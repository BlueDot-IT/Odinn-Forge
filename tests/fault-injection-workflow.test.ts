import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DurableWorkflowRuntime,
  createRunLedger,
  workflowDefinitionFromSteps
} from "../packages/kernel/src/index.ts";
import { SqliteWorkflowStore } from "../packages/store-sqlite/src/index.ts";

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

type Evidence = {
  caseId: string;
  injectionPoint: string;
  physicalDispatches: number;
  replayDispatches: number;
  workflowStatus: string;
  stepStatus: string;
  eventTypes: string[];
  invariants: {
    noDuplicatePhysicalDispatch: boolean;
    noFalseCompletion: boolean;
    cleanupVerified: boolean;
  };
};

type Fixture = {
  root: string;
  ledger: ReturnType<typeof createRunLedger>;
  store: SqliteWorkflowStore;
  closed: boolean;
};

const evidence: Evidence[] = [];

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function waitFor<T>(read: () => T | undefined, label: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function fixture(prefix: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `odinn-issue-139-${prefix}-`));
  const ledger = createRunLedger({ stateDir: join(root, ".odinn"), workspaceRoot: root });
  return { root, ledger, store: new SqliteWorkflowStore(ledger.database), closed: false };
}

async function closeFixture(fixtureValue: Fixture, runtimes: readonly DurableWorkflowRuntime[]): Promise<boolean> {
  for (const runtime of runtimes) await runtime.shutdown().catch(() => undefined);
  if (!fixtureValue.closed) {
    fixtureValue.ledger.close();
    fixtureValue.closed = true;
  }
  await rm(fixtureValue.root, { recursive: true, force: true });
  return !existsSync(fixtureValue.root);
}

function workflow(id: string, retrySafety: "retry-safe" | "effectful" = "effectful") {
  return workflowDefinitionFromSteps({
    id: `fixture.issue-139.${id}`,
    name: `Issue 139 ${id}`,
    steps: [{ id: "effect", actionRef: "controlled.fake", input: { marker: id }, retrySafety, maxAttempts: 2 }]
  });
}

function summarize(fixtureValue: Fixture, runId: string, caseId: string, injectionPoint: string, physicalDispatches: number, replayDispatches: number, cleanupVerified: boolean): Evidence {
  const run = fixtureValue.store.get(runId)!;
  const eventTypes = fixtureValue.store.events(runId).map((event) => String(event.type));
  return {
    caseId,
    injectionPoint,
    physicalDispatches,
    replayDispatches,
    workflowStatus: String(run.status),
    stepStatus: String(run.steps[0]?.status),
    eventTypes,
    invariants: {
      noDuplicatePhysicalDispatch: physicalDispatches <= 1 && replayDispatches === 0,
      noFalseCompletion: run.status === "completed" ? eventTypes.filter((type) => type === "workflow.completed").length === 1 : !eventTypes.includes("workflow.completed"),
      cleanupVerified
    }
  };
}

test("issue #139: admission barrier prevents pre-dispatch cancellation from crossing the effect boundary", async () => {
  const fixtureValue = await fixture("pre-dispatch");
  const runtimes: DurableWorkflowRuntime[] = [];
  let cleaned = false;
  try {
    const runId = "issue-139-pre-dispatch";
    const admissionReached = deferred<void>();
    const releaseAdmission = deferred<void>();
    let physicalDispatches = 0;
    const runtime = new DurableWorkflowRuntime({
      store: fixtureValue.store,
      cancellationGraceMs: 1_000,
      onEvent: async (event) => {
        if (event.type !== "workflow.step.admitted") return;
        admissionReached.resolve();
        await releaseAdmission.promise;
      },
      dispatch: async () => {
        physicalDispatches += 1;
        return { status: "completed", result: { shouldNotDispatch: true } };
      }
    });
    runtimes.push(runtime);

    await runtime.submit({ runId, principalId: "issue-139", idempotencyKey: runId, definition: workflow("pre-dispatch"), input: {} });
    await admissionReached.promise;
    const cancellation = runtime.cancel(runId);
    await waitFor(() => fixtureValue.store.get(runId)?.status === "cancelling" ? true : undefined, "cancellation fence");
    releaseAdmission.resolve();
    const result = await cancellation;

    assert.equal(result.status, "cancelled");
    assert.equal(result.steps[0]?.status, "cancelled");
    assert.equal(physicalDispatches, 0);
    assert.equal(fixtureValue.store.events(runId).some((event) => event.type === "workflow.step.completed"), false);

    const resultEvidence = summarize(fixtureValue, runId, "pre-dispatch-cancel", "after admission, before dispatch", physicalDispatches, 0, false);
    cleaned = await closeFixture(fixtureValue, runtimes);
    resultEvidence.invariants.cleanupVerified = cleaned;
    evidence.push(resultEvidence);
  } finally {
    if (!cleaned) await closeFixture(fixtureValue, runtimes);
  }
});

