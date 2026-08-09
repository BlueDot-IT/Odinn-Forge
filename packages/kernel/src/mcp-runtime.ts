import { createHash } from "node:crypto";
import { ExtensionExecutor, ExtensionRegistry, extensionIdentityFingerprint } from "./extensions.ts";
import {
  createCachedMcpHost,
  type CachedMcpHost,
  type McpCallRequest,
  type McpDiscoveryRequest,
  type McpHostStatus,
  type McpToolSnapshot,
  type McpRawJson
} from "./mcp-host.ts";
import { validateDigestPinnedOciImage } from "./sandbox-backend.ts";
import type { JsonObject } from "@odinn/protocol";

const MCP_RUNTIME_SCHEMA_VERSION = 1 as const;
const MAX_SERVERS = 32;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_TOOL_DESCRIPTION_BYTES = 16 * 1024;
const SERVER_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/u;
const EXTENSION_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const CONFIG_KEYS = new Set(["servers"]);
const SERVER_CONFIG_KEYS = new Set([
  "extensionId", "enabled", "maxConcurrency", "callTimeoutMs", "discoveryTimeoutMs",
  "shutdownTimeoutMs", "maxStaleMs", "maxTrackedCallIds", "snapshotTtlMs"
]);

type NodeError = Error & { code?: string };

export type McpServerConfig = Readonly<{
  serverId: string;
  extensionId: string;
  enabled: boolean;
  maxConcurrency: number;
  callTimeoutMs: number;
  discoveryTimeoutMs: number;
  shutdownTimeoutMs: number;
  maxStaleMs: number;
  maxTrackedCallIds: number;
  snapshotTtlMs: number;
}>;

export type McpRuntimeContext = {
  request?: { id?: string; actor?: string; input?: Record<string, unknown> };
  admission?: { attemptId?: string };
  policy?: unknown;
  auditStore?: { append(event: JsonObject): Promise<unknown> };
  runLedger?: any;
  signal?: AbortSignal;
  capabilityToken?: string;
  trustedApprovalId?: string;
  trustedApprovalRunId?: string;
  durableExecution?: boolean;
  effectiveCapabilities?: readonly string[];
  manifestFingerprint?: string;
};

export type GovernedMcpRuntimeOptions = {
  config?: unknown;
  enabled?: boolean;
  extensionRegistry: ExtensionRegistry;
  extensionExecutor: ExtensionExecutor;
  auditStore?: { append(event: JsonObject): Promise<unknown> };
  runLedger?: any;
  now?: () => number;
};

export type McpRuntimeStatus = Readonly<{
  enabled: boolean;
  servers: readonly Readonly<{
    serverId: string;
    extensionId: string;
    configuredEnabled: boolean;
    extensionFingerprint?: string;
    host?: McpHostStatus;
  }>[];
}>;

function runtimeError(code: string, message: string): NodeError {
  const error = new Error(message) as NodeError;
  error.code = code;
  return error;
}

function ordinaryRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw runtimeError("MCP_CONFIG_INVALID", `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw runtimeError("MCP_CONFIG_INVALID", `${label} contains unsupported fields`);
}

function boundedInteger(value: unknown, fallback: number, label: string, minimum: number, maximum: number): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw runtimeError("MCP_CONFIG_INVALID", `${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return result;
}

function safeIdentifier(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw runtimeError("MCP_CONFIG_INVALID", `${label} is invalid`);
  return value;
}

function normalizeServer(value: unknown, serverId: string): McpServerConfig {
  const record = ordinaryRecord(value, `config.mcp.servers.${serverId}`);
  exactKeys(record, SERVER_CONFIG_KEYS, `config.mcp.servers.${serverId}`);
  const extensionId = safeIdentifier(record.extensionId, `config.mcp.servers.${serverId}.extensionId`, EXTENSION_ID);
  if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
    throw runtimeError("MCP_CONFIG_INVALID", `config.mcp.servers.${serverId}.enabled must be true or false`);
  }
  return Object.freeze({
    serverId,
    extensionId,
    enabled: record.enabled === true,
    maxConcurrency: boundedInteger(record.maxConcurrency, 1, `config.mcp.servers.${serverId}.maxConcurrency`, 1, 16),
    callTimeoutMs: boundedInteger(record.callTimeoutMs, 30_000, `config.mcp.servers.${serverId}.callTimeoutMs`, 1, 300_000),
    discoveryTimeoutMs: boundedInteger(record.discoveryTimeoutMs, 30_000, `config.mcp.servers.${serverId}.discoveryTimeoutMs`, 1, 300_000),
    shutdownTimeoutMs: boundedInteger(record.shutdownTimeoutMs, 10_000, `config.mcp.servers.${serverId}.shutdownTimeoutMs`, 1, 300_000),
    maxStaleMs: boundedInteger(record.maxStaleMs, 0, `config.mcp.servers.${serverId}.maxStaleMs`, 0, 7 * 24 * 60 * 60 * 1_000),
    maxTrackedCallIds: boundedInteger(record.maxTrackedCallIds, 4_096, `config.mcp.servers.${serverId}.maxTrackedCallIds`, 1, 1_000_000),
    snapshotTtlMs: boundedInteger(record.snapshotTtlMs, 5 * 60 * 1_000, `config.mcp.servers.${serverId}.snapshotTtlMs`, 1, 24 * 60 * 60 * 1_000)
  });
}

