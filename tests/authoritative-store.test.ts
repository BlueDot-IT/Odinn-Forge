import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SqliteRecordStore,
  migrateLegacyRecordsToSqlite,
  rollbackLegacyRecordsMigration
} from "../packages/store-sqlite/src/index.ts";

const roots: string[] = [];

async function root() {
  const value = await mkdtemp(join(tmpdir(), "odinn-authoritative-store-"));
  roots.push(value);
  return value;
}

test.after(async () => {
  await Promise.all(roots.map((value) => rm(value, { recursive: true, force: true })));
});

test("record queries use stable keyset cursors and preserve deterministic order", async () => {
  const state = await root();
  const store = new SqliteRecordStore(join(state, "records.sqlite"));
  try {
    for (let index = 0; index < 7; index += 1) {
      await store.append({ id: `record-${index}`, type: "memory", at: `2026-08-01T00:00:0${index}.000Z`, status: "active", namespace: "project/demo", text: `value-${index}` });
    }
    const records: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.queryRecordsPage({ types: ["memory"], limit: 2, order: "asc", ...(cursor ? { cursor } : {}) });
      records.push(...page.records.map((record) => String(record.id)));
      cursor = page.nextCursor;
      assert.equal(page.records.length <= 2, true);
      if (!page.hasMore) assert.equal(cursor, undefined);
    } while (cursor);
    assert.deepEqual(records, Array.from({ length: 7 }, (_, index) => `record-${index}`));
    const source = await readFile(new URL("../packages/store-sqlite/src/authoritative.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bOFFSET\b/u);
  } finally {
    store.close();
  }
});

test("external message IDs are unique and idempotent under concurrent appenders", async () => {
  const state = await root();
  const left = new SqliteRecordStore(join(state, "records.sqlite"));
  const right = new SqliteRecordStore(join(state, "records.sqlite"));
  try {
    await left.append({ id: "session-1", type: "session.created", status: "open", projectId: "project_default" });
    const results = await Promise.all([
      left.append({ id: "message-a", type: "message.appended", sessionId: "session-1", externalId: "provider-1", role: "user", content: "same" }),
      right.append({ id: "message-b", type: "message.appended", sessionId: "session-1", externalId: "provider-1", role: "user", content: "same" })
    ]);
    assert.equal(results[0].id, results[1].id);
    assert.equal((await right.findMessageByExternalId("session-1", "provider-1"))?.content, "same");
    assert.equal((await right.queryRecordsPage({ types: ["message.appended"], sessionId: "session-1", limit: 10 })).records.length, 1);
  } finally {
    left.close();
    right.close();
  }
});

test("active memory queries honor namespaces, supersession, tombstones, and expiry", async () => {
  const state = await root();
  const store = new SqliteRecordStore(join(state, "records.sqlite"));
  try {
    await store.append({ id: "memory-old", type: "memory", status: "active", kind: "decision", namespace: "project/demo", subject: "storage", text: "old" });
    await store.append({ id: "memory-forgotten", type: "memory", status: "active", kind: "decision", namespace: "project/demo", subject: "forgotten", text: "gone" });
    await store.append({ id: "memory-expired", type: "memory", status: "active", kind: "decision", namespace: "project/demo", subject: "expired", text: "gone", expiresAt: "2020-01-01T00:00:00.000Z" });
    await store.append({ id: "memory-correction", type: "memory", status: "active", kind: "correction", namespace: "project/demo", subject: "storage", text: "new", supersedes: "memory-old" });
    await store.append({ id: "forget-1", type: "memory.deactivation", status: "inactive", targetId: "memory-forgotten" });
    const page = await store.queryRecordsPage({ activeMemoryOnly: true, namespacePrefix: "project", limit: 20, order: "asc" });
    assert.deepEqual(page.records.map((record) => record.id), ["memory-correction"]);
  } finally {
    store.close();
  }
});

test("legacy migration is backup-first, resumable, and rollback-safe", async () => {
  const state = await root();
  const legacyPath = join(state, "records.jsonl");
  const databasePath = join(state, "records.sqlite");
  const lines = [
    { id: "project-1", type: "project.created", status: "active", name: "Demo" },
    { id: "session-1", type: "session.created", status: "open", projectId: "project_default" },
    { id: "memory-1", type: "memory", status: "active", namespace: "project/demo", text: "hello" }
  ];
  await writeFile(legacyPath, `${lines.map((value) => JSON.stringify(value)).join("\n")}\n`, { mode: 0o600 });
  assert.throws(
    () => migrateLegacyRecordsToSqlite({ legacyPath, databasePath, chunkSize: 1, failAfterRecords: 1 }),
    /test migration interruption/u
  );
  const backupPath = `${legacyPath}.pre-sqlite.bak`;
  assert.equal(existsSync(backupPath), true);
  const resumed = migrateLegacyRecordsToSqlite({ legacyPath, databasePath, chunkSize: 1 });
  assert.equal(resumed.complete, true);
  const store = new SqliteRecordStore(databasePath);
  try {
    assert.equal((await store.queryRecordsPage({ limit: 20, order: "asc" })).records.length, 3);
  } finally {
    store.close();
  }
  const rolledBack = rollbackLegacyRecordsMigration({ legacyPath, databasePath });
  assert.equal(rolledBack.rolledBack, true);
  assert.equal(existsSync(databasePath), false);
  assert.equal(existsSync(backupPath), true);
});
