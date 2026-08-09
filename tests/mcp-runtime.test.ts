import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createBuiltInRegistry,
  createAuditStore,
  createApprovalStore,
  createRunLedger,
  createGovernedMcpRuntime,
  CapabilityBroker,
  runTask,
  type McpRuntimeContext
} from "../packages/kernel/src/index.ts";
import { toolSafetyDescriptor } from "../packages/kernel/src/tool-safety.ts";
import { normalizeMcpConfiguration } from "../packages/kernel/src/mcp-runtime.ts";
import { projectDurableToolInput, projectDurableToolOutput } from "../packages/protocol/src/index.ts";
import { createDefaultPolicy } from "../packages/policy/src/index.ts";

const PINNED_IMAGE = `ghcr.io/bluedot-it/odinn-mcp-fixture@sha256:${"a".repeat(64)}`;

function fixtureRuntime({ slowCall = false } = {}) {
  const calls: Array<{ method?: string; input: Record<string, unknown> }> = [];
  const audit: Array<Record<string, unknown>> = [];
  const extension = {
    id: "fixture-mcp",
    type: "mcp",
    enabled: true,
    trusted: true,
    sandbox: "container",
    bundleDigest: "b".repeat(64),
    containerImage: PINNED_IMAGE,
    capabilities: ["mcp.discover", "mcp.invoke"],
    grants: ["mcp.discover", "mcp.invoke"]
  };
  const extensionRegistry = { get: async (id: string) => id === extension.id ? extension : undefined };
  const extensionExecutor = {
    invoke: async (_id: string, input: Record<string, unknown>, options: any) => {
      calls.push({ method: options.mcpMethod, input });
      if (options.mcpMethod === "tools/list") {
        return {
          tools: [{
            name: "echo",
            description: "untrusted fixture description",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string", maxLength: 64 } },
              required: ["text"],
              additionalProperties: false
            }
          }]
        };
      }
      if (slowCall) {
        await options.onDispatchAuthorized?.({ backend: "fixture", profileDigest: "0".repeat(64), controlsAttested: true });
        return new Promise((resolve) => options.signal?.addEventListener("abort", () => setTimeout(() => resolve({ content: [{ type: "text", text: "late fixture result" }] }), 0), { once: true }));
      }
      return { content: [{ type: "text", text: "fixture result" }] };
    }
  };
  const root = "/tmp/odinn-mcp-test-root";
  const runLedger = { stateDir: root, workspaceRoot: root, featureFlags: { capabilities: false } };
  const auditStore = { append: async (event: Record<string, unknown>) => { audit.push(event); } };
  const context: McpRuntimeContext = {
    request: { id: "mcp-run", actor: "test" },
    auditStore,
    runLedger,
    policy: createDefaultPolicy({ allowedCapabilities: ["mcp.discover", "mcp.invoke"] })
  };
  const runtime = createGovernedMcpRuntime({
    enabled: true,
    config: { servers: { fixture: { extensionId: "fixture-mcp", enabled: true, maxConcurrency: 1 } } },
    extensionRegistry: extensionRegistry as any,
    extensionExecutor: extensionExecutor as any,
    auditStore,
    runLedger
  });
  return { runtime, calls, audit, context, extensionRegistry, extensionExecutor, runLedger, auditStore };
}

test("MCP activation is default-inert and configuration rejects undeclared transport authority", () => {
  assert.deepEqual([...normalizeMcpConfiguration(undefined)], []);
  assert.throws(
    () => normalizeMcpConfiguration({ servers: { fixture: { extensionId: "fixture-mcp", endpoint: "https://example.invalid" } } }),
    (error: any) => error.code === "MCP_CONFIG_INVALID"
  );
  assert.equal(toolSafetyDescriptor("mcp.discover", {}).retrySafe, true);
  assert.equal(toolSafetyDescriptor("mcp.invoke", {}).requiresApproval, true);
});

test("governed MCP runtime translates discovery and pinned calls without persisting result content", async (t) => {
  const { runtime, calls, audit, context } = fixtureRuntime();
  t.after(() => runtime.close());

  const snapshot = await runtime.discover({ serverId: "fixture" }, context);
  assert.equal(snapshot.generation, 1);
  assert.equal((snapshot.tools as any[]).length, 1);
  const [tool] = snapshot.tools as any[];
  const result = await runtime.invoke({
    serverId: "fixture",
    generation: snapshot.generation,
    snapshotFingerprint: snapshot.fingerprint,
    extensionFingerprint: snapshot.extensionFingerprint,
    toolName: tool.name,
    toolSchemaFingerprint: tool.schemaFingerprint,
    arguments: { text: "private fixture input" }
  }, context);

  assert.deepEqual((result.result as any).content, [{ type: "text", text: "fixture result" }]);
  assert.deepEqual(calls.map((call) => call.method), ["tools/list", "tools/call"]);
  assert.match(JSON.stringify(audit), /mcp\.discovery\.completed/u);
  assert.doesNotMatch(JSON.stringify(audit), /private fixture input|fixture result/u);

  const durableInput = projectDurableToolInput("mcp.invoke", { serverId: "fixture", arguments: { text: "private fixture input" } }) as Record<string, unknown>;
  const durableOutput = projectDurableToolOutput("mcp.invoke", result) as Record<string, unknown>;
  assert.doesNotMatch(JSON.stringify(durableInput), /private fixture input/u);
  assert.equal("result" in durableOutput, false);
  await assert.rejects(
    () => runtime.invoke({ ...({
      serverId: "fixture",
      generation: snapshot.generation,
      snapshotFingerprint: snapshot.fingerprint,
      extensionFingerprint: snapshot.extensionFingerprint,
      toolName: tool.name,
      toolSchemaFingerprint: "0".repeat(64),
      arguments: { text: "private fixture input" }
    }) }, context),
    /tool\/schema pin does not match/u
  );
});

