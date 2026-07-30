import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  AUTOMATION_SCHEMA_VERSION,
  createScheduleCandidate,
  formatAutomationCursor,
  matchAutomationEvent,
  nextAutomationDue,
  validateAutomationDeclaration,
  validateAutomationEvent,
  validateOdinnAgentControlEnvelope,
  validateOdinnAgentControlTransition
} from "../packages/kernel/src/automation-primitives.ts";

const interval = {
  schemaVersion: AUTOMATION_SCHEMA_VERSION,
  id: "hourly-report",
  revision: 1,
  enabled: true,
  actionRef: "agent.run",
  kind: "schedule",
  schedule: { type: "interval", anchorUnixMs: 1_000, everyMs: 3_600_000 }
};

const eventDeclaration = {
  schemaVersion: AUTOMATION_SCHEMA_VERSION,
  id: "important-order",
  revision: 2,
  enabled: true,
  actionRef: "agent.run",
  kind: "event",
  source: "orders",
  event: "created",
  match: [
    { field: "region", operator: "eq", value: "east" },
    { field: "sku", operator: "prefix", value: "pro-" },
    { field: "priority", operator: "in", values: [1, 2] }
  ]
};

const event = {
  schemaVersion: AUTOMATION_SCHEMA_VERSION,
  source: "orders",
  event: "created",
  sequence: 42,
  cursor: formatAutomationCursor("orders", 42),
  occurredAtUnixMs: 5_000,
  attributes: { region: "east", sku: "pro-1", priority: 2 }
};

const replayWindow = (afterCursor?: string) => ({
  source: "orders",
  oldestAvailableSequence: 40,
  oldestAvailableCursor: formatAutomationCursor("orders", 40),
  newestAvailableSequence: 50,
  newestAvailableCursor: formatAutomationCursor("orders", 50),
  ...(afterCursor === undefined ? {} : { afterCursor })
});

test("schedule declarations calculate deterministic strictly-next occurrences", () => {
  assert.equal(nextAutomationDue(interval, 0), 1_000);
  assert.equal(nextAutomationDue(interval, 1_000), 3_601_000);
  assert.equal(nextAutomationDue(interval, 3_600_999), 3_601_000);
  assert.equal(nextAutomationDue({ ...interval, enabled: false }, 0), null);
  const oneShot = { ...interval, schedule: { type: "at", atUnixMs: 10 } };
  assert.equal(nextAutomationDue(oneShot, 9), 10);
  assert.equal(nextAutomationDue(oneShot, 10), null);
  const boundary = { ...interval, schedule: { type: "interval", anchorUnixMs: 8_639_999_999_999_000, everyMs: 1_000 } };
  assert.equal(nextAutomationDue(boundary, 8_639_999_999_999_999), 8_640_000_000_000_000);
  assert.equal(nextAutomationDue(boundary, 8_640_000_000_000_000), null);
});

test("schedule candidates are deterministic, immutable, and explicitly unauthorized", () => {
  const first = createScheduleCandidate(interval, 1_000)!;
  const second = createScheduleCandidate(interval, 1_000)!;
  assert.deepEqual(first, second);
  assert.equal(first.authorized, false);
  assert.equal(first.requiresAuditedDispatch, true);
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => createScheduleCandidate(interval, 1_001), /not an occurrence/u);
  assert.equal(createScheduleCandidate({ ...interval, schedule: { type: "interval", anchorUnixMs: 0, everyMs: 1_000 } }, 0)!.occurrenceUnixMs, 0);
});

test("event matching is deterministic, bounded, and replay-aware", () => {
  const candidate = matchAutomationEvent(eventDeclaration, event, replayWindow())!;
  assert.equal(candidate.cursor, event.cursor);
  assert.equal(candidate.sequence, 42);
  assert.equal(candidate.authorized, false);
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(matchAutomationEvent(eventDeclaration, { ...event, attributes: { ...event.attributes, region: "west" } }, replayWindow()), null);
  assert.throws(() => matchAutomationEvent(eventDeclaration, { ...event, sequence: 39, cursor: formatAutomationCursor("orders", 39) }, replayWindow()), /stale/u);
  assert.throws(() => matchAutomationEvent(eventDeclaration, { ...event, sequence: 51, cursor: formatAutomationCursor("orders", 51) }, replayWindow()), /future/u);
  assert.equal(matchAutomationEvent(eventDeclaration, event, replayWindow(formatAutomationCursor("orders", 41)))!.sequence, 42);
  assert.throws(() => matchAutomationEvent(eventDeclaration, event, replayWindow(formatAutomationCursor("orders", 42))), /duplicate or out of order/u);
});

