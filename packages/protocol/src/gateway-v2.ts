import { createHash } from "node:crypto";

export const GATEWAY_PROTOCOL_VERSION = 2 as const;
export const DEFAULT_GATEWAY_MAX_PAYLOAD_BYTES = 1_048_576;
export const MAX_GATEWAY_JSON_DEPTH = 32;
export const MAX_GATEWAY_JSON_NODES = 100_000;
export const MAX_GATEWAY_SEQUENCE = 999_999_999_999_999;
export const DEFAULT_GATEWAY_REPLAY_LIMIT = 100;
export const MAX_GATEWAY_REPLAY_LIMIT = 1_000;
export const MAX_GATEWAY_REPLAY_SOURCE_EVENTS = 10_000;
export const MAX_GATEWAY_REPLAY_SCAN_BYTES = 4_194_304;
export const MAX_GATEWAY_REPLAY_PAGE_BYTES = 1_048_576;
export const DEFAULT_GATEWAY_IDEMPOTENCY_RETENTION_MS = 86_400_000;

export type GatewayJsonPrimitive = string | number | boolean | null;
export type GatewayJsonValue = GatewayJsonPrimitive | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayClientRole = "operator" | "agent" | "service" | "observer";
export type GatewayScope = string;

export type GatewayDeclaredCapability = {
  name: string;
  version?: string;
};

export type GatewayProtocolRange = {
  min: number;
  max: number;
};

export type GatewayClientDeclaration = {
  role: GatewayClientRole;
  scopes: GatewayScope[];
  capabilities: GatewayDeclaredCapability[];
};

export type GatewayMethodDiscovery = {
  name: string;
  mutating: boolean;
  requiredScopes: GatewayScope[];
};

export type GatewayEventDiscovery = {
  name: string;
  requiredScopes: GatewayScope[];
};

export type GatewayDiscovery = {
  protocol: GatewayProtocolRange;
  methods: GatewayMethodDiscovery[];
  events: GatewayEventDiscovery[];
};

export type GatewayStructuredError = {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  details?: GatewayJsonValue;
};

export type GatewayRequestFrame = {
  v: typeof GATEWAY_PROTOCOL_VERSION;
  type: "request";
  id: string;
  method: string;
  params?: GatewayJsonValue;
  idempotencyKey?: string;
  traceparent?: string;
};

export type GatewayResponseFrame = {
  v: typeof GATEWAY_PROTOCOL_VERSION;
  type: "response";
  id: string;
  result?: GatewayJsonValue;
  error?: GatewayStructuredError;
  traceparent?: string;
};

export type GatewayEventFrame = {
  v: typeof GATEWAY_PROTOCOL_VERSION;
  type: "event";
  event: string;
  sequence: number;
  cursor: string;
  data?: GatewayJsonValue;
  traceparent?: string;
};

export type GatewayFrame = GatewayRequestFrame | GatewayResponseFrame | GatewayEventFrame;

export type GatewayValidationOptions = {
  maxPayloadBytes?: number;
  methods?: readonly GatewayMethodDiscovery[];
  grantedScopes?: readonly GatewayScope[];
};

export type GatewayAuthorizationOptions = {
  maxPayloadBytes?: number;
  methods: readonly GatewayMethodDiscovery[];
  grantedScopes: readonly GatewayScope[];
};

export type GatewayEventAuthorizationOptions = GatewayEventValidationOptions & {
  events: readonly GatewayEventDiscovery[];
  grantedScopes: readonly GatewayScope[];
};

export type GatewayEventValidationOptions = GatewayValidationOptions & {
  previousSequence?: number;
  replayAfterCursor?: string;
};

export type GatewayReplayOptions = {
  afterCursor?: string;
  limit?: number;
  oldestAvailableSequence?: number;
  newestAvailableSequence?: number;
};

export type GatewayReplayPage = {
  events: GatewayEventFrame[];
  nextCursor?: string;
  hasMore: boolean;
};

export type GatewayIdempotencyBinding = {
  principal: string;
  idempotencyKey: string;
  namespaceKey: string;
  requestFingerprint: string;
  method: string;
};

export type GatewayIdempotencyRecord = GatewayIdempotencyBinding & (
  | { state: "in-flight"; expiresAt: string }
  | { state: "completed"; response: GatewayResponseFrame; expiresAt: string }
);

