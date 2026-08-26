#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { cwd as currentWorkingDirectory } from "node:process";
import { spawnPnpmSync } from "./lib/package-manager.ts";

const [command = "status", ...args] = process.argv.slice(2);
const prefix = resolve(option("--prefix", process.env.ODINN_INSTALL_PREFIX || join(homedir(), ".local", "share", "odinn")));
const statePath = join(prefix, "install-state.json");
const currentPath = join(prefix, "current");
// Kept separate so the TypeScript template emits the POSIX parameter-length expression verbatim.
const RUNTIME_SHA256 = { length: "$" + "{#RUNTIME_SHA256}" } as const;
await assertNoLinkedAncestors(prefix, "install prefix");
await ensurePhysicalDirectory(prefix, "install prefix");
const releaseInstallLock = await acquireInstallLock();
try {
  await validatePrefix(prefix);
  await cleanupStaleInstallEntries();
  if (command === "install" || command === "upgrade") await install(command);
  else if (command === "rollback") await rollback();
  else if (command === "status") console.log(JSON.stringify(await readState(), null, 2));
  else throw new Error("usage: install.ts install|upgrade|rollback|status [--source DIR] [--prefix DIR] [--version VERSION] [--commit SHA] [--artifact-sha256 HASH] [--skip-deps]");
} finally {
  await releaseInstallLock();
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
    await cp(source, staging, { recursive: true, dereference: false, filter: (path: any) => !excluded(path, source, compiled) });
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
  const next = { schemaVersion: 1, current: versionId, currentVersion: version, currentCommit: commit, previous: previous.current && previous.current !== versionId ? previous.current : previous.previous ?? null, installedAt: new Date().toISOString(), operation };
  await writeLaunchers();
  await writeState(next);
  await writeCurrentPointer(versionId, toolchain.distribution, standalone ? releaseInfo.embeddedRuntime.executableSha256 : "");
  console.log(JSON.stringify({ ok: true, prefix, version, versionId, commit, previous: next.previous }, null, 2));
}

