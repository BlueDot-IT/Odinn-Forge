import { MAX_APPLICATION_CONTRACT_BYTES, type JsonObject, type JsonValue } from "./contracts.ts";
import {
  isAmbiguousApplicationMetadataKey,
  isSensitiveApplicationMetadataKey
} from "./sensitive-metadata.ts";
import { ApplicationContractValidationError } from "./validation.ts";

const MAX_ID_BYTES = 256;
const MAX_STRING_BYTES = 65_536;
const MAX_LIST_ITEMS = 512;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 8_192;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SENSITIVE_VALUES = [
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|capability(?:[_-]?token)?|token|authorization|cookie|credentials?|password(?:[_-]?hash)?|passwd|secret|client[_-]?secret|bot[_-]?(?:secret|token)|private[_-]?key)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/iu,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/iu,
  /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/iu,
  /\b(?:gh[pousr]_|github_pat_|glpat-|npm_|xox[baprs]-)[A-Za-z0-9_-]{10,}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bAIza[A-Za-z0-9_-]{30,}\b/u,
  /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{16,}\b/u,
  /\b(?:sk|rk)(?:[_-](?:live|test))?[_-][A-Za-z0-9_-]{8,}\b/u,
  /\b(?:access|refresh|id|api|client|bot)[ _-]?(?:key|token|secret)\s*(?:is|[:=])?\s*[A-Za-z0-9._~+\/-]{8,}\b/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\b(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,})\b/u,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/iu,
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u
];

interface ReadContractSensitiveFieldContext {
  readonly path: string;
  readonly key: string;
  readonly value: unknown;
}

interface ReadContractJsonOptions {
  readonly allowSensitiveField?: (context: ReadContractSensitiveFieldContext) => boolean;
}

export function normalizeReadContractJsonValueV1(
  input: unknown,
  name: string,
  options: ReadContractJsonOptions = {},
): JsonValue {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, path: string, depth: number, arrayItem = false): JsonValue | undefined => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) fail(`${name} exceeds ${MAX_JSON_NODES} JSON nodes`, "APPLICATION_JSON_TOO_COMPLEX", path);
    if (depth > MAX_JSON_DEPTH) fail(`${name} exceeds JSON depth ${MAX_JSON_DEPTH}`, "APPLICATION_JSON_TOO_DEEP", path);
    if (current === undefined) return arrayItem ? null : undefined;
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      if (Buffer.byteLength(current, "utf8") > MAX_STRING_BYTES) fail(`${path} exceeds ${MAX_STRING_BYTES} bytes`, "INVALID_APPLICATION_READ_CONTRACT", path);
      if (SENSITIVE_VALUES.some((pattern) => pattern.test(current))) fail(`${path} contains secret-like material`, "UNREDACTED_APPLICATION_METADATA", path);
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Math.abs(current) > Number.MAX_SAFE_INTEGER) fail(`${path} must be a finite safe number`, "INVALID_APPLICATION_READ_CONTRACT", path);
      return current;
    }
    if (!current || typeof current !== "object") fail(`${path} contains a non-JSON value`, "INVALID_APPLICATION_READ_CONTRACT", path);
    if (seen.has(current)) fail(`${path} contains a cycle`, "CYCLIC_APPLICATION_JSON", path);
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        const items = plainArrayValues(current, path);
        return items.map((item, index) => visit(item, `${path}[${index}]`, depth + 1, true) ?? null);
      }
      const value = plainObject(current, path);
      const output: Record<string, JsonValue> = {};
      const keys = Object.keys(value);
      if (keys.length > MAX_LIST_ITEMS) fail(`${path} cannot contain more than ${MAX_LIST_ITEMS} fields`, "INVALID_APPLICATION_READ_CONTRACT", path);
      for (const key of keys) {
        if (Buffer.byteLength(key, "utf8") > MAX_ID_BYTES) fail(`${path} field name exceeds ${MAX_ID_BYTES} bytes`, "INVALID_APPLICATION_READ_CONTRACT", `${path}.${key}`);
        if (isAmbiguousApplicationMetadataKey(key)) fail(`${path} contains an ambiguous metadata field`, "AMBIGUOUS_APPLICATION_METADATA_KEY", path);
        if (isSensitiveApplicationMetadataKey(key)
          && value[key] !== "[redacted]"
          && options.allowSensitiveField?.({ path, key, value: value[key] }) !== true) {
          fail(`${path}.${key} is not permitted in a read contract`, "UNREDACTED_APPLICATION_METADATA", `${path}.${key}`);
        }
        const normalized = visit(value[key], `${path}.${key}`, depth + 1);
        if (normalized !== undefined) output[key] = normalized;
      }
      return output;
    } finally {
      seen.delete(current);
    }
  };
  const normalized = visit(input, name, 0);
  if (normalized === undefined) fail(`${name} must be a JSON value`, "INVALID_APPLICATION_READ_CONTRACT", name);
  const canonical = canonicalJson(normalized);
  if (Buffer.byteLength(canonical, "utf8") > MAX_APPLICATION_CONTRACT_BYTES) fail(`${name} exceeds ${MAX_APPLICATION_CONTRACT_BYTES} bytes`, "APPLICATION_CONTRACT_TOO_LARGE", name);
  return deepFreeze(normalized);
}

