# Runtime ledger

This is the implementation ledger for Ódinn Forge. A checked item has code
and regression coverage. The default remains local and single-user; remote
multi-user operation is an explicit TLS-only host mode. Use the [surface
matrix](surface-matrix.md) and [v1 compatibility
policy](v1-compatibility.md) for the authoritative classifications:
**Stable v1 interface**, **Internal implementation detail**,
**Experimental interface**, **Provider-dependent behavior**,
**Platform-dependent behavior**, and **Unsupported behavior**.

The three hard limits are:

- Forked workers are crash containment, not a security sandbox.
- Remote hosting is application-level tenant isolation, not hostile-user OS isolation.
- External effects and nondeterministic provider behavior are outside full replay/rollback guarantees.

## Current state

- [x] Unified execution admission is active for the shared `runTask` spine. Gateway run and streaming requests, CLI runs, browser workers, plan steps, and nested agent tool calls persist strict immutable `ExecutionEnvelopeV1` records before execution, with mutable attempts and cancellation controls stored separately. Policy denial remains pre-admission, and cancelled non-retry-safe effects settle as `needs-review`. See [Execution admission architecture](architecture/execution-admission.md).
- [x] Runtime jobs, owner/epoch-fenced active leases, portable legacy-import provenance, envelope/attempt bindings, cancellation correlation, and restart reconciliation live in runtime SQLite schema v5. `jobs.json` is a one-time validated import source retained as rollback evidence; Gateway no longer writes it. Cron definitions retain their compatibility store, while each occurrence uses one admitted job/run identity. Exact inputs changed by persistence redaction remain volatile and fail closed after restart rather than replaying placeholders.
- [x] Stage 7 durable child-agent graphs use additive runtime SQLite graph state (extended in schema v8 for bounded concurrency). The explicit `config.runtime.enableAgentGraphs` gate exposes up to eight read-only child nodes (four concurrent) through durable `/jobs`; manifests bind to enabled installed runtime identities and are intersected with the parent capability set, child prompts and provider output are projected to digests, graph/node state is journaled before dispatch, and missing terminal audit or restart proof becomes `needs-review` rather than replaying the child.
- [x] Stage 10 durable workflows use versioned, digest-bound definitions, persisted token-and-time-fenced step leases/checkpoints, caller-renewed live leases, idempotent submission, and scheduled fail-closed restart recovery. Parallel terminal failure first enters a durable `stopping` state, aborts and fences siblings, and reaches `failed` or `needs-review` only after active ownership settles or its bounded stop deadline expires. Cancellation and shutdown use the same bounded uncertain-outcome discipline. Retry-safe restart work may requeue; effectful uncertainty becomes `needs-review`. The explicit `config.runtime.enableDurableWorkflows` gate exposes `/workflows`.
- [x] Stage 11 event ingress and heartbeat candidates use authenticated source identities, monotonic cursors, deterministic idempotency keys, bounded declarations, token-fenced renewable dispatch leases, scheduled live expiry recovery, shutdown quarantine, durable delivery state, and explicit `config.runtime.enableEventIngress` activation. Expired or interrupted effectful dispatch remains `needs-review`, and candidates still require the existing durable job/admission boundary.
- [x] Stage 12 project context uses authoritative project/session scope, bounded deterministic memory retrieval, optional freshness-bound indexing, provenance, and digest-only durable projections behind `config.runtime.enableProjectContext`.
- [x] Five bounded workspace inspection tools provide deterministic listing,
  metadata, literal search, UTF-8-safe reads, and text diffs under the trusted
  `workspace.inspect` mapping. They enforce portable relative paths,
  sensitive-file and ignore rules, traversal/read/result ceilings,
  request-bound cursors, cooperative cancellation, and content-free audit and
  ledger projections. Portable pre/open/post identity checks detect tested
  replacement races without claiming atomic macOS/Windows ABA exclusion;
  the planned Stage 4 sandbox remains the hard boundary for untrusted
  execution.

