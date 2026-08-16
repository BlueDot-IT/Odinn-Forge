# Post-1.1 roadmap

This roadmap separates post-1.1 work from the active 1.1 release candidate. It
does not promote experimental surfaces to stable or override the current
release freeze.

The repository is on the `1.1.0-rc.4` package line. This roadmap records work
around the release candidate and does not itself establish stable-release
evidence.

## Release gate first: stabilization

An independent review of the pre-roadmap `main` at
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
   downloaded-artifact verification across GitHub-hosted Linux, macOS, and
   Windows runners through the protected release workflow.

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
- Durable audit projections now hash non-opaque provider identifiers and fail
  closed on malformed identifiers before a concrete email provider can ship.
- The local console is now built as a separately validated Vite artifact with
  a manifest, hashed assets, no inline script/style, and a restrictive CSP.
- The hosted gateway now carries authenticated tenant scope through ingress,
  jobs, workflows, governed execution, and audit markers; tenant lifecycle
  suspension, membership-scoped administration, and bounded backups are
  covered by focused tests.

These changes have passed focused registry/graph tests, gateway and kernel
type checks, lint, formatting, architecture checks, and the relevant gateway,
memory, workspace, and host suites. They do not close the external artifact
verification or release-review gates below.

### Remaining 1.1 release gates

The stable-release decision remains **NO-GO** until the following evidence is
recorded:

- validate the extracted console through the exact downloaded candidate
  artifact and retain its manifest/CSP evidence;
- preserve durable review evidence for the security-sensitive merges;
- validate rollback with the actual prior binary and restored backup;
- build a fresh exact candidate from a clean tree and perform protected
  downloaded-asset verification across GitHub-hosted Linux, macOS, and Windows
  runners as a publication dependency; maintainer-owned physical machines
  remain supplemental;
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
3. **Runtime scope:** ✅ gateway composition-boundary tranche implemented for
   authenticated ingress claims, durable jobs, cron/event payloads, workflow
   principals, governed/isolated task execution, and audit markers. Complete
   the remaining direct store/API scope audit across approvals, agents,
   plugins, channels, secrets, and any future service boundaries.
4. **Multi-agent tenancy:** ✅ admitted graph and runtime-agent provenance are
   immutable; gateway execution carries tenant scope. Add tenant ownership to
   agent registries, graph admission, capabilities, approvals, quotas, and
   audit receipts everywhere outside the gateway boundary. Cross-tenant
   delegation remains denied by default.
5. **Lifecycle and operations:** ✅ bounded suspension, membership-scoped
   administration, and verified sensitive-state-excluding backups are
   implemented. Add tenant create/delete/export/restore/migrate workflows,
   fair scheduling, durable metering, multi-instance leases, and
   tenant-labelled observability.
6. **Isolation hardening:** use per-tenant secret storage and OS-user,
   container, or VM boundaries before claiming support for mutually hostile
   tenants. The current host is application-level isolation only.
7. **Product surfaces:** enable channels and provider routing only with
   tenant-owned accounts, credentials, webhook routing, and abuse controls.
8. **Promotion evidence:** add cross-tenant adversarial, path/race, restart,
   agent-delegation, noisy-neighbor, deletion, backup/restore, and load tests
   before promoting multi-tenancy from experimental to stable.

### Recommended first tranche

The first operational tranche is now implemented while retaining separate
per-tenant runtime state. The remaining work is cross-package scope closure,
full lifecycle operations, and isolation evidence; do not claim SaaS-grade or
hostile-tenant isolation before those gates exist.

## Current classifications

- Multi-user hosting: experimental interface.
- Multi-tenant hosting: experimental first tranche; no stable compatibility
  promise.
- Hostile-tenant isolation: unsupported until an OS/container/VM boundary and
  corresponding evidence exist.
