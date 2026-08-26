export const TELEMETRY_SCHEMA_VERSION = 1 as const;
export const TELEMETRY_NAMES = Object.freeze([
  "odinn.runtime.lifecycle",
  "odinn.run.acceptance",
  "odinn.task",
  "odinn.model.request",
  "odinn.tool.execution",
  "odinn.audit.append",
  "odinn.memory.recall",
  "odinn.recovery",
  "odinn.shutdown",
  "odinn.policy.evaluation",
  "odinn.queue.depth",
  "odinn.export.dropped"
] as const);
export const TELEMETRY_ATTRIBUTE_KEYS = Object.freeze([
  "service.name",
  "service.version",
  "component",
  "operation",
  "outcome",
  "provider.id",
  "model.id",
  "tool.name",
  "transport",
  "error.type",
  "http.response.status_code",
  "retryable",
  "duration.ms",
  "item.count",
  "queue.depth"
] as const);

export type TelemetryName = typeof TELEMETRY_NAMES[number];
export type TelemetryAttributeKey = typeof TELEMETRY_ATTRIBUTE_KEYS[number];
export type TelemetryAttributeValue = string | number | boolean;
export type TelemetryAttributes = Partial<Record<TelemetryAttributeKey, TelemetryAttributeValue>>;
export type TelemetryLifecycleState = "disabled" | "running" | "stopping" | "stopped";
export type TelemetryFailureKind = "exporter-error" | "timeout";

type TelemetryCommon = {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  name: TelemetryName;
  timeUnixMs: number;
  attributes: Readonly<TelemetryAttributes>;
};

export type TelemetryEvent = TelemetryCommon & {
  kind: "event";
};

export type TelemetrySpan = TelemetryCommon & {
  kind: "span";
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  durationMs: number;
  status: "ok" | "error" | "unset";
};

export type TelemetryMetric = TelemetryCommon & {
  kind: "metric";
  instrument: "counter" | "gauge" | "histogram";
  value: number;
  unit: "1" | "ms" | "By";
};

export type TelemetryEnvelope = TelemetryEvent | TelemetrySpan | TelemetryMetric;

export interface TelemetryExporter {
  export(
    batch: readonly TelemetryEnvelope[],
    signal: AbortSignal
  ): Promise<TelemetryExportResult | void> | TelemetryExportResult | void;
  shutdown?(signal: AbortSignal): Promise<void> | void;
}

export type TelemetryExportResult = Readonly<{
  exported: number;
  rejected: number;
}>;

export type BufferedTelemetryOptions = {
  enabled?: boolean;
  exporter?: TelemetryExporter;
  maxQueue?: number;
  maxQueueBytes?: number;
  maxBatch?: number;
  maxBatchBytes?: number;
  exportTimeoutMs?: number;
  flushTimeoutMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  autoPump?: boolean;
  now?: () => number;
};

export type TelemetryStatus = {
  state: TelemetryLifecycleState;
  queued: number;
  queuedBytes: number;
  inFlight: number;
  inFlightBytes: number;
  accepted: number;
  exported: number;
  droppedOverflow: number;
  droppedExportFailure: number;
  rejectedInvalid: number;
  rejectedAfterShutdown: number;
  exportFailures: number;
  consecutiveFailures: number;
  lastFailure?: TelemetryFailureKind;
  nextRetryDelayMs?: number;
  exporterState: "idle" | "exporting" | "backing-off" | "wedged";
};

export type TelemetryShutdownResult = {
  flushed: boolean;
  remaining: number;
  exporterShutdown: boolean;
};

