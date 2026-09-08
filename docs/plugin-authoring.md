# Third-party connector authoring (SDK v1)

Forge now supports a complete local third-party **read-only OCI MCP connector**
workflow: scaffold, validate, deterministic package, catalog, install, configure,
inspect/doctor, grant/review, enable, discover/invoke, disable, update, rollback,
and uninstall. This is the bounded SDK v1 contract, not an arbitrary in-process
plugin loader or a public marketplace. No SDK, catalog, or package is publicly
published automatically.

## Independent author quick start

From the Forge checkout:

```sh
npm pack ./packages/plugin-sdk
```

Install the resulting `odinn-plugin-sdk-1.0.0.tgz` in an unrelated Node 24+ project:

```sh
npm install /absolute/path/odinn-plugin-sdk-1.0.0.tgz
npx odinn-plugin scaffold my-weather
npx odinn-plugin validate my-weather/plugin.json
```

The SDK exports standalone JavaScript and `.d.ts` declarations. Consumers need
neither Forge's source tree, kernel imports, a TypeScript loader, nor runtime
packages beyond Node. The small checked-in `packages/plugin-sdk/lib/` distribution
is reproducible from `src/` using the package build script. `npm pack` refreshes it.

The scaffold is the same working connector as `examples/plugins/weather-connector`.
Use `--image=<reviewed-digest-pinned-Node-image>` to select another available image.
The included image pin identifies Node 24.19.0 Bookworm. The operator must arrange
for that exact image to be available to the configured local OCI backend.

Use Forge's `plugin scaffold`, `plugin validate`, `plugin pack`, `plugin inspect`,
`plugin catalog`, `plugin details`, `plugin install`, `plugin configure`, `plugin
doctor`, and lifecycle commands, or the Plugins console. Run the CLI's help for
current arguments. Packing never overwrites an existing output; use a new filename.

## Manifest and service contract

Only `schemaVersion: 1`, `sdkVersion: "1.0"`, `kind: "connector"`,
`runtime: "oci-mcp-stdio"`, and `transport: "mcp-jsonrpc-stdio"` are accepted.
The manifest requires an immutable `containerImage` with `@sha256:<64 lowercase
hex>` and a relative JavaScript `entrypoint`. Runtime dependencies must be files
inside the package, or already present in that pinned image; no install scripts
are run. Identifiers, tool names, and schema properties follow the host's privacy
restrictions, including rejecting credential/authority-shaped identifiers.

Tool names are unique, prefixed with `<plugin-id>.`, and limited to the host's
eight name atoms. IDs are 2–64 lowercase kebab-case characters. Only the recognized
`mcp.discover`, `mcp.invoke`, `network.access`, and `secret.reference.use`
capabilities are accepted. Capabilities and read/network/credential effects must
agree. v1 tools are read-only and retry-safe; unknown fields and external-state
effects are rejected. The host remains authoritative for admission and policy.

Tool input schemas use closed objects (`properties`, `required`,
`additionalProperties: false`), arrays, strings, numbers, integers, and booleans.
Unknown keywords and `$ref` are unsupported. Limits include depth 12, 1,024 schema
nodes, 128 object properties, strings up to 16,384 bytes, and array bounds up to
1,024 items. Properties and names cannot impersonate credential or host authority.

Services are exact declarations such as:

```json
{
  "id": "open-meteo",
  "origin": "https://api.open-meteo.com",
  "paths": ["/v1/forecast"],
  "queryKeys": ["latitude", "longitude", "current"]
}
```

Each origin must be credential-free HTTPS on port 443, without a path, query, or
fragment. It must match `egress.hosts`. Paths are exact absolute paths, never
prefixes or patterns; query keys are individually allowlisted. All egress hosts
and declared secrets must be referenced by services. An optional service
`credential` names a top-level `secrets` declaration `{name, purpose}`; declarations
contain no values. The host separately opts each service in and may map its
credential to an opaque `env:NAME` reference. Values remain host-owned and never
enter the container, manifest, tool arguments, catalog, or package.

## Open-Meteo example

The example implements `initialize`, `notifications/initialized`, `tools/list`,
and `tools/call` incrementally over newline-delimited JSON-RPC 2.0. Its tool
`weather-connector.current` accepts latitude [-90,90] and longitude [-180,180].
After an admitted call it emits a request with string id `service-1`:

```json
{"jsonrpc":"2.0","id":"service-1","method":"odinn/service.request","params":{"serviceId":"open-meteo","path":"/v1/forecast","query":{"latitude":"40","longitude":"-74","current":"temperature_2m"}}}
```

It reads the host response `{status: 200, body: <parsed JSON>}` and returns bounded
MCP text content. The container has zero network and environment access. Only
the host broker can issue the exact approved GET; discovery cannot make service
requests. Host broker errors are categorical. No account is needed for this
example. Open-Meteo's service terms and availability remain external prerequisites.

## Portable package integrity

Packages are deterministic ZIP files rooted at `plugin/`. SHA-256 of the ZIP bytes
is the immutable artifact identity. A separate content digest seals every sorted
relative filename, byte length, and SHA-256. Extraction validates all metadata and
content before creating an exclusive destination, then seals files `0444` and
directories `0555`. Installed content is reverified before activation.

Limits: 16 MiB archive and total expanded data; 4 MiB per file; 256 KiB manifest;
1,024 files; depth 16; 512-byte portable ASCII paths. File and directory names must
be portable and cannot collide case-insensitively. Symbolic/hard links, special
files, path escapes, duplicate paths, overlapping entries, mismatched local/central
headers, encryption, ZIP64, archive comments, extra fields, and data descriptors
are unsupported. STORE and DEFLATE are supported; DEFLATE output is independently
bounded during decompression, and CRC and output length must match.

## Metadata-only catalogs

A catalog is a bounded local JSON file or public HTTPS document:

```json
{"schemaVersion":1,"plugins":[{"id":"weather-connector","version":"0.1.0","sdkVersion":"1.0","name":"Weather","description":"Read current temperature","artifact":"weather.zip","digest":"<SHA-256 of archive bytes>","publisher":"Unverified descriptive label"}]}
```

Catalogs allow at most 128 entries and 256 KiB. Local artifacts must be relative
and remain within the catalog directory. Remote artifacts require public HTTPS;
DNS is validated and pinned, TLS verified, redirects refused, and responses
bounded by size and a 15-second deadline. Credential-bearing URLs, URL queries,
non443 ports, private/IP-literal destinations, and compressed HTTP bodies are
refused. Downloads require a digest and validate archive identity before writing;
selected packages must also match catalog id, version, and SDK version.

A checksum proves content integrity, **not publisher identity**. Catalog publisher
labels are unverified metadata. Catalog inspection never executes code, grants
access, changes configuration, connects an account, or enables a plugin.

## Verification and release status

Focused checks exercise archive identity/sealing/tampering, links, malformed
metadata and bounded decompression, manifest-to-host compatibility, catalog
identity and private-DNS refusal. A real npm tarball is installed in an unrelated
consumer and its JavaScript import, scaffold CLI, and TypeScript declarations are
verified. The runnable example is suitable for the project's OCI integration
smoke; mock-only checks must not be described as live provider evidence.

Public registry publishing, a hosted marketplace, publisher signing, OAuth setup,
arbitrary remote MCP transports, and mutating service connectors are not part of
SDK v1. Installing or distributing this implementation does not deploy it or
publish any package automatically.
