# Odinn Forge plugin system

_Status: design baseline plus the first shipped host-capability seam._

This document defines the boundary for plugins that give Ódinn Forge access to
the browser, a local desktop, or external services such as email. The browser
host-capability seam, conditional `computer.screen` node-host contract,
conditional read-only email provider contract, and authenticated two-tool
remote-node read contract are shipped; computer mutation and a concrete email
provider remain design targets until their adapters and security tests land.

## Decision summary

Forge already has three useful foundations:

- the built-in tool registry in `packages/kernel/src/index.ts`;
- the capability and safety registry in `packages/policy/src/capabilities.ts`;
- the disabled-by-default, integrity-checked extension and MCP path in
  `packages/kernel/src/extensions.ts` and `packages/kernel/src/mcp-runtime.ts`.

The plugin system should extend those boundaries rather than create a second
execution path.

The target model has two planes:

```text
manifest / catalog / setup / enablement
                |
                v
       host-owned admission and policy
                |
       +--------+---------+
       |                  |
  host adapter       OCI/MCP adapter
  (Forge-owned)      (third-party code)
       |                  |
       +--------+---------+
                v
       audited tool result / receipt
```

The host owns tool identity, capability declarations, approval semantics,
resource binding, audit projections, and recovery. A plugin supplies an
implementation behind that contract; it never creates authority by declaring
an arbitrary capability or by returning a token to the host.

## What we borrow, and what we do not

### OpenClaw patterns worth borrowing

OpenClaw's plugin boundary separates manifest-first discovery from runtime
activation. Its scoped guidance and source show the useful pieces:

- `openclaw.plugin.json` carries metadata, activation, config, and contract
  information before runtime code is loaded;
- the loader builds a registry and the SDK exposes narrow registration methods
  such as `registerTool`, `registerService`, and node-host commands;
- browser and computer plugins keep registration light and lazy-load heavy
  runtime code (`extensions/browser/plugin-registration.ts` and
  `extensions/cua-computer/index.ts`);
- dangerous computer input is routed through a separate node-host command and
  an explicit policy gate (`computer.act`).

Forge should copy the separation of control plane, runtime plane, metadata,
and lazy activation. It should not copy an assumption that arbitrary
third-party JavaScript is safe merely because it was loaded as a plugin.

### Hermes patterns worth borrowing

Hermes provides several practical ergonomics:

- `tools/registry.py` keeps schemas, handlers, availability checks, and
  toolset membership together;
- tool modules self-register, while `model_tools.py` remains a thin
  orchestration layer;
- `check_fn` availability probes and lazy dependencies keep unavailable tools
  out of the model context;
- `hermes_cli/plugins.py` discovers `plugin.yaml` manifests and controls
  enabled plugin loading;
- browser, computer-use, and email implementations are separate tool/plugin
  surfaces rather than special cases in the agent loop.

Forge should copy the single registry, availability metadata, tool grouping,
and lazy dependency ideas. Import-time self-registration is not an authority
boundary, so untrusted Forge plugins must not gain access to the trusted kernel
by importing a module and calling a global registry.

## Plugin kinds

The first tranche uses four explicit kinds:

| Kind | Code location | Trust model | Example |
| --- | --- | --- | --- |
| `host-capability` | Forge-owned adapter package | trusted, reviewed, shipped with Forge | browser, desktop node bridge |
| `provider` | Forge-owned or separately reviewed adapter | narrow host port plus opaque secret reference | Gmail, Microsoft Graph, IMAP |
| `mcp` | third-party bundle | disabled, trusted, digest-pinned OCI execution | user-selected service connector |
| `skill` | reference material | untrusted text; no authority | email triage instructions |

The existing `ExtensionRegistry` is the lifecycle and integrity primitive for
`mcp` and `skill`. A future host-capability/provider SDK must not bypass it for
installed third-party code.

## Manifest and tool contract

The manifest is metadata. It is read during catalog, setup, and doctor flows;
those flows must not execute plugin runtime code.

Illustrative shape:

```json
{
  "schemaVersion": 1,
  "id": "email-gmail",
  "version": "0.1.0",
  "kind": "provider",
  "displayName": "Gmail",
  "runtime": "host-adapter",
  "activation": { "enabledByDefault": false },
  "tools": [
    {
      "name": "email.search",
      "capabilities": ["email.read"],
      "requiresApproval": false,
      "retrySafe": false
    },
    {
      "name": "email.send",
      "capabilities": ["email.send"],
      "requiresApproval": true,
      "retrySafe": false,
      "idempotency": "required"
    }
  ],
  "configSchemaRef": "email.account.v1"
}
```

