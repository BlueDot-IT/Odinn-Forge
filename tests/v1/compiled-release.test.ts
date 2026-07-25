import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const packageRoot = join(root, "dist", "package-stage", `odinn-v${pkg.version}`);

async function walk(directory: string, prefix = ""): Promise<string[]> {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(join(directory, entry.name), name));
    else files.push(name);
  }
  return files;
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32" && command.endsWith(".cmd")
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("production package contains compiled runtime files and no workspace install path", async () => {
  const files = await walk(packageRoot);
  assert.ok(files.includes("dist/cli/index.js"));
  assert.ok(files.includes("dist/gateway/server.js"));
  assert.ok(files.includes("dist/workers/task-worker.js"));
  assert.ok(files.includes("node_modules/playwright-core/package.json"));
  assert.ok(files.some((path) => path.endsWith(".js.map")), "production source maps must be present");
  assert.equal(files.some((path) => /\.(?:ts|tsx|mts|cts)$/.test(path)), false);
  assert.equal(files.some((path) => /(^|\/)tests?(\/|$)/i.test(path)), false);
  assert.equal(files.includes("pnpm-lock.yaml"), false);

  const productionPackage = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(productionPackage.engines.node, ">=24.0.0");
  assert.deepEqual(productionPackage.dependencies, { "playwright-core": "1.61.1" });
  assert.equal(productionPackage.devDependencies, undefined);
  assert.equal(productionPackage.packageManager, undefined);

  for (const launcher of ["bin/odinn", "bin/odinn.cmd", "bin/odinn-gateway", "bin/odinn-gateway.cmd"]) {
    const content = await readFile(join(packageRoot, launcher), "utf8");
    assert.doesNotMatch(content, /apps[/\\].*src|\.ts\b|pnpm|corepack/i);
  }
});

test("production package runs without pnpm or a source checkout", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-compiled-release-test-"));
  const state = join(temporary, "state");
  const workspace = join(temporary, "workspace");
  const cli = join(packageRoot, "bin", process.platform === "win32" ? "odinn.cmd" : "odinn");
  try {
    await mkdir(workspace, { recursive: true });
    assert.equal(run(cli, ["--version"], workspace).trim(), pkg.version);
    run(cli, ["onboard", "--state", state], workspace);
    const inputFile = join(workspace, "compiled-release-input.json");
    await writeFile(inputFile, `${JSON.stringify({ text: "ODINN_COMPILED_TEST_OK" })}\n`);
    const tool = run(cli, [
      "run",
      "--tool",
      "text.echo",
      "--input-file",
      inputFile,
      "--state",
      state
    ], workspace);
    assert.match(tool, /ODINN_COMPILED_TEST_OK/);
    const lifecycleHelp = run(cli, ["help", "--all"], workspace);
    for (const command of ["odinn update check", "odinn rollback", "odinn backup", "odinn restore", "odinn uninstall", "odinn state status"]) {
      assert.match(lifecycleHelp, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    const stateStatus = JSON.parse(run(cli, ["state", "status", "--state", state], workspace));
    assert.equal(stateStatus.ok, true);
    assert.equal(stateStatus.pendingMigration, false);

    const marker = join(state, "lifecycle-marker.txt");
    const backup = join(temporary, "backup");
    await writeFile(marker, "before backup\n");
    const backupResult = JSON.parse(run(cli, ["backup", "--output", backup, "--state", state], workspace));
    assert.equal(backupResult.ok, true);
    await writeFile(marker, "after backup\n");
    const restoreResult = JSON.parse(run(cli, ["restore", "--input", backup, "--confirm", "--state", state], workspace));
    assert.equal(restoreResult.ok, true);
    assert.equal(await readFile(marker, "utf8"), "before backup\n");
    assert.match(run(cli, ["runs", "--state", state], workspace), /text\.echo/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
