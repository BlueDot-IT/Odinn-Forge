import { constants, type BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, opendir, realpath, rename, rm, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_BYTES = 1_073_741_824;
const DEFAULT_MAX_PATH_BYTES = 4_096;
const HARD_MAX_FILES = 100_000;
const HARD_MAX_DEPTH = 64;
const HARD_MAX_BYTES = 8 * 1_073_741_824;
const HARD_MAX_PATH_BYTES = 16_384;
const COPY_BUFFER_BYTES = 64 * 1_024;
const BUNDLE_FORMAT = "odinn-sandbox-bundle-v1\0";
const DIRECTORY_MODE = 0o555;
const DATA_FILE_MODE = 0o444;
const EXECUTABLE_FILE_MODE = 0o555;

type Identity = Readonly<{ dev: bigint; ino: bigint }>;
type DirectoryIdentity = Identity & Readonly<{
  path: string;
  mode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;
type BundleEntry = Readonly<{
  type: "directory" | "file";
  path: string;
  mode: number;
  size?: number;
  contentDigest?: string;
}>;

export type SandboxBundleReference = Readonly<{
  digest: string;
  path: string;
  files: number;
  bytes: number;
}>;

export type SandboxBundleTestHooks = Readonly<{
  afterSourceValidation?: () => void | Promise<void>;
  afterEntryLstat?: (path: string) => void | Promise<void>;
  afterFileOpen?: (path: string) => void | Promise<void>;
  beforeFilePostValidation?: (path: string) => void | Promise<void>;
  beforeDirectoryPostValidation?: (path: string) => void | Promise<void>;
  beforeFinalize?: (stagingPath: string, digest: string) => void | Promise<void>;
  afterStagingSync?: (stagingPath: string) => void | Promise<void>;
  beforeExistingVerification?: (targetPath: string) => void | Promise<void>;
  afterExistingVerification?: (targetPath: string) => void | Promise<void>;
  afterPublishSync?: (targetPath: string) => void | Promise<void>;
}>;

export type SandboxBundleOptions = Readonly<{
  maxFiles?: number;
  maxDepth?: number;
  maxBytes?: number;
  maxPathBytes?: number;
  signal?: AbortSignal;
  /** Deterministic security-test hooks. Production callers must not supply these. */
  hooks?: SandboxBundleTestHooks;
}>;

type MaterializationLimits = Readonly<{
  maxFiles: number;
  maxDepth: number;
  maxBytes: number;
  maxPathBytes: number;
  maxDirectories: number;
}>;

type BundleScan = Readonly<{
  digest: string;
  files: number;
  bytes: number;
  entries: readonly BundleEntry[];
  rootIdentity?: DirectoryIdentity;
}>;

type MaterializationContext = {
  sourceRoot: string;
  stagingRoot: string;
  limits: MaterializationLimits;
  signal?: AbortSignal;
  hooks?: SandboxBundleTestHooks;
  entries: BundleEntry[];
  files: number;
  directories: number;
  bytes: number;
  sourceDirectories: DirectoryIdentity[];
};

/**
 * Materialize one hostile source tree into a verified, content-addressed bundle.
 * The returned reference contains only content-free aggregate metadata.
 */
export async function materializeSandboxBundle(
  sourceDirectory: string,
  stateRoot: string,
  options: SandboxBundleOptions = {}
): Promise<SandboxBundleReference> {
  const limits = normalizeLimits(options);
  throwIfCancelled(options.signal);
  const sourceRoot = await requireAbsoluteRealDirectory(sourceDirectory, "sandbox bundle source");
  const sourceRootIdentity = await captureDirectoryIdentity(sourceRoot, "sandbox bundle source");
  const requestedStateRoot = resolveStateRootInput(stateRoot);
  if (overlaps(sourceRoot, requestedStateRoot)) {
    throw new Error("sandbox bundle source and state root must not overlap");
  }
  const store = await prepareBundleStore(stateRoot);
  if (overlaps(sourceRoot, store.stateRoot)) {
    throw new Error("sandbox bundle source and state root must not overlap");
  }
  await options.hooks?.afterSourceValidation?.();
  throwIfCancelled(options.signal);
  await assertDirectoryIdentity(sourceRootIdentity, "sandbox bundle source");

  // Keep staging and final names in one directory so publication is one
  // same-parent atomic rename on restrictive/FUSE-backed filesystems too.
  const stagingRoot = join(store.digestRoot, `.staging-${process.pid}-${randomUUID()}`);
  await mkdir(stagingRoot, { mode: 0o700 });
  const storeIdentities = await captureDirectoryChain([store.stateRoot, store.bundlesRoot, store.digestRoot], "sandbox bundle store");
  let published = false;
  try {
    const context: MaterializationContext = {
      sourceRoot,
      stagingRoot,
      limits,
      signal: options.signal,
      hooks: options.hooks,
      entries: [],
      files: 0,
      directories: 0,
      bytes: 0,
      sourceDirectories: [sourceRootIdentity]
    };
    await copyDirectory(context, sourceRoot, stagingRoot, "", 0, sourceRootIdentity);
    await chmod(stagingRoot, DIRECTORY_MODE);
    const expected = summarizeEntries(context.entries, context.files, context.bytes);

    await options.hooks?.beforeFinalize?.(stagingRoot, expected.digest);
    throwIfCancelled(options.signal);
    await assertDirectoryChain(storeIdentities, "sandbox bundle store");
    const staged = await scanSealedBundle(stagingRoot, limits, options.signal);
    assertMatchingBundle(staged, expected, "sandbox bundle staging tree changed before finalization");
    await syncSealedTree(stagingRoot, options.signal);
    await options.hooks?.afterStagingSync?.(stagingRoot);
    throwIfCancelled(options.signal);
    await syncDirectory(store.digestRoot);

    const target = join(store.digestRoot, expected.digest);
    if (await pathExists(target)) {
      await options.hooks?.beforeExistingVerification?.(target);
      const existing = await scanSealedBundle(target, limits, options.signal);
      assertMatchingBundle(existing, expected, "existing sandbox bundle does not match its content address");
      await options.hooks?.afterExistingVerification?.(target);
      await assertScannedRootIdentity(existing, "existing sandbox bundle changed after verification");
      return frozenReference(expected, target);
    }

    await assertDirectoryChain(storeIdentities, "sandbox bundle store");
    throwIfCancelled(options.signal);
    try {
      await rename(stagingRoot, target);
      published = true;
    } catch (error) {
      if (!isPublishCollision(error) || !await pathExists(target)) throw error;
      await options.hooks?.beforeExistingVerification?.(target);
      const existing = await scanSealedBundle(target, limits, options.signal);
      assertMatchingBundle(existing, expected, "concurrently published sandbox bundle does not match its content address");
      await options.hooks?.afterExistingVerification?.(target);
      await assertScannedRootIdentity(existing, "concurrently published sandbox bundle changed after verification");
      return frozenReference(expected, target);
    }
    await assertDirectoryChainIdentityOnly(storeIdentities, "sandbox bundle store");
    await syncSealedTree(target, options.signal);
    await syncDirectory(store.digestRoot);
    await options.hooks?.afterPublishSync?.(target);
    throwIfCancelled(options.signal);
    const finalized = await scanSealedBundle(target, limits, options.signal);
    assertMatchingBundle(finalized, expected, "finalized sandbox bundle does not match its content address");
    await assertScannedRootIdentity(finalized, "finalized sandbox bundle changed after verification");
    return frozenReference(expected, target);
  } finally {
    if (!published) await removeStagingTree(stagingRoot);
  }
}

async function copyDirectory(
  context: MaterializationContext,
  sourceDirectory: string,
  destinationDirectory: string,
  relativeDirectory: string,
  depth: number,
  admitted: DirectoryIdentity
) {
  throwIfCancelled(context.signal);
  if (depth > context.limits.maxDepth) throw new Error(`sandbox bundle exceeds maximum depth ${context.limits.maxDepth}`);
  await assertDirectoryIdentity(admitted, "sandbox bundle source directory");
  const names: string[] = [];
  const directory = await opendir(sourceDirectory);
  try {
    for await (const entry of directory) {
      throwIfCancelled(context.signal);
      names.push(entry.name);
      if (names.length > context.limits.maxFiles + context.limits.maxDirectories) {
        throw new Error("sandbox bundle exceeds bounded entry count");
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  names.sort(compareStrings);
  if (new Set(names).size !== names.length) throw new Error("sandbox bundle directory contains duplicate entry names");

  for (const name of names) {
    throwIfCancelled(context.signal);
    const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    assertSafeBundlePath(relativePath, context.limits.maxPathBytes);
    const sourcePath = join(sourceDirectory, name);
    const destinationPath = join(destinationDirectory, name);
    await assertDirectoryChain(context.sourceDirectories, "sandbox bundle source");
    const before = await lstat(sourcePath, { bigint: true });
    await context.hooks?.afterEntryLstat?.(relativePath);
    throwIfCancelled(context.signal);

    if (before.isSymbolicLink()) throw new Error(`sandbox bundle rejects symbolic links and junctions: ${relativePath}`);
    if (before.isDirectory()) {
      context.directories += 1;
      if (context.directories > context.limits.maxDirectories) throw new Error(`sandbox bundle exceeds maximum directory count ${context.limits.maxDirectories}`);
      const canonical = resolve(await realpath(sourcePath));
      if (canonical !== resolve(sourcePath)) throw new Error(`sandbox bundle rejects noncanonical directory identity: ${relativePath}`);
      const current = await lstat(sourcePath, { bigint: true });
      const childIdentity = directoryIdentity(sourcePath, current, `sandbox bundle directory ${relativePath}`);
      if (!sameStableDirectory(before, current)) throw new Error(`sandbox bundle directory changed during admission: ${relativePath}`);
      await mkdir(destinationPath, { mode: 0o700 });
      context.entries.push(Object.freeze({ type: "directory", path: relativePath, mode: DIRECTORY_MODE }));
      context.sourceDirectories.push(childIdentity);
      try {
        await copyDirectory(context, sourcePath, destinationPath, relativePath, depth + 1, childIdentity);
      } finally {
        context.sourceDirectories.pop();
      }
      await chmod(destinationPath, DIRECTORY_MODE);
      continue;
    }
    if (!before.isFile()) throw new Error(`sandbox bundle rejects sockets, devices, FIFOs, and special files: ${relativePath}`);
    if (before.nlink !== 1n) throw new Error(`sandbox bundle rejects hard-linked files: ${relativePath}`);
    await copyRegularFile(context, sourcePath, destinationPath, relativePath, before);
  }

  await context.hooks?.beforeDirectoryPostValidation?.(relativeDirectory || ".");
  throwIfCancelled(context.signal);
  await assertDirectoryIdentity(admitted, "sandbox bundle source directory");
  await assertDirectoryChain(context.sourceDirectories, "sandbox bundle source");
}

async function copyRegularFile(
  context: MaterializationContext,
  sourcePath: string,
  destinationPath: string,
  relativePath: string,
  before: BigIntStats
) {
  context.files += 1;
  if (context.files > context.limits.maxFiles) throw new Error(`sandbox bundle exceeds maximum file count ${context.limits.maxFiles}`);
  if (before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`sandbox bundle file size is unsupported: ${relativePath}`);
  const size = Number(before.size);
  if (size > context.limits.maxBytes - context.bytes) throw new Error(`sandbox bundle exceeds maximum byte count ${context.limits.maxBytes}`);
  const canonical = resolve(await realpath(sourcePath));
  if (canonical !== resolve(sourcePath)) throw new Error(`sandbox bundle rejects noncanonical file identity: ${relativePath}`);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const source = await open(sourcePath, flags);
  let destination;
  try {
    const opened = await source.stat({ bigint: true });
    await context.hooks?.afterFileOpen?.(relativePath);
    throwIfCancelled(context.signal);
    await assertDirectoryChain(context.sourceDirectories, "sandbox bundle source");
    if (!opened.isFile() || opened.nlink !== 1n || !sameStableFile(before, opened)) {
      throw new Error(`sandbox bundle file changed during secure open: ${relativePath}`);
    }
    if (process.platform === "linux") {
      const handlePath = resolve(await realpath(`/proc/self/fd/${source.fd}`));
      if (handlePath !== sourcePath || !contained(context.sourceRoot, handlePath)) {
        throw new Error(`sandbox bundle opened handle escaped source root: ${relativePath}`);
      }
    }

    const normalizedMode = Number(opened.mode & 0o111n) === 0 ? DATA_FILE_MODE : EXECUTABLE_FILE_MODE;
    destination = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      normalizedMode
    );
    const contentHash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let copied = 0;
    while (copied < size) {
      throwIfCancelled(context.signal);
      const requested = Math.min(buffer.byteLength, size - copied);
      const chunk = await source.read(buffer, 0, requested, null);
      if (chunk.bytesRead === 0) throw new Error(`sandbox bundle file shrank during copy: ${relativePath}`);
      contentHash.update(buffer.subarray(0, chunk.bytesRead));
      let written = 0;
      while (written < chunk.bytesRead) {
        const result = await destination.write(buffer, written, chunk.bytesRead - written, null);
        if (result.bytesWritten === 0) throw new Error(`sandbox bundle destination stopped accepting data: ${relativePath}`);
        written += result.bytesWritten;
      }
      copied += chunk.bytesRead;
    }
    await context.hooks?.beforeFilePostValidation?.(relativePath);
    throwIfCancelled(context.signal);
    const after = await source.stat({ bigint: true });
    const current = await lstat(sourcePath, { bigint: true });
    await assertDirectoryChain(context.sourceDirectories, "sandbox bundle source");
    if (
      !after.isFile()
      || after.nlink !== 1n
      || current.isSymbolicLink()
      || !current.isFile()
      || current.nlink !== 1n
      || !sameStableFile(opened, after)
      || !sameStableFile(opened, current)
    ) {
      throw new Error(`sandbox bundle file changed during copy: ${relativePath}`);
    }
    const currentCanonical = resolve(await realpath(sourcePath));
    if (currentCanonical !== sourcePath) throw new Error(`sandbox bundle file identity became noncanonical: ${relativePath}`);
    await destination.chmod(normalizedMode);
    await destination.sync();
    const destinationMetadata = await destination.stat({ bigint: true });
    if (!destinationMetadata.isFile() || destinationMetadata.nlink !== 1n || destinationMetadata.size !== BigInt(size)) {
      throw new Error(`sandbox bundle destination verification failed: ${relativePath}`);
    }
    context.bytes += size;
    context.entries.push(Object.freeze({
      type: "file",
      path: relativePath,
      mode: normalizedMode,
      size,
      contentDigest: contentHash.digest("hex")
    }));
  } finally {
    await destination?.close().catch(() => undefined);
    await source.close();
  }
}

async function scanSealedBundle(root: string, limits: MaterializationLimits, signal?: AbortSignal): Promise<BundleScan> {
  const physical = await requireAbsoluteRealDirectory(root, "sandbox bundle target");
  const rootIdentity = await captureDirectoryIdentity(physical, "sandbox bundle target");
  const rootMetadata = await lstat(physical, { bigint: true });
  if (permissionBits(rootMetadata) !== DIRECTORY_MODE) throw new Error("sandbox bundle target root has unsafe permissions");
  const entries: BundleEntry[] = [];
  let files = 0;
  let directories = 0;
  let bytes = 0;

  const walk = async (directoryPath: string, relativeDirectory: string, depth: number): Promise<void> => {
    throwIfCancelled(signal);
    if (depth > limits.maxDepth) throw new Error(`sandbox bundle exceeds maximum depth ${limits.maxDepth}`);
    const admitted = await captureDirectoryIdentity(directoryPath, "sandbox bundle target directory");
    if (permissionBits(await lstat(directoryPath, { bigint: true })) !== DIRECTORY_MODE) {
      throw new Error(`sandbox bundle target directory has unsafe permissions: ${relativeDirectory || "."}`);
    }
    const names: string[] = [];
    const directory = await opendir(directoryPath);
    try {
      for await (const entry of directory) {
        throwIfCancelled(signal);
        names.push(entry.name);
        if (names.length > limits.maxFiles + limits.maxDirectories) throw new Error("sandbox bundle exceeds bounded entry count");
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    names.sort(compareStrings);
    for (const name of names) {
      const entryPath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      assertSafeBundlePath(entryPath, limits.maxPathBytes);
      const absolute = join(directoryPath, name);
      const metadata = await lstat(absolute, { bigint: true });
      if (metadata.isSymbolicLink()) throw new Error(`sandbox bundle target contains a symbolic link or junction: ${entryPath}`);
      if (metadata.isDirectory()) {
        directories += 1;
        if (directories > limits.maxDirectories) throw new Error(`sandbox bundle exceeds maximum directory count ${limits.maxDirectories}`);
        if (permissionBits(metadata) !== DIRECTORY_MODE) throw new Error(`sandbox bundle target directory has unsafe permissions: ${entryPath}`);
        entries.push(Object.freeze({ type: "directory", path: entryPath, mode: DIRECTORY_MODE }));
        await walk(absolute, entryPath, depth + 1);
        continue;
      }
      if (!metadata.isFile()) throw new Error(`sandbox bundle target contains a special file: ${entryPath}`);
      if (metadata.nlink !== 1n) throw new Error(`sandbox bundle target contains a hard-linked file: ${entryPath}`);
      files += 1;
      if (files > limits.maxFiles) throw new Error(`sandbox bundle exceeds maximum file count ${limits.maxFiles}`);
      if (metadata.size < 0n || metadata.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`sandbox bundle target file size is unsupported: ${entryPath}`);
      const size = Number(metadata.size);
      if (size > limits.maxBytes - bytes) throw new Error(`sandbox bundle exceeds maximum byte count ${limits.maxBytes}`);
      const mode = permissionBits(metadata);
      if (mode !== DATA_FILE_MODE && mode !== EXECUTABLE_FILE_MODE) throw new Error(`sandbox bundle target file has unsafe permissions: ${entryPath}`);
      const contentDigest = await digestVerifiedFile(physical, absolute, metadata, entryPath, signal);
      bytes += size;
      entries.push(Object.freeze({ type: "file", path: entryPath, mode, size, contentDigest }));
    }
    await assertDirectoryIdentity(admitted, "sandbox bundle target directory");
  };

  await walk(physical, "", 0);
  return Object.freeze({ ...summarizeEntries(entries, files, bytes), rootIdentity });
}

async function syncSealedTree(root: string, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  const names: string[] = [];
  const directory = await opendir(root);
  try {
    for await (const entry of directory) names.push(entry.name);
  } finally {
    await directory.close().catch(() => undefined);
  }
  names.sort(compareStrings);
  for (const name of names) {
    throwIfCancelled(signal);
    const path = join(root, name);
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink()) throw new Error("sandbox bundle changed to a link before durability sync");
    if (metadata.isDirectory()) {
      await syncSealedTree(path, signal);
      continue;
    }
    if (!metadata.isFile() || metadata.nlink !== 1n) throw new Error("sandbox bundle changed to an unsafe file before durability sync");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameStableFile(metadata, opened)) throw new Error("sandbox bundle file changed before durability sync");
      await handle.sync();
      const after = await handle.stat({ bigint: true });
      if (!sameStableFile(opened, after)) throw new Error("sandbox bundle file changed during durability sync");
    } finally {
      await handle.close();
    }
  }
  await syncDirectory(root);
}

async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isDirectory()) throw new Error("sandbox bundle durability target is not a directory");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function digestVerifiedFile(root: string, path: string, before: BigIntStats, relativePath: string, signal?: AbortSignal) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameStableFile(before, opened)) {
      throw new Error(`sandbox bundle target file changed during secure open: ${relativePath}`);
    }
    if (process.platform === "linux") {
      const handlePath = resolve(await realpath(`/proc/self/fd/${handle.fd}`));
      if (handlePath !== path || !contained(root, handlePath)) throw new Error(`sandbox bundle target handle escaped its root: ${relativePath}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let total = 0;
    while (total < Number(opened.size)) {
      throwIfCancelled(signal);
      const result = await handle.read(buffer, 0, Math.min(buffer.byteLength, Number(opened.size) - total), null);
      if (result.bytesRead === 0) throw new Error(`sandbox bundle target file shrank during verification: ${relativePath}`);
      hash.update(buffer.subarray(0, result.bytesRead));
      total += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!sameStableFile(opened, after) || !sameStableFile(opened, current) || current.nlink !== 1n) {
      throw new Error(`sandbox bundle target file changed during verification: ${relativePath}`);
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function summarizeEntries(entries: readonly BundleEntry[], files: number, bytes: number): BundleScan {
  const ordered = [...entries].sort((left, right) => compareStrings(left.path, right.path) || compareStrings(left.type, right.type));
  const hash = createHash("sha256").update(BUNDLE_FORMAT, "utf8");
  for (const entry of ordered) {
    if (entry.type === "directory") hash.update(`D\0${entry.path}\0${entry.mode.toString(8)}\n`, "utf8");
    else hash.update(`F\0${entry.path}\0${entry.mode.toString(8)}\0${entry.size}\0${entry.contentDigest}\n`, "utf8");
  }
  return Object.freeze({ digest: hash.digest("hex"), files, bytes, entries: Object.freeze(ordered) });
}

function assertMatchingBundle(actual: BundleScan, expected: BundleScan, label: string) {
  if (actual.digest !== expected.digest || actual.files !== expected.files || actual.bytes !== expected.bytes) throw new Error(label);
}

function frozenReference(bundle: BundleScan, path: string): SandboxBundleReference {
  return Object.freeze({ digest: bundle.digest, path, files: bundle.files, bytes: bundle.bytes });
}

async function prepareBundleStore(stateRootInput: string) {
  const stateRoot = resolveStateRootInput(stateRootInput);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await repairOwnerOnlyDirectory(stateRoot, "sandbox bundle state root");
  const bundlesRoot = join(stateRoot, "bundles");
  const digestRoot = join(bundlesRoot, "sha256");
  await mkdir(bundlesRoot, { recursive: true, mode: 0o700 });
  await repairOwnerOnlyDirectory(bundlesRoot, "sandbox bundle store");
  await mkdir(digestRoot, { recursive: true, mode: 0o700 });
  await repairOwnerOnlyDirectory(digestRoot, "sandbox bundle digest store");
  await syncDirectory(digestRoot);
  await syncDirectory(bundlesRoot);
  await syncDirectory(stateRoot);
  return { stateRoot, bundlesRoot, digestRoot };
}

function resolveStateRootInput(input: string) {
  if (typeof input !== "string" || !input || input.includes("\0")) throw new Error("sandbox bundle state root is required");
  return resolve(input);
}

async function repairOwnerOnlyDirectory(path: string, label: string) {
  const physical = await requireAbsoluteRealDirectory(path, label);
  const before = await lstat(physical, { bigint: true });
  const handle = await open(physical, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !sameIdentity(before, opened)) throw new Error(`${label} changed during secure open`);
    if (process.platform === "linux" && resolve(await realpath(`/proc/self/fd/${handle.fd}`)) !== physical) {
      throw new Error(`${label} opened handle escaped its canonical path`);
    }
    await handle.chmod(0o700);
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(physical, { bigint: true });
    if (
      !after.isDirectory()
      || permissionBits(after) !== 0o700
      || !sameIdentity(opened, after)
      || !sameIdentity(opened, current)
      || current.isSymbolicLink()
      || !current.isDirectory()
    ) throw new Error(`${label} changed while repairing owner-only permissions`);
  } finally {
    await handle.close();
  }
}

async function requireAbsoluteRealDirectory(input: string, label: string) {
  if (typeof input !== "string" || !isAbsolute(input) || input.includes("\0")) throw new Error(`${label} must be an absolute path`);
  const lexical = resolve(input);
  const metadata = await lstat(lexical, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${label} must be a real directory, not a symbolic link or junction`);
  stableIdentity(metadata, label);
  const canonical = resolve(await realpath(lexical));
  if (canonical !== lexical) throw new Error(`${label} must use its canonical real path`);
  const current = await lstat(canonical, { bigint: true });
  if (!sameIdentity(metadata, current) || current.isSymbolicLink() || !current.isDirectory()) throw new Error(`${label} changed during canonicalization`);
  return canonical;
}

async function captureDirectoryChain(paths: readonly string[], label: string) {
  const identities: DirectoryIdentity[] = [];
  for (const path of paths) identities.push(await captureDirectoryIdentity(path, label));
  return identities;
}

async function captureDirectoryIdentity(path: string, label: string): Promise<DirectoryIdentity> {
  const metadata = await lstat(path, { bigint: true });
  return directoryIdentity(path, metadata, label);
}

function directoryIdentity(path: string, metadata: BigIntStats, label: string): DirectoryIdentity {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${label} must remain a real directory`);
  const value = stableIdentity(metadata, label);
  return Object.freeze({ path, ...value, mode: metadata.mode, mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs });
}

async function assertDirectoryChain(identities: readonly DirectoryIdentity[], label: string) {
  for (const expected of identities) await assertDirectoryIdentity(expected, label);
}

async function assertDirectoryChainIdentityOnly(identities: readonly DirectoryIdentity[], label: string) {
  for (const expected of identities) {
    const current = await lstat(expected.path, { bigint: true });
    if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(expected, current) || current.mode !== expected.mode) {
      throw new Error(`${label} changed during materialization`);
    }
    if (resolve(await realpath(expected.path)) !== expected.path) throw new Error(`${label} identity became noncanonical`);
  }
}

async function assertScannedRootIdentity(bundle: BundleScan, label: string) {
  if (!bundle.rootIdentity) throw new Error(`${label}: verification identity is unavailable`);
  await assertDirectoryIdentity(bundle.rootIdentity, label);
}

async function assertDirectoryIdentity(expected: DirectoryIdentity, label: string) {
  const current = await lstat(expected.path, { bigint: true });
  if (
    current.isSymbolicLink()
    || !current.isDirectory()
    || !sameIdentity(expected, current)
    || current.mode !== expected.mode
    || current.mtimeNs !== expected.mtimeNs
    || current.ctimeNs !== expected.ctimeNs
  ) throw new Error(`${label} changed during materialization`);
  const canonical = resolve(await realpath(expected.path));
  if (canonical !== expected.path) throw new Error(`${label} identity became noncanonical`);
}

function stableIdentity(metadata: BigIntStats, label: string): Identity {
  if (metadata.dev === 0n || metadata.ino === 0n) throw new Error(`${label} has no stable filesystem identity on this platform`);
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

function sameIdentity(left: Pick<BigIntStats, "dev" | "ino"> | Identity, right: Pick<BigIntStats, "dev" | "ino"> | Identity) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: BigIntStats, right: BigIntStats) {
  return sameIdentity(left, right)
    && left.isFile()
    && right.isFile()
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameStableDirectory(left: BigIntStats, right: BigIntStats) {
  return sameIdentity(left, right)
    && left.isDirectory()
    && right.isDirectory()
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function permissionBits(metadata: BigIntStats) {
  return Number(metadata.mode & 0o777n);
}

function assertSafeBundlePath(path: string, maximumBytes: number) {
  if (!path || Buffer.byteLength(path, "utf8") > maximumBytes || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new Error(`sandbox bundle path is empty, contains controls, or exceeds ${maximumBytes} bytes`);
  }
  if (isAbsolute(path) || win32.isAbsolute(path) || path.includes("\\") || path.startsWith("//")) {
    throw new Error(`sandbox bundle path is not portable: ${path}`);
  }
  const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
  for (const component of path.split("/")) {
    if (!component || component === "." || component === ".." || component.includes(":") || /[ .]$/u.test(component) || reserved.test(component)) {
      throw new Error(`sandbox bundle path is not portable: ${path}`);
    }
  }
}

function normalizeLimits(options: SandboxBundleOptions): MaterializationLimits {
  const maxFiles = boundedInteger(options.maxFiles, 1, HARD_MAX_FILES, DEFAULT_MAX_FILES, "maxFiles");
  return Object.freeze({
    maxFiles,
    maxDepth: boundedInteger(options.maxDepth, 0, HARD_MAX_DEPTH, DEFAULT_MAX_DEPTH, "maxDepth"),
    maxBytes: boundedInteger(options.maxBytes, 1, HARD_MAX_BYTES, DEFAULT_MAX_BYTES, "maxBytes"),
    maxPathBytes: boundedInteger(options.maxPathBytes, 1, HARD_MAX_PATH_BYTES, DEFAULT_MAX_PATH_BYTES, "maxPathBytes"),
    maxDirectories: maxFiles
  });
}

function boundedInteger(value: number | undefined, minimum: number, maximum: number, fallback: number, label: string) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`sandbox bundle ${label} must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("sandbox bundle materialization cancelled");
  error.name = "AbortError";
  throw error;
}

function contained(root: string, target: string) {
  const value = relative(root, target);
  return value === "" || value !== ".." && !value.startsWith(`..${sep}`);
}

function overlaps(left: string, right: string) {
  return contained(left, right) || contained(right, left);
}

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isPublishCollision(error: unknown) {
  return ["EEXIST", "ENOTEMPTY"].includes(String((error as NodeJS.ErrnoException | undefined)?.code ?? ""));
}

async function removeStagingTree(path: string) {
  if (!await pathExists(path)) return;
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    await unlink(path);
    return;
  }
  const admitted = directoryIdentity(path, metadata, "sandbox bundle staging cleanup");
  await makeTreeOwnerWritable(path).catch(() => undefined);
  const current = await lstat(path, { bigint: true });
  if (!sameIdentity(admitted, current) || current.isSymbolicLink() || !current.isDirectory()) {
    throw new Error("sandbox bundle staging path changed during cleanup");
  }
  await rm(path, { recursive: true, force: true });
}

async function makeTreeOwnerWritable(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    const directory = await opendir(path);
    try {
      for await (const entry of directory) await makeTreeOwnerWritable(join(path, entry.name));
    } finally {
      await directory.close().catch(() => undefined);
    }
  } else if (metadata.isFile()) await chmod(path, 0o600);
}
