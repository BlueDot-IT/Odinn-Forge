import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { JobSupervisor } from "../packages/kernel/src/jobs.ts";
import { ensureSecureStateDirectory, FileAuditStore, FileJobStore, isOwnerOnlyPath } from "../packages/store-file/src/index.ts";

const execFile = promisify(execFileCallback);

async function waitFor(check: any, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve: any) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for job state");
}

test("job supervisor persists completion and replays recovered work", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-jobs-"));
  const store = new FileJobStore(join(root, "jobs.json"));
  const supervisor = new JobSupervisor({
    store,
    execute: async (payload: any) => ({ echoed: payload.value })
  });
  await supervisor.start();
  const submitted = await supervisor.submit({ value: "ODINN_JOB_OK" }, { id: "job_persisted" });
  assert.equal(submitted.status, "queued");
  const completed = await waitFor(async () => (await supervisor.get("job_persisted"))?.status === "completed" ? supervisor.get("job_persisted") : undefined);
  assert.equal(completed.result.echoed, "ODINN_JOB_OK");
  assert.equal(await isOwnerOnlyPath(store.path), true);
  await supervisor.shutdown();

  const recoveredStore = new FileJobStore(join(root, "jobs-recovered.json"));
  await recoveredStore.create({ id: "job_crashed", status: "running", payload: { value: "recovered" }, attempts: 0, retrySafe: true });
  const recovered = new JobSupervisor({ store: recoveredStore, execute: async (payload: any) => payload });
  await recovered.start();
  const recoveredJob = await waitFor(async () => (await recovered.get("job_crashed"))?.status === "completed" ? recovered.get("job_crashed") : undefined);
  assert.equal(recoveredJob.result.value, "recovered");
  await recovered.shutdown();
});

test("job supervisor supports cancellation and timeout recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-jobs-control-"));
  const store = new FileJobStore(join(root, "jobs.json"));
  const supervisor = new JobSupervisor({
    store,
    maxAttempts: 1,
    execute: async (_payload: any, { signal }: any) => new Promise((resolve: any, reject: any) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  });
  await supervisor.start();
  await supervisor.submit({ action: "cancel" }, { id: "job_cancel" });
  await supervisor.cancel("job_cancel");
  assert.equal((await waitFor(async () => (await supervisor.get("job_cancel"))?.status === "cancelled" ? supervisor.get("job_cancel") : undefined)).status, "cancelled");

  await supervisor.submit({ action: "timeout" }, { id: "job_timeout", timeoutMs: 10, retrySafe: true });
  const failed = await waitFor(async () => (await supervisor.get("job_timeout"))?.status === "failed" ? supervisor.get("job_timeout") : undefined);
  assert.match(failed.error, /timed out|aborted/);
  await supervisor.shutdown();
});

