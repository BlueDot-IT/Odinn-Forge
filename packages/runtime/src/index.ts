import { fileURLToPath } from "node:url";
import { createDiscordAgentToolDefinitions } from "@odinn/channel-discord";
import { createApprovalStore, createBuiltInRegistry, createIsolatedTaskExecutor } from "@odinn/kernel";

declare const __ODINN_COMPILED__: boolean | undefined;

export function createRuntimeRegistry(options: Record<string, any> = {}) {
  const {
    approvalStore = createApprovalStore(),
    discordFetch = globalThis.fetch,
    ...kernelOptions
  } = options;
  const channelAgentTools = createDiscordAgentToolDefinitions({
    config: kernelOptions.config,
    fetch: discordFetch
  });
  return createBuiltInRegistry({
    ...kernelOptions,
    approvalStore,
    channelAgentTools
  });
}

export function createRuntimeIsolatedTaskExecutor(options: Record<string, any> = {}) {
  const compiled = typeof __ODINN_COMPILED__ !== "undefined";
  const taskWorkerPath = fileURLToPath(new URL(
    compiled ? "../workers/task-worker.js" : "./task-worker.ts",
    import.meta.url
  ));
  const browserWorkerPath = fileURLToPath(new URL(
    compiled ? "../workers/browser-worker.js" : "./browser-worker.ts",
    import.meta.url
  ));
  return createIsolatedTaskExecutor({
    ...options,
    taskWorkerPath,
    browserWorkerPath
  });
}
