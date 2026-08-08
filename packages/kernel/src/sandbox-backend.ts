import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, posix, resolve } from "node:path";
import { platform } from "node:os";
import { SandboxRecoveryCoordinator, SandboxRecoveryError, type SandboxRecoveryIdentity, type SandboxRecoverySession } from "./sandbox-recovery.ts";

export type OciBackendId = "podman" | "docker";
export type SandboxBackendSelection = "auto" | OciBackendId;
export type SandboxNetworkMode = "denied" | "brokered-public" | "allowlisted" | "allowlisted-private" | "unrestricted";
export type SandboxMountAccess = "read-only" | "read-write";

export interface SandboxMountInput {
  source: string;
  target: string;
  access: SandboxMountAccess;
}

export interface SandboxLimitsInput {
  timeoutMs: number;
  maxOutputBytes: number;
  memoryBytes: number;
  cpuCount: number;
  processCount: number;
  tmpfsBytes: number;
}

export interface SandboxProfileInput {
  backend: OciBackendId;
  image: string;
  network: SandboxNetworkMode;
  argv: readonly string[];
  cwd: string;
  environment?: Readonly<Record<string, string>>;
  mounts?: readonly SandboxMountInput[];
  limits: SandboxLimitsInput;
}

export interface CompiledSandboxProfile {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly backend: OciBackendId;
  readonly image: string;
  readonly network: SandboxNetworkMode;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly mounts: readonly Readonly<SandboxMountInput>[];
  readonly limits: Readonly<SandboxLimitsInput>;
}

export interface OciCapabilityProbe {
  readonly schemaVersion: 1;
  readonly backend: OciBackendId;
  readonly command: string;
  readonly available: boolean;
  readonly compatible: boolean;
  readonly runtimeVersion: string;
  readonly containerOs: string;
  readonly rootless: boolean | "unknown";
  readonly hostPlatform: NodeJS.Platform;
  readonly resourceControls: Readonly<{
    readonly memory: boolean;
    readonly memorySwap: boolean;
    readonly cpuPeriod: boolean;
    readonly cpuQuota: boolean;
    readonly pids: boolean;
    readonly seccomp: boolean;
    readonly evidence: "engine-reported" | "cgroup-controllers" | "unknown";
  }>;
  readonly controlEvidence: Readonly<{
    readonly status: "capabilities-reported" | "unavailable";
    readonly requiredOptions: readonly string[];
    readonly note: string;
  }>;
  readonly diagnostic: string;
}

export interface SandboxExecutionResult {
  readonly backend: OciBackendId;
  readonly containerName: string;
  readonly profileDigest: string;
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly outputTruncated: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly cleanupUncertain: boolean;
  readonly controlsAttested: boolean;
  readonly cleanupDiagnostics: readonly string[];
  readonly durationMs: number;
}

export interface OciBackendRequirements {
  readonly rootless?: "required" | "preferred" | "any";
  readonly executablePaths?: Readonly<Partial<Record<OciBackendId, string>>>;
}

export interface SandboxBackend {
  readonly id: OciBackendId;
  probe(): Promise<OciCapabilityProbe>;
  execute(profile: CompiledSandboxProfile, options?: SandboxExecutionOptions): Promise<SandboxExecutionResult>;
}

export interface SandboxExecutionOptions {
  readonly signal?: AbortSignal;
  readonly stdin?: Uint8Array | string;
  readonly onDispatchAuthorized?: (evidence: Readonly<{ backend: OciBackendId; containerName: string; profileDigest: string; controlsAttested: true }>) => void | Promise<void>;
}

export class SandboxBackendRefusalError extends Error {
  readonly code: string;

  constructor(message: string, code = "SANDBOX_BACKEND_REFUSED") {
    super(message);
    this.name = "SandboxBackendRefusalError";
    this.code = code;
  }
}

export class SandboxExecutionError extends Error {
  readonly code: string;
  readonly result: SandboxExecutionResult;

  constructor(message: string, code: string, result: SandboxExecutionResult) {
    super(message);
    this.name = "SandboxExecutionError";
    this.code = code;
    this.result = result;
  }
}

type ProbeResult = { status: number | null; stdout: string; stderr: string; error?: Error };
export type OciProbeRunner = (command: string, args: readonly string[]) => ProbeResult;

export interface OciLifecycleAdapter {
  prepare(command: string, args: readonly string[]): Promise<void>;
  attestContainer(command: string, containerName: string, profile: CompiledSandboxProfile, identity: SandboxRecoveryIdentity): Promise<void>;
  spawn(command: string, args: readonly string[], options: SpawnOptions): any;
  control(command: string, args: readonly string[]): Promise<void>;
  terminate(child: any): void;
  inspectImage?(command: string, image: string): Promise<Readonly<{ declaredVolumes: readonly string[] }>>;
  locateManagedContainer(command: string, identity: SandboxRecoveryIdentity): Promise<"present" | "absent" | "unknown">;
}

const OCI_PATH_COMPONENT = String.raw`[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*`;
const OCI_DOMAIN_LABEL = String.raw`[a-z0-9](?:[a-z0-9-]*[a-z0-9])?`;
const OCI_REGISTRY = String.raw`(?:${OCI_DOMAIN_LABEL}(?:\.${OCI_DOMAIN_LABEL})*|localhost)(?::[0-9]{1,5})?`;
const OCI_TAG = String.raw`[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}`;
const DIGEST_PINNED_OCI_REFERENCE = new RegExp(
  String.raw`^(?:(?:${OCI_REGISTRY})/)?${OCI_PATH_COMPONENT}(?:/${OCI_PATH_COMPONENT})*(?::${OCI_TAG})?@sha256:[a-f0-9]{64}$`,
  "u"
);
const MAX_ARGV_ITEMS = 512;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 256;
const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1024;
const CONTROL_TIMEOUT_MS = 10_000;
export const MAX_SANDBOX_STDIN_BYTES = 1024 * 1024;

function defaultOciExecutable(backend: OciBackendId): string {
  if (process.platform === "win32") {
    return backend === "docker"
      ? String.raw`C:\Program Files\Docker\Docker\resources\bin\docker.exe`
      : String.raw`C:\Program Files\RedHat\Podman\podman.exe`;
  }
  return `/usr/bin/${backend}`;
}

function validateOciExecutablePathSyntax(backend: OciBackendId, input: unknown): string {
  const command = typeof input === "string" ? input : "";
  if (!command || command !== command.trim() || command.length > 4096 || /[\u0000-\u001f\u007f]/u.test(command) || !isAbsolute(command)) {
    throw new SandboxBackendRefusalError(`configured ${backend} executable must be a bounded absolute path`, "SANDBOX_ENGINE_PATH_INVALID");
  }
  const executableName = basename(command).toLowerCase();
  if (executableName !== backend && executableName !== `${backend}.exe`) {
    throw new SandboxBackendRefusalError(`configured ${backend} executable path has the wrong basename`, "SANDBOX_ENGINE_PATH_INVALID");
  }
  return resolve(command);
}

