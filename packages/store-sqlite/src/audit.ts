import { createHash, createHmac, randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, watch, writeFileSync, writeSync, type FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StringDecoder } from "node:string_decoder";
import { normalizeAuditEvent, redactDurableValue, type AuditEvent } from "@odinn/protocol";

type Row = Record<string, any>;
type Integrity = { keyId: string; previous: string | null; signature: string };
type Keyring = { schemaVersion: number; current: string; keys: Record<string, string> };
export type AuditPage = { sequence: number; event: AuditEvent; keyId?: string; previousSignature?: string | null; signature?: string };

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
function writeFully(descriptor: number, value: Buffer) { let offset = 0; while (offset < value.length) offset += writeSync(descriptor, value, offset, value.length - offset); }

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
    CREATE TABLE IF NOT EXISTS audit_segment_integrity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), key_id TEXT NOT NULL, signature TEXT NOT NULL);
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

function legacySegmentLedgerEligible(db: DatabaseSync, keyringPath: string) {
  const state = db.prepare("SELECT * FROM audit_state WHERE singleton=1").get() as Row; if (Number(state.retained_sequence) !== 0) return false; const keyring = keyringFor(keyringPath); let cursor = 0; let previous: string | null = null;
  const events = db.prepare("SELECT sequence,event_json,key_id,previous_signature,signature FROM audit_events ORDER BY sequence").all() as Row[];
  for (const row of events) { const event = normalizeAuditEvent(JSON.parse(String(row.event_json))); const integrity = event.data?.__odinnIntegrity as Integrity | undefined; const secret = integrity && keyring.keys[integrity.keyId]; const expected = secret && createHmac("sha256", Buffer.from(secret, "base64")).update(JSON.stringify({ event: unsigned(event), previous: integrity!.previous })).digest("base64url"); if (Number(row.sequence) !== cursor + 1 || !integrity || integrity.previous !== previous || expected !== integrity.signature || row.key_id !== integrity.keyId || row.previous_signature !== integrity.previous || row.signature !== integrity.signature) return false; cursor = Number(row.sequence); previous = integrity.signature; }
  if (cursor !== Number(state.head_sequence) || previous !== (state.head_signature ?? null)) return false; const segments = db.prepare("SELECT * FROM audit_segments ORDER BY id").all() as Row[]; let expectedFirst = 1; let priorFinal: string | null = null; let open = 0;
  for (const segment of segments) { const first = Number(segment.first_sequence); const last = segment.last_sequence === null ? undefined : Number(segment.last_sequence); if (first !== expectedFirst || (segment.anchor_signature ?? null) !== priorFinal) return false; if (last === undefined) { open++; if (first > cursor + 1) return false; } else { const boundary = db.prepare("SELECT signature FROM audit_events WHERE sequence=?").get(last) as Row | undefined; if (last < first - 1 || boundary?.signature !== segment.final_signature) return false; expectedFirst = last + 1; priorFinal = segment.final_signature ?? null; } }
  return segments.length > 0 && open === 1;
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
    const databaseExisted = existsSync(this.path);
    this.db = openDatabase(this.path);
    const schemaVersion = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    if (!databaseExisted) { this.signSegmentInventory(true); this.db.exec("PRAGMA user_version=1"); }
    else if (schemaVersion < 1) { if (!legacySegmentLedgerEligible(this.db, this.keyringPath)) { this.db.close(); throw new Error("existing audit segment topology is not eligible for authenticated-ledger migration"); } this.db.exec("BEGIN IMMEDIATE"); try { this.signSegmentInventory(true); this.db.exec("PRAGMA user_version=1; COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); this.db.close(); throw error; } }
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
    const rows = this.db.prepare("SELECT sequence,event_json,key_id,previous_signature,signature FROM audit_events WHERE sequence>? ORDER BY sequence LIMIT ?").all(Math.max(0, Number(afterSequence) || 0), bounded(limit)) as Row[];
    return rows.map((row) => ({ sequence: Number(row.sequence), event: normalizeAuditEvent(JSON.parse(String(row.event_json))), keyId: row.key_id ?? undefined, previousSignature: row.previous_signature ?? null, signature: row.signature ?? undefined }));
  }
  async readSince(sequence = 0, limit = 500) { return this.readPage({ afterSequence: sequence, limit }); }
  async readAll() { const result: AuditEvent[] = []; let cursor = 0; for (;;) { const page = await this.readPage({ afterSequence: cursor, limit: MAX_PAGE }); if (!page.length) return result; result.push(...page.map((item) => item.event)); cursor = page.at(-1)!.sequence; } }
  async readRuns() { return (this.db.prepare("SELECT summary_json FROM audit_runs ORDER BY last_event_at DESC,run_id").all() as Row[]).map((row) => JSON.parse(String(row.summary_json))); }
  async readRun(id: string) { const row = this.db.prepare("SELECT summary_json FROM audit_runs WHERE run_id=?").get(id) as Row | undefined; if (!row) return undefined; const events = (this.db.prepare("SELECT event_json FROM audit_events WHERE run_id=? ORDER BY sequence").all(id) as Row[]).map((item) => normalizeAuditEvent(JSON.parse(String(item.event_json)))); return { ...JSON.parse(String(row.summary_json)), events }; }
  async getCursor(id: string) { return Number((this.db.prepare("SELECT sequence FROM audit_subscriber_cursors WHERE subscriber_id=?").get(id) as Row | undefined)?.sequence ?? 0); }
  async ackCursor(id: string, sequence: number) { const now = new Date(); this.db.exec("BEGIN IMMEDIATE"); try { const head = Number((this.db.prepare("SELECT head_sequence FROM audit_state WHERE singleton=1").get() as Row).head_sequence); if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > head) throw new Error("audit subscriber cursor is outside the durable audit range"); this.db.prepare("DELETE FROM audit_subscriber_cursors WHERE updated_at<?").run(new Date(now.getTime() - 90 * 24 * 60 * 60 * 1_000).toISOString()); const exists = this.db.prepare("SELECT 1 FROM audit_subscriber_cursors WHERE subscriber_id=?").get(id); if (!exists && Number((this.db.prepare("SELECT count(*) AS count FROM audit_subscriber_cursors").get() as Row).count) >= 10_000) throw new Error("audit subscriber cursor capacity reached"); this.db.prepare("INSERT INTO audit_subscriber_cursors VALUES(?,?,?) ON CONFLICT(subscriber_id) DO UPDATE SET sequence=MAX(sequence,excluded.sequence),updated_at=excluded.updated_at").run(id, sequence, now.toISOString()); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; } }

  subscribe(listener: (sequence: number) => void) {
    this.listeners.add(listener);
    if (!this.watcher) this.watcher = watch(dirname(this.notifyPath), (_event, filename) => { if (filename && String(filename) !== basename(this.notifyPath)) return; const sequence = Number.parseInt(readFileSync(this.notifyPath, "utf8"), 10); for (const item of this.listeners) item(Number.isFinite(sequence) ? sequence : 0); });
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { this.watcher?.close(); this.watcher = undefined; } };
  }
  private signal(sequence: number) { for (const listener of this.listeners) listener(sequence); try { writeFileSync(this.notifyPath, `${sequence}\n`, { mode: 0o600 }); } catch { /* advisory: durable cursor recovery remains authoritative */ } }

  async verifyIntegrity({ allowUnsigned = true } = {}) {
    const keyring = keyringFor(this.keyringPath); const retained = this.db.prepare("SELECT retained_sequence,retained_signature FROM audit_state WHERE singleton=1").get() as Row; const retainedSequence = Number(retained.retained_sequence); let cursor = retainedSequence; let previous: string | null = retained.retained_signature ?? null; let unsignedCount = 0; const failures: Row[] = []; const onlineRotations: Row[] = [];
    const retainedArchive = retainedSequence ? this.verifiedArchive(retainedSequence) : undefined; if (retainedSequence && !retainedArchive) failures.push({ runId: "", reason: "retained audit archive missing or modified" });
    for (;;) { const page = await this.readPage({ afterSequence: cursor, limit: 2_000 }); if (!page.length) break; for (const item of page) { if (item.sequence !== cursor + 1) failures.push({ runId: item.event.runId, reason: "audit sequence gap or reorder" }); cursor = item.sequence; if (item.event.type === "audit.segment.rotated") onlineRotations.push(item.event.data?.segmentRotation as Row); const integrity = item.event.data?.__odinnIntegrity as Integrity | undefined; if (!integrity) { unsignedCount++; if (!allowUnsigned) failures.push({ runId: item.event.runId, reason: "unsigned event" }); if (item.keyId || item.previousSignature || item.signature) failures.push({ runId: item.event.runId, reason: "audit materialized integrity mismatch" }); previous = null; continue; } const secret = keyring.keys[integrity.keyId]; const expected = secret && createHmac("sha256", Buffer.from(secret, "base64")).update(JSON.stringify({ event: unsigned(item.event), previous: integrity.previous })).digest("base64url"); if (!secret || integrity.previous !== previous || expected !== integrity.signature) failures.push({ runId: item.event.runId, reason: "audit integrity mismatch" }); if (item.keyId !== integrity.keyId || item.previousSignature !== integrity.previous || item.signature !== integrity.signature) failures.push({ runId: item.event.runId, reason: "audit materialized integrity mismatch" }); previous = integrity.signature; } }
    const head = this.db.prepare("SELECT head_sequence,head_signature,current_key_id FROM audit_state WHERE singleton=1").get() as Row;
    if (cursor !== Number(head.head_sequence) || previous !== (head.head_signature ?? null)) failures.push({ runId: "", reason: "audit head mismatch" });
    if (head.current_key_id && !keyring.keys[String(head.current_key_id)]) failures.push({ runId: "", reason: "audit current key is unavailable" });
    const segments = this.db.prepare("SELECT * FROM audit_segments ORDER BY id").all() as Row[]; if (!this.segmentInventoryValid(segments)) failures.push({ runId: "", reason: "audit segment ledger integrity mismatch" }); const retainedSegments = archiveSegments(segments, retainedSequence); const retainedBoundaries = new Set(retainedSegments.map((segment) => segment.lastSequence)); const archived = retainedArchive ? verifyArchivedHistory(String(retainedArchive.path), retainedSequence, keyring, retainedBoundaries) : { valid: retainedSequence === 0, lastSignature: null, boundaries: new Map<number, string>(), rotations: [] as Row[] }; if (!archived.valid || (retainedSequence > 0 && archived.lastSignature !== retained.retained_signature)) failures.push({ runId: "", reason: "retained audit archive chain mismatch" }); if (retainedArchive && JSON.stringify(retainedArchive.manifest.segments) !== JSON.stringify(retainedSegments)) failures.push({ runId: "", reason: "retained audit segment inventory mismatch" }); if (JSON.stringify([...archived.rotations, ...onlineRotations]) !== JSON.stringify(segmentRotations(segments))) failures.push({ runId: "", reason: "audit segment rotation history mismatch" }); let expectedFirst = 1; let priorFinal: string | null = null; let openSegments = 0;
    if (!segments.length) failures.push({ runId: "", reason: "audit segment metadata missing" });
    for (const segment of segments) { const first = Number(segment.first_sequence); const last = segment.last_sequence === null ? undefined : Number(segment.last_sequence); if (first !== expectedFirst || (segment.anchor_signature ?? null) !== priorFinal) failures.push({ runId: "", reason: "audit segment order or anchor mismatch" }); if (last === undefined) { openSegments++; if (first > Number(head.head_sequence) + 1) failures.push({ runId: "", reason: "audit active segment boundary mismatch" }); } else { if (last < first - 1) failures.push({ runId: "", reason: "audit segment range mismatch" }); const boundary = this.db.prepare("SELECT signature FROM audit_events WHERE sequence=?").get(last) as Row | undefined; const knownFinal = boundary?.signature ?? archived.boundaries.get(last); if (knownFinal !== segment.final_signature) failures.push({ runId: "", reason: "audit segment final signature mismatch" }); expectedFirst = last + 1; priorFinal = segment.final_signature ?? null; } }
    if (openSegments !== 1) failures.push({ runId: "", reason: "audit active segment count mismatch" });
    return { valid: !failures.length, events: cursor, unsigned: unsignedCount, failures, currentKeyId: head.current_key_id ?? keyring.current, retiredKeyIds: Object.keys(keyring.keys).filter((id) => id !== (head.current_key_id ?? keyring.current)) };
  }

  async rotateKey() { this.db.exec("BEGIN IMMEDIATE"); try { const keyring = keyringFor(this.keyringPath); const keyId = `key_${randomUUID()}`; keyring.keys[keyId] = Buffer.from(randomUUID().replaceAll("-", ""), "hex").toString("base64"); keyring.current = keyId; writeKeyring(this.keyringPath, keyring); this.db.prepare("UPDATE audit_state SET current_key_id=?,updated_at=? WHERE singleton=1").run(keyId, new Date().toISOString()); this.db.exec("COMMIT"); return { keyId, retiredKeyIds: Object.keys(keyring.keys).filter((id) => id !== keyId) }; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  rotateSegment() { this.db.exec("BEGIN IMMEDIATE"); let sequence = 0; try { if (!this.segmentInventoryValid()) throw new Error("audit segment ledger integrity verification required before rotation"); const head = this.db.prepare("SELECT head_sequence,head_signature FROM audit_state WHERE singleton=1").get() as Row; const now = new Date().toISOString(); this.db.prepare("UPDATE audit_segments SET last_sequence=?,final_signature=?,closed_at=? WHERE closed_at IS NULL").run(head.head_sequence, head.head_signature, now); this.db.prepare("INSERT INTO audit_segments(first_sequence,anchor_signature,opened_at) VALUES(?,?,?)").run(Number(head.head_sequence) + 1, head.head_signature, now); const segments = this.db.prepare("SELECT * FROM audit_segments ORDER BY id DESC LIMIT 2").all() as Row[]; const opened = segments[0]!; const closed = segments[1]!; const candidate = normalizeAuditEvent({ at: now, runId: `audit-segment-${opened.id}`, type: "audit.segment.rotated", actor: "audit-store", tool: "audit.rotate", capability: "audit.integrity", decision: "allow", data: { segmentRotation: rotationRecord(closed, opened) } }); const keyring = keyringFor(this.keyringPath); const keyId = keyring.current; const previous = head.head_signature ?? null; const signature = createHmac("sha256", Buffer.from(keyring.keys[keyId]!, "base64")).update(JSON.stringify({ event: unsigned(candidate), previous })).digest("base64url"); const event = normalizeAuditEvent({ ...candidate, data: { ...candidate.data, __odinnIntegrity: { keyId, previous, signature } } }); const result = this.db.prepare("INSERT INTO audit_events(run_id,actor,type,at,key_id,previous_signature,signature,event_json) VALUES(?,?,?,?,?,?,?,?)").run(event.runId, event.actor, event.type, event.at, keyId, previous, signature, JSON.stringify(event)); sequence = Number(result.lastInsertRowid); if (sequence !== Number(head.head_sequence) + 1) throw new Error("non-contiguous audit sequence"); this.db.prepare("UPDATE audit_state SET head_sequence=?,head_signature=?,current_key_id=?,updated_at=? WHERE singleton=1").run(sequence, signature, keyId, now); this.db.prepare("INSERT INTO audit_runs VALUES(?,?,?)").run(event.runId, JSON.stringify(statusFor(event, undefined)), event.at); this.signSegmentInventory(false); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; } this.signal(sequence); }
  async exportArchive(path: string, throughSequence?: number) {
    const archivePath = resolve(path); const manifestPath = `${archivePath}.manifest.json`; let archiveCreated = false; let manifestCreated = false; this.db.exec("BEGIN IMMEDIATE");
    try {
      const verification = await this.verifyIntegrity({ allowUnsigned: false }); if (!verification.valid) throw new Error("audit integrity verification required before archive export");
      const head = this.db.prepare("SELECT head_sequence,retained_sequence FROM audit_state WHERE singleton=1").get() as Row; const retained = Number(head.retained_sequence); const through = Math.min(Number(throughSequence ?? head.head_sequence), Number(head.head_sequence)); if (through <= retained) throw new Error("archive boundary must advance retained audit history"); const prior = retained ? this.verifiedArchive(retained) : undefined; if (retained && !prior) throw new Error("prior retained audit archive is unavailable"); ensureParent(archivePath); const output = openSync(archivePath, "wx", 0o600); archiveCreated = true; const hash = createHash("sha256");
      try { if (prior) { const input = openSync(String(prior.path), "r"); const buffer = Buffer.alloc(64 * 1024); try { for (;;) { const bytes = readSync(input, buffer, 0, buffer.length, null); if (!bytes) break; const chunk = buffer.subarray(0, bytes); writeFully(output, chunk); hash.update(chunk); } } finally { closeSync(input); } } let cursor = retained; for (;;) { const rows = this.db.prepare("SELECT sequence,event_json FROM audit_events WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT 2000").all(cursor, through) as Row[]; if (!rows.length) break; for (const row of rows) { const line = Buffer.from(`${JSON.stringify({ sequence: Number(row.sequence), event: JSON.parse(String(row.event_json)) })}\n`); writeFully(output, line); hash.update(line); cursor = Number(row.sequence); } } if (cursor !== through) throw new Error("archive range is incomplete"); fsyncSync(output); } finally { closeSync(output); }
      const sha256 = hash.digest("hex"); const now = new Date().toISOString(); const keyring = keyringFor(this.keyringPath); const segments = archiveSegments(this.db.prepare("SELECT * FROM audit_segments ORDER BY id").all() as Row[], through); const manifest = { schemaVersion: 1, path: archivePath, firstSequence: 1, throughSequence: through, events: through, sha256, createdAt: now, keyId: keyring.current, segments }; const signature = createHmac("sha256", Buffer.from(keyring.keys[keyring.current]!, "base64")).update(JSON.stringify(manifest)).digest("base64url"); writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, signature }, null, 2)}\n`, { mode: 0o600, flag: "wx" }); manifestCreated = true; this.db.prepare("INSERT INTO audit_archives(through_sequence,path,sha256,created_at,verified_at) VALUES(?,?,?,?,?)").run(through, archivePath, sha256, now, now); this.db.exec("COMMIT"); return { ...manifest, signature };
    } catch (error) { this.db.exec("ROLLBACK"); if (archiveCreated) rmSync(archivePath, { force: true }); if (manifestCreated) rmSync(manifestPath, { force: true }); throw error; }
  }
  private verifiedArchive(throughSequence: number): Row | undefined { const archive = this.db.prepare("SELECT * FROM audit_archives WHERE through_sequence=? ORDER BY id DESC LIMIT 1").get(throughSequence) as Row | undefined; if (!archive) return undefined; const actual = fileSha256(String(archive.path)); if (actual !== archive.sha256) return undefined; const manifest = JSON.parse(readFileSync(`${archive.path}.manifest.json`, "utf8")) as Row; const { signature, ...unsignedManifest } = manifest; const keyring = keyringFor(this.keyringPath); const secret = keyring.keys[String(manifest.keyId)]; const expected = secret && createHmac("sha256", Buffer.from(secret, "base64")).update(JSON.stringify(unsignedManifest)).digest("base64url"); return expected === signature && manifest.sha256 === actual && Array.isArray(manifest.segments) && Number(manifest.firstSequence) === 1 && Number(manifest.events) === throughSequence && Number(manifest.throughSequence) === throughSequence ? { ...archive, manifest } : undefined; }
  async applyRetention(throughSequence: number) { const verification = await this.verifyIntegrity({ allowUnsigned: false }); if (!verification.valid) throw new Error("audit integrity verification required before retention"); this.db.exec("BEGIN IMMEDIATE"); try { const state = this.db.prepare("SELECT retained_sequence,head_sequence FROM audit_state WHERE singleton=1").get() as Row; const retained = Number(state.retained_sequence); if (!Number.isSafeInteger(throughSequence) || throughSequence <= retained || throughSequence > Number(state.head_sequence)) throw new Error("retention boundary must advance online audit history"); const archive = this.verifiedArchive(throughSequence); if (!archive) throw new Error("verified archive required before audit retention"); const segments = archiveSegments(this.db.prepare("SELECT * FROM audit_segments ORDER BY id").all() as Row[], throughSequence); if (JSON.stringify(archive.manifest.segments) !== JSON.stringify(segments)) throw new Error("verified archive segment inventory does not match the retention boundary"); const boundary = this.db.prepare("SELECT signature,event_json FROM audit_events WHERE sequence=?").get(throughSequence) as Row | undefined; const integrity = boundary ? (normalizeAuditEvent(JSON.parse(String(boundary.event_json))).data?.__odinnIntegrity as Integrity | undefined) : undefined; if (!integrity?.signature || boundary?.signature !== integrity.signature) throw new Error("retention boundary must reference a verified signed event"); const changes = this.db.prepare("DELETE FROM audit_events WHERE sequence>? AND sequence<=?").run(retained, throughSequence).changes; if (Number(changes) !== throughSequence - retained) throw new Error("retention range is incomplete"); this.db.prepare("UPDATE audit_state SET retained_sequence=?,retained_signature=?,updated_at=? WHERE singleton=1").run(throughSequence,integrity.signature,new Date().toISOString()); this.db.exec("COMMIT"); return changes; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  private segmentInventoryValid(segments = this.db.prepare("SELECT * FROM audit_segments ORDER BY id").all() as Row[]) { const integrity = this.db.prepare("SELECT key_id,signature FROM audit_segment_integrity WHERE singleton=1").get() as Row | undefined; if (!integrity) return false; const keyring = keyringFor(this.keyringPath); const secret = keyring.keys[String(integrity.key_id)]; const expected = secret && createHmac("sha256", Buffer.from(secret, "base64")).update(JSON.stringify(segmentInventory(segments))).digest("base64url"); return expected === integrity.signature; }
  private signSegmentInventory(insert: boolean) { const keyring = keyringFor(this.keyringPath); const keyId = keyring.current; const segments = this.db.prepare("SELECT * FROM audit_segments ORDER BY id").all() as Row[]; const signature = createHmac("sha256", Buffer.from(keyring.keys[keyId]!, "base64")).update(JSON.stringify(segmentInventory(segments))).digest("base64url"); const statement = insert ? "INSERT OR IGNORE INTO audit_segment_integrity VALUES(1,?,?)" : "INSERT INTO audit_segment_integrity VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET key_id=excluded.key_id,signature=excluded.signature"; this.db.prepare(statement).run(keyId, signature); }
  backup(destination = `${this.path}.bak`) { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); ensureParent(destination); copyFileSync(this.path, destination); chmodSync(destination, 0o600); return destination; }
  close() { if (this.closed) return; this.closed = true; this.watcher?.close(); this.listeners.clear(); this.db.close(); }
}

export function auditMigrationStatus(databasePath: string) { if (!existsSync(databasePath)) return undefined; const db = openDatabase(resolve(databasePath)); try { const row = db.prepare("SELECT migration_complete,head_sequence AS events FROM audit_state WHERE singleton=1").get() as Row; return { complete: Boolean(row.migration_complete || row.events), events: Number(row.events) }; } finally { db.close(); } }

function fileSha256(path: string) { const descriptor = openSync(path, "r"); const buffer = Buffer.alloc(64 * 1024); const hash = createHash("sha256"); try { for (;;) { const bytes = readSync(descriptor, buffer, 0, buffer.length, null); if (!bytes) return hash.digest("hex"); hash.update(buffer.subarray(0, bytes)); } } finally { closeSync(descriptor); } }

function archiveSegments(segments: Row[], throughSequence: number) {
  return segments.filter((segment) => segment.last_sequence !== null && Number(segment.last_sequence) <= throughSequence).map((segment) => ({ id: Number(segment.id), firstSequence: Number(segment.first_sequence), lastSequence: Number(segment.last_sequence), anchorSignature: segment.anchor_signature ?? null, finalSignature: segment.final_signature ?? null, openedAt: String(segment.opened_at), closedAt: String(segment.closed_at) }));
}

function segmentInventory(segments: Row[]) {
  return segments.map((segment) => ({ id: Number(segment.id), firstSequence: Number(segment.first_sequence), lastSequence: segment.last_sequence === null ? null : Number(segment.last_sequence), anchorSignature: segment.anchor_signature ?? null, finalSignature: segment.final_signature ?? null, openedAt: String(segment.opened_at), closedAt: segment.closed_at === null ? null : String(segment.closed_at) }));
}

function rotationRecord(closed: Row, opened: Row) {
  return { closed: segmentInventory([closed])[0], opened: { id: Number(opened.id), firstSequence: Number(opened.first_sequence), anchorSignature: opened.anchor_signature ?? null, openedAt: String(opened.opened_at) } };
}

function segmentRotations(segments: Row[]) {
  return segments.slice(0, -1).map((segment, index) => rotationRecord(segment, segments[index + 1]!));
}

function verifyArchivedHistory(path: string, throughSequence: number, keyring: Keyring, requestedBoundaries: Set<number>) {
  const descriptor = openSync(path, "r"); const buffer = Buffer.alloc(64 * 1024); const decoder = new StringDecoder("utf8"); const boundaries = new Map<number, string>(); const rotations: Row[] = []; let carry = ""; let cursor = 0; let previous: string | null = null; let valid = true;
  const line = (value: string) => { if (!value.trim()) return; try { const record = JSON.parse(value) as Row; const sequence = Number(record.sequence); const event = normalizeAuditEvent(record.event); const integrity = event.data?.__odinnIntegrity as Integrity | undefined; const secret = integrity && keyring.keys[integrity.keyId]; const expected = secret && createHmac("sha256", Buffer.from(secret, "base64")).update(JSON.stringify({ event: unsigned(event), previous: integrity!.previous })).digest("base64url"); if (sequence !== cursor + 1 || !integrity || integrity.previous !== previous || expected !== integrity.signature) valid = false; cursor = sequence; previous = integrity?.signature ?? null; if (integrity && requestedBoundaries.has(sequence)) boundaries.set(sequence, integrity.signature); if (event.type === "audit.segment.rotated") rotations.push(event.data?.segmentRotation as Row); } catch { valid = false; } };
  try { for (;;) { const bytes = readSync(descriptor, buffer, 0, buffer.length, null); if (!bytes) break; const parts = (carry + decoder.write(buffer.subarray(0, bytes))).split("\n"); carry = parts.pop()!; for (const value of parts) line(value); } carry += decoder.end(); line(carry); } finally { closeSync(descriptor); }
  return { valid: valid && cursor === throughSequence && requestedBoundaries.size === boundaries.size, lastSignature: previous, boundaries, rotations };
}

function publishMigrationBackup(source: string, backup: string, sourceHash: string) { if (existsSync(backup) && fileSha256(backup) === sourceHash) return; if (existsSync(backup)) renameSync(backup, `${backup}.rejected-${Date.now()}-${randomUUID()}`); const temporary = `${backup}.${process.pid}.${randomUUID()}.tmp`; const input = openSync(source, "r"); const output = openSync(temporary, "wx", 0o600); const buffer = Buffer.alloc(64 * 1024); const hash = createHash("sha256"); try { for (;;) { const bytes = readSync(input, buffer, 0, buffer.length, null); if (!bytes) break; hash.update(buffer.subarray(0, bytes)); let written = 0; while (written < bytes) written += writeSync(output, buffer, written, bytes - written); } fsyncSync(output); } catch (error) { rmSync(temporary, { force: true }); throw error; } finally { closeSync(input); closeSync(output); } if (hash.digest("hex") !== sourceHash) { rmSync(temporary, { force: true }); throw new Error("legacy audit changed while creating migration backup"); } renameSync(temporary, backup); chmodSync(backup, 0o600); }

export function migrateLegacyAuditToSqlite({ legacyPath, databasePath, keyringPath = `${legacyPath}.keys.json` }: { legacyPath: string; databasePath: string; keyringPath?: string }) {
  const source = resolve(legacyPath); if (!existsSync(source)) return { migrated: false, events: 0 };
  const store = new SqliteAuditStore(databasePath, { keyringPath }); const count = Number((store.db.prepare("SELECT count(*) AS count FROM audit_events").get() as Row).count);
  if (count) { store.close(); return { migrated: false, events: count }; }
  const backup = `${source}.migration.bak`; const sourceHash = fileSha256(source); publishMigrationBackup(source, backup, sourceHash);
  const before = statSync(source); const descriptor = openSync(backup, "r"); const buffer = Buffer.alloc(64 * 1024); const decoder = new StringDecoder("utf8"); let carry = ""; let events = 0; let position = 0;
  const migrationKeyring = keyringFor(keyringPath); let previous: string | null = null;
  const validateIntegrity = (event: AuditEvent) => { const integrity = event.data?.__odinnIntegrity as Integrity | undefined; if (!integrity) { previous = null; return; } const secret = migrationKeyring.keys[integrity.keyId]; const expected = secret && createHmac("sha256", Buffer.from(secret, "base64")).update(JSON.stringify({ event: unsigned(event), previous: integrity.previous })).digest("base64url"); if (!secret || integrity.previous !== previous || expected !== integrity.signature) throw new Error("legacy audit integrity verification failed"); previous = integrity.signature; };
  store.db.exec("BEGIN IMMEDIATE");
  try {
    for (;;) { const bytes = readSync(descriptor, buffer, 0, buffer.length, position); if (!bytes) break; position += bytes; const parts = (carry + decoder.write(buffer.subarray(0, bytes))).split("\n"); carry = parts.pop()!; for (const line of parts) if (line.trim()) { const event = normalizeAuditEvent(JSON.parse(line)); validateIntegrity(event); const integrity = event.data?.__odinnIntegrity as Integrity | undefined; const result = store.db.prepare("INSERT INTO audit_events(run_id,actor,type,at,key_id,previous_signature,signature,event_json) VALUES(?,?,?,?,?,?,?,?)").run(event.runId,event.actor,event.type,event.at,integrity?.keyId ?? null,integrity?.previous ?? null,integrity?.signature ?? null,JSON.stringify(event)); events = Number(result.lastInsertRowid); const prior = store.db.prepare("SELECT summary_json FROM audit_runs WHERE run_id=?").get(event.runId) as Row | undefined; const summary = statusFor(event, prior); store.db.prepare("INSERT INTO audit_runs VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET summary_json=excluded.summary_json,last_event_at=excluded.last_event_at").run(event.runId,JSON.stringify(summary),event.at); } }
    carry += decoder.end();
    if (carry.trim()) { const event = normalizeAuditEvent(JSON.parse(carry)); validateIntegrity(event); const integrity = event.data?.__odinnIntegrity as Integrity | undefined; const result = store.db.prepare("INSERT INTO audit_events(run_id,actor,type,at,key_id,previous_signature,signature,event_json) VALUES(?,?,?,?,?,?,?,?)").run(event.runId,event.actor,event.type,event.at,integrity?.keyId ?? null,integrity?.previous ?? null,integrity?.signature ?? null,JSON.stringify(event)); events = Number(result.lastInsertRowid); const prior = store.db.prepare("SELECT summary_json FROM audit_runs WHERE run_id=?").get(event.runId) as Row | undefined; const summary = statusFor(event, prior); store.db.prepare("INSERT INTO audit_runs VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET summary_json=excluded.summary_json,last_event_at=excluded.last_event_at").run(event.runId,JSON.stringify(summary),event.at); }
    const last = store.db.prepare("SELECT signature,key_id FROM audit_events ORDER BY sequence DESC LIMIT 1").get() as Row | undefined; store.db.prepare("UPDATE audit_state SET head_sequence=?,head_signature=?,current_key_id=?,migration_complete=1,updated_at=? WHERE singleton=1").run(events,last?.signature ?? null,last?.key_id ?? keyringFor(keyringPath).current,new Date().toISOString());
    const after = statSync(source); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || fileSha256(source) !== sourceHash) throw new Error("legacy audit journal changed during migration"); store.db.exec("COMMIT");
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
