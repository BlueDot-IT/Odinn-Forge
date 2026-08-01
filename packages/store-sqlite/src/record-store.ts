import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { JsonObject } from "@odinn/protocol";
import { SqliteStore } from "./index.ts";

export type StoredRecord = JsonObject & { schemaVersion: number; at?: string; type?: string };

export const RECORD_PAGE_SIZE = 200;
export const MAX_RECORD_PAGE_SIZE = 500;
export const MAX_RECORD_SCAN = 100_000;
const RECORD_SCHEMA_VERSION = 1;

type SqlRow = Record<string, unknown>;
type RecordOrder = "asc" | "desc";

type RecordFilter = {
  types?: string[];
  typePrefix?: string;
  sessionId?: string;
  projectId?: string;
  scopeType?: string;
  scopeId?: string;
  namespace?: string;
  kind?: string;
  status?: string;
  subject?: string;
  targetId?: string;
  text?: string;
};

export type RecordQuery = RecordFilter & {
  cursor?: string;
  limit?: number;
  order?: RecordOrder;
};

export type RecordPage = {
  records: StoredRecord[];
  nextCursor?: string;
};

type RecordTransaction = {
  append(record: JsonObject): StoredRecord;
  queryRecordsPage(query?: RecordQuery): RecordPage;
  findById(id: string): StoredRecord | undefined;
  findMessageByExternalId(sessionId: string, externalId: string): StoredRecord | undefined;
};

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dirname(path), 0o700);
}

function parseRecord(value: unknown): StoredRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record must be an object");
  const input = value as JsonObject;
  const schemaVersion = Number(input.schemaVersion ?? RECORD_SCHEMA_VERSION);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > RECORD_SCHEMA_VERSION) {
    throw new Error(`unsupported record schema version: ${String(input.schemaVersion)}`);
  }
  const at = typeof input.at === "string" && input.at ? input.at : new Date().toISOString();
  const normalized: StoredRecord = { schemaVersion: RECORD_SCHEMA_VERSION, at, ...input };
  return normalized;
}

function stringField(record: StoredRecord, name: string): string | null {
  return typeof record[name] === "string" && record[name] !== "" ? String(record[name]) : null;
}

function boundedLimit(value: unknown): number {
  const parsed = Number(value ?? RECORD_PAGE_SIZE);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return RECORD_PAGE_SIZE;
  return Math.min(parsed, MAX_RECORD_PAGE_SIZE);
}

function encodeCursor(sequence: number, order: RecordOrder): string {
  return Buffer.from(JSON.stringify({ version: 1, sequence, order }), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined, order: RecordOrder): number | undefined {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { version?: number; sequence?: number; order?: string };
    if (decoded.version !== 1 || decoded.order !== order || !Number.isSafeInteger(decoded.sequence) || Number(decoded.sequence) < 0) {
      throw new Error("invalid record cursor");
    }
    return Number(decoded.sequence);
  } catch {
    throw new Error("invalid record cursor");
  }
}

function recordFromRow(row: SqlRow): StoredRecord {
  const value = JSON.parse(String(row.payload_json));
  return parseRecord(value);
}

function recordDatabaseRow(record: StoredRecord, sequence: number) {
  return [
    sequence,
    stringField(record, "id") ?? `record_${randomUUID()}`,
    Number(record.schemaVersion ?? RECORD_SCHEMA_VERSION),
    String(record.at),
    stringField(record, "type") ?? "",
    JSON.stringify(record),
    stringField(record, "externalId"),
    stringField(record, "sessionId"),
    stringField(record, "projectId"),
    stringField(record, "scopeType"),
    stringField(record, "scopeId"),
    stringField(record, "namespace"),
    stringField(record, "kind"),
    stringField(record, "status"),
    stringField(record, "subject"),
    stringField(record, "targetId")
  ];
}

export class SqliteRecordStore {
  readonly database: SqliteStore;
  readonly db: SqliteStore["db"];
  readonly path: string;
  private nextSequence: number;

