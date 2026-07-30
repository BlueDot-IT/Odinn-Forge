import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  MEMORY_INDEX_LIMITS,
  MemoryCandidateIndex,
  assertFts5Available,
  memoryFtsQuery,
  validateMemoryIndexDocument,
  type MemoryIndexDocument
} from "../packages/store-sqlite/src/memory-index.ts";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "odinn-memory-index-test-"));
  roots.push(root);
  return root;
}

test.after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function document(id: string, overrides: Partial<MemoryIndexDocument> = {}): MemoryIndexDocument {
  return {
    id,
    kind: "note",
    namespace: "project-odinn",
    scopeType: "project",
    scopeId: "odinn",
    subject: `Subject ${id}`,
    summary: "Routine memory summary",
    text: "Routine memory body",
    tags: ["memory", "test"],
    at: "2026-07-29T12:00:00.000Z",
    source: "test-fixture",
    authority: "user",
    confidence: 0.9,
    ...overrides
  };
}

function open(path: string, options: { maxDocuments?: number } = {}): MemoryCandidateIndex {
  return new MemoryCandidateIndex(path, options);
}

function freshness(index: MemoryCandidateIndex, documents: MemoryIndexDocument[], sourceGeneration: string) {
  return { sourceGeneration, sourceFingerprint: index.fingerprint(documents) };
}

test("validates canonical bounded documents and freshness-sized fields", () => {
  const canonical = validateMemoryIndexDocument(document("valid", { tags: ["z", "a"] }));
  assert.deepEqual(canonical.tags, ["a", "z"]);
  assert.throws(() => validateMemoryIndexDocument(document("bad id!")), /unsupported characters/u);
  assert.throws(() => validateMemoryIndexDocument(document("bad-date", { at: "2026-07-29" })), /canonical ISO/u);
  assert.throws(() => validateMemoryIndexDocument(document("bad-confidence", { confidence: Number.NaN })), /confidence/u);
  assert.throws(
    () => validateMemoryIndexDocument(document("large", { text: "x".repeat(MEMORY_INDEX_LIMITS.fieldBytes + 1) })),
    /exceeds/u
  );
  assert.throws(
    () => validateMemoryIndexDocument(document("many-tags", {
      tags: Array.from({ length: MEMORY_INDEX_LIMITS.tags + 1 }, (_, index) => `tag-${index}`)
    })),
    /tags exceeds/u
  );
  assert.throws(() => validateMemoryIndexDocument(document("duplicate-tags", { tags: ["a", "a"] })), /duplicates/u);
  assert.throws(
    () => validateMemoryIndexDocument({ ...document("unknown"), secret: "must-not-be-silently-ignored" } as any),
    /unknown fields: secret/u
  );
  assert.throws(() => validateMemoryIndexDocument(document("bad-scope", { scopeType: "agent" })), /scopeType/u);
  assert.throws(() => validateMemoryIndexDocument(document("empty-project", { scopeId: "" })), /scopeId/u);
  assert.equal(validateMemoryIndexDocument(document("global", { scopeType: "global", scopeId: "" })).scopeId, "");
  assert.throws(() => validateMemoryIndexDocument(document("global-id", { scopeType: "global", scopeId: "not-empty" })), /empty/u);
});

test("constructs safe token-only FTS expressions without preserving raw MATCH operators", () => {
  assert.equal(memoryFtsQuery('café "raven" OR (restore*)'), '"café" AND "raven" AND "OR" AND "restore"');
  assert.equal(memoryFtsQuery("zero-signal's boundary"), `"zero-signal's" AND "boundary"`);
  assert.throws(() => memoryFtsQuery("***"), /searchable token/u);
  assert.throws(() => memoryFtsQuery("word ".repeat(MEMORY_INDEX_LIMITS.queryTokens + 1)), /tokens/u);
  assert.throws(() => memoryFtsQuery("x".repeat(MEMORY_INDEX_LIMITS.queryTokenBytes + 1)), /token 0/u);
});

