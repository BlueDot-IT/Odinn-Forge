import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  COMPUTER_CONTROL_PLUGIN_MANIFEST,
  COMPUTER_SCREEN_PLUGIN_MANIFEST,
  captureComputerScreen,
  computerControlHostCapabilityPlugin,
  computerScreenHostCapabilityPlugin,
  createApprovalStore,
  createAuditStore,
  createBuiltInRegistry,
  createDifferentiatedRuntime,
  materializeHostCapabilityPlugin,
  normalizeComputerActionInput,
  runTask
} from "../packages/kernel/src/index.ts";
import { createDefaultPolicy, evaluateTaskPolicy } from "../packages/policy/src/index.ts";
import { isReplayUnavailableTool, projectDurableToolInput, projectDurableToolOutput } from "../packages/protocol/src/index.ts";

const target = Object.freeze({ nodeId: "node-a", displayId: "display-1", pairingGeneration: "pair-7" });
const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function provider(overrides: Record<string, unknown> = {}) {
  return {
    target,
    capture: async (request: { target: typeof target; signal?: AbortSignal }) => ({
      frameId: "frame-1",
      target: request.target,
      capturedAt: "2026-08-14T12:00:00.000Z",
      width: 1,
      height: 1,
      mimeType: "image/png",
      imageBase64,
      ...overrides
    })
  };
}

function context(computerScreenProvider: ReturnType<typeof provider>) {
  return { stateDir: "/tmp/odinn-computer-screen-test", approvalStore: createApprovalStore(), computerScreenProvider };
}

function controlProvider(overrides: Record<string, unknown> = {}) {
  return {
    ...provider(),
    act: async (request: Record<string, any>) => ({
      status: "completed",
      target: request.target,
      beforeFrameId: request.frameId,
      afterFrame: await provider().capture({ target: request.target }),
      ...overrides
    }),
    recoveryStatus: async () => ({ unresolved: false }),
    resolveRecovery: async () => ({ status: "resolved" })
  };
}

async function assertTreeExcludes(root: string, markers: ReadonlyArray<Readonly<{ label: string; value: string }>>): Promise<void> {
  const inspect = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await inspect(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const content = await readFile(path);
      for (const marker of markers) {
        assert.equal(content.includes(Buffer.from(marker.value, "utf8")), false, `${marker.label} crossed the durable state boundary`);
      }
    }
  };
  await inspect(root);
}

test("computer.screen is target-bound and returns a bounded frame projection", async () => {
  let requestedTarget;
  const screenProvider = {
    ...provider(),
    capture: async (request: { target: typeof target; signal?: AbortSignal }) => {
      requestedTarget = request.target;
      return provider().capture(request);
    }
  };
  const tools = materializeHostCapabilityPlugin(computerScreenHostCapabilityPlugin, context(screenProvider));
  const result = await tools.get("computer.screen")?.execute({}, { signal: undefined });
  assert.deepEqual(requestedTarget, target);
  assert.deepEqual(result.target, { nodeId: "node-a", displayId: "display-1" });
  assert.equal(result.frameId, "frame-1");
  assert.equal(result.imageBase64, imageBase64);
  assert.equal("pairingGeneration" in result.target, false);
  const durable = projectDurableToolOutput("computer.screen", result) as Record<string, any>;
  assert.equal("imageBase64" in durable, false);
  assert.equal(durable.contentUnavailableOnReplay, true);
  assert.match(durable.imageDigest, /^sha256:/u);
});

test("computer.screen rejects a frame from a different node, display, or pairing generation", async () => {
  await assert.rejects(
    () => captureComputerScreen(provider({ target: { ...target, pairingGeneration: "pair-8" } }) as any),
    /does not match the paired host target/u
  );
});

test("computer.screen rejects pairing rotation while capture is in flight", async () => {
  let currentTarget = target;
  const rotatingProvider = {
    get target() {
      return currentTarget;
    },
    capture: async (request: { target: typeof target; signal?: AbortSignal }) => {
      currentTarget = { ...target, pairingGeneration: "pair-8" };
      return provider().capture(request);
    }
  };
  await assert.rejects(() => captureComputerScreen(rotatingProvider), /pairing target changed during capture/u);
});

