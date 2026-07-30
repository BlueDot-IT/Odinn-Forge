# Continuous security fuzzing

Odinn Forge runs a bounded security-fuzz campaign every day and whenever the
fuzz harness changes. This is dynamic-analysis evidence for security-sensitive
production boundaries; it is not a substitute for unit tests or a claim of
80% full-tree branch coverage.

## Scope

The campaign generates cases against:

- protocol required-field normalization;
- credential and secret redaction;
- policy-denial monotonicity; and
- managed skill-package path validation.

These targets are deterministic, network-free, and credential-free. Generated
values are synthetic. The workflow runs on hosted Linux and Windows runners
with read-only repository permissions.

## Resource bounds and evidence

The scheduled campaign permits at most 100,000 generated cases and five minutes
inside the harness. The workflow has a twelve-minute job timeout. Pull requests
use a smaller smoke campaign.

Every run writes `artifacts/fuzz/report.json` with the commit, timestamp,
platform, architecture, Node version, configured bounds, seeds, executed cases,
shrinks, and interruption state. GitHub Actions retains the Linux and Windows
artifacts for 30 days. A property failure also writes `replay.json` containing
the scenario, seed, shrink path, and replay command.

## Replay and regression promotion

Download the failed artifact and replay the exact minimized case:

```bash
ODINN_FUZZ_SCENARIO=credential-redaction \
ODINN_FUZZ_SEED=123456 \
ODINN_FUZZ_PATH='0:1:2' \
pnpm fuzz:replay
```

Before fixing a defect, promote the minimized counterexample into the nearest
deterministic `tests/*.test.ts` regression. The regression must fail on the
affected revision and pass with the fix. Keep the generated replay artifact as
supporting evidence, not as the only permanent test.

An interrupted campaign is reported explicitly and fails the job when
fast-check cannot complete the configured run count within its time budget.
