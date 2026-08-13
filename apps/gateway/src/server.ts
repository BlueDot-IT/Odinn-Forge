import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, open, readFile, readdir, rename, rm, stat as statPath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { APPLICATION_CONTRACT_VERSION, createDiagnosticsReadUseCase, createSessionListUseCase, createStatusReadUseCase, normalizeSessionListLimit, validateGatewayChannelDiagnosticsV1, validatePendingApprovalSummariesV1, validateRuntimeSecuritySummaryV1, type DiagnosticsReportV1, type GatewayStatusSnapshotV1 } from "@odinn/application";
import { AGENT_GRAPH_TOOL, AGENT_SDK_VERSION, buildOperatorSnapshot, CORE_ADVANCED_FEATURES, DEFAULT_SANDBOX_CONFIG, assertHostedSandboxConfig, CheckpointCoordinator, createApprovalStore, createAuditStore, createDifferentiatedRuntime, createGovernedMcpRuntime, DurableEventIngress, DurableWorkflowRuntime, ensureMainAgent, ensureStateCompatibility, ExtensionExecutor, ExtensionRegistry, isAllowedCredentialEnvironmentKey, isPhysicalPathInside, JobSupervisor, listConfiguredModels, MAX_BOUNDED_UTF8_BYTES, normalizeExperimentalFlags, normalizeMcpConfiguration, normalizeModelConfig, normalizeSandboxConfig, normalizeSelfImprovementConfig, oauthTokenPath, operatorActionNames, previewExecutionAdmission, ProjectContextService, probeOciBackend, providerSupport, PROVIDER_PRESETS, ProofVerifier, ProgressiveSkillDisclosure, readUtf8Prefix, reconcileProcessRecovery, reconcileSandboxRecovery, resolveConfiguredOciBackend, runTask as executeTask, SkillLifecycleService, SkillPackageStore, SqliteRecordStore, SqliteJobStore, SqliteWorkflowStore, summarizeSandboxRisk, toolSafetyDescriptor, validateAgentManifest, validatePolicy, validateSkillPackage, withStateMutationLock } from "@odinn/kernel";
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
  type ChannelExecutionStateEvent
} from "@odinn/channels";
import { authenticationMode, isMutatingMethod, permitsGatewayTokenBootstrap, validHostHeader, validMutationOrigin } from "./security.ts";
import { runGatewayEntrypoint } from "./bootstrap.ts";
import { renderConsoleHtml } from "./public/console.ts";
import { runWithWorkflowLeaseHeartbeat } from "./workflow.ts";

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

const CRON_SCHEMA_VERSION = 2;
const CRON_MAX_JOBS = 500;
const CRON_MAX_FILE_BYTES = 4 * 1024 * 1024;
const CRON_DISPATCH_LEASE_MS = 10 * 60 * 1000;

