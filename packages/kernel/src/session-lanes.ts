import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "@odinn/protocol";
import type { JobRecord, JobStore } from "./jobs.ts";

export const SESSION_LANE_STATE_VERSION = 1;
export const DEFAULT_SESSION_LANE_CONCURRENCY = 4;
export const DEFAULT_SESSION_LANE_MAX_PENDING = 1_000;
export const DEFAULT_SESSION_LANE_MAX_PENDING_PER_LANE = 100;
export const DEFAULT_SESSION_LANE_MAX_PAYLOAD_BYTES = 262_144;
export const DEFAULT_SESSION_LANE_MAX_PENDING_BYTES = 8_388_608;
export const MAX_SESSION_LANE_KEY_BYTES = 128;
export const MAX_SESSION_LANE_JOB_ID_BYTES = 128;
export const MAX_SESSION_LANE_REQUEST_HASH_BYTES = 256;

const MAX_TIMEOUT_MS = 86_400_000;
const MAX_ATTEMPTS = 1_000_000;
const MAX_ERROR_BYTES = 8_192;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "needs-review"]);
const ALLOWED_STATUSES = new Set([...TERMINAL_STATUSES, "queued", "running"]);
const LANE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const REQUEST_HASH_PATTERN = /^[\x21-\x7e]+$/u;
const ENVELOPE_KEYS = new Set([
  "schemaVersion", "id", "status", "payload", "attempts", "timeoutMs", "requestHash",
  "retrySafe", "result", "error", "createdAt", "updatedAt", "startedAt", "completedAt",
  "recoveredAt"
]);
const PAYLOAD_KEYS = new Set(["sessionLaneVersion", "laneKey", "laneSequence", "input"]);

export type SessionLaneStore = JobStore;
export type SessionLaneLifecycle = "stopped" | "started" | "stopping";

export interface SessionLaneExecutionContext {
  signal: AbortSignal;
  job: JobRecord;
  laneKey: string;
}

/**
 * Executors should stop promptly when `context.signal` aborts. The scheduler
 * retains physical same-lane exclusion until this promise actually settles,
 * even when timeout/cancellation has already released global capacity.
 */
export type SessionLaneExecute = (
  payload: JsonObject,
  context: SessionLaneExecutionContext
) => Promise<unknown>;

export interface DurableSessionLaneSchedulerOptions {
  store: SessionLaneStore;
  execute: SessionLaneExecute;
  concurrency?: number;
  maxPending?: number;
  maxPendingPerLane?: number;
  maxPayloadBytes?: number;
  maxPendingBytes?: number;
  defaultTimeoutMs?: number;
}

export interface SessionLaneSubmitOptions {
  id?: string;
  timeoutMs?: number;
  requestHash?: string;
}

export interface SessionLaneSchedulerStatus {
  lifecycle: SessionLaneLifecycle;
  degraded: boolean;
  degradedError?: string;
  activeJobs: number;
  lockedLanes: number;
}

interface PersistedLanePayload extends JsonObject {
  sessionLaneVersion: number;
  laneKey: string;
  laneSequence: number;
  input: JsonObject;
}

interface ValidatedLaneJob {
  job: JobRecord;
  persisted: PersistedLanePayload;
  payloadBytes: number;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

interface ActiveLaneJob {
  controller: AbortController;
  deferred: Deferred;
  job: JobRecord;
  laneKey: string;
  payload: PersistedLanePayload;
  logicalSettled: boolean;
  executionSettled: boolean;
}

interface TransitionExpectation {
  id: string;
  status: string;
  attempts: number;
  prior?: JobRecord;
  payload?: JsonObject;
  timeoutMs?: number;
  retrySafe?: boolean;
  requestHash?: string;
  patch?: JsonObject;
}

type ExecutionOutcome =
  | { kind: "success"; result: unknown }
  | { kind: "failure"; error: unknown };

class SessionLaneAbortReason extends Error {
  readonly kind: "cancel" | "timeout" | "shutdown";

  constructor(kind: SessionLaneAbortReason["kind"]) {
    super(`session lane job ${kind === "cancel" ? "cancelled by user" : kind === "timeout" ? "timed out" : "aborted during shutdown"}`);
    this.name = "SessionLaneAbortReason";
    this.kind = kind;
  }
}

export class SessionLaneValidationError extends Error {
  readonly code: "INVALID_LANE_KEY" | "INVALID_OPTION" | "INVALID_STORED_JOB";

