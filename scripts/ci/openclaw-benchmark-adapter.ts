import { realpath, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PINNED_OPENCLAW_VERSION = "2026.7.1-2";

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? String(args[index + 1] ?? "").trim() : "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function runOpenClawBenchmarkAdapter(args = process.argv.slice(2)): Promise<unknown> {
  const executable = await realpath(resolve(option(args, "--openclaw")));
  const packageRoot = dirname(executable);
  const packageMetadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (packageMetadata.name !== "openclaw" || packageMetadata.version !== PINNED_OPENCLAW_VERSION) {
    throw new Error(`--openclaw does not resolve to openclaw@${PINNED_OPENCLAW_VERSION}`);
  }
  const runtimeUrl = pathToFileURL(join(packageRoot, "dist", "plugin-sdk", "agent-runtime.js")).href;
  const runtime = await import(runtimeUrl) as { agentCommand?: (input: Record<string, unknown>) => Promise<unknown> };
  if (typeof runtime.agentCommand !== "function") throw new Error("pinned OpenClaw package does not export agentCommand");

  const prompt = await readFile(resolve(option(args, "--prompt-file")), "utf8");
  const trialId = option(args, "--trial-id");
  const result = await runtime.agentCommand({
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
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runOpenClawBenchmarkAdapter().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
