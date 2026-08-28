import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { kill as signalProcess } from "node:process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  createStateBackup,
  extractSecureArchive,
  inspectStateSchemas,
  restoreStateBackup,
  sanitizedChildEnvironment,
  STATE_SCHEMA_TARGETS,
  type StateSchemaVersions
} from "@odinn/kernel";

const DEFAULT_PREFIX = join(homedir(), ".local", "share", "odinn");
const DEFAULT_RELEASE_API = "https://api.github.com/repos/BlueDot-IT/Odinn-Forge/releases/latest";
const DEFAULT_REPOSITORY_API = "https://api.github.com/repos/BlueDot-IT/Odinn-Forge";
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const WINDOWS_LAUNCHER_GENERATION_NAME = /^(?:odinn|odinn-gateway)\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.cmd$/iu;

export type ApplicationIdentity = {
  applicationVersion: string;
  applicationCommit: string;
};

type StandaloneReleaseArtifact = {
  name: string;
  target: string;
  bytes: number;
  sha256: string;
  embeddedRuntime: {
    version: string;
    target: string;
    archiveSha256: string;
    executableBytes: number;
    executableSha256: string;
    runtimePolicySha256: string;
  };
};

export type ReleaseManifest = {
  name: "odinn";
  version: string;
  commit: string;
  distribution: "compiled";
  runtimeSha256: string;
  artifacts: string[];
  standaloneArtifacts?: StandaloneReleaseArtifact[];
  nodeRuntimePolicySha256?: string;
  archiveSha256: Record<string, string>;
  stateSchemas?: StateSchemaVersions;
  minimumApplicationVersionForTargetState?: string;
};

type ReleaseSource = {
  manifest: ReleaseManifest;
  manifestLocation: string;
  checksumsLocation: string | null;
  artifactLocations: Record<string, string>;
  releaseNotesLocation: string | null;
  channel: "stable" | "prerelease" | "local";
  sizes: Record<string, number>;
};

export type UpdateCheckOptions = {
  identity: ApplicationIdentity;
  stateDir: string;
  packageRoot: string;
  prefix?: string;
  manifest?: string;
  checksums?: string;
  artifact?: string;
};

export async function checkForUpdate(options: UpdateCheckOptions) {
  const release = await discoverRelease(options);
  const currentDistribution = await packageDistribution(options.packageRoot);
  const installation = await readInstallState(installPrefix(options.prefix));
  const inspection = await inspectStateSchemas(options.stateDir);
  const targetSchemas = release.manifest.stateSchemas ?? STATE_SCHEMA_TARGETS;
  const migrationRequired = (Object.keys(STATE_SCHEMA_TARGETS) as Array<keyof StateSchemaVersions>)
    .some((surface) => inspection.currentVersions[surface] < targetSchemas[surface]);
  const blockingIncompatibilities = (Object.keys(STATE_SCHEMA_TARGETS) as Array<keyof StateSchemaVersions>)
    .filter((surface) => inspection.currentVersions[surface] > targetSchemas[surface])
    .map((surface) => `${surface} schema ${inspection.currentVersions[surface]} is newer than release schema ${targetSchemas[surface]}`);
  const previousVersion = installation.previous
    ? await installedVersion(installPrefix(options.prefix), installation.previous)
    : null;
  const currentStateMetadata = await readJsonIfPresent(join(options.stateDir, "state-schema.json"));
  const releaseMinimum = release.manifest.minimumApplicationVersionForTargetState ?? release.manifest.version;
  const currentMinimum = String(currentStateMetadata?.minimumApplicationVersion ?? "0.0.0");
  const minimum = compareVersions(currentMinimum, releaseMinimum) > 0 ? currentMinimum : releaseMinimum;
  const rollbackCompatible = previousVersion ? compareVersions(previousVersion, minimum) >= 0 : false;
  const artifactName = selectArtifact(release.manifest, currentDistribution);
  return {
    ok: true,
    currentVersion: options.identity.applicationVersion,
    currentCommit: options.identity.applicationCommit,
    currentReleaseChannel: releaseChannel(options.identity.applicationVersion),
    availableVersion: release.manifest.version,
    availableCommit: release.manifest.commit,
    availableReleaseChannel: release.channel,
    updateAvailable: compareVersions(release.manifest.version, options.identity.applicationVersion) > 0
      || release.manifest.commit !== options.identity.applicationCommit,
    stateMigrationRequired: migrationRequired,
    blockingIncompatibilities,
    applicationRollbackCompatible: rollbackCompatible,
    downloadSize: release.sizes[artifactName] ?? null,
    releaseNotesLocation: release.releaseNotesLocation,
    verificationRequirements: [
      "immutable Git tag commit",
      "SHA-256 checksum",
      "GitHub build attestation",
      "Odinn release manifest identity",
      "package release-info identity",
      ...(currentDistribution === "standalone" ? ["embedded runtime and policy identity"] : [])
    ],
    artifact: artifactName,
    manifestLocation: release.manifestLocation
  };
}