test("ranks weighted fields and applies bound filters with deterministic tie-breaks", async () => {
  const root = await temporaryRoot();
  const index = open(join(root, "memory.sqlite"));
  try {
    const documents = [
      document("body-hit", { text: "quartz raven", at: "2026-07-29T12:00:02.000Z" }),
      document("subject-hit", { subject: "quartz raven", text: "other", at: "2026-07-29T12:00:01.000Z" }),
      document("filtered", { subject: "quartz raven", namespace: "other", kind: "decision" }),
      document("tie-b", { summary: "quartz raven", at: "2026-07-29T12:00:03.000Z" }),
      document("tie-a", { summary: "quartz raven", at: "2026-07-29T12:00:03.000Z" })
    ];
    index.rebuild(documents, freshness(index, documents, "generation-1"));

    const ranked = index.search({
      text: "quartz raven",
      namespace: "project-odinn",
      kind: "note",
      scopeType: "project",
      scopeId: "odinn",
      tags: ["memory"],
      atOrAfter: "2026-07-29T12:00:00.000Z",
      atOrBefore: "2026-07-29T12:00:03.000Z",
      expectedSourceGeneration: "generation-1",
      limit: 10
    });
    assert.equal(ranked[0]?.id, "subject-hit");
    assert.deepEqual(ranked.slice(1, 3).map((item) => item.id), ["tie-a", "tie-b"]);
    assert.equal(ranked.some((item) => item.id === "filtered"), false);
    assert.ok(ranked.every((item) => Number.isFinite(item.rank)));
  } finally {
    index.close();
  }
});

test("handles Unicode and quotes while refusing raw boolean and wildcard injection", async () => {
  const root = await temporaryRoot();
  const index = open(join(root, "unicode.sqlite"));
  try {
    const documents = [
      document("unicode", { subject: "Café revenant", text: "boundary" }),
      document("operator-only", { subject: "unrelated", text: "OR wildcard" })
    ];
    index.rebuild(documents, freshness(index, documents, "unicode-1"));
    assert.deepEqual(index.search({ text: '"cafe" revenant', limit: 10 }).map((item) => item.id), ["unicode"]);
    assert.deepEqual(index.search({ text: "OR wildcard", limit: 10 }).map((item) => item.id), ["operator-only"]);
    assert.deepEqual(index.search({ text: "cafe OR wildcard", limit: 10 }), []);
  } finally {
    index.close();
  }
});

test("global scope filtering requires and binds the canonical empty scope ID", async () => {
  const root = await temporaryRoot();
  const index = open(join(root, "global.sqlite"));
  try {
    const documents = [
      document("global-memory", { scopeType: "global", scopeId: "", text: "worldtree" }),
      document("project-memory", { text: "worldtree" })
    ];
    index.rebuild(documents, freshness(index, documents, "scope-1"));
    assert.deepEqual(index.search({ text: "worldtree", scopeType: "global" }).map((item) => item.id), ["global-memory"]);
    assert.throws(() => index.search({ text: "worldtree", scopeId: "odinn" }), /requires scopeType/u);
    assert.throws(() => index.search({ text: "worldtree", scopeType: "global", scopeId: "odinn" }), /empty/u);
  } finally {
    index.close();
  }
});

test("upsert and remove synchronize content, FTS, counts, and freshness", async () => {
  const root = await temporaryRoot();
  const index = open(join(root, "mutations.sqlite"));
  try {
    const initial = [document("mutable", { text: "oldtoken" })];
    const initialFreshness = freshness(index, initial, "generation-1");
    index.rebuild(initial, initialFreshness);
    assert.equal(index.search({ text: "oldtoken" }).length, 1);
    const updatedDocuments = [document("mutable", { text: "newtoken" })];
    const updatedFreshness = freshness(index, updatedDocuments, "generation-2");
    const upserted = index.upsert(updatedDocuments[0], updatedFreshness, initialFreshness);
    assert.equal(upserted.documents, 1);
    assert.equal(index.search({ text: "oldtoken" }).length, 0);
    assert.equal(index.search({ text: "newtoken", expectedSourceFingerprint: updatedFreshness.sourceFingerprint })[0]?.id, "mutable");
    const emptyFreshness = freshness(index, [], "generation-3");
    const removed = index.remove("mutable", {
      ...emptyFreshness
    }, updatedFreshness);
    assert.equal(removed.documents, 0);
    assert.equal(index.search({ text: "newtoken" }).length, 0);
  } finally {
    index.close();
  }
});

