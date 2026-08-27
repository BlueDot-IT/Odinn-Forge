import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, open, readFile, readdir, realpath, rename, rm, stat as statPath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { cwd as currentWorkingDirectory } from "node:process";
import { fileURLToPath } from "node:url";
import { OPERATOR_SCHEDULE_SCHEMA_VERSION, OPERATOR_SNAPSHOT_CHANGED_CODE, createDiagnosticsReadUseCase, createOperatorSnapshotReadUseCase, createSessionListUseCase, createStatusReadUseCase, projectOperatorScheduleEnvelopeV1, validateGatewayChannelDiagnosticsV1, validateOperatorIdentifierV1, validatePendingApprovalSummariesV1, validateRuntimeSecuritySummaryV1, type DiagnosticsReportV1, type GatewayStatusSnapshotV1, type OperatorSurfaceV1 } from "@odinn/application";
import { AGENT_GRAPH_TOOL, AGENT_SDK_VERSION, AgentRegistryStore, CORE_ADVANCED_FEATURES, DEFAULT_SANDBOX_CONFIG, assertHostedSandboxConfig, CheckpointCoordinator, createApprovalStore, createAuditStore, createDifferentiatedRuntime, createGovernedMcpRuntime, diagnoseGitHubReadIntegration, diagnoseMicrosoftGraphReadIntegration, DurableEventIngress, DurableWorkflowRuntime, ensureMainAgent, ensureStateCompatibility, ExtensionExecutor, ExtensionRegistry, inspectOperatorRecovery, isAllowedCredentialEnvironmentKey, isLiveOnlyAutomationTool, isPhysicalPathInside, JobSupervisor, listConfiguredModels, MAX_BOUNDED_UTF8_BYTES, normalizeExperimentalFlags, normalizeGitHubReadConfig, normalizeMicrosoftGraphReadConfig, normalizeMcpConfiguration, normalizeModelConfig, normalizeSandboxConfig, normalizeSelfImprovementConfig, oauthTokenPath, operatorActionNames, previewExecutionAdmission, projectDurableToolInput, ProjectContextService, probeChromiumEngine, probeOciBackend, providerSupport, PROVIDER_PRESETS, provisionRuntimeAgent, ProofVerifier, ProgressiveSkillDisclosure, readApprovalSummaries, readUtf8Prefix, reconcileProcessRecovery, reconcileSandboxRecovery, resolveConfiguredOciBackend, runTask as executeTask, SkillLifecycleService, SkillPackageStore, SqliteOperatorReadStore, SqliteRecordStore, SqliteJobStore, SqliteWorkflowStore, summarizeSandboxRisk, toolSafetyDescriptor, validateAgentManifest, validatePolicy, validateSkillPackage, withStateMutationLock } from "@odinn/kernel";
import { CAPABILITY_REGISTRY, CAPABILITY_REGISTRY_VERSION, assertCapabilityIds, createDefaultPolicy, evaluateTaskPolicy } from "@odinn/policy";
import { createRuntimeIsolatedTaskExecutor, createRuntimeRegistry } from "@odinn/runtime";
import { ensureSecureStateDirectory, isOwnerOnlyPath } from "@odinn/store-file";
import {
  ChannelPluginRegistry,
  ChannelRouter,
  FileChannelDedupeStore,
  FileSessionBindingStore,
  GatewayChannelHandler,
  createAllowlistPolicy,
  projectChannelExecutionAudit,
  type ChannelExecutionStateEvent
} from "@odinn/channels";
import { authenticationMode, isMutatingMethod, permitsGatewayTokenBootstrap, validHostHeader, validMutationOrigin } from "./security.ts";
import { runGatewayEntrypoint } from "./bootstrap.ts";
import { CONSOLE_CSP, readConsoleAsset, renderConsoleHtml } from "./public/console.ts";
import { gatewayTestHooksFor } from "./testing.ts";
import { dispatchGovernedWorkflowStep, submitDurableEventJob, waitForDurableJobTerminal } from "./durable-dispatch.ts";
import { gatewayOperatorSnapshotFailure } from "./http/errors.ts";
import { createGatewayOperatorSnapshotReadRequest, normalizeHostedUserId } from "./http/request-context.ts";
import { assertTenantClaims, createGatewayTenantScope, createTenantScopedAuditStore, scopedJobPayload, type GatewayTenantScope } from "./http/tenant-scope.ts";
import { AuthenticatedRouter } from "./http/router.ts";
import { registerApplicationReadRoutes } from "./routes/application-reads.ts";

export { gatewayOperatorSnapshotFailure } from "./http/errors.ts";
export {
  createGatewayDiagnosticsReadRequest,
  createGatewayOperatorSnapshotReadRequest,
  createGatewaySessionListRequest,
  createGatewayStatusReadRequest,
} from "./http/request-context.ts";

declare const __ODINN_COMPILED__: boolean | undefined;
const DEFAULT_REQUEST_MAX_BYTES = 65_536;
const compiledRuntime = typeof __ODINN_COMPILED__ !== "undefined";
const SKILL_DISCOVERY_MAX_BYTES = MAX_BOUNDED_UTF8_BYTES;
const PUBLIC_DIR = fileURLToPath(new URL(compiledRuntime ? "./public/" : "../public/", import.meta.url));
const PACKAGE_FILE = fileURLToPath(new URL(compiledRuntime ? "../../package.json" : "../../../package.json", import.meta.url));
const INSTALL_METADATA_FILE = fileURLToPath(new URL(compiledRuntime ? "../../install-metadata.json" : "../../../install-metadata.json", import.meta.url));

async function productVersion() {
  try {
    const pkg = JSON.parse(await readFile(PACKAGE_FILE, "utf8"));
    return String(pkg.version || "development");
  } catch {
    return String(process.env.ODINN_VERSION || "development");
  }
}

async function productCommit() {
  try {
    const metadata = JSON.parse(await readFile(INSTALL_METADATA_FILE, "utf8"));
    return String(metadata.commit || process.env.ODINN_COMMIT || "unknown");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    return String(process.env.ODINN_COMMIT || "unknown");
  }
}

const GATEWAY_OPERATOR_SURFACES = new Set<OperatorSurfaceV1>(["cli", "tui", "http", "console"]);

function gatewayOperatorSurface(input: string): OperatorSurfaceV1 {
  return GATEWAY_OPERATOR_SURFACES.has(input as OperatorSurfaceV1) ? input as OperatorSurfaceV1 : "http";
}

function createQuotaGate(value: any = {}) {
  const maximumActiveJobs = Math.max(1, Number(value.maximumActiveJobs ?? 8));
  const maximumBrowserActionsPerHour = Math.max(1, Number(value.maximumBrowserActionsPerHour ?? 200));
  const maximumModelCallsPerHour = Math.max(1, Number(value.maximumModelCallsPerHour ?? 120));
  const maximumModelTokensPerDay = Math.max(1_000, Number(value.maximumModelTokensPerDay ?? 2_000_000));
  const browserActions: number[] = [];
  const modelCalls: number[] = [];
  const tokenUsage: Array<{ at: number; tokens: number }> = [];
  const prune = (entries: number[], horizon: number) => {
    const cutoff = Date.now() - horizon;
    while (entries[0] !== undefined && entries[0] < cutoff) entries.shift();
  };
  return {
    maximumActiveJobs,
    checkTool(tool: string) {
      if (String(tool).startsWith("browser.") && !["browser.tabs", "browser.snapshot", "browser.recovery.status"].includes(tool)) {
        prune(browserActions, 60 * 60 * 1000);
        if (browserActions.length >= maximumBrowserActionsPerHour) throw new GatewayError(429, "tenant browser-action quota exceeded");
        browserActions.push(Date.now());
      }
      if (["model.chat", "agent.run"].includes(tool)) {
        prune(modelCalls, 60 * 60 * 1000);
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        while (tokenUsage[0] && tokenUsage[0].at < cutoff) tokenUsage.shift();
        if (modelCalls.length >= maximumModelCallsPerHour) throw new GatewayError(429, "tenant model-call quota exceeded");
        if (tokenUsage.reduce((sum, item) => sum + item.tokens, 0) >= maximumModelTokensPerDay) throw new GatewayError(429, "tenant model-token quota exceeded");
        modelCalls.push(Date.now());
      }
    },
    recordUsage(tool: string, usage: any) {
      if (!["model.chat", "agent.run"].includes(tool)) return;
      const tokens = Number(usage?.totalTokens ?? usage?.total_tokens ?? 0);
      if (Number.isFinite(tokens) && tokens > 0) tokenUsage.push({ at: Date.now(), tokens });
    }
  };
}

class GatewayError extends Error {
  status: number;
  constructor(status: any, message: any) {
    super(message);
    this.status = status;
  }
}

class MissingChannelCredentialError extends Error {}

const CRON_SCHEMA_VERSION = OPERATOR_SCHEDULE_SCHEMA_VERSION;
const CRON_MAX_JOBS = 500;
const CRON_MAX_FILE_BYTES = 4 * 1024 * 1024;
const CRON_DISPATCH_LEASE_MS = 10 * 60 * 1000;

export class CronStore {
  path: string;
  writeChain: Promise<unknown> = Promise.resolve();
  constructor(path: string) { this.path = path; }
  async readRaw() {
    try {
      if ((await statPath(this.path)).size > CRON_MAX_FILE_BYTES) throw new GatewayError(409, `cron state exceeds the ${CRON_MAX_FILE_BYTES}-byte limit`);
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error: any) {
      if (error?.code === "ENOENT") return { schemaVersion: CRON_SCHEMA_VERSION, jobs: [] };
      throw error;
    }
  }
  async readSource() {
    const value = await this.readRaw();
    if ((value?.schemaVersion !== 1 && value?.schemaVersion !== CRON_SCHEMA_VERSION) || !Array.isArray(value.jobs)) {
      return { schemaVersion: CRON_SCHEMA_VERSION, jobs: [] };
    }
    if (value.jobs.length > CRON_MAX_JOBS) throw new GatewayError(409, `cron state exceeds the ${CRON_MAX_JOBS}-job limit`);
    return { schemaVersion: CRON_SCHEMA_VERSION, jobs: value.jobs };
  }
  async read() {
    const value = await this.readSource();
    return value.jobs.length
      ? { schemaVersion: CRON_SCHEMA_VERSION, jobs: value.jobs.map((job: any) => normalizeCronJob(job)) }
      : value;
  }
  async readOperatorSchedules() {
    return projectOperatorScheduleEnvelopeV1(await this.readRaw());
  }
  async list({ limit = CRON_MAX_JOBS, offset = 0 }: { limit?: number; offset?: number } = {}) {
    const jobs = (await this.read()).jobs.sort((left: any, right: any) => String(left.name).localeCompare(String(right.name)) || String(left.id).localeCompare(String(right.id)));
    const boundedLimit = Math.min(CRON_MAX_JOBS, Math.max(0, Number.isSafeInteger(Number(limit)) ? Number(limit) : CRON_MAX_JOBS));
    const boundedOffset = Math.max(0, Number.isSafeInteger(Number(offset)) ? Number(offset) : 0);
    return jobs.slice(boundedOffset, boundedOffset + boundedLimit);
  }
  async mutate(operation: (jobs: any[]) => any) {
    const pending = this.writeChain.then(() => withStateMutationLock(dirname(this.path), async () => {
      const state = await this.read();
      const result = await operation(state.jobs);
      state.schemaVersion = CRON_SCHEMA_VERSION;
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
      return result;
    }));
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }
  async create(input: any) {
    return this.mutate((jobs) => {
      const job = normalizeCronJob({ ...input, id: input.id || `cron_${randomBytes(8).toString("hex")}`, createdAt: new Date().toISOString() });
      assertDurableScheduleTool(job.tool);
      if (jobs.length >= CRON_MAX_JOBS) throw new GatewayError(409, `cron state is at its ${CRON_MAX_JOBS}-job limit`);
      if (jobs.some((item) => item.id === job.id)) throw new GatewayError(409, "cron job id already exists");
      jobs.push(job);
      return job;
    });
  }
  async update(id: string, patch: any) {
    if (patch?.tool !== undefined) assertDurableScheduleTool(String(patch.tool).trim());
    return this.mutate((jobs) => {
      const index = jobs.findIndex((item) => item.id === id);
      if (index < 0) throw new GatewayError(404, "cron job not found");
      const current = normalizeCronJob(jobs[index]);
      const scheduleChanged = patch.schedule !== undefined || patch.timezone !== undefined;
      if (scheduleChanged && current.dispatchLease) throw new GatewayError(409, "cannot change an active cron schedule until its occurrence lease settles");
      const updated = normalizeCronJob({
        ...current,
        ...patch,
        ...(scheduleChanged ? { nextRunAt: undefined, scheduledFor: undefined, dispatchLease: undefined } : {}),
        id,
        updatedAt: new Date().toISOString()
      });
      assertDurableScheduleTool(updated.tool);
      jobs[index] = updated;
      return updated;
    });
  }
  async quarantineLiveOnly(id: string) {
    return this.mutate((jobs) => {
      const index = jobs.findIndex((item) => item.id === id);
      if (index < 0) throw new GatewayError(404, "cron job not found");
      const current = normalizeCronJob(jobs[index]);
      if (!isLiveOnlyAutomationTool(current.tool)) return current;
      if (current.enabled === false
        && current.liveOnlyQuarantine?.code === "LIVE_ONLY_AUTOMATION_INPUT_REMOVED"
        && current.liveOnlyQuarantine?.originalTool === current.tool) return current;
      const updated = normalizeCronJob({
        ...current,
        enabled: false,
        input: {
          quarantinedTool: current.tool,
          liveInputAvailable: false,
          ...(projectDurableToolInput(current.tool, current.input) as Record<string, unknown>)
        },
        dispatchLease: undefined,
        scheduledFor: undefined,
        lastStatus: "error",
        lastError: `live-only tool ${current.tool} requires fresh input and cannot be persisted in cron`,
        liveOnlyQuarantine: {
          schemaVersion: 1,
          code: "LIVE_ONLY_AUTOMATION_INPUT_REMOVED",
          originalTool: current.tool,
          migratedAt: new Date().toISOString()
        },
        updatedAt: new Date().toISOString()
      });
      jobs[index] = updated;
      return updated;
    });
  }
  async remove(id: string) {
    return this.mutate((jobs) => {
      const index = jobs.findIndex((item) => item.id === id);
      if (index < 0) throw new GatewayError(404, "cron job not found");
      jobs.splice(index, 1);
    });
  }
  async nextWake() {
    const enabled = (await this.list()).filter((job: any) => job.enabled);
    const values = enabled.map((job: any) => job.nextRunAt || nextCronWake(job.schedule, job.timezone)).filter(Boolean).sort();
    return values[0] ?? null;
  }

  async claimDueOccurrence(id: string, now = new Date(), ownerId = `gateway:${process.pid}:${randomUUID()}`) {
    return this.mutate((jobs) => {
      const index = jobs.findIndex((item: any) => item.id === id);
      if (index < 0) throw new GatewayError(404, "cron job not found");
      const current = normalizeCronJob(jobs[index]);
      const existingLease = current.dispatchLease && typeof current.dispatchLease === "object" ? current.dispatchLease : undefined;
      const leaseExpiresAt = existingLease ? Date.parse(String(existingLease.expiresAt || "")) : Number.NaN;
      const leaseIsActive = existingLease && Number.isFinite(leaseExpiresAt) && leaseExpiresAt > now.getTime();
      if (current.enabled && leaseIsActive) {
        jobs[index] = current;
        return { claimed: false, alreadyDispatched: true, job: current };
      }
      const due = Boolean(existingLease && !leaseIsActive) || Boolean(current.nextRunAt && Date.parse(current.nextRunAt) <= now.getTime());
      if (!current.enabled || !due) {
        jobs[index] = current;
        return { claimed: false, alreadyDispatched: false, job: current };
      }
      const scheduledFor = String(existingLease?.scheduledFor || current.nextRunAt);
      const occurrenceKey = String(existingLease?.occurrenceKey || `cron:${current.id}:${scheduledFor}`);
      const lease = {
        occurrenceKey,
        scheduledFor,
        ownerId,
        token: randomUUID(),
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + CRON_DISPATCH_LEASE_MS).toISOString()
      };
      const nextRunAt = existingLease ? current.nextRunAt : nextCronWake(current.schedule, current.timezone, new Date(Date.parse(scheduledFor)));
      const updated = normalizeCronJob({
        ...current,
        scheduledFor,
        nextRunAt,
        dispatchLease: lease,
        updatedAt: now.toISOString()
      });
      jobs[index] = updated;
      return { claimed: true, recovered: Boolean(existingLease), occurrenceKey, scheduledFor, nextRunAt, lease, job: updated };
    });
  }

  async acknowledgeSubmitted(id: string, occurrenceKey: string, token: string) {
    return this.mutate((jobs) => {
      const index = jobs.findIndex((item: any) => item.id === id);
      if (index < 0) throw new GatewayError(404, "cron job not found");
      const current = normalizeCronJob(jobs[index]);
      const lease = current.dispatchLease && typeof current.dispatchLease === "object" ? current.dispatchLease : undefined;
      if (!lease || lease.occurrenceKey !== occurrenceKey || lease.token !== token) return current;
      const updated = normalizeCronJob({ ...current, dispatchLease: undefined, updatedAt: new Date().toISOString() });
      jobs[index] = updated;
      return updated;
    });
  }

  async recordOutcome(id: string, scheduledFor: string, patch: Record<string, unknown>) {
    return this.mutate((jobs) => {
      const index = jobs.findIndex((item: any) => item.id === id);
      if (index < 0) throw new GatewayError(404, "cron job not found");
      const current = normalizeCronJob(jobs[index]);
      const previous = Date.parse(String(current.lastRunAt || ""));
      const candidate = Date.parse(scheduledFor);
      if (!Number.isFinite(candidate) || (Number.isFinite(previous) && candidate < previous)) return current;
      const updated = normalizeCronJob({ ...current, ...patch, lastRunAt: scheduledFor, updatedAt: new Date().toISOString() });
      jobs[index] = updated;
      return updated;
    });
  }
}

export class AgentPackageStore {
  path: string;
  readonly registry: AgentRegistryStore;
  constructor(path: string) {
    this.path = path;
    this.registry = new AgentRegistryStore(path);
  }
  async read() { return this.registry.read(); }
  async list() { return this.registry.list(); }
  async mutate(operation: (agents: any[]) => any) {
    return this.registry.mutate((agents) => operation(agents));
  }
  async install(input: any) {
    if (String(input?.id || "").trim() === "main") throw new GatewayError(409, "the primary main agent cannot be replaced by an SDK package");
    const manifest = validateAgentPackage(input);
    return this.registry.mutate(async (agents) => {
      const current = agents.find((agent) => agent.id === manifest.id);
      const record = { ...manifest, status: "disabled", installedAt: new Date().toISOString(), previousVersion: current?.version };
      if (manifest.kind === "runtime") {
        await provisionRuntimeAgent(dirname(this.path), manifest, {
          assumeLocked: true,
          previousRecord: current,
          nextRecord: record
        });
      }
      const index = agents.findIndex((agent) => agent.id === manifest.id);
      if (index >= 0) agents[index] = record; else agents.push(record);
      return record;
    });
  }
  async transition(id: string, action: string) {
    return this.mutate((agents) => {
      const agent = agents.find((item) => item.id === id);
      if (!agent) throw new GatewayError(404, "agent package not found");
      if (agent.kind === "runtime" && agent.primary) throw new GatewayError(409, "the primary runtime agent cannot be disabled or quarantined");
      if (!['enable', 'disable', 'quarantine'].includes(action)) throw new GatewayError(400, "unsupported agent lifecycle action");
      agent.status = action === 'enable' ? 'enabled' : action === 'disable' ? 'disabled' : 'quarantined';
      agent.updatedAt = new Date().toISOString();
      return agent;
    });
  }
}

function validateAgentPackage(input: any) {
  try {
    return { ...validateAgentManifest(input), tests: Array.isArray(input.tests) ? input.tests : [], validation: { valid: true, checkedAt: new Date().toISOString() } };
  } catch (error) {
    throw new GatewayError(400, error instanceof Error ? error.message : "agent manifest is invalid");
  }
}

