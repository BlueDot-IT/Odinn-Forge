# Demand-loaded automation primitives

Odinn exposes a small, pure contract at `@odinn/kernel/automation-primitives`.
It is a foundation for future scheduling and event integrations. It does not
replace or alter the gateway cron implementation.

## Boundary

Declarations are data, not authority. Evaluating one can only produce an
immutable candidate with `authorized: false` and
`requiresAuditedDispatch: true`. A caller must still submit that candidate
through Odinn's existing job/runtime, policy, approval, and audit path. This
module has no timers, workers, persistence, network access, filesystem access,
environment discovery, credentials, or import from a current runtime path.

Version 1 supports:

- one-shot UTC Unix-millisecond schedules;
- anchored intervals from 1 second through 365 days;
- flat event attributes matched by exact equality, string prefix, or bounded
  set membership;
- positive declaration revisions and whole-normalized-declaration SHA-256
  digests; predicates and set members are canonicalized before hashing;
- source-bound authoritative replay windows, exact canonical cursors, optional
  exclusive prior-cursor checks, and deterministic idempotency keys;
- immutable schedule or event candidates without arbitrary task payloads.

Regular expressions, globs, nested paths, arbitrary predicates, timezone
calculation, and embedded execution inputs are intentionally absent.
Unix milliseconds are bounded to the ECMAScript date range. All declarations,
events, replay windows, candidates, and control messages are bounded plain JSON:
prototypes, accessors, symbols, non-enumerable fields, excess nodes, and excess
canonical bytes fail closed.

## Odinn Agent Control Envelope

The same subpath validates a bounded `Odinn Agent Control Envelope v1` for
dispatch, cancel, status, and result handoff. This is an Odinn-local contract
inspired by agent control planes. It does **not** claim conformance with the
Agent Client Protocol or any other external protocol called ACP.

Dispatch carries only a validated automation candidate. Cancel reasons,
in-progress states, and terminal outcomes are enums. Results may carry a
bounded reference, never arbitrary result content. Unknown versions, fields,
kinds, states, and outcomes fail closed.

`validateOdinnAgentControlTransition(history, next)` validates the complete
retained dispatch chain before accepting its next transition. History is a
strict dense plain-JSON array bounded to 16 messages. The validator requires
one initial dispatch, globally unique retained message IDs, matching dispatch,
correlation, and agent IDs, monotonic timestamps and state progression,
ordered cancellation, and terminal finality. Callers must durably retain the
accepted bounded chain; longer-lived protocols need a separately reviewed
immutable compaction/checkpoint contract.

## Activation requirements

Any future runtime integration requires a separate review covering:

1. durable cursor and idempotency retention;
2. authenticated event ingress and authoritative replay windows;
3. conversion into the existing audited job envelope;
4. policy and approval enforcement;
5. lifecycle, recovery, backpressure, and latency measurements.