test("job supervisor does not requeue or start work after shutdown begins", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-jobs-shutdown-"));
  const store = new FileJobStore(join(root, "jobs.json"));
  let executions = 0;
  const supervisor = new JobSupervisor({
    store,
    maxAttempts: 3,
    execute: async (_payload: any, { signal }: any) => {
      executions += 1;
      await new Promise((resolve: any, reject: any) => {
        const timer = setTimeout(resolve, 100);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
    }
  });
  await supervisor.start();
  await supervisor.submit({}, { id: "job_shutdown" });
  await supervisor.shutdown();
  await new Promise((resolve: any) => setTimeout(resolve, 50));
  assert.equal(executions, 1);
  assert.equal((await supervisor.get("job_shutdown")).status, "needs-review");
});

test("job supervisor never retries unsafe failures and quarantines unknown outcomes", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-jobs-unsafe-"));
  const store = new FileJobStore(join(root, "jobs.json"));
  let executions = 0;
  const supervisor = new JobSupervisor({
    store,
    maxAttempts: 3,
    execute: async (_payload: any, { signal }: any) => {
      executions += 1;
      await new Promise((resolve: any, reject: any) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
  });
  await supervisor.start();
  await supervisor.submit({ action: "external-write" }, { id: "job_unsafe_timeout", timeoutMs: 10 });
  const review = await waitFor(async () => (await supervisor.get("job_unsafe_timeout"))?.status === "needs-review" ? supervisor.get("job_unsafe_timeout") : undefined);
  assert.equal(review.attempts, 1);
  assert.equal(executions, 1);
  await supervisor.shutdown();
});

test("file stores expose explicit corruption recovery without hiding the damaged source", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-store-recovery-"));
  const path = join(root, "jobs.json");
  await writeFile(path, "{not-json}\n");
  const store = new FileJobStore(path);
  await assert.rejects(() => store.list(), /store is corrupted/);
  const recovered = await store.recoverCorruption();
  assert.equal(recovered.recovered, true);
  assert.deepEqual(await store.list(), []);
});

test("audit journals rotate keys and verify signed records across retired keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-audit-keys-"));
  const path = join(root, "audit.jsonl");
  const store = new FileAuditStore(path);
  await store.append({ runId: "run-a", type: "task.started", data: { message: "before rotation" } });
  const rotation = await store.rotateKey();
  await store.append({ runId: "run-b", type: "task.completed", data: { message: "after rotation" } });
  const verified = await store.verifyIntegrity({ allowUnsigned: false });
  assert.equal(verified.valid, true);
  assert.equal(verified.retiredKeyIds.length, 1);
  const content = await readFile(path, "utf8");
  await writeFile(path, content.replace("after rotation", "tampered"));
  const tampered = await store.verifyIntegrity({ allowUnsigned: false });
  assert.equal(tampered.valid, false);
  assert.equal(rotation.retiredKeyIds.length, 1);
});

test("independent audit store instances serialize one signed chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-audit-concurrent-"));
  const path = join(root, "audit.jsonl");
  const left = new FileAuditStore(path);
  const right = new FileAuditStore(path);
  await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? left : right).append({
    runId: `run-concurrent-${index}`,
    type: "task.completed",
    data: { index }
  })));
  const verification = await left.verifyIntegrity({ allowUnsigned: false });
  assert.equal(verification.events, 40);
  assert.equal(verification.valid, true);
  assert.deepEqual(verification.failures, []);
});

test("independent job stores serialize asynchronous mutations without losing state", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-job-store-concurrent-"));
  const path = join(root, "jobs.json");
  const left = new FileJobStore(path);
  const right = new FileJobStore(path);
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let secondFinished = false;

  const first = left.mutate(async (state: any) => {
    await firstCanFinish;
    state.jobs.first = {
      id: "first", status: "queued", payload: {}, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), attempts: 0, timeoutMs: 1_000, retrySafe: true
    };
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = right.create({ id: "second", status: "queued", payload: {} }).then(() => { secondFinished = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(secondFinished, false);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual((await left.list()).map((job: any) => job.id).sort(), ["first", "second"]);
});

test("job store readers never observe an empty state while Windows-compatible replacement runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-job-store-readers-"));
  const store = new FileJobStore(join(root, "jobs.json"));
  await store.create({ id: "persistent", status: "queued", payload: {} });
  let emptyObservation = false;
  let pendingWrites = 8;
  const writes = Array.from({ length: 8 }, async (_, index) => {
    await store.update("persistent", { status: index % 2 ? "running" : "queued" });
  }).map((write) => write.finally(() => { pendingWrites -= 1; }));
  const reader = (async () => {
    while (pendingWrites > 0) {
      if ((await store.list()).length === 0) emptyObservation = true;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  })();
  await Promise.all(writes);
  await reader;
  assert.equal(emptyObservation, false);
});

test("Windows state hardening removes pre-existing explicit foreign grants", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-windows-acl-"));
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot);
  await execFile(join(systemRoot, "System32", "icacls.exe"), [
    root,
    "/grant", "*S-1-1-0:(OI)(CI)R"
  ], { windowsHide: true });
  assert.equal(await isOwnerOnlyPath(root), false);
  await ensureSecureStateDirectory(root);
  assert.equal(await isOwnerOnlyPath(root), true);
});