Every executable tool definition must provide:

- a stable, namespaced tool name;
- a bounded input schema with `additionalProperties: false` where practical;
- host-recognized capability IDs;
- a host-recognized safety descriptor: effects, reversibility, approval, and
  retry behavior;
- a bounded availability/health probe that returns metadata, not secrets;
- a resource-binding function for approval and capability-token scope;
- a durable-output projection that removes raw credentials, message bodies,
  cookies, access tokens, and provider exception text where the surface does
  not need them.

The plugin cannot supply a new capability ID at runtime. Adding a capability
is a versioned Forge policy change in `@odinn/policy`, with migration,
Gatewatch, and sibling-tool tests.

## Initial capability map

### Browser control

Browser read and mutation already exist as core Forge tools:

- read: `browser.tabs`, `browser.open`, `browser.snapshot`, and recovery
  inspection;
- mutation: `browser.click`, `browser.type`, `browser.press`, and recovery
  resolution.

The first plugin task is therefore an adapter seam around the existing browser
service, not another browser tool with a competing tab/session model. That seam
is implemented by `packages/kernel/src/plugins/browser.ts` and materialized
into the existing kernel registry. The existing browser profile, URL
validation, private-network policy, stale snapshot checks, approval
continuation, and uncertain-outcome recovery remain the source of truth.

Provider-specific browser backends may be added later behind that seam, but a
plugin must not receive the user's ordinary browser cookies by default.

### Computer use

Computer use is a different authority class from browser control. The initial
host contract exposes two tools:

- `computer.screen` — read-only screenshot/display metadata;
- `computer.act` — click, type, key, pointer, scroll, and bounded wait.

The shipped `computer.screen` contract uses `computer.read` and becomes
available only when the host supplies a paired, target-bound node provider. It
does not include an OS capture backend or pairing UI. `computer.act` must:

1. bind coordinates to the exact frame ID returned by `computer.screen`;
2. route through a paired host/node broker rather than an arbitrary child
   process;
3. require explicit approval for input actions by default;
4. return an after-action frame or a categorical uncertain-outcome result;
5. never accept a raw driver path, shell command, or ambient desktop session
   from model input.

The provider target and pairing generation are host-owned resource bindings,
not model-selected input. Live pixels may be returned to the requesting model,
but durable audit/ledger projections retain only frame metadata and an image
digest; completed-run replay cannot recreate the pixels. Registry activation
also requires explicit `enableComputerScreen` opt-in.

This follows the useful OpenClaw split between a model-facing computer tool,
screen capture, and a dangerous node-host command while keeping Forge's
execution admission and audit ledger authoritative.

### Remote-node status

The shipped remote-node host capability is deliberately separate from
computer use. It exposes only `node.status` and `node.diagnostics`, with exact
`{ nodeId }` input, the `node.read`/network/credential-reference capability
intersection, and no approval because both operations are pure reads. The
operator owns the exact HTTPS authority, literal pinned-address allowlist, and
environment credential reference. Paths and response schemas are fixed by the
kernel; neither plugin metadata nor model input can add an endpoint or return
logs and arbitrary content. See
[Authenticated remote-node reads](../remote-node-read.md).

### Email

Email should begin read-only and provider-neutral:

- `email.accounts` — list configured account labels and health state;
- `email.search` — bounded query, account-scoped;
- `email.read` — fetch one message by opaque provider/message reference;
- `email.thread` — fetch a bounded thread projection.

Mutation tools come only after the read path is stable:

- `email.draft` — create or update a provider-side draft;
- `email.send` — send a fully specified message;
- `email.archive` / `email.label` — change mailbox state.

Reads should not require approval, but they still require an explicit account
grant and network capability. Drafts and all mailbox mutations require
approval. `email.send` additionally requires an idempotency key bound to the
account, recipient set, subject/body digest, and attachment digests. A timeout
or lost response is `needs-review`, never an automatic retry.

OAuth refresh tokens, IMAP passwords, cookies, raw authorization headers, and
message bodies must not enter manifests, model-visible tool schemas, ordinary
audit events, or durable approval projections. Providers receive an opaque
host-managed secret reference through a narrow port. The adapter owns token
refresh and redaction; the plugin never receives the Forge state-directory key.

