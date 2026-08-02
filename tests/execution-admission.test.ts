import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    assert.equal(stepEnvelope?.inputReference, `artifact:sha256:${stepEnvelope?.inputDigest}`);
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

test("terminal audit failure settles post-dispatch effectful work as needs-review", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-admission-terminal-audit-"));
  const stateDir = join(root, ".odinn");
  const ledger = createRunLedger({ stateDir, workspaceRoot: root });
  const durableAudit = createAuditStore(join(stateDir, "audit.jsonl"));
  let executed = false;
  const auditStore = {
    append(value: unknown) {
      if (value && typeof value === "object" && "type" in value && ["task.completed", "task.failed"].includes(String(value.type))) {
        return Promise.reject(new Error("fixture terminal audit unavailable"));
      }
      return durableAudit.append(value);
    },
    readRun(id: string) { return durableAudit.readRun(id); }
  };
  const registry = new Map<string, unknown>([["fixture.effect.audit", {
    capability: "fixture.effect",
    execute: async () => {
      executed = true;
      return { applied: true };
    }
  }]]);
  try {
    await assert.rejects(() => runTask({
      task: { id: "run_terminal_audit_failure", tool: "fixture.effect.audit", input: {}, actor: "test" },
      auditStore,
      policy: createDefaultPolicy({ allowedCapabilities: ["fixture.effect"] }),
      registry,
      runLedger: ledger
    }), /fixture terminal audit unavailable/u);
    assert.equal(executed, true);
    const [attempt] = ledger.listExecutionAttempts("run_terminal_audit_failure");
    assert.equal(attempt.state, "needs-review");
    assert.equal(attempt.errorCode, "EXECUTION_OUTCOME_UNCERTAIN");
    assert.equal(ledger.getRun("run_terminal_audit_failure")?.status, "failed");
  } finally {
    durableAudit.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("approval-required output leaves the attempt awaiting approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-admission-awaiting-approval-"));
  const stateDir = join(root, ".odinn");
  const ledger = createRunLedger({ stateDir, workspaceRoot: root });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const registry = new Map<string, unknown>([["browser.click", {
    capability: "browser.act",
    execute: async () => ({ type: "approval.required", approvalId: "approval_fixture", summary: "Approve fixture", expiresInSeconds: 300 })
  }]]);
  try {
    const result = await runTask({
      task: { id: "run_awaiting_approval", tool: "browser.click", input: { selector: "#apply" }, actor: "test" },
      auditStore,
      registry,
      runLedger: ledger
    });
    assert.equal(result.output.type, "approval.required");
    const [attempt] = ledger.listExecutionAttempts("run_awaiting_approval");
    assert.equal(attempt.state, "awaiting-approval");
    assert.equal(attempt.settledAt, undefined);
    assert.equal(ledger.getRun("run_awaiting_approval")?.status, "blocked");
  } finally {
    auditStore.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("input digest authenticates the redacted artifact without a raw secret fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-admission-redacted-input-"));
  const stateDir = join(root, ".odinn");
  const ledger = createRunLedger({ stateDir, workspaceRoot: root });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir, auditStore });
  try {
    await runTask({
      task: { id: "run_redacted_input", tool: "text.echo", input: { text: "ok", password: "guessable-secret" }, actor: "test" },
      auditStore,
      registry,
      runLedger: ledger
    });
    const envelope = ledger.getExecutionEnvelope("run_redacted_input")!.envelope;
    assert.equal(envelope.inputReference, `artifact:sha256:${envelope.inputDigest}`);
    const artifact = await readFile(join(ledger.artifacts.root, "sha256", envelope.inputDigest.slice(0, 2), envelope.inputDigest), "utf8");
    assert.doesNotMatch(artifact, /guessable-secret/u);
    assert.match(artifact, /\[redacted\]/u);
  } finally {
    registry.close();
    auditStore.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("only trusted recovery creates a fresh attempt for an identical retry-safe envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-admission-retry-"));
  const stateDir = join(root, ".odinn");
  const ledger = createRunLedger({ stateDir, workspaceRoot: root });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  let executions = 0;
  const registry = new Map<string, unknown>([["text.echo", {
    capability: "core.echo",
    execute: async () => {
      executions += 1;
      if (executions === 1) throw new Error("retry fixture failed");
      return { text: "recovered" };
    }
  }]]);
  const options = {
    task: { id: "run_retry_safe", tool: "text.echo", input: { text: "same" }, actor: "test" },
    auditStore,
    policy: createDefaultPolicy({ allowedCapabilities: ["core.echo"] }),
    registry,
    runLedger: ledger
  };
  try {
    await assert.rejects(() => runTask(options), /retry fixture failed/u);
    await assert.rejects(() => runTask(options), (error: unknown) => error instanceof Error && "code" in error && error.code === "IDEMPOTENCY_REUSE");
    const recovered = await runTask({ ...options, trustedRecovery: true });
    assert.equal(recovered.output.text, "recovered");
    assert.equal(executions, 2);
    assert.deepEqual(ledger.listExecutionAttempts("run_retry_safe").map((attempt) => attempt.state), ["failed", "completed"]);
    const readmitted = (await auditStore.readRun("run_retry_safe")).events.filter((event: any) => event.type === "execution.readmitted");
    assert.equal(readmitted.length, 1);
    assert.equal(readmitted[0].data.auditCorrelationId, ledger.getExecutionEnvelope("run_retry_safe")?.envelope.auditCorrelationId);
  } finally {
    auditStore.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted recovery admits a request bound before any envelope was persisted", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-admission-pre-envelope-recovery-"));
  const stateDir = join(root, ".odinn");
  const ledger = createRunLedger({ stateDir, workspaceRoot: root });
  const durableAudit = createAuditStore(join(stateDir, "audit.jsonl"));
  let failPolicy = true;
  let executions = 0;
  const auditStore = {
    append(value: any) {
      if (failPolicy && value?.type === "task.policy") {
        failPolicy = false;
        return Promise.reject(new Error("crash before admission"));
      }
      return durableAudit.append(value);
    },
    readRun(id: string) { return durableAudit.readRun(id); }
  };
  const registry = new Map<string, unknown>([["fixture.pre-admission", {
    capability: "fixture.read",
    execute: async () => { executions += 1; return { recovered: true }; }
  }]]);
  const options = {
    task: { id: "run_pre_admission_crash", tool: "fixture.pre-admission", input: {}, actor: "test" },
    auditStore,
    policy: createDefaultPolicy({ allowedCapabilities: ["fixture.read"] }),
    registry,
    runLedger: ledger
  };
  try {
    await assert.rejects(() => runTask(options), /crash before admission/u);
    assert.equal(ledger.getExecutionEnvelope("run_pre_admission_crash"), undefined);
    const recovered = await runTask({ ...options, trustedRecovery: true });
    assert.equal(recovered.output.recovered, true);
    assert.equal(executions, 1);
    assert.deepEqual(ledger.listExecutionAttempts("run_pre_admission_crash").map((attempt) => attempt.state), ["completed"]);
  } finally {
    durableAudit.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted recovery dispatches an unsafe attempt that never crossed the backend boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-admission-queued-unsafe-recovery-"));
  const stateDir = join(root, ".odinn");
  const ledger = createRunLedger({ stateDir, workspaceRoot: root });
  const durableAudit = createAuditStore(join(stateDir, "audit.jsonl"));
  let failStart = true;
  let executions = 0;
  const auditStore = {
    append(value: any) {
      if (failStart && value?.type === "task.started") {
        failStart = false;
        return Promise.reject(new Error("crash before dispatch"));
      }
      return durableAudit.append(value);
    },
    readRun(id: string) { return durableAudit.readRun(id); }
  };
  const registry = new Map<string, unknown>([["fixture.effect.queued", {
    capability: "fixture.effect",
    execute: async () => { executions += 1; return { applied: true }; }
  }]]);
  const options = {
    task: { id: "run_queued_unsafe", tool: "fixture.effect.queued", input: {}, actor: "test" },
    auditStore,
    policy: createDefaultPolicy({ allowedCapabilities: ["fixture.effect"] }),
    registry,
    runLedger: ledger
  };
  try {
    await assert.rejects(() => runTask(options), /crash before dispatch/u);
    assert.deepEqual(ledger.listExecutionAttempts("run_queued_unsafe").map((attempt) => attempt.state), ["queued"]);
    const recovered = await runTask({ ...options, trustedRecovery: true });
    assert.equal(recovered.output.applied, true);
    assert.equal(executions, 1);
    assert.deepEqual(ledger.listExecutionAttempts("run_queued_unsafe").map((attempt) => attempt.state), ["completed"]);
  } finally {
    durableAudit.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});
