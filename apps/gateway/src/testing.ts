type ApprovalJobClaimedTestEvent = {
  approvalId: string;
  jobId: string;
};

export type GatewayTestHooks = {
  afterApprovalJobClaimed?: (event: ApprovalJobClaimedTestEvent) => void | Promise<void>;
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
