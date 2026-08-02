import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuditStore, createBuiltInRegistry, runTask } from "../packages/kernel/src/index.ts";
import { createDefaultPolicy } from "../packages/policy/src/index.ts";

async function fixture(responder: (request: any, index: number) => any) {
  const requests: any[] = [];
  const provider = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responder(requests.at(-1), requests.length)));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("provider did not bind");
  const root = await mkdtemp(join(tmpdir(), "odinn-tool-arguments-"));
  const stateDir = join(root, ".odinn");
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir,
    config: {
      defaultModel: "test:test-model",
      providers: { test: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: ["test-model"] } }
    }
  });
  return {
    root,
    requests,
    auditStore,
    registry,
    close: () => new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()))
  };
}

async function runAgent(fx: Awaited<ReturnType<typeof fixture>>, id: string, toolCall: string, policyTools = ["agent.run", "model.chat", "browser.read"]) {
  const policy = createDefaultPolicy({ allowedCapabilities: policyTools });
  return runTask({
    task: { id, tool: "agent.run", input: { model: "test:test-model", prompt: "Use the tool and then report." }, actor: "test" },
    auditStore: fx.auditStore,
    registry: fx.registry,
    policy
  });
}

function toolResponse(request: any, callId: string) {
  return JSON.parse(request.messages.find((message: any) => message.role === "tool" && message.tool_call_id === callId).content);
}

async function auditText(fx: Awaited<ReturnType<typeof fixture>>) {
  return (await fx.auditStore.readAll()).map(JSON.stringify).join("\n");
}

test("malformed arguments never dispatch, audit without raw payload, and valid {} remains compatible", async () => {
  const malformed = '{"text":"unterminated';
  const fx = await fixture((_request, index) => index === 1 ? {
    id: "malformed-1",
    choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "bad", type: "function", function: { name: "browser.recovery.status", arguments: malformed } }] } }]
  } : index === 2 ? {
    id: "corrected-1",
    choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "good", type: "function", function: { name: "browser.recovery.status", arguments: "{}" } }] } }]
  } : { id: "done-1", choices: [{ message: { role: "assistant", content: "corrected" } }] });
  try {
    const result = await runAgent(fx, "malformed-arguments", malformed);
    assert.equal(result.output.content, "corrected");
    assert.deepEqual(toolResponse(fx.requests[1], "bad"), {
      ok: false,
      error: { code: "TOOL_ARGUMENTS_MALFORMED", message: "The tool arguments were malformed JSON. Return one valid JSON object and retry once." }
    });
    assert.equal(toolResponse(fx.requests[2], "good").recovery.status, "clear");
    const audit = await auditText(fx);
    assert.match(audit, /"type":"tool\.call\.rejected"/u);
    assert.match(audit, /TOOL_ARGUMENTS_MALFORMED/u);
    assert.doesNotMatch(audit, /unterminated/u);
    assert.doesNotMatch(audit, /text\\":\\"/u);
  } finally {
    await fx.close();
  }
});

test("schema-invalid arguments are rejected before dispatch", async () => {
  const fx = await fixture((_request, index) => index === 1 ? {
    id: "schema-1",
    choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "schema-bad", type: "function", function: { name: "workspace.readText", arguments: "{\"maxBytes\":1024}" } }] } }]
  } : { id: "schema-done", choices: [{ message: { role: "assistant", content: "schema corrected" } }] });
  try {
    const policy = createDefaultPolicy({ allowedCapabilities: ["agent.run", "model.chat", "workspace.readText"] });
    const result = await runTask({ task: { id: "schema-arguments", tool: "agent.run", input: { model: "test:test-model", prompt: "Read a file." }, actor: "test" }, auditStore: fx.auditStore, registry: fx.registry, policy });
    assert.equal(result.output.content, "schema corrected");
    assert.deepEqual(toolResponse(fx.requests[1], "schema-bad").error.code, "TOOL_ARGUMENTS_SCHEMA_INVALID");
    assert.doesNotMatch(await auditText(fx), /task\.started.*workspace\.readText/u);
  } finally {
    await fx.close();
  }
});

