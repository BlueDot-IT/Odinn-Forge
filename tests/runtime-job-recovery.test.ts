import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecutionEnvelopeV1, JsonObject } from "../packages/protocol/src/index.ts";
import { createDefaultPolicy } from "../packages/policy/src/index.ts";
import { createAuditStore, createRunLedger, JobSupervisor, runTask, SqliteJobStore } from "../packages/kernel/src/index.ts";

function executionEnvelope(root: string, runId: string, retrySafe: boolean): ExecutionEnvelopeV1 {
  const digest = "a".repeat(64);
  return {
    version: 1,
    runId,
    principalId: "principal:test",
    execution: { kind: "tool", id: "text.echo" },
    inputDigest: digest,
    inputReference: `artifact:sha256:${digest}`,
    capabilityDecisionReferences: [`policy:${runId}`],
    approvalRequirements: [],
    timeoutMs: 30_000,
    resourceLimits: { maxInputBytes: 16_384, maxOutputBytes: 65_536, maxPersistedStateBytes: 131_072, maxConcurrency: 1 },
    idempotencyKey: `request:${runId}`,
    retrySafety: retrySafe ? "retry-safe" : "not-retry-safe",
    workspaceRoot: root,
    sandboxProfile: "inspect-only",
    auditCorrelationId: `audit:${runId}`,
    cancellationControlReference: `cancel:${runId}`
  };
}

async function createRunningJob(store: SqliteJobStore, id: string, retrySafe: boolean, lease = false) {
  await store.create({ id, status: "queued", payload: { task: { id, tool: "text.echo", input: { text: id } } }, retrySafe });
  return store.claim(id, {
    status: "running",
    attempts: 1,
    startedAt: new Date().toISOString(),
    ...(lease ? { dispatchLease: {
      token: `lease-${id}`, owner: "test-supervisor", epoch: "test-epoch",
      acquiredAt: new Date(Date.now() - 120_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString()
    } } : {})
  });
}

async function waitForJob(store: SqliteJobStore, id: string, status: string) {
  let current: Awaited<ReturnType<SqliteJobStore["get"]>>;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    current = await store.get(id);
    if (current?.status === status) return current;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`runtime job ${id} did not reach ${status}: ${JSON.stringify(current)}`);
}

test("SQLite supervisor drains more than the operator list window in FIFO order", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-runtime-job-queue-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = createRunLedger({ stateDir: join(root, ".odinn"), workspaceRoot: root });
  t.after(() => ledger.close());
  const store = new SqliteJobStore(ledger);
  const ids = Array.from({ length: 600 }, (_, index) => `queued-${String(index).padStart(4, "0")}`);
  for (const id of ids) {
    await store.create({ id, status: "queued", payload: { task: { id, tool: "text.echo", input: { text: id } } } });
  }
  let signalFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve;
  });
  let releaseFirst!: () => void;
  let first = true;
  const executions: string[] = [];
  const supervisor = new JobSupervisor({
    store,
    concurrency: 1,
    execute: async (payload) => {
      const id = String((payload.task as JsonObject).id);
      executions.push(id);
      if (first) {
        first = false;
        signalFirstStarted();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { ok: true };
    }
  });
  t.after(() => supervisor.shutdown());
  await supervisor.start();
  await firstStarted.catch(() => undefined);
  releaseFirst();
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const row = ledger.database.db.prepare("SELECT COUNT(*) AS count FROM runtime_jobs WHERE status = 'completed'").get() as { count: number };
    if (Number(row.count) === ids.length) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const statuses = ledger.database.db.prepare("SELECT status, COUNT(*) AS count FROM runtime_jobs GROUP BY status").all() as Array<{ status: string; count: number }>;
  assert.deepEqual(Object.fromEntries(statuses.map((row) => [row.status, Number(row.count)])), { completed: ids.length });
  assert.deepEqual(executions, ids);
  const deepPage = await store.queryJobs({ status: "completed", offset: 500, limit: 100 });
  assert.equal(deepPage.total, ids.length);
  assert.equal(deepPage.items.length, 100);
});

