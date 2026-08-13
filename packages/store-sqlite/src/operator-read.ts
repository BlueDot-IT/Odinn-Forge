import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withSqliteReadSnapshot } from "./read-snapshot.ts";

type Row = Record<string, unknown>;
type Query = { readonly offset?: number; readonly limit?: number; readonly query?: string; readonly status?: string };
type OperatorJobReadStatus = "queued" | "running" | "awaiting-approval" | "cancelling" | "completed" | "failed" | "cancelled" | "needs-review";
type OperatorRunReadStatus = "unknown" | "running" | "awaiting_approval" | "completed" | "failed" | "blocked" | "cancelled" | "denied" | "needs-review";
type OperatorWorkflowReadStatus = "queued" | "running" | "awaiting-approval" | "stopping" | "cancelling" | "completed" | "failed" | "cancelled" | "needs-review";
type OperatorAttemptReadState = "proposed" | "admitted" | "queued" | "running" | "awaiting-approval" | "cancelling" | "completed" | "failed" | "cancelled" | "needs-review";
type OperatorReadPage<T> = { readonly items: readonly T[]; readonly total: number; readonly attention: number; readonly generation?: string };

export interface SqliteOperatorJobReadRecord {
  readonly id: string;
  readonly status: OperatorJobReadStatus;
  readonly tool: string;
  readonly attempts: number;
  readonly retrySafe: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly executionRunId?: string;
  readonly envelopeDigest?: string;
  readonly auditCorrelationId?: string;
}

export interface SqliteOperatorRunReadRecord {
  readonly id: string;
  readonly status: OperatorRunReadStatus;
  readonly tool?: string;
  readonly message?: string;
  readonly eventCount: number;
  readonly actor: string;
  readonly lastEventAt?: string;
  readonly completedAt?: string;
  readonly startedAt?: string;
}

export interface SqliteOperatorWorkflowReadRecord {
  readonly runId: string;
  readonly definitionDigest: string;
  readonly status: OperatorWorkflowReadStatus;
  readonly updatedAt: string;
}

