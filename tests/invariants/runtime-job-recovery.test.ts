import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalizeExecutionEnvelopeV1,
  digestExecutionEnvelopeV1,
  type ExecutionEnvelopeV1
} from "../../packages/protocol/src/index.ts";
import { createRunLedger, SqliteJobStore } from "../../packages/kernel/src/index.ts";

const RECORDS = 10_000;

function envelope(root: string, runId: string, retrySafe: boolean): ExecutionEnvelopeV1 {
  const inputDigest = "a".repeat(64);
  return {
    version: 1,
    runId,
    principalId: "principal:recovery-invariant",
    execution: { kind: "tool", id: "text.echo" },
    inputDigest,
    inputReference: `artifact:sha256:${inputDigest}`,
    capabilityDecisionReferences: [`policy:${runId}`],
    approvalRequirements: [],
    timeoutMs: 30_000,
    resourceLimits: {
      maxInputBytes: 16_384,
      maxOutputBytes: 65_536,
      maxPersistedStateBytes: 131_072,
      maxConcurrency: 1
    },
    idempotencyKey: `request:${runId}`,
    retrySafety: retrySafe ? "retry-safe" : "not-retry-safe",
    workspaceRoot: root,
    sandboxProfile: "inspect-only",
    auditCorrelationId: `audit:${runId}`,
    cancellationControlReference: `cancel:${runId}`
  };
}

