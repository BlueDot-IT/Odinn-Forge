import { createHash } from "node:crypto";

export const EXECUTION_ENVELOPE_VERSION = 1 as const;
export const MAX_EXECUTION_ENVELOPE_BYTES = 65_536;

const MAX_ID_BYTES = 256;
const MAX_REFERENCE_BYTES = 2_048;
const MAX_WORKSPACE_ROOT_BYTES = 4_096;
const MAX_LIST_ITEMS = 128;
const MAX_TIMEOUT_MS = 86_400_000;
const MAX_LIMIT = Number.MAX_SAFE_INTEGER;

export type ExecutionKindV1 = "tool" | "agent" | "skill" | "mcp-tool" | "workflow-node";
export type ExecutionRetrySafetyV1 = "retry-safe" | "not-retry-safe" | "unknown";

export interface ExecutionIdentityV1 {
  readonly kind: ExecutionKindV1;
  readonly id: string;
}

export interface ExecutionApprovalRequirementV1 {
  readonly capability: string;
  readonly approvalId?: string;
}

export interface ExecutionResourceLimitsV1 {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxPersistedStateBytes: number;
  readonly maxConcurrency: number;
  readonly memoryBytes?: number;
  readonly cpuTimeMs?: number;
  readonly processCount?: number;
}

export interface ExecutionEnvelopeV1 {
  readonly version: typeof EXECUTION_ENVELOPE_VERSION;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly sessionId?: string;
  readonly projectId?: string;
  readonly principalId: string;
  readonly execution: ExecutionIdentityV1;
  readonly inputDigest: string;
  readonly inputReference: string;
  readonly capabilityDecisionReferences: readonly string[];
  readonly approvalRequirements: readonly ExecutionApprovalRequirementV1[];
  readonly timeoutMs: number;
  readonly resourceLimits: ExecutionResourceLimitsV1;
  readonly idempotencyKey: string;
  readonly retrySafety: ExecutionRetrySafetyV1;
  readonly workspaceRoot: string;
  readonly sandboxProfile: string;
  readonly expectedResultReference?: string;
  readonly auditCorrelationId: string;
  readonly cancellationControlReference: string;
  readonly verificationContractReference?: string;
}

export class ExecutionEnvelopeValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = "INVALID_EXECUTION_ENVELOPE") {
    super(message);
    this.name = "ExecutionEnvelopeValidationError";
    this.code = code;
  }
}