test("event cursor binds source and sequence", () => {
  assert.deepEqual(validateAutomationEvent(event), event);
  assert.throws(() => validateAutomationEvent({ ...event, cursor: formatAutomationCursor("other", 42) }), /does not match/u);
});

test("declarations fail closed on versions, fields, unsafe operators, and excess complexity", () => {
  assert.throws(() => validateAutomationDeclaration({ ...interval, schemaVersion: 2 }), /unsupported schemaVersion/u);
  assert.throws(() => validateAutomationDeclaration({ ...interval, input: { secret: true } }), /unknown field: input/u);
  assert.throws(() => validateAutomationDeclaration({
    ...eventDeclaration,
    match: [{ field: "name", operator: "regex", value: ".*" }]
  }), /operator must be eq, prefix, or in/u);
  assert.throws(() => validateAutomationDeclaration({
    ...eventDeclaration,
    match: Array.from({ length: 17 }, (_, index) => ({ field: `f${index}`, operator: "eq", value: true }))
  }), /at most 16/u);
  assert.throws(() => validateAutomationDeclaration({ ...interval, revision: 0 }), /must be positive/u);
  assert.throws(() => validateAutomationDeclaration({
    ...eventDeclaration,
    match: [{ field: "x", operator: "in", values: [1, 1] }]
  }), /duplicate values/u);
  assert.throws(() => validateAutomationEvent({
    ...event,
    attributes: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`f${index}`, index]))
  }), /at most 32/u);
  const inherited = Object.create({ actionRef: "shell.exec" });
  Object.assign(inherited, interval);
  assert.throws(() => validateAutomationDeclaration(inherited), /plain object/u);
  const accessor = { ...interval };
  Object.defineProperty(accessor, "actionRef", { get: () => "shell.exec", enumerable: true });
  assert.throws(() => validateAutomationDeclaration(accessor), /cannot contain accessors/u);
  assert.throws(() => validateAutomationEvent({
    ...event,
    attributes: JSON.parse('{"__proto__":"bad"}')
  }), /bounded identifier|reserved/u);
  assert.throws(() => validateAutomationDeclaration(Object.prototype), /plain object/u);
  assert.throws(() => validateAutomationDeclaration({ ...interval, [Symbol("hidden")]: true }), /symbol fields/u);
  const hidden = { ...interval };
  Object.defineProperty(hidden, "authority", { value: true, enumerable: false });
  assert.throws(() => validateAutomationDeclaration(hidden), /non-enumerable/u);
  assert.throws(() => validateAutomationDeclaration({
    ...eventDeclaration,
    match: Array.from({ length: 16 }, (_, index) => ({
      field: `f${index}`,
      operator: "in",
      values: Array.from({ length: 16 }, (__, value) => `${index}-${value}-${"x".repeat(200)}`)
    }))
  }), /canonical JSON bytes|JSON nodes/u);
  assert.throws(() => nextAutomationDue(interval, 8_640_000_000_000_001), /ECMAScript date range/u);

  const sparse = [{ field: "x", operator: "eq", value: 1 }, , { field: "y", operator: "eq", value: 2 }];
  assert.throws(() => validateAutomationDeclaration({ ...eventDeclaration, match: sparse }), /dense canonical indices/u);
  const accessorArray = [{ field: "x", operator: "eq", value: 1 }];
  Object.defineProperty(accessorArray, "0", { get: () => ({ field: "x", operator: "eq", value: 2 }), enumerable: true });
  assert.throws(() => validateAutomationDeclaration({ ...eventDeclaration, match: accessorArray }), /data properties/u);
  const symbolArray = [{ field: "x", operator: "eq", value: 1 }];
  (symbolArray as any)[Symbol("hidden")] = "collision";
  assert.throws(() => validateAutomationDeclaration({ ...eventDeclaration, match: symbolArray }), /dense canonical indices/u);
  const hiddenArray = [{ field: "x", operator: "eq", value: 1 }];
  Object.defineProperty(hiddenArray, "hidden", { value: "collision", enumerable: false });
  assert.throws(() => validateAutomationDeclaration({ ...eventDeclaration, match: hiddenArray }), /dense canonical indices/u);
  const extraArray = [{ field: "x", operator: "eq", value: 1 }] as any;
  extraArray.extra = "collision";
  assert.throws(() => validateAutomationDeclaration({ ...eventDeclaration, match: extraArray }), /dense canonical indices/u);
});

