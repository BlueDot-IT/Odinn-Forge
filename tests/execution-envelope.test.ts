import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalizeExecutionEnvelopeV1,
  digestExecutionEnvelopeV1,
  MAX_EXECUTION_ENVELOPE_BYTES,
  parseExecutionEnvelopeV1,
  validateExecutionEnvelopeV1,
  type ExecutionEnvelopeV1
} from "../packages/protocol/src/index.ts";
import { createAuditStore, createBuiltInRegistry, createRunLedger, runTask } from "../packages/kernel/src/index.ts";
import { inspectExistingSqliteSchema, SqliteStore } from "../packages/store-sqlite/src/index.ts";

function envelope(overrides: Partial<ExecutionEnvelopeV1> = {}): ExecutionEnvelopeV1 {
  return {
    version: 1,
    runId: "run_execution_1",
    principalId: "principal:test",
    execution: { kind: "tool", id: "workspace.read" },
    inputDigest: "a".repeat(64),
    inputReference: `artifact:sha256:${"a".repeat(64)}`,
    capabilityDecisionReferences: ["decision:workspace-inspect"],
    approvalRequirements: [],
    timeoutMs: 30_000,
    resourceLimits: {
      maxInputBytes: 16_384,
      maxOutputBytes: 65_536,
      maxPersistedStateBytes: 131_072,
      maxConcurrency: 1
    },
    idempotencyKey: "request:execution-1",
    retrySafety: "retry-safe",
    workspaceRoot: "/workspace/repository",
    sandboxProfile: "inspect-only",
    auditCorrelationId: "audit:execution-1",
    cancellationControlReference: "cancel:execution-1",
    ...overrides
  };
}

test("ExecutionEnvelopeV1 validates, canonicalizes, digests, and freezes immutable intent", () => {
  const first = validateExecutionEnvelopeV1(envelope());
  const reordered = {
    ...envelope(),
    resourceLimits: { maxConcurrency: 1, maxPersistedStateBytes: 131_072, maxOutputBytes: 65_536, maxInputBytes: 16_384 }
  };
  assert.equal(canonicalizeExecutionEnvelopeV1(first), canonicalizeExecutionEnvelopeV1(reordered));
  assert.equal(digestExecutionEnvelopeV1(first), digestExecutionEnvelopeV1(reordered));
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.execution), true);
  assert.equal(Object.isFrozen(first.capabilityDecisionReferences), true);
  assert.equal(Object.isFrozen(first.resourceLimits), true);
});

