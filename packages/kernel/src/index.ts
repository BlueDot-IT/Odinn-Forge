import { existsSync } from "node:fs";
import { hostname, platform, release } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { createDefaultPolicy, evaluateTaskPolicy, assertAllowed } from "@odinn/policy";
import { createRunId, normalizeTaskRequest } from "@odinn/protocol";
import { FileAuditStore } from "@odinn/store-file";
import { legacyRecordMigrationStatus, migrateLegacyRecordsToSqlite, SqliteRecordStore } from "@odinn/store-sqlite";
import { captureAncestorIdentities, MAX_BOUNDED_UTF8_BYTES, readUtf8Prefix } from "./skill-packages.ts";
export { MAX_BOUNDED_UTF8_BYTES, SkillPackageStore, readUtf8Prefix, validateSkillPackage } from "./skill-packages.ts";
export { loadEnvironmentFiles } from "./environment.ts";
export type { EnvironmentLoadOptions, LoadedEnvironmentFile } from "./environment.ts";
export { capabilityTokensPlugin, capsulesPlugin, counterfactualPlugin, loadRuntimePlugins } from "./plugins/index.ts";
export type { LoadedRuntimePlugin, RuntimePlugin, RuntimePluginContext } from "./plugins/index.ts";
import { ADVANCED_FEATURE_BRANDS, CORE_ADVANCED_FEATURES, createRunLedger, EXPERIMENTAL_FEATURES, advancedFeatureLabel, experimentalFeatureWarning, normalizeExperimentalFlags } from "./run-ledger.ts";
import { toolSafetyDescriptor } from "./tool-safety.ts";
import { CapabilityBroker, DarwinRouter, OdinnRuntimeError, Sentinel } from "./differentiated-runtime.ts";
import { withStateMutationLock } from "./state-mutation.ts";
import { appendSessionMessage, assignSessionProject, createGoal, createProject, createSession, DEFAULT_PROJECT_ID, deleteSession, listGoals, listProjects, listSessions, readSession, renameSession, resolveSession, updateGoal, updateProject, updateSession } from "./workspace-records.ts";
import { browseMemory, compactMemory, correctMemory, curateMemory, decideMemoryCandidate, forgetMemory, formatMemoryContext, learnFromConversation, listMemoryCandidates, normalizeMemoryOptions, openMemory, recallMemory, remember, searchMemory, suggestMemory } from "./memory.ts";
import { createApprovalStore } from "./approvals.ts";
import { fetchWebPage, searchWeb, withWebRequestSlot, dnsLookupAll } from "./web.ts";
import { browserAction, browserOpen, browserRecoveryResolve, browserRecoveryStatus, browserSnapshot, browserTabs, closeBrowserManagers } from "./browser.ts";
import { chatWithModel, createOAuthAuthorizationRequest, exchangeOAuthCode, listConfiguredModels, mergeUsage, normalizeModelConfig, normalizeProviderAuth, normalizeUsage, oauthTokenPath, saveOAuthToken } from "./providers/runtime.ts";
import { decideImprovement, learnImprovements, listImprovements, normalizeSelfImprovementConfig, proposeImprovement, rollbackImprovement } from "./improvements.ts";
import { DEFAULT_AGENT_ID, loadAgent } from "./agents.ts";
import { createDiscordAgentTools, DISCORD_AGENT_TOOL_SCHEMAS } from "./discord.ts";
type AnyRecord = Record<string, any>;
type NodeError = Error & { code?: string };
export { JobSupervisor, createIsolatedTaskExecutor } from "./jobs.ts";
export { ExtensionRegistry, ExtensionExecutor } from "./extensions.ts";
export { CapabilityBroker, CapsuleManager, CounterfactualManager, DarwinRouter, OdinnRuntimeError, ProofEngine, Sentinel, SnapshotManager, createDifferentiatedRuntime, parseStructuredDocument, validateContract, validatePolicy } from "./differentiated-runtime.ts";
export { PROOF_CONTRACT_SCHEMA_VERSION, ProofVerifier, validateProofContract, validateVerificationContract, verifyContract, verifyProof } from "./proof.ts";
export { ADVANCED_FEATURE_BRANDS, CORE_ADVANCED_FEATURES, createRunLedger, EXPERIMENTAL_FEATURES, advancedFeatureLabel, experimentalFeatureWarning, normalizeExperimentalFlags, toolSafetyDescriptor };
export type { AdvancedFeature } from "./features.ts";
export { withStateMutationLock } from "./state-mutation.ts";
export { STATE_SCHEMA_MINIMUM_APPLICATION_VERSION, STATE_SCHEMA_OWNERS, STATE_SCHEMA_TARGETS, targetStateSchemaVersions } from "./state/schema-registry.ts";
export type { StateSchemaOwner, StateSchemaVersions, StateSupport, StateSurface } from "./state/schema-registry.ts";
export { applyStateMigrations, ensureStateCompatibility, inspectStateSchemas, planStateMigration, recoverInterruptedStateMigration } from "./state/migration-manager.ts";
export type { PlannedMigrationStep, StateCompatibilityOptions, StateInspection, StateMigrationPlan, StateMigrationReport, StateSurfaceStatus } from "./state/migration-manager.ts";
export { createStateBackup, inspectStateBackup, restoreStateBackup, stateLifecycleStatus } from "./state/backup-manager.ts";
export type { BackupApplicationIdentity, CreateStateBackupOptions, InspectedStateBackup, RestoreStateBackupOptions, RestoreStateBackupReport, StateBackupFile, StateBackupManifest } from "./state/backup-manager.ts";
export { CUSTOM_PROVIDER_SUPPORT, listProviderPresets, providerSupport, PROVIDER_PRESETS, PROVIDER_REGISTRY } from "./providers/registry.ts";
export type { ProviderAuthMode, ProviderAuthorization, ProviderAuthVariant, ProviderDefinition, ProviderPresetInput, ProviderSupportDescriptor, ProviderSupportTier, ProviderTransport } from "./providers/types.ts";
export { createOAuthAuthorizationRequest, exchangeOAuthCode, listConfiguredModels, normalizeModelConfig, normalizeProviderAuth, normalizeUsage, oauthTokenPath, saveOAuthToken } from "./providers/runtime.ts";
export { appendSessionMessage, assignSessionProject, createGoal, createProject, createSession, DEFAULT_PROJECT_ID, deleteSession, listGoals, listProjects, listSessions, readSession, reduceGoals, reduceProjects, reduceSessions, renameSession, updateGoal, updateProject, updateSession } from "./workspace-records.ts";
export type { GoalCommandInput, GoalView, ProjectCommandInput, ProjectView, SessionCommandInput, SessionView, WorkspaceRecord, WorkspaceRecordStore } from "./workspace-records.ts";
export { browseMemory, compactMemory, correctMemory, curateMemory, decideMemoryCandidate, forgetMemory, listMemoryCandidates, openMemory, recallMemory, remember, searchMemory, suggestMemory } from "./memory.ts";
export type { MemoryCommandInput, MemoryRecordStore } from "./memory.ts";
export { createApprovalStore } from "./approvals.ts";
export type { ApprovalAction, ApprovalStore } from "./approvals.ts";
export { ensureSecureStateDirectory, isOwnerOnlyPath } from "@odinn/store-file";
export { closeBrowserManagers } from "./browser.ts";
export { normalizeSelfImprovementConfig } from "./improvements.ts";
export { AGENT_BOOTSTRAP_FILE, AGENT_IDENTITY_FILES, AGENT_SDK_VERSION, DEFAULT_AGENT_ID, defaultMainAgentManifest, ensureMainAgent, loadAgent, validateAgentManifest } from "./agents.ts";
export type { AgentManifest } from "./agents.ts";