test("issue #139: shutdown after a physical effect quarantines the lease and restart does not replay it", async () => {
  const fixtureValue = await fixture("post-dispatch");
  const runtimes: DurableWorkflowRuntime[] = [];
  let cleaned = false;
  try {
    const runId = "issue-139-post-dispatch";
    const effectReached = deferred<void>();
    const releaseDispatch = deferred<void>();
    const dispatchReturned = deferred<void>();
    let physicalDispatches = 0;
    let replayDispatches = 0;
    const runtime = new DurableWorkflowRuntime({
      store: fixtureValue.store,
      cancellationGraceMs: 20,
      dispatch: async () => {
        physicalDispatches += 1;
        effectReached.resolve();
        await releaseDispatch.promise;
        dispatchReturned.resolve();
        return { status: "completed", result: { applied: true } };
      }
    });
    runtimes.push(runtime);

    await runtime.submit({ runId, principalId: "issue-139", idempotencyKey: runId, definition: workflow("post-dispatch"), input: {} });
    await effectReached.promise;
    const shutdown = runtime.shutdown();
    await waitFor(() => fixtureValue.store.get(runId)?.status === "needs-review" ? true : undefined, "post-dispatch quarantine");
    releaseDispatch.resolve();
    await dispatchReturned.promise;
    await shutdown;

    const restarted = new DurableWorkflowRuntime({
      store: fixtureValue.store,
      dispatch: async () => {
        replayDispatches += 1;
        return { status: "completed", result: { replayed: true } };
      }
    });
    runtimes.push(restarted);
    await restarted.start();
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    const run = fixtureValue.store.get(runId)!;
    assert.equal(run.status, "needs-review");
    assert.equal(run.steps[0]?.status, "needs-review");
    assert.equal(physicalDispatches, 1);
    assert.equal(replayDispatches, 0);
    assert.equal(fixtureValue.store.events(runId).some((event) => event.type === "workflow.step.completed"), false);

    const resultEvidence = summarize(fixtureValue, runId, "post-dispatch-shutdown", "after physical effect, before durable settlement", physicalDispatches, replayDispatches, false);
    cleaned = await closeFixture(fixtureValue, runtimes);
    resultEvidence.invariants.cleanupVerified = cleaned;
    evidence.push(resultEvidence);
  } finally {
    if (!cleaned) await closeFixture(fixtureValue, runtimes);
  }
});

