# Dependency security overrides

The root `pnpm.overrides` entries keep pinned transitive HTTP dependencies on
compatible security releases. Install with `pnpm install --frozen-lockfile` and
keep the normal `node scripts/ci/audit.ts high` gate enabled.

- Discord's Undici 6 dependency is held at 6.29.1 or newer within major 6.
- Slack explicitly uses Undici 7.30.1; its socket-mode peer resolves to that copy.
- Express's body-parser 2 dependency is held at 2.4.0 or newer within major 2.

`tests/dependency-http-security.test.ts` exercises the resolved HTTP libraries
against loopback responses with excessive content encodings and compressed
request bodies with trailing malformed bytes. It also verifies subsequent
ordinary requests remain functional.

## Outstanding upstream compatibility gaps (2026-10-25)

The full audit still reports Zod and MSAL Node in the optional Teams dependency
tree. Bot Framework 4.23.3 requires Zod 3 and calls `.nonstrict()`, which patched
Zod 4.6.6 and newer no longer provide. Azure Identity's latest 4.14.0 manifest
still requires MSAL Node 6, while the advisory fixes start at 7.1.0. Do not force
these major-version overrides merely to turn the audit green: use a supported
upstream dependency update or separately reviewed compatibility migration.
These unresolved findings remain merge-blocking; this HTTP refresh is not a
claim that the complete dependency tree is clear.
