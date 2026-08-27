# User guide

## Choose a download

Normal users on Linux x64, macOS x64, or Windows x64 should choose the release
asset named `odinn-v<VERSION>-standalone-<PLATFORM>-x64`. These archives carry
a checksum- and signature-verified Node 24 runtime and do not use ambient
`node`, `NODE_OPTIONS`, preload hooks, or loader paths. The generic archives
and npm package intentionally remain Node-dependent for advanced installation
and unsupported platforms.

On Linux, the standalone entrypoint is a reproducible static PIE that removes
loader and Node hook variables before starting a fixed companion script. On
macOS, the equivalent entrypoint is signed with the hardened runtime before it
performs the same sanitization. Windows uses the fixed system command and
PowerShell boundary, clears CLR hooks and `PSModulePath` before PowerShell
starts, and verifies the embedded runtime with direct .NET SHA-256 APIs rather
than an auto-loadable command. Release validation injects hostile preload and
module probes and rejects any package or installed launcher that admits them.

The standalone installer stages the complete application/runtime pair under
an immutable version identity before switching the current pointer. Upgrade
and rollback never mix application and runtime versions; user state and
credentials remain outside the version tree.

Ódinn Forge is a local-first personal agent for a machine you control. This
guide covers the supported local workflow, installation, privacy boundary,
diagnostics, and bug reporting. Do not use it as a safety-critical service or
as a hostile-code sandbox.

The [v1 compatibility policy](v1-compatibility.md) is the authoritative
contract. The [surface matrix](surface-matrix.md) applies its six terms:
**Stable v1 interface**, **Internal implementation detail**,
**Experimental interface**, **Provider-dependent behavior**,
**Platform-dependent behavior**, and **Unsupported behavior**.

The three hard limits are:

- Forked workers are crash containment, not a security sandbox.
- Remote hosting is application-level tenant isolation, not hostile-user OS isolation.
- External effects and nondeterministic provider behavior are outside full replay/rollback guarantees.

## Supported boundary

Odinn Forge v1 supports this local, single-user workflow:

- Linux x64, macOS x64, or Windows x64 with the standalone release; Node.js is
  embedded and verified. Advanced generic-package installs and unsupported
  standalone targets require Node.js 24 or newer.
- One local operator using the loopback gateway at `127.0.0.1`.
- Public web reading, an isolated browser profile, scoped durable memory, audited tools, projects, sessions, goals, and cron jobs. A disabled-by-default [local macOS computer-control](computer-control.md) slice is available with separate operating-system permissions, explicit capability grants, exact approvals, and recovery. The console can register and inspect declarative Agent SDK packages and build integrity-checked Skill SDK packages; both install disabled, and registration and discovery do not execute or activate them.
- Explicit approval for browser mutations and other external side effects.
- Core advanced **Runemark** (run verification), **Gatewatch** (policy safety),
  **Norn Restore** (restore points), and **Raven Route** (model routing)
  services are available by default. **Saga Archive** (portable run bundles),
  **Rune Key** (scoped temporary access), and **Worldtree Paths** (scenario
  comparison) remain optional plugin modules until individually enabled.
- Automatic improvements runs by default and is limited to reversible, allowlisted reliability tuning.

The TLS multi-user host is available to experienced operators, but remote
hosting is application-level tenant isolation, not hostile-user OS isolation.
It is not the default path. Do not expose the single-user gateway to a network.

## Install a verified release

Download the current release from the repository's Releases page. Normal users
on supported x64 targets should choose the matching `standalone` ZIP or tar.gz
asset. It contains compiled JavaScript, runtime dependencies, and a verified
Node.js runtime; it does not require Node.js, pnpm, or a source checkout. The
generic archives remain an advanced Node-dependent fallback for arm64 and other
unsupported standalone targets. Releases also include `SHA256SUMS.txt`, SBOMs,
a release manifest, and workflow-built provenance attestations.

### Linux and macOS

Replace `vX.Y.Z` with the exact release tag shown on the Releases page. Release
tags and archives use the same `vX.Y.Z` identity. On Linux x64, tag `v1.2.3`
is packaged as `odinn-v1.2.3-standalone-linux-x64.tar.gz` and extracts to
`odinn-v1.2.3-standalone-linux-x64`. On macOS x64, replace `linux` with
`darwin`:

