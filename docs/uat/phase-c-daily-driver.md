# Phase C daily-driver operator acceptance

This acceptance is intentionally performed through the shipped browser console.
The operator does not inspect source files, SQLite, raw audit rows, or internal
state while completing it.

Run the retained automated walkthrough with pinned Chromium:

```sh
pnpm uat:phase-c
```

The walkthrough proves that an operator can:

1. select a configured model and complete a streaming conversation;
2. attach a bounded local text file and see it cleared only after success;
3. review and consume a one-use approval;
4. create a recurring schedule;
5. inspect saved memory and searchable activity history;
6. inspect a child session's terminal reason; and
7. find interrupted work on the Operator page and resume it from the durable
   checkpoint until the attention count clears.

The test uses fixture provider and integration responses, never live accounts or
credentials. Gateway session persistence, console assets, browser behavior, and
the operator's visible interactions are real. Provider-specific acceptance and
live external effects remain integration-slice gates rather than Phase C UI
authority.

For human usability sign-off, give a tester only the running console URL and the
seven goals above. Record the exact commit, browser version, result, confusing
labels, and any step that required terminal, source, or raw audit access. Any
such requirement fails the Phase C exit gate.