test("live dispatch uses volatile input while restart fails closed when redacted input is unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-runtime-job-volatile-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = createRunLedger({ stateDir: join(root, ".odinn"), workspaceRoot: root });
  t.after(() => ledger.close());
  const store = new SqliteJobStore(ledger);
  let receivedValue: unknown;
  const supervisor = new JobSupervisor({
    store,
    execute: async (payload) => {
      receivedValue = ((payload.task as JsonObject).input as JsonObject).value;
      return { ok: true };
    }
  });
  await supervisor.start();
  await supervisor.submit({ task: { tool: "browser.type", input: { value: "live secret text" } } }, { id: "volatile-live" });
  await waitForJob(store, "volatile-live", "completed");
  assert.equal(receivedValue, "live secret text");
  const durable = await store.get("volatile-live");
  assert.equal(((durable?.payload.task as JsonObject).input as JsonObject).value, "[redacted]");
  assert.equal(durable?.recoveryInputAvailable, false);
  await supervisor.shutdown();

  await store.create({
    id: "volatile-after-restart",
    status: "queued",
    payload: { task: { id: "volatile-after-restart", tool: "browser.type", input: { value: "lost secret text" } } },
    retrySafe: true
  });
  let restartedExecutions = 0;
  const restarted = new JobSupervisor({
    store,
    execute: async () => {
      restartedExecutions += 1;
      return { ok: true };
    }
  });
  await restarted.start();
  const failed = await waitForJob(store, "volatile-after-restart", "failed");
  assert.match(failed.error ?? "", /volatile execution input is unavailable/u);
  assert.equal(restartedExecutions, 0);
  await restarted.shutdown();
});

test("workspace job payloads and results persist only shared durable projections", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-runtime-job-workspace-projection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = createRunLedger({ stateDir: join(root, ".odinn"), workspaceRoot: root });
  t.after(() => ledger.close());
  const store = new SqliteJobStore(ledger);
  const querySentinel = "WORKSPACE_JOB_QUERY_47f18d";
  const beforeSentinel = "WORKSPACE_JOB_BEFORE_8b02a1";
  const resultSentinel = "WORKSPACE_JOB_RESULT_1d930c";
  const received: string[] = [];
  const supervisor = new JobSupervisor({
    store,
    execute: async (payload) => {
      const task = payload.task as JsonObject;
      const input = task.input as JsonObject;
      if (task.tool === "workspace.search") {
        received.push(String(input.query));
        return { id: task.id, output: {
          path: ".", resolvedPath: ".", searchedFiles: 1, searchedBytes: 32,
          matches: [{ path: "note.txt", resolvedPath: "note.txt", digest: `sha256:${"a".repeat(64)}`, matches: [{ line: 1, text: resultSentinel }] }]
        } };
      }
      received.push(String(input.before));
      return { id: task.id, output: {
        path: "note.txt", resolvedPath: "note.txt", basePath: "/provided",
        beforeDigest: `sha256:${"b".repeat(64)}`, digest: `sha256:${"c".repeat(64)}`,
        diffDigest: `sha256:${"d".repeat(64)}`, diff: resultSentinel, truncated: false
      } };
    }
  });
  await supervisor.start();
  await supervisor.submit({ task: { tool: "workspace.search", input: { query: querySentinel } } }, { id: "workspace-search-job" });
  await waitForJob(store, "workspace-search-job", "completed");
  await supervisor.submit({ task: { tool: "workspace.diff", input: { path: "note.txt", before: beforeSentinel } } }, { id: "workspace-diff-job" });
  await waitForJob(store, "workspace-diff-job", "completed");
  assert.deepEqual(received, [querySentinel, beforeSentinel]);
  for (const id of ["workspace-search-job", "workspace-diff-job"]) {
    const row = ledger.database.db.prepare("SELECT payload_json, result_json, payload_recoverable FROM runtime_jobs WHERE id = ?").get(id) as {
      payload_json: string; result_json: string; payload_recoverable: number;
    };
    assert.equal(row.payload_recoverable, 0);
    assert.doesNotMatch(row.payload_json, new RegExp(`${querySentinel}|${beforeSentinel}`, "u"));
    assert.doesNotMatch(row.result_json, new RegExp(resultSentinel, "u"));
    assert.match(row.payload_json, /(?:query|before)Digest/u);
    assert.equal((JSON.parse(row.result_json) as JsonObject).contentUnavailableOnReplay, true);
  }
  await supervisor.shutdown();
});

