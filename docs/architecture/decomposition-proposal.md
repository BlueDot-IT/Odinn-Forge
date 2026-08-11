# Odinn Forge decomposition proposal

_Status: incremental migration in progress. Gateway authentication, process
bootstrap, and the embedded console have been extracted into separately
auditable modules; route and runtime-service decomposition remains._

## Evidence from the current tree

- `apps/gateway/src/server.ts` is the HTTP composition root. It owns request
  normalization, routing, and assembly of kernel services. Authentication and
  binding rules live in `security.ts`, process startup and state selection live
  in `bootstrap.ts`, and the large console document lives under `src/public/`.
- `apps/cli/src/cli.ts` is the command composition root. It owns command
  parsing, terminal-oriented output, onboarding, and lifecycle commands while
  calling the kernel directly.
- `packages/kernel/src/index.ts` exports the runtime service surface, including
  policy, approvals, jobs, memory, providers, state, extensions, and task
  execution.
- `packages/channels/src/index.ts` and `adapters/channels/*` provide external
  channel/provider adapters, but the current gateway and CLI composition roots
  still import the kernel directly.

This is a boundary problem, not evidence that the current runtime is unsafe:
transport, presentation, orchestration, and domain services are colocated in a
small product and can still be tested independently.

## Proposed target shape

```text
channel adapters / HTTP / CLI
          |
          v
@odinn/application (composition-neutral use cases and receipts)
          |
          v
@odinn/kernel (policy, state, task execution, audit, providers)
          |
          +--> stores, provider ports, approval ports
```

### 1. Channel-neutral kernel boundary

Introduce a small, serializable application boundary with these concepts:

- `InboundEnvelope`: source, conversation/tenant scope, event id, timestamp,
  text or structured payload, and redacted metadata.
- `ExecutionRequest`: normalized objective, input, principal namespace, source
  correlation id, and requested response mode.
- `ExecutionResult`: output reference, terminal status, audit reference,
  correlation id, and uncertainty/approval state.
- `ChannelPort`: delivery capability that accepts an outbound envelope; it must
  not expose channel SDK objects to the kernel.
- `ProviderPort` and `StorePort`: narrow ports for model calls and persistence;
  implementations remain outside the domain policy code.

The kernel should accept and return these boundary types only. Discord,
Telegram, Slack, HTTP request/response objects, and terminal streams stay in
adapters or composition roots.

### 2. Gateway decomposition

Keep `apps/gateway` as the process and HTTP adapter, then split responsibilities
behind explicit modules:

1. `gateway/transport`: HTTP routing, authentication, CORS/origin checks, and
   protocol serialization.
2. `gateway/application`: request-to-`ExecutionRequest` mapping, lifecycle
   assembly, and response mapping.
3. `gateway/runtime`: process startup, worker supervision, shutdown, and state
   directory setup.

The gateway should depend on application ports, not on channel adapter details.

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

This is an incremental target. The first extraction should be types and ports,
then one use case at a time, with the current kernel exports preserved as a
compatibility facade during migration.

## Migration sequence

1. Add boundary types and contract tests without moving runtime code.
2. Add gateway and CLI mapping modules that use the boundary types.
3. Move one read-only status/diagnostics use case through the boundary.
4. Move model execution and approval-bearing task execution with identical
   audit and failure semantics.
5. Migrate channel adapters to the same inbound/outbound envelopes.
6. Deprecate direct transport imports from kernel modules after import-graph
   checks prove the dependency direction.

## Invariants and stop conditions

- No channel SDK type crosses into `packages/kernel`.
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
