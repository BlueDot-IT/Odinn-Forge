# Odinn Forge CI/CD

Odinn Forge uses separate workflows for correctness, package integrity, workflow linting, pull-request policy, merge-queue validation, security, scheduled verification, and release publication. A green release requires every applicable required workflow to succeed independently.

## Workflows

### CI

Runs on every pull request, every push to `main`, and manual dispatch.

Required jobs:

- `Quality and unit tests`
- `Platform test (ubuntu-latest)`
- `Platform test (macos-latest)`
- `Platform test (windows-latest)`
- `Integration and inference protocol`
- Three platform-specific package smoke jobs

The inference job launches the packaged Gateway, configures a local OpenAI-compatible protocol provider, and verifies a persisted model response through the public API. It is real packaged gateway behavior proof, but it is not proof of production-model quality or a live cloud-provider account.

### Security

Runs on pull requests, pushes to `main`, a weekly schedule, and manual dispatch.

It includes:

- CodeQL for JavaScript and TypeScript
- GitHub dependency review on pull requests
- Frozen-lockfile installation and a fail-closed advisory audit. The audit uses `pnpm audit` when available and queries npm's bulk advisory endpoint directly when the legacy endpoint returns its retirement response.
- Full-history Gitleaks secret scanning
- OpenSSF Scorecard reporting on default-branch pushes, schedules, and manual default-branch runs (Scorecard does not support non-default refs)

### Nightly

Runs the complete repository check, integration test, protocol smoke,
performance threshold, dependency audit, and compiled production packaging
every day. Nightly artifacts are retained for seven days.

### Package Integrity

Runs on every pull request and push to `main`. Linux, macOS, and Windows each
build the compiled production archives, verify checksums and archive contents,
install without a workspace dependency install, complete onboarding, execute a
packaged CLI tool, start the gateway, verify diagnostics, stop cleanly, and
reopen state.

### Workflow and pull-request policy

Workflow Lint runs actionlint on every pull request and on workflow changes pushed to `main`. Pull Request Policy validates Conventional Commit syntax for pull-request titles. Merge Queue performs the full release-candidate suite for `merge_group` events.

### Maintainer reconciliation

The event-facing Odinn Maintainer workflow discovers a bounded target matrix and
delegates each issue or pull request to a local reusable workflow. The reusable
workflow holds one concurrency group for the complete plan-to-apply lifecycle:
`repository-kind-number`. Scheduled sweeps, direct comments, pull-request
events, and completed-workflow events therefore queue behind the same target
lock instead of racing one another. Different targets can still reconcile in
parallel.

Planning and application remain separate jobs with separate permissions. The
target lock uses `cancel-in-progress: false`, so a newer event does not cancel a
plan or deterministic apply already in progress. GitHub retains at most one
pending run for a concurrency group, so bursts coalesce to the newest pending
event; that run re-fetches the complete live target state before planning.

### Version preparation

Versions are prepared through ordinary reviewed pull requests. A release change
updates `package.json` and `CHANGELOG.md` together, receives the same CI,
Security, Package Integrity, Workflow Lint, and Pull Request Policy checks as
any other change, and merges without creating a tag or release as a side effect.

After the version pull request and required `main` checks pass, an operator
creates an annotated (preferably signed) `v<package-version>` tag at the exact
merge commit and pushes that tag. Tags are immutable release identities; a
failed release is corrected with a new version rather than by moving a tag.

### Release

A `v*` tag starts the release workflow. Manual dispatch can republish an
existing tag for recovery, but cannot release an untagged branch. The workflow:

1. Checks out the exact tag.
2. Verifies that the tag matches `package.json`.
3. Runs all quality, integration, inference protocol, benchmark, and dependency-audit gates.
4. Compiles the CLI, gateway, workers, installer, and runtime packages to
   JavaScript with source maps.
5. Assembles equivalent ZIP and tar.gz production archives with runtime
   dependencies only.
6. Runs the packaged restart/recovery soak against the compiled archive.
7. Generates production-package SPDX JSON SBOMs.
8. Generates SHA-256 checksums and verifies archive identity and contents.
9. Runs clean install smoke against the exact archives.
10. Creates GitHub build provenance attestations.
11. Publishes the verified assets to the GitHub release through the protected
    `release` environment.

The workflow cannot publish from an untagged branch or a tag that disagrees with the package version.

## Required repository settings

Configure the following manually in GitHub because they are repository policy, not workflow code:

- Protect `main`.
- Require pull requests before merging.
- Require at least one approval when more than one maintainer is active.
- Dismiss stale approvals after new commits.
- Require conversation resolution.
- Require signed commits if all active maintainers can use them reliably.
- Require the CI and Security status checks listed above.
- Require branches to be current before merge.
- Block force pushes and deletion of `main`.
- Enable private vulnerability reporting.
- Create a `release` environment and require approval for every prerelease and stable release publication.
- Limit workflow permissions to read-only by default.

## Local equivalence

Before opening a pull request:

```bash
corepack enable
corepack prepare pnpm@10.14.0 --activate
pnpm install --frozen-lockfile
pnpm release:preflight
pnpm check
pnpm test:integration
pnpm smoke:inference
pnpm benchmark:ci
node scripts/ci/audit.ts high
```

`benchmark:ci` measures twenty cold packaged-gateway protocol runs and fails
when p95 exceeds the 2-second budget. The local Forgejo integration runner
executes inside nested Docker and uses a documented 4-second cold-start
allowance; all other workflows retain the 2-second default. Set
`ODINN_BENCHMARK_P95_MAX_MS` only when diagnosing a slower host; do not use it
to hide a release regression. It then runs the observational assurance
microbenchmarks described below.

`benchmark:assurance` measures the synchronous paths added by the core advanced
services: ordinary tool dispatch with zero, one, three, and ten Gatewatch
invariants, pinned Raven Route selection, and evidence-based selection over
100, 1,000, and 10,000 observations. The report includes p50, p95, and maximum
latency plus the p95 difference between zero-invariant and three-invariant
dispatch.

```bash
pnpm benchmark:assurance
```

Use `ODINN_ASSURANCE_BENCHMARK_SAMPLES` and
`ODINN_ASSURANCE_BENCHMARK_WARMUPS` to adjust the bounded sample counts during
diagnosis. These measurements are initially observational: the existing
packaged-gateway threshold remains the only enforced latency budget until
stable baselines from CI and representative operator hardware establish
portable regression limits.

To inspect release output without publishing:

```bash
pnpm release:package
pnpm release:soak
pnpm release:checksums
node scripts/release/verify.ts
pnpm release:install-smoke
```

Artifacts are written to `dist/release/`.

The audit command fails if neither advisory service can produce a valid result. A successful gate must never mean "the scanner was unavailable."

## Release conventions

Pull request titles and squash commit messages use Conventional Commits:

- `feat(scope): description`
- `fix(scope): description`
- `docs(scope): description`
- `ci(scope): description`
- `chore(scope): description`

Breaking changes use `!` before the colon or a `BREAKING CHANGE:` footer.

## Future package targets

When native binaries and containers are added, extend the release workflow with platform-specific build jobs. Each job must upload its own checksummed artifact, and the publish job must not run until Windows, macOS, and Linux package smoke tests pass.
