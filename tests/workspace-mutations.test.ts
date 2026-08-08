import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBuiltInRegistry } from "../packages/kernel/src/index.ts";
import { CheckpointCoordinator, createRunLedger } from "../packages/kernel/src/index.ts";
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

test("apply mode creates publication artifacts for write, edit, patch, mkdir, remove, and move", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-apply-all-"));
  const stateDir = join(root, ".odinn");
  const runLedger = createRunLedger({ workspaceRoot: root, stateDir });
  const coordinator = new CheckpointCoordinator({ runLedger });
  const tools = createWorkspaceMutationTools({ workspaceRoot: root, runLedger, coordinator, stateDir });

  try {
    await writeFile(join(root, "seed.txt"), "alpha");
    const writeResult = await tools["workspace.write"].execute({
      path: "seed.txt",
      content: "beta",
      apply: true
    });
    assert.equal(writeResult.preview, false);
    assert.equal(writeResult.applied, true);
    assert.equal((await readFile(join(root, "seed.txt"), "utf8")), "beta");
    assert.equal(existsSync(join(root, "seed.txt")), true);

    const editDigest = createHash("sha256").update("beta").digest("hex");
    const editResult = await tools["workspace.edit"].execute({
      path: "seed.txt",
      find: "be",
      replace: "g",
      expected: { digest: editDigest },
      apply: true
    });
    assert.equal(editResult.preview, false);
    assert.equal(editResult.applied, true);
    assert.equal(await readFile(join(root, "seed.txt"), "utf8"), "gta");

    const patchResult = await tools["workspace.applyPatch"].execute({
      path: "seed.txt",
      patches: [{ find: "gta", replace: "omega" }],
      apply: true
    });
    assert.equal(patchResult.preview, false);
    assert.equal(patchResult.applied, true);
    assert.equal((await readFile(join(root, "seed.txt"), "utf8")), "omega");

    const mkdirResult = await tools["workspace.mkdir"].execute({
      path: "folder",
      apply: true
    });
    assert.equal(mkdirResult.preview, false);
    assert.equal(mkdirResult.applied, true);
    assert.equal(existsSync(join(root, "folder")), true);

    const removeResult = await tools["workspace.remove"].execute({ path: "folder", apply: true });
    assert.equal(removeResult.preview, false);
    assert.equal(removeResult.applied, true);
    assert.equal(existsSync(join(root, "folder")), false);

    await writeFile(join(root, "move-from.txt"), "to-move");
    const moveResult = await tools["workspace.move"].execute({
      from: "move-from.txt",
      to: "moved.txt",
      apply: true
    });
    assert.equal(moveResult.preview, false);
    assert.equal(moveResult.applied, true);
    assert.equal(existsSync(join(root, "move-from.txt")), false);
    assert.equal(existsSync(join(root, "moved.txt")), true);

    const boundaryStatus = runLedger.database.db.prepare(
      "SELECT status, step_id FROM mutation_groups ORDER BY created_at DESC LIMIT 1"
    ).get() as { status: string; step_id: string | null } | undefined;
    assert.equal(boundaryStatus?.status, "completed");
  } finally {
    runLedger.close();
  }
});

test("stale-write refusal rejects apply when expected-current digest no longer matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-apply-stale-"));
  await writeFile(join(root, "seed.txt"), "one");
  const original = await readFile(join(root, "seed.txt"));
  const expectedDigest = createHash("sha256").update(original).digest("hex");
  const tools = createWorkspaceMutationTools({ workspaceRoot: root });

  await writeFile(join(root, "seed.txt"), "stale");
  const staleResult = await tools["workspace.write"].execute({
    path: "seed.txt",
    content: "new-content",
    expected: { digest: expectedDigest },
    apply: true
  });
  assert.equal(staleResult.preview, false);
  assert.equal(staleResult.applied, false);
  assert.equal(staleResult.status, "conflict");
  assert.equal(staleResult.conflicts[0]?.code, "DIGEST_MISMATCH");
});

