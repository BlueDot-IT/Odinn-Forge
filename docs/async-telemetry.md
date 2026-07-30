# Optional asynchronous telemetry foundation

Ódinn includes a dependency-light, OpenTelemetry-compatible foundation at
`@odinn/kernel/async-telemetry`. It is **disabled by default**, has no network
exporter, and is not imported by the kernel root, provider runtime, CLI, or
Gateway. Existing product behavior therefore remains unchanged: Ódinn Forge has
no active built-in product telemetry.

This module is an inert integration boundary for operators or future optional
adapters. Creating an enabled instance requires an explicit exporter. Ódinn
does not ship an exporter, endpoint, credential, background service, or hidden
activation path. Supplying an exporter is an explicit data-egress decision.
Delivery is best-effort and non-durable; this buffer never replaces or weakens
Ódinn's signed local audit journal.

## Privacy boundary

The schema minimizes external data rather than claiming it can recognize every
possible secret. It has no fields for prompts, model responses, tool input,
memory content, credentials, tokens, cookies, arbitrary payloads, or user
content. Record names and attribute keys use fixed allowlists. String values
must be compact operational labels of at most 128 UTF-8 bytes; prose, JSON,
multiline content, paths, URLs, emails, encoded path characters, and recognized
credential formats are rejected. Provider, model, and tool identifiers use
separate narrow grammars; only model identifiers may contain one slash.
Numeric and boolean attributes are accepted only for keys with matching
schemas and remain bounded. Trace identifiers use nonzero lowercase W3C
shapes, and every envelope is immutable.
Timestamps are integer Unix milliseconds and caller-supplied values more than
60 seconds in the future are rejected.

Exporter failures retain only a categorical `timeout` or `exporter-error`
status. Exporter exception messages are never copied into telemetry status.
No finite recognizer can detect an unknown opaque credential that happens to
fit an identifier grammar. This is a bounded data-minimization boundary, not
permission to place secrets into an allowlisted attribute. Integrators remain
responsible for supplying only non-sensitive, low-cardinality operational
labels.

## Lifecycle and failure behavior

`recordEvent`, `recordSpan`, and `recordMetric` only validate, freeze, and
enqueue an envelope synchronously in memory. They never await an exporter.
With automatic pumping enabled, exporter work starts after the current stack
yields. A single pump serializes exporter calls.

The queue, aggregate queued bytes, batches, batch bytes, and individual records
are bounded. When the queue plus in-flight batch reaches either capacity, the
newest record is dropped and `droppedOverflow` increases deterministically.
Export failures and timeouts definitively drop the uncertain batch rather than
retrying it and risking duplicates. Bounded exponential backoff delays the next
batch. Failures cannot reject the recording call or create an unhandled
rejection.

Every export attempt receives an abort signal and timeout. If an exporter
ignores cancellation and remains physically active, the instance enters a
wedged state and starts no overlapping exporter call. Shutdown still returns
within its deadline; the physical promise is only released if the exporter
eventually settles. The already-computed exponential delay is preserved while
wedged and begins only after physical settlement; repeated failures grow to
the configured cap.

`flush()` captures the highest accepted sequence at call time and is bounded by
`flushTimeoutMs`. It returns `true` only when every record through that
watermark exported without failure. Once an accepted sequence fails or times
out, every flush watermark containing that sequence remains `false`, including
repeated, concurrent, and post-shutdown calls. Later records do not extend an
earlier watermark.
Each export attempt is separately bounded by `exportTimeoutMs`, which cannot
exceed the lifecycle budget. `shutdown()` stops admission, drains only within
that same lifecycle deadline, invokes optional exporter shutdown with the
remaining budget, and returns any remaining count. Shutdown is idempotent;
concurrent callers receive the same promise. Exporter shutdown failure is
isolated and reported only as `exporterShutdown: false`.

The optional `autoPump: false` and `now` clock are deterministic test and
integration hooks. Disabling automatic pumping requires an explicit `flush()`
or `shutdown()`.

## OpenTelemetry compatibility

Version 1 envelopes separate events, completed spans, and metric points and use
W3C trace/span identifiers, millisecond timestamps, scalar attributes,
instrument kind, unit, duration, and status fields. A future adapter can
translate these bounded records to OpenTelemetry SDK data without placing that
SDK or its initialization cost in Ódinn's active path.

The interface does not claim wire-level OTLP compatibility and does not include
a network implementation. Adding an OTLP exporter, runtime activation, remote
endpoint, credentials, or configuration would require a separate security,
privacy, lifecycle, and latency review.

No persistent state is added, so there is no migration. Removing the optional
subpath and its explicit callers fully rolls back this foundation.
