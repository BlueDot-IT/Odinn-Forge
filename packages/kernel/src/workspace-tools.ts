import { constants, type BigIntStats, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { kill as killProcess } from "node:process";
import { ProcessRecoveryError, createProcessExecutionDescriptor, type ProcessExecutionSession, type ProcessSupervisor } from "./process-supervisor.ts";

const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_OUTPUT_BYTES = 128_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;
const DEFAULT_MAX_DEPTH = 8;
const MAX_DEPTH = 32;
const DEFAULT_MAX_FILES = 10_000;
const MAX_FILES = 100_000;
const DEFAULT_INSPECTION_BYTES = 4 * 1024 * 1024;
const MAX_INSPECTION_BYTES = 8 * 1024 * 1024;
const MAX_IGNORE_FILE_BYTES = 256 * 1024;
const MAX_IGNORE_PATTERNS = 4_096;
const MAX_PATTERN_BYTES = 1_024;
const MAX_SEARCH_LINES = 100_000;
const MAX_DIFF_LINES = 100_000;
const DEFAULT_IGNORE_FILES = [".gitignore", ".odinnignore"];
const DEFAULT_SENSITIVE_PATTERNS = [
  ".env", ".env.*", "**/.env", "**/.env.*", "**/*.key", "**/*.pem", "**/.ssh/**", ".git/**", ".odinn/**"
];

type FileIdentity = { dev: bigint; ino: bigint };
type AncestorIdentity = FileIdentity & { path: string };
type WorkspaceSecurity = { deniedPatterns?: unknown; ignoreFiles?: unknown };
type ResolverOptions = { allowRoot?: boolean; expected?: "file" | "directory" | "either"; security?: WorkspaceSecurity };
type ResolvedWorkspacePath = {
  root: string;
  target: string;
  path: string;
  metadata: BigIntStats;
  identity: FileIdentity;
  ancestors: AncestorIdentity[];
};

export type WorkspaceInspectionContext = {
  signal?: AbortSignal;
  security?: WorkspaceSecurity;
  /** Deterministic race-test hooks. Production callers must not supply these. */
  hooks?: {
    afterResolve?: () => void | Promise<void>;
    beforeOpen?: () => void | Promise<void>;
    afterOpen?: () => void | Promise<void>;
    beforePostValidation?: () => void | Promise<void>;
    beforeDirectoryPostValidation?: (path: string) => void | Promise<void>;
    beforeDirectoryRecurse?: (path: string) => void | Promise<void>;
  };
};

function contained(root: string, target: string) {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function canonicalEqual(left: string, right: string) {
  return resolve(left) === resolve(right);
}

function identity(metadata: BigIntStats): FileIdentity {
  if (metadata.dev === 0n || metadata.ino === 0n) throw new Error("workspace inspection cannot establish a stable filesystem identity on this platform");
  return { dev: metadata.dev, ino: metadata.ino };
}

function normalizedPath(root: string, target: string) {
  return relative(root, target).replaceAll("\\", "/") || ".";
}

async function physicalWorkspaceRoot(workspaceRoot: string) {
  const lexical = resolve(workspaceRoot);
  const metadata = await lstat(lexical, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("workspace root must be a real directory, not a symbolic link or junction");
  const physical = resolve(await realpath(lexical));
  const canonical = await lstat(physical, { bigint: true });
  if (canonical.isSymbolicLink() || !canonical.isDirectory()) throw new Error("workspace root canonical identity is not a real directory");
  identity(canonical);
  return physical;
}

async function captureAncestors(root: string, target: string, label: string) {
  const identities: AncestorIdentity[] = [];
  let cursor = root;
  const components = normalizedPath(root, target) === "." ? [] : normalizedPath(root, target).split("/").slice(0, -1);
  for (const component of ["", ...components]) {
    if (component) cursor = resolve(cursor, component);
    const metadata = await lstat(cursor, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${label} path escapes workspace root through a symbolic link, junction, or non-directory ancestor`);
    identities.push({ path: cursor, ...identity(metadata) });
  }
  return identities;
}

async function assertAncestors(identities: readonly AncestorIdentity[], label: string) {
  for (const expected of identities) {
    const actual = await lstat(expected.path, { bigint: true });
    if (actual.isSymbolicLink() || !actual.isDirectory() || !sameIdentity(identity(actual), expected)) {
      throw new Error(`${label} confinement ancestor changed during inspection`);
    }
  }
}

function sameIdentity(metadata: FileIdentity, expected: FileIdentity) {
  return metadata.dev === expected.dev && metadata.ino === expected.ino;
}

function assertNotSensitive(path: string, security: WorkspaceSecurity | undefined, label: string) {
  const patterns = stringArray(security?.deniedPatterns, DEFAULT_SENSITIVE_PATTERNS, 128, "workspace deniedPatterns");
  if (patterns.some((pattern) => globMatches(path, pattern))) throw new Error(`${label} denied by workspace sensitive-file policy`);
}

export async function resolveWorkspacePath(workspaceRoot: string, candidate: unknown, label: string, options: ResolverOptions = {}): Promise<ResolvedWorkspacePath> {
  if (typeof candidate !== "string" || !candidate.trim() || candidate.includes("\0") || Buffer.byteLength(candidate, "utf8") > 4_096) throw new Error(`${label} requires a bounded non-empty path`);
  assertPortableRelativePath(candidate, label);
  const root = await physicalWorkspaceRoot(workspaceRoot);
  const lexical = resolve(root, candidate);
  if ((!options.allowRoot && lexical === root) || !contained(root, lexical)) throw new Error(`${label} path escapes workspace root`);
  const path = normalizedPath(root, lexical);
  assertNotSensitive(path, options.security, label);
  const ancestors = await captureAncestors(root, lexical, label);
  const metadata = await lstat(lexical, { bigint: true });
  const admittedIdentity = identity(metadata);
  if (metadata.isSymbolicLink()) throw new Error(`${label} target must not be a symbolic link or junction`);
  if (metadata.isFile() && metadata.nlink > 1) throw new Error(`${label} target must not be a hard-linked file`);
  const target = resolve(await realpath(lexical));
  if (!contained(root, target) || !canonicalEqual(target, lexical)) throw new Error(`${label} path escapes workspace root through a symbolic link or junction`);
  const canonicalMetadata = await lstat(target, { bigint: true });
  if (canonicalMetadata.isSymbolicLink() || !sameIdentity(identity(canonicalMetadata), admittedIdentity)) throw new Error(`${label} target changed during canonicalization`);
  assertNotSensitive(normalizedPath(root, target), options.security, label);
  if (options.expected === "file" && !metadata.isFile()) throw new Error(`${label} target must be a regular file`);
  if (options.expected === "directory" && !metadata.isDirectory()) throw new Error(`${label} target must be a directory`);
  if (options.expected === "either" && !metadata.isFile() && !metadata.isDirectory()) throw new Error(`${label} target must be a regular file or directory`);
  await assertAncestors(ancestors, label);
  return { root, target, path, metadata, identity: admittedIdentity, ancestors };
}

async function secureRead(resolved: ResolvedWorkspacePath, maxBytes: number, label: string, signal?: AbortSignal, hooks?: WorkspaceInspectionContext["hooks"]) {
  throwIfCancelled(signal, label);
  await hooks?.afterResolve?.();
  throwIfCancelled(signal, label);
  const before = await lstat(resolved.target, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1n || !sameIdentity(identity(before), resolved.identity)) throw new Error(`${label} target changed during admission`);
  await hooks?.beforeOpen?.();
  throwIfCancelled(signal, label);
  const handle = await open(resolved.target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    await hooks?.afterOpen?.();
    throwIfCancelled(signal, label);
    await assertAncestors(resolved.ancestors, label);
    if (!opened.isFile() || opened.nlink > 1n || !sameIdentity(identity(opened), resolved.identity)) throw new Error(`${label} target changed during secure open`);
    if (process.platform === "linux") {
      const handlePath = resolve(await realpath(`/proc/self/fd/${handle.fd}`));
      if (handlePath !== resolved.target || !contained(resolved.root, handlePath)) throw new Error(`${label} opened handle escaped workspace root`);
    }
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      throwIfCancelled(signal, label);
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    await hooks?.beforePostValidation?.();
    throwIfCancelled(signal, label);
    const after = await handle.stat({ bigint: true });
    await assertAncestors(resolved.ancestors, label);
    const current = await lstat(resolved.target, { bigint: true });
    const stableContent = after.size === opened.size && after.mtimeNs === opened.mtimeNs && after.ctimeNs === opened.ctimeNs
      && opened.size === before.size && opened.mtimeNs === before.mtimeNs && opened.ctimeNs === before.ctimeNs;
    if (!sameIdentity(identity(after), resolved.identity) || !sameIdentity(identity(current), resolved.identity) || current.isSymbolicLink() || current.nlink > 1n || !stableContent) {
      throw new Error(`${label} target changed during secure read`);
    }
    const retained = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    return {
      bytes: retained,
      bytesRead,
      totalBytes: Number(opened.size),
      truncated: bytesRead > maxBytes || opened.size > BigInt(maxBytes),
      digest: `sha256:${createHash("sha256").update(retained).digest("hex")}`,
      digestComplete: opened.size <= BigInt(maxBytes),
      metadata: after
    };
  } finally {
    await handle.close();
  }
}

export async function workspaceRead(workspaceRoot: string, input: any = {}, context: WorkspaceInspectionContext = {}) {
  const label = "workspace.read";
  throwIfCancelled(context.signal, label);
  const limit = strictBoundedInteger(input.maxBytes, 1, MAX_INSPECTION_BYTES, 65_536, `${label} maxBytes`);
  const resolved = await resolveWorkspacePath(workspaceRoot, input.path, label, { expected: "file", security: context.security });
  const result = await secureRead(resolved, limit, label, context.signal, context.hooks);
  const binary = isBinary(result.bytes, result.truncated);
  return {
    path: resolved.path,
    resolvedPath: resolved.path,
    type: binary ? "binary" : "text",
    binary,
    bytes: result.totalBytes,
    bytesRead: result.bytesRead,
    truncated: result.truncated,
    digest: result.digest,
    digestComplete: result.digestComplete,
    content: binary ? null : decodeUtf8Prefix(result.bytes, result.truncated, label)
  };
}

export async function readWorkspaceText(workspaceRoot: string, input: any = {}, context: WorkspaceInspectionContext = {}) {
  const label = "workspace.readText";
  throwIfCancelled(context.signal, label);
  if (input.maxBytes !== undefined && (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > MAX_INSPECTION_BYTES)) {
    throw new Error(`${label} maxBytes must be a positive safe integer no greater than ${MAX_INSPECTION_BYTES}`);
  }
  const limit = input.maxBytes ?? 65_536;
  const resolved = await resolveWorkspacePath(workspaceRoot, input.path, label, { expected: "file", security: context.security });
  const result = await secureRead(resolved, limit, label, context.signal, context.hooks);
  return { path: resolved.path, content: decodeUtf8Prefix(result.bytes, result.truncated, label), bytesRead: result.bytesRead, truncated: result.truncated, digest: result.digest };
}

export async function workspaceStat(workspaceRoot: string, input: any = {}, context: WorkspaceInspectionContext = {}) {
  const label = "workspace.stat";
  throwIfCancelled(context.signal, label);
  const resolved = await resolveWorkspacePath(workspaceRoot, input.path ?? ".", label, { allowRoot: true, expected: "either", security: context.security });
  let digest: string | null = null;
  let digestComplete = false;
  let binary: boolean | null = null;
  let metadata = resolved.metadata;
  if (resolved.metadata.isFile()) {
    const maxBytes = strictBoundedInteger(input.maxBytes, 1, MAX_INSPECTION_BYTES, DEFAULT_INSPECTION_BYTES, `${label} maxBytes`);
    const read = await secureRead(resolved, maxBytes, label, context.signal, context.hooks);
    digest = read.digest;
    digestComplete = read.digestComplete;
    binary = isBinary(read.bytes, read.truncated);
    metadata = read.metadata;
  } else {
    await context.hooks?.beforeDirectoryPostValidation?.(resolved.path);
    await assertAncestors(resolved.ancestors, label);
    const current = await lstat(resolved.target, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(identity(current), resolved.identity)) throw new Error(`${label} target changed before metadata return`);
    metadata = current;
  }
  return metadataResult({ ...resolved, metadata }, { digest, digestComplete, binary });
}

export async function workspaceList(workspaceRoot: string, input: any = {}, context: WorkspaceInspectionContext = {}) {
  const label = "workspace.list";
  throwIfCancelled(context.signal, label);
  const start = await resolveWorkspacePath(workspaceRoot, input.path ?? ".", label, { allowRoot: true, expected: "directory", security: context.security });
  const bounds = traversalBounds(input, label);
  const ignores = await loadIgnoreRules(start.root, start.target, input.ignoreFiles, context);
  const fingerprint = cursorFingerprint(label, `${start.identity.dev}:${start.identity.ino}`, start.path, {
    recursive: input.recursive === true, ...bounds, ignoreDigest: ignores.digest, sensitiveDigest: sensitivePolicyDigest(context.security)
  });
  const after = decodeCursor(input.cursor, label, fingerprint);
  const entries: any[] = [];
  let visited = 0;
  let omittedSensitive = 0;
  let hasMore = false;
  for await (const item of traverse(start, { ...bounds, recursive: input.recursive === true, ignores, after, signal: context.signal, security: context.security, hooks: context.hooks, label })) {
    visited += 1;
    if (item.sensitive) { omittedSensitive += 1; continue; }
    if (after && compareTraversalPaths(item.path, after) <= 0) continue;
    if (entries.length >= bounds.limit) { hasMore = true; break; }
    entries.push(item);
  }
  let response: any;
  do {
    const nextCursor = hasMore && entries.length ? encodeCursor(label, fingerprint, entries.at(-1)!.path) : null;
    response = withResultBytes({ path: start.path, resolvedPath: start.path, entries, nextCursor, visited, omittedSensitive, limits: bounds });
    if (response.resultBytes <= bounds.maxBytes) break;
    if (entries.length <= 1) throw new Error(`${label} entry metadata exceeds maxBytes result ceiling`);
    entries.pop();
    hasMore = true;
  } while (true);
  return response;
}

export async function workspaceSearch(workspaceRoot: string, input: any = {}, context: WorkspaceInspectionContext = {}) {
  const label = "workspace.search";
  throwIfCancelled(context.signal, label);
  if (typeof input.query !== "string" || !input.query || input.query.length > 1_024 || input.query.includes("\0")) throw new Error(`${label} requires a query of at most 1024 characters`);
  const start = await resolveWorkspacePath(workspaceRoot, input.path ?? ".", label, { allowRoot: true, expected: "directory", security: context.security });
  const bounds = traversalBounds(input, label);
  const caseSensitive = input.caseSensitive === true;
  const needle = caseSensitive ? input.query : input.query.toLocaleLowerCase("en-US");
  const ignores = await loadIgnoreRules(start.root, start.target, input.ignoreFiles, context);
  const fingerprint = cursorFingerprint(label, `${start.identity.dev}:${start.identity.ino}`, start.path, {
    query: input.query, caseSensitive, ...bounds, ignoreDigest: ignores.digest, sensitiveDigest: sensitivePolicyDigest(context.security)
  });
  const after = decodeCursor(input.cursor, label, fingerprint);
  const matches: any[] = [];
  let searchedFiles = 0;
  let searchedBytes = 0;
  let hasMore = false;
  let resumeAfter: string | undefined;
  for await (const item of traverse(start, { ...bounds, recursive: true, ignores, after, signal: context.signal, security: context.security, hooks: context.hooks, label })) {
    if (item.sensitive || item.type !== "file") continue;
    if (after && compareTraversalPaths(item.path, after) <= 0) continue;
    const remaining = bounds.maxBytes - searchedBytes;
    if (remaining <= 0) { hasMore = true; break; }
    const resolved = await resolveWorkspacePath(start.root, item.path, label, { expected: "file", security: context.security });
    const read = await secureRead(resolved, Math.min(remaining, DEFAULT_MAX_FILE_BYTES), label, context.signal, context.hooks);
    searchedFiles += 1;
    searchedBytes += read.bytes.length;
    if (isBinary(read.bytes, read.truncated)) { resumeAfter = item.path; continue; }
    const content = decodeUtf8Prefix(read.bytes, read.truncated, label);
    const lineMatches = [];
    let scannedLines = 0;
    for (const line of iterateLines(content)) {
      throwIfCancelled(context.signal, label);
      scannedLines += 1;
      if (scannedLines > MAX_SEARCH_LINES) throw new Error(`${label} exceeded per-file line traversal ceiling`);
      const haystack = caseSensitive ? line.text : line.text.toLocaleLowerCase("en-US");
      if (haystack.includes(needle)) lineMatches.push({ line: line.number, text: truncateUtf8(line.text, 2_048) });
      if (lineMatches.length >= 100) break;
    }
    if (lineMatches.length) {
      if (matches.length >= bounds.limit) { hasMore = true; break; }
      matches.push({ path: item.path, resolvedPath: item.path, digest: read.digest, digestComplete: read.digestComplete, truncated: read.truncated, matches: lineMatches });
    }
    resumeAfter = item.path;
  }
  let response: any;
  do {
    const nextCursor = hasMore && resumeAfter ? encodeCursor(label, fingerprint, resumeAfter) : null;
    response = withResultBytes({ path: start.path, resolvedPath: start.path, query: input.query, matches, nextCursor, searchedFiles, searchedBytes, limits: bounds });
    if (response.resultBytes <= bounds.maxBytes) break;
    if (matches.length <= 1) throw new Error(`${label} match metadata exceeds maxBytes result ceiling`);
    matches.pop();
    resumeAfter = matches.at(-1)!.path;
    hasMore = true;
  } while (true);
  return response;
}

export async function workspaceDiff(workspaceRoot: string, input: any = {}, context: WorkspaceInspectionContext = {}) {
  const label = "workspace.diff";
  throwIfCancelled(context.signal, label);
  if (input.basePath !== undefined && input.before !== undefined) throw new Error(`${label} accepts either basePath or before, not both`);
  if (input.beforePath !== undefined && input.before === undefined) throw new Error(`${label} beforePath requires before`);
  const maxBytes = strictBoundedInteger(input.maxBytes, 1, MAX_INSPECTION_BYTES, 256 * 1024, `${label} maxBytes`);
  const current = await resolveWorkspacePath(workspaceRoot, input.path, label, { expected: "file", security: context.security });
  const currentRead = await secureRead(current, maxBytes, label, context.signal, context.hooks);
  if (isBinary(currentRead.bytes, currentRead.truncated)) throw new Error(`${label} does not render binary files`);
  let beforePath = "/dev/null";
  let beforeContent = "";
  let beforeDigest: string | null = null;
  if (input.basePath !== undefined) {
    const base = await resolveWorkspacePath(workspaceRoot, input.basePath, label, { expected: "file", security: context.security });
    const baseRead = await secureRead(base, maxBytes, label, context.signal, context.hooks);
    if (isBinary(baseRead.bytes, baseRead.truncated)) throw new Error(`${label} does not render binary files`);
    beforePath = base.path;
    beforeContent = decodeUtf8Prefix(baseRead.bytes, baseRead.truncated, label);
    beforeDigest = baseRead.digest;
  } else if (input.before !== undefined) {
    if (typeof input.before !== "string" || Buffer.byteLength(input.before, "utf8") > maxBytes) throw new Error(`${label} before must be UTF-8 text within maxBytes`);
    beforePath = input.beforePath === undefined ? "/provided" : cleanDisplayPath(input.beforePath, label);
    beforeContent = input.before;
    beforeDigest = `sha256:${createHash("sha256").update(input.before).digest("hex")}`;
  }
  const currentContent = decodeUtf8Prefix(currentRead.bytes, currentRead.truncated, label);
  const rendered = unifiedDiff(beforeContent, currentContent, beforePath, current.path, maxBytes, context.signal);
  return {
    path: current.path,
    resolvedPath: current.path,
    basePath: beforePath,
    beforeDigest,
    digest: currentRead.digest,
    digestComplete: currentRead.digestComplete,
    diffDigest: `sha256:${createHash("sha256").update(rendered.diff).digest("hex")}`,
    diff: rendered.diff,
    truncated: rendered.truncated
  };
}

type TraverseOptions = ReturnType<typeof traversalBounds> & {
  recursive: boolean;
  ignores: Awaited<ReturnType<typeof loadIgnoreRules>>;
  after?: string;
  signal?: AbortSignal;
  security?: WorkspaceSecurity;
  hooks?: WorkspaceInspectionContext["hooks"];
  label: string;
};

async function* traverse(start: ResolvedWorkspacePath, options: TraverseOptions): AsyncGenerator<any> {
  let visited = 0;
  const walk = async function* (directory: string, depth: number, expectedIdentity: FileIdentity, ancestors: readonly AncestorIdentity[]): AsyncGenerator<any> {
    throwIfCancelled(options.signal, options.label);
    await assertAncestors(ancestors, options.label);
    const before = await lstat(directory, { bigint: true });
    const beforeIdentity = identity(before);
    if (before.isSymbolicLink() || !before.isDirectory() || !sameIdentity(beforeIdentity, expectedIdentity)) throw new Error(`${options.label} traversal directory changed`);
    const entries: Dirent[] = [];
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) {
        throwIfCancelled(options.signal, options.label);
        entries.push(entry);
        if (visited + entries.length > options.maxFiles) throw new Error(`${options.label} exceeded maxFiles traversal ceiling`);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    entries.sort((left, right) => comparePaths(left.name, right.name));
    // Snapshot eligible entries first, then revalidate each identity immediately
    // before emission or recursion. Keeping these phases separate detects
    // replacements that occur after directory enumeration.
    const validated: any[] = [];
    for (const entry of entries) {
      throwIfCancelled(options.signal, options.label);
      visited += 1;
      const target = resolve(directory, entry.name);
      const path = normalizedPath(start.root, target);
      if (options.after && compareTraversalPaths(path, options.after) <= 0 && !(entry.isDirectory() && (options.after === path || options.after.startsWith(`${path}/`)))) continue;
      if (options.ignores.matches(path, entry.isDirectory())) continue;
      const sensitive = sensitivePath(path, options.security);
      const metadata = await lstat(target, { bigint: true });
      if (metadata.isSymbolicLink() || isLinkLike(entry, metadata)) continue;
      if (metadata.isFile() && metadata.nlink > 1n) continue;
      const itemIdentity = identity(metadata);
      const type = metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "other";
      validated.push({ path, resolvedPath: path, type, bytes: Number(metadata.size), modifiedAt: new Date(Number(metadata.mtimeMs)).toISOString(), sensitive, target, identity: itemIdentity });
    }
    await options.hooks?.beforeDirectoryPostValidation?.(normalizedPath(start.root, directory));
    throwIfCancelled(options.signal, options.label);
    await assertAncestors(ancestors, options.label);
    const after = await lstat(directory, { bigint: true });
    if (!sameIdentity(identity(after), beforeIdentity) || after.isSymbolicLink() || !after.isDirectory()) throw new Error(`${options.label} traversal directory changed during enumeration`);
    for (const item of validated) {
      throwIfCancelled(options.signal, options.label);
      await assertAncestors(ancestors, options.label);
      const currentDirectory = await lstat(directory, { bigint: true });
      if (currentDirectory.isSymbolicLink() || !currentDirectory.isDirectory() || !sameIdentity(identity(currentDirectory), beforeIdentity)) throw new Error(`${options.label} traversal directory changed before emission`);
      const current = await lstat(item.target, { bigint: true });
      if (current.isSymbolicLink() || !sameIdentity(identity(current), item.identity) || current.isFile() && current.nlink > 1n) {
        throw new Error(`${options.label} traversal entry changed before emission`);
      }
      const { target: _target, identity: _identity, ...result } = item;
      yield result;
      if (!item.sensitive && options.recursive && current.isDirectory() && depth < options.maxDepth) {
        await options.hooks?.beforeDirectoryRecurse?.(item.path);
        throwIfCancelled(options.signal, options.label);
        const recurseTarget = await lstat(item.target, { bigint: true });
        if (recurseTarget.isSymbolicLink() || !recurseTarget.isDirectory() || !sameIdentity(identity(recurseTarget), item.identity)) throw new Error(`${options.label} traversal directory changed before recursion`);
        yield* walk(item.target, depth + 1, item.identity, [...ancestors, { path: directory, ...beforeIdentity }]);
      }
    }
  };
  yield* walk(start.target, 0, start.identity, start.ancestors);
}

function isLinkLike(entry: Dirent, metadata: BigIntStats) {
  return entry.isSymbolicLink() || metadata.isSymbolicLink();
}

async function loadIgnoreRules(root: string, start: string, configured: unknown, context: WorkspaceInspectionContext) {
  throwIfCancelled(context.signal, "workspace ignore file");
  const names = stringArray(configured ?? context.security?.ignoreFiles, DEFAULT_IGNORE_FILES, 16, "workspace ignoreFiles");
  const patterns: string[] = [];
  const sources: string[] = [];
  for (const name of names) {
    if (name.includes("/") || name.includes("\\") || name === "." || name === "..") throw new Error("workspace ignoreFiles entries must be file names");
    const candidates = start === root ? [resolve(root, name)] : [resolve(root, name), resolve(start, name)];
    for (const candidate of [...new Set(candidates)]) {
      throwIfCancelled(context.signal, "workspace ignore file");
      let metadata: BigIntStats;
      try { metadata = await lstat(candidate, { bigint: true }); } catch (error: any) { if (error?.code === "ENOENT") continue; throw error; }
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink > 1n || metadata.size > BigInt(MAX_IGNORE_FILE_BYTES)) throw new Error(`workspace ignore file is unsafe: ${normalizedPath(root, candidate)}`);
      const resolved = await resolveWorkspacePath(root, normalizedPath(root, candidate), "workspace ignore file", { expected: "file", security: context.security });
      const read = await secureRead(resolved, MAX_IGNORE_FILE_BYTES, "workspace ignore file", context.signal, context.hooks);
      const content = decodeUtf8Prefix(read.bytes, read.truncated, "workspace ignore file");
      for (const line of iterateLines(content)) {
        throwIfCancelled(context.signal, "workspace ignore file");
        const trimmed = line.text.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        if (Buffer.byteLength(trimmed, "utf8") > MAX_PATTERN_BYTES) throw new Error(`workspace ignore pattern exceeds ${MAX_PATTERN_BYTES} bytes`);
        if (patterns.length >= MAX_IGNORE_PATTERNS) throw new Error(`workspace ignore files exceed ${MAX_IGNORE_PATTERNS} patterns`);
        patterns.push(trimmed);
      }
      sources.push(normalizedPath(root, candidate));
    }
  }
  const rules = patterns.map((source) => {
    const negate = source.startsWith("!");
    const pattern = negate ? source.slice(1) : source;
    if (!pattern) throw new Error("workspace ignore pattern must not be empty");
    const normalized = pattern.endsWith("/") ? `${pattern}**` : pattern;
    return { negate, path: compileGlob(normalized), basename: normalized.includes("/") ? undefined : compileGlob(normalized) };
  });
  const digest = createHash("sha256").update(JSON.stringify({ sources: sources.sort(comparePaths), patterns })).digest("hex");
  return {
    sources: sources.sort(comparePaths),
    digest,
    matches(path: string, directory: boolean) {
      let ignored = false;
      for (const rule of rules) {
        if (rule.path.test(path) || rule.basename?.test(basename(path))) ignored = !rule.negate;
      }
      return ignored || (directory && rules.some((rule) => rule.path.test(`${path}/`)));
    }
  };
}

function traversalBounds(input: any, label: string) {
  return {
    limit: strictBoundedInteger(input.limit, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, `${label} limit`),
    maxDepth: strictBoundedInteger(input.maxDepth, 0, MAX_DEPTH, DEFAULT_MAX_DEPTH, `${label} maxDepth`),
    maxFiles: strictBoundedInteger(input.maxFiles, 1, MAX_FILES, DEFAULT_MAX_FILES, `${label} maxFiles`),
    maxBytes: strictBoundedInteger(input.maxBytes, 1, MAX_INSPECTION_BYTES, DEFAULT_INSPECTION_BYTES, `${label} maxBytes`)
  };
}

function metadataResult(resolved: ResolvedWorkspacePath, extra: Record<string, unknown>) {
  return {
    path: resolved.path,
    resolvedPath: resolved.path,
    type: resolved.metadata.isDirectory() ? "directory" : "file",
    bytes: Number(resolved.metadata.size),
    modifiedAt: new Date(Number(resolved.metadata.mtimeMs)).toISOString(),
    mode: Number(resolved.metadata.mode & 0o777n),
    ...extra
  };
}

function sensitivePath(path: string, security: WorkspaceSecurity | undefined) {
  const patterns = stringArray(security?.deniedPatterns, DEFAULT_SENSITIVE_PATTERNS, 128, "workspace deniedPatterns");
  return patterns.some((pattern) => globMatches(path, pattern));
}

function globMatches(path: string, pattern: string) {
  const normalizedPathname = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  return compileGlob(pattern).test(normalizedPathname);
}

function compileGlob(pattern: string) {
  const normalizedPattern = pattern.replaceAll("\\", "/").replace(/^\.\//u, "");
  let expression = "";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index]!;
    if (character === "/" && normalizedPattern[index + 1] === "*" && normalizedPattern[index + 2] === "*" && index + 3 === normalizedPattern.length) {
      expression += "(?:/.*)?";
      index += 2;
    } else if (character === "*") {
      if (normalizedPattern[index + 1] === "*" && normalizedPattern[index + 2] === "/") { expression += "(?:.*/)?"; index += 2; }
      else if (normalizedPattern[index + 1] === "*") { expression += ".*"; index += 1; }
      else expression += "[^/]*";
    } else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  return new RegExp(`^${expression}$`, "iu");
}

function isBinary(bytes: Buffer, truncated = false) {
  if (bytes.includes(0)) return true;
  try { decodeUtf8Prefix(bytes, truncated, "workspace binary probe"); return false; } catch { return true; }
}

function decodeUtf8Prefix(bytes: Buffer, truncated: boolean, label: string) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try { return decoder.decode(bytes); } catch (error) {
    if (!truncated) throw new Error(`${label} target is binary or not valid UTF-8`, { cause: error });
    for (let trim = 1; trim <= 3 && trim <= bytes.length; trim += 1) {
      try { return decoder.decode(bytes.subarray(0, bytes.length - trim)); } catch { /* try the preceding UTF-8 boundary */ }
    }
    throw new Error(`${label} target is binary or not valid UTF-8`, { cause: error });
  }
}

function truncateUtf8(value: string, maxBytes: number) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;
  return decodeUtf8Prefix(encoded.subarray(0, maxBytes), true, "workspace result");
}

function cursorFingerprint(operation: string, rootIdentity: string, path: string, options: unknown) {
  return createHash("sha256").update(JSON.stringify({ operation, rootIdentity, path, options })).digest("hex");
}

function encodeCursor(operation: string, fingerprint: string, last: string) {
  const payload = { v: 1, operation, fingerprint, last };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const checksum = createHash("sha256").update(body).digest("hex").slice(0, 24);
  return `${body}.${checksum}`;
}

function decodeCursor(value: unknown, operation: string, fingerprint: string) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 4_096 || !value.includes(".")) throw new Error(`${operation} cursor is invalid`);
  const [body, checksum] = value.split(".", 2);
  if (createHash("sha256").update(body!).digest("hex").slice(0, 24) !== checksum) throw new Error(`${operation} cursor integrity check failed`);
  let payload: any;
  try { payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")); } catch { throw new Error(`${operation} cursor is invalid`); }
  if (payload?.v !== 1 || payload.operation !== operation || payload.fingerprint !== fingerprint || typeof payload.last !== "string") throw new Error(`${operation} cursor does not match this request`);
  if (!payload.last || payload.last.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(payload.last)) throw new Error(`${operation} cursor is invalid`);
  assertPortableRelativePath(payload.last, `${operation} cursor`);
  return payload.last as string;
}

function unifiedDiff(before: string, after: string, beforePath: string, afterPath: string, maxBytes: number, signal?: AbortSignal) {
  if (before === after) return { diff: "", truncated: false };
  const leftCount = countLines(before, MAX_DIFF_LINES, "workspace.diff");
  const rightCount = countLines(after, MAX_DIFF_LINES, "workspace.diff");
  const chunks: string[] = [];
  let used = 0;
  let truncated = false;
  const append = (chunk: string) => {
    const remaining = maxBytes - used;
    if (remaining <= 0) { truncated = true; return false; }
    const bytes = Buffer.byteLength(chunk, "utf8");
    if (bytes <= remaining) { chunks.push(chunk); used += bytes; return true; }
    chunks.push(truncateUtf8(chunk, remaining));
    used = maxBytes;
    truncated = true;
    return false;
  };
  append(`--- a/${beforePath}\n+++ b/${afterPath}\n@@ -1,${leftCount} +1,${rightCount} @@\n`);
  for (const line of iterateLines(before)) {
    throwIfCancelled(signal, "workspace.diff");
    if (!append(`-${line.text}\n`)) break;
  }
  if (!truncated) {
    for (const line of iterateLines(after)) {
      throwIfCancelled(signal, "workspace.diff");
      if (!append(`+${line.text}\n`)) break;
    }
  }
  return { diff: chunks.join(""), truncated };
}

function* iterateLines(value: string): Generator<{ number: number; text: string }> {
  let start = 0;
  let number = 1;
  while (start <= value.length) {
    const newline = value.indexOf("\n", start);
    const end = newline === -1 ? value.length : newline;
    const carriageReturn = end > start && value.charCodeAt(end - 1) === 13;
    yield { number, text: value.slice(start, carriageReturn ? end - 1 : end) };
    if (newline === -1) break;
    start = newline + 1;
    number += 1;
  }
}

function countLines(value: string, maximum: number, label: string) {
  let count = 0;
  for (const _line of iterateLines(value)) {
    count += 1;
    if (count > maximum) throw new Error(`${label} exceeded ${maximum} lines`);
  }
  return count;
}

function comparePaths(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTraversalPaths(left: string, right: string) {
  const leftParts = left.split("/");
  const rightParts = right.split("/");
  const shared = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < shared; index += 1) {
    const compared = comparePaths(leftParts[index]!, rightParts[index]!);
    if (compared !== 0) return compared;
  }
  return leftParts.length - rightParts.length;
}

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function withResultBytes(value: Record<string, unknown>) {
  let resultBytes = 0;
  for (let index = 0; index < 4; index += 1) {
    const measured = jsonBytes({ ...value, resultBytes });
    if (measured === resultBytes) break;
    resultBytes = measured;
  }
  return { ...value, resultBytes };
}

function cleanDisplayPath(value: unknown, label: string) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} beforePath must be bounded control-free text`);
  }
  assertPortableRelativePath(value, `${label} beforePath`);
  return value;
}

function stringArray(value: unknown, fallback: readonly string[], maximum: number, label: string) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 256 || item.includes("\0"))) {
    throw new Error(`${label} must be an array of at most ${maximum} bounded strings`);
  }
  return [...new Set(value.map((item) => String(item).trim()))];
}

