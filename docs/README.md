# Documentation hub

This page is the navigation index for the documentation in this repository. It
does not create a separate compatibility promise: the linked documents remain
authoritative for their own scope, and the [surface matrix](surface-matrix.md)
and [v1 compatibility policy](v1-compatibility.md) define support boundaries.

## Start here

- [Getting started](getting-started.md) — source setup, onboarding, local models,
  headless systems, and troubleshooting.
- [User guide](user-guide.md) — installation, privacy, updates, backups,
  recovery, and bug reports.
- [Operator console](operator-console.md) — projects, tasks, memory, and
  scheduled work in the local console.
- [AI provider support](provider-support.md) — tested providers and
  compatibility labels.
- [Messaging channels](channels.md) — current adapter scope and limitations.
- [Interface reference](interface-reference.md) — the documented CLI and
  authenticated loopback gateway interfaces.
- [Surface matrix](surface-matrix.md) — stable, experimental,
  provider-dependent, platform-dependent, internal, and unsupported surfaces.
- [v1 compatibility policy](v1-compatibility.md) — the v1 product promise and
  its boundaries.

## Benchmark evidence

- [Benchmark evidence and limitations](benchmarks.md) — enforced gates,
  observational microbenchmarks, synthetic profiling, independent evaluation,
  reproduction requirements, and publication caveats.
- [CI/CD](ci-cd.md) — workflows that run the repository checks and benchmarks.
- [Release validation](release-validation.md) — evidence expected from a
  release candidate.

## Runtime and architecture notes

- [Runtime event ledger](architecture/event-ledger.md) — the hash-chained event
  ledger design.
- [Audit storage operations](audit-storage.md) — indexed journal migration,
  streaming cursors, verification, archives, retention, soak, and benchmarks.
- [Runtime ledger](runtime-ledger.md) — structured runtime records.
- [Gateway Protocol v2](gateway-protocol-v2.md) — protocol schema and client
  behavior.
- [Provider capability metadata](provider-capability-metadata.md) — provider
  capability contracts.
- [SQLite/FTS5 memory candidate index](sqlite-memory-index.md) — indexed memory
  candidate retrieval.
- [Durable session lanes](durable-session-lanes.md) — persistent conversation
  lanes.
- [Progressive skill disclosure](progressive-skill-disclosure.md) — bounded
  skill discovery and loading.
- [Optional asynchronous telemetry foundation](async-telemetry.md) — local
  telemetry buffering design and boundaries.
- [Executable agent manifests and run graphs](agent-run-graphs.md) — bounded
  agent graph primitives.
- [Demand-loaded automation primitives](automation-primitives.md) — inert
  trigger and schedule primitives.
- [Cached MCP host foundation](cached-mcp-host.md) — bounded MCP host and
  governed Stage 9 activation with OCI isolation and
  lifecycle foundations.
- [Execution admission](architecture/execution-admission.md) — immutable execution
  envelopes, admission, attempts, cancellation, and recovery boundaries.
- [Capability registry and Gatewatch preview](capability-gatewatch.md) —
  operator-owned capability identities and fail-closed preview decisions.
- [Sandboxing](sandboxing.md) — platform-specific execution isolation and
  explicit host-execution limits.
- [Bounded workspace inspection](workspace-inspection.md) — read-only listing,
  metadata, literal search, bounded reads and diffs, sensitive-file policy,
  cursors, and platform limits.

## Advanced capability notes

These pages describe individual capabilities. Consult the surface matrix and
v1 compatibility policy before treating any interface as stable.

- [Features index](features/README.md) — status and technical identifiers for
  the advanced services and optional plugin modules
- [Gatewatch — policy safety](features/sentinel.md)
- [Runemark — run verification](features/proof.md)
- [Norn Restore — restore points](features/rewind.md)
- [Raven Route — model routing](features/darwin.md)
- [Rune Key — scoped temporary access](features/capability-tokens.md)
- [Saga Archive — portable run bundles](features/capsules.md)
- [Worldtree Paths — scenario comparison](features/counterfactual.md)
- [Self-improvement](features/self-improvement.md)

## Reference and repository policy

- [Policy schema reference](reference/policy-schema.md)
- [Task contract reference](reference/task-contract.md)
- [Repository policy setup](repository-policy.md)
- [Contributing guide](../CONTRIBUTING.md)

## Security boundaries

- [Security guide and vulnerability reporting](../SECURITY.md)
- [Threat model](security/threat-model.md)
- [Multi-user host](security/multi-user-host.md)
- [Continuous security fuzzing](security/continuous-fuzzing.md)
- [OpenSSF Scorecard triage](security/openssf-scorecard-triage.md)

## Planning and acceptance records

These documents record planning or acceptance work. Read each document's own
status and date before using it as current product evidence.

- [Stabilization plan](stabilization-plan.md)
- [v0.4.0 user acceptance record](uat/v0.4.0-uat.md)
- [UAT findings proof log](uat/logs/uat-findings.md)

## Repository resources

- [Latest release](https://github.com/BlueDot-IT/Odinn-Forge/releases/latest)
- [Issue tracker](https://github.com/BlueDot-IT/Odinn-Forge/issues)
- [MIT license](../LICENSE)