async function rollback() {
  const current = await readState();
  if (!current.previous) throw new Error("no previous Odinn Forge installation is available for rollback");
  const priorMetadata = await readInstalledMetadata(current.previous);
  const next = { ...current, current: current.previous, currentVersion: priorMetadata.version, currentCommit: priorMetadata.commit, previous: current.current, rolledBackAt: new Date().toISOString(), operation: "rollback" };
  await writeLaunchers();
  await writeState(next);
  await writeCurrentPointer(next.current, priorMetadata.toolchain?.distribution ?? "compiled", priorMetadata.toolchain?.embeddedRuntime?.executableSha256 ?? "");
  console.log(JSON.stringify({ ok: true, prefix, current: next.current, previous: next.previous }, null, 2));
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
  const runtimeExecutable = join(runtimeDirectory, expectedRuntimeName);
  const policyDirectory = join(root, "THIRD_PARTY_NOTICES");
  const policyPath = join(policyDirectory, "node-runtime-policy.json");
  if (!evidence || !standalone
    || evidence.version !== process.version.slice(1)
    || evidence.target !== expectedTarget
    || standalone.runtime !== "node"
    || standalone.version !== evidence.version
    || standalone.target !== expectedTarget
    || standalone.executableSha256 !== evidence.executableSha256
    || standalone.runtimePolicySha256 !== evidence.runtimePolicySha256
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

async function writeLaunchers() {
  const bin = join(prefix, "bin");
  await ensurePhysicalDirectory(bin, "launcher root");
  const hostileNodeEnvironment = "NODE_CHANNEL_FD NODE_COMPILE_CACHE NODE_COMPILE_CACHE_PORTABLE NODE_EXTRA_CA_CERTS NODE_OPTIONS NODE_PATH NODE_REDIRECT_WARNINGS NODE_REPL_EXTERNAL_MODULE NODE_TLS_REJECT_UNAUTHORIZED NODE_UNIQUE_ID NODE_V8_COVERAGE OPENSSL_CONF SSL_CERT_DIR SSL_CERT_FILE";
  const unix = installedUnixLauncher("dist/cli/index.js", "apps/cli/src/cli.ts", hostileNodeEnvironment);
  const gateway = installedUnixLauncher("dist/gateway/server.js", "apps/gateway/src/server.ts", hostileNodeEnvironment);
  await atomicLauncher(join(bin, "odinn"), unix, 0o755);
  await atomicLauncher(join(bin, "odinn-gateway"), gateway, 0o755);
  const cmd = installedWindowsLauncher("dist\\cli\\index.js", "apps\\cli\\src\\cli.ts");
  const gatewayCmd = installedWindowsLauncher("dist\\gateway\\server.js", "apps\\gateway\\src\\server.ts");
  await atomicLauncher(join(bin, "odinn.cmd"), cmd, 0o600);
  await atomicLauncher(join(bin, "odinn-gateway.cmd"), gatewayCmd, 0o600);
}

function installedUnixLauncher(compiledEntry: string, sourceEntry: string, hostileNodeEnvironment: string): string {
  const digestCommand = process.platform === "darwin"
    ? 'ACTUAL=$(/usr/bin/shasum -a 256 "$NODE"); ACTUAL=${ACTUAL%% *}'
    : 'ACTUAL=$(/usr/bin/sha256sum "$NODE"); ACTUAL=${ACTUAL%% *}';
  return `#!/bin/sh\nset -eu\nPREFIX=${shellQuote(prefix)}\nunset ${hostileNodeEnvironment}\n{ IFS= read -r CURRENT; IFS= read -r DISTRIBUTION; IFS= read -r RUNTIME_SHA256; } < "$PREFIX/current"\ncase "$CURRENT" in ''|*[!A-Za-z0-9._-]*) echo "Ódinn current pointer is invalid" >&2; exit 126;; esac\ncase "$DISTRIBUTION" in\n  standalone)\n    case "$RUNTIME_SHA256" in *[!a-f0-9]*|'') echo "Ódinn embedded runtime digest is invalid" >&2; exit 126;; esac\n    [ "${RUNTIME_SHA256.length}" -eq 64 ] || { echo "Ódinn embedded runtime digest is invalid" >&2; exit 126; }\n    ROOT="$PREFIX/versions/$CURRENT"; NODE="$ROOT/runtime/node"\n    for PHYSICAL in "$PREFIX" "$PREFIX/versions" "$ROOT" "$ROOT/runtime" "$NODE"; do [ ! -L "$PHYSICAL" ] || { echo "Ódinn embedded runtime path is linked" >&2; exit 126; }; done\n    [ -f "$NODE" ] && [ -x "$NODE" ] || { echo "Ódinn embedded runtime is missing or not executable" >&2; exit 126; }\n    PHYSICAL_ROOT=$(CDPATH= cd -- "$ROOT/runtime" && pwd -P)\n    [ "$PHYSICAL_ROOT" = "$ROOT/runtime" ] || { echo "Ódinn embedded runtime path is not physical" >&2; exit 126; }\n    ${digestCommand}\n    [ "$ACTUAL" = "$RUNTIME_SHA256" ] || { echo "Ódinn embedded runtime digest mismatch" >&2; exit 126; }\n    exec "$NODE" "$ROOT/${compiledEntry}" "$@";;\n  compiled) exec node "$PREFIX/versions/$CURRENT/${compiledEntry}" "$@";;\n  source) exec node "$PREFIX/versions/$CURRENT/${sourceEntry}" "$@";;\n  *) echo "Ódinn current distribution is invalid" >&2; exit 126;;\nesac\n`;
}

function installedWindowsLauncher(compiledEntry: string, sourceEntry: string): string {
  const clears = ["NODE_CHANNEL_FD", "NODE_COMPILE_CACHE", "NODE_COMPILE_CACHE_PORTABLE", "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "NODE_PATH", "NODE_REDIRECT_WARNINGS", "NODE_REPL_EXTERNAL_MODULE", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_UNIQUE_ID", "NODE_V8_COVERAGE", "OPENSSL_CONF", "SSL_CERT_DIR", "SSL_CERT_FILE"]
    .map((name) => `set "${name}="`).join("\r\n");
  const physicalPathAssertion = "function Assert-OdinnPhysicalPath([string]$PathValue){$full=[IO.Path]::GetFullPath($PathValue);$root=[IO.Path]::GetPathRoot($full);$cursor=$root;foreach($part in ($full.Substring($root.Length) -split '[\\\\/]')){if(!$part){continue};$cursor=[IO.Path]::Combine($cursor,$part);$item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Odinn path contains a reparse point'}}}";
  const powershell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${clears}\r\nset "ODINN_CURRENT="\r\nset "ODINN_DISTRIBUTION="\r\nset "ODINN_RUNTIME_SHA256="\r\nset /p ODINN_CURRENT=<"${currentPath}"\r\nfor /f "usebackq skip=1 delims=" %%i in ("${currentPath}") do if not defined ODINN_DISTRIBUTION set "ODINN_DISTRIBUTION=%%i"\r\nfor /f "usebackq skip=2 delims=" %%i in ("${currentPath}") do if not defined ODINN_RUNTIME_SHA256 set "ODINN_RUNTIME_SHA256=%%i"\r\nset "ODINN_CURRENT_PATH=${currentPath}"\r\nset "ODINN_PREFIX=${prefix}"\r\nset "ODINN_VERSIONS=${prefix}\\versions"\r\nset "ODINN_ROOT=${prefix}\\versions\\%ODINN_CURRENT%"\r\nset "ODINN_RUNTIME_DIR=%ODINN_ROOT%\\runtime"\r\nset "ODINN_NODE=%ODINN_RUNTIME_DIR%\\node.exe"\r\nset "ODINN_POWERSHELL=${powershell}"\r\nif not exist "%ODINN_POWERSHELL%" (echo Trusted PowerShell is unavailable 1>&2 & exit /b 126)\r\n"%ODINN_POWERSHELL%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${physicalPathAssertion};if($env:ODINN_CURRENT -cnotmatch '^[A-Za-z0-9._-]+$'){exit 126};if(@('standalone','compiled','source') -cnotcontains $env:ODINN_DISTRIBUTION){exit 126};Assert-OdinnPhysicalPath $env:ODINN_CURRENT_PATH;Assert-OdinnPhysicalPath $env:ODINN_PREFIX;Assert-OdinnPhysicalPath $env:ODINN_VERSIONS;Assert-OdinnPhysicalPath $env:ODINN_ROOT;if($env:ODINN_DISTRIBUTION -ceq 'standalone'){if($env:ODINN_RUNTIME_SHA256 -cnotmatch '^[a-f0-9]{64}$'){exit 126};Assert-OdinnPhysicalPath $env:ODINN_RUNTIME_DIR;Assert-OdinnPhysicalPath $env:ODINN_NODE;$i=Get-Item -LiteralPath $env:ODINN_NODE -Force -ErrorAction Stop;if($i.PSIsContainer){exit 126};if((Get-FileHash -LiteralPath $env:ODINN_NODE -Algorithm SHA256).Hash.ToLowerInvariant() -ne $env:ODINN_RUNTIME_SHA256){exit 126}}elseif($env:ODINN_RUNTIME_SHA256){exit 126}"\r\nif errorlevel 1 (echo Odinn installation pointer or runtime identity check failed 1>&2 & exit /b 126)\r\nif "%ODINN_DISTRIBUTION%"=="standalone" goto standalone\r\nif "%ODINN_DISTRIBUTION%"=="compiled" goto compiled\r\nif "%ODINN_DISTRIBUTION%"=="source" goto source\r\necho Odinn current distribution is invalid 1>&2\r\nexit /b 126\r\n:standalone\r\n"%ODINN_NODE%" "%ODINN_ROOT%\\${compiledEntry}" %*\r\nexit /b %ERRORLEVEL%\r\n:compiled\r\nnode "%ODINN_ROOT%\\${compiledEntry}" %*\r\nexit /b %ERRORLEVEL%\r\n:source\r\nnode "%ODINN_ROOT%\\${sourceEntry}" %*\r\nexit /b %ERRORLEVEL%\r\n`;
}

async function atomicLauncher(path: string, content: string, mode: number) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error(`launcher must be a physical file: ${basename(path)}`);
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { mode, flag: "wx" });
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
    const allowed = new Set(["odinn", "odinn.cmd", "odinn-gateway", "odinn-gateway.cmd"]);
    for (const entry of await readdir(bin, { withFileTypes: true })) {
      const temporary = /^(?:odinn|odinn-gateway)(?:\.cmd)?\.[A-Za-z0-9_.-]+\.tmp$/u.test(entry.name);
      if ((!allowed.has(entry.name) && !temporary) || !entry.isFile() || entry.isSymbolicLink()) {
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
      if (/^(?:\.install-state-|current\.).+\.tmp$/u.test(entry.name)) candidates.push(join(prefix, entry.name));
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
      if (/^(?:odinn|odinn-gateway)(?:\.cmd)?\.[A-Za-z0-9_.-]+\.tmp$/u.test(entry.name)) candidates.push(join(bin, entry.name));
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
