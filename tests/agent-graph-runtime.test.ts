import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultPolicy } from "../packages/policy/src/index.ts";
import { AGENT_GRAPH_REGISTRY_REF, executeAgentGraph } from "../packages/kernel/src/agent-graph-runtime.ts";
import { createAuditStore, createBuiltInRegistry, runTask } from "../packages/kernel/src/index.ts";
import { projectDurableToolInput, projectDurableToolOutput } from "../packages/protocol/src/index.ts";

const manifest = (requestedTools = ["text.echo"], requestedCapabilities = ["workspace.inspect"]) => ({
  schemaVersion: 1,
  id: "reader",
  revision: 1,
  registryRef: AGENT_GRAPH_REGISTRY_REF,
  requestedTools,
  requestedCapabilities,
  maxChildren: 2,
  defaultTimeoutMs: 5
});

const graph = (manifestDigest: string) => ({
  schemaVersion: 1,
  id: "graph",
  nodes: [{
    id: "first",
    manifestId: "reader",
    manifestDigest,
    inputRef: "input:first",
    resultRef: "result:first",
    dependsOn: []
  }]
});

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

test("live graph dispatch validates capabilities, owns child registry scope, and retains only digests", async () => {
  const manifestInput = manifest();
  const manifestDigest = digest({
    schemaVersion: 1,
    id: manifestInput.id,
    revision: manifestInput.revision,
    registryRef: manifestInput.registryRef,
    requestedTools: [...manifestInput.requestedTools].sort(),
    requestedCapabilities: [...manifestInput.requestedCapabilities].sort(),
    maxChildren: manifestInput.maxChildren,
    defaultTimeoutMs: manifestInput.defaultTimeoutMs
  });
  const calls: any[] = [];
  const events: any[] = [];
  const registry = new Map([
    ["agent.run", { execute: async () => undefined }],
    ["text.echo", { execute: async () => undefined }],
    ["workspace.mutate", { execute: async () => undefined }]
  ]);
  const report = await executeAgentGraph({
    graph: JSON.stringify(graph(manifestDigest)),
    manifests: JSON.stringify([manifestInput]),
    principalNamespace: "operator",
    inputs: { "input:first": { prompt: "PRIVATE_CHILD_PROMPT" } }
  }, {
    registry,
    policy: createDefaultPolicy(),
    parentCapabilities: createDefaultPolicy().allowedCapabilities,
    runId: "outer-job",
    appendEvent: (event) => events.push(event),
    runChild: async (task) => {
      calls.push(task);
      return { ok: true, output: { content: "PRIVATE_CHILD_OUTPUT" } };
    }
  });
  assert.equal(report.status, "completed");
  assert.equal(report.nodes[0]?.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].registry.has("agent.run"), true);
  assert.equal(calls[0].modelRegistry.has("agent.run"), false);
  assert.equal(calls[0].registry.has("workspace.mutate"), false);
  assert.equal(calls[0].input.prompt, "PRIVATE_CHILD_PROMPT");
  assert.deepEqual(events.map((event) => event.type), [
    "agent-graph-validated", "agent-graph-node-dispatch", "agent-graph-node-settled", "agent-graph-completed"
  ]);
  assert.equal(JSON.stringify(events).includes("PRIVATE_CHILD"), false);
});