test("declaration identity canonicalizes predicates and binds revision and digest", () => {
  const left = validateAutomationDeclaration(eventDeclaration);
  const right = validateAutomationDeclaration({
    ...eventDeclaration,
    match: [
      { field: "priority", operator: "in", values: [2, 1] },
      { field: "sku", operator: "prefix", value: "pro-" },
      { field: "region", operator: "eq", value: "east" }
    ]
  });
  assert.equal(left.declarationDigest, right.declarationDigest);
  const revised = validateAutomationDeclaration({ ...eventDeclaration, revision: 3 });
  assert.notEqual(left.declarationDigest, revised.declarationDigest);
  const unicode = validateAutomationDeclaration({
    ...eventDeclaration,
    match: [{ field: "label", operator: "in", values: ["é", "z", "ä", "😀"] }]
  });
  assert.deepEqual((unicode as any).match[0].values, ["z", "ä", "é", "😀"]);
  assert.equal(unicode.declarationDigest, validateAutomationDeclaration({
    ...eventDeclaration,
    match: [{ field: "label", operator: "in", values: ["😀", "ä", "z", "é"] }]
  }).declarationDigest);
  const candidate = matchAutomationEvent(left, event, replayWindow())!;
  assert.equal(candidate.declarationRevision, 2);
  assert.equal(candidate.declarationDigest, left.declarationDigest);
});

test("canonical declaration ordering is identical across process locales", () => {
  const script = `
    import { validateAutomationDeclaration } from "./packages/kernel/src/automation-primitives.ts";
    const value = validateAutomationDeclaration({
      schemaVersion: 1, id: "locale-test", revision: 1, enabled: true,
      actionRef: "agent.run", kind: "event", source: "source", event: "event",
      match: [
        { field: "i", operator: "eq", value: "é" },
        { field: "I", operator: "in", values: ["😀", "ä", "z", "é"] }
      ]
    });
    process.stdout.write(JSON.stringify({ fields: value.match.map((item) => item.field), digest: value.declarationDigest }));
  `;
  const outputs = ["C", "en_US.UTF-8", "tr_TR.UTF-8"].map((locale) => {
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, LC_ALL: locale, LANG: locale }
    });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  });
  assert.equal(new Set(outputs).size, 1);
  assert.deepEqual(JSON.parse(outputs[0]).fields, ["I", "i"]);
});

test("Odinn Agent Control Envelope covers dispatch, cancel, status, and result without arbitrary payloads", () => {
  const candidate = createScheduleCandidate(interval, 1_000)!;
  const common = { version: 1, id: "message-1", correlationId: "flow-1", agentId: "main", issuedAtUnixMs: 2_000 };
  for (const envelope of [
    { ...common, kind: "dispatch", candidate },
    { ...common, kind: "cancel", dispatchId: "dispatch-1", reason: "operator-request" },
    { ...common, kind: "status", dispatchId: "dispatch-1", state: "awaiting-approval" },
    { ...common, kind: "result", dispatchId: "dispatch-1", outcome: "needs-review", resultRef: "audit:run-1" }
  ]) {
    const validated = validateOdinnAgentControlEnvelope(envelope);
    assert.equal(Object.isFrozen(validated), true);
  }
  assert.throws(() => validateOdinnAgentControlEnvelope({ ...common, kind: "dispatch", candidate, payload: { tool: "shell" } }), /unknown field: payload/u);
  assert.throws(() => validateOdinnAgentControlEnvelope({ ...common, kind: "dispatch", candidate, approvalId: "forged" }), /unknown field: approvalId/u);
  assert.throws(() => validateOdinnAgentControlEnvelope({ ...common, version: 2, kind: "status", dispatchId: "d", state: "running" }), /unsupported version/u);
  assert.throws(() => validateOdinnAgentControlEnvelope({ ...common, kind: "status", dispatchId: "d", state: "completed" }), /status state is invalid/u);
  assert.throws(() => validateOdinnAgentControlEnvelope({ ...common, kind: "result", dispatchId: "d", outcome: "running" }), /result outcome is invalid/u);
});

