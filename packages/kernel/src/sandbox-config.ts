import { isIP } from "node:net";
import { isAbsolute, posix, win32 } from "node:path";
import { validateDigestPinnedOciImage } from "./sandbox-backend.ts";

const BACKENDS = ["rootless-oci", "oci", "confined-native"] as const;
const BACKEND_MODES = ["auto", ...BACKENDS] as const;
const HOME_MODES = ["persistent", "ephemeral"] as const;
const FILE_ACCESS = ["read-only", "read-write"] as const;
const NETWORK_MODES = ["denied", "brokered-public", "allowlisted", "unrestricted"] as const;
const HOST_MODES = ["deny", "prompt"] as const;
const HOST_SCOPES = ["restricted", "all"] as const;

type Backend = typeof BACKENDS[number];
type BackendMode = typeof BACKEND_MODES[number];
type FileAccess = typeof FILE_ACCESS[number];
type NetworkMode = typeof NETWORK_MODES[number];

export interface SandboxFilesystemGrant {
  readonly source: string;
  readonly target: string;
  readonly access: FileAccess;
}

export interface SandboxNetworkRule {
  readonly host: string;
  readonly ports: readonly number[];
}

export interface SandboxDeviceGrant {
  readonly source: string;
  readonly target: string;
  readonly access: FileAccess;
}

export interface SandboxSecretReference {
  readonly name: string;
  readonly sourceEnv: string;
  readonly targetEnv: string;
}

export interface SandboxBackendConfig {
  readonly mode: BackendMode;
  readonly preference: readonly Backend[];
  readonly unavailable: "refuse";
  readonly enginePaths: Readonly<{
    readonly podman?: string;
    readonly docker?: string;
  }>;
}

export interface SandboxConfig {
  readonly backend: SandboxBackendConfig;
  readonly home: {
    readonly mode: typeof HOME_MODES[number];
    readonly maxBytes: number;
  };
  readonly filesystem: {
    readonly sandboxHome: FileAccess;
    readonly grants: readonly SandboxFilesystemGrant[];
  };
  readonly network: {
    readonly mode: NetworkMode;
    readonly allow: readonly SandboxNetworkRule[];
    readonly deny: readonly SandboxNetworkRule[];
    readonly allowPrivate: boolean;
    readonly allowLoopback: boolean;
    readonly ports: readonly number[];
    readonly maxResponseBytes: number;
  };
  readonly process: {
    readonly enabled: boolean;
    readonly shell: boolean;
    readonly image?: string;
    readonly limits: {
      readonly timeoutMs: number;
      readonly cpu: number;
      readonly memoryBytes: number;
      readonly pids: number;
      readonly tmpfsBytes: number;
      readonly outputBytes: number;
    };
  };
  readonly environment: {
    readonly inherit: readonly string[];
    readonly set: Readonly<Record<string, string>>;
    readonly secrets: readonly SandboxSecretReference[];
  };
  readonly devices: {
    readonly grants: readonly SandboxDeviceGrant[];
  };
  readonly hostExecution: {
    readonly mode: typeof HOST_MODES[number];
    readonly scope: typeof HOST_SCOPES[number];
    readonly allowedCommands: readonly string[];
    readonly allowedRoots: readonly string[];
  };
}

export interface SandboxConfigInput {
  readonly sandbox?: unknown;
  readonly runtime?: unknown;
  readonly [key: string]: unknown;
}

export interface SandboxRiskSummary {
  readonly elevated: boolean;
  readonly broadFilesystemGrants: number;
  readonly writableFilesystemGrants: number;
  readonly networkMode: NetworkMode;
  readonly privateNetworkAccess: boolean;
  readonly loopbackAccess: boolean;
  readonly shellEnabled: boolean;
  readonly inheritedEnvironmentVariables: number;
  readonly secretReferences: number;
  readonly deviceGrants: number;
  readonly hostExecution: Readonly<{ mode: "deny" | "prompt"; scope: "restricted" | "all" }>;
  readonly enginePathsConfigured: Readonly<{ podman: boolean; docker: boolean }>;
  readonly risks: readonly string[];
}

const DEFAULT_ENGINE_PATHS: Readonly<{ podman?: string; docker?: string }> = process.platform === "linux"
  ? { podman: "/usr/bin/podman", docker: "/usr/bin/docker" }
  : {};

