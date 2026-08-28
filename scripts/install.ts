#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, type Stats } from "node:fs";
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { cwd as currentWorkingDirectory } from "node:process";
import { spawnPnpmSync } from "./lib/package-manager.ts";
import { verifyNativeLauncher, type NativeLauncherTarget } from "./release/native-launcher.ts";
import {
  HOSTILE_NODE_ENVIRONMENT_VARIABLES,
  HOSTILE_WINDOWS_RUNTIME_ENVIRONMENT_VARIABLES,
  WINDOWS_RUNTIME_TRUST_ASSERTIONS
} from "./release/standalone-launchers.ts";

const [command = "status", ...args] = process.argv.slice(2);
const prefix = resolve(option("--prefix", process.env.ODINN_INSTALL_PREFIX || join(homedir(), ".local", "share", "odinn")));
const statePath = join(prefix, "install-state.json");
const currentPath = join(prefix, "current");
const launcherActivationPath = join(prefix, ".launcher-activation.json");
const LAUNCHER_ACTIVATION_TIMEOUT_MS = 10 * 60 * 1000;
const LAUNCHER_ACTIVATION_MAXIMUM_ATTEMPTS = 100;
const WINDOWS_LAUNCHER_GENERATION_NAME = /^(?:odinn|odinn-gateway)\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.cmd$/iu;
type LauncherActivationPhase = "prepared" | "waiting" | "applying" | "failed";
type LauncherActivationMarker = {
  schemaVersion: 3;
  token: string;
  operation: "upgrade" | "rollback";
  phase: LauncherActivationPhase;
  versionId: string;
  sourceVersionId: string | null;
  previousVersionId: string | null;
  activationAt: string;
  waitForPid: number;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  attempts: number;
  lastError?: string;
};
// Kept separate so the TypeScript template emits the POSIX parameter-length expression verbatim.
const RUNTIME_SHA256 = { length: "$" + "{#RUNTIME_SHA256}" } as const;
if (command === "finalize-launchers") await finalizeDeferredLaunchers();
else {
  await assertNoLinkedAncestors(prefix, "install prefix");
  await ensurePhysicalDirectory(prefix, "install prefix");
  const releaseInstallLock = await acquireInstallLock();
  try {
    await validatePrefix(prefix);
    if (command === "reconcile-launchers") {
      const token = option("--activation-token");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(token)) {
        throw new Error("launcher reconciliation token is invalid");
      }
      const result = await reconcileDeferredLauncherActivation({ force: true, token });
      if (result === "exhausted") throw new Error("Windows launcher activation retry limit was reached");
    } else {
      await reconcileDeferredLauncherActivation();
      await cleanupStaleInstallEntries();
      if (command === "install" || command === "upgrade") await install(command);
      else if (command === "rollback") await rollback();
      else if (command === "status") console.log(JSON.stringify(await readState(), null, 2));
      else throw new Error("usage: install.ts install|upgrade|rollback|status [--source DIR] [--prefix DIR] [--version VERSION] [--commit SHA] [--artifact-sha256 HASH] [--skip-deps]");
    }
  } finally {
    await releaseInstallLock();
  }
}