test("live graph dispatch runs multiple installed agent identities with bounded concurrency", async () => {
  const manifests = ["researcher", "reviewer"].map((agentId, index) => {
    const value = { ...manifest(), id: agentId, revision: index + 1, registryRef: `registry:agent.${agentId}`, defaultTimeoutMs: 1_000 };
    return { ...value, manifestDigest: digest({ ...value, requestedTools: [...value.requestedTools].sort(), requestedCapabilities: [...value.requestedCapabilities].sort() }) };
  });
  const graphInput = {
    schemaVersion: 1,
    id: "multi-agent",
    nodes: manifests.map((item, index) => ({
      id: `node-${index + 1}`, manifestId: item.id, manifestDigest: item.manifestDigest,
      inputRef: `input:${item.id}`, resultRef: `result:${item.id}`, dependsOn: []
    }))
  };
  let active = 0;
  let peak = 0;
  const agentIds: string[] = [];
  const report = await executeAgentGraph({
    graph: JSON.stringify(graphInput), manifests: JSON.stringify(manifests), principalNamespace: "operator",
    inputs: { "input:researcher": { prompt: "research" }, "input:reviewer": { prompt: "review" } }, maxConcurrency: 2
  }, {
    registry: new Map([["agent.run", { execute: async () => undefined }], ["text.echo", { execute: async () => undefined }]]),
    policy: createDefaultPolicy(), parentCapabilities: createDefaultPolicy().allowedCapabilities, runId: "multi-agent-job",
    runChild: async (task: any) => {
      agentIds.push(task.input.agentId);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { ok: true, output: { content: "done" } };
    }
  });
  assert.equal(report.status, "completed");
  assert.deepEqual(agentIds.sort(), ["researcher", "reviewer"]);
  assert.equal(peak, 2);
});

test("graph dispatch rejects capability escalation and unsupported registry claims", async () => {
  const manifestInput = manifest(["web.fetch"], ["network.access"]);
  const normalizedManifest = {
    schemaVersion: 1,
    id: manifestInput.id,
    revision: manifestInput.revision,
    registryRef: manifestInput.registryRef,
    requestedTools: [...manifestInput.requestedTools].sort(),
    requestedCapabilities: [...manifestInput.requestedCapabilities].sort(),
    maxChildren: manifestInput.maxChildren,
    defaultTimeoutMs: manifestInput.defaultTimeoutMs
  };
  const manifestDigest = digest(normalizedManifest);
  const options = {
    registry: new Map([["agent.run", { execute: async () => undefined }], ["web.fetch", { execute: async () => undefined }]]),
    policy: createDefaultPolicy(),
    parentCapabilities: ["workspace.inspect"] as const,
    runId: "outer-job",
    runChild: async () => ({ ok: true })
  };
  await assert.rejects(() => executeAgentGraph({
    graph: JSON.stringify(graph(manifestDigest)), manifests: JSON.stringify([manifestInput]), principalNamespace: "operator", inputs: { "input:first": { prompt: "x" } }
  }, options), /exceeds its parent/u);
  await assert.rejects(() => executeAgentGraph({
    graph: JSON.stringify(graph(manifestDigest)), manifests: JSON.stringify([{ ...manifestInput, registryRef: "registry:other" }]), principalNamespace: "operator", inputs: { "input:first": { prompt: "x" } }
  }, { ...options, parentCapabilities: createDefaultPolicy().allowedCapabilities }), /requires registry:agent-runner.v1/u);
});

test("graph semantic validation completes before durable creation or validated audit", async () => {
  const manifestInput = manifest();
  let createCalls = 0;
  const auditTypes: string[] = [];
  await assert.rejects(() => executeAgentGraph({
    graph: JSON.stringify(graph("a".repeat(64))),
    manifests: JSON.stringify([manifestInput]),
    principalNamespace: "operator",
    inputs: { "input:first": { prompt: "x" } }
  }, {
    registry: new Map([["agent.run", { execute: async () => undefined }], ["text.echo", { execute: async () => undefined }]]),
    policy: createDefaultPolicy(),
    parentCapabilities: createDefaultPolicy().allowedCapabilities,
    runId: "validation-order",
    appendAuditEvent: ({ type }) => { auditTypes.push(type); },
    persistGraph: {
      create: () => { createCalls += 1; },
      startNode: () => undefined,
      recordNode: () => undefined,
      complete: () => undefined
    },
    runChild: async () => ({ ok: true })
  }), /identity does not match/u);
  assert.equal(createCalls, 0);
  assert.deepEqual(auditTypes, []);
});

