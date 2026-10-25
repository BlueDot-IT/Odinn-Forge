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

## Microsoft Teams dependency removal (2026-10-25)

The Microsoft Teams messaging adapter and its Bot Framework SDK are removed.
This eliminates the incompatible Zod 3 and MSAL Node dependency chains instead
of forcing unsupported major-version overrides. The normal high-severity audit
remains mandatory. Slack, Discord, Telegram, and WhatsApp remain available.

See [channel migration instructions](../channels.md#microsoft-teams-removed) for
handling existing Teams account records without deleting conversation history.
