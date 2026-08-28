import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createMacOSComputerControlProvider,
  diagnoseMacOSComputerIntegration,
  normalizeMacOSComputerConfig,
  runComputerCommand,
  type ComputerCommandRequest
} from "../packages/kernel/src/index.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("macOS computer configuration is explicit, bounded, and platform-diagnostic", () => {
  assert.deepEqual(normalizeMacOSComputerConfig(undefined), { enabled: false, backend: "macos-local", nodeId: "local-macos", displayId: "main" });
  assert.deepEqual(normalizeMacOSComputerConfig({ enabled: true, backend: "macos-local", nodeId: "studio", displayId: "display-2" }), {
    enabled: true,
    backend: "macos-local",
    nodeId: "studio",
    displayId: "display-2"
  });
  assert.throws(() => normalizeMacOSComputerConfig({ enabled: true, executable: "/tmp/driver" }), /unsupported fields/u);
  assert.throws(() => normalizeMacOSComputerConfig({ enabled: true, backend: "shell" }), /must be macos-local/u);
  assert.throws(() => normalizeMacOSComputerConfig({ enabled: true, displayId: "marketing-display" }), /must be main or display-1/u);
  assert.equal(diagnoseMacOSComputerIntegration({ enabled: true }, { platform: "linux" }).reason, "platform-unsupported");
  assert.equal(diagnoseMacOSComputerIntegration({ enabled: false }).status, "disabled");
});

test("macOS provider binds actions to captured frames and persists only categorical uncertainty", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-macos-computer-"));
  const stateDir = join(root, ".odinn");
  let failAction = false;
  const scripts: string[] = [];
  const screenshotArguments: string[][] = [];
  const runner = async (request: ComputerCommandRequest) => {
    if (request.executable.endsWith("screencapture")) {
      screenshotArguments.push([...request.args]);
      await writeFile(request.args.at(-1)!, png, { mode: 0o600 });
    } else if (request.executable.endsWith("osascript")) {
      scripts.push(request.input ?? "");
      if (failAction) {
        const error = new Error("categorical timeout") as Error & { code?: string };
        error.code = "COMPUTER_COMMAND_TIMEOUT";
        throw error;
      }
    }
    return { stdout: "", stderr: "" };
  };
  const dependencies = { platform: "darwin" as const, runner, validateExecutable: () => undefined, now: () => "2026-08-27T12:00:00.000Z" };
  const config = { enabled: true, backend: "macos-local", nodeId: "studio", displayId: "display-2" };
  const provider = createMacOSComputerControlProvider(stateDir, config, dependencies);
  t.after(async () => {
    provider.close?.();
    await rm(root, { recursive: true, force: true });
  });

  const first = await provider.capture({ target: provider.target });
  assert.deepEqual(screenshotArguments[0]?.slice(0, 3), ["-x", "-D", "2"]);
  await assert.rejects(
    () => provider.act({ target: { ...provider.target, pairingGeneration: "rotated" }, frameId: String((first as any).frameId), action: { action: "click", x: 0, y: 0, button: "left" } }),
    /target does not match/u
  );
  await assert.rejects(
    () => provider.act({ target: provider.target, frameId: String((first as any).frameId), action: { action: "click", x: 1, y: 0, button: "left" } }),
    /outside the approved frame/u
  );
  const completed = await provider.act({ target: provider.target, frameId: String((first as any).frameId), action: { action: "click", x: 0, y: 0, button: "left" } }) as any;
  assert.equal(completed.status, "completed");
  assert.match(scripts[0]!, /CGEventCreateMouseEvent/u);
  await assert.rejects(
    () => provider.act({ target: provider.target, frameId: String((first as any).frameId), action: { action: "click", x: 0, y: 0, button: "left" } }),
    /frame is stale/u
  );

  const beforeType = await provider.capture({ target: provider.target });
  failAction = true;
  const uncertain = await provider.act({
    target: provider.target,
    frameId: String((beforeType as any).frameId),
    action: { action: "type", text: "PRIVATE_DESKTOP_SECRET", sensitive: true }
  }) as any;
  assert.equal(uncertain.status, "needs-review");
  assert.equal(uncertain.reason, "timeout");
  const recoveryPath = join(stateDir, "computer", "control-recovery.json");
  const stored = await readFile(recoveryPath, "utf8");
  assert.equal(stored.includes("PRIVATE_DESKTOP_SECRET"), false);
  assert.equal((await provider.recoveryStatus?.() as any).unresolved, true);
  await assert.rejects(
    () => provider.act({ target: provider.target, frameId: String((beforeType as any).frameId), action: { action: "wait", durationMs: 50 } }),
    /unresolved action/u
  );
  await provider.resolveRecovery?.({ recoveryId: uncertain.recoveryId, outcome: "confirmed-not-applied" });
  assert.equal((await provider.recoveryStatus?.() as any).unresolved, false);

  const generation = provider.target.pairingGeneration;
  provider.close?.();
  const reopened = createMacOSComputerControlProvider(stateDir, config, dependencies);
  assert.equal(reopened.target.pairingGeneration, generation);
  await assert.rejects(
    () => reopened.act({ target: reopened.target, frameId: String((beforeType as any).frameId), action: { action: "wait", durationMs: 50 } }),
    /frame is stale/u
  );
  reopened.close?.();
});

test("computer command runner starts with a fixed loader-free environment", { skip: process.platform === "win32" }, async () => {
  const result = await runComputerCommand({ executable: "/usr/bin/env", args: [], timeoutMs: 2_000 });
  const keys = result.stdout.trim().split("\n").filter(Boolean).map((line) => line.split("=", 1)[0]).sort();
  assert.deepEqual(keys, ["LANG", "PATH"]);
});

test("macOS provider quarantines cancellation after action dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-macos-computer-cancel-"));
  const stateDir = join(root, ".odinn");
  const controller = new AbortController();
  const runner = async (request: ComputerCommandRequest) => {
    if (request.executable.endsWith("screencapture")) await writeFile(request.args.at(-1)!, png, { mode: 0o600 });
    if (request.executable.endsWith("osascript")) {
      controller.abort();
      const error = new Error("cancelled after dispatch");
      error.name = "AbortError";
      throw error;
    }
    return { stdout: "", stderr: "" };
  };
  const provider = createMacOSComputerControlProvider(stateDir, { enabled: true, displayId: "main" }, {
    platform: "darwin",
    runner,
    validateExecutable: () => undefined
  });
  t.after(async () => {
    provider.close?.();
    await rm(root, { recursive: true, force: true });
  });
  const frame = await provider.capture({ target: provider.target });
  const result = await provider.act({
    target: provider.target,
    frameId: String((frame as any).frameId),
    action: { action: "type", text: "CANCELLED_PRIVATE_TEXT", sensitive: true },
    signal: controller.signal
  }) as any;
  assert.equal(result.status, "needs-review");
  assert.equal(result.reason, "cancelled-after-dispatch");
  const stored = await readFile(join(stateDir, "computer", "control-recovery.json"), "utf8");
  assert.equal(stored.includes("CANCELLED_PRIVATE_TEXT"), false);
});
