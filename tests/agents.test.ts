import assert from "node:assert/strict";
import { access, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AGENT_IDENTITY_FILES,
  AGENT_SDK_VERSION,
  ensureMainAgent,
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
  assert.equal((await stat(join(state, "agents.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(state, "agents", "main"))).mode & 0o777, 0o700);
  for (const file of AGENT_IDENTITY_FILES) {
    await access(join(state, "agents", "main", file));
    assert.equal((await stat(join(state, "agents", "main", file))).mode & 0o777, 0o600);
  }
});

test("agent identity is local mutable state and is loaded independently of a provider", async () => {
  const state = join(await mkdtemp(join(tmpdir(), "odinn-agent-identity-")), "state");
  await ensureMainAgent(state);
  await writeFile(join(state, "agents", "main", "IDENTITY.md"), "# Identity\n\nName: Morrow\n", { mode: 0o600 });

  const loaded = await loadAgent(state);
  assert.equal(loaded.manifest.model.default, "");
  assert.match(loaded.systemPrompt, /Name: Morrow/);
  assert.match(loaded.systemPrompt, /## SOUL\.md/);
});

test("Agent SDK validation rejects identity paths that escape the agent directory", () => {
  assert.throws(() => validateAgentManifest({
    id: "unsafe-agent",
    version: "1.0.0",
    identity: { files: ["../SOUL.md"] }
  }), /identity file is unsafe/);
});