export type BuiltInRegistry = Map<string, any> & { close(): void };

export function createBuiltInRegistry({ workspaceRoot = process.cwd(), stateDir = ".odinn", config = {}, approvalStore = createApprovalStore(), auditStore, resolveNetworkAddresses = dnsLookupAll, discordFetch = globalThis.fetch }: any = {}): BuiltInRegistry {
  const root = resolve(workspaceRoot);
  const stateRoot = resolve(stateDir);
  const legacyRecordPath = join(stateRoot, "records.jsonl");
  const recordDatabasePath = join(stateRoot, "db", "records.sqlite");
  const migration = legacyRecordMigrationStatus({ legacyPath: legacyRecordPath, databasePath: recordDatabasePath });
  if (existsSync(legacyRecordPath) && !migration?.complete) migrateLegacyRecordsToSqlite({ legacyPath: legacyRecordPath, databasePath: recordDatabasePath });
  const recordStore = new SqliteRecordStore(recordDatabasePath);
  const modelConfig = normalizeModelConfig(config);
  const registry = new Map([
    ["job.healthcheck", {
      capability: "job.healthcheck",
      description: "Return deterministic local runtime health.",
      execute: async () => ({
        ok: true,
        platform: platform(),
        release: release(),
        hostname: hostname(),
        workspaceRoot: root
      })
    }],
    ["text.echo", {
      capability: "text.echo",
      description: "Return provided text without model involvement.",
      execute: async ({ text = "" }: any) => ({ text: String(text) })
    }],
    ["workspace.readText", {
      capability: "workspace.readText",
      description: "Read a UTF-8 text file confined to the workspace root. maxBytes is a positive byte limit capped at 8388608; content is valid UTF-8 and at most maxBytes bytes; bytesRead reports the bounded probe of up to maxBytes + 1 bytes; truncated is byte-based.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, maxBytes: { type: "integer", minimum: 1, maximum: MAX_BOUNDED_UTF8_BYTES } }, required: ["path"] },
      execute: async ({ path, maxBytes = 65_536 }: any) => {
        if (typeof path !== "string" || path.trim() === "") throw new Error("workspace.readText requires path");
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BOUNDED_UTF8_BYTES) {
          throw new Error(`workspace.readText maxBytes must be a positive safe integer no greater than ${MAX_BOUNDED_UTF8_BYTES}`);
        }
        const realRoot = await realpath(root);
        const lexicalTarget = resolve(realRoot, path);
        const lexicalRelative = relative(realRoot, lexicalTarget);
        if (lexicalRelative === "" || lexicalRelative.startsWith("..") || lexicalRelative.includes("..\\")) throw new Error("workspace.readText path escapes workspace root");
        const admissionAncestors = await captureAncestorIdentities(realRoot, lexicalTarget, "workspace.readText");
        const admissionTarget = await stat(lexicalTarget);
        const target = await realpath(lexicalTarget);
        const rel = relative(realRoot, target);
        if (rel === "" || rel.startsWith("..") || rel.includes("..\\") || target !== realRoot && !target.startsWith(`${realRoot}${sep}`)) {
          throw new Error("workspace.readText path escapes workspace root");
        }
        const bounded = await readUtf8Prefix(target, maxBytes, "workspace.readText", {
          confinementRoot: realRoot,
          expectedAncestors: admissionAncestors,
          expectedFileIdentity: { dev: admissionTarget.dev, ino: admissionTarget.ino }
        });
        return {
          path: rel.replaceAll("\\", "/"),
          content: bounded.content,
          bytesRead: bounded.bytesRead,
          truncated: bounded.truncated
        };
      }
    }],
    ["web.search", {
      capability: "web.read",
      description: "Search the public web and return ranked results with snippets.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] },
      execute: async (input: any) => withWebRequestSlot(() => searchWeb(input))
    }],
    ["web.fetch", {
      capability: "web.read",
      description: "Fetch and extract readable content from a public web page.",
      inputSchema: { type: "object", properties: { url: { type: "string" }, maxChars: { type: "integer" } }, required: ["url"] },
      execute: async (input: any, context: any) => withWebRequestSlot(() => fetchWebPage(input, context.policy?.security?.web, resolveNetworkAddresses))
    }],
    ["browser.tabs", {
      capability: "browser.read",
      description: "List tabs in Ódinn Forge's persistent browser profile.",
      inputSchema: { type: "object", properties: {} },
      execute: async (_input: any, context: any) => browserTabs(stateDir, context.policy?.security?.browser)
    }],
    ["browser.open", {
      capability: "browser.read",
      description: "Open a URL and return its title, URL, visible text, links, and snapshot id. Use browser.snapshot only after the page changes.",
      inputSchema: { type: "object", properties: { url: { type: "string" }, tabId: { type: "string" } }, required: ["url"] },
      execute: async (input: any, context: any) => browserOpen(stateDir, input, context.policy?.security?.browser, resolveNetworkAddresses)
    }],
    ["browser.snapshot", {
      capability: "browser.read",
      description: "Read the visible page, title, and links from a browser tab.",
      inputSchema: { type: "object", properties: { tabId: { type: "string" } } },
      execute: async (input: any, context: any) => browserSnapshot(stateDir, input, context.policy?.security?.browser)
    }],
    ["browser.click", {
      capability: "browser.act",
      description: "Click a browser control after explicit user approval.",
      inputSchema: { type: "object", properties: { tabId: { type: "string" }, snapshotId: { type: "string" }, selector: { type: "string" }, role: { type: "string" }, name: { type: "string" }, text: { type: "string" } } },
      execute: async (input: any, context: any) => browserAction(stateDir, approvalStore, "browser.click", input, context.policy?.security?.browser, { approvalId: context.trustedApprovalId, runId: context.trustedApprovalRunId ?? context.request.id })
    }],
    ["browser.type", {
      capability: "browser.act",
      description: "Fill a browser field after explicit user approval.",
      inputSchema: { type: "object", properties: { tabId: { type: "string" }, snapshotId: { type: "string" }, selector: { type: "string" }, name: { type: "string" }, value: { type: "string" }, sensitive: { type: "boolean" } }, required: ["value"] },
      execute: async (input: any, context: any) => browserAction(stateDir, approvalStore, "browser.type", input, context.policy?.security?.browser, { approvalId: context.trustedApprovalId, runId: context.trustedApprovalRunId ?? context.request.id })
    }],
    ["browser.press", {
      capability: "browser.act",
      description: "Press a browser key after explicit user approval.",
      inputSchema: { type: "object", properties: { tabId: { type: "string" }, snapshotId: { type: "string" }, key: { type: "string" } }, required: ["key"] },
      execute: async (input: any, context: any) => browserAction(stateDir, approvalStore, "browser.press", input, context.policy?.security?.browser, { approvalId: context.trustedApprovalId, runId: context.trustedApprovalRunId ?? context.request.id })
    }],
    ["browser.recovery.status", {
      capability: "browser.read",
      description: "Inspect unresolved browser mutations after a crash, tab loss, or uncertain action outcome.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => browserRecoveryStatus(stateDir)
    }],
    ["browser.recovery.resolve", {
      capability: "browser.act",
      description: "Resolve an uncertain browser mutation after operator inspection.",
      execute: async (input: any) => browserRecoveryResolve(stateDir, input)
    }],
    ["agent.run", {
      capability: "agent.run",
      description: "Run a bounded model/tool loop with web and browser capabilities.",
      execute: async (input: any, context: any) => runAgent(modelConfig, input, {
        stateDir,
        defaultAgentId: config.defaultAgentId,
        memoryStore: recordStore,
        auditStore: context.auditStore,
        runId: context.request.id,
        registry: context.registry,
        runTool: context.runTool,
        runLedger: context.runLedger,
        policy: context.policy,
        signal: context.signal,
        onModelDelta: context.onModelDelta,
        onProviderAttempt: context.onProviderAttempt,
        onAgentProgress: context.onAgentProgress
      })
    }],
    ["model.chat", {
      capability: "model.chat",
      description: "Send a chat completion through a configured OpenAI-compatible provider.",
      execute: async (input: any, context: any) => {
        const startedAt = Date.now();
        const taskClass = typeof input.taskClass === "string" && input.taskClass.trim() ? input.taskClass.trim() : "general";
        const router = context.runLedger ? new DarwinRouter({ ledger: context.runLedger }) : undefined;
        const availableModels = listConfiguredModels(modelConfig).map((model: any) => model.id);
        let selectedModel = typeof input.model === "string" && input.model.trim() ? input.model.trim() : "";
        let routingDecisionRecorded = false;
        if (selectedModel && router) {
          router.choose(taskClass, { pinnedModel: selectedModel, availableModels, runId: context.request.id });
          routingDecisionRecorded = true;
        } else if (router && availableModels.length) {
          try {
            selectedModel = router.choose(taskClass, { availableModels, runId: context.request.id }).model;
            routingDecisionRecorded = true;
          } catch (error) {
            if (!(error instanceof OdinnRuntimeError) || error.code !== "MODEL_ROUTING_UNAVAILABLE") throw error;
          }
        }
        selectedModel ||= modelConfig.defaultModel ?? "";
        if (router && selectedModel && !routingDecisionRecorded) {
          router.recordDecision({
            runId: context.request.id,
            taskClass,
            model: selectedModel,
            source: "configured-default",
            reason: "no applicable Darwin observations; used the configured default"
          });
        }
        const modelInput = {
          ...(input.retries === undefined && input.maxRetries === undefined && config.runtime?.modelRetries !== undefined
            ? { retries: config.runtime.modelRetries }
            : {}),
          ...input,
          ...(selectedModel ? { model: selectedModel } : {})
        };
        let output;
        try {
          output = await chatWithModel(modelConfig, modelInput, {
            stateDir,
            signal: context.signal,
            onDelta: context.onModelDelta,
            onProviderAttempt: context.onProviderAttempt
          });
        } catch (error) {
          const separator = selectedModel.indexOf(":");
          if (router && separator > 0) {
            try {
              router.observe({
                runId: context.request.id,
                providerId: selectedModel.slice(0, separator),
                modelId: selectedModel.slice(separator + 1),
                taskClass,
                durationMs: Date.now() - startedAt,
                toolErrors: 1
              });
            } catch {
              // Routing telemetry must never replace the provider failure.
            }
          }
          throw error;
        }
        context.runLedger?.database.db.prepare("UPDATE runs SET provider_id = ?, model_id = ? WHERE id = ?")
          .run(output.provider, output.model, context.request.id);
        if (router) {
          router.observe({
            runId: context.request.id,
            providerId: output.provider,
            modelId: output.model,
            taskClass,
            partiallyVerified: true,
            durationMs: Date.now() - startedAt,
            toolCalls: "toolCalls" in output && Array.isArray(output.toolCalls) ? output.toolCalls.length : 0
          });
        }
        return output;
      }
    }],
    ["memory.remember", {
      capability: "memory.write",
      description: "Store a typed, provenance-bearing memory record.",
      inputSchema: { type: "object", properties: { text: { type: "string" }, kind: { type: "string", enum: ["project", "person", "artifact", "correction", "procedure", "decision", "preference", "system"] }, subject: { type: "string" }, tags: { type: "array", items: { type: "string" } }, expiresAt: { type: "string" } }, required: ["text"] },
      execute: async (input: any) => remember(recordStore, input)
    }],
    ["memory.suggest", {
      capability: "memory.write",
      description: "Record an automatically learned memory suggestion for later user curation.",
      execute: async (input: any) => suggestMemory(recordStore, input)
    }],
    ["memory.candidates", {
      capability: "memory.read",
      description: "List automatic memory suggestions and their curation status.",
      execute: async (input: any) => listMemoryCandidates(recordStore, input)
    }],
    ["memory.decide", {
      capability: "memory.write",
      description: "Accept or reject one pending memory suggestion.",
      execute: async (input: any) => decideMemoryCandidate(recordStore, input)
    }],
    ["memory.search", {
      capability: "memory.read",
      description: "Search active memory records.",
      execute: async (input: any) => searchMemory(recordStore, input)
    }],
    ["memory.recall", {
      capability: "memory.read",
      description: "Recall ranked memories relevant to the current task.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, kind: { type: "string" }, limit: { type: "integer" } }, required: ["query"] },
      execute: async (input: any) => recallMemory(recordStore, input)
    }],
    ["memory.browse", {
      capability: "memory.read",
      description: "Browse the hierarchical memory namespace.",
      inputSchema: { type: "object", properties: { namespace: { type: "string" } } },
      execute: async (input: any) => browseMemory(recordStore, input)
    }],
    ["memory.open", {
      capability: "memory.read",
      description: "Open one durable memory record by id.",
      execute: async (input: any) => openMemory(recordStore, input)
    }],
    ["memory.compact", {
      capability: "memory.write",
      description: "Compact a session into a durable context summary.",
      execute: async (input: any) => compactMemory(recordStore, input)
    }],
    ["memory.correct", {
      capability: "memory.write",
      description: "Supersede a memory record with a correction.",
      execute: async (input: any) => correctMemory(recordStore, input)
    }],
    ["memory.forget", {
      capability: "memory.write",
      description: "Deactivate a memory so it is no longer searched or recalled.",
      execute: async (input: any) => forgetMemory(recordStore, input)
    }],
    ["memory.curate", {
      capability: "memory.read",
      description: "Return a compact curated view of active memory by kind.",
      execute: async (input: any) => curateMemory(recordStore, input)
    }],
    ["session.create", {
      capability: "session.write",
      description: "Create a local conversation/session record.",
      execute: async (input: any) => createSession(recordStore, input)
    }],
    ["session.message", {
      capability: "session.write",
      description: "Append a message to a local session.",
      execute: async (input: any) => appendSessionMessage(recordStore, input)
    }],
    ["session.rename", {
      capability: "session.write",
      description: "Rename a local conversation/session record.",
      execute: async (input: any) => renameSession(recordStore, input)
    }],
    ["session.assign", {
      capability: "session.write",
      description: "Assign a local session to a project.",
      execute: async (input: any) => assignSessionProject(recordStore, input)
    }],
    ["session.update", {
      capability: "session.write",
      description: "Atomically rename and/or assign a local session.",
      execute: async (input: any) => updateSession(recordStore, input)
    }],
    ["session.delete", {
      capability: "session.write",
      description: "Soft-delete a local conversation/session record.",
      execute: async (input: any) => deleteSession(recordStore, input)
    }],
    ["session.list", {
      capability: "session.read",
      description: "List local sessions with message counts.",
      execute: async (input: any) => listSessions(recordStore, input)
    }],
    ["session.read", {
      capability: "session.read",
      description: "Read a local session and its messages.",
      execute: async (input: any) => readSession(recordStore, input)
    }],
    ["project.create", {
      capability: "session.write",
      description: "Create a project that groups sessions and goals.",
      execute: async (input: any) => createProject(recordStore, input)
    }],
    ["project.update", {
      capability: "session.write",
      description: "Rename, describe, or archive a project.",
      execute: async (input: any) => updateProject(recordStore, input)
    }],
    ["project.list", {
      capability: "session.read",
      description: "List projects with session and goal counts.",
      execute: async (input: any) => listProjects(recordStore, input)
    }],
    ["goal.create", {
      capability: "goal.write",
      description: "Create a tracked local goal.",
      execute: async (input: any) => createGoal(recordStore, input)
    }],
    ["goal.update", {
      capability: "goal.write",
      description: "Append a status update to a tracked goal.",
      execute: async (input: any) => updateGoal(recordStore, input)
    }],
    ["goal.list", {
      capability: "goal.read",
      description: "List tracked local goals.",
      execute: async (input: any) => listGoals(recordStore, input)
    }],
    ["improve.propose", {
      capability: "improve.write",
      description: "Record a self-improvement proposal without applying it.",
      execute: async (input: any) => proposeImprovement(recordStore, input)
    }],
    ["improve.learn", {
      capability: "improve.write",
      description: "Continuously learn from repeated runtime failures and apply narrowly allowlisted, rollback-safe tuning.",
      execute: async (input: any, context: any) => learnImprovements(recordStore, auditStore, input, {
        stateDir: resolve(stateDir),
        config,
        modelConfig,
        runModel: async (modelInput: any) => {
          const result = await context.runTool({
            id: `${context.request.id}:advisor`,
            tool: "model.chat",
            input: modelInput,
            actor: "automatic-improvement"
          });
          return result.output;
        }
      })
    }],
    ["improve.list", {
      capability: "improve.read",
      description: "List self-improvement proposals.",
      execute: async (input: any) => listImprovements(recordStore, input)
    }],
    ["improve.decide", {
      capability: "improve.write",
      description: "Approve or reject a self-improvement proposal as an auditable record.",
      execute: async (input: any) => decideImprovement(recordStore, input)
    }],
    ["improve.rollback", {
      capability: "improve.write",
      description: "Rollback an autonomously applied improvement to its captured configuration snapshot.",
      execute: async (input: any) => rollbackImprovement(recordStore, input, { stateDir: resolve(stateDir), config })
    }]
  ]) as BuiltInRegistry;
  let closed = false;
  Object.defineProperty(registry, "close", {
    enumerable: false,
    value: () => {
      if (closed) return;
      closed = true;
      recordStore.close();
    }
  });
  const discordSchemas = new Map(DISCORD_AGENT_TOOL_SCHEMAS.map((schema: any) => [schema.function.name, schema.function.parameters]));
  for (const [name, tool] of createDiscordAgentTools({ config, approvalStore, fetch: discordFetch })) {
    registry.set(name, { ...tool, inputSchema: discordSchemas.get(name) });
  }
  return registry;
}


