import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CronStore, nextCronWake, runDueCronJobs } from "../apps/gateway/src/server.ts";
import { JobSupervisor } from "../packages/kernel/src/jobs.ts";
import { FileJobStore } from "../packages/store-file/src/index.ts";

async function cronStores() {
  const root = await mkdtemp(join(tmpdir(), "odinn-cron-claims-"));
  const path = join(root, "cron-jobs.json");
  return { left: new CronStore(path), right: new CronStore(path), path };
}

test("cron admission enforces five-field ranges, positive steps, and IANA timezones", async () => {
  const { left } = await cronStores();
  for (const schedule of ["*/0 * * * *", "-1 * * * *", "60 * * * *", "0 24 * * *", "0 0 32 * *", "0 0 * 13 *", "0 0 * * 7", "0 0 31 2 *"]) {
    await assert.rejects(
      () => left.create({ id: `invalid-${schedule.replaceAll(/\W/gu, "-")}`, schedule, timezone: "UTC", tool: "text.echo" }),
      /standard ranges|valid fields/u
    );
  }
  await assert.rejects(
    () => left.create({ id: "invalid-timezone", schedule: "0 9 * * 1-5", timezone: "Not/An_Iana_Zone", tool: "text.echo" }),
    /valid IANA timezone/u
  );
  const valid = await left.create({ id: "weekday", schedule: "0 9 * * 1-5", timezone: "America/New_York", tool: "text.echo" });
  assert.equal(valid.schemaVersion, 2);
  assert.equal(valid.timezone, "America/New_York");
  assert.ok(valid.nextRunAt);
});

test("two cron store instances claim one occurrence and recover the same stale lease", async () => {
  const { left, right } = await cronStores();
  const now = new Date("2026-08-01T12:00:30.000Z");
  await left.create({
    id: "minute-job",
    schedule: "* * * * *",
    timezone: "UTC",
    tool: "text.echo",
    input: { text: "once" },
    nextRunAt: "2026-08-01T12:00:00.000Z"
  });
  const [first, second] = await Promise.all([
    left.claimDueOccurrence("minute-job", now, "gateway:left"),
    right.claimDueOccurrence("minute-job", now, "gateway:right")
  ]);
  const winner = [first, second].find((claim) => claim.claimed);
  const loser = [first, second].find((claim) => !claim.claimed);
  assert.ok(winner?.occurrenceKey);
  assert.equal(loser?.alreadyDispatched, true);
  assert.equal(winner?.occurrenceKey, "cron:minute-job:2026-08-01T12:00:00.000Z");

  await left.update("minute-job", {
    dispatchLease: { ...winner.lease, expiresAt: "2026-08-01T11:59:00.000Z" },
    nextRunAt: "2026-08-01T12:01:00.000Z"
  });
  const recovered = await right.claimDueOccurrence("minute-job", now, "gateway:restarted");
  assert.equal(recovered.claimed, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.occurrenceKey, winner.occurrenceKey);
  assert.equal(recovered.scheduledFor, winner.scheduledFor);
});

test("a claimed occurrence is reused after restart without a second execution", async () => {
  const { left } = await cronStores();
  const now = new Date("2026-08-01T12:00:30.000Z");
  await left.create({ id: "restart-job", schedule: "* * * * *", timezone: "UTC", tool: "text.echo", nextRunAt: "2026-08-01T12:00:00.000Z" });
  const claim = await left.claimDueOccurrence("restart-job", now, "gateway:before-crash");
  assert.equal(claim.claimed, true);

  const root = await mkdtemp(join(tmpdir(), "odinn-cron-restart-"));
  const jobs = new FileJobStore(join(root, "jobs.json"));
  await jobs.create({
    id: claim.occurrenceKey,
    occurrenceKey: claim.occurrenceKey,
    scheduledFor: claim.scheduledFor,
    status: "running",
    payload: { task: { id: claim.occurrenceKey, tool: "text.echo", input: {}, actor: "cron" } },
    attempts: 1,
    retrySafe: false,
    timeoutMs: 120_000
  });
  let executions = 0;
  const restarted = new JobSupervisor({ store: jobs, execute: async () => { executions += 1; } });
  await restarted.start();
  const replay = await restarted.submit(
    { task: { id: claim.occurrenceKey, tool: "text.echo", input: {}, actor: "cron" } },
    { id: claim.occurrenceKey, occurrenceKey: claim.occurrenceKey, idempotent: true }
  );
  assert.equal(replay.status, "needs-review");
  assert.equal(executions, 0);
  await restarted.shutdown();
});