test("SQLite runtime jobs import legacy state once and preserve the source as rollback evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-runtime-job-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, ".odinn");
  const legacyPath = join(stateDir, "jobs.json");
  await mkdir(stateDir, { recursive: true });
  await writeFile(legacyPath, `${JSON.stringify({
    schemaVersion: 1,
    jobs: {
      legacy: {
        schemaVersion: 1, id: "legacy", status: "queued", payload: { task: { id: "legacy", tool: "text.echo", input: { text: "legacy" } } },
        retrySafe: true, attempts: 0, timeoutMs: 1_000, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
      },
      legacy_unsafe_running: {
        schemaVersion: 1, id: "legacy_unsafe_running", status: "running", payload: { task: { id: "legacy_unsafe_running", tool: "session.create", input: { title: "uncertain" } } },
        retrySafe: false, attempts: 1, timeoutMs: 1_000, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
      }
    }
  }, null, 2)}\n`);
  const ledger = createRunLedger({ stateDir, workspaceRoot: root });
  t.after(() => ledger.close());
  const store = new SqliteJobStore(ledger, { legacyPath });

  const recovery = await store.recover({ maxAttempts: 3 });
  assert.equal(recovery.queued, 1);
  assert.equal(recovery.needsReview, 1);
  assert.equal((await store.get("legacy_unsafe_running"))?.status, "needs-review");
  assert.equal((await store.get("legacy"))?.payload.task instanceof Object, true);
  assert.equal((await store.importLegacy()).imported, false);
  assert.match(await readFile(legacyPath, "utf8"), /"legacy"/u);
  const marker = ledger.database.db.prepare("SELECT imported_jobs, source_digest FROM runtime_job_imports").get() as { imported_jobs: number; source_digest: string };
  assert.equal(Number(marker.imported_jobs), 2);
  assert.match(marker.source_digest, /^[a-f0-9]{64}$/u);
  await writeFile(legacyPath, `${JSON.stringify({ schemaVersion: 1, jobs: {} })}\n`);
  await assert.rejects(() => store.importLegacy(), /changed after SQLite cutover/u);
});

test("SQLite runtime jobs atomically claim leases and bind terminal execution identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-runtime-job-claim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, ".odinn");
  const leftLedger = createRunLedger({ stateDir, workspaceRoot: root });
  const rightLedger = createRunLedger({ stateDir, workspaceRoot: root });
  t.after(() => { leftLedger.close(); rightLedger.close(); });
  const left = new SqliteJobStore(leftLedger);
  const right = new SqliteJobStore(rightLedger);
  const runId = "runtime-claim";
  leftLedger.ensureRun({ runId, objective: "claim once" });
  const admitted = leftLedger.admitExecution(executionEnvelope(root, runId, true));
  await left.create({ id: runId, status: "queued", payload: { task: { id: runId, tool: "text.echo", input: {} } }, retrySafe: true });
  const lease = {
    token: "lease-runtime-claim", owner: "test-supervisor", epoch: "test-epoch",
    acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  const [first, second] = await Promise.all([
    left.claim(runId, { status: "running", attempts: 1, dispatchLease: lease }),
    right.claim(runId, { status: "running", attempts: 1, dispatchLease: { ...lease, token: "lease-other" } })
  ]);
  assert.equal([first, second].filter(Boolean).length, 1);
  leftLedger.transitionExecutionAttempt({ attemptId: admitted.attempt.id, from: "queued", to: "running" });
  const completed = await left.update(runId, { status: "completed", completedAt: new Date().toISOString(), result: { ok: true }, dispatchLease: undefined });
  assert.equal(completed.executionAttemptId, admitted.attempt.id);
  assert.equal(completed.envelopeDigest, admitted.envelopeDigest);
  assert.equal(completed.auditCorrelationId, `audit:${runId}`);
  assert.equal(completed.cancellationControlReference, `cancel:${runId}`);
  assert.equal(leftLedger.getExecutionAttempt(admitted.attempt.id)?.state, "completed");
  const leaseRow = leftLedger.database.db.prepare("SELECT released_at, release_reason FROM runtime_job_leases WHERE job_id = ?").get(runId) as { released_at: string; release_reason: string };
  assert.ok(leaseRow.released_at);
  assert.equal(leaseRow.release_reason, "completed");
});