test("untrusted MCP extensions and disabled activation cannot dispatch", async (t) => {
  const fixture = fixtureRuntime();
  t.after(() => fixture.runtime.close());
  const disabled = createGovernedMcpRuntime({
    enabled: false,
    config: { servers: { fixture: { extensionId: "fixture-mcp", enabled: true } } },
    extensionRegistry: fixture.extensionRegistry as any,
    extensionExecutor: fixture.extensionExecutor as any
  });
  await assert.rejects(() => disabled.discover({ serverId: "fixture" }, fixture.context), (error: any) => error.code === "MCP_DISABLED");
  await disabled.close();

  const untrustedRegistry = {
    get: async () => ({
      id: "fixture-mcp",
      type: "mcp",
      enabled: true,
      trusted: false,
      sandbox: "container",
      bundleDigest: "b".repeat(64),
      containerImage: PINNED_IMAGE,
      capabilities: ["mcp.discover", "mcp.invoke"],
      grants: ["mcp.discover", "mcp.invoke"]
    })
  };
  const untrusted = createGovernedMcpRuntime({
    enabled: true,
    config: { servers: { fixture: { extensionId: "fixture-mcp", enabled: true } } },
    extensionRegistry: untrustedRegistry as any,
    extensionExecutor: fixture.extensionExecutor as any
  });
  t.after(() => untrusted.close());
  await assert.rejects(() => untrusted.discover({ serverId: "fixture" }, fixture.context), (error: any) => error.code === "MCP_EXTENSION_UNTRUSTED");
});

test("built-in MCP tools are absent unless the explicit runtime gate is supplied", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-mcp-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = fixtureRuntime();
  t.after(() => fixture.runtime.close());
  const disabled = createBuiltInRegistry({ workspaceRoot: root, stateDir: join(root, ".odinn"), config: {} });
  assert.equal(disabled.has("mcp.discover"), false);
  disabled.close();
  const enabled = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir: join(root, ".odinn-enabled"),
    config: { runtime: { enableMcp: true } },
    mcpRuntime: fixture.runtime
  });
  try {
    assert.equal(enabled.has("mcp.discover"), true);
    assert.equal(enabled.has("mcp.invoke"), true);
    assert.deepEqual(createDefaultPolicy({ allowedCapabilities: ["mcp.discover", "mcp.invoke"] }).allowedCapabilities, ["mcp.discover", "mcp.invoke"]);
  } finally {
    enabled.close();
  }
});

test("MCP discovery is admitted as an mcp-tool execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-mcp-admission-"));
  const stateDir = join(root, ".odinn");
  const ledger = createRunLedger({ stateDir, workspaceRoot: root });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const fixture = fixtureRuntime();
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir,
    config: { runtime: { enableMcp: true } },
    auditStore,
    mcpRuntime: fixture.runtime
  });
  t.after(() => {
    registry.close();
    auditStore.close();
    ledger.close();
    return Promise.all([fixture.runtime.close(), rm(root, { recursive: true, force: true })]);
  });
  const result = await runTask({
    task: { id: "mcp-discovery-admitted", tool: "mcp.discover", input: { serverId: "fixture" }, actor: "test" },
    auditStore,
    policy: createDefaultPolicy({ allowedCapabilities: ["mcp.discover"] }),
    registry,
    runLedger: ledger
  });
  assert.equal(result.ok, true);
  assert.equal(ledger.getExecutionEnvelope("mcp-discovery-admitted")?.envelope.execution.kind, "mcp-tool");
  assert.deepEqual(ledger.listExecutionAttempts("mcp-discovery-admitted").map((attempt) => attempt.state), ["completed"]);
});

