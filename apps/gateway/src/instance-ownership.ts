import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync, type Stats } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { kill as signalProcess } from "node:process";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const MAX_LEASE_MS = 5 * 60_000;
const MAX_OWNER_ID_BYTES = 128;
const getProcessUserId = process.getuid;

const LEASE_DDL = `CREATE TABLE gateway_instance_lease (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  owner_id TEXT NOT NULL,
  owner_host_digest TEXT NOT NULL,
  state_root_digest TEXT NOT NULL,
  owner_pid INTEGER NOT NULL CHECK(owner_pid > 0),
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT
)`;

type LeaseRow = {
  owner_id: string;
  owner_host_digest: string;
  state_root_digest: string;
  owner_pid: number;
  epoch: number;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
};

export class GatewayInstanceOwnershipError extends Error {
  readonly code = "GATEWAY_INSTANCE_OWNED";
  readonly status = 503;
}

export type GatewayInstanceOwnershipOptions = {
  ownerId?: string;
  ownerHostDigest?: string;
  ownerPid?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  processAlive?: (pid: number) => boolean;
  disableHeartbeat?: boolean;
};

function boundedPositiveInteger(value: unknown, fallback: number, maximum: number): number {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 && normalized <= maximum
    ? normalized
    : fallback;
}

function hostDigest(): string {
  return `sha256:${createHash("sha256").update(hostname(), "utf8").digest("hex")}`;
}

function pathDigest(path: string): string {
  return `sha256:${createHash("sha256").update(path, "utf8").digest("hex")}`;
}

