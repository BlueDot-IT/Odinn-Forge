import { createHash } from "node:crypto";

export const AUTOMATION_SCHEMA_VERSION = 1 as const;
export const ODINN_AGENT_CONTROL_VERSION = 1 as const;
export const MAX_AUTOMATION_MATCH_CLAUSES = 16;
export const MAX_AUTOMATION_SET_VALUES = 16;
export const MAX_AUTOMATION_ATTRIBUTES = 32;
export const MAX_AUTOMATION_INTERVAL_MS = 31_536_000_000;
export const MIN_AUTOMATION_INTERVAL_MS = 1_000;
export const MAX_AUTOMATION_UNIX_MS = 8_640_000_000_000_000;
export const MAX_AUTOMATION_INPUT_BYTES = 16_384;
export const MAX_AUTOMATION_INPUT_NODES = 256;
export const MAX_ODINN_CONTROL_HISTORY = 16;

type Scalar = string | number | boolean;
type MatchClause =
  | { field: string; operator: "eq"; value: Scalar }
  | { field: string; operator: "prefix"; value: string }
  | { field: string; operator: "in"; values: readonly Scalar[] };

type CommonDeclaration = {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION;
  id: string;
  revision: number;
  enabled: boolean;
  actionRef: string;
  declarationDigest: string;
};

export type ScheduleAutomationDeclaration = CommonDeclaration & {
  kind: "schedule";
  schedule:
    | { type: "at"; atUnixMs: number }
    | { type: "interval"; anchorUnixMs: number; everyMs: number };
};

export type EventAutomationDeclaration = CommonDeclaration & {
  kind: "event";
  source: string;
  event: string;
  match: readonly MatchClause[];
};

export type AutomationDeclaration = ScheduleAutomationDeclaration | EventAutomationDeclaration;

export type AutomationEvent = {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION;
  source: string;
  event: string;
  sequence: number;
  cursor: string;
  occurredAtUnixMs: number;
  attributes: Readonly<Record<string, Scalar>>;
};

export type AutomationCandidate = {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION;
  candidateId: string;
  declarationId: string;
  declarationRevision: number;
  declarationDigest: string;
  actionRef: string;
  trigger: "schedule" | "event";
  occurrenceUnixMs: number;
  cursor?: string;
  sequence?: number;
  eventSource?: string;
  idempotencyKey: string;
  authorized: false;
  requiresAuditedDispatch: true;
};

export type OdinnAgentControlEnvelope =
  | {
      version: typeof ODINN_AGENT_CONTROL_VERSION;
      kind: "dispatch";
      id: string;
      correlationId: string;
      agentId: string;
      issuedAtUnixMs: number;
      candidate: AutomationCandidate;
    }
  | {
      version: typeof ODINN_AGENT_CONTROL_VERSION;
      kind: "cancel";
      id: string;
      correlationId: string;
      agentId: string;
      issuedAtUnixMs: number;
      dispatchId: string;
      reason: "operator-request" | "superseded" | "shutdown" | "policy";
    }
  | {
      version: typeof ODINN_AGENT_CONTROL_VERSION;
      kind: "status";
      id: string;
      correlationId: string;
      agentId: string;
      issuedAtUnixMs: number;
      dispatchId: string;
      state: "queued" | "awaiting-approval" | "running" | "cancelling";
    }
  | {
      version: typeof ODINN_AGENT_CONTROL_VERSION;
      kind: "result";
      id: string;
      correlationId: string;
      agentId: string;
      issuedAtUnixMs: number;
      dispatchId: string;
      outcome: "completed" | "failed" | "cancelled" | "needs-review";
      resultRef?: string;
    };

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ACTION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const COMMON_KEYS = new Set(["schemaVersion", "id", "revision", "enabled", "actionRef", "kind", "declarationDigest"]);
const CONTROL_COMMON_KEYS = ["version", "kind", "id", "correlationId", "agentId", "issuedAtUnixMs"];
const CONTROL_KEYS = {
  dispatch: new Set([...CONTROL_COMMON_KEYS, "candidate"]),
  cancel: new Set([...CONTROL_COMMON_KEYS, "dispatchId", "reason"]),
  status: new Set([...CONTROL_COMMON_KEYS, "dispatchId", "state"]),
  result: new Set([...CONTROL_COMMON_KEYS, "dispatchId", "outcome", "resultRef"])
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (value === Object.prototype || (prototype !== Object.prototype && prototype !== null)) throw new Error(`${label} must be a plain object`);
  const clean: Record<string, unknown> = Object.create(null);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64) throw new Error(`${label} has too many fields`);
  for (const key of keys) {
    if (typeof key !== "string") throw new Error(`${label} cannot contain symbol fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) throw new Error(`${label} cannot contain accessors`);
    if (!descriptor.enumerable) throw new Error(`${label} cannot contain non-enumerable fields`);
    clean[key] = descriptor.value;
  }
  return clean;
}

function exact(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} has unknown field: ${key}`);
}

