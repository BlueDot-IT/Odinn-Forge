# Durable session lanes

Odinn's session-lane scheduler is an **unintegrated, default-inert
foundation**. Importing `@odinn/kernel` does not load it. Consumers must
explicitly import `@odinn/kernel/session-lanes`, provide a durable store, and
start an instance. The gateway, kernel task path, and channel adapters do not
currently instantiate it.

## Contract

- A lane key is 1–128 ASCII bytes: letters, digits, `.`, `_`, `:`, or `-`, and
  must begin with a letter or digit.
- Jobs in one lane run strictly in persisted creation order. Different lanes
  may be logically active concurrently, bounded by the configured global
  concurrency.
- The durable job payload stores the lane key, monotonic per-lane sequence,
  state version, and original input. Queued work survives restart. Persisted
  `running` work represents an already-counted attempt with an unknown outcome:
  restart quarantines it as `needs-review` and never automatically re-executes
  it, even when it was marked retry-safe.
- The scheduler validates every durable envelope before recovery and refuses a
  store containing unrelated or malformed records without changing it. Use a
  dedicated store with one active scheduler owner; distributed multi-process
  admission is outside this foundation.
- Admission, claim, and queued cancellation share one serialized state chain.
  Admission is bounded globally, per lane, per payload, and by aggregate
  pending payload bytes.
- Failure, timeout, or cancellation releases global execution capacity without
  affecting other lanes. The scheduler retains the affected lane's physical
  lock until its underlying execution promise actually settles, including when
  an executor ignores `AbortSignal`. Cooperative abort handling remains
  strongly recommended because shutdown does not wait indefinitely for a
  non-cooperative executor. Consequently, timed-out non-cooperative promises
  may remain physically alive in addition to the bounded logical concurrency;
  the concurrency option is not a physical process/thread cap.
- Shutdown and start are serialized. Shutdown aborts active work, waits for
  logical durable outcomes, starts no queued work, and leaves the scheduler
  restartable.
- Dispatch performs no synchronous filesystem, network, or telemetry work.
  Persistence calls are asynchronous and supplied by the consumer.

## Durable-store failures

A read or write failure enters fail-closed degraded mode. The scheduler exposes
the cause through `status().degradedError`, stops admission and dispatch, and
does not spin or retry execution. If execution succeeds but its completion
cannot be persisted, the durable record remains `running`; a fresh scheduler
will quarantine it as `needs-review` during validated recovery. Repair or
replace the store and construct a fresh scheduler rather than attempting to
resume a degraded instance.

## Activation acceptance

This module must remain absent from existing runtime import graphs and must not
change default behavior. Any future integration must:

1. remain disabled by default until explicitly configured;
2. avoid discovery, blocking I/O, and synchronous telemetry in request paths;
3. preserve all existing correctness, security, and resource-limit gates; and
4. evaluate enabled and disabled performance externally before activation.

Comparative performance evaluation belongs in
[BlueDot-IT/agent-benchmarks](https://github.com/BlueDot-IT/agent-benchmarks).

This foundation does not add a gateway listener, session router, channel
binding, background worker, cross-process admission protocol, automatic retry,
or degraded-instance repair mechanism.
