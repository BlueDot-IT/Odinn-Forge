import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { withStateMutationLock } from "./state-mutation.ts";

const execFileAsync = promisify(execFile);
const MAX_JOURNAL_BYTES = 512 * 1024;
const MAX_RECOVERY_RECORDS = 256;
const MAX_CWD_BYTES = 4_096;
const MAX_REASON_BYTES = 256;
const PROCESS_IDENTITY_TIMEOUT_MS = 1_000;
const PROCESS_SESSION_TOKEN = Symbol("process-session");

export type ProcessRecoveryPhase = "launching" | "running" | "terminating" | "needs-review";
export type ProcessPresence = "present" | "absent" | "unknown";

export interface ProcessExecutionDescriptor {
  readonly workspaceRootDigest: string;
  readonly commandDigest: string;
  readonly argsDigest: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly requestDigest?: string;
}

export interface ProcessRecoveryRecord extends ProcessExecutionDescriptor {
  readonly schemaVersion: 1;
  readonly namespaceId: string;
  readonly executionId: string;
  readonly phase: ProcessRecoveryPhase;
  readonly registeredAt: string;
  readonly updatedAt: string;
  readonly pid?: number;
  readonly processGroupId?: number;
  readonly processIdentity?: string;
  readonly reasonCode?: string;
  readonly reconciliationAttempts: number;
  readonly lastAttemptAt?: string;
}

export interface ProcessRecoveryAdapter {
  inspect(record: ProcessRecoveryRecord): Promise<ProcessPresence>;
  terminate(record: ProcessRecoveryRecord): Promise<void>;
}

export interface ProcessExecutionSession {
  readonly record: ProcessRecoveryRecord;
  markRunning(pid: number): Promise<ProcessRecoveryRecord>;
  markTerminating(): Promise<ProcessRecoveryRecord>;
  settle(): Promise<void>;
  abortBeforeLaunch(): Promise<void>;
  markNeedsReview(reasonCode?: string): Promise<void>;
}

interface ProcessRecoveryJournal {
  readonly schemaVersion: 1;
  readonly namespaceId: string;
  readonly pending: readonly ProcessRecoveryRecord[];
}

export interface ProcessSupervisorOptions {
  readonly adapter?: ProcessRecoveryAdapter;
  readonly lockTimeoutMs?: number;
}

export class ProcessRecoveryError extends Error {
  readonly code: string;

  constructor(message: string, code = "PROCESS_RECOVERY_REQUIRED") {
    super(message);
    this.name = "ProcessRecoveryError";
    this.code = code;
  }
}

export function digestProcessValue(value: unknown): string {
  return createHash("sha256").update(stable(value), "utf8").digest("hex");
}

export function createProcessExecutionDescriptor({
  workspaceRoot,
  command,
  args,
  cwd,
  timeoutMs,
  maxOutputBytes,
  requestId
}: {
  workspaceRoot: string;
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  requestId?: string;
}): ProcessExecutionDescriptor {
  const normalizedRoot = resolve(workspaceRoot);
  const normalizedCwd = String(cwd);
  if (!normalizedRoot || !normalizedCwd || Buffer.byteLength(normalizedCwd, "utf8") > MAX_CWD_BYTES || /[\u0000-\u001f\u007f]/u.test(normalizedCwd)) {
    throw new ProcessRecoveryError("process recovery descriptor has an invalid cwd", "PROCESS_DESCRIPTOR_INVALID");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) {
    throw new ProcessRecoveryError("process recovery descriptor has an invalid timeout", "PROCESS_DESCRIPTOR_INVALID");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024 * 1024) {
    throw new ProcessRecoveryError("process recovery descriptor has an invalid output limit", "PROCESS_DESCRIPTOR_INVALID");
  }
  if (typeof command !== "string" || !command || command.includes("\0") || !Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new ProcessRecoveryError("process recovery descriptor has invalid command arguments", "PROCESS_DESCRIPTOR_INVALID");
  }
  return Object.freeze({
    workspaceRootDigest: digestProcessValue(normalizedRoot),
    commandDigest: digestProcessValue(command),
    argsDigest: digestProcessValue(args),
    cwd: normalizedCwd,
    timeoutMs,
    maxOutputBytes,
    ...(requestId ? { requestDigest: digestProcessValue(requestId) } : {})
  });
}