async function discoverSkills(root: string, state: string) {
  const results: any[] = [];
  const sources = [
    { directory: root, status: "unmanaged", source: "workspace" },
    { directory: join(state, "skill-workshop"), status: "draft", source: "legacy-draft" },
    { directory: join(state, "imports"), status: "unmanaged", source: "import" }
  ];
  const stateRoot = resolve(state);
  const walk = async (directory: string, depth: number, descriptor: any) => {
    if (depth > 9 || results.length >= 250) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if ([".git", "node_modules", "dist", "coverage"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (descriptor.source === "workspace" && resolve(path) === stateRoot) continue;
      if (entry.isDirectory()) await walk(path, depth + 1, descriptor);
      else if (entry.isFile() && entry.name === "SKILL.md") {
        try {
          const bounded = await readUtf8Prefix(path, SKILL_DISCOVERY_MAX_BYTES, "SKILL.md");
          if (bounded.truncated) continue;
          const frontmatter = /^---\s*\n([\s\S]*?)\n---/u.exec(bounded.content)?.[1] || "";
          const name = /^name:\s*["']?([^\n"']+)/mu.exec(frontmatter)?.[1]?.trim() || path.split(sep).at(-2) || "skill";
          const description = /^description:\s*["']?([^\n"']+)/mu.exec(frontmatter)?.[1]?.trim() || "No description";
          results.push({ id: createHash("sha256").update(path).digest("hex").slice(0, 16), name, description, path, bytes: bounded.bytesRead, status: descriptor.status, source: descriptor.source });
        } catch {
          continue;
        }
      }
    }
  };
  for (const descriptor of sources) await walk(descriptor.directory, 0, descriptor);
  return results;
}

function validateSkillDraft(input: any) {
  const name = String(input.name || "").trim();
  const description = String(input.description || "").trim();
  const instructions = String(input.instructions || "").trim();
  const errors = [];
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/u.test(name)) errors.push("name must be 2-64 lowercase letters, digits, or hyphens");
  if (description.length < 12) errors.push("description must explain when the skill applies");
  if (instructions.length < 40) errors.push("instructions must contain an actionable workflow");
  const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\n${instructions}\n`;
  return { valid: errors.length === 0, errors, content, digest: createHash("sha256").update(content).digest("hex") };
}

function auditEventOutcome(event: any) {
  if (["task.failed", "plan.failed"].includes(event.type)) return "failed";
  if (event.type === "task.blocked" || event.decision === "deny") return "denied";
  if (event.type === "task.approval_required") return "approval";
  if (["task.completed", "plan.completed"].includes(event.type)) return "completed";
  if (["task.started", "plan.started"].includes(event.type)) return "running";
  return "recorded";
}

function auditEventTokens(event: any) {
  if (event.type !== "task.completed") return 0;
  const usage = event.data?.output?.usage;
  const total = Number(usage?.totalTokens ?? usage?.total_tokens ?? usage?.total ?? 0);
  if (Number.isFinite(total) && total > 0) return total;
  const input = Number(usage?.inputTokens ?? usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
  const output = Number(usage?.outputTokens ?? usage?.output_tokens ?? usage?.completion_tokens ?? 0);
  return Number.isFinite(input + output) ? input + output : 0;
}

function summarizeAuditEvents(events: any[]) {
  const runIds = new Set(events.map((event) => event.runId).filter(Boolean));
  const modelRuns = new Set(events
    .filter((event) => event.type === "task.completed" && ["model.chat", "agent.run"].includes(event.tool))
    .map((event) => event.runId));
  const errorEvents = events.filter((event) => ["failed", "denied"].includes(auditEventOutcome(event)));
  return {
    events: events.length,
    runs: runIds.size,
    modelRuns: modelRuns.size,
    errors: errorEvents.length,
    totalTokens: events.reduce((sum, event) => sum + auditEventTokens(event), 0),
    firstAt: events[0]?.at ?? null,
    lastAt: events.at(-1)?.at ?? null
  };
}

function auditFacet(events: any[], key: string) {
  const counts = new Map<string, number>();
  for (const event of events) {
    const value = key === "outcome" ? auditEventOutcome(event) : String(event[key] || "").trim();
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts, ([value, count]) => ({ value, count })).sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function queryAuditEvents(events: any[], url: URL) {
  const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const type = String(url.searchParams.get("type") || "").trim();
  const tool = String(url.searchParams.get("tool") || "").trim();
  const actor = String(url.searchParams.get("actor") || "").trim();
  const outcome = String(url.searchParams.get("outcome") || "").trim();
  const from = Date.parse(url.searchParams.get("from") || "");
  const to = Date.parse(url.searchParams.get("to") || "");
  const filtered = events.filter((event) => {
    const at = Date.parse(event.at || "");
    return (!query || JSON.stringify(event).toLowerCase().includes(query))
      && (!type || event.type === type)
      && (!tool || event.tool === tool)
      && (!actor || event.actor === actor)
      && (!outcome || auditEventOutcome(event) === outcome)
      && (!Number.isFinite(from) || at >= from)
      && (!Number.isFinite(to) || at <= to + 86_399_999);
  });
  const pageSize = Math.max(10, Math.min(100, Number.parseInt(url.searchParams.get("pageSize") || "25", 10) || 25));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.max(1, Math.min(pages, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
  const sorted = filtered.slice().sort((left, right) => String(right.at).localeCompare(String(left.at)));
  const offset = (page - 1) * pageSize;
  return {
    events: sorted.slice(offset, offset + pageSize),
    pagination: { page, pageSize, pages, total: filtered.length, from: filtered.length ? offset + 1 : 0, to: Math.min(offset + pageSize, filtered.length) },
    summary: summarizeAuditEvents(events),
    filteredSummary: summarizeAuditEvents(filtered),
    facets: {
      types: auditFacet(events, "type"),
      tools: auditFacet(events, "tool"),
      actors: auditFacet(events, "actor"),
      outcomes: auditFacet(events, "outcome")
    }
  };
}

function classifyTask(run: any) {
  const systemReadTools = new Set([
    "session.list", "session.read", "memory.search", "memory.browse", "memory.curate", "memory.candidates",
    "goal.list", "project.list", "job.healthcheck", "browser.tabs", "browser.snapshot", "improve.list"
  ]);
  if (run.actor === "gateway" && systemReadTools.has(run.tool)) return "system";
  if (/^(?:autonomous|automatic|automation)/u.test(String(run.actor || "")) || run.actor === "cron") return "automation";
  if (run.actor === "agent" || run.tool === "agent.run" || run.tool === "model.chat") return "agent";
  return "user";
}

function taskTitle(tool: string) {
  const labels: Record<string, string> = {
    "agent.run": "Agent response", "model.chat": "Model response", "web.search": "Web search", "web.fetch": "Read webpage",
    "session.create": "Create session", "session.message": "Save message", "memory.remember": "Store memory", "memory.compact": "Compact session memory", "memory.forget": "Forget memory"
  };
  return labels[tool] || String(tool || "Task").split(".").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" · ");
}

function taskStatusMatches(value: string, filter: string) {
  if (!filter || filter === "all") return true;
  if (filter === "active") return ["queued", "running", "cancelling", "awaiting_approval"].includes(value);
  if (filter === "review") return ["failed", "denied", "blocked", "cancelled", "needs-review"].includes(value);
  return value === filter;
}

function summarizeTasks(runs: any[], events: any[], jobs: any[], registry: any, includeSystem: boolean) {
  const eventsByRun = new Map<string, any[]>();
  for (const event of events) {
    const current = eventsByRun.get(event.runId) ?? [];
    current.push(event);
    eventsByRun.set(event.runId, current);
  }
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const runIds = new Set(runs.map((run) => run.id));
  const allRuns = runs.slice();
  for (const job of jobs) {
    if (runIds.has(job.id)) continue;
    const task = job.payload?.task && typeof job.payload.task === "object" ? job.payload.task : {};
    allRuns.push({
      id: job.id,
      tool: task.tool || "job",
      status: job.status,
      actor: task.actor || "job",
      startedAt: job.startedAt || job.createdAt,
      lastEventAt: job.updatedAt || job.completedAt || job.createdAt,
      eventCount: 0,
      message: job.error || ""
    });
  }
  return allRuns.map((run) => {
    const runEvents = eventsByRun.get(run.id) ?? [];
    const started = runEvents.find((event) => ["task.started", "plan.started"].includes(event.type));
    const finished = [...runEvents].reverse().find((event) => ["task.completed", "task.failed", "task.blocked", "plan.completed", "plan.failed"].includes(event.type));
    const startedAt = run.startedAt || started?.at;
    const updatedAt = run.lastEventAt || finished?.at || startedAt;
    const durationMs = startedAt && updatedAt ? Math.max(0, Date.parse(updatedAt) - Date.parse(startedAt)) : null;
    const category = classifyTask(run);
    const safety = toolSafetyDescriptor(run.tool, registry.get(run.tool));
    const proofEvents = runEvents.filter((event) => /^(?:proof\.|verification\.|snapshot\.|artifact\.)/u.test(event.type));
    const job: any = jobsById.get(run.id);
    return {
      id: run.id,
      title: taskTitle(run.tool),
      tool: run.tool,
      status: run.status,
      actor: run.actor || "local",
      category,
      startedAt: startedAt ?? null,
      updatedAt: updatedAt ?? null,
      durationMs,
      eventCount: run.eventCount ?? runEvents.length,
      evidenceCount: proofEvents.length,
      message: run.message || finished?.message || "",
      replayable: safety.retrySafe === true && Boolean(started?.data?.input),
      replayReason: safety.retrySafe !== true
        ? "Tool is not declared retry-safe"
        : started?.data?.input ? "Recorded input is retry-safe" : "No audited task input is available",
      cancellable: Boolean(job && ["queued", "running", "cancelling"].includes(job.status)),
      source: job ? "job" : category,
      events: runEvents
    };
  }).filter((task) => includeSystem || task.category !== "system");
}

function normalizeCronJob(value: any) {
  const schedule = String(value.schedule || "").trim();
  const parsed = cronParts(schedule);
  if (!parsed) throw new GatewayError(400, "cron schedule must contain five valid fields within standard ranges");
  const tool = String(value.tool || "agent.run").trim();
  if (!tool) throw new GatewayError(400, "cron job requires a tool");
  const timezone = validateCronTimezone(String(value.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"));
  const nextRunAt = value.nextRunAt === null
    ? null
    : typeof value.nextRunAt === "string" && Number.isFinite(Date.parse(value.nextRunAt))
      ? value.nextRunAt
      : nextCronWake(schedule, timezone);
  return {
    ...value,
    schemaVersion: CRON_SCHEMA_VERSION,
    id: String(value.id),
    name: String(value.name || value.id).trim().slice(0, 120),
    schedule,
    timezone,
    enabled: value.enabled !== false,
    tool,
    input: value.input && typeof value.input === "object" ? value.input : {},
    nextRunAt,
    scheduledFor: typeof value.scheduledFor === "string" ? value.scheduledFor : undefined,
    dispatchLease: value.dispatchLease && typeof value.dispatchLease === "object" && !Array.isArray(value.dispatchLease) ? value.dispatchLease : undefined,
    updatedAt: value.updatedAt || new Date().toISOString()
  };
}

function assertDurableScheduleTool(tool: string): void {
  if (isLiveOnlyAutomationTool(tool)) {
    throw new GatewayError(400, `live-only tool ${tool} cannot be persisted in cron`);
  }
}

function cronMutationInput(value: any, creating: boolean) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError(400, "cron request must be a JSON object");
  const allowed = new Set(creating ? ["id", "name", "schedule", "timezone", "enabled", "tool", "input"] : ["name", "schedule", "timezone", "enabled", "tool", "input"]);
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length) throw new GatewayError(400, `cron request contains unsupported fields: ${unsupported.join(", ")}`);
  if (creating && (typeof value.timezone !== "string" || !value.timezone.trim())) throw new GatewayError(400, "cron timezone is required");
  return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key)));
}

function cronParts(schedule: string) {
  const parts = schedule.split(/\s+/u);
  if (parts.length !== 5) return null;
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const;
  const fields = parts.map((part, index) => parseCronField(part, ranges[index][0], ranges[index][1]));
  if (fields.some((field) => field === null)) return null;
  const dayValues = fields[2]!;
  const monthValues = fields[3]!;
  if (![...monthValues].some((month) => [...dayValues].some((day) => day <= new Date(Date.UTC(2024, month, 0)).getUTCDate()))) return null;
  return fields as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
}

function parseCronField(field: string, minimum: number, maximum: number): Set<number> | null {
  const values = new Set<number>();
  for (const token of field.split(",")) {
    const match = /^(?:(\d+)(?:-(\d+))?|\*)(?:\/(\d+))?$/u.exec(token);
    if (!match) return null;
    const start = match[1] === undefined ? minimum : Number(match[1]);
    const end = match[2] === undefined ? (match[1] === undefined ? maximum : start) : Number(match[2]);
    const step = match[3] === undefined ? 1 : Number(match[3]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(step) || step < 1 || start < minimum || end > maximum || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size ? values : null;
}

function validateCronTimezone(timezone: string): string {
  if (!timezone.trim()) throw new GatewayError(400, "cron timezone is required");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new GatewayError(400, "cron timezone must be a valid IANA timezone");
  }
  return timezone;
}

function cronDateParts(date: Date, timezone = "UTC") {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: timezone, minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short", hourCycle: "h23" }).formatToParts(date).map((part) => [part.type, part.value]));
  return { minute: Number(values.minute), hour: Number(values.hour), day: Number(values.day), month: Number(values.month), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday) };
}

function cronMatches(schedule: string, date: Date, timezone = "UTC") {
  const parts = cronParts(schedule);
  const local = cronDateParts(date, timezone);
  return Boolean(parts && parts[0].has(local.minute) && parts[1].has(local.hour) && parts[2].has(local.day) && parts[3].has(local.month) && parts[4].has(local.weekday));
}

export function nextCronWake(schedule: string, timezone = "UTC", after = new Date()) {
  const parts = cronParts(schedule);
  if (!parts) return null;
  const candidate = new Date();
  candidate.setTime(after.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  const deadline = candidate.getTime() + 366 * 24 * 60 * 60 * 1000;
  for (let index = 0; candidate.getTime() <= deadline && index < 366 * 24 * 60; index += 1) {
    if (cronMatches(schedule, candidate, timezone)) return candidate.toISOString();
    const local = cronDateParts(candidate, timezone);
    if (!parts[3].has(local.month) || !parts[2].has(local.day) || !parts[4].has(local.weekday) || !parts[1].has(local.hour)) {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + (60 - local.minute));
    } else {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
    }
  }
  return null;
}

async function runCronJob(store: CronStore, id: string, executor: any, tenantScope?: GatewayTenantScope) {
  const job = (await store.list()).find((item: any) => item.id === id);
  if (!job) throw new GatewayError(404, "cron job not found");
  assertDurableScheduleTool(job.tool);
  const startedAt = new Date().toISOString();
  try {
    const task = { id: `${job.id}:${Date.now()}`, tool: job.tool, input: job.input, actor: "cron", reason: `cron:${job.id}` };
    const result = await executor(tenantScope ? scopedJobPayload({ task }, tenantScope) : { task });
    await store.update(id, { lastRunAt: startedAt, lastStatus: "ok", lastError: "", lastMinuteKey: startedAt.slice(0, 16) });
    return result;
  } catch (error) {
    await store.update(id, { lastRunAt: startedAt, lastStatus: "error", lastError: error instanceof Error ? error.message : String(error), lastMinuteKey: startedAt.slice(0, 16) });
    throw error;
  }
}

async function settleCronOccurrence(store: CronStore, supervisor: JobSupervisor, claim: any, jobId: string): Promise<void> {
  const deadline = Date.now() + CRON_DISPATCH_LEASE_MS;
  while (Date.now() < deadline) {
    const job = await supervisor.get(claim.occurrenceKey);
    if (job && ["completed", "failed", "cancelled", "needs-review"].includes(job.status)) {
      const ok = job.status === "completed";
      await store.recordOutcome(jobId, claim.scheduledFor, {
        lastStatus: ok ? "ok" : "error",
        lastError: ok ? "" : String(job.error || `scheduled job ended with status ${job.status}`),
        lastMinuteKey: claim.scheduledFor.slice(0, 16)
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function dispatchCronOccurrence(store: CronStore, supervisor: JobSupervisor, claim: any, job: any, retrySafe = false, tenantScope?: GatewayTenantScope): Promise<void> {
  const payload = { task: {
    id: claim.occurrenceKey,
    tool: job.tool,
    input: job.input,
    actor: "cron",
    reason: claim.occurrenceKey,
    occurrenceKey: claim.occurrenceKey,
    scheduledFor: claim.scheduledFor
  } };
  await supervisor.submit(
    tenantScope ? scopedJobPayload(payload, tenantScope) : payload,
    {
      id: claim.occurrenceKey,
      occurrenceKey: claim.occurrenceKey,
      scheduledFor: claim.scheduledFor,
      nextRunAt: claim.nextRunAt,
      retrySafe,
      idempotent: true
    }
  );
  await store.acknowledgeSubmitted(job.id, claim.occurrenceKey, claim.lease.token);
  await settleCronOccurrence(store, supervisor, claim, job.id);
}

export async function runDueCronJobs(store: CronStore, supervisor: JobSupervisor, now = new Date(), retrySafeFor: (tool: string) => boolean = () => false, tenantScope?: GatewayTenantScope) {
  const dispatches: Promise<void>[] = [];
  for (const job of await store.list()) {
    if (isLiveOnlyAutomationTool(job.tool)) {
      await store.quarantineLiveOnly(job.id);
      continue;
    }
    if (!job.enabled) continue;
    const claim = await store.claimDueOccurrence(job.id, now);
    if (!claim.claimed) continue;
    dispatches.push(dispatchCronOccurrence(store, supervisor, claim, job, retrySafeFor(job.tool), tenantScope));
  }
  await Promise.allSettled(dispatches);
}

export async function createGatewayServer(options: any = {}) {
  const {
    stateDir = resolve(homedir(), ".odinn"),
    workspaceRoot = currentWorkingDirectory(),
    requestMaxBytes = DEFAULT_REQUEST_MAX_BYTES,
    quotas = {},
    hosted = false,
    hostedUserId,
    hostedTenantId,
    channelPluginLoader = loadChannelPlugin
  } = options;
  const testHooks = gatewayTestHooksFor(options);
  const trustedHostedUserId = hosted ? normalizeHostedUserId(hostedUserId) : undefined;
  const trustedHostedTenantId = hosted ? normalizeHostedUserId(hostedTenantId ?? hostedUserId) : undefined;
  const tenantScope = createGatewayTenantScope({ hosted, userId: trustedHostedUserId, tenantId: trustedHostedTenantId });
  const requestedState = resolve(stateDir);
  const root = resolve(workspaceRoot);
  const version = await productVersion();
  await ensureSecureStateDirectory(requestedState);
  await ensureStateCompatibility(requestedState, { applicationVersion: version, applicationCommit: await productCommit() });
  // macOS exposes standard temporary paths through system-owned aliases such
  // as /var -> /private/var. Keep the public path for the security checks
  // above, then hand stores the physical root so later containment checks do
  // not mistake that platform layout for an escaped managed package.
  const state = await realpath(requestedState);
  const config = await readConfig(state, { hosted });
  const startupSandboxConfig = normalizeSandboxConfig(config);
  let processRecoveryStartupError = false;
  let sandboxRecoveryStartupError = false;
  if (await access(join(state, "sandbox-recovery.json")).then(() => true).catch(() => false)) {
    await reconcileSandboxRecovery(state, startupSandboxConfig.backend.enginePaths).catch(() => { sandboxRecoveryStartupError = true; });
  }
  if (await access(join(state, "process-recovery.json")).then(() => true).catch(() => false)) {
    await reconcileProcessRecovery(state).catch(() => { processRecoveryStartupError = true; });
  }
  await ensureMainAgent(state);
  const agentRegistryState = await new AgentRegistryStore(join(state, "agents.json")).read();
  // The registry is the runtime fallback, but do not mutate the persisted
  // config-shaped object: doing so would make a read-only `/config` request
  // report a spurious restart requirement when the default only exists in the
  // registry.
  const runtimeConfig = !config.defaultAgentId && typeof agentRegistryState.defaultAgentId === "string"
    ? { ...config, defaultAgentId: agentRegistryState.defaultAgentId }
    : config;
  const featureFlags = normalizeExperimentalFlags(config.experimental);
  const proofOptions = {
    allowedCommands: config.proof?.allowedCommands ?? [],
    includeRawEvidence: config.proof?.includeRawEvidence === true
  };
  const runtime = createDifferentiatedRuntime({ stateDir: state, workspaceRoot: root, featureFlags, proofOptions });
  new CheckpointCoordinator({ runLedger: runtime.ledger }).recover();
  const rawAuditStore = createAuditStore(join(state, config.auditLog ?? "audit.jsonl"));
  const auditStore = createTenantScopedAuditStore(rawAuditStore, tenantScope);
  if (typeof auditStore.verifyIntegrity === "function") await auditStore.verifyIntegrity({ allowUnsigned: true }).catch(() => undefined);
  const policy = createDefaultPolicy(config.policy);
  const approvalStore = createApprovalStore({ path: join(state, "approvals.json") });
  const skillStore = new SkillPackageStore(state);
  const skillDisclosure = new ProgressiveSkillDisclosure(skillStore);
  const skillLifecycle = new SkillLifecycleService({
    store: skillStore,
    auditStore,
    approvalStore,
    policy,
    enabled: config.runtime?.enableSkillLifecycle === true
  });
  const extensionRegistry = new ExtensionRegistry(join(state, "extensions.json"));
  const extensionExecutor = new ExtensionExecutor(extensionRegistry, { workspaceRoot: root, config: config.sandbox });
  const mcpRuntime = config.runtime?.enableMcp === true
    ? createGovernedMcpRuntime({ enabled: true, config: config.mcp, extensionRegistry, extensionExecutor, auditStore, runLedger: runtime.ledger })
    : undefined;
  const writeSelfImprovementConfig = (nextConfig: any, expectedFingerprint: string) => writeEditableConfig(state, { config: nextConfig, fingerprint: expectedFingerprint }, { hosted });
  const registry = createRuntimeRegistry({ workspaceRoot: root, stateDir: state, config: runtimeConfig, approvalStore, auditStore, skillDisclosure, mcpRuntime, writeConfig: writeSelfImprovementConfig });
  const governedRegistry = createRuntimeRegistry({ workspaceRoot: root, stateDir: state, config: { ...runtimeConfig, runLedger: runtime.ledger }, approvalStore, auditStore, skillDisclosure, mcpRuntime, writeConfig: writeSelfImprovementConfig });
  const gatewayToken = await loadGatewayToken(state);
  const rawIsolatedTaskExecutor = createRuntimeIsolatedTaskExecutor({ stateDir: state, workspaceRoot: root, config, policy });
  const isolatedTaskExecutor: any = (request: any, options?: { signal?: AbortSignal; job?: any }) => rawIsolatedTaskExecutor(scopeTaskRequest(request, tenantScope), options);
  isolatedTaskExecutor.shutdown = rawIsolatedTaskExecutor.shutdown?.bind(rawIsolatedTaskExecutor);
  const proofVerifier = new ProofVerifier({ runLedger: runtime.ledger, allowedRoot: root, ...proofOptions });
  const channelResultRecords = new SqliteRecordStore(join(state, "db", "records.sqlite"));
  const jobStore = new SqliteJobStore(runtime.ledger, { legacyPath: join(state, "jobs.json") });
  await recoverPersistedChannelResults(jobStore, channelResultRecords, tenantScope);
  const supervisor = new JobSupervisor({
    store: jobStore,
    execute: isolatedTaskExecutor,
    persistResult: async (job, result) => {
      const protectedResult = Boolean(durableChannelResultBinding(job, tenantScope));
      if (protectedResult) {
        await testHooks?.beforeChannelResultPersist?.({ jobId: job.id });
      }
      await persistDurableChannelResult(channelResultRecords, job, result, tenantScope);
      return protectedResult ? { settlement: "protected" as const } : undefined;
    },
    onCancel: (job) => {
      const task = job.payload?.task;
      const taskTool = task && typeof task === "object" && !Array.isArray(task)
        ? (task as Record<string, unknown>).tool
        : undefined;
      if (taskTool === AGENT_GRAPH_TOOL) {
        runtime.ledger.cancelAgentGraphRunsForParent({ parentRunId: job.id });
      }
    }
  });
  const runIsolatedTask = (request: any, options?: { signal?: AbortSignal }): Promise<any> => isolatedTaskExecutor(request, options) as Promise<any>;
  const runGovernedTask = (request: any): Promise<any> => executeTask({ ...request, task: scopeTask(request.task, tenantScope), auditStore, policy, registry: governedRegistry, runLedger: runtime.ledger });
  const workflowRuntime = config.runtime?.enableDurableWorkflows === true
    ? new DurableWorkflowRuntime({
      store: new SqliteWorkflowStore(runtime.ledger.database),
      concurrency: 1,
      dispatch: (context) => dispatchGovernedWorkflowStep(context, runGovernedTask),
      onEvent: async (event) => {
        await auditStore.append({ at: new Date().toISOString(), runId: event.runId, type: event.type, actor: "workflow-runtime", tool: "workflow", capability: "workflow.execute", decision: "allow", data: event.data });
      }
    })
    : undefined;
  const contextRecords = config.runtime?.enableProjectContext === true ? new SqliteRecordStore(join(state, "db", "records.sqlite")) : undefined;
  const projectContext = contextRecords ? new ProjectContextService({ records: contextRecords }) : undefined;
  const operatorAuditPath = join(state, config.auditLog ?? "audit.jsonl");
  const operatorAuditDatabasePath = join(dirname(operatorAuditPath), "db", `${basename(operatorAuditPath, ".jsonl")}.sqlite`);
  const operatorReadStore = new SqliteOperatorReadStore({
    runtimeDatabasePath: join(state, "db", "odinn.sqlite"),
    auditDatabasePath: operatorAuditDatabasePath,
  });
  const quotaGate = createQuotaGate(quotas);
  const cronStore = new CronStore(join(state, "cron-jobs.json"));
  const agentStore = new AgentPackageStore(join(state, "agents.json"));
  const channelSupervisor = await createChannelSupervisor({
    config,
    state,
    gatewayToken,
    requestMaxBytes,
    auditStore,
    loadPlugin: channelPluginLoader
  });
  const runControlTask = (task: any) => executeTask({ task: scopeTask(task, tenantScope), auditStore, policy, registry, runLedger: runtime.ledger });
  await supervisor.start();
  // Tokenless event-delivery recovery may submit projected jobs immediately
  // from the DurableEventIngress constructor. Complete job-store recovery
  // first so those fresh volatile payloads cannot be mistaken for abandoned
  // pre-restart input by SqliteJobStore.recover().
  const eventIngress = config.runtime?.enableEventIngress === true
    ? new DurableEventIngress({
      database: runtime.ledger.database,
      dispatch: async (candidate, { signal, renewLease }) => {
        const { job, request } = await submitDurableEventJob(supervisor, candidate, tenantScope);
        return waitForDurableJobTerminal({ initialJob: job, getJob: (id) => supervisor.get(id), signal, renewLease, expectedRequest: request });
      }
    })
    : undefined;
  await workflowRuntime?.start();
  runtime.ledger.reconcileAgentGraphRuns();
  for (const recovery of runtime.ledger.listAgentGraphRecoveryEvents()) {
    const auditRun = await auditStore.readRun(recovery.parentRunId);
    const hasAuditRecovery = auditRun?.events?.some((event: any) =>
      ["agent.graph.completed", "agent.graph.failed", "agent.graph.cancelled", "agent.graph.needs-review"].includes(String(event.type))
      && String(event.data?.graphRunId) === recovery.graphRunId
      && String(event.data?.status) === recovery.status
    );
    const auditType = recovery.status === "needs-review" ? "agent.graph.needs-review" : recovery.status === "failed" ? "agent.graph.failed" : "agent.graph.cancelled";
    if (!hasAuditRecovery) {
      await auditStore.append({
        at: new Date().toISOString(),
        runId: recovery.parentRunId,
        type: auditType,
        actor: "system",
        tool: AGENT_GRAPH_TOOL,
        capability: AGENT_GRAPH_TOOL,
        decision: recovery.status === "needs-review" ? "pending" : "deny",
        message: "agent graph recovery state requires operator review",
        data: { graphRunId: recovery.graphRunId, status: recovery.status, errorCode: recovery.errorCode, recovered: true }
      });
    }
    const ledgerRun = runtime.ledger.getRun(recovery.parentRunId);
    const ledgerType = recovery.status === "needs-review" ? "agent-graph-needs-review" : recovery.status === "failed" ? "agent-graph-failed" : "agent-graph-cancelled";
    const hasLedgerRecovery = ledgerRun?.events?.some((event: any) =>
      ["agent-graph-completed", "agent-graph-failed", "agent-graph-cancelled", "agent-graph-needs-review"].includes(String(event.type))
      && String(event.payload?.graphRunId) === recovery.graphRunId
      && String(event.payload?.status) === recovery.status
    );
    if (!hasLedgerRecovery) runtime.ledger.appendEvent({ runId: recovery.parentRunId, type: ledgerType, payload: { graphRunId: recovery.graphRunId, status: recovery.status, errorCode: recovery.errorCode, recovered: true } });
  }
  const cronTimer = setInterval(() => runDueCronJobs(
    cronStore,
    supervisor,
    new Date(),
    (tool) => toolSafetyDescriptor(tool, registry.get(tool)).retrySafe === true,
    tenantScope
  ).catch(() => undefined), 30_000);
  cronTimer.unref();
  const eventHeartbeatTimer = eventIngress
    ? setInterval(() => eventIngress.heartbeat().catch(() => undefined), 30_000)
    : undefined;
  eventHeartbeatTimer?.unref?.();
  const selfImprovement = normalizeSelfImprovementConfig(config.selfImprovement);
  let improvementCycle: Promise<any> | undefined;
  const runImprovementCycle = () => {
    if (improvementCycle) return improvementCycle;
    improvementCycle = runControlTask({
      tool: "improve.learn",
      input: { limit: 1000 },
      actor: "autonomous-improvement"
    }).catch(async () => {
      await auditStore.append({
        runId: `improvement-cycle:${Date.now()}`,
        type: "improvement.cycle_failed",
        actor: "autonomous-improvement",
        tool: "improve.learn",
        decision: "needs-review",
        message: "automatic improvement recovery or observation failed; inspect the operator surface before retrying"
      }).catch(() => undefined);
      return undefined;
    }).finally(() => { improvementCycle = undefined; });
    return improvementCycle;
  };
  const automaticImprovement = selfImprovement.enabled && selfImprovement.mode === "auto";
  const improvementStartupTimer = automaticImprovement ? setTimeout(runImprovementCycle, 2_000) : undefined;
  improvementStartupTimer?.unref?.();
  const improvementTimer = automaticImprovement
    ? setInterval(runImprovementCycle, selfImprovement.intervalMs)
    : undefined;
  improvementTimer?.unref?.();
  const statusSecurity = validateRuntimeSecuritySummaryV1(policy.security);
  const statusRead = createStatusReadUseCase({
    readStatus: async (): Promise<GatewayStatusSnapshotV1> => ({
      ok: true,
      version,
      state,
      workspaceRoot: root,
      tools: Array.from(registry.keys()),
      toolDetails: Array.from(registry.entries()).map(([name, tool]: any) => ({
        name,
        capability: tool.capability,
        capabilities: tool.capabilities,
        description: tool.description
      })),
      capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
      capabilityRegistry: CAPABILITY_REGISTRY,
      capabilityMigration: policy.capabilityMigration,
      allowedCapabilities: policy.allowedCapabilities,
      allowedTools: Array.from(registry.entries()).filter(([name, tool]: any) => evaluateTaskPolicy({ policy, request: { tool: name, input: {} }, tool }).allowed).map(([name]) => name),
      defaultModel: normalizeModelConfig(config).defaultModel,
      models: listConfiguredModels(normalizeModelConfig(config)),
      providers: await summarizeProviders(config, state),
      coreAdvanced: CORE_ADVANCED_FEATURES,
      pluginModules: [...runtime.plugins.values()].map(({ id, displayName, configKey, enabled }: any) => ({ id, displayName, configKey, enabled })),
      experimental: featureFlags,
      runtimeSurfaces: {
        durableWorkflows: { enabled: Boolean(workflowRuntime) },
        eventIngress: { enabled: Boolean(eventIngress) },
        projectContext: { enabled: Boolean(projectContext) }
      },
      security: statusSecurity,
      selfImprovement: {
        ...selfImprovement,
        automatic: automaticImprovement,
        advisor: normalizeModelConfig(config).defaultModel
          ? { source: "configured-provider", model: normalizeModelConfig(config).defaultModel }
          : { source: "waiting-for-provider", model: "" }
      },
      pendingApprovals: validatePendingApprovalSummariesV1(approvalStore.list())
    })
  });
  const diagnosticsRead = createDiagnosticsReadUseCase({
    readDiagnostics: async () => diagnostics({ state, workspaceRoot: root, config, featureFlags, auditStore, approvalStore, supervisor, channelSupervisor, processRecoveryStartupError, sandboxRecoveryStartupError })
  });
  const sessionList = createSessionListUseCase(createGatewaySessionListPort({
    execute: runIsolatedTask,
    auditStore,
    policy,
    registry
  }));

  const approvalSettlementError = (error: unknown): unknown => {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (code !== "APPROVAL_STORE_CONTENDED"
      && code !== "APPROVAL_CONTINUATION_DENIED"
      && message !== "claimed approval continuation is missing or does not match the exact request") return error;
    return Object.assign(
      new Error("claimed approval continuation is missing or does not match the exact request"),
      { code: "APPROVAL_CONTINUATION_DENIED" }
    );
  };

  const listGatewayApprovals = () => typeof approvalStore.listAsync === "function"
    ? approvalStore.listAsync()
    : Promise.resolve(approvalStore.list());
  const claimGatewayApproval = (id: string) => typeof approvalStore.claimAsync === "function"
    ? approvalStore.claimAsync(id)
    : Promise.resolve(approvalStore.claim(id));
  const recoverGatewayApproval = (id: string) => typeof approvalStore.recoverAsync === "function"
    ? approvalStore.recoverAsync(id)
    : Promise.resolve(approvalStore.recover(id));
  const revokeGatewayApproval = (id: string) => typeof approvalStore.revokeAsync === "function"
    ? approvalStore.revokeAsync(id)
    : Promise.resolve(approvalStore.revoke(id));

  const recoverGatewayApprovalContinuation = async (id: string, pending: any, linkedTask: Record<string, unknown> | undefined) => {
    const recovered = await recoverGatewayApproval(id);
    const runId = String(pending?.runId ?? "");
    const tool = String(pending?.tool ?? "");
    const recoveredRunId = String(recovered?.runId ?? "");
    const recoveredTool = String(recovered?.tool ?? "");
    const recoveredActor = typeof recovered?.actor === "string" && recovered.actor.trim() ? recovered.actor.trim() : "";
    const linkedActor = typeof linkedTask?.actor === "string" && linkedTask.actor.trim() ? linkedTask.actor.trim() : "";
    const input = recovered?.input;
    const invalid = !runId
      || !tool
      || recoveredRunId !== runId
      || recoveredTool !== tool
      || !input
      || typeof input !== "object"
      || Array.isArray(input)
      || (recoveredActor && linkedActor && recoveredActor !== linkedActor);
    if (invalid) {
      await revokeGatewayApproval(id);
      throw new GatewayError(409, "approved execution input or authority could not be recovered; refusing dispatch");
    }
    return {
      runId,
      tool,
      input: input as Record<string, unknown>,
      actor: recoveredActor || linkedActor || "local"
    };
  };

  const activeGatewayApprovalExecutions = new Set<string>();
  const approveGatewayApproval = async (id: string) => {
    if (activeGatewayApprovalExecutions.has(id)) {
      throw new GatewayError(409, "approval execution is already in flight");
    }
    activeGatewayApprovalExecutions.add(id);
    let claimedLinkedJob: any;
    try {
      const preview = (await listGatewayApprovals()).find((approval: any) => approval.id === id);
      const linkedJob = preview?.runId ? await supervisor.get(String(preview.runId)) : undefined;
      if (linkedJob && linkedJob.status !== "awaiting-approval") {
        if (linkedJob.status !== "running") await revokeGatewayApproval(id);
        throw new GatewayError(409, "the originating job is no longer awaiting approval");
      }
      if (linkedJob) {
        let result: unknown;
        try {
          result = await supervisor.runApproval(linkedJob.id, async ({ signal, job, markDispatched }) => {
            claimedLinkedJob = job;
            await testHooks?.afterApprovalJobClaimed?.({ approvalId: id, jobId: job.id });
            let pending: any;
            try {
              pending = await claimGatewayApproval(id);
            } catch (error) {
              throw approvalSettlementError(error);
            }
            if (!pending) throw new GatewayError(404, "approval not found or expired");
            if (pending.type === "skill-lifecycle") {
              markDispatched();
              await testHooks?.afterApprovalDispatchStarted?.({ approvalId: id, jobId: job.id, signal });
              if (signal.aborted) throw signal.reason ?? new Error("approval continuation aborted before skill activation");
              return skillLifecycle.applyApproved(id, pending);
            }
            const linkedTask = job.payload?.task && typeof job.payload.task === "object" && !Array.isArray(job.payload.task)
              ? job.payload.task as Record<string, unknown>
              : undefined;
            const continuation = await recoverGatewayApprovalContinuation(id, pending, linkedTask);
            markDispatched();
            await testHooks?.afterApprovalDispatchStarted?.({ approvalId: id, jobId: job.id, signal });
            if (signal.aborted) throw signal.reason ?? new Error("approval continuation aborted before executor dispatch");
            return isolatedTaskExecutor({
              approvalId: id,
              approvalRunId: continuation.runId,
              durableExecution: continuation.tool === "process.exec" || continuation.tool === "mcp.invoke",
              task: {
                id: continuation.runId,
                tool: continuation.tool,
                input: continuation.input,
                actor: continuation.actor,
                reason: "explicit user approval"
              }
            }, { signal, job });
          });
        } catch (error) {
          if (!claimedLinkedJob) {
            const current = await supervisor.get(linkedJob.id);
            if (current?.status !== "running") await revokeGatewayApproval(id);
            throw new GatewayError(409, "the originating job approval was already claimed or cancelled");
          }
          throw error;
        }
        return { approvalId: id, result };
      }
      const pending = await claimGatewayApproval(id);
      if (!pending) throw new GatewayError(404, "approval not found or expired");
      if (pending.type === "skill-lifecycle") {
        return { approvalId: id, result: await skillLifecycle.applyApproved(id, pending) };
      }
      const continuation = await recoverGatewayApprovalContinuation(id, pending, undefined);
      const result = await isolatedTaskExecutor({
        approvalId: id,
        approvalRunId: continuation.runId,
        durableExecution: continuation.tool === "process.exec" || continuation.tool === "mcp.invoke",
        task: {
          id: continuation.runId,
          tool: continuation.tool,
          input: continuation.input,
          actor: continuation.actor,
          reason: "explicit user approval"
        }
      });
      return { approvalId: id, result };
    } catch (error) {
      if (claimedLinkedJob) {
        const settlementError = approvalSettlementError(error);
        if ((settlementError as { code?: unknown } | undefined)?.code === "APPROVAL_CONTINUATION_DENIED") {
          await auditStore.append({
            at: new Date().toISOString(),
            runId: claimedLinkedJob.id,
            type: "operator.approval_continuation_denied",
            actor: "operator",
            tool: String(claimedLinkedJob.payload?.task?.tool || "approval"),
            decision: "deny",
            message: "claimed approval continuation is missing or does not match the exact request",
            data: { code: "APPROVAL_CONTINUATION_DENIED", dispatchStarted: false }
          }).catch(() => undefined);
        }
      }
      throw error;
    } finally {
      activeGatewayApprovalExecutions.delete(id);
    }
  };

  const denyGatewayApproval = async (id: string) => {
    const pending = (await listGatewayApprovals()).find((approval: any) => approval.id === id);
    if (!pending) throw new GatewayError(404, "approval not found or expired");
    const linkedJob = pending.runId ? await supervisor.get(String(pending.runId)) : undefined;
    const auditContext = {
      runId: String(pending.runId || `approval:${id}`),
      actor: "operator",
      tool: String(pending.tool || "approval"),
      data: { approvalId: id, ...(pending.runId ? { linkedRunId: pending.runId } : {}) }
    };
    try {
      await auditStore.append({
        ...auditContext,
        type: "operator.approval_denial_requested",
        decision: "deny-requested",
        message: "operator requested denial of a pending approval"
      });
    } catch {
      throw new GatewayError(503, "approval denial could not be recorded; no approval state was changed");
    }
    if (linkedJob && linkedJob.status !== "awaiting-approval") {
      if (!await revokeGatewayApproval(id)) throw new GatewayError(404, "approval not found or expired");
      await auditStore.append({
        ...auditContext,
        type: "operator.approval_denial_stale",
        decision: "stale",
        message: "approval was revoked after its originating job left the awaiting-approval state"
      }).catch(() => undefined);
      throw new GatewayError(409, "the originating job is no longer awaiting approval");
    }
    if (!await revokeGatewayApproval(id)) throw new GatewayError(404, "approval not found or expired");
    try {
      if (linkedJob) await supervisor.cancel(linkedJob.id);
    } catch (error) {
      await auditStore.append({
        ...auditContext,
        type: "operator.approval_denial_failed",
        decision: "deny-failed",
        message: `approval was revoked but linked job cancellation failed: ${error instanceof Error ? error.message : String(error)}`
      }).catch(() => undefined);
      throw new GatewayError(503, "approval was revoked but the originating job needs operator recovery");
    }
    try {
      await auditStore.append({
        ...auditContext,
        type: "operator.approval_denied",
        decision: "deny",
        message: "operator denied a pending approval"
      });
    } catch {
      await auditStore.append({
        ...auditContext,
        type: "operator.approval_denial_failed",
        decision: "deny-failed",
        message: "approval was revoked and the linked job was cancelled, but the final denial record could not be appended"
      }).catch(() => undefined);
      throw new GatewayError(503, "approval was denied but the final audit record needs operator verification");
    }
    return { approvalId: id, denied: true, ...(pending.runId ? { runId: pending.runId } : {}) };
  };

  const operatorSnapshotRead = createOperatorSnapshotReadUseCase({
    readEnvironment: async () => ({
      identity: { state, workspaceRoot: root, version, commit: await productCommit() },
      runtime: {
        gateway: "running",
        mcp: Boolean(mcpRuntime),
        workflows: Boolean(workflowRuntime),
        eventIngress: Boolean(eventIngress),
        projectContext: Boolean(projectContext)
      }
    }),
    queryJobs: async (query) => operatorReadStore.queryJobs(query),
    queryRuns: async (query) => operatorReadStore.queryRuns(query),
    readLatestAttempts: async (runIds) => runtime.ledger.readLatestExecutionAttempts(runIds),
    readApprovals: async () => readApprovalSummaries(join(state, "approvals.json")),
    queryWorkflows: async (query) => operatorReadStore.queryWorkflows(query),
    queryEventWatches: async (query) => operatorReadStore.queryEventWatches(query),
    readSchedules: async () => cronStore.readOperatorSchedules(),
    readRecovery: async () => inspectOperatorRecovery(state, {
      sandboxQuarantined: sandboxRecoveryStartupError,
      processQuarantined: processRecoveryStartupError,
    }),
    readAudit: async () => {
      const integrity = auditStore.getIntegrityStatus();
      return {
        summary: await auditStore.readSummary(),
        integrity: {
          valid: integrity.valid,
          checked: integrity.checked,
          unsigned: integrity.unsigned,
          failureCount: integrity.failures.length,
        },
      };
    }
  });

  const applicationReadRouter = registerApplicationReadRoutes(new AuthenticatedRouter(), {
    statusRead,
    diagnosticsRead,
    sessionList,
    operatorSnapshotRead,
  });

  const durableJobReplayIdentity = (payload: any) => {
    const task = payload?.task;
    const principalNamespace = task?.input?.principalNamespace;
    return {
      tool: typeof task?.tool === "string" ? task.tool : "",
      principalNamespaceDigest: typeof principalNamespace === "string"
        ? createHash("sha256").update(principalNamespace, "utf8").digest("hex")
        : null,
      delegationDigest: hashRequest(payload?.delegation ?? null),
      scopeDigest: hashRequest(payload?.scope ?? null),
      parentCapabilitiesDigest: hashRequest(payload?.parentCapabilities ?? [])
    };
  };

  const durableJobReplayIdentityMatches = ({
    existing,
    requestHash,
    scopedPayload
  }: {
    existing: any;
    requestHash: string;
    scopedPayload: any;
  }) => {
    if (typeof existing?.requestHash !== "string" || existing.requestHash !== requestHash) return false;
    return stableJson(existing.payload?.replayIdentity ?? null) === stableJson(scopedPayload.replayIdentity ?? null);
  };

  const ensureGraphControlAuditIntent = async ({
    action,
    graphRunId,
    parentRunId,
    operationId,
    type,
    tool,
    data,
    controlDigest
  }: {
    action: "cancel" | "reassign" | "checkpoint";
    graphRunId: string;
    parentRunId: string;
    operationId: string;
    type: string;
    tool: string;
    data: Record<string, unknown>;
    controlDigest?: string;
  }) => {
    const auditRun = await auditStore.readRun(parentRunId);
    const existing = auditRun?.events?.find((event: any) => event.type === type
      && event.data?.graphRunId === graphRunId
      && event.data?.operationId === operationId);
    if (existing) {
      if (controlDigest) {
        const exactData = { ...data, graphRunId, operationId, controlDigest };
        const exactMatch = existing.actor === tenantScope.principalId
          && Object.entries(exactData).every(([key, value]) => stableJson(existing.data?.[key]) === stableJson(value));
        if (!exactMatch) {
          throw new GatewayError(409, "agent graph control intent conflicts with the signed immutable request");
        }
      }
      return false;
    }
    await testHooks?.beforeAgentGraphControlAudit?.({ action, graphRunId, operationId });
    await auditStore.append({
      at: new Date().toISOString(),
      runId: parentRunId,
      type,
      actor: tenantScope.principalId,
      tool,
      capability: action === "checkpoint" ? tool : "agent.delegate",
      decision: "allow",
      data: { ...data, graphRunId, operationId, ...(controlDigest ? { controlDigest } : {}) }
    });
    return true;
  };

  const ensureGraphControlLedgerIntent = ({ parentRunId, type, operationId, payload }: {
    parentRunId: string;
    type: string;
    operationId: string;
    payload: Record<string, unknown>;
  }) => {
    const run = runtime.ledger.getRun(parentRunId);
    if (run?.events.some((event: any) => event.type === type && event.payload?.operationId === operationId)) return false;
    runtime.ledger.appendEvent({ runId: parentRunId, type, payload: { ...payload, operationId } });
    return true;
  };

  const ensureGraphControlAuditOutcome = async ({
    runId,
    graphRunId,
    operationId,
    type,
    tool,
    data
  }: {
    runId: string;
    graphRunId: string;
    operationId: string;
    type: string;
    tool: string;
    data: Record<string, unknown>;
  }) => {
    const auditRun = await auditStore.readRun(runId);
    const exists = auditRun?.events?.some((event: any) => event.type === type
      && event.data?.graphRunId === graphRunId
      && event.data?.operationId === operationId);
    if (exists) return false;
    await auditStore.append({
      at: new Date().toISOString(),
      runId,
      type,
      actor: tenantScope.principalId,
      tool,
      capability: type === "agent.graph.checkpoint" ? tool : "agent.delegate",
      decision: "allow",
      data: { ...data, graphRunId, operationId }
    });
    return true;
  };

  type PreparedDurableJobSubmission = {
    id?: string;
    requestHash: string;
    scopedPayload: any;
    effectiveTimeout?: number;
    retrySafe: boolean;
    existingSubmission?: { status: number; payload: any };
  };

  type AgentGraphReassignmentCreationControl = {
    agentGraphReassignment: {
      graphRunId: string;
      replacementJobId: string;
      replacementRequestHash: string;
      replacementIdentityDigest: string;
      trustedPrincipalId: string;
    };
  };

  const prepareDurableJobSubmission = async (
    body: any,
    idempotencyKey?: string,
    delegation?: { reassignedFromGraphRunId: string; reassignedFromRequestDigest: string }
  ): Promise<PreparedDurableJobSubmission> => {
    const task = body.task && typeof body.task === "object" && !Array.isArray(body.task) ? body.task : body;
    if (task.tool === "agent.delegate" && body.kind !== "agent-graph") {
      throw new GatewayError(400, "agent.delegate jobs require kind=agent-graph");
    }
    if (body.kind === "agent-graph" && task.tool !== "agent.delegate") {
      throw new GatewayError(400, "kind=agent-graph requires task.tool=agent.delegate");
    }
    if (task.tool === AGENT_GRAPH_TOOL && config?.runtime?.enableAgentGraphs !== true) {
      throw new GatewayError(403, "agent graph execution is disabled; enable config.runtime.enableAgentGraphs explicitly");
    }
    const channelExecutionRequested = task.tool === "agent.run"
      && Object.prototype.hasOwnProperty.call(body, "executionKey");
    let channelExecutionKey: string | undefined;
    if (channelExecutionRequested) {
      if (typeof body.executionKey !== "string" || !body.executionKey
        || Buffer.byteLength(body.executionKey, "utf8") > 512) {
        throw new GatewayError(400, "channel executionKey must contain 1 through 512 bytes");
      }
      channelExecutionKey = body.executionKey;
      if ((body.id !== undefined && String(body.id) !== channelExecutionKey)
        || (idempotencyKey !== undefined && idempotencyKey !== channelExecutionKey)) {
        throw new GatewayError(409, "channel execution identity does not match its idempotency key");
      }
      const input = task.input && typeof task.input === "object" && !Array.isArray(task.input)
        ? task.input
        : undefined;
      const sessionId = typeof input?.sessionId === "string" ? input.sessionId : "";
      if (!sessionId || Buffer.byteLength(sessionId, "utf8") > 256) {
        throw new GatewayError(400, "channel execution requires a bounded sessionId");
      }
      const session = await channelResultRecords.getCurrentSession(sessionId);
      if (!session || session.status !== "open") {
        throw new GatewayError(409, "channel session is unavailable or closed");
      }
      const sessionActor = typeof session.actor === "string" ? session.actor : "";
      const acceptedActors = tenantScope.hosted
        ? [tenantScope.principalId]
        : [tenantScope.principalId, "local"];
      if (!acceptedActors.includes(sessionActor)) {
        throw new GatewayError(403, "channel session is not owned by the authenticated principal");
      }
    }
    const parentCapabilities = task.tool === AGENT_GRAPH_TOOL
      ? (() => {
        try {
          const capabilities = assertCapabilityIds(body.parentCapabilities, "parentCapabilities");
          if (!capabilities.length) throw new Error("agent graph jobs require at least one explicit parent capability");
          return capabilities;
        } catch (error) {
          throw new GatewayError(400, error instanceof Error ? error.message : "parentCapabilities is invalid");
        }
      })()
      : undefined;
    const activeJobs = (await supervisor.list()).filter((job: any) => ["queued", "running"].includes(job.status)).length;
    if (activeJobs >= quotaGate.maximumActiveJobs) throw new GatewayError(429, "tenant active-job quota exceeded");
    const id = channelExecutionKey ?? (body.id || idempotencyKey || undefined);
    const requestHash = hashRequest(delegation ? { ...body, delegation } : body);
    const scopedPayloadBase = scopedJobPayload({
      durableExecution: task.tool === "process.exec" || task.tool === "agent.delegate" || task.tool === "mcp.invoke",
      ...(parentCapabilities ? { parentCapabilities } : {}),
      ...(delegation ? { delegation } : {}),
      ...(typeof body.executionKey === "string" ? { executionKey: body.executionKey } : {}),
      task: { ...task, ...(id ? { id: String(id) } : {}) }
    }, tenantScope);
    const scopedPayload = {
      ...scopedPayloadBase,
      replayIdentity: durableJobReplayIdentity(scopedPayloadBase)
    };
    if (id) {
      const existing = await supervisor.get(String(id));
      if (existing) {
        if (!durableJobReplayIdentityMatches({ existing, requestHash, scopedPayload })) {
          return {
            id: String(id),
            requestHash,
            scopedPayload,
            retrySafe: false,
            existingSubmission: { status: 409, payload: { ok: false, error: "idempotency key was already used for a different request" } }
          };
        }
        return {
          id: String(id),
          requestHash,
          scopedPayload,
          retrySafe: false,
          existingSubmission: { status: 200, payload: { ok: true, replayed: true, job: existing } }
        };
      }
    }
    const safety = toolSafetyDescriptor(task.tool, registry.get(task.tool));
    const sandboxProcessConfig = task.tool === "process.exec" ? normalizeSandboxConfig(config).process : undefined;
    const requestedTimeout = Number.isSafeInteger(task.input?.timeoutMs) ? Number(task.input.timeoutMs) : sandboxProcessConfig?.limits.timeoutMs;
    const requestedGraphTimeout = Number.isSafeInteger(task.input?.maxRunMs) ? Number(task.input.maxRunMs) : 120_000;
    const effectiveTimeout = task.tool === "process.exec"
      ? Math.min(requestedTimeout ?? 120_000, sandboxProcessConfig?.limits.timeoutMs ?? 120_000) + 30_000
      : task.tool === "agent.delegate"
        ? Math.min(Math.max(requestedGraphTimeout, 1), 300_000) + 30_000
        : body.timeoutMs;
    return {
      ...(id ? { id: String(id) } : {}),
      requestHash,
      scopedPayload,
      effectiveTimeout,
      retrySafe: safety.retrySafe === true
    };
  };

  const commitDurableJobSubmission = async (
    prepared: PreparedDurableJobSubmission,
    creationControl?: AgentGraphReassignmentCreationControl
  ): Promise<{ status: number; payload: any }> => {
    if (prepared.existingSubmission) return prepared.existingSubmission;
    let job;
    try {
      job = await supervisor.submit(
        prepared.scopedPayload,
        {
          id: prepared.id,
          requestHash: prepared.requestHash,
          timeoutMs: prepared.effectiveTimeout,
          retrySafe: prepared.retrySafe,
          ...(creationControl ? { creationControl } : {})
        }
      );
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (["AGENT_GRAPH_REASSIGNMENT_TARGET_RESERVED", "AGENT_GRAPH_REASSIGNMENT_RESERVATION_LOST"].includes(code)) {
        throw new GatewayError(409, error instanceof Error ? error.message : "job id is reserved for agent graph reassignment");
      }
      throw error;
    }
    return { status: 202, payload: { ok: true, job } };
  };

  const submitDurableJob = async (
    body: any,
    idempotencyKey?: string,
    delegation?: { reassignedFromGraphRunId: string; reassignedFromRequestDigest: string }
  ): Promise<{ status: number; payload: any }> => commitDurableJobSubmission(
    await prepareDurableJobSubmission(body, idempotencyKey, delegation)
  );

  const server: any = createServer(async (request: any, response: any) => {
    const requestId = String(request.headers["x-odinn-request-id"] || randomUUID());
    response.setHeader("x-odinn-request-id", requestId);
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!validHostHeader(request)) return json(response, 421, { ok: false, error: "invalid gateway Host header" });
      if (request.method === "GET" && url.pathname === "/odinn-logo.png") {
        return image(response, 200, await readFile(join(PUBLIC_DIR, "odinn-logo.png")), "image/png");
      }
      if (request.method === "GET" && url.pathname.startsWith("/console/assets/")) {
        try {
          const asset = await readConsoleAsset(url.pathname);
          return staticAsset(response, 200, asset.body, asset.contentType);
        } catch {
          return json(response, 404, { ok: false, error: "console asset not found" });
        }
      }
      if (request.method === "GET" && url.pathname === "/") {
        const bootstrapHeaders = permitsGatewayTokenBootstrap(request, server)
          ? {
              "set-cookie": `odinn_gateway_token=${encodeURIComponent(gatewayToken)}; HttpOnly; SameSite=Strict; Path=/`,
              "x-odinn-auth": "bootstrap-cookie"
            }
          : { "x-odinn-auth": "authentication-required" };
        return html(response, 200, renderConsoleHtml(version), { ...bootstrapHeaders, "content-security-policy": CONSOLE_CSP });
      }
      if (url.pathname.startsWith("/channels/webhook/")) {
        if (await channelSupervisor.handleWebhook(request, response, url)) return;
        return json(response, 404, { ok: false, error: "channel webhook not found" });
      }
      const authentication = process.env.ODINN_GATEWAY_AUTH === "off" ? "disabled" : authenticationMode(request, gatewayToken);
      if (!authentication) {
        return json(response, 401, { ok: false, error: "gateway authentication required" });
      }
      request.__odinnTenantScope = tenantScope;
      if (isMutatingMethod(request.method) && !validMutationOrigin(request, authentication)) {
        return json(response, 403, { ok: false, error: "origin rejected for control-plane mutation" });
      }
      const routeAbort = new AbortController();
      const abortRoute = () => routeAbort.abort();
      request.once("aborted", abortRoute);
      response.once("close", abortRoute);
      try {
        if (await applicationReadRouter.dispatch(Object.freeze({
          request,
          response,
          url,
          requestId,
          applicationRequestId: randomUUID(),
          authentication,
          hostedUserId: trustedHostedUserId,
          hostedTenantId: trustedHostedTenantId,
          signal: routeAbort.signal,
        }))) return;
      } finally {
        request.off("aborted", abortRoute);
        response.off("close", abortRoute);
      }
      if (request.method === "GET" && url.pathname === "/config") {
        const editable = await readEditableConfig(state, { hosted });
        return json(response, 200, {
          ok: true,
          ...editable,
          restartRequired: !configsMatch(editable.config, config)
        });
      }
      if (request.method === "PUT" && url.pathname === "/config") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const saved = await writeEditableConfig(state, body, { hosted });
        return json(response, 200, {
          ok: true,
          ...saved,
          restartRequired: !configsMatch(saved.config, config)
        });
      }
      if (request.method === "POST" && url.pathname === "/operator/actions") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const action = String(body.action || "").trim();
        if (!operatorActionNames().includes(action as any)) throw new GatewayError(400, "operator action is unsupported");
        if (action !== "verify-audit" && body.confirm !== true) throw new GatewayError(400, "operator action requires confirm=true");
        let targetId: string | undefined;
        if (action !== "verify-audit") {
          try { targetId = validateOperatorIdentifierV1(body.targetId, "operator action targetId"); }
          catch { throw new GatewayError(400, "operator action targetId is invalid"); }
        }
        let result: any;
        const requiredTargetId = () => {
          if (!targetId) throw new GatewayError(400, "operator action targetId is required");
          return targetId;
        };
        if (action === "cancel-job") {
          for (const approval of approvalStore.list()) if (approval.runId === targetId && approval.id) approvalStore.revoke(approval.id);
          result = await supervisor.cancel(requiredTargetId());
        } else if (action === "approve") {
          result = await approveGatewayApproval(requiredTargetId());
        } else if (action === "deny-approval") {
          result = await denyGatewayApproval(requiredTargetId());
        } else if (action === "cancel-workflow") {
          if (!workflowRuntime) throw new GatewayError(403, "durable workflows are disabled");
          result = await workflowRuntime.cancel(requiredTargetId());
        } else {
          result = await auditStore.verifyIntegrity({ allowUnsigned: true });
        }
        const requestedSurface = String(body.surface || "http");
        const surface = gatewayOperatorSurface(requestedSurface);
        try {
          const snapshotResult = await operatorSnapshotRead.execute(createGatewayOperatorSnapshotReadRequest({
            applicationRequestId: randomUUID(),
            hostedUserId: trustedHostedUserId,
            hostedTenantId: trustedHostedTenantId,
            authentication,
            sourcePath: "/operator/actions",
            input: { surface }
          }));
          return json(response, 200, { ok: true, action, ...(targetId ? { targetId } : {}), result, snapshot: snapshotResult.output });
        } catch (error) {
          const failure = gatewayOperatorSnapshotFailure(error, requestId);
          return json(response, 200, {
            ok: true,
            action,
            ...(targetId ? { targetId } : {}),
            result,
            snapshotUnavailable: failure
              ? { code: OPERATOR_SNAPSHOT_CHANGED_CODE, retryable: true }
              : { code: "OPERATOR_SNAPSHOT_UNAVAILABLE", retryable: false },
          });
        }
      }
      if (request.method === "GET" && url.pathname === "/channels") {
        return json(response, 200, { ok: true, channels: channelSupervisor.status() });
      }
      if (request.method === "GET" && url.pathname === "/agents") {
        return json(response, 200, { agents: await agentStore.list(), sdkVersion: AGENT_SDK_VERSION });
      }
      if (request.method === "POST" && url.pathname === "/agents/validate") {
        return json(response, 200, { ok: true, manifest: validateAgentPackage(await readJson(request, { maxBytes: requestMaxBytes })) });
      }
      if (request.method === "POST" && url.pathname === "/agents") {
        return json(response, 200, { ok: true, agent: await agentStore.install(await readJson(request, { maxBytes: requestMaxBytes })) });
      }
      if (request.method === "POST" && url.pathname.startsWith("/agents/") && url.pathname.endsWith("/lifecycle")) {
        const id = decodeURIComponent(url.pathname.slice("/agents/".length, -"/lifecycle".length));
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, { ok: true, agent: await agentStore.transition(id, body.action) });
      }
      if (request.method === "GET" && url.pathname === "/skills") {
        const [managed, files, extensions] = await Promise.all([skillLifecycle.inspect(), discoverSkills(root, state), extensionRegistry.list()]);
        return json(response, 200, {
          sdkVersion: "0.1",
          skills: [
            ...managed.map((skill: any) => ({ ...skill, source: "managed" })),
            ...files,
            ...extensions.filter((extension: any) => extension.type === "skill").map((extension: any) => ({ ...extension, source: "legacy-extension", status: "unmanaged", path: extension.entrypoint }))
          ]
        });
      }
      if (request.method === "GET" && url.pathname === "/mcp") {
        if (!mcpRuntime) throw new GatewayError(404, "MCP activation is disabled");
        return json(response, 200, { ok: true, ...mcpRuntime.status() });
      }
      if (request.method === "GET" && url.pathname === "/skills/catalog") {
        if (config.runtime?.enableProgressiveSkills !== true) throw new GatewayError(404, "progressive skill disclosure is disabled");
        return json(response, 200, { ok: true, entries: await skillDisclosure.catalog() });
      }
      if (request.method === "GET" && url.pathname.startsWith("/skills/") && url.pathname.endsWith("/hydrate")) {
        if (config.runtime?.enableProgressiveSkills !== true) throw new GatewayError(404, "progressive skill disclosure is disabled");
        const id = decodeURIComponent(url.pathname.slice("/skills/".length, -"/hydrate".length));
        return json(response, 200, { ok: true, skill: await skillDisclosure.hydrate(id) });
      }
      if (request.method === "POST" && url.pathname === "/skills/validate") {
        return json(response, 200, { ok: true, ...validateSkillPackage(await readJson(request, { maxBytes: requestMaxBytes })) });
      }
      if (request.method === "POST" && url.pathname === "/skills") {
        skillLifecycle.assertWritable();
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, { ok: true, skill: await skillLifecycle.create(body, { operationId: requestId, actor: "gateway", idempotencyKey: String(request.headers["idempotency-key"] ?? "") }) });
      }
      if (request.method === "GET" && url.pathname.startsWith("/skills/") && url.pathname.endsWith("/verify")) {
        const id = decodeURIComponent(url.pathname.slice("/skills/".length, -"/verify".length));
        return json(response, 200, await skillStore.verify(id));
      }
      if (request.method === "POST" && url.pathname.startsWith("/skills/") && url.pathname.endsWith("/lifecycle")) {
        const id = decodeURIComponent(url.pathname.slice("/skills/".length, -"/lifecycle".length));
        skillLifecycle.assertWritable();
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const skill = await skillLifecycle.transition({ ...body, id }, { operationId: requestId, actor: "gateway", idempotencyKey: String(request.headers["idempotency-key"] ?? "") });
        return json(response, "type" in skill && skill.type === "approval.required" ? 202 : 200, { ok: true, skill });
      }
      if (request.method === "POST" && url.pathname === "/skills/workshop/validate") {
        return json(response, 200, validateSkillDraft(await readJson(request, { maxBytes: requestMaxBytes })));
      }
      if (request.method === "POST" && url.pathname === "/skills/workshop/save") {
        skillLifecycle.assertWritable();
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const validation = validateSkillDraft(body);
        if (!validation.valid) throw new GatewayError(400, validation.errors.join("; "));
        return json(response, 200, { ok: true, ...(await skillLifecycle.saveDraft(body, { operationId: requestId, actor: "gateway", idempotencyKey: String(request.headers["idempotency-key"] ?? "") })) });
      }
      if (request.method === "GET" && url.pathname === "/runtime/runs") {
        return json(response, 200, runtime.ledger.listRuns({ limit: Number.parseInt(url.searchParams.get("limit") ?? "100", 10) }));
      }
      if (request.method === "GET" && url.pathname.startsWith("/runtime/runs/") && url.pathname.endsWith("/verify")) {
        const runId = decodeURIComponent(url.pathname.slice("/runtime/runs/".length, -"/verify".length));
        return json(response, 200, runtime.ledger.verify(runId));
      }
      if (request.method === "GET" && url.pathname.startsWith("/runtime/runs/")) {
        const runId = decodeURIComponent(url.pathname.slice("/runtime/runs/".length));
        const run = runtime.ledger.getRun(runId);
        return run ? json(response, 200, run) : json(response, 404, { ok: false, error: "runtime run not found" });
      }
      if (request.method === "POST" && url.pathname === "/proof") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, await proofVerifier.verify(body));
      }
      if (request.method === "GET" && url.pathname.startsWith("/proof/")) {
        const runId = decodeURIComponent(url.pathname.slice("/proof/".length));
        return json(response, 200, { runId, assertions: runtime.proof.show(runId) });
      }
      if (request.method === "POST" && url.pathname === "/policy/evaluate") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        validatePolicy(body.policy);
        const runId = body.runId ?? `policy-${randomBytes(12).toString("hex")}`;
        runtime.ledger.ensureRun({ runId, objective: "policy evaluation" });
        return json(response, 200, runtime.sentinel.evaluate({ runId, stepId: body.stepId, toolName: body.toolName, input: body.input ?? {}, policy: body.policy, workspaceRoot: root }));
      }
      if (request.method === "POST" && url.pathname === "/gatewatch/preview") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        try {
          return json(response, 200, previewExecutionAdmission({
            task: { tool: body.toolName ?? body.tool, input: body.input ?? {} },
            policy,
            registry,
            workspaceRoot: root,
            parentCapabilities: body.parentCapabilities,
            requestedCapabilities: body.requestedCapabilities,
            skillCapabilities: body.skillCapabilities,
            mcpCapabilities: body.mcpCapabilities
          }));
        } catch (error) {
          throw new GatewayError(400, error instanceof Error ? error.message : "Gatewatch preview request is invalid");
        }
      }
      if (request.method === "POST" && url.pathname === "/capabilities/issue") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        runtime.ledger.ensureRun({ runId: body.runId, objective: body.objective ?? `capability: ${body.toolName}` });
        return json(response, 200, runtime.capabilities.issue(body));
      }
      if (request.method === "POST" && url.pathname === "/capabilities/use") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, runtime.capabilities.consume(body.token, body));
      }
      if (request.method === "GET" && url.pathname.startsWith("/capabilities/")) {
        const runId = decodeURIComponent(url.pathname.slice("/capabilities/".length));
        return json(response, 200, runtime.capabilities.list(runId));
      }
      if (request.method === "POST" && url.pathname.startsWith("/capabilities/") && url.pathname.endsWith("/revoke")) {
        const capabilityId = decodeURIComponent(url.pathname.slice("/capabilities/".length, -"/revoke".length));
        return json(response, 200, runtime.capabilities.revoke(capabilityId));
      }
      if (request.method === "POST" && url.pathname === "/checkpoints") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const snapshotRunId = body.runId;
        const runId = body.taskId || body.id || request.headers["idempotency-key"] || (snapshotRunId ? `checkpoint-create-${snapshotRunId}` : randomUUID());
        const result = await runGovernedTask({
          task: {
            id: runId,
            actor: body.actor || "gateway",
            tool: "snapshot.create",
            input: {
              paths: body.paths,
              stepId: body.stepId,
              label: body.label,
              snapshotRunId,
              capabilityToken: body.capabilityToken
            },
            reason: body.reason ?? "checkpoint create"
          }
        });
        return json(response, 200, result.output ?? result);
      }
      if (request.method === "POST" && url.pathname.startsWith("/rewind/")) {
        const snapshotId = decodeURIComponent(url.pathname.slice("/rewind/".length));
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const runId = body.runId || body.id || request.headers["idempotency-key"] || randomUUID();
        const result = await runGovernedTask({
          task: {
            id: runId,
            actor: body.actor || "gateway",
            tool: "snapshot.restore",
            input: {
              snapshotId,
              apply: body.apply === true,
              capabilityToken: body.capabilityToken
            },
            reason: body.reason
          }
        });
        return json(response, 200, result.output ?? result);
      }
      if (request.method === "POST" && url.pathname === "/governed/workspace/mutate") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const runId = body.runId || body.id || request.headers["idempotency-key"] || randomUUID();
        if (!runId || typeof runId !== "string") return json(response, 400, { ok: false, error: "runId is required for governed mutation" });
        const result = await runGovernedTask({
          task: {
            id: runId,
            actor: body.actor || "gateway",
            tool: "workspace.mutate",
            input: {
              operation: body.operation,
              path: body.path,
              content: body.content,
              mode: body.mode,
              expected: body.expected,
              from: body.from,
              to: body.to,
              recursive: body.recursive,
              apply: body.apply === true,
              maxBytes: body.maxBytes,
              maxFiles: body.maxFiles,
              capabilityToken: body.capabilityToken
            },
            reason: body.reason
          }
        });
        return json(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/governed/workspace/patch") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const runId = body.runId || body.id || request.headers["idempotency-key"] || randomUUID();
        if (!runId || typeof runId !== "string") return json(response, 400, { ok: false, error: "runId is required for governed mutation" });
        const result = await runGovernedTask({
          task: {
            id: runId,
            actor: body.actor || "gateway",
            tool: "workspace.patch",
            input: {
              operation: body.operation,
              path: body.path,
              find: body.find,
              replace: body.replace,
              replaceAll: body.replaceAll,
              patches: body.patches,
              expected: body.expected,
              apply: body.apply === true,
              maxBytes: body.maxBytes,
              maxFiles: body.maxFiles,
              capabilityToken: body.capabilityToken
            },
            reason: body.reason
          }
        });
        return json(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/governed/restore/create") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const runId = body.runId || body.id || request.headers["idempotency-key"] || randomUUID();
        if (!runId || typeof runId !== "string") return json(response, 400, { ok: false, error: "runId is required for governed restore" });
        const result = await runGovernedTask({
          task: {
            id: runId,
            actor: body.actor || "gateway",
            tool: "restore.create",
            input: {
              checkpointId: body.checkpointId,
              checkpointManifestDigest: body.checkpointManifestDigest,
              capabilityToken: body.capabilityToken
            },
            reason: body.reason
          }
        });
        return json(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/governed/restore/apply") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const runId = body.runId || body.id || request.headers["idempotency-key"] || randomUUID();
        if (!runId || typeof runId !== "string") return json(response, 400, { ok: false, error: "runId is required for governed restore" });
        const result = await runGovernedTask({
          task: {
            id: runId,
            actor: body.actor || "gateway",
            tool: "restore.apply",
            input: {
              checkpointId: body.checkpointId,
              checkpointManifestDigest: body.checkpointManifestDigest,
              apply: true,
              capabilityToken: body.capabilityToken
            },
            reason: body.reason
          }
        });
        return json(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/capsules/export") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const output = body.output ? safeCapsulePath(state, body.output) : join(state, "capsules", `${body.runId}.odinn`);
        return json(response, 200, await runtime.capsules.export(body.runId, { ...body, output }));
      }
      if (request.method === "POST" && url.pathname === "/capsules/verify") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, await runtime.capsules.verify(safeCapsulePath(state, body.path)));
      }
      if (request.method === "POST" && url.pathname === "/capsules/replay") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, await runtime.capsules.replay(safeCapsulePath(state, body.path), { mode: body.mode, workspace: body.workspace }));
      }
      if (request.method === "POST" && url.pathname === "/counterfactual") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, await runtime.counterfactual.create({ ...body, workspaceRoot: root }));
      }
      if (request.method === "GET" && url.pathname.startsWith("/counterfactual/")) {
        if (url.pathname.endsWith("/execute")) return json(response, 405, { ok: false, error: "counterfactual execute requires POST" });
        const groupId = decodeURIComponent(url.pathname.slice("/counterfactual/".length));
        return json(response, 200, runtime.counterfactual.compare(groupId));
      }
      if (request.method === "POST" && url.pathname.startsWith("/counterfactual/") && url.pathname.endsWith("/execute")) {
        const groupId = decodeURIComponent(url.pathname.slice("/counterfactual/".length, -"/execute".length));
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, await runtime.counterfactual.execute(groupId, {
          capabilities: runtime.capabilities,
          proof: {
            run: async (runId: string, contract: any, { workspaceRoot = root }: any = {}) => {
              return new ProofVerifier({
                runLedger: runtime.ledger,
                allowedRoot: workspaceRoot,
                ...proofOptions
              }).verify({ ...contract, runId });
            }
          },
          policy,
          executor: (task: any, context: any) => isolatedTaskExecutor({ task, workspaceRoot: context.workspaceRoot })
        }));
      }
      if (request.method === "POST" && url.pathname.startsWith("/counterfactual/") && url.pathname.endsWith("/select")) {
        const groupId = decodeURIComponent(url.pathname.slice("/counterfactual/".length, -"/select".length));
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, await runtime.counterfactual.select(groupId, body.runId, { apply: body.apply === true }));
      }
      if (request.method === "POST" && url.pathname === "/routing/observe") {
        return json(response, 200, runtime.darwin.observe(await readJson(request, { maxBytes: requestMaxBytes })));
      }
      if (request.method === "GET" && url.pathname === "/routing/stats") {
        return json(response, 200, runtime.darwin.stats(url.searchParams.get("taskClass") ?? "general"));
      }
      if (request.method === "POST" && url.pathname === "/routing/choose") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const runId = body.runId ?? `routing-${randomBytes(12).toString("hex")}`;
        runtime.ledger.ensureRun({ runId, objective: `choose a model for ${body.taskClass ?? "general"}` });
        return json(response, 200, { ...runtime.darwin.choose(body.taskClass ?? "general", { pinnedModel: body.pinnedModel, runId }), runId });
      }
      if (request.method === "GET" && url.pathname === "/runs") {
        return json(response, 200, await auditStore.readRuns());
      }
      if (request.method === "GET" && url.pathname.startsWith("/runs/")) {
        const id = decodeURIComponent(url.pathname.slice("/runs/".length));
        const run = await auditStore.readRun(id);
        return run ? json(response, 200, run) : json(response, 404, { ok: false, error: "run not found" });
      }
      if (request.method === "POST" && url.pathname.startsWith("/runs/") && url.pathname.endsWith("/replay")) {
        const id = decodeURIComponent(url.pathname.slice("/runs/".length, -"/replay".length));
        const original = await auditStore.readRun(id);
        const started = original?.events?.find((event: any) => event.type === "task.started");
        if (!original || !started?.tool || !started.data?.input) return json(response, 409, { ok: false, error: "run has no replayable task input" });
        const safety = toolSafetyDescriptor(started.tool, registry.get(started.tool));
        if (safety.retrySafe !== true) return json(response, 409, { ok: false, error: `tool ${started.tool} is not declared retry-safe and cannot be replayed from the console` });
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const replayId = body.id || request.headers["idempotency-key"] || `${id}:replay:${Date.now()}`;
        return json(response, 200, await isolatedTaskExecutor({
          task: { id: replayId, tool: started.tool, input: started.data.input, actor: "gateway-replay", reason: `replay:${id}` },
        }));
      }
      if (request.method === "GET" && url.pathname === "/agent-graphs") {
        try {
          return json(response, 200, { graphs: runtime.ledger.listAgentGraphRuns({
            limit: Number(url.searchParams.get("limit") || 20),
            status: url.searchParams.get("status") || undefined,
            parentRunId: url.searchParams.get("parentRunId") || undefined
          }) });
        } catch (error) {
          throw new GatewayError(400, error instanceof Error ? error.message : "agent graph query is invalid");
        }
      }
      if (url.pathname.startsWith("/agent-graphs/")) {
        const suffix = url.pathname.slice("/agent-graphs/".length);
        const action = ["cancel", "reassign", "checkpoint"].find((candidate) => suffix.endsWith(`/${candidate}`));
        const encodedId = action ? suffix.slice(0, -`/${action}`.length) : suffix;
        const graphRunId = decodeURIComponent(encodedId);
        const graph = runtime.ledger.getAgentGraphRun(graphRunId);
        if (!graph) return json(response, 404, { ok: false, error: "agent graph not found" });
        if (request.method === "GET" && !action) return json(response, 200, { graph });
        if (request.method === "POST" && action === "cancel") {
          const operationId = `cancel:${graph.requestDigest}`;
          ensureGraphControlLedgerIntent({
            parentRunId: graph.parentRunId,
            type: "agent-graph-cancellation-requested",
            operationId,
            payload: { graphRunId, requestDigest: graph.requestDigest }
          });
          await ensureGraphControlAuditIntent({
            action: "cancel",
            graphRunId,
            parentRunId: graph.parentRunId,
            operationId,
            type: "agent.graph.cancellation.requested",
            tool: AGENT_GRAPH_TOOL,
            data: { requestDigest: graph.requestDigest }
          });
          const parentJob = await supervisor.get(graph.parentRunId);
          if (!parentJob) {
            if (["validated", "running", "publishing"].includes(graph.status)) {
              runtime.ledger.cancelAgentGraphRun({ graphRunId, errorCode: "GRAPH_PARENT_JOB_MISSING" });
            }
            return json(response, 409, {
              ok: false,
              error: "agent graph parent job is unavailable; the graph was quarantined for review",
              graph: runtime.ledger.getAgentGraphRun(graphRunId)
            });
          }
          const job = await supervisor.cancel(graph.parentRunId);
          await ensureGraphControlAuditOutcome({
            runId: graph.parentRunId,
            graphRunId,
            operationId,
            type: "agent.graph.cancellation.completed",
            tool: AGENT_GRAPH_TOOL,
            data: {
              requestDigest: graph.requestDigest,
              jobStatus: job.status,
              graphStatus: runtime.ledger.getAgentGraphRun(graphRunId)?.status
            }
          });
          return json(response, 200, { ok: true, job, graph: runtime.ledger.getAgentGraphRun(graphRunId) });
        }
        if (request.method === "POST" && action === "reassign") {
          if (!["failed", "cancelled", "needs-review"].includes(graph.status)) {
            throw new GatewayError(409, "agent graph must be terminal and incomplete before reassignment");
          }
          const body = await readJson(request, { maxBytes: requestMaxBytes });
          if (body.expectedRequestDigest !== graph.requestDigest) {
            throw new GatewayError(409, "agent graph request digest changed before reassignment");
          }
          if (!body.replacement || typeof body.replacement !== "object" || Array.isArray(body.replacement)) {
            throw new GatewayError(400, "agent graph reassignment requires a replacement job");
          }
          if (body.replacement.kind !== "agent-graph") {
            throw new GatewayError(400, "agent graph reassignment replacement must declare kind=agent-graph");
          }
          const replacement = { ...body.replacement, kind: "agent-graph" };
          const replacementId = replacement.id || request.headers["idempotency-key"];
          if (typeof replacementId !== "string" || !replacementId || replacementId === graph.parentRunId) {
            throw new GatewayError(400, "agent graph reassignment requires a new idempotency key");
          }
          replacement.id = replacementId;
          const parentJob = await supervisor.get(graph.parentRunId);
          if (!parentJob) throw new GatewayError(409, "agent graph parent job is unavailable for authority comparison");
          const priorCapabilities = assertCapabilityIds(parentJob.payload?.parentCapabilities, "prior parentCapabilities");
          const replacementCapabilities = assertCapabilityIds(replacement.parentCapabilities, "replacement parentCapabilities");
          if (replacementCapabilities.some((capability) => !priorCapabilities.includes(capability))) {
            throw new GatewayError(403, "agent graph reassignment cannot widen parent authority");
          }
          const replacementTask = replacement.task && typeof replacement.task === "object" && !Array.isArray(replacement.task)
            ? replacement.task
            : undefined;
          const replacementPrincipal = replacementTask?.input?.principalNamespace;
          if (typeof replacementPrincipal !== "string" || `sha256:${hashRequest(replacementPrincipal)}` !== graph.principalNamespace) {
            throw new GatewayError(403, "agent graph reassignment must preserve the principal namespace");
          }
          const trustedParentScope = parentJob.payload?.scope;
          const trustedParentScopeRecord = trustedParentScope && typeof trustedParentScope === "object" && !Array.isArray(trustedParentScope)
            ? trustedParentScope as Record<string, unknown>
            : undefined;
          if (!trustedParentScopeRecord
            || trustedParentScopeRecord.tenantId !== tenantScope.tenantId
            || trustedParentScopeRecord.principalId !== tenantScope.principalId) {
            throw new GatewayError(403, "agent graph reassignment must preserve the original trusted tenant and principal");
          }
          const delegation = {
            reassignedFromGraphRunId: graphRunId,
            reassignedFromRequestDigest: graph.requestDigest
          };
          const preparedSubmission = await prepareDurableJobSubmission(replacement, replacementId, delegation);
          const replacementRequestHash = preparedSubmission.requestHash;
          const replacementIdentityDigest = hashRequest({
            tool: replacementTask.tool,
            delegation,
            scope: trustedParentScopeRecord,
            principalNamespace: replacementPrincipal,
            parentCapabilities: replacementCapabilities
          });
          const operationId = `reassign:${replacementId}`;
          const scopeDigest = hashRequest(trustedParentScopeRecord);
          const controlDigest = hashRequest({
            action: "reassign",
            graphRunId,
            parentRunId: graph.parentRunId,
            operationId,
            sourceRequestDigest: graph.requestDigest,
            replacementJobId: replacementId,
            replacementRequestHash,
            replacementIdentityDigest,
            tenantId: tenantScope.tenantId,
            principalId: tenantScope.principalId,
            scopeDigest
          });
          try {
            runtime.ledger.reserveAgentGraphReassignment({
              graphRunId,
              expectedRequestDigest: graph.requestDigest,
              replacementJobId: replacementId,
              replacementRequestHash,
              replacementIdentityDigest,
              trustedPrincipalId: tenantScope.principalId
            });
          } catch (error) {
            const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
            const status = code === "AGENT_GRAPH_REASSIGNMENT_PRINCIPAL_MISMATCH" ? 403
              : code === "AGENT_GRAPH_REASSIGNMENT_INVALID" ? 400
                : 409;
            throw new GatewayError(status, error instanceof Error ? error.message : "agent graph reassignment reservation failed");
          }
          try {
            await ensureGraphControlAuditIntent({
              action: "reassign",
              graphRunId,
              parentRunId: graph.parentRunId,
              operationId,
              type: "agent.graph.reassignment.requested",
              tool: AGENT_GRAPH_TOOL,
              data: {
                requestDigest: graph.requestDigest,
                replacementJobId: replacementId,
                replacementRequestHash,
                replacementIdentityDigest,
                tenantId: tenantScope.tenantId,
                trustedPrincipalId: tenantScope.principalId,
                scopeDigest
              },
              controlDigest
            });
          } catch (error) {
            runtime.ledger.releaseAgentGraphReassignment({ graphRunId, replacementJobId: replacementId });
            throw error;
          }
          let submission;
          try {
            submission = await commitDurableJobSubmission(preparedSubmission, {
              agentGraphReassignment: {
                graphRunId,
                replacementJobId: replacementId,
                replacementRequestHash,
                replacementIdentityDigest,
                trustedPrincipalId: tenantScope.principalId
              }
            });
          } catch (error) {
            runtime.ledger.releaseAgentGraphReassignment({ graphRunId, replacementJobId: replacementId });
            throw error;
          }
          if (submission.status >= 400) {
            runtime.ledger.releaseAgentGraphReassignment({ graphRunId, replacementJobId: replacementId });
            return json(response, submission.status, submission.payload);
          }
          const replacementJobId = String(submission.payload.job.id);
          runtime.ledger.markAgentGraphReassignmentSubmitted({ graphRunId, replacementJobId, replacementRequestHash });
          await ensureGraphControlAuditOutcome({
            runId: graph.parentRunId,
            graphRunId,
            operationId,
            type: "agent.graph.reassigned",
            tool: AGENT_GRAPH_TOOL,
            data: { requestDigest: graph.requestDigest, replacementJobId, replacementRequestHash }
          });
          return json(response, submission.status, { ...submission.payload, reassignedFrom: graphRunId });
        }
        if (request.method === "POST" && action === "checkpoint") {
          const body = await readJson(request, { maxBytes: requestMaxBytes });
          if (graph.status !== "completed") throw new GatewayError(409, "agent graph must complete before checkpoint admission");
          const nodeId = String(body.nodeId || "");
          const node = graph.nodes.find((candidate: any) => candidate.nodeId === nodeId);
          if (!node || node.status !== "completed" || typeof node.resultDigest !== "string") {
            throw new GatewayError(409, "agent graph checkpoint requires a completed child result");
          }
          if (body.expectedResultDigest !== node.resultDigest) {
            throw new GatewayError(409, "agent graph child result digest changed before checkpoint admission");
          }
          const tool = body.tool === "workspace.patch" ? "workspace.patch" : body.tool === "workspace.mutate" ? "workspace.mutate" : undefined;
          if (!tool) throw new GatewayError(400, "agent graph checkpoint tool must be workspace.mutate or workspace.patch");
          const parentJob = await supervisor.get(graph.parentRunId);
          if (!parentJob) throw new GatewayError(409, "agent graph parent job is unavailable for authority comparison");
          const parentCapabilities = assertCapabilityIds(parentJob.payload?.parentCapabilities, "parentCapabilities");
          if (!parentCapabilities.includes(tool)) throw new GatewayError(403, `agent graph parent authority does not include ${tool}`);
          const runId = body.runId || body.id || request.headers["idempotency-key"];
          if (typeof runId !== "string" || !runId) throw new GatewayError(400, "agent graph checkpoint requires a run id");
          if (typeof body.capabilityToken !== "string" || !body.capabilityToken) {
            throw new GatewayError(400, "agent graph checkpoint requires a capability token");
          }
          const input = tool === "workspace.patch"
            ? {
              operation: body.operation,
              path: body.path,
              find: body.find,
              replace: body.replace,
              replaceAll: body.replaceAll,
              patches: body.patches,
              expected: body.expected,
              apply: body.apply === true,
              maxBytes: body.maxBytes,
              maxFiles: body.maxFiles,
              capabilityToken: body.capabilityToken
            }
            : {
              operation: body.operation,
              path: body.path,
              content: body.content,
              mode: body.mode,
              expected: body.expected,
              from: body.from,
              to: body.to,
              recursive: body.recursive,
              apply: body.apply === true,
              maxBytes: body.maxBytes,
              maxFiles: body.maxFiles,
              capabilityToken: body.capabilityToken
            };
          const operationId = `checkpoint:${runId}`;
          const checkpointControlDigest = hashRequest({
            graphRunId,
            nodeId,
            expectedResultDigest: node.resultDigest,
            runId,
            tool,
            input
          });
          ensureGraphControlLedgerIntent({
            parentRunId: graph.parentRunId,
            type: "agent-graph-checkpoint-requested",
            operationId,
            payload: { graphRunId, nodeId, resultDigest: node.resultDigest, checkpointRunId: runId, tool, checkpointControlDigest }
          });
          await ensureGraphControlAuditIntent({
            action: "checkpoint",
            graphRunId,
            parentRunId: graph.parentRunId,
            operationId,
            type: "agent.graph.checkpoint.requested",
            tool,
            data: { nodeId, resultDigest: node.resultDigest, checkpointRunId: runId, checkpointControlDigest, apply: body.apply === true }
          });
          const result = await runGovernedTask({
            task: {
              id: runId,
              actor: tenantScope.principalId,
              tool,
              input,
              reason: `agent-graph-checkpoint:${graphRunId}:${nodeId}`
            },
            parentRunId: graph.parentRunId,
            parentCapabilities,
            durableExecution: true
          });
          await ensureGraphControlAuditOutcome({
            runId,
            graphRunId,
            operationId,
            type: "agent.graph.checkpoint",
            tool,
            data: {
              nodeId,
              resultDigest: node.resultDigest,
              checkpointRunId: runId,
              checkpointControlDigest,
              apply: body.apply === true
            }
          });
          return json(response, 200, { ok: true, graphRunId, nodeId, result });
        }
      }
      if (request.method === "GET" && url.pathname === "/jobs") {
        return json(response, 200, { jobs: await supervisor.list() });
      }
      if (url.pathname === "/workflows" || url.pathname.startsWith("/workflows/")) {
        if (!workflowRuntime) throw new GatewayError(403, "durable workflows are disabled; enable config.runtime.enableDurableWorkflows explicitly");
        if (request.method === "GET" && url.pathname === "/workflows") return json(response, 200, { workflows: workflowRuntime.list() });
        if (request.method === "POST" && url.pathname === "/workflows") {
          const body = await readJson(request, { maxBytes: requestMaxBytes });
          const key = String(body.idempotencyKey || request.headers["idempotency-key"] || body.runId || `workflow:${randomUUID()}`);
          const run = await workflowRuntime.submit({
            schemaVersion: 1,
            runId: String(body.runId || `workflow_${randomUUID()}`),
            principalId: tenantScope.hosted ? `${tenantScope.principalId}:${tenantScope.tenantId}` : tenantScope.principalId,
            idempotencyKey: key,
            definition: body.definition,
            input: body.input ?? {}
          });
          return json(response, 202, { ok: true, run });
        }
        const workflowId = decodeURIComponent(url.pathname.slice("/workflows/".length));
        if (request.method === "GET" && workflowId.endsWith("/events")) {
          const id = workflowId.slice(0, -"/events".length);
          return json(response, 200, { events: workflowRuntime.events(id) });
        }
        if (request.method === "POST" && workflowId.endsWith("/cancel")) {
          return json(response, 200, { ok: true, run: await workflowRuntime.cancel(workflowId.slice(0, -"/cancel".length)) });
        }
        if (request.method === "POST" && workflowId.endsWith("/resume")) {
          return json(response, 200, { ok: true, run: await workflowRuntime.resume(workflowId.slice(0, -"/resume".length)) });
        }
        if (request.method === "GET") {
          const run = workflowRuntime.get(workflowId);
          return run ? json(response, 200, { run }) : json(response, 404, { ok: false, error: "workflow not found" });
        }
      }
      if (url.pathname === "/event-sources" || url.pathname === "/event-watches" || url.pathname === "/events/ingest" || url.pathname === "/heartbeat") {
        if (!eventIngress) throw new GatewayError(403, "event ingress is disabled; enable config.runtime.enableEventIngress explicitly");
        if (request.method === "POST" && url.pathname === "/event-sources") {
          const body = await readJson(request, { maxBytes: requestMaxBytes });
          return json(response, 200, { ok: true, source: eventIngress.registerSource({ source: String(body.source || ""), authDigest: String(body.authDigest || ""), oldestSequence: body.oldestSequence }) });
        }
        if (request.method === "GET" && url.pathname === "/event-watches") return json(response, 200, { watches: eventIngress.listWatches() });
        if (request.method === "POST" && url.pathname === "/event-watches") {
          const body = await readJson(request, { maxBytes: requestMaxBytes });
          return json(response, 200, { ok: true, watchId: body.watchId, declaration: eventIngress.registerWatch(String(body.watchId || ""), body.declaration) });
        }
        if (request.method === "POST" && url.pathname === "/events/ingest") {
          const body = await readJson(request, { maxBytes: requestMaxBytes });
          return json(response, 202, { ok: true, ...(await eventIngress.ingest(body.event, String(body.authDigest || ""))) });
        }
        if (request.method === "POST" && url.pathname === "/heartbeat") return json(response, 202, { ok: true, candidates: await eventIngress.heartbeat(Number((await readJson(request, { maxBytes: requestMaxBytes })).nowUnixMs ?? Date.now())) });
      }
      if (url.pathname === "/context" || url.pathname.startsWith("/projects/") && url.pathname.endsWith("/context")) {
        if (!projectContext) throw new GatewayError(403, "project context is disabled; enable config.runtime.enableProjectContext explicitly");
        if (request.method === "GET") {
          const projectId = url.pathname.startsWith("/projects/") ? decodeURIComponent(url.pathname.slice("/projects/".length, -"/context".length)) : url.searchParams.get("projectId") || undefined;
          return json(response, 200, await projectContext.build({ query: url.searchParams.get("query") || "", projectId, sessionId: url.searchParams.get("sessionId") || undefined, limit: Number(url.searchParams.get("limit") || 12) }));
        }
        if (request.method === "POST" && url.pathname === "/context") return json(response, 200, await projectContext.build(await readJson(request, { maxBytes: requestMaxBytes })));
      }
      if (request.method === "GET" && url.pathname === "/cron") {
        return json(response, 200, { enabled: true, jobs: await cronStore.list(), nextWake: await cronStore.nextWake() });
      }
      if (request.method === "POST" && url.pathname === "/cron") {
        return json(response, 200, { ok: true, job: await cronStore.create(cronMutationInput(await readJson(request, { maxBytes: requestMaxBytes }), true)) });
      }
      if (request.method === "PATCH" && url.pathname.startsWith("/cron/")) {
        const id = decodeURIComponent(url.pathname.slice("/cron/".length));
        return json(response, 200, { ok: true, job: await cronStore.update(id, cronMutationInput(await readJson(request, { maxBytes: requestMaxBytes }), false)) });
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/cron/")) {
        const id = decodeURIComponent(url.pathname.slice("/cron/".length));
        await cronStore.remove(id);
        return json(response, 200, { ok: true });
      }
      if (request.method === "POST" && url.pathname.startsWith("/cron/") && url.pathname.endsWith("/run")) {
        const id = decodeURIComponent(url.pathname.slice("/cron/".length, -"/run".length));
        return json(response, 200, { ok: true, result: await runCronJob(cronStore, id, isolatedTaskExecutor, tenantScope) });
      }
      if (request.method === "GET" && url.pathname.startsWith("/jobs/") && url.pathname.endsWith("/result")) {
        const id = decodeURIComponent(url.pathname.slice("/jobs/".length, -"/result".length));
        const job = await supervisor.get(id);
        if (!job) return json(response, 404, { ok: false, error: "job not found" });
        const task = job.payload?.task;
        const taskTool = task && typeof task === "object" && !Array.isArray(task) ? (task as Record<string, unknown>).tool : undefined;
        if (job.status !== "completed" || job.payload?.executionKey !== id || taskTool !== "agent.run") {
          return json(response, 409, { ok: false, error: "durable channel result is unavailable" });
        }
        let durableResult: unknown;
        try {
          durableResult = await readDurableChannelResult(channelResultRecords, job, tenantScope);
        } catch {
          await jobStore.update(job.id, {
            status: "needs-review",
            completedAt: new Date().toISOString(),
            error: "protected channel result failed integrity verification",
            dispatchLease: undefined
          });
          return json(response, 409, { ok: false, error: "durable channel result is unavailable" });
        }
        if (durableResult === undefined) {
          await jobStore.update(job.id, {
            status: "needs-review",
            completedAt: new Date().toISOString(),
            error: "protected channel result is unavailable after completed execution",
            dispatchLease: undefined
          });
          return json(response, 409, { ok: false, error: "durable channel result is unavailable" });
        }
        return json(response, 200, { ok: true, result: durableResult });
      }
      if (request.method === "GET" && url.pathname.startsWith("/jobs/")) {
        const id = decodeURIComponent(url.pathname.slice("/jobs/".length));
        const job = await supervisor.get(id);
        return job ? json(response, 200, job) : json(response, 404, { ok: false, error: "job not found" });
      }
      if (request.method === "POST" && url.pathname === "/jobs") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const submission = await submitDurableJob(body, request.headers["idempotency-key"] as string | undefined);
        return json(response, submission.status, submission.payload);
      }
      if (request.method === "POST" && url.pathname.startsWith("/jobs/") && url.pathname.endsWith("/cancel")) {
        const id = decodeURIComponent(url.pathname.slice("/jobs/".length, -"/cancel".length));
        for (const approval of approvalStore.list()) {
          if (approval.runId === id && approval.id) approvalStore.revoke(approval.id);
        }
        return json(response, 200, { ok: true, job: await supervisor.cancel(id) });
      }
      if (request.method === "GET" && url.pathname === "/audit") {
        return json(response, 200, await auditStore.readAll());
      }
      if (request.method === "GET" && url.pathname === "/audit/query") {
        return json(response, 200, queryAuditEvents(await auditStore.readAll(), url));
      }
      if (request.method === "GET" && url.pathname === "/audit/verify") {
        return json(response, 200, await auditStore.verifyIntegrity());
      }
      if (request.method === "GET" && url.pathname === "/usage") {
        const events = await auditStore.readAll();
        const runs = await auditStore.readRuns();
        const summary = summarizeAuditEvents(events);
        const days = [];
        for (let offset = 13; offset >= 0; offset -= 1) {
          const day = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
          const dayEvents = events.filter((event: any) => String(event.at || "").startsWith(day));
          days.push({ day, events: dayEvents.length, tokens: dayEvents.reduce((sum: number, event: any) => sum + auditEventTokens(event), 0) });
        }
        return json(response, 200, { summary, days, runs: runs.filter((run: any) => ["model.chat", "agent.run"].includes(run.tool)).slice(0, 25) });
      }
      if (request.method === "GET" && url.pathname === "/tasks") {
        const includeSystem = url.searchParams.get("includeSystem") === "true";
        const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
        const pageSize = Math.min(100, Math.max(5, Number.parseInt(url.searchParams.get("pageSize") ?? "25", 10) || 25));
        const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
        const status = String(url.searchParams.get("status") || "all");
        const category = String(url.searchParams.get("category") || "all");
        const [runs, events, jobs] = await Promise.all([auditStore.readRuns(), auditStore.readAll(), supervisor.list()]);
        const allTasks = summarizeTasks(runs, events, jobs, registry, includeSystem);
        const filtered = allTasks
          .filter((task: any) => taskStatusMatches(task.status, status))
          .filter((task: any) => category === "all" || task.category === category)
          .filter((task: any) => !query || [task.title, task.tool, task.message, task.actor, task.category].some((value) => String(value || "").toLowerCase().includes(query)))
          .sort((left: any, right: any) =>
            String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
            || String(right.id || "").localeCompare(String(left.id || "")));
        const total = filtered.length;
        const pages = Math.max(1, Math.ceil(total / pageSize));
        const currentPage = Math.min(page, pages);
        const offset = (currentPage - 1) * pageSize;
        const tasks = filtered.slice(offset, offset + pageSize).map(({ events: _events, ...task }: any) => task);
        return json(response, 200, {
          tasks,
          summary: {
            total,
            running: filtered.filter((task: any) => ["queued", "running", "cancelling", "awaiting_approval"].includes(task.status)).length,
            completed: filtered.filter((task: any) => task.status === "completed").length,
            needsReview: filtered.filter((task: any) => ["failed", "denied", "blocked", "cancelled", "needs-review"].includes(task.status)).length
          },
          pagination: {
            page: currentPage,
            pageSize,
            pages,
            total,
            from: total ? offset + 1 : 0,
            to: Math.min(offset + pageSize, total)
          }
        });
      }
      if (request.method === "GET" && url.pathname.startsWith("/tasks/")) {
        const id = decodeURIComponent(url.pathname.slice("/tasks/".length));
        const [run, job] = await Promise.all([auditStore.readRun(id), supervisor.get(id)]);
        if (!run && !job) return json(response, 404, { ok: false, error: "task not found" });
        const tasks = summarizeTasks(run ? [run] : [], run?.events || [], job ? [job] : [], registry, true);
        const ledger = runtime.ledger.getRun(id);
        return json(response, 200, { task: tasks[0] ?? job, run, job, ledger });
      }
      if (request.method === "GET" && url.pathname === "/events") {
        return streamAuditEvents(request, response, auditStore, url);
      }
      if (request.method === "POST" && url.pathname === "/events/ack") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const subscriber = String(body.subscriber ?? "").trim();
        const sequence = Number(body.sequence);
        if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(subscriber)) throw new GatewayError(400, "audit subscriber id is invalid");
        if (!Number.isSafeInteger(sequence) || sequence < 0) throw new GatewayError(400, "audit subscriber sequence is invalid");
        try { await auditStore.ackCursor(subscriber, sequence); }
        catch (error: any) { throw new GatewayError(409, error?.message || "audit subscriber cursor could not be acknowledged"); }
        return json(response, 200, { ok: true, subscriber, sequence: await auditStore.getCursor(subscriber) });
      }
      if (request.method === "GET" && url.pathname === "/approvals") {
        return json(response, 200, validatePendingApprovalSummariesV1(await listGatewayApprovals()));
      }
      if (request.method === "POST" && url.pathname.startsWith("/approvals/") && url.pathname.endsWith("/approve")) {
        const id = decodeURIComponent(url.pathname.slice("/approvals/".length, -"/approve".length));
        const preview = (await listGatewayApprovals()).find((approval: any) => approval.id === id);
        const approved = await approveGatewayApproval(id);
        return json(response, 200, preview?.type === "skill-lifecycle"
          ? { ok: true, ...approved }
          : approved.result);
      }
      if (request.method === "POST" && url.pathname.startsWith("/approvals/") && url.pathname.endsWith("/deny")) {
        const id = decodeURIComponent(url.pathname.slice("/approvals/".length, -"/deny".length));
        return json(response, 200, { ok: true, ...(await denyGatewayApproval(id)) });
      }
      if (request.method === "GET" && url.pathname === "/memory") {
        const query = url.searchParams.get("query") ?? "";
        const kind = url.searchParams.get("kind") ?? "";
        const subject = url.searchParams.get("subject") ?? "";
        const scopeType = url.searchParams.get("scopeType") ?? "";
        const scopeId = url.searchParams.get("scopeId") ?? "";
        const projectId = url.searchParams.get("projectId") ?? "";
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "memory.search", input: { query, kind, subject, scopeType, scopeId, projectId, sessionId, limit }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "GET" && url.pathname === "/memory/recall") {
        const query = url.searchParams.get("query") ?? "";
        const kind = url.searchParams.get("kind") ?? "";
        const projectId = url.searchParams.get("projectId") ?? "";
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "8", 10);
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "memory.recall", input: { query, kind, projectId, sessionId, limit }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "GET" && url.pathname === "/memory/browse") {
        const namespace = url.searchParams.get("namespace") ?? "";
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "memory.browse", input: { namespace, limit }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "GET" && url.pathname === "/memory/status") {
        const allows = (toolName: string, input: any = {}) => evaluateTaskPolicy({
          policy,
          request: { tool: toolName, input },
          tool: registry.get(toolName)
        }).allowed;
        const agentRun = allows("agent.run");
        const readAllowed = ["memory.curate", "memory.search", "memory.browse", "memory.open", "memory.candidates"].every((toolName) => allows(toolName));
        const writeAllowed = ["memory.remember", "memory.correct", "memory.forget", "memory.suggest", "memory.decide"].every((toolName) => allows(toolName));
        const integration = {
          agentRun,
          readAllowed,
          writeAllowed,
          recallAllowed: allows("memory.recall"),
          compactAllowed: allows("memory.compact"),
          autoRecall: agentRun && allows("memory.recall") && config.memory?.autoRecall !== false,
          autoLearn: agentRun && allows("memory.suggest") && config.memory?.autoLearn !== false,
          autoCompact: agentRun && allows("memory.compact") && config.memory?.autoCompact !== false
        };
        if (!integration.readAllowed) return json(response, 200, { working: false, records: null, namespaces: null, latestAt: null, integration });
        const curated = await runIsolatedTask({ task: { tool: "memory.curate", input: { limit: 1000 }, actor: "gateway" }, auditStore, policy, registry });
        const records = Object.values(curated.output.kinds || {}).flat() as any[];
        const namespaces = new Set<string>();
        for (const record of records) {
          const parts = String(record.namespace || "general").split("/").filter(Boolean);
          for (let index = 1; index <= parts.length; index += 1) namespaces.add(parts.slice(0, index).join("/"));
        }
        return json(response, 200, {
          working: true,
          records: curated.output.count || 0,
          namespaces: namespaces.size,
          latestAt: records.map((record) => record.at).filter(Boolean).sort().at(-1) || null,
          integration
        });
      }
      if (request.method === "GET" && url.pathname.startsWith("/memory/") && !["/memory/recall", "/memory/browse", "/memory/curated", "/memory/status", "/memory/candidates"].includes(url.pathname)) {
        const id = decodeURIComponent(url.pathname.slice("/memory/".length));
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "memory.open", input: { id }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname === "/memory/compact") {
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "memory.compact", input: await readJson(request, { maxBytes: requestMaxBytes }), actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "GET" && url.pathname === "/memory/curated") {
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "memory.curate", input: {}, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "GET" && url.pathname === "/memory/candidates") {
        const status = url.searchParams.get("status") ?? "pending";
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "memory.candidates", input: { status, limit }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname.startsWith("/memory/candidates/") && url.pathname.endsWith("/decision")) {
        const candidateId = decodeURIComponent(url.pathname.slice("/memory/candidates/".length, -"/decision".length));
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "memory.decide", input: { ...body, candidateId }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname === "/memory") {
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "memory.remember", input: await readJson(request, { maxBytes: requestMaxBytes }), actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname === "/memory/corrections") {
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "memory.correct", input: await readJson(request, { maxBytes: requestMaxBytes }), actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname.startsWith("/memory/") && url.pathname.endsWith("/forget")) {
        const targetId = decodeURIComponent(url.pathname.slice("/memory/".length, -"/forget".length));
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "memory.forget", input: { ...body, targetId }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname === "/sessions") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, (await runIsolatedTask({
          task: {
            tool: "session.create",
            input: { ...body, actor: tenantScope.principalId },
            actor: "gateway"
          },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "PATCH" && url.pathname.startsWith("/sessions/")) {
        const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "session.update", input: { ...body, sessionId: id }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/sessions/")) {
        const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "session.delete", input: { sessionId: id }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "GET" && url.pathname.startsWith("/sessions/")) {
        const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "session.read", input: { sessionId: id }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname.startsWith("/sessions/") && url.pathname.endsWith("/messages")) {
        const id = decodeURIComponent(url.pathname.slice("/sessions/".length, -"/messages".length));
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "session.message", input: { ...(await readJson(request, { maxBytes: requestMaxBytes })), sessionId: id }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "GET" && url.pathname === "/goals") {
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
        const projectId = url.searchParams.get("projectId") ?? "";
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const status = url.searchParams.get("status") ?? "";
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "goal.list", input: { limit, projectId, sessionId, status }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname === "/goals") {
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "goal.create", input: await readJson(request, { maxBytes: requestMaxBytes }), actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname.startsWith("/goals/") && url.pathname.endsWith("/updates")) {
        const id = decodeURIComponent(url.pathname.slice("/goals/".length, -"/updates".length));
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "goal.update", input: { ...(await readJson(request, { maxBytes: requestMaxBytes })), goalId: id }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "GET" && url.pathname === "/projects") {
        const includeArchived = url.searchParams.get("includeArchived") === "true";
        return json(response, 200, (await runIsolatedTask({ task: { tool: "project.list", input: { includeArchived, limit: 100 }, actor: "gateway" }, auditStore, policy, registry })).output);
      }
      if (request.method === "POST" && url.pathname === "/projects") {
        return json(response, 200, (await runIsolatedTask({ task: { tool: "project.create", input: await readJson(request, { maxBytes: requestMaxBytes }), actor: "gateway" }, auditStore, policy, registry })).output);
      }
      if (request.method === "PATCH" && url.pathname.startsWith("/projects/")) {
        const id = decodeURIComponent(url.pathname.slice("/projects/".length));
        return json(response, 200, (await runIsolatedTask({ task: { tool: "project.update", input: { ...(await readJson(request, { maxBytes: requestMaxBytes })), projectId: id }, actor: "gateway" }, auditStore, policy, registry })).output);
      }
      if (request.method === "GET" && url.pathname === "/improvements") {
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
        return json(response, 200, (await runControlTask({ tool: "improve.list", input: { limit }, actor: "gateway" })).output);
      }
      if (request.method === "POST" && url.pathname === "/improvements") {
        return json(response, 200, (await runControlTask({ tool: "improve.propose", input: await readJson(request, { maxBytes: requestMaxBytes }), actor: "gateway" })).output);
      }
      if (request.method === "POST" && url.pathname === "/improvements/learn") {
        return json(response, 200, (await runControlTask({ tool: "improve.learn", input: await readJson(request, { maxBytes: requestMaxBytes }), actor: "gateway" })).output);
      }
      if (request.method === "POST" && url.pathname.startsWith("/improvements/") && url.pathname.endsWith("/decisions")) {
        const id = decodeURIComponent(url.pathname.slice("/improvements/".length, -"/decisions".length));
        return json(response, 200, (await runControlTask({
          tool: "improve.decide",
          input: { ...(await readJson(request, { maxBytes: requestMaxBytes })), improvementId: id },
          actor: "gateway"
        })).output);
      }
      if (request.method === "POST" && url.pathname.startsWith("/improvements/") && url.pathname.endsWith("/rollback")) {
        const id = decodeURIComponent(url.pathname.slice("/improvements/".length, -"/rollback".length));
        return json(response, 200, (await runControlTask({
          tool: "improve.rollback",
          input: { improvementId: id, source: "gateway" },
          actor: "gateway"
        })).output);
      }
      if (request.method === "POST" && url.pathname === "/run/stream") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        quotaGate.checkTool(body.tool);
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        });
        const controller = new AbortController();
        request.once("aborted", () => controller.abort(new Error("client disconnected")));
        response.once("close", () => { if (!response.writableEnded) controller.abort(new Error("client disconnected")); });
        const sendEvent = (event: string, value: any) => response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
        try {
          const result = await executeTask({
            task: scopeTask({ id: body.id ?? request.headers["idempotency-key"], tool: body.tool, input: body.input, reason: body.reason, actor: "gateway" }, tenantScope),
            auditStore,
            policy,
            registry,
            signal: controller.signal,
            runLedger: runtime.ledger,
            onModelDelta: (delta: string) => sendEvent("delta", { delta }),
            onAgentProgress: (progress: any) => sendEvent("progress", progress)
          });
          quotaGate.recordUsage(body.tool, result.output?.usage);
          sendEvent("result", result);
        } catch (error) {
          sendEvent("error", publicError(error, requestId));
        } finally {
          response.end();
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/run") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        quotaGate.checkTool(body.tool);
        const result = await runIsolatedTask({
          task: { id: body.id ?? request.headers["idempotency-key"], tool: body.tool, input: body.input, reason: body.reason, actor: "gateway" },
          auditStore,
          policy,
          registry
        });
        quotaGate.recordUsage(body.tool, result.output?.usage);
        return json(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/plan") {
        const plan = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, await isolatedTaskExecutor({
          plan: { ...plan, id: plan.id ?? request.headers["idempotency-key"], actor: "gateway" }
        }));
      }
      return json(response, 404, { ok: false, error: "not found" });
    } catch (error: any) {
      await testHooks?.onRequestError?.({ pathname: String(request.url ?? "/").split("?", 1)[0], error });
      return json(response, error.status ?? 400, publicError(error, requestId));
    }
  });

  const close = server.close.bind(server);
  server.close = (callback: any) => {
    if (improvementStartupTimer) clearTimeout(improvementStartupTimer);
    if (improvementTimer) clearInterval(improvementTimer);
    clearInterval(cronTimer);
    if (eventHeartbeatTimer) clearInterval(eventHeartbeatTimer);
    Promise.allSettled([channelSupervisor.stop(), supervisor.shutdown(), workflowRuntime?.shutdown(), eventIngress?.shutdown(), isolatedTaskExecutor.shutdown?.(), mcpRuntime?.close()])
      .then(() => {
        let registryError: unknown;
        try { registry.close(); } catch (error) { registryError = error; }
        try { governedRegistry.close(); } catch (error) { registryError ??= error; }
        try { auditStore.close?.(); } catch (error) { registryError ??= error; }
        try { contextRecords?.close?.(); } catch (error) { registryError ??= error; }
        try { channelResultRecords.close(); } catch (error) { registryError ??= error; }
        try { operatorReadStore.close(); } catch (error) { registryError ??= error; }
        close((serverError: unknown) => callback?.(serverError ?? registryError));
      })
      .catch((error: any) => callback?.(error));
    return server;
  };
  server.on("close", () => supervisor.shutdown().catch(() => undefined));
  server.on("close", () => runtime.ledger.close());
  server.on("listening", () => {
    const address = server.address();
    if (!address || typeof address === "string") return;
    channelSupervisor.start(`http://127.0.0.1:${address.port}`).catch(() => undefined);
  });
  server.odinnAuthToken = gatewayToken;
  return server;
}