export function normalizeReadContractJsonObjectV1(
  input: unknown,
  name: string,
  options: ReadContractJsonOptions = {},
): JsonObject {
  const normalized = normalizeReadContractJsonValueV1(input, name, options);
  if (!normalized || Array.isArray(normalized) || typeof normalized !== "object") fail(`${name} must be a JSON object`, "INVALID_APPLICATION_READ_CONTRACT", name);
  return normalized as JsonObject;
}

export function parseReadContractJsonObjectV1(
  source: string,
  name: string,
  options: ReadContractJsonOptions = {},
): JsonObject {
  if (typeof source !== "string") fail(`${name} source must be a JSON string`, "INVALID_APPLICATION_READ_CONTRACT", name);
  if (Buffer.byteLength(source, "utf8") > MAX_APPLICATION_CONTRACT_BYTES) fail(`${name} exceeds ${MAX_APPLICATION_CONTRACT_BYTES} bytes`, "APPLICATION_CONTRACT_TOO_LARGE", name);
  rejectDuplicateJsonObjectKeys(source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    fail(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, "INVALID_APPLICATION_READ_CONTRACT", name);
  }
  return normalizeReadContractJsonObjectV1(parsed, name, options);
}

function plainObject(input: object, path: string): Record<string, unknown> {
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) fail(`${path} must be a plain object`, "NON_PLAIN_APPLICATION_OBJECT", path);
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string")) fail(`${path} cannot contain symbol fields`, "NON_JSON_APPLICATION_FIELD", path);
  for (const key of keys as string[]) {
    if (RESERVED_KEYS.has(key)) fail(`${path} contains reserved field: ${key}`, "RESERVED_APPLICATION_FIELD", `${path}.${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) fail(`${path}.${key} must be an enumerable data field`, "NON_JSON_APPLICATION_FIELD", `${path}.${key}`);
  }
  return input as Record<string, unknown>;
}

function plainArrayValues(input: readonly unknown[], path: string): readonly unknown[] {
  if (Object.getPrototypeOf(input) !== Array.prototype) fail(`${path} must be a plain array`, "NON_PLAIN_APPLICATION_OBJECT", path);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    fail(`${path}.length must be a safe data field`, "NON_JSON_APPLICATION_FIELD", `${path}.length`);
  }
  const length = Number(lengthDescriptor.value);
  if (length > MAX_LIST_ITEMS) fail(`${path} cannot contain more than ${MAX_LIST_ITEMS} items`, "INVALID_APPLICATION_READ_CONTRACT", path);
  const keys = Reflect.ownKeys(input);
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key)) {
      fail(`${path} cannot contain extra fields`, "NON_JSON_APPLICATION_FIELD", path);
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index >= length) {
      fail(`${path} cannot contain an out-of-range numeric field`, "NON_JSON_APPLICATION_FIELD", `${path}.${key}`);
    }
  }
  const output = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor) fail(`${path} cannot contain sparse entries`, "NON_JSON_APPLICATION_FIELD", `${path}[${index}]`);
    if (!descriptor.enumerable || !("value" in descriptor)) {
      fail(`${path}[${index}] must be an enumerable data field`, "NON_JSON_APPLICATION_FIELD", `${path}[${index}]`);
    }
    output[index] = descriptor.value;
  }
  return output;
}

function canonicalJson(input: unknown): string {
  if (input === null || typeof input === "string" || typeof input === "boolean" || typeof input === "number") return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
  const value = input as Record<string, unknown>;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function deepFreeze<T>(input: T): T {
  if (input && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}

function rejectDuplicateJsonObjectKeys(source: string): void {
  let offset = 0;
  const skipWhitespace = () => { while (offset < source.length && /\s/u.test(source[offset]!)) offset += 1; };
  const readString = (): string => {
    const start = offset;
    if (source[offset] !== '"') fail(`invalid JSON string at offset ${offset}`, "INVALID_APPLICATION_READ_CONTRACT", "source");
    offset += 1;
    while (offset < source.length) {
      const character = source[offset]!;
      if (character === '"') {
        offset += 1;
        try { return JSON.parse(source.slice(start, offset)) as string; }
        catch { fail(`invalid JSON string at offset ${start}`, "INVALID_APPLICATION_READ_CONTRACT", "source"); }
      }
      if (character === "\\") offset += 1;
      offset += 1;
    }
    fail(`unterminated JSON string at offset ${start}`, "INVALID_APPLICATION_READ_CONTRACT", "source");
  };
  const readValue = (depth = 0): void => {
    if (depth > MAX_JSON_DEPTH) fail(`read contract JSON exceeds depth ${MAX_JSON_DEPTH}`, "APPLICATION_JSON_TOO_DEEP", "source");
    skipWhitespace();
    const character = source[offset];
    if (character === "{") {
      offset += 1; skipWhitespace();
      const keys = new Set<string>();
      if (source[offset] === "}") { offset += 1; return; }
      while (offset < source.length) {
        skipWhitespace();
        const key = readString();
        if (keys.has(key)) fail(`duplicate JSON object field: ${key}`, "DUPLICATE_APPLICATION_FIELD", key);
        keys.add(key); skipWhitespace();
        if (source[offset] !== ":") fail(`expected ':' at offset ${offset}`, "INVALID_APPLICATION_READ_CONTRACT", "source");
        offset += 1; readValue(depth + 1); skipWhitespace();
        if (source[offset] === "}") { offset += 1; return; }
        if (source[offset] !== ",") fail(`expected ',' at offset ${offset}`, "INVALID_APPLICATION_READ_CONTRACT", "source");
        offset += 1;
      }
      fail("unterminated JSON object", "INVALID_APPLICATION_READ_CONTRACT", "source");
    }
    if (character === "[") {
      offset += 1; skipWhitespace();
      if (source[offset] === "]") { offset += 1; return; }
      while (offset < source.length) {
        readValue(depth + 1); skipWhitespace();
        if (source[offset] === "]") { offset += 1; return; }
        if (source[offset] !== ",") fail(`expected ',' at offset ${offset}`, "INVALID_APPLICATION_READ_CONTRACT", "source");
        offset += 1;
      }
      fail("unterminated JSON array", "INVALID_APPLICATION_READ_CONTRACT", "source");
    }
    if (character === '"') { readString(); return; }
    const start = offset;
    while (offset < source.length && !/[\s,\]}]/u.test(source[offset]!)) offset += 1;
    if (start === offset) fail(`invalid JSON value at offset ${offset}`, "INVALID_APPLICATION_READ_CONTRACT", "source");
  };
  readValue(); skipWhitespace();
  if (offset !== source.length) fail(`unexpected JSON content at offset ${offset}`, "INVALID_APPLICATION_READ_CONTRACT", "source");
}

function fail(message: string, code: string, path: string): never {
  throw new ApplicationContractValidationError(message, code, path);
}
