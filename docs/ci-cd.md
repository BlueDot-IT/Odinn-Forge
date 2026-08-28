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
conditions. Type-only references activate TypeScript's `types` condition;
static import/export mode follows `.mts`/`.mjs`, `.cts`/`.cjs`, the package
module type, and explicit type-resolution attributes. Every export target in
every condition is physically audited even when unreferenced. It must remain
an existing regular file owned by its declared package, so a parent cannot
proxy files from a nested workspace or through a symlink. Only statically
auditable JavaScript/TypeScript, extensionless entrypoints, and inert JSON may
be exported; opaque `.node`, `.txt`, and other loader-defined surfaces fail
closed. Exported source remains in the inventory even beneath ignored
build-output directories. Relative, absolute, repository-tool, outside-file,
ignored-output, and percent-encoded traversal references cannot bypass the
production package boundary. Explicitly
matched `dist` package roots are included; generated directories must be
excluded in the workspace globs, while pnpm's `node_modules` and
`bower_components` source exclusions remain intact. Package-local dependency
links are still physically audited and must point to a canonical declared
workspace package or a declared package in the pnpm store. Production package
roots, manifests, and descendants cannot traverse symbolic links or junctions;
broken links and repository escapes fail closed. Archive verification retains
an independent no-symbolic-link and no-hard-link boundary.

Dynamic `import()`, direct `require()`, and `module.require()` calls in every
production workspace package must use literal module specifiers. Non-`node:`
URL modules, indirect or computed loaders, private or derived `Module`
entrypoints, `Reflect.get` loader authority, loader hook registration,
`createRequire`, dynamic `getBuiltinModule` access, direct or aliased `eval`,
`Function`, and callable constructor-based code generation fail closed.
Runtime `node:module`/`module` acquisition is limited to type-only use and the
static `builtinModules` metadata export; runtime `node:vm`/`vm` acquisition is
forbidden. Production package scripts are also closed-form: only a
package-owned audited `node ./entrypoint` without runtime options or
`tsc -p tsconfig*.json` is accepted. Loader/preload/eval flags, `NODE_OPTIONS`,
shell wrappers, and path escapes fail closed. Accepted Node entrypoints are
added to the source inventory even when they live in build output.
Package `bin` entrypoints follow the same inventory boundary through a stricter
manifest grammar: string and object forms must name unique portable commands
and exact package-owned JS/TS files with the canonical `#!/usr/bin/env node`
shebang. Explicit `dist` bins are scanned; symbolic links, junctions, package
escapes, ambiguous or opaque paths, command collisions, and non-Node shebangs
fail closed. Release archive verification separately rejects hard links.
`directories.bin` is rejected rather than turning a directory into an
unenumerated executable surface.
TypeScript triple-slash path, type, and AMD dependency references are checked
through the same boundary as imports. Package `imports`
aliases and effective TypeScript `paths` aliases in production package config
variants and their inherited chains also fail closed so dependency identities
and packaged build inputs remain statically enforceable. Tool-only TypeScript
configurations are outside this production-package rule.

This gate enforces its documented syntax, manifest, export, and installed-link
grammar. It is not a whole-program proof for arbitrary worker or child-process
execution; those behaviors remain subject to their dedicated runtime and
sandbox controls.

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
The release candidate is retained for seven days. A separate credential-free
job measures and fail-closed validates all six local-runtime SLOs against the
exact clean commit, then retains its machine-readable collector report for 30
days. See [Exact-commit SLO acceptance](slo-acceptance.md).
The release-candidate artifact is retained for seven days. A separate nightly
state-growth job exercises the production SQLite store at 10,000, 100,000, and
1,000,000 records, verifies archive-before-retention behavior, and retains its
machine-readable acceptance report for 30 days.

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

The Release workflow is intentionally `workflow_dispatch` only. A `v*` tag and
draft release are prerequisites, but pushing a tag does not start publication;
an operator manually dispatches the workflow for the exact tag and release.
Manual dispatch cannot release an untagged branch. The workflow:

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
9. Runs clean install, onboarding, diagnostic, and state reopen smoke against
   exact downloaded draft-release archives across GitHub-hosted Linux, macOS,
   and Windows runners.
10. Creates GitHub build provenance attestations.
11. Publishes the verified assets to the GitHub release through the protected
    `release` environment after all cross-platform validation passes.

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

The weekly `Weekly comparative benchmarks` workflow checks out a pinned
[BlueDot-IT/agent-benchmarks](https://github.com/BlueDot-IT/agent-benchmarks)
revision and runs the complete Odinn Forge, OpenClaw, and Hermes matrix on a
GitHub-hosted Ubuntu runner. The harness continues to own cases, deterministic
grading, and raw reports. Odinn Forge owns the generated
[current benchmark page](benchmarks.md) and README snapshot.

The local `odinn-maintainer-oauth-sync` command job keeps the existing masked
`ODINN_OPENAI_OAUTH_JSON` Actions secret synchronized. The benchmark workflow
only reads that secret into ephemeral isolated runtime state; it does not
refresh, replace, or publish credentials and does not select another provider
or model. Plaintext runtime state is removed before artifacts or repository
writes. Publication occurs in a separate write-capable job only after the three
reports pass strict metadata, provenance, and completeness validation.
That job commits the generated files to the stable
`automation/weekly-benchmark-docs` branch and updates it only with an exact
remote-SHA lease. It reuses an existing protected pull request or attempts to
create one; when repository policy denies workflow-created pull requests, the
branch remains available for a maintainer to open against `main`. The workflow
never pushes benchmark documentation directly to `main` or bypasses required
reviews and checks.
Failed matrices retain bounded adapter logs and per-trial progress journals for
14 days. These diagnostics contain only disposable public benchmark fixtures
and model results; runtime state and plaintext credentials are removed first.

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

When native binaries and containers are added, extend the release workflow with
platform-specific build jobs. Each job must upload its own checksummed artifact
and report its package smoke result; make it a publication dependency only when
the release scope explicitly requires a platform-specific artifact.