function modelVisibleAgentToolSchemas(registry: any) {
  return Array.from(registry?.entries?.() ?? []).flatMap(([name, tool]: any) => {
    if (!tool?.inputSchema) return [];
    return [{
      type: "function",
      function: {
        name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }];
  });
}

async function runAgent(modelConfig: any, input: any = {}, { stateDir, defaultAgentId, memoryStore, auditStore, runId, registry, runTool, runLedger, policy, signal, onModelDelta, onProviderAttempt, onAgentProgress }: any = {}) {
  const messages = Array.isArray(input.messages) ? input.messages.map((message: any) => ({ ...message })) : [{ role: "user", content: cleanRequired(input.prompt, "agent.run requires prompt") }];
  const agent = await loadAgent(stateDir, cleanString(input.agentId, defaultAgentId || DEFAULT_AGENT_ID));
  const memoryOptions = normalizeMemoryOptions(input.memory);
  const policyAllows = (toolName: string, toolInput: any = {}) => evaluateTaskPolicy({
    policy,
    request: { tool: toolName, input: toolInput },
    tool: registry?.get?.(toolName)
  }).allowed;
  const canRecallMemory = policyAllows("memory.recall");
  const canRememberMemory = policyAllows("memory.remember");
  const canSuggestMemory = policyAllows("memory.suggest");
  const canCompactMemory = policyAllows("memory.compact");
  const currentSession = memoryStore && input.sessionId ? await resolveSession(memoryStore, cleanString(input.sessionId, "")) : undefined;
  const memoryScope = { sessionId: cleanString(input.sessionId, ""), projectId: cleanString(input.projectId, currentSession?.projectId ?? "") };
  const runMemoryTool = async (tool: string, toolInput: any, reason: string) => (await runTool({ tool, input: toolInput, actor: "agent-memory", reason })).output;
  const learned = memoryStore && canSuggestMemory && memoryOptions.autoLearn
    ? await learnFromConversation(memoryStore, messages, memoryScope, (toolInput: any) => runMemoryTool("memory.suggest", toolInput, "automatic memory suggestion"))
    : { suggested: [], skipped: [] };
  const compacted = memoryStore && canCompactMemory && input.sessionId && memoryOptions.autoCompact && messages.length >= memoryOptions.compactAfter
    ? await runMemoryTool("memory.compact", { sessionId: input.sessionId, messages }, "automatic session memory compaction")
    : undefined;
  const latestUserMessage = [...messages].reverse().find((message: any) => message.role === "user");
  const recallStartedAt = Date.now();
  if (memoryStore && canRecallMemory && memoryOptions.autoRecall && latestUserMessage?.content) {
    await onAgentProgress?.({ stage: "recalling-memory", message: "Recalling relevant memory." });
  }
  const recalled = memoryStore && canRecallMemory && memoryOptions.autoRecall && latestUserMessage?.content
    ? await runMemoryTool("memory.recall", { query: latestUserMessage.content, limit: memoryOptions.maxRecall, ...memoryScope }, "automatic memory recall")
    : { memories: [] };
  if (memoryStore && canRecallMemory && memoryOptions.autoRecall && latestUserMessage?.content) {
    await onAgentProgress?.({ stage: "memory-recalled", message: "Memory recall completed.", durationMs: Date.now() - recallStartedAt, count: recalled.memories.length });
  }
  const systemMessage = `${agent.systemPrompt}\n\n## Runtime safety contract\nUse web tools for current public information. Use browser tools for private accounts only after the user has logged in. Never claim an external action completed until its tool result says so. Actions that change external state require approval. Use memory.recall when durable context is relevant. Only use memory.remember for explicit user-approved facts, preferences, or decisions.`.trim();
  const existingSystem = messages.find((message: any) => message.role === "system");
  if (existingSystem) existingSystem.content = `${systemMessage}\n${existingSystem.content || ""}`.trim();
  else messages.unshift({ role: "system", content: systemMessage });
  if (recalled.memories.length) messages.splice(1, 0, { role: "system", content: formatMemoryContext(recalled.memories) });
  const maxTurns = Math.min(Math.max(Number(input.maxTurns) || 6, 1), 8);
  const availableTools = modelVisibleAgentToolSchemas(registry).filter((schema: any) => {
    return policyAllows(schema.function.name);
  });
  let aggregateUsage;
  let toolRepairUsed = false;
  let budgetRecoveryUsed = false;
  let budgetRecovery;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    throwIfAborted(signal);
    await onAgentProgress?.({ stage: "drafting-answer", message: "Drafting the answer.", turn: turn + 1 });
    const selectedModel = input.model || agent.manifest.model.default || undefined;
    const modelRequest = {
      model: selectedModel,
      messages,
      tools: availableTools,
      stream: true,
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens })
    };
    let result: any;
    try {
      result = await chatWithModel(modelConfig, modelRequest, { stateDir, signal, onDelta: onModelDelta, onProviderAttempt });
    } catch (error: any) {
      const recovery = agentBudgetRecovery(error, selectedModel, input, budgetRecoveryUsed);
      if (!recovery) throw error;
      budgetRecoveryUsed = true;
      budgetRecovery = recovery;
      await onProviderAttempt?.({
        attemptId: `budget_recovery_${randomUUID()}`,
        providerId: recovery.providerId,
        modelId: recovery.modelId,
        status: "budget-recovery",
        retryable: true,
        fromMaxTokens: recovery.fromMaxTokens,
        toMaxTokens: recovery.toMaxTokens,
        reason: "reasoning-budget-exhausted"
      });
      result = await chatWithModel(modelConfig, {
        ...modelRequest,
        maxTokens: recovery.toMaxTokens
      }, { stateDir, signal, onDelta: onModelDelta, onProviderAttempt });
    }
    aggregateUsage = mergeUsage(aggregateUsage, result.usage);
    if (!result.toolCalls?.length) {
      return {
        ...result,
        ...(aggregateUsage ? { usage: aggregateUsage } : {}),
        ...(budgetRecovery ? { modelRecovery: budgetRecovery } : {}),
        ...answerShapeMetadata(latestUserMessage?.content, result.content),
        memory: { recalled: recalled.memories.length, suggested: learned.suggested.length, learned: 0, compacted: compacted?.duplicate ? 0 : compacted ? 1 : 0 }
      };
    }
    messages.push({ role: "assistant", content: result.content || "", tool_calls: result.toolCalls });
    for (const [callIndex, call] of result.toolCalls.entries()) {
      let nested;
      try {
        const args = parseAgentToolArguments(call.arguments, registry?.get?.(call.name)?.inputSchema);
        nested = await runTool({ tool: call.name, input: args, actor: "agent", reason: "agent tool call", runLedger });
      } catch (error: any) {
        throwIfAborted(signal);
        const failure = (error instanceof Error ? error : new Error(String(error))) as NodeError;
        const argumentCorrection = failure.code === "TOOL_ARGUMENTS_MALFORMED" || failure.code === "TOOL_ARGUMENTS_SCHEMA_INVALID";
        if (argumentCorrection) await recordAgentToolRejection(auditStore, runId ?? input?.sessionId, call, failure);
        const safety = toolSafetyDescriptor(call.name, registry?.get?.(call.name));
        if ((!argumentCorrection && !safety.retrySafe) || toolRepairUsed) throw error;
        toolRepairUsed = true;
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({
            ok: false,
            error: {
              code: cleanString(error?.code, "TOOL_ERROR"),
              message: agentToolFailureMessage(error)
            }
          })
        });
        for (const cancelled of result.toolCalls.slice(callIndex + 1)) {
          messages.push({
            role: "tool",
            tool_call_id: cancelled.id,
            content: JSON.stringify({
              ok: false,
              error: {
                code: "TOOL_CALL_CANCELLED",
                message: "The tool call was not executed because an earlier retry-safe tool call requires correction."
              }
            })
          });
        }
        break;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(nested.output) });
      if (call.name === "browser.open") {
        await onAgentProgress?.({
          stage: "page-opened",
          message: "Page opened and snapshot captured.",
          tabId: cleanString(nested.output?.id, ""),
          snapshotId: cleanString(nested.output?.snapshotId, "")
        });
      }
      if (nested.output?.type === "approval.required") {
        return {
          ...result,
          ...(aggregateUsage ? { usage: aggregateUsage } : {}),
          content: `I need your approval before I ${nested.output.summary.toLowerCase()}.`,
          pendingApproval: nested.output,
          ...(budgetRecovery ? { modelRecovery: budgetRecovery } : {}),
          memory: { recalled: recalled.memories.length, suggested: learned.suggested.length, learned: 0, compacted: compacted?.duplicate ? 0 : compacted ? 1 : 0 }
        };
      }
    }
  }
  throw new Error(`agent reached its ${maxTurns}-turn tool limit`);
}

