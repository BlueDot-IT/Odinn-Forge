# Audit storage operations

Odinn stores the active audit journal in `db/audit.sqlite`. Appends serialize with
`BEGIN IMMEDIATE`, insert the signed event, and advance the chain head in the same
FULL-synchronous transaction. Run projections and subscriber reads use indexed
queries; the gateway never scans the full journal to deliver server-sent events.

## Legacy migration and rollback

On first open, an existing configured `audit*.jsonl` is copied to the owner-only
`audit*.jsonl.migration.bak` before import. Import uses bounded 64 KiB reads and a
single transaction. The SQLite store is activated only after the source remains
unchanged and the completion marker and chain head commit together. A failed or
interrupted import rolls back without removing the source or backup.

`rollbackLegacyAuditMigration` restores the protected JSONL backup and moves the
SQLite database and its sidecars to uniquely named rollback artifacts. It does
not delete either representation.

## Streaming and cursors

SSE event IDs are durable SQLite sequence numbers. `Last-Event-ID` or `since`
resumes exclusively after that sequence. Supplying a bounded `subscriber` query
parameter also persists monotonic acknowledgement state. Appenders publish an
advisory cross-process notification after commit; subscribers always drain
bounded `sequence > cursor` pages, so a missed or coalesced notification cannot
lose or duplicate an event. Keepalive comments do not query storage.

## Verification, rotation, archives, and retention

Integrity verification pages from the retained anchor through the active head
and checks sequence continuity, key availability, previous-signature links,
event HMACs, and the stored head. Key rotation retains old verification keys.
Segment rotation seals the current sequence/signature boundary and anchors the
next segment.

`exportArchive` creates deterministic sequence-tagged JSONL and a HMAC-signed
manifest. Online retention refuses to remove events unless a matching archive,
digest, manifest signature, key, and boundary signature all verify. State backup
uses the SQLite backup API and excludes WAL, SHM, and notification sidecars.

## Evidence commands

```sh
pnpm soak:audit
pnpm benchmark:audit
```

The benchmark defaults to 10K, 100K, and 1M events and reports append p50/p95/p99,
throughput, memory, and final chain verification. Override sizes for a smoke run
with `ODINN_AUDIT_BENCHMARK_SIZES=1000`.
