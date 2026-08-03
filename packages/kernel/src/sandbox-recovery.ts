import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withStateMutationLock } from "./state-mutation.ts";

export type SandboxRecoveryBackend = "docker" | "podman";
export type SandboxRecoveryPhase = "creating" | "created" | "attested" | "starting" | "running" | "cleanup-uncertain";

export interface SandboxRecoveryIdentity {
  readonly namespaceId: string;
  readonly executionId: string;
  readonly backend: SandboxRecoveryBackend;
  readonly containerName: string;
  readonly engineBindingDigest: string;
}

export interface SandboxRecoveryRecord extends SandboxRecoveryIdentity {
  readonly profileDigest: string;
  readonly imageDigest: string;
  readonly phase: SandboxRecoveryPhase;
  readonly registeredAt: string;
  readonly updatedAt: string;
  readonly reasonCode?: string;
  readonly reconciliationAttempts: number;
  readonly lastAttemptAt?: string;
}

export interface SandboxRecoveryAdapter {
  control(command: string, args: readonly string[]): Promise<void>;
  locateManagedContainer(command: string, identity: SandboxRecoveryIdentity): Promise<"present" | "absent" | "unknown">;
}

interface SandboxRecoveryJournal {
  readonly schemaVersion: 1;
  readonly namespaceId: string;
  readonly pending: readonly SandboxRecoveryRecord[];
}

const MAX_JOURNAL_BYTES = 256 * 1024;
const MAX_RECOVERY_RECORDS = 1_024;
const LOCK_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;
const PHASES = new Set<SandboxRecoveryPhase>(["creating", "created", "attested", "starting", "running", "cleanup-uncertain"]);

export class SandboxRecoveryError extends Error {
  readonly code: string;

  constructor(message: string, code = "SANDBOX_RECOVERY_REQUIRED") {
    super(message);
    this.name = "SandboxRecoveryError";
    this.code = code;
  }
}

export class SandboxRecoverySession {
  readonly coordinator: SandboxRecoveryCoordinator;
  readonly adapter: SandboxRecoveryAdapter;
  private executionId?: string;

  constructor(coordinator: SandboxRecoveryCoordinator, adapter: SandboxRecoveryAdapter) {
    this.coordinator = coordinator;
    this.adapter = adapter;
  }

  async reserve(input: Omit<SandboxRecoveryRecord, "namespaceId" | "phase" | "registeredAt" | "updatedAt" | "reconciliationAttempts">): Promise<SandboxRecoveryRecord> {
    if (this.executionId) throw new SandboxRecoveryError("sandbox recovery session already has a reservation", "SANDBOX_RECOVERY_INVALID");
    const journal = await this.coordinator.readJournal();
    const now = new Date().toISOString();
    const record = normalizeRecord({
      ...input,
      namespaceId: journal.namespaceId,
      phase: "creating",
      registeredAt: now,
      updatedAt: now,
      reconciliationAttempts: 0
    });
    if (journal.pending.length >= MAX_RECOVERY_RECORDS || journal.pending.some((entry) => entry.executionId === record.executionId || entry.containerName === record.containerName)) {
      throw new SandboxRecoveryError("sandbox recovery journal cannot accept another execution", "SANDBOX_BACKEND_QUARANTINED");
    }
    await this.coordinator.writeJournal({ ...journal, pending: [...journal.pending, record] });
    this.executionId = record.executionId;
    return record;
  }

  async transition(phase: SandboxRecoveryPhase, reasonCode?: string): Promise<SandboxRecoveryRecord> {
    if (!this.executionId || !PHASES.has(phase)) throw new SandboxRecoveryError("sandbox recovery transition is invalid", "SANDBOX_RECOVERY_INVALID");
    const journal = await this.coordinator.readJournal();
    const index = journal.pending.findIndex((entry) => entry.executionId === this.executionId);
    if (index < 0) throw new SandboxRecoveryError("sandbox recovery reservation is missing", "SANDBOX_BACKEND_QUARANTINED");
    const current = journal.pending[index]!;
    const updated = normalizeRecord({
      ...current,
      phase,
      updatedAt: new Date().toISOString(),
      ...(reasonCode ? { reasonCode: boundedCode(reasonCode) } : {})
    });
    const pending = [...journal.pending];
    pending[index] = updated;
    await this.coordinator.writeJournal({ ...journal, pending });
    return updated;
  }

