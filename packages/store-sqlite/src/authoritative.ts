import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactDurableValue, type JsonObject } from "@odinn/protocol";

export type RecordQuery = {
  types?: string[];
  typePrefix?: string;
  id?: string;
  ids?: string[];
  sessionId?: string;
  projectId?: string;
  scopeType?: string;
  scopeId?: string;
  scopeAny?: Array<{ scopeType: string; scopeId?: string }>;
  namespace?: string;
  namespacePrefix?: string;
  kind?: string;
  status?: string;
  subject?: string;
  targetId?: string;
  goalId?: string;
  candidateId?: string;
  candidateIds?: string[];
  improvementId?: string;
  observationKey?: string;
  externalId?: string;
  supersedes?: string;
  text?: string;
  activeMemoryOnly?: boolean;
  limit?: number;
  cursor?: string;
  order?: "asc" | "desc";
};

export type RecordPage<TRecord extends JsonObject = JsonObject> = {
  records: TRecord[];
  nextCursor?: string;
  hasMore: boolean;
};

type SqlRow = Record<string, unknown>;
type StoredRecord = JsonObject & { schemaVersion: number; at: string; id: string };
export type CurrentEntityPage = { ids: string[]; records: JsonObject[]; nextCursor?: string; hasMore: boolean };
export type ProjectEntityCounts = { sessionCount: number; goalCount: number; activeGoalCount: number };
export type MemoryNamespaceAggregate = { namespace: string; tier: string; kind: string; count: number; latestAt: string };
const RECORD_SCHEMA_VERSION = 1;
export const AUTHORITATIVE_RECORD_SCHEMA_VERSION = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MIGRATION_CHUNK_SIZE = 500;
const CURRENT_PROJECTION_VERSION = 2;
const MAX_PROJECTED_IMPROVEMENT_DECISIONS = 200;

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dirname(path), 0o700);
}

function parseRecord(value: unknown): StoredRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record must be an object");
  const record = value as JsonObject;
  const schemaVersion = Number(record.schemaVersion ?? RECORD_SCHEMA_VERSION);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > RECORD_SCHEMA_VERSION) {
    throw new Error(`unsupported record schema version: ${String(record.schemaVersion)}`);
  }
  const at = typeof record.at === "string" && record.at ? record.at : new Date().toISOString();
  const id = typeof record.id === "string" && record.id ? record.id : `record_${randomUUID()}`;
  const stored: StoredRecord = { ...record, schemaVersion: RECORD_SCHEMA_VERSION, at, id };
  return stored;
}

function field(record: JsonObject, name: string): string | null {
  return typeof record[name] === "string" && record[name] !== "" ? String(record[name]) : null;
}

function pageSize(value: unknown): number {
  const parsed = Number(value ?? DEFAULT_PAGE_SIZE);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
}

function encodeCursor(sequence: number): string {
  return Buffer.from(JSON.stringify({ sequence }), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): { sequence: number } | undefined {
  if (!value) return undefined;
  if (value.length > 512) throw new Error("invalid record cursor");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { at?: unknown; sequence?: unknown };
    const sequence = parsed.sequence;
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error("invalid cursor");
    return { sequence };
  } catch {
    throw new Error("invalid record cursor");
  }
}

function sha256Fd(fd: number, size: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < size) {
    const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (bytes <= 0) throw new Error("migration source changed while hashing");
    hash.update(buffer.subarray(0, bytes));
    offset += bytes;
  }
  return hash.digest("hex");
}

function fsyncParent(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(dirname(path), "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function atomicReplaceWithBackup(source: string, target: string, backup: string, beforeParentFsync?: () => void): void {
  if (!existsSync(target)) {
    renameSync(source, target);
    fsyncParent(target);
    return;
  }
  if (process.platform === "win32") {
    const script = "[System.IO.File]::Replace($env:ODINN_REPLACE_SOURCE,$env:ODINN_REPLACE_TARGET,$env:ODINN_REPLACE_BACKUP,$true)";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, ODINN_REPLACE_SOURCE: source, ODINN_REPLACE_TARGET: target, ODINN_REPLACE_BACKUP: backup },
      encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024
    });
    if (result.status !== 0) throw new Error(`atomic Windows replacement failed: ${String(result.stderr || result.stdout).trim()}`);
    return;
  }
  linkSync(target, backup);
  let published = false;
  try {
    renameSync(source, target);
    published = true;
    beforeParentFsync?.();
    fsyncParent(target);
  } catch (error) {
    if (!published) rmSync(backup, { force: true });
    throw error;
  }
}

