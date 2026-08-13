# Odinn Forge decomposition proposal

_Status: incremental migration in progress. Gateway authentication, process
bootstrap, and the embedded console have been extracted into separately
auditable modules. Transport-neutral application contracts now exist; runtime
use-case migration has begun with the read-only `status.read`,
`diagnostics.read`, and `session.list` paths. Discord agent-tool definitions and
REST behavior now live in the Discord adapter and are composed outside the
kernel._

## Evidence from the current tree

- `apps/gateway/src/server.ts` is the HTTP composition root. It owns request
  normalization, routing, and assembly of kernel services. Authentication and
  binding rules live in `security.ts`, process startup and state selection live
  in `bootstrap.ts`, and the large console document lives under `src/public/`.
- `apps/cli/src/cli.ts` is the command composition root. It owns command
  parsing, terminal-oriented output, onboarding, and lifecycle commands. The
  status, doctor, and session-list commands now cross `@odinn/application`;
  other commands still call the kernel directly.
- `packages/kernel/src/index.ts` exports the runtime service surface, including
  policy, approvals, jobs, memory, providers, state, extensions, and task
  execution. It accepts transport-neutral channel-tool definitions and keeps
  policy, capability, approval, audit, and uncertainty enforcement authoritative.
- `packages/channels/src/index.ts` and `packages/channels/src/plugin.ts` define
  shared channel contracts. `adapters/channels/*` own network concepts, schemas,
  validation, and protocol clients.
- `packages/runtime` composes the Discord adapter with the neutral kernel
  registry and provides the worker entrypoints used by both the gateway and
  CLI. The gateway and CLI still import the kernel directly for application
  paths that have not yet migrated.

This is a boundary problem, not evidence that the current runtime is unsafe:
transport, presentation, orchestration, and domain services are colocated in a
small product and can still be tested independently.

## Proposed target shape

```text
HTTP / CLI / channel ingress
          |
          +--> @odinn/application (migrated use cases and receipts)
          |
          +--> @odinn/runtime (host-owned adapter composition)
                         |
                         v
              @odinn/kernel (policy, state, task execution, audit)
                         |
                         +--> stores, providers, approval ports
```

### 1. Channel-neutral application boundary

`packages/application` now defines a small, serializable application boundary
with these concepts:

- `InboundEnvelope`: source, conversation/tenant scope, event id, timestamp,
  text or structured payload, and redacted metadata.
- `ExecutionRequest`: normalized operation and input, a trusted effective
  principal/scope context, source correlation, and requested response mode.
- `ExecutionResult` and `ExecutionReceipt`: output evidence, terminal status,
  authorization and audit references, correlation, and uncertainty/approval
  state.
- `StatusSnapshotV1`, `DiagnosticsReportV1`, and `SessionPageV1`: explicit,
  versioned read models with allowlisted fields, boundary validation, and
  redaction checks. CLI and gateway presenters no longer receive arbitrary
  kernel objects for the migrated read paths.
- `ChannelPort`: delivery capability that accepts an outbound envelope; it must
  not expose channel SDK objects to the kernel.

Inbound identity and scope values are explicitly claims. They confer no
authority. A trusted transport/authentication mapper must construct the
effective `ExecutionContext`; required capabilities, policy decisions,
approval validity, retry safety, and recovery semantics remain authoritative
kernel concerns. Provider and store ports will be introduced only alongside a
concrete use case so they remain capability- and scope-specific rather than
becoming generic bypasses.

The kernel should accept and return these boundary types only. Discord,
Telegram, Slack, HTTP request/response objects, and terminal streams stay in
adapters or composition roots. During migration, compatibility kernel calls
remain for operations that do not yet have an application use case.

### 2. Gateway decomposition

Keep `apps/gateway` as the process and HTTP adapter, then split responsibilities
behind explicit modules:

1. `gateway/transport`: HTTP routing, authentication, CORS/origin checks, and
   protocol serialization.
2. `gateway/application`: request-to-`ExecutionRequest` mapping, lifecycle
   assembly, and response mapping.
3. `gateway/runtime`: process startup, worker supervision, shutdown, and state
   directory setup.

The authenticated `GET /status`, `GET /diagnostics`, and `GET /sessions` routes
now construct a trusted principal and scope, invoke transport-neutral read use
cases, and map only their output to the stable HTTP responses. Session listing
continues through the existing isolated, policy-checked, audited kernel task
path behind its application port. Other routes remain incremental migration
targets. The gateway should depend on application ports, not on channel adapter
details.

### 3. CLI decomposition

Keep `apps/cli` as the terminal adapter and split:

1. `cli/commands`: argument parsing and command selection;
2. `cli/presentation`: human/JSON output and diagnostics;
3. `cli/application`: mapping command intent to application requests.

CLI commands should not construct gateway internals or encode channel-specific
behavior. Existing onboarding and lifecycle behavior must remain stable.

### 4. Kernel decomposition

Within `packages/kernel`, separate by capability rather than by transport:

- `domain`: policy, receipts, task state machines, approval decisions, and
  normalized boundary types;
- `application`: orchestration of use cases and audit evidence;
- `infrastructure`: provider/store adapters, filesystem state, browser/runtime
  workers, and migration code;
- `plugins`: optional capabilities with explicit activation and permissions.

This is an incremental target. Types, transport-facing ports, and the first
read-only use case now exist. Each later pull request will move one use case at
a time while preserving the current kernel exports as a compatibility facade.

## Migration sequence

1. **Complete:** add boundary types and contract tests without moving runtime
   code.
2. **In progress:** add gateway and CLI mapping modules that use the boundary
   types; both transports now map `status.read`, `diagnostics.read`, and
   `session.list` with authenticated server-side principal and scope.
3. **In progress:** move read-only use cases through the boundary. Status,
   diagnostics, and session listing now have explicit V1 output contracts; the
   remaining inspection surfaces are pending.
4. Move model execution and approval-bearing task execution with identical
   audit and failure semantics.
5. **In progress:** migrate channel adapters to the same inbound/outbound
   envelopes. Discord agent tools are adapter-owned and host-composed; inbound
   channel routing remains on the existing shared channel contracts.
6. **Complete for protected packages:** enforce dependency direction in CI.
   `packages/kernel` and `packages/application` have no channel-adapter or
   direct-adapter imports; application-to-app imports are also rejected.

## Invariants and stop conditions

- No channel SDK type or channel-adapter dependency crosses into
  `packages/kernel`.
- Approval, audit, persistence, and uncertainty semantics remain unchanged.
- Every external side effect remains behind an explicit port and existing
  authorization gate.
- The compatibility facade remains until all composition roots migrate.
- Stop if a migration requires a persistent-state change without a versioned
  migration and rollback fixture, or if a test only passes through a source
  import but fails from the compiled package.

## Out of scope

This proposal does not change CLI help text, operator documentation, public
product narrative, channel behavior, persistence schemas, release policy, or
credential handling. It is an architecture boundary plan for later, separately
reviewed implementation work.
