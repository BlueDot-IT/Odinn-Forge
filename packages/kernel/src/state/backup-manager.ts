import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { backup as backupSqlite, DatabaseSync } from "node:sqlite";
import { FileAuditStore, isOwnerOnlyPath } from "@odinn/store-file";
import { SqliteAuditStore } from "@odinn/store-sqlite";
import { withStateMutationLock } from "../state-mutation.ts";
import { inspectStateSchemas, type StateInspection } from "./migration-manager.ts";
import { STATE_SCHEMA_TARGETS, type StateSchemaVersions, type StateSurface } from "./schema-registry.ts";

const BACKUP_MANIFEST = "backup-manifest.json";
const BACKUP_SCHEMA_VERSION = 1;
const DEFAULT_EXCLUSIONS = Object.freeze([
  "oauth/",
  "browser-profile/",
  "browser-profiles/",
  "cookies/",
  "gateway.token",
  "capability-signing.key",
  "users.json",
  "login-attempts.json"
]);
const EPHEMERAL_STATE_FILES = Object.freeze([
  "db/odinn.sqlite-shm",
  "db/odinn.sqlite-wal",
  "db/records.sqlite-shm",
  "db/records.sqlite-wal",
  "db/audit.sqlite-shm",
  "db/audit.sqlite-wal",
  "db/audit.sqlite.notify"
]);
const isEphemeralStateFile = (path: string) => EPHEMERAL_STATE_FILES.includes(path) || /^db\/.+\.sqlite-(?:shm|wal)$/u.test(path) || /^db\/.+\.sqlite\.notify$/u.test(path);

export type BackupApplicationIdentity = {
  version: string;
  commit: string;
};

export type StateBackupFile = {
  path: string;
  bytes: number;
  sha256: string;
};

export type StateBackupManifest = {
  schemaVersion: 1;
  kind: "odinn-state-backup";
  createdAt: string;
  sourceApplication: BackupApplicationIdentity;
  stateSchemas: StateSchemaVersions;
  includesSensitiveState: boolean;
  excluded: string[];
  files: StateBackupFile[];
};

export type CreateStateBackupOptions = {
  applicationVersion?: string;
  applicationCommit?: string;
  includeSensitiveState?: boolean;
};

export type InspectedStateBackup = {
  root: string;
  manifest: StateBackupManifest;
  valid: true;
};

export type RestoreStateBackupOptions = {
  applicationVersion?: string;
  applicationCommit?: string;
  skipCurrentBackup?: boolean;
};

export type RestoreStateBackupReport = {
  ok: true;
  operation: "restore";
  sourceVersion: string;
  sourceCommit: string;
  sourceSchemas: StateSchemaVersions;
  preRestoreBackup: string | null;
  restoredFiles: number;
  auditIntegrity: { valid: boolean; events: number; unsigned: number };
};

export async function createStateBackup(
  stateDir: string,
  outputDir: string,
  options: CreateStateBackupOptions = {}
): Promise<{ ok: true; operation: "backup"; destination: string; manifest: StateBackupManifest }> {
  const stateRoot = safeRoot(stateDir, "state");
  return withStateMutationLock(stateRoot, () => createStateBackupUnlocked(stateRoot, outputDir, options));
}

