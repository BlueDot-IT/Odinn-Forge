import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

process.env.ODINN_GATEWAY_AUTH = "off";

import { createAuditStore, createBuiltInRegistry, MAX_BOUNDED_UTF8_BYTES, readUtf8Prefix, runTask } from "../packages/kernel/src/index.ts";
import { createGatewayServer } from "../apps/gateway/src/server.ts";

const execFileAsync = promisify(execFile);

async function workspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), "odinn-resource-limits-"));
  const stateDir = join(root, ".odinn");
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir });
  return { root, auditStore, registry };
}

async function readWorkspace(fixture: Awaited<ReturnType<typeof workspaceFixture>>, id: string, input: any) {
  return runTask({
    task: { id, tool: "workspace.readText", input, actor: "test" },
    auditStore: fixture.auditStore,
    registry: fixture.registry
  });
}

test("workspace.readText reads only a bounded sparse prefix and reports byte semantics", async () => {
  const fixture = await workspaceFixture();
  try {
    const path = join(fixture.root, "sparse.bin");
    const handle = await open(path, "w");
    await handle.truncate(64 * 1024 * 1024);
    await handle.close();
    const result = await readWorkspace(fixture, "sparse-read", { path: "sparse.bin", maxBytes: 1_024 });
    assert.equal(result.output.bytesRead, 1_025);
    assert.equal(result.output.truncated, true);
    assert.equal(Buffer.byteLength(result.output.content, "utf8"), 1_024);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("workspace.readText truncates only at valid UTF-8 boundaries", async () => {
  const fixture = await workspaceFixture();
  try {
    await writeFile(join(fixture.root, "utf8.txt"), "😀😀", "utf8");
    const result = await readWorkspace(fixture, "utf8-boundary", { path: "utf8.txt", maxBytes: 5 });
    assert.equal(result.output.content, "😀");
    assert.equal(result.output.bytesRead, 6);
    assert.equal(result.output.truncated, true);
    assert.equal(result.output.content.includes("�"), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("workspace.readText rejects invalid and over-cap maxBytes values", async () => {
  const fixture = await workspaceFixture();
  try {
    await writeFile(join(fixture.root, "limits.txt"), "bounded\n", "utf8");
    for (const [index, maxBytes] of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_BOUNDED_UTF8_BYTES + 1, Number.MAX_SAFE_INTEGER + 1].entries()) {
      await assert.rejects(
        readWorkspace(fixture, `invalid-limit-${index}`, { path: "limits.txt", maxBytes }),
        /workspace\.readText maxBytes must be a positive safe integer/u
      );
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("workspace.readText rejects directories, FIFOs, and replaced paths", { skip: process.platform === "win32" }, async () => {
  const fixture = await workspaceFixture();
  try {
    await mkdir(join(fixture.root, "directory"));
    await assert.rejects(readWorkspace(fixture, "directory-read", { path: "directory" }), /regular file/u);

    const fifo = join(fixture.root, "pipe");
    await execFileAsync("mkfifo", [fifo]);
    await assert.rejects(readWorkspace(fixture, "fifo-read", { path: "pipe" }), /regular file/u);

    const outside = await mkdtemp(join(tmpdir(), "odinn-outside-") );
    await writeFile(join(outside, "secret.txt"), "outside\n", "utf8");
    await rm(join(fixture.root, "replacement"), { recursive: true, force: true });
    await symlink(outside, join(fixture.root, "replacement"));
    await assert.rejects(readWorkspace(fixture, "replacement-read", { path: "replacement/secret.txt" }), /path escapes workspace root/u);
    await rm(outside, { recursive: true, force: true });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("bounded UTF-8 reader rejects non-UTF-8 content and static symlinks", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-reader-"));
  try {
    const invalid = join(root, "invalid.txt");
    await writeFile(invalid, Buffer.from([0xc3, 0x28]));
    await assert.rejects(readUtf8Prefix(invalid, 32, "invalid.txt"), /not valid UTF-8/u);

    const original = join(root, "original.txt");
    const replacement = join(root, "replacement.txt");
    await writeFile(original, "safe\n", "utf8");
    await symlink(original, replacement);
    await assert.rejects(readUtf8Prefix(replacement, 32, "replacement.txt"), /symbolic link/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded reader rejects an ancestor swap before helper admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-reader-admission-race-"));
  try {
    const ancestor = join(root, "ancestor");
    const originalAncestor = join(root, "ancestor-original");
    const replacementAncestor = join(root, "replacement-ancestor");
    await mkdir(ancestor, { recursive: true });
    await mkdir(replacementAncestor, { recursive: true });
    await writeFile(join(ancestor, "target.txt"), "safe\n", "utf8");
    await writeFile(join(replacementAncestor, "target.txt"), "outside\n", "utf8");
    const admitted = await stat(join(ancestor, "target.txt"));
    let afterLstatBeforeOpenRan = false;
    await assert.rejects(
      readUtf8Prefix(join(ancestor, "target.txt"), 32, "admission-race.txt", {
        confinementRoot: root,
        expectedFileIdentity: { dev: admitted.dev, ino: admitted.ino },
        beforeOpen: async () => {
          await rename(ancestor, originalAncestor);
          await rename(replacementAncestor, ancestor);
        },
        afterLstatBeforeOpen: async () => {
          afterLstatBeforeOpenRan = true;
        }
      }),
      /changed during admission/u
    );
    assert.equal(afterLstatBeforeOpenRan, false);
    await rename(ancestor, replacementAncestor);
    await rename(originalAncestor, ancestor);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded reader rejects an ancestor swap between lstat and open after restoring paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-reader-open-race-"));
  const ancestor = join(root, "ancestor");
  const originalAncestor = join(root, "ancestor-original");
  const replacementAncestor = join(root, "replacement-ancestor");
  let replacementInstalled = false;
  try {
    await mkdir(ancestor, { recursive: true });
    await mkdir(replacementAncestor, { recursive: true });
    await writeFile(join(ancestor, "target.txt"), "safe\n", "utf8");
    await writeFile(join(replacementAncestor, "target.txt"), "outside\n", "utf8");
    const admitted = await stat(join(ancestor, "target.txt"));
    let afterLstatBeforeOpenRan = false;
    let afterOpenRan = false;
    await assert.rejects(
      readUtf8Prefix(join(ancestor, "target.txt"), 32, "open-race.txt", {
        confinementRoot: root,
        expectedFileIdentity: { dev: admitted.dev, ino: admitted.ino },
        afterLstatBeforeOpen: async () => {
          afterLstatBeforeOpenRan = true;
          await rename(ancestor, originalAncestor);
          await rename(replacementAncestor, ancestor);
          replacementInstalled = true;
        },
        afterOpen: async () => {
          afterOpenRan = true;
          if (process.platform === "win32") return;
          await rename(ancestor, replacementAncestor);
          await rename(originalAncestor, ancestor);
          replacementInstalled = false;
        }
      }),
      /changed during secure open/u
    );
    assert.equal(afterLstatBeforeOpenRan, true);
    assert.equal(afterOpenRan, true);
  } finally {
    if (replacementInstalled) {
      await rename(ancestor, replacementAncestor);
      await rename(originalAncestor, ancestor);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("skill discovery preflights and skips oversized SKILL.md before parsing", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "odinn-skill-discovery-"));
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-skill-state-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: workspace });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const oversized = join(workspace, "skills", "oversized", "SKILL.md");
    const valid = join(workspace, "skills", "valid", "SKILL.md");
    await mkdir(join(workspace, "skills", "oversized"), { recursive: true });
    await mkdir(join(workspace, "skills", "valid"), { recursive: true });
    await writeFile(oversized, Buffer.concat([Buffer.from("---\nname: oversized\n---\n"), Buffer.alloc(MAX_BOUNDED_UTF8_BYTES + 1, 0x78)]));
    await writeFile(valid, "---\nname: valid\ndescription: bounded skill\n---\n\n# Valid\n", "utf8");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/skills`);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    const validBytes = (await readFile(valid)).byteLength;
    assert.equal(body.skills.some((skill: any) => skill.path === oversized), false);
    assert.equal(body.skills.some((skill: any) => skill.path === valid && skill.bytes === validBytes), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(workspace, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});