  async proveAbsentAndClear(): Promise<void> {
    if (!this.executionId) return;
    const journal = await this.coordinator.readJournal();
    const current = journal.pending.find((entry) => entry.executionId === this.executionId);
    if (!current) {
      this.executionId = undefined;
      return;
    }
    const located = await this.adapter.locateManagedContainer(current.backend, current).catch(() => "unknown" as const);
    if (located !== "absent") {
      await this.markUncertain(journal, current, "SANDBOX_CLEANUP_UNCERTAIN");
      throw new SandboxRecoveryError("sandbox cleanup could not prove the managed container absent; backend remains quarantined");
    }
    await this.coordinator.writeJournal({ ...journal, pending: journal.pending.filter((entry) => entry.executionId !== current.executionId) });
    this.executionId = undefined;
  }

  private async markUncertain(journal: SandboxRecoveryJournal, current: SandboxRecoveryRecord, reasonCode: string): Promise<void> {
    const now = new Date().toISOString();
    const updated = normalizeRecord({
      ...current,
      phase: "cleanup-uncertain",
      reasonCode: boundedCode(reasonCode),
      updatedAt: now,
      lastAttemptAt: now,
      reconciliationAttempts: current.reconciliationAttempts + 1
    });
    await this.coordinator.writeJournal({
      ...journal,
      pending: journal.pending.map((entry) => entry.executionId === current.executionId ? updated : entry)
    });
  }
}

export class SandboxRecoveryCoordinator {
  readonly stateDir: string;
  readonly journalPath: string;
  readonly lockPath: string;

  constructor(stateDir: string) {
    if (typeof stateDir !== "string" || !stateDir.trim()) throw new SandboxRecoveryError("sandbox recovery requires a state directory", "SANDBOX_RECOVERY_INVALID");
    this.stateDir = resolve(stateDir);
    this.journalPath = join(this.stateDir, "sandbox-recovery.json");
    this.lockPath = join(this.stateDir, "sandbox-execution.lock");
  }

  async runExclusive<T>(adapter: SandboxRecoveryAdapter, operation: (session: SandboxRecoverySession) => Promise<T>): Promise<T> {
    if (!adapter?.locateManagedContainer) throw new SandboxRecoveryError("sandbox recovery requires exact managed-container lookup", "SANDBOX_RECOVERY_INVALID");
    // State backup, restore, migration, and sandbox execution share this outer
    // lock. The sandbox-specific lease is acquired second and held for the
    // entire container lifetime so the durable journal cannot be moved or
    // snapshotted between reservation and cleanup.
    return withStateMutationLock(this.stateDir, async () => {
      const release = await this.acquireLock();
      try {
        await this.reconcileUnlocked(adapter);
        return await operation(new SandboxRecoverySession(this, adapter));
      } finally {
        await release();
      }
    });
  }

  async status(): Promise<Readonly<{ schemaVersion: 1; pending: number }>> {
    const release = await this.acquireLock();
    try {
      const journal = await this.readJournal();
      return Object.freeze({ schemaVersion: 1, pending: journal.pending.length });
    } finally {
      await release();
    }
  }

