import { realpath, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PINNED_OPENCLAW_VERSION = "2026.7.1-2";

type PinnedOpenClawRuntime = {
  agentCommand?: (input: Record<string, unknown>) => Promise<unknown>;
  clearRuntimeAuthProfileStoreSnapshots?: () => void;
  replaceRuntimeAuthProfileStoreSnapshots?: (entries: Array<{ agentDir: string; store: unknown }>) => void;
};

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? String(args[index + 1] ?? "").trim() : "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredEnvironment(name: string): string {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertBenchmarkAuthStore(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("isolated OpenClaw benchmark auth store must be an object");
  }
  const store = value as { version?: unknown; profiles?: unknown };
  const profiles = store.profiles;
  if (store.version !== 1 || !profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    throw new Error("isolated OpenClaw benchmark auth store has an invalid schema");
  }
  const entries = Object.entries(profiles);
  const credential = (profiles as Record<string, unknown>)["openai:benchmark"];
  if (entries.length !== 1 || !credential || typeof credential !== "object" || Array.isArray(credential)) {
    throw new Error("isolated OpenClaw benchmark auth store must contain only openai:benchmark");
  }
  const oauth = credential as Record<string, unknown>;
  if (oauth.type !== "oauth" || oauth.provider !== "openai"
    || typeof oauth.access !== "string" || !oauth.access
    || typeof oauth.refresh !== "string" || !oauth.refresh
    || typeof oauth.expires !== "number" || !Number.isFinite(oauth.expires)) {
    throw new Error("isolated OpenClaw benchmark OAuth profile is incomplete");
  }
}

async function withRuntimeDiagnosticsOnStderr<T>(operation: () => Promise<T>): Promise<T> {
  const original = {
    debug: console.debug,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const route = (...values: unknown[]) => console.error(...values);
  (process.stdout as any).write = (...values: unknown[]) => Reflect.apply(stderrWrite, process.stderr, values);
  console.debug = route;
  console.info = route;
  console.log = route;
  console.warn = route;
  try {
    return await operation();
  } finally {
    process.stdout.write = stdoutWrite;
    console.debug = original.debug;
    console.info = original.info;
    console.log = original.log;
    console.warn = original.warn;
  }
}

export async function runOpenClawBenchmarkAdapter(args = process.argv.slice(2)): Promise<unknown> {
  const executable = await realpath(resolve(option(args, "--openclaw")));
  const packageRoot = dirname(executable);
  const packageMetadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (packageMetadata.name !== "openclaw" || packageMetadata.version !== PINNED_OPENCLAW_VERSION) {
    throw new Error(`--openclaw does not resolve to openclaw@${PINNED_OPENCLAW_VERSION}`);
  }
  const runtimeUrl = pathToFileURL(join(packageRoot, "dist", "plugin-sdk", "agent-runtime.js")).href;
  const runtime = await import(runtimeUrl) as PinnedOpenClawRuntime;
  if (typeof runtime.agentCommand !== "function"
    || typeof runtime.replaceRuntimeAuthProfileStoreSnapshots !== "function"
    || typeof runtime.clearRuntimeAuthProfileStoreSnapshots !== "function") {
    throw new Error("pinned OpenClaw package does not export the prepared-runtime contract");
  }

  const stateRoot = resolve(requiredEnvironment("OPENCLAW_STATE_DIR"));
  const agentDir = await realpath(join(stateRoot, "agents", "main", "agent"));
  const authStore = JSON.parse(await readFile(join(agentDir, "auth-profiles.json"), "utf8"));
  assertBenchmarkAuthStore(authStore);
  try {
    runtime.replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: authStore }]);
    const prompt = await readFile(resolve(option(args, "--prompt-file")), "utf8");
    const trialId = option(args, "--trial-id");
    const result = await withRuntimeDiagnosticsOnStderr(() => runtime.agentCommand!({
      message: prompt,
      agentId: "main",
      model: "openai/gpt-5.6-luna",
      sessionKey: `agent:main:${trialId}`,
      runId: trialId,
      timeout: "300",
      json: true,
      cleanupBundleMcpOnRunEnd: true,
      cleanupCliLiveSessionOnRunEnd: true,
      oneShotCliRun: true,
    }));
    if (result === undefined) {
      throw new Error("pinned OpenClaw agentCommand returned no benchmark result");
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    runtime.clearRuntimeAuthProfileStoreSnapshots();
  }
}

if (process.argv.includes("--openclaw") && process.argv.includes("--prompt-file")) {
  try {
    await runOpenClawBenchmarkAdapter();
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