test("computer.screen rejects unbounded or invalid frames", async () => {
  await assert.rejects(() => captureComputerScreen(provider({ width: 9_000 }) as any), /dimensions exceed/u);
  await assert.rejects(() => captureComputerScreen(provider({ imageBase64: "not base64" }) as any), /bounded base64/u);
  await assert.rejects(() => captureComputerScreen(provider({ mimeType: "image/webp" }) as any), /image type is unsupported/u);
});

test("computer.screen is not composed without a paired provider and requires an explicit capability grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-computer-screen-"));
  const stateDir = join(root, ".odinn");
  const absent = createBuiltInRegistry({ workspaceRoot: root, stateDir });
  assert.equal(absent.has("computer.screen"), false);
  absent.close();

  const noOptIn = createBuiltInRegistry({ workspaceRoot: root, stateDir, computerScreenProvider: provider() });
  assert.equal(noOptIn.has("computer.screen"), false);
  noOptIn.close();

  let closed = false;
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir,
    enableComputerScreen: true,
    computerScreenProvider: { ...provider(), close: () => { closed = true; } }
  });
  try {
    const tool = registry.get("computer.screen");
    assert.equal(typeof tool?.execute, "function");
    assert.deepEqual(tool.resourceForInput({}), target);
    const denied = evaluateTaskPolicy({
      policy: createDefaultPolicy(),
      request: { tool: "computer.screen", input: {} },
      tool
    });
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /computer\.read/u);
    const allowed = evaluateTaskPolicy({
      policy: createDefaultPolicy({ allowedCapabilities: ["computer.read"] }),
      request: { tool: "computer.screen", input: {} },
      tool
    });
    assert.equal(allowed.allowed, true);
    assert.deepEqual(tool.capabilities, ["computer.read"]);
    assert.deepEqual(COMPUTER_SCREEN_PLUGIN_MANIFEST.tools.map((entry) => entry.name), ["computer.screen"]);
    registry.close();
    assert.equal(closed, true);
    await assert.rejects(() => tool.execute({}, { signal: undefined }), /provider is closed/u);
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported platforms diagnose configured computer control without composing an ambient fallback", { skip: process.platform === "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-computer-unsupported-"));
  const stateDir = join(root, ".odinn");
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir,
    config: { integrations: { computer: { enabled: true, backend: "macos-local", nodeId: "studio", displayId: "main" } } }
  });
  try {
    assert.equal(registry.has("computer.screen"), false);
    assert.equal(registry.has("computer.act"), false);
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("computer control actions are strict and durable projections never retain typed text, keys, or pixels", () => {
  assert.deepEqual(normalizeComputerActionInput({ frameId: "frame-1", action: "click", x: 5, y: 9 }), {
    frameId: "frame-1",
    action: { action: "click", x: 5, y: 9, button: "left" }
  });
  assert.throws(() => normalizeComputerActionInput({ frameId: "frame-1", action: "click", x: 5, y: 9, text: "smuggled" }), /unsupported fields/u);
  assert.throws(() => normalizeComputerActionInput({ frameId: "frame-1", action: "key", key: "Control+Shift+Alt+Command+Option+X" }), /unsupported/u);
  assert.throws(() => normalizeComputerActionInput({ frameId: "frame-1", action: "scroll", deltaX: 0, deltaY: 0 }), /must not be zero/u);

  const durableInput = projectDurableToolInput("computer.act", {
    frameId: "frame-private",
    action: "type",
    text: "PRIVATE_TYPED_SECRET",
    sensitive: true
  }) as Record<string, unknown>;
  assert.equal(JSON.stringify(durableInput).includes("PRIVATE_TYPED_SECRET"), false);
  assert.equal(JSON.stringify(durableInput).includes("frame-private"), false);
  assert.match(String(durableInput.textDigest), /^sha256:/u);
  assert.match(String(durableInput.frameIdDigest), /^sha256:/u);

  const durableOutput = projectDurableToolOutput("computer.act", {
    type: "computer.act",
    status: "completed",
    action: "type",
    beforeFrameId: "frame-private",
    afterFrame: {
      type: "computer.screen",
      frameId: "frame-after",
      target,
      capturedAt: "2026-08-14T12:00:00.000Z",
      width: 1,
      height: 1,
      mimeType: "image/png",
      imageBase64
    }
  }) as Record<string, any>;
  const encoded = JSON.stringify(durableOutput);
  assert.equal(encoded.includes(imageBase64), false);
  assert.equal(encoded.includes("frame-private"), false);
  assert.equal(durableOutput.contentUnavailableOnReplay, true);
  assert.equal(durableOutput.afterFrame.contentUnavailableOnReplay, true);
  assert.equal(isReplayUnavailableTool("computer.act"), true);
});

test("computer.act requires one exact durable approval, binds the paired frame, and never replays the provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-computer-control-"));
  const stateDir = join(root, ".odinn");
  const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const runtime = createDifferentiatedRuntime({
    stateDir,
    workspaceRoot: root,
    featureFlags: { capabilities: false, capsules: false, counterfactual: false }
  });
  let actions = 0;
  let closed = false;
  const paired = {
    ...controlProvider(),
    act: async (request: Record<string, any>) => {
      actions += 1;
      return controlProvider().act(request);
    },
    close: () => { closed = true; }
  };
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir,
    approvalStore,
    auditStore,
    enableComputerScreen: true,
    computerControlProvider: paired
  });
  t.after(async () => {
    registry.close();
    auditStore.close();
    runtime.ledger.close();
    await rm(root, { recursive: true, force: true });
  });

  assert.deepEqual(COMPUTER_CONTROL_PLUGIN_MANIFEST.tools.map((entry) => entry.name), ["computer.act", "computer.recovery.status", "computer.recovery.resolve"]);
  assert.deepEqual(registry.get("computer.act")?.resourceForInput({ frameId: "frame-1" }), { ...target, frameId: "frame-1" });
  assert.equal(registry.has("computer.recovery.status"), true);
  assert.equal(registry.has("computer.recovery.resolve"), true);
  const policy = createDefaultPolicy({ allowedCapabilities: ["computer.read", "computer.mutate"] });
  const input = { frameId: "frame-1", action: "type", text: "one approved value", sensitive: true };
  const options = { auditStore, approvalStore, policy, registry, runLedger: runtime.ledger, durableExecution: true };
  const first = await runTask({ ...options, task: { id: "computer-action-1", tool: "computer.act", input, actor: "operator" } });
  assert.equal(first.output.type, "approval.required");
  assert.equal(actions, 0);
  const persistedApproval = await readFile(join(stateDir, "approvals.json"), "utf8");
  assert.equal(persistedApproval.includes("one approved value"), false);
  assert.equal(persistedApproval.includes("frame-1"), false);
  assert.match(persistedApproval, /textDigest/u);
  assert.match(persistedApproval, /frameIdDigest/u);
  const approvalSummary = approvalStore.list().find((entry) => entry.id === first.output.approvalId);
  assert.equal(approvalSummary?.effect?.mutation, "type");
  assert.match(String(approvalSummary?.effect?.summary), /approved type computer input/u);
  const approvalId = first.output.approvalId as string;
  assert.ok(approvalStore.claim(approvalId));
  await assert.rejects(
    runTask({
      ...options,
      task: { id: "computer-action-1", tool: "computer.act", input: { ...input, frameId: "frame-stale" }, actor: "operator" },
      trustedApprovalId: approvalId,
      trustedApprovalRunId: "computer-action-1",
      trustedRecovery: true
    }),
    (error: any) => error.code === "APPROVAL_CONTINUATION_DENIED"
  );
  assert.equal(actions, 0);
  const second = await runTask({
    ...options,
    task: { id: "computer-action-1", tool: "computer.act", input: { ...input, confirmed: true, approvalId: "untrusted-hint" }, actor: "operator" },
    trustedApprovalId: approvalId,
    trustedApprovalRunId: "computer-action-1"
  });
  assert.equal(second.output.status, "completed");
  assert.equal(actions, 1);
  const replay = await runTask({ ...options, task: { id: "computer-action-1", tool: "computer.act", input, actor: "operator" } });
  assert.equal(replay.replayed, true);
  assert.equal(replay.contentUnavailableOnReplay, true);
  assert.equal(actions, 1);

  const recoveryTool = registry.get("computer.recovery.status")!;
  registry.close();
  assert.equal(closed, true);
  await assert.rejects(() => recoveryTool.execute({}, {}), /provider is closed/u);
});

