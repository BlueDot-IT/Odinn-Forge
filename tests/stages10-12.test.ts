import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runWithWorkflowLeaseHeartbeat } from "../apps/gateway/src/workflow.ts";
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
  assert.equal(store.get("workflow-parallel-1")?.status, "cancelled");
  assert.deepEqual(store.get("workflow-parallel-1")?.steps.map((step) => step.status), ["cancelled", "cancelled", "cancelled", "cancelled"]);
  ledger.close();
});

test("Stage 10 cancellation remains non-terminal until active work acknowledges it", async () => {
  const state = await stateRoot("workflow-noncooperative-cancel");
  const ledger = createRunLedger({ stateDir: state });
  const store = new SqliteWorkflowStore(ledger.database);
  let release!: () => void;
  let dispatchStarted!: () => void;
  const started = new Promise<void>((resolve) => { dispatchStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const definition = workflowDefinitionFromSteps({
    id: "fixture.noncooperative-workflow",
    name: "Non-cooperative fixture workflow",
    steps: [{ id: "effect", actionRef: "remote.mutate", input: {}, retrySafety: "effectful" }]
  });
  const runtime = new DurableWorkflowRuntime({
    store,
    cancellationGraceMs: 20,
    dispatch: async () => {
      dispatchStarted();
      await gate;
      return { status: "completed", result: { externallyCommitted: true } };
    }
  });
  await runtime.submit({ runId: "workflow-noncooperative-1", principalId: "test", idempotencyKey: "workflow-noncooperative-key", definition, input: {} });
  await started;
  const cancellation = runtime.cancel("workflow-noncooperative-1");
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(store.get("workflow-noncooperative-1")?.status, "cancelling");
  const cancelled = await cancellation;
  assert.equal(cancelled.status, "needs-review");
  assert.equal(cancelled.steps[0]?.status, "needs-review");
  assert.equal(cancelled.steps[0]?.errorCode, "WORKFLOW_CANCELLATION_OUTCOME_UNCERTAIN");
  release();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!store.get("workflow-noncooperative-1")?.steps[0]?.leaseToken) break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(store.get("workflow-noncooperative-1")?.status, "needs-review");
  assert.equal(store.events("workflow-noncooperative-1").some((event) => event.type === "workflow.step.completed"), false);
  await runtime.shutdown();
  ledger.close();
});

test("Stage 10 quarantines an effectful abort unless dispatch explicitly acknowledges no effect", async () => {
  const state = await stateRoot("workflow-effectful-cancel");
  const ledger = createRunLedger({ stateDir: state });
  const store = new SqliteWorkflowStore(ledger.database);
  const uncertainDefinition = workflowDefinitionFromSteps({
    id: "fixture.effectful-abort",
    name: "Effectful abort fixture",
    steps: [{ id: "effect", actionRef: "remote.mutate", input: {}, retrySafety: "effectful" }]
  });
  let uncertainStarted!: () => void;
  const uncertainDispatchStarted = new Promise<void>((resolve) => { uncertainStarted = resolve; });
  const uncertainRuntime = new DurableWorkflowRuntime({
    store,
    dispatch: async ({ signal }) => {
      uncertainStarted();
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { status: "completed", result: {} };
    }
  });
  await uncertainRuntime.submit({ runId: "workflow-effectful-abort-1", principalId: "test", idempotencyKey: "workflow-effectful-abort-key", definition: uncertainDefinition, input: {} });
  await uncertainDispatchStarted;
  const uncertain = await uncertainRuntime.cancel("workflow-effectful-abort-1");
  assert.equal(uncertain.status, "needs-review");
  assert.equal(uncertain.steps[0]?.errorCode, "WORKFLOW_CANCELLATION_OUTCOME_UNCERTAIN");
  await uncertainRuntime.shutdown();

  const acknowledgedDefinition = workflowDefinitionFromSteps({
    id: "fixture.effectful-no-effect-ack",
    name: "Effectful no-effect acknowledgement fixture",
    steps: [{ id: "effect", actionRef: "remote.mutate", input: {}, retrySafety: "effectful" }]
  });
  let acknowledgedStarted!: () => void;
  const acknowledgedDispatchStarted = new Promise<void>((resolve) => { acknowledgedStarted = resolve; });
  const acknowledgedRuntime = new DurableWorkflowRuntime({
    store,
    dispatch: ({ signal }) => new Promise((resolve) => {
      acknowledgedStarted();
      const acknowledge = () => resolve({ status: "cancelled", effectApplied: false });
      if (signal.aborted) acknowledge();
      else signal.addEventListener("abort", acknowledge, { once: true });
    })
  });
  await acknowledgedRuntime.submit({ runId: "workflow-effectful-ack-1", principalId: "test", idempotencyKey: "workflow-effectful-ack-key", definition: acknowledgedDefinition, input: {} });
  await acknowledgedDispatchStarted;
  const acknowledged = await acknowledgedRuntime.cancel("workflow-effectful-ack-1");
  assert.equal(acknowledged.status, "cancelled");
  assert.equal(acknowledged.steps[0]?.status, "cancelled");
  await acknowledgedRuntime.shutdown();
  ledger.close();
});

test("Stage 10 recovers a persisted cancellation at its deadline after restart", async () => {
  const state = await stateRoot("workflow-cancel-restart");
  const ledger = createRunLedger({ stateDir: state });
  const store = new SqliteWorkflowStore(ledger.database);
  const definition = workflowDefinitionFromSteps({
    id: "fixture.cancel-restart-workflow",
    name: "Cancellation restart fixture",
    steps: [{ id: "effect", actionRef: "remote.mutate", input: {}, retrySafety: "effectful" }]
  });
  store.create({ schemaVersion: 1, runId: "workflow-cancel-restart-1", principalId: "test", idempotencyKey: "workflow-cancel-restart-key", definition, input: {} });
  store.claimNext("workflow-cancel-restart-1");
  store.requestCancellation("workflow-cancel-restart-1", new Date(Date.now() + 150).toISOString());
  const restarted = new DurableWorkflowRuntime({ store, dispatch: async () => ({ status: "completed", result: {} }) });
  await restarted.start();
  assert.equal(store.get("workflow-cancel-restart-1")?.status, "cancelling");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (store.get("workflow-cancel-restart-1")?.status === "needs-review") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(store.get("workflow-cancel-restart-1")?.status, "needs-review");
  assert.equal(store.get("workflow-cancel-restart-1")?.steps[0]?.errorCode, "WORKFLOW_CANCELLATION_OUTCOME_UNCERTAIN");
  await restarted.shutdown();
  ledger.close();
});

test("Stage 10 schedules recovery for a lease that expires after restart", async () => {
  const state = await stateRoot("workflow-restart-lease");
  const ledger = createRunLedger({ stateDir: state });
  const store = new SqliteWorkflowStore(ledger.database);
  const definition = workflowDefinitionFromSteps({
    id: "fixture.restart-workflow",
    name: "Restart fixture workflow",
    steps: [{ id: "retry", actionRef: "text.echo", input: {}, retrySafety: "retry-safe", maxAttempts: 2 }]
  });
  store.create({ schemaVersion: 1, runId: "workflow-restart-1", principalId: "test", idempotencyKey: "workflow-restart-key", definition, input: {} });
  const abandoned = store.claimNext("workflow-restart-1");
  assert.ok(abandoned);
  ledger.database.db.prepare("UPDATE workflow_steps SET lease_expires_at=? WHERE run_id=? AND step_id=?")
    .run(new Date(Date.now() + 150).toISOString(), abandoned.runId, abandoned.stepId);
  let dispatches = 0;
  const restarted = new DurableWorkflowRuntime({
    store,
    dispatch: async () => {
      dispatches += 1;
      return { status: "completed", result: {} };
    }
  });
  await restarted.start();
  assert.equal(store.get("workflow-restart-1")?.steps[0]?.status, "running");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (store.get("workflow-restart-1")?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(dispatches, 1);
  assert.equal(store.get("workflow-restart-1")?.status, "completed");
  assert.equal(store.get("workflow-restart-1")?.steps[0]?.attempt, 2);
  await restarted.shutdown();
  ledger.close();
});

test("Stage 10 rejects every settlement path after a workflow lease expires", async () => {
  const state = await stateRoot("workflow-expired-settlement");
  const ledger = createRunLedger({ stateDir: state });
  const store = new SqliteWorkflowStore(ledger.database);
  const definition = workflowDefinitionFromSteps({
    id: "fixture.expired-settlement",
    name: "Expired settlement fixture",
    steps: [{ id: "step", actionRef: "text.echo", input: {}, maxAttempts: 2 }]
  });
  const claimExpired = (suffix: string) => {
    const runId = `workflow-expired-${suffix}`;
    store.create({ schemaVersion: 1, runId, principalId: "test", idempotencyKey: `workflow-expired-key-${suffix}`, definition, input: {} });
    const step = store.claimNext(runId);
    assert.ok(step);
    ledger.database.db.prepare("UPDATE workflow_steps SET lease_expires_at=? WHERE run_id=? AND step_id=?")
      .run(new Date(Date.now() - 1_000).toISOString(), runId, step.stepId);
    return step;
  };
  const completion = claimExpired("completion");
  assert.throws(() => store.completeStep(completion.runId, completion.stepId, completion.leaseToken, {}), /missing or stale/u);
  const failure = claimExpired("failure");
  assert.throws(() => store.failStep(failure.runId, failure.stepId, failure.leaseToken, "EXPIRED"), /missing or stale/u);
  const approval = claimExpired("approval");
  assert.throws(() => store.awaitApproval(approval.runId, approval.stepId, approval.leaseToken), /missing or stale/u);
  const cancellation = claimExpired("cancellation");
  store.requestCancellation(cancellation.runId);
  assert.throws(() => store.acknowledgeCancellation(cancellation.runId, cancellation.stepId, cancellation.leaseToken), /missing or stale/u);
  ledger.close();
});

test("Stage 10 aborts and quarantines a locally active dispatch at lease expiry", async () => {
  const state = await stateRoot("workflow-active-expiry");
  const ledger = createRunLedger({ stateDir: state });
  const store = new SqliteWorkflowStore(ledger.database);
  const definition = workflowDefinitionFromSteps({
    id: "fixture.active-expiry",
    name: "Active expiry fixture",
    steps: [{ id: "effect", actionRef: "remote.mutate", input: {}, retrySafety: "effectful" }]
  });
  let release!: () => void;
  let started!: () => void;
  let aborted = false;
  const dispatchStarted = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = new DurableWorkflowRuntime({
    store,
    leaseMs: 30,
    cancellationGraceMs: 20,
    dispatch: async ({ signal }) => {
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      started();
      await gate;
      return { status: "completed", result: { late: true } };
    }
  });
  await runtime.submit({ runId: "workflow-active-expiry-1", principalId: "test", idempotencyKey: "workflow-active-expiry-key", definition, input: {} });
  await dispatchStarted;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (store.get("workflow-active-expiry-1")?.status === "needs-review") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(aborted, true);
  assert.equal(store.get("workflow-active-expiry-1")?.status, "needs-review");
  assert.equal(store.get("workflow-active-expiry-1")?.steps[0]?.errorCode, "WORKFLOW_ACTIVE_LEASE_EXPIRED");
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(store.events("workflow-active-expiry-1").some((event) => event.type === "workflow.step.completed"), false);
  await runtime.shutdown();
  ledger.close();
});

test("Stage 10 bounds shutdown and quarantines non-cooperative active work", async () => {
  const state = await stateRoot("workflow-bounded-shutdown");
  const ledger = createRunLedger({ stateDir: state });
  const store = new SqliteWorkflowStore(ledger.database);
  const definition = workflowDefinitionFromSteps({
    id: "fixture.bounded-shutdown",
    name: "Bounded shutdown fixture",
    steps: [{ id: "effect", actionRef: "remote.mutate", input: {}, retrySafety: "effectful" }]
  });
  let release!: () => void;
  let started!: () => void;
  const dispatchStarted = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = new DurableWorkflowRuntime({
    store,
    cancellationGraceMs: 20,
    dispatch: async () => {
      started();
      await gate;
      return { status: "completed", result: { late: true } };
    }
  });
  await runtime.submit({ runId: "workflow-bounded-shutdown-1", principalId: "test", idempotencyKey: "workflow-bounded-shutdown-key", definition, input: {} });
  await dispatchStarted;
  const startedAt = Date.now();
  await runtime.shutdown();
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 500, `shutdown exceeded its bounded grace period: ${elapsedMs}ms`);
  assert.equal(store.get("workflow-bounded-shutdown-1")?.status, "needs-review");
  assert.equal(store.get("workflow-bounded-shutdown-1")?.steps[0]?.errorCode, "WORKFLOW_SHUTDOWN_OUTCOME_UNCERTAIN");
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(store.events("workflow-bounded-shutdown-1").some((event) => event.type === "workflow.step.completed"), false);
  ledger.close();
});

test("Stage 10 keeps parallel failure non-terminal until effectful siblings stop", async () => {
  const state = await stateRoot("workflow-parallel-failure");
  const ledger = createRunLedger({ stateDir: state });
  const store = new SqliteWorkflowStore(ledger.database);
  const definition = workflowDefinitionFromSteps({
    id: "fixture.parallel-failure",
    name: "Parallel failure fixture",
    steps: [
      { id: "fails", actionRef: "test.fail", input: {} },
      { id: "effect", actionRef: "remote.mutate", input: {}, retrySafety: "effectful" }
    ]
  });
  let release!: () => void;
  let siblingStarted!: () => void;
  const started = new Promise<void>((resolve) => { siblingStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = new DurableWorkflowRuntime({
    store,
    concurrency: 2,
    cancellationGraceMs: 100,
    dispatch: async ({ step }) => {
      if (step.stepId === "effect") {
        siblingStarted();
        await gate;
        return { status: "completed", result: { effectApplied: true } };
      }
      await started;
      return { status: "failed", errorCode: "EXPECTED_FAILURE" };
    }
  });
  await runtime.submit({ runId: "workflow-parallel-failure-1", principalId: "test", idempotencyKey: "workflow-parallel-failure-key", definition, input: {} });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (store.get("workflow-parallel-failure-1")?.status === "stopping") break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(store.get("workflow-parallel-failure-1")?.status, "stopping");
  assert.equal(store.get("workflow-parallel-failure-1")?.steps.find((step) => step.stepId === "effect")?.status, "running");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (store.get("workflow-parallel-failure-1")?.status === "needs-review") break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(store.get("workflow-parallel-failure-1")?.status, "needs-review");
  assert.equal(store.get("workflow-parallel-failure-1")?.steps.find((step) => step.stepId === "effect")?.errorCode, "WORKFLOW_STOP_OUTCOME_UNCERTAIN");
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(store.events("workflow-parallel-failure-1").some((event) => event.type === "workflow.step.completed" && (event.payload as any).stepId === "effect"), false);
  await runtime.shutdown();
  ledger.close();
});

test("Stage 10 cancellation after a parallel failure cannot hide uncertain sibling work", async () => {
  const state = await stateRoot("workflow-failure-cancel");
  const ledger = createRunLedger({ stateDir: state });
  const store = new SqliteWorkflowStore(ledger.database);
  const definition = workflowDefinitionFromSteps({
    id: "fixture.failure-cancel",
    name: "Failure cancellation fixture",
    steps: [
      { id: "fails", actionRef: "test.fail", input: {} },
      { id: "effect", actionRef: "remote.mutate", input: {}, retrySafety: "effectful" }
    ]
  });
  let release!: () => void;
  let siblingStarted!: () => void;
  const started = new Promise<void>((resolve) => { siblingStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = new DurableWorkflowRuntime({
    store,
    concurrency: 2,
    cancellationGraceMs: 20,
    dispatch: async ({ step }) => {
      if (step.stepId === "effect") { siblingStarted(); await gate; return { status: "completed", result: {} }; }
      await started;
      return { status: "failed", errorCode: "EXPECTED_FAILURE" };
    }
  });
  await runtime.submit({ runId: "workflow-failure-cancel-1", principalId: "test", idempotencyKey: "workflow-failure-cancel-key", definition, input: {} });
  for (let attempt = 0; attempt < 100 && store.get("workflow-failure-cancel-1")?.status !== "stopping"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(store.get("workflow-failure-cancel-1")?.status, "stopping");
  const cancelled = await runtime.cancel("workflow-failure-cancel-1");
  assert.equal(cancelled.status, "needs-review");
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(store.get("workflow-failure-cancel-1")?.status, "needs-review");
  await runtime.shutdown();
  ledger.close();
});

test("Stage 10 cancellation telemetry cannot outlive the cancellation grace", async () => {
  const state = await stateRoot("workflow-cancel-telemetry");
  const ledger = createRunLedger({ stateDir: state });
  const store = new SqliteWorkflowStore(ledger.database);
  const definition = workflowDefinitionFromSteps({ id: "fixture.cancel-telemetry", name: "Cancellation telemetry fixture", steps: [{ id: "step", actionRef: "text.echo", input: {} }] });
  let dispatchStarted!: () => void;
  const started = new Promise<void>((resolve) => { dispatchStarted = resolve; });
  let releaseTelemetry!: () => void;
  const telemetryGate = new Promise<void>((resolve) => { releaseTelemetry = resolve; });
  const runtime = new DurableWorkflowRuntime({
    store,
    cancellationGraceMs: 20,
    dispatch: async ({ signal }) => {
      dispatchStarted();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return { status: "completed", result: {} };
    },
    onEvent: async (event) => { if (event.type.startsWith("workflow.cancellation")) await telemetryGate; }
  });
  await runtime.submit({ runId: "workflow-cancel-telemetry-1", principalId: "test", idempotencyKey: "workflow-cancel-telemetry-key", definition, input: {} });
  await started;
  const startedAt = Date.now();
  const result = await runtime.cancel("workflow-cancel-telemetry-1");
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(result.status, "cancelled");
  releaseTelemetry();
  await runtime.shutdown();
  ledger.close();
});

test("Stage 10 never crosses dispatch after cancellation interrupts admission telemetry", async () => {
  const state = await stateRoot("workflow-admission-cancel");
  const ledger = createRunLedger({ stateDir: state });
  const store = new SqliteWorkflowStore(ledger.database);
  const definition = workflowDefinitionFromSteps({ id: "fixture.admission-cancel", name: "Admission cancellation fixture", steps: [{ id: "effect", actionRef: "remote.mutate", input: {}, retrySafety: "effectful" }] });
  let admissionStarted!: () => void;
  const admitted = new Promise<void>((resolve) => { admissionStarted = resolve; });
  let releaseAdmission!: () => void;
  const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
  let dispatches = 0;
  const runtime = new DurableWorkflowRuntime({
    store,
    cancellationGraceMs: 20,
    dispatch: async () => { dispatches += 1; return { status: "completed", result: {} }; },
    onEvent: async (event) => {
      if (event.type === "workflow.step.admitted") {
        admissionStarted();
        await admissionGate;
      }
    }
  });
  await runtime.submit({ runId: "workflow-admission-cancel-1", principalId: "test", idempotencyKey: "workflow-admission-cancel-key", definition, input: {} });
  await admitted;
  const result = await runtime.cancel("workflow-admission-cancel-1");
  assert.equal(result.status, "needs-review");
  releaseAdmission();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(dispatches, 0);
  await runtime.shutdown();
  ledger.close();
});

test("Stage 10 contains late dispatch rejection after bounded shutdown closes the ledger", async () => {
  const state = await stateRoot("workflow-post-close");
  const ledger = createRunLedger({ stateDir: state });
  const store = new SqliteWorkflowStore(ledger.database);
  const definition = workflowDefinitionFromSteps({ id: "fixture.post-close", name: "Post-close fixture", steps: [{ id: "effect", actionRef: "remote.mutate", input: {}, retrySafety: "effectful" }] });
  let release!: () => void;
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const rejections: unknown[] = [];
  const onUnhandled = (error: unknown) => { rejections.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const runtime = new DurableWorkflowRuntime({ store, cancellationGraceMs: 20, dispatch: async () => { started(); await gate; return { status: "completed", result: {} }; } });
    await runtime.submit({ runId: "workflow-post-close-1", principalId: "test", idempotencyKey: "workflow-post-close-key", definition, input: {} });
    await dispatched;
    await runtime.shutdown();
    ledger.close();
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(rejections, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("Stage 10 renews a live workflow lease for legitimate long-running work", { timeout: 10_000 }, async (t) => {
  const state = await stateRoot("workflow-lease-renewal");
  const ledger = createRunLedger({ stateDir: state });
  const store = new SqliteWorkflowStore(ledger.database);
  const definition = workflowDefinitionFromSteps({ id: "fixture.lease-renewal", name: "Lease renewal fixture", steps: [{ id: "step", actionRef: "remote.long", input: {}, retrySafety: "effectful" }] });
  let renewals = 0;
  let markDispatchFinished!: () => void;
  const dispatchFinished = new Promise<void>((resolve) => { markDispatchFinished = resolve; });
  const runtime = new DurableWorkflowRuntime({
    store,
    leaseMs: 40,
    dispatch: async (_context) => {
      try {
        for (let index = 0; index < 4; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          assert.equal(_context.renewLease(), true);
          renewals += 1;
        }
        return { status: "completed", result: {} };
      } finally {
        markDispatchFinished();
      }
    }
  });
  t.after(async () => {
    await runtime.shutdown();
    ledger.close();
  });
  await runtime.submit({ runId: "workflow-lease-renewal-1", principalId: "test", idempotencyKey: "workflow-lease-renewal-key", definition, input: {} });
  await dispatchFinished;
  for (let attempt = 0; attempt < 200 && store.get("workflow-lease-renewal-1")?.status !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(renewals, 4);
  assert.equal(store.get("workflow-lease-renewal-1")?.status, "completed");
});

test("Stage 10 gateway dispatch heartbeats its workflow lease until settlement", async () => {
  let renewals = 0;
  let release!: () => void;
  const operation = new Promise<string>((resolve) => { release = () => resolve("completed"); });
  const running = runWithWorkflowLeaseHeartbeat(() => operation, () => {
    renewals += 1;
    return true;
  }, 10);
  for (let attempt = 0; attempt < 100 && renewals < 3; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(renewals >= 3);
  release();
  assert.equal(await running, "completed");
  const settledRenewals = renewals;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(renewals, settledRenewals);
});

test("Stage 10 tolerates a concurrent duplicate workflow column migration", () => {
  const fake = {
    db: {
      exec(sql: string) { if (sql.startsWith("ALTER TABLE workflow_runs ADD COLUMN")) throw new Error("duplicate column name: simulated"); },
      prepare(sql: string) { return { all: () => sql.startsWith("PRAGMA table_info") ? [] : [] }; }
    }
  };
  assert.doesNotThrow(() => new SqliteWorkflowStore(fake as any));
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

test("Stage 11 times out a hung dispatch and fences its late completion", async () => {
  const state = await stateRoot("event-dispatch-timeout");
  const ledger = createRunLedger({ stateDir: state });
  let aborted = false;
  let finish!: (status: "completed") => void;
  const ingress = new DurableEventIngress({
    database: ledger.database,
    dispatchLeaseMs: 80,
    dispatch: async (_candidate, { signal }) => {
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return new Promise<"completed">((resolve) => { finish = resolve; });
    }
  });
  const authDigest = sourceAuthDigest("fixture-secret");
  ingress.registerSource({ source: "fixture", authDigest });
  ingress.registerWatch("watch-timeout", { schemaVersion: 1, id: "watch-timeout", revision: 1, enabled: true, actionRef: "remote.mutate", kind: "event", source: "fixture", event: "message", match: [] });
  const event = { schemaVersion: 1, source: "fixture", event: "message", sequence: 0, cursor: "odinn-event-v1/fixture/0", occurredAtUnixMs: 1, attributes: {} };
  const result = await ingress.ingest(event, authDigest);
  assert.equal(result.deliveries.at(-1)?.status, "needs-review");
  assert.equal(aborted, true);
  const delivery = ingress.delivery(result.candidates[0]!.idempotencyKey);
  assert.equal(delivery?.status, "needs-review");
  assert.equal(delivery?.errorCode, "EVENT_DISPATCH_LEASE_EXPIRED");
  finish("completed");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ingress.delivery(result.candidates[0]!.idempotencyKey)?.status, "needs-review");
  await ingress.shutdown();
  ledger.close();
});

test("Stage 11 renews a live dispatch lease beyond its original deadline", async () => {
  const state = await stateRoot("event-dispatch-renewal");
  const ledger = createRunLedger({ stateDir: state });
  let renewals = 0;
  const ingress = new DurableEventIngress({
    database: ledger.database,
    dispatchLeaseMs: 400,
    dispatch: async (_candidate, { renewLease }) => {
      for (let index = 0; index < 6; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(renewLease(), true);
        renewals += 1;
      }
      return "completed";
    }
  });
  const authDigest = sourceAuthDigest("fixture-secret");
  ingress.registerSource({ source: "fixture", authDigest });
  ingress.registerWatch("watch-renew", { schemaVersion: 1, id: "watch-renew", revision: 1, enabled: true, actionRef: "remote.mutate", kind: "event", source: "fixture", event: "message", match: [] });
  const event = { schemaVersion: 1, source: "fixture", event: "message", sequence: 0, cursor: "odinn-event-v1/fixture/0", occurredAtUnixMs: 1, attributes: {} };
  const result = await ingress.ingest(event, authDigest);
  assert.equal(renewals, 6);
  assert.equal(ingress.delivery(result.candidates[0]!.idempotencyKey)?.status, "completed");
  await ingress.shutdown();
  ledger.close();
});

test("Stage 11 rejects completion after event-loop starvation outlives the lease", async () => {
  const state = await stateRoot("event-dispatch-starvation");
  const ledger = createRunLedger({ stateDir: state });
  const ingress = new DurableEventIngress({
    database: ledger.database,
    dispatchLeaseMs: 25,
    dispatch: async () => {
      const deadline = Date.now() + 80;
      while (Date.now() < deadline) { /* Deliberately starve the expiry timer. */ }
      return "completed";
    }
  });
  const authDigest = sourceAuthDigest("fixture-secret");
  ingress.registerSource({ source: "fixture", authDigest });
  ingress.registerWatch("watch-starvation", { schemaVersion: 1, id: "watch-starvation", revision: 1, enabled: true, actionRef: "remote.mutate", kind: "event", source: "fixture", event: "message", match: [] });
  const event = { schemaVersion: 1, source: "fixture", event: "message", sequence: 0, cursor: "odinn-event-v1/fixture/0", occurredAtUnixMs: 1, attributes: {} };
  const result = await ingress.ingest(event, authDigest);
  const delivery = ingress.delivery(result.candidates[0]!.idempotencyKey);
  assert.equal(delivery?.status, "needs-review");
  assert.equal(delivery?.errorCode, "EVENT_DISPATCH_LEASE_EXPIRED");
  await ingress.close();
  ledger.close();
});

test("Stage 11 reconciles orphaned future leases while the process remains alive", async () => {
  const state = await stateRoot("event-dispatch-recovery");
  const ledger = createRunLedger({ stateDir: state });
  const setup = new DurableEventIngress({ database: ledger.database });
  const authDigest = sourceAuthDigest("fixture-secret");
  setup.registerSource({ source: "fixture", authDigest });
  setup.registerWatch("watch-recovery", { schemaVersion: 1, id: "watch-recovery", revision: 1, enabled: true, actionRef: "remote.mutate", kind: "event", source: "fixture", event: "message", match: [] });
  const event = { schemaVersion: 1, source: "fixture", event: "message", sequence: 0, cursor: "odinn-event-v1/fixture/0", occurredAtUnixMs: 1, attributes: {} };
  const result = await setup.ingest(event, authDigest);
  const idempotencyKey = result.candidates[0]!.idempotencyKey;
  ledger.database.db.prepare("UPDATE event_deliveries SET dispatch_token='orphan', dispatch_lease_expires_at=? WHERE idempotency_key=?").run(new Date(Date.now() + 25).toISOString(), idempotencyKey);
  const recovering = new DurableEventIngress({ database: ledger.database, dispatchLeaseMs: 25 });
  for (let attempt = 0; attempt < 100 && recovering.delivery(idempotencyKey)?.status === "queued"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(recovering.delivery(idempotencyKey)?.status, "needs-review");
  assert.equal(recovering.delivery(idempotencyKey)?.errorCode, "EVENT_DISPATCH_LEASE_EXPIRED");
  await Promise.all([setup.shutdown(), recovering.shutdown()]);
  ledger.close();
});

test("Stage 11 shutdown aborts and quarantines active event effects", async () => {
  const state = await stateRoot("event-dispatch-shutdown");
  const ledger = createRunLedger({ stateDir: state });
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => { started = resolve; });
  let observedAbort = false;
  let finish!: (status: "completed") => void;
  const ingress = new DurableEventIngress({
    database: ledger.database,
    dispatchLeaseMs: 10_000,
    dispatch: async (_candidate, { signal }) => {
      started();
      return new Promise<"completed">((resolve) => {
        finish = resolve;
        signal.addEventListener("abort", () => { observedAbort = true; }, { once: true });
      });
    }
  });
  const authDigest = sourceAuthDigest("fixture-secret");
  ingress.registerSource({ source: "fixture", authDigest });
  ingress.registerWatch("watch-shutdown", { schemaVersion: 1, id: "watch-shutdown", revision: 1, enabled: true, actionRef: "remote.mutate", kind: "event", source: "fixture", event: "message", match: [] });
  const event = { schemaVersion: 1, source: "fixture", event: "message", sequence: 0, cursor: "odinn-event-v1/fixture/0", occurredAtUnixMs: 1, attributes: {} };
  const ingesting = ingress.ingest(event, authDigest);
  await dispatched;
  const closing = ingress.close();
  assert.ok(closing instanceof Promise);
  await closing;
  const result = await ingesting;
  assert.equal(observedAbort, true);
  const delivery = ingress.delivery(result.candidates[0]!.idempotencyKey);
  assert.equal(delivery?.status, "needs-review");
  assert.equal(delivery?.errorCode, "EVENT_DISPATCH_SHUTDOWN");
  ledger.close();
  finish("completed");
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test("Stage 11 fire-and-forget close remains safe after the owning ledger closes", async () => {
  const state = await stateRoot("event-dispatch-unawaited-close");
  const ledger = createRunLedger({ stateDir: state });
  let started!: () => void;
  let finish!: (status: "completed") => void;
  const dispatched = new Promise<void>((resolve) => { started = resolve; });
  const ingress = new DurableEventIngress({
    database: ledger.database,
    dispatchLeaseMs: 10_000,
    dispatch: async () => {
      started();
      return new Promise<"completed">((resolve) => { finish = resolve; });
    }
  });
  const authDigest = sourceAuthDigest("fixture-secret");
  ingress.registerSource({ source: "fixture", authDigest });
  ingress.registerWatch("watch-unawaited-close", { schemaVersion: 1, id: "watch-unawaited-close", revision: 1, enabled: true, actionRef: "remote.mutate", kind: "event", source: "fixture", event: "message", match: [] });
  const event = { schemaVersion: 1, source: "fixture", event: "message", sequence: 0, cursor: "odinn-event-v1/fixture/0", occurredAtUnixMs: 1, attributes: {} };
  const ingesting = ingress.ingest(event, authDigest);
  await dispatched;
  void ingress.close();
  ledger.close();
  finish("completed");
  const result = await ingesting;
  assert.equal(result.deliveries.at(-1)?.status, "needs-review");
  await new Promise((resolve) => setTimeout(resolve, 10));
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
