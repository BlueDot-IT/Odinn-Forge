import { createHash } from "node:crypto";
import {
  createScheduleCandidate,
  formatAutomationCursor,
  matchAutomationEvent,
  nextAutomationDue,
  validateAutomationDeclaration,
  validateAutomationEvent,
  type AutomationCandidate,
  type AutomationDeclaration,
  type AutomationEvent
} from "./automation-primitives.ts";
import type { SqliteStore } from "@odinn/store-sqlite";

type Row = Record<string, any>;
type Source = { source: string; authDigest: string; oldestSequence: number; newestSequence: number; enabled: boolean; updatedAt: string };
type DeliveryStatus = "queued" | "completed" | "failed" | "needs-review";

export type EventIngressDispatch = (candidate: AutomationCandidate, context: { signal: AbortSignal }) => Promise<"completed" | "failed" | "needs-review">;
export type EventIngressOptions = { database: SqliteStore; dispatch?: EventIngressDispatch; maxWatches?: number };

const AUTH_DIGEST = /^[a-f0-9]{64}$/u;
const WATCH_ID = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;

function timestamp(): string { return new Date().toISOString(); }
function parse(value: unknown, fallback: any = {}) { try { return typeof value === "string" ? JSON.parse(value) : fallback; } catch { return fallback; } }

function initialize(database: SqliteStore): void {
  database.db.exec(`
    CREATE TABLE IF NOT EXISTS event_sources (
      source TEXT PRIMARY KEY,
      auth_digest TEXT NOT NULL CHECK(length(auth_digest)=64),
      oldest_sequence INTEGER NOT NULL CHECK(oldest_sequence >= 0),
      newest_sequence INTEGER NOT NULL CHECK(newest_sequence >= -1),
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_watches (
      watch_id TEXT PRIMARY KEY,
      declaration_json TEXT NOT NULL,
      declaration_digest TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_deliveries (
      idempotency_key TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL UNIQUE,
      watch_id TEXT NOT NULL REFERENCES event_watches(watch_id),
      source TEXT NOT NULL,
      sequence INTEGER,
      status TEXT NOT NULL CHECK(status IN ('queued','completed','failed','needs-review')),
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS heartbeat_checkpoints (
      name TEXT PRIMARY KEY,
      last_tick_unix_ms INTEGER NOT NULL CHECK(last_tick_unix_ms >= 0),
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_deliveries_watch ON event_deliveries(watch_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_event_deliveries_status ON event_deliveries(status, created_at);
  `);
}

function validSource(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new Error("event source is invalid");
  return value;
}

function validAuth(value: unknown): string {
  if (typeof value !== "string" || !AUTH_DIGEST.test(value)) throw new Error("event source authentication digest is invalid");
  return value;
}

export class DurableEventIngress {
  readonly database: SqliteStore;
  readonly dispatch?: EventIngressDispatch;
  readonly maxWatches: number;

  constructor(options: EventIngressOptions) {
    if (!options?.database) throw new Error("DurableEventIngress requires a database");
    this.database = options.database;
    this.dispatch = options.dispatch;
    this.maxWatches = Math.max(1, Math.min(256, Number(options.maxWatches) || 64));
    initialize(options.database);
  }

  registerSource({ source, authDigest, oldestSequence = 0, enabled = true }: { source: string; authDigest: string; oldestSequence?: number; enabled?: boolean }): Source {
    const normalizedSource = validSource(source);
    const normalizedAuth = validAuth(authDigest);
    if (!Number.isSafeInteger(oldestSequence) || oldestSequence < 0) throw new Error("oldestSequence must be a non-negative integer");
    const existing = this.database.db.prepare("SELECT * FROM event_sources WHERE source=?").get(normalizedSource) as Row | undefined;
    if (existing && String(existing.auth_digest) !== normalizedAuth) throw new Error("event source authentication identity cannot be replaced implicitly");
    const updatedAt = timestamp();
    this.database.db.prepare(`INSERT INTO event_sources(source, auth_digest, oldest_sequence, newest_sequence, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`).run(normalizedSource, normalizedAuth, oldestSequence, existing ? Number(existing.newest_sequence) : oldestSequence - 1, enabled ? 1 : 0, updatedAt);
    return this.source(normalizedSource)!;
  }

