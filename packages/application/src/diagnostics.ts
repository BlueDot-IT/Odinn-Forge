import type { ApplicationInvocationOptions } from "./ports.ts";
import {
  APPLICATION_CONTRACT_VERSION,
  type ExecutionContextV1,
  type JsonObject
} from "./contracts.ts";
import { validateExecutionRequestV1 } from "./validation.ts";

export const DIAGNOSTICS_READ_OPERATION_ID = "diagnostics.read" as const;

export interface DiagnosticsReadRequestV1 {
  readonly version: typeof APPLICATION_CONTRACT_VERSION;
  readonly kind: "diagnostics-read-request";
  readonly requestId: string;
  readonly context: ExecutionContextV1;
  readonly operation: { readonly kind: "query"; readonly id: typeof DIAGNOSTICS_READ_OPERATION_ID };
}

export interface DiagnosticsReadResultV1 {
  readonly version: typeof APPLICATION_CONTRACT_VERSION;
  readonly kind: "diagnostics-read-result";
  readonly requestId: string;
  readonly correlationId: string;
  readonly output: JsonObject;
}

export interface DiagnosticsReadPort {
  readDiagnostics(context: ExecutionContextV1, options?: ApplicationInvocationOptions): Promise<unknown>;
}

export interface DiagnosticsReadUseCase {
  execute(request: DiagnosticsReadRequestV1, options?: ApplicationInvocationOptions): Promise<DiagnosticsReadResultV1>;
}

export function createDiagnosticsReadUseCase(port: DiagnosticsReadPort): DiagnosticsReadUseCase {
  if (!port || typeof port.readDiagnostics !== "function") throw new Error("diagnostics read port is required");
  return Object.freeze({
    async execute(request: DiagnosticsReadRequestV1, options: ApplicationInvocationOptions = {}) {
      const validated = validateDiagnosticsReadRequestV1(request);
      throwIfCancelled(options.signal);
      const output = normalizeDiagnosticsOutput(await port.readDiagnostics(validated.context, options));
      throwIfCancelled(options.signal);
      return Object.freeze({
        version: APPLICATION_CONTRACT_VERSION,
        kind: "diagnostics-read-result" as const,
        requestId: validated.requestId,
        correlationId: validated.context.correlationId,
        output
      });
    }
  });
}

export function validateDiagnosticsReadRequestV1(request: DiagnosticsReadRequestV1): DiagnosticsReadRequestV1 {
  if (request?.kind !== "diagnostics-read-request") throw new Error("diagnostics read request kind must be diagnostics-read-request");
  if (request.operation?.kind !== "query" || request.operation.id !== DIAGNOSTICS_READ_OPERATION_ID) {
    throw new Error(`diagnostics read operation must be query:${DIAGNOSTICS_READ_OPERATION_ID}`);
  }
  const validated = validateExecutionRequestV1({
    version: request.version,
    kind: "execution-request",
    requestId: request.requestId,
    context: request.context,
    operation: request.operation,
    input: {},
    responseMode: "sync"
  });
  return Object.freeze({
    version: APPLICATION_CONTRACT_VERSION,
    kind: "diagnostics-read-request" as const,
    requestId: validated.requestId,
    context: validated.context,
    operation: Object.freeze({ kind: "query" as const, id: DIAGNOSTICS_READ_OPERATION_ID })
  });
}

function normalizeDiagnosticsOutput(value: unknown): JsonObject {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("diagnostics read output must be a JSON object");
  const normalized = JSON.parse(serialized);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new Error("diagnostics read output must be a JSON object");
  }
  return freezeJson(normalized) as JsonObject;
}

function freezeJson(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item);
  } else {
    for (const item of Object.values(value)) freezeJson(item);
  }
  return Object.freeze(value);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("diagnostics read cancelled");
  error.name = "AbortError";
  throw error;
}
