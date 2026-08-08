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
| Admission preview | `odinn gatewatch preview --tool <tool> ...` | The complete current capability, invariant, safety, and approval decision with `executes: false` |

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

### Workspace inspection tool contracts

The trusted `workspace.list`, `workspace.stat`, `workspace.search`,
`workspace.read`, and `workspace.diff` built-ins require the
`workspace.inspect` capability. They accept only portable workspace-relative
paths, do not follow links or hard-linked regular files, apply the configured
sensitive-file policy, and return bounded results. Direct content access
rejects those unsafe targets. Traversal is deterministic, ignore-aware,
cancellation-aware, and cursor-paginated. Content returned to a live caller is
projected to content-free metadata before audit and run-ledger persistence.

The complete inputs, outputs, defaults, ceilings, cursor binding, ignore
semantics, durable-evidence behavior, and platform boundary are documented in
[Bounded workspace inspection](workspace-inspection.md).

### `workspace.readText` compatibility contract

`workspace.readText` reads one UTF-8 text file beneath the assigned workspace
root. Its optional `maxBytes` input is a positive, safe integer measured in
bytes, capped at `8,388,608` bytes; the default is `65,536`. The response is:

```json
{
  "path": "notes/example.txt",
  "content": "...",
  "bytesRead": 65537,
  "truncated": true,
  "digest": "sha256:..."
}
```

`content` is always valid UTF-8 and contains at most `maxBytes` encoded bytes;
truncation never leaves a partial UTF-8 sequence. `bytesRead` reports the
bounded probe, so it is the number of bytes observed up to `maxBytes + 1` (not
the character count and not necessarily the retained content length).
`truncated` is byte-based: it is `true` when the probe observes more than
`maxBytes` bytes and `false` otherwise. Operators and clients must treat these
fields as byte-accurate interface data. `digest` covers the retained bounded
bytes. The compatibility tool now shares the same sensitive-file policy,
confinement, race-detection, and cancellation implementation as
`workspace.read`; a legacy tool-scoped grant authorizes only
`workspace.readText`.

### `process.exec` tool contract

`process.exec` starts one executable directly with a separate argument array;
it never invokes a shell. Its working directory must resolve beneath the
assigned workspace. `timeoutMs` is bounded from 100 to 120,000 milliseconds and
defaults to 30,000. Combined captured output is bounded from 1,024 to 1,000,000
bytes and defaults to 128,000; exceeding the limit terminates the process tree
and sets `outputTruncated`.

This is intentionally not an operating-system sandbox. A child runs under the
same OS identity as Odinn and may use available executables or network access.
Odinn limits the inherited environment and assigns the workspace as child
`HOME` and `USERPROFILE`, but operators must still use a disposable workspace
and a suitably restricted host identity. The tool requires both an explicit
`process.execute` policy capability and the following configuration acknowledgement:

```json
{
  "runtime": {
    "allowUnconfinedProcessExec": true
  }
}
```

The result reports the normalized `command`, `args`, workspace-relative `cwd`,
`exitCode`, terminating `signal`, bounded `stdout` and `stderr`, captured byte
counts, `timedOut`, `outputTruncated`, and `durationMs`. Process execution is
classified as irreversible and non-retry-safe.

### System and configuration routes

| Method and path | Input | Output |
| --- | --- | --- |
| `GET /config` | No body | `{ ok, config, restartRequired, ... }` with editable configuration and metadata |
| `PUT /config` | `{ config, fingerprint }`, using the current 64-character fingerprint from `GET /config` | `{ ok, config, fingerprint, restartRequired }`; stale fingerprints return `409` without overwriting newer configuration |
| `GET /status` | No body | Version, absolute state/workspace paths, configured models/providers, exact tool capability declarations, capability registry and migration report, allowed tools, security policy, core advanced services, optional plugin flags, and pending approvals |
| `GET /diagnostics` | No body | A credential-redacted health and configuration report |
| `GET /channels` | No body | Credential-redacted configured channel lifecycle status |
| `POST /gatewatch/preview` | `{ toolName, input?, parentCapabilities?, requestedCapabilities?, skillCapabilities?, mcpCapabilities? }` | Complete non-executing Gatewatch decision; invalid or unknown capability sets return `400` |

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
| `POST /checkpoints` | `{ runId, taskId?, paths, stepId?, label?, capabilityToken? }` | Governed legacy snapshot creation; the workspace root is server-bound and `restore.create` admission is required |
| `POST /rewind/:snapshotId` | `{ runId, apply?, capabilityToken? }` | Governed legacy snapshot preview or restore; apply records a checkpoint boundary and requires `restore.apply` admission |
| `POST /governed/workspace/mutate` | `{ runId, operation, path, content?, mode?, expected?, from?, to?, recursive?, apply?, maxBytes?, maxFiles?, capabilityToken? }` | Governed workspace write/mkdir/remove/move preview or apply result |
| `POST /governed/workspace/patch` | `{ runId, operation, path, find?, replace?, replaceAll?, patches?, expected?, apply?, maxBytes?, maxFiles?, capabilityToken? }` | Governed workspace edit/applyPatch preview or apply result |
| `POST /governed/restore/create` | `{ runId, checkpointId, checkpointManifestDigest?, capabilityToken? }` | Create governed checkpoint-restore preview |
| `POST /governed/restore/apply` | `{ runId, checkpointId, checkpointManifestDigest, capabilityToken? }` | Apply governed checkpoint restore preview or restore; the exact digest returned by preview is required |
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
