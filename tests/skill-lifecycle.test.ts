import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApprovalStore, createAuditStore, createBuiltInRegistry, ProgressiveSkillDisclosure, SkillLifecycleService, SkillPackageStore } from "../packages/kernel/src/index.ts";
import { createDefaultPolicy } from "../packages/policy/src/index.ts";
import { projectDurableToolOutput } from "../packages/protocol/src/index.ts";

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    sdkVersion: "0.1",
    id: "bounded-skill",
    version: "1.0.0",
    name: "Bounded Skill",
    description: "Use this skill for a bounded, explicitly selected workflow.",
    instructions: "Inspect the selected evidence, perform the bounded workflow, and return only verified results.",
    requestedTools: [],
    requestedCapabilities: [],
    requestedSecrets: [],
    network: { default: "deny", allow: [] },
    tests: [],
    ...overrides
  };
}

async function fixture(t: test.TestContext, enabled = true) {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-skill-lifecycle-"));
  const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const store = new SkillPackageStore(stateDir);
  const service = new SkillLifecycleService({
    store,
    approvalStore,
    auditStore,
    policy: createDefaultPolicy({ allowedCapabilities: ["skill.manage"] }),
    enabled
  });
  t.after(() => {
    auditStore.close?.();
    return rm(stateDir, { recursive: true, force: true });
  });
  return { stateDir, store, service, auditStore, approvalStore };
}

test("managed lifecycle is default-inert and creates no artifacts when disabled", async (t) => {
  const { store, service } = await fixture(t, false);
  await assert.rejects(() => service.create(manifest()), (error: any) => error.code === "SKILL_LIFECYCLE_DISABLED" && error.status === 403);
  assert.deepEqual(await store.inspect(), []);
});

test("create installs disabled and untrusted, then enable requires a digest-bound one-time approval", async (t) => {
  const { service, store, approvalStore, auditStore } = await fixture(t);
  const created = await service.create(manifest(), { operationId: "skill-create-1", actor: "operator" });
  assert.equal(created.status, "disabled");
  assert.equal(created.trusted, false);

  const requested = await service.transition({
    id: created.id,
    action: "enable",
    version: created.version,
    integrity: created.integrity
  }, { operationId: "skill-enable-1", actor: "operator" });
  assert.equal(requested.type, "approval.required");
  assert.equal((await store.inspect())[0]?.status, "disabled");

  const pending = approvalStore.claim(requested.approvalId);
  assert.ok(pending);
  const enabled = await service.applyApproved(requested.approvalId, pending);
  assert.equal(enabled.status, "enabled");
  assert.equal(enabled.trusted, true);
  await assert.rejects(() => service.applyApproved(requested.approvalId, pending), (error: any) => error.code === "SKILL_APPROVAL_CONSUMED");

  const audit = JSON.stringify(await auditStore.readAll());
  assert.match(audit, /skill\.lifecycle\.approval_required/u);
  assert.doesNotMatch(audit, /Inspect the selected evidence/u);
  assert.doesNotMatch(audit, /requestedSecrets|network/u);
});

test("lifecycle preconditions and declarations fail closed", async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(() => service.create(manifest({ id: "unknown-tool", requestedTools: ["skill.unknown"] })), /trusted capability declaration/u);
  const created = await service.create(manifest({ id: "network-skill", network: { default: "deny", allow: ["example.com"] } }));
  await assert.rejects(() => service.transition({ id: created.id, action: "enable", version: created.version, integrity: created.integrity }), /secret or network declarations/u);
  await assert.rejects(() => service.transition({ id: created.id, action: "disable", version: created.version, integrity: "0".repeat(64) }), (error: any) => error.code === "SKILL_PRECONDITION_FAILED");
});

test("inspection reports tampering without quarantining on a read", async (t) => {
  const { stateDir, store, service } = await fixture(t);
  const installed = await store.install(manifest({ id: "inspect-only" }));
  await store.transition(installed.id, "enable");
  await writeFile(join(installed.packagePath, "SKILL.md"), "tampered content\n", "utf8");
  const [record] = await service.inspect();
  assert.equal(record.status, "enabled");
  assert.equal(record.trusted, true);
  assert.equal(record.verification.valid, false);
  const registry = JSON.parse(await readFile(join(stateDir, "skills", "registry.json"), "utf8"));
  assert.equal(registry.packages[0].status, "enabled");
});

test("progressive skill tools are absent by default and explicit when enabled", async (t) => {
  const { stateDir, store } = await fixture(t);
  const installed = await store.install(manifest({ id: "tool-skill" }));
  await store.transition(installed.id, "enable");
  const disclosure = new ProgressiveSkillDisclosure(store);
  const disabled = createBuiltInRegistry({ workspaceRoot: stateDir, stateDir, config: {}, skillDisclosure: disclosure });
  assert.equal(disabled.has("skill.catalog"), false);
  disabled.close();
  const enabled = createBuiltInRegistry({ workspaceRoot: stateDir, stateDir, config: { runtime: { enableProgressiveSkills: true } }, skillDisclosure: disclosure });
  try {
    assert.equal(enabled.has("skill.catalog"), true);
    assert.equal(enabled.has("skill.hydrate"), true);
    const hydrated = await enabled.get("skill.hydrate").execute({ id: "tool-skill" }, {});
    assert.match(hydrated.skillMarkdown, /BEGIN UNTRUSTED SKILL REFERENCE/u);
  } finally {
    enabled.close();
  }
});

test("skill durable projections retain bounded digests without raw package content", () => {
  const projected = projectDurableToolOutput("skill.hydrate", {
    id: "bounded-skill",
    version: "1.0.0",
    name: "Bounded Skill",
    description: "A description that must not be persisted as raw model-facing content.",
    integrity: "a".repeat(64),
    requestedTools: [],
    requestedCapabilities: [],
    skillMarkdown: "PRIVATE SKILL INSTRUCTIONS MUST NOT ENTER DURABLE STATE"
  }) as Record<string, unknown>;
  assert.equal(projected.id, "bounded-skill");
  assert.match(String(projected.skillMarkdownDigest), /^sha256:/u);
  assert.equal(projected.skillMarkdown, undefined);
  assert.equal(projected.description, undefined);

  const approval = projectDurableToolOutput("skill.lifecycle", {
    type: "approval.required",
    approvalId: "approval-1",
    tool: "skill.lifecycle",
    summary: "raw operator summary must not be retained",
    skill: { id: "bounded-skill", version: "1.0.0", integrity: "a".repeat(64), status: "disabled" }
  }) as Record<string, any>;
  assert.equal(approval.skill.skillId, "bounded-skill");
  assert.equal(approval.summary, undefined);
  assert.equal(approval.skill.integrity, "a".repeat(64));
});
