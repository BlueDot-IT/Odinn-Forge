import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const GIT_TIMEOUT_MS = 10_000;
const GIT_STATUS_MAX_BYTES = 1_048_576;
const GIT_DIFF_DEFAULT_BYTES = 65_536;
const GIT_DIFF_MAX_BYTES = 262_144;
const GIT_LOG_MAX_BYTES = 262_144;
const SHA256_REFERENCE = /^sha256:[a-f0-9]{64}$/u;

type GitRunResult = Readonly<{ stdout: Buffer; truncated: boolean }>;
type GitIdentity = Readonly<{ repositoryId: string; worktreeId: string }>;

export type GitDiagnostic = Readonly<{
  available: boolean;
  repository: boolean;
  worktree: boolean;
  readOnly: true;
  networkAccess: false;
  headState: "attached" | "detached" | "unborn" | "unavailable";
}>;

export function gitResourceBinding(workspaceRoot: string, input: Record<string, unknown> = {}): Readonly<Record<string, unknown>> {
  const identity = inspectGitIdentity(workspaceRoot);
  const ref = normalizeGitRef(input.ref);
  const path = normalizeGitPath(input.path, false);
  return Object.freeze({
    ...identity,
    refDigest: digest(ref),
    ...(path === undefined ? {} : { pathDigest: digest(path) })
  });
}

export async function gitStatus(workspaceRoot: string, input: Record<string, unknown> = {}, signal?: AbortSignal) {
  const identity = inspectGitIdentity(workspaceRoot);
  const path = normalizeGitPath(input.path, false);
  const limit = boundedInteger(input.limit, 100, 1, 500, "git.status limit");
  const args = ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignored=no", "--no-renames"];
  args.push("--", path ?? ".", ":(exclude).odinn", ":(exclude).odinn/**");
  const result = await runGit(workspaceRoot, args, { maxBytes: GIT_STATUS_MAX_BYTES, signal });
  const records = completeNulRecords(result.stdout, result.truncated);
  const entries = records.slice(0, limit).map((record) => {
    if (record.length < 4 || record[2] !== " ") throw new Error("git status returned an invalid bounded record");
    const index = record[0]!;
    const worktree = record[1]!;
    const entryPath = record.slice(3);
    if (!entryPath || entryPath.includes("\u0000")) throw new Error("git status returned an invalid path");
    return { path: entryPath, index, worktree };
  });
  const head = await readHead(workspaceRoot, signal);
  return {
    type: "git.status" as const,
    ...identity,
    ...head,
    entries,
    entryCount: entries.length,
    truncated: result.truncated || records.length > limit
  };
}

export async function gitDiff(workspaceRoot: string, input: Record<string, unknown> = {}, signal?: AbortSignal) {
  const identity = inspectGitIdentity(workspaceRoot);
  const path = normalizeGitPath(input.path, false);
  const ref = normalizeGitRef(input.ref);
  const staged = input.staged === true;
  const maxBytes = boundedInteger(input.maxBytes, GIT_DIFF_DEFAULT_BYTES, 1, GIT_DIFF_MAX_BYTES, "git.diff maxBytes");
  const args = [
    "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames",
    ...(staged ? ["--cached"] : []), ref
  ];
  args.push("--", path ?? ".", ":(exclude).odinn", ":(exclude).odinn/**");
  const result = await runGit(workspaceRoot, args, { maxBytes, signal });
  const patch = utf8Prefix(result.stdout, maxBytes);
  const truncated = result.truncated || Buffer.byteLength(patch, "utf8") < result.stdout.byteLength;
  return {
    type: "git.diff" as const,
    ...identity,
    ref,
    staged,
    ...(path === undefined ? {} : { path }),
    patch,
    patchBytes: Buffer.byteLength(patch, "utf8"),
    patchDigest: digest(patch),
    digestComplete: !truncated,
    truncated
  };
}

