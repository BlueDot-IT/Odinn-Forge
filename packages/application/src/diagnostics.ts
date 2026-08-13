import type { ApplicationInvocationOptions } from "./ports.ts";
import {
  APPLICATION_CONTRACT_VERSION,
  type ExecutionContextV1
} from "./contracts.ts";
import type { DiagnosticsReportV1 } from "./read-output-contracts.ts";
import { validateDiagnosticsReportV1 } from "./read-output-contracts.ts";
import { validateExecutionRequestV1 } from "./validation/execution-request.ts";

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
  readonly output: DiagnosticsReportV1;
}

export interface DiagnosticsReadPort {
  readDiagnostics(context: ExecutionContextV1, options?: ApplicationInvocationOptions): Promise<DiagnosticsReportV1>;
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
      const output = validateDiagnosticsReportV1(await port.readDiagnostics(validated.context, options));
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

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("diagnostics read cancelled");
  error.name = "AbortError";
  throw error;
}