test("approved MCP invocation recovers the exact sealed request and reuses the admitted capability run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-mcp-approval-"));
  const stateDir = join(root, ".odinn");
  const ledger = createRunLedger({ stateDir, workspaceRoot: root, featureFlags: { capabilities: true, capsules: false, counterfactual: false } });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
  const fixture = fixtureRuntime();
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir,
    config: { runtime: { enableMcp: true } },
    auditStore,
    approvalStore,
    mcpRuntime: fixture.runtime
  });
  t.after(() => {
    registry.close();
    auditStore.close();
    ledger.close();
    return Promise.all([fixture.runtime.close(), rm(root, { recursive: true, force: true })]);
  });

  const snapshot = await fixture.runtime.discover({ serverId: "fixture" }, fixture.context);
  const tool = (snapshot.tools as any[])[0];
  const runId = "mcp-approved-round-trip";
  ledger.ensureRun({ runId, objective: "approved MCP round trip" });
  const issued = new CapabilityBroker({ ledger, stateDir, featureFlags: ledger.featureFlags }).issue({ runId, stepId: "approval-step", toolName: "mcp.invoke" });
  const input = {
    serverId: "fixture",
    generation: snapshot.generation,
    snapshotFingerprint: snapshot.fingerprint,
    extensionFingerprint: snapshot.extensionFingerprint,
    toolName: tool.name,
    toolSchemaFingerprint: tool.schemaFingerprint,
    arguments: { text: "sealed MCP argument" },
    capabilityToken: issued.token
  };
  const policy = createDefaultPolicy({ allowedCapabilities: ["mcp.invoke"] });
  const first = await runTask({
    task: { id: runId, tool: "mcp.invoke", input, actor: "test" },
    auditStore,
    approvalStore,
    policy,
    registry,
    runLedger: ledger,
    durableExecution: true
  });
  const approvalId = (first.output as any).approvalId as string;
  assert.ok(approvalId);
  const persisted = await readFile(join(stateDir, "approvals.json"), "utf8");
  assert.doesNotMatch(persisted, /sealed MCP argument|cap_/u);
  assert.equal((approvalStore.list()[0] as any).input.argumentsDigest.length, 64);
  assert.equal("arguments" in ((approvalStore.list()[0] as any).input), false);

  assert.ok(approvalStore.claim(approvalId));
  const recovered = approvalStore.recover(approvalId);
  assert.equal((recovered?.input?.arguments as any).text, "sealed MCP argument");
  const second = await runTask({
    task: { id: runId, tool: "mcp.invoke", input, actor: "test" },
    auditStore,
    approvalStore,
    policy,
    registry,
    runLedger: ledger,
    trustedApprovalId: approvalId,
    trustedApprovalRunId: runId,
    trustedRecovery: true,
    durableExecution: true
  });
  assert.equal(second.ok, true);
  assert.deepEqual((second.output as any).result.content, [{ type: "text", text: "fixture result" }]);
  assert.deepEqual(ledger.listExecutionAttempts(runId).map((attempt) => attempt.state), ["completed"]);
});

test("MCP timeout after dispatch authorization remains needs-review", async (t) => {
  const fixture = fixtureRuntime({ slowCall: true });
  t.after(() => fixture.runtime.close());
  const snapshot = await fixture.runtime.discover({ serverId: "fixture" }, fixture.context);
  const tool = (snapshot.tools as any[])[0];
  const outcome = await fixture.runtime.invoke({
    serverId: "fixture",
    generation: snapshot.generation,
    snapshotFingerprint: snapshot.fingerprint,
    extensionFingerprint: snapshot.extensionFingerprint,
    toolName: tool.name,
    toolSchemaFingerprint: tool.schemaFingerprint,
    arguments: { text: "timeout fixture" },
    timeoutMs: 5
  }, fixture.context);
  assert.equal(outcome.status, "needs-review");
  assert.equal((outcome as any).reason, "timeout");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fixture.runtime.status().servers[0]?.host?.lateSettlements >= 1);
});

test("MCP approvals cannot cross an executable manifest replacement", async (t) => {
  const fixture = fixtureRuntime();
  t.after(() => fixture.runtime.close());
  const snapshot = await fixture.runtime.discover({ serverId: "fixture" }, fixture.context);
  const tool = (snapshot.tools as any[])[0];
  (fixture.extensionRegistry as any).get = async () => ({
    id: "fixture-mcp",
    type: "mcp",
    enabled: true,
    trusted: true,
    sandbox: "container",
    installId: "replacement-install",
    bundleDigest: "c".repeat(64),
    containerImage: `ghcr.io/bluedot-it/odinn-mcp-fixture@sha256:${"d".repeat(64)}`,
    capabilities: ["mcp.discover", "mcp.invoke"],
    grants: ["mcp.discover", "mcp.invoke"]
  });
  await assert.rejects(
    () => fixture.runtime.invoke({
      serverId: "fixture",
      generation: snapshot.generation,
      snapshotFingerprint: snapshot.fingerprint,
      extensionFingerprint: snapshot.extensionFingerprint,
      toolName: tool.name,
      toolSchemaFingerprint: tool.schemaFingerprint,
      arguments: { text: "must not cross replacement" }
    }, fixture.context),
    (error: any) => error.code === "MCP_EXTENSION_CHANGED"
  );
});
