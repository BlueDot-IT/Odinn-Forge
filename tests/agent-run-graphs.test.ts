import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  AgentRunGraphRunner,
  validateAgentRunGraph,
  validateExecutableAgentManifest,
  validateExecutableAgentManifestCollection
} from "../packages/kernel/src/agent-run-graphs.ts";

const manifestInput = (maxChildren = 4) => ({
  schemaVersion: 1, id: "worker", revision: 1, registryRef: "registry:worker",
  requestedTools: ["memory.recall"], requestedCapabilities: ["workspace.inspect"],
  maxChildren, defaultTimeoutMs: 30
});
const validateManifest = (input: unknown) => validateExecutableAgentManifest(JSON.stringify(input));
const validateGraph = (input: unknown) => validateAgentRunGraph(JSON.stringify(input));
const manifest = validateManifest(manifestInput());
const manifests = validateExecutableAgentManifestCollection(JSON.stringify([manifest]));
const node = (id: string, dependsOn: string[] = [], resultRef = `result:${id}`) => ({
  id, manifestId: "worker", manifestDigest: manifest.manifestDigest,
  inputRef: `input:${id}`, resultRef, dependsOn
});
const graphInput = { schemaVersion: 1, id: "graph", nodes: [node("a"), node("b", ["a"]), node("c", ["a"])] };

function receipt(request: any, terminalStatus = "completed") {
  return {
    graphRunId: request.graphRunId, nodeCallId: request.nodeCallId,
    principalNamespace: request.principalNamespace, graphDigest: request.graphDigest,
    manifestDigest: request.manifestDigest, requestDigest: request.requestDigest,
    producerNodeId: request.nodeId, resultRef: request.resultRef,
    resultDigest: "a".repeat(64), terminalStatus, auditRef: `audit:${request.nodeId}`
  };
}

const runInput = (graph: unknown = graphInput) => ({
  graphRunId: "run-1", principalNamespace: "principal-1", graph: validateGraph(graph),
  manifests, parentCapabilities: ["workspace.inspect"], maxConcurrency: 2, maxRunMs: 100
});

test("manifest and graph identities are strict, canonical, and privacy bounded", () => {
  assert.equal(validateManifest(manifest).manifestDigest, manifest.manifestDigest);
  assert.throws(() => validateManifest({ ...manifestInput(), registryRef: "registry:auth-token" }), /forbidden/u);
  assert.throws(() => validateManifest({ ...manifestInput(), command: "sh" }), /unknown field/u);
  assert.throws(() => validateGraph({ ...graphInput, nodes: [node("a"), node("b", [], "result:a")] }), /duplicate resultRefs/u);
  assert.throws(() => validateGraph({ ...graphInput, nodes: [node("a", ["b"]), node("b", ["a"])] }), /cycle/u);
  for (const forbidden of ["input:auth-token", "result:secret", "approval:item", "credential:item"]) {
    assert.throws(() => validateGraph({ ...graphInput, nodes: [{ ...node("a"), inputRef: forbidden }] }), /forbidden reference namespace/u);
  }
  assert.throws(() => validateGraph({ ...graphInput, excess1: 1, excess2: 2, excess3: 3, excess4: 4, excess5: 5, excess6: 6, excess7: 7, excess8: 8, excess9: 9, excess10: 10, excess11: 11, excess12: 12, excess13: 13, excess14: 14 }), /exceeds 16 own fields/u);
});

test("audited receipts are content-bound and mismatches become needs-review", async () => {
  for (const field of ["graphRunId", "nodeCallId", "principalNamespace", "graphDigest", "manifestDigest", "requestDigest", "producerNodeId", "resultRef"] as const) {
    const runner = new AgentRunGraphRunner({ dispatch: async (request) => ({ ...receipt(request), [field]: "forged" }) });
    const result = await runner.run(runInput({ ...graphInput, nodes: [node("a")] }));
    assert.equal(result.nodes[0].status, "needs-review", field);
  }
  const runner = new AgentRunGraphRunner({ dispatch: async (request) => ({ ...receipt(request), auditRef: "audit:secret-token" }) });
  const report = await runner.run(runInput({ ...graphInput, nodes: [node("a")] }));
  assert.equal(report.nodes[0].status, "needs-review");
});

