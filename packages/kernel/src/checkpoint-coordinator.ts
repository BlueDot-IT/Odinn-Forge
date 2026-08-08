import { randomUUID } from "node:crypto";
import { RunLedger } from "@odinn/store-sqlite";

type JsonMap = Record<string, unknown>;
type SqlRow = Record<string, unknown>;

interface MutationPreviewLike {
  preview: true;
  operation: string;
  status: "ready" | "conflict";
  coveredPaths?: string[];
  conflicts?: { code: string; path: string }[];
  manifest?: JsonMap;
  payload?: JsonMap;
}
interface MutationJournalRecord {
  id: string;
  operation: string;
  status: "ready" | "conflict";
  stepId: string | null;
  coveredPaths: string[];
  conflicts: { code: string; path: string }[];
}

interface BoundaryInput {
  runId: string;
  stepId?: string;
  purpose?: string;
  foundation?: string;
  metadata?: JsonMap;
}

interface BoundaryPreviewInput {
  boundaryId: string;
  operation: string;
  stepId?: string;
  preview: MutationPreviewLike;
}

interface BoundArtifact {
  id: string;
  checkpointId: string;
  manifestDigest: string;
  artifactDigest: string;
  artifactPath: string;
  mediaType: string;
  sizeBytes: number;
}

interface BoundaryRecord {
  id: string;
  runId: string;
  purpose: string;
  stepId?: string;
  foundation: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  metadata: JsonMap;
}