function isOwnerOnly(info: Stats): boolean {
  return (info.mode & 0o077) === 0
    && (typeof getProcessUserId !== "function" || info.uid === getProcessUserId());
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    signalProcess(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function normalizeOwnerId(value: string): string {
  const normalized = String(value).trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > MAX_OWNER_ID_BYTES || !/^[A-Za-z0-9._:-]+$/u.test(normalized)) {
    throw new Error("gateway instance owner id is invalid");
  }
  return normalized;
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function parseTimestamp(value: unknown): number {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function leaseRow(database: DatabaseSync): LeaseRow | undefined {
  return database.prepare("SELECT owner_id, owner_host_digest, state_root_digest, owner_pid, epoch, acquired_at, heartbeat_at, expires_at, released_at FROM gateway_instance_lease WHERE singleton = 1").get() as LeaseRow | undefined;
}

function validateLeaseRow(row: LeaseRow | undefined): void {
  if (!row) return;
  normalizeOwnerId(row.owner_id);
  if (!/^sha256:[0-9a-f]{64}$/u.test(String(row.owner_host_digest))) throw new Error("gateway instance lease host identity is invalid");
  if (!/^sha256:[0-9a-f]{64}$/u.test(String(row.state_root_digest))) throw new Error("gateway instance lease state identity is invalid");
  if (!Number.isSafeInteger(Number(row.owner_pid)) || Number(row.owner_pid) < 1) throw new Error("gateway instance lease pid is invalid");
  if (!Number.isSafeInteger(Number(row.epoch)) || Number(row.epoch) < 1) throw new Error("gateway instance lease epoch is invalid");
  for (const timestamp of [row.acquired_at, row.heartbeat_at, row.expires_at]) {
    if (!Number.isFinite(parseTimestamp(timestamp))) throw new Error("gateway instance lease timestamp is invalid");
  }
  if (row.released_at !== null && !Number.isFinite(parseTimestamp(row.released_at))) throw new Error("gateway instance release timestamp is invalid");
}

function assertOwnershipSchema(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(gateway_instance_lease)").all() as Array<Record<string, unknown>>;
  const expected = [
    ["singleton", "INTEGER", 0, 1],
    ["owner_id", "TEXT", 1, 0],
    ["owner_host_digest", "TEXT", 1, 0],
    ["state_root_digest", "TEXT", 1, 0],
    ["owner_pid", "INTEGER", 1, 0],
    ["epoch", "INTEGER", 1, 0],
    ["acquired_at", "TEXT", 1, 0],
    ["heartbeat_at", "TEXT", 1, 0],
    ["expires_at", "TEXT", 1, 0],
    ["released_at", "TEXT", 0, 0]
  ];
  const normalized = columns.map((column) => [String(column.name), String(column.type).toUpperCase(), Number(column.notnull), Number(column.pk)]);
  if (normalized.length !== expected.length || normalized.some((column, index) => column.some((value, field) => value !== expected[index]?.[field]))) {
    throw new Error("gateway instance ownership schema is invalid");
  }
  const ddl = String((database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gateway_instance_lease'").get() as { sql?: unknown } | undefined)?.sql ?? "")
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),=])\s*/gu, "$1")
    .trim()
    .toLowerCase();
  const expectedDdl = LEASE_DDL.replace(/\s+/gu, " ").replace(/\s*([(),=])\s*/gu, "$1").trim().toLowerCase();
  if (ddl !== expectedDdl) throw new Error("gateway instance ownership table definition is invalid");
}

export function gatewayOwnershipDirectory(stateDir: string): string {
  const state = realpathSync(resolve(stateDir));
  return join(dirname(state), `.${basename(state)}.gateway-instance`);
}

function openOwnershipDatabase(stateDir: string): { database: DatabaseSync; path: string; stateRootDigest: string } {
  const state = realpathSync(resolve(stateDir));
  const databaseDirectory = gatewayOwnershipDirectory(state);
  mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(databaseDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || realpathSync(databaseDirectory) !== databaseDirectory) {
    throw new Error("gateway ownership database directory must be a physical directory");
  }
  chmodSync(databaseDirectory, 0o700);
  const securedDirectoryStat = lstatSync(databaseDirectory);
  if (process.platform !== "win32" && !isOwnerOnly(securedDirectoryStat)) {
    throw new Error("gateway ownership database directory must be owner-only");
  }
  const path = join(databaseDirectory, "gateway-instance.sqlite");
  try {
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("gateway ownership database must be a physical file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const database = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    const fileStat = lstatSync(path);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("gateway ownership database must be a physical file");
    if (process.platform !== "win32" && !isOwnerOnly(fileStat)) {
      throw new Error("gateway ownership database must be owner-only");
    }
    database.exec("PRAGMA busy_timeout = 30000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    database.exec(LEASE_DDL.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"));
    assertOwnershipSchema(database);
    validateLeaseRow(leaseRow(database));
    return { database, path, stateRootDigest: pathDigest(state) };
  } catch (error) {
    database.close();
    throw error;
  }
}

export class GatewayInstanceOwnership {
  readonly ownerId: string;
  readonly ownerHostDigest: string;
  readonly ownerPid: number;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly path: string;
  readonly stateRootDigest: string;
  readonly signal: AbortSignal;
  #database: DatabaseSync;
  #now: () => number;
  #processAlive: (pid: number) => boolean;
  #abort = new AbortController();
  #epoch = 0;
  #timer: NodeJS.Timeout | undefined;
  #closed = false;
  #lostHandlers = new Set<() => void>();

  constructor(stateDir: string, options: GatewayInstanceOwnershipOptions = {}) {
    this.ownerId = normalizeOwnerId(options.ownerId ?? `gateway:${randomUUID()}`);
    this.ownerHostDigest = options.ownerHostDigest ?? hostDigest();
    if (!/^sha256:[0-9a-f]{64}$/u.test(this.ownerHostDigest)) throw new Error("gateway owner host digest is invalid");
    this.ownerPid = boundedPositiveInteger(options.ownerPid, process.pid, Number.MAX_SAFE_INTEGER);
    this.leaseMs = boundedPositiveInteger(options.leaseMs, DEFAULT_LEASE_MS, MAX_LEASE_MS);
    this.heartbeatMs = boundedPositiveInteger(options.heartbeatMs, Math.min(DEFAULT_HEARTBEAT_MS, Math.floor(this.leaseMs / 3)), this.leaseMs);
    if (this.heartbeatMs >= this.leaseMs) throw new Error("gateway heartbeat must be shorter than its lease");
    this.#now = options.now ?? Date.now;
    this.#processAlive = options.processAlive ?? processIsAlive;
    const opened = openOwnershipDatabase(stateDir);
    this.#database = opened.database;
    this.path = opened.path;
    this.stateRootDigest = opened.stateRootDigest;
    this.signal = this.#abort.signal;
    try {
      this.#acquire();
      if (!options.disableHeartbeat) {
        this.#timer = setInterval(() => {
          try {
            if (!this.heartbeat()) this.#markLost();
          } catch {
            this.#markLost();
          }
        }, this.heartbeatMs);
        this.#timer.unref();
      }
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  get epoch(): number { return this.#epoch; }

  onLost(handler: () => void): () => void {
    this.#lostHandlers.add(handler);
    return () => this.#lostHandlers.delete(handler);
  }

  #acquire(): void {
    const now = this.#now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = leaseRow(this.#database);
      validateLeaseRow(current);
      if (current && current.state_root_digest !== this.stateRootDigest) {
        throw new GatewayInstanceOwnershipError("gateway ownership record does not match this physical state root");
      }
      if (current && current.released_at === null && parseTimestamp(current.expires_at) > now) {
        throw new GatewayInstanceOwnershipError("gateway state is already owned by an active instance");
      }
      if (current && current.released_at === null && current.owner_host_digest === this.ownerHostDigest && this.#processAlive(Number(current.owner_pid))) {
        throw new GatewayInstanceOwnershipError("gateway state owner process is still alive; refusing lease takeover");
      }
      const epoch = current ? Number(current.epoch) + 1 : 1;
      const timestamp = iso(now);
      const expiresAt = iso(now + this.leaseMs);
      this.#database.prepare(`INSERT INTO gateway_instance_lease(singleton, owner_id, owner_host_digest, state_root_digest, owner_pid, epoch, acquired_at, heartbeat_at, expires_at, released_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(singleton) DO UPDATE SET owner_id=excluded.owner_id, owner_host_digest=excluded.owner_host_digest,
          state_root_digest=excluded.state_root_digest, owner_pid=excluded.owner_pid, epoch=excluded.epoch, acquired_at=excluded.acquired_at,
          heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at, released_at=NULL`).run(
        this.ownerId, this.ownerHostDigest, this.stateRootDigest, this.ownerPid, epoch, timestamp, timestamp, expiresAt
      );
      this.#database.exec("COMMIT");
      this.#epoch = epoch;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  isOwned(): boolean {
    if (this.#closed || this.#abort.signal.aborted || this.#epoch < 1) return false;
    const row = leaseRow(this.#database);
    validateLeaseRow(row);
    return Boolean(row
      && row.owner_id === this.ownerId
      && row.state_root_digest === this.stateRootDigest
      && Number(row.epoch) === this.#epoch
      && row.released_at === null
      && parseTimestamp(row.expires_at) > this.#now());
  }

  assertOwned(): void {
    if (!this.isOwned()) {
      this.#markLost();
      throw new GatewayInstanceOwnershipError("gateway instance no longer owns this state root");
    }
  }

  heartbeat(): boolean {
    if (this.#closed || this.#abort.signal.aborted || this.#epoch < 1) return false;
    const now = this.#now();
    const result = this.#database.prepare(`UPDATE gateway_instance_lease SET heartbeat_at = ?, expires_at = ?
      WHERE singleton = 1 AND owner_id = ? AND state_root_digest = ? AND epoch = ? AND released_at IS NULL AND expires_at > ?`).run(
      iso(now), iso(now + this.leaseMs), this.ownerId, this.stateRootDigest, this.#epoch, iso(now)
    );
    const renewed = Number(result.changes) === 1;
    if (!renewed) this.#markLost();
    return renewed;
  }

  release(): void {
    if (this.#closed) return;
    if (this.#timer) clearInterval(this.#timer);
    const timestamp = iso(this.#now());
    try {
      this.#database.prepare(`UPDATE gateway_instance_lease SET released_at = ?, heartbeat_at = ?, expires_at = ?
        WHERE singleton = 1 AND owner_id = ? AND state_root_digest = ? AND epoch = ? AND released_at IS NULL`).run(
        timestamp, timestamp, timestamp, this.ownerId, this.stateRootDigest, this.#epoch
      );
    } finally {
      this.#closed = true;
      this.#abort.abort(new GatewayInstanceOwnershipError("gateway instance ownership was released"));
      this.#database.close();
    }
  }

  #markLost(): void {
    if (this.#closed || this.#abort.signal.aborted) return;
    if (this.#timer) clearInterval(this.#timer);
    this.#abort.abort(new GatewayInstanceOwnershipError("gateway instance ownership was lost"));
    for (const handler of this.#lostHandlers) {
      try { handler(); } catch {}
    }
  }
}