test("parent-swap and identity defenses reject apply when ancestors become unsafe", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-parent-swap-"));
  const safeDir = join(root, "safe");
  await mkdir(safeDir);
  const target = join(root, "target-dir");
  await mkdir(target);
  await writeFile(join(root, "seed.txt"), "value");
  const tools = createWorkspaceMutationTools({ workspaceRoot: root });
  await writeFile(join(safeDir, "seed.txt"), "value");
  await symlink(target, join(root, "link-safe"), "dir");
  await assert.rejects(
    () => tools["workspace.write"].execute({ path: "link-safe/seed.txt", content: "changed", apply: true }),
    (error: any) => error.code === "SYMLINK_FORBIDDEN" || error.code === "PARENT_INVALID"
  );
});

test("mutations fail-closed when publication fails after execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-publication-failclosed-"));
  const stateDir = join(root, ".odinn");
  const runLedger = createRunLedger({ workspaceRoot: root, stateDir });
  const coordinator = new CheckpointCoordinator({ runLedger });
  const originalPublish = coordinator.publishBoundary.bind(coordinator);
  const tools = createWorkspaceMutationTools({ workspaceRoot: root, runLedger, coordinator, stateDir });
  coordinator.publishBoundary = ((boundaryId: string) => {
    throw new Error(`injected publish failure for ${boundaryId}`);
  }) as typeof coordinator.publishBoundary;
  try {
    await assert.rejects(
      () => tools["workspace.write"].execute({
        path: "seed.txt",
        content: "alpha",
        apply: true
      }),
      (error: any) => error.name === "ODINN_MUTATION_FAIL_CLOSED"
    );

    const boundary = runLedger.database.db.prepare("SELECT id, status FROM mutation_groups ORDER BY created_at DESC LIMIT 1").get() as {
      id: string;
      status: string;
    } | undefined;
    assert.equal(boundary?.status, "needs-review");
    assert.equal(existsSync(join(root, "seed.txt")), true);
  } finally {
    coordinator.publishBoundary = originalPublish;
    runLedger.close();
  }
});

test("fault-injection in limits keeps publication from proceeding and returns conflict", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-apply-limit-"));
  const tools = createWorkspaceMutationTools({ workspaceRoot: root });

  const limited = await tools["workspace.write"].execute({
    path: "seed.txt",
    content: "x".repeat(2_500),
    maxBytes: 1_000,
    apply: true
  });
  assert.equal(limited.preview, false);
  assert.equal(limited.applied, false);
  assert.equal(limited.status, "conflict");
  assert.equal(limited.conflicts[0]?.code, "BUDGET_EXCEEDED");
  assert.equal(existsSync(join(root, "seed.txt")), false);
});

