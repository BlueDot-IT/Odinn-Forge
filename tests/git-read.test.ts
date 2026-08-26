import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createAuditStore, createBuiltInRegistry, createRunLedger, diagnoseGitWorkspace, gitDiff, gitLog, gitStatus, runTask } from "../packages/kernel/src/index.ts";
import { createDefaultPolicy } from "../packages/policy/src/index.ts";

const executeFile = promisify(execFile);

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "odinn-git-read-"));
  const stateDir = join(root, ".odinn");
  await executeFile("git", ["init", "-q", "-b", "main", root]);
  await executeFile("git", ["-C", root, "config", "user.name", "Odinn Test"]);
  await executeFile("git", ["-C", root, "config", "user.email", "odinn@example.invalid"]);
  await writeFile(join(root, "tracked.txt"), "before\n", "utf8");
  await executeFile("git", ["-C", root, "add", "tracked.txt"]);
  await executeFile("git", ["-C", root, "commit", "-q", "-m", "fixture commit"]);
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir });
  const ledger = createRunLedger({ stateDir, workspaceRoot: root });
  t.after(async () => { ledger.close(); registry.close(); auditStore.close(); await rm(root, { recursive: true, force: true }); });
  return { root, stateDir, auditStore, registry, ledger };
}

test("local Git reads are bounded, network-free, and registered under git.read", async (t) => {
  const value = await fixture(t);
  await writeFile(join(value.root, "tracked.txt"), "after\n", "utf8");
  await writeFile(join(value.root, "new.txt"), "new\n", "utf8");
  assert.deepEqual((await diagnoseGitWorkspace(value.root)), { available: true, repository: true, worktree: true, readOnly: true, networkAccess: false, headState: "attached" });
  const status = await gitStatus(value.root, { limit: 10 });
  assert.deepEqual(status.entries.map((entry) => entry.path).sort(), ["new.txt", "tracked.txt"]);
  const diff = await gitDiff(value.root, { path: "tracked.txt", maxBytes: 4_096 });
  assert.match(diff.patch, /-before[\s\S]*\+after/u);
  assert.match(diff.patchDigest, /^sha256:[a-f0-9]{64}$/u);
  const log = await gitLog(value.root, { limit: 1 });
  assert.equal(log.commits[0]?.subject, "fixture commit");
  for (const name of ["git.status", "git.diff", "git.log"]) {
    assert.deepEqual(value.registry.get(name)?.capabilities, ["git.read"]);
  }
});

test("Git reads reject traversal, metadata access, remote syntax, and malicious executable overrides", async (t) => {
  const value = await fixture(t);
  for (const path of ["../outside", ".git/config", "nested/.git/config", "/etc/passwd", "C:outside"]) {
    await assert.rejects(gitDiff(value.root, { path }), /Git path/u);
  }
  for (const ref of ["origin/main", "https://example.invalid/repo", "HEAD~1", "refs/remotes/origin/main", "--output=x"]) {
    await assert.rejects(gitLog(value.root, { ref }), /Git ref/u);
  }
  const original = process.env.ODINN_GIT_EXECUTABLE;
  process.env.ODINN_GIT_EXECUTABLE = "git";
  try { await assert.rejects(gitStatus(value.root), /absolute path/u); }
  finally { if (original === undefined) delete process.env.ODINN_GIT_EXECUTABLE; else process.env.ODINN_GIT_EXECUTABLE = original; }
});

test("Git content is returned live but excluded from durable audit and ledger state", async (t) => {
  const value = await fixture(t);
  const sentinel = "PRIVATE_GIT_PATCH_3f6de4";
  await writeFile(join(value.root, "tracked.txt"), `${sentinel}\n`, "utf8");
  const result = await runTask({
    task: { id: "git-diff-private", tool: "git.diff", input: { path: "tracked.txt" }, actor: "git-test" },
    auditStore: value.auditStore,
    registry: value.registry,
    runLedger: value.ledger,
    policy: createDefaultPolicy({ capabilityRegistryVersion: 1, allowedCapabilities: ["git.read"] })
  });
  assert.match(result.output.patch, new RegExp(sentinel, "u"));
  const replay = await runTask({
    task: { id: "git-diff-private", tool: "git.diff", input: { path: "tracked.txt" }, actor: "git-test" },
    auditStore: value.auditStore,
    registry: value.registry,
    runLedger: value.ledger,
    policy: createDefaultPolicy({ capabilityRegistryVersion: 1, allowedCapabilities: ["git.read"] })
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.contentUnavailableOnReplay, true);
  assert.equal("patch" in replay.output, false);
  const durable = `${(await value.auditStore.readAll()).map(JSON.stringify).join("\n")}\n${await readFile(join(value.stateDir, "runs.jsonl"), "utf8").catch(() => "")}`;
  assert.doesNotMatch(durable, new RegExp(sentinel, "u"));
});
