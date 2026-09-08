import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGovernedMcpRuntime } from "../packages/kernel/src/mcp-runtime.ts";
import { createAuditStore, createRunLedger, runTask } from "../packages/kernel/src/index.ts";
import { createDefaultPolicy } from "../packages/policy/src/index.ts";

async function fixture() {
  const manifest = JSON.parse(await readFile(new URL("../examples/plugins/weather-connector/plugin.json", import.meta.url), "utf8"));
  const capabilities = ["mcp.discover", "mcp.invoke", "network.access"];
  const extension = {
    id: manifest.id, version: manifest.version, type: "mcp", enabled: true, trusted: true, sandbox: "container",
    bundleDigest: "b".repeat(64), containerImage: manifest.containerImage, capabilities, grants: capabilities,
    lifecycleRevision: 1, permissions: { plugin: { manifest, serviceBindings: { "open-meteo": { enabled: true } } } }
  };
  const calls: string[] = [];
  const executor = {
    invalidate: async (_id: string) => undefined,
    invoke: async (_id: string, _input: unknown, options: { mcpMethod: string }) => {
      calls.push(options.mcpMethod);
      return options.mcpMethod === "tools/list"
        ? { tools: manifest.tools.map((tool: { name: string; inputSchema: unknown }) => ({ name: tool.name, inputSchema: tool.inputSchema })) }
        : { content: [{ type: "text", text: "private live service response" }] };
    }
  };
  const audit: unknown[] = [];
  const context = {
    request: { id: "plugin-runtime-fixture", actor: "operator" },
    auditStore: { append: async (event: unknown) => { audit.push(event); } },
    runLedger: { stateDir: "/tmp/odinn-plugin-runtime", workspaceRoot: "/tmp/odinn-plugin-runtime", featureFlags: { capabilities: false } },
    effectiveCapabilities: ["mcp.invoke"],
    policy: createDefaultPolicy({ allowedCapabilities: capabilities })
  };
  const runtime = createGovernedMcpRuntime({ enabled: true, config: {}, extensionRegistry: { get: async (id: string) => id === extension.id ? extension : undefined } as any, extensionExecutor: executor as any });
  return { manifest, extension, calls, audit, context, runtime, executor };
}

function pinned(snapshot: any, tool: any) {
  return { serverId: snapshot.serverId, generation: snapshot.generation, snapshotFingerprint: snapshot.fingerprint, extensionFingerprint: snapshot.extensionFingerprint, toolName: tool.name, toolSchemaFingerprint: tool.schemaFingerprint, arguments: { latitude: 40, longitude: -74 } };
}

test("installed plugins discover without a competing config registry and invoke using exact manifest schemas", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const snapshot = await f.runtime.discover({ serverId: f.extension.id }, f.context);
  const result = await f.runtime.invoke(pinned(snapshot, (snapshot.tools as any[])[0]), f.context);
  assert.deepEqual((result.result as any).content, [{ type: "text", text: "private live service response" }]);
  assert.deepEqual(f.calls, ["tools/list", "tools/call"]);
  assert.doesNotMatch(JSON.stringify(f.audit), /private live service response/u);
});

test("changed setup invalidates discovery and old approvals while newly enabled identity can run", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const first = await f.runtime.discover({ serverId: f.extension.id }, f.context);
  f.extension.lifecycleRevision += 1;
  await f.runtime.invalidatePlugin(f.extension.id);
  await assert.rejects(() => f.runtime.invoke(pinned(first, (first.tools as any[])[0]), f.context), /changed since discovery/u);
  const next = await f.runtime.discover({ serverId: f.extension.id }, f.context);
  assert.notEqual(next.extensionFingerprint, first.extensionFingerprint);
  assert.equal((await f.runtime.invoke(pinned(next, (next.tools as any[])[0]), f.context)).status, "completed");
});

test("cross-process setup change refreshes stale cached discovery automatically", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const first = await f.runtime.discover({ serverId: f.extension.id }, f.context);
  f.extension.lifecycleRevision += 1;
  const next = await f.runtime.discover({ serverId: f.extension.id }, f.context);
  assert.notEqual(next.extensionFingerprint, first.extensionFingerprint);
  assert.deepEqual(f.calls, ["tools/list", "tools/list"]);
});

test("plugin policy intersection cannot omit service capabilities", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const snapshot = await f.runtime.discover({ serverId: f.extension.id }, f.context);
  await assert.rejects(() => f.runtime.invoke(pinned(snapshot, (snapshot.tools as any[])[0]), { ...f.context, policy: createDefaultPolicy({ allowedCapabilities: ["mcp.invoke"] }) }));
  assert.deepEqual(f.calls, ["tools/list"]);
});

test("unreviewed discovered tool schemas cannot be advertised as the installed package", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  f.executor.invoke = async () => ({ tools: [{ name: "unreviewed.read", inputSchema: { type: "object" } }] }) as any;
  await assert.rejects(() => f.runtime.discover({ serverId: f.extension.id }, f.context), /discovery transport failed/u);
});

test("scoped MCP service grants work without granting global network access", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const snapshot = await f.runtime.discover({ serverId: f.extension.id }, f.context);
  const policy = createDefaultPolicy({ allowedCapabilities: ["mcp.invoke"], scopedCapabilities: [{ tool: "mcp.invoke", capability: "network.access" }] });
  const result = await f.runtime.invoke(pinned(snapshot, (snapshot.tools as any[])[0]), { ...f.context, policy });
  assert.equal(result.status, "completed");
  assert.equal(policy.allowedCapabilities.includes("network.access"), false);
});

test("a delegated parent ceiling cannot regain a service capability from broader host policy", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const snapshot = await f.runtime.discover({ serverId: f.extension.id }, f.context);
  await assert.rejects(() => f.runtime.invoke(pinned(snapshot, (snapshot.tools as any[])[0]), { ...f.context, parentCapabilities: ["mcp.invoke"] }));
  assert.deepEqual(f.calls, ["tools/list"]);
});

test("nested tool dispatch inherits its parent's capability ceiling and refuses widening", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-plugin-parent-ceiling-"));
  const auditStore = createAuditStore(join(root, "audit.jsonl"));
  const ledger = createRunLedger({ stateDir: root, workspaceRoot: root, featureFlags: { capabilities: false } });
  t.after(async () => { auditStore.close(); ledger.close(); await rm(root, { recursive: true, force: true }); });
  const policy = createDefaultPolicy({ allowedCapabilities: ["workspace.inspect", "network.access"] });
  let widened = false;
  let observed: unknown;
  const registry = new Map<string, any>([
    ["text.echo", { capability: "workspace.inspect", execute: async (_input: unknown, context: any) => context.runTool({ id: widened ? "nested-widened" : "nested-bounded", tool: "workspace.stat", input: {}, ...(widened ? { parentCapabilities: ["workspace.inspect", "network.access"] } : {}) }) }],
    ["workspace.stat", { capability: "workspace.inspect", execute: async (_input: unknown, context: any) => { observed = context.parentCapabilities; return { ok: true }; } }]
  ]);
  const options = { auditStore, runLedger: ledger, policy, registry, parentCapabilities: ["workspace.inspect"] };
  const first = await runTask({ ...options, task: { id: "parent-bounded", actor: "operator", tool: "text.echo", input: {} } });
  assert.equal(first.ok, true);
  assert.deepEqual(observed, ["workspace.inspect"]);
  widened = true;
  observed = undefined;
  await assert.rejects(() => runTask({ ...options, task: { id: "parent-widened", actor: "operator", tool: "text.echo", input: {} } }), /cannot exceed its admitted parent/u);
  assert.equal(observed, undefined);
});