async function install(operation: any) {
  const source = resolve(option("--source", currentWorkingDirectory()));
  await validateSource(source);
  const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  if (pkg.name !== "odinn" && pkg.name !== "@bluedot-it/odinn") {
    throw new Error("install source is not an Odinn Forge package");
  }
  const releaseInfo = await readReleaseInfo(source);
  const distribution = await validateDistributionRuntime(source, releaseInfo, pkg, true);
  const standalone = distribution === "standalone";
  const compiled = distribution !== "source";
  if (compiled) await validateCompiledSourceTree(source);
  const version = option("--version", pkg.version);
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error("invalid Odinn Forge version");
  const lockfileSha256 = await digestIfPresent(join(source, "pnpm-lock.yaml"));
  const runtimeSha256 = releaseInfo.runtimeSha256
    || await digestIfPresent(join(source, "dist", "production-build-info.json"))
    || createHash("sha256").update(await readFile(join(source, "package.json"))).digest("hex");
  const commit = option("--commit", process.env.ODINN_RELEASE_COMMIT || releaseInfo.commit || pkg.odinnCommit || "unknown");
  const artifactSha256 = option("--artifact-sha256", process.env.ODINN_ARTIFACT_SHA256 || "unknown");
  if (!/^(?:[a-f0-9]{40}|unknown)$/u.test(commit)) throw new Error("invalid Odinn Forge commit identity");
  if (!/^(?:[a-f0-9]{64}|unknown)$/u.test(artifactSha256)) throw new Error("invalid Odinn Forge artifact digest");
  const toolchain = compiled
    ? { node: process.version, distribution: standalone ? "standalone" : "compiled", embeddedRuntime: standalone ? releaseInfo.embeddedRuntime : undefined }
    : { node: process.version, distribution: "source", packageManager: pkg.packageManager || "unknown" };
  const toolchainSha256 = createHash("sha256").update(JSON.stringify(toolchain)).digest("hex");
  const identity = `${runtimeSha256.slice(0, 12)}-${String(commit).slice(0, 12)}-${toolchainSha256.slice(0, 12)}`;
  const versionId = `${version}-${identity}`;
  const versions = join(prefix, "versions");
  const destination = join(versions, versionId);
  await ensurePhysicalDirectory(versions, "version root");
  const staging = await mkdtemp(join(versions, ".staging-"));
  const metadata = { schemaVersion: 2, version, commit, runtimeSha256, lockfileSha256: lockfileSha256 || undefined, artifactSha256, toolchain, installedAt: new Date().toISOString() };
  try {
    try {
      await cp(source, staging, { recursive: true, dereference: false, filter: (path: any) => !excluded(path, source, compiled) });
    } catch (error: any) {
      if (error?.code === "ENOENT") throw new Error("install source changed during guarded copy");
      throw error;
    }
    if (!compiled && !has("--skip-deps")) runPnpm(["install", "--frozen-lockfile"], staging);
    await writeFile(join(staging, "install-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    if (compiled) await validateCompiledSourceTree(staging);
    await validateDistributionRuntime(source, releaseInfo, pkg, false);
    await validateDistributionRuntime(staging, releaseInfo, pkg, false);
    const destinationExists = await access(destination).then(() => true).catch(() => false);
    if (destinationExists) {
      const destinationMetadata = await lstat(destination);
      if (!destinationMetadata.isDirectory() || destinationMetadata.isSymbolicLink()) {
        throw new Error(`immutable Odinn version path is not a physical directory: ${versionId}`);
      }
      const existing = JSON.parse(await readFile(join(destination, "install-metadata.json"), "utf8"));
      if (existing.version !== metadata.version || existing.commit !== metadata.commit || existing.runtimeSha256 !== metadata.runtimeSha256 || existing.artifactSha256 !== metadata.artifactSha256 || JSON.stringify(existing.toolchain) !== JSON.stringify(metadata.toolchain)) {
        throw new Error(`immutable Odinn version directory already exists with different release identity: ${versionId}`);
      }
      await validateDistributionRuntime(destination, releaseInfo, pkg, false);
    } else {
      await rename(staging, destination);
      await validateDistributionRuntime(destination, releaseInfo, pkg, false);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const previous = await readState();
  const previousMetadata = previous.current
    ? await readInstalledMetadata(previous.current)
    : null;
  // v1.0.0 rejects UUID-named Windows launcher companions during its own
  // startup validation. Do not create a deferred generation while that legacy
  // runtime is still the caller: publish the bounded stable launchers directly
  // and let the candidate take ownership without leaving files the old CLI
  // cannot recognize.
  const legacyWindowsUpgrade = process.platform === "win32"
    && previousMetadata?.version === "1.0.0";
  const activationAt = new Date().toISOString();
  const next = { schemaVersion: 1, current: versionId, currentVersion: version, currentCommit: commit, previous: previous.current && previous.current !== versionId ? previous.current : previous.previous ?? null, installedAt: activationAt, operation };
  const deferredParentPid = legacyWindowsUpgrade ? null : deferredLauncherParentPid(operation);
  const activation = deferredParentPid
    ? await prepareDeferredLauncherActivation({
      versionId,
      sourceVersionId: previous.current,
      previousVersionId: next.previous,
      waitForPid: deferredParentPid,
      operation: "upgrade",
      activationAt
    })
    : null;
  // On Windows, install the immutable generation launcher and its short stable
  // trampoline before publishing the activation intent. Replacing a legacy
  // active batch file with the shorter trampoline leaves its old read cursor at
  // EOF, while every later generation keeps the same direct-transfer layout.
  await writeLaunchers(destination, distribution, activation ?? undefined, legacyWindowsUpgrade);
  if (activation) await writeLauncherActivationMarker(activation, null);
  await writeCurrentPointer(versionId, toolchain.distribution, standalone ? releaseInfo.embeddedRuntime.executableSha256 : "");
  await writeState(next);
  if (activation) await startDeferredLauncherFinalizer(destination, standalone, activation);
  console.log(JSON.stringify({
    ok: true,
    prefix,
    version,
    versionId,
    commit,
    previous: next.previous,
    launcherActivation: activation ? "deferred" : "complete"
  }, null, 2));
}

function deferredLauncherParentPid(operation: string): number | null {
  const value = option("--defer-launchers-until-pid");
  if (process.platform !== "win32" || (operation !== "upgrade" && operation !== "rollback")) {
    if (!value) return null;
    throw new Error("deferred launcher activation is supported only for Windows upgrades and rollbacks");
  }
  // Older installed CLIs do not know the defer flag. The candidate installer
  // still owns launcher safety, so every Windows upgrade defaults to waiting
  // for its invoking CLI parent before replacing the active batch file.
  if (operation === "rollback" && !value) return null;
  const pid = Number(value || process.ppid);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("deferred launcher activation requires a valid parent process ID");
  if (!processIsAlive(pid)) throw new Error("deferred launcher activation parent process is not running");
  return pid;
}

async function prepareDeferredLauncherActivation({
  versionId,
  sourceVersionId,
  previousVersionId,
  waitForPid,
  operation,
  activationAt
}: {
  versionId: string;
  sourceVersionId: string | null;
  previousVersionId: string | null;
  waitForPid: number;
  operation: "upgrade" | "rollback";
  activationAt: string;
}): Promise<LauncherActivationMarker> {
  const existing = await readLauncherActivationMarker();
  if (existing) await retireLauncherActivation(existing.token);
  const token = randomUUID();
  const now = new Date();
  const marker: LauncherActivationMarker = {
    schemaVersion: 3,
    token,
    operation,
    phase: "prepared",
    versionId,
    sourceVersionId,
    previousVersionId,
    activationAt,
    waitForPid,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + LAUNCHER_ACTIVATION_TIMEOUT_MS).toISOString(),
    attempts: 0
  };
  return marker;
}

async function startDeferredLauncherFinalizer(
  destination: string,
  standalone: boolean,
  marker: LauncherActivationMarker
): Promise<void> {
  const waiting = await updateLauncherActivationMarker(marker.token, {
    phase: "waiting",
    updatedAt: new Date().toISOString(),
    lastError: undefined
  });
  const runtime = standalone ? join(destination, "runtime", "node.exe") : process.execPath;
  const installer = join(destination, "dist", "install", "install.js");
  try {
    const child = spawn(runtime, [
      installer,
      "finalize-launchers",
      "--prefix",
      prefix,
      "--wait-for-pid",
      String(waiting.waitForPid),
      "--version-id",
      waiting.versionId,
      "--activation-token",
      waiting.token
    ], {
      // The upgrade caller removes its verified extraction tree immediately
      // after the installer returns. Windows keeps a process working directory
      // open, so the detached finalizer must remain rooted in the durable
      // install prefix rather than inheriting that temporary package path.
      cwd: prefix,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        TEMP: process.env.TEMP ?? tmpdir(),
        TMP: process.env.TMP ?? tmpdir()
      }
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    child.unref();
  } catch (error) {
    await recordLauncherActivationFailure(waiting.token, error);
  }
}

async function readLauncherActivationMarker(): Promise<LauncherActivationMarker | null> {
  try {
    const metadata = await requirePhysicalFile(launcherActivationPath, "launcher activation marker");
    if (metadata.size <= 0 || metadata.size > 64 * 1024) throw new Error("launcher activation marker is oversized");
    const value = JSON.parse(await readFile(launcherActivationPath, "utf8"));
    const legacyV1 = value?.schemaVersion === 1;
    const legacyV2 = value?.schemaVersion === 2;
    const createdAt = String(value?.createdAt ?? "");
    const created = Date.parse(createdAt);
    const deadlineAt = legacyV1 && Number.isFinite(created)
      ? new Date(created + LAUNCHER_ACTIVATION_TIMEOUT_MS).toISOString()
      : legacyV1
        ? ""
      : String(value?.deadlineAt ?? "");
    const marker: LauncherActivationMarker = legacyV1 ? {
      schemaVersion: 3,
      token: value.token,
      operation: "upgrade",
      phase: "waiting",
      versionId: value.versionId,
      sourceVersionId: null,
      previousVersionId: null,
      activationAt: createdAt,
      waitForPid: value.waitForPid,
      createdAt,
      updatedAt: createdAt,
      deadlineAt,
      attempts: 0
    } : legacyV2 ? {
      ...value,
      schemaVersion: 3,
      sourceVersionId: null,
      previousVersionId: null,
      activationAt: createdAt
    } : value;
    if (marker?.schemaVersion !== 3
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(marker.token))
      || (marker.operation !== "upgrade" && marker.operation !== "rollback")
      || !(["prepared", "waiting", "applying", "failed"] as LauncherActivationPhase[]).includes(marker.phase)
      || !safeVersionId(marker.versionId)
      || (marker.sourceVersionId !== null && !safeVersionId(marker.sourceVersionId))
      || (marker.previousVersionId !== null && !safeVersionId(marker.previousVersionId))
      || !Number.isSafeInteger(marker.waitForPid) || marker.waitForPid <= 0
      || !Number.isFinite(created)
      || !Number.isFinite(Date.parse(marker.activationAt))
      || !Number.isFinite(Date.parse(marker.updatedAt))
      || !Number.isFinite(Date.parse(marker.deadlineAt))
      || !Number.isSafeInteger(marker.attempts) || marker.attempts < 0 || marker.attempts > LAUNCHER_ACTIVATION_MAXIMUM_ATTEMPTS
      || (marker.lastError !== undefined && (typeof marker.lastError !== "string" || marker.lastError.length > 256))) {
      throw new Error("launcher activation marker is invalid or unsupported");
    }
    return marker;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeLauncherActivationMarker(
  marker: LauncherActivationMarker,
  expectedToken: string | null
): Promise<void> {
  const current = await readLauncherActivationMarker();
  if (expectedToken === null ? current !== null : current?.token !== expectedToken) {
    throw new Error("launcher activation marker changed during a guarded update");
  }
  const temporary = `${launcherActivationPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, launcherActivationPath);
  await chmod(launcherActivationPath, 0o600).catch(() => undefined);
}

async function updateLauncherActivationMarker(
  token: string,
  patch: Partial<LauncherActivationMarker>
): Promise<LauncherActivationMarker> {
  const current = await readLauncherActivationMarker();
  if (!current || current.token !== token) throw new Error("launcher activation marker was superseded");
  const next: LauncherActivationMarker = { ...current, ...patch, schemaVersion: 3, token: current.token };
  await writeLauncherActivationMarker(next, token);
  return next;
}

async function retireLauncherActivation(token: string): Promise<boolean> {
  const current = await readLauncherActivationMarker();
  if (!current || current.token !== token) return false;
  const retired = `${launcherActivationPath}.retired-${token}`;
  await rename(launcherActivationPath, retired);
  await requirePhysicalFile(retired, "retired launcher activation marker");
  const retiredMarker = JSON.parse(await readFile(retired, "utf8"));
  if (retiredMarker?.token !== token) throw new Error("retired launcher activation marker changed unexpectedly");
  await rm(retired, { force: false });
  return true;
}

async function recordLauncherActivationFailure(token: string, error: unknown): Promise<void> {
  const current = await readLauncherActivationMarker();
  if (!current || current.token !== token) return;
  const message = error instanceof Error ? error.message : String(error);
  await updateLauncherActivationMarker(token, {
    phase: "failed",
    updatedAt: new Date().toISOString(),
    lastError: message.slice(0, 256)
  });
}

async function applyLauncherActivation(marker: LauncherActivationMarker): Promise<"applied" | "exhausted" | "stale"> {
  const current = await readLauncherActivationMarker();
  if (!current || current.token !== marker.token) return "stale";
  const state = await readState();
  const pointer = await readCurrentPointer();
  const admittedVersions = new Set([current.versionId, current.sourceVersionId].filter((value): value is string => value !== null));
  if (!admittedVersions.has(String(state.current)) || !pointer || !admittedVersions.has(pointer.versionId)) {
    await retireLauncherActivation(current.token);
    return "stale";
  }
  if (current.attempts >= LAUNCHER_ACTIVATION_MAXIMUM_ATTEMPTS) {
    await recordLauncherActivationFailure(current.token, new Error("Windows launcher activation retry limit was reached"));
    return "exhausted";
  }
  const applying = await updateLauncherActivationMarker(current.token, {
    phase: "applying",
    attempts: current.attempts + 1,
    updatedAt: new Date().toISOString(),
    lastError: undefined
  });
  try {
    const metadata = await readInstalledMetadata(applying.versionId);
    const distribution = metadata.toolchain?.distribution ?? "compiled";
    await writeLaunchers(
      join(prefix, "versions", applying.versionId),
      distribution,
      applying
    );
    await writeCurrentPointer(
      applying.versionId,
      distribution,
      metadata.toolchain?.embeddedRuntime?.executableSha256 ?? ""
    );
    const previousVersionId = applying.previousVersionId
      ?? (state.current === applying.versionId ? state.previous ?? null : state.current ?? null);
    await writeState({
      ...state,
      schemaVersion: 1,
      current: applying.versionId,
      currentVersion: metadata.version,
      currentCommit: metadata.commit,
      previous: previousVersionId,
      operation: applying.operation,
      ...(applying.operation === "upgrade"
        ? { installedAt: applying.activationAt }
        : { rolledBackAt: applying.activationAt })
    });
    // v1.0.0 predates UUID-named Windows generation launchers and rejects
    // those files during its startup validation. Once a candidate upgraded
    // from that release is fully applied, publish stable launchers and remove
    // the temporary generation companions before the old runtime can be
    // selected by a later rollback. Newer source releases retain the deferred
    // generation protocol and its crash-safe handoff.
    const legacySourceVersionId = applying.operation === "upgrade"
      ? applying.sourceVersionId ?? state.previous ?? null
      : null;
    if (legacySourceVersionId) {
      const sourceMetadata = await readInstalledMetadata(legacySourceVersionId);
      if (sourceMetadata.version === "1.0.0") {
        await writeLaunchers(
          join(prefix, "versions", applying.versionId),
          distribution,
          undefined,
          true
        );
      }
    }
    await retireLauncherActivation(applying.token);
    return "applied";
  } catch (error) {
    await recordLauncherActivationFailure(applying.token, error);
    throw error;
  }
}

async function reconcileDeferredLauncherActivation({
  force = false,
  token
}: {
  force?: boolean;
  token?: string;
} = {}): Promise<"applied" | "exhausted" | "stale" | "waiting"> {
  const marker = await readLauncherActivationMarker();
  if (!marker || (token !== undefined && marker.token !== token)) return "stale";
  if (process.platform !== "win32") throw new Error("a Windows launcher activation marker exists on a non-Windows installation");
  if (!force && marker.phase !== "applying" && processIsAlive(marker.waitForPid)) {
    if (Date.now() >= Date.parse(marker.deadlineAt) && marker.phase !== "failed") {
      await recordLauncherActivationFailure(marker.token, new Error("timed out waiting to finalize Windows launchers"));
    }
    return "waiting";
  }
  return applyLauncherActivation(marker);
}

async function finalizeDeferredLaunchers() {
  if (process.platform !== "win32") throw new Error("deferred launcher activation is supported only on Windows");
  const waitForPid = Number(option("--wait-for-pid"));
  const versionId = option("--version-id");
  const token = option("--activation-token");
  if (!Number.isSafeInteger(waitForPid) || waitForPid <= 0 || !safeVersionId(versionId) || !/^[0-9a-f-]{36}$/iu.test(token)) {
    throw new Error("deferred launcher activation arguments are invalid");
  }
  const initial = await readLauncherActivationMarker();
  if (!initial || initial.token !== token) return;
  if (initial.versionId !== versionId || initial.waitForPid !== waitForPid) {
    return;
  }
  const deadline = Date.parse(initial.deadlineAt);
  while (processIsAlive(waitForPid)) {
    // Ordinary startup or synchronous rollback can reconcile/retire this exact
    // marker before the original parent exits. Stop the detached waiter as
    // soon as it no longer owns the activation instead of retaining the
    // installation directory until the parent or timeout ends.
    const active = await readLauncherActivationMarker();
    if (!active || active.token !== token) return;
    if (Date.now() >= deadline) {
      await assertNoLinkedAncestors(prefix, "install prefix");
      await ensurePhysicalDirectory(prefix, "install prefix");
      const timeoutLock = await acquireInstallLock();
      try {
        await recordLauncherActivationFailure(token, new Error("timed out waiting to finalize Windows launchers"));
      } finally {
        await timeoutLock();
      }
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  // cmd.exe can execute the line after the Node child exits before releasing the
  // batch file. Keep the reviewed launcher stable through that final read.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));

  await assertNoLinkedAncestors(prefix, "install prefix");
  await ensurePhysicalDirectory(prefix, "install prefix");
  const releaseInstallLock = await acquireInstallLock();
  try {
    const marker = await readLauncherActivationMarker();
    if (!marker || marker.token !== token) return;
    if (marker.versionId !== versionId || marker.waitForPid !== waitForPid) {
      await recordLauncherActivationFailure(token, new Error("launcher activation marker does not match the requested activation"));
      return;
    }
    await validatePrefix(prefix);
    await applyLauncherActivation(marker);
  } catch (error) {
    await recordLauncherActivationFailure(token, error);
  } finally {
    await releaseInstallLock();
  }
}

async function rollback() {
  const current = await readState();
  if (!current.previous) throw new Error("no previous Odinn Forge installation is available for rollback");
  const priorMetadata = await readInstalledMetadata(current.previous);
  const activationAt = new Date().toISOString();
  const next = { ...current, current: current.previous, currentVersion: priorMetadata.version, currentCommit: priorMetadata.commit, previous: current.current, rolledBackAt: activationAt, operation: "rollback" };
  // Rollback is the recovery path: do not leave the older runtime dependent
  // on a deferred finalizer unless the operator explicitly supplied a wait
  // PID. This also prevents a legacy runtime from observing a newer marker or
  // generation launcher during the handoff.
  const deferredParentPid = has("--defer-launchers-until-pid")
    ? deferredLauncherParentPid("rollback")
    : null;
  const activation = deferredParentPid
    ? await prepareDeferredLauncherActivation({
      versionId: current.previous,
      sourceVersionId: current.current,
      previousVersionId: next.previous,
      waitForPid: deferredParentPid,
      operation: "rollback",
      activationAt
    })
    : null;
  if (!activation) {
    // A synchronous rollback can be entered by an older CLI that does not know
    // the deferred-activation flag. Retire any pending upgrade activation before
    // changing launchers so its detached finalizer cannot later overwrite the
    // rollback launchers after the health-recovery path has completed.
    const pendingActivation = await readLauncherActivationMarker();
    if (pendingActivation) await retireLauncherActivation(pendingActivation.token);
  }
  const distribution = priorMetadata.toolchain?.distribution ?? "compiled";
  await writeLaunchers(join(prefix, "versions", current.previous), distribution, activation ?? undefined, !activation);
  if (activation) await writeLauncherActivationMarker(activation, null);
  await writeCurrentPointer(next.current, distribution, priorMetadata.toolchain?.embeddedRuntime?.executableSha256 ?? "");
  await writeState(next);
  if (!activation) {
    const lingeringActivation = await readLauncherActivationMarker();
    if (lingeringActivation) await retireLauncherActivation(lingeringActivation.token);
    if (process.platform === "win32") {
      for (const entry of await readdir(join(prefix, "bin"), { withFileTypes: true })) {
        if (WINDOWS_LAUNCHER_GENERATION_NAME.test(entry.name)) {
          await rm(join(prefix, "bin", entry.name), { force: true });
        }
      }
    }
  }
  if (activation) {
    await startDeferredLauncherFinalizer(
      join(prefix, "versions", current.previous),
      priorMetadata.toolchain?.distribution === "standalone",
      activation
    );
  }
  console.log(JSON.stringify({
    ok: true,
    prefix,
    current: next.current,
    previous: next.previous,
    launcherActivation: activation ? "deferred" : "complete"
  }, null, 2));
}

async function readState() {
  let value: any;
  try {
    const metadata = await lstat(statePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error("install state must be a physical file");
    value = JSON.parse(await readFile(statePath, "utf8"));
  }
  catch (error: any) { if (error?.code === "ENOENT") return { schemaVersion: 1, current: null, previous: null }; throw error; }
  if (!value || value.schemaVersion !== 1) throw new Error("install state is invalid or unsupported");
  for (const pointer of [value.current, value.previous]) {
    if (pointer !== null && (typeof pointer !== "string" || !safeVersionId(pointer))) {
      throw new Error("install state contains an unsafe version pointer");
    }
  }
  const pointer = await readCurrentPointer();
  if (!pointer && value.current) {
    const metadata = await readInstalledMetadata(value.current);
    await writeCurrentPointer(value.current, metadata.toolchain?.distribution ?? "compiled", metadata.toolchain?.embeddedRuntime?.executableSha256 ?? "");
    return value;
  }
  if (pointer) {
    const activeMetadata = await readInstalledMetadata(pointer.versionId);
    if (pointer.distribution !== (activeMetadata.toolchain?.distribution ?? "compiled")) {
      throw new Error("current distribution pointer does not match installed release metadata");
    }
    if (pointer.runtimeSha256 !== (activeMetadata.toolchain?.embeddedRuntime?.executableSha256 ?? "")) {
      throw new Error("current runtime digest pointer does not match installed release metadata");
    }
    if (pointer.versionId !== value.current) {
      const recovered = {
        ...value,
        current: pointer.versionId,
        currentVersion: activeMetadata.version,
        currentCommit: activeMetadata.commit,
        previous: value.current && value.current !== pointer.versionId ? value.current : value.previous ?? null,
        operation: "recover-interrupted-activation",
        recoveredAt: new Date().toISOString()
      };
      await writeState(recovered);
      return recovered;
    }
  }
  return value;
}

async function writeState(value: any) {
  await ensurePhysicalDirectory(prefix, "install prefix");
  const temporary = join(prefix, `.install-state-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, statePath);
  await chmod(statePath, 0o600).catch(() => undefined);
}

async function readCurrentPointer(): Promise<{ versionId: string; distribution: "standalone" | "compiled" | "source"; runtimeSha256: string } | null> {
  try {
    const metadata = await lstat(currentPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error("current version pointer must be a physical file");
    const lines = (await readFile(currentPath, "utf8")).split(/\r?\n/u);
    const versionId = lines[0] ?? "";
    const distribution = lines[1] ?? "";
    const runtimeSha256 = lines[2] ?? "";
    if (!safeVersionId(versionId) || !isDistribution(distribution)
      || (distribution === "standalone" ? !/^[a-f0-9]{64}$/u.test(runtimeSha256) : runtimeSha256 !== "")) {
      throw new Error("current version pointer is invalid");
    }
    return { versionId, distribution, runtimeSha256 };
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeCurrentPointer(versionId: string, distribution: string, runtimeSha256 = "") {
  if (!safeVersionId(versionId)) throw new Error("unsafe current version pointer");
  if (!isDistribution(distribution)) throw new Error("unsafe current distribution pointer");
  if (distribution === "standalone" ? !/^[a-f0-9]{64}$/u.test(runtimeSha256) : runtimeSha256 !== "") {
    throw new Error("unsafe current runtime digest pointer");
  }
  const temporary = `${currentPath}.${process.pid}.${Date.now()}.tmp`;
  const lineEnding = process.platform === "win32" ? "\r\n" : "\n";
  await writeFile(temporary, `${versionId}${lineEnding}${distribution}${lineEnding}${runtimeSha256}${lineEnding}`, { mode: 0o600, flag: "wx" });
  await rename(temporary, currentPath);
  await chmod(currentPath, 0o600).catch(() => undefined);
}

async function readReleaseInfo(source: string) {
  try {
    const value = JSON.parse(await readFile(join(source, "release-info.json"), "utf8"));
    const commit = String(value?.commit ?? "");
    return {
      ...value,
      commit: commit.startsWith("$Format:") ? "" : commit,
      runtimeSha256: typeof value?.runtimeSha256 === "string" ? value.runtimeSha256 : ""
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { commit: "", runtimeSha256: "" };
    throw error;
  }
}

type Distribution = "standalone" | "compiled" | "source";

async function validateDistributionRuntime(
  root: string,
  expectedReleaseInfo: any,
  expectedPackage: any,
  requireExecutingRuntime: boolean
): Promise<Distribution> {
  await assertNoLinkedAncestors(root, "package root");
  const actualReleaseInfo = await readReleaseInfo(root);
  const actualPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const declared = actualReleaseInfo.distribution;
  const distribution: Distribution = declared === undefined || declared === ""
    ? "source"
    : declared;
  if (!isDistribution(distribution)) throw new Error("package distribution metadata is invalid or unsupported");
  if (expectedReleaseInfo.distribution !== actualReleaseInfo.distribution
    || JSON.stringify(expectedReleaseInfo.embeddedRuntime) !== JSON.stringify(actualReleaseInfo.embeddedRuntime)
    || JSON.stringify(expectedPackage.odinnStandalone) !== JSON.stringify(actualPackage.odinnStandalone)) {
    throw new Error("package distribution metadata changed while the installation was copied");
  }

  const runtimeDirectory = join(root, "runtime");
  if (distribution !== "standalone") {
    if (existsSync(runtimeDirectory) || actualReleaseInfo.embeddedRuntime !== undefined || actualPackage.odinnStandalone !== undefined) {
      throw new Error("runtime-dependent installation contains undeclared embedded runtime material");
    }
    if (distribution === "compiled" && !existsSync(join(root, "dist", "cli", "index.js"))) {
      throw new Error("compiled installation is missing its declared CLI entry point");
    }
    return distribution;
  }

  if (!existsSync(join(root, "dist", "cli", "index.js"))) {
    throw new Error("standalone installation is missing its declared CLI entry point");
  }
  const evidence = actualReleaseInfo.embeddedRuntime;
  const standalone = actualPackage.odinnStandalone;
  const expectedTarget = `${process.platform}-${process.arch}`;
  const expectedRuntimeName = process.platform === "win32" ? "node.exe" : "node";
  const expectedRuntimeBoundary = process.platform === "win32"
    ? "win32-system-launcher"
    : process.platform === "linux"
      ? "linux-static-pie"
      : "darwin-hardened-runtime";
  const runtimeExecutable = join(runtimeDirectory, expectedRuntimeName);
  const policyDirectory = join(root, "THIRD_PARTY_NOTICES");
  const policyPath = join(policyDirectory, "node-runtime-policy.json");
  if (!evidence || !standalone
    || !/^24\.\d+\.\d+$/u.test(String(evidence.version ?? ""))
    || evidence.target !== expectedTarget
    || standalone.runtime !== "node"
    || standalone.version !== evidence.version
    || standalone.target !== expectedTarget
    || standalone.executableSha256 !== evidence.executableSha256
    || standalone.runtimePolicySha256 !== evidence.runtimePolicySha256
    || standalone.runtimeBoundary !== expectedRuntimeBoundary
    || (process.platform === "win32"
      ? standalone.launcherSha256 !== undefined
      : !/^[a-f0-9]{64}$/u.test(String(standalone.launcherSha256 ?? "")))
    || !/^[a-f0-9]{64}$/u.test(String(evidence.executableSha256 ?? ""))
    || !/^[a-f0-9]{64}$/u.test(String(evidence.runtimePolicySha256 ?? ""))
    || !Number.isSafeInteger(evidence.executableBytes)
    || evidence.executableBytes <= 0) {
    throw new Error("standalone installer is not executing its declared platform runtime");
  }

  await requirePhysicalDirectory(runtimeDirectory, "embedded runtime directory");
  const runtimeEntries = await readdir(runtimeDirectory);
  if (runtimeEntries.length !== 1 || runtimeEntries[0] !== expectedRuntimeName) {
    throw new Error("standalone installer is not executing its declared platform runtime: embedded runtime directory does not match signed release metadata");
  }
  const runtimeMetadata = await requirePhysicalFile(runtimeExecutable, "embedded runtime executable");
  await requirePhysicalDirectory(policyDirectory, "runtime notice directory");
  await requirePhysicalFile(policyPath, "embedded runtime policy");
  if (runtimeMetadata.size !== evidence.executableBytes
    || await digestIfPresent(runtimeExecutable) !== evidence.executableSha256) {
    throw new Error("embedded runtime executable digest does not match signed release metadata");
  }
  if (await digestIfPresent(policyPath) !== evidence.runtimePolicySha256) {
    throw new Error("embedded runtime policy digest does not match signed release metadata");
  }
  const runtimePolicy = JSON.parse(await readFile(policyPath, "utf8"));
  const targetPolicy = runtimePolicy?.targets?.[expectedTarget];
  if (runtimePolicy?.schemaVersion !== 1
    || runtimePolicy?.version !== evidence.version
    || runtimePolicy?.origin !== "https://nodejs.org"
    || !/^[a-f0-9]{64}$/u.test(String(runtimePolicy?.signedManifest?.sha256 ?? ""))
    || !/^[a-f0-9]{64}$/u.test(String(runtimePolicy?.signedManifest?.cleartextSha256 ?? ""))
    || !/^[a-f0-9]{64}$/u.test(String(runtimePolicy?.keyring?.sha256 ?? ""))
    || !Array.isArray(runtimePolicy?.keyring?.allowedPrimaryFingerprints)
    || runtimePolicy.keyring.allowedPrimaryFingerprints.length === 0
    || !runtimePolicy.keyring.allowedPrimaryFingerprints.every((value: unknown) => /^[A-F0-9]{40}$/u.test(String(value)))
    || targetPolicy?.executableBytes !== evidence.executableBytes
    || targetPolicy?.executableSha256 !== evidence.executableSha256
    || (evidence.archiveSha256 !== undefined && targetPolicy?.sha256 !== evidence.archiveSha256)) {
    throw new Error("embedded runtime policy does not match signed release metadata");
  }
  const versionProbe = spawnSync(runtimeExecutable, ["--version"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    env: {
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {})
    }
  });
  if (versionProbe.status !== 0 || versionProbe.stdout.trim() !== `v${evidence.version}`) {
    throw new Error("embedded runtime version output does not match signed release metadata");
  }
  if (process.platform !== "win32") {
    const nativeTarget = expectedTarget as NativeLauncherTarget;
    for (const [launcher, companion] of [
      ["bin/odinn", "bin/odinn.runtime.sh"],
      ["bin/odinn-gateway", "bin/odinn-gateway.runtime.sh"],
      ["install/install.sh", "install/install.sh.runtime.sh"]
    ]) {
      const launcherPath = join(root, launcher);
      const companionPath = join(root, companion);
      await requirePhysicalFile(launcherPath, "native standalone launcher");
      await requirePhysicalFile(companionPath, "native standalone launcher companion");
      const launcherBytes = await readFile(launcherPath);
      if (createHash("sha256").update(launcherBytes).digest("hex") !== standalone.launcherSha256) {
        throw new Error("native standalone launcher digest does not match release metadata");
      }
      verifyNativeLauncher(launcherBytes, nativeTarget);
      const companionBytes = await readFile(companionPath, "utf8");
      if (!companionBytes.includes("ODINN_NATIVE_BOUNDARY")
        || !companionBytes.includes("runtime/node")
        || /exec node\b/u.test(companionBytes)) {
        throw new Error("native standalone launcher companion does not preserve the controlled runtime boundary");
      }
    }
  }
  if (requireExecutingRuntime && (await digestIfPresent(process.execPath) !== evidence.executableSha256
    || normalizePhysicalPath(await realpath(process.execPath)) !== normalizePhysicalPath(await realpath(runtimeExecutable)))) {
    throw new Error("standalone installer must execute with the bundled runtime it is installing");
  }
  return distribution;
}

async function requirePhysicalDirectory(path: string, label: string) {
  await assertNoLinkedAncestors(path, label);
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a physical directory`);
}

async function requirePhysicalFile(path: string, label: string) {
  const reviewedDarwinAliasAncestor = await assertNoLinkedAncestors(dirname(path), `${label} parent`);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be a physical, uniquely linked file`);
  }
  const physicalPath = await realpath(path);
  if (normalizePhysicalPath(physicalPath) !== normalizePhysicalPath(resolve(path))
    && (!(process.platform === "win32" || reviewedDarwinAliasAncestor)
      || !sameStableFilesystemIdentity(metadata, await lstat(physicalPath)))) {
    throw new Error(`${label} must not traverse a linked path`);
  }
  return metadata;
}

function normalizePhysicalPath(path: string) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function digestIfPresent(path: string): Promise<string> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch (error: any) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function writeLaunchers(
  targetRoot?: string,
  distribution: Distribution = "source",
  activation?: LauncherActivationMarker,
  legacyCompatibleSynchronousRollback = false
) {
  const bin = join(prefix, "bin");
  await ensurePhysicalDirectory(bin, "launcher root");
  const hostileNodeEnvironment = HOSTILE_NODE_ENVIRONMENT_VARIABLES.join(" ");
  const standalone = distribution === "standalone";
  const nativeTarget = `${process.platform}-${process.arch}` as NativeLauncherTarget;
  const nativeLaunchers = new Map<string, Buffer>();
  if (process.platform !== "win32") {
    for (const name of ["odinn", "odinn-gateway"]) {
      const source = standalone && targetRoot ? join(targetRoot, "bin", name) : join(bin, name);
      try {
        await requirePhysicalFile(source, standalone ? "versioned native standalone launcher" : "installed native standalone launcher");
        const bytes = await readFile(source);
        verifyNativeLauncher(bytes, nativeTarget);
        nativeLaunchers.set(name, bytes);
      } catch (error) {
        if (standalone) throw error;
      }
    }
    if (nativeLaunchers.size !== 0 && nativeLaunchers.size !== 2) {
      throw new Error("installed native launcher pair is incomplete");
    }
    if (standalone && nativeLaunchers.size !== 2) {
      throw new Error("native standalone launcher activation requires an immutable version root");
    }
  }
  const useNativeBoundary = nativeLaunchers.size === 2;
  const unix = installedUnixLauncher("dist/cli/index.js", "apps/cli/src/cli.ts", hostileNodeEnvironment, useNativeBoundary);
  const gateway = installedUnixLauncher("dist/gateway/server.js", "apps/gateway/src/server.ts", hostileNodeEnvironment, useNativeBoundary);
  if (process.platform !== "win32" && useNativeBoundary) {
    for (const [name, companion] of [["odinn", unix], ["odinn-gateway", gateway]] as const) {
      const bytes = nativeLaunchers.get(name)!;
      await atomicLauncher(join(bin, `${name}.runtime.sh`), companion, 0o600);
      await atomicLauncher(join(bin, name), bytes, 0o755);
    }
  } else if (process.platform !== "win32") {
    await atomicLauncher(join(bin, "odinn"), unix, 0o755);
    await atomicLauncher(join(bin, "odinn-gateway"), gateway, 0o755);
  }
  const generation = activation?.token ?? randomUUID();
  const windowsActivation = activation && targetRoot ? {
    token: activation.token,
    targetRoot,
    distribution,
    runtimeSha256: standalone ? String((await readReleaseInfo(targetRoot)).embeddedRuntime?.executableSha256 ?? "") : ""
  } : undefined;
  const cmd = installedWindowsLauncher("dist\\cli\\index.js", "apps\\cli\\src\\cli.ts", windowsActivation);
  const gatewayCmd = installedWindowsLauncher("dist\\gateway\\server.js", "apps\\gateway\\src\\server.ts", windowsActivation);
  if (legacyCompatibleSynchronousRollback && process.platform === "win32") {
    // An older installation becomes the active runtime immediately after a
    // synchronous rollback. Its validatePrefix cannot know about the newer
    // UUID-named generation companions, so leave the stable launchers in the
    // legacy shape before publishing the old pointer. Deferred activation
    // retains generation launchers until the new runtime has taken ownership.
    await atomicLauncher(join(bin, "odinn.cmd"), cmd, 0o600);
    await atomicLauncher(join(bin, "odinn-gateway.cmd"), gatewayCmd, 0o600);
    for (const entry of await readdir(bin, { withFileTypes: true })) {
      if (WINDOWS_LAUNCHER_GENERATION_NAME.test(entry.name)) {
        await rm(join(bin, entry.name), { force: true });
      }
    }
    return;
  }
  const cliGenerationName = `odinn.${generation}.cmd`;
  const gatewayGenerationName = `odinn-gateway.${generation}.cmd`;
  await atomicLauncher(join(bin, cliGenerationName), cmd, 0o600);
  await atomicLauncher(join(bin, gatewayGenerationName), gatewayCmd, 0o600);
  const cliTrampoline = installedWindowsTrampoline(cliGenerationName);
  const gatewayTrampoline = installedWindowsTrampoline(gatewayGenerationName);
  const repairingInterruptedActivation = activation?.phase === "applying";
  await assertSafeWindowsTrampolineReplacement(join(bin, "odinn.cmd"), cliTrampoline, repairingInterruptedActivation);
  await assertSafeWindowsTrampolineReplacement(join(bin, "odinn-gateway.cmd"), gatewayTrampoline, repairingInterruptedActivation);
  await atomicLauncher(join(bin, "odinn.cmd"), cliTrampoline, 0o600);
  await atomicLauncher(join(bin, "odinn-gateway.cmd"), gatewayTrampoline, 0o600);
}

function installedUnixLauncher(compiledEntry: string, sourceEntry: string, hostileNodeEnvironment: string, nativeBoundary: boolean): string {
  const digestCommand = process.platform === "darwin"
    ? 'ACTUAL=$(/usr/bin/shasum -a 256 "$NODE"); ACTUAL=${ACTUAL%% *}'
    : 'ACTUAL=$(/usr/bin/sha256sum "$NODE"); ACTUAL=${ACTUAL%% *}';
  const boundary = nativeBoundary
    ? `[ "\${ODINN_NATIVE_BOUNDARY-}" = "1" ] || { echo "Ódinn native runtime boundary was bypassed" >&2; exit 126; }\nunset ODINN_NATIVE_BOUNDARY\n`
    : "#!/bin/sh\n";
  return `${boundary}set -eu\nPREFIX=${shellQuote(prefix)}\nunset ${hostileNodeEnvironment}\n{ IFS= read -r CURRENT; IFS= read -r DISTRIBUTION; IFS= read -r RUNTIME_SHA256; } < "$PREFIX/current"\ncase "$CURRENT" in ''|*[!A-Za-z0-9._-]*) echo "Ódinn current pointer is invalid" >&2; exit 126;; esac\ncase "$DISTRIBUTION" in\n  standalone)\n    case "$RUNTIME_SHA256" in *[!a-f0-9]*|'') echo "Ódinn embedded runtime digest is invalid" >&2; exit 126;; esac\n    [ "${RUNTIME_SHA256.length}" -eq 64 ] || { echo "Ódinn embedded runtime digest is invalid" >&2; exit 126; }\n    ROOT="$PREFIX/versions/$CURRENT"; NODE="$ROOT/runtime/node"\n    for PHYSICAL in "$PREFIX" "$PREFIX/versions" "$ROOT" "$ROOT/runtime" "$NODE"; do [ ! -L "$PHYSICAL" ] || { echo "Ódinn embedded runtime path is linked" >&2; exit 126; }; done\n    [ -f "$NODE" ] && [ -x "$NODE" ] || { echo "Ódinn embedded runtime is missing or not executable" >&2; exit 126; }\n    PHYSICAL_ROOT=$(CDPATH= cd -- "$ROOT/runtime" && pwd -P)\n    [ "$PHYSICAL_ROOT" = "$ROOT/runtime" ] || { echo "Ódinn embedded runtime path is not physical" >&2; exit 126; }\n    ${digestCommand}\n    [ "$ACTUAL" = "$RUNTIME_SHA256" ] || { echo "Ódinn embedded runtime digest mismatch" >&2; exit 126; }\n    exec "$NODE" "$ROOT/${compiledEntry}" "$@";;\n  compiled) exec node "$PREFIX/versions/$CURRENT/${compiledEntry}" "$@";;\n  source) exec node "$PREFIX/versions/$CURRENT/${sourceEntry}" "$@";;\n  *) echo "Ódinn current distribution is invalid" >&2; exit 126;;\nesac\n`;
}

function installedWindowsLauncher(
  compiledEntry: string,
  sourceEntry: string,
  activation?: {
    token: string;
    targetRoot: string;
    distribution: Distribution;
    runtimeSha256: string;
  }
): string {
  // Use the unquoted assignment form here. The installed launcher is also
  // invoked by v1.0.0's cmd.exe update path; quoted assignments can be split by
  // that legacy command parser when a CLR variable is absent, turning the
  // suffix into a command (for example, `AltJit`).
  const clears = HOSTILE_WINDOWS_RUNTIME_ENVIRONMENT_VARIABLES
    .map((name) => `set ${name}=`).join("\r\n");
  const powershell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
  const activationPrelude = activation ? installedWindowsActivationPrelude(activation) : "";
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${clears}\r\nset "ODINN_POWERSHELL=${powershell}"\r\nif not exist "%ODINN_POWERSHELL%" (echo Trusted PowerShell is unavailable 1>&2 & exit /b 126)\r\n${activationPrelude}set "ODINN_CURRENT="\r\nset "ODINN_DISTRIBUTION="\r\nset "ODINN_RUNTIME_SHA256="\r\nset /p ODINN_CURRENT=<"${currentPath}"\r\nfor /f "usebackq skip=1 delims=" %%i in ("${currentPath}") do if not defined ODINN_DISTRIBUTION set "ODINN_DISTRIBUTION=%%i"\r\nfor /f "usebackq skip=2 delims=" %%i in ("${currentPath}") do if not defined ODINN_RUNTIME_SHA256 set "ODINN_RUNTIME_SHA256=%%i"\r\nset "ODINN_CURRENT_PATH=${currentPath}"\r\nset "ODINN_PREFIX=${prefix}"\r\nset "ODINN_VERSIONS=${prefix}\\versions"\r\nset "ODINN_ROOT=${prefix}\\versions\\%ODINN_CURRENT%"\r\nset "ODINN_RUNTIME_DIR=%ODINN_ROOT%\\runtime"\r\nset "ODINN_NODE=%ODINN_RUNTIME_DIR%\\node.exe"\r\n"%ODINN_POWERSHELL%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${WINDOWS_RUNTIME_TRUST_ASSERTIONS};if($env:ODINN_CURRENT -cnotmatch '^[A-Za-z0-9._-]+$'){exit 126};if(@('standalone','compiled','source') -cnotcontains $env:ODINN_DISTRIBUTION){exit 126};Assert-OdinnPhysicalPath $env:ODINN_CURRENT_PATH;Assert-OdinnPhysicalPath $env:ODINN_PREFIX;Assert-OdinnPhysicalPath $env:ODINN_VERSIONS;Assert-OdinnPhysicalPath $env:ODINN_ROOT;if($env:ODINN_DISTRIBUTION -ceq 'standalone'){if($env:ODINN_RUNTIME_SHA256 -cnotmatch '^[a-f0-9]{64}$'){exit 126};Assert-OdinnPhysicalPath $env:ODINN_RUNTIME_DIR;Assert-OdinnPhysicalPath $env:ODINN_NODE;$attributes=[System.IO.File]::GetAttributes($env:ODINN_NODE);if(($attributes -band [System.IO.FileAttributes]::Directory) -ne 0){exit 126};if((Get-OdinnSha256 $env:ODINN_NODE) -cne $env:ODINN_RUNTIME_SHA256){exit 126}}elseif($env:ODINN_RUNTIME_SHA256){exit 126}"\r\nif errorlevel 1 (echo Odinn installation pointer or runtime identity check failed 1>&2 & exit /b 126)\r\nif "%ODINN_DISTRIBUTION%"=="standalone" goto standalone\r\nif "%ODINN_DISTRIBUTION%"=="compiled" goto compiled\r\nif "%ODINN_DISTRIBUTION%"=="source" goto source\r\necho Odinn current distribution is invalid 1>&2\r\nexit /b 126\r\n:standalone\r\n"%ODINN_NODE%" "%ODINN_ROOT%\\${compiledEntry}" %*\r\nexit /b %ERRORLEVEL%\r\n:compiled\r\nnode "%ODINN_ROOT%\\${compiledEntry}" %*\r\nexit /b %ERRORLEVEL%\r\n:source\r\nnode "%ODINN_ROOT%\\${sourceEntry}" %*\r\nexit /b %ERRORLEVEL%\r\n`;
}

function installedWindowsActivationPrelude(
  activation: {
    token: string;
    targetRoot: string;
    distribution: Distribution;
    runtimeSha256: string;
  }
): string {
  const marker = launcherActivationPath;
  const installer = activation.distribution === "source"
    ? join(activation.targetRoot, "scripts", "install.ts")
    : join(activation.targetRoot, "dist", "install", "install.js");
  const common = `reconcile-launchers --prefix "${prefix}" --activation-token "${activation.token}"`;
  if (activation.distribution !== "standalone") {
    return `if exist "${marker}" (\r\n  node "${installer}" ${common} >nul\r\n  if errorlevel 1 (echo Odinn launcher activation reconciliation failed 1>&2 & exit /b 126)\r\n)\r\n`;
  }
  const runtimeDirectory = join(activation.targetRoot, "runtime");
  const runtime = join(runtimeDirectory, "node.exe");
  return `if exist "${marker}" (\r\n  set "ODINN_ACTIVATION_ROOT=${activation.targetRoot}"\r\n  set "ODINN_ACTIVATION_RUNTIME_DIR=${runtimeDirectory}"\r\n  set "ODINN_ACTIVATION_NODE=${runtime}"\r\n  set "ODINN_ACTIVATION_RUNTIME_SHA256=${activation.runtimeSha256}"\r\n  "%ODINN_POWERSHELL%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${WINDOWS_RUNTIME_TRUST_ASSERTIONS};if($env:ODINN_ACTIVATION_RUNTIME_SHA256 -cnotmatch '^[a-f0-9]{64}$'){exit 126};Assert-OdinnPhysicalPath $env:ODINN_ACTIVATION_ROOT;Assert-OdinnPhysicalPath $env:ODINN_ACTIVATION_RUNTIME_DIR;Assert-OdinnPhysicalPath $env:ODINN_ACTIVATION_NODE;$attributes=[System.IO.File]::GetAttributes($env:ODINN_ACTIVATION_NODE);if(($attributes -band [System.IO.FileAttributes]::Directory) -ne 0){exit 126};if((Get-OdinnSha256 $env:ODINN_ACTIVATION_NODE) -cne $env:ODINN_ACTIVATION_RUNTIME_SHA256){exit 126}"\r\n  if errorlevel 1 (echo Odinn activation runtime identity check failed 1>&2 & exit /b 126)\r\n  "${runtime}" "${installer}" ${common} >nul\r\n  if errorlevel 1 (echo Odinn launcher activation reconciliation failed 1>&2 & exit /b 126)\r\n)\r\n`;
}

function installedWindowsTrampoline(generationName: string): string {
  if (!WINDOWS_LAUNCHER_GENERATION_NAME.test(generationName)) {
    throw new Error("Windows launcher generation name is invalid");
  }
  // Batch-to-batch transfer preserves the generation's exit status without
  // CALL. CALL reparses %* and can turn a caller-controlled argument into a
  // second environment expansion (and then batch metacharacter execution).
  return `@echo off\r\n"%~dp0${generationName}" %*\r\n`;
}

async function assertSafeWindowsTrampolineReplacement(
  path: string,
  trampoline: string,
  repairingInterruptedActivation = false
): Promise<void> {
  try {
    const metadata = await requirePhysicalFile(path, "installed Windows launcher trampoline");
    const existing = await readFile(path, "utf8");
    const currentTrampoline = /^@echo off\r?\n"%~dp0(?:odinn|odinn-gateway)\.[0-9a-f-]{36}\.cmd" %\*\r?\n$/iu.test(existing);
    const legacyCallTrampoline = /^@echo off\r?\ncall "%~dp0(?:odinn|odinn-gateway)\.[0-9a-f-]{36}\.cmd" %\*\r?\nexit \/b %ERRORLEVEL%\r?\n$/iu.test(existing);
    const versionedTrampoline = currentTrampoline || legacyCallTrampoline;
    // The authenticated applying marker proves the prior owner has exited and
    // permits repair of a physically truncated trampoline after power loss.
    // Initial activation still refuses a replacement that could strand an
    // active legacy cmd.exe read cursor.
    if (!versionedTrampoline && !repairingInterruptedActivation && Buffer.byteLength(trampoline, "utf8") >= metadata.size) {
      throw new Error("active legacy Windows launcher cannot transition to a bounded trampoline safely");
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function atomicLauncher(path: string, content: string | Buffer, mode: number) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error(`launcher must be a physical file: ${basename(path)}`);
    }
    // A deferred Windows finalizer may revisit the exact generation still
    // executing an ordinary startup. Preserve the physical file when its
    // reviewed bytes already match; replacing it is unnecessary and can fail
    // or invalidate cmd.exe's active read cursor.
    if ((await readFile(path)).equals(bytes)) {
      await chmod(path, mode).catch(() => undefined);
      return;
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, bytes, { mode, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, mode).catch(() => undefined);
}

async function validatePrefix(path: string) {
  if (path === parse(path).root || path === homedir() || dirname(path) === path) {
    throw new Error("install prefix is too broad or ambiguous");
  }
  await assertNoLinkedAncestors(path, "install prefix");
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("install prefix must be a physical directory");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const bin = join(path, "bin");
  try {
    const metadata = await lstat(bin);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("launcher root must be a physical directory");
    const allowed = new Set(["odinn", "odinn.runtime.sh", "odinn.cmd", "odinn-gateway", "odinn-gateway.runtime.sh", "odinn-gateway.cmd"]);
    for (const entry of await readdir(bin, { withFileTypes: true })) {
      const temporary = /^(?:odinn|odinn-gateway)(?:\.runtime\.sh|\.cmd)?\.[A-Za-z0-9_.-]+\.tmp$/u.test(entry.name);
      const generation = WINDOWS_LAUNCHER_GENERATION_NAME.test(entry.name);
      const entryMetadata = await lstat(join(bin, entry.name));
      if ((!allowed.has(entry.name) && !temporary && !generation)
        || !entry.isFile() || entry.isSymbolicLink()
        || !entryMetadata.isFile() || entryMetadata.isSymbolicLink() || entryMetadata.nlink !== 1) {
        throw new Error(`install prefix contains an unrelated launcher entry: ${entry.name}`);
      }
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function validateSource(path: string) {
  await assertNoLinkedAncestors(path, "install source");
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("install source must be a physical directory");
  if (path === prefix || path.startsWith(`${prefix}${sep}`) || prefix.startsWith(`${path}${sep}`)) {
    throw new Error("install source and prefix must not contain one another");
  }
}

async function validateCompiledSourceTree(root: string) {
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error(`compiled install source contains a symbolic link: ${path.slice(root.length + 1)}`);
      if (metadata.isDirectory()) await walk(path);
      else if (!metadata.isFile() || metadata.nlink !== 1) throw new Error(`compiled install source contains an unsupported or hard-linked entry: ${path.slice(root.length + 1)}`);
    }
  };
  await walk(root);
}

async function cleanupStaleInstallEntries() {
  const candidates: string[] = [];
  try {
    for (const entry of await readdir(prefix, { withFileTypes: true })) {
      if (/^(?:\.install-state-|current\.|\.launcher-activation\.).+\.tmp$/u.test(entry.name)
        || /^\.launcher-activation\.json\.retired-[0-9a-f-]{36}$/iu.test(entry.name)) {
        candidates.push(join(prefix, entry.name));
      }
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const versions = join(prefix, "versions");
  try {
    for (const entry of await readdir(versions, { withFileTypes: true })) {
      if (/^\.staging-[A-Za-z0-9_-]+$/u.test(entry.name)) candidates.push(join(versions, entry.name));
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const bin = join(prefix, "bin");
  try {
    for (const entry of await readdir(bin, { withFileTypes: true })) {
      if (/^(?:odinn|odinn-gateway)(?:\.runtime\.sh|\.cmd)?\.[A-Za-z0-9_.-]+\.tmp$/u.test(entry.name)) candidates.push(join(bin, entry.name));
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const path of candidates) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`stale installer entry must not be a symbolic link: ${basename(path)}`);
    if (!metadata.isFile() && !metadata.isDirectory()) throw new Error(`stale installer entry has an unsupported type: ${basename(path)}`);
    await rm(path, { recursive: metadata.isDirectory(), force: true });
  }
}

async function ensurePhysicalDirectory(path: string, label: string) {
  await assertNoLinkedAncestors(path, label);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertNoLinkedAncestors(path, label);
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a physical directory`);
}

async function assertNoLinkedAncestors(path: string, label: string) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  let reviewedDarwinAliasAncestor = false;
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error: any) {
      if (error?.code === "ENOENT") return reviewedDarwinAliasAncestor;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      const physicalPath = await realpath(current);
      const physical = await lstat(physicalPath);
      if (!reviewedDarwinRootAlias(metadata, physical)) {
        throw new Error(`${label} must not traverse a symbolic link or reparse point`);
      }
      reviewedDarwinAliasAncestor = true;
      continue;
    }
    if (!metadata.isDirectory() && current !== absolute) throw new Error(`${label} has a non-directory ancestor`);
    const physicalPath = await realpath(current);
    if (normalizePhysicalPath(physicalPath) !== normalizePhysicalPath(current)
      && (!(process.platform === "win32" || reviewedDarwinAliasAncestor)
        || !sameStableFilesystemIdentity(metadata, await lstat(physicalPath)))) {
      throw new Error(`${label} must not traverse a linked ancestor`);
    }
  }
  return reviewedDarwinAliasAncestor;
}

function reviewedDarwinRootAlias(link: Stats, physical: Stats) {
  return process.platform === "darwin"
    && link.uid === 0
    && physical.isDirectory()
    && !physical.isSymbolicLink()
    && physical.uid === 0
    && (physical.mode & 0o022) === 0;
}

function sameStableFilesystemIdentity(
  lexical: Stats,
  physical: Stats
) {
  return lexical.dev !== 0
    && lexical.ino !== 0
    && lexical.dev === physical.dev
    && lexical.ino === physical.ino
    && lexical.isDirectory() === physical.isDirectory()
    && lexical.isFile() === physical.isFile();
}

async function acquireInstallLock(): Promise<() => Promise<void>> {
  const lockPath = join(prefix, ".install.lock");
  const ownerPath = join(lockPath, "owner.json");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let createdLock = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      createdLock = true;
      await writeFile(ownerPath, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token, startedAt: new Date().toISOString() })}\n`, {
        mode: 0o600,
        flag: "wx"
      });
      return async () => {
        let owner: any;
        try {
          await requirePhysicalDirectory(lockPath, "installer lock");
          await requirePhysicalFile(ownerPath, "installer lock owner");
          owner = JSON.parse(await readFile(ownerPath, "utf8"));
        } catch (error: any) {
          if (error?.code === "ENOENT") return;
          throw error;
        }
        if (owner?.token !== token || owner?.pid !== process.pid) {
          throw new Error("installer lock ownership changed before release");
        }
        const retiredPath = `${lockPath}.retired-${token}`;
        await rename(lockPath, retiredPath);
        const retiredOwnerPath = join(retiredPath, "owner.json");
        await requirePhysicalDirectory(retiredPath, "retired installer lock");
        await requirePhysicalFile(retiredOwnerPath, "retired installer lock owner");
        const retiredOwner = JSON.parse(await readFile(retiredOwnerPath, "utf8"));
        if (retiredOwner?.token !== token || retiredOwner?.pid !== process.pid) {
          throw new Error("installer lock ownership changed during release");
        }
        await rm(retiredPath, { recursive: true, force: false });
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST" || createdLock) {
        if (createdLock) {
          const failedPath = `${lockPath}.failed-${token}`;
          await rename(lockPath, failedPath).then(
            () => rm(failedPath, { recursive: true, force: false }),
            () => undefined
          );
        }
        throw error;
      }
      await requirePhysicalDirectory(lockPath, "installer lock");
      const entries = await readdir(lockPath, { withFileTypes: true });
      if (entries.some((entry) => entry.name !== "owner.json" || !entry.isFile() || entry.isSymbolicLink())) {
        throw new Error("installer lock contains unsupported entries");
      }
      let owner: any = null;
      let ownerAge = 0;
      try {
        const ownerMetadata = await requirePhysicalFile(ownerPath, "installer lock owner");
        ownerAge = Date.now() - ownerMetadata.mtimeMs;
        owner = JSON.parse(await readFile(ownerPath, "utf8"));
      } catch (ownerError: any) {
        if (ownerError?.code !== "ENOENT") throw new Error("installer lock owner is invalid", { cause: ownerError });
        ownerAge = Date.now() - (await lstat(lockPath)).mtimeMs;
      }
      if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && processIsAlive(owner.pid)) {
        throw new Error(`another installer command is active for this prefix (pid ${owner.pid})`);
      }
      if ((!owner || typeof owner.token !== "string") && ownerAge < 10 * 60 * 1000) {
        throw new Error("another installer command may be active for this prefix");
      }
      const stalePath = `${lockPath}.stale-${token}`;
      try {
        await rename(lockPath, stalePath);
      } catch (renameError: any) {
        if (renameError?.code === "ENOENT") continue;
        throw renameError;
      }
      await requirePhysicalDirectory(stalePath, "retired stale installer lock");
      const staleEntries = await readdir(stalePath, { withFileTypes: true });
      if (staleEntries.some((entry) => entry.name !== "owner.json" || !entry.isFile() || entry.isSymbolicLink())) {
        throw new Error("retired stale installer lock contains unsupported entries");
      }
      await rm(stalePath, { recursive: true, force: false });
    }
  }
  throw new Error("could not acquire the installer lock safely");
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

async function readInstalledMetadata(versionId: string) {
  if (!safeVersionId(versionId)) throw new Error("install state contains an unsafe version pointer");
  const root = join(prefix, "versions", versionId);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("installed version must be a physical directory");
  const path = join(root, "install-metadata.json");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error("installed metadata must be a physical file");
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value.version !== "string" || typeof value.commit !== "string") throw new Error("installed metadata is invalid");
  const releaseInfo = await readReleaseInfo(root);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const distribution = await validateDistributionRuntime(root, releaseInfo, pkg, false);
  if (value.toolchain?.distribution !== distribution
    || (distribution === "standalone" && JSON.stringify(value.toolchain?.embeddedRuntime) !== JSON.stringify(releaseInfo.embeddedRuntime))) {
    throw new Error("installed runtime identity does not match immutable installation metadata");
  }
  return value;
}

function safeVersionId(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function isDistribution(value: unknown): value is "standalone" | "compiled" | "source" {
  return value === "standalone" || value === "compiled" || value === "source";
}

function excluded(path: any, source: any, compiled: boolean) {
  const relative = path.slice(source.length).replaceAll("\\", "/");
  if (/(^|\/)(\.cache|\.git|\.odinn)(\/|$)/.test(relative)) return true;
  if (!compiled && /(^|\/)(node_modules|dist)(\/|$)/.test(relative)) return true;
  return false;
}
function runPnpm(commandArgs: string[], cwd: string) {
  const result = spawnPnpmSync(commandArgs, { cwd, encoding: "utf8", env: process.env });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw new Error(`pnpm failed: ${result.error?.message ?? `exit ${result.status ?? "unknown"}`}`);
}
function option(name: any, fallback: any = "") { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; }
function has(name: any) { return args.includes(name); }
function shellQuote(value: any) { return `'${String(value).replaceAll("'", `'\\''`)}'`; }
