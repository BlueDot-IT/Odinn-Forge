import { approvalsV0ToV1 } from "./approvals-v0-to-v1.ts";
import { auditV0ToV1 } from "./audit-v0-to-v1.ts";
import { browserRecoveryV0ToV1 } from "./browser-recovery-v0-to-v1.ts";
import { configV0ToV1 } from "./config-v0-to-v1.ts";
import { cronV1ToV2 } from "./cron-v1-to-v2.ts";
import { hostMetadataV0ToV1 } from "./host-metadata-v0-to-v1.ts";
import { recordsV0ToV1 } from "./records-v0-to-v1.ts";
import { runtimeDatabaseMigration } from "./runtime-database.ts";
import type { StateMigrationDefinition } from "./types.ts";

export type { StateMigrationContext, StateMigrationDefinition, StateMigrationResult } from "./types.ts";

export const STATE_MIGRATIONS: readonly StateMigrationDefinition[] = Object.freeze([
  configV0ToV1,
  recordsV0ToV1,
  auditV0ToV1,
  cronV1ToV2,
  approvalsV0ToV1,
  browserRecoveryV0ToV1,
  runtimeDatabaseMigration(0, 1),
  runtimeDatabaseMigration(1, 2),
  runtimeDatabaseMigration(2, 3),
  runtimeDatabaseMigration(3, 4),
  runtimeDatabaseMigration(4, 5),
  runtimeDatabaseMigration(5, 6),
  runtimeDatabaseMigration(6, 7),
  hostMetadataV0ToV1
]);
