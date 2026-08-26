type ApprovalJobClaimedTestEvent = {
  approvalId: string;
  jobId: string;
};

export type AgentGraphControlAuditTestEvent = {
  action: "cancel" | "reassign" | "checkpoint";
  graphRunId: string;
  operationId: string;
};

export type GatewayTestHooks = {
  afterApprovalJobClaimed?: (event: ApprovalJobClaimedTestEvent) => void | Promise<void>;
  afterApprovalDispatchStarted?: (event: ApprovalJobClaimedTestEvent & { signal: AbortSignal }) => void | Promise<void>;
  beforeAgentGraphControlAudit?: (event: AgentGraphControlAuditTestEvent) => void | Promise<void>;
  beforeChannelResultPersist?: (event: { jobId: string }) => void | Promise<void>;
  afterControlPlaneMutationLockAcquired?: (event: { surface: string }) => void | Promise<void>;
  beforeControlPlaneMutationCommit?: (event: { surface: string }) => void | Promise<void>;
  onRequestError?: (event: { pathname: string; error: unknown }) => void | Promise<void>;
  shutdownTimeoutMs?: number;
};

const hooksByOptions = new WeakMap<object, Readonly<GatewayTestHooks>>();

/** @internal Test-only capability; this module is excluded from the package export map. */
export function withGatewayTestHooks<T extends object>(options: T, hooks: GatewayTestHooks): T {
  hooksByOptions.set(options, Object.freeze({ ...hooks }));
  return options;
}

/** @internal The public Gateway factory cannot activate hooks without the exact registered options object. */
export function gatewayTestHooksFor(options: unknown): Readonly<GatewayTestHooks> | undefined {
  return options && typeof options === "object" ? hooksByOptions.get(options) : undefined;
}