  async readJournal(): Promise<SandboxRecoveryJournal> {
    await this.ensureStateDirectory();
    try {
      const metadata = await lstat(this.journalPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_JOURNAL_BYTES || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
        throw new SandboxRecoveryError("sandbox recovery journal is unsafe; backend remains quarantined");
      }
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        const journal = Object.freeze({ schemaVersion: 1 as const, namespaceId: `sbx_${randomBytes(18).toString("hex")}`, pending: Object.freeze([]) });
        await this.writeJournal(journal);
        return journal;
      }
      if (error instanceof SandboxRecoveryError) throw error;
      throw new SandboxRecoveryError("sandbox recovery journal could not be inspected; backend remains quarantined");
    }
    let value: unknown;
    try { value = JSON.parse(await readFile(this.journalPath, "utf8")); }
    catch { throw new SandboxRecoveryError("sandbox recovery journal is invalid; backend remains quarantined"); }
    return normalizeJournal(value);
  }

  async writeJournal(input: SandboxRecoveryJournal): Promise<void> {
    const journal = normalizeJournal(input);
    await this.ensureStateDirectory();
    const temporary = join(this.stateDir, `.sandbox-recovery.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.journalPath);
      await chmod(this.journalPath, 0o600);
      const directory = await open(this.stateDir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new SandboxRecoveryError(`sandbox recovery journal could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async reconcileUnlocked(adapter: SandboxRecoveryAdapter): Promise<void> {
    const journal = await this.readJournal();
    if (!journal.pending.length) return;
    const retained: SandboxRecoveryRecord[] = [];
    for (const current of journal.pending) {
      const before = await adapter.locateManagedContainer(current.backend, current).catch(() => "unknown" as const);
      if (before === "absent" && current.reasonCode !== "SANDBOX_CREATE_UNCERTAIN") continue;
      // A create request that failed or timed out can still materialize later
      // in the daemon. A point-in-time absence cannot safely clear that
      // ambiguity; retain the record for explicit operator recovery.
      if (before === "absent" && current.reasonCode === "SANDBOX_CREATE_UNCERTAIN") {
        const now = new Date().toISOString();
        retained.push(normalizeRecord({
          ...current,
          phase: "cleanup-uncertain",
          updatedAt: now,
          lastAttemptAt: now,
          reconciliationAttempts: current.reconciliationAttempts + 1
        }));
        continue;
      }
      if (before !== "present") {
        const now = new Date().toISOString();
        retained.push(normalizeRecord({
          ...current,
          phase: "cleanup-uncertain",
          reasonCode: "SANDBOX_RECOVERY_REQUIRED",
          updatedAt: now,
          lastAttemptAt: now,
          reconciliationAttempts: current.reconciliationAttempts + 1
        }));
        continue;
      }
      await adapter.control(current.backend, ["kill", current.containerName]).catch(() => undefined);
      await adapter.control(current.backend, ["wait", current.containerName]).catch(() => undefined);
      await adapter.control(current.backend, ["rm", "--force", "--volumes", current.containerName]).catch(() => undefined);
      const located = await adapter.locateManagedContainer(current.backend, current).catch(() => "unknown" as const);
      if (located !== "absent") {
        const now = new Date().toISOString();
        retained.push(normalizeRecord({
          ...current,
          phase: "cleanup-uncertain",
          reasonCode: "SANDBOX_RECOVERY_REQUIRED",
          updatedAt: now,
          lastAttemptAt: now,
          reconciliationAttempts: current.reconciliationAttempts + 1
        }));
      }
    }
    await this.writeJournal({ ...journal, pending: retained });
    if (retained.length) throw new SandboxRecoveryError(`sandbox backend remains quarantined because ${retained.length} managed container${retained.length === 1 ? "" : "s"} could not be proven absent`);
  }

  private async ensureStateDirectory(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.stateDir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new SandboxRecoveryError("sandbox recovery state directory is unsafe", "SANDBOX_RECOVERY_INVALID");
    await chmod(this.stateDir, 0o700);
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await this.ensureStateDirectory();
    const token = randomBytes(18).toString("hex");
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw new SandboxRecoveryError("sandbox execution lease could not be acquired", "SANDBOX_BACKEND_QUARANTINED");
        if (await removeDeadLock(this.lockPath)) continue;
        if (Date.now() >= deadline) throw new SandboxRecoveryError("another sandbox execution holds the state lease", "SANDBOX_BACKEND_BUSY");
        await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS));
      }
    }
    return async () => {
      try {
        const current = JSON.parse(await readFile(this.lockPath, "utf8"));
        if (current?.token === token) await rm(this.lockPath);
      } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
      }
    };
  }
}