test("restart recovery classifies every crash boundary without replaying unsafe work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-runtime-job-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = createRunLedger({ stateDir: join(root, ".odinn"), workspaceRoot: root });
  t.after(() => ledger.close());
  const store = new SqliteJobStore(ledger);

  await createRunningJob(store, "before-admission", false);

  ledger.ensureRun({ runId: "admitted-not-dispatched", objective: "queued attempt" });
  const queued = ledger.admitExecution(executionEnvelope(root, "admitted-not-dispatched", false));
  await createRunningJob(store, "admitted-not-dispatched", false);

  ledger.ensureRun({ runId: "unsafe-dispatched", objective: "unsafe dispatch" });
  const unsafe = ledger.admitExecution(executionEnvelope(root, "unsafe-dispatched", false));
  ledger.transitionExecutionAttempt({ attemptId: unsafe.attempt.id, from: "queued", to: "running" });
  await createRunningJob(store, "unsafe-dispatched", false, true);

  ledger.ensureRun({ runId: "safe-dispatched", objective: "safe dispatch" });
  const safe = ledger.admitExecution(executionEnvelope(root, "safe-dispatched", true));
  ledger.transitionExecutionAttempt({ attemptId: safe.attempt.id, from: "queued", to: "running" });
  await createRunningJob(store, "safe-dispatched", true);

  ledger.ensureRun({ runId: "approval-pending", objective: "approval" });
  const approval = ledger.admitExecution(executionEnvelope(root, "approval-pending", false));
  ledger.transitionExecutionAttempt({ attemptId: approval.attempt.id, from: "queued", to: "running" });
  ledger.transitionExecutionAttempt({ attemptId: approval.attempt.id, from: "running", to: "awaiting-approval" });
  await createRunningJob(store, "approval-pending", false);

  ledger.ensureRun({ runId: "settled-before-projection", objective: "settled" });
  const settled = ledger.admitExecution(executionEnvelope(root, "settled-before-projection", false));
  ledger.transitionExecutionAttempt({ attemptId: settled.attempt.id, from: "queued", to: "running" });
  ledger.transitionExecutionAttempt({ attemptId: settled.attempt.id, from: "running", to: "completed", outcomeDigest: "b".repeat(64) });
  await createRunningJob(store, "settled-before-projection", false);

  const counts = await store.recover({ maxAttempts: 3 });
  assert.equal((await store.get("before-admission"))?.status, "queued");
  assert.equal((await store.get("admitted-not-dispatched"))?.status, "queued");
  assert.equal(ledger.getExecutionAttempt(queued.attempt.id)?.state, "queued");
  assert.equal((await store.get("unsafe-dispatched"))?.status, "needs-review");
  assert.equal(ledger.getExecutionAttempt(unsafe.attempt.id)?.state, "needs-review");
  assert.equal((await store.get("safe-dispatched"))?.status, "queued");
  assert.equal(ledger.getExecutionAttempt(safe.attempt.id)?.state, "failed");
  assert.equal((await store.get("approval-pending"))?.status, "needs-review");
  assert.equal(ledger.getExecutionAttempt(approval.attempt.id)?.state, "needs-review");
  assert.equal((await store.get("settled-before-projection"))?.status, "completed");
  assert.deepEqual(counts, { queued: 3, running: 0, awaitingApproval: 0, completed: 1, failed: 0, cancelled: 0, needsReview: 2 });
});