export class ProcessSupervisor {
  readonly stateDir: string;
  readonly journalPath: string;
  readonly adapter: ProcessRecoveryAdapter;
  readonly lockTimeoutMs: number;

  constructor(stateDir: string, options: ProcessSupervisorOptions = {}) {
    if (typeof stateDir !== "string" || !stateDir.trim()) throw new ProcessRecoveryError("process supervisor requires a state directory", "PROCESS_DESCRIPTOR_INVALID");
    this.stateDir = resolve(stateDir);
    this.journalPath = join(this.stateDir, "process-recovery.json");
    this.adapter = options.adapter ?? defaultProcessRecoveryAdapter;
    this.lockTimeoutMs = normalizeLockTimeout(options.lockTimeoutMs);
  }

  async execute<T>(descriptor: ProcessExecutionDescriptor, operation: (session: ProcessExecutionSession) => Promise<T>): Promise<T> {
    if (typeof operation !== "function") throw new ProcessRecoveryError("process supervisor requires an execution operation", "PROCESS_DESCRIPTOR_INVALID");
    return withStateMutationLock(this.stateDir, async () => {
      await this.reconcileUnlocked();
      const session = await this.reserve(descriptor);
      try {
        const result = await operation(session);
        if (!sessionSettled(session)) {
          await session.markNeedsReview("PROCESS_SESSION_NOT_SETTLED");
          throw new ProcessRecoveryError("process execution returned without proving cleanup", "PROCESS_CLEANUP_UNCERTAIN");
        }
        return result;
      } catch (error) {
        if (!sessionSettled(session)) {
          await session.markNeedsReview(error instanceof ProcessRecoveryError ? error.code : "PROCESS_OUTCOME_UNCERTAIN").catch(() => undefined);
        }
        throw error;
      }
    }, { timeoutMs: this.lockTimeoutMs });
  }

  async reconcile(): Promise<Readonly<{ ok: true; pending: number }>> {
    return withStateMutationLock(this.stateDir, async () => {
      await this.reconcileUnlocked();
      const journal = await this.readJournal();
      return Object.freeze({ ok: true as const, pending: journal.pending.length });
    }, { timeoutMs: this.lockTimeoutMs });
  }

  async status(): Promise<Readonly<{ schemaVersion: 1; pending: number }>> {
    return withStateMutationLock(this.stateDir, async () => {
      const journal = await this.readJournal();
      return Object.freeze({ schemaVersion: 1 as const, pending: journal.pending.length });
    }, { timeoutMs: this.lockTimeoutMs });
  }