The shipped read seams are implemented by `packages/kernel/src/email.ts`,
`packages/kernel/src/calendar.ts`, and their host-capability plugins. They are
provider-neutral and activate only with an explicit provider. Provider identity
and generation, together with the selected account and resource identifiers,
bind the execution resource; read results are live-only and durable
audit/ledger projections retain bounded counts, sizes, and digests rather than
message bodies, snippets, subjects, addresses, event bodies, attendees, or
locations.

The first concrete adapter is the optional, read-only Microsoft Graph slice.
It is disabled by default, binds one explicit account and selected email and/or
calendar resources, uses an environment-only token reference, and permits only
bounded `GET` requests beneath the fixed Graph origin. It installs no mutation
surface and is rejected by the TLS multi-user host. See
[Bounded Microsoft Graph reads](../microsoft-graph-read.md).

## Activation and lifecycle

All optional plugins follow the same state machine:

```text
discovered -> reviewed -> enabled -> healthy -> available
                    \-> rejected/disabled
available -> degraded -> needs-review/disabled
```

Required invariants:

- discovery is metadata-only and deterministic;
- install does not enable; enable does not grant capabilities implicitly;
- enabling binds a version/digest and explicit grants;
- a changed manifest, bundle, provider account binding, or tool schema blocks
  execution until the operator reviews the new identity;
- health failure hides the affected tools from the model or returns a visible,
  actionable unavailable result;
- disable/rollback removes registry contributions and closes provider/browser
  sessions without deleting user data.

The host should borrow OpenClaw's light/heavy entrypoint split and Hermes's
availability checks, but store the final activation decision in Forge's
audited state rather than relying on process-global import order.

## Security and approval boundary

The following are non-negotiable for every plugin:

1. **No ambient authority.** Plugin input is data; it does not choose a
   command, endpoint, account, secret, filesystem root, or node.
2. **Admission before execution.** Capability policy, Gatewatch, approval
   continuation, input bounds, and execution envelopes run before the adapter.
3. **Exact approval binding.** Approval binds the normalized request and its
   resource identity. Adding a confirmation flag cannot change the approved
   action.
4. **Safe durable projections.** Audit, ledger, job, and public operator views
   retain digests, identities, categorical status, and bounded summaries—not
   raw secrets or unrestricted provider payloads.
5. **Uncertain external effects stop.** Browser, desktop, and email mutations
   are not automatically replayed after cancellation, timeout, crash, or lost
   provider response.
6. **Plugin failure is visible.** A failed health check or unavailable
   dependency produces a reason and recovery hint; it must not silently remove
   tools from a running agent without diagnostics.

## Delivery sequence

1. **Contract slice (shipped):** add manifest-first plugin metadata and
   fail-closed host tool materialization/registration with contract tests.
   Keep capability and safety authority in the host policy registry.
2. **Browser adapter seam (shipped):** model the current browser manager as a
   host-capability provider and prove registry/approval/recovery behavior is
   unchanged.
3. **Computer read path (contract shipped):** add a paired-node screen broker
   and `computer.screen` only. Validate frame identity, image bounds, cleanup,
   and operator status. Forge activates the tool only when that provider is
   supplied; it does not use ambient desktop access as a fallback.
4. **Computer mutation path:** add `computer.act` with approval, after-frame,
   timeout, and needs-review recovery semantics.
5. **Email/calendar read path (shipped, experimental):** the Microsoft Graph
   adapter provides one-account, credential-reference-only, bounded reads
   without sending mail or mutating calendars. Live tenant behavior remains
   provider-dependent.
6. **Email mutation path:** add drafts and send only after the provider's
   idempotency and uncertain-outcome behavior have live-tested evidence.
7. **Third-party connector path:** expose the narrow provider/MCP contract to
   external authors after the host adapter and secret broker have contract
   tests. No arbitrary in-process plugin loading before that gate.

## Explicit non-goals for this tranche

- taking over the user's everyday browser profile;
- arbitrary desktop shell access disguised as computer use;
- passing OAuth tokens or passwords through MCP arguments or environment;
- letting a plugin define its own approval, capability, or audit semantics;
- implementing every email provider at once;
- adding a second tool-dispatch loop beside `runTask` and
  `ExecutionAdmissionService`.
