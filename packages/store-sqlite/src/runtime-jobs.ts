import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { digestExecutionEnvelopeV1, isWorkspaceContentTool, projectDurableJobPayload, projectDurableToolOutput, redactDurableValue, validateExecutionEnvelopeV1, type JsonObject } from "@odinn/protocol";
import type { ExecutionAttemptState, RunLedger } from "./index.ts";

const TERMINAL_JOB_STATES = new Set(["completed", "failed", "cancelled", "needs-review"]);
const JOB_STATES = new Set(["queued", "running", "awaiting-approval", "cancelling", ...TERMINAL_JOB_STATES]);
const TERMINAL_ATTEMPT_STATES = new Set<ExecutionAttemptState>(["completed", "failed", "cancelled", "needs-review"]);
const MAX_LEGACY_JOB_STORE_BYTES = 64 * 1024 * 1024;

type SqlRow = { [key: string]: any };

type AgentGraphReassignmentCreationControl = {
  graphRunId: string;
  replacementJobId: string;
  replacementRequestHash: string;
  replacementIdentityDigest: string;
  trustedPrincipalId: string;
};

type JobCreationControl = {
  agentGraphReassignment?: AgentGraphReassignmentCreationControl;
};

function jobCreationConflict(message: string, code: string): never {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  throw error;
}

export interface RuntimeJobRecord {
  schemaVersion: 1;
  id: string;
  status: string;
  payload: JsonObject;
  attempts: number;
  timeoutMs: number;
  retrySafe: boolean;
  requestHash?: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  recoveredAt?: string;
  occurrenceKey?: string;
  scheduledFor?: string;
  nextRunAt?: string | null;
  executionRunId?: string;
  executionAttemptId?: string;
  envelopeDigest?: string;
  auditCorrelationId?: string;
  cancellationControlReference?: string;
  importedFromLegacy?: boolean;
  recoveryInputAvailable?: boolean;
  dispatchLease?: JsonObject;
}

type ProtectedResultRecoveryExpectation = {
  status: string;
  updatedAt?: string;
  requestHash?: string;
  occurrenceKey?: string;
  executionRunId?: string;
  executionAttemptId?: string;
  envelopeDigest?: string;
  auditCorrelationId?: string;
  cancellationControlReference?: string;
  dispatchLease?: JsonObject;
};

