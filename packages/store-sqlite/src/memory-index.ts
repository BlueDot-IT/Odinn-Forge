import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, parse, resolve, sep } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export const MEMORY_INDEX_SCHEMA_VERSION = 1;

export const MEMORY_INDEX_LIMITS = Object.freeze({
  documentBytes: 512 * 1024,
  idBytes: 256,
  fieldBytes: 256 * 1024,
  metadataFieldBytes: 4 * 1024,
  tags: 32,
  tagBytes: 256,
  rebuildDocuments: 250_000,
  queryBytes: 2 * 1024,
  queryTokens: 32,
  queryTokenBytes: 256,
  results: 100,
  offset: 10_000
});

export type MemoryIndexDocument = {
  id: string;
  kind: string;
  namespace: string;
  scopeType: string;
  scopeId: string;
  subject: string;
  summary: string;
  text: string;
  tags: string[];
  at: string;
  source?: string;
  authority?: string;
  confidence?: number;
};

export type MemoryIndexFreshness = {
  sourceGeneration: string;
  sourceFingerprint: string;
};

export type MemoryIndexStatus = MemoryIndexFreshness & {
  schemaVersion: number;
  documents: number;
  complete: boolean;
  stale: boolean;
};

export type MemoryIndexQuery = {
  text: string;
  namespace?: string;
  kind?: string;
  scopeType?: string;
  scopeId?: string;
  tags?: string[];
  atOrBefore?: string;
  atOrAfter?: string;
  limit?: number;
  offset?: number;
  expectedSourceGeneration?: string;
  expectedSourceFingerprint?: string;
};

export type MemoryIndexResult = MemoryIndexDocument & { rank: number };

type SqliteLike = Pick<DatabaseSync, "exec" | "prepare">;
type Row = Record<string, unknown>;
type FileIdentity = { dev: bigint; ino: bigint };
type OwnerLock = { lockPath: string; identity: FileIdentity };
type FingerprintEntry = { id: string; digest: string };
const MEMORY_DOCUMENT_FIELDS = new Set([
  "id", "kind", "namespace", "scopeType", "scopeId", "subject", "summary", "text",
  "tags", "at", "source", "authority", "confidence"
]);

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fileIdentity(path: string): FileIdentity {
  const information = lstatSync(path, { bigint: true });
  if (!information.isFile() || information.isSymbolicLink() || information.nlink !== 1n) {
    throw new Error(`memory index file identity is unsafe: ${path}`);
  }
  return { dev: information.dev, ino: information.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedString(value: unknown, name: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  if (!allowEmpty && value.length === 0) throw new TypeError(`${name} must not be empty`);
  if (value.includes("\0")) throw new TypeError(`${name} must not contain NUL`);
  if (byteLength(value) > maxBytes) throw new RangeError(`${name} exceeds ${maxBytes} UTF-8 bytes`);
  return value;
}

function identifier(value: unknown, name: string): string {
  const result = boundedString(value, name, MEMORY_INDEX_LIMITS.idBytes);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._:/@+-]*$/u.test(result)) {
    throw new TypeError(`${name} contains unsupported characters`);
  }
  return result;
}

function timestamp(value: unknown, name: string): string {
  const result = boundedString(value, name, 64);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== result) {
    throw new TypeError(`${name} must be a canonical ISO 8601 timestamp`);
  }
  return result;
}

function canonicalTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError("tags must be an array");
  if (value.length > MEMORY_INDEX_LIMITS.tags) throw new RangeError(`tags exceeds ${MEMORY_INDEX_LIMITS.tags} items`);
  const tags = value.map((tag, index) => boundedString(tag, `tags[${index}]`, MEMORY_INDEX_LIMITS.tagBytes));
  if (new Set(tags).size !== tags.length) throw new TypeError("tags must not contain duplicates");
  return [...tags].sort(codePointCompare);
}

function canonicalScope(scopeTypeValue: unknown, scopeIdValue: unknown): { scopeType: string; scopeId: string } {
  const scopeType = identifier(scopeTypeValue, "scopeType");
  if (!["global", "project", "session"].includes(scopeType)) {
    throw new TypeError("scopeType must be global, project, or session");
  }
  if (scopeType === "global") {
    if (scopeIdValue !== "") throw new TypeError("scopeId must be empty for global scope");
    return { scopeType, scopeId: "" };
  }
  return { scopeType, scopeId: identifier(scopeIdValue, "scopeId") };
}

