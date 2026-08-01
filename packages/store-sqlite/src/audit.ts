import { createHash, createHmac, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeAuditEvent, redactDurableValue, type AuditEvent } from "@odinn/protocol";

type Row = Record<string, any>;
type Integrity = { keyId: string; previous: string | null; signature: string };
type Keyring = { schemaVersion: number; current: string; keys: Record<string, string> };
export type AuditPage = { sequence: number; event: AuditEvent };

const MAX_PAGE = 10_000;
const bounded = (value: unknown, fallback = 500) => {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_PAGE) : fallback;
};
const ensureParent = (path: string) => mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

function unsigned(event: AuditEvent): AuditEvent {
  const copy = { ...event, data: { ...(event.data ?? {}) } };
  delete copy.data!.__odinnIntegrity;
  return copy;
}

function keyringFor(path: string): Keyring {
  ensureParent(path);
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Keyring;
    if (!parsed.current || !parsed.keys?.[parsed.current]) throw new Error("invalid audit keyring");
    return parsed;
  }
  const keyId = `key_${randomUUID()}`;
  const value: Keyring = { schemaVersion: 1, current: keyId, keys: { [keyId]: Buffer.from(randomUUID().replaceAll("-", ""), "hex").toString("base64") } };
  try { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); return value; }
  catch (error: any) { if (error?.code !== "EEXIST") throw error; return keyringFor(path); }
}

function writeKeyring(path: string, value: Keyring) { const temporary = `${path}.${process.pid}.${randomUUID()}`; writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); renameSync(temporary, path); chmodSync(path, 0o600); }

