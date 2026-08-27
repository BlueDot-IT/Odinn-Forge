# Odinn Forge Experimental Runtime Threat Model

## Trust boundaries

- The operator and local filesystem are trusted inputs only where explicitly configured.
- Models, imported contracts, policies, extension metadata, capsule contents, and tool output are untrusted.
- External services and browser sessions are untrusted, stateful side effects.

## Controls

- The default gateway is loopback-only. Cookie-authenticated mutations require an exact scheme/host/port Origin and reject missing Origin; bearer clients are authenticated separately. Remote deployments use a separate TLS-only host with exact-origin enforcement, throttled authentication, signed revocable sessions, and per-tenant gateway/state/workspace/browser boundaries.
- Unknown tools default to irreversible, approval-required safety descriptors.
- Paths are canonicalized and symlink escapes are rejected for Runemark verification and snapshots.
- Runemark commands are denied by default and require an exact operator-owned argument-vector allowlist; approved commands use no shell, a minimal environment, bounded output, and process-tree termination.
- HTTP request bodies cannot replace the gateway's authoritative workspace. Internal alternate roots must be validated descendants of the assigned workspace.
- Ledger payloads and artifact evidence are redacted and bounded.
- Gatewatch decisions are deterministic and persisted before execution.
- Capability tokens are signed, short-lived, run/step/tool bound, scoped, revocable, and replay-limited.
- Capsule extraction rejects traversal and absolute paths.
- The gateway rejects hostile `Host` headers before issuing its bootstrap cookie.
- Public web fetch validates all DNS answers and uses a validated address for the connection; redirects are revalidated and oversized responses are terminated immediately under an absolute deadline.
- Remote-node reads use exact operator-owned HTTPS authorities and literal IP
  allowlists, never runtime DNS or a model-selected URL. TLS verifies the
  configured authority while the socket is pinned to a configured address;
  authentication is environment-reference-only, redirects and remote error
  bodies are refused, response schemas contain only fixed enums and counts,
  and durable evidence is content-free.
- Browser traffic is forced through a loopback egress proxy that validates every DNS answer and connects to a pinned public address. Playwright request and WebSocket routing enforce domain policy, and service workers are disabled.
- Workspace inspection accepts only portable workspace-relative paths and does
  not follow symlinks, junctions, or hard-linked regular files. Content access
  rejects those targets, special files, ambiguous platform paths, and
  configured sensitive-file patterns. The resolver validates target and
  ancestor identities before and after open or enumeration. Linux also checks
  the opened descriptor through `/proc/self/fd`. The portable Node.js
  pre/open/post checks detect tested replacement races but do not claim a
  single kernel-atomic resolver or complete ABA-race exclusion on macOS or
  Windows.
- Workspace listing and literal search are deterministically ordered, bounded
  by entry/depth/byte/result ceilings, ignore-aware, cursor-bound to the request
  and policy, and cooperatively cancellable. File contents, search query text,
  matching lines, supplied baselines, and rendered diffs are projected to
  bounded digest-and-count metadata before audit or run-ledger persistence.
- Job shutdown sets a stopping barrier before aborting work, preventing retry/requeue races. Only tools explicitly classified as safe and idempotent may retry; unsafe interrupted work requires operator review.
- State directories and records are repaired to owner-only permissions; restores reject symlinks, hardlinks, and special files before copying; run IDs and job idempotency keys are bound to canonical request digests.
- Signed audit appends and job-state mutations use token-owned interprocess locks so forked workers cannot create sibling successors from one previous state. Locks are never reclaimed automatically: after a timeout, Odinn fails closed. An operator may remove a stale lock only after verifying that no Odinn process is using that store; automatic age- or PID-based deletion can race a new owner.
- Browser mutations are journaled before execution. Unknown outcomes block further mutation until explicitly resolved.
- Extensions and MCP adapters execute through the audited Gatewatch/Rune Key boundary; direct extension execution is rejected. Third-party extensions use the container adapter with a whole-bundle digest, read-only mount, no network, dropped capabilities, no-new-privileges, and CPU/memory/PID/filesystem limits. Explicit `unconfined-process` extensions remain trusted-code-only.
- Full capsule replay requires a disposable workspace, complete non-redacted inputs, an audited executor, and explicit approval for external effects.

## Residual risk

No local runtime can reverse sent email, purchases, or arbitrary remote mutations. Browser sessions and imported credentials remain high-value secrets. An explicitly allowed remote-node address can expose a private service if the operator misconfigures the origin, address allowlist, certificate trust, or responder; the two fixed authenticated schemas reduce but do not remove that operator trust. Workspace inspection reduces accidental disclosure and detects known link and replacement races; it is not hostile-code containment, a data-loss-prevention system, or a substitute for operating-system permissions. Content returned during an agent run may be sent to the configured model provider even though audit and ledger persistence is content-free. The planned Stage 4 sandbox backend remains the hard boundary for untrusted execution. `unconfined-process` extensions still run as the Odinn operating-system user: capability grants authorize invocation, not filesystem or network confinement. Full deterministic replay of remote services and nondeterministic models is not claimed. The multi-user host rejects overlapping workspaces, reloads user disablement without restart, evicts idle tenant gateways, strips untrusted proxy headers, refuses shared GitHub and remote-node credentials, and enforces storage, active-job, browser-action, model-call, and model-token quotas. It remains application-level tenant isolation, not kernel containment; mutually hostile tenants require separate operating-system users or containers.
