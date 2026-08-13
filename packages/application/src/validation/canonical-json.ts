import { MAX_APPLICATION_CONTRACT_BYTES } from "../contracts.ts";
import { invalid } from "./errors.ts";

export function canonicalJson(input: unknown): string {
  if (input === null || typeof input === "string" || typeof input === "boolean") return JSON.stringify(input);
  if (typeof input === "number") {
    if (!Number.isFinite(input) || Math.abs(input) > Number.MAX_SAFE_INTEGER) throw invalid("application contract contains an unsupported number");
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
  if (input && typeof input === "object") {
    const value = input as Record<string, unknown>;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw invalid("application contract contains a non-JSON value");
}

export function finish<T>(input: T): T {
  const canonical = canonicalJson(input);
  if (Buffer.byteLength(canonical, "utf8") > MAX_APPLICATION_CONTRACT_BYTES) {
    throw invalid(`application contract exceeds ${MAX_APPLICATION_CONTRACT_BYTES} bytes`, "APPLICATION_CONTRACT_TOO_LARGE");
  }
  return deepFreeze(input);
}

function deepFreeze<T>(input: T): T {
  if (input && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}
