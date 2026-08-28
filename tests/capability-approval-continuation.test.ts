import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createApprovalStore,
  createAuditStore,
  createBuiltInRegistry,
  createDifferentiatedRuntime,
  runTask
} from "../packages/kernel/src/index.ts";
import { createDefaultPolicy } from "../packages/policy/src/index.ts";
import { createRuntimeRegistry } from "../packages/runtime/src/index.ts";

const featureFlags = { capabilities: true, capsules: false, counterfactual: false };

function configuredDiscord() {
  return {
    plugins: {
      entries: {
        discord: {
          enabled: true,
          config: {
            accounts: {
              home: { enabled: true, tokenEnv: "ODINN_TEST_DISCORD_TOKEN" }
            }
          }
        }
      }
    }
  };
}

test("Rune Key admits an exact Discord approval continuation once without exposing its token", async (t) => {
  const originalToken = process.env.ODINN_TEST_DISCORD_TOKEN;
  process.env.ODINN_TEST_DISCORD_TOKEN = "test-token";
  const root = await mkdtemp(join(tmpdir(), "odinn-rune-key-discord-"));
  const stateDir = join(root, ".odinn");
  const approvalPath = join(stateDir, "approvals.json");
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const runtime = createDifferentiatedRuntime({ stateDir, workspaceRoot: root, featureFlags });
  const approvalStore = createApprovalStore({ path: approvalPath });
  let dispatches = 0;
  let dispatchedContent = "";
  const registry = createRuntimeRegistry({
    workspaceRoot: root,
    stateDir,
    config: { ...configuredDiscord(), experimental: featureFlags, runLedger: runtime.ledger },
    approvalStore,
    auditStore,
    discordFetch: async (_url: string | URL | Request, init?: RequestInit) => {
      dispatches += 1;
      dispatchedContent = String(JSON.parse(String(init?.body ?? "{}")).content ?? "");
      return new Response(JSON.stringify({ id: "sent-once" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  t.after(async () => {
    registry.close();
    auditStore.close();
    runtime.ledger.close();
    await rm(root, { recursive: true, force: true });
    if (originalToken === undefined) delete process.env.ODINN_TEST_DISCORD_TOKEN;
    else process.env.ODINN_TEST_DISCORD_TOKEN = originalToken;
  });

  const runId = "rune-key-discord-approval";
  const actor = "discord-operator";
  runtime.ledger.ensureRun({ runId, objective: "send one approved Discord message" });
  const issued = runtime.capabilities.issue({
    runId,
    stepId: "send-message",
    toolName: "discord.sendMessage",
    resourceConstraints: { accountId: "home", channelId: "123" },
    maxUses: 1
  });
  const input = {
    accountId: "home",
    channelId: "123",
    content: "approved exact message",
    capabilityToken: issued.token,
    confirmed: false,
    approvalId: "untrusted-first-leg-hint"
  };
  const exactExecutionInput = {
    accountId: input.accountId,
    channelId: input.channelId,
    content: input.content
  };
  const options = {
    auditStore,
    approvalStore,
    policy: createDefaultPolicy({ allowedCapabilities: ["network.access"] }),
    registry,
    runLedger: runtime.ledger
  };

  const first = await runTask({
    ...options,
    task: { id: runId, tool: "discord.sendMessage", input, actor }
  });
  assert.equal(first.output.type, "approval.required");
  assert.equal(dispatches, 0);
  assert.equal(runtime.capabilities.list(runId)[0].uses, 0, "approval creation must not consume the key");
  assert.equal(runtime.capabilities.list(runId)[0].status, "active");
  const persisted = await readFile(approvalPath, "utf8");
  assert.equal(persisted.includes(issued.token), false);
  assert.equal(JSON.stringify(approvalStore.list()).includes(issued.token), false);
  assert.equal(persisted.includes("capabilityToken"), false);

  const approvalId = first.output.approvalId as string;
  assert.ok(approvalStore.claim(approvalId));
  const recovered = approvalStore.recover(approvalId);
  assert.deepEqual(recovered?.input, exactExecutionInput);
  assert.equal(recovered?.actor, actor);
  assert.throws(
    () => runtime.capabilities.validate(issued.token, {
      runId,
      toolName: "discord.sendMessage",
      resource: { accountId: "home", channelId: "999" }
    }),
    (error: any) => error.code === "CAPABILITY_SCOPE_MISMATCH"
  );

  await assert.rejects(
    runTask({
      ...options,
      task: { id: runId, tool: "discord.sendMessage", input: { ...input, content: "changed" }, actor },
      trustedApprovalId: approvalId,
      trustedApprovalRunId: runId,
      trustedRecovery: true
    }),
    (error: any) => error.code === "APPROVAL_CONTINUATION_DENIED"
  );
  await assert.rejects(
    runTask({
      ...options,
      task: { id: runId, tool: "discord.sendMessage", input, actor: "different-actor" },
      trustedApprovalId: approvalId,
      trustedApprovalRunId: runId,
      trustedRecovery: true
    }),
    (error: any) => error.code === "APPROVAL_CONTINUATION_DENIED"
  );
  await assert.rejects(
    runTask({
      ...options,
      task: { id: runId, tool: "discord.sendMessage", input, actor },
      trustedApprovalId: "approval_forged",
      trustedApprovalRunId: runId,
      trustedRecovery: true
    }),
    (error: any) => error.code === "APPROVAL_CONTINUATION_DENIED"
  );
  assert.equal(dispatches, 0, "changed input or actor must fail before Discord dispatch");

  const continuationInput = {
    ...input,
    confirmed: true,
    approvalId: "untrusted-continuation-hint"
  };
  const second = await runTask({
    ...options,
    task: { id: runId, tool: "discord.sendMessage", input: continuationInput, actor },
    trustedApprovalId: approvalId,
    trustedApprovalRunId: runId
  });
  assert.equal(second.output.id, "sent-once");
  assert.equal(dispatches, 1);
  assert.equal(dispatchedContent, exactExecutionInput.content);
  assert.equal(runtime.capabilities.list(runId)[0].uses, 1);
  assert.equal(runtime.capabilities.list(runId)[0].status, "consumed");
  assert.deepEqual(approvalStore.list(), []);

  await assert.rejects(
    runTask({
      ...options,
      task: { id: runId, tool: "discord.sendMessage", input: continuationInput, actor },
      trustedApprovalId: approvalId,
      trustedApprovalRunId: runId,
      trustedRecovery: true
    }),
    (error: any) => error.code === "APPROVAL_CONTINUATION_DENIED"
  );
  const replay = await runTask({
    ...options,
    task: { id: runId, tool: "discord.sendMessage", input: continuationInput, actor }
  });
  assert.equal(replay.replayed, true);
  assert.equal(dispatches, 1, "completed-run replay must not dispatch the mutation twice");
  assert.throws(
    () => runtime.capabilities.consume(issued.token, {
      runId,
      toolName: "discord.sendMessage",
      resource: { accountId: "home", channelId: "123" }
    }),
    (error: any) => error.code === "CAPABILITY_DENIED"
  );
});

test("Rune Key admits an exact process approval continuation while rejecting mismatched authority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-rune-key-process-"));
  const stateDir = join(root, ".odinn");
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const runtime = createDifferentiatedRuntime({ stateDir, workspaceRoot: root, featureFlags });
  const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
  let dispatches = 0;
  let dispatchedProcessInput: Record<string, unknown> | undefined;
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir,
    approvalStore,
    auditStore,
    processExecutor: async (input: Record<string, unknown>) => {
      dispatches += 1;
      dispatchedProcessInput = input;
      return { exitCode: 0, command: input.command };
    }
  });
  t.after(async () => {
    registry.close();
    auditStore.close();
    runtime.ledger.close();
    await rm(root, { recursive: true, force: true });
  });

  const runId = "rune-key-process-approval";
  const actor = "process-operator";
  runtime.ledger.ensureRun({ runId, objective: "run one approved sandbox command" });
  const issued = runtime.capabilities.issue({
    runId,
    stepId: "sandbox-command",
    toolName: "process.exec",
    maxUses: 1
  });
  const input = {
    command: "/bin/true",
    args: [],
    cwd: ".",
    capabilityToken: issued.token,
    confirmed: "exact-process-input"
  };
  const options = {
    auditStore,
    approvalStore,
    policy: createDefaultPolicy({ allowedCapabilities: ["process.exec"] }),
    registry,
    runLedger: runtime.ledger,
    durableExecution: true
  };

  const first = await runTask({
    ...options,
    task: { id: runId, tool: "process.exec", input, actor }
  });
  assert.equal(first.output.type, "approval.required");
  assert.equal(dispatches, 0);
  assert.equal(runtime.capabilities.list(runId)[0].uses, 0);

  const approvalId = first.output.approvalId as string;
  assert.throws(
    () => runtime.capabilities.validate(issued.token, { runId: "other-run", toolName: "process.exec" }),
    (error: any) => error.code === "CAPABILITY_SCOPE_MISMATCH"
  );
  assert.throws(
    () => runtime.capabilities.validate(issued.token, { runId, toolName: "discord.sendMessage" }),
    (error: any) => error.code === "CAPABILITY_SCOPE_MISMATCH"
  );

  const originalAttempt = runtime.ledger.listExecutionAttempts(runId)[0];
  assert.equal(originalAttempt.state, "awaiting-approval");
  const envelope = runtime.ledger.getExecutionEnvelope(runId)!.envelope;
  assert.throws(
    () => runtime.ledger.resumeExecution({
      runId,
      executionId: envelope.execution.id,
      inputDigest: envelope.inputDigest,
      principalId: envelope.principalId
    }),
    (error: any) => error.code === "EXECUTION_RETRY_UNSAFE"
  );
  await assert.rejects(
    runTask({
      ...options,
      task: { id: runId, tool: "process.exec", input, actor },
      trustedApprovalId: "approval_forged",
      trustedApprovalRunId: runId,
      trustedRecovery: true
    }),
    (error: any) => error.code === "APPROVAL_CONTINUATION_DENIED"
  );
  assert.equal(dispatches, 0);
  assert.ok(approvalStore.claim(approvalId));
  await assert.rejects(
    runTask({
      ...options,
      task: { id: runId, tool: "process.exec", input: { ...input, confirmed: "changed-process-input" }, actor },
      trustedApprovalId: approvalId,
      trustedApprovalRunId: runId,
      trustedRecovery: true
    }),
    (error: any) => error.code === "APPROVAL_CONTINUATION_DENIED"
  );
  assert.equal(dispatches, 0);

  const second = await runTask({
    ...options,
    task: { id: runId, tool: "process.exec", input, actor },
    trustedApprovalId: approvalId,
    trustedApprovalRunId: runId
  });
  assert.deepEqual(second.output, { exitCode: 0, command: "/bin/true" });
  assert.equal(dispatches, 1);
  assert.equal(dispatchedProcessInput?.confirmed, "exact-process-input");
  assert.equal("capabilityToken" in (dispatchedProcessInput ?? {}), false);
  assert.equal(runtime.capabilities.list(runId)[0].status, "consumed");
  assert.deepEqual(runtime.ledger.listExecutionAttempts(runId).map((attempt: any) => attempt.state), ["completed"]);

  const expiredRunId = "rune-key-process-expired";
  runtime.ledger.ensureRun({ runId: expiredRunId, objective: "reject an expired sandbox continuation" });
  const expired = runtime.capabilities.issue({
    runId: expiredRunId,
    stepId: "expired-command",
    toolName: "process.exec",
    maxUses: 1
  });
  const expiredInput = { command: "/bin/false", args: [], cwd: ".", capabilityToken: expired.token };
  const expiredFirst = await runTask({
    ...options,
    task: { id: expiredRunId, tool: "process.exec", input: expiredInput, actor }
  });
  assert.equal(expiredFirst.output.type, "approval.required");
  const expiredApprovalId = expiredFirst.output.approvalId as string;
  assert.ok(approvalStore.claim(expiredApprovalId));
  runtime.ledger.database.db.prepare("UPDATE capabilities SET expires_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 1_000).toISOString(), expired.claims.id);
  await assert.rejects(
    runTask({
      ...options,
      task: { id: expiredRunId, tool: "process.exec", input: expiredInput, actor },
      trustedApprovalId: expiredApprovalId,
      trustedApprovalRunId: expiredRunId
    }),
    (error: any) => error.code === "CAPABILITY_EXPIRED"
  );
  assert.equal(dispatches, 1, "expired continuation authority must fail before process dispatch");
  assert.equal(runtime.capabilities.list(expiredRunId)[0].uses, 0);
});

test("one of twelve direct approval continuations owns dispatch and generic recovery cannot mint another approval", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-rune-key-direct-race-"));
  const stateDir = join(root, ".odinn");
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const runtime = createDifferentiatedRuntime({ stateDir, workspaceRoot: root, featureFlags });
  const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
  let dispatches = 0;
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir,
    approvalStore,
    auditStore,
    processExecutor: async () => {
      dispatches += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { exitCode: 0 };
    }
  });
  t.after(async () => {
    registry.close();
    auditStore.close();
    runtime.ledger.close();
    await rm(root, { recursive: true, force: true });
  });

  const runId = "rune-key-direct-race";
  const actor = "direct-race-operator";
  runtime.ledger.ensureRun({ runId, objective: "dispatch one approved continuation" });
  const issued = runtime.capabilities.issue({
    runId,
    stepId: "direct-race",
    toolName: "process.exec",
    maxUses: 1
  });
  const input = { command: "/bin/true", args: [], cwd: ".", capabilityToken: issued.token };
  const options = {
    auditStore,
    approvalStore,
    policy: createDefaultPolicy({ allowedCapabilities: ["process.exec"] }),
    registry,
    runLedger: runtime.ledger,
    durableExecution: true
  };
  const first = await runTask({
    ...options,
    task: { id: runId, tool: "process.exec", input, actor }
  });
  const approvalId = first.output.approvalId as string;
  assert.equal(first.output.type, "approval.required");
  assert.equal(approvalStore.list().length, 1);
  assert.deepEqual(runtime.ledger.listExecutionAttempts(runId).map((attempt: any) => attempt.state), ["awaiting-approval"]);

  await assert.rejects(
    runTask({
      ...options,
      task: { id: runId, tool: "process.exec", input, actor },
      trustedRecovery: true
    }),
    (error: any) => error.code === "APPROVAL_CONTINUATION_REQUIRED"
  );
  assert.equal(dispatches, 0);
  assert.deepEqual(approvalStore.list().map((approval: any) => approval.id), [approvalId]);
  assert.deepEqual(runtime.ledger.listExecutionAttempts(runId).map((attempt: any) => attempt.state), ["awaiting-approval"]);
  assert.equal(runtime.capabilities.list(runId)[0].uses, 0);

  assert.ok(approvalStore.claim(approvalId));
  const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => runTask({
    ...options,
    task: { id: runId, tool: "process.exec", input, actor },
    trustedApprovalId: approvalId,
    trustedApprovalRunId: runId
  })));
  const successes = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 11);
  assert.ok(failures.every(({ reason }) => reason?.code === "APPROVAL_CONTINUATION_DENIED"));
  assert.equal(dispatches, 1);
  assert.equal(runtime.capabilities.list(runId)[0].uses, 1);
  assert.equal(runtime.capabilities.list(runId)[0].status, "consumed");
  assert.deepEqual(approvalStore.list(), []);
  assert.deepEqual(runtime.ledger.listExecutionAttempts(runId).map((attempt: any) => attempt.state), ["completed"]);
});