const DEFAULT_VALUE: SandboxConfig = {
  backend: { mode: "auto", preference: ["rootless-oci", "oci", "confined-native"], unavailable: "refuse", enginePaths: DEFAULT_ENGINE_PATHS },
  home: { mode: "persistent", maxBytes: 10 * 1024 * 1024 * 1024 },
  filesystem: { sandboxHome: "read-write", grants: [] },
  network: {
    mode: "brokered-public",
    allow: [],
    deny: [],
    allowPrivate: false,
    allowLoopback: false,
    ports: [80, 443],
    maxResponseBytes: 16 * 1024 * 1024
  },
  process: {
    enabled: true,
    shell: true,
    limits: {
      timeoutMs: 120_000,
      cpu: 2,
      memoryBytes: 2 * 1024 * 1024 * 1024,
      pids: 256,
      tmpfsBytes: 512 * 1024 * 1024,
      outputBytes: 1_000_000
    }
  },
  environment: { inherit: [], set: {}, secrets: [] },
  devices: { grants: [] },
  hostExecution: { mode: "deny", scope: "restricted", allowedCommands: [], allowedRoots: [] }
};

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = deepFreeze(DEFAULT_VALUE);

export function normalizeSandboxConfig(input: SandboxConfigInput | undefined = {}): SandboxConfig {
  const root = record(input, "config");
  const rawSandbox = root.sandbox === undefined ? {} : record(root.sandbox, "config.sandbox");
  const legacy = legacyHostExecution(root.runtime);
  const sandbox = parseSandbox(rawSandbox, legacy);
  return deepFreeze(sandbox);
}

export function validateSandboxConfig(input: SandboxConfigInput | undefined = {}): SandboxConfig {
  return normalizeSandboxConfig(input);
}

export function assertHostedSandboxConfig(input: SandboxConfigInput | SandboxConfig): SandboxConfig {
  const sandbox = looksNormalized(input) ? input : normalizeSandboxConfig(input);
  const violations: string[] = [];
  if (sandbox.filesystem.grants.length) violations.push("external filesystem grants");
  if (sandbox.network.mode === "unrestricted") violations.push("unrestricted network access");
  if (sandbox.network.allowPrivate) violations.push("private network access");
  if (sandbox.network.allowLoopback) violations.push("loopback access");
  if (sandbox.devices.grants.length) violations.push("device grants");
  if (sandbox.hostExecution.mode === "prompt") violations.push("host execution");
  if (sandbox.environment.inherit.length) violations.push("inherited host environment variables");
  if (sandbox.environment.secrets.length) violations.push("tenant-selected secret references");
  if (violations.length) throw new Error(`hosted sandbox configuration does not permit: ${violations.join(", ")}`);
  return sandbox;
}

export function summarizeSandboxRisk(input: SandboxConfigInput | SandboxConfig): SandboxRiskSummary {
  const sandbox = looksNormalized(input) ? input : normalizeSandboxConfig(input);
  const broadFilesystemGrants = sandbox.filesystem.grants.filter((grant) => broadHostPath(grant.source)).length;
  const writableFilesystemGrants = sandbox.filesystem.grants.filter((grant) => grant.access === "read-write").length;
  const risks: string[] = [];
  if (broadFilesystemGrants) risks.push("broad-filesystem-access");
  if (writableFilesystemGrants) risks.push("host-filesystem-write");
  if (sandbox.network.mode === "unrestricted") risks.push("unrestricted-network");
  if (sandbox.network.allowPrivate) risks.push("private-network-access");
  if (sandbox.network.allowLoopback) risks.push("loopback-access");
  if (sandbox.environment.inherit.length) risks.push("host-environment-inheritance");
  if (sandbox.devices.grants.length) risks.push("device-access");
  if (sandbox.hostExecution.mode === "prompt") risks.push(sandbox.hostExecution.scope === "all" ? "broad-host-execution-prompt" : "host-execution-prompt");
  return deepFreeze({
    elevated: risks.length > 0,
    broadFilesystemGrants,
    writableFilesystemGrants,
    networkMode: sandbox.network.mode,
    privateNetworkAccess: sandbox.network.allowPrivate,
    loopbackAccess: sandbox.network.allowLoopback,
    shellEnabled: sandbox.process.shell,
    inheritedEnvironmentVariables: sandbox.environment.inherit.length,
    secretReferences: sandbox.environment.secrets.length,
    deviceGrants: sandbox.devices.grants.length,
    hostExecution: { mode: sandbox.hostExecution.mode, scope: sandbox.hostExecution.scope },
    enginePathsConfigured: { podman: Boolean(sandbox.backend.enginePaths.podman), docker: Boolean(sandbox.backend.enginePaths.docker) },
    risks
  });
}