test("computer.act capability authority is broker-only and exact approval continuation consumes it once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-computer-capability-"));
  const stateDir = join(root, ".odinn");
  const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const runtime = createDifferentiatedRuntime({
    stateDir,
    workspaceRoot: root,
    featureFlags: { capabilities: true, capsules: false, counterfactual: false }
  });
  let currentTarget = target;
  let actions = 0;
  let dispatchedRequest: Record<string, any> | undefined;
  const paired = {
    ...controlProvider(),
    get target() { return currentTarget; },
    act: async (request: Record<string, any>) => {
      actions += 1;
      dispatchedRequest = request;
      return controlProvider().act(request);
    }
  };
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir,
    approvalStore,
    auditStore,
    enableComputerScreen: true,
    computerControlProvider: paired
  });
  t.after(async () => {
    registry.close();
    auditStore.close();
    runtime.ledger.close();
    await rm(root, { recursive: true, force: true });
  });

  const runId = "computer-capability-exact";
  const actor = "desktop-operator";
  const typedText = "typed-value-that-must-not-persist-71f9";
  const businessInput = { frameId: "frame-1", action: "type", text: typedText, sensitive: true };
  runtime.ledger.ensureRun({ runId, objective: "perform one exact governed desktop action" });
  const issued = runtime.capabilities.issue({
    runId,
    stepId: "desktop-action",
    toolName: "computer.act",
    resourceConstraints: { ...target, frameId: businessInput.frameId },
    maxUses: 1
  });
  const input = { ...businessInput, capabilityToken: issued.token };
  const options = {
    auditStore,
    approvalStore,
    policy: createDefaultPolicy({ allowedCapabilities: ["computer.read", "computer.mutate"] }),
    registry,
    runLedger: runtime.ledger,
    durableExecution: true
  };

  const first = await runTask({ ...options, task: { id: runId, tool: "computer.act", input, actor } });
  assert.equal(first.output.type, "approval.required");
  assert.equal(actions, 0);
  assert.equal(runtime.capabilities.list(runId)[0].uses, 0, "approval creation validates but must not consume authority");
  assert.equal(runtime.capabilities.list(runId)[0].status, "active");
  const approvalId = first.output.approvalId as string;
  assert.ok(approvalStore.claim(approvalId));
  assert.deepEqual(approvalStore.recover(approvalId)?.input, businessInput, "the trusted approval stores only business input");
  const publicApproval = JSON.stringify(approvalStore.list());
  assert.equal(publicApproval.includes(issued.token), false);
  assert.equal(publicApproval.includes(typedText), false);
  assert.equal(publicApproval.includes("capabilityToken"), false);
  await assertTreeExcludes(stateDir, [
    { label: "capability token", value: issued.token },
    { label: "typed computer text", value: typedText }
  ]);

  for (const changedInput of [
    { ...input, frameId: "frame-stale" },
    { frameId: "frame-1", action: "key", key: "Enter", capabilityToken: issued.token }
  ]) {
    await assert.rejects(
      runTask({
        ...options,
        task: { id: runId, tool: "computer.act", input: changedInput, actor },
        trustedApprovalId: approvalId,
        trustedApprovalRunId: runId,
        trustedRecovery: true
      }),
      (error: any) => error.code === "APPROVAL_CONTINUATION_DENIED"
    );
  }
  await assert.rejects(
    runTask({
      ...options,
      task: { id: runId, tool: "computer.act", input, actor },
      trustedApprovalId: "approval_forged",
      trustedApprovalRunId: runId,
      trustedRecovery: true
    }),
    (error: any) => error.code === "APPROVAL_CONTINUATION_DENIED"
  );
  assert.equal(actions, 0);
  assert.equal(runtime.capabilities.list(runId)[0].uses, 0);

  const second = await runTask({
    ...options,
    task: { id: runId, tool: "computer.act", input, actor },
    trustedApprovalId: approvalId,
    trustedApprovalRunId: runId
  });
  assert.equal(second.output.status, "completed");
  assert.equal(actions, 1);
  assert.equal(runtime.capabilities.list(runId)[0].uses, 1);
  assert.equal(runtime.capabilities.list(runId)[0].status, "consumed");
  assert.equal("capabilityToken" in (dispatchedRequest ?? {}), false, "authority must not reach the computer provider");
  assert.deepEqual(dispatchedRequest?.target, target);
  assert.equal(dispatchedRequest?.frameId, businessInput.frameId);
  const capabilityUse = runtime.ledger.database.db.prepare("SELECT resource_json FROM capability_uses WHERE capability_id = ?").get(issued.claims.id) as { resource_json: string };
  assert.deepEqual(JSON.parse(capabilityUse.resource_json), { ...target, frameId: businessInput.frameId });

  await assert.rejects(
    runTask({
      ...options,
      task: { id: runId, tool: "computer.act", input, actor },
      trustedApprovalId: approvalId,
      trustedApprovalRunId: runId,
      trustedRecovery: true
    }),
    (error: any) => error.code === "APPROVAL_CONTINUATION_DENIED"
  );
  assert.throws(
    () => runtime.capabilities.consume(issued.token, { runId, toolName: "computer.act", resource: { ...target, frameId: businessInput.frameId } }),
    (error: any) => error.code === "CAPABILITY_DENIED"
  );
  const replay = await runTask({
    ...options,
    task: { id: runId, tool: "computer.act", input: businessInput, actor }
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.contentUnavailableOnReplay, true);
  assert.equal(actions, 1, "completed replay must not call the computer provider");
  await assertTreeExcludes(stateDir, [
    { label: "capability token", value: issued.token },
    { label: "typed computer text", value: typedText }
  ]);

  const targetRunId = "computer-capability-target-rotation";
  runtime.ledger.ensureRun({ runId: targetRunId, objective: "reject a changed paired target" });
  const targetIssued = runtime.capabilities.issue({
    runId: targetRunId,
    stepId: "desktop-target",
    toolName: "computer.act",
    resourceConstraints: { ...target, frameId: "frame-1" },
    maxUses: 1
  });
  const targetInput = { frameId: "frame-1", action: "click", x: 0, y: 0, capabilityToken: targetIssued.token };
  const targetFirst = await runTask({ ...options, task: { id: targetRunId, tool: "computer.act", input: targetInput, actor } });
  const targetApprovalId = targetFirst.output.approvalId as string;
  assert.ok(approvalStore.claim(targetApprovalId));
  currentTarget = { ...target, pairingGeneration: "pair-rotated" };
  await assert.rejects(
    runTask({
      ...options,
      task: { id: targetRunId, tool: "computer.act", input: targetInput, actor },
      trustedApprovalId: targetApprovalId,
      trustedApprovalRunId: targetRunId
    }),
    (error: any) => error.code === "IDEMPOTENCY_CONFLICT"
  );
  assert.equal(runtime.capabilities.list(targetRunId)[0].uses, 0);
  assert.equal(actions, 1, "a changed node/display/pairing target must fail before provider dispatch");
});

