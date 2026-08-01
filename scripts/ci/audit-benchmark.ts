import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { normalizeAuditEvent, type AuditEvent } from "../../packages/protocol/src/index.ts";
import { SqliteAuditStore } from "../../packages/store-sqlite/src/audit.ts";

const sizes = String(process.env.ODINN_AUDIT_BENCHMARK_SIZES ?? "10000,100000,1000000").split(",").map(Number).filter((value) => Number.isSafeInteger(value) && value > 0);
const sampleTarget = Math.max(1, Math.min(10_000, Number.parseInt(process.env.ODINN_AUDIT_BENCHMARK_SAMPLES ?? "1000", 10) || 1_000));
const percentile = (sorted: number[], fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
const event = (index: number) => normalizeAuditEvent({ at: new Date().toISOString(), runId: `bench-${index % 1_000}`, type: "task.completed", actor: "benchmark", tool: "benchmark", capability: "audit.append", decision: "allow", data: { index } });
const unsigned = (value: AuditEvent) => { const copy = { ...value, data: { ...(value.data ?? {}) } }; delete copy.data!.__odinnIntegrity; return copy; };

async function seed(store: SqliteAuditStore, count: number) {
  if (count <= 0) return;
  await store.append(event(0));
  if (count === 1) return;
  const keyring = JSON.parse(readFileSync(store.keyringPath, "utf8")); const keyId = String(keyring.current); const secret = Buffer.from(String(keyring.keys[keyId]), "base64"); let previous = String((store.db.prepare("SELECT head_signature FROM audit_state WHERE singleton=1").get() as any).head_signature);
  const insert = store.db.prepare("INSERT INTO audit_events(run_id,actor,type,at,key_id,previous_signature,signature,event_json) VALUES(?,?,?,?,?,?,?,?)"); store.db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 1; index < count; index++) { const base = event(index); const signature = createHmac("sha256", secret).update(JSON.stringify({ event: unsigned(base), previous })).digest("base64url"); const signed = normalizeAuditEvent({ ...base, data: { ...(base.data ?? {}), __odinnIntegrity: { keyId, previous, signature } } }); const result = insert.run(signed.runId, signed.actor, signed.type, signed.at, keyId, previous, signature, JSON.stringify(signed)); if (Number(result.lastInsertRowid) !== index + 1) throw new Error("benchmark seed sequence is not contiguous"); previous = signature; }
    store.db.prepare("UPDATE audit_state SET head_sequence=?,head_signature=?,current_key_id=?,updated_at=? WHERE singleton=1").run(count, previous, keyId, new Date().toISOString()); store.db.exec("COMMIT");
  } catch (error) { store.db.exec("ROLLBACK"); throw error; }
}

const reports = [];
for (const size of sizes) {
  const root = mkdtempSync(join(tmpdir(), "odinn-audit-bench-"));
  try {
    const store = new SqliteAuditStore(join(root, "audit.sqlite"), { keyringPath: join(root, "keys.json") });
    const sampleCount = Math.min(size, sampleTarget); const seededEvents = size - sampleCount; await seed(store, seededEvents); const samples: number[] = []; const started = performance.now();
    for (let index = seededEvents; index < size; index++) {
      const before = performance.now();
      await store.append(event(index));
      samples.push(performance.now() - before);
    }
    samples.sort((left, right) => left - right);
    const elapsedMs = performance.now() - started; const memory = process.memoryUsage();
    reports.push({ events: size, seededEvents, sampledAppends: sampleCount, elapsedMs: Number(elapsedMs.toFixed(2)), eventsPerSecond: Number((sampleCount / (elapsedMs / 1_000)).toFixed(2)), appendMs: { p50: Number(percentile(samples, .50).toFixed(3)), p95: Number(percentile(samples, .95).toFixed(3)), p99: Number(percentile(samples, .99).toFixed(3)) }, memoryMiB: { rss: Number((memory.rss / 1048576).toFixed(2)), heapUsed: Number((memory.heapUsed / 1048576).toFixed(2)) }, integrity: await store.verifyIntegrity({ allowUnsigned: false }) });
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
}
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, reports }, null, 2)}\n`);
