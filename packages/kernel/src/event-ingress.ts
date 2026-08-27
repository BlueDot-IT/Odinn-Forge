import { createHash, randomUUID } from "node:crypto";
import {
  createScheduleCandidate,
  formatAutomationCursor,
  matchAutomationEvent,
  nextAutomationDue,
  validateAutomationCandidate,
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

export type EventIngressDispatch = (candidate: AutomationCandidate, context: { signal: AbortSignal; renewLease: () => boolean }) => Promise<"completed" | "failed" | "needs-review">;
export type EventIngressOptions = { database: SqliteStore; dispatch?: EventIngressDispatch; maxWatches?: number; dispatchLeaseMs?: number };
export type EventIngressMutationOptions = { signal?: AbortSignal };

type ActiveDispatch = {
  controller: AbortController;
  force: (errorCode: string) => void;
  settled: Promise<void>;
};

const AUTH_DIGEST = /^[a-f0-9]{64}$/u;
const CANDIDATE_DIGEST = /^[a-f0-9]{64}$/u;
const WATCH_ID = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;

function timestamp(): string { return new Date().toISOString(); }
function parse(value: unknown, fallback: any = {}) { try { return typeof value === "string" ? JSON.parse(value) : fallback; } catch { return fallback; } }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function candidateProjection(input: unknown): { candidate: AutomationCandidate; json: string; digest: string } {
  const candidate = validateAutomationCandidate(input);
  const json = canonicalJson(candidate);
  return { candidate, json, digest: createHash("sha256").update(json, "utf8").digest("hex") };
}

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
  for (const statement of [
    "ALTER TABLE event_deliveries ADD COLUMN dispatch_token TEXT",
    "ALTER TABLE event_deliveries ADD COLUMN dispatch_lease_expires_at TEXT",
    "ALTER TABLE event_deliveries ADD COLUMN candidate_json TEXT",
    "ALTER TABLE event_deliveries ADD COLUMN candidate_digest TEXT"
  ]) {
    try { database.db.exec(statement); } catch (error: any) { if (!String(error?.message ?? error).includes("duplicate column name")) throw error; }
  }
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
  readonly dispatchLeaseMs: number;
  #active = new Map<string, ActiveDispatch>();
  #recoveryTimer?: ReturnType<typeof setTimeout>;
  #closed = false;
  #shutdownPromise?: Promise<void>;

  constructor(options: EventIngressOptions) {
    if (!options?.database) throw new Error("DurableEventIngress requires a database");
    this.database = options.database;
    this.dispatch = options.dispatch;
    this.maxWatches = Math.max(1, Math.min(256, Number(options.maxWatches) || 64));
    this.dispatchLeaseMs = positiveDuration(options.dispatchLeaseMs, 30_000, "event dispatch lease");
    initialize(options.database);
    this.reconcileExpiredDispatches();
    this.recoverTokenlessDeliveries();
  }

  registerSource({ source, authDigest, oldestSequence = 0, enabled = true }: { source: string; authDigest: string; oldestSequence?: number; enabled?: boolean }, options: EventIngressMutationOptions = {}): Source {
    throwIfEventIngressMutationAborted(options.signal);
    const normalizedSource = validSource(source);
    const normalizedAuth = validAuth(authDigest);
    if (!Number.isSafeInteger(oldestSequence) || oldestSequence < 0) throw new Error("oldestSequence must be a non-negative integer");
    const existing = this.database.db.prepare("SELECT * FROM event_sources WHERE source=?").get(normalizedSource) as Row | undefined;
    if (existing && String(existing.auth_digest) !== normalizedAuth) throw new Error("event source authentication identity cannot be replaced implicitly");
    const updatedAt = timestamp();
    throwIfEventIngressMutationAborted(options.signal);
    this.database.db.prepare(`INSERT INTO event_sources(source, auth_digest, oldest_sequence, newest_sequence, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`).run(normalizedSource, normalizedAuth, oldestSequence, existing ? Number(existing.newest_sequence) : oldestSequence - 1, enabled ? 1 : 0, updatedAt);
    return this.source(normalizedSource)!;
  }

  source(source: string): Source | undefined {
    const row = this.database.db.prepare("SELECT * FROM event_sources WHERE source=?").get(validSource(source)) as Row | undefined;
    return row ? { source: String(row.source), authDigest: String(row.auth_digest), oldestSequence: Number(row.oldest_sequence), newestSequence: Number(row.newest_sequence), enabled: Number(row.enabled) === 1, updatedAt: String(row.updated_at) } : undefined;
  }

  registerWatch(watchId: string, declarationInput: unknown, options: EventIngressMutationOptions = {}): AutomationDeclaration {
    throwIfEventIngressMutationAborted(options.signal);
    if (!WATCH_ID.test(watchId)) throw new Error("event watch id is invalid");
    const declaration = validateAutomationDeclaration(declarationInput);
    if (!declaration.enabled) throw new Error("disabled automation declarations cannot be activated as watches");
    const existing = this.database.db.prepare("SELECT watch_id, declaration_digest, enabled FROM event_watches WHERE watch_id=?").get(watchId) as Row | undefined;
    if (existing && String(existing.declaration_digest) !== declaration.declarationDigest) throw new Error("event watch identity is immutable; create a new revision id");
    const count = Number((this.database.db.prepare("SELECT count(*) AS count FROM event_watches WHERE enabled=1").get() as Row).count);
    if (count >= this.maxWatches && (!existing || Number(existing.enabled) !== 1)) throw new Error("event watch capacity reached");
    const at = timestamp();
    throwIfEventIngressMutationAborted(options.signal);
    this.database.db.prepare(`INSERT INTO event_watches(watch_id, declaration_json, declaration_digest, enabled, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(watch_id) DO UPDATE SET enabled=1, updated_at=excluded.updated_at`).run(watchId, JSON.stringify(declaration), declaration.declarationDigest, at, at);
    return declaration;
  }

  disableWatch(watchId: string, options: EventIngressMutationOptions = {}): void {
    throwIfEventIngressMutationAborted(options.signal);
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

  private persistCandidate(
    database: any,
    candidateInput: AutomationCandidate,
    { watchId, source, sequence }: { watchId: string; source: string; sequence?: number }
  ): boolean {
    const { candidate, json, digest } = candidateProjection(candidateInput);
    const at = timestamp();
    const result = database.prepare(`INSERT OR IGNORE INTO event_deliveries(
      idempotency_key, candidate_id, watch_id, source, sequence, status,
      candidate_json, candidate_digest, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).run(
      candidate.idempotencyKey,
      candidate.candidateId,
      watchId,
      source,
      sequence ?? null,
      json,
      digest,
      at,
      at
    );
    const row = database.prepare(`SELECT candidate_id, watch_id, source, sequence, candidate_json, candidate_digest
      FROM event_deliveries WHERE idempotency_key=?`).get(candidate.idempotencyKey) as Row | undefined;
    if (!row
      || String(row.candidate_id) !== candidate.candidateId
      || String(row.watch_id) !== watchId
      || String(row.source) !== source
      || (row.sequence === null ? undefined : Number(row.sequence)) !== sequence) {
      throw new Error("event delivery idempotency key is bound to a different candidate or trigger scope");
    }
    if (row.candidate_json === null && row.candidate_digest === null) {
      const upgraded = database.prepare(`UPDATE event_deliveries SET candidate_json=?, candidate_digest=?, updated_at=?
        WHERE idempotency_key=? AND candidate_id=? AND watch_id=? AND source=?
          AND ((sequence IS NULL AND ? IS NULL) OR sequence=?)
          AND candidate_json IS NULL AND candidate_digest IS NULL`).run(
        json,
        digest,
        at,
        candidate.idempotencyKey,
        candidate.candidateId,
        watchId,
        source,
        sequence ?? null,
        sequence ?? null
      );
      if (Number(upgraded.changes) !== 1) throw new Error("event delivery candidate projection changed concurrently");
    } else if (String(row.candidate_json ?? "") !== json || String(row.candidate_digest ?? "") !== digest) {
      throw new Error("event delivery candidate projection integrity check failed");
    }
    return Number(result.changes) === 1;
  }

  private candidateFromDelivery(row: Row): AutomationCandidate {
    if (typeof row.candidate_json !== "string" || typeof row.candidate_digest !== "string") {
      throw new Error("EVENT_CANDIDATE_RECOVERY_UNAVAILABLE");
    }
    if (!CANDIDATE_DIGEST.test(row.candidate_digest)) throw new Error("EVENT_CANDIDATE_INTEGRITY_INVALID");
    let parsed: unknown;
    try { parsed = JSON.parse(row.candidate_json); }
    catch { throw new Error("EVENT_CANDIDATE_INTEGRITY_INVALID"); }
    const projection = candidateProjection(parsed);
    if (projection.json !== row.candidate_json
      || projection.digest !== row.candidate_digest
      || projection.candidate.idempotencyKey !== String(row.idempotency_key)
      || projection.candidate.candidateId !== String(row.candidate_id)) {
      throw new Error("EVENT_CANDIDATE_INTEGRITY_INVALID");
    }
    return projection.candidate;
  }

  private startDispatch(candidate: AutomationCandidate): void {
    if (!this.dispatch || this.#closed) return;
    void this.dispatchCandidate(candidate).catch(() => undefined);
  }

  private recoverTokenlessDeliveries(): void {
    if (!this.dispatch || this.#closed) return;
    const rows = this.database.db.prepare(`SELECT * FROM event_deliveries
      WHERE status='queued' AND dispatch_token IS NULL ORDER BY created_at, idempotency_key`).all() as Row[];
    for (const row of rows) {
      try {
        this.startDispatch(this.candidateFromDelivery(row));
      } catch (error) {
        const errorCode = error instanceof Error && error.message === "EVENT_CANDIDATE_RECOVERY_UNAVAILABLE"
          ? error.message
          : "EVENT_CANDIDATE_INTEGRITY_INVALID";
        this.database.db.prepare(`UPDATE event_deliveries
          SET status='needs-review', error_code=?, updated_at=?
          WHERE idempotency_key=? AND status='queued' AND dispatch_token IS NULL`).run(
          errorCode,
          timestamp(),
          String(row.idempotency_key)
        );
      }
    }
  }

  private claimDelivery(idempotencyKey: string): string | undefined {
    const token = randomUUID();
    const expires = new Date(Date.now() + this.dispatchLeaseMs).toISOString();
    const result = this.database.db.prepare(`UPDATE event_deliveries
      SET dispatch_token=?, dispatch_lease_expires_at=?, updated_at=?
      WHERE idempotency_key=? AND status='queued' AND dispatch_token IS NULL`).run(token, expires, timestamp(), idempotencyKey);
    if (Number(result.changes) === 1) {
      this.scheduleRecovery();
      return token;
    }
    return undefined;
  }

  private renewDelivery(idempotencyKey: string, token: string): boolean {
    if (this.#closed) return false;
    const now = timestamp();
    const result = this.database.db.prepare(`UPDATE event_deliveries
      SET dispatch_lease_expires_at=?, updated_at=?
      WHERE idempotency_key=? AND status='queued' AND dispatch_token=? AND dispatch_lease_expires_at > ?`).run(
      new Date(Date.now() + this.dispatchLeaseMs).toISOString(), now, idempotencyKey, token, now
    );
    if (Number(result.changes) === 1) this.scheduleRecovery();
    return Number(result.changes) === 1;
  }

  private settleDelivery(idempotencyKey: string, token: string, status: DeliveryStatus, errorCode?: string): DeliveryStatus {
    const now = timestamp();
    const result = this.database.db.prepare(`UPDATE event_deliveries
      SET status=?, error_code=?, dispatch_token=NULL, dispatch_lease_expires_at=NULL, updated_at=?
      WHERE idempotency_key=? AND status='queued' AND dispatch_token=? AND dispatch_lease_expires_at > ?`).run(
      status,
      status === "completed" ? null : errorCode ?? (status === "needs-review" ? "EVENT_DISPATCH_UNCERTAIN" : "EVENT_DISPATCH_FAILED"),
      now, idempotencyKey, token, now
    );
    if (Number(result.changes) !== 1) {
      const current = this.database.db.prepare("SELECT status, dispatch_token, dispatch_lease_expires_at FROM event_deliveries WHERE idempotency_key=?").get(idempotencyKey) as Row | undefined;
      if (current?.status === "queued") {
        const expired = Date.parse(String(current.dispatch_lease_expires_at ?? "")) <= Date.now();
        const currentToken = typeof current.dispatch_token === "string" ? current.dispatch_token : undefined;
        this.database.db.prepare(`UPDATE event_deliveries
          SET status='needs-review', error_code=?, dispatch_token=NULL, dispatch_lease_expires_at=NULL, updated_at=?
          WHERE idempotency_key=? AND status='queued'`).run(
          expired ? "EVENT_DISPATCH_LEASE_EXPIRED" : "EVENT_DISPATCH_LEASE_LOST", now, idempotencyKey
        );
        if (currentToken && currentToken !== token) this.#active.get(currentToken)?.force("EVENT_DISPATCH_LEASE_LOST");
      }
    }
    this.scheduleRecovery();
    return this.delivery(idempotencyKey)?.status ?? "needs-review";
  }

  private async dispatchCandidate(candidate: AutomationCandidate, requestSignal?: AbortSignal): Promise<DeliveryStatus | undefined> {
    throwIfEventIngressMutationAborted(requestSignal);
    if (!this.dispatch || this.#closed) return undefined;
    const token = this.claimDelivery(candidate.idempotencyKey);
    if (!token) return this.delivery(candidate.idempotencyKey)?.status;
    const controller = new AbortController();
    let forceOutcome!: (value: { status: DeliveryStatus; errorCode: string }) => void;
    let settleActive!: () => void;
    const forced = new Promise<{ status: DeliveryStatus; errorCode: string }>((resolve) => { forceOutcome = resolve; });
    const settled = new Promise<void>((resolve) => { settleActive = resolve; });
    let forcedOnce = false;
    const force = (errorCode: string) => {
      if (forcedOnce) return;
      forcedOnce = true;
      controller.abort(new Error(errorCode));
      forceOutcome({ status: "needs-review", errorCode });
    };
    const abortForRequest = () => force("EVENT_REQUEST_ABORTED");
    requestSignal?.addEventListener("abort", abortForRequest, { once: true });
    if (requestSignal?.aborted) abortForRequest();
    this.#active.set(token, { controller, force, settled });
    const dispatch = Promise.resolve()
      .then(() => this.dispatch!(candidate, {
        signal: controller.signal,
        renewLease: () => {
          const renewed = this.renewDelivery(candidate.idempotencyKey, token);
          if (!renewed) force("EVENT_DISPATCH_LEASE_EXPIRED");
          return renewed;
        }
      }))
      .then((status) => ({ status }), () => ({ status: "needs-review" as const, errorCode: "EVENT_DISPATCH_UNCERTAIN" }));
    let outcome: { status: DeliveryStatus; errorCode?: string };
    try {
      outcome = await Promise.race([dispatch, forced]);
      // shutdown() durably quarantines every active token synchronously before
      // returning its Promise. Preserve legacy fire-and-forget close() callers:
      // once closed, this continuation must never touch the parent-owned DB.
      if (this.#closed) return "needs-review";
      return this.settleDelivery(candidate.idempotencyKey, token, outcome.status, outcome.errorCode);
    } finally {
      requestSignal?.removeEventListener("abort", abortForRequest);
      this.#active.delete(token);
      settleActive();
    }
  }

  private reconcileExpiredDispatches(): void {
    if (this.#closed) return;
    const now = timestamp();
    const expired = this.database.db.prepare(`SELECT idempotency_key, dispatch_token FROM event_deliveries
      WHERE status='queued' AND dispatch_token IS NOT NULL AND dispatch_lease_expires_at <= ?`).all(now) as Row[];
    for (const row of expired) {
      const token = String(row.dispatch_token);
      const result = this.database.db.prepare(`UPDATE event_deliveries
        SET status='needs-review', error_code='EVENT_DISPATCH_LEASE_EXPIRED', dispatch_token=NULL,
          dispatch_lease_expires_at=NULL, updated_at=?
        WHERE idempotency_key=? AND status='queued' AND dispatch_token=? AND dispatch_lease_expires_at <= ?`).run(
        now, String(row.idempotency_key), token, now
      );
      if (Number(result.changes) === 1) this.#active.get(token)?.force("EVENT_DISPATCH_LEASE_EXPIRED");
    }
    this.scheduleRecovery();
  }

  private scheduleRecovery(): void {
    if (this.#recoveryTimer) clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = undefined;
    if (this.#closed) return;
    const row = this.database.db.prepare(`SELECT min(dispatch_lease_expires_at) AS expires_at FROM event_deliveries
      WHERE status='queued' AND dispatch_token IS NOT NULL`).get() as Row | undefined;
    const expiry = Date.parse(String(row?.expires_at ?? ""));
    if (!Number.isFinite(expiry)) return;
    this.#recoveryTimer = setTimeout(() => this.reconcileExpiredDispatches(), Math.max(1, expiry - Date.now() + 1));
    this.#recoveryTimer.unref?.();
  }

  async ingest(input: unknown, authDigest: string, options: EventIngressMutationOptions = {}): Promise<{ event: AutomationEvent; candidates: AutomationCandidate[]; deliveries: Array<{ idempotencyKey: string; status: DeliveryStatus }> }> {
    throwIfEventIngressMutationAborted(options.signal);
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
    throwIfEventIngressMutationAborted(options.signal);
    this.database.transaction((db) => {
      throwIfEventIngressMutationAborted(options.signal);
      if (!duplicate) {
        const updated = db.prepare("UPDATE event_sources SET newest_sequence=?, updated_at=? WHERE source=? AND newest_sequence=?").run(event.sequence, timestamp(), source.source, source.newestSequence);
        if (Number(updated.changes) !== 1) {
          const current = db.prepare("SELECT newest_sequence FROM event_sources WHERE source=?").get(source.source) as Row | undefined;
          if (Number(current?.newest_sequence) !== event.sequence) throw new Error("event cursor is not the next authoritative sequence");
        }
      }
      for (const candidate of candidates) {
        const watch = watches.find((entry) => entry.declaration.declarationDigest === candidate.declarationDigest)!;
        if (this.persistCandidate(db, candidate, { watchId: watch.watchId, source: source.source, sequence: event.sequence })) {
          deliveries.push({ idempotencyKey: candidate.idempotencyKey, status: "queued" });
        }
      }
    });
    throwIfEventIngressMutationAborted(options.signal);
    for (const candidate of candidates) {
      throwIfEventIngressMutationAborted(options.signal);
      this.startDispatch(candidate);
    }
    return { event, candidates, deliveries };
  }

  async heartbeat(nowUnixMs = Date.now(), options: EventIngressMutationOptions = {}): Promise<AutomationCandidate[]> {
    throwIfEventIngressMutationAborted(options.signal);
    if (!Number.isSafeInteger(nowUnixMs) || nowUnixMs < 0) throw new Error("heartbeat time is invalid");
    const candidates: AutomationCandidate[] = [];
    for (const watch of this.listActiveWatches("schedule")) {
      const checkpoint = this.database.db.prepare("SELECT last_tick_unix_ms FROM heartbeat_checkpoints WHERE name=?").get(watch.watchId) as Row | undefined;
      const after = checkpoint ? Number(checkpoint.last_tick_unix_ms) : nowUnixMs - 1;
      const occurrence = nextAutomationDue(watch.declaration, after);
      if (occurrence === null || occurrence > nowUnixMs) continue;
      const candidate = createScheduleCandidate(watch.declaration, occurrence);
      if (!candidate) continue;
      throwIfEventIngressMutationAborted(options.signal);
      this.database.transaction((db) => {
        throwIfEventIngressMutationAborted(options.signal);
        this.persistCandidate(db, candidate, { watchId: watch.watchId, source: "heartbeat" });
        db.prepare(`INSERT INTO heartbeat_checkpoints(name, last_tick_unix_ms, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET last_tick_unix_ms=excluded.last_tick_unix_ms, updated_at=excluded.updated_at
          WHERE heartbeat_checkpoints.last_tick_unix_ms < excluded.last_tick_unix_ms`).run(watch.watchId, occurrence, timestamp());
      });
      candidates.push(candidate);
      throwIfEventIngressMutationAborted(options.signal);
      this.startDispatch(candidate);
    }
    return candidates;
  }

  delivery(idempotencyKey: string): { idempotencyKey: string; candidateId: string; watchId: string; status: DeliveryStatus; errorCode?: string } | undefined {
    const row = this.database.db.prepare("SELECT * FROM event_deliveries WHERE idempotency_key=?").get(idempotencyKey) as Row | undefined;
    return row ? { idempotencyKey: String(row.idempotency_key), candidateId: String(row.candidate_id), watchId: String(row.watch_id), status: String(row.status) as DeliveryStatus, ...(row.error_code ? { errorCode: String(row.error_code) } : {}) } : undefined;
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#closed = true;
    this.#shutdownPromise = this.finishShutdown();
    return this.#shutdownPromise;
  }

  private async finishShutdown(): Promise<void> {
    if (this.#recoveryTimer) clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = undefined;
    const active = [...this.#active.entries()];
    for (const [token, entry] of active) {
      entry.controller.abort(new Error("EVENT_DISPATCH_SHUTDOWN"));
      entry.force("EVENT_DISPATCH_SHUTDOWN");
      this.database.db.prepare(`UPDATE event_deliveries
        SET status='needs-review', error_code='EVENT_DISPATCH_SHUTDOWN', dispatch_token=NULL,
          dispatch_lease_expires_at=NULL, updated_at=?
        WHERE status='queued' AND dispatch_token=?`).run(timestamp(), token);
    }
    await Promise.allSettled(active.map(([, entry]) => entry.settled));
  }

  close(): Promise<void> {
    return this.shutdown();
  }
}

export function sourceAuthDigest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  const duration = value ?? fallback;
  if (!Number.isInteger(duration) || duration < 1) throw new Error(`${label} must be a positive integer`);
  return duration;
}

function throwIfEventIngressMutationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("event ingress mutation was aborted");
}
