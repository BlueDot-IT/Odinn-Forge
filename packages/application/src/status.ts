import type { ApplicationInvocationOptions } from "./ports.ts";
import {
  APPLICATION_CONTRACT_VERSION,
  type ExecutionContextV1
} from "./contracts.ts";
import type { StatusSnapshotV1 } from "./read-output-contracts.ts";
import { validateStatusSnapshotV1 } from "./read-output-contracts.ts";
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
  readonly output: StatusSnapshotV1;
}

export interface StatusReadPort {
  readStatus(context: ExecutionContextV1, options?: ApplicationInvocationOptions): Promise<StatusSnapshotV1>;
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
      const output = validateStatusSnapshotV1(await port.readStatus(validated.context, options));
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

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("status read cancelled");
  error.name = "AbortError";
  throw error;
}
