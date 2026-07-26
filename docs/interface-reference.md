# Interface reference

This reference describes the primary user-facing external interfaces for the
stable local, single-user workflow: the command-line interface and documented
routes on the authenticated loopback gateway. The
[v1 compatibility policy](v1-compatibility.md) is authoritative for stability,
versioning, state schemas, audit formats, and provider contracts. The
[surface matrix](surface-matrix.md) identifies experimental, internal,
provider-dependent, platform-dependent, and unsupported surfaces.

## Command-line interface

Run these commands from an installed release:

```bash
odinn help
odinn help --all
```

`odinn help --all` is the authoritative input reference for command names,
subcommands, parameters, and options in the installed version. Stable commands
accept `--state <directory>` where shown. Commands that return records,
configuration, diagnostics, or lifecycle results write JSON to standard output.
Interactive commands such as `odinn onboard`, `odinn start`, and `odinn tui`
write human-readable progress or open a user interface. Errors write a
credential-redacted message to standard error and return a nonzero exit code;
success returns `0`. Human-readable wording is not an automation interface.

The stable command groups are:

| Purpose | Inputs | Output |
| --- | --- | --- |
| Setup and runtime | `odinn onboard`, `odinn start`, `odinn status`, `odinn doctor` with the options shown by `odinn help --all` | Guided setup or console startup; status and diagnostics return structured state with secrets redacted |
| Provider and security configuration | `odinn config provider ...`, `odinn config model ...`, `odinn config security ...` | The saved or current configuration and validation errors |
| Application lifecycle | `odinn update check`, `odinn update`, `odinn rollback`, `odinn backup`, `odinn restore`, `odinn uninstall` | JSON describing the inspected release, verification result, state action, final version, or refusal reason |
| Persistent state | `odinn state status`, `odinn state backup`, `odinn state restore`, `odinn state migrate --dry-run` | JSON describing schema versions, paths, checksums, migration plans, backups, or compatibility blockers |
| Sessions, goals, and memory | `odinn session ...`, `odinn sessions`, `odinn goal ...`, `odinn memory ...` | JSON records or collections; create/update commands include the resulting event or record identifier |
| Runs and audit | `odinn run ...`, `odinn runs`, `odinn show`, `odinn audit`, `odinn audit verify` | JSON task results, run events, redacted history, or integrity-verification results |
| Plans | `odinn plan` | The JSON execution result for the submitted task plan |

Commands under `odinn experimental` control optional plugin modules. Runemark,
Gatewatch, Norn Restore, and Raven Route are always-available core advanced
services. Their existing `proof`, `policy`, `checkpoint`/`rewind`, and
`routing` commands remain the compatibility interface. Neither core placement
nor appearance in CLI help promotes an advanced surface to a stable public
SDK. Consult the [surface matrix](surface-matrix.md) before automating these
services, plugin modules, extensions, Agent SDK, or Skill SDK surfaces.

## Loopback gateway

The single-user gateway listens on `http://127.0.0.1:18790/` by default.
Loading `GET /` creates an HttpOnly, SameSite bootstrap cookie for the console.
Scripts should instead read the owner-only `gateway.token` file inside the
configured state directory (`.odinn/gateway.token` by default) and send:

```http
Authorization: Bearer <gateway token>
```

JSON requests use `Content-Type: application/json`. Identifiers in route paths
must be URL-encoded. Cookie-authenticated mutations require an exact matching
scheme, host, port, and `Origin`. Bearer-authenticated mutations may omit
`Origin`; when they provide one, it must match the exact loopback origin. Every
response includes `x-odinn-request-id`. Successful JSON responses use a `2xx`
status. JSON failures include at least:

```json
{
  "ok": false,
  "error": "redacted error message safe to display or log"
}
```

Handled application errors may also include `category`, `nextAction`, and
`requestId` in the JSON body. Callers should use the `x-odinn-request-id` header
as the consistent correlation identifier.

New optional response fields may be added in v1.x. Callers must not depend on
HTML structure, CSS selectors, undocumented routes, undocumented private files,
or physical store layouts. The documented `gateway.token` file is the supported
exception for local script authentication.

The tables below summarize accepted fields and response shapes; they are not
formal JSON Schema definitions.

### System and configuration routes

| Method and path | Input | Output |
| --- | --- | --- |
| `GET /config` | No body | `{ ok, config, restartRequired, ... }` with editable configuration and metadata |
| `PUT /config` | `{ config, fingerprint }`, using the current 64-character fingerprint from `GET /config` | `{ ok, config, fingerprint, restartRequired }`; stale fingerprints return `409` without overwriting newer configuration |
| `GET /status` | No body | Version, absolute state/workspace paths, configured models/providers, tools, capabilities, security policy, core advanced services, optional plugin flags, and pending approvals |
| `GET /diagnostics` | No body | A credential-redacted health and configuration report |