async function createStateBackupUnlocked(
  stateDir: string,
  outputDir: string,
  options: CreateStateBackupOptions = {}
): Promise<{ ok: true; operation: "backup"; destination: string; manifest: StateBackupManifest }> {
  const stateRoot = safeRoot(stateDir, "state");
  const destination = safeRoot(outputDir, "backup destination");
  assertSeparateTrees(stateRoot, destination);
  await validatePhysicalTree(stateRoot, "state");
  const inspection = await inspectStateSchemas(stateRoot);
  if (!inspection.healthy) throw new Error("state backup refused because the active state is unhealthy");
  if (await exists(destination)) throw new Error("state backup destination already exists");

  const parent = dirname(destination);
  const staging = join(parent, `.${basename(destination)}.backup-stage-${process.pid}-${randomBytes(6).toString("hex")}`);
  assertManagedSibling(staging, parent, `.${basename(destination)}.backup-stage-`);
  await ensurePhysicalParent(parent, "backup destination");
  await mkdir(staging, { mode: 0o700 });
  const includeSensitiveState = options.includeSensitiveState === true;
  const sensitiveExclusions = includeSensitiveState ? [] : await configuredSensitiveStatePaths(stateRoot);
  const files = await payloadFiles(stateRoot, includeSensitiveState, sensitiveExclusions);
  try {
    for (const file of files) {
      const source = join(stateRoot, file);
      const target = join(staging, file);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      if (/^db\/.+\.sqlite$/u.test(file)) await copySqliteSnapshot(source, target);
      else await cp(source, target, { force: false, errorOnExist: true });
      await chmod(target, 0o600);
    }
    const stagedAudit = await verifyAudit(staging);
    if (!stagedAudit.valid) throw new Error("state backup refused because the staged audit snapshot is inconsistent");
    const manifest: StateBackupManifest = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      kind: "odinn-state-backup",
      createdAt: new Date().toISOString(),
      sourceApplication: {
        version: String(options.applicationVersion || process.env.ODINN_VERSION || "unknown"),
        commit: String(options.applicationCommit || process.env.ODINN_COMMIT || "unknown")
      },
      stateSchemas: inspection.currentVersions,
      includesSensitiveState: includeSensitiveState,
      excluded: includeSensitiveState
        ? [...EPHEMERAL_STATE_FILES]
        : [...new Set([...DEFAULT_EXCLUSIONS, ...sensitiveExclusions, ...EPHEMERAL_STATE_FILES])],
      files: await Promise.all(files.map(async (file) => fileRecord(staging, file)))
    };
    await writeFile(join(staging, BACKUP_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await secureTree(staging);
    await inspectStateBackup(staging);
    await rename(staging, destination);
    return { ok: true, operation: "backup", destination, manifest };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function inspectStateBackup(inputDir: string): Promise<InspectedStateBackup> {
  const root = safeRoot(inputDir, "backup");
  await validatePhysicalTree(root, "state backup");
  const raw = JSON.parse(await readFile(join(root, BACKUP_MANIFEST), "utf8"));
  const manifest = validateManifest(raw);
  const actualFiles = (await payloadFiles(root, true)).filter((path) => path !== BACKUP_MANIFEST);
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  if (expected.size !== manifest.files.length) throw new Error("backup manifest contains duplicate file paths");
  if (actualFiles.length !== expected.size || actualFiles.some((path) => !expected.has(path))) {
    throw new Error("backup contents do not match the manifest");
  }
  for (const file of actualFiles) {
    const expectedFile = expected.get(file)!;
    const actual = await fileRecord(root, file);
    if (actual.bytes !== expectedFile.bytes || actual.sha256 !== expectedFile.sha256) {
      throw new Error(`backup checksum mismatch: ${file}`);
    }
  }
  for (const [surface, version] of Object.entries(manifest.stateSchemas) as Array<[StateSurface, number]>) {
    if (!(surface in STATE_SCHEMA_TARGETS)) throw new Error(`backup manifest contains unknown state surface: ${surface}`);
    if (version > STATE_SCHEMA_TARGETS[surface]) {
      throw new Error(`backup contains future ${surface} schema ${version}; this Odinn supports ${STATE_SCHEMA_TARGETS[surface]}`);
    }
  }
  return { root, manifest, valid: true };
}

export async function restoreStateBackup(
  inputDir: string,
  stateDir: string,
  options: RestoreStateBackupOptions = {}
): Promise<RestoreStateBackupReport> {
  const stateRoot = safeRoot(stateDir, "state");
  return withStateMutationLock(stateRoot, () => restoreStateBackupUnlocked(inputDir, stateRoot, options));
}

async function restoreStateBackupUnlocked(
  inputDir: string,
  stateDir: string,
  options: RestoreStateBackupOptions = {}
): Promise<RestoreStateBackupReport> {
  const source = await inspectStateBackup(inputDir);
  const stateRoot = safeRoot(stateDir, "state");
  assertSeparateTrees(stateRoot, source.root);
  const parent = dirname(stateRoot);
  const token = `${Date.now()}-${randomBytes(6).toString("hex")}`;
  const staging = join(parent, `.${basename(stateRoot)}.restore-stage-${token}`);
  const displaced = join(parent, `.${basename(stateRoot)}.restore-old-${token}`);
  assertManagedSibling(staging, parent, `.${basename(stateRoot)}.restore-stage-`);
  assertManagedSibling(displaced, parent, `.${basename(stateRoot)}.restore-old-`);

  let preRestoreBackup: string | null = null;
  const stateExists = await exists(stateRoot);
  if (stateExists && !options.skipCurrentBackup) {
    await validatePhysicalTree(stateRoot, "state");
    const backup = join(parent, `${basename(stateRoot)}.backups`, `restore-${token}`, "state");
    preRestoreBackup = (await createStateBackupUnlocked(stateRoot, backup, {
      ...options,
      includeSensitiveState: true
    })).destination;
  }

  await mkdir(staging, { mode: 0o700 });
  try {
    for (const file of source.manifest.files) {
      const from = join(source.root, file.path);
      const to = join(staging, file.path);
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await cp(from, to, { force: false, errorOnExist: true });
      await chmod(to, 0o600);
    }
    await secureTree(staging);
    const stagedInspection = await inspectStateSchemas(staging);
    assertRestorableSchemas(stagedInspection, source.manifest.stateSchemas);
    const stagedAudit = await verifyAudit(staging);
    if (!stagedAudit.valid) throw new Error("restored state failed audit integrity verification");

    if (stateExists) await rename(stateRoot, displaced);
    try {
      await rename(staging, stateRoot);
      const activeInspection = await inspectStateSchemas(stateRoot);
      assertRestorableSchemas(activeInspection, source.manifest.stateSchemas);
      const activeAudit = await verifyAudit(stateRoot);
      if (!activeAudit.valid) throw new Error("activated restore failed audit integrity verification");
      await appendLifecycleAudit(stateRoot, "state.restore", `Restored state from Odinn ${source.manifest.sourceApplication.version}`, {
        sourceVersion: source.manifest.sourceApplication.version,
        sourceCommit: source.manifest.sourceApplication.commit,
        sourceSchemas: source.manifest.stateSchemas
      });
      if (stateExists) await rm(displaced, { recursive: true, force: true });
      return {
        ok: true,
        operation: "restore",
        sourceVersion: source.manifest.sourceApplication.version,
        sourceCommit: source.manifest.sourceApplication.commit,
        sourceSchemas: source.manifest.stateSchemas,
        preRestoreBackup,
        restoredFiles: source.manifest.files.length,
        auditIntegrity: await verifyAudit(stateRoot)
      };
    } catch (error) {
      if (await exists(stateRoot)) {
        const failed = `${stateRoot}.failed-restore-${Date.now()}`;
        await rename(stateRoot, failed);
      }
      if (stateExists && await exists(displaced)) await rename(displaced, stateRoot);
      throw error;
    }
  } catch (error) {
    if (await exists(staging)) await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function stateLifecycleStatus(stateDir: string): Promise<{
  ok: boolean;
  stateDirectory: { exists: boolean; ownerOnly: boolean; healthy: boolean };
  schemas: StateInspection["surfaces"];
  compatibility: { stateApplicationVersion: string | null; stateApplicationCommit: string | null; minimumApplicationVersion: string | null };
  pendingMigration: boolean;
  lastMigration: Record<string, unknown> | null;
  backups: { available: number; latest: string | null };
  audit: { valid: boolean; events: number; unsigned: number };
  approvals: { pending: number };
  browserRecovery: { status: string; pending: boolean };
  jobs: { total: number; queued: number; running: number; failed: number; needsReview: number; completed: number };
  warnings: string[];
}> {
  const stateRoot = safeRoot(stateDir, "state");
  const stateExists = await exists(stateRoot);
  let inspection: StateInspection | undefined;
  let inspectionError = "";
  try {
    inspection = await inspectStateSchemas(stateRoot);
  } catch {
    inspectionError = "state schema inspection failed: persistent data is invalid or unreadable";
  }
  let ownerOnly = false;
  if (stateExists) ownerOnly = await isOwnerOnlyPath(stateRoot);
  let lastMigration: Record<string, unknown> | null = null;
  let historyError = "";
  try {
    lastMigration = await lastJsonLine(join(stateRoot, "migration-history.jsonl"));
  } catch {
    historyError = "migration history is invalid or unreadable";
  }
  const backupRoot = join(dirname(stateRoot), `${basename(stateRoot)}.backups`);
  const backupEntries = await directoriesIfPresent(backupRoot);
  let compatibilityMetadata: Record<string, any> = {};
  try {
    compatibilityMetadata = await readJsonIfPresent(join(stateRoot, "state-schema.json"), {});
  } catch {
    if (!inspectionError) inspectionError = "state compatibility metadata is invalid or unreadable";
  }
  let approvalsState: Record<string, any> | unknown[] = { approvals: [] };
  let approvalError = "";
  try {
    approvalsState = await readJsonOrArrayIfPresent(join(stateRoot, "approvals.json"), { approvals: [] });
  } catch {
    approvalError = "approval journal is invalid or unreadable";
  }
  const approvalRecords = Array.isArray(approvalsState)
    ? approvalsState
    : Array.isArray(approvalsState.approvals) ? approvalsState.approvals : [];
  const approvals = approvalRecords.filter(pendingApproval);
  let browserRecovery: Record<string, any> = { status: "clear" };
  let browserError = "";
  try {
    browserRecovery = await readJsonIfPresent(join(stateRoot, "browser-recovery.json"), { status: "clear" });
  } catch {
    browserError = "browser recovery journal is invalid or unreadable";
  }
  let jobsState: Record<string, any> = { jobs: {} };
  let jobsError = "";
  try {
    jobsState = await readJsonIfPresent(join(stateRoot, "jobs.json"), { jobs: {} });
  } catch {
    jobsError = "job store is invalid or unreadable";
  }
  const jobs = Object.values(jobsState.jobs ?? {}) as Array<{ status?: string }>;
  let audit = { valid: true, events: 0, unsigned: 0 };
  let auditError = "";
  try {
    audit = await verifyAudit(stateRoot);
  } catch {
    audit = { valid: false, events: 0, unsigned: 0 };
    auditError = "audit verification could not read the configured journal";
  }
  const interruptedMigration = await exists(join(dirname(stateRoot), `.${basename(stateRoot)}.migration-in-progress.json`));
  const warnings = [...(inspection?.warnings ?? [])];
  for (const warning of [inspectionError, historyError, approvalError, browserError, jobsError, auditError]) {
    if (warning) warnings.push(warning);
  }
  if (stateExists && !ownerOnly) warnings.push("state directory permissions are broader than owner-only");
  if (!audit.valid) warnings.push("audit integrity verification failed");
  if (["executing", "unknown"].includes(String(browserRecovery.status))) warnings.push("browser recovery requires operator resolution");
  if (interruptedMigration) warnings.push("an interrupted state migration requires recovery");
  return {
    ok: Boolean(inspection?.healthy) && audit.valid && (!stateExists || ownerOnly) && !interruptedMigration && warnings.length === 0,
    stateDirectory: { exists: stateExists, ownerOnly, healthy: Boolean(inspection?.healthy) },
    schemas: inspection?.surfaces ?? [],
    compatibility: {
      stateApplicationVersion: typeof compatibilityMetadata.applicationVersion === "string" ? compatibilityMetadata.applicationVersion : null,
      stateApplicationCommit: typeof compatibilityMetadata.applicationCommit === "string" ? compatibilityMetadata.applicationCommit : null,
      minimumApplicationVersion: typeof compatibilityMetadata.minimumApplicationVersion === "string" ? compatibilityMetadata.minimumApplicationVersion : null
    },
    pendingMigration: inspection?.surfaces.some((surface) => surface.currentVersion !== surface.targetVersion) ?? false,
    lastMigration,
    backups: { available: backupEntries.length, latest: backupEntries.at(-1) ?? null },
    audit,
    approvals: { pending: approvals.length },
    browserRecovery: {
      status: String(browserRecovery.status ?? "clear"),
      pending: ["executing", "unknown"].includes(String(browserRecovery.status))
    },
    jobs: {
      total: jobs.length,
      queued: jobs.filter((job) => job.status === "queued").length,
      running: jobs.filter((job) => job.status === "running").length,
      failed: jobs.filter((job) => job.status === "failed").length,
      needsReview: jobs.filter((job) => job.status === "needs-review").length,
      completed: jobs.filter((job) => job.status === "completed").length
    },
    warnings
  };
}

function validateManifest(value: unknown): StateBackupManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("backup manifest must contain an object");
  const manifest = value as Partial<StateBackupManifest>;
  if (manifest.schemaVersion !== BACKUP_SCHEMA_VERSION || manifest.kind !== "odinn-state-backup") {
    throw new Error("backup manifest is unsupported");
  }
  if (typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error("backup manifest createdAt is invalid");
  if (!manifest.sourceApplication || typeof manifest.sourceApplication.version !== "string" || typeof manifest.sourceApplication.commit !== "string") {
    throw new Error("backup manifest application identity is invalid");
  }
  if (!manifest.stateSchemas || typeof manifest.stateSchemas !== "object" || Array.isArray(manifest.stateSchemas)) {
    throw new Error("backup manifest state schemas are invalid");
  }
  const schemaKeys = Object.keys(manifest.stateSchemas);
  const expectedKeys = Object.keys(STATE_SCHEMA_TARGETS);
  if (schemaKeys.length !== expectedKeys.length || expectedKeys.some((key) => !schemaKeys.includes(key))) {
    throw new Error("backup manifest must include every state schema");
  }
  for (const [surface, version] of Object.entries(manifest.stateSchemas)) {
    if (!(surface in STATE_SCHEMA_TARGETS) || !Number.isInteger(version) || Number(version) < 0) {
      throw new Error(`backup manifest has an invalid ${surface} schema`);
    }
  }
  if (typeof manifest.includesSensitiveState !== "boolean" || !Array.isArray(manifest.excluded) || !manifest.excluded.every((item) => typeof item === "string")) {
    throw new Error("backup manifest exclusions are invalid");
  }
  if (!Array.isArray(manifest.files)) throw new Error("backup manifest file inventory is invalid");
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || !safeRelativePath(file.path)
      || !Number.isInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
      throw new Error("backup manifest contains an invalid file record");
    }
  }
  return manifest as StateBackupManifest;
}

function assertRestorableSchemas(inspection: StateInspection, recorded: StateSchemaVersions): void {
  if (!inspection.healthy) throw new Error("restored state is unhealthy");
  for (const surface of Object.keys(STATE_SCHEMA_TARGETS) as StateSurface[]) {
    if (inspection.currentVersions[surface] !== recorded[surface]) {
      throw new Error(`restored ${surface} schema does not match the backup manifest`);
    }
    if (inspection.currentVersions[surface] > STATE_SCHEMA_TARGETS[surface]) {
      throw new Error(`restored ${surface} schema is newer than this Odinn version supports`);
    }
  }
}

async function verifyAudit(stateRoot: string): Promise<{ valid: boolean; events: number; unsigned: number }> {
  if (!await exists(stateRoot)) return { valid: true, events: 0, unsigned: 0 };
  const config = await readJsonIfPresent(join(stateRoot, "config.json"), {});
  const filename = String(config.auditLog ?? "audit.jsonl");
  if (!/^audit(?:-[A-Za-z0-9._-]+)?\.jsonl$/u.test(filename)) {
    throw new Error("config.auditLog must be audit.jsonl or an audit-*.jsonl filename");
  }
  const path = join(stateRoot, filename);
  const databasePath = join(stateRoot, "db", `${basename(filename, ".jsonl")}.sqlite`);
  if (!await exists(databasePath) && !await exists(path)) return { valid: true, events: 0, unsigned: 0 };
  if (!await exists(databasePath)) {
    const result = await new FileAuditStore(path).verifyIntegrity({ allowUnsigned: true });
    return { valid: result.valid, events: result.events, unsigned: result.unsigned };
  }
  const store = new SqliteAuditStore(databasePath, { keyringPath: `${path}.keys.json` });
  const result = await store.verifyIntegrity({ allowUnsigned: true });
  store.close();
  return { valid: result.valid, events: result.events, unsigned: result.unsigned };
}

async function appendLifecycleAudit(stateRoot: string, type: string, message: string, data: Record<string, unknown>): Promise<void> {
  const config = await readJsonIfPresent(join(stateRoot, "config.json"), {});
  const filename = String(config.auditLog ?? "audit.jsonl");
  if (!/^audit(?:-[A-Za-z0-9._-]+)?\.jsonl$/u.test(filename)) return;
  const legacyPath = join(stateRoot, filename);
  const databasePath = join(stateRoot, "db", `${basename(filename, ".jsonl")}.sqlite`);
  const store = await exists(databasePath) ? new SqliteAuditStore(databasePath, { keyringPath: `${legacyPath}.keys.json` }) : new FileAuditStore(legacyPath);
  await store.append({
    runId: `lifecycle_${randomUUID()}`,
    type,
    actor: "odinn",
    message,
    data
  });
  if ("close" in store) store.close();
}

async function payloadFiles(root: string, includeSensitiveState: boolean, sensitiveExclusions: string[] = []): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path).replaceAll("\\", "/");
      if (isEphemeralStateFile(name)) continue;
      if (!includeSensitiveState && excludedFromNormalBackup(name, entry.isDirectory(), sensitiveExclusions)) continue;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error(`state contains a symbolic link: ${name}`);
      if (metadata.isDirectory()) await walk(path);
      else if (!metadata.isFile()) throw new Error(`state contains an unsupported file type: ${name}`);
      else {
        if (metadata.nlink !== 1) throw new Error(`state contains a hard-linked file: ${name}`);
        files.push(name);
      }
    }
  };
  await walk(root);
  return files.sort();
}

