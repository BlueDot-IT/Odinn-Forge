import { createHash } from "node:crypto";
import { projectDurableJobPayload, type WorkflowDispatchContext, type WorkflowDispatchResult } from "@odinn/kernel";
import { validateAutomationCandidate, type AutomationCandidate } from "@odinn/kernel/automation-primitives";
import { scopedJobPayload, type GatewayTenantScope } from "./http/tenant-scope.ts";
import { runWithWorkflowLeaseHeartbeat } from "./workflow.ts";

export type DurableJobSnapshot = {
  id: string;
  status: string;
  payload?: unknown;
  requestHash?: string;
  retrySafe?: boolean;
};

export type DurableEventJobRequest = {
  id: string;
  payload: Record<string, unknown>;
  requestHash: string;
  retrySafe: false;
};

type DurableEventJobSupervisor = {
  get(id: string): Promise<DurableJobSnapshot | undefined>;
  submit(
    payload: Record<string, unknown>,
    options: { id: string; requestHash: string; retrySafe: false; idempotent: true }
  ): Promise<DurableJobSnapshot>;
};

type EventJobWaitOptions = {
  initialJob: DurableJobSnapshot;
  getJob: (id: string) => Promise<DurableJobSnapshot | undefined>;
  signal: AbortSignal;
  renewLease: () => boolean;
  pollIntervalMs?: number;
  leaseRenewIntervalMs?: number;
  expectedRequest?: DurableEventJobRequest;
};

type GovernedWorkflowExecutor = (request: Record<string, unknown>) => Promise<unknown>;

const NONTERMINAL_JOB_STATUSES = new Set(["queued", "running", "cancelling", "awaiting-approval"]);
const WORKFLOW_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function eventJobRequestForCandidate(
  candidateInput: AutomationCandidate,
  scope: GatewayTenantScope
): DurableEventJobRequest {
  const candidate = validateAutomationCandidate(candidateInput);
  const id = candidate.idempotencyKey;
  const payload = scopedJobPayload({
    durableExecution: true,
    task: {
      id,
      tool: candidate.actionRef,
      input: { candidateId: candidate.candidateId, idempotencyKey: candidate.idempotencyKey },
      actor: "event-ingress",
      reason: `automation:${candidate.declarationId}`
    }
  }, scope);
  const retrySafe = false as const;
  return {
    id,
    payload,
    requestHash: requestDigest({ schemaVersion: 1, candidate, payload, retrySafe }),
    retrySafe
  };
}

function assertEventJobBinding(job: DurableJobSnapshot, expected: DurableEventJobRequest): void {
  const expectedPayload = projectDurableJobPayload(expected.payload);
  const storedPayload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
    ? job.payload as Record<string, unknown>
    : undefined;
  const expectedTask = expectedPayload.task && typeof expectedPayload.task === "object" && !Array.isArray(expectedPayload.task)
    ? expectedPayload.task as Record<string, unknown>
    : undefined;
  const storedTask = storedPayload?.task && typeof storedPayload.task === "object" && !Array.isArray(storedPayload.task)
    ? storedPayload.task as Record<string, unknown>
    : undefined;
  const expectedScope = expectedPayload.scope && typeof expectedPayload.scope === "object" && !Array.isArray(expectedPayload.scope)
    ? expectedPayload.scope as Record<string, unknown>
    : undefined;
  const storedScope = storedPayload?.scope && typeof storedPayload.scope === "object" && !Array.isArray(storedPayload.scope)
    ? storedPayload.scope as Record<string, unknown>
    : undefined;
  if (job.id !== expected.id
    || job.requestHash !== expected.requestHash
    || job.retrySafe !== expected.retrySafe
    || storedTask?.id !== expectedTask?.id
    || storedScope?.tenantId !== expectedScope?.tenantId
    || storedScope?.principalId !== expectedScope?.principalId
    || canonicalJson(storedScope) !== canonicalJson(expectedScope)
    || canonicalJson(storedPayload) !== canonicalJson(expectedPayload)) {
    throw new Error("event delivery idempotency key is already bound to a different request, payload, or scope");
  }
}

export async function submitDurableEventJob(
  supervisor: DurableEventJobSupervisor,
  candidate: AutomationCandidate,
  scope: GatewayTenantScope
): Promise<{ job: DurableJobSnapshot; request: DurableEventJobRequest }> {
  const request = eventJobRequestForCandidate(candidate, scope);
  const existing = await supervisor.get(request.id);
  if (existing) {
    assertEventJobBinding(existing, request);
    return { job: existing, request };
  }
  const job = await supervisor.submit(request.payload, {
    id: request.id,
    requestHash: request.requestHash,
    retrySafe: request.retrySafe,
    idempotent: true
  });
  assertEventJobBinding(job, request);
  return { job, request };
}

