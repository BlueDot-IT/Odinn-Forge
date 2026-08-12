import { join } from "node:path";
import type { RuntimePolicy } from "@odinn/policy";
import {
  closeBrowserManagers,
  createApprovalStore,
  createAuditStore,
  createRunLedger,
  normalizeExperimentalFlags,
  runTask,
  withStateMutationLock
} from "./index.ts";

type WorkerRegistry = Map<string, any> & { close(): void };
type WorkerRegistryFactory = (options: Record<string, any>) => WorkerRegistry;

interface BrowserWorkerMessage {
  type?: "task" | "shutdown";
  id?: string;
  payload?: { approvalId?: string; approvalRunId?: string; task?: unknown };
  stateDir?: string;
  workspaceRoot?: string;
  config?: { auditLog?: string; experimental?: unknown };
  policy?: RuntimePolicy;
  trustedRecovery?: boolean;
}

const messageError = (error: unknown) => error instanceof Error ? error.message : String(error);

export function installBrowserWorker(createRegistry: WorkerRegistryFactory): void {
  let queue = Promise.resolve();
  let shuttingDown = false;

  const handle = async (message: BrowserWorkerMessage) => {
    if (message?.type === "shutdown") {
      shuttingDown = true;
      await queue;
      await closeBrowserManagers();
      process.exit(0);
    }
    if (message?.type !== "task") return;
    queue = queue.then(async () => {
      let runLedger: ReturnType<typeof createRunLedger> | undefined;
      let registry: WorkerRegistry | undefined;
      let auditStore: ReturnType<typeof createAuditStore> | undefined;
      try {
        const { payload, stateDir, workspaceRoot, config = {}, policy } = message;
        if (!payload?.task || !stateDir || !workspaceRoot) throw new Error("browser worker received an invalid task envelope");
        await withStateMutationLock(stateDir, async () => {
          auditStore = createAuditStore(join(stateDir, config.auditLog ?? "audit.jsonl"));
          const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
          registry = createRegistry({ workspaceRoot, stateDir, config, approvalStore, auditStore });
          runLedger = createRunLedger({ stateDir, workspaceRoot, featureFlags: normalizeExperimentalFlags(config.experimental) });
        });
        const result = await runTask({ task: payload.task, auditStore, policy, registry, runLedger, signal: undefined, trustedApprovalId: payload.approvalId, trustedApprovalRunId: payload.approvalRunId, trustedRecovery: message.trustedRecovery === true });
        process.send?.({ id: message.id, ok: true, result });
      } catch (error) {
        process.send?.({ id: message.id, ok: false, error: messageError(error) });
      } finally {
        registry?.close();
        runLedger?.close();
        auditStore?.close();
      }
    });
    await queue;
  };

  process.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    if (!shuttingDown) handle(message as BrowserWorkerMessage).catch(() => undefined);
  });
  process.on("disconnect", async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await queue;
    await closeBrowserManagers();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await queue;
    await closeBrowserManagers();
    process.exit(0);
  });
}
