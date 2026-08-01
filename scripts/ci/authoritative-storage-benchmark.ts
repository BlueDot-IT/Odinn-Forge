import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SqliteRecordStore } from "../../packages/store-sqlite/src/authoritative.ts";

const sizes = (process.env.BENCHMARK_SIZES ?? "10000,100000,1000000")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isSafeInteger(value) && value > 0);
const samples = Number(process.env.BENCHMARK_SAMPLES ?? 100);

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

for (const size of sizes) {
  const root = await mkdtemp(join(tmpdir(), `odinn-authoritative-benchmark-${size}-`));
  const store = new SqliteRecordStore(join(root, "records.sqlite"));
  const heapBefore = process.memoryUsage().heapUsed;
  const appendStart = performance.now();
  store.transaction(() => {
    for (let index = 0; index < size; index += 1) {
      store.appendSync({
        id: `memory-${index}`,
        type: "memory",
        at: new Date(index).toISOString(),
        status: "active",
        namespace: "project/benchmark",
        kind: "fact",
        subject: `subject-${index % 1000}`,
        text: `benchmark record ${index}`
      });
    }
  });
  const appendMs = performance.now() - appendStart;
  const latencies: number[] = [];
  let peakHeap = process.memoryUsage().heapUsed;
  for (let sample = 0; sample < Math.min(samples, size); sample += 1) {
    const start = performance.now();
    store.queryRecordsPageSync({
      activeMemoryOnly: true,
      namespacePrefix: "project/benchmark",
      subject: `subject-${sample % 1000}`,
      limit: 50,
      cursor: sample === 0 ? undefined : Buffer.from(JSON.stringify({ sequence: sample }), "utf8").toString("base64url")
    });
    latencies.push(performance.now() - start);
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  store.close();
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({
    rows: size,
    append_ms: Number(appendMs.toFixed(3)),
    query_ms_p50: Number(percentile(latencies, 0.50).toFixed(3)),
    query_ms_p95: Number(percentile(latencies, 0.95).toFixed(3)),
    query_ms_p99: Number(percentile(latencies, 0.99).toFixed(3)),
    peak_heap_delta_mb: Number(((peakHeap - heapBefore) / 1024 / 1024).toFixed(3))
  }));
}