  constructor(code: SessionLaneValidationError["code"], message: string) {
    super(message);
    this.name = "SessionLaneValidationError";
    this.code = code;
  }
}

export class SessionLaneOwnershipError extends Error {
  readonly code = "STORE_NOT_DEDICATED";

  constructor(message: string) {
    super(message);
    this.name = "SessionLaneOwnershipError";
  }
}

export class SessionLaneAdmissionError extends Error {
  readonly code: "QUEUE_FULL" | "LANE_QUEUE_FULL" | "QUEUE_BYTES_FULL";

  constructor(code: SessionLaneAdmissionError["code"], message: string) {
    super(message);
    this.name = "SessionLaneAdmissionError";
    this.code = code;
  }
}

export class SessionLaneDegradedError extends Error {
  readonly code = "SCHEDULER_DEGRADED";
  override readonly cause: unknown;

  constructor(operation: string, cause: unknown) {
    super(`session lane scheduler degraded after durable store ${operation} failed: ${errorMessage(cause)}`);
    this.name = "SessionLaneDegradedError";
    this.cause = cause;
  }
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function positiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new SessionLaneValidationError("INVALID_OPTION", `${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function strictAsciiIdentifier(value: string, maximum: number, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum || !pattern.test(value)) {
    throw new SessionLaneValidationError(
      "INVALID_OPTION",
      `${label} must be 1-${maximum} ASCII bytes and contain only letters, digits, dot, underscore, colon, or hyphen`
    );
  }
  return value;
}

export function validateSessionLaneKey(laneKey: string): string {
  try {
    return strictAsciiIdentifier(laneKey, MAX_SESSION_LANE_KEY_BYTES, LANE_KEY_PATTERN, "lane key");
  } catch (error) {
    throw new SessionLaneValidationError("INVALID_LANE_KEY", errorMessage(error).replace("INVALID_OPTION: ", ""));
  }
}

function validateJobId(id: string): string {
  return strictAsciiIdentifier(id, MAX_SESSION_LANE_JOB_ID_BYTES, JOB_ID_PATTERN, "job id");
}

function validateRequestHash(requestHash: string | undefined): string | undefined {
  if (requestHash === undefined) return undefined;
  if (typeof requestHash !== "string"
    || Buffer.byteLength(requestHash, "utf8") > MAX_SESSION_LANE_REQUEST_HASH_BYTES
    || !REQUEST_HASH_PATTERN.test(requestHash)) {
    throw new SessionLaneValidationError(
      "INVALID_OPTION",
      `requestHash must be 1-${MAX_SESSION_LANE_REQUEST_HASH_BYTES} printable ASCII bytes without spaces`
    );
  }
  return requestHash;
}

function jsonBytes(value: unknown, label: string): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new SessionLaneValidationError("INVALID_OPTION", `${label} must be JSON serializable: ${errorMessage(error)}`);
  }
  if (serialized === undefined) {
    throw new SessionLaneValidationError("INVALID_OPTION", `${label} must be JSON serializable`);
  }
  return Buffer.byteLength(serialized, "utf8");
}

function validateTimestamp(value: unknown, name: string, required: boolean): void {
  if (value === undefined && !required) return;
  if (typeof value !== "string"
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new SessionLaneValidationError("INVALID_STORED_JOB", `${name} must be a canonical ISO timestamp`);
  }
}

function persistedPayload(laneKey: string, laneSequence: number, input: JsonObject): PersistedLanePayload {
  return {
    sessionLaneVersion: SESSION_LANE_STATE_VERSION,
    laneKey: validateSessionLaneKey(laneKey),
    laneSequence: positiveInteger(laneSequence, "laneSequence"),
    input
  };
}

function validateStoredJob(job: JobRecord, maxPayloadBytes: number): ValidatedLaneJob {
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    throw new SessionLaneValidationError("INVALID_STORED_JOB", "stored lane job must be an object");
  }
  for (const key of Object.keys(job)) {
    if (!ENVELOPE_KEYS.has(key)) {
      throw new SessionLaneValidationError("INVALID_STORED_JOB", `job ${String(job.id)} contains unsupported field ${key}`);
    }
  }
  try {
    validateJobId(job.id);
    validateRequestHash(job.requestHash);
  } catch (error) {
    throw new SessionLaneValidationError("INVALID_STORED_JOB", errorMessage(error));
  }
  if (!ALLOWED_STATUSES.has(job.status)) {
    throw new SessionLaneValidationError("INVALID_STORED_JOB", `job ${job.id} has invalid status ${job.status}`);
  }
  const schemaVersion = (job as unknown as JsonObject).schemaVersion;
  if (schemaVersion !== 1) {
    throw new SessionLaneValidationError("INVALID_STORED_JOB", `job ${job.id} has invalid schemaVersion`);
  }
  if (!Number.isSafeInteger(job.attempts) || job.attempts < 0 || job.attempts > MAX_ATTEMPTS) {
    throw new SessionLaneValidationError("INVALID_STORED_JOB", `job ${job.id} has invalid attempts`);
  }
  if (job.status === "queued" && job.attempts !== 0) {
    throw new SessionLaneValidationError("INVALID_STORED_JOB", `queued job ${job.id} must not contain a prior attempt`);
  }
  if (!Number.isSafeInteger(job.timeoutMs) || job.timeoutMs < 1 || job.timeoutMs > MAX_TIMEOUT_MS) {
    throw new SessionLaneValidationError("INVALID_STORED_JOB", `job ${job.id} has invalid timeoutMs`);
  }
  if (typeof job.retrySafe !== "boolean") {
    throw new SessionLaneValidationError("INVALID_STORED_JOB", `job ${job.id} has invalid retrySafe`);
  }
  validateTimestamp(job.createdAt, `job ${job.id} createdAt`, true);
  validateTimestamp(job.updatedAt, `job ${job.id} updatedAt`, true);
  validateTimestamp(job.startedAt, `job ${job.id} startedAt`, job.status === "running");
  if (job.status === "queued" && job.startedAt !== undefined) {
    throw new SessionLaneValidationError("INVALID_STORED_JOB", `queued job ${job.id} must not contain startedAt`);
  }
  validateTimestamp(job.completedAt, `job ${job.id} completedAt`, TERMINAL_STATUSES.has(job.status));
  if (!TERMINAL_STATUSES.has(job.status) && job.completedAt !== undefined) {
    throw new SessionLaneValidationError("INVALID_STORED_JOB", `job ${job.id} has completedAt before a terminal state`);
  }
  validateTimestamp((job as unknown as JsonObject).recoveredAt, `job ${job.id} recoveredAt`, false);
  const createdAt = Date.parse(String(job.createdAt));
  for (const [name, timestamp] of [
    ["updatedAt", job.updatedAt],
    ["startedAt", job.startedAt],
    ["completedAt", job.completedAt]
  ] as const) {
    if (timestamp !== undefined && Date.parse(timestamp) < createdAt) {
      throw new SessionLaneValidationError("INVALID_STORED_JOB", `job ${job.id} ${name} predates createdAt`);
    }
  }
  if (job.error !== undefined
    && (typeof job.error !== "string" || Buffer.byteLength(job.error, "utf8") > MAX_ERROR_BYTES)) {
    throw new SessionLaneValidationError("INVALID_STORED_JOB", `job ${job.id} has invalid error`);
  }
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) {
    throw new SessionLaneValidationError("INVALID_STORED_JOB", `job ${job.id} has invalid lane payload`);
  }
  for (const key of Object.keys(job.payload)) {
    if (!PAYLOAD_KEYS.has(key)) {
      throw new SessionLaneValidationError("INVALID_STORED_JOB", `job ${job.id} lane payload contains unsupported field ${key}`);
    }
  }
  const value = job.payload as Partial<PersistedLanePayload>;
  if (value.sessionLaneVersion !== SESSION_LANE_STATE_VERSION
    || typeof value.laneKey !== "string"
    || !Number.isSafeInteger(value.laneSequence)
    || Number(value.laneSequence) < 1
    || !value.input
    || typeof value.input !== "object"
    || Array.isArray(value.input)) {
    throw new SessionLaneValidationError("INVALID_STORED_JOB", `job ${job.id} is not a valid session-lane record`);
  }
  try {
    validateSessionLaneKey(value.laneKey);
  } catch (error) {
    throw new SessionLaneValidationError("INVALID_STORED_JOB", errorMessage(error));
  }
  const payloadBytes = jsonBytes(job.payload, `job ${job.id} payload`);
  if (payloadBytes > maxPayloadBytes) {
    throw new SessionLaneValidationError(
      "INVALID_STORED_JOB",
      `job ${job.id} payload exceeds ${maxPayloadBytes} bytes`
    );
  }
  return { job, persisted: value as PersistedLanePayload, payloadBytes };
}

function byCreatedAtThenId(left: JobRecord, right: JobRecord): number {
  const created = String(left.createdAt).localeCompare(String(right.createdAt));
  return created || left.id.localeCompare(right.id);
}

/**
 * Default-inert, demand-loaded durable session-lane scheduling foundation.
 * Durable store errors enter fail-closed degraded mode: no further admission
 * or dispatch occurs, active executions are not retried, and callers observe
 * `SessionLaneDegradedError` plus `status().degradedError`.
 */
export class DurableSessionLaneScheduler {
  readonly store: SessionLaneStore;
  readonly execute: SessionLaneExecute;
  readonly concurrency: number;
  readonly maxPending: number;
  readonly maxPendingPerLane: number;
  readonly maxPayloadBytes: number;
  readonly maxPendingBytes: number;
  readonly defaultTimeoutMs: number;

  private readonly active = new Map<string, ActiveLaneJob>();
  private readonly lockedLanes = new Set<string>();
  private stateChain: Promise<unknown> = Promise.resolve();
  private lifecycleChain: Promise<unknown> = Promise.resolve();
  private drainPromise: Promise<void> | undefined;
  private drainRequested = false;
  private lifecycle: SessionLaneLifecycle = "stopped";
  private degraded: SessionLaneDegradedError | undefined;

  constructor(options: DurableSessionLaneSchedulerOptions) {
    if (!options?.store || typeof options.store.create !== "function") {
      throw new SessionLaneValidationError("INVALID_OPTION", "session lane scheduler requires a durable store");
    }
    if (typeof options.execute !== "function") {
      throw new SessionLaneValidationError("INVALID_OPTION", "session lane scheduler requires an execute function");
    }
    this.store = options.store;
    this.execute = options.execute;
    this.concurrency = positiveInteger(options.concurrency ?? DEFAULT_SESSION_LANE_CONCURRENCY, "concurrency", 256);
    this.maxPending = positiveInteger(options.maxPending ?? DEFAULT_SESSION_LANE_MAX_PENDING, "maxPending", 1_000_000);
    this.maxPendingPerLane = positiveInteger(
      options.maxPendingPerLane ?? DEFAULT_SESSION_LANE_MAX_PENDING_PER_LANE,
      "maxPendingPerLane",
      this.maxPending
    );
    this.maxPayloadBytes = positiveInteger(
      options.maxPayloadBytes ?? DEFAULT_SESSION_LANE_MAX_PAYLOAD_BYTES,
      "maxPayloadBytes",
      16_777_216
    );
    this.maxPendingBytes = positiveInteger(
      options.maxPendingBytes ?? DEFAULT_SESSION_LANE_MAX_PENDING_BYTES,
      "maxPendingBytes",
      1_073_741_824
    );
    if (this.maxPendingBytes < this.maxPayloadBytes) {
      throw new SessionLaneValidationError("INVALID_OPTION", "maxPendingBytes must be at least maxPayloadBytes");
    }
    this.defaultTimeoutMs = positiveInteger(options.defaultTimeoutMs ?? 120_000, "defaultTimeoutMs", MAX_TIMEOUT_MS);
  }

  status(): SessionLaneSchedulerStatus {
    return {
      lifecycle: this.lifecycle,
      degraded: Boolean(this.degraded),
      degradedError: this.degraded?.message,
      activeJobs: this.active.size,
      lockedLanes: this.lockedLanes.size
    };
  }

  start(): Promise<void> {
    return this.withLifecycle(async () => {
      if (this.lifecycle === "started") return;
      this.assertHealthy();
      await this.withState(async () => {
        const jobs = await this.storeRead("ownership validation", () => this.store.list());
        const validated = this.validateDedicatedStore(jobs);
        const running = validated.filter(({ job }) => job.status === "running");
        for (const { job } of running) {
          const patch = {
            status: "needs-review",
            completedAt: new Date().toISOString(),
            error: "scheduler stopped during execution; outcome is unknown and will not be retried automatically"
          };
          const quarantined = await this.storeWrite(
            "running-job quarantine",
            () => this.store.update(job.id, patch)
          );
          this.validateTransitionResult(quarantined, "running-job quarantine", {
            id: job.id,
            status: "needs-review",
            attempts: job.attempts,
            prior: job,
            patch
          });
        }
        this.lifecycle = "started";
      });
      await this.drain();
    });
  }

  shutdown(): Promise<void> {
    return this.withLifecycle(async () => {
      const logical: Promise<void>[] = [];
      await this.withState(async () => {
        if (this.lifecycle === "stopped") return;
        this.lifecycle = "stopping";
        for (const active of this.active.values()) {
          active.controller.abort(new SessionLaneAbortReason("shutdown"));
          logical.push(active.deferred.promise);
        }
      });
      await Promise.allSettled(logical);
      await this.withState(async () => {
        this.lifecycle = "stopped";
      });
    });
  }

  async submit(
    laneKey: string,
    payload: JsonObject,
    options: SessionLaneSubmitOptions = {}
  ): Promise<JobRecord> {
    validateSessionLaneKey(laneKey);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new SessionLaneValidationError("INVALID_OPTION", "session lane payload must be an object");
    }
    const timeoutMs = positiveInteger(options.timeoutMs ?? this.defaultTimeoutMs, "timeoutMs", MAX_TIMEOUT_MS);
    const id = validateJobId(options.id ?? `lane_job_${randomUUID()}`);
    const requestHash = validateRequestHash(options.requestHash);
    const created = await this.withState(async () => {
      this.assertHealthy();
      const jobs = await this.storeRead("admission read", () => this.store.list());
      const validated = this.validateDedicatedStore(jobs);
      const pending = validated.filter(({ job }) => !TERMINAL_STATUSES.has(job.status));
      if (pending.length >= this.maxPending) {
        throw new SessionLaneAdmissionError("QUEUE_FULL", `session lane queue limit reached (${this.maxPending})`);
      }
      let lanePending = 0;
      let laneSequence = 0;
      let pendingBytes = 0;
      for (const record of validated) {
        if (!TERMINAL_STATUSES.has(record.job.status)) pendingBytes += record.payloadBytes;
        if (record.persisted.laneKey === laneKey) {
          if (!TERMINAL_STATUSES.has(record.job.status)) lanePending += 1;
          laneSequence = Math.max(laneSequence, record.persisted.laneSequence);
        }
      }
      if (lanePending >= this.maxPendingPerLane) {
        throw new SessionLaneAdmissionError(
          "LANE_QUEUE_FULL",
          `session lane ${laneKey} queue limit reached (${this.maxPendingPerLane})`
        );
      }
      const wrapped = persistedPayload(laneKey, laneSequence + 1, payload);
      const payloadBytes = jsonBytes(wrapped, "session lane payload");
      if (payloadBytes > this.maxPayloadBytes) {
        throw new SessionLaneAdmissionError(
          "QUEUE_BYTES_FULL",
          `session lane payload exceeds ${this.maxPayloadBytes} bytes`
        );
      }
      if (pendingBytes + payloadBytes > this.maxPendingBytes) {
        throw new SessionLaneAdmissionError(
          "QUEUE_BYTES_FULL",
          `session lane pending payload limit reached (${this.maxPendingBytes} bytes)`
        );
      }
      const created = await this.storeWrite("admission create", () => this.store.create({
        id,
        status: "queued",
        payload: wrapped,
        requestHash,
        retrySafe: false,
        timeoutMs
      }));
      this.validateTransitionResult(created, "admission", {
        id,
        status: "queued",
        attempts: 0,
        payload: wrapped,
        timeoutMs,
        retrySafe: false,
        requestHash
      });
      return created;
    });
    await this.drain();
    return created;
  }

  async cancel(id: string): Promise<JobRecord> {
    validateJobId(id);
    const action = await this.withState<{
      kind: "job";
      job: JobRecord;
    } | {
      kind: "active";
      active: ActiveLaneJob;
    }>(async () => {
      this.assertHealthy();
      const job = await this.storeRead("cancellation read", () => this.store.get(id));
      if (!job) throw new Error(`session lane job not found: ${id}`);
      validateStoredJob(job, this.maxPayloadBytes);
      if (TERMINAL_STATUSES.has(job.status)) return { kind: "job", job };
      const running = this.active.get(id);
      if (running) {
        running.controller.abort(new SessionLaneAbortReason("cancel"));
        return { kind: "active", active: running };
      }
      if (job.status !== "queued") {
        throw new SessionLaneOwnershipError(`job ${id} is running without scheduler ownership`);
      }
      const patch = {
        status: "cancelled",
        completedAt: new Date().toISOString()
      };
      const cancelled = await this.storeWrite(
        "queued cancellation",
        () => this.store.update(id, patch)
      );
      this.validateTransitionResult(cancelled, "queued cancellation", {
        id,
        status: "cancelled",
        attempts: job.attempts,
        prior: job,
        patch
      });
      return { kind: "job", job: cancelled };
    });
    if (action.kind === "job") {
      await this.drain();
      return action.job;
    }
    await action.active.deferred.promise;
    const terminal = await this.storeRead("terminal cancellation read", () => this.store.get(id));
    if (!terminal) throw new Error(`session lane job disappeared during cancellation: ${id}`);
    validateStoredJob(terminal, this.maxPayloadBytes);
    return terminal;
  }

  async get(id: string): Promise<JobRecord | undefined> {
    return this.store.get(id);
  }

  async list(): Promise<JobRecord[]> {
    return this.store.list();
  }

  async drain(): Promise<void> {
    if (this.lifecycle !== "started" || this.degraded) return;
    if (this.drainPromise) {
      this.drainRequested = true;
      await this.drainPromise;
      return;
    }
    this.drainPromise = (async () => {
      do {
        this.drainRequested = false;
        while (this.lifecycle === "started" && !this.degraded) {
          const claimed = await this.claimOne();
          if (!claimed) break;
          // Let state/control operations that queued during the durable claim
          // observe the reservation before execution is launched.
          await this.stateChain;
          this.runClaimed(claimed);
        }
      } while (this.drainRequested && this.lifecycle === "started" && !this.degraded);
    })().finally(() => {
      this.drainPromise = undefined;
    });
    await this.drainPromise;
  }

  private async claimOne(): Promise<ActiveLaneJob | undefined> {
    return this.withState(async () => {
      if (this.lifecycle !== "started" || this.degraded || this.active.size >= this.concurrency) return undefined;
      const jobs = await this.storeRead("dispatch read", () => this.store.list());
      let validated: ValidatedLaneJob[];
      try {
        validated = this.validateDedicatedStore(jobs);
      } catch (error) {
        throw this.enterDegraded("dispatch ownership validation", error);
      }
      const laneHeads = new Map<string, ValidatedLaneJob>();
      for (const record of validated) {
        if (record.job.status !== "queued") continue;
        const head = laneHeads.get(record.persisted.laneKey);
        if (!head || record.persisted.laneSequence < head.persisted.laneSequence) {
          laneHeads.set(record.persisted.laneKey, record);
        }
      }
      const candidate = [...laneHeads.entries()]
        .filter(([laneKey]) => !this.lockedLanes.has(laneKey))
        .map(([, record]) => record)
        .sort((left, right) => byCreatedAtThenId(left.job, right.job))[0];
      if (!candidate) return undefined;
      const attempt = candidate.job.attempts + 1;
      if (attempt > MAX_ATTEMPTS) {
        throw this.enterDegraded("dispatch attempt validation", new Error(`job ${candidate.job.id} attempt limit exceeded`));
      }
      const patch = {
        status: "running",
        startedAt: new Date().toISOString(),
        attempts: attempt
      };
      const running = await this.storeWrite(
        "queued-job claim",
        () => this.store.update(candidate.job.id, patch)
      );
      const validatedRunning = this.validateTransitionResult(running, "claim", {
        id: candidate.job.id,
        status: "running",
        attempts: attempt,
        prior: candidate.job,
        patch
      });
      const active: ActiveLaneJob = {
        controller: new AbortController(),
        deferred: deferred(),
        job: running,
        laneKey: candidate.persisted.laneKey,
        payload: validatedRunning.persisted,
        logicalSettled: false,
        executionSettled: false
      };
      this.active.set(running.id, active);
      this.lockedLanes.add(active.laneKey);
      return active;
    });
  }

  private runClaimed(active: ActiveLaneJob): void {
    if (active.controller.signal.aborted) {
      const outcome: ExecutionOutcome = {
        kind: "failure",
        error: active.controller.signal.reason
      };
      void this.executionFinished(active)
        .then(() => this.finishLogical(active, outcome))
        .catch((error) => this.failLogicalBookkeeping(active, error));
      return;
    }
    const execution = Promise.resolve().then(() => this.execute(active.payload.input, {
      signal: active.controller.signal,
      job: active.job,
      laneKey: active.laneKey
    }));
    const executionOutcome: Promise<ExecutionOutcome> = execution.then(
      (result) => ({ kind: "success", result }),
      (error) => ({ kind: "failure", error })
    );
    void executionOutcome.then(() => this.executionFinished(active)).catch(() => undefined);

    let rejectAbort!: () => void;
    const aborted = new Promise<ExecutionOutcome>((resolve) => {
      rejectAbort = () => resolve({ kind: "failure", error: active.controller.signal.reason });
      active.controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const timeout = setTimeout(
      () => active.controller.abort(new SessionLaneAbortReason("timeout")),
      active.job.timeoutMs || this.defaultTimeoutMs
    );

    void Promise.race([executionOutcome, aborted])
      .then((outcome) => this.finishLogical(active, outcome))
      .catch((error) => this.failLogicalBookkeeping(active, error))
      .finally(() => {
        clearTimeout(timeout);
        active.controller.signal.removeEventListener("abort", rejectAbort);
      });
  }

  private async finishLogical(active: ActiveLaneJob, outcome: ExecutionOutcome): Promise<void> {
    await this.withState(async () => {
      if (active.logicalSettled) return;
      const patch = this.terminalPatch(active, outcome);
      try {
        const terminal = await this.storeWrite(
          "terminal outcome persistence",
          () => this.store.update(active.job.id, patch)
        );
        this.validateTransitionResult(terminal, "terminal outcome persistence", {
          id: active.job.id,
          status: String(patch.status),
          attempts: active.job.attempts,
          prior: active.job,
          patch
        });
      } catch {
        // Store failure/result validation already entered degraded mode. A
        // failed write leaves durable `running` for fresh-start quarantine;
        // an invalid returned record likewise requires operator inspection.
      }
      active.logicalSettled = true;
      this.active.delete(active.job.id);
      if (active.executionSettled) this.lockedLanes.delete(active.laneKey);
      active.deferred.resolve();
    });
    this.requestDrain();
  }

  private terminalPatch(active: ActiveLaneJob, outcome: ExecutionOutcome): JsonObject {
    if (outcome.kind === "success") {
      return {
        status: "completed",
        completedAt: new Date().toISOString(),
        result: outcome.result
      };
    }
    const reason = active.controller.signal.reason;
    const abortReason = reason instanceof SessionLaneAbortReason ? reason : undefined;
    const status = abortReason?.kind === "cancel"
      ? "cancelled"
      : abortReason
        ? "needs-review"
        : "failed";
    return {
      status,
      completedAt: new Date().toISOString(),
      error: truncateUtf8(errorMessage(outcome.error), MAX_ERROR_BYTES)
    };
  }

  private async executionFinished(active: ActiveLaneJob): Promise<void> {
    await this.withState(async () => {
      active.executionSettled = true;
      if (active.logicalSettled) this.lockedLanes.delete(active.laneKey);
    });
    this.requestDrain();
  }

  private async failLogicalBookkeeping(active: ActiveLaneJob, error: unknown): Promise<void> {
    await this.withState(async () => {
      this.enterDegraded("logical outcome bookkeeping", error);
      active.logicalSettled = true;
      this.active.delete(active.job.id);
      if (active.executionSettled) this.lockedLanes.delete(active.laneKey);
      active.deferred.resolve();
    });
  }

  private validateDedicatedStore(jobs: JobRecord[]): ValidatedLaneJob[] {
    try {
      const validated = jobs.map((job) => validateStoredJob(job, this.maxPayloadBytes));
      const sequences = new Map<string, Set<number>>();
      for (const record of validated) {
        const laneSequences = sequences.get(record.persisted.laneKey) ?? new Set<number>();
        if (laneSequences.has(record.persisted.laneSequence)) {
          throw new SessionLaneValidationError(
            "INVALID_STORED_JOB",
            `lane ${record.persisted.laneKey} contains duplicate sequence ${record.persisted.laneSequence}`
          );
        }
        laneSequences.add(record.persisted.laneSequence);
        sequences.set(record.persisted.laneKey, laneSequences);
      }
      return validated;
    } catch (error) {
      throw new SessionLaneOwnershipError(
        `session lane scheduler requires a dedicated store; no records were changed: ${errorMessage(error)}`
      );
    }
  }

  private validateTransitionResult(
    job: JobRecord,
    operation: string,
    expected: TransitionExpectation
  ): ValidatedLaneJob {
    try {
      const validated = validateStoredJob(job, this.maxPayloadBytes);
      if (job.id !== expected.id || job.status !== expected.status || job.attempts !== expected.attempts) {
        throw new SessionLaneValidationError(
          "INVALID_STORED_JOB",
          `${operation} returned ${job.id}/${job.status}/${job.attempts}; expected ${expected.id}/${expected.status}/${expected.attempts}`
        );
      }
      const schemaVersion = (job as unknown as JsonObject).schemaVersion;
      if (schemaVersion !== 1) {
        throw new SessionLaneValidationError("INVALID_STORED_JOB", `${operation} changed schemaVersion`);
      }
      const prior = expected.prior;
      const immutablePayload = prior?.payload ?? expected.payload;
      const immutableTimeout = prior?.timeoutMs ?? expected.timeoutMs;
      const immutableRetrySafe = prior?.retrySafe ?? expected.retrySafe;
      const immutableRequestHash = prior?.requestHash ?? expected.requestHash;
      if (!isDeepStrictEqual(job.payload, immutablePayload)
        || job.timeoutMs !== immutableTimeout
        || job.retrySafe !== immutableRetrySafe
        || job.requestHash !== immutableRequestHash) {
        throw new SessionLaneValidationError("INVALID_STORED_JOB", `${operation} changed immutable request fields`);
      }
      if (prior) {
        const priorSchemaVersion = (prior as unknown as JsonObject).schemaVersion;
        if (schemaVersion !== priorSchemaVersion
          || job.createdAt !== prior.createdAt
          || String(job.updatedAt).localeCompare(String(prior.updatedAt)) < 0) {
          throw new SessionLaneValidationError("INVALID_STORED_JOB", `${operation} changed immutable envelope fields`);
        }
      }
      const patch = expected.patch ?? {};
      const expectedStartedAt = Object.hasOwn(patch, "startedAt") ? patch.startedAt : prior?.startedAt;
      const expectedCompletedAt = Object.hasOwn(patch, "completedAt") ? patch.completedAt : prior?.completedAt;
      const expectedResult = Object.hasOwn(patch, "result") ? patch.result : prior?.result;
      const expectedError = Object.hasOwn(patch, "error") ? patch.error : prior?.error;
      if (job.startedAt !== expectedStartedAt
        || job.completedAt !== expectedCompletedAt
        || !isDeepStrictEqual(job.result, expectedResult)
        || job.error !== expectedError) {
        throw new SessionLaneValidationError("INVALID_STORED_JOB", `${operation} returned invalid transition state`);
      }
      return validated;
    } catch (error) {
      throw this.enterDegraded(`${operation} result validation`, error);
    }
  }

  private requestDrain(): void {
    void this.drain().catch(() => undefined);
  }

  private assertHealthy(): void {
    if (this.degraded) throw this.degraded;
  }

  private enterDegraded(operation: string, cause: unknown): SessionLaneDegradedError {
    this.degraded ??= cause instanceof SessionLaneDegradedError
      ? cause
      : new SessionLaneDegradedError(operation, cause);
    return this.degraded;
  }

  private async storeRead<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof SessionLaneOwnershipError || error instanceof SessionLaneValidationError) throw error;
      throw this.enterDegraded(operation, error);
    }
  }

  private async storeWrite<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw this.enterDegraded(operation, error);
    }
  }

  private withState<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.stateChain.then(operation);
    this.stateChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleChain.then(operation);
    this.lifecycleChain = result.then(() => undefined, () => undefined);
    return result;
  }
}
