import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { projectDurableToolOutput } from "@odinn/protocol";
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
  manifest?: JsonMap;
  payload?: JsonMap;
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

interface RestoreCheckpointResult {
  checkpointId: string;
  boundaryId: string;
  manifestDigest: string;
  artifactPath: string;
  journal: MutationJournalRecord[];
}

interface CheckpointRestoreConflict {
  code: string;
  path: string;
  message: string;
  details?: JsonMap;
}

interface CheckpointRestorePlan {
  checkpointId: string;
  boundaryId: string;
  runId: string;
  manifestDigest: string;
  status: "ready" | "conflict";
  conflicts: CheckpointRestoreConflict[];
  journal: MutationJournalRecord[];
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

type SqlCountRow = { count?: unknown };

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
    const journalCount = this.readCount("SELECT COUNT(1) AS count FROM mutation_journal_entries WHERE group_id = ?", boundaryId);
    const conflictCount = this.readCount(
      "SELECT COUNT(1) AS count FROM mutation_journal_entries WHERE group_id = ? AND status = 'conflict'",
      boundaryId
    );
    return {
      boundaryId,
      boundaryStatus: boundary.status,
      checkpointId: checkpoint?.id,
      checkpointStatus: checkpoint?.status ?? "unknown",
      journalCount,
      conflictCount
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
    const durablePayload = projectDurableToolOutput("workspace.patch", preview.payload ?? {});
    const durableManifest = projectDurableToolOutput("workspace.patch", manifest);
    const durableConflicts = projectDurableToolOutput("workspace.patch", conflicts);

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
        toJson(durablePayload, "{}"),
        toJson(durableManifest, "{}"),
        toJson(coveredPaths, "[]"),
        toJson(durableConflicts, "[]"),
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
          "INSERT OR IGNORE INTO artifacts(digest, path, media_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)"
        ).run(manifestArtifact.digest, manifestArtifact.path, manifestArtifact.mediaType, manifestArtifact.sizeBytes, nowValue);
        database.prepare(
          "UPDATE mutation_checkpoints SET status = ?, completed_at = ?, manifest_json = ?, manifest_digest = ? WHERE id = ?"
        ).run("verifying", nowValue, toJson(manifest, "{}"), manifestArtifact.digest, checkpoint.id);
        database.prepare(
          "INSERT INTO checkpoint_manifest_artifacts(id, checkpoint_id, manifest_digest, artifact_digest, artifact_path, media_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(bindingId, checkpoint.id, manifestArtifact.digest, manifestArtifact.digest, manifestArtifact.path, manifestArtifact.mediaType, manifestArtifact.sizeBytes, nowValue);
      });

      const boundArtifact = this.readManifestBinding(checkpoint.id);
      if (!boundArtifact || !this.verifyManifestArtifact(boundArtifact)) {
        throw new Error("published checkpoint manifest artifact failed verification");
      }
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
      this.setNeedsReview(boundaryId, checkpoint.id, `publish failed: ${message}`);
      const error = cause instanceof Error ? cause : new Error(message);
      error.name = "ODINN_CHECKPOINT_FAIL_CLOSED";
      throw error;
    }
  }

  recover() {
    const unstable = this.runLedger.database.db.prepare(
      "SELECT id, group_id, status FROM mutation_checkpoints WHERE status IN ('created', 'checkpointing', 'publishing', 'verifying', 'ready')"
    ).all() as SqlRow[];
    const recovered = unstable.map((row) => {
      const checkpointId = String(row.id);
      const boundaryId = String(row.group_id);
      const checkpointStatus = String(row.status);
      const recovery = this.classifyRecoveredCheckpoint(checkpointId, checkpointStatus);
      if (recovery.kind === "complete") {
        this.setCompleted(boundaryId, checkpointId, recovery.completedAt);
      } else {
        this.setNeedsReview(boundaryId, checkpointId, "recovered after interruption");
      }
      return checkpointId;
    });
    return { recovered };
  }

  assertReady() {
    const row = this.runLedger.database.db.prepare(
      "SELECT COUNT(1) AS count FROM mutation_groups WHERE status = 'needs-review'"
    ).get() as SqlCountRow | undefined;
    if (Number(row?.count ?? 0) > 0) {
      const blocked = new Error("Odinn has an unresolved mutation checkpoint; inspect and resolve needs-review state before starting another mutation") as Error & { code?: string };
      blocked.code = "CHECKPOINT_RECOVERY_REQUIRED";
      throw blocked;
    }
  }

  failBoundary(boundaryId: string, reason = "failure detected") {
    const boundary = this.readBoundary(boundaryId);
    if (!boundary) throw new Error(`checkpoint boundary not found: ${boundaryId}`);
    const checkpoint = this.currentCheckpoint(boundaryId);
    if (!checkpoint) throw new Error(`checkpoint boundary missing checkpoint: ${boundaryId}`);
    this.setNeedsReview(boundary.id, checkpoint.id, reason);
  }

  replayBoundary(boundaryId: string) {
    const boundary = this.readBoundary(boundaryId);
    if (!boundary) throw new Error(`checkpoint boundary not found: ${boundaryId}`);
    const checkpoint = this.currentCheckpoint(boundaryId);
    if (!checkpoint) throw new Error(`checkpoint boundary missing checkpoint: ${boundaryId}`);

    const journals = this.runLedger.database.db.prepare(`
      SELECT id, operation, status, step_id AS stepId, covered_paths_json, conflicts_json, manifest_json, payload_json
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
      conflicts: parseJson(journal.conflicts_json, [] as { code: string; path: string }[]),
      manifest: parseJson(journal.manifest_json, {}),
      payload: parseJson(journal.payload_json, {})
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

  describeCheckpoint(checkpointId: string) {
    const checkpoint = this.runLedger.database.db.prepare(`
      SELECT id, group_id AS boundary_id, run_id, status, created_at, completed_at, error, manifest_digest
      FROM mutation_checkpoints
      WHERE id = ?
    `).get(checkpointId) as SqlRow | undefined;
    if (!checkpoint) throw new Error(`checkpoint not found: ${checkpointId}`);

    const boundary = this.readBoundary(String(checkpoint.boundary_id));
    if (!boundary) throw new Error(`checkpoint boundary not found for checkpoint ${checkpointId}`);

    const journal = this.runLedger.database.db.prepare(`
      SELECT id, operation, status, step_id AS stepId, covered_paths_json, conflicts_json, manifest_json, payload_json
      FROM mutation_journal_entries
      WHERE checkpoint_id = ?
      ORDER BY created_at ASC
    `).all(checkpointId) as SqlRow[];
    return {
      checkpointId: String(checkpoint.id),
      boundaryId: String(boundary.id),
      runId: String(checkpoint.run_id),
      status: String(checkpoint.status),
      createdAt: String(checkpoint.created_at),
      completedAt: checkpoint.completed_at == null ? null : String(checkpoint.completed_at),
      manifestDigest: checkpoint.manifest_digest == null ? null : String(checkpoint.manifest_digest),
      error: checkpoint.error == null ? null : String(checkpoint.error),
      journal: journal.map((journalEntry) => ({
        id: String(journalEntry.id),
        operation: String(journalEntry.operation),
        status: String(journalEntry.status) as MutationJournalRecord["status"],
        stepId: journalEntry.stepId == null ? null : String(journalEntry.stepId),
        coveredPaths: parseJson(journalEntry.covered_paths_json, [] as string[]),
        conflicts: parseJson(journalEntry.conflicts_json, [] as { code: string; path: string }[]),
        manifest: parseJson(journalEntry.manifest_json, {}),
        payload: parseJson(journalEntry.payload_json, {})
      }))
    };
  }

  planCheckpointRestore(checkpointId: string, manifestDigest?: string): CheckpointRestorePlan {
    const checkpoint = this.describeCheckpoint(checkpointId);
    const binding = this.readManifestBinding(checkpointId);
    if (!binding) {
      return {
        checkpointId: checkpoint.checkpointId,
        boundaryId: checkpoint.boundaryId,
        runId: checkpoint.runId,
        manifestDigest: manifestDigest ?? "",
        status: "conflict",
        conflicts: [{ code: "MISSING_MANIFEST", path: checkpoint.checkpointId, message: "checkpoint has no manifest artifact", details: {} }],
        journal: checkpoint.journal
      };
    }
    if (!this.verifyManifestArtifact(binding)) {
      return {
        checkpointId: checkpoint.checkpointId,
        boundaryId: checkpoint.boundaryId,
        runId: checkpoint.runId,
        manifestDigest: binding.manifestDigest,
        status: "conflict",
        conflicts: [{ code: "MANIFEST_ARTIFACT_INVALID", path: checkpoint.checkpointId, message: "checkpoint manifest artifact failed byte verification", details: { digest: binding.manifestDigest } }],
        journal: checkpoint.journal
      };
    }
    if (manifestDigest !== undefined && binding.manifestDigest !== manifestDigest) {
      return {
        checkpointId: checkpoint.checkpointId,
        boundaryId: checkpoint.boundaryId,
        runId: checkpoint.runId,
        manifestDigest: binding.manifestDigest,
        status: "conflict",
        conflicts: [{ code: "TARGET_DIGEST_MISMATCH", path: checkpoint.checkpointId, message: "checkpoint manifest digest does not match target", details: { expected: manifestDigest, actual: binding.manifestDigest } }],
        journal: checkpoint.journal
      };
    }
    const status = checkpoint.status === "completed" ? "ready" : "conflict";
    const conflicts: CheckpointRestoreConflict[] = [];
    if (status !== "ready") {
      conflicts.push({ code: "CHECKPOINT_NOT_READY", path: checkpoint.checkpointId, message: "checkpoint is not ready", details: { status: String(checkpoint.status) } });
    }
    for (const entry of checkpoint.journal) {
      if (entry.status === "conflict") {
        conflicts.push({ code: "TARGET_ENTRY_CONFLICT", path: entry.id, message: "checkpoint entry is conflicted", details: { operation: entry.operation } });
      }
    }
    const coveredPathHits = new Map<string, string[]>();
    for (const entry of checkpoint.journal) {
      for (const coveredPath of entry.coveredPaths) {
        const existing = coveredPathHits.get(coveredPath);
        if (existing) existing.push(entry.id);
        else coveredPathHits.set(coveredPath, [entry.id]);
      }
    }
    for (const [path, seenBy] of coveredPathHits.entries()) {
      if (seenBy.length > 1) {
        conflicts.push({
          code: "COVERED_PATH_CONFLICT",
          path,
          message: "covered-path overlap cannot be safely restored",
          details: { entries: seenBy.join(",") }
        });
      }
    }
    return {
      checkpointId: checkpoint.checkpointId,
      boundaryId: checkpoint.boundaryId,
      runId: checkpoint.runId,
      manifestDigest: binding.manifestDigest,
      status,
      conflicts,
      journal: checkpoint.journal
    };
  }

  private setNeedsReview(groupId: string, checkpointId: string, reason: string) {
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
  private readCount(statement: string, boundaryId: string): number {
    const row = this.runLedger.database.db.prepare(statement).get(boundaryId) as SqlCountRow | undefined;
    return Number(row?.count ?? 0);
  }

  private hasCheckpointManifest(checkpointId: string): boolean {
    const row = this.readManifestBinding(checkpointId);
    return Boolean(row && this.verifyManifestArtifact(row));
  }

  private verifyManifestArtifact(binding: BoundArtifact): boolean {
    const artifactRoot = resolve(this.runLedger.artifacts.root);
    const artifactPath = resolve(artifactRoot, binding.artifactPath);
    if (!(artifactPath === artifactRoot || artifactPath.startsWith(`${artifactRoot}${sep}`))) return false;
    try {
      if (!existsSync(artifactPath) || !lstatSync(artifactPath).isFile()) return false;
      const bytes = readFileSync(artifactPath);
      return bytes.byteLength === binding.sizeBytes
        && createHash("sha256").update(bytes).digest("hex") === binding.artifactDigest
        && binding.manifestDigest === binding.artifactDigest;
    } catch {
      return false;
    }
  }

  private countCheckpointJournalEntries(checkpointId: string): number {
    const row = this.runLedger.database.db.prepare(
      "SELECT COUNT(1) AS count FROM mutation_journal_entries WHERE checkpoint_id = ?"
    ).get(checkpointId) as SqlCountRow | undefined;
    return Number(row?.count ?? 0);
  }

  private classifyRecoveredCheckpoint(checkpointId: string, status: string):
    { kind: "complete"; completedAt: string } | { kind: "needs-review" } {
    if (!ACTIVE_STATUSES.has(status)) return { kind: "needs-review" };
    if (status === "verifying") {
      if (this.hasCheckpointManifest(checkpointId)) {
        return { kind: "complete", completedAt: this.now() };
      }
      return { kind: "needs-review" };
    }
    const mutationCount = this.countCheckpointJournalEntries(checkpointId);
    if (status === "created" && mutationCount === 0) {
      return { kind: "complete", completedAt: this.now() };
    }
    return { kind: "needs-review" };
  }

  private setCompleted(groupId: string, checkpointId: string, completedAt: string) {
    this.runLedger.database.transaction((database) => {
      database.prepare(
        "UPDATE mutation_checkpoints SET status = ?, completed_at = COALESCE(completed_at, ?), error = NULL WHERE id = ?"
      ).run("completed", completedAt, checkpointId);
      database.prepare("UPDATE mutation_groups SET status = ?, updated_at = ? WHERE id = ?").run("completed", completedAt, groupId);
    });
  }
}