type NormalizedRuntimeJob = RuntimeJobRecord & {
  resultJson: string | null;
  payloadJson: string;
  leaseToken: string | null;
  leaseOwner: string | null;
  leaseEpoch: string | null;
  leaseAcquiredAt: string | null;
  leaseExpiresAt: string | null;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function optionalNullableString(value: unknown): string | null | undefined {
  return value === null ? null : optionalString(value);
}

function parseObject(value: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must contain a JSON object`);
  return parsed as JsonObject;
}

function normalizeJob(input: Record<string, unknown> & { id: string }, current?: RuntimeJobRecord): NormalizedRuntimeJob {
  const id = String(input.id);
  if (!id || id.length > 512) throw new Error("runtime job id must contain 1 through 512 characters");
  const status = String(input.status ?? current?.status ?? "queued");
  if (!JOB_STATES.has(status)) throw new Error(`runtime job ${id} has invalid status: ${status}`);
  const payloadSource = input.payload ?? current?.payload ?? {};
  if (!payloadSource || typeof payloadSource !== "object" || Array.isArray(payloadSource)) throw new Error(`runtime job ${id} payload must be an object`);
  const payload = projectDurableJobPayload(payloadSource as JsonObject);
  const recoveryInputAvailable = current?.recoveryInputAvailable
    ?? JSON.stringify(payloadSource) === JSON.stringify(payload);
  const attempts = Number(input.attempts ?? current?.attempts ?? 0);
  const timeoutMs = Number(input.timeoutMs ?? current?.timeoutMs ?? 120_000);
  if (!Number.isSafeInteger(attempts) || attempts < 0) throw new Error(`runtime job ${id} attempts must be a non-negative integer`);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new Error(`runtime job ${id} timeoutMs is invalid`);
  const now = new Date().toISOString();
  const result = "result" in input
    ? redactDurableValue(projectRuntimeJobResult(runtimeJobTool(payloadSource as Record<string, unknown>), input.result))
    : current?.result;
  const lease = input.dispatchLease && typeof input.dispatchLease === "object" && !Array.isArray(input.dispatchLease)
    ? input.dispatchLease as JsonObject
    : "dispatchLease" in input ? undefined : current?.dispatchLease;
  const executionRunId = optionalString(input.executionRunId ?? current?.executionRunId)
    ?? optionalString((payload.task as JsonObject | undefined)?.id);
  return {
    schemaVersion: 1,
    id,
    status,
    payload,
    payloadJson: JSON.stringify(payload),
    recoveryInputAvailable,
    requestHash: optionalString(input.requestHash ?? current?.requestHash),
    retrySafe: input.retrySafe === true || (!("retrySafe" in input) && current?.retrySafe === true),
    attempts,
    timeoutMs,
    result,
    resultJson: result === undefined ? null : JSON.stringify(result),
    error: optionalString(input.error) ?? (!("error" in input) ? current?.error : undefined),
    createdAt: optionalString(input.createdAt) ?? current?.createdAt ?? now,
    updatedAt: optionalString(input.updatedAt) ?? now,
    startedAt: optionalString(input.startedAt) ?? (!("startedAt" in input) ? current?.startedAt : undefined),
    completedAt: optionalString(input.completedAt) ?? (!("completedAt" in input) ? current?.completedAt : undefined),
    recoveredAt: optionalString(input.recoveredAt) ?? (!("recoveredAt" in input) ? current?.recoveredAt : undefined),
    occurrenceKey: optionalString(input.occurrenceKey ?? current?.occurrenceKey),
    scheduledFor: optionalString(input.scheduledFor ?? current?.scheduledFor),
    nextRunAt: optionalNullableString("nextRunAt" in input ? input.nextRunAt : current?.nextRunAt),
    executionRunId,
    executionAttemptId: optionalString(input.executionAttemptId ?? current?.executionAttemptId),
    envelopeDigest: optionalString(input.envelopeDigest ?? current?.envelopeDigest),
    auditCorrelationId: optionalString(input.auditCorrelationId ?? current?.auditCorrelationId),
    cancellationControlReference: optionalString(input.cancellationControlReference ?? current?.cancellationControlReference),
    importedFromLegacy: input.importedFromLegacy === true || (!("importedFromLegacy" in input) && current?.importedFromLegacy === true),
    dispatchLease: lease,
    leaseToken: optionalString(lease?.token) ?? null,
    leaseOwner: optionalString(lease?.owner) ?? null,
    leaseEpoch: optionalString(lease?.epoch) ?? null,
    leaseAcquiredAt: optionalString(lease?.acquiredAt) ?? null,
    leaseExpiresAt: optionalString(lease?.expiresAt) ?? null
  };
}

function runtimeJobTool(payload: Record<string, unknown>): string {
  const task = payload.task;
  return task && typeof task === "object" && !Array.isArray(task) && typeof (task as JsonObject).tool === "string"
    ? String((task as JsonObject).tool)
    : "";
}

function projectRuntimeJobResult(toolName: string, result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return projectDurableToolOutput(toolName, result);
  const record = result as JsonObject;
  if (!("output" in record)) return projectDurableToolOutput(toolName, result);
  return {
    ...record,
    ...(isWorkspaceContentTool(toolName) ? { contentUnavailableOnReplay: true } : {}),
    output: projectDurableToolOutput(toolName, record.output)
  };
}

function hydrate(row: SqlRow): RuntimeJobRecord {
  const payload = parseObject(String(row.payload_json), `runtime job ${String(row.id)} payload`);
  const result = row.result_json === null ? undefined : JSON.parse(String(row.result_json));
  const dispatchLease = row.lease_token === null ? undefined : {
    ...(row.occurrence_key === null ? {} : { occurrenceKey: String(row.occurrence_key) }),
    token: String(row.lease_token),
    owner: String(row.lease_owner),
    epoch: String(row.lease_epoch),
    acquiredAt: String(row.lease_acquired_at),
    expiresAt: String(row.lease_expires_at)
  };
  return {
    schemaVersion: 1,
    id: String(row.id),
    status: String(row.status),
    payload,
    recoveryInputAvailable: Number(row.payload_recoverable) === 1,
    attempts: Number(row.attempts),
    timeoutMs: Number(row.timeout_ms),
    retrySafe: Number(row.retry_safe) === 1,
    ...(row.request_hash === null ? {} : { requestHash: String(row.request_hash) }),
    ...(result === undefined ? {} : { result }),
    ...(row.error === null ? {} : { error: String(row.error) }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.started_at === null ? {} : { startedAt: String(row.started_at) }),
    ...(row.completed_at === null ? {} : { completedAt: String(row.completed_at) }),
    ...(row.recovered_at === null ? {} : { recoveredAt: String(row.recovered_at) }),
    ...(row.occurrence_key === null ? {} : { occurrenceKey: String(row.occurrence_key) }),
    ...(row.scheduled_for === null ? {} : { scheduledFor: String(row.scheduled_for) }),
    ...(row.next_run_at === null ? {} : { nextRunAt: String(row.next_run_at) }),
    ...(row.execution_run_id === null ? {} : { executionRunId: String(row.execution_run_id) }),
    ...(row.execution_attempt_id === null ? {} : { executionAttemptId: String(row.execution_attempt_id) }),
    ...(row.envelope_digest === null ? {} : { envelopeDigest: String(row.envelope_digest) }),
    ...(row.audit_correlation_id === null ? {} : { auditCorrelationId: String(row.audit_correlation_id) }),
    ...(row.cancellation_control_reference === null ? {} : { cancellationControlReference: String(row.cancellation_control_reference) }),
    ...(Number(row.imported_from_legacy) === 1 ? { importedFromLegacy: true } : {}),
    ...(dispatchLease ? { dispatchLease } : {})
  };
}

function writeJob(db: any, job: NormalizedRuntimeJob) {
  db.prepare(`INSERT INTO runtime_jobs (
    id, status, payload_json, payload_recoverable, request_hash, retry_safe, attempts, timeout_ms, result_json, error,
    created_at, updated_at, started_at, completed_at, recovered_at, occurrence_key, scheduled_for,
    next_run_at, execution_run_id, execution_attempt_id, envelope_digest, audit_correlation_id,
    cancellation_control_reference, imported_from_legacy, lease_token, lease_owner, lease_epoch, lease_acquired_at, lease_expires_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    status=excluded.status, payload_json=excluded.payload_json, payload_recoverable=excluded.payload_recoverable, request_hash=excluded.request_hash,
    retry_safe=excluded.retry_safe, attempts=excluded.attempts, timeout_ms=excluded.timeout_ms,
    result_json=excluded.result_json, error=excluded.error, updated_at=excluded.updated_at,
    started_at=excluded.started_at, completed_at=excluded.completed_at, recovered_at=excluded.recovered_at,
    occurrence_key=excluded.occurrence_key, scheduled_for=excluded.scheduled_for, next_run_at=excluded.next_run_at,
    execution_run_id=excluded.execution_run_id, execution_attempt_id=excluded.execution_attempt_id,
    envelope_digest=excluded.envelope_digest, audit_correlation_id=excluded.audit_correlation_id,
    cancellation_control_reference=excluded.cancellation_control_reference, imported_from_legacy=excluded.imported_from_legacy, lease_token=excluded.lease_token,
    lease_owner=excluded.lease_owner, lease_epoch=excluded.lease_epoch,
    lease_acquired_at=excluded.lease_acquired_at, lease_expires_at=excluded.lease_expires_at`)
    .run(
      job.id, job.status, job.payloadJson, job.recoveryInputAvailable === true ? 1 : 0, job.requestHash ?? null, job.retrySafe ? 1 : 0, job.attempts,
      job.timeoutMs, job.resultJson, job.error ?? null, job.createdAt, job.updatedAt, job.startedAt ?? null,
      job.completedAt ?? null, job.recoveredAt ?? null, job.occurrenceKey ?? null, job.scheduledFor ?? null,
      job.nextRunAt ?? null, job.executionRunId ?? null, job.executionAttemptId ?? null,
      job.envelopeDigest ?? null, job.auditCorrelationId ?? null, job.cancellationControlReference ?? null,
      job.importedFromLegacy === true ? 1 : 0, job.leaseToken, job.leaseOwner, job.leaseEpoch, job.leaseAcquiredAt, job.leaseExpiresAt
    );
}

function correlation(ledger: RunLedger, runId: string | undefined) {
  if (!runId) return undefined;
  const row = ledger.database.db.prepare(`SELECT e.envelope_digest, e.envelope_json, a.id AS attempt_id, a.state AS attempt_state,
      a.error_code, a.attempt_number
    FROM execution_envelopes e
    LEFT JOIN execution_attempts a ON a.id = (
      SELECT id FROM execution_attempts WHERE run_id = e.run_id ORDER BY attempt_number DESC LIMIT 1
    )
    WHERE e.run_id = ?`).get(runId) as SqlRow | undefined;
  if (!row) return undefined;
  const envelope = validateExecutionEnvelopeV1(parseObject(String(row.envelope_json), `execution envelope ${runId}`));
  if (digestExecutionEnvelopeV1(envelope) !== String(row.envelope_digest)) {
    throw new Error(`execution envelope integrity check failed during runtime job correlation: ${runId}`);
  }
  return {
    envelopeDigest: String(row.envelope_digest),
    attemptId: row.attempt_id === null ? undefined : String(row.attempt_id),
    attemptState: row.attempt_state as ExecutionAttemptState | undefined,
    attemptErrorCode: row.error_code === null ? undefined : String(row.error_code),
    attemptNumber: row.attempt_number === null ? undefined : Number(row.attempt_number),
    retrySafety: String(envelope.retrySafety),
    auditCorrelationId: String(envelope.auditCorrelationId),
    cancellationControlReference: String(envelope.cancellationControlReference)
  };
}

function transitionAttempt(db: any, attemptId: string | undefined, from: ExecutionAttemptState | undefined, to: ExecutionAttemptState, errorCode?: string, executionOwnershipEnabled = false) {
  if (!attemptId || !from || TERMINAL_ATTEMPT_STATES.has(from) || from === to) return;
  const now = new Date().toISOString();
  const settledAt = TERMINAL_ATTEMPT_STATES.has(to) ? now : null;
  const ownerRelease = executionOwnershipEnabled && TERMINAL_ATTEMPT_STATES.has(to)
    ? ", owner_released_at = COALESCE(owner_released_at, ?)"
    : "";
  const result = db.prepare(`UPDATE execution_attempts
    SET state = ?, started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
      settled_at = ?, error_code = ?${ownerRelease}
    WHERE id = ? AND state = ?`).run(
      to, to, now, settledAt, errorCode ?? null,
      ...(ownerRelease ? [now] : []),
      attemptId, from
    );
  if (Number(result.changes) !== 1) throw new Error(`execution attempt ${attemptId} changed concurrently during job recovery`);
}

export class SqliteJobStore {
  readonly ledger: RunLedger;
  readonly legacyPath?: string;
  private readonly executionOwnershipEnabled: boolean;

  constructor(ledger: RunLedger, { legacyPath }: { legacyPath?: string } = {}) {
    if (!ledger?.database?.db) throw new Error("SqliteJobStore requires a run ledger");
    this.ledger = ledger;
    this.legacyPath = legacyPath ? resolve(legacyPath) : undefined;
    this.executionOwnershipEnabled = (ledger.database.db.prepare("PRAGMA table_info(execution_attempts)").all() as SqlRow[])
      .some((column) => String(column.name) === "owner_token");
  }

  async list({ limit = 500, offset = 0 }: { limit?: number; offset?: number } = {}): Promise<RuntimeJobRecord[]> {
    const safeLimit = Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 500) : 500;
    const safeOffset = Number.isSafeInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0;
    return (this.ledger.database.db.prepare("SELECT * FROM runtime_jobs ORDER BY updated_at DESC, id LIMIT ? OFFSET ?").all(safeLimit, safeOffset) as SqlRow[]).map(hydrate);
  }

  async queryJobs({ limit = 50, offset = 0, query = "", status = "" }: { limit?: number; offset?: number; query?: string; status?: string } = {}) {
    const safeLimit = Number.isSafeInteger(Number(limit)) && Number(limit) >= 0 ? Math.min(Number(limit), 100_000) : 50;
    const safeOffset = Number.isSafeInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0;
    const needle = String(query).trim();
    const normalizedStatus = String(status).trim();
    const conditions = ["1=1"];
    const parameters: any[] = [];
    if (normalizedStatus) { conditions.push("status = ?"); parameters.push(normalizedStatus); }
    if (needle) { conditions.push("instr(lower('job ' || id || ' ' || status || ' ' || payload_json || ' ' || retry_safe || ' ' || attempts), lower(?)) > 0"); parameters.push(needle); }
    const where = conditions.join(" AND ");
    const totalRow = this.ledger.database.db.prepare(`SELECT count(*) AS total,
      sum(CASE WHEN status IN ('failed','needs-review') THEN 1 ELSE 0 END) AS attention
      FROM runtime_jobs WHERE ${where}`).get(...parameters) as SqlRow;
    const rows = (this.ledger.database.db.prepare(`SELECT * FROM runtime_jobs WHERE ${where}
      ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`).all(...parameters, safeLimit, safeOffset) as SqlRow[]).map(hydrate);
    return {
      items: rows,
      total: Number(totalRow.total || 0),
      attention: Number(totalRow.attention || 0),
      ...(safeOffset + rows.length < Number(totalRow.total || 0) ? { nextOffset: safeOffset + rows.length, nextCursor: String(safeOffset + rows.length) } : {})
    };
  }

  async claimNextQueued(patch: JsonObject): Promise<RuntimeJobRecord | undefined> {
    return this.ledger.database.transaction((db) => {
      const row = db.prepare(`SELECT * FROM runtime_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC, id ASC
        LIMIT 1`).get() as SqlRow | undefined;
      if (!row) return undefined;
      const current = hydrate(row);
      const now = new Date().toISOString();
      const requestedLease = patch.dispatchLease && typeof patch.dispatchLease === "object" && !Array.isArray(patch.dispatchLease)
        ? patch.dispatchLease as JsonObject
        : undefined;
      const dispatchLease = requestedLease ? {
        ...requestedLease,
        ...(current.occurrenceKey ? { occurrenceKey: current.occurrenceKey } : {}),
        acquiredAt: optionalString(requestedLease.acquiredAt) ?? now,
        expiresAt: optionalString(requestedLease.expiresAt)
          ?? new Date(Date.now() + Math.max(current.timeoutMs + 30_000, 120_000)).toISOString()
      } : undefined;
      const normalized = normalizeJob({
        ...current,
        ...patch,
        id: current.id,
        status: "running",
        attempts: current.attempts + 1,
        createdAt: current.createdAt,
        updatedAt: now,
        ...(dispatchLease ? { dispatchLease } : {})
      }, current);
      writeJob(db, normalized);
      if (normalized.leaseToken && normalized.leaseOwner && normalized.leaseEpoch && normalized.leaseAcquiredAt && normalized.leaseExpiresAt) {
        db.prepare(`INSERT INTO runtime_job_leases(token, job_id, occurrence_key, owner, epoch, acquired_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          normalized.leaseToken, current.id, normalized.occurrenceKey ?? null, normalized.leaseOwner, normalized.leaseEpoch,
          normalized.leaseAcquiredAt, normalized.leaseExpiresAt
        );
      }
      return hydrate(db.prepare("SELECT * FROM runtime_jobs WHERE id = ?").get(current.id) as SqlRow);
    });
  }

  async count(): Promise<{ total: number; attention: number }> {
    const row = this.ledger.database.db.prepare("SELECT count(*) AS total, sum(CASE WHEN status IN ('failed','needs-review') THEN 1 ELSE 0 END) AS attention FROM runtime_jobs").get() as SqlRow;
    return { total: Number(row.total || 0), attention: Number(row.attention || 0) };
  }

  async get(id: string): Promise<RuntimeJobRecord | undefined> {
    const row = this.ledger.database.db.prepare("SELECT * FROM runtime_jobs WHERE id = ?").get(id) as SqlRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  async create(job: JsonObject & { id: string }, control?: JobCreationControl): Promise<RuntimeJobRecord> {
    return this.ledger.database.transaction((db) => {
      if (db.prepare("SELECT 1 FROM runtime_jobs WHERE id = ?").get(job.id)) throw new Error(`job already exists: ${job.id}`);
      const normalized = normalizeJob(job);
      const supportsReassignments = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_graph_reassignments'").get());
      const reservation = supportsReassignments
        ? db.prepare("SELECT * FROM agent_graph_reassignments WHERE replacement_job_id = ?").get(normalized.id) as SqlRow | undefined
        : undefined;
      const reassignment = control?.agentGraphReassignment;
      if (reservation) {
        if (!reassignment
          || reassignment.graphRunId !== String(reservation.graph_run_id)
          || reassignment.replacementJobId !== normalized.id
          || reassignment.replacementRequestHash !== String(reservation.replacement_request_hash)
          || reassignment.replacementRequestHash !== normalized.requestHash
          || reassignment.replacementIdentityDigest !== String(reservation.replacement_identity_digest)
          || reassignment.trustedPrincipalId !== String(reservation.trusted_principal_id)
          || String(reservation.status) !== "reserved") {
          jobCreationConflict(
            "job id is reserved for an exact agent graph reassignment",
            "AGENT_GRAPH_REASSIGNMENT_TARGET_RESERVED"
          );
        }
      } else if (reassignment) {
        jobCreationConflict(
          "agent graph reassignment reservation is unavailable during job creation",
          "AGENT_GRAPH_REASSIGNMENT_RESERVATION_LOST"
        );
      }
      writeJob(db, normalized);
      if (reservation && reassignment) {
        const now = new Date().toISOString();
        const submitted = db.prepare(`UPDATE agent_graph_reassignments
          SET status='submitted', submitted_at=COALESCE(submitted_at, ?)
          WHERE graph_run_id=? AND replacement_job_id=? AND replacement_request_hash=?
            AND replacement_identity_digest=? AND trusted_principal_id=? AND status='reserved'`)
          .run(
            now,
            reassignment.graphRunId,
            reassignment.replacementJobId,
            reassignment.replacementRequestHash,
            reassignment.replacementIdentityDigest,
            reassignment.trustedPrincipalId
          );
        if (Number(submitted.changes) !== 1) {
          jobCreationConflict(
            "agent graph reassignment reservation changed during atomic job creation",
            "AGENT_GRAPH_REASSIGNMENT_RESERVATION_LOST"
          );
        }
      }
      return hydrate(db.prepare("SELECT * FROM runtime_jobs WHERE id = ?").get(normalized.id) as SqlRow);
    });
  }

  async claim(id: string, patch: JsonObject): Promise<RuntimeJobRecord | undefined> {
    return this.ledger.database.transaction((db) => {
      const row = db.prepare("SELECT * FROM runtime_jobs WHERE id = ?").get(id) as SqlRow | undefined;
      if (!row || row.status !== "queued") return undefined;
      const normalized = normalizeJob({ ...hydrate(row), ...patch, id }, hydrate(row));
      writeJob(db, normalized);
      if (normalized.leaseToken && normalized.leaseOwner && normalized.leaseEpoch && normalized.leaseAcquiredAt && normalized.leaseExpiresAt) {
        db.prepare(`INSERT INTO runtime_job_leases(token, job_id, occurrence_key, owner, epoch, acquired_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          normalized.leaseToken, id, normalized.occurrenceKey ?? null, normalized.leaseOwner, normalized.leaseEpoch,
          normalized.leaseAcquiredAt, normalized.leaseExpiresAt
        );
      }
      return hydrate(db.prepare("SELECT * FROM runtime_jobs WHERE id = ?").get(id) as SqlRow);
    });
  }

  async claimApproval(id: string, patch: JsonObject): Promise<RuntimeJobRecord | undefined> {
    return this.ledger.database.transaction((db) => {
      const row = db.prepare("SELECT * FROM runtime_jobs WHERE id = ?").get(id) as SqlRow | undefined;
      if (!row || row.status !== "awaiting-approval") return undefined;
      const current = hydrate(row);
      const linked = correlation(this.ledger, current.executionRunId);
      if (linked?.attemptState !== "awaiting-approval") return undefined;
      const normalized = normalizeJob({
        ...current,
        ...patch,
        id,
        executionAttemptId: linked.attemptId,
        envelopeDigest: linked.envelopeDigest,
        auditCorrelationId: linked.auditCorrelationId,
        cancellationControlReference: linked.cancellationControlReference
      }, current);
      writeJob(db, normalized);
      if (normalized.leaseToken && normalized.leaseOwner && normalized.leaseEpoch && normalized.leaseAcquiredAt && normalized.leaseExpiresAt) {
        db.prepare(`INSERT INTO runtime_job_leases(token, job_id, occurrence_key, owner, epoch, acquired_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          normalized.leaseToken, id, normalized.occurrenceKey ?? null, normalized.leaseOwner, normalized.leaseEpoch,
          normalized.leaseAcquiredAt, normalized.leaseExpiresAt
        );
      }
      return hydrate(db.prepare("SELECT * FROM runtime_jobs WHERE id = ?").get(id) as SqlRow);
    });
  }

  async settleApproval(id: string, {
    expectedLeaseToken,
    result,
    error,
    dispatched,
    interrupted
  }: {
    expectedLeaseToken: string;
    result?: unknown;
    error?: string;
    dispatched: boolean;
    interrupted?: string;
  }): Promise<RuntimeJobRecord> {
    return this.ledger.database.transaction((db) => {
      const row = db.prepare("SELECT * FROM runtime_jobs WHERE id = ?").get(id) as SqlRow | undefined;
      if (!row) throw new Error(`job not found: ${id}`);
      const current = hydrate(row);
      if (!expectedLeaseToken || current.dispatchLease?.token !== expectedLeaseToken) {
        const staleLease = new Error(`runtime job ${id} approval claim lease is no longer owned by this continuation`) as Error & { code?: string };
        staleLease.code = "STALE_APPROVAL_LEASE";
        throw staleLease;
      }
      if (!["running", "cancelling"].includes(current.status)) {
        const staleState = new Error(`runtime job ${id} has no claimed approval execution`) as Error & { code?: string };
        staleState.code = "STALE_APPROVAL_STATE";
        throw staleState;
      }
      const linked = correlation(this.ledger, current.executionRunId);
      if (!linked?.attemptId || !["awaiting-approval", "running", "cancelling"].includes(String(linked.attemptState))) {
        const staleAttempt = new Error(`runtime job ${id} approval execution attempt is no longer active for settlement`) as Error & { code?: string };
        staleAttempt.code = "STALE_APPROVAL_ATTEMPT";
        throw staleAttempt;
      }
      const interruption = optionalString(interrupted)
        ?? (current.status === "cancelling" ? "job cancellation was requested" : undefined);
      const targetStatus = interruption
        ? dispatched ? "needs-review" : "cancelled"
        : error !== undefined ? "needs-review" : "completed";
      const settlementError = targetStatus === "completed"
        ? undefined
        : interruption
          ? dispatched
            ? `approval continuation was interrupted after dispatch; external outcome requires review: ${interruption}`
            : `approval continuation was cancelled before dispatch: ${interruption}`
          : optionalString(error) ?? "approval continuation failed without a bounded error";
      const now = new Date().toISOString();
      db.prepare(`UPDATE runtime_job_leases
        SET released_at = COALESCE(released_at, ?), release_reason = COALESCE(release_reason, ?)
        WHERE token = ? AND job_id = ? AND released_at IS NULL`)
        .run(now, targetStatus, expectedLeaseToken, id);
      transitionAttempt(
        db,
        linked.attemptId,
        linked.attemptState,
        targetStatus as ExecutionAttemptState,
        targetStatus === "needs-review"
          ? interruption ? "APPROVAL_CONTINUATION_OUTCOME_UNCERTAIN" : "EXECUTION_OUTCOME_UNCERTAIN"
          : targetStatus === "cancelled" ? "EXECUTION_CANCELLED" : undefined,
        this.executionOwnershipEnabled
      );
      if (current.executionRunId) {
        db.prepare("UPDATE cancellation_controls SET settled_at = COALESCE(settled_at, ?) WHERE run_id = ?")
          .run(now, current.executionRunId);
      }
      const normalized = normalizeJob({
        ...current,
        status: targetStatus,
        completedAt: now,
        result: targetStatus === "completed" ? result : undefined,
        error: settlementError,
        dispatchLease: undefined,
        executionAttemptId: linked.attemptId,
        envelopeDigest: linked.envelopeDigest,
        auditCorrelationId: linked.auditCorrelationId,
        cancellationControlReference: linked.cancellationControlReference
      }, current);
      writeJob(db, normalized);
      return hydrate(db.prepare("SELECT * FROM runtime_jobs WHERE id = ?").get(id) as SqlRow);
    });
  }

  async adoptProtectedResult(id: string, {
    result,
    expected,
    interrupted,
    source = "recovery"
  }: {
    result: unknown;
    expected: ProtectedResultRecoveryExpectation;
    interrupted?: string;
    source?: "live" | "recovery";
  }): Promise<RuntimeJobRecord> {
    return this.ledger.database.transaction((db) => {
      const row = db.prepare("SELECT * FROM runtime_jobs WHERE id = ?").get(id) as SqlRow | undefined;
      if (!row) throw new Error(`job not found: ${id}`);
      const current = hydrate(row);

      const linked = correlation(this.ledger, current.executionRunId);
      const cancellation = current.executionRunId
        ? db.prepare(`SELECT id, requested_at, acknowledged_at, settled_at
          FROM cancellation_controls WHERE run_id = ?`).get(current.executionRunId) as SqlRow | undefined
        : undefined;
      const lease = current.dispatchLease?.token
        ? db.prepare("SELECT * FROM runtime_job_leases WHERE token = ? AND job_id = ?")
            .get(String(current.dispatchLease.token), current.id) as SqlRow | undefined
        : undefined;

      // The protected record lives in a separate access-controlled store, so
      // bind the already-verified record to the exact runtime-job snapshot
      // that was used to verify it. The remaining job, attempt, lease, and
      // cancellation checks and all state changes share this transaction.
      const expectedLeaseToken = optionalString(expected.dispatchLease?.token);
      const snapshotMatches = current.status === expected.status
        && current.updatedAt === expected.updatedAt
        && current.requestHash === expected.requestHash
        && current.occurrenceKey === expected.occurrenceKey
        && current.executionRunId === expected.executionRunId
        && current.dispatchLease?.token === expectedLeaseToken
        && current.dispatchLease?.owner === optionalString(expected.dispatchLease?.owner)
        && current.dispatchLease?.epoch === optionalString(expected.dispatchLease?.epoch)
        && current.dispatchLease?.acquiredAt === optionalString(expected.dispatchLease?.acquiredAt)
        && current.dispatchLease?.expiresAt === optionalString(expected.dispatchLease?.expiresAt)
        && current.dispatchLease?.occurrenceKey === optionalString(expected.dispatchLease?.occurrenceKey);
      const executionIdentityMatches = Boolean(
        current.executionRunId
        && current.executionRunId === expected.executionRunId
        && linked?.attemptId
        && expected.executionAttemptId === linked.attemptId
        && expected.envelopeDigest === linked.envelopeDigest
        && expected.auditCorrelationId === linked.auditCorrelationId
        && expected.cancellationControlReference === linked.cancellationControlReference
        && (!current.executionAttemptId || current.executionAttemptId === expected.executionAttemptId)
        && (!current.envelopeDigest || current.envelopeDigest === expected.envelopeDigest)
        && (!current.auditCorrelationId || current.auditCorrelationId === expected.auditCorrelationId)
        && (!current.cancellationControlReference
          || current.cancellationControlReference === expected.cancellationControlReference)
      );
      const cancellationControlMatches = Boolean(
        cancellation
        && linked
        && String(cancellation.id) === linked.cancellationControlReference
      );
      const cancellationObserved = Boolean(cancellation?.requested_at || cancellation?.acknowledged_at);
      const settlementInterrupted = optionalString(interrupted);
      const leaseMatches = Boolean(
        expectedLeaseToken
        && current.dispatchLease
        && lease
        && lease.released_at === null
        && String(lease.owner) === current.dispatchLease.owner
        && String(lease.epoch) === current.dispatchLease.epoch
        && String(lease.acquired_at) === current.dispatchLease.acquiredAt
        && String(lease.expires_at) === current.dispatchLease.expiresAt
        && (lease.occurrence_key === null ? current.occurrenceKey === undefined : String(lease.occurrence_key) === current.occurrenceKey)
      );
      const compatibleAttempt = linked?.attemptState === "running" || linked?.attemptState === "completed";
      const canAdopt = current.status === "running"
        && snapshotMatches
        && executionIdentityMatches
        && cancellationControlMatches
        && !cancellationObserved
        && !settlementInterrupted
        && leaseMatches
        && compatibleAttempt;
      const now = new Date().toISOString();
      const targetStatus = canAdopt ? "completed" : "needs-review";
      const recoveryError = canAdopt
        ? undefined
        : current.status === "cancelling" || cancellationObserved || linked?.attemptState === "cancelling"
          ? "protected channel result cannot override a cancellation; external outcome requires operator review"
          : settlementInterrupted
            ? "protected channel result settlement was interrupted; external outcome requires operator review"
            : "protected channel result could not be atomically bound to its execution state; external outcome requires operator review";

      if (current.dispatchLease?.token) {
        db.prepare(`UPDATE runtime_job_leases
          SET released_at = COALESCE(released_at, ?), release_reason = COALESCE(release_reason, ?)
          WHERE token = ? AND job_id = ?`)
          .run(now, targetStatus, String(current.dispatchLease.token), current.id);
      }
      if (canAdopt && linked?.attemptState === "running") {
        transitionAttempt(db, linked.attemptId, "running", "completed", undefined, this.executionOwnershipEnabled);
      } else if (!canAdopt && linked?.attemptState
        && !TERMINAL_ATTEMPT_STATES.has(linked.attemptState)) {
        transitionAttempt(
          db,
          linked.attemptId,
          linked.attemptState,
          "needs-review",
          cancellationObserved || current.status === "cancelling" || linked.attemptState === "cancelling"
            ? "PROTECTED_RESULT_CANCELLATION_OUTCOME_UNCERTAIN"
            : "PROTECTED_RESULT_RECOVERY_STATE_UNCERTAIN",
          this.executionOwnershipEnabled
        );
      }
      if (current.executionRunId && cancellationControlMatches) {
        db.prepare("UPDATE cancellation_controls SET settled_at = COALESCE(settled_at, ?) WHERE run_id = ?")
          .run(now, current.executionRunId);
      }
      const normalized = normalizeJob({
        ...current,
        status: targetStatus,
        completedAt: now,
        result: canAdopt ? result : undefined,
        error: recoveryError,
        ...(source === "recovery" ? { recoveredAt: now } : {}),
        dispatchLease: undefined,
        ...(linked ? {
          executionAttemptId: linked.attemptId,
          envelopeDigest: linked.envelopeDigest,
          auditCorrelationId: linked.auditCorrelationId,
          cancellationControlReference: linked.cancellationControlReference
        } : {})
      }, current);
      if (!canAdopt) {
        normalized.result = undefined;
        normalized.resultJson = null;
      }
      writeJob(db, normalized);
      return hydrate(db.prepare("SELECT * FROM runtime_jobs WHERE id = ?").get(id) as SqlRow);
    });
  }

  async getProtectedResultSnapshot(id: string): Promise<RuntimeJobRecord | undefined> {
    return this.ledger.database.transaction((db) => {
      const row = db.prepare("SELECT * FROM runtime_jobs WHERE id = ?").get(id) as SqlRow | undefined;
      if (!row) return undefined;
      const current = hydrate(row);
      const linked = correlation(this.ledger, current.executionRunId);
      return linked ? {
        ...current,
        executionAttemptId: linked.attemptId,
        envelopeDigest: linked.envelopeDigest,
        auditCorrelationId: linked.auditCorrelationId,
        cancellationControlReference: linked.cancellationControlReference
      } : current;
    });
  }

  async update(id: string, patch: JsonObject): Promise<RuntimeJobRecord> {
    return this.ledger.database.transaction((db) => {
      const row = db.prepare("SELECT * FROM runtime_jobs WHERE id = ?").get(id) as SqlRow | undefined;
      if (!row) throw new Error(`job not found: ${id}`);
      const current = hydrate(row);
      const expectedLeaseToken = optionalString(patch.expectedLeaseToken);
      if (expectedLeaseToken && current.dispatchLease?.token !== expectedLeaseToken) {
        const error = new Error(`runtime job ${id} dispatch lease is no longer owned by this worker`) as Error & { code?: string };
        error.code = "STALE_DISPATCH_LEASE";
        throw error;
      }
      const linked = correlation(this.ledger, current.executionRunId);
      const requestedStatus = String(patch.status ?? current.status);
      const linkedTerminalState = linked?.attemptState && TERMINAL_ATTEMPT_STATES.has(linked.attemptState)
        ? linked.attemptState
        : undefined;
      // A later integrity failure is allowed to quarantine an apparently
      // completed attempt. Completion is not truthful when its protected
      // result is missing or failed verification.
      const targetStatus = requestedStatus === "needs-review"
        ? requestedStatus
        : linkedTerminalState && TERMINAL_JOB_STATES.has(requestedStatus)
        ? linkedTerminalState
        : requestedStatus;
      const effectivePatch = targetStatus === requestedStatus ? patch : {
        ...patch,
        status: targetStatus,
        ...(targetStatus === "completed" ? { error: undefined } : { error: patch.error ?? linked?.attemptErrorCode ?? current.error })
      };
      if ("dispatchLease" in patch && patch.dispatchLease === undefined && current.dispatchLease?.token) {
        db.prepare(`UPDATE runtime_job_leases SET released_at = COALESCE(released_at, ?), release_reason = COALESCE(release_reason, ?)
          WHERE token = ?`).run(new Date().toISOString(), targetStatus, String(current.dispatchLease.token));
      }
      if (linked?.attemptState && TERMINAL_JOB_STATES.has(targetStatus)) {
        transitionAttempt(
          db,
          linked.attemptId,
          linked.attemptState,
          targetStatus as ExecutionAttemptState,
          targetStatus === "needs-review" ? "EXECUTION_OUTCOME_UNCERTAIN" : targetStatus === "cancelled" ? "EXECUTION_CANCELLED" : undefined,
          this.executionOwnershipEnabled
        );
        db.prepare("UPDATE cancellation_controls SET settled_at = COALESCE(settled_at, ?) WHERE run_id = ?")
          .run(new Date().toISOString(), current.executionRunId ?? "");
      }
      const normalized = normalizeJob({
        ...current,
        ...effectivePatch,
        id,
        ...(linked ? {
          executionAttemptId: linked.attemptId,
          envelopeDigest: linked.envelopeDigest,
          auditCorrelationId: linked.auditCorrelationId,
          cancellationControlReference: linked.cancellationControlReference
        } : {})
      }, current);
      writeJob(db, normalized);
      return hydrate(db.prepare("SELECT * FROM runtime_jobs WHERE id = ?").get(id) as SqlRow);
    });
  }

  async renewLease(id: string, { token, owner, epoch, expiresAt }: { token: string; owner: string; epoch: string; expiresAt: string }) {
    return this.ledger.database.transaction((db) => {
      const result = db.prepare(`UPDATE runtime_jobs SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('running', 'cancelling') AND lease_token = ? AND lease_owner = ? AND lease_epoch = ?`)
        .run(expiresAt, new Date().toISOString(), id, token, owner, epoch);
      if (Number(result.changes) !== 1) return false;
      db.prepare(`UPDATE runtime_job_leases SET expires_at = ?
        WHERE token = ? AND owner = ? AND epoch = ? AND released_at IS NULL`).run(expiresAt, token, owner, epoch);
      return true;
    });
  }

  async cancel(id: string, { requestedBy = "operator", reason = "job cancelled by user" }: { requestedBy?: string; reason?: string } = {}) {
    return this.ledger.database.transaction((db) => {
      const row = db.prepare("SELECT * FROM runtime_jobs WHERE id = ?").get(id) as SqlRow | undefined;
      if (!row) throw new Error(`job not found: ${id}`);
      const current = hydrate(row);
      if (TERMINAL_JOB_STATES.has(current.status)) return current;
      const linked = correlation(this.ledger, current.executionRunId);
      const now = new Date().toISOString();
      if (linked?.attemptState && TERMINAL_ATTEMPT_STATES.has(linked.attemptState)) {
        if (current.dispatchLease?.token) {
          db.prepare(`UPDATE runtime_job_leases SET released_at = COALESCE(released_at, ?), release_reason = COALESCE(release_reason, ?)
            WHERE token = ?`).run(now, linked.attemptState, String(current.dispatchLease.token));
        }
        if (current.executionRunId) {
          db.prepare("UPDATE cancellation_controls SET settled_at = COALESCE(settled_at, ?) WHERE run_id = ?")
            .run(now, current.executionRunId);
        }
        const normalized = normalizeJob({
          ...current,
          status: linked.attemptState,
          completedAt: current.completedAt ?? now,
          error: linked.attemptState === "completed" ? undefined : current.error ?? linked.attemptErrorCode,
          dispatchLease: undefined,
          executionAttemptId: linked.attemptId,
          envelopeDigest: linked.envelopeDigest,
          auditCorrelationId: linked.auditCorrelationId,
          cancellationControlReference: linked.cancellationControlReference
        }, current);
        writeJob(db, normalized);
        return hydrate(db.prepare("SELECT * FROM runtime_jobs WHERE id = ?").get(id) as SqlRow);
      }
      const running = current.status === "running" || current.status === "cancelling";
      const status = running ? "cancelling" : "cancelled";
      if (current.executionRunId) {
        db.prepare(`UPDATE cancellation_controls SET requested_at = COALESCE(requested_at, ?),
          requested_by = COALESCE(requested_by, ?), reason = COALESCE(reason, ?),
          acknowledged_at = COALESCE(acknowledged_at, ?), settled_at = CASE WHEN ? = 'cancelled' THEN COALESCE(settled_at, ?) ELSE settled_at END
          WHERE run_id = ?`).run(now, requestedBy, reason, now, status, now, current.executionRunId);
      }
      if (linked?.attemptState === "running") transitionAttempt(db, linked.attemptId, "running", "cancelling", "EXECUTION_CANCELLATION_REQUESTED", this.executionOwnershipEnabled);
      else if (status === "cancelled" && linked?.attemptState && !TERMINAL_ATTEMPT_STATES.has(linked.attemptState)) {
        transitionAttempt(db, linked.attemptId, linked.attemptState, "cancelled", "EXECUTION_CANCELLED", this.executionOwnershipEnabled);
      }
      const normalized = normalizeJob({
        ...current,
        status,
        ...(status === "cancelled" ? { completedAt: now } : {}),
        ...(linked ? {
          executionAttemptId: linked.attemptId,
          envelopeDigest: linked.envelopeDigest,
          auditCorrelationId: linked.auditCorrelationId,
          cancellationControlReference: linked.cancellationControlReference
        } : {})
      }, current);
      writeJob(db, normalized);
      return hydrate(db.prepare("SELECT * FROM runtime_jobs WHERE id = ?").get(id) as SqlRow);
    });
  }

  async recover({ maxAttempts = 3 }: { maxAttempts?: number } = {}) {
    await this.importLegacy();
    return this.ledger.database.transaction((db) => {
      const candidates = (db.prepare(
        `SELECT * FROM runtime_jobs
          WHERE status IN ('running', 'cancelling', 'awaiting-approval')
            OR (status = 'queued' AND (payload_recoverable = 0 OR execution_run_id IS NOT NULL))
          ORDER BY created_at, id`
      ).all() as SqlRow[]).map(hydrate);
      for (const current of candidates) {
        const linked = correlation(this.ledger, current.executionRunId);
        const retrySafe = linked ? current.retrySafe && linked.retrySafety === "retry-safe" : current.retrySafe;
        const now = new Date().toISOString();
        if ((current.status === "running" || current.status === "cancelling")
          && current.dispatchLease?.expiresAt
          && Date.parse(String(current.dispatchLease.expiresAt)) > Date.parse(now)) {
          continue;
        }
        let status = current.status;
        let error = current.error;
        let completedAt = current.completedAt;

        if ((linked?.attemptState === "failed" || (linked?.attemptState === "cancelled" && current.status === "queued"))
          && ["queued", "running"].includes(current.status)
          && retrySafe && current.attempts < maxAttempts
          && !TERMINAL_JOB_STATES.has(current.status)) {
          status = "queued";
          error = "retry-safe execution settled before its queued retry intent and is eligible for a new attempt";
          completedAt = undefined;
        } else if (linked?.attemptState === "completed") {
          status = linked.attemptState;
          error = undefined;
          completedAt = current.completedAt ?? now;
        } else if (current.status === "cancelling") {
          const terminalCancellationRace = linked?.attemptState && TERMINAL_ATTEMPT_STATES.has(linked.attemptState)
            ? linked.attemptState
            : undefined;
          status = terminalCancellationRace ?? (retrySafe ? "cancelled" : "needs-review");
          error = status === "cancelled"
            ? "cancellation was recovered after restart"
            : status === "failed"
              ? current.error ?? linked?.attemptErrorCode ?? "execution failed while cancellation was pending"
              : "execution was interrupted while cancellation was pending; outcome requires operator review";
          completedAt = now;
          transitionAttempt(db, linked?.attemptId, linked?.attemptState, status as ExecutionAttemptState, status === "needs-review" ? "CANCELLATION_OUTCOME_UNCERTAIN" : "EXECUTION_CANCELLED", this.executionOwnershipEnabled);
        } else if (linked?.attemptState && TERMINAL_ATTEMPT_STATES.has(linked.attemptState)) {
          status = linked.attemptState;
          error = current.error ?? linked.attemptErrorCode ?? "execution attempt settled before runtime job projection";
          completedAt = current.completedAt ?? now;
        } else if (current.status === "awaiting-approval" && linked?.attemptState === "awaiting-approval") {
          status = "awaiting-approval";
        } else if (linked?.attemptState === "awaiting-approval") {
          status = "needs-review";
          error = "an approval continuation lease expired before a terminal result was persisted; outcome requires operator review";
          completedAt = now;
          transitionAttempt(db, linked.attemptId, linked.attemptState, "needs-review", "APPROVAL_CONTINUATION_OUTCOME_UNCERTAIN", this.executionOwnershipEnabled);
        } else if (current.recoveryInputAvailable !== true) {
          const crossedDispatch = linked?.attemptState === "running";
          status = crossedDispatch && !retrySafe ? "needs-review" : "failed";
          error = crossedDispatch && !retrySafe
            ? "execution crossed the dispatch boundary before volatile input was lost; outcome requires operator review"
            : "volatile execution input is unavailable after restart; resubmit the job with fresh input";
          completedAt = now;
          transitionAttempt(db, linked?.attemptId, linked?.attemptState, status as ExecutionAttemptState, status === "needs-review" ? "EXECUTION_OUTCOME_UNCERTAIN" : "RECOVERY_INPUT_UNAVAILABLE", this.executionOwnershipEnabled);
        } else if (!linked && current.importedFromLegacy && (!retrySafe || current.attempts >= maxAttempts)) {
          status = retrySafe ? "failed" : "needs-review";
          error = retrySafe
            ? "legacy retry-safe execution exhausted its attempt limit during restart recovery"
            : "legacy execution was already running at SQLite cutover; outcome requires operator review";
          completedAt = now;
        } else if (!linked || linked.attemptState === "queued") {
          status = "queued";
          error = "execution was interrupted before the dispatch boundary and is eligible for dispatch";
          completedAt = undefined;
        } else if (retrySafe && current.attempts < maxAttempts) {
          status = "queued";
          error = "retry-safe execution was interrupted and is eligible for a new attempt";
          completedAt = undefined;
          transitionAttempt(db, linked?.attemptId, linked?.attemptState, "failed", "EXECUTION_INTERRUPTED_RETRY_SAFE", this.executionOwnershipEnabled);
        } else {
          status = retrySafe ? "failed" : "needs-review";
          error = retrySafe
            ? "retry-safe execution exhausted its attempt limit during restart recovery"
            : "execution was interrupted after dispatch; outcome requires operator review";
          completedAt = now;
          transitionAttempt(db, linked?.attemptId, linked?.attemptState, status as ExecutionAttemptState, status === "needs-review" ? "EXECUTION_OUTCOME_UNCERTAIN" : "EXECUTION_RETRY_EXHAUSTED", this.executionOwnershipEnabled);
        }
        const normalized = normalizeJob({
          ...current,
          status,
          error,
          completedAt,
          recoveredAt: now,
          dispatchLease: undefined,
          ...(linked ? {
            executionAttemptId: linked.attemptId,
            envelopeDigest: linked.envelopeDigest,
            auditCorrelationId: linked.auditCorrelationId,
            cancellationControlReference: linked.cancellationControlReference
          } : {})
        }, current);
        if (current.dispatchLease?.token) {
          db.prepare(`UPDATE runtime_job_leases SET released_at = COALESCE(released_at, ?), release_reason = COALESCE(release_reason, 'restart-recovery')
            WHERE token = ?`).run(now, String(current.dispatchLease.token));
        }
        if (TERMINAL_JOB_STATES.has(status) && current.executionRunId) {
          db.prepare("UPDATE cancellation_controls SET settled_at = COALESCE(settled_at, ?) WHERE run_id = ?")
            .run(now, current.executionRunId);
        }
        writeJob(db, normalized);
      }
      const grouped = db.prepare("SELECT status, COUNT(*) AS count FROM runtime_jobs GROUP BY status").all() as SqlRow[];
      const byStatus = Object.fromEntries(grouped.map((row) => [String(row.status), Number(row.count)]));
      const nextLease = db.prepare(`SELECT MIN(lease_expires_at) AS expires_at FROM runtime_jobs
        WHERE status IN ('running', 'cancelling') AND lease_token IS NOT NULL AND lease_expires_at > ?`).get(new Date().toISOString()) as SqlRow;
      return {
        queued: byStatus.queued ?? 0,
        running: byStatus.running ?? 0,
        awaitingApproval: byStatus["awaiting-approval"] ?? 0,
        completed: byStatus.completed ?? 0,
        failed: byStatus.failed ?? 0,
        cancelled: byStatus.cancelled ?? 0,
        needsReview: byStatus["needs-review"] ?? 0,
        ...(nextLease.expires_at === null ? {} : { nextLeaseExpiry: String(nextLease.expires_at) })
      };
    });
  }

  async importLegacy() {
    if (!this.legacyPath) return { imported: false, jobs: 0 };
    const legacyPath = this.legacyPath;
    const sourceId = basename(legacyPath);
    let source: string;
    try {
      const metadata = await stat(legacyPath);
      if (!metadata.isFile() || metadata.size > MAX_LEGACY_JOB_STORE_BYTES) {
        throw new Error(`legacy runtime job store exceeds the ${MAX_LEGACY_JOB_STORE_BYTES}-byte migration limit: ${legacyPath}`);
      }
      source = await readFile(legacyPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { imported: false, jobs: 0 };
      throw error;
    }
    const sourceDigest = createHash("sha256").update(source).digest("hex");
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error(`legacy runtime job store is corrupted: ${legacyPath}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || (parsed as JsonObject).schemaVersion !== 1
      || !(parsed as JsonObject).jobs || typeof (parsed as JsonObject).jobs !== "object" || Array.isArray((parsed as JsonObject).jobs)) {
      throw new Error(`unsupported legacy runtime job store: ${legacyPath}`);
    }
    const jobs = Object.values((parsed as { jobs: Record<string, unknown> }).jobs);
    return this.ledger.database.transaction((db) => {
      const prior = db.prepare("SELECT source_digest, imported_jobs FROM runtime_job_imports WHERE source_path = ?").get(sourceId) as SqlRow | undefined;
      if (prior) {
        if (String(prior.source_digest) !== sourceDigest) {
          throw new Error(`legacy runtime job store changed after SQLite cutover: ${legacyPath}`);
        }
        return { imported: false, jobs: Number(prior.imported_jobs), sourceDigest: String(prior.source_digest) };
      }
      let imported = 0;
      for (const value of jobs) {
        if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as JsonObject).id !== "string") {
          throw new Error(`legacy runtime job store contains an invalid job: ${legacyPath}`);
        }
        const normalized = normalizeJob({ ...(value as Record<string, unknown> & { id: string }), importedFromLegacy: true });
        const existing = db.prepare("SELECT 1 FROM runtime_jobs WHERE id = ?").get(normalized.id);
        if (!existing) {
          writeJob(db, normalized);
          imported += 1;
        }
      }
      db.prepare("INSERT INTO runtime_job_imports(source_path, source_digest, imported_at, imported_jobs) VALUES (?, ?, ?, ?)")
        .run(sourceId, sourceDigest, new Date().toISOString(), imported);
      return { imported: true, jobs: imported, sourceDigest };
    });
  }
}
