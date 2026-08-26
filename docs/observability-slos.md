# Operational telemetry and service-level objectives

Ódinn's optional Gateway telemetry defines measurable local-runtime objectives
without turning prompts, tool arguments, audit payloads, or identities into
external data. These objectives are acceptance targets for controlled test and
soak environments; they are not provider latency guarantees.

| Objective | Telemetry | Target | Failure evidence |
| --- | --- | --- | --- |
| Durable run acceptance | `odinn.run.acceptance` | p95 ≤ 250 ms and ≥ 99.9% accepted when admission capacity is available | HTTP status category and bounded duration |
| Governed tool latency | `odinn.tool.execution` | p95 runtime overhead ≤ 250 ms beyond the underlying adapter | tool identifier, outcome, bounded duration |
| Signed audit append | `odinn.audit.append` | p99 ≤ 50 ms and zero silent append failures | outcome and bounded duration; operation still fails closed |
| Memory recall | `odinn.memory.recall` | p95 ≤ 500 ms for bounded local recall fixtures | tool identifier, outcome, bounded duration |
| Startup recovery | `odinn.recovery` | p99 ≤ 30 s; uncertain effects end quarantined rather than replayed | component, completed/quarantined outcome, bounded duration |
| Graceful shutdown | `odinn.shutdown` | p99 ≤ 5 s with no new admitted work after the stop barrier | complete/partial outcome and bounded duration |

## Measurement rules

- Measure exact commits and retain collector output as a CI or UAT artifact.
- Report sample count, p50, p95, p99, failures, dropped telemetry, and the
  configured state-fixture size.
- Separate Ódinn overhead from external model, website, and provider latency.
- A telemetry export failure never changes a governed operation's result. The
  local status projection reports queue and drop counts so a missing sample is
  visible rather than silently treated as success.
- Failed or timed-out telemetry batches are dropped, not replayed, because
  remote receipt is uncertain.
- SLO misses keep Phase F acceptance open; they do not weaken policy, audit,
  approval, or recovery boundaries.

## Privacy and activation

Telemetry is disabled unless `ODINN_OTLP_ENDPOINT` is explicitly present in
the Gateway environment. Only HTTPS and loopback HTTP endpoints are accepted.
No exporter credential is read, and no endpoint value is returned in status or
diagnostics. See [Optional asynchronous telemetry](async-telemetry.md) for the
complete schema, queue, shutdown, and failure contracts.
