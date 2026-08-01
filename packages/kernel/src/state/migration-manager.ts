import { randomBytes } from "node:crypto";
import { access, chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { AUDIT_SCHEMA_VERSION } from "@odinn/protocol";
import { FileAuditStore } from "@odinn/store-file";
import { inspectAuthoritativeRecordSchema, inspectExistingSqliteSchema, SqliteAuditStore } from "@odinn/store-sqlite";
import { STATE_MIGRATIONS, type StateMigrationDefinition, type StateMigrationResult } from "./migrations/index.ts";
import { STATE_SCHEMA_MINIMUM_APPLICATION_VERSION, STATE_SCHEMA_OWNERS, STATE_SCHEMA_TARGETS, targetStateSchemaVersions, type StateSchemaVersions, type StateSurface } from "./schema-registry.ts";
import { withStateMutationLock } from "../state-mutation.ts";

const MARKER_SCHEMA_VERSION = 1;
const MANIFEST_FILENAME = "state-schema.json";
const HISTORY_FILENAME = "migration-history.jsonl";
const RECOGNIZED_STATE_ENTRIES = new Set([
  "config.json",
  "records.jsonl",
  "jobs.json",
  "audit.jsonl",
  "approvals.json",
  "browser-recovery.json",
  "browser-tabs.json",
  "cron-jobs.json",
  "extensions.json",
  "agents.json",
  "skills",
  "db"
]);

export type StateSurfaceStatus = {
  surface: StateSurface;
  currentVersion: number;
  targetVersion: number;
  present: boolean;
  healthy: boolean;
  location: string;
  support: "stable" | "experimental" | "internal";
  detail: string;
};

export type StateInspection = {
  stateRoot: string;
  exists: boolean;
  healthy: boolean;
  currentVersions: StateSchemaVersions;
  targetVersions: StateSchemaVersions;
  surfaces: StateSurfaceStatus[];
  warnings: string[];
};

export type PlannedMigrationStep = {
  id: string;
  surface: StateSurface;
  from: number;
  to: number;
  rollbackCompatible: boolean;
};

export type StateMigrationPlan = {
  schemaVersion: 1;
  applicationVersion: string;
  applicationCommit: string;
  stateRoot: string;
  currentVersions: StateSchemaVersions;
  targetVersions: StateSchemaVersions;
  steps: PlannedMigrationStep[];
  blockingIncompatibilities: string[];
  backupLocation: string | null;
  rollbackCompatible: boolean;
  dryRun: true;
};

export type StateMigrationReport = {
  schemaVersion: 1;
  id: string;
  applicationVersion: string;
  applicationCommit: string;
  stateRoot: string;
  backupLocation: string | null;
  startedAt: string;
  completedAt: string;
  fromVersions: StateSchemaVersions;
  toVersions: StateSchemaVersions;
  rollbackCompatible: boolean;
  auditIntegrity: { valid: boolean; events: number; unsigned: number };
  steps: Array<PlannedMigrationStep & StateMigrationResult>;
  recoveredInterruptedMigration: boolean;
};

export type StateCompatibilityOptions = {
  applicationVersion?: string;
  applicationCommit?: string;
  previousCompatibleApplicationVersion?: string;
  onPhase?: (phase: MigrationPhase) => void | Promise<void>;
};

type MigrationPhase = "backup-created" | "staging-verified" | "cutover-started" | "activated";
type MigrationMarker = {
  schemaVersion: 1;
  id: string;
  stateRoot: string;
  backupPath: string;
  stagingPath: string;
  displacedPath: string;
  phase: MigrationPhase;
  createdAt: string;
};

export async function inspectStateSchemas(stateDir: string): Promise<StateInspection> {
  const stateRoot = safeStateRoot(stateDir);
  const rootExists = await exists(stateRoot);
  if (rootExists) await validatePhysicalTree(stateRoot);
  const hasState = rootExists && await hasRecognizedState(stateRoot);
  const statuses = new Map<StateSurface, StateSurfaceStatus>();

  const config = await inspectConfig(stateRoot);
  put(statuses, "config", config);
  const authoritativeRecordPath = join(stateRoot, "db", "records.sqlite");
  const records = await exists(authoritativeRecordPath)
    ? presentInspection(inspectAuthoritativeRecordSchema(authoritativeRecordPath), "authoritative SQLite record store is readable")
    : await inspectJsonLines(join(stateRoot, "records.jsonl"), 1, "record");
  put(statuses, "records", records);
  for (const surface of ["sessions", "projects", "goals", "memory"] as const) put(statuses, surface, records);
  put(statuses, "jobs", await inspectVersionedObject(join(stateRoot, "jobs.json"), "jobs", "object"));

  const auditFilename = config.present ? await auditFilenameFromConfig(stateRoot) : "audit.jsonl";
  const audit = await inspectJsonLines(join(stateRoot, auditFilename), AUDIT_SCHEMA_VERSION, "audit event");
  await inspectAuditKeyring(join(stateRoot, `${auditFilename}.keys.json`));
  put(statuses, "audit", audit, auditFilename);

  put(statuses, "approvals", await inspectApprovals(join(stateRoot, "approvals.json")));
  put(statuses, "browserRecovery", await inspectBrowserRecovery(stateRoot));
  put(statuses, "cron", await inspectVersionedObject(join(stateRoot, "cron-jobs.json"), "jobs", "array"));
  put(statuses, "extensions", await inspectVersionedObject(join(stateRoot, "extensions.json"), "extensions", "object"));
  put(statuses, "skills", await inspectVersionedObject(join(stateRoot, "skills", "registry.json"), "packages", "array"));
  put(statuses, "agents", await inspectVersionedObject(join(stateRoot, "agents.json"), "agents", "array"));
  put(statuses, "runtimeDatabase", await inspectRuntimeDatabase(join(stateRoot, "db", "odinn.sqlite")));
  put(statuses, "hostMetadata", await inspectHostMetadata(stateRoot, hasState));

  const surfaces = (Object.keys(STATE_SCHEMA_TARGETS) as StateSurface[]).map((surface) => {
    const status = statuses.get(surface);
    if (!status) throw new Error(`state schema inspector is missing ${surface}`);
    return status;
  });
  const currentVersions = Object.fromEntries(surfaces.map((surface) => [surface.surface, surface.currentVersion])) as StateSchemaVersions;
  const warnings = surfaces
    .filter((surface) => surface.present && surface.currentVersion < surface.targetVersion)
    .map((surface) => `${surface.surface} requires schema migration ${surface.currentVersion} to ${surface.targetVersion}`);
  return {
    stateRoot,
    exists: rootExists,
    healthy: surfaces.every((surface) => surface.healthy),
    currentVersions,
    targetVersions: targetStateSchemaVersions(),
    surfaces,
    warnings
  };
}

export async function planStateMigration(stateDir: string, options: StateCompatibilityOptions = {}): Promise<StateMigrationPlan> {
  const inspection = await inspectStateSchemas(stateDir);
  const identity = applicationIdentity(options);
  const blockingIncompatibilities: string[] = [];
  const steps: PlannedMigrationStep[] = [];

  for (const surface of inspection.surfaces) {
    if (surface.currentVersion > surface.targetVersion) {
      blockingIncompatibilities.push(
        `${surface.surface} schema ${surface.currentVersion} is newer than supported schema ${surface.targetVersion}; use an Odinn version that supports this state`
      );
      continue;
    }
    let version = surface.currentVersion;
    while (version < surface.targetVersion) {
      const migration = STATE_MIGRATIONS.find((candidate) => candidate.surface === surface.surface && candidate.from === version);
      if (!migration) {
        blockingIncompatibilities.push(
          `${surface.surface} has no complete migration path from schema ${surface.currentVersion} to ${surface.targetVersion}`
        );
        break;
      }
      steps.push(stepSummary(migration));
      version = migration.to;
    }
  }

  const marker = await readMarker(markerPath(inspection.stateRoot));
  if (marker) blockingIncompatibilities.push("an interrupted state migration requires recovery before a new migration can be planned");
  const migrationId = migrationIdentifier();
  const backupLocation = steps.length ? backupPath(inspection.stateRoot, migrationId) : null;
  return {
    schemaVersion: 1,
    ...identity,
    stateRoot: inspection.stateRoot,
    currentVersions: inspection.currentVersions,
    targetVersions: inspection.targetVersions,
    steps,
    blockingIncompatibilities,
    backupLocation,
    rollbackCompatible: steps.every((step) => step.rollbackCompatible),
    dryRun: true
  };
}

export async function ensureStateCompatibility(
  stateDir: string,
  options: StateCompatibilityOptions = {}
): Promise<StateMigrationReport | undefined> {
  const stateRoot = safeStateRoot(stateDir);
  let recoveredInterruptedMigration = false;
  return withStateMutationLock(stateRoot, async () => {
    recoveredInterruptedMigration = await recoverInterruptedStateMigrationUnlocked(stateRoot);
    const plan = await planStateMigrationUnlocked(stateRoot, options);
    if (plan.blockingIncompatibilities.length) throw new Error(plan.blockingIncompatibilities.join("; "));
    if (!plan.steps.length) return undefined;
    return applyStateMigrationPlanUnlocked(plan, { ...options, recoveredInterruptedMigration });
  });
}

export async function applyStateMigrations(
  stateDir: string,
  options: StateCompatibilityOptions = {}
): Promise<StateMigrationReport | undefined> {
  return ensureStateCompatibility(stateDir, options);
}

export async function recoverInterruptedStateMigration(stateDir: string): Promise<boolean> {
  const stateRoot = safeStateRoot(stateDir);
  return withStateMutationLock(stateRoot, () => recoverInterruptedStateMigrationUnlocked(stateRoot));
}

async function planStateMigrationUnlocked(stateRoot: string, options: StateCompatibilityOptions): Promise<StateMigrationPlan> {
  const inspection = await inspectStateSchemas(stateRoot);
  const identity = applicationIdentity(options);
  const blockingIncompatibilities: string[] = [];
  const steps: PlannedMigrationStep[] = [];
  for (const surface of inspection.surfaces) {
    if (surface.currentVersion > surface.targetVersion) {
      blockingIncompatibilities.push(
        `${surface.surface} schema ${surface.currentVersion} is newer than supported schema ${surface.targetVersion}; use an Odinn version that supports this state`
      );
      continue;
    }
    let version = surface.currentVersion;
    while (version < surface.targetVersion) {
      const migration = STATE_MIGRATIONS.find((candidate) => candidate.surface === surface.surface && candidate.from === version);
      if (!migration) {
        blockingIncompatibilities.push(`${surface.surface} has no complete migration path from schema ${surface.currentVersion} to ${surface.targetVersion}`);
        break;
      }
      steps.push(stepSummary(migration));
      version = migration.to;
    }
  }
  const migrationId = migrationIdentifier();
  return {
    schemaVersion: 1,
    ...identity,
    stateRoot,
    currentVersions: inspection.currentVersions,
    targetVersions: inspection.targetVersions,
    steps,
    blockingIncompatibilities,
    backupLocation: steps.length ? backupPath(stateRoot, migrationId) : null,
    rollbackCompatible: steps.every((step) => step.rollbackCompatible),
    dryRun: true
  };
}

async function applyStateMigrationPlanUnlocked(
  plan: StateMigrationPlan,
  options: StateCompatibilityOptions & { recoveredInterruptedMigration: boolean }
): Promise<StateMigrationReport> {
  const id = basename(dirname(plan.backupLocation!));
  const parent = dirname(plan.stateRoot);
  const token = randomBytes(8).toString("hex");
  const stagingPath = join(parent, `.${basename(plan.stateRoot)}.migration-stage-${token}`);
  const displacedPath = join(parent, `.${basename(plan.stateRoot)}.migration-old-${token}`);
  const markerFile = markerPath(plan.stateRoot);
  const marker: MigrationMarker = {
    schemaVersion: MARKER_SCHEMA_VERSION,
    id,
    stateRoot: plan.stateRoot,
    backupPath: plan.backupLocation!,
    stagingPath,
    displacedPath,
    phase: "backup-created",
    createdAt: new Date().toISOString()
  };
  const startedAt = marker.createdAt;
  const results: Array<PlannedMigrationStep & StateMigrationResult> = [];

  await validatePhysicalTree(plan.stateRoot);
  await mkdir(dirname(plan.backupLocation!), { recursive: true, mode: 0o700 });
  await cp(plan.stateRoot, plan.backupLocation!, { recursive: true, force: false, errorOnExist: true });
  await secureTree(dirname(plan.backupLocation!));
  await validatePhysicalTree(plan.backupLocation!);
  await writeMarker(markerFile, marker);
  await options.onPhase?.("backup-created");

  await cp(plan.stateRoot, stagingPath, { recursive: true, force: false, errorOnExist: true });
  await secureTree(stagingPath);
  const context = {
    stateRoot: stagingPath,
    applicationVersion: plan.applicationVersion,
    applicationCommit: plan.applicationCommit,
    minimumApplicationVersion: plan.rollbackCompatible
      ? String(options.previousCompatibleApplicationVersion || STATE_SCHEMA_MINIMUM_APPLICATION_VERSION)
      : plan.applicationVersion,
    targetVersions: plan.targetVersions
  };
  for (const step of plan.steps) {
    const migration = findMigration(step);
    const result = await migration.apply(context);
    results.push({ ...step, ...result });
  }
  await refreshHostMetadata(stagingPath, plan, options);
  await appendMigrationAuditEvent(stagingPath, plan, id);
  const stagedInspection = await inspectStateSchemas(stagingPath);
  const stagedBlocking = stagedInspection.surfaces.filter((surface) => surface.currentVersion !== surface.targetVersion);
  if (stagedBlocking.length) {
    throw new Error(`staged migration verification failed: ${stagedBlocking.map((surface) => `${surface.surface}=${surface.currentVersion}`).join(", ")}`);
  }
  const auditIntegrity = await verifyAuditIntegrity(stagingPath);
  if (!auditIntegrity.valid) throw new Error("staged migration failed audit integrity verification");
  marker.phase = "staging-verified";
  await writeMarker(markerFile, marker);
  await options.onPhase?.("staging-verified");

  marker.phase = "cutover-started";
  await writeMarker(markerFile, marker);
  await rename(plan.stateRoot, displacedPath);
  await options.onPhase?.("cutover-started");
  await rename(stagingPath, plan.stateRoot);
  marker.phase = "activated";
  await writeMarker(markerFile, marker);
  await options.onPhase?.("activated");

  const activeInspection = await inspectStateSchemas(plan.stateRoot);
  if (!activeInspection.healthy || activeInspection.surfaces.some((surface) => surface.currentVersion !== surface.targetVersion)) {
    throw new Error("activated state failed post-migration verification");
  }
  const activeAudit = await verifyAuditIntegrity(plan.stateRoot);
  if (!activeAudit.valid) throw new Error("activated state failed audit integrity verification");
  const report: StateMigrationReport = {
    schemaVersion: 1,
    id,
    applicationVersion: plan.applicationVersion,
    applicationCommit: plan.applicationCommit,
    stateRoot: plan.stateRoot,
    backupLocation: plan.backupLocation,
    startedAt,
    completedAt: new Date().toISOString(),
    fromVersions: plan.currentVersions,
    toVersions: plan.targetVersions,
    rollbackCompatible: plan.rollbackCompatible,
    auditIntegrity: activeAudit,
    steps: results,
    recoveredInterruptedMigration: options.recoveredInterruptedMigration
  };
  await appendHistory(plan.stateRoot, report);
  await rm(displacedPath, { recursive: true, force: true });
  await rm(markerFile, { force: true });
  return report;
}

async function recoverInterruptedStateMigrationUnlocked(stateRoot: string): Promise<boolean> {
  const markerFile = markerPath(stateRoot);
  const marker = await readMarker(markerFile);
  if (!marker) return false;
  validateMarker(marker, stateRoot);
  const rootExists = await exists(stateRoot);
  const stagingExists = await exists(marker.stagingPath);
  const displacedExists = await exists(marker.displacedPath);

  if (marker.phase === "activated" || marker.phase === "cutover-started") {
    if (rootExists) {
      try {
        const inspection = await inspectStateSchemas(stateRoot);
        if (inspection.healthy && inspection.surfaces.every((surface) => surface.currentVersion === surface.targetVersion)) {
          await appendRecoveryHistory(stateRoot, marker);
          if (displacedExists) await rm(marker.displacedPath, { recursive: true, force: true });
          if (stagingExists) await rm(marker.stagingPath, { recursive: true, force: true });
          await rm(markerFile, { force: true });
          return true;
        }
      } catch {
        // Restore the pre-migration tree below.
      }
      if (!displacedExists) throw new Error("interrupted migration cannot recover: active state is invalid and the displaced state is missing");
      const failedPath = `${stateRoot}.failed-migration-${Date.now()}`;
      await rename(stateRoot, failedPath);
      await rename(marker.displacedPath, stateRoot);
    } else if (displacedExists) {
      await rename(marker.displacedPath, stateRoot);
    } else {
      throw new Error("interrupted migration cannot recover: both active and displaced state are missing");
    }
  }

  if (stagingExists) await rm(marker.stagingPath, { recursive: true, force: true });
  await rm(markerFile, { force: true });
  await validatePhysicalTree(stateRoot);
  return true;
}

async function inspectConfig(stateRoot: string): Promise<BasicInspection> {
  const path = join(stateRoot, "config.json");
  const value = await readJson(path);
  if (!value.present) return absentInspection(STATE_SCHEMA_TARGETS.config);
  if (!value.value || typeof value.value !== "object" || Array.isArray(value.value)) throw new Error("config.json must contain an object");
  const version = "version" in value.value ? schemaNumber(value.value.version, "config") : 0;
  return presentInspection(version, "configuration document is structurally valid");
}

async function inspectVersionedObject(path: string, collection: string, kind: "array" | "object"): Promise<BasicInspection> {
  const target = schemaTargetForPath(path);
  const value = await readJson(path);
  if (!value.present) return absentInspection(target);
  if (!value.value || typeof value.value !== "object" || Array.isArray(value.value)) throw new Error(`${basename(path)} must contain an object`);
  const version = schemaNumber(value.value.schemaVersion, basename(path));
  const collectionValue = value.value[collection];
  if (kind === "array" ? !Array.isArray(collectionValue) : !collectionValue || typeof collectionValue !== "object" || Array.isArray(collectionValue)) {
    throw new Error(`${basename(path)} has an invalid ${collection} collection`);
  }
  return presentInspection(version, `${collection} collection is structurally valid`);
}

async function inspectApprovals(path: string): Promise<BasicInspection> {
  const value = await readJson(path);
  if (!value.present) return absentInspection(STATE_SCHEMA_TARGETS.approvals);
  if (Array.isArray(value.value)) {
    if (value.value.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) throw new Error("legacy approval entries must be objects");
    return presentInspection(0, "legacy approval array requires migration");
  }
  if (!value.value || typeof value.value !== "object" || Array.isArray(value.value)) throw new Error("approvals.json must contain an object or legacy array");
  if (!Array.isArray(value.value.approvals)) throw new Error("approvals.json has an invalid approvals collection");
  return presentInspection(schemaNumber(value.value.schemaVersion, "approvals"), "approval collection is structurally valid");
}

async function inspectBrowserRecovery(stateRoot: string): Promise<BasicInspection> {
  const versions: number[] = [];
  for (const filename of ["browser-recovery.json", "browser-tabs.json"]) {
    const value = await readJson(join(stateRoot, filename));
    if (!value.present) continue;
    if (!value.value || typeof value.value !== "object" || Array.isArray(value.value)) throw new Error(`${filename} must contain an object`);
    versions.push("schemaVersion" in value.value ? schemaNumber(value.value.schemaVersion, filename) : 0);
  }
  if (!versions.length) return absentInspection(STATE_SCHEMA_TARGETS.browserRecovery);
  return presentInspection(Math.min(...versions), "browser recovery documents are structurally valid");
}

async function inspectJsonLines(path: string, target: number, label: string): Promise<BasicInspection> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return absentInspection(target);
    throw error;
  }
  const versions: number[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`${basename(path)} contains invalid JSON at line ${index + 1}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${basename(path)} ${label} at line ${index + 1} must be an object`);
    const record = value as Record<string, unknown>;
    versions.push("schemaVersion" in record ? schemaNumber(record.schemaVersion, `${label} line ${index + 1}`) : target);
  }
  return presentInspection(versions.length ? Math.max(...versions) : target, `${versions.length} ${label}${versions.length === 1 ? "" : "s"} validated`);
}

