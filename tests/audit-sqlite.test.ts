import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { SqliteAuditStore, migrateLegacyAuditToSqlite, rollbackLegacyAuditMigration } from "../packages/store-sqlite/src/audit.ts";
import { createAuditStore } from "../packages/kernel/src/index.ts";

const event = (runId: string, type = "task.started") => ({ at: new Date().toISOString(), runId, type, actor: "test", tool: "shell", capability: "test", decision: "allow" });

test("distinct configured audit journals use distinct databases and keyrings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-audit-distinct-")); t.after(() => rm(root, { recursive: true, force: true })); const main = createAuditStore(join(root, "audit.jsonl")); const onboarding = createAuditStore(join(root, "onboarding-verification.jsonl"));
  await main.append(event("main")); await onboarding.append(event("onboarding")); assert.deepEqual((await main.readAll()).map((item) => item.runId), ["main"]); assert.deepEqual((await onboarding.readAll()).map((item) => item.runId), ["onboarding"]); assert.equal((await main.verifyIntegrity({ allowUnsigned: false })).valid, true); main.close(); onboarding.close();
});

test("SQLite audit append is transactional across store instances and pages by durable sequence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-audit-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "audit.sqlite"); const keys = join(root, "audit.keys.json");
  const left = new SqliteAuditStore(path, { keyringPath: keys }); const right = new SqliteAuditStore(path, { keyringPath: keys });
  t.after(() => { left.close(); right.close(); });
  await Promise.all(Array.from({ length: 100 }, (_, index) => (index % 2 ? left : right).append(event(`run-${index}`))));
  const first = await left.readPage({ limit: 37 }); const second = await left.readPage({ afterSequence: first.at(-1)!.sequence, limit: 100 });
  assert.equal(first.length, 37); assert.equal(second.length, 63); assert.deepEqual([...first, ...second].map((item) => item.sequence), Array.from({ length: 100 }, (_, index) => index + 1));
  assert.equal((await left.verifyIntegrity({ allowUnsigned: false })).valid, true);
});

test("SQLite audit append serializes independent writer processes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-audit-processes-")); t.after(() => rm(root, { recursive: true, force: true })); const path = join(root, "audit.sqlite"); const keys = join(root, "keys.json"); const worker = fileURLToPath(new URL("../scripts/ci/audit-soak-worker.ts", import.meta.url));
  const run = (id: number) => new Promise<void>((resolve, reject) => { const child = spawn(process.execPath, [worker, path, keys, String(id), "25"], { stdio: ["ignore", "ignore", "pipe"] }); let error = ""; child.stderr.on("data", (chunk) => { error += chunk; }); child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(error))); });
  await Promise.all([run(1), run(2), run(3), run(4)]); const store = new SqliteAuditStore(path, { keyringPath: keys }); assert.equal((await store.readAll()).length, 100); assert.equal((await store.verifyIntegrity({ allowUnsigned: false })).valid, true); store.close();
});

test("subscriber cursor is monotonic and cross-instance notifications wake bounded drains", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-audit-stream-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "audit.sqlite"); const keys = join(root, "audit.keys.json");
  const writer = new SqliteAuditStore(path, { keyringPath: keys }); const reader = new SqliteAuditStore(path, { keyringPath: keys }); t.after(() => { writer.close(); reader.close(); });
  const woke = new Promise<number>((resolve) => { const stop = reader.subscribe((sequence) => { stop(); resolve(sequence); }); });
  await writer.append(event("wake")); assert.equal(await woke, 1);
  await reader.ackCursor("client", 1); await reader.ackCursor("client", 0); assert.equal(await reader.getCursor("client"), 1); await assert.rejects(reader.ackCursor("client", 2), /outside the durable audit range/u);
});

