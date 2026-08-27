import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { chmod, lstat, open, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  canonicalJson,
  isLiveOnlyAutomationTool,
  projectDurableJobPayload,
  projectDurableToolInput,
  projectDurableToolOutput,
  workflowDefinitionDigest,
  type JsonObject
} from "@odinn/protocol";

const CRON_MAX_BYTES = 4 * 1024 * 1024;
const LEGACY_JOBS_MAX_BYTES = 64 * 1024 * 1024;
const QUARANTINE_CODE = "LIVE_ONLY_AUTOMATION_INPUT_REMOVED";
const WORKFLOW_QUARANTINE_CODE = "WORKFLOW_LIVE_INPUT_QUARANTINED";
const QUARANTINED_WORKFLOW_ACTION = "automation.quarantined";
const SHA256_REFERENCE = /^sha256:[a-f0-9]{64}$/u;
const DURABLE_OUTPUT_KEYS = new Set([
  "type", "contentUnavailableOnReplay", "targetDigest", "payloadDigest", "payloadBytes",
  "accountCount", "messageCount", "toCount", "ccCount", "attachmentCount", "itemCount", "attendeeCount"
]);
const RUNTIME_RESULT_KEYS = new Set([
  "id", "tool", "capability", "capabilities", "ok", "replayed", "contentUnavailableOnReplay", "output"
]);

type RecordValue = Record<string, any>;
type SqlRow = Record<string, any>;

export type LiveOnlyAutomationQuarantineReport = Readonly<{
  cronJobs: number;
  legacyJobs: number;
  runtimeJobs: number;
  workflows: number;
}>;

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function asRecord(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as RecordValue;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
}

function contentTombstone(value: unknown): JsonObject {
  const encoded = canonicalJson(value);
  return {
    contentUnavailableAfterUpgrade: true,
    payloadDigest: sha256(encoded),
    payloadBytes: Buffer.byteLength(encoded, "utf8")
  };
}

function projectedInputTombstone(tool: string, input: unknown): JsonObject {
  const projected = projectDurableToolInput(tool, input);
  return {
    quarantinedTool: tool,
    liveInputAvailable: false,
    ...(projected && typeof projected === "object" && !Array.isArray(projected)
      ? projected as JsonObject
      : { projection: projected })
  };
}

function runtimeJobTool(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const task = (payload as RecordValue).task;
  return task && typeof task === "object" && !Array.isArray(task) && typeof task.tool === "string"
    ? task.tool
    : "";
}

function quarantinedRuntimePayload(payload: RecordValue, tool: string): JsonObject {
  const task = asRecord(payload.task, `legacy ${tool} runtime job task`);
  return {
    liveOnlyQuarantined: true,
    task: {
      ...(typeof task.id === "string" ? { id: task.id } : {}),
      tool,
      input: projectedInputTombstone(tool, task.input)
    }
  };
}

function quarantinedRuntimeResult(tool: string, result: unknown): unknown {
  if (result === undefined || result === null) return result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return projectDurableToolOutput(tool, result);
  }
  const record = result as RecordValue;
  const output = "output" in record ? record.output : result;
  return {
    tool,
    contentUnavailableOnReplay: true,
    output: projectDurableToolOutput(tool, output)
  };
}

function isDurableLiveOutput(tool: string, value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as RecordValue;
  if (Object.keys(record).some((key) => !DURABLE_OUTPUT_KEYS.has(key))) return false;
  if (record.type !== tool
    || record.contentUnavailableOnReplay !== true
    || !SHA256_REFERENCE.test(String(record.targetDigest ?? ""))
    || !SHA256_REFERENCE.test(String(record.payloadDigest ?? ""))
    || !Number.isSafeInteger(record.payloadBytes)
    || record.payloadBytes < 0) return false;
  return Object.entries(record).every(([key, item]) => !key.endsWith("Count") || (Number.isSafeInteger(item) && Number(item) >= 0));
}

