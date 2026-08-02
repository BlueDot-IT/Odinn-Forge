import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  createStateBackup,
  inspectStateSchemas,
  restoreStateBackup,
  STATE_SCHEMA_TARGETS,
  type StateSchemaVersions
} from "@odinn/kernel";

const DEFAULT_PREFIX = join(homedir(), ".local", "share", "odinn");
const DEFAULT_RELEASE_API = "https://api.github.com/repos/BlueDot-IT/Odinn-Forge/releases/latest";
const DEFAULT_REPOSITORY_API = "https://api.github.com/repos/BlueDot-IT/Odinn-Forge";
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

export type ApplicationIdentity = {
  applicationVersion: string;
  applicationCommit: string;
};

export type ReleaseManifest = {
  name: "odinn";
  version: string;
  commit: string;
  distribution: "compiled";
  runtimeSha256: string;
  artifacts: string[];
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
  const artifactName = selectArtifact(release.manifest.artifacts);
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
    verificationRequirements: ["immutable Git tag commit", "SHA-256 checksum", "Odinn release manifest identity", "package release-info identity"],
    artifact: artifactName,
    manifestLocation: release.manifestLocation
  };
}

export async function updateApplication(options: UpdateCheckOptions) {
  const prefix = installPrefix(options.prefix);
  await validateInstallLayout(prefix);
  await assertActivePackage(prefix, options.packageRoot);
  const release = await discoverRelease(options);
  const versionComparison = compareVersions(release.manifest.version, options.identity.applicationVersion);
  if (versionComparison < 0) throw new Error("update refused a release older than the current application; use rollback for an installed previous version");
  if (versionComparison === 0) {
    if (release.manifest.commit !== options.identity.applicationCommit) {
      throw new Error("update refused a different commit with the current version number");
    }
    throw new Error("Odinn is already running this verified release");
  }
  const artifactName = options.artifact ? basename(options.artifact) : selectArtifact(release.manifest.artifacts);
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
    if (release.manifest.archiveSha256?.[artifactName] !== expectedChecksum) {
      throw new Error("release manifest checksum does not match checksum metadata");
    }

    await extractVerifiedArchive(downloadedArtifact, extracted, release.manifest.version);
    const packageRoot = join(extracted, `odinn-v${release.manifest.version}`);
    await verifyExtractedPackage(packageRoot, release.manifest);
    const cliEntry = join(packageRoot, "dist", "cli", "index.js");
    const preSwitchVersion = runNode(cliEntry, ["--version"], packageRoot).stdout.trim();
    if (preSwitchVersion !== release.manifest.version) throw new Error("pre-switch smoke returned the wrong version");
    const migrationPlan = JSON.parse(runNode(cliEntry, [
      "state",
      "migrate",
      "--dry-run",
      "--state",
      options.stateDir
    ], packageRoot).stdout);
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
    runNode(installer, [
      "upgrade",
      "--source",
      packageRoot,
      "--prefix",
      prefix,
      "--artifact-sha256",
      expectedChecksum
    ], packageRoot);
    switched = true;
    const installed = await readInstallState(prefix);
    if (installed.currentVersion !== release.manifest.version || installed.currentCommit !== release.manifest.commit) {
      throw new Error("installed application pointer does not match the verified release");
    }
    const installedRoot = join(prefix, "versions", String(installed.current));
    const health = JSON.parse(runNode(join(installedRoot, "dist", "cli", "index.js"), [
      "doctor",
      "--state",
      options.stateDir
    ], installedRoot).stdout);
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
      health: "passed"
    };
  } catch (error) {
    if (switched) {
      try {
        const current = await readInstallState(prefix);
        const currentRoot = join(prefix, "versions", String(current.current));
        runNode(installerEntry(currentRoot), ["rollback", "--prefix", prefix], currentRoot);
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
  runNode(installerEntry(currentRoot), ["rollback", "--prefix", prefix], currentRoot);
  const rolledBack = await readInstallState(prefix);
  try {
    const priorRoot = join(prefix, "versions", String(rolledBack.current));
    const health = JSON.parse(runNode(join(priorRoot, "dist", "cli", "index.js"), [
      "doctor",
      "--state",
      options.stateDir
    ], priorRoot).stdout);
    if (!health.ok) throw new Error("rolled-back application failed its health check");
  } catch (error) {
    const priorRoot = join(prefix, "versions", String(rolledBack.current));
    runNode(installerEntry(priorRoot), ["rollback", "--prefix", prefix], priorRoot);
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
    join(prefix, "install-state.json")
  ];
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
  const bin = join(prefix, "bin");
  try {
    const binMetadata = await lstat(bin);
    if (!binMetadata.isDirectory() || binMetadata.isSymbolicLink()) {
      throw new Error("launcher root must be a physical directory");
    }
    const allowed = new Set(["odinn", "odinn.cmd", "odinn-gateway", "odinn-gateway.cmd"]);
    for (const entry of await readdir(bin, { withFileTypes: true })) {
      if (!allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
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
      if (!entry.isDirectory() || entry.isSymbolicLink() || !safeVersionId(entry.name)) {
        throw new Error(`uninstall refused an unexpected version entry: ${entry.name}`);
      }
      await readInstalledMetadata(prefix, entry.name);
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
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
    const artifactLocations = Object.fromEntries(manifest.artifacts.map((name) => [
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
  for (const name of manifest.artifacts) {
    const asset = assets.get(name);
    if (!asset?.browser_download_url) throw new Error(`release does not contain ${name}`);
    artifactLocations[name] = String(asset.browser_download_url);
    sizes[name] = Number(asset.size) || 0;
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
  if (manifest.stateSchemas) validateStateSchemaRecord(manifest.stateSchemas);
  if (manifest.minimumApplicationVersionForTargetState && !validVersion(manifest.minimumApplicationVersionForTargetState)) {
    throw new Error("release manifest minimum application version is invalid");
  }
  return manifest as ReleaseManifest;
}

async function verifyExtractedPackage(packageRoot: string, manifest: ReleaseManifest): Promise<void> {
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
    || releaseInfo.distribution !== manifest.distribution
    || releaseInfo.runtimeSha256 !== manifest.runtimeSha256) {
    throw new Error("package release identity does not match the release manifest");
  }
  for (const required of ["dist/cli/index.js", "dist/gateway/server.js", "dist/install/install.js", "package.json", "release-info.json"]) {
    const path = join(packageRoot, required);
    if (!existsSync(path) || !(await lstat(path)).isFile()) throw new Error(`release package is missing ${required}`);
  }
}

async function extractVerifiedArchive(archive: string, destination: string, version: string): Promise<void> {
  const names = listArchive(archive);
  const expectedRoot = `odinn-v${version}`;
  if (!names.length) throw new Error("release archive is empty");
  for (const name of names) {
    const normalized = name.replaceAll("\\", "/").replace(/\/$/u, "");
    if (!safeArchivePath(normalized) || (normalized !== expectedRoot && !normalized.startsWith(`${expectedRoot}/`))) {
      throw new Error(`release archive contains an unsafe path: ${name}`);
    }
  }
  rejectArchiveLinks(archive);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  if (isZip(archive) && process.platform !== "win32") {
    runCommand("unzip", ["-q", archive, "-d", destination], process.cwd());
  } else {
    const args = isZip(archive) ? ["-xf", archive, "-C", destination] : ["-xzf", archive, "-C", destination];
    runCommand("tar", args, process.cwd());
  }
  await validatePhysicalTree(join(destination, expectedRoot));
}

function listArchive(archive: string): string[] {
  const result = isZip(archive) && process.platform !== "win32"
    ? runCommand("unzip", ["-Z1", archive], process.cwd()).stdout
    : runCommand("tar", [isZip(archive) ? "-tf" : "-tzf", archive], process.cwd()).stdout;
  return result.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function rejectArchiveLinks(archive: string): void {
  const listing = isZip(archive) && process.platform !== "win32"
    ? runCommand("zipinfo", ["-l", archive], process.cwd()).stdout
    : runCommand("tar", [isZip(archive) ? "-tvf" : "-tvzf", archive], process.cwd()).stdout;
  for (const line of listing.split(/\r?\n/u)) {
    const type = line.trimStart()[0];
    if (type === "l" || type === "h") throw new Error("release archive contains a symbolic or hard link");
  }
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

function selectArtifact(artifacts: string[]): string {
  const preferred = process.platform === "win32" ? ".zip" : ".tar.gz";
  const artifact = artifacts.find((name) => name.endsWith(preferred));
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

function runNode(entry: string, args: string[], cwd: string) {
  return runCommand(process.execPath, [entry, ...args], cwd);
}

function runCommand(command: string, args: string[], cwd: string): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, ODINN_NONINTERACTIVE: "1" }
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
  if (resolve(packageRoot) !== expected) {
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

function safeArchivePath(value: string): boolean {
  if (!value || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return false;
  return value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function isZip(path: string): boolean {
  return path.toLowerCase().endsWith(".zip");
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
