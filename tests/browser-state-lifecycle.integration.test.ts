import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  closeBrowserManagers,
  createAuditStore,
  createBuiltInRegistry,
  runTask
} from "../packages/kernel/src/index.ts";

const root = new URL("..", import.meta.url).pathname;

test("macOS browser use leaves state auditable and exactly back-up-able", { skip: process.platform !== "darwin", timeout: 60_000 }, async () => {
  const executable = await installedMacChromium();
  assert.ok(executable, "supported macOS browser lifecycle gate requires Google Chrome or Chromium");
  const fixture = await mkdtemp(join(tmpdir(), "odinn-browser-state-lifecycle-"));
  const state = join(fixture, "state");
  const workspace = join(fixture, "workspace");
  const backup = join(fixture, "backup");
  const previousExecutable = process.env.ODINN_CHROMIUM_PATH;
  const previousHeadless = process.env.ODINN_BROWSER_HEADLESS;
  process.env.ODINN_CHROMIUM_PATH = executable;
  process.env.ODINN_BROWSER_HEADLESS = "1";
  try {
    const initialized = cli(["init", "--state", state]);
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    const auditStore = createAuditStore(join(state, "audit.jsonl"));
    try {
      const registry = createBuiltInRegistry({ workspaceRoot: workspace, stateDir: state, auditStore });
      const opened = await runTask({
        task: { id: "run_macos_browser_lifecycle", tool: "browser.open", input: { url: "https://example.com" }, actor: "test" },
        auditStore,
        registry
      });
      assert.equal(opened.ok, true);
    } finally {
      await closeBrowserManagers();
      auditStore.close();
    }

    await assert.rejects(access(join(state, "browser-profile")), { code: "ENOENT" });
    const verified = cli(["audit", "verify", "--allow-unsigned", "--state", state]);
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);
    assert.equal(JSON.parse(verified.stdout).valid, true);
    const created = cli(["state", "backup", "--output", backup, "--state", state]);
    assert.equal(created.status, 0, created.stderr || created.stdout);

    const manifest = JSON.parse(await readFile(join(backup, "backup-manifest.json"), "utf8"));
    assert.deepEqual(
      await recursiveFiles(backup),
      [...manifest.files.map((file: { path: string }) => file.path), "backup-manifest.json"].sort()
    );
  } finally {
    if (previousExecutable === undefined) delete process.env.ODINN_CHROMIUM_PATH;
    else process.env.ODINN_CHROMIUM_PATH = previousExecutable;
    if (previousHeadless === undefined) delete process.env.ODINN_BROWSER_HEADLESS;
    else process.env.ODINN_BROWSER_HEADLESS = previousHeadless;
    await closeBrowserManagers();
    await rm(fixture, { recursive: true, force: true });
  }
});

function cli(args: string[]) {
  return spawnSync(process.execPath, ["apps/cli/src/cli.ts", ...args], { cwd: root, encoding: "utf8" });
}

async function installedMacChromium(): Promise<string | undefined> {
  for (const candidate of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ]) {
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  return undefined;
}

async function recursiveFiles(directory: string, rootDirectory = directory): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await recursiveFiles(path, rootDirectory));
    else files.push(path.slice(rootDirectory.length + 1).replaceAll("\\", "/"));
  }
  return files.sort();
}
