import { createHash } from "node:crypto";
import { intersectChildCapabilities, type CapabilityId } from "@odinn/policy";

export const EXECUTABLE_AGENT_SCHEMA_VERSION = 1 as const;
export const AGENT_RUN_GRAPH_SCHEMA_VERSION = 1 as const;
export const MAX_AGENT_GRAPH_NODES = 32;
export const MAX_AGENT_GRAPH_EDGES = 64;
export const MAX_AGENT_GRAPH_DEPTH = 8;
export const MAX_AGENT_GRAPH_FANOUT = 8;
export const MAX_AGENT_GRAPH_BYTES = 32_768;
export const MAX_AGENT_REQUESTS = 32;
export const MAX_AGENT_TIMEOUT_MS = 300_000;

export type ExecutableAgentManifest = {
  schemaVersion: 1;
  id: string;
  revision: number;
  registryRef: string;
  requestedTools: readonly string[];
  requestedCapabilities: readonly string[];
  maxChildren: number;
  defaultTimeoutMs: number;
  manifestDigest: string;
};

export type AgentRunNode = {
  id: string;
  manifestId: string;
  manifestDigest: string;
  inputRef: string;
  resultRef: string;
  dependsOn: readonly string[];
  timeoutMs?: number;
};

export type AgentRunGraph = {
  schemaVersion: 1;
  id: string;
  nodes: readonly AgentRunNode[];
  graphDigest: string;
};

export type AgentDispatchRequest = {
  schemaVersion: 1;
  graphRunId: string;
  nodeCallId: string;
  principalNamespace: string;
  graphDigest: string;
  manifestDigest: string;
  requestDigest: string;
  nodeId: string;
  manifest: ExecutableAgentManifest;
  effectiveCapabilities: readonly CapabilityId[];
  inputRef: string;
  resultRef: string;
  authorized: false;
  requiresAuditedDispatch: true;
};

export type AgentDispatchReceipt = {
  graphRunId: string;
  nodeCallId: string;
  principalNamespace: string;
  graphDigest: string;
  manifestDigest: string;
  requestDigest: string;
  producerNodeId: string;
  resultRef: string;
  resultDigest: string;
  terminalStatus: "completed" | "failed" | "cancelled" | "needs-review";
  auditRef: string;
};

export type AgentRunNodeResult = {
  nodeId: string;
  status: "completed" | "failed" | "cancelled" | "needs-review" | "blocked";
  nodeCallId?: string;
  requestDigest?: string;
  auditRef?: string;
  resultDigest?: string;
  resultRef?: string;
  errorCode?: string;
};