export function parseExecutionEnvelopeV1(source: string): ExecutionEnvelopeV1 {
  if (typeof source !== "string") throw invalid("execution envelope source must be a JSON string");
  const size = Buffer.byteLength(source, "utf8");
  if (size > MAX_EXECUTION_ENVELOPE_BYTES) {
    throw invalid(`execution envelope exceeds ${MAX_EXECUTION_ENVELOPE_BYTES} bytes`, "EXECUTION_ENVELOPE_TOO_LARGE");
  }
  rejectDuplicateJsonObjectKeys(source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw invalid(`execution envelope is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateExecutionEnvelopeV1(parsed);
}

export function validateExecutionEnvelopeV1(input: unknown): ExecutionEnvelopeV1 {
  const value = exactObject(input, "execution envelope", [
    "version", "runId", "parentRunId", "sessionId", "projectId", "principalId", "execution",
    "inputDigest", "inputReference", "capabilityDecisionReferences", "approvalRequirements",
    "timeoutMs", "resourceLimits", "idempotencyKey", "retrySafety", "workspaceRoot", "sandboxProfile",
    "expectedResultReference", "auditCorrelationId", "cancellationControlReference", "verificationContractReference"
  ]);

  if (value.version !== EXECUTION_ENVELOPE_VERSION) {
    throw invalid(`unsupported execution envelope version: ${String(value.version)}`, "UNSUPPORTED_EXECUTION_ENVELOPE_VERSION");
  }

  const envelope: ExecutionEnvelopeV1 = {
    version: EXECUTION_ENVELOPE_VERSION,
    runId: identifier(value.runId, "runId"),
    principalId: identifier(value.principalId, "principalId"),
    execution: executionIdentity(value.execution),
    inputDigest: sha256(value.inputDigest, "inputDigest"),
    inputReference: reference(value.inputReference, "inputReference"),
    capabilityDecisionReferences: referenceList(value.capabilityDecisionReferences, "capabilityDecisionReferences"),
    approvalRequirements: approvalRequirements(value.approvalRequirements),
    timeoutMs: positiveInteger(value.timeoutMs, "timeoutMs", MAX_TIMEOUT_MS),
    resourceLimits: resourceLimits(value.resourceLimits),
    idempotencyKey: identifier(value.idempotencyKey, "idempotencyKey"),
    retrySafety: enumValue(value.retrySafety, "retrySafety", ["retry-safe", "not-retry-safe", "unknown"]),
    workspaceRoot: boundedString(value.workspaceRoot, "workspaceRoot", MAX_WORKSPACE_ROOT_BYTES),
    sandboxProfile: identifier(value.sandboxProfile, "sandboxProfile"),
    auditCorrelationId: identifier(value.auditCorrelationId, "auditCorrelationId"),
    cancellationControlReference: reference(value.cancellationControlReference, "cancellationControlReference"),
    ...(value.parentRunId === undefined ? {} : { parentRunId: identifier(value.parentRunId, "parentRunId") }),
    ...(value.sessionId === undefined ? {} : { sessionId: identifier(value.sessionId, "sessionId") }),
    ...(value.projectId === undefined ? {} : { projectId: identifier(value.projectId, "projectId") }),
    ...(value.expectedResultReference === undefined ? {} : { expectedResultReference: reference(value.expectedResultReference, "expectedResultReference") }),
    ...(value.verificationContractReference === undefined ? {} : { verificationContractReference: reference(value.verificationContractReference, "verificationContractReference") })
  };

  if (envelope.inputReference !== `artifact:sha256:${envelope.inputDigest}`) {
    throw invalid("inputReference must identify the artifact authenticated by inputDigest", "EXECUTION_INPUT_REFERENCE_MISMATCH");
  }

  const canonical = canonicalizeJson(envelope);
  if (Buffer.byteLength(canonical, "utf8") > MAX_EXECUTION_ENVELOPE_BYTES) {
    throw invalid(`execution envelope exceeds ${MAX_EXECUTION_ENVELOPE_BYTES} bytes`, "EXECUTION_ENVELOPE_TOO_LARGE");
  }
  return deepFreeze(envelope);
}

export function canonicalizeExecutionEnvelopeV1(input: ExecutionEnvelopeV1 | unknown): string {
  return canonicalizeJson(validateExecutionEnvelopeV1(input));
}

export function digestExecutionEnvelopeV1(input: ExecutionEnvelopeV1 | unknown): string {
  return createHash("sha256").update(canonicalizeExecutionEnvelopeV1(input), "utf8").digest("hex");
}

function executionIdentity(input: unknown): ExecutionIdentityV1 {
  const value = exactObject(input, "execution", ["kind", "id"]);
  return {
    kind: enumValue(value.kind, "execution.kind", ["tool", "agent", "skill", "mcp-tool", "workflow-node"]),
    id: identifier(value.id, "execution.id")
  };
}

function approvalRequirements(input: unknown): readonly ExecutionApprovalRequirementV1[] {
  if (!Array.isArray(input)) throw invalid("approvalRequirements must be an array");
  if (input.length > MAX_LIST_ITEMS) throw invalid(`approvalRequirements cannot contain more than ${MAX_LIST_ITEMS} items`);
  return input.map((item, index) => {
    const value = exactObject(item, `approvalRequirements[${index}]`, ["capability", "approvalId"]);
    return {
      capability: identifier(value.capability, `approvalRequirements[${index}].capability`),
      ...(value.approvalId === undefined ? {} : { approvalId: identifier(value.approvalId, `approvalRequirements[${index}].approvalId`) })
    };
  });
}

function resourceLimits(input: unknown): ExecutionResourceLimitsV1 {
  const value = exactObject(input, "resourceLimits", [
    "maxInputBytes", "maxOutputBytes", "maxPersistedStateBytes", "maxConcurrency", "memoryBytes", "cpuTimeMs", "processCount"
  ]);
  return {
    maxInputBytes: positiveInteger(value.maxInputBytes, "resourceLimits.maxInputBytes", MAX_LIMIT),
    maxOutputBytes: positiveInteger(value.maxOutputBytes, "resourceLimits.maxOutputBytes", MAX_LIMIT),
    maxPersistedStateBytes: positiveInteger(value.maxPersistedStateBytes, "resourceLimits.maxPersistedStateBytes", MAX_LIMIT),
    maxConcurrency: positiveInteger(value.maxConcurrency, "resourceLimits.maxConcurrency", MAX_LIMIT),
    ...(value.memoryBytes === undefined ? {} : { memoryBytes: positiveInteger(value.memoryBytes, "resourceLimits.memoryBytes", MAX_LIMIT) }),
    ...(value.cpuTimeMs === undefined ? {} : { cpuTimeMs: positiveInteger(value.cpuTimeMs, "resourceLimits.cpuTimeMs", MAX_LIMIT) }),
    ...(value.processCount === undefined ? {} : { processCount: positiveInteger(value.processCount, "resourceLimits.processCount", MAX_LIMIT) })
  };
}

function referenceList(input: unknown, name: string): readonly string[] {
  if (!Array.isArray(input)) throw invalid(`${name} must be an array`);
  if (input.length > MAX_LIST_ITEMS) throw invalid(`${name} cannot contain more than ${MAX_LIST_ITEMS} items`);
  const values = input.map((item, index) => reference(item, `${name}[${index}]`));
  if (new Set(values).size !== values.length) throw invalid(`${name} cannot contain duplicate references`);
  return values;
}

function exactObject(input: unknown, name: string, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid(`${name} must be an object`);
  const value = input as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  const unknownKeys = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknownKeys.length) throw invalid(`${name} contains unknown field: ${unknownKeys[0]}`);
  return value;
}

function identifier(input: unknown, name: string): string {
  const value = boundedString(input, name, MAX_ID_BYTES);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)) throw invalid(`${name} contains unsupported characters`);
  return value;
}

function reference(input: unknown, name: string): string {
  const value = boundedString(input, name, MAX_REFERENCE_BYTES);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/u.test(value)) throw invalid(`${name} must be an opaque non-secret reference`);
  return value;
}

function sha256(input: unknown, name: string): string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input)) throw invalid(`${name} must be a lowercase SHA-256 digest`);
  return input;
}

function boundedString(input: unknown, name: string, maxBytes: number): string {
  if (typeof input !== "string" || input.length === 0) throw invalid(`${name} must be a non-empty string`);
  if (input.trim() !== input) throw invalid(`${name} cannot have leading or trailing whitespace`);
  if (Buffer.byteLength(input, "utf8") > maxBytes) throw invalid(`${name} exceeds ${maxBytes} bytes`);
  return input;
}

function positiveInteger(input: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(input) || Number(input) < 1 || Number(input) > maximum) {
    throw invalid(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return Number(input);
}

function enumValue<const Value extends string>(input: unknown, name: string, values: readonly Value[]): Value {
  if (typeof input !== "string" || !values.includes(input as Value)) throw invalid(`${name} has an unsupported value`);
  return input as Value;
}

function canonicalizeJson(input: unknown): string {
  if (input === null || typeof input === "string" || typeof input === "boolean") return JSON.stringify(input);
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw invalid("execution envelope cannot contain non-finite numbers");
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) return `[${input.map(canonicalizeJson).join(",")}]`;
  if (input && typeof input === "object") {
    const value = input as Record<string, unknown>;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`).join(",")}}`;
  }
  throw invalid("execution envelope contains a non-JSON value");
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
  const whitespace = /\s/u;

  const skipWhitespace = () => {
    while (offset < source.length && whitespace.test(source[offset]!)) offset += 1;
  };

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
          if (error instanceof ExecutionEnvelopeValidationError) throw error;
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
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        skipWhitespace();
        const key = readString();
        if (keys.has(key)) throw invalid(`duplicate JSON object field: ${key}`, "DUPLICATE_EXECUTION_ENVELOPE_FIELD");
        keys.add(key);
        skipWhitespace();
        if (source[offset] !== ":") throw invalid(`expected ':' at offset ${offset}`);
        offset += 1;
        readValue();
        skipWhitespace();
        if (source[offset] === "}") {
          offset += 1;
          return;
        }
        if (source[offset] !== ",") throw invalid(`expected ',' or '}' at offset ${offset}`);
        offset += 1;
      }
      throw invalid("unterminated JSON object");
    }
    if (character === "[") {
      offset += 1;
      skipWhitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        readValue();
        skipWhitespace();
        if (source[offset] === "]") {
          offset += 1;
          return;
        }
        if (source[offset] !== ",") throw invalid(`expected ',' or ']' at offset ${offset}`);
        offset += 1;
      }
      throw invalid("unterminated JSON array");
    }
    if (character === '"') {
      readString();
      return;
    }
    const start = offset;
    while (offset < source.length && !/[\s,}\]]/u.test(source[offset]!)) offset += 1;
    if (start === offset) throw invalid(`invalid JSON value at offset ${offset}`);
    try {
      JSON.parse(source.slice(start, offset)) as unknown;
    } catch {
      throw invalid(`invalid JSON value at offset ${start}`);
    }
  };

  readValue();
  skipWhitespace();
  if (offset !== source.length) throw invalid(`unexpected JSON content at offset ${offset}`);
}

function invalid(message: string, code?: string): ExecutionEnvelopeValidationError {
  return new ExecutionEnvelopeValidationError(message, code);
}
