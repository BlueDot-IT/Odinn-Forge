import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createApprovalStore,
  createBuiltInRegistry,
  executeSandboxProcess,
  toolSafetyDescriptor
} from "../packages/kernel/src/index.ts";

const IMAGE = "docker.io/library/odinn-process@sha256:" + "a".repeat(64);

function config() {
  return {
    sandbox: {
      backend: { mode: "oci", preference: ["oci"], unavailable: "refuse", enginePaths: {} },
      process: {
        enabled: true,
        shell: true,
        image: IMAGE,
        limits: { timeoutMs: 20_000, cpu: 1, memoryBytes: 128 * 1024 * 1024, pids: 64, tmpfsBytes: 8 * 1024 * 1024, outputBytes: 32_000 }
      }
    }
  };
}

test("strict process profile is network-denied, sealed, read-only, and backend-bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-process-root-"));
  const state = await mkdtemp(join(tmpdir(), "odinn-process-state-"));
  await writeFile(join(root, "input.txt"), "sealed\n");
  const bundleRoot = await mkdtemp(join(tmpdir(), "odinn-process-bundle-"));
  const calls: any[] = [];
  const backend = {
    id: "docker" as const,
    async probe() { throw new Error("not used"); },
    async execute(profile: any, options: any) {
      calls.push(profile);
      await options.onDispatchAuthorized?.({ backend: "docker", containerName: "odinn-test", profileDigest: profile.digest, controlsAttested: true });
      return {
        backend: "docker",
        containerName: "odinn-test",
        profileDigest: profile.digest,
        exitCode: 0,
        signal: null,
        stdout: "ok",
        stderr: "",
        stdoutBytes: 2,
        stderrBytes: 0,
        outputTruncated: false,
        timedOut: false,
        cancelled: false,
        cleanupUncertain: false,
        controlsAttested: true,
        cleanupDiagnostics: [],
        durationMs: 1
      };
    }
  };
  const bundle = async () => ({ digest: "b".repeat(64), path: bundleRoot, files: 1, bytes: 7 });
  const result = await executeSandboxProcess(
    { command: "/bin/echo", args: ["hello"], cwd: "." },
    { workspaceRoot: root, stateDir: state, config: config(), backend, materializeBundle: bundle as any },
    { onDispatchAuthorized: async () => undefined }
  );
  assert.equal(result.stdout, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].network, "denied");
  assert.deepEqual(Object.keys(calls[0].environment), []);
  assert.deepEqual(calls[0].mounts, [{ source: bundleRoot, target: "/workspace", access: "read-only" }]);
  assert.equal(calls[0].argv[0], "/bin/echo");
  assert.equal(calls[0].argv[1], "hello");
});

test("strict process execution refuses when no digest-pinned image is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-process-no-image-root-"));
  const state = await mkdtemp(join(tmpdir(), "odinn-process-no-image-state-"));
  await assert.rejects(
    executeSandboxProcess({ command: "/bin/true" }, { workspaceRoot: root, stateDir: state, config: { sandbox: { process: { enabled: true, shell: false } } } }),
    (error: any) => error.code === "SANDBOX_PROCESS_IMAGE_REQUIRED"
  );
});

test("strict process execution supports the default state-under-workspace layout without bundling state", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-process-default-layout-root-"));
  const state = join(root, ".odinn");
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(root, "input.txt"), "workspace\n");
  await writeFile(join(state, "approval-secret"), "must-not-enter-bundle\n");
  let bundlePath = "";
  const backend = {
    id: "docker" as const,
    async probe() { throw new Error("not used"); },
    async execute(profile: any) {
      bundlePath = profile.mounts[0].source;
      return {
        backend: "docker",
        containerName: "odinn-default-layout",
        profileDigest: profile.digest,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        outputTruncated: false,
        timedOut: false,
        cancelled: false,
        cleanupUncertain: false,
        controlsAttested: true,
        cleanupDiagnostics: [],
        durationMs: 1
      };
    }
  };

  await executeSandboxProcess({ command: "/bin/true" }, { workspaceRoot: root, stateDir: state, config: config(), backend });
  assert.ok(bundlePath);
  await assert.rejects(() => access(join(bundlePath, ".odinn")), { code: "ENOENT" });
});

test("process registry keeps direct execution refused and enforces one-use approval for durable jobs", async () => {
  const approvalStore = createApprovalStore();
  let executions = 0;
  const registry = createBuiltInRegistry({
    approvalStore,
    processExecutor: async () => { executions += 1; return { exitCode: 0 }; }
  });
  const tool = registry.get("process.exec");
  await assert.rejects(
    tool.execute({ command: "/bin/true" }, { request: { id: "direct" }, durableExecution: false }),
    /only through the durable \/jobs execution surface/
  );
  const pending = await tool.execute({ command: "/bin/true", args: ["opaque-private-command-contents"] }, { request: { id: "durable" }, durableExecution: true });
  assert.equal(pending.type, "approval.required");
  assert.equal(executions, 0);
  assert.doesNotMatch(JSON.stringify(approvalStore.list()), /opaque-private-command-contents/u);
  assert.ok(approvalStore.claim(pending.approvalId));
  const completed = await tool.execute(
    { command: "/bin/true", args: ["opaque-private-command-contents"] },
    { request: { id: "approval-attempt" }, durableExecution: true, trustedApprovalId: pending.approvalId, trustedApprovalRunId: "durable" }
  );
  assert.deepEqual(completed, { exitCode: 0 });
  assert.equal(executions, 1);
  await assert.rejects(
    tool.execute({ command: "/bin/true", args: ["opaque-private-command-contents"] }, { request: { id: "approval-attempt-2" }, durableExecution: true, trustedApprovalId: pending.approvalId, trustedApprovalRunId: "durable" }),
    /approval is missing, expired, already used/
  );
  assert.equal(toolSafetyDescriptor("process.exec", tool).requiresApproval, true);
  registry.close();
});