function positiveInterval(value: number | undefined, fallback: number, label: string): number {
  const interval = value ?? fallback;
  if (!Number.isInteger(interval) || interval < 1) throw new Error(`${label} must be a positive integer`);
  return interval;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("durable dispatch aborted");
}

async function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function eventDeliveryStatusForJob(job: DurableJobSnapshot): "completed" | "failed" | "needs-review" | undefined {
  if (NONTERMINAL_JOB_STATUSES.has(job.status)) return undefined;
  if (job.status === "completed") return "completed";
  if (job.status === "failed" || job.status === "cancelled") return "failed";
  return "needs-review";
}

/**
 * Keep the event-delivery lease live while the durable job owns execution.
 * The caller may resume from an idempotently returned job after supervisor
 * restart; only the job's durable terminal state settles the delivery.
 */
export async function waitForDurableJobTerminal({
  initialJob,
  getJob,
  signal,
  renewLease,
  pollIntervalMs,
  leaseRenewIntervalMs,
  expectedRequest
}: EventJobWaitOptions): Promise<"completed" | "failed" | "needs-review"> {
  const pollEvery = positiveInterval(pollIntervalMs, 250, "durable job poll interval");
  const renewEvery = positiveInterval(leaseRenewIntervalMs, 10_000, "event lease renewal interval");
  let job: DurableJobSnapshot | undefined = initialJob;
  let renewAt = 0;

  while (job) {
    if (expectedRequest) {
      try { assertEventJobBinding(job, expectedRequest); }
      catch { return "needs-review"; }
    }
    const terminal = eventDeliveryStatusForJob(job);
    if (terminal) return terminal;
    if (signal.aborted) throw abortReason(signal);
    if (Date.now() >= renewAt) {
      if (!renewLease()) throw new Error("event delivery lease renewal failed while its durable job was nonterminal");
      renewAt = Date.now() + renewEvery;
    }
    await waitForDelay(Math.min(pollEvery, Math.max(1, renewAt - Date.now())), signal);
    job = await getJob(initialJob.id);
  }

  return "needs-review";
}

function outputRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function errorCodeFor(value: Record<string, unknown>, fallback: string): string {
  return typeof value.errorCode === "string" && WORKFLOW_ERROR_CODE.test(value.errorCode)
    ? value.errorCode
    : fallback;
}

export function workflowDispatchResultForExecution(value: unknown): WorkflowDispatchResult {
  const result = outputRecord(value);
  const output = outputRecord(result?.output);
  if (output?.type === "approval.required" || result?.type === "approval.required") return { status: "awaiting-approval" };

  const declaredTerminalStatus = typeof result?.terminalStatus === "string" ? result.terminalStatus : undefined;
  const knownOutputStatus = typeof output?.status === "string"
    && ["completed", "failed", "cancelled", "needs-review"].includes(output.status)
    ? output.status
    : undefined;
  const terminalStatus = declaredTerminalStatus ?? knownOutputStatus;
  const terminal = output ?? result ?? {};
  if (terminalStatus === "failed") return { status: "failed", errorCode: errorCodeFor(terminal, "WORKFLOW_STEP_FAILED") };
  if (terminalStatus === "needs-review") return { status: "needs-review", errorCode: errorCodeFor(terminal, "WORKFLOW_OUTCOME_UNCERTAIN") };
  if (terminalStatus === "cancelled") {
    return terminal.effectApplied === false
      ? { status: "cancelled", effectApplied: false }
      : { status: "needs-review", errorCode: "WORKFLOW_CANCELLATION_EFFECT_UNCONFIRMED" };
  }
  if (declaredTerminalStatus && declaredTerminalStatus !== "completed") {
    return { status: "needs-review", errorCode: "WORKFLOW_TERMINAL_STATUS_UNKNOWN" };
  }
  return { status: "completed", result: value };
}

export async function dispatchGovernedWorkflowStep(
  context: WorkflowDispatchContext,
  execute: GovernedWorkflowExecutor,
  heartbeatIntervalMs?: number
): Promise<WorkflowDispatchResult> {
  const { run, step, signal, renewLease } = context;
  const operation = () => execute({
    task: {
      id: `${run.runId}:${step.stepId}:${step.attempt}`,
      tool: step.actionRef,
      input: step.input,
      actor: "workflow",
      reason: `workflow:${run.runId}`
    },
    signal,
    durableExecution: true,
    parentRunId: run.runId
  });
  const result = heartbeatIntervalMs === undefined
    ? await runWithWorkflowLeaseHeartbeat(operation, renewLease)
    : await runWithWorkflowLeaseHeartbeat(operation, renewLease, heartbeatIntervalMs);
  return workflowDispatchResultForExecution(result);
}
