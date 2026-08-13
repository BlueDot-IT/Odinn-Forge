import {
  APPLICATION_CONTRACT_VERSION,
  type JsonObject,
  type JsonValue
} from "../contracts.ts";
import {
  containsSensitiveApplicationValue,
  isAmbiguousApplicationMetadataKey,
  isSensitiveApplicationMetadataKey
} from "../sensitive-metadata.ts";
import { ApplicationContractValidationError, invalid } from "./errors.ts";
import {
  MAX_ID_BYTES,
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  MAX_LIST_ITEMS,
  MAX_REFERENCE_BYTES,
  MAX_STRING_BYTES,
  RESERVED_KEYS
} from "./limits.ts";

export function jsonObject(input: unknown, name: string, rejectSensitive: boolean): JsonObject {
  const value = jsonValue(input, name, { rejectSensitive });
  if (value === null || Array.isArray(value) || typeof value !== "object") throw invalid(`${name} must be a JSON object`, undefined, name);
  return value as JsonObject;
}

export function jsonValue(input: unknown, name: string, options: { rejectSensitive?: boolean } = {}): JsonValue {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, path: string, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw invalid(`${name} exceeds ${MAX_JSON_NODES} JSON nodes`, "APPLICATION_JSON_TOO_COMPLEX", path);
    if (depth > MAX_JSON_DEPTH) throw invalid(`${name} exceeds JSON depth ${MAX_JSON_DEPTH}`, "APPLICATION_JSON_TOO_DEEP", path);
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      const value = boundedString(current, path, MAX_STRING_BYTES, true);
      if (options.rejectSensitive && containsSensitiveApplicationValue(value)) throw invalid(`${path} contains secret-like material`, "UNREDACTED_APPLICATION_METADATA", path);
      return value;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Math.abs(current) > Number.MAX_SAFE_INTEGER) throw invalid(`${path} must be a finite safe number`, undefined, path);
      return current;
    }
    if (!current || typeof current !== "object") throw invalid(`${path} contains a non-JSON value`, undefined, path);
    if (seen.has(current)) throw invalid(`${path} contains a cycle`, "CYCLIC_APPLICATION_JSON", path);
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        const items = plainArrayValues(current, path);
        if (items.length > MAX_LIST_ITEMS) throw invalid(`${path} cannot contain more than ${MAX_LIST_ITEMS} items`, undefined, path);
        return items.map((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      }
      const value = exactObject(current, path, [], { allowAdditional: true });
      const output: Record<string, JsonValue> = {};
      const keys = Object.keys(value).sort();
      if (keys.length > MAX_LIST_ITEMS) throw invalid(`${path} cannot contain more than ${MAX_LIST_ITEMS} fields`, undefined, path);
      for (const key of keys) {
        if (RESERVED_KEYS.has(key)) throw invalid(`${path} contains reserved field ${key}`, "RESERVED_APPLICATION_FIELD", `${path}.${key}`);
        if (Buffer.byteLength(key, "utf8") > MAX_ID_BYTES) throw invalid(`${path} field name exceeds ${MAX_ID_BYTES} bytes`, undefined, `${path}.${key}`);
        if (options.rejectSensitive && isAmbiguousApplicationMetadataKey(key)) {
          throw invalid(`${path} contains an ambiguous metadata field`, "AMBIGUOUS_APPLICATION_METADATA_KEY", path);
        }
        if (options.rejectSensitive && isSensitiveApplicationMetadataKey(key) && value[key] !== "[redacted]") {
          throw invalid(`${path}.${key} is not permitted in redacted metadata`, "UNREDACTED_APPLICATION_METADATA", `${path}.${key}`);
        }
        output[key] = visit(value[key], `${path}.${key}`, depth + 1);
      }
      return output;
    } finally {
      seen.delete(current);
    }
  };
  return visit(input, name, 0);
}

