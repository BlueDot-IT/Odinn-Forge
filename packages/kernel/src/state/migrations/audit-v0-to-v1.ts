import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { migrateLegacyAuditToSqlite } from "@odinn/store-sqlite";
import type { StateMigrationDefinition } from "./types.ts";

export const auditV0ToV1: StateMigrationDefinition = {
  id: "audit-v0-to-v1",
  surface: "audit",
  from: 0,
  to: 1,
  rollbackCompatible: true,
  async apply(context) {
    const config = JSON.parse(await readFile(join(context.stateRoot, "config.json"), "utf8")) as Record<string, unknown>;
    const auditFilename = typeof config.auditLog === "string" && config.auditLog.trim() ? config.auditLog.trim() : "audit.jsonl";
    if (!/^audit(?:-[A-Za-z0-9._-]+)?\.jsonl$/u.test(auditFilename)) throw new Error("config.auditLog must be audit.jsonl or an audit-*.jsonl filename");
    const legacyPath = join(context.stateRoot, auditFilename);
    const databasePath = join(context.stateRoot, "db", `${basename(auditFilename, ".jsonl")}.sqlite`);
    const result = migrateLegacyAuditToSqlite({ legacyPath, databasePath, keyringPath: `${legacyPath}.keys.json` });
    return {
      changed: [auditFilename, relativeDatabasePath(auditFilename)],
      preservedUnknownFields: true,
      notes: [`imported ${result.events} legacy audit event(s) into the authoritative SQLite journal; ${auditFilename} remains rollback evidence`]
    };
  }
};

function relativeDatabasePath(auditFilename: string): string {
  return `db/${basename(auditFilename, ".jsonl")}.sqlite`;
}
