import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import type { JsonObject } from "@odinn/protocol";

declare const __ODINN_COMPILED__: boolean | undefined;

export interface JobRecord {
  id: string;
  status: string;
  payload: JsonObject;
  attempts: number;
  timeoutMs: number;
  requestHash?: string;
  retrySafe?: boolean;
  recoveryInputAvailable?: boolean;
  result?: unknown;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  occurrenceKey?: string;
  scheduledFor?: string;
  nextRunAt?: string | null;
  dispatchLease?: JsonObject;
}

export interface JobStore {
  create(job: JsonObject & { id: string }): Promise<JobRecord>;
  claim(id: string, patch: JsonObject): Promise<JobRecord | undefined>;
  claimApproval?(id: string, patch: JsonObject): Promise<JobRecord | undefined>;
  update(id: string, patch: JsonObject): Promise<JobRecord>;
  get(id: string): Promise<JobRecord | undefined>;
  list(): Promise<JobRecord[]>;
  recover(options: { maxAttempts: number }): Promise<unknown>;
  cancel?(id: string, options?: { requestedBy?: string; reason?: string }): Promise<JobRecord>;
  renewLease?(id: string, lease: { token: string; owner: string; epoch: string; expiresAt: string }): Promise<boolean>;
}

export interface JobExecutionContext {
  signal: AbortSignal;
  job: JobRecord;
}

export type JobExecute = (payload: JsonObject, context: JobExecutionContext) => Promise<unknown>;

export interface JobSupervisorOptions {
  store: JobStore;
  execute: JobExecute;
  onCancel?: (job: JobRecord) => Promise<void> | void;
  concurrency?: number;
  maxAttempts?: number;
  defaultTimeoutMs?: number;
}

interface ActiveJob {
  controller: AbortController;
  promise: Promise<void>;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const PROCESS_WORKER_ABORT_GRACE_MS = 30_000;

export class JobSupervisor {
  readonly store: JobStore;
  readonly execute: JobExecute;
  readonly onCancel?: (job: JobRecord) => Promise<void> | void;
  readonly concurrency: number;
  readonly maxAttempts: number;
  readonly defaultTimeoutMs: number;
  private readonly active: Map<string, ActiveJob>;
  private readonly volatilePayloads: Map<string, JsonObject>;
  private readonly volatileResults: Map<string, { result: unknown; expiresAt: number }>;
  private readonly leaseOwner: string;
  private readonly leaseEpoch: string;
  private recoveryTimer?: NodeJS.Timeout;
  private started: boolean;
  private draining: boolean;
  private stopping: boolean;

  constructor(options: Partial<JobSupervisorOptions> = {}) {
    const { store, execute, onCancel, concurrency = 1, maxAttempts = 3, defaultTimeoutMs = 120_000 } = options;
    if (!store || typeof store.create !== "function") throw new Error("JobSupervisor requires a durable store");
    if (typeof execute !== "function") throw new Error("JobSupervisor requires an execute function");
    this.store = store;
    this.execute = execute;
    this.onCancel = onCancel;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 1);
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.active = new Map();
    this.volatilePayloads = new Map();
    this.volatileResults = new Map();
    this.leaseOwner = `supervisor:${process.pid}`;
    this.leaseEpoch = randomUUID();
    this.started = false;
    this.draining = false;
    this.stopping = false;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.stopping = false;
    const recovery = await this.store.recover({ maxAttempts: this.maxAttempts });
    this.started = true;
    this.scheduleLeaseRecovery(recovery);
    await this.drain();
  }