export class GatewayValidationError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: GatewayJsonValue;

  constructor(code: string, message: string, retryable = false, retryAfterMs?: number, details?: GatewayJsonValue) {
    super(message);
    this.name = "GatewayValidationError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.details = details;
  }

  toStructuredError(): GatewayStructuredError {
    const error: GatewayStructuredError = {
      code: this.code,
      message: this.message,
      retryable: this.retryable
    };
    if (this.retryAfterMs !== undefined) error.retryAfterMs = this.retryAfterMs;
    if (this.details !== undefined) error.details = this.details;
    return error;
  }
}

const TRACEPARENT = /^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{8,128}$/u;
const ROLES = new Set<GatewayClientRole>(["operator", "agent", "service", "observer"]);

export function validateTraceparent(value: unknown): string {
  if (typeof value !== "string" || !TRACEPARENT.test(value)) {
    throw validationError("INVALID_TRACEPARENT", "traceparent must use the W3C version-trace-id-parent-id-flags format");
  }
  const [version, traceId, parentId] = value.split("-");
  if (version !== "00" || /^0+$/u.test(traceId) || /^0+$/u.test(parentId)) {
    throw validationError("INVALID_TRACEPARENT", "traceparent must be version 00 with nonzero trace and parent identifiers");
  }
  return value;
}

export function negotiateGatewayProtocol(client: GatewayProtocolRange, server: GatewayProtocolRange): number {
  validateProtocolRange(client, "client");
  validateProtocolRange(server, "server");
  const selected = Math.min(client.max, server.max);
  if (selected < Math.max(client.min, server.min)) {
    throw validationError("INCOMPATIBLE_PROTOCOL", "client and server protocol ranges do not overlap");
  }
  return selected;
}

export function validateClientDeclaration(input: unknown): GatewayClientDeclaration {
  const value = strictObject(input, "client declaration", ["role", "scopes", "capabilities"]);
  if (typeof value.role !== "string" || !ROLES.has(value.role as GatewayClientRole)) {
    throw validationError("INVALID_CLIENT_ROLE", "client role is not supported");
  }
  const scopes = stringArray(value.scopes, "scopes");
  const capabilities = array(value.capabilities, "capabilities").map((item, index) => {
    const capability = strictObject(item, `capabilities[${index}]`, ["name", "version"]);
    return {
      name: identifier(capability.name, `capabilities[${index}].name`),
      ...(capability.version === undefined ? {} : { version: nonEmptyString(capability.version, `capabilities[${index}].version`, 64) })
    };
  });
  return { role: value.role as GatewayClientRole, scopes, capabilities };
}

export function validateDiscovery(input: unknown): GatewayDiscovery {
  const value = strictObject(input, "discovery", ["protocol", "methods", "events"]);
  const protocol = validateProtocolRange(value.protocol, "protocol");
  const methods = array(value.methods, "methods").map((item, index) => validateMethod(item, index));
  const events = array(value.events, "events").map((item, index) => {
    const event = strictObject(item, `events[${index}]`, ["name", "requiredScopes"]);
    return {
      name: identifier(event.name, `events[${index}].name`),
      requiredScopes: stringArray(event.requiredScopes, `events[${index}].requiredScopes`)
    };
  });
  rejectDuplicates(methods.map((method) => method.name), "method");
  rejectDuplicates(events.map((event) => event.name), "event");
  return { protocol, methods, events };
}

export function validateGatewayFrame(input: unknown, options: GatewayEventValidationOptions = {}): GatewayFrame {
  validatePayload(input, options.maxPayloadBytes);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw validationError("INVALID_FRAME", "gateway frame must be an object");
  }
  const type = (input as Record<string, unknown>).type;
  if (type === "request") return validateGatewayRequest(input, options);
  if (type === "response") return validateGatewayResponse(input, options);
  if (type === "event") return validateGatewayEvent(input, options);
  throw validationError("INVALID_FRAME_TYPE", "gateway frame type must be request, response, or event");
}

/**
 * Mandatory raw transport ingress. The wire byte limit is enforced before
 * UTF-8 decoding and JSON parsing. Object validators are for already parsed,
 * trusted-process values and are not a substitute for this boundary.
 */
