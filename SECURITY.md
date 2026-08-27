# Security Policy

## Supported versions

Security fixes are applied to the latest commit on `main` and the newest
published `v1.x` release.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Report it through [GitHub private vulnerability reporting](https://github.com/BlueDot-IT/Odinn-Forge/security/advisories/new). Include:

- A concise description of the issue
- Affected commit, tag, or package version
- Reproduction steps or a minimal proof of concept
- Expected and observed behavior
- Potential impact
- Any suggested mitigation

We make a best-effort attempt to acknowledge reports within seven calendar days.
During an active investigation, we aim to provide a status update at least every
14 days, including when there is no material change.

Disclosure timing will be coordinated with the reporter after impact and
remediation are understood. Where appropriate, the target coordinated-disclosure
window is up to 90 days from the initial report. If severity, active exploitation,
remediation availability, or downstream coordination changes that target, we will
communicate the revised timeline before disclosure.

## Security boundaries

Ódinn Forge has explicit capability boundaries, append-only audit events, restart-safe approval and browser-recovery claims, forked crash-containment workers, isolated browser profiles, durable stores, and a loopback-only default control plane. The task workers retain the parent operating-system identity, filesystem, environment, and network authority; they are not a security sandbox. Remote hosting is a separate opt-in service that requires TLS and gives every provisioned user an independent gateway and state/workspace boundary.

The [v1 compatibility policy](docs/v1-compatibility.md) is authoritative for
stable, internal, experimental, provider-dependent, platform-dependent, and
unsupported behavior. The stable v1 security boundary covers the documented
local single-user workflow. Experimental packages, unconfined execution, and
multi-user hosting remain outside that normal compatibility promise.

- Do not expose the Gateway directly to the public internet.
- Do not run unreviewed tools, skills, MCP servers, or channel adapters. Installed extensions are disabled and untrusted by default. Container extensions require a verified whole-bundle digest and explicit grants; unconfined process execution additionally requires explicit trust and unsafe-mode acknowledgement. Every enabled extension runs from an owner-only snapshot reverified after copying, so the mutable source bundle is never launched after its integrity check.
- Use dedicated credentials with minimal permissions.
- Keep provider keys and channel tokens out of source control.
- Treat generated skills and imported configuration as untrusted until reviewed.

### Secure defaults

The default policy enables public web reading while blocking private-network URLs, leaves domain allowlists empty, uses a separate Chromium profile for browser work, and requires explicit approval before `browser.click`, `browser.type`, or `browser.press` can execute. Approval claims are persisted with atomic replacement, expire after five minutes, and use a stable run ID so duplicate approval requests do not execute the same action twice. Approval state is stored in the state directory with mode `0600`; the corresponding request and decision are written to the audit log. The gateway validates `Host` before bootstrap and accepts only loopback hosts (`localhost`, `127.0.0.1`, and `[::1]`), then requires a per-state bearer token or same-site bootstrap cookie for control-plane access and rejects cross-origin mutations.

The policy is configurable because local operators have different trust boundaries. The dangerous switches are intentionally explicit:

```bash
odinn config security show
odinn config security set --surface web --allow-private-network true
odinn config security set --surface browser --require-approval false
```

Private-network access can expose local services and metadata endpoints. Disabling browser approval allows the model to drive external accounts without a human checkpoint. Those settings are operator decisions, not safe defaults.

The default state directory is the operator-owned `~/.odinn`. A repository-local
`.odinn` directory is workspace content unless the operator explicitly selects
it with `--state` or `ODINN_STATE_DIR`; merely cloning `.odinn/config.json` never
adopts it as trusted state. Workspace `.env` files cannot set executable
selectors, network service endpoints, authentication controls, or other runtime
controls. Existing repository-local state is reported with an actionable
migration notice, but is never adopted automatically. Configured workspace
credential names must use a credential suffix (`_API_KEY`, `_TOKEN`, `_SECRET`,
`_PASSWORD`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_APP_ID`, or `_TENANT_ID`) and
cannot alias reserved controls; invalid names are rejected when configuration is
written. `ODINN_CHROMIUM_PATH`,
`ODINN_EXTENSION_CONTAINER_RUNTIME`, and `ODINN_SEARCH_ENDPOINT` are accepted
only from the parent process or the explicitly selected operator state `.env`.
Explicit capability arrays remain exact across upgrades and are never widened
by default migration.

The web tools follow redirects through the same URL policy and enforce blocked/allowed domains at each hop. `web.fetch` resolves DNS, rejects private/link-local/metadata ranges, and pins the validated address into the request so validation and connection do not use separate DNS answers. Browser navigation and post-action snapshots are checked against the same network and domain rules. Workspace reads resolve real paths and reject escaping symlinks. Ódinn does not expose file upload or download tools.

### Update, migration, and backup safety

Remote lifecycle resources require HTTPS. `odinn update` requires checksum
metadata, verifies the release manifest, archive digest, package identity,
version, and commit, and rejects archive traversal and linked files before
installation. Versions are immutable and the active pointer changes
atomically. Remote release assets must also identify the exact immutable Git
tag commit resolved independently through the repository API. State migrations validate all stores, create a protected backup,
operate on a staging tree, verify audit integrity, and fail closed on unknown
future schemas.

Normal `odinn backup` output excludes OAuth tokens, gateway tokens, browser
profiles and cookies, capability signing keys, the state-directory `.env`, and
multi-user password records.
It uses SQLite's backup API for the runtime database and checksums every
included file. Restore validates the manifest and every checksum, rejects
unsafe links and future schemas, creates a protected pre-restore backup, and
activates verified state atomically. `odinn uninstall` preserves state unless
state removal is explicitly confirmed and refuses ambiguous paths or unexpected
installation contents.

Migration and failed-update recovery use internal full snapshots so the
previous installation can be restored exactly. Those snapshots remain local,
use owner-only directory and file permissions, and are not the normal export
format.

### Advanced services and experimental module controls

Runemark (run verification), Gatewatch (policy safety), Norn Restore (restore points), and Raven Route (model routing) are core advanced services. They are available by default and do not use experimental feature flags.

Rune Key (scoped temporary access), Saga Archive (portable run bundles), and Worldtree Paths (scenario comparison) are optional plugin modules and are disabled by default. Enable only the modules you need, one at a time, and review their feature documentation:

```bash
odinn config experimental show
odinn config experimental enable capabilities
odinn config experimental enable capsules
odinn config experimental enable counterfactual
```

Runemark is evidence-based: model text cannot set `verified`. Gatewatch decisions are generated by code and written before an operation. Rune Key tokens are short-lived, signed, scoped to a run/step/tool, and use-limited; they are not substitutes for credential isolation. Norn Restore only restores selected local files. Saga Archive redacts secrets and rejects archive traversal, but a run bundle is not a trusted executable. Worldtree Paths workspaces are local copies, not a sandbox for irreversible remote actions. Raven Route stores outcome metadata, not prompts or credentials.

### Trust model

- The local operator controls the config, provider credentials, browser login, and approval decisions.
- Model output and imported skills are untrusted input; they cannot bypass the kernel policy evaluator.
- Extension and MCP manifests are metadata, not trust. They are disabled by default, require provenance review, and receive only explicit capability grants when enabled. The active Docker adapter verifies the complete immutable bundle, uses read-only scoped mounts, disables network access, drops capabilities, enables no-new-privileges, selects and attests `seccomp=builtin`, and requires engine-reported plus stopped-container-attested CPU, memory/swap, PID, temporary-filesystem, timeout, and output controls before start. Podman remains inactive until an explicit operator-trusted seccomp profile is compiled and attested. Effective kernel enforcement remains a disclosed OCI-runtime trust dependency. Exact pre-start audit evidence and a durable cleanup-recovery reservation bound to the trusted engine path are required; uncertain cleanup quarantines later dispatch. `unconfined-process` declarations remain inactive even when host execution is configured; they refuse until a host-approved backend can bind exact commands, roots, limits, and one-time approval evidence.
- Public web content is untrusted data and may contain prompt injection. Ódinn Forge must not treat page instructions as operator authorization.
- Live-only email and calendar output is also untrusted. After one such result, the agent may form a visible final answer but receives no further tool authority in that run; unadvertised tool calls and replay without the active integration's trusted resource binding fail closed.
- State directories are repaired to `0700` and sensitive JSON/JSONL records to `0600` when the gateway opens them. Idempotency keys are bound to a canonical request hash; reusing a key with different content returns `409`.
- Durable external-channel session bindings are capped at 10,000 entries. New conversations fail closed at that ceiling while existing bindings remain usable.
- Browser read access is not action authorization. An external side effect requires the approval gate unless the operator explicitly disables it.
- The single-user gateway remains loopback-only. Remote deployment uses `host.ts`; non-loopback startup fails without a certificate, key, and exact public origin. Passwords are scrypt-derived, sessions are signed, cookies are HttpOnly/SameSite=Strict/Secure under TLS, and tenants never share state roots or gateway bearer tokens.

### Known gaps

Browser mutations are journaled before execution; an interrupted or failed mutation blocks further actions until the operator inspects and resolves the uncertain outcome. Native installs use immutable version directories and an atomic current/previous pointer. Full capsule replay requires a disposable workspace, complete non-redacted inputs, an audited executor, and explicit approval for network, credential, or external-state effects. Arbitrary remote services remain nondeterministic and an approved replay is not a guarantee that a remote mutation is reversible. The multi-user host provides application-level tenant isolation, not hostile-code containment between Unix users; use OS/container isolation for mutually untrusted tenants.

## CI security gates

The repository requires CodeQL analysis, dependency review, a fail-closed dependency advisory audit, secret scanning, package-integrity checks, and OpenSSF Scorecard reporting. The audit uses `pnpm audit` when available and falls back to npm's bulk advisory endpoint when the legacy audit endpoint is retired or unavailable. Release jobs additionally generate an SPDX SBOM, SHA-256 checksums, and GitHub build provenance.