test("integrity verification detects modification, deletion, insertion, reorder, key and head errors", async (t) => {
  for (const scenario of ["modification", "deletion", "insertion", "reorder", "key", "head", "materialized", "segment"] as const) await t.test(scenario, async () => {
    const root = await mkdtemp(join(tmpdir(), `odinn-audit-${scenario}-`)); t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "audit.sqlite"); const keys = join(root, "audit.keys.json"); const store = new SqliteAuditStore(path, { keyringPath: keys });
    await store.append(event("one")); await store.append(event("two")); store.close();
    if (scenario === "key") { const keyring = JSON.parse(await readFile(keys, "utf8")); keyring.keys[keyring.current] = Buffer.alloc(32, 7).toString("base64"); await writeFile(keys, JSON.stringify(keyring)); }
    else {
      const db = new DatabaseSync(path);
      if (scenario === "modification") db.prepare("UPDATE audit_events SET event_json=? WHERE sequence=1").run(JSON.stringify(event("modified")));
      if (scenario === "deletion") db.prepare("DELETE FROM audit_events WHERE sequence=1").run();
      if (scenario === "insertion") db.prepare("INSERT INTO audit_events(run_id,actor,type,at,event_json) VALUES(?,?,?,?,?)").run("inserted","test","task.started",new Date().toISOString(),JSON.stringify(event("inserted")));
      if (scenario === "reorder") db.exec("CREATE TEMP TABLE swap AS SELECT sequence,event_json FROM audit_events; UPDATE audit_events SET event_json=(SELECT event_json FROM swap WHERE swap.sequence=3-audit_events.sequence);");
      if (scenario === "head") db.prepare("UPDATE audit_state SET head_signature='forged'").run();
      if (scenario === "materialized") db.prepare("UPDATE audit_events SET signature='forged-column' WHERE sequence=1").run();
      if (scenario === "segment") db.prepare("UPDATE audit_segments SET anchor_signature='forged'").run();
      db.close();
    }
    const verifier = new SqliteAuditStore(path, { keyringPath: keys }); assert.equal((await verifier.verifyIntegrity({ allowUnsigned: false })).valid, false); verifier.close();
  });
});

test("legacy migration is backup-first, bounded, idempotent and preserves the chain", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-audit-migrate-")); t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = join(root, "audit.jsonl"); const database = join(root, "db", "audit.sqlite"); const keys = `${legacy}.keys.json`;
  const sourceDb = join(root, "source.sqlite"); const source = new SqliteAuditStore(sourceDb, { keyringPath: keys }); await source.append(event("legacy-1")); await source.append(event("legacy-2")); const lines = (await source.readAll()).map(JSON.stringify).join("\n") + "\n"; source.close(); await writeFile(legacy, lines);
  const result = migrateLegacyAuditToSqlite({ legacyPath: legacy, databasePath: database, keyringPath: keys }); assert.equal(result.migrated, true); assert.equal(result.events, 2); assert.equal(await readFile(`${legacy}.migration.bak`, "utf8"), lines);
  const store = new SqliteAuditStore(database, { keyringPath: keys }); assert.equal((await store.verifyIntegrity({ allowUnsigned: false })).valid, true); store.close();
  assert.equal(migrateLegacyAuditToSqlite({ legacyPath: legacy, databasePath: database, keyringPath: keys }).migrated, false);
  await writeFile(legacy, "changed after migration\n"); const rollback = rollbackLegacyAuditMigration({ legacyPath: legacy, databasePath: database }); assert.equal(await readFile(legacy, "utf8"), lines); assert.ok(rollback.displacedDatabase);
});

test("interrupted migration rolls back SQLite and retains its source backup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-audit-interrupt-")); t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = join(root, "audit.jsonl"); const database = join(root, "db", "audit.sqlite"); await writeFile(legacy, `${JSON.stringify(event("valid"))}\n{broken\n`);
  assert.throws(() => migrateLegacyAuditToSqlite({ legacyPath: legacy, databasePath: database }), /JSON/u); assert.equal(await readFile(`${legacy}.migration.bak`, "utf8"), await readFile(legacy, "utf8"));
  const db = new DatabaseSync(database); assert.equal((db.prepare("SELECT count(*) AS count FROM audit_events").get() as any).count, 0); db.close();
});

test("migration preserves stale backups and rejects invalid signed chains before cutover", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-audit-migration-integrity-")); t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = join(root, "audit.jsonl"); const database = join(root, "db", "audit.sqlite"); await writeFile(legacy, `${JSON.stringify(event("live"))}\n`); await writeFile(`${legacy}.migration.bak`, `${JSON.stringify(event("stale"))}\n`);
  assert.equal(migrateLegacyAuditToSqlite({ legacyPath: legacy, databasePath: database }).migrated, true); assert.ok((await readdir(root)).some((name) => name.startsWith("audit.jsonl.migration.bak.rejected-")));
  const second = await mkdtemp(join(tmpdir(), "odinn-audit-migration-forged-")); t.after(() => rm(second, { recursive: true, force: true })); const forgedLegacy = join(second, "audit.jsonl"); const forged = { ...event("forged"), data: { __odinnIntegrity: { keyId: "missing", previous: null, signature: "forged" } } }; await writeFile(forgedLegacy, `${JSON.stringify(forged)}\n`);
  assert.throws(() => migrateLegacyAuditToSqlite({ legacyPath: forgedLegacy, databasePath: join(second, "audit.sqlite") }), /integrity verification failed/u);
});