export function createGatewaySessionListPort({ execute, auditStore, policy, registry }: any) {
  return {
    readSessions: async (input: any, _context: any, options: { signal?: AbortSignal } = {}) => (await execute({
      task: { tool: "session.list", input, actor: "gateway" },
      auditStore,
      policy,
      registry
    }, options.signal ? { signal: options.signal } : undefined)).output
  };
}

async function loadGatewayToken(state: any) {
  const path = join(state, "gateway.token");
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(state, { recursive: true });
  const token = randomBytes(32).toString("base64url");
  await writeFile(path, `${token}\n`, { flag: "wx", mode: 0o600 }).catch(async (error: any) => {
    if (error?.code !== "EEXIST") throw error;
  });
  await chmod(path, 0o600);
  return (await readFile(path, "utf8")).trim();
}

function hashRequest(value: any) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

const CHANNEL_RESULT_MAX_BYTES = 1_000_000;

function durableChannelResultBinding(job: any, scope: GatewayTenantScope) {
  const payload = job?.payload;
  const task = payload?.task;
  const input = task?.input;
  const persistedScope = payload?.scope;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || payload.executionKey !== job.id
    || !task || typeof task !== "object" || Array.isArray(task)
    || task.tool !== "agent.run"
    || !input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  const requestHash = typeof job.requestHash === "string" ? job.requestHash : "";
  const tenantId = typeof persistedScope?.tenantId === "string" ? persistedScope.tenantId : "";
  const principalId = typeof persistedScope?.principalId === "string" ? persistedScope.principalId : "";
  if (!sessionId || Buffer.byteLength(sessionId, "utf8") > 256
    || typeof job.id !== "string" || !job.id || Buffer.byteLength(job.id, "utf8") > 512
    || !/^[a-f0-9]{64}$/u.test(requestHash)
    || tenantId !== scope.tenantId || principalId !== scope.principalId) {
    throw new Error("durable channel result binding is invalid");
  }
  return {
    recordId: `channel_result_${hashRequest({ jobId: job.id, requestHash })}`,
    jobId: job.id,
    idempotencyKey: job.id,
    conversationId: job.id,
    sessionId,
    requestHash,
    tenantId,
    principalId
  };
}