test("checkpoint.restore preview captures add/modify/remove and directory actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-restore-preview-"));
  const stateDir = join(root, ".odinn");
  const runLedger = createRunLedger({ workspaceRoot: root, stateDir });
  const coordinator = new CheckpointCoordinator({ runLedger });
  const tools = createWorkspaceMutationTools({
    workspaceRoot: root,
    runLedger,
    coordinator,
    stateDir,
    runId: "restore-preview-run"
  });

  try {
    await writeFile(join(root, "mutable.txt"), "one");
    await writeFile(join(root, "to-remove.txt"), "to remove");
    await mkdir(join(root, "restore-dir"));
    await writeFile(join(root, "restore-dir", "leaf.txt"), "nested");

    const addFile = await tools["workspace.write"].execute({ path: "added.txt", content: "added", apply: true });
    const addPreview = await tools["checkpoint.restore"].execute({ checkpointId: addFile.checkpointId as string });
    assert.equal(addPreview.status, "ready");
    assert.equal(addPreview.preview, true);
    assert.ok(addPreview.entries.some((entry) => entry.path === "added.txt" && entry.action === "remove"));
    const addResult = await tools["checkpoint.restore"].execute({ checkpointId: addFile.checkpointId as string, apply: true });
    assert.equal(addResult.preview, false);
    assert.equal(addResult.applied, true);
    assert.equal(addResult.externalEffects, false);
    assert.equal(existsSync(join(root, "added.txt")), false);

    const modifySeed = await tools["workspace.write"].execute({ path: "mutable.txt", content: "two", apply: true });
    const modifyPreview = await tools["checkpoint.restore"].execute({ checkpointId: modifySeed.checkpointId as string });
    assert.equal(modifyPreview.status, "ready");
    assert.equal(modifyPreview.entries[0]?.action, "modify");
    const restoreResult = await tools["checkpoint.restore"].execute({ checkpointId: modifySeed.checkpointId as string, apply: true });
    assert.equal(restoreResult.preview, false);
    assert.equal(restoreResult.applied, true);
    assert.equal(await readFile(join(root, "mutable.txt"), "utf8"), "one");

    const removeFile = await tools["workspace.remove"].execute({ path: "to-remove.txt", apply: true });
    const removePreview = await tools["checkpoint.restore"].execute({ checkpointId: removeFile.checkpointId as string });
    assert.equal(removePreview.status, "ready");
    assert.equal(removePreview.entries[0]?.action, "restore");
    const removeResult = await tools["checkpoint.restore"].execute({ checkpointId: removeFile.checkpointId as string, apply: true });
    assert.equal(removeResult.applied, true);
    assert.equal(await readFile(join(root, "to-remove.txt"), "utf8"), "to remove");

    const removeDirectory = await tools["workspace.remove"].execute({ path: "restore-dir", recursive: true, apply: true });
    const restoreDirectoryPreview = await tools["checkpoint.restore"].execute({ checkpointId: removeDirectory.checkpointId as string });
    assert.equal(restoreDirectoryPreview.status, "ready");
    assert.equal(restoreDirectoryPreview.entries.some((entry) => entry.action === "restore-directory"), true);
    const restoreDirectoryResult = await tools["checkpoint.restore"].execute({
      checkpointId: removeDirectory.checkpointId as string,
      apply: true
    });
    if (restoreDirectoryResult.applied === true) {
      assert.equal((await readFile(join(root, "restore-dir", "leaf.txt"), "utf8")), "nested");
    } else {
      assert.equal(restoreDirectoryResult.status, "conflict");
    }

    const addDirectory = await tools["workspace.mkdir"].execute({ path: "created-only-dir", apply: true });
    const removeDirectoryRestore = await tools["checkpoint.restore"].execute({ checkpointId: addDirectory.checkpointId as string });
    assert.equal(removeDirectoryRestore.entries[0]?.action, "remove-directory");
    const addDirectoryResult = await tools["checkpoint.restore"].execute({
      checkpointId: addDirectory.checkpointId as string,
      apply: true
    });
    assert.equal(addDirectoryResult.applied, true);
    assert.equal(existsSync(join(root, "created-only-dir")), false);
  } finally {
    runLedger.close();
  }
});

test("checkpoint.restore rejects stale post-restore targets through conflict checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-restore-stale-"));
  const tools = createWorkspaceMutationTools({ workspaceRoot: root });
  await writeFile(join(root, "seed.txt"), "before");

  const mutation = await tools["workspace.remove"].execute({ path: "seed.txt", apply: true });
  const firstRestore = await tools["checkpoint.restore"].execute({
    checkpointId: mutation.checkpointId as string,
    apply: true
  });
  assert.equal(firstRestore.applied, true);
  assert.equal(await readFile(join(root, "seed.txt"), "utf8"), "before");

  await writeFile(join(root, "seed.txt"), "changed");
  const staleRestore = await tools["checkpoint.restore"].execute({
    checkpointId: mutation.checkpointId as string,
    apply: true
  });
  assert.equal(staleRestore.preview, true);
  assert.equal(staleRestore.applied, false);
  assert.equal(staleRestore.status, "conflict");
  assert.equal(staleRestore.conflicts[0]?.code, "STATE_EXISTS");
  assert.equal(await readFile(join(root, "seed.txt"), "utf8"), "changed");
});

