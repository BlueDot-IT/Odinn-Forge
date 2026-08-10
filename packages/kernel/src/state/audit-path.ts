import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_AUDIT_FILENAME = "audit.jsonl";
const AUDIT_FILENAME = /^audit(?:-[A-Za-z0-9._-]+)?\.jsonl$/u;

export async function auditFilenameFromConfig(stateRoot: string): Promise<string> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(stateRoot, "config.json"), "utf8"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return DEFAULT_AUDIT_FILENAME;
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config.json must contain an object");
  const configured = (value as Record<string, unknown>).auditLog;
  const filename = typeof configured === "string" && configured.trim() ? configured.trim() : DEFAULT_AUDIT_FILENAME;
  if (!AUDIT_FILENAME.test(filename)) throw new Error("config.auditLog must be audit.jsonl or an audit-*.jsonl filename");
  return filename;
}