  async submit(
    payload: JsonObject,
    {
      id = `job_${randomUUID()}`,
      timeoutMs = this.defaultTimeoutMs,
      requestHash,
      retrySafe = false,
      occurrenceKey,
      scheduledFor,
      nextRunAt,
      idempotent = false
    }: {
      id?: string;
      timeoutMs?: number;
      requestHash?: string;
      retrySafe?: boolean;
      occurrenceKey?: string;
      scheduledFor?: string;
      nextRunAt?: string | null;
      idempotent?: boolean;
    } = {}
  ): Promise<JobRecord> {
    const normalizedPayload = payload.task && typeof payload.task === "object" && !Array.isArray(payload.task)
      ? { ...payload, task: { ...payload.task, id } }
      : payload;
    let job: JobRecord;
    try {
      job = await this.store.create({
        id,
        payload: normalizedPayload,
        requestHash,
        retrySafe,
        status: "queued",
        timeoutMs,
        ...(occurrenceKey ? { occurrenceKey } : {}),
        ...(scheduledFor ? { scheduledFor } : {}),
        ...(nextRunAt !== undefined ? { nextRunAt } : {})
      });
      this.volatilePayloads.set(id, normalizedPayload);
    } catch (error) {
      if (!idempotent) throw error;
      const existing = await this.store.get(id);
      if (!existing || existing.occurrenceKey !== occurrenceKey) throw error;
      return existing;
    }
    await this.drain();
    return job;
  }

  async cancel(id: string): Promise<JobRecord> {
    const job = await this.store.get(id);
    if (!job) throw new Error(`job not found: ${id}`);
    if (["completed", "failed", "cancelled", "needs-review"].includes(job.status)) return job;
    const running = this.active.get(id);
    try {
      await this.onCancel?.(job);
    } catch (error) {
      const quarantined = await this.store.update(id, {
        status: "needs-review",
        completedAt: new Date().toISOString(),
        error: `cancellation fence failed: ${errorMessage(error)}`
      });
      running?.controller.abort(new Error("job cancellation fence failed"));
      if (!running) {
        this.volatilePayloads.delete(id);
        await this.drain();
      }
      return quarantined;
    }
    if (running) {
      const cancelling = this.store.cancel
        ? await this.store.cancel(id, { requestedBy: "operator", reason: "job cancelled by user" })
        : await this.store.update(id, { status: "cancelling" });
      running.controller.abort(new Error("job cancelled by user"));
      return cancelling;
    }
    const cancelled = this.store.cancel
      ? await this.store.cancel(id, { requestedBy: "operator", reason: "job cancelled by user" })
      : await this.store.update(id, { status: "cancelled", completedAt: new Date().toISOString() });
    this.volatilePayloads.delete(id);
    await this.drain();
    return cancelled;
  }

  async get(id: string): Promise<JobRecord | undefined> { return this.store.get(id); }
  async list(): Promise<JobRecord[]> { return this.store.list(); }

