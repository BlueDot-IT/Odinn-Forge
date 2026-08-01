import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRecordStore } from "../../packages/store-sqlite/src/index.ts";

const sizes = [10_000, 100_000, 1_000_000];
const pageSize = 100;
const samples = 20;

function measure(operation: () => unknown) {
  for (let index = 0; index < 3; index += 1) operation();
  const durations: number[] = [];
  let peakHeap = process.memoryUsage().heapUsed;
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    operation();
    durations.push(performance.now() - started);
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }
  durations.sort((left, right) => left - right);
  const percentile = (value: number) => durations[Math.min(durations.length - 1, Math.ceil(durations.length * value) - 1)] ?? 0;
  return {
    p50Ms: Number(percentile(0.5).toFixed(3)),
    p95Ms: Number(percentile(0.95).toFixed(3)),
    peakHeapMb: Number((peakHeap / 1024 / 1024).toFixed(3))
  };
}

const root = await mkdtemp(join(tmpdir(), "odinn-authoritative-record-benchmark-"));
const results: unknown[] = [];
try {
  for (const size of sizes) {
    const store = new SqliteRecordStore(join(root, `records-${size}.sqlite`));
    const seedStarted = performance.now();
    await store.transaction((transaction) => {
      for (let index = 0; index < size; index += 1) {
        transaction.append({
          id: `record-${index}`,
          type: index % 11 === 0 ? "memory" : index % 5 === 0 ? "goal.updated" : "message.appended",
          sessionId: `session-${index % 1000}`,
          projectId: `project-${index % 100}`,
          namespace: `projects/project-${index % 100}`,
          kind: index % 11 === 0 ? "decision" : undefined,
          status: index % 7 === 0 ? "active" : "open",
          externalId: index % 5 === 0 ? `external-${index}` : undefined,
          subject: `subject-${index % 1000}`,
          text: `synthetic record ${index}`
        });
      }
    });
    const seedMs = performance.now() - seedStarted;
    const scopedPage = () => store.queryRecordsPage({ types: ["memory"], namespace: "projects/project-42", limit: pageSize, order: "asc" });
    const externalLookup = () => store.findMessageByExternalIdSync(`session-${(size - 5) % 1000}`, `external-${size - 5}`);
    const sessionPage = () => store.queryRecordsPage({ types: ["message.appended"], sessionId: "session-42", limit: pageSize, order: "desc" });
    results.push({
      records: size,
      pageSize,
      samples,
      seedMs: Number(seedMs.toFixed(3)),
      scopedPage: measure(scopedPage),
      sessionPage: measure(sessionPage),
      externalLookup: measure(externalLookup)
    });
    store.close();
  }
  console.log(JSON.stringify({ schemaVersion: 1, authoritative: "sqlite-record-events", ftsActivated: false, results }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
