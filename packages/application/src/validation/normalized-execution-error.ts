import type { NormalizedExecutionErrorV1 } from "../contracts.ts";
import { invalid } from "./errors.ts";
import {
  enumValue,
  exactObject,
  identifier,
  jsonObject,
  nonnegativeInteger,
  safeString
} from "./json-safety.ts";
import { MAX_RETRY_AFTER_MS } from "./limits.ts";

export function normalizedError(input: unknown, name: string): NormalizedExecutionErrorV1 {
  const value = exactObject(input, name, ["code", "message", "category", "retryable", "retryAfterMs", "redactedDetails"]);
  if (typeof value.retryable !== "boolean") throw invalid(`${name}.retryable must be a boolean`);
  const error: NormalizedExecutionErrorV1 = {
    code: identifier(value.code, `${name}.code`),
    message: safeString(value.message, `${name}.message`, 4_096),
    category: enumValue(value.category, `${name}.category`, ["authorization", "validation", "conflict", "cancelled", "dependency", "timeout", "internal"]),
    retryable: value.retryable,
    ...(value.retryAfterMs === undefined ? {} : { retryAfterMs: nonnegativeInteger(value.retryAfterMs, `${name}.retryAfterMs`, MAX_RETRY_AFTER_MS) }),
    ...(value.redactedDetails === undefined ? {} : { redactedDetails: jsonObject(value.redactedDetails, `${name}.redactedDetails`, true) })
  };
  if (!error.retryable && error.retryAfterMs !== undefined) throw invalid(`${name}.retryAfterMs requires retryable=true`);
  return error;
}