function normalizeJournal(value: unknown): SandboxRecoveryJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SandboxRecoveryError("sandbox recovery journal is invalid; backend remains quarantined");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !/^sbx_[a-f0-9]{36}$/u.test(String(record.namespaceId)) || !Array.isArray(record.pending)
    || record.pending.length > MAX_RECOVERY_RECORDS || Object.keys(record).some((key) => !["schemaVersion", "namespaceId", "pending"].includes(key))) {
    throw new SandboxRecoveryError("sandbox recovery journal is invalid; backend remains quarantined");
  }
  const pending = record.pending.map(normalizeRecord);
  if (new Set(pending.map((entry) => entry.executionId)).size !== pending.length || new Set(pending.map((entry) => entry.containerName)).size !== pending.length
    || pending.some((entry) => entry.namespaceId !== record.namespaceId)) {
    throw new SandboxRecoveryError("sandbox recovery journal contains duplicate or foreign identities; backend remains quarantined");
  }
  return Object.freeze({ schemaVersion: 1, namespaceId: String(record.namespaceId), pending: Object.freeze(pending) });
}

function normalizeRecord(value: unknown): SandboxRecoveryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SandboxRecoveryError("sandbox recovery record is invalid");
  const record = value as Record<string, unknown>;
  const allowed = ["namespaceId", "executionId", "backend", "containerName", "engineBindingDigest", "profileDigest", "imageDigest", "phase", "registeredAt", "updatedAt", "reasonCode", "reconciliationAttempts", "lastAttemptAt"];
  if (Object.keys(record).some((key) => !allowed.includes(key))
    || !/^sbx_[a-f0-9]{36}$/u.test(String(record.namespaceId))
    || !/^sbxexec_[a-f0-9]{32}$/u.test(String(record.executionId))
    || !["docker", "podman"].includes(String(record.backend))
    || !/^odinn-[a-z0-9-]{8,100}$/u.test(String(record.containerName))
    || !/^[a-f0-9]{64}$/u.test(String(record.engineBindingDigest))
    || !/^[a-f0-9]{64}$/u.test(String(record.profileDigest))
    || !/^sha256:[a-f0-9]{64}$/u.test(String(record.imageDigest))
    || !PHASES.has(record.phase as SandboxRecoveryPhase)
    || !validTimestamp(record.registeredAt) || !validTimestamp(record.updatedAt)
    || (record.lastAttemptAt !== undefined && !validTimestamp(record.lastAttemptAt))
    || (record.reasonCode !== undefined && boundedCode(record.reasonCode) !== record.reasonCode)
    || !Number.isSafeInteger(record.reconciliationAttempts) || Number(record.reconciliationAttempts) < 0) {
    throw new SandboxRecoveryError("sandbox recovery record is invalid");
  }
  return Object.freeze({
    namespaceId: String(record.namespaceId),
    executionId: String(record.executionId),
    backend: record.backend as SandboxRecoveryBackend,
    containerName: String(record.containerName),
    engineBindingDigest: String(record.engineBindingDigest),
    profileDigest: String(record.profileDigest),
    imageDigest: String(record.imageDigest),
    phase: record.phase as SandboxRecoveryPhase,
    registeredAt: String(record.registeredAt),
    updatedAt: String(record.updatedAt),
    ...(record.reasonCode ? { reasonCode: String(record.reasonCode) } : {}),
    reconciliationAttempts: Number(record.reconciliationAttempts),
    ...(record.lastAttemptAt ? { lastAttemptAt: String(record.lastAttemptAt) } : {})
  });
}

function boundedCode(value: unknown): string {
  const code = String(value ?? "");
  return /^[A-Z][A-Z0-9_]{0,127}$/u.test(code) ? code : "SANDBOX_RECOVERY_REQUIRED";
}

function validTimestamp(value: unknown): boolean {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

async function removeDeadLock(path: string): Promise<boolean> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { return isCode(error, "ENOENT"); }
  let owner: { pid?: unknown };
  try { owner = JSON.parse(raw); }
  catch { return false; }
  if (!Number.isInteger(owner.pid) || Number(owner.pid) < 1 || processExists(Number(owner.pid))) return false;
  try {
    if (await readFile(path, "utf8") !== raw) return false;
    await rm(path);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return true;
    throw error;
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !isCode(error, "ESRCH"); }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
