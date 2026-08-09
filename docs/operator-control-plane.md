# Unified operator control plane

Stage 13 gives Ódinn one bounded operator contract across the CLI, terminal
TUI, authenticated HTTP JSON API, and web console. The surfaces are adapters;
they do not maintain separate health or mutation semantics.

## Snapshot

`GET /operator/snapshot` (also `GET /operator`) returns schema version `1` with
these sections:

- `runtime` — active and disabled runtime surfaces;
- `work` — durable jobs and audited runs;
- `approvals` — pending one-time decisions;
- `automation` — workflows, event watches, and schedules;
- `context` — whether governed project context is available;
- `recovery` — browser, sandbox, and process recovery boundaries;
- `audit` — bounded journal verification and counts;
- `surfaces` — the available operator adapters.

Every section is bounded and paginated. Use `page`, `pageSize` (capped at 50),
`q`, and `status` query parameters; section-specific pages such as `workPage`,
`approvalsPage`, `automationPage`, and `recoveryPage` prevent one large
collection from hiding smaller sections. Snapshot projections contain
identifiers, statuses, counts, timestamps, digests, and bounded effect summaries
only. Prompts, message content, credentials, headers, raw tool input, and raw
tool results are not part of the contract.

The HTTP route retains the gateway's bearer/cookie authentication and mutation
origin checks. A web-console request can set `surface=console`; API clients
normally use `surface=http`.

## Actions

`POST /operator/actions` accepts:

```json
{"action":"cancel-job","targetId":"job-id","confirm":true}
```

Supported actions are `cancel-job`, `approve`, `deny-approval`,
`cancel-workflow`, `resume-workflow`, and `verify-audit`. Mutations require
`confirm: true` and remain behind the existing supervisor, approval, workflow,
audit, and recovery boundaries. Approval projections include a code-generated,
bounded effect summary; the operator projection never executes a tool directly.
A denied approval also settles its linked job or leaves an explicit recovery
record if that settlement cannot be completed.

## Surfaces

- `odinn operator snapshot` emits the same JSON contract locally.
- `odinn operator action ... --confirm` performs local durable cancellation,
  workflow control, or audit verification. Approval execution requires a live
  authenticated gateway and can be sent with `--gateway-url`.
- `odinn tui` renders the same snapshot as a compact terminal dashboard.
  `odinn tui --watch` exits cleanly on SIGINT/SIGTERM and performs no browser or
  network work.
- The authenticated web console's **Operator** page reads the same endpoint
  and sends actions through `/operator/actions`.

The CLI also accepts `odinn inspect` as a short alias for the snapshot command.
All four surfaces remain local-first. Remote use requires the normal gateway
authentication and explicit operator choice.

## Failure and privacy rules

An unhealthy audit chain, pending approval, failed job, uncertain job, or
unresolved recovery record raises the snapshot attention count. The snapshot
is still returned so the operator can diagnose the boundary. Unknown or
uncertain external outcomes are not converted into success and are never
silently replayed by an operator view.

The shared projection performs a second bounded redaction pass before data is
returned or rendered. It treats authority-shaped keys, credentials, cookies,
headers, prompts, content, and results as non-displayable data. The control
plane is an inspection and governed-action surface, not a raw state browser.
