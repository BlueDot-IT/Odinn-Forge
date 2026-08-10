import { createRunId, validateWorkflowDefinition, type WorkflowDefinition, type WorkflowRunRecord, type WorkflowRunRequest, type WorkflowStepDefinition } from "@odinn/protocol";
import { SqliteWorkflowStore, createRunLedger, type ClaimedWorkflowStep } from "@odinn/store-sqlite";

export type WorkflowDispatchContext = {
  run: WorkflowRunRecord;
  step: ClaimedWorkflowStep;
  signal: AbortSignal;
};

export type WorkflowDispatchResult =
  | { status: "completed"; result?: unknown }
  | { status: "failed"; errorCode?: string }
  | { status: "needs-review"; errorCode?: string }
  | { status: "awaiting-approval" };

export type WorkflowRuntimeOptions = {
  store: SqliteWorkflowStore;
  dispatch: (context: WorkflowDispatchContext) => Promise<WorkflowDispatchResult>;
  concurrency?: number;
  onEvent?: (event: { runId: string; type: string; data: Record<string, unknown> }) => void | Promise<void>;
};

export type WorkflowSubmission = Omit<WorkflowRunRequest, "schemaVersion"> & { schemaVersion?: 1 };

export class DurableWorkflowRuntime {
  readonly store: SqliteWorkflowStore;
  readonly dispatch: WorkflowRuntimeOptions["dispatch"];
  readonly concurrency: number;
  readonly onEvent?: WorkflowRuntimeOptions["onEvent"];
  #active = new Map<string, { runId: string; controller: AbortController; promise: Promise<void> }>();
  #draining = false;
  #stopping = false;
  #started = false;

  constructor(options: WorkflowRuntimeOptions) {
    if (!options?.store) throw new Error("DurableWorkflowRuntime requires a workflow store");
    if (typeof options.dispatch !== "function") throw new Error("DurableWorkflowRuntime requires a dispatch callback");
    this.store = options.store;
    this.dispatch = options.dispatch;
    this.concurrency = Math.max(1, Math.min(4, Number(options.concurrency) || 1));
    this.onEvent = options.onEvent;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.store.recover();
    this.#started = true;
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
    for (const active of this.#active.values()) if (active.runId === runId) active.controller.abort(new Error("workflow cancelled by operator"));
    const result = this.store.cancel(runId);
    await this.emit(runId, "workflow.cancelled", {});
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
    for (const active of this.#active.values()) active.controller.abort(new Error("workflow runtime shutting down"));
    await Promise.allSettled([...this.#active.values()].map(({ promise }) => promise));
    this.#active.clear();
  }

  async drain(): Promise<void> {
    if (this.#draining || this.#stopping) return;
    this.#draining = true;
    try {
      while (!this.#stopping && this.#active.size < this.concurrency) {
        const step = this.store.claimNext();
        if (!step) break;
        const controller = new AbortController();
        const promise = this.execute(step, controller);
        const activeKey = `${step.runId}:${step.stepId}:${step.leaseToken}`;
        this.#active.set(activeKey, { runId: step.runId, controller, promise });
        void promise.finally(() => {
          if (this.#active.get(activeKey)?.promise === promise) this.#active.delete(activeKey);
          void this.drain();
        });
      }
    } finally {
      this.#draining = false;
    }
  }

  async execute(step: ClaimedWorkflowStep, controller: AbortController): Promise<void> {
    const run = this.store.get(step.runId);
    if (!run) return;
    try {
      await this.emit(step.runId, "workflow.step.admitted", { stepId: step.stepId, actionRef: step.actionRef, attempt: step.attempt });
      const outcome = await this.dispatch({ run, step, signal: controller.signal });
      if (outcome.status === "completed") this.store.completeStep(step.runId, step.stepId, step.leaseToken, outcome.result);
      else if (outcome.status === "awaiting-approval") this.store.awaitApproval(step.runId, step.stepId, step.leaseToken);
      else this.store.failStep(step.runId, step.stepId, step.leaseToken, outcome.errorCode ?? (outcome.status === "needs-review" ? "WORKFLOW_OUTCOME_UNCERTAIN" : "WORKFLOW_STEP_FAILED"), { uncertain: outcome.status === "needs-review" });
    } catch (error) {
      const uncertain = controller.signal.aborted || step.retrySafety === "effectful";
      try { this.store.failStep(step.runId, step.stepId, step.leaseToken, uncertain ? "WORKFLOW_OUTCOME_UNCERTAIN" : "WORKFLOW_DISPATCH_FAILED", { uncertain }); } catch { /* stale lease or prior settlement is already durable */ }
    }
  }

  private async emit(runId: string, type: string, data: Record<string, unknown>): Promise<void> {
    await this.onEvent?.({ runId, type, data });
  }
}

export function createDurableWorkflowRuntime({ stateDir = ".odinn", workspaceRoot = process.cwd(), dispatch, onEvent, concurrency = 1 }: Omit<WorkflowRuntimeOptions, "store"> & { stateDir?: string; workspaceRoot?: string }): DurableWorkflowRuntime {
  const ledger = createRunLedger({ stateDir, workspaceRoot });
  const store = new SqliteWorkflowStore(ledger.database);
  return new DurableWorkflowRuntime({ store, dispatch, onEvent, concurrency });
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
