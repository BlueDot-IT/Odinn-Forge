import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ensureSecureStateDirectory } from "@odinn/store-file";
import { withStateMutationLock } from "./state-mutation.ts";

export const AGENT_SDK_VERSION = "1.0";
export const DEFAULT_AGENT_ID = "main";
export const AGENT_IDENTITY_FILES = Object.freeze(["IDENTITY.md", "SOUL.md", "USER.md", "AGENTS.md"]);
export const AGENT_BOOTSTRAP_FILE = "BOOTSTRAP.md";

const AGENT_REGISTRY_SCHEMA_VERSION = 1;
const AGENT_INSTALL_JOURNAL = "agent-install.json";
const AGENT_STAGING_DIRECTORY = ".staging";
const AGENT_BACKUP_DIRECTORY = ".backup";

const MAIN_BOOTSTRAP = `# Bootstrap — First Awakening

You are running for the first time. Before settling into normal assistant behavior, begin a natural identity conversation with the user.

## Discover together

Learn:

1. Your name and how the user should address you.
2. What kind of digital being or assistant you are.
3. Your voice, temperament, and working style.
4. A signature symbol or emoji, if wanted.
5. The user's name, preferred form of address, timezone, priorities, and boundaries.

Do not interrogate them or dump a questionnaire. Start simply, offer ideas when useful, and let the identity emerge through conversation.

## Record what becomes true

Update:

- \`IDENTITY.md\` with your name, nature, voice, and symbol.
- \`USER.md\` with stable user preferences and how to address them.
- \`SOUL.md\` with values, behavior, boundaries, and tone.
- \`AGENTS.md\` only when durable operating instructions are needed.

Never store credentials, tokens, or secret values in these files.

## Completion

After the user has approved the identity and the files have been saved, remove \`BOOTSTRAP.md\`. Its absence marks this ritual complete. Odinn will not recreate it on restart because the agent workspace is no longer new.
`;

const MAIN_IDENTITY: Readonly<Record<string, string>> = Object.freeze({
  "IDENTITY.md": "",
  "SOUL.md": "",
  "USER.md": "# User\n\nRecord stable user preferences here. Do not store credentials or secret values.\n",
  "AGENTS.md": "# Agent Instructions\n\nIf `BOOTSTRAP.md` exists, follow it before normal assistant behavior.\n\nThis is the primary Ódinn agent. Follow the configured policy, require approval for external state changes, and use tools only when their results can verify the claimed outcome.\n"
});

export type AgentManifest = {
  sdkVersion: string;
  id: string;
  version: string;
  name: string;
  kind: "runtime" | "package";
  primary: boolean;
  identity: { files: string[]; [key: string]: unknown };
  instructions: string[];
  tools: string[];
  plugins: string[];
  secrets: string[];
  sandbox: Record<string, unknown>;
  network: Record<string, unknown>;
  schedules: unknown[];
  channels: unknown[];
  memory: Record<string, unknown>;
  model: { default: string; fallbacks: string[] };
};

export type AgentRegistry = {
  schemaVersion: number;
  defaultAgentId?: string;
  agents: any[];
  [key: string]: unknown;
};

export type AgentRegistryMutationOptions = {
  signal?: AbortSignal;
  /** @internal Test-only barrier after this process owns the registry lock. */
  __testOnlyAfterLockAcquired?: () => void | Promise<void>;
  __testOnlyAfterRead?: (registry: AgentRegistry) => void | Promise<void>;
};

/**
 * The single read-modify-write boundary for the runtime-agent registry.
 *
 * Agent manifests and lifecycle records are security-relevant state. Keep the
 * lock here, beside the state file, so startup reconciliation and gateway
 * lifecycle operations cannot publish stale complete-registry snapshots over
 * one another.
 */
