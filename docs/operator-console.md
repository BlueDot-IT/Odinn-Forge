# Operator console

The local console at `http://127.0.0.1:18790/` is an authenticated view over the single-user gateway. Loading `/` over a loopback listener sets the HttpOnly bootstrap cookie. Scripts should read the owner-only `.odinn/gateway.token` and use bearer authentication instead. A gateway bound to a wildcard or non-loopback address never issues the bootstrap cookie; remote clients must use a pre-provisioned bearer token, or operators must deploy the authenticated multi-user host with TLS. Cookie-authenticated mutations require an exact scheme, host, and port Origin. The [v1 compatibility policy](v1-compatibility.md) and [surface matrix](surface-matrix.md) distinguish **Stable v1 interfaces**, **Internal implementation details**, **Experimental interfaces**, **Provider-dependent behavior**, **Platform-dependent behavior**, and **Unsupported behavior**.

The three hard limits are:

- Forked workers are crash containment, not a security sandbox.
- Remote hosting is application-level tenant isolation, not hostile-user OS isolation.
- External effects and nondeterministic provider behavior are outside full replay/rollback guarantees.

## Projects, sessions, goals, and activity

Projects group related sessions and goals through `/projects`. Sessions default to the built-in Workspace project and can be reassigned. Goals must belong to a project or a specific session; session-scoped goals also inherit that session's project. Sessions remain durable conversation records exposed through `/sessions` and `/sessions/<id>`.

The Activity page combines the usage overview and searchable history in two tabs over the same signed audit journal. It reports distinct run IDs, completed `model.chat`/`agent.run` executions, recorded token counts, and semantic failed-or-denied outcomes. The overview shows only the four latest model conversations. Activity is operational telemetry, not a provider invoice.

## Operator page and shared control plane

The **Operator** page is the web-console adapter for the same bounded contract
used by `odinn operator snapshot`, `odinn inspect`, and the terminal TUI. It
combines runtime surfaces, durable work, approvals, automation, context,
recovery, audit verification, and the other available operator surfaces in one
redacted projection. The JSON source is `GET /operator/snapshot`; use `page`,
`pageSize`, `q`, and `status` to keep inspection bounded.

Operator mutations use `POST /operator/actions` and retain the gateway's
authentication and origin checks. Cancel job, approve, cancel/resume workflow,
and verify-audit actions route through the existing supervisor, approval,
workflow, and audit paths. The page does not expose raw prompts, credentials,
headers, tool input, or tool results. Pending or uncertain work remains visible
as attention rather than being treated as completed.

## Cron Jobs

Cron Jobs are stored in `.odinn/cron-jobs.json` and evaluated by the running gateway every 30 seconds. `/cron` creates and lists jobs; `/cron/<id>` updates or deletes them; `/cron/<id>/run` starts one immediately. Each scheduled occurrence is durably keyed as `cron:<job-id>:<scheduled ISO timestamp>` before dispatch. A second gateway process, a polling race, or a restart reuses that key rather than creating a second occurrence. A dispatch lease expires only after the bounded recovery window; an expired lease is reconciled against the same occurrence key.

Cron expressions contain five fields with standard minute (0-59), hour (0-23), day (1-31), month (1-12), and weekday (0-6, Sunday 0) ranges. Positive steps, lists, and ranges are accepted; step `0`, negative values, out-of-range values, impossible day/month combinations, and invalid IANA timezones are rejected at admission. Each job has an explicit IANA timezone, tool, and JSON input. Treat creation or editing as a privileged control-plane mutation.

Cron state uses schema v2. On upgrade, Odinn creates the normal protected migration backup before the v1-to-v2 migration. Existing valid definitions and unknown fields are preserved; invalid legacy definitions fail before cutover with the original state untouched. `nextRunAt` is initialized lazily, and each occurrence persists its scheduled timestamp and dispatch lease before execution. Rollback to a pre-v2 binary is refused because it cannot safely read occurrence metadata; restore the protected pre-migration backup with `odinn state restore` before using that binary. Do not hand-edit a lease or occurrence key. A job left uncertain after process loss remains in the durable job store for review and is not silently replayed.

## Tasks, Runemark verification, and activity history

Tasks is the operator view over meaningful user, agent, and automation runs. Routine console reads are hidden unless **System activity** is enabled. Server-side search, filtering, and pagination keep the list bounded. Operators can select tasks, stop active supervised jobs, and run tasks again only when recorded input is declared retry-safe. The replay endpoint enforces the same classification server-side; external effects and nondeterministic provider behavior are outside full replay/rollback guarantees.

