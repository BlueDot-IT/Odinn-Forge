import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { cwd as currentWorkingDirectory } from "node:process";
import {
  MAX_EXECUTION_ENVELOPE_BYTES,
  canonicalizeExecutionEnvelopeV1,
  digestExecutionEnvelopeV1,
  redactDurableValue,
  validateExecutionEnvelopeV1,
  type DurableRedactionContext,
  type ExecutionEnvelopeV1
} from "@odinn/protocol";
export { SQLITE_AUDIT_SCHEMA_VERSION, SqliteAuditStore, auditMigrationStatus, inspectExistingSqliteAuditSchema, migrateLegacyAuditToSqlite, rollbackLegacyAuditMigration } from "./audit.ts";
export type { AuditIntegrityStatus, AuditPage } from "./audit.ts";

export const SQLITE_SCHEMA_VERSION = 7;
export type SqliteStoreOptions = { targetVersion?: number };
type JsonMap = { [key: string]: unknown };
type SqlRow = { [key: string]: any };
type FeatureFlags = Record<string, boolean>;
type Artifact = { digest: string; path: string; mediaType: string; sizeBytes: number };
export type ExecutionAttemptState = "proposed" | "admitted" | "queued" | "running" | "awaiting-approval" | "cancelling" | "completed" | "failed" | "cancelled" | "needs-review";
type InitialExecutionAttemptState = "proposed" | "admitted" | "queued";
const INITIAL_EXECUTION_ATTEMPT_STATES = new Set<ExecutionAttemptState>(["proposed", "admitted", "queued"]);
const TERMINAL_EXECUTION_ATTEMPT_STATES = new Set<ExecutionAttemptState>(["completed", "failed", "cancelled", "needs-review"]);
const EXECUTION_ATTEMPT_TRANSITIONS: Readonly<Record<ExecutionAttemptState, ReadonlySet<ExecutionAttemptState>>> = Object.freeze({
  proposed: new Set<ExecutionAttemptState>(["admitted", "failed", "cancelled"]),
  admitted: new Set<ExecutionAttemptState>(["queued", "failed", "cancelled"]),
  queued: new Set<ExecutionAttemptState>(["running", "failed", "cancelled"]),
  running: new Set<ExecutionAttemptState>(["awaiting-approval", "cancelling", "completed", "failed", "cancelled", "needs-review"]),
  "awaiting-approval": new Set<ExecutionAttemptState>(["running", "completed", "failed", "cancelled", "needs-review"]),
  cancelling: new Set<ExecutionAttemptState>(["completed", "failed", "cancelled", "needs-review"]),
  completed: new Set<ExecutionAttemptState>(),
  failed: new Set<ExecutionAttemptState>(),
  cancelled: new Set<ExecutionAttemptState>(),
  "needs-review": new Set<ExecutionAttemptState>()
});

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as JsonMap;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function redact(value: unknown, context: DurableRedactionContext = {}): unknown {
  return redactDurableValue(value, context);
}

const SHA256_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotateRight(value: number, bits: number) { return (value >>> bits) | (value << (32 - bits)); }

function digest(value: string | Buffer): string {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = Buffer.alloc(paddedLength);
  input.copy(padded);
  padded[input.length] = 0x80;
  padded.writeUInt32BE(Math.floor(bitLength / 0x100000000), paddedLength - 8);
  padded.writeUInt32BE(bitLength >>> 0, paddedLength - 4);
  let [a0, b0, c0, d0, e0, f0, g0, h0] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = padded.readUInt32BE(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15]; const y = words[index - 2];
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = [a0, b0, c0, d0, e0, f0, g0, h0];
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + temp1) >>> 0, c, b, a, (temp1 + temp2) >>> 0];
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
    e0 = (e0 + e) >>> 0; f0 = (f0 + f) >>> 0; g0 = (g0 + g) >>> 0; h0 = (h0 + h) >>> 0;
  }
  return [a0, b0, c0, d0, e0, f0, g0, h0].map((word) => word.toString(16).padStart(8, "0")).join("");
}