test("tool-scoped parent grants cannot be widened into child-agent authority", async () => {
  const manifestInput = manifest();
  const manifestDigest = digest({
    schemaVersion: 1,
    id: manifestInput.id,
    revision: manifestInput.revision,
    registryRef: manifestInput.registryRef,
    requestedTools: [...manifestInput.requestedTools].sort(),
    requestedCapabilities: [...manifestInput.requestedCapabilities].sort(),
    maxChildren: manifestInput.maxChildren,
    defaultTimeoutMs: manifestInput.defaultTimeoutMs
  });
  const policy = createDefaultPolicy({
    allowedCapabilities: ["agent.delegate"],
    scopedCapabilities: [{ tool: "text.echo", capability: "workspace.inspect" }]
  });
  await assert.rejects(() => executeAgentGraph({
    graph: JSON.stringify(graph(manifestDigest)),
    manifests: JSON.stringify([manifestInput]),
    principalNamespace: "operator",
    inputs: { "input:first": { prompt: "x" } }
  }, {
    registry: new Map([["agent.run", { execute: async () => undefined }], ["text.echo", { execute: async () => undefined }]]),
    policy,
    parentCapabilities: policy.allowedCapabilities,
    runId: "scoped-parent",
    runChild: async () => ({ ok: true })
  }), /exceeds its parent/u);
});

test("graph execution quarantines a child when terminal audit evidence is unavailable", async () => {
  const manifestInput = manifest();
  const manifestDigest = digest({
    schemaVersion: 1,
    id: manifestInput.id,
    revision: manifestInput.revision,
    registryRef: manifestInput.registryRef,
    requestedTools: [...manifestInput.requestedTools].sort(),
    requestedCapabilities: [...manifestInput.requestedCapabilities].sort(),
    maxChildren: manifestInput.maxChildren,
    defaultTimeoutMs: manifestInput.defaultTimeoutMs
  });
  const persisted: any[] = [];
  const report = await executeAgentGraph({
    graph: JSON.stringify(graph(manifestDigest)),
    manifests: JSON.stringify([manifestInput]),
    principalNamespace: "operator",
    inputs: { "input:first": { prompt: "private" } }
  }, {
    registry: new Map([["agent.run", { execute: async () => undefined }], ["text.echo", { execute: async () => undefined }]]),
    policy: createDefaultPolicy(),
    parentCapabilities: createDefaultPolicy().allowedCapabilities,
    runId: "outer-job",
    readAuditRun: async () => undefined,
    persistGraph: {
      create: () => { persisted.push("create"); },
      startNode: () => { persisted.push("start"); },
      cancel: () => { persisted.push("cancel"); },
      recordNode: (value) => { persisted.push(value.status); },
      complete: (value) => { persisted.push(value.status); }
    },
    runChild: async () => ({ ok: true, output: { content: "private" } })
  });
  assert.equal(report.status, "needs-review");
  assert.equal(report.nodes[0]?.status, "needs-review");
  assert.deepEqual(persisted, ["create", "start", "needs-review", "needs-review", "needs-review"]);
});

test("graph completion failure leaves a fenced needs-review projection", async () => {
  const manifestInput = manifest();
  const manifestDigest = digest({
    schemaVersion: 1,
    id: manifestInput.id,
    revision: manifestInput.revision,
    registryRef: manifestInput.registryRef,
    requestedTools: [...manifestInput.requestedTools].sort(),
    requestedCapabilities: [...manifestInput.requestedCapabilities].sort(),
    maxChildren: manifestInput.maxChildren,
    defaultTimeoutMs: manifestInput.defaultTimeoutMs
  });
  const persisted: string[] = [];
  const events: string[] = [];
  await assert.rejects(() => executeAgentGraph({
    graph: JSON.stringify(graph(manifestDigest)),
    manifests: JSON.stringify([manifestInput]),
    principalNamespace: "operator",
    inputs: { "input:first": { prompt: "x" } }
  }, {
    registry: new Map([["agent.run", { execute: async () => undefined }], ["text.echo", { execute: async () => undefined }]]),
    policy: createDefaultPolicy(),
    parentCapabilities: createDefaultPolicy().allowedCapabilities,
    runId: "publication-failure",
    appendAuditEvent: ({ type }) => {
      if (type === "agent.graph.completed") throw new Error("audit publication failed");
    },
    appendEvent: ({ type }) => { events.push(type); },
    persistGraph: {
      create: () => { persisted.push("create"); },
      startNode: () => { persisted.push("start"); },
      beginCompletion: () => { persisted.push("publishing"); },
      recordNode: (value) => { persisted.push(value.status); },
      complete: (value) => { persisted.push(value.status); }
    },
    runChild: async () => ({ ok: true, output: { content: "private" } })
  }), /audit publication failed/u);
  assert.equal(events.includes("agent-graph-completed"), false);
  assert.equal(persisted.includes("publishing"), true);
  assert.equal(persisted.at(-1), "needs-review");
});

