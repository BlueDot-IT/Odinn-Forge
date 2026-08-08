import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBuiltInRegistry } from "../packages/kernel/src/index.ts";
import { createWorkspaceMutationTools } from "../packages/kernel/src/workspace-mutations.ts";

test("workspace mutation tools stay unavailable in default registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-registry-"));
  const registry = createBuiltInRegistry({ workspaceRoot: root });
  const mutationTools = ["workspace.write", "workspace.edit", "workspace.applyPatch", "workspace.mkdir", "workspace.remove", "workspace.move"];
  for (const tool of mutationTools) {
    assert.equal(registry.has(tool), false, `${tool} is unavailable before PR2`);
  }
});

test("workspace.write preview is deterministic and side-effect free", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-preview-"));
  const tools = createWorkspaceMutationTools({ workspaceRoot: root });
  const first = await tools["workspace.write"].execute({ path: "note.txt", content: "hello" });
  const second = await tools["workspace.write"].execute({ path: "note.txt", content: "hello" });

  assert.equal(first.status, "ready");
  assert.equal(first.preview, true);
  assert.deepEqual(first, second);
  assert.deepEqual(first.coveredPaths, ["note.txt"]);
  assert.equal(first.conflicts.length, 0);
  assert.equal(existsSync(join(root, "note.txt")), false);
});

test("portable path validation rejects traversal, hidden paths, and ignored segments", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-portable-"));
  const tools = createWorkspaceMutationTools({ workspaceRoot: root });
  const paths = [
    "../escape.txt",
    "./relative.txt",
    "foo/../bar",
    "foo//bar",
    "foo/.env/config.txt",
    ".git/index.txt"
  ];

  for (const path of paths) {
    await assert.rejects(
      () => tools["workspace.write"].execute({ path, content: "x" }),
      (error: any) => typeof error?.code === "string" && error.code.startsWith("PATH")
    );
  }
});

test("symlinks and hardlinks are rejected on safe preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-links-"));
  const tools = createWorkspaceMutationTools({ workspaceRoot: root });
  const target = join(root, "target.txt");
  await writeFile(target, "original\n");

  const linkedFile = join(root, "symlinked.txt");
  await symlink(target, linkedFile);

  await assert.rejects(
    () => tools["workspace.edit"].execute({ path: "symlinked.txt", find: "original", replace: "modified" }),
    (error: any) => error.code === "SYMLINK_FORBIDDEN"
  );

  const hardLinked = join(root, "hard.txt");
  await link(target, hardLinked);
  await assert.rejects(
    () => tools["workspace.applyPatch"].execute({ path: "hard.txt", patches: [{ find: "original", replace: "new" }] }),
    (error: any) => error.code === "HARDLINK_FORBIDDEN"
  );
});

test("parent replacement and expected-state failures create deterministic conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-parent-"));
  const tools = createWorkspaceMutationTools({ workspaceRoot: root });

  const parentFile = join(root, "not-a-directory");
  await writeFile(parentFile, "I am a file\n");

  const mkdirConflict = await tools["workspace.mkdir"].execute({ path: "not-a-directory/child" });
  assert.equal(mkdirConflict.status, "conflict");
  assert.equal(mkdirConflict.conflicts[0]?.code, "PARENT_INVALID");

  await mkdir(join(root, "seed"), { recursive: true });
  await writeFile(join(root, "seed.txt"), "alpha\n");
  const staleState = await tools["workspace.remove"].execute({ path: "seed.txt", expected: { exists: false } });
  assert.equal(staleState.status, "conflict");
  assert.equal(staleState.conflicts[0]?.code, "STATE_EXISTS");
});

test("overlap rules and conflict determinism are enforced", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-overlap-"));
  const tools = createWorkspaceMutationTools({ workspaceRoot: root });
  await mkdir(join(root, "a"), { recursive: true });
  await writeFile(join(root, "a", "file.txt"), "one");

  const first = await tools["workspace.move"].execute({ from: "a", to: "a/sub" });
  const second = await tools["workspace.move"].execute({ from: "a", to: "a/sub" });

  assert.equal(first.status, "conflict");
  assert.equal(second.status, "conflict");
  assert.equal(first.conflicts[0]?.code, "PATH_OVERLAP");
  assert.deepEqual(first.conflicts, second.conflicts);
  assert.deepEqual(first, second);
});

test("limit checks report deterministic conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-limits-"));
  const tools = createWorkspaceMutationTools({ workspaceRoot: root });

  const largePayload = "x".repeat(2_000);
  const writeLimited = await tools["workspace.write"].execute({ path: "large.txt", content: largePayload, maxBytes: 1_000 });
  assert.equal(writeLimited.status, "conflict");
  assert.equal(writeLimited.conflicts[0]?.code, "BUDGET_EXCEEDED");

  await mkdir(join(root, "dir"), { recursive: true });
  await writeFile(join(root, "dir", "a.txt"), "one");
  await writeFile(join(root, "dir", "b.txt"), "two");
  const removeLimited = await tools["workspace.remove"].execute({ path: "dir", maxFiles: 1, recursive: true });
  assert.equal(removeLimited.status, "conflict");
  assert.equal(removeLimited.conflicts[0]?.code, "BUDGET_EXCEEDED");
});

test("digest checks are reported as expected-state conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-digest-"));
  const tools = createWorkspaceMutationTools({ workspaceRoot: root });
  const file = join(root, "seed.txt");
  await writeFile(file, "alpha\n");

  const wrongDigest = await tools["workspace.write"].execute({
    path: "seed.txt",
    content: "alpha\n",
    expected: { digest: "0".repeat(64) }
  });
  assert.equal(wrongDigest.status, "conflict");
  assert.equal(wrongDigest.conflicts[0]?.code, "DIGEST_MISMATCH");

  const digest = createHash("sha256").update(await readFile(file)).digest("hex");
  const correctDigest = await tools["workspace.applyPatch"].execute({
    path: "seed.txt",
    patches: [{ find: "alpha", replace: "alpha" }],
    expected: { digest: digest }
  });
  assert.equal(correctDigest.status, "ready");
});

if (process.platform !== "win32") {
  test("symlinked directory parents are blocked", async () => {
    const root = await mkdtemp(join(tmpdir(), "odinn-stage5-dir-link-"));
    const tools = createWorkspaceMutationTools({ workspaceRoot: root });
    const real = join(root, "real");
    const linked = join(root, "linked");
    await mkdir(real, { recursive: true });
    await symlink(real, linked, "dir");

    await assert.rejects(
      () => tools["workspace.write"].execute({ path: "linked/file.txt", content: "x" }),
      (error: any) => error.code === "SYMLINK_FORBIDDEN"
    );
  });
}
