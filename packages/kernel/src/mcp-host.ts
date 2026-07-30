import { createHash } from "node:crypto";

export const MCP_HOST_SCHEMA_VERSION = 1 as const;
export const MCP_HOST_MAX_TOOLS = 128;
export const MCP_HOST_MAX_SCHEMA_DEPTH = 12;
export const MCP_HOST_MAX_SCHEMA_NODES = 1_024;
export const MCP_HOST_MAX_SNAPSHOT_BYTES = 256 * 1024;
export const MCP_HOST_MAX_ARGUMENT_BYTES = 64 * 1024;
export const MCP_HOST_MAX_DISCOVERY_BYTES = 256 * 1024;
export const MCP_HOST_MAX_RECEIPT_BYTES = 16 * 1024;

export type McpRawJson = string | Uint8Array;

export type McpSchema =
  | { readonly type: "object"; readonly properties: Readonly<Record<string, McpSchema>>; readonly required: readonly string[]; readonly additionalProperties: false }
  | { readonly type: "array"; readonly items: McpSchema; readonly minItems?: number; readonly maxItems?: number }
  | { readonly type: "string"; readonly minLength?: number; readonly maxLength?: number }
  | { readonly type: "number" | "integer"; readonly minimum?: number; readonly maximum?: number }
  | { readonly type: "boolean" };

export type McpToolDefinition = {
  readonly name: string;
  readonly inputSchema: McpSchema;
  readonly schemaFingerprint: string;
};

export type McpDiscoveryRequest = {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly serverId: string;
  readonly reason: "start" | "refresh";
};

export type McpDiscoveryResult = {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly serverId: string;
  readonly generation: number;
  readonly validForMs: number;
  readonly tools: readonly {
    readonly name: string;
    readonly inputSchema: unknown;
  }[];
};

export type McpToolSnapshot = {
  readonly schemaVersion: 1;
  readonly serverId: string;
  readonly generation: number;
  readonly discoveredAtMs: number;
  readonly expiresAtMs: number;
  readonly staleUntilMs: number;
  readonly fingerprint: string;
  readonly tools: readonly McpToolDefinition[];
};

export type McpSnapshotState = "empty" | "fresh" | "stale" | "expired";
export type McpHostLifecycle = "idle" | "running" | "stopping" | "stopped";

export type McpCallRequest = {
  readonly schemaVersion: 1;
  readonly callId: string;
  readonly principalNamespace: string;
  readonly serverId: string;
  readonly generation: number;
  readonly snapshotFingerprint: string;
  readonly toolName: string;
  readonly toolSchemaFingerprint: string;
  readonly argumentDigest: string;
  readonly arguments: unknown;
  readonly requestDigest: string;
  readonly requiresAuthorization: true;
  readonly requiresAudit: true;
};

export type McpCallReceipt = {
  readonly schemaVersion: 1;
  readonly callId: string;
  readonly principalNamespace: string;
  readonly serverId: string;
  readonly generation: number;
  readonly snapshotFingerprint: string;
  readonly toolName: string;
  readonly toolSchemaFingerprint: string;
  readonly argumentDigest: string;
  readonly requestDigest: string;
  readonly authorizationRef: string;
  readonly auditRef: string;
  readonly status: "completed" | "failed" | "needs-review";
  readonly resultRef?: string;
  readonly resultDigest?: string;
  readonly errorCode?: string;
};

export type McpUncertainCall = {
  readonly schemaVersion: 1;
  readonly callId: string;
  readonly requestDigest: string;
  readonly status: "needs-review";
  readonly reason: "timeout" | "cancelled" | "shutdown";
  readonly physicalPending: true;
};

export type McpCallOutcome = McpCallReceipt | McpUncertainCall;

export interface McpDiscoveryTransport {
  discover(request: McpDiscoveryRequest, signal: AbortSignal): Promise<McpRawJson> | McpRawJson;
}

export interface McpAuditedDispatcher {
  dispatch(request: McpCallRequest, signal: AbortSignal): Promise<McpRawJson> | McpRawJson;
}

export type CachedMcpHostOptions = {
  serverId: string;
  discovery: McpDiscoveryTransport;
  dispatcher: McpAuditedDispatcher;
  maxConcurrency?: number;
  callTimeoutMs?: number;
  discoveryTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxStaleMs?: number;
  maxTrackedCallIds?: number;
  now?: () => number;
};

export type McpHostStatus = {
  readonly lifecycle: McpHostLifecycle;
  readonly snapshotState: McpSnapshotState;
  readonly generation?: number;
  readonly snapshotFingerprint?: string;
  readonly discoveryInFlight: boolean;
  readonly discoveryPhysicallyPending: boolean;
  readonly logicalCalls: number;
  readonly physicalCalls: number;
  readonly pendingPhysicalCalls: number;
  readonly completedCalls: number;
  readonly failedCalls: number;
  readonly uncertainCalls: number;
  readonly invalidReceipts: number;
  readonly lateSettlements: number;
  readonly trackedCallIds: number;
};