test("bounded migration preserves UTF-8 split across its 64 KiB read boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-audit-migration-utf8-")); t.after(() => rm(root, { recursive: true, force: true })); const legacy = join(root, "audit.jsonl"); const database = join(root, "audit.sqlite");
  const prefix = JSON.stringify({ ...event("utf8"), message: "" }); const marker = prefix.indexOf('""', prefix.indexOf('"message"')) + 1; const padding = "x".repeat(65_535 - marker); const line = `${prefix.slice(0, marker)}${padding}💀${prefix.slice(marker)}`; await writeFile(legacy, `${line}\n`);
  migrateLegacyAuditToSqlite({ legacyPath: legacy, databasePath: database }); const store = new SqliteAuditStore(database, { keyringPath: `${legacy}.keys.json` }); const [migrated] = await store.readAll(); assert.equal(migrated!.message, `${padding}💀`); store.close();
});

test("rotation, archive and retention require a verified immutable artifact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-audit-archive-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SqliteAuditStore(join(root, "audit.sqlite"), { keyringPath: join(root, "keys.json") }); t.after(() => store.close());
  await store.append(event("one")); store.rotateSegment(); await store.rotateKey(); await store.append(event("two"));
  await assert.rejects(store.applyRetention(1), /verified archive/u);
  const archive = await store.exportArchive(join(root, "archive.jsonl"), 1); assert.equal(archive.events, 1); assert.equal(await store.applyRetention(1), 1); assert.equal((await store.verifyIntegrity({ allowUnsigned: false })).valid, true);
});

test("retention refuses to launder a tampered online chain into a newly signed archive", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-audit-retention-tamper-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "audit.sqlite"); const store = new SqliteAuditStore(path, { keyringPath: join(root, "keys.json") }); t.after(() => store.close()); await store.append(event("one"));
  store.db.prepare("UPDATE audit_events SET event_json=? WHERE sequence=1").run(JSON.stringify(event("tampered"))); await assert.rejects(store.exportArchive(join(root, "archive.jsonl"), 1), /integrity verification required/u);
});

test("successive retention archives remain cumulative and independently verifiable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-audit-cumulative-")); t.after(() => rm(root, { recursive: true, force: true })); const path = join(root, "audit.sqlite"); const store = new SqliteAuditStore(path, { keyringPath: join(root, "keys.json") }); t.after(() => store.close());
  await store.append(event("one")); const firstPath = join(root, "first.jsonl"); await store.exportArchive(firstPath, 1); await store.applyRetention(1); await store.append(event("two")); const secondPath = join(root, "second.jsonl"); const second = await store.exportArchive(secondPath, 2); assert.equal(second.events, 2); await store.applyRetention(2);
  await rm(firstPath); await rm(`${firstPath}.manifest.json`); assert.equal((await store.verifyIntegrity({ allowUnsigned: false })).valid, true); assert.equal((await readFile(secondPath, "utf8")).trim().split("\n").length, 2);
});

test("retained segment boundaries remain bound to archived event signatures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-audit-retained-segments-")); t.after(() => rm(root, { recursive: true, force: true })); const store = new SqliteAuditStore(join(root, "audit.sqlite"), { keyringPath: join(root, "keys.json") }); t.after(() => store.close());
  await store.append(event("one")); store.rotateSegment(); await store.append(event("two")); await store.exportArchive(join(root, "archive.jsonl"), 2); await store.applyRetention(2);
  store.db.exec("UPDATE audit_segments SET final_signature='forged' WHERE id=1; UPDATE audit_segments SET anchor_signature='forged' WHERE id=2;");
  const verification = await store.verifyIntegrity({ allowUnsigned: false }); assert.equal(verification.valid, false); assert.ok(verification.failures.some((failure) => failure.reason === "audit segment final signature mismatch"));
});
