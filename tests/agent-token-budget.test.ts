import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuditStore, runTask } from "../packages/kernel/src/index.ts";
import { createRuntimeRegistry } from "../packages/runtime/src/index.ts";

test("agent turns adapt output limits while preserving a visible-answer reserve", async () => {
  const requests: any[] = [];
  const provider = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(requests.length === 1 ? {
      id: "budget_tool",
      choices: [{ message: { role: "assistant", content: "", tool_calls: [{
        id: "echo_1",
        type: "function",
        function: { name: "text.echo", arguments: JSON.stringify({ text: "probe" }) }
      }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    } : {
      id: "budget_answer",
      choices: [{ message: { role: "assistant", content: "Visible answer." } }],
      usage: { prompt_tokens: 130, completion_tokens: 40, total_tokens: 170 }
    }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(join(tmpdir(), "odinn-agent-budget-"));
  const stateDir = join(root, ".odinn");
  const registry = createRuntimeRegistry({
    workspaceRoot: root,
    stateDir,
    config: {
      defaultModel: "test:test-model",
      providers: { test: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: ["test-model"] } }
    }
  });
  try {
    const result = await runTask({
      task: {
        id: "adaptive-token-budget",
        tool: "agent.run",
        actor: "test",
        input: { prompt: "Use the echo tool, then answer.", maxTurns: 2, maxTokens: 1_000, visibleAnswerReserveTokens: 400 }
      },
      auditStore: createAuditStore(join(stateDir, "audit.jsonl")),
      registry
    });
    assert.equal(result.output.content, "Visible answer.");
    assert.deepEqual(requests.map((request) => request.max_tokens), [700, 1_000]);
    assert.equal(result.output.tokenBudget.visibleAnswerReserve, 400);
    assert.equal(result.output.tokenBudget.lastTurnAllocation, 1_000);
    assert.equal(result.output.tokenBudget.completionTokensUsed, 60);
  } finally {
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
});

test("agent refuses a turn when context pressure would consume the visible-answer reserve", async () => {
  let called = false;
  const provider = createServer((_request, response) => {
    called = true;
    response.writeHead(500).end();
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(join(tmpdir(), "odinn-agent-budget-context-"));
  const stateDir = join(root, ".odinn");
  const registry = createRuntimeRegistry({
    workspaceRoot: root,
    stateDir,
    config: {
      defaultModel: "test:test-model",
      providers: { test: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: ["test-model"] } }
    }
  });
  try {
    await assert.rejects(runTask({
      task: {
        id: "exhausted-visible-answer-reserve",
        tool: "agent.run",
        actor: "test",
        input: {
          messages: [{ role: "user", content: "x".repeat(7_000) }],
          maxTokens: 512,
          visibleAnswerReserveTokens: 256,
          contextWindowTokens: 2_048
        }
      },
      auditStore: createAuditStore(join(stateDir, "audit.jsonl")),
      registry
    }), (error: any) => error.code === "AGENT_VISIBLE_ANSWER_BUDGET_EXHAUSTED");
    assert.equal(called, false);
  } finally {
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
});
