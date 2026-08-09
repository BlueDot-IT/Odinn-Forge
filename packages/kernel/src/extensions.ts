import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CapabilityBroker, Sentinel } from "./differentiated-runtime.ts";
import { redact } from "./run-ledger.ts";
import { materializeSandboxBundle } from "./sandbox-bundle.ts";
import { OciSandboxBackend, SandboxBackendRefusalError, SandboxExecutionError, compileSandboxProfile, detectOciBackend, validateDigestPinnedOciImage, type OciCapabilityProbe, type SandboxExecutionResult, type SandboxInteractiveSession } from "./sandbox-backend.ts";
import { normalizeSandboxConfig, type SandboxConfig, type SandboxConfigInput } from "./sandbox-config.ts";
import type { JsonObject } from "@odinn/protocol";

const EXTENSION_SCHEMA_VERSION = 1;
const EXTENSION_TYPES = new Set(["tool", "skill", "mcp"]);
const SANDBOXES = new Set(["unconfined-process", "container", "none"]);
const MAX_EXTENSION_OUTPUT_BYTES = 1_000_000;

type ExtensionType = "tool" | "skill" | "mcp";
type ExtensionSandbox = "unconfined-process" | "container" | "none";
interface ExtensionManifest extends JsonObject {
  schemaVersion: number; installId: string; id: string; version: string; name: string;
  type: ExtensionType; entrypoint: string; capabilities: string[]; sandbox: ExtensionSandbox;
  source: string; provenance: string; digest: string; contentDigest: string;
  bundleRoot: string; bundleDigest: string; containerImage: string;
  integrity: string; permissions: JsonObject; installedAt?: string; enabled?: boolean;
  trusted?: boolean; grants?: string[]; rollbackId?: string; enabledAt?: string;
  disabledAt?: string; disabledReason?: string; rolledBackAt?: string;
}
interface ExtensionState { schemaVersion: number; extensions: Record<string, ExtensionManifest>; history: Record<string, ExtensionManifest[]> }
interface InstallOptions { source?: string; provenance?: string }
interface EnableOptions { grants?: string[]; trust?: boolean; allowUnsafeSandbox?: boolean }
type StateMutation<T> = (state: ExtensionState) => T | Promise<T>;
type NodeError = Error & { code?: string };

export function extensionIdentityFingerprint(extension: any): string {
  return createHash("sha256").update(JSON.stringify({
    id: extension?.id ?? "",
    type: extension?.type ?? "",
    installId: extension?.installId ?? "",
    version: extension?.version ?? "",
    bundleDigest: extension?.bundleDigest ?? "",
    containerImage: extension?.containerImage ?? "",
    entrypoint: extension?.entrypoint ?? "",
    bundleRoot: extension?.bundleRoot ?? "",
    capabilities: Array.isArray(extension?.capabilities) ? [...extension.capabilities].sort() : [],
    grants: Array.isArray(extension?.grants) ? [...extension.grants].sort() : []
  })).digest("hex");
}

interface ExtensionRuntime {
  runLedger: any;
  auditStore: { append(event: JsonObject): Promise<unknown> };
  runId?: string; featureFlags?: Record<string, boolean>; workspaceRoot?: string;
  actor?: string; policy?: any; capabilityToken?: string;
  /** The enclosing governed MCP tool already consumed its capability at admission. */
  authorizedByAdmission?: boolean;
}
interface ExtensionExecutorOptions { workspaceRoot?: string; defaultTimeoutMs?: number; config?: SandboxConfigInput }
type McpMethod = "tools/list" | "tools/call";
const MCP_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
interface InvokeOptions {
  capability?: string;
  timeoutMs?: number;
  runtime?: ExtensionRuntime;
  capabilityToken?: string;
  signal?: AbortSignal;
  mcpMethod?: McpMethod;
  onDispatchAuthorized?: (evidence: JsonObject) => void | Promise<void>;
  expectedIdentityFingerprint?: string;
}
interface ExtensionRequest extends JsonObject {}
interface ProcessOptions { timeoutMs: number; protocol: "mcp-jsonl" | "odinn-jsonl" }
interface ProcessResponse extends JsonObject { result?: any; error?: { message?: string } }

export class ExtensionRegistry {
  readonly path: string;
  private writeChain: Promise<unknown>;

  constructor(path: string) {
    if (!path) throw new Error("ExtensionRegistry requires a path");
    this.path = path;
    this.writeChain = Promise.resolve();
  }