export function parseGatewayWireFrame(
  input: string | Uint8Array,
  options: GatewayEventValidationOptions = {}
): GatewayFrame {
  const limit = payloadLimit(options.maxPayloadBytes);
  const bytes = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (bytes > limit) throw validationError("PAYLOAD_TOO_LARGE", `gateway payload exceeds ${limit} bytes`);
  let encoded: string;
  try {
    encoded = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw validationError("INVALID_UTF8", "gateway wire payload must be valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw validationError("INVALID_JSON", "gateway wire payload must contain valid JSON");
  }
  return validateGatewayFrame(parsed, options);
}

export function validateGatewayRequest(input: unknown, options: GatewayValidationOptions = {}): GatewayRequestFrame {
  validatePayload(input, options.maxPayloadBytes);
  const value = strictObject(input, "request frame", ["v", "type", "id", "method", "params", "idempotencyKey", "traceparent"]);
  frameHeader(value, "request");
  const request: GatewayRequestFrame = {
    v: GATEWAY_PROTOCOL_VERSION,
    type: "request",
    id: identifier(value.id, "request id"),
    method: identifier(value.method, "request method")
  };
  if (value.params !== undefined) request.params = jsonValue(value.params);
  if (value.traceparent !== undefined) request.traceparent = validateTraceparent(value.traceparent);
  if (value.idempotencyKey !== undefined) {
    if (typeof value.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(value.idempotencyKey)) {
      throw validationError("INVALID_IDEMPOTENCY_KEY", "idempotency key must contain 8-128 visible ASCII characters");
    }
    request.idempotencyKey = value.idempotencyKey;
  }

  if (options.methods) {
    const method = options.methods.find((candidate) => candidate.name === request.method);
    if (!method) throw validationError("METHOD_NOT_FOUND", `method ${request.method} is not discoverable`);
    assertScopes(method.requiredScopes, options.grantedScopes ?? []);
    if (method.mutating && request.idempotencyKey === undefined) {
      throw validationError("IDEMPOTENCY_KEY_REQUIRED", `mutating method ${request.method} requires an idempotency key`);
    }
  }
  return request;
}

export function validateAuthorizedGatewayRequest(
  input: unknown,
  options: GatewayAuthorizationOptions
): GatewayRequestFrame {
  return validateGatewayRequest(input, options);
}

export function validateGatewayResponse(input: unknown, options: GatewayValidationOptions = {}): GatewayResponseFrame {
  validatePayload(input, options.maxPayloadBytes);
  const value = strictObject(input, "response frame", ["v", "type", "id", "result", "error", "traceparent"]);
  frameHeader(value, "response");
  if ((value.result === undefined) === (value.error === undefined)) {
    throw validationError("INVALID_RESPONSE", "response must contain exactly one of result or error");
  }
  const response: GatewayResponseFrame = {
    v: GATEWAY_PROTOCOL_VERSION,
    type: "response",
    id: identifier(value.id, "response id")
  };
  if (value.result !== undefined) response.result = jsonValue(value.result);
  if (value.error !== undefined) response.error = validateStructuredError(value.error);
  if (value.traceparent !== undefined) response.traceparent = validateTraceparent(value.traceparent);
  return response;
}

export function validateGatewayEvent(input: unknown, options: GatewayEventValidationOptions = {}): GatewayEventFrame {
  validatePayload(input, options.maxPayloadBytes);
  const value = strictObject(input, "event frame", ["v", "type", "event", "sequence", "cursor", "data", "traceparent"]);
  frameHeader(value, "event");
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 ||
      (value.sequence as number) > MAX_GATEWAY_SEQUENCE) {
    throw validationError("INVALID_EVENT_SEQUENCE", `event sequence must be an integer from 0 to ${MAX_GATEWAY_SEQUENCE}`);
  }
  const sequence = value.sequence as number;
  const cursor = nonEmptyString(value.cursor, "event cursor", 64);
  if (parseGatewayCursor(cursor) !== sequence) {
    throw validationError("INVALID_REPLAY_CURSOR", "event cursor must encode its sequence");
  }
  if (options.previousSequence !== undefined && sequence <= options.previousSequence) {
    throw validationError("EVENT_OUT_OF_ORDER", "event sequence must increase monotonically");
  }
  if (options.replayAfterCursor !== undefined && sequence <= parseGatewayCursor(options.replayAfterCursor)) {
    throw validationError("EVENT_BEFORE_CURSOR", "replayed event must follow the requested cursor");
  }
  const event: GatewayEventFrame = {
    v: GATEWAY_PROTOCOL_VERSION,
    type: "event",
    event: identifier(value.event, "event name"),
    sequence,
    cursor
  };
  if (value.data !== undefined) event.data = jsonValue(value.data);
  if (value.traceparent !== undefined) event.traceparent = validateTraceparent(value.traceparent);
  return event;
}

