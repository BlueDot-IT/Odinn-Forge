# Plugin system completion: implementation and verification

## Delivered contract

The supported external boundary is public SDK **1.0** with an independently
packable JavaScript/types package, portable `.odinn-plugin.zip` artifacts,
local/public-HTTPS metadata catalogs, and OCI-contained MCP stdio connectors.
The host broker performs constrained HTTPS reads on behalf of a denied-network
container; credential references remain host-owned.

`PluginLifecycleService` and `ExtensionRegistry` provide one audited,
identity-checked lifecycle across CLI and gateway. Install/update/rollback
reset authority. Service configuration and grant changes invalidate review.
The console Plugins page exposes inspect/install, catalog browse, service
setup, selected access, review, enable/disable, doctor, update/rollback,
uninstall, governed tool discovery, and durable one-time-approved invocation.

## Acceptance evidence

| Area | Verification source |
| --- | --- |
| Independent SDK consumption, archive integrity, bounded catalogs | `tests/plugin-authoring.test.ts` and public SDK package tests |
| Real extension-backed lifecycle and stale identity rejection | Plugin lifecycle tests and `tests/plugin-surfaces.test.ts` |
| CLI and HTTP author-to-operator workflow | `tests/plugin-surfaces.test.ts` |
| Console safe metadata rendering and pinned durable invocation | `tests/console-plugin.test.ts`, console regression suite, browser UAT |
| Host request broker, denial, timeout, and credential privacy | Plugin service broker tests and OCI integration evidence |
| Live external-author connector | `examples/plugins/weather-connector`; real OCI/network evidence reported separately |

Test names identify intended checks; release evidence must include actual
commands and results. Passing mock or fixture tests is not live-account or
live-network verification. Do not infer completion from a test file existing.
The final implementation report records executed checks and any remaining
runtime limitations.

## Authority and privacy invariants

- Archive integrity covers executable and dependency files, not merely manifest
  metadata. Source paths are not trusted execution identity.
- The real ExtensionRegistry remains the sole installed authority record.
- Mutations require the current identity, run under the state mutation lock,
  and are audited. Disable supports immediate revocation.
- Discovery uses normal host admission. Invocation goes through durable jobs
  and exact one-time approval continuation, not a new dispatcher.
- Containers have no unrestricted network or host secret environment. The
  host service broker accepts only reviewed service scopes.
- Lifecycle changes invalidate discovery/approval identities. Stale requests
  cannot silently acquire new grants or a new account reference.
- Live provider content is not advertised as saved job/replay output. Approval
  continuation delivers it only to the active operator.
- Every plugin route is local-owner-only. Hosted tenant reads cannot expose
  host package paths, credential-reference identities, or OCI diagnostics.
- SDK/package publication, catalog hosting, production deployment, and account
  provisioning remain separate authorized release actions.

## Explicitly outside this slice

Arbitrary remote HTTP MCP, third-party in-process JavaScript, third-party
host adapters, unconfined runtime fallback, hosted tenant plugin access,
OAuth account creation, automated image pulls, a hosted marketplace, and
publisher verification infrastructure. A digest verifies bytes, not authorship.