test("checkpoint.restore reports missing artifact for file restore preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-restore-artifact-missing-"));
  const stateDir = join(root, ".odinn");
  const runLedger = createRunLedger({ workspaceRoot: root, stateDir });
  const coordinator = new CheckpointCoordinator({ runLedger });
  const tools = createWorkspaceMutationTools({ workspaceRoot: root, stateDir, runLedger, coordinator });

  try {
    await writeFile(join(root, "seed.txt"), "original");
    const mutation = await tools["workspace.remove"].execute({ path: "seed.txt", apply: true });
    const description = coordinator.describeCheckpoint(mutation.checkpointId as string);
    const manifest = description.journal[0]?.manifest as { entries?: Array<{ before?: { artifactDigest?: string } }> };
    const missingDigest = manifest?.entries?.[0]?.before?.artifactDigest;
    assert.ok(typeof missingDigest === "string" && missingDigest.length === 64);
    const artifactPath = join(runLedger.artifacts.root, "sha256", missingDigest.slice(0, 2), missingDigest);
    await rm(artifactPath);

    const preview = await tools["checkpoint.restore"].execute({ checkpointId: mutation.checkpointId as string });
    assert.equal(preview.status, "conflict");
    assert.equal(preview.conflicts.some((entry) => entry.code === "ARTIFACT_MISSING"), true);
    const applied = await tools["checkpoint.restore"].execute({ checkpointId: mutation.checkpointId as string, apply: true });
    assert.equal(applied.status, "conflict");
    assert.equal(applied.applied, false);
    await assert.rejects(readFile(join(root, "seed.txt"), "utf8"), { code: "ENOENT" });
  } finally {
    runLedger.close();
  }
});

test("checkpoint.restore reports corrupt artifact for file restore preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-restore-artifact-corrupt-"));
  const stateDir = join(root, ".odinn");
  const runLedger = createRunLedger({ workspaceRoot: root, stateDir });
  const coordinator = new CheckpointCoordinator({ runLedger });
  const tools = createWorkspaceMutationTools({ workspaceRoot: root, stateDir, runLedger, coordinator });

  try {
    await writeFile(join(root, "seed.txt"), "original");
    const mutation = await tools["workspace.remove"].execute({ path: "seed.txt", apply: true });
    const description = coordinator.describeCheckpoint(mutation.checkpointId as string);
    const manifest = description.journal[0]?.manifest as { entries?: Array<{ before?: { artifactDigest?: string } }> };
    const corruptDigest = manifest?.entries?.[0]?.before?.artifactDigest;
    assert.ok(typeof corruptDigest === "string" && corruptDigest.length === 64);
    const artifactPath = join(runLedger.artifacts.root, "sha256", corruptDigest.slice(0, 2), corruptDigest);
    await writeFile(artifactPath, "corrupt");

    const preview = await tools["checkpoint.restore"].execute({ checkpointId: mutation.checkpointId as string });
    assert.equal(preview.status, "conflict");
    assert.equal(preview.conflicts.some((entry) => entry.code === "ARTIFACT_CORRUPT"), true);
    const applied = await tools["checkpoint.restore"].execute({ checkpointId: mutation.checkpointId as string, apply: true });
    assert.equal(applied.status, "conflict");
    assert.equal(applied.applied, false);
  } finally {
    runLedger.close();
  }
});