  getVolatileResult(id: string): unknown | undefined {
    const entry = this.volatileResults.get(id);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.volatileResults.delete(id);
      return undefined;
    }
    return entry.result;
  }

  async settleApproval(id: string, { result, error }: { result?: unknown; error?: unknown }): Promise<JobRecord> {
    const current = await this.store.get(id);
    if (!current || !["running", "cancelling"].includes(current.status)) {
      throw new Error(`runtime job ${id} has no claimed approval execution`);
    }
    return this.store.update(id, error === undefined ? {
      status: "completed",
      completedAt: new Date().toISOString(),
      result
    } : {
      status: "needs-review",
      completedAt: new Date().toISOString(),
      error: errorMessage(error)
    });
  }

  async beginApproval(id: string): Promise<JobRecord> {
    if (!this.store.claimApproval) throw new Error("runtime job store does not support approval claims");
    const claimed = await this.store.claimApproval(id, { status: "running", error: undefined });
    if (!claimed) throw new Error(`runtime job ${id} is no longer awaiting approval`);
    return claimed;
  }

  async drain(): Promise<void> {
    if (!this.started || this.stopping || this.draining) return;
    this.draining = true;
    try {
      while (this.active.size < this.concurrency) {
        const queued = (await this.store.list()).find((job) => job.status === "queued");
        if (!queued) break;
        const attempts = queued.attempts + 1;
        const claimed = await this.store.claim(queued.id, {
          status: "running",
          startedAt: new Date().toISOString(),
          attempts,
          dispatchLease: {
            ...(queued.occurrenceKey ? { occurrenceKey: queued.occurrenceKey } : {}),
            token: randomUUID(),
            owner: this.leaseOwner,
            epoch: this.leaseEpoch,
            acquiredAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + Math.max((queued.timeoutMs || this.defaultTimeoutMs) + 30_000, 120_000)).toISOString()
          }
        });
        if (!claimed) continue;
        const volatilePayload = this.volatilePayloads.get(claimed.id);
        if (claimed.recoveryInputAvailable === false && !volatilePayload) {
          await this.store.update(claimed.id, {
            status: "failed",
            completedAt: new Date().toISOString(),
            error: "volatile execution input is unavailable after restart; resubmit the job with fresh input",
            dispatchLease: undefined
          });
          continue;
        }
        void this.run({ ...claimed, payload: volatilePayload ?? claimed.payload }).catch(() => undefined);
      }
    } finally {
      this.draining = false;
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.volatileResults.clear();
    for (const active of this.active.values()) active.controller.abort(new Error("supervisor shutting down"));
    await Promise.allSettled(Array.from(this.active.values(), (active) => active.promise));
  }

  private run(job: JobRecord): Promise<void> {
    const controller = new AbortController();
    const timeoutMs = job.timeoutMs || this.defaultTimeoutMs;
    const leaseWindowMs = Math.max(timeoutMs + 30_000, 120_000);
    const timeout = setTimeout(() => controller.abort(new Error("job timed out")), timeoutMs);
    const leaseToken = typeof job.dispatchLease?.token === "string" ? job.dispatchLease.token : undefined;
    const heartbeat = leaseToken && this.store.renewLease
      ? setInterval(() => {
          void this.store.renewLease!(job.id, {
            token: leaseToken,
            owner: String(job.dispatchLease?.owner),
            epoch: String(job.dispatchLease?.epoch),
            expiresAt: new Date(Date.now() + leaseWindowMs).toISOString()
          }).then((renewed) => {
            if (!renewed) controller.abort(new Error("job dispatch lease was lost"));
          }).catch(() => controller.abort(new Error("job dispatch lease renewal failed")));
        }, Math.min(30_000, Math.max(1_000, Math.floor(leaseWindowMs / 3))))
      : undefined;
    heartbeat?.unref?.();
    const promise = (async () => {
      let backendReturned = false;
      try {
        const result = await this.execute(job.payload, { signal: controller.signal, job });
        backendReturned = true;
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error("job aborted");
        if (job.payload.executionKey === job.id && (job.payload.task as JsonObject | undefined)?.tool === "agent.run") {
          const now = Date.now();
          for (const [id, entry] of this.volatileResults) {
            if (entry.expiresAt <= now) this.volatileResults.delete(id);
          }
          this.volatileResults.set(job.id, { result, expiresAt: now + 5 * 60_000 });
          while (this.volatileResults.size > 256) this.volatileResults.delete(this.volatileResults.keys().next().value as string);
        }
        const awaitingApproval = Boolean(result && typeof result === "object"
          && (result as { output?: { type?: unknown } }).output?.type === "approval.required");
        const terminalStatus = result && typeof result === "object"
          && ["completed", "failed", "cancelled", "needs-review"].includes(String((result as { terminalStatus?: unknown }).terminalStatus))
          ? String((result as { terminalStatus?: unknown }).terminalStatus)
          : result && typeof result === "object" && (result as { output?: { status?: unknown } }).output
            && ["completed", "failed", "cancelled", "needs-review"].includes(String((result as { output?: { status?: unknown } }).output?.status))
            ? String((result as { output?: { status?: unknown } }).output?.status)
            : undefined;
        await this.store.update(job.id, {
          status: awaitingApproval ? "awaiting-approval" : terminalStatus ?? "completed",
          ...(awaitingApproval ? {} : { completedAt: new Date().toISOString() }),
          result,
          expectedLeaseToken: leaseToken,
          dispatchLease: undefined
        });
      } catch (error) {
        const current = await this.store.get(job.id);
        const reason = controller.signal.reason;
        const cancelled = controller.signal.aborted && reason instanceof Error && reason.message.includes("cancel");
        const message = errorMessage(error);
        const unknownOutcome = !job.retrySafe && (backendReturned || controller.signal.aborted || /worker exited unexpectedly|gateway stopped during execution/i.test(message));
        const retry = !cancelled && job.retrySafe === true && job.recoveryInputAvailable !== false
          && current && current.attempts < this.maxAttempts;
        await this.store.update(job.id, {
          status: retry ? "queued" : unknownOutcome ? "needs-review" : cancelled ? "cancelled" : "failed",
          completedAt: retry ? undefined : new Date().toISOString(),
          error: message,
          expectedLeaseToken: leaseToken,
          dispatchLease: undefined
        });
      } finally {
        clearTimeout(timeout);
        if (heartbeat) clearInterval(heartbeat);
        this.active.delete(job.id);
        try {
          const current = await this.store.get(job.id);
          if (current?.status !== "queued") this.volatilePayloads.delete(job.id);
        } catch {
          this.volatilePayloads.delete(job.id);
        }
        if (!this.stopping) await this.drain();
      }
    })();
    this.active.set(job.id, { controller, promise });
    return promise;
  }

  private scheduleLeaseRecovery(recovery: unknown) {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    const expiresAt = recovery && typeof recovery === "object" && "nextLeaseExpiry" in recovery
      ? (recovery as { nextLeaseExpiry?: unknown }).nextLeaseExpiry
      : undefined;
    if (typeof expiresAt !== "string") return;
    const delay = Math.max(1, Date.parse(expiresAt) - Date.now() + 5);
    this.recoveryTimer = setTimeout(() => {
      void (async () => {
        if (!this.started || this.stopping) return;
        const next = await this.store.recover({ maxAttempts: this.maxAttempts });
        this.scheduleLeaseRecovery(next);
        await this.drain();
      })().catch(() => {
        if (this.started && !this.stopping) {
          this.scheduleLeaseRecovery({ nextLeaseExpiry: new Date(Date.now() + 1_000).toISOString() });
        }
      });
    }, delay);
    this.recoveryTimer.unref?.();
  }
}