test("an interrupted iterable rebuild rolls back documents and freshness atomically", async () => {
  const root = await temporaryRoot();
  const index = open(join(root, "rollback.sqlite"));
  try {
    const prior = [document("prior", { text: "survivor" })];
    const priorFreshness = freshness(index, prior, "prior-generation");
    index.rebuild(prior, priorFreshness);
    function* interrupted(): Generator<MemoryIndexDocument> {
      yield document("replacement", { text: "partial" });
      throw new Error("simulated source interruption");
    }
    assert.throws(() => index.rebuild(interrupted(), {
      sourceGeneration: "replacement-generation",
      sourceFingerprint: index.fingerprint([document("replacement", { text: "partial" })])
    }), /simulated source interruption/u);
    assert.equal(index.search({ text: "survivor", expectedSourceGeneration: "prior-generation" })[0]?.id, "prior");
    assert.equal(index.search({ text: "partial" }).length, 0);
    assert.deepEqual(index.status(), {
      schemaVersion: 1,
      sourceGeneration: "prior-generation",
      sourceFingerprint: priorFreshness.sourceFingerprint,
      complete: true,
      documents: 1,
      stale: false
    });
  } finally {
    index.close();
  }
});

test("freshness is explicit and stale or incomplete searches fail closed", async () => {
  const root = await temporaryRoot();
  const index = open(join(root, "freshness.sqlite"));
  try {
    assert.equal(index.status().complete, false);
    assert.throws(() => index.search({ text: "anything" }), /incomplete or stale/u);
    const documents = [document("fresh", { text: "anything" })];
    const currentFreshness = freshness(index, documents, "fresh-1");
    index.rebuild(documents, currentFreshness);
    assert.equal(index.status({ sourceGeneration: "wrong" }).stale, true);
    assert.throws(
      () => index.search({ text: "anything", expectedSourceFingerprint: "sha256:wrong" }),
      /incomplete or stale/u
    );
  } finally {
    index.close();
  }
});

test("enforces query result, offset, and filter bounds", async () => {
  const root = await temporaryRoot();
  const index = open(join(root, "bounds.sqlite"));
  try {
    const documents = [document("bounded", { text: "bounded" })];
    index.rebuild(documents, freshness(index, documents, "bounds-1"));
    assert.throws(() => index.search({ text: "bounded", limit: MEMORY_INDEX_LIMITS.results + 1 }), /limit/u);
    assert.throws(() => index.search({ text: "bounded", offset: MEMORY_INDEX_LIMITS.offset + 1 }), /offset/u);
    assert.throws(() => index.search({ text: "bounded", namespace: "bad space" }), /unsupported/u);
    assert.throws(() => index.search({
      text: "bounded",
      tags: Array.from({ length: MEMORY_INDEX_LIMITS.tags + 1 }, (_, value) => `tag-${value}`)
    }), /tags exceeds/u);
  } finally {
    index.close();
  }
});

test("rebuild verifies the declared fingerprint and preserves the prior generation on mismatch", async () => {
  const root = await temporaryRoot();
  const index = open(join(root, "fingerprint.sqlite"));
  try {
    const prior = [document("prior-fingerprint", { text: "survivor" })];
    const priorFreshness = freshness(index, prior, "fingerprint-1");
    index.rebuild(prior, priorFreshness);
    assert.throws(() => index.rebuild([document("replacement-fingerprint", { text: "replacement" })], {
      sourceGeneration: "fingerprint-2",
      sourceFingerprint: "sha256:not-the-canonical-fingerprint"
    }), /fingerprint mismatch/u);
    assert.equal(index.search({ text: "survivor", expectedSourceGeneration: "fingerprint-1" }).length, 1);
  } finally {
    index.close();
  }
});

test("corpus fingerprints are order-independent and reject duplicate IDs", async () => {
  const root = await temporaryRoot();
  const index = open(join(root, "fingerprint-order.sqlite"));
  try {
    const first = document("a", { text: "first" });
    const second = document("b", { text: "second" });
    assert.equal(index.fingerprint([first, second]), index.fingerprint([second, first]));
    assert.throws(() => index.fingerprint([first, first]), /duplicate id/u);
    const reversed = [second, first];
    index.rebuild(reversed, freshness(index, [first, second], "order-1"));
    assert.equal(index.status().documents, 2);
  } finally {
    index.close();
  }
});

