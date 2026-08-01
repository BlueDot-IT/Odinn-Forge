import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
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
      await store.append({ id: `record-${index}`, type: "memory", at: index === 5 ? "2020-01-01T00:00:00.000Z" : `2026-08-01T00:00:0${index}.000Z`, status: "active", namespace: "project/demo", text: `value-${index}` });
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
    const filtered = await store.queryRecordsPage({ types: ["memory"], text: "value-1", limit: 20 });
    assert.equal(await store.countRecords({ types: ["memory"], text: "value-1" }), filtered.records.length);
    const sessionPlan = store.db.prepare("EXPLAIN QUERY PLAN SELECT sequence FROM record_events WHERE session_id = ? AND type = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?")
      .all("session-1", "message.appended", 0, 20) as Array<Record<string, unknown>>;
    assert.match(sessionPlan.map((row) => String(row.detail)).join("\n"), /idx_record_events_session_sequence/u);
    const source = await readFile(new URL("../packages/store-sqlite/src/authoritative.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bOFFSET\b/u);
  } finally {
    store.close();
  }
});

test("external message IDs are unique and idempotent across concurrent processes", async () => {
  const state = await root();
  const databasePath = join(state, "records.sqlite");
  const setup = new SqliteRecordStore(databasePath);
  try {
    await setup.append({ id: "session-1", type: "session.created", status: "open", projectId: "project_default" });
    setup.close();
    const moduleUrl = new URL("../packages/store-sqlite/src/authoritative.ts", import.meta.url).href;
    const worker = (id: string) => new Promise<{ id: string }>((resolveWorker, rejectWorker) => {
      const code = `
        import { SqliteRecordStore } from ${JSON.stringify(moduleUrl)};
        const store = new SqliteRecordStore(process.argv[1]);
        try {
          const record = await store.append({ id: process.argv[2], type: "message.appended", sessionId: "session-1", externalId: "provider-1", role: "user", content: "same" });
          process.stdout.write(JSON.stringify({ id: record.id }));
        } finally { store.close(); }
      `;
      const child = spawn(process.execPath, ["--input-type=module", "--eval", code, databasePath, id], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", rejectWorker);
      child.on("close", (status) => status === 0 ? resolveWorker(JSON.parse(stdout) as { id: string }) : rejectWorker(new Error(stderr)));
    });
    const results = await Promise.all([worker("message-a"), worker("message-b")]);
    assert.equal(results[0].id, results[1].id);
    const verify = new SqliteRecordStore(databasePath);
    assert.equal((await verify.findMessageByExternalId("session-1", "provider-1"))?.content, "same");
    assert.equal((await verify.queryRecordsPage({ types: ["message.appended"], sessionId: "session-1", limit: 10 })).records.length, 1);
    verify.close();
  } finally {
    try { setup.close(); } catch {}
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

test("current improvement projections order by latest decision and retain exact state beyond 200 decisions", async () => {
  const state = await root();
  const store = new SqliteRecordStore(join(state, "records.sqlite"));
  try {
    await store.append({ id: "improvement-old", type: "improvement.proposed", status: "proposed", title: "Old", observationKey: "old-key" });
    await store.append({ id: "improvement-new", type: "improvement.proposed", status: "proposed", title: "New", observationKey: "new-key" });
    for (let index = 0; index < 250; index += 1) {
      await store.append({ id: `decision-${index}`, type: "improvement.approved", improvementId: "improvement-old", decision: index === 249 ? "rejected" : "approved", note: `decision ${index}` });
    }
    const current = await store.getCurrentImprovement("improvement-old");
    assert.equal(current?.status, "rejected");
    assert.equal(current?.decisionCount, 250);
    assert.equal(current?.decisionsTruncated, true);
    assert.equal((current?.decisions as unknown[]).length, 200);
    const page = await store.queryCurrentImprovementsPage({ limit: 1 });
    assert.equal(page.records[0]?.id, "improvement-old");
    assert.equal(page.hasMore, true);
    assert.ok(page.nextCursor);
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
  const originalLegacy = await readFile(legacyPath);
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
    assert.equal((await store.getCurrentProject("project-1"))?.name, "Demo");
    assert.equal((await store.getCurrentSession("session-1"))?.projectId, "project_default");
  } finally {
    store.close();
  }
  const rolledBack = rollbackLegacyRecordsMigration({ legacyPath, databasePath });
  assert.equal(rolledBack.rolledBack, true);
  assert.equal(existsSync(databasePath), false);
  assert.equal(existsSync(backupPath), true);
  assert.deepEqual(await readFile(legacyPath), originalLegacy);
});

test("legacy migration rejects stale backups and live-source mutation without advancing state", async () => {
  const state = await root();
  const legacyPath = join(state, "records.jsonl");
  const databasePath = join(state, "records.sqlite");
  const backupPath = `${legacyPath}.pre-sqlite.bak`;
  const original = `${JSON.stringify({ id: "session-1", type: "session.created", status: "open", projectId: "project_default" })}\n${JSON.stringify({ id: "memory-1", type: "memory", status: "active", namespace: "tests/migration", text: "original" })}\n`;
  await writeFile(legacyPath, original, { mode: 0o600 });
  await writeFile(backupPath, "stale\n", { mode: 0o600 });
  assert.throws(() => migrateLegacyRecordsToSqlite({ legacyPath, databasePath }), /backup does not match source/u);
  await rm(backupPath);
  assert.throws(() => migrateLegacyRecordsToSqlite({ legacyPath, databasePath, chunkSize: 1, failAfterRecords: 1 }), /test migration interruption/u);
  await writeFile(legacyPath, `${original}${JSON.stringify({ id: "memory-2", type: "memory", status: "active", namespace: "tests/migration", text: "mutated" })}\n`);
  assert.throws(() => migrateLegacyRecordsToSqlite({ legacyPath, databasePath, chunkSize: 1 }), /backup does not match source|changed during/u);
  const store = new SqliteRecordStore(databasePath);
  try {
    assert.equal(await store.countRecords(), 1);
  } finally {
    store.close();
  }
});

test("legacy migration detects source mutation in the same import and rollback restores a displaced live file after verification failure", async () => {
  const state = await root();
  const legacyPath = join(state, "records.jsonl");
  const databasePath = join(state, "records.sqlite");
  const original = Array.from({ length: 3 }, (_, index) => JSON.stringify({ id: `memory-${index}`, type: "memory", status: "active", namespace: "tests/migration", text: `value-${index}` })).join("\n") + "\n";
  await writeFile(legacyPath, original, { mode: 0o600 });
  let mutated = false;
  assert.throws(() => migrateLegacyRecordsToSqlite({
    legacyPath,
    databasePath,
    chunkSize: 1,
    __testOnlyAfterChunk: () => {
      if (!mutated) {
        appendFileSync(legacyPath, `${JSON.stringify({ id: "late", type: "memory", status: "active" })}\n`);
        mutated = true;
      }
    }
  }), /changed during/u);

  await writeFile(legacyPath, "live-file-before-interruption\n", { mode: 0o600 });
  assert.throws(() => rollbackLegacyRecordsMigration({
    legacyPath,
    databasePath,
    __testOnlyBeforePublish: () => {
      assert.equal(existsSync(legacyPath), true);
      throw new Error("test rollback publication interruption");
    }
  }), /test rollback publication interruption/u);
  assert.equal(await readFile(legacyPath, "utf8"), "live-file-before-interruption\n");
  assert.equal(existsSync(databasePath), true);

  if (process.platform !== "win32") {
    await writeFile(legacyPath, "live-file-before-parent-fsync\n", { mode: 0o600 });
    assert.throws(() => rollbackLegacyRecordsMigration({
      legacyPath,
      databasePath,
      __testOnlyBeforeParentFsync: () => { throw new Error("test parent fsync failure"); }
    }), /test parent fsync failure/u);
    assert.equal(await readFile(legacyPath, "utf8"), "live-file-before-parent-fsync\n");
    assert.equal(existsSync(databasePath), true);
  }

  await writeFile(legacyPath, "live-file-before-rollback\n", { mode: 0o600 });
  assert.throws(() => rollbackLegacyRecordsMigration({
    legacyPath,
    databasePath,
    __testOnlyAfterPublish: () => writeFileSync(legacyPath, "corrupt-published-restore\n", { mode: 0o600 })
  }), /backup verification/u);
  assert.equal(await readFile(legacyPath, "utf8"), "live-file-before-rollback\n");
  assert.equal(existsSync(databasePath), true);
});
