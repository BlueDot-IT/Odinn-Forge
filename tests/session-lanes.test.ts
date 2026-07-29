import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DurableSessionLaneScheduler,
  SessionLaneAdmissionError,
  SessionLaneDegradedError,
  SessionLaneOwnershipError,
  SessionLaneValidationError,
  validateSessionLaneKey
} from "../packages/kernel/src/session-lanes.ts";
import { FileJobStore } from "../packages/store-file/src/index.ts";

async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for session lane state");
}

async function store() {
  const root = await mkdtemp(join(tmpdir(), "odinn-session-lanes-"));
  return new FileJobStore(join(root, "jobs.json"));
}

class AdversarialJobStore {
  readonly delegate: FileJobStore;
  failRunningClaims = 0;
  failCompletions = 0;
  mutateRunningPayload = false;
  mutateCompletionTimeout = false;
  runningClaimCalls = 0;
  completionCalls = 0;
  needsReviewCalls = 0;
  recoverCalls = 0;
  runningClaimStarted: (() => void) | undefined;
  releaseRunningClaim: Promise<void> | undefined;
  listDelay: Promise<void> | undefined;

  constructor(delegate: FileJobStore) {
    this.delegate = delegate;
  }

  async create(job: any) {
    return this.delegate.create(job);
  }

  async update(id: string, patch: any) {
    if (patch.status === "running") {
      this.runningClaimCalls += 1;
      this.runningClaimStarted?.();
      if (this.releaseRunningClaim) await this.releaseRunningClaim;
      if (this.failRunningClaims > 0) {
        this.failRunningClaims -= 1;
        throw new Error("adversarial running claim failure");
      }
    }
    if (patch.status === "completed") {
      this.completionCalls += 1;
      if (this.failCompletions > 0) {
        this.failCompletions -= 1;
        throw new Error("adversarial completion failure");
      }
    }
    if (patch.status === "needs-review") this.needsReviewCalls += 1;
    let updated = await this.delegate.update(id, patch);
    if (patch.status === "running" && this.mutateRunningPayload) {
      updated = await this.delegate.update(id, {
        payload: { ...updated.payload, laneKey: "lane:store-mutated" }
      });
    }
    if (patch.status === "completed" && this.mutateCompletionTimeout) {
      updated = await this.delegate.update(id, { timeoutMs: updated.timeoutMs + 1 });
    }
    return updated;
  }

  async get(id: string) {
    return this.delegate.get(id);
  }

  async list() {
    if (this.listDelay) await this.listDelay;
    return this.delegate.list();
  }

  async recover() {
    this.recoverCalls += 1;
    throw new Error("generic recovery must not be called");
  }
}

test("session lane keys are strictly bounded ASCII identifiers", () => {
  assert.equal(validateSessionLaneKey("discord:guild-123.thread_4"), "discord:guild-123.thread_4");
  for (const laneKey of ["", "-leading", "has space", "snowman-☃", "a".repeat(129)]) {
    assert.throws(
      () => validateSessionLaneKey(laneKey),
      (error: unknown) => error instanceof SessionLaneValidationError && error.code === "INVALID_LANE_KEY"
    );
  }
});

