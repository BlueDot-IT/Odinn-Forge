import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuditStore, createBuiltInRegistry, runTask } from "../packages/kernel/src/index.ts";

async function fixture(responder: (request: any, index: number) => any) {
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responder(requests.at(-1), requests.length)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(join(tmpdir(), "odinn-structured-output-"));
  const stateDir = join(root, ".odinn");
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir,
    config: { defaultModel: "test:test-model", providers: { test: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: ["test-model"] } } }
  });
  return { requests, auditStore, registry, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

const outputSchema = {
  type: "object",
  properties: { answer: { type: "string", minLength: 1 }, complete: { type: "boolean" } },
  required: ["answer", "complete"],
  additionalProperties: false
};

test("structured assistant output receives exactly one bounded repair cycle", async () => {
  const fx = await fixture((_request, index) => ({
    id: `structured-${index}`,
    choices: [{ message: { role: "assistant", content: index === 1 ? '{"answer":1,"complete":true}' : '{"answer":"done","complete":true}' } }]
  }));
  try {
    const result = await runTask({
      task: { id: "structured-repair", tool: "agent.run", actor: "test", input: { prompt: "Return status JSON.", outputSchema, maxTurns: 1 } },
      auditStore: fx.auditStore,
      registry: fx.registry
    });
    assert.deepEqual(result.output.structuredOutput, { answer: "done", complete: true });
    assert.deepEqual(result.output.structuredOutputRepair, { attempted: true });
    assert.equal(fx.requests.length, 2);
    assert.match(fx.requests[0].messages.find((message: any) => message.role === "system" && String(message.content).includes("final assistant answer"))?.content ?? "", /additionalProperties/u);
    assert.equal(fx.requests[1].messages.some((message: any) => message.content === "[invalid structured output omitted]"), true);
    assert.equal(fx.requests[1].tools, undefined);
    const audit = await fx.auditStore.readAll();
    assert.equal(audit.filter((event: any) => event.type === "assistant.output.rejected").length, 1);
    assert.doesNotMatch(audit.map(JSON.stringify).join("\n"), /answer\\?":1/u);
  } finally { await fx.close(); }
});

test("structured-output repair rejects fabricated tool calls without dispatch", async () => {
  let dispatched = false;
  const fx = await fixture((_request, index) => index === 1 ? {
    id: "repair-tool-first",
    choices: [{ message: { role: "assistant", content: "not-json" } }]
  } : {
    id: "repair-tool-second",
    choices: [{ message: { role: "assistant", content: "", tool_calls: [{
      id: "repair-echo",
      type: "function",
      function: { name: "repair.probe", arguments: "{}" }
    }] } }]
  });
  fx.registry.set("repair.probe", {
    capability: "repair.probe",
    description: "Must remain unavailable during structured-output repair.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    retrySafe: true,
    execute: async () => { dispatched = true; return { ok: true }; }
  });
  try {
    await assert.rejects(runTask({
      task: { id: "structured-repair-tool-refusal", tool: "agent.run", actor: "test", input: { prompt: "Return JSON.", outputSchema, maxTurns: 1 } },
      auditStore: fx.auditStore,
      registry: fx.registry
    }), (error: any) => error.code === "ASSISTANT_OUTPUT_SCHEMA_INVALID");
    assert.equal(fx.requests.length, 2);
    assert.equal(fx.requests[1].tools, undefined);
    assert.equal(dispatched, false);
    const audit = await fx.auditStore.readAll();
    assert.equal(audit.filter((event: any) => event.type === "assistant.output.rejected").length, 2);
  } finally { await fx.close(); }
});

test("a second invalid structured answer fails closed without a third provider call", async () => {
  const fx = await fixture((_request, index) => ({ id: `invalid-${index}`, choices: [{ message: { role: "assistant", content: "not-json" } }] }));
  try {
    await assert.rejects(runTask({
      task: { id: "structured-repair-limit", tool: "agent.run", actor: "test", input: { prompt: "Return JSON.", outputSchema } },
      auditStore: fx.auditStore,
      registry: fx.registry
    }), (error: any) => error.code === "ASSISTANT_OUTPUT_SCHEMA_INVALID");
    assert.equal(fx.requests.length, 2);
    const audit = await fx.auditStore.readAll();
    assert.equal(audit.filter((event: any) => event.type === "assistant.output.rejected").length, 2);
  } finally { await fx.close(); }
});

test("parent results project bounded nested tool and child summaries", async () => {
  const fx = await fixture((_request, index) => index === 1 ? {
    id: "nested-tools",
    choices: [{ message: { role: "assistant", content: "", tool_calls: [
      { id: "echo-call", type: "function", function: { name: "text.echo", arguments: '{"text":"probe"}' } },
      { id: "child-call", type: "function", function: { name: "agent.delegate", arguments: '{}' } }
    ] } }]
  } : { id: "nested-final", choices: [{ message: { role: "assistant", content: "Parent complete." } }] });
  fx.registry.set("agent.delegate", {
    capability: "agent.delegate",
    capabilities: ["agent.delegate"],
    description: "Test child dispatcher.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    retrySafe: true,
    execute: async () => ({ graphRunId: "graph:test-child", status: "completed" })
  });
  try {
    const result = await runTask({ task: { id: "nested-summary", tool: "agent.run", actor: "test", input: { prompt: "Use both tools." } }, auditStore: fx.auditStore, registry: fx.registry });
    assert.deepEqual(result.output.nestedExecutionSummary.toolCalls.map((entry: any) => ({ callId: entry.callId, tool: entry.tool, status: entry.status })), [
      { callId: "echo-call", tool: "text.echo", status: "completed" },
      { callId: "child-call", tool: "agent.delegate", status: "completed" }
    ]);
    assert.deepEqual(result.output.nestedExecutionSummary.childRuns.map((entry: any) => ({ callId: entry.callId, graphRunId: entry.graphRunId, status: entry.status })), [
      { callId: "child-call", graphRunId: "graph:test-child", status: "completed" }
    ]);
    assert.equal(JSON.stringify(result.output.nestedExecutionSummary).includes("probe"), false);
  } finally { await fx.close(); }
});
