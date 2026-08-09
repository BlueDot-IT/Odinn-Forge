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
| Runtime jobs, leases, and graph/node state | Run ledger | `db/odinn.sqlite` schema v7 | `runtime_jobs` and the additive `agent_graph_*` tables are live authority; a validated `jobs.json` is imported once and retained as rollback evidence. |
| Cron definitions | Gateway cron store | `cron-jobs.json` | Definitions may remain compatible; every occurrence will bind to an envelope. |

## Execution entry points at the accepted baseline

| Entry point | Current path | Current authority boundary | Admission status |
| --- | --- | --- | --- |
| Gateway task submission | `apps/gateway/src/server.ts` -> SQLite job supervisor -> isolated task worker -> `runTask` | Gateway policy/config, shared ledger/audit | Active through `ExecutionAdmissionService`; job, envelope, attempt, cancellation, and audit identities are correlated. |
| CLI task | `apps/cli/src/cli.ts` -> `runTask` or isolated browser worker | CLI-created policy, ledger, audit | Active through the same service as Gateway. |
| CLI plan | `apps/cli/src/cli.ts` -> `runPlan` | Parent plan plus admitted task steps | Executable steps are active and parent-correlated; a first-class workflow envelope remains pending. |
| Cron occurrence | Gateway `CronStore` -> `JobSupervisor` -> isolated task worker | Compatible cron definition plus SQLite occurrence/lease | Every occurrence uses one job/run ID and binds to an admitted envelope and attempt. |
| Agent tool call | `agent.run` -> `runTool` -> `runTask` | Parent task context and policy | Active with parent-run correlation and parent-child capability intersection. |
| Browser work | Persistent isolated browser worker | Browser policy plus recovery JSON | Active before browser tool execution; browser recovery remains authoritative for browser uncertainty. |
| Extension execution | Container extension executor | Extension registry and policy | Reuse as an execution backend behind admission. |
| Agent graphs | Kernel graph dispatcher | Explicit `config.runtime.enableAgentGraphs` plus durable `/jobs` | Stage 7 activates one read-only node through admission, isolated workers, runtime SQLite graph/node state, and signed audit correlation. The broader graph, skills, MCP, and automation foundations remain default-inert. |

## Binding decisions

1. `ExecutionEnvelopeV1` is trusted runtime data, not model-authored authority.
2. The envelope is immutable after admission and stores references and digests, never raw prompts, results, secrets, approval tokens, or live cancellation signals. Its input digest is the digest of the redacted input artifact named by `inputReference`, not a separately persisted fingerprint of raw input.
3. Idempotency is scoped by principal and key and is bound to the full canonical envelope digest.
4. Mutable attempts and cancellation controls are stored separately from immutable intent.
5. The shared `runTask` compatibility surface delegates to the kernel-owned `ExecutionAdmissionService`; callers do not maintain a second admission path.
6. No execution backend may silently degrade to unconfined host execution.

## First implementation slice

Runtime schema v4 adds:

- `execution_envelopes`
- `execution_attempts`
- `cancellation_controls`

Runtime schema v5 adds:

- `runtime_jobs`
- `runtime_job_leases`
- `runtime_job_imports`

Runtime schema v7 adds:

- `agent_graph_runs`
- `agent_graph_nodes`
- `agent_graph_edges`

The first graph profile persists validated graph/manifest digests and bounded
byte metadata, plus one queued node, before dispatch. A node that has crossed the child dispatch boundary is never
automatically replayed after worker loss; startup reconciliation moves the
parent job and graph/node projection to `needs-review` when the terminal audit
or physical outcome is not provable.

Every dispatch receives a token bound to a supervisor owner and process epoch. The owner renews the lease while the physical worker remains live; reconciliation ignores unexpired leases, and terminal writes present the expected token so a stale worker cannot settle a recovered generation. Lease expiry includes a settlement grace beyond the execution timeout.

The protocol package owns strict parsing, duplicate-field rejection, exact-field validation, canonical serialization, and SHA-256 content binding.

## Live admission cutover