export class CronStore {
  path: string;
  writeChain: Promise<unknown> = Promise.resolve();
  constructor(path: string) { this.path = path; }
  async read() {
    try {
      if ((await statPath(this.path)).size > CRON_MAX_FILE_BYTES) throw new GatewayError(409, `cron state exceeds the ${CRON_MAX_FILE_BYTES}-byte limit`);
      const value = JSON.parse(await readFile(this.path, "utf8"));
      if ((value?.schemaVersion !== 1 && value?.schemaVersion !== CRON_SCHEMA_VERSION) || !Array.isArray(value.jobs)) {
        return { schemaVersion: CRON_SCHEMA_VERSION, jobs: [] };
      }
      if (value.jobs.length > CRON_MAX_JOBS) throw new GatewayError(409, `cron state exceeds the ${CRON_MAX_JOBS}-job limit`);
      return value.jobs.length
        ? { schemaVersion: CRON_SCHEMA_VERSION, jobs: value.jobs.map((job: any) => normalizeCronJob(job)) }
        : { schemaVersion: CRON_SCHEMA_VERSION, jobs: [] };
    } catch (error: any) {
      if (error?.code === "ENOENT") return { schemaVersion: CRON_SCHEMA_VERSION, jobs: [] };
      throw error;
    }
  }
  async list({ limit = CRON_MAX_JOBS, offset = 0 }: { limit?: number; offset?: number } = {}) {
    const jobs = (await this.read()).jobs.sort((left: any, right: any) => String(left.name).localeCompare(String(right.name)));
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
      if (jobs.length >= CRON_MAX_JOBS) throw new GatewayError(409, `cron state is at its ${CRON_MAX_JOBS}-job limit`);
      if (jobs.some((item) => item.id === job.id)) throw new GatewayError(409, "cron job id already exists");
      jobs.push(job);
      return job;
    });
  }
  async update(id: string, patch: any) {
    return this.mutate((jobs) => {
      const index = jobs.findIndex((item) => item.id === id);
      if (index < 0) throw new GatewayError(404, "cron job not found");
      const current = normalizeCronJob(jobs[index]);
      const scheduleChanged = patch.schedule !== undefined || patch.timezone !== undefined;
      if (scheduleChanged && current.dispatchLease) throw new GatewayError(409, "cannot change an active cron schedule until its occurrence lease settles");
      jobs[index] = normalizeCronJob({
        ...current,
        ...patch,
        ...(scheduleChanged ? { nextRunAt: undefined, scheduledFor: undefined, dispatchLease: undefined } : {}),
        id,
        updatedAt: new Date().toISOString()
      });
      return jobs[index];
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
  writeChain: Promise<unknown> = Promise.resolve();
  constructor(path: string) { this.path = path; }
  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      return value?.schemaVersion === 1 && Array.isArray(value.agents) ? value : { schemaVersion: 1, agents: [] };
    } catch (error: any) {
      if (error?.code === "ENOENT") return { schemaVersion: 1, agents: [] };
      throw error;
    }
  }
  async list() { return (await this.read()).agents; }
  async mutate(operation: (agents: any[]) => any) {
    const pending = this.writeChain.then(() => withStateMutationLock(dirname(this.path), async () => {
      const state = await this.read();
      const result = await operation(state.agents);
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
  async install(input: any) {
    if (String(input?.id || "").trim() === "main") throw new GatewayError(409, "the primary main agent cannot be replaced by an SDK package");
    const manifest = validateAgentPackage(input);
    return this.mutate((agents) => {
      const current = agents.find((agent) => agent.id === manifest.id);
      const record = { ...manifest, status: "disabled", installedAt: new Date().toISOString(), previousVersion: current?.version };
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

async function runCronJob(store: CronStore, id: string, executor: any) {
  const job = (await store.list()).find((item: any) => item.id === id);
  if (!job) throw new GatewayError(404, "cron job not found");
  const startedAt = new Date().toISOString();
  try {
    const result = await executor({ task: { id: `${job.id}:${Date.now()}`, tool: job.tool, input: job.input, actor: "cron", reason: `cron:${job.id}` } });
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

async function dispatchCronOccurrence(store: CronStore, supervisor: JobSupervisor, claim: any, job: any, retrySafe = false): Promise<void> {
  await supervisor.submit(
    {
      task: {
        id: claim.occurrenceKey,
        tool: job.tool,
        input: job.input,
        actor: "cron",
        reason: claim.occurrenceKey,
        occurrenceKey: claim.occurrenceKey,
        scheduledFor: claim.scheduledFor
      }
    },
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

export async function runDueCronJobs(store: CronStore, supervisor: JobSupervisor, now = new Date(), retrySafeFor: (tool: string) => boolean = () => false) {
  const dispatches: Promise<void>[] = [];
  for (const job of await store.list()) {
    if (!job.enabled) continue;
    const claim = await store.claimDueOccurrence(job.id, now);
    if (!claim.claimed) continue;
    dispatches.push(dispatchCronOccurrence(store, supervisor, claim, job, retrySafeFor(job.tool)));
  }
  await Promise.allSettled(dispatches);
}

export async function createGatewayServer({
  stateDir = resolve(homedir(), ".odinn"),
  workspaceRoot = process.cwd(),
  requestMaxBytes = DEFAULT_REQUEST_MAX_BYTES,
  quotas = {},
  hosted = false,
  hostedUserId,
  channelPluginLoader = loadChannelPlugin
}: any = {}) {
  const trustedHostedUserId = hosted ? normalizeHostedUserId(hostedUserId) : undefined;
  const state = resolve(stateDir);
  const root = resolve(workspaceRoot);
  const version = await productVersion();
  await ensureStateCompatibility(state, { applicationVersion: version, applicationCommit: await productCommit() });
  await ensureSecureStateDirectory(state);
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
  const featureFlags = normalizeExperimentalFlags(config.experimental);
  const proofOptions = {
    allowedCommands: config.proof?.allowedCommands ?? [],
    includeRawEvidence: config.proof?.includeRawEvidence === true
  };
  const runtime = createDifferentiatedRuntime({ stateDir: state, workspaceRoot: root, featureFlags, proofOptions });
  new CheckpointCoordinator({ runLedger: runtime.ledger }).recover();
  const auditStore = createAuditStore(join(state, config.auditLog ?? "audit.jsonl"));
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
  const registry = createRuntimeRegistry({ workspaceRoot: root, stateDir: state, config, approvalStore, auditStore, skillDisclosure, mcpRuntime, writeConfig: writeSelfImprovementConfig });
  const governedRegistry = createRuntimeRegistry({ workspaceRoot: root, stateDir: state, config: { ...config, runLedger: runtime.ledger }, approvalStore, auditStore, skillDisclosure, mcpRuntime, writeConfig: writeSelfImprovementConfig });
  const gatewayToken = await loadGatewayToken(state);
  const isolatedTaskExecutor = createRuntimeIsolatedTaskExecutor({ stateDir: state, workspaceRoot: root, config, policy });
  const proofVerifier = new ProofVerifier({ runLedger: runtime.ledger, allowedRoot: root, ...proofOptions });
  const supervisor = new JobSupervisor({
    store: new SqliteJobStore(runtime.ledger, { legacyPath: join(state, "jobs.json") }),
    execute: isolatedTaskExecutor,
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
  const runGovernedTask = (request: any): Promise<any> => executeTask({ ...request, auditStore, policy, registry: governedRegistry, runLedger: runtime.ledger });
  const workflowRuntime = config.runtime?.enableDurableWorkflows === true
    ? new DurableWorkflowRuntime({
      store: new SqliteWorkflowStore(runtime.ledger.database),
      concurrency: 1,
      dispatch: async ({ run, step, signal, renewLease }) => {
        const output = await runWithWorkflowLeaseHeartbeat(() => runGovernedTask({
          task: { id: `${run.runId}:${step.stepId}:${step.attempt}`, tool: step.actionRef, input: step.input, actor: "workflow", reason: `workflow:${run.runId}` },
          signal,
          durableExecution: true
        }), renewLease);
        return output?.output?.type === "approval.required" || output?.type === "approval.required"
          ? { status: "awaiting-approval" as const }
          : { status: "completed" as const, result: output };
      },
      onEvent: async (event) => {
        await auditStore.append({ at: new Date().toISOString(), runId: event.runId, type: event.type, actor: "workflow-runtime", tool: "workflow", capability: "workflow.execute", decision: "allow", data: event.data });
      }
    })
    : undefined;
  const eventIngress = config.runtime?.enableEventIngress === true
    ? new DurableEventIngress({
      database: runtime.ledger.database,
      dispatch: async (candidate) => {
        const job = await supervisor.submit({ durableExecution: true, task: { id: candidate.candidateId, tool: candidate.actionRef, input: { candidateId: candidate.candidateId, idempotencyKey: candidate.idempotencyKey }, actor: "event-ingress", reason: `automation:${candidate.declarationId}` } }, { id: candidate.idempotencyKey, requestHash: candidate.idempotencyKey, retrySafe: false, idempotent: true });
        return ["queued", "running", "awaiting-approval", "completed"].includes(job.status) ? "completed" : "needs-review";
      }
    })
    : undefined;
  const contextRecords = config.runtime?.enableProjectContext === true ? new SqliteRecordStore(join(state, "db", "records.sqlite")) : undefined;
  const projectContext = contextRecords ? new ProjectContextService({ records: contextRecords }) : undefined;
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
  const runControlTask = (task: any) => executeTask({ task, auditStore, policy, registry, runLedger: runtime.ledger });
  await supervisor.start();
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
    (tool) => toolSafetyDescriptor(tool, registry.get(tool)).retrySafe === true
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

  const settleClaimedGatewayApproval = async (linkedJob: any, outcome: { result?: unknown; error?: unknown }) => {
    const expectedLeaseToken = typeof linkedJob?.dispatchLease?.token === "string"
      ? linkedJob.dispatchLease.token
      : "";
    if (!expectedLeaseToken) throw new Error("claimed approval job is missing its dispatch lease");
    return supervisor.settleApproval(linkedJob.id, { ...outcome, expectedLeaseToken });
  };

  const recoverGatewayApprovalContinuation = async (id: string, pending: any, linkedJob: any, linkedTask: Record<string, unknown> | undefined) => {
    const recovered = approvalStore.recover(id);
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
      approvalStore.revoke(id);
      if (linkedJob) {
        await settleClaimedGatewayApproval(linkedJob, {
          error: new Error("approved execution continuation could not be recovered exactly")
        }).catch(() => undefined);
      }
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
    try {
      const preview = approvalStore.list().find((approval: any) => approval.id === id);
      let linkedJob = preview?.runId ? await supervisor.get(String(preview.runId)) : undefined;
      if (linkedJob && linkedJob.status !== "awaiting-approval") {
        if (linkedJob.status !== "running") approvalStore.revoke(id);
        throw new GatewayError(409, "the originating job is no longer awaiting approval");
      }
      if (linkedJob) {
        try {
          linkedJob = await supervisor.beginApproval(linkedJob.id);
        } catch {
          const current = await supervisor.get(linkedJob.id);
          if (current?.status !== "running") approvalStore.revoke(id);
          throw new GatewayError(409, "the originating job approval was already claimed or cancelled");
        }
      }
      const pending = approvalStore.claim(id);
      if (!pending) {
        if (linkedJob) await settleClaimedGatewayApproval(linkedJob, { error: new Error("approval expired before execution claim") }).catch(() => undefined);
        throw new GatewayError(404, "approval not found or expired");
      }
      if (pending.type === "skill-lifecycle") {
        return { approvalId: id, result: await skillLifecycle.applyApproved(id, pending) };
      }
      const linkedTask = linkedJob?.payload?.task && typeof linkedJob.payload.task === "object" && !Array.isArray(linkedJob.payload.task)
        ? linkedJob.payload.task as Record<string, unknown>
        : undefined;
      const continuation = await recoverGatewayApprovalContinuation(id, pending, linkedJob, linkedTask);
      try {
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
        if (linkedJob) await settleClaimedGatewayApproval(linkedJob, { result });
        return { approvalId: id, result };
      } catch (error) {
        if (linkedJob) await settleClaimedGatewayApproval(linkedJob, { error }).catch(() => undefined);
        throw error;
      }
    } finally {
      activeGatewayApprovalExecutions.delete(id);
    }
  };

  const denyGatewayApproval = async (id: string) => {
    const pending = approvalStore.list().find((approval: any) => approval.id === id);
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
      if (!approvalStore.revoke(id)) throw new GatewayError(404, "approval not found or expired");
      await auditStore.append({
        ...auditContext,
        type: "operator.approval_denial_stale",
        decision: "stale",
        message: "approval was revoked after its originating job left the awaiting-approval state"
      }).catch(() => undefined);
      throw new GatewayError(409, "the originating job is no longer awaiting approval");
    }
    if (!approvalStore.revoke(id)) throw new GatewayError(404, "approval not found or expired");
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

  const readOperatorFile = async (name: string, fallback: any) => {
    try {
      const path = join(state, name);
      if ((await statPath(path)).size > 4 * 1024 * 1024) return { ...fallback, invalid: true };
      return JSON.parse(await readFile(path, "utf8"));
    }
    catch (error: any) { return error?.code === "ENOENT" ? fallback : { ...fallback, invalid: true }; }
  };

  const operatorSnapshot = async (surface: any = "http", page = 1, pageSize = 10, query = "", statusFilter = "", pages: Record<string, number> = {}) => {
    const [jobCounts, auditSummary, cronJobs, auditVerification, browserRecovery, sandboxRecovery, processRecovery] = await Promise.all([
      supervisor.counts(),
      typeof auditStore.readSummary === "function" ? auditStore.readSummary() : Promise.resolve({ events: 0, runs: 0, attentionRuns: 0 }),
      cronStore.list(),
      typeof auditStore.getIntegrityStatus === "function"
        ? Promise.resolve(auditStore.getIntegrityStatus())
        : Promise.resolve({ valid: true, checked: false, events: 0, unsigned: 0, failures: [] }),
      readOperatorFile("browser-recovery.json", { status: "clear" }),
      readOperatorFile("sandbox-recovery.json", { pending: [] }),
      readOperatorFile("process-recovery.json", { pending: [] })
    ]);
    const queryText = String(query || "").trim().toLowerCase();
    const queryStatus = statusFilter && statusFilter !== "all" ? String(statusFilter) : "";
    const normalizedPageSize = Math.min(50, Math.max(1, Number.isSafeInteger(Number(pageSize)) && Number(pageSize) > 0 ? Number(pageSize) : 10));
    const requestedPageFor = (section: string) => {
      const requested = pages[section] ?? page;
      return Number.isSafeInteger(Number(requested)) && Number(requested) > 0 ? Number(requested) : 1;
    };
    const makePage = (total: number, requested: number) => {
      const safeTotal = Math.max(0, Number(total) || 0);
      const pageCount = Math.max(1, Math.ceil(safeTotal / normalizedPageSize));
      const currentPage = Math.min(Math.max(1, requested), pageCount);
      const offset = (currentPage - 1) * normalizedPageSize;
      return {
        page: currentPage,
        pageSize: normalizedPageSize,
        pages: pageCount,
        total: safeTotal,
        from: safeTotal ? offset + 1 : 0,
        to: safeTotal ? Math.min(offset + normalizedPageSize, safeTotal) : 0
      };
    };
    const emptyQuery = () => ({ items: [] as any[], total: 0, attention: 0 });
    const selectPage = async <T>(sectionPage: { page: number; pageSize: number }, categories: Array<{ total: number; fetch: (offset: number, limit: number) => Promise<T[]> }>) => {
      let skip = (sectionPage.page - 1) * sectionPage.pageSize;
      let remaining = sectionPage.pageSize;
      const selected: T[] = [];
      for (const category of categories) {
        const total = Math.max(0, Number(category.total) || 0);
        if (skip >= total) {
          skip -= total;
          continue;
        }
        const limit = Math.min(remaining, total - skip);
        if (limit > 0) selected.push(...await category.fetch(skip, limit));
        remaining -= limit;
        skip = 0;
        if (remaining <= 0) break;
      }
      return selected;
    };
    const matches = (item: any) => (!queryText || [item.id, item.label, item.status, item.summary, item.kind].some((value) => String(value ?? "").toLowerCase().includes(queryText)))
      && (!statusFilter || statusFilter === "all" || item.status === statusFilter);
    const filter = (items: any[]) => items.filter(matches);
    const mapJob = (job: any) => {
      const task = job.payload?.task && typeof job.payload.task === "object" && !Array.isArray(job.payload.task) ? job.payload.task : {};
      const tool = String(task.tool || "job");
      const attention = ["failed", "needs-review"].includes(job.status);
      return {
        id: job.id,
        kind: "job",
        label: tool,
        status: job.status,
        summary: attention ? "Execution needs operator attention." : `${job.attempts ?? 0} attempt(s) · ${job.retrySafe ? "retry-safe" : "effectful"}`,
        updatedAt: job.updatedAt || job.completedAt || job.createdAt,
        attention,
        controls: ["queued", "running", "cancelling", "awaiting-approval"].includes(job.status) ? ["cancel-job"] : [],
        details: {
          attempts: Number(job.attempts || 0),
          retrySafe: job.retrySafe === true,
          ...(job.executionRunId ? { executionRunId: job.executionRunId } : {}),
          ...(job.envelopeDigest ? { envelopeDigest: job.envelopeDigest } : {}),
          ...(job.auditCorrelationId ? { auditCorrelationId: job.auditCorrelationId } : {})
        }
      };
    };
    const mapRun = (run: any) => ({
      id: String(run.id),
      kind: "run",
      label: String(run.tool || "run"),
      status: String(run.status || "unknown"),
      summary: String(run.message || "Audited run"),
      updatedAt: run.lastEventAt || run.completedAt || run.startedAt,
      attention: ["failed", "blocked", "needs-review"].includes(String(run.status || "")),
      details: { eventCount: Number(run.eventCount || 0), actor: String(run.actor || "local") }
    });
    const [jobQuery, runQuery, workflowQuery, watchQuery] = await Promise.all([
      supervisor.queryJobs({ limit: 0, offset: 0, query: queryText, status: queryStatus }),
      typeof (auditStore as any).queryRuns === "function"
        ? (auditStore as any).queryRuns({ limit: 0, offset: 0, query: queryText, status: queryStatus })
        : (async () => {
          const allRuns = typeof (auditStore as any).readRuns === "function" ? await (auditStore as any).readRuns() : [];
          const filteredRuns = allRuns.filter((run: any) => (!queryStatus || String(run.status || "") === queryStatus) && (!queryText || JSON.stringify(run).toLowerCase().includes(queryText)));
          return { items: [], total: filteredRuns.length, attention: filteredRuns.filter((run: any) => ["failed", "blocked", "needs-review"].includes(String(run.status || ""))).length, fetch: (offset: number, limit: number) => filteredRuns.slice(offset, offset + limit) };
        })(),
      workflowRuntime ? workflowRuntime.queryWorkflows({ limit: 0, offset: 0, query: queryText, status: queryStatus }) : Promise.resolve(emptyQuery()),
      eventIngress ? Promise.resolve(eventIngress.queryWatches({ limit: 0, offset: 0, query: queryText, status: queryStatus })) : Promise.resolve(emptyQuery())
    ]);
    const allCronItems = cronJobs.map((job: any) => ({ id: job.id, kind: "schedule", label: job.name, status: job.lastStatus === "error" ? "needs-review" : job.enabled ? "enabled" : "disabled", summary: job.lastStatus ? `Last run: ${job.lastStatus}` : "Scheduled automation", updatedAt: job.updatedAt, attention: job.lastStatus === "error", details: { nextRunAt: job.nextRunAt ?? null } }));
    const cronItems = filter(allCronItems);
    const workPage = makePage(Number(jobQuery.total || 0) + Number(runQuery.total || 0), requestedPageFor("work"));
    const workItems = await selectPage<any>(workPage, [
      {
        total: Number(jobQuery.total || 0),
        fetch: async (offset, limit) => (await supervisor.queryJobs({ limit, offset, query: queryText, status: queryStatus })).items.map(mapJob)
      },
      {
        total: Number(runQuery.total || 0),
        fetch: async (offset, limit) => {
          if (typeof (auditStore as any).queryRuns === "function") return (await (auditStore as any).queryRuns({ limit, offset, query: queryText, status: queryStatus })).items.map(mapRun);
          if (typeof (runQuery as any).fetch === "function") return (runQuery as any).fetch(offset, limit).map(mapRun);
          return [];
        }
      }
    ]);
    const allApprovalItems = approvalStore.list().map((approval: any) => ({
      id: String(approval.id),
      kind: "approval",
      label: String(approval.tool || approval.type || "approval"),
      status: String(approval.status || "pending"),
      summary: String(approval.effect?.summary || "Review the bounded effect details before deciding."),
      updatedAt: approval.createdAt,
      attention: true,
      controls: ["approve", "deny-approval"],
      details: {
        ...(approval.runId ? { runId: approval.runId } : {}),
        ...(approval.expiresAt ? { expiresAt: approval.expiresAt } : {}),
        ...(approval.effect ? { effect: approval.effect } : {})
      }
    }));
    const approvals = filter(allApprovalItems);
    const workflowCounts = workflowRuntime?.counts?.() ?? { total: 0, attention: 0 };
    const automationPage = makePage(Number(workflowQuery.total || 0) + Number(watchQuery.total || 0) + cronItems.length, requestedPageFor("automation"));
    const automationItems = await selectPage<any>(automationPage, [
      {
        total: Number(workflowQuery.total || 0),
        fetch: async (offset, limit) => workflowRuntime
          ? (await workflowRuntime.queryWorkflows({ limit, offset, query: queryText, status: queryStatus })).items.map((run: any) => ({
            id: String(run.runId), kind: "workflow", label: String(run.definitionDigest || "workflow"), status: String(run.status),
            summary: "Durable workflow run", updatedAt: run.updatedAt,
            attention: ["failed", "needs-review", "awaiting-approval"].includes(String(run.status)),
            controls: ["running", "queued", "awaiting-approval"].includes(String(run.status)) ? ["cancel-workflow"] : ["needs-review"].includes(String(run.status)) ? ["resume-workflow"] : []
          }))
          : []
      },
      {
        total: Number(watchQuery.total || 0),
        fetch: async (offset, limit) => eventIngress
          ? (await eventIngress.queryWatches({ limit, offset, query: queryText, status: queryStatus })).items.map((watch: any) => ({ id: watch.watchId, kind: "event-watch", label: "Event watch", status: watch.enabled ? "enabled" : "disabled", summary: "Durable event ingress declaration", updatedAt: watch.updatedAt, details: { enabled: watch.enabled === true } }))
          : []
      },
      { total: cronItems.length, fetch: async (offset, limit) => cronItems.slice(offset, offset + limit) }
    ]);
    const allRecoveryItems = [
      { id: "browser-recovery", kind: "recovery", label: "Browser recovery", status: String(browserRecovery.status || "clear"), summary: browserRecovery.status === "clear" ? "No browser action is awaiting resolution." : "Browser action recovery is required.", attention: ["executing", "unknown"].includes(String(browserRecovery.status)), details: { pending: ["executing", "unknown"].includes(String(browserRecovery.status)) } },
      { id: "sandbox-recovery", kind: "recovery", label: "Sandbox recovery", status: Array.isArray(sandboxRecovery.pending) && sandboxRecovery.pending.length ? "needs-review" : "clear", summary: "Sandbox process recovery state", attention: Array.isArray(sandboxRecovery.pending) && sandboxRecovery.pending.length > 0, details: { pending: Array.isArray(sandboxRecovery.pending) ? sandboxRecovery.pending.length : null } },
      { id: "process-recovery", kind: "recovery", label: "Process recovery", status: processRecovery.invalid === true ? "needs-review" : Array.isArray(processRecovery.pending) && processRecovery.pending.length ? "needs-review" : "clear", summary: "Durable process recovery state", attention: processRecovery.invalid === true || (Array.isArray(processRecovery.pending) && processRecovery.pending.length > 0), details: { pending: Array.isArray(processRecovery.pending) ? processRecovery.pending.length : null } }
    ];
    const recoveryItems = filter(allRecoveryItems);
    const auditItem = {
      id: "audit-journal", kind: "audit", label: "Audit journal", status: auditVerification.valid === false ? "needs-review" : auditVerification.checked === false ? "unknown" : "verified", summary: auditVerification.valid === false ? "Audit integrity needs attention." : auditVerification.checked === false ? "Audit integrity has not been explicitly verified in this process." : "Hash-chain verification passed.", attention: auditVerification.valid === false || auditVerification.checked === false,
      details: { events: Number(auditSummary.events || 0), runs: Number(auditSummary.runs || 0), unsigned: Number(auditVerification.unsigned || 0), failures: Array.isArray(auditVerification.failures) ? auditVerification.failures.length : 0, checked: auditVerification.checked === true }
    };
    const runtimeItems = [
      { id: "gateway", kind: "runtime", label: "Gateway", status: "running", summary: "Authenticated local control plane" },
      { id: "mcp", kind: "runtime", label: "MCP", status: mcpRuntime ? "enabled" : "disabled", summary: mcpRuntime ? "Governed MCP activation" : "Disabled by default" },
      { id: "workflows", kind: "runtime", label: "Durable workflows", status: workflowRuntime ? "enabled" : "disabled", summary: workflowRuntime ? "Durable workflow runtime" : "Disabled by default" },
      { id: "event-ingress", kind: "runtime", label: "Event ingress", status: eventIngress ? "enabled" : "disabled", summary: eventIngress ? "Authenticated event and heartbeat ingress" : "Disabled by default" },
      { id: "project-context", kind: "runtime", label: "Project context", status: projectContext ? "enabled" : "disabled", summary: projectContext ? "Bounded context retrieval" : "Disabled by default" }
    ];
    const surfaces = ["CLI", "TUI", "HTTP JSON", "Web console"].map((label) => ({ id: label.toLowerCase().replace(/\s+/gu, "-"), kind: "surface", label, status: "available", summary: "Uses the shared operator contract" }));
    const attentionCount = Number(jobCounts.attention || 0)
      + Number(auditSummary.attentionRuns || 0)
      + allApprovalItems.filter((item: any) => item.attention).length
      + Number(workflowCounts.attention || 0)
      + allRecoveryItems.filter((item: any) => item.attention).length
      + (auditItem.attention ? 1 : 0);
    return buildOperatorSnapshot({
      surface,
      identity: { state, workspaceRoot: root, version, commit: await productCommit() },
      health: { status: attentionCount ? "attention" : "healthy", ok: attentionCount === 0, attention: attentionCount, summary: attentionCount ? `${attentionCount} item(s) need operator attention.` : "All governed surfaces are operating normally." },
      page,
      pageSize,
      pages: pages as any,
      sections: {
        runtime: { items: runtimeItems },
        work: { items: workItems, pagination: workPage, counts: { total: workPage.total, jobs: Number(jobQuery.total || 0), runs: Number(runQuery.total || 0), attention: Number(jobQuery.attention || 0) + Number(runQuery.attention || 0) }, attentionCount: Number(jobQuery.attention || 0) + Number(runQuery.attention || 0) },
        approvals: { items: approvals, counts: { total: allApprovalItems.length, pending: allApprovalItems.length }, attentionCount: allApprovalItems.filter((item: any) => item.attention).length },
        automation: { items: automationItems, pagination: automationPage, counts: { total: automationPage.total, workflows: Number(workflowQuery.total || 0), watches: Number(watchQuery.total || 0), schedules: cronItems.length, attention: Number(workflowQuery.attention || 0) + Number(watchQuery.attention || 0) + cronItems.filter((item: any) => item.attention).length }, attentionCount: Number(workflowQuery.attention || 0) + Number(watchQuery.attention || 0) + cronItems.filter((item: any) => item.attention).length },
        context: { items: [{ id: "project-context", kind: "context", label: "Project context", status: projectContext ? "enabled" : "disabled", summary: projectContext ? "Context retrieval is available through the governed context surface." : "Project context is disabled by default." }] },
        recovery: { items: recoveryItems, attentionCount: allRecoveryItems.filter((item: any) => item.attention).length },
        audit: { items: [auditItem], counts: { events: Number(auditSummary.events || 0), runs: Number(auditSummary.runs || 0) } },
        surfaces: { items: surfaces }
      }
    });
  };

  const server: any = createServer(async (request: any, response: any) => {
    const requestId = String(request.headers["x-odinn-request-id"] || randomUUID());
    response.setHeader("x-odinn-request-id", requestId);
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!validHostHeader(request)) return json(response, 421, { ok: false, error: "invalid gateway Host header" });
      if (request.method === "GET" && url.pathname === "/odinn-logo.png") {
        return image(response, 200, await readFile(join(PUBLIC_DIR, "odinn-logo.png")), "image/png");
      }
      if (request.method === "GET" && url.pathname === "/") {
        const bootstrapHeaders = permitsGatewayTokenBootstrap(request, server)
          ? {
              "set-cookie": `odinn_gateway_token=${encodeURIComponent(gatewayToken)}; HttpOnly; SameSite=Strict; Path=/`,
              "x-odinn-auth": "bootstrap-cookie"
            }
          : { "x-odinn-auth": "authentication-required" };
        return html(response, 200, renderConsoleHtml(version), bootstrapHeaders);
      }
      if (url.pathname.startsWith("/channels/webhook/")) {
        if (await channelSupervisor.handleWebhook(request, response, url)) return;
        return json(response, 404, { ok: false, error: "channel webhook not found" });
      }
      const authentication = process.env.ODINN_GATEWAY_AUTH === "off" ? "disabled" : authenticationMode(request, gatewayToken);
      if (!authentication) {
        return json(response, 401, { ok: false, error: "gateway authentication required" });
      }
      if (isMutatingMethod(request.method) && !validMutationOrigin(request, authentication)) {
        return json(response, 403, { ok: false, error: "origin rejected for control-plane mutation" });
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
      if (request.method === "GET" && url.pathname === "/status") {
        const applicationRequestId = randomUUID();
        const result = await statusRead.execute(createGatewayStatusReadRequest({
          applicationRequestId,
          hostedUserId: trustedHostedUserId,
          authentication
        }));
        return json(response, 200, result.output);
      }
      if (request.method === "GET" && url.pathname === "/diagnostics") {
        const applicationRequestId = randomUUID();
        const result = await diagnosticsRead.execute(createGatewayDiagnosticsReadRequest({
          applicationRequestId,
          hostedUserId: trustedHostedUserId,
          authentication
        }));
        return json(response, 200, result.output);
      }
      if (request.method === "GET" && (url.pathname === "/operator" || url.pathname === "/operator/snapshot")) {
        const requestedSurface = String(url.searchParams.get("surface") || "http");
        const surface = ["cli", "tui", "http", "console"].includes(requestedSurface) ? requestedSurface : "http";
        const page = Number.parseInt(url.searchParams.get("page") || "1", 10) || 1;
        const pageSize = Number.parseInt(url.searchParams.get("pageSize") || "10", 10) || 10;
        const pageNames = ["runtime", "work", "approvals", "automation", "context", "recovery", "audit", "surfaces"];
        const pages = Object.fromEntries(pageNames
          .map((name) => [name, Number.parseInt(url.searchParams.get(`${name}Page`) || "", 10)])
          .filter(([, value]) => Number.isSafeInteger(value) && Number(value) > 0));
        const snapshot = await operatorSnapshot(surface, page, pageSize, url.searchParams.get("q") || "", url.searchParams.get("status") || "", pages);
        return json(response, 200, { ok: true, ...snapshot });
      }
      if (request.method === "POST" && url.pathname === "/operator/actions") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const action = String(body.action || "").trim();
        if (!operatorActionNames().includes(action as any)) throw new GatewayError(400, "operator action is unsupported");
        if (action !== "verify-audit" && body.confirm !== true) throw new GatewayError(400, "operator action requires confirm=true");
        const targetId = String(body.targetId || "").trim();
        if (action !== "verify-audit" && (!targetId || targetId.length > 512)) throw new GatewayError(400, "operator action targetId is required");
        let result: any;
        if (action === "cancel-job") {
          for (const approval of approvalStore.list()) if (approval.runId === targetId && approval.id) approvalStore.revoke(approval.id);
          result = await supervisor.cancel(targetId);
        } else if (action === "approve") {
          result = await approveGatewayApproval(targetId);
        } else if (action === "deny-approval") {
          result = await denyGatewayApproval(targetId);
        } else if (action === "cancel-workflow") {
          if (!workflowRuntime) throw new GatewayError(403, "durable workflows are disabled");
          result = await workflowRuntime.cancel(targetId);
        } else if (action === "resume-workflow") {
          if (!workflowRuntime) throw new GatewayError(403, "durable workflows are disabled");
          result = await workflowRuntime.resume(targetId);
        } else {
          result = await auditStore.verifyIntegrity({ allowUnsigned: true });
        }
        const surface = String(body.surface || "http");
        const snapshot = await operatorSnapshot(["cli", "tui", "http", "console"].includes(surface) ? surface : "http");
        return json(response, 200, { ok: true, action, ...(targetId ? { targetId } : {}), result, snapshot });
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
            principalId: "gateway",
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
        return json(response, 200, { ok: true, result: await runCronJob(cronStore, id, isolatedTaskExecutor) });
      }
      if (request.method === "GET" && url.pathname.startsWith("/jobs/") && url.pathname.endsWith("/result")) {
        const id = decodeURIComponent(url.pathname.slice("/jobs/".length, -"/result".length));
        const job = await supervisor.get(id);
        if (!job) return json(response, 404, { ok: false, error: "job not found" });
        const task = job.payload?.task;
        const taskTool = task && typeof task === "object" && !Array.isArray(task) ? (task as Record<string, unknown>).tool : undefined;
        if (job.status !== "completed" || job.payload?.executionKey !== id || taskTool !== "agent.run") {
          return json(response, 409, { ok: false, error: "ephemeral channel result is unavailable" });
        }
        const result = supervisor.getVolatileResult(id);
        return result === undefined
          ? json(response, 409, { ok: false, error: "ephemeral channel result is unavailable" })
          : json(response, 200, { ok: true, result });
      }
      if (request.method === "GET" && url.pathname.startsWith("/jobs/")) {
        const id = decodeURIComponent(url.pathname.slice("/jobs/".length));
        const job = await supervisor.get(id);
        return job ? json(response, 200, job) : json(response, 404, { ok: false, error: "job not found" });
      }
      if (request.method === "POST" && url.pathname === "/jobs") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const task = body.task && typeof body.task === "object" ? body.task : body;
        if (task.tool === "agent.delegate" && body.kind !== "agent-graph") {
          throw new GatewayError(400, "agent.delegate jobs require kind=agent-graph");
        }
        if (body.kind === "agent-graph" && task.tool !== "agent.delegate") {
          throw new GatewayError(400, "kind=agent-graph requires task.tool=agent.delegate");
        }
        if (task.tool === AGENT_GRAPH_TOOL && config?.runtime?.enableAgentGraphs !== true) {
          throw new GatewayError(403, "agent graph execution is disabled; enable config.runtime.enableAgentGraphs explicitly");
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
        const id = body.id || request.headers["idempotency-key"] || undefined;
        const requestHash = hashRequest(body);
        if (id) {
          const existing = await supervisor.get(String(id));
          if (existing) {
            if (existing.requestHash && existing.requestHash !== requestHash) return json(response, 409, { ok: false, error: "idempotency key was already used for a different request" });
            return json(response, 200, { ok: true, replayed: true, job: existing });
          }
        }
        const safety = toolSafetyDescriptor(task.tool, registry.get(task.tool));
        const durableExecution = task.tool === "process.exec" || task.tool === "agent.delegate" || task.tool === "mcp.invoke";
        const sandboxProcessConfig = task.tool === "process.exec" ? normalizeSandboxConfig(config).process : undefined;
        const requestedTimeout = Number.isSafeInteger(task.input?.timeoutMs) ? Number(task.input.timeoutMs) : sandboxProcessConfig?.limits.timeoutMs;
        const requestedGraphTimeout = Number.isSafeInteger(task.input?.maxRunMs) ? Number(task.input.maxRunMs) : 120_000;
        const effectiveTimeout = task.tool === "process.exec"
          ? Math.min(requestedTimeout ?? 120_000, sandboxProcessConfig?.limits.timeoutMs ?? 120_000) + 30_000
          : task.tool === "agent.delegate"
            ? Math.min(Math.max(requestedGraphTimeout, 1), 300_000) + 30_000
          : body.timeoutMs;
        const job = await supervisor.submit(
          { durableExecution, ...(parentCapabilities ? { parentCapabilities } : {}), ...(typeof body.executionKey === "string" ? { executionKey: body.executionKey } : {}), task: { ...task, ...(id ? { id: String(id) } : {}) } },
          { id: id ? String(id) : undefined, requestHash, timeoutMs: effectiveTimeout, retrySafe: safety.retrySafe === true }
        );
        return json(response, 202, { ok: true, job });
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
        return json(response, 200, validatePendingApprovalSummariesV1(approvalStore.list()));
      }
      if (request.method === "POST" && url.pathname.startsWith("/approvals/") && url.pathname.endsWith("/approve")) {
        const id = decodeURIComponent(url.pathname.slice("/approvals/".length, -"/approve".length));
        const preview = approvalStore.list().find((approval: any) => approval.id === id);
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
      if (request.method === "GET" && url.pathname === "/sessions") {
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
        const projectId = url.searchParams.get("projectId") ?? "";
        const applicationRequestId = randomUUID();
        const result = await sessionList.execute(createGatewaySessionListRequest({
          applicationRequestId,
          hostedUserId: trustedHostedUserId,
          authentication,
          limit: normalizeSessionListLimit(limit),
          projectId
        }));
        return json(response, 200, result.output);
      }
      if (request.method === "POST" && url.pathname === "/sessions") {
        return json(response, 200, (await runIsolatedTask({
          task: { tool: "session.create", input: await readJson(request, { maxBytes: requestMaxBytes }), actor: "gateway" },
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
            task: { id: body.id ?? request.headers["idempotency-key"], tool: body.tool, input: body.input, reason: body.reason, actor: "gateway" },
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

function normalizeHostedUserId(value: unknown): string {
  const normalized = String(value ?? "");
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/u.test(normalized)) {
    throw new Error("hosted gateway requires a canonical host user identity");
  }
  return normalized;
}

export function createGatewayStatusReadRequest({
  applicationRequestId,
  hostedUserId,
  authentication
}: {
  applicationRequestId: string;
  hostedUserId?: string;
  authentication: string;
}) {
  return {
    version: APPLICATION_CONTRACT_VERSION,
    kind: "status-read-request" as const,
    requestId: applicationRequestId,
    context: {
      principal: {
        principalId: hostedUserId ? `host-user:${normalizeHostedUserId(hostedUserId)}` : "local-gateway-user",
        actorId: "gateway",
        kind: "host-user" as const,
        authenticationReference: authentication === "disabled" ? "gateway:auth-disabled" : `gateway:${authentication}`
      },
      scope: { tenantId: hostedUserId ? `tenant:${normalizeHostedUserId(hostedUserId)}` : "local" },
      sourceReference: "http:GET:/status",
      correlationId: applicationRequestId,
      cancellationControlReference: `http:request:${applicationRequestId}`
    },
    operation: { kind: "query" as const, id: "status.read" as const }
  };
}

export function createGatewayDiagnosticsReadRequest({
  applicationRequestId,
  hostedUserId,
  authentication
}: {
  applicationRequestId: string;
  hostedUserId?: string;
  authentication: string;
}) {
  return {
    version: APPLICATION_CONTRACT_VERSION,
    kind: "diagnostics-read-request" as const,
    requestId: applicationRequestId,
    context: {
      principal: {
        principalId: hostedUserId ? `host-user:${normalizeHostedUserId(hostedUserId)}` : "local-gateway-user",
        actorId: "gateway",
        kind: "host-user" as const,
        authenticationReference: authentication === "disabled" ? "gateway:auth-disabled" : `gateway:${authentication}`
      },
      scope: { tenantId: hostedUserId ? `tenant:${normalizeHostedUserId(hostedUserId)}` : "local" },
      sourceReference: "http:GET:/diagnostics",
      correlationId: applicationRequestId,
      cancellationControlReference: `http:request:${applicationRequestId}`
    },
    operation: { kind: "query" as const, id: "diagnostics.read" as const }
  };
}

export function createGatewaySessionListRequest({
  applicationRequestId,
  hostedUserId,
  authentication,
  limit,
  projectId
}: {
  applicationRequestId: string;
  hostedUserId?: string;
  authentication: string;
  limit: number;
  projectId?: string;
}) {
  return {
    version: APPLICATION_CONTRACT_VERSION,
    kind: "session-list-request" as const,
    requestId: applicationRequestId,
    context: {
      principal: {
        principalId: hostedUserId ? `host-user:${normalizeHostedUserId(hostedUserId)}` : "local-gateway-user",
        actorId: "gateway",
        kind: "host-user" as const,
        authenticationReference: authentication === "disabled" ? "gateway:auth-disabled" : `gateway:${authentication}`
      },
      scope: { tenantId: hostedUserId ? `tenant:${normalizeHostedUserId(hostedUserId)}` : "local" },
      sourceReference: "http:GET:/sessions",
      correlationId: applicationRequestId,
      cancellationControlReference: `http:request:${applicationRequestId}`
    },
    operation: { kind: "query" as const, id: "session.list" as const },
    input: { limit, ...(projectId ? { projectId } : {}) }
  };
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
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new GatewayError(400, "request body must be valid JSON");
  }
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
      return validateGatewayChannelDiagnosticsV1(configured.map((channel) => ({
        name: channel.name,
        type: channel.type,
        enabled: channel.config.enabled,
        running: channel.status.state === "connected" || channel.status.state === "starting" || channel.status.state === "degraded",
        state: channel.status.state,
        credentialConfigured: channelCredentialEnvironments(channel.config).every(Boolean),
        credentialPresent: channelCredentialEnvironments(channel.config).every((name) => Boolean(process.env[name])),
        allowlistEntries: channel.config.allowlist.length,
        capabilities: channel.plugin.capabilities,
        error: channel.publicError || (channel.status.error ? "channel adapter reported an error" : ""),
        connectedAt: channel.status.connectedAt,
        lastEventAt: channel.status.lastEventAt,
        reconnectAttempts: channel.status.reconnectAttempts,
        latencyMs: channel.status.latencyMs,
        details: channel.status.details
      })));
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
            await auditStore.append({
              at: new Date().toISOString(),
              runId: event.executionKey,
              type: "channel.execution",
              actor: `channel:${channel.type}`,
              tool: "agent.run",
              decision: "allow",
              message: event.error,
              data: {
                executionKey: event.executionKey,
                state: event.state,
                channel: event.message.address.channel,
                accountId: event.message.address.accountId,
                conversationId: event.message.address.conversationId,
                conversationKind: event.message.address.conversationKind,
                threadId: event.message.address.threadId,
                inboundMessageId: event.message.id
              }
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
    String(config.tokenEnv ?? ""),
    ...Object.values(config.credentialEnvs ?? {}).map(String)
  ].filter(Boolean);
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
