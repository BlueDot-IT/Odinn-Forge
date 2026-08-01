import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAuditStore } from "../../packages/store-sqlite/src/audit.ts";

const root = mkdtempSync(join(tmpdir(), "odinn-audit-soak-"));
try {
  const path = join(root, "audit.sqlite"); const keys = join(root, "keys.json");
  const writers = Array.from({ length: 4 }, () => new SqliteAuditStore(path, { keyringPath: keys }));
  const reader = new SqliteAuditStore(path, { keyringPath: keys }); let wakeups = 0; const unsubscribe = reader.subscribe(() => { wakeups++; });
  const events = Number(process.env.ODINN_AUDIT_SOAK_EVENTS ?? 5_000);
  await Promise.all(Array.from({ length: events }, (_, index) => writers[index % writers.length]!.append({ at: new Date().toISOString(), runId: `soak-${index % 100}`, type: index % 2 ? "task.started" : "task.completed", actor: "soak", tool: "soak", capability: "audit.append", decision: "allow", data: { index } })));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(wakeups > 0);
  unsubscribe(); for (const writer of writers) writer.close();
  let cursor = 0; let delivered = 0; for (;;) { const page = await reader.readPage({ afterSequence: cursor, limit: 137 }); if (!page.length) break; assert.equal(page[0]!.sequence, cursor + 1); cursor = page.at(-1)!.sequence; delivered += page.length; await reader.ackCursor("soak", cursor); }
  assert.equal(delivered, events); assert.equal(await reader.getCursor("soak"), events); await reader.rotateKey(); reader.rotateSegment();
  const archive = reader.exportArchive(join(root, "archive.jsonl"), Math.floor(events / 2)); reader.applyRetention(archive.throughSequence);
  assert.equal((await reader.verifyIntegrity({ allowUnsigned: false })).valid, true); reader.close();
  const restarted = new SqliteAuditStore(path, { keyringPath: keys }); assert.equal(await restarted.getCursor("soak"), events); assert.equal((await restarted.verifyIntegrity({ allowUnsigned: false })).valid, true); restarted.close();
  process.stdout.write(`${JSON.stringify({ ok: true, events, delivered, wakeups, restart: true, rotation: true, archive: true, retention: true })}\n`);
} finally { rmSync(root, { recursive: true, force: true }); }