function excludedFromNormalBackup(path: string, directory: boolean, sensitiveExclusions: string[]): boolean {
  const normalized = directory ? `${path}/` : path;
  return [...DEFAULT_EXCLUSIONS, ...sensitiveExclusions].some((excluded) =>
    excluded.endsWith("/") ? normalized === excluded || normalized.startsWith(excluded) : normalized === excluded
  );
}

async function configuredSensitiveStatePaths(stateRoot: string): Promise<string[]> {
  const config = await readJsonIfPresent(join(stateRoot, "config.json"), {});
  const exclusions = new Set<string>();
  const providers = config.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return [];
  for (const provider of Object.values(providers)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
    const auth = (provider as Record<string, unknown>).auth;
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) continue;
    const tokenFile = (auth as Record<string, unknown>).tokenFile;
    if (typeof tokenFile !== "string" || !tokenFile) continue;
    const normalized = tokenFile.replaceAll("\\", "/");
    if (!safeRelativePath(normalized)) throw new Error("provider OAuth token path must stay inside the state directory");
    exclusions.add(normalized);
  }
  return [...exclusions].sort();
}

async function fileRecord(root: string, path: string): Promise<StateBackupFile> {
  const content = await readFile(join(root, path));
  return {
    path,
    bytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex")
  };
}