export function validateAuthorizedGatewayEvent(
  input: unknown,
  options: GatewayEventAuthorizationOptions
): GatewayEventFrame {
  const event = validateGatewayEvent(input, options);
  const metadata = options.events.find((candidate) => candidate.name === event.event);
  if (!metadata) throw validationError("EVENT_NOT_FOUND", `event ${event.event} is not discoverable`);
  assertScopes(metadata.requiredScopes, options.grantedScopes);
  return event;
}

export function createGatewayCursor(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > MAX_GATEWAY_SEQUENCE) {
    throw validationError("INVALID_EVENT_SEQUENCE", `cursor sequence must be an integer from 0 to ${MAX_GATEWAY_SEQUENCE}`);
  }
  return `v2:${sequence}`;
}

export function parseGatewayCursor(cursor: unknown): number {
  if (typeof cursor !== "string" || !/^v2:(0|[1-9]\d{0,14})$/u.test(cursor)) {
    throw validationError("INVALID_REPLAY_CURSOR", "replay cursor must have the form v2:<sequence>");
  }
  const sequence = Number(cursor.slice(3));
  if (!Number.isSafeInteger(sequence) || sequence > MAX_GATEWAY_SEQUENCE) {
    throw validationError("INVALID_REPLAY_CURSOR", "replay cursor exceeds the supported sequence range");
  }
  return sequence;
}

export function replayGatewayEvents(
  events: readonly GatewayEventFrame[],
  options: GatewayReplayOptions = {}
): GatewayReplayPage {
  if (events.length > MAX_GATEWAY_REPLAY_SOURCE_EVENTS) {
    throw validationError("REPLAY_SOURCE_TOO_LARGE", `replay source exceeds ${MAX_GATEWAY_REPLAY_SOURCE_EVENTS} events`);
  }
  const limit = options.limit ?? DEFAULT_GATEWAY_REPLAY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_GATEWAY_REPLAY_LIMIT) {
    throw validationError("INVALID_REPLAY_LIMIT", `replay limit must be from 1 to ${MAX_GATEWAY_REPLAY_LIMIT}`);
  }
  const after = options.afterCursor === undefined ? -1 : parseGatewayCursor(options.afterCursor);
  if (options.afterCursor !== undefined &&
      (options.oldestAvailableSequence === undefined || options.newestAvailableSequence === undefined)) {
    throw validationError(
      "REPLAY_WINDOW_REQUIRED",
      "authoritative oldest and newest retained sequences are required with afterCursor"
    );
  }
  const oldest = options.oldestAvailableSequence;
  const newest = options.newestAvailableSequence;
  if (oldest !== undefined && (!Number.isSafeInteger(oldest) || oldest < 0 || oldest > MAX_GATEWAY_SEQUENCE)) {
    throw validationError("INVALID_REPLAY_WINDOW", "oldest available sequence is invalid");
  }
  if (newest !== undefined && (!Number.isSafeInteger(newest) || newest < 0 || newest > MAX_GATEWAY_SEQUENCE)) {
    throw validationError("INVALID_REPLAY_WINDOW", "newest available sequence is invalid");
  }
  if (oldest !== undefined && newest !== undefined && oldest > newest) {
    throw validationError("INVALID_REPLAY_WINDOW", "oldest available sequence exceeds newest available sequence");
  }
  if (options.afterCursor !== undefined && oldest !== undefined && after < oldest - 1) {
    throw validationError("REPLAY_CURSOR_STALE", "replay cursor predates retained events");
  }
  if (options.afterCursor !== undefined && newest !== undefined && after > newest) {
    throw validationError("REPLAY_CURSOR_FUTURE", "replay cursor is ahead of the newest event");
  }

  const pageEvents: GatewayEventFrame[] = [];
  let previous = -1;
  let scanBytes = 0;
  let pageBytes = 2;
  let hasMore = false;
  for (const sourceEvent of events) {
    scanBytes += encodedPayloadBytes(sourceEvent);
    if (scanBytes > MAX_GATEWAY_REPLAY_SCAN_BYTES) {
      throw validationError("REPLAY_SCAN_TOO_LARGE", `replay scan exceeds ${MAX_GATEWAY_REPLAY_SCAN_BYTES} bytes`);
    }
    const event = validateGatewayEvent(sourceEvent, { previousSequence: previous });
    previous = event.sequence;
    if (event.sequence <= after) continue;
    if (pageEvents.length >= limit) {
      hasMore = true;
      break;
    }
    const eventBytes = encodedPayloadBytes(event);
    const separatorBytes = pageEvents.length === 0 ? 0 : 1;
    if (pageBytes + separatorBytes + eventBytes > MAX_GATEWAY_REPLAY_PAGE_BYTES) {
      if (pageEvents.length === 0) {
        throw validationError("REPLAY_EVENT_TOO_LARGE", "one event exceeds the aggregate replay page byte budget");
      }
      hasMore = true;
      break;
    }
    pageEvents.push(event);
    pageBytes += separatorBytes + eventBytes;
  }
  if (!hasMore && newest !== undefined && after < newest &&
      (pageEvents.at(-1)?.sequence ?? after) < newest) {
    throw validationError("REPLAY_SOURCE_INCOMPLETE", "replay source does not reach the authoritative newest sequence");
  }
  const nextCursor = pageEvents.at(-1)?.cursor;
  return {
    events: pageEvents,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    hasMore
  };
}

