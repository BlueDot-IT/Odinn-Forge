import assert from "node:assert/strict";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { PluginLifecycleService } from "../packages/kernel/src/plugin-lifecycle.ts";
import { packPluginPackage, scaffoldPlugin, verifyPluginPackageDirectory } from "../packages/kernel/src/plugin-packages.ts";
import { createStateBackup, restoreStateBackup } from "../packages/kernel/src/state/backup-manager.ts";
import { ensureStateCompatibility, recoverInterruptedStateMigration } from "../packages/kernel/src/state/migration-manager.ts";
import { removeManagedStateTree } from "../packages/kernel/src/state/state-tree.ts";

async function removeFixture(root: string): Promise<void> {
  const metadata = await lstat(root);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    await chmod(root, 0o700);
    for (const name of await readdir(root)) await removeFixture(join(root, name));
    await rm(root, { recursive: true });
  } else await rm(root, { force: true });
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "odinn-plugin-state-"));
  t.after(() => removeFixture(root));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const state = join(workspace, ".odinn");
  await cp(new URL("./fixtures/state/latest-pre-v1", import.meta.url), state, { recursive: true });
  const source = join(root, "source");
  await scaffoldPlugin(source, "state-fixture", `node@sha256:${"a".repeat(64)}`);
  await mkdir(join(source, "lib"));
  await writeFile(join(source, "lib", "support.mjs"), "export const fixture = true;\n");
  const archive = join(root, "fixture.zip");
  const packed = await packPluginPackage(source, archive);
  const service = new PluginLifecycleService({ workspaceRoot: workspace, stateDir: state, auditStore: { append: async () => {} } });
  const record = await service.install(archive, { expectedDigest: packed.digest });
  return { root, workspace, state, record };
}

test("migration disposes sealed installed packages without unsealing active or backup copies", { skip: process.platform === "win32" }, async (t) => {
  const { workspace, state, record } = await fixture(t);
  const report = await ensureStateCompatibility(state);
  assert.ok(report?.backupLocation);
  await verifyPluginPackageDirectory(record.packageRoot, record.contentDigest);
  await verifyPluginPackageDirectory(join(report.backupLocation, relative(state, record.packageRoot)), record.contentDigest);
  assert.equal((await lstat(record.packageRoot)).mode & 0o777, 0o500);
  assert.equal((await lstat(join(record.packageRoot, "server.mjs"))).mode & 0o777, 0o400);
  assert.equal((await readdir(workspace)).some((name) => name.startsWith("..odinn.migration-")), false);
});

test("backup and restore preserve sealed package integrity and clean the displaced installation", { skip: process.platform === "win32" }, async (t) => {
  const { root, workspace, state, record } = await fixture(t);
  await ensureStateCompatibility(state);
  const backup = join(root, "backup");
  const created = await createStateBackup(state, backup);
  assert.ok(created.manifest.files.some((file) => file.path === relative(state, join(record.packageRoot, "server.mjs"))));
  await verifyPluginPackageDirectory(join(backup, relative(state, record.packageRoot)), record.contentDigest);
  const result = await restoreStateBackup(backup, state);
  assert.equal(result.ok, true);
  assert.equal(result.auditIntegrity.valid, true);
  assert.ok(result.preRestoreBackup);
  await verifyPluginPackageDirectory(record.packageRoot, record.contentDigest);
  assert.equal((await readdir(workspace)).some((name) => name.startsWith("..odinn.restore-")), false);
});

for (const phase of ["staging-verified", "activated"] as const) {
  test(`interrupted migration at ${phase} cleans sealed package trees`, { skip: process.platform === "win32" }, async (t) => {
    const { workspace, state, record } = await fixture(t);
    await assert.rejects(() => ensureStateCompatibility(state, {
      onPhase: (current) => { if (current === phase) throw new Error("fixture interruption"); }
    }), /fixture interruption/u);
    assert.equal(await recoverInterruptedStateMigration(state), true);
    await verifyPluginPackageDirectory(record.packageRoot, record.contentDigest);
    assert.equal((await readdir(workspace)).some((name) => name.startsWith("..odinn.migration-")), false);
  });
}

test("managed state cleanup rejects unrelated roots and does not follow symbolic links", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-plugin-cleanup-"));
  t.after(() => removeFixture(root));
  const target = join(root, "state");
  const outside = join(root, "unrelated");
  await mkdir(outside, { mode: 0o500 });
  await chmod(outside, 0o700);
  await writeFile(join(outside, "keep.txt"), "unchanged\n", { mode: 0o400 });
  await chmod(outside, 0o500);
  await assert.rejects(() => removeManagedStateTree(outside, target), /unsafe lifecycle cleanup path/u);
  const linkedRoot = join(root, ".state.restore-old-linked");
  await symlink(outside, linkedRoot);
  await assert.rejects(() => removeManagedStateTree(linkedRoot, target), /physical directory/u);
  const displaced = join(root, ".state.restore-old-fixture");
  await mkdir(displaced);
  await symlink(outside, join(displaced, "link"));
  await chmod(displaced, 0o500);
  await removeManagedStateTree(displaced, target);
  await assert.rejects(lstat(displaced), { code: "ENOENT" });
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "unchanged\n");
  assert.equal((await lstat(outside)).mode & 0o777, 0o500);
  assert.equal((await lstat(join(outside, "keep.txt"))).mode & 0o777, 0o400);
});