test("durable completion downgrade publishes matching recovery evidence", async () => {
  const manifestInput = manifest();
  const manifestDigest = digest({
    schemaVersion: 1,
    id: manifestInput.id,
    revision: manifestInput.revision,
    registryRef: manifestInput.registryRef,
    requestedTools: [...manifestInput.requestedTools].sort(),
    requestedCapabilities: [...manifestInput.requestedCapabilities].sort(),
    maxChildren: manifestInput.maxChildren,
    defaultTimeoutMs: manifestInput.defaultTimeoutMs
  });
  const auditTypes: string[] = [];
  const ledgerTypes: string[] = [];
  const report = await executeAgentGraph({
    graph: JSON.stringify(graph(manifestDigest)),
    manifests: JSON.stringify([manifestInput]),
    principalNamespace: "operator",
    inputs: { "input:first": { prompt: "x" } }
  }, {
    registry: new Map([["agent.run", { execute: async () => undefined }], ["text.echo", { execute: async () => undefined }]]),
    policy: createDefaultPolicy(),
    parentCapabilities: createDefaultPolicy().allowedCapabilities,
    runId: "completion-downgrade",
    appendAuditEvent: ({ type }) => { auditTypes.push(type); },
    appendEvent: ({ type }) => { ledgerTypes.push(type); },
    persistGraph: {
      create: () => undefined,
      startNode: () => undefined,
      recordNode: () => undefined,
      complete: () => ({ status: "needs-review" as const })
    },
    runChild: async () => ({ ok: true, output: { content: "private" } })
  });
  assert.equal(report.status, "needs-review");
  assert.deepEqual(auditTypes.slice(-2), ["agent.graph.completed", "agent.graph.needs-review"]);
  assert.deepEqual(ledgerTypes.slice(-2), ["agent-graph-completed", "agent-graph-needs-review"]);
});

