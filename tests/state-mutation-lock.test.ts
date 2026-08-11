import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { withStateMutationLock } from "../packages/kernel/src/index.ts";

test("state mutation lock serializes stale-owner recovery and recovers a crashed marker", async () => {
  const state = join(await mkdtemp(join(tmpdir(), "odinn-state-lock-recovery-")), "state");
  const lockPath = join(dirname(state), `.${basename(state)}.state-mutation.lock`);
  const owner = { token: "dead-primary", pid: 2_147_483_647, createdAt: new Date(0).toISOString() };
  const recoveryPath = join(dirname(state), `.odinn-lock-recovery.${createHash("sha256").update(`${lockPath}\0${owner.token}`).digest("hex")}`);
  await writeFile(lockPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  await writeFile(recoveryPath, `${JSON.stringify({
    token: "dead-recovery",
    pid: 2_147_483_647,
    createdAt: new Date(0).toISOString()
  })}\n`, { mode: 0o600 });

  let active = 0;
  let maximum = 0;
  const operations = ["one", "two"].map((value) => withStateMutationLock(state, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return value;
  }, { timeoutMs: 2_000 }));
  assert.deepEqual((await Promise.all(operations)).sort(), ["one", "two"]);
  assert.equal(maximum, 1);
  const files = await readdir(dirname(state));
  assert.equal(files.some((name) => name.startsWith(".odinn-stale-lock.")), true);
  assert.equal(files.some((name) => name === basename(lockPath)), false);
  assert.equal(await readOptional(lockPath), undefined);
});

test("state mutation stale recovery preserves the primary lock while a live recovery marker exists", async () => {
  const state = join(await mkdtemp(join(tmpdir(), "odinn-state-lock-contended-")), "state");
  const lockPath = join(dirname(state), `.${basename(state)}.state-mutation.lock`);
  const owner = { token: "dead-primary-contended", pid: 2_147_483_647, createdAt: new Date(0).toISOString() };
  const recoveryPath = join(dirname(state), `.odinn-lock-recovery.${createHash("sha256").update(`${lockPath}\0${owner.token}`).digest("hex")}`);
  await writeFile(lockPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  await writeFile(recoveryPath, `${JSON.stringify({ token: "live-recovery", pid: process.pid, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  await assert.rejects(
    () => withStateMutationLock(state, async () => undefined, { timeoutMs: 100 }),
    /state is busy/u
  );
  assert.deepEqual(JSON.parse((await readFile(lockPath, "utf8")).trim()), owner);
  assert.equal((await readdir(dirname(state))).some((name) => name.startsWith(".odinn-stale-lock.")), false);
});

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}
