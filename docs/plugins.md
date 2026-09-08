# Third-party plugins

Forge's public plugin contract is SDK **1.0**, with portable packages running
as **OCI-contained MCP JSON-RPC 2.0 stdio** connectors. A plugin cannot load
JavaScript into Forge's host process. Arbitrary remote HTTP MCP servers and
hosted-tenant plugin access are not supported.

The CLI and the console's **Plugins** page share `PluginLifecycleService` and
the real `ExtensionRegistry`. There is no second plugin execution registry.

## For operators

### Install and inspect

In the console, open **Plugins**, select an archive or a package path inside
the workspace, and click **Inspect package**. Review the requested tools,
services, and package digest before choosing **Install disabled**. For large
packages, use a workspace path instead of an upload. The current upload limit
is shown in the UI and respects the gateway request-body limit.

CLI equivalents, run from the intended workspace:

```sh
odinn plugin inspect --input weather.odinn-plugin.zip
odinn plugin install --input weather.odinn-plugin.zip --digest SHA256
odinn plugin list
odinn plugin info --id weather-connector
```

`SHA256` above is the complete archive digest returned by inspection, not a
publisher identity. The host verifies package contents and stages its own
workspace-contained copy. Source-machine paths are not execution paths.

Installation does not execute plugin code or enable tools. Package checksums
establish content integrity, **not publisher verification**.

### Configure, grant, review, enable

The console guides these steps separately:

1. Choose the declared services the plugin may use.
2. Select and save its capability grants.
3. Review the exact package, service scope, and access; trust that identity.
4. Run setup checks, resolve missing prerequisites, then enable the plugin.

Example for the included public weather connector:

```sh
odinn plugin configure --id weather-connector --bindings-json '{"open-meteo":{"enabled":true}}' --identity FINGERPRINT
odinn plugin grant --id weather-connector --grant mcp.discover,mcp.invoke,network.access --identity FINGERPRINT
odinn plugin review --id weather-connector --identity FINGERPRINT
odinn plugin enable --id weather-connector --identity FINGERPRINT
odinn plugin doctor --id weather-connector
```

**Use the current `identityFingerprint` returned by each preceding operation**
for the next command. Changing a package, grant, or service binding invalidates
earlier review and discovery. Stale operations are rejected instead of
overwriting intervening changes.

Services with credentials accept only an existing host-owned reference such
as `env:SERVICE_API_TOKEN`. Set up the underlying value through protected host
credential setup; never enter it in plugin configuration, manifests, CLI
arguments, catalog files, or console forms. The plugin receives a bounded
service response, not the referenced credential.

The manifest fixes each service's HTTPS origin, exact paths, allowed query
keys, and optional credential declaration. Operators can select these
services, not replace their origins or invent broader paths.

### Runtime prerequisites

Enabled does not necessarily mean ready. `plugin doctor` reports the
independent prerequisites and recovery steps:

- `runtime.enableMcp` is enabled in the selected Forge configuration.
- `sandbox.process.enabled` is enabled with a supported local OCI backend.
- The package's **digest-pinned** container image is available locally.
- Package integrity, review, capabilities, selected services, and any
  credential references are valid.
- Host policy permits MCP discovery/invocation and the requested service
  capabilities.

Plugin lifecycle operations do not rewrite your configuration or pull images.
Use Forge's existing configuration editor to preserve unrelated settings.
Runtime configuration changes require the normal gateway restart. Image
installation is a separate operator action; doctor only inspects availability.

### Run a tool

In **Plugins**, select an enabled plugin, choose **Discover tools**, fill the
selected tool's input form, and select **Request run**. Review the exact
pending request and choose **Allow once and show result** or **Deny**.

CLI runtime commands address the running local gateway, defaulting to
`http://127.0.0.1:18790` and using its existing protected authentication file:

```sh
odinn plugin discover --id weather-connector
odinn plugin invoke --id weather-connector --tool weather-connector.current --input-json '{"latitude":40.7,"longitude":-74}'
odinn plugin approvals --id weather-connector
odinn plugin approve --approval APPROVAL_ID --confirm
```

Use `--gateway-url` and the matching `--state` when the local gateway is at a
different address. Never put an authentication token in a URL or command.

