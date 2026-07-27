#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

const [command = "status", ...args] = process.argv.slice(2);
const prefix = resolve(option("--prefix", process.env.ODINN_INSTALL_PREFIX || join(homedir(), ".local", "share", "odinn")));
const statePath = join(prefix, "install-state.json");
await validatePrefix(prefix);

if (command === "install" || command === "upgrade") await install(command);
else if (command === "rollback") await rollback();
else if (command === "status") console.log(JSON.stringify(await readState(), null, 2));
else throw new Error("usage: install.ts install|upgrade|rollback|status [--source DIR] [--prefix DIR] [--version VERSION] [--commit SHA] [--artifact-sha256 HASH] [--skip-deps]");

async function install(operation: any) {
  const source = resolve(option("--source", process.cwd()));
  await validateSource(source);
  const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  if (pkg.name !== "odinn" && pkg.name !== "@bluedot-it/odinn") {
    throw new Error("install source is not an Odinn Forge package");
  }
  const releaseInfo = await readReleaseInfo(source);
  const compiled = releaseInfo.distribution === "compiled" && existsSync(join(source, "dist", "cli", "index.js"));
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
    ? { node: process.version, distribution: "compiled" }
    : { node: process.version, distribution: "source", packageManager: pkg.packageManager || "unknown" };
  const toolchainSha256 = createHash("sha256").update(JSON.stringify(toolchain)).digest("hex");
  const identity = `${runtimeSha256.slice(0, 12)}-${String(commit).slice(0, 12)}-${toolchainSha256.slice(0, 12)}`;
  const versionId = `${version}-${identity}`;
  const versions = join(prefix, "versions");
  const destination = join(versions, versionId);
  await ensurePhysicalDirectory(versions, "version root");
  const staging = await mkdtemp(join(versions, ".staging-"));
  await cp(source, staging, { recursive: true, filter: (path: any) => !excluded(path, source, compiled) });
  if (!compiled && !has("--skip-deps")) run(process.platform === "win32" ? "corepack.cmd" : "corepack", ["pnpm", "install", "--frozen-lockfile"], staging);
  const metadata = { schemaVersion: 2, version, commit, runtimeSha256, lockfileSha256: lockfileSha256 || undefined, artifactSha256, toolchain, installedAt: new Date().toISOString() };
  await writeFile(join(staging, "install-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
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
    await rm(staging, { recursive: true, force: true });
  } else {
    await rename(staging, destination);
  }
  const previous = await readState();
  const next = { schemaVersion: 1, current: versionId, currentVersion: version, currentCommit: commit, previous: previous.current && previous.current !== versionId ? previous.current : previous.previous ?? null, installedAt: new Date().toISOString(), operation };
  await writeState(next);
  await writeLaunchers(compiled);
  console.log(JSON.stringify({ ok: true, prefix, version, versionId, commit, previous: next.previous }, null, 2));
}

async function rollback() {
  const current = await readState();
  if (!current.previous) throw new Error("no previous Odinn Forge installation is available for rollback");
  const priorMetadata = await readInstalledMetadata(current.previous);
  const next = { ...current, current: current.previous, currentVersion: priorMetadata.version, currentCommit: priorMetadata.commit, previous: current.current, rolledBackAt: new Date().toISOString(), operation: "rollback" };
  await writeState(next);
  console.log(JSON.stringify({ ok: true, prefix, current: next.current, previous: next.previous }, null, 2));
}

async function readState() {
  try {
    const metadata = await lstat(statePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error("install state must be a physical file");
    const value = JSON.parse(await readFile(statePath, "utf8"));
    if (!value || value.schemaVersion !== 1) throw new Error("install state is invalid or unsupported");
    for (const pointer of [value.current, value.previous]) {
      if (pointer !== null && (typeof pointer !== "string" || !safeVersionId(pointer))) {
        throw new Error("install state contains an unsafe version pointer");
      }
    }
    return value;
  }
  catch (error: any) { if (error?.code === "ENOENT") return { schemaVersion: 1, current: null, previous: null }; throw error; }
}

async function writeState(value: any) {
  await ensurePhysicalDirectory(prefix, "install prefix");
  const temporary = join(prefix, `.install-state-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, statePath);
  await chmod(statePath, 0o600).catch(() => undefined);
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

async function digestIfPresent(path: string): Promise<string> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch (error: any) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function writeLaunchers(compiled: boolean) {
  const bin = join(prefix, "bin");
  await ensurePhysicalDirectory(bin, "launcher root");
  const cliEntry = compiled ? "dist/cli/index.js" : "apps/cli/src/cli.ts";
  const gatewayEntry = compiled ? "dist/gateway/server.js" : "apps/gateway/src/server.ts";
  const unix = `#!/bin/sh\nset -eu\nPREFIX=${shellQuote(prefix)}\nCURRENT=$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).current)' "$PREFIX/install-state.json")\nexec node "$PREFIX/versions/$CURRENT/${cliEntry}" "$@"\n`;
  const gateway = `#!/bin/sh\nset -eu\nPREFIX=${shellQuote(prefix)}\nCURRENT=$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).current)' "$PREFIX/install-state.json")\nexec node "$PREFIX/versions/$CURRENT/${gatewayEntry}" "$@"\n`;
  await atomicLauncher(join(bin, "odinn"), unix, 0o755);
  await atomicLauncher(join(bin, "odinn-gateway"), gateway, 0o755);
  const cmdEntry = cliEntry.replaceAll("/", "\\");
  const gatewayCmdEntry = gatewayEntry.replaceAll("/", "\\");
  const cmd = `@echo off\r\nfor /f "usebackq delims=" %%i in (\`node -e "const fs=require('fs');process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).current)" "${statePath}"\`) do set ODINN_CURRENT=%%i\r\nnode "${prefix}\\versions\\%ODINN_CURRENT%\\${cmdEntry}" %*\r\n`;
  const gatewayCmd = `@echo off\r\nfor /f "usebackq delims=" %%i in (\`node -e "const fs=require('fs');process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).current)" "${statePath}"\`) do set ODINN_CURRENT=%%i\r\nnode "${prefix}\\versions\\%ODINN_CURRENT%\\${gatewayCmdEntry}" %*\r\n`;
  await atomicLauncher(join(bin, "odinn.cmd"), cmd, 0o600);
  await atomicLauncher(join(bin, "odinn-gateway.cmd"), gatewayCmd, 0o600);
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
      if (!allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`install prefix contains an unrelated launcher entry: ${entry.name}`);
      }
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function validateSource(path: string) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("install source must be a physical directory");
  if (path === prefix || path.startsWith(`${prefix}${sep}`) || prefix.startsWith(`${path}${sep}`)) {
    throw new Error("install source and prefix must not contain one another");
  }
}

async function ensurePhysicalDirectory(path: string, label: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a physical directory`);
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
  return value;
}

function safeVersionId(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function excluded(path: any, source: any, compiled: boolean) {
  const relative = path.slice(source.length).replaceAll("\\", "/");
  if (/(^|\/)(\.git|\.odinn)(\/|$)/.test(relative)) return true;
  if (!compiled && /(^|\/)(node_modules|dist)(\/|$)/.test(relative)) return true;
  return false;
}
function run(commandName: any, commandArgs: any, cwd: any) { const result = spawnSync(commandName, commandArgs, { cwd, stdio: "inherit", shell: false }); if (result.status !== 0) throw new Error(`${commandName} failed with exit code ${result.status}`); }
function option(name: any, fallback: any = "") { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; }
function has(name: any) { return args.includes(name); }
function shellQuote(value: any) { return `'${String(value).replaceAll("'", `'\\''`)}'`; }