function agentToolFailureMessage(error: any) {
  if (error?.code === "TOOL_ARGUMENTS_MALFORMED") return "The tool arguments were malformed JSON. Return one valid JSON object and retry once.";
  if (error?.code === "TOOL_ARGUMENTS_SCHEMA_INVALID") return "The tool arguments did not match the declared schema. Return one valid JSON object matching the schema and retry once.";
  if (error?.code === "ENOENT") return "The requested file or resource was not found. Inspect the workspace and try a valid path.";
  if (error?.code === "EACCES" || error?.code === "EPERM") return "The requested operation was not permitted.";
  return "The tool could not complete the requested operation. Inspect the input and try a valid alternative.";
}

const MAX_AGENT_TOOL_ARGUMENT_BYTES = 1_048_576;
const FORBIDDEN_AGENT_ARGUMENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SUPPORTED_AGENT_SCHEMA_KEYS = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum",
  "minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "title", "description"
]);
const SUPPORTED_AGENT_SCHEMA_TYPES = new Set(["object", "array", "string", "boolean", "number", "integer", "null"]);

function agentToolArgumentError(code: string, message: string): NodeError {
  const error = new Error(message) as NodeError;
  error.code = code;
  return error;
}

function parseAgentToolArguments(raw: any, schema: any): any {
  const text = typeof raw === "string" && raw.trim() ? raw : "{}";
  if (Buffer.byteLength(text, "utf8") > MAX_AGENT_TOOL_ARGUMENT_BYTES) {
    throw agentToolArgumentError("TOOL_ARGUMENTS_MALFORMED", "Tool arguments exceed the maximum permitted size.");
  }
  let value;
  try {
    rejectDuplicateJsonKeys(text);
    value = JSON.parse(text);
  } catch {
    throw agentToolArgumentError("TOOL_ARGUMENTS_MALFORMED", "Tool arguments are not valid JSON.");
  }
  try {
    validateAgentToolSchema(value, schema);
  } catch {
    throw agentToolArgumentError("TOOL_ARGUMENTS_SCHEMA_INVALID", "Tool arguments do not match the declared schema.");
  }
  return value;
}

