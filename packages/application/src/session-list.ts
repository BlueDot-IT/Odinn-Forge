import type { ApplicationInvocationOptions } from "./ports.ts";
import {
  APPLICATION_CONTRACT_VERSION,
  type ExecutionContextV1
} from "./contracts.ts";
import type { SessionPageV1 } from "./read-output-contracts.ts";
import { validateSessionPageV1 } from "./read-output-contracts.ts";
import { validateExecutionRequestV1 } from "./validation/execution-request.ts";

export const SESSION_LIST_OPERATION_ID = "session.list" as const;

export interface SessionListInputV1 {
  readonly limit: number;
  readonly projectId?: string;
}

export interface SessionListRequestV1 {
  readonly version: typeof APPLICATION_CONTRACT_VERSION;
  readonly kind: "session-list-request";
  readonly requestId: string;
  readonly context: ExecutionContextV1;
  readonly operation: { readonly kind: "query"; readonly id: typeof SESSION_LIST_OPERATION_ID };
  readonly input: SessionListInputV1;
}

export interface SessionListResultV1 {
  readonly version: typeof APPLICATION_CONTRACT_VERSION;
  readonly kind: "session-list-result";
  readonly requestId: string;
  readonly correlationId: string;
  readonly output: SessionPageV1;
}

export interface SessionListPort {
  readSessions(
    input: SessionListInputV1,
    context: ExecutionContextV1,
    options?: ApplicationInvocationOptions
  ): Promise<SessionPageV1>;
}

export interface SessionListUseCase {
  execute(request: SessionListRequestV1, options?: ApplicationInvocationOptions): Promise<SessionListResultV1>;
}

export function normalizeSessionListLimit(limit: number): number {
  return Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 20;
}

export function createSessionListUseCase(port: SessionListPort): SessionListUseCase {
  if (!port || typeof port.readSessions !== "function") throw new Error("session list port is required");
  return Object.freeze({
    async execute(request: SessionListRequestV1, options: ApplicationInvocationOptions = {}) {
      const validated = validateSessionListRequestV1(request);
      throwIfCancelled(options.signal);
      const output = validateSessionPageV1(await port.readSessions(validated.input, validated.context, options));
      throwIfCancelled(options.signal);
      return Object.freeze({
        version: APPLICATION_CONTRACT_VERSION,
        kind: "session-list-result" as const,
        requestId: validated.requestId,
        correlationId: validated.context.correlationId,
        output
      });
    }
  });
}

export function validateSessionListRequestV1(request: SessionListRequestV1): SessionListRequestV1 {
  if (request?.kind !== "session-list-request") throw new Error("session list request kind must be session-list-request");
  if (request.operation?.kind !== "query" || request.operation.id !== SESSION_LIST_OPERATION_ID) {
    throw new Error(`session list operation must be query:${SESSION_LIST_OPERATION_ID}`);
  }
  const validated = validateExecutionRequestV1({
    version: request.version,
    kind: "execution-request",
    requestId: request.requestId,
    context: request.context,
    operation: request.operation,
    input: request.input,
    responseMode: "sync"
  });
  const input = normalizeSessionListInput(validated.input);
  return Object.freeze({
    version: APPLICATION_CONTRACT_VERSION,
    kind: "session-list-request" as const,
    requestId: validated.requestId,
    context: validated.context,
    operation: Object.freeze({ kind: "query" as const, id: SESSION_LIST_OPERATION_ID }),
    input
  });
}

function normalizeSessionListInput(value: unknown): SessionListInputV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session list input must be an object");
  const input = value as Record<string, unknown>;
  const limit = Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("session list limit must be an integer from 1 to 200");
  }
  if (input.projectId !== undefined && typeof input.projectId !== "string") {
    throw new Error("session list projectId must be a string");
  }
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  return Object.freeze({ limit, ...(projectId ? { projectId } : {}) });
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("session list cancelled");
  error.name = "AbortError";
  throw error;
}
