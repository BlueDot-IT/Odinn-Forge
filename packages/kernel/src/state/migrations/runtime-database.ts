import { join } from "node:path";
import { SqliteStore } from "@odinn/store-sqlite";
import type { StateMigrationDefinition } from "./types.ts";

export function runtimeDatabaseMigration(from: number, to: number): StateMigrationDefinition {
  return {
    id: `runtime-database-v${from}-to-v${to}`,
    surface: "runtimeDatabase",
    from,
    to,
    rollbackCompatible: true,
    async apply({ stateRoot }) {
      const store = new SqliteStore(join(stateRoot, "db", "odinn.sqlite"), { targetVersion: to });
      store.close();
      return {
        changed: [`db/odinn.sqlite: applied schema migration ${from} to ${to}`],
        preservedUnknownFields: true,
        notes: ["SQLite migration ran in a transaction inside the staged state tree."]
      };
    }
  };
}
