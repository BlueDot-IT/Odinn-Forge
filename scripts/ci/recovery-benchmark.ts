import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeExecutionEnvelopeV1, digestExecutionEnvelopeV1, type ExecutionEnvelopeV1 } from "../../packages/protocol/src/index.ts";
import { createRunLedger, SqliteJobStore } from "../../packages/kernel/src/index.ts";

const RECORDS = 10_000;
const MAX_RECOVERY_MS = 5_000;
const root = await mkdtemp(join(tmpdir(), "odinn-recovery-benchmark-"));
const stateDir = join(root, ".odinn");

function envelope(runId: string, retrySafe: boolean): ExecutionEnvelopeV1 {
  const inputDigest = "a".repeat(64);
  return {
    version: 1,
    runId,
    principalId: "principal:recovery-benchmark",
    execution: { kind: "tool", id: "text.echo" },
    inputDigest,
    inputReference: `artifact:sha256:${inputDigest}`,
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

try {
  const seedLedger = createRunLedger({ stateDir, workspaceRoot: root });
  const seededAt = new Date().toISOString();
  seedLedger.database.transaction((db) => {
    const insertRun = db.prepare(`INSERT INTO runs
      (id, status, objective, model_id, provider_id, workspace_root, feature_flags_json, created_at)
      VALUES (?, 'created', 'recovery benchmark', '', '', ?, '{}', ?)`);
    const insertEnvelope = db.prepare(`INSERT INTO execution_envelopes
      (run_id, schema_version, principal_id, idempotency_key, envelope_digest, envelope_json, admitted_at)
      VALUES (?, 1, ?, ?, ?, ?, ?)`);
    const insertAttempt = db.prepare(`INSERT INTO execution_attempts
      (id, run_id, attempt_number, state, created_at, started_at, settled_at)
      VALUES (?, ?, 1, ?, ?, ?, ?)`);
    const insertCancel = db.prepare("INSERT INTO cancellation_controls(id, run_id) VALUES (?, ?)");
    const insertJob = db.prepare(`INSERT INTO runtime_jobs
      (id, status, payload_json, payload_recoverable, retry_safe, attempts, timeout_ms, created_at, updated_at, started_at, completed_at, execution_run_id)
      VALUES (?, ?, ?, 1, ?, ?, 30000, ?, ?, ?, ?, ?)`);

    for (let index = 0; index < RECORDS; index += 1) {
      const runId = `recovery-benchmark-${index}`;
      const bucket = index % 10;
      const status = bucket < 4 ? "queued" : bucket < 7 ? "running" : bucket === 7 ? "awaiting-approval" : bucket === 8 ? "completed" : "failed";
      const retrySafe = bucket === 5 || bucket === 6;
      const hasAttempt = bucket >= 4;
      insertJob.run(
        runId,
        status,
        JSON.stringify({ task: { id: runId, tool: "text.echo", input: { text: "benchmark" } } }),
        retrySafe ? 1 : 0,
        status === "queued" ? 0 : 1,
        seededAt,
        seededAt,
        status === "queued" ? null : seededAt,
        status === "completed" || status === "failed" ? seededAt : null,
        hasAttempt ? runId : null
      );
      if (!hasAttempt) continue;
      const executionEnvelope = envelope(runId, retrySafe);
      insertRun.run(runId, root, seededAt);
      insertEnvelope.run(
        runId,
        executionEnvelope.principalId,
        executionEnvelope.idempotencyKey,
        digestExecutionEnvelopeV1(executionEnvelope),
        canonicalizeExecutionEnvelopeV1(executionEnvelope),
        seededAt
      );
      insertCancel.run(executionEnvelope.cancellationControlReference, runId);
      const attemptState = status === "awaiting-approval" ? "awaiting-approval" : status;
      insertAttempt.run(
        `attempt-${index}`,
        runId,
        attemptState,
        seededAt,
        seededAt,
        status === "completed" || status === "failed" ? seededAt : null
      );
    }
  });
  seedLedger.close();

  const openedAt = performance.now();
  const recoveryLedger = createRunLedger({ stateDir, workspaceRoot: root });
  const openedMs = performance.now() - openedAt;
  const store = new SqliteJobStore(recoveryLedger);
  const recoveryStarted = performance.now();
  const counts = await store.recover({ maxAttempts: 3 });
  const recoveryMs = performance.now() - recoveryStarted;
  const totalMs = openedMs + recoveryMs;
  const expected = { queued: 6_000, running: 0, awaitingApproval: 1_000, completed: 1_000, failed: 1_000, cancelled: 0, needsReview: 1_000 };
  const countsMatch = JSON.stringify(counts) === JSON.stringify(expected);
  recoveryLedger.close();

  const report = {
    schemaVersion: 1,
    environment: { platform: process.platform, architecture: process.arch, node: process.version },
    records: RECORDS,
    openedMs: Number(openedMs.toFixed(3)),
    recoveryMs: Number(recoveryMs.toFixed(3)),
    totalMs: Number(totalMs.toFixed(3)),
    counts,
    expected,
    gate: { maxMs: MAX_RECOVERY_MS, countsMatch, passed: countsMatch && totalMs <= MAX_RECOVERY_MS }
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.gate.passed) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
