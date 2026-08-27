import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CALENDAR_READ_PLUGIN_MANIFEST,
  calendarReadHostCapabilityPlugin,
  createApprovalStore,
  createBuiltInRegistry,
  materializeHostCapabilityPlugin
} from "../packages/kernel/src/index.ts";
import { createDefaultPolicy, evaluateTaskPolicy } from "../packages/policy/src/index.ts";
import { projectDurableToolInput, projectDurableToolOutput } from "../packages/protocol/src/index.ts";

const target = Object.freeze({ providerId: "calendar-fixture", generation: "generation-1" });
const summary = Object.freeze({
  accountId: "account-1",
  calendarId: "calendar-1",
  eventId: "event-1",
  subject: "Private planning session",
  start: "2026-08-27T13:00:00.000Z",
  end: "2026-08-27T14:00:00.000Z",
  organizer: "organizer@example.test",
  location: "Private room",
  snippet: "Private preview",
  cancelled: false
});
const full = Object.freeze({
  ...summary,
  bodyText: "PRIVATE_CALENDAR_BODY_41de",
  attendees: ["attendee@example.test"]
});

function provider(overrides: Record<string, unknown> = {}) {
  return {
    target,
    health: async () => ({ status: "ready" as const }),
    calendars: async ({ accountId }: { accountId: string }) => [{ accountId, calendarId: "calendar-1", name: "Private calendar", canEdit: true, isDefault: true }],
    events: async ({ accountId, calendarId }: { accountId: string; calendarId: string }) => ({ accountId, calendarId, events: [summary] }),
    read: async () => full,
    ...overrides
  };
}

function tools(calendarReadProvider: ReturnType<typeof provider>) {
  return materializeHostCapabilityPlugin(calendarReadHostCapabilityPlugin, {
    stateDir: "/tmp/odinn-calendar-test",
    approvalStore: createApprovalStore(),
    calendarReadProvider
  });
}

test("calendar read tools are bounded, scoped, live-only, and capability declared", async () => {
  const available = tools(provider());
  assert.deepEqual([...available.keys()], ["calendar.calendars", "calendar.events", "calendar.read"]);
  const calendars = await available.get("calendar.calendars")?.execute({ accountId: "account-1" }, {});
  const events = await available.get("calendar.events")?.execute({
    accountId: "account-1",
    calendarId: "calendar-1",
    start: "2026-08-27T00:00:00.000Z",
    end: "2026-08-28T00:00:00.000Z",
    limit: 10
  }, {});
  const read = await available.get("calendar.read")?.execute({ accountId: "account-1", calendarId: "calendar-1", eventId: "event-1" }, {});
  assert.equal(calendars.health.status, "ready");
  assert.equal(calendars.calendars[0].name, "Private calendar");
  assert.equal(events.events[0].contentTrust, undefined);
  assert.equal(events.contentTrust, "external-untrusted");
  assert.equal(read.bodyText, full.bodyText);
  assert.equal(read.contentTrust, "external-untrusted");
  assert.deepEqual(CALENDAR_READ_PLUGIN_MANIFEST.tools[0]?.capabilities, ["calendar.read", "network.access", "secret.reference.use"]);

  const durableInput = projectDurableToolInput("calendar.events", {
    accountId: "account-1",
    calendarId: "calendar-1",
    start: "2026-08-27T00:00:00.000Z",
    end: "2026-08-28T00:00:00.000Z",
    limit: 10
  }) as Record<string, unknown>;
  const durableOutput = projectDurableToolOutput("calendar.read", read) as Record<string, unknown>;
  assert.deepEqual(Object.keys(durableInput).sort(), ["limit", "targetDigest"]);
  assert.match(String(durableInput.targetDigest), /^sha256:/u);
  assert.match(String(durableOutput.payloadDigest), /^sha256:/u);
  assert.equal(durableOutput.contentUnavailableOnReplay, true);
  assert.equal(durableOutput.attendeeCount, 1);
  assert.doesNotMatch(JSON.stringify({ durableInput, durableOutput }), /PRIVATE|account-1|calendar-1|event-1|example\.test/u);
});