test("incremental mutations reject incomplete indexes and stale writers", async () => {
  const root = await temporaryRoot();
  const index = open(join(root, "compare-and-swap.sqlite"));
  try {
    assert.throws(() => index.upsert(document("partial"), {
      sourceGeneration: "next",
      sourceFingerprint: "sha256:next"
    }, {
      sourceGeneration: "missing",
      sourceFingerprint: "sha256:missing"
    }), /complete memory index/u);

    const initial = [document("initial", { text: "initialtoken" })];
    const initialFreshness = freshness(index, initial, "cas-1");
    index.rebuild(initial, initialFreshness);
    const next = document("next", { text: "nexttoken" });
    const nextFreshness = freshness(index, [initial[0], next], "cas-2");
    index.upsert(next, nextFreshness, initialFreshness);
    assert.throws(() => index.remove("initial", {
      sourceGeneration: "cas-3",
      sourceFingerprint: "sha256:cas-three"
    }, initialFreshness), /freshness conflict/u);
    assert.equal(index.search({ text: "initialtoken", expectedSourceGeneration: "cas-2" }).length, 1);
  } finally {
    index.close();
  }
});

test("incremental mutations reject fabricated post-state fingerprints transactionally", async () => {
  const root = await temporaryRoot();
  const index = open(join(root, "incremental-fingerprint.sqlite"));
  try {
    const initial = [document("initial-fingerprint", { text: "survivor" })];
    const initialFreshness = freshness(index, initial, "incremental-1");
    index.rebuild(initial, initialFreshness);
    assert.throws(() => index.upsert(document("fabricated", { text: "partial" }), {
      sourceGeneration: "incremental-2",
      sourceFingerprint: "sha256:fabricated"
    }, initialFreshness), /post-upsert corpus/u);
    assert.equal(index.search({ text: "partial" }).length, 0);
    assert.equal(index.search({ text: "survivor", expectedSourceGeneration: "incremental-1" }).length, 1);

    assert.throws(() => index.remove("initial-fingerprint", {
      sourceGeneration: "incremental-3",
      sourceFingerprint: "sha256:fabricated"
    }, initialFreshness), /post-remove corpus/u);
    assert.equal(index.search({ text: "survivor", expectedSourceGeneration: "incremental-1" }).length, 1);
  } finally {
    index.close();
  }
});

test("uses explicit single-owner locking and releases it only on close", async () => {
  const root = await temporaryRoot();
  const path = join(root, "owner.sqlite");
  const first = open(path);
  try {
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o077, 0);
      assert.equal((await stat(first.lockPath)).mode & 0o077, 0);
    }
    assert.throws(() => open(path), /already owned/u);
  } finally {
    first.close();
  }
  const next = open(path);
  next.close();
});

test("owner close releases the original lock inode even when its record becomes malformed", async () => {
  const root = await temporaryRoot();
  const path = join(root, "malformed-lock.sqlite");
  const first = open(path);
  await writeFile(first.lockPath, "{malformed");
  first.close();
  const second = open(path);
  second.close();
});

test("open repairs a dropped FTS structure but remains incomplete until explicit rebuild", async () => {
  const root = await temporaryRoot();
  const path = join(root, "dropped-fts.sqlite");
  const documents = [document("fts-recovery", { text: "recoverabletoken" })];
  const first = open(path);
  first.rebuild(documents, freshness(first, documents, "fts-1"));
  first.close();

  const raw = new DatabaseSync(path);
  raw.exec("DROP TABLE memory_documents_fts");
  raw.close();

  const recovered = open(path);
  try {
    assert.equal(recovered.status().complete, false);
    assert.throws(() => recovered.search({ text: "recoverabletoken" }), /incomplete or stale/u);
    const nextFreshness = freshness(recovered, documents, "fts-2");
    recovered.rebuild(documents, nextFreshness);
    assert.equal(recovered.search({ text: "recoverabletoken", expectedSourceGeneration: "fts-2" })[0]?.id, "fts-recovery");
  } finally {
    recovered.close();
  }
});

