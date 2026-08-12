# Workspace package dependency graph

_Status: enforced for every production workspace package._

Odinn Forge uses an explicit package-by-package allowlist rather than a broad
layer slogan. The allowlist records the architecture that the current
composition roots actually implement. A new package or edge requires a
deliberate update to this document, the checker policy, and its regression
tests.

## Allowed graph

Each row lists every other workspace package that the source package may
depend on. An empty cell means that the package may use Node.js and external
dependencies, but may not depend on another Odinn workspace package.

| Source package | Role | Allowed workspace dependencies |
| --- | --- | --- |
| `@odinn/application` | Transport-neutral application contracts and use cases | — |
| `@odinn/protocol` | Durable protocol contracts | — |
| `@odinn/policy` | Capability and policy evaluation | — |
| `@odinn/store-file` | File-backed store | `@odinn/protocol` |
| `@odinn/store-sqlite` | SQLite-backed stores | `@odinn/protocol` |
| `@odinn/channels` | Shared transport-neutral channel contracts and persisted channel state | `@odinn/store-file` |
| `@odinn/channel-discord` | Discord adapter | `@odinn/channels` |
| `@odinn/channel-slack` | Slack adapter | `@odinn/channels` |
| `@odinn/channel-teams` | Teams adapter | `@odinn/channels` |
| `@odinn/channel-telegram` | Telegram adapter | `@odinn/channels` |
| `@odinn/channel-whatsapp` | WhatsApp adapter | `@odinn/channels` |
| `@odinn/kernel` | Policy-authoritative domain/runtime service facade | `@odinn/channels`, `@odinn/policy`, `@odinn/protocol`, `@odinn/store-file`, `@odinn/store-sqlite` |
| `@odinn/runtime` | Host-owned worker and adapter composition | `@odinn/channel-discord`, `@odinn/kernel` |
| `@odinn/gateway` | HTTP process composition root | `@odinn/application`, all five `@odinn/channel-*` adapters, `@odinn/channels`, `@odinn/kernel`, `@odinn/policy`, `@odinn/runtime`, `@odinn/store-file` |
| `@odinn/cli` | Terminal process composition root | `@odinn/application`, `@odinn/gateway`, `@odinn/kernel`, `@odinn/policy`, `@odinn/runtime` |

The CLI-to-Gateway edge is intentional: the CLI's `serve` path starts the
Gateway. Gateway-to-adapter edges are also intentional because Gateway is the
composition root that selects configured channel transports. Runtime composes
the Discord adapter only for the adapter-owned agent-tool definitions that it
currently hosts. These composition edges do not authorize packages or
adapters to import an app.

The application layer currently has no workspace dependency. Apps construct
its transport-neutral ports over the compatibility kernel facade while the
vertical-slice migration proceeds. The kernel therefore does **not** import
the application package, and the broad sample rule `kernel -> application`
would encode the dependency in the wrong direction for the current tree.

## Enforced invariants

`pnpm check:architecture` parses TypeScript and JavaScript syntax and validates
both source references and package manifests. It enforces all of the following:

1. Package roots are derived from the globs in `pnpm-workspace.yaml`, including
   nested workspace packages. Every discovered package is registered in the
   allowed graph, every graph key is discovered, and every graph target names
   a discovered graph package. A nested package is not scanned again as part
   of its parent package.
2. Workspace entries in `dependencies`, `devDependencies`,
   `optionalDependencies`, and `peerDependencies` use the target's canonical
   package name and the exact `workspace:*` specifier, then follow the allowed
   graph. Internal semver references and workspace aliases/redirections cannot
   substitute a different package identity. `file:`, `link:`, and npm alias
   specifiers are rejected outright in production workspace manifests.
3. Every workspace package imported by source is declared in the importing
   package's manifest.
4. Packages and adapters cannot depend on an app. The intentional
   CLI-to-Gateway app composition edge remains allowed.
5. One adapter cannot depend on another adapter.
6. Bare workspace imports may use only the root or subpaths exposed through
   Node-compatible `exports` resolution. Exact entries take precedence over
   patterns, the most-specific wildcard wins, active `import`, `require`,
   `node`, `types`, and `default` conditions are evaluated in declaration
   order, and a selected `null` target excludes the subpath. Public subpaths such as
   `@odinn/kernel/browser-worker-host` and
   `@odinn/store-sqlite/memory-index` remain valid.
7. Relative, absolute, or repository-root paths that cross a workspace package
   boundary are rejected. Production code must not reach into another
   package's `src/` tree or depend on files absent as package API.
8. Dynamic `import()`, direct `require()`, and `module.require()` calls in
   production workspace packages use literal specifiers. Indirect `require`
   references and `createRequire` loaders are rejected because the checker
   cannot soundly bind their later calls to module identities.
9. The `@odinn/*` namespace and `workspace:` dependency protocol resolve only
   to packages present in this workspace.
10. `package.json#imports` aliases and TypeScript `paths` aliases are rejected
    for production architecture. Cross-package imports must remain visible as
    exported workspace package specifiers rather than being rewritten by a
    second resolver.

There are no legacy exemptions.

## Deliberate exclusions

- Repository tooling under `scripts/` and tests under `tests/` are not runtime
  workspace packages and are outside this graph. Release scripts may inspect
  source-owned schema constants because they execute from the source checkout;
  they are not imports from a shipped runtime package.
- External npm and Node.js dependencies are outside dependency-direction
  policy. Lockfile integrity, advisory audit, package verification, and SBOM
  jobs govern those dependencies.
- Mutable workspace configuration and runtime backend selection are trust and
  validation concerns, not package edges. They remain subject to their
  dedicated parsers, policy checks, and runtime tests; this static checker does
  not pretend to prove them safe.
- The graph describes the current migration state. As additional vertical
  slices move behind `@odinn/application`, old app-to-kernel edges should be
  removed from the allowlist in the same change that removes the imports and
  manifest entries.