test("cancellation fences a late child completion", async () => {
  const manifestInput = manifest();
  const manifestDigest = digest({
    schemaVersion: 1,
    id: manifestInput.id,
    revision: manifestInput.revision,
    registryRef: manifestInput.registryRef,
    requestedTools: [...manifestInput.requestedTools].sort(),
    requestedCapabilities: [...manifestInput.requestedCapabilities].sort(),
    maxChildren: manifestInput.maxChildren,
    defaultTimeoutMs: manifestInput.defaultTimeoutMs
  });
  const controller = new AbortController();
  let nodeStatus = "running";
  let releaseChild!: () => void;
  const childReleased = new Promise<void>((resolve) => { releaseChild = resolve; });
  const persisted: string[] = [];
  const auditTypes: string[] = [];
  const reportPromise = executeAgentGraph({
    graph: JSON.stringify(graph(manifestDigest)),
    manifests: JSON.stringify([manifestInput]),
    principalNamespace: "operator",
    inputs: { "input:first": { prompt: "x" } }
  }, {
    registry: new Map([["agent.run", { execute: async () => undefined }], ["text.echo", { execute: async () => undefined }]]),
    policy: createDefaultPolicy(),
    parentCapabilities: createDefaultPolicy().allowedCapabilities,
    runId: "cancellation-fence",
    appendAuditEvent: ({ type }) => { auditTypes.push(type); },
    persistGraph: {
      create: () => undefined,
      startNode: () => { nodeStatus = "running"; },
      cancel: () => { nodeStatus = "needs-review"; persisted.push("cancel"); },
      recordNode: (value) => { if (nodeStatus !== "needs-review") { nodeStatus = value.status; persisted.push(value.status); } },
      complete: (value) => { persisted.push(value.status); }
    },
    runChild: async () => {
      await childReleased;
      return { ok: true, output: { content: "late" } };
    },
    signal: controller.signal
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  releaseChild();
  const report = await reportPromise;
  assert.equal(report.status, "needs-review");
  assert.equal(nodeStatus, "needs-review");
  assert.equal(persisted.includes("completed"), false);
  assert.equal(auditTypes.includes("agent.graph.completed"), false);
  assert.equal(auditTypes.includes("agent.graph.needs-review"), true);
});

test("cancellation during final graph projection fences completion publication", async () => {
  const manifestInput = manifest();
  const manifestDigest = digest({
    schemaVersion: 1,
    id: manifestInput.id,
    revision: manifestInput.revision,
    registryRef: manifestInput.registryRef,
    requestedTools: [...manifestInput.requestedTools].sort(),
    requestedCapabilities: [...manifestInput.requestedCapabilities].sort(),
    maxChildren: manifestInput.maxChildren,
    defaultTimeoutMs: manifestInput.defaultTimeoutMs
  });
  const controller = new AbortController();
  const auditTypes: string[] = [];
  let recordCalls = 0;
  let fenced = false;
  const report = await executeAgentGraph({
    graph: JSON.stringify(graph(manifestDigest)),
    manifests: JSON.stringify([manifestInput]),
    principalNamespace: "operator",
    inputs: { "input:first": { prompt: "x" } }
  }, {
    registry: new Map([["agent.run", { execute: async () => undefined }], ["text.echo", { execute: async () => undefined }]]),
    policy: createDefaultPolicy(),
    parentCapabilities: createDefaultPolicy().allowedCapabilities,
    runId: "cancellation-during-publication",
    appendAuditEvent: ({ type }) => { auditTypes.push(type); },
    persistGraph: {
      create: () => undefined,
      startNode: () => undefined,
      cancel: () => { fenced = true; },
      recordNode: () => {
        recordCalls += 1;
        if (recordCalls === 2) controller.abort();
      },
      complete: () => undefined
    },
    runChild: async () => ({ ok: true, output: { content: "complete" } }),
    signal: controller.signal
  });
  assert.equal(fenced, true);
  assert.equal(report.status, "needs-review");
  assert.equal(auditTypes.includes("agent.graph.completed"), false);
  assert.equal(auditTypes.includes("agent.graph.needs-review"), true);
});

test("cancellation after terminal publication begins cannot split the graph outcome", async () => {
  const manifestInput = manifest();
  const manifestDigest = digest({
    schemaVersion: 1,
    id: manifestInput.id,
    revision: manifestInput.revision,
    registryRef: manifestInput.registryRef,
    requestedTools: [...manifestInput.requestedTools].sort(),
    requestedCapabilities: [...manifestInput.requestedCapabilities].sort(),
    maxChildren: manifestInput.maxChildren,
    defaultTimeoutMs: manifestInput.defaultTimeoutMs
  });
  const controller = new AbortController();
  const auditTypes: string[] = [];
  const ledgerTypes: string[] = [];
  const report = await executeAgentGraph({
    graph: JSON.stringify(graph(manifestDigest)),
    manifests: JSON.stringify([manifestInput]),
    principalNamespace: "operator",
    inputs: { "input:first": { prompt: "x" } }
  }, {
    registry: new Map([["agent.run", { execute: async () => undefined }], ["text.echo", { execute: async () => undefined }]]),
    policy: createDefaultPolicy(),
    parentCapabilities: createDefaultPolicy().allowedCapabilities,
    runId: "cancellation-after-publication-start",
    appendAuditEvent: ({ type }) => {
      auditTypes.push(type);
      if (type === "agent.graph.completed") controller.abort();
    },
    appendEvent: ({ type }) => { ledgerTypes.push(type); },
    persistGraph: {
      create: () => undefined,
      startNode: () => undefined,
      recordNode: () => undefined,
      complete: () => undefined
    },
    runChild: async () => ({ ok: true, output: { content: "complete" } }),
    signal: controller.signal
  });
  assert.equal(report.status, "completed");
  assert.equal(auditTypes.includes("agent.graph.completed"), true);
  assert.equal(auditTypes.includes("agent.graph.needs-review"), false);
  assert.equal(ledgerTypes.includes("agent-graph-completed"), true);
  assert.equal(ledgerTypes.includes("agent-graph-needs-review"), false);
});

test("node-start audit failure settles the durable node as needs-review", async () => {
  const manifestInput = manifest();
  const manifestDigest = digest({
    schemaVersion: 1,
    id: manifestInput.id,
    revision: manifestInput.revision,
    registryRef: manifestInput.registryRef,
    requestedTools: [...manifestInput.requestedTools].sort(),
    requestedCapabilities: [...manifestInput.requestedCapabilities].sort(),
    maxChildren: manifestInput.maxChildren,
    defaultTimeoutMs: manifestInput.defaultTimeoutMs
  });
  let childCalled = false;
  const nodeStatuses: string[] = [];
  const report = await executeAgentGraph({
    graph: JSON.stringify(graph(manifestDigest)),
    manifests: JSON.stringify([manifestInput]),
    principalNamespace: "operator",
    inputs: { "input:first": { prompt: "x" } }
  }, {
    registry: new Map([["agent.run", { execute: async () => undefined }], ["text.echo", { execute: async () => undefined }]]),
    policy: createDefaultPolicy(),
    parentCapabilities: createDefaultPolicy().allowedCapabilities,
    runId: "node-start-audit-failure",
    appendAuditEvent: ({ type }) => {
      if (type === "agent.graph.node.started") throw new Error("node-start audit unavailable");
    },
    persistGraph: {
      create: () => undefined,
      startNode: () => undefined,
      recordNode: (value) => { nodeStatuses.push(value.status); },
      complete: () => undefined
    },
    runChild: async () => {
      childCalled = true;
      return { ok: true };
    }
  });
  assert.equal(childCalled, false);
  assert.equal(report.status, "needs-review");
  assert.ok(nodeStatuses.includes("needs-review"));
  assert.equal(nodeStatuses.includes("running"), false);
});

test("node-start persistence failure synchronously quarantines queued work", async () => {
  const manifestInput = manifest();
  const manifestDigest = digest({
    schemaVersion: 1,
    id: manifestInput.id,
    revision: manifestInput.revision,
    registryRef: manifestInput.registryRef,
    requestedTools: [...manifestInput.requestedTools].sort(),
    requestedCapabilities: [...manifestInput.requestedCapabilities].sort(),
    maxChildren: manifestInput.maxChildren,
    defaultTimeoutMs: manifestInput.defaultTimeoutMs
  });
  let quarantined = false;
  let childCalled = false;
  const report = await executeAgentGraph({
    graph: JSON.stringify(graph(manifestDigest)),
    manifests: JSON.stringify([manifestInput]),
    principalNamespace: "operator",
    inputs: { "input:first": { prompt: "x" } }
  }, {
    registry: new Map([["agent.run", { execute: async () => undefined }], ["text.echo", { execute: async () => undefined }]]),
    policy: createDefaultPolicy(),
    parentCapabilities: createDefaultPolicy().allowedCapabilities,
    runId: "node-start-persistence-failure",
    persistGraph: {
      create: () => undefined,
      startNode: () => { throw new Error("graph state unavailable"); },
      cancel: () => { quarantined = true; },
      recordNode: () => undefined,
      complete: () => undefined
    },
    runChild: async () => {
      childCalled = true;
      return { ok: true };
    }
  });
  assert.equal(childCalled, false);
  assert.equal(quarantined, true);
  assert.equal(report.status, "needs-review");
});

test("failed graphs publish failed terminal events and bind delegated input digests", async () => {
  const manifestInput = manifest();
  const manifestDigest = digest({
    schemaVersion: 1,
    id: manifestInput.id,
    revision: manifestInput.revision,
    registryRef: manifestInput.registryRef,
    requestedTools: [...manifestInput.requestedTools].sort(),
    requestedCapabilities: [...manifestInput.requestedCapabilities].sort(),
    maxChildren: manifestInput.maxChildren,
    defaultTimeoutMs: manifestInput.defaultTimeoutMs
  });
  const requests: string[] = [];
  const auditTypes: string[] = [];
  const ledgerTypes: string[] = [];
  const options = {
    registry: new Map([["agent.run", { execute: async () => undefined }], ["text.echo", { execute: async () => undefined }]]),
    policy: createDefaultPolicy(),
    parentCapabilities: createDefaultPolicy().allowedCapabilities,
    runId: "graph-input-binding",
    appendAuditEvent: ({ type }: { type: string }) => { auditTypes.push(type); },
    appendEvent: ({ type }: { type: string }) => { ledgerTypes.push(type); },
    persistGraph: {
      create: (value: { requestDigest: string }) => { requests.push(value.requestDigest); },
      startNode: () => undefined,
      recordNode: () => undefined,
      complete: () => undefined
    },
    runChild: async () => ({ ok: false, output: {} })
  };
  const base = { graph: JSON.stringify(graph(manifestDigest)), manifests: JSON.stringify([manifestInput]), principalNamespace: "operator" };
  const first = await executeAgentGraph({ ...base, inputs: { "input:first": { prompt: "first" } } }, options);
  const second = await executeAgentGraph({ ...base, inputs: { "input:first": { prompt: "second" } } }, options);
  assert.equal(first.status, "failed");
  assert.equal(second.status, "failed");
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0], requests[1]);
  assert.equal(auditTypes.filter((type) => type === "agent.graph.failed").length, 2);
  assert.equal(auditTypes.includes("agent.graph.completed"), false);
  assert.equal(ledgerTypes.filter((type) => type === "agent-graph-failed").length, 2);
  assert.equal(ledgerTypes.includes("agent-graph-completed"), false);
});