test("same-lane work is strictly serialized in persisted creation order", async () => {
  const durable = await store();
  const order: string[] = [];
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    concurrency: 4,
    execute: async (payload) => {
      order.push(`start:${String(payload.name)}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
      order.push(`end:${String(payload.name)}`);
    }
  });
  await scheduler.submit("session:one", { name: "first" }, { id: "first" });
  await scheduler.submit("session:one", { name: "second" }, { id: "second" });
  await scheduler.start();
  await waitFor(async () => (await scheduler.get("second"))?.status === "completed" ? true : undefined);
  assert.deepEqual(order, ["start:first", "end:first", "start:second", "end:second"]);
  await scheduler.shutdown();
});

test("interleaved timestamp ties select each lane's lowest persisted sequence first", async () => {
  const durable = await store();
  const timestamp = "2026-07-29T00:00:00.000Z";
  await durable.create({
    id: "a-second",
    status: "queued",
    payload: { sessionLaneVersion: 1, laneKey: "lane:a", laneSequence: 2, input: { name: "second" } },
    createdAt: timestamp,
    updatedAt: timestamp
  });
  await durable.create({
    id: "m-other",
    status: "queued",
    payload: { sessionLaneVersion: 1, laneKey: "lane:b", laneSequence: 1, input: { name: "other" } },
    createdAt: timestamp,
    updatedAt: timestamp
  });
  await durable.create({
    id: "z-first",
    status: "queued",
    payload: { sessionLaneVersion: 1, laneKey: "lane:a", laneSequence: 1, input: { name: "first" } },
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const order: string[] = [];
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    concurrency: 1,
    execute: async (payload) => { order.push(String(payload.name)); }
  });
  await scheduler.start();
  await waitFor(async () => (await scheduler.get("a-second"))?.status === "completed" ? true : undefined);
  assert.deepEqual(order, ["other", "first", "second"]);
  await scheduler.shutdown();
});

test("different lanes run concurrently within the global bound", async () => {
  const durable = await store();
  let active = 0;
  let maximum = 0;
  const releases = new Map<string, () => void>();
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    concurrency: 2,
    execute: async (_payload, { laneKey }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.set(laneKey, resolve));
      active -= 1;
    }
  });
  await scheduler.submit("lane:a", {}, { id: "a" });
  await scheduler.submit("lane:b", {}, { id: "b" });
  await scheduler.submit("lane:c", {}, { id: "c" });
  await scheduler.start();
  await waitFor(async () => releases.size === 2 ? true : undefined);
  assert.equal(maximum, 2);
  assert.deepEqual([...releases.keys()].sort(), ["lane:a", "lane:b"]);
  releases.get("lane:a")?.();
  await waitFor(async () => releases.has("lane:c") ? true : undefined);
  releases.get("lane:b")?.();
  releases.get("lane:c")?.();
  await waitFor(async () => (await scheduler.get("c"))?.status === "completed" ? true : undefined);
  await scheduler.shutdown();
});

test("queued work recovers while interrupted running work is quarantined without retry", async () => {
  const durable = await store();
  const interruptedAt = new Date().toISOString();
  await durable.create({
    id: "interrupted",
    status: "running",
    payload: { sessionLaneVersion: 1, laneKey: "lane:recover", laneSequence: 1, input: { value: "running" } },
    attempts: 1,
    createdAt: interruptedAt,
    updatedAt: interruptedAt,
    startedAt: interruptedAt,
    retrySafe: true
  });
  await durable.create({
    id: "queued",
    status: "queued",
    payload: { sessionLaneVersion: 1, laneKey: "lane:queued", laneSequence: 1, input: { value: "queued" } },
    retrySafe: true
  });
  const seen: string[] = [];
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    execute: async (payload) => { seen.push(String(payload.value)); }
  });
  await scheduler.start();
  await waitFor(async () => {
    const jobs = await scheduler.list();
    return jobs.find((job) => job.id === "interrupted")?.status === "needs-review"
      && jobs.find((job) => job.id === "queued")?.status === "completed"
      ? true
      : undefined;
  });
  assert.deepEqual(seen, ["queued"]);
  assert.equal((await scheduler.get("interrupted"))?.attempts, 1);
  await scheduler.shutdown();
});

test("start rejects accidental shared stores before recovery or mutation", async () => {
  const durable = await store();
  await durable.create({ id: "ordinary-job", status: "queued", payload: { unrelated: true } });
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    execute: async () => undefined
  });
  await assert.rejects(
    () => scheduler.start(),
    (error: unknown) => error instanceof SessionLaneOwnershipError
  );
  assert.equal((await durable.get("ordinary-job"))?.status, "queued");
  assert.equal(scheduler.status().lifecycle, "stopped");
});

test("start rejects malformed durable envelope fields before changing any record", async () => {
  const base = {
    id: "valid-id",
    status: "queued",
    payload: { sessionLaneVersion: 1, laneKey: "lane:valid", laneSequence: 1, input: {} },
    attempts: 0,
    timeoutMs: 1_000,
    retrySafe: false
  };
  const cases = [
    { name: "job id", patch: { id: "invalid id" } },
    { name: "status", patch: { status: "mystery" } },
    { name: "request hash", patch: { requestHash: "invalid hash" } },
    { name: "attempts", patch: { attempts: -1 } },
    { name: "timeout", patch: { timeoutMs: 0 } },
    { name: "timestamp", patch: { createdAt: "not-a-timestamp" } },
    {
      name: "payload bytes",
      patch: {
        payload: {
          sessionLaneVersion: 1,
          laneKey: "lane:valid",
          laneSequence: 1,
          input: { data: "x".repeat(512) }
        }
      }
    }
  ];
  for (const { name, patch } of cases) {
    const durable = await store();
    const record = { ...base, ...patch };
    await durable.create(record);
    const scheduler = new DurableSessionLaneScheduler({
      store: durable,
      maxPayloadBytes: 128,
      maxPendingBytes: 128,
      execute: async () => undefined
    });
    await assert.rejects(
      () => scheduler.start(),
      (error: unknown) => error instanceof SessionLaneOwnershipError,
      name
    );
    assert.equal((await durable.get(String(record.id)))?.status, record.status, name);
  }
});

test("start rejects duplicate persisted sequence numbers within one lane", async () => {
  const durable = await store();
  for (const id of ["duplicate-a", "duplicate-b"]) {
    await durable.create({
      id,
      status: "queued",
      payload: { sessionLaneVersion: 1, laneKey: "lane:duplicate", laneSequence: 1, input: { id } }
    });
  }
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    execute: async () => undefined
  });
  await assert.rejects(
    () => scheduler.start(),
    (error: unknown) => error instanceof SessionLaneOwnershipError && /duplicate sequence/.test(error.message)
  );
  assert.deepEqual((await durable.list()).map((job) => job.status), ["queued", "queued"]);
});

test("a failed queued-to-running claim degrades once without leaking capacity or executing", async () => {
  const delegate = await store();
  const durable = new AdversarialJobStore(delegate);
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    execute: async () => { throw new Error("must not execute"); }
  });
  await scheduler.submit("lane:claim-failure", {}, { id: "claim-failure" });
  durable.failRunningClaims = 1;
  await assert.rejects(
    () => scheduler.start(),
    (error: unknown) => error instanceof SessionLaneDegradedError
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(scheduler.status(), {
    lifecycle: "started",
    degraded: true,
    degradedError: scheduler.status().degradedError,
    activeJobs: 0,
    lockedLanes: 0
  });
  assert.match(scheduler.status().degradedError ?? "", /queued-job claim/);
  assert.equal(durable.runningClaimCalls, 1);
  assert.equal((await durable.get("claim-failure"))?.status, "queued");
});

test("claim invariant validation rejects a store-persisted lane mutation before execute or lock derivation", async () => {
  const delegate = await store();
  const durable = new AdversarialJobStore(delegate);
  let executions = 0;
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    execute: async () => { executions += 1; }
  });
  await scheduler.submit("lane:original", { immutable: true }, { id: "mutated-claim" });
  durable.mutateRunningPayload = true;
  await assert.rejects(
    () => scheduler.start(),
    (error: unknown) => error instanceof SessionLaneDegradedError && /immutable request fields/.test(error.message)
  );
  assert.equal(executions, 0);
  assert.equal(scheduler.status().activeJobs, 0);
  assert.equal(scheduler.status().lockedLanes, 0);
  const persisted = await durable.get("mutated-claim");
  assert.equal((persisted?.payload as any).laneKey, "lane:store-mutated");
  assert.equal(persisted?.status, "running");
});

test("completion persistence failure never repeats execution and restart quarantines running", async () => {
  const delegate = await store();
  const durable = new AdversarialJobStore(delegate);
  let executions = 0;
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    execute: async () => {
      executions += 1;
      return { ok: true };
    }
  });
  await scheduler.submit("lane:completion-failure", {}, { id: "completion-failure" });
  durable.failCompletions = 1;
  await scheduler.start();
  await waitFor(async () => scheduler.status().degraded ? true : undefined);
  assert.equal(executions, 1);
  assert.equal((await durable.get("completion-failure"))?.status, "running");
  assert.equal(scheduler.status().activeJobs, 0);

  let recoveredExecutions = 0;
  const recovered = new DurableSessionLaneScheduler({
    store: durable,
    execute: async () => { recoveredExecutions += 1; }
  });
  await recovered.start();
  assert.equal((await durable.get("completion-failure"))?.status, "needs-review");
  assert.equal(recoveredExecutions, 0);
  assert.equal(durable.recoverCalls, 0);
  await recovered.shutdown();
});

test("terminal invariant validation degrades on a valid persisted immutable-field mutation", async () => {
  const delegate = await store();
  const durable = new AdversarialJobStore(delegate);
  let executions = 0;
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    execute: async () => { executions += 1; return "done"; }
  });
  await scheduler.submit("lane:terminal-mutation", {}, { id: "terminal-mutation", timeoutMs: 1_000 });
  durable.mutateCompletionTimeout = true;
  await scheduler.start();
  await waitFor(async () => scheduler.status().degraded ? true : undefined);
  assert.equal(executions, 1);
  assert.equal((await durable.get("terminal-mutation"))?.timeoutMs, 1_001);
  assert.match(scheduler.status().degradedError ?? "", /immutable request fields/);
});

test("multibyte execution errors are truncated to a valid UTF-8 byte bound", async () => {
  const durable = await store();
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    execute: async () => { throw new Error("💥".repeat(5_000)); }
  });
  await scheduler.submit("lane:utf8-error", {}, { id: "utf8-error" });
  await scheduler.start();
  const failed = await waitFor(async () => {
    const job = await scheduler.get("utf8-error");
    return job?.status === "failed" ? job : undefined;
  });
  assert.equal(Buffer.byteLength(String(failed.error), "utf8"), 8_192);
  assert.equal(String(failed.error).includes("�"), false);
  assert.equal(scheduler.status().degraded, false);
  await scheduler.shutdown();

  const recovered = new DurableSessionLaneScheduler({
    store: durable,
    execute: async () => undefined
  });
  await recovered.start();
  assert.equal(recovered.status().degraded, false);
  await recovered.shutdown();
});

test("failure, timeout, and cancellation isolate and release only their lanes", async () => {
  const durable = await store();
  const completed: string[] = [];
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    concurrency: 3,
    execute: async (payload, { signal, laneKey }) => {
      if (payload.action === "fail") throw new Error("deliberate failure");
      if (payload.action === "wait") {
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      completed.push(laneKey);
    }
  });
  await scheduler.submit("lane:fail", { action: "fail" }, { id: "fail" });
  await scheduler.submit("lane:fail", {}, { id: "after-fail" });
  await scheduler.submit("lane:timeout", { action: "wait" }, { id: "timeout", timeoutMs: 15 });
  await scheduler.submit("lane:timeout", {}, { id: "after-timeout" });
  await scheduler.submit("lane:cancel", { action: "wait" }, { id: "cancel" });
  await scheduler.submit("lane:cancel", {}, { id: "after-cancel" });
  await scheduler.submit("lane:healthy", {}, { id: "healthy" });
  await scheduler.start();
  await waitFor(async () => (await scheduler.get("cancel"))?.status === "running" ? true : undefined);
  await scheduler.cancel("cancel");
  await waitFor(async () => {
    const jobs = await scheduler.list();
    return ["after-fail", "after-timeout", "after-cancel", "healthy"].every(
      (id) => jobs.find((job) => job.id === id)?.status === "completed"
    ) ? true : undefined;
  });
  assert.equal((await scheduler.get("fail"))?.status, "failed");
  assert.equal((await scheduler.get("timeout"))?.status, "needs-review");
  assert.equal((await scheduler.get("cancel"))?.status, "cancelled");
  assert.deepEqual(completed.sort(), ["lane:cancel", "lane:fail", "lane:healthy", "lane:timeout"]);
  await scheduler.shutdown();
});

test("active cancellation races always settle to completed or cancelled, never cancelling", async () => {
  const durable = await store();
  const releases = new Map<string, () => void>();
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    concurrency: 12,
    execute: async (_payload, { signal, laneKey }) => {
      await new Promise<void>((resolve, reject) => {
        releases.set(laneKey, resolve);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  });
  const ids = Array.from({ length: 12 }, (_, index) => `cancel-race-${index}`);
  for (const id of ids) await scheduler.submit(`lane:${id}`, {}, { id });
  await scheduler.start();
  await waitFor(async () => {
    const jobs = await scheduler.list();
    return ids.every((id) => jobs.find((job) => job.id === id)?.status === "running") ? true : undefined;
  });
  const cancellations = ids.map((id) => scheduler.cancel(id));
  for (const release of releases.values()) release();
  const returned = await Promise.all(cancellations);
  assert.ok(returned.every((job) => ["completed", "cancelled"].includes(job.status)));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    (await scheduler.list()).filter((job) => ids.includes(job.id) && !["completed", "cancelled"].includes(job.status)).length,
    0
  );
  await scheduler.shutdown();
});

test("queued cancellation and dispatch claim serialize without resurrection", async () => {
  const delegate = await store();
  const durable = new AdversarialJobStore(delegate);
  let signalClaimStarted!: () => void;
  const claimStarted = new Promise<void>((resolve) => { signalClaimStarted = resolve; });
  let releaseClaim!: () => void;
  durable.runningClaimStarted = signalClaimStarted;
  durable.releaseRunningClaim = new Promise<void>((resolve) => { releaseClaim = resolve; });
  let executions = 0;
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    execute: async (_payload, { signal }) => {
      executions += 1;
      if (signal.aborted) throw signal.reason;
    }
  });
  await scheduler.submit("lane:claim-cancel", {}, { id: "claim-cancel" });
  const starting = scheduler.start();
  await claimStarted;
  const cancelling = scheduler.cancel("claim-cancel");
  releaseClaim();
  await starting;
  const terminal = await cancelling;
  assert.ok(["completed", "cancelled"].includes(terminal.status));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await durable.get("claim-cancel"))?.status, terminal.status);
  assert.equal(executions, 0);
  await scheduler.shutdown();
});

test("non-cooperative timeout releases global capacity but retains physical lane exclusion", async () => {
  const durable = await store();
  let releaseStuck!: () => void;
  const stuck = new Promise<void>((resolve) => { releaseStuck = resolve; });
  const started: string[] = [];
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    concurrency: 1,
    execute: async (payload) => {
      started.push(String(payload.name));
      if (payload.name === "stuck") await stuck;
    }
  });
  await scheduler.submit("lane:a", { name: "stuck" }, { id: "stuck", timeoutMs: 15 });
  await scheduler.submit("lane:a", { name: "same-lane" }, { id: "same-lane" });
  await scheduler.submit("lane:b", { name: "other-lane" }, { id: "other-lane" });
  await scheduler.start();
  await waitFor(async () => (await scheduler.get("other-lane"))?.status === "completed" ? true : undefined);
  assert.equal((await scheduler.get("stuck"))?.status, "needs-review");
  assert.equal((await scheduler.get("same-lane"))?.status, "queued");
  assert.deepEqual(started, ["stuck", "other-lane"]);
  assert.equal(scheduler.status().lockedLanes, 1);
  releaseStuck();
  await waitFor(async () => (await scheduler.get("same-lane"))?.status === "completed" ? true : undefined);
  assert.deepEqual(started, ["stuck", "other-lane", "same-lane"]);
  await scheduler.shutdown();
});

test("admission is bounded globally and per lane under concurrent submission", async () => {
  const durable = await store();
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    maxPending: 3,
    maxPendingPerLane: 2,
    execute: async () => undefined
  });
  await Promise.all([
    scheduler.submit("lane:a", {}, { id: "a1" }),
    scheduler.submit("lane:a", {}, { id: "a2" })
  ]);
  await assert.rejects(
    () => scheduler.submit("lane:a", {}, { id: "a3" }),
    (error: unknown) => error instanceof SessionLaneAdmissionError && error.code === "LANE_QUEUE_FULL"
  );
  await scheduler.submit("lane:b", {}, { id: "b1" });
  await assert.rejects(
    () => scheduler.submit("lane:c", {}, { id: "c1" }),
    (error: unknown) => error instanceof SessionLaneAdmissionError && error.code === "QUEUE_FULL"
  );
});

test("admission validates identifiers and bounds individual and aggregate payload bytes", async () => {
  const durable = await store();
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    maxPayloadBytes: 256,
    maxPendingBytes: 320,
    execute: async () => undefined
  });
  await assert.rejects(() => scheduler.submit("lane:valid", {}, { id: "has space" }), /job id/);
  await assert.rejects(() => scheduler.submit("lane:valid", {}, { requestHash: "has space" }), /requestHash/);
  await assert.rejects(
    () => scheduler.submit("lane:huge", { data: "x".repeat(512) }),
    (error: unknown) => error instanceof SessionLaneAdmissionError && error.code === "QUEUE_BYTES_FULL"
  );
  await scheduler.submit("lane:one", { data: "x".repeat(80) }, { id: "bytes-one" });
  await assert.rejects(
    () => scheduler.submit("lane:two", { data: "x".repeat(80) }, { id: "bytes-two" }),
    (error: unknown) => error instanceof SessionLaneAdmissionError && error.code === "QUEUE_BYTES_FULL"
  );
});

test("concurrent starts recover once and start/shutdown lifecycle races remain restartable", async () => {
  const delegate = await store();
  const durable = new AdversarialJobStore(delegate);
  const now = new Date().toISOString();
  await durable.create({
    id: "lifecycle-running",
    status: "running",
    payload: { sessionLaneVersion: 1, laneKey: "lane:lifecycle", laneSequence: 1, input: {} },
    attempts: 1,
    createdAt: now,
    updatedAt: now,
    startedAt: now
  });
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    execute: async () => undefined
  });
  await Promise.all([scheduler.start(), scheduler.start()]);
  assert.equal(durable.needsReviewCalls, 1);
  assert.equal(durable.recoverCalls, 0);
  await scheduler.shutdown();
  assert.equal(scheduler.status().lifecycle, "stopped");

  await Promise.all([scheduler.start(), scheduler.shutdown()]);
  assert.equal(scheduler.status().lifecycle, "stopped");
  await scheduler.start();
  assert.equal(scheduler.status().lifecycle, "started");
  await scheduler.shutdown();
});

test("shutdown aborts active work without starting queued same-lane work", async () => {
  const durable = await store();
  const started: string[] = [];
  const scheduler = new DurableSessionLaneScheduler({
    store: durable,
    execute: async (payload, { signal }) => {
      started.push(String(payload.name));
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  });
  await scheduler.submit("lane:shutdown", { name: "active" }, { id: "active" });
  await scheduler.submit("lane:shutdown", { name: "queued" }, { id: "queued" });
  await scheduler.start();
  await waitFor(async () => (await scheduler.get("active"))?.status === "running" ? true : undefined);
  await scheduler.shutdown();
  assert.deepEqual(started, ["active"]);
  assert.equal((await scheduler.get("active"))?.status, "needs-review");
  assert.equal((await scheduler.get("queued"))?.status, "queued");
});
