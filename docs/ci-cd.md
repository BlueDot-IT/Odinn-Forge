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

The quality job also runs `pnpm check:architecture`. This repository-owned
TypeScript AST and manifest check enforces the [complete production workspace
package graph](architecture/package-dependency-graph.md). Package roots come
from `pnpm-workspace.yaml`; discovered packages, graph keys, and graph targets
must agree. The check validates source imports and every package dependency
field, requires the canonical package name with exact `workspace:*`, rejects
local-path and npm aliases, rejects package-to-app and adapter-to-adapter edges,
and requires source imports to be declared. Package subpaths are evaluated with
Node 24 conditional, wildcard, null-exclusion, and array-fallback `exports`
semantics, including the default `node-addons` and `module-sync` runtime
conditions. A selected export target is physically resolved to an existing
regular file that must remain owned by its declared package, so a parent cannot
proxy files from a nested workspace or through a symlink. Relative or
repository-root cross-package source imports are rejected so production code
cannot depend on private TypeScript files that are not package API. Explicitly
matched `dist` package roots are included; generated directories must be
excluded in the workspace globs, while pnpm's `node_modules` and
`bower_components` exclusions remain intact. Production package roots,
manifests, and descendants cannot traverse symbolic links or junctions;
broken links and repository escapes fail closed. Archive verification retains
an independent no-symbolic-link and no-hard-link boundary.

Dynamic `import()`, direct `require()`, and `module.require()` calls in every
production workspace package must use literal module specifiers. Indirect
`require`, computed loader properties, `createRequire` re-exports, package
`imports` aliases, and effective TypeScript `paths` aliases in production
package config variants and their inherited chains fail closed so dependency
identities and packaged build inputs remain statically enforceable. Tool-only
TypeScript configurations are outside this production-package rule.

Diagnostics name the source file or manifest, import/dependency specifier, and
violated rule. The dependency-direction check has no legacy exemptions.
Gateway and CLI retain their documented composition-root edges; the kernel
accepts only the shared channel-tool contract from `@odinn/channels` and cannot
import a channel adapter.

### Security

Runs on pull requests, pushes to `main`, a weekly schedule, and manual dispatch.

It includes:

- CodeQL for JavaScript and TypeScript
- GitHub dependency review on pull requests
- Frozen-lockfile installation and a fail-closed advisory audit. The audit uses `pnpm audit` when available and queries npm's bulk advisory endpoint directly when the legacy endpoint returns its retirement response.
- Full-history Gitleaks secret scanning
- OpenSSF Scorecard reporting on default-branch pushes, schedules, and manual default-branch runs (Scorecard does not support non-default refs)

### Nightly

Runs the complete repository check, integration and product-invariant tests,
protocol smoke, dependency audit, and compiled production packaging every day.
Nightly artifacts are retained for seven days.

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
Planning jobs also share a repository-wide OAuth concurrency group. This
prevents simultaneous refresh consumers from racing the rotating credential.
As with other GitHub concurrency groups, bursts coalesce to the newest pending
plan while the active plan completes. Plan or artifact-download failures remain
visible workflow failures; they are not converted into successful runs.

### Codex Security remediation

The event-facing Odinn Maintainer workflow also calls a separate, immutable
reusable remediation workflow every day at 05:41 UTC. This path scans only the
trusted `main` branch. The ordinary six-hour reconciliation sweep is routed to
the target-discovery jobs, while the daily security schedule is routed only to
the remediation job.

The caller grants `actions: write`, `contents: write`, and
`pull-requests: write` so the reusable workflow can publish a bounded repair
branch, open a draft pull request, and explicitly dispatch CI. The ChatGPT OAuth
record is passed as a workflow secret. Inside the pinned maintainer workflow,
scan and patch steps receive OAuth without a repository write credential; the
later publication step receives the caller-scoped GitHub token without OAuth.

Publication is fail-closed. The candidate must remain bound to the scanned
default-branch revision, satisfy affected-path and diff-size limits, and pass
the complete Forge check suite before publication. The workflow creates only a
draft pull request and never merges it. Maintainer review and protected-branch
requirements remain mandatory.

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
3. Runs all quality, integration, product-invariant, inference protocol, and
   dependency-audit gates.
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
pnpm test:invariants
pnpm smoke:inference
node scripts/ci/audit.ts high
```

The invariant lane proves product properties that previously lived inside
timing harnesses: exact restart classification for 10,000 mixed durable jobs,
bounded deterministic traversal of a 10,000-file workspace, and exact ordered
memory-index retrieval parity over 20,000 documents, plus mixed projection and
scope correctness over 10,000 authoritative records. Compiled inference smoke
separately exercises the staged production gateway. These are correctness and
resource-bound checks; they do not publish latency or throughput claims.

Comparative runtime, model, and performance evaluation belongs in
[BlueDot-IT/agent-benchmarks](https://github.com/BlueDot-IT/agent-benchmarks).

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
