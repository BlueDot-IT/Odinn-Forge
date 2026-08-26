import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("OpenClaw benchmark adapter serializes the embedded agent result", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-openclaw-adapter-"));
  const packageRoot = join(root, "openclaw");
  const executable = join(packageRoot, "openclaw.mjs");
  const runtime = join(packageRoot, "dist", "plugin-sdk", "agent-runtime.js");
  const stateRoot = join(root, "state");
  const agentDir = join(stateRoot, "agents", "main", "agent");
  const prompt = join(root, "prompt.md");
  await Promise.all([
    mkdir(join(packageRoot, "dist", "plugin-sdk"), { recursive: true }),
    mkdir(agentDir, { recursive: true }),
  ]);
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({ name: "openclaw", version: "2026.7.1-2", type: "module" })}\n`);
  await writeFile(executable, "#!/usr/bin/env node\n", { mode: 0o700 });
  await chmod(executable, 0o700);
  await writeFile(runtime, `let snapshots = [];
export function replaceRuntimeAuthProfileStoreSnapshots(entries) { snapshots = entries; }
export function clearRuntimeAuthProfileStoreSnapshots() { snapshots = []; }
export async function agentCommand(input) {
  const credential = snapshots[0]?.store?.profiles?.["openai:benchmark"];
  if (credential?.type !== "oauth" || credential?.provider !== "openai") throw new Error("missing benchmark OAuth snapshot");
  console.log("[agents/tools] synthetic runtime diagnostic");
  return { payloads: [{ text: input.message.trim() }], meta: { agentMeta: { provider: "openai", model: input.model } } };
}\n`);
  await writeFile(join(agentDir, "auth-profiles.json"), `${JSON.stringify({
    version: 1,
    profiles: {
      "openai:benchmark": {
        type: "oauth",
        provider: "openai",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: Date.now() + 8 * 60 * 60 * 1_000,
      },
    },
  })}\n`, { mode: 0o600 });
  await writeFile(prompt, "AGENT_BENCH_PREFLIGHT_OK\n");

  const result = spawnSync(process.execPath, [
    new URL("../scripts/ci/openclaw-benchmark-adapter.ts", import.meta.url).pathname,
    "--openclaw", executable,
    "--trial-id", "preflight",
    "--prompt-file", prompt,
  ], { encoding: "utf8", env: { ...process.env, OPENCLAW_STATE_DIR: stateRoot } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.payloads[0].text, "AGENT_BENCH_PREFLIGHT_OK");
  assert.equal(output.meta.agentMeta.model, "openai/gpt-5.6-luna");
  assert.match(result.stderr, /\[agents\/tools\] synthetic runtime diagnostic/u);
  assert.equal((await readFile(prompt, "utf8")).trim(), output.payloads[0].text);
});

test("OpenClaw benchmark adapter rejects an unpinned package version", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-openclaw-adapter-version-"));
  const packageRoot = join(root, "openclaw");
  const executable = join(packageRoot, "openclaw.mjs");
  const prompt = join(root, "prompt.md");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({ name: "openclaw", version: "2026.7.2", type: "module" })}\n`);
  await writeFile(executable, "#!/usr/bin/env node\n", { mode: 0o700 });
  await chmod(executable, 0o700);
  await writeFile(prompt, "AGENT_BENCH_PREFLIGHT_OK\n");

  const result = spawnSync(process.execPath, [
    new URL("../scripts/ci/openclaw-benchmark-adapter.ts", import.meta.url).pathname,
    "--openclaw", executable,
    "--trial-id", "preflight",
    "--prompt-file", prompt,
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not resolve to openclaw@2026\.7\.1-2/u);
});

test("OpenClaw benchmark adapter clears the auth snapshot when prompt loading fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-openclaw-adapter-cleanup-"));
  const packageRoot = join(root, "openclaw");
  const executable = join(packageRoot, "openclaw.mjs");
  const runtime = join(packageRoot, "dist", "plugin-sdk", "agent-runtime.js");
  const stateRoot = join(root, "state");
  const agentDir = join(stateRoot, "agents", "main", "agent");
  const marker = join(root, "snapshot-cleared.txt");
  await Promise.all([
    mkdir(join(packageRoot, "dist", "plugin-sdk"), { recursive: true }),
    mkdir(agentDir, { recursive: true }),
  ]);
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({ name: "openclaw", version: "2026.7.1-2", type: "module" })}\n`);
  await writeFile(executable, "#!/usr/bin/env node\n", { mode: 0o700 });
  await chmod(executable, 0o700);
  await writeFile(runtime, `import { writeFileSync } from "node:fs";
let snapshots = [];
export function replaceRuntimeAuthProfileStoreSnapshots(entries) { snapshots = entries; }
export function clearRuntimeAuthProfileStoreSnapshots() {
  snapshots = [];
  writeFileSync(process.env.SNAPSHOT_CLEAR_MARKER, "cleared\\n");
}
export async function agentCommand() { throw new Error("agentCommand must not run"); }
\n`);
  await writeFile(join(agentDir, "auth-profiles.json"), `${JSON.stringify({
    version: 1,
    profiles: {
      "openai:benchmark": {
        type: "oauth",
        provider: "openai",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: Date.now() + 8 * 60 * 60 * 1_000,
      },
    },
  })}\n`, { mode: 0o600 });

  const result = spawnSync(process.execPath, [
    new URL("../scripts/ci/openclaw-benchmark-adapter.ts", import.meta.url).pathname,
    "--openclaw", executable,
    "--trial-id", "missing-prompt",
    "--prompt-file", join(root, "missing.md"),
  ], {
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_STATE_DIR: stateRoot, SNAPSHOT_CLEAR_MARKER: marker },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/u);
  assert.equal(await readFile(marker, "utf8"), "cleared\n");
});
