# Channel state persistence and recovery

Ódinn stores channel delivery claims in `channel-dedupe.json` and conversation
bindings in `channel-bindings.json`. Both remain schema version 1 JSON files.
This change does not require a state migration and older v1 builds can read the
files after a code rollback.

## Mutation guarantees

- One token-owned `.lock` file covers each complete read-modify-replace
  transaction across processes and store instances.
- Supported readers participate in the same lock, so a Windows replacement's
  transient name handoff is never interpreted as an empty state.
- Failed operations reject only their caller; later operations retry from the
  last valid durable state.
- Writes use an owner-only temporary file, durable flush, and atomic
  replacement. Readers therefore observe either the previous valid state or
  the next valid state, never a partially serialized document.
- On Windows, lock files inherit the already protected state-directory ACL at
  creation; POSIX locks are created with mode `0600`.
- Existing state must be a regular, non-symbolic, owner-only file with the
  expected schema. Invalid JSON, unknown schemas, invalid entries, and insecure
  ownership or permissions fail closed instead of being overwritten.
- Dedupe claim, commit, release, capacity pruning, and expiry semantics are
  unchanged.

## Stale lock recovery

Locks are not reclaimed automatically. A process identifier can be reused, and
deleting a lock by age or PID alone can remove a newer owner's lock.

If an operation reports an invalid or orphaned channel-state lock:

1. Stop every Ódinn CLI, gateway, and worker that uses the same state directory.
2. Verify no process is still using the state files.
3. Preserve the lock as evidence by moving `<state-file>.lock` to a uniquely
   named recovery file. Do not overwrite another recovery file.
4. Back up the corresponding JSON state file before retrying.
5. Restart one process and verify that binding lookup or dedupe claim succeeds
   before restoring normal concurrency.

Temporary files named `.<state-file>.<pid>.<uuid>.tmp` are not authoritative.
They may be moved aside only after all processes are stopped and the canonical
JSON file has been backed up and validated.

## Corruption and permission failures

Do not hand-edit a live store. Stop all users of the state directory, preserve
the rejected file, and restore a known-good schema version 1 backup. On POSIX,
the directory and files must be owner-only. On Windows, inherited foreign ACL
grants are rejected; restore the native owner-only Ódinn ACL before retrying.

Because no schema migration occurs, rollback consists of stopping Ódinn,
restoring the pre-change executable, and retaining the validated schema version
1 files. If recovery cannot preserve the original evidence, stop and escalate
instead of creating an empty state.
