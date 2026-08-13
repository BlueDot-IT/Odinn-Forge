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
   of its parent package. Repository and package roots are resolved physically;
   a package root or manifest that traverses a symbolic link fails the check.
   Pnpm's `node_modules` and `bower_components` exclusions remain in force;
   other generated directories, including a directory named `dist`, are
   authoritative workspace roots when matched and must be excluded explicitly
   in `pnpm-workspace.yaml` when they are not packages.
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
   patterns, the most-specific wildcard wins, and active conditions are
   evaluated in declaration order. Runtime imports and requires include Node
   24's default `node-addons` and `module-sync` conditions in addition to
   `node`, `import`, or `require`. Static imports and exports select `import` or
   `require` from the source extension (`.mts`/`.mjs` or `.cts`/`.cjs`) and the
   package module type; TypeScript-only imports also activate `types` and honor
   an explicit `resolution-mode`. `default` remains the fallback condition,
   and a selected exact or wildcard `null` target excludes the subpath.
   Inside an exports fallback array, `null`, unmatched conditions, and invalid
   targets may fall through to a later valid target as they do in Node 24.
   Every target in every condition and fallback is audited even when no current
   source import selects it. Concrete targets and existing wildcard matches are
   resolved physically and must be regular files owned by the exporting
   package. Broken targets, repository escapes, and transitions into a
   separately discovered nested workspace fail closed. Export targets are
   restricted to statically auditable JavaScript/TypeScript, extensionless Node
   entrypoints, or inert JSON data. Native addons and arbitrary extensions such
   as `.node` and `.txt` cannot become opaque executable package surfaces.
   Exported source targets under otherwise ignored build output are added to
   the source inventory. Public subpaths such as
   `@odinn/kernel/browser-worker-host`, `@odinn/protocol/gateway-v2/schema.json`,
   and `@odinn/store-sqlite/memory-index` remain valid.
7. Relative, absolute, or repository-root file references that leave a
   workspace package are rejected, including paths into repository tooling and
   paths outside the repository. Relative references into ignored package
   directories such as `dist` or `node_modules`, and references to source
   extensions the checker cannot statically audit, also fail closed.
   Percent-encoded module specifiers cannot disguise traversal segments.
   Production code must not reach into another package's `src/` tree or depend
   on files absent as package API. Every
   symbolic link or junction beneath a production package is rejected without
   being followed, including broken links and links whose targets cross package
   or repository ownership. The release verifier independently rejects
   symbolic and hard links in extracted production archives.
8. Dynamic `import()`, direct `require()`, and `module.require()` calls in
   production workspace packages use literal specifiers. Non-`node:` URL
   module specifiers are rejected, including `file:` paths whose physical
   meaning can change through `/proc`, symlinks, or the process working
   directory and executable `data:` modules. Indirect `require` references,
   `createRequire`, computed or private `Module` loaders, derived `Module`
   classes and instances, `Reflect.get` loader authority, synchronous or
   asynchronous loader registration, unresolved module loader properties, and
   runtime `getBuiltinModule("module")` access fail closed. Direct, global, or
   aliased `eval`, `Function` construction, evaluator
   call/apply/bind forms, and callable `.constructor` code generation are also
   rejected because their later imports cannot be bound to package identities.
   Statically computed loader properties, computed destructuring, and
   re-exports that expose loader authority are covered; unrelated string
   construction and ordinary function calls remain ordinary source text.
9. The `@odinn/*` namespace and `workspace:` dependency protocol resolve only
   to packages present in this workspace.
10. TypeScript triple-slash path, type-package, and AMD dependency references
    are evaluated through the same file and package boundary as ordinary
    imports. Local declaration references and external ambient type packages
    remain valid; cross-package private paths and forbidden workspace edges do
    not.
11. `package.json#imports` aliases and effective TypeScript `paths` aliases in
    every `tsconfig*.json` or `jsconfig*.json` owned by a production package are
    rejected, including package build variants and their inherited options.
    Cross-package imports must remain visible as exported workspace package
    specifiers rather than being rewritten by a second resolver. Repository
    tooling configurations are outside this production graph unless a
    production package config inherits them; nested workspace configs belong
    only to their most-specific package.

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
