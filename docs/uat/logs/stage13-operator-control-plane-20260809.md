# Stage 13 operator control-plane proof

Date: 2026-08-09

## Scope

This proof covers the shared operator snapshot/action contract and its CLI,
TUI, authenticated HTTP JSON, and web-console adapters.

## Exact checks

All local checks were run serialized and constrained to CPUs 0–1:

- `taskset -c 0,1 pnpm format:check` — `format contract passed`.
- `taskset -c 0,1 pnpm lint` — repository lint passed; one pre-existing warning
  remains in `packages/kernel/src/differentiated-runtime.ts`.
- `taskset -c 0,1 pnpm typecheck` — `typecheck contract passed`.
- `taskset -c 0,1 node --test --test-concurrency=1 --test-reporter=spec tests/operator-control.test.ts` — 3/3 passed.
- `taskset -c 0,1 pnpm --filter @odinn/cli start -- tui --state .odinn` — rendered
  the v1 operator snapshot with runtime, work, attention, approvals, and audit
  sections, then exited normally.

## HTTP smoke

An ephemeral loopback gateway was started on port `18997`, queried with the
owner-only bearer token, and stopped immediately afterward.

- `GET /operator/snapshot?surface=http&pageSize=2` returned `200`, schema
  version `1`, bounded sections, redacted projections, and pagination metadata.
- `POST /operator/actions` with `{"action":"verify-audit","surface":"http"}`
  returned `200` with a valid audit result and a refreshed snapshot.
- No browser or external network automation was started.

## Not tested in this bounded pass

- Full repository test suite, platform matrix, OCI integration suite, and
  compiled-release checks were not rerun locally because the operator requested
  serialized, non-repetitive validation. Existing CI remains the release gate.
- Live approval execution, workflow enablement, event ingress enablement, and
  remote multi-user hosting were not activated; their existing governed paths
  remain the adapters used by the action dispatcher.
