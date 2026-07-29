import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

type NodeError = Error & { code?: string };

const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_OUTPUT_BYTES = 128_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function contained(root: string, target: string) {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function physicalWorkspaceRoot(workspaceRoot: string) {
  return resolve(await realpath(resolve(workspaceRoot)));
}

async function resolveExistingWorkspacePath(workspaceRoot: string, candidate: unknown, label: string, allowRoot = false) {
  if (typeof candidate !== "string" || !candidate.trim()) throw new Error(`${label} requires a non-empty path`);
  const root = await physicalWorkspaceRoot(workspaceRoot);
  const lexical = resolve(root, candidate);
  if ((!allowRoot && lexical === root) || !contained(root, lexical)) throw new Error(`${label} path escapes workspace root`);
  const target = resolve(await realpath(lexical));
  if (!contained(root, target)) throw new Error(`${label} path escapes workspace root through a symbolic link`);
  return { root, target, path: relative(root, target).replaceAll("\\", "/") };
}

async function resolveWritableWorkspacePath(workspaceRoot: string, candidate: unknown) {
  if (typeof candidate !== "string" || !candidate.trim()) throw new Error("workspace.writeText requires path");
  const root = await physicalWorkspaceRoot(workspaceRoot);
  const target = resolve(root, candidate);
  if (target === root || !contained(root, target)) throw new Error("workspace.writeText path escapes workspace root");

  let ancestor = target;
  while (ancestor !== root) {
    try {
      const metadata = await lstat(ancestor);
      if (metadata.isSymbolicLink()) throw new Error("workspace.writeText refuses symbolic-link targets");
      const physical = resolve(await realpath(ancestor));
      if (!contained(root, physical)) throw new Error("workspace.writeText path escapes workspace root through a symbolic link");
      break;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeError).code ?? "")) throw error;
      ancestor = dirname(ancestor);
    }
  }
  return { root, target, path: relative(root, target).replaceAll("\\", "/") };
}

export async function readWorkspaceText(workspaceRoot: string, { path, maxBytes = 65_536 }: any = {}) {
  const resolved = await resolveExistingWorkspacePath(workspaceRoot, path, "workspace.readText");
  const limit = boundedInteger(maxBytes, 1, DEFAULT_MAX_FILE_BYTES, 65_536);
  const handle = await open(resolved.target, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("workspace.readText target must be a regular file");
    const buffer = Buffer.alloc(Math.min(limit, metadata.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return {
      path: resolved.path,
      bytes: metadata.size,
      truncated: metadata.size > limit,
      content: buffer.subarray(0, bytesRead).toString("utf8")
    };
  } finally {
    await handle.close();
  }
}

export async function writeWorkspaceText(workspaceRoot: string, { path, content = "", createDirectories = true, maxBytes = DEFAULT_MAX_FILE_BYTES }: any = {}) {
  const resolved = await resolveWritableWorkspacePath(workspaceRoot, path);
  if (typeof content !== "string") throw new Error("workspace.writeText requires string content");
  const limit = boundedInteger(maxBytes, 1, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > limit) throw new Error(`workspace.writeText content exceeds ${limit} bytes`);

  let previousMode = 0o600;
  let created = true;
  try {
    const metadata = await lstat(resolved.target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("workspace.writeText target must be a regular file");
    previousMode = metadata.mode & 0o777;
    created = false;
  } catch (error) {
    if ((error as NodeError).code !== "ENOENT") throw error;
  }

  const parent = dirname(resolved.target);
  if (createDirectories === false) {
    const metadata = await stat(parent);
    if (!metadata.isDirectory()) throw new Error("workspace.writeText parent is not a directory");
  } else {
    await mkdir(parent, { recursive: true, mode: 0o700 });
  }
  const physicalParent = resolve(await realpath(parent));
  if (!contained(resolved.root, physicalParent)) throw new Error("workspace.writeText parent escapes workspace root through a symbolic link");

  const temporary = resolve(parent, `.odinn-write-${randomUUID()}.tmp`);
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: previousMode });
  try {
    await chmod(temporary, previousMode);
    await rename(temporary, resolved.target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    path: resolved.path,
    bytes,
    created,
    sha256: createHash("sha256").update(content).digest("hex")
  };
}

export async function executeWorkspaceProcess(workspaceRoot: string, input: any = {}, signal?: AbortSignal) {
  const command = cleanCommand(input.command);
  const args = cleanArguments(input.args);
  const cwd = await resolveExistingWorkspacePath(workspaceRoot, input.cwd ?? ".", "process.exec", true);
  if (!(await stat(cwd.target)).isDirectory()) throw new Error("process.exec cwd must be a directory");
  const timeoutMs = boundedInteger(input.timeoutMs, 100, 120_000, DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = boundedInteger(input.maxOutputBytes, 1_024, 1_000_000, DEFAULT_MAX_OUTPUT_BYTES);
  const startedAt = Date.now();

  return await new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      cwd: cwd.target,
      env: processEnvironment(),
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let capturedBytes = 0;
    let timedOut = false;
    let outputTruncated = false;
    let settled = false;

    const terminate = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
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
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk, "stderr"));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      rejectProcess(error);
    });
    const abort = () => terminate();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.once("close", (exitCode, childSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        const error = new Error("process.exec cancelled");
        error.name = "AbortError";
        rejectProcess(error);
        return;
      }
      resolveProcess({
        command,
        args,
        cwd: cwd.path,
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
    });
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

function processEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TERM", "CI"];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}