test("restart recovery classifies every record beyond operator windows", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-recovery-invariant-"));
  const stateDir = join(root, ".odinn");
  try {
    const seedLedger = createRunLedger({ stateDir, workspaceRoot: root });
    const seededAt = new Date().toISOString();
    try {
      seedLedger.database.transaction((db) => {
      const insertRun = db.prepare(`INSERT INTO runs
        (id, status, objective, model_id, provider_id, workspace_root, feature_flags_json, created_at)
        VALUES (?, 'created', 'recovery invariant', '', '', ?, '{}', ?)`);
      const insertEnvelope = db.prepare(`INSERT INTO execution_envelopes
        (run_id, schema_version, principal_id, idempotency_key, envelope_digest, envelope_json, admitted_at)
        VALUES (?, 1, ?, ?, ?, ?, ?)`);
      const insertAttempt = db.prepare(`INSERT INTO execution_attempts
        (id, run_id, attempt_number, state, created_at, started_at, settled_at)
        VALUES (?, ?, 1, ?, ?, ?, ?)`);
      const insertCancel = db.prepare("INSERT INTO cancellation_controls(id, run_id) VALUES (?, ?)");
      const insertJob = db.prepare(`INSERT INTO runtime_jobs
        (id, status, payload_json, payload_recoverable, retry_safe, attempts, timeout_ms,
         created_at, updated_at, started_at, completed_at, execution_run_id)
        VALUES (?, ?, ?, 1, ?, ?, 30000, ?, ?, ?, ?, ?)`);

      for (let index = 0; index < RECORDS; index += 1) {
        const runId = `recovery-invariant-${index}`;
        const bucket = index % 10;
        const status = bucket < 4
          ? "queued"
          : bucket < 7
            ? "running"
            : bucket === 7
              ? "awaiting-approval"
              : bucket === 8
                ? "completed"
                : "failed";
        const retrySafe = bucket === 5 || bucket === 6;
        const hasAttempt = bucket >= 4;
        insertJob.run(
          runId,
          status,
          JSON.stringify({ task: { id: runId, tool: "text.echo", input: { text: "invariant" } } }),
          retrySafe ? 1 : 0,
          status === "queued" ? 0 : 1,
          seededAt,
          seededAt,
          status === "queued" ? null : seededAt,
          status === "completed" || status === "failed" ? seededAt : null,
          hasAttempt ? runId : null
        );
        if (!hasAttempt) continue;
        const admitted = envelope(root, runId, retrySafe);
        insertRun.run(runId, root, seededAt);
        insertEnvelope.run(
          runId,
          admitted.principalId,
          admitted.idempotencyKey,
          digestExecutionEnvelopeV1(admitted),
          canonicalizeExecutionEnvelopeV1(admitted),
          seededAt
        );
        insertCancel.run(admitted.cancellationControlReference, runId);
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
    } finally {
      seedLedger.close();
    }

    const recoveryLedger = createRunLedger({ stateDir, workspaceRoot: root });
    try {
      const store = new SqliteJobStore(recoveryLedger);
      const counts = await store.recover({ maxAttempts: 3 });
      assert.deepEqual(counts, {
        queued: 6_000,
        running: 0,
        awaitingApproval: 1_000,
        completed: 1_000,
        failed: 1_000,
        cancelled: 0,
        needsReview: 1_000
      });
      const grouped = recoveryLedger.database.db.prepare(
        "SELECT status, COUNT(*) AS count FROM runtime_jobs GROUP BY status ORDER BY status"
      ).all() as Array<{ status: string; count: number }>;
      assert.deepEqual(Object.fromEntries(grouped.map((row) => [row.status, Number(row.count)])), {
        "awaiting-approval": 1_000,
        completed: 1_000,
        failed: 1_000,
        "needs-review": 1_000,
        queued: 6_000
      });
      const jobs = recoveryLedger.database.db.prepare(
        `SELECT id, status, error, completed_at, recovered_at, execution_attempt_id,
          envelope_digest, audit_correlation_id, cancellation_control_reference
          FROM runtime_jobs ORDER BY id`
      ).all() as Array<{
        id: string;
        status: string;
        error: string | null;
        completed_at: string | null;
        recovered_at: string | null;
        execution_attempt_id: string | null;
        envelope_digest: string | null;
        audit_correlation_id: string | null;
        cancellation_control_reference: string | null;
      }>;
      assert.equal(jobs.length, RECORDS);
      for (const job of jobs) {
        const index = Number(job.id.slice("recovery-invariant-".length));
        const bucket = index % 10;
        const expected = bucket < 4 || bucket === 5 || bucket === 6
          ? "queued"
          : bucket === 4
            ? "needs-review"
            : bucket === 7
              ? "awaiting-approval"
              : bucket === 8
                ? "completed"
                : "failed";
        assert.equal(job.status, expected, job.id);
        assert.equal(job.recovered_at !== null, bucket >= 4 && bucket <= 7, `${job.id} recovered_at`);
        assert.equal(job.completed_at !== null, bucket === 4 || bucket === 8 || bucket === 9, `${job.id} completed_at`);
        if (bucket >= 4 && bucket <= 7) {
          assert.equal(job.execution_attempt_id, `attempt-${index}`, `${job.id} attempt correlation`);
          assert.equal(
            job.envelope_digest,
            digestExecutionEnvelopeV1(envelope(root, job.id, bucket === 5 || bucket === 6)),
            `${job.id} envelope correlation`
          );
          assert.equal(job.audit_correlation_id, `audit:${job.id}`, `${job.id} audit correlation`);
          assert.equal(job.cancellation_control_reference, `cancel:${job.id}`, `${job.id} cancellation correlation`);
        }
        if (bucket === 4) assert.match(job.error ?? "", /outcome requires operator review/u, job.id);
        if (bucket === 5 || bucket === 6) assert.match(job.error ?? "", /eligible for a new attempt/u, job.id);
      }
      const attempts = recoveryLedger.database.db.prepare(
        "SELECT id, state, settled_at, error_code FROM execution_attempts ORDER BY id"
      ).all() as Array<{ id: string; state: string; settled_at: string | null; error_code: string | null }>;
      assert.equal(attempts.length, 6_000);
      for (const attempt of attempts) {
        const index = Number(attempt.id.slice("attempt-".length));
        const bucket = index % 10;
        const expected = bucket === 4
          ? "needs-review"
          : bucket === 7
            ? "awaiting-approval"
            : bucket === 8
              ? "completed"
              : "failed";
        assert.equal(attempt.state, expected, attempt.id);
        const expectedError = bucket === 4
          ? "EXECUTION_OUTCOME_UNCERTAIN"
          : bucket === 5 || bucket === 6
            ? "EXECUTION_INTERRUPTED_RETRY_SAFE"
            : null;
        assert.equal(attempt.error_code, expectedError, `${attempt.id} error_code`);
        assert.equal(attempt.settled_at !== null, bucket !== 7, `${attempt.id} settled_at`);
      }
      const controls = recoveryLedger.database.db.prepare(
        "SELECT run_id, settled_at FROM cancellation_controls ORDER BY run_id"
      ).all() as Array<{ run_id: string; settled_at: string | null }>;
      assert.equal(controls.length, 6_000);
      for (const control of controls) {
        const index = Number(control.run_id.slice("recovery-invariant-".length));
        assert.equal(control.settled_at !== null, index % 10 === 4, `${control.run_id} cancellation settled_at`);
      }
    } finally {
      recoveryLedger.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
