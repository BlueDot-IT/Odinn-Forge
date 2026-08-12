import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MemoryCandidateIndex,
  type MemoryIndexDocument
} from "../../packages/store-sqlite/src/memory-index.ts";

const DOCUMENT_COUNT = 20_000;

test("large memory indexes preserve exact filtered retrieval parity", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-memory-index-invariant-"));
  const documents: MemoryIndexDocument[] = Array.from({ length: DOCUMENT_COUNT }, (_, index) => ({
    id: `memory-${String(index).padStart(6, "0")}`,
    kind: index % 3 === 0 ? "decision" : "note",
    namespace: `project-${index % 20}`,
    scopeType: "project",
    scopeId: `scope-${index % 100}`,
    subject: `Operational note ${index}`,
    summary: index % 997 === 0 ? "quartz raven recovery boundary" : `Routine synthetic record ${index}`,
    text: `Deterministic invariant content for record ${index}. Group ${index % 100}.`,
    tags: [`group-${index % 10}`, index % 2 === 0 ? "even" : "odd"],
    at: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    source: "invariant-fixture",
    authority: "fixture",
    confidence: 1
  }));
  const index = new MemoryCandidateIndex(join(root, "memory.sqlite"));
  try {
    const sourceGeneration = "invariant-1";
    const sourceFingerprint = index.fingerprint(documents);
    index.rebuild(documents, { sourceGeneration, sourceFingerprint });

    const expectedIds = documents
      .filter((document) => document.kind === "decision"
        && document.summary.includes("quartz")
        && document.summary.includes("raven")
        && document.summary.includes("recovery"))
      .sort((left, right) => right.at.localeCompare(left.at) || left.id.localeCompare(right.id))
      .slice(0, 10)
      .map((document) => document.id);
    const actualIds = index.search({
      text: "quartz raven recovery",
      kind: "decision",
      limit: 10,
      expectedSourceGeneration: sourceGeneration,
      expectedSourceFingerprint: sourceFingerprint
    }).map((document) => document.id);

    assert.deepEqual(actualIds, expectedIds);
    assert.deepEqual(index.status({ sourceGeneration, sourceFingerprint }), {
      schemaVersion: 1,
      sourceGeneration,
      sourceFingerprint,
      complete: true,
      documents: DOCUMENT_COUNT,
      stale: false
    });
  } finally {
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});