interface WorkerPayload extends JsonObject {
  actor?: string;
  approvalId?: string;
  approvalRunId?: string;
  trustedRecovery?: boolean;
  plan?: JsonObject;
  workspaceRoot?: string;
  task?: JsonObject & { tool?: string };
}

interface ExecutorOptions { signal?: AbortSignal; job?: JobRecord }
type TaskExecutor = ((payload: WorkerPayload, options?: ExecutorOptions) => Promise<unknown>) & { shutdown(): Promise<void> };

interface WorkerConfiguration {
  stateDir?: string;
  workspaceRoot?: string;
  config?: unknown;
  policy?: unknown;
}

interface WorkerResponse {
  id?: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  finish(error?: Error, result?: unknown): void;
}

function isWorkerResponse(message: unknown): message is WorkerResponse {
  return Boolean(message && typeof message === "object" && "ok" in message && typeof (message as { ok?: unknown }).ok === "boolean");
}

export function createIsolatedTaskExecutor(options: WorkerConfiguration = {}): TaskExecutor {
  const { stateDir, workspaceRoot, config, policy } = options;
  const authoritativeRoot = resolve(workspaceRoot ?? process.cwd());
  const workerPath = fileURLToPath(new URL(
    typeof __ODINN_COMPILED__ !== "undefined" ? "../workers/task-worker.js" : "./task-worker.ts",
    import.meta.url
  ));
  const browserWorkerPath = fileURLToPath(new URL(
    typeof __ODINN_COMPILED__ !== "undefined" ? "../workers/browser-worker.js" : "./browser-worker.ts",
    import.meta.url
  ));
  const browserExecutor = createPersistentWorkerExecutor({ workerPath: browserWorkerPath, stateDir, workspaceRoot: authoritativeRoot, config, policy });
  const children = new Set<ChildProcess>();
  const execute = ((payload: WorkerPayload, { signal, job }: ExecutorOptions = {}) => {
    const trustedRecovery = payload.trustedRecovery === true || Number(job?.attempts ?? 0) > 1;
    const taskWorkspaceRoot = resolve(payload.workspaceRoot || authoritativeRoot);
    if (taskWorkspaceRoot !== authoritativeRoot && !taskWorkspaceRoot.startsWith(`${authoritativeRoot}${sep}`)) {
      return Promise.reject(new Error("task workspaceRoot must remain inside the gateway workspace"));
    }
    if (String(payload.task?.tool || "").startsWith("browser.")) {
      return browserExecutor({ ...payload, workspaceRoot: taskWorkspaceRoot }, { signal, job });
    }
    return new Promise<unknown>((resolve, reject) => {
      const child = fork(workerPath, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      children.add(child);
      let settled = false;
      let abortGraceTimer: NodeJS.Timeout | undefined;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        if (abortGraceTimer) clearTimeout(abortGraceTimer);
        children.delete(child);
        signal?.removeEventListener("abort", abort);
        child.removeAllListeners();
        if (child.connected) child.disconnect();
        if (error) reject(error);
        else resolve(result);
      };
      const abort = () => {
        const reason = signal?.reason instanceof Error ? signal.reason : new Error("isolated task aborted");
        if (payload.task?.tool === "process.exec") {
          try {
            if (child.connected) child.send({ type: "abort" });
          } catch {
            child.kill();
            finish(reason);
            return;
          }
          abortGraceTimer = setTimeout(() => {
            child.kill();
            finish(reason);
          }, PROCESS_WORKER_ABORT_GRACE_MS);
          abortGraceTimer.unref?.();
          return;
        }
        child.kill();
        finish(reason);
      };
      child.on("message", (message) => {
        if (!isWorkerResponse(message)) return finish(new Error("isolated task returned an invalid response"));
        if (message.ok) finish(undefined, message.result);
        else finish(new Error(message.error || "isolated task failed"));
      });
      child.on("error", (error) => finish(error));
      child.on("exit", (code, exitSignal) => {
        if (!settled) finish(new Error(`forked task worker exited unexpectedly: ${code ?? exitSignal}`));
      });
      signal?.addEventListener("abort", abort, { once: true });
      child.send({ type: "task", payload, stateDir, workspaceRoot: taskWorkspaceRoot, config, policy, trustedRecovery });
    });
  }) as TaskExecutor;
  execute.shutdown = async () => {
    await browserExecutor.shutdown();
    for (const child of children) child.kill();
    children.clear();
  };
  return execute;
}

