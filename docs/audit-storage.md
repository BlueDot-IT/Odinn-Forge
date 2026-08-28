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
lose or duplicate an event. The 15-second keepalive also performs a bounded
indexed cursor drain to repair a completely lost notification without scanning
history.

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
pnpm state:growth
```

The soak validates concurrent append, cursor persistence, segment rotation,
archive and retention behavior, restart, and final chain integrity. Comparative
audit performance evaluation belongs in
[BlueDot-IT/agent-benchmarks](https://github.com/BlueDot-IT/agent-benchmarks).

`pnpm state:growth` is the scheduled large-state acceptance lane. It grows one
production authoritative SQLite store through 10,000, 100,000, and 1,000,000
records. At every tier it checkpoints and closes the database, reopens it,
verifies the exact record count and a known record, runs a SQLite integrity
check, and samples bounded point, page, projection, and count queries. The same
run creates a signed audit store, exports and verifies an archive, applies
online retention only after that verification, and proves integrity again
after restart.

The acceptance budgets cap the authoritative database at 3 GiB and 3,072 bytes
per record, process RSS at 1.5 GiB, query p95 at one second, reopen and integrity
checks at two minutes each, and the audit database at 64 MiB. Incremental append
throughput must remain at least 250 records per second. The command writes the
machine-readable `dist/reports/state-growth-report.json`; the nightly workflow
retains that report for 30 days, including when a budget fails.

For a local development probe, `ODINN_STATE_GROWTH_TIERS` accepts a strictly
ascending comma-separated subset whose final tier does not exceed 1,000,000.
An overridden tier list is reported as a development profile and is not the
full nightly acceptance result. `ODINN_STATE_GROWTH_BATCH_SIZE` changes the
positive transaction batch size, and `ODINN_STATE_GROWTH_REPORT` selects the
report path.