function projectedRuntimeResult(tool: string, result: unknown): unknown {
  if (result === undefined || result === null) return result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return projectDurableToolOutput(tool, result);
  const record = result as RecordValue;
  if (isDurableLiveOutput(tool, record)) return record;
  if (!("output" in record)) return projectDurableToolOutput(tool, result);
  if (isDurableLiveOutput(tool, record.output)) {
    if (Object.keys(record).every((key) => RUNTIME_RESULT_KEYS.has(key))) return record;
    return {
      ...(typeof record.id === "string" ? { id: record.id } : {}),
      tool,
      ...(typeof record.capability === "string" ? { capability: record.capability } : {}),
      ...(Array.isArray(record.capabilities) && record.capabilities.every((value: unknown) => typeof value === "string") ? { capabilities: record.capabilities } : {}),
      ...(typeof record.ok === "boolean" ? { ok: record.ok } : {}),
      output: record.output
    };
  }
  return { ...record, output: projectDurableToolOutput(tool, record.output) };
}

function quarantinedLegacyJob(value: unknown, migratedAt: string): { changed: boolean; value: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { changed: false, value };
  const job = value as RecordValue;
  const tool = runtimeJobTool(job.payload);
  if (!isLiveOnlyAutomationTool(tool)) return { changed: false, value };
  if (job.liveOnlyQuarantine?.code === QUARANTINE_CODE
    && job.recoveryInputAvailable === false
    && job.payload?.liveOnlyQuarantined === true) return { changed: false, value };
  const payload = quarantinedRuntimePayload(asRecord(job.payload, `legacy runtime job ${String(job.id ?? "unknown")} payload`), tool);
  const next: RecordValue = {
    schemaVersion: 1,
    id: String(job.id ?? ""),
    status: "needs-review",
    payload,
    recoveryInputAvailable: false,
    attempts: Number.isSafeInteger(job.attempts) && job.attempts >= 0 ? job.attempts : 0,
    timeoutMs: Number.isSafeInteger(job.timeoutMs) && job.timeoutMs > 0 ? job.timeoutMs : 120_000,
    retrySafe: false,
    error: "live-only persisted input was removed during startup; resubmit with fresh input",
    createdAt: typeof job.createdAt === "string" ? job.createdAt : migratedAt,
    updatedAt: migratedAt,
    completedAt: migratedAt,
    recoveredAt: migratedAt,
    liveOnlyQuarantine: { schemaVersion: 1, code: QUARANTINE_CODE, originalTool: tool, migratedAt }
  };
  for (const key of ["requestHash", "occurrenceKey", "scheduledFor", "nextRunAt", "executionRunId", "executionAttemptId", "envelopeDigest", "auditCorrelationId", "cancellationControlReference"] as const) {
    if (typeof job[key] === "string" || (key === "nextRunAt" && job[key] === null)) next[key] = job[key];
  }
  if (job.result !== undefined) next.result = quarantinedRuntimeResult(tool, job.result);
  return { changed: canonicalJson(next) !== canonicalJson(value), value: next };
}

async function readBoundedJson(path: string, maximumBytes: number, label: string): Promise<{ value: unknown; source: string } | undefined> {
  let pathMetadata;
  try {
    pathMetadata = await lstat(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() || pathMetadata.nlink !== 1) throw new Error(`${label} must be a private physical file`);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let source: string;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.dev !== pathMetadata.dev || metadata.ino !== pathMetadata.ino) {
      throw new Error(`${label} changed during startup quarantine`);
    }
    if (metadata.size > maximumBytes) throw new Error(`${label} exceeds its migration size limit`);
    source = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  return { value: parseJson(source, label), source };
}

async function writePrivateJson(path: string, value: unknown): Promise<string> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
  return content;
}

