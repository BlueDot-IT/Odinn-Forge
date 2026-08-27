# Exact-commit SLO acceptance

The Phase F SLO lane measures the six objectives defined in
[Operational telemetry and service-level objectives](observability-slos.md)
against one clean, exact Git commit. It is a controlled local-runtime
acceptance fixture, not a claim about external provider, website, or network
latency.

| Objective | Telemetry | Acceptance target |
| --- | --- | --- |
| Durable run acceptance | `odinn.run.acceptance` | p95 at most 250 ms and at least 99.9% accepted |
| Governed tool overhead | `odinn.tool.execution` | p95 at most 250 ms beyond the direct adapter |
| Signed audit append | `odinn.audit.append` | p99 at most 50 ms and zero failures |
| Bounded memory recall | `odinn.memory.recall` | p95 at most 500 ms |
| Startup recovery | `odinn.recovery` | p99 at most 30 seconds; every interrupted non-retry-safe fixture is quarantined without replay |
| Graceful shutdown | `odinn.shutdown` | p99 at most 5 seconds; every post-barrier admission is refused |

## Running the lane

From a clean checkout of the commit under test:

```sh
pnpm slo:measure
pnpm slo:validate
```

`slo:measure` exercises real repository operations: durable SQLite job
admission, the governed `text.echo` path compared with its direct adapter,
signed SQLite audit append, bounded FTS recall, recovery of a crossed-dispatch
non-retry-safe job, and Gateway listener shutdown. The acceptance profile uses
1,000 durable admissions, 100 governed tool samples, 250 audit appends, 100
recalls, 20 uncertain recoveries, and 20 shutdown cycles.

The command writes `dist/reports/slo-collector-report.json`. The report binds
the repository, full commit SHA, Git tree, clean-tree marker, Node/platform
identity, configured fixture sizes, and every content-free timing sample. For
each objective it reports sample count, p50, p95, p99, failures, and dropped samples.
The collector settlement also reports accepted, exported, queued,
dropped, and export-failure counts.

`slo:validate` recomputes every aggregate from the retained samples. It fails
closed on a dirty or mismatched commit, unknown or missing fields, an
incomplete objective set, insufficient samples, non-finite or oversized
durations, any dropped measurement, semantic failures, aggregate tampering, or
an SLO budget miss. No target is weakened when a run fails.

## Scheduled evidence

The `Exact-commit SLO measurement` Nightly job runs without credentials or
repository write authority. It binds the report to `${{ github.sha }}` and
retains the machine-readable report for 30 days even when validation fails.
Hosted evidence from the final merged commit is required for Phase F
acceptance; a local report is supporting evidence only.

Tests use a smaller development profile. A development report exercises the
same real operations and validator but cannot satisfy the acceptance-profile
minimum sample counts and is never a release artifact.
