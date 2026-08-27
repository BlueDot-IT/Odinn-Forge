import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from "node:https";
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SecureContextOptions } from "node:tls";
import { isAllowedCredentialEnvironmentKey } from "./environment.ts";
import { pinnedAddressLookup } from "./web.ts";

export const REMOTE_NODE_PROTOCOL_VERSION = 1 as const;
export const REMOTE_NODE_STATUS_PATH = "/odinn/node/v1/status" as const;
export const REMOTE_NODE_DIAGNOSTICS_PATH = "/odinn/node/v1/diagnostics" as const;

const REMOTE_NODE_DEFAULT_TOKEN_ENV = "ODINN_REMOTE_NODE_TOKEN";
const REMOTE_NODE_TIMEOUT_MS = 10_000;
const REMOTE_NODE_MAX_RESPONSE_BYTES = 65_536;
const REMOTE_NODE_MAX_CONCURRENT_REQUESTS = 4;
const REMOTE_NODE_MAX_NODES = 32;
const REMOTE_NODE_MAX_ADDRESSES = 8;
const REMOTE_NODE_MAX_TOKEN_ENV_BYTES = 128;
const REMOTE_NODE_MAX_TASKS = 1_000_000;
const REMOTE_NODE_MAX_UPTIME_SECONDS = 315_576_000;
const REMOTE_NODE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const REMOTE_NODE_CHECK_NAMES = ["runtime", "storage", "network", "clock", "work-queue"] as const;
const REMOTE_NODE_CONFIG_FIELDS = new Set(["enabled", "nodes"]);
const REMOTE_NODE_ENTRY_FIELDS = new Set(["nodeId", "origin", "addresses", "tokenEnv"]);

export type RemoteNodeCheckName = typeof REMOTE_NODE_CHECK_NAMES[number];
export type RemoteNodeReadKind = "status" | "diagnostics";

export type RemoteNodeEndpointConfig = Readonly<{
  nodeId: string;
  origin: string;
  addresses: readonly string[];
  tokenEnv: string;
}>;

export type RemoteNodeReadConfig = Readonly<{
  enabled: boolean;
  nodes: readonly RemoteNodeEndpointConfig[];
}>;

export type RemoteNodeReadDiagnostic = Readonly<{
  enabled: boolean;
  configured: boolean;
  nodeCount: number;
  readyNodeCount: number;
  addressCount: number;
  protocolVersion: 1;
  fixedEndpointCount: 2;
  readOnly: true;
  mutationsAvailable: false;
  redirectsAllowed: false;
  runtimeDnsAllowed: false;
  tlsVerificationRequired: true;
}>;

export type RemoteNodeReadTarget = Readonly<{
  protocolVersion: 1;
  generation: string;
}>;

export type RemoteNodeStatusResponse = Readonly<{
  schemaVersion: 1;
  type: "node.status";
  nodeId: string;
  observedAt: string;
  status: "ready" | "degraded" | "unavailable";
  uptimeSeconds: number;
  activeTasks: number;
  queuedTasks: number;
  contentTrust: "external-untrusted";
}>;

export type RemoteNodeDiagnosticCheck = Readonly<{
  name: RemoteNodeCheckName;
  status: "pass" | "warn" | "fail" | "unknown";
}>;

export type RemoteNodeDiagnosticsResponse = Readonly<{
  schemaVersion: 1;
  type: "node.diagnostics";
  nodeId: string;
  observedAt: string;
  status: "healthy" | "degraded" | "unavailable";
  checks: readonly RemoteNodeDiagnosticCheck[];
  contentTrust: "external-untrusted";
}>;

export type RemoteNodeHttpRequest = Readonly<{
  nodeId: string;
  kind: RemoteNodeReadKind;
  url: URL;
  address: string;
  headers: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  tlsCa?: string | Buffer;
}>;

export type RemoteNodeHttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Buffer;
}>;