function boundedDurableChannelResult(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("channel result must be an object");
  const output = (result as Record<string, unknown>).output;
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("channel result output must be an object");
  const source = output as Record<string, unknown>;
  const content = typeof source.content === "string" ? source.content : "";
  if (!content || Buffer.byteLength(content, "utf8") > CHANNEL_RESULT_MAX_BYTES) throw new Error("channel result content is invalid or exceeds its durable limit");
  const projectedOutput: Record<string, unknown> = { content };
  for (const key of ["provider", "model"] as const) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 256) throw new Error(`channel result ${key} is invalid`);
    projectedOutput[key] = value;
  }
  const projected = { output: projectedOutput };
  const encoded = stableJson(projected);
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > CHANNEL_RESULT_MAX_BYTES) throw new Error("channel result exceeds its durable limit");
  return {
    projected,
    digest: hashRequest(projected),
    bytes,
    contentDigest: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    contentBytes: Buffer.byteLength(content, "utf8")
  };
}

function assertDurableChannelResultRecord(record: any, binding: ReturnType<typeof durableChannelResultBinding>, job: any) {
  if (!binding || !record || typeof record !== "object" || Array.isArray(record)
    || record.type !== "channel.result.persisted"
    || record.id !== binding.recordId
    || record.jobId !== binding.jobId
    || record.idempotencyKey !== binding.idempotencyKey
    || record.conversationId !== binding.conversationId
    || record.sessionId !== binding.sessionId
    || record.requestHash !== binding.requestHash
    || record.tenantId !== binding.tenantId
    || record.principalId !== binding.principalId) {
    throw new Error("durable channel result record binding does not match its job");
  }
  const normalized = boundedDurableChannelResult(record.result);
  if (record.resultDigest !== normalized.digest || record.resultBytes !== normalized.bytes) {
    throw new Error("durable channel result record failed integrity verification");
  }
  const projectedOutput = job?.result?.output;
  const projectedOutputIsObject = Boolean(projectedOutput
    && typeof projectedOutput === "object"
    && !Array.isArray(projectedOutput));
  const projectedRecord = projectedOutputIsObject
    ? projectedOutput as Record<string, unknown>
    : undefined;
  const hasContentDigest = projectedRecord
    ? Object.prototype.hasOwnProperty.call(projectedRecord, "contentDigest")
    : false;
  const hasContentBytes = projectedRecord
    ? Object.prototype.hasOwnProperty.call(projectedRecord, "contentBytes")
    : false;
  // A running approval continuation can legitimately retain the earlier
  // non-terminal approval projection (`output: {}`). Once a job is public and
  // terminal, or either terminal binding field is present, the projection must
  // contain the complete exact digest/length pair for this protected record.
  if (job?.status === "completed" || hasContentDigest || hasContentBytes) {
    if (!projectedRecord
      || !hasContentDigest
      || !hasContentBytes
      || projectedRecord.contentDigest !== normalized.contentDigest
      || projectedRecord.contentBytes !== normalized.contentBytes) {
      throw new Error("durable channel result does not match the terminal job projection");
    }
  }
  return normalized.projected;
}