```bash
tag="vX.Y.Z"
platform="linux-x64"
archive="odinn-$tag-standalone-$platform.tar.gz"
curl -fLO "https://github.com/BlueDot-IT/Odinn-Forge/releases/download/$tag/$archive"
curl -fLO "https://github.com/BlueDot-IT/Odinn-Forge/releases/download/$tag/SHA256SUMS.txt"
grep "  $archive$" SHA256SUMS.txt | sha256sum -c -
tar -xzf "$archive"
cd "odinn-$tag-standalone-$platform"
./install/install.sh --prefix "$HOME/.local/share/odinn"
export PATH="$HOME/.local/share/odinn/bin:$PATH"
odinn --version
odinn onboard
```

In a terminal, onboarding provides Quick, Guided, Blank Slate, and detected
OpenClaw/Hermes import paths. Existing installs get separate Open, Repair,
Change AI, Review capabilities, Advanced, and confirmed reset actions. Changes
are staged and backed up, custom policies are preserved by default, and a real
model response must succeed before a connected setup is accepted. For automated
or headless setup, pass explicit provider flags such as
`odinn onboard --provider openai --auth api-key`. Run
`odinn onboard --verify --non-interactive` for a standalone capability check.

OpenAI / ChatGPT, OpenRouter, and Ollama are the first-class v1 provider paths.
Other built-in connections are labeled as compatibility presets or
experimental paths during onboarding and in the console. An endpoint you add
yourself is labeled custom compatibility mode. See
[AI provider support](provider-support.md) for what each label promises.

On macOS, use `shasum -a 256 -c` instead of `sha256sum -c` when GNU coreutils is unavailable.

### Windows PowerShell

Replace `vX.Y.Z` with the exact published tag:

```powershell
$Tag = "vX.Y.Z"
$Archive = "odinn-$Tag-standalone-win32-x64.zip"
Invoke-WebRequest "https://github.com/BlueDot-IT/Odinn-Forge/releases/download/$Tag/$Archive" -OutFile $Archive
Invoke-WebRequest "https://github.com/BlueDot-IT/Odinn-Forge/releases/download/$Tag/SHA256SUMS.txt" -OutFile SHA256SUMS.txt
$Expected = ((Select-String -Path SHA256SUMS.txt -Pattern "  $([regex]::Escape($Archive))$").Line -split "  ")[0]
$Actual = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Actual -ne $Expected) { throw "checksum mismatch for $Archive" }
Expand-Archive $Archive -DestinationPath . -Force
Set-Location "odinn-$Tag-standalone-win32-x64"
./install/install.cmd --prefix "$HOME/.local/share/odinn"
$env:Path = "$HOME/.local/share/odinn/bin;$env:Path"
odinn.cmd --version
odinn.cmd onboard
odinn.cmd start
```

The installer keeps immutable version directories and a previous-version
pointer.

## Updates, backups, restore, and uninstall

Check before changing anything:

```bash
odinn update check
odinn state status
```

`odinn update check` reports the installed and available release identities,
download size, migration requirement, and rollback compatibility without
changing application files or state. `odinn update` requires SHA-256 metadata,
verifies the release and package identities, rejects unsafe archive paths,
installs into an immutable version directory, checks migration compatibility,
switches atomically, and runs a health check. A failed switch restores the
previous application and any pre-update state snapshot.

Windows upgrades publish a new immutable launcher generation and fixed-layout
trampoline before recording the activation marker and changing the verified
application/runtime pointer. An installed finalizer revalidates and seals the
bound launcher/pointer/state generation under the installer lock after the
invoking batch process exits. If power is lost or the finalizer fails, the next
ordinary startup verifies the candidate runtime and reconciles the same marker
before launching; it never falls back to ambient Node for a standalone activation.
Retries are bounded and an exhausted or invalid marker fails closed.

After reviewing the check, install the latest verified release with:

```bash
odinn update
```

If the release was installed under a non-default prefix, pass the same
`--prefix <directory>` to `odinn update check`, `odinn update`,
`odinn rollback`, and `odinn uninstall`.

Uninstall shares the installer lock with update, rollback, and deferred Windows
launcher finalization. It refuses an active or malformed lock before removing
launchers or version state, so a finalizer cannot recreate launchers after a
successful uninstall.

Use these commands for local state:

```bash
odinn backup
odinn backup --output ./odinn-backup
odinn restore --input ./odinn-backup --confirm
odinn state migrate --dry-run
```

The bare backup command appends `.backups` to the configured state-directory
path and creates a timestamped `manual-...` directory beneath that sibling
backup root. It reports the exact destination. `--output` must name the new
backup directory. Restore changes the active state, so review the selected
backup before supplying the required `--confirm` flag.

