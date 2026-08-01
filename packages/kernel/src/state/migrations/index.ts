import { approvalsV0ToV1 } from "./approvals-v0-to-v1.ts";
import { browserRecoveryV0ToV1 } from "./browser-recovery-v0-to-v1.ts";
import { configV0ToV1 } from "./config-v0-to-v1.ts";
import { cronV1ToV2 } from "./cron-v1-to-v2.ts";
import { hostMetadataV0ToV1 } from "./host-metadata-v0-to-v1.ts";
import { runtimeDatabaseMigration } from "./runtime-database.ts";
import type { StateMigrationDefinition } from "./types.ts";

export type { StateMigrationContext, StateMigrationDefinition, StateMigrationResult } from "./types.ts";

export const STATE_MIGRATIONS: readonly StateMigrationDefinition[] = Object.freeze([
  configV0ToV1,
  cronV1ToV2,
  approvalsV0ToV1,
  browserRecoveryV0ToV1,
  runtimeDatabaseMigration(0, 1),
  runtimeDatabaseMigration(1, 2),
  runtimeDatabaseMigration(2, 3),
  hostMetadataV0ToV1
]);
