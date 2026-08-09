import { migrateLegacyRecordsToSqlite } from "@odinn/store-sqlite";
import { join } from "node:path";
import type { StateMigrationDefinition } from "./types.ts";

export const recordsV0ToV1: StateMigrationDefinition = {
  id: "records-v0-to-v1",
  surface: "records",
  from: 0,
  to: 1,
  rollbackCompatible: true,
  async apply(context) {
    const legacyPath = join(context.stateRoot, "records.jsonl");
    const databasePath = join(context.stateRoot, "db", "records.sqlite");
    const result = migrateLegacyRecordsToSqlite({ legacyPath, databasePath });
    if (!result.complete) throw new Error("legacy records migration did not reach a complete checkpoint");
    return {
      changed: ["records.jsonl", "db/records.sqlite"],
      preservedUnknownFields: true,
      notes: [`imported ${result.records} legacy record(s) into the authoritative SQLite store; records.jsonl remains rollback evidence`]
    };
  }
};