test("graph execution is refused outside the durable jobs boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-agent-graph-direct-"));
  const auditStore = createAuditStore(join(root, ".odinn", "audit.jsonl"));
  const disabledRegistry = createBuiltInRegistry({ workspaceRoot: root, stateDir: join(root, ".odinn"), auditStore });
  await assert.rejects(() => runTask({
    task: { id: "graph-disabled", tool: "agent.delegate", actor: "test", input: {} }, auditStore, registry: disabledRegistry
  }), /agent graph execution is disabled/u);
  disabledRegistry.close();
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir: join(root, ".odinn"), auditStore, config: { runtime: { enableAgentGraphs: true } } });
  await assert.rejects(() => runTask({
    task: { id: "graph-direct", tool: "agent.delegate", actor: "test", input: {} }, auditStore, registry
  }), /durable \/jobs execution surface/u);
  registry.close();
  auditStore.close();
});

test("graph and child-agent projections never persist prompts or model output", () => {
  const input = projectDurableToolInput("agent.delegate", {
    graph: "PRIVATE_INVALID_GRAPH_DOCUMENT",
    manifests: "PRIVATE_INVALID_MANIFEST_DOCUMENT",
    principalNamespace: "operator",
    inputs: { "input:first": { prompt: "PRIVATE_GRAPH_PROMPT" } }
  }) as any;
  assert.equal(input.graph, undefined);
  assert.equal(input.manifests, undefined);
  assert.match(input.graphInputDigest, /^sha256:/u);
  assert.match(input.manifestsInputDigest, /^sha256:/u);
  assert.equal(input.graphInputBytes, Buffer.byteLength("PRIVATE_INVALID_GRAPH_DOCUMENT", "utf8"));
  assert.equal(input.manifestsInputBytes, Buffer.byteLength("PRIVATE_INVALID_MANIFEST_DOCUMENT", "utf8"));
  assert.equal(input.inputs["input:first"].prompt, undefined);
  assert.match(input.inputs["input:first"].promptDigest, /^sha256:/u);
  assert.doesNotMatch(JSON.stringify(input), /PRIVATE_INVALID_GRAPH_DOCUMENT|PRIVATE_INVALID_MANIFEST_DOCUMENT|PRIVATE_GRAPH_PROMPT/u);
  const output = projectDurableToolOutput("agent.run", { content: "PRIVATE_GRAPH_OUTPUT", provider: "test", model: "model" }) as any;
  assert.equal(output.content, undefined);
  assert.match(output.contentDigest, /^sha256:/u);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE_GRAPH_OUTPUT/u);
});