export function exactObject(
  input: unknown,
  name: string,
  allowedKeys: readonly string[],
  options: { allowAdditional?: boolean } = {}
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid(`${name} must be a plain object`, undefined, name);
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw invalid(`${name} must be a plain object`, "NON_PLAIN_APPLICATION_OBJECT", name);
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string")) throw invalid(`${name} cannot contain symbol fields`, "NON_JSON_APPLICATION_FIELD", name);
  const stringKeys = keys as string[];
  const allowed = new Set(allowedKeys);
  if (!options.allowAdditional) {
    const unknownKey = stringKeys.find((key) => !allowed.has(key));
    if (unknownKey !== undefined) throw invalid(`${name} contains unknown field: ${unknownKey}`, "UNKNOWN_APPLICATION_FIELD", `${name}.${unknownKey}`);
  }
  for (const key of stringKeys) {
    if (RESERVED_KEYS.has(key)) throw invalid(`${name} contains reserved field: ${key}`, "RESERVED_APPLICATION_FIELD", `${name}.${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid(`${name}.${key} must be an enumerable data field`, "NON_JSON_APPLICATION_FIELD", `${name}.${key}`);
  }
  return input as Record<string, unknown>;
}

export function plainArrayValues(input: readonly unknown[], name: string): readonly unknown[] {
  if (Object.getPrototypeOf(input) !== Array.prototype) throw invalid(`${name} must be a plain array`, "NON_PLAIN_APPLICATION_OBJECT", name);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    throw invalid(`${name}.length must be a safe data field`, "NON_JSON_APPLICATION_FIELD", `${name}.length`);
  }
  const length = Number(lengthDescriptor.value);
  if (length > MAX_LIST_ITEMS) throw invalid(`${name} cannot contain more than ${MAX_LIST_ITEMS} items`, undefined, name);
  const keys = Reflect.ownKeys(input);
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key)) {
      throw invalid(`${name} cannot contain extra fields`, "NON_JSON_APPLICATION_FIELD", name);
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index >= length) {
      throw invalid(`${name} cannot contain an out-of-range numeric field`, "NON_JSON_APPLICATION_FIELD", `${name}.${key}`);
    }
  }
  const output = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor) throw invalid(`${name} cannot contain sparse entries`, "NON_JSON_APPLICATION_FIELD", `${name}[${index}]`);
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw invalid(`${name}[${index}] must be an enumerable data field`, "NON_JSON_APPLICATION_FIELD", `${name}[${index}]`);
    }
    output[index] = descriptor.value;
  }
  return output;
}

export function referenceList(input: unknown, name: string, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(input)) throw invalid(`${name} must be an array`, undefined, name);
  const items = plainArrayValues(input, name);
  if (items.length > MAX_LIST_ITEMS || (!allowEmpty && items.length === 0)) throw invalid(`${name} has an invalid item count`, undefined, name);
  const values = items.map((item, index) => reference(item, `${name}[${index}]`));
  if (new Set(values).size !== values.length) throw invalid(`${name} cannot contain duplicate references`, undefined, name);
  return values;
}

export function versionAndKind(value: Record<string, unknown>, kind: string): void {
  if (value.version !== APPLICATION_CONTRACT_VERSION) throw invalid(`unsupported application contract version: ${String(value.version)}`, "UNSUPPORTED_APPLICATION_CONTRACT_VERSION", "version");
  if (value.kind !== kind) throw invalid(`expected application contract kind ${kind}`, "UNSUPPORTED_APPLICATION_ENVELOPE_KIND", "kind");
}

export function identifier(input: unknown, name: string): string {
  const value = boundedString(input, name, MAX_ID_BYTES);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)) throw invalid(`${name} contains unsupported characters`, undefined, name);
  return value;
}

export function reference(input: unknown, name: string): string {
  const value = boundedString(input, name, MAX_REFERENCE_BYTES);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/u.test(value)) throw invalid(`${name} must be an opaque non-secret reference`, undefined, name);
  return value;
}

export function sha256(input: unknown, name: string): string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input)) throw invalid(`${name} must be a lowercase SHA-256 digest`, undefined, name);
  return input;
}

export function timestamp(input: unknown, name: string): string {
  const value = boundedString(input, name, 64);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) throw invalid(`${name} must be a canonical UTC ISO timestamp`, undefined, name);
  return value;
}

export function boundedString(input: unknown, name: string, maxBytes: number, allowEmpty = false): string {
  if (typeof input !== "string" || (!allowEmpty && input.length === 0)) throw invalid(`${name} must be ${allowEmpty ? "a" : "a non-empty"} string`, undefined, name);
  if (input.trim() !== input && !allowEmpty) throw invalid(`${name} cannot have leading or trailing whitespace`, undefined, name);
  if (Buffer.byteLength(input, "utf8") > maxBytes) throw invalid(`${name} exceeds ${maxBytes} bytes`, undefined, name);
  return input;
}

export function safeString(input: unknown, name: string, maxBytes: number): string {
  const value = boundedString(input, name, maxBytes);
  if (containsSensitiveApplicationValue(value)) throw invalid(`${name} contains secret-like material`, "UNREDACTED_APPLICATION_ERROR", name);
  return value;
}

export function nonnegativeInteger(input: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(input) || Number(input) < 0 || Number(input) > maximum) throw invalid(`${name} must be a non-negative safe integer no greater than ${maximum}`, undefined, name);
  return Number(input);
}

export function enumValue<const Value extends string>(input: unknown, name: string, values: readonly Value[]): Value {
  if (typeof input !== "string" || !values.includes(input as Value)) throw invalid(`${name} has an unsupported value`, undefined, name);
  return input as Value;
}

export function rejectDuplicateJsonObjectKeys(source: string): void {
  let offset = 0;
  const whitespace = /\s/u;
  const skipWhitespace = () => { while (offset < source.length && whitespace.test(source[offset]!)) offset += 1; };
  const readString = (): string => {
    const start = offset;
    if (source[offset] !== '"') throw invalid(`invalid JSON string at offset ${offset}`);
    offset += 1;
    while (offset < source.length) {
      const character = source[offset]!;
      if (character === '"') {
        offset += 1;
        try {
          const value = JSON.parse(source.slice(start, offset)) as unknown;
          if (typeof value !== "string") throw invalid(`invalid JSON string at offset ${start}`);
          return value;
        } catch (error) {
          if (error instanceof ApplicationContractValidationError) throw error;
          throw invalid(`invalid JSON string at offset ${start}`);
        }
      }
      if (character === "\\") offset += 1;
      offset += 1;
    }
    throw invalid(`unterminated JSON string at offset ${start}`);
  };
  const readValue = (): void => {
    skipWhitespace();
    const character = source[offset];
    if (character === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[offset] === "}") { offset += 1; return; }
      while (offset < source.length) {
        skipWhitespace();
        const key = readString();
        if (keys.has(key)) throw invalid(`duplicate JSON object field: ${key}`, "DUPLICATE_APPLICATION_FIELD");
        keys.add(key);
        skipWhitespace();
        if (source[offset] !== ":") throw invalid(`expected ':' at offset ${offset}`);
        offset += 1;
        readValue();
        skipWhitespace();
        if (source[offset] === "}") { offset += 1; return; }
        if (source[offset] !== ",") throw invalid(`expected ',' or '}' at offset ${offset}`);
        offset += 1;
      }
      throw invalid("unterminated JSON object");
    }
    if (character === "[") {
      offset += 1;
      skipWhitespace();
      if (source[offset] === "]") { offset += 1; return; }
      while (offset < source.length) {
        readValue();
        skipWhitespace();
        if (source[offset] === "]") { offset += 1; return; }
        if (source[offset] !== ",") throw invalid(`expected ',' or ']' at offset ${offset}`);
        offset += 1;
      }
      throw invalid("unterminated JSON array");
    }
    if (character === '"') { readString(); return; }
    const start = offset;
    while (offset < source.length && !/[\s,}\]]/u.test(source[offset]!)) offset += 1;
    if (start === offset) throw invalid(`invalid JSON value at offset ${offset}`);
    try { JSON.parse(source.slice(start, offset)) as unknown; } catch { throw invalid(`invalid JSON value at offset ${start}`); }
  };
  readValue();
  skipWhitespace();
  if (offset !== source.length) throw invalid(`unexpected JSON content at offset ${offset}`);
}
