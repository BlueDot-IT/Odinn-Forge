import assert from "node:assert/strict";
import { createServer } from "node:http";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAuditStore,
  createBuiltInRegistry,
  createRunLedger,
  runTask,
  workspaceDiff,
  workspaceList,
  workspaceRead,
  workspaceSearch
} from "../packages/kernel/src/index.ts";
import { createDefaultPolicy } from "../packages/policy/src/index.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "odinn-workspace-inspection-"));
  const stateDir = join(root, ".odinn");
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir });
  return { root, stateDir, auditStore, registry };
}

async function closeFixture(fixture: Awaited<ReturnType<typeof fixture>>) {
  fixture.registry.close();
  fixture.auditStore.close();
  await rm(fixture.root, { recursive: true, force: true });
}

async function execute(fixture: Awaited<ReturnType<typeof fixture>>, id: string, tool: string, input: any, options: any = {}) {
  return runTask({
    task: { id, tool, input, actor: "workspace-test" },
    auditStore: fixture.auditStore,
    registry: fixture.registry,
    policy: createDefaultPolicy({ capabilityRegistryVersion: 1, allowedCapabilities: ["workspace.inspect"] }),
    ...options
  });
}

test("workspace inspection tools are trusted inspect-only built-ins", async () => {
  const workspace = await fixture();
  try {
    for (const name of ["workspace.list", "workspace.stat", "workspace.search", "workspace.read", "workspace.diff"]) {
      const tool = workspace.registry.get(name);
      assert.ok(tool, name);
      assert.deepEqual(tool.capabilities, ["workspace.inspect"]);
      assert.ok(tool.inputSchema);
    }
  } finally {
    await closeFixture(workspace);
  }
});

test("workspace.list is deterministic, ignored, sensitive-safe, and cursor paginated", async () => {
  const workspace = await fixture();
  try {
    await mkdir(join(workspace.root, "src"));
    await writeFile(join(workspace.root, ".gitignore"), "ignored.txt\n", "utf8");
    await writeFile(join(workspace.root, "ignored.txt"), "ignored", "utf8");
    await writeFile(join(workspace.root, ".env"), "SECRET_SENTINEL", "utf8");
    await writeFile(join(workspace.root, "z.txt"), "z", "utf8");
    await writeFile(join(workspace.root, "a.txt"), "a", "utf8");
    await writeFile(join(workspace.root, "src", "b.txt"), "b", "utf8");
    const first = await execute(workspace, "list-page-one", "workspace.list", { recursive: true, limit: 2 });
    assert.deepEqual(first.output.entries.map((entry: any) => entry.path), [".gitignore", "a.txt"]);
    assert.ok(first.output.nextCursor);
    assert.ok(first.output.omittedSensitive >= 1);
    const second = await execute(workspace, "list-page-two", "workspace.list", { recursive: true, limit: 2, cursor: first.output.nextCursor });
    assert.deepEqual(second.output.entries.map((entry: any) => entry.path), ["src", "src/b.txt"]);
    assert.equal(second.output.entries.some((entry: any) => entry.path === "ignored.txt" || entry.path === ".env"), false);
    await assert.rejects(execute(workspace, "list-tampered", "workspace.list", { recursive: true, limit: 2, cursor: `${first.output.nextCursor}x` }), /cursor integrity/u);
    await assert.rejects(execute(workspace, "list-cross-use", "workspace.list", { recursive: false, limit: 2, cursor: first.output.nextCursor }), /cursor does not match/u);
  } finally {
    await closeFixture(workspace);
  }
});

