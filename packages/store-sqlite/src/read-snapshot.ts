import type { DatabaseSync } from "node:sqlite";

/** Execute related SELECT statements against one SQLite read generation. */
export function withSqliteReadSnapshot<T>(database: DatabaseSync, read: (database: DatabaseSync) => T): T {
  if (database.isTransaction) return read(database);
  database.exec("BEGIN DEFERRED TRANSACTION");
  try {
    const result = read(database);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}
