import { randomUUID } from "node:crypto";
import { redactDurableValue, type JsonObject } from "@odinn/protocol";
import {
  canonicalJson,
  projectWorkflowInput,
  projectWorkflowOutput,
  validateWorkflowDefinition,
  validateWorkflowRunRequest,
  validateWorkflowTransition,
  type WorkflowDefinition,
  type WorkflowRunRecord,
  type WorkflowRunRequest,
  type WorkflowRunStatus,
  type WorkflowStepRecord,
  type WorkflowStepStatus
} from "@odinn/protocol";
import { SqliteStore } from "./index.ts";

type Row = Record<string, any>;

const TERMINAL_STEP_STATUSES = new Set<WorkflowStepStatus>(["completed", "failed", "cancelled", "needs-review"]);
const TERMINAL_RUN_STATUSES = new Set<WorkflowRunStatus>(["completed", "failed", "cancelled", "needs-review"]);
const LEASE_MS = 120_000;

function now(): string { return new Date().toISOString(); }
function parse(value: unknown, fallback: any = {}) { try { return typeof value === "string" ? JSON.parse(value) : fallback; } catch { return fallback; } }
function digestJson(value: unknown): string { return projectWorkflowInput(value).digest; }
function asStatus(value: unknown): WorkflowStepStatus { return String(value) as WorkflowStepStatus; }

