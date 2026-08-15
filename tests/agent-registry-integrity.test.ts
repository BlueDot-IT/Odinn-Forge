import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AgentRegistryStore,
  ensureMainAgent,
  loadAgent,
  provisionRuntimeAgent,
  validateAgentManifest
} from "../packages/kernel/src/index.ts";
import { AgentPackageStore } from "../apps/gateway/src/server.ts";

test("ordinary agent loading is read-only and leaves startup reconciliation to the caller", async () => {
  const state = join(await mkdtemp(join(tmpdir(), "odinn-agent-load-readonly-")), "state");
  await assert.rejects(() => loadAgent(state), /runtime agent is not installed/u);
  await assert.rejects(() => access(join(state, "agents.json")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("startup reconciliation and lifecycle mutation serialize without restoring a quarantined agent", async () => {
  const state = join(await mkdtemp(join(tmpdir(), "odinn-agent-registry-race-")), "state");
  await ensureMainAgent(state);
  const registry = new AgentRegistryStore(join(state, "agents.json"));
  const secondary = validateAgentManifest({
    sdkVersion: "1.0",
    id: "race-agent",
    version: "1.0.0",
    name: "Race agent",
    kind: "runtime",
    primary: false,
    identity: { files: ["IDENTITY.md"] }
  });
  await registry.mutate((agents) => agents.push({ ...secondary, status: "enabled", installedAt: new Date().toISOString() }));

  const entered = join(state, "ensure-entered");
  const release = join(state, "ensure-release");
  const ensure = ensureMainAgent(state, {
    __testOnlyAfterRegistryRead: async () => {
      await writeFile(entered, "ready");
      while (true) {
        try { await access(release); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
      }
    }
  });
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try { await access(entered); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  await access(entered);

  const quarantine = registry.mutate((agents) => {
    const agent = agents.find((candidate) => candidate.id === "race-agent");
    assert.ok(agent);
    agent.status = "quarantined";
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await writeFile(release, "release");
  await Promise.all([ensure, quarantine]);

  const persisted = JSON.parse(await readFile(join(state, "agents.json"), "utf8"));
  assert.equal(persisted.agents.find((agent: any) => agent.id === "race-agent")?.status, "quarantined");
});

test("runtime-agent install journal rolls back an interrupted replacement", async () => {
  const state = join(await mkdtemp(join(tmpdir(), "odinn-agent-install-recovery-")), "state");
  await ensureMainAgent(state);
  const store = new AgentPackageStore(join(state, "agents.json"));
  const v1 = {
    sdkVersion: "1.0", id: "recover-agent", version: "1.0.0", name: "Recover agent", kind: "runtime", primary: false,
    identity: { files: ["IDENTITY.md"] }, model: { default: "", fallbacks: [] }
  };
  await store.install(v1);
  await store.transition("recover-agent", "enable");
  const priorRecord = (await store.read()).agents.find((agent: any) => agent.id === "recover-agent");
  assert.ok(priorRecord);

  await assert.rejects(() => provisionRuntimeAgent(state, {
    ...v1,
    version: "2.0.0",
    name: "Recover agent v2"
  }, {
    previousRecord: priorRecord,
    __testOnlyAfterPhase: async (phase) => {
      if (phase === "new-installed") throw new Error("simulated process interruption");
    }
  }), /simulated process interruption/u);

  const journalPath = join(state, "agent-install.json");
  await access(journalPath);
  await ensureMainAgent(state);
  await assert.rejects(() => access(journalPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  const restored = await loadAgent(state, "recover-agent");
  assert.equal(restored.manifest.version, "1.0.0");
  assert.equal((await store.read()).agents.find((agent: any) => agent.id === "recover-agent")?.status, "enabled");
});

test("runtime-agent installation publishes a complete directory before the registry record", async () => {
  const state = join(await mkdtemp(join(tmpdir(), "odinn-agent-install-atomic-")), "state");
  await ensureMainAgent(state);
  const store = new AgentPackageStore(join(state, "agents.json"));
  const manifest = {
    sdkVersion: "1.0", id: "atomic-agent", version: "1.0.0", name: "Atomic agent", kind: "runtime", primary: false,
    identity: { files: ["IDENTITY.md", "SOUL.md"] }, model: { default: "", fallbacks: [] }
  };
  const installed = await store.install(manifest);
  assert.equal(installed.status, "disabled");
  await assert.rejects(() => loadAgent(state, "atomic-agent"), /not enabled/u);
  await store.transition("atomic-agent", "enable");
  const loaded = await loadAgent(state, "atomic-agent");
  assert.equal(loaded.manifest.id, "atomic-agent");
  assert.equal(loaded.manifest.version, "1.0.0");
  const persisted = JSON.parse(await readFile(join(state, "agents.json"), "utf8"));
  assert.equal(persisted.agents.find((agent: any) => agent.id === "atomic-agent")?.integrity, loaded.manifest.integrity);
  await assert.rejects(() => access(join(state, "agent-install.json")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});