function parseJson<T>(value: unknown, fallback: T): T {
  try { return typeof value === "string" && value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    parent_run_id TEXT,
    branch_point_step_id TEXT,
    status TEXT NOT NULL,
    objective TEXT NOT NULL,
    model_id TEXT,
    provider_id TEXT,
    workspace_root TEXT NOT NULL,
    feature_flags_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS run_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    input_digest TEXT,
    output_digest TEXT,
    metadata_json TEXT NOT NULL,
    UNIQUE(run_id, sequence)
  );
  CREATE TABLE IF NOT EXISTS artifacts (
    digest TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ledger_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    previous_hash TEXT,
    hash TEXT NOT NULL,
    UNIQUE(run_id, sequence),
    UNIQUE(run_id, hash)
  );
  CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_ledger_events_run ON ledger_events(run_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_ledger_events_type ON ledger_events(type, timestamp);`
  ,
  `CREATE TABLE IF NOT EXISTS verification_contracts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    version INTEGER NOT NULL,
    contract_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, id)
  );
  CREATE TABLE IF NOT EXISTS assertion_results (
    id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL REFERENCES verification_contracts(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    assertion_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    evidence_artifact_ids_json TEXT NOT NULL,
    message TEXT NOT NULL,
    result_json TEXT NOT NULL,
    UNIQUE(contract_id, assertion_id)
  );
  CREATE TABLE IF NOT EXISTS policies (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    policy_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS policy_evaluations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    step_id TEXT,
    policy_id TEXT,
    invariant_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    enforcement TEXT NOT NULL,
    reason TEXT NOT NULL,
    input_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS capabilities (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    step_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    constraints_json TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    max_uses INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    approval_id TEXT,
    nonce TEXT NOT NULL UNIQUE,
    revoked_at TEXT,
    status TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS capability_uses (
    id TEXT PRIMARY KEY,
    capability_id TEXT NOT NULL REFERENCES capabilities(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    tool_name TEXT NOT NULL,
    resource_json TEXT NOT NULL,
    used_at TEXT NOT NULL,
    ok INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    step_id TEXT,
    label TEXT,
    workspace_root TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS snapshot_entries (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
    path TEXT NOT NULL,
    existed INTEGER NOT NULL,
    mode INTEGER,
    digest TEXT,
    artifact_digest TEXT,
    UNIQUE(snapshot_id, path)
  );
  CREATE TABLE IF NOT EXISTS run_branches (
    id TEXT PRIMARY KEY,
    source_run_id TEXT NOT NULL REFERENCES runs(id),
    source_step_id TEXT NOT NULL,
    child_run_id TEXT NOT NULL REFERENCES runs(id),
    label TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(source_run_id, child_run_id)
  );
  CREATE TABLE IF NOT EXISTS compensation_actions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    step_id TEXT NOT NULL,
    handler TEXT NOT NULL,
    status TEXT NOT NULL,
    input_json TEXT NOT NULL,
    output_json TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS capsules (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    path TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    digest TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS model_observations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    task_class TEXT NOT NULL,
    verified INTEGER NOT NULL,
    partially_verified INTEGER NOT NULL,
    cost_usd REAL,
    duration_ms INTEGER NOT NULL,
    tool_calls INTEGER NOT NULL,
    tool_errors INTEGER NOT NULL,
    retries INTEGER NOT NULL,
    policy_violations INTEGER NOT NULL,
    rolled_back INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS counterfactual_groups (
    id TEXT PRIMARY KEY,
    source_run_id TEXT NOT NULL REFERENCES runs(id),
    contract_id TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS counterfactual_candidates (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES counterfactual_groups(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    plan_json TEXT NOT NULL,
    status TEXT NOT NULL,
    selected_at TEXT,
    UNIQUE(group_id, run_id)
  );
  CREATE INDEX IF NOT EXISTS idx_assertion_results_run ON assertion_results(run_id, completed_at);
  CREATE INDEX IF NOT EXISTS idx_policy_evaluations_run ON policy_evaluations(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_capabilities_run ON capabilities(run_id, status);
  CREATE INDEX IF NOT EXISTS idx_snapshots_run ON snapshots(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_model_observations_model ON model_observations(provider_id, model_id, task_class);`,
  `CREATE TABLE IF NOT EXISTS run_request_bindings (
    run_id TEXT PRIMARY KEY REFERENCES runs(id),
    request_digest TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS execution_envelopes (
    run_id TEXT PRIMARY KEY REFERENCES runs(id),
    schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    principal_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    envelope_digest TEXT NOT NULL,
    envelope_json TEXT NOT NULL CHECK(length(CAST(envelope_json AS BLOB)) <= ${MAX_EXECUTION_ENVELOPE_BYTES}),
    admitted_at TEXT NOT NULL,
    UNIQUE(principal_id, idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS execution_attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES execution_envelopes(run_id),
    attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
    state TEXT NOT NULL CHECK(state IN ('proposed', 'admitted', 'queued', 'running', 'awaiting-approval', 'cancelling', 'completed', 'failed', 'cancelled', 'needs-review')),
    created_at TEXT NOT NULL,
    started_at TEXT,
    settled_at TEXT,
    outcome_digest TEXT,
    error_code TEXT,
    UNIQUE(run_id, attempt_number)
  );
  CREATE TABLE IF NOT EXISTS cancellation_controls (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE REFERENCES execution_envelopes(run_id),
    requested_at TEXT,
    requested_by TEXT,
    reason TEXT,
    acknowledged_at TEXT,
    settled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_execution_envelopes_principal ON execution_envelopes(principal_id, admitted_at);
  CREATE INDEX IF NOT EXISTS idx_execution_attempts_state ON execution_attempts(state, created_at);`,
  `CREATE TABLE IF NOT EXISTS runtime_jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'awaiting-approval', 'cancelling', 'completed', 'failed', 'cancelled', 'needs-review')),
    payload_json TEXT NOT NULL CHECK(length(CAST(payload_json AS BLOB)) <= 1048576),
    payload_recoverable INTEGER NOT NULL CHECK(payload_recoverable IN (0, 1)),
    request_hash TEXT CHECK(request_hash IS NULL OR length(request_hash) <= 512),
    retry_safe INTEGER NOT NULL CHECK(retry_safe IN (0, 1)),
    attempts INTEGER NOT NULL CHECK(attempts >= 0),
    timeout_ms INTEGER NOT NULL CHECK(timeout_ms > 0),
    result_json TEXT CHECK(result_json IS NULL OR length(CAST(result_json AS BLOB)) <= 1048576),
    error TEXT CHECK(error IS NULL OR length(CAST(error AS BLOB)) <= 16384),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    recovered_at TEXT,
    occurrence_key TEXT UNIQUE,
    scheduled_for TEXT,
    next_run_at TEXT,
    execution_run_id TEXT,
    execution_attempt_id TEXT UNIQUE REFERENCES execution_attempts(id),
    envelope_digest TEXT,
    audit_correlation_id TEXT,
    cancellation_control_reference TEXT,
    imported_from_legacy INTEGER NOT NULL DEFAULT 0 CHECK(imported_from_legacy IN (0, 1)),
    lease_token TEXT UNIQUE,
    lease_owner TEXT,
    lease_epoch TEXT,
    lease_acquired_at TEXT,
    lease_expires_at TEXT
  );
  CREATE TABLE IF NOT EXISTS runtime_job_imports (
    source_path TEXT PRIMARY KEY,
    source_digest TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    imported_jobs INTEGER NOT NULL CHECK(imported_jobs >= 0)
  );
  CREATE TABLE IF NOT EXISTS runtime_job_leases (
    token TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES runtime_jobs(id),
    occurrence_key TEXT,
    owner TEXT NOT NULL,
    epoch TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    released_at TEXT,
    release_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runtime_jobs_status ON runtime_jobs(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_runtime_jobs_queue ON runtime_jobs(status, created_at, id);
  CREATE INDEX IF NOT EXISTS idx_runtime_jobs_execution ON runtime_jobs(execution_run_id, execution_attempt_id);
  CREATE INDEX IF NOT EXISTS idx_runtime_job_leases_job ON runtime_job_leases(job_id, acquired_at);`
  ,
  `CREATE TABLE IF NOT EXISTS mutation_groups (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    purpose TEXT NOT NULL,
    step_id TEXT,
    foundation TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mutation_checkpoints (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    group_id TEXT NOT NULL REFERENCES mutation_groups(id),
    status TEXT NOT NULL,
    label TEXT,
    manifest_json TEXT,
    manifest_digest TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    error TEXT,
    UNIQUE(group_id, id)
  );
  CREATE TABLE IF NOT EXISTS mutation_journal_entries (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    group_id TEXT NOT NULL REFERENCES mutation_groups(id),
    checkpoint_id TEXT NOT NULL REFERENCES mutation_checkpoints(id),
    step_id TEXT,
    operation TEXT NOT NULL,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    covered_paths_json TEXT NOT NULL,
    conflicts_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS checkpoint_manifest_artifacts (
    id TEXT PRIMARY KEY,
    checkpoint_id TEXT NOT NULL REFERENCES mutation_checkpoints(id),
    manifest_digest TEXT NOT NULL,
    artifact_digest TEXT NOT NULL REFERENCES artifacts(digest),
    artifact_path TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(checkpoint_id, manifest_digest)
  );
  CREATE INDEX IF NOT EXISTS idx_mutation_groups_run ON mutation_groups(run_id, status);
  CREATE INDEX IF NOT EXISTS idx_mutation_checkpoints_group ON mutation_checkpoints(group_id, status);
  CREATE INDEX IF NOT EXISTS idx_mutation_checkpoints_run ON mutation_checkpoints(run_id, status);
  CREATE INDEX IF NOT EXISTS idx_mutation_journal_group ON mutation_journal_entries(group_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_mutation_journal_checkpoint ON mutation_journal_entries(checkpoint_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_checkpoint_manifest_artifacts_checkpoint ON checkpoint_manifest_artifacts(checkpoint_id, manifest_digest);`
  ,
  `CREATE TABLE IF NOT EXISTS agent_graph_runs (
    id TEXT PRIMARY KEY,
    parent_run_id TEXT NOT NULL REFERENCES runs(id),
    schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    graph_digest TEXT NOT NULL CHECK(length(graph_digest) = 64),
    manifests_digest TEXT NOT NULL CHECK(length(manifests_digest) = 64),
    graph_bytes INTEGER NOT NULL CHECK(graph_bytes >= 0 AND graph_bytes <= 32768),
    manifests_bytes INTEGER NOT NULL CHECK(manifests_bytes >= 0 AND manifests_bytes <= 32768),
    principal_namespace TEXT NOT NULL CHECK(length(principal_namespace) = 71 AND substr(principal_namespace, 1, 7) = 'sha256:' AND substr(principal_namespace, 8) NOT GLOB '*[^0-9a-f]*'),
    request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
    status TEXT NOT NULL CHECK(status IN ('validated', 'running', 'publishing', 'completed', 'failed', 'cancelled', 'needs-review')),
    max_concurrency INTEGER NOT NULL CHECK(max_concurrency = 1),
    max_run_ms INTEGER NOT NULL CHECK(max_run_ms > 0),
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    error_code TEXT
  );
  CREATE TABLE IF NOT EXISTS agent_graph_nodes (
    graph_run_id TEXT NOT NULL REFERENCES agent_graph_runs(id),
    node_id TEXT NOT NULL,
    manifest_id TEXT NOT NULL,
    manifest_digest TEXT NOT NULL CHECK(length(manifest_digest) = 64),
    input_ref TEXT NOT NULL,
    input_digest TEXT NOT NULL CHECK(length(input_digest) = 64),
    result_ref TEXT NOT NULL,
    node_call_id TEXT,
    request_digest TEXT,
    status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'needs-review', 'blocked')),
    execution_run_id TEXT,
    execution_attempt_id TEXT,
    result_digest TEXT,
    audit_ref TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    settled_at TEXT,
    PRIMARY KEY(graph_run_id, node_id)
  );
  CREATE TABLE IF NOT EXISTS agent_graph_edges (
    graph_run_id TEXT NOT NULL REFERENCES agent_graph_runs(id),
    node_id TEXT NOT NULL,
    depends_on_node_id TEXT NOT NULL,
    PRIMARY KEY(graph_run_id, node_id, depends_on_node_id),
    FOREIGN KEY(graph_run_id, node_id) REFERENCES agent_graph_nodes(graph_run_id, node_id),
    FOREIGN KEY(graph_run_id, depends_on_node_id) REFERENCES agent_graph_nodes(graph_run_id, node_id)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_graph_runs_parent ON agent_graph_runs(parent_run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_graph_runs_status ON agent_graph_runs(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_graph_nodes_status ON agent_graph_nodes(status, created_at);`
];

export class SqliteStore {
  readonly path: string;
  readonly db: DatabaseSync;

  constructor(path: string, { targetVersion = SQLITE_SCHEMA_VERSION }: SqliteStoreOptions = {}) {
    if (!path) throw new Error("SqliteStore requires a path");
    if (!Number.isInteger(targetVersion) || targetVersion < 0 || targetVersion > SQLITE_SCHEMA_VERSION) {
      throw new Error(`unsupported SQLite migration target: ${String(targetVersion)}`);
    }
    this.path = resolve(path);
    const existingVersion = inspectExistingSqliteSchema(this.path);
    if (existingVersion > SQLITE_SCHEMA_VERSION) {
      throw new Error(`SQLite state schema ${existingVersion} is newer than this Odinn version supports (${SQLITE_SCHEMA_VERSION})`);
    }
    if (existingVersion > targetVersion) {
      throw new Error(`invalid SQLite migration target ${targetVersion} from schema ${existingVersion}`);
    }
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA busy_timeout = 30000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    this.migrate(targetVersion);
    this.ensureRuntimeJobIndexes();
    this.normalizeAgentGraphPrincipalMetadata();
  }

  private ensureRuntimeJobIndexes() {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_jobs'").get()) return;
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_runtime_jobs_queue ON runtime_jobs(status, created_at, id)");
  }

  private normalizeAgentGraphPrincipalMetadata() {
    const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_graph_runs'").get();
    if (!table) return;
    const rows = this.db.prepare("SELECT id, principal_namespace FROM agent_graph_runs WHERE length(principal_namespace) != 71 OR substr(principal_namespace, 1, 7) != 'sha256:' OR substr(principal_namespace, 8) GLOB '*[^0-9a-f]*'").all() as SqlRow[];
    if (!rows.length) return;
    this.transaction((db) => {
      const update = db.prepare("UPDATE agent_graph_runs SET principal_namespace=? WHERE id=?");
      for (const row of rows) {
        const raw = String(row.principal_namespace);
        if (!raw || Buffer.byteLength(raw, "utf8") > 256) throw new Error(`agent graph principal metadata is too large: ${String(row.id)}`);
        update.run(`sha256:${digest(raw)}`, String(row.id));
      }
    });
  }

  migrate(targetVersion = SQLITE_SCHEMA_VERSION) {
    const current = (this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as SqlRow).version;
    if (!Number.isInteger(current) || Number(current) < 0) throw new Error(`invalid SQLite schema version: ${String(current)}`);
    if (Number(current) > SQLITE_SCHEMA_VERSION) {
      throw new Error(`SQLite state schema ${String(current)} is newer than this Odinn version supports (${SQLITE_SCHEMA_VERSION})`);
    }
    if (!Number.isInteger(targetVersion) || targetVersion < Number(current) || targetVersion > SQLITE_SCHEMA_VERSION) {
      throw new Error(`invalid SQLite migration target ${String(targetVersion)} from schema ${String(current)}`);
    }
    for (let version = Number(current) + 1; version <= targetVersion; version += 1) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(MIGRATIONS[version - 1]!);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  transaction<T>(callback: (database: DatabaseSync) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback(this.db);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}

export function inspectExistingSqliteSchema(path: string): number {
  const resolved = resolve(path);
  if (!existsSync(resolved)) return 0;
  const database = new DatabaseSync(resolved, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 30000");
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (!table) return 0;
    const row = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as SqlRow;
    const version = Number(row.version);
    if (!Number.isInteger(version) || version < 0) throw new Error(`invalid SQLite schema version: ${String(row.version)}`);
    return version;
  } finally {
    database.close();
  }
}

export class ArtifactStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  put(value: string | Buffer, { mediaType = "application/octet-stream" }: { mediaType?: string } = {}): Artifact {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const hash = digest(bytes);
    const relativePath = join("sha256", hash.slice(0, 2), hash);
    const path = join(this.root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    return { digest: hash, path: relativePath.replaceAll("\\", "/"), mediaType, sizeBytes: bytes.byteLength };
  }

  putJson(value: unknown, context: DurableRedactionContext = {}): Artifact {
    return this.put(JSON.stringify(redact(value, context)), { mediaType: "application/json" });
  }
}

export class RunLedger {
  readonly database: SqliteStore;
  readonly artifacts: ArtifactStore;
  readonly workspaceRoot: string;
  readonly stateDir: string;
  readonly featureFlags: FeatureFlags;

  constructor({ database, artifacts, workspaceRoot, stateDir, featureFlags = {} }: { database: SqliteStore; artifacts: ArtifactStore; workspaceRoot?: string; stateDir?: string; featureFlags?: FeatureFlags }) {
    if (!database || !artifacts) throw new Error("RunLedger requires database and artifacts");
    this.database = database;
    this.artifacts = artifacts;
    this.workspaceRoot = resolve(workspaceRoot ?? currentWorkingDirectory());
    this.stateDir = resolve(stateDir ?? dirname(database.path));
    this.featureFlags = { ...featureFlags };
  }

  ensureRun({ runId, objective, modelId = "", providerId = "", parentRunId, branchPointStepId, workspaceRoot = this.workspaceRoot }: { runId: string; objective?: string; modelId?: string; providerId?: string; parentRunId?: string; branchPointStepId?: string; workspaceRoot?: string }) {
    if (!runId) throw new Error("RunLedger requires runId");
    const now = new Date().toISOString();
    this.database.db.prepare(`INSERT OR IGNORE INTO runs
      (id, parent_run_id, branch_point_step_id, status, objective, model_id, provider_id, workspace_root, feature_flags_json, created_at)
      VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)`)
      .run(runId, parentRunId ?? null, branchPointStepId ?? null, String(objective ?? ""), String(modelId), String(providerId), resolve(workspaceRoot), JSON.stringify(this.featureFlags), now);
    return runId;
  }

  bindRunRequest({ runId, requestDigest }: { runId: string; requestDigest: string }) {
    if (!runId || !requestDigest) throw new Error("run request binding requires runId and requestDigest");
    return this.database.transaction((db) => {
      const existing = db.prepare("SELECT request_digest FROM run_request_bindings WHERE run_id = ?").get(runId) as SqlRow | undefined;
      if (existing && existing.request_digest !== requestDigest) {
        const error = new Error(`run id ${runId} was already used for a different request`) as Error & { code?: string };
        error.code = "IDEMPOTENCY_CONFLICT";
        throw error;
      }
      if (!existing) db.prepare("INSERT INTO run_request_bindings(run_id, request_digest, created_at) VALUES (?, ?, ?)").run(runId, requestDigest, new Date().toISOString());
      return { runId, requestDigest, replay: Boolean(existing) };
    });
  }

  recordExecutionEnvelope(input: unknown) {
    const envelope = validateExecutionEnvelopeV1(input);
    const canonical = canonicalizeExecutionEnvelopeV1(envelope);
    const envelopeDigest = digestExecutionEnvelopeV1(envelope);
    return this.database.transaction((db) => this.recordExecutionEnvelopeUnsafe(db, envelope, canonical, envelopeDigest, new Date().toISOString()));
  }

  admitExecution(input: unknown, { attemptId = `attempt_${randomUUID()}`, timestamp = new Date().toISOString() }: { attemptId?: string; timestamp?: string } = {}) {
    const envelope = validateExecutionEnvelopeV1(input);
    const canonical = canonicalizeExecutionEnvelopeV1(envelope);
    const envelopeDigest = digestExecutionEnvelopeV1(envelope);
    return this.database.transaction((db) => {
      const persisted = this.recordExecutionEnvelopeUnsafe(db, envelope, canonical, envelopeDigest, timestamp);
      if (persisted.replay) {
        const error = new Error(`execution envelope ${envelope.runId} was already admitted`) as Error & { code?: string };
        error.code = "EXECUTION_ADMISSION_REPLAY";
        throw error;
      }
      const attemptNumber = Number((db.prepare("SELECT COALESCE(MAX(attempt_number), 0) AS attempt_number FROM execution_attempts WHERE run_id = ?").get(envelope.runId) as SqlRow).attempt_number) + 1;
      db.prepare(`INSERT INTO execution_attempts(id, run_id, attempt_number, state, created_at)
        VALUES (?, ?, ?, 'queued', ?)`)
        .run(attemptId, envelope.runId, attemptNumber, timestamp);
      this.appendEventUnsafe(db, {
        runId: envelope.runId,
        type: "execution-admitted",
        timestamp,
        payload: { envelopeDigest, attemptId, inputDigest: envelope.inputDigest, inputReference: envelope.inputReference }
      });
      return {
        ...persisted,
        attempt: { id: attemptId, runId: envelope.runId, attemptNumber, state: "queued" as const, createdAt: timestamp }
      };
    });
  }

  resumeExecution({ runId, executionId, inputDigest, principalId, approvalContinuation = false }: {
    runId: string;
    executionId: string;
    inputDigest: string;
    principalId: string;
    approvalContinuation?: boolean;
  }) {
    return this.database.transaction((db) => {
      const envelopeRow = db.prepare(`SELECT envelope_digest, envelope_json, admitted_at
        FROM execution_envelopes WHERE run_id = ?`).get(runId) as SqlRow | undefined;
      if (!envelopeRow) {
        const error = new Error(`execution envelope not found: ${runId}`) as Error & { code?: string };
        error.code = "EXECUTION_ENVELOPE_NOT_FOUND";
        throw error;
      }
      const persisted = this.hydrateExecutionEnvelope(envelopeRow);
      const envelope = persisted.envelope;
      if (envelope.execution.id !== executionId || envelope.inputDigest !== inputDigest || envelope.principalId !== principalId) {
        const error = new Error(`execution recovery content does not match immutable envelope: ${runId}`) as Error & { code?: string };
        error.code = "EXECUTION_RECOVERY_CONFLICT";
        throw error;
      }
      const latest = db.prepare(`SELECT id, attempt_number, state, created_at, started_at, settled_at, outcome_digest, error_code
        FROM execution_attempts WHERE run_id = ? ORDER BY attempt_number DESC LIMIT 1`).get(runId) as SqlRow | undefined;
      if (latest?.state === "queued") {
        return {
          ...persisted,
          replay: true,
          attempt: {
            id: String(latest.id), runId, attemptNumber: Number(latest.attempt_number), state: "queued" as const,
            createdAt: String(latest.created_at)
          }
        };
      }
      if (latest?.state === "awaiting-approval" && approvalContinuation) {
        return {
          ...persisted,
          replay: true,
          attempt: {
            id: String(latest.id), runId, attemptNumber: Number(latest.attempt_number), state: "awaiting-approval" as const,
            createdAt: String(latest.created_at)
          }
        };
      }
      if (envelope.retrySafety !== "retry-safe") {
        const error = new Error(`execution ${runId} is not eligible for automatic retry`) as Error & { code?: string };
        error.code = "EXECUTION_RETRY_UNSAFE";
        throw error;
      }
      if (!latest || !["failed", "cancelled"].includes(String(latest.state))) {
        const error = new Error(`execution ${runId} has no failed retry-safe attempt to resume`) as Error & { code?: string };
        error.code = "EXECUTION_RECOVERY_NOT_ELIGIBLE";
        throw error;
      }
      const attemptId = `attempt_${randomUUID()}`;
      const attemptNumber = Number(latest.attempt_number) + 1;
      const createdAt = new Date().toISOString();
      db.prepare(`INSERT INTO execution_attempts(id, run_id, attempt_number, state, created_at)
        VALUES (?, ?, ?, 'queued', ?)`).run(attemptId, runId, attemptNumber, createdAt);
      this.appendEventUnsafe(db, {
        runId,
        type: "execution-retry-queued",
        timestamp: createdAt,
        payload: { attemptId, priorAttemptId: String(latest.id), envelopeDigest: persisted.envelopeDigest }
      });
      return {
        ...persisted,
        replay: true,
        attempt: { id: attemptId, runId, attemptNumber, state: "queued" as const, createdAt }
      };
    });
  }

  getExecutionEnvelope(runId: string) {
    const row = this.database.db.prepare(`SELECT envelope_digest, envelope_json, admitted_at
      FROM execution_envelopes WHERE run_id = ?`).get(runId) as SqlRow | undefined;
    if (!row) return undefined;
    return this.hydrateExecutionEnvelope(row);
  }

  createExecutionAttempt({ runId, attemptId = `attempt_${randomUUID()}`, state = "queued" }: { runId: string; attemptId?: string; state?: InitialExecutionAttemptState }) {
    if (!INITIAL_EXECUTION_ATTEMPT_STATES.has(state)) throw new Error(`unsupported initial execution attempt state: ${state}`);
    return this.database.transaction((db) => {
      if (!db.prepare("SELECT 1 FROM execution_envelopes WHERE run_id = ?").get(runId)) {
        const error = new Error(`execution envelope not found: ${runId}`) as Error & { code?: string };
        error.code = "EXECUTION_ENVELOPE_NOT_FOUND";
        throw error;
      }
      const attemptNumber = Number((db.prepare("SELECT COALESCE(MAX(attempt_number), 0) AS attempt_number FROM execution_attempts WHERE run_id = ?").get(runId) as SqlRow).attempt_number) + 1;
      const createdAt = new Date().toISOString();
      db.prepare(`INSERT INTO execution_attempts(id, run_id, attempt_number, state, created_at)
        VALUES (?, ?, ?, ?, ?)`)
        .run(attemptId, runId, attemptNumber, state, createdAt);
      return { id: attemptId, runId, attemptNumber, state, createdAt };
    });
  }

  listExecutionAttempts(runId: string) {
    return (this.database.db.prepare(`SELECT id, run_id, attempt_number, state, created_at, started_at, settled_at, outcome_digest, error_code
      FROM execution_attempts WHERE run_id = ? ORDER BY attempt_number`).all(runId) as SqlRow[]).map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      attemptNumber: Number(row.attempt_number),
      state: row.state as ExecutionAttemptState,
      createdAt: String(row.created_at),
      startedAt: row.started_at === null ? undefined : String(row.started_at),
      settledAt: row.settled_at === null ? undefined : String(row.settled_at),
      outcomeDigest: row.outcome_digest === null ? undefined : String(row.outcome_digest),
      errorCode: row.error_code === null ? undefined : String(row.error_code)
    }));
  }

  /** Read at most one authoritative execution-attempt projection per run. */
  readLatestExecutionAttempts(runIds: readonly string[]) {
    if (!Array.isArray(runIds) || runIds.length > 50) throw new Error("latest execution-attempt read accepts at most 50 run ids");
    const normalized = runIds.map((runId) => String(runId));
    if (normalized.some((runId) => !runId || runId.length > 512) || new Set(normalized).size !== normalized.length) {
      throw new Error("latest execution-attempt read requires unique bounded run ids");
    }
    if (!normalized.length) return [];
    const placeholders = normalized.map(() => "?").join(",");
    return (this.database.db.prepare(`SELECT id, run_id, attempt_number, state, created_at, started_at, settled_at, outcome_digest, error_code
      FROM execution_attempts AS attempt
      WHERE run_id IN (${placeholders})
        AND attempt_number = (SELECT MAX(latest.attempt_number) FROM execution_attempts AS latest WHERE latest.run_id = attempt.run_id)
      ORDER BY run_id`).all(...normalized) as SqlRow[]).map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      attemptNumber: Number(row.attempt_number),
      state: row.state as ExecutionAttemptState,
      createdAt: String(row.created_at),
      ...(row.started_at === null ? {} : { startedAt: String(row.started_at) }),
      ...(row.settled_at === null ? {} : { settledAt: String(row.settled_at) }),
      ...(row.outcome_digest === null ? {} : { outcomeDigest: String(row.outcome_digest) }),
      ...(row.error_code === null ? {} : { errorCode: String(row.error_code) })
    }));
  }

  getExecutionAttempt(attemptId: string) {
    const row = this.database.db.prepare(`SELECT id, run_id, attempt_number, state, created_at, started_at, settled_at, outcome_digest, error_code
      FROM execution_attempts WHERE id = ?`).get(attemptId) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id), runId: String(row.run_id), attemptNumber: Number(row.attempt_number),
      state: row.state as ExecutionAttemptState, createdAt: String(row.created_at),
      startedAt: row.started_at === null ? undefined : String(row.started_at),
      settledAt: row.settled_at === null ? undefined : String(row.settled_at),
      outcomeDigest: row.outcome_digest === null ? undefined : String(row.outcome_digest),
      errorCode: row.error_code === null ? undefined : String(row.error_code)
    };
  }

  transitionExecutionAttempt({ attemptId, from, to, outcomeDigest, errorCode }: {
    attemptId: string;
    from: ExecutionAttemptState;
    to: ExecutionAttemptState;
    outcomeDigest?: string;
    errorCode?: string;
  }) {
    if (!EXECUTION_ATTEMPT_TRANSITIONS[from]?.has(to)) throw new Error(`invalid execution attempt transition: ${from} -> ${to}`);
    if (outcomeDigest !== undefined && !/^[a-f0-9]{64}$/u.test(outcomeDigest)) throw new Error("execution attempt outcomeDigest must be a lowercase SHA-256 digest");
    if (errorCode !== undefined && !/^[A-Z][A-Z0-9_]{0,127}$/u.test(errorCode)) throw new Error("execution attempt errorCode is invalid");
    return this.database.transaction((db) => {
      const row = db.prepare("SELECT run_id, attempt_number, state, created_at, started_at FROM execution_attempts WHERE id = ?").get(attemptId) as SqlRow | undefined;
      if (!row) {
        const error = new Error(`execution attempt not found: ${attemptId}`) as Error & { code?: string };
        error.code = "EXECUTION_ATTEMPT_NOT_FOUND";
        throw error;
      }
      if (row.state !== from) {
        const error = new Error(`execution attempt ${attemptId} is ${String(row.state)}, expected ${from}`) as Error & { code?: string };
        error.code = "EXECUTION_ATTEMPT_STATE_CONFLICT";
        throw error;
      }
      const now = new Date().toISOString();
      const startedAt = to === "running" ? now : row.started_at;
      const settledAt = TERMINAL_EXECUTION_ATTEMPT_STATES.has(to) ? now : null;
      const result = db.prepare(`UPDATE execution_attempts
        SET state = ?, started_at = ?, settled_at = ?, outcome_digest = ?, error_code = ?
        WHERE id = ? AND state = ?`)
        .run(to, startedAt ?? null, settledAt, outcomeDigest ?? null, errorCode ?? null, attemptId, from);
      if (Number(result.changes) !== 1) {
        const error = new Error(`execution attempt ${attemptId} changed concurrently`) as Error & { code?: string };
        error.code = "EXECUTION_ATTEMPT_STATE_CONFLICT";
        throw error;
      }
      return {
        id: attemptId,
        runId: String(row.run_id),
        attemptNumber: Number(row.attempt_number),
        state: to,
        createdAt: String(row.created_at),
        startedAt: startedAt === null ? undefined : String(startedAt),
        settledAt: settledAt === null ? undefined : String(settledAt),
        outcomeDigest,
        errorCode
      };
    });
  }

  private hydrateExecutionEnvelope(row: SqlRow) {
    const envelope = validateExecutionEnvelopeV1(parseJson(row.envelope_json, {}));
    const actualDigest = digestExecutionEnvelopeV1(envelope);
    const storedDigest = String(row.envelope_digest);
    if (actualDigest !== storedDigest) {
      const error = new Error(`execution envelope integrity check failed for run ${envelope.runId}`) as Error & { code?: string };
      error.code = "EXECUTION_ENVELOPE_INTEGRITY";
      throw error;
    }
    return { envelope, envelopeDigest: storedDigest, admittedAt: String(row.admitted_at) };
  }

  private recordExecutionEnvelopeUnsafe(db: DatabaseSync, envelope: ExecutionEnvelopeV1, canonical: string, envelopeDigest: string, admittedAt: string) {
    const existing = db.prepare(`SELECT run_id, envelope_digest, envelope_json, admitted_at
      FROM execution_envelopes WHERE principal_id = ? AND idempotency_key = ?`)
      .get(envelope.principalId, envelope.idempotencyKey) as SqlRow | undefined;
    if (existing) {
      const persisted = this.hydrateExecutionEnvelope(existing);
      if (persisted.envelopeDigest !== envelopeDigest) {
        const error = new Error(`idempotency key ${envelope.idempotencyKey} was already used for different execution content`) as Error & { code?: string };
        error.code = "IDEMPOTENCY_CONFLICT";
        throw error;
      }
      return { ...persisted, replay: true };
    }
    if (db.prepare("SELECT 1 FROM execution_envelopes WHERE run_id = ?").get(envelope.runId)) {
      const error = new Error(`run id ${envelope.runId} already has an execution envelope`) as Error & { code?: string };
      error.code = "EXECUTION_ENVELOPE_CONFLICT";
      throw error;
    }
    if (!db.prepare("SELECT 1 FROM runs WHERE id = ?").get(envelope.runId)) {
      const error = new Error(`execution envelope run does not exist: ${envelope.runId}`) as Error & { code?: string };
      error.code = "EXECUTION_RUN_NOT_FOUND";
      throw error;
    }
    db.prepare(`INSERT INTO execution_envelopes
      (run_id, schema_version, principal_id, idempotency_key, envelope_digest, envelope_json, admitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(envelope.runId, envelope.version, envelope.principalId, envelope.idempotencyKey, envelopeDigest, canonical, admittedAt);
    db.prepare("INSERT INTO cancellation_controls(id, run_id) VALUES (?, ?)")
      .run(envelope.cancellationControlReference, envelope.runId);
    return { envelope, envelopeDigest, admittedAt, replay: false };
  }

  appendEvent({ runId, type, payload = {}, timestamp = new Date().toISOString() }: { runId: string; type: string; payload?: JsonMap; timestamp?: string }) {
    return this.database.transaction((db) => this.appendEventUnsafe(db, { runId, type, payload, timestamp }));
  }

  appendEventUnsafe(db: DatabaseSync, { runId, type, payload = {}, timestamp }: { runId: string; type: string; payload?: JsonMap; timestamp: string }) {
    const previous = db.prepare("SELECT sequence, hash FROM ledger_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1").get(runId) as SqlRow | undefined;
    const sequence = Number(previous?.sequence ?? 0) + 1;
    const safePayload = redact(payload);
    const envelope = { id: randomUUID(), runId, sequence, type, timestamp, payload: safePayload, previousHash: previous?.hash ?? null };
    const hash = digest(stable(envelope));
    db.prepare(`INSERT INTO ledger_events
      (id, run_id, sequence, type, timestamp, payload_json, previous_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(envelope.id, runId, sequence, type, timestamp, JSON.stringify(safePayload), envelope.previousHash, hash);
    return { ...envelope, hash };
  }

  beginTool({ runId, toolName, input, safety, metadata = {} }: { runId: string; toolName: string; input?: unknown; safety?: unknown; metadata?: JsonMap }) {
    const inputArtifact = this.artifacts.putJson(input ?? {}, { toolName, input: true });
    const now = new Date().toISOString();
    const stepId = `step_${randomUUID()}`;
    this.database.transaction((db) => {
      db.prepare("UPDATE runs SET status = 'executing', started_at = COALESCE(started_at, ?) WHERE id = ?").run(now, runId);
      const next = Number((db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM run_steps WHERE run_id = ?").get(runId) as SqlRow).sequence) + 1;
      db.prepare(`INSERT INTO run_steps
        (id, run_id, sequence, type, status, started_at, input_digest, metadata_json)
        VALUES (?, ?, ?, 'tool-request', 'running', ?, ?, ?)`)
        .run(stepId, runId, next, now, inputArtifact.digest, JSON.stringify(redact({ toolName, safety, ...metadata })));
      this.appendEventUnsafe(db, { runId, type: "tool-request", timestamp: now, payload: { stepId, toolName, inputDigest: inputArtifact.digest, safety } });
      db.prepare("INSERT OR IGNORE INTO artifacts(digest, path, media_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(inputArtifact.digest, inputArtifact.path, inputArtifact.mediaType, inputArtifact.sizeBytes, now);
    });
    return { stepId, inputArtifact };
  }

  recordPolicy({ runId, stepId, decision, reason, details }: { runId: string; stepId: string; decision: string; reason?: string; details?: unknown }) {
    return this.appendEvent({ runId, type: "policy-check", payload: { stepId, decision, reason, details } });
  }

  finishTool({ runId, stepId, output, status = "succeeded", error }: { runId: string; stepId: string; output?: unknown; status?: string; error?: unknown }) {
    const outputArtifact = output === undefined ? undefined : this.artifacts.putJson(output);
    const now = new Date().toISOString();
    this.database.transaction((db) => {
      const row = db.prepare("SELECT sequence FROM run_steps WHERE id = ? AND run_id = ?").get(stepId, runId);
      if (!row) throw new Error(`ledger step not found: ${stepId}`);
      db.prepare("UPDATE run_steps SET status = ?, completed_at = ?, output_digest = ? WHERE id = ?")
        .run(status, now, outputArtifact?.digest ?? null, stepId);
      this.appendEventUnsafe(db, { runId, type: "tool-result", timestamp: now, payload: { stepId, status, outputDigest: outputArtifact?.digest, error } });
      if (outputArtifact) db.prepare("INSERT OR IGNORE INTO artifacts(digest, path, media_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(outputArtifact.digest, outputArtifact.path, outputArtifact.mediaType, outputArtifact.sizeBytes, now);
      db.prepare("UPDATE runs SET status = ?, completed_at = ? WHERE id = ?").run(status === "succeeded" ? "completed-unverified" : status, now, runId);
    });
    return outputArtifact;
  }

  createAgentGraphRun({
    graphRunId,
    parentRunId,
    graphDigest,
    manifestsDigest,
    graphBytes,
    manifestsBytes,
    principalNamespace,
    requestDigest,
    maxRunMs,
    nodes
  }: {
    graphRunId: string;
    parentRunId: string;
    graphDigest: string;
    manifestsDigest: string;
    graphBytes: number;
    manifestsBytes: number;
    principalNamespace: string;
    requestDigest: string;
    maxRunMs: number;
    nodes: readonly { nodeId: string; manifestId: string; manifestDigest: string; inputRef: string; inputDigest: string; resultRef: string; dependsOn: readonly string[] }[];
  }) {
    if (!/^[a-f0-9]{64}$/u.test(graphDigest) || !/^[a-f0-9]{64}$/u.test(manifestsDigest) || !/^[a-f0-9]{64}$/u.test(requestDigest)) throw new Error("agent graph digests must be lowercase SHA-256 values");
    if (!Number.isSafeInteger(graphBytes) || graphBytes < 0 || graphBytes > 32_768 || !Number.isSafeInteger(manifestsBytes) || manifestsBytes < 0 || manifestsBytes > 32_768) throw new Error("agent graph byte metadata is invalid");
    if (!Number.isSafeInteger(maxRunMs) || maxRunMs < 1 || maxRunMs > 300_000) throw new Error("agent graph maxRunMs is invalid");
    if (typeof principalNamespace !== "string" || !principalNamespace || Buffer.byteLength(principalNamespace, "utf8") > 256) throw new Error("agent graph principal metadata is invalid");
    const durablePrincipalNamespace = /^sha256:[a-f0-9]{64}$/u.test(principalNamespace)
      ? principalNamespace
      : `sha256:${digest(principalNamespace)}`;
    return this.database.transaction((db) => {
      const existing = db.prepare("SELECT graph_digest, manifests_digest, request_digest, max_run_ms FROM agent_graph_runs WHERE id = ?").get(graphRunId) as SqlRow | undefined;
      if (existing) {
        if (String(existing.graph_digest) !== graphDigest || String(existing.manifests_digest) !== manifestsDigest || String(existing.request_digest) !== requestDigest || Number(existing.max_run_ms) !== maxRunMs) {
          const error = new Error(`agent graph run ${graphRunId} conflicts with an existing durable request`) as Error & { code?: string };
          error.code = "AGENT_GRAPH_IDEMPOTENCY_CONFLICT";
          throw error;
        }
        return { graphRunId, replay: true };
      }
      if (!db.prepare("SELECT 1 FROM runs WHERE id = ?").get(parentRunId)) throw new Error(`agent graph parent run does not exist: ${parentRunId}`);
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO agent_graph_runs
        (id, parent_run_id, schema_version, graph_digest, manifests_digest, graph_bytes, manifests_bytes, principal_namespace, request_digest, status, max_concurrency, max_run_ms, created_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'validated', 1, ?, ?)`).run(
        graphRunId, parentRunId, graphDigest, manifestsDigest, graphBytes, manifestsBytes, durablePrincipalNamespace, requestDigest, maxRunMs, now
      );
      const insertNode = db.prepare(`INSERT INTO agent_graph_nodes
        (graph_run_id, node_id, manifest_id, manifest_digest, input_ref, input_digest, result_ref, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`);
      const insertEdge = db.prepare(`INSERT INTO agent_graph_edges(graph_run_id, node_id, depends_on_node_id) VALUES (?, ?, ?)`);
      for (const node of nodes) {
        if (!/^[a-f0-9]{64}$/u.test(node.inputDigest)) throw new Error(`agent graph node ${node.nodeId} input digest is invalid`);
        insertNode.run(graphRunId, node.nodeId, node.manifestId, node.manifestDigest, node.inputRef, node.inputDigest, node.resultRef, now);
        for (const dependency of node.dependsOn) insertEdge.run(graphRunId, node.nodeId, dependency);
      }
      return { graphRunId, replay: false };
    });
  }

  startAgentGraphNode({ graphRunId, nodeId, nodeCallId, requestDigest, executionRunId, executionAttemptId, resultRef, auditRef }: { graphRunId: string; nodeId: string; nodeCallId: string; requestDigest: string; executionRunId: string; executionAttemptId: string; resultRef: string; auditRef: string }) {
    return this.database.transaction((db) => {
      const graph = db.prepare("SELECT status FROM agent_graph_runs WHERE id = ?").get(graphRunId) as SqlRow | undefined;
      if (!graph) throw new Error(`agent graph run not found: ${graphRunId}`);
      if (!["validated", "running"].includes(String(graph.status))) throw new Error(`agent graph run ${graphRunId} cannot dispatch from ${String(graph.status)}`);
      const row = db.prepare("SELECT status, node_call_id, request_digest, execution_run_id, execution_attempt_id, result_ref, audit_ref FROM agent_graph_nodes WHERE graph_run_id = ? AND node_id = ?").get(graphRunId, nodeId) as SqlRow | undefined;
      if (!row) throw new Error(`agent graph node not found: ${graphRunId}/${nodeId}`);
      if (row.status === "running") {
        if (String(row.node_call_id) === nodeCallId && String(row.request_digest) === requestDigest && String(row.execution_run_id) === executionRunId && String(row.execution_attempt_id) === executionAttemptId && String(row.result_ref) === resultRef && String(row.audit_ref) === auditRef) return { graphRunId, nodeId, state: "running" };
        const error = new Error(`agent graph node ${graphRunId}/${nodeId} has a different active dispatch identity`) as Error & { code?: string };
        error.code = "AGENT_GRAPH_STALE_DISPATCH";
        throw error;
      }
      if (row.status !== "queued") throw new Error(`agent graph node ${graphRunId}/${nodeId} cannot start from ${String(row.status)}`);
      const now = new Date().toISOString();
      if (!executionRunId || !executionAttemptId || !resultRef || !auditRef) throw new Error("agent graph node dispatch identity is incomplete");
      if (String(row.result_ref) !== resultRef || (row.audit_ref !== null && String(row.audit_ref) !== auditRef)) {
        const error = new Error(`agent graph node ${graphRunId}/${nodeId} has a different predeclared result identity`) as Error & { code?: string };
        error.code = "AGENT_GRAPH_STALE_DISPATCH";
        throw error;
      }
      db.prepare(`UPDATE agent_graph_nodes SET status='running', node_call_id=?, request_digest=?, execution_run_id=?, execution_attempt_id=?, audit_ref=?, started_at=? WHERE graph_run_id=? AND node_id=? AND status='queued'`)
        .run(nodeCallId, requestDigest, executionRunId, executionAttemptId, auditRef, now, graphRunId, nodeId);
      db.prepare("UPDATE agent_graph_runs SET status='running', started_at=COALESCE(started_at, ?) WHERE id=?").run(now, graphRunId);
      return { graphRunId, nodeId, state: "running", startedAt: now };
    });
  }

  recordAgentGraphNodeResult({ graphRunId, nodeId, status, nodeCallId, requestDigest, executionRunId, executionAttemptId, resultDigest, resultRef, auditRef, errorCode }: {
    graphRunId: string;
    nodeId: string;
    status: "completed" | "failed" | "cancelled" | "needs-review" | "blocked";
    nodeCallId?: string;
    requestDigest?: string;
    executionRunId?: string;
    executionAttemptId?: string;
    resultDigest?: string;
    resultRef?: string;
    auditRef?: string;
    errorCode?: string;
  }) {
    return this.database.transaction((db) => {
      const row = db.prepare("SELECT n.status, n.node_call_id, n.request_digest, n.execution_run_id, n.execution_attempt_id, n.result_ref, n.audit_ref, g.status AS graph_status FROM agent_graph_nodes n JOIN agent_graph_runs g ON g.id = n.graph_run_id WHERE n.graph_run_id = ? AND n.node_id = ?").get(graphRunId, nodeId) as SqlRow | undefined;
      if (!row) throw new Error(`agent graph node not found: ${graphRunId}/${nodeId}`);
      const currentStatus = String(row.status);
      if (["completed", "failed", "cancelled", "needs-review", "blocked"].includes(currentStatus) || ["publishing", "completed", "failed", "cancelled", "needs-review"].includes(String(row.graph_status))) {
        return { graphRunId, nodeId, status: currentStatus, ignored: true };
      }
      if (currentStatus === "queued") return { graphRunId, nodeId, status: currentStatus, ignored: true, stale: true };
      if (currentStatus !== "running") throw new Error(`agent graph node ${graphRunId}/${nodeId} cannot settle from ${currentStatus}`);
      if (!nodeCallId || String(row.node_call_id) !== nodeCallId || !requestDigest || String(row.request_digest) !== requestDigest
        || !executionRunId || String(row.execution_run_id) !== executionRunId
        || !executionAttemptId || String(row.execution_attempt_id) !== executionAttemptId
        || !resultRef || String(row.result_ref) !== resultRef
        || !auditRef || String(row.audit_ref) !== auditRef
        || typeof resultDigest !== "string" || !/^[a-f0-9]{64}$/u.test(resultDigest)) {
        return { graphRunId, nodeId, status: currentStatus, ignored: true, stale: true };
      }
      const now = new Date().toISOString();
      db.prepare(`UPDATE agent_graph_nodes SET status=?, result_digest=?, error_code=COALESCE(?, error_code), started_at=COALESCE(started_at, ?), settled_at=? WHERE graph_run_id=? AND node_id=? AND status='running' AND node_call_id=? AND request_digest=? AND execution_run_id=? AND execution_attempt_id=? AND result_ref=? AND audit_ref=?`)
        .run(status, resultDigest, errorCode ?? null, now, now, graphRunId, nodeId, nodeCallId, requestDigest, executionRunId, executionAttemptId, resultRef, auditRef);
      return { graphRunId, nodeId, status, settledAt: now };
    });
  }

  cancelAgentGraphRun({ graphRunId, errorCode = "GRAPH_CANCELLATION_UNCERTAIN" }: { graphRunId: string; errorCode?: string }) {
    return this.database.transaction((db) => {
      const existing = db.prepare("SELECT status FROM agent_graph_runs WHERE id=?").get(graphRunId) as SqlRow | undefined;
      if (!existing) throw new Error(`agent graph run not found: ${graphRunId}`);
      const currentStatus = String(existing.status);
      if (["completed", "failed", "cancelled", "needs-review"].includes(currentStatus)) return { graphRunId, status: currentStatus, ignored: true };
      const now = new Date().toISOString();
      db.prepare("UPDATE agent_graph_runs SET status='needs-review', completed_at=COALESCE(completed_at, ?), error_code=COALESCE(error_code, ?) WHERE id=? AND status IN ('validated','running','publishing')").run(now, errorCode, graphRunId);
      db.prepare("UPDATE agent_graph_nodes SET status='needs-review', settled_at=COALESCE(settled_at, ?), error_code=COALESCE(error_code, ?) WHERE graph_run_id=? AND status IN ('queued','running')").run(now, errorCode, graphRunId);
      return { graphRunId, status: "needs-review", errorCode };
    });
  }

  cancelAgentGraphRunsForParent({ parentRunId, errorCode = "GRAPH_CANCELLATION_UNCERTAIN" }: { parentRunId: string; errorCode?: string }) {
    return this.database.transaction((db) => {
      const rows = db.prepare("SELECT id FROM agent_graph_runs WHERE parent_run_id=? AND status IN ('validated','running','publishing') ORDER BY id").all(parentRunId) as SqlRow[];
      if (!rows.length) return { parentRunId, graphRunIds: [], status: "none" as const };
      const now = new Date().toISOString();
      db.prepare("UPDATE agent_graph_runs SET status='needs-review', completed_at=COALESCE(completed_at, ?), error_code=COALESCE(error_code, ?) WHERE parent_run_id=? AND status IN ('validated','running','publishing')").run(now, errorCode, parentRunId);
      db.prepare("UPDATE agent_graph_nodes SET status='needs-review', settled_at=COALESCE(settled_at, ?), error_code=COALESCE(error_code, ?) WHERE graph_run_id IN (SELECT id FROM agent_graph_runs WHERE parent_run_id=? AND status='needs-review') AND status IN ('queued','running')").run(now, errorCode, parentRunId);
      return { parentRunId, graphRunIds: rows.map((row) => String(row.id)), status: "needs-review" as const, errorCode };
    });
  }

  completeAgentGraphRun({ graphRunId, status, errorCode }: { graphRunId: string; status: "completed" | "failed" | "cancelled" | "needs-review"; errorCode?: string }) {
    return this.database.transaction((db) => {
      const existing = db.prepare("SELECT status, error_code FROM agent_graph_runs WHERE id=?").get(graphRunId) as SqlRow | undefined;
      if (!existing) throw new Error(`agent graph run not found: ${graphRunId}`);
      const currentStatus = String(existing.status);
      const unsettled = Number((db.prepare("SELECT COUNT(*) AS count FROM agent_graph_nodes WHERE graph_run_id=? AND status IN ('queued','running')").get(graphRunId) as SqlRow)?.count ?? 0);
      if (["completed", "failed", "cancelled", "needs-review"].includes(currentStatus)) {
        if (unsettled > 0) {
          const now = new Date().toISOString();
          const quarantineCode = errorCode ?? (existing.error_code === null ? undefined : String(existing.error_code)) ?? "GRAPH_OUTCOME_UNCERTAIN";
          db.prepare("UPDATE agent_graph_nodes SET status='needs-review', settled_at=COALESCE(settled_at, ?), error_code=COALESCE(error_code, ?) WHERE graph_run_id=? AND status IN ('queued','running')")
            .run(now, quarantineCode, graphRunId);
          if (currentStatus !== "needs-review") {
            db.prepare("UPDATE agent_graph_runs SET status='needs-review', completed_at=COALESCE(completed_at, ?), error_code=COALESCE(error_code, ?) WHERE id=?")
              .run(now, quarantineCode, graphRunId);
            return { graphRunId, status: "needs-review", ignored: true, quarantined: true };
          }
        }
        return { graphRunId, status: currentStatus, ignored: true };
      }
      if (status === "completed" && unsettled > 0) {
        const error = new Error(`agent graph ${graphRunId} has unsettled nodes`) as Error & { code?: string };
        error.code = "AGENT_GRAPH_UNSETTLED_NODES";
        throw error;
      }
      const now = new Date().toISOString();
      let finalStatus = status;
      if (unsettled > 0) {
        finalStatus = "needs-review";
        db.prepare("UPDATE agent_graph_nodes SET status='needs-review', settled_at=COALESCE(settled_at, ?), error_code=COALESCE(error_code, ?) WHERE graph_run_id=? AND status IN ('queued','running')")
          .run(now, errorCode ?? "GRAPH_OUTCOME_UNCERTAIN", graphRunId);
      }
      const result = db.prepare("UPDATE agent_graph_runs SET status=?, completed_at=?, error_code=? WHERE id=? AND status IN ('validated','running','publishing')").run(finalStatus, now, errorCode ?? (finalStatus === "needs-review" ? "GRAPH_OUTCOME_UNCERTAIN" : null), graphRunId);
      if (Number(result.changes) !== 1) throw new Error(`agent graph run not found: ${graphRunId}`);
      return { graphRunId, status: finalStatus, completedAt: now };
    });
  }

  beginAgentGraphCompletion({ graphRunId }: { graphRunId: string }) {
    return this.database.transaction((db) => {
      const existing = db.prepare("SELECT status FROM agent_graph_runs WHERE id=?").get(graphRunId) as SqlRow | undefined;
      if (!existing) throw new Error(`agent graph run not found: ${graphRunId}`);
      const currentStatus = String(existing.status);
      if (currentStatus === "publishing") return { graphRunId, status: currentStatus, replay: true };
      if (!["validated", "running"].includes(currentStatus)) {
        if (["completed", "failed", "cancelled", "needs-review"].includes(currentStatus)) return { graphRunId, status: currentStatus, replay: true };
        throw new Error(`agent graph run ${graphRunId} cannot publish from ${currentStatus}`);
      }
      db.prepare("UPDATE agent_graph_runs SET status='publishing' WHERE id=? AND status IN ('validated','running')").run(graphRunId);
      return { graphRunId, status: "publishing", replay: false };
    });
  }

  reconcileAgentGraphRuns() {
    return this.database.transaction((db) => {
      const now = new Date().toISOString();
      const unresolved = db.prepare(`SELECT agr.id, rj.status AS job_status
        FROM agent_graph_runs agr
        LEFT JOIN runtime_jobs rj ON rj.execution_run_id = agr.parent_run_id
          WHERE agr.status IN ('validated', 'running', 'publishing')
          AND rj.status IN ('needs-review', 'failed', 'cancelled')`).all() as SqlRow[];
      for (const row of unresolved) {
        const graphStatus = row.job_status === "needs-review" ? "needs-review" : row.job_status;
        db.prepare("UPDATE agent_graph_runs SET status=?, completed_at=COALESCE(completed_at, ?), error_code=COALESCE(error_code, ?) WHERE id=? AND status IN ('validated','running','publishing')")
          .run(graphStatus, now, graphStatus === "needs-review" ? "GRAPH_OUTCOME_UNCERTAIN" : "PARENT_JOB_TERMINAL", row.id);
        const nodeError = graphStatus === "needs-review" ? "GRAPH_OUTCOME_UNCERTAIN" : "PARENT_JOB_TERMINAL";
        db.prepare("UPDATE agent_graph_nodes SET status=?, settled_at=COALESCE(settled_at, ?), error_code=COALESCE(error_code, ?) WHERE graph_run_id=? AND status IN ('queued','running')").run(graphStatus, now, nodeError, row.id);
      }
      db.prepare("UPDATE agent_graph_runs SET status='needs-review', completed_at=COALESCE(completed_at, ?), error_code=COALESCE(error_code, 'GRAPH_TERMINAL_PUBLICATION_UNCERTAIN') WHERE status='publishing'").run(now);
      db.prepare("UPDATE agent_graph_nodes SET status='needs-review', settled_at=COALESCE(settled_at, ?), error_code=COALESCE(error_code, 'GRAPH_TERMINAL_PUBLICATION_UNCERTAIN') WHERE graph_run_id IN (SELECT id FROM agent_graph_runs WHERE status='needs-review' AND error_code='GRAPH_TERMINAL_PUBLICATION_UNCERTAIN') AND status IN ('queued','running')").run(now);
      db.prepare("UPDATE agent_graph_runs SET status='needs-review', completed_at=COALESCE(completed_at, ?), error_code=COALESCE(error_code, 'GRAPH_UNSETTLED_NODES') WHERE status IN ('completed','failed','cancelled','needs-review') AND EXISTS (SELECT 1 FROM agent_graph_nodes WHERE graph_run_id=agent_graph_runs.id AND status IN ('queued','running'))").run(now);
      db.prepare("UPDATE agent_graph_nodes SET status='needs-review', settled_at=COALESCE(settled_at, ?), error_code=COALESCE(error_code, 'GRAPH_UNSETTLED_NODES') WHERE graph_run_id IN (SELECT id FROM agent_graph_runs WHERE status='needs-review' AND error_code='GRAPH_UNSETTLED_NODES') AND status IN ('queued','running')").run(now);
      return { reconciled: unresolved.length };
    });
  }

  listAgentGraphRecoveryEvents() {
    return (this.database.db.prepare(`SELECT id, parent_run_id, status, error_code
      FROM agent_graph_runs
      WHERE status IN ('failed', 'cancelled', 'needs-review')
        AND error_code IN ('GRAPH_TERMINAL_PUBLICATION_UNCERTAIN', 'GRAPH_CANCELLATION_UNCERTAIN', 'GRAPH_OUTCOME_UNCERTAIN', 'GRAPH_UNSETTLED_NODES', 'PARENT_JOB_TERMINAL')
      ORDER BY completed_at, id`).all() as SqlRow[]).map((row) => ({
      graphRunId: String(row.id),
      parentRunId: String(row.parent_run_id),
      status: String(row.status) as "failed" | "cancelled" | "needs-review",
      errorCode: String(row.error_code)
    }));
  }

  getAgentGraphRun(graphRunId: string) {
    const run = this.database.db.prepare("SELECT * FROM agent_graph_runs WHERE id=?").get(graphRunId) as SqlRow | undefined;
    if (!run) return undefined;
    const nodes = (this.database.db.prepare("SELECT * FROM agent_graph_nodes WHERE graph_run_id=? ORDER BY node_id").all(graphRunId) as SqlRow[]).map((node) => ({
      graphRunId, nodeId: String(node.node_id), manifestId: String(node.manifest_id), manifestDigest: String(node.manifest_digest), inputRef: String(node.input_ref), inputDigest: String(node.input_digest), resultRef: String(node.result_ref), nodeCallId: node.node_call_id ?? undefined, requestDigest: node.request_digest ?? undefined, status: String(node.status), executionRunId: node.execution_run_id ?? undefined, executionAttemptId: node.execution_attempt_id ?? undefined, resultDigest: node.result_digest ?? undefined, auditRef: node.audit_ref ?? undefined, errorCode: node.error_code ?? undefined, createdAt: String(node.created_at), startedAt: node.started_at ?? undefined, settledAt: node.settled_at ?? undefined
    }));
    return { graphRunId, parentRunId: String(run.parent_run_id), graphDigest: String(run.graph_digest), manifestsDigest: String(run.manifests_digest), graphBytes: Number(run.graph_bytes), manifestsBytes: Number(run.manifests_bytes), principalNamespace: String(run.principal_namespace), requestDigest: String(run.request_digest), status: String(run.status), maxConcurrency: Number(run.max_concurrency), maxRunMs: Number(run.max_run_ms), createdAt: String(run.created_at), startedAt: run.started_at ?? undefined, completedAt: run.completed_at ?? undefined, errorCode: run.error_code ?? undefined, nodes };
  }

  listRuns({ limit = 20 }: { limit?: number } = {}) {
    return (this.database.db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Math.min(Number(limit) || 20, 200))) as SqlRow[]).map((row) => this.hydrateRun(row));
  }

  getRun(runId: string) {
    const row = this.database.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as SqlRow | undefined;
    if (!row) return undefined;
    const steps = (this.database.db.prepare("SELECT * FROM run_steps WHERE run_id = ? ORDER BY sequence").all(runId) as SqlRow[]).map((step) => ({ ...step, metadata: parseJson(step.metadata_json, {}) }));
    const events = (this.database.db.prepare("SELECT * FROM ledger_events WHERE run_id = ? ORDER BY sequence").all(runId) as SqlRow[]).map((event) => ({ ...event, payload: parseJson(event.payload_json, {}) }));
    return { ...this.hydrateRun(row), steps, events };
  }

  hasRun(runId: string) {
    return Boolean(this.database.db.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId));
  }

  verify(runId: string) {
    const events = this.database.db.prepare("SELECT * FROM ledger_events WHERE run_id = ? ORDER BY sequence").all(runId) as SqlRow[];
    let previousHash = null;
    let valid = true;
    for (const event of events) {
      const envelope = { id: event.id, runId: event.run_id, sequence: event.sequence, type: event.type, timestamp: event.timestamp, payload: parseJson(event.payload_json, {}), previousHash };
      if (event.previous_hash !== previousHash || event.hash !== digest(stable(envelope))) valid = false;
      previousHash = event.hash;
    }
    return { runId, valid, eventCount: events.length };
  }

  close() {
    this.database.close();
  }

  hydrateRun(row: SqlRow) {
    return {
      id: row.id,
      parentRunId: row.parent_run_id ?? undefined,
      branchPointStepId: row.branch_point_step_id ?? undefined,
      status: row.status,
      objective: row.objective,
      modelId: row.model_id,
      providerId: row.provider_id,
      workspaceRoot: row.workspace_root,
      featureFlags: parseJson(row.feature_flags_json, {}),
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined
    };
  }
}

export function createRunLedger({ stateDir = ".odinn", workspaceRoot = currentWorkingDirectory(), featureFlags = {} }: { stateDir?: string; workspaceRoot?: string; featureFlags?: FeatureFlags } = {}) {
  const state = resolve(stateDir);
  const database = new SqliteStore(join(state, "db", "odinn.sqlite"));
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  return new RunLedger({ database, artifacts, workspaceRoot, stateDir: state, featureFlags });
}

export {
  AUTHORITATIVE_RECORD_SCHEMA_VERSION,
  SqliteRecordStore,
  inspectAuthoritativeRecordSchema,
  legacyRecordMigrationStatus,
  migrateLegacyRecordsToSqlite,
  rollbackLegacyRecordsMigration,
  redactRecord
} from "./authoritative.ts";
export type {
  CurrentEntityPage,
  LegacyRecordMigrationOptions,
  LegacyRecordMigrationResult,
  MemoryNamespaceAggregate,
  ProjectEntityCounts,
  RecordPage,
  RecordQuery,
  SqliteRecordTransaction
} from "./authoritative.ts";
export { SqliteJobStore } from "./runtime-jobs.ts";
export type { RuntimeJobRecord } from "./runtime-jobs.ts";
export { SqliteWorkflowStore } from "./workflows.ts";
export { SqliteOperatorReadStore } from "./operator-read.ts";
export type {
  SqliteOperatorAttemptReadRecord,
  SqliteOperatorAuditReadRecord,
  SqliteOperatorEventWatchReadRecord,
  SqliteOperatorJobReadRecord,
  SqliteOperatorRunReadRecord,
  SqliteOperatorWorkflowReadRecord,
} from "./operator-read.ts";
export type { ClaimedWorkflowStep } from "./workflows.ts";
