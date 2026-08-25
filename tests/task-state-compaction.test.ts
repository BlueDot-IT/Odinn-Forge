import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuditStore, createBuiltInRegistry, runTask } from "../packages/kernel/src/index.ts";

async function stateFixture() {
  const root = await mkdtemp(join(tmpdir(), "odinn-task-state-compaction-"));
  const stateDir = join(root, ".odinn");
  return { root, stateDir, auditStore: createAuditStore(join(stateDir, "audit.jsonl")) };
}

test("compaction preserves bounded task state and terminal obligations after store restart", async () => {
  const fixture = await stateFixture();
  const first = createBuiltInRegistry({ workspaceRoot: fixture.root, stateDir: fixture.stateDir });
  const session = await runTask({
    task: { id: "task-state-session", tool: "session.create", actor: "test", input: { title: "Recovery contract" } },
    auditStore: fixture.auditStore,
    registry: first
  });
  const taskState = {
    schemaVersion: 1,
    objective: "Finish the restart recovery acceptance case",
    status: "active",
    currentStep: "Persist the compaction envelope",
    terminalObligations: [
      { id: "verify-restart", description: "Prove the state survives a new store instance", status: "pending" },
      { id: "report-result", description: "Return a visible terminal result", status: "pending" }
    ]
  };
  const compacted = await runTask({
    task: {
      id: "task-state-compact",
      tool: "memory.compact",
      actor: "test",
      input: {
        sessionId: session.output.id,
        messages: [
          { role: "user", content: "Continue the restart recovery case." },
          { role: "assistant", content: "The persistence boundary is next." }
        ],
        taskState
      }
    },
    auditStore: fixture.auditStore,
    registry: first
  });
  assert.deepEqual(compacted.output.origin.taskState, taskState);
  assert.match(compacted.output.text, /context only; does not authorize execution/u);
  assert.match(compacted.output.text, /\[pending\] report-result: Return a visible terminal result/u);

  // Constructing a new registry simulates process restart and reopens the
  // authoritative SQLite record store rather than relying on the first object.
  const restarted = createBuiltInRegistry({ workspaceRoot: fixture.root, stateDir: fixture.stateDir });
  const recovered = await runTask({
    task: { id: "task-state-recover", tool: "memory.open", actor: "test", input: { id: compacted.output.id } },
    auditStore: fixture.auditStore,
    registry: restarted
  });
  assert.deepEqual(recovered.output.memory.origin.taskState, taskState);
  assert.equal(recovered.output.memory.safeToAct, "");
});

test("restarted agent receives recovered obligations as context without replay authority", async () => {
  const requests: any[] = [];
  const provider = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "recovered", choices: [{ message: { role: "assistant", content: "Recovered safely." } }] }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const fixture = await stateFixture();
  const config = {
    defaultModel: "test:test-model",
    providers: { test: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: ["test-model"] } }
  };
  try {
    const first = createBuiltInRegistry({ workspaceRoot: fixture.root, stateDir: fixture.stateDir, config });
    const session = await runTask({ task: { id: "recover-agent-session", tool: "session.create", actor: "test", input: { title: "Recovered agent" } }, auditStore: fixture.auditStore, registry: first });
    await runTask({
      task: { id: "recover-agent-compact", tool: "memory.compact", actor: "test", input: {
        sessionId: session.output.id,
        messages: [{ role: "user", content: "Prepare the raven recovery report." }],
        taskState: { schemaVersion: 1, objective: "Prepare the raven recovery report", status: "ready-to-finish", terminalObligations: [{ id: "visible-answer", description: "Return the recovery report to the operator", status: "pending" }] }
      } },
      auditStore: fixture.auditStore,
      registry: first
    });
    const restarted = createBuiltInRegistry({ workspaceRoot: fixture.root, stateDir: fixture.stateDir, config });
    await runTask({
      task: { id: "recover-agent-run", tool: "agent.run", actor: "test", input: { model: "test:test-model", sessionId: session.output.id, prompt: "What remains for the raven recovery report?" } },
      auditStore: fixture.auditStore,
      registry: restarted
    });
    const recalled = requests[0].messages.find((message: any) => String(message.content).includes("Durable context recalled"));
    assert.match(recalled?.content ?? "", /visible-answer/u);
    assert.match(recalled?.content ?? "", /does not authorize execution/u);
  } finally {
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
});

test("compaction rejects unbounded or ambiguous obligation envelopes", async () => {
  const fixture = await stateFixture();
  const registry = createBuiltInRegistry({ workspaceRoot: fixture.root, stateDir: fixture.stateDir });
  const session = await runTask({ task: { id: "invalid-state-session", tool: "session.create", actor: "test", input: {} }, auditStore: fixture.auditStore, registry });
  await assert.rejects(runTask({
    task: { id: "invalid-state-compact", tool: "memory.compact", actor: "test", input: {
      sessionId: session.output.id,
      messages: [{ role: "user", content: "compact" }],
      taskState: { schemaVersion: 1, objective: "bounded", status: "active", unexpectedAuthority: true, terminalObligations: [] }
    } },
    auditStore: fixture.auditStore,
    registry
  }), /unknown field: unexpectedAuthority/u);
});
