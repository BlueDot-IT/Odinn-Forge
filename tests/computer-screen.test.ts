import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  COMPUTER_SCREEN_PLUGIN_MANIFEST,
  captureComputerScreen,
  computerScreenHostCapabilityPlugin,
  createApprovalStore,
  createBuiltInRegistry,
  materializeHostCapabilityPlugin
} from "../packages/kernel/src/index.ts";
import { createDefaultPolicy, evaluateTaskPolicy } from "../packages/policy/src/index.ts";
import { projectDurableToolOutput } from "../packages/protocol/src/index.ts";

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
