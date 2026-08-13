# Issue #139 deterministic fault-injection proof

Date: 2026-08-13

## Scope

This bounded slice exercises workflow dispatch and settlement recovery using the
real SQLite workflow store/runtime and controlled local fakes. No third-party
or user-state effect is contacted. The machine-readable record is
`issue-139-deterministic-fault-injection-20260813.json`.

## Focused evidence

```text
corepack pnpm exec node --test --test-concurrency=1 --test-reporter=spec \
  tests/fault-injection-workflow.test.ts
5 tests passed, 0 failed
```

The four fault boundaries are:

- admission barrier before dispatch: cancellation ends the run without a physical dispatch;
- post-dispatch shutdown barrier: effectful work becomes `needs-review` and is not replayed;
- settlement failure before SQLite commit: the effectful step becomes `needs-review` and is not replayed;
- settlement acknowledgement loss after SQLite commit: the durable completion remains authoritative and is not replayed.

Every case records the durable workflow/step state, physical versus replay
counts, event-terminality invariant, and temporary-directory cleanup proof.

## Repository gates

- `corepack pnpm format:check` — passed
- `corepack pnpm lint` — passed
- `corepack pnpm check:architecture` — passed
- `corepack pnpm typecheck` — passed
- focused workflow/security regression set — 58 passed, 0 failed
- `git diff --check` — passed

No release, tag, publication, service restart, or external-effect operation was
performed.