test("independent supervisors submit and execute one occurrence exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-cron-supervisors-"));
  const path = join(root, "jobs.json");
  const leftStore = new FileJobStore(path);
  const rightStore = new FileJobStore(path);
  let executions = 0;
  const execute = async () => {
    executions += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  const left = new JobSupervisor({ store: leftStore, execute });
  const right = new JobSupervisor({ store: rightStore, execute });
  await Promise.all([left.start(), right.start()]);
  const occurrenceKey = "cron:slow-job:2026-08-01T12:00:00.000Z";
  await Promise.all([
    left.submit({ task: { id: occurrenceKey, tool: "text.echo", input: {}, actor: "cron" } }, { id: occurrenceKey, occurrenceKey, idempotent: true }),
    right.submit({ task: { id: occurrenceKey, tool: "text.echo", input: {}, actor: "cron" } }, { id: occurrenceKey, occurrenceKey, idempotent: true })
  ]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await left.get(occurrenceKey))?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(executions, 1);
  assert.equal((await left.get(occurrenceKey))?.status, "completed");
  await Promise.all([left.shutdown(), right.shutdown()]);
});

test("duplicate polls submit N once and submit N+1 once while N remains held for 70 seconds", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-cron-poll-overlap-"));
  const cronPath = join(root, "cron-jobs.json");
  const jobsPath = join(root, "jobs.json");
  const leftCron = new CronStore(cronPath);
  const rightCron = new CronStore(cronPath);
  await leftCron.create({
    id: "seventy-second-job",
    schedule: "* * * * *",
    timezone: "UTC",
    tool: "text.echo",
    nextRunAt: "2026-08-01T12:00:00.000Z"
  });

  const executed: string[] = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const execute = async (_payload: unknown, context: { job: { occurrenceKey?: string } }) => {
    const key = String(context.job.occurrenceKey);
    executed.push(key);
    if (key.endsWith("12:00:00.000Z")) {
      markFirstStarted();
      await firstHeld;
    }
  };
  const left = new JobSupervisor({ store: new FileJobStore(jobsPath), execute, concurrency: 1 });
  const right = new JobSupervisor({ store: new FileJobStore(jobsPath), execute, concurrency: 1 });
  await Promise.all([left.start(), right.start()]);

  const occurrenceN = "cron:seventy-second-job:2026-08-01T12:00:00.000Z";
  const occurrenceN1 = "cron:seventy-second-job:2026-08-01T12:01:00.000Z";
  const firstTick = runDueCronJobs(leftCron, left, new Date("2026-08-01T12:00:30.000Z"));
  await firstStarted;
  const duplicateTick = runDueCronJobs(rightCron, right, new Date("2026-08-01T12:00:30.000Z"));
  await duplicateTick;
  const nextTick = runDueCronJobs(rightCron, right, new Date("2026-08-01T12:01:00.000Z"));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await right.get(occurrenceN1)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await right.get(occurrenceN1))?.status, "queued");
  assert.deepEqual(executed, [occurrenceN]);

  releaseFirst();
  await Promise.all([firstTick, nextTick]);
  assert.deepEqual(executed.sort(), [occurrenceN, occurrenceN1].sort());
  assert.equal((await left.get(occurrenceN))?.status, "completed");
  assert.equal((await left.get(occurrenceN1))?.status, "completed");
  await Promise.all([left.shutdown(), right.shutdown()]);
});

test("dispatch failure before job submission recovers the expired lease to the same occurrence key", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-cron-dispatch-recovery-"));
  const cron = new CronStore(join(root, "cron-jobs.json"));
  await cron.create({
    id: "recover-dispatch",
    schedule: "* * * * *",
    timezone: "UTC",
    tool: "text.echo",
    nextRunAt: "2026-08-01T12:00:00.000Z"
  });

  const failedSupervisor = {
    submit: async () => { throw new Error("synthetic failure before job submission"); }
  } as unknown as JobSupervisor;
  await runDueCronJobs(cron, failedSupervisor, new Date("2026-08-01T12:00:30.000Z"));
  const failedClaim = (await cron.list())[0];
  const occurrenceKey = "cron:recover-dispatch:2026-08-01T12:00:00.000Z";
  assert.equal(failedClaim.dispatchLease.occurrenceKey, occurrenceKey);

  await cron.update("recover-dispatch", {
    dispatchLease: { ...failedClaim.dispatchLease, expiresAt: "2026-08-01T12:00:59.000Z" }
  });
  let executions = 0;
  const supervisor = new JobSupervisor({
    store: new FileJobStore(join(root, "jobs.json")),
    execute: async (_payload, context) => {
      executions += 1;
      assert.equal(context.job.occurrenceKey, occurrenceKey);
    }
  });
  await supervisor.start();
  await runDueCronJobs(cron, supervisor, new Date("2026-08-01T12:01:00.000Z"));
  assert.equal(executions, 1);
  assert.equal((await supervisor.get(occurrenceKey))?.status, "completed");
  assert.equal((await cron.list())[0].dispatchLease, undefined);
  await supervisor.shutdown();
});