  source(source: string): Source | undefined {
    const row = this.database.db.prepare("SELECT * FROM event_sources WHERE source=?").get(validSource(source)) as Row | undefined;
    return row ? { source: String(row.source), authDigest: String(row.auth_digest), oldestSequence: Number(row.oldest_sequence), newestSequence: Number(row.newest_sequence), enabled: Number(row.enabled) === 1, updatedAt: String(row.updated_at) } : undefined;
  }

  registerWatch(watchId: string, declarationInput: unknown): AutomationDeclaration {
    if (!WATCH_ID.test(watchId)) throw new Error("event watch id is invalid");
    const declaration = validateAutomationDeclaration(declarationInput);
    if (!declaration.enabled) throw new Error("disabled automation declarations cannot be activated as watches");
    const existing = this.database.db.prepare("SELECT watch_id, declaration_digest, enabled FROM event_watches WHERE watch_id=?").get(watchId) as Row | undefined;
    if (existing && String(existing.declaration_digest) !== declaration.declarationDigest) throw new Error("event watch identity is immutable; create a new revision id");
    const count = Number((this.database.db.prepare("SELECT count(*) AS count FROM event_watches WHERE enabled=1").get() as Row).count);
    if (count >= this.maxWatches && (!existing || Number(existing.enabled) !== 1)) throw new Error("event watch capacity reached");
    const at = timestamp();
    this.database.db.prepare(`INSERT INTO event_watches(watch_id, declaration_json, declaration_digest, enabled, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(watch_id) DO UPDATE SET enabled=1, updated_at=excluded.updated_at`).run(watchId, JSON.stringify(declaration), declaration.declarationDigest, at, at);
    return declaration;
  }

  disableWatch(watchId: string): void {
    if (!WATCH_ID.test(watchId)) throw new Error("event watch id is invalid");
    this.database.db.prepare("UPDATE event_watches SET enabled=0, updated_at=? WHERE watch_id=?").run(timestamp(), watchId);
  }

  listWatches({ limit = 256, offset = 0 }: { limit?: number; offset?: number } = {}): Array<{ watchId: string; declaration: AutomationDeclaration; enabled: boolean; updatedAt: string }> {
    const boundedLimit = Math.min(256, Math.max(0, Number.isSafeInteger(Number(limit)) ? Number(limit) : 256));
    const boundedOffset = Math.max(0, Number.isSafeInteger(Number(offset)) ? Number(offset) : 0);
    return (this.database.db.prepare("SELECT * FROM event_watches ORDER BY watch_id LIMIT ? OFFSET ?").all(boundedLimit, boundedOffset) as Row[]).map((row) => ({ watchId: String(row.watch_id), declaration: validateAutomationDeclaration(parse(row.declaration_json)), enabled: Number(row.enabled) === 1, updatedAt: String(row.updated_at) }));
  }

