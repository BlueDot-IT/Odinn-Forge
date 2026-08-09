import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  CAPABILITY_IDS,
  CAPABILITY_REGISTRY,
  CAPABILITY_REGISTRY_VERSION,
  TOOL_CAPABILITY_REGISTRY,
  createDefaultPolicy,
  evaluateTaskPolicy,
  intersectChildCapabilities
} from "../packages/policy/src/index.ts";
import { createBuiltInRegistry, previewExecutionAdmission } from "../packages/kernel/src/index.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "odinn-gatewatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir: join(root, ".odinn") });
  t.after(() => registry.close());
  return { root, registry };
}

test("capability registry is versioned, immutable, and separates process authorities", () => {
  assert.equal(CAPABILITY_REGISTRY_VERSION, 1);
  assert.equal(Object.isFrozen(CAPABILITY_IDS), true);
  assert.equal(CAPABILITY_REGISTRY.every(Object.isFrozen), true);
  assert.equal(TOOL_CAPABILITY_REGISTRY.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.capabilities)), true);
  assert.deepEqual(CAPABILITY_IDS, [
    "workspace.inspect", "workspace.mutate", "workspace.patch", "process.execute",
    "process.interactive", "process.shell", "network.access", "browser.read",
    "browser.mutate", "agent.delegate", "mcp.discover", "mcp.invoke",
    "skill.catalog", "skill.hydrate", "skill.manage", "event.register", "secret.reference.use", "restore.create", "restore.apply"
  ]);
  const processTool = TOOL_CAPABILITY_REGISTRY.find((entry) => entry.tool === "process.exec");
  assert.deepEqual(processTool?.capabilities, ["process.execute"]);
  assert.equal(processTool?.capabilities.includes("process.shell"), false);
  assert.equal(processTool?.capabilities.includes("process.interactive"), false);
  assert.throws(() => (CAPABILITY_IDS as any).push("hidden.capability"), TypeError);
});

test("every active built-in tool uses its exact trusted capability declaration", async (t) => {
  const { registry } = await fixture(t);
  for (const [name, value] of registry) {
    const expected = TOOL_CAPABILITY_REGISTRY.find((entry) => entry.tool === name);
    assert.ok(expected, `missing trusted declaration for ${name}`);
    assert.deepEqual(value.capabilities, expected.capabilities, name);
    assert.equal(value.capability, expected.capabilities[0], name);
  }
});

test("unknown capability identifiers fail closed", async (t) => {
  const { registry, root } = await fixture(t);
  assert.throws(() => createDefaultPolicy({ allowedCapabilities: ["workspace.inspect", "model.grant"] }), /unknown capability identifier/u);
  assert.throws(() => createDefaultPolicy({ capabilityRegistryVersion: 2 as any }), /unsupported capability registry version/u);
  assert.throws(() => previewExecutionAdmission({
    task: { tool: "text.echo", input: {} },
    policy: createDefaultPolicy(),
    registry,
    workspaceRoot: root,
    skillCapabilities: ["workspace.inspect", "unknown.skill.grant"]
  }), /unknown capability identifier/u);
});

test("workspace policy enforces the runtime ignore-file ceiling without reducing denial capacity", () => {
  const sixteenIgnoreFiles = Array.from({ length: 16 }, (_, index) => `.ignore-${index}`);
  const oneHundredTwentyEightDenials = Array.from({ length: 128 }, (_, index) => `private-${index}/**`);
  const policy = createDefaultPolicy({
    security: { workspace: { ignoreFiles: sixteenIgnoreFiles, deniedPatterns: oneHundredTwentyEightDenials } }
  });
  assert.deepEqual(policy.security.workspace.ignoreFiles, sixteenIgnoreFiles);
  assert.deepEqual(policy.security.workspace.deniedPatterns, oneHundredTwentyEightDenials);
  assert.throws(() => createDefaultPolicy({
    security: { workspace: { ignoreFiles: [...sixteenIgnoreFiles, ".ignore-16"] } }
  }), /ignoreFiles must be an array of at most 16/u);
});