test("calendar provider responses and target generation fail closed", async () => {
  await assert.rejects(
    () => tools(provider({ calendars: async () => [
      { accountId: "account-1", calendarId: "duplicate", name: "a", canEdit: false, isDefault: false },
      { accountId: "account-1", calendarId: "duplicate", name: "b", canEdit: false, isDefault: false }
    ] })).get("calendar.calendars")?.execute({ accountId: "account-1" }, {}),
    /duplicate calendar identifiers/u
  );
  await assert.rejects(
    () => tools(provider({ events: async () => ({ accountId: "account-2", calendarId: "calendar-1", events: [] }) })).get("calendar.events")?.execute({
      accountId: "account-1", calendarId: "calendar-1", start: "2026-08-27T00:00:00.000Z", end: "2026-08-28T00:00:00.000Z"
    }, {}),
    /target does not match/u
  );
  await assert.rejects(
    () => tools(provider({ read: async () => ({ ...full, end: full.start }) })).get("calendar.read")?.execute({ accountId: "account-1", calendarId: "calendar-1", eventId: "event-1" }, {}),
    /end must be after/u
  );
  await assert.rejects(
    () => tools(provider({ events: async () => ({ accountId: "account-1", calendarId: "calendar-1", events: [{ ...summary, bodyText: "not allowed in a summary" }] }) })).get("calendar.events")?.execute({
      accountId: "account-1", calendarId: "calendar-1", start: "2026-08-27T00:00:00.000Z", end: "2026-08-28T00:00:00.000Z"
    }, {}),
    /unsupported field: bodyText/u
  );

  let generation = "generation-1";
  const rotating = {
    ...provider(),
    get target() { return { providerId: "calendar-fixture", generation }; },
    events: async () => {
      generation = "generation-2";
      return { accountId: "account-1", calendarId: "calendar-1", events: [summary] };
    }
  };
  await assert.rejects(
    () => tools(rotating).get("calendar.events")?.execute({
      accountId: "account-1", calendarId: "calendar-1", start: "2026-08-27T00:00:00.000Z", end: "2026-08-28T00:00:00.000Z"
    }, {}),
    /target changed/u
  );
});

test("calendar input ranges, resources, policy, and provider lifecycle are explicit", async () => {
  const available = tools(provider());
  const resource = available.get("calendar.read")?.resourceForInput?.({ accountId: "account-1", calendarId: "calendar-1", eventId: "event-1" });
  assert.deepEqual(Object.keys(resource ?? {}).sort(), ["accountDigest", "calendarDigest", "eventDigest", "generationDigest", "providerDigest"]);
  assert.doesNotMatch(JSON.stringify(resource), /account-1|calendar-1|event-1|calendar-fixture|generation-1/u);
  assert.throws(() => available.get("calendar.read")?.resourceForInput?.({ accountId: "unsafe\u0000", calendarId: "calendar-1", eventId: "event-1" }), /bounded visible provider identifier/u);
  await assert.rejects(() => available.get("calendar.events")?.execute({
    accountId: "account-1", calendarId: "calendar-1", start: "2026-08-28T00:00:00.000Z", end: "2026-08-27T00:00:00.000Z"
  }, {}), /range must be positive/u);

  const root = await mkdtemp(join(tmpdir(), "odinn-calendar-provider-"));
  let closed = false;
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir: join(root, ".odinn"),
    enableCalendar: true,
    calendarReadProvider: { ...provider(), close: () => { closed = true; } }
  });
  try {
    const tool = registry.get("calendar.read");
    const request = { tool: "calendar.read", input: { accountId: "account-1", calendarId: "calendar-1", eventId: "event-1" } };
    assert.equal(evaluateTaskPolicy({ policy: createDefaultPolicy({ allowedCapabilities: ["calendar.read", "network.access"] }), request, tool }).allowed, false);
    assert.equal(evaluateTaskPolicy({ policy: createDefaultPolicy({ allowedCapabilities: ["calendar.read", "network.access", "secret.reference.use"] }), request, tool }).allowed, true);
    registry.close();
    assert.equal(closed, true);
    await assert.rejects(() => tool.execute(request.input, {}), /provider is closed/u);
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