  async list() {
    const state = await this.readState();
    return Object.values(state.extensions).sort((left, right) => left.id.localeCompare(right.id));
  }

  async get(id: string) {
    const state = await this.readState();
    return state.extensions[id];
  }

  async install(input: unknown, { source = "local", provenance = "user-reviewed" }: InstallOptions = {}) {
    const manifest = normalizeManifest(input, { source, provenance });
    return this.mutate((state) => {
      const current = state.extensions[manifest.id];
      if (current) state.history[manifest.id] = [...(state.history[manifest.id] ?? []), current].slice(-10);
      state.extensions[manifest.id] = {
        ...manifest,
        installedAt: new Date().toISOString(),
        enabled: false,
        trusted: false,
        grants: [],
        rollbackId: current?.installId
      };
      return state.extensions[manifest.id];
    });
  }

  async enable(id: string, { grants = [], trust = false, allowUnsafeSandbox = false }: EnableOptions = {}) {
    return this.mutate((state) => {
      const extension = state.extensions[id];
      if (!extension) throw new Error(`extension not found: ${id}`);
      if (!extension.trusted && trust !== true) throw new Error(`extension is untrusted: ${id}; review provenance before enabling`);
      const integrityDigest = extension.sandbox === "container" ? extension.bundleDigest : extension.contentDigest;
      if (!/^[a-f0-9]{64}$/.test(integrityDigest ?? "")) throw new Error(`extension requires a full SHA-256 ${extension.sandbox === "container" ? "bundleDigest" : "contentDigest"} before enabling: ${id}`);
      if (["none", "unconfined-process"].includes(extension.sandbox) && allowUnsafeSandbox !== true) throw new Error(`extension requests unconfined execution: ${id}; pass the explicit unsafe-sandbox acknowledgement after review`);
      const requested = new Set(extension.capabilities);
      const selected = [...new Set(grants)].filter((grant) => requested.has(grant));
      if (selected.length !== new Set(grants).size) throw new Error(`extension grant exceeds manifest capabilities: ${id}`);
      state.extensions[id] = { ...extension, enabled: true, trusted: true, grants: selected, enabledAt: new Date().toISOString() };
      return state.extensions[id];
    });
  }

  async disable(id: string, reason = "operator disabled") {
    return this.mutate((state) => {
      const extension = state.extensions[id];
      if (!extension) throw new Error(`extension not found: ${id}`);
      state.extensions[id] = { ...extension, enabled: false, disabledAt: new Date().toISOString(), disabledReason: reason };
      return state.extensions[id];
    });
  }

  async rollback(id: string) {
    return this.mutate((state) => {
      const history = state.history[id] ?? [];
      const previous = history.pop();
      if (!previous) throw new Error(`no rollback version available: ${id}`);
      state.history[id] = history;
      state.extensions[id] = { ...previous, enabled: false, trusted: false, grants: [], rolledBackAt: new Date().toISOString() };
      return state.extensions[id];
    });
  }

  async readState(): Promise<ExtensionState> {
    try {
      const state = JSON.parse(await readFile(this.path, "utf8"));
      if (state.schemaVersion !== EXTENSION_SCHEMA_VERSION || !state.extensions || !state.history) throw new Error("unsupported extension registry schema");
      return state;
    } catch (error) {
      if ((error as NodeError | undefined)?.code === "ENOENT") return { schemaVersion: EXTENSION_SCHEMA_VERSION, extensions: {}, history: {} };
      throw error;
    }
  }

  async mutate<T>(fn: StateMutation<T>): Promise<T> {
    const operation = this.writeChain.then(async () => {
      const state = await this.readState();
      const result = await fn(state);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = join(dirname(this.path), `.${this.path.split(/[\\/]/).pop()}.${process.pid}.${Date.now()}.tmp`);
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      return result;
    });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }
}

export class ExtensionExecutor {
  readonly registry: ExtensionRegistry;
  readonly workspaceRoot: string;
  readonly defaultTimeoutMs: number;
  readonly sandboxConfig: SandboxConfig;

  constructor(registry: ExtensionRegistry, { workspaceRoot = process.cwd(), defaultTimeoutMs = 30_000, config = {} }: ExtensionExecutorOptions = {}) {
    if (!registry || typeof registry.get !== "function") throw new Error("ExtensionExecutor requires an ExtensionRegistry");
    this.registry = registry;
    this.workspaceRoot = resolve(workspaceRoot);
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.sandboxConfig = normalizeSandboxConfig(config);
  }

