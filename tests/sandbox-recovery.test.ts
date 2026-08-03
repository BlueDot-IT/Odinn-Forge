import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SandboxRecoveryCoordinator,
  SandboxRecoveryError,
  type SandboxRecoveryAdapter
} from "../packages/kernel/src/sandbox-recovery.ts";
import { digestOciEngineBinding, reconcileSandboxRecovery, type OciLifecycleAdapter } from "../packages/kernel/src/sandbox-backend.ts";

function adapter(located: "present" | "absent" | "unknown", controls: string[] = []): SandboxRecoveryAdapter {
  return {
    control: async (_backend, args) => { controls.push(args.join(" ")); },
    locateManagedContainer: async () => located
  };
}

const reservation = {
  executionId: `sbxexec_${"a".repeat(32)}`,
  backend: "docker" as const,
  containerName: "odinn-recovery-fixture",
  engineBindingDigest: "d".repeat(64),
  profileDigest: "b".repeat(64),
  imageDigest: `sha256:${"c".repeat(64)}`
};

test("pre-create reservations survive interruption without persisting invocation data", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "odinn-sandbox-recovery-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const coordinator = new SandboxRecoveryCoordinator(state);
  await assert.rejects(
    coordinator.runExclusive(adapter("absent"), async (session) => {
      await session.reserve(reservation);
      throw new Error("simulated process interruption");
    }),
    /simulated process interruption/u
  );
  const raw = await readFile(join(state, "sandbox-recovery.json"), "utf8");
  const journal = JSON.parse(raw);
  assert.equal(journal.pending.length, 1);
  assert.equal(journal.pending[0].phase, "creating");
  assert.equal(raw.includes("secret"), false);
  assert.equal(raw.includes("stdin"), false);
  assert.equal(raw.includes("mount"), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(state)).mode & 0o777, 0o700);
    assert.equal((await stat(join(state, "sandbox-recovery.json"))).mode & 0o777, 0o600);
  }
});

test("unknown presence quarantines new work until exact absence proof succeeds", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "odinn-sandbox-quarantine-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const coordinator = new SandboxRecoveryCoordinator(state);
  await assert.rejects(coordinator.runExclusive(adapter("absent"), async (session) => {
    await session.reserve(reservation);
    throw new Error("crash");
  }));
  let entered = false;
  await assert.rejects(
    coordinator.runExclusive(adapter("unknown"), async () => { entered = true; }),
    (error: unknown) => error instanceof SandboxRecoveryError && error.code === "SANDBOX_RECOVERY_REQUIRED"
  );
  assert.equal(entered, false);
  const controls: string[] = [];
  let located = 0;
  const recovering: SandboxRecoveryAdapter = {
    control: async (_backend, args) => { controls.push(args.join(" ")); },
    locateManagedContainer: async () => located++ === 0 ? "present" : "absent"
  };
  await coordinator.runExclusive(recovering, async () => { entered = true; });
  assert.equal(entered, true);
  assert.deepEqual(controls.map((entry) => entry.split(" ")[0]), ["kill", "wait", "rm"]);
  assert.equal((await coordinator.status()).pending, 0);
});

test("sandbox execution lease serializes coordinators sharing one state root", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "odinn-sandbox-lease-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const first = new SandboxRecoveryCoordinator(state);
  const second = new SandboxRecoveryCoordinator(state);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let secondEntered = false;
  const active = first.runExclusive(adapter("absent"), async () => gate);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const waiting = second.runExclusive(adapter("absent"), async () => { secondEntered = true; });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(secondEntered, false);
  release();
  await active;
  await waiting;
  assert.equal(secondEntered, true);
});

test("corrupt and overly broad recovery journals fail closed", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "odinn-sandbox-corrupt-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const path = join(state, "sandbox-recovery.json");
  await writeFile(path, "{invalid", { mode: 0o600 });
  const coordinator = new SandboxRecoveryCoordinator(state);
  await assert.rejects(coordinator.runExclusive(adapter("absent"), async () => undefined), SandboxRecoveryError);
  if (process.platform !== "win32") {
    await writeFile(path, JSON.stringify({ schemaVersion: 1, namespaceId: `sbx_${"d".repeat(36)}`, pending: [] }));
    await chmod(path, 0o644);
    await assert.rejects(coordinator.runExclusive(adapter("absent"), async () => undefined), SandboxRecoveryError);
  }
});

test("recovery refuses to clear a record through a different configured engine binding", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "odinn-sandbox-engine-binding-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const oldEngine = "/opt/odinn-old/docker";
  const newEngine = "/opt/odinn-new/docker";
  const namespaceId = `sbx_${"a".repeat(36)}`;
  await writeFile(join(state, "sandbox-recovery.json"), `${JSON.stringify({
    schemaVersion: 1,
    namespaceId,
    pending: [{
      namespaceId,
      executionId: `sbxexec_${"b".repeat(32)}`,
      backend: "docker",
      containerName: "odinn-engine-binding-fixture",
      engineBindingDigest: digestOciEngineBinding("docker", oldEngine),
      profileDigest: "c".repeat(64),
      imageDigest: `sha256:${"d".repeat(64)}`,
      phase: "running",
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      reconciliationAttempts: 0
    }]
  }, null, 2)}\n`, { mode: 0o600 });
  let locateCalls = 0;
  const lifecycle: OciLifecycleAdapter = {
    prepare: async () => undefined,
    attestContainer: async () => undefined,
    spawn: () => { throw new Error("not used"); },
    control: async () => undefined,
    terminate: () => undefined,
    locateManagedContainer: async () => { locateCalls += 1; return "absent"; }
  };
  await assert.rejects(
    reconcileSandboxRecovery(state, { docker: newEngine }, lifecycle),
    (error: unknown) => error instanceof SandboxRecoveryError && error.code === "SANDBOX_RECOVERY_REQUIRED"
  );
  assert.equal(locateCalls, 0, "a different engine must not be asked to prove the old container absent");
  const journal = JSON.parse(await readFile(join(state, "sandbox-recovery.json"), "utf8"));
  assert.equal(journal.pending.length, 1);
  assert.equal(journal.pending[0].engineBindingDigest, digestOciEngineBinding("docker", oldEngine));
});