function token(value: unknown, label: string): string {
  if (typeof value !== "string" || !TOKEN.test(value)) throw new Error(`${label} must be a bounded identifier`);
  return value;
}

function action(value: unknown): string {
  if (typeof value !== "string" || !ACTION.test(value)) throw new Error("actionRef must be a bounded action identifier");
  return value;
}

function uint(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function unixMs(value: unknown, label: string): number {
  const result = uint(value, label);
  if (result > MAX_AUTOMATION_UNIX_MS) throw new Error(`${label} exceeds the ECMAScript date range`);
  return result;
}

function boundedJson(input: unknown, label: string): unknown {
  let nodes = 0;
  const visit = (value: unknown, path: string): unknown => {
    nodes += 1;
    if (nodes > MAX_AUTOMATION_INPUT_NODES) throw new Error(`${label} exceeds ${MAX_AUTOMATION_INPUT_NODES} JSON nodes`);
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new Error(`${path} number must be a safe integer`);
      return value;
    }
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${path} must be an ordinary array`);
      if (value.length > MAX_AUTOMATION_INPUT_NODES) throw new Error(`${path} array is too long`);
      const keys = Reflect.ownKeys(value);
      const expected = [...Array.from({ length: value.length }, (_, index) => String(index)), "length"];
      if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
        throw new Error(`${path} array must contain only dense canonical indices`);
      }
      const clean: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
          throw new Error(`${path} array entries must be enumerable data properties`);
        }
        clean.push(visit(descriptor.value, `${path}[${index}]`));
      }
      return clean;
    }
    const source = object(value, path);
    const clean: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(source)) clean[key] = visit(item, `${path}.${key}`);
    return clean;
  };
  const clean = visit(input, label);
  if (Buffer.byteLength(stableJson(clean), "utf8") > MAX_AUTOMATION_INPUT_BYTES) {
    throw new Error(`${label} exceeds ${MAX_AUTOMATION_INPUT_BYTES} canonical JSON bytes`);
  }
  return clean;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function scalar(value: unknown, label: string): Scalar {
  if (typeof value === "string") {
    if (value.length === 0 || Buffer.byteLength(value, "utf8") > 256) throw new Error(`${label} string must contain 1-256 UTF-8 bytes`);
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "boolean") return value;
  throw new Error(`${label} must be a bounded string, safe integer, or boolean`);
}

function freeze<T extends object>(value: T): Readonly<T> {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) freeze(nested);
  }
  return Object.freeze(value);
}

function common(value: Record<string, unknown>): CommonDeclaration {
  if (value.schemaVersion !== AUTOMATION_SCHEMA_VERSION) throw new Error("automation declaration has an unsupported schemaVersion");
  if (typeof value.enabled !== "boolean") throw new Error("automation declaration enabled must be boolean");
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: token(value.id, "automation declaration id"),
    revision: positive(value.revision, "automation declaration revision"),
    enabled: value.enabled,
    actionRef: action(value.actionRef),
    declarationDigest: ""
  };
}

function positive(value: unknown, label: string): number {
  const result = uint(value, label);
  if (result === 0) throw new Error(`${label} must be positive`);
  return result;
}

export function validateAutomationDeclaration(input: unknown): AutomationDeclaration {
  const value = object(boundedJson(input, "automation declaration"), "automation declaration");
  const finalize = <T extends Omit<AutomationDeclaration, "declarationDigest">>(normalized: T): AutomationDeclaration => {
    const declarationDigest = digest(normalized);
    if (value.declarationDigest !== undefined && value.declarationDigest !== declarationDigest) {
      throw new Error("automation declaration digest is invalid");
    }
    return freeze({ ...normalized, declarationDigest }) as unknown as AutomationDeclaration;
  };
  if (value.kind === "schedule") {
    exact(value, new Set([...COMMON_KEYS, "schedule"]), "schedule automation declaration");
    const schedule = object(value.schedule, "schedule");
    if (schedule.type === "at") {
      exact(schedule, new Set(["type", "atUnixMs"]), "at schedule");
      const base = common(value);
      const { declarationDigest: _, ...identity } = base;
      return finalize({ ...identity, kind: "schedule", schedule: { type: "at", atUnixMs: unixMs(schedule.atUnixMs, "atUnixMs") } });
    }
    if (schedule.type === "interval") {
      exact(schedule, new Set(["type", "anchorUnixMs", "everyMs"]), "interval schedule");
      const everyMs = uint(schedule.everyMs, "everyMs");
      if (everyMs < MIN_AUTOMATION_INTERVAL_MS || everyMs > MAX_AUTOMATION_INTERVAL_MS) {
        throw new Error(`everyMs must be between ${MIN_AUTOMATION_INTERVAL_MS} and ${MAX_AUTOMATION_INTERVAL_MS}`);
      }
      const base = common(value);
      const { declarationDigest: _, ...identity } = base;
      return finalize({
        ...identity,
        kind: "schedule",
        schedule: { type: "interval", anchorUnixMs: unixMs(schedule.anchorUnixMs, "anchorUnixMs"), everyMs }
      });
    }
    throw new Error("schedule type must be at or interval");
  }
  if (value.kind === "event") {
    exact(value, new Set([...COMMON_KEYS, "source", "event", "match"]), "event automation declaration");
    if (!Array.isArray(value.match) || value.match.length > MAX_AUTOMATION_MATCH_CLAUSES) {
      throw new Error(`event match must contain at most ${MAX_AUTOMATION_MATCH_CLAUSES} clauses`);
    }
    const match = value.match.map((entry, index): MatchClause => {
      const clause = object(entry, `event match clause ${index + 1}`);
      const field = token(clause.field, `event match clause ${index + 1} field`);
      if (clause.operator === "eq") {
        exact(clause, new Set(["field", "operator", "value"]), `event match clause ${index + 1}`);
        return { field, operator: "eq", value: scalar(clause.value, "match value") };
      }
      if (clause.operator === "prefix") {
        exact(clause, new Set(["field", "operator", "value"]), `event match clause ${index + 1}`);
        const prefix = scalar(clause.value, "prefix value");
        if (typeof prefix !== "string") throw new Error("prefix value must be a string");
        return { field, operator: "prefix", value: prefix };
      }
      if (clause.operator === "in") {
        exact(clause, new Set(["field", "operator", "values"]), `event match clause ${index + 1}`);
        if (!Array.isArray(clause.values) || clause.values.length === 0 || clause.values.length > MAX_AUTOMATION_SET_VALUES) {
          throw new Error(`in operator requires 1-${MAX_AUTOMATION_SET_VALUES} values`);
        }
        const values = clause.values.map((item) => scalar(item, "match set value")).sort(compareScalar);
        if (new Set(values.map(scalarKey)).size !== values.length) throw new Error("in operator contains duplicate values");
        return { field, operator: "in", values };
      }
      throw new Error("event match operator must be eq, prefix, or in");
    });
    match.sort((left, right) => compareUtf8(left.field, right.field) || compareUtf8(left.operator, right.operator));
    const clauseKeys = match.map((clause) => `${clause.field}\n${clause.operator}`);
    if (new Set(clauseKeys).size !== clauseKeys.length) throw new Error("event match contains semantically duplicate clauses");
    const base = common(value);
    const { declarationDigest: _, ...identity } = base;
    return finalize({
      ...identity,
      kind: "event",
      source: token(value.source, "event source"),
      event: token(value.event, "event name"),
      match
    });
  }
  throw new Error("automation declaration kind must be schedule or event");
}

function scalarKey(value: Scalar): string {
  return `${typeof value}:${String(value)}`;
}

function compareScalar(left: Scalar, right: Scalar): number {
  return compareUtf8(scalarKey(left), scalarKey(right));
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function nextAutomationDue(input: unknown, afterUnixMs: number): number | null {
  const declaration = validateAutomationDeclaration(input);
  const after = unixMs(afterUnixMs, "afterUnixMs");
  if (declaration.kind !== "schedule") throw new Error("next-due calculation requires a schedule declaration");
  if (!declaration.enabled) return null;
  if (declaration.schedule.type === "at") return declaration.schedule.atUnixMs > after ? declaration.schedule.atUnixMs : null;
  const { anchorUnixMs, everyMs } = declaration.schedule;
  if (anchorUnixMs > after) return anchorUnixMs;
  const intervals = Math.floor((after - anchorUnixMs) / everyMs) + 1;
  const next = anchorUnixMs + intervals * everyMs;
  if (!Number.isSafeInteger(next)) throw new Error("next schedule occurrence exceeds safe integer range");
  if (next > MAX_AUTOMATION_UNIX_MS) return null;
  return next;
}

export function formatAutomationCursor(source: string, sequence: number): string {
  return `odinn-event-v1/${token(source, "event source")}/${uint(sequence, "event sequence")}`;
}

export function validateAutomationEvent(input: unknown): AutomationEvent {
  const value = object(boundedJson(input, "automation event"), "automation event");
  exact(value, new Set(["schemaVersion", "source", "event", "sequence", "cursor", "occurredAtUnixMs", "attributes"]), "automation event");
  if (value.schemaVersion !== AUTOMATION_SCHEMA_VERSION) throw new Error("automation event has an unsupported schemaVersion");
  const source = token(value.source, "event source");
  const sequence = uint(value.sequence, "event sequence");
  if (value.cursor !== formatAutomationCursor(source, sequence)) throw new Error("automation event cursor does not match source and sequence");
  const rawAttributes = object(value.attributes, "automation event attributes");
  if (Object.keys(rawAttributes).length > MAX_AUTOMATION_ATTRIBUTES) {
    throw new Error(`automation event allows at most ${MAX_AUTOMATION_ATTRIBUTES} attributes`);
  }
  const attributes: Record<string, Scalar> = {};
  for (const [key, item] of Object.entries(rawAttributes)) {
    const name = token(key, "event attribute name");
    if (name === "__proto__" || name === "prototype" || name === "constructor") {
      throw new Error("event attribute name is reserved");
    }
    attributes[name] = scalar(item, `event attribute ${key}`);
  }
  return freeze({
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    source,
    event: token(value.event, "event name"),
    sequence,
    cursor: value.cursor,
    occurredAtUnixMs: unixMs(value.occurredAtUnixMs, "occurredAtUnixMs"),
    attributes
  });
}

function candidate(fields: Omit<AutomationCandidate, "schemaVersion" | "candidateId" | "idempotencyKey" | "authorized" | "requiresAuditedDispatch">): AutomationCandidate {
  const binding = [
    AUTOMATION_SCHEMA_VERSION,
    fields.declarationId,
    fields.declarationRevision,
    fields.declarationDigest,
    fields.actionRef,
    fields.trigger,
    fields.occurrenceUnixMs,
    fields.cursor ?? "",
    fields.sequence ?? "",
    fields.eventSource ?? ""
  ].join("\n");
  const digest = createHash("sha256").update(binding).digest("hex");
  return freeze({
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    candidateId: `candidate-${digest}`,
    ...fields,
    idempotencyKey: `automation-${digest}`,
    authorized: false,
    requiresAuditedDispatch: true
  });
}

export function createScheduleCandidate(input: unknown, occurrenceUnixMs: number): AutomationCandidate | null {
  const declaration = validateAutomationDeclaration(input);
  const occurrence = unixMs(occurrenceUnixMs, "occurrenceUnixMs");
  if (declaration.kind !== "schedule") throw new Error("schedule candidate requires a schedule declaration");
  if (!declaration.enabled) return null;
  const isOccurrence = declaration.schedule.type === "at"
    ? declaration.schedule.atUnixMs === occurrence
    : occurrence >= declaration.schedule.anchorUnixMs
      && (occurrence - declaration.schedule.anchorUnixMs) % declaration.schedule.everyMs === 0;
  if (!isOccurrence) throw new Error("occurrenceUnixMs is not an occurrence of this schedule");
  return candidate({
    declarationId: declaration.id,
    declarationRevision: declaration.revision,
    declarationDigest: declaration.declarationDigest,
    actionRef: declaration.actionRef,
    trigger: "schedule",
    occurrenceUnixMs: occurrence
  });
}

export function matchAutomationEvent(
  declarationInput: unknown,
  eventInput: unknown,
  window: {
    source: string;
    oldestAvailableSequence: number;
    oldestAvailableCursor: string;
    newestAvailableSequence: number;
    newestAvailableCursor: string;
    afterCursor?: string;
  }
): AutomationCandidate | null {
  const declaration = validateAutomationDeclaration(declarationInput);
  const event = validateAutomationEvent(eventInput);
  const bounds = object(boundedJson(window, "event replay window"), "event replay window");
  exact(bounds, new Set(["source", "oldestAvailableSequence", "oldestAvailableCursor", "newestAvailableSequence", "newestAvailableCursor", "afterCursor"]), "event replay window");
  const source = token(bounds.source, "event replay window source");
  const oldest = uint(bounds.oldestAvailableSequence, "oldestAvailableSequence");
  const newest = uint(bounds.newestAvailableSequence, "newestAvailableSequence");
  if (oldest > newest) throw new Error("event replay window is invalid");
  if (bounds.oldestAvailableCursor !== formatAutomationCursor(source, oldest)
    || bounds.newestAvailableCursor !== formatAutomationCursor(source, newest)) {
    throw new Error("event replay window cursor does not bind source and sequence");
  }
  if (source !== event.source) throw new Error("event replay window source does not match event source");
  if (bounds.afterCursor !== undefined) {
    if (typeof bounds.afterCursor !== "string") throw new Error("event replay afterCursor must be a string");
    const expectedAfter = event.sequence === 0 ? null : formatAutomationCursor(source, event.sequence - 1);
    if (bounds.afterCursor !== expectedAfter) throw new Error("automation event is duplicate or out of order");
  }
  if (event.sequence < oldest) throw new Error("automation event cursor is stale");
  if (event.sequence > newest) throw new Error("automation event cursor is in the future");
  if (declaration.kind !== "event") throw new Error("event matching requires an event declaration");
  if (!declaration.enabled || declaration.source !== event.source || declaration.event !== event.event) return null;
  const matches = declaration.match.every((clause) => {
    const actual = event.attributes[clause.field];
    if (clause.operator === "eq") return actual === clause.value;
    if (clause.operator === "prefix") return typeof actual === "string" && actual.startsWith(clause.value);
    return clause.values.includes(actual);
  });
  if (!matches) return null;
  return candidate({
    declarationId: declaration.id,
    declarationRevision: declaration.revision,
    declarationDigest: declaration.declarationDigest,
    actionRef: declaration.actionRef,
    trigger: "event",
    occurrenceUnixMs: event.occurredAtUnixMs,
    cursor: event.cursor,
    sequence: event.sequence,
    eventSource: event.source
  });
}

function validateCandidate(input: unknown): AutomationCandidate {
  const value = object(input, "automation candidate");
  exact(value, new Set([
    "schemaVersion", "candidateId", "declarationId", "declarationRevision", "declarationDigest",
    "actionRef", "trigger", "occurrenceUnixMs", "cursor", "sequence", "eventSource",
    "idempotencyKey", "authorized", "requiresAuditedDispatch"
  ]), "automation candidate");
  if (value.schemaVersion !== AUTOMATION_SCHEMA_VERSION || value.authorized !== false || value.requiresAuditedDispatch !== true) {
    throw new Error("automation candidate does not preserve the audited dispatch boundary");
  }
  const trigger = value.trigger;
  if (trigger !== "schedule" && trigger !== "event") throw new Error("automation candidate has invalid trigger");
  const base: Omit<AutomationCandidate, "schemaVersion" | "candidateId" | "idempotencyKey" | "authorized" | "requiresAuditedDispatch"> = {
    declarationId: token(value.declarationId, "candidate declarationId"),
    declarationRevision: positive(value.declarationRevision, "candidate declarationRevision"),
    declarationDigest: typeof value.declarationDigest === "string" && /^[a-f0-9]{64}$/u.test(value.declarationDigest)
      ? value.declarationDigest
      : (() => { throw new Error("candidate declarationDigest is invalid"); })(),
    actionRef: action(value.actionRef),
    trigger,
    occurrenceUnixMs: unixMs(value.occurrenceUnixMs, "candidate occurrenceUnixMs")
  };
  if (trigger === "schedule" && (value.cursor !== undefined || value.sequence !== undefined || value.eventSource !== undefined)) throw new Error("schedule candidate cannot contain event replay fields");
  if (trigger === "event") {
    if (typeof value.cursor !== "string" || value.sequence === undefined || typeof value.eventSource !== "string") throw new Error("event candidate requires source, cursor, and sequence");
    const sequence = uint(value.sequence, "candidate sequence");
    const eventSource = token(value.eventSource, "candidate eventSource");
    if (value.cursor !== formatAutomationCursor(eventSource, sequence)) {
      throw new Error("event candidate cursor does not bind its source and sequence");
    }
    base.cursor = value.cursor;
    base.sequence = sequence;
    base.eventSource = eventSource;
  }
  const rebuilt = candidate(base);
  if (value.candidateId !== rebuilt.candidateId || value.idempotencyKey !== rebuilt.idempotencyKey) {
    throw new Error("automation candidate integrity binding is invalid");
  }
  return rebuilt;
}

export function validateOdinnAgentControlEnvelope(input: unknown): OdinnAgentControlEnvelope {
  const value = object(boundedJson(input, "Odinn agent control envelope"), "Odinn agent control envelope");
  if (value.version !== ODINN_AGENT_CONTROL_VERSION) throw new Error("Odinn agent control envelope has an unsupported version");
  if (value.kind !== "dispatch" && value.kind !== "cancel" && value.kind !== "status" && value.kind !== "result") {
    throw new Error("Odinn agent control envelope has an unsupported kind");
  }
  exact(value, CONTROL_KEYS[value.kind], "Odinn agent control envelope");
  const base = {
    version: ODINN_AGENT_CONTROL_VERSION,
    kind: value.kind,
    id: token(value.id, "control message id"),
    correlationId: token(value.correlationId, "control correlationId"),
    agentId: token(value.agentId, "control agentId"),
    issuedAtUnixMs: unixMs(value.issuedAtUnixMs, "control issuedAtUnixMs")
  };
  if (value.kind === "dispatch") return freeze({ ...base, kind: "dispatch", candidate: validateCandidate(value.candidate) });
  const dispatchId = token(value.dispatchId, "control dispatchId");
  if (value.kind === "cancel") {
    const reasons = new Set(["operator-request", "superseded", "shutdown", "policy"]);
    if (typeof value.reason !== "string" || !reasons.has(value.reason)) throw new Error("control cancellation reason is invalid");
    return freeze({ ...base, kind: "cancel", dispatchId, reason: value.reason as "operator-request" });
  }
  if (value.kind === "status") {
    const states = new Set(["queued", "awaiting-approval", "running", "cancelling"]);
    if (typeof value.state !== "string" || !states.has(value.state)) throw new Error("control status state is invalid");
    return freeze({ ...base, kind: "status", dispatchId, state: value.state as "queued" });
  }
  const outcomes = new Set(["completed", "failed", "cancelled", "needs-review"]);
  if (typeof value.outcome !== "string" || !outcomes.has(value.outcome)) throw new Error("control result outcome is invalid");
  const resultRef = value.resultRef === undefined ? undefined : action(value.resultRef);
  return freeze({ ...base, kind: "result", dispatchId, outcome: value.outcome as "completed", ...(resultRef ? { resultRef } : {}) });
}

/**
 * Validates one message-to-message transition in a single dispatch chain.
 * Callers remain responsible for durably storing the accepted chain.
 */
export function validateOdinnAgentControlTransition(
  historyInput: unknown,
  nextInput: unknown
): OdinnAgentControlEnvelope {
  if (!Array.isArray(historyInput) || historyInput.length > MAX_ODINN_CONTROL_HISTORY) {
    throw new Error(`control history must be an array of at most ${MAX_ODINN_CONTROL_HISTORY} messages`);
  }
  const normalizedHistory = boundedJson(historyInput, "control history");
  if (!Array.isArray(normalizedHistory)) throw new Error("control history must be an array");
  const history = normalizedHistory.map((item) => validateOdinnAgentControlEnvelope(item));
  const next = validateOdinnAgentControlEnvelope(nextInput);
  if (history.length === 0) {
    if (next.kind !== "dispatch") throw new Error("control transition references an unknown dispatch");
    return next;
  }
  if (history[0].kind !== "dispatch") throw new Error("control history must begin with dispatch");
  const ids = new Set<string>();
  ids.add(history[0].id);
  for (let index = 1; index < history.length; index += 1) {
    if (ids.has(history[index].id)) throw new Error("control history contains a reused message id");
    validateControlPair(history[index - 1], history[index]);
    ids.add(history[index].id);
  }
  if (ids.has(next.id)) throw new Error("control transition message id must be unique across retained history");
  return validateControlPair(history[history.length - 1], next);
}

function validateControlPair(
  previous: OdinnAgentControlEnvelope,
  next: OdinnAgentControlEnvelope
): OdinnAgentControlEnvelope {
  if (previous.kind === "result") throw new Error("control transition cannot follow a terminal result");
  if (next.kind === "dispatch") throw new Error("control transition cannot replace an existing dispatch");
  const dispatchId = previous.kind === "dispatch" ? previous.id : previous.dispatchId;
  if (next.dispatchId !== dispatchId) throw new Error("control transition dispatchId does not match");
  if (next.agentId !== previous.agentId) throw new Error("control transition agentId does not match");
  if (next.correlationId !== previous.correlationId) throw new Error("control transition correlationId does not match");
  if (next.issuedAtUnixMs < previous.issuedAtUnixMs) throw new Error("control transition timestamp regresses");

  if (previous.kind === "cancel") {
    if (next.kind === "status" && next.state === "cancelling") return next;
    if (next.kind === "result" && next.outcome !== "completed") return next;
    throw new Error("control cancellation must progress to cancelling or a non-completed result");
  }
  if (previous.kind === "status") {
    const rank = { queued: 0, "awaiting-approval": 1, running: 2, cancelling: 3 } as const;
    if (next.kind === "status") {
      if (rank[next.state] <= rank[previous.state]) throw new Error("control status transition is duplicate or regressive");
      return next;
    }
    if (next.kind === "cancel") {
      if (previous.state === "cancelling") throw new Error("control cancellation is duplicate");
      return next;
    }
    if (next.kind === "result") {
      if (previous.state === "cancelling" && next.outcome === "completed") {
        throw new Error("cancelling control cannot complete successfully");
      }
      return next;
    }
  }
  if (previous.kind === "dispatch") {
    if (next.kind === "status" || next.kind === "cancel" || next.kind === "result") return next;
  }
  throw new Error("control transition is not legal");
}