test("checkpoint.restore creates a recovery snapshot before mutation and records the event", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-restore-recovery-"));
  const stateDir = join(root, ".odinn");
  const runLedger = createRunLedger({ workspaceRoot: root, stateDir });
  const tools = createWorkspaceMutationTools({
    workspaceRoot: root,
    stateDir,
    runLedger,
    runId: "restore-recovery-run"
  });

  try {
    await writeFile(join(root, "seed.txt"), "before");
    const mutation = await tools["workspace.write"].execute({ path: "seed.txt", content: "after", apply: true });
    const restored = await tools["checkpoint.restore"].execute({ checkpointId: mutation.checkpointId as string, apply: true });
    assert.equal(restored.preview, false);
    assert.equal(restored.applied, true);
    assert.equal(restored.externalEffects, false);
    assert.ok(typeof restored.recoveryCheckpointId === "string" && restored.recoveryCheckpointId.startsWith("snap_"));
    const recovery = runLedger.database.db.prepare("SELECT id FROM snapshots WHERE id = ?").get(restored.recoveryCheckpointId as string);
    assert.ok(recovery !== undefined);
    const runEvents = runLedger.getRun("restore-recovery-run").events;
    assert.equal(
      runEvents.some((event: any) => event.type === "checkpoint-restore" && event.payload?.checkpointId === mutation.checkpointId),
      true
    );
    assert.equal(
      runEvents.some((event: any) => event.type === "checkpoint-restore" && event.payload?.recoveryCheckpointId === restored.recoveryCheckpointId),
      true
    );
  } finally {
    runLedger.close();
  }
});

test("checkpoint.restore detects covered-path overlap across manifest entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-stage5-restore-covered-"));
  const stateDir = join(root, ".odinn");
  const runLedger = createRunLedger({ workspaceRoot: root, stateDir });
  const coordinator = new CheckpointCoordinator({ runLedger });
  const toolsRestore = createWorkspaceMutationTools({ workspaceRoot: root, stateDir, runLedger, coordinator });

  try {
    const boundary = coordinator.startBoundary({ runId: "restore-covered-conflict-run" });
    coordinator.recordMutationPreview({
      boundaryId: boundary.boundaryId,
      operation: "workspace.write",
      stepId: "covered-1",
      preview: {
        preview: true,
        operation: "workspace.write",
        status: "ready",
        coveredPaths: ["seed.txt"],
        conflicts: [],
        entries: [{ path: "seed.txt", before: { path: "seed.txt", exists: false, kind: "missing" }, after: { path: "seed.txt", exists: true, kind: "file", bytes: 5 } }],
        manifest: {
          operation: "workspace.write",
          status: "ready",
          stepId: "covered-1",
          coveredPaths: ["seed.txt"],
          entries: [{ path: "seed.txt", before: { path: "seed.txt", exists: false, kind: "missing" }, after: { path: "seed.txt", exists: true, kind: "file", bytes: 5 } }]
        }
      }
    });
    coordinator.recordMutationPreview({
      boundaryId: boundary.boundaryId,
      operation: "workspace.write",
      stepId: "covered-2",
      preview: {
        preview: true,
        operation: "workspace.write",
        status: "ready",
        coveredPaths: ["seed.txt"],
        conflicts: [],
        entries: [{ path: "seed.txt", before: { path: "seed.txt", exists: false, kind: "missing" }, after: { path: "seed.txt", exists: true, kind: "file", bytes: 5 } }],
        manifest: {
          operation: "workspace.write",
          status: "ready",
          stepId: "covered-2",
          coveredPaths: ["seed.txt"],
          entries: [{ path: "seed.txt", before: { path: "seed.txt", exists: false, kind: "missing" }, after: { path: "seed.txt", exists: true, kind: "file", bytes: 5 } }]
        }
      }
    });
    const published = coordinator.publishBoundary(boundary.boundaryId);
    const restore = await toolsRestore["checkpoint.restore"].execute({ checkpointId: published.checkpointId });
    assert.equal(restore.status, "conflict");
    assert.equal(restore.conflicts.some((entry) => entry.code === "COVERED_PATH_CONFLICT"), true);
  } finally {
    runLedger.close();
  }
});
