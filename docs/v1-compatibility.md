# Odinn Forge v1 compatibility policy

This document defines the compatibility promise for Odinn Forge v1. It is the
authoritative source for deciding whether a surface is stable, experimental,
provider-dependent, platform-dependent, internal, or unsupported.

This policy is effective for the `v1.x` release line.

## Boundary terms

- **Stable v1 interface** — documented behavior that v1.x releases preserve.
  Additive changes are allowed. Removal or incompatible semantic change
  requires deprecation or a new major version, except when a security fix must
  fail closed.
- **Internal implementation detail** — file layout, module boundaries, private
  package APIs, storage filenames, HTML structure, and other internals that may
  change without a compatibility promise.
- **Experimental interface** — an opt-in surface that may change or be removed
  in a minor release. Experimental state is not promised a stable migration
  path unless a release says otherwise.
- **Provider-dependent behavior** — behavior controlled in part by an external
  model provider, account, model, quota, endpoint, or network service.
- **Platform-dependent behavior** — behavior controlled in part by the host
  operating system, browser engine, filesystem, process model, or installed
  local software.
- **Unsupported behavior** — behavior outside the product contract. Do not
  depend on it for production use.

## Stable v1 interfaces

The stable local, single-user product includes:

- CLI startup and documented core commands
- Local onboarding
- Configuration loading and validation
- The loopback gateway and documented gateway routes
- The local web console
- Projects
- Sessions and messages
- Goals
- Memory
- Tasks, jobs, and cron jobs
- Provider inference through documented adapter contracts
- Audited tool execution
- Bounded workspace listing, metadata inspection, literal search, reads, and
  diffs
- Public web reads
- Isolated browser operation
- Approval before browser mutations
- Restart recovery and uncertain-outcome recovery
- Diagnostics
- Installation, update, rollback, backup, restore, and uninstall
- Persistent-state inspection and migration
- Audit verification
- Discord and Telegram local channel configuration, routing, diagnostics,
  durable session binding, and uncertain-outcome recovery

The [surface matrix](surface-matrix.md) maps individual product areas to these
terms. Passing tests or having an implementation does not by itself make an
undocumented interface stable.

## Compatibility expectations

### CLI commands and exit codes

Documented core command names, option meanings, and automation-relevant exit
behavior are stable. Exit code `0` means success; failures return a nonzero
code. New commands and optional flags may be added in v1.x.

Human-readable wording, spacing, color, and ordering may change. Scripts must
use documented machine-readable output where available rather than parse prose.
Removing a documented command, changing an option incompatibly, or turning a
successful operation into a different semantic operation requires deprecation
or a new major version.

### Configuration fields

Documented configuration fields, their types, and their security meaning are
stable. v1.x may add optional fields and stricter validation for invalid or
unsafe values. Security-sensitive defaults will not be silently weakened.
Compatible unknown fields are preserved where doing so is safe.

Undocumented fields, derived values, comments, ordering, and the internal file
layout are implementation details.

### Persistent state schemas

Every stable persistent store has an explicit schema owner and version.
Supported older schemas migrate through a validated, testable migration path
after planning and backup. Unknown newer schemas fail closed before mutation.
An older application must refuse state it cannot read instead of rewriting it.

The logical records and documented backup manifest are stable. Physical
filenames, JSON formatting, indexes, and module-level storage APIs are internal
unless this policy or the backup documentation says otherwise.

The canonical per-store registry is
`packages/kernel/src/state/schema-registry.ts`. The v1 owners are:

| Logical state | Schema owner | v1 support |
| --- | --- | --- |
| Configuration | Kernel configuration boundary | Stable |
| Records, sessions, projects, goals, and memory | File store plus the matching kernel module | Stable |
| Jobs | File store and job supervisor | Stable |
| Audit events and verification keyring | Protocol and file store | Stable |
| Approvals | Kernel approval boundary | Stable |
| Browser recovery and durable tab handles | Kernel browser boundary | Stable |
| Channel session bindings and delivery deduplication | Shared channel boundary | Stable |
| Cron definitions | Gateway cron boundary | Stable |
| Runtime database | SQLite store | Stable |
| Extension, Skill SDK, and Agent SDK registries | Their owning package boundary | Experimental |
| Per-store compatibility metadata | Kernel state boundary | Internal |

Before a supported migration changes state, Odinn inspects every store, proves
that a complete migration path exists, creates a protected backup, transforms
and verifies a staging tree, and then switches the state directory. An
interprocess lock and an external in-progress marker make an interrupted switch
recoverable. `odinn state migrate --dry-run` reports the versions, steps,
planned backup location, rollback compatibility, and blockers without writing
state.

The v1 backup manifest records its format version and kind, creation time,
source application version and commit, every store schema, whether sensitive
state was included, explicit exclusions, and a path, size, and SHA-256 digest
for every payload file. v1.x may add optional fields, but restore continues to
validate all required fields and rejects unknown future schemas.

The stable lifecycle commands are `odinn update check`, `odinn update`,
`odinn rollback`, `odinn backup`, `odinn restore`, `odinn uninstall`,
`odinn state status`, and `odinn state migrate --dry-run`. Their documented
safety properties—verified release identity, rollback compatibility checks,
backup-before-replace, state preservation by default, and explicit destructive
confirmation—are part of the v1 contract. Version-directory names, pointer
files, recovery directory names, and staging filenames remain internal.

### Gateway routes

