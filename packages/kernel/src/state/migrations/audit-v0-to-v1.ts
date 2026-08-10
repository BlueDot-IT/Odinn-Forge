import { basename, join } from "node:path";
import { migrateLegacyAuditToSqlite } from "@odinn/store-sqlite";
import type { StateMigrationDefinition } from "./types.ts";
import { auditFilenameFromConfig } from "../audit-path.ts";

export const auditV0ToV1: StateMigrationDefinition = {
  id: "audit-v0-to-v1",
  surface: "audit",
  from: 0,
  to: 1,
  rollbackCompatible: true,
  async apply(context) {
    const auditFilename = await auditFilenameFromConfig(context.stateRoot);
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
