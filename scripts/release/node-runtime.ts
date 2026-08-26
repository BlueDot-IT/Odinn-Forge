import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { sanitizedReleaseEnvironment, trustedTool } from "./trusted-tools.ts";

export type RuntimeTarget = "linux-x64" | "darwin-x64" | "win32-x64";
type RuntimeTargetPolicy = {
  archive: string;
  bytes: number;
  sha256: string;
  nodePath: string;
  executableBytes: number;
  executableSha256: string;
};
export interface RuntimePolicy {
  schemaVersion: 1;
  version: string;
  origin: string;
  signedManifest: { path: string; bytes: number; sha256: string; cleartextSha256: string };
  keyring: { url: string; bytes: number; sha256: string; allowedPrimaryFingerprints: string[] };
  targets: Record<RuntimeTarget, RuntimeTargetPolicy>;
}

type ArchiveEntry = { name: string; type: "file" | "directory" | "link" | "device" };
const TARGETS: RuntimeTarget[] = ["darwin-x64", "linux-x64", "win32-x64"];
const SHA256 = /^[a-f0-9]{64}$/u;
const FINGERPRINT = /^[A-F0-9]{40}$/u;
const MAX_KEY_MATERIAL_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 180_000;

function digest(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function assertBoundedInteger(value: unknown, maximum: number, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
    throw new Error(`invalid ${label} byte size`);
  }
}

export async function runtimePolicySha256(root: string): Promise<string> {
  return digest(await readFile(join(root, "release/node-runtime-policy.json")));
}

export async function readRuntimePolicy(root: string): Promise<RuntimePolicy> {
  const policy = JSON.parse(await readFile(join(root, "release/node-runtime-policy.json"), "utf8")) as RuntimePolicy;
  if (policy.schemaVersion !== 1 || !/^24\.\d+\.\d+$/u.test(policy.version)) throw new Error("invalid pinned Node runtime policy");
  if (policy.origin !== "https://nodejs.org") throw new Error("Node runtime origin must be the reviewed HTTPS origin");
  if (policy.signedManifest?.path !== "SHASUMS256.txt.asc") throw new Error("invalid signed Node checksum manifest policy");
  assertBoundedInteger(policy.signedManifest?.bytes, MAX_KEY_MATERIAL_BYTES, "signed Node checksum manifest");
  if (!SHA256.test(policy.signedManifest.sha256) || !SHA256.test(policy.signedManifest.cleartextSha256)) {
    throw new Error("invalid signed Node checksum manifest digest policy");
  }
  if (!/^https:\/\/raw\.githubusercontent\.com\/nodejs\/release-keys\/[a-f0-9]{40}\/gpg-only-active-keys\/pubring\.kbx$/u.test(policy.keyring?.url ?? "")) {
    throw new Error("Node release keyring URL must be pinned to an immutable reviewed commit");
  }
  assertBoundedInteger(policy.keyring?.bytes, MAX_KEY_MATERIAL_BYTES, "Node release keyring");
  if (!SHA256.test(policy.keyring.sha256)
    || !Array.isArray(policy.keyring.allowedPrimaryFingerprints)
    || policy.keyring.allowedPrimaryFingerprints.length < 3
    || policy.keyring.allowedPrimaryFingerprints.some((entry) => !FINGERPRINT.test(entry))
    || new Set(policy.keyring.allowedPrimaryFingerprints).size !== policy.keyring.allowedPrimaryFingerprints.length) {
    throw new Error("invalid reviewed Node release key policy");
  }
  if (JSON.stringify(Object.keys(policy.targets ?? {}).sort()) !== JSON.stringify(TARGETS)) {
    throw new Error("Node runtime policy must define the exact reviewed platform matrix");
  }
  const expected = {
    "linux-x64": { archive: `node-v${policy.version}-linux-x64.tar.xz`, nodePath: "bin/node" },
    "darwin-x64": { archive: `node-v${policy.version}-darwin-x64.tar.gz`, nodePath: "bin/node" },
    "win32-x64": { archive: `node-v${policy.version}-win-x64.zip`, nodePath: "node.exe" }
  } satisfies Record<RuntimeTarget, { archive: string; nodePath: string }>;
  for (const target of TARGETS) {
    const entry = policy.targets[target];
    if (basename(entry.archive) !== entry.archive
      || entry.archive !== expected[target].archive
      || entry.nodePath !== expected[target].nodePath
      || !SHA256.test(entry.sha256)
      || !SHA256.test(entry.executableSha256)) {
      throw new Error(`invalid Node runtime target policy: ${target}`);
    }
    assertBoundedInteger(entry.bytes, 1024 * 1024 * 1024, `${target} archive`);
    assertBoundedInteger(entry.executableBytes, 512 * 1024 * 1024, `${target} executable`);
  }
  return policy;
}

