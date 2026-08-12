import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

test("state mutation lock release preserves a replacement owner", async () => {
  const state = join(await mkdtemp(join(tmpdir(), "odinn-state-lock-replacement-")), "state");
  const lockPath = join(dirname(state), `.${basename(state)}.state-mutation.lock`);
  const replacement = { token: "replacement-owner", pid: process.pid, createdAt: new Date().toISOString() };

  await withStateMutationLock(state, async () => undefined, {
    __testOnlyAfterLockRead: async () => {
      await rm(lockPath);
      await writeFile(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
    }
  });

  assert.deepEqual(JSON.parse((await readFile(lockPath, "utf8")).trim()), replacement);
  assert.equal((await readdir(dirname(state))).some((name) => name.includes(".release-")), false);
  await rm(lockPath);
});

test("state mutation lock retries a transient quarantine rename for the same owner", async () => {
  const state = join(await mkdtemp(join(tmpdir(), "odinn-state-lock-rename-retry-")), "state");
  let injected = false;
  await withStateMutationLock(state, async () => undefined, {
    __testOnlyWindowsFileSemantics: true,
    __testOnlyBeforeReleaseFileOperation: (operation, attempt) => {
      if (operation === "quarantine" && attempt === 0) {
        injected = true;
        throw fileError("EPERM");
      }
    }
  });
  assert.equal(injected, true);
  assert.equal(await readOptional(join(dirname(state), `.${basename(state)}.state-mutation.lock`)), undefined);
});

test("state mutation lock refuses a quarantine retry after owner replacement", async () => {
  const state = join(await mkdtemp(join(tmpdir(), "odinn-state-lock-rename-replaced-")), "state");
  const lockPath = join(dirname(state), `.${basename(state)}.state-mutation.lock`);
  const replacement = { token: "rename-replacement", pid: process.pid, createdAt: new Date().toISOString() };
  await withStateMutationLock(state, async () => undefined, {
    __testOnlyWindowsFileSemantics: true,
    __testOnlyBeforeReleaseFileOperation: async (operation, attempt) => {
      if (operation === "quarantine" && attempt === 0) {
        await rm(lockPath);
        await writeFile(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
        throw fileError("EPERM");
      }
    }
  });
  assert.deepEqual(JSON.parse((await readFile(lockPath, "utf8")).trim()), replacement);
  await rm(lockPath);
});

test("state mutation lock retries transient replacement restoration and removal", async () => {
  const state = join(await mkdtemp(join(tmpdir(), "odinn-state-lock-release-retry-")), "state");
  const lockPath = join(dirname(state), `.${basename(state)}.state-mutation.lock`);
  const replacement = { token: "release-replacement", pid: process.pid, createdAt: new Date().toISOString() };
  const injected = new Set<string>();
  await withStateMutationLock(state, async () => undefined, {
    __testOnlyAfterLockRead: async () => {
      await rm(lockPath);
      await writeFile(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
    },
    __testOnlyWindowsFileSemantics: true,
    __testOnlyBeforeReleaseFileOperation: (operation, attempt) => {
      if ((operation === "restore-link" || operation === "remove") && attempt === 0) {
        injected.add(operation);
        throw fileError("EBUSY");
      }
    }
  });
  assert.deepEqual([...injected].sort(), ["remove", "restore-link"]);
  assert.deepEqual(JSON.parse((await readFile(lockPath, "utf8")).trim()), replacement);
  assert.equal((await readdir(dirname(state))).some((name) => name.includes(".release-")), false);
  await rm(lockPath);
});

test("state mutation lock publishes a blocking owner after persistent link failure", async () => {
  const state = join(await mkdtemp(join(tmpdir(), "odinn-state-lock-restore-fallback-")), "state");
  const lockPath = join(dirname(state), `.${basename(state)}.state-mutation.lock`);
  const replacement = { token: "fallback-replacement", pid: process.pid, createdAt: new Date().toISOString() };
  let restoreMarkerAttempts = 0;
  await withStateMutationLock(state, async () => undefined, {
    __testOnlyAfterLockRead: async () => {
      await rm(lockPath);
      await writeFile(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
    },
    __testOnlyWindowsFileSemantics: true,
    __testOnlyBeforeReleaseFileOperation: (operation, attempt) => {
      if (operation === "restore-link") throw fileError("EPERM");
      if (operation === "restore-marker" && attempt < 2) {
        restoreMarkerAttempts += 1;
        throw fileError("EBUSY");
      }
    }
  });
  assert.equal(restoreMarkerAttempts, 2);
  assert.deepEqual(JSON.parse((await readFile(lockPath, "utf8")).trim()), replacement);
  await assert.rejects(
    () => withStateMutationLock(state, async () => undefined, { timeoutMs: 100 }),
    /state is busy/u
  );
  await rm(lockPath);
});

test("state mutation lock never overwrites a newer owner during fallback publication", async () => {
  const state = join(await mkdtemp(join(tmpdir(), "odinn-state-lock-newer-owner-")), "state");
  const lockPath = join(dirname(state), `.${basename(state)}.state-mutation.lock`);
  const replacement = { token: "fallback-replacement", pid: process.pid, createdAt: new Date().toISOString() };
  const newerOwner = { token: "newer-owner", pid: process.pid, createdAt: new Date().toISOString() };
  await assert.rejects(
    () => withStateMutationLock(state, async () => undefined, {
      __testOnlyAfterLockRead: async () => {
        await rm(lockPath);
        await writeFile(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
      },
      __testOnlyWindowsFileSemantics: true,
      __testOnlyBeforeReleaseFileOperation: async (operation, attempt) => {
        if (operation === "restore-link") throw fileError("EPERM");
        if (operation === "restore-marker" && attempt === 0) {
          await writeFile(lockPath, `${JSON.stringify(newerOwner)}\n`, { flag: "wx", mode: 0o600 });
        }
      }
    }),
    /changed during release and was quarantined/u
  );
  assert.deepEqual(JSON.parse((await readFile(lockPath, "utf8")).trim()), newerOwner);
  assert.equal((await readdir(dirname(state))).some((name) => name.includes(".release-")), true);
  await rm(lockPath);
});

test("state mutation lock serializes forked process mutations", { timeout: 20_000 }, async () => {
  const state = join(await mkdtemp(join(tmpdir(), "odinn-state-lock-processes-")), "state");
  const counterPath = join(dirname(state), "counter.txt");
  const workers = 4;
  const mutationsPerWorker = 12;
  const startPath = join(dirname(state), "start");
  await writeFile(counterPath, "0\n");

  const childCode = `
    const { readFile, writeFile } = await import("node:fs/promises");
    const { withStateMutationLock } = await import("./packages/kernel/src/index.ts");
    await writeFile(process.env.ODINN_TEST_READY, "ready\\n");
    while (true) {
      try { await readFile(process.env.ODINN_TEST_START); break; }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    for (let index = 0; index < Number(process.env.ODINN_TEST_MUTATIONS); index += 1) {
      await withStateMutationLock(process.env.ODINN_TEST_STATE, async () => {
        const current = Number((await readFile(process.env.ODINN_TEST_COUNTER, "utf8")).trim());
        await new Promise((resolve) => setTimeout(resolve, 2));
        await writeFile(process.env.ODINN_TEST_COUNTER, String(current + 1) + "\\n");
      }, { timeoutMs: 15_000 });
    }
  `;
  const workerRuns = Array.from({ length: workers }, (_, index) => runWorker(childCode, {
    ODINN_TEST_STATE: state,
    ODINN_TEST_COUNTER: counterPath,
    ODINN_TEST_MUTATIONS: String(mutationsPerWorker),
    ODINN_TEST_READY: join(dirname(state), `ready-${index}`),
    ODINN_TEST_START: startPath
  }));
  while ((await readdir(dirname(state))).filter((name) => name.startsWith("ready-")).length < workers) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await writeFile(startPath, "start\n");
  await Promise.all(workerRuns);

  assert.equal(Number((await readFile(counterPath, "utf8")).trim()), workers * mutationsPerWorker);
  assert.equal((await readdir(dirname(state))).some((name) => name === basename(join(dirname(state), `.${basename(state)}.state-mutation.lock`))), false);
});

function runWorker(code: string, environment: Record<string, string>): Promise<void> {
  return new Promise((resolveWorker, rejectWorker) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", rejectWorker);
    child.on("exit", (code) => {
      if (code === 0) resolveWorker();
      else rejectWorker(new Error(`state mutation worker exited ${String(code)}: ${stderr}`));
    });
  });
}

function fileError(code: "EPERM" | "EBUSY"): Error & { code: string } {
  return Object.assign(new Error(`injected ${code}`), { code });
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}