Discovery uses the host's normal execution-admission service. Invocation
submits a durable `/jobs` request pinned to the discovered package and tool
schema. It does not bypass policy or approvals. The approval continuation
returns the **live result**; saved job status and replay are not a copy of
service content. Clearing/reloading the console discards its live result.
Approval continuation requires the originating direct plugin job. Detached
or nested-agent MCP approvals must be resubmitted as a fresh direct plugin run.

### Update, revoke, roll back, uninstall

```sh
odinn plugin update --input weather-new.odinn-plugin.zip --identity FINGERPRINT
odinn plugin disable --id weather-connector
odinn plugin rollback --id weather-connector --identity FINGERPRINT
odinn plugin uninstall --id weather-connector --identity FINGERPRINT
```

An update or rollback remains disabled and requires fresh setup/access/review.
Disable can be requested without a stale-identity precondition for immediate
revocation. New dispatch is blocked; active resources are invalidated through
the governed runtime. Uninstall preserves user data. Neither revocation nor
rollback undoes a response already delivered or an external effect already
performed.

## Catalogs

Catalogs are bounded metadata-only JSON, read from a local file or public
HTTPS. There is no implicit official marketplace or publisher-verification
service. Every listed artifact has an exact version and SHA-256 digest.

```sh
odinn plugin catalog --catalog catalog.json
odinn plugin catalog --catalog catalog.json --id weather-connector --version 0.1.0
odinn plugin install --catalog catalog.json --id weather-connector --version 0.1.0
odinn plugin install --input https://publisher.example/weather.odinn-plugin.zip --digest SHA256
```

Use **Browse catalog** in the console for the same discovery and inspection
flow. HTTPS downloads reject credentials in URLs, redirects, private-network
destinations, excessive bodies, and mismatched digests. Local catalog artifacts
must remain within the catalog boundary, and gateway-selected local files
must also remain physically inside the selected workspace.

## For authors

`@odinn/plugin-sdk` is a separately packable, versioned package. Its generated
JavaScript and declarations work in an independent Node project without
private Forge imports. This development change does not itself publish it to
npm; distribute/install the SDK's packed tarball until publication is approved.

```sh
odinn plugin scaffold --id my-connector --output my-connector
odinn plugin validate --input my-connector
odinn plugin pack --input my-connector --output my-connector.odinn-plugin.zip
```

The scaffold is executable MCP stdio, not a placeholder. Supply `--image` to
choose another supported digest-pinned image. Follow the SDK README for the
supported manifest/schema and host-broker protocol. Keep diagnostics off
stdout, which is reserved for bounded JSON-RPC messages.

The [weather example](../examples/plugins/weather-connector/server.mjs) uses
Open-Meteo through the host request broker. It needs no account credential and
demonstrates the actual external-author path. Its mock/fixture tests establish
protocol behavior, not live service availability. OCI and live-network
verification must be reported separately in release evidence.

## HTTP contract

| Route | Purpose |
| --- | --- |
| `GET /plugins`, `GET /plugins/:id` | Installed state and current identity |
| `GET /plugins/doctor?id=…` | Non-mutating readiness checks |
| `GET /plugins/catalog?source=…` | Metadata-only catalog discovery/details |
| `POST /plugins/inspect`, `/plugins/validate` | Verify an upload or workspace-contained artifact |
| `POST /plugins` | Install/update a verified archive, disabled |
| `POST /plugins/:id/lifecycle` | Configure, grant, review, enable, disable, rollback, remove |
| `POST /plugins/:id/discover` | Governed MCP tool discovery |
| `POST /jobs` | Submit pinned `mcp.invoke` for approval |
| `POST /approvals/:id/approve` | Exact one-time continuation and live result |

Install accepts exactly one of `path`, bounded `archiveBase64`, `artifactUrl`
with `expectedDigest`, or `catalogSource` plus `id`/`version`. It never accepts
a manifest and caller-claimed digest as an installed artifact. Lifecycle
requests carry `expectedIdentityFingerprint`; service setup accepts
`serviceBindings` only. All plugin routes require authenticated local-owner
access under the gateway's existing auth/origin controls; hosted tenants
cannot enumerate packages, inspect host prerequisites, or mutate plugins.
