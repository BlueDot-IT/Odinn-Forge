import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

export class RecoveryJournalFileError extends Error {
  constructor(message = "recovery journal is unsafe or invalid") {
    super(message);
    this.name = "RecoveryJournalFileError";
  }
}

/** Read one recovery journal without following links or accepting shared files. */
export async function readRecoveryJournalJson(path: string, maxBytes: number): Promise<unknown | undefined> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw new RecoveryJournalFileError();
  }
  try {
    const metadata = await handle.stat();
    const getProcessUserId = process.getuid;
    const currentUser = getProcessUserId?.();
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maxBytes
      || (process.platform !== "win32" && ((metadata.mode & 0o077) !== 0
        || (currentUser !== undefined && metadata.uid !== currentUser)))) {
      throw new RecoveryJournalFileError();
    }
    let raw: string;
    try { raw = await handle.readFile("utf8"); }
    catch { throw new RecoveryJournalFileError(); }
    if (Buffer.byteLength(raw, "utf8") > maxBytes) throw new RecoveryJournalFileError();
    try { return JSON.parse(raw) as unknown; }
    catch { throw new RecoveryJournalFileError(); }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
