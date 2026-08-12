import type { ApplicationInvocationOptions } from "./ports.ts";
import {
  APPLICATION_CONTRACT_VERSION,
  type ExecutionContextV1,
  type JsonObject
} from "./contracts.ts";
import { validateExecutionRequestV1 } from "./validation.ts";

export const STATUS_READ_OPERATION_ID = "status.read" as const;

export interface StatusReadRequestV1 {
  readonly version: typeof APPLICATION_CONTRACT_VERSION;
  readonly kind: "status-read-request";
  readonly requestId: string;
  readonly context: ExecutionContextV1;
  readonly operation: { readonly kind: "query"; readonly id: typeof STATUS_READ_OPERATION_ID };
}

export interface StatusReadResultV1 {
  readonly version: typeof APPLICATION_CONTRACT_VERSION;
  readonly kind: "status-read-result";
  readonly requestId: string;
  readonly correlationId: string;
  readonly output: JsonObject;
}

export interface StatusReadPort {
  readStatus(context: ExecutionContextV1, options?: ApplicationInvocationOptions): Promise<unknown>;
}

export interface StatusReadUseCase {
  execute(request: StatusReadRequestV1, options?: ApplicationInvocationOptions): Promise<StatusReadResultV1>;
}

export function createStatusReadUseCase(port: StatusReadPort): StatusReadUseCase {
  if (!port || typeof port.readStatus !== "function") throw new Error("status read port is required");
  return Object.freeze({
    async execute(request: StatusReadRequestV1, options: ApplicationInvocationOptions = {}) {
      const validated = validateStatusReadRequestV1(request);
      throwIfCancelled(options.signal);
      const output = normalizeStatusOutput(await port.readStatus(validated.context, options));
      throwIfCancelled(options.signal);
      return Object.freeze({
        version: APPLICATION_CONTRACT_VERSION,
        kind: "status-read-result" as const,
        requestId: validated.requestId,
        correlationId: validated.context.correlationId,
        output
      });
    }
  });
}

export function validateStatusReadRequestV1(request: StatusReadRequestV1): StatusReadRequestV1 {
  if (request?.kind !== "status-read-request") throw new Error("status read request kind must be status-read-request");
  if (request.operation?.kind !== "query" || request.operation.id !== STATUS_READ_OPERATION_ID) {
    throw new Error(`status read operation must be query:${STATUS_READ_OPERATION_ID}`);
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
    kind: "status-read-request" as const,
    requestId: validated.requestId,
    context: validated.context,
    operation: Object.freeze({ kind: "query" as const, id: STATUS_READ_OPERATION_ID })
  });
}

function normalizeStatusOutput(value: unknown): JsonObject {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("status read output must be a JSON object");
  const normalized = JSON.parse(serialized);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new Error("status read output must be a JSON object");
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
  const error = new Error("status read cancelled");
  error.name = "AbortError";
  throw error;
}
