import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CheckpointCoordinator,
  createBuiltInRegistry,
  createRunLedger
} from "../packages/kernel/src/index.ts";
import { createWorkspaceMutationTools } from "../packages/kernel/src/workspace-mutations.ts";

test("checkpoint coordinator replays durable journal from persisted mutation previews", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-checkpoint-replay-"));
  const stateDir = join(root, ".odinn");
  const runLedger = createRunLedger({ stateDir, workspaceRoot: root });
  const coordinator = new CheckpointCoordinator({ runLedger });
  const mutationTools = createWorkspaceMutationTools({ workspaceRoot: root });

  try {
    const writePreview = await mutationTools["workspace.write"].execute({
      path: "seed.txt",
      content: "alpha",
      maxBytes: 500
    });
    const movePreview = await mutationTools["workspace.write"].execute({
      path: "seed-copy.txt",
      content: "beta",
      maxBytes: 500
    });

    const { boundaryId } = coordinator.startBoundary({ runId: "run-checkpoint-replay" });
    const first = coordinator.recordMutationPreview({ boundaryId, operation: writePreview.operation, stepId: "step-1", preview: writePreview });
    const second = coordinator.recordMutationPreview({ boundaryId, operation: movePreview.operation, stepId: "step-2", preview: movePreview });

    const published = coordinator.publishBoundary(boundaryId);
    assert.equal(first.status, "ready");
    assert.equal(second.status, "ready");
    assert.equal(published.boundArtifact?.manifestDigest, published.manifestDigest);
    assert.equal(published.boundArtifact?.artifactDigest, published.manifestDigest);

    const replay = coordinator.replayBoundary(boundaryId);
    assert.equal(replay.journal.length, 2);
    assert.equal(replay.conflicts, 0);
    assert.equal(replay.artifacts.length, 1);
    assert.equal(replay.artifacts[0].manifestDigest, published.manifestDigest);
    assert.equal(replay.artifacts[0].artifactPath, published.artifactPath);

    const artifactPath = join(stateDir, "artifacts", published.artifactPath);
    await access(artifactPath);
  } finally {
    coordinator.runLedger.close();
  }
});

test("checkpoint coordinator marks unresolved boundary as needs-review on publish failure (fail-closed)", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-checkpoint-failclosed-"));
  const stateDir = join(root, ".odinn");
  const runLedger = createRunLedger({ stateDir, workspaceRoot: root });
  const coordinator = new CheckpointCoordinator({ runLedger });

  try {
    const { boundaryId } = coordinator.startBoundary({ runId: "run-checkpoint-empty" });

    await assert.rejects(async () => coordinator.publishBoundary(boundaryId), (error: any) => {
      return error instanceof Error && error.name === "ODINN_CHECKPOINT_FAIL_CLOSED";
    });

    const boundaryRow = runLedger.database.db.prepare("SELECT status FROM mutation_groups WHERE id = ?").get(boundaryId) as { status: string };
    const checkpointRow = runLedger.database.db.prepare("SELECT status FROM mutation_checkpoints WHERE group_id = ? ORDER BY created_at DESC LIMIT 1").get(boundaryId) as { status: string };
    assert.equal(boundaryRow.status, "needs-review");
    assert.equal(checkpointRow.status, "needs-review");
  } finally {
    coordinator.runLedger.close();
  }
});

test("checkpoint coordinator recovers crash-state boundaries into needs-review", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-checkpoint-recover-"));
  const stateDir = join(root, ".odinn");
  const runLedger = createRunLedger({ stateDir, workspaceRoot: root });
  const coordinator = new CheckpointCoordinator({ runLedger });

  try {
    const { boundaryId } = coordinator.startBoundary({ runId: "run-checkpoint-crash", stepId: "step-0" });
    const mutationTools = createWorkspaceMutationTools({ workspaceRoot: root });
    const preview = await mutationTools["workspace.write"].execute({ path: "crash.txt", content: "value" });
    coordinator.recordMutationPreview({ boundaryId, operation: preview.operation, stepId: "step-1", preview });

    const checkpointRow = runLedger.database.db.prepare("SELECT id FROM mutation_checkpoints WHERE group_id = ? ORDER BY created_at DESC LIMIT 1").get(boundaryId) as { id: string };
    runLedger.database.db.prepare("UPDATE mutation_checkpoints SET status = 'publishing' WHERE id = ?").run(checkpointRow.id);

    const recovered = coordinator.recover();
    assert.equal(recovered.recovered.length, 1);
    assert.equal(recovered.recovered[0], checkpointRow.id);

    const recoveredBoundaryRow = runLedger.database.db.prepare("SELECT status FROM mutation_groups WHERE id = ?").get(boundaryId) as { status: string };
    const recoveredCheckpointRow = runLedger.database.db.prepare("SELECT status FROM mutation_checkpoints WHERE id = ?").get(checkpointRow.id) as { status: string };
    assert.equal(recoveredBoundaryRow.status, "needs-review");
    assert.equal(recoveredCheckpointRow.status, "needs-review");
  } finally {
    coordinator.runLedger.close();
  }
});

