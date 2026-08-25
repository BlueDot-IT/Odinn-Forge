# Independent macOS Recheck Remediation Plan

This plan converts the 23 August 2026 independent review of Odinn Forge v1.1.0
(`a208e07102af0dfe1d1408873bb96d24a19343bb`) into release acceptance work.

## Release acceptance boundary

Odinn is ready for another independent macOS recheck when every P1 item below
has a focused regression, the supported macOS gates pass from a fresh tagged
checkout, and a browser-enabled disposable state remains auditable and exactly
backed up without manual quarantine.

## Worklist

| Priority | Item | Status | Acceptance evidence |
| --- | --- | --- | --- |
| P1 | Keep Chromium-managed profile data outside governed state | Completed | Real macOS `browser.open` followed by audit verification and an exact backup passes; legacy profile data relocates atomically; unrelated symlinks remain rejected |
| P1 | Make backup contents exactly match `backup-manifest.json` | Completed | No SQLite sidecar remains in a completed backup; inspection rejects every unexpected file, including excluded sidecars |
| P1 | Repair supported-macOS platform and Gateway gates | Completed | The two reported Gateway cases pass on macOS and the portable platform/Gateway gates are CI-wired |
| P1/P2 | Accept the standard macOS `/tmp` to `/private/tmp` alias without accepting attacker-controlled intermediate links | Completed | Real macOS alias regression passes; arbitrary-parent-symlink negative control remains green |
| P1/P2 | Remove implicit `corepack` availability assumptions | Completed | Direct pnpm launcher and PATH fallback regressions run with no `corepack` executable available |
| P2 | Restore the documented portable test entry point | Completed | `pnpm test:portable` covers platform/Gateway/invariants/migrations/state lifecycle/browser lifecycle and is wired into supported-platform CI |
| P2 | Improve reasoning/output budget behavior | Deferred | Small deterministic answers remain visible under documented low-budget settings |
| P2 | Surface nested tool calls in the top-level result | Deferred | Top-level observability agrees with signed nested audit events |
| P2 | Strengthen correction-aware contamination suppression | Deferred | Low-authority superseded rumors do not outrank authoritative corrections |

## Implementation sequence

1. Land the state-governance and backup-exactness fixes together because they
   share the same browser-to-backup reproduction contract.
2. Reproduce and repair the two reported Gateway HTTP 400 cases.
3. Harden path canonicalization for the macOS system temp alias.
4. Centralize package-manager subprocess invocation and remove `corepack`
   assumptions from release gates.
5. Add `test:portable`, wire it into supported-platform CI, and run the complete
   release matrix.
6. Request an independent recheck before treating the release as unattended-
   macOS ready.

## Required verification

- Focused state lifecycle and browser contract tests.
- Typecheck, lint, formatting, and repository diff checks.
- Platform, Gateway, invariant, migration, and state lifecycle gates.
- Real Chromium disposable-state exercise on macOS.
- Recursive physical backup inventory equals manifest inventory plus the
  manifest itself.
- Independent security and test review before publication.