async function copySqliteSnapshot(source: string, destination: string): Promise<void> {
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    await backupSqlite(database, destination);
  } finally {
    database.close();
  }
}

async function validatePhysicalTree(root: string, label: string): Promise<void> {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} root must be a physical directory`);
  await payloadFiles(root, true);
}

async function secureTree(root: string): Promise<void> {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await secureTree(path);
    else if (entry.isFile()) await chmod(path, 0o600);
  }
}

async function ensurePhysicalParent(directory: string, label: string): Promise<void> {
  let nearest = resolve(directory);
  while (!await exists(nearest)) {
    const parent = dirname(nearest);
    if (parent === nearest) break;
    nearest = parent;
  }
  const nearestMetadata = await lstat(nearest);
  if (!nearestMetadata.isDirectory() || nearestMetadata.isSymbolicLink()) {
    throw new Error(`${label} parent must be a physical directory`);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parentMetadata = await lstat(directory);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error(`${label} parent must be a physical directory`);
  }
}

function safeRoot(path: string, label: string): string {
  const root = resolve(path);
  if (root === parse(root).root || dirname(root) === root || !basename(root)) throw new Error(`${label} path is too broad or ambiguous`);
  return root;
}

function assertSeparateTrees(left: string, right: string): void {
  if (left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`)) {
    throw new Error("state and backup paths must not contain one another");
  }
}

