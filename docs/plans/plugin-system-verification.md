# Plugin SDK v1 implementation and verification

Verified locally on 2026-09-08 in `/home/rev/projects/odinn-plugin-system-complete`,
branch `feat/plugin-system-complete`, based on
`470b21e9bfb5853a56a3952987fe4c857f166c79`.

## Implemented contract

- Standalone `@odinn/plugin-sdk@1.0.0` JavaScript, declarations, and scaffold/validate CLI.
- Portable deterministic ZIP packages, complete content verification, bounded extraction, and sealed installations.
- Local and public-HTTPS catalogs with pinned artifact identity; publisher labels remain explicitly unverified.
- One audited lifecycle service and existing execution registry for CLI and console: install, inspect, configure, grant, review, doctor, enable, disable, update, rollback, uninstall.
- OCI-contained MCP stdio discovery and invocation with exact package/tool/approval identity and host capability intersection.
- Host-owned read-only HTTPS service broker: exact service scopes, public-address pinning, optional opaque host credential references, bounded responses, cancellation, and retained physical-call ownership.
- Direct durable plugin jobs with one-time approval, live-only service results, and supervisor-owned terminal settlement.
- Installed packages survive state migration, backup, restore, and interrupted recovery without losing their sealed permissions.

Operator documentation: [Third-party plugins](../plugins.md).
Author documentation: [SDK authoring](../plugin-authoring.md).

## Executed checks

These rows report actual runs, not a deduplicated aggregate count.

| Check | Result |
| --- | --- |
| `pnpm check:architecture` | Pass; 16 package manifests, 192 source files, no temporary legacy occurrences |
| `pnpm format:check` | Pass |
| `pnpm lint` | Pass; one existing warning in `scripts/ci/slo-measurement.ts`, zero errors |
| `pnpm typecheck` | Pass across all workspace packages and the tooling contract |
| `pnpm build:production` | Pass; console and 18 compiled production files |
| Authoring and catalog suites | 7 passed, including actual npm tarball installation into an unrelated JS/TS consumer |
| Plugin lifecycle suite | 14 passed |
| CLI/HTTP/console plugin suites | 9 passed, including unlinked-approval refusal and content-only live rendering |
| Plugin runtime and service broker, existing MCP host/runtime, extension/bundle and agent regressions | 80 passed in the combined run |
| Final plugin runtime suite after adding inherited-capability regression | 8 passed |
| Capability Gatewatch, admission, and approval continuation suites | 24 passed |
| Gateway approval/MCP and cancellation regressions | 6 passed |
| Installed-package migration/restore suite | 5 passed |
| Existing state migration/lifecycle suites | 33 passed, 2 Windows-only skipped |
| Real packaged-plugin OCI smoke | 1 passed against the actual public Open-Meteo service |
| Real CLI/gateway/plugin OCI smoke | 1 passed; approved response delivered and durable job completed |
| `git diff --check` | Pass |

The two real-service checks are opt-in because they require an already available
digest-pinned OCI image and access to the public Open-Meteo endpoint:

```sh
ODINN_RUN_PLUGIN_LIVE_TESTS=1 node --test --test-concurrency=1 tests/plugin-oci.integration.test.ts
ODINN_RUN_PLUGIN_LIVE_TESTS=1 node --test --test-concurrency=1 tests/plugin-gateway-oci.integration.test.ts
```

The standalone OCI smoke verifies installed archive execution, admission,
approval, a numeric live temperature response, metadata-only audit, successful
container removal, and disablement. The CLI/gateway smoke additionally verifies
actual CLI discovery/invocation/approval, the originating job's completed status,
no provider body in its persisted projection, and rejection of approval reuse.

The console was exercised in a separate temporary local gateway through inspect,
install-disabled, service configuration, grants, review, enablement, discovery,
request-run, and allow-once. It displayed a successful real Open-Meteo result;
the originating job was independently checked as completed with no saved provider
body. That temporary gateway is not the running Forge installation.
The final content-only result was visually verified in
`.reports/plugin-system/console-live-result.png`; reproducible local fixture
scripts are retained beside it. The screenshot contains public weather data,
not credentials or a private account response.

## Review outcomes

Independent reviews covered architecture, package/lifecycle identity, broker
authority, physical-resource settlement, and the final gateway continuation.
The implementation fixes their identified issues, including inherited capability
ceilings, approval cache invalidation, and deferred supervisor settlement.
Unlinked or non-direct MCP approval continuations are refused; the supported
operator path always creates a direct durable `mcp.invoke` job.

## Local distributable artifacts

Built artifacts are under `dist/plugins/` (ignored build output):

| File | SHA-256 |
| --- | --- |
| `odinn-plugin-sdk-1.0.0.tgz` | `109abce289a087e5ac4d410e63085c66215f2c0505953f2f32ef4ab16a5a7dce` |
| `weather-connector-0.1.0.odinn-plugin.zip` | `72bcf3d8b8a89028af4208e949b5112b61e8428386c332c4cdaa5f7ae88f2574` |
| `catalog.json` | `4596f7dd9cbd929b39f2b52f04673b8ebd60436e5fc14b079868ebbf8b2a5752` |

The SDK tarball and example ZIP were built by the actual npm/Forge packaging
commands. The catalog points to that exact example archive. Checksums establish
artifact integrity, not public publisher verification.

## Explicit limits and release state

This is the local **read-only OCI MCP connector v1** contract. Arbitrary remote
MCP servers, in-process third-party code, mutating connectors, hosted tenants,
OAuth onboarding, public publisher signing, and a hosted marketplace are not
implemented by this version. Host-credential handling has fixture coverage;
no credential-backed live account was exercised. Windows-only behavior was not
verified on this Linux host.

No package was published, no catalog was hosted, no upstream branch was pushed,
and no production instance or account configuration was changed. The SDK tarball,
example package, compiled build, source changes, and verification are local and
reviewable.
