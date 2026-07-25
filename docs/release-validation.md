# Release validation

Release validation checks the packaged artifact and the workflows that matter
to an operator. It complements the automated test suite with installation,
onboarding, recovery, rollback, and security evidence from the exact artifact
being published.

## What to verify

- The package is built from the intended commit and its archive checksums,
  SBOM, and provenance are available.
- A clean Linux, macOS, and Windows environment can install the package,
  complete onboarding, and run a deterministic local tool.
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

## Evidence record

For each platform and provider path, record the OS, architecture, Node.js and
package-manager versions, exact artifact checksum, result, and sanitized
failure evidence. Do not include credentials, prompts containing private data,
cookies, gateway tokens, or raw runtime state.

Synthetic providers and hosted CI runners are useful regression coverage, but
they do not prove the behavior of a live account, external website, or clean
machine. Keep those distinctions explicit in release notes and issue reports.

## Boundaries

Forked workers provide crash containment, not a security sandbox. Remote
hosting provides application-level tenant isolation, not hostile-user
operating-system isolation. External effects and nondeterministic provider
behavior are outside full replay and rollback guarantees.
