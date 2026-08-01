# Authoritative record ledger

Issue #58 moves typed product records to the `record_events` table in the runtime SQLite database. The table is append-only and keeps the complete JSON payload alongside indexed projections for type, session, project, scope, namespace, status, subject, target, and message external IDs.

## Query contract

Operational readers use bounded pages (`limit <= 500`) ordered by the immutable `sequence` key. A cursor contains the last sequence and direction, so the next page uses a strict `sequence >` or `sequence <` predicate; no active query uses `OFFSET`. Session, project, goal, lifecycle, and memory reducers consume page iterators with a 100,000-record safety ceiling. FTS5 remains a separate candidate index and is not activated by this migration.

Message external IDs are unique per session and are checked inside the same SQLite write transaction as append. Concurrent retries therefore return the first logical message rather than creating duplicates.

## Migration and rollback

`records.jsonl` remains unchanged as migration input and rollback evidence. Migration first creates a deterministic `.migration.bak` copy, validates/parses the backup, and imports the rows in one SQLite transaction. An interrupted transaction can be retried; a changed source after the backup exists fails closed. State-level schema migration is backup-first and advances runtime SQLite from v3 to v4.

The migration intentionally excludes audit append, audit SSE, retention, key rotation, and journal lifecycle work; those belong to issue #57. FTS activation also remains separate until production-corpus parity and failure behavior are proven.
