import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCandidateIndex, type MemoryIndexDocument } from "../../packages/store-sqlite/src/memory-index.ts";

const documentCount = 20_000;
const samples = 50;
const documents: MemoryIndexDocument[] = Array.from({ length: documentCount }, (_, index) => ({
  id: `memory-${String(index).padStart(6, "0")}`,
  kind: index % 3 === 0 ? "decision" : "note",
  namespace: `project-${index % 20}`,
  scopeType: "project",
  scopeId: `scope-${index % 100}`,
  subject: `Operational note ${index}`,
  summary: index % 997 === 0 ? "quartz raven recovery boundary" : `Routine synthetic record ${index}`,
  text: `Deterministic benchmark content for record ${index}. Group ${index % 100}.`,
  tags: [`group-${index % 10}`, index % 2 === 0 ? "even" : "odd"],
  at: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
  source: "synthetic-benchmark",
  authority: "fixture",
  confidence: 1
}));

function measure(operation: () => unknown): { p50Ms: number; p95Ms: number } {
  for (let index = 0; index < 5; index += 1) operation();
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    operation();
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  const percentile = (value: number) => durations[Math.min(durations.length - 1, Math.ceil(durations.length * value) - 1)] ?? 0;
  return { p50Ms: Number(percentile(0.5).toFixed(3)), p95Ms: Number(percentile(0.95).toFixed(3)) };
}

const root = await mkdtemp(join(tmpdir(), "odinn-memory-index-benchmark-"));
const index = new MemoryCandidateIndex(join(root, "memory.sqlite"));
try {
  const fingerprintStarted = performance.now();
  const sourceFingerprint = index.fingerprint(documents);
  const fingerprintMs = performance.now() - fingerprintStarted;
  const rebuildStarted = performance.now();
  index.rebuild(documents, { sourceGeneration: "benchmark-1", sourceFingerprint });
  const rebuildMs = performance.now() - rebuildStarted;
  const ftsQuery = () => index.search({
    text: "quartz raven recovery",
    kind: "decision",
    limit: 10,
    expectedSourceGeneration: "benchmark-1"
  }).map((document) => document.id);
  const scanQuery = () => documents
    .filter((document) => document.kind === "decision"
      && document.summary.includes("quartz")
      && document.summary.includes("raven")
      && document.summary.includes("recovery"))
    .sort((left, right) => right.at.localeCompare(left.at) || left.id.localeCompare(right.id))
    .slice(0, 10)
    .map((document) => document.id);
  const expectedIds = scanQuery();
  const actualIds = ftsQuery();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`benchmark retrieval parity failed: FTS=${JSON.stringify(actualIds)} scan=${JSON.stringify(expectedIds)}`);
  }
  const fts = measure(ftsQuery);
  const scan = measure(scanQuery);
  const observedWinner = fts.p50Ms < scan.p50Ms ? "fts5" : fts.p50Ms > scan.p50Ms ? "full-js-scan" : "tie";
  console.log(JSON.stringify({
    schemaVersion: 1,
    corpus: { documents: documentCount, synthetic: true },
    fingerprintMs: Number(fingerprintMs.toFixed(3)),
    rebuildMs: Number(rebuildMs.toFixed(3)),
    samples,
    equivalentResultIds: true,
    fts5: fts,
    fullJsScan: scan,
    observedWinner,
    caveat: "Lexical synthetic timing only; no semantic-quality or production-corpus parity claim."
  }, null, 2));
} finally {
  index.close();
  await rm(root, { recursive: true, force: true });
}