export function validateMemoryIndexDocument(value: MemoryIndexDocument): MemoryIndexDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("memory document must be an object");
  const unknown = Object.keys(value).filter((key) => !MEMORY_DOCUMENT_FIELDS.has(key));
  if (unknown.length > 0) throw new TypeError(`memory document contains unknown fields: ${unknown.sort(codePointCompare).join(", ")}`);
  const confidence = value.confidence;
  if (confidence !== undefined && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new RangeError("confidence must be a finite number from 0 through 1");
  }
  const scope = canonicalScope(value.scopeType, value.scopeId);
  const document: MemoryIndexDocument = {
    id: identifier(value.id, "id"),
    kind: identifier(value.kind, "kind"),
    namespace: identifier(value.namespace, "namespace"),
    ...scope,
    subject: boundedString(value.subject, "subject", MEMORY_INDEX_LIMITS.metadataFieldBytes, true),
    summary: boundedString(value.summary, "summary", MEMORY_INDEX_LIMITS.fieldBytes, true),
    text: boundedString(value.text, "text", MEMORY_INDEX_LIMITS.fieldBytes, true),
    tags: canonicalTags(value.tags),
    at: timestamp(value.at, "at")
  };
  if (value.source !== undefined) document.source = boundedString(value.source, "source", MEMORY_INDEX_LIMITS.metadataFieldBytes);
  if (value.authority !== undefined) document.authority = boundedString(value.authority, "authority", MEMORY_INDEX_LIMITS.metadataFieldBytes);
  if (confidence !== undefined) document.confidence = confidence;
  if (byteLength(JSON.stringify(document)) > MEMORY_INDEX_LIMITS.documentBytes) {
    throw new RangeError(`memory document exceeds ${MEMORY_INDEX_LIMITS.documentBytes} UTF-8 bytes`);
  }
  return document;
}

function validateFreshness(value: MemoryIndexFreshness): MemoryIndexFreshness {
  if (!value || typeof value !== "object") throw new TypeError("freshness metadata is required");
  return {
    sourceGeneration: identifier(value.sourceGeneration, "sourceGeneration"),
    sourceFingerprint: boundedString(value.sourceFingerprint, "sourceFingerprint", 512)
  };
}

function documentFingerprintEntry(document: MemoryIndexDocument): FingerprintEntry {
  return {
    id: document.id,
    digest: createHash("sha256").update(JSON.stringify(document)).digest("hex")
  };
}

function corpusFingerprint(entries: FingerprintEntry[]): string {
  entries.sort((left, right) => codePointCompare(left.id, right.id));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(JSON.stringify([entry.id, entry.digest]));
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

function ensureSecureDatabasePath(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) throw new TypeError("memory index path must be a non-empty path");
  let path = resolve(input);
  if (!isAbsolute(path)) throw new TypeError("memory index path must resolve to an absolute path");
  // macOS exposes /tmp and /var as fixed operating-system aliases beneath
  // /private. Treat only those exact platform roots as lexical sugar, then
  // apply the normal non-symlink walk to the canonical tree. Symlinks below
  // either root remain forbidden.
  if (process.platform === "darwin") {
    for (const alias of ["/tmp", "/var"]) {
      if (path !== alias && !path.startsWith(`${alias}/`)) continue;
      const metadata = lstatSync(alias);
      if (!metadata.isSymbolicLink() || resolve(realpathSync(alias)) !== `/private${alias}`) {
        throw new Error(`memory index macOS ${alias} alias is not canonical`);
      }
      path = resolve(`/private${path}`);
      break;
    }
  }
  const root = parse(path).root;
  let cursor = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean).slice(0, -1)) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
    const information = lstatSync(cursor);
    if (information.isSymbolicLink()) throw new Error(`memory index path contains a symbolic link: ${cursor}`);
    if (!information.isDirectory()) throw new Error(`memory index parent is not a directory: ${cursor}`);
  }
  const parent = dirname(path);
  if (resolve(realpathSync(parent)) !== resolve(parent)) throw new Error("memory index parent resolves through a symbolic link");
  const parentInformation = lstatSync(parent);
  if (process.platform !== "win32") {
    if ((parentInformation.mode & 0o077) !== 0) throw new Error("memory index parent must be owner-only (mode 0700)");
    const getProcessUserId = process.getuid;
    const currentUser = getProcessUserId?.();
    if (currentUser !== undefined && parentInformation.uid !== currentUser) throw new Error("memory index parent must be owned by the current user");
  }
  if (existsSync(path)) {
    const information = lstatSync(path);
    if (information.isSymbolicLink() || !information.isFile()) throw new Error("memory index path must be a regular, non-symbolic-link file");
    if (information.nlink !== 1) throw new Error("memory index path must not be hard-linked");
  } else {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
  for (const sidecar of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    if (!existsSync(sidecar)) continue;
    const information = lstatSync(sidecar);
    if (information.isSymbolicLink() || !information.isFile()) {
      throw new Error(`memory index SQLite sidecar must be a regular, non-symbolic-link file: ${sidecar}`);
    }
    if (information.nlink !== 1) throw new Error(`memory index SQLite sidecar must not be hard-linked: ${sidecar}`);
  }
  return path;
}

function secureSqliteSidecars(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    if (!existsSync(candidate)) continue;
    const information = lstatSync(candidate);
    if (information.isSymbolicLink() || !information.isFile()) {
      throw new Error(`memory index SQLite file must be a regular, non-symbolic-link file: ${candidate}`);
    }
    if (information.nlink !== 1) throw new Error(`memory index SQLite file must not be hard-linked: ${candidate}`);
    chmodSync(candidate, 0o600);
  }
}