test("malformed agent metadata is reduced to safe markers before durable persistence", () => {
  const input = projectDurableToolInput("agent.delegate", {
    model: { secret: "PRIVATE_MODEL_METADATA" },
    principalNamespace: { secret: "PRIVATE_PRINCIPAL_METADATA" },
    maxRunMs: { secret: "PRIVATE_LIMIT_METADATA" },
    messages: [{ role: { secret: "PRIVATE_ROLE_METADATA" }, content: { secret: "PRIVATE_CONTENT_METADATA" } }],
    inputs: {
      "PRIVATE_INPUT_REFERENCE": { prompt: "PRIVATE_NESTED_PROMPT" },
      "input:safe": { prompt: "safe" }
    }
  }) as any;
  const serialized = JSON.stringify(input);
  assert.doesNotMatch(serialized, /PRIVATE_MODEL_METADATA|PRIVATE_PRINCIPAL_METADATA|PRIVATE_LIMIT_METADATA|PRIVATE_ROLE_METADATA|PRIVATE_CONTENT_METADATA|PRIVATE_INPUT_REFERENCE|PRIVATE_NESTED_PROMPT/u);
  assert.equal(input.model, undefined);
  assert.equal(input.modelInvalid, true);
  assert.equal(input.principalNamespace, undefined);
  assert.equal(input.principalNamespaceInvalid, true);
  assert.equal(input.maxRunMs, undefined);
  assert.equal(input.maxRunMsInvalid, true);
  assert.deepEqual(input.messages, [{ invalid: true }]);
  assert.equal(input.inputsInvalid, true);
  assert.equal(input.inputs["PRIVATE_INPUT_REFERENCE"], undefined);
  assert.match(input.inputs["input:safe"].promptDigest, /^sha256:/u);
});