  constructor(path: string) {
    this.path = resolve(path);
    this.database = new SqliteStore(this.path);
    this.db = this.database.db;
    this.nextSequence = Number((this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM record_events").get() as SqlRow).sequence);
  }

  private refreshSequence(): void {
    this.nextSequence = Number((this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM record_events").get() as SqlRow).sequence);
  }

  appendSync(record: JsonObject): StoredRecord {
    const normalized = parseRecord(record);
    const type = stringField(normalized, "type");
    if (!type) throw new Error("record requires type");
    const id = stringField(normalized, "id") ?? `record_${randomUUID()}`;
    normalized.id = id;
    const externalId = stringField(normalized, "externalId");
    const sessionId = stringField(normalized, "sessionId");
    if (type === "message.appended" && externalId && sessionId) {
      const existing = this.findMessageByExternalIdSync(sessionId, externalId);
      if (existing) return existing;
    }
    const sequence = ++this.nextSequence;
    this.db.prepare(`
      INSERT INTO record_events(
        sequence, id, schema_version, at, type, payload_json, external_id, session_id,
        project_id, scope_type, scope_id, namespace, kind, status, subject, target_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...recordDatabaseRow(normalized, sequence));
    return normalized;
  }

  async append(record: JsonObject): Promise<StoredRecord> {
    return this.transactionSync((transaction) => transaction.append(record));
  }

  transactionSync<T>(callback: (transaction: RecordTransaction) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    this.refreshSequence();
    const transaction: RecordTransaction = {
      append: (record) => this.appendSync(record),
      queryRecordsPage: (query = {}) => this.queryRecordsPageSync(query),
      findById: (id) => this.findByIdSync(id),
      findMessageByExternalId: (sessionId, externalId) => this.findMessageByExternalIdSync(sessionId, externalId)
    };
    try {
      const result = callback(transaction);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  async transaction<T>(callback: (transaction: RecordTransaction) => T | Promise<T>): Promise<T> {
    let started = false;
    for (let attempt = 0; attempt < 100 && !started; attempt += 1) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        started = true;
      } catch (error) {
        if ((error as { code?: string }).code !== "ERR_SQLITE_ERROR" || attempt === 99) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    this.refreshSequence();
    const transaction: RecordTransaction = {
      append: (record) => this.appendSync(record),
      queryRecordsPage: (query = {}) => this.queryRecordsPageSync(query),
      findById: (id) => this.findByIdSync(id),
      findMessageByExternalId: (sessionId, externalId) => this.findMessageByExternalIdSync(sessionId, externalId)
    };
    try {
      const result = await callback(transaction);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  queryRecordsPageSync(query: RecordQuery = {}): RecordPage {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (query.types?.length) {
      clauses.push(`type IN (${query.types.map(() => "?").join(", ")})`);
      values.push(...query.types);
    }
    if (query.typePrefix) { clauses.push("type LIKE ?"); values.push(`${query.typePrefix}%`); }
    for (const [column, value] of [
      ["session_id", query.sessionId], ["project_id", query.projectId], ["scope_type", query.scopeType],
      ["scope_id", query.scopeId], ["namespace", query.namespace], ["kind", query.kind],
      ["status", query.status], ["subject", query.subject], ["target_id", query.targetId]
    ] as Array<[string, unknown]>) {
      if (value !== undefined && value !== "") { clauses.push(`${column} = ?`); values.push(String(value)); }
    }
    if (query.text?.trim()) {
      const tokens = query.text.trim().toLowerCase().split(/\s+/u).filter(Boolean).slice(0, 16);
      clauses.push(`(${tokens.map(() => "lower(payload_json) LIKE ?").join(" OR ")})`);
      values.push(...tokens.map((token) => `%${token}%`));
    }
    const order: RecordOrder = query.order === "desc" ? "desc" : "asc";
    const cursor = decodeCursor(query.cursor, order);
    if (cursor !== undefined) clauses.push(`sequence ${order === "asc" ? ">" : "<"} ?`), values.push(cursor);
    const limit = boundedLimit(query.limit);
    values.push(limit + 1);
    const rows = this.db.prepare(`
      SELECT sequence, payload_json FROM record_events
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY sequence ${order.toUpperCase()} LIMIT ?
    `).all(...values) as SqlRow[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastSequence = pageRows.at(-1)?.sequence;
    return {
      records: pageRows.map(recordFromRow),
      ...(hasMore && lastSequence !== undefined ? { nextCursor: encodeCursor(Number(lastSequence), order) } : {})
    };
  }

  async queryRecordsPage(query: RecordQuery = {}): Promise<RecordPage> {
    return this.queryRecordsPageSync(query);
  }

  async queryRecords(query: RecordQuery = {}): Promise<StoredRecord[]> {
    return (await this.queryRecordsPage(query)).records;
  }

  async readAll(): Promise<StoredRecord[]> {
    const records: StoredRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.queryRecordsPage({ limit: MAX_RECORD_PAGE_SIZE, order: "asc", cursor });
      records.push(...page.records);
      cursor = page.nextCursor;
      if (records.length > MAX_RECORD_SCAN) throw new Error(`record scan exceeds bounded limit ${MAX_RECORD_SCAN}`);
    } while (cursor);
    return records;
  }

  findByIdSync(id: string): StoredRecord | undefined {
    const row = this.db.prepare("SELECT payload_json FROM record_events WHERE id = ? ORDER BY sequence DESC LIMIT 1").get(id) as SqlRow | undefined;
    return row ? recordFromRow(row) : undefined;
  }

  async findById(id: string): Promise<StoredRecord | undefined> { return this.findByIdSync(id); }

  findMessageByExternalIdSync(sessionId: string, externalId: string): StoredRecord | undefined {
    const row = this.db.prepare("SELECT payload_json FROM record_events WHERE type = 'message.appended' AND session_id = ? AND external_id = ? ORDER BY sequence ASC LIMIT 1").get(sessionId, externalId) as SqlRow | undefined;
    return row ? recordFromRow(row) : undefined;
  }

  async findMessageByExternalId(sessionId: string, externalId: string): Promise<StoredRecord | undefined> {
    return this.findMessageByExternalIdSync(sessionId, externalId);
  }

  backup(destination: string): string {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    ensureParent(destination);
    copyFileSync(this.path, destination);
    chmodSync(destination, 0o600);
    return destination;
  }

  close(): void { this.database.close(); }
}

function sourceDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function legacyBackupPath(source: string): string { return `${source}.migration.bak`; }

export function migrateLegacyRecordsToSqlite({ legacyPath, databasePath }: { legacyPath: string; databasePath: string }) {
  const source = resolve(legacyPath);
  const backup = legacyBackupPath(source);
  const store = new SqliteRecordStore(databasePath);
  try {
    const existing = Number((store.db.prepare("SELECT count(*) AS count FROM record_events").get() as SqlRow).count);
    if (!existsSync(source)) return { migrated: false, backup: existsSync(backup) ? backup : undefined, records: existing };
    if (existsSync(backup) && sourceDigest(source) !== sourceDigest(backup)) {
      throw new Error(`legacy records changed after migration backup was created: ${source}`);
    }
    if (!existsSync(backup)) {
      ensureParent(backup);
      copyFileSync(source, backup);
      chmodSync(backup, 0o600);
    }
    if (existing > 0) return { migrated: false, backup, records: existing };
    const records = readFileSync(backup, "utf8").split("\n").filter((line) => line.trim()).map((line) => parseRecord(JSON.parse(line)));
    store.transactionSync((transaction) => {
      for (const record of records) transaction.append(record);
    });
    return { migrated: true, backup, records: records.length };
  } finally {
    store.close();
  }
}
