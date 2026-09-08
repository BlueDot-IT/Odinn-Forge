# @odinn/plugin-sdk 1.0.0

Dependency-free JavaScript and TypeScript SDK for Odinn Forge's read-only OCI MCP
connectors. No private kernel imports or TypeScript loader are required. The
compiled `lib/` distribution is checked in so fresh workspace installs work;
`pnpm --filter @odinn/plugin-sdk build` and `npm pack` refresh it from TypeScript.

This version is implemented and locally distributable, **not publicly published**.
Create the tarball from a Forge checkout with `npm pack ./packages/plugin-sdk`,
then install that tarball in an unrelated project with `npm install /path/to/tarball`.

```js
import { createConnectorScaffold, validatePluginManifest } from '@odinn/plugin-sdk';
const { manifest, files } = createConnectorScaffold('my-weather');
validatePluginManifest(manifest);
```

```sh
npx odinn-plugin scaffold my-weather
npx odinn-plugin validate my-weather/plugin.json
```

The scaffold contains a runnable incremental MCP JSON-RPC server. It reads
Open-Meteo's current temperature through Forge's `odinn/service.request` broker;
it has no network client or credential dependency. The default Node 24.19.0 image
is immutable and digest-pinned. `--image=<reviewed-reference>@sha256:<digest>`
selects another Node image; inspection never pulls it automatically.

SDK v1 supports only `connector`, `oci-mcp-stdio`, `mcp-jsonrpc-stdio`, closed
bounded MCP schemas, and read-only host-brokered HTTPS GET services. Tool names
start with `<plugin-id>.`. Manifest metadata does not grant permissions, network
access, account access, or publisher trust. Forge separately installs, configures,
grants, reviews, enables, disables, updates, rolls back, and removes plugins.

No host-process plugins, remote MCP servers, unrestricted network, direct secret
values, lifecycle scripts, general JSON Schema, or external-state effects are
supported by this contract. See the Forge authoring guide for package and catalog
limits, explicit service setup, and compatibility details.