test("runtime job cancellation correlates cancellation control and uncertainty", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-runtime-job-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = createRunLedger({ stateDir: join(root, ".odinn"), workspaceRoot: root });
  t.after(() => ledger.close());
  const store = new SqliteJobStore(ledger);
  const runId = "cancel-correlated";
  ledger.ensureRun({ runId, objective: "cancel" });
  const admitted = ledger.admitExecution(executionEnvelope(root, runId, false));
  ledger.transitionExecutionAttempt({ attemptId: admitted.attempt.id, from: "queued", to: "running" });
  await createRunningJob(store, runId, false);
  const cancelling = await store.cancel(runId, { requestedBy: "test", reason: "stop" });
  assert.equal(cancelling.status, "cancelling");
  assert.equal(ledger.getExecutionAttempt(admitted.attempt.id)?.state, "cancelling");
  const control = ledger.database.db.prepare("SELECT requested_by, reason, acknowledged_at, settled_at FROM cancellation_controls WHERE run_id = ?").get(runId) as JsonObject;
  assert.equal(control.requested_by, "test");
  assert.equal(control.reason, "stop");
  assert.ok(control.acknowledged_at);
  assert.equal(control.settled_at, null);
  await store.recover({ maxAttempts: 3 });
  const settledControl = ledger.database.db.prepare("SELECT settled_at FROM cancellation_controls WHERE run_id = ?").get(runId) as JsonObject;
  assert.ok(settledControl.settled_at);
  assert.equal(ledger.getExecutionAttempt(admitted.attempt.id)?.state, "needs-review");
});

test("terminal execution attempts override a conflicting terminal job projection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-runtime-job-terminal-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = createRunLedger({ stateDir: join(root, ".odinn"), workspaceRoot: root });
  t.after(() => ledger.close());
  const store = new SqliteJobStore(ledger);
  const runId = "terminal-authority";
  ledger.ensureRun({ runId, objective: "terminal authority" });
  const admitted = ledger.admitExecution(executionEnvelope(root, runId, false));
  ledger.transitionExecutionAttempt({ attemptId: admitted.attempt.id, from: "queued", to: "running" });
  await createRunningJob(store, runId, false);
  ledger.transitionExecutionAttempt({ attemptId: admitted.attempt.id, from: "running", to: "needs-review", errorCode: "TERMINAL_AUDIT_FAILED" });
  const projected = await store.update(runId, { status: "failed", error: "worker reported a generic failure", completedAt: new Date().toISOString() });
  assert.equal(projected.status, "needs-review");
  assert.equal(projected.error, "worker reported a generic failure");
  assert.equal(ledger.getExecutionAttempt(admitted.attempt.id)?.state, "needs-review");
});

