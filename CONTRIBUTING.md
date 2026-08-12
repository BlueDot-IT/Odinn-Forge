# Contributing to Odinn Forge

Odinn Forge v1 is stable for the local, single-user workflow defined in the
compatibility policy. Changes should preserve cross-platform behavior, explicit
security boundaries, durable state transitions, and a small understandable
core.

## Feature development

Odinn v1 is stable, not feature-frozen. New capabilities—including channel
adapters, providers, plugins, remote workflows, and interface improvements—are
welcome when they are coherent, supportable, and meet the same security and
compatibility standards as the existing product. Evaluate proposals on their
implementation and operational risk rather than rejecting entire feature
categories.

Substantial features must:

- preserve stable interfaces or document a deliberate, versioned transition;
- define permissions, secrets, network access, audit evidence, failure
  behavior, and other affected trust boundaries;
- keep optional integrations modular, explicitly configured, and safe by
  default;
- include migrations and rollback behavior for persistent-state changes;
- include focused automated coverage and operator-facing documentation; and
- avoid coupling the feature to unrelated architectural rewrites.

Experimental work may enter through an explicit advanced or plugin boundary
while its interface is still evolving. It must remain opt-in, clearly labeled,
and subject to the normal review and security requirements.

## Development setup

Requirements:

- Node.js 24 or newer
- Corepack
- Git

```bash
corepack enable
corepack prepare pnpm@10.14.0 --activate
pnpm install --frozen-lockfile
pnpm check
```

The repository defaults to one concurrent workspace/build worker, one dependency
lifecycle worker, and a 1536 MB Node.js old-space limit. This keeps local checks
from exhausting a development machine. Maintainers can deliberately tune the
workspace and heap limits with `ODINN_WORKSPACE_CONCURRENCY` and
`ODINN_NODE_MAX_OLD_SPACE_MB`; CI should only raise them when the runner capacity
is known.

## Pull requests

Contribute through pull requests. Do not push changes directly to `main` or
another protected branch. Use a focused branch and a Conventional Commit pull
request title, for example:

```text
feat(gateway): add replayable event cursor
fix(store): recover expired queue leases
ci(release): attest packaged artifacts
```

A pull request must use the repository template and explain the problem,
implementation, compatibility impact, persistent-state or migration impact,
security impact, exact validation, and rollback path. Each pull request must
address one coherent area.

Every pull request must also declare its documentation impact. Select exactly
one outcome in the pull request template and provide concrete details:

- `Documentation updated` requires at least one changed Markdown/MDX file or a
  file under `docs/`, and the details must identify at least one exact changed
  documentation path.
- `Documentation not required` requires a specific rationale; generic
  assertions such as `No documentation required` are rejected, and reviewers
  enforce whether the supplied rationale is adequate. This is
  appropriate for changes such as internal refactors, focused tests, or fixes
  that do not change user, operator, contributor, API, configuration, security,
  installation, upgrade, or troubleshooting behavior.

User-visible and operator-visible behavior changes require documentation.
Selecting `Documentation not required` does not waive reviewer enforcement of
that requirement.

Maintainers may enable auto-merge for routine pull requests after the required
independent approval is recorded. The authoring agent must not queue
auto-merge for changes to security boundaries, credentials, repository
permissions, deployment infrastructure, or releases; those require explicit
maintainer confirmation. Auto-merge must never bypass required checks or
reviews.

You are responsible for every branch you create. After its pull request is
merged or closed, promptly delete the branch from the remote and remove any
corresponding local branch or worktree. Do not leave abandoned contribution
branches behind.

Do not mix feature work with migration work or broad refactoring with lifecycle
behavior changes. A pull request that affects a stable interface or persistent
state must say so explicitly. Persistent-state changes also require the
previous and new schemas, migration path, backup and failure behavior, rollback
compatibility, and fixture coverage.

Changes that add or alter production behavior must add or update automated
tests that exercise the changed behavior. Bug fixes should include a regression
test when practical. Documentation-only and non-behavioral metadata changes do
not require new tests. If automated coverage is not practical, explain why in
the pull request and provide exact manual validation.

## Required local checks

```bash
pnpm release:preflight
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:invariants
pnpm smoke:inference
node scripts/ci/audit.ts high
pnpm build
pnpm release:package
pnpm release:checksums
node scripts/release/verify.ts
pnpm release:install-smoke
pnpm storage:drill
```

The inference command launches the packaged gateway against a local OpenAI-compatible protocol provider and verifies persistence through the public API. Do not describe it as production-model or live cloud-provider validation.

When changing `.github/workflows/`, also run the pinned actionlint container described by `.github/workflows/workflow-lint.yml`. The dependency audit must return a real advisory result; scanner unavailability is a failure, not a waiver.

## Design constraints

- Keep platform-specific behavior behind platform interfaces.
- Do not acknowledge durable work before persistence succeeds.
- Do not grant a capability merely because a tool is visible to a model.
- Do not put provider secrets, channel tokens, or generated credentials in source control.
- Generated or imported skills must remain reviewable and reversible.
- Avoid hidden fallback behavior that changes security or billing semantics.
- Add failure-path tests for state transitions and recovery logic.

## Releases

Prepare every release as a normal reviewed pull request that updates
`package.json` and `CHANGELOG.md` together. The changelog heading and comparison
link must match the package version. Do not create the tag until that pull
request is merged and all required checks on `main` are green.

From an up-to-date, clean `main`, create an annotated tag that exactly matches
the package version and push only that tag:

```bash
git switch main
git pull --ff-only origin main
pnpm release:preflight
version="$(node -p "require('./package.json').version")"
tag="v$version"
git tag -a "$tag" -m "Odinn Forge $tag"
git push origin "$tag"
```

Use a signed tag when signing is configured. The tag starts the protected
release workflow, which independently verifies the version/tag/commit binding,
runs the release gates, and publishes through the `release` environment. Never
move or reuse a published tag; prepare a new patch or prerelease version instead.