function parseSandbox(value: Record<string, unknown>, legacy: LegacyHostExecution | undefined): SandboxConfig {
  exactKeys(value, ["backend", "home", "filesystem", "network", "process", "environment", "devices", "hostExecution"], "config.sandbox");
  const backend = parseBackend(optionalRecord(value.backend, "config.sandbox.backend"));
  const home = parseHome(optionalRecord(value.home, "config.sandbox.home"));
  const filesystem = parseFilesystem(optionalRecord(value.filesystem, "config.sandbox.filesystem"));
  const network = parseNetwork(optionalRecord(value.network, "config.sandbox.network"));
  const processConfig = parseProcess(optionalRecord(value.process, "config.sandbox.process"));
  const environment = parseEnvironment(optionalRecord(value.environment, "config.sandbox.environment"));
  const devices = parseDevices(optionalRecord(value.devices, "config.sandbox.devices"));
  const explicitHost = value.hostExecution === undefined ? undefined : parseHostExecution(record(value.hostExecution, "config.sandbox.hostExecution"));
  const legacyHost = legacy && legacy.value
    ? { mode: "prompt", scope: "all", allowedCommands: [] as string[], allowedRoots: [] as string[] } as const
    : legacy
      ? { mode: "deny", scope: "restricted", allowedCommands: [] as string[], allowedRoots: [] as string[] } as const
      : undefined;
  if (explicitHost && legacyHost && !sameHostExecution(explicitHost, legacyHost)) {
    throw new Error("config.sandbox.hostExecution conflicts with runtime.allowUnconfinedProcessExec");
  }
  if (backend.mode === "confined-native" && processConfig.enabled) {
    throw new Error("config.sandbox.backend.mode confined-native cannot isolate process execution; select an OCI backend or disable process execution");
  }
  return { backend, home, filesystem, network, process: processConfig, environment, devices, hostExecution: explicitHost ?? legacyHost ?? clone(DEFAULT_SANDBOX_CONFIG.hostExecution) };
}

function parseBackend(value: Record<string, unknown>): SandboxConfig["backend"] {
  exactKeys(value, ["mode", "preference", "unavailable", "enginePaths"], "config.sandbox.backend");
  const mode = enumeration(value.mode ?? DEFAULT_SANDBOX_CONFIG.backend.mode, BACKEND_MODES, "config.sandbox.backend.mode");
  const preference = stringArray(value.preference ?? DEFAULT_SANDBOX_CONFIG.backend.preference, "config.sandbox.backend.preference", 3)
    .map((entry, index) => enumeration(entry, BACKENDS, `config.sandbox.backend.preference[${index}]`));
  unique(preference, "config.sandbox.backend.preference");
  if (!preference.length) throw new Error("config.sandbox.backend.preference must not be empty");
  const unavailable = enumeration(value.unavailable ?? "refuse", ["refuse"] as const, "config.sandbox.backend.unavailable");
  const enginePathsInput = value.enginePaths === undefined
    ? clone(DEFAULT_SANDBOX_CONFIG.backend.enginePaths)
    : record(value.enginePaths, "config.sandbox.backend.enginePaths");
  exactKeys(enginePathsInput, ["podman", "docker"], "config.sandbox.backend.enginePaths");
  const enginePaths: { podman?: string; docker?: string } = {};
  for (const engine of ["podman", "docker"] as const) {
    if (enginePathsInput[engine] !== undefined) {
      enginePaths[engine] = enginePath(enginePathsInput[engine], engine, `config.sandbox.backend.enginePaths.${engine}`);
    }
  }
  return { mode, preference, unavailable, enginePaths };
}

function parseHome(value: Record<string, unknown>): SandboxConfig["home"] {
  exactKeys(value, ["mode", "maxBytes"], "config.sandbox.home");
  return {
    mode: enumeration(value.mode ?? DEFAULT_SANDBOX_CONFIG.home.mode, HOME_MODES, "config.sandbox.home.mode"),
    maxBytes: integer(value.maxBytes ?? DEFAULT_SANDBOX_CONFIG.home.maxBytes, 64 * 1024 * 1024, 1024 ** 4, "config.sandbox.home.maxBytes")
  };
}

