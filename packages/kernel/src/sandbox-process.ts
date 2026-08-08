import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  compileSandboxProfile,
  detectOciBackend,
  OciSandboxBackend,
  SandboxBackendRefusalError,
  type CompiledSandboxProfile,
  type OciCapabilityProbe,
  type SandboxBackend,
  type SandboxExecutionResult
} from "./sandbox-backend.ts";
import { materializeSandboxBundle, type SandboxBundleReference } from "./sandbox-bundle.ts";
import { normalizeSandboxConfig, type SandboxConfig, type SandboxConfigInput } from "./sandbox-config.ts";
import { resolveWorkspacePath } from "./workspace-tools.ts";

const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_ARGUMENTS = 256;
const MAX_BUNDLE_FILES = 20_000;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

export const SANDBOX_PROCESS_PROFILE = "sandbox.process.v1";

export type SandboxProcessInput = Readonly<{
  command: string;
  args?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}>;

export type SandboxProcessResult = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  timedOut: boolean;
  outputTruncated: boolean;
  durationMs: number;
  backend: string;
  profileDigest: string;
  controlsAttested: boolean;
  cleanupUncertain: boolean;
}>;

export type SandboxProcessBackendResolver = (config: SandboxConfig) => Promise<OciCapabilityProbe>;
export type SandboxProcessBundleMaterializer = typeof materializeSandboxBundle;

export type SandboxProcessExecutorOptions = Readonly<{
  workspaceRoot: string;
  stateDir: string;
  config: SandboxConfigInput | SandboxConfig;
  backend?: SandboxBackend;
  resolveBackend?: SandboxProcessBackendResolver;
  materializeBundle?: SandboxProcessBundleMaterializer;
}>;

export type SandboxProcessExecutionContext = Readonly<{
  signal?: AbortSignal;
  requestId?: string;
  onDispatchAuthorized?: (evidence: Readonly<{ backend: string; containerName: string; profileDigest: string; controlsAttested: true }>) => void | Promise<void>;
}>;

export class SandboxProcessRefusalError extends Error {
  readonly code: string;

  constructor(message: string, code = "SANDBOX_PROCESS_REFUSED") {
    super(message);
    this.name = "SandboxProcessRefusalError";
    this.code = code;
  }
}

/**
 * Execute one process inside the strict, durable OCI boundary. This function
 * deliberately has no host-spawn fallback: a missing image, unsupported host,
 * unavailable engine, or unsafe workspace bundle is a refusal.
 */
export async function executeSandboxProcess(
  input: SandboxProcessInput,
  options: SandboxProcessExecutorOptions,
  { signal, onDispatchAuthorized }: SandboxProcessExecutionContext = {}
): Promise<SandboxProcessResult> {
  const config = normalizedConfig(options.config);
  if (process.platform !== "linux") throw new SandboxProcessRefusalError("durable process execution requires a Linux OCI backend", "SANDBOX_PROCESS_PLATFORM_UNSUPPORTED");
  if (!config.process.enabled) throw new SandboxProcessRefusalError("durable process execution is disabled by sandbox configuration", "SANDBOX_PROCESS_DISABLED");
  if (!config.process.image) throw new SandboxProcessRefusalError("durable process execution requires an operator-owned digest-pinned sandbox.process.image", "SANDBOX_PROCESS_IMAGE_REQUIRED");
  if (signal?.aborted) throw cancellationRefusal();

  const root = resolve(options.workspaceRoot);
  const command = boundedCommand(input?.command);
  const args = boundedArguments(input?.args);
  const configuredCwd = input?.cwd ?? ".";
  const cwdRelative = typeof configuredCwd === "string" && isAbsolute(configuredCwd)
    ? relative(root, resolve(configuredCwd))
    : "";
  const compatibleCwd = cwdRelative && cwdRelative !== ".." && !cwdRelative.startsWith(`..${sep}`)
    ? cwdRelative.replaceAll("\\", "/") || "."
    : configuredCwd;
  const resolvedCwd = await resolveWorkspacePath(root, compatibleCwd, "process.exec", {
    allowRoot: true,
    expected: "directory",
    security: { deniedPatterns: [] }
  });
  const cwd = resolvedCwd.path;
  const stateRelative = relative(root, resolve(options.stateDir)).replaceAll("\\", "/");
  if (stateRelative && stateRelative !== "." && stateRelative !== ".." && !stateRelative.startsWith("../") && !stateRelative.startsWith("/")) {
    if (cwd === stateRelative || cwd.startsWith(`${stateRelative}/`)) {
      throw new SandboxProcessRefusalError("process.exec cwd may not enter the runtime state directory", "SANDBOX_PROCESS_STATE_CONFINED");
    }
  }
  const timeoutMs = boundedInteger(input?.timeoutMs, 100, config.process.limits.timeoutMs, config.process.limits.timeoutMs, "process.exec timeoutMs");
  const maxOutputBytes = boundedInteger(input?.maxOutputBytes, 1_024, config.process.limits.outputBytes, config.process.limits.outputBytes, "process.exec maxOutputBytes");
  const materialize = options.materializeBundle ?? materializeSandboxBundle;
  const bundle = await materialize(root, options.stateDir, {
    maxFiles: MAX_BUNDLE_FILES,
    maxBytes: MAX_BUNDLE_BYTES,
    signal,
    excludeStateRoot: true
  });
  if (signal?.aborted) throw cancellationRefusal();

  const capability = options.backend ? undefined : await (options.resolveBackend ?? resolveConfiguredProcessBackend)(config);
  const backend = options.backend ?? new OciSandboxBackend(capability!, undefined, { recoveryStateDir: resolve(options.stateDir) });
  const profile = compileProcessProfile(config, backend.id, bundle, command, args, cwd, timeoutMs, maxOutputBytes);
  let execution: SandboxExecutionResult;
  try {
    execution = await backend.execute(profile, { signal, onDispatchAuthorized });
  } catch (error) {
    if (error instanceof SandboxBackendRefusalError) throw error;
    throw error;
  }
  if (execution.cleanupUncertain) {
    throw new SandboxProcessRefusalError("sandbox process cleanup could not be proven complete; process execution remains quarantined", "SANDBOX_CLEANUP_UNCERTAIN");
  }
  return mapExecutionResult(execution, command, args, cwd);
}