### Project, session, and goal routes

| Method and path | Input | Output |
| --- | --- | --- |
| `GET /projects` | Optional `includeArchived=true` | `{ projects, defaultProjectId }`; each project includes session and goal counts |
| `POST /projects` | `{ name, description?, tags?, id? }` | The created project event and identifier |
| `PATCH /projects/:id` | `{ name?, description?, status? }` | The project update event |
| `GET /sessions` | Optional `projectId` and `limit` | `{ sessions }` |
| `POST /sessions` | `{ title?, projectId?, tags? }` | The created session event and identifier |
| `GET /sessions/:id` | No body | `{ session, messages }` |
| `PATCH /sessions/:id` | `{ title?, projectId? }` | The update event plus the updated session |
| `DELETE /sessions/:id` | No body | The session deletion event |
| `POST /sessions/:id/messages` | `{ content, role?, provider?, model? }`; `role` defaults to `user` | The appended message event and identifier |
| `GET /goals` | Optional `projectId`, `sessionId`, `status`, and `limit` | `{ goals }` |
| `POST /goals` | `{ title, description?, tags?, projectId?, sessionId? }` | The created goal event and identifier |
| `POST /goals/:id/updates` | `{ status?, title?, description?, note? }` | The goal update event |

### Memory routes

| Method and path | Input | Output |
| --- | --- | --- |
| `GET /memory` | Optional `query`, `kind`, `subject`, scope fields, and `limit` | Matching memory records |
| `GET /memory/recall` | `query` plus optional `kind`, `projectId`, `sessionId`, and `limit` | Ranked recalled records |
| `GET /memory/browse` | Optional `namespace` and `limit` | Records in the selected namespace |
| `GET /memory/:id` | Memory identifier in the path | The selected record; unknown identifiers return an error |
| `POST /memory` | Memory text, kind, subject, namespace, tags, and optional scope fields | The appended memory record |
| `POST /memory/corrections` | Target identifier plus replacement text and optional metadata | The superseding correction record |
| `POST /memory/:id/forget` | Optional reason metadata | The deactivation record |
| `POST /memory/compact` | `{ sessionId }` | The generated session summary record |

### Work, schedules, approvals, and audit routes

| Method and path | Input | Output |
| --- | --- | --- |
| `POST /run` | `{ tool, input, id?, actor?, reason? }` | The completed audited task result |
| `POST /plan` | A plan with ordered task steps and optional identifier | The isolated plan result |
| `GET /runs` | No body | Recorded run summaries |
| `GET /runs/:id` | Run identifier in the path | The run and its recorded events |
| `POST /runs/:id/replay` | Optional `{ id }` or `Idempotency-Key` | A new result only when recorded input is declared retry-safe |
| `GET /jobs` | No body | `{ jobs }` for queued, running, or completed supervised work |
| `POST /jobs` | A task or `{ task, id?, timeoutMs? }` | `202 { ok, job }`; a repeated matching idempotency key returns the existing job |
| `GET /jobs/:id` | Job identifier in the path | The job record |
| `POST /jobs/:id/cancel` | No body | `{ ok, job }` with the cancellation state |
| `GET /cron` | No body | `{ enabled, jobs, nextWake }` |
| `POST /cron` | `{ name?, schedule, timezone?, tool, input?, enabled? }` | `{ ok, job }` for the created schedule |
| `PATCH /cron/:id` | Any mutable schedule fields | `{ ok, job }` for the updated schedule |
| `DELETE /cron/:id` | No body | `{ ok: true }` |
| `POST /cron/:id/run` | No body | `{ ok, result }` for the immediate audited run |
| `GET /tasks` | Optional `q`, `status`, `category`, `page`, `pageSize`, and `includeSystem` | `{ tasks, summary, pagination }` |
| `GET /tasks/:id` | Task identifier in the path | `{ task, run, job, ledger }` |
| `GET /approvals` | No body | Pending approval records |
| `POST /approvals/:id/approve` | No body | The result of the explicitly approved operation |
| `GET /audit` | No body | Audit events |
| `GET /audit/query` | Optional `q`, `type`, `tool`, `actor`, `outcome`, `from`, `to`, `page`, and `pageSize` | Filtered audit events and pagination metadata |
| `GET /audit/verify` | No body | Audit-chain integrity verification |

Advanced-service and optional-plugin routes documented in the
[operator console guide](operator-console.md) retain the classifications in
the surface matrix. Other implemented routes are internal unless this
reference or another v1 document explicitly defines them.