  async invoke(id: string, input: JsonObject = {}, { capability, timeoutMs = this.defaultTimeoutMs, runtime, capabilityToken, signal, mcpMethod, onDispatchAuthorized, expectedIdentityFingerprint }: InvokeOptions = {}) {
    const extension = await this.registry.get(id);
    if (!extension) throw new Error(`extension not found: ${id}`);
    if (expectedIdentityFingerprint && extensionIdentityFingerprint(extension) !== expectedIdentityFingerprint) throw new Error(`extension manifest changed before governed execution: ${id}`);
    if (!extension.enabled || !extension.trusted) throw new Error(`extension is not enabled and trusted: ${id}`);
    if (!["unconfined-process", "container"].includes(extension.sandbox)) throw new Error(`extension sandbox is not executable by this adapter: ${extension.sandbox}`);
    const requested = String(capability || extension.capabilities[0] || "").trim();
    if (!requested || !(extension.grants ?? []).includes(requested)) throw new Error(`extension capability is not granted: ${requested || "unspecified"}`);
    if (extension.sandbox === "container" && !this.sandboxConfig.process.enabled) throw new Error("container extension execution is disabled by config.sandbox.process.enabled");
    if (extension.sandbox === "unconfined-process") {
      throw new Error(
        "unconfined extension execution is unavailable until a host-approved backend can bind the exact command, root, limits, and one-time operator approval into audited execution evidence"
      );
    }
    if (!extension.entrypoint || extension.entrypoint.includes("\0")) throw new Error(`extension entrypoint is missing: ${id}`);
    const realRoot = await realpath(this.workspaceRoot);
    const lexicalEntrypoint = resolve(realRoot, extension.entrypoint);
    const entrypoint = await realpath(lexicalEntrypoint);
    const relativeEntrypoint = relative(realRoot, entrypoint);
    if (!relativeEntrypoint || relativeEntrypoint.startsWith("..") || relativeEntrypoint.includes(`..${sep}`) || !entrypoint.startsWith(`${realRoot}${sep}`)) {
      throw new Error("extension entrypoint must remain inside the configured workspace root");
    }
    const bundleRoot = await realpath(resolve(realRoot, extension.bundleRoot || dirname(extension.entrypoint)));
    if (bundleRoot !== realRoot && !bundleRoot.startsWith(`${realRoot}${sep}`)) throw new Error("extension bundle must remain inside the configured workspace root");
    if (extension.sandbox === "container") {
      const bundleDigest = await digestExtensionBundle(bundleRoot);
      if (!/^[a-f0-9]{64}$/.test(extension.bundleDigest) || extension.bundleDigest !== bundleDigest) throw new Error(`extension bundle integrity check failed: ${id}`);
    }
    const protocol = extension.type === "mcp" ? "mcp-jsonl" : "odinn-jsonl";
    const request = protocol === "mcp-jsonl"
      ? (mcpMethod ? createMcpRequestSequence(mcpMethod, input) : { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: input.name || extension.id, arguments: input.arguments ?? input } })
      : { type: "odinn.call", id: `call_${randomUUID()}`, input, capability: requested };
    if (!runtime) throw new Error("extension execution requires the audited runtime boundary");
    const snapshot = await createExtensionExecutionSnapshot(extension, entrypoint, bundleRoot, runtime.runLedger.stateDir, signal);
    return invokeThroughRuntime({
      id,
      input,
      requested,
      extension,
      entrypoint: snapshot.entrypoint,
      bundleRoot: snapshot.bundleRoot,
      request,
      protocol,
      timeoutMs,
      runtime: { ...runtime, capabilityToken },
      sandboxConfig: this.sandboxConfig,
      sealedBundleDigest: snapshot.sealedBundleDigest,
      signal,
      mcpMethod,
      onDispatchAuthorized
    });
  }
}