async function inspectAuditKeyring(path: string): Promise<void> {
  const value = await readJson(path);
  if (!value.present) return;
  if (!value.value || typeof value.value !== "object" || Array.isArray(value.value)) throw new Error("audit keyring must contain an object");
  const version = schemaNumber(value.value.schemaVersion, "audit keyring");
  if (version > 1) throw new Error(`audit keyring schema ${version} is newer than supported schema 1`);
  if (typeof value.value.current !== "string" || !value.value.keys || typeof value.value.keys !== "object" || Array.isArray(value.value.keys)) {
    throw new Error("audit keyring is invalid");
  }
}

async function inspectRuntimeDatabase(path: string): Promise<BasicInspection> {
  if (!await exists(path)) return absentInspection(STATE_SCHEMA_TARGETS.runtimeDatabase);
  return presentInspection(inspectExistingSqliteSchema(path), "SQLite migration ledger is readable");
}

async function inspectHostMetadata(stateRoot: string, hasState: boolean): Promise<BasicInspection> {
  const value = await readJson(join(stateRoot, MANIFEST_FILENAME));
  if (!value.present) return hasState ? presentInspection(0, "pre-v1 state has no compatibility manifest") : absentInspection(STATE_SCHEMA_TARGETS.hostMetadata);
  if (!value.value || typeof value.value !== "object" || Array.isArray(value.value)) throw new Error(`${MANIFEST_FILENAME} must contain an object`);
  const version = schemaNumber(value.value.schemaVersion, "state compatibility manifest");
  const storeVersions = value.value.storeVersions;
  if (!storeVersions || typeof storeVersions !== "object" || Array.isArray(storeVersions)) throw new Error(`${MANIFEST_FILENAME} has no storeVersions object`);
  for (const surface of Object.keys(STATE_SCHEMA_TARGETS) as StateSurface[]) {
    if (!(surface in storeVersions)) throw new Error(`${MANIFEST_FILENAME} is missing ${surface}`);
    const recordedVersion = schemaNumber((storeVersions as Record<string, unknown>)[surface], `${MANIFEST_FILENAME}.${surface}`);
    if (recordedVersion > STATE_SCHEMA_TARGETS[surface]) {
      throw new Error(`${MANIFEST_FILENAME} records future ${surface} schema ${recordedVersion}`);
    }
  }
  return presentInspection(version, "per-store compatibility manifest is structurally valid");
}