interface CheckpointRecord {
  id: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

interface CountRow { count: number; }

const ACTIVE_STATUSES = new Set(["created", "checkpointing", "ready", "publishing", "verifying"]);

function normalizedInput(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function toJson(value: unknown, fallback = "") {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const now = () => new Date().toISOString();

export class CheckpointCoordinator {
  readonly runLedger: RunLedger;
  readonly now: () => string;

  constructor({ runLedger, now: nowValue = now }: { runLedger: RunLedger; now?: () => string }) {
    if (!runLedger) throw new Error("checkpoint coordinator requires runLedger");
    this.runLedger = runLedger;
    this.now = nowValue;
  }

  status(boundaryId: string) {
    const boundary = this.readBoundary(boundaryId);
    if (!boundary) return undefined;
    const checkpoint = this.currentCheckpoint(boundaryId);
    const journalRow = this.runLedger.database.db.prepare(
      "SELECT COUNT(1) AS count FROM mutation_journal_entries WHERE group_id = ?"
    ).get(boundaryId) as CountRow;
    const conflictRow = this.runLedger.database.db.prepare(
      "SELECT COUNT(1) AS count FROM mutation_journal_entries WHERE group_id = ? AND status = 'conflict'"
    ).get(boundaryId) as CountRow;
    return {
      boundaryId,
      boundaryStatus: boundary.status,
      checkpointId: checkpoint?.id,
      checkpointStatus: checkpoint?.status ?? "unknown",
      journalCount: Number(journalRow.count ?? 0),
      conflictCount: Number(conflictRow.count ?? 0)
    };
  }

  startBoundary({ runId, stepId, purpose = "mutation-group", foundation = "agent", metadata = {} }: BoundaryInput) {
    const safeRunId = normalizedInput(runId, "");
    if (!safeRunId) throw new Error("checkpoint boundary requires runId");
    this.runLedger.ensureRun({ runId: safeRunId });

    const boundaryId = `norn_group_${randomUUID()}`;
    const checkpointId = `norn_checkpoint_${randomUUID()}`;
    const createdAt = this.now();

    this.runLedger.database.transaction((database) => {
      database.prepare(
        "INSERT INTO mutation_groups(id, run_id, purpose, step_id, foundation, metadata_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        boundaryId,
        safeRunId,
        normalizedInput(purpose, "mutation-group"),
        stepId ?? null,
        normalizedInput(foundation, "agent"),
        toJson(metadata, "{}"),
        "created",
        createdAt,
        createdAt
      );
      database.prepare(
        "INSERT INTO mutation_checkpoints(id, run_id, group_id, status, created_at, manifest_json, manifest_digest) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(checkpointId, safeRunId, boundaryId, "checkpointing", createdAt, null, null);
    });

    this.runLedger.appendEvent({
      runId: safeRunId,
      type: "checkpoint-boundary-started",
      payload: { boundaryId, checkpointId, purpose, foundation, stepId }
    });
    return { boundaryId, checkpointId };
  }

  recordMutationPreview({ boundaryId, operation, stepId, preview }: BoundaryPreviewInput) {
    const boundary = this.readBoundary(boundaryId);
    if (!boundary) throw new Error(`checkpoint boundary not found: ${boundaryId}`);
    if (!ACTIVE_STATUSES.has(boundary.status)) {
      throw new Error(`checkpoint boundary ${boundaryId} is not in a mutable state (${boundary.status})`);
    }

    const status = preview.status === "ready" ? "ready" : "conflict";
    const checkpointId = this.currentCheckpointId(boundaryId);
    const nowValue = this.now();
    const id = `mutation_journal_${randomUUID()}`;
    const safeOperation = normalizedInput(preview.operation, operation);

    const coveredPaths = Array.isArray(preview.coveredPaths)
      ? preview.coveredPaths.filter((value): value is string => typeof value === "string")
      : [];
    const conflicts = Array.isArray(preview.conflicts) ? preview.conflicts : [];
    const manifest = preview.manifest ?? {
      operation: safeOperation,
      stepId: stepId ?? boundary.stepId,
      status: preview.status
    };

    this.runLedger.database.transaction((database) => {
      database.prepare(
        "INSERT INTO mutation_journal_entries(id, run_id, group_id, checkpoint_id, step_id, operation, status, payload_json, manifest_json, covered_paths_json, conflicts_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        id,
        boundary.runId,
        boundary.id,
        checkpointId,
        stepId ?? boundary.stepId ?? null,
        safeOperation,
        status,
        toJson(preview.payload ?? {}, "{}"),
        toJson(manifest, "{}"),
        toJson(coveredPaths, "[]"),
        toJson(conflicts, "[]"),
        nowValue
      );

      const nextBoundaryStatus = status === "conflict" ? "conflict" : "checkpointing";
      const nextCheckpointStatus = status === "conflict" ? "conflict" : "ready";
      database.prepare("UPDATE mutation_groups SET status = ?, updated_at = ? WHERE id = ?").run(nextBoundaryStatus, nowValue, boundaryId);
      database.prepare("UPDATE mutation_checkpoints SET status = ? WHERE id = ?").run(nextCheckpointStatus, checkpointId);
    });

    this.runLedger.appendEvent({
      runId: boundary.runId,
      type: "checkpoint-boundary-preview",
      payload: {
        boundaryId,
        checkpointId,
        operation: safeOperation,
        stepId: stepId ?? boundary.stepId,
        status,
        conflicts: conflicts.length,
        paths: coveredPaths.length
      }
    });
    return { id, status, checkpointId };
  }

  publishBoundary(boundaryId: string) {
    const boundary = this.readBoundary(boundaryId);
    if (!boundary) throw new Error(`checkpoint boundary not found: ${boundaryId}`);
    const checkpoint = this.currentCheckpoint(boundaryId);
    if (!checkpoint) throw new Error(`checkpoint boundary missing checkpoint: ${boundaryId}`);

    const replay = this.replayBoundary(boundaryId);
    const entries = replay.journal;
    const conflictCount = replay.conflicts;
    const nowValue = this.now();

    this.runLedger.database.transaction((database) => {
      database.prepare("UPDATE mutation_checkpoints SET status = ? WHERE id = ?").run("publishing", checkpoint.id);
    });

    try {
      if (entries.length === 0) {
        throw new Error(`checkpoint boundary ${boundaryId} has no mutations`);
      }
      if (conflictCount > 0) {
        throw new Error("checkpoint boundary has conflicts");
      }

      const manifest = {
        boundaryId,
        checkpointId: checkpoint.id,
        runId: boundary.runId,
        foundation: boundary.foundation,
        status: "ready",
        purpose: boundary.purpose,
        stepId: boundary.stepId,
        startedAt: checkpoint.createdAt,
        completedAt: nowValue,
        journal: entries
      };
      const manifestArtifact = this.runLedger.artifacts.putJson(manifest);
      const bindingId = `manifest_${randomUUID()}`;

      this.runLedger.database.transaction((database) => {
        database.prepare(
          "UPDATE mutation_checkpoints SET status = ?, completed_at = ?, manifest_json = ?, manifest_digest = ? WHERE id = ?"
        ).run("verifying", nowValue, toJson(manifest, "{}"), manifestArtifact.digest, checkpoint.id);
        database.prepare(
          "INSERT INTO checkpoint_manifest_artifacts(id, checkpoint_id, manifest_digest, artifact_digest, artifact_path, media_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(bindingId, checkpoint.id, manifestArtifact.digest, manifestArtifact.digest, manifestArtifact.path, manifestArtifact.mediaType, manifestArtifact.sizeBytes, nowValue);
      });

      const boundArtifact = this.readManifestBinding(checkpoint.id);
      this.runLedger.database.transaction((database) => {
        database.prepare("UPDATE mutation_checkpoints SET status = ? WHERE id = ?").run("completed", checkpoint.id);
        database.prepare("UPDATE mutation_groups SET status = ?, updated_at = ? WHERE id = ?").run("completed", nowValue, boundaryId);
      });
      this.runLedger.appendEvent({
        runId: boundary.runId,
        type: "checkpoint-boundary-published",
        payload: {
          boundaryId,
          checkpointId: checkpoint.id,
          manifestDigest: manifestArtifact.digest,
          artifactPath: manifestArtifact.path
        }
      });
      return {
        checkpointId: checkpoint.id,
        manifestDigest: manifestArtifact.digest,
        artifactPath: manifestArtifact.path,
        boundArtifact
      };
    } catch (cause) {
      const message = toErrorMessage(cause);
      this.failBoundary(boundaryId, checkpoint.id, `publish failed: ${message}`);
      const error = cause instanceof Error ? cause : new Error(message);
      error.name = "ODINN_CHECKPOINT_FAIL_CLOSED";
      throw error;
    }
  }

  recover() {
    const unstable = this.runLedger.database.db.prepare(
      "SELECT id, group_id FROM mutation_checkpoints WHERE status IN ('created', 'checkpointing', 'publishing', 'verifying', 'ready')"
    ).all() as SqlRow[];
    const recovered = unstable.map((row) => {
      this.failBoundary(String(row.group_id), String(row.id), "recovered after interruption");
      return String(row.id);
    });
    return { recovered };
  }

  replayBoundary(boundaryId: string) {
    const boundary = this.readBoundary(boundaryId);
    if (!boundary) throw new Error(`checkpoint boundary not found: ${boundaryId}`);
    const checkpoint = this.currentCheckpoint(boundaryId);
    if (!checkpoint) throw new Error(`checkpoint boundary missing checkpoint: ${boundaryId}`);

    const journals = this.runLedger.database.db.prepare(`
      SELECT id, operation, status, step_id AS stepId, covered_paths_json, conflicts_json
      FROM mutation_journal_entries
      WHERE group_id = ?
      ORDER BY created_at ASC
    `).all(boundaryId) as SqlRow[];
    const parsedJournal = journals.map((journal) => ({
      id: String(journal.id),
      operation: String(journal.operation),
      status: String(journal.status) as MutationJournalRecord["status"],
      stepId: journal.stepId == null ? null : String(journal.stepId),
      coveredPaths: parseJson(journal.covered_paths_json, [] as string[]),
      conflicts: parseJson(journal.conflicts_json, [] as { code: string; path: string }[])
    }));

    const artifacts = this.runLedger.database.db.prepare(`
      SELECT manifest_digest AS manifestDigest, artifact_digest AS artifactDigest, artifact_path AS artifactPath, media_type AS mediaType, size_bytes AS sizeBytes
      FROM checkpoint_manifest_artifacts
      WHERE checkpoint_id = ?
      ORDER BY manifestDigest
    `).all(checkpoint.id) as SqlRow[];

    return {
      boundary,
      checkpoint,
      journal: parsedJournal as MutationJournalRecord[],
      conflicts: parsedJournal.reduce((total, entry) => total + (entry.status === "conflict" ? 1 : 0), 0),
      artifacts: artifacts.map((artifact) => ({
        id: `${artifact.manifestDigest}`,
        checkpointId: checkpoint.id,
        manifestDigest: String(artifact.manifestDigest),
        artifactDigest: String(artifact.artifactDigest),
        artifactPath: String(artifact.artifactPath),
        mediaType: String(artifact.mediaType),
        sizeBytes: Number(artifact.sizeBytes)
      })) as BoundArtifact[]
    };
  }

  private failBoundary(groupId: string, checkpointId: string, reason: string) {
    const nowValue = this.now();
    this.runLedger.database.transaction((database) => {
      database.prepare(
        "UPDATE mutation_checkpoints SET status = ?, error = ?, completed_at = ? WHERE id = ?"
      ).run("needs-review", reason, nowValue, checkpointId);
      database.prepare("UPDATE mutation_groups SET status = ?, updated_at = ? WHERE id = ?")
        .run("needs-review", nowValue, groupId);
    });

    const checkpoint = this.runLedger.database.db.prepare(
      "SELECT run_id FROM mutation_checkpoints WHERE id = ?"
    ).get(checkpointId) as SqlRow | undefined;
    if (checkpoint?.run_id) {
      this.runLedger.appendEvent({
        runId: String(checkpoint.run_id),
        type: "checkpoint-boundary-needs-review",
        payload: { boundaryId: groupId, checkpointId, reason }
      });
    }
  }

  private readBoundary(boundaryId: string): BoundaryRecord | undefined {
    const boundary = this.runLedger.database.db.prepare(
      "SELECT id, run_id, purpose, step_id, foundation, status, created_at, updated_at, metadata_json FROM mutation_groups WHERE id = ?"
    ).get(boundaryId) as SqlRow | undefined;
    if (!boundary) return undefined;
    return {
      id: String(boundary.id),
      runId: String(boundary.run_id),
      purpose: String(boundary.purpose),
      stepId: boundary.step_id ? String(boundary.step_id) : undefined,
      foundation: String(boundary.foundation),
      status: String(boundary.status),
      createdAt: String(boundary.created_at),
      updatedAt: String(boundary.updated_at),
      metadata: parseJson(boundary.metadata_json, {})
    };
  }

  private currentCheckpointId(boundaryId: string): string {
    const checkpoint = this.currentCheckpoint(boundaryId);
    if (!checkpoint) throw new Error(`checkpoint boundary missing checkpoint: ${boundaryId}`);
    return checkpoint.id;
  }

  private currentCheckpoint(boundaryId: string): CheckpointRecord | undefined {
    const checkpoint = this.runLedger.database.db.prepare(
      "SELECT * FROM mutation_checkpoints WHERE group_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(boundaryId) as SqlRow | undefined;
    if (!checkpoint) return undefined;
    return {
      id: String(checkpoint.id),
      status: String(checkpoint.status),
      createdAt: String(checkpoint.created_at),
      completedAt: checkpoint.completed_at == null ? null : String(checkpoint.completed_at),
      error: checkpoint.error == null ? null : String(checkpoint.error)
    };
  }

  private readManifestBinding(checkpointId: string): BoundArtifact | undefined {
    const row = this.runLedger.database.db.prepare(
      "SELECT id, checkpoint_id AS checkpointId, manifest_digest AS manifestDigest, artifact_digest AS artifactDigest, artifact_path AS artifactPath, media_type AS mediaType, size_bytes AS sizeBytes FROM checkpoint_manifest_artifacts WHERE checkpoint_id = ?"
    ).get(checkpointId) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      checkpointId: String(row.checkpointId),
      manifestDigest: String(row.manifestDigest),
      artifactDigest: String(row.artifactDigest),
      artifactPath: String(row.artifactPath).replaceAll("\\", "/"),
      mediaType: String(row.mediaType),
      sizeBytes: Number(row.sizeBytes)
    };
  }
}