test("child manifests cannot exceed parent or trusted tool authority", async () => {
  const runner = new AgentRunGraphRunner({ dispatch: async (request) => receipt(request) });
  await assert.rejects(() => runner.run({ ...runInput(), parentCapabilities: [] }), /exceeds its parent or trusted tool declarations/u);
  const widened = validateExecutableAgentManifestCollection(JSON.stringify([{ ...manifestInput(), requestedCapabilities: ["workspace.inspect", "network.access"] }]));
  const widenedManifest = widened[0]!;
  const widenedGraph = validateGraph({
    schemaVersion: 1,
    id: "widened",
    nodes: [{ ...node("a"), manifestDigest: widenedManifest.manifestDigest }]
  });
  await assert.rejects(() => runner.run({
    ...runInput(),
    graphRunId: "run-widened",
    graph: widenedGraph,
    manifests: widened,
    parentCapabilities: ["workspace.inspect", "network.access"]
  }), /exceeds its parent or trusted tool declarations/u);
});

test("immutable reports preserve bounded correlation evidence and status precedence", async () => {
  const graph = { ...graphInput, id: "mixed", nodes: [node("a"), node("b"), node("c")] };
  const runner = new AgentRunGraphRunner({ dispatch: async (request) => receipt(request,
    request.nodeId === "a" ? "failed" : request.nodeId === "b" ? "cancelled" : "needs-review") });
  const report = await runner.run(runInput(graph));
  assert.equal(report.status, "needs-review");
  assert.equal(report.graphRunId, "run-1");
  assert.equal(report.principalNamespace, "principal-1");
  assert.equal(Object.isFrozen(report), true);
  for (const item of report.nodes) {
    assert.match(item.nodeCallId!, /^call:/u);
    assert.match(item.requestDigest!, /^[a-f0-9]{64}$/u);
    assert.match(item.resultDigest!, /^[a-f0-9]{64}$/u);
    assert.match(item.auditRef!, /^audit:/u);
    assert.equal("content" in item, false);
  }
  const failedRunner = new AgentRunGraphRunner({ dispatch: async (request) => receipt(request, request.nodeId === "a" ? "failed" : "cancelled") });
  assert.equal((await failedRunner.run(runInput({ ...graph, nodes: [node("a"), node("b")] }))).status, "failed");
  await assert.rejects(() => new AgentRunGraphRunner({ dispatch: async (request) => receipt(request) })
    .run({ ...runInput(), principalNamespace: "auth-principal" }), /forbidden authority/u);
});

test("fixed sorted batches do not partially refill", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const graph = { ...graphInput, id: "waves", nodes: [node("a"), node("b"), node("c"), node("d")] };
  const runner = new AgentRunGraphRunner({ dispatch: async (request) => {
    calls.push(request.nodeId);
    if (request.nodeId === "b") await held;
    return receipt(request);
  } });
  const running = runner.run({ ...runInput(graph), maxConcurrency: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["a", "b"]);
  release();
  await running;
  assert.deepEqual(calls, ["a", "b", "c", "d"]);
});

test("physical ownership survives logical timeout and blocks overlapping runs until late settlement", async () => {
  let release!: (value: any) => void;
  const held = new Promise<any>((resolve) => { release = resolve; });
  let captured: any;
  const runner = new AgentRunGraphRunner({ maxPhysicalSlots: 1, dispatch: async (request) => { captured = request; return held; } });
  const result = await runner.run({ ...runInput({ ...graphInput, nodes: [{ ...node("a"), timeoutMs: 5 }] }), maxConcurrency: 1 });
  assert.equal(result.nodes[0].status, "needs-review");
  assert.equal(result.pendingPhysicalDispatches, 1);
  await assert.rejects(() => runner.run({ ...runInput(), graphRunId: "run-2" }), /unresolved physical/u);
  release(receipt(captured));
  await new Promise((resolve) => setImmediate(resolve));
  const shutdown = await runner.shutdown(5);
  assert.deepEqual(shutdown.unresolvedNodeCallIds, []);
  await assert.rejects(() => runner.run({ ...runInput(), graphRunId: "run-3" }), /stopped/u);
});

test("pre-dispatch cancellation is cancelled while post-dispatch uncertainty needs review", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const runner = new AgentRunGraphRunner({ dispatch: async (request) => { calls += 1; return receipt(request); } });
  const result = await runner.run({ ...runInput({ ...graphInput, nodes: [node("a")] }), signal: controller.signal });
  assert.equal(calls, 0);
  assert.equal(result.nodes[0].status, "cancelled");
});