test("duplicate, prototype-shaped, trailing, and oversized arguments fail closed", async () => {
  const cases = [
    { arguments: '{"text":"a","text":"b"}', code: "TOOL_ARGUMENTS_MALFORMED" },
    { arguments: '{"__proto__":{"polluted":true}}', code: "TOOL_ARGUMENTS_SCHEMA_INVALID" },
    { arguments: '{"text":"ok"} trailing', code: "TOOL_ARGUMENTS_MALFORMED" },
    { arguments: JSON.stringify({ text: "x".repeat(1_100_000) }), code: "TOOL_ARGUMENTS_MALFORMED" }
  ];
  for (const [index, entry] of cases.entries()) {
    const badArguments = entry.arguments;
    const fx = await fixture((_request, requestIndex) => requestIndex === 1 ? {
      id: `bad-${index}`,
      choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `bad-${index}`, type: "function", function: { name: "browser.recovery.status", arguments: badArguments } }] } }]
    } : { id: `done-${index}`, choices: [{ message: { role: "assistant", content: "rejected" } }] });
    try {
      const result = await runAgent(fx, `bad-case-${index}`, badArguments);
      assert.equal(result.output.content, "rejected");
      const rejected = fx.requests[1]?.messages.find((message: any) => message.role === "tool" && message.tool_call_id === `bad-${index}`);
      assert.ok(rejected, `missing rejection for case ${index}: ${JSON.stringify(fx.requests)}`);
      const payload = JSON.parse(rejected.content);
      assert.equal(payload?.error?.code, entry.code, JSON.stringify({ index, payload, badArguments: badArguments.slice(0, 80) }));
      assert.doesNotMatch(await auditText(fx), /polluted|duplicate|trailing|1,100,000/u);
    } finally {
      await fx.close();
    }
  }
});

test("only one correction cycle is allowed for malformed arguments", async () => {
  const fx = await fixture((_request, index) => ({
    id: `repeat-${index}`,
    choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `repeat-${index}`, type: "function", function: { name: "browser.recovery.status", arguments: "{\"text\":" } }] } }]
  }));
  try {
    await assert.rejects(
      runAgent(fx, "malformed-correction-limit", "{\"text\":"),
      (error: any) => error.code === "TOOL_ARGUMENTS_MALFORMED"
    );
    assert.equal(fx.requests.length, 2);
    const audit = await auditText(fx);
    assert.equal((audit.match(/tool\.call\.rejected/g) ?? []).length, 2);
  } finally {
    await fx.close();
  }
});

test("supported schema constraints fail closed and valid boundaries dispatch once", async () => {
  const cases = [
    { schema: { type: "string", minLength: 2 }, invalid: "x", valid: "xy" },
    { schema: { type: "string", maxLength: 2 }, invalid: "xyz", valid: "xy" },
    { schema: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 3 }, invalid: [1], valid: [1, 2, 3] },
    { schema: { type: "number", minimum: 2, maximum: 4 }, invalid: 1, valid: 2 },
    { schema: { type: "number", exclusiveMinimum: 2, exclusiveMaximum: 4 }, invalid: 2, valid: 3 },
    { schema: { type: "string", pattern: "^x$" }, invalid: "x", valid: undefined }
  ];
  for (const [index, entry] of cases.entries()) {
    for (const [label, value, expectedDispatches] of [["invalid", entry.invalid, 0], ["valid", entry.valid, entry.valid === undefined ? 0 : 1]] as const) {
      let dispatches = 0;
      const fx = await fixture((_request, requestIndex) => requestIndex === 1 ? {
        id: `constraint-${index}-${label}`,
        choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `constraint-${index}-${label}`, type: "function", function: { name: "test.constraint", arguments: JSON.stringify(value) } }] } }]
      } : { id: `constraint-done-${index}-${label}`, choices: [{ message: { role: "assistant", content: "done" } }] });
      fx.registry.set("test.constraint", {
        capability: "workspace.inspect",
        capabilities: ["workspace.inspect"],
        description: "Constraint test tool.",
        inputSchema: entry.schema,
        execute: async (input: any) => { dispatches += 1; return { input }; }
      });
      try {
        const result = await runAgent(fx, `constraint-${index}-${label}`, "", ["agent.run", "model.chat", "workspace.inspect"]);
        assert.equal(result.output.content, "done");
        assert.equal(dispatches, expectedDispatches, `${index}/${label}`);
      } finally {
        await fx.close();
      }
    }
  }
});
