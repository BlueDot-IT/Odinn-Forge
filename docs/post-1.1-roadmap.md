# Post-1.1 roadmap

This roadmap separates post-1.1 work from the active 1.1 release candidate. It
does not promote experimental surfaces to stable or override the current
release freeze.

## Release gate first: stabilization

An independent review of `main` at
`85b7ded1b0c9a0238443beb49b5b2eb124d27e5b` rated the project 8.6/10 and
returned **NO-GO for stable 1.1**. The review reported no critical or
high-severity vulnerability, but identified state-integrity, provenance, and
release-process work that must be triaged before another stable-release
decision:

1. Replace competing agent-registry writers with one locked registry store;
   ordinary main-agent loading must be read-only.
2. Bind admitted agent graphs to immutable agent, manifest, identity, prompt,
   model, and version digests.
3. Deep-snapshot and freeze graph inputs before calculating digests or
   dispatching nodes.
4. Correct the schema-v8 rollback documentation and validate rollback using
   the actual previous binary and backup path.
5. Make runtime-agent installation crash-consistent with staging, journaling,
   reconciliation, and fault-injection coverage.
6. Require opaque provider identifiers before shipping a concrete email
   adapter.
7. Freeze feature work, resolve or formally amend the console-extraction
   release criterion, preserve durable review evidence, and perform exact
   downloaded-artifact acceptance on clean Linux, macOS, and Windows systems.

### Stabilization tranche implemented in the current candidate work

The current implementation tranche addresses the first state-integrity risks
with focused tests:

- `AgentRegistryStore` is the shared locked read-modify-write boundary;
  ordinary loads are read-only after first-run bootstrap.
- Runtime-agent installation stages complete directories, journals swaps, and
  reconciles interrupted transactions before publishing registry state.
- Graph admission snapshots and freezes child inputs, binds agent version,
  manifest, identity, prompt, and model digests, and fences dispatch if the
  live definition no longer matches.
- Rollback documentation now states the actual backup-first boundary for
  incompatible SQLite migrations.

These changes have passed focused registry/graph tests, gateway and kernel
type checks, lint, formatting, architecture checks, and the relevant gateway,
memory, workspace, and host suites. They do not close the external artifact
acceptance or release-review gates below.

### Remaining 1.1 release gates

The stable-release decision remains **NO-GO** until the following evidence is
recorded:

- complete or formally amend the Vite console-extraction criterion;
- preserve durable review evidence for the security-sensitive merges;
- validate rollback with the actual prior binary and restored backup;
- build a fresh exact candidate from a clean tree and perform downloaded-asset
  acceptance on clean Linux, macOS, and Windows systems;
- require opaque provider identifiers before shipping a concrete email adapter.

## Multi-tenant structure

Multi-tenancy is a **post-stabilization roadmap item**, not a 1.1 release
blocker. The experimental TLS host now has the first control-plane tranche:
durable users, tenants, memberships, roles, service-account records, tenant
selection, revocable restart-persistent sessions, membership-derived scope,
separate per-tenant runtime state, and state/workspace overlap checks. The
documented boundary remains application-level, not hostile-user
operating-system isolation.

### Target sequence

1. **Control plane:** ✅ first tranche implemented. Durable `Tenant`, `User`,
   `Membership`, `Role`, and service-account records separate user identity
   from tenant identity, so one user can belong to multiple tenants.
2. **Authentication and authorization:** ✅ first tranche implemented with
   durable revocable sessions, membership-derived tenant scope, and checked
   tenant selection. An identity-provider integration remains future work;
   tenant IDs supplied by clients never grant authority.
3. **Runtime scope:** require tenant context across records, jobs, workflows,
   approvals, audit, agents, plugins, channels, secrets, and API contracts.
   Keep the existing per-tenant state boundary initially rather than rushing
   into a shared database.
4. **Multi-agent tenancy:** bind agents, graphs, capabilities, approvals,
   quotas, and audit receipts to the tenant. Cross-tenant delegation is denied
   by default and requires a separately designed broker if ever needed.
5. **Lifecycle and operations:** implement tenant create, suspend, export,
   backup, restore, delete, migrate, fair scheduling, durable metering,
   multi-instance leases, and tenant-labelled observability.
6. **Isolation hardening:** use per-tenant secret storage and OS-user,
   container, or VM boundaries before claiming support for mutually hostile
   tenants. The current host is application-level isolation only.
7. **Product surfaces:** enable channels and provider routing only with
   tenant-owned accounts, credentials, webhook routing, and abuse controls.
8. **Promotion evidence:** add cross-tenant adversarial, path/race, restart,
   agent-delegation, noisy-neighbor, deletion, backup/restore, and load tests
   before promoting multi-tenancy from experimental to stable.

### Recommended first tranche

The first tranche is now implemented while retaining separate per-tenant
runtime state. The next tranche is runtime-wide tenant scoping and lifecycle
operations; do not claim SaaS-grade or hostile-tenant isolation before the
security and operational evidence exists.

## Current classifications

- Multi-user hosting: experimental interface.
- Multi-tenant hosting: experimental first tranche; no stable compatibility
  promise.
- Hostile-tenant isolation: unsupported until an OS/container/VM boundary and
  corresponding evidence exist.