The History tab in Activity provides server-side search, type/tool/actor/outcome/date filtering, pagination, JSON export, and integrity verification. Runemark is a core advanced service; command assertions still require exact operator-owned argument-vector allowlisting through the compatibility `proof` configuration key. Chain verification detects journal damage; it does not make a local journal tamper-proof against an attacker who controls the state directory.

Runtime errors return a stable request correlation ID in the `x-odinn-request-id`
header and JSON body. Audit entries retain run, task/step, provider-attempt,
approval, and browser-recovery identifiers where applicable. Use `odinn doctor`
or `GET /diagnostics` for a redacted health snapshot rather than collecting the
raw state directory.

## Advanced

Advanced is a collapsible navigation group, not a landing page. Run Checks,
Safety Preview, Restore Points, Controlled Workspace Governance, and Smart Routing
are core capabilities. Controlled Workspace Governance introduces bounded
workspace mutate, patch, and restore workflows that separate preview and apply so
apply stays intentionally behind an explicit review step. The page shows digest
and conflict summaries, including needs-review signals, when returned. Temporary
Access, Portable Runs, and Compare Approaches are optional plugin modules. Each
has a dedicated guided workflow, while developer input and raw endpoint details
stay collapsed under Advanced options.

Restore apply is bound to the exact manifest digest returned by its preview;
missing or mismatched digests are rejected. Legacy `rewind` routes use the same
governed admission, capability, audit, locking, and recovery path. Startup
reconciliation verifies checkpoint manifest bytes and blocks new governed
mutations while an unresolved `needs-review` boundary remains.

Legacy `/checkpoints` creation and `odinn checkpoint create` also enter the
governed admission path and require an explicit `restore.create` capability;
the gateway always binds capture to its configured workspace root. A legacy
snapshot apply records a durable mutation boundary so interruption becomes
`needs-review` rather than silently publishing an uncertain restore.

The three plugin-module flags remain off by default. A disabled plugin stays
locked. Destructive operations remain explicit, and restore or comparison
selection defaults to a preview. Plugin configuration changes require an
intentional edit or `odinn experimental enable <feature> --confirm-impact`
followed by a gateway restart.

Automatic improvements has its own page and runs by default. It uses the configured model for plain-language assessment and applies only reversible, allowlisted reliability adjustments.

## Agent SDK packages

**Experimental interface.** Agent SDK packages are not stable public v1 SDKs.

The Agent SDK page manages declarative Agent SDK v0.3 manifests through `/agents`, `/agents/validate`, and `/agents/<id>/lifecycle`. Installation validates and records package metadata; lifecycle controls enable, disable, or quarantine a package. This surface is a package registry and inspector, not an Agent SDK execution engine. Package metadata is not executable trust, and registration does not bypass extension, sandbox, capability, network, secret, or policy controls.

Agent package state is stored in `.odinn/agents.json`. Keep package instructions and integrity metadata reviewable before enablement.

## Skills SDK packages

**Experimental interface.** Skill SDK packages are not stable public v1 SDKs.

The Skills SDK page is one Skill SDK v0.1 package registry and builder. `/skills/validate` validates the manifest and rendered `SKILL.md`; `/skills` installs it into managed storage only when `enableSkillLifecycle` and the explicit `skill.manage` policy grant are active; `/skills/<id>/verify` checks persisted integrity; and `/skills/<id>/lifecycle` performs audited, conditional disable/quarantine or creates a digest-bound one-time approval for enablement. New packages are disabled and untrusted. Secret or network declarations cannot be activated in this first slice.

The registry also discovers existing workspace and imported `SKILL.md` files as unmanaged packages. Discovery does not silently install, trust, enable, inject, or execute them. Managed package state lives under `.odinn/skills/`; workshop writes are service-owned compatibility staging and are disabled with the lifecycle flag.

## Memory

Memory automatically extracts durable candidates from conversations and recalls accepted context when relevant. Candidates remain pending until the user keeps or dismisses them in the Memory page; keeping one can use the suggested scope, make it global, or place it in one project. Saved memories may be global, project-scoped, or session-scoped. Edits supersede prior records rather than rewriting history, and forgetting appends a deactivation record so the memory immediately stops participating in search and recall. Automatic suggestion, recall, compaction, and user decisions remain gated by `memory.read`/`memory.write` and the concrete tool policy; `agent.run` routes them through the normal audited boundary.

## Remote hosting

The console may be reached through the dedicated TLS multi-user host. Each tenant receives a separate gateway, state root, workspace, browser profile, and quota boundary. Remote hosting is application-level tenant isolation, not hostile-user OS isolation. Mutually hostile users require separate operating-system users, containers, or machines.
