# SQLite/FTS5 memory candidate index

Odinn includes a standalone, **default-inert** memory retrieval candidate at
`@odinn/store-sqlite/memory-index`. It is not imported by the store package
root, kernel, gateway, prompt construction, or the current memory runtime.
Merely installing this version therefore adds no work to an interactive turn.

## Scope and safety

The candidate owns a separate SQLite file and requires SQLite FTS5. It validates
canonical memory documents, enforces UTF-8 byte and collection limits, binds
all filters, and converts user text to quoted tokens instead of accepting raw
FTS `MATCH` syntax. Results use BM25 followed by timestamp and ID tie-breaks.
Scopes are limited to `global`, `project`, and `session`; global scope requires
an empty scope ID and the other scopes require a bounded non-empty ID.
One live `MemoryCandidateIndex` owns a file; a second owner fails closed. Index
files, SQLite sidecars, their immediate parent, and the owner lock are checked
for unsafe links and identity replacement. POSIX parents must be owner-only.
Windows ACL ownership and junction/reparse-point behavior remains an explicit
activation gap and requires native CI proof.

Rebuilds run in one `BEGIN IMMEDIATE` transaction. The generation and
fingerprint become visible only with the complete replacement. If iteration,
validation, insertion, or commit fails, SQLite restores the prior queryable
generation. The canonical corpus fingerprint hashes per-document canonical
digests ordered by document ID, so source iteration order cannot alter it. A
rebuild computes it during the transaction and rejects a caller-declared
fingerprint mismatch. Incremental
upsert/removal requires a complete index plus the exact current generation and
fingerprint, then verifies the declared post-state fingerprint before commit,
preventing stale or fabricated writers from publishing over newer state.
Callers can compare `status()` with source freshness or pass
expected freshness to `search()`, which fails closed on a stale or incomplete
index.

On open, core and auxiliary objects are compared with exact canonical SQL
contracts, while PRAGMA checks independently verify column constraints,
strictness, index columns, and FTS columns. Canonical rows are streamed in ID
order into the corpus fingerprint with a count bound; they are not loaded as a
corpus-sized array. Metadata count, corpus fingerprint, and external-content
FTS parity are checked. Repairable FTS or synchronization damage is
structurally repaired but marked incomplete; an explicit authoritative rebuild
is required before queries resume. A missing performance-only filter index is
recreated without invalidating otherwise complete source freshness. Fatal core
schema or row corruption rejects open. Every mutation repeats FTS/content
integrity checks inside its transaction before publishing complete freshness.

Default limits are exported as `MEMORY_INDEX_LIMITS`: 512 KiB per canonical
document, 250,000 documents per rebuild, 2 KiB/32 tokens per query, 100 results,
and an offset of 10,000.

## Authoritative record storage (#58)

The active project, session, workspace, goal, lifecycle, and memory paths use
`@odinn/store-sqlite`'s `SqliteRecordStore` as the authoritative event store.
Logical reads are expressed through `queryRecordsPage`, which applies bounded
page sizes and opaque sequence keyset cursors; callers must not use `OFFSET`,
`readAll()`, or pseudo-unbounded limits. Filters are scope-bound before the
query reaches SQLite. Message external IDs are covered by a partial unique
index for idempotent replay.

Legacy `records.jsonl` migration is backup-first and records a source hash,
byte cursor, progress count, and completion state in SQLite. It can resume
from an interrupted chunk and rollback by removing the SQLite target while
retaining the pre-migration backup. Migration does not activate FTS5; the FTS
candidate remains an opt-in, separate retrieval layer pending parity and
cross-platform activation proof.

## Parity and activation gates

FTS5 is lexical retrieval. It does not reproduce embeddings, semantic
similarity, the current memory contamination controls, recency weighting beyond
tie-breaking, or authority policy. Activation requires:

1. an adapter that maps the authoritative memory source without losing scope,
   authority, confidence, or deletion semantics;
2. generation/fingerprint reconciliation and crash-recovery tests against that
   source;
3. retrieval-quality and contamination parity on representative corpora;
4. security review of multi-user scope enforcement;
5. cross-platform FTS5 packaging proof; and
6. existing inference latency gates plus the synthetic candidate benchmark.

`pnpm benchmark:memory-index` builds a deterministic 20,000-document corpus and
first proves equivalent result IDs, then reports bounded FTS5 retrieval beside a
simple full JavaScript scan. Fingerprint and rebuild timing are separate. It is
diagnostic evidence, not a replacement for `pnpm benchmark:ci`, and does not
claim a speedup when the observed FTS result is slower, production relevance, or
semantic-quality parity.