Documented loopback gateway routes, request meanings, authentication boundary,
and stable response fields are v1 interfaces. New optional fields or routes may
be added. Undocumented routes, HTML structure, CSS selectors, JavaScript
bundles, and internal service calls are implementation details.

Browser-cookie mutations continue to require the documented same-origin
boundary. Authentication, approval, network, and recovery requirements are
part of the route contract, not optional implementation details.

### Audit event formats

The documented audit event schema, event meaning, integrity verification, and
correlation identifiers are stable. v1.x may add optional event types or
fields. Existing required fields will not be silently repurposed.

The physical journal encoding, file segmentation, key storage layout, and
internal TypeScript types are implementation details. A migration that must
re-establish integrity records a deliberate migration event.

### Workspace inspection

The documented `workspace.list`, `workspace.stat`, `workspace.search`,
`workspace.read`, and `workspace.diff` contracts are additive stable v1
interfaces. Portable relative-path confinement, configured sensitive-file
filtering, deterministic ordering, documented bounds, request-bound cursors,
cooperative cancellation, and content-free audit and ledger projections are
part of that contract. Host filesystem identity details and the internal
resolver algorithm remain platform-dependent implementation details.

`workspace.readText` remains a compatible text-read surface. Existing response
fields retain their meanings, and additive digest metadata is allowed. A
legacy tool-shaped capability grant remains scoped to `workspace.readText`; it
does not silently authorize the broader registry v1 `workspace.inspect`
surface.

### Provider adapter contracts

The normalized request, response, error-redaction, retry, usage, and diagnostic
contracts for first-class providers and the generic OpenAI-compatible adapter
are stable. Provider presets and support tiers live outside the kernel entry
module.

The first-class v1 provider paths are OpenAI / ChatGPT, OpenRouter, and Ollama.
Compatibility presets use the stable shared adapter but do not receive a
continuous live-service guarantee. Specialized paths labeled Experimental are
outside the stable provider promise. Arbitrary OpenAI-compatible endpoints are
supported through Custom compatibility mode. The current classifications are
listed in [AI provider support](provider-support.md) and exposed by
`odinn config provider catalog`.

Live model availability, pricing, quotas, rate limits, service behavior, OAuth
availability, and provider-specific output remain provider-dependent. Local
model installation, CLI adapters, and host acceleration may also be
platform-dependent.

### Extension manifests and packages

Extension manifests, Skill SDK packages, Agent SDK packages, third-party
packages, and MCP packages are experimental interfaces for v1. Registration or
discovery does not grant trust or execute code. Validation, integrity review,
explicit enablement, capability grants, and policy enforcement still fail
closed.

All repository packages and application packages currently marked `private`
are internal implementation details. They are not stable public SDKs merely
because source code or TypeScript exports are visible.

### Advanced services and experimental modules

Runemark, Gatewatch, Norn Restore, Norn Governance, and Raven Route are core
advanced runtime services and do not require feature flags. The existing Proof,
Sentinel, Rewind, and Darwin technical identifiers remain compatible. Their
documented CLI and gateway surfaces remain experimental interfaces unless another
row in this policy explicitly marks them stable; core placement is an
implementation and availability decision, not a public-SDK compatibility
promise.

Saga Archive, Rune Key, Worldtree Paths, Agent SDK packages, Skill SDK
packages, third-party extensions, MCP packages, multi-user hosting, and
unconfined process execution are optional experimental interfaces. The
existing Capsule, Capability Token, and Counterfactual technical identifiers
remain compatible. These surfaces remain outside normal v1 compatibility and
migration guarantees.

For configuration compatibility, old `experimental.proof`,
`experimental.sentinel`, `experimental.rewind`, and `experimental.darwin`
fields may still be read from existing files, but they no longer control
runtime availability. Only `capabilities`, `capsules`, and `counterfactual`
are normalized as optional runtime-plugin flags.

## Provider- and platform-dependent behavior

The compatibility promise covers Odinn's local validation, policy, redaction,
recovery, and normalized adapter behavior. It cannot guarantee that an external
provider, website, login flow, browser engine, or local model server remains
available or behaves identically.

Linux, macOS, and Windows remain supported CI platforms. A platform-specific
capability may depend on the operating system and installed software without
changing the cross-platform CLI and state contracts.

## Unsupported behavior

The following are explicitly unsupported:

- Using forked workers as hostile-code security sandboxes
- Exposing the single-user loopback gateway directly to a network
- Treating multi-user hosting as hostile-user operating-system isolation
- Guaranteed replay or rollback of external effects or nondeterministic
  provider behavior
- Bypassing approval, policy, audit, update verification, or state compatibility
  checks
- Relying on undocumented private packages, routes, files, or console DOM
- Assuming imported or generated code is trusted because it was discovered or
  registered

## Versioning and deprecation

v1.x releases preserve stable v1 interfaces while allowing additive behavior,
bug fixes, security fixes, provider maintenance, and internal refactoring.
Breaking a stable interface normally requires a new major version. When an
active security issue requires an incompatible restriction, Odinn may fail
closed in a minor or patch release and will document the exception.

Experimental interfaces may change without a major version. Provider- and
platform-dependent changes are documented when known but are not fully under
Odinn's control.

## Three hard limits

- Forked workers are crash containment, not a security sandbox.
- Remote hosting is application-level tenant isolation, not hostile-user OS
  isolation.
- External effects and nondeterministic provider behavior are outside full
  replay and rollback guarantees.
