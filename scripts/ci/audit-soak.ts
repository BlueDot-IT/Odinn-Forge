import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteAuditStore } from "../../packages/store-sqlite/src/audit.ts";

const worker = fileURLToPath(new URL("./audit-soak-worker.ts", import.meta.url));
const runWriter = (path: string, keys: string, id: number, count: number) => new Promise<void>((resolve, reject) => { const child = spawn(process.execPath, [worker, path, keys, String(id), String(count)], { stdio: ["ignore", "ignore", "pipe"] }); let error = ""; child.stderr.on("data", (chunk) => { error += chunk; }); child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`audit writer ${id} failed (${code}): ${error}`))); });

const root = mkdtempSync(join(tmpdir(), "odinn-audit-soak-"));
try {
  const path = join(root, "audit.sqlite"); const keys = join(root, "keys.json");
  const reader = new SqliteAuditStore(path, { keyringPath: keys }); let wakeups = 0; const unsubscribe = reader.subscribe(() => { wakeups++; });
  const events = Number(process.env.ODINN_AUDIT_SOAK_EVENTS ?? 5_000);
  const counts = Array.from({ length: 4 }, (_, index) => Math.floor(events / 4) + (index < events % 4 ? 1 : 0));
  await Promise.all(counts.map((count, index) => runWriter(path, keys, index, count)));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(wakeups > 0);
  unsubscribe();
  let cursor = 0; let delivered = 0; for (;;) { const page = await reader.readPage({ afterSequence: cursor, limit: 137 }); if (!page.length) break; assert.equal(page[0]!.sequence, cursor + 1); cursor = page.at(-1)!.sequence; delivered += page.length; await reader.ackCursor("soak", cursor); }
  assert.equal(delivered, events); assert.equal(await reader.getCursor("soak"), events); await reader.rotateKey(); reader.rotateSegment();
  const archive = reader.exportArchive(join(root, "archive.jsonl"), Math.floor(events / 2)); await reader.applyRetention(archive.throughSequence);
  assert.equal((await reader.verifyIntegrity({ allowUnsigned: false })).valid, true); reader.close();
  const restarted = new SqliteAuditStore(path, { keyringPath: keys }); assert.equal(await restarted.getCursor("soak"), events); assert.equal((await restarted.verifyIntegrity({ allowUnsigned: false })).valid, true); restarted.close();
  process.stdout.write(`${JSON.stringify({ ok: true, events, delivered, wakeups, restart: true, rotation: true, archive: true, retention: true })}\n`);
} finally { rmSync(root, { recursive: true, force: true }); }