function acquireOwnerLock(path: string): OwnerLock {
  const lockPath = `${path}.lock`;
  const token = randomUUID();
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      throw new Error(`memory index is already owned; verify no process is using it before removing ${lockPath}`);
    }
    throw error;
  }
  const information = fstatSync(descriptor, { bigint: true });
  const identity = { dev: information.dev, ino: information.ino };
  try {
    writeFileSync(descriptor, `${JSON.stringify({ token, pid: process.pid })}\n`, "utf8");
  } catch (error) {
    closeSync(descriptor);
    try {
      if (existsSync(lockPath) && sameIdentity(fileIdentity(lockPath), identity)) unlinkSync(lockPath);
    } catch {}
    throw error;
  }
  closeSync(descriptor);
  return { lockPath, identity };
}

function releaseOwnerLock(lock: OwnerLock): void {
  if (!existsSync(lock.lockPath)) return;
  if (sameIdentity(fileIdentity(lock.lockPath), lock.identity)) unlinkSync(lock.lockPath);
}

export function assertFts5Available(database: SqliteLike): void {
  try {
    database.exec("CREATE VIRTUAL TABLE temp.odinn_fts5_probe USING fts5(value); DROP TABLE temp.odinn_fts5_probe;");
  } catch (error) {
    throw new Error("SQLite FTS5 is unavailable; the memory candidate index cannot be opened", { cause: error });
  }
}

const SCHEMA_SQL = {
  memory_index_metadata: `CREATE TABLE IF NOT EXISTS memory_index_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      source_generation TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
      document_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`,
  memory_documents: `CREATE TABLE IF NOT EXISTS memory_documents (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      namespace TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      summary TEXT NOT NULL,
      text TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      at TEXT NOT NULL,
      source TEXT,
      authority TEXT,
      confidence REAL
    ) STRICT`,
  memory_documents_filters: `CREATE INDEX IF NOT EXISTS memory_documents_filters
      ON memory_documents(namespace, kind, scope_type, scope_id, at DESC, id ASC)`,
  memory_documents_fts: `CREATE VIRTUAL TABLE IF NOT EXISTS memory_documents_fts USING fts5(
      subject, summary, text, tags_json,
      content='memory_documents',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    )`,
  memory_documents_ai: `CREATE TRIGGER IF NOT EXISTS memory_documents_ai AFTER INSERT ON memory_documents BEGIN
      INSERT INTO memory_documents_fts(rowid, subject, summary, text, tags_json)
      VALUES (new.rowid, new.subject, new.summary, new.text, new.tags_json);
    END`,
  memory_documents_ad: `CREATE TRIGGER IF NOT EXISTS memory_documents_ad AFTER DELETE ON memory_documents BEGIN
      INSERT INTO memory_documents_fts(memory_documents_fts, rowid, subject, summary, text, tags_json)
      VALUES ('delete', old.rowid, old.subject, old.summary, old.text, old.tags_json);
    END`,
  memory_documents_au: `CREATE TRIGGER IF NOT EXISTS memory_documents_au AFTER UPDATE ON memory_documents BEGIN
      INSERT INTO memory_documents_fts(memory_documents_fts, rowid, subject, summary, text, tags_json)
      VALUES ('delete', old.rowid, old.subject, old.summary, old.text, old.tags_json);
      INSERT INTO memory_documents_fts(rowid, subject, summary, text, tags_json)
      VALUES (new.rowid, new.subject, new.summary, new.text, new.tags_json);
    END`
} as const;

function createSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    ${SCHEMA_SQL.memory_index_metadata};
    ${SCHEMA_SQL.memory_documents};
    ${SCHEMA_SQL.memory_documents_filters};
    ${SCHEMA_SQL.memory_documents_fts};
    ${SCHEMA_SQL.memory_documents_ai};
    ${SCHEMA_SQL.memory_documents_ad};
    ${SCHEMA_SQL.memory_documents_au};
    INSERT OR IGNORE INTO memory_index_metadata(
      singleton, schema_version, source_generation, source_fingerprint, complete, document_count, updated_at
    ) VALUES (1, ${MEMORY_INDEX_SCHEMA_VERSION}, '', '', 0, 0, '1970-01-01T00:00:00.000Z');
  `);
  const row = database.prepare("SELECT schema_version FROM memory_index_metadata WHERE singleton = 1").get() as Row | undefined;
  if (Number(row?.schema_version) !== MEMORY_INDEX_SCHEMA_VERSION) {
    throw new Error(`unsupported memory index schema version: ${String(row?.schema_version)}`);
  }
}

const CORE_SCHEMA_COLUMNS = {
  memory_index_metadata: [
    "singleton", "schema_version", "source_generation", "source_fingerprint",
    "complete", "document_count", "updated_at"
  ],
  memory_documents: [
    "id", "kind", "namespace", "scope_type", "scope_id", "subject", "summary",
    "text", "tags_json", "at", "source", "authority", "confidence"
  ]
} as const;
const CORE_SCHEMA_TYPES = {
  memory_index_metadata: ["INTEGER", "INTEGER", "TEXT", "TEXT", "INTEGER", "INTEGER", "TEXT"],
  memory_documents: ["TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "REAL"]
} as const;
const CORE_SCHEMA_NOT_NULL = {
  memory_index_metadata: [0, 1, 1, 1, 1, 1, 1],
  memory_documents: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0]
} as const;
const CORE_SCHEMA_PRIMARY_KEY = {
  memory_index_metadata: [1, 0, 0, 0, 0, 0, 0],
  memory_documents: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
} as const;
const AUXILIARY_SCHEMA_OBJECTS = [
  ["table", "memory_documents_fts"],
  ["index", "memory_documents_filters"],
  ["trigger", "memory_documents_ai"],
  ["trigger", "memory_documents_ad"],
  ["trigger", "memory_documents_au"]
] as const;

function schemaObject(database: DatabaseSync, type: string, name: string): Row | undefined {
  return database.prepare("SELECT type, name, sql FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) as Row | undefined;
}

function validateCoreTable(database: DatabaseSync, table: keyof typeof CORE_SCHEMA_COLUMNS): void {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Row[];
  const actual = rows.map((row) => String(row.name));
  const expected = [...CORE_SCHEMA_COLUMNS[table]];
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`memory index schema corruption: ${table} columns do not match schema version ${MEMORY_INDEX_SCHEMA_VERSION}`);
  }
  const types = CORE_SCHEMA_TYPES[table];
  if (rows.some((row, index) => String(row.type).toUpperCase() !== types[index])) {
    throw new Error(`memory index schema corruption: ${table} column types do not match schema version ${MEMORY_INDEX_SCHEMA_VERSION}`);
  }
  if (rows.some((row, index) => Number(row.notnull) !== CORE_SCHEMA_NOT_NULL[table][index]
    || Number(row.pk) !== CORE_SCHEMA_PRIMARY_KEY[table][index] || row.dflt_value !== null)) {
    throw new Error(`memory index schema corruption: ${table} column constraints do not match schema version ${MEMORY_INDEX_SCHEMA_VERSION}`);
  }
  const tableMetadata = database.prepare("PRAGMA table_list").all() as Row[];
  const descriptor = tableMetadata.find((row) => row.name === table && row.schema === "main");
  if (Number(descriptor?.strict) !== 1) throw new Error(`memory index schema corruption: ${table} must be STRICT`);
  const object = schemaObject(database, "table", table);
  if (!object || canonicalSchemaSql(object.sql) !== canonicalSchemaSql(SCHEMA_SQL[table])) {
    throw new Error(`memory index schema corruption: ${table} SQL does not match the canonical contract`);
  }
}

function canonicalSchemaSql(value: unknown): string {
  const sql = String(value ?? "");
  const tokens: string[] = [];
  for (let index = 0; index < sql.length;) {
    const character = sql[index];
    if (/\s/u.test(character)) { index += 1; continue; }
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      const closing = character === "[" ? "]" : character;
      let token = character;
      index += 1;
      while (index < sql.length) {
        token += sql[index];
        if (sql[index] === closing) {
          if (sql[index + 1] === closing && closing !== "]") {
            token += sql[index + 1];
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      tokens.push(`quoted:${token}`);
      continue;
    }
    const word = /^[\p{L}\p{N}_.$]+/u.exec(sql.slice(index))?.[0];
    if (word) {
      tokens.push(word.toLowerCase());
      index += word.length;
      continue;
    }
    tokens.push(character);
    index += 1;
  }
  const withoutCreationHint: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === "if" && tokens[index + 1] === "not" && tokens[index + 2] === "exists") {
      index += 2;
      continue;
    }
    withoutCreationHint.push(tokens[index]);
  }
  if (withoutCreationHint.at(-1) === ";") withoutCreationHint.pop();
  return JSON.stringify(withoutCreationHint);
}

function validateAuxiliaryObject(database: DatabaseSync, type: string, name: keyof typeof SCHEMA_SQL, object: Row): void {
  if (canonicalSchemaSql(object.sql) !== canonicalSchemaSql(SCHEMA_SQL[name])) {
    throw new Error(`memory index schema corruption: ${type} ${name} SQL does not match the canonical contract`);
  }
  if (name === "memory_documents_fts") {
    const columns = (database.prepare("PRAGMA table_info(memory_documents_fts)").all() as Row[]).map((row) => String(row.name));
    if (columns.join(",") !== "subject,summary,text,tags_json") {
      throw new Error("memory index schema corruption: FTS columns do not match the required schema");
    }
  } else if (type === "index") {
    const columns = (database.prepare("PRAGMA index_info(memory_documents_filters)").all() as Row[]).map((row) => String(row.name));
    if (columns.join(",") !== "namespace,kind,scope_type,scope_id,at,id") {
      throw new Error("memory index schema corruption: filter index columns do not match the required schema");
    }
  }
}

function inspectExistingSchema(database: DatabaseSync, maxDocuments: number): { ftsRepairRequired: boolean; filterIndexMissing: boolean } {
  const metadataExists = Boolean(schemaObject(database, "table", "memory_index_metadata"));
  const documentsExists = Boolean(schemaObject(database, "table", "memory_documents"));
  if (metadataExists !== documentsExists) throw new Error("memory index schema corruption: core tables are incomplete");
  if (!metadataExists) return { ftsRepairRequired: false, filterIndexMissing: false };
  validateCoreTable(database, "memory_index_metadata");
  validateCoreTable(database, "memory_documents");
  const metadataRows = database.prepare("SELECT * FROM memory_index_metadata").all() as Row[];
  if (metadataRows.length !== 1) throw new Error("memory index metadata must contain exactly one row");
  validateMetadataRow(metadataRows[0]);
  databaseFingerprint(database, maxDocuments);

  let ftsRepairRequired = false;
  let filterIndexMissing = false;
  for (const [type, name] of AUXILIARY_SCHEMA_OBJECTS) {
    const object = schemaObject(database, type, name);
    if (!object) {
      if (name === "memory_documents_filters") filterIndexMissing = true;
      else ftsRepairRequired = true;
      continue;
    }
    validateAuxiliaryObject(database, type, name, object);
  }
  return { ftsRepairRequired, filterIndexMissing };
}

function databaseFingerprint(database: DatabaseSync, maxDocuments: number): { count: number; fingerprint: string } {
  const hash = createHash("sha256");
  let count = 0;
  const rows = database.prepare("SELECT * FROM memory_documents ORDER BY id ASC").iterate() as Iterable<Row>;
  for (const row of rows) {
    count += 1;
    if (count > maxDocuments) throw new Error(`memory index contains more than ${maxDocuments} documents`);
    const entry = documentFingerprintEntry(asDocument(row));
    hash.update(JSON.stringify([entry.id, entry.digest]));
    hash.update("\n");
  }
  return { count, fingerprint: `sha256:${hash.digest("hex")}` };
}

function validateMetadataRow(row: Row): {
  complete: boolean;
  documentCount: number;
  sourceGeneration: string;
  sourceFingerprint: string;
} {
  if (Number(row.singleton) !== 1) throw new Error("memory index metadata singleton is malformed");
  if (Number(row.schema_version) !== MEMORY_INDEX_SCHEMA_VERSION) {
    throw new Error(`unsupported memory index schema version: ${String(row.schema_version)}`);
  }
  const completeValue = Number(row.complete);
  if (completeValue !== 0 && completeValue !== 1) throw new Error("memory index metadata complete flag is malformed");
  const documentCount = Number(row.document_count);
  if (!Number.isSafeInteger(documentCount) || documentCount < 0 || documentCount > MEMORY_INDEX_LIMITS.rebuildDocuments) {
    throw new Error("memory index metadata document count is malformed");
  }
  timestamp(row.updated_at, "memory index metadata updatedAt");
  const complete = completeValue === 1;
  const sourceGeneration = complete
    ? identifier(row.source_generation, "memory index sourceGeneration")
    : boundedString(row.source_generation, "memory index sourceGeneration", MEMORY_INDEX_LIMITS.idBytes, true);
  const sourceFingerprint = complete
    ? boundedString(row.source_fingerprint, "memory index sourceFingerprint", 512)
    : boundedString(row.source_fingerprint, "memory index sourceFingerprint", 512, true);
  return { complete, documentCount, sourceGeneration, sourceFingerprint };
}

function ftsParityValid(database: DatabaseSync, documentCount: number): boolean {
  try {
    database.exec("INSERT INTO memory_documents_fts(memory_documents_fts, rank) VALUES ('integrity-check', 1)");
    const row = database.prepare("SELECT count(*) AS count FROM memory_documents_fts_docsize").get() as Row;
    if (Number(row.count) !== documentCount) return false;
    const missing = database.prepare(`
      SELECT count(*) AS count
      FROM memory_documents d
      LEFT JOIN memory_documents_fts_docsize f ON f.id = d.rowid
      WHERE f.id IS NULL
    `).get() as Row;
    return Number(missing.count) === 0;
  } catch {
    return false;
  }
}

function validateAndRecoverIndex(database: DatabaseSync, repairRequired: boolean, maxDocuments: number): void {
  validateCoreTable(database, "memory_index_metadata");
  validateCoreTable(database, "memory_documents");
  for (const [type, name] of AUXILIARY_SCHEMA_OBJECTS) {
    const object = schemaObject(database, type, name);
    if (!object) throw new Error(`memory index schema corruption: required ${type} ${name} is missing`);
    validateAuxiliaryObject(database, type, name, object);
  }
  const metadataRows = database.prepare("SELECT * FROM memory_index_metadata").all() as Row[];
  if (metadataRows.length !== 1) throw new Error("memory index metadata must contain exactly one row");
  const metadata = validateMetadataRow(metadataRows[0]);
  const corpus = databaseFingerprint(database, maxDocuments);
  const staleMetadata = metadata.documentCount !== corpus.count
    || (metadata.complete && metadata.sourceFingerprint !== corpus.fingerprint);
  const invalidFts = !ftsParityValid(database, corpus.count);
  if (!repairRequired && !staleMetadata && !invalidFts) return;

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("INSERT INTO memory_documents_fts(memory_documents_fts) VALUES ('rebuild')");
    database.prepare(`
      UPDATE memory_index_metadata
      SET complete = 0, document_count = ?, updated_at = ?
      WHERE singleton = 1
    `).run(corpus.count, new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw new Error("memory index recovery failed; a full rebuild is required before use", { cause: error });
  }
  if (!ftsParityValid(database, corpus.count)) throw new Error("memory index FTS recovery did not restore structural parity");
}

function insertDocument(database: DatabaseSync, document: MemoryIndexDocument): void {
  database.prepare(`
    INSERT INTO memory_documents(
      id, kind, namespace, scope_type, scope_id, subject, summary, text, tags_json, at, source, authority, confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    document.id, document.kind, document.namespace, document.scopeType, document.scopeId,
    document.subject, document.summary, document.text, JSON.stringify(document.tags), document.at,
    document.source ?? null, document.authority ?? null, document.confidence ?? null
  );
}