test("open repairs missing synchronization triggers but requires a rebuild", async () => {
  const root = await temporaryRoot();
  const path = join(root, "missing-trigger.sqlite");
  const documents = [document("trigger-recovery", { text: "triggertoken" })];
  const first = open(path);
  first.rebuild(documents, freshness(first, documents, "trigger-1"));
  first.close();

  const raw = new DatabaseSync(path);
  raw.exec("DROP TRIGGER memory_documents_ai");
  raw.close();
  const recovered = open(path);
  try {
    assert.equal(recovered.status().complete, false);
    const nextFreshness = freshness(recovered, documents, "trigger-2");
    recovered.rebuild(documents, nextFreshness);
    assert.equal(recovered.search({ text: "triggertoken" }).length, 1);
  } finally {
    recovered.close();
  }
});

test("exact schema contracts reject malicious no-op triggers and altered tokenizers", async () => {
  const root = await temporaryRoot();
  const triggerPath = join(root, "malicious-trigger.sqlite");
  const triggerIndex = open(triggerPath);
  triggerIndex.close();
  const triggerDatabase = new DatabaseSync(triggerPath);
  triggerDatabase.exec(`
    DROP TRIGGER memory_documents_ai;
    CREATE TRIGGER memory_documents_ai AFTER INSERT ON memory_documents BEGIN
      SELECT 'insert into memory_documents_fts new.tags_json';
    END;
  `);
  triggerDatabase.close();
  assert.throws(() => open(triggerPath), /canonical contract/u);

  const tokenizerPath = join(root, "altered-tokenizer.sqlite");
  const tokenizerIndex = open(tokenizerPath);
  tokenizerIndex.close();
  const tokenizerDatabase = new DatabaseSync(tokenizerPath);
  tokenizerDatabase.exec(`
    DROP TABLE memory_documents_fts;
    CREATE VIRTUAL TABLE memory_documents_fts USING fts5(
      subject, summary, text, tags_json,
      content='memory_documents',
      content_rowid='rowid',
      tokenize='porter'
    );
  `);
  tokenizerDatabase.close();
  assert.throws(() => open(tokenizerPath), /canonical contract/u);
});

test("live trigger divergence makes incremental mutation roll back before freshness publication", async () => {
  const root = await temporaryRoot();
  const path = join(root, "live-trigger-defect.sqlite");
  const index = open(path);
  try {
    const initial = [document("live-prior", { text: "survivortoken" })];
    const initialFreshness = freshness(index, initial, "live-1");
    index.rebuild(initial, initialFreshness);
    const raw = new DatabaseSync(path);
    raw.exec(`
      DROP TRIGGER memory_documents_ai;
      CREATE TRIGGER memory_documents_ai AFTER INSERT ON memory_documents BEGIN SELECT 1; END;
    `);
    raw.close();
    const added = document("live-added", { text: "shouldrollback" });
    assert.throws(
      () => index.upsert(added, freshness(index, [...initial, added], "live-2"), initialFreshness),
      /FTS\/content parity failed/u
    );
    assert.equal(index.search({ text: "survivortoken", expectedSourceGeneration: "live-1" }).length, 1);
    assert.equal(index.search({ text: "shouldrollback" }).length, 0);
  } finally {
    index.close();
  }
});

