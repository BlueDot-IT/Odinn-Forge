import { join } from "node:path";
import { ArtifactStore, RunLedger, SqliteJobStore, SqliteStore } from "@odinn/store-sqlite";
import type { StateMigrationDefinition } from "./types.ts";

export function runtimeDatabaseMigration(from: number, to: number): StateMigrationDefinition {
  return {
    id: `runtime-database-v${from}-to-v${to}`,
    surface: "runtimeDatabase",
    from,
    to,
    rollbackCompatible: to < 5,
    async apply({ stateRoot }) {
      const database = new SqliteStore(join(stateRoot, "db", "odinn.sqlite"), { targetVersion: to });
      let importedJobs = 0;
      try {
        if (to === 5) {
          const ledger = new RunLedger({
            database,
            artifacts: new ArtifactStore(join(stateRoot, "artifacts")),
            workspaceRoot: stateRoot,
            stateDir: stateRoot
          });
          const imported = await new SqliteJobStore(ledger, { legacyPath: join(stateRoot, "jobs.json") }).importLegacy();
          importedJobs = imported.jobs;
        }
      } finally {
        database.close();
      }
      return {
        changed: [
          `db/odinn.sqlite: applied schema migration ${from} to ${to}`,
          ...(to === 5 ? [`jobs.json: validated and imported ${importedJobs} runtime jobs into SQLite; source retained as rollback evidence`] : [])
        ],
        preservedUnknownFields: true,
        notes: ["SQLite migration ran in a transaction inside the staged state tree."]
      };
    }
  };
}