export interface SqliteOperatorEventWatchReadRecord {
  readonly watchId: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

export interface SqliteOperatorAttemptReadRecord {
  readonly id: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly state: OperatorAttemptReadState;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly settledAt?: string;
  readonly outcomeDigest?: string;
  readonly errorCode?: string;
}

export interface SqliteOperatorAuditReadRecord {
  readonly summary: { readonly events: number; readonly runs: number; readonly attentionRuns: number };
  readonly integrity: { readonly valid: boolean; readonly checked: boolean; readonly unsigned: number; readonly failureCount: number };
}

export interface SqliteOperatorJobCounts {
  readonly total: number;
  readonly queued: number;
  readonly running: number;
  readonly failed: number;
  readonly needsReview: number;
  readonly completed: number;
}

const JOB_STATUSES = new Set<OperatorJobReadStatus>(["queued", "running", "awaiting-approval", "cancelling", "completed", "failed", "cancelled", "needs-review"]);
const RUN_STATUSES = new Set<OperatorRunReadStatus>(["unknown", "running", "awaiting_approval", "completed", "failed", "blocked", "cancelled", "denied", "needs-review"]);
const WORKFLOW_STATUSES = new Set<OperatorWorkflowReadStatus>(["queued", "running", "awaiting-approval", "stopping", "cancelling", "completed", "failed", "cancelled", "needs-review"]);
const ATTEMPT_STATES = new Set<OperatorAttemptReadState>(["proposed", "admitted", "queued", "running", "awaiting-approval", "cancelling", "completed", "failed", "cancelled", "needs-review"]);

function boundedQuery(input: Query, fallbackLimit = 50) {
  const offset = Number.isSafeInteger(Number(input.offset)) && Number(input.offset) >= 0 ? Number(input.offset) : 0;
  const limit = Number.isSafeInteger(Number(input.limit)) && Number(input.limit) >= 0
    ? Math.min(Number(input.limit), 10_000)
    : fallbackLimit;
  return { offset, limit, query: String(input.query ?? "").trim(), status: String(input.status ?? "").trim() };
}

function sqliteReadGeneration(database: DatabaseSync): string {
  const value = Number((database.prepare("PRAGMA data_version").get() as Row).data_version);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("SQLite returned an invalid read generation");
  return `sqlite:data-version:${value}`;
}

function openReadOnly(path: string | undefined): DatabaseSync | undefined {
  if (!path) return undefined;
  const canonical = resolve(path);
  return existsSync(canonical) ? new DatabaseSync(canonical, { readOnly: true }) : undefined;
}

function hasTable(database: DatabaseSync | undefined, table: string): boolean {
  return Boolean(database?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function requiredString(value: unknown, label: string): string {
  const output = optionalString(value);
  if (!output) throw new Error(`${label} must be a non-empty string`);
  return output;
}

function nonnegativeInteger(value: unknown, label: string): number {
  const output = Number(value);
  if (!Number.isSafeInteger(output) || output < 0) throw new Error(`${label} must be a non-negative integer`);
  return output;
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>, label: string): T {
  if (typeof value !== "string" || !values.has(value as T)) throw new Error(`${label} is invalid`);
  return value as T;
}

function runtimeJobTool(payloadJson: unknown, id: string): string {
  if (typeof payloadJson !== "string") throw new Error(`runtime job ${id} payload is not JSON text`);
  let payload: unknown;
  try { payload = JSON.parse(payloadJson); }
  catch { throw new Error(`runtime job ${id} payload contains invalid JSON`); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`runtime job ${id} payload must be an object`);
  const task = (payload as Row).task;
  return task && typeof task === "object" && !Array.isArray(task) && typeof (task as Row).tool === "string" && (task as Row).tool
    ? String((task as Row).tool)
    : "job";
}

function parseRunSummary(value: unknown, runId: string): SqliteOperatorRunReadRecord {
  if (typeof value !== "string") throw new Error(`audit run ${runId} summary is not JSON text`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`audit run ${runId} summary contains invalid JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`audit run ${runId} summary must be an object`);
  const record = parsed as Record<string, unknown>;
  const id = requiredString(record.id, `audit run ${runId} id`);
  if (id !== runId) throw new Error(`audit run ${runId} summary id does not match its durable key`);
  return {
    id,
    status: enumValue(record.status, RUN_STATUSES, `audit run ${runId} status`),
    eventCount: nonnegativeInteger(record.eventCount, `audit run ${runId} eventCount`),
    actor: requiredString(record.actor, `audit run ${runId} actor`),
    ...(optionalString(record.tool) ? { tool: String(record.tool) } : {}),
    ...(optionalString(record.message) ? { message: String(record.message) } : {}),
    ...(optionalString(record.lastEventAt) ? { lastEventAt: String(record.lastEventAt) } : {}),
    ...(optionalString(record.completedAt) ? { completedAt: String(record.completedAt) } : {}),
    ...(optionalString(record.startedAt) ? { startedAt: String(record.startedAt) } : {}),
  };
}

/**
 * Bounded, query-only projections for offline operator snapshots. Connections
 * are opened read-only and this adapter exposes no lifecycle or mutation API.
 */
export class SqliteOperatorReadStore {
  readonly runtime?: DatabaseSync;
  readonly audit?: DatabaseSync;

  constructor({ runtimeDatabasePath, auditDatabasePath }: { readonly runtimeDatabasePath?: string; readonly auditDatabasePath?: string }) {
    this.runtime = openReadOnly(runtimeDatabasePath);
    try { this.audit = openReadOnly(auditDatabasePath); }
    catch (error) { this.runtime?.close(); throw error; }
  }

  hasRuntimeJobs(): boolean { return hasTable(this.runtime, "runtime_jobs"); }

  readJobCounts(): SqliteOperatorJobCounts {
    if (!hasTable(this.runtime, "runtime_jobs")) {
      return { total: 0, queued: 0, running: 0, failed: 0, needsReview: 0, completed: 0 };
    }
    return withSqliteReadSnapshot(this.runtime!, (database) => {
      const row = database.prepare(`SELECT count(*) AS total,
        sum(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
        sum(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
        sum(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
        sum(CASE WHEN status='needs-review' THEN 1 ELSE 0 END) AS needs_review,
        sum(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed
        FROM runtime_jobs`).get() as Row;
      return {
        total: Number(row.total || 0),
        queued: Number(row.queued || 0),
        running: Number(row.running || 0),
        failed: Number(row.failed || 0),
        needsReview: Number(row.needs_review || 0),
        completed: Number(row.completed || 0),
      };
    });
  }

  queryJobs(input: Query = {}): OperatorReadPage<SqliteOperatorJobReadRecord> {
    if (!hasTable(this.runtime, "runtime_jobs")) return { items: [], total: 0, attention: 0 };
    const { offset, limit, query, status } = boundedQuery(input);
    const conditions = ["1=1"];
    const parameters: Array<string | number> = [];
    if (status) { conditions.push("status=?"); parameters.push(status); }
    if (query) {
      conditions.push("instr(lower('job ' || id || ' ' || status || ' ' || payload_json || ' ' || retry_safe || ' ' || attempts),lower(?))>0");
      parameters.push(query);
    }
    const where = conditions.join(" AND ");
    return withSqliteReadSnapshot(this.runtime!, (database) => {
      const totals = database.prepare(`SELECT count(*) AS total,
        sum(CASE WHEN status IN ('failed','needs-review') THEN 1 ELSE 0 END) AS attention
        FROM runtime_jobs WHERE ${where}`).get(...parameters) as Row;
      const rows = database.prepare(`SELECT id,status,payload_json,attempts,retry_safe,created_at,updated_at,completed_at,
        execution_run_id,envelope_digest,audit_correlation_id
        FROM runtime_jobs WHERE ${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`)
        .all(...parameters, limit, offset) as Row[];
      return {
        items: rows.map((row) => ({
          id: String(row.id),
          status: enumValue(row.status, JOB_STATUSES, `runtime job ${String(row.id)} status`),
          tool: runtimeJobTool(row.payload_json, String(row.id)),
          attempts: Number(row.attempts),
          retrySafe: Number(row.retry_safe) === 1,
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
          ...(optionalString(row.completed_at) ? { completedAt: String(row.completed_at) } : {}),
          ...(optionalString(row.execution_run_id) ? { executionRunId: String(row.execution_run_id) } : {}),
          ...(optionalString(row.envelope_digest) ? { envelopeDigest: String(row.envelope_digest) } : {}),
          ...(optionalString(row.audit_correlation_id) ? { auditCorrelationId: String(row.audit_correlation_id) } : {})
        })),
        total: Number(totals.total || 0),
        attention: Number(totals.attention || 0),
        generation: sqliteReadGeneration(database)
      };
    });
  }

  queryWorkflows(input: Query = {}): OperatorReadPage<SqliteOperatorWorkflowReadRecord> {
    if (!hasTable(this.runtime, "workflow_runs")) return { items: [], total: 0, attention: 0 };
    const { offset, limit, query, status } = boundedQuery(input, 100);
    const columns = new Set((this.runtime!.prepare("PRAGMA table_info(workflow_runs)").all() as Row[]).map((row) => String(row.name)));
    const cancellation = columns.has("cancellation_requested_at");
    const failure = columns.has("failure_requested_at");
    const effectiveStatus = cancellation || failure
      ? `CASE
          ${cancellation ? "WHEN cancellation_requested_at IS NOT NULL AND status NOT IN ('completed','failed','cancelled','needs-review') THEN 'cancelling'" : ""}
          ${failure ? `WHEN ${cancellation ? "cancellation_requested_at IS NULL AND " : ""}failure_requested_at IS NOT NULL AND status NOT IN ('completed','failed','cancelled','needs-review') THEN 'stopping'` : ""}
          ELSE status END`
      : "status";
    const conditions = ["1=1"];
    const parameters: Array<string | number> = [];
    if (status) { conditions.push(`${effectiveStatus}=?`); parameters.push(status); }
    if (query) {
      conditions.push(`instr(lower('workflow durable workflow run ' || run_id || ' ' || definition_id || ' ' || definition_digest || ' ' || (${effectiveStatus})),lower(?))>0`);
      parameters.push(query);
    }
    const where = conditions.join(" AND ");
    return withSqliteReadSnapshot(this.runtime!, (database) => {
      const totals = database.prepare(`SELECT count(*) AS total,
        sum(CASE WHEN (${effectiveStatus}) IN ('failed','needs-review','awaiting-approval') THEN 1 ELSE 0 END) AS attention
        FROM workflow_runs WHERE ${where}`).get(...parameters) as Row;
      const rows = database.prepare(`SELECT run_id,definition_digest,updated_at,${effectiveStatus} AS effective_status
        FROM workflow_runs WHERE ${where} ORDER BY updated_at DESC,run_id LIMIT ? OFFSET ?`)
        .all(...parameters, limit, offset) as Row[];
      return {
        items: rows.map((row) => ({
          runId: String(row.run_id),
          definitionDigest: String(row.definition_digest),
          status: enumValue(row.effective_status, WORKFLOW_STATUSES, `workflow ${String(row.run_id)} status`),
          updatedAt: String(row.updated_at)
        })),
        total: Number(totals.total || 0),
        attention: Number(totals.attention || 0),
        generation: sqliteReadGeneration(database)
      };
    });
  }

  queryEventWatches(input: Query = {}): OperatorReadPage<SqliteOperatorEventWatchReadRecord> {
    if (!hasTable(this.runtime, "event_watches")) return { items: [], total: 0, attention: 0 };
    const { offset, limit, query, status } = boundedQuery(input);
    const conditions = ["1=1"];
    const parameters: Array<string | number> = [];
    if (status && status !== "enabled" && status !== "disabled") conditions.push("0=1");
    else if (status) { conditions.push("enabled=?"); parameters.push(status === "enabled" ? 1 : 0); }
    if (query) {
      conditions.push("instr(lower('event-watch event watch durable event ingress declaration ' || watch_id || ' ' || declaration_json),lower(?))>0");
      parameters.push(query);
    }
    const where = conditions.join(" AND ");
    return withSqliteReadSnapshot(this.runtime!, (database) => {
      const totals = database.prepare(`SELECT count(*) AS total FROM event_watches WHERE ${where}`).get(...parameters) as Row;
      const rows = database.prepare(`SELECT watch_id,enabled,updated_at FROM event_watches WHERE ${where}
        ORDER BY watch_id LIMIT ? OFFSET ?`).all(...parameters, limit, offset) as Row[];
      return {
        items: rows.map((row) => ({ watchId: String(row.watch_id), enabled: Number(row.enabled) === 1, updatedAt: String(row.updated_at) })),
        total: Number(totals.total || 0),
        attention: 0,
        generation: sqliteReadGeneration(database)
      };
    });
  }

  queryRuns(input: Query = {}): OperatorReadPage<SqliteOperatorRunReadRecord> {
    if (!hasTable(this.audit, "audit_runs")) return { items: [], total: 0, attention: 0 };
    const { offset, limit, query, status } = boundedQuery(input, 100);
    const conditions = ["1=1"];
    const parameters: Array<string | number> = [];
    if (status) { conditions.push("json_extract(summary_json,'$.status')=?"); parameters.push(status); }
    if (query) { conditions.push("instr(lower('run ' || summary_json),lower(?))>0"); parameters.push(query); }
    const where = conditions.join(" AND ");
    return withSqliteReadSnapshot(this.audit!, (database) => {
      const totals = database.prepare(`SELECT count(*) AS total,
        sum(CASE WHEN json_extract(summary_json,'$.status') IN ('failed','blocked','needs-review') THEN 1 ELSE 0 END) AS attention
        FROM audit_runs WHERE ${where}`).get(...parameters) as Row;
      const rows = database.prepare(`SELECT run_id,summary_json FROM audit_runs WHERE ${where}
        ORDER BY last_event_at DESC,run_id LIMIT ? OFFSET ?`).all(...parameters, limit, offset) as Row[];
      return {
        items: rows.map((row) => parseRunSummary(row.summary_json, String(row.run_id))),
        total: Number(totals.total || 0),
        attention: Number(totals.attention || 0),
        generation: sqliteReadGeneration(database)
      };
    });
  }

  readLatestExecutionAttempts(runIds: readonly string[]): readonly SqliteOperatorAttemptReadRecord[] {
    if (!Array.isArray(runIds) || runIds.length > 50) throw new Error("latest execution-attempt read accepts at most 50 run ids");
    const normalized = runIds.map((runId) => String(runId));
    if (normalized.some((runId) => !runId || runId.length > 512) || new Set(normalized).size !== normalized.length) {
      throw new Error("latest execution-attempt read requires unique bounded run ids");
    }
    if (!normalized.length || !hasTable(this.runtime, "execution_attempts")) return [];
    const placeholders = normalized.map(() => "?").join(",");
    return withSqliteReadSnapshot(this.runtime!, (database) => (database.prepare(`SELECT id,run_id,attempt_number,state,created_at,started_at,settled_at,outcome_digest,error_code
      FROM execution_attempts AS attempt WHERE run_id IN (${placeholders})
        AND attempt_number=(SELECT MAX(latest.attempt_number) FROM execution_attempts AS latest WHERE latest.run_id=attempt.run_id)
      ORDER BY run_id`).all(...normalized) as Row[]).map((row) => ({
        id: String(row.id),
        runId: String(row.run_id),
        attemptNumber: Number(row.attempt_number),
        state: enumValue(row.state, ATTEMPT_STATES, `execution attempt ${String(row.id)} state`),
        createdAt: String(row.created_at),
        ...(optionalString(row.started_at) ? { startedAt: String(row.started_at) } : {}),
        ...(optionalString(row.settled_at) ? { settledAt: String(row.settled_at) } : {}),
        ...(optionalString(row.outcome_digest) ? { outcomeDigest: String(row.outcome_digest) } : {}),
        ...(optionalString(row.error_code) ? { errorCode: String(row.error_code) } : {})
      })));
  }

  readAudit(): SqliteOperatorAuditReadRecord {
    if (!hasTable(this.audit, "audit_events") || !hasTable(this.audit, "audit_runs") || !hasTable(this.audit, "audit_state")) {
      return {
        summary: { events: 0, runs: 0, attentionRuns: 0 },
        integrity: { valid: true, checked: false, unsigned: 0, failureCount: 0 }
      };
    }
    return withSqliteReadSnapshot(this.audit!, (database) => {
      const events = Number((database.prepare("SELECT count(*) AS count FROM audit_events").get() as Row).count || 0);
      const runs = Number((database.prepare("SELECT count(*) AS count FROM audit_runs").get() as Row).count || 0);
      const attentionRuns = Number((database.prepare("SELECT count(*) AS count FROM audit_runs WHERE json_extract(summary_json,'$.status') IN ('failed','blocked','needs-review')").get() as Row).count || 0);
      return {
        summary: { events, runs, attentionRuns },
        integrity: { valid: true, checked: false, unsigned: 0, failureCount: 0 }
      };
    });
  }

  close(): void {
    this.audit?.close();
    this.runtime?.close();
  }
}