export type RemoteNodeHttpTransport = (request: RemoteNodeHttpRequest) => Promise<RemoteNodeHttpResponse>;

export interface RemoteNodeReadClient {
  readonly target: RemoteNodeReadTarget;
  readonly diagnostic: RemoteNodeReadDiagnostic;
  resourceFor(kind: RemoteNodeReadKind, input: Record<string, unknown>): Readonly<Record<string, string>>;
  status(input: Record<string, unknown>, signal?: AbortSignal): Promise<RemoteNodeStatusResponse>;
  diagnostics(input: Record<string, unknown>, signal?: AbortSignal): Promise<RemoteNodeDiagnosticsResponse>;
  close(): void;
}

type RemoteNodeClientOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  transport?: RemoteNodeHttpTransport;
  __testOnlyRequestTimeoutMs?: number;
  __testOnlyTlsCa?: string | Buffer;
}>;

export type RemoteNodeStatusSnapshot = Readonly<{
  observedAt: string;
  status: "ready" | "degraded" | "unavailable";
  uptimeSeconds: number;
  activeTasks: number;
  queuedTasks: number;
}>;

export type RemoteNodeDiagnosticsSnapshot = Readonly<{
  observedAt: string;
  status: "healthy" | "degraded" | "unavailable";
  checks: readonly RemoteNodeDiagnosticCheck[];
}>;

export type RemoteNodeResponderOptions = Readonly<{
  enabled: true;
  nodeId: string;
  tokenEnv?: string;
  environment?: NodeJS.ProcessEnv;
  tls: SecureContextOptions;
  status: (context: Readonly<{ signal: AbortSignal }>) => RemoteNodeStatusSnapshot | Promise<RemoteNodeStatusSnapshot>;
  diagnostics: (context: Readonly<{ signal: AbortSignal }>) => RemoteNodeDiagnosticsSnapshot | Promise<RemoteNodeDiagnosticsSnapshot>;
}>;

function ordinaryObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be an ordinary object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains an unsupported field`);
}

function normalizeNodeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !REMOTE_NODE_ID.test(value)) throw new Error(`${label} must be a canonical lowercase node identifier`);
  return value;
}

function normalizeOrigin(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 512) throw new Error(`${label} must be an HTTPS authority`);
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`${label} must be an HTTPS authority`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== value) {
    throw new Error(`${label} must be a canonical HTTPS authority without a path, query, fragment, or credentials`);
  }
  return parsed.origin;
}

function normalizeAddresses(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > REMOTE_NODE_MAX_ADDRESSES) {
    throw new Error(`${label} must be a nonempty explicit IP allowlist of at most ${REMOTE_NODE_MAX_ADDRESSES} addresses`);
  }
  const addresses = Array.from(value, (address) => {
    if (typeof address !== "string" || address.length > 64 || isIP(address) === 0) throw new Error(`${label} must contain only literal IP addresses`);
    return address;
  });
  if (new Set(addresses.map((address) => address.toLowerCase())).size !== addresses.length) throw new Error(`${label} must not contain duplicate addresses`);
  return Object.freeze(addresses);
}

function normalizeTokenEnvironment(value: unknown, label: string): string {
  if (typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > REMOTE_NODE_MAX_TOKEN_ENV_BYTES
    || !isAllowedCredentialEnvironmentKey(value)) {
    throw new Error(`${label} must be an allowed credential environment reference`);
  }
  return value;
}

export function normalizeRemoteNodeReadConfig(value: unknown = {}): RemoteNodeReadConfig {
  const source = ordinaryObject(value, "remote node configuration");
  rejectUnknownFields(source, REMOTE_NODE_CONFIG_FIELDS, "remote node configuration");
  if (source.enabled !== undefined && typeof source.enabled !== "boolean") throw new Error("remote node configuration.enabled must be boolean");
  if (source.nodes !== undefined && !Array.isArray(source.nodes)) throw new Error("remote node configuration.nodes must be an array");
  const enabled = source.enabled === true;
  const nodeEntries = source.nodes ?? [];
  if (nodeEntries.length > REMOTE_NODE_MAX_NODES) throw new Error(`remote node configuration.nodes must contain at most ${REMOTE_NODE_MAX_NODES} entries`);
  const nodes = Array.from(nodeEntries, (entry, index) => {
    const node = ordinaryObject(entry, `remote node configuration.nodes[${index}]`);
    rejectUnknownFields(node, REMOTE_NODE_ENTRY_FIELDS, `remote node configuration.nodes[${index}]`);
    const nodeId = normalizeNodeId(node.nodeId, `remote node configuration.nodes[${index}].nodeId`);
    const origin = normalizeOrigin(node.origin, `remote node configuration.nodes[${index}].origin`);
    const addresses = normalizeAddresses(node.addresses, `remote node configuration.nodes[${index}].addresses`);
    const tokenEnv = normalizeTokenEnvironment(node.tokenEnv, `remote node configuration.nodes[${index}].tokenEnv`);
    const originHostname = new URL(origin).hostname.replace(/^\[|\]$/gu, "");
    if (isIP(originHostname) !== 0 && !addresses.includes(originHostname)) {
      throw new Error(`remote node configuration.nodes[${index}].addresses must include its literal-IP origin`);
    }
    return Object.freeze({ nodeId, origin, addresses, tokenEnv });
  });
  if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length) throw new Error("remote node configuration.nodes must not contain duplicate node identifiers");
  if (enabled && nodes.length === 0) throw new Error("enabled remote node access requires at least one explicitly allowed node");
  return Object.freeze({ enabled, nodes: Object.freeze(nodes) });
}

export function diagnoseRemoteNodeReadIntegration(
  value: unknown = {},
  environment: NodeJS.ProcessEnv = process.env
): RemoteNodeReadDiagnostic {
  const config = normalizeRemoteNodeReadConfig(value);
  const readyNodeCount = config.nodes.filter((node) => validCredential(environment[node.tokenEnv]) !== undefined).length;
  return Object.freeze({
    enabled: config.enabled,
    configured: config.enabled && readyNodeCount === config.nodes.length,
    nodeCount: config.nodes.length,
    readyNodeCount,
    addressCount: config.nodes.reduce((total, node) => total + node.addresses.length, 0),
    protocolVersion: REMOTE_NODE_PROTOCOL_VERSION,
    fixedEndpointCount: 2,
    readOnly: true,
    mutationsAvailable: false,
    redirectsAllowed: false,
    runtimeDnsAllowed: false,
    tlsVerificationRequired: true
  });
}

export function createRemoteNodeReadClient(value: unknown = {}, options: RemoteNodeClientOptions = {}): RemoteNodeReadClient {
  const config = normalizeRemoteNodeReadConfig(value);
  if (!config.enabled) throw new Error("remote node integration is disabled");
  const environment = options.environment ?? process.env;
  const transport = options.transport ?? nativeRemoteNodeTransport;
  const timeoutMs = normalizeRequestTimeout(options.__testOnlyRequestTimeoutMs);
  const nodes = new Map(config.nodes.map((node) => [node.nodeId, node]));
  const addressCursors = new Map(config.nodes.map((node) => [node.nodeId, 0]));
  const generation = digest(`remote-node:v1:${config.nodes.map((node) => `${node.nodeId}\0${node.origin}\0${node.addresses.join(",")}\0${node.tokenEnv}`).sort().join("\n")}`);
  const target = Object.freeze({ protocolVersion: REMOTE_NODE_PROTOCOL_VERSION, generation });
  const diagnostic = diagnoseRemoteNodeReadIntegration(config, environment);
  const pool = new RemoteNodeRequestPool();
  const closeController = new AbortController();
  let closed = false;

  const ensureActive = () => {
    if (closed) throw new Error("remote node read client is closed");
  };
  const selectedNode = (input: Record<string, unknown>) => {
    const source = ordinaryObject(input, "remote node tool input");
    rejectUnknownFields(source, new Set(["nodeId"]), "remote node tool input");
    const nodeId = normalizeNodeId(source.nodeId, "remote node tool input.nodeId");
    const node = nodes.get(nodeId);
    if (!node) throw new Error("remote node is outside the configured allowlist");
    return node;
  };
  const resourceFor = (kind: RemoteNodeReadKind, input: Record<string, unknown>) => {
    ensureActive();
    const node = selectedNode(input);
    return Object.freeze({
      configurationDigest: generation,
      nodeDigest: digest(`remote-node:${node.nodeId}`),
      targetDigest: digest(`remote-node-target:v1:${kind}:${node.nodeId}:${node.origin}:${node.addresses.join(",")}`)
    });
  };
  const request = async (kind: RemoteNodeReadKind, input: Record<string, unknown>, signal?: AbortSignal) => {
    ensureActive();
    const node = selectedNode(input);
    const token = validCredential(environment[node.tokenEnv]);
    if (token === undefined) throw new Error("remote node credential is not configured");
    const raw = await requestRemoteNodeJson(node, kind, token, {
      callerSignal: signal,
      closeSignal: closeController.signal,
      pool,
      timeoutMs,
      transport,
      address: selectConfiguredAddress(node, addressCursors),
      tlsCa: options.__testOnlyTlsCa
    });
    if (closeController.signal.aborted) throw abortError();
    try {
      return kind === "status"
        ? normalizeRemoteNodeStatusResponse(raw, node.nodeId)
        : normalizeRemoteNodeDiagnosticsResponse(raw, node.nodeId);
    } catch {
      throw new Error(`remote node ${kind} response failed schema validation`);
    }
  };

  const client: RemoteNodeReadClient = {
    target,
    diagnostic,
    resourceFor,
    status: (input, signal) => request("status", input, signal) as Promise<RemoteNodeStatusResponse>,
    diagnostics: (input, signal) => request("diagnostics", input, signal) as Promise<RemoteNodeDiagnosticsResponse>,
    close: () => {
      if (closed) return;
      closed = true;
      closeController.abort();
      pool.close();
    }
  };
  return Object.freeze(client);
}

function validCredential(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 8_192
    && !/[\s\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function pathFor(kind: RemoteNodeReadKind): typeof REMOTE_NODE_STATUS_PATH | typeof REMOTE_NODE_DIAGNOSTICS_PATH {
  return kind === "status" ? REMOTE_NODE_STATUS_PATH : REMOTE_NODE_DIAGNOSTICS_PATH;
}

async function requestRemoteNodeJson(
  node: RemoteNodeEndpointConfig,
  kind: RemoteNodeReadKind,
  token: string,
  options: Readonly<{
    callerSignal?: AbortSignal;
    closeSignal: AbortSignal;
    pool: RemoteNodeRequestPool;
    timeoutMs: number;
    transport: RemoteNodeHttpTransport;
    address: string;
    tlsCa?: string | Buffer;
  }>
): Promise<unknown> {
  const url = trustedRemoteNodeUrl(node, pathFor(kind));
  const headers = Object.freeze({
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "user-agent": "Odinn-Forge/remote-node-read",
    "x-odinn-node-protocol": String(REMOTE_NODE_PROTOCOL_VERSION)
  });
  const budget = createRequestBudget(options.callerSignal, options.closeSignal, options.timeoutMs);
  let acquired = false;
  try {
    await options.pool.acquire(budget.signal);
    acquired = true;
    if (budget.signal.aborted) throw budget.failure();
    let operation: Promise<RemoteNodeHttpResponse>;
    try {
      operation = Promise.resolve(options.transport({
        nodeId: node.nodeId,
        kind,
        url,
        address: options.address,
        headers,
        signal: budget.signal,
        ...(options.tlsCa === undefined ? {} : { tlsCa: options.tlsCa })
      })).catch(() => {
        if (budget.signal.aborted) throw budget.failure();
        throw new Error("remote node request failed");
      });
    } catch {
      throw new Error("remote node request failed");
    }
    void operation.then(() => options.pool.release(), () => options.pool.release());
    acquired = false;
    const response = await settleWithinRequestBudget(operation, budget);
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("remote node response envelope was invalid");
    }
    if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599) {
      throw new Error("remote node response status was invalid");
    }
    if (response.status >= 300 && response.status < 400) throw new Error("remote node redirects are refused");
    if (response.status === 401 || response.status === 403) throw new Error("remote node authentication failed");
    if (response.status < 200 || response.status >= 300) throw new Error(`remote node returned status ${response.status}`);
    if (!Buffer.isBuffer(response.body)) throw new Error("remote node response body was invalid");
    if (response.body.byteLength > REMOTE_NODE_MAX_RESPONSE_BYTES) throw new Error("remote node response exceeded the bounded size limit");
    if (mediaType(response.headers?.["content-type"]) !== "application/json") throw new Error("remote node response was not JSON");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)); }
    catch { throw new Error("remote node returned invalid JSON"); }
  } catch (error) {
    if (budget.signal.aborted) throw budget.failure();
    throw error;
  } finally {
    if (acquired) options.pool.release();
    budget.dispose();
  }
}

function selectConfiguredAddress(node: RemoteNodeEndpointConfig, cursors: Map<string, number>): string {
  const cursor = cursors.get(node.nodeId) ?? 0;
  cursors.set(node.nodeId, (cursor + 1) % node.addresses.length);
  return node.addresses[cursor % node.addresses.length]!;
}

function trustedRemoteNodeUrl(node: RemoteNodeEndpointConfig, path: string): URL {
  const url = new URL(path, `${node.origin}/`);
  if (url.origin !== node.origin || url.protocol !== "https:" || url.pathname !== path || url.search || url.hash || url.username || url.password) {
    throw new Error("remote node target is outside the configured HTTPS authority");
  }
  return url;
}

async function nativeRemoteNodeTransport(input: RemoteNodeHttpRequest): Promise<RemoteNodeHttpResponse> {
  return new Promise((resolveResponse, rejectResponse) => {
    if (input.signal?.aborted) return rejectResponse(abortError());
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, response?: RemoteNodeHttpResponse) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      if (error) rejectResponse(error); else resolveResponse(response!);
    };
    const request = httpsRequest(input.url, {
      method: "GET",
      headers: input.headers,
      lookup: pinnedAddressLookup(input.address),
      rejectUnauthorized: true,
      agent: false,
      ...(input.tlsCa === undefined ? {} : { ca: input.tlsCa })
    }, (response) => {
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > REMOTE_NODE_MAX_RESPONSE_BYTES) {
          response.destroy();
          request.destroy();
          finish(new Error("remote node response exceeded the bounded size limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(undefined, {
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
      response.on("error", () => finish(new Error("remote node response failed")));
    });
    const onAbort = () => {
      request.destroy();
      finish(abortError());
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    request.on("error", (error) => {
      if (input.signal?.aborted || error.name === "AbortError") finish(abortError());
      else finish(new Error("remote node request failed"));
    });
    request.end();
  });
}

type RequestWaiter = {
  active: boolean;
  readonly signal: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  onAbort?: () => void;
};

class RemoteNodeRequestPool {
  private active = 0;
  private closed = false;
  private readonly waiters: RequestWaiter[] = [];

  async acquire(signal: AbortSignal): Promise<void> {
    if (this.closed) throw new Error("remote node read client is closed");
    if (signal.aborted) throw abortError();
    if (this.active < REMOTE_NODE_MAX_CONCURRENT_REQUESTS) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolveSlot, rejectSlot) => {
      const waiter: RequestWaiter = { active: true, signal, resolve: resolveSlot, reject: rejectSlot };
      waiter.onAbort = () => {
        if (!waiter.active) return;
        waiter.active = false;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        rejectSlot(abortError());
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  release(): void {
    let waiter = this.waiters.shift();
    while (waiter && !waiter.active) waiter = this.waiters.shift();
    if (waiter) {
      waiter.active = false;
      waiter.signal.removeEventListener("abort", waiter.onAbort!);
      waiter.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      if (!waiter.active) continue;
      waiter.active = false;
      waiter.signal.removeEventListener("abort", waiter.onAbort!);
      waiter.reject(new Error("remote node read client is closed"));
    }
  }
}

type RequestBudget = Readonly<{
  signal: AbortSignal;
  failure: () => Error;
  dispose: () => void;
}>;

function normalizeRequestTimeout(value: unknown): number {
  if (value === undefined) return REMOTE_NODE_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > REMOTE_NODE_TIMEOUT_MS) {
    throw new Error(`remote node request timeout must be an integer from 1 through ${REMOTE_NODE_TIMEOUT_MS}`);
  }
  return Number(value);
}

function createRequestBudget(callerSignal: AbortSignal | undefined, closeSignal: AbortSignal, timeoutMs: number): RequestBudget {
  const controller = new AbortController();
  let reason: "cancelled" | "closed" | "timed-out" | undefined;
  const abort = (nextReason: typeof reason) => {
    if (controller.signal.aborted) return;
    reason = nextReason;
    controller.abort();
  };
  const onCallerAbort = () => abort("cancelled");
  const onClose = () => abort("closed");
  if (callerSignal?.aborted) onCallerAbort(); else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (closeSignal.aborted) onClose(); else closeSignal.addEventListener("abort", onClose, { once: true });
  const deadline = setTimeout(() => abort("timed-out"), timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    failure: () => reason === "timed-out"
      ? new Error("remote node request timed out")
      : reason === "closed"
        ? new Error("remote node read client is closed")
        : abortError(),
    dispose: () => {
      clearTimeout(deadline);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      closeSignal.removeEventListener("abort", onClose);
    }
  });
}

function settleWithinRequestBudget<T>(operation: Promise<T>, budget: RequestBudget): Promise<T> {
  if (budget.signal.aborted) return Promise.reject(budget.failure());
  return new Promise<T>((resolveOperation, rejectOperation) => {
    let settled = false;
    const finish = (callback: (value: any) => void, value: any) => {
      if (settled) return;
      settled = true;
      budget.signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(rejectOperation, budget.failure());
    budget.signal.addEventListener("abort", onAbort, { once: true });
    operation.then((value) => finish(resolveOperation, value), (error) => finish(rejectOperation, error));
  });
}

function mediaType(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.split(";", 1)[0]!.trim().toLowerCase() : "";
}

function exactTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 64 || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
  const normalized = new Date(value).toISOString();
  if (normalized !== value) throw new Error(`${label} must be a canonical ISO timestamp`);
  return normalized;
}

function boundedCount(value: unknown, label: string, maximum = REMOTE_NODE_MAX_TASKS): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) throw new Error(`${label} must be a bounded nonnegative integer`);
  return Number(value);
}

function enumValue<const T extends readonly string[]>(value: unknown, label: string, allowed: T): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${label} is unsupported`);
  return value as T[number];
}