export function createSandboxProcessExecutor(options: SandboxProcessExecutorOptions) {
  return (input: SandboxProcessInput, context: SandboxProcessExecutionContext = {}) => executeSandboxProcess(input, options, context);
}

export async function resolveConfiguredProcessBackend(config: SandboxConfig, detector: typeof detectOciBackend = detectOciBackend): Promise<OciCapabilityProbe> {
  if (process.platform !== "linux") throw new SandboxProcessRefusalError("durable process execution requires Linux", "SANDBOX_PROCESS_PLATFORM_UNSUPPORTED");
  const modes = config.backend.mode === "auto" ? config.backend.preference : [config.backend.mode];
  let lastError: Error | undefined;
  for (const mode of modes) {
    if (mode === "confined-native") continue;
    try {
      return await detector("auto", undefined, {
        rootless: mode === "rootless-oci" ? "required" : "any",
        executablePaths: config.backend.enginePaths
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new SandboxProcessRefusalError("no compatible OCI process backend is configured; host execution is not a fallback", "SANDBOX_BACKEND_UNAVAILABLE");
}

export function compileProcessProfile(
  config: SandboxConfig,
  backend: "podman" | "docker",
  bundle: SandboxBundleReference,
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number
): CompiledSandboxProfile {
  const containerCwd = cwd === "." ? "/workspace" : `/workspace/${cwd}`;
  return compileSandboxProfile({
    backend,
    image: config.process.image!,
    network: "denied",
    argv: [command, ...args],
    cwd: containerCwd,
    environment: {},
    mounts: [{ source: bundle.path, target: "/workspace", access: "read-only" }],
    limits: {
      timeoutMs,
      maxOutputBytes,
      memoryBytes: config.process.limits.memoryBytes,
      cpuCount: config.process.limits.cpu,
      processCount: config.process.limits.pids,
      tmpfsBytes: config.process.limits.tmpfsBytes
    }
  });
}

function mapExecutionResult(execution: SandboxExecutionResult, command: string, args: readonly string[], cwd: string): SandboxProcessResult {
  return Object.freeze({
    command,
    args: Object.freeze([...args]),
    cwd: cwd === "." ? "" : cwd,
    exitCode: execution.exitCode,
    signal: execution.signal,
    stdout: execution.stdout,
    stderr: execution.stderr,
    stdoutBytes: execution.stdoutBytes,
    stderrBytes: execution.stderrBytes,
    timedOut: execution.timedOut,
    outputTruncated: execution.outputTruncated,
    durationMs: execution.durationMs,
    backend: execution.backend,
    profileDigest: execution.profileDigest,
    controlsAttested: execution.controlsAttested,
    cleanupUncertain: execution.cleanupUncertain
  });
}

function normalizedConfig(input: SandboxConfigInput | SandboxConfig): SandboxConfig {
  if (input && typeof input === "object" && "backend" in input && "process" in input) return input as SandboxConfig;
  return normalizeSandboxConfig(input as SandboxConfigInput);
}

function boundedCommand(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_ARGUMENT_BYTES) {
    throw new SandboxProcessRefusalError("process.exec command must be one bounded non-empty argument", "SANDBOX_PROCESS_INPUT_INVALID");
  }
  return value;
}

function boundedArguments(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ARGUMENTS || value.some((item) => typeof item !== "string" || item.includes("\0"))) {
    throw new SandboxProcessRefusalError("process.exec args must be a bounded argument array", "SANDBOX_PROCESS_INPUT_INVALID");
  }
  const args = value.map((item) => String(item));
  if (Buffer.byteLength(args.join("\0"), "utf8") > MAX_ARGUMENT_BYTES) throw new SandboxProcessRefusalError("process.exec args exceed the bounded argument budget", "SANDBOX_PROCESS_INPUT_INVALID");
  return args;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new SandboxProcessRefusalError(`${label} must be bounded`, "SANDBOX_PROCESS_INPUT_INVALID");
  return Number(value);
}

function cancellationRefusal(): SandboxProcessRefusalError {
  return new SandboxProcessRefusalError("sandbox process execution was cancelled before dispatch", "SANDBOX_CANCELLED");
}
