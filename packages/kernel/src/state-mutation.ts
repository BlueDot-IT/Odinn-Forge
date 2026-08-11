import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;

export type StateMutationLockOptions = {
  timeoutMs?: number;
};

/**
 * Serialize mutations to one Odinn state directory across CLI and gateway
 * processes. The lock lives beside the state directory so acquiring it never
 * creates a fresh state as a side effect.
 */
export async function withStateMutationLock<T>(
  stateDir: string,
  operation: () => Promise<T>,
  options: StateMutationLockOptions = {}
): Promise<T> {
  const root = resolve(stateDir);
  const parent = dirname(root);
  const lockPath = join(parent, `.${basename(root)}.state-mutation.lock`);
  const timeoutMs = positiveTimeout(options.timeoutMs);
  await mkdir(parent, { recursive: true });

  const token = randomBytes(18).toString("hex");
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      } finally {
        await handle.close();
      }
      break;
    } catch (error: unknown) {
      if (!isCode(error, "EEXIST")) throw error;
      if (await quarantineDeadOwnerLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error("Odinn state is busy in another process. Wait for that operation to finish, then try again.");
      }
      await wait(POLL_INTERVAL_MS);
    }
  }

  try {
    return await operation();
  } finally {
    await removeOwnedLock(lockPath, token);
  }
}

function positiveTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1) throw new Error("state mutation lock timeout must be a positive integer");
  return timeout;
}

async function quarantineDeadOwnerLock(lockPath: string): Promise<boolean> {
  const owner = await readLockOwner(lockPath);
  if (!owner) return false;
  if (typeof owner.token !== "string" || !deadOwner(owner)) return false;
  const ownerDigest = lockTokenDigest(owner.token);
  const recoveryPath = join(dirname(lockPath), `.odinn-lock-recovery.${lockTokenDigest(`${lockPath}\0${owner.token}`)}`);
  const recoveryToken = randomBytes(18).toString("hex");
  if (!await acquireRecoveryMarker(recoveryPath, recoveryToken)) return false;
  try {
    const current = await readLockOwner(lockPath);
    if (!current || current.token !== owner.token || !deadOwner(current)) return false;
    const quarantinePath = join(dirname(lockPath), `.odinn-stale-lock.${lockTokenDigest(lockPath)}.${ownerDigest}.${recoveryToken}`);
    await rename(lockPath, quarantinePath);
    const quarantined = await readLockOwner(quarantinePath);
    if (quarantined?.token !== owner.token) throw new Error("state mutation lock changed during stale-lock quarantine; refusing recovery");
    return true;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return true;
    throw error;
  } finally {
    await removeOwnedLock(recoveryPath, recoveryToken);
  }
}

async function acquireRecoveryMarker(recoveryPath: string, token: string): Promise<boolean> {
  try {
    await createLockFile(recoveryPath, token);
    return true;
  } catch (error: unknown) {
    if (!isCode(error, "EEXIST")) throw error;
  }
  // Recovery markers use the same protocol recursively. If a recovering
  // process dies, the next process acquires a distinct token-bound marker
  // before quarantining it; there is no unguarded stale-marker unlink.
  if (!await quarantineDeadOwnerLock(recoveryPath)) return false;
  try {
    await createLockFile(recoveryPath, token);
    return true;
  } catch (error: unknown) {
    if (isCode(error, "EEXIST")) return false;
    throw error;
  }
}

async function createLockFile(path: string, token: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
  } finally {
    await handle.close();
  }
}

async function readLockOwner(path: string): Promise<{ token?: unknown; pid?: unknown } | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    if (isCode(error, "ENOENT") || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function deadOwner(owner: { pid?: unknown }): boolean {
  return Number.isInteger(owner.pid) && Number(owner.pid) > 0 && !processExists(Number(owner.pid));
}

function lockTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function removeOwnedLock(lockPath: string, token: string): Promise<void> {
  try {
    const current = JSON.parse(await readFile(lockPath, "utf8"));
    if (current?.token === token) await rm(lockPath);
  } catch (error: unknown) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isCode(error, "ESRCH");
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}