export function normalizeRemoteNodeStatusResponse(value: unknown, expectedNodeId: string): RemoteNodeStatusResponse {
  const source = ordinaryObject(value, "remote node status response");
  rejectUnknownFields(source, new Set(["schemaVersion", "type", "nodeId", "observedAt", "status", "uptimeSeconds", "activeTasks", "queuedTasks"]), "remote node status response");
  if (source.schemaVersion !== REMOTE_NODE_PROTOCOL_VERSION || source.type !== "node.status") throw new Error("remote node status response protocol identity is invalid");
  if (normalizeNodeId(source.nodeId, "remote node status response.nodeId") !== expectedNodeId) throw new Error("remote node status response target does not match the requested node");
  return Object.freeze({
    schemaVersion: REMOTE_NODE_PROTOCOL_VERSION,
    type: "node.status",
    nodeId: expectedNodeId,
    observedAt: exactTimestamp(source.observedAt, "remote node status response.observedAt"),
    status: enumValue(source.status, "remote node status response.status", ["ready", "degraded", "unavailable"] as const),
    uptimeSeconds: boundedCount(source.uptimeSeconds, "remote node status response.uptimeSeconds", REMOTE_NODE_MAX_UPTIME_SECONDS),
    activeTasks: boundedCount(source.activeTasks, "remote node status response.activeTasks"),
    queuedTasks: boundedCount(source.queuedTasks, "remote node status response.queuedTasks"),
    contentTrust: "external-untrusted"
  });
}