test("public admission bounds raw bytes before parse and rejects direct object enumeration", () => {
  const hugeObject = Object.fromEntries(Array.from({ length: 250_000 }, (_, index) => [`k${index}`, index]));
  assert.throws(() => validateExecutableAgentManifest(hugeObject as any), /bounded UTF-8 JSON/u);
  assert.throws(() => validateAgentRunGraph({ ...graphInput } as any), /bounded UTF-8 JSON/u);
  const accessor = {};
  Object.defineProperty(accessor, "schemaVersion", { get: () => 1, enumerable: true });
  assert.throws(() => validateExecutableAgentManifest(accessor as any), /bounded UTF-8 JSON/u);
  assert.throws(() => validateExecutableAgentManifest(Object.create({ schemaVersion: 1 }) as any), /bounded UTF-8 JSON/u);
  assert.throws(() => validateExecutableAgentManifest({ [Symbol("schemaVersion")]: 1 } as any), /bounded UTF-8 JSON/u);
  assert.throws(() => validateExecutableAgentManifestCollection(`["${"x".repeat(33_000)}"]`), /wire bytes/u);
  const sparseJson = `[{${JSON.stringify("schemaVersion")}:1},,{}]`;
  assert.throws(() => validateExecutableAgentManifestCollection(sparseJson), /valid JSON/u);
});

test("byte admission uses intrinsic Uint8Array slots and an exact non-shared brand", () => {
  const oversized = new Uint8Array(40_162);
  Object.defineProperty(oversized, "byteLength", { value: 1 });
  assert.throws(() => validateExecutableAgentManifest(oversized), /wire bytes/u);

  const encoded = new TextEncoder().encode(JSON.stringify(manifestInput()));
  Object.defineProperties(encoded, {
    length: { value: 1 },
    buffer: { value: new ArrayBuffer(1) },
    byteOffset: { value: 40_000 },
    byteLength: { value: 1 }
  });
  assert.equal(validateExecutableAgentManifest(encoded).id, "worker");

  class Subclass extends Uint8Array {}
  assert.throws(() => validateExecutableAgentManifest(new Subclass(encoded)), /bounded UTF-8 JSON/u);
  assert.throws(() => validateExecutableAgentManifest(new Proxy(new Uint8Array(encoded), {})), /internal slot/u);
  assert.throws(() => validateExecutableAgentManifest(Object.create(Uint8Array.prototype)), /internal slot/u);

  if (typeof SharedArrayBuffer !== "undefined") {
    assert.throws(() => validateExecutableAgentManifest(new Uint8Array(new SharedArrayBuffer(8))), /shared backing memory/u);
    const mutated = new SharedArrayBuffer(8);
    Object.setPrototypeOf(mutated, null);
    assert.throws(() => validateExecutableAgentManifest(new Uint8Array(mutated)), /shared backing memory/u);
    const crossRealm = runInNewContext("new SharedArrayBuffer(8)") as SharedArrayBuffer;
    assert.throws(() => validateExecutableAgentManifest(new Uint8Array(crossRealm)), /shared backing memory/u);
  }

  const ordinary = new TextEncoder().encode(JSON.stringify(manifestInput()));
  Object.setPrototypeOf(ordinary.buffer, null);
  assert.equal(validateExecutableAgentManifest(ordinary).id, "worker");

  const exact = `"${"x".repeat(32_766)}"`;
  assert.equal(Buffer.byteLength(exact), 32_768);
  assert.throws(() => validateExecutableAgentManifest(exact), /must be an object/u);
  assert.throws(() => validateExecutableAgentManifest(`${exact} `), /wire bytes/u);
});

test("runner accepts only branded snapshots", async () => {
  const runner = new AgentRunGraphRunner({ dispatch: async (request) => receipt(request) });
  await assert.rejects(() => runner.run({ ...runInput(), graph: graphInput as any }), /validated branded snapshot/u);
  await assert.rejects(() => runner.run({ ...runInput(), manifests: [manifest] as any }), /validated branded collection/u);
});

test("package remains demand-loaded and absent from active imports", async () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval",
    "const m=await import('@odinn/kernel/agent-run-graphs');if(!m.AgentRunGraphRunner)process.exit(2)"],
  { cwd: join(process.cwd(), "apps", "cli"), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  for (const file of ["packages/kernel/src/index.ts", "packages/kernel/src/jobs.ts", "apps/gateway/src/server.ts", "apps/cli/src/cli.ts"]) {
    assert.doesNotMatch(await readFile(join(process.cwd(), file), "utf8"), /agent-run-graphs/u);
  }
});