test("unexpired owner leases prevent recovery and stale workers cannot settle a recovered generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-runtime-job-live-lease-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, ".odinn");
  const ownerLedger = createRunLedger({ stateDir, workspaceRoot: root });
  const recoveryLedger = createRunLedger({ stateDir, workspaceRoot: root });
  t.after(() => { ownerLedger.close(); recoveryLedger.close(); });
  const owner = new SqliteJobStore(ownerLedger);
  const recovery = new SqliteJobStore(recoveryLedger);
  const runId = "live-lease";
  ownerLedger.ensureRun({ runId, objective: "live lease" });
  const admitted = ownerLedger.admitExecution(executionEnvelope(root, runId, false));
  ownerLedger.transitionExecutionAttempt({ attemptId: admitted.attempt.id, from: "queued", to: "running" });
  await owner.create({ id: runId, status: "queued", payload: { task: { id: runId, tool: "session.create", input: {} } }, retrySafe: false });
  const lease = {
    token: "live-owner-token", owner: "supervisor:owner", epoch: "owner-epoch",
    acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  await owner.claim(runId, { status: "running", attempts: 1, dispatchLease: lease });
  await recovery.recover({ maxAttempts: 3 });
  assert.equal((await recovery.get(runId))?.status, "running");
  assert.equal(recoveryLedger.getExecutionAttempt(admitted.attempt.id)?.state, "running");

  recoveryLedger.database.db.prepare("UPDATE runtime_jobs SET lease_expires_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 1_000).toISOString(), runId);
  await recovery.recover({ maxAttempts: 3 });
  assert.equal((await recovery.get(runId))?.status, "needs-review");
  await assert.rejects(
    () => owner.update(runId, { status: "completed", expectedLeaseToken: lease.token, result: { stale: true } }),
    (error: unknown) => (error as { code?: string }).code === "STALE_DISPATCH_LEASE"
  );
});

test("retry-safe shutdown and failed-attempt crash windows remain dispatchable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-runtime-job-retry-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = createRunLedger({ stateDir: join(root, ".odinn"), workspaceRoot: root });
  t.after(() => ledger.close());
  const store = new SqliteJobStore(ledger);
  let firstStarted!: () => void;
  const started = new Promise<void>((resolvePromise) => { firstStarted = resolvePromise; });
  const first = new JobSupervisor({
    store,
    execute: async (_payload, { signal }) => {
      firstStarted();
      await new Promise((resolvePromise, rejectPromise) => {
        signal.addEventListener("abort", () => rejectPromise(signal.reason), { once: true });
      });
    }
  });
  await first.start();
  await first.submit({ task: { tool: "text.echo", input: { text: "retry after shutdown" } } }, { id: "shutdown-retry", retrySafe: true });
  await started;
  await first.shutdown();
  assert.equal((await store.get("shutdown-retry"))?.status, "queued");
  let restartedExecutions = 0;
  const restarted = new JobSupervisor({ store, execute: async () => { restartedExecutions += 1; return { ok: true }; } });
  await restarted.start();
  await waitForJob(store, "shutdown-retry", "completed");
  assert.equal(restartedExecutions, 1);
  await restarted.shutdown();

  const runId = "failed-attempt-window";
  ledger.ensureRun({ runId, objective: "failed attempt crash" });
  const admitted = ledger.admitExecution(executionEnvelope(root, runId, true));
  ledger.transitionExecutionAttempt({ attemptId: admitted.attempt.id, from: "queued", to: "running" });
  await store.create({ id: runId, status: "queued", payload: { task: { id: runId, tool: "text.echo", input: { text: "retry" } } }, retrySafe: true });
  await store.claim(runId, {
    status: "running", attempts: 1,
    dispatchLease: {
      token: "failed-window", owner: "dead-owner", epoch: "dead-epoch",
      acquiredAt: new Date(Date.now() - 120_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString()
    }
  });
  ledger.transitionExecutionAttempt({ attemptId: admitted.attempt.id, from: "running", to: "failed", errorCode: "PROCESS_EXIT" });
  await store.recover({ maxAttempts: 3 });
  assert.equal((await store.get(runId))?.status, "queued");
});

test("correlated retry-safe shutdown resumes after its cancelled attempt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-runtime-job-correlated-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, ".odinn");
  const ledger = createRunLedger({ stateDir, workspaceRoot: root });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  t.after(() => { auditStore.close(); ledger.close(); });
  const store = new SqliteJobStore(ledger);
  let backendStarts = 0;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolvePromise) => { firstStarted = resolvePromise; });
  const registry = new Map<string, unknown>([["text.echo", {
    capability: "workspace.inspect",
    capabilities: ["workspace.inspect"],
    execute: async (_input: unknown, { signal }: { signal: AbortSignal }) => {
      backendStarts += 1;
      if (backendStarts > 1) return { text: "recovered" };
      firstStarted();
      await new Promise((resolvePromise, rejectPromise) => {
        signal.addEventListener("abort", () => rejectPromise(signal.reason), { once: true });
      });
    }
  }]]);
  const execute = (payload: JsonObject, { signal, job }: { signal: AbortSignal; job: { attempts: number } }) => runTask({
    task: payload.task,
    auditStore,
    policy: createDefaultPolicy({ allowedCapabilities: ["workspace.inspect"] }),
    registry,
    runLedger: ledger,
    signal,
    trustedRecovery: job.attempts > 1
  });
  const first = new JobSupervisor({ store, execute });
  await first.start();
  await first.submit({ task: { tool: "text.echo", input: { text: "same" }, actor: "test" } }, { id: "correlated-shutdown", retrySafe: true });
  await started;
  await first.shutdown();
  assert.equal((await store.get("correlated-shutdown"))?.status, "queued");
  assert.deepEqual(ledger.listExecutionAttempts("correlated-shutdown").map((attempt) => attempt.state), ["cancelled"]);

  const restarted = new JobSupervisor({ store, execute });
  await restarted.start();
  await waitForJob(store, "correlated-shutdown", "completed");
  assert.equal(backendStarts, 2);
  assert.deepEqual(ledger.listExecutionAttempts("correlated-shutdown").map((attempt) => attempt.state), ["cancelled", "completed"]);
  await restarted.shutdown();
});