function validateAgentToolSchema(value: any, schema: any, path = "arguments"): void {
  if (!schema) return;
  validateAgentToolSchemaDefinition(schema, path);
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${path} must be an object`);
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_AGENT_ARGUMENT_KEYS.has(key)) throw new Error(`${path}.${key} is forbidden`);
      if (schema.additionalProperties === false && !Object.prototype.hasOwnProperty.call(properties, key)) throw new Error(`${path}.${key} is not allowed`);
      if (Object.prototype.hasOwnProperty.call(properties, key)) validateAgentToolSchema(value[key], properties[key], `${path}.${key}`);
    }
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) throw new Error(`${path}.${required} is required`);
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${path} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${path} has too many items`);
    if (schema.items) for (const [index, entry] of value.entries()) validateAgentToolSchema(entry, schema.items, `${path}[${index}]`);
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`${path} must be a string`);
    const length = Array.from(value).length;
    if (schema.minLength !== undefined && length < schema.minLength) throw new Error(`${path} is too short`);
    if (schema.maxLength !== undefined && length > schema.maxLength) throw new Error(`${path} is too long`);
  }
  if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${path} must be a number`);
  if (schema.type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) throw new Error(`${path} must be an integer`);
  if (schema.type === "number" || schema.type === "integer") {
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} is below the minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path} is above the maximum`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) throw new Error(`${path} is at or below the exclusive minimum`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) throw new Error(`${path} is at or above the exclusive maximum`);
  }
  if (schema.type === "null" && value !== null) throw new Error(`${path} must be null`);
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate: any) => Object.is(candidate, value))) throw new Error(`${path} is not an allowed value`);
}