export function normalizeMcpConfiguration(value: unknown): ReadonlyMap<string, McpServerConfig> {
  if (value === undefined) return new Map();
  const config = ordinaryRecord(value, "config.mcp");
  exactKeys(config, CONFIG_KEYS, "config.mcp");
  if (config.servers === undefined) return new Map();
  const servers = ordinaryRecord(config.servers, "config.mcp.servers");
  const entries = Object.entries(servers);
  if (entries.length > MAX_SERVERS) throw runtimeError("MCP_CONFIG_INVALID", `config.mcp.servers may contain at most ${MAX_SERVERS} entries`);
  const normalized = new Map<string, McpServerConfig>();
  for (const [serverId, server] of entries) {
    safeIdentifier(serverId, `config.mcp.servers key`, SERVER_ID);
    normalized.set(serverId, normalizeServer(server, serverId));
  }
  return normalized;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

const manifestFingerprint = extensionIdentityFingerprint;

function boundedJson(value: unknown, label: string): unknown {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw runtimeError("MCP_RESULT_INVALID", `${label} is not JSON serializable`); }
  if (!encoded || Buffer.byteLength(encoded, "utf8") > MAX_RESULT_BYTES) {
    throw runtimeError("MCP_RESULT_TOO_LARGE", `${label} exceeds the bounded result limit`);
  }
  try { return JSON.parse(encoded); } catch { throw runtimeError("MCP_RESULT_INVALID", `${label} is not valid JSON`); }
}

function protocolObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw runtimeError("MCP_PROTOCOL_INVALID", `${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function mcpResult(value: unknown): Record<string, unknown> {
  const result = protocolObject(value, "MCP response result");
  const allowed = new Set(["tools", "content", "structuredContent", "isError"]);
  if (Object.keys(result).some((key) => !allowed.has(key))) throw runtimeError("MCP_PROTOCOL_UNSUPPORTED", "MCP response contains unsupported fields");
  return result;
}

function mcpTools(value: unknown): Array<{ name: string; inputSchema: unknown }> {
  const result = mcpResult(value);
  if (result.content !== undefined || result.structuredContent !== undefined || result.isError !== undefined) throw runtimeError("MCP_PROTOCOL_UNSUPPORTED", "MCP tools/list returned non-discovery content");
  if (!Array.isArray(result.tools) || result.tools.length > 128) throw runtimeError("MCP_PROTOCOL_INVALID", "MCP tools/list did not return a bounded tools array");
  return result.tools.map((raw, index) => {
    const tool = protocolObject(raw, `MCP tool ${index + 1}`);
    const keys = new Set(["name", "description", "inputSchema"]);
    if (Object.keys(tool).some((key) => !keys.has(key))) throw runtimeError("MCP_PROTOCOL_UNSUPPORTED", "MCP tool metadata contains unsupported fields");
    if (tool.description !== undefined && (typeof tool.description !== "string" || Buffer.byteLength(tool.description, "utf8") > MAX_TOOL_DESCRIPTION_BYTES)) {
      throw runtimeError("MCP_PROTOCOL_INVALID", "MCP tool description is invalid or too large");
    }
    if (typeof tool.name !== "string" || !tool.name) throw runtimeError("MCP_PROTOCOL_INVALID", "MCP tool name is invalid");
    if (tool.inputSchema === undefined) throw runtimeError("MCP_PROTOCOL_INVALID", "MCP tool inputSchema is required");
    // The cached host performs the authoritative schema validation. This boundary
    // only removes descriptive text and rejects extension-shaped metadata.
    return { name: tool.name, inputSchema: boundedJson(tool.inputSchema, "MCP tool inputSchema") };
  });
}

function mcpCallResult(value: unknown): { value: unknown; isError: boolean } {
  const result = mcpResult(value);
  if (result.tools !== undefined) throw runtimeError("MCP_PROTOCOL_UNSUPPORTED", "MCP tools/call returned discovery metadata");
  if (result.content !== undefined && !Array.isArray(result.content)) throw runtimeError("MCP_PROTOCOL_INVALID", "MCP tools/call content is invalid");
  if (result.isError !== undefined && typeof result.isError !== "boolean") throw runtimeError("MCP_PROTOCOL_INVALID", "MCP tools/call isError is invalid");
  return { value: boundedJson(result, "MCP tools/call result"), isError: result.isError === true };
}

function requestContext(base: McpRuntimeContext | undefined, fallback: McpRuntimeContext): McpRuntimeContext {
  return { ...fallback, ...(base ?? {}) };
}

function bindingHash(prefix: string, context: McpRuntimeContext, requestDigest: string): string {
  return digest({ prefix, runId: context.request?.id ?? "unknown", attemptId: context.admission?.attemptId ?? "unknown", requestDigest });
}

export class GovernedMcpRuntime {
  readonly enabled: boolean;
  readonly extensionRegistry: ExtensionRegistry;
  readonly extensionExecutor: ExtensionExecutor;
  readonly servers: ReadonlyMap<string, McpServerConfig>;
  #auditStore?: { append(event: JsonObject): Promise<unknown> };
  #runLedger?: any;
  #now: () => number;
  #hosts = new Map<string, CachedMcpHost>();
  #manifestFingerprints = new Map<string, string>();
  #contexts = new Map<string, McpRuntimeContext>();
  #discoveryContexts = new Map<string, McpRuntimeContext>();
  #results = new Map<string, unknown>();
  #closed = false;

  constructor(options: GovernedMcpRuntimeOptions) {
    if (!options.extensionRegistry || !options.extensionExecutor) throw new Error("GovernedMcpRuntime requires the trusted extension boundary");
    this.enabled = options.enabled === true;
    this.extensionRegistry = options.extensionRegistry;
    this.extensionExecutor = options.extensionExecutor;
    this.servers = normalizeMcpConfiguration(options.config);
    this.#auditStore = options.auditStore;
    this.#runLedger = options.runLedger;
    this.#now = options.now ?? Date.now;
  }

  status(): McpRuntimeStatus {
    return Object.freeze({
      enabled: this.enabled,
      servers: Object.freeze([...this.servers.values()].map((server) => Object.freeze({
        serverId: server.serverId,
        extensionId: server.extensionId,
        configuredEnabled: server.enabled,
        ...(this.#manifestFingerprints.has(server.serverId) ? { extensionFingerprint: this.#manifestFingerprints.get(server.serverId) } : {}),
        ...(this.#hosts.has(server.serverId) ? { host: this.#hosts.get(server.serverId)!.status() } : {})
      })))
    });
  }

  async discover(input: { serverId?: unknown; refresh?: unknown }, context?: McpRuntimeContext): Promise<JsonObject> {
    this.#assertOpen();
    const server = this.#configuredServer(input?.serverId);
    const executionContext = requestContext(context, { auditStore: this.#auditStore, runLedger: this.#runLedger });
    await this.#assertManifest(server, "mcp.discover");
    const host = this.#host(server);
    const refresh = input?.refresh === true;
    this.#discoveryContexts.set(server.serverId, executionContext);
    try {
      const snapshot = refresh ? await host.refresh() : await host.start();
      return this.#snapshotResult(snapshot);
    } finally {
      this.#discoveryContexts.delete(server.serverId);
    }
  }

  async invoke(input: {
    serverId?: unknown;
    generation?: unknown;
    snapshotFingerprint?: unknown;
    extensionFingerprint?: unknown;
    toolName?: unknown;
    toolSchemaFingerprint?: unknown;
    arguments?: unknown;
    timeoutMs?: unknown;
  }, context?: McpRuntimeContext): Promise<JsonObject> {
    this.#assertOpen();
    const server = this.#configuredServer(input?.serverId);
    const executionContext = requestContext(context, { auditStore: this.#auditStore, runLedger: this.#runLedger });
    const extension = await this.#assertManifest(server, "mcp.invoke");
    const extensionFingerprint = manifestFingerprint(extension);
    if (typeof input?.extensionFingerprint !== "string" || !DIGEST.test(input.extensionFingerprint)) {
      throw runtimeError("MCP_EXTENSION_PIN_INVALID", "MCP invocation requires an executable extension fingerprint");
    }
    if (this.#manifestFingerprints.get(server.serverId) !== input.extensionFingerprint || extensionFingerprint !== input.extensionFingerprint) {
      throw runtimeError("MCP_EXTENSION_CHANGED", "configured MCP executable changed since discovery; rediscover before invoking");
    }
    const host = this.#host(server);
    const runId = String(executionContext.request?.id ?? "");
    if (!runId) throw runtimeError("MCP_AUTHORITY_MISSING", "MCP invocation requires an admitted run context");
    const callId = `mcp-${digest(`${runId}:${server.serverId}:${String(input?.toolName ?? "")}:${String(input?.generation ?? "")}`).slice(0, 48)}`;
    const principalNamespace = `principal:${digest(`${runId}:${executionContext.request?.actor ?? "unknown"}`)}`;
    this.#contexts.set(callId, { ...executionContext, manifestFingerprint: extensionFingerprint });
    try {
      const outcome = await host.invoke({
        callId,
        principalNamespace,
        generation: input?.generation as number,
        snapshotFingerprint: input?.snapshotFingerprint as string,
        toolName: input?.toolName as string,
        toolSchemaFingerprint: input?.toolSchemaFingerprint as string,
        arguments: input?.arguments,
        signal: executionContext.signal,
        timeoutMs: input?.timeoutMs as number | undefined
      });
      if (outcome.status !== "completed") return outcome;
      const result = this.#results.get(callId);
      this.#results.delete(callId);
      if (result === undefined) throw runtimeError("MCP_RESULT_MISSING", "MCP completed without a bounded result");
      return Object.freeze({ ...outcome, result });
    } finally {
      this.#contexts.delete(callId);
      this.#results.delete(callId);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#hosts.values()].map((host) => host.shutdown()));
    this.#contexts.clear();
    this.#discoveryContexts.clear();
    this.#manifestFingerprints.clear();
    this.#results.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw runtimeError("MCP_RUNTIME_CLOSED", "MCP runtime is closed");
    if (!this.enabled) throw runtimeError("MCP_DISABLED", "MCP activation is disabled");
  }

  #configuredServer(value: unknown): McpServerConfig {
    if (typeof value !== "string" || !SERVER_ID.test(value)) throw runtimeError("MCP_SERVER_INVALID", "MCP serverId is invalid");
    const server = this.servers.get(value);
    if (!server) throw runtimeError("MCP_SERVER_NOT_CONFIGURED", "MCP server is not configured");
    if (!server.enabled) throw runtimeError("MCP_SERVER_DISABLED", "MCP server is disabled");
    return server;
  }

  async #assertManifest(server: McpServerConfig, capability: "mcp.discover" | "mcp.invoke"): Promise<any> {
    const extension = await this.extensionRegistry.get(server.extensionId) as any;
    if (!extension || extension.type !== "mcp") throw runtimeError("MCP_EXTENSION_INVALID", "configured MCP extension is missing or has the wrong type");
    if (extension.enabled !== true || extension.trusted !== true) throw runtimeError("MCP_EXTENSION_UNTRUSTED", "configured MCP extension is not enabled and trusted");
    if (extension.sandbox !== "container") throw runtimeError("MCP_SANDBOX_UNSUPPORTED", "MCP activation requires the confined OCI container sandbox");
    if (typeof extension.bundleDigest !== "string" || !DIGEST.test(extension.bundleDigest)) throw runtimeError("MCP_EXTENSION_INTEGRITY", "MCP extension requires a full bundle digest");
    try { validateDigestPinnedOciImage(extension.containerImage); } catch { throw runtimeError("MCP_EXTENSION_INTEGRITY", "MCP extension requires a digest-pinned OCI image"); }
    if (!Array.isArray(extension.capabilities) || !extension.capabilities.includes(capability) || !Array.isArray(extension.grants) || !extension.grants.includes(capability)) {
      throw runtimeError("MCP_CAPABILITY_NOT_GRANTED", `MCP extension is not granted ${capability}`);
    }
    return extension;
  }

  #host(server: McpServerConfig): CachedMcpHost {
    const existing = this.#hosts.get(server.serverId);
    if (existing) return existing;
    const host = createCachedMcpHost({
      serverId: server.serverId,
      maxConcurrency: server.maxConcurrency,
      callTimeoutMs: server.callTimeoutMs,
      discoveryTimeoutMs: server.discoveryTimeoutMs,
      shutdownTimeoutMs: server.shutdownTimeoutMs,
      maxStaleMs: server.maxStaleMs,
      maxTrackedCallIds: server.maxTrackedCallIds,
      discovery: { discover: (request, signal) => this.#discoverTransport(server, request, signal) },
      dispatcher: { dispatch: (request, signal) => this.#dispatchTransport(server, request, signal) }
    });
    this.#hosts.set(server.serverId, host);
    return host;
  }

  async #discoverTransport(server: McpServerConfig, request: McpDiscoveryRequest, signal: AbortSignal): Promise<McpRawJson> {
    const context = this.#discoveryContexts.get(server.serverId);
    if (!context) throw runtimeError("MCP_CONTEXT_MISSING", "MCP discovery context is unavailable");
    const extension = await this.#assertManifest(server, "mcp.discover");
    const expectedIdentityFingerprint = manifestFingerprint(extension);
    const runtime = this.#extensionRuntime(context);
    let output: unknown;
    try {
      output = await this.extensionExecutor.invoke(extension.id, {}, {
        capability: "mcp.discover",
        mcpMethod: "tools/list",
        timeoutMs: server.discoveryTimeoutMs,
        runtime,
        signal,
        expectedIdentityFingerprint
      });
    } catch {
      throw runtimeError("MCP_DISCOVERY_FAILED", "MCP tools/list failed");
    }
    const tools = mcpTools(output);
    const generation = (this.#hosts.get(server.serverId)?.snapshot()?.generation ?? 0) + 1;
    const extensionFingerprint = manifestFingerprint(extension);
    this.#manifestFingerprints.set(server.serverId, extensionFingerprint);
    const result = { schemaVersion: MCP_RUNTIME_SCHEMA_VERSION, requestId: request.requestId, serverId: server.serverId, generation, validForMs: server.snapshotTtlMs, tools };
    await this.#appendAudit(context, "mcp.discovery.completed", {
      serverId: server.serverId,
      extensionId: extension.id,
      extensionFingerprint,
      generation,
      toolCount: tools.length,
      toolsDigest: digest(tools)
    }, "mcp.discover");
    return JSON.stringify(result);
  }

  async #dispatchTransport(server: McpServerConfig, request: McpCallRequest, signal: AbortSignal): Promise<McpRawJson> {
    const context = this.#contexts.get(request.callId);
    if (!context) throw runtimeError("MCP_CONTEXT_MISSING", "MCP call context is unavailable");
    const extension = await this.#assertManifest(server, "mcp.invoke");
    const expectedIdentityFingerprint = manifestFingerprint(extension);
    if (context.manifestFingerprint && manifestFingerprint(extension) !== context.manifestFingerprint) {
      throw runtimeError("MCP_EXTENSION_CHANGED", "configured MCP executable changed during dispatch");
    }
    const runtime = this.#extensionRuntime(context);
    const refs = {
      authorizationRef: `authorization:${bindingHash("authorization", context, request.requestDigest)}`,
      auditRef: `audit:${bindingHash("audit", context, request.requestDigest)}`
    };
    let dispatched = false;
    try {
      const output = await this.extensionExecutor.invoke(extension.id, { name: request.toolName, arguments: request.arguments }, {
        capability: "mcp.invoke",
        mcpMethod: "tools/call",
        timeoutMs: server.callTimeoutMs,
        runtime,
        signal,
        onDispatchAuthorized: async () => { dispatched = true; },
        expectedIdentityFingerprint
      });
      const bounded = mcpCallResult(output);
      if (bounded.isError) {
        await this.#appendAudit(context, "mcp.call.failed", {
          serverId: server.serverId,
          extensionId: extension.id,
          extensionFingerprint: context.manifestFingerprint,
          callId: request.callId,
          generation: request.generation,
          toolName: request.toolName,
          argumentDigest: request.argumentDigest,
          requestDigest: request.requestDigest,
          ...refs,
          errorCode: "MCP_TOOL_REPORTED_ERROR"
        });
        return JSON.stringify({
          schemaVersion: 1,
          callId: request.callId,
          principalNamespace: request.principalNamespace,
          serverId: request.serverId,
          generation: request.generation,
          snapshotFingerprint: request.snapshotFingerprint,
          toolName: request.toolName,
          toolSchemaFingerprint: request.toolSchemaFingerprint,
          argumentDigest: request.argumentDigest,
          requestDigest: request.requestDigest,
          ...refs,
          status: "failed",
          errorCode: "MCP_TOOL_REPORTED_ERROR"
        });
      }
      const result = boundedJson(bounded.value, "MCP call result");
      if (signal.aborted) throw runtimeError("MCP_DISPATCH_CANCELLED", "MCP call was cancelled");
      await this.#appendAudit(context, "mcp.call.completed", {
        serverId: server.serverId,
          extensionId: extension.id,
          extensionFingerprint: context.manifestFingerprint,
        callId: request.callId,
        generation: request.generation,
        toolName: request.toolName,
        argumentDigest: request.argumentDigest,
        requestDigest: request.requestDigest,
        resultDigest: digest(result),
        ...refs
      });
      this.#results.set(request.callId, result);
      return JSON.stringify({
        schemaVersion: 1,
        callId: request.callId,
        principalNamespace: request.principalNamespace,
        serverId: request.serverId,
        generation: request.generation,
        snapshotFingerprint: request.snapshotFingerprint,
        toolName: request.toolName,
        toolSchemaFingerprint: request.toolSchemaFingerprint,
        argumentDigest: request.argumentDigest,
        requestDigest: request.requestDigest,
        ...refs,
        status: "completed",
        resultRef: `record:${digest(request.callId)}`,
        resultDigest: digest(result)
      });
    } catch {
      this.#results.delete(request.callId);
      await this.#appendAudit(context, dispatched ? "mcp.call.needs_review" : "mcp.call.failed", {
        serverId: server.serverId,
        extensionId: extension.id,
        extensionFingerprint: context.manifestFingerprint,
        callId: request.callId,
        generation: request.generation,
        toolName: request.toolName,
        argumentDigest: request.argumentDigest,
        requestDigest: request.requestDigest,
        ...refs,
        errorCode: dispatched ? "MCP_AUDIT_CORRELATION_FAILED" : "MCP_DISPATCH_FAILED"
      }).catch(() => undefined);
      return JSON.stringify({
        schemaVersion: 1,
        callId: request.callId,
        principalNamespace: request.principalNamespace,
        serverId: request.serverId,
        generation: request.generation,
        snapshotFingerprint: request.snapshotFingerprint,
        toolName: request.toolName,
        toolSchemaFingerprint: request.toolSchemaFingerprint,
        argumentDigest: request.argumentDigest,
        requestDigest: request.requestDigest,
        ...refs,
        status: dispatched ? "needs-review" : "failed",
        errorCode: dispatched ? "MCP_AUDIT_CORRELATION_FAILED" : "MCP_DISPATCH_FAILED"
      });
    }
  }

  #extensionRuntime(context: McpRuntimeContext): any {
    if (!context.runLedger || !context.auditStore) throw runtimeError("MCP_AUTHORITY_MISSING", "MCP execution requires the audited runtime boundary");
    return {
      runLedger: context.runLedger,
      auditStore: context.auditStore,
      runId: context.request?.id,
      actor: context.request?.actor ?? "mcp-runtime",
      policy: context.policy,
      workspaceRoot: context.runLedger.workspaceRoot,
      featureFlags: context.runLedger.featureFlags,
      authorizedByAdmission: true
    };
  }

  async #appendAudit(context: McpRuntimeContext, type: string, data: JsonObject, capability: "mcp.discover" | "mcp.invoke" = "mcp.invoke"): Promise<void> {
    await context.auditStore?.append({
      at: new Date(this.#now()).toISOString(),
      runId: context.request?.id ?? "mcp-runtime",
      actor: context.request?.actor ?? "mcp-runtime",
      tool: capability,
      capability,
      type,
      decision: "allow",
      data
    });
  }

  #snapshotResult(snapshot: McpToolSnapshot): JsonObject {
    return Object.freeze({
      type: "mcp.discovery",
      serverId: snapshot.serverId,
      generation: snapshot.generation,
      fingerprint: snapshot.fingerprint,
      ...(this.#manifestFingerprints.has(snapshot.serverId) ? { extensionFingerprint: this.#manifestFingerprints.get(snapshot.serverId) } : {}),
      discoveredAtMs: snapshot.discoveredAtMs,
      expiresAtMs: snapshot.expiresAtMs,
      staleUntilMs: snapshot.staleUntilMs,
      tools: snapshot.tools.map((tool) => ({ name: tool.name, schemaFingerprint: tool.schemaFingerprint, inputSchema: tool.inputSchema }))
    });
  }
}

export function createGovernedMcpRuntime(options: GovernedMcpRuntimeOptions): GovernedMcpRuntime {
  return new GovernedMcpRuntime(options);
}