function parseFilesystem(value: Record<string, unknown>): SandboxConfig["filesystem"] {
  exactKeys(value, ["sandboxHome", "grants"], "config.sandbox.filesystem");
  const grants = objectArray(value.grants ?? [], "config.sandbox.filesystem.grants", 64).map((grant, index) => {
    const label = `config.sandbox.filesystem.grants[${index}]`;
    exactKeys(grant, ["source", "target", "access"], label);
    return {
      source: absolutePath(requiredString(grant.source, `${label}.source`, 4096), `${label}.source`),
      target: sandboxTarget(requiredString(grant.target, `${label}.target`, 4096), `${label}.target`),
      access: enumeration(grant.access, FILE_ACCESS, `${label}.access`)
    };
  });
  unique(grants.map((grant) => grant.target), "config.sandbox.filesystem.grants targets");
  rejectOverlappingTargets(grants.map((grant) => grant.target), "config.sandbox.filesystem.grants targets");
  return { sandboxHome: enumeration(value.sandboxHome ?? "read-write", FILE_ACCESS, "config.sandbox.filesystem.sandboxHome"), grants };
}

function parseNetwork(value: Record<string, unknown>): SandboxConfig["network"] {
  exactKeys(value, ["mode", "allow", "deny", "allowPrivate", "allowLoopback", "ports", "maxResponseBytes"], "config.sandbox.network");
  const mode = enumeration(value.mode ?? DEFAULT_SANDBOX_CONFIG.network.mode, NETWORK_MODES, "config.sandbox.network.mode");
  const allow = networkRules(value.allow ?? [], "config.sandbox.network.allow");
  const deny = networkRules(value.deny ?? [], "config.sandbox.network.deny");
  const allowPrivate = boolean(value.allowPrivate ?? false, "config.sandbox.network.allowPrivate");
  const allowLoopback = boolean(value.allowLoopback ?? false, "config.sandbox.network.allowLoopback");
  const ports = portArray(value.ports ?? DEFAULT_SANDBOX_CONFIG.network.ports, "config.sandbox.network.ports");
  if (!ports.length) throw new Error("config.sandbox.network.ports must not be empty");
  for (const [index, rule] of allow.entries()) {
    if (rule.ports.some((port) => !ports.includes(port))) {
      throw new Error(`config.sandbox.network.allow[${index}].ports must be a subset of config.sandbox.network.ports`);
    }
  }
  if (mode === "denied" && (allow.length || allowPrivate || allowLoopback)) {
    throw new Error("config.sandbox.network denied mode cannot grant hosts, private networks, or loopback");
  }
  if (mode === "allowlisted" && !allow.length) throw new Error("config.sandbox.network allowlisted mode requires at least one allow rule");
  return {
    mode,
    allow,
    deny,
    allowPrivate,
    allowLoopback,
    ports,
    maxResponseBytes: integer(value.maxResponseBytes ?? DEFAULT_SANDBOX_CONFIG.network.maxResponseBytes, 1024, 256 * 1024 * 1024, "config.sandbox.network.maxResponseBytes")
  };
}