test("ExecutionEnvelopeV1 rejects unknown versions, fields, duplicate JSON keys, and raw bodies", () => {
  assert.throws(
    () => validateExecutionEnvelopeV1({ ...envelope(), version: 2 }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "UNSUPPORTED_EXECUTION_ENVELOPE_VERSION"
  );
  assert.throws(() => validateExecutionEnvelopeV1({ ...envelope(), prompt: "do not persist this" }), /unknown field: prompt/u);
  assert.throws(() => validateExecutionEnvelopeV1({ ...envelope(), inputReference: "full prompt text is not a reference" }), /opaque non-secret reference/u);
  assert.throws(
    () => validateExecutionEnvelopeV1({ ...envelope(), inputReference: `artifact:sha256:${"b".repeat(64)}` }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "EXECUTION_INPUT_REFERENCE_MISMATCH"
  );

  const source = JSON.stringify(envelope()).replace('"runId":"run_execution_1"', '"runId":"run_execution_1","runId":"run_execution_2"');
  assert.throws(
    () => parseExecutionEnvelopeV1(source),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "DUPLICATE_EXECUTION_ENVELOPE_FIELD"
  );
  assert.throws(
    () => parseExecutionEnvelopeV1(`${JSON.stringify(envelope())}${" ".repeat(MAX_EXECUTION_ENVELOPE_BYTES)}`),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "EXECUTION_ENVELOPE_TOO_LARGE"
  );
});

test("run ledger persists content-bound, principal-scoped envelopes and attempt records", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-execution-envelope-"));
  const ledger = createRunLedger({ stateDir: join(root, ".odinn"), workspaceRoot: root });
  try {
    assert.equal((ledger.database.db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 30_000);
    ledger.ensureRun({ runId: "run_execution_1", objective: "persist envelope" });
    const admitted = ledger.recordExecutionEnvelope(envelope({ workspaceRoot: root }));
    assert.equal(admitted.replay, false);
    assert.equal(admitted.envelopeDigest, digestExecutionEnvelopeV1(envelope({ workspaceRoot: root })));
    assert.equal(ledger.recordExecutionEnvelope(envelope({ workspaceRoot: root })).replay, true);
    assert.deepEqual(ledger.getExecutionEnvelope("run_execution_1")?.envelope, envelope({ workspaceRoot: root }));

    const firstAttempt = ledger.createExecutionAttempt({ runId: "run_execution_1", attemptId: "attempt_execution_1" });
    assert.equal(firstAttempt.attemptNumber, 1);
    assert.equal(firstAttempt.state, "queued");
    ledger.transitionExecutionAttempt({ attemptId: firstAttempt.id, from: "queued", to: "running" });
    ledger.transitionExecutionAttempt({ attemptId: firstAttempt.id, from: "running", to: "completed", outcomeDigest: "b".repeat(64) });
    assert.deepEqual(ledger.listExecutionAttempts("run_execution_1").map((attempt) => [attempt.id, attempt.state]), [["attempt_execution_1", "completed"]]);
    assert.throws(() => ledger.transitionExecutionAttempt({ attemptId: firstAttempt.id, from: "completed", to: "running" }), /invalid execution attempt transition/u);
    const cancellation = ledger.database.db.prepare("SELECT id, run_id FROM cancellation_controls").get() as { id: string; run_id: string };
    assert.equal(cancellation.id, "cancel:execution-1");
    assert.equal(cancellation.run_id, "run_execution_1");

    ledger.ensureRun({ runId: "run_execution_2", objective: "conflicting retry" });
    assert.throws(
      () => ledger.recordExecutionEnvelope(envelope({ runId: "run_execution_2", workspaceRoot: root })),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "IDEMPOTENCY_CONFLICT"
    );

    ledger.recordExecutionEnvelope(envelope({
      runId: "run_execution_2",
      principalId: "principal:other",
      workspaceRoot: root,
      cancellationControlReference: "cancel:execution-2"
    }));

    ledger.ensureRun({ runId: "run_execution_3", objective: "atomic admission conflict" });
    assert.throws(() => ledger.admitExecution(envelope({
      runId: "run_execution_3",
      principalId: "principal:third",
      idempotencyKey: "request:execution-3",
      workspaceRoot: root
    })), /UNIQUE constraint failed: cancellation_controls.id/u);
    assert.equal(ledger.getExecutionEnvelope("run_execution_3"), undefined);
    assert.deepEqual(ledger.listExecutionAttempts("run_execution_3"), []);

    ledger.database.db.prepare("UPDATE execution_envelopes SET envelope_json = ? WHERE run_id = ?")
      .run(canonicalizeExecutionEnvelopeV1(envelope({ workspaceRoot: "/tampered" })), "run_execution_1");
    assert.throws(
      () => ledger.getExecutionEnvelope("run_execution_1"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "EXECUTION_ENVELOPE_INTEGRITY"
    );
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime transactions survive a live writer beyond the former contention window", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-runtime-contention-"));
  const databasePath = join(root, "odinn.sqlite");
  const store = new SqliteStore(databasePath);
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { DatabaseSync } from "node:sqlite";
     const database = new DatabaseSync(process.argv[1]);
     database.exec("BEGIN IMMEDIATE");
     process.stdout.write("locked\\n");
     setTimeout(() => { database.exec("COMMIT"); database.close(); }, 5_500);`,
    databasePath
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", resolveExit);
  });
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      child.once("error", rejectReady);
      child.stdout.once("data", (chunk) => String(chunk).includes("locked") ? resolveReady() : rejectReady(new Error(`unexpected writer output: ${String(chunk)}`)));
    });
    assert.equal(store.transaction(() => "acquired"), "acquired");
    assert.equal(await exit, 0, stderr);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime schema migrations are additive and the live task path uses admitted envelopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-execution-migration-"));
  const stateDir = join(root, ".odinn");
  const databasePath = join(stateDir, "db", "odinn.sqlite");
  const versionThree = new SqliteStore(databasePath, { targetVersion: 3 });
  versionThree.close();
  const migrated = new SqliteStore(databasePath);
  migrated.close();
  assert.equal(inspectExistingSqliteSchema(databasePath), 10);

  const ledger = createRunLedger({ stateDir, workspaceRoot: root });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir, auditStore });
  try {
    await runTask({
      task: { id: "run_existing_path", tool: "text.echo", input: { text: "still direct" }, actor: "test" },
      auditStore,
      registry,
      runLedger: ledger
    });
    const row = ledger.database.db.prepare("SELECT COUNT(*) AS count FROM execution_envelopes").get() as { count: number };
    assert.equal(Number(row.count), 1);
    const admitted = ledger.getExecutionEnvelope("run_existing_path");
    assert.equal(admitted?.envelope.execution.id, "text.echo");
    assert.equal(admitted?.envelope.retrySafety, "retry-safe");
    assert.equal(admitted?.envelope.sandboxProfile, "inspect-only");
    const [attempt] = ledger.listExecutionAttempts("run_existing_path");
    assert.equal(attempt.state, "completed");
    assert.ok(attempt.startedAt);
    assert.ok(attempt.settledAt);
  } finally {
    registry.close();
    auditStore.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});