  queryWatches({ limit = 50, offset = 0, query = "", status = "" }: { limit?: number; offset?: number; query?: string; status?: string } = {}) {
    const safeLimit = Number.isSafeInteger(Number(limit)) && Number(limit) >= 0 ? Math.min(Number(limit), 10_000) : 50;
    const safeOffset = Number.isSafeInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0;
    const needle = String(query).trim();
    const normalizedStatus = String(status).trim();
    const conditions = ["1=1"];
    const parameters: any[] = [];
    if (normalizedStatus && normalizedStatus !== "enabled" && normalizedStatus !== "disabled") conditions.push("0=1");
    else if (normalizedStatus === "enabled" || normalizedStatus === "disabled") { conditions.push("enabled = ?"); parameters.push(normalizedStatus === "enabled" ? 1 : 0); }
    if (needle) { conditions.push("instr(lower('event-watch event watch durable event ingress declaration ' || watch_id || ' ' || declaration_json), lower(?)) > 0"); parameters.push(needle); }
    const where = conditions.join(" AND ");
    const totals = this.database.db.prepare(`SELECT count(*) AS total, 0 AS attention FROM event_watches WHERE ${where}`).get(...parameters) as Row;
    const rows = (this.database.db.prepare(`SELECT * FROM event_watches WHERE ${where}
      ORDER BY watch_id LIMIT ? OFFSET ?`).all(...parameters, safeLimit, safeOffset) as Row[]).map((row) => ({
      watchId: String(row.watch_id),
      declaration: validateAutomationDeclaration(parse(row.declaration_json)),
      enabled: Number(row.enabled) === 1,
      updatedAt: String(row.updated_at)
    }));
    return {
      items: rows,
      total: Number(totals.total || 0),
      attention: Number(totals.attention || 0),
      ...(safeOffset + rows.length < Number(totals.total || 0) ? { nextOffset: safeOffset + rows.length, nextCursor: String(safeOffset + rows.length) } : {})
    };
  }

  private listActiveWatches(kind?: AutomationDeclaration["kind"]): Array<{ watchId: string; declaration: AutomationDeclaration; enabled: true; updatedAt: string }> {
    const rows = (this.database.db.prepare(`SELECT * FROM event_watches
      WHERE enabled = 1${kind ? " AND json_extract(declaration_json, '$.kind') = ?" : ""}
      ORDER BY watch_id`).all(...(kind ? [kind] : [])) as Row[]);
    return rows.map((row) => ({
      watchId: String(row.watch_id),
      declaration: validateAutomationDeclaration(parse(row.declaration_json)),
      enabled: true as const,
      updatedAt: String(row.updated_at)
    }));
  }

  countWatches(): number {
    return Number((this.database.db.prepare("SELECT count(*) AS count FROM event_watches").get() as Row).count || 0);
  }

  async ingest(input: unknown, authDigest: string): Promise<{ event: AutomationEvent; candidates: AutomationCandidate[]; deliveries: Array<{ idempotencyKey: string; status: DeliveryStatus }> }> {
    const event = validateAutomationEvent(input);
    const source = this.source(event.source);
    if (!source || !source.enabled) throw new Error("event source is unknown or disabled");
    if (source.authDigest !== validAuth(authDigest)) throw new Error("event source authentication failed");
    if (event.sequence < source.oldestSequence) throw new Error("event cursor is stale");
    const duplicate = event.sequence === source.newestSequence;
    if (!duplicate && event.sequence !== source.newestSequence + 1) throw new Error("event cursor is not the next authoritative sequence");
    const watches = this.listActiveWatches("event");
    const window = { source: source.source, oldestAvailableSequence: source.oldestSequence, oldestAvailableCursor: formatAutomationCursor(source.source, source.oldestSequence), newestAvailableSequence: event.sequence, newestAvailableCursor: event.cursor };
    const replayWindow = event.sequence === source.oldestSequence ? window : { ...window, afterCursor: formatAutomationCursor(source.source, event.sequence - 1) };
    const candidates = watches.map((watch) => matchAutomationEvent(watch.declaration, event, replayWindow)).filter((candidate): candidate is AutomationCandidate => Boolean(candidate));
    const deliveries: Array<{ idempotencyKey: string; status: DeliveryStatus }> = [];
    this.database.transaction((db) => {
      if (!duplicate) db.prepare("UPDATE event_sources SET newest_sequence=?, updated_at=? WHERE source=? AND newest_sequence=?").run(event.sequence, timestamp(), source.source, source.newestSequence);
      for (const candidate of candidates) {
        const watch = watches.find((entry) => entry.declaration.declarationDigest === candidate.declarationDigest)!;
        const result = db.prepare(`INSERT OR IGNORE INTO event_deliveries(idempotency_key, candidate_id, watch_id, source, sequence, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`).run(candidate.idempotencyKey, candidate.candidateId, watch.watchId, source.source, event.sequence, timestamp(), timestamp());
        if (Number(result.changes) === 1) deliveries.push({ idempotencyKey: candidate.idempotencyKey, status: "queued" });
      }
    });
    if (this.dispatch) {
      for (const candidate of candidates) {
        const delivery = this.delivery(candidate.idempotencyKey);
        if (!delivery || delivery.status !== "queued") continue;
        const controller = new AbortController();
        let status: DeliveryStatus = "completed";
        try { status = await this.dispatch(candidate, { signal: controller.signal }); }
        catch { status = "needs-review"; }
        this.database.db.prepare("UPDATE event_deliveries SET status=?, error_code=?, updated_at=? WHERE idempotency_key=? AND status='queued'").run(status, status === "completed" ? null : status === "needs-review" ? "EVENT_DISPATCH_UNCERTAIN" : "EVENT_DISPATCH_FAILED", timestamp(), candidate.idempotencyKey);
        deliveries.push({ idempotencyKey: candidate.idempotencyKey, status });
      }
    }
    return { event, candidates, deliveries };
  }