function asDocument(row: Row): MemoryIndexDocument {
  const document: MemoryIndexDocument = {
    id: String(row.id),
    kind: String(row.kind),
    namespace: String(row.namespace),
    scopeType: String(row.scope_type),
    scopeId: String(row.scope_id),
    subject: String(row.subject),
    summary: String(row.summary),
    text: String(row.text),
    tags: JSON.parse(String(row.tags_json)) as string[],
    at: String(row.at)
  };
  if (row.source !== null && row.source !== undefined) document.source = String(row.source);
  if (row.authority !== null && row.authority !== undefined) document.authority = String(row.authority);
  if (row.confidence !== null && row.confidence !== undefined) document.confidence = Number(row.confidence);
  return validateMemoryIndexDocument(document);
}

export function memoryFtsQuery(input: string): string {
  boundedString(input, "query text", MEMORY_INDEX_LIMITS.queryBytes);
  const tokens = input.normalize("NFKC").match(/[\p{L}\p{N}]+(?:[_'-][\p{L}\p{N}]+)*/gu) ?? [];
  if (tokens.length === 0) throw new TypeError("query text must contain at least one searchable token");
  if (tokens.length > MEMORY_INDEX_LIMITS.queryTokens) throw new RangeError(`query exceeds ${MEMORY_INDEX_LIMITS.queryTokens} tokens`);
  return tokens.map((token, index) => {
    if (byteLength(token) > MEMORY_INDEX_LIMITS.queryTokenBytes) {
      throw new RangeError(`query token ${index} exceeds ${MEMORY_INDEX_LIMITS.queryTokenBytes} UTF-8 bytes`);
    }
    return `"${token.replaceAll('"', '""')}"`;
  }).join(" AND ");
}

export class MemoryCandidateIndex {
  readonly path: string;
  readonly lockPath: string;
  #database: DatabaseSync;
  #ownerLock: OwnerLock;
  #maxDocuments: number;
  #closed = false;

  constructor(path: string, { maxDocuments = MEMORY_INDEX_LIMITS.rebuildDocuments }: { maxDocuments?: number } = {}) {
    if (!Number.isSafeInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > MEMORY_INDEX_LIMITS.rebuildDocuments) {
      throw new RangeError(`maxDocuments must be from 1 through ${MEMORY_INDEX_LIMITS.rebuildDocuments}`);
    }
    this.#maxDocuments = maxDocuments;
    this.path = ensureSecureDatabasePath(path);
    const initialIdentity = fileIdentity(this.path);
    const lock = acquireOwnerLock(this.path);
    this.lockPath = lock.lockPath;
    this.#ownerLock = lock;
    let database: DatabaseSync | undefined;
    try {
      if (!sameIdentity(initialIdentity, fileIdentity(this.path))) throw new Error("memory index file identity changed before open");
      database = new DatabaseSync(this.path);
      if (!sameIdentity(initialIdentity, fileIdentity(this.path))) throw new Error("memory index file identity changed during open");
      assertFts5Available(database);
      const existing = inspectExistingSchema(database, this.#maxDocuments);
      createSchema(database);
      validateAndRecoverIndex(database, existing.ftsRepairRequired, this.#maxDocuments);
      secureSqliteSidecars(this.path);
      if (!sameIdentity(initialIdentity, fileIdentity(this.path))) throw new Error("memory index file identity changed during initialization");
      this.#database = database;
    } catch (error) {
      try { database?.close(); } catch {}
      try { releaseOwnerLock(this.#ownerLock); } catch {}
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("memory index is closed");
  }

  status(expected: Partial<MemoryIndexFreshness> = {}): MemoryIndexStatus {
    this.#assertOpen();
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw new TypeError("expected freshness must be an object");
    const expectedGeneration = expected.sourceGeneration === undefined
      ? undefined
      : identifier(expected.sourceGeneration, "expected sourceGeneration");
    const expectedFingerprint = expected.sourceFingerprint === undefined
      ? undefined
      : boundedString(expected.sourceFingerprint, "expected sourceFingerprint", 512);
    const row = this.#database.prepare(`
      SELECT singleton, schema_version, source_generation, source_fingerprint, complete, document_count, updated_at
      FROM memory_index_metadata WHERE singleton = 1
    `).get() as Row;
    const metadata = validateMetadataRow(row);
    const status = {
      schemaVersion: Number(row.schema_version),
      sourceGeneration: metadata.sourceGeneration,
      sourceFingerprint: metadata.sourceFingerprint,
      complete: metadata.complete,
      documents: metadata.documentCount,
      stale: false
    };
    status.stale = !status.complete
      || (expectedGeneration !== undefined && expectedGeneration !== status.sourceGeneration)
      || (expectedFingerprint !== undefined && expectedFingerprint !== status.sourceFingerprint);
    return status;
  }

  rebuild(documents: Iterable<MemoryIndexDocument>, freshness: MemoryIndexFreshness): MemoryIndexStatus {
    this.#assertOpen();
    const canonicalFreshness = validateFreshness(freshness);
    const ids = new Set<string>();
    const fingerprintEntries: FingerprintEntry[] = [];
    let count = 0;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec("DELETE FROM memory_documents");
      for (const raw of documents) {
        if (count >= this.#maxDocuments) {
          throw new RangeError(`rebuild exceeds ${this.#maxDocuments} documents`);
        }
        const document = validateMemoryIndexDocument(raw);
        if (ids.has(document.id)) throw new TypeError(`rebuild contains duplicate id: ${document.id}`);
        ids.add(document.id);
        fingerprintEntries.push(documentFingerprintEntry(document));
        insertDocument(this.#database, document);
        count += 1;
      }
      const indexedFingerprint = corpusFingerprint(fingerprintEntries);
      if (canonicalFreshness.sourceFingerprint !== indexedFingerprint) {
        throw new Error(`source fingerprint mismatch: indexed documents produce ${indexedFingerprint}`);
      }
      if (!ftsParityValid(this.#database, count)) throw new Error("FTS/content parity failed during rebuild");
      this.#database.prepare(`
        UPDATE memory_index_metadata
        SET schema_version = ?, source_generation = ?, source_fingerprint = ?,
            complete = 1, document_count = ?, updated_at = ?
        WHERE singleton = 1
      `).run(
        MEMORY_INDEX_SCHEMA_VERSION,
        canonicalFreshness.sourceGeneration,
        canonicalFreshness.sourceFingerprint,
        count,
        new Date().toISOString()
      );
      this.#database.exec("COMMIT");
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return this.status(canonicalFreshness);
  }

  upsert(
    document: MemoryIndexDocument,
    freshness: MemoryIndexFreshness,
    expectedCurrent: MemoryIndexFreshness
  ): MemoryIndexStatus {
    this.#assertOpen();
    const canonical = validateMemoryIndexDocument(document);
    const canonicalFreshness = validateFreshness(freshness);
    const canonicalExpected = validateFreshness(expectedCurrent);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertMutationBase(canonicalExpected);
      const existing = this.#database.prepare("SELECT 1 AS present FROM memory_documents WHERE id = ?").get(canonical.id);
      const beforeCount = Number((this.#database.prepare("SELECT count(*) AS count FROM memory_documents").get() as Row).count);
      if (!existing && beforeCount >= this.#maxDocuments) {
        throw new RangeError(`upsert exceeds ${this.#maxDocuments} unique documents`);
      }
      this.#database.prepare("DELETE FROM memory_documents WHERE id = ?").run(canonical.id);
      insertDocument(this.#database, canonical);
      const corpus = databaseFingerprint(this.#database, this.#maxDocuments);
      if (canonicalFreshness.sourceFingerprint !== corpus.fingerprint) {
        throw new Error(`source fingerprint mismatch: post-upsert corpus produces ${corpus.fingerprint}`);
      }
      if (!ftsParityValid(this.#database, corpus.count)) throw new Error("FTS/content parity failed during upsert");
      this.#database.prepare(`
        UPDATE memory_index_metadata SET source_generation = ?, source_fingerprint = ?,
          complete = 1, document_count = ?, updated_at = ? WHERE singleton = 1
      `).run(canonicalFreshness.sourceGeneration, canonicalFreshness.sourceFingerprint, corpus.count, new Date().toISOString());
      this.#database.exec("COMMIT");
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return this.status(canonicalFreshness);
  }

  remove(id: string, freshness: MemoryIndexFreshness, expectedCurrent: MemoryIndexFreshness): MemoryIndexStatus {
    this.#assertOpen();
    const canonicalId = identifier(id, "id");
    const canonicalFreshness = validateFreshness(freshness);
    const canonicalExpected = validateFreshness(expectedCurrent);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertMutationBase(canonicalExpected);
      this.#database.prepare("DELETE FROM memory_documents WHERE id = ?").run(canonicalId);
      const corpus = databaseFingerprint(this.#database, this.#maxDocuments);
      if (canonicalFreshness.sourceFingerprint !== corpus.fingerprint) {
        throw new Error(`source fingerprint mismatch: post-remove corpus produces ${corpus.fingerprint}`);
      }
      if (!ftsParityValid(this.#database, corpus.count)) throw new Error("FTS/content parity failed during remove");
      this.#database.prepare(`
        UPDATE memory_index_metadata SET source_generation = ?, source_fingerprint = ?,
          complete = 1, document_count = ?, updated_at = ? WHERE singleton = 1
      `).run(canonicalFreshness.sourceGeneration, canonicalFreshness.sourceFingerprint, corpus.count, new Date().toISOString());
      this.#database.exec("COMMIT");
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return this.status(canonicalFreshness);
  }

  search(query: MemoryIndexQuery): MemoryIndexResult[] {
    this.#assertOpen();
    if (!query || typeof query !== "object") throw new TypeError("memory index query must be an object");
    const match = memoryFtsQuery(query.text);
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MEMORY_INDEX_LIMITS.results) {
      throw new RangeError(`query limit must be from 1 through ${MEMORY_INDEX_LIMITS.results}`);
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MEMORY_INDEX_LIMITS.offset) {
      throw new RangeError(`query offset must be from 0 through ${MEMORY_INDEX_LIMITS.offset}`);
    }
    const expected: Partial<MemoryIndexFreshness> = {};
    if (query.expectedSourceGeneration !== undefined) expected.sourceGeneration = identifier(query.expectedSourceGeneration, "expectedSourceGeneration");
    if (query.expectedSourceFingerprint !== undefined) expected.sourceFingerprint = boundedString(query.expectedSourceFingerprint, "expectedSourceFingerprint", 512);
    if (this.status(expected).stale) throw new Error("memory index is incomplete or stale for the expected source generation");

    const clauses = ["memory_documents_fts MATCH ?"];
    const parameters: SQLInputValue[] = [match];
    const filter = (column: string, value: unknown, name: string) => {
      if (value === undefined) return;
      clauses.push(`d.${column} = ?`);
      parameters.push(identifier(value, name));
    };
    filter("namespace", query.namespace, "namespace");
    filter("kind", query.kind, "kind");
    if (query.scopeType !== undefined) {
      const scope = canonicalScope(query.scopeType, query.scopeId ?? (query.scopeType === "global" ? "" : undefined));
      clauses.push("d.scope_type = ?", "d.scope_id = ?");
      parameters.push(scope.scopeType, scope.scopeId);
    } else if (query.scopeId !== undefined) {
      throw new TypeError("scopeId filter requires scopeType");
    }
    if (query.atOrBefore !== undefined) { clauses.push("d.at <= ?"); parameters.push(timestamp(query.atOrBefore, "atOrBefore")); }
    if (query.atOrAfter !== undefined) { clauses.push("d.at >= ?"); parameters.push(timestamp(query.atOrAfter, "atOrAfter")); }
    if (query.tags !== undefined) {
      const tags = canonicalTags(query.tags);
      for (const tag of tags) {
        clauses.push("EXISTS (SELECT 1 FROM json_each(d.tags_json) WHERE value = ?)");
        parameters.push(tag);
      }
    }
    parameters.push(limit, offset);
    const rows = this.#database.prepare(`
      SELECT d.*, bm25(memory_documents_fts, 4.0, 2.0, 1.0, 0.5) AS rank
      FROM memory_documents_fts
      JOIN memory_documents d ON d.rowid = memory_documents_fts.rowid
      WHERE ${clauses.join(" AND ")}
      ORDER BY rank ASC, d.at DESC, d.id ASC
      LIMIT ? OFFSET ?
    `).all(...parameters) as Row[];
    return rows.map((row) => {
      const rank = Number(row.rank);
      if (!Number.isFinite(rank)) throw new Error("memory index returned a malformed rank");
      return { ...asDocument(row), rank };
    });
  }

  fingerprint(documents: Iterable<MemoryIndexDocument>): string {
    const entries: FingerprintEntry[] = [];
    const ids = new Set<string>();
    let count = 0;
    for (const document of documents) {
      if (count >= this.#maxDocuments) {
        throw new RangeError(`fingerprint exceeds ${this.#maxDocuments} documents`);
      }
      const canonical = validateMemoryIndexDocument(document);
      if (ids.has(canonical.id)) throw new TypeError(`fingerprint contains duplicate id: ${canonical.id}`);
      ids.add(canonical.id);
      entries.push(documentFingerprintEntry(canonical));
      count += 1;
    }
    return corpusFingerprint(entries);
  }

  #assertMutationBase(expected: MemoryIndexFreshness): void {
    const current = this.status();
    if (!current.complete) throw new Error("incremental mutation requires a complete memory index");
    if (current.sourceGeneration !== expected.sourceGeneration || current.sourceFingerprint !== expected.sourceFingerprint) {
      throw new Error("memory index freshness conflict; incremental mutation base is stale");
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    let failure: unknown;
    try { this.#database.close(); } catch (error) { failure = error; }
    try { releaseOwnerLock(this.#ownerLock); } catch (error) { if (failure === undefined) failure = error; }
    if (failure !== undefined) throw failure;
  }
}
