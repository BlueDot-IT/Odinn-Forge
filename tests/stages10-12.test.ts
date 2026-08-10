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

test("Stage 10 counts independent steps per lease and cancels every active step", async () => {
  const state = await stateRoot("workflow-concurrency");
  const ledger = createRunLedger({ stateDir: state });
  const store = new SqliteWorkflowStore(ledger.database);
  let active = 0;
  let maximum = 0;
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const definition = workflowDefinitionFromSteps({
    id: "fixture.parallel-workflow",
    name: "Parallel fixture workflow",
    steps: ["one", "two", "three", "four"].map((id) => ({ id, actionRef: "text.echo", input: { id } }))
  });
  const runtime = new DurableWorkflowRuntime({
    store,
    concurrency: 2,
    dispatch: async ({ signal }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      started += 1;
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(signal.reason); };
        signal.addEventListener("abort", onAbort, { once: true });
        gate.then(() => { signal.removeEventListener("abort", onAbort); resolve(); }, reject);
      }).finally(() => { active -= 1; });
      return { status: "completed" };
    }
  });
  await runtime.submit({ runId: "workflow-parallel-1", principalId: "test", idempotencyKey: "workflow-parallel-key", definition, input: {} });
  for (let attempt = 0; attempt < 100 && started < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(started, 2);
  assert.equal(maximum, 2);
  await runtime.cancel("workflow-parallel-1");
  release();
  await runtime.shutdown();
  assert.equal(active, 0);
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

test("Stage 11 claims duplicate delivery ownership before dispatch", async () => {
  const state = await stateRoot("events-concurrent");
  const ledger = createRunLedger({ stateDir: state });
  let dispatches = 0;
  let release!: () => void;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const authDigest = sourceAuthDigest("fixture-secret");
  const ingress = new DurableEventIngress({
    database: ledger.database,
    dispatch: async () => {
      dispatches += 1;
      firstStarted();
      await gate;
      return "completed";
    }
  });
  ingress.registerSource({ source: "fixture", authDigest });
  ingress.registerWatch("watch-1", { schemaVersion: 1, id: "watch", revision: 1, enabled: true, actionRef: "text.echo", kind: "event", source: "fixture", event: "message", match: [] });
  const event = { schemaVersion: 1, source: "fixture", event: "message", sequence: 0, cursor: "odinn-event-v1/fixture/0", occurredAtUnixMs: 1, attributes: { kind: "test" } };
  const first = ingress.ingest(event, authDigest);
  await started;
  const duplicate = ingress.ingest(event, authDigest);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(dispatches, 1);
  release();
  await Promise.all([first, duplicate]);
  const delivery = ledger.database.db.prepare("SELECT status FROM event_deliveries").get() as { status: string };
  assert.equal(delivery.status, "completed");
  ledger.close();
});

test("Stage 11 dispatches active watches outside the bounded administrative listing", async () => {
  const state = await stateRoot("event-watch-boundary");
  const ledger = createRunLedger({ stateDir: state });
  let eventDispatches = 0;
  let scheduleDispatches = 0;
  const ingress = new DurableEventIngress({
    database: ledger.database,
    dispatch: async (candidate) => {
      if (candidate.trigger === "event") eventDispatches += 1;
      if (candidate.trigger === "schedule") scheduleDispatches += 1;
      return "completed";
    }
  });
  const authDigest = sourceAuthDigest("fixture-secret");
  ingress.registerSource({ source: "fixture", authDigest });
  for (let index = 0; index < 256; index += 1) {
    const suffix = String(index).padStart(3, "0");
    ingress.registerWatch(`a-disabled-${suffix}`, {
      schemaVersion: 1, id: `disabled-${suffix}`, revision: 1, enabled: true,
      actionRef: "text.echo", kind: "event", source: "fixture", event: "message", match: []
    });
    ingress.disableWatch(`a-disabled-${suffix}`);
  }
  ingress.registerWatch("z-active-event", {
    schemaVersion: 1, id: "active-event", revision: 1, enabled: true,
    actionRef: "text.echo", kind: "event", source: "fixture", event: "message", match: []
  });
  ingress.registerWatch("z-active-schedule", {
    schemaVersion: 1, id: "active-schedule", revision: 1, enabled: true,
    actionRef: "text.echo", kind: "schedule", schedule: { type: "at", atUnixMs: 100 }
  });
  const event = { schemaVersion: 1, source: "fixture", event: "message", sequence: 0, cursor: "odinn-event-v1/fixture/0", occurredAtUnixMs: 1, attributes: { kind: "test" } };
  const result = await ingress.ingest(event, authDigest);
  const heartbeat = await ingress.heartbeat(100);
  assert.equal(result.candidates.length, 1);
  assert.equal(heartbeat.length, 1);
  assert.equal(eventDispatches, 1);
  assert.equal(scheduleDispatches, 1);
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
