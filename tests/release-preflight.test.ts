import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const preflightScriptPath = join(repoRoot, "scripts/release/preflight.ts");

const requiredFiles = [
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "docs/user-guide.md",
  "docs/surface-matrix.md",
  "docs/v1-compatibility.md",
  "scripts/build-production.ts",
  "pnpm-lock.yaml",
  ".github/ISSUE_TEMPLATE/bug-report.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/security.yml",
  ".github/workflows/release.yml"
];

async function setupTestRepo(initialVersion = "1.2.3-rc.1"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "odinn-preflight-test-"));

  spawnSync("git", ["init", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test Runner"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });

  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "odinn", version: initialVersion }, null, 2));

  for (const relPath of requiredFiles) {
    const fullPath = join(dir, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, `# ${relPath}\n`);
  }

  const scriptDir = join(dir, "scripts/release");
  await mkdir(scriptDir, { recursive: true });
  const scriptContent = await readFile(preflightScriptPath, "utf8");
  await writeFile(join(scriptDir, "preflight.ts"), scriptContent);

  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "initial commit"], { cwd: dir });

  return dir;
}

function runPreflight(cwd: string, env: Record<string, string> = {}) {
  return spawnSync("node", ["scripts/release/preflight.ts"], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "true",
      ...env
    }
  });
}

test("release preflight passes when tag matches exact HEAD commit", async () => {
  const dir = await setupTestRepo("1.2.3-rc.1");
  try {
    spawnSync("git", ["tag", "-a", "v1.2.3-rc.1", "-m", "tag v1.2.3-rc.1"], { cwd: dir });

    const resWithTag = runPreflight(dir, { ODINN_RELEASE_TAG: "v1.2.3-rc.1" });
    assert.equal(resWithTag.status, 0, `Expected 0 but got error: ${resWithTag.stderr}`);

    const resNoTag = runPreflight(dir);
    assert.equal(resNoTag.status, 0, `Expected 0 but got error: ${resNoTag.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release preflight fails when development HEAD is ahead of existing tag", async () => {
  const dir = await setupTestRepo("1.2.3-rc.1");
  try {
    spawnSync("git", ["tag", "-a", "v1.2.3-rc.1", "-m", "tag v1.2.3-rc.1"], { cwd: dir });

    await writeFile(join(dir, "README.md"), "# Updated README\n");
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-m", "first change after tag"], { cwd: dir });

    const res = runPreflight(dir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /development HEAD is ahead of published v1\.2\.3-rc\.1; bump the package version before building/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release preflight passes for untagged prerelease version", async () => {
  const dir = await setupTestRepo("1.2.3-rc.2");
  try {
    const res = runPreflight(dir);
    assert.equal(res.status, 0, `Expected 0 but got error: ${res.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pull request events do NOT bypass the stale version check", async () => {
  const dir = await setupTestRepo("1.2.3-rc.1");
  try {
    spawnSync("git", ["tag", "-a", "v1.2.3-rc.1", "-m", "tag v1.2.3-rc.1"], { cwd: dir });

    await writeFile(join(dir, "README.md"), "# PR change\n");
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-m", "PR commit"], { cwd: dir });

    const res = runPreflight(dir, { GITHUB_EVENT_NAME: "pull_request" });
    assert.equal(res.status, 1, "Preflight must fail on PR when reusing published tag");
    assert.match(res.stderr, /development HEAD is ahead of published v1\.2\.3-rc\.1; bump the package version before building/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release preflight fails for malformed package version", async () => {
  const dir = await setupTestRepo("invalid-version-string");
  try {
    const res = runPreflight(dir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /invalid package version invalid-version-string/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release preflight fails when release tag cannot be resolved or is missing", async () => {
  const dir = await setupTestRepo("1.2.3-rc.1");
  try {
    const res = runPreflight(dir, { ODINN_RELEASE_TAG: "v1.2.3-rc.1" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /could not resolve tag v1\.2\.3-rc\.1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release preflight fails in shallow repository", async () => {
  const sourceDir = await setupTestRepo("1.2.3-rc.1");
  const shallowDir = await mkdtemp(join(tmpdir(), "odinn-shallow-test-"));
  try {
    spawnSync("git", ["clone", "--depth", "1", `file://${sourceDir}`, shallowDir]);
    const res = runPreflight(shallowDir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /shallow repository detected; full tag history is required/);
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(shallowDir, { recursive: true, force: true });
  }
});
