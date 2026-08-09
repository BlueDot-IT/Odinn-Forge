import { capabilitiesForTool, intersectChildCapabilities, type CapabilityId, type RuntimePolicy } from "@odinn/policy";
import type { JsonObject } from "@odinn/protocol";
import {
  AgentRunGraphRunner,
  digestAgentRunValue,
  normalizeAgentPrincipalNamespace,
  validateAgentRunGraph,
  validateExecutableAgentManifestCollection,
  type AgentDispatchReceipt,
  type AgentRunGraphResult,
  type ExecutableAgentManifest
} from "./agent-run-graphs.ts";

export const AGENT_GRAPH_TOOL = "agent.delegate" as const;
export const AGENT_GRAPH_REGISTRY_REF = "registry:agent-runner.v1" as const;

const CHILD_TOOL_ALLOWLIST = new Set([
  "job.healthcheck",
  "text.echo",
  "workspace.readText",
  "workspace.list",
  "workspace.stat",
  "workspace.search",
  "workspace.read",
  "workspace.diff",
  "web.search",
  "web.fetch",
  "memory.search",
  "memory.recall",
  "memory.browse",
  "memory.open",
  "memory.curate"
]);

const CHILD_INPUT_KEYS = new Set([
  "prompt", "messages", "model", "maxTurns", "maxTokens", "sessionId", "projectId",
  "reasoningBudgetRecovery"
]);
const MAX_CHILD_INPUT_BYTES = 256 * 1024;
const MAX_CHILD_MESSAGE_BYTES = 64 * 1024;
const CHILD_DISPATCH_CAPABILITIES = ["agent.delegate", "network.access"] as const satisfies readonly CapabilityId[];

export type AgentGraphTaskInput = {
  graph: string;
  manifests: string;
  principalNamespace: string;
  inputs: Record<string, JsonObject>;
  maxConcurrency?: number;
  maxRunMs?: number;
};