function openDatabase(path: string): DatabaseSync {
  const resolved = resolve(path);
  ensureParent(resolved);
  const database = new DatabaseSync(resolved);
  database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS record_events (
      sequence INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      external_id TEXT,
      session_id TEXT,
      project_id TEXT,
      scope_type TEXT,
      scope_id TEXT,
      namespace TEXT,
      kind TEXT,
      status TEXT,
      subject TEXT,
      target_id TEXT,
      goal_id TEXT,
      candidate_id TEXT,
      improvement_id TEXT,
      observation_key TEXT,
      supersedes TEXT,
      expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_record_events_type_sequence ON record_events(type, sequence);
    CREATE INDEX IF NOT EXISTS idx_record_events_type_at_id ON record_events(type, at, id);
    CREATE INDEX IF NOT EXISTS idx_record_events_session_sequence ON record_events(session_id, type, sequence);
    CREATE INDEX IF NOT EXISTS idx_record_events_project_sequence ON record_events(project_id, type, sequence);
    CREATE INDEX IF NOT EXISTS idx_record_events_scope_sequence ON record_events(type, scope_type, scope_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_record_events_memory_filter ON record_events(type, status, namespace, kind, subject, sequence);
    CREATE INDEX IF NOT EXISTS idx_record_events_memory_scope_at ON record_events(type, scope_type, scope_id, namespace, status, at, id);
    CREATE INDEX IF NOT EXISTS idx_record_events_normalized_scope_sequence
      ON record_events(COALESCE(NULLIF(scope_type, ''), 'global'), COALESCE(scope_id, ''), type, status, sequence);
    CREATE INDEX IF NOT EXISTS idx_record_events_external ON record_events(session_id, external_id);
    CREATE INDEX IF NOT EXISTS idx_record_events_target ON record_events(target_id);
    CREATE INDEX IF NOT EXISTS idx_record_events_goal ON record_events(goal_id);
    CREATE INDEX IF NOT EXISTS idx_record_events_candidate ON record_events(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_record_events_supersedes ON record_events(supersedes);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_record_events_message_external
      ON record_events(session_id, external_id)
      WHERE type = 'message.appended' AND external_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS current_sessions (
      id TEXT PRIMARY KEY,
      created_sequence INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL,
      project_id TEXT NOT NULL,
      view_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_current_sessions_project ON current_sessions(project_id, status, created_sequence);
    CREATE TABLE IF NOT EXISTS current_projects (
      id TEXT PRIMARY KEY,
      created_sequence INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL,
      view_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_current_projects_status ON current_projects(status, created_sequence);
    CREATE TABLE IF NOT EXISTS current_goals (
      id TEXT PRIMARY KEY,
      created_sequence INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL,
      project_id TEXT NOT NULL,
      session_id TEXT,
      view_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_current_goals_project ON current_goals(project_id, status, created_sequence);
    CREATE INDEX IF NOT EXISTS idx_current_goals_session ON current_goals(session_id, status, created_sequence);
    CREATE TABLE IF NOT EXISTS current_improvements (
      id TEXT PRIMARY KEY,
      created_sequence INTEGER NOT NULL UNIQUE,
      updated_sequence INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL,
      observation_key TEXT,
      view_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_current_improvements_updated ON current_improvements(updated_sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_current_improvements_observation ON current_improvements(observation_key);
    CREATE TABLE IF NOT EXISTS record_migrations (
      source_path TEXT PRIMARY KEY,
      source_sha256 TEXT NOT NULL,
      backup_path TEXT NOT NULL,
      next_byte INTEGER NOT NULL DEFAULT 0,
      records INTEGER NOT NULL,
      complete INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS record_projection_meta (
      name TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS record_store_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO record_store_meta(id, schema_version) VALUES (1, ${AUTHORITATIVE_RECORD_SCHEMA_VERSION});
  `);
  try { database.exec("ALTER TABLE record_migrations ADD COLUMN next_byte INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { database.exec("ALTER TABLE record_events ADD COLUMN improvement_id TEXT"); } catch {}
  try { database.exec("ALTER TABLE record_events ADD COLUMN observation_key TEXT"); } catch {}
  database.exec("CREATE INDEX IF NOT EXISTS idx_record_events_improvement ON record_events(improvement_id, sequence); CREATE INDEX IF NOT EXISTS idx_record_events_observation ON record_events(observation_key, sequence);");
  try { database.exec("ALTER TABLE current_sessions ADD COLUMN view_json TEXT"); } catch {}
  try { database.exec("ALTER TABLE current_projects ADD COLUMN view_json TEXT"); } catch {}
  try { database.exec("ALTER TABLE current_goals ADD COLUMN view_json TEXT"); } catch {}
  ensureCurrentProjections(database);
  return database;
}

function withTransaction<T>(database: DatabaseSync, callback: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function recordFromRow(row: SqlRow): StoredRecord {
  const record = parseRecord(JSON.parse(String(row.payload_json)));
  if (row.sequence !== undefined) Object.defineProperty(record, "sequence", { value: Number(row.sequence), enumerable: false });
  return record;
}

function projectionView(database: DatabaseSync, table: string, id: string): JsonObject | undefined {
  const row = database.prepare(`SELECT view_json FROM ${table} WHERE id = ?`).get(id) as SqlRow | undefined;
  return row?.view_json ? JSON.parse(String(row.view_json)) as JsonObject : undefined;
}

function updateProjectionView(database: DatabaseSync, table: string, id: string, view: JsonObject): void {
  database.prepare(`UPDATE ${table} SET view_json = ? WHERE id = ?`).run(JSON.stringify(view), id);
}

function projectCurrentState(database: DatabaseSync, record: StoredRecord, sequence: number): void {
  const type = String(record.type ?? "");
  if (type === "session.created") {
    const status = field(record, "status") ?? "open";
    const projectId = field(record, "projectId") ?? "project_default";
    const view = {
      id: record.id, title: field(record, "title") ?? "Untitled session", status,
      createdAt: record.at, updatedAt: record.at, lastEventAt: record.at, messageCount: 0,
      tags: Array.isArray(record.tags) ? record.tags : [], actor: field(record, "actor") ?? "local",
      source: field(record, "source") ?? "local", projectId
    };
    database.prepare("INSERT OR IGNORE INTO current_sessions(id, created_sequence, status, project_id, view_json) VALUES (?, ?, ?, ?, ?)")
      .run(record.id, sequence, status, projectId, JSON.stringify(view));
    return;
  }
  const sessionId = field(record, "sessionId");
  if (sessionId) {
    const view = projectionView(database, "current_sessions", sessionId);
    if (view) {
      if (type === "session.renamed") view.title = field(record, "title") ?? view.title;
      if (type === "session.assigned" || type === "session.updated") {
        if (field(record, "title")) view.title = field(record, "title");
        if (field(record, "projectId")) view.projectId = field(record, "projectId");
      }
      if (type === "session.closed") view.status = "closed";
      if (type === "session.deleted") view.status = "deleted";
      if (type === "message.appended") {
        view.messageCount = Number(view.messageCount ?? 0) + 1;
        view.lastMessageRole = field(record, "role") ?? "";
      }
      if (["session.renamed", "session.assigned", "session.updated", "session.closed", "session.deleted", "message.appended"].includes(type)) {
        view.updatedAt = record.at;
        view.lastEventAt = record.at;
        database.prepare("UPDATE current_sessions SET status = ?, project_id = ?, view_json = ? WHERE id = ?")
          .run(String(view.status), String(view.projectId), JSON.stringify(view), sessionId);
      }
      if ((type === "session.assigned" || type === "session.updated") && field(record, "projectId")) {
        const projectId = field(record, "projectId")!;
        const goals = database.prepare("SELECT id, view_json FROM current_goals WHERE session_id = ?").all(sessionId) as SqlRow[];
        for (const goal of goals) {
          const goalView = JSON.parse(String(goal.view_json)) as JsonObject;
          goalView.projectId = projectId;
          database.prepare("UPDATE current_goals SET project_id = ?, view_json = ? WHERE id = ?")
            .run(projectId, JSON.stringify(goalView), String(goal.id));
        }
      }
    }
  }
  if (type === "project.created") {
    const status = field(record, "status") ?? "active";
    const view = { id: record.id, name: field(record, "name") ?? "", description: field(record, "description") ?? "", status,
      tags: Array.isArray(record.tags) ? record.tags : [], createdAt: record.at, updatedAt: record.at };
    database.prepare("INSERT OR IGNORE INTO current_projects(id, created_sequence, status, view_json) VALUES (?, ?, ?, ?)")
      .run(record.id, sequence, status, JSON.stringify(view));
  } else if (type === "project.updated" && field(record, "projectId")) {
    const projectId = field(record, "projectId")!;
    const view = projectionView(database, "current_projects", projectId);
    if (view) {
      for (const key of ["name", "description", "status"] as const) if (record[key] !== undefined) view[key] = record[key];
      view.updatedAt = record.at;
      database.prepare("UPDATE current_projects SET status = ?, view_json = ? WHERE id = ?")
        .run(String(view.status), JSON.stringify(view), projectId);
    }
  }
  if (type === "goal.created") {
    const status = field(record, "status") ?? "active";
    const projectId = field(record, "projectId") ?? "project_default";
    const sessionIdValue = field(record, "sessionId");
    const view: JsonObject = {
      id: record.id, title: field(record, "title") ?? "", description: field(record, "description") ?? "", status,
      tags: Array.isArray(record.tags) ? record.tags : [], scopeType: field(record, "scopeType") ?? (sessionIdValue ? "session" : "project"),
      scopeId: field(record, "scopeId") ?? sessionIdValue ?? projectId, projectId, createdAt: record.at, updatedAt: record.at, notes: []
    };
    if (sessionIdValue) view.sessionId = sessionIdValue;
    database.prepare("INSERT OR IGNORE INTO current_goals(id, created_sequence, status, project_id, session_id, view_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(record.id, sequence, status, projectId, sessionIdValue, JSON.stringify(view));
  } else if (type === "goal.updated" && field(record, "goalId")) {
    const goalId = field(record, "goalId")!;
    const view = projectionView(database, "current_goals", goalId);
    if (view) {
      for (const key of ["title", "description", "status"] as const) if (record[key] !== undefined) view[key] = record[key];
      view.updatedAt = record.at;
      const note = field(record, "note");
      if (note) (view.notes as JsonObject[]).push({ at: record.at, note, status: String(view.status) });
      database.prepare("UPDATE current_goals SET status = ?, view_json = ? WHERE id = ?")
        .run(String(view.status), JSON.stringify(view), goalId);
    }
  }
  if (type === "improvement.proposed") {
    const status = field(record, "status") ?? "proposed";
    const view: JsonObject = {
      id: record.id, title: record.title, rationale: record.rationale, target: record.target,
      priority: record.priority, status, evidence: record.evidence ?? [], observationKey: record.observationKey,
      advisor: record.advisor, action: record.action, createdAt: record.at, updatedAt: record.at,
      decisions: [], decisionCount: 0, decisionsTruncated: false
    };
    database.prepare("INSERT OR IGNORE INTO current_improvements(id, created_sequence, updated_sequence, status, observation_key, view_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(record.id, sequence, sequence, status, field(record, "observationKey"), JSON.stringify(view));
  } else if (type.startsWith("improvement.") && field(record, "improvementId")) {
    const improvementId = field(record, "improvementId")!;
    const view = projectionView(database, "current_improvements", improvementId);
    if (view) {
      const decision = field(record, "decision");
      if (decision) view.status = decision;
      view.updatedAt = record.at;
      const decisions = Array.isArray(view.decisions) ? view.decisions as JsonObject[] : [];
      decisions.push({ at: record.at, decision, note: record.note, snapshotPath: record.snapshotPath, action: record.action });
      view.decisionCount = Number(view.decisionCount ?? 0) + 1;
      view.decisions = decisions.slice(-MAX_PROJECTED_IMPROVEMENT_DECISIONS);
      view.decisionsTruncated = Number(view.decisionCount) > MAX_PROJECTED_IMPROVEMENT_DECISIONS;
      database.prepare("UPDATE current_improvements SET updated_sequence = ?, status = ?, view_json = ? WHERE id = ?")
        .run(sequence, String(view.status), JSON.stringify(view), improvementId);
    }
  }
}

function ensureCurrentProjections(database: DatabaseSync): void {
  const row = database.prepare("SELECT version FROM record_projection_meta WHERE name = 'workspace'").get() as SqlRow | undefined;
  if (Number(row?.version) === CURRENT_PROJECTION_VERSION) return;
  withTransaction(database, () => {
    database.exec("DELETE FROM current_sessions; DELETE FROM current_projects; DELETE FROM current_goals; DELETE FROM current_improvements;");
    const events = database.prepare("SELECT sequence, payload_json FROM record_events ORDER BY sequence ASC").all() as SqlRow[];
    for (const event of events) projectCurrentState(database, recordFromRow(event), Number(event.sequence));
    database.prepare("INSERT INTO record_projection_meta(name, version) VALUES ('workspace', ?) ON CONFLICT(name) DO UPDATE SET version = excluded.version")
      .run(CURRENT_PROJECTION_VERSION);
  });
}

export type SqliteRecordTransaction = {
  append(record: JsonObject): StoredRecord;
  queryRecordsPage(query?: RecordQuery): RecordPage<StoredRecord>;
  findById(id: string): StoredRecord | undefined;
  findMessageByExternalId(sessionId: string, externalId: string): StoredRecord | undefined;
};

export class SqliteRecordStore {
  readonly path: string;
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (!path) throw new Error("SqliteRecordStore requires a path");
    this.path = resolve(path);
    this.db = openDatabase(this.path);
  }

  appendSync(record: JsonObject): StoredRecord {
    if (!this.db.isTransaction) return withTransaction(this.db, () => this.appendSync(record));
    const normalized = parseRecord(record);
    const type = field(normalized, "type");
    if (!type) throw new Error("record requires type");
    const externalId = field(normalized, "externalId");
    const sessionId = field(normalized, "sessionId");
    if (type === "message.appended" && externalId && sessionId) {
      const existing = this.findMessageByExternalIdSync(sessionId, externalId);
      if (existing) return existing;
    }
    const inserted = this.db.prepare(`
      INSERT INTO record_events(
        id, schema_version, at, type, payload_json, external_id, session_id,
        project_id, scope_type, scope_id, namespace, kind, status, subject, target_id,
        goal_id, candidate_id, improvement_id, observation_key, supersedes, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.id, normalized.schemaVersion, normalized.at, type, JSON.stringify(normalized),
      externalId, sessionId, field(normalized, "projectId"),
      field(normalized, "scopeType"), field(normalized, "scopeId"), field(normalized, "namespace"),
      field(normalized, "kind"), field(normalized, "status"), field(normalized, "subject"),
      field(normalized, "targetId"), field(normalized, "goalId"), field(normalized, "candidateId"),
      field(normalized, "improvementId"), field(normalized, "observationKey"),
      field(normalized, "supersedes"), field(normalized, "expiresAt")
    );
    const sequence = Number(inserted.lastInsertRowid);
    projectCurrentState(this.db, normalized, sequence);
    Object.defineProperty(normalized, "sequence", { value: sequence, enumerable: false });
    return normalized;
  }

  async append(record: JsonObject): Promise<StoredRecord> {
    return withTransaction(this.db, () => this.appendSync(record));
  }

  transaction<T>(callback: (transaction: SqliteRecordTransaction) => T): T {
    return withTransaction(this.db, () => callback({
      append: (record) => this.appendSync(record),
      queryRecordsPage: (query = {}) => this.queryRecordsPageSync(query),
      findById: (id) => this.findByIdSync(id),
      findMessageByExternalId: (sessionId, externalId) => this.findMessageByExternalIdSync(sessionId, externalId)
    }));
  }

  queryRecordsPageSync(query: RecordQuery = {}): RecordPage<StoredRecord> {
    if ((query.types?.length ?? 0) > 32 || (query.ids?.length ?? 0) > MAX_PAGE_SIZE || (query.candidateIds?.length ?? 0) > MAX_PAGE_SIZE || (query.scopeAny?.length ?? 0) > 8) {
      throw new Error("record query exceeds bounded filter limits");
    }
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (query.types?.length) {
      clauses.push(`type IN (${query.types.map(() => "?").join(",")})`);
      values.push(...query.types);
    }
    if (query.typePrefix) { clauses.push("type LIKE ?"); values.push(`${query.typePrefix}%`); }
    if (query.id) { clauses.push("id = ?"); values.push(query.id); }
    if (query.ids?.length) { clauses.push(`id IN (${query.ids.map(() => "?").join(",")})`); values.push(...query.ids); }
    if (query.candidateIds?.length) { clauses.push(`candidate_id IN (${query.candidateIds.map(() => "?").join(",")})`); values.push(...query.candidateIds); }
    for (const [column, value] of [
      ["session_id", query.sessionId], ["project_id", query.projectId], ["scope_type", query.scopeType],
      ["scope_id", query.scopeId], ["namespace", query.namespace], ["kind", query.kind],
      ["status", query.status], ["subject", query.subject], ["target_id", query.targetId],
      ["goal_id", query.goalId], ["candidate_id", query.candidateId], ["improvement_id", query.improvementId],
      ["observation_key", query.observationKey], ["external_id", query.externalId], ["supersedes", query.supersedes]
    ] as Array<[string, unknown]>) {
      if (value !== undefined && value !== "") { clauses.push(`${column} = ?`); values.push(String(value)); }
    }
    if (query.namespacePrefix) { clauses.push("(namespace = ? OR namespace LIKE ?)"); values.push(query.namespacePrefix, `${query.namespacePrefix}/%`); }
    if (query.text?.trim()) {
      const tokens = query.text.trim().toLowerCase().split(/\s+/u).filter(Boolean).slice(0, 12);
      clauses.push(`(${tokens.map(() => "lower(payload_json) LIKE ?").join(" OR ")})`);
      values.push(...tokens.map((token) => `%${token}%`));
    }
    if (query.activeMemoryOnly) {
      clauses.push("type = 'memory'");
      clauses.push("status = 'active'");
      clauses.push("(expires_at IS NULL OR expires_at = '' OR expires_at > ?)");
      values.push(new Date().toISOString());
      clauses.push("NOT EXISTS (SELECT 1 FROM record_events superseder WHERE superseder.supersedes = record_events.id)");
      clauses.push("NOT EXISTS (SELECT 1 FROM record_events deactivation WHERE deactivation.type = 'memory.deactivation' AND deactivation.target_id = record_events.id)");
    }
    const cursor = decodeCursor(query.cursor);
    const order = query.order === "desc" ? "DESC" : "ASC";
    if (cursor) {
      clauses.push(order === "ASC" ? "sequence > ?" : "sequence < ?");
      values.push(cursor.sequence);
    }
    const limit = pageSize(query.limit);
    let rows: SqlRow[];
    if (query.scopeAny?.length) {
      const branches: string[] = [];
      const branchValues: Array<string | number> = [];
      const scopes = Array.from(new Map(query.scopeAny.map((scope) => [`${scope.scopeType}\0${scope.scopeId ?? ""}`, scope])).values());
      for (const scope of scopes) {
        branches.push(`SELECT * FROM (
          SELECT sequence, at, payload_json FROM record_events
          WHERE ${[...clauses, "COALESCE(NULLIF(scope_type, ''), 'global') = ?", "COALESCE(scope_id, '') = ?"].join(" AND ")}
          ORDER BY sequence ${order} LIMIT ?
        )`);
        branchValues.push(...values, scope.scopeType, scope.scopeId ?? "", limit + 1);
      }
      rows = this.db.prepare(`SELECT * FROM (${branches.join(" UNION ALL ")}) ORDER BY sequence ${order} LIMIT ?`)
        .all(...branchValues, limit + 1) as SqlRow[];
    } else {
      rows = this.db.prepare(`
        SELECT sequence, at, payload_json FROM record_events
        ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY sequence ${order}
        LIMIT ?
      `).all(...values, limit + 1) as SqlRow[];
    }
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const records = pageRows.map(recordFromRow);
    const tail = pageRows.at(-1);
    return {
      records,
      hasMore,
      ...(hasMore && tail ? { nextCursor: encodeCursor(Number(tail.sequence)) } : {})
    };
  }

  async queryRecordsPage(query: RecordQuery = {}): Promise<RecordPage<StoredRecord>> {
    return this.queryRecordsPageSync(query);
  }

  queryRecordsSync(query: RecordQuery = {}): StoredRecord[] {
    return this.queryRecordsPageSync(query).records;
  }

  async queryRecords(query: RecordQuery = {}): Promise<StoredRecord[]> {
    return this.queryRecordsSync(query);
  }

  findByIdSync(id: string): StoredRecord | undefined {
    const row = this.db.prepare("SELECT payload_json FROM record_events WHERE id = ? LIMIT 1").get(id) as SqlRow | undefined;
    return row ? recordFromRow(row) : undefined;
  }

  async findById(id: string): Promise<StoredRecord | undefined> {
    return this.findByIdSync(id);
  }

  findMessageByExternalIdSync(sessionId: string, externalId: string): StoredRecord | undefined {
    const row = this.db.prepare("SELECT payload_json FROM record_events WHERE type = 'message.appended' AND session_id = ? AND external_id = ? LIMIT 1").get(sessionId, externalId) as SqlRow | undefined;
    return row ? recordFromRow(row) : undefined;
  }

  async findMessageByExternalId(sessionId: string, externalId: string): Promise<StoredRecord | undefined> {
    return this.findMessageByExternalIdSync(sessionId, externalId);
  }

  countSync(query: RecordQuery = {}): number {
    if ((query.types?.length ?? 0) > 32 || (query.ids?.length ?? 0) > MAX_PAGE_SIZE || (query.candidateIds?.length ?? 0) > MAX_PAGE_SIZE || (query.scopeAny?.length ?? 0) > 8) {
      throw new Error("record query exceeds bounded filter limits");
    }
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (query.types?.length) {
      clauses.push(`type IN (${query.types.map(() => "?").join(",")})`);
      values.push(...query.types);
    }
    if (query.typePrefix) { clauses.push("type LIKE ?"); values.push(`${query.typePrefix}%`); }
    if (query.id) { clauses.push("id = ?"); values.push(query.id); }
    if (query.ids?.length) { clauses.push(`id IN (${query.ids.map(() => "?").join(",")})`); values.push(...query.ids); }
    if (query.candidateIds?.length) { clauses.push(`candidate_id IN (${query.candidateIds.map(() => "?").join(",")})`); values.push(...query.candidateIds); }
    for (const [column, value] of [
      ["session_id", query.sessionId], ["project_id", query.projectId], ["scope_type", query.scopeType],
      ["scope_id", query.scopeId], ["namespace", query.namespace], ["kind", query.kind],
      ["status", query.status], ["subject", query.subject], ["target_id", query.targetId],
      ["goal_id", query.goalId], ["candidate_id", query.candidateId], ["improvement_id", query.improvementId],
      ["observation_key", query.observationKey], ["external_id", query.externalId], ["supersedes", query.supersedes]
    ] as Array<[string, unknown]>) {
      if (value !== undefined && value !== "") { clauses.push(`${column} = ?`); values.push(String(value)); }
    }
    if (query.scopeAny?.length) {
      clauses.push(`(${query.scopeAny.map(() => "(COALESCE(NULLIF(scope_type, ''), 'global') = ? AND COALESCE(scope_id, '') = ?)").join(" OR ")})`);
      for (const scope of query.scopeAny) values.push(scope.scopeType, scope.scopeId ?? "");
    }
    if (query.namespacePrefix) { clauses.push("(namespace = ? OR namespace LIKE ?)"); values.push(query.namespacePrefix, `${query.namespacePrefix}/%`); }
    if (query.text?.trim()) {
      const tokens = query.text.trim().toLowerCase().split(/\s+/u).filter(Boolean).slice(0, 12);
      clauses.push(`(${tokens.map(() => "lower(payload_json) LIKE ?").join(" OR ")})`);
      values.push(...tokens.map((token) => `%${token}%`));
    }
    if (query.activeMemoryOnly) {
      clauses.push("type = 'memory'");
      clauses.push("status = 'active'");
      clauses.push("(expires_at IS NULL OR expires_at = '' OR expires_at > ?)");
      values.push(new Date().toISOString());
      clauses.push("NOT EXISTS (SELECT 1 FROM record_events superseder WHERE superseder.supersedes = record_events.id)");
      clauses.push("NOT EXISTS (SELECT 1 FROM record_events deactivation WHERE deactivation.type = 'memory.deactivation' AND deactivation.target_id = record_events.id)");
    }
    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      clauses.push(query.order === "desc" ? "sequence < ?" : "sequence > ?");
      values.push(cursor.sequence);
    }
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM record_events ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`).get(...values) as SqlRow;
    return Number(row.count);
  }

  async countRecords(query: RecordQuery = {}): Promise<number> {
    return this.countSync(query);
  }

  async getCurrentSession(id: string): Promise<JsonObject | undefined> {
    return projectionView(this.db, "current_sessions", id);
  }

  async getCurrentProject(id: string): Promise<JsonObject | undefined> {
    return projectionView(this.db, "current_projects", id);
  }

  async getCurrentGoal(id: string): Promise<JsonObject | undefined> {
    return projectionView(this.db, "current_goals", id);
  }

  async getCurrentImprovement(id: string): Promise<JsonObject | undefined> {
    return projectionView(this.db, "current_improvements", id);
  }

  async aggregateActiveMemoryNamespaces(query: Pick<RecordQuery, "scopeAny" | "namespacePrefix"> = {}): Promise<MemoryNamespaceAggregate[]> {
    const clauses = [
      "type = 'memory'", "status = 'active'", "(expires_at IS NULL OR expires_at = '' OR expires_at > ?)",
      "NOT EXISTS (SELECT 1 FROM record_events superseder WHERE superseder.supersedes = record_events.id)",
      "NOT EXISTS (SELECT 1 FROM record_events deactivation WHERE deactivation.type = 'memory.deactivation' AND deactivation.target_id = record_events.id)"
    ];
    const values: string[] = [new Date().toISOString()];
    if (query.namespacePrefix) {
      clauses.push("(namespace = ? OR namespace LIKE ?)");
      values.push(query.namespacePrefix, `${query.namespacePrefix}/%`);
    }
    const scopes = query.scopeAny?.length
      ? Array.from(new Map(query.scopeAny.map((scope) => [`${scope.scopeType}\0${scope.scopeId ?? ""}`, scope])).values())
      : [undefined];
    const rows = scopes.flatMap((scope) => this.db.prepare(`
        SELECT namespace, COALESCE(json_extract(payload_json, '$.tier'), 'l1') AS tier, kind,
               COUNT(*) AS count, MAX(at) AS latest_at
        FROM record_events WHERE ${[
          ...clauses,
          ...(scope ? ["COALESCE(NULLIF(scope_type, ''), 'global') = ?", "COALESCE(scope_id, '') = ?"] : [])
        ].join(" AND ")}
        GROUP BY namespace, tier, kind ORDER BY namespace ASC
      `).all(...values, ...(scope ? [scope.scopeType, scope.scopeId ?? ""] : [])) as SqlRow[]);
    return rows.map((row) => ({
      namespace: String(row.namespace), tier: String(row.tier), kind: String(row.kind),
      count: Number(row.count), latestAt: String(row.latest_at)
    }));
  }

  private currentEntityPage(
    table: "current_sessions" | "current_projects" | "current_goals",
    clauses: string[],
    values: Array<string | number>,
    query: { limit?: number; cursor?: string }
  ): CurrentEntityPage {
    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      clauses.push("created_sequence > ?");
      values.push(cursor.sequence);
    }
    const limit = pageSize(query.limit);
    const rows = this.db.prepare(`SELECT id, created_sequence, view_json FROM ${table} ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_sequence ASC LIMIT ?`)
      .all(...values, limit + 1) as SqlRow[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const tail = pageRows.at(-1);
    return {
      ids: pageRows.map((row) => String(row.id)),
      records: pageRows.map((row) => JSON.parse(String(row.view_json)) as JsonObject),
      hasMore,
      ...(hasMore && tail ? { nextCursor: encodeCursor(Number(tail.created_sequence)) } : {})
    };
  }

  async queryCurrentSessionsPage(query: { projectId?: string; limit?: number; cursor?: string } = {}): Promise<CurrentEntityPage> {
    const clauses = ["status <> 'deleted'"];
    const values: Array<string | number> = [];
    if (query.projectId) { clauses.push("project_id = ?"); values.push(query.projectId); }
    return this.currentEntityPage("current_sessions", clauses, values, query);
  }

  async queryCurrentProjectsPage(query: { includeArchived?: boolean; limit?: number; cursor?: string } = {}): Promise<CurrentEntityPage> {
    const clauses = query.includeArchived ? [] : ["status <> 'archived'"];
    return this.currentEntityPage("current_projects", clauses, [], query);
  }

  async queryCurrentGoalsPage(query: { projectId?: string; sessionId?: string; status?: string; limit?: number; cursor?: string } = {}): Promise<CurrentEntityPage> {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    for (const [column, value] of [["project_id", query.projectId], ["session_id", query.sessionId], ["status", query.status]] as const) {
      if (value) { clauses.push(`${column} = ?`); values.push(value); }
    }
    return this.currentEntityPage("current_goals", clauses, values, query);
  }

  async queryCurrentImprovementsPage(query: { limit?: number; cursor?: string } = {}): Promise<CurrentEntityPage> {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    const cursor = decodeCursor(query.cursor);
    if (cursor) { clauses.push("updated_sequence < ?"); values.push(cursor.sequence); }
    const limit = pageSize(query.limit);
    const rows = this.db.prepare(`SELECT id, updated_sequence, view_json FROM current_improvements ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY updated_sequence DESC LIMIT ?`)
      .all(...values, limit + 1) as SqlRow[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const tail = pageRows.at(-1);
    return {
      ids: pageRows.map((row) => String(row.id)),
      records: pageRows.map((row) => JSON.parse(String(row.view_json)) as JsonObject),
      hasMore,
      ...(hasMore && tail ? { nextCursor: encodeCursor(Number(tail.updated_sequence)) } : {})
    };
  }

  async projectEntityCounts(projectId: string): Promise<ProjectEntityCounts> {
    const sessions = this.db.prepare("SELECT COUNT(*) AS count FROM current_sessions WHERE project_id = ? AND status <> 'deleted'").get(projectId) as SqlRow;
    const goals = this.db.prepare("SELECT COUNT(*) AS count, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM current_goals WHERE project_id = ?").get(projectId) as SqlRow;
    return {
      sessionCount: Number(sessions.count),
      goalCount: Number(goals.count),
      activeGoalCount: Number(goals.active ?? 0)
    };
  }

  close(): void { this.db.close(); }
}

export type LegacyRecordMigrationOptions = {
  legacyPath: string;
  databasePath: string;
  backupPath?: string;
  chunkSize?: number;
  failAfterRecords?: number;
  __testOnlyAfterChunk?: () => void;
};

export type LegacyRecordMigrationResult = {
  migrated: boolean;
  complete: boolean;
  records: number;
  nextByte: number;
  backup: string;
};

export function inspectAuthoritativeRecordSchema(path: string): number {
  const database = new DatabaseSync(resolve(path), { readOnly: true });
  try {
    const row = database.prepare("SELECT schema_version FROM record_store_meta WHERE id = 1").get() as SqlRow | undefined;
    const version = Number(row?.schema_version);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error("authoritative record database has no valid schema version");
    return version;
  } finally {
    database.close();
  }
}

export function legacyRecordMigrationStatus({ legacyPath, databasePath }: Pick<LegacyRecordMigrationOptions, "legacyPath" | "databasePath">): LegacyRecordMigrationResult | undefined {
  const resolvedDatabase = resolve(databasePath);
  if (!existsSync(resolvedDatabase)) return undefined;
  const store = new SqliteRecordStore(resolvedDatabase);
  try {
    const row = migrationRow(store, resolve(legacyPath));
    if (!row) return undefined;
    return {
      migrated: false,
      complete: Boolean(row.complete),
      records: Number(row.records),
      nextByte: Number(row.next_byte),
      backup: String(row.backup_path)
    };
  } finally {
    store.close();
  }
}

const LEGACY_READ_BUFFER_BYTES = 64 * 1024;
const MAX_LEGACY_LINE_BYTES = 8 * 1024 * 1024;

type LegacyChunk = { records: StoredRecord[]; nextByte: number };

function sha256File(path: string): string {
  const fd = openSync(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(LEGACY_READ_BUFFER_BYTES);
  try {
    let bytesRead = 0;
    while ((bytesRead = readSync(fd, buffer, 0, buffer.byteLength, null)) > 0) hash.update(buffer.subarray(0, bytesRead));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function readLegacyChunk(fd: number, startByte: number, fileSize: number, chunkSize: number): LegacyChunk {
  if (!Number.isSafeInteger(startByte) || startByte < 0 || startByte > fileSize) throw new Error("invalid legacy migration byte checkpoint");
  const records: StoredRecord[] = [];
  const buffer = Buffer.allocUnsafe(LEGACY_READ_BUFFER_BYTES);
  let position = startByte;
  let carry = Buffer.alloc(0);
  let carryStart = startByte;
  let checkpoint = startByte;
  while (position < fileSize && records.length < chunkSize) {
    const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.byteLength, fileSize - position), position);
    if (bytesRead <= 0) break;
    const chunkStart = position;
    position += bytesRead;
    let data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
    let dataStart = carry.length ? carryStart : chunkStart;
    let offset = 0;
    while (records.length < chunkSize) {
      const newline = data.indexOf(0x0a, offset);
      if (newline < 0) break;
      const raw = data.subarray(offset, newline).toString("utf8").replace(/\r$/u, "");
      checkpoint = dataStart + newline + 1;
      offset = newline + 1;
      if (raw.trim()) records.push(parseRecord(JSON.parse(raw)));
    }
    if (records.length >= chunkSize) return { records, nextByte: checkpoint };
    carry = Buffer.from(data.subarray(offset));
    carryStart = dataStart + offset;
    if (carry.byteLength > MAX_LEGACY_LINE_BYTES) throw new Error("legacy record line exceeds bounded migration size");
  }
  if (carry.length) {
    const raw = carry.toString("utf8").replace(/\r$/u, "");
    if (raw.trim()) records.push(parseRecord(JSON.parse(raw)));
  }
  return { records, nextByte: fileSize };
}

function migrationRow(store: SqliteRecordStore, sourcePath: string): SqlRow | undefined {
  return store.db.prepare("SELECT * FROM record_migrations WHERE source_path = ?").get(sourcePath) as SqlRow | undefined;
}

function saveMigration(store: SqliteRecordStore, values: { sourcePath: string; sourceSha256: string; backupPath: string; nextByte: number; records: number; complete: boolean; startedAt: string }): void {
  store.db.prepare(`
    INSERT INTO record_migrations(source_path, source_sha256, backup_path, next_byte, records, complete, started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET source_sha256=excluded.source_sha256, backup_path=excluded.backup_path,
      next_byte=excluded.next_byte, records=excluded.records, complete=excluded.complete, updated_at=excluded.updated_at
  `).run(values.sourcePath, values.sourceSha256, values.backupPath, values.nextByte, values.records, values.complete ? 1 : 0, values.startedAt, new Date().toISOString());
}

export function migrateLegacyRecordsToSqlite(options: LegacyRecordMigrationOptions): LegacyRecordMigrationResult {
  const legacyPath = resolve(options.legacyPath);
  const databasePath = resolve(options.databasePath);
  const backupPath = resolve(options.backupPath ?? `${legacyPath}.pre-sqlite.bak`);
  if (!existsSync(legacyPath)) throw new Error(`legacy records file not found: ${legacyPath}`);
  ensureParent(backupPath);
  if (!existsSync(backupPath)) copyFileSync(legacyPath, backupPath);
  const sourceSha256 = sha256File(legacyPath);
  if (sha256File(backupPath) !== sourceSha256) throw new Error("legacy migration backup does not match source");
  const store = new SqliteRecordStore(databasePath);
  let sourceFd: number | undefined;
  try {
    // Import the verified immutable backup, not the live legacy path. A writer
    // changing the source after the initial digest cannot alter this migration.
    sourceFd = openSync(backupPath, "r");
    const openedBackup = fstatSync(sourceFd);
    const fileSize = openedBackup.size;
    if (!openedBackup.isFile() || sha256Fd(sourceFd, fileSize) !== sourceSha256) {
      throw new Error("legacy migration backup changed before import");
    }
    const assertSourcesUnchanged = () => {
      const currentBackup = fstatSync(sourceFd!);
      const namedBackup = statSync(backupPath);
      if (!currentBackup.isFile() || currentBackup.dev !== openedBackup.dev || currentBackup.ino !== openedBackup.ino
        || currentBackup.size !== openedBackup.size || currentBackup.mtimeMs !== openedBackup.mtimeMs
        || currentBackup.ctimeMs !== openedBackup.ctimeMs || namedBackup.dev !== openedBackup.dev
        || namedBackup.ino !== openedBackup.ino || sha256Fd(sourceFd!, fileSize) !== sourceSha256) {
        throw new Error("legacy migration backup changed during import");
      }
      if (sha256File(legacyPath) !== sourceSha256) throw new Error("legacy records changed during SQLite migration");
    };
    const current = migrationRow(store, legacyPath);
    if (current && String(current.source_sha256) !== sourceSha256) throw new Error("legacy records changed during SQLite migration");
    if (current?.complete) {
      assertSourcesUnchanged();
      return { migrated: false, complete: true, records: Number(current.records), nextByte: Number(current.next_byte ?? current.next_line ?? 0), backup: backupPath };
    }
    let nextByte = Number(current?.next_byte ?? current?.next_line ?? 0);
    let records = Number(current?.records ?? 0);
    if (!Number.isSafeInteger(records) || records < 0) throw new Error("invalid legacy migration record checkpoint");
    if (!Number.isSafeInteger(nextByte) || nextByte < 0 || nextByte > fileSize) throw new Error("invalid legacy migration byte checkpoint");
    const chunkSize = Number.isSafeInteger(options.chunkSize) && Number(options.chunkSize) > 0 ? Number(options.chunkSize) : MIGRATION_CHUNK_SIZE;
    const startedAt = String(current?.started_at ?? new Date().toISOString());
    while (nextByte < fileSize) {
      const chunk = readLegacyChunk(sourceFd, nextByte, fileSize, chunkSize);
      if (chunk.nextByte <= nextByte) throw new Error("legacy migration made no byte progress");
      const imported = chunk.records.length;
      const chunkRecords = records + imported;
      store.transaction(() => {
        for (const record of chunk.records) store.appendSync(record);
        saveMigration(store, { sourcePath: legacyPath, sourceSha256, backupPath, nextByte: chunk.nextByte, records: chunkRecords, complete: chunk.nextByte >= fileSize, startedAt });
      });
      nextByte = chunk.nextByte;
      records = chunkRecords;
      options.__testOnlyAfterChunk?.();
      if (options.failAfterRecords !== undefined && records >= options.failAfterRecords && nextByte < fileSize) throw new Error("test migration interruption");
    }
    if (!migrationRow(store, legacyPath)) {
      store.transaction(() => saveMigration(store, { sourcePath: legacyPath, sourceSha256, backupPath, nextByte: fileSize, records, complete: true, startedAt }));
    }
    assertSourcesUnchanged();
    const final = migrationRow(store, legacyPath)!;
    return { migrated: true, complete: Boolean(final.complete), records: Number(final.records), nextByte: Number(final.next_byte), backup: backupPath };
  } finally {
    if (sourceFd !== undefined) closeSync(sourceFd);
    store.close();
  }
}

export function rollbackLegacyRecordsMigration({ legacyPath, databasePath, backupPath = `${legacyPath}.pre-sqlite.bak`, __testOnlyBeforePublish, __testOnlyBeforeParentFsync, __testOnlyAfterPublish }: { legacyPath: string; databasePath: string; backupPath?: string; __testOnlyBeforePublish?: () => void; __testOnlyBeforeParentFsync?: () => void; __testOnlyAfterPublish?: () => void }): { rolledBack: boolean; backup: string } {
  const resolvedLegacy = resolve(legacyPath);
  const resolvedDatabase = resolve(databasePath);
  const resolvedBackup = resolve(backupPath);
  if (!existsSync(resolvedBackup)) throw new Error(`migration backup not found: ${resolvedBackup}`);
  const backupHash = sha256File(resolvedBackup);
  let expectedHash: string | undefined;
  if (existsSync(resolvedDatabase)) {
    const store = new SqliteRecordStore(resolvedDatabase);
    try {
      const row = migrationRow(store, resolvedLegacy);
      expectedHash = row ? String(row.source_sha256) : undefined;
    } finally {
      store.close();
    }
  }
  if (expectedHash && expectedHash !== backupHash) throw new Error("migration rollback backup does not match recorded source");
  ensureParent(resolvedLegacy);
  const staged = `${resolvedLegacy}.rollback-${randomUUID()}.tmp`;
  const displaced = `${resolvedLegacy}.rollback-${randomUUID()}.previous`;
  let displacedLegacy = false;
  try {
    copyFileSync(resolvedBackup, staged, constants.COPYFILE_EXCL);
    if (process.platform !== "win32") chmodSync(staged, 0o600);
    const stagedFd = openSync(staged, process.platform === "win32" ? "r+" : "r");
    try { fsyncSync(stagedFd); } finally { closeSync(stagedFd); }
    if (sha256File(staged) !== backupHash) throw new Error("migration rollback failed staged backup verification");
    __testOnlyBeforePublish?.();
    displacedLegacy = existsSync(resolvedLegacy);
    atomicReplaceWithBackup(staged, resolvedLegacy, displaced, __testOnlyBeforeParentFsync);
    __testOnlyAfterPublish?.();
    if (sha256File(resolvedLegacy) !== backupHash) throw new Error("migration rollback failed backup verification");
    if (displacedLegacy) rmSync(displaced, { force: true });
  } catch (error) {
    if (displacedLegacy && existsSync(displaced)) {
      const failed = `${resolvedLegacy}.rollback-${randomUUID()}.failed`;
      try {
        atomicReplaceWithBackup(displaced, resolvedLegacy, failed);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], "migration rollback failed and the displaced legacy file could not be restored");
      }
      rmSync(failed, { force: true });
    }
    throw error;
  } finally {
    rmSync(staged, { force: true });
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try { rmSync(`${resolvedDatabase}${suffix}`, { force: true }); } catch {}
    if (existsSync(`${resolvedDatabase}${suffix}`)) throw new Error("migration rollback failed database cleanup");
  }
  return { rolledBack: true, backup: resolvedBackup };
}

export function redactRecord(value: unknown): unknown {
  return redactDurableValue(value);
}
