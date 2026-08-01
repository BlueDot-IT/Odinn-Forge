import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, closeSync } from "node:fs";
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
  namespace?: string;
  namespacePrefix?: string;
  kind?: string;
  status?: string;
  subject?: string;
  targetId?: string;
  goalId?: string;
  candidateId?: string;
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
const RECORD_SCHEMA_VERSION = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MIGRATION_CHUNK_SIZE = 500;

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
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { at?: unknown; sequence?: unknown };
    const sequence = parsed.sequence;
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error("invalid cursor");
    return { sequence };
  } catch {
    throw new Error("invalid record cursor");
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
      supersedes TEXT,
      expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_record_events_order ON record_events(at, sequence);
    CREATE INDEX IF NOT EXISTS idx_record_events_type_order ON record_events(type, at, sequence);
    CREATE INDEX IF NOT EXISTS idx_record_events_session_order ON record_events(session_id, at, sequence);
    CREATE INDEX IF NOT EXISTS idx_record_events_project_order ON record_events(project_id, at, sequence);
    CREATE INDEX IF NOT EXISTS idx_record_events_scope_order ON record_events(type, scope_type, scope_id, at, sequence);
    CREATE INDEX IF NOT EXISTS idx_record_events_memory_filter ON record_events(type, status, namespace, kind, subject, at, sequence);
    CREATE INDEX IF NOT EXISTS idx_record_events_external ON record_events(session_id, external_id);
    CREATE INDEX IF NOT EXISTS idx_record_events_target ON record_events(target_id);
    CREATE INDEX IF NOT EXISTS idx_record_events_goal ON record_events(goal_id);
    CREATE INDEX IF NOT EXISTS idx_record_events_candidate ON record_events(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_record_events_supersedes ON record_events(supersedes);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_record_events_message_external
      ON record_events(session_id, external_id)
      WHERE type = 'message.appended' AND external_id IS NOT NULL;
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
  `);
  try { database.exec("ALTER TABLE record_migrations ADD COLUMN next_byte INTEGER NOT NULL DEFAULT 0"); } catch {}
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
    const normalized = parseRecord(record);
    const type = field(normalized, "type");
    if (!type) throw new Error("record requires type");
    const externalId = field(normalized, "externalId");
    const sessionId = field(normalized, "sessionId");
    if (type === "message.appended" && externalId && sessionId) {
      const existing = this.findMessageByExternalIdSync(sessionId, externalId);
      if (existing) return existing;
    }
    const next = Number((this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM record_events").get() as SqlRow).sequence);
    this.db.prepare(`
      INSERT INTO record_events(
        sequence, id, schema_version, at, type, payload_json, external_id, session_id,
        project_id, scope_type, scope_id, namespace, kind, status, subject, target_id,
        goal_id, candidate_id, supersedes, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      next, normalized.id, normalized.schemaVersion, normalized.at, type, JSON.stringify(normalized),
      externalId, sessionId, field(normalized, "projectId"),
      field(normalized, "scopeType"), field(normalized, "scopeId"), field(normalized, "namespace"),
      field(normalized, "kind"), field(normalized, "status"), field(normalized, "subject"),
      field(normalized, "targetId"), field(normalized, "goalId"), field(normalized, "candidateId"),
      field(normalized, "supersedes"), field(normalized, "expiresAt")
    );
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
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (query.types?.length) {
      clauses.push(`type IN (${query.types.map(() => "?").join(",")})`);
      values.push(...query.types);
    }
    if (query.typePrefix) { clauses.push("type LIKE ?"); values.push(`${query.typePrefix}%`); }
    if (query.id) { clauses.push("id = ?"); values.push(query.id); }
    if (query.ids?.length) { clauses.push(`id IN (${query.ids.map(() => "?").join(",")})`); values.push(...query.ids); }
    for (const [column, value] of [
      ["session_id", query.sessionId], ["project_id", query.projectId], ["scope_type", query.scopeType],
      ["scope_id", query.scopeId], ["namespace", query.namespace], ["kind", query.kind],
      ["status", query.status], ["subject", query.subject], ["target_id", query.targetId],
      ["goal_id", query.goalId], ["candidate_id", query.candidateId], ["external_id", query.externalId], ["supersedes", query.supersedes]
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
    values.push(limit + 1);
    const rows = this.db.prepare(`
      SELECT sequence, at, payload_json FROM record_events
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY sequence ${order}
      LIMIT ?
    `).all(...values) as SqlRow[];
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
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (query.types?.length) {
      clauses.push(`type IN (${query.types.map(() => "?").join(",")})`);
      values.push(...query.types);
    }
    if (query.typePrefix) { clauses.push("type LIKE ?"); values.push(`${query.typePrefix}%`); }
    if (query.id) { clauses.push("id = ?"); values.push(query.id); }
    if (query.ids?.length) { clauses.push(`id IN (${query.ids.map(() => "?").join(",")})`); values.push(...query.ids); }
    for (const [column, value] of [
      ["session_id", query.sessionId], ["project_id", query.projectId], ["scope_type", query.scopeType],
      ["scope_id", query.scopeId], ["namespace", query.namespace], ["kind", query.kind],
      ["status", query.status], ["subject", query.subject], ["target_id", query.targetId],
      ["goal_id", query.goalId], ["candidate_id", query.candidateId], ["external_id", query.externalId], ["supersedes", query.supersedes]
    ] as Array<[string, unknown]>) {
      if (value !== undefined && value !== "") { clauses.push(`${column} = ?`); values.push(String(value)); }
    }
    if (query.namespacePrefix) { clauses.push("(namespace = ? OR namespace LIKE ?)"); values.push(query.namespacePrefix, `${query.namespacePrefix}/%`); }
    if (query.activeMemoryOnly) {
      clauses.push("type = 'memory'");
      clauses.push("status = 'active'");
      clauses.push("(expires_at IS NULL OR expires_at = '' OR expires_at > ?)");
      values.push(new Date().toISOString());
      clauses.push("NOT EXISTS (SELECT 1 FROM record_events superseder WHERE superseder.supersedes = record_events.id)");
      clauses.push("NOT EXISTS (SELECT 1 FROM record_events deactivation WHERE deactivation.type = 'memory.deactivation' AND deactivation.target_id = record_events.id)");
    }
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM record_events ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`).get(...values) as SqlRow;
    return Number(row.count);
  }

  close(): void { this.db.close(); }
}

export type LegacyRecordMigrationOptions = {
  legacyPath: string;
  databasePath: string;
  backupPath?: string;
  chunkSize?: number;
  failAfterRecords?: number;
};

export type LegacyRecordMigrationResult = {
  migrated: boolean;
  complete: boolean;
  records: number;
  nextByte: number;
  backup: string;
};

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
  const fileSize = statSync(legacyPath).size;
  const sourceFd = openSync(legacyPath, "r");
  const store = new SqliteRecordStore(databasePath);
  try {
    const current = migrationRow(store, legacyPath);
    if (current && String(current.source_sha256) !== sourceSha256) throw new Error("legacy records changed during SQLite migration");
    if (current?.complete) return { migrated: false, complete: true, records: Number(current.records), nextByte: Number(current.next_byte ?? current.next_line ?? 0), backup: backupPath };
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
      if (options.failAfterRecords !== undefined && records >= options.failAfterRecords && nextByte < fileSize) throw new Error("test migration interruption");
    }
    if (!migrationRow(store, legacyPath)) {
      store.transaction(() => saveMigration(store, { sourcePath: legacyPath, sourceSha256, backupPath, nextByte: fileSize, records, complete: true, startedAt }));
    }
    const final = migrationRow(store, legacyPath)!;
    return { migrated: true, complete: Boolean(final.complete), records: Number(final.records), nextByte: Number(final.next_byte), backup: backupPath };
  } finally {
    closeSync(sourceFd);
    store.close();
  }
}

export function rollbackLegacyRecordsMigration({ legacyPath, databasePath, backupPath = `${legacyPath}.pre-sqlite.bak` }: { legacyPath: string; databasePath: string; backupPath?: string }): { rolledBack: boolean; backup: string } {
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
  copyFileSync(resolvedBackup, resolvedLegacy);
  if (sha256File(resolvedLegacy) !== backupHash) throw new Error("migration rollback failed backup verification");
  for (const suffix of ["", "-wal", "-shm"]) {
    try { rmSync(`${resolvedDatabase}${suffix}`, { force: true }); } catch {}
    if (existsSync(`${resolvedDatabase}${suffix}`)) throw new Error("migration rollback failed database cleanup");
  }
  return { rolledBack: true, backup: resolvedBackup };
}

export function redactRecord(value: unknown): unknown {
  return redactDurableValue(value);
}