test("legacy grants migrate to exact tool scopes without widening", async (t) => {
  const { registry } = await fixture(t);
  const policy = createDefaultPolicy({ allowedCapabilities: ["web.read"] });
  assert.deepEqual(policy.allowedCapabilities, []);
  assert.equal(policy.capabilityMigration.required, true);
  assert.equal(policy.capabilityMigration.automaticWidening, false);
  assert.deepEqual(policy.scopedCapabilities, [
    { tool: "web.fetch", capability: "network.access" },
    { tool: "web.search", capability: "network.access" }
  ]);
  assert.equal(evaluateTaskPolicy({ policy, request: { tool: "web.search", input: { query: "x" } }, tool: registry.get("web.search") }).allowed, true);
  const model = evaluateTaskPolicy({ policy, request: { tool: "model.chat", input: {} }, tool: registry.get("model.chat") });
  assert.equal(model.allowed, false);
  if (!model.allowed) assert.equal(model.details.code, "CAPABILITY_DENIED");
});

test("versionless capability names that collide with registry v1 remain exact legacy grants", () => {
  const legacy = createDefaultPolicy({ allowedCapabilities: ["browser.read"] });
  assert.deepEqual(legacy.allowedCapabilities, []);
  assert.equal(legacy.capabilityMigration.required, true);
  assert.ok(legacy.scopedCapabilities.some((grant) => grant.tool === "browser.open" && grant.capability === "network.access"));
  const current = createDefaultPolicy({ capabilityRegistryVersion: 1, allowedCapabilities: ["browser.read"] });
  assert.deepEqual(current.allowedCapabilities, ["browser.read"]);
  assert.deepEqual(current.scopedCapabilities, []);
  assert.equal(current.capabilityMigration.required, false);
});

test("Gatewatch preview intersects parent, child, tool, and policy authority without executing", async (t) => {
  const { registry, root } = await fixture(t);
  const preview = previewExecutionAdmission({
    task: { tool: "browser.open", input: { url: "https://example.com" } },
    policy: createDefaultPolicy(),
    registry,
    workspaceRoot: root,
    parentCapabilities: ["browser.read"],
    requestedCapabilities: ["browser.read", "network.access"]
  });
  assert.equal(preview.allowed, false);
  assert.equal(preview.decision, "deny");
  assert.equal(preview.details.code, "CHILD_CAPABILITY_ESCALATION");
  assert.deepEqual(preview.effectiveCapabilities, []);
  assert.equal(preview.executes, false);
  assert.equal(preview.safety.effects.includes("network"), true);
});

test("skill and MCP declarations request authority but never grant it", async (t) => {
  const { registry, root } = await fixture(t);
  const preview = previewExecutionAdmission({
    task: { tool: "model.chat", input: { messages: [] } },
    policy: createDefaultPolicy({ allowedCapabilities: ["workspace.inspect"] }),
    registry,
    workspaceRoot: root,
    skillCapabilities: ["network.access"],
    mcpCapabilities: ["network.access"]
  });
  assert.equal(preview.allowed, false);
  assert.deepEqual(preview.effectiveCapabilities, []);
  assert.deepEqual(preview.declarationRequests.skill, ["network.access"]);
  assert.deepEqual(preview.declarationRequests.mcp, ["network.access"]);
  assert.equal(preview.declarationRequests.grantsAuthority, false);
});

test("child capability intersection rejects escalation and missing tool authority", () => {
  assert.deepEqual(intersectChildCapabilities({
    parentCapabilities: ["workspace.inspect"],
    requestedCapabilities: ["workspace.inspect"],
    requestedTools: ["memory.recall"]
  }), ["workspace.inspect"]);
  assert.throws(() => intersectChildCapabilities({
    parentCapabilities: ["workspace.inspect"],
    requestedCapabilities: ["workspace.inspect", "network.access"],
    requestedTools: ["memory.recall"]
  }), /exceeds its parent or trusted tool declarations/u);
  assert.throws(() => intersectChildCapabilities({
    parentCapabilities: ["workspace.inspect"],
    requestedCapabilities: [],
    requestedTools: ["memory.recall"]
  }), /exceeds its parent or trusted tool declarations/u);
});
