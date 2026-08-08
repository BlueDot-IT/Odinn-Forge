import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CheckpointCoordinator } from "./checkpoint-coordinator.ts";
import { OdinnRuntimeError, SnapshotManager } from "./differentiated-runtime.ts";
import { withStateMutationLock } from "./state-mutation.ts";
import { createRunLedger, RunLedger } from "./run-ledger.ts";

type AnyRecord = Record<string, unknown>;

export const DEFAULT_MUTATION_MAX_BYTES = 1_000_000;
export const DEFAULT_MUTATION_MAX_FILES = 256;

const MAX_PORTABLE_PATH_BYTES = 1_024;
const MAX_STRING_BYTES = 2_000_000;
const MAX_PATCH_COUNT = 16;
const MAX_PATCH_OCCURRENCES = 10_000;

const PORTABLE_BANNED_SEGMENTS = new Set([
  "..",
  ".git",
  ".odinn",
  ".odinn-worktrees",
  ".cache",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules"
]);

interface MutationNodeState {
  path: string;
  exists: boolean;
  kind: "missing" | "file" | "directory";
  bytes?: number;
  mode?: number;
  digest?: string;
  artifactDigest?: string;
}

interface ExpectedState {
  exists?: boolean;
  type?: Exclude<MutationNodeState["kind"], "missing">;
  digest?: string;
  bytes?: number;
  mode?: number;
}

interface MutationConflict {
  code: string;
  path: string;
  message: string;
  details?: AnyRecord;
}

interface NormalizedPatch {
  find: string;
  replace: string;
  replaceAll: boolean;
  occurrence?: number;
}

interface MutationLimits {
  maxBytes: number;
  maxFiles: number;
}

interface NormalizedLimitsInput {
  maxBytes?: number;
  maxFiles?: number;
}

export interface MutationPreview {
  ok: true;
  preview: true;
  operation: string;
  status: "ready" | "conflict";
  ceilings: {
    maxBytes: number;
    maxFiles: number;
  };
  usage: {
    paths: number;
    files: number;
    bytes: number;
  };
  coveredPaths: string[];
  entries: Array<{
    path: string;
    before?: MutationNodeState;
    after?: MutationNodeState;
    expected?: ExpectedState;
    resultDigest?: string;
  }>;
  conflicts: MutationConflict[];
}

type MutationExecutionResult = Omit<MutationPreview, "preview"> & {
  preview: false;
  apply: true;
  applied: boolean;
  boundaryId?: string;
  checkpointId?: string;
  manifestDigest?: string;
  artifactPath?: string;
};

type RestoreExecutionResult = Omit<MutationPreview, "preview"> & {
  preview: false;
  apply: true;
  applied: boolean;
  checkpointId: string;
  manifestDigest?: string;
  checkpointRunId?: string;
  boundaryId?: string;
  recoveryCheckpointId?: string;
  externalEffects: false;
};

interface RestorePreviewResult {
  ok: true;
  preview: true;
  operation: string;
  status: "ready" | "conflict";
  ceilings: {
    maxBytes: number;
    maxFiles: number;
  };
  usage: {
    paths: number;
    files: number;
    bytes: number;
  };
  coveredPaths: string[];
  entries: Array<{
    path: string;
    before?: MutationNodeState;
    after?: MutationNodeState;
    action: RestoreAction["action"];
    resultDigest?: string;
  }>;
  conflicts: MutationConflict[];
  checkpointId: string;
  manifestDigest?: string;
  checkpointRunId?: string;
  recoveryCheckpointId?: string;
  apply?: true;
  applied?: boolean;
  externalEffects: false;
}

interface RestoreAction {
  path: string;
  action: "restore" | "remove" | "modify" | "restore-directory" | "remove-directory" | "mode";
  before: MutationNodeState;
  after: MutationNodeState;
  reason: "checkpoint-restore-inverse";
}

interface RestoreManifestEntry {
  path: string;
  before?: MutationNodeState;
  after?: MutationNodeState;
}

interface MutationToolOptions {
  workspaceRoot?: string;
  safe?: boolean;
  runLedger?: RunLedger;
  coordinator?: CheckpointCoordinator;
  stateDir?: string;
  runId?: string;
  stepId?: string;
  purpose?: string;
  foundation?: string;
  metadata?: AnyRecord;
}

interface MutationPublicationState {
  runId: string;
  boundaryId: string;
  stepId?: string;
}

function isWithin(root: string, target: string) {
  const base = resolve(root);
  const absoluteTarget = resolve(target);
  return absoluteTarget === base || absoluteTarget.startsWith(`${base}${sep}`);
}

function lstatIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch (cause) {
    if (["ENOENT", "ENOTDIR"].includes((cause as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw cause;
  }
}

function toPosix(value: string) {
  return value.split(sep).join("/");
}

function hashValue(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function error(code: string, message: string, details?: AnyRecord): never {
  throw new OdinnRuntimeError(code, message, details);
}

function optionalInteger(input: unknown, label: string, minimum: number, maximum: number): number | undefined {
  if (input === undefined) return undefined;
  const value = Number(input);
  if (!Number.isInteger(value)) error("INPUT_INVALID", `${label} must be an integer`);
  if (value < minimum || value > maximum) error("INPUT_INVALID", `${label} must be between ${minimum} and ${maximum}`);
  return value;
}

function normalizeLimits(input: NormalizedLimitsInput): MutationLimits {
  const maxBytes = optionalInteger(input.maxBytes, "maxBytes", 1, MAX_STRING_BYTES) ?? DEFAULT_MUTATION_MAX_BYTES;
  const maxFiles = optionalInteger(input.maxFiles, "maxFiles", 1, 10_000) ?? DEFAULT_MUTATION_MAX_FILES;
  return { maxBytes, maxFiles };
}

function normalizeMode(input: unknown): number {
  if (input === undefined) return 0o755;
  const value = Number(input);
  if (!Number.isInteger(value) || value < 0 || value > 0o777) {
    error("INPUT_INVALID", "mode must be an integer in 0o000..0o777");
  }
  return value;
}

function normalizeExpectedState(input: unknown): ExpectedState {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    error("INPUT_INVALID", "expected must be an object");
  }
  const value = input as AnyRecord;
  const normalized: ExpectedState = {};

  if (value.exists !== undefined) {
    if (typeof value.exists !== "boolean") error("INPUT_INVALID", "expected.exists must be boolean");
    normalized.exists = value.exists;
  }

  if (value.type !== undefined) {
    if (value.type !== "file" && value.type !== "directory") {
      error("INPUT_INVALID", "expected.type must be file or directory");
    }
    normalized.type = value.type as "file" | "directory";
  }

  if (value.digest !== undefined) {
    if (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.digest)) {
      error("INPUT_INVALID", "expected.digest must be a SHA-256 hex string");
    }
    normalized.digest = value.digest;
  }

  if (value.bytes !== undefined) {
    const bytes = Number(value.bytes);
    if (!Number.isInteger(bytes) || bytes < 0) error("INPUT_INVALID", "expected.bytes must be a non-negative integer");
    normalized.bytes = bytes;
  }

  if (value.mode !== undefined) {
    normalized.mode = normalizeMode(value.mode);
  }

  return normalized;
}

function pushConflict(conflicts: MutationConflict[], path: string, code: string, message: string, details?: AnyRecord) {
  conflicts.push({ code, path, message, details });
}

function finalizePreview(
  operation: string,
  limits: MutationLimits,
  entries: MutationPreview["entries"],
  conflicts: MutationConflict[]
): MutationPreview {
  const seen = new Set<string>();
  let files = 0;
  let bytes = 0;

  const stableEntries = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  for (const entry of stableEntries) {
    if (seen.has(entry.path)) error("PREVIEW_DUPE", "preview path was duplicated", { path: entry.path });
    seen.add(entry.path);

    if (entry.before?.kind === "file") {
      files += 1;
      bytes += entry.before.bytes ?? 0;
    }
    if (entry.after?.kind === "file") {
      files += 1;
      bytes += entry.after.bytes ?? 0;
    }
  }

  const stableConflicts = [...conflicts].sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
  const pathList = stableEntries.map((entry) => entry.path);

  return {
    ok: true,
    preview: true,
    operation,
    status: stableConflicts.length > 0 ? "conflict" : "ready",
    ceilings: limits,
    usage: {
      paths: stableEntries.length,
      files,
      bytes
    },
    coveredPaths: pathList,
    entries: stableEntries,
    conflicts: stableConflicts
  };
}

function applyMutationResult(preview: MutationPreview, fields: {
  applied: boolean;
  boundaryId?: string;
  checkpointId?: string;
  manifestDigest?: string;
  artifactPath?: string;
}) {
  const result: MutationExecutionResult = {
    ...preview,
    preview: false,
    apply: true,
    ...fields
  };
  return result;
}

function expectedFromNode(node: MutationNodeState): ExpectedState {
  if (!node.exists) return { exists: false };
  const expected: ExpectedState = {
    exists: true,
    type: node.kind === "missing" ? undefined : node.kind
  };
  if (node.bytes !== undefined) expected.bytes = node.bytes;
  if (node.mode !== undefined) expected.mode = node.mode;
  if (node.digest !== undefined) expected.digest = node.digest;
  return expected;
}

function verifyParentChains(root: string, entries: MutationPreview["entries"], limits: MutationLimits, enforceSafety: boolean, conflicts: MutationConflict[]) {
  const seen = new Set<string>();
  for (const entry of entries) {
    const parent = resolveParent(entry.path);
    if (!parent) continue;
    if (seen.has(parent)) continue;
    seen.add(parent);
    try {
      const state = inspectPath(root, parent, { maxBytes: limits.maxBytes }, enforceSafety);
      if (!state.exists || state.kind !== "directory") {
        pushConflict(conflicts, entry.path, "PARENT_INVALID", "parent directory missing or not a directory", { parent });
      }
    } catch (cause) {
      if (cause instanceof OdinnRuntimeError) {
        pushConflict(conflicts, entry.path, cause.code, cause.message, cause.details);
      } else {
        throw cause;
      }
    }
  }
}

function ensureNoStaleState({ root, entries, enforceSafety, limits }: {
  root: string;
  entries: MutationPreview["entries"];
  enforceSafety: boolean;
  limits: MutationLimits;
}): MutationConflict[] {
  const conflicts: MutationConflict[] = [];
  for (const entry of entries) {
    const expectedBefore = expectedFromNode(entry.before ?? { path: entry.path, exists: false, kind: "missing" });
    try {
      const current = inspectPath(
        root,
        entry.path,
        { requireDigest: entry.before?.kind === "file" && entry.before.digest !== undefined, maxBytes: limits.maxBytes },
        enforceSafety
      );
      addExpectedConflicts(entry.path, current, expectedBefore, conflicts);
    } catch (cause) {
      if (cause instanceof OdinnRuntimeError) {
        pushConflict(conflicts, entry.path, cause.code, cause.message, cause.details);
      } else {
        throw cause;
      }
    }
  }

  verifyParentChains(root, entries, limits, enforceSafety, conflicts);
  return conflicts;
}

interface MutationPathIdentity {
  absolute: string;
  exists: boolean;
  dev?: number;
  ino?: number;
  directory?: boolean;
  file?: boolean;
}

interface MutationIdentities {
  targets: MutationPathIdentity[];
  ancestors: MutationPathIdentity[];
}

function pathIdentity(absolute: string, state: ReturnType<typeof lstatIfPresent>): MutationPathIdentity {
  if (!state) return { absolute, exists: false };
  return {
    absolute,
    exists: true,
    dev: Number(state.dev),
    ino: Number(state.ino),
    directory: state.isDirectory(),
    file: state.isFile()
  };
}

function captureMutationIdentities(root: string, paths: string[], enforceSafety: boolean): MutationIdentities {
  const targets = new Map<string, MutationPathIdentity>();
  const ancestors = new Map<string, MutationPathIdentity>();
  const workspaceRoot = resolve(root);

  for (const portable of [...new Set(paths)]) {
    const candidate = resolveCandidate(workspaceRoot, portable || ".", enforceSafety);
    targets.set(candidate.absolute, pathIdentity(candidate.absolute, lstatIfPresent(candidate.absolute)));

    let cursor = dirname(candidate.absolute);
    while (isWithin(workspaceRoot, cursor)) {
      if (!targets.has(cursor)) ancestors.set(cursor, pathIdentity(cursor, lstatIfPresent(cursor)));
      if (cursor === workspaceRoot) break;
      cursor = dirname(cursor);
    }
  }

  return {
    targets: [...targets.values()],
    ancestors: [...ancestors.values()]
  };
}

function assertMutationIdentities(root: string, identities: MutationIdentities, { includeTargets = true } = {}) {
  const workspaceRoot = resolve(root);
  const check = (identity: MutationPathIdentity) => {
    const current = lstatIfPresent(identity.absolute);
    if (identity.exists !== Boolean(current)) {
      error("PATH_REPLACED", "workspace path changed during the governed mutation", { path: toPosix(relative(workspaceRoot, identity.absolute)) });
    }
    if (!identity.exists || !current) return;
    if (
      Number(current.dev) !== identity.dev
      || Number(current.ino) !== identity.ino
      || current.isDirectory() !== identity.directory
      || current.isFile() !== identity.file
      || current.isSymbolicLink()
    ) {
      error("PATH_REPLACED", "workspace path identity changed during the governed mutation", { path: toPosix(relative(workspaceRoot, identity.absolute)) });
    }
  };

  for (const identity of identities.ancestors) check(identity);
  if (includeTargets) for (const identity of identities.targets) check(identity);
}

function verifyPostWrite({ root, preview, enforceSafety, limits }: {
  root: string;
  preview: MutationPreview;
  enforceSafety: boolean;
  limits: MutationLimits;
}) {
  const conflicts: MutationConflict[] = [];
  for (const entry of preview.entries) {
    if (!entry.after) continue;
    const expected = expectedFromNode(entry.after);
    try {
      const actual = inspectPath(
        root,
        entry.path,
        {
          requireDigest: entry.after.kind === "file",
          maxBytes: limits.maxBytes
        },
        enforceSafety
      );
      addExpectedConflicts(entry.path, actual, expected, conflicts);
    } catch (cause) {
      if (cause instanceof OdinnRuntimeError) {
        pushConflict(conflicts, entry.path, cause.code, cause.message, cause.details);
      } else {
        throw cause;
      }
    }
  }
  return conflicts;
}

function writeAtomically(absolute: string, bytes: Buffer, mode: number) {
  const temporary = `${absolute}.odinn-write-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, bytes, { mode });
    renameSync(temporary, absolute);
  } catch (error) {
    try {
      rmSync(temporary, { recursive: true, force: true });
    } catch {}
    throw error;
  }
}

function removeAtomically(absolute: string) {
  const backup = `${absolute}.odinn-remove-${process.pid}-${randomUUID()}`;
  renameSync(absolute, backup);
  try {
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    try {
      renameSync(backup, absolute);
    } catch {}
    throw error;
  }
}

function moveAtomically(source: string, destination: string, overwrite: boolean) {
  const backup = `${destination}.odinn-overwrite-${process.pid}-${randomUUID()}`;
  const destinationExisted = existsSync(destination);
  let backedUp = false;
  try {
    if (destinationExisted) {
      if (!overwrite) throw new Error("destination exists");
      renameSync(destination, backup);
      backedUp = true;
    }
    renameSync(source, destination);
    if (backedUp) {
      rmSync(backup, { recursive: true, force: true });
    }
  } catch (error) {
    if (backedUp) {
      try {
        if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
        renameSync(backup, destination);
      } catch {}
    }
    throw error;
  }
}

function normalizePortablePath(label: string, value: unknown): string {
  if (typeof value !== "string") error("INPUT_INVALID", `${label} must be a string`);
  if (value.length === 0) error("INPUT_INVALID", `${label} cannot be empty`);
  if (Buffer.byteLength(value, "utf8") > MAX_PORTABLE_PATH_BYTES) {
    error("PATH_INVALID", `${label} exceeds ${MAX_PORTABLE_PATH_BYTES} bytes`);
  }

  if (value.includes("\\")) error("PATH_INVALID", `${label} must use forward slashes`);
  if (value.includes("\u0000")) error("PATH_INVALID", `${label} cannot contain null bytes`);
  if (value === "." || value === "..") error("PATH_INVALID", `${label} must be a portable relative path`);
  if (value.startsWith("./") || value.startsWith("../") || value === "./" || value.endsWith("/.") || value.endsWith("/..") || value.includes("/./") || value.includes("/../")) {
    error("PATH_INVALID", `${label} must be a portable relative path`);
  }
  if (/^[A-Za-z]:/u.test(value)) {
    error("PATH_INVALID", `${label} cannot contain a Windows drive path`);
  }

  const parts = value.split("/");
  if (parts.some((part) => part.length === 0)) {
    error("PATH_INVALID", `${label} contains empty path segments`);
  }
  if (parts.some((part) => part === "." || part === "..")) {
    error("PATH_INVALID", `${label} contains '.' or '..' segment`);
  }
  if (parts.some((part) => PORTABLE_BANNED_SEGMENTS.has(part))) {
    error("PATH_INVALID", `${label} enters a sensitive directory`);
  }
  if (parts.some((part) => part.startsWith(".env"))) {
    error("PATH_INVALID", `${label} is in an ignored environment path`);
  }
  if (parts.some((part) => part.startsWith("."))) {
    error("PATH_INVALID", `${label} contains unsupported hidden segment`);
  }

  return parts.join("/");
}

function resolveCandidate(root: string, portable: string, safe = true): { absolute: string; relative: string } {
  const workspaceRoot = resolve(root);
  const absolute = resolve(workspaceRoot, portable);
  if (!isWithin(workspaceRoot, absolute)) error("PATH_TRAVERSAL", "path escapes the workspace root");

  let cursor = absolute;
  const rootPhysical = resolve(realpathSync(workspaceRoot));

  while (cursor !== workspaceRoot) {
    const cursorState = lstatIfPresent(cursor);
    if (cursorState) {
      if (safe && cursorState.isSymbolicLink()) {
        error("SYMLINK_FORBIDDEN", "path crosses symbolic link junction", { path: toPosix(relative(workspaceRoot, cursor)) });
      }
      const cursorReal = resolve(realpathSync(cursor));
      if (!isWithin(rootPhysical, cursorReal)) {
        error("PATH_ESCAPE", "path resolves outside the workspace root", { path: toPosix(relative(workspaceRoot, cursor)) });
      }
      if (cursor !== absolute && !cursorState.isDirectory()) {
        error("PARENT_NOT_DIRECTORY", "parent path must be a directory", { path: toPosix(relative(workspaceRoot, cursor)) });
      }
    }
    cursor = dirname(cursor);
  }

  const targetState = lstatIfPresent(absolute);
  if (safe && targetState) {
    const state = targetState;
    if (state.isSymbolicLink()) {
      error("SYMLINK_FORBIDDEN", "target is a symbolic link", { path: portable });
    }
  }

  return { absolute, relative: toPosix(relative(workspaceRoot, absolute)) };
}

function inspectPath(root: string, portable: string, options: { requireDigest?: boolean; maxBytes?: number } = {}, safe = true): MutationNodeState {
  let candidate: { absolute: string; relative: string };
  try {
    candidate = resolveCandidate(root, portable, safe);
  } catch (cause) {
    if (cause instanceof OdinnRuntimeError && cause.code === "PARENT_NOT_DIRECTORY") {
      return { path: toPosix(relative(resolve(root), resolve(root, portable))), exists: false, kind: "missing" };
    }
    throw cause;
  }
  const { absolute, relative: relativePath } = candidate;
  if (!lstatIfPresent(absolute)) {
    return {
      path: relativePath,
      exists: false,
      kind: "missing"
    };
  }

  const state = lstatSync(absolute);
  if (state.isSymbolicLink()) {
    if (safe) error("SYMLINK_FORBIDDEN", "target is a symbolic link", { path: portable });
  }

  const metadata = statSync(absolute);
  if (safe && metadata.isFile() && metadata.nlink > 1) {
    error("HARDLINK_FORBIDDEN", "file has additional hard links", { path: portable, links: metadata.nlink });
  }
  if (options.maxBytes !== undefined && metadata.size > options.maxBytes) {
    error("BUDGET_EXCEEDED", "file exceeds operation byte ceiling", { path: portable, bytes: metadata.size, maxBytes: options.maxBytes });
  }

  if (metadata.isDirectory()) {
    return {
      path: relativePath,
      exists: true,
      kind: "directory",
      mode: metadata.mode & 0o777
    };
  }

  if (metadata.isFile()) {
    if (safe && options.maxBytes !== undefined && metadata.size > options.maxBytes) {
      // Already reported above for strict mode to keep the same budget surface for preview calculations.
    }
    const digest = options.requireDigest ? hashValue(readFileSync(absolute)) : undefined;

    return {
      path: relativePath,
      exists: true,
      kind: "file",
      bytes: metadata.size,
      mode: metadata.mode & 0o777,
      ...(digest ? { digest } : {})
    };
  }

  error("PATH_UNSUPPORTED", "unsupported filesystem object type", { path: portable });
}

function collectDirectoryTree(
  root: string,
  portable: string,
  limits: MutationLimits,
  safe = true,
  conflicts: MutationConflict[] = []
): {
  entries: MutationNodeState[];
  files: number;
  bytes: number;
} {
  const { absolute, relative: baseRelative } = resolveCandidate(root, portable, safe);
  const entries: MutationNodeState[] = [];
  const baseState = inspectPath(root, portable, { maxBytes: limits.maxBytes }, safe);
  if (baseState.kind !== "directory") {
    error("TYPE_MISMATCH", "source path is not a directory", { path: portable });
  }

  let files = 0;
  let bytes = 0;
  entries.push(baseState);

  function walk(currentAbsolute: string, currentRelative: string): boolean {
    if (conflicts.some((entry) => entry.code === "BUDGET_EXCEEDED")) {
      return false;
    }

    const children = readdirSync(currentAbsolute).sort((left, right) => left.localeCompare(right));
    for (const child of children) {
      const childAbsolute = join(currentAbsolute, child);
      const childRelative = `${currentRelative}/${child}`;
      const lstat = lstatSync(childAbsolute);

      if (lstat.isSymbolicLink()) {
        error("SYMLINK_FORBIDDEN", "directory tree cannot cross symlink", { path: childRelative });
      }

      if (lstat.isDirectory()) {
        const childState = inspectPath(root, childRelative, { maxBytes: limits.maxBytes }, safe);
        entries.push(childState);
        if (!walk(childAbsolute, childRelative)) {
          return false;
        }
        continue;
      }

      if (!lstat.isFile()) {
        error("PATH_UNSUPPORTED", "directory tree contains unsupported file type", { path: childRelative });
      }

      const fileState = inspectPath(root, childRelative, { requireDigest: true, maxBytes: limits.maxBytes }, safe);
      if (fileState.kind !== "file") {
        error("PATH_UNSUPPORTED", "directory tree encountered non-file child", { path: childRelative });
      }

      const nextFiles = files + 1;
      const nextBytes = bytes + (fileState.bytes ?? 0);
      if (nextFiles > limits.maxFiles) {
        pushConflict(conflicts, portable, "BUDGET_EXCEEDED", "operation exceeds file-count ceiling", {
          maxFiles: limits.maxFiles,
          files: nextFiles
        });
        return false;
      }
      if (nextBytes > limits.maxBytes) {
        pushConflict(conflicts, portable, "BUDGET_EXCEEDED", "operation exceeds byte ceiling", {
          maxBytes: limits.maxBytes,
          bytes: nextBytes
        });
        return false;
      }

      files = nextFiles;
      bytes = nextBytes;
      entries.push(fileState);
    }
    if (conflicts.some((entry) => entry.code === "BUDGET_EXCEEDED")) {
      return false;
    }
    return true;
  }

  walk(absolute, baseRelative);
  return { entries, files, bytes };
}

function addExpectedConflicts(path: string, actual: MutationNodeState, expected: ExpectedState, conflicts: MutationConflict[]) {
  if (expected.exists === false && actual.exists) {
    pushConflict(conflicts, path, "STATE_EXISTS", "path was expected to be absent", { expected: false, actual: true });
    return;
  }
  if (expected.exists === true && !actual.exists) {
    pushConflict(conflicts, path, "STATE_MISSING", "path was expected to exist", { expected: true, actual: false });
    return;
  }
  if (!actual.exists) return;

  if (expected.type !== undefined && expected.type !== actual.kind) {
    pushConflict(conflicts, path, "TYPE_MISMATCH", "path kind mismatch", { expected: expected.type, actual: actual.kind });
  }
  if (expected.bytes !== undefined && expected.bytes !== actual.bytes) {
    pushConflict(conflicts, path, "BYTES_MISMATCH", "bytes mismatch", { expected: expected.bytes, actual: actual.bytes });
  }
  if (expected.mode !== undefined && expected.mode !== actual.mode) {
    pushConflict(conflicts, path, "MODE_MISMATCH", "mode mismatch", { expected: expected.mode, actual: actual.mode });
  }
  if (expected.digest !== undefined) {
    if (actual.kind !== "file") {
      pushConflict(conflicts, path, "DIGEST_MISMATCH", "digest only applies to files", { expected: expected.digest, actual: actual.kind });
      return;
    }
    if (actual.digest === undefined) {
      pushConflict(conflicts, path, "DIGEST_MISMATCH", "target digest unavailable", { expected: expected.digest });
      return;
    }
    if (expected.digest !== actual.digest) {
      pushConflict(conflicts, path, "DIGEST_MISMATCH", "digest mismatch", { expected: expected.digest, actual: actual.digest });
    }
  }
}

function parsePatchList(patches: unknown): NormalizedPatch[] {
  if (!Array.isArray(patches) || patches.length === 0 || patches.length > MAX_PATCH_COUNT) {
    error("PATCH_INVALID", `patches must be an array with 1-${MAX_PATCH_COUNT} items`);
  }
  const normalized: NormalizedPatch[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < patches.length; index += 1) {
    const patch = patches[index];
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      error("PATCH_INVALID", `patches[${index}] must be an object`);
    }
    const value = patch as AnyRecord;
    if (typeof value.find !== "string" || value.find.length === 0) {
      error("PATCH_INVALID", `patches[${index}].find must be a non-empty string`);
    }
    if (Buffer.byteLength(value.find, "utf8") > MAX_STRING_BYTES) {
      error("PATCH_INVALID", `patches[${index}].find exceeds ${MAX_STRING_BYTES} bytes`);
    }
    if (typeof value.replace !== "string") {
      error("PATCH_INVALID", `patches[${index}].replace must be a string`);
    }

    const replaceAll = value.replaceAll === true;
    const occurrence = value.occurrence === undefined ? undefined : optionalInteger(value.occurrence, `patches[${index}].occurrence`, 1, MAX_PATCH_OCCURRENCES);
    if (replaceAll && occurrence !== undefined) {
      error("PATCH_INVALID", `patches[${index}] cannot combine replaceAll and occurrence`);
    }

    const key = JSON.stringify({ find: value.find, replace: value.replace, replaceAll, occurrence });
    if (seen.has(key)) error("PATCH_DUPLICATE", "duplicate patch entries are not allowed");
    seen.add(key);

    normalized.push({ find: value.find, replace: value.replace, replaceAll, occurrence });
  }

  return normalized;
}

function applyPatchOperations(input: string, patches: NormalizedPatch[], conflicts: MutationConflict[]) {
  let text = input;
  for (const patch of patches) {
    const matches = text.split(patch.find);
    if (matches.length === 1) {
      conflicts.push({ code: "PATCH_MISS", path: "", message: "patch find text not found", details: { find: patch.find } });
      continue;
    }

    const count = matches.length - 1;
    if (!patch.replaceAll && patch.occurrence === undefined && count > 1) {
      conflicts.push({
        code: "PATCH_AMBIGUOUS",
        path: "",
        message: "patch text is ambiguous",
        details: { find: patch.find, occurrences: count }
      });
      continue;
    }

    if (patch.replaceAll) {
      text = text.split(patch.find).join(patch.replace);
      continue;
    }

    const target = patch.occurrence ?? 1;
    if (target > count) {
      conflicts.push({
        code: "PATCH_OCCURRENCE_MISS",
        path: "",
        message: "patch occurrence not present",
        details: { find: patch.find, occurrence: target, total: count }
      });
      continue;
    }

    let cursor = -1;
    for (let index = 0; index < target; index += 1) {
      cursor = text.indexOf(patch.find, cursor + 1);
      if (cursor < 0) break;
    }
    if (cursor < 0) {
      conflicts.push({
        code: "PATCH_OCCURRENCE_MISSING",
        path: "",
        message: "patch occurrence not present",
        details: { find: patch.find, occurrence: target }
      });
      continue;
    }

    text = `${text.slice(0, cursor)}${patch.replace}${text.slice(cursor + patch.find.length)}`;
  }

  return text;
}

function checkOverlap(source: string, destination: string, conflicts: MutationConflict[]) {
  if (source === destination) {
    pushConflict(conflicts, source, "PATH_DUPLICATE", "source and destination are identical");
  }
  if (source.startsWith(`${destination}/`) || destination.startsWith(`${source}/`)) {
    pushConflict(conflicts, source, "PATH_OVERLAP", "source and destination overlap");
  }
}

function readTextFileIfFits(path: string, maxBytes: number, conflicts: MutationConflict[], label: string) {
  try {
    const bytes = readFileSync(path);
    if (bytes.length > maxBytes) {
      pushConflict(conflicts, label, "BUDGET_EXCEEDED", "file exceeds byte ceiling", { bytes: bytes.length, maxBytes });
      return bytes.slice(0, maxBytes + 1).toString("utf8");
    }
    return bytes.toString("utf8");
  } catch (cause) {
    error("FILE_READ_FAILED", "unable to read source file", { path: label, reason: (cause as Error).message });
  }
}

function resolveParent(path: string): string | undefined {
  if (!path.includes("/")) return undefined;
  const index = path.lastIndexOf("/");
  return index <= 0 ? undefined : path.slice(0, index);
}

function isPortableNode(value: unknown): value is MutationNodeState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { path?: unknown; exists?: unknown; kind?: unknown };
  if (typeof candidate.path !== "string" || candidate.path.length === 0) return false;
  if (typeof candidate.exists !== "boolean") return false;
  return candidate.kind === "missing" || candidate.kind === "file" || candidate.kind === "directory";
}

function extractManifestEntries(value: unknown): RestoreManifestEntry[] {
  if (!value || typeof value !== "object") return [];
  const candidate = value as { entries?: unknown };
  if (!Array.isArray(candidate.entries)) return [];
  const entries = candidate.entries;
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as { path?: unknown; before?: unknown; after?: unknown };
    if (typeof raw.path !== "string" || raw.path.length === 0) return [];
    const normalized: RestoreManifestEntry = { path: raw.path };
    if (raw.before && isPortableNode(raw.before)) {
      normalized.before = { ...(raw.before as MutationNodeState) };
    }
    if (raw.after && isPortableNode(raw.after)) {
      normalized.after = { ...(raw.after as MutationNodeState) };
    }
    return [normalized];
  });
}

function resolveTopLevelRoots(paths: string[]) {
  const sorted = [...new Set(paths)].sort((left, right) => left.length - right.length || left.localeCompare(right));
  const roots: string[] = [];
  for (const candidate of sorted) {
    if (roots.some((root) => candidate === root || candidate.startsWith(`${root}/`))) continue;
    roots.push(candidate);
  }
  return roots;
}

type RestoreCheckpointRestoreResult = RestorePreviewResult | RestoreExecutionResult;

export function createWorkspaceMutationTools({
  workspaceRoot = process.cwd(),
  safe = true,
  runLedger,
  coordinator,
  stateDir,
  runId,
  stepId,
  purpose,
  foundation,
  metadata
}: MutationToolOptions = {}) {
  const enforceSafety = safe !== false;
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedStateDir = resolve(stateDir ?? join(resolvedRoot, ".odinn"));
  const inspectPathWithPolicy = (portable: string, options: { requireDigest?: boolean; maxBytes?: number } = {}) =>
    inspectPath(resolvedRoot, portable, options, enforceSafety);
  const resolvePathWithPolicy = (portable: string) => resolveCandidate(resolvedRoot, portable, enforceSafety);
  const collectTreeWithPolicy = (portable: string, limits: MutationLimits, conflicts: MutationConflict[]) =>
    collectDirectoryTree(resolvedRoot, portable, limits, enforceSafety, conflicts);

  async function executeMutation(
    input: AnyRecord,
    preview: MutationPreview,
    mutation: () => Promise<void> | void
  ): Promise<MutationPreview | MutationExecutionResult> {
    const apply = input.apply === true;
    if (!apply || preview.status === "conflict") {
      if (!apply) return preview;
      return applyMutationResult(preview, { applied: false });
    }

    const selectedRunId = runId ?? `mutation-${randomUUID()}`;
    let localRunLedger: RunLedger | undefined;
    const activeRunLedger = runLedger ?? coordinator?.runLedger ?? (localRunLedger = createRunLedger({ workspaceRoot: resolvedRoot, stateDir: resolvedStateDir }));
    const activeCoordinator = coordinator ?? new CheckpointCoordinator({ runLedger: activeRunLedger });
    let publication: MutationPublicationState | undefined;
    let recoverySnapshotId: string | undefined;
    let mutationStarted = false;
    let staleResult: MutationExecutionResult | undefined;
    let completedResult: MutationExecutionResult | undefined;
    let mutationIdentities: MutationIdentities | undefined;

    activeRunLedger.ensureRun({ runId: selectedRunId });

    try {
      await withStateMutationLock(resolvedStateDir, async () => {
        activeCoordinator.assertReady();
        const staleConflicts = ensureNoStaleState({
          root: resolvedRoot,
          entries: preview.entries,
          enforceSafety,
          limits: preview.ceilings
        });
        if (staleConflicts.length > 0) {
          staleResult = applyMutationResult({
            ...preview,
            status: "conflict",
            conflicts: [...preview.conflicts, ...staleConflicts]
          }, { applied: false });
          return;
        }

        mutationIdentities = captureMutationIdentities(resolvedRoot, preview.coveredPaths, enforceSafety);

        publication = {
          ...activeCoordinator.startBoundary({
            runId: selectedRunId,
            stepId,
            purpose: purpose ?? "mutation-group",
            foundation: foundation ?? "agent",
            metadata: metadata ?? {}
          }),
          runId: selectedRunId
        };

        try {
          const recovery = new SnapshotManager({ ledger: activeRunLedger }).create({
            runId: selectedRunId,
            stepId: `mutation-recovery-${publication.boundaryId}`,
            paths: resolveTopLevelRoots(preview.coveredPaths),
            label: `Automatic recovery point before ${preview.operation}`,
            workspaceRoot: resolvedRoot
          });
          recoverySnapshotId = recovery.snapshotId;

          for (const entry of preview.entries) {
            if (entry.before && entry.before.kind === "file" && !entry.before.artifactDigest) {
              try {
                const beforeFile = resolvePathWithPolicy(entry.before.path).absolute;
                const beforeBytes = readFileSync(beforeFile);
                const beforeArtifact = activeRunLedger.artifacts.put(beforeBytes);
                entry.before.artifactDigest = beforeArtifact.digest;
                entry.before.digest = hashValue(beforeBytes);
                entry.before.bytes = beforeBytes.length;
              } catch (cause) {
                throw new OdinnRuntimeError("CHECKPOINT_ARTIFACT_CAPTURE_FAILED", "unable to capture pre-mutation artifact; mutation was not attempted", {
                  path: entry.path,
                  reason: cause instanceof Error ? cause.message : String(cause)
                });
              }
            }
          }

          const recorded = activeCoordinator.recordMutationPreview({
            boundaryId: publication.boundaryId,
            operation: preview.operation,
            stepId,
            preview: {
              ...preview,
              manifest: {
                operation: preview.operation,
                status: preview.status,
                stepId,
                coveredPaths: preview.coveredPaths,
                entries: preview.entries.map((entry) => ({
                  path: entry.path,
                  before: entry.before ? { ...entry.before } : undefined,
                  after: entry.after ? { ...entry.after } : undefined
                }))
              }
            }
          });
          if (recorded.status === "conflict") {
            staleResult = applyMutationResult({
              ...preview,
              status: "conflict",
              conflicts: [...preview.conflicts]
            }, { applied: false, boundaryId: publication.boundaryId });
            return;
          }

          assertMutationIdentities(resolvedRoot, mutationIdentities);
          mutationStarted = true;
          await mutation();
          assertMutationIdentities(resolvedRoot, mutationIdentities, { includeTargets: false });

          const verification = verifyPostWrite({
            root: resolvedRoot,
            preview,
            enforceSafety,
            limits: preview.ceilings
          });
          if (verification.length > 0) {
            throw new OdinnRuntimeError("VERIFICATION_FAILED", "post-write verification failed", { issues: verification });
          }

          const published = activeCoordinator.publishBoundary(publication.boundaryId);
          completedResult = applyMutationResult(preview, {
            applied: true,
            boundaryId: publication.boundaryId,
            checkpointId: published.checkpointId,
            manifestDigest: published.manifestDigest,
            artifactPath: published.artifactPath
          });
        } catch (cause) {
          let failure: unknown = cause;
          if (mutationStarted && recoverySnapshotId) {
            try {
              new SnapshotManager({ ledger: activeRunLedger }).restore(recoverySnapshotId, { apply: true });
            } catch (rollbackCause) {
              failure = new OdinnRuntimeError("MUTATION_RECOVERY_FAILED", "mutation failed and automatic recovery could not restore the workspace", {
                cause: cause instanceof Error ? cause.message : String(cause),
                recovery: rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause)
              });
            }
          }
          if (publication) {
            try {
              activeCoordinator.failBoundary(publication.boundaryId, `mutation failed: ${failure instanceof Error ? failure.message : String(failure)}`);
            } catch {}
          }
          throw failure;
        }
      });

      if (staleResult) return staleResult;
      if (completedResult) return completedResult;
      throw new Error("mutation completed without an execution result");
    } catch (cause) {
      if (cause instanceof OdinnRuntimeError && cause.code === "INPUT_INVALID") throw cause;
      const failed = cause instanceof Error ? cause : new Error(String(cause));
      failed.name = "ODINN_MUTATION_FAIL_CLOSED";
      throw failed;
    } finally {
      localRunLedger?.close();
    }
  }

  const restoreEntryMode = (entry: MutationNodeState, defaultMode = 0o600) => entry.mode ?? defaultMode;

  function normalizeManifestDigest(value: unknown) {
    if (value === undefined) return undefined;
    if (typeof value !== "string") return null;
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || !/^[a-f0-9]{64}$/u.test(trimmed)) return null;
    return trimmed;
  }

  function resolveRestoreArtifact(ledger: RunLedger, digest: string) {
    if (!/^[a-f0-9]{64}$/u.test(digest)) return undefined;
    const artifactPath = join(ledger.artifacts.root, "sha256", digest.slice(0, 2), digest);
    try {
      if (!existsSync(artifactPath) || !lstatSync(artifactPath).isFile()) return undefined;
      const bytes = readFileSync(artifactPath);
      const actual = hashValue(bytes);
      return { bytes, digest: actual, valid: actual === digest };
    } catch {
      return undefined;
    }
  }

  function invertMutationEntries(entries: RestoreManifestEntry[]): RestoreAction[] {
    const inverse: RestoreAction[] = [];
    for (const entry of entries) {
      const before = entry.before;
      const after = entry.after;
      if (!entry.path) continue;

      if (!before && !after) {
        continue;
      }

      if ((before?.exists === false || before == null) && (after?.exists === true && (after.kind === "file" || after.kind === "directory"))) {
        inverse.push({
          path: entry.path,
          before: { ...after },
          after: { path: entry.path, exists: false, kind: "missing" },
          action: after.kind === "directory" ? "remove-directory" : "remove",
          reason: "checkpoint-restore-inverse"
        });
        continue;
      }

      if ((after?.exists === false || after == null) && (before?.exists === true && (before.kind === "file" || before.kind === "directory"))) {
        inverse.push({
          path: entry.path,
          before: { path: entry.path, exists: false, kind: "missing" },
          after: { ...before },
          action: before.kind === "directory" ? "restore-directory" : "restore",
          reason: "checkpoint-restore-inverse"
        });
        continue;
      }

      if (before?.kind === "file" && after?.kind === "file") {
        if (before.digest === after.digest && before.mode === after.mode) {
          continue;
        }
        inverse.push({
          path: entry.path,
          before: { ...after },
          after: { ...before },
          action: "modify",
          reason: "checkpoint-restore-inverse"
        });
        continue;
      }

      if (before?.kind === "directory" && after?.kind === "directory") {
        if (before.mode === after.mode) {
          continue;
        }
        inverse.push({
          path: entry.path,
          before: { ...after },
          after: { ...before },
          action: "mode",
          reason: "checkpoint-restore-inverse"
        });
      }
    }
    return inverse;
  }

  async function executeCheckpointRestore(
    input: AnyRecord,
    checkpointId: string,
    manifestDigest: string | undefined,
    baseConflicts: MutationConflict[] = []
  ): Promise<RestoreCheckpointRestoreResult> {
    const apply = input.apply === true;
    const selectedRunId = runId ?? `checkpoint-restore-${checkpointId}`;
    const normalizedDigest = normalizeManifestDigest(manifestDigest);
    if (manifestDigest !== undefined && normalizedDigest === null) {
      error("INPUT_INVALID", "checkpointManifestDigest must be a SHA-256 hex string");
    }

    const resolvedDigest = normalizedDigest === null ? undefined : normalizedDigest;
    let localRunLedger: RunLedger | undefined;
    const activeRunLedger = runLedger ?? coordinator?.runLedger ?? (localRunLedger = createRunLedger({ workspaceRoot: resolvedRoot, stateDir: resolvedStateDir }));
    const activeCoordinator = coordinator ?? new CheckpointCoordinator({ runLedger: activeRunLedger });
    const plan = activeCoordinator.planCheckpointRestore(checkpointId, resolvedDigest);

    const manifestEntries: RestoreManifestEntry[] = [];
    const previewConflicts: MutationConflict[] = [];
    for (const journalEntry of plan.journal) {
      const entries = extractManifestEntries(journalEntry.manifest);
      if (entries.length === 0) {
        previewConflicts.push({
          code: "EMPTY_MANIFEST",
          path: journalEntry.id,
          message: "restore manifest entry is empty",
          details: { operation: journalEntry.operation }
        });
      }
      for (const entry of entries) manifestEntries.push(entry);
    }

    const inverseActions = manifestEntries.slice().reverse().flatMap((entry) => invertMutationEntries([entry]));
    const inverseByPath = new Map<string, number>();
    const restorePreviewEntries: RestorePreviewResult["entries"] = [];
    const usage = { paths: 0, files: 0, bytes: 0 };
    const planConflicts: MutationConflict[] = [];

    for (const action of inverseActions) {
      inverseByPath.set(action.path, (inverseByPath.get(action.path) ?? 0) + 1);
      if (inverseByPath.get(action.path)! > 1) {
        planConflicts.push({
          code: "COVERED_PATH_CONFLICT",
          path: action.path,
          message: "restore action path appears more than once in inverse plan"
        });
      }
      if (action.after.kind === "file") {
        usage.files += 1;
        usage.bytes += action.after.bytes ?? 0;
      }
      if (action.after.kind === "file" && action.after.artifactDigest) {
        const resolved = resolveRestoreArtifact(activeRunLedger, action.after.artifactDigest);
        if (!resolved) {
          previewConflicts.push({
            code: "ARTIFACT_MISSING",
            message: "restore target artifact is missing",
            path: action.path,
            details: { digest: action.after.artifactDigest }
          });
        } else if (!resolved.valid) {
          previewConflicts.push({
            code: "ARTIFACT_CORRUPT",
            message: "restore target artifact digest mismatch",
            path: action.path,
            details: { digest: action.after.artifactDigest }
          });
        }
      }
      if (action.after.kind === "file" && action.after.digest === undefined && action.after.artifactDigest) {
        previewConflicts.push({
          code: "DIGEST_MISSING",
          message: "restore target file lacks digest record",
          path: action.path
        });
      }

      if (action.before.kind === action.after.kind && action.before.digest === action.after.digest && action.before.exists === action.after.exists && action.before.mode === action.after.mode) {
        continue;
      }
      restorePreviewEntries.push({
        path: action.path,
        before: { ...action.before },
        after: { ...action.after },
        action: action.action,
        resultDigest: action.after.digest
      });
    }

    const restorePreview: RestorePreviewResult = {
      ok: true,
      preview: true,
      operation: "checkpoint.restore",
      status: previewConflicts.length || baseConflicts.length || planConflicts.length || plan.conflicts.length ? "conflict" : "ready",
      ceilings: { maxBytes: DEFAULT_MUTATION_MAX_BYTES, maxFiles: DEFAULT_MUTATION_MAX_FILES },
      usage: { paths: restorePreviewEntries.length, files: usage.files, bytes: usage.bytes },
      coveredPaths: inverseActions.map((action) => action.path),
      entries: restorePreviewEntries,
      conflicts: [...baseConflicts, ...previewConflicts, ...plan.conflicts, ...planConflicts],
      checkpointId,
      manifestDigest: plan.manifestDigest,
      checkpointRunId: plan.runId,
      externalEffects: false
    };

    if (!apply) return restorePreview;
    if (resolvedDigest === undefined) {
      restorePreview.status = "conflict";
      restorePreview.conflicts = [...restorePreview.conflicts, {
        code: "MANIFEST_DIGEST_REQUIRED",
        path: checkpointId,
        message: "checkpointManifestDigest is required when applying a restore"
      }];
    }
    if (restorePreview.status === "conflict") return { ...restorePreview, apply: true, applied: false };
    activeCoordinator.assertReady();
    activeRunLedger.ensureRun({ runId: selectedRunId });
    let publication: MutationPublicationState | undefined;
    let recoveryCheckpointId: string | undefined;
    let staleResult: RestoreCheckpointRestoreResult | undefined;
    let completedResult: RestoreExecutionResult | undefined;
    let mutationStarted = false;
    let mutationIdentities: MutationIdentities | undefined;
    try {
      await withStateMutationLock(resolvedStateDir, async () => {
        activeCoordinator.assertReady();
        const staleConflicts = ensureNoStaleState({
          root: resolvedRoot,
          entries: restorePreviewEntries.map((entry) => ({ path: entry.path, before: entry.before, after: entry.after })),
          enforceSafety,
          limits: restorePreview.ceilings
        });
        if (staleConflicts.length > 0) {
          staleResult = {
            ...restorePreview,
            status: "conflict",
            conflicts: [...restorePreview.conflicts, ...staleConflicts],
            apply: true,
            applied: false
          };
          return;
        }

        mutationIdentities = captureMutationIdentities(resolvedRoot, restorePreview.coveredPaths, enforceSafety);

        const recoveryRoots = resolveTopLevelRoots(inverseActions.map((action) => action.path));
        const snapshotter = new SnapshotManager({ ledger: activeRunLedger });
        const recovery = snapshotter.create({
          runId: selectedRunId,
          stepId: `checkpoint-restore-recovery-${checkpointId}`,
          paths: recoveryRoots,
          label: `Automatic recovery point before restoring ${checkpointId}`,
          workspaceRoot: resolvedRoot
        });
        recoveryCheckpointId = recovery.snapshotId;

        publication = {
          ...activeCoordinator.startBoundary({
            runId: selectedRunId,
            stepId,
            purpose: "restore",
            foundation: foundation ?? "agent",
            metadata: metadata ?? {}
          }),
          runId: selectedRunId
        };

        try {
          const restoreMutationPreview: MutationPreview = {
            ok: true,
            preview: true,
            operation: "checkpoint.restore",
            status: restorePreview.status,
            ceilings: restorePreview.ceilings,
            usage: restorePreview.usage,
            coveredPaths: restorePreview.coveredPaths,
            entries: restorePreview.entries.map((entry) => ({ path: entry.path, before: entry.before, after: entry.after })),
            conflicts: restorePreview.conflicts
          };
          activeCoordinator.recordMutationPreview({
            boundaryId: publication.boundaryId,
            operation: "checkpoint.restore",
            stepId,
            preview: restoreMutationPreview
          });

          assertMutationIdentities(resolvedRoot, mutationIdentities);
          mutationStarted = true;
          const applyActions = inverseActions.slice().sort((left, right) => {
            const rank = (action: RestoreAction) => {
              if (action.action === "restore-directory" || action.action === "restore" || action.action === "modify" || action.action === "mode") return 0;
              return action.action === "remove" ? 1 : 2;
            };
            const leftRank = rank(left);
            const rightRank = rank(right);
            if (leftRank !== rightRank) return leftRank - rightRank;

            const leftDepth = left.path.split("/").length;
            const rightDepth = right.path.split("/").length;
            if (left.path === right.path) return 0;
            if (left.action === "remove" || left.action === "remove-directory") {
              return rightDepth - leftDepth;
            }
            return leftDepth - rightDepth;
          });

          for (const action of applyActions) {
            const destination = resolveCandidate(resolvedRoot, action.path, enforceSafety).absolute;
            if (action.action === "restore-directory") {
              if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
              mkdirSync(destination, { recursive: true, mode: restoreEntryMode(action.after, action.before.mode) });
              continue;
            }
            if (action.action === "remove-directory") {
              if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
              continue;
            }
            if (action.action === "mode") {
              if (action.after.kind === "directory") {
                if (existsSync(destination)) chmodSync(destination, action.after.mode ?? 0o755);
                continue;
              }
            }
            if (action.action === "remove") {
              if (existsSync(destination)) removeAtomically(destination);
              continue;
            }
            if (action.action === "modify" || action.action === "restore") {
              if (action.after.kind !== "file") continue;
              const artifact = action.after.artifactDigest ? resolveRestoreArtifact(activeRunLedger, action.after.artifactDigest) : undefined;
              if (!artifact) throw new Error(`restore artifact unavailable for ${action.path}`);
              if (existsSync(destination)) removeAtomically(destination);
              const parent = dirname(destination);
              if (parent !== resolvedRoot) mkdirSync(parent, { recursive: true });
              writeAtomically(destination, artifact.bytes, restoreEntryMode(action.after, action.before.mode));
              continue;
            }
          }

          assertMutationIdentities(resolvedRoot, mutationIdentities, { includeTargets: false });

          const verification = verifyPostWrite({
            root: resolvedRoot,
            preview: {
              ok: true,
              preview: true,
              operation: "checkpoint.restore",
              status: "ready",
              ceilings: restorePreview.ceilings,
              usage: restorePreview.usage,
              coveredPaths: restorePreview.coveredPaths,
              entries: restorePreview.entries.map((entry) => ({ path: entry.path, before: entry.before, after: entry.after })),
              conflicts: restorePreview.conflicts
            },
            enforceSafety,
            limits: restorePreview.ceilings
          });
          if (verification.length > 0) {
            throw new OdinnRuntimeError("VERIFICATION_FAILED", "restore verification failed", { issues: verification });
          }

          const published = activeCoordinator.publishBoundary(publication.boundaryId);
          activeRunLedger.appendEvent({
            runId: selectedRunId,
            type: "checkpoint-restore",
            payload: {
              checkpointId,
              manifestDigest: plan.manifestDigest,
              applied: true,
              recoveryCheckpointId,
              externalEffects: false
            }
          });

          completedResult = {
            ok: true,
            preview: false,
            operation: "checkpoint.restore",
            status: "ready",
            ceilings: restorePreview.ceilings,
            usage: restorePreview.usage,
            coveredPaths: restorePreview.coveredPaths,
            conflicts: restorePreview.conflicts,
            entries: restorePreview.entries.map((entry) => ({ path: entry.path, before: entry.before, after: entry.after })),
            apply: true,
            applied: true,
            boundaryId: publication.boundaryId,
            checkpointId: published.checkpointId,
            manifestDigest: published.manifestDigest ?? plan.manifestDigest,
            checkpointRunId: restorePreview.checkpointRunId,
            recoveryCheckpointId,
            externalEffects: false
          };
        } catch (cause) {
          let failure: unknown = cause;
          if (mutationStarted && recoveryCheckpointId) {
            try {
              snapshotter.restore(recoveryCheckpointId, { apply: true });
            } catch (rollbackCause) {
              failure = new OdinnRuntimeError("RESTORE_RECOVERY_FAILED", "restore failed and automatic recovery could not restore the workspace", {
                cause: cause instanceof Error ? cause.message : String(cause),
                recovery: rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause)
              });
            }
          }
          if (publication) {
            try {
              activeCoordinator.failBoundary(publication.boundaryId, `checkpoint restore failed: ${failure instanceof Error ? failure.message : String(failure)}`);
            } catch {}
          }
          throw failure;
        }
      });
      if (staleResult) return staleResult;
      if (completedResult) return completedResult;
      throw new Error("restore completed without an execution result");
    } catch (cause) {
      const failed = cause instanceof OdinnRuntimeError ? cause : new Error(cause instanceof Error ? cause.message : String(cause));
      failed.name = failed.name === "Error" ? "ODINN_CHECKPOINT_RESTORE_FAIL_CLOSED" : failed.name;
      throw failed;
    } finally {
      localRunLedger?.close();
    }
  }

  async function executeLegacySnapshotCreate(input: AnyRecord, requestRunId?: string) {
    const selectedRunId = typeof input.snapshotRunId === "string" && input.snapshotRunId.trim()
      ? input.snapshotRunId.trim()
      : requestRunId ?? runId ?? (typeof input.runId === "string" ? input.runId : `snapshot-${randomUUID()}`);
    let localRunLedger: RunLedger | undefined;
    const activeRunLedger = runLedger ?? coordinator?.runLedger ?? (localRunLedger = createRunLedger({ workspaceRoot: resolvedRoot, stateDir: resolvedStateDir }));
    const activeCoordinator = coordinator ?? new CheckpointCoordinator({ runLedger: activeRunLedger });
    activeRunLedger.ensureRun({ runId: selectedRunId });
    try {
      return await withStateMutationLock(resolvedStateDir, async () => {
        activeCoordinator.assertReady();
        return new SnapshotManager({ ledger: activeRunLedger }).create({
          runId: selectedRunId,
          stepId: typeof input.stepId === "string" ? input.stepId : undefined,
          paths: input.paths,
          label: typeof input.label === "string" ? input.label : undefined,
          workspaceRoot: resolvedRoot
        });
      });
    } finally {
      localRunLedger?.close();
    }
  }

  async function executeLegacySnapshotRestore(input: AnyRecord, requestRunId?: string) {
    const snapshotId = typeof input.snapshotId === "string" && input.snapshotId.trim()
      ? input.snapshotId.trim()
      : error("INPUT_INVALID", "snapshotId must be a non-empty string");
    const selectedRunId = requestRunId ?? runId ?? `snapshot-restore-${snapshotId}`;
    let localRunLedger: RunLedger | undefined;
    const activeRunLedger = runLedger ?? coordinator?.runLedger ?? (localRunLedger = createRunLedger({ workspaceRoot: resolvedRoot, stateDir: resolvedStateDir }));
    const activeCoordinator = coordinator ?? new CheckpointCoordinator({ runLedger: activeRunLedger });
    activeRunLedger.ensureRun({ runId: selectedRunId });
    try {
      return await withStateMutationLock(resolvedStateDir, async () => {
        activeCoordinator.assertReady();
        const snapshotter = new SnapshotManager({ ledger: activeRunLedger });
        const plan = snapshotter.plan(snapshotId);
        const preview = snapshotter.restore(snapshotId, { apply: false });
        if (input.apply !== true) return preview;

        const coveredPaths = [...new Set([
          ...plan.roots.map((entry: AnyRecord) => String(entry.path ?? "")),
          ...plan.entries.map((entry: AnyRecord) => String(entry.path ?? ""))
        ])];
        const identities = captureMutationIdentities(resolvedRoot, coveredPaths, enforceSafety);
        const publication = {
          ...activeCoordinator.startBoundary({
            runId: selectedRunId,
            purpose: "legacy-snapshot-restore",
            foundation: foundation ?? "operator",
            metadata: { ...(metadata ?? {}), snapshotId }
          }),
          runId: selectedRunId
        };

        try {
          activeCoordinator.recordMutationPreview({
            boundaryId: publication.boundaryId,
            operation: "snapshot.restore",
            stepId,
            preview: {
              preview: true,
              operation: "snapshot.restore",
              status: "ready",
              coveredPaths,
              conflicts: [],
              payload: { snapshotId, apply: true },
              manifest: {
                operation: "snapshot.restore",
                snapshotId,
                coveredPaths,
                roots: plan.roots.map((entry: AnyRecord) => ({ path: entry.path, existed: entry.existed, type: entry.type })),
                entries: plan.entries.map((entry: AnyRecord) => ({ path: entry.path, existed: entry.existed, digest: entry.digest, artifactDigest: entry.artifact_digest }))
              }
            }
          });
          assertMutationIdentities(resolvedRoot, identities);
          const result = snapshotter.restore(snapshotId, { apply: true, runId: selectedRunId });
          assertMutationIdentities(resolvedRoot, identities, { includeTargets: false });
          const published = activeCoordinator.publishBoundary(publication.boundaryId);
          return {
            ...result,
            boundaryId: publication.boundaryId,
            checkpointId: published.checkpointId,
            manifestDigest: published.manifestDigest,
            artifactPath: published.artifactPath
          };
        } catch (cause) {
          try {
            activeCoordinator.failBoundary(publication.boundaryId, `legacy snapshot restore failed: ${cause instanceof Error ? cause.message : String(cause)}`);
          } catch {}
          throw cause;
        }
      });
    } finally {
      localRunLedger?.close();
    }
  }

  return {
    "snapshot.create": {
      capability: "restore.create",
      description: "Create a governed legacy workspace snapshot for later restore.",
      inputSchema: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 256 },
          stepId: { type: "string" },
          label: { type: "string" }
        },
        required: ["paths"]
      },
      execute: async (input: AnyRecord, context: AnyRecord = {}) => executeLegacySnapshotCreate(input, typeof (context.request as AnyRecord | undefined)?.id === "string" ? (context.request as AnyRecord).id as string : undefined)
    },
    "snapshot.restore": {
      capability: "restore.apply",
      description: "Preview or apply a legacy snapshot restore through the governed admission boundary.",
      inputSchema: {
        type: "object",
        properties: {
          snapshotId: { type: "string" },
          apply: { type: "boolean" }
        },
        required: ["snapshotId"]
      },
      execute: async (input: AnyRecord, context: AnyRecord = {}) => executeLegacySnapshotRestore(input, typeof (context.request as AnyRecord | undefined)?.id === "string" ? (context.request as AnyRecord).id as string : undefined)
    },
    "checkpoint.restore": {
      capability: "checkpoint.restore",
      description: "Preview or apply a bounded checkpoint restore with conflict checks and pre-restore recovery snapshotting.",
      inputSchema: {
        type: "object",
        properties: {
          checkpointId: { type: "string" },
          checkpointManifestDigest: { type: "string" },
          apply: { type: "boolean" }
        },
        required: ["checkpointId"]
      },
      execute: async (input: AnyRecord) => {
        const checkpointId = typeof input.checkpointId === "string" && input.checkpointId.trim().length > 0
          ? input.checkpointId.trim()
          : error("INPUT_INVALID", "checkpointId must be a non-empty string");
        const checkpointManifestDigest = typeof input.checkpointManifestDigest === "string" ? input.checkpointManifestDigest : undefined;
        return executeCheckpointRestore(input, checkpointId, checkpointManifestDigest);
      }
    },
    "workspace.write": {
      capability: "workspace.write",
      description: "Preview a bounded write with strict parent and expected-state checks.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          mode: { type: "integer" },
          expected: { type: "object" },
          apply: { type: "boolean" },
          maxBytes: { type: "integer" },
          maxFiles: { type: "integer" }
        },
        required: ["path", "content"]
      },
      execute: async (input: AnyRecord) => {
        const limits = normalizeLimits(input);
        const conflicts: MutationConflict[] = [];

        const path = normalizePortablePath("path", input.path);
        const content = typeof input.content === "string" ? input.content : error("INPUT_INVALID", "content must be a string");
        const mode = normalizeMode(input.mode);
        const expected = normalizeExpectedState(input.expected);

        const before = inspectPathWithPolicy(path, { requireDigest: true, maxBytes: limits.maxBytes });
        addExpectedConflicts(path, before, expected, conflicts);

        if (before.exists && before.kind !== "file") {
          pushConflict(conflicts, path, "TYPE_MISMATCH", "write target is not a file", { actual: before.kind });
        }

        const parent = resolveParent(path);
        if (parent && parent.length > 0) {
          const parentState = inspectPathWithPolicy(parent, { maxBytes: limits.maxBytes });
          if (!parentState.exists || parentState.kind !== "directory") {
            pushConflict(conflicts, path, "PARENT_INVALID", "parent directory missing or not a directory", { parent });
          }
        }

        const bytes = Buffer.byteLength(content, "utf8");
        if (bytes > limits.maxBytes) {
          pushConflict(conflicts, path, "BUDGET_EXCEEDED", "content exceeds maxBytes", { bytes, maxBytes: limits.maxBytes });
        }

        const after: MutationNodeState = {
          path,
          exists: true,
          kind: "file",
          mode,
          bytes,
          digest: hashValue(Buffer.from(content, "utf8"))
        };

      const preview = finalizePreview("workspace.write", limits, [{ path, before, after, expected, resultDigest: after.digest }], conflicts);
      return executeMutation(input, preview, () => {
        const { absolute } = resolvePathWithPolicy(path);
        writeAtomically(absolute, Buffer.from(content, "utf8"), mode);
      });
    }
  },
    "workspace.edit": {
      capability: "workspace.edit",
      description: "Preview a bounded in-file find-and-replace edit with deterministic conflicts.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          find: { type: "string" },
          replace: { type: "string" },
          replaceAll: { type: "boolean" },
          expected: { type: "object" },
          apply: { type: "boolean" },
          maxBytes: { type: "integer" },
          maxFiles: { type: "integer" }
        },
        required: ["path", "find", "replace"]
      },
      execute: async (input: AnyRecord) => {
        const limits = normalizeLimits(input);
        const conflicts: MutationConflict[] = [];

        const path = normalizePortablePath("path", input.path);
        if (typeof input.find !== "string" || input.find.length === 0) {
          error("INPUT_INVALID", "find must be a non-empty string");
        }
        if (typeof input.replace !== "string") {
          error("INPUT_INVALID", "replace must be a string");
        }

        const expected = normalizeExpectedState(input.expected);
        const replaceAll = input.replaceAll === true;
        let before = inspectPathWithPolicy(path, { requireDigest: true, maxBytes: limits.maxBytes });

        if (before.kind !== "file") {
          pushConflict(conflicts, path, "TYPE_MISMATCH", "edit target is not a file", { actual: before.kind });
        }
        addExpectedConflicts(path, before, expected, conflicts);

        let sourceText = "";
        let afterText = "";
        let after: MutationNodeState = before;

        if (before.exists && before.kind === "file") {
          const { absolute } = resolvePathWithPolicy(path);
          sourceText = readTextFileIfFits(absolute, limits.maxBytes, conflicts, path);
          const occurrences = sourceText.split(input.find as string).length - 1;
          if (occurrences === 0) {
            pushConflict(conflicts, path, "EDIT_NOT_FOUND", "find text not present", { find: input.find });
          } else if (!replaceAll && occurrences > 1) {
            pushConflict(conflicts, path, "EDIT_AMBIGUOUS", "find text is ambiguous", { find: input.find, occurrences });
          }

          if (occurrences > 0) {
            afterText = replaceAll
              ? sourceText.split(input.find as string).join(input.replace as string)
              : sourceText.replace(input.find as string, input.replace as string);
            if (Buffer.byteLength(afterText, "utf8") !== before.bytes) {
              after = {
                path,
                exists: true,
                kind: "file",
                mode: before.mode,
                bytes: Buffer.byteLength(afterText, "utf8"),
                digest: hashValue(Buffer.from(afterText, "utf8"))
              };
            } else {
              after = {
                path,
                exists: true,
                kind: "file",
                mode: before.mode,
                bytes: before.bytes,
                digest: hashValue(Buffer.from(afterText, "utf8"))
              };
            }
          }
        }

        if ((after.bytes ?? 0) > limits.maxBytes) {
          pushConflict(conflicts, path, "BUDGET_EXCEEDED", "result exceeds byte ceiling", { bytes: after.bytes, maxBytes: limits.maxBytes });
        }

        const preview = finalizePreview("workspace.edit", limits, [{ path, before, after, expected, resultDigest: after.digest }], conflicts);
        return executeMutation(input, preview, () => {
          if (after.kind !== "file") {
            error("TYPE_MISMATCH", "edit target is not a file", { path });
          }
          const { absolute } = resolvePathWithPolicy(path);
          writeAtomically(absolute, Buffer.from(afterText, "utf8"), before.mode ?? 0o600);
        });
      }
    },
    "workspace.applyPatch": {
      capability: "workspace.applyPatch",
      description: "Preview a bounded patch set against one file with overlap and stale-edit checks.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          patches: { type: "array", minItems: 1, maxItems: MAX_PATCH_COUNT },
          expected: { type: "object" },
          apply: { type: "boolean" },
          maxBytes: { type: "integer" },
          maxFiles: { type: "integer" }
        },
        required: ["path", "patches"]
      },
      execute: async (input: AnyRecord) => {
        const limits = normalizeLimits(input);
        const conflicts: MutationConflict[] = [];

        const path = normalizePortablePath("path", input.path);
        const patches = parsePatchList(input.patches);
        const expected = normalizeExpectedState(input.expected);

        const before = inspectPathWithPolicy(path, { requireDigest: true, maxBytes: limits.maxBytes });
        addExpectedConflicts(path, before, expected, conflicts);

        let sourceText = "";
        if (before.exists && before.kind === "file") {
          const absolute = resolvePathWithPolicy(path).absolute;
          sourceText = readTextFileIfFits(absolute, limits.maxBytes, conflicts, path);
        } else {
          pushConflict(conflicts, path, "TYPE_MISMATCH", "patch target must be a file", { actual: before.kind });
        }

        const patched = applyPatchOperations(sourceText, patches, conflicts);
        const afterBytes = Buffer.byteLength(patched, "utf8");
        const after: MutationNodeState = before.kind !== "file"
          ? before
          : {
              path,
              exists: true,
              kind: "file",
              mode: before.mode,
              bytes: afterBytes,
              digest: hashValue(Buffer.from(patched, "utf8"))
            };

        if (afterBytes > limits.maxBytes) {
          pushConflict(conflicts, path, "BUDGET_EXCEEDED", "result exceeds byte ceiling", { bytes: afterBytes, maxBytes: limits.maxBytes });
        }

        const preview = finalizePreview("workspace.applyPatch", limits, [{ path, before, after, expected, resultDigest: after.digest }], conflicts);
        return executeMutation(input, preview, () => {
          const { absolute } = resolvePathWithPolicy(path);
          if (after.kind !== "file") {
            error("TYPE_MISMATCH", "patch target is not a file", { path });
          }
          writeAtomically(absolute, Buffer.from(patched, "utf8"), before.mode ?? 0o600);
        });
      }
    },
    "workspace.mkdir": {
      capability: "workspace.mkdir",
      description: "Preview a bounded directory creation with parent validation and overlap checks.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          mode: { type: "integer" },
          expected: { type: "object" },
          apply: { type: "boolean" },
          maxBytes: { type: "integer" },
          maxFiles: { type: "integer" }
        },
        required: ["path"]
      },
      execute: async (input: AnyRecord) => {
        const limits = normalizeLimits(input);
        const conflicts: MutationConflict[] = [];

        const path = normalizePortablePath("path", input.path);
        const mode = normalizeMode(input.mode);
        const expected = normalizeExpectedState(input.expected);

        const before = inspectPathWithPolicy(path, { maxBytes: limits.maxBytes });
        addExpectedConflicts(path, before, expected, conflicts);

        if (before.exists && before.kind !== "directory") {
          pushConflict(conflicts, path, "TYPE_MISMATCH", "path exists and is not a directory", { actual: before.kind });
        }

        const parent = resolveParent(path);
        if (parent && parent.length > 0) {
          const parentState = inspectPathWithPolicy(parent, { maxBytes: limits.maxBytes });
          if (!parentState.exists || parentState.kind !== "directory") {
            pushConflict(conflicts, path, "PARENT_INVALID", "parent directory missing or not a directory", { parent });
          }
        }

        const after: MutationNodeState = {
          path,
          exists: true,
          kind: "directory",
          mode
        };

        const preview = finalizePreview("workspace.mkdir", limits, [{ path, before, after, expected }], conflicts);
        return executeMutation(input, preview, () => {
          const { absolute } = resolvePathWithPolicy(path);
          mkdirSync(absolute, { mode, recursive: false });
        });
      }
    },
    "workspace.remove": {
      capability: "workspace.remove",
      description: "Preview a deterministic removal plan with overlap-safe recursive behavior.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          recursive: { type: "boolean" },
          expected: { type: "object" },
          apply: { type: "boolean" },
          maxBytes: { type: "integer" },
          maxFiles: { type: "integer" }
        },
        required: ["path"]
      },
      execute: async (input: AnyRecord) => {
        const limits = normalizeLimits(input);
        const conflicts: MutationConflict[] = [];
        const path = normalizePortablePath("path", input.path);
        const recursive = input.recursive !== false;
        const expected = normalizeExpectedState(input.expected);

        const before = inspectPathWithPolicy(path, { requireDigest: true, maxBytes: limits.maxBytes });
        addExpectedConflicts(path, before, expected, conflicts);
        const entries: MutationPreview["entries"] = [{ path, before, after: { path, exists: false, kind: "missing" }, expected }];

        if (!before.exists) {
          return finalizePreview("workspace.remove", limits, entries, conflicts);
        }

        if (before.kind === "directory") {
          if (!recursive) {
          const children = readdirSync(resolvePathWithPolicy(path).absolute);
            if (children.length > 0) {
              pushConflict(conflicts, path, "DIRECTORY_NOT_EMPTY", "directory is not empty", { recursive: false });
            }
          }
          const tree = collectTreeWithPolicy(path, limits, conflicts);
          for (const child of tree.entries.slice(1)) {
            entries.push({ path: child.path, before: child, after: { path: child.path, exists: false, kind: "missing" }, expected: {} });
          }
        }

        const preview = finalizePreview("workspace.remove", limits, entries, conflicts);
        return executeMutation(input, preview, () => {
          if (before.exists) removeAtomically(resolvePathWithPolicy(path).absolute);
        });
      }
    },
    "workspace.move": {
      capability: "workspace.move",
      description: "Preview a bounded move with destination checks and overlap protection.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          overwrite: { type: "boolean" },
          expectedSource: { type: "object" },
          expectedDestination: { type: "object" },
          apply: { type: "boolean" },
          maxBytes: { type: "integer" },
          maxFiles: { type: "integer" }
        },
        required: ["from", "to"]
      },
      execute: async (input: AnyRecord) => {
        const limits = normalizeLimits(input);
        const conflicts: MutationConflict[] = [];

        const sourcePath = normalizePortablePath("from", input.from);
        const destinationPath = normalizePortablePath("to", input.to);
        const overwrite = input.overwrite === true;
        const expectedSource = normalizeExpectedState(input.expectedSource);
        const expectedDestination = normalizeExpectedState(input.expectedDestination);

        checkOverlap(sourcePath, destinationPath, conflicts);

        const sourceState = inspectPathWithPolicy(sourcePath, { requireDigest: true, maxBytes: limits.maxBytes });
        const destinationState = inspectPathWithPolicy(destinationPath, { requireDigest: true, maxBytes: limits.maxBytes });

        addExpectedConflicts(sourcePath, sourceState, expectedSource, conflicts);
        addExpectedConflicts(destinationPath, destinationState, expectedDestination, conflicts);

        if (destinationState.exists && !overwrite) {
          pushConflict(conflicts, destinationPath, "DESTINATION_EXISTS", "destination exists and overwrite is disabled");
        }

        const destinationParent = resolveParent(destinationPath);
        if (destinationParent && destinationParent.length > 0) {
          const destinationParentState = inspectPathWithPolicy(destinationParent, { maxBytes: limits.maxBytes });
          if (!destinationParentState.exists || destinationParentState.kind !== "directory") {
            pushConflict(conflicts, destinationPath, "PARENT_INVALID", "destination parent is missing or not a directory", { parent: destinationParent });
          }
        }

        const entries: MutationPreview["entries"] = [
          {
            path: sourcePath,
            before: sourceState,
            after: { path: sourcePath, exists: false, kind: "missing" },
            expected: expectedSource
          },
          {
            path: destinationPath,
            before: destinationState,
            after: sourceState.exists ? {
              path: destinationPath,
              exists: true,
              kind: sourceState.kind,
              mode: sourceState.mode,
              bytes: sourceState.bytes,
              digest: sourceState.digest
            } : { path: destinationPath, exists: false, kind: "missing" },
            expected: expectedDestination
          }
        ];

        if (sourceState.exists && sourceState.kind === "directory") {
          const tree = collectTreeWithPolicy(sourcePath, limits, conflicts);
          for (const child of tree.entries.slice(1)) {
            const suffix = child.path.slice(sourcePath.length + 1);
            const movedPath = `${destinationPath}/${suffix}`;
            entries.push({
              path: child.path,
              before: child,
              after: child.kind === "directory"
                ? { ...child, path: movedPath }
                : child.exists
                  ? { path: movedPath, exists: true, kind: child.kind, mode: child.mode, bytes: child.bytes, digest: child.digest }
                  : { path: movedPath, exists: false, kind: "missing" },
              expected: {}
            });
          }
        }

        const preview = finalizePreview("workspace.move", limits, entries, conflicts);
        return executeMutation(input, preview, () => {
          if (!sourceState.exists) return;
          const { absolute: source } = resolvePathWithPolicy(sourcePath);
          const { absolute: destination } = resolvePathWithPolicy(destinationPath);
          moveAtomically(source, destination, overwrite);
        });
      }
    }
  };
}