export type AgentRunGraphResult = {
  graphRunId: string;
  principalNamespace: string;
  graphDigest: string;
  status: "completed" | "failed" | "needs-review" | "cancelled";
  nodes: readonly AgentRunNodeResult[];
  pendingPhysicalDispatches: number;
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const REQUEST_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OPAQUE_REFERENCE = /^[a-z][a-z0-9-]{1,15}:[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const REGISTRY_REFERENCE = /^registry:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_JSON_NODES = 512;
const MAX_JSON_ARRAY_LENGTH = 128;
const FORBIDDEN_IDENTITY = /(?:token|secret|auth|credential|approval)/iu;
const manifestSnapshots = new WeakSet<object>();
const graphSnapshots = new WeakSet<object>();
const manifestCollections = new WeakSet<object>();
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsicTypedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const intrinsicTypedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const intrinsicArrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const intrinsicSharedArrayBufferByteLength = typeof SharedArrayBuffer === "undefined"
  ? undefined
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")!.get!;

export type ExecutableAgentManifestCollection = readonly ExecutableAgentManifest[];

function parseBoundedJson(input: unknown, label: string): unknown {
  const isString = typeof input === "string";
  if (!isString && (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Uint8Array.prototype)) {
    throw new Error(`${label} must be bounded UTF-8 JSON text or bytes`);
  }
  let bytes: number;
  let buffer: ArrayBufferLike | undefined;
  try {
    bytes = isString
      ? Buffer.byteLength(input as string, "utf8")
      : Reflect.apply(intrinsicTypedArrayByteLength, input, []) as number;
    if (!isString) buffer = Reflect.apply(intrinsicTypedArrayBuffer, input, []) as ArrayBufferLike;
  } catch {
    throw new Error(`${label} must use an exact Uint8Array internal slot`);
  }
  if (!isString) {
    let ordinaryBuffer = false;
    try {
      Reflect.apply(intrinsicArrayBufferByteLength, buffer, []);
      ordinaryBuffer = true;
    } catch {
      if (intrinsicSharedArrayBufferByteLength) {
        try {
          Reflect.apply(intrinsicSharedArrayBufferByteLength, buffer, []);
          throw new Error(`${label} cannot use shared backing memory`);
        } catch (error) {
          if (error instanceof Error && /shared backing memory/u.test(error.message)) throw error;
        }
      }
    }
    if (!ordinaryBuffer) throw new Error(`${label} backing buffer has invalid internal slots`);
  }
  if (bytes > MAX_AGENT_GRAPH_BYTES) throw new Error(`${label} exceeds ${MAX_AGENT_GRAPH_BYTES} wire bytes`);
  let text: string;
  try {
    text = isString ? input as string : new TextDecoder("utf-8", { fatal: true }).decode(input as Uint8Array);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function cleanJson(input: unknown, label: string): unknown {
  let nodes = 0;
  const visit = (value: unknown, path: string): unknown => {
    if (++nodes > MAX_JSON_NODES) throw new Error(`${label} exceeds ${MAX_JSON_NODES} JSON nodes`);
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${path} must be an ordinary array`);
      if (!Number.isSafeInteger(value.length) || value.length > MAX_JSON_ARRAY_LENGTH) throw new Error(`${path} array length exceeds ${MAX_JSON_ARRAY_LENGTH}`);
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1) throw new Error(`${path} must be a dense array`);
      const expected = [...Array.from({ length: value.length }, (_, index) => String(index)), "length"];
      if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error(`${path} must be a dense array`);
      const clean: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) throw new Error(`${path} array entries must be data fields`);
        clean.push(visit(descriptor.value, `${path}[${index}]`));
      }
      return clean;
    }
    const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
    if (!value || typeof value !== "object" || (prototype !== Object.prototype && prototype !== null) || value === Object.prototype) {
      throw new Error(`${path} must be a plain object`);
    }
    const clean: Record<string, unknown> = Object.create(null);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > 16) throw new Error(`${path} exceeds 16 own fields`);
    for (const key of ownKeys) {
      if (typeof key !== "string") throw new Error(`${path} cannot contain symbols`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) throw new Error(`${path} must contain enumerable data fields`);
      clean[key] = visit(descriptor.value, `${path}.${key}`);
    }
    return clean;
  };
  const clean = visit(input, label);
  if (Buffer.byteLength(stableJson(clean), "utf8") > MAX_AGENT_GRAPH_BYTES) throw new Error(`${label} exceeds ${MAX_AGENT_GRAPH_BYTES} bytes`);
  return clean;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} has unknown field: ${key}`);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${label} must be a bounded identifier`);
  return value;
}

function principal(value: unknown): string {
  const result = identifier(value, "principalNamespace");
  if (FORBIDDEN_IDENTITY.test(result)) throw new Error("principalNamespace uses a forbidden authority namespace");
  return result;
}

function requestReference(value: unknown, label: string): string {
  if (typeof value !== "string" || !REQUEST_REFERENCE.test(value)) throw new Error(`${label} must be a bounded declarative reference`);
  return value;
}

function typedReference(value: unknown, label: string, allowedPrefixes: readonly string[]): string {
  if (typeof value !== "string" || !OPAQUE_REFERENCE.test(value)) throw new Error(`${label} must be an opaque typed reference`);
  const prefix = value.slice(0, value.indexOf(":")).toLowerCase();
  if (!allowedPrefixes.includes(prefix) || FORBIDDEN_IDENTITY.test(value)) throw new Error(`${label} uses a forbidden reference namespace`);
  return value;
}

function registryReference(value: unknown): string {
  if (typeof value !== "string" || !REGISTRY_REFERENCE.test(value)) throw new Error("manifest registryRef must be a trusted registry reference");
  if (FORBIDDEN_IDENTITY.test(value)) throw new Error("manifest registryRef uses a forbidden identity namespace");
  return value;
}

function positive(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  return value;
}

function sortedUniqueReferences(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_AGENT_REQUESTS) throw new Error(`${label} must contain at most ${MAX_AGENT_REQUESTS} references`);
  const result = value.map((item) => requestReference(item, label)).sort();
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}

function deepFreeze<T extends object>(value: T): T {
  for (const item of Object.values(value)) if (item && typeof item === "object" && !Object.isFrozen(item)) deepFreeze(item);
  return Object.freeze(value);
}

function normalizeExecutableAgentManifest(input: unknown): ExecutableAgentManifest {
  const value = object(cleanJson(input, "executable agent manifest"), "executable agent manifest");
  exact(value, ["schemaVersion", "id", "revision", "registryRef", "requestedTools", "requestedCapabilities", "maxChildren", "defaultTimeoutMs", "manifestDigest"], "executable agent manifest");
  if (value.schemaVersion !== EXECUTABLE_AGENT_SCHEMA_VERSION) throw new Error("executable agent manifest has unsupported schemaVersion");
  const normalized = {
    schemaVersion: EXECUTABLE_AGENT_SCHEMA_VERSION,
    id: identifier(value.id, "manifest id"),
    revision: positive(value.revision, "manifest revision"),
    registryRef: registryReference(value.registryRef),
    requestedTools: sortedUniqueReferences(value.requestedTools, "requestedTools"),
    requestedCapabilities: sortedUniqueReferences(value.requestedCapabilities, "requestedCapabilities"),
    maxChildren: positive(value.maxChildren, "maxChildren", MAX_AGENT_GRAPH_FANOUT),
    defaultTimeoutMs: positive(value.defaultTimeoutMs, "defaultTimeoutMs", MAX_AGENT_TIMEOUT_MS)
  };
  const manifestDigest = hash(normalized);
  if (value.manifestDigest !== undefined && value.manifestDigest !== manifestDigest) throw new Error("executable agent manifest digest is invalid");
  const snapshot = deepFreeze({ ...normalized, manifestDigest });
  manifestSnapshots.add(snapshot);
  return snapshot;
}

export function validateExecutableAgentManifest(input: string | Uint8Array): ExecutableAgentManifest {
  return normalizeExecutableAgentManifest(parseBoundedJson(input, "executable agent manifest"));
}

export function validateExecutableAgentManifestCollection(input: string | Uint8Array): ExecutableAgentManifestCollection {
  const parsed = parseBoundedJson(input, "executable manifests collection");
  const clean = cleanJson(parsed, "executable manifests collection");
  if (!Array.isArray(clean) || clean.length > MAX_AGENT_GRAPH_NODES) throw new Error("manifests collection is invalid");
  const snapshots = deepFreeze(clean.map(normalizeExecutableAgentManifest));
  if (new Set(snapshots.map((manifest) => manifest.id)).size !== snapshots.length) throw new Error("manifests collection contains duplicate ids");
  manifestCollections.add(snapshots);
  return snapshots;
}

export function validateAgentRunGraph(input: string | Uint8Array): AgentRunGraph {
  const value = object(cleanJson(parseBoundedJson(input, "agent run graph"), "agent run graph"), "agent run graph");
  exact(value, ["schemaVersion", "id", "nodes", "graphDigest"], "agent run graph");
  if (value.schemaVersion !== AGENT_RUN_GRAPH_SCHEMA_VERSION) throw new Error("agent run graph has unsupported schemaVersion");
  if (!Array.isArray(value.nodes) || value.nodes.length === 0 || value.nodes.length > MAX_AGENT_GRAPH_NODES) throw new Error(`agent run graph requires 1-${MAX_AGENT_GRAPH_NODES} nodes`);
  const nodes = value.nodes.map((item, index): AgentRunNode => {
    const node = object(item, `graph node ${index + 1}`);
    exact(node, ["id", "manifestId", "manifestDigest", "inputRef", "resultRef", "dependsOn", "timeoutMs"], `graph node ${index + 1}`);
    if (!Array.isArray(node.dependsOn) || node.dependsOn.length > MAX_AGENT_GRAPH_NODES) throw new Error("node dependencies are invalid");
    const dependsOn = node.dependsOn.map((dependency) => identifier(dependency, "dependency id")).sort();
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error("node dependencies contain duplicates");
    return {
      id: identifier(node.id, "node id"),
      manifestId: identifier(node.manifestId, "node manifestId"),
      manifestDigest: typeof node.manifestDigest === "string" && DIGEST.test(node.manifestDigest)
        ? node.manifestDigest
        : (() => { throw new Error("node manifestDigest must be a SHA-256 digest"); })(),
      inputRef: typedReference(node.inputRef, "node inputRef", ["input", "artifact", "memory"]),
      resultRef: typedReference(node.resultRef, "node resultRef", ["result", "artifact"]),
      dependsOn,
      ...(node.timeoutMs === undefined ? {} : { timeoutMs: positive(node.timeoutMs, "node timeoutMs", MAX_AGENT_TIMEOUT_MS) })
    };
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new Error("agent run graph contains duplicate nodes");
  if (new Set(nodes.map((node) => node.resultRef)).size !== nodes.length) throw new Error("agent run graph contains duplicate resultRefs");
  const ids = new Set(nodes.map((node) => node.id));
  let edges = 0;
  const children = new Map(nodes.map((node) => [node.id, 0]));
  for (const node of nodes) for (const dependency of node.dependsOn) {
    if (!ids.has(dependency)) throw new Error(`node ${node.id} has an unknown dependency`);
    if (dependency === node.id) throw new Error("agent run graph contains a self-cycle");
    edges += 1;
    children.set(dependency, children.get(dependency)! + 1);
  }
  if (edges > MAX_AGENT_GRAPH_EDGES) throw new Error(`agent run graph exceeds ${MAX_AGENT_GRAPH_EDGES} edges`);
  if ([...children.values()].some((count) => count > MAX_AGENT_GRAPH_FANOUT)) throw new Error(`agent run graph exceeds fanout ${MAX_AGENT_GRAPH_FANOUT}`);
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depth = (id: string): number => {
    if (depths.has(id)) return depths.get(id)!;
    if (visiting.has(id)) throw new Error("agent run graph contains a cycle");
    visiting.add(id);
    const result = 1 + Math.max(0, ...byId.get(id)!.dependsOn.map(depth));
    visiting.delete(id);
    depths.set(id, result);
    return result;
  };
  for (const node of nodes) if (depth(node.id) > MAX_AGENT_GRAPH_DEPTH) throw new Error(`agent run graph exceeds depth ${MAX_AGENT_GRAPH_DEPTH}`);
  const normalized = { schemaVersion: AGENT_RUN_GRAPH_SCHEMA_VERSION, id: identifier(value.id, "graph id"), nodes };
  const graphDigest = hash(normalized);
  if (value.graphDigest !== undefined && value.graphDigest !== graphDigest) throw new Error("agent run graph digest is invalid");
  const snapshot = deepFreeze({ ...normalized, graphDigest });
  graphSnapshots.add(snapshot);
  return snapshot;
}
export class AgentRunGraphRunner {
  private readonly dispatch: (request: AgentDispatchRequest, context: { signal: AbortSignal }) => Promise<AgentDispatchReceipt>;
  private readonly maxPhysicalSlots: number;
  private readonly physical = new Map<string, Promise<void>>();
  private active?: { runId: string; controller: AbortController };
  private stopped = false;

  constructor(options: {
    dispatch: (request: AgentDispatchRequest, context: { signal: AbortSignal }) => Promise<AgentDispatchReceipt>;
    maxPhysicalSlots?: number;
  }) {
    if (!options || typeof options.dispatch !== "function") throw new Error("runner requires an audited dispatch callback");
    this.dispatch = options.dispatch;
    this.maxPhysicalSlots = positive(options.maxPhysicalSlots ?? 4, "maxPhysicalSlots", 16);
  }

  cancel(graphRunId: string): boolean {
    if (!this.active || this.active.runId !== identifier(graphRunId, "graphRunId")) return false;
    this.active.controller.abort();
    return true;
  }

  async shutdown(timeoutMs = 1_000): Promise<{ unresolvedNodeCallIds: readonly string[] }> {
    this.stopped = true;
    this.active?.controller.abort();
    const timeout = positive(timeoutMs, "shutdown timeoutMs", MAX_AGENT_TIMEOUT_MS);
    await Promise.race([
      Promise.allSettled([...this.physical.values()]),
      new Promise<void>((resolve) => setTimeout(resolve, timeout))
    ]);
    return deepFreeze({ unresolvedNodeCallIds: [...this.physical.keys()].sort() });
  }

  async run(input: {
    graphRunId: string;
    principalNamespace: string;
    graph: AgentRunGraph;
    manifests: ExecutableAgentManifestCollection;
    parentCapabilities: readonly string[];
    maxConcurrency?: number;
    maxRunMs?: number;
    signal?: AbortSignal;
  }): Promise<AgentRunGraphResult> {
    if (this.stopped) throw new Error("runner is stopped");
    if (this.active) throw new Error("runner already owns an active run");
    if (this.physical.size) throw new Error("runner has unresolved physical dispatches");
    const graphRunId = identifier(input.graphRunId, "graphRunId");
    const principalNamespace = principal(input.principalNamespace);
    if (!graphSnapshots.has(input.graph as object)) throw new Error("graph must be a validated branded snapshot");
    if (!manifestCollections.has(input.manifests as object)) throw new Error("manifests must be a validated branded collection");
    const graph = input.graph;
    const manifests = input.manifests;
    const byManifest = new Map(manifests.map((manifest) => [manifest.id, manifest]));
    const authorityByManifest = new Map(manifests.map((manifest) => [manifest.id, intersectChildCapabilities({
      parentCapabilities: input.parentCapabilities,
      requestedCapabilities: manifest.requestedCapabilities,
      requestedTools: manifest.requestedTools
    })]));
    if (byManifest.size !== manifests.length) throw new Error("manifests collection contains duplicate ids");
    for (const node of graph.nodes) {
      const manifest = byManifest.get(node.manifestId);
      if (!manifest || manifest.manifestDigest !== node.manifestDigest) throw new Error(`node ${node.id} manifest identity does not match`);
      const children = graph.nodes.filter((candidate) => candidate.dependsOn.includes(node.id)).length;
      if (children > manifest.maxChildren) throw new Error(`node ${node.id} exceeds its manifest child limit`);
    }
    const concurrency = positive(input.maxConcurrency ?? this.maxPhysicalSlots, "maxConcurrency", this.maxPhysicalSlots);
    const maxRunMs = positive(input.maxRunMs ?? MAX_AGENT_TIMEOUT_MS, "maxRunMs", MAX_AGENT_TIMEOUT_MS);
    const controller = new AbortController();
    this.active = { runId: graphRunId, controller };
    const externalAbort = () => controller.abort();
    input.signal?.addEventListener("abort", externalAbort, { once: true });
    if (input.signal?.aborted) controller.abort();
    const deadline = setTimeout(() => controller.abort(), maxRunMs);
    const results = new Map<string, AgentRunNodeResult>();
    const byNode = new Map(graph.nodes.map((node) => [node.id, node]));
    const levels = new Map<string, number>();
    const level = (node: AgentRunNode): number => {
      if (levels.has(node.id)) return levels.get(node.id)!;
      const result = node.dependsOn.length ? 1 + Math.max(...node.dependsOn.map((id) => level(byNode.get(id)!))) : 0;
      levels.set(node.id, result);
      return result;
    };
    graph.nodes.forEach(level);

    const runNode = async (node: AgentRunNode): Promise<void> => {
      if (controller.signal.aborted) {
        results.set(node.id, { nodeId: node.id, status: "cancelled", errorCode: "CANCELLED_BEFORE_DISPATCH" });
        return;
      }
      const manifest = byManifest.get(node.manifestId)!;
      const nodeCallId = `call:${hash({ principalNamespace, graphRunId, graphDigest: graph.graphDigest, nodeId: node.id }).slice(0, 48)}`;
      const requestCore = {
        schemaVersion: 1 as const, graphRunId, nodeCallId, principalNamespace,
        graphDigest: graph.graphDigest, manifestDigest: manifest.manifestDigest,
        nodeId: node.id, manifest, effectiveCapabilities: authorityByManifest.get(manifest.id)!, inputRef: node.inputRef, resultRef: node.resultRef,
        authorized: false as const, requiresAuditedDispatch: true as const
      };
      const request = deepFreeze({ ...requestCore, requestDigest: hash(requestCore) });
      const local = new AbortController();
      const abort = () => local.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, node.timeoutMs ?? manifest.defaultTimeoutMs);
      let started = false;
      const raw = Promise.resolve().then(() => {
        if (local.signal.aborted) throw new Error("cancelled before dispatch");
        started = true;
        return this.dispatch(request, { signal: local.signal });
      });
      const physical = raw.then(() => undefined, () => undefined).finally(() => {
        this.physical.delete(nodeCallId);
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", abort);
      });
      this.physical.set(nodeCallId, physical);
      const logical = Promise.race([
        raw.then((receipt) => this.validateReceipt(request, receipt)),
        new Promise<AgentDispatchReceipt>((_, reject) => local.signal.addEventListener("abort", () => reject(new Error("dispatch uncertain")), { once: true }))
      ]);
      try {
        const receipt = await logical;
        results.set(node.id, {
          nodeId: node.id,
          status: receipt.terminalStatus,
          nodeCallId,
          requestDigest: request.requestDigest,
          auditRef: receipt.auditRef,
          resultDigest: receipt.resultDigest,
          resultRef: receipt.resultRef,
          ...(receipt.terminalStatus === "completed" ? {} : { errorCode: "AUDITED_TERMINAL" })
        });
      } catch {
        results.set(node.id, {
          nodeId: node.id,
          status: started ? "needs-review" : "cancelled",
          ...(started ? { nodeCallId, requestDigest: request.requestDigest } : {}),
          errorCode: started ? "DISPATCH_OUTCOME_UNCERTAIN" : "CANCELLED_BEFORE_DISPATCH"
        });
      }
    };

    try {
      const maxLevel = Math.max(...levels.values());
      for (let current = 0; current <= maxLevel; current += 1) {
        const wave = graph.nodes.filter((node) => levels.get(node.id) === current);
        for (let offset = 0; offset < wave.length; offset += concurrency) {
          const batch = wave.slice(offset, offset + concurrency);
          if (controller.signal.aborted) {
            batch.forEach((node) => results.set(node.id, { nodeId: node.id, status: "cancelled", errorCode: "CANCELLED_BEFORE_DISPATCH" }));
            continue;
          }
          for (const node of batch) {
            const dependencies = node.dependsOn.map((id) => results.get(id)!);
            if (dependencies.some((result) => result.status !== "completed")) {
              results.set(node.id, { nodeId: node.id, status: "blocked", errorCode: "DEPENDENCY_NOT_COMPLETED" });
            }
          }
          const runnable = batch.filter((node) => !results.has(node.id));
          if (this.physical.size + runnable.length > this.maxPhysicalSlots) {
            controller.abort();
            runnable.forEach((node) => results.set(node.id, { nodeId: node.id, status: "cancelled", errorCode: "PHYSICAL_CAPACITY_UNAVAILABLE" }));
          } else {
            await Promise.all(runnable.map(runNode));
          }
        }
      }
    } finally {
      clearTimeout(deadline);
      input.signal?.removeEventListener("abort", externalAbort);
      this.active = undefined;
      for (const node of graph.nodes) if (!results.has(node.id)) results.set(node.id, { nodeId: node.id, status: "cancelled", errorCode: "RUN_CANCELLED" });
    }
    const ordered = graph.nodes.map((node) => results.get(node.id)!);
    const status = ordered.some((item) => item.status === "needs-review") ? "needs-review"
      : ordered.some((item) => item.status === "failed" || item.status === "blocked") ? "failed"
        : ordered.some((item) => item.status === "cancelled") ? "cancelled" : "completed";
    return deepFreeze({ graphRunId, principalNamespace, graphDigest: graph.graphDigest, status, nodes: ordered, pendingPhysicalDispatches: this.physical.size });
  }

  private validateReceipt(request: AgentDispatchRequest, input: unknown): AgentDispatchReceipt {
    const value = object(cleanJson(input, "agent dispatch receipt"), "agent dispatch receipt");
    exact(value, ["graphRunId", "nodeCallId", "principalNamespace", "graphDigest", "manifestDigest", "requestDigest", "producerNodeId", "resultRef", "resultDigest", "terminalStatus", "auditRef"], "agent dispatch receipt");
    for (const key of ["graphRunId", "nodeCallId", "principalNamespace", "graphDigest", "manifestDigest", "requestDigest"] as const) {
      if (value[key] !== request[key]) throw new Error(`receipt ${key} mismatch`);
    }
    if (value.producerNodeId !== request.nodeId || value.resultRef !== request.resultRef) throw new Error("receipt node or result reference mismatch");
    if (typeof value.resultDigest !== "string" || !DIGEST.test(value.resultDigest)) throw new Error("receipt resultDigest is invalid");
    if (!["completed", "failed", "cancelled", "needs-review"].includes(String(value.terminalStatus))) throw new Error("receipt terminalStatus is invalid");
    return deepFreeze({
      graphRunId: request.graphRunId, nodeCallId: request.nodeCallId, principalNamespace: request.principalNamespace,
      graphDigest: request.graphDigest, manifestDigest: request.manifestDigest, requestDigest: request.requestDigest,
      producerNodeId: request.nodeId, resultRef: request.resultRef, resultDigest: value.resultDigest,
      terminalStatus: value.terminalStatus as AgentDispatchReceipt["terminalStatus"],
      auditRef: typedReference(value.auditRef, "receipt auditRef", ["audit"])
    });
  }
}