function assertManagedSibling(path: string, parent: string, prefix: string): void {
  const resolved = resolve(path);
  if (dirname(resolved) !== parent || !basename(resolved).startsWith(prefix)) throw new Error("unsafe lifecycle staging path");
}

function safeRelativePath(path: string): boolean {
  if (!path || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/u.test(path)) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function pendingApproval(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const approval = value as Record<string, unknown>;
  return approval.status === "pending"
    && Number(approval.expiresAt ?? Number.MAX_SAFE_INTEGER) > Date.now();
}

async function directoriesIfPresent(root: string): Promise<string[]> {
  try {
    const directories = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(entry.name);
    }
    return directories.sort();
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
}

async function lastJsonLine(path: string): Promise<Record<string, unknown> | null> {
  try {
    const lines = (await readFile(path, "utf8")).trim().split(/\r?\n/u).filter(Boolean);
    return lines.length ? JSON.parse(lines.at(-1)!) : null;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function readJsonIfPresent(path: string, fallback: Record<string, unknown>): Promise<Record<string, any>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${basename(path)} must contain an object`);
    return value;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return fallback;
    throw error;
  }
}

async function readJsonOrArrayIfPresent(
  path: string,
  fallback: Record<string, unknown>
): Promise<Record<string, any> | unknown[]> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object") throw new Error(`${basename(path)} must contain an object or array`);
    return value;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return fallback;
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
