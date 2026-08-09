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

Schedule declarations can also be advanced by the explicit heartbeat
operation. No timer or network listener is created unless
`config.runtime.enableEventIngress` is enabled. The Gateway exposes source,
watch, ingest, and heartbeat endpoints under that gate. Uncertain dispatch is
recorded as `needs-review`.