export function normalizeRemoteNodeDiagnosticsResponse(value: unknown, expectedNodeId: string): RemoteNodeDiagnosticsResponse {
  const source = ordinaryObject(value, "remote node diagnostics response");
  rejectUnknownFields(source, new Set(["schemaVersion", "type", "nodeId", "observedAt", "status", "checks"]), "remote node diagnostics response");
  if (source.schemaVersion !== REMOTE_NODE_PROTOCOL_VERSION || source.type !== "node.diagnostics") throw new Error("remote node diagnostics response protocol identity is invalid");
  if (normalizeNodeId(source.nodeId, "remote node diagnostics response.nodeId") !== expectedNodeId) throw new Error("remote node diagnostics response target does not match the requested node");
  if (!Array.isArray(source.checks) || source.checks.length === 0 || source.checks.length > REMOTE_NODE_CHECK_NAMES.length) {
    throw new Error("remote node diagnostics response.checks must be a bounded nonempty array");
  }
  const checks = Array.from(source.checks, (entry, index) => {
    const check = ordinaryObject(entry, `remote node diagnostics response.checks[${index}]`);
    rejectUnknownFields(check, new Set(["name", "status"]), `remote node diagnostics response.checks[${index}]`);
    return Object.freeze({
      name: enumValue(check.name, `remote node diagnostics response.checks[${index}].name`, REMOTE_NODE_CHECK_NAMES),
      status: enumValue(check.status, `remote node diagnostics response.checks[${index}].status`, ["pass", "warn", "fail", "unknown"] as const)
    });
  });
  if (new Set(checks.map((check) => check.name)).size !== checks.length) throw new Error("remote node diagnostics response.checks must not contain duplicates");
  return Object.freeze({
    schemaVersion: REMOTE_NODE_PROTOCOL_VERSION,
    type: "node.diagnostics",
    nodeId: expectedNodeId,
    observedAt: exactTimestamp(source.observedAt, "remote node diagnostics response.observedAt"),
    status: enumValue(source.status, "remote node diagnostics response.status", ["healthy", "degraded", "unavailable"] as const),
    checks: Object.freeze(checks),
    contentTrust: "external-untrusted"
  });
}