function parseProcess(value: Record<string, unknown>): SandboxConfig["process"] {
  exactKeys(value, ["enabled", "shell", "image", "limits"], "config.sandbox.process");
  const limits = optionalRecord(value.limits, "config.sandbox.process.limits");
  exactKeys(limits, ["timeoutMs", "cpu", "memoryBytes", "pids", "tmpfsBytes", "outputBytes"], "config.sandbox.process.limits");
  const enabled = boolean(value.enabled ?? true, "config.sandbox.process.enabled");
  const shell = boolean(value.shell ?? true, "config.sandbox.process.shell");
  if (!enabled && shell) throw new Error("config.sandbox.process.shell cannot be enabled when process execution is disabled");
  const image = value.image === undefined
    ? undefined
    : validateDigestPinnedOciImage(value.image);
  return {
    enabled,
    shell,
    ...(image ? { image } : {}),
    limits: {
      timeoutMs: integer(limits.timeoutMs ?? DEFAULT_SANDBOX_CONFIG.process.limits.timeoutMs, 100, 3_600_000, "config.sandbox.process.limits.timeoutMs"),
      cpu: boundedNumber(limits.cpu ?? DEFAULT_SANDBOX_CONFIG.process.limits.cpu, 0.1, 64, "config.sandbox.process.limits.cpu"),
      memoryBytes: integer(limits.memoryBytes ?? DEFAULT_SANDBOX_CONFIG.process.limits.memoryBytes, 64 * 1024 * 1024, 1024 ** 4, "config.sandbox.process.limits.memoryBytes"),
      pids: integer(limits.pids ?? DEFAULT_SANDBOX_CONFIG.process.limits.pids, 16, 4096, "config.sandbox.process.limits.pids"),
      tmpfsBytes: integer(limits.tmpfsBytes ?? DEFAULT_SANDBOX_CONFIG.process.limits.tmpfsBytes, 1024 * 1024, 64 * 1024 * 1024 * 1024, "config.sandbox.process.limits.tmpfsBytes"),
      outputBytes: integer(limits.outputBytes ?? DEFAULT_SANDBOX_CONFIG.process.limits.outputBytes, 1024, 100 * 1024 * 1024, "config.sandbox.process.limits.outputBytes")
    }
  };
}

function parseEnvironment(value: Record<string, unknown>): SandboxConfig["environment"] {
  exactKeys(value, ["inherit", "set", "secrets"], "config.sandbox.environment");
  const inherit = stringArray(value.inherit ?? [], "config.sandbox.environment.inherit", 64).map((name, index) => environmentName(name, `config.sandbox.environment.inherit[${index}]`));
  unique(inherit, "config.sandbox.environment.inherit");
  const set = optionalRecord(value.set, "config.sandbox.environment.set");
  if (Object.keys(set).length > 64) throw new Error("config.sandbox.environment.set must contain at most 64 entries");
  const normalizedSet: Record<string, string> = {};
  for (const [name, raw] of Object.entries(set)) {
    environmentName(name, "config.sandbox.environment.set key");
    if (secretLikeEnvironmentName(name)) {
      throw new Error(`config.sandbox.environment.set cannot contain secret-like variable ${name}; use a secret reference`);
    }
    normalizedSet[name] = requiredString(raw, `config.sandbox.environment.set.${name}`, 8192, true);
  }
  const secrets = objectArray(value.secrets ?? [], "config.sandbox.environment.secrets", 64).map((secret, index) => {
    const label = `config.sandbox.environment.secrets[${index}]`;
    exactKeys(secret, ["name", "sourceEnv", "targetEnv"], label);
    return {
      name: identifier(secret.name, `${label}.name`),
      sourceEnv: environmentName(secret.sourceEnv, `${label}.sourceEnv`),
      targetEnv: environmentName(secret.targetEnv, `${label}.targetEnv`)
    };
  });
  unique(secrets.map((secret) => secret.name), "config.sandbox.environment.secrets names");
  unique(secrets.map((secret) => secret.targetEnv), "config.sandbox.environment.secrets targetEnv values");
  for (const target of secrets.map((secret) => secret.targetEnv)) {
    if (inherit.includes(target) || target in normalizedSet) throw new Error("config.sandbox.environment secret targets must not overlap inherited or set variables");
  }
  return { inherit, set: normalizedSet, secrets };
}

function parseDevices(value: Record<string, unknown>): SandboxConfig["devices"] {
  exactKeys(value, ["grants"], "config.sandbox.devices");
  const grants = objectArray(value.grants ?? [], "config.sandbox.devices.grants", 16).map((grant, index) => {
    const label = `config.sandbox.devices.grants[${index}]`;
    exactKeys(grant, ["source", "target", "access"], label);
    return {
      source: absolutePath(requiredString(grant.source, `${label}.source`, 4096), `${label}.source`),
      target: sandboxTarget(requiredString(grant.target, `${label}.target`, 4096), `${label}.target`),
      access: enumeration(grant.access, FILE_ACCESS, `${label}.access`)
    };
  });
  unique(grants.map((grant) => grant.target), "config.sandbox.devices.grants targets");
  return { grants };
}