async function persistDurableChannelResult(store: SqliteRecordStore, job: any, result: unknown, scope: GatewayTenantScope) {
  const binding = durableChannelResultBinding(job, scope);
  if (!binding) return;
  const normalized = boundedDurableChannelResult(result);
  const existing = await store.findById(binding.recordId);
  if (existing) {
    const persisted = assertDurableChannelResultRecord(existing, binding, job);
    if (hashRequest(persisted) !== normalized.digest) throw new Error("durable channel result changed for the same execution");
    return;
  }
  await store.append({
    id: binding.recordId,
    type: "channel.result.persisted",
    status: "completed",
    ...binding,
    resultDigest: normalized.digest,
    resultBytes: normalized.bytes,
    result: normalized.projected
  });
}

async function readDurableChannelResult(store: SqliteRecordStore, job: any, scope: GatewayTenantScope) {
  const binding = durableChannelResultBinding(job, scope);
  if (!binding) return undefined;
  const record = await store.findById(binding.recordId);
  return record ? assertDurableChannelResultRecord(record, binding, job) : undefined;
}

async function recoverPersistedChannelResults(store: SqliteJobStore, records: SqliteRecordStore, scope: GatewayTenantScope) {
  for (const status of ["running", "cancelling", "completed"] as const) {
    const page = await store.queryJobs({ status, limit: 100_000 });
    for (const job of page.items) {
      const listedTask = job.payload?.task;
      const listedChannelShaped = job.payload?.executionKey === job.id
        && listedTask && typeof listedTask === "object" && !Array.isArray(listedTask)
        && (listedTask as Record<string, unknown>).tool === "agent.run";
      if (!listedChannelShaped) continue;
      const snapshot = await store.getProtectedResultSnapshot(job.id);
      if (!snapshot) continue;
      const task = snapshot.payload?.task;
      const channelShaped = snapshot.payload?.executionKey === snapshot.id
        && task && typeof task === "object" && !Array.isArray(task)
        && (task as Record<string, unknown>).tool === "agent.run";
      if (!channelShaped) continue;
      let result: unknown;
      let integrityError: unknown;
      try { result = await readDurableChannelResult(records, snapshot, scope); }
      catch (error) { integrityError = error; }
      const attempt = snapshot.executionAttemptId
        ? store.ledger.getExecutionAttempt(snapshot.executionAttemptId)
        : undefined;
      if (integrityError || (result === undefined && attempt?.state === "completed")) {
        await store.update(snapshot.id, {
          status: "needs-review",
          completedAt: new Date().toISOString(),
          error: integrityError
            ? "protected channel result failed integrity verification"
            : "protected channel result is unavailable after completed execution",
          expectedLeaseToken: snapshot.dispatchLease?.token,
          dispatchLease: undefined
        });
        continue;
      }
      if (result === undefined) continue;
      if (snapshot.status === "completed") continue;
      await store.adoptProtectedResult(snapshot.id, {
        result,
        expected: snapshot,
        source: "recovery"
      });
    }
  }
}