test("checkpoint coordinator completes empty created boundary on startup reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-checkpoint-recover-empty-"));
  const stateDir = join(root, ".odinn");
  const runLedger = createRunLedger({ stateDir, workspaceRoot: root });
  const coordinator = new CheckpointCoordinator({ runLedger });

  try {
    const { boundaryId } = coordinator.startBoundary({ runId: "run-checkpoint-empty-boundary" });
    const checkpointRow = runLedger.database.db.prepare("SELECT id FROM mutation_checkpoints WHERE group_id = ? ORDER BY created_at DESC LIMIT 1").get(boundaryId) as { id: string };
    runLedger.database.db.prepare("UPDATE mutation_checkpoints SET status = 'created' WHERE id = ?").run(checkpointRow.id);

    const recovered = coordinator.recover();
    assert.equal(recovered.recovered.length, 1);
    assert.equal(recovered.recovered[0], checkpointRow.id);

    const boundaryRow = runLedger.database.db.prepare("SELECT status FROM mutation_groups WHERE id = ?").get(boundaryId) as { status: string };
    const recoveredCheckpointRow = runLedger.database.db.prepare("SELECT status FROM mutation_checkpoints WHERE id = ?").get(checkpointRow.id) as { status: string };
    assert.equal(boundaryRow.status, "completed");
    assert.equal(recoveredCheckpointRow.status, "completed");
  } finally {
    coordinator.runLedger.close();
  }
});

test("checkpoint coordinator reconciles publishing crash state into needs-review", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-checkpoint-recover-publishing-"));
  const stateDir = join(root, ".odinn");
  const runLedger = createRunLedger({ stateDir, workspaceRoot: root });
  const coordinator = new CheckpointCoordinator({ runLedger });

  try {
    const { boundaryId } = coordinator.startBoundary({ runId: "run-checkpoint-recover-publishing" });
    const mutationTools = createWorkspaceMutationTools({ workspaceRoot: root });
    const preview = await mutationTools["workspace.write"].execute({ path: "safe.txt", content: "value" });
    coordinator.recordMutationPreview({ boundaryId, operation: preview.operation, stepId: "step-1", preview });

    const checkpointRow = runLedger.database.db.prepare("SELECT id FROM mutation_checkpoints WHERE group_id = ? ORDER BY created_at DESC LIMIT 1").get(boundaryId) as { id: string };
    runLedger.database.db.prepare("UPDATE mutation_checkpoints SET status = 'publishing' WHERE id = ?").run(checkpointRow.id);

    const recovered = coordinator.recover();
    assert.equal(recovered.recovered.length, 1);
    assert.equal(recovered.recovered[0], checkpointRow.id);

    const boundary = runLedger.database.db.prepare("SELECT status FROM mutation_groups WHERE id = ?").get(boundaryId) as { status: string };
    const checkpoint = runLedger.database.db.prepare("SELECT status FROM mutation_checkpoints WHERE id = ?").get(checkpointRow.id) as { status: string };
    assert.equal(boundary.status, "needs-review");
    assert.equal(checkpoint.status, "needs-review");
  } finally {
    coordinator.runLedger.close();
  }
});

test("checkpoint coordinator reconciles verifying crash state with manifest as completed", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-checkpoint-recover-verifying-"));
  const stateDir = join(root, ".odinn");
  const runLedger = createRunLedger({ stateDir, workspaceRoot: root });
  const coordinator = new CheckpointCoordinator({ runLedger });
  const mutationTools = createWorkspaceMutationTools({ workspaceRoot: root });

  try {
    const { boundaryId } = coordinator.startBoundary({ runId: "run-checkpoint-recover-verifying" });
    const preview = await mutationTools["workspace.write"].execute({ path: "safe.txt", content: "value" });
    coordinator.recordMutationPreview({ boundaryId, operation: preview.operation, stepId: "step-1", preview });
    coordinator.publishBoundary(boundaryId);
    const checkpointRow = runLedger.database.db.prepare("SELECT id FROM mutation_checkpoints WHERE group_id = ? ORDER BY created_at DESC LIMIT 1").get(boundaryId) as { id: string };
    runLedger.database.db.prepare("UPDATE mutation_checkpoints SET status = 'verifying' WHERE id = ?").run(checkpointRow.id);

    const recovered = coordinator.recover();
    assert.equal(recovered.recovered.length, 1);
    const boundary = runLedger.database.db.prepare("SELECT status FROM mutation_groups WHERE id = ?").get(boundaryId) as { status: string };
    const checkpoint = runLedger.database.db.prepare("SELECT status FROM mutation_checkpoints WHERE id = ?").get(checkpointRow.id) as { status: string };
    assert.equal(boundary.status, "completed");
    assert.equal(checkpoint.status, "completed");
  } finally {
    coordinator.runLedger.close();
  }
});

test("checkpoint journal records mutation budgets and deterministic conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-checkpoint-budget-"));
  const stateDir = join(root, ".odinn");
  const runLedger = createRunLedger({ stateDir, workspaceRoot: root });
  const coordinator = new CheckpointCoordinator({ runLedger });
  const mutationTools = createWorkspaceMutationTools({ workspaceRoot: root });

  try {
    const { boundaryId } = coordinator.startBoundary({ runId: "run-checkpoint-budget", purpose: "budget" });
    const huge = "x".repeat(4096);
    const limited = await mutationTools["workspace.write"].execute({ path: "budget.txt", content: huge, maxBytes: 1 });
    assert.equal(limited.status, "conflict");

    const recorded = coordinator.recordMutationPreview({
      boundaryId,
      operation: limited.operation,
      stepId: "step-budget",
      preview: limited
    });

    assert.equal(recorded.status, "conflict");
    const replay = coordinator.replayBoundary(boundaryId);
    assert.equal(replay.conflicts, 1);
    assert.equal(replay.journal.length, 1);
    assert.equal(replay.journal[0].conflicts[0]?.code, "BUDGET_EXCEEDED");
  } finally {
    coordinator.runLedger.close();
  }
});

test("checkpoint foundation remains inactive in default registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-checkpoint-foundation-"));
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir: join(root, ".odinn") });
  const foundationTools = [...registry.keys()].filter((name) => name.startsWith("checkpoint") || name.includes("norn"));
  assert.deepEqual(foundationTools, []);
  assert.equal(registry.has("text.echo"), true);
});
