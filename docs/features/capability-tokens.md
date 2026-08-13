# Rune Key — Scoped temporary access

Rune Key is Ódinn Forge's optional scoped-access plugin module. The existing
`capability` CLI command, `experimental.capabilities` configuration key,
gateway routes, and SDK names remain compatibility identifiers. Each key binds
one short-lived operation to a run, step, tool, resource constraints, and a use
count. The signing key is local-only with restrictive permissions. Raw
credentials are never placed in token claims, ledger payloads, or normal CLI
output.

```bash
odinn config experimental enable capabilities --confirm-impact
odinn capability issue --run <run-id> --step <step-id> --tool github.create --scope pull_request:create
odinn capability list <run-id>
odinn capability revoke <capability-id>
```

The broker validates signature, expiration, run/tool binding, resource constraints, revocation, and replay count before recording a use.

Approval-required tools use a two-phase continuation protocol. The first leg
validates the key and its exact resource scope without consuming it, creates an
operation-bound approval, and seals the exact execution input outside public
approval views. After the operator claims that approval, the continuation
resumes the original awaiting-approval run with the original actor, tool, and
sealed input. The kernel independently recovers and verifies that claimed
binding; a request field or transport boolean cannot assert continuation
authority. The kernel atomically consumes the one-use approval before
readmission, so concurrent processes cannot share the awaiting attempt. Only
that winner can validate and atomically consume the same key immediately
before dispatch. A
changed run, actor, tool, resource, input, expired or revoked
key, duplicate approval, or replay cannot create a second dispatch. This model
does not mint a broader approval capability and does not relax ordinary run
binding; it delays the existing one-use consumption until the approved leg.
Generic recovery cannot restart an awaiting-approval first leg. If a process
stops after claiming an approval continuation, its durable job lease prevents
another process from dispatching it; an expired unfinished lease is classified
as needs-review instead of being replayed. A crash between consuming the
approval and consuming the Rune Key therefore fails closed and may leave the
key unused, but never authorizes an automatic duplicate dispatch.

Enabling this optional plugin module changes direct CLI execution immediately:
ordinary tool runs require a matching scoped token after capability enforcement is
active. Issue the token first, or disable the feature before returning to normal
manual runs. Worldtree Paths read-only execution issues its own one-use key.
