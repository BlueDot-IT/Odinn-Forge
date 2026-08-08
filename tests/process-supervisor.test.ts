import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcessRecoveryError, ProcessSupervisor, createProcessExecutionDescriptor, type ProcessRecoveryAdapter } from "../packages/kernel/src/index.ts";
import { projectDurableToolInput, projectDurableToolOutput } from "../packages/protocol/src/index.ts";
import { executeWorkspaceProcess } from "../packages/kernel/src/workspace-tools.ts";

function descriptor(root: string) {
  return createProcessExecutionDescriptor({
    workspaceRoot: root,
    command: "node",
    args: ["-e", "process.stdout.write('private-process-input')"],
    cwd: ".",
    timeoutMs: 5_000,
    maxOutputBytes: 1_024,
    requestId: "process-run"
  });
}

test("process supervisor releases a reservation when cancellation wins before launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-process-prelaunch-cancel-"));
  const supervisor = new ProcessSupervisor(join(root, ".odinn"));

  await assert.rejects(
    supervisor.execute(descriptor(root), async (session) => {
      await session.abortBeforeLaunch();
      const error = new Error("process.exec cancelled");
      error.name = "AbortError";
      throw error;
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError"
  );
  assert.deepEqual(await supervisor.status(), { schemaVersion: 1, pending: 0 });
});

test("process supervisor records only bounded digests and clears a proven lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-process-supervisor-"));
  const live = new Set<string>();
  const adapter: ProcessRecoveryAdapter = {
    inspect: async (record) => live.has(record.executionId) ? "present" : "absent",
    terminate: async (record) => { live.delete(record.executionId); }
  };
  const supervisor = new ProcessSupervisor(join(root, ".odinn"), { adapter });
  const result = await supervisor.execute(descriptor(root), async (session) => {
    await session.markRunning(42);
    live.add(session.record.executionId);
    await session.markTerminating();
    live.delete(session.record.executionId);
    await session.settle();
    return "settled";
  });

  assert.equal(result, "settled");
  assert.deepEqual(await supervisor.status(), { schemaVersion: 1, pending: 0 });
  const journal = await readFile(join(root, ".odinn", "process-recovery.json"), "utf8");
  assert.doesNotMatch(journal, /private-process-input/u);
  assert.doesNotMatch(journal, /node/u);
});

test("process supervisor serializes launch and termination transitions without losing the pid", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-process-transition-race-"));
  const adapter: ProcessRecoveryAdapter = {
    inspect: async () => "absent",
    terminate: async () => undefined
  };
  const supervisor = new ProcessSupervisor(join(root, ".odinn"), { adapter });
  await supervisor.execute(descriptor(root), async (session) => {
    await Promise.all([session.markRunning(46), session.markTerminating()]);
    assert.equal(session.record.phase, "terminating");
    assert.equal(session.record.pid, 46);
    await session.settle();
  });
  assert.deepEqual(await supervisor.status(), { schemaVersion: 1, pending: 0 });
});

test("process supervisor proves and terminates a surviving process group before clearing", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-process-descendants-"));
  let present = true;
  let terminationCount = 0;
  const adapter: ProcessRecoveryAdapter = {
    inspect: async () => present ? "present" : "absent",
    terminate: async () => { terminationCount += 1; present = false; }
  };
  const supervisor = new ProcessSupervisor(join(root, ".odinn"), { adapter });
  await supervisor.execute(descriptor(root), async (session) => {
    await session.markRunning(47);
    await session.settle();
  });
  assert.equal(terminationCount, 1);
  assert.deepEqual(await supervisor.status(), { schemaVersion: 1, pending: 0 });
});

test("real supervised process cleanup includes a detached descendant on POSIX", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-process-descendant-real-"));
  const supervisor = new ProcessSupervisor(join(root, ".odinn"));
  const result = await executeWorkspaceProcess(root, {
    command: process.execPath,
    args: ["-e", "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100000)'], { stdio: 'ignore' }); child.unref();"],
    cwd: ".",
    timeoutMs: 5_000,
    maxOutputBytes: 1_024
  }, undefined, { supervisor, requestId: "real-descendant-cleanup" });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(await supervisor.status(), { schemaVersion: 1, pending: 0 });
});

test("process supervisor quarantines an uncertain outcome across restart reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-process-recovery-"));
  const live = new Set<string>();
  const adapter: ProcessRecoveryAdapter = {
    inspect: async (record) => live.has(record.executionId) ? "present" : "absent",
    terminate: async (record) => { live.delete(record.executionId); }
  };
  const supervisor = new ProcessSupervisor(join(root, ".odinn"), { adapter });
  await assert.rejects(
    supervisor.execute(descriptor(root), async (session) => {
      await session.markRunning(43);
      live.add(session.record.executionId);
      throw new Error("worker exited unexpectedly");
    }),
    /worker exited unexpectedly/u
  );
  assert.deepEqual(await supervisor.status(), { schemaVersion: 1, pending: 1 });

  live.clear();
  await assert.rejects(supervisor.reconcile(), (error: unknown) => error instanceof ProcessRecoveryError && error.code === "PROCESS_RECOVERY_REQUIRED");
  assert.deepEqual(await supervisor.status(), { schemaVersion: 1, pending: 1 });
  const journal = JSON.parse(await readFile(join(root, ".odinn", "process-recovery.json"), "utf8"));
  assert.equal(journal.pending[0].phase, "needs-review");
  assert.equal(journal.pending[0].reasonCode, "PROCESS_OUTCOME_UNCERTAIN");
});