function initialize(database: SqliteStore): void {
  database.db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_definitions (
      id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      definition_digest TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(id, revision),
      UNIQUE(definition_digest)
    );
    CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      definition_id TEXT NOT NULL,
      definition_revision INTEGER NOT NULL,
      definition_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','awaiting-approval','completed','failed','cancelled','needs-review')),
      input_json TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      recovery_input_available INTEGER NOT NULL CHECK(recovery_input_available IN (0,1)),
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(principal_id, idempotency_key),
      FOREIGN KEY(definition_id, definition_revision) REFERENCES workflow_definitions(id, revision)
    );
    CREATE TABLE IF NOT EXISTS workflow_steps (
      run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
      step_id TEXT NOT NULL,
      action_ref TEXT NOT NULL,
      depends_on_json TEXT NOT NULL,
      input_json TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      recovery_input_available INTEGER NOT NULL CHECK(recovery_input_available IN (0,1)),
      retry_safety TEXT NOT NULL CHECK(retry_safety IN ('retry-safe','effectful')),
      max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 8),
      status TEXT NOT NULL CHECK(status IN ('queued','awaiting-approval','running','completed','failed','cancelled','needs-review')),
      attempt INTEGER NOT NULL CHECK(attempt >= 0),
      result_json TEXT,
      result_digest TEXT,
      error_code TEXT,
      lease_token TEXT UNIQUE,
      lease_expires_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(run_id, step_id)
    );
    CREATE TABLE IF NOT EXISTS workflow_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_status ON workflow_steps(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_events_run ON workflow_events(run_id, sequence);
  `);
}

function durableProjection(value: unknown): { value: unknown; digest: string; recoveryInputAvailable: boolean } {
  const projected = redactDurableValue(value, { input: true });
  const clean = projectWorkflowInput(projected);
  return {
    value: clean.value,
    digest: digestJson(value),
    recoveryInputAvailable: canonicalJson(projected) === canonicalJson(value)
  };
}

function definitionFromRow(row: Row): WorkflowDefinition {
  return validateWorkflowDefinition(parse(row.definition_json));
}

function stepsFor(database: SqliteStore, runId: string): WorkflowStepRecord[] {
  return (database.db.prepare("SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY rowid").all(runId) as Row[]).map((row) => ({
    runId,
    stepId: String(row.step_id),
    actionRef: String(row.action_ref),
    status: asStatus(row.status),
    attempt: Number(row.attempt),
    retrySafety: String(row.retry_safety) as "retry-safe" | "effectful",
    maxAttempts: Number(row.max_attempts),
    inputDigest: String(row.input_digest),
    ...(row.result_digest ? { resultDigest: String(row.result_digest) } : {}),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    ...(row.lease_token ? { leaseToken: String(row.lease_token) } : {}),
    updatedAt: String(row.updated_at)
  }));
}

export type ClaimedWorkflowStep = WorkflowStepRecord & {
  input: unknown;
  definition: WorkflowDefinition;
  leaseToken: string;
  leaseExpiresAt: string;
};

export class SqliteWorkflowStore {
  readonly database: SqliteStore;

  constructor(database: SqliteStore) {
    if (!database) throw new Error("SqliteWorkflowStore requires a SqliteStore");
    this.database = database;
    initialize(database);
  }

  create(input: WorkflowRunRequest): WorkflowRunRecord {
    const request = validateWorkflowRunRequest(input);
    const definition = validateWorkflowDefinition(request.definition);
    const runProjection = durableProjection(request.input);
    const timestamp = now();
    return this.database.transaction((db) => {
      const existing = db.prepare("SELECT run_id FROM workflow_runs WHERE principal_id = ? AND idempotency_key = ?").get(request.principalId, request.idempotencyKey) as Row | undefined;
      if (existing) return this.get(request.runId === String(existing.run_id) ? request.runId : String(existing.run_id))!;
      const idConflict = db.prepare("SELECT run_id FROM workflow_runs WHERE run_id = ?").get(request.runId) as Row | undefined;
      if (idConflict) throw new Error(`workflow run already exists: ${request.runId}`);
      const priorDefinition = db.prepare("SELECT definition_json FROM workflow_definitions WHERE id = ? AND revision = ?").get(definition.id, definition.revision) as Row | undefined;
      if (priorDefinition && validateWorkflowDefinition(parse(priorDefinition.definition_json)).definitionDigest !== definition.definitionDigest) {
        throw new Error(`workflow definition revision is immutable: ${definition.id}@${definition.revision}`);
      }
      db.prepare("INSERT OR IGNORE INTO workflow_definitions(id, revision, definition_digest, definition_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(definition.id, definition.revision, definition.definitionDigest, canonicalJson(definition), timestamp);
      db.prepare(`INSERT INTO workflow_runs(
        run_id, principal_id, idempotency_key, definition_id, definition_revision, definition_digest,
        status, input_json, input_digest, recovery_input_available, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`)
        .run(request.runId, request.principalId, request.idempotencyKey, definition.id, definition.revision, definition.definitionDigest, canonicalJson(runProjection.value), runProjection.digest, runProjection.recoveryInputAvailable ? 1 : 0, timestamp, timestamp);
      const insertStep = db.prepare(`INSERT INTO workflow_steps(
        run_id, step_id, action_ref, depends_on_json, input_json, input_digest, recovery_input_available,
        retry_safety, max_attempts, status, attempt, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)`);
      for (const step of definition.steps) {
        const projection = durableProjection(step.input);
        insertStep.run(request.runId, step.id, step.actionRef, JSON.stringify(step.dependsOn), canonicalJson(projection.value), projection.digest, projection.recoveryInputAvailable ? 1 : 0, step.retrySafety, step.maxAttempts, timestamp);
      }
      appendEventUnsafe(db, request.runId, "workflow.created", { definitionId: definition.id, definitionRevision: definition.revision, definitionDigest: definition.definitionDigest });
      return this.get(request.runId)!;
    });
  }

  get(runId: string): WorkflowRunRecord | undefined {
    const row = this.database.db.prepare("SELECT * FROM workflow_runs WHERE run_id = ?").get(runId) as Row | undefined;
    if (!row) return undefined;
    return {
      runId: String(row.run_id), principalId: String(row.principal_id), idempotencyKey: String(row.idempotency_key),
      definitionId: String(row.definition_id), definitionDigest: String(row.definition_digest), status: String(row.status) as WorkflowRunStatus,
      inputDigest: String(row.input_digest), recoveryInputAvailable: Number(row.recovery_input_available) === 1,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), steps: stepsFor(this.database, String(row.run_id))
    };
  }

  list(limit = 100): WorkflowRunRecord[] {
    const bounded = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 100;
    return (this.database.db.prepare("SELECT run_id FROM workflow_runs ORDER BY updated_at DESC, run_id LIMIT ?").all(bounded) as Row[])
      .map((row) => this.get(String(row.run_id))!).filter(Boolean);
  }

  queryWorkflows({ offset = 0, limit = 100, query = "", status = "" }: { offset?: number; limit?: number; query?: string; status?: string } = {}) {
    const safeOffset = Number.isSafeInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0;
    const safeLimit = Number.isSafeInteger(Number(limit)) && Number(limit) >= 0 ? Math.min(Number(limit), 10_000) : 100;
    const needle = String(query).trim();
    const normalizedStatus = String(status).trim();
    const conditions = ["1=1"];
    const parameters: any[] = [];
    if (normalizedStatus) { conditions.push("status = ?"); parameters.push(normalizedStatus); }
    if (needle) { conditions.push("instr(lower('workflow durable workflow run ' || run_id || ' ' || definition_id || ' ' || definition_digest || ' ' || status), lower(?)) > 0"); parameters.push(needle); }
    const where = conditions.join(" AND ");
    const totals = this.database.db.prepare(`SELECT count(*) AS total,
      sum(CASE WHEN status IN ('failed','needs-review','awaiting-approval') THEN 1 ELSE 0 END) AS attention
      FROM workflow_runs WHERE ${where}`).get(...parameters) as Row;
    const rows = (this.database.db.prepare(`SELECT run_id FROM workflow_runs WHERE ${where}
      ORDER BY updated_at DESC,run_id LIMIT ? OFFSET ?`).all(...parameters, safeLimit, safeOffset) as Row[])
      .map((row) => this.get(String(row.run_id))!).filter(Boolean);
    return {
      items: rows,
      total: Number(totals.total || 0),
      attention: Number(totals.attention || 0),
      ...(safeOffset + rows.length < Number(totals.total || 0) ? { nextOffset: safeOffset + rows.length, nextCursor: String(safeOffset + rows.length) } : {})
    };
  }

  counts(): { total: number; attention: number } {
    const row = this.database.db.prepare("SELECT count(*) AS total, sum(CASE WHEN status IN ('failed','needs-review','awaiting-approval') THEN 1 ELSE 0 END) AS attention FROM workflow_runs").get() as Row;
    return { total: Number(row.total || 0), attention: Number(row.attention || 0) };
  }

  claimNext(runId?: string): ClaimedWorkflowStep | undefined {
    const timestamp = now();
    return this.database.transaction((db) => {
      const candidates = (db.prepare(`SELECT s.*, r.status AS run_status, r.definition_id, r.definition_revision, d.definition_json
        FROM workflow_steps s JOIN workflow_runs r ON r.run_id = s.run_id
        JOIN workflow_definitions d ON d.id = r.definition_id AND d.revision = r.definition_revision
        WHERE s.status = 'queued' AND r.status IN ('queued','running') ${runId ? "AND s.run_id = ?" : ""}
        ORDER BY s.updated_at, s.run_id, s.step_id`).all(...(runId ? [runId] : [])) as Row[]);
      for (const row of candidates) {
        if (Number(row.recovery_input_available) !== 1) {
          const timestamp = now();
          db.prepare("UPDATE workflow_steps SET status='needs-review', error_code='WORKFLOW_INPUT_REDACTED', updated_at=? WHERE run_id=? AND step_id=? AND status='queued'").run(timestamp, row.run_id, row.step_id);
          db.prepare("UPDATE workflow_runs SET status='needs-review', error_code='WORKFLOW_INPUT_REDACTED', updated_at=? WHERE run_id=? AND status IN ('queued','running')").run(timestamp, row.run_id);
          appendEventUnsafe(db, String(row.run_id), "workflow.input-unavailable", { stepId: String(row.step_id) });
          continue;
        }
        const dependencies = parse(row.depends_on_json, []) as string[];
        const statuses = dependencies.length
          ? (db.prepare(`SELECT step_id, status FROM workflow_steps WHERE run_id = ? AND step_id IN (${dependencies.map(() => "?").join(",")})`).all(row.run_id, ...dependencies) as Row[])
          : [];
        if (statuses.length !== dependencies.length || statuses.some((dependency) => dependency.status !== "completed")) continue;
        const leaseToken = `wflease_${randomUUID()}`;
        const leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
        const updated = db.prepare(`UPDATE workflow_steps SET status='running', attempt=attempt+1, lease_token=?, lease_expires_at=?, updated_at=?
          WHERE run_id=? AND step_id=? AND status='queued'`).run(leaseToken, leaseExpiresAt, timestamp, row.run_id, row.step_id);
        if (Number(updated.changes) !== 1) continue;
        db.prepare("UPDATE workflow_runs SET status='running', updated_at=? WHERE run_id=? AND status='queued'").run(timestamp, row.run_id);
        appendEventUnsafe(db, String(row.run_id), "workflow.step.claimed", { stepId: String(row.step_id), leaseToken, attempt: Number(row.attempt) + 1 });
        const definition = definitionFromRow(row);
        const step = stepsFor(this.database, String(row.run_id)).find((candidate) => candidate.stepId === String(row.step_id))!;
        return { ...step, status: "running", attempt: Number(row.attempt) + 1, input: parse(row.input_json), leaseToken, leaseExpiresAt, definition };
      }
      return undefined;
    });
  }

  completeStep(runId: string, stepId: string, leaseToken: string, result: unknown): WorkflowRunRecord {
    const projection = projectWorkflowOutput(result);
    return this.database.transaction((db) => {
      const row = db.prepare("SELECT status FROM workflow_steps WHERE run_id=? AND step_id=? AND lease_token=?").get(runId, stepId, leaseToken) as Row | undefined;
      if (!row) throw new Error("workflow step lease is missing or stale");
      validateWorkflowTransition(String(row.status) as WorkflowStepStatus, "completed");
      const timestamp = now();
      db.prepare("UPDATE workflow_steps SET status='completed', result_json=?, result_digest=?, lease_token=NULL, lease_expires_at=NULL, updated_at=? WHERE run_id=? AND step_id=? AND lease_token=?")
        .run(canonicalJson(projection.value), projection.digest, timestamp, runId, stepId, leaseToken);
      appendEventUnsafe(db, runId, "workflow.step.completed", { stepId, resultDigest: projection.digest });
      settleRunUnsafe(db, runId, timestamp);
      return this.get(runId)!;
    });
  }

  failStep(runId: string, stepId: string, leaseToken: string, errorCode: string, { uncertain = false } = {}): WorkflowRunRecord {
    return this.database.transaction((db) => {
      const row = db.prepare("SELECT status, attempt, max_attempts, retry_safety FROM workflow_steps WHERE run_id=? AND step_id=? AND lease_token=?").get(runId, stepId, leaseToken) as Row | undefined;
      if (!row) throw new Error("workflow step lease is missing or stale");
      const timestamp = now();
      const retry = !uncertain && String(row.retry_safety) === "retry-safe" && Number(row.attempt) < Number(row.max_attempts);
      const status: WorkflowStepStatus = uncertain ? "needs-review" : retry ? "queued" : "failed";
      validateWorkflowTransition(String(row.status) as WorkflowStepStatus, status);
      db.prepare("UPDATE workflow_steps SET status=?, error_code=?, lease_token=NULL, lease_expires_at=NULL, updated_at=? WHERE run_id=? AND step_id=? AND lease_token=?")
        .run(status, errorCode.slice(0, 256), timestamp, runId, stepId, leaseToken);
      appendEventUnsafe(db, runId, `workflow.step.${status}`, { stepId, errorCode: errorCode.slice(0, 256) });
      if (status !== "queued") db.prepare("UPDATE workflow_runs SET status=?, error_code=?, updated_at=? WHERE run_id=? AND status NOT IN ('completed','cancelled')").run(status === "needs-review" ? "needs-review" : "failed", errorCode.slice(0, 256), timestamp, runId);
      return this.get(runId)!;
    });
  }

  awaitApproval(runId: string, stepId: string, leaseToken: string): WorkflowRunRecord {
    return this.database.transaction((db) => {
      const row = db.prepare("SELECT status FROM workflow_steps WHERE run_id=? AND step_id=? AND lease_token=?").get(runId, stepId, leaseToken) as Row | undefined;
      if (!row) throw new Error("workflow step lease is missing or stale");
      validateWorkflowTransition(String(row.status) as WorkflowStepStatus, "awaiting-approval");
      const timestamp = now();
      db.prepare("UPDATE workflow_steps SET status='awaiting-approval', updated_at=? WHERE run_id=? AND step_id=? AND lease_token=?").run(timestamp, runId, stepId, leaseToken);
      db.prepare("UPDATE workflow_runs SET status='awaiting-approval', updated_at=? WHERE run_id=?").run(timestamp, runId);
      appendEventUnsafe(db, runId, "workflow.step.awaiting-approval", { stepId });
      return this.get(runId)!;
    });
  }

  resume(runId: string): WorkflowRunRecord {
    return this.database.transaction((db) => {
      const row = db.prepare("SELECT status FROM workflow_runs WHERE run_id=?").get(runId) as Row | undefined;
      if (!row) throw new Error(`workflow run not found: ${runId}`);
      const status = String(row.status) as WorkflowRunStatus;
      if (status === "needs-review") throw new Error("workflow needs operator resolution before resume");
      if (status === "awaiting-approval") {
        db.prepare("UPDATE workflow_steps SET status='queued', lease_token=NULL, lease_expires_at=NULL, updated_at=? WHERE run_id=? AND status='awaiting-approval'").run(now(), runId);
        db.prepare("UPDATE workflow_runs SET status='queued', updated_at=? WHERE run_id=?").run(now(), runId);
      }
      return this.get(runId)!;
    });
  }

  cancel(runId: string): WorkflowRunRecord {
    return this.database.transaction((db) => {
      const row = db.prepare("SELECT status FROM workflow_runs WHERE run_id=?").get(runId) as Row | undefined;
      if (!row) throw new Error(`workflow run not found: ${runId}`);
      const status = String(row.status) as WorkflowRunStatus;
      if (!TERMINAL_RUN_STATUSES.has(status)) {
        const timestamp = now();
        db.prepare("UPDATE workflow_steps SET status='cancelled', lease_token=NULL, lease_expires_at=NULL, updated_at=? WHERE run_id=? AND status IN ('queued','awaiting-approval')").run(timestamp, runId);
        db.prepare("UPDATE workflow_runs SET status='cancelled', updated_at=? WHERE run_id=?").run(timestamp, runId);
        appendEventUnsafe(db, runId, "workflow.cancelled", {});
      }
      return this.get(runId)!;
    });
  }

  recover(): WorkflowRunRecord[] {
    const recovered: WorkflowRunRecord[] = [];
    this.database.transaction((db) => {
      const expired = db.prepare("SELECT run_id, step_id, retry_safety, attempt, max_attempts FROM workflow_steps WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?").all(now()) as Row[];
      for (const row of expired) {
        const retry = String(row.retry_safety) === "retry-safe" && Number(row.attempt) < Number(row.max_attempts);
        const status = retry ? "queued" : "needs-review";
        db.prepare("UPDATE workflow_steps SET status=?, error_code=?, lease_token=NULL, lease_expires_at=NULL, updated_at=? WHERE run_id=? AND step_id=? AND status='running'").run(status, retry ? "WORKFLOW_WORKER_EXPIRED" : "WORKFLOW_EFFECT_OUTCOME_UNCERTAIN", now(), row.run_id, row.step_id);
        if (!retry) db.prepare("UPDATE workflow_runs SET status='needs-review', error_code='WORKFLOW_EFFECT_OUTCOME_UNCERTAIN', updated_at=? WHERE run_id=?").run(now(), row.run_id);
        appendEventUnsafe(db, String(row.run_id), "workflow.recovered", { stepId: String(row.step_id), status });
      }
    });
    for (const run of this.list()) if (["queued", "needs-review"].includes(run.status)) recovered.push(run);
    return recovered;
  }

  events(runId: string, limit = 200): JsonObject[] {
    const bounded = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 200;
    return (this.database.db.prepare("SELECT sequence, type, payload_json, created_at FROM workflow_events WHERE run_id=? ORDER BY sequence LIMIT ?").all(runId, bounded) as Row[])
      .map((row) => ({ sequence: Number(row.sequence), type: String(row.type), payload: parse(row.payload_json), at: String(row.created_at) }));
  }
}

function appendEventUnsafe(database: any, runId: string, type: string, payload: JsonObject): void {
  database.prepare("INSERT INTO workflow_events(run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)").run(runId, type, canonicalJson(payload), now());
}

function settleRunUnsafe(database: any, runId: string, timestamp: string): void {
  const rows = database.prepare("SELECT status FROM workflow_steps WHERE run_id=?").all(runId) as Row[];
  if (!rows.length || rows.some((row) => !TERMINAL_STEP_STATUSES.has(String(row.status) as WorkflowStepStatus))) return;
  const status: WorkflowRunStatus = rows.some((row) => row.status === "needs-review") ? "needs-review"
    : rows.some((row) => row.status === "failed") ? "failed"
      : rows.some((row) => row.status === "cancelled") ? "cancelled" : "completed";
  database.prepare("UPDATE workflow_runs SET status=?, updated_at=? WHERE run_id=? AND status NOT IN ('cancelled','needs-review')").run(status, timestamp, runId);
  appendEventUnsafe(database, runId, `workflow.${status}`, {});
}