test("computer.act refuses pairing rotation between capability consumption and provider dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-computer-dispatch-race-"));
  const stateDir = join(root, ".odinn");
  const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const runtime = createDifferentiatedRuntime({
    stateDir,
    workspaceRoot: root,
    featureFlags: { capabilities: true, capsules: false, counterfactual: false }
  });
  let currentTarget = target;
  let continuationTargetReads = 0;
  let rotateDuringContinuation = false;
  let actions = 0;
  const paired = {
    ...controlProvider(),
    get target() {
      if (rotateDuringContinuation && ++continuationTargetReads === 2) {
        currentTarget = { ...target, pairingGeneration: "pair-rotated-before-dispatch" };
      }
      return currentTarget;
    },
    act: async (request: Record<string, any>) => {
      actions += 1;
      return controlProvider().act(request);
    }
  };
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir,
    approvalStore,
    auditStore,
    enableComputerScreen: true,
    computerControlProvider: paired
  });
  t.after(async () => {
    registry.close();
    auditStore.close();
    runtime.ledger.close();
    await rm(root, { recursive: true, force: true });
  });

  const runId = "computer-capability-dispatch-race";
  const actor = "desktop-operator";
  const businessInput = { frameId: "frame-1", action: "click", x: 0, y: 0 };
  runtime.ledger.ensureRun({ runId, objective: "reject pairing rotation before provider dispatch" });
  const issued = runtime.capabilities.issue({
    runId,
    stepId: "desktop-action",
    toolName: "computer.act",
    resourceConstraints: { ...target, frameId: businessInput.frameId },
    maxUses: 1
  });
  const input = { ...businessInput, capabilityToken: issued.token };
  const options = {
    auditStore,
    approvalStore,
    policy: createDefaultPolicy({ allowedCapabilities: ["computer.read", "computer.mutate"] }),
    registry,
    runLedger: runtime.ledger,
    durableExecution: true
  };
  const first = await runTask({ ...options, task: { id: runId, tool: "computer.act", input, actor } });
  const approvalId = first.output.approvalId as string;
  assert.ok(approvalStore.claim(approvalId));
  rotateDuringContinuation = true;
  continuationTargetReads = 0;

  await assert.rejects(
    runTask({
      ...options,
      task: { id: runId, tool: "computer.act", input, actor },
      trustedApprovalId: approvalId,
      trustedApprovalRunId: runId
    }),
    /pairing target changed before provider dispatch/u
  );
  assert.equal(continuationTargetReads, 2, "the target is captured once and checked once immediately before dispatch");
  assert.equal(actions, 0, "a rotated target must never receive the approved action");
  assert.equal(runtime.capabilities.list(runId)[0].uses, 1, "the one-use capability is consumed before the final dispatch fence");
});