test("failure after durable submit but before acknowledgment reuses the job and clears the recovered lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-cron-submit-ack-recovery-"));
  const cron = new CronStore(join(root, "cron-jobs.json"));
  await cron.create({ id: "ack-crash", schedule: "* * * * *", timezone: "UTC", tool: "text.echo", nextRunAt: "2026-08-01T12:00:00.000Z" });
  const occurrenceKey = "cron:ack-crash:2026-08-01T12:00:00.000Z";
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let executions = 0;
  const supervisor = new JobSupervisor({
    store: new FileJobStore(join(root, "jobs.json")),
    execute: async () => { executions += 1; await held; }
  });
  await supervisor.start();
  const crashAfterSubmit = {
    submit: async (...args: Parameters<JobSupervisor["submit"]>) => {
      await supervisor.submit(...args);
      throw new Error("synthetic crash after durable submit before acknowledgment");
    }
  } as unknown as JobSupervisor;
  await runDueCronJobs(cron, crashAfterSubmit, new Date("2026-08-01T12:00:30.000Z"));
  const leased = (await cron.list())[0];
  assert.equal(leased.dispatchLease.occurrenceKey, occurrenceKey);
  await cron.update("ack-crash", { dispatchLease: { ...leased.dispatchLease, expiresAt: "2026-08-01T12:00:59.000Z" } });

  const recovered = runDueCronJobs(cron, supervisor, new Date("2026-08-01T12:01:00.000Z"));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await cron.list())[0].dispatchLease === undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await cron.list())[0].dispatchLease, undefined);
  assert.equal(executions, 1);
  release();
  await recovered;
  assert.equal((await supervisor.get(occurrenceKey))?.status, "completed");
  await supervisor.shutdown();
});

test("out-of-order cron outcomes preserve the newest occurrence result", async () => {
  const { left } = await cronStores();
  await left.create({ id: "outcomes", schedule: "* * * * *", timezone: "UTC", tool: "text.echo" });
  await left.recordOutcome("outcomes", "2026-08-01T12:01:00.000Z", { lastStatus: "ok", lastError: "" });
  await left.recordOutcome("outcomes", "2026-08-01T12:00:00.000Z", { lastStatus: "error", lastError: "older failure" });
  const persisted = (await left.list())[0];
  assert.equal(persisted.lastRunAt, "2026-08-01T12:01:00.000Z");
  assert.equal(persisted.lastStatus, "ok");
  assert.equal(persisted.lastError, "");
});

test("failed cron execution records an error after submission acknowledgment", async () => {
  const { left } = await cronStores();
  const now = new Date("2026-08-01T12:00:30.000Z");
  await left.create({ id: "failing-job", schedule: "* * * * *", timezone: "UTC", tool: "text.echo", nextRunAt: "2026-08-01T12:00:00.000Z" });
  const claim = await left.claimDueOccurrence("failing-job", now, "gateway:failure");
  const root = await mkdtemp(join(tmpdir(), "odinn-cron-failure-"));
  const jobs = new FileJobStore(join(root, "jobs.json"));
  const supervisor = new JobSupervisor({ store: jobs, execute: async () => { throw new Error("executor failed"); } });
  await supervisor.start();
  await supervisor.submit(
    { task: { id: claim.occurrenceKey, tool: "text.echo", input: {}, actor: "cron" } },
    { id: claim.occurrenceKey, occurrenceKey: claim.occurrenceKey, idempotent: true }
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await supervisor.get(claim.occurrenceKey))?.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const failed = await supervisor.get(claim.occurrenceKey);
  assert.equal(failed?.status, "failed");
  await left.acknowledgeSubmitted("failing-job", claim.occurrenceKey, claim.lease.token);
  await left.recordOutcome("failing-job", claim.scheduledFor, {
    lastStatus: "error",
    lastError: failed?.error || "unknown failure"
  });
  const persisted = (await left.list()).find((job) => job.id === "failing-job");
  assert.equal(persisted?.dispatchLease, undefined);
  assert.equal(persisted?.lastStatus, "error");
  await supervisor.shutdown();
});

test("next-wake hour jumps use the next local-hour boundary in UTC and fractional-offset zones", () => {
  assert.equal(nextCronWake("0 13 * * *", "UTC", new Date("2026-08-01T12:30:00.000Z")), "2026-08-01T13:00:00.000Z");
  assert.equal(nextCronWake("0 19 * * *", "Asia/Kolkata", new Date("2026-08-01T12:30:00.000Z")), "2026-08-01T13:30:00.000Z");
  assert.equal(nextCronWake("*/17 9-17 * * 1-5", "UTC", new Date("2026-08-03T00:00:00.000Z")), "2026-08-03T09:00:00.000Z");
});

test("impossible schedules fail the bounded next-wake calculation without a minute hot loop", () => {
  assert.equal(nextCronWake("0 0 31 2 *", "UTC", new Date("2026-08-01T00:00:00.000Z")), null);
});
