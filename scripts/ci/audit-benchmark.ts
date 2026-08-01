import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SqliteAuditStore } from "../../packages/store-sqlite/src/audit.ts";

const sizes = String(process.env.ODINN_AUDIT_BENCHMARK_SIZES ?? "10000,100000,1000000").split(",").map(Number).filter((value) => Number.isSafeInteger(value) && value > 0);
const percentile = (sorted: number[], fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
const reports = [];
for (const size of sizes) {
  const root = mkdtempSync(join(tmpdir(), "odinn-audit-bench-"));
  try {
    const store = new SqliteAuditStore(join(root, "audit.sqlite"), { keyringPath: join(root, "keys.json") });
    const samples: number[] = []; const started = performance.now();
    for (let index = 0; index < size; index++) {
      const before = performance.now();
      await store.append({ at: new Date().toISOString(), runId: `bench-${index % 1_000}`, type: "task.completed", actor: "benchmark", tool: "benchmark", capability: "audit.append", decision: "allow", data: { index } });
      if (size <= 100_000 || index % Math.ceil(size / 100_000) === 0) samples.push(performance.now() - before);
    }
    samples.sort((left, right) => left - right);
    const elapsedMs = performance.now() - started; const memory = process.memoryUsage();
    reports.push({ events: size, elapsedMs: Number(elapsedMs.toFixed(2)), eventsPerSecond: Number((size / (elapsedMs / 1_000)).toFixed(2)), appendMs: { p50: Number(percentile(samples, .50).toFixed(3)), p95: Number(percentile(samples, .95).toFixed(3)), p99: Number(percentile(samples, .99).toFixed(3)) }, memoryMiB: { rss: Number((memory.rss / 1048576).toFixed(2)), heapUsed: Number((memory.heapUsed / 1048576).toFixed(2)) }, integrity: await store.verifyIntegrity({ allowUnsigned: false }) });
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
}
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, reports }, null, 2)}\n`);