function openDatabase(path: string) {
  ensureParent(path);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), head_sequence INTEGER NOT NULL, head_signature TEXT, current_key_id TEXT, migration_complete INTEGER NOT NULL DEFAULT 0, retained_sequence INTEGER NOT NULL DEFAULT 0, retained_signature TEXT, updated_at TEXT NOT NULL);
    INSERT OR IGNORE INTO audit_state VALUES(1,0,NULL,NULL,0,0,NULL,'1970-01-01T00:00:00.000Z');
    CREATE TABLE IF NOT EXISTS audit_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, key_id TEXT, previous_signature TEXT, signature TEXT, event_json TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_signature ON audit_events(signature) WHERE signature IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_events(run_id,sequence);
    CREATE INDEX IF NOT EXISTS idx_audit_type_at ON audit_events(type,at,sequence);
    CREATE TABLE IF NOT EXISTS audit_runs(run_id TEXT PRIMARY KEY, summary_json TEXT NOT NULL, last_event_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_audit_runs_at ON audit_runs(last_event_at DESC,run_id);
    CREATE TABLE IF NOT EXISTS audit_subscriber_cursors(subscriber_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_segments(id INTEGER PRIMARY KEY AUTOINCREMENT, first_sequence INTEGER NOT NULL, last_sequence INTEGER, anchor_signature TEXT, final_signature TEXT, opened_at TEXT NOT NULL, closed_at TEXT);
    INSERT OR IGNORE INTO audit_segments(id,first_sequence,opened_at) VALUES(1,1,'1970-01-01T00:00:00.000Z');
    CREATE TABLE IF NOT EXISTS audit_archives(id INTEGER PRIMARY KEY AUTOINCREMENT, through_sequence INTEGER NOT NULL, path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, created_at TEXT NOT NULL, verified_at TEXT NOT NULL);
  `);
  return db;
}

function statusFor(event: AuditEvent, prior: Row | undefined) {
  const summary: Row = prior ? JSON.parse(String(prior.summary_json)) : { id: event.runId, status: "unknown", eventCount: 0 };
  Object.assign(summary, { id: event.runId, actor: event.actor, tool: event.tool ?? summary.tool, capability: event.capability ?? summary.capability, lastEventAt: event.at, eventCount: Number(summary.eventCount) + 1 });
  if (event.type === "task.policy" && event.decision === "deny") Object.assign(summary, { status: "denied", message: event.message });
  else if (["plan.started", "task.started"].includes(event.type)) Object.assign(summary, { status: "running", startedAt: event.at });
  else if (["plan.completed", "task.completed"].includes(event.type)) Object.assign(summary, { status: "completed", completedAt: event.at });
  else if (["plan.failed", "task.failed"].includes(event.type)) Object.assign(summary, { status: "failed", completedAt: event.at, message: event.message });
  else if (event.type === "task.approval_required") Object.assign(summary, { status: "awaiting_approval", message: event.message });
  else if (["task.blocked", "task.cancelled"].includes(event.type)) Object.assign(summary, { status: event.type.slice(5), completedAt: event.at, message: event.message });
  return summary;
}

export class SqliteAuditStore {
  readonly path: string;
  readonly keyringPath: string;
  readonly notifyPath: string;
  readonly db: DatabaseSync;
  private watcher?: FSWatcher;
  private listeners = new Set<(sequence: number) => void>();
  private closed = false;

  constructor(databasePath: string, { keyringPath = `${databasePath}.keys.json` }: { keyringPath?: string } = {}) {
    this.path = resolve(databasePath);
    this.keyringPath = resolve(keyringPath);
    this.notifyPath = `${this.path}.notify`;
    this.db = openDatabase(this.path);
    ensureParent(this.notifyPath);
    if (!existsSync(this.notifyPath)) writeFileSync(this.notifyPath, "0\n", { mode: 0o600 });
  }

  async append(value: unknown): Promise<AuditEvent> {
    const candidate = normalizeAuditEvent(value);
    const event = normalizeAuditEvent(redactDurableValue(candidate, { toolName: candidate.tool }));
    this.db.exec("BEGIN IMMEDIATE");
    let sequence = 0;
    let signed: AuditEvent;
    try {
      const keyring = keyringFor(this.keyringPath);
      const state = this.db.prepare("SELECT head_sequence,head_signature FROM audit_state WHERE singleton=1").get() as Row;
      const previous = state.head_signature ? String(state.head_signature) : null;
      const keyId = keyring.current;
      const signature = createHmac("sha256", Buffer.from(keyring.keys[keyId]!, "base64")).update(JSON.stringify({ event: unsigned(event), previous })).digest("base64url");
      signed = normalizeAuditEvent({ ...event, data: { ...(event.data ?? {}), __odinnIntegrity: { keyId, previous, signature } } });
      const result = this.db.prepare("INSERT INTO audit_events(run_id,actor,type,at,key_id,previous_signature,signature,event_json) VALUES(?,?,?,?,?,?,?,?)").run(signed.runId, signed.actor, signed.type, signed.at, keyId, previous, signature, JSON.stringify(signed));
      sequence = Number(result.lastInsertRowid);
      if (sequence !== Number(state.head_sequence) + 1) throw new Error("non-contiguous audit sequence");
      this.db.prepare("UPDATE audit_state SET head_sequence=?,head_signature=?,current_key_id=?,updated_at=? WHERE singleton=1").run(sequence, signature, keyId, new Date().toISOString());
      const prior = this.db.prepare("SELECT summary_json FROM audit_runs WHERE run_id=?").get(signed.runId) as Row | undefined;
      const summary = statusFor(signed, prior);
      this.db.prepare("INSERT INTO audit_runs VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET summary_json=excluded.summary_json,last_event_at=excluded.last_event_at").run(signed.runId, JSON.stringify(summary), signed.at);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.signal(sequence);
    return signed!;
  }

  async readPage({ afterSequence = 0, limit = 500 }: { afterSequence?: number; limit?: number } = {}): Promise<AuditPage[]> {
    const rows = this.db.prepare("SELECT sequence,event_json FROM audit_events WHERE sequence>? ORDER BY sequence LIMIT ?").all(Math.max(0, Number(afterSequence) || 0), bounded(limit)) as Row[];
    return rows.map((row) => ({ sequence: Number(row.sequence), event: normalizeAuditEvent(JSON.parse(String(row.event_json))) }));
  }
  async readSince(sequence = 0, limit = 500) { return this.readPage({ afterSequence: sequence, limit }); }
  async readAll() { const result: AuditEvent[] = []; let cursor = 0; for (;;) { const page = await this.readPage({ afterSequence: cursor, limit: MAX_PAGE }); if (!page.length) return result; result.push(...page.map((item) => item.event)); cursor = page.at(-1)!.sequence; } }
  async readRuns() { return (this.db.prepare("SELECT summary_json FROM audit_runs ORDER BY last_event_at DESC,run_id").all() as Row[]).map((row) => JSON.parse(String(row.summary_json))); }
  async readRun(id: string) { const row = this.db.prepare("SELECT summary_json FROM audit_runs WHERE run_id=?").get(id) as Row | undefined; if (!row) return undefined; const events = (this.db.prepare("SELECT event_json FROM audit_events WHERE run_id=? ORDER BY sequence").all(id) as Row[]).map((item) => normalizeAuditEvent(JSON.parse(String(item.event_json)))); return { ...JSON.parse(String(row.summary_json)), events }; }
  async getCursor(id: string) { return Number((this.db.prepare("SELECT sequence FROM audit_subscriber_cursors WHERE subscriber_id=?").get(id) as Row | undefined)?.sequence ?? 0); }
  async ackCursor(id: string, sequence: number) { this.db.prepare("INSERT INTO audit_subscriber_cursors VALUES(?,?,?) ON CONFLICT(subscriber_id) DO UPDATE SET sequence=MAX(sequence,excluded.sequence),updated_at=excluded.updated_at").run(id, Math.max(0, sequence), new Date().toISOString()); }

  subscribe(listener: (sequence: number) => void) {
    this.listeners.add(listener);
    if (!this.watcher) this.watcher = watch(dirname(this.notifyPath), (_event, filename) => { if (filename && String(filename) !== basename(this.notifyPath)) return; const sequence = Number.parseInt(readFileSync(this.notifyPath, "utf8"), 10); for (const item of this.listeners) item(Number.isFinite(sequence) ? sequence : 0); });
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { this.watcher?.close(); this.watcher = undefined; } };
  }
  private signal(sequence: number) { const temporary = `${this.notifyPath}.${process.pid}.${randomUUID()}`; writeFileSync(temporary, `${sequence}\n`, { mode: 0o600 }); renameSync(temporary, this.notifyPath); for (const listener of this.listeners) listener(sequence); }

  async verifyIntegrity({ allowUnsigned = true } = {}) {
    const keyring = keyringFor(this.keyringPath); const retained = this.db.prepare("SELECT retained_sequence,retained_signature FROM audit_state WHERE singleton=1").get() as Row; let cursor = Number(retained.retained_sequence); let previous: string | null = retained.retained_signature ?? null; let unsignedCount = 0; const failures: Row[] = [];
    if (cursor && !this.verifiedArchive(cursor)) failures.push({ runId: "", reason: "retained audit archive missing or modified" });
    for (;;) { const page = await this.readPage({ afterSequence: cursor, limit: 2_000 }); if (!page.length) break; for (const item of page) { if (item.sequence !== cursor + 1) failures.push({ runId: item.event.runId, reason: "audit sequence gap or reorder" }); cursor = item.sequence; const integrity = item.event.data?.__odinnIntegrity as Integrity | undefined; if (!integrity) { unsignedCount++; if (!allowUnsigned) failures.push({ runId: item.event.runId, reason: "unsigned event" }); previous = null; continue; } const secret = keyring.keys[integrity.keyId]; const expected = secret && createHmac("sha256", Buffer.from(secret, "base64")).update(JSON.stringify({ event: unsigned(item.event), previous: integrity.previous })).digest("base64url"); if (!secret || integrity.previous !== previous || expected !== integrity.signature) failures.push({ runId: item.event.runId, reason: "audit integrity mismatch" }); previous = integrity.signature; } }
    const head = this.db.prepare("SELECT head_sequence,head_signature,current_key_id FROM audit_state WHERE singleton=1").get() as Row;
    if (cursor !== Number(head.head_sequence) || previous !== (head.head_signature ?? null)) failures.push({ runId: "", reason: "audit head mismatch" });
    return { valid: !failures.length, events: cursor, unsigned: unsignedCount, failures, currentKeyId: head.current_key_id ?? keyring.current, retiredKeyIds: Object.keys(keyring.keys).filter((id) => id !== (head.current_key_id ?? keyring.current)) };
  }

  async rotateKey() { this.db.exec("BEGIN IMMEDIATE"); try { const keyring = keyringFor(this.keyringPath); const keyId = `key_${randomUUID()}`; keyring.keys[keyId] = Buffer.from(randomUUID().replaceAll("-", ""), "hex").toString("base64"); keyring.current = keyId; writeKeyring(this.keyringPath, keyring); this.db.prepare("UPDATE audit_state SET current_key_id=?,updated_at=? WHERE singleton=1").run(keyId, new Date().toISOString()); this.db.exec("COMMIT"); return { keyId, retiredKeyIds: Object.keys(keyring.keys).filter((id) => id !== keyId) }; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  rotateSegment() { this.db.exec("BEGIN IMMEDIATE"); try { const head = this.db.prepare("SELECT head_sequence,head_signature FROM audit_state WHERE singleton=1").get() as Row; this.db.prepare("UPDATE audit_segments SET last_sequence=?,final_signature=?,closed_at=? WHERE closed_at IS NULL").run(head.head_sequence, head.head_signature, new Date().toISOString()); this.db.prepare("INSERT INTO audit_segments(first_sequence,anchor_signature,opened_at) VALUES(?,?,?)").run(Number(head.head_sequence) + 1, head.head_signature, new Date().toISOString()); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  exportArchive(path: string, throughSequence?: number) { const head = this.db.prepare("SELECT head_sequence FROM audit_state WHERE singleton=1").get() as Row; const through = Math.min(Number(throughSequence ?? head.head_sequence), Number(head.head_sequence)); const rows = this.db.prepare("SELECT sequence,event_json FROM audit_events WHERE sequence<=? ORDER BY sequence").all(through) as Row[]; const content = rows.map((row) => JSON.stringify({ sequence: Number(row.sequence), event: JSON.parse(String(row.event_json)) })).join("\n") + (rows.length ? "\n" : ""); ensureParent(path); writeFileSync(path, content, { mode: 0o600, flag: "wx" }); const sha256 = createHash("sha256").update(content).digest("hex"); const now = new Date().toISOString(); const keyring = keyringFor(this.keyringPath); const manifest = { schemaVersion: 1, path: resolve(path), throughSequence: through, events: rows.length, sha256, createdAt: now, keyId: keyring.current }; const signature = createHmac("sha256", Buffer.from(keyring.keys[keyring.current]!, "base64")).update(JSON.stringify(manifest)).digest("base64url"); writeFileSync(`${path}.manifest.json`, `${JSON.stringify({ ...manifest, signature }, null, 2)}\n`, { mode: 0o600, flag: "wx" }); this.db.prepare("INSERT INTO audit_archives(through_sequence,path,sha256,created_at,verified_at) VALUES(?,?,?,?,?)").run(through, resolve(path), sha256, now, now); return { ...manifest, signature }; }
  private verifiedArchive(throughSequence: number) { const archive = this.db.prepare("SELECT * FROM audit_archives WHERE through_sequence>=? ORDER BY through_sequence LIMIT 1").get(throughSequence) as Row | undefined; if (!archive) return undefined; const actual = createHash("sha256").update(readFileSync(String(archive.path))).digest("hex"); if (actual !== archive.sha256) return undefined; const manifest = JSON.parse(readFileSync(`${archive.path}.manifest.json`, "utf8")) as Row; const { signature, ...unsignedManifest } = manifest; const keyring = keyringFor(this.keyringPath); const secret = keyring.keys[String(manifest.keyId)]; const expected = secret && createHmac("sha256", Buffer.from(secret, "base64")).update(JSON.stringify(unsignedManifest)).digest("base64url"); return expected === signature && manifest.sha256 === actual && Number(manifest.throughSequence) >= throughSequence ? archive : undefined; }
  applyRetention(throughSequence: number) { const archive = this.verifiedArchive(throughSequence); if (!archive) throw new Error("verified archive required before audit retention"); const boundary = this.db.prepare("SELECT signature FROM audit_events WHERE sequence=?").get(throughSequence) as Row | undefined; if (!boundary?.signature) throw new Error("retention boundary must reference an online signed event"); this.db.exec("BEGIN IMMEDIATE"); try { const changes = this.db.prepare("DELETE FROM audit_events WHERE sequence<=?").run(throughSequence).changes; this.db.prepare("UPDATE audit_state SET retained_sequence=?,retained_signature=?,updated_at=? WHERE singleton=1").run(throughSequence,boundary.signature,new Date().toISOString()); this.db.exec("COMMIT"); return changes; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  backup(destination = `${this.path}.bak`) { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); ensureParent(destination); copyFileSync(this.path, destination); chmodSync(destination, 0o600); return destination; }
  close() { if (this.closed) return; this.closed = true; this.watcher?.close(); this.listeners.clear(); this.db.close(); }
}

export function auditMigrationStatus(databasePath: string) { if (!existsSync(databasePath)) return undefined; const db = openDatabase(resolve(databasePath)); try { const row = db.prepare("SELECT migration_complete,head_sequence AS events FROM audit_state WHERE singleton=1").get() as Row; return { complete: Boolean(row.migration_complete || row.events), events: Number(row.events) }; } finally { db.close(); } }

export function migrateLegacyAuditToSqlite({ legacyPath, databasePath, keyringPath = `${legacyPath}.keys.json` }: { legacyPath: string; databasePath: string; keyringPath?: string }) {
  const source = resolve(legacyPath); if (!existsSync(source)) return { migrated: false, events: 0 };
  const store = new SqliteAuditStore(databasePath, { keyringPath }); const count = Number((store.db.prepare("SELECT count(*) AS count FROM audit_events").get() as Row).count);
  if (count) { store.close(); return { migrated: false, events: count }; }
  const backup = `${source}.migration.bak`; if (!existsSync(backup)) { copyFileSync(source, backup); chmodSync(backup, 0o600); }
  const before = statSync(source); const descriptor = openSync(backup, "r"); const buffer = Buffer.alloc(64 * 1024); let carry = ""; let events = 0; let position = 0;
  store.db.exec("BEGIN IMMEDIATE");
  try {
    for (;;) { const bytes = readSync(descriptor, buffer, 0, buffer.length, position); if (!bytes) break; position += bytes; const parts = (carry + buffer.subarray(0, bytes).toString("utf8")).split("\n"); carry = parts.pop()!; for (const line of parts) if (line.trim()) { const event = normalizeAuditEvent(JSON.parse(line)); const integrity = event.data?.__odinnIntegrity as Integrity | undefined; const result = store.db.prepare("INSERT INTO audit_events(run_id,actor,type,at,key_id,previous_signature,signature,event_json) VALUES(?,?,?,?,?,?,?,?)").run(event.runId,event.actor,event.type,event.at,integrity?.keyId ?? null,integrity?.previous ?? null,integrity?.signature ?? null,JSON.stringify(event)); events = Number(result.lastInsertRowid); const prior = store.db.prepare("SELECT summary_json FROM audit_runs WHERE run_id=?").get(event.runId) as Row | undefined; const summary = statusFor(event, prior); store.db.prepare("INSERT INTO audit_runs VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET summary_json=excluded.summary_json,last_event_at=excluded.last_event_at").run(event.runId,JSON.stringify(summary),event.at); } }
    if (carry.trim()) { const event = normalizeAuditEvent(JSON.parse(carry)); const integrity = event.data?.__odinnIntegrity as Integrity | undefined; const result = store.db.prepare("INSERT INTO audit_events(run_id,actor,type,at,key_id,previous_signature,signature,event_json) VALUES(?,?,?,?,?,?,?,?)").run(event.runId,event.actor,event.type,event.at,integrity?.keyId ?? null,integrity?.previous ?? null,integrity?.signature ?? null,JSON.stringify(event)); events = Number(result.lastInsertRowid); const prior = store.db.prepare("SELECT summary_json FROM audit_runs WHERE run_id=?").get(event.runId) as Row | undefined; const summary = statusFor(event, prior); store.db.prepare("INSERT INTO audit_runs VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET summary_json=excluded.summary_json,last_event_at=excluded.last_event_at").run(event.runId,JSON.stringify(summary),event.at); }
    const last = store.db.prepare("SELECT signature,key_id FROM audit_events ORDER BY sequence DESC LIMIT 1").get() as Row | undefined; store.db.prepare("UPDATE audit_state SET head_sequence=?,head_signature=?,current_key_id=?,migration_complete=1,updated_at=? WHERE singleton=1").run(events,last?.signature ?? null,last?.key_id ?? keyringFor(keyringPath).current,new Date().toISOString());
    const after = statSync(source); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("legacy audit journal changed during migration"); store.db.exec("COMMIT");
  } catch (error) { store.db.exec("ROLLBACK"); throw error; } finally { closeSync(descriptor); store.close(); }
  return { migrated: true, backup, events };
}

export function rollbackLegacyAuditMigration({ legacyPath, databasePath }: { legacyPath: string; databasePath: string }) {
  const source = resolve(legacyPath); const database = resolve(databasePath); const backup = `${source}.migration.bak`;
  if (!existsSync(backup)) throw new Error("legacy audit migration backup is missing");
  const token = `${Date.now()}-${randomUUID()}`; const displacedSource = `${source}.rollback-displaced-${token}`; const displacedDatabase = `${database}.rollback-${token}`;
  if (existsSync(source)) copyFileSync(source, displacedSource);
  const temporary = `${source}.rollback-${token}.tmp`; copyFileSync(backup, temporary); chmodSync(temporary, 0o600); renameSync(temporary, source);
  if (existsSync(database)) renameSync(database, displacedDatabase);
  for (const suffix of ["-wal", "-shm", ".notify"]) if (existsSync(`${database}${suffix}`)) renameSync(`${database}${suffix}`, `${displacedDatabase}${suffix}`);
  return { restored: source, displacedSource: existsSync(displacedSource) ? displacedSource : undefined, displacedDatabase: existsSync(displacedDatabase) ? displacedDatabase : undefined };
}
