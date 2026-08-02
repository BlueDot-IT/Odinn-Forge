import { spawn } from "node:child_process";
import { open, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

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

export async function executeWorkspaceProcess(workspaceRoot: string, input: any = {}, signal?: AbortSignal) {
  if (signal?.aborted) throw processCancellationError();
  const command = cleanCommand(input.command);
  const args = cleanArguments(input.args);
  const cwd = await resolveExistingWorkspacePath(workspaceRoot, input.cwd ?? ".", "process.exec", true);
  if (!(await stat(cwd.target)).isDirectory()) throw new Error("process.exec cwd must be a directory");
  const timeoutMs = boundedInteger(input.timeoutMs, 100, 120_000, DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = boundedInteger(input.maxOutputBytes, 1_024, 1_000_000, DEFAULT_MAX_OUTPUT_BYTES);
  const startedAt = Date.now();

  return await new Promise((resolveProcess, rejectProcess) => {
    let child: ReturnType<typeof spawn> | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let capturedBytes = 0;
    let timedOut = false;
    let outputTruncated = false;
    let settled = false;

    const terminate = () => {
      const activeChild = child;
      if (!activeChild?.pid) return;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(activeChild.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
      } else {
        try { process.kill(-activeChild.pid, "SIGKILL"); } catch { activeChild.kill("SIGKILL"); }
      }
    };
    const abort = () => terminate();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      signal.removeEventListener("abort", abort);
      rejectProcess(processCancellationError());
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
      rejectProcess(error);
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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      rejectProcess(error);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    activeChild.once("close", (exitCode, childSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        rejectProcess(processCancellationError());
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

function processCancellationError() {
  const error = new Error("process.exec cancelled");
  error.name = "AbortError";
  return error;
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
