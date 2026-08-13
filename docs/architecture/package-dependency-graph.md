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
   Pnpm's `node_modules` and `bower_components` source exclusions remain in
   force. The checker audits package-local `node_modules` links and the first
   resolver-visible ancestor link for every bare production import. A link's
   path name and physical target manifest name must match the requested
   package. Workspace links must resolve to that workspace package's canonical
   physical root; external links must resolve to a same-named declared package
   in the repository pnpm store. A missing package-local workspace link cannot
   fall through to a redirected ancestor. Resolver-visible dot-prefixed package
   names are audited too, including `.bin` and `.pnpm` when source attempts to
   load them as packages. Undeclared aliases into apps,
   workspace source, or repository tooling fail closed.
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
   targets may fall through to a later valid target as they do in Node 24, but
   the package remains noncompliant until every invalid fallback is removed.
   Every target in every condition and fallback is audited even when no current
   source import selects it. Non-string/non-null leaves and string targets
   containing backslashes, percent encoding, or a path outside the
   package-target `./` grammar are invalid. Concrete
   targets and existing wildcard matches are
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
7. Relative runtime file references (`.`, `..`, `./…`, or `../…`) must name an
   existing regular file with an explicit statically auditable extension. A
   dot-prefixed name without a slash remains a bare package specifier, matching
   Node resolution. Directory/package-main resolution,
   extension fallback, and native addon fallback are deliberately outside the
   accepted grammar. Backslashes are forbidden in production module specifiers,
   and CommonJS `require` specifiers cannot use query or fragment suffixes,
   because Node treats those characters as literal filename/package identity.
   Relative, absolute, or repository-root file references that leave a
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
   runtime `getBuiltinModule` access and direct `process.dlopen` fail closed.
   The ambient `process` object is governed at its origin by a closed grammar.
   Direct reads are limited to `arch`, `argv`, `cwd`, `env`, `execPath`,
   `exit`, `exitCode`, `getuid`, `kill`, `pid`, `platform`, `stdin`, `stdout`,
   and `version`; only direct `exitCode = ...` assignment is writable.
   Receiver-independent calls use named `node:process` imports limited to
   `cwd`, `exit`, and `kill`; optional platform APIs such as `getuid` are read
   and invoked unbound. Default, namespace, dynamic, CommonJS,
   and all other runtime `node:process` acquisitions fail closed. The Node
   operations that have no receiver-independent named export are limited to
   direct expression-statement calls of `process.on`, `process.once`,
   `process.removeListener`, and `process.send`; event listeners must resolve
   to stable local arrow functions. Computed access, extraction of these four
   operations, member mutation, or any unsupported transfer of the whole
   `process` object is rejected at the origin. A process-bearing local object
   is accepted only when every use resolves to an exact own data property and
   the process member itself stays within this grammar.
   The ambient global object likewise cannot be passed, stored, returned, or
   wrapped. Its `global`, `globalThis`, `self`, and `window` properties retain
   global authority recursively; only read-only `fetch` and `Math` terminals
   are ordinary, while evaluators and `Proxy` remain governed by their
   dedicated restrictions.
   The ambient CommonJS `module` object is limited to the exact
   `module.exports` surface; `_compile`, `require`, computed properties,
   CommonJS wrapper `arguments`, destructuring, and capability-preserving
   transforms are rejected.
   Production source cannot
   acquire the runtime `node:module`/`module` namespace (apart from type-only
   use and the static `builtinModules` metadata export) or `node:vm`/`vm` at
   all. For the enumerated acquisition grammar, this boundary remains
   effective across descriptors, spreads, bound constructors, proxies,
   prototype-derived containers, callbacks, and the other covered
   capability-preserving transforms. Direct, global, or
   aliased `eval`, `Function` construction, evaluator
   call/apply/bind forms, and callable `.constructor` code generation are also
   rejected because their later imports cannot be bound to package identities.
   Global evaluator descriptors, repeated/comma-wrapped global objects,
   reflected or computed callable constructors, transparent array/conditional/
   logical wrappers, and Proxy-derived global objects are covered. Reflected
   authority stays tracked through direct, bound, destructured, call, and apply
   helper forms. Ambient names are resolved against lexical bindings,
   so shadowed local `module`, `Module`, `process`, `getBuiltinModule`, and
   lookalike `constructor` methods remain ordinary. Reflection helper aliases
   are accepted and become restricted only when invoked against evaluator or
   runtime-loader authority. Unresolved computed access directly against a
   callable expression is rejected by the closed grammar; use an explicit
   property name for ordinary code.
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
12. Production package scripts use a closed, shell-free grammar. They may run
    a package-owned, regular, statically audited source entrypoint as
    `node ./path` with no runtime options, or a package-owned configuration as
    `tsc -p tsconfig*.json`. Loader/preload flags, inline evaluation,
    environment injection such as `NODE_OPTIONS`, shell wrappers, URLs, and
    package/repository escapes are rejected. Accepted Node entrypoints are
    added to the source inventory, including explicit build-output targets.

There are no legacy exemptions.

The architecture checker and its package-link fixtures run on hosted Linux,
macOS, and Windows CI. Windows uses directory junctions for the same physical
ownership and manifest-identity assertions; path containment and package-name
checks are platform-neutral.

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
- This is a syntax, manifest, exports, and installed-link policy for the
  enumerated acquisition grammar. It does not claim whole-program semantic
  proof over arbitrary execution primitives such as approved worker or child
  process creation; those remain governed by their dedicated runtime and
  sandbox boundaries.
- The four allowed receiver-bound `process` operations above are operational
  compatibility points, not a proof that a mutated Node.js prototype or
  runtime dispatch table is trustworthy. Nor does the checker claim to model
  arbitrary recovery of the global object through engine-specific call-stack
  reflection. Dependency review, runtime tests, and the trusted Node.js
  boundary govern those semantics; the checker enforces the documented
  syntactic origins and transfers.
- The graph describes the current migration state. As additional vertical
  slices move behind `@odinn/application`, old app-to-kernel edges should be
  removed from the allowlist in the same change that removes the imports and
  manifest entries.