async function createExtensionExecutionSnapshot(extension: ExtensionManifest, entrypoint: string, bundleRoot: string, stateDir: string, signal?: AbortSignal) {
  const sealed = await materializeSandboxBundle(bundleRoot, join(resolve(stateDir), "sandbox-bundles"), { signal });
  const verifiedDigest = await digestExtensionBundle(sealed.path);
  if (extension.bundleDigest !== verifiedDigest) throw new Error(`extension bundle changed while sealing its execution bundle: ${extension.id}`);
  const relativeEntrypoint = relative(bundleRoot, entrypoint).replaceAll("\\", "/");
  if (!relativeEntrypoint || relativeEntrypoint.startsWith("..")) throw new Error("extension entrypoint must remain inside its sealed execution bundle");
  const sealedEntrypoint = await realpath(resolve(sealed.path, relativeEntrypoint));
  if (!sealedEntrypoint.startsWith(`${sealed.path}${sep}`)) throw new Error("extension entrypoint escapes its sealed execution bundle");
  return { bundleRoot: sealed.path, entrypoint: sealedEntrypoint, sealedBundleDigest: sealed.digest };
}

type ExtensionRequestSequence = ExtensionRequest | readonly ExtensionRequest[];
interface RuntimeInvocation { id: string; input: JsonObject; requested: string; extension: ExtensionManifest; entrypoint: string; bundleRoot: string; request: ExtensionRequestSequence; protocol: "mcp-jsonl" | "odinn-jsonl"; timeoutMs: number; runtime: ExtensionRuntime; sandboxConfig: SandboxConfig; sealedBundleDigest?: string; signal?: AbortSignal; mcpMethod?: McpMethod; onDispatchAuthorized?: (evidence: JsonObject) => void | Promise<void> }
async function invokeThroughRuntime({ id, input, requested, extension, entrypoint, bundleRoot, request, protocol, timeoutMs, runtime, sandboxConfig, sealedBundleDigest, signal, mcpMethod, onDispatchAuthorized }: RuntimeInvocation) {
  const ledger = runtime.runLedger;
  const auditStore = runtime.auditStore;
  if (!ledger || !auditStore) throw new Error("extension runtime enforcement requires runLedger and auditStore");
  const runId = String(runtime.runId || `extension_${randomUUID()}`);
  const featureFlags = ledger.featureFlags ?? runtime.featureFlags ?? {};
  const safety = { toolName: "extension.invoke", effects: ["process", ...(extension.type === "mcp" ? ["network"] : [])], reversibility: "compensatable", requiresCapability: true, requiresApproval: false };
  ledger.ensureRun({ runId, objective: `extension:${id}`, workspaceRoot: runtime.workspaceRoot ?? ledger.workspaceRoot });
  const auditedInput = extension.type === "mcp"
    ? { extensionId: id, method: mcpMethod ?? "tools/call", input: summarizeMcpExtensionInput(input) }
    : { extensionId: id, input };
  const ledgerStep = ledger.beginTool({ runId, toolName: "extension.invoke", input: auditedInput, safety, metadata: { extensionType: extension.type } });
  const safeInput = extension.type === "mcp" ? auditedInput : redact(auditedInput);
  const append = (event: JsonObject) => auditStore.append({ at: new Date().toISOString(), runId, actor: runtime.actor ?? "extension", tool: "extension.invoke", capability: extension.capabilities[0], ...event });
  try {
    if (runtime.policy?.version === 1 && Array.isArray(runtime.policy.invariants) && runtime.policy.invariants.length) {
      new Sentinel({ ledger }).evaluate({ runId, stepId: ledgerStep.stepId, toolName: "extension.invoke", input: safeInput, policy: runtime.policy, workspaceRoot: runtime.workspaceRoot ?? ledger.workspaceRoot });
    }
    let claims;
    if (featureFlags.capabilities === true && runtime.authorizedByAdmission !== true) {
      const brokerOptions = { ledger, stateDir: ledger.stateDir, featureFlags };
      const consumeOptions = { runId, toolName: "extension.invoke", resource: { extensionId: id, capability: requested } };
      claims = new CapabilityBroker(brokerOptions).consume(runtime.capabilityToken ?? "", consumeOptions);
    }
    await append({ type: "task.started", decision: "allow", data: { input: safeInput, capabilityId: claims?.id } });
    let sandboxEvidence: JsonObject | undefined;
    const output = await runContainerExtension(extension, entrypoint, bundleRoot, request, { timeoutMs, protocol, sandboxConfig, signal, stateDir: ledger.stateDir }, async (phase, evidence) => {
      sandboxEvidence = { ...sandboxEvidence, ...evidence, sealedBundleDigest };
      await append({ type: `sandbox.${phase}`, decision: "allow", data: { ...evidence, sealedBundleDigest } });
    }, onDispatchAuthorized);
    const durableOutput = extension.type === "mcp" ? summarizeMcpExtensionOutput(output) : redact(output);
    await append({ type: "task.completed", decision: "allow", data: { output: durableOutput, ...(sandboxEvidence ? { sandbox: sandboxEvidence } : {}) } });
    ledger.finishTool({ runId, stepId: ledgerStep.stepId, output: durableOutput, status: "succeeded" });
    return output;
  } catch (error) {
    const failure = (error instanceof Error ? error : new Error(String(error))) as NodeError;
    const message = extension.type === "mcp" ? "MCP extension execution failed" : failure.message;
    await append({ type: "task.failed", decision: "deny", message, data: { code: failure.code ?? "EXTENSION_FAILED" } });
    ledger.finishTool({ runId, stepId: ledgerStep.stepId, status: "failed", error: message });
    throw error;
  }
}