export function createGatewayIdempotencyBinding(
  principal: string,
  request: GatewayRequestFrame
): GatewayIdempotencyBinding {
  if (!IDENTIFIER.test(principal)) {
    throw validationError("INVALID_PRINCIPAL", "idempotency principal must be a bounded stable identifier");
  }
  if (request.idempotencyKey === undefined) {
    throw validationError("IDEMPOTENCY_KEY_REQUIRED", "idempotency binding requires an idempotency key");
  }
  const validated = validateGatewayRequest(request);
  const material = canonicalJson({
    hasParams: validated.params !== undefined,
    method: validated.method,
    params: validated.params ?? null
  });
  return {
    principal,
    idempotencyKey: validated.idempotencyKey as string,
    namespaceKey: sha256(`${principal}\0${validated.idempotencyKey}`),
    requestFingerprint: sha256(material),
    method: validated.method
  };
}

export function assertGatewayIdempotencyMatch(
  existing: Pick<GatewayIdempotencyRecord, "namespaceKey" | "requestFingerprint">,
  incoming: GatewayIdempotencyBinding
): void {
  if (existing.namespaceKey !== incoming.namespaceKey ||
      existing.requestFingerprint !== incoming.requestFingerprint) {
    throw validationError("IDEMPOTENCY_KEY_MISMATCH", "idempotency key was already bound to different request content");
  }
}

export function validateStructuredError(input: unknown): GatewayStructuredError {
  const value = strictObject(input, "structured error", ["code", "message", "retryable", "retryAfterMs", "details"]);
  if (typeof value.code !== "string" || !ERROR_CODE.test(value.code)) {
    throw validationError("INVALID_ERROR", "error code must be a stable uppercase identifier");
  }
  if (typeof value.retryable !== "boolean") throw validationError("INVALID_ERROR", "error retryable must be boolean");
  if (value.retryAfterMs !== undefined && (!Number.isSafeInteger(value.retryAfterMs) || (value.retryAfterMs as number) < 0)) {
    throw validationError("INVALID_ERROR", "error retryAfterMs must be a non-negative safe integer");
  }
  if (value.retryAfterMs !== undefined && value.retryable !== true) {
    throw validationError("INVALID_ERROR", "retryAfterMs is only valid for retryable errors");
  }
  const error: GatewayStructuredError = {
    code: value.code,
    message: nonEmptyString(value.message, "error message", 4_096),
    retryable: value.retryable
  };
  if (value.retryAfterMs !== undefined) error.retryAfterMs = value.retryAfterMs as number;
  if (value.details !== undefined) error.details = jsonValue(value.details);
  return error;
}

export function validateProtocolRange(input: unknown, label = "gateway"): GatewayProtocolRange {
  const value = strictObject(input, `${label} protocol range`, ["min", "max"]);
  if (!Number.isSafeInteger(value.min) || !Number.isSafeInteger(value.max) ||
      (value.min as number) < 1 || (value.max as number) < (value.min as number)) {
    throw validationError("INVALID_PROTOCOL_RANGE", `${label} protocol range must contain positive integers with min <= max`);
  }
  return { min: value.min as number, max: value.max as number };
}