function validateAgentToolSchemaDefinition(schema: any, path: string): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || Object.getPrototypeOf(schema) !== Object.prototype) throw new Error(`${path} has an invalid schema`);
  for (const key of Object.keys(schema)) if (!SUPPORTED_AGENT_SCHEMA_KEYS.has(key)) throw new Error(`${path} uses an unsupported schema keyword`);
  if (schema.type !== undefined && (typeof schema.type !== "string" || !SUPPORTED_AGENT_SCHEMA_TYPES.has(schema.type))) throw new Error(`${path} has an unsupported schema type`);
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties) || Object.getPrototypeOf(schema.properties) !== Object.prototype) throw new Error(`${path}.properties is invalid`);
    for (const [key, child] of Object.entries(schema.properties)) {
      if (FORBIDDEN_AGENT_ARGUMENT_KEYS.has(key)) throw new Error(`${path}.properties contains a forbidden key`);
      validateAgentToolSchemaDefinition(child, `${path}.${key}`);
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((key: any) => typeof key !== "string") || new Set(schema.required).size !== schema.required.length) throw new Error(`${path}.required is invalid`);
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") throw new Error(`${path}.additionalProperties is unsupported`);
  if (schema.items !== undefined) validateAgentToolSchemaDefinition(schema.items, `${path}.items`);
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw new Error(`${path}.enum is invalid`);
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
    if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) throw new Error(`${path}.${key} is invalid`);
  }
  if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) throw new Error(`${path} has inconsistent length bounds`);
  if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) throw new Error(`${path} has inconsistent item bounds`);
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) throw new Error(`${path}.${key} is invalid`);
  }
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) throw new Error(`${path} has inconsistent numeric bounds`);
  if (schema.exclusiveMinimum !== undefined && schema.exclusiveMaximum !== undefined && schema.exclusiveMinimum >= schema.exclusiveMaximum) throw new Error(`${path} has inconsistent exclusive bounds`);
}

function rejectDuplicateJsonKeys(text: string): void {
  let index = 0;
  const whitespace = () => { while (/\s/u.test(text[index] ?? "")) index += 1; };
  const string = (): string => {
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index++] === '"') return JSON.parse(text.slice(start, index));
    }
    throw new Error("unterminated string");
  };
  const value = (depth: number): void => {
    if (depth > 64) throw new Error("JSON nesting too deep");
    whitespace();
    const token = text[index];
    if (token === '"') { string(); return; }
    if (token === "{") {
      index += 1;
      const keys = new Set<string>();
      whitespace();
      if (text[index] === "}") { index += 1; return; }
      while (true) {
        whitespace();
        if (text[index] !== '"') throw new Error("object key expected");
        const key = string();
        if (keys.has(key)) throw new Error("duplicate object key");
        keys.add(key);
        whitespace();
        if (text[index++] !== ":") throw new Error("object colon expected");
        value(depth + 1);
        whitespace();
        if (text[index] === "}") { index += 1; return; }
        if (text[index++] !== ",") throw new Error("object separator expected");
      }
    }
    if (token === "[") {
      index += 1;
      whitespace();
      if (text[index] === "]") { index += 1; return; }
      while (true) {
        value(depth + 1);
        whitespace();
        if (text[index] === "]") { index += 1; return; }
        if (text[index++] !== ",") throw new Error("array separator expected");
      }
    }
    const literal = text.slice(index).match(/^(?:true|false|null)\b/u);
    if (literal) { index += literal[0].length; return; }
    const number = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (number) { index += number[0].length; return; }
    throw new Error("JSON value expected");
  };
  value(0);
  whitespace();
  if (index !== text.length) throw new Error("trailing JSON data");
}

async function recordAgentToolRejection(auditStore: any, runId: any, call: any, error: NodeError): Promise<void> {
  if (!auditStore?.append) return;
  await auditStore.append({
    at: new Date().toISOString(),
    runId: cleanString(runId, cleanString(call?.id, "agent-tool-call")),
    type: "tool.call.rejected",
    actor: "agent",
    tool: cleanString(call?.name, "unknown"),
    decision: "deny",
    message: error.message,
    data: { callId: cleanString(call?.id, "unknown"), code: error.code ?? "TOOL_ARGUMENTS_INVALID" }
  });
}

function agentBudgetRecovery(error: any, selectedModel: any, input: any, alreadyUsed: boolean) {
  if (alreadyUsed || input.reasoningBudgetRecovery === false || error?.code !== "MODEL_REASONING_BUDGET_EXHAUSTED") return undefined;
  const modelRef = cleanString(selectedModel, "");
  const separator = modelRef.indexOf(":");
  const providerId = separator > 0 ? modelRef.slice(0, separator) : "";
  if (providerId.toLowerCase() !== "ollama") return undefined;
  const fromMaxTokens = Number.parseInt(String(input.maxTokens ?? ""), 10);
  if (!Number.isFinite(fromMaxTokens) || fromMaxTokens < 1 || fromMaxTokens >= 4_096) return undefined;
  const toMaxTokens = Math.min(4_096, Math.max(900, fromMaxTokens * 4, fromMaxTokens + 512));
  return {
    performed: true,
    providerId,
    modelId: separator > 0 ? modelRef.slice(separator + 1) : modelRef,
    reason: "reasoning-budget-exhausted",
    fromMaxTokens,
    toMaxTokens
  };
}

