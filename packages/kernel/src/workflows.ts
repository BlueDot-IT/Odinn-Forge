import { createRunId, validateWorkflowDefinition, type WorkflowDefinition, type WorkflowRunRecord, type WorkflowRunRequest, type WorkflowStepDefinition } from "@odinn/protocol";
import { SqliteWorkflowStore, createRunLedger, type ClaimedWorkflowStep } from "@odinn/store-sqlite";
import { cwd as currentWorkingDirectory } from "node:process";

export type WorkflowDispatchContext = {
  run: WorkflowRunRecord;
  step: ClaimedWorkflowStep;
  signal: AbortSignal;
  renewLease: () => boolean;
};

export type WorkflowDispatchResult =
  | { status: "completed"; result?: unknown }
  | { status: "failed"; errorCode?: string }
  | { status: "needs-review"; errorCode?: string }
  | { status: "cancelled"; effectApplied: false }
  | { status: "awaiting-approval" };

export type WorkflowRuntimeOptions = {
  store: SqliteWorkflowStore;
  dispatch: (context: WorkflowDispatchContext) => Promise<WorkflowDispatchResult>;
  concurrency?: number;
  cancellationGraceMs?: number;
  leaseMs?: number;
  onEvent?: (event: { runId: string; type: string; data: Record<string, unknown> }) => void | Promise<void>;
};

export type WorkflowSubmission = Omit<WorkflowRunRequest, "schemaVersion"> & { schemaVersion?: 1 };

export class DurableWorkflowRuntime {
  readonly store: SqliteWorkflowStore;
  readonly dispatch: WorkflowRuntimeOptions["dispatch"];
  readonly concurrency: number;
  readonly cancellationGraceMs: number;
  readonly leaseMs: number;
  readonly onEvent?: WorkflowRuntimeOptions["onEvent"];
  #active = new Map<string, { runId: string; stepId: string; leaseToken: string; leaseExpiresAt: string; leaseTimer: NodeJS.Timeout; controller: AbortController; promise: Promise<void> }>();
  #draining = false;
  #stopping = false;
  #started = false;
  #recoveryTimer?: NodeJS.Timeout;
  #recoveryScheduledAt?: number;

  constructor(options: WorkflowRuntimeOptions) {
    if (!options?.store) throw new Error("DurableWorkflowRuntime requires a workflow store");
    if (typeof options.dispatch !== "function") throw new Error("DurableWorkflowRuntime requires a dispatch callback");
    this.store = options.store;
    this.dispatch = options.dispatch;
    this.concurrency = Math.max(1, Math.min(4, Number(options.concurrency) || 1));
    this.cancellationGraceMs = Math.max(1, Math.min(120_000, Number(options.cancellationGraceMs) || 30_000));
    this.leaseMs = Math.max(25, Math.min(10 * 60_000, Number(options.leaseMs) || 120_000));
    this.onEvent = options.onEvent;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#stopping = false;
    const recovery = this.store.recover();
    this.#started = true;
    this.scheduleLeaseRecovery(recovery.nextRecoveryAt);
    await this.drain();
  }

  async submit(input: WorkflowSubmission): Promise<WorkflowRunRecord> {
    const request: WorkflowRunRequest = {
      schemaVersion: 1,
      runId: input.runId || createRunId(),
      principalId: input.principalId,
      idempotencyKey: input.idempotencyKey,
      definition: input.definition,
      input: input.input
    };
    const run = this.store.create(request);
    await this.emit(run.runId, "workflow.accepted", { definitionDigest: run.definitionDigest });
    await this.drain();
    return this.store.get(run.runId)!;
  }

  get(runId: string): WorkflowRunRecord | undefined { return this.store.get(runId); }
  list(limit?: number): WorkflowRunRecord[] { return this.store.list(limit); }
  queryWorkflows(options: { limit?: number; offset?: number; query?: string; status?: string } = {}) { return this.store.queryWorkflows(options); }
  counts(): { total: number; attention: number } { return this.store.counts(); }
  events(runId: string, limit?: number) { return this.store.events(runId, limit); }