async function quarantineCronFile(path: string, migratedAt: string): Promise<number> {
  const source = await readBoundedJson(path, CRON_MAX_BYTES, "cron-jobs.json");
  if (!source) return 0;
  const collection = asRecord(source.value, "cron-jobs.json");
  if (collection.schemaVersion !== 1 && collection.schemaVersion !== 2) return 0;
  if (!Array.isArray(collection.jobs)) {
    throw new Error("cron-jobs.json is not a supported job collection");
  }
  let changed = 0;
  const jobs = collection.jobs.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const job = value as RecordValue;
    const tool = typeof job.tool === "string" ? job.tool : "";
    if (!isLiveOnlyAutomationTool(tool)) return value;
    if (job.liveOnlyQuarantine?.code === QUARANTINE_CODE
      && job.enabled === false
      && job.liveOnlyQuarantine?.originalTool === tool) return value;
    changed += 1;
    const next: RecordValue = {
      ...job,
      enabled: false,
      input: projectedInputTombstone(tool, job.input),
      lastStatus: "error",
      lastError: `live-only tool ${tool} requires fresh input and cannot be persisted in cron`,
      updatedAt: migratedAt,
      liveOnlyQuarantine: { schemaVersion: 1, code: QUARANTINE_CODE, originalTool: tool, migratedAt }
    };
    delete next.dispatchLease;
    delete next.scheduledFor;
    return next;
  });
  if (changed > 0) await writePrivateJson(path, { ...collection, jobs });
  return changed;
}

async function quarantineLegacyJobsFile(path: string, migratedAt: string): Promise<{ count: number; digest?: string }> {
  const source = await readBoundedJson(path, LEGACY_JOBS_MAX_BYTES, "jobs.json");
  if (!source) return { count: 0 };
  const collection = asRecord(source.value, "jobs.json");
  if (collection.schemaVersion !== 1) {
    return { count: 0, digest: createHash("sha256").update(source.source, "utf8").digest("hex") };
  }
  if (!collection.jobs || typeof collection.jobs !== "object" || Array.isArray(collection.jobs)) {
    throw new Error("jobs.json is not a supported legacy runtime-job collection");
  }
  let count = 0;
  const jobs = Object.fromEntries(Object.entries(collection.jobs).map(([id, value]) => {
    const quarantined = quarantinedLegacyJob(value, migratedAt);
    if (quarantined.changed) count += 1;
    return [id, quarantined.value];
  }));
  const content = count > 0
    ? await writePrivateJson(path, { ...collection, jobs })
    : source.source;
  return { count, digest: createHash("sha256").update(content, "utf8").digest("hex") };
}