test("stat, read, literal search, and diff return bounded path and digest metadata", async () => {
  const workspace = await fixture();
  try {
    await writeFile(join(workspace.root, "before.txt"), "first\nold\n", "utf8");
    await writeFile(join(workspace.root, "after.txt"), "first\nnew 😀\n", "utf8");
    await writeFile(join(workspace.root, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    const stat = await execute(workspace, "inspect-stat", "workspace.stat", { path: "after.txt" });
    assert.equal(stat.output.path, "after.txt");
    assert.match(stat.output.digest, /^sha256:[a-f0-9]{64}$/u);
    const read = await execute(workspace, "inspect-read", "workspace.read", { path: "after.txt", maxBytes: 11 });
    assert.equal(read.output.content, "first\nnew ");
    assert.equal(read.output.truncated, true);
    assert.equal(read.output.content.includes("�"), false);
    const binary = await execute(workspace, "inspect-binary", "workspace.read", { path: "binary.dat" });
    assert.equal(binary.output.binary, true);
    assert.equal(binary.output.content, null);
    const search = await execute(workspace, "inspect-search", "workspace.search", { query: "new", limit: 10 });
    assert.equal(search.output.matches[0].path, "after.txt");
    assert.deepEqual(search.output.matches[0].matches, [{ line: 2, text: "new 😀" }]);
    assert.match(search.output.matches[0].digest, /^sha256:[a-f0-9]{64}$/u);
    const diff = await execute(workspace, "inspect-diff", "workspace.diff", { path: "after.txt", basePath: "before.txt" });
    assert.match(diff.output.diff, /--- a\/before\.txt[\s\S]*\+\+\+ b\/after\.txt/u);
    assert.match(diff.output.diffDigest, /^sha256:[a-f0-9]{64}$/u);
  } finally {
    await closeFixture(workspace);
  }
});

test("resolver rejects traversal, ambiguous paths, links, junctions, and hard links", async () => {
  const workspace = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "odinn-workspace-outside-"));
  try {
    await writeFile(join(workspace.root, "plain.txt"), "safe", "utf8");
    await writeFile(join(outside, "secret.txt"), "outside", "utf8");
    for (const path of ["../secret.txt", "/etc/passwd", "C:relative.txt", "\\\\server\\share", "folder\\..\\secret", "file.txt:stream", "NUL", "trailing. "]) {
      await assert.rejects(workspaceRead(workspace.root, { path }), /workspace-relative|escapes workspace root|platform-ambiguous/u, path);
    }
    const linkPath = join(workspace.root, "outside-link");
    await symlink(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(workspaceRead(workspace.root, { path: "outside-link/secret.txt" }), /symbolic link|junction|escapes workspace root/u);
    await link(join(workspace.root, "plain.txt"), join(workspace.root, "hard.txt"));
    await assert.rejects(workspaceRead(workspace.root, { path: "hard.txt" }), /hard-linked/u);
  } finally {
    await closeFixture(workspace);
    await rm(outside, { recursive: true, force: true });
  }
});

test("resolver detects replacement races and cancellation", async () => {
  const workspace = await fixture();
  try {
    await writeFile(join(workspace.root, "target.txt"), "safe", "utf8");
    await writeFile(join(workspace.root, "replacement.txt"), "replacement", "utf8");
    await assert.rejects(workspaceRead(workspace.root, { path: "target.txt" }, {
      hooks: { afterResolve: async () => rename(join(workspace.root, "replacement.txt"), join(workspace.root, "target.txt")) }
    }), /changed during admission/u);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(workspaceRead(workspace.root, { path: "target.txt" }, { signal: controller.signal }), (error: any) => error.name === "AbortError");
  } finally {
    await closeFixture(workspace);
  }
});

test("workspace content is returned to the caller but excluded from audit and ledger artifacts", async () => {
  const workspace = await fixture();
  const sentinel = "WORKSPACE_PRIVATE_CONTENT_8f3190";
  const ledger = createRunLedger({ stateDir: workspace.stateDir, workspaceRoot: workspace.root });
  try {
    await writeFile(join(workspace.root, "secret-note.txt"), `${sentinel}\n`, "utf8");
    const result = await execute(workspace, "private-workspace-read", "workspace.read", { path: "secret-note.txt" }, { runLedger: ledger });
    assert.match(result.output.content, new RegExp(sentinel, "u"));
    const replay = await execute(workspace, "private-workspace-read", "workspace.read", { path: "secret-note.txt" }, { runLedger: ledger });
    assert.equal(replay.replayed, true);
    assert.equal(replay.contentUnavailableOnReplay, true);
    assert.equal("content" in replay.output, false);
    assert.match(replay.output.digest, /^sha256:[a-f0-9]{64}$/u);
    const audit = (await workspace.auditStore.readAll()).map(JSON.stringify).join("\n");
    assert.doesNotMatch(audit, new RegExp(sentinel, "u"));
    assert.match(audit, /sha256:[a-f0-9]{64}/u);
    const durable = await readTreeBytes(workspace.stateDir);
    assert.equal(durable.includes(sentinel), false);
  } finally {
    ledger.close();
    await closeFixture(workspace);
  }
});

test("the normal agent run can invoke workspace.read without persisting returned content", async () => {
  const sentinel = "AGENT_WORKSPACE_SENTINEL_c41d90";
  let requestCount = 0;
  const provider = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requestCount += 1;
    response.writeHead(200, { "content-type": "application/json" });
    if (requestCount === 1) {
      assert.ok(body.tools.some((entry: any) => entry.function.name === "workspace_x2e_read"));
      response.end(JSON.stringify({ id: "workspace-call", choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "read-1", type: "function", function: { name: "workspace.read", arguments: "{\"path\":\"agent.txt\"}" } }] } }] }));
    } else {
      const toolMessage = body.messages.find((entry: any) => entry.role === "tool");
      assert.match(toolMessage.content, new RegExp(sentinel, "u"));
      response.end(JSON.stringify({ id: "workspace-done", choices: [{ message: { role: "assistant", content: "inspection complete" } }] }));
    }
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("provider did not bind");
  const root = await mkdtemp(join(tmpdir(), "odinn-workspace-agent-"));
  const stateDir = join(root, ".odinn");
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir,
    config: { defaultModel: "test:model", providers: { test: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: ["model"] } } }
  });
  try {
    await writeFile(join(root, "agent.txt"), sentinel, "utf8");
    const result = await runTask({
      task: { id: "agent-workspace-run", tool: "agent.run", input: { prompt: "Inspect agent.txt", model: "test:model" }, actor: "test" },
      auditStore,
      registry,
      policy: createDefaultPolicy({ capabilityRegistryVersion: 1, allowedCapabilities: ["agent.delegate", "network.access", "workspace.inspect"] })
    });
    assert.equal(result.output.content, "inspection complete");
    assert.doesNotMatch((await auditStore.readAll()).map(JSON.stringify).join("\n"), new RegExp(sentinel, "u"));
  } finally {
    registry.close();
    auditStore.close();
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("sensitive key, certificate, and SSH paths are denied at root and nested depths", async () => {
  const workspace = await fixture();
  try {
    await mkdir(join(workspace.root, "nested"));
    await mkdir(join(workspace.root, ".ssh"));
    await mkdir(join(workspace.root, "nested", ".ssh"));
    for (const [path, content] of [
      ["root.key", "root-key"],
      ["root.pem", "root-pem"],
      [".ssh/id_ed25519", "root-ssh"],
      ["nested/child.key", "nested-key"],
      ["nested/child.pem", "nested-pem"],
      ["nested/.ssh/config", "nested-ssh"]
    ]) await writeFile(join(workspace.root, path), content, "utf8");

    const listed = await workspaceList(workspace.root, { recursive: true, limit: 100 });
    const paths = listed.entries.map((entry: any) => entry.path);
    for (const denied of ["root.key", "root.pem", ".ssh", ".ssh/id_ed25519", "nested/child.key", "nested/child.pem", "nested/.ssh", "nested/.ssh/config"]) {
      assert.equal(paths.includes(denied), false, denied);
    }
    assert.ok(listed.omittedSensitive >= 5);
    for (const denied of ["root.key", "root.pem", ".ssh/id_ed25519", "nested/child.key", "nested/child.pem", "nested/.ssh/config"]) {
      await assert.rejects(workspaceRead(workspace.root, { path: denied }), /sensitive-file policy/u, denied);
    }
  } finally {
    await closeFixture(workspace);
  }
});

test("sensitive ignore sources and oversized ignore rules fail closed", async () => {
  const workspace = await fixture();
  try {
    await writeFile(join(workspace.root, ".env"), "ignored.txt\n", "utf8");
    await assert.rejects(
      workspaceList(workspace.root, { recursive: true, ignoreFiles: [".env"] }),
      /sensitive-file policy/u
    );

    const manyPatterns = Array.from({ length: 4_097 }, (_, index) => `p${index}`).join("\n");
    await writeFile(join(workspace.root, "many.ignore"), manyPatterns, "utf8");
    await assert.rejects(
      workspaceList(workspace.root, { recursive: true, ignoreFiles: ["many.ignore"] }),
      /exceed 4096 patterns/u
    );

    await writeFile(join(workspace.root, "wide.ignore"), "x".repeat(1_025), "utf8");
    await assert.rejects(
      workspaceList(workspace.root, { recursive: true, ignoreFiles: ["wide.ignore"] }),
      /exceeds 1024 bytes/u
    );
  } finally {
    await closeFixture(workspace);
  }
});

test("recursive traversal rejects a real-directory replacement before descent", async () => {
  const workspace = await fixture();
  try {
    await mkdir(join(workspace.root, "child"));
    await writeFile(join(workspace.root, "child", "safe.txt"), "safe", "utf8");
    await mkdir(join(workspace.root, "replacement"));
    await writeFile(join(workspace.root, "replacement", "outside.txt"), "replacement", "utf8");
    let replaced = false;
    await assert.rejects(
      workspaceList(workspace.root, { recursive: true }, {
        hooks: {
          beforeDirectoryRecurse: async (path) => {
            if (path !== "child" || replaced) return;
            replaced = true;
            await rename(join(workspace.root, "child"), join(workspace.root, "original-child"));
            await rename(join(workspace.root, "replacement"), join(workspace.root, "child"));
          }
        }
      }),
      /directory changed before recursion/u
    );
  } finally {
    await closeFixture(workspace);
  }
});

test("invalid UTF-8 beyond the former probe boundary is binary for read, search, and diff", async () => {
  const workspace = await fixture();
  try {
    const lateInvalidUtf8 = Buffer.concat([Buffer.alloc(8_192, 0x61), Buffer.from([0xff])]);
    await writeFile(join(workspace.root, "late-invalid.dat"), lateInvalidUtf8);
    await writeFile(join(workspace.root, "valid.txt"), "valid\n", "utf8");

    const read = await workspaceRead(workspace.root, { path: "late-invalid.dat", maxBytes: 16_384 });
    assert.equal(read.binary, true);
    assert.equal(read.content, null);
    const search = await workspaceSearch(workspace.root, { query: "aaa", maxBytes: 32_768, limit: 10 });
    assert.deepEqual(search.matches, []);
    await assert.rejects(
      workspaceDiff(workspace.root, { path: "late-invalid.dat", basePath: "valid.txt", maxBytes: 16_384 }),
      /does not render binary files/u
    );
  } finally {
    await closeFixture(workspace);
  }
});

test("search and diff reject inputs above their bounded line ceilings", async () => {
  const workspace = await fixture();
  try {
    const tooManyLines = "\n".repeat(100_001);
    await writeFile(join(workspace.root, "many-lines.txt"), tooManyLines, "utf8");
    await writeFile(join(workspace.root, "current.txt"), "current\n", "utf8");
    await assert.rejects(
      workspaceSearch(workspace.root, { query: "absent", maxBytes: 256_000 }),
      /line traversal ceiling/u
    );
    await assert.rejects(
      workspaceDiff(workspace.root, { path: "current.txt", before: tooManyLines, maxBytes: 256_000 }),
      /exceeded 100000 lines/u
    );
  } finally {
    await closeFixture(workspace);
  }
});

test("list and search serialize within maxBytes and expose resumable cursors", async () => {
  const workspace = await fixture();
  try {
    for (let index = 0; index < 40; index += 1) {
      const name = `entry-${String(index).padStart(3, "0")}-${"n".repeat(80)}.txt`;
      await writeFile(join(workspace.root, name), `${"match ".repeat(330)}\n`, "utf8");
    }
    const listed = await workspaceList(workspace.root, { recursive: true, limit: 100, maxBytes: 4_096 });
    assert.ok(listed.resultBytes <= 4_096, String(listed.resultBytes));
    assert.ok(listed.nextCursor);

    const searched = await workspaceSearch(workspace.root, { query: "match", limit: 4, maxBytes: 8_192 });
    assert.ok(searched.resultBytes <= 8_192, String(searched.resultBytes));
    assert.ok(searched.nextCursor);
  } finally {
    await closeFixture(workspace);
  }
});

test("workspace.list enforces maxFiles before traversal exceeds the ceiling", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-workspace-file-limit-"));
  try {
    for (let index = 0; index < 4; index += 1) {
      await writeFile(join(root, `entry-${index}.txt`), `${index}\n`, "utf8");
    }
    const exact = await workspaceList(root, { limit: 4, maxFiles: 4 });
    assert.equal(exact.entries.length, 4);
    await writeFile(join(root, "entry-4.txt"), "4\n", "utf8");
    await assert.rejects(
      workspaceList(root, { limit: 1, maxFiles: 4 }),
      /maxFiles traversal ceiling/u
    );
    await rm(root, { recursive: true, force: true });
    await mkdir(join(root, "a"), { recursive: true });
    await mkdir(join(root, "b"), { recursive: true });
    await writeFile(join(root, "a", "one.txt"), "one\n", "utf8");
    await writeFile(join(root, "a", "two.txt"), "two\n", "utf8");
    await writeFile(join(root, "b", "three.txt"), "three\n", "utf8");
    await assert.rejects(
      workspaceList(root, { recursive: true, limit: 100, maxFiles: 4 }),
      /maxFiles traversal ceiling/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace.list excludes descendants beyond maxDepth", async () => {
  const workspace = await fixture();
  try {
    await mkdir(join(workspace.root, "level-0", "level-1", "level-2"), { recursive: true });
    await writeFile(join(workspace.root, "level-0", "visible.txt"), "visible\n", "utf8");
    await writeFile(join(workspace.root, "level-0", "level-1", "hidden.txt"), "hidden\n", "utf8");
    const listed = await workspaceList(workspace.root, { recursive: true, maxDepth: 1, limit: 100 });
    assert.deepEqual(listed.entries.map((entry: any) => entry.path), [
      "level-0",
      "level-0/level-1",
      "level-0/visible.txt"
    ]);
    const deeper = await workspaceList(workspace.root, { recursive: true, maxDepth: 2, limit: 100 });
    assert.deepEqual(deeper.entries.map((entry: any) => entry.path), [
      "level-0",
      "level-0/level-1",
      "level-0/level-1/hidden.txt",
      "level-0/level-1/level-2",
      "level-0/visible.txt"
    ]);
  } finally {
    await closeFixture(workspace);
  }
});

test("workspace.search returns matching files exactly once across byte-bounded pages", async () => {
  const workspace = await fixture();
  try {
    const expected = Array.from({ length: 30 }, (_, index) => `entry-${String(index).padStart(3, "0")}.txt`);
    for (const name of expected) await writeFile(join(workspace.root, name), `needle ${"x".repeat(80)}\n`, "utf8");
    const paths: string[] = [];
    const pages: any[] = [];
    let cursor: string | null = null;
    do {
      const page = await workspaceSearch(workspace.root, {
        query: "needle",
        limit: 30,
        maxBytes: 2_048,
        ...(cursor ? { cursor } : {})
      });
      assert.ok(page.searchedBytes <= 2_048, String(page.searchedBytes));
      assert.ok(page.resultBytes <= 2_048, String(page.resultBytes));
      assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 2_048);
      paths.push(...page.matches.map((match: any) => match.path));
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor);
    assert.ok(pages.length > 1, String(pages.length));
    assert.ok(pages[0].nextCursor);
    assert.deepEqual(paths, expected);
    assert.equal(new Set(paths).size, paths.length);
    await assert.rejects(
      workspaceSearch(workspace.root, {
        query: "different",
        limit: 30,
        maxBytes: 2_048,
        cursor: pages[0].nextCursor
      }),
      /cursor does not match/u
    );
  } finally {
    await closeFixture(workspace);
  }
});

test("workspace.diff rejects control-character injection in beforePath", async () => {
  const workspace = await fixture();
  try {
    await writeFile(join(workspace.root, "current.txt"), "current\n", "utf8");
    for (const beforePath of ["forged\n+++ b/forged", "forged\u0000path", "forged\u001bpath"]) {
      await assert.rejects(
        workspaceDiff(workspace.root, { path: "current.txt", before: "before\n", beforePath }),
        /beforePath must be bounded control-free text/u
      );
    }
    await assert.rejects(workspaceDiff(workspace.root, { path: "current.txt", beforePath: "orphan" }), /beforePath requires before/u);
    await assert.rejects(workspaceDiff(workspace.root, { path: "current.txt", basePath: "current.txt", before: "before\n" }), /either basePath or before/u);
  } finally {
    await closeFixture(workspace);
  }
});

test("recursive traversal observes cancellation at the descent boundary", async () => {
  const workspace = await fixture();
  try {
    await mkdir(join(workspace.root, "child"));
    await writeFile(join(workspace.root, "child", "file.txt"), "content", "utf8");
    const controller = new AbortController();
    await assert.rejects(
      workspaceList(workspace.root, { recursive: true }, {
        signal: controller.signal,
        hooks: { beforeDirectoryRecurse: () => controller.abort() }
      }),
      (error: any) => error.name === "AbortError"
    );
  } finally {
    await closeFixture(workspace);
  }
});

test("cursor pagination returns recursive preorder entries exactly once", async () => {
  const workspace = await fixture();
  try {
    await mkdir(join(workspace.root, "a"));
    await mkdir(join(workspace.root, "a", "nested"));
    await writeFile(join(workspace.root, "a", "child"), "child", "utf8");
    await writeFile(join(workspace.root, "a", "nested", "leaf"), "leaf", "utf8");
    await writeFile(join(workspace.root, "a.txt"), "sibling", "utf8");
    const paths: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await workspaceList(workspace.root, { recursive: true, limit: 1, ...(cursor ? { cursor } : {}) });
      paths.push(...page.entries.map((entry: any) => entry.path));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(paths, ["a", "a/child", "a/nested", "a/nested/leaf", "a.txt"]);
    assert.equal(new Set(paths).size, paths.length);
  } finally {
    await closeFixture(workspace);
  }
});

test("search cursor pagination returns every matching file exactly once", async () => {
  const workspace = await fixture();
  try {
    for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(workspace.root, name), "needle\n", "utf8");
    const paths: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await workspaceSearch(workspace.root, { query: "needle", limit: 1, ...(cursor ? { cursor } : {}) });
      paths.push(...page.matches.map((match: any) => match.path));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(paths, ["a.txt", "b.txt", "c.txt"]);
    assert.equal(new Set(paths).size, paths.length);
  } finally {
    await closeFixture(workspace);
  }
});

async function readTreeBytes(root: string) {
  const chunks: Buffer[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) chunks.push(await readFile(path));
    }
  };
  await walk(root);
  return Buffer.concat(chunks).toString("utf8");
}
