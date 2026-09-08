import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApprovalStore, createAuditStore, createBuiltInRegistry, createGovernedMcpRuntime, createRunLedger, ExtensionExecutor, ExtensionRegistry, packPluginPackage, PluginLifecycleService, runTask } from "../packages/kernel/src/index.ts";
import { createDefaultPolicy } from "../packages/policy/src/index.ts";

const enabled = process.env.ODINN_RUN_PLUGIN_LIVE_TESTS === "1";
async function cleanFixture(path: string): Promise<void> {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await cleanFixture(join(path, entry.name));
  await rm(path, { recursive: true, force: true });
}

test("installed external plugin performs an approved real service read through OCI and leaves no container or durable response", { skip: !enabled, timeout: 120_000 }, async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "odinn-plugin-live-"));
  const stateDir = join(workspaceRoot, ".odinn");
  const source = join(workspaceRoot, "author");
  await cp(new URL("../examples/plugins/weather-connector/", import.meta.url), source, { recursive: true });
  const manifest = JSON.parse(await readFile(join(source, "plugin.json"), "utf8"));
  if (process.env.ODINN_TEST_EXTENSION_OCI_IMAGE) {
    manifest.containerImage = process.env.ODINN_TEST_EXTENSION_OCI_IMAGE;
    await writeFile(join(source, "plugin.json"), JSON.stringify(manifest));
  }
  const archive = join(workspaceRoot, "weather.odinn-plugin.zip");
  const packed = await packPluginPackage(source, archive);
  const config = { runtime: { enableMcp: true }, sandbox: { backend: { mode: "oci", preference: ["oci"], unavailable: "refuse" }, process: { enabled: true }, network: { mode: "denied" } } };
  const extensionRegistry = new ExtensionRegistry(join(stateDir, "extensions.json"));
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
  const ledger = createRunLedger({ workspaceRoot, stateDir, featureFlags: { capabilities: false } });
  const executor = new ExtensionExecutor(extensionRegistry, { workspaceRoot, config });
  const runtime = createGovernedMcpRuntime({ enabled: true, extensionRegistry, extensionExecutor: executor, auditStore, runLedger: ledger });
  const registry = createBuiltInRegistry({ workspaceRoot, stateDir, config, auditStore, approvalStore, mcpRuntime: runtime });
  const lifecycle = new PluginLifecycleService({ workspaceRoot, stateDir, registry: extensionRegistry, auditStore, config, onInvalidate: (id) => runtime.invalidatePlugin(id) });
  t.after(async () => { await runtime.close(); await registry.close?.(); auditStore.close(); ledger.close(); await cleanFixture(workspaceRoot); });
  let plugin = await lifecycle.install(archive, { expectedDigest: packed.digest });
  plugin = await lifecycle.configure(plugin.manifest.id, { serviceBindings: { "open-meteo": { enabled: true } } }, { expectedIdentityFingerprint: plugin.identityFingerprint });
  plugin = await lifecycle.enable(plugin.manifest.id, { expectedIdentityFingerprint: plugin.identityFingerprint, grants: plugin.requestedCapabilities, trust: true });
  assert.equal(plugin.enabled, true);
  const policy = createDefaultPolicy({ allowedCapabilities: ["mcp.discover", "mcp.invoke", "network.access"] });
  const base = { auditStore, approvalStore, registry, policy, runLedger: ledger };
  const discovered = await runTask({ ...base, task: { id: "plugin-live-discover", actor: "operator", tool: "mcp.discover", input: { serverId: plugin.manifest.id } } });
  assert.equal(discovered.ok, true, JSON.stringify(discovered));
  const snapshot = discovered.output as any;
  const tool = snapshot.tools[0];
  const input = { serverId: plugin.manifest.id, generation: snapshot.generation, snapshotFingerprint: snapshot.fingerprint, extensionFingerprint: snapshot.extensionFingerprint, toolName: tool.name, toolSchemaFingerprint: tool.schemaFingerprint, arguments: { latitude: 40, longitude: -74 } };
  const task = { id: "plugin-live-read", actor: "operator", tool: "mcp.invoke", input };
  const pending = await runTask({ ...base, task, durableExecution: true });
  assert.equal((pending.output as any)?.type, "approval.required", JSON.stringify(pending));
  const approvalId = (pending.output as any).approvalId;
  assert.ok(approvalStore.claim(approvalId));
  const completed = await runTask({ ...base, task, durableExecution: true, trustedApprovalId: approvalId, trustedApprovalRunId: task.id, trustedRecovery: true });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  assert.equal((completed.output as any).status, "completed");
  const text = (completed.output as any).result.content[0].text;
  const weather = JSON.parse(text);
  assert.equal(typeof weather.current.temperature_2m, "number");
  const audit = await auditStore.readRun(task.id);
  assert.ok(audit.events.some((event: any) => event.type === "plugin.service.completed"));
  assert.doesNotMatch(JSON.stringify(audit), /"temperature_2m"/u);
  const settled = audit.events.find((event: any) => event.type === "sandbox.settled") as any;
  assert.equal(settled?.data.cleanupUncertain, false);
  const inspection = spawnSync(`/usr/bin/${settled.data.backend}`, ["container", "inspect", settled.data.containerName], { encoding: "utf8", shell: false, timeout: 10_000 });
  assert.notEqual(inspection.status, 0, "plugin container must have been removed");
  await lifecycle.disable(plugin.manifest.id, { expectedIdentityFingerprint: plugin.identityFingerprint });
  await assert.rejects(() => runtime.discover({ serverId: plugin.manifest.id }), /disabled/u);
  t.diagnostic("Real Open-Meteo response verified through installed package, admission, approval, stdio broker, OCI isolation, audit projection, and cleanup.");
});
