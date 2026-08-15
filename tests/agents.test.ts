import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AGENT_BOOTSTRAP_FILE,
  AGENT_IDENTITY_FILES,
  AGENT_SDK_VERSION,
  ensureMainAgent,
  isOwnerOnlyPath,
  loadAgent,
  validateAgentManifest
} from "../packages/kernel/src/index.ts";

test("first setup creates the main agent from the Agent SDK contract", async () => {
  const state = join(await mkdtemp(join(tmpdir(), "odinn-agent-main-")), "state");
  const manifest = await ensureMainAgent(state);

  assert.equal(manifest.sdkVersion, AGENT_SDK_VERSION);
  assert.equal(manifest.id, "main");
  assert.equal(manifest.kind, "runtime");
  assert.equal(manifest.primary, true);
  assert.deepEqual(manifest.identity.files, AGENT_IDENTITY_FILES);
  assert.equal(manifest.model.default, "");

  const registry = JSON.parse(await readFile(join(state, "agents.json"), "utf8"));
  assert.equal(registry.defaultAgentId, "main");
  assert.equal(registry.agents[0].id, "main");
  assert.equal(registry.agents[0].status, "enabled");
  if (process.platform === "win32") assert.equal(await isOwnerOnlyPath(state), true);
  else {
    assert.equal((await stat(join(state, "agents.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(state, "agents", "main"))).mode & 0o777, 0o700);
  }
  for (const file of AGENT_IDENTITY_FILES) {
    await access(join(state, "agents", "main", file));
    if (process.platform !== "win32") assert.equal((await stat(join(state, "agents", "main", file))).mode & 0o777, 0o600);
  }
  assert.equal(await readFile(join(state, "agents", "main", "IDENTITY.md"), "utf8"), "");
  assert.equal(await readFile(join(state, "agents", "main", "SOUL.md"), "utf8"), "");
  await access(join(state, "agents", "main", AGENT_BOOTSTRAP_FILE));
  if (process.platform !== "win32") assert.equal((await stat(join(state, "agents", "main", AGENT_BOOTSTRAP_FILE))).mode & 0o777, 0o600);
});

test("pending bootstrap is loaded before provider-independent identity context", async () => {
  const state = join(await mkdtemp(join(tmpdir(), "odinn-agent-identity-")), "state");
  await ensureMainAgent(state);
  await writeFile(join(state, "agents", "main", "IDENTITY.md"), "# Identity\n\nName: Morrow\n", { mode: 0o600 });

  const loaded = await loadAgent(state);
  assert.equal(loaded.manifest.model.default, "");
  assert.equal(loaded.executionBinding.agentId, "main");
  assert.equal(loaded.executionBinding.agentVersion, loaded.manifest.version);
  for (const digest of [loaded.executionBinding.manifestIntegrity, loaded.executionBinding.identityContentDigest, loaded.executionBinding.resolvedSystemPromptDigest, loaded.executionBinding.modelConfigurationDigest]) {
    assert.match(digest, /^[a-f0-9]{64}$/u);
  }
  assert.equal(Object.isFrozen(loaded.executionBinding), true);
  assert.equal(loaded.bootstrapPending, true);
  assert.ok(loaded.systemPrompt.indexOf("## BOOTSTRAP.md") < loaded.systemPrompt.indexOf("## IDENTITY.md"));
  assert.match(loaded.systemPrompt, /begin a natural identity conversation/i);
  assert.match(loaded.systemPrompt, /Name: Morrow/);
  assert.doesNotMatch(loaded.systemPrompt, /## SOUL\.md/);
});

test("completed bootstrap is not recreated on restart", async () => {
  const state = join(await mkdtemp(join(tmpdir(), "odinn-agent-bootstrap-complete-")), "state");
  await ensureMainAgent(state);
  const bootstrapPath = join(state, "agents", "main", AGENT_BOOTSTRAP_FILE);
  await rm(bootstrapPath);

  await ensureMainAgent(state);
  await assert.rejects(access(bootstrapPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  const loaded = await loadAgent(state);
  assert.equal(loaded.bootstrapPending, false);
  assert.doesNotMatch(loaded.systemPrompt, /## BOOTSTRAP\.md — required first-run identity workflow/);
});

test("Agent SDK validation rejects identity paths that escape the agent directory", () => {
  assert.throws(() => validateAgentManifest({
    id: "unsafe-agent",
    version: "1.0.0",
    identity: { files: ["../SOUL.md"] }
  }), /identity file is unsafe/);
});
