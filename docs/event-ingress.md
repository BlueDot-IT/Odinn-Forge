# Event ingress and heartbeat

Stage 11 adds an explicit, deterministic event-ingress boundary. Sources are
registered with an operator-owned authentication digest. Events must carry a
validated source cursor and arrive in authoritative sequence order. Duplicate
delivery is idempotent; gaps, stale cursors, unauthenticated sources, and
unbounded attributes fail closed.

Event watches contain declarations only. A matching event produces an
unauthorized automation candidate with a deterministic idempotency key. The
candidate is converted into a durable job through an injected dispatcher; the
event source cannot provide execution authority or arbitrary task input.
The request hash binds the complete validated candidate and authenticated
tenant-scoped live payload before persistence. SQLite stores only the shared
content-safe durable-job projection. Initial submission and restart adoption
require the exact request hash, job and task identity, retry classification,
tenant/principal scope, and projected payload, so redaction cannot create a
false binding conflict or authorize a different request.
Delivery does not become `completed` when that job is merely queued, running,
or awaiting approval. The Gateway polls the persisted job across supervisor
recovery and maps only its durable terminal state back to the delivery. A
failed or cancelled job records a failed delivery, while a missing,
unrecognized, or `needs-review` job fails closed as `needs-review`.

Schedule declarations can also be advanced by the explicit heartbeat
operation. No timer or network listener is created unless
`config.runtime.enableEventIngress` is enabled. The Gateway exposes source,
watch, ingest, and heartbeat endpoints under that gate. Uncertain dispatch is
recorded as `needs-review`.

Each delivery is claimed with a token-fenced 30-second dispatch lease. A
dispatcher that is still making legitimate progress must call its
`renewLease()` callback before the deadline. The runtime schedules recovery at
the next durable expiry, aborts an expired dispatcher, and records the effect
as `needs-review`; a late result carrying the old claim token cannot overwrite
that terminal review state. The Gateway renews this lease while its submitted
job remains nonterminal, including during an approval wait. Gateway shutdown
likewise aborts active deliveries and records them for review before the
shared runtime database is closed.
