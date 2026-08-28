# Gateway instance ownership and failover

Ódinn permits one active Gateway process for a physical state root. Startup
acquires a durable owner/host/PID/epoch lease before migration, recovery, store
initialization, or background dispatch. A concurrent process receives
`GATEWAY_INSTANCE_OWNED` with HTTP-compatible status `503`; it does not open
the application stores or dispatch work.

The lease database lives in an owner-private sibling control directory rather
than inside the state tree. State backup, restore, and migration therefore do
not copy a live owner record or invalidate an open lease connection. The
record binds the canonical physical state path by digest. Host identity is
also digest-only; status, diagnostics, audit, and error projections never
disclose a hostname or control-directory path.

## Fencing and takeover

- The owner renews a bounded lease on a shorter heartbeat interval.
- Every renewal, release, and request-time ownership check binds the exact
  owner ID, physical-state digest, and monotonic epoch.
- A successor cannot start while the lease is active.
- An expired same-host lease is still refused while the recorded PID is live.
- An expired cross-host or dead-process lease may be claimed with epoch + 1.
- A resumed old owner cannot renew or release the successor's lease. New HTTP,
  cron, event-ingress, and automatic-improvement work fails closed, and lease
  loss begins ordinary bounded Gateway shutdown.

This is a single-active ownership and controlled-failover contract. It is not
an active-active scheduler, a distributed transactional store, or support for
sharing the state directory over a filesystem on which SQLite locking is not
reliable.

## Acceptance evidence

`tests/gateway-instance-ownership.test.ts` starts two real Gateways against one
state root, proves that the second is rejected before clean release, and then
proves successor startup after shutdown. Its coordinator-level adversarial
cases cover expired cross-host takeover, epoch fencing of the old owner,
same-host live-process refusal, owner-only control state, and forged-schema
rejection.
