import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;

export type StateMutationLockOptions = {
  timeoutMs?: number;
  __testOnlyAfterLockRead?: () => void | Promise<void>;
  __testOnlyWindowsFileSemantics?: boolean;
  __testOnlyBeforeReleaseFileOperation?: (
    operation: "quarantine" | "restore-link" | "restore-marker" | "remove",
    attempt: number
  ) => void | Promise<void>;
};

type ReleaseOptions = Pick<
  StateMutationLockOptions,
  "__testOnlyAfterLockRead" | "__testOnlyWindowsFileSemantics" | "__testOnlyBeforeReleaseFileOperation"
>;

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
    await removeOwnedLock(lockPath, token, options);
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

async function removeOwnedLock(
  lockPath: string,
  token: string,
  options: ReleaseOptions = {}
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let quarantinePath: string | undefined;
  try {
    const lockInfo = await lstat(lockPath);
    if (!lockInfo.isFile() || lockInfo.isSymbolicLink()) return;
    handle = await open(lockPath, "r");
    const handleInfo = await handle.stat();
    if (!handleInfo.isFile()) return;
    const current = JSON.parse(await handle.readFile("utf8"));
    if (current?.token !== token) return;
    await options.__testOnlyAfterLockRead?.();

    quarantinePath = `${lockPath}.release-${process.pid}-${randomBytes(18).toString("hex")}`;
    if (!await quarantineOwnedPath(lockPath, quarantinePath, handleInfo, options)) return;
    const movedInfo = await lstat(quarantinePath);
    if (!sameFile(movedInfo, handleInfo) || !movedInfo.isFile() || movedInfo.isSymbolicLink()) {
      // A replacement owner won the read-to-rename race. Restore that inode
      // without overwriting any still-newer owner at the shared lock path.
      try {
        const restoredByLink = await restoreReplacementPath(quarantinePath, lockPath, options);
        if (restoredByLink) await removeWithTransientRetry(quarantinePath, options);
        quarantinePath = undefined;
        return;
      } catch (restoreError: unknown) {
        if (isCode(restoreError, "EEXIST")) {
          throw new Error(`state mutation lock changed during release and was quarantined: ${quarantinePath}`);
        }
        throw restoreError;
      }
    }
    await removeWithTransientRetry(quarantinePath, options);
    quarantinePath = undefined;
  } catch (error: unknown) {
    if (!isCode(error, "ENOENT")) throw error;
  } finally {
    await handle?.close();
  }
}

async function quarantineOwnedPath(
  lockPath: string,
  quarantinePath: string,
  expected: { dev: number; ino: number },
  options: ReleaseOptions
): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await options.__testOnlyBeforeReleaseFileOperation?.("quarantine", attempt);
      await rename(lockPath, quarantinePath);
      return true;
    } catch (error: unknown) {
      if (isCode(error, "ENOENT")) return false;
      if (!usesWindowsFileSemantics(options) || !isTransientWindowsFileError(error) || attempt >= 7) throw error;
      const current = await optionalFileIdentity(lockPath);
      if (!current || !sameFile(current, expected)) return false;
      await wait(25);
    }
  }
}

async function restoreReplacementPath(
  quarantinePath: string,
  lockPath: string,
  options: ReleaseOptions
): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await options.__testOnlyBeforeReleaseFileOperation?.("restore-link", attempt);
      await link(quarantinePath, lockPath);
      return true;
    } catch (error: unknown) {
      if (isCode(error, "EEXIST")) throw error;
      if (!usesWindowsFileSemantics(options) || !isTransientWindowsFileError(error)) throw error;
      if (attempt < 2) {
        if (await optionalFileIdentity(lockPath)) throw new Error(`state mutation lock changed during release and was quarantined: ${quarantinePath}`);
        await wait(25);
        continue;
      }
      // Publish an exclusive token-equivalent marker after bounded hard-link
      // retries. `wx` cannot overwrite a newer owner and keeps the canonical
      // path blocking until the replacement process releases its same token.
      await publishReplacementMarker(quarantinePath, lockPath, options);
      return true;
    }
  }
}

async function publishReplacementMarker(
  quarantinePath: string,
  lockPath: string,
  options: ReleaseOptions
): Promise<void> {
  const contents = await readFile(quarantinePath, "utf8");
  const owner = JSON.parse(contents);
  if (typeof owner?.token !== "string" || !Number.isInteger(owner?.pid)) {
    throw new Error(`state mutation replacement owner is invalid: ${quarantinePath}`);
  }
  for (let attempt = 0; ; attempt += 1) {
    let marker: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await options.__testOnlyBeforeReleaseFileOperation?.("restore-marker", attempt);
      marker = await open(lockPath, "wx", 0o600);
      await marker.writeFile(contents);
      return;
    } catch (error: unknown) {
      if (isCode(error, "EEXIST")) throw new Error(`state mutation lock changed during release and was quarantined: ${quarantinePath}`);
      if (!isTransientWindowsFileError(error) || attempt >= 7) throw error;
      await wait(25);
    } finally {
      await marker?.close();
    }
  }
}

async function removeWithTransientRetry(path: string, options: ReleaseOptions): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await options.__testOnlyBeforeReleaseFileOperation?.("remove", attempt);
      await rm(path);
      return;
    } catch (error: unknown) {
      if (isCode(error, "ENOENT")) return;
      if (!usesWindowsFileSemantics(options) || !isTransientWindowsFileError(error) || attempt >= 7) throw error;
      await wait(25);
    }
  }
}

async function optionalFileIdentity(path: string): Promise<{ dev: number; ino: number } | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    return info;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isTransientWindowsFileError(error: unknown): boolean {
  return isCode(error, "EPERM") || isCode(error, "EBUSY");
}

function usesWindowsFileSemantics(options: ReleaseOptions): boolean {
  return process.platform === "win32" || options.__testOnlyWindowsFileSemantics === true;
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