test("issue #139: settlement failure before SQLite commit is needs-review and never retries the effect", async () => {
  const fixtureValue = await fixture("settlement-before-commit");
  const runtimes: DurableWorkflowRuntime[] = [];
  let cleaned = false;
  try {
    const runId = "issue-139-settlement-before-commit";
    const dispatchReached = deferred<void>();
    let physicalDispatches = 0;
    let replayDispatches = 0;
    const originalCompleteStep = fixtureValue.store.completeStep.bind(fixtureValue.store);
    (fixtureValue.store as any).completeStep = (..._args: unknown[]) => {
      throw new Error("ISSUE_139_INJECTED_SETTLEMENT_FAILURE_BEFORE_COMMIT");
    };

    const runtime = new DurableWorkflowRuntime({
      store: fixtureValue.store,
      dispatch: async () => {
        physicalDispatches += 1;
        dispatchReached.resolve();
        return { status: "completed", result: { applied: true } };
      }
    });
    runtimes.push(runtime);
    await runtime.submit({ runId, principalId: "issue-139", idempotencyKey: runId, definition: workflow("settlement-before-commit"), input: {} });
    await dispatchReached.promise;
    await waitFor(() => fixtureValue.store.get(runId)?.status === "needs-review" ? true : undefined, "pre-commit settlement quarantine");

    const first = fixtureValue.store.get(runId)!;
    assert.equal(first.status, "needs-review");
    assert.equal(first.steps[0]?.status, "needs-review");
    assert.equal(physicalDispatches, 1);
    assert.equal(fixtureValue.store.events(runId).some((event) => event.type === "workflow.completed"), false);

    (fixtureValue.store as any).completeStep = originalCompleteStep;
    const restarted = new DurableWorkflowRuntime({
      store: fixtureValue.store,
      dispatch: async () => {
        replayDispatches += 1;
        return { status: "completed", result: { replayed: true } };
      }
    });
    runtimes.push(restarted);
    await restarted.start();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(replayDispatches, 0);

    const resultEvidence = summarize(fixtureValue, runId, "settlement-before-commit", "completeStep before SQLite commit", physicalDispatches, replayDispatches, false);
    cleaned = await closeFixture(fixtureValue, runtimes);
    resultEvidence.invariants.cleanupVerified = cleaned;
    evidence.push(resultEvidence);
  } finally {
    if (!cleaned) await closeFixture(fixtureValue, runtimes);
  }
});

test("issue #139: durable settlement wins when the post-commit acknowledgement is lost", async () => {
  const fixtureValue = await fixture("settlement-after-commit");
  const runtimes: DurableWorkflowRuntime[] = [];
  let cleaned = false;
  try {
    const runId = "issue-139-settlement-after-commit";
    const dispatchReached = deferred<void>();
    const committed = deferred<void>();
    let physicalDispatches = 0;
    let replayDispatches = 0;
    const originalCompleteStep = fixtureValue.store.completeStep.bind(fixtureValue.store);
    (fixtureValue.store as any).completeStep = (...args: unknown[]) => {
      const result = originalCompleteStep(...(args as [string, string, string, unknown]));
      committed.resolve();
      throw new Error("ISSUE_139_INJECTED_SETTLEMENT_ACKNOWLEDGEMENT_LOSS");
    };

    const runtime = new DurableWorkflowRuntime({
      store: fixtureValue.store,
      dispatch: async () => {
        physicalDispatches += 1;
        dispatchReached.resolve();
        return { status: "completed", result: { applied: true } };
      }
    });
    runtimes.push(runtime);
    await runtime.submit({ runId, principalId: "issue-139", idempotencyKey: runId, definition: workflow("settlement-after-commit"), input: {} });
    await dispatchReached.promise;
    await committed.promise;
    await waitFor(() => fixtureValue.store.get(runId)?.status === "completed" ? true : undefined, "post-commit durable completion");

    const completed = fixtureValue.store.get(runId)!;
    assert.equal(completed.status, "completed");
    assert.equal(completed.steps[0]?.status, "completed");
    assert.equal(physicalDispatches, 1);
    assert.equal(fixtureValue.store.events(runId).filter((event) => event.type === "workflow.completed").length, 1);

    (fixtureValue.store as any).completeStep = originalCompleteStep;
    const restarted = new DurableWorkflowRuntime({
      store: fixtureValue.store,
      dispatch: async () => {
        replayDispatches += 1;
        return { status: "completed", result: { replayed: true } };
      }
    });
    runtimes.push(restarted);
    await restarted.start();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(replayDispatches, 0);

    const resultEvidence = summarize(fixtureValue, runId, "settlement-after-commit", "completeStep after SQLite commit", physicalDispatches, replayDispatches, false);
    cleaned = await closeFixture(fixtureValue, runtimes);
    resultEvidence.invariants.cleanupVerified = cleaned;
    evidence.push(resultEvidence);
  } finally {
    if (!cleaned) await closeFixture(fixtureValue, runtimes);
  }
});

test("issue #139 evidence is machine-readable and sanitized", () => {
  assert.equal(evidence.length, 4);
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /token|secret|credential|password|authorization/iu);
  assert.ok(evidence.every((entry) => entry.invariants.noDuplicatePhysicalDispatch && entry.invariants.cleanupVerified));
  process.stdout.write(`ISSUE_139_EVIDENCE ${serialized}\n`);
});
