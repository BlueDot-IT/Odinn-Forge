import { closeBrowserManagers, createAuditStore, createApprovalStore, createBuiltInRegistry, createRunLedger, normalizeExperimentalFlags, runPlan, runTask } from "./index.ts";
import { createSandboxProcessExecutor } from "./sandbox-process.ts";
import { join } from "node:path";
import type { RuntimePolicy } from "@odinn/policy";

let shuttingDown = false;
let activeAbortController: AbortController | undefined;
let active = false;

interface TaskWorkerMessage {
  type?: "task" | "abort";
  payload?: { actor?: string; approvalId?: string; approvalRunId?: string; trustedRecovery?: boolean; durableExecution?: boolean; parentCapabilities?: unknown; plan?: unknown; task?: unknown };
  stateDir?: string;
  workspaceRoot?: string;
  config?: { auditLog?: string; experimental?: unknown; [key: string]: unknown };
  policy?: RuntimePolicy;
  trustedRecovery?: boolean;
}

const messageError = (error: unknown) => error instanceof Error ? error.message : String(error);

async function executeMessage(rawMessage: unknown) {
  let runLedger;
  let registry: ReturnType<typeof createBuiltInRegistry> | undefined;
  let auditStore: ReturnType<typeof createAuditStore> | undefined;
  const controller = new AbortController();
  activeAbortController = controller;
  active = true;
  try {
    if (!rawMessage || typeof rawMessage !== "object") throw new Error("task worker received an invalid envelope");
    const { payload, stateDir, workspaceRoot, config = {}, policy, trustedRecovery } = rawMessage as TaskWorkerMessage;
    if (!payload || !stateDir || !workspaceRoot) throw new Error("task worker received an incomplete envelope");
    auditStore = createAuditStore(join(stateDir, config.auditLog ?? "audit.jsonl"));
    const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
    const processExecutor = createSandboxProcessExecutor({ workspaceRoot, stateDir, config });
    const registryOptions = { workspaceRoot, stateDir, config, approvalStore, auditStore, processExecutor };
    registry = createBuiltInRegistry(registryOptions);
    runLedger = createRunLedger({ stateDir, workspaceRoot, featureFlags: normalizeExperimentalFlags(config.experimental) });
    const result = payload.plan
      ? await runPlan({ plan: payload.plan, auditStore, policy, registry, runLedger, actor: payload.actor, signal: controller.signal, durableExecution: payload.durableExecution === true })
      : await runTask({ task: payload.task, auditStore, policy, registry, runLedger, signal: controller.signal, trustedApprovalId: payload.approvalId, trustedApprovalRunId: payload.approvalRunId, trustedRecovery: trustedRecovery === true, durableExecution: payload.durableExecution === true, parentCapabilities: payload.parentCapabilities });
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
}

process.on("message", (rawMessage: unknown) => {
  if (rawMessage && typeof rawMessage === "object" && (rawMessage as TaskWorkerMessage).type === "abort") {
    activeAbortController?.abort(new Error("isolated task aborted"));
    return;
  }
  if (active) return;
  void executeMessage(rawMessage);
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await closeBrowserManagers();
  process.exit(0);
}

process.on("disconnect", shutdown);
process.on("SIGTERM", shutdown);