async function runContainerExtension(
  extension: ExtensionManifest,
  entrypoint: string,
  bundleRoot: string,
  request: ExtensionRequestSequence,
  { timeoutMs, protocol, sandboxConfig, signal, stateDir }: Pick<ProcessOptions, "timeoutMs" | "protocol"> & { sandboxConfig: SandboxConfig; signal?: AbortSignal; stateDir: string },
  auditSandbox: (phase: "prepared" | "dispatch-authorized" | "settled", evidence: JsonObject) => Promise<void>,
  onDispatchAuthorized?: (evidence: JsonObject) => void | Promise<void>
) {
  const relativeEntrypoint = relative(bundleRoot, entrypoint).replaceAll("\\", "/");
  if (!relativeEntrypoint || relativeEntrypoint.startsWith("..")) throw new Error("extension entrypoint must remain inside its immutable bundle");
  if (sandboxConfig.backend.mode === "confined-native") throw new Error("container extensions require an OCI sandbox backend; host execution is not a fallback");
  const capability = await resolveConfiguredOciBackend(sandboxConfig);
  const limits = sandboxConfig.process.limits;
  const profile = compileSandboxProfile({
    backend: capability.backend,
    image: extension.containerImage,
    // Extension bundles request no network authority. A broader operator
    // ceiling never enlarges the effective per-execution profile.
    network: "denied",
    argv: ["node", `/extension/${relativeEntrypoint}`],
    cwd: "/extension",
    // Secret and environment brokers are separate enforcement surfaces. Until
    // they are active, extensions receive no operator environment values.
    environment: {},
    mounts: [{ source: bundleRoot, target: "/extension", access: "read-only" }],
    limits: {
      timeoutMs: Math.min(timeoutMs, limits.timeoutMs),
      maxOutputBytes: Math.min(MAX_EXTENSION_OUTPUT_BYTES, limits.outputBytes),
      memoryBytes: limits.memoryBytes,
      cpuCount: limits.cpu,
      processCount: limits.pids,
      tmpfsBytes: limits.tmpfsBytes
    }
  });
  await auditSandbox("prepared", {
    schemaVersion: 1,
    backend: capability.backend,
    rootless: capability.rootless,
    containerOs: capability.containerOs,
    controls: capability.controlEvidence.status,
    image: profile.image,
    profileDigest: profile.digest,
    network: profile.network,
    mounts: profile.mounts.map((mount) => ({ target: mount.target, access: mount.access })),
    limits: profile.limits
  });
  const requests = Array.isArray(request) ? request : [request];
  const interactive = protocol === "mcp-jsonl" && Array.isArray(request)
    ? async (session: SandboxInteractiveSession) => {
        await session.write(`${JSON.stringify(requests[0])}\n`);
        const initializeLine = await session.readLine();
        let initialize: ProcessResponse;
        try { initialize = JSON.parse(initializeLine); } catch { throw mcpProtocolError(); }
        if (!initialize || typeof initialize !== "object" || Array.isArray(initialize) || initialize.jsonrpc !== "2.0" || initialize.id !== requests[0]!.id || initialize.error || !initialize.result || typeof initialize.result !== "object" || typeof initialize.result.protocolVersion !== "string" || !MCP_PROTOCOL_VERSIONS.has(initialize.result.protocolVersion)) throw mcpProtocolError();
        await session.write(`${JSON.stringify(requests[1])}\n`);
        await session.write(`${JSON.stringify(requests[2])}\n`);
        const callLine = await session.readLine();
        let call: ProcessResponse;
        try { call = JSON.parse(callLine); } catch { throw mcpProtocolError(); }
        if (!call || typeof call !== "object" || Array.isArray(call) || call.jsonrpc !== "2.0" || call.id !== requests[2]!.id) throw mcpProtocolError();
      }
    : undefined;
  let execution: SandboxExecutionResult;
  try {
    execution = await new OciSandboxBackend(capability, undefined, { recoveryStateDir: stateDir }).execute(profile, {
      signal,
      ...(interactive ? { interactive } : { stdin: `${requests.map((item) => JSON.stringify(item)).join("\n")}\n` }),
      onDispatchAuthorized: async (evidence) => {
        await onDispatchAuthorized?.(evidence);
        await auditSandbox("dispatch-authorized", evidence);
      }
    });
  } catch (error) {
    if (error instanceof SandboxExecutionError) await auditSandbox("settled", sandboxSettlementEvidence(error.result, error.code));
    throw error;
  }
  await auditSandbox("settled", sandboxSettlementEvidence(execution));
  if (execution.cleanupUncertain) throw new Error("sandbox container cleanup could not be proven complete");
  if (execution.exitCode !== 0) throw new Error(`extension container exited before returning a result: ${execution.exitCode}`);
  const lines = execution.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (!lines.length) throw new Error("extension container exited before returning a result");
  const responses: ProcessResponse[] = [];
  for (const line of lines) {
    let parsed: ProcessResponse;
    try { parsed = JSON.parse(line); } catch { throw protocol === "mcp-jsonl" ? mcpProtocolError() : new Error("extension returned invalid JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw protocol === "mcp-jsonl" ? mcpProtocolError() : new Error("extension returned an invalid response");
    if (protocol === "mcp-jsonl" && (parsed.jsonrpc !== "2.0" || !Object.hasOwn(parsed, "id"))) throw mcpProtocolError();
    responses.push(parsed);
  }
  if (protocol === "mcp-jsonl") {
    const expected = requests.filter((item) => Object.hasOwn(item, "id")).map((item) => item.id);
    if (responses.length !== expected.length || responses.some((response, index) => response.id !== expected[index])) throw mcpProtocolError();
    const initialize = responses[0];
    if (requests.length > 1) {
      if (!initialize || initialize.error || !initialize.result || typeof initialize.result !== "object" || typeof initialize.result.protocolVersion !== "string" || !MCP_PROTOCOL_VERSIONS.has(initialize.result.protocolVersion)) throw mcpProtocolError();
    }
  }
  const response = responses[responses.length - 1]!;
  if (response.error) throw protocol === "mcp-jsonl" ? mcpProtocolError() : new Error("extension returned an error");
  return response.result ?? response;
}

function createMcpRequestSequence(method: McpMethod, input: JsonObject): readonly ExtensionRequest[] {
  const params = method === "tools/call"
    ? { name: input.name, arguments: input.arguments ?? {} }
    : {};
  return [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "odinn", version: "1.0.0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method, params }
  ];
}

function mcpProtocolError(): NodeError {
  const error = new Error("MCP extension returned an invalid protocol response") as NodeError;
  error.code = "MCP_PROTOCOL_INVALID";
  return error;
}

function summarizeMcpExtensionInput(input: JsonObject): JsonObject {
  const raw = input.arguments;
  let encoded = "";
  try { encoded = JSON.stringify(raw) ?? "null"; } catch { encoded = "[unserializable]"; }
  return {
    name: typeof input.name === "string" ? input.name : "",
    argumentsDigest: createHash("sha256").update(encoded, "utf8").digest("hex"),
    argumentsBytes: Buffer.byteLength(encoded, "utf8")
  };
}

function summarizeMcpExtensionOutput(output: unknown): JsonObject {
  let encoded = "";
  try { encoded = JSON.stringify(output) ?? "null"; } catch { encoded = "[unserializable]"; }
  return {
    resultDigest: createHash("sha256").update(encoded, "utf8").digest("hex"),
    resultBytes: Buffer.byteLength(encoded, "utf8")
  };
}

export async function resolveConfiguredOciBackend(
  config: SandboxConfig,
  detector: typeof detectOciBackend = detectOciBackend
): Promise<OciCapabilityProbe> {
  const modes = config.backend.mode === "auto" ? config.backend.preference : [config.backend.mode];
  let lastRefusal: Error | undefined;
  for (const mode of modes) {
    if (mode === "confined-native") continue;
    try {
      return await detector("auto", undefined, {
        rootless: mode === "rootless-oci" ? "required" : "any",
        executablePaths: config.backend.enginePaths
      });
    } catch (error) {
      if (!(error instanceof SandboxBackendRefusalError)) throw error;
      lastRefusal = error;
    }
  }
  throw lastRefusal ?? new SandboxBackendRefusalError("configured sandbox backend preference has no process-isolating OCI backend", "SANDBOX_BACKEND_UNAVAILABLE");
}

function sandboxSettlementEvidence(result: SandboxExecutionResult, code = "SANDBOX_SETTLED"): JsonObject {
  return {
    schemaVersion: 1,
    code,
    backend: result.backend,
    containerName: result.containerName,
    profileDigest: result.profileDigest,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    outputTruncated: result.outputTruncated,
    cleanupUncertain: result.cleanupUncertain,
    controlsAttested: result.controlsAttested,
    cleanupFailures: result.cleanupDiagnostics.length,
    durationMs: result.durationMs
  };
}

export function validateOciImageReference(input: unknown) {
  try { return validateDigestPinnedOciImage(input); }
  catch { throw new Error("extension containerImage must be a digest-pinned OCI image reference"); }
}

export async function digestExtensionBundle(root: string) {
  const base = await realpath(root);
  const entries: Array<{ path: string; digest: string }> = [];
  const walk = async (directory: string) => {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, item.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new Error(`extension bundle contains a symbolic link: ${relative(base, absolute)}`);
      if (metadata.isDirectory()) await walk(absolute);
      else if (metadata.isFile()) entries.push({ path: relative(base, absolute).replaceAll("\\", "/"), digest: createHash("sha256").update(await readFile(absolute)).digest("hex") });
      else throw new Error(`extension bundle contains an unsupported file type: ${relative(base, absolute)}`);
    }
  };
  await walk(base);
  return createHash("sha256").update(entries.map((entry) => `${entry.path}\0${entry.digest}\n`).join(""), "utf8").digest("hex");
}

function normalizeManifest(input: unknown, { source, provenance }: Required<InstallOptions>): ExtensionManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("extension manifest must be an object");
  const value = input as JsonObject;
  const id = String(value.id ?? "").trim();
  const version = String(value.version ?? "").trim();
  const type = String(value.type ?? "").trim() as ExtensionType;
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) throw new Error("extension id must be lowercase and 2-64 characters");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`invalid extension version: ${version}`);
  if (!EXTENSION_TYPES.has(type)) throw new Error(`extension type must be one of: ${Array.from(EXTENSION_TYPES).join(", ")}`);
  const capabilities = Array.isArray(value.capabilities) ? [...new Set(value.capabilities.map(String).filter(Boolean))] : [];
  const sandbox = String(value.sandbox ?? "container") as ExtensionSandbox;
  if (!SANDBOXES.has(sandbox)) throw new Error(`extension sandbox must be one of: ${Array.from(SANDBOXES).join(", ")}`);
  const normalized = {
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    installId: `install_${randomUUID()}`,
    id,
    version,
    name: String(value.name ?? id).trim().slice(0, 120),
    type,
    entrypoint: String(value.entrypoint ?? "").trim(),
    capabilities,
    sandbox,
    source: String(value.source ?? source).trim().slice(0, 500),
    provenance: String(value.provenance ?? provenance).trim().slice(0, 120),
    digest: String(value.digest ?? createHash("sha256").update(JSON.stringify({ id, version, type, capabilities, sandbox, entrypoint: value.entrypoint ?? "" })).digest("hex")).trim(),
    contentDigest: String(value.contentDigest ?? "").trim().toLowerCase(),
    bundleRoot: String(value.bundleRoot ?? "").trim(),
    bundleDigest: String(value.bundleDigest ?? "").trim().toLowerCase(),
    containerImage: sandbox === "container" ? validateOciImageReference(value.containerImage) : String(value.containerImage ?? ""),
    integrity: value.bundleDigest ? "bundle-verified" : value.contentDigest ? "content-verified" : "metadata-only",
    permissions: value.permissions && typeof value.permissions === "object" && !Array.isArray(value.permissions) ? value.permissions as JsonObject : {}
  };
  return normalized;
}