  async cancel(runId: string): Promise<WorkflowRunRecord> {
    const deadlineAt = new Date(Date.now() + this.cancellationGraceMs).toISOString();
    const requested = this.store.requestCancellation(runId, deadlineAt);
    if (requested.status !== "cancelling") return requested;
    this.scheduleLeaseRecovery(deadlineAt);
    const active = [...this.#active.values()].filter((entry) => entry.runId === runId);
    for (const entry of active) entry.controller.abort(new Error("workflow cancelled by operator"));
    void this.emit(runId, "workflow.cancellation-requested", { deadlineAt }).catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    if (active.length) {
      await Promise.race([
        Promise.allSettled(active.map(({ promise }) => promise)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, this.cancellationGraceMs); })
      ]);
      if (timer) clearTimeout(timer);
    }
    const result = this.store.finalizeCancellation(runId, { quarantineRunning: true });
    void this.emit(runId, result.status === "cancelled" ? "workflow.cancelled" : "workflow.cancellation-needs-review", {}).catch(() => undefined);
    return result;
  }

  async resume(runId: string): Promise<WorkflowRunRecord> {
    const result = this.store.resume(runId);
    await this.emit(runId, "workflow.resumed", {});
    await this.drain();
    return result;
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    this.#started = false;
    if (this.#recoveryTimer) clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = undefined;
    this.#recoveryScheduledAt = undefined;
    const active = [...this.#active.entries()];
    for (const [, entry] of active) entry.controller.abort(new Error("workflow runtime shutting down"));
    let timer: NodeJS.Timeout | undefined;
    if (active.length) {
      await Promise.race([
        Promise.allSettled(active.map(([, { promise }]) => promise)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, this.cancellationGraceMs); })
      ]);
      if (timer) clearTimeout(timer);
    }
    for (const [activeKey, entry] of active) {
      if (this.#active.get(activeKey)?.promise !== entry.promise) continue;
      clearTimeout(entry.leaseTimer);
      try { this.store.quarantineStep(entry.runId, entry.stepId, entry.leaseToken, "WORKFLOW_SHUTDOWN_OUTCOME_UNCERTAIN", new Date(Date.now() + this.cancellationGraceMs).toISOString()); } catch { /* already settled or fenced */ }
    }
    this.#active.clear();
  }

  async drain(): Promise<void> {
    if (this.#draining || this.#stopping) return;
    this.#draining = true;
    try {
      while (!this.#stopping && this.#active.size < this.concurrency) {
        const step = this.store.claimNext(undefined, this.leaseMs);
        if (!step) break;
        const controller = new AbortController();
        const promise = this.execute(step, controller);
        const activeKey = `${step.runId}:${step.stepId}:${step.leaseToken}`;
        const leaseTimer = setTimeout(() => {
          const deadlineAt = new Date(Date.now() + this.cancellationGraceMs).toISOString();
          try {
            const result = this.store.quarantineStep(step.runId, step.stepId, step.leaseToken, "WORKFLOW_ACTIVE_LEASE_EXPIRED", deadlineAt);
            if (result.status === "stopping") this.abortActiveRun(step.runId, step.leaseToken, new Error("workflow stopped after a step lease expired"));
          } catch { /* already settled or fenced */ }
          controller.abort(new Error("workflow step lease expired"));
        }, Math.max(1, Date.parse(step.leaseExpiresAt) - Date.now() + 5));
        leaseTimer.unref?.();
        this.#active.set(activeKey, { runId: step.runId, stepId: step.stepId, leaseToken: step.leaseToken, leaseExpiresAt: step.leaseExpiresAt, leaseTimer, controller, promise });
        this.scheduleLeaseRecovery(step.leaseExpiresAt);
        const cleanup = () => {
          const active = this.#active.get(activeKey);
          if (active?.promise === promise) {
            clearTimeout(active.leaseTimer);
            this.#active.delete(activeKey);
          }
          void this.drain();
        };
        void promise.then(cleanup, cleanup);
      }
    } finally {
      this.#draining = false;
    }
  }

  async execute(step: ClaimedWorkflowStep, controller: AbortController): Promise<void> {
    let run: WorkflowRunRecord | undefined;
    try { run = this.store.get(step.runId); } catch { return; }
    if (!run) return;
    let dispatchReturned = false;
    try {
      await this.emit(step.runId, "workflow.step.admitted", { stepId: step.stepId, actionRef: step.actionRef, attempt: step.attempt });
      const admittedStatus = this.safeRunStatus(step.runId);
      if (admittedStatus === "cancelling") {
        this.store.acknowledgeCancellation(step.runId, step.stepId, step.leaseToken, { uncertain: false, errorCode: "WORKFLOW_CANCELLED_BEFORE_DISPATCH" });
        return;
      }
      if (admittedStatus === "stopping") {
        this.store.acknowledgeStop(step.runId, step.stepId, step.leaseToken, { uncertain: false, errorCode: "WORKFLOW_STOPPED_BEFORE_DISPATCH" });
        return;
      }
      if (controller.signal.aborted) {
        if (this.activeLeaseExpired(step)) this.store.quarantineStep(step.runId, step.stepId, step.leaseToken, "WORKFLOW_ACTIVE_LEASE_EXPIRED", new Date(Date.now() + this.cancellationGraceMs).toISOString());
        else this.recordFailure(step, "WORKFLOW_ABORTED_BEFORE_DISPATCH", false);
        return;
      }
      const outcome = await this.dispatch({
        run,
        step,
        signal: controller.signal,
        renewLease: () => this.renewActiveLease(step, controller)
      });
      dispatchReturned = true;
      const currentStatus = this.safeRunStatus(step.runId);
      if (currentStatus === "cancelling") {
        const cancellationAcknowledged = outcome.status === "cancelled" && outcome.effectApplied === false;
        this.store.acknowledgeCancellation(step.runId, step.stepId, step.leaseToken, {
          uncertain: !cancellationAcknowledged,
          errorCode: cancellationAcknowledged ? "WORKFLOW_CANCELLED" : "WORKFLOW_COMPLETED_AFTER_CANCELLATION_REQUEST"
        });
        return;
      }
      if (currentStatus === "stopping" || controller.signal.aborted) {
        const stopAcknowledged = outcome.status === "cancelled" && outcome.effectApplied === false;
        this.store.acknowledgeStop(step.runId, step.stepId, step.leaseToken, {
          uncertain: !stopAcknowledged,
          errorCode: stopAcknowledged ? "WORKFLOW_STOPPED_AFTER_FAILURE" : "WORKFLOW_STOP_OUTCOME_UNCERTAIN"
        });
        return;
      }
      if (outcome.status === "completed") this.store.completeStep(step.runId, step.stepId, step.leaseToken, outcome.result);
      else if (outcome.status === "awaiting-approval") this.store.awaitApproval(step.runId, step.stepId, step.leaseToken);
      else if (outcome.status === "cancelled") this.recordFailure(step, "WORKFLOW_UNEXPECTED_CANCELLATION_ACKNOWLEDGEMENT", true);
      else this.recordFailure(step, outcome.errorCode ?? (outcome.status === "needs-review" ? "WORKFLOW_OUTCOME_UNCERTAIN" : "WORKFLOW_STEP_FAILED"), outcome.status === "needs-review");
    } catch (error) {
      const currentStatus = this.safeRunStatus(step.runId);
      const cancellationPending = currentStatus === "cancelling";
      if (cancellationPending) {
        const uncertain = dispatchReturned || step.retrySafety === "effectful";
        try {
          this.store.acknowledgeCancellation(step.runId, step.stepId, step.leaseToken, {
            uncertain,
            errorCode: uncertain ? "WORKFLOW_CANCELLATION_OUTCOME_UNCERTAIN" : "WORKFLOW_CANCELLED"
          });
        } catch { /* stale cancellation leases are fenced by the durable store */ }
        return;
      }
      if (currentStatus === "stopping") {
        const uncertain = dispatchReturned || step.retrySafety === "effectful";
        try { this.store.acknowledgeStop(step.runId, step.stepId, step.leaseToken, { uncertain }); } catch { /* stale stop leases are fenced */ }
        return;
      }
      if (this.activeLeaseExpired(step)) {
        try { this.store.quarantineStep(step.runId, step.stepId, step.leaseToken, "WORKFLOW_ACTIVE_LEASE_EXPIRED", new Date(Date.now() + this.cancellationGraceMs).toISOString()); } catch { /* expired or settled leases are already fenced */ }
        return;
      }
      if (controller.signal.aborted) {
        const uncertain = step.retrySafety === "effectful";
        try { this.recordFailure(step, uncertain ? "WORKFLOW_SHUTDOWN_OUTCOME_UNCERTAIN" : "WORKFLOW_DISPATCH_ABORTED", uncertain); } catch { /* stale lease or prior settlement is already durable */ }
        return;
      }
      const uncertain = step.retrySafety === "effectful";
      try { this.recordFailure(step, uncertain ? "WORKFLOW_OUTCOME_UNCERTAIN" : "WORKFLOW_DISPATCH_FAILED", uncertain); } catch { /* stale lease or prior settlement is already durable */ }
    }
  }

  private safeRunStatus(runId: string): WorkflowRunRecord["status"] | undefined {
    try { return this.store.get(runId)?.status; } catch { return undefined; }
  }

  private activeLeaseExpired(step: ClaimedWorkflowStep): boolean {
    const active = this.#active.get(`${step.runId}:${step.stepId}:${step.leaseToken}`);
    return Date.parse(active?.leaseExpiresAt ?? step.leaseExpiresAt) <= Date.now();
  }

  private recordFailure(step: ClaimedWorkflowStep, errorCode: string, uncertain: boolean): void {
    const deadlineAt = new Date(Date.now() + this.cancellationGraceMs).toISOString();
    const result = this.store.failStep(step.runId, step.stepId, step.leaseToken, errorCode, { uncertain, stopDeadlineAt: deadlineAt });
    if (result.status !== "stopping") return;
    this.scheduleLeaseRecovery(deadlineAt);
    this.abortActiveRun(step.runId, step.leaseToken, new Error("workflow stopped after a step failure"));
  }

  private abortActiveRun(runId: string, exceptLeaseToken: string, reason: Error): void {
    for (const active of this.#active.values()) {
      if (active.runId === runId && active.leaseToken !== exceptLeaseToken) active.controller.abort(reason);
    }
  }

  private renewActiveLease(step: ClaimedWorkflowStep, controller: AbortController): boolean {
    const activeKey = `${step.runId}:${step.stepId}:${step.leaseToken}`;
    const active = this.#active.get(activeKey);
    if (!active || active.controller !== controller || controller.signal.aborted) return false;
    const expiresAt = new Date(Date.now() + this.leaseMs).toISOString();
    const renewed = this.store.renewStepLease(step.runId, step.stepId, step.leaseToken, expiresAt);
    if (!renewed) {
      controller.abort(new Error("workflow step lease renewal failed"));
      return false;
    }
    clearTimeout(active.leaseTimer);
    active.leaseExpiresAt = expiresAt;
    active.leaseTimer = setTimeout(() => {
      const deadlineAt = new Date(Date.now() + this.cancellationGraceMs).toISOString();
      try {
        const result = this.store.quarantineStep(step.runId, step.stepId, step.leaseToken, "WORKFLOW_ACTIVE_LEASE_EXPIRED", deadlineAt);
        if (result.status === "stopping") this.abortActiveRun(step.runId, step.leaseToken, new Error("workflow stopped after a step lease expired"));
      } catch { /* already settled or fenced */ }
      controller.abort(new Error("workflow step lease expired"));
    }, Math.max(1, Date.parse(expiresAt) - Date.now() + 5));
    active.leaseTimer.unref?.();
    this.scheduleLeaseRecovery(expiresAt);
    return true;
  }

  private scheduleLeaseRecovery(expiresAt?: string): void {
    if (!expiresAt || this.#stopping) return;
    const scheduledAt = Date.parse(expiresAt);
    if (!Number.isFinite(scheduledAt)) return;
    if (this.#recoveryTimer && this.#recoveryScheduledAt !== undefined && this.#recoveryScheduledAt <= scheduledAt) return;
    if (this.#recoveryTimer) clearTimeout(this.#recoveryTimer);
    this.#recoveryScheduledAt = scheduledAt;
    this.#recoveryTimer = setTimeout(() => {
      this.#recoveryTimer = undefined;
      this.#recoveryScheduledAt = undefined;
      if (this.#stopping) return;
      try {
        const recovery = this.store.recover({ uncertainLeaseTokens: [...this.#active.values()].map(({ leaseToken }) => leaseToken) });
        this.scheduleLeaseRecovery(recovery.nextRecoveryAt);
        void this.drain();
      } catch {
        this.scheduleLeaseRecovery(new Date(Date.now() + 1_000).toISOString());
      }
    }, Math.max(1, scheduledAt - Date.now() + 5));
    this.#recoveryTimer.unref?.();
  }

  private async emit(runId: string, type: string, data: Record<string, unknown>): Promise<void> {
    await this.onEvent?.({ runId, type, data });
  }
}

export function createDurableWorkflowRuntime({ stateDir = ".odinn", workspaceRoot = currentWorkingDirectory(), dispatch, onEvent, concurrency = 1, cancellationGraceMs, leaseMs }: Omit<WorkflowRuntimeOptions, "store"> & { stateDir?: string; workspaceRoot?: string }): DurableWorkflowRuntime {
  const ledger = createRunLedger({ stateDir, workspaceRoot });
  const store = new SqliteWorkflowStore(ledger.database);
  return new DurableWorkflowRuntime({ store, dispatch, onEvent, concurrency, cancellationGraceMs, leaseMs });
}

export function workflowDefinitionFromSteps({ id, revision = 1, name, steps }: { id: string; revision?: number; name: string; steps: Array<Pick<WorkflowStepDefinition, "id" | "actionRef" | "input"> & Partial<Pick<WorkflowStepDefinition, "dependsOn" | "retrySafety" | "maxAttempts" | "requiresApproval">>> }): WorkflowDefinition {
  return validateWorkflowDefinition({
    schemaVersion: 1,
    id,
    revision,
    name,
    steps: steps.map((step) => ({
      id: step.id,
      actionRef: step.actionRef,
      dependsOn: step.dependsOn ?? [],
      input: step.input,
      retrySafety: step.retrySafety ?? "retry-safe",
      maxAttempts: step.maxAttempts ?? 1,
      requiresApproval: step.requiresApproval ?? false
    })),
    definitionDigest: undefined
  });
}

export type { WorkflowDefinition, WorkflowRunRecord, WorkflowStepDefinition } from "@odinn/protocol";