export function validateTrustedOciExecutable(backend: OciBackendId, input: unknown): string {
  const command = validateOciExecutablePathSyntax(backend, input);
  try {
    const metadata = lstatSync(command);
    if (!metadata.isFile() || metadata.isSymbolicLink() || realpathSync(command) !== command) throw new Error("not a regular non-link file");
    if (process.platform !== "win32" && (metadata.mode & 0o111) === 0) throw new Error("not executable");
    assertTrustedOciOwnership(command, metadata);
  } catch (error) {
    throw new SandboxBackendRefusalError(
      `configured ${backend} executable is unavailable or not operator-trusted: ${cleanProbeText(error instanceof Error ? error.message : error)}`,
      "SANDBOX_ENGINE_UNTRUSTED"
    );
  }
  return command;
}

function assertTrustedOciOwnership(command: string, fileMetadata: Stats): void {
  if (process.platform !== "linux") throw new Error("trusted OCI executable validation is currently supported only on Linux");
  const trustedOwners = new Set([0]);
  if (!trustedOwners.has(fileMetadata.uid) || (fileMetadata.mode & 0o022) !== 0) throw new Error("executable ownership or permissions are unsafe");
  let current = dirname(command);
  while (true) {
    const metadata = lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !trustedOwners.has(metadata.uid) || (metadata.mode & 0o022) !== 0) {
      throw new Error("executable path chain is not operator-trusted");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function validateDigestPinnedOciImage(input: unknown): string {
  const image = typeof input === "string" ? input : "";
  if (
    !image
    || image !== image.trim()
    || image.length > 512
    || /[\s\u0000-\u001f\u007f]/u.test(image)
    || !DIGEST_PINNED_OCI_REFERENCE.test(image)
  ) {
    throw new SandboxBackendRefusalError(
      "sandbox image must be an exact OCI reference pinned with @sha256:<64 lowercase hex characters>",
      "SANDBOX_IMAGE_NOT_PINNED"
    );
  }
  const name = image.slice(0, image.indexOf("@"));
  const slash = name.indexOf("/");
  const first = slash === -1 ? "" : name.slice(0, slash);
  if (first.includes(":")) {
    const port = Number(first.slice(first.lastIndexOf(":") + 1));
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new SandboxBackendRefusalError("sandbox image contains an invalid registry port", "SANDBOX_IMAGE_INVALID");
    }
  }
  return image;
}

export function compileSandboxProfile(input: SandboxProfileInput): CompiledSandboxProfile {
  if (!input || typeof input !== "object") throw new SandboxBackendRefusalError("sandbox profile must be an object", "SANDBOX_PROFILE_INVALID");
  if (!(["podman", "docker"] as const).includes(input.backend)) {
    throw new SandboxBackendRefusalError("sandbox profile requires an OCI backend", "SANDBOX_BACKEND_INVALID");
  }
  const image = validateDigestPinnedOciImage(input.image);
  const network = normalizeNetworkMode(input.network);
  assertNetworkImplemented(network);
  const argv = normalizeArgv(input.argv);
  const cwd = normalizeContainerPath(input.cwd, "sandbox cwd");
  const environment = normalizeEnvironment(input.environment ?? {});
  const mounts = normalizeMounts(input.mounts ?? []);
  const limits = normalizeLimits(input.limits);
  const unsigned = {
    schemaVersion: 1 as const,
    backend: input.backend,
    image,
    network,
    argv,
    cwd,
    environment,
    mounts,
    limits
  };
  const digest = createHash("sha256").update(canonicalize(unsigned), "utf8").digest("hex");
  return deepFreeze({ ...unsigned, digest });
}

export function buildNetworkDeniedOciArgs(
  profile: CompiledSandboxProfile,
  containerName: string,
  identity?: Readonly<Pick<SandboxRecoveryIdentity, "namespaceId" | "executionId">>
): readonly string[] {
  assertCompiledProfile(profile);
  if (!/^odinn-[a-z0-9-]{8,100}$/u.test(containerName)) {
    throw new SandboxBackendRefusalError("sandbox container name is invalid", "SANDBOX_CONTAINER_NAME_INVALID");
  }
  assertNetworkImplemented(profile.network);
  const args: string[] = [
    "create",
    "--name", containerName,
    "--pull=never",
    "--interactive",
    "--network", "none",
    "--read-only",
    "--user", "65532:65532",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    ...(profile.backend === "docker" ? ["--security-opt", "seccomp=builtin"] : []),
    "--pids-limit", String(profile.limits.processCount),
    "--memory", String(profile.limits.memoryBytes),
    "--memory-swap", String(profile.limits.memoryBytes),
    "--cpus", String(profile.limits.cpuCount),
    "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${profile.limits.tmpfsBytes}`,
    "--stop-timeout", "1",
    "--label", "odinn.managed=true",
    ...(identity ? ["--label", `odinn.namespace-id=${identity.namespaceId}`, "--label", `odinn.execution-id=${identity.executionId}`] : []),
    "--label", `odinn.profile-digest=${profile.digest}`,
    "--label", `odinn.image-ref=${profile.image}`,
    "--label", `odinn.timeout-ms=${profile.limits.timeoutMs}`,
    "--label", `odinn.max-output-bytes=${profile.limits.maxOutputBytes}`
  ];
  for (const [key, value] of Object.entries(profile.environment)) args.push("--env", `${key}=${value}`);
  for (const mount of profile.mounts) {
    args.push(
      "--mount",
      `type=bind,src=${mount.source},dst=${mount.target},${mount.access === "read-only" ? "readonly" : "rw"}`
    );
  }
  args.push("--workdir", profile.cwd, "--", profile.image, ...profile.argv);
  return deepFreeze(args);
}

export async function probeOciBackend(
  backend: OciBackendId,
  runner: OciProbeRunner = defaultProbeRunner,
  requirements: OciBackendRequirements = {}
): Promise<OciCapabilityProbe> {
  let command = requirements.executablePaths === undefined
    ? defaultOciExecutable(backend)
    : requirements.executablePaths[backend] ?? "";
  let resolutionError: Error | undefined;
  try {
    command = runner === defaultProbeRunner
      ? validateTrustedOciExecutable(backend, command)
      : validateOciExecutablePathSyntax(backend, command);
  } catch (error) {
    resolutionError = error instanceof Error ? error : new Error(String(error));
  }
  const result = resolutionError
    ? { status: null, stdout: "", stderr: "", error: resolutionError }
    : runner(command, ["info", "--format", "{{json .}}"]);
  let info: any = {};
  if (result.status === 0) {
    try { info = JSON.parse(result.stdout || "{}"); } catch { info = {}; }
  }
  const available = result.status === 0 && !result.error;
  const runtimeVersion = cleanProbeText(
    info?.Version?.Version ?? info?.version?.Version ?? info?.version?.version ?? info?.ServerVersion ?? "unknown"
  );
  const containerOs = cleanProbeText(info?.OSType ?? info?.host?.os ?? info?.Host?.OS ?? "unknown").toLowerCase();
  const securityOptions: string[] = (Array.isArray(info?.SecurityOptions) ? info.SecurityOptions : []).map((value: unknown) => String(value).trim().toLowerCase());
  const dockerSeccompOptions = securityOptions.filter((value) => value.startsWith("name=seccomp"));
  const rootlessValue = info?.host?.security?.rootless ?? info?.Host?.Security?.Rootless;
  const rootless = typeof rootlessValue === "boolean" ? rootlessValue : securityOptions.some((value) => value.includes("rootless")) ? true : "unknown";
  const dockerControls = backend === "docker" ? {
    memory: info?.MemoryLimit === true,
    memorySwap: info?.SwapLimit === true,
    cpuPeriod: info?.CpuCfsPeriod === true,
    cpuQuota: info?.CpuCfsQuota === true,
    pids: info?.PidsLimit === true,
    seccomp: dockerSeccompOptions.length === 1 && dockerSeccompOptions[0] === "name=seccomp,profile=builtin",
    evidence: "engine-reported" as const
  } : undefined;
  const podmanControllers = backend === "podman" && Array.isArray(info?.host?.cgroupControllers)
    ? new Set(info.host.cgroupControllers.map((value: unknown) => String(value).toLowerCase()))
    : undefined;
  const podmanControls = backend === "podman" ? {
    memory: podmanControllers?.has("memory") === true,
    memorySwap: podmanControllers?.has("memory") === true && normalizeCgroupVersion(info?.host?.cgroupVersion) === "v2",
    cpuPeriod: podmanControllers?.has("cpu") === true,
    cpuQuota: podmanControllers?.has("cpu") === true,
    pids: podmanControllers?.has("pids") === true,
    // Podman accepts explicit profile files rather than Docker's immutable
    // builtin selector. Until an operator-trusted profile path is part of the
    // compiled contract, Podman execution remains unavailable.
    seccomp: false,
    evidence: podmanControllers
      && ["systemd", "cgroupfs"].includes(String(info?.host?.cgroupManager ?? "").toLowerCase())
      && normalizeCgroupVersion(info?.host?.cgroupVersion) === "v2"
      ? "cgroup-controllers" as const : "unknown" as const
  } : undefined;
  const resourceControls = dockerControls ?? podmanControls ?? {
    memory: false,
    memorySwap: false,
    cpuPeriod: false,
    cpuQuota: false,
    pids: false,
    seccomp: false,
    evidence: "unknown" as const
  };
  const controlsAvailable = resourceControls.memory && resourceControls.memorySwap && resourceControls.cpuPeriod
    && resourceControls.cpuQuota && resourceControls.pids && resourceControls.seccomp && resourceControls.evidence !== "unknown";
  const compatible = available && containerOs === "linux" && controlsAvailable;
  const missingControls = [
    !resourceControls.memory ? "memory" : "",
    !resourceControls.memorySwap ? "memory+swap" : "",
    !resourceControls.cpuPeriod ? "CPU period" : "",
    !resourceControls.cpuQuota ? "CPU quota" : "",
    !resourceControls.pids ? "PID" : ""
    , !resourceControls.seccomp ? "seccomp" : ""
  ].filter(Boolean).join(", ");
  const diagnostic = available
    ? containerOs !== "linux"
      ? `${backend} reported unsupported container OS ${containerOs}`
      : compatible
        ? `${backend} reported the required memory, swap, CPU quota, and PID resource controls`
        : `${backend} did not report required ${missingControls || "resource"} controls`
    : `${backend} is unavailable: ${cleanProbeText(result.error?.message ?? result.stderr ?? "probe failed")}`;
  return deepFreeze({
    schemaVersion: 1,
    backend,
    command,
    available,
    compatible,
    runtimeVersion,
    containerOs,
    rootless,
    hostPlatform: platform(),
    resourceControls,
    controlEvidence: {
      status: controlsAvailable ? "capabilities-reported" : "unavailable",
      requiredOptions: deepFreeze([
        "--pull=never", "--network=none", "--read-only", "--user", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--pids-limit", "--memory", "--cpus", "--tmpfs"
      ]),
      note: controlsAvailable
        ? "The engine reports required cgroup capabilities. Every execution is created stopped and its compiled configuration is attested before start; effective kernel enforcement remains runtime-trusted."
        : "The engine did not report every required resource control; execution is refused."
    },
    diagnostic
  });
}

export function selectOciBackend(
  selection: SandboxBackendSelection,
  probes: readonly OciCapabilityProbe[],
  { rootless = "preferred" }: OciBackendRequirements = {}
): OciCapabilityProbe {
  if (!(["auto", "podman", "docker"] as const).includes(selection)) {
    throw new SandboxBackendRefusalError(`unsupported sandbox backend selection: ${String(selection)}`, "SANDBOX_BACKEND_INVALID");
  }
  if (!["required", "preferred", "any"].includes(rootless)) {
    throw new SandboxBackendRefusalError(`unsupported rootless requirement: ${String(rootless)}`, "SANDBOX_BACKEND_INVALID");
  }
  const compatible = probes.filter((probe) => probe.available && probe.compatible);
  const usable = rootless === "required" ? compatible.filter((probe) => probe.rootless === true) : compatible;
  if (selection !== "auto") {
    const exact = usable.find((probe) => probe.backend === selection);
    if (!exact) {
      throw new SandboxBackendRefusalError(
        `configured sandbox backend ${selection} is unavailable, incompatible, or does not meet the ${rootless} rootless requirement; refusing to fall back`,
        "SANDBOX_BACKEND_UNAVAILABLE"
      );
    }
    return exact;
  }
  const preferred = rootless === "any"
    ? usable.find((probe) => probe.backend === "podman") ?? usable.find((probe) => probe.backend === "docker")
    : usable.find((probe) => probe.backend === "podman" && probe.rootless === true)
      ?? usable.find((probe) => probe.backend === "docker" && probe.rootless === true)
      ?? usable.find((probe) => probe.backend === "podman")
      ?? usable.find((probe) => probe.backend === "docker");
  if (!preferred) {
    throw new SandboxBackendRefusalError("no compatible OCI sandbox backend is available; host execution is not a fallback", "SANDBOX_BACKEND_UNAVAILABLE");
  }
  return preferred;
}

export async function detectOciBackend(
  selection: SandboxBackendSelection,
  runner: OciProbeRunner = defaultProbeRunner,
  requirements: OciBackendRequirements = {}
): Promise<OciCapabilityProbe> {
  if (selection === "podman" || selection === "docker") return selectOciBackend(selection, [await probeOciBackend(selection, runner, requirements)], requirements);
  if (selection !== "auto") return selectOciBackend(selection, [], requirements);
  const probes = await Promise.all([probeOciBackend("podman", runner, requirements), probeOciBackend("docker", runner, requirements)]);
  return selectOciBackend(selection, probes, requirements);
}

export interface OciSandboxBackendOptions {
  readonly recoveryStateDir: string;
}

export class OciSandboxBackend implements SandboxBackend {
  readonly id: OciBackendId;
  readonly capability: OciCapabilityProbe;
  readonly adapter: OciLifecycleAdapter;
  readonly recovery: SandboxRecoveryCoordinator;

  constructor(capability: OciCapabilityProbe, adapter: OciLifecycleAdapter = defaultLifecycleAdapter, options: OciSandboxBackendOptions) {
    if (!capability.available || !capability.compatible) {
      throw new SandboxBackendRefusalError(`${capability.backend} is not a compatible Linux-container runtime`, "SANDBOX_BACKEND_UNAVAILABLE");
    }
    if (adapter === defaultLifecycleAdapter && capability.backend === "podman") {
      throw new SandboxBackendRefusalError("Podman execution requires an explicit operator-trusted seccomp profile, which is not active", "SANDBOX_SECCOMP_PROFILE_UNAVAILABLE");
    }
    this.id = capability.backend;
    this.capability = capability;
    this.adapter = adapter;
    this.recovery = new SandboxRecoveryCoordinator(options?.recoveryStateDir);
  }

  async probe() {
    return this.capability;
  }

  async execute(profile: CompiledSandboxProfile, { signal, stdin, onDispatchAuthorized }: SandboxExecutionOptions = {}) {
    if (profile.backend !== this.id) {
      throw new SandboxBackendRefusalError(`compiled profile requires ${profile.backend}, not ${this.id}`, "SANDBOX_BACKEND_MISMATCH");
    }
    if (this.adapter === defaultLifecycleAdapter) validateTrustedOciExecutable(this.id, this.capability.command);
    const boundAdapter = bindLifecycleAdapter(this.adapter, this.capability.command);
    return this.recovery.runExclusive(boundAdapter, (recoverySession) => executeOciProfile(this.id, profile, {
      signal,
      stdin,
      onDispatchAuthorized,
      adapter: boundAdapter,
      engineExecutable: this.capability.command,
      recoverySession
    }));
  }
}

export async function reconcileSandboxRecovery(
  stateDir: string,
  executablePaths: Readonly<Partial<Record<OciBackendId, string>>> = {},
  lifecycleAdapter: OciLifecycleAdapter = defaultLifecycleAdapter
): Promise<Readonly<{ ok: true; pending: 0 }>> {
  const coordinator = new SandboxRecoveryCoordinator(stateDir);
  const adapter = routeRecoveryAdapter(executablePaths, lifecycleAdapter);
  return coordinator.runExclusive(adapter, async () => deepFreeze({ ok: true as const, pending: 0 as const }));
}

export async function executeOciProfile(
  backend: OciBackendId,
  profile: CompiledSandboxProfile,
  { signal, stdin, onDispatchAuthorized, adapter = defaultLifecycleAdapter, engineExecutable, recoverySession }: SandboxExecutionOptions & { adapter?: OciLifecycleAdapter; engineExecutable?: string; recoverySession?: SandboxRecoverySession } = {}
): Promise<SandboxExecutionResult> {
  assertCompiledProfile(profile);
  if (profile.backend !== backend) throw new SandboxBackendRefusalError("sandbox backend does not match compiled profile", "SANDBOX_BACKEND_MISMATCH");
  const engineCommand = adapter === defaultLifecycleAdapter
    ? validateTrustedOciExecutable(backend, engineExecutable ?? defaultOciExecutable(backend))
    : engineExecutable ?? backend;
  if (adapter === defaultLifecycleAdapter && backend === "podman") {
    throw new SandboxBackendRefusalError("Podman execution requires an explicit operator-trusted seccomp profile, which is not active", "SANDBOX_SECCOMP_PROFILE_UNAVAILABLE");
  }
  const stdinBytes = normalizeStdin(stdin);
  if (signal?.aborted) throw new SandboxBackendRefusalError("sandbox execution was cancelled before dispatch", "SANDBOX_CANCELLED");
  if (adapter.inspectImage) {
    const inspected = await adapter.inspectImage(engineCommand, profile.image);
    if (inspected.declaredVolumes.length) {
      throw new SandboxBackendRefusalError(
        "sandbox images with declared OCI volumes are unsupported because they create writable storage outside the compiled mount profile",
        "SANDBOX_IMAGE_VOLUME_UNSUPPORTED"
      );
    }
  }
  const containerName = uniqueContainerName();
  const executionId = `sbxexec_${randomUUID().replaceAll("-", "")}`;
  const ephemeralNamespaceId = `sbx_${createHash("sha256").update(`${process.pid}:${profile.digest}`, "utf8").digest("hex").slice(0, 36)}`;
  const reserved = recoverySession
    ? await recoverySession.reserve({
        executionId,
        backend,
        containerName,
        engineBindingDigest: digestOciEngineBinding(backend, engineCommand),
        profileDigest: profile.digest,
        imageDigest: profile.image.slice(profile.image.lastIndexOf("@") + 1)
      })
    : { namespaceId: ephemeralNamespaceId, executionId, backend, containerName, engineBindingDigest: digestOciEngineBinding(backend, engineCommand) };
  const args = buildNetworkDeniedOciArgs(profile, containerName, reserved);
  const provePreStartCleanup = async (reasonCode: string) => {
    await adapter.control(engineCommand, ["rm", "--force", "--volumes", containerName]).catch(() => undefined);
    if (recoverySession) {
      await recoverySession.transition("cleanup-uncertain", reasonCode).catch(() => undefined);
      await recoverySession.proveAbsentAndClear();
      return;
    }
    const located = await adapter.locateManagedContainer(engineCommand, reserved).catch(() => "unknown" as const);
    if (located !== "absent") throw new SandboxRecoveryError("sandbox pre-start cleanup could not prove the managed container absent");
  };
  try {
    await adapter.prepare(engineCommand, args);
  } catch (error) {
    // A failed create request is not equivalent to proof that the daemon did
    // not accept it. In particular, a timed-out client can lose the race with
    // a create that completes after the client exits. Keep the durable record
    // quarantined instead of clearing it from a momentary absence observation.
    await adapter.control(engineCommand, ["rm", "--force", "--volumes", containerName]).catch(() => undefined);
    await recoverySession?.transition("cleanup-uncertain", "SANDBOX_CREATE_UNCERTAIN").catch(() => undefined);
    if (error instanceof SandboxBackendRefusalError) throw error;
    throw new SandboxBackendRefusalError("sandbox container creation did not settle successfully; backend remains quarantined", "SANDBOX_CREATE_UNCERTAIN");
  }
  try {
    await recoverySession?.transition("created");
    await adapter.attestContainer(engineCommand, containerName, profile, reserved);
    await recoverySession?.transition("attested");
  } catch (error) {
    await provePreStartCleanup("SANDBOX_CONTROL_ATTESTATION_FAILED");
    if (error instanceof SandboxBackendRefusalError) throw error;
    throw new SandboxBackendRefusalError("sandbox container controls could not be attested before start", "SANDBOX_CONTROL_ATTESTATION_FAILED");
  }
  if (signal?.aborted) {
    await provePreStartCleanup("SANDBOX_CANCELLED");
    throw new SandboxBackendRefusalError("sandbox execution was cancelled before dispatch", "SANDBOX_CANCELLED");
  }
  try {
    await onDispatchAuthorized?.(deepFreeze({ backend, containerName, profileDigest: profile.digest, controlsAttested: true as const }));
    await recoverySession?.transition("starting");
  } catch (error) {
    await provePreStartCleanup("SANDBOX_AUDIT_COMMIT_FAILED");
    throw new SandboxBackendRefusalError(
      error instanceof Error ? `sandbox pre-start audit commit failed: ${error.message}` : "sandbox pre-start audit commit failed",
      "SANDBOX_AUDIT_COMMIT_FAILED"
    );
  }
  const startedAt = Date.now();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let capturedBytes = 0;
  let outputTruncated = false;
  let cleanupUncertain = false;
  const cleanupDiagnostics: string[] = [];
  let settling = false;
  let child: any;

  return await new Promise<SandboxExecutionResult>((resolveExecution, rejectExecution) => {
    const result = (exitCode: number, childSignal: NodeJS.Signals | null, reason?: "timeout" | "cancelled" | "output"): SandboxExecutionResult => deepFreeze({
      backend,
      containerName,
      profileDigest: profile.digest,
      exitCode,
      signal: childSignal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdoutBytes,
      stderrBytes,
      outputTruncated,
      timedOut: reason === "timeout",
      cancelled: reason === "cancelled",
      cleanupUncertain,
      controlsAttested: true,
      cleanupDiagnostics: deepFreeze([...cleanupDiagnostics]),
      durationMs: Date.now() - startedAt
    });

    const removeAbort = () => signal?.removeEventListener("abort", abort);
    const control = async (commandArgs: readonly string[]) => {
      try {
        await Promise.resolve().then(() => adapter.control(engineCommand, commandArgs));
        return true;
      } catch (error) {
        cleanupDiagnostics.push(`${commandArgs[0] ?? "control"}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
        return false;
      }
    };
    const cleanup = async () => control(["rm", "--force", "--volumes", containerName]);
    const terminateClient = () => {
      try {
        adapter.terminate(child);
      } catch (error) {
        cleanupDiagnostics.push(`client-termination: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
      }
    };
    const proveCleanup = async () => {
      try {
        if (recoverySession) await recoverySession.proveAbsentAndClear();
        else {
          const located = await adapter.locateManagedContainer(engineCommand, reserved).catch(() => "unknown" as const);
          if (located !== "absent") throw new Error("managed container absence was not proven");
        }
        return true;
      } catch (error) {
        cleanupUncertain = true;
        cleanupDiagnostics.push(`absence-proof: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
        return false;
      }
    };
    const settleExceptional = async (reason: "timeout" | "cancelled" | "output") => {
      if (settling) return;
      settling = true;
      clearTimeout(timer);
      removeAbort();
      terminateClient();
      await control(["kill", containerName]);
      await control(["wait", containerName]);
      await cleanup();
      await proveCleanup();
      const settled = result(1, null, reason);
      const code = reason === "timeout" ? "SANDBOX_TIMEOUT" : reason === "cancelled" ? "SANDBOX_CANCELLED" : "SANDBOX_OUTPUT_LIMIT";
      const message = reason === "timeout"
        ? "sandbox execution timed out"
        : reason === "cancelled" ? "sandbox execution was cancelled" : `sandbox output exceeded ${profile.limits.maxOutputBytes} bytes`;
      rejectExecution(new SandboxExecutionError(message, code, settled));
    };
    const settleRuntimeError = async (error: Error) => {
      if (settling) return;
      settling = true;
      clearTimeout(timer);
      removeAbort();
      terminateClient();
      await control(["kill", containerName]);
      await control(["wait", containerName]);
      await cleanup();
      await proveCleanup();
      rejectExecution(new SandboxExecutionError(
        error.message || "sandbox runtime client failed",
        "SANDBOX_RUNTIME_ERROR",
        result(1, null)
      ));
    };
    const abort = () => { void settleExceptional("cancelled"); };
    const timer = setTimeout(() => { void settleExceptional("timeout"); }, profile.limits.timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      void settleExceptional("cancelled");
      return;
    }

    try {
      child = adapter.spawn(engineCommand, ["start", "--attach", "--interactive", containerName], {
        detached: process.platform !== "win32",
        env: minimalRuntimeEnvironment(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      clearTimeout(timer);
      removeAbort();
      void (async () => {
        await cleanup();
        await proveCleanup();
        rejectExecution(new SandboxExecutionError(
          error instanceof Error ? error.message : "sandbox runtime client failed before dispatch",
          "SANDBOX_RUNTIME_ERROR",
          result(1, null)
        ));
      })();
      return;
    }
    const collect = (chunks: Buffer[], raw: Buffer | string, stream: "stdout" | "stderr") => {
      if (settling) return;
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const available = Math.max(0, profile.limits.maxOutputBytes - capturedBytes);
      const retained = chunk.subarray(0, available);
      if (retained.byteLength) chunks.push(retained);
      capturedBytes += retained.byteLength;
      if (stream === "stdout") stdoutBytes += retained.byteLength;
      else stderrBytes += retained.byteLength;
      if (chunk.byteLength > available) {
        outputTruncated = true;
        void settleExceptional("output");
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk, "stderr"));
    const settleClose = (exitCode: number | null, childSignal: NodeJS.Signals | null) => {
      if (settling) return;
      settling = true;
      clearTimeout(timer);
      removeAbort();
      void (async () => {
        await control(["wait", containerName]);
        await cleanup();
        const absent = await proveCleanup();
        if (!absent) {
          rejectExecution(new SandboxExecutionError("sandbox cleanup could not be proven complete", "SANDBOX_CLEANUP_UNCERTAIN", result(exitCode ?? 1, childSignal)));
          return;
        }
        resolveExecution(result(exitCode ?? 1, childSignal));
      })().catch((cleanupError) => {
        cleanupUncertain = true;
        cleanupDiagnostics.push(`cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`.slice(0, 500));
        rejectExecution(new SandboxExecutionError("sandbox cleanup could not be proven complete", "SANDBOX_CLEANUP_UNCERTAIN", result(exitCode ?? 1, childSignal)));
      });
    };
    child.once("error", (error: Error) => {
      void settleRuntimeError(error);
    });
    child.once("close", (exitCode: number | null, childSignal: NodeJS.Signals | null) => {
      settleClose(exitCode, childSignal);
    });
    child.stdin?.once("error", (error: Error) => {
      void settleRuntimeError(error);
    });
    void (async () => {
      await recoverySession?.transition("running");
      if (signal?.aborted) {
        await settleExceptional("cancelled");
        return;
      }
      if (!child.stdin) {
        await settleRuntimeError(new Error("sandbox runtime did not provide a writable stdin pipe"));
        return;
      }
      child.stdin.end(stdinBytes);
    })().catch((error) => {
      void settleRuntimeError(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function normalizeNetworkMode(value: unknown): SandboxNetworkMode {
  if (!["denied", "brokered-public", "allowlisted", "allowlisted-private", "unrestricted"].includes(String(value))) {
    throw new SandboxBackendRefusalError(`unsupported sandbox network mode: ${String(value)}`, "SANDBOX_NETWORK_INVALID");
  }
  return value as SandboxNetworkMode;
}

function assertNetworkImplemented(mode: SandboxNetworkMode): void {
  if (mode !== "denied") {
    throw new SandboxBackendRefusalError(
      `sandbox network mode ${mode} requires the egress broker, which is not implemented; refusing unrestricted container networking`,
      "SANDBOX_NETWORK_BROKER_UNAVAILABLE"
    );
  }
}

function normalizeArgv(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ARGV_ITEMS) {
    throw new SandboxBackendRefusalError(`sandbox argv must contain 1-${MAX_ARGV_ITEMS} arguments`, "SANDBOX_ARGV_INVALID");
  }
  const result = value.map((item) => {
    if (typeof item !== "string" || item.includes("\0") || Buffer.byteLength(item, "utf8") > MAX_ARGUMENT_BYTES) {
      throw new SandboxBackendRefusalError("sandbox argv contains an invalid or oversized argument", "SANDBOX_ARGV_INVALID");
    }
    return item;
  });
  return deepFreeze(result);
}

function normalizeEnvironment(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SandboxBackendRefusalError("sandbox environment must be an object", "SANDBOX_ENVIRONMENT_INVALID");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new SandboxBackendRefusalError(`sandbox environment exceeds ${MAX_ENVIRONMENT_ENTRIES} entries`, "SANDBOX_ENVIRONMENT_INVALID");
  }
  const normalized = Object.create(null) as Record<string, string>;
  for (const [key, raw] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key) || typeof raw !== "string" || raw.includes("\0") || Buffer.byteLength(raw, "utf8") > MAX_ENVIRONMENT_VALUE_BYTES) {
      throw new SandboxBackendRefusalError(`sandbox environment contains an invalid entry: ${key}`, "SANDBOX_ENVIRONMENT_INVALID");
    }
    normalized[key] = raw;
  }
  return deepFreeze(normalized);
}

function normalizeStdin(value: Uint8Array | string | undefined): Buffer {
  if (value === undefined) return Buffer.alloc(0);
  if (typeof value !== "string" && !(value instanceof Uint8Array)) {
    throw new SandboxBackendRefusalError("sandbox stdin must be a string or Uint8Array", "SANDBOX_STDIN_INVALID");
  }
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (bytes.byteLength > MAX_SANDBOX_STDIN_BYTES) {
    throw new SandboxBackendRefusalError(
      `sandbox stdin exceeds ${MAX_SANDBOX_STDIN_BYTES} bytes`,
      "SANDBOX_STDIN_TOO_LARGE"
    );
  }
  return bytes;
}

function normalizeMounts(value: unknown): readonly Readonly<SandboxMountInput>[] {
  if (!Array.isArray(value) || value.length > 128) throw new SandboxBackendRefusalError("sandbox mounts must be an array of at most 128 entries", "SANDBOX_MOUNT_INVALID");
  const targets = new Set<string>();
  const normalized = value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SandboxBackendRefusalError("sandbox mount must be an object", "SANDBOX_MOUNT_INVALID");
    const mount = raw as Record<string, unknown>;
    if (!isAbsolute(String(mount.source ?? ""))) throw new SandboxBackendRefusalError("sandbox mount source must be absolute", "SANDBOX_MOUNT_INVALID");
    const source = resolve(String(mount.source));
    if (/[\u0000-\u001f\u007f,]/u.test(source)) throw new SandboxBackendRefusalError("sandbox mount source contains unsupported characters", "SANDBOX_MOUNT_INVALID");
    const target = normalizeContainerPath(mount.target, "sandbox mount target");
    if (target === "/" || target === "/tmp") throw new SandboxBackendRefusalError(`sandbox mount target is reserved: ${target}`, "SANDBOX_MOUNT_INVALID");
    if (targets.has(target)) throw new SandboxBackendRefusalError(`sandbox mount target is duplicated: ${target}`, "SANDBOX_MOUNT_INVALID");
    targets.add(target);
    if (mount.access !== "read-only" && mount.access !== "read-write") throw new SandboxBackendRefusalError("sandbox mount access must be read-only or read-write", "SANDBOX_MOUNT_INVALID");
    return deepFreeze({ source, target, access: mount.access as SandboxMountAccess });
  });
  return deepFreeze(normalized.sort((left, right) => left.target.localeCompare(right.target) || left.source.localeCompare(right.source)));
}

function normalizeContainerPath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f,]/u.test(value)) {
    throw new SandboxBackendRefusalError(`${label} must be an absolute control-free container path`, "SANDBOX_PATH_INVALID");
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || value.split("/").includes("..")) {
    throw new SandboxBackendRefusalError(`${label} must be normalized and cannot contain parent traversal`, "SANDBOX_PATH_INVALID");
  }
  return normalized;
}

function normalizeLimits(value: unknown): Readonly<SandboxLimitsInput> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SandboxBackendRefusalError("sandbox limits must be an object", "SANDBOX_LIMIT_INVALID");
  const limits = value as Record<string, unknown>;
  const normalized = {
    timeoutMs: boundedInteger(limits.timeoutMs, 100, 86_400_000, "timeoutMs"),
    maxOutputBytes: boundedInteger(limits.maxOutputBytes, 1_024, 64 * 1024 * 1024, "maxOutputBytes"),
    memoryBytes: boundedInteger(limits.memoryBytes, 16 * 1024 * 1024, Number.MAX_SAFE_INTEGER, "memoryBytes"),
    cpuCount: boundedNumber(limits.cpuCount, 0.1, 1024, "cpuCount"),
    processCount: boundedInteger(limits.processCount, 1, 1_000_000, "processCount"),
    tmpfsBytes: boundedInteger(limits.tmpfsBytes, 1_024 * 1_024, Number.MAX_SAFE_INTEGER, "tmpfsBytes")
  };
  return deepFreeze(normalized);
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new SandboxBackendRefusalError(`sandbox ${label} must be an integer from ${minimum} through ${maximum}`, "SANDBOX_LIMIT_INVALID");
  }
  return Number(value);
}

function boundedNumber(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new SandboxBackendRefusalError(`sandbox ${label} must be a finite number from ${minimum} through ${maximum}`, "SANDBOX_LIMIT_INVALID");
  }
  return value;
}

function assertCompiledProfile(profile: CompiledSandboxProfile): void {
  if (!profile || profile.schemaVersion !== 1 || !/^[a-f0-9]{64}$/u.test(profile.digest)) {
    throw new SandboxBackendRefusalError("sandbox profile is not compiled", "SANDBOX_PROFILE_INVALID");
  }
  if (!isDeepFrozen(profile)) throw new SandboxBackendRefusalError("compiled sandbox profile must be deeply frozen", "SANDBOX_PROFILE_INVALID");
  const { digest: _digest, ...unsigned } = profile;
  const expected = createHash("sha256").update(canonicalize(unsigned), "utf8").digest("hex");
  if (expected !== profile.digest) throw new SandboxBackendRefusalError("compiled sandbox profile integrity check failed", "SANDBOX_PROFILE_INTEGRITY");
}

function isDeepFrozen(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value as Record<string, unknown>).every(isDeepFrozen);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SandboxBackendRefusalError("sandbox profile contains a non-finite number", "SANDBOX_PROFILE_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
  }
  throw new SandboxBackendRefusalError("sandbox profile contains a non-JSON value", "SANDBOX_PROFILE_INVALID");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function cleanProbeText(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 500) || "unknown";
}

function normalizeCgroupVersion(value: unknown): "v1" | "v2" | "unknown" {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "1" || normalized === "v1") return "v1";
  if (normalized === "2" || normalized === "v2") return "v2";
  return "unknown";
}

function minimalRuntimeEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.platform === "win32" ? String.raw`C:\Windows\System32` : "/usr/bin:/bin",
    ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {})
  };
}

function uniqueContainerName(): string {
  return `odinn-${process.pid.toString(36)}-${Date.now().toString(36)}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

const defaultProbeRunner: OciProbeRunner = (command, args) => {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    env: minimalRuntimeEnvironment(),
    shell: false,
    windowsHide: true,
    timeout: CONTROL_TIMEOUT_MS,
    maxBuffer: 1_000_000
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    ...(result.error ? { error: result.error } : {})
  };
};

function defaultControl(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolveControl, rejectControl) => {
    const child = spawn(command, [...args], {
      env: minimalRuntimeEnvironment(),
      shell: false,
      stdio: "ignore",
      windowsHide: true
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectControl(new Error(`sandbox control command timed out: ${args[0] ?? "unknown"}`));
    }, CONTROL_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectControl(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveControl();
      else rejectControl(new Error(`sandbox control command failed: ${args[0] ?? "unknown"}`));
    });
  });
}

function attestContainerProfile(command: string, containerName: string, profile: CompiledSandboxProfile, identity: SandboxRecoveryIdentity): void {
  const inspection = spawnSync(command, ["container", "inspect", containerName], {
    encoding: "utf8",
    env: minimalRuntimeEnvironment(),
    shell: false,
    windowsHide: true,
    timeout: CONTROL_TIMEOUT_MS,
    maxBuffer: 1_000_000
  });
  if (inspection.status !== 0 || inspection.error) {
    throw new SandboxBackendRefusalError("sandbox container could not be inspected before start", "SANDBOX_CONTROL_ATTESTATION_FAILED");
  }
  let record: any;
  try { record = JSON.parse(String(inspection.stdout ?? "[]"))[0]; }
  catch { throw new SandboxBackendRefusalError("sandbox container inspection was invalid", "SANDBOX_CONTROL_ATTESTATION_FAILED"); }
  attestContainerConfiguration(profile, record, identity);
}

export function attestContainerConfiguration(profile: CompiledSandboxProfile, record: unknown, identity?: SandboxRecoveryIdentity): void {
  assertCompiledProfile(profile);
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new SandboxBackendRefusalError("sandbox container inspection was invalid", "SANDBOX_CONTROL_ATTESTATION_FAILED");
  }
  const inspected = record as any;
  const host = inspected.HostConfig ?? {};
  const configuration = inspected.Config ?? {};
  const state = inspected.State ?? {};
  const labels = configuration.Labels && typeof configuration.Labels === "object" && !Array.isArray(configuration.Labels) ? configuration.Labels : {};
  const security: string[] = Array.isArray(host.SecurityOpt) ? host.SecurityOpt.map(String) : [];
  const seccompSelectors = security.filter((value) => value.startsWith("seccomp="));
  const noNewPrivilegesSelectors = security.filter((value) => value === "no-new-privileges" || value.startsWith("no-new-privileges="));
  const noNewPrivilegesMatches = noNewPrivilegesSelectors.length === 1
    && ["no-new-privileges", "no-new-privileges=true"].includes(noNewPrivilegesSelectors[0]!);
  const securityOptionsSafe = security.every((value) => value === "no-new-privileges" || value === "no-new-privileges=true" || value === "seccomp=builtin");
  const dropped: string[] = Array.isArray(host.CapDrop) ? host.CapDrop.map((value: unknown) => String(value).toUpperCase()) : [];
  const tmpfs = host.Tmpfs && typeof host.Tmpfs === "object" ? host.Tmpfs : {};
  const tmpfsTokens = typeof tmpfs["/tmp"] === "string" ? String(tmpfs["/tmp"]).split(",").map((value) => value.trim()).filter(Boolean) : [];
  const requiredTmpfsTokens = ["rw", "noexec", "nosuid", "nodev", `size=${profile.limits.tmpfsBytes}`];
  const tmpfsMatches = tmpfsTokens.length === requiredTmpfsTokens.length
    && new Set(tmpfsTokens).size === tmpfsTokens.length
    && requiredTmpfsTokens.every((token) => tmpfsTokens.includes(token));
  const declaredMounts = Array.isArray(host.Mounts) ? host.Mounts : [];
  const mountsMatch = profile.mounts.every((mount) => declaredMounts.some((actual: any) =>
    actual?.Type === "bind"
      && resolve(String(actual.Source ?? "")) === mount.source
      && String(actual.Target ?? actual.Destination ?? "") === mount.target
      && typeof actual.ReadOnly === "boolean"
      && actual.ReadOnly === (mount.access === "read-only")
  ));
  const forbiddenPrivilegeSurfaces = host.Privileged === true
    || (Array.isArray(host.Devices) && host.Devices.length > 0)
    || (Array.isArray(host.DeviceRequests) && host.DeviceRequests.length > 0)
    || (Array.isArray(host.Binds) && host.Binds.length > 0)
    || ["PidMode", "IpcMode", "UTSMode", "UsernsMode"].some((key) => typeof host[key] === "string" && host[key] !== "");
  const controlsMatch = String(host.NetworkMode ?? "") === "none"
    && state.Running === false
    && state.Paused === false
    && state.Restarting === false
    && String(state.Status ?? "").toLowerCase() === "created"
    && host.ReadonlyRootfs === true
    && String(configuration.User ?? "") === "65532:65532"
    && dropped.includes("ALL")
    && noNewPrivilegesMatches
    && securityOptionsSafe
    && !forbiddenPrivilegeSurfaces
    && (profile.backend !== "docker" || seccompSelectors.length === 1 && seccompSelectors[0] === "seccomp=builtin")
    && typeof host.PidsLimit === "number" && Number.isSafeInteger(host.PidsLimit) && host.PidsLimit === profile.limits.processCount
    && typeof host.Memory === "number" && Number.isSafeInteger(host.Memory) && host.Memory === profile.limits.memoryBytes
    && typeof host.MemorySwap === "number" && Number.isSafeInteger(host.MemorySwap) && host.MemorySwap === profile.limits.memoryBytes
    && typeof host.NanoCpus === "number" && Number.isSafeInteger(host.NanoCpus) && host.NanoCpus === Math.round(profile.limits.cpuCount * 1_000_000_000)
    && tmpfsMatches
    && mountsMatch
    && declaredMounts.length === profile.mounts.length;
  const identityMatches = !identity || labels["odinn.managed"] === "true"
    && labels["odinn.namespace-id"] === identity.namespaceId
    && labels["odinn.execution-id"] === identity.executionId
    && labels["odinn.profile-digest"] === profile.digest
    && labels["odinn.image-ref"] === profile.image;
  if (!controlsMatch || !identityMatches) {
    throw new SandboxBackendRefusalError("sandbox runtime did not preserve the compiled isolation controls", "SANDBOX_CONTROL_ATTESTATION_FAILED");
  }
}

function terminateProcessTree(child: any): void {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill?.("SIGKILL"); }
}

function backendFromCommand(command: string): OciBackendId {
  const name = basename(command).toLowerCase().replace(/\.exe$/u, "");
  if (name !== "docker" && name !== "podman") {
    throw new SandboxBackendRefusalError("sandbox engine command is not Docker or Podman", "SANDBOX_ENGINE_PATH_INVALID");
  }
  return name;
}

function trustedRuntimeCommand(command: string): string {
  const backend = backendFromCommand(command);
  return validateTrustedOciExecutable(backend, isAbsolute(command) ? command : defaultOciExecutable(backend));
}

export function digestOciEngineBinding(backend: OciBackendId, command: string): string {
  return createHash("sha256").update(`odinn.oci-engine.v1\0${backend}\0${resolve(command)}`, "utf8").digest("hex");
}

function bindLifecycleAdapter(adapter: OciLifecycleAdapter, executable: string): OciLifecycleAdapter {
  const backend = backendFromCommand(executable);
  return {
    prepare: (_command, args) => adapter.prepare(executable, args),
    attestContainer: (_command, containerName, profile, identity) => adapter.attestContainer(executable, containerName, profile, identity),
    spawn: (_command, args, options) => adapter.spawn(executable, args, options),
    control: (_command, args) => adapter.control(executable, args),
    terminate: (child) => adapter.terminate(child),
    locateManagedContainer: (_command, identity) => {
      if (digestOciEngineBinding(backend, executable) !== identity.engineBindingDigest) return Promise.resolve("unknown" as const);
      return adapter.locateManagedContainer(executable, identity);
    },
    ...(adapter.inspectImage ? { inspectImage: (_command: string, image: string) => adapter.inspectImage!(executable, image) } : {})
  };
}

function routeRecoveryAdapter(
  executablePaths: Readonly<Partial<Record<OciBackendId, string>>>,
  lifecycleAdapter: OciLifecycleAdapter
): OciLifecycleAdapter {
  const executable = (command: string) => {
    const backend = backendFromCommand(command);
    const configured = executablePaths[backend];
    if (!configured) throw new SandboxBackendRefusalError(`no configured ${backend} executable is available for recovery`, "SANDBOX_ENGINE_PATH_INVALID");
    return lifecycleAdapter === defaultLifecycleAdapter
      ? validateTrustedOciExecutable(backend, configured)
      : validateOciExecutablePathSyntax(backend, configured);
  };
  return {
    prepare: async () => { throw new SandboxBackendRefusalError("recovery adapter cannot create containers", "SANDBOX_RECOVERY_INVALID"); },
    attestContainer: async () => { throw new SandboxBackendRefusalError("recovery adapter cannot attest new containers", "SANDBOX_RECOVERY_INVALID"); },
    spawn: () => { throw new SandboxBackendRefusalError("recovery adapter cannot start containers", "SANDBOX_RECOVERY_INVALID"); },
    control: (command, args) => lifecycleAdapter.control(executable(command), args),
    terminate: () => undefined,
    locateManagedContainer: (command, identity) => {
      const backend = backendFromCommand(command);
      const current = executable(command);
      if (digestOciEngineBinding(backend, current) !== identity.engineBindingDigest) return Promise.resolve("unknown" as const);
      return lifecycleAdapter.locateManagedContainer(current, identity);
    }
  };
}

const defaultLifecycleAdapter: OciLifecycleAdapter = {
  prepare: (command, args) => defaultControl(trustedRuntimeCommand(command), args),
  attestContainer: async (command, containerName, profile, identity) => attestContainerProfile(trustedRuntimeCommand(command), containerName, profile, identity),
  spawn: (command, args, options) => spawn(trustedRuntimeCommand(command), [...args], options),
  control: (command, args) => defaultControl(trustedRuntimeCommand(command), args),
  terminate: terminateProcessTree,
  locateManagedContainer: async (command, identity) => {
    command = trustedRuntimeCommand(command);
    const options = {
      encoding: "utf8" as const,
      env: minimalRuntimeEnvironment(),
      shell: false as const,
      windowsHide: true,
      timeout: CONTROL_TIMEOUT_MS,
      maxBuffer: 1_000_000
    };
    const all = spawnSync(command, ["container", "ls", "--all", "--format", "{{.Names}}"], options);
    if (all.status !== 0 || all.error) return "unknown";
    const allNames = String(all.stdout ?? "").split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    if (!allNames.includes(identity.containerName)) return "absent";
    if (allNames.filter((name) => name === identity.containerName).length !== 1) return "unknown";
    const result = spawnSync(command, [
      "container", "ls", "--all",
      "--filter", "label=odinn.managed=true",
      "--filter", `label=odinn.namespace-id=${identity.namespaceId}`,
      "--filter", `label=odinn.execution-id=${identity.executionId}`,
      "--format", "{{.Names}}"
    ], options);
    if (result.status !== 0 || result.error) return "unknown";
    const names = String(result.stdout ?? "").split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    // The unfiltered query already proved that the exact name exists. Missing
    // expected labels is an identity contradiction, never absence.
    if (!names.length) return "unknown";
    return names.length === 1 && names[0] === identity.containerName ? "present" : "unknown";
  },
  inspectImage: async (command, image) => {
    command = trustedRuntimeCommand(command);
    const result = spawnSync(command, ["image", "inspect", image, "--format", "{{json .Config.Volumes}}"], {
      encoding: "utf8",
      env: minimalRuntimeEnvironment(),
      shell: false,
      windowsHide: true,
      timeout: CONTROL_TIMEOUT_MS,
      maxBuffer: 1_000_000
    });
    if (result.status !== 0 || result.error) {
      throw new SandboxBackendRefusalError("digest-pinned sandbox image is not available locally for inspection", "SANDBOX_IMAGE_UNAVAILABLE");
    }
    let value: unknown;
    try { value = JSON.parse(String(result.stdout ?? "null")); }
    catch { throw new SandboxBackendRefusalError("sandbox image volume metadata is invalid", "SANDBOX_IMAGE_INSPECTION_FAILED"); }
    if (value !== null && (!value || typeof value !== "object" || Array.isArray(value))) {
      throw new SandboxBackendRefusalError("sandbox image volume metadata is invalid", "SANDBOX_IMAGE_INSPECTION_FAILED");
    }
    return deepFreeze({ declaredVolumes: deepFreeze(value ? Object.keys(value as Record<string, unknown>).sort() : []) });
  }
};
