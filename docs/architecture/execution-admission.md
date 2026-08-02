# Execution Admission Architecture

## Baseline

- Program baseline: `fa91e44c1185b549da5854cdec365176bdd55ced`
- Program branch: `program/critical-capabilities`
- The separate `docs/features-index-hub` documentation changes are outside this implementation slice.

## State authorities

| State | Authority | Current location | Direction |
| --- | --- | --- | --- |
| Runs, steps, verification, execution intent | Run ledger | `db/odinn.sqlite` | Add execution envelopes, attempts, cancellation controls, and later execution graphs. |
| Operator audit | Audit store | `db/audit.sqlite` with legacy JSONL compatibility | Remains authoritative; correlate by immutable run and audit IDs. |
| Projects, sessions, goals, messages, memory | Authoritative record store | `db/records.sqlite` | Remains authoritative. |
| Runtime jobs | File job store | `jobs.json` | Migrate occurrences into the run ledger after admission parity exists. |
| Cron definitions | Gateway cron store | `cron-jobs.json` | Definitions may remain compatible; every occurrence will bind to an envelope. |

## Execution entry points at the accepted baseline

| Entry point | Current path | Current authority boundary | Admission status |
| --- | --- | --- | --- |
| Gateway task submission | `apps/gateway/src/server.ts` -> isolated task worker -> `runTask` | Gateway policy/config, worker-local ledger/audit | Active through `ExecutionAdmissionService`; job queue convergence remains pending. |
| CLI task | `apps/cli/src/cli.ts` -> `runTask` or isolated browser worker | CLI-created policy, ledger, audit | Active through the same service as Gateway. |
| CLI plan | `apps/cli/src/cli.ts` -> `runPlan` | Parent plan plus admitted task steps | Executable steps are active and parent-correlated; a first-class workflow envelope remains pending. |
| Cron occurrence | Gateway `CronStore` -> `JobSupervisor` -> isolated task worker | Cron definition plus `jobs.json` lease | Dispatched tasks are admitted; occurrence/lease migration into SQLite remains pending. |
| Agent tool call | `agent.run` -> `runTool` -> `runTask` | Parent task context and policy | Active with parent-run correlation; capability intersection is Stage 2 work. |
| Browser work | Persistent isolated browser worker | Browser policy plus recovery JSON | Active before browser tool execution; browser recovery remains authoritative for browser uncertainty. |
| Extension execution | Container extension executor | Extension registry and policy | Reuse as an execution backend behind admission. |
| Experimental graphs, skills, MCP, automation | Kernel foundations | Default-inert feature flags | Activation must dispatch through admission; no parallel runtime. |

## Binding decisions

1. `ExecutionEnvelopeV1` is trusted runtime data, not model-authored authority.
2. The envelope is immutable after admission and stores references and digests, never raw prompts, results, secrets, approval tokens, or live cancellation signals.
3. Idempotency is scoped by principal and key and is bound to the full canonical envelope digest.
4. Mutable attempts and cancellation controls are stored separately from immutable intent.
5. The shared `runTask` compatibility surface delegates to the kernel-owned `ExecutionAdmissionService`; callers do not maintain a second admission path.
6. No execution backend may silently degrade to unconfined host execution.

## First implementation slice

Runtime schema v4 adds:

- `execution_envelopes`
- `execution_attempts`
- `cancellation_controls`

The protocol package owns strict parsing, duplicate-field rejection, exact-field validation, canonical serialization, and SHA-256 content binding.

## Live admission cutover

The following paths now use the shared admission service when a run ledger is present:

- Gateway `/run` and `/run/stream`
- CLI `run` and record-tool commands
- Browser and isolated task workers
- Plan steps, correlated to the parent plan run
- Nested `agent.run` tool calls, correlated to the parent agent run
- Cron occurrences whose durable job payload dispatches a task

Admission occurs after the base policy decision and before capability-token checks or tool execution. One atomic run-ledger transaction persists the immutable envelope, creates and moves the attempt from `queued` to `running`, and appends the `execution-admitted` ledger event. The service then commits the authoritative `execution.admitted` signed audit event before backend dispatch. If that audit commit fails, dispatch is blocked and the running attempt is settled as `failed` with `AUDIT_CORRELATION_FAILED`.

Policy denial creates no executable envelope. Completed work settles the attempt with the result-artifact digest. Cancelled non-retry-safe, non-pure work becomes `needs-review`; it is never silently replayed.

Ledger-less custom callers still pass through the same application service but cannot claim durable admission. Normal Gateway and CLI execution supply the ledger. Runtime job leases remain in `jobs.json` pending the dedicated job-state migration.

`pnpm benchmark:assurance` enforces the 10 ms p95 gate on the atomic execution-envelope ledger transaction. It separately reports complete admission with the authoritative signed audit commit. That second store uses `synchronous=FULL` and remains observational; its durability is not reduced for latency cosmetics.