function createPersistentWorkerExecutor(options: WorkerConfiguration & { workerPath: string }): TaskExecutor {
  const { workerPath, stateDir, workspaceRoot, config, policy } = options;
  let child: ChildProcess | undefined;
  let sequence = 0;
  let shuttingDown = false;
  const pending = new Map<string, PendingRequest>();

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) request.finish(error);
    pending.clear();
  };

  const ensureChild = (): ChildProcess => {
    if (child?.connected) return child;
    const currentChild = fork(workerPath, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    child = currentChild;
    currentChild.on("message", (message) => {
      if (!isWorkerResponse(message) || typeof message.id !== "string") return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.ok) request.finish(undefined, message.result);
      else request.finish(new Error(message.error || "persistent worker failed"));
    });
    currentChild.on("error", (error) => rejectPending(error));
    currentChild.on("exit", (code, exitSignal) => {
      if (currentChild.connected) currentChild.disconnect();
      if (child === currentChild) child = undefined;
      if (!shuttingDown) rejectPending(new Error(`persistent worker exited unexpectedly: ${code ?? exitSignal}`));
    });
    return currentChild;
  };

  const execute = ((payload: WorkerPayload, { signal, job }: ExecutorOptions = {}) => new Promise<unknown>((resolve, reject) => {
    if (shuttingDown) return reject(new Error("persistent worker is shutting down"));
    const id = `request_${++sequence}`;
    let settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => {
      const error = signal?.reason instanceof Error ? signal.reason : new Error("persistent task aborted");
      rejectPending(error);
      child?.kill();
      finish(error);
    };
    pending.set(id, { finish });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      ensureChild().send({ type: "task", id, payload, stateDir, workspaceRoot, config, policy, trustedRecovery: Number(job?.attempts ?? 0) > 1 }, (error) => {
        if (error) {
          pending.delete(id);
          finish(error);
        }
      });
    } catch (error) {
      pending.delete(id);
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  })) as TaskExecutor;

  execute.shutdown = async () => {
    shuttingDown = true;
    if (!child) return;
    const current = child;
    rejectPending(new Error("persistent worker shutting down"));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { current.kill(); resolve(); }, 5_000);
      current.once("exit", () => { clearTimeout(timer); resolve(); });
      if (current.connected) current.send({ type: "shutdown" });
      else current.kill();
    });
    child = undefined;
  };
  return execute;
}