export class AgentRegistryStore {
  readonly path: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async read(): Promise<AgentRegistry> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      return value?.schemaVersion === AGENT_REGISTRY_SCHEMA_VERSION && Array.isArray(value.agents)
        ? value
        : { schemaVersion: AGENT_REGISTRY_SCHEMA_VERSION, agents: [] };
    } catch (error: any) {
      if (error?.code === "ENOENT") return { schemaVersion: AGENT_REGISTRY_SCHEMA_VERSION, agents: [] };
      throw error;
    }
  }

  async list(): Promise<any[]> {
    return (await this.read()).agents;
  }

  async mutate<T>(operation: (agents: any[], registry: AgentRegistry) => T | Promise<T>, options: AgentRegistryMutationOptions = {}): Promise<T> {
    const pending = this.writeChain.then(() => withStateMutationLock(dirname(this.path), async () => {
      throwIfAgentMutationAborted(options.signal);
      const registry = await this.read();
      await reconcileAgentInstallStateUnlocked(dirname(this.path), registry.agents);
      await options.__testOnlyAfterRead?.(registry);
      throwIfAgentMutationAborted(options.signal);
      try {
        const result = await operation(registry.agents, registry);
        throwIfAgentMutationAborted(options.signal);
        await atomicWrite(this.path, `${JSON.stringify(registry, null, 2)}\n`, options.signal);
        // A successful registry publication commits a staged runtime-agent
        // install. Cleanup is deliberately best-effort: if the process dies
        // after the registry rename, startup reconciliation can prove the
        // active directory from the journal and remove the old backup.
        await reconcileAgentInstallStateUnlocked(dirname(this.path), (await this.read()).agents);
        return result;
      } catch (error) {
        // If an operation staged files and then failed before publishing the
        // registry, roll the directory transaction back while the lock is
        // still held. Preserve the original operation error.
        try { await reconcileAgentInstallStateUnlocked(dirname(this.path), (await this.read()).agents); } catch { /* startup will fail closed if recovery remains uncertain */ }
        throw error;
      }
    }, {
      signal: options.signal,
      __testOnlyAfterLockAcquired: options.__testOnlyAfterLockAcquired
    }));
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }
}

/**
 * Immutable provenance for one runtime-agent execution admission.
 *
 * The identity and prompt files are intentionally represented only by
 * digests.  The binding is safe to carry through graph requests and durable
 * audit projections while still making a later edit to the agent's workspace
 * observable as a provenance mismatch.
 */
export type AgentExecutionBinding = Readonly<{
  agentId: string;
  agentVersion: string;
  manifestIntegrity: string;
  identityContentDigest: string;
  resolvedSystemPromptDigest: string;
  modelConfigurationDigest: string;
}>;

export function validateAgentManifest(input: any): AgentManifest & { integrity: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("agent manifest must be an object");
  const id = String(input.id || "").trim();
  const version = String(input.version || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(id)) throw new Error("agent id must be lowercase and 2-64 characters");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error("agent version must be semantic");
  const identity = input.identity && typeof input.identity === "object" && !Array.isArray(input.identity) ? input.identity : {};
  const files = Array.isArray(identity.files) ? identity.files.map(String) : [];
  for (const file of files) assertIdentityFilename(file);
  const model = input.model && typeof input.model === "object" && !Array.isArray(input.model) ? input.model : {};
  const manifest: AgentManifest = {
    sdkVersion: String(input.sdkVersion || AGENT_SDK_VERSION),
    id,
    version,
    name: String(input.name || id).slice(0, 120),
    kind: input.kind === "runtime" ? "runtime" : "package",
    primary: input.primary === true,
    identity: { ...identity, files },
    instructions: stringArray(input.instructions),
    tools: stringArray(input.tools),
    plugins: stringArray(input.plugins),
    secrets: stringArray(input.secrets),
    sandbox: record(input.sandbox, { mode: "workspace-write" }),
    network: record(input.network, { default: "deny", allow: [] }),
    schedules: Array.isArray(input.schedules) ? input.schedules : [],
    channels: Array.isArray(input.channels) ? input.channels : [],
    memory: record(input.memory, {}),
    model: { default: String(model.default || ""), fallbacks: stringArray(model.fallbacks) }
  };
  const integrity = createHash("sha256").update(stableJson(manifest)).digest("hex");
  if (input.integrity && input.integrity !== integrity) throw new Error("agent manifest integrity mismatch");
  return { ...manifest, integrity };
}