function parseHostExecution(value: Record<string, unknown>): SandboxConfig["hostExecution"] {
  exactKeys(value, ["mode", "scope", "allowedCommands", "allowedRoots"], "config.sandbox.hostExecution");
  const mode = enumeration(value.mode ?? DEFAULT_SANDBOX_CONFIG.hostExecution.mode, HOST_MODES, "config.sandbox.hostExecution.mode");
  const scope = enumeration(value.scope ?? DEFAULT_SANDBOX_CONFIG.hostExecution.scope, HOST_SCOPES, "config.sandbox.hostExecution.scope");
  const allowedCommands = stringArray(value.allowedCommands ?? [], "config.sandbox.hostExecution.allowedCommands", 64)
    .map((path, index) => absolutePath(path, `config.sandbox.hostExecution.allowedCommands[${index}]`));
  const allowedRoots = stringArray(value.allowedRoots ?? [], "config.sandbox.hostExecution.allowedRoots", 64)
    .map((path, index) => absolutePath(path, `config.sandbox.hostExecution.allowedRoots[${index}]`));
  unique(allowedCommands, "config.sandbox.hostExecution.allowedCommands");
  unique(allowedRoots, "config.sandbox.hostExecution.allowedRoots");
  if (mode === "deny" && (scope !== "restricted" || allowedCommands.length || allowedRoots.length)) {
    throw new Error("config.sandbox.hostExecution deny mode cannot declare broad scope, commands, or roots");
  }
  if (scope === "all" && (allowedCommands.length || allowedRoots.length)) {
    throw new Error("config.sandbox.hostExecution all scope cannot also declare command or root restrictions");
  }
  return { mode, scope, allowedCommands, allowedRoots };
}

function networkRules(input: unknown, label: string): SandboxNetworkRule[] {
  const rules = objectArray(input, label, 256).map((rule, index) => {
    const item = `${label}[${index}]`;
    exactKeys(rule, ["host", "ports"], item);
    const ports = portArray(rule.ports, `${item}.ports`);
    if (!ports.length) throw new Error(`${item}.ports must not be empty`);
    return { host: networkHost(rule.host, `${item}.host`), ports };
  });
  unique(rules.map((rule) => `${rule.host}:${rule.ports.join(",")}`), label);
  return rules;
}

function networkHost(input: unknown, label: string): string {
  const value = requiredString(input, label, 253);
  if (value !== value.toLowerCase()) throw new Error(`${label} must be lowercase`);
  const bare = value.startsWith("*.") ? value.slice(2) : value;
  if (value === "*" || value.includes("://") || value.includes("/") || value.includes("@")) throw new Error(`${label} must be a DNS name or literal IP without a scheme, path, or credentials`);
  if (isIP(bare)) {
    if (value.startsWith("*.")) throw new Error(`${label} cannot wildcard an IP address`);
    return value;
  }
  if (bare.length < 1 || !bare.includes(".") || bare.split(".").some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part))) {
    throw new Error(`${label} must be a valid DNS name or literal IP`);
  }
  return value;
}

function portArray(input: unknown, label: string): number[] {
  if (!Array.isArray(input) || input.length > 64) throw new Error(`${label} must be an array of at most 64 ports`);
  const ports = input.map((port, index) => integer(port, 1, 65_535, `${label}[${index}]`));
  unique(ports, label);
  return ports;
}

type LegacyHostExecution = { value: boolean };

function legacyHostExecution(input: unknown): LegacyHostExecution | undefined {
  if (input === undefined) return undefined;
  const runtime = record(input, "config.runtime");
  if (runtime.allowUnconfinedProcessExec === undefined) return undefined;
  return { value: boolean(runtime.allowUnconfinedProcessExec, "config.runtime.allowUnconfinedProcessExec") };
}

function sameHostExecution(left: SandboxConfig["hostExecution"], right: SandboxConfig["hostExecution"]): boolean {
  return left.mode === right.mode && left.scope === right.scope && left.allowedCommands.length === 0 && left.allowedRoots.length === 0;
}

function looksNormalized(input: SandboxConfigInput | SandboxConfig): input is SandboxConfig {
  return Boolean(input && typeof input === "object" && "backend" in input && "hostExecution" in input && !("sandbox" in input));
}

function broadHostPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").replace(/\/$/u, "");
  const withoutDrive = normalized.replace(/^[a-z]:/iu, "");
  const parts = withoutDrive.split("/").filter(Boolean);
  return parts.length <= 2;
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value) && !win32.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  const separatorPattern = win32.isAbsolute(value) ? /[\\/]+/u : /\/+/u;
  if (value.split(separatorPattern).some((part) => part === "." || part === "..")) throw new Error(`${label} must not contain dot segments`);
  return value;
}