function answerShapeMetadata(request: any, content: any) {
  const expected = requestedBulletCount(request);
  if (!expected) return {};
  const text = String(content ?? "");
  const actual = text.split(/\r?\n/u).filter((line) => /^\s{0,3}[-*+]\s+\S/u.test(line)).length;
  if (actual === expected) return {
    answerShape: {
      constraints: [{ type: "bullet-count", expected, actual, satisfied: true }],
      warnings: []
    }
  };
  return {
    answerShape: {
      constraints: [{ type: "bullet-count", expected, actual, satisfied: false }],
      warnings: [{
        code: "ANSWER_SHAPE_MISMATCH",
        message: `The answer has ${actual} bullet points; the request explicitly required ${expected}.`
      }]
    }
  };
}

function requestedBulletCount(value: any) {
  const text = String(value ?? "");
  const match = text.match(/\b(?:exactly\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:bullet|bullets|bullet\s+points?)\b/iu);
  if (!match) return undefined;
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const expected = words[match[1]!.toLowerCase()] ?? Number.parseInt(match[1]!, 10);
  return Number.isFinite(expected) && expected > 0 ? expected : undefined;
}

function stableTaskValue(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableTaskValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableTaskValue(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function taskRequestDigest(request: any): string {
  return createHash("sha256").update(stableTaskValue({ tool: request.tool, input: request.input ?? {}, actor: request.actor ?? "unknown" })).digest("hex");
}

export async function runTask({
  task,
  auditStore,
  policy = createDefaultPolicy(),
  registry = createBuiltInRegistry(),
  now = () => new Date().toISOString(),
  signal,
  runLedger,
  onModelDelta,
  onProviderAttempt,
  onAgentProgress,
  trustedApprovalId,
  trustedApprovalRunId
}: any) {
  const request = normalizeTaskRequest(task);
  const tool = registry.get(request.tool);
  const requestDigest = taskRequestDigest(request);
  let runBinding: { replay?: boolean } | undefined;

  if (!auditStore) throw new Error("runTask requires an auditStore");

  if (runLedger) {
    const modelRef = typeof request.input?.model === "string" ? request.input.model : "";
    const separator = modelRef.indexOf(":");
    runLedger.ensureRun({
      runId: request.id,
      objective: request.reason ?? `execute ${request.tool}`,
      providerId: separator > 0 ? modelRef.slice(0, separator) : "",
      modelId: separator > 0 ? modelRef.slice(separator + 1) : modelRef
    });
    runBinding = runLedger.bindRunRequest({ runId: request.id, requestDigest });
  }

  const prior = await auditStore.readRun(request.id);
  if (prior?.status === "completed") {
    const started = [...prior.events].reverse().find((event: any) => event.type === "task.started");
    const priorDigest = started?.data?.requestDigest ?? (started?.tool && started?.data && "input" in started.data
      ? taskRequestDigest({ tool: started.tool, input: started.data.input, actor: started.actor })
      : undefined);
    if (!priorDigest || priorDigest !== requestDigest) {
      const error = new Error(`run id ${request.id} was already used for a different request`) as NodeError;
      error.code = "IDEMPOTENCY_CONFLICT";
      throw error;
    }
    const completed = [...prior.events].reverse().find((event: any) => event.type === "task.completed");
    return { id: request.id, tool: request.tool, capability: tool?.capability, ok: true, replayed: true, output: completed?.data?.output };
  }
  if (runBinding?.replay) {
    const error = new Error(`run id ${request.id} is already bound to an unfinished or failed request and will not be executed again`) as NodeError;
    error.code = "IDEMPOTENCY_REUSE";
    throw error;
  }

  throwIfAborted(signal);
  const safety = toolSafetyDescriptor(request.tool, tool);
  let ledgerStep;
  if (runLedger) {
    ledgerStep = runLedger.beginTool({ runId: request.id, toolName: request.tool, input: request.input, safety, metadata: { actor: request.actor } });
  }
  const decision = evaluateTaskPolicy({ policy, request, tool });

  await auditStore.append({
    at: now(),
    runId: request.id,
    type: "task.policy",
    actor: request.actor,
    tool: request.tool,
    capability: tool?.capability,
    decision: decision.decision,
    message: decision.allowed ? "policy allowed task" : decision.reason,
    data: "details" in decision ? decision.details : undefined
  });

  runLedger?.recordPolicy({ runId: request.id, stepId: ledgerStep?.stepId, decision: decision.decision, reason: "reason" in decision ? decision.reason : "policy allowed task", details: "details" in decision ? decision.details : undefined });

  try {
    assertAllowed(decision);
  } catch (error) {
    runLedger?.finishTool({ runId: request.id, stepId: ledgerStep?.stepId, status: "blocked", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }

  let capabilityClaims;
  try {
    if (runLedger && Array.isArray(policy?.invariants) && policy.invariants.length) {
      new Sentinel({ ledger: runLedger }).evaluate({
        runId: request.id,
        stepId: ledgerStep?.stepId,
        toolName: request.tool,
        input: request.input,
        policy: { id: policy.id, version: 1, invariants: policy.invariants },
        workspaceRoot: runLedger.workspaceRoot
      });
    }
    if (runLedger?.featureFlags?.capabilities === true && safety.requiresCapability) {
      const token = request.input?.capabilityToken;
      if (typeof token !== "string" || !token) {
        const error = new Error(`capability token required for ${request.tool}`) as NodeError;
        error.code = "CAPABILITY_DENIED";
        throw error;
      }
      capabilityClaims = new CapabilityBroker({ ledger: runLedger, stateDir: runLedger.stateDir, featureFlags: runLedger.featureFlags }).consume(token, { runId: request.id, toolName: request.tool, resource: request.input?.resource ?? {} });
    }
  } catch (error) {
    const failure = (error instanceof Error ? error : new Error(String(error))) as NodeError;
    await auditStore.append({ at: now(), runId: request.id, type: "task.blocked", actor: request.actor, tool: request.tool, capability: tool?.capability, decision: "deny", message: failure.message, data: { code: failure.code ?? "POLICY_VIOLATION" } });
    runLedger?.finishTool({ runId: request.id, stepId: ledgerStep?.stepId, status: "blocked", error: failure.message });
    throw error;
  }

  await auditStore.append({
    at: now(),
    runId: request.id,
    type: "task.started",
    actor: request.actor,
    tool: request.tool,
    capability: tool.capability,
    decision: "allow",
    data: {
      inputDigest: createHash("sha256").update(JSON.stringify(request.input)).digest("hex"),
      requestDigest,
      input: safeAuditValue(request.input)
    }
  });

  try {
    throwIfAborted(signal);
    const output = await tool.execute(request.input, {
      request,
      policy,
      registry,
      auditStore,
      signal,
      onModelDelta,
      onProviderAttempt: async (attempt: any) => auditStore.append({ at: now(), runId: request.id, type: "provider.attempt", actor: request.actor, tool: request.tool, capability: tool.capability, decision: "allow", data: attempt }),
      onAgentProgress: async (progress: any) => {
        await auditStore.append({
          at: now(),
          runId: request.id,
          type: "agent.progress",
          actor: request.actor,
          tool: request.tool,
          capability: tool.capability,
          decision: "allow",
          message: cleanString(progress?.message, "Agent progress"),
          data: safeAuditValue(progress)
        });
        await onAgentProgress?.(progress);
      },
      runLedger,
      capability: capabilityClaims,
      trustedApprovalId,
      trustedApprovalRunId,
      runTool: (nestedTask: any) => runTask({
        task: { ...nestedTask, actor: nestedTask.actor ?? request.actor },
        auditStore,
        policy,
        registry,
        now,
        signal,
        runLedger: nestedTask.runLedger ?? runLedger,
        onModelDelta,
        onProviderAttempt,
        onAgentProgress
      })
    });
    throwIfAborted(signal);
    const awaitingApproval = output?.type === "approval.required";
    await auditStore.append({
      at: now(),
      runId: request.id,
      type: awaitingApproval ? "task.approval_required" : "task.completed",
      actor: request.actor,
      tool: request.tool,
      capability: tool.capability,
      decision: awaitingApproval ? "pending" : "allow",
      message: awaitingApproval ? output.summary : undefined,
      data: awaitingApproval
        ? { approvalId: output.approvalId, expiresInSeconds: output.expiresInSeconds }
        : { output: safeAuditValue(output) }
    });
    runLedger?.finishTool({ runId: request.id, stepId: ledgerStep?.stepId, output, status: awaitingApproval ? "blocked" : "succeeded" });
    return { id: request.id, tool: request.tool, capability: tool.capability, ok: true, output };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const cancelled = signal?.aborted === true || failure.name === "AbortError";
    await auditStore.append({
      at: now(),
      runId: request.id,
      type: cancelled ? "task.cancelled" : "task.failed",
      actor: request.actor,
      tool: request.tool,
      capability: tool.capability,
      decision: "allow",
      message: cancelled ? "task cancelled" : failure.message
    });
    runLedger?.finishTool({ runId: request.id, stepId: ledgerStep?.stepId, status: cancelled ? "failed" : "failed", error: cancelled ? "task cancelled" : failure.message });
    throw error;
  }
}

export async function runPlan({
  plan,
  auditStore,
  policy = createDefaultPolicy(),
  registry = createBuiltInRegistry(),
  actor = "local",
  now = () => new Date().toISOString(),
  runLedger
}: any) {
  const normalized = normalizePlan(plan, actor);
  if (!auditStore) throw new Error("runPlan requires an auditStore");

  runLedger?.ensureRun({ runId: normalized.id, objective: normalized.name });
  runLedger?.appendEvent({ runId: normalized.id, type: "plan-started", payload: { name: normalized.name, steps: normalized.steps.length } });

  await auditStore.append({
    at: now(),
    runId: normalized.id,
    type: "plan.started",
    actor: normalized.actor,
    tool: "plan",
    capability: "plan.run",
    decision: "allow",
    data: { name: normalized.name, steps: normalized.steps.length }
  });

  const steps = [];
  try {
    for (const step of normalized.steps) {
      const result = await runTask({
        task: {
          id: `${normalized.id}:${step.id}`,
          tool: step.tool,
          input: step.input,
          actor: normalized.actor,
          reason: `plan:${normalized.name}`
        },
        auditStore,
        policy,
        registry,
        now,
        runLedger
      });
      steps.push({ id: step.id, ok: true, result });
    }
    await auditStore.append({
      at: now(),
      runId: normalized.id,
      type: "plan.completed",
      actor: normalized.actor,
      tool: "plan",
      capability: "plan.run",
      decision: "allow",
      data: { name: normalized.name, steps: steps.length }
    });
    runLedger?.appendEvent({ runId: normalized.id, type: "plan-completed", payload: { name: normalized.name, steps: steps.length } });
    return { id: normalized.id, name: normalized.name, ok: true, steps };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    await auditStore.append({
      at: now(),
      runId: normalized.id,
      type: "plan.failed",
      actor: normalized.actor,
      tool: "plan",
      capability: "plan.run",
      decision: "allow",
      message: failure.message,
      data: { name: normalized.name, completedSteps: steps.length }
    });
    runLedger?.appendEvent({ runId: normalized.id, type: "plan-failed", payload: { name: normalized.name, completedSteps: steps.length, error: failure.message } });
    throw error;
  }
}

export function createAuditStore(path: any = ".odinn/audit.jsonl") {
  return new FileAuditStore(path);
}



function prefixedId(prefix: any) {
  return `${prefix}_${randomUUID()}`;
}

function cleanRequired(value: any, message: any) {
  const text = cleanString(value, "");
  if (!text) throw new Error(message);
  return text;
}

function cleanString(value: any, fallback: any) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function boundedInteger(value: any, fallback: any, minimum: any, maximum: any) {
  const number = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function normalizeTags(tags: any) {
  return Array.isArray(tags)
    ? tags.map((tag: any) => String(tag).trim()).filter(Boolean)
    : [];
}

function normalizeEvidence(evidence: any) {
  if (Array.isArray(evidence)) return evidence.map((entry: any) => String(entry).trim()).filter(Boolean);
  const text = cleanString(evidence, "");
  return text ? [text] : [];
}

function normalizeConfidence(value: any) {
  const confidence = Number(value ?? 1);
  if (!Number.isFinite(confidence)) return 1;
  return Math.max(0, Math.min(1, confidence));
}

function normalizeLimit(value: any, fallback: any) {
  const limit = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(limit) && limit > 0 ? limit : fallback;
}

function throwIfAborted(signal: any) {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : new Error("task aborted");
  error.name = "AbortError";
  throw error;
}

function safeAuditValue(value: any, depth: any = 0): any {
  if (depth > 4) return "[truncated]";
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value === "string" && value.length > 12_000 ? `${value.slice(0, 12_000)}…[truncated]` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((entry: any) => safeAuditValue(entry, depth + 1));
  if (typeof value !== "object") return undefined;
  const output: AnyRecord = {};
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    if (/api[-_]?key|access[-_]?token|refresh[-_]?token|capability(?:[-_]?token)?|secret|password|authorization|cookie|credential/i.test(key)) {
      output[key] = "[redacted]";
    } else {
      output[key] = safeAuditValue(entry, depth + 1);
    }
  }
  return output;
}

function normalizePlan(input: any, actor: any) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("plan must be an object");
  if (!Array.isArray(input.steps) || input.steps.length === 0) throw new Error("plan requires at least one step");
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : createRunId();
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : id;
  const seen = new Set();
  const steps = input.steps.map((step: any, index: any) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`plan step ${index + 1} must be an object`);
    const stepId = typeof step.id === "string" && step.id.trim() ? step.id.trim() : `step-${index + 1}`;
    if (seen.has(stepId)) throw new Error(`duplicate plan step id: ${stepId}`);
    seen.add(stepId);
    if (typeof step.tool !== "string" || step.tool.trim() === "") throw new Error(`plan step ${stepId} requires tool`);
    return {
      id: stepId,
      tool: step.tool.trim(),
      input: step.input && typeof step.input === "object" && !Array.isArray(step.input) ? step.input : {}
    };
  });
  return {
    id,
    name,
    actor: typeof input.actor === "string" && input.actor.trim() ? input.actor.trim() : actor,
    steps
  };
}