const NAME_SET = new Set<string>(TELEMETRY_NAMES);
const ATTRIBUTE_KEY_SET = new Set<string>(TELEMETRY_ATTRIBUTE_KEYS);
const MAX_ATTRIBUTES = TELEMETRY_ATTRIBUTE_KEYS.length;
const MAX_ATTRIBUTE_STRING_BYTES = 128;
const MAX_ABSOLUTE_NUMBER = 1_000_000_000_000_000;
const MAX_QUEUE = 4096;
const MAX_BATCH = 256;
const MAX_RECORD_BYTES = (4 * 1024) - 2;
const MIN_BATCH_BYTES = 256;
const MAX_QUEUE_BYTES = 1024 * 1024;
const MAX_BATCH_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_FUTURE_TIMESTAMP_SKEW_MS = 60_000;
const TRACE_ID = /^[0-9a-f]{32}$/u;
const SPAN_ID = /^[0-9a-f]{16}$/u;
const OPERATIONAL_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u;
const PROVIDER_IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/u;
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)?$/u;
const TOOL_IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const SENSITIVE_LABEL = /(?:^|[._:/+=-])(?:bearer|token|secret|password|api[_-]?key)(?:$|[._:/+=-])/iu;
const JWT_LIKE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u;
const RECOGNIZED_SECRET_VALUES = [
  /^(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,})$/u,
  /^(?:AKIA|ASIA)[A-Z0-9]{16}$/u,
  /^AIza[A-Za-z0-9_-]{30,}$/u,
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/u,
  /^(?:sk|rk)-[A-Za-z0-9_-]{12,}$/u,
  /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}$/u,
  /^mfa\.[A-Za-z0-9_-]{20,}$/u
] as const;
const NUMERIC_ATTRIBUTE_KEYS = new Set([
  "http.response.status_code",
  "duration.ms",
  "item.count",
  "queue.depth"
]);
const EVENT_KEYS = new Set(["name", "timeUnixMs", "attributes"]);
const SPAN_KEYS = new Set([
  "name",
  "timeUnixMs",
  "attributes",
  "traceId",
  "spanId",
  "parentSpanId",
  "durationMs",
  "status"
]);
const METRIC_KEYS = new Set(["name", "timeUnixMs", "attributes", "instrument", "value", "unit"]);

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${label} must be a safe integer from ${minimum} to ${maximum}`);
  }
  return result;
}

function strictObject(value: unknown, label: string, keys: ReadonlySet<string>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.has(key)) throw new Error(`${label} has unknown field: ${key}`);
  }
  return record;
}

function telemetryName(value: unknown): TelemetryName {
  if (typeof value !== "string" || !NAME_SET.has(value)) throw new Error("telemetry name is not allowlisted");
  return value as TelemetryName;
}

function timestamp(value: unknown, now: () => number): number {
  const current = now();
  if (typeof current !== "number" || !Number.isSafeInteger(current) || current < 0) {
    throw new Error("telemetry clock must return a non-negative safe integer");
  }
  const result = value === undefined ? current : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) {
    throw new Error("telemetry timeUnixMs must be a non-negative safe integer");
  }
  if (result > current + MAX_FUTURE_TIMESTAMP_SKEW_MS) {
    throw new Error(`telemetry timeUnixMs exceeds the ${MAX_FUTURE_TIMESTAMP_SKEW_MS} ms future-skew limit`);
  }
  return result;
}

function finiteNumber(value: unknown, label: string, minimum = -MAX_ABSOLUTE_NUMBER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || Math.abs(value) > MAX_ABSOLUTE_NUMBER) {
    throw new Error(`${label} must be a bounded finite number`);
  }
  return value;
}

function attributes(value: unknown): Readonly<TelemetryAttributes> {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("telemetry attributes must be an object");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ATTRIBUTES) throw new Error(`telemetry allows at most ${MAX_ATTRIBUTES} attributes`);
  const normalized: Partial<Record<TelemetryAttributeKey, TelemetryAttributeValue>> = {};
  for (const [key, item] of entries) {
    if (!ATTRIBUTE_KEY_SET.has(key)) throw new Error(`telemetry attribute is not allowlisted: ${key}`);
    if (typeof item === "string") {
      const grammar = key === "provider.id"
        ? PROVIDER_IDENTIFIER
        : key === "model.id"
          ? MODEL_IDENTIFIER
          : key === "tool.name"
            ? TOOL_IDENTIFIER
            : OPERATIONAL_LABEL;
      if (
        NUMERIC_ATTRIBUTE_KEYS.has(key)
        || key === "retryable"
        || !grammar.test(item)
        || SENSITIVE_LABEL.test(item)
        || JWT_LIKE.test(item)
        || RECOGNIZED_SECRET_VALUES.some((pattern) => pattern.test(item))
        || item.includes("://")
        || /^[A-Za-z]:\//u.test(item)
        || item.split("/").some((part) => part === "." || part === "..")
        || Buffer.byteLength(item, "utf8") > MAX_ATTRIBUTE_STRING_BYTES
      ) {
        throw new Error(`telemetry attribute ${key} must be an operational label of at most ${MAX_ATTRIBUTE_STRING_BYTES} UTF-8 bytes`);
      }
    } else if (typeof item === "number") {
      if (!NUMERIC_ATTRIBUTE_KEYS.has(key)) throw new Error(`telemetry attribute ${key} does not accept numbers`);
      finiteNumber(item, `telemetry attribute ${key}`, 0);
      if (["http.response.status_code", "item.count", "queue.depth"].includes(key) && !Number.isSafeInteger(item)) {
        throw new Error(`telemetry attribute ${key} must be a safe integer`);
      }
      if (key === "http.response.status_code" && (item < 100 || item > 599)) {
        throw new Error("telemetry attribute http.response.status_code must be from 100 to 599");
      }
    } else if (typeof item !== "boolean") {
      throw new Error(`telemetry attribute ${key} must be a string, number, or boolean`);
    } else if (key !== "retryable") {
      throw new Error(`telemetry attribute ${key} does not accept booleans`);
    }
    normalized[key as TelemetryAttributeKey] = item as TelemetryAttributeValue;
  }
  return Object.freeze(normalized);
}

function traceIdentifier(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value) || /^0+$/u.test(value)) {
    throw new Error(`${label} must be a lowercase nonzero W3C trace identifier`);
  }
  return value;
}

function freezeEnvelope<T extends TelemetryEnvelope>(envelope: T): T {
  return Object.freeze(envelope);
}

class ExportTimeoutError extends Error {}
type QueuedEnvelope = { envelope: TelemetryEnvelope; bytes: number; sequence: number };

export class BufferedTelemetry {
  readonly enabled: boolean;
  readonly #exporter?: TelemetryExporter;
  readonly #maxQueue: number;
  readonly #maxQueueBytes: number;
  readonly #maxBatch: number;
  readonly #maxBatchBytes: number;
  readonly #exportTimeoutMs: number;
  readonly #flushTimeoutMs: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #autoPump: boolean;
  readonly #now: () => number;
  readonly #queue: QueuedEnvelope[] = [];
  #queueBytes = 0;
  #state: TelemetryLifecycleState;
  #inFlight = 0;
  #inFlightBytes = 0;
  #accepted = 0;
  #settledThrough = 0;
  #firstFailedSequence?: number;
  #exported = 0;
  #droppedOverflow = 0;
  #droppedExportFailure = 0;
  #rejectedInvalid = 0;
  #rejectedAfterShutdown = 0;
  #exportFailures = 0;
  #consecutiveFailures = 0;
  #lastFailure?: TelemetryFailureKind;
  #scheduled = false;
  #backoffTimer?: ReturnType<typeof setTimeout>;
  #retryDelay?: number;
  #physicalExportPromise?: Promise<TelemetryExportResult | void>;
  #wedged = false;
  #pumpPromise?: Promise<void>;
  #shutdownPromise?: Promise<TelemetryShutdownResult>;

  constructor(options: BufferedTelemetryOptions = {}) {
    this.enabled = options.enabled === true;
    if (this.enabled && !options.exporter) throw new Error("enabled telemetry requires an exporter");
    if (this.enabled && typeof options.exporter?.export !== "function") {
      throw new Error("enabled telemetry exporter requires an export function");
    }
    this.#exporter = options.exporter;
    this.#maxQueue = boundedInteger(options.maxQueue, 512, 1, MAX_QUEUE, "telemetry maxQueue");
    this.#maxQueueBytes = boundedInteger(options.maxQueueBytes, MAX_QUEUE_BYTES, MAX_RECORD_BYTES, MAX_QUEUE_BYTES, "telemetry maxQueueBytes");
    this.#maxBatch = boundedInteger(options.maxBatch, 64, 1, Math.min(MAX_BATCH, this.#maxQueue), "telemetry maxBatch");
    this.#maxBatchBytes = boundedInteger(
      options.maxBatchBytes,
      Math.min(MAX_BATCH_BYTES, this.#maxQueueBytes),
      MIN_BATCH_BYTES,
      Math.min(MAX_BATCH_BYTES, this.#maxQueueBytes),
      "telemetry maxBatchBytes"
    );
    this.#exportTimeoutMs = boundedInteger(options.exportTimeoutMs, 2_000, 10, MAX_TIMEOUT_MS, "telemetry exportTimeoutMs");
    this.#flushTimeoutMs = boundedInteger(
      options.flushTimeoutMs,
      Math.max(5_000, this.#exportTimeoutMs),
      this.#exportTimeoutMs,
      MAX_TIMEOUT_MS,
      "telemetry flushTimeoutMs"
    );
    this.#baseBackoffMs = boundedInteger(options.baseBackoffMs, 250, 10, MAX_BACKOFF_MS, "telemetry baseBackoffMs");
    this.#maxBackoffMs = boundedInteger(options.maxBackoffMs, 30_000, this.#baseBackoffMs, MAX_BACKOFF_MS, "telemetry maxBackoffMs");
    this.#autoPump = options.autoPump !== false;
    this.#now = options.now ?? Date.now;
    if (typeof this.#now !== "function") throw new Error("telemetry now must be a function");
    this.#state = this.enabled ? "running" : "disabled";
  }

  recordEvent(input: {
    name: TelemetryName;
    timeUnixMs?: number;
    attributes?: TelemetryAttributes;
  }): boolean {
    if (!this.#canRecord()) return false;
    try {
      const value = strictObject(input, "telemetry event", EVENT_KEYS);
      return this.#enqueue(freezeEnvelope({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      kind: "event",
      name: telemetryName(value.name),
      timeUnixMs: timestamp(value.timeUnixMs, this.#now),
      attributes: attributes(value.attributes)
      }));
    } catch (error) {
      this.#rejectedInvalid += 1;
      throw error;
    }
  }

  recordSpan(input: {
    name: TelemetryName;
    timeUnixMs?: number;
    attributes?: TelemetryAttributes;
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    durationMs: number;
    status?: "ok" | "error" | "unset";
  }): boolean {
    if (!this.#canRecord()) return false;
    try {
      const value = strictObject(input, "telemetry span", SPAN_KEYS);
      const status = value.status ?? "unset";
      if (!["ok", "error", "unset"].includes(String(status))) throw new Error("telemetry span status is invalid");
      return this.#enqueue(freezeEnvelope({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      kind: "span",
      name: telemetryName(value.name),
      timeUnixMs: timestamp(value.timeUnixMs, this.#now),
      attributes: attributes(value.attributes),
      traceId: traceIdentifier(value.traceId, TRACE_ID, "telemetry traceId"),
      spanId: traceIdentifier(value.spanId, SPAN_ID, "telemetry spanId"),
      ...(value.parentSpanId === undefined ? {} : {
        parentSpanId: traceIdentifier(value.parentSpanId, SPAN_ID, "telemetry parentSpanId")
      }),
      durationMs: finiteNumber(value.durationMs, "telemetry span durationMs", 0),
      status: status as "ok" | "error" | "unset"
      }));
    } catch (error) {
      this.#rejectedInvalid += 1;
      throw error;
    }
  }

  recordMetric(input: {
    name: TelemetryName;
    timeUnixMs?: number;
    attributes?: TelemetryAttributes;
    instrument: "counter" | "gauge" | "histogram";
    value: number;
    unit: "1" | "ms" | "By";
  }): boolean {
    if (!this.#canRecord()) return false;
    try {
      const value = strictObject(input, "telemetry metric", METRIC_KEYS);
      if (!["counter", "gauge", "histogram"].includes(String(value.instrument))) {
        throw new Error("telemetry metric instrument is invalid");
      }
      if (!["1", "ms", "By"].includes(String(value.unit))) throw new Error("telemetry metric unit is invalid");
      return this.#enqueue(freezeEnvelope({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      kind: "metric",
      name: telemetryName(value.name),
      timeUnixMs: timestamp(value.timeUnixMs, this.#now),
      attributes: attributes(value.attributes),
      instrument: value.instrument as "counter" | "gauge" | "histogram",
      value: finiteNumber(value.value, "telemetry metric value"),
      unit: value.unit as "1" | "ms" | "By"
      }));
    } catch (error) {
      this.#rejectedInvalid += 1;
      throw error;
    }
  }

  status(): TelemetryStatus {
    return Object.freeze({
      state: this.#state,
      queued: this.#queue.length,
      queuedBytes: this.#queueBytes,
      inFlight: this.#inFlight,
      inFlightBytes: this.#inFlightBytes,
      accepted: this.#accepted,
      exported: this.#exported,
      droppedOverflow: this.#droppedOverflow,
      droppedExportFailure: this.#droppedExportFailure,
      rejectedInvalid: this.#rejectedInvalid,
      rejectedAfterShutdown: this.#rejectedAfterShutdown,
      exportFailures: this.#exportFailures,
      consecutiveFailures: this.#consecutiveFailures,
      ...(this.#lastFailure ? { lastFailure: this.#lastFailure } : {}),
      ...(this.#retryDelay !== undefined ? { nextRetryDelayMs: this.#retryDelay } : {}),
      exporterState: this.#wedged
        ? "wedged"
        : this.#physicalExportPromise
          ? "exporting"
          : this.#backoffTimer
            ? "backing-off"
            : "idle"
    });
  }

  async flush(): Promise<boolean> {
    if (!this.enabled) return true;
    if (this.#state === "stopped") {
      return this.#queue.length === 0
        && (this.#firstFailedSequence === undefined || this.#firstFailedSequence > this.#accepted);
    }
    this.#clearBackoff();
    return this.#flushWithin(Date.now() + this.#flushTimeoutMs);
  }

  shutdown(): Promise<TelemetryShutdownResult> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    if (!this.enabled) {
      this.#state = "stopped";
      this.#shutdownPromise = Promise.resolve(Object.freeze({
        flushed: true,
        remaining: 0,
        exporterShutdown: true
      }));
      return this.#shutdownPromise;
    }
    this.#state = "stopping";
    this.#clearBackoff();
    this.#shutdownPromise = this.#finishShutdown();
    return this.#shutdownPromise;
  }

  #canRecord(): boolean {
    if (!this.enabled) return false;
    if (this.#state !== "running") {
      this.#rejectedAfterShutdown += 1;
      return false;
    }
    return true;
  }

  #enqueue(envelope: TelemetryEnvelope): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
    if (bytes > MAX_RECORD_BYTES) throw new Error(`telemetry record exceeds ${MAX_RECORD_BYTES} UTF-8 bytes`);
    if (
      bytes + 2 > this.#maxBatchBytes
      ||
      this.#queue.length + this.#inFlight >= this.#maxQueue
      || this.#queueBytes + this.#inFlightBytes + bytes > this.#maxQueueBytes
    ) {
      this.#droppedOverflow += 1;
      return false;
    }
    this.#accepted += 1;
    this.#queue.push({ envelope, bytes, sequence: this.#accepted });
    this.#queueBytes += bytes;
    if (this.#autoPump) this.#schedulePump();
    return true;
  }

  #schedulePump(delay = 0): void {
    if (
      this.#state !== "running"
      || this.#scheduled
      || this.#pumpPromise
      || this.#physicalExportPromise
      || (!this.#queue.length && delay <= 0)
    ) return;
    this.#scheduled = true;
    const run = () => {
      this.#backoffTimer = undefined;
      this.#scheduled = false;
      void this.#runPump().catch(() => {});
    };
    if (delay <= 0) queueMicrotask(run);
    else {
      this.#backoffTimer = setTimeout(run, delay);
      this.#backoffTimer.unref?.();
    }
  }

  #clearBackoff(): void {
    if (this.#backoffTimer) clearTimeout(this.#backoffTimer);
    this.#backoffTimer = undefined;
    this.#scheduled = false;
  }

  #runPump(): Promise<void> {
    return this.#runPumpWithTimeout(this.#exportTimeoutMs);
  }

  #runPumpWithTimeout(timeoutMs: number): Promise<void> {
    if (this.#pumpPromise) return this.#pumpPromise;
    if (this.#physicalExportPromise) return Promise.resolve();
    this.#pumpPromise = this.#drainOne(timeoutMs).finally(() => {
      this.#pumpPromise = undefined;
      if (this.#retryDelay !== undefined && this.#state === "running" && this.#autoPump) {
        if (!this.#physicalExportPromise) {
          const delay = this.#retryDelay;
          this.#retryDelay = undefined;
          this.#schedulePump(delay);
        }
      } else if (this.#queue.length && this.#state === "running" && this.#autoPump) {
        this.#schedulePump();
      }
    });
    return this.#pumpPromise;
  }

  async #drainOne(timeoutMs: number): Promise<void> {
    if (!this.#queue.length || this.#physicalExportPromise) return;
    const queuedBatch: QueuedEnvelope[] = [];
    let recordBytes = 0;
    let serializedBatchBytes = 2;
    while (queuedBatch.length < this.#maxBatch && this.#queue.length) {
      const next = this.#queue[0];
      const addedBytes = next.bytes + (queuedBatch.length ? 1 : 0);
      if (serializedBatchBytes + addedBytes > this.#maxBatchBytes) break;
      queuedBatch.push(this.#queue.shift()!);
      recordBytes += next.bytes;
      serializedBatchBytes += addedBytes;
    }
    if (!queuedBatch.length) throw new Error("telemetry admission invariant produced an oversized batch record");
    this.#queueBytes -= recordBytes;
    const batch = queuedBatch.map((item) => item.envelope);
    this.#inFlight = batch.length;
    this.#inFlightBytes = recordBytes;
    try {
      const result = await this.#exportBatch(Object.freeze([...batch]), timeoutMs);
      const exported = result?.exported ?? batch.length;
      const rejected = result?.rejected ?? 0;
      if (
        !Number.isSafeInteger(exported)
        || !Number.isSafeInteger(rejected)
        || exported < 0
        || rejected < 0
        || exported + rejected !== batch.length
      ) {
        throw new Error("telemetry exporter returned an invalid settlement result");
      }
      this.#exported += exported;
      this.#droppedExportFailure += rejected;
      this.#settledThrough = queuedBatch.at(-1)!.sequence;
      if (rejected > 0) {
        this.#firstFailedSequence ??= queuedBatch[0].sequence;
        this.#exportFailures += 1;
        this.#consecutiveFailures += 1;
        this.#lastFailure = "exporter-error";
        if (this.#state === "running" && this.#autoPump) {
          const exponent = Math.min(this.#consecutiveFailures - 1, 16);
          this.#retryDelay = Math.min(this.#maxBackoffMs, this.#baseBackoffMs * (2 ** exponent));
        }
      } else {
        this.#consecutiveFailures = 0;
        this.#lastFailure = undefined;
        this.#retryDelay = undefined;
      }
    } catch (error) {
      this.#droppedExportFailure += batch.length;
      this.#settledThrough = queuedBatch.at(-1)!.sequence;
      this.#firstFailedSequence ??= queuedBatch[0].sequence;
      this.#exportFailures += 1;
      this.#consecutiveFailures += 1;
      this.#lastFailure = error instanceof ExportTimeoutError ? "timeout" : "exporter-error";
      if (this.#state === "running" && this.#autoPump) {
        const exponent = Math.min(this.#consecutiveFailures - 1, 16);
        this.#retryDelay = Math.min(this.#maxBackoffMs, this.#baseBackoffMs * (2 ** exponent));
      }
    } finally {
      this.#inFlight = 0;
      this.#inFlightBytes = 0;
    }
  }

  async #exportBatch(batch: readonly TelemetryEnvelope[], timeoutMs: number): Promise<TelemetryExportResult | void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let physicallySettled = false;
    const physical = Promise.resolve().then(() => this.#exporter!.export(batch, controller.signal));
    this.#physicalExportPromise = physical;
    void physical.then(
      () => this.#physicalExportSettled(physical),
      () => this.#physicalExportSettled(physical)
    );
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (!physicallySettled) {
          this.#wedged = true;
          controller.abort(new ExportTimeoutError("telemetry exporter timed out"));
        }
        reject(new ExportTimeoutError("telemetry exporter timed out"));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        physical.then((result) => {
          physicallySettled = true;
          return result;
        }),
        timeout
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #physicalExportSettled(physical: Promise<TelemetryExportResult | void>): void {
    if (this.#physicalExportPromise !== physical) return;
    this.#physicalExportPromise = undefined;
    const wasWedged = this.#wedged;
    this.#wedged = false;
    if (wasWedged) {
      const delay = this.#retryDelay ?? this.#baseBackoffMs;
      this.#retryDelay = undefined;
      if (this.#state === "running" && this.#autoPump) {
        this.#schedulePump(delay);
      }
    }
  }

  async #callWithTimeout(
    operation: (signal: AbortSignal) => Promise<void> | void,
    timeoutMs: number
  ): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new ExportTimeoutError("telemetry exporter timed out"));
        reject(new ExportTimeoutError("telemetry exporter timed out"));
      }, timeoutMs);
    });
    try {
      await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        timeout
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #finishShutdown(): Promise<TelemetryShutdownResult> {
    const deadline = Date.now() + this.#flushTimeoutMs;
    const flushed = await this.#flushWithin(deadline);
    let exporterShutdown = true;
    if (this.#physicalExportPromise) exporterShutdown = false;
    else if (this.#exporter?.shutdown) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) exporterShutdown = false;
      else try {
        await this.#callWithTimeout(
          (signal) => this.#exporter!.shutdown!(signal),
          Math.min(this.#exportTimeoutMs, remainingMs)
        );
      } catch {
        exporterShutdown = false;
      }
    }
    this.#state = "stopped";
    return Object.freeze({
      flushed,
      remaining: this.#queue.length,
      exporterShutdown
    });
  }

  async #flushWithin(deadline: number): Promise<boolean> {
    const watermark = this.#accepted;
    while (this.#settledThrough < watermark) {
      if (this.#wedged || this.#physicalExportPromise && !this.#pumpPromise) return false;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      const failuresBefore = this.#exportFailures;
      await this.#runPumpWithTimeout(Math.min(this.#exportTimeoutMs, remainingMs));
      if (this.#exportFailures > failuresBefore) return false;
    }
    return this.#firstFailedSequence === undefined || this.#firstFailedSequence > watermark;
  }
}

export function createBufferedTelemetry(options: BufferedTelemetryOptions = {}): BufferedTelemetry {
  return new BufferedTelemetry(options);
}