  async heartbeat(nowUnixMs = Date.now()): Promise<AutomationCandidate[]> {
    if (!Number.isSafeInteger(nowUnixMs) || nowUnixMs < 0) throw new Error("heartbeat time is invalid");
    const candidates: AutomationCandidate[] = [];
    for (const watch of this.listActiveWatches("schedule")) {
      const checkpoint = this.database.db.prepare("SELECT last_tick_unix_ms FROM heartbeat_checkpoints WHERE name=?").get(watch.watchId) as Row | undefined;
      const after = checkpoint ? Number(checkpoint.last_tick_unix_ms) : nowUnixMs - 1;
      const occurrence = nextAutomationDue(watch.declaration, after);
      if (occurrence === null || occurrence > nowUnixMs) continue;
      const candidate = createScheduleCandidate(watch.declaration, occurrence);
      if (!candidate) continue;
      this.database.db.prepare(`INSERT INTO heartbeat_checkpoints(name, last_tick_unix_ms, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET last_tick_unix_ms=excluded.last_tick_unix_ms, updated_at=excluded.updated_at`).run(watch.watchId, occurrence, timestamp());
      candidates.push(candidate);
      if (this.dispatch) {
        try {
          const status = await this.dispatch(candidate, { signal: new AbortController().signal });
          this.database.db.prepare(`INSERT OR IGNORE INTO event_deliveries(idempotency_key, candidate_id, watch_id, source, sequence, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`).run(candidate.idempotencyKey, candidate.candidateId, watch.watchId, "heartbeat", status, timestamp(), timestamp());
        } catch {
          this.database.db.prepare(`INSERT OR IGNORE INTO event_deliveries(idempotency_key, candidate_id, watch_id, source, sequence, status, error_code, created_at, updated_at)
            VALUES (?, ?, ?, ?, NULL, 'needs-review', 'HEARTBEAT_DISPATCH_UNCERTAIN', ?, ?)`).run(candidate.idempotencyKey, candidate.candidateId, watch.watchId, "heartbeat", timestamp(), timestamp());
        }
      }
    }
    return candidates;
  }

  delivery(idempotencyKey: string): { idempotencyKey: string; candidateId: string; watchId: string; status: DeliveryStatus; errorCode?: string } | undefined {
    const row = this.database.db.prepare("SELECT * FROM event_deliveries WHERE idempotency_key=?").get(idempotencyKey) as Row | undefined;
    return row ? { idempotencyKey: String(row.idempotency_key), candidateId: String(row.candidate_id), watchId: String(row.watch_id), status: String(row.status) as DeliveryStatus, ...(row.error_code ? { errorCode: String(row.error_code) } : {}) } : undefined;
  }

  close(): void { /* The parent RunLedger owns the SQLite connection. */ }
}

export function sourceAuthDigest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
