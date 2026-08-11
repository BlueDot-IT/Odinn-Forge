import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { AgentPackageStore } from "../apps/gateway/src/server.ts";

test("agent package mutations serialize across processes without lost updates", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "odinn-agent-package-lock-"));
  const path = join(state, "agents.json");
  const entered = join(state, "child-entered");
  const release = join(state, "child-release");
  const moduleUrl = pathToFileURL(join(process.cwd(), "apps/gateway/src/server.ts")).href;
  const childCode = [
    `import { access, writeFile } from "node:fs/promises";`,
    `import { AgentPackageStore } from ${JSON.stringify(moduleUrl)};`,
    `const store = new AgentPackageStore(${JSON.stringify(path)});`,
    `await store.mutate(async (agents) => {`,
    `  await writeFile(${JSON.stringify(entered)}, "ready");`,
    `  while (true) { try { await access(${JSON.stringify(release)}); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); } }`,
    `  agents.push({ id: "child", status: "disabled" });`,
    `});`
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 1_000 && !await fileExists(entered); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(await fileExists(entered), true, stderr || "child did not enter its mutation");

  const local = new AgentPackageStore(path);
  const localMutation = local.mutate((agents) => {
    agents.push({ id: "parent", status: "disabled" });
  });
  await new Promise((resolve) => setTimeout(resolve, 75));
  await writeFile(release, "release");
  const [childExit] = await Promise.all([
    new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    }),
    localMutation
  ]);
  assert.equal(childExit, 0, stderr);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(persisted.agents.map((agent: any) => agent.id).sort(), ["child", "parent"]);
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