export async function gitLog(workspaceRoot: string, input: Record<string, unknown> = {}, signal?: AbortSignal) {
  const identity = inspectGitIdentity(workspaceRoot);
  const path = normalizeGitPath(input.path, false);
  const ref = normalizeGitRef(input.ref);
  const limit = boundedInteger(input.limit, 20, 1, 100, "git.log limit");
  const args = [
    "log", "--no-show-signature", "--no-decorate", `--max-count=${limit}`,
    "--format=%H%x00%P%x00%ct%x00%s%x1e", ref
  ];
  args.push("--", path ?? ".", ":(exclude).odinn", ":(exclude).odinn/**");
  const result = await runGit(workspaceRoot, args, { maxBytes: GIT_LOG_MAX_BYTES, signal });
  if (result.truncated) throw new Error("git log exceeded the bounded output limit");
  const commits = result.stdout.toString("utf8").split("\u001e").flatMap((raw) => {
    const record = raw.replace(/^\r?\n/u, "").replace(/\r?\n$/u, "");
    if (!record) return [];
    const fields = record.split("\u0000");
    if (fields.length !== 4) throw new Error("git log returned an invalid bounded record");
    const [oid, parentsRaw, committedAtRaw, subject] = fields as [string, string, string, string];
    if (!/^[a-f0-9]{40,64}$/u.test(oid) || !/^\d{1,16}$/u.test(committedAtRaw)) throw new Error("git log returned invalid commit metadata");
    const parents = parentsRaw ? parentsRaw.split(" ") : [];
    if (parents.some((parent) => !/^[a-f0-9]{40,64}$/u.test(parent))) throw new Error("git log returned invalid parent metadata");
    const committedAt = new Date(Number(committedAtRaw) * 1_000).toISOString();
    return [{ oid, parents, committedAt, subject }];
  });
  return {
    type: "git.log" as const,
    ...identity,
    ref,
    ...(path === undefined ? {} : { path }),
    commits,
    commitCount: commits.length,
    truncated: false
  };
}

export async function diagnoseGitWorkspace(workspaceRoot: string): Promise<GitDiagnostic> {
  try {
    await runGit(workspaceRoot, ["--version"], { maxBytes: 1_024 });
  } catch {
    return { available: false, repository: false, worktree: false, readOnly: true, networkAccess: false, headState: "unavailable" };
  }
  try {
    inspectGitIdentity(workspaceRoot);
    const head = await readHead(workspaceRoot);
    return { available: true, repository: true, worktree: true, readOnly: true, networkAccess: false, headState: head.headState };
  } catch {
    return { available: true, repository: false, worktree: false, readOnly: true, networkAccess: false, headState: "unavailable" };
  }
}

function inspectGitIdentity(workspaceRoot: string): GitIdentity {
  const worktreeRoot = realpathSync(resolve(workspaceRoot));
  const dotGit = join(worktreeRoot, ".git");
  const metadata = lstatSync(dotGit);
  if (metadata.isSymbolicLink()) throw new Error("git metadata must not be a symbolic link");
  let gitDirectory: string;
  if (metadata.isDirectory()) {
    gitDirectory = realpathSync(dotGit);
  } else if (metadata.isFile()) {
    const pointer = readFileSync(dotGit, "utf8");
    if (Buffer.byteLength(pointer, "utf8") > 4_096) throw new Error("git worktree pointer exceeds the bounded limit");
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(pointer);
    if (!match) throw new Error("git worktree pointer is invalid");
    gitDirectory = realpathSync(resolve(worktreeRoot, match[1]!));
  } else {
    throw new Error("workspace root does not contain physical Git metadata");
  }
  const commonPointer = join(gitDirectory, "commondir");
  let commonDirectory = gitDirectory;
  try {
    const value = readFileSync(commonPointer, "utf8");
    if (Buffer.byteLength(value, "utf8") > 4_096 || /[\u0000\r\n].+/u.test(value.trim())) throw new Error("git common-directory pointer is invalid");
    commonDirectory = realpathSync(resolve(gitDirectory, value.trim()));
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return Object.freeze({
    repositoryId: digest(`repository:${commonDirectory}`),
    worktreeId: digest(`worktree:${worktreeRoot}`)
  });
}

async function readHead(workspaceRoot: string, signal?: AbortSignal): Promise<Readonly<{ headState: "attached" | "detached" | "unborn"; headRef?: string; headOid?: string }>> {
  const symbolic = await runGit(workspaceRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], { maxBytes: 1_024, signal, acceptedExitCodes: [0, 1] });
  const oid = await runGit(workspaceRoot, ["rev-parse", "--verify", "HEAD"], { maxBytes: 1_024, signal, acceptedExitCodes: [0, 128] });
  const headRef = symbolic.stdout.toString("utf8").trim();
  const headOid = oid.stdout.toString("utf8").trim();
  if (!headOid) return { headState: "unborn", ...(headRef ? { headRef } : {}) };
  if (!/^[a-f0-9]{40,64}$/u.test(headOid)) throw new Error("git HEAD returned invalid metadata");
  return headRef ? { headState: "attached", headRef, headOid } : { headState: "detached", headOid };
}

