# Local macOS computer control

Ódinn Forge includes an experimental, disabled-by-default local macOS backend
for bounded display capture and desktop input. It is not a general shell,
remote administration service, or cross-platform desktop driver.

## Enable or disable

Review and confirm the authority change explicitly:

```bash
odinn config computer show
odinn config computer enable --node-id local-macos --display-id main --confirm-impact
odinn doctor
```

macOS must grant the Odinn terminal or service host **Screen Recording** and
**Accessibility** access in Privacy & Security. Configuration can be removed
from active policy without deleting audit or recovery evidence:

```bash
odinn config computer disable
```

Enablement adds only `computer.read` and `computer.mutate` to the active policy.
Disablement removes those grants. The configuration stores the fixed
`macos-local` backend and bounded node and display identity. `main` or
`display-1` selects macOS display 1; `display-2` through `display-16` select
that exact numbered display. It accepts no executable path, command,
credential, or secret.

## Tools and authority

- `computer.screen` captures the paired display and returns a bounded PNG frame
  to the live caller.
- `computer.act` supports frame-bound click, move, scroll, key, type, and
  bounded wait actions. Every mutation requires an exact approval tied to the
  captured frame and action.
- `computer.recovery.status` reports a categorical unresolved outcome.
- `computer.recovery.resolve` records whether the operator confirmed the action
  applied or did not apply before another mutation is admitted.

The provider invokes only `/usr/sbin/screencapture`, `/usr/bin/sips`, and
`/usr/bin/osascript`. Their paths are fixed in reviewed code and must resolve to
root-owned physical files that are not group- or world-writable. JavaScript for
Apple Events is sent on standard input; model input never selects an executable
or supplies shell syntax.

## Data, audit, and recovery

Live screenshots and typed input are sensitive. Public durable task, audit,
approval, and run-ledger projections retain categorical action data,
target/frame digests, dimensions, byte counts, and result state. They do not
retain pixels, screenshots, typed text, or key values. A pending approval keeps
the exact action only in volatile memory or its owner-only authenticated sealed
continuation envelope; that envelope expires after five minutes and is excluded
from ordinary backups. Completed runs cannot reconstruct those live-only
fields.

Before an input action is dispatched, the provider writes an owner-only
recovery marker containing only categorical metadata. Cancellation, timeout,
transport loss, capture failure after dispatch, or another uncertain result
returns `needs-review`, blocks further input, and requires explicit operator
resolution. Odinn does not claim it can reverse input already delivered to an
application.

`odinn doctor` reports only status, fixed backend identity, bounded target
labels when available, operating-system permission guidance, and categorical
failure reason. It never prints state paths, pixels, input, or credentials.

## Platform and acceptance boundary

The concrete backend supports local macOS only. Linux and Windows report
`platform-unsupported`; they never fall back to an ambient driver. Unit and
adversarial tests cover strict schemas, target/pairing rotation, stale frames,
approval binding, replay refusal, durable redaction, executable trust,
temporary-frame cleanup, cancellation, uncertainty quarantine, restart state,
and explicit CLI enable/disable diagnostics. A real macOS acceptance run still
depends on the installed operating-system version, desktop session, and granted
Screen Recording and Accessibility permissions.