function normalizedArchivePath(raw: string): string {
  if (!raw || raw.includes("\\") || /[\0-\x1f\x7f]/u.test(raw)) throw new Error(`unsafe Node archive path: ${raw}`);
  const name = raw.replace(/^\.\//u, "").replace(/\/$/u, "");
  if (!name || name.startsWith("/") || /^[A-Za-z]:/u.test(name)) throw new Error(`unsafe Node archive path: ${raw}`);
  if (name.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`unsafe Node archive path: ${raw}`);
  return name;
}

function validateArchivePaths(entries: ArchiveEntry[], expectedRoot: string, caseInsensitive: boolean): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = normalizedArchivePath(entry.name);
    const identity = caseInsensitive ? name.toLowerCase() : name;
    if (seen.has(identity)) throw new Error(`duplicate Node archive path: ${name}`);
    seen.add(identity);
    if (name !== expectedRoot && !name.startsWith(`${expectedRoot}/`)) throw new Error(`unexpected Node archive top-level layout: ${name}`);
  }
  if (!seen.size) throw new Error("empty Node runtime archive");
}

export function validateArchiveEntries(entries: ArchiveEntry[], expectedRoot: string): void {
  validateArchivePaths(entries, expectedRoot, false);
  for (const entry of entries) {
    if (entry.type === "link" || entry.type === "device") {
      throw new Error(`unsupported Node archive entry: ${normalizedArchivePath(entry.name)}`);
    }
  }
}

function validateSelectedRuntimeEntries(entries: ArchiveEntry[], expectedRoot: string, required: string[], caseInsensitive: boolean): void {
  validateArchivePaths(entries, expectedRoot, caseInsensitive);
  const byName = new Map(entries.map((entry) => [normalizedArchivePath(entry.name), entry]));
  const selected: ArchiveEntry[] = [];
  for (const path of required) {
    const entry = byName.get(path);
    if (!entry || entry.type !== "file") throw new Error(`required Node runtime entry is missing or not a regular file: ${path}`);
    selected.push(entry);
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = parts.slice(0, index).join("/");
      const ancestorEntry = byName.get(ancestor);
      if (ancestorEntry && ancestorEntry.type !== "directory") {
        throw new Error(`required Node runtime ancestor is not a physical directory: ${ancestor}`);
      }
    }
  }
  // Official Node tarballs contain npm/corepack convenience links. They are
  // never extracted. The selected runtime subset itself is strictly link- and
  // device-free and is materialized from stdout into a new physical tree.
  validateArchiveEntries(selected, expectedRoot);
  if (entries.some((entry) => entry.type === "device")) throw new Error("Node runtime archive contains a device entry");
}

function run(command: string, args: string[], options: { cwd?: string; maxBuffer?: number } = {}): Buffer {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: null,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    env: sanitizedReleaseEnvironment()
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${Buffer.from(result.stderr ?? "").toString("utf8") || Buffer.from(result.stdout ?? "").toString("utf8") || result.error?.message}`);
  }
  return Buffer.from(result.stdout ?? "");
}

async function downloadExact(url: string, expectedLocation: { origin?: string; exactUrl?: string }, bytes: number, sha256: string): Promise<Buffer> {
  const location = new URL(url);
  if (location.protocol !== "https:"
    || (expectedLocation.origin && location.origin !== expectedLocation.origin)
    || (expectedLocation.exactUrl && location.toString() !== expectedLocation.exactUrl)) {
    throw new Error(`untrusted runtime download location: ${location.toString()}`);
  }
  const response = await fetch(location, { redirect: "manual", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (response.status >= 300 && response.status < 400) throw new Error("runtime download redirect refused");
  if (!response.ok || !response.body) throw new Error(`runtime download failed: ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared && declared !== bytes) throw new Error("runtime download declared an unexpected byte size");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      received += chunk.byteLength;
      if (received > bytes) throw new Error("runtime download exceeded its pinned byte size");
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const value = Buffer.concat(chunks, received);
  if (value.byteLength !== bytes || digest(value) !== sha256) throw new Error("runtime download did not match its pinned identity");
  return value;
}