function validateMethod(input: unknown, index: number): GatewayMethodDiscovery {
  const value = strictObject(input, `methods[${index}]`, ["name", "mutating", "requiredScopes"]);
  if (typeof value.mutating !== "boolean") throw validationError("INVALID_DISCOVERY", `methods[${index}].mutating must be boolean`);
  return {
    name: identifier(value.name, `methods[${index}].name`),
    mutating: value.mutating,
    requiredScopes: stringArray(value.requiredScopes, `methods[${index}].requiredScopes`)
  };
}

function assertScopes(required: readonly string[], granted: readonly string[]): void {
  const available = new Set(granted);
  const missing = required.filter((scope) => !available.has(scope));
  if (missing.length > 0) throw validationError("INSUFFICIENT_SCOPE", `missing required scopes: ${missing.join(", ")}`);
}

function validatePayload(input: unknown, configuredLimit = DEFAULT_GATEWAY_MAX_PAYLOAD_BYTES): void {
  const limit = payloadLimit(configuredLimit);
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    throw validationError("INVALID_JSON", "gateway payload must be JSON serializable");
  }
  if (encoded === undefined) throw validationError("INVALID_JSON", "gateway payload must be JSON serializable");
  if (Buffer.byteLength(encoded, "utf8") > limit) {
    throw validationError("PAYLOAD_TOO_LARGE", `gateway payload exceeds ${limit} bytes`);
  }
}

function payloadLimit(configuredLimit = DEFAULT_GATEWAY_MAX_PAYLOAD_BYTES): number {
  if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1) {
    throw validationError("INVALID_PAYLOAD_LIMIT", "max payload bytes must be a positive safe integer");
  }
  return configuredLimit;
}

function encodedPayloadBytes(value: unknown): number {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw validationError("INVALID_JSON", "gateway payload must be JSON serializable");
  }
  if (encoded === undefined) throw validationError("INVALID_JSON", "gateway payload must be JSON serializable");
  return Buffer.byteLength(encoded, "utf8");
}

function canonicalJson(value: GatewayJsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key] as GatewayJsonValue)}`
  )).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonValue(input: unknown): GatewayJsonValue {
  let nodes = 0;
  const visit = (value: unknown, depth: number): GatewayJsonValue => {
    nodes += 1;
    if (nodes > MAX_GATEWAY_JSON_NODES || depth > MAX_GATEWAY_JSON_DEPTH) {
      throw validationError("JSON_COMPLEXITY_EXCEEDED", "gateway JSON exceeds depth or node limits");
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, depth + 1)]));
    }
    throw validationError("INVALID_JSON", "gateway values may only contain finite JSON values");
  };
  return visit(input, 0);
}

function frameHeader(value: Record<string, unknown>, type: GatewayFrame["type"]): void {
  if (value.v !== GATEWAY_PROTOCOL_VERSION) throw validationError("UNSUPPORTED_PROTOCOL", `frame version must be ${GATEWAY_PROTOCOL_VERSION}`);
  if (value.type !== type) throw validationError("INVALID_FRAME_TYPE", `frame type must be ${type}`);
}

function strictObject(input: unknown, label: string, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw validationError("INVALID_OBJECT", `${label} must be a plain object`);
  }
  const value = input as Record<string, unknown>;
  const unknown = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unknown !== undefined) throw validationError("UNKNOWN_FIELD", `${label} contains unknown field ${unknown}`);
  return value;
}

function identifier(input: unknown, label: string): string {
  if (typeof input !== "string" || !IDENTIFIER.test(input)) {
    throw validationError("INVALID_IDENTIFIER", `${label} must be a bounded identifier`);
  }
  return input;
}

function nonEmptyString(input: unknown, label: string, maxLength: number): string {
  if (typeof input !== "string" || input.length === 0 || input.length > maxLength) {
    throw validationError("INVALID_STRING", `${label} must contain 1-${maxLength} characters`);
  }
  return input;
}

function stringArray(input: unknown, label: string): string[] {
  const values = array(input, label).map((value, index) => identifier(value, `${label}[${index}]`));
  rejectDuplicates(values, label);
  return values;
}

function array(input: unknown, label: string): unknown[] {
  if (!Array.isArray(input) || input.length > 1_000) {
    throw validationError("INVALID_ARRAY", `${label} must be an array with at most 1000 entries`);
  }
  return input;
}

function rejectDuplicates(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw validationError("DUPLICATE_VALUE", `${label} contains duplicate entries`);
}

function validationError(code: string, message: string): GatewayValidationError {
  return new GatewayValidationError(code, message);
}