test("explicitly cancelled retry-safe work never inherits shutdown retry intent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-runtime-job-explicit-safe-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = createRunLedger({ stateDir: join(root, ".odinn"), workspaceRoot: root });
  t.after(() => ledger.close());
  const store = new SqliteJobStore(ledger);
  for (const terminal of ["cancelled", "failed"] as const) {
    const runId = `explicit-safe-cancel-${terminal}`;
    ledger.ensureRun({ runId, objective: "explicit cancellation" });
    const admitted = ledger.admitExecution(executionEnvelope(root, runId, true));
    ledger.transitionExecutionAttempt({ attemptId: admitted.attempt.id, from: "queued", to: "running" });
    await createRunningJob(store, runId, true);
    assert.equal((await store.cancel(runId)).status, "cancelling");
    ledger.transitionExecutionAttempt({ attemptId: admitted.attempt.id, from: "cancelling", to: terminal });
    await store.recover({ maxAttempts: 3 });
    assert.equal((await store.get(runId))?.status, terminal);
    assert.equal(ledger.getExecutionAttempt(admitted.attempt.id)?.state, terminal);
    const control = ledger.database.db.prepare("SELECT requested_at, settled_at FROM cancellation_controls WHERE run_id = ?").get(runId) as JsonObject;
    assert.ok(control.requested_at);
    assert.ok(control.settled_at);
  }
});

test("cancellation defers to every already-terminal execution attempt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-runtime-job-cancel-terminal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = createRunLedger({ stateDir: join(root, ".odinn"), workspaceRoot: root });
  t.after(() => ledger.close());
  const store = new SqliteJobStore(ledger);
  for (const terminal of ["completed", "failed", "cancelled", "needs-review"] as const) {
    const runId = `cancel-terminal-${terminal}`;
    ledger.ensureRun({ runId, objective: terminal });
    const admitted = ledger.admitExecution(executionEnvelope(root, runId, false));
    ledger.transitionExecutionAttempt({ attemptId: admitted.attempt.id, from: "queued", to: "running" });
    await createRunningJob(store, runId, false);
    ledger.transitionExecutionAttempt({ attemptId: admitted.attempt.id, from: "running", to: terminal });
    const projected = await store.cancel(runId);
    assert.equal(projected.status, terminal);
    const control = ledger.database.db.prepare("SELECT requested_at, acknowledged_at, settled_at FROM cancellation_controls WHERE run_id = ?").get(runId) as JsonObject;
    assert.equal(control.requested_at, null);
    assert.equal(control.acknowledged_at, null);
    assert.ok(control.settled_at);
  }
});

test("claimed approvals have one durable owner and only its lease can settle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-runtime-job-approval-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, ".odinn");
  const leftLedger = createRunLedger({ stateDir, workspaceRoot: root });
  const rightLedger = createRunLedger({ stateDir, workspaceRoot: root });
  t.after(() => { leftLedger.close(); rightLedger.close(); });
  const leftStore = new SqliteJobStore(leftLedger);
  const rightStore = new SqliteJobStore(rightLedger);
  const leftSupervisor = new JobSupervisor({ store: leftStore, execute: async () => ({ ok: true }) });
  const rightSupervisor = new JobSupervisor({ store: rightStore, execute: async () => ({ ok: true }) });
  const runId = "approval-cancel-race";
  leftLedger.ensureRun({ runId, objective: "approval cancellation race" });
  const admitted = leftLedger.admitExecution(executionEnvelope(root, runId, false));
  leftLedger.transitionExecutionAttempt({ attemptId: admitted.attempt.id, from: "queued", to: "running" });
  await createRunningJob(leftStore, runId, false);
  leftLedger.transitionExecutionAttempt({ attemptId: admitted.attempt.id, from: "running", to: "awaiting-approval" });
  await leftStore.update(runId, { status: "awaiting-approval", dispatchLease: undefined });
  const awaiting = await leftStore.get(runId);
  assert.equal(awaiting?.status, "awaiting-approval");
  assert.equal(awaiting?.dispatchLease, undefined);
  assert.equal(leftLedger.getExecutionAttempt(admitted.attempt.id)?.state, "awaiting-approval");

  const claims = await Promise.allSettled([
    leftSupervisor.beginApproval(runId),
    rightSupervisor.beginApproval(runId)
  ]);
  const winners = claims.filter((claim): claim is PromiseFulfilledResult<Awaited<ReturnType<JobSupervisor["beginApproval"]>>> => claim.status === "fulfilled");
  assert.equal(winners.length, 1);
  assert.equal(claims.filter((claim) => claim.status === "rejected").length, 1);
  const claimed = winners[0].value;
  const expectedLeaseToken = String(claimed.dispatchLease?.token ?? "");
  assert.equal(claimed.status, "running");
  assert.ok(expectedLeaseToken);
  assert.equal(leftLedger.getExecutionAttempt(admitted.attempt.id)?.state, "awaiting-approval");

  await assert.rejects(
    () => rightSupervisor.settleApproval(runId, { result: { forged: true }, expectedLeaseToken: "loser-lease" }),
    /claim lease is no longer owned/u
  );
  assert.equal((await leftStore.get(runId))?.status, "running");
  assert.equal(leftLedger.getExecutionAttempt(admitted.attempt.id)?.state, "awaiting-approval");

  const winner = claims[0].status === "fulfilled" ? leftSupervisor : rightSupervisor;
  const settled = await winner.settleApproval(runId, { result: { applied: true }, expectedLeaseToken });
  assert.equal(settled.status, "completed");
  assert.equal(settled.dispatchLease, undefined);
  assert.equal(leftLedger.getExecutionAttempt(admitted.attempt.id)?.state, "completed");
});