Normal backups include configuration, projects, sessions, goals, memory, jobs,
cron definitions, audit records and verification keys, approval and browser
recovery journals, registries, schema versions, and application identity.
OAuth tokens, gateway tokens, browser profiles and cookies, capability signing
keys, the state-directory `.env`, and multi-user password records are excluded.
The `.env` remains local credential/runtime input and must be restored through
the operator's secure credential setup rather than a normal backup. Every
included file is checksummed. Restore validates the manifest and checksums, rejects future
schemas and unsafe links, creates a protected backup of current state, verifies
a staging tree, and switches it atomically.

Internal migration and failed-update recovery snapshots are complete so Odinn
can restore the previous installation exactly. They stay local with owner-only
permissions and are separate from normal user-created backups.

Application rollback is separate from state restore:

```bash
odinn rollback
```

Rollback refuses an older application when the current state requires a newer
reader and points to a matching recovery backup when one was created.

Uninstall preserves state by default:

```bash
odinn uninstall
odinn uninstall --remove-state --confirm
odinn uninstall --remove-state --force
```

The first command removes the application but retains state. Use the confirmed
form for interactive state removal; use the `--remove-state --force`
combination only for deliberate non-interactive state removal. `--force`
without `--remove-state` does not remove state. Odinn rejects ambiguous paths
and unexpected files in a custom installation prefix.

## Privacy and external services

Ódinn Forge product telemetry is disabled by default. The Gateway exports the
fixed, content-free operational schema only when you explicitly configure an
`ODINN_OTLP_ENDPOINT`; see [Optional asynchronous telemetry](async-telemetry.md).
Runtime state, browser profiles, audit records, memory, and credentials stay in
the configured local state directory unless you deliberately use a remote host
or external provider. Optional bounded GitHub reads send authenticated requests
only to the fixed GitHub API origin for repositories on the configured
allowlist; see [Bounded GitHub reads](github-read.md). Optional Microsoft Graph
email and calendar reads send authenticated requests only to the fixed Graph
origin for one configured account and selected resources; see
[Bounded Microsoft Graph reads](microsoft-graph-read.md).
Optional [authenticated remote-node reads](remote-node-read.md) send only the
two fixed status/diagnostics requests to exact operator-configured HTTPS
authorities and pinned addresses.

Model providers receive the prompts, recalled context, and tool results sent to their configured API. Websites receive normal browser or fetch traffic. Imported skills, MCP servers, extensions, and browser pages are untrusted input. Review them before enabling them and never post `.odinn`, OAuth files, gateway tokens, browser profiles, or raw diagnostic bundles publicly. External effects and nondeterministic provider behavior are outside full replay/rollback guarantees.

## Before reporting a bug

Capture the smallest safe reproduction:

```bash
odinn doctor
odinn status
odinn state status
odinn audit verify
odinn runs
```

The diagnostic report includes the Odinn version and commit, platform and Node
version, provider mode without credentials, experimental flags, audit status,
pending approvals, path-free Chromium candidate and configuration state,
browser recovery, job counts, and optional path-free GitHub and Microsoft Graph
read health, and credential-safe remote-node readiness counts. A
browser recovery, job counts, optional path-free GitHub and Microsoft Graph
read health, credential-safe remote-node readiness counts, and path-free local
macOS computer-control status. A
configured `ODINN_CHROMIUM_PATH` is reported as unverified without dereferencing
or executing it; browser execution performs
the normal policy-bound validation only when a browser tool is requested. If no
reviewed platform candidate is available, install Chromium or configure a path
before retrying browser tools. The report deliberately omits
state paths, tokens, prompts, cookies, and provider secrets. The running
gateway exposes the same safe report at `GET /diagnostics`.

Include the operating system, Node.js version, Odinn Forge version, provider name, exact command or UI action, expected result, observed result, and sanitized logs. Remove API keys, OAuth tokens, cookies, prompts containing private data, local usernames, private hostnames, and filesystem paths that identify people or clients.

Use the repository's bug-report form for ordinary defects. Suspected vulnerabilities must use GitHub private vulnerability reporting as described in `SECURITY.md`; never disclose an unpatched security issue in a public ticket.

## Feedback

Useful reports describe an actual workflow: what you tried, whether onboarding succeeded, where the interface became confusing, which provider or tool was involved, and whether restart or rollback recovered cleanly. Feature requests should explain the outcome needed rather than prescribing a large architecture from the void.
