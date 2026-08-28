# Phase F long-duration soak

The Phase F long soak is a repeated, exact-commit acceptance lane. It is not an
alias for the one-shot release soak. Every cycle runs the compiled release soak
and the concurrent SQLite audit soak from fresh temporary state.

Each cycle exercises:

- transient provider failure, timeout, retry, and post-timeout recovery;
- an in-flight queued job interrupted with `SIGKILL` to model process power
  loss, followed by durable-lease expiry and either fail-closed quarantine or
  at most one bounded retry-safe replay;
- persisted output after a separate clean restart;
- unresolved browser-effect recovery and approval blocking;
- audit-chain verification, key and segment rotation, signed archive creation,
  archive-before-retention, and restart integrity; and
- standalone install, upgrade, rollback, post-rollback onboarding, and a
  deterministic post-rollback tool call.

## Scheduled acceptance

The `Nightly` workflow runs the compiled candidate for two hours with at least
12 complete cycles and 5,000 concurrent audit events per cycle. Cycles start no
more frequently than every five minutes. The workflow retains the report for
30 days even when the soak fails.

The scheduled profile enforces these budgets:

| Budget | Required value |
| --- | --- |
| Failed cycles | 0 |
| Duration | at least 2 hours |
| Complete cycles | at least 12 |
| Restarts per cycle | at least 2 |
| Power-loss interruptions per cycle | at least 1 |
| Recovered/quarantined jobs per cycle | at least 1 |
| Unresolved approvals after recovery | 0 |
| Audit, archive, retention, restart, and rollback checks | all pass |
| Cycle duration | at most 20 minutes |
| Linux process-tree peak RSS | at most 4 GiB |

The RSS budget is measured over the runner process and all descendants on the
Linux scheduled runner. On platforms without a compatible process inventory,
the report marks resource measurement unavailable instead of inventing a
value; the authoritative scheduled acceptance runs on Linux.

## Local development profile

Build the compiled package once, then run two deterministic cycles:

```bash
pnpm build
pnpm release:package
pnpm soak:long --profile development --allow-dirty
```

`--allow-dirty` exists only to exercise harness changes before committing. Its
report is explicitly non-qualifying. Release evidence must come from a clean
checkout and therefore omits that flag.

The duration, cycle count, cadence, audit-event count, command timeout, cycle
duration budget, RSS budget, and report path are configurable CLI options. The
`nightly` profile refuses durations below one hour or fewer than eight cycles,
so a scheduled long soak cannot silently collapse into a renamed one-shot.

## Evidence and failure handling

The runner writes
`dist/reports/phase-f-long-soak/long-soak-report.json` atomically before work
starts and after every cycle. The machine-readable report includes:

- the exact 40-character source commit and whether the worktree was clean;
- the complete profile and budget declaration;
- cycle-level durations, categorical failures, resource peaks, release-soak
  results, and audit-soak results; and
- aggregate cycle, restart, power-loss, recovered-job, and resource totals.

The report never stores provider credentials or raw child-process output.
Command failures are reduced to categorical state. A failed or timed-out cycle
stops the run, preserves the latest report, and fails the workflow. Operators
must retain the exact report artifact and workflow URL with the Phase F
completion evidence.