function hasTable(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function quarantineWorkflowState(database: DatabaseSync, migratedAt: string): number {
  if (!hasTable(database, "workflow_definitions")
    || !hasTable(database, "workflow_runs")
    || !hasTable(database, "workflow_steps")) return 0;
  const definitions = database.prepare("SELECT id, revision, definition_json FROM workflow_definitions").all() as SqlRow[];
  const liveRows = database.prepare(`SELECT DISTINCT r.definition_id, r.definition_revision
    FROM workflow_steps s JOIN workflow_runs r ON r.run_id=s.run_id
    WHERE s.action_ref IN ('email.accounts','email.search','email.read','email.thread','calendar.calendars','calendar.events','calendar.read')`).all() as SqlRow[];
  const liveKeys = new Set(liveRows.map((row) => `${String(row.definition_id)}\0${Number(row.definition_revision)}`));
  let workflows = 0;
  for (const row of definitions) {
    const definition = asRecord(parseJson(String(row.definition_json), `workflow definition ${String(row.id)}@${String(row.revision)}`), "workflow definition");
    const steps = Array.isArray(definition.steps) ? definition.steps : [];
    const key = `${String(row.id)}\0${Number(row.revision)}`;
    if (!liveKeys.has(key) && !steps.some((step: unknown) => step && typeof step === "object" && !Array.isArray(step) && isLiveOnlyAutomationTool((step as RecordValue).actionRef))) continue;
    const safeSteps = steps.map((step: unknown) => {
      const current = asRecord(step, `workflow definition ${String(row.id)} step`);
      const tool = typeof current.actionRef === "string" ? current.actionRef : "";
      return {
        ...current,
        actionRef: isLiveOnlyAutomationTool(tool) ? QUARANTINED_WORKFLOW_ACTION : tool,
        input: isLiveOnlyAutomationTool(tool)
          ? projectedInputTombstone(tool, current.input)
          : contentTombstone(current.input)
      };
    });
    const safeDefinitionBase = {
      schemaVersion: definition.schemaVersion,
      id: definition.id,
      revision: definition.revision,
      name: "Quarantined live-only workflow",
      steps: safeSteps
    };
    const definitionDigest = workflowDefinitionDigest(safeDefinitionBase as any);
    const runRows = database.prepare("SELECT run_id FROM workflow_runs WHERE definition_id=? AND definition_revision=?").all(row.id, row.revision) as SqlRow[];
    for (const runRow of runRows) {
      const runId = String(runRow.run_id);
      const stepRows = database.prepare("SELECT step_id, action_ref, input_json, result_json FROM workflow_steps WHERE run_id=?").all(runId) as SqlRow[];
      for (const stepRow of stepRows) {
        const tool = String(stepRow.action_ref);
        const input = parseJson(String(stepRow.input_json), `workflow ${runId} step ${String(stepRow.step_id)} input`);
        const result = stepRow.result_json === null ? undefined : parseJson(String(stepRow.result_json), `workflow ${runId} step ${String(stepRow.step_id)} result`);
        database.prepare(`UPDATE workflow_steps SET action_ref=?, input_json=?, recovery_input_available=0,
          result_json=?, status='needs-review', error_code=?, lease_token=NULL, lease_expires_at=NULL, updated_at=?
          WHERE run_id=? AND step_id=?`).run(
          isLiveOnlyAutomationTool(tool) ? QUARANTINED_WORKFLOW_ACTION : tool,
          canonicalJson(isLiveOnlyAutomationTool(tool) ? projectedInputTombstone(tool, input) : contentTombstone(input)),
          result === undefined ? null : canonicalJson(isLiveOnlyAutomationTool(tool) ? projectDurableToolOutput(tool, result) : contentTombstone(result)),
          WORKFLOW_QUARANTINE_CODE,
          migratedAt,
          runId,
          stepRow.step_id
        );
      }
      const runInput = database.prepare("SELECT input_json FROM workflow_runs WHERE run_id=?").get(runId) as SqlRow;
      const safeRunInput = contentTombstone(parseJson(String(runInput.input_json), `workflow ${runId} input`));
      database.prepare(`UPDATE workflow_runs SET definition_digest=?, status='needs-review', input_json=?,
        recovery_input_available=0, error_code=?, updated_at=? WHERE run_id=?`).run(
        definitionDigest,
        canonicalJson(safeRunInput),
        WORKFLOW_QUARANTINE_CODE,
        migratedAt,
        runId
      );
      if (hasTable(database, "workflow_events")) {
        database.prepare("INSERT INTO workflow_events(run_id,type,payload_json,created_at) VALUES (?,?,?,?)")
          .run(runId, "workflow.live-only-input-quarantined", canonicalJson({ code: WORKFLOW_QUARANTINE_CODE }), migratedAt);
      }
      workflows += 1;
    }
    database.prepare("UPDATE workflow_definitions SET definition_digest=?, definition_json=? WHERE id=? AND revision=?").run(
      definitionDigest,
      canonicalJson({ ...safeDefinitionBase, definitionDigest }),
      row.id,
      row.revision
    );
  }
  return workflows;
}

function quarantineRuntimeJobs(database: DatabaseSync, migratedAt: string): number {
  if (!hasTable(database, "runtime_jobs")) return 0;
  const rows = database.prepare("SELECT id,status,payload_json,payload_recoverable,result_json,execution_attempt_id FROM runtime_jobs").all() as SqlRow[];
  let count = 0;
  for (const row of rows) {
    const payload = asRecord(parseJson(String(row.payload_json), `runtime job ${String(row.id)} payload`), "runtime job payload");
    const tool = runtimeJobTool(payload);
    if (!isLiveOnlyAutomationTool(tool)) continue;
    const safePayload = quarantinedRuntimePayload(payload, tool);
    if (payload.liveOnlyQuarantined === true && Number(row.payload_recoverable) === 0) continue;
    const standardPayload = projectDurableJobPayload(payload);
    const rawResult = row.result_json === null ? undefined : parseJson(String(row.result_json), `runtime job ${String(row.id)} result`);
    const standardResult = projectedRuntimeResult(tool, rawResult);
    const safeResult = quarantinedRuntimeResult(tool, rawResult);
    const payloadChanged = canonicalJson(payload) !== canonicalJson(standardPayload);
    const resultChanged = canonicalJson(rawResult) !== canonicalJson(standardResult);
    if (!payloadChanged && !resultChanged && Number(row.payload_recoverable) === 0) continue;
    database.prepare(`UPDATE runtime_jobs SET status='needs-review', payload_json=?, payload_recoverable=0,
      retry_safe=0, result_json=?, error=?, updated_at=?, completed_at=COALESCE(completed_at,?), recovered_at=?,
      lease_token=NULL, lease_owner=NULL, lease_epoch=NULL, lease_acquired_at=NULL, lease_expires_at=NULL
      WHERE id=?`).run(
      canonicalJson(safePayload),
      safeResult === undefined ? null : canonicalJson(safeResult),
      "live-only persisted input was removed during startup; resubmit with fresh input",
      migratedAt,
      migratedAt,
      migratedAt,
      row.id
    );
    if (row.execution_attempt_id && hasTable(database, "execution_attempts")) {
      database.prepare(`UPDATE execution_attempts SET state='needs-review', settled_at=COALESCE(settled_at,?),
        error_code=COALESCE(error_code,'LIVE_ONLY_INPUT_QUARANTINED')
        WHERE id=? AND state NOT IN ('completed','failed','cancelled','needs-review')`).run(migratedAt, row.execution_attempt_id);
    }
    if (hasTable(database, "runtime_job_leases")) {
      database.prepare(`UPDATE runtime_job_leases SET released_at=COALESCE(released_at,?),
        release_reason=COALESCE(release_reason,'live-only-input-quarantined') WHERE job_id=?`).run(migratedAt, row.id);
    }
    count += 1;
  }
  return count;
}

function quarantineRuntimeDatabase(path: string, migratedAt: string, legacyJobsDigest?: string): { runtimeJobs: number; workflows: number } {
  const database = new DatabaseSync(path);
  let runtimeJobs = 0;
  let workflows = 0;
  let changed = false;
  try {
    database.exec("PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; BEGIN IMMEDIATE");
    try {
      workflows = quarantineWorkflowState(database, migratedAt);
      runtimeJobs = quarantineRuntimeJobs(database, migratedAt);
      if (legacyJobsDigest && hasTable(database, "runtime_job_imports")) {
        const update = database.prepare("UPDATE runtime_job_imports SET source_digest=? WHERE source_path='jobs.json' AND source_digest<>?")
          .run(legacyJobsDigest, legacyJobsDigest);
        changed = Number(update.changes) > 0;
      }
      changed = changed || workflows > 0 || runtimeJobs > 0;
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    if (changed) {
      database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
      database.exec("VACUUM");
      database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
    }
  } finally {
    database.close();
  }
  return { runtimeJobs, workflows };
}

/**
 * Remove pre-hardening live-only automation payloads before any compatibility
 * backup is allowed to snapshot state. This migration is intentionally
 * idempotent and never makes a quarantined request replayable.
 */
export async function quarantineLegacyLiveOnlyAutomationState(stateRoot: string): Promise<LiveOnlyAutomationQuarantineReport> {
  const migratedAt = new Date().toISOString();
  const cronJobs = await quarantineCronFile(join(stateRoot, "cron-jobs.json"), migratedAt);
  const legacy = await quarantineLegacyJobsFile(join(stateRoot, "jobs.json"), migratedAt);
  let runtimeJobs = 0;
  let workflows = 0;
  const databasePath = join(stateRoot, "db", "odinn.sqlite");
  try {
    const metadata = await lstat(databasePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error("runtime SQLite state must be a private physical file");
    ({ runtimeJobs, workflows } = quarantineRuntimeDatabase(databasePath, migratedAt, legacy.digest));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { cronJobs, legacyJobs: legacy.count, runtimeJobs, workflows };
}
