import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ensureSecureStateDirectory } from "@odinn/store-file";

export const AGENT_SDK_VERSION = "1.0";
export const DEFAULT_AGENT_ID = "main";
export const AGENT_IDENTITY_FILES = Object.freeze(["IDENTITY.md", "SOUL.md", "USER.md", "AGENTS.md"]);
export const AGENT_BOOTSTRAP_FILE = "BOOTSTRAP.md";

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

export async function ensureMainAgent(stateDir: string): Promise<AgentManifest & { integrity: string }> {
  const state = resolve(stateDir);
  await ensureSecureStateDirectory(state);
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
  const registryPath = join(state, "agents.json");
  let registry: any;
  try {
    registry = JSON.parse(await readFile(registryPath, "utf8"));
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    registry = { schemaVersion: 1, defaultAgentId: DEFAULT_AGENT_ID, agents: [] };
  }
  if (!Array.isArray(registry.agents)) registry.agents = [];
  registry.schemaVersion = 1;
  registry.defaultAgentId ||= DEFAULT_AGENT_ID;
  const current = registry.agents.findIndex((agent: any) => agent.id === DEFAULT_AGENT_ID);
  const record = { ...manifest, status: "enabled", installedAt: registry.agents[current]?.installedAt ?? new Date().toISOString() };
  if (current < 0) registry.agents.unshift(record);
  else if (registry.agents[current]?.kind === "runtime") registry.agents[current] = { ...registry.agents[current], ...record };
  await atomicWrite(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  return manifest;
}

export async function loadAgent(stateDir: string, agentId = DEFAULT_AGENT_ID): Promise<{ manifest: AgentManifest & { integrity: string }; systemPrompt: string; bootstrapPending: boolean }> {
  const state = resolve(stateDir);
  if (agentId === DEFAULT_AGENT_ID) await ensureMainAgent(state);
  const directory = join(state, "agents", agentId);
  assertInside(resolve(state, "agents"), directory);
  const manifest = validateAgentManifest(JSON.parse(await readFile(join(directory, "agent.json"), "utf8")));
  const sections: string[] = [];
  const bootstrap = await readOptionalText(join(directory, AGENT_BOOTSTRAP_FILE));
  if (bootstrap.trim()) {
    sections.push(`## ${AGENT_BOOTSTRAP_FILE} — required first-run identity workflow\n${bootstrap.trim()}`);
  }
  for (const file of manifest.identity.files) {
    assertIdentityFilename(file);
    const content = (await readFile(join(directory, file), "utf8")).trim();
    if (content) sections.push(`## ${file}\n${content}`);
  }
  if (manifest.instructions.length) sections.push(`## Manifest instructions\n${manifest.instructions.join("\n")}`);
  return { manifest, systemPrompt: sections.join("\n\n"), bootstrapPending: Boolean(bootstrap.trim()) };
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

async function writeExclusive(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
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
