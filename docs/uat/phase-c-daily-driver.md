# Phase C daily-driver operator acceptance

Phase C has two separate gates. The automated gate proves durable behavior and
the source-blind human gate establishes usability. Passing one does not stand in
for the other.

## Automated durability gate

Install the repository-pinned Chromium revision when it is not already present,
then run the retained walkthrough:

```sh
pnpm --filter @odinn/kernel exec playwright-core install chromium
pnpm uat:phase-c
```

`uat:phase-c` launches the real local Gateway, console assets, SQLite stores,
OpenAI-compatible provider adapter, governed agent loop, browser adapter, and
pinned Playwright Chromium. The only simulated boundary is a deterministic local
model protocol server; the test does not intercept Gateway or console API calls
and uses no live account or credential.

The harness disables Gateway authentication and binds only to loopback. Run it
only on a trusted single-user host; loopback limits network exposure but is not
caller authentication on a multi-user machine.

The walkthrough proves all of the following through public HTTP and browser
surfaces:

1. the operator selects the second configured model, attaches a bounded text
   file, sees streaming progress, and completes a real agent/browser tool loop;
2. a recurring schedule and saved memory are created through the console;
3. activity history is actually filtered with a search query;
4. a completed child graph exposes its child activity and terminal reason;
5. a one-use approval survives restart, is denied with the keyboard, and cannot
   later be approved;
6. a completed durable job survives restart and an identical idempotent request
   returns the retained result without another execution attempt;
7. the same Gateway port is stopped and reopened, with chat, schedule, memory,
   approval, job, graph, and signed audit state retained, and an exact
   post-restart request reaches the second configured model through the local
   provider adapter;
8. an approval-gated browser mutation reaches a controlled loopback POST and is
   held in flight while the Gateway stops; restart recovers the durable job as
   `needs-review`, preserves its uncertain browser recovery record, and neither
   startup nor an identical idempotent submission dispatches the POST a second
   time;
9. the interrupted workspace file remains unchanged at startup; the browser
   drives both preview and apply through the shipped **Restore Points** page,
   the harness inspects workspace state between those two actions, and the
   visible preview is non-mutating before explicit restore applies the retained
   checkpoint; and
10. the 375-pixel layout has no horizontal overflow and navigation remains
    keyboard-operable with truthful accessible names.

The interrupted effect is a real browser request to a deterministic loopback
fixture, not a live external service. This gate proves the Gateway's durable
uncertainty and no-automatic-replay behavior at that controlled boundary. It
does not claim provider-account behavior, billing semantics, or recovery of a
third-party side effect.

The test validates that the runtime Chromium version exactly matches
`playwright-core`'s pinned browser metadata, even when `ODINN_CHROMIUM_PATH` is
set. Temporary state, workspace, browser managers, provider sockets, Gateway
stores, Chromium, and readline are closed and removed after the run, including
when setup fails after only some resources have initialized. Adversarial tests
inject failures at each setup boundary and after readline creation.

## Source-blind human gate

From a clean checkout at the exact commit under review, run:

```sh
pnpm uat:phase-c:human
```

The facilitator gives the tester only the printed loopback URL, visible goals,
and the opaque restore-point reference printed by the command. Do not provide
terminal access, source paths, SQLite, raw audit records, CSS selectors, or
implementation hints. The tester must perform both restore preview and apply
through **Advanced → Restore Points**. The command inspects state after preview
and before apply, keeps the same URL while restarting the Gateway, records a
pass/fail/blocked result plus notes for every goal, and writes an owner-only
report to:

```text
dist/uat/phase-c-human-<commit>.json
```

The report binds the exact commit and tree, dirty-tree state, Playwright and
Chromium versions, model/tool evidence, durable state results,
browser-originated restore request sequence, and tester notes. After restart,
the tester sends the exact printed probe with the second model so the report can
bind a provider request to the post-restart interval. The harness also sets the
actual tester page to exactly 375×812 for a named keyboard-only segment; it
records DOM overflow widths and trusted Tab/activation events without recording
typed content, then restores the normal viewport.

The report records explicit attestations that the tester is a non-developer,
remained source-blind, used no terminal or direct API, and performed the narrow
segment with the keyboard only. It reports `HOLD` unless the checkout is clean,
every human goal and attestation passes, the second model and browser tool
round-trip were observed, exactly one post-restart probe reached the second
model, the schedule and approval lifecycle are exact, the controlled uncertain
effect is quarantined without replay, the controlled viewport has no horizontal
overflow with trusted keyboard evidence, the UI-originated restore preview is
non-mutating, UI-originated apply succeeds, the child graph completes, and
audit verification returns exactly `valid: true`, zero unsigned events, and no
failures. `HOLD`, any blocked/failed goal, or any missing attestation exits
nonzero after the report and cleanup are complete.

Any confusing or undiscoverable label, missing feedback, overflow, keyboard
blocker, need for implementation knowledge, or unavailable non-developer tester
keeps the human gate on `HOLD`. Provider-specific acceptance and live external
effects remain separate integration gates; this Phase C procedure never claims
live-provider evidence.
