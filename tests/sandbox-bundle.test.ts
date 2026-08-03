import assert from "node:assert/strict";
import { createServer } from "node:net";
import { access, chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializeSandboxBundle } from "../packages/kernel/src/sandbox-bundle.ts";

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `odinn-sandbox-bundle-${name}-`));
  const source = join(root, "source");
  const state = join(root, "state");
  await mkdir(source);
  return { root, source, state };
}

test("sandbox bundles are deterministic, sealed, content-addressed, and safely reusable", async () => {
  const first = await fixture("deterministic-a");
  await mkdir(join(first.source, "empty"));
  await mkdir(join(first.source, "nested"));
  await writeFile(join(first.source, "z.txt"), "private-content-z\n", { mode: 0o666 });
  await writeFile(join(first.source, "nested", "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o777 });
  await mkdir(first.state, { mode: 0o777 });
  await chmod(first.state, 0o777);

  let stagingSynced = false;
  let publishedSynced = false;
  const reference = await materializeSandboxBundle(first.source, first.state, {
    hooks: {
      afterStagingSync: () => { stagingSynced = true; },
      afterPublishSync: () => { publishedSynced = true; }
    }
  });
  assert.equal(stagingSynced, true);
  assert.equal(publishedSynced, true);
  assert.equal(Object.isFrozen(reference), true);
  assert.match(reference.digest, /^[a-f0-9]{64}$/u);
  assert.equal(reference.path, join(first.state, "bundles", "sha256", reference.digest));
  assert.equal(reference.files, 2);
  assert.equal(reference.bytes, Buffer.byteLength("private-content-z\n#!/bin/sh\nexit 0\n"));
  assert.equal(JSON.stringify(reference).includes("private-content-z"), false);
  assert.equal(await readFile(join(reference.path, "z.txt"), "utf8"), "private-content-z\n");
  assert.equal((await stat(reference.path)).mode & 0o777, 0o555);
  assert.equal((await stat(join(reference.path, "z.txt"))).mode & 0o777, 0o444);
  assert.equal((await stat(join(reference.path, "nested", "run.sh"))).mode & 0o777, 0o555);
  assert.equal((await stat(join(first.state, "bundles"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(first.state, "bundles", "sha256"))).mode & 0o777, 0o700);
  assert.equal((await stat(first.state)).mode & 0o777, 0o700);

  assert.deepEqual(await materializeSandboxBundle(first.source, first.state), reference);

  const second = await fixture("deterministic-b");
  await mkdir(join(second.source, "nested"));
  await writeFile(join(second.source, "nested", "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(join(second.source, "z.txt"), "private-content-z\n", { mode: 0o600 });
  await mkdir(join(second.source, "empty"));
  const equivalent = await materializeSandboxBundle(second.source, second.state);
  assert.equal(equivalent.digest, reference.digest);
});

test("sandbox bundles reject links and special files", { skip: process.platform === "win32" }, async () => {
  const symbolic = await fixture("symlink");
  await writeFile(join(symbolic.root, "outside"), "outside\n");
  await symlink(join(symbolic.root, "outside"), join(symbolic.source, "linked"));
  await assert.rejects(() => materializeSandboxBundle(symbolic.source, symbolic.state), /symbolic links and junctions/u);

  const hard = await fixture("hardlink");
  await writeFile(join(hard.source, "original"), "same inode\n");
  await link(join(hard.source, "original"), join(hard.source, "alias"));
  await assert.rejects(() => materializeSandboxBundle(hard.source, hard.state), /hard-linked files/u);

  const socket = await fixture("socket");
  const socketPath = join(socket.source, "service.sock");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    await assert.rejects(() => materializeSandboxBundle(socket.source, socket.state), /sockets, devices, FIFOs, and special files/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("sandbox bundle limits bound file count, depth, bytes, and portable path length", async () => {
  const count = await fixture("file-limit");
  await writeFile(join(count.source, "a"), "a");
  await writeFile(join(count.source, "b"), "b");
  await assert.rejects(() => materializeSandboxBundle(count.source, count.state, { maxFiles: 1 }), /maximum file count 1|bounded entry count/u);

  const depth = await fixture("depth-limit");
  await mkdir(join(depth.source, "nested"));
  await assert.rejects(() => materializeSandboxBundle(depth.source, depth.state, { maxDepth: 0 }), /maximum depth 0/u);

  const bytes = await fixture("byte-limit");
  await writeFile(join(bytes.source, "data"), "1234");
  await assert.rejects(() => materializeSandboxBundle(bytes.source, bytes.state, { maxBytes: 3 }), /maximum byte count 3/u);

  const path = await fixture("path-limit");
  await writeFile(join(path.source, "long-name"), "x");
  await assert.rejects(() => materializeSandboxBundle(path.source, path.state, { maxPathBytes: 4 }), /exceeds 4 bytes/u);
});

test("sandbox bundles reject source replacement and mutation races", async () => {
  const rootRace = await fixture("root-race");
  await writeFile(join(rootRace.source, "data"), "original");
  await assert.rejects(
    () => materializeSandboxBundle(rootRace.source, rootRace.state, {
      hooks: {
        afterSourceValidation: async () => {
          await rename(rootRace.source, `${rootRace.source}-old`);
          await mkdir(rootRace.source);
        }
      }
    }),
    /source changed during materialization/u
  );

  const pathRace = await fixture("path-race");
  await writeFile(join(pathRace.source, "data"), "original");
  await assert.rejects(
    () => materializeSandboxBundle(pathRace.source, pathRace.state, {
      hooks: {
        afterEntryLstat: async (path) => {
          if (path !== "data") return;
          await rename(join(pathRace.source, "data"), join(pathRace.source, "old"));
          await writeFile(join(pathRace.source, "data"), "replacement");
        }
      }
    }),
    /changed during secure open|source changed during materialization/u
  );

  const contentRace = await fixture("content-race");
  await writeFile(join(contentRace.source, "data"), "original");
  await assert.rejects(
    () => materializeSandboxBundle(contentRace.source, contentRace.state, {
      hooks: {
        afterFileOpen: async (path) => {
          if (path === "data") await writeFile(join(contentRace.source, "data"), "modified");
        }
      }
    }),
    /changed during copy/u
  );

  const directoryRace = await fixture("directory-race");
  await writeFile(join(directoryRace.source, "data"), "original");
  await assert.rejects(
    () => materializeSandboxBundle(directoryRace.source, directoryRace.state, {
      hooks: {
        beforeDirectoryPostValidation: async (path) => {
          if (path === ".") await writeFile(join(directoryRace.source, "added"), "late");
        }
      }
    }),
    /source directory changed during materialization|source changed during materialization/u
  );
});

test("sandbox bundles detect staging mutation and reject corrupt existing targets", async () => {
  const staging = await fixture("staging-race");
  await writeFile(join(staging.source, "data"), "original");
  await assert.rejects(
    () => materializeSandboxBundle(staging.source, staging.state, {
      hooks: {
        beforeFinalize: async (path) => {
          const target = join(path, "data");
          await chmod(target, 0o644);
          await writeFile(target, "tampered");
        }
      }
    }),
    /unsafe permissions|changed before finalization/u
  );
  assert.equal((await readdir(join(staging.state, "bundles", "sha256"))).some((name) => name.startsWith(".staging-")), false);

  const existing = await fixture("existing-corrupt");
  await writeFile(join(existing.source, "data"), "original");
  const reference = await materializeSandboxBundle(existing.source, existing.state);
  const stored = join(reference.path, "data");
  await chmod(stored, 0o644);
  await writeFile(stored, "tampered");
  await assert.rejects(
    () => materializeSandboxBundle(existing.source, existing.state),
    /unsafe permissions|does not match its content address/u
  );
});

test("sandbox bundle cleanup unlinks a replaced staging symlink without following it", { skip: process.platform === "win32" }, async () => {
  const paths = await fixture("cleanup-link");
  const external = join(paths.root, "external");
  const sentinel = join(external, "keep.txt");
  await mkdir(external);
  await writeFile(sentinel, "keep");
  await writeFile(join(paths.source, "data"), "original");
  let stagingPath = "";
  await assert.rejects(
    () => materializeSandboxBundle(paths.source, paths.state, {
      hooks: {
        beforeFinalize: async (path) => {
          stagingPath = path;
          await rename(path, `${path}-attacker-moved`);
          await symlink(external, path, "dir");
        }
      }
    }),
    /store changed|real directory/u
  );
  assert.equal(await readFile(sentinel, "utf8"), "keep");
  await assert.rejects(lstat(stagingPath), { code: "ENOENT" });
});

test("sandbox bundle reuse rejects target replacement after content verification", async () => {
  const paths = await fixture("existing-replacement");
  await writeFile(join(paths.source, "data"), "original");
  const reference = await materializeSandboxBundle(paths.source, paths.state);
  await assert.rejects(
    () => materializeSandboxBundle(paths.source, paths.state, {
      hooks: {
        afterExistingVerification: async (target) => {
          await rename(target, `${target}-replaced`);
          await mkdir(target, { mode: 0o555 });
        }
      }
    }),
    /changed after verification/u
  );
  await access(`${reference.path}-replaced`);
});

test("sandbox bundle cancellation aborts without publishing a partial bundle", async () => {
  const beforeStart = await fixture("cancelled-before-start");
  await writeFile(join(beforeStart.source, "data"), "original");
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(
    () => materializeSandboxBundle(beforeStart.source, beforeStart.state, { signal: stopped.signal }),
    { name: "AbortError" }
  );

  const duringCopy = await fixture("cancelled-during-copy");
  await writeFile(join(duringCopy.source, "data"), Buffer.alloc(256 * 1024, 1));
  const controller = new AbortController();
  await assert.rejects(
    () => materializeSandboxBundle(duringCopy.source, duringCopy.state, {
      signal: controller.signal,
      hooks: { afterFileOpen: () => controller.abort() }
    }),
    { name: "AbortError" }
  );
  assert.equal((await readdir(join(duringCopy.state, "bundles", "sha256"))).some((name) => name.startsWith(".staging-")), false);
});

test("sandbox bundle sources must be absolute canonical real directories and separate from state", async () => {
  const paths = await fixture("roots");
  await assert.rejects(() => materializeSandboxBundle("relative-source", paths.state), /absolute path/u);
  await assert.rejects(() => materializeSandboxBundle(paths.source, join(paths.source, "state")), /must not overlap/u);

  if (process.platform !== "win32") {
    const alias = join(paths.root, "source-alias");
    await symlink(paths.source, alias, "dir");
    await assert.rejects(() => materializeSandboxBundle(alias, paths.state), /real directory/u);
  }
});
