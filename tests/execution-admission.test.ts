import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultPolicy } from "../packages/policy/src/index.ts";
import { createAuditStore, createBuiltInRegistry, createRunLedger, runPlan, runTask } from "../packages/kernel/src/index.ts";

test("plan steps execute through admission with durable parent correlation", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-admission-plan-"));
  const stateDir = join(root, ".odinn");
  const ledger = createRunLedger({ stateDir, workspaceRoot: root });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir, auditStore });
  try {
    const result = await runPlan({
      plan: { id: "plan_admitted", name: "admitted plan", steps: [{ id: "echo", tool: "text.echo", input: { text: "ok" } }] },
      auditStore,
      registry,
      runLedger: ledger
    });
    assert.equal(result.ok, true);
    const stepEnvelope = ledger.getExecutionEnvelope("plan_admitted:echo")?.envelope;
    assert.equal(stepEnvelope?.parentRunId, "plan_admitted");
    assert.equal(stepEnvelope?.execution.id, "text.echo");
    assert.deepEqual(ledger.listExecutionAttempts("plan_admitted:echo").map((attempt) => attempt.state), ["completed"]);
  } finally {
    registry.close();
    auditStore.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelled non-retry-safe effects settle as needs-review", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-admission-uncertain-"));
  const stateDir = join(root, ".odinn");
  const ledger = createRunLedger({ stateDir, workspaceRoot: root });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const controller = new AbortController();
  const registry = new Map<string, unknown>([["fixture.effect", {
    capability: "fixture.effect",
    execute: async () => {
      controller.abort(new Error("fixture cancelled after dispatch"));
      throw controller.signal.reason;
    }
  }]]);
  try {
    await assert.rejects(() => runTask({
      task: { id: "run_uncertain_effect", tool: "fixture.effect", input: {}, actor: "test" },
      auditStore,
      policy: createDefaultPolicy({ allowedCapabilities: ["fixture.effect"] }),
      registry,
      runLedger: ledger,
      signal: controller.signal
    }), /fixture cancelled after dispatch/u);
    const [attempt] = ledger.listExecutionAttempts("run_uncertain_effect");
    assert.equal(attempt.state, "needs-review");
    assert.equal(attempt.errorCode, "EXECUTION_OUTCOME_UNCERTAIN");
    assert.ok(attempt.settledAt);
  } finally {
    auditStore.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("policy denial remains pre-admission and cannot create an executable envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-admission-denied-"));
  const stateDir = join(root, ".odinn");
  const ledger = createRunLedger({ stateDir, workspaceRoot: root });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir, auditStore });
  try {
    await assert.rejects(() => runTask({
      task: { id: "run_denied_before_admission", tool: "text.echo", input: { text: "blocked" }, actor: "test" },
      auditStore,
      policy: createDefaultPolicy({ deniedTools: ["text.echo"] }),
      registry,
      runLedger: ledger
    }), /denied by policy/u);
    assert.equal(ledger.getExecutionEnvelope("run_denied_before_admission"), undefined);
    assert.deepEqual(ledger.listExecutionAttempts("run_denied_before_admission"), []);
  } finally {
    registry.close();
    auditStore.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("signed audit failure blocks backend dispatch and settles admission as failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-admission-audit-failure-"));
  const stateDir = join(root, ".odinn");
  const ledger = createRunLedger({ stateDir, workspaceRoot: root });
  const durableAudit = createAuditStore(join(stateDir, "audit.jsonl"));
  let executed = false;
  const auditStore = {
    append(value: unknown) {
      if (value && typeof value === "object" && "type" in value && value.type === "execution.admitted") {
        return Promise.reject(new Error("fixture audit admission failure"));
      }
      return durableAudit.append(value);
    },
    readRun(id: string) { return durableAudit.readRun(id); }
  };
  const registry = new Map<string, unknown>([["fixture.read", {
    capability: "fixture.read",
    execute: async () => {
      executed = true;
      return { ok: true };
    }
  }]]);
  try {
    await assert.rejects(() => runTask({
      task: { id: "run_audit_admission_failure", tool: "fixture.read", input: {}, actor: "test" },
      auditStore,
      policy: createDefaultPolicy({ allowedCapabilities: ["fixture.read"] }),
      registry,
      runLedger: ledger
    }), /fixture audit admission failure/u);
    assert.equal(executed, false);
    const [attempt] = ledger.listExecutionAttempts("run_audit_admission_failure");
    assert.equal(attempt.state, "failed");
    assert.equal(attempt.errorCode, "AUDIT_CORRELATION_FAILED");
  } finally {
    durableAudit.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});