export type AgentGraphExecutorOptions = {
  registry: Map<string, any>;
  policy: RuntimePolicy;
  parentCapabilities: readonly CapabilityId[];
  runChild: (task: JsonObject & { registry: Map<string, any>; modelRegistry: Map<string, any>; policy: RuntimePolicy; signal: AbortSignal; executionAttemptId: string }) => Promise<any>;
  appendEvent?: (event: { type: string; payload: JsonObject }) => void | Promise<void>;
  appendAuditEvent?: (event: { type: string; payload: JsonObject }) => void | Promise<void>;
  readAuditRun?: (runId: string) => Promise<{ events?: readonly { type?: string }[] } | undefined>;
  getExecutionAttemptId?: (runId: string) => string | undefined;
  persistGraph?: {
    create(input: {
      graphRunId: string;
      parentRunId: string;
      graphDigest: string;
      manifestsDigest: string;
      graphBytes: number;
      manifestsBytes: number;
      principalNamespace: string;
      requestDigest: string;
      maxRunMs: number;
      nodes: readonly { nodeId: string; manifestId: string; manifestDigest: string; inputRef: string; inputDigest: string; resultRef: string; dependsOn: readonly string[] }[];
    }): void | Promise<void>;
    startNode(input: { graphRunId: string; nodeId: string; nodeCallId: string; requestDigest: string; executionRunId: string; executionAttemptId: string; resultRef: string; auditRef: string }): void | Promise<void>;
    cancel?(input: { graphRunId: string; errorCode?: string }): void;
    beginCompletion?(input: { graphRunId: string }): void | Promise<void>;
    recordNode(input: { graphRunId: string; nodeId: string; status: "completed" | "failed" | "cancelled" | "needs-review" | "blocked"; nodeCallId?: string; requestDigest?: string; executionRunId?: string; executionAttemptId?: string; resultDigest?: string; resultRef?: string; auditRef?: string; errorCode?: string }): void | Promise<void>;
    complete(input: { graphRunId: string; status: "completed" | "failed" | "cancelled" | "needs-review"; errorCode?: string }): { status?: "completed" | "failed" | "cancelled" | "needs-review" } | void | Promise<{ status?: "completed" | "failed" | "cancelled" | "needs-review" } | void>;
  };
  runId: string;
  signal?: AbortSignal;
};

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be an ordinary object`);
  }
  return value as Record<string, unknown>;
}

function boundedJsonText(value: unknown, label: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 32_768) {
    throw new Error(`${label} must be bounded JSON text`);
  }
  return value;
}

function boundedChildInput(value: unknown, label: string): JsonObject {
  const input = plainObject(value, label);
  for (const key of Object.keys(input)) if (!CHILD_INPUT_KEYS.has(key)) throw new Error(`${label}.${key} is not allowed`);
  if (Object.prototype.hasOwnProperty.call(input, "prompt")) {
    if (typeof input.prompt !== "string" || !input.prompt.trim() || Buffer.byteLength(input.prompt, "utf8") > MAX_CHILD_INPUT_BYTES) {
      throw new Error(`${label}.prompt is invalid`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, "messages")) {
    if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 32) throw new Error(`${label}.messages is invalid`);
    for (const [index, raw] of input.messages.entries()) {
      const message = plainObject(raw, `${label}.messages[${index}]`);
      const keys = Object.keys(message);
      if (keys.some((key) => !["role", "content"].includes(key))) throw new Error(`${label}.messages[${index}] contains an unsupported field`);
      if (!["system", "user", "assistant"].includes(String(message.role)) || typeof message.content !== "string") throw new Error(`${label}.messages[${index}] is invalid`);
      if (Buffer.byteLength(message.content, "utf8") > MAX_CHILD_MESSAGE_BYTES) throw new Error(`${label}.messages[${index}] is too large`);
    }
  }
  if (!input.prompt && !input.messages) throw new Error(`${label} requires prompt or messages`);
  if (input.model !== undefined && (typeof input.model !== "string" || input.model.length > 256)) throw new Error(`${label}.model is invalid`);
  if (input.sessionId !== undefined && (typeof input.sessionId !== "string" || input.sessionId.length > 256)) throw new Error(`${label}.sessionId is invalid`);
  if (input.projectId !== undefined && (typeof input.projectId !== "string" || input.projectId.length > 256)) throw new Error(`${label}.projectId is invalid`);
  for (const key of ["maxTurns", "maxTokens"] as const) {
    const value = input[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > (key === "maxTurns" ? 4 : 4_096))) throw new Error(`${label}.${key} is invalid`);
  }
  if (input.reasoningBudgetRecovery !== undefined && typeof input.reasoningBudgetRecovery !== "boolean") throw new Error(`${label}.reasoningBudgetRecovery is invalid`);
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_CHILD_INPUT_BYTES) throw new Error(`${label} exceeds the input limit`);
  return input as JsonObject;
}

function childPolicy(policy: RuntimePolicy, effective: readonly CapabilityId[], parentCapabilities: readonly CapabilityId[]): RuntimePolicy {
  // Child authority is the explicitly admitted parent grant only. The
  // ambient policy allowlist is not an authority source for a child graph.
  const allowedCapabilities = [...new Set([
    ...effective,
    ...CHILD_DISPATCH_CAPABILITIES.filter((capability) => parentCapabilities.includes(capability))
  ])] as CapabilityId[];
  return {
    ...policy,
    allowedCapabilities,
    // A scoped parent grant is intentionally not copied into the child
    // policy. The active graph profile has no tool-scoped delegation model;
    // retaining it here would make a grant scoped to one parent tool appear
    // globally usable by the child.
    scopedCapabilities: []
  };
}

function childRegistry(parent: Map<string, any>, manifest: ExecutableAgentManifest): { execution: Map<string, any>; model: Map<string, any> } {
  const model = new Map<string, any>();
  for (const toolName of manifest.requestedTools) {
    if (!CHILD_TOOL_ALLOWLIST.has(toolName)) throw new Error(`manifest ${manifest.id} requests a tool outside the read-only child allowlist`);
    const tool = parent.get(toolName);
    if (!tool || typeof tool.execute !== "function") throw new Error(`manifest ${manifest.id} references an unavailable tool: ${toolName}`);
    model.set(toolName, tool);
  }
  const agentRun = parent.get("agent.run");
  if (!agentRun || typeof agentRun.execute !== "function") throw new Error("agent.run is unavailable for child dispatch");
  const execution = new Map(model);
  execution.set("agent.run", agentRun);
  return { execution, model };
}

function graphInputs(input: AgentGraphTaskInput, graphNodes: readonly { inputRef: string }[]): Map<string, JsonObject> {
  const values = plainObject(input.inputs, "inputs");
  const required = new Set(graphNodes.map((node) => node.inputRef));
  for (const key of Object.keys(values)) if (!required.has(key)) throw new Error(`inputs contains an unused reference: ${key}`);
  const result = new Map<string, JsonObject>();
  for (const ref of required) {
    if (!ref.startsWith("input:")) throw new Error(`graph input reference is not supported by the live dispatcher: ${ref}`);
    if (!Object.prototype.hasOwnProperty.call(values, ref)) throw new Error(`graph input is missing: ${ref}`);
    result.set(ref, boundedChildInput(values[ref], `inputs.${ref}`));
  }
  return result;
}

async function append(options: AgentGraphExecutorOptions, type: string, payload: JsonObject) {
  const auditType = type === "agent-graph-validated" ? "agent.graph.validated"
    : type === "agent-graph-node-dispatch" ? "agent.graph.node.started"
      : type === "agent-graph-node-settled" ? "agent.graph.node.completed"
        : type === "agent-graph-completed" ? "agent.graph.completed" : type;
  await options.appendAuditEvent?.({ type: auditType, payload });
  await options.appendEvent?.({ type, payload });
}

async function appendFinalCompletion(options: AgentGraphExecutorOptions, payload: JsonObject, isCancellationFenced: () => boolean): Promise<"completed" | "failed" | "cancelled" | "needs-review"> {
  // Fence the graph in a non-terminal publishing state before crossing the
  // independent audit/ledger boundaries. A later failure is therefore
  // quarantined by startup reconciliation instead of appearing complete.
  await options.persistGraph?.beginCompletion?.({ graphRunId: String(payload.graphRunId) });
  let needsReview = payload.status === "needs-review" || isCancellationFenced();
  const publish = async (quarantined: boolean) => {
    const eventPayload = quarantined
      ? {
        ...payload,
        status: "needs-review",
        errorCode: isCancellationFenced() ? "GRAPH_CANCELLATION_UNCERTAIN" : "GRAPH_OUTCOME_UNCERTAIN"
      }
      : payload;
    const terminalStatus = String(eventPayload.status);
    const auditType = quarantined ? "agent.graph.needs-review"
      : terminalStatus === "failed" ? "agent.graph.failed"
        : terminalStatus === "cancelled" ? "agent.graph.cancelled" : "agent.graph.completed";
    const ledgerType = quarantined ? "agent-graph-needs-review"
      : terminalStatus === "failed" ? "agent-graph-failed"
        : terminalStatus === "cancelled" ? "agent-graph-cancelled" : "agent-graph-completed";
    await options.appendAuditEvent?.({ type: auditType, payload: eventPayload });
    await options.appendEvent?.({ type: ledgerType, payload: eventPayload });
  };
  await publish(needsReview);
  if (!needsReview && isCancellationFenced()) {
    needsReview = true;
    await publish(true);
  }
  return needsReview ? "needs-review" : payload.status as "completed" | "failed" | "cancelled";
}

export async function executeAgentGraph(input: AgentGraphTaskInput, options: AgentGraphExecutorOptions): Promise<AgentRunGraphResult> {
  if (!options || typeof options.runChild !== "function") throw new Error("agent graph execution requires a governed child dispatcher");
  const graphText = boundedJsonText(input?.graph, "graph");
  const manifestsText = boundedJsonText(input?.manifests, "manifests");
  const graph = validateAgentRunGraph(graphText);
  const manifests = validateExecutableAgentManifestCollection(manifestsText);
  // Normalize the caller-supplied namespace only in memory, then immediately
  // replace it with its bounded digest. No runner request, child task, audit
  // projection, receipt, or graph result may carry the raw principal.
  const principalNamespaceInput = normalizeAgentPrincipalNamespace(input?.principalNamespace);
  const principalNamespace = `sha256:${digestAgentRunValue(principalNamespaceInput)}`;
  if (graph.nodes.length !== 1 || manifests.length !== 1) {
    throw new Error("the active agent graph profile permits exactly one read-only child node");
  }
  if (input.maxConcurrency !== undefined && input.maxConcurrency !== 1) {
    throw new Error("the active agent graph profile permits maxConcurrency=1 only");
  }
  const inputs = graphInputs(input, graph.nodes);
  if (manifests.some((manifest) => manifest.registryRef !== AGENT_GRAPH_REGISTRY_REF)) {
    throw new Error(`live child dispatch requires ${AGENT_GRAPH_REGISTRY_REF}`);
  }
  for (const manifest of manifests) {
    if (!manifest.requestedTools.length) throw new Error(`manifest ${manifest.id} must request at least one read-only tool`);
    for (const toolName of manifest.requestedTools) {
      if (!CHILD_TOOL_ALLOWLIST.has(toolName)) throw new Error(`manifest ${manifest.id} requests a non-read-only tool`);
      capabilitiesForTool(toolName);
    }
    intersectChildCapabilities({
      parentCapabilities: options.parentCapabilities,
      requestedCapabilities: manifest.requestedCapabilities,
      requestedTools: manifest.requestedTools
    });
  }
  const manifestsById = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  for (const node of graph.nodes) {
    const manifest = manifestsById.get(node.manifestId);
    if (!manifest || manifest.manifestDigest !== node.manifestDigest) throw new Error(`node ${node.id} manifest identity does not match`);
    const children = graph.nodes.filter((candidate) => candidate.dependsOn.includes(node.id)).length;
    if (children > manifest.maxChildren) throw new Error(`node ${node.id} exceeds its manifest child limit`);
  }
  if (!options.parentCapabilities.includes("agent.delegate") || !options.parentCapabilities.includes("network.access")) {
    throw new Error("agent graph parent authority must explicitly include agent.delegate and network.access");
  }
  const graphRunId = `graph:${digestAgentRunValue({ runId: options.runId, graphDigest: graph.graphDigest }).slice(0, 48)}`;
  const manifestsDigest = digestAgentRunValue(manifests);
  const inputDigests = graph.nodes.map((node) => ({ inputRef: node.inputRef, inputDigest: digestAgentRunValue(inputs.get(node.inputRef)) }));
  const graphRequestDigest = digestAgentRunValue({
    graphDigest: graph.graphDigest,
    manifestsDigest,
    principalNamespace,
    maxConcurrency: input.maxConcurrency ?? 1,
    maxRunMs: input.maxRunMs ?? 300_000,
    inputDigests
  });
  try {
    if (options.persistGraph) {
      await options.persistGraph.create({
        graphRunId,
        parentRunId: options.runId,
        graphDigest: graph.graphDigest,
        manifestsDigest,
        graphBytes: Buffer.byteLength(graphText, "utf8"),
        manifestsBytes: Buffer.byteLength(manifestsText, "utf8"),
        // Durable graph state retains a digest marker, never the principal.
        principalNamespace,
        requestDigest: graphRequestDigest,
        maxRunMs: input.maxRunMs ?? 300_000,
        nodes: graph.nodes.map((node) => ({
          nodeId: node.id,
          manifestId: node.manifestId,
          manifestDigest: node.manifestDigest,
          inputRef: node.inputRef,
          inputDigest: digestAgentRunValue(inputs.get(node.inputRef)),
          resultRef: node.resultRef,
          dependsOn: node.dependsOn
        }))
      });
    }
    await append(options, "agent-graph-validated", {
      graphRunId,
      graphId: graph.id,
      graphDigest: graph.graphDigest,
      nodeCount: graph.nodes.length,
      manifestCount: manifests.length
    });
  } catch (error) {
    try { options.persistGraph?.cancel?.({ graphRunId, errorCode: "GRAPH_VALIDATION_PUBLICATION_UNCERTAIN" }); } catch { /* preserve the original validation error */ }
    throw error;
  }
  let cancellationFenced = false;
  let terminalPublicationStarted = false;
  const fenceCancellation = () => {
    // Once the graph has entered its terminal publication boundary, the
    // terminal outcome owns the state transition. A later abort belongs to
    // the parent controller and must not create a graph-completed/needs-review
    // split across the independent audit and ledger stores.
    if (cancellationFenced || terminalPublicationStarted) return;
    cancellationFenced = true;
    // The SQLite implementation is synchronous on purpose: the cancellation
    // fence must win before a late child completion can write its result.
    try {
      options.persistGraph?.cancel?.({ graphRunId, errorCode: "GRAPH_CANCELLATION_UNCERTAIN" });
    } catch {
      // The parent outcome remains uncertain if the fence store is unavailable.
    }
  };
  options.signal?.addEventListener("abort", fenceCancellation, { once: true });
  if (options.signal?.aborted) fenceCancellation();
  const runner = new AgentRunGraphRunner({ maxPhysicalSlots: 4, dispatch: async (request, { signal }) => {
    const manifest = request.manifest;
    const resolved = inputs.get(request.inputRef);
    if (!resolved) throw new Error(`graph input is missing: ${request.inputRef}`);
    const registries = childRegistry(options.registry, manifest);
    const policy = childPolicy(options.policy, request.effectiveCapabilities, options.parentCapabilities);
    const childId = `child-${digestAgentRunValue({ parentRunId: options.runId, graphRunId: request.graphRunId, nodeId: request.nodeId }).slice(0, 48)}`;
    const executionAttemptId = `attempt_${digestAgentRunValue({ childId, requestDigest: request.requestDigest }).slice(0, 48)}`;
    const auditRef = `audit:${childId}`;
    try {
      await options.persistGraph?.startNode({ graphRunId: request.graphRunId, nodeId: request.nodeId, nodeCallId: request.nodeCallId, requestDigest: request.requestDigest, executionRunId: childId, executionAttemptId, resultRef: request.resultRef, auditRef });
    } catch {
      // A failed start write may have committed before surfacing its error.
      // Quarantine both queued and running representations synchronously so
      // the graph can never finish with an unsettled durable node.
      try {
        options.persistGraph?.cancel?.({ graphRunId: request.graphRunId, errorCode: "NODE_DISPATCH_PERSISTENCE_UNCERTAIN" });
      } catch {
        // The graph completion path retains the uncertainty if the fence store
        // is unavailable as well.
      }
      const resultDigest = digestAgentRunValue({ resultRef: request.resultRef, terminalStatus: "needs-review", errorCode: "NODE_DISPATCH_PERSISTENCE_UNCERTAIN" });
      return {
        graphRunId: request.graphRunId, nodeCallId: request.nodeCallId, principalNamespace: request.principalNamespace,
        graphDigest: request.graphDigest, manifestDigest: request.manifestDigest, requestDigest: request.requestDigest,
        producerNodeId: request.nodeId, resultRef: request.resultRef, resultDigest,
        terminalStatus: "needs-review", auditRef
      } satisfies AgentDispatchReceipt;
    }
    try {
      await append(options, "agent-graph-node-dispatch", {
        graphRunId: request.graphRunId,
        nodeCallId: request.nodeCallId,
        nodeId: request.nodeId,
        requestDigest: request.requestDigest,
        manifestDigest: request.manifestDigest,
        resultRef: request.resultRef
      });
    } catch {
      const resultDigest = digestAgentRunValue({ resultRef: request.resultRef, terminalStatus: "needs-review", errorCode: "NODE_DISPATCH_AUDIT_UNCERTAIN" });
      try {
        await options.persistGraph?.recordNode({
          graphRunId: request.graphRunId,
          nodeId: request.nodeId,
          status: "needs-review",
          nodeCallId: request.nodeCallId,
          requestDigest: request.requestDigest,
          executionRunId: childId,
          executionAttemptId,
          resultDigest,
          resultRef: request.resultRef,
          auditRef,
          errorCode: "NODE_DISPATCH_AUDIT_UNCERTAIN"
        });
      } catch {
        // The graph completion path and startup reconciliation retain the
        // original audit error if the durable node settlement also fails.
      }
      try {
        await append(options, "agent-graph-node-settled", {
          graphRunId: request.graphRunId,
          nodeId: request.nodeId,
          requestDigest: request.requestDigest,
          resultRef: request.resultRef,
          terminalStatus: "needs-review",
          resultDigest,
          auditRef,
          errorCode: "NODE_DISPATCH_AUDIT_UNCERTAIN"
        });
      } catch {
        // Preserve the original node-start publication error.
      }
      return {
        graphRunId: request.graphRunId, nodeCallId: request.nodeCallId, principalNamespace: request.principalNamespace,
        graphDigest: request.graphDigest, manifestDigest: request.manifestDigest, requestDigest: request.requestDigest,
        producerNodeId: request.nodeId, resultRef: request.resultRef, resultDigest,
        terminalStatus: "needs-review", auditRef
      } satisfies AgentDispatchReceipt;
    }
    let childResult: any;
    try {
      childResult = await options.runChild({
        id: childId,
        tool: "agent.run",
        input: resolved,
        actor: `child-agent:${request.principalNamespace}`,
        reason: `agent-graph:${request.graphRunId}:${request.nodeId}`,
        registry: registries.execution,
        modelRegistry: registries.model,
        policy,
        allowNestedAgentExecution: false,
        executionAttemptId,
        signal
      });
    } catch (error) {
      const cancelled = signal.aborted || (error as NodeError)?.name === "AbortError";
      let hasTerminalAudit = true;
      if (options.readAuditRun) {
        try {
          const childAudit = await options.readAuditRun(childId);
          hasTerminalAudit = Boolean(childAudit?.events?.some((event) => ["task.completed", "task.failed", "task.cancelled"].includes(String(event.type))));
        } catch {
          hasTerminalAudit = false;
        }
      }
      const terminalStatus = cancelled || !hasTerminalAudit ? "needs-review" : "failed";
      const resultDigest = digestAgentRunValue({ resultRef: request.resultRef, terminalStatus, errorCode: cancelled ? "CHILD_DISPATCH_UNCERTAIN" : "CHILD_DISPATCH_FAILED" });
      await options.persistGraph?.recordNode({ graphRunId: request.graphRunId, nodeId: request.nodeId, status: terminalStatus, nodeCallId: request.nodeCallId, requestDigest: request.requestDigest, executionRunId: childId, executionAttemptId, resultDigest, resultRef: request.resultRef, auditRef, errorCode: cancelled ? "CHILD_DISPATCH_UNCERTAIN" : "CHILD_DISPATCH_FAILED" });
      await append(options, "agent-graph-node-settled", { graphRunId: request.graphRunId, nodeId: request.nodeId, requestDigest: request.requestDigest, resultRef: request.resultRef, terminalStatus, resultDigest, auditRef });
      return {
        graphRunId: request.graphRunId, nodeCallId: request.nodeCallId, principalNamespace: request.principalNamespace,
        graphDigest: request.graphDigest, manifestDigest: request.manifestDigest, requestDigest: request.requestDigest,
        producerNodeId: request.nodeId, resultRef: request.resultRef, resultDigest, terminalStatus, auditRef
      } satisfies AgentDispatchReceipt;
    }
    let hasTerminalAudit = true;
    if (options.readAuditRun) {
      try {
        const childAudit = await options.readAuditRun(childId);
        hasTerminalAudit = Boolean(childAudit?.events?.some((event) => ["task.completed", "task.failed", "task.cancelled"].includes(String(event.type))));
      } catch {
        hasTerminalAudit = false;
      }
    }
    const terminalStatus = !hasTerminalAudit ? "needs-review" : childResult?.ok === true ? "completed" : "failed";
    const resultDigest = digestAgentRunValue({ resultRef: request.resultRef, terminalStatus, output: childResult?.output });
    await options.persistGraph?.recordNode({ graphRunId: request.graphRunId, nodeId: request.nodeId, status: terminalStatus, nodeCallId: request.nodeCallId, requestDigest: request.requestDigest, executionRunId: childId, executionAttemptId, resultDigest, resultRef: request.resultRef, auditRef, ...(terminalStatus === "completed" ? {} : { errorCode: terminalStatus === "needs-review" ? "CHILD_AUDIT_UNCERTAIN" : "CHILD_DISPATCH_FAILED" }) });
    await append(options, "agent-graph-node-settled", { graphRunId: request.graphRunId, nodeId: request.nodeId, requestDigest: request.requestDigest, resultRef: request.resultRef, terminalStatus, resultDigest, auditRef });
    return {
      graphRunId: request.graphRunId, nodeCallId: request.nodeCallId, principalNamespace: request.principalNamespace,
      graphDigest: request.graphDigest, manifestDigest: request.manifestDigest, requestDigest: request.requestDigest,
      producerNodeId: request.nodeId, resultRef: request.resultRef, resultDigest, terminalStatus, auditRef
    } satisfies AgentDispatchReceipt;
  }});
  let rawReport: AgentRunGraphResult;
  try {
    rawReport = await runner.run({
      graphRunId,
      principalNamespace,
      graph,
      manifests,
      parentCapabilities: options.parentCapabilities,
      maxConcurrency: input.maxConcurrency,
      maxRunMs: input.maxRunMs,
      signal: options.signal
    });
  } catch (error) {
    options.signal?.removeEventListener("abort", fenceCancellation);
    throw error;
  }
  try {
    const fencedReport = (candidate: AgentRunGraphResult): AgentRunGraphResult => cancellationFenced
      ? { ...candidate, status: "needs-review" as const, nodes: candidate.nodes.map((node) => node.status === "needs-review" ? node : { ...node, status: "needs-review" as const, errorCode: node.errorCode ?? "GRAPH_CANCELLATION_UNCERTAIN" }) }
      : candidate;
    let report = fencedReport(rawReport);
    for (const [index] of report.nodes.entries()) {
      if (options.signal?.aborted) fenceCancellation();
      report = fencedReport(report);
      const node = report.nodes[index]!;
      await options.persistGraph?.recordNode({
        graphRunId: report.graphRunId,
        nodeId: node.nodeId,
        status: node.status,
        nodeCallId: node.nodeCallId,
        requestDigest: node.requestDigest,
        resultDigest: node.resultDigest,
        resultRef: node.resultRef,
        auditRef: node.auditRef,
        errorCode: node.errorCode
      });
      if (options.signal?.aborted) fenceCancellation();
    }
    report = fencedReport(report);
    const completion = {
      graphRunId: report.graphRunId,
      graphDigest: report.graphDigest,
      status: report.status,
      nodeCount: report.nodes.length,
      pendingPhysicalDispatches: report.pendingPhysicalDispatches
    } satisfies JsonObject;
    if (options.signal?.aborted) fenceCancellation();
    report = fencedReport(report);
    terminalPublicationStarted = true;
    const publishedStatus = await appendFinalCompletion(options, completion, () => {
      if (options.signal?.aborted) fenceCancellation();
      return cancellationFenced;
    });
    report = fencedReport(report);
    const persistedCompletion = await options.persistGraph?.complete({ graphRunId: report.graphRunId, status: publishedStatus, ...(publishedStatus === "needs-review" ? { errorCode: cancellationFenced ? "GRAPH_CANCELLATION_UNCERTAIN" : "GRAPH_OUTCOME_UNCERTAIN" } : {}) });
    if (persistedCompletion && typeof persistedCompletion === "object" && persistedCompletion.status === "needs-review" && publishedStatus !== "needs-review") {
      const recovery = { ...completion, status: "needs-review", errorCode: "GRAPH_OUTCOME_UNCERTAIN", recovered: true } satisfies JsonObject;
      await options.appendAuditEvent?.({ type: "agent.graph.needs-review", payload: recovery });
      await options.appendEvent?.({ type: "agent-graph-needs-review", payload: recovery });
      report = { ...report, status: "needs-review" };
    }
    return report;
  } catch (error) {
    // Completion publication is a multi-store boundary. If either the signed
    // audit event or the durable graph projection cannot be committed, leave
    // the graph quarantined rather than presenting a false terminal success.
    try {
      await options.persistGraph?.complete({ graphRunId: rawReport.graphRunId, status: "needs-review", errorCode: "GRAPH_TERMINAL_PUBLICATION_UNCERTAIN" });
    } catch {
      // The original publication error remains the actionable failure; a
      // second store failure is itself covered by startup reconciliation.
    }
    const uncertain = { graphRunId: rawReport.graphRunId, status: "needs-review", errorCode: "GRAPH_TERMINAL_PUBLICATION_UNCERTAIN" } satisfies JsonObject;
    try { await options.appendAuditEvent?.({ type: "agent.graph.needs-review", payload: uncertain }); } catch { /* preserve the original publication error */ }
    try { await options.appendEvent?.({ type: "agent-graph-needs-review", payload: uncertain }); } catch { /* preserve the original publication error */ }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", fenceCancellation);
  }
}

type NodeError = Error & { name?: string };