export function createRemoteNodeResponder(options: RemoteNodeResponderOptions): HttpsServer {
  if (options?.enabled !== true) throw new Error("remote node responder requires explicit enablement");
  const nodeId = normalizeNodeId(options.nodeId, "remote node responder.nodeId");
  const tokenEnv = normalizeTokenEnvironment(options.tokenEnv ?? REMOTE_NODE_DEFAULT_TOKEN_ENV, "remote node responder.tokenEnv");
  const environment = options.environment ?? process.env;
  if (!options.tls || typeof options.tls !== "object") throw new Error("remote node responder requires TLS key and certificate material");
  if (typeof options.status !== "function" || typeof options.diagnostics !== "function") throw new Error("remote node responder requires both read providers");
  return createHttpsServer({ ...options.tls }, (request, response) => {
    void handleResponderRequest({ request, response, nodeId, tokenEnv, environment, options });
  });
}

async function handleResponderRequest({
  request,
  response,
  nodeId,
  tokenEnv,
  environment,
  options
}: Readonly<{
  request: IncomingMessage;
  response: ServerResponse;
  nodeId: string;
  tokenEnv: string;
  environment: NodeJS.ProcessEnv;
  options: RemoteNodeResponderOptions;
}>): Promise<void> {
  const path = request.url ?? "";
  const kind: RemoteNodeReadKind | undefined = path === REMOTE_NODE_STATUS_PATH
    ? "status"
    : path === REMOTE_NODE_DIAGNOSTICS_PATH
      ? "diagnostics"
      : undefined;
  if (!kind) return responderJson(response, 404, { error: "not-found" });
  if (request.method !== "GET") return responderJson(response, 405, { error: "method-not-allowed" }, { allow: "GET" });
  if (request.headers["transfer-encoding"] || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")) {
    return responderJson(response, 400, { error: "request-body-refused" });
  }
  if (request.headers["x-odinn-node-protocol"] !== String(REMOTE_NODE_PROTOCOL_VERSION)) {
    return responderJson(response, 400, { error: "protocol-version-required" });
  }
  const credential = validCredential(environment[tokenEnv]);
  if (credential === undefined || !authorizedBearer(request.headers.authorization, credential)) {
    return responderJson(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.once("aborted", abort);
  try {
    const snapshot = kind === "status"
      ? await options.status({ signal: controller.signal })
      : await options.diagnostics({ signal: controller.signal });
    if (controller.signal.aborted || response.destroyed) return;
    const wire = kind === "status"
      ? wireStatusResponse(nodeId, snapshot)
      : wireDiagnosticsResponse(nodeId, snapshot);
    responderJson(response, 200, wire);
  } catch {
    if (!controller.signal.aborted && !response.destroyed) responderJson(response, 503, { error: "unavailable" });
  } finally {
    request.removeListener("aborted", abort);
  }
}

function wireStatusResponse(nodeId: string, value: unknown): Record<string, unknown> {
  const source = ordinaryObject(value, "remote node responder status snapshot");
  rejectUnknownFields(source, new Set(["observedAt", "status", "uptimeSeconds", "activeTasks", "queuedTasks"]), "remote node responder status snapshot");
  const normalized = normalizeRemoteNodeStatusResponse({ schemaVersion: 1, type: "node.status", nodeId, ...source }, nodeId);
  const { contentTrust: _contentTrust, ...wire } = normalized;
  return wire;
}

function wireDiagnosticsResponse(nodeId: string, value: unknown): Record<string, unknown> {
  const source = ordinaryObject(value, "remote node responder diagnostics snapshot");
  rejectUnknownFields(source, new Set(["observedAt", "status", "checks"]), "remote node responder diagnostics snapshot");
  const normalized = normalizeRemoteNodeDiagnosticsResponse({ schemaVersion: 1, type: "node.diagnostics", nodeId, ...source }, nodeId);
  const { contentTrust: _contentTrust, ...wire } = normalized;
  return wire;
}

function authorizedBearer(header: string | undefined, credential: string): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ") || Buffer.byteLength(header, "utf8") > 8_200) return false;
  const supplied = header.slice("Bearer ".length);
  if (validCredential(supplied) === undefined) return false;
  const expectedDigest = createHash("sha256").update(credential, "utf8").digest();
  const suppliedDigest = createHash("sha256").update(supplied, "utf8").digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function responderJson(response: ServerResponse, status: number, value: Record<string, unknown>, headers: Record<string, string> = {}): void {
  if (response.headersSent || response.destroyed) return;
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    "x-content-type-options": "nosniff",
    ...headers
  });
  response.end(body);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function abortError(): Error {
  const error = new Error("remote node read cancelled");
  error.name = "AbortError";
  return error;
}