async function appendMigrationAuditEvent(stateRoot: string, plan: StateMigrationPlan, migrationId: string): Promise<void> {
  const auditFilename = await auditFilenameFromConfig(stateRoot);
  const auditPath = join(stateRoot, auditFilename);
  if (!await exists(auditPath)) return;
  const store = new FileAuditStore(auditPath);
  await store.append({
    runId: migrationId,
    type: "state.migration",
    actor: "odinn",
    message: `Migrated persistent state for Odinn ${plan.applicationVersion}`,
    data: {
      migrationId,
      fromVersions: plan.currentVersions,
      toVersions: plan.targetVersions,
      rollbackCompatible: plan.rollbackCompatible
    }
  });
}

async function refreshHostMetadata(
  stateRoot: string,
  plan: StateMigrationPlan,
  options: StateCompatibilityOptions
): Promise<void> {
  const path = join(stateRoot, MANIFEST_FILENAME);
  const existing = await readJson(path);
  if (!existing.present || !existing.value || typeof existing.value !== "object" || Array.isArray(existing.value)) {
    throw new Error("state compatibility manifest was not created by the migration plan");
  }
  const minimumApplicationVersion = plan.rollbackCompatible
    ? String(existing.value.minimumApplicationVersion || options.previousCompatibleApplicationVersion || STATE_SCHEMA_MINIMUM_APPLICATION_VERSION)
    : plan.applicationVersion;
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    ...existing.value,
    schemaVersion: STATE_SCHEMA_TARGETS.hostMetadata,
    applicationVersion: plan.applicationVersion,
    applicationCommit: plan.applicationCommit,
    storeVersions: plan.targetVersions,
    minimumApplicationVersion,
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function verifyAuditIntegrity(stateRoot: string): Promise<{ valid: boolean; events: number; unsigned: number }> {
  const auditFilename = await auditFilenameFromConfig(stateRoot);
  const auditPath = join(stateRoot, auditFilename);
  const databasePath = join(stateRoot, "db", `${basename(auditFilename, ".jsonl")}.sqlite`);
  if (await exists(databasePath)) { const store = new SqliteAuditStore(databasePath, { keyringPath: `${auditPath}.keys.json` }); try { const result = await store.verifyIntegrity({ allowUnsigned: true }); return { valid: result.valid, events: result.events, unsigned: result.unsigned }; } finally { store.close(); } }
  if (!await exists(auditPath)) return { valid: true, events: 0, unsigned: 0 };
  const store = new FileAuditStore(auditPath); const result = await store.verifyIntegrity({ allowUnsigned: true }); return { valid: result.valid, events: result.events, unsigned: result.unsigned };
}

async function auditFilenameFromConfig(stateRoot: string): Promise<string> {
  const config = await readJson(join(stateRoot, "config.json"));
  const filename = config.present && config.value && typeof config.value === "object" && !Array.isArray(config.value)
    ? String(config.value.auditLog ?? "audit.jsonl")
    : "audit.jsonl";
  if (!/^audit(?:-[A-Za-z0-9._-]+)?\.jsonl$/u.test(filename)) {
    throw new Error("config.auditLog must be audit.jsonl or an audit-*.jsonl filename");
  }
  return filename;
}

async function appendHistory(stateRoot: string, report: StateMigrationReport): Promise<void> {
  const path = join(stateRoot, HISTORY_FILENAME);
  await writeFile(path, `${JSON.stringify(report)}\n`, { flag: "a", mode: 0o600 });
  await chmod(path, 0o600);
}

async function appendRecoveryHistory(stateRoot: string, marker: MigrationMarker): Promise<void> {
  const path = join(stateRoot, HISTORY_FILENAME);
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    id: marker.id,
    type: "state.migration.recovered",
    outcome: "activated-state-verified",
    backupLocation: marker.backupPath,
    interruptedPhase: marker.phase,
    recoveredAt: new Date().toISOString()
  })}\n`, { flag: "a", mode: 0o600 });
  await chmod(path, 0o600);
}

function put(statuses: Map<StateSurface, StateSurfaceStatus>, surface: StateSurface, inspected: BasicInspection, location = STATE_SCHEMA_OWNERS[surface].location): void {
  const targetVersion = STATE_SCHEMA_TARGETS[surface];
  statuses.set(surface, {
    surface,
    currentVersion: inspected.version,
    targetVersion,
    present: inspected.present,
    healthy: inspected.version >= 0 && inspected.version <= targetVersion,
    location,
    support: STATE_SCHEMA_OWNERS[surface].support,
    detail: inspected.detail
  });
}

type BasicInspection = { version: number; present: boolean; detail: string };
const absentInspection = (version: number): BasicInspection => ({ version, present: false, detail: "store is not initialized" });
const presentInspection = (version: number, detail: string): BasicInspection => ({ version, present: true, detail });

function schemaTargetForPath(path: string): number {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.endsWith("/jobs.json")) return STATE_SCHEMA_TARGETS.jobs;
  if (normalized.endsWith("/cron-jobs.json")) return STATE_SCHEMA_TARGETS.cron;
  if (normalized.endsWith("/extensions.json")) return STATE_SCHEMA_TARGETS.extensions;
  if (normalized.endsWith("/skills/registry.json")) return STATE_SCHEMA_TARGETS.skills;
  if (normalized.endsWith("/agents.json")) return STATE_SCHEMA_TARGETS.agents;
  throw new Error(`no schema target owns ${path}`);
}

function schemaNumber(value: unknown, label: string): number {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) throw new Error(`${label} has an invalid schema version`);
  return version;
}

function findMigration(step: PlannedMigrationStep): StateMigrationDefinition {
  const migration = STATE_MIGRATIONS.find((candidate) =>
    candidate.id === step.id
    && candidate.surface === step.surface
    && candidate.from === step.from
    && candidate.to === step.to
  );
  if (!migration) throw new Error(`migration implementation is missing for ${step.id}`);
  return migration;
}

function stepSummary(migration: StateMigrationDefinition): PlannedMigrationStep {
  return {
    id: migration.id,
    surface: migration.surface,
    from: migration.from,
    to: migration.to,
    rollbackCompatible: migration.rollbackCompatible
  };
}

function applicationIdentity(options: StateCompatibilityOptions) {
  return {
    applicationVersion: String(options.applicationVersion || process.env.ODINN_VERSION || "development"),
    applicationCommit: String(options.applicationCommit || process.env.ODINN_COMMIT || "unknown")
  };
}

function migrationIdentifier(): string {
  return `migration-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomBytes(5).toString("hex")}`;
}

function backupPath(stateRoot: string, migrationId: string): string {
  return join(dirname(stateRoot), `${basename(stateRoot)}.backups`, migrationId, "state");
}

function markerPath(stateRoot: string): string {
  return join(dirname(stateRoot), `.${basename(stateRoot)}.migration-in-progress.json`);
}

async function writeMarker(path: string, marker: MigrationMarker): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function readMarker(path: string): Promise<MigrationMarker | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || value.schemaVersion !== MARKER_SCHEMA_VERSION) throw new Error("unsupported migration-in-progress marker");
    return value as MigrationMarker;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function validateMarker(marker: MigrationMarker, stateRoot: string): void {
  if (resolve(marker.stateRoot) !== stateRoot) throw new Error("migration marker targets a different state root");
  const parent = dirname(stateRoot);
  assertManagedSibling(marker.stagingPath, parent, `.${basename(stateRoot)}.migration-stage-`);
  assertManagedSibling(marker.displacedPath, parent, `.${basename(stateRoot)}.migration-old-`);
  const backupRoot = resolve(parent, `${basename(stateRoot)}.backups`);
  const resolvedBackup = resolve(marker.backupPath);
  if (!resolvedBackup.startsWith(`${backupRoot}${sep}`)) throw new Error("migration marker backup path escaped managed backup storage");
  if (!["backup-created", "staging-verified", "cutover-started", "activated"].includes(marker.phase)) throw new Error("migration marker has an invalid phase");
}

function assertManagedSibling(path: string, parent: string, prefix: string): void {
  const resolved = resolve(path);
  if (dirname(resolved) !== parent || !basename(resolved).startsWith(prefix)) throw new Error("migration marker contains an unsafe temporary path");
}

function safeStateRoot(stateDir: string): string {
  const root = resolve(stateDir);
  if (root === parse(root).root || dirname(root) === root || !basename(root)) throw new Error("Odinn state root is too broad or ambiguous");
  return root;
}

async function hasRecognizedState(stateRoot: string): Promise<boolean> {
  for (const entry of await readdir(stateRoot)) {
    if (RECOGNIZED_STATE_ENTRIES.has(entry) || /^audit(?:-[A-Za-z0-9._-]+)?\.jsonl$/u.test(entry)) return true;
  }
  return false;
}

async function validatePhysicalTree(root: string): Promise<void> {
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error(`state root must be a physical directory: ${root}`);
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error(`state contains a symbolic link: ${relative(root, path)}`);
      if (metadata.isDirectory()) {
        await walk(path);
      } else if (!metadata.isFile()) {
        throw new Error(`state contains an unsupported file type: ${relative(root, path)}`);
      } else if (metadata.nlink !== 1) {
        throw new Error(`state contains a hard-linked file: ${relative(root, path)}`);
      }
    }
  };
  await walk(root);
}

async function secureTree(root: string): Promise<void> {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await secureTree(path);
    else if (entry.isFile()) await chmod(path, 0o600);
  }
}

async function readJson(path: string): Promise<{ present: false } | { present: true; value: Record<string, unknown> | unknown[] }> {
  try {
    return { present: true, value: JSON.parse(await readFile(path, "utf8")) };
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return { present: false };
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