function scopeTask(task: any, scope: GatewayTenantScope): any {
  if (!task || typeof task !== "object" || Array.isArray(task)) throw new GatewayError(400, "task must be an object");
  const existingTenantId = task.tenantId ?? task.scope?.tenantId;
  if (existingTenantId !== undefined) {
    try { assertTenantClaims({ tenantId: existingTenantId }, scope, "task"); }
    catch (error) { throw new GatewayError(403, error instanceof Error ? error.message : "task tenant scope is invalid"); }
  }
  return {
    ...task,
    actor: scope.hosted ? scope.principalId : task.actor || "gateway",
    scope: {
      ...(task.scope && typeof task.scope === "object" && !Array.isArray(task.scope) ? task.scope : {}),
      tenantId: scope.tenantId,
      principalId: scope.principalId,
    },
  };
}

function scopeTaskRequest(request: any, scope: GatewayTenantScope): any {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new GatewayError(400, "task request must be an object");
  if (request.task) return { ...request, task: scopeTask(request.task, scope) };
  if (request.plan && typeof request.plan === "object" && !Array.isArray(request.plan)) {
    return {
      ...request,
      plan: {
        ...request.plan,
        actor: scope.hosted ? scope.principalId : request.plan.actor || "gateway",
        scope: { tenantId: scope.tenantId, principalId: scope.principalId },
      },
    };
  }
  throw new GatewayError(400, "task request must contain a task or plan");
}