export function defaultMainAgentManifest(): AgentManifest & { integrity: string } {
  return validateAgentManifest({
    sdkVersion: AGENT_SDK_VERSION,
    id: DEFAULT_AGENT_ID,
    version: "1.0.0",
    name: "Ódinn",
    kind: "runtime",
    primary: true,
    identity: { files: [...AGENT_IDENTITY_FILES] },
    instructions: [],
    tools: [],
    plugins: [],
    secrets: [],
    sandbox: { mode: "workspace-write" },
    network: { default: "policy" },
    schedules: [],
    channels: [],
    memory: { autoRecall: true, autoLearn: true, autoCompact: true },
    model: { default: "", fallbacks: [] }
  });
}

export type EnsureMainAgentOptions = {
  __testOnlyAfterRegistryRead?: (registry: AgentRegistry) => void | Promise<void>;
};

/**
 * Reconcile the primary agent during process startup. Ordinary execution must
 * not call this function: loading an agent is intentionally read-only so a
 * model request cannot rewrite lifecycle state from a stale registry copy.
 */
export async function ensureMainAgent(stateDir: string, options: EnsureMainAgentOptions = {}): Promise<AgentManifest & { integrity: string }> {
  const state = resolve(stateDir);
  await ensureSecureStateDirectory(state);
  const store = new AgentRegistryStore(join(state, "agents.json"));
  return store.mutate(async (agents, registry) => {
    const agentDirectory = join(state, "agents", DEFAULT_AGENT_ID);
    const manifestPath = join(agentDirectory, "agent.json");
    const brandNewAgent = !await anyFileExists([
      manifestPath,
      ...AGENT_IDENTITY_FILES.map((file) => join(agentDirectory, file)),
      join(agentDirectory, AGENT_BOOTSTRAP_FILE)
    ]);
    await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
    await chmod(agentDirectory, 0o700);
    let manifest: AgentManifest & { integrity: string };
    try {
      manifest = validateAgentManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      manifest = defaultMainAgentManifest();
      await writeExclusive(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    for (const file of AGENT_IDENTITY_FILES) {
      await writeExclusive(join(agentDirectory, file), MAIN_IDENTITY[file]).catch((error: any) => {
        if (error?.code !== "EEXIST") throw error;
      });
    }
    if (brandNewAgent) await writeExclusive(join(agentDirectory, AGENT_BOOTSTRAP_FILE), MAIN_BOOTSTRAP);
    registry.schemaVersion = AGENT_REGISTRY_SCHEMA_VERSION;
    registry.defaultAgentId ||= DEFAULT_AGENT_ID;
    const current = agents.findIndex((agent: any) => agent.id === DEFAULT_AGENT_ID);
    const record = { ...manifest, status: "enabled", installedAt: agents[current]?.installedAt ?? new Date().toISOString() };
    if (current < 0) agents.unshift(record);
    else if (agents[current]?.kind === "runtime") agents[current] = { ...agents[current], ...record };
    return manifest;
  }, {
    __testOnlyAfterRead: options.__testOnlyAfterRegistryRead
  });
}

export async function loadAgent(stateDir: string, agentId = DEFAULT_AGENT_ID): Promise<{ manifest: AgentManifest & { integrity: string }; systemPrompt: string; bootstrapPending: boolean; executionBinding: AgentExecutionBinding }> {
  const state = resolve(stateDir);
  // Loading is deliberately read-only. Startup paths call ensureMainAgent()
  // before execution; doing reconciliation here would allow every model
  // request to rewrite a stale complete registry and undo a lifecycle change.
  const registry = await new AgentRegistryStore(join(state, "agents.json")).read();
  const record = Array.isArray(registry?.agents) ? registry.agents.find((candidate: any) => candidate?.id === agentId) : undefined;
  if (!record || record.kind !== "runtime") throw new Error(`runtime agent is not installed: ${agentId}`);
  if (record.status !== "enabled") throw new Error(`runtime agent is not enabled: ${agentId}`);
  if (agentId !== DEFAULT_AGENT_ID && record.primary === true) throw new Error("only the main runtime agent may be primary");
  const directory = join(state, "agents", agentId);
  assertInside(resolve(state, "agents"), directory);
  const manifest = validateAgentManifest(JSON.parse(await readFile(join(directory, "agent.json"), "utf8")));
  if (manifest.id !== agentId || manifest.kind !== "runtime" || manifest.integrity !== record.integrity) {
    throw new Error(`runtime agent registry integrity mismatch: ${agentId}`);
  }
  const sections: string[] = [];
  const identityContents: { file: string; content: string }[] = [];
  const bootstrap = await readOptionalText(join(directory, AGENT_BOOTSTRAP_FILE));
  if (bootstrap.trim()) {
    sections.push(`## ${AGENT_BOOTSTRAP_FILE} — required first-run identity workflow\n${bootstrap.trim()}`);
  }
  for (const file of manifest.identity.files) {
    assertIdentityFilename(file);
    const rawContent = await readFile(join(directory, file), "utf8");
    identityContents.push({ file, content: rawContent });
    const content = rawContent.trim();
    if (content) sections.push(`## ${file}\n${content}`);
  }
  if (manifest.instructions.length) sections.push(`## Manifest instructions\n${manifest.instructions.join("\n")}`);
  const systemPrompt = sections.join("\n\n");
  const executionBinding: AgentExecutionBinding = Object.freeze({
    agentId: manifest.id,
    agentVersion: manifest.version,
    manifestIntegrity: manifest.integrity,
    identityContentDigest: digestStable({ bootstrap, files: identityContents }),
    resolvedSystemPromptDigest: digestStable(systemPrompt),
    modelConfigurationDigest: digestStable(manifest.model)
  });
  return { manifest, systemPrompt, bootstrapPending: Boolean(bootstrap.trim()), executionBinding };
}

export type RuntimeAgentProvisionOptions = {
  /** The caller already owns AgentRegistryStore's state mutation lock. */
  assumeLocked?: boolean;
  previousRecord?: any;
  nextRecord?: any;
  signal?: AbortSignal;
  __testOnlyAfterPhase?: (phase: AgentInstallJournal["phase"]) => void | Promise<void>;
};

export async function provisionRuntimeAgent(stateDir: string, input: unknown, options: RuntimeAgentProvisionOptions = {}): Promise<AgentManifest & { integrity: string }> {
  const state = resolve(stateDir);
  const execute = () => provisionRuntimeAgentUnlocked(state, input, options);
  return options.assumeLocked ? execute() : withStateMutationLock(state, execute, { signal: options.signal });
}

async function provisionRuntimeAgentUnlocked(state: string, input: unknown, options: RuntimeAgentProvisionOptions): Promise<AgentManifest & { integrity: string }> {
  throwIfAgentMutationAborted(options.signal);
  const manifest = validateAgentManifest(input);
  if (manifest.id === DEFAULT_AGENT_ID) throw new Error("the primary main agent cannot be provisioned through the runtime package path");
  if (manifest.kind !== "runtime" || manifest.primary) throw new Error("secondary runtime agents must use kind=runtime and primary=false");
  await ensureSecureStateDirectory(state);
  const agentsRoot = join(state, "agents");
  const directory = join(agentsRoot, manifest.id);
  const stagingDirectory = join(agentsRoot, AGENT_STAGING_DIRECTORY, `${manifest.id}-${randomUUID()}`);
  const backupDirectory = join(agentsRoot, AGENT_BACKUP_DIRECTORY, `${manifest.id}-${randomUUID()}`);
  assertInside(resolve(state, "agents"), directory);
  assertInside(resolve(state, "agents"), stagingDirectory);
  assertInside(resolve(state, "agents"), backupDirectory);
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  await chmod(stagingDirectory, 0o700);
  throwIfAgentMutationAborted(options.signal);
  await atomicWrite(join(stagingDirectory, "agent.json"), `${JSON.stringify(manifest, null, 2)}\n`, options.signal);
  for (const file of manifest.identity.files) {
    throwIfAgentMutationAborted(options.signal);
    await writeExclusive(join(stagingDirectory, file), "");
  }

  const journalPath = join(state, AGENT_INSTALL_JOURNAL);
  const journal = {
    schemaVersion: 1,
    id: manifest.id,
    phase: "staged",
    finalPath: relativeAgentPath(state, directory),
    stagingPath: relativeAgentPath(state, stagingDirectory),
    backupPath: relativeAgentPath(state, backupDirectory),
    previousIntegrity: typeof options.previousRecord?.integrity === "string" ? options.previousRecord.integrity : undefined,
    nextIntegrity: manifest.integrity,
    createdAt: new Date().toISOString()
  };
  await atomicWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`, options.signal);
  await options.__testOnlyAfterPhase?.("staged");
  throwIfAgentMutationAborted(options.signal);

  if (await pathExists(directory)) {
    await mkdir(dirname(backupDirectory), { recursive: true, mode: 0o700 });
    throwIfAgentMutationAborted(options.signal);
    await rename(directory, backupDirectory);
    const oldMoved = { ...journal, phase: "old-moved" as const };
    await atomicWrite(journalPath, `${JSON.stringify(oldMoved, null, 2)}\n`, options.signal);
    await options.__testOnlyAfterPhase?.("old-moved");
    throwIfAgentMutationAborted(options.signal);
  }
  throwIfAgentMutationAborted(options.signal);
  await rename(stagingDirectory, directory);
  const newInstalled = { ...journal, phase: "new-installed" as const };
  await atomicWrite(journalPath, `${JSON.stringify(newInstalled, null, 2)}\n`, options.signal);
  await options.__testOnlyAfterPhase?.("new-installed");
  throwIfAgentMutationAborted(options.signal);
  return manifest;
}

type AgentInstallJournal = {
  schemaVersion: 1;
  id: string;
  phase: "staged" | "old-moved" | "new-installed";
  finalPath: string;
  stagingPath: string;
  backupPath: string;
  previousIntegrity?: string;
  nextIntegrity: string;
  createdAt: string;
};

/** Recover or discard a directory transaction while the registry lock is held. */
async function reconcileAgentInstallStateUnlocked(state: string, agents: any[]): Promise<void> {
  const journalPath = join(state, AGENT_INSTALL_JOURNAL);
  let journal: AgentInstallJournal | undefined;
  try {
    journal = parseAgentInstallJournal(JSON.parse(await readFile(journalPath, "utf8")));
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (journal) {
    const agentsRoot = resolve(state, "agents");
    const finalPath = resolve(state, journal.finalPath);
    const stagingPath = resolve(state, journal.stagingPath);
    const backupPath = resolve(state, journal.backupPath);
    assertInside(agentsRoot, finalPath);
    assertInside(agentsRoot, stagingPath);
    assertInside(agentsRoot, backupPath);
    const current = agents.find((agent: any) => agent?.id === journal?.id);
    const committed = current?.integrity === journal.nextIntegrity;
    const prior = journal.previousIntegrity === undefined
      ? current === undefined
      : current?.integrity === journal.previousIntegrity;
    if (!committed && !prior) {
      throw new Error(`runtime agent install recovery is ambiguous: ${journal.id}`);
    }

    if (committed) {
      if (!await pathExists(finalPath)) {
        if (await pathExists(stagingPath)) await rename(stagingPath, finalPath);
        else throw new Error(`runtime agent install commit is missing its directory: ${journal.id}`);
      }
      await removeManagedPath(stagingPath);
      await removeManagedPath(backupPath);
    } else {
      if (await pathExists(backupPath)) {
        await removeManagedPath(finalPath);
        await rename(backupPath, finalPath);
      } else if (journal.previousIntegrity === undefined && await pathExists(finalPath)) {
        await removeManagedPath(finalPath);
      }
      await removeManagedPath(stagingPath);
    }
    await removeManagedPath(journalPath);
  }

  // A crash before the journal itself was durable can still leave a managed
  // staging directory behind. These names are generated by Odinn and never
  // contain user-controlled paths, so cleanup is bounded and recoverable.
  await removeManagedChildren(join(state, "agents", AGENT_STAGING_DIRECTORY));
  await removeManagedChildren(join(state, "agents", AGENT_BACKUP_DIRECTORY));
}

function parseAgentInstallJournal(input: any): AgentInstallJournal {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schemaVersion !== 1) {
    throw new Error("runtime agent install journal is invalid");
  }
  const id = String(input.id || "");
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(id)) throw new Error("runtime agent install journal id is invalid");
  const phase = input.phase;
  if (!new Set(["staged", "old-moved", "new-installed"]).has(phase)) throw new Error("runtime agent install journal phase is invalid");
  const result = {
    schemaVersion: 1 as const,
    id,
    phase,
    finalPath: String(input.finalPath || ""),
    stagingPath: String(input.stagingPath || ""),
    backupPath: String(input.backupPath || ""),
    previousIntegrity: input.previousIntegrity === undefined ? undefined : String(input.previousIntegrity),
    nextIntegrity: String(input.nextIntegrity || ""),
    createdAt: String(input.createdAt || "")
  } satisfies AgentInstallJournal;
  const finalPath = normalizeJournalPath(result.finalPath);
  const stagingPath = normalizeJournalPath(result.stagingPath);
  const backupPath = normalizeJournalPath(result.backupPath);
  const uuidSuffix = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (finalPath !== join("agents", id)) throw new Error("runtime agent install journal final path is invalid");
  if (!new RegExp(`^agents/${AGENT_STAGING_DIRECTORY}/${escapedId}-${uuidSuffix}$`, "u").test(stagingPath.replaceAll(sep, "/"))) throw new Error("runtime agent install journal staging path is invalid");
  if (!new RegExp(`^agents/${AGENT_BACKUP_DIRECTORY}/${escapedId}-${uuidSuffix}$`, "u").test(backupPath.replaceAll(sep, "/"))) throw new Error("runtime agent install journal backup path is invalid");
  if (!/^[a-f0-9]{64}$/u.test(result.nextIntegrity) || (result.previousIntegrity !== undefined && !/^[a-f0-9]{64}$/u.test(result.previousIntegrity))) {
    throw new Error("runtime agent install journal integrity is invalid");
  }
  return result;
}

function relativeAgentPath(state: string, path: string): string {
  const relative = path.slice(resolve(state).length + 1).split(sep).join("/");
  return relative;
}

function normalizeJournalPath(path: string): string {
  return path.split(/[\\/]+/u).join(sep);
}

async function removeManagedChildren(directory: string): Promise<void> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) await rm(target, { recursive: true, force: true });
      else await rm(target, { force: true });
    }
    await rm(directory, { recursive: true, force: true });
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function removeManagedPath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function record(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : fallback;
}

function assertIdentityFilename(file: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/u.test(file) || basename(file) !== file) {
    throw new Error(`agent identity file is unsafe: ${file}`);
  }
}

function assertInside(root: string, target: string): void {
  const resolved = resolve(target);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) throw new Error("agent path escapes agent state");
}

function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function digestStable(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

async function writeExclusive(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
}

async function atomicWrite(path: string, content: string, signal?: AbortSignal): Promise<void> {
  throwIfAgentMutationAborted(signal);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    throwIfAgentMutationAborted(signal);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function throwIfAgentMutationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("agent mutation was aborted");
}

async function anyFileExists(paths: string[]): Promise<boolean> {
  for (const path of paths) {
    try {
      await access(path);
      return true;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return false;
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}