async function ensurePhysicalDirectory(path: string, label: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a physical directory`);
  if (process.platform !== "win32" && await realpath(path) !== resolve(path)) throw new Error(`${label} must not traverse a symbolic link`);
}

async function readVerifiedCacheFile(path: string, bytes: number, sha256: string): Promise<Buffer | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size !== bytes) {
      throw new Error("cached Node runtime archive is not a physical file with the pinned size");
    }
    const value = await readFile(path);
    if (digest(value) !== sha256) throw new Error("cached Node runtime archive checksum mismatch");
    return value;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function listZipEntries(archive: Buffer): ArchiveEntry[] {
  const minimum = Math.max(0, archive.byteLength - 65_557);
  let eocd = -1;
  for (let offset = archive.byteLength - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("Node ZIP archive is missing its central directory");
  const disk = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const count = archive.readUInt16LE(eocd + 10);
  const size = archive.readUInt32LE(eocd + 12);
  let offset = archive.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || count === 0xffff || size === 0xffffffff || offset === 0xffffffff || offset + size > eocd) {
    throw new Error("unsupported or multi-disk Node ZIP archive");
  }
  const entries: ArchiveEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > archive.byteLength || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("invalid Node ZIP central directory entry");
    const madeBy = archive.readUInt16LE(offset + 4);
    const flags = archive.readUInt16LE(offset + 8);
    const nameBytes = archive.readUInt16LE(offset + 28);
    const extraBytes = archive.readUInt16LE(offset + 30);
    const commentBytes = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const end = offset + 46 + nameBytes + extraBytes + commentBytes;
    if ((flags & 1) !== 0 || end > archive.byteLength) throw new Error("encrypted or truncated Node ZIP archive entry");
    const name = archive.subarray(offset + 46, offset + 46 + nameBytes).toString((flags & 0x800) !== 0 ? "utf8" : "latin1");
    const host = madeBy >>> 8;
    const unixMode = host === 3 ? externalAttributes >>> 16 : 0;
    const kind = unixMode & 0o170000;
    const type: ArchiveEntry["type"] = name.endsWith("/") || kind === 0o040000 || (externalAttributes & 0x10) !== 0
      ? "directory"
      : kind === 0o120000 ? "link"
        : kind !== 0 && kind !== 0o100000 ? "device" : "file";
    entries.push({ name, type });
    offset = end;
  }
  if (offset > eocd || offset < eocd - 20) throw new Error("Node ZIP central directory length mismatch");
  return entries;
}

function listTarEntries(archivePath: string): ArchiveEntry[] {
  const names = run(trustedTool("tar"), ["--quoting-style=escape", "-tf", archivePath]).toString("utf8").trimEnd().split("\n").filter(Boolean);
  const verbose = run(trustedTool("tar"), ["--quoting-style=escape", "-tvf", archivePath]).toString("utf8").trimEnd().split("\n").filter(Boolean);
  if (names.length !== verbose.length) throw new Error("Node tar archive listing is ambiguous");
  return names.map((name, index) => {
    const marker = verbose[index]?.trimStart()[0];
    const type: ArchiveEntry["type"] = marker === "d" ? "directory"
      : marker === "-" ? "file"
        : marker === "l" || marker === "h" ? "link" : "device";
    return { name, type };
  });
}

function extractSelectedFile(archivePath: string, archiveName: string, path: string, maximumBytes: number): Buffer {
  const value = archiveName.endsWith(".zip")
    ? run(trustedTool("unzip"), ["-p", archivePath, path], { maxBuffer: maximumBytes + 1 })
    : run(trustedTool("tar"), ["-xOf", archivePath, path], { maxBuffer: maximumBytes + 1 });
  if (value.byteLength > maximumBytes) throw new Error(`selected Node runtime entry exceeds its byte limit: ${path}`);
  return value;
}

export function verifyRuntimeExecutableIdentity(executable: Buffer, target: RuntimeTarget): void {
  if (target === "linux-x64") {
    if (executable.byteLength < 20
      || executable.subarray(0, 4).toString("hex") !== "7f454c46"
      || executable[4] !== 2
      || executable[5] !== 1
      || executable.readUInt16LE(18) !== 0x3e) throw new Error("embedded runtime is not a Linux x64 ELF executable");
    return;
  }
  if (target === "darwin-x64") {
    if (executable.byteLength < 12
      || executable.readUInt32LE(0) !== 0xfeedfacf
      || executable.readUInt32LE(4) !== 0x01000007) throw new Error("embedded runtime is not a macOS x64 Mach-O executable");
    return;
  }
  if (executable.byteLength < 0x40 || executable.subarray(0, 2).toString("ascii") !== "MZ") throw new Error("embedded runtime is not a Windows PE executable");
  const header = executable.readUInt32LE(0x3c);
  if (header + 6 > executable.byteLength
    || executable.readUInt32LE(header) !== 0x00004550
    || executable.readUInt16LE(header + 4) !== 0x8664) throw new Error("embedded runtime is not a Windows x64 PE executable");
}

function primaryFingerprints(keyringPath: string, gnupgHome: string): string[] {
  const listing = run(trustedTool("gpg"), ["--no-options", "--batch", "--homedir", gnupgHome, "--no-default-keyring", "--keyring", keyringPath, "--with-colons", "--fingerprint"]).toString("utf8");
  const result: string[] = [];
  let awaitingPrimary = false;
  for (const line of listing.split("\n")) {
    const fields = line.split(":");
    if (fields[0] === "pub") awaitingPrimary = true;
    else if (awaitingPrimary && fields[0] === "fpr") {
      if (!FINGERPRINT.test(fields[9] ?? "")) throw new Error("Node release keyring contains an invalid primary fingerprint");
      result.push(fields[9]!);
      awaitingPrimary = false;
    }
  }
  return result;
}

export async function acquireNodeRuntime(root: string, target: RuntimeTarget, cacheRoot: string): Promise<{ runtimeRoot: string; temporaryRoot: string; evidence: Record<string, unknown> }> {
  const policy = await readRuntimePolicy(root);
  const policySha256 = await runtimePolicySha256(root);
  const selected = policy.targets[target];
  if (!selected) throw new Error(`unsupported standalone target: ${target}`);
  await ensurePhysicalDirectory(cacheRoot, "Node runtime cache root");
  const cache = join(cacheRoot, `${policy.version}-${policySha256}-${selected.sha256}`);
  await ensurePhysicalDirectory(cache, "Node runtime cache entry");
  const archivePath = join(cache, selected.archive);
  let archive = await readVerifiedCacheFile(archivePath, selected.bytes, selected.sha256);
  if (!archive) {
    const downloaded = await downloadExact(
      `${policy.origin}/dist/v${policy.version}/${selected.archive}`,
      { origin: policy.origin },
      selected.bytes,
      selected.sha256
    );
    const temporary = join(cache, `.archive-${process.pid}-${Date.now()}.tmp`);
    try {
      await writeFile(temporary, downloaded, { flag: "wx", mode: 0o600 });
      await rename(temporary, archivePath);
    } catch (error: any) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (error?.code !== "EEXIST") throw error;
    }
    archive = await readVerifiedCacheFile(archivePath, selected.bytes, selected.sha256);
    if (!archive) throw new Error("verified Node runtime archive did not enter the immutable cache");
  }

  const verificationRoot = await mkdtemp(join(tmpdir(), `odinn-node-verify-${target}-`));
  try {
    const [signedManifest, keyring] = await Promise.all([
      downloadExact(
        `${policy.origin}/dist/v${policy.version}/${policy.signedManifest.path}`,
        { origin: policy.origin },
        policy.signedManifest.bytes,
        policy.signedManifest.sha256
      ),
      downloadExact(policy.keyring.url, { exactUrl: policy.keyring.url }, policy.keyring.bytes, policy.keyring.sha256)
    ]);
    const keyringPath = join(verificationRoot, "node-release-keyring.kbx");
    const gnupgHome = join(verificationRoot, "gnupg");
    const ascPath = join(verificationRoot, policy.signedManifest.path);
    const manifestPath = join(verificationRoot, "SHASUMS256.txt");
    await writeFile(keyringPath, keyring, { flag: "wx", mode: 0o600 });
    await writeFile(ascPath, signedManifest, { flag: "wx", mode: 0o600 });
    await mkdir(gnupgHome, { mode: 0o700 });
    const actualPrimaries = primaryFingerprints(keyringPath, gnupgHome).sort();
    const reviewedPrimaries = [...policy.keyring.allowedPrimaryFingerprints].sort();
    if (JSON.stringify(actualPrimaries) !== JSON.stringify(reviewedPrimaries)) {
      throw new Error("Node release keyring primary fingerprints differ from the reviewed policy");
    }
    const status = run(trustedTool("gpgv"), ["--homedir", gnupgHome, "--status-fd=1", "--keyring", keyringPath, "--output", manifestPath, ascPath]).toString("utf8");
    const validSigners = status.split("\n")
      .filter((line) => line.startsWith("[GNUPG:] VALIDSIG "))
      .map((line) => line.split(/\s+/u)[2] ?? "");
    if (validSigners.length !== 1 || !policy.keyring.allowedPrimaryFingerprints.includes(validSigners[0]!)) {
      throw new Error("signed Node checksum manifest was not signed by one reviewed primary key");
    }
    const manifestBytes = await readFile(manifestPath);
    if (digest(manifestBytes) !== policy.signedManifest.cleartextSha256) throw new Error("verified Node checksum manifest cleartext digest mismatch");
    const expectedLine = `${selected.sha256}  ${selected.archive}`;
    if (manifestBytes.toString("utf8").split(/\r?\n/u).filter((line) => line === expectedLine).length !== 1) {
      throw new Error("signed Node checksum manifest does not uniquely authorize selected archive");
    }

    const expectedRoot = selected.archive.replace(/\.(?:tar\.xz|tar\.gz|zip)$/u, "");
    const required = [`${expectedRoot}/${selected.nodePath}`, `${expectedRoot}/LICENSE`];
    const entries = selected.archive.endsWith(".zip") ? listZipEntries(archive) : listTarEntries(archivePath);
    validateSelectedRuntimeEntries(entries, expectedRoot, required, target === "win32-x64");
    const executable = extractSelectedFile(archivePath, selected.archive, required[0]!, selected.executableBytes);
    if (executable.byteLength !== selected.executableBytes || digest(executable) !== selected.executableSha256) {
      throw new Error("extracted Node runtime executable digest mismatch");
    }
    verifyRuntimeExecutableIdentity(executable, target);
    const license = extractSelectedFile(archivePath, selected.archive, required[1]!, 2 * 1024 * 1024);
    if (!license.byteLength) throw new Error("Node runtime license is empty");

    const runtimeRoot = join(verificationRoot, expectedRoot);
    const node = join(runtimeRoot, selected.nodePath);
    await mkdir(join(runtimeRoot, selected.nodePath.includes("/") ? selected.nodePath.split("/")[0]! : "."), { recursive: true, mode: 0o700 });
    await writeFile(node, executable, { flag: "wx", mode: 0o755 });
    await writeFile(join(runtimeRoot, "LICENSE"), license, { flag: "wx", mode: 0o644 });
    await chmod(node, 0o755).catch(() => undefined);
    const resolvedNode = resolve(node);
    if (!resolvedNode.startsWith(`${resolve(runtimeRoot)}${sep}`)) throw new Error("unsafe runtime executable policy path");
    if (target === `${process.platform}-${process.arch}`) {
      const versionOutput = run(node, ["--version"]).toString("utf8").trim();
      if (versionOutput !== `v${policy.version}`) throw new Error("Node runtime binary version mismatch");
    }
    return {
      runtimeRoot,
      temporaryRoot: verificationRoot,
      evidence: {
        version: policy.version,
        target,
        sourceUrl: `${policy.origin}/dist/v${policy.version}/${selected.archive}`,
        archive: selected.archive,
        archiveBytes: selected.bytes,
        archiveSha256: selected.sha256,
        executableBytes: selected.executableBytes,
        executableSha256: selected.executableSha256,
        signedManifest: policy.signedManifest.path,
        signedManifestSha256: policy.signedManifest.sha256,
        signedManifestCleartextSha256: policy.signedManifest.cleartextSha256,
        signerFingerprint: validSigners[0],
        keyringUrl: policy.keyring.url,
        keyringSha256: policy.keyring.sha256,
        runtimePolicySha256: policySha256,
        extraction: "selected-regular-files-only"
      }
    };
  } catch (error) {
    await rm(verificationRoot, { recursive: true, force: true });
    throw error;
  }
}