function sandboxTarget(value: string, label: string): string {
  if (!posix.isAbsolute(value) || posix.normalize(value) !== value) {
    throw new Error(`${label} must be a normalized absolute POSIX path`);
  }
  return value;
}

function enginePath(input: unknown, engine: "podman" | "docker", label: string): string {
  const value = requiredString(input, label, 4096);
  const windowsPath = !posix.isAbsolute(value) && win32.isAbsolute(value);
  if (!isAbsolute(value) && !windowsPath) throw new Error(`${label} must be an absolute path`);
  const normalized = windowsPath ? win32.normalize(value) : posix.normalize(value);
  if (normalized !== value) throw new Error(`${label} must be a normalized absolute path`);
  const name = (windowsPath ? win32.basename(value) : posix.basename(value)).toLowerCase();
  if (name !== engine && name !== `${engine}.exe`) throw new Error(`${label} must name the ${engine} executable`);
  return value;
}

function environmentName(input: unknown, label: string): string {
  const value = requiredString(input, label, 128);
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(value)) throw new Error(`${label} must be an uppercase environment variable name`);
  return value;
}

function identifier(input: unknown, label: string): string {
  const value = requiredString(input, label, 64);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)) throw new Error(`${label} must be a lowercase identifier`);
  return value;
}

function optionalRecord(input: unknown, label: string): Record<string, unknown> {
  return input === undefined ? {} : record(input, label);
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be a JSON object`);
  return input as Record<string, unknown>;
}

function objectArray(input: unknown, label: string, maximum: number): Record<string, unknown>[] {
  if (!Array.isArray(input) || input.length > maximum) throw new Error(`${label} must be an array of at most ${maximum} objects`);
  return input.map((value, index) => record(value, `${label}[${index}]`));
}

function stringArray(input: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(input) || input.length > maximum) throw new Error(`${label} must be an array of at most ${maximum} strings`);
  return input.map((value, index) => requiredString(value, `${label}[${index}]`, 4096));
}

function requiredString(input: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof input !== "string" || (!allowEmpty && input.length === 0) || Buffer.byteLength(input, "utf8") > maximum) {
    throw new Error(`${label} must be ${allowEmpty ? "a" : "a non-empty"} string of at most ${maximum} UTF-8 bytes`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(input)) throw new Error(`${label} must not contain control characters or NUL`);
  return input;
}

/*
 * A value alone cannot be classified as a secret without false positives: API
 * keys have no universal syntax and ordinary build values can be high entropy.
 * Direct assignment is therefore rejected for secret-bearing variable names;
 * callers must use an explicit secret reference. The runtime must still avoid
 * logging all environment values, including values whose names are innocuous.
 */
function secretLikeEnvironmentName(name: string): boolean {
  return /(?:secret|token|password|passwd|api[_-]?key|credential|private[_-]?key)/iu.test(name);
}

function boolean(input: unknown, label: string): boolean {
  if (typeof input !== "boolean") throw new Error(`${label} must be true or false`);
  return input;
}

function integer(input: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < minimum || (input as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return input as number;
}

function boundedNumber(input: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < minimum || input > maximum) {
    throw new Error(`${label} must be a number from ${minimum} through ${maximum}`);
  }
  return input;
}

function enumeration<const Values extends readonly string[]>(input: unknown, values: Values, label: string): Values[number] {
  if (typeof input !== "string" || !(values as readonly unknown[]).includes(input)) throw new Error(`${label} must be one of: ${values.join(", ")}`);
  return input as Values[number];
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} contains unknown field: ${unknown.sort()[0]}`);
}

function unique(values: readonly (string | number)[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`);
}

function rejectOverlappingTargets(values: readonly string[], label: string): void {
  const normalized = values.map((value) => value.replaceAll("\\", "/").replace(/\/+$/u, "") || "/");
  for (let left = 0; left < normalized.length; left += 1) {
    for (let right = left + 1; right < normalized.length; right += 1) {
      if (normalized[left].startsWith(`${normalized[right]}/`) || normalized[right].startsWith(`${normalized[left]}/`)) {
        throw new Error(`${label} must not overlap`);
      }
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