The following paths now use the shared admission service when a run ledger is present:

- Gateway `/run` and `/run/stream`
- CLI `run` and record-tool commands
- Browser and isolated task workers
- Plan steps, correlated to the parent plan run
- Nested `agent.run` tool calls, correlated to the parent agent run
- Cron occurrences whose durable job payload dispatches a task

Admission occurs after the base policy decision and before capability-token checks or tool execution. One atomic run-ledger transaction persists the immutable envelope and creates a `queued` attempt. The service then commits the authoritative `execution.admitted` signed audit event with the envelope digest, attempt ID, audit correlation ID, and cancellation reference. A signed `task.started` event is committed before a compare-and-set transition marks the attempt `running` immediately at the backend dispatch boundary. If admission audit fails, dispatch is blocked and the queued attempt settles as `failed` with `AUDIT_CORRELATION_FAILED`.

Policy denial creates no executable envelope. Completed work settles the attempt with the result-artifact digest. Approval requests remain `awaiting-approval` rather than claiming execution completed. Cancelled non-retry-safe, non-pure work becomes `needs-review`; it is never silently replayed. If terminal audit persistence fails after an effectful backend returns, ledger settlement still runs and the attempt becomes `needs-review`.

Ledger-less custom callers still pass through the same application service but cannot claim durable admission. Normal Gateway and CLI execution supply the ledger. Gateway runtime jobs and lease history now live in SQLite. Restart reconciliation keeps queued and approval-pending work nonterminal, mirrors already-settled attempts, reuses a queued attempt that never crossed the backend boundary, creates a fresh attempt only for trusted retry-safe recovery, and quarantines interrupted effectful work as `needs-review`. A request bound before its envelope transaction is safely admitted for the first time after restart. Ordinary idempotency replay cannot enter the trusted recovery path.

Job payloads use the shared persistence redactor. The first live dispatch receives the original payload only from supervisor memory. When redaction changes a field, SQLite records that the durable projection is insufficient for replay; if the process restarts before dispatch completes, the job fails closed and must be resubmitted with fresh input. This prevents browser typing values and credential-shaped data from becoming a recovery store.

## Capability admission and preview

Capability registry v1 replaces tool-shaped global grants with precise,
versioned authority. Every built-in executable tool is finalized from the
trusted registry. Unknown identifiers and missing or conflicting declarations
fail closed. Legacy grants migrate to exact tool scopes with a report and no
automatic widening. Parent/child agent requests are intersected with trusted
tool declarations before dispatch; Skill and MCP declarations never grant
authority.

Gatewatch exposes the same capability and invariant decision inputs through
the CLI, authenticated loopback API, and operator console. Preview is pure and
returns `executes: false`; it does not create a run, audit event, execution
envelope, or attempt. Live admission remains authoritative at dispatch time.

The bounded workspace inspection tools preserve live content for the immediate
caller while projecting only content-free metadata into audit events and run
ledger artifacts. Search queries and provided diff baselines become SHA-256
digests plus byte counts; read content, matching-line text, and rendered diffs
are omitted. Output projections retain normalized paths, bounds, counts,
truncation state, and digests needed for correlation without turning the
durable execution record into a copy of inspected workspace data.

Approval execution is correlated back to the originating job and attempt. Claiming an approval atomically moves the original attempt from `awaiting-approval` to `running`; a definitive result settles it, while failure or uncertain interruption becomes `needs-review`. Cancelling before claim revokes the pending approval. Cancelling after claim returns `cancelling` until the in-flight approved action reaches a terminal projection.

`pnpm benchmark:assurance` enforces the 10 ms p95 gate on the atomic execution-envelope ledger transaction. It separately reports complete admission with the authoritative signed audit commit. That second store uses `synchronous=FULL` and remains observational; its durability is not reduced for latency cosmetics.

`pnpm benchmark:recovery` seeds 10,000 mixed job/attempt records, closes and reopens the database, performs the indexed reconciliation transaction, verifies exact classification counts, and enforces a five-second cold-start gate.