function stableJson(value: any): any {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key: any) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function safeCapsulePath(state: any, candidate: any) {
  const capsulesRoot = resolve(join(state, "capsules"));
  const target = resolve(capsulesRoot, candidate);
  if (target !== capsulesRoot && !target.startsWith(`${capsulesRoot}${sep}`)) {
    throw new GatewayError(400, "capsule paths must remain inside the gateway capsule store");
  }
  return target;
}

async function streamAuditEvents(request: any, response: any, auditStore: any, url: any) {
  const subscriber = String(url.searchParams.get("subscriber") ?? "").trim().slice(0, 200);
  if (subscriber && !/^[A-Za-z0-9._:-]{1,128}$/u.test(subscriber)) throw new GatewayError(400, "audit subscriber id is invalid");
  const initial = Number.parseInt(request.headers["last-event-id"] ?? url.searchParams.get("since") ?? "0", 10);
  let cursor = Number.isFinite(initial) ? Math.max(0, initial) : 0;
  if (subscriber && auditStore.getCursor) cursor = Math.max(cursor, await auditStore.getCursor(subscriber));
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-content-type-options": "nosniff"
  });
  response.write("retry: 1000\n\n");
  let draining = false;
  let pending = true;
  let closed = false;
  const drain = async () => {
    if (draining || closed) { pending = true; return; }
    draining = true;
    try {
      do {
        pending = false;
        const page = await auditStore.readPage({ afterSequence: cursor, limit: 500 });
        for (const item of page) {
          if (closed) return;
          if (!response.write(`id: ${item.sequence}\ndata: ${JSON.stringify(item.event)}\n\n`)) {
            await new Promise<void>((resolve) => { response.once("drain", resolve); request.once("close", resolve); });
          }
          if (closed) return;
          cursor = item.sequence;
        }
        if (page.length === 500) pending = true;
      } while (pending && !closed);
    } catch (error: any) {
      response.write(`event: error\ndata: ${JSON.stringify(publicError(error, String(request.headers["x-odinn-request-id"] || "audit-stream")))}\n\n`);
    } finally {
      draining = false;
      if (pending && !closed) void drain();
    }
  };
  const unsubscribe = auditStore.subscribe(() => { pending = true; void drain(); });
  const heartbeat = setInterval(() => { if (!closed) { response.write(": keepalive\n\n"); pending = true; void drain(); } }, 15_000);
  request.on("close", () => { closed = true; clearInterval(heartbeat); unsubscribe(); });
  await drain();
}

const HOSTED_PROVIDER_ENDPOINTS = new Set<string>();
const HOSTED_PROVIDER_ENV_NAMES = new Set<string>();
const HOSTED_PROVIDER_AUTH_URLS = new Set<string>();
for (const preset of Object.values(PROVIDER_PRESETS) as any[]) {
  for (const value of [preset.baseUrl, preset.oauth?.baseUrl]) {
    const normalized = normalizeHostedProviderUrl(value);
    if (normalized && !isPrivateHostedProviderUrl(normalized)) HOSTED_PROVIDER_ENDPOINTS.add(normalized);
  }
  for (const value of [preset.apiKeyEnv, preset.oauth?.auth?.clientIdEnv, preset.oauth?.auth?.clientSecretEnv, preset.auth?.clientIdEnv, preset.auth?.clientSecretEnv]) {
    if (typeof value === "string" && value.trim()) HOSTED_PROVIDER_ENV_NAMES.add(value.trim());
  }
  for (const auth of [preset.oauth?.auth, preset.auth]) {
    for (const value of [auth?.authorizationUrl, auth?.tokenUrl]) {
      const normalized = normalizeHostedProviderUrl(value);
      if (normalized) HOSTED_PROVIDER_AUTH_URLS.add(normalized);
    }
  }
}

function normalizeHostedProviderUrl(value: any) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const parsed = new URL(value.trim());
    if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password || parsed.hash) return "";
    return parsed.href.replace(/\/+$/u, "");
  } catch {
    return "";
  }
}

function isPrivateHostedProviderUrl(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.)/u.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host) || host === "::1";
  } catch {
    return true;
  }
}

function validateHostedProviderConfig(config: any) {
  try { assertHostedSandboxConfig(config); }
  catch (error) { throw new GatewayError(400, error instanceof Error ? error.message : "hosted sandbox configuration is invalid"); }
  if (Object.values(config?.channels ?? {}).some((channel: any) => channel?.enabled === true)) {
    throw new GatewayError(400, "multi-user host does not allow messaging channels");
  }
  if (config?.integrations?.github?.enabled === true) {
    throw new GatewayError(400, "multi-user host does not allow a shared GitHub read credential");
  }
  if (config?.integrations?.microsoftGraph?.enabled === true) {
    throw new GatewayError(400, "multi-user host does not allow a shared Microsoft Graph read credential");
  }
  for (const [name, provider] of Object.entries(config?.providers ?? {}) as Array<[string, any]>) {
    const auth = provider?.auth && typeof provider.auth === "object" && !Array.isArray(provider.auth) ? provider.auth : {};
    if (provider?.type === "cli" || String(provider?.transport ?? "").startsWith("cli-") || auth.mode === "cli") {
      throw new GatewayError(400, `multi-user host does not allow CLI provider ${name}`);
    }
    if (provider?.baseUrl) {
      const baseUrl = normalizeHostedProviderUrl(provider.baseUrl);
      if (!baseUrl || !HOSTED_PROVIDER_ENDPOINTS.has(baseUrl)) {
        throw new GatewayError(400, `multi-user host only permits approved provider endpoints: ${name}`);
      }
    }
    for (const [label, value] of [["apiKeyEnv", provider?.apiKeyEnv], ["clientIdEnv", auth.clientIdEnv], ["clientSecretEnv", auth.clientSecretEnv]] as Array<[string, any]>) {
      if (value && !HOSTED_PROVIDER_ENV_NAMES.has(String(value).trim())) {
        throw new GatewayError(400, `multi-user host does not allow custom provider credential environment variable: ${label}`);
      }
    }
    for (const [label, value] of [["authorizationUrl", auth.authorizationUrl], ["tokenUrl", auth.tokenUrl]] as Array<[string, any]>) {
      if (value && !HOSTED_PROVIDER_AUTH_URLS.has(normalizeHostedProviderUrl(value))) {
        throw new GatewayError(400, `multi-user host does not allow custom provider ${label}`);
      }
    }
  }
}

async function readConfig(state: any, { hosted = false }: any = {}) {
  const path = join(state, "config.json");
  try {
    const config = JSON.parse(await readFile(path, "utf8"));
    validateGatewayConfig(config);
    if (hosted) validateHostedProviderConfig(config);
    await chmod(path, 0o600);
    return config;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    return withStateMutationLock(state, async () => {
      try {
        const existing = JSON.parse(await readFile(path, "utf8"));
        validateGatewayConfig(existing);
        if (hosted) validateHostedProviderConfig(existing);
        await chmod(path, 0o600);
        return existing;
      } catch (readError: any) {
        if (readError?.code !== "ENOENT") throw readError;
      }
      await mkdir(state, { recursive: true });
      const config = { version: 1, policy: createDefaultPolicy(), auditLog: "audit.jsonl", providers: {}, channels: {}, plugins: { entries: {} }, defaultModel: "", experimental: { capabilities: false, capsules: false, counterfactual: false }, runtime: { enableAgentGraphs: false, enableProgressiveSkills: false, enableSkillLifecycle: false, enableMcp: false, enableDurableWorkflows: false, enableEventIngress: false, enableProjectContext: false }, mcp: { servers: {} }, selfImprovement: normalizeSelfImprovementConfig(), sandbox: DEFAULT_SANDBOX_CONFIG };
      await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await chmod(path, 0o600);
      return config;
    });
  }
}

function assertConfigObject(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError(400, "config must be a JSON object");
  }
}

function assertConfigRecord(value: any, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError(400, `${label} must be a JSON object`);
  }
}

function assertConfigStringArray(value: any, label: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new GatewayError(400, `${label} must be an array of strings`);
  }
}

function assertOptionalConfigBoolean(record: any, key: string, label: string) {
  if (record[key] !== undefined && typeof record[key] !== "boolean") {
    throw new GatewayError(400, `${label}.${key} must be true or false`);
  }
}

function validateDiscordGuildConfig(value: any, label: string) {
  assertConfigRecord(value, label);
  for (const [guildId, guild] of Object.entries(value) as Array<[string, any]>) {
    if (!/^\d{1,20}$/u.test(guildId)) throw new GatewayError(400, `${label} contains an invalid guild id`);
    assertConfigRecord(guild, `${label}.${guildId}`);
    assertOptionalConfigBoolean(guild, "requireMention", `${label}.${guildId}`);
    for (const key of ["users", "roles"]) {
      if (guild[key] !== undefined) assertConfigStringArray(guild[key], `${label}.${guildId}.${key}`);
    }
    if (guild.channels === undefined) continue;
    assertConfigRecord(guild.channels, `${label}.${guildId}.channels`);
    for (const [channelId, channel] of Object.entries(guild.channels) as Array<[string, any]>) {
      if (!/^\d{1,20}$/u.test(channelId)) throw new GatewayError(400, `${label}.${guildId}.channels contains an invalid channel id`);
      assertConfigRecord(channel, `${label}.${guildId}.channels.${channelId}`);
      assertOptionalConfigBoolean(channel, "enabled", `${label}.${guildId}.channels.${channelId}`);
      assertOptionalConfigBoolean(channel, "requireMention", `${label}.${guildId}.channels.${channelId}`);
      for (const key of ["users", "roles"]) {
        if (channel[key] !== undefined) assertConfigStringArray(channel[key], `${label}.${guildId}.channels.${channelId}.${key}`);
      }
    }
  }
}

function validateGatewayConfig(config: any) {
  assertConfigObject(config);
  try { normalizeSandboxConfig(config); }
  catch (error) { throw new GatewayError(400, error instanceof Error ? error.message : "config.sandbox is invalid"); }
  if (config.version !== undefined && config.version !== 1) {
    throw new GatewayError(400, "config.version must be 1");
  }
  if (config.auditLog !== undefined && (typeof config.auditLog !== "string" || !/^(?:audit|audit[-_.][a-z0-9][a-z0-9._-]{0,110})\.jsonl$/i.test(config.auditLog))) {
    throw new GatewayError(400, "config.auditLog must be audit.jsonl or an audit-*.jsonl filename");
  }
  if (config.defaultModel !== undefined && typeof config.defaultModel !== "string") {
    throw new GatewayError(400, "config.defaultModel must be a string");
  }
  if (config.runtime !== undefined) {
    assertConfigRecord(config.runtime, "config.runtime");
    assertOptionalConfigBoolean(config.runtime, "enableAgentGraphs", "config.runtime");
    assertOptionalConfigBoolean(config.runtime, "enableProgressiveSkills", "config.runtime");
    assertOptionalConfigBoolean(config.runtime, "enableSkillLifecycle", "config.runtime");
    assertOptionalConfigBoolean(config.runtime, "enableMcp", "config.runtime");
    assertOptionalConfigBoolean(config.runtime, "enableDurableWorkflows", "config.runtime");
    assertOptionalConfigBoolean(config.runtime, "enableEventIngress", "config.runtime");
    assertOptionalConfigBoolean(config.runtime, "enableProjectContext", "config.runtime");
  }
  if (config.integrations !== undefined) {
    assertConfigRecord(config.integrations, "config.integrations");
    if (config.integrations.github !== undefined) {
      try { normalizeGitHubReadConfig(config.integrations.github); }
      catch (error) { throw new GatewayError(400, error instanceof Error ? error.message : "config.integrations.github is invalid"); }
    }
    if (config.integrations.microsoftGraph !== undefined) {
      try { normalizeMicrosoftGraphReadConfig(config.integrations.microsoftGraph); }
      catch (error) { throw new GatewayError(400, error instanceof Error ? error.message : "config.integrations.microsoftGraph is invalid"); }
    }
  }
  try { normalizeMcpConfiguration(config.mcp); }
  catch (error) { throw new GatewayError(400, error instanceof Error ? error.message : "config.mcp is invalid"); }
  if (config.channels !== undefined) {
    assertConfigRecord(config.channels, "config.channels");
    for (const [name, channel] of Object.entries(config.channels) as Array<[string, any]>) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) throw new GatewayError(400, `config.channels contains an invalid channel name: ${name}`);
      assertConfigRecord(channel, `config.channels.${name}`);
      assertOptionalConfigBoolean(channel, "enabled", `config.channels.${name}`);
      for (const key of [
        "type", "tokenEnv", "defaultModel", "appTokenEnv", "appIdEnv", "tenantIdEnv",
        "appSecretEnv", "verifyTokenEnv", "phoneNumberId", "apiVersion"
      ]) {
        if (channel[key] !== undefined && typeof channel[key] !== "string") throw new GatewayError(400, `config.channels.${name}.${key} must be a string`);
      }
      if (channel.type !== undefined && !["telegram", "discord", "slack", "teams", "whatsapp"].includes(channel.type)) {
        throw new GatewayError(400, `config.channels.${name}.type must be telegram, discord, slack, teams, or whatsapp`);
      }
      for (const key of ["requireMention", "nativeCommands", "nativeCommandEphemeral"]) {
        assertOptionalConfigBoolean(channel, key, `config.channels.${name}`);
      }
      if (channel.historyLimit !== undefined && (!Number.isSafeInteger(channel.historyLimit) || channel.historyLimit < 1 || channel.historyLimit > 200)) {
        throw new GatewayError(400, `config.channels.${name}.historyLimit must be an integer from 1 through 200`);
      }
      if (channel.pollTimeoutSeconds !== undefined && (!Number.isSafeInteger(channel.pollTimeoutSeconds) || channel.pollTimeoutSeconds < 1 || channel.pollTimeoutSeconds > 50)) {
        throw new GatewayError(400, `config.channels.${name}.pollTimeoutSeconds must be an integer from 1 through 50`);
      }
      const nativeCommandPattern = channel.type === "slack"
        ? /^\/[a-z0-9_-]{1,31}$/u
        : channel.type === "telegram"
        ? /^[a-z][a-z0-9_]{0,31}$/u
        : /^[a-z0-9_-]{1,32}$/u;
      if (channel.nativeCommandName !== undefined && (
        typeof channel.nativeCommandName !== "string" || !nativeCommandPattern.test(channel.nativeCommandName)
      )) {
        throw new GatewayError(400, `config.channels.${name}.nativeCommandName is invalid`);
      }
      for (const key of ["dmPolicy", "groupPolicy"]) {
        if (channel[key] !== undefined && !["disabled", "allowlist", "open"].includes(channel[key])) {
          throw new GatewayError(400, `config.channels.${name}.${key} must be disabled, allowlist, or open`);
        }
      }
      if (channel.allowBots !== undefined && ![true, false, "mentions"].includes(channel.allowBots)) {
        throw new GatewayError(400, `config.channels.${name}.allowBots must be true, false, or mentions`);
      }
      if (channel.acknowledgementEmoji !== undefined) {
        assertConfigRecord(channel.acknowledgementEmoji, `config.channels.${name}.acknowledgementEmoji`);
        for (const key of ["processing", "succeeded", "failed"]) {
          if (channel.acknowledgementEmoji[key] !== undefined && typeof channel.acknowledgementEmoji[key] !== "string") {
            throw new GatewayError(400, `config.channels.${name}.acknowledgementEmoji.${key} must be a string`);
          }
        }
      }
      if (channel.guilds !== undefined) validateDiscordGuildConfig(channel.guilds, `config.channels.${name}.guilds`);
      if (channel.token !== undefined || channel.botToken !== undefined) throw new GatewayError(400, `config.channels.${name} must reference a tokenEnv instead of storing a bot token`);
      if (channel.tokenEnv !== undefined && channel.tokenEnv !== "" && !isAllowedCredentialEnvironmentKey(channel.tokenEnv)) {
        throw new GatewayError(400, `config.channels.${name}.tokenEnv must be credential-oriented and must not name a reserved runtime control`);
      }
      for (const key of ["appTokenEnv", "appIdEnv", "tenantIdEnv", "appSecretEnv", "verifyTokenEnv"]) {
        if (channel[key] !== undefined && channel[key] !== "" && !isAllowedCredentialEnvironmentKey(channel[key])) {
          throw new GatewayError(400, `config.channels.${name}.${key} must be credential-oriented and must not name a reserved runtime control`);
        }
      }
      if (channel.phoneNumberId !== undefined && channel.phoneNumberId !== "" && !/^\d{1,32}$/u.test(channel.phoneNumberId)) {
        throw new GatewayError(400, `config.channels.${name}.phoneNumberId must be numeric`);
      }
      if (channel.apiVersion !== undefined && !/^v\d+\.\d+$/u.test(channel.apiVersion)) {
        throw new GatewayError(400, `config.channels.${name}.apiVersion must look like v23.0`);
      }
      if (channel.allowlist !== undefined) assertConfigStringArray(channel.allowlist, `config.channels.${name}.allowlist`);
    }
  }
  if (config.plugins !== undefined) {
    assertConfigRecord(config.plugins, "config.plugins");
    assertConfigRecord(config.plugins.entries ?? {}, "config.plugins.entries");
    for (const [id, entry] of Object.entries(config.plugins.entries ?? {}) as Array<[string, any]>) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) throw new GatewayError(400, `config.plugins.entries contains an invalid plugin id: ${id}`);
      assertConfigRecord(entry, `config.plugins.entries.${id}`);
      assertOptionalConfigBoolean(entry, "enabled", `config.plugins.entries.${id}`);
      if (entry.config !== undefined) assertConfigRecord(entry.config, `config.plugins.entries.${id}.config`);
      if (id !== "discord" || entry.config === undefined) continue;
      const discord = entry.config;
      if (discord.accounts !== undefined) {
        assertConfigRecord(discord.accounts, "config.plugins.entries.discord.config.accounts");
        for (const [accountId, account] of Object.entries(discord.accounts) as Array<[string, any]>) {
          if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(accountId)) throw new GatewayError(400, `config.plugins.entries.discord.config.accounts contains an invalid account id: ${accountId}`);
          assertConfigRecord(account, `config.plugins.entries.discord.config.accounts.${accountId}`);
          assertOptionalConfigBoolean(account, "enabled", `config.plugins.entries.discord.config.accounts.${accountId}`);
          if (account.tokenEnv !== undefined && (typeof account.tokenEnv !== "string" || !isAllowedCredentialEnvironmentKey(account.tokenEnv))) {
            throw new GatewayError(400, `config.plugins.entries.discord.config.accounts.${accountId}.tokenEnv must be credential-oriented and must not name a reserved runtime control`);
          }
        }
      }
      if (discord.tools !== undefined) {
        assertConfigRecord(discord.tools, "config.plugins.entries.discord.config.tools");
        for (const [tool, enabled] of Object.entries(discord.tools)) {
          if (!DISCORD_CONFIGURABLE_TOOLS.has(tool) || typeof enabled !== "boolean") {
            throw new GatewayError(400, `config.plugins.entries.discord.config.tools contains an invalid tool setting: ${tool}`);
          }
        }
      }
    }
  }

  if (config.providers !== undefined) {
    assertConfigRecord(config.providers, "config.providers");
    for (const [name, provider] of Object.entries(config.providers) as Array<[string, any]>) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
        throw new GatewayError(400, `config.providers contains an invalid provider name: ${name}`);
      }
      assertConfigRecord(provider, `config.providers.${name}`);
      for (const key of ["type", "baseUrl", "apiKeyEnv", "transport"]) {
        if (provider[key] !== undefined && typeof provider[key] !== "string") {
          throw new GatewayError(400, `config.providers.${name}.${key} must be a string`);
        }
      }
      if (provider.apiKeyEnv && !isAllowedCredentialEnvironmentKey(provider.apiKeyEnv)) {
        throw new GatewayError(400, `config.providers.${name}.apiKeyEnv must be credential-oriented and must not name a reserved runtime control`);
      }
      if (provider.models !== undefined) assertConfigStringArray(provider.models, `config.providers.${name}.models`);
      if (provider.auth !== undefined) {
        assertConfigRecord(provider.auth, `config.providers.${name}.auth`);
        for (const key of ["clientIdEnv", "clientSecretEnv", "accessTokenEnv", "refreshTokenEnv"]) {
          if (provider.auth[key] !== undefined && provider.auth[key] !== "" && (
            typeof provider.auth[key] !== "string" || !isAllowedCredentialEnvironmentKey(provider.auth[key])
          )) {
            throw new GatewayError(400, `config.providers.${name}.auth.${key} must be credential-oriented and must not name a reserved runtime control`);
          }
        }
      }
    }
  }

  let normalizedModels;
  try {
    normalizedModels = normalizeModelConfig(config);
    for (const provider of Object.values(normalizedModels.providers) as any[]) {
      if (["oauth", "device"].includes(provider.auth?.mode)) oauthTokenPath(provider, ".");
    }
  } catch (error) {
    throw new GatewayError(400, error instanceof Error ? error.message : "model provider configuration is invalid");
  }

  if (config.policy !== undefined) {
    assertConfigRecord(config.policy, "config.policy");
    if (config.policy.deniedTools !== undefined) assertConfigStringArray(config.policy.deniedTools, "config.policy.deniedTools");
    if (config.policy.allowedCapabilities !== undefined) assertConfigStringArray(config.policy.allowedCapabilities, "config.policy.allowedCapabilities");
    if (config.policy.maxInputBytes !== undefined && (!Number.isSafeInteger(config.policy.maxInputBytes) || config.policy.maxInputBytes < 1)) {
      throw new GatewayError(400, "config.policy.maxInputBytes must be a positive integer");
    }
    if (config.policy.security !== undefined) {
      assertConfigRecord(config.policy.security, "config.policy.security");
      for (const surfaceName of ["web", "browser"]) {
        const surface = config.policy.security[surfaceName];
        if (surface === undefined) continue;
        assertConfigRecord(surface, `config.policy.security.${surfaceName}`);
        for (const key of ["enabled", "allowPrivateNetwork", "requireApproval", "allowDownloads", "allowUploads"]) {
          assertOptionalConfigBoolean(surface, key, `config.policy.security.${surfaceName}`);
        }
        for (const key of ["allowedDomains", "blockedDomains"]) {
          if (surface[key] !== undefined) assertConfigStringArray(surface[key], `config.policy.security.${surfaceName}.${key}`);
        }
      }
    }
    try {
      createDefaultPolicy(config.policy);
    } catch (error) {
      throw new GatewayError(400, error instanceof Error ? error.message : "config.policy capability declarations are invalid");
    }
  }

  if (config.proof !== undefined) {
    assertConfigRecord(config.proof, "config.proof");
    assertOptionalConfigBoolean(config.proof, "includeRawEvidence", "config.proof");
    if (config.proof.allowedCommands !== undefined) {
      if (!Array.isArray(config.proof.allowedCommands) || config.proof.allowedCommands.some((command: any) =>
        !Array.isArray(command) || command.length === 0 || command.some((part: any) => typeof part !== "string") || !isAbsolute(command[0]))) {
        throw new GatewayError(400, "config.proof.allowedCommands must contain exact argument arrays beginning with an absolute executable path");
      }
    }
  }

  if (config.experimental !== undefined) {
    assertConfigRecord(config.experimental, "config.experimental");
    for (const key of ["proof", "rewind", "sentinel", "capsules", "darwin", "capabilities", "counterfactual"]) {
      assertOptionalConfigBoolean(config.experimental, key, "config.experimental");
    }
    normalizeExperimentalFlags(config.experimental);
  }

  if (config.selfImprovement !== undefined) {
    assertConfigRecord(config.selfImprovement, "config.selfImprovement");
    assertOptionalConfigBoolean(config.selfImprovement, "enabled", "config.selfImprovement");
    assertOptionalConfigBoolean(config.selfImprovement, "rollbackOnFailure", "config.selfImprovement");
    if (config.selfImprovement.mode !== undefined && !["disabled", "propose", "auto"].includes(config.selfImprovement.mode)) {
      throw new GatewayError(400, "config.selfImprovement.mode must be disabled, propose, or auto");
    }
    for (const [key, minimum, maximum] of [["intervalMs", 30_000, 86_400_000], ["maxChangesPerCycle", 1, 3]] as const) {
      const value = config.selfImprovement[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > maximum)) {
        throw new GatewayError(400, `config.selfImprovement.${key} must be an integer from ${minimum} through ${maximum}`);
      }
    }
    normalizeSelfImprovementConfig(config.selfImprovement);
  }

  if (config.runtime !== undefined) {
    assertConfigRecord(config.runtime, "config.runtime");
    if (config.runtime.modelRetries !== undefined && (!Number.isSafeInteger(config.runtime.modelRetries) || config.runtime.modelRetries < 0 || config.runtime.modelRetries > 4)) {
      throw new GatewayError(400, "config.runtime.modelRetries must be an integer from 0 through 4");
    }
  }

  if (config.memory !== undefined) {
    assertConfigRecord(config.memory, "config.memory");
    for (const key of ["autoRecall", "autoLearn", "autoCompact"]) assertOptionalConfigBoolean(config.memory, key, "config.memory");
  }
}