test("separate approval stores and ledgers serialize one continuation owner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-rune-key-cross-instance-"));
  const stateDir = join(root, ".odinn");
  const approvalPath = join(stateDir, "approvals.json");
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const leftRuntime = createDifferentiatedRuntime({ stateDir, workspaceRoot: root, featureFlags });
  const rightRuntime = createDifferentiatedRuntime({ stateDir, workspaceRoot: root, featureFlags });
  const leftApprovals = createApprovalStore({ path: approvalPath });
  const rightApprovals = createApprovalStore({ path: approvalPath });
  let dispatches = 0;
  const processExecutor = async () => {
    dispatches += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { exitCode: 0 };
  };
  const leftRegistry = createBuiltInRegistry({ workspaceRoot: root, stateDir, approvalStore: leftApprovals, auditStore, processExecutor });
  const rightRegistry = createBuiltInRegistry({ workspaceRoot: root, stateDir, approvalStore: rightApprovals, auditStore, processExecutor });
  t.after(async () => {
    leftRegistry.close();
    rightRegistry.close();
    auditStore.close();
    leftRuntime.ledger.close();
    rightRuntime.ledger.close();
    await rm(root, { recursive: true, force: true });
  });

  const runId = "rune-key-cross-instance";
  const actor = "cross-instance-operator";
  leftRuntime.ledger.ensureRun({ runId, objective: "serialize approval continuation ownership" });
  const issued = leftRuntime.capabilities.issue({
    runId,
    stepId: "cross-instance",
    toolName: "process.exec",
    maxUses: 1
  });
  const input = { command: "/bin/true", args: [], cwd: ".", capabilityToken: issued.token };
  const policy = createDefaultPolicy({ allowedCapabilities: ["process.exec"] });
  const first = await runTask({
    task: { id: runId, tool: "process.exec", input, actor },
    auditStore,
    approvalStore: leftApprovals,
    policy,
    registry: leftRegistry,
    runLedger: leftRuntime.ledger,
    durableExecution: true
  });
  const approvalId = first.output.approvalId as string;
  assert.ok(rightApprovals.claim(approvalId));
  const continuation = (approvalStore: any, registry: any, runLedger: any) => runTask({
    task: { id: runId, tool: "process.exec", input, actor },
    auditStore,
    approvalStore,
    policy,
    registry,
    runLedger,
    durableExecution: true,
    trustedApprovalId: approvalId,
    trustedApprovalRunId: runId
  });
  const outcomes = await Promise.allSettled([
    continuation(leftApprovals, leftRegistry, leftRuntime.ledger),
    continuation(rightApprovals, rightRegistry, rightRuntime.ledger)
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  assert.equal(rejected?.reason?.code, "APPROVAL_CONTINUATION_DENIED");
  assert.equal(dispatches, 1);
  assert.equal(leftRuntime.capabilities.list(runId)[0].uses, 1);
  assert.equal(leftRuntime.capabilities.list(runId)[0].status, "consumed");
  assert.deepEqual(createApprovalStore({ path: approvalPath }).list(), []);
  assert.deepEqual(leftRuntime.ledger.listExecutionAttempts(runId).map((attempt: any) => attempt.state), ["completed"]);
});

test("legacy approval hints remain exact input for tools that do not define them as no-ops", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-approval-hint-scope-"));
  const stateDir = join(root, ".odinn");
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir, auditStore });
  t.after(async () => {
    registry.close();
    auditStore.close();
    await rm(root, { recursive: true, force: true });
  });

  const task = {
    id: "approval-hints-are-tool-scoped",
    tool: "text.echo",
    input: { text: "exact", confirmed: "real-value", approvalId: "real-identifier" },
    actor: "test"
  };
  const first = await runTask({ task, auditStore, registry });
  assert.equal(first.output.text, "exact");
  for (const input of [
    { ...task.input, confirmed: "changed" },
    { ...task.input, approvalId: "changed" }
  ]) {
    await assert.rejects(
      runTask({ task: { ...task, input }, auditStore, registry }),
      (error: any) => error.code === "IDEMPOTENCY_CONFLICT"
    );
  }
});