test("expired approval continuation leases require review without replay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-runtime-job-approval-crash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, ".odinn");
  const ownerLedger = createRunLedger({ stateDir, workspaceRoot: root });
  const recoveryLedger = createRunLedger({ stateDir, workspaceRoot: root });
  t.after(() => { ownerLedger.close(); recoveryLedger.close(); });
  const ownerStore = new SqliteJobStore(ownerLedger);
  const recoveryStore = new SqliteJobStore(recoveryLedger);
  const owner = new JobSupervisor({ store: ownerStore, execute: async () => ({ ok: true }) });
  const runId = "approval-crash-after-claim";
  ownerLedger.ensureRun({ runId, objective: "approval crash recovery" });
  const admitted = ownerLedger.admitExecution(executionEnvelope(root, runId, false));
  ownerLedger.transitionExecutionAttempt({ attemptId: admitted.attempt.id, from: "queued", to: "running" });
  await createRunningJob(ownerStore, runId, false);
  ownerLedger.transitionExecutionAttempt({ attemptId: admitted.attempt.id, from: "running", to: "awaiting-approval" });
  await ownerStore.update(runId, { status: "awaiting-approval", dispatchLease: undefined });

  const claimed = await owner.beginApproval(runId);
  const leaseToken = String(claimed.dispatchLease?.token ?? "");
  assert.equal(claimed.status, "running");
  assert.ok(leaseToken);
  assert.equal(ownerLedger.getExecutionAttempt(admitted.attempt.id)?.state, "awaiting-approval");
  const liveRecovery = await recoveryStore.recover({ maxAttempts: 3 });
  assert.equal((await recoveryStore.get(runId))?.status, "running");
  assert.equal(recoveryLedger.getExecutionAttempt(admitted.attempt.id)?.state, "awaiting-approval");
  assert.equal((liveRecovery as { running: number }).running, 1);

  const expiredAt = new Date(Date.now() - 1_000).toISOString();
  recoveryLedger.database.db.prepare("UPDATE runtime_jobs SET lease_expires_at = ? WHERE id = ?").run(expiredAt, runId);
  recoveryLedger.database.db.prepare("UPDATE runtime_job_leases SET expires_at = ? WHERE token = ?").run(expiredAt, leaseToken);
  const expiredRecovery = await recoveryStore.recover({ maxAttempts: 3 });
  const recovered = await recoveryStore.get(runId);
  assert.equal(recovered?.status, "needs-review");
  assert.equal(recovered?.dispatchLease, undefined);
  assert.match(recovered?.error ?? "", /approval continuation lease expired/u);
  assert.equal(recoveryLedger.getExecutionAttempt(admitted.attempt.id)?.state, "needs-review");
  assert.equal((expiredRecovery as { needsReview: number }).needsReview, 1);
  const lease = recoveryLedger.database.db.prepare("SELECT released_at, release_reason FROM runtime_job_leases WHERE token = ?").get(leaseToken) as { released_at: string; release_reason: string };
  assert.ok(lease.released_at);
  assert.equal(lease.release_reason, "restart-recovery");
});