async function runGit(workspaceRoot: string, args: readonly string[], options: { maxBytes: number; signal?: AbortSignal; acceptedExitCodes?: readonly number[] }): Promise<GitRunResult> {
  const root = resolve(workspaceRoot);
  const executable = process.env.ODINN_GIT_EXECUTABLE || "git";
  if (process.env.ODINN_GIT_EXECUTABLE && !isAbsolute(executable)) throw new Error("configured Git executable must be an absolute path");
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATHEXT: process.env.PATHEXT,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_ALLOW_PROTOCOL: "file"
  };
  const commandArgs = [
    "--no-pager",
    "-c", "core.fsmonitor=false",
    "-c", "credential.helper=",
    "-c", "diff.external=",
    "-c", "color.ui=false",
    "-C", root,
    ...args
  ];
  return new Promise<GitRunResult>((resolveResult, reject) => {
    if (options.signal?.aborted) return reject(abortError());
    const child = spawn(executable, commandArgs, { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let stderrBytes = 0;
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("git read exceeded the bounded execution timeout"));
    }, GIT_TIMEOUT_MS);
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(abortError());
    };
    const finish = (error?: Error, value?: GitRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolveResult(value!);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (bytes < options.maxBytes) {
        const retained = chunk.subarray(0, Math.max(0, options.maxBytes - bytes));
        chunks.push(retained);
        bytes += retained.byteLength;
      }
      if (bytes >= options.maxBytes && chunk.byteLength > 0) truncated = true;
      if (truncated) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 8_192) return;
      const retained = chunk.subarray(0, 8_192 - stderrBytes);
      stderrChunks.push(retained);
      stderrBytes += retained.byteLength;
    });
    child.on("error", () => finish(new Error("local Git read adapter is unavailable")));
    child.on("close", (code) => {
      if (settled) return;
      const accepted = options.acceptedExitCodes ?? [0];
      if (!truncated && !accepted.includes(code ?? -1)) {
        const category = stderrChunks.length ? "repository or ref is unavailable" : "command failed";
        finish(new Error(`local Git read ${category}`));
        return;
      }
      finish(undefined, { stdout: Buffer.concat(chunks), truncated });
    });
  });
}

function normalizeGitPath(value: unknown, required: boolean): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error("Git path is required");
    return undefined;
  }
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1_024 || /[\u0000-\u001f\u007f\\]/u.test(value)) throw new Error("Git path must be a bounded portable relative path");
  if (isAbsolute(value) || /^[A-Za-z]:/u.test(value)) throw new Error("Git path must be workspace-relative");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || [".git", ".odinn"].includes(segment.toLowerCase()))) throw new Error("Git path is outside the supported workspace file set");
  return segments.join("/");
}

function normalizeGitRef(value: unknown): string {
  if (value === undefined || value === null || value === "") return "HEAD";
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 256 || /[\u0000-\u0020\u007f~^:?*\[\\]/u.test(value)) throw new Error("Git ref is invalid");
  if (value === "HEAD" || /^[a-f0-9]{40,64}$/u.test(value)) return value;
  if (!/^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
    || value.includes("..") || value.includes("@{") || value.includes("//") || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) {
    throw new Error("Git ref must be HEAD, a full object ID, or a full local branch/tag ref");
  }
  return value;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  return Number(value);
}

function completeNulRecords(value: Buffer, truncated: boolean): string[] {
  const records = value.toString("utf8").split("\u0000");
  if (records.at(-1) === "") records.pop();
  else if (truncated) records.pop();
  return records;
}

function utf8Prefix(value: Buffer, maximum: number): string {
  let end = Math.min(maximum, value.byteLength);
  while (end > 0) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(value.subarray(0, end)); }
    catch { end -= 1; }
  }
  return "";
}

function digest(value: string): string {
  const result = `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
  if (!SHA256_REFERENCE.test(result)) throw new Error("Git digest generation failed");
  return result;
}

function abortError(): Error {
  const error = new Error("Git read cancelled");
  error.name = "AbortError";
  return error;
}