test("workspace process execution can use the durable supervisor without activating the registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-process-exec-"));
  const supervisor = new ProcessSupervisor(join(root, ".odinn"));
  const result = await executeWorkspaceProcess(root, {
    command: process.execPath,
    args: ["-e", "process.stdout.write('ODINN_PROCESS_SUPERVISOR_OK')"],
    cwd: ".",
    timeoutMs: 5_000,
    maxOutputBytes: 1_024
  }, undefined, { supervisor, requestId: "supervised-process" });

  assert.equal(result.stdout, "ODINN_PROCESS_SUPERVISOR_OK");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(await supervisor.status(), { schemaVersion: 1, pending: 0 });
});

test("process supervisor refuses to clear cleanup it cannot prove", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-process-uncertain-"));
  const adapter: ProcessRecoveryAdapter = {
    inspect: async () => "unknown",
    terminate: async () => undefined
  };
  const supervisor = new ProcessSupervisor(join(root, ".odinn"), { adapter });
  await assert.rejects(
    supervisor.execute(descriptor(root), async (session) => {
      await session.markRunning(44);
      await session.settle();
    }),
    (error: unknown) => error instanceof ProcessRecoveryError && error.code === "PROCESS_CLEANUP_UNCERTAIN"
  );
  assert.deepEqual(await supervisor.status(), { schemaVersion: 1, pending: 1 });
});

test("supervised timeout and output termination settle the physical process", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-process-limits-"));
  const supervisor = new ProcessSupervisor(join(root, ".odinn"));
  const result = await executeWorkspaceProcess(root, {
    command: process.execPath,
    args: ["-e", "setInterval(() => process.stdout.write('x'.repeat(512)), 1)"],
    cwd: ".",
    timeoutMs: 2_000,
    maxOutputBytes: 1_024
  }, undefined, { supervisor, requestId: "limited-process" });

  assert.equal(result.outputTruncated, true);
  assert.deepEqual(await supervisor.status(), { schemaVersion: 1, pending: 0 });
});

test("process identity mismatch is treated as absence, never as permission to kill a reused pid", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-process-pid-reuse-"));
  let terminated = false;
  const adapter: ProcessRecoveryAdapter = {
    inspect: async (record) => record.processIdentity === "expected-start" ? "present" : "absent",
    terminate: async () => { terminated = true; }
  };
  const supervisor = new ProcessSupervisor(join(root, ".odinn"), { adapter });
  await supervisor.writeJournal({
    schemaVersion: 1,
    namespaceId: "pex_000000000000000000000000000000000000",
    pending: [{
      ...descriptor(root),
      schemaVersion: 1,
      namespaceId: "pex_000000000000000000000000000000000000",
      executionId: "pexec_00000000000000000000000000000000",
      phase: "running",
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: 42,
      processIdentity: "old-start",
      reconciliationAttempts: 0
    }]
  });
  await assert.rejects(supervisor.reconcile(), /outcome require review/u);
  assert.equal(terminated, false);
  const journal = JSON.parse(await readFile(join(root, ".odinn", "process-recovery.json"), "utf8"));
  assert.equal(journal.pending[0].reasonCode, "PROCESS_OUTCOME_UNCERTAIN");
});

test("durable process projections retain digests and bounded metadata, never command or output text", () => {
  const input = projectDurableToolInput("process.exec", {
    command: "secret-command",
    args: ["--token=opaque-private-value"],
    cwd: "work",
    timeoutMs: 100,
    maxOutputBytes: 1024
  }) as Record<string, unknown>;
  const output = projectDurableToolOutput("process.exec", {
    command: "secret-command",
    args: ["--token=opaque-private-value"],
    cwd: "work",
    stdout: "private process output",
    stderr: "private process error",
    exitCode: 0,
    stdoutBytes: 22,
    stderrBytes: 21,
    timedOut: false,
    outputTruncated: false,
    durationMs: 10
  }) as Record<string, unknown>;

  assert.equal("command" in input, false);
  assert.equal("args" in input, false);
  assert.equal("stdout" in output, false);
  assert.equal("stderr" in output, false);
  assert.doesNotMatch(JSON.stringify({ input, output }), /secret-command|opaque-private-value|private process/u);
  assert.equal(typeof input.commandDigest, "string");
  assert.equal(typeof output.stdoutDigest, "string");

  const hostileProjection = projectDurableToolInput("process.exec", {
    cwd: { secret: "private-cwd" },
    timeoutMs: "private-timeout",
    env: { SECRET: "private-env" },
    args: [{ secret: "private-arg" }]
  });
  const hostileOutput = projectDurableToolOutput("process.exec", {
    cwd: { secret: "private-output-cwd" },
    signal: { secret: "private-signal" },
    stdoutBytes: "private-byte-count",
    stdout: { secret: "private-output" }
  });
  assert.deepEqual(hostileProjection, {});
  assert.deepEqual(hostileOutput, {});
});