- [x] Durable queued jobs with persisted state, cancellation, timeouts, restart recovery, content-bound idempotent submission, and graceful supervisor shutdown. Retries require an explicit safe/idempotent tool descriptor; interrupted unsafe work stops in `needs-review` instead of replaying an unknown external outcome.
- [x] Forked crash-containment workers for every gateway-submitted task. These workers retain the parent OS identity, environment, filesystem, and network authority and are not described as a security sandbox; the local CLI remains an explicitly local operator path.
- [x] Extension manifests with type, version, digest, provenance, sandbox declaration, capability grants, enable/disable, and rollback. Installed extensions remain disabled and untrusted by default.
- [x] Extension/MCP execution adapters. Container extensions require a whole-bundle digest and execute with read-only mounts, no network, dropped capabilities, no-new-privileges, CPU/memory/PID/tmpfs limits, and bounded output. Trusted `unconfined-process` extensions still require an entrypoint digest and explicit unsafe acknowledgement. Both cross the audited Gatewatch/Rune Key boundary. Stage 9 MCP manifests use a response-gated JSON-RPC `initialize`/`tools/list`/`tools/call` JSONL subset; approved invocation continuation resumes the original awaiting-approval run with sealed exact input, while remote URLs and unconfined MCP remain unavailable.
- [x] Provider retries for transient failures, rate-limit backoff, generic chat SSE normalization, OAuth refresh path, and provider transport tests.
- [x] Provider catalog conformance contract across every preset, generic chat/Responses/SSE/tool-call fixtures, retry behavior, and canonical token accounting. Live provider-account and provider-specific service behavior remains an external release test, not a fake local green check.
- [x] Loopback-only gateway default, strict localhost/127.0.0.1/[::1] Host validation, per-state bearer token, browser bootstrap cookie, exact scheme/host/port checks for cookie-authenticated mutations, missing-Origin rejection for cookie mutations, request limits, content-bound idempotency keys, graceful shutdown, and reconnectable audit SSE.
- [x] Opt-in remote multi-user host with mandatory TLS/public-origin configuration for non-loopback binds, scrypt password verification, login throttling, signed revocable sessions, logout, and separate state/workspace/gateway/browser boundaries per tenant.
- [x] Browser approval gate, DNS-pinned local egress proxy, request/WebSocket interception, blocked service workers, domain/private-network policy, input redaction, and stale snapshot checks when an action is based on a snapshot.
- [x] Durable approval transactions survive restart and duplicate approval claims idempotently; job-backed approval claims and terminal results settle the original job/attempt, pre-claim cancellation revokes the approval, and post-claim cancellation remains explicitly in flight. Persistent tab handles recover after restart. Browser mutations use a pre-action recovery journal and block subsequent mutations until interrupted/unknown outcomes are explicitly resolved.
- [x] Store schema versions, atomic job writes, explicit corruption recovery, owner-only state permissions, atomic replacement restore with symlink/hardlink/special-file rejection, and persisted task output for replay.
- [x] Audit-journal key rotation and cross-process append serialization. Signed journal records retain retired verification keys; `odinn audit rotate-key` rotates the active key and `odinn audit verify` validates the single signed chain. Legacy unsigned records are reported and can be rejected without silently rewriting history.
- [x] Packaged gateway/provider smoke, onboarding smoke, checksums, SBOM/provenance workflow hooks, and cross-platform package tests.
- [x] Compiled production archives with versioned POSIX/PowerShell installers,
  atomic current/previous pointers, tested application rollback, bundled runtime
  dependencies, onboarding, gateway diagnostics, and CLI release smoke without
  a workspace dependency installation.
- [x] Structured audit events, run timelines, persisted output, replay endpoint, provider failure tests, and failure categorization for task lifecycle.

## Core advanced services and optional plugin modules

The core advanced services are available without feature flags:

- [x] One gateway Runemark verification path with strict schema validation, exact operator-controlled command allowlists, minimal command environments, process-tree termination, file assertions, metadata-only persisted assertion results by default, operator-opt-in redacted evidence artifacts, and verified/failed run transitions. Legacy arbitrary-command assertions are rejected.
- [x] Gatewatch policy validation and pre-operation invariant decisions for denied commands, allowed roots, and approval-required tools.
- [x] Norn Restore snapshots with content-addressed file artifacts, dry-run previews, symlink rejection, bounded capture, exact selected-root restoration, and an automatic pre-restore recovery snapshot.
- [x] Raven Route observations, automatic configured-model routing, Runemark promotion, transparent routing scores, uncertainty penalties, and human-readable selection reasons.

The optional runtime plugin modules remain disabled by default:

- [x] Capability tokens with local signing keys, expiry, run/step/tool binding, resource constraints, revocation, and one-use enforcement.
- [x] Saga Archive bundles with redaction, ZIP path validation, checksums, verification-only contract metadata, tool-mocked durable boundary replay, tamper detection, and full replay through the audited executor in disposable workspaces. External effects require explicit approval and redacted inputs remain fail-closed.
- [x] Worldtree Paths workspace copies with independent runs, bounded task execution through the audited tool boundary, optional shared Runemark checks, candidate comparison, and dry-run/apply branch selection with source backup. Irreversible external actions remain approval-gated and full remote rollback is not claimed.

The private kernel plugin boundary exposes a descriptor, configuration key,
enabled state, and service factory for each of those three modules. It is an
internal composition boundary, not a stable third-party plugin SDK. Existing
runtime service properties remain as compatibility aliases to the loaded
module services.

These slices do not claim to reverse arbitrary remote mutations or make
nondeterministic model and remote-service results deterministic. Built-in tools
and extension/MCP adapters route through the shared audited execution boundary;
direct extension execution is rejected. Forked workers are crash containment,
not a security sandbox. Remote hosting is application-level tenant isolation,
not hostile-user OS isolation. External effects and nondeterministic provider
behavior are outside full replay/rollback guarantees. See the [surface
matrix](surface-matrix.md) for the complete surface classification.

The self-improvement loop runs automatically by default. It applies only allowlisted reliability tuning, captures a rollback snapshot, and cannot widen permissions, disable safeguards, change credentials, install extensions, or weaken Gatewatch.

## Required release proof

The normal CI integration test launches the source gateway, configures an
OpenAI-compatible provider endpoint, calls the gateway, and verifies the
response is present in the persisted run record. The separate production
package smoke exercises the compiled gateway/provider path. Neither calls a
cloud provider or pretends a local protocol fixture is production-model
validation.

The cross-platform CI matrix runs the CLI onboarding smoke on Linux, macOS, and Windows. The smoke uses a fresh state directory and completes without credentials; provider-specific auth remains an explicit onboarding path.

Package integrity CI builds and extracts both production archives without
running pnpm in the extracted tree. It installs the compiled application,
checks its version, completes onboarding, runs a real CLI tool, starts the
gateway, verifies diagnostics, stops it cleanly, and reopens persisted state.
Native installer integration tests separately prove immutable version
installation, atomic current/previous pointer changes, and application
rollback.

The single-user gateway remains loopback-only. Remote operation must use the TLS-only multi-user host. Extension manifests remain untrusted until explicitly enabled and grant-scoped.