const DISCORD_CONFIGURABLE_TOOLS = new Set([
  "discord.listChannels",
  "discord.readMessages",
  "discord.sendMessage",
  "discord.editMessage",
  "discord.deleteMessage",
  "discord.addReaction",
  "discord.removeReaction",
  "discord.listReactions",
  "discord.pinMessage",
  "discord.unpinMessage",
  "discord.listPins",
  "discord.sendPoll",
  "discord.createThread",
  "discord.listThreads",
  "discord.replyThread",
  "discord.searchMessages"
]);

function configFingerprint(contents: string | Buffer) {
  return createHash("sha256").update(contents).digest("hex");
}

function canonicalConfig(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalConfig);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalConfig(value[key])]));
}

function configsMatch(left: any, right: any) {
  const effective = (value: any) => ({ ...value, sandbox: normalizeSandboxConfig(value) });
  return JSON.stringify(canonicalConfig(effective(left))) === JSON.stringify(canonicalConfig(effective(right)));
}

async function openEditableConfigFile(path: string) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new GatewayError(409, "config.json is not a regular private file");
    }
    return handle;
  } catch (error: any) {
    await handle?.close().catch(() => undefined);
    if (error instanceof GatewayError) throw error;
    if (["ELOOP", "EMLINK"].includes(String(error?.code ?? ""))) {
      throw new GatewayError(409, "config.json must not be a symbolic link");
    }
    throw error;
  }
}

async function readEditableConfig(state: string, { hosted = false }: any = {}) {
  const path = join(state, "config.json");
  const handle = await openEditableConfigFile(path);
  let contents;
  try {
    contents = await handle.readFile("utf8");
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  let config;
  try {
    config = JSON.parse(contents);
  } catch {
    throw new GatewayError(409, "config.json is not valid JSON");
  }
  validateGatewayConfig(config);
  if (hosted) validateHostedProviderConfig(config);
  return { config, fingerprint: configFingerprint(contents) };
}

async function writeEditableConfig(state: string, input: any, { hosted = false }: any = {}) {
  validateGatewayConfig(input?.config);
  if (hosted) validateHostedProviderConfig(input?.config);
  const expectedFingerprint = String(input?.fingerprint ?? "");
  if (!/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
    throw new GatewayError(400, "a current config fingerprint is required");
  }
  const serialized = `${JSON.stringify(input.config, null, 2)}\n`;
  return withStateMutationLock(state, async () => {
    const path = join(state, "config.json");
    const handle = await openEditableConfigFile(path);
    let current;
    try {
      current = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (configFingerprint(current) !== expectedFingerprint) {
      throw new GatewayError(409, "config changed after this page loaded; reload it before saving");
    }
    const temporary = join(state, `.config.json.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return { config: input.config, fingerprint: configFingerprint(serialized) };
  });
}

async function readJson(request: any, { maxBytes = DEFAULT_REQUEST_MAX_BYTES }: any = {}) {
  const raw = (await readRequestBuffer(request, { maxBytes })).toString("utf8");
  let value: any;
  try {
    value = raw ? JSON.parse(raw) : {};
  } catch {
    throw new GatewayError(400, "request body must be valid JSON");
  }
  const scope = request?.__odinnTenantScope as GatewayTenantScope | undefined;
  if (scope) {
    try { assertTenantClaims(value, scope); }
    catch (error) { throw new GatewayError(403, error instanceof Error ? error.message : "request tenant scope is invalid"); }
  }
  return value;
}

async function readRequestBuffer(request: any, { maxBytes = DEFAULT_REQUEST_MAX_BYTES }: any = {}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new GatewayError(413, `request body exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(response: any, status: any, body: any) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function html(response: any, status: any, body: any, extraHeaders: any = {}) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders
  });
  response.end(body);
}

function image(response: any, status: any, body: any, contentType: any) {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function staticAsset(response: any, status: any, body: any, contentType: any) {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

async function summarizeProviders(config: any, state: any) {
  return Promise.all(Object.entries(config.providers ?? {}).map(async ([name, provider]: any) => {
    const support = providerSupport(name);
    return {
      name,
      displayName: support.displayName,
      supportTier: support.supportTier,
      locallyTested: support.locallyTested,
      genericCompatibilityMode: support.genericCompatibilityMode,
      modelAvailability: support.modelAvailability,
      type: provider.type ?? "openai-compatible",
      baseUrl: provider.baseUrl,
      authMode: provider.auth?.mode ?? "api-key",
      apiKeyEnv: provider.apiKeyEnv ?? "",
      models: provider.models ?? [],
      configured: provider.auth?.mode === "oauth"
        ? await oauthTokenExists(provider, state)
        : !provider.apiKeyEnv || Boolean(process.env[provider.apiKeyEnv])
    };
  }));
}

async function loadChannelPlugin(type: string) {
  switch (type) {
    case "telegram": return (await import("@odinn/channel-telegram")).telegramChannelPlugin;
    case "discord": return (await import("@odinn/channel-discord")).discordChannelPlugin;
    case "slack": return (await import("@odinn/channel-slack")).slackChannelPlugin;
    case "teams": return (await import("@odinn/channel-teams")).teamsChannelPlugin;
    case "whatsapp": return (await import("@odinn/channel-whatsapp")).whatsappChannelPlugin;
    default: throw new Error(`unsupported channel plugin: ${type}`);
  }
}

async function createChannelSupervisor({ config, state, gatewayToken, requestMaxBytes, auditStore, loadPlugin }: any) {
  const configuredEntries = Object.entries(config.channels ?? {});
  const configuredTypes = [...new Set(configuredEntries.map(([, value]: any) => String(value?.type ?? "telegram")))];
  const plugins = new ChannelPluginRegistry(await Promise.all(configuredTypes.map(loadPlugin)));
  const dedupe = new FileChannelDedupeStore(join(state, "channel-dedupe.json"));
  const configured = configuredEntries.map(([name, value]: any) => {
    const type = String(value?.type ?? "telegram");
    const plugin = plugins.get(type);
    const accountConfig = plugin.normalizeAccountConfig(name, value);
    return {
      name,
      type,
      plugin,
      config: accountConfig,
      status: {
        channel: type,
        accountId: name,
        state: "stopped",
        error: ""
      } as any,
      publicError: ""
    };
  });
  const runtimes: Array<{ adapter: any; router: ChannelRouter; healthTimer?: NodeJS.Timeout }> = [];
  const webhooks = new Map<string, { adapter: any; requestMode: "buffer" | "raw-stream" }>();
  let started = false;
  return {
    status() {
      return validateGatewayChannelDiagnosticsV1(configured.map((channel) => {
        const credentials = channelCredentialStatus(channel.config);
        return {
          name: channel.name,
          type: channel.type,
          enabled: channel.config.enabled,
          running: channel.status.state === "connected" || channel.status.state === "starting" || channel.status.state === "degraded",
          state: channel.status.state,
          credentialConfigured: credentials.configured,
          credentialPresent: credentials.present,
          allowlistEntries: channel.config.allowlist.length,
          capabilities: channel.plugin.capabilities,
          error: channel.publicError || (channel.status.error ? "channel adapter reported an error" : ""),
          connectedAt: channel.status.connectedAt,
          lastEventAt: channel.status.lastEventAt,
          reconnectAttempts: channel.status.reconnectAttempts,
          latencyMs: channel.status.latencyMs,
          details: channel.status.details
        };
      }));
    },
    async handleWebhook(request: any, response: any, url: URL) {
      const webhook = webhooks.get(url.pathname);
      if (!webhook?.adapter.handleWebhook) return false;
      const body = webhook.requestMode === "buffer"
        ? await readRequestBuffer(request, { maxBytes: requestMaxBytes })
        : undefined;
      const result = await webhook.adapter.handleWebhook({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
        rawRequest: request,
        rawResponse: response
      });
      if (!response.writableEnded && result) {
        response.writeHead(result.status, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          ...result.headers
        });
        response.end(result.body ?? "");
      }
      return true;
    },
    async start(baseUrl: string) {
      if (started) return;
      started = true;
      for (const channel of configured) {
        if (!channel.config.enabled) continue;
        try {
          const validation = channel.plugin.validateAccountConfig(channel.name, channel.config);
          if (validation.some((message) => !/denies all inbound messages/iu.test(message))) {
            throw new Error(validation.join("; "));
          }
          const token = channel.config.tokenEnv ? process.env[channel.config.tokenEnv] : "";
          if (!token) throw new MissingChannelCredentialError(`channel credential is unavailable in ${channel.config.tokenEnv || "an environment variable"}`);
          const credentials = Object.fromEntries(Object.entries(channel.config.credentialEnvs ?? {}).map(([key, environmentName]) => [
            key,
            process.env[String(environmentName)] ?? ""
          ]));
          const missingCredential = Object.entries(channel.config.credentialEnvs ?? {}).find(([, environmentName]) => (
            !process.env[String(environmentName)]
          ));
          if (missingCredential) throw new MissingChannelCredentialError(`channel credential is unavailable in ${String(missingCredential[1])}`);
          const adapter = channel.plugin.createAdapter({
            accountId: channel.name,
            config: channel.config,
            credential: token,
            credentials,
            onError(error) {
              channel.publicError = "";
              channel.status.error = error instanceof Error ? error.message : String(error);
            }
          });
          const recordChannelExecutionState = async (event: ChannelExecutionStateEvent) => {
            const projection = projectChannelExecutionAudit(event);
            await auditStore.append({
              at: new Date().toISOString(),
              runId: event.executionKey,
              type: "channel.execution",
              actor: `channel:${channel.type}`,
              tool: "agent.run",
              decision: "allow",
              ...projection.message ? { message: projection.message } : {},
              data: projection.data
            });
          };
          const handler = new GatewayChannelHandler({
            baseUrl,
            token: gatewayToken,
            bindings: new FileSessionBindingStore(join(state, "channel-bindings.json")),
            onExecutionState: recordChannelExecutionState,
            ...(channel.config.defaultModel ? { defaultModel: channel.config.defaultModel } : {}),
            ...(channel.config.historyLimit ? { historyLimit: channel.config.historyLimit } : {})
          });
          const router = new ChannelRouter(handler, {
            access: channel.plugin.createAccessPolicy?.(channel.config) ?? createAllowlistPolicy(channel.config.allowlist),
            dedupe,
            onError(error) {
              channel.publicError = "";
              channel.status.error = error instanceof Error ? error.message : String(error);
            },
            onExecutionState: recordChannelExecutionState
          });
          await router.attach(adapter, (patch) => {
            if (Object.hasOwn(patch, "error")) channel.publicError = "";
            channel.status = { ...channel.status, ...patch };
          });
          const runtime: { adapter: any; router: ChannelRouter; healthTimer?: NodeJS.Timeout } = { adapter, router };
          const probe = adapter.probe?.bind(adapter);
          if (probe) {
            runtime.healthTimer = setInterval(() => {
              void probe().then((status: any) => {
                if (Object.hasOwn(status, "error")) channel.publicError = "";
                channel.status = { ...channel.status, ...status };
              }).catch((error: unknown) => {
                channel.publicError = "";
                channel.status = {
                  ...channel.status,
                  state: "degraded",
                  error: error instanceof Error ? error.message : String(error)
                };
              });
            }, 30_000);
            runtime.healthTimer.unref?.();
          }
          runtimes.push(runtime);
          const webhookPath = channel.plugin.webhookPath?.(channel.name, channel.config);
          if (webhookPath && adapter.handleWebhook) {
            webhooks.set(webhookPath, {
              adapter,
              requestMode: channel.plugin.webhookRequestMode ?? "buffer"
            });
          }
          channel.publicError = "";
          channel.status.error = "";
        } catch (error) {
          channel.status.state = "failed";
          channel.publicError = error instanceof MissingChannelCredentialError
            ? "channel credential is unavailable"
            : "";
          channel.status.error = error instanceof Error ? error.message : String(error);
        }
      }
    },
    async stop() {
      started = false;
      await Promise.allSettled(runtimes.splice(0).map(({ adapter, router, healthTimer }) => {
        if (healthTimer) clearInterval(healthTimer);
        return router.stop([adapter]);
      }));
      for (const channel of configured) channel.status.state = "stopped";
      webhooks.clear();
    }
  };
}

function channelCredentialEnvironments(config: any): string[] {
  return [
    config.tokenEnv,
    ...Object.values(config.credentialEnvs ?? {})
  ].map((value) => typeof value === "string" ? value.trim() : "");
}

function channelCredentialStatus(config: any): { configured: boolean; present: boolean } {
  const environments = channelCredentialEnvironments(config);
  const configured = environments.length > 0 && environments.every(Boolean);
  return {
    configured,
    present: configured && environments.every((name) => typeof process.env[name] === "string" && process.env[name]!.length > 0)
  };
}

async function diagnostics({ state, workspaceRoot, config, featureFlags, auditStore, approvalStore, supervisor, channelSupervisor, processRecoveryStartupError = false, sandboxRecoveryStartupError = false }: any): Promise<DiagnosticsReportV1> {
  let audit = { valid: true, events: 0, unsigned: 0, failureCount: 0 };
  try {
    const auditPath = join(state, config.auditLog ?? "audit.jsonl");
    if (await access(auditPath).then(() => true).catch(() => false)) {
      const verification: any = await auditStore.verifyIntegrity({ allowUnsigned: true });
      audit = { valid: verification.valid, events: verification.events, unsigned: verification.unsigned, failureCount: verification.failures?.length ?? 0 };
    }
  } catch { audit = { valid: false, events: 0, unsigned: 0, failureCount: 1 }; }
  const jobs = await supervisor.list();
  const pendingApprovals = approvalStore.list();
  let recovery: any = { status: "clear" };
  try { recovery = JSON.parse(await readFile(join(state, "browser-recovery.json"), "utf8")); } catch (error: any) { if (error?.code !== "ENOENT") recovery = { status: "unavailable" }; }
  let sandboxRecovery: any = { pending: [] };
  try { sandboxRecovery = JSON.parse(await readFile(join(state, "sandbox-recovery.json"), "utf8")); } catch (error: any) { if (error?.code !== "ENOENT") sandboxRecovery = { pending: null }; }
  let processRecovery: any = { pending: [] };
  try { processRecovery = JSON.parse(await readFile(join(state, "process-recovery.json"), "utf8")); } catch (error: any) { if (error?.code !== "ENOENT") processRecovery = { pending: null, invalid: true }; }
  const ownerOnly = await isOwnerOnlyPath(state);
  const normalized = normalizeModelConfig(config);
  let version = "unknown";
  try { version = JSON.parse(await readFile(PACKAGE_FILE, "utf8")).version ?? version; } catch {}
  let commit = process.env.ODINN_COMMIT ?? "";
  if (!commit) {
    try { commit = JSON.parse(await readFile(INSTALL_METADATA_FILE, "utf8")).commit ?? ""; } catch {}
  }
  const sandboxConfig = normalizeSandboxConfig(config);
  const sandboxBackends = await Promise.all([
    probeOciBackend("podman", undefined, { executablePaths: sandboxConfig.backend.enginePaths }),
    probeOciBackend("docker", undefined, { executablePaths: sandboxConfig.backend.enginePaths })
  ]);
  let extensionLane: any = { status: sandboxConfig.process.enabled ? "refused" : "disabled", code: sandboxConfig.process.enabled ? "SANDBOX_BACKEND_UNAVAILABLE" : "SANDBOX_PROCESS_DISABLED" };
  if (sandboxConfig.process.enabled) {
    try {
      const selected = await resolveConfiguredOciBackend(sandboxConfig);
      extensionLane = { status: "eligible", backend: selected.backend, rootless: selected.rootless, controls: "engine-reported; stopped-container attestation required before start" };
    } catch (error: any) {
      extensionLane = { status: "refused", code: String(error?.code ?? "SANDBOX_BACKEND_UNAVAILABLE") };
    }
  }
  return {
    ok: audit.valid,
    command: "diagnostics",
    version,
    commit: commit || "unknown",
    platform: { os: process.platform, arch: process.arch, node: process.version },
    providerMode: await Promise.all(Object.entries(normalized.providers ?? {}).map(async ([name, provider]: any) => {
      const support = providerSupport(name);
      return {
        name,
        displayName: support.displayName,
        supportTier: support.supportTier,
        locallyTested: support.locallyTested,
        genericCompatibilityMode: support.genericCompatibilityMode,
        type: provider.type ?? "openai-compatible",
        authMode: provider.auth?.mode ?? "api-key",
        configured: provider.auth?.mode === "oauth" ? await oauthTokenExists(provider, state) : !provider.apiKeyEnv || Boolean(process.env[provider.apiKeyEnv]),
        models: provider.models ?? []
      };
    })),
    coreAdvanced: CORE_ADVANCED_FEATURES,
    experimental: featureFlags,
    channels: channelSupervisor.status(),
    audit,
    approvals: { pending: pendingApprovals.length, ids: pendingApprovals.map((approval: any) => approval.id) },
    browserEngine: await probeChromiumEngine(),
    browserRecovery: { status: recovery.status ?? "clear", pending: ["executing", "unknown"].includes(recovery.status), id: recovery.id ?? undefined },
    jobs: {
      total: jobs.length,
      queued: jobs.filter((job: any) => job.status === "queued").length,
      running: jobs.filter((job: any) => job.status === "running").length,
      failed: jobs.filter((job: any) => job.status === "failed").length,
      needsReview: jobs.filter((job: any) => job.status === "needs-review").length,
      completed: jobs.filter((job: any) => job.status === "completed").length
    },
    sandbox: {
      configured: summarizeSandboxRisk(sandboxConfig),
      recovery: { pending: Array.isArray(sandboxRecovery.pending) ? sandboxRecovery.pending.length : null, quarantined: sandboxRecoveryStartupError === true || sandboxRecovery.pending === null },
      extensionLane,
      activation: "durable process jobs require an operator approval and a configured digest-pinned Linux OCI image; direct runs, shell access, network access, and writable host integration remain unavailable",
      backends: sandboxBackends.map((backend) => ({
        backend: backend.backend,
        available: backend.available,
        compatible: backend.compatible,
        rootless: backend.rootless,
        containerOs: backend.containerOs,
        controls: backend.controlEvidence.status,
        resourceControls: backend.resourceControls
      }))
    },
    processRecovery: {
      pending: Array.isArray(processRecovery.pending) ? processRecovery.pending.length : null,
      needsReview: Array.isArray(processRecovery.pending) ? processRecovery.pending.filter((entry: any) => entry?.phase === "needs-review").length : null,
      quarantined: processRecoveryStartupError === true || processRecovery.invalid === true || (Array.isArray(processRecovery.pending) && processRecovery.pending.length > 0)
    },
    githubRead: diagnoseGitHubReadIntegration(config?.integrations?.github ?? {}),
    microsoftGraphRead: diagnoseMicrosoftGraphReadIntegration(config?.integrations?.microsoftGraph ?? {}),
    state: { ownerOnly, runtimeStateOutsideSourceCheckout: !isPhysicalPathInside(workspaceRoot, state), secretsExcludedFromDiagnostics: true }
  };
}

function publicError(error: any, requestId: string) {
  const status = Number(error?.status ?? 400);
  const raw = error instanceof Error ? error.message : String(error);
  const code = String(error?.code ?? "");
  const category = code === "BROWSER_RECOVERY_REQUIRED" || /outcome is unknown|uncertain outcome/i.test(raw)
    ? "browser-recovery"
    : code.includes("CAPABILITY") || /policy|approval|disabled/i.test(raw)
      ? "policy"
      : /timeout|timed out/i.test(raw)
        ? "timeout"
        : /browser(?:type|context| tab| proxy)|chromium|playwright|locator\./i.test(raw)
          ? "browser"
        : /provider|model/i.test(raw)
          ? "provider"
          : status === 404 ? "not-found" : status >= 500 ? "runtime" : "validation";
  const safe = error instanceof GatewayError || /experimental\.[a-z-]+ is disabled|request body must be valid JSON|request body exceeds \d+ bytes|origin rejected|gateway authentication required|outcome is unknown|uncertain outcome/i.test(raw)
    ? raw.slice(0, 240)
    : category === "timeout" ? "The operation timed out. Retry it or inspect diagnostics."
      : category === "provider" ? "The provider operation failed. Check the configured provider and retry."
        : category === "browser" ? "The browser operation failed. Check the browser runtime and retry."
        : category === "policy" ? "The operation was blocked by policy or approval state. Review the policy and pending approvals."
          : "The operation failed. Run `odinn doctor` for a safe diagnostic report.";
  return { ok: false, error: safe, category, nextAction: category === "browser-recovery" ? "Inspect and resolve the browser recovery record before retrying." : "Run `odinn doctor` and retry after correcting the reported condition.", requestId };
}

async function oauthTokenExists(provider: any, state: any) {
  try {
    await access(oauthTokenPath(provider, state));
    return true;
  } catch {
    return false;
  }
}

await runGatewayEntrypoint({ createGatewayServer, compiledRuntime, moduleUrl: import.meta.url });
