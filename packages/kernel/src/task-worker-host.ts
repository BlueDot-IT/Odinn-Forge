import { join } from "node:path";
import { exit as exitProcess } from "node:process";
import type { RuntimePolicy } from "@odinn/policy";
import {
  closeBrowserManagers,
  createApprovalStore,
  createAuditStore,
  createRunLedger,
  normalizeExperimentalFlags,
  runPlan,
  runTask,
  withStateMutationLock
} from "./index.ts";
import { createSandboxProcessExecutor } from "./sandbox-process.ts";

type WorkerRegistry = Map<string, any> & { close(): void };
type WorkerRegistryFactory = (options: Record<string, any>) => WorkerRegistry;

interface TaskWorkerMessage {
  type?: "task" | "abort";
  payload?: { actor?: string; approvalId?: string; approvalRunId?: string; durableExecution?: boolean; parentCapabilities?: unknown; plan?: unknown; task?: unknown };
  stateDir?: string;
  workspaceRoot?: string;
  config?: { auditLog?: string; experimental?: unknown; [key: string]: unknown };
  policy?: RuntimePolicy;
  trustedRecovery?: boolean;
}

const messageError = (error: unknown) => error instanceof Error ? error.message : String(error);

export function installTaskWorker(createRegistry: WorkerRegistryFactory): void {
  let shuttingDown = false;
  let activeAbortController: AbortController | undefined;
  let active = false;
  const workerStateInitializationTimeoutMs = 60_000;

  const executeMessage = async (rawMessage: unknown) => {
    let runLedger: ReturnType<typeof createRunLedger> | undefined;
    let registry: WorkerRegistry | undefined;
    let auditStore: ReturnType<typeof createAuditStore> | undefined;
    let approvalStore: ReturnType<typeof createApprovalStore> | undefined;
    const controller = new AbortController();
    activeAbortController = controller;
    active = true;
    try {
      if (!rawMessage || typeof rawMessage !== "object") throw new Error("task worker received an invalid envelope");
      const { payload, stateDir, workspaceRoot, config = {}, policy, trustedRecovery } = rawMessage as TaskWorkerMessage;
      if (!payload || !stateDir || !workspaceRoot) throw new Error("task worker received an incomplete envelope");
      await withStateMutationLock(stateDir, async () => {
        auditStore = createAuditStore(join(stateDir, config.auditLog ?? "audit.jsonl"));
        approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
        const processExecutor = createSandboxProcessExecutor({ workspaceRoot, stateDir, config });
        registry = createRegistry({ workspaceRoot, stateDir, config, approvalStore, auditStore, processExecutor });
        runLedger = createRunLedger({ stateDir, workspaceRoot, featureFlags: normalizeExperimentalFlags(config.experimental) });
      }, {
        // Windows applies owner-only ACLs while each isolated worker opens the
        // shared state. Concurrent read surfaces can therefore legitimately
        // serialize longer than the general interactive mutation timeout.
        timeoutMs: workerStateInitializationTimeoutMs
      });
      const result = payload.plan
        ? await runPlan({ plan: payload.plan, auditStore, policy, registry, runLedger, actor: payload.actor, signal: controller.signal, durableExecution: payload.durableExecution === true })
        : await runTask({ task: payload.task, auditStore, approvalStore, policy, registry, runLedger, signal: controller.signal, trustedApprovalId: payload.approvalId, trustedApprovalRunId: payload.approvalRunId, trustedRecovery: trustedRecovery === true, durableExecution: payload.durableExecution === true, parentCapabilities: payload.parentCapabilities });
      process.send?.({ ok: true, result });
    } catch (error) {
      process.send?.({ ok: false, error: messageError(error) });
    } finally {
      activeAbortController = undefined;
      active = false;
      registry?.close();
      runLedger?.close();
      auditStore?.close();
    }
  };

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await closeBrowserManagers();
    exitProcess(0);
  };

  process.on("message", (rawMessage: unknown) => {
    if (rawMessage && typeof rawMessage === "object" && (rawMessage as TaskWorkerMessage).type === "abort") {
      activeAbortController?.abort(new Error("isolated task aborted"));
      return;
    }
    if (active) return;
    void executeMessage(rawMessage);
  });
  process.on("disconnect", shutdown);
  process.on("SIGTERM", shutdown);
}
