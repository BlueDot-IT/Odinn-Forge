import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DurableEventIngress,
  DurableWorkflowRuntime,
  ProjectContextService,
  createRunLedger,
  sourceAuthDigest,
  workflowDefinitionFromSteps
} from "../packages/kernel/src/index.ts";
import { SqliteRecordStore, SqliteWorkflowStore } from "../packages/store-sqlite/src/index.ts";

async function stateRoot(prefix: string) {
  return mkdtemp(join(tmpdir(), `odinn-${prefix}-`));
}

test("Stage 10 persists and completes a dependency-bound workflow", async () => {
  const state = await stateRoot("workflow");
  const ledger = createRunLedger({ stateDir: state });
  const store = new SqliteWorkflowStore(ledger.database);
  const definition = workflowDefinitionFromSteps({
    id: "fixture.workflow",
    name: "Fixture workflow",
    steps: [
      { id: "first", actionRef: "text.echo", input: { text: "one" } },
      { id: "second", actionRef: "text.echo", dependsOn: ["first"], input: { text: "two" } }
    ]
  });
  const runtime = new DurableWorkflowRuntime({
    store,
    dispatch: async ({ step }) => ({ status: "completed", result: { stepId: step.stepId } })
  });
  const run = await runtime.submit({ runId: "workflow-run-1", principalId: "test", idempotencyKey: "workflow-key-1", definition, input: {} });
  assert.ok(["queued", "running", "completed"].includes(run.status));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (store.get("workflow-run-1")?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(store.get("workflow-run-1")?.status, "completed");
  assert.deepEqual(store.get("workflow-run-1")?.steps.map((step) => step.status), ["completed", "completed"]);
  assert.equal(store.get("workflow-run-1")?.definitionDigest, definition.definitionDigest);
  ledger.close();
});

test("Stage 11 authenticates event sources and suppresses duplicate candidates", async () => {
  const state = await stateRoot("events");
  const ledger = createRunLedger({ stateDir: state });
  let dispatches = 0;
  const ingress = new DurableEventIngress({ database: ledger.database, dispatch: async () => { dispatches += 1; return "completed"; } });
  const authDigest = sourceAuthDigest("fixture-secret");
  ingress.registerSource({ source: "fixture", authDigest });
  ingress.registerWatch("watch-1", { schemaVersion: 1, id: "watch", revision: 1, enabled: true, actionRef: "text.echo", kind: "event", source: "fixture", event: "message", match: [] });
  const event = { schemaVersion: 1, source: "fixture", event: "message", sequence: 0, cursor: "odinn-event-v1/fixture/0", occurredAtUnixMs: 1, attributes: { kind: "test" } };
  const first = await ingress.ingest(event, authDigest);
  const duplicate = await ingress.ingest(event, authDigest);
  assert.equal(first.candidates.length, 1);
  assert.equal(duplicate.candidates.length, 1);
  assert.equal(dispatches, 1);
  await assert.rejects(() => ingress.ingest({ ...event, sequence: 2, cursor: "odinn-event-v1/fixture/2" }, authDigest), /next authoritative sequence/u);
  ledger.close();
});

test("Stage 12 keeps project context scoped and digest-bound", async () => {
  const state = await stateRoot("context");
  const records = new SqliteRecordStore(join(state, "records.sqlite"));
  await records.append({ id: "project-a", type: "project.created", status: "active", name: "Project A", description: "A", tags: [], source: "test" });
  await records.append({ id: "memory-a", type: "memory", status: "active", scopeType: "project", scopeId: "project-a", projectId: "project-a", namespace: "test", kind: "fact", subject: "alpha", summary: "alpha summary", text: "alpha project context", source: "test", authority: "user", confidence: 1 });
  await records.append({ id: "memory-b", type: "memory", status: "active", scopeType: "project", scopeId: "other-project", projectId: "other-project", namespace: "test", kind: "fact", subject: "beta", summary: "beta summary", text: "alpha but other project", source: "test", authority: "user", confidence: 1 });
  const context = new ProjectContextService({ records });
  const packet = await context.build({ projectId: "project-a", query: "alpha" });
  assert.deepEqual(packet.memories.map((memory) => memory.id), ["memory-a"]);
  assert.match(packet.contextDigest, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(context.projectDurable(packet)), /alpha project context/u);
  records.close();
});