  async readJournal(): Promise<ProcessRecoveryJournal> {
    await this.ensureStateDirectory();
    try {
      const metadata = await lstat(this.journalPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_JOURNAL_BYTES
        || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
        throw new ProcessRecoveryError("process recovery journal is unsafe; process execution remains quarantined");
      }
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        const journal = Object.freeze({ schemaVersion: 1 as const, namespaceId: `pex_${randomBytes(18).toString("hex")}`, pending: Object.freeze([]) });
        await this.writeJournal(journal);
        return journal;
      }
      if (error instanceof ProcessRecoveryError) throw error;
      throw new ProcessRecoveryError("process recovery journal could not be inspected; process execution remains quarantined");
    }
    let value: unknown;
    try { value = JSON.parse(await readFile(this.journalPath, "utf8")); }
    catch { throw new ProcessRecoveryError("process recovery journal is invalid; process execution remains quarantined"); }
    return normalizeJournal(value);
  }

  async writeJournal(input: ProcessRecoveryJournal): Promise<void> {
    const journal = normalizeJournal(input);
    await this.ensureStateDirectory();
    const temporary = join(this.stateDir, `.process-recovery.${process.pid}.${randomUUID()}.tmp`);
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
      throw new ProcessRecoveryError(`process recovery journal could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async reserve(descriptor: ProcessExecutionDescriptor): Promise<ProcessExecutionSession> {
    const journal = await this.readJournal();
    if (journal.pending.length >= MAX_RECOVERY_RECORDS) throw new ProcessRecoveryError("process recovery journal is full; process execution remains quarantined", "PROCESS_BACKEND_QUARANTINED");
    const now = new Date().toISOString();
    const record = normalizeRecord({
      schemaVersion: 1,
      ...descriptor,
      namespaceId: journal.namespaceId,
      executionId: `pexec_${randomUUID().replaceAll("-", "")}`,
      phase: "launching",
      registeredAt: now,
      updatedAt: now,
      reconciliationAttempts: 0
    });
    await this.writeJournal({ ...journal, pending: [...journal.pending, record] });
    return new ProcessExecutionSessionImpl(this, this.adapter, record);
  }

  private async reconcileUnlocked(): Promise<void> {
    const journal = await this.readJournal();
    if (!journal.pending.length) return;
    const retained: ProcessRecoveryRecord[] = [];
    for (const current of journal.pending) {
      const before = await this.adapter.inspect(current).catch(() => "unknown" as const);
      if (before === "present") await this.adapter.terminate(current).catch(() => undefined);
      const after = before === "absent" ? "absent" : await this.adapter.inspect(current).catch(() => "unknown" as const);
      const now = new Date().toISOString();
      retained.push(normalizeRecord({
        ...current,
        phase: "needs-review",
        reasonCode: after === "absent" ? "PROCESS_OUTCOME_UNCERTAIN" : "PROCESS_RECOVERY_REQUIRED",
        updatedAt: now,
        lastAttemptAt: now,
        reconciliationAttempts: current.reconciliationAttempts + 1
      }));
    }
    await this.writeJournal({ ...journal, pending: retained });
    throw new ProcessRecoveryError(`process execution remains quarantined because ${retained.length} outcome${retained.length === 1 ? "" : "s"} require review`, "PROCESS_RECOVERY_REQUIRED");
  }

  private async ensureStateDirectory(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.stateDir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new ProcessRecoveryError("process supervisor state directory is unsafe", "PROCESS_DESCRIPTOR_INVALID");
    await chmod(this.stateDir, 0o700);
  }

  async update(record: ProcessRecoveryRecord, patch: Partial<ProcessRecoveryRecord>, token?: symbol): Promise<ProcessRecoveryRecord> {
    if (token !== PROCESS_SESSION_TOKEN) throw new ProcessRecoveryError("process recovery updates require an active execution session", "PROCESS_RECOVERY_REQUIRED");
    const journal = await this.readJournal();
    const index = journal.pending.findIndex((entry) => entry.executionId === record.executionId);
    if (index < 0) throw new ProcessRecoveryError("process recovery reservation is missing", "PROCESS_RECOVERY_REQUIRED");
    const current = journal.pending[index];
    if (current.updatedAt !== record.updatedAt) throw new ProcessRecoveryError("process recovery reservation changed concurrently", "PROCESS_RECOVERY_CONFLICT");
    const allowed = new Set(["phase", "pid", "processGroupId", "processIdentity", "reasonCode", "lastAttemptAt", "reconciliationAttempts"]);
    if (Object.keys(patch).some((key) => !allowed.has(key))) throw new ProcessRecoveryError("process recovery attempted to change immutable identity", "PROCESS_RECOVERY_CONFLICT");
    const updated = normalizeRecord({ ...current, ...patch, updatedAt: new Date().toISOString() });
    assertProcessTransition(current, updated);
    const pending = [...journal.pending];
    pending[index] = updated;
    await this.writeJournal({ ...journal, pending });
    return updated;
  }

  async clear(record: ProcessRecoveryRecord, token?: symbol): Promise<void> {
    if (token !== PROCESS_SESSION_TOKEN) throw new ProcessRecoveryError("process recovery clearing requires an active execution session", "PROCESS_RECOVERY_REQUIRED");
    const journal = await this.readJournal();
    const current = journal.pending.find((entry) => entry.executionId === record.executionId);
    if (!current) throw new ProcessRecoveryError("process recovery reservation is missing", "PROCESS_RECOVERY_REQUIRED");
    if (current.updatedAt !== record.updatedAt) throw new ProcessRecoveryError("process recovery reservation changed concurrently", "PROCESS_RECOVERY_CONFLICT");
    if (current.phase === "launching") {
      if (current.pid !== undefined) throw new ProcessRecoveryError("launching process reservation unexpectedly has a pid", "PROCESS_CLEANUP_UNCERTAIN");
    } else if (current.phase === "needs-review" || current.pid === undefined || await this.adapter.inspect(current).catch(() => "unknown" as const) !== "absent") {
      throw new ProcessRecoveryError("process recovery clearing requires positive absence proof", "PROCESS_CLEANUP_UNCERTAIN");
    }
    await this.writeJournal({ ...journal, pending: journal.pending.filter((entry) => entry.executionId !== record.executionId) });
  }
}

export async function reconcileProcessRecovery(stateDir: string, options: ProcessSupervisorOptions = {}) {
  return new ProcessSupervisor(stateDir, options).reconcile();
}

class ProcessExecutionSessionImpl implements ProcessExecutionSession {
  private current: ProcessRecoveryRecord;
  private settled = false;
  private transition: Promise<unknown> = Promise.resolve();
  private readonly supervisor: ProcessSupervisor;
  private readonly adapter: ProcessRecoveryAdapter;

  constructor(supervisor: ProcessSupervisor, adapter: ProcessRecoveryAdapter, record: ProcessRecoveryRecord) {
    this.supervisor = supervisor;
    this.adapter = adapter;
    this.current = record;
  }

  get record(): ProcessRecoveryRecord { return this.current; }

  markRunning(pid: number): Promise<ProcessRecoveryRecord> {
    return this.enqueue(async () => {
      if (!Number.isSafeInteger(pid) || pid < 1) throw new ProcessRecoveryError("process did not provide a valid pid", "PROCESS_LAUNCH_FAILED");
      if (this.settled || this.current.phase !== "launching" || this.current.pid !== undefined) {
        throw new ProcessRecoveryError("process launch state changed before its pid was recorded", "PROCESS_LAUNCH_FAILED");
      }
      const processIdentity = await readProcessIdentity(pid);
      this.current = await this.supervisor.update(this.current, {
        phase: "running",
        pid,
        ...(process.platform === "win32" ? {} : { processGroupId: pid }),
        ...(processIdentity ? { processIdentity } : {})
      }, PROCESS_SESSION_TOKEN);
      return this.current;
    });
  }

  markTerminating(): Promise<ProcessRecoveryRecord> {
    return this.enqueue(async () => {
      if (this.settled) throw new ProcessRecoveryError("process cleanup was already settled", "PROCESS_CLEANUP_UNCERTAIN");
      if (this.current.phase === "terminating") return this.current;
      if (this.current.phase === "launching" && this.current.pid === undefined) {
        this.current = await this.markNeedsReviewNow("PROCESS_LAUNCH_STATE_UNCERTAIN");
        return this.current;
      }
      if (this.current.phase !== "running" || this.current.pid === undefined) {
        throw new ProcessRecoveryError("process termination state is invalid", "PROCESS_CLEANUP_UNCERTAIN");
      }
      this.current = await this.supervisor.update(this.current, { phase: "terminating" }, PROCESS_SESSION_TOKEN);
      return this.current;
    });
  }

  settle(): Promise<void> {
    return this.enqueue(async () => {
      if (this.settled) return;
      if (this.current.phase === "needs-review" || this.current.pid === undefined) {
        throw new ProcessRecoveryError("process cleanup could not prove a managed process identity", "PROCESS_CLEANUP_UNCERTAIN");
      }
      let located = await this.adapter.inspect(this.current).catch(() => "unknown" as const);
      if (located === "present") {
        try {
          await this.adapter.terminate(this.current);
          located = await inspectUntilAbsent(this.adapter, this.current);
        } catch {
          located = "unknown";
        }
      }
      if (located !== "absent") {
        await this.markNeedsReviewNow("PROCESS_CLEANUP_UNCERTAIN").catch(() => undefined);
        throw new ProcessRecoveryError("process cleanup could not prove the managed process tree absent", "PROCESS_CLEANUP_UNCERTAIN");
      }
      try {
        await this.supervisor.clear(this.current, PROCESS_SESSION_TOKEN);
      } catch (error) {
        await this.markNeedsReviewNow("PROCESS_CLEANUP_UNCERTAIN").catch(() => undefined);
        throw error;
      }
      this.settled = true;
    });
  }

  abortBeforeLaunch(): Promise<void> {
    return this.enqueue(async () => {
      if (this.settled) return;
      if (this.current.phase !== "launching" || this.current.pid !== undefined) {
        throw new ProcessRecoveryError("process reservation cannot be aborted after launch", "PROCESS_CLEANUP_UNCERTAIN");
      }
      await this.supervisor.clear(this.current, PROCESS_SESSION_TOKEN);
      this.settled = true;
    });
  }

  markNeedsReview(reasonCode = "PROCESS_OUTCOME_UNCERTAIN"): Promise<void> {
    return this.enqueue(async () => {
      if (this.settled) return;
      this.current = await this.markNeedsReviewNow(reasonCode);
    });
  }

  isSettled(): boolean { return this.settled; }

  private async markNeedsReviewNow(reasonCode = "PROCESS_OUTCOME_UNCERTAIN"): Promise<ProcessRecoveryRecord> {
    this.current = await this.supervisor.update(this.current, {
      phase: "needs-review",
      reasonCode: boundedReason(reasonCode),
      lastAttemptAt: new Date().toISOString(),
      reconciliationAttempts: this.current.reconciliationAttempts + 1
    }, PROCESS_SESSION_TOKEN);
    return this.current;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.transition.then(operation, operation);
    this.transition = next.then(() => undefined, () => undefined);
    return next;
  }
}

function sessionSettled(session: ProcessExecutionSession): boolean {
  return session instanceof ProcessExecutionSessionImpl && session.isSettled();
}

function assertProcessTransition(current: ProcessRecoveryRecord, updated: ProcessRecoveryRecord): void {
  const allowed = current.phase === "launching"
    ? new Set<ProcessRecoveryPhase>(["launching", "running", "needs-review"])
    : current.phase === "running"
      ? new Set<ProcessRecoveryPhase>(["running", "terminating", "needs-review"])
      : current.phase === "terminating"
        ? new Set<ProcessRecoveryPhase>(["terminating", "needs-review"])
        : new Set<ProcessRecoveryPhase>(["needs-review"]);
  if (!allowed.has(updated.phase)) throw new ProcessRecoveryError("process recovery phase transition is invalid", "PROCESS_RECOVERY_CONFLICT");
  for (const key of ["workspaceRootDigest", "commandDigest", "argsDigest", "cwd", "timeoutMs", "maxOutputBytes", "requestDigest", "namespaceId", "executionId", "registeredAt"] as const) {
    if (current[key] !== updated[key]) throw new ProcessRecoveryError("process recovery identity changed", "PROCESS_RECOVERY_CONFLICT");
  }
  if (current.pid !== undefined && updated.pid !== current.pid) throw new ProcessRecoveryError("process recovery pid changed", "PROCESS_RECOVERY_CONFLICT");
  if (current.processGroupId !== undefined && updated.processGroupId !== current.processGroupId) throw new ProcessRecoveryError("process recovery process group changed", "PROCESS_RECOVERY_CONFLICT");
  if (current.processIdentity !== undefined && updated.processIdentity !== current.processIdentity) throw new ProcessRecoveryError("process recovery identity token changed", "PROCESS_RECOVERY_CONFLICT");
  if (updated.reconciliationAttempts < current.reconciliationAttempts || updated.reconciliationAttempts > current.reconciliationAttempts + 1) {
    throw new ProcessRecoveryError("process recovery attempt counter changed unexpectedly", "PROCESS_RECOVERY_CONFLICT");
  }
}

const defaultProcessRecoveryAdapter: ProcessRecoveryAdapter = {
  async inspect(record) {
    if (!record.pid) return "unknown";
    const identity = await readProcessIdentity(record.pid);
    const group = await inspectProcessGroup(record.processGroupId);
    if (identity && record.processIdentity && identity !== record.processIdentity) return group === "present" ? "unknown" : "absent";
    if (identity && (!record.processIdentity || identity === record.processIdentity)) return "present";
    if (group === "present") return record.processIdentity ? "present" : "unknown";
    if (group === "unknown") return "unknown";
    if (!identity) {
      try { process.kill(record.pid, 0); return "unknown"; }
      catch (error) { return isCode(error, "ESRCH") ? "absent" : "unknown"; }
    }
    return "absent";
  },
  async terminate(record) {
    if (!record.pid || (await this.inspect(record)) !== "present") throw new ProcessRecoveryError("process identity could not be proven for recovery termination", "PROCESS_RECOVERY_REQUIRED");
    if (process.platform === "win32") throw new ProcessRecoveryError("Windows process recovery cannot terminate an unverified process identity", "PROCESS_RECOVERY_REQUIRED");
    const groupId = record.processGroupId ?? record.pid;
    try { process.kill(-groupId, "SIGKILL"); }
    catch { try { process.kill(record.pid, "SIGKILL"); } catch (error) { if (!isCode(error, "ESRCH")) throw error; } }
  }
};

async function inspectUntilAbsent(adapter: ProcessRecoveryAdapter, record: ProcessRecoveryRecord): Promise<ProcessPresence> {
  let located: ProcessPresence = "unknown";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    located = await adapter.inspect(record).catch(() => "unknown" as const);
    if (located === "absent") return located;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return located;
}

async function inspectProcessGroup(groupId: number | undefined): Promise<ProcessPresence> {
  if (!groupId || process.platform === "win32") return "absent";
  try {
    process.kill(-groupId, 0);
    return "present";
  } catch (error) {
    if (isCode(error, "ESRCH")) return "absent";
    return "unknown";
  }
}

async function readProcessIdentity(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const closing = stat.lastIndexOf(")");
      if (closing < 0) return undefined;
      const fields = stat.slice(closing + 2).trim().split(/\s+/u);
      const startTime = fields[19];
      return startTime ? `linux:${startTime}` : undefined;
    } catch { return undefined; }
  }
  if (process.platform === "darwin") {
    try {
      const result = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: PROCESS_IDENTITY_TIMEOUT_MS, maxBuffer: 8 * 1024 });
      const started = String(result.stdout).trim();
      return started ? `darwin:${digestProcessValue(started)}` : undefined;
    } catch { return undefined; }
  }
  return undefined;
}

function normalizeJournal(value: unknown): ProcessRecoveryJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProcessRecoveryError("process recovery journal is invalid; process execution remains quarantined");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !/^pex_[a-f0-9]{36}$/u.test(String(record.namespaceId)) || !Array.isArray(record.pending)
    || record.pending.length > MAX_RECOVERY_RECORDS || Object.keys(record).some((key) => !["schemaVersion", "namespaceId", "pending"].includes(key))) {
    throw new ProcessRecoveryError("process recovery journal is invalid; process execution remains quarantined");
  }
  const pending = record.pending.map(normalizeRecord);
  if (new Set(pending.map((entry) => entry.executionId)).size !== pending.length || pending.some((entry) => entry.namespaceId !== record.namespaceId)) {
    throw new ProcessRecoveryError("process recovery journal contains duplicate or foreign identities; process execution remains quarantined");
  }
  return Object.freeze({ schemaVersion: 1, namespaceId: String(record.namespaceId), pending: Object.freeze(pending) });
}

function normalizeRecord(value: unknown): ProcessRecoveryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProcessRecoveryError("process recovery record is invalid");
  const record = value as Record<string, unknown>;
  const allowed = ["schemaVersion", "workspaceRootDigest", "commandDigest", "argsDigest", "cwd", "timeoutMs", "maxOutputBytes", "requestDigest", "namespaceId", "executionId", "phase", "registeredAt", "updatedAt", "pid", "processGroupId", "processIdentity", "reasonCode", "reconciliationAttempts", "lastAttemptAt"];
  if (Object.keys(record).some((key) => !allowed.includes(key))
    || record.schemaVersion !== 1
    || !/^pex_[a-f0-9]{36}$/u.test(String(record.namespaceId))
    || !/^pexec_[a-f0-9]{32}$/u.test(String(record.executionId))
    || !/^[a-f0-9]{64}$/u.test(String(record.workspaceRootDigest))
    || !/^[a-f0-9]{64}$/u.test(String(record.commandDigest))
    || !/^[a-f0-9]{64}$/u.test(String(record.argsDigest))
    || typeof record.cwd !== "string" || !record.cwd || Buffer.byteLength(record.cwd, "utf8") > MAX_CWD_BYTES || /[\u0000-\u001f\u007f]/u.test(record.cwd)
    || !["launching", "running", "terminating", "needs-review"].includes(String(record.phase))
    || !validTimestamp(record.registeredAt) || !validTimestamp(record.updatedAt)
    || (record.requestDigest !== undefined && !/^[a-f0-9]{64}$/u.test(String(record.requestDigest)))
    || (record.pid !== undefined && (!Number.isSafeInteger(record.pid) || Number(record.pid) < 1))
    || (record.processGroupId !== undefined && (!Number.isSafeInteger(record.processGroupId) || Number(record.processGroupId) < 1))
    || (record.processIdentity !== undefined && (typeof record.processIdentity !== "string" || record.processIdentity.length > 256))
    || (record.reasonCode !== undefined && boundedReason(record.reasonCode) !== record.reasonCode)
    || !Number.isSafeInteger(record.timeoutMs) || Number(record.timeoutMs) < 1 || Number(record.timeoutMs) > 86_400_000
    || !Number.isSafeInteger(record.maxOutputBytes) || Number(record.maxOutputBytes) < 1 || Number(record.maxOutputBytes) > 16 * 1024 * 1024
    || !Number.isSafeInteger(record.reconciliationAttempts) || Number(record.reconciliationAttempts) < 0
    || (record.lastAttemptAt !== undefined && !validTimestamp(record.lastAttemptAt))) {
    throw new ProcessRecoveryError("process recovery record is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    workspaceRootDigest: String(record.workspaceRootDigest),
    commandDigest: String(record.commandDigest),
    argsDigest: String(record.argsDigest),
    cwd: String(record.cwd),
    timeoutMs: Number(record.timeoutMs),
    maxOutputBytes: Number(record.maxOutputBytes),
    ...(record.requestDigest ? { requestDigest: String(record.requestDigest) } : {}),
    namespaceId: String(record.namespaceId),
    executionId: String(record.executionId),
    phase: record.phase as ProcessRecoveryPhase,
    registeredAt: String(record.registeredAt),
    updatedAt: String(record.updatedAt),
    ...(record.pid !== undefined ? { pid: Number(record.pid) } : {}),
    ...(record.processGroupId !== undefined ? { processGroupId: Number(record.processGroupId) } : {}),
    ...(record.processIdentity ? { processIdentity: String(record.processIdentity) } : {}),
    ...(record.reasonCode ? { reasonCode: String(record.reasonCode) } : {}),
    reconciliationAttempts: Number(record.reconciliationAttempts),
    ...(record.lastAttemptAt ? { lastAttemptAt: String(record.lastAttemptAt) } : {})
  });
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function boundedReason(value: unknown): string {
  const reason = String(value ?? "");
  return /^[A-Z][A-Z0-9_]{0,127}$/u.test(reason) && Buffer.byteLength(reason, "utf8") <= MAX_REASON_BYTES ? reason : "PROCESS_RECOVERY_REQUIRED";
}

function validTimestamp(value: unknown): boolean {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function normalizeLockTimeout(value: number | undefined): number {
  const timeout = value ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new ProcessRecoveryError("process supervisor lock timeout is invalid", "PROCESS_DESCRIPTOR_INVALID");
  return timeout;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