function sensitivePolicyDigest(security: WorkspaceSecurity | undefined) {
  const patterns = stringArray(security?.deniedPatterns, DEFAULT_SENSITIVE_PATTERNS, 128, "workspace deniedPatterns");
  return createHash("sha256").update(JSON.stringify(patterns)).digest("hex");
}

function assertPortableRelativePath(value: string, label: string) {
  if (isAbsolute(value) || win32.isAbsolute(value) || /^[A-Za-z]:/u.test(value) || value.startsWith("\\\\") || value.startsWith("//") || value.includes("\\")) {
    throw new Error(`${label} path must be a portable workspace-relative path`);
  }
  const components = value.split("/");
  const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
  if (components.some((component) => component === ".." || component !== "." && (component.includes(":") || /[ .]$/u.test(component) || reserved.test(component)))) {
    throw new Error(`${label} path escapes workspace root or contains a platform-ambiguous component`);
  }
}

function strictBoundedInteger(value: unknown, minimum: number, maximum: number, fallback: number, label: string) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${label} must be a safe integer from ${minimum} to ${maximum}`);
  return Number(value);
}

function throwIfCancelled(signal: AbortSignal | undefined, label: string) {
  if (!signal?.aborted) return;
  const error = new Error(`${label} cancelled`);
  error.name = "AbortError";
  throw error;
}

export async function executeWorkspaceProcess(workspaceRoot: string, input: any = {}, signal?: AbortSignal, { supervisor, requestId }: { supervisor?: ProcessSupervisor; requestId?: string } = {}) {
  if (signal?.aborted) throw processCancellationError();
  const command = cleanCommand(input.command);
  const args = cleanArguments(input.args);
  const configuredCwd = input.cwd ?? ".";
  const root = resolve(workspaceRoot);
  const compatibleCwd = typeof configuredCwd === "string" && isAbsolute(configuredCwd) && contained(root, resolve(configuredCwd))
    ? normalizedPath(root, resolve(configuredCwd))
    : configuredCwd;
  const cwd = await resolveWorkspacePath(workspaceRoot, compatibleCwd, "process.exec", { allowRoot: true, expected: "directory", security: { deniedPatterns: [] } });
  const timeoutMs = boundedInteger(input.timeoutMs, 100, 120_000, DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = boundedInteger(input.maxOutputBytes, 1_024, 1_000_000, DEFAULT_MAX_OUTPUT_BYTES);
  const descriptor = supervisor
    ? createProcessExecutionDescriptor({ workspaceRoot: root, command, args, cwd: cwd.path || ".", timeoutMs, maxOutputBytes, requestId })
    : undefined;
  const startedAt = Date.now();

  const execute = async (session?: ProcessExecutionSession) => await new Promise((resolveProcess, rejectProcess) => {
    let child: ReturnType<typeof spawn> | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let capturedBytes = 0;
    let timedOut = false;
    let outputTruncated = false;
    let settled = false;
    let launchFailed = false;
    let cancellationRequested = false;
    let lifecycleError: unknown;
    let runningRecord: Promise<void> | undefined;
    let terminationRecord: Promise<void> | undefined;
    let launchAbortRecord: Promise<void> | undefined;
    let terminationStarted = false;
    let closed = false;

    const terminate = () => {
      const activeChild = child;
      if (!activeChild?.pid) return;
      if (!terminationStarted) {
        terminationStarted = true;
        terminationRecord = Promise.all([
          session?.markTerminating() ?? Promise.resolve(),
          process.platform === "win32" ? terminateWindowsProcess(activeChild.pid) : Promise.resolve()
        ]).then(() => undefined).catch((error) => {
          lifecycleError ??= error;
        });
      }
      if (process.platform === "win32") {
        return;
      } else {
        try { killProcess(-activeChild.pid, "SIGKILL"); } catch { activeChild.kill("SIGKILL"); }
      }
    };
    const abort = () => {
      cancellationRequested = true;
      terminate();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      signal.removeEventListener("abort", abort);
      launchAbortRecord = session?.abortBeforeLaunch();
      if (launchAbortRecord) void launchAbortRecord.then(() => rejectProcess(processCancellationError())).catch(rejectProcess);
      else rejectProcess(processCancellationError());
      return;
    }
    try {
      child = spawn(command, args, {
        cwd: cwd.target,
        env: processEnvironment(cwd.target),
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      signal?.removeEventListener("abort", abort);
      launchFailed = true;
      launchAbortRecord = session?.abortBeforeLaunch();
      const launchError = processLaunchFailure();
      void (launchAbortRecord ? launchAbortRecord.then(() => rejectProcess(launchError)).catch(rejectProcess) : Promise.resolve(rejectProcess(launchError)));
      return;
    }
    const activeChild = child!;
    const collect = (chunks: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
      const available = Math.max(0, maxOutputBytes - capturedBytes);
      if (available) chunks.push(chunk.subarray(0, available));
      const captured = Math.min(chunk.byteLength, available);
      capturedBytes += captured;
      if (stream === "stdout") stdoutBytes += captured;
      else stderrBytes += captured;
      if (chunk.byteLength > available) {
        outputTruncated = true;
        terminate();
      }
    };
    activeChild.stdout!.on("data", (chunk: Buffer) => collect(stdout, chunk, "stdout"));
    activeChild.stderr!.on("data", (chunk: Buffer) => collect(stderr, chunk, "stderr"));
    activeChild.once("error", (error) => {
      lifecycleError ??= processLaunchFailure();
      if (!activeChild.pid) {
        launchFailed = true;
        launchAbortRecord = session?.abortBeforeLaunch().catch((failure) => { lifecycleError ??= failure; });
      } else terminate();
    });
    const timer = setTimeout(() => {
      if (closed || settled) return;
      timedOut = true;
      terminate();
    }, timeoutMs);
    activeChild.once("exit", () => {
      closed = true;
      clearTimeout(timer);
    });
    activeChild.once("close", (exitCode, childSignal) => {
      void (async () => {
        if (settled) return;
        closed = true;
        clearTimeout(timer);
        await launchAbortRecord;
        await runningRecord;
        await terminationRecord;
        if (session && !launchFailed) {
          try { await session.settle(); }
          catch (error) { lifecycleError ??= error; }
        }
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (cancellationRequested || signal?.aborted) {
          rejectProcess(processCancellationError());
          return;
        }
        if (lifecycleError) {
          rejectProcess(lifecycleError);
          return;
        }
        resolveProcess({
          command,
          args,
          cwd: cwd.path === "." ? "" : cwd.path,
          exitCode: exitCode ?? 1,
          signal: childSignal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdoutBytes,
          stderrBytes,
          timedOut,
          outputTruncated,
          durationMs: Date.now() - startedAt
        });
      })().catch(rejectProcess);
    });
    if (session && activeChild.pid) {
      runningRecord = session.markRunning(activeChild.pid).then(() => undefined).catch((error) => {
        lifecycleError ??= error;
        terminate();
      });
    }
  });

  return supervisor && descriptor ? supervisor.execute(descriptor, (session) => execute(session)) : execute();
}

function processCancellationError() {
  const error = new Error("process.exec cancelled");
  error.name = "AbortError";
  return error;
}

function processLaunchFailure() {
  return new ProcessRecoveryError("process execution could not be started", "PROCESS_LAUNCH_FAILED");
}

function terminateWindowsProcess(pid: number): Promise<void> {
  return new Promise((resolveTermination) => {
    let killer: ReturnType<typeof spawn>;
    try {
      killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      resolveTermination();
      return;
    }
    killer.once("error", () => resolveTermination());
    killer.once("close", () => resolveTermination());
  });
}

function cleanCommand(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("process.exec requires command");
  return value.trim();
}

function cleanArguments(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256 || value.some((entry) => typeof entry !== "string" || entry.includes("\0"))) {
    throw new Error("process.exec args must be an array of at most 256 strings");
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function processEnvironment(workspaceDirectory: string): NodeJS.ProcessEnv {
  const allowed = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TERM", "CI"];
  return {
    ...Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    HOME: workspaceDirectory,
    USERPROFILE: workspaceDirectory
  };
}