test("valid graph principals are digest-only across durable projections", () => {
  const input = projectDurableToolInput("agent.delegate", {
    principalNamespace: "operator",
    prompt: "PRIVATE_GRAPH_PROMPT"
  }) as any;
  const output = projectDurableToolOutput("agent.delegate", {
    graphRunId: "graph:run",
    principalNamespace: "operator",
    graphDigest: "a".repeat(64),
    status: "completed",
    nodes: []
  }) as any;
  assert.match(input.principalNamespace, /^sha256:[a-f0-9]{64}$/u);
  assert.match(output.principalNamespace, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify({ input, output }), /operator/u);
});

test("live child dispatch keeps principals digest-only", async () => {
  const manifestInput = manifest();
  const manifestDigest = digest({
    schemaVersion: 1,
    id: manifestInput.id,
    revision: manifestInput.revision,
    registryRef: manifestInput.registryRef,
    requestedTools: [...manifestInput.requestedTools].sort(),
    requestedCapabilities: [...manifestInput.requestedCapabilities].sort(),
    maxChildren: manifestInput.maxChildren,
    defaultTimeoutMs: manifestInput.defaultTimeoutMs
  });
  const executable = { ...manifestInput, manifestDigest };
  const graphInput = {
    graph: JSON.stringify(graph(manifestDigest)),
    manifests: JSON.stringify([executable]),
    principalNamespace: "PRIVATE_LIVE_PRINCIPAL",
    inputs: { "input:first": { prompt: "safe" } }
  } as any;
  const dispatches: any[] = [];
  const report = await executeAgentGraph(graphInput, {
    registry: new Map([
      ["agent.run", { execute: async () => undefined }],
      ["text.echo", { execute: async () => undefined }]
    ]),
    policy: createDefaultPolicy(),
    parentCapabilities: ["agent.delegate", "network.access", "workspace.inspect"],
    runId: "parent-live-principal",
    runChild: async (task: any) => {
      dispatches.push(task);
      return { ok: true, output: { text: "done" } };
    },
    appendAuditEvent: async () => undefined,
    readAuditRun: async () => ({ events: [{ type: "task.completed" }] })
  });
  const serialized = JSON.stringify({ report, dispatches });
  assert.doesNotMatch(serialized, /PRIVATE_LIVE_PRINCIPAL/u);
  assert.match(report.principalNamespace, /^sha256:[a-f0-9]{64}$/u);
  assert.match(dispatches[0].actor, /^child-agent:sha256:[a-f0-9]{64}$/u);
  assert.equal(dispatches[0].actor.includes("PRIVATE_LIVE_PRINCIPAL"), false);
});