export type McpShutdownResult = {
  readonly stopped: true;
  readonly pendingPhysicalCalls: number;
  readonly discoveryPhysicallyPending: boolean;
};

const HOST_OPTION_KEYS = new Set([
  "serverId", "discovery", "dispatcher", "maxConcurrency", "callTimeoutMs",
  "discoveryTimeoutMs", "shutdownTimeoutMs", "maxStaleMs", "maxTrackedCallIds", "now"
]);
const DISCOVERY_RESULT_KEYS = new Set(["schemaVersion", "requestId", "serverId", "generation", "validForMs", "tools"]);
const TOOL_KEYS = new Set(["name", "inputSchema"]);
const RECEIPT_KEYS = new Set([
  "schemaVersion", "callId", "principalNamespace", "serverId", "generation",
  "snapshotFingerprint", "toolName", "toolSchemaFingerprint", "argumentDigest",
  "requestDigest", "authorizationRef", "auditRef", "status", "resultRef",
  "resultDigest", "errorCode"
]);
const OBJECT_SCHEMA_KEYS = new Set(["type", "properties", "required", "additionalProperties"]);
const ARRAY_SCHEMA_KEYS = new Set(["type", "items", "minItems", "maxItems"]);
const STRING_SCHEMA_KEYS = new Set(["type", "minLength", "maxLength"]);
const NUMBER_SCHEMA_KEYS = new Set(["type", "minimum", "maximum"]);
const BOOLEAN_SCHEMA_KEYS = new Set(["type"]);
const SERVER_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/u;
const TOOL_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REFERENCE_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const AUTHORIZATION_REFERENCE = /^authorization:([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u;
const AUDIT_REFERENCE = /^audit:([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u;
const RESULT_REFERENCE = /^(?:artifact|record):([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const PROPERTY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const SENSITIVE_IDENTITY_ATOMS = new Set([
  "auth", "authentication", "authorization", "bearer", "cookie", "cookies",
  "credential", "credentials", "endpoint", "endpoints", "header", "headers",
  "host", "key", "oauth", "password", "passwd", "path", "secret", "secrets",
  "session", "token", "tokens", "uri", "url", "username", "approval",
  "capability", "grant", "permission", "policy", "refresh", "jwt", "api"
]);
const CREDENTIAL_AUTHORITY_SUBJECTS = Object.freeze([
  "auth", "authentication", "authorization", "oauth", "client", "bearer",
  "password", "passwd", "username", "cookie", "cookies", "credential",
  "credentials", "api", "token", "tokens", "session", "refresh", "jwt",
  "grant", "approval", "policy", "secret", "secrets", "key", "access",
  "private", "account", "service", "callback", "endpoint", "webhook", "base",
  "internal", "remote", "server", "capability", "permission"
] as const);
const CREDENTIAL_AUTHORITY_MATERIALS = Object.freeze([
  "id", "value", "token", "tokens", "key", "keys", "header", "headers",
  "secret", "secrets", "password", "passwd", "credential", "credentials",
  "digest", "hash", "grant", "session", "ref", "reference", "approved",
  "handle", "cookie", "cookies", "url", "uri", "endpoint", "host", "approval",
  "capability", "permission", "policy"
] as const);
const CREDENTIAL_AUTHORITY_PARTS = Object.freeze([
  ...new Set([...CREDENTIAL_AUTHORITY_SUBJECTS, ...CREDENTIAL_AUTHORITY_MATERIALS])
]);
const CREDENTIAL_AUTHORITY_SUBJECT_SET = new Set<string>(CREDENTIAL_AUTHORITY_SUBJECTS);
const CREDENTIAL_AUTHORITY_MATERIAL_SET = new Set<string>(CREDENTIAL_AUTHORITY_MATERIALS);
const MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_STALE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_CONCURRENCY = 64;
const MAX_TRACKED_CALL_IDS = 1_000_000;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_JSON_NODES = 8_192;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_ARRAY = 2_048;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset")?.get;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER = typeof SharedArrayBuffer === "undefined"
  ? undefined
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;

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

function ordinaryObject(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype || input === Object.prototype) {
    throw new Error(`${label} must be an ordinary object`);
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") throw new Error(`${label} cannot contain symbols`);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
      throw new Error(`${label} must contain enumerable data fields`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function ordinaryArray(input: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > maximum) {
    throw new Error(`${label} must be an ordinary array of at most ${maximum} entries`);
  }
  const keys = Reflect.ownKeys(input);
  const expected = [...Array.from({ length: input.length }, (_, index) => String(index)), "length"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must be a dense array without extra fields`);
  }
  return input.map((_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
      throw new Error(`${label} entries must be enumerable data fields`);
    }
    return descriptor.value;
  });
}

function exact(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} has unknown fields`);
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function boundedOption(value: unknown, fallback: number, label: string, maximum: number): number {
  return value === undefined ? fallback : integer(value, label, 1, maximum);
}

function identityTokens(value: string): string[] {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

function normalizedAlphanumeric(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/gu, "").toLowerCase();
}

function isCredentialAuthorityComposition(value: string): boolean {
  const visit = (offset: number, depth: number, materialSeen: boolean): boolean => {
    if (offset === value.length) return depth >= 2 && materialSeen;
    if (depth >= 3) return false;
    const candidates = depth === 0 ? CREDENTIAL_AUTHORITY_SUBJECTS : CREDENTIAL_AUTHORITY_PARTS;
    for (const part of candidates) {
      if (
        value.startsWith(part, offset)
        && visit(
          offset + part.length,
          depth + 1,
          materialSeen || (
            depth > 0
            && (CREDENTIAL_AUTHORITY_MATERIAL_SET.has(part) || CREDENTIAL_AUTHORITY_SUBJECT_SET.has(part))
          )
        )
      ) {
        return true;
      }
    }
    return false;
  };
  return visit(0, 0, false);
}

function hasProtectedIdentity(value: string): boolean {
  const normalized = normalizedAlphanumeric(value);
  return identityTokens(value).some((token) => SENSITIVE_IDENTITY_ATOMS.has(token))
    || SENSITIVE_IDENTITY_ATOMS.has(normalized)
    || isCredentialAuthorityComposition(normalized);
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || hasProtectedIdentity(value)) {
    throw new Error(`${label} must be a bounded non-sensitive identifier`);
  }
  return value;
}

function serverId(value: unknown): string {
  if (typeof value !== "string" || !SERVER_ID.test(value) || hasProtectedIdentity(value)) {
    throw new Error("serverId must be a bounded non-sensitive identifier");
  }
  return value;
}

function toolName(value: unknown): string {
  if (typeof value !== "string" || !TOOL_NAME.test(value) || hasProtectedIdentity(value)) {
    throw new Error("tool name must be a bounded non-sensitive identifier");
  }
  return value;
}

function namespacedRef(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== "string") throw new Error(`${label} has an invalid namespace`);
  const match = pattern.exec(value);
  if (
    !match
    || !REFERENCE_SUFFIX.test(match[1])
    || hasProtectedIdentity(match[1])
  ) {
    throw new Error(`${label} has an invalid or sensitive namespace value`);
  }
  return value;
}

function resultRef(value: unknown): string {
  const result = namespacedRef(value, "resultRef", RESULT_REFERENCE);
  const suffix = RESULT_REFERENCE.exec(result)?.[1];
  if (!suffix || hasProtectedIdentity(suffix)) {
    throw new Error("resultRef contains authority-shaped content");
  }
  return result;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function parseBoundedRawJson(input: unknown, label: string, maximumBytes: number): unknown {
  let text: string;
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > maximumBytes) throw new Error(`${label} exceeds the raw byte limit`);
    const roundTrip = new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(input));
    if (roundTrip !== input) throw new Error(`${label} must contain valid UTF-8`);
    text = input;
  } else {
    if (
      !TYPED_ARRAY_BYTE_LENGTH_GETTER
      || !TYPED_ARRAY_BYTE_OFFSET_GETTER
      || !TYPED_ARRAY_BUFFER_GETTER
      || !ARRAY_BUFFER_BYTE_LENGTH_GETTER
      || !input
      || typeof input !== "object"
    ) {
      throw new Error(`${label} must be raw UTF-8 JSON`);
    }
    let byteLength: number;
    let byteOffset: number;
    let buffer: ArrayBuffer;
    try {
      byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(input) as number;
      byteOffset = TYPED_ARRAY_BYTE_OFFSET_GETTER.call(input) as number;
      if (Object.getPrototypeOf(input) !== Uint8Array.prototype) throw new Error("non-exact typed array");
      const candidate = TYPED_ARRAY_BUFFER_GETTER.call(input) as unknown;
      let ordinaryBacking = false;
      let sharedBacking = false;
      try {
        ARRAY_BUFFER_BYTE_LENGTH_GETTER.call(candidate);
        ordinaryBacking = true;
      } catch {}
      if (SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER) {
        try {
          SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER.call(candidate);
          sharedBacking = true;
        } catch {}
      }
      if (!ordinaryBacking || sharedBacking) {
        throw new Error("shared or unrecognized backing buffer");
      }
      buffer = candidate as ArrayBuffer;
    } catch {
      throw new Error(`${label} must be an exact Uint8Array`);
    }
    if (byteLength > maximumBytes) throw new Error(`${label} exceeds the raw byte limit`);
    let copy: Uint8Array;
    try {
      copy = new Uint8Array(byteLength);
      copy.set(new Uint8Array(buffer, byteOffset, byteLength));
    } catch {
      throw new Error(`${label} must be an exact Uint8Array`);
    }
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(copy);
    } catch {
      throw new Error(`${label} must contain valid UTF-8`);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
}

function cleanJson(input: unknown, label: string, maximumBytes: number): unknown {
  let nodes = 0;
  const visit = (value: unknown, path: string, depth: number): unknown => {
    if (++nodes > MAX_JSON_NODES) throw new Error(`${label} exceeds ${MAX_JSON_NODES} JSON nodes`);
    if (depth > MAX_JSON_DEPTH) throw new Error(`${label} exceeds depth ${MAX_JSON_DEPTH}`);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) throw new Error(`${path} string is too large`);
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return value;
    if (Array.isArray(value)) return ordinaryArray(value, path, MAX_JSON_ARRAY).map((item, index) => visit(item, `${path}[${index}]`, depth + 1));
    const record = ordinaryObject(value, path);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error(`${path} contains a forbidden object key`);
      Object.defineProperty(result, key, {
        value: visit(item, `${path}.field`, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return result;
  };
  const result = visit(input, label, 0);
  if (Buffer.byteLength(stableJson(result), "utf8") > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} UTF-8 bytes`);
  return result;
}

function normalizeSchema(input: unknown): McpSchema {
  let nodes = 0;
  const visit = (raw: unknown, path: string, depth: number): McpSchema => {
    if (++nodes > MCP_HOST_MAX_SCHEMA_NODES) throw new Error(`tool schema exceeds ${MCP_HOST_MAX_SCHEMA_NODES} nodes`);
    if (depth > MCP_HOST_MAX_SCHEMA_DEPTH) throw new Error(`tool schema exceeds depth ${MCP_HOST_MAX_SCHEMA_DEPTH}`);
    const value = ordinaryObject(raw, path);
    if (value.type === "object") {
      exact(value, OBJECT_SCHEMA_KEYS, path);
      if (value.additionalProperties !== false) throw new Error(`${path}.additionalProperties must be false`);
      const properties = ordinaryObject(value.properties, `${path}.properties`);
      const normalized: Record<string, McpSchema> = Object.create(null);
      for (const key of Object.keys(properties).sort()) {
        if (!PROPERTY_NAME.test(key) || hasProtectedIdentity(key)) throw new Error(`${path} has an unsafe property name`);
        normalized[key] = visit(properties[key], `${path}.properties.${key}`, depth + 1);
      }
      const required = ordinaryArray(value.required, `${path}.required`, Object.keys(normalized).length)
        .map((item) => {
          if (typeof item !== "string" || !Object.hasOwn(normalized, item)) throw new Error(`${path}.required contains an unknown property`);
          return item;
        }).sort();
      if (new Set(required).size !== required.length) throw new Error(`${path}.required contains duplicates`);
      return { type: "object", properties: normalized, required, additionalProperties: false };
    }
    if (value.type === "array") {
      exact(value, ARRAY_SCHEMA_KEYS, path);
      const minItems = value.minItems === undefined ? undefined : integer(value.minItems, `${path}.minItems`, 0, MAX_JSON_ARRAY);
      const maxItems = value.maxItems === undefined ? undefined : integer(value.maxItems, `${path}.maxItems`, 0, MAX_JSON_ARRAY);
      if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) throw new Error(`${path} has minItems greater than maxItems`);
      const result: McpSchema = {
        type: "array",
        items: visit(value.items, `${path}.items`, depth + 1),
        ...(minItems === undefined ? {} : { minItems }),
        ...(maxItems === undefined ? {} : { maxItems })
      };
      return result;
    }
    if (value.type === "string") {
      exact(value, STRING_SCHEMA_KEYS, path);
      const minLength = value.minLength === undefined ? undefined : integer(value.minLength, `${path}.minLength`, 0, MAX_STRING_BYTES);
      const maxLength = value.maxLength === undefined ? undefined : integer(value.maxLength, `${path}.maxLength`, 0, MAX_STRING_BYTES);
      if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) throw new Error(`${path} has minLength greater than maxLength`);
      return {
        type: "string",
        ...(minLength === undefined ? {} : { minLength }),
        ...(maxLength === undefined ? {} : { maxLength })
      };
    }
    if (value.type === "number" || value.type === "integer") {
      exact(value, NUMBER_SCHEMA_KEYS, path);
      const finite = (item: unknown, field: string): number | undefined => {
        if (item === undefined) return undefined;
        if (typeof item !== "number" || !Number.isFinite(item) || Math.abs(item) > Number.MAX_SAFE_INTEGER) throw new Error(`${path}.${field} must be a bounded finite number`);
        if (value.type === "integer" && !Number.isSafeInteger(item)) throw new Error(`${path}.${field} must be a safe integer`);
        return item;
      };
      const minimum = finite(value.minimum, "minimum");
      const maximum = finite(value.maximum, "maximum");
      if (minimum !== undefined && maximum !== undefined && minimum > maximum) throw new Error(`${path} has minimum greater than maximum`);
      return {
        type: value.type,
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum })
      };
    }
    if (value.type === "boolean") {
      exact(value, BOOLEAN_SCHEMA_KEYS, path);
      return { type: "boolean" };
    }
    throw new Error(`${path}.type is not in the allowlisted JSON Schema subset`);
  };
  return deepFreeze(visit(input, "tool inputSchema", 0));
}

function validateArguments(input: unknown, schema: McpSchema): unknown {
  try {
    const value = cleanJson(input, "tool arguments", MCP_HOST_MAX_ARGUMENT_BYTES);
    const visit = (item: unknown, rule: McpSchema, path: string): void => {
      if (rule.type === "object") {
        const object = ordinaryObject(item, path);
        for (const key of Object.keys(object)) if (!Object.hasOwn(rule.properties, key)) throw new Error(`${path} has unknown fields`);
        for (const key of rule.required) if (!Object.hasOwn(object, key)) throw new Error(`${path} is missing required fields`);
        for (const [key, child] of Object.entries(object)) visit(child, rule.properties[key], `${path}.${key}`);
        return;
      }
      if (rule.type === "array") {
        const array = ordinaryArray(item, path, rule.maxItems ?? MAX_JSON_ARRAY);
        if (rule.minItems !== undefined && array.length < rule.minItems) throw new Error(`${path} has too few entries`);
        for (const [index, child] of array.entries()) visit(child, rule.items, `${path}[${index}]`);
        return;
      }
      if (rule.type === "string") {
        if (typeof item !== "string") throw new Error(`${path} must be a string`);
        const length = [...item].length;
        if (rule.minLength !== undefined && length < rule.minLength) throw new Error(`${path} is too short`);
        if (rule.maxLength !== undefined && length > rule.maxLength) throw new Error(`${path} is too long`);
        return;
      }
      if (rule.type === "boolean") {
        if (typeof item !== "boolean") throw new Error(`${path} must be a boolean`);
        return;
      }
      if (typeof item !== "number" || !Number.isFinite(item) || (rule.type === "integer" && !Number.isSafeInteger(item))) {
        throw new Error(`${path} must be a ${rule.type}`);
      }
      if (rule.minimum !== undefined && item < rule.minimum) throw new Error(`${path} is below minimum`);
      if (rule.maximum !== undefined && item > rule.maximum) throw new Error(`${path} is above maximum`);
    };
    visit(value, schema, "tool arguments");
    return deepFreeze(value);
  } catch {
    throw new Error("MCP tool arguments do not match the pinned schema");
  }
}

function snapshotState(snapshot: McpToolSnapshot | undefined, now: number): McpSnapshotState {
  if (!snapshot) return "empty";
  if (now < snapshot.expiresAtMs) return "fresh";
  if (now < snapshot.staleUntilMs) return "stale";
  return "expired";
}

function validateReceipt(input: unknown, request: McpCallRequest): McpCallReceipt {
  const parsed = parseBoundedRawJson(input, "MCP call receipt", MCP_HOST_MAX_RECEIPT_BYTES);
  const value = ordinaryObject(cleanJson(parsed, "MCP call receipt", MCP_HOST_MAX_RECEIPT_BYTES), "MCP call receipt");
  exact(value, RECEIPT_KEYS, "MCP call receipt");
  for (const [key, expected] of Object.entries({
    schemaVersion: MCP_HOST_SCHEMA_VERSION,
    callId: request.callId,
    principalNamespace: request.principalNamespace,
    serverId: request.serverId,
    generation: request.generation,
    snapshotFingerprint: request.snapshotFingerprint,
    toolName: request.toolName,
    toolSchemaFingerprint: request.toolSchemaFingerprint,
    argumentDigest: request.argumentDigest,
    requestDigest: request.requestDigest
  })) {
    if (value[key] !== expected) throw new Error(`MCP call receipt ${key} does not match the request`);
  }
  const status = value.status;
  if (status !== "completed" && status !== "failed" && status !== "needs-review") throw new Error("MCP call receipt has invalid status");
  const authorizationRef = namespacedRef(value.authorizationRef, "authorizationRef", AUTHORIZATION_REFERENCE);
  const auditRef = namespacedRef(value.auditRef, "auditRef", AUDIT_REFERENCE);
  const resultReference = value.resultRef === undefined ? undefined : resultRef(value.resultRef);
  const resultDigest = value.resultDigest === undefined ? undefined : sha256(value.resultDigest, "resultDigest");
  const errorCode = value.errorCode === undefined ? undefined : id(value.errorCode, "errorCode");
  if (status === "completed" && (!resultReference || !resultDigest || errorCode)) throw new Error("completed receipt requires resultRef and resultDigest only");
  if (status !== "completed" && (resultReference || resultDigest || !errorCode)) throw new Error("non-completed receipt requires errorCode only");
  const receipt: McpCallReceipt = {
    schemaVersion: MCP_HOST_SCHEMA_VERSION,
    callId: request.callId,
    principalNamespace: request.principalNamespace,
    serverId: request.serverId,
    generation: request.generation,
    snapshotFingerprint: request.snapshotFingerprint,
    toolName: request.toolName,
    toolSchemaFingerprint: request.toolSchemaFingerprint,
    argumentDigest: request.argumentDigest,
    requestDigest: request.requestDigest,
    authorizationRef,
    auditRef,
    status,
    ...(resultReference ? { resultRef: resultReference, resultDigest } : {}),
    ...(errorCode ? { errorCode } : {})
  };
  return deepFreeze(receipt);
}

export class CachedMcpHost {
  readonly #serverId: string;
  readonly #discovery: McpDiscoveryTransport;
  readonly #dispatcher: McpAuditedDispatcher;
  readonly #maxConcurrency: number;
  readonly #callTimeoutMs: number;
  readonly #discoveryTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #maxStaleMs: number;
  readonly #maxTrackedCallIds: number;
  readonly #now: () => number;
  #lifecycle: McpHostLifecycle = "idle";
  #snapshot?: McpToolSnapshot;
  #discoveryPromise?: Promise<McpToolSnapshot>;
  #discoveryPhysical = false;
  #discoveryController?: AbortController;
  #requestSequence = 0;
  #logicalCalls = 0;
  #physicalCalls = 0;
  #completedCalls = 0;
  #failedCalls = 0;
  #uncertainCalls = 0;
  #invalidReceipts = 0;
  #lateSettlements = 0;
  #controllers = new Set<AbortController>();
  #cancelCalls = new Map<AbortController, (reason: McpUncertainCall["reason"]) => void>();
  #callIds = new Set<string>();
  #shutdownPromise?: Promise<McpShutdownResult>;

  constructor(options: CachedMcpHostOptions) {
    const value = ordinaryObject(options, "cached MCP host options");
    exact(value, HOST_OPTION_KEYS, "cached MCP host options");
    this.#serverId = serverId(value.serverId);
    const discovery = ordinaryObject(value.discovery, "MCP discovery transport");
    const dispatcher = ordinaryObject(value.dispatcher, "MCP audited dispatcher");
    if (typeof discovery.discover !== "function") throw new Error("MCP discovery transport requires discover()");
    if (typeof dispatcher.dispatch !== "function") throw new Error("MCP audited dispatcher requires dispatch()");
    this.#discovery = value.discovery as McpDiscoveryTransport;
    this.#dispatcher = value.dispatcher as McpAuditedDispatcher;
    this.#maxConcurrency = boundedOption(value.maxConcurrency, 4, "maxConcurrency", MAX_CONCURRENCY);
    this.#callTimeoutMs = boundedOption(value.callTimeoutMs, 30_000, "callTimeoutMs", MAX_TIMEOUT_MS);
    this.#discoveryTimeoutMs = boundedOption(value.discoveryTimeoutMs, 30_000, "discoveryTimeoutMs", MAX_TIMEOUT_MS);
    this.#shutdownTimeoutMs = boundedOption(value.shutdownTimeoutMs, 10_000, "shutdownTimeoutMs", MAX_TIMEOUT_MS);
    this.#maxStaleMs = value.maxStaleMs === undefined ? 0 : integer(value.maxStaleMs, "maxStaleMs", 0, MAX_STALE_MS);
    this.#maxTrackedCallIds = boundedOption(value.maxTrackedCallIds, 4_096, "maxTrackedCallIds", MAX_TRACKED_CALL_IDS);
    if (value.now !== undefined && typeof value.now !== "function") throw new Error("now must be a function");
    this.#now = (value.now as (() => number) | undefined) ?? Date.now;
  }

  get serverId(): string { return this.#serverId; }

  snapshot(): McpToolSnapshot | undefined { return this.#snapshot; }

  status(): McpHostStatus {
    return Object.freeze({
      lifecycle: this.#lifecycle,
      snapshotState: snapshotState(this.#snapshot, this.#readNow()),
      ...(this.#snapshot ? { generation: this.#snapshot.generation, snapshotFingerprint: this.#snapshot.fingerprint } : {}),
      discoveryInFlight: Boolean(this.#discoveryPromise),
      discoveryPhysicallyPending: this.#discoveryPhysical,
      logicalCalls: this.#logicalCalls,
      physicalCalls: this.#physicalCalls,
      pendingPhysicalCalls: this.#physicalCalls,
      completedCalls: this.#completedCalls,
      failedCalls: this.#failedCalls,
      uncertainCalls: this.#uncertainCalls,
      invalidReceipts: this.#invalidReceipts,
      lateSettlements: this.#lateSettlements,
      trackedCallIds: this.#callIds.size
    });
  }

  start(): Promise<McpToolSnapshot> {
    if (this.#lifecycle === "stopping" || this.#lifecycle === "stopped") return Promise.reject(new Error("cached MCP host is stopped"));
    if (this.#snapshot) {
      this.#lifecycle = "running";
      return Promise.resolve(this.#snapshot);
    }
    this.#lifecycle = "running";
    return this.#discover("start");
  }

  refresh(): Promise<McpToolSnapshot> {
    if (this.#lifecycle !== "running") return Promise.reject(new Error("cached MCP host must be started before refresh"));
    return this.#discover("refresh");
  }

  async invoke(input: {
    callId: string;
    principalNamespace: string;
    generation: number;
    snapshotFingerprint: string;
    toolName: string;
    toolSchemaFingerprint: string;
    arguments: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<McpCallOutcome> {
    if (this.#lifecycle !== "running") throw new Error("cached MCP host is not running");
    const value = ordinaryObject(input, "MCP invocation");
    exact(value, new Set(["callId", "principalNamespace", "generation", "snapshotFingerprint", "toolName", "toolSchemaFingerprint", "arguments", "signal", "timeoutMs"]), "MCP invocation");
    const snapshot = this.#snapshot;
    if (!snapshot || snapshotState(snapshot, this.#readNow()) !== "fresh") throw new Error("MCP tool snapshot is not fresh; explicit refresh is required");
    if (value.generation !== snapshot.generation || value.snapshotFingerprint !== snapshot.fingerprint) throw new Error("MCP invocation snapshot pin does not match");
    const name = toolName(value.toolName);
    const tool = snapshot.tools.find((item) => item.name === name);
    if (!tool || value.toolSchemaFingerprint !== tool.schemaFingerprint) throw new Error("MCP invocation tool/schema pin does not match");
    if (this.#physicalCalls >= this.#maxConcurrency) throw new Error("MCP physical call capacity is exhausted");
    const callId = id(value.callId, "callId");
    const principalNamespace = id(value.principalNamespace, "principalNamespace");
    const args = validateArguments(value.arguments, tool.inputSchema);
    const argumentDigest = digest(args);
    const requestBase = {
      schemaVersion: MCP_HOST_SCHEMA_VERSION,
      callId,
      principalNamespace,
      serverId: this.#serverId,
      generation: snapshot.generation,
      snapshotFingerprint: snapshot.fingerprint,
      toolName: name,
      toolSchemaFingerprint: tool.schemaFingerprint,
      argumentDigest,
      arguments: args,
      requiresAuthorization: true as const,
      requiresAudit: true as const
    };
    const request = deepFreeze({ ...requestBase, requestDigest: digest(requestBase) });
    const timeoutMs = value.timeoutMs === undefined ? this.#callTimeoutMs : integer(value.timeoutMs, "timeoutMs", 1, this.#callTimeoutMs);
    const callerSignal = value.signal;
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) throw new Error("signal must be an AbortSignal");
    if (callerSignal?.aborted) throw new Error("MCP invocation was cancelled before dispatch");
    if (this.#callIds.has(callId)) throw new Error("MCP callId has already been used by this host");
    if (this.#callIds.size >= this.#maxTrackedCallIds) throw new Error("MCP callId admission capacity is exhausted");
    this.#callIds.add(callId);

    const controller = new AbortController();
    this.#controllers.add(controller);
    this.#logicalCalls += 1;
    this.#physicalCalls += 1;
    let logicalSettled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const physical = Promise.resolve().then(() => this.#dispatcher.dispatch(request, controller.signal));
    const validatedPhysical = physical.then((receipt) => {
      try {
        return validateReceipt(receipt, request);
      } catch (error) {
        this.#invalidReceipts += 1;
        throw error;
      }
    });
    void validatedPhysical.then(
      () => { if (logicalSettled) this.#lateSettlements += 1; },
      () => { if (logicalSettled) this.#lateSettlements += 1; }
    ).finally(() => {
      this.#physicalCalls -= 1;
      this.#controllers.delete(controller);
      this.#cancelCalls.delete(controller);
    });

    let settleUncertain!: (reason: McpUncertainCall["reason"]) => void;
    const timeoutOutcome = new Promise<McpUncertainCall>((resolve) => {
      let settled = false;
      settleUncertain = (reason) => {
        if (settled) return;
        settled = true;
        controller.abort();
        resolve(this.#uncertain(request, reason));
      };
      this.#cancelCalls.set(controller, settleUncertain);
      timeout = setTimeout(() => {
        settleUncertain("timeout");
      }, timeoutMs);
      abortListener = () => {
        settleUncertain(this.#lifecycle === "running" ? "cancelled" : "shutdown");
      };
      callerSignal?.addEventListener("abort", abortListener, { once: true });
    });
    try {
      const result = await Promise.race([
        validatedPhysical.then((validated) => {
          if (validated.status === "completed") this.#completedCalls += 1;
          else this.#failedCalls += 1;
          return validated;
        }, (error) => {
          this.#failedCalls += 1;
          void error;
          throw new Error("MCP audited dispatch failed or returned an invalid receipt");
        }),
        timeoutOutcome
      ]);
      return result;
    } finally {
      logicalSettled = true;
      this.#logicalCalls -= 1;
      if (timeout) clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortListener!);
    }
  }

  shutdown(): Promise<McpShutdownResult> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#lifecycle = "stopping";
    this.#discoveryController?.abort();
    for (const controller of this.#controllers) {
      this.#cancelCalls.get(controller)?.("shutdown");
      controller.abort();
    }
    this.#shutdownPromise = (async () => {
      const deadline = Date.now() + this.#shutdownTimeoutMs;
      while ((this.#physicalCalls > 0 || this.#discoveryPhysical) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
      }
      this.#lifecycle = "stopped";
      return Object.freeze({
        stopped: true as const,
        pendingPhysicalCalls: this.#physicalCalls,
        discoveryPhysicallyPending: this.#discoveryPhysical
      });
    })();
    return this.#shutdownPromise;
  }

  #uncertain(request: McpCallRequest, reason: McpUncertainCall["reason"]): McpUncertainCall {
    this.#uncertainCalls += 1;
    return Object.freeze({
      schemaVersion: MCP_HOST_SCHEMA_VERSION,
      callId: request.callId,
      requestDigest: request.requestDigest,
      status: "needs-review",
      reason,
      physicalPending: true
    });
  }

  #discover(reason: McpDiscoveryRequest["reason"]): Promise<McpToolSnapshot> {
    if (this.#discoveryPromise) return this.#discoveryPromise;
    if (this.#discoveryPhysical) return Promise.reject(new Error("previous MCP discovery remains physically pending"));
    const request = deepFreeze({
      schemaVersion: MCP_HOST_SCHEMA_VERSION,
      requestId: `discovery-${++this.#requestSequence}`,
      serverId: this.#serverId,
      reason
    } satisfies McpDiscoveryRequest);
    const controller = new AbortController();
    this.#discoveryController = controller;
    this.#discoveryPhysical = true;
    let accepted = true;
    const physical = Promise.resolve()
      .then(() => this.#discovery.discover(request, controller.signal))
      .catch(() => { throw new Error("MCP discovery transport failed"); });
    const timed = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        accepted = false;
        controller.abort();
        reject(new Error("MCP discovery timed out"));
      }, this.#discoveryTimeoutMs);
      void physical.finally(() => clearTimeout(timer)).catch(() => {});
    });
    this.#discoveryPromise = Promise.race([physical, timed]).then((result) => {
      if (!accepted || this.#lifecycle !== "running") throw new Error("MCP discovery result arrived after cancellation");
      const snapshot = this.#validateDiscovery(result, request);
      this.#snapshot = snapshot;
      return snapshot;
    }).finally(() => {
      this.#discoveryPromise = undefined;
      this.#discoveryController = undefined;
    });
    void physical.then(() => {}, () => {}).finally(() => { this.#discoveryPhysical = false; });
    return this.#discoveryPromise;
  }

  #validateDiscovery(input: unknown, request: McpDiscoveryRequest): McpToolSnapshot {
    const parsed = parseBoundedRawJson(input, "MCP discovery result", MCP_HOST_MAX_DISCOVERY_BYTES);
    const value = ordinaryObject(cleanJson(parsed, "MCP discovery result", MCP_HOST_MAX_SNAPSHOT_BYTES), "MCP discovery result");
    exact(value, DISCOVERY_RESULT_KEYS, "MCP discovery result");
    if (value.schemaVersion !== MCP_HOST_SCHEMA_VERSION || value.requestId !== request.requestId || value.serverId !== this.#serverId) {
      throw new Error("MCP discovery result does not match its request");
    }
    const generation = integer(value.generation, "MCP discovery generation", 1, Number.MAX_SAFE_INTEGER);
    if (this.#snapshot && generation <= this.#snapshot.generation) throw new Error("MCP discovery generation must increase");
    const validForMs = integer(value.validForMs, "MCP discovery validForMs", 1, MAX_TTL_MS);
    const toolsInput = ordinaryArray(value.tools, "MCP discovery tools", MCP_HOST_MAX_TOOLS);
    const tools = toolsInput.map((item, index): McpToolDefinition => {
      const tool = ordinaryObject(item, `MCP tool ${index + 1}`);
      exact(tool, TOOL_KEYS, `MCP tool ${index + 1}`);
      const name = toolName(tool.name);
      const inputSchema = normalizeSchema(tool.inputSchema);
      return deepFreeze({ name, inputSchema, schemaFingerprint: digest(inputSchema) });
    }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error("MCP discovery returned duplicate tool names");
    const discoveredAtMs = this.#readNow();
    const expiresAtMs = discoveredAtMs + validForMs;
    if (!Number.isSafeInteger(expiresAtMs)) throw new Error("MCP discovery expiry exceeds safe integer range");
    const staleUntilMs = expiresAtMs + this.#maxStaleMs;
    if (!Number.isSafeInteger(staleUntilMs)) throw new Error("MCP discovery stale window exceeds safe integer range");
    const content = {
      schemaVersion: MCP_HOST_SCHEMA_VERSION,
      serverId: this.#serverId,
      generation,
      discoveredAtMs,
      expiresAtMs,
      staleUntilMs,
      tools
    };
    const fingerprint = digest(content);
    const snapshot = deepFreeze({ ...content, fingerprint });
    if (Buffer.byteLength(stableJson(snapshot), "utf8") > MCP_HOST_MAX_SNAPSHOT_BYTES) throw new Error(`MCP snapshot exceeds ${MCP_HOST_MAX_SNAPSHOT_BYTES} UTF-8 bytes`);
    return snapshot;
  }

  #readNow(): number {
    const value = this.#now();
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("MCP host clock must return a non-negative safe integer");
    return value;
  }
}

export function createCachedMcpHost(options: CachedMcpHostOptions): CachedMcpHost {
  return new CachedMcpHost(options);
}