test("uncertain computer actions quarantine the durable attempt until operator resolution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-computer-recovery-"));
  const stateDir = join(root, ".odinn");
  const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const runtime = createDifferentiatedRuntime({ stateDir, workspaceRoot: root, featureFlags: { capabilities: false, capsules: false, counterfactual: false } });
  let unresolved = true;
  const paired = {
    ...controlProvider(),
    act: async (request: Record<string, any>) => ({ status: "needs-review", target: request.target, beforeFrameId: request.frameId, recoveryId: "recovery-1", reason: "transport-lost" }),
    recoveryStatus: async () => unresolved
      ? ({ unresolved: true, recoveryId: "recovery-1", frameId: "frame-1", action: "click", reason: "transport-lost" })
      : ({ unresolved: false }),
    resolveRecovery: async () => { unresolved = false; }
  };
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir, approvalStore, auditStore, enableComputerScreen: true, computerControlProvider: paired });
  t.after(async () => {
    registry.close();
    auditStore.close();
    runtime.ledger.close();
    await rm(root, { recursive: true, force: true });
  });
  const policy = createDefaultPolicy({ allowedCapabilities: ["computer.read", "computer.mutate"] });
  const input = { frameId: "frame-1", action: "click", x: 0, y: 0 };
  const options = { auditStore, approvalStore, policy, registry, runLedger: runtime.ledger, durableExecution: true };
  const first = await runTask({ ...options, task: { id: "computer-uncertain-1", tool: "computer.act", input, actor: "operator" } });
  const approvalId = first.output.approvalId as string;
  assert.ok(approvalStore.claim(approvalId));
  await assert.rejects(
    runTask({ ...options, task: { id: "computer-uncertain-1", tool: "computer.act", input, actor: "operator" }, trustedApprovalId: approvalId, trustedApprovalRunId: "computer-uncertain-1" }),
    (error: any) => error.code === "COMPUTER_OUTCOME_NEEDS_REVIEW"
  );
  assert.equal(runtime.ledger.listExecutionAttempts("computer-uncertain-1").at(-1)?.state, "needs-review");
  const status = await runTask({ ...options, task: { id: "computer-recovery-status-1", tool: "computer.recovery.status", input: {}, actor: "operator" } });
  assert.equal(status.output.unresolved, true);
  const resolved = await runTask({ ...options, task: { id: "computer-recovery-resolve-1", tool: "computer.recovery.resolve", input: { recoveryId: "recovery-1", outcome: "confirmed-not-applied" }, actor: "operator" } });
  assert.equal(resolved.output.status, "resolved");
  const after = await runTask({ ...options, task: { id: "computer-recovery-status-2", tool: "computer.recovery.status", input: {}, actor: "operator" } });
  assert.equal(after.output.unresolved, false);
});