test("external-content integrity check detects coherent but incorrect FTS tokens", async () => {
  const root = await temporaryRoot();
  const path = join(root, "fts-parity.sqlite");
  const documents = [document("fts-parity", { text: "canonicaltoken" })];
  const first = open(path);
  first.rebuild(documents, freshness(first, documents, "parity-1"));
  first.close();
  const raw = new DatabaseSync(path);
  const row = raw.prepare("SELECT rowid, subject, summary, text, tags_json FROM memory_documents WHERE id = ?").get("fts-parity") as any;
  raw.prepare(`
    INSERT INTO memory_documents_fts(memory_documents_fts, rowid, subject, summary, text, tags_json)
    VALUES ('delete', ?, ?, ?, ?, ?)
  `).run(row.rowid, row.subject, row.summary, row.text, row.tags_json);
  raw.prepare(`
    INSERT INTO memory_documents_fts(rowid, subject, summary, text, tags_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(row.rowid, row.subject, row.summary, "forgedtoken", row.tags_json);
  raw.close();

  const recovered = open(path);
  try {
    assert.equal(recovered.status().complete, false);
    recovered.rebuild(documents, freshness(recovered, documents, "parity-2"));
    assert.equal(recovered.search({ text: "canonicaltoken" }).length, 1);
    assert.equal(recovered.search({ text: "forgedtoken" }).length, 0);
  } finally {
    recovered.close();
  }
});

test("open rejects malformed persisted documents and metadata without leaving a lock", async () => {
  const root = await temporaryRoot();
  const malformedDocumentPath = join(root, "malformed-document.sqlite");
  const documents = [document("malformed-row", { text: "valid-before-corruption" })];
  const first = open(malformedDocumentPath);
  first.rebuild(documents, freshness(first, documents, "malformed-1"));
  first.close();
  const rawDocument = new DatabaseSync(malformedDocumentPath);
  rawDocument.prepare("UPDATE memory_documents SET scope_type = 'unknown' WHERE id = ?").run("malformed-row");
  rawDocument.close();
  assert.throws(() => open(malformedDocumentPath), /scopeType must be/u);
  await assert.rejects(() => readFile(`${malformedDocumentPath}.lock`), (error: any) => error?.code === "ENOENT");

  const malformedMetadataPath = join(root, "malformed-metadata.sqlite");
  const second = open(malformedMetadataPath);
  second.rebuild(documents, freshness(second, documents, "metadata-1"));
  second.close();
  const rawMetadata = new DatabaseSync(malformedMetadataPath);
  rawMetadata.prepare("UPDATE memory_index_metadata SET source_generation = 'bad generation'").run();
  rawMetadata.close();
  assert.throws(() => open(malformedMetadataPath), /unsupported characters/u);
  await assert.rejects(() => readFile(`${malformedMetadataPath}.lock`), (error: any) => error?.code === "ENOENT");

  const missingMetadataPath = join(root, "missing-metadata.sqlite");
  const third = open(missingMetadataPath);
  third.close();
  const rawMissingMetadata = new DatabaseSync(missingMetadataPath);
  rawMissingMetadata.exec("DELETE FROM memory_index_metadata");
  rawMissingMetadata.close();
  assert.throws(() => open(missingMetadataPath), /exactly one row/u);
});

test("metadata count drift fails closed and is recoverable through rebuild", async () => {
  const root = await temporaryRoot();
  const path = join(root, "metadata-count.sqlite");
  const documents = [document("count-recovery", { text: "counttoken" })];
  const first = open(path);
  first.rebuild(documents, freshness(first, documents, "count-1"));
  first.close();
  const raw = new DatabaseSync(path);
  raw.exec("UPDATE memory_index_metadata SET document_count = 0");
  raw.close();
  const recovered = open(path);
  try {
    assert.equal(recovered.status().complete, false);
    recovered.rebuild(documents, freshness(recovered, documents, "count-2"));
    assert.equal(recovered.status().complete, true);
  } finally {
    recovered.close();
  }
});

test("a missing performance index is recreated without invalidating complete freshness", async () => {
  const root = await temporaryRoot();
  const path = join(root, "missing-filter-index.sqlite");
  const documents = [document("filter-index", { text: "filtertoken" })];
  const first = open(path);
  const sourceFreshness = freshness(first, documents, "filter-1");
  first.rebuild(documents, sourceFreshness);
  first.close();
  const raw = new DatabaseSync(path);
  raw.exec("DROP INDEX memory_documents_filters");
  raw.close();
  const reopened = open(path);
  try {
    assert.equal(reopened.status(sourceFreshness).stale, false);
    assert.equal(reopened.search({ text: "filtertoken", expectedSourceGeneration: "filter-1" }).length, 1);
  } finally {
    reopened.close();
  }
  const verified = new DatabaseSync(path);
  assert.equal(
    Boolean(verified.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='memory_documents_filters'").get()),
    true
  );
  verified.close();
});

test("streaming open rejects the first over-limit row before materializing or validating it", async () => {
  const root = await temporaryRoot();
  const path = join(root, "stream-limit.sqlite");
  const documents = [
    document("stream-1"),
    document("stream-2"),
    document("stream-3")
  ];
  const first = open(path);
  first.rebuild(documents, freshness(first, documents, "stream-1"));
  first.close();
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE memory_documents SET scope_type = 'malformed' WHERE id = 'stream-3'").run();
  raw.close();
  assert.throws(() => open(path, { maxDocuments: 2 }), /more than 2 documents/u);
});

test("rejects symlinked parents and database files", { skip: process.platform === "win32" }, async () => {
  const root = await temporaryRoot();
  const real = join(root, "real");
  const linked = join(root, "linked");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(real);
  await symlink(real, linked, "dir");
  assert.throws(() => open(join(linked, "memory.sqlite")), /symbolic link/u);

  const target = join(root, "target.sqlite");
  await writeFile(target, "");
  const linkedFile = join(root, "linked.sqlite");
  await symlink(target, linkedFile, "file");
  assert.throws(() => open(linkedFile), /symbolic-link/u);

  const hardLinkTarget = join(root, "hard-target.sqlite");
  await writeFile(hardLinkTarget, "");
  const hardLink = join(root, "hard-linked.sqlite");
  await link(hardLinkTarget, hardLink);
  assert.throws(() => open(hardLink), /hard-linked/u);

  const journalPath = join(real, "journal.sqlite");
  await chmod(real, 0o700);
  await writeFile(journalPath, "");
  await symlink(target, `${journalPath}-journal`, "file");
  assert.throws(() => open(journalPath), /sidecar/u);
});

test("requires an owner-only immediate parent on POSIX", { skip: process.platform === "win32" }, async () => {
  const root = await temporaryRoot();
  await chmod(root, 0o755);
  assert.throws(() => open(join(root, "permissions.sqlite")), /owner-only/u);
  await chmod(root, 0o700);
});

test("reports a clear FTS5 capability error", () => {
  assert.throws(
    () => assertFts5Available({ exec: () => { throw new Error("no such module: fts5"); }, prepare: () => { throw new Error("unused"); } } as any),
    /FTS5 is unavailable/u
  );
});

test("constructor failure closes SQLite and releases its owner lock", async () => {
  const root = await temporaryRoot();
  const path = join(root, "invalid.sqlite");
  await writeFile(path, "not a sqlite database");
  assert.throws(() => open(path), /database|encrypted|FTS5 is unavailable/u);
  await assert.rejects(() => readFile(`${path}.lock`), (error: any) => error?.code === "ENOENT");
});

test("status validates expected freshness bounds", async () => {
  const root = await temporaryRoot();
  const index = open(join(root, "status-bounds.sqlite"));
  try {
    assert.throws(() => index.status({ sourceGeneration: "bad generation" }), /unsupported characters/u);
    assert.throws(() => index.status({ sourceFingerprint: "x".repeat(513) }), /exceeds 512/u);
    assert.throws(() => index.status(null as any), /must be an object/u);
  } finally {
    index.close();
  }
});

test("package subpath resolves while root and active runtime stay import-isolated", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../packages/store-sqlite/package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.exports["./memory-index"], "./src/memory-index.ts");
  assert.equal(packageJson.exports["."], "./src/index.ts");
  execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    "const module = await import('@odinn/store-sqlite/memory-index'); if (!module.MemoryCandidateIndex) process.exit(1)"
  ], { cwd: new URL("../packages/kernel", import.meta.url), stdio: "pipe" });

  const activeFiles = [
    "../packages/store-sqlite/src/index.ts",
    "../packages/kernel/src/index.ts",
    "../packages/kernel/src/memory.ts",
    "../apps/gateway/src/index.ts"
  ];
  for (const relative of activeFiles) {
    const source = await readFile(new URL(relative, import.meta.url), "utf8").catch((error: any) => {
      if (error?.code === "ENOENT") return "";
      throw error;
    });
    assert.doesNotMatch(source, /memory-index|MemoryCandidateIndex/u, relative);
  }
});
