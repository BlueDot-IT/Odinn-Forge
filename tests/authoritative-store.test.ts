import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteRecordStore, migrateLegacyRecordsToSqlite } from "../packages/store-sqlite/src/index.ts";
import { appendSessionMessage, createGoal, createProject, createSession, DEFAULT_PROJECT_ID, listGoals, listProjects, listSessions } from "../packages/kernel/src/workspace-records.ts";
import { compactMemory, forgetMemory, remember, searchMemory } from "../packages/kernel/src/memory.ts";

async function databaseFixture() {
  const root = await mkdtemp(join(tmpdir(), "odinn-authoritative-records-"));
  return { root, database: join(root, "db", "odinn.sqlite"), legacy: join(root, "records.jsonl") };
}

test("record pages use deterministic keyset cursors without skips or duplicates", async () => {
  const fixture = await databaseFixture();
  const store = new SqliteRecordStore(fixture.database);
  try {
    for (let index = 0; index < 1_200; index += 1) await store.append({ id: `record-${index}`, type: index % 2 ? "message.appended" : "memory", subject: `subject-${index % 7}` });
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await store.queryRecordsPage({ limit: 97, order: "asc", ...(cursor ? { cursor } : {}) });
      assert.ok(page.records.length <= 97);
      for (const record of page.records) {
        assert.equal(seen.has(String(record.id)), false);
        seen.add(String(record.id));
      }
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    assert.equal(seen.size, 1_200);
    assert.ok(pages > 10);
    await assert.rejects(() => store.queryRecordsPage({ cursor: "not-a-cursor" }), /invalid record cursor/u);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM record_events").get()?.count, 1_200);
  } finally {
    store.close();
  }
});

test("external message IDs are idempotent across concurrent SQLite store instances", async () => {
  const fixture = await databaseFixture();
  const left = new SqliteRecordStore(fixture.database);
  const right = new SqliteRecordStore(fixture.database);
  try {
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? left : right).append({
      type: "message.appended",
      sessionId: "session-1",
      externalId: "provider-message-1",
      role: "user",
      content: "same logical message"
    })));
    assert.equal(new Set(results.map((record) => record.id)).size, 1);
    assert.equal((await left.queryRecordsPage({ types: ["message.appended"], limit: 10 })).records.length, 1);
  } finally {
    left.close();
    right.close();
  }
});

test("legacy JSONL migration is backup-first, restart-safe, and preserves lifecycle evidence", async () => {
  const fixture = await databaseFixture();
  const source = [
    { id: "project_default", type: "project.created", status: "active", name: "Workspace" },
    { id: "session-1", type: "session.created", projectId: DEFAULT_PROJECT_ID, status: "open", title: "Migration" },
    { id: "message-1", type: "message.appended", sessionId: "session-1", role: "user", content: "keep this" },
    { id: "memory-1", type: "memory", status: "active", namespace: "projects/odinn", tier: "l1", kind: "project", subject: "storage", text: "SQLite is authoritative" },
    { id: "tombstone-1", type: "memory.deactivation", targetId: "memory-old", status: "inactive" }
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
  await writeFile(fixture.legacy, source, { mode: 0o600 });
  const first = migrateLegacyRecordsToSqlite({ legacyPath: fixture.legacy, databasePath: fixture.database });
  assert.equal(first.migrated, true);
  assert.equal(first.records, 5);
  assert.equal(await readFile(fixture.legacy, "utf8"), source);
  assert.equal(await readFile(first.backup!, "utf8"), source);
  const second = migrateLegacyRecordsToSqlite({ legacyPath: fixture.legacy, databasePath: fixture.database });
  assert.equal(second.migrated, false);
  assert.equal(second.records, 5);
  const store = new SqliteRecordStore(fixture.database);
  try {
    assert.equal((await store.queryRecordsPage({ types: ["memory.deactivation"], limit: 10 })).records.length, 1);
  } finally {
    store.close();
  }
});

test("logical workspace and memory listings expose stable cursors", async () => {
  const fixture = await databaseFixture();
  const store = new SqliteRecordStore(fixture.database);
  try {
    await store.append({ id: DEFAULT_PROJECT_ID, type: "project.created", status: "active", name: "Workspace" });
    for (let index = 0; index < 3; index += 1) {
      const project = await createProject(store, { id: `project-${index}`, name: `Project ${index}` });
      const session = await createSession(store, { title: `Session ${index}`, projectId: String(project.id) });
      await createGoal(store, { title: `Goal ${index}`, projectId: String(project.id) });
      await remember(store, { text: `cursor memory ${index}`, kind: "project", subject: `subject-${index}` });
      void session;
    }
    const firstSessions = await listSessions(store, { limit: 2 });
    const secondSessions = await listSessions(store, { limit: 2, cursor: firstSessions.nextCursor });
    assert.equal(new Set([...firstSessions.sessions, ...secondSessions.sessions].map((entry) => entry.id)).size, 3);
    const firstProjects = await listProjects(store, { limit: 2 });
    const secondProjects = await listProjects(store, { limit: 2, cursor: firstProjects.nextCursor });
    assert.equal(new Set([...firstProjects.projects, ...secondProjects.projects].map((entry) => entry.id)).size, 4);
    const firstMemory = await searchMemory(store, { query: "cursor memory", limit: 2 });
    const secondMemory = await searchMemory(store, { query: "cursor memory", limit: 2, cursor: firstMemory.nextCursor });
    assert.equal(new Set([...firstMemory.memories, ...secondMemory.memories].map((entry: any) => entry.id)).size, 3);
  } finally {
    store.close();
  }
});

test("SQLite record operations preserve session tombstones, compaction, and namespaces", async () => {
  const fixture = await databaseFixture();
  const store = new SqliteRecordStore(fixture.database);
  try {
    await store.append({ id: DEFAULT_PROJECT_ID, type: "project.created", status: "active", name: "Workspace" });
    const session = await createSession(store, { title: "Compaction" });
    await appendSessionMessage(store, { sessionId: String(session.id), role: "user", content: "remember this", externalId: "m-1" });
    await appendSessionMessage(store, { sessionId: String(session.id), role: "assistant", content: "done", externalId: "m-2" });
    const compacted = await compactMemory(store, { sessionId: String(session.id) });
    assert.equal(compacted.namespace, `sessions/${String(session.id)}`);
    const memory = await remember(store, { text: "temporary namespace fact", kind: "project", subject: "scope", namespace: "projects/odinn" });
    const forgotten = await forgetMemory(store, { targetId: String(memory.id) });
    assert.equal(forgotten.forgotten, true);
    const rows = await store.readAll();
    assert.ok(rows.some((row) => row.type === "memory.deactivation" && row.targetId === memory.id));
    assert.ok(rows.some((row) => row.type === "memory" && row.namespace === `sessions/${String(session.id)}`));
  } finally {
    store.close();
  }
});