test("dispatch rejects tampered candidates", () => {
  const candidate = createScheduleCandidate(interval, 1_000)!;
  assert.throws(() => validateOdinnAgentControlEnvelope({
    version: 1,
    kind: "dispatch",
    id: "message-1",
    correlationId: "flow-1",
    agentId: "main",
    issuedAtUnixMs: 2_000,
    candidate: { ...candidate, actionRef: "shell.exec" }
  }), /integrity binding/u);
  assert.throws(() => validateOdinnAgentControlEnvelope({
    version: 1,
    kind: "dispatch",
    id: "message-1",
    correlationId: "flow-1",
    agentId: "main",
    issuedAtUnixMs: 2_000,
    candidate: { ...candidate, declarationRevision: 2 }
  }), /integrity binding/u);
  assert.throws(() => validateOdinnAgentControlEnvelope({
    version: 1,
    kind: "dispatch",
    id: "message-1",
    correlationId: "flow-1",
    agentId: "main",
    issuedAtUnixMs: 2_000,
    candidate: { ...matchAutomationEvent(eventDeclaration, event, replayWindow())!, cursor: "odinn-event-v1/orders/042" }
  }), /cursor does not bind/u);
});

test("control transitions bind dispatch, agent, correlation, ordering, and terminal finality", () => {
  const candidate = createScheduleCandidate(interval, 1_000)!;
  const dispatch = validateOdinnAgentControlEnvelope({
    version: 1, kind: "dispatch", id: "dispatch-1", correlationId: "flow-1",
    agentId: "main", issuedAtUnixMs: 2_000, candidate
  });
  const running = { version: 1, kind: "status", id: "status-1", correlationId: "flow-1", agentId: "main", issuedAtUnixMs: 2_001, dispatchId: "dispatch-1", state: "running" };
  const result = { version: 1, kind: "result", id: "result-1", correlationId: "flow-1", agentId: "main", issuedAtUnixMs: 2_002, dispatchId: "dispatch-1", outcome: "completed" };
  assert.equal(validateOdinnAgentControlTransition([], dispatch).kind, "dispatch");
  assert.equal(validateOdinnAgentControlTransition([dispatch], running).kind, "status");
  assert.equal(validateOdinnAgentControlTransition([dispatch, running], result).kind, "result");
  assert.throws(() => validateOdinnAgentControlTransition([], running), /unknown dispatch/u);
  assert.throws(() => validateOdinnAgentControlTransition([dispatch], { ...running, agentId: "other" }), /agentId/u);
  assert.throws(() => validateOdinnAgentControlTransition([dispatch], { ...running, correlationId: "other" }), /correlationId/u);
  assert.throws(() => validateOdinnAgentControlTransition([dispatch, running], { ...running, id: "status-2" }), /duplicate or regressive/u);
  assert.throws(() => validateOdinnAgentControlTransition([dispatch, running], { ...result, id: "dispatch-1" }), /unique across retained history/u);
  assert.throws(() => validateOdinnAgentControlTransition([dispatch, running, result], { ...result, id: "result-2" }), /terminal/u);
  assert.throws(() => validateOdinnAgentControlTransition(Array.from({ length: 17 }, () => dispatch), result), /at most 16/u);
  assert.throws(() => validateOdinnAgentControlTransition([running], result), /begin with dispatch/u);
});

test("automation primitives resolve only through their demand-loaded package subpath", async () => {
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    "const m = await import('@odinn/kernel/automation-primitives'); if (m.AUTOMATION_SCHEMA_VERSION !== 1) process.exit(2)"
  ], { cwd: join(process.cwd(), "apps", "cli"), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);

  for (const file of [
    "packages/kernel/src/index.ts",
    "packages/kernel/src/jobs.ts",
    "apps/gateway/src/server.ts",
    "apps/cli/src/cli.ts"
  ]) {
    assert.doesNotMatch(await readFile(join(process.cwd(), file), "utf8"), /automation-primitives/u);
  }
});