export async function updateApplication(options: UpdateCheckOptions) {
  const prefix = installPrefix(options.prefix);
  await validateInstallLayout(prefix);
  await assertActivePackage(prefix, options.packageRoot);
  const release = await discoverRelease(options);
  const currentDistribution = await packageDistribution(options.packageRoot);
  const versionComparison = compareVersions(release.manifest.version, options.identity.applicationVersion);
  if (versionComparison < 0) throw new Error("update refused a release older than the current application; use rollback for an installed previous version");
  if (versionComparison === 0) {
    if (release.manifest.commit !== options.identity.applicationCommit) {
      throw new Error("update refused a different commit with the current version number");
    }
    throw new Error("Odinn is already running this verified release");
  }
  const expectedArtifactName = selectArtifact(release.manifest, currentDistribution);
  const artifactName = options.artifact ? basename(options.artifact) : expectedArtifactName;
  if (artifactName !== expectedArtifactName) {
    throw new Error(`update artifact ${artifactName} does not match the required ${currentDistribution} artifact ${expectedArtifactName}`);
  }
  const standaloneArtifact = release.manifest.standaloneArtifacts?.find((entry) => entry.name === artifactName) ?? null;
  const artifactLocation = options.artifact
    ? resolve(options.artifact)
    : release.artifactLocations[artifactName];
  if (!artifactLocation) throw new Error(`release does not provide ${artifactName}`);
  const checksumsLocation = options.checksums
    ? resolve(options.checksums)
    : release.checksumsLocation;
  if (!checksumsLocation) throw new Error("update requires checksum metadata");

  const temporary = await mkdtemp(join(tmpdir(), "odinn-update-"));
  const downloadedArtifact = join(temporary, artifactName);
  const extracted = join(temporary, "extracted");
  const lifecycleId = `update-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomBytes(4).toString("hex")}`;
  let recoveryBackup: string | null = null;
  let switched = false;
  try {
    const artifact = await materialize(artifactLocation, downloadedArtifact, MAX_ARTIFACT_BYTES);
    const checksumText = await readTextResource(checksumsLocation, MAX_METADATA_BYTES);
    const expectedChecksum = checksumFor(checksumText, artifactName);
    if (artifact.sha256 !== expectedChecksum) throw new Error(`artifact checksum mismatch for ${artifactName}`);
    if (standaloneArtifact && artifact.bytes !== standaloneArtifact.bytes) throw new Error(`standalone artifact size mismatch for ${artifactName}`);
    if (release.manifest.archiveSha256?.[artifactName] !== expectedChecksum) {
      throw new Error("release manifest checksum does not match checksum metadata");
    }

    const expectedPackageRoot = standaloneArtifact
      ? `odinn-v${release.manifest.version}-standalone-${standaloneArtifact.target}`
      : `odinn-v${release.manifest.version}`;
    await extractVerifiedArchive(downloadedArtifact, extracted, expectedPackageRoot);
    const packageRoot = join(extracted, expectedPackageRoot);
    await verifyExtractedPackage(packageRoot, release.manifest, standaloneArtifact);
    const cliEntry = join(packageRoot, "dist", "cli", "index.js");
    const preSwitchVersion = runPackageNode(packageRoot, cliEntry, ["--version"]).stdout.trim();
    if (preSwitchVersion !== release.manifest.version) throw new Error("pre-switch smoke returned the wrong version");
    const migrationPlan = JSON.parse(runPackageNode(packageRoot, cliEntry, [
      "state",
      "migrate",
      "--dry-run",
      "--state",
      options.stateDir
    ]).stdout);
    if (migrationPlan.blockingIncompatibilities?.length) {
      throw new Error(`state migration is blocked: ${migrationPlan.blockingIncompatibilities.join("; ")}`);
    }
    if (migrationPlan.steps?.length) {
      recoveryBackup = (await createStateBackup(
        options.stateDir,
        join(prefix, "recovery", lifecycleId, "state"),
        {
          applicationVersion: options.identity.applicationVersion,
          applicationCommit: options.identity.applicationCommit,
          includeSensitiveState: true
        }
      )).destination;
    }

    const before = await readInstallState(prefix);
    const installer = join(packageRoot, "dist", "install", "install.js");
    runPackageNode(packageRoot, installer, [
      "upgrade",
      "--source",
      packageRoot,
      "--prefix",
      prefix,
      "--artifact-sha256",
      expectedChecksum,
      // v1.0.0 cannot validate UUID-named launcher companions. Its update
      // path must use the synchronous legacy-compatible handoff; newer
      // callers retain the crash-safe deferred activation protocol.
      ...(process.platform === "win32" && options.identity.applicationVersion !== "1.0.0"
        ? ["--defer-launchers-until-pid", String(process.pid)]
        : [])
    ]);
    switched = true;
    const installed = await readInstallState(prefix);
    if (installed.currentVersion !== release.manifest.version || installed.currentCommit !== release.manifest.commit) {
      throw new Error("installed application pointer does not match the verified release");
    }
    const installedRoot = join(prefix, "versions", String(installed.current));
    const health = JSON.parse(runPackageNode(installedRoot, join(installedRoot, "dist", "cli", "index.js"), [
      "doctor",
      "--state",
      options.stateDir
    ]).stdout);
    if (!health.ok) throw new Error("post-update health check failed");
    const state = await inspectStateSchemas(options.stateDir);
    await appendLifecycleHistory(prefix, {
      schemaVersion: 1,
      id: lifecycleId,
      operation: "update",
      status: "completed",
      from: { version: options.identity.applicationVersion, commit: options.identity.applicationCommit, versionId: before.current },
      to: { version: release.manifest.version, commit: release.manifest.commit, versionId: installed.current },
      artifactSha256: expectedChecksum,
      stateSchemas: state.currentVersions,
      stateBackup: recoveryBackup,
      completedAt: new Date().toISOString()
    });
    return {
      ok: true,
      operation: "update",
      version: release.manifest.version,
      commit: release.manifest.commit,
      versionId: installed.current,
      previousVersionId: installed.previous,
      stateSchemas: state.currentVersions,
      stateBackup: recoveryBackup,
      health: "passed",
      launcherActivation: process.platform === "win32" ? "deferred" : "complete"
    };
  } catch (error) {
    if (switched) {
      try {
        const current = await readInstallState(prefix);
        const currentRoot = join(prefix, "versions", String(current.current));
        runPackageNode(currentRoot, installerEntry(currentRoot), [
          "rollback",
          "--prefix",
          prefix,
          ...(process.platform === "win32" ? ["--defer-launchers-until-pid", String(process.pid)] : [])
        ]);
        if (recoveryBackup) {
          await restoreStateBackup(recoveryBackup, options.stateDir, {
            applicationVersion: options.identity.applicationVersion,
            applicationCommit: options.identity.applicationCommit,
            skipCurrentBackup: true
          });
        }
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "update failed and automatic recovery also failed");
      }
    }
    await appendLifecycleHistory(prefix, {
      schemaVersion: 1,
      id: lifecycleId,
      operation: "update",
      status: "failed",
      message: lifecycleFailureMessage(error),
      completedAt: new Date().toISOString()
    }).catch(() => undefined);
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function rollbackApplication(options: {
  identity: ApplicationIdentity;
  stateDir: string;
  packageRoot: string;
  prefix?: string;
}) {
  const prefix = installPrefix(options.prefix);
  await validateInstallLayout(prefix);
  await assertActivePackage(prefix, options.packageRoot);
  const installed = await readInstallState(prefix);
  if (!installed.current || !installed.previous) throw new Error("no previous Odinn application version is available");
  const previousMetadata = await readInstalledMetadata(prefix, installed.previous);
  const stateMetadata = await readJsonIfPresent(join(options.stateDir, "state-schema.json"));
  const minimumVersion = String(stateMetadata?.minimumApplicationVersion ?? "0.0.0");
  const matchingBackup = await latestMatchingStateBackup(prefix, String(installed.current));
  if (compareVersions(previousMetadata.version, minimumVersion) < 0) {
    throw new Error(
      `rollback refused: state requires Odinn ${minimumVersion} or newer, but the previous application is ${previousMetadata.version}`
      + (matchingBackup ? `; restore the compatible state backup at ${matchingBackup}` : "; no matching state backup is recorded")
    );
  }
  const currentRoot = join(prefix, "versions", String(installed.current));
  runPackageNode(currentRoot, installerEntry(currentRoot), [
    "rollback",
    "--prefix",
    prefix,
    ...(process.platform === "win32" ? ["--defer-launchers-until-pid", String(process.pid)] : [])
  ]);
  const rolledBack = await readInstallState(prefix);
  try {
    const priorRoot = join(prefix, "versions", String(rolledBack.current));
    const health = JSON.parse(runPackageNode(priorRoot, join(priorRoot, "dist", "cli", "index.js"), [
      "doctor",
      "--state",
      options.stateDir
    ]).stdout);
    if (!health.ok) throw new Error("rolled-back application failed its health check");
  } catch (error) {
    const priorRoot = join(prefix, "versions", String(rolledBack.current));
    runPackageNode(priorRoot, installerEntry(priorRoot), [
      "rollback",
      "--prefix",
      prefix,
      ...(process.platform === "win32" ? ["--defer-launchers-until-pid", String(process.pid)] : [])
    ]);
    throw error;
  }
  await appendLifecycleHistory(prefix, {
    schemaVersion: 1,
    id: `rollback-${Date.now()}-${randomBytes(4).toString("hex")}`,
    operation: "rollback",
    status: "completed",
    from: installed.current,
    to: rolledBack.current,
    completedAt: new Date().toISOString()
  });
  return {
    ok: true,
    operation: "rollback",
    version: rolledBack.currentVersion,
    commit: rolledBack.currentCommit,
    versionId: rolledBack.current,
    previousVersionId: rolledBack.previous
  };
}

export async function uninstallApplication(options: {
  stateDir: string;
  prefix?: string;
  removeState?: boolean;
  confirmed?: boolean;
  force?: boolean;
}) {
  const prefix = safeInstallPrefix(installPrefix(options.prefix));
  const stateRoot = safeStateRoot(options.stateDir);
  const targets = [
    join(prefix, "versions"),
    join(prefix, "bin"),
    join(prefix, "install-state.json"),
    join(prefix, "current"),
    join(prefix, ".launcher-activation.json")
  ];
  const releaseInstallLock = await acquireLifecycleInstallLock(prefix);
  try {
    await validateInstallLayout(prefix);
    if (options.removeState) {
      if (!options.confirmed && !options.force) {
        throw new Error(`uninstall --remove-state requires --confirm or --force; paths: ${[...targets, stateRoot].join(", ")}`);
      }
      assertNoUnsafeOverlap(prefix, stateRoot);
      await validateRemovableState(stateRoot);
    }
    for (const target of targets) await rm(target, { recursive: true, force: true });
    let stateRemoved = false;
    if (options.removeState) {
      await rm(stateRoot, { recursive: true, force: true });
      stateRemoved = true;
    }
    return {
      ok: true,
      operation: "uninstall",
      removed: targets,
      stateRemoved,
      retainedState: stateRemoved ? null : stateRoot,
      reinstall: stateRemoved
        ? "Install Odinn again and run odinn onboard."
        : `Install Odinn again and use the existing state at ${stateRoot}.`
    };
  } finally {
    await releaseInstallLock();
  }
}

async function validateInstallLayout(prefix: string): Promise<void> {
  try {
    const prefixMetadata = await lstat(prefix);
    if (!prefixMetadata.isDirectory() || prefixMetadata.isSymbolicLink()) {
      throw new Error("install prefix must be a physical directory");
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const state = await readInstallState(prefix);
  if (state.current !== null && typeof state.current !== "string") throw new Error("install state current pointer is invalid");
  if (state.previous !== null && typeof state.previous !== "string") throw new Error("install state previous pointer is invalid");
  try {
    const activation = await lstat(join(prefix, ".launcher-activation.json"));
    if (!activation.isFile() || activation.isSymbolicLink() || activation.nlink !== 1) {
      throw new Error("launcher activation marker must be a physical file");
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const bin = join(prefix, "bin");
  try {
    const binMetadata = await lstat(bin);
    if (!binMetadata.isDirectory() || binMetadata.isSymbolicLink()) {
      throw new Error("launcher root must be a physical directory");
    }
    const allowed = new Set([
      "odinn",
      "odinn.runtime.sh",
      "odinn.cmd",
      "odinn-gateway",
      "odinn-gateway.runtime.sh",
      "odinn-gateway.cmd"
    ]);
    for (const entry of await readdir(bin, { withFileTypes: true })) {
      const metadata = await lstat(join(bin, entry.name));
      if ((!allowed.has(entry.name) && !WINDOWS_LAUNCHER_GENERATION_NAME.test(entry.name))
        || !entry.isFile() || entry.isSymbolicLink()
        || !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        throw new Error(`uninstall refused an unexpected launcher entry: ${entry.name}`);
      }
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const versions = join(prefix, "versions");
  try {
    const versionsMetadata = await lstat(versions);
    if (!versionsMetadata.isDirectory() || versionsMetadata.isSymbolicLink()) {
      throw new Error("version root must be a physical directory");
    }
    for (const entry of await readdir(versions, { withFileTypes: true })) {
      if (/^\.staging-[A-Za-z0-9_-]+$/u.test(entry.name)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`stale installer entry has an unsafe type: ${entry.name}`);
        throw new Error(`installer transaction must be recovered before lifecycle mutation: ${entry.name}`);
      }
      if (!entry.isDirectory() || entry.isSymbolicLink() || !safeVersionId(entry.name)) {
        throw new Error(`uninstall refused an unexpected version entry: ${entry.name}`);
      }
      await readInstalledMetadata(prefix, entry.name);
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function acquireLifecycleInstallLock(prefix: string): Promise<() => Promise<void>> {
  let prefixMetadata;
  try {
    prefixMetadata = await lstat(prefix);
  } catch (error: any) {
    if (error?.code === "ENOENT") return async () => undefined;
    throw error;
  }
  if (!prefixMetadata.isDirectory() || prefixMetadata.isSymbolicLink()) {
    throw new Error("install prefix must be a physical directory");
  }
  assertNoLinkedAncestorsSync(prefix, "install prefix");

  const lockPath = join(prefix, ".install.lock");
  const ownerPath = join(lockPath, "owner.json");
  const token = randomBytes(16).toString("hex");
  try {
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(ownerPath, `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      token,
      startedAt: new Date().toISOString()
    })}\n`, { mode: 0o600, flag: "wx" });
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      const lockMetadata = await lstat(lockPath);
      if (!lockMetadata.isDirectory() || lockMetadata.isSymbolicLink()) {
        throw new Error("installer lock must be a physical directory");
      }
      const entries = await readdir(lockPath, { withFileTypes: true });
      if (entries.length !== 1 || entries[0]?.name !== "owner.json"
        || !entries[0].isFile() || entries[0].isSymbolicLink()) {
        throw new Error("installer lock contains unsupported entries");
      }
      const ownerMetadata = await lstat(ownerPath);
      if (!ownerMetadata.isFile() || ownerMetadata.isSymbolicLink() || ownerMetadata.nlink !== 1) {
        throw new Error("installer lock owner must be a physical file");
      }
      const owner = JSON.parse(await readFile(ownerPath, "utf8"));
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0 && lifecycleProcessIsAlive(owner.pid)) {
        throw new Error(`another installer command is active for this prefix (pid ${owner.pid})`);
      }
      throw new Error("stale installer lock must be reconciled before uninstall");
    }
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return async () => {
    const lockMetadata = await lstat(lockPath);
    const ownerMetadata = await lstat(ownerPath);
    if (!lockMetadata.isDirectory() || lockMetadata.isSymbolicLink()
      || !ownerMetadata.isFile() || ownerMetadata.isSymbolicLink() || ownerMetadata.nlink !== 1) {
      throw new Error("installer lock ownership changed before release");
    }
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    if (owner?.schemaVersion !== 1 || owner?.token !== token || owner?.pid !== process.pid) {
      throw new Error("installer lock ownership changed before release");
    }
    const retiredPath = `${lockPath}.retired-${token}`;
    await rename(lockPath, retiredPath);
    const retiredOwnerPath = join(retiredPath, "owner.json");
    const retiredMetadata = await lstat(retiredPath);
    const retiredOwnerMetadata = await lstat(retiredOwnerPath);
    if (!retiredMetadata.isDirectory() || retiredMetadata.isSymbolicLink()
      || !retiredOwnerMetadata.isFile() || retiredOwnerMetadata.isSymbolicLink() || retiredOwnerMetadata.nlink !== 1) {
      throw new Error("installer lock ownership changed during release");
    }
    const retiredOwner = JSON.parse(await readFile(retiredOwnerPath, "utf8"));
    if (retiredOwner?.schemaVersion !== 1 || retiredOwner?.token !== token || retiredOwner?.pid !== process.pid) {
      throw new Error("installer lock ownership changed during release");
    }
    await rm(retiredPath, { recursive: true, force: false });
  };
}

function lifecycleProcessIsAlive(pid: number): boolean {
  try {
    signalProcess(pid, 0);
    return true;
  } catch (error: any) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function validateRemovableState(stateRoot: string): Promise<void> {
  try {
    const metadata = await lstat(stateRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("state removal requires a physical state directory");
    const entries = await readdir(stateRoot);
    if (!entries.includes("config.json") && !entries.includes("state-schema.json")) {
      throw new Error("state removal refused because the directory is not recognizable as Odinn state");
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function discoverRelease(options: UpdateCheckOptions): Promise<ReleaseSource> {
  if (options.manifest) {
    const manifestLocation = normalizeResource(options.manifest);
    const manifest = validateReleaseManifest(JSON.parse(await readTextResource(manifestLocation, MAX_METADATA_BYTES)));
    const base = resourceBase(manifestLocation);
    const artifactNames = [...manifest.artifacts, ...(manifest.standaloneArtifacts ?? []).map((entry) => entry.name)];
    const artifactLocations = Object.fromEntries(artifactNames.map((name) => [
      name,
      options.artifact && basename(options.artifact) === name ? normalizeResource(options.artifact) : resourceChild(base, name)
    ]));
    const sizes: Record<string, number> = {};
    if (options.artifact && !isHttp(options.artifact)) {
      sizes[basename(options.artifact)] = (await stat(localPath(normalizeResource(options.artifact)))).size;
    }
    return {
      manifest,
      manifestLocation,
      checksumsLocation: options.checksums ? normalizeResource(options.checksums) : resourceChild(base, "SHA256SUMS.txt"),
      artifactLocations,
      releaseNotesLocation: null,
      channel: "local",
      sizes
    };
  }

  const response = await fetch(DEFAULT_RELEASE_API, {
    headers: { accept: "application/vnd.github+json", "user-agent": "odinn-update-check" },
    redirect: "error"
  });
  if (!response.ok) throw new Error(`release check failed with HTTP ${response.status}`);
  const release = await boundedJson(response, MAX_METADATA_BYTES);
  if (!release || typeof release !== "object" || !Array.isArray(release.assets)) throw new Error("GitHub release metadata is invalid");
  const assets = new Map<string, any>(release.assets.map((asset: any) => [String(asset.name), asset]));
  const manifestAsset = assets.get("release-manifest.json");
  if (!manifestAsset?.browser_download_url) throw new Error("release does not contain release-manifest.json");
  const manifest = validateReleaseManifest(JSON.parse(await readTextResource(String(manifestAsset.browser_download_url), MAX_METADATA_BYTES)));
  const tagName = String(release.tag_name);
  if (tagName !== `v${manifest.version}`) throw new Error("release tag and manifest version do not match");
  const tagCommit = await resolveGitHubTagCommit(tagName);
  if (tagCommit !== manifest.commit) throw new Error("release manifest commit does not match the immutable Git tag");
  const checksumAsset = assets.get("SHA256SUMS.txt");
  if (!checksumAsset?.browser_download_url) throw new Error("release does not contain SHA256SUMS.txt");
  const artifactLocations: Record<string, string> = {};
  const sizes: Record<string, number> = {};
  for (const name of [...manifest.artifacts, ...(manifest.standaloneArtifacts ?? []).map((entry) => entry.name)]) {
    const asset = assets.get(name);
    if (!asset?.browser_download_url) throw new Error(`release does not contain ${name}`);
    artifactLocations[name] = String(asset.browser_download_url);
    sizes[name] = Number(asset.size) || 0;
    await verifyGitHubReleaseAttestation({ artifactName: name, artifactDigest: manifest.archiveSha256[name], version: manifest.version, commit: manifest.commit });
  }
  return {
    manifest,
    manifestLocation: String(manifestAsset.browser_download_url),
    checksumsLocation: String(checksumAsset.browser_download_url),
    artifactLocations,
    releaseNotesLocation: typeof release.html_url === "string" ? release.html_url : null,
    channel: release.prerelease ? "prerelease" : "stable",
    sizes
  };
}

const EXPECTED_RELEASE_REPOSITORY = "BlueDot-IT/Odinn-Forge";

export async function verifyGitHubReleaseAttestation({
  artifactName,
  artifactDigest,
  version,
  commit,
  fetchImplementation = globalThis.fetch
}: {
  artifactName: string;
  artifactDigest: string;
  version: string;
  commit: string;
  fetchImplementation?: typeof fetch;
}): Promise<void> {
  if (!safeAssetName(artifactName) || !/^[a-f0-9]{64}$/u.test(artifactDigest)) throw new Error("release attestation input is invalid");
  const response = await fetchImplementation(`${DEFAULT_REPOSITORY_API}/attestations/${encodeURIComponent(`sha256:${artifactDigest}`)}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "odinn-update-check" },
    redirect: "error"
  });
  if (!response.ok) throw new Error(`release attestation lookup failed with HTTP ${response.status}`);
  const body = await boundedJson(response, MAX_METADATA_BYTES);
  const attestations = body && typeof body === "object" && Array.isArray((body as any).attestations) ? (body as any).attestations : [];
  const expectedDigest = artifactDigest;
  for (const attestation of attestations) {
    if (attestation?.verification_status !== "verified") continue;
    const payloadText = attestation?.bundle?.dsseEnvelope?.payload;
    if (typeof payloadText !== "string") continue;
    let statement: any;
    try { statement = JSON.parse(Buffer.from(payloadText, "base64").toString("utf8")); }
    catch { continue; }
    const subjects = Array.isArray(statement?.subject) ? statement.subject : [];
    const subjectMatches = subjects.some((subject: any) => String(subject?.name) === artifactName && String(subject?.digest?.sha256) === expectedDigest);
    if (!subjectMatches) continue;
    if (!String(statement?.predicateType ?? "").startsWith("https://slsa.dev/provenance/")) continue;
    const serialized = JSON.stringify(statement);
    const repositoryMatches = serialized.includes(EXPECTED_RELEASE_REPOSITORY)
      || serialized.includes(`https://github.com/${EXPECTED_RELEASE_REPOSITORY}`)
      || serialized.includes(`git+https://github.com/${EXPECTED_RELEASE_REPOSITORY}`);
    if (!repositoryMatches || !serialized.includes(commit) || !serialized.includes(`v${version}`) || !serialized.includes("release.yml")) continue;
    return;
  }
  throw new Error(`no verified GitHub build attestation matched ${artifactName} at ${commit}`);
}

export async function resolveGitHubTagCommit(tagName: string, fetchImplementation: typeof fetch = globalThis.fetch): Promise<string> {
  if (!/^v[0-9A-Za-z][0-9A-Za-z._-]*$/u.test(tagName)) throw new Error("release tag name is invalid");
  const refResponse = await fetchImplementation(`${DEFAULT_REPOSITORY_API}/git/ref/tags/${encodeURIComponent(tagName)}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "odinn-update-check" },
    redirect: "error"
  });
  if (!refResponse.ok) throw new Error(`release tag lookup failed with HTTP ${refResponse.status}`);
  const ref = await boundedJson(refResponse, MAX_METADATA_BYTES);
  if (ref?.ref !== `refs/tags/${tagName}`) throw new Error("release tag lookup returned the wrong ref");
  let object = ref?.object;
  for (let depth = 0; depth < 4; depth += 1) {
    const sha = String(object?.sha ?? "");
    const type = String(object?.type ?? "");
    if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("release tag object has an invalid commit identity");
    if (type === "commit") return sha;
    if (type !== "tag") throw new Error(`release tag resolved to unsupported object type: ${type || "missing"}`);
    const tagResponse = await fetchImplementation(`${DEFAULT_REPOSITORY_API}/git/tags/${sha}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "odinn-update-check" },
      redirect: "error"
    });
    if (!tagResponse.ok) throw new Error(`annotated release tag lookup failed with HTTP ${tagResponse.status}`);
    object = (await boundedJson(tagResponse, MAX_METADATA_BYTES))?.object;
  }
  throw new Error("release tag indirection exceeds the verification limit");
}

function validateReleaseManifest(value: unknown): ReleaseManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("release manifest must contain an object");
  const manifest = value as Partial<ReleaseManifest>;
  if (manifest.name !== "odinn" || manifest.distribution !== "compiled") throw new Error("release manifest does not identify compiled Odinn");
  if (!validVersion(manifest.version) || !/^[a-f0-9]{40}$/u.test(String(manifest.commit))) throw new Error("release manifest version or commit is invalid");
  if (!/^[a-f0-9]{64}$/u.test(String(manifest.runtimeSha256))) throw new Error("release manifest runtime digest is invalid");
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length || !manifest.artifacts.every(safeAssetName)) {
    throw new Error("release manifest artifact list is invalid");
  }
  if (!manifest.archiveSha256 || typeof manifest.archiveSha256 !== "object") throw new Error("release manifest archive checksums are missing");
  for (const artifact of manifest.artifacts) {
    if (!/^[a-f0-9]{64}$/u.test(String(manifest.archiveSha256[artifact]))) {
      throw new Error(`release manifest checksum is invalid for ${artifact}`);
    }
  }
  if (manifest.standaloneArtifacts !== undefined) {
    if (!SHA256.test(String(manifest.nodeRuntimePolicySha256 ?? ""))
      || !Array.isArray(manifest.standaloneArtifacts)
      || manifest.standaloneArtifacts.length === 0) {
      throw new Error("release manifest standalone runtime policy is invalid");
    }
    const names = new Set<string>();
    const targets = new Set<string>();
    for (const entry of manifest.standaloneArtifacts) {
      const expectedName = `odinn-v${manifest.version}-standalone-${entry.target}.${entry.target === "win32-x64" ? "zip" : "tar.gz"}`;
      if (!safeAssetName(entry?.name)
        || names.has(entry.name)
        || entry.name !== expectedName
        || targets.has(entry.target)
        || !/^(?:linux|darwin|win32)-x64$/u.test(String(entry.target))
        || entry.embeddedRuntime?.target !== entry.target
        || !/^24\.\d+\.\d+$/u.test(String(entry.embeddedRuntime?.version))
        || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > MAX_ARTIFACT_BYTES
        || !SHA256.test(String(entry.sha256))
        || manifest.archiveSha256[entry.name] !== entry.sha256
        || !SHA256.test(String(entry.embeddedRuntime?.archiveSha256))
        || !Number.isSafeInteger(entry.embeddedRuntime?.executableBytes) || entry.embeddedRuntime.executableBytes <= 0
        || !SHA256.test(String(entry.embeddedRuntime?.executableSha256))
        || entry.embeddedRuntime?.runtimePolicySha256 !== manifest.nodeRuntimePolicySha256) {
        throw new Error("release manifest standalone artifact identity is invalid");
      }
      names.add(entry.name);
      targets.add(entry.target);
    }
    if (JSON.stringify([...targets].sort()) !== JSON.stringify(["darwin-x64", "linux-x64", "win32-x64"])) {
      throw new Error("release manifest standalone target matrix is incomplete");
    }
  }
  if (manifest.stateSchemas) validateStateSchemaRecord(manifest.stateSchemas);
  if (manifest.minimumApplicationVersionForTargetState && !validVersion(manifest.minimumApplicationVersionForTargetState)) {
    throw new Error("release manifest minimum application version is invalid");
  }
  return manifest as ReleaseManifest;
}

async function verifyExtractedPackage(packageRoot: string, manifest: ReleaseManifest, standaloneArtifact: StandaloneReleaseArtifact | null): Promise<void> {
  await validatePhysicalTree(packageRoot);
  const packageMetadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const releaseInfo = JSON.parse(await readFile(join(packageRoot, "release-info.json"), "utf8"));
  const recognizedPackageName = packageMetadata.name === "odinn" || packageMetadata.name === "@bluedot-it/odinn";
  if (!recognizedPackageName || packageMetadata.version !== manifest.version) {
    throw new Error("package metadata does not match the release manifest");
  }
  if (releaseInfo.name !== manifest.name
    || releaseInfo.version !== manifest.version
    || releaseInfo.commit !== manifest.commit
    || releaseInfo.distribution !== (standaloneArtifact ? "standalone" : manifest.distribution)
    || releaseInfo.runtimeSha256 !== manifest.runtimeSha256) {
    throw new Error("package release identity does not match the release manifest");
  }
  for (const required of ["dist/cli/index.js", "dist/gateway/server.js", "dist/install/install.js", "package.json", "release-info.json"]) {
    const path = join(packageRoot, required);
    if (!existsSync(path) || !(await lstat(path)).isFile()) throw new Error(`release package is missing ${required}`);
  }
  if (standaloneArtifact) {
    const expectedTarget = `${process.platform}-${process.arch}`;
    if (standaloneArtifact.target !== expectedTarget
      || packageMetadata.odinnStandalone?.target !== expectedTarget
      || packageMetadata.odinnStandalone?.runtimePolicySha256 !== manifest.nodeRuntimePolicySha256
      || JSON.stringify(releaseInfo.embeddedRuntime) !== JSON.stringify(standaloneArtifact.embeddedRuntime)) {
      throw new Error("standalone package runtime identity does not match the release manifest");
    }
    const runtimeName = process.platform === "win32" ? "node.exe" : "node";
    const runtimePath = join(packageRoot, "runtime", runtimeName);
    const runtimeMetadata = await lstat(runtimePath);
    if (!runtimeMetadata.isFile() || runtimeMetadata.isSymbolicLink() || runtimeMetadata.nlink !== 1
      || runtimeMetadata.size !== standaloneArtifact.embeddedRuntime.executableBytes) {
      throw new Error("standalone package runtime is not a physical file with the declared size");
    }
    const runtimeDigest = createHash("sha256").update(await readFile(runtimePath)).digest("hex");
    const policyDigest = createHash("sha256").update(await readFile(join(packageRoot, "THIRD_PARTY_NOTICES", "node-runtime-policy.json"))).digest("hex");
    if (runtimeDigest !== standaloneArtifact.embeddedRuntime.executableSha256 || policyDigest !== manifest.nodeRuntimePolicySha256) {
      throw new Error("standalone package runtime or policy digest mismatch");
    }
  } else if (existsSync(join(packageRoot, "runtime")) || releaseInfo.embeddedRuntime !== undefined || packageMetadata.odinnStandalone !== undefined) {
    throw new Error("compiled release package contains undeclared embedded runtime material");
  }
}

async function extractVerifiedArchive(archive: string, destination: string, expectedRoot: string): Promise<void> {
  await extractSecureArchive(archive, destination, {
    expectedRoot,
    maximumArchiveBytes: MAX_ARTIFACT_BYTES,
    maximumExpandedBytes: 2 * MAX_ARTIFACT_BYTES
  });
}

async function validatePhysicalTree(root: string): Promise<void> {
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("release root must be a physical directory");
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error(`release contains a symbolic link: ${relative(root, path)}`);
      if (metadata.isDirectory()) await walk(path);
      else if (!metadata.isFile()) throw new Error(`release contains an unsupported file type: ${relative(root, path)}`);
      else if (metadata.nlink !== 1) throw new Error(`release contains a hard-linked file: ${relative(root, path)}`);
    }
  };
  await walk(root);
}

async function materialize(source: string, destination: string, maximumBytes: number): Promise<{ sha256: string; bytes: number }> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (!isHttp(source)) {
    const local = localPath(source);
    const metadata = await stat(local);
    if (!metadata.isFile() || metadata.size > maximumBytes) throw new Error("artifact is missing or exceeds the size limit");
    await cp(local, destination, { force: false, errorOnExist: true });
    const content = await readFile(destination);
    return { sha256: createHash("sha256").update(content).digest("hex"), bytes: content.byteLength };
  }
  assertSecureRemote(source);
  const response = await fetch(source, { redirect: "follow", headers: { "user-agent": "odinn-updater" } });
  assertSecureRemote(response.url);
  if (!response.ok || !response.body) throw new Error(`artifact download failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maximumBytes) throw new Error("artifact exceeds the size limit");
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maximumBytes) return callback(new Error("artifact exceeds the size limit"));
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(destination, { mode: 0o600, flags: "wx" }));
  return { sha256: hash.digest("hex"), bytes };
}

async function readTextResource(source: string, maximumBytes: number): Promise<string> {
  if (!isHttp(source)) {
    const content = await readFile(localPath(source));
    if (content.byteLength > maximumBytes) throw new Error("metadata exceeds the size limit");
    return content.toString("utf8");
  }
  assertSecureRemote(source);
  const response = await fetch(source, { redirect: "follow", headers: { "user-agent": "odinn-updater" } });
  assertSecureRemote(response.url);
  if (!response.ok) throw new Error(`metadata download failed with HTTP ${response.status}`);
  return (await readBoundedResponse(response, maximumBytes, "metadata")).toString("utf8");
}

async function boundedJson(response: Response, maximumBytes: number): Promise<any> {
  return JSON.parse((await readBoundedResponse(response, maximumBytes, "release metadata")).toString("utf8"));
}

async function readBoundedResponse(response: Response, maximumBytes: number, label: string): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maximumBytes) throw new Error(`${label} exceeds the size limit`);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) throw new Error(`${label} exceeds the size limit`);
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

function checksumFor(text: string, name: string): string {
  let found = "";
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/u.exec(line);
    if (!match) throw new Error(`invalid checksum metadata line: ${line}`);
    if (match[2] === name) {
      if (found) throw new Error(`duplicate checksum for ${name}`);
      found = match[1]!;
    }
  }
  if (!found) throw new Error(`checksum metadata does not cover ${name}`);
  return found;
}

function selectArtifact(manifest: ReleaseManifest, distribution: "standalone" | "compiled" | "source"): string {
  if (distribution === "standalone") {
    const target = `${process.platform}-${process.arch}`;
    const artifact = manifest.standaloneArtifacts?.find((entry) => entry.target === target);
    if (!artifact) throw new Error(`release has no controlled standalone artifact for ${target}`);
    return artifact.name;
  }
  const preferred = process.platform === "win32" ? ".zip" : ".tar.gz";
  const artifact = manifest.artifacts.find((name) => name.endsWith(preferred));
  if (!artifact) throw new Error(`release has no ${preferred} artifact for this platform`);
  return artifact;
}

function installerEntry(root: string): string {
  const compiled = join(root, "dist", "install", "install.js");
  if (existsSync(compiled)) return compiled;
  const source = join(root, "scripts", "install.ts");
  if (existsSync(source)) return source;
  throw new Error("installed application does not contain its lifecycle installer");
}

function runPackageNode(packageRoot: string, entry: string, args: string[]) {
  const selected = validatedPackageRuntime(packageRoot);
  return runCommand(selected.runtime, [entry, ...args], packageRoot);
}

function validatedPackageRuntime(packageRoot: string): {
  distribution: "standalone" | "compiled" | "source";
  runtime: string;
} {
  const releaseInfoPath = join(packageRoot, "release-info.json");
  const packagePath = join(packageRoot, "package.json");
  const releaseInfo = existsSync(releaseInfoPath) ? JSON.parse(readFileSync(releaseInfoPath, "utf8")) : {};
  const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8"));
  const distribution = releaseInfo.distribution === "standalone" || releaseInfo.distribution === "compiled"
    ? releaseInfo.distribution
    : releaseInfo.distribution === undefined ? "source" : null;
  if (!distribution) throw new Error("package distribution metadata is invalid");
  const runtimeDirectory = join(packageRoot, "runtime");
  if (distribution !== "standalone") {
    if (existsSync(runtimeDirectory) || releaseInfo.embeddedRuntime !== undefined || packageMetadata.odinnStandalone !== undefined) {
      throw new Error("runtime-dependent package contains undeclared embedded runtime material");
    }
    return { distribution, runtime: process.execPath };
  }

  const expectedTarget = `${process.platform}-${process.arch}`;
  const runtimeName = process.platform === "win32" ? "node.exe" : "node";
  const runtime = join(runtimeDirectory, runtimeName);
  const expectedDigest = String(releaseInfo.embeddedRuntime?.executableSha256 ?? "");
  const expectedPolicyDigest = String(releaseInfo.embeddedRuntime?.runtimePolicySha256 ?? "");
  if (releaseInfo.embeddedRuntime?.target !== expectedTarget
    || !/^24\.\d+\.\d+$/u.test(String(releaseInfo.embeddedRuntime?.version ?? ""))
    || packageMetadata.odinnStandalone?.target !== expectedTarget
    || packageMetadata.odinnStandalone?.version !== releaseInfo.embeddedRuntime?.version
    || packageMetadata.odinnStandalone?.runtime !== "node"
    || packageMetadata.odinnStandalone?.executableSha256 !== expectedDigest
    || packageMetadata.odinnStandalone?.runtimePolicySha256 !== expectedPolicyDigest
    || !Number.isSafeInteger(releaseInfo.embeddedRuntime?.executableBytes)
    || releaseInfo.embeddedRuntime.executableBytes <= 0
    || !SHA256.test(expectedDigest) || !SHA256.test(expectedPolicyDigest)) {
    throw new Error("standalone package runtime metadata is invalid for this platform");
  }
  assertNoLinkedAncestorsSync(packageRoot, "standalone package root");
  const reviewedRuntimeAliasAncestor = assertNoLinkedAncestorsSync(runtimeDirectory, "standalone runtime directory");
  const packageRootMetadata = lstatSync(packageRoot);
  const runtimeDirectoryMetadata = lstatSync(runtimeDirectory);
  const runtimeMetadata = lstatSync(runtime);
  if (!packageRootMetadata.isDirectory() || packageRootMetadata.isSymbolicLink()
    || !runtimeDirectoryMetadata.isDirectory() || runtimeDirectoryMetadata.isSymbolicLink()
    || !runtimeMetadata.isFile() || runtimeMetadata.isSymbolicLink() || runtimeMetadata.nlink !== 1
    || runtimeMetadata.size !== releaseInfo.embeddedRuntime.executableBytes
    || readdirSync(runtimeDirectory).length !== 1 || readdirSync(runtimeDirectory)[0] !== runtimeName
    || !hasStablePhysicalPathSync(runtimeDirectory, runtimeDirectoryMetadata, reviewedRuntimeAliasAncestor)
    || !hasStablePhysicalPathSync(runtime, runtimeMetadata, reviewedRuntimeAliasAncestor)) {
    throw new Error("standalone embedded runtime must be a physical regular file without linked ancestors");
  }
  if (createHash("sha256").update(readFileSync(runtime)).digest("hex") !== expectedDigest) {
    throw new Error("standalone embedded runtime digest mismatch");
  }
  const policy = join(packageRoot, "THIRD_PARTY_NOTICES", "node-runtime-policy.json");
  const reviewedPolicyAliasAncestor = assertNoLinkedAncestorsSync(dirname(policy), "standalone runtime policy directory");
  const policyMetadata = lstatSync(policy);
  const policyBytes = readFileSync(policy);
  if (!policyMetadata.isFile() || policyMetadata.isSymbolicLink() || policyMetadata.nlink !== 1
    || !hasStablePhysicalPathSync(policy, policyMetadata, reviewedPolicyAliasAncestor)
    || createHash("sha256").update(policyBytes).digest("hex") !== expectedPolicyDigest) {
    throw new Error("standalone embedded runtime policy digest mismatch");
  }
  validateEmbeddedRuntimePolicy(policyBytes, expectedTarget, releaseInfo.embeddedRuntime);
  const reportedVersion = runCommand(runtime, ["--version"], packageRoot).stdout.trim();
  if (reportedVersion !== `v${releaseInfo.embeddedRuntime.version}`) {
    throw new Error("standalone embedded runtime version output does not match authenticated metadata");
  }
  return { distribution, runtime };
}

function validateEmbeddedRuntimePolicy(policyBytes: Buffer, expectedTarget: string, evidence: Record<string, any>): void {
  let policy: any;
  try {
    policy = JSON.parse(policyBytes.toString("utf8"));
  } catch {
    throw new Error("standalone embedded runtime policy is invalid");
  }
  const target = policy?.targets?.[expectedTarget];
  if (policy?.schemaVersion !== 1
    || policy?.version !== evidence.version
    || policy?.origin !== "https://nodejs.org"
    || !SHA256.test(String(policy?.signedManifest?.sha256 ?? ""))
    || !SHA256.test(String(policy?.signedManifest?.cleartextSha256 ?? ""))
    || !SHA256.test(String(policy?.keyring?.sha256 ?? ""))
    || !Array.isArray(policy?.keyring?.allowedPrimaryFingerprints)
    || policy.keyring.allowedPrimaryFingerprints.length === 0
    || !policy.keyring.allowedPrimaryFingerprints.every((value: unknown) => /^[A-F0-9]{40}$/u.test(String(value)))
    || !target
    || target.executableBytes !== evidence.executableBytes
    || target.executableSha256 !== evidence.executableSha256
    || (evidence.archiveSha256 !== undefined && target.sha256 !== evidence.archiveSha256)) {
    throw new Error("standalone embedded runtime policy does not match authenticated runtime metadata");
  }
}

function assertNoLinkedAncestorsSync(path: string, label: string): boolean {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  let reviewedDarwinAliasAncestor = false;
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current)) return reviewedDarwinAliasAncestor;
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) {
      const physicalPath = realpathSync(current);
      const physical = lstatSync(physicalPath);
      if (!reviewedDarwinRootAlias(metadata, physical)) {
        throw new Error(`${label} must not traverse a symbolic link or reparse point`);
      }
      reviewedDarwinAliasAncestor = true;
      continue;
    }
    if (!metadata.isDirectory() && current !== absolute) throw new Error(`${label} has a non-directory ancestor`);
    const physicalPath = realpathSync(current);
    if (!samePhysicalPath(physicalPath, current)
      && (!(process.platform === "win32" || reviewedDarwinAliasAncestor)
        || !sameStableFilesystemIdentity(metadata, lstatSync(physicalPath)))) {
      throw new Error(`${label} must not traverse a linked ancestor`);
    }
  }
  return reviewedDarwinAliasAncestor;
}

function reviewedDarwinRootAlias(link: Stats, physical: Stats): boolean {
  return process.platform === "darwin"
    && link.uid === 0
    && physical.isDirectory()
    && !physical.isSymbolicLink()
    && physical.uid === 0
    && (physical.mode & 0o022) === 0;
}

function hasStablePhysicalPathSync(path: string, metadata: Stats, reviewedDarwinAliasAncestor: boolean): boolean {
  const physicalPath = realpathSync(path);
  return samePhysicalPath(physicalPath, path)
    || ((process.platform === "win32" || reviewedDarwinAliasAncestor)
      && sameStableFilesystemIdentity(metadata, lstatSync(physicalPath)));
}

function sameStableFilesystemIdentity(left: Stats, right: Stats): boolean {
  return left.dev !== 0
    && left.ino !== 0
    && left.dev === right.dev
    && left.ino === right.ino
    && left.isDirectory() === right.isDirectory()
    && left.isFile() === right.isFile();
}

function samePhysicalPath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function runCommand(command: string, args: string[], cwd: string): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    env: { ...sanitizedChildEnvironment(), ODINN_NONINTERACTIVE: "1" }
  });
  if (result.status !== 0) {
    throw new Error(`${basename(command)} failed: ${String(result.stderr || result.stdout || result.error?.message).trim()}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function installPrefix(explicit?: string): string {
  return resolve(explicit || process.env.ODINN_INSTALL_PREFIX || DEFAULT_PREFIX);
}

function safeInstallPrefix(path: string): string {
  const prefix = resolve(path);
  if (prefix === parse(prefix).root || prefix === homedir() || dirname(prefix) === prefix) {
    throw new Error("install prefix is too broad or ambiguous");
  }
  return prefix;
}

function safeStateRoot(path: string): string {
  const state = resolve(path);
  if (state === parse(state).root || state === homedir() || dirname(state) === state) {
    throw new Error("state path is too broad or ambiguous");
  }
  return state;
}

function assertNoUnsafeOverlap(prefix: string, state: string): void {
  if (prefix === state || prefix.startsWith(`${state}${sep}`) || state.startsWith(`${prefix}${sep}`)) {
    throw new Error("install prefix and state path must not contain one another");
  }
}

async function readInstallState(prefix: string): Promise<Record<string, any>> {
  try {
    const path = join(prefix, "install-state.json");
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error("install state must be a physical file");
    }
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || value.schemaVersion !== 1) throw new Error("install state is invalid or unsupported");
    return value;
  } catch (error: any) {
    if (error?.code === "ENOENT") return { schemaVersion: 1, current: null, previous: null };
    throw error;
  }
}

async function readInstalledMetadata(prefix: string, versionId: string): Promise<Record<string, any>> {
  if (!safeVersionId(versionId)) throw new Error("install state contains an unsafe version identifier");
  const path = join(prefix, "versions", versionId, "install-metadata.json");
  const fileMetadata = await lstat(path);
  if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink() || fileMetadata.nlink !== 1) {
    throw new Error(`installed metadata must be a physical file for ${versionId}`);
  }
  const metadata = JSON.parse(await readFile(path, "utf8"));
  if (!metadata || !validVersion(metadata.version) || typeof metadata.commit !== "string") {
    throw new Error(`installed metadata is invalid for ${versionId}`);
  }
  return metadata;
}

async function installedVersion(prefix: string, versionId: string): Promise<string> {
  return String((await readInstalledMetadata(prefix, versionId)).version);
}

async function assertActivePackage(prefix: string, packageRoot: string): Promise<void> {
  const installed = await readInstallState(prefix);
  if (!installed.current) return;
  const expected = resolve(prefix, "versions", String(installed.current));
  let canonicalExpected = expected;
  let canonicalRoot = resolve(packageRoot);
  try {
    canonicalExpected = await realpath(expected);
    canonicalRoot = await realpath(packageRoot);
  } catch {
    // Keep resolved paths if realpath fails
  }
  if (canonicalRoot !== canonicalExpected && resolve(packageRoot) !== expected) {
    throw new Error("lifecycle command is not running from the active installed application");
  }
}

async function appendLifecycleHistory(prefix: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(prefix, { recursive: true, mode: 0o700 });
  const path = join(prefix, "lifecycle-history.jsonl");
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error("lifecycle history must be a physical file");
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(path, `${JSON.stringify(record)}\n`, { flag: "a", mode: 0o600 });
  await chmod(path, 0o600);
}

async function latestMatchingStateBackup(prefix: string, currentVersionId: string): Promise<string | null> {
  try {
    const lines = (await readFile(join(prefix, "lifecycle-history.jsonl"), "utf8")).trim().split(/\r?\n/u).filter(Boolean).reverse();
    for (const line of lines) {
      const record = JSON.parse(line);
      if (record.operation === "update" && record.status === "completed"
        && String(record.to?.versionId) === currentVersionId && typeof record.stateBackup === "string") {
        return record.stateBackup;
      }
    }
    return null;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonIfPresent(path: string): Promise<Record<string, any> | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function packageDistribution(packageRoot: string): Promise<"standalone" | "compiled" | "source"> {
  return validatedPackageRuntime(packageRoot).distribution;
}

function validateStateSchemaRecord(value: StateSchemaVersions): void {
  const expected = Object.keys(STATE_SCHEMA_TARGETS);
  if (Object.keys(value).length !== expected.length) throw new Error("release manifest state schemas are incomplete");
  for (const surface of expected as Array<keyof StateSchemaVersions>) {
    if (!Number.isInteger(value[surface]) || value[surface] < 0) throw new Error(`release manifest ${surface} schema is invalid`);
  }
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}

function compareVersions(left: string, right: string): number {
  const parseVersion = (value: string) => {
    if (!validVersion(value)) return [0, 0, 0, ""] as const;
    const [withoutBuild] = value.split("+", 1);
    const separator = withoutBuild!.indexOf("-");
    const core = separator >= 0 ? withoutBuild!.slice(0, separator) : withoutBuild!;
    const prerelease = separator >= 0 ? withoutBuild!.slice(separator + 1) : "";
    const numbers = core!.split(".").map(Number);
    return [numbers[0]!, numbers[1]!, numbers[2]!, prerelease] as const;
  };
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return Number(a[index]) - Number(b[index]);
  }
  if (a[3] === b[3]) return 0;
  if (!a[3]) return 1;
  if (!b[3]) return -1;
  const aParts = a[3].split(".");
  const bParts = b[3].split(".");
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const aPart = aParts[index];
    const bPart = bParts[index];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    if (aPart === bPart) continue;
    const aNumeric = /^\d+$/u.test(aPart);
    const bNumeric = /^\d+$/u.test(bPart);
    if (aNumeric && bNumeric) return Number(aPart) - Number(bPart);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return aPart.localeCompare(bPart);
  }
  return 0;
}

function releaseChannel(version: string): "stable" | "prerelease" | "development" {
  if (!validVersion(version)) return "development";
  return version.includes("-") ? "prerelease" : "stable";
}

function safeAssetName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function safeVersionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function normalizeResource(value: string): string {
  if (isHttp(value)) {
    assertSecureRemote(value);
    return value;
  }
  if (value.startsWith("file:")) return value;
  return resolve(value);
}

function resourceBase(resource: string): string {
  if (isHttp(resource) || resource.startsWith("file:")) return new URL(".", resource).toString();
  return dirname(resource);
}

function resourceChild(base: string, name: string): string {
  if (isHttp(base) || base.startsWith("file:")) return new URL(name, base).toString();
  return join(base, name);
}

function localPath(resource: string): string {
  if (resource.startsWith("file:")) return fileURLToPath(resource);
  return resolve(resource);
}

function isHttp(value: string): boolean {
  return value.startsWith("https://") || value.startsWith("http://");
}

function assertSecureRemote(value: string): void {
  if (!value.startsWith("https://")) throw new Error("remote lifecycle resources require HTTPS");
}

function lifecycleFailureMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|authorization)=)[^&\s]+/giu, "$1[redacted]")
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|authorization)\s*[=:]\s*)[^\s,;]+/giu, "$1[redacted]")
    .slice(0, 1_000);
}
