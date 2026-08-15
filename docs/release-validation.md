# Release validation

Release validation checks the packaged artifact and the workflows that matter
to an operator. It complements the automated test suite with installation,
onboarding, recovery, rollback, and security evidence from the exact artifact
being published.

## What to verify

- The package is built from the intended commit and its archive checksums,
  SBOM, and provenance are available.
- Platform support is covered by the ordinary Linux, macOS, and Windows CI
  matrix. Downloaded-artifact installation on each operating system is
  advisory evidence, not a publication gate.
- A configured provider can complete a real model request without exposing
  credentials in output or diagnostics.
- Gateway restart, queued-job recovery, browser-action recovery, audit
  verification, and installer rollback behave as documented.
- The single-user gateway remains loopback-only unless the separate TLS host is
  deliberately configured.
- No unresolved security or release-blocking defect is hidden by a green
  synthetic check.

## Artifact checks

Run these commands from a clean, committed checkout:

```bash
pnpm test:migrations
pnpm test:update
pnpm test:rollback
pnpm test:backup
pnpm test:restore
pnpm test:uninstall
pnpm test:compiled-release
pnpm test:invariants
pnpm release:package
pnpm release:soak
pnpm release:checksums
node scripts/release/verify.ts
pnpm release:install-smoke
pnpm storage:drill
```

The packager archives `HEAD`, not uncommitted working-tree changes. Run the
soak before checksums so its report is included in the final checksum set. If
an artifact changes afterward, regenerate the checksums and rerun verification.

## Published RC2 identity (historical)

The published `1.1.0-rc.2` candidate is immutable historical evidence. Its
reviewed merge commit, source metadata, generated package metadata, and release
assets describe one identity. Do not retag RC2, move its Git ref, or reuse its
release for a later candidate. The current candidate must use a new exact tag
and a fresh downloaded-asset verification record.

- The RC2 package metadata declared `1.1.0-rc.2` and its release assets were
  generated for the matching `v1.1.0-rc.2` identity.
- The historical RC2 Git ref resolves to commit
  `9256e23c1f78b3ab14b51ee72c0d2a4d0fdd769c`; it is not evidence that the
  current candidate has an annotated release tag. Future candidates must
  satisfy the annotated-tag policy in [ci-cd](ci-cd.md).
- RC2 is not evidence that the current `1.1.0-rc.3` line has been published.
  The current line still requires a fresh candidate tag, draft release, and
  exact-artifact validation.
- The source `release-info.json` is an export-substituted template; `pnpm
  release:package` generates the compiled package's release identity with the
  exact version, commit, runtime digest, and state-schema compatibility.
- The generated `release-manifest.json`, package `release-info.json`, archive
  `package.json`, `SHA256SUMS.txt`, SPDX SBOM, and `release-provenance.json`
  must agree on version, commit, runtime digest, and archive checksums. The
  workflow's downloaded-asset verification is the authoritative proof that
  published files match the generated set.
- Build provenance must cover the final release assets. When additional
  platform-specific validation is performed, retain sanitized OS/architecture,
  toolchain, artifact checksum, SBOM, provenance, and downloaded-asset results.

## Schema rollback boundary

State migrations marked `rollbackCompatible: false` (including runtime SQLite
schema upgrades through v7/v8) are intentionally fail-closed. The previous
Odinn binary must not be launched against the newer active state: the updater
or operator must restore the protected pre-migration backup first, then launch
the older binary. A green source-level migration test does not prove binary
rollback; the acceptance record must exercise the actual previous artifact,
backup restore, and post-restore onboarding/tool smoke.

## Publication sequence

Create the GitHub release as a draft with the exact `vX.Y.Z` tag, then manually
dispatch the protected **Release** workflow with that tag. Draft releases do
not emit the `release.created` workflow event, so the manual dispatch is
intentional. The workflow verifies the tag commit, builds and soaks the exact
candidate, refuses asset replacement, downloads the release assets back, and
checks their checksums on its staging runner before publishing npm or
promoting the GitHub release. The separate Linux/macOS/Windows downloaded-
artifact matrix is not a publication dependency; those platforms remain
covered by ordinary CI.
The GitHub release `prerelease` flag must match the tag: tags containing `-`
must be prereleases, and stable tags must not be. Prerelease packages use the
npm `next` dist-tag. If the npm version already exists, the workflow downloads
the registry tarball and compares it byte-for-byte with the candidate before
continuing. If GitHub promotion fails after npm publication, leave the release
draft in place and rerun the same tag after resolving the GitHub failure; the
workflow reports that partial-publication state explicitly. Enable GitHub
immutable releases in repository administration before publishing a stable
release; that setting cannot be established by the workflow itself.

## Evidence record

For any platform or provider path that is exercised, record the OS,
architecture, Node.js and package-manager versions, exact artifact checksum,
result, and sanitized failure evidence. Do not include credentials, prompts
containing private data, cookies, gateway tokens, or raw runtime state.

Synthetic providers and hosted CI runners are useful regression coverage, but
they do not prove the behavior of a live account, external website, or clean
machine. Keep those distinctions explicit in release notes and issue reports.

## Boundaries

Forked workers provide crash containment, not a security sandbox. Remote
hosting provides application-level tenant isolation, not hostile-user
operating-system isolation. External effects and nondeterministic provider
behavior are outside full replay and rollback guarantees.
