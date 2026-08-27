export type CalendarProviderTarget = Readonly<{
  providerId: string;
  generation: string;
}>;

export type CalendarProviderHealth = Readonly<{
  status: "ready" | "degraded" | "unavailable" | "unknown";
  checkedAt?: string;
}>;

export type CalendarSummary = Readonly<{
  accountId: string;
  calendarId: string;
  name: string;
  canEdit: boolean;
  isDefault: boolean;
}>;

export type CalendarEventSummary = Readonly<{
  accountId: string;
  calendarId: string;
  eventId: string;
  subject: string;
  start: string;
  end: string;
  organizer?: string;
  location?: string;
  snippet?: string;
  cancelled: boolean;
}>;

export type CalendarEvent = CalendarEventSummary & Readonly<{
  bodyText: string;
  attendees: readonly string[];
}>;

export type CalendarEventPage = Readonly<{
  accountId: string;
  calendarId: string;
  events: readonly CalendarEventSummary[];
}>;

export type CalendarReadProvider = Readonly<{
  target: CalendarProviderTarget;
  health?: (request: { signal?: AbortSignal }) => Promise<CalendarProviderHealth>;
  calendars: (request: { accountId: string; signal?: AbortSignal }) => Promise<readonly CalendarSummary[]>;
  events: (request: { accountId: string; calendarId: string; start: string; end: string; limit: number; signal?: AbortSignal }) => Promise<CalendarEventPage>;
  read: (request: { accountId: string; calendarId: string; eventId: string; signal?: AbortSignal }) => Promise<CalendarEvent>;
  close?: () => void | Promise<void>;
}>;

type CalendarRecord = Record<string, unknown>;

const MAX_IDENTIFIER_BYTES = 256;
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_CALENDARS = 64;
const MAX_EVENTS = 100;
const MAX_ATTENDEES = 256;
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1_000;

function assertRecord(value: unknown, label: string): CalendarRecord {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be an ordinary object`);
  }
  return value as CalendarRecord;
}

function rejectUnknownFields(value: CalendarRecord, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
}

function boundedString(value: unknown, label: string, maximum = MAX_TEXT_BYTES): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}

function boundedIdentifier(value: unknown, label: string): string {
  const identifier = boundedString(value, label, MAX_IDENTIFIER_BYTES);
  if (!identifier || /[\u0000-\u001f\u007f]/u.test(identifier)) throw new Error(`${label} must be a bounded visible identifier`);
  return identifier;
}

function boundedTimestamp(value: unknown, label: string): string {
  const timestamp = boundedString(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(milliseconds).toISOString();
}

function boundedLimit(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > MAX_EVENTS) throw new Error(`${label} must be an integer from 1 through ${MAX_EVENTS}`);
  return Number(value);
}

function abortIfRequested(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error("calendar operation aborted"), { name: "AbortError" });
}

function targetSnapshot(provider: CalendarReadProvider): CalendarProviderTarget {
  const target = assertRecord(provider.target, "calendar provider target");
  rejectUnknownFields(target, new Set(["providerId", "generation"]), "calendar provider target");
  return Object.freeze({
    providerId: boundedIdentifier(target.providerId, "calendar provider target.providerId"),
    generation: boundedIdentifier(target.generation, "calendar provider target.generation")
  });
}

function normalizeHealth(value: unknown): CalendarProviderHealth {
  const source = assertRecord(value, "calendar provider health");
  rejectUnknownFields(source, new Set(["status", "checkedAt"]), "calendar provider health");
  if (!(["ready", "degraded", "unavailable", "unknown"] as const).includes(source.status as CalendarProviderHealth["status"])) {
    throw new Error("calendar provider health.status is unsupported");
  }
  return Object.freeze({
    status: source.status as CalendarProviderHealth["status"],
    ...(source.checkedAt === undefined ? {} : { checkedAt: boundedTimestamp(source.checkedAt, "calendar provider health.checkedAt") })
  });
}

function assertStableTarget(provider: CalendarReadProvider, expected: CalendarProviderTarget): void {
  const actual = targetSnapshot(provider);
  if (actual.providerId !== expected.providerId || actual.generation !== expected.generation) throw new Error("calendar provider target changed during operation");
}

function normalizeCalendar(value: unknown): CalendarSummary {
  const source = assertRecord(value, "calendar");
  rejectUnknownFields(source, new Set(["accountId", "calendarId", "name", "canEdit", "isDefault"]), "calendar");
  if (typeof source.canEdit !== "boolean" || typeof source.isDefault !== "boolean") throw new Error("calendar flags must be boolean");
  return Object.freeze({
    accountId: boundedIdentifier(source.accountId, "calendar.accountId"),
    calendarId: boundedIdentifier(source.calendarId, "calendar.calendarId"),
    name: boundedString(source.name, "calendar.name", 512),
    canEdit: source.canEdit,
    isDefault: source.isDefault
  });
}

function normalizeAttendees(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_ATTENDEES) throw new Error(`calendar attendees must contain at most ${MAX_ATTENDEES} entries`);
  return Object.freeze(value.map((entry, index) => boundedString(entry, `calendar attendees[${index}]`, 320)));
}

function normalizeEvent(value: unknown, full: boolean): CalendarEventSummary | CalendarEvent {
  const source = assertRecord(value, "calendar event");
  const allowed = new Set([
    "accountId", "calendarId", "eventId", "subject", "start", "end", "organizer", "location", "snippet", "cancelled",
    ...(full ? ["bodyText", "attendees"] : [])
  ]);
  rejectUnknownFields(source, allowed, "calendar event");
  if (typeof source.cancelled !== "boolean") throw new Error("calendar event.cancelled must be boolean");
  const start = boundedTimestamp(source.start, "calendar event.start");
  const end = boundedTimestamp(source.end, "calendar event.end");
  if (Date.parse(end) <= Date.parse(start)) throw new Error("calendar event.end must be after calendar event.start");
  const common = {
    accountId: boundedIdentifier(source.accountId, "calendar event.accountId"),
    calendarId: boundedIdentifier(source.calendarId, "calendar event.calendarId"),
    eventId: boundedIdentifier(source.eventId, "calendar event.eventId"),
    subject: boundedString(source.subject, "calendar event.subject", 4_096),
    start,
    end,
    ...(source.organizer === undefined ? {} : { organizer: boundedString(source.organizer, "calendar event.organizer", 320) }),
    ...(source.location === undefined ? {} : { location: boundedString(source.location, "calendar event.location", 4_096) }),
    ...(source.snippet === undefined ? {} : { snippet: boundedString(source.snippet, "calendar event.snippet", 8_192) }),
    cancelled: source.cancelled
  };
  if (!full) return Object.freeze(common);
  return Object.freeze({
    ...common,
    bodyText: boundedString(source.bodyText, "calendar event.bodyText"),
    attendees: normalizeAttendees(source.attendees)
  });
}

export async function listCalendars(provider: CalendarReadProvider, input: unknown, signal?: AbortSignal) {
  const source = assertRecord(input, "calendar.calendars input");
  rejectUnknownFields(source, new Set(["accountId"]), "calendar.calendars input");
  const accountId = boundedIdentifier(source.accountId, "calendar.calendars accountId");
  const target = targetSnapshot(provider);
  abortIfRequested(signal);
  const raw = await provider.calendars({ accountId, signal });
  abortIfRequested(signal);
  assertStableTarget(provider, target);
  if (!Array.isArray(raw) || raw.length > MAX_CALENDARS) throw new Error(`calendar provider returned more than ${MAX_CALENDARS} calendars`);
  const calendars = raw.map(normalizeCalendar);
  if (calendars.some((calendar) => calendar.accountId !== accountId)) throw new Error("calendar provider returned a different account");
  if (new Set(calendars.map((calendar) => calendar.calendarId)).size !== calendars.length) throw new Error("calendar provider returned duplicate calendar identifiers");
  const health = provider.health
    ? normalizeHealth(await provider.health({ signal }))
    : Object.freeze({ status: "unknown" as const });
  abortIfRequested(signal);
  assertStableTarget(provider, target);
  return Object.freeze({ type: "calendar.calendars" as const, providerId: target.providerId, accountId, health, calendars: Object.freeze(calendars), contentTrust: "external-untrusted" as const });
}

export async function listCalendarEvents(provider: CalendarReadProvider, input: unknown, signal?: AbortSignal) {
  const source = assertRecord(input, "calendar.events input");
  rejectUnknownFields(source, new Set(["accountId", "calendarId", "start", "end", "limit"]), "calendar.events input");
  const accountId = boundedIdentifier(source.accountId, "calendar.events accountId");
  const calendarId = boundedIdentifier(source.calendarId, "calendar.events calendarId");
  const start = boundedTimestamp(source.start, "calendar.events start");
  const end = boundedTimestamp(source.end, "calendar.events end");
  const range = Date.parse(end) - Date.parse(start);
  if (range <= 0 || range > MAX_RANGE_MS) throw new Error("calendar.events range must be positive and no longer than 366 days");
  const limit = boundedLimit(source.limit, "calendar.events limit", 50);
  const target = targetSnapshot(provider);
  abortIfRequested(signal);
  const raw = assertRecord(await provider.events({ accountId, calendarId, start, end, limit, signal }), "calendar event page");
  abortIfRequested(signal);
  assertStableTarget(provider, target);
  rejectUnknownFields(raw, new Set(["accountId", "calendarId", "events"]), "calendar event page");
  if (raw.accountId !== accountId || raw.calendarId !== calendarId) throw new Error("calendar event page target does not match the request");
  if (!Array.isArray(raw.events) || raw.events.length > limit) throw new Error("calendar event page exceeds the requested limit");
  const events = raw.events.map((event) => normalizeEvent(event, false) as CalendarEventSummary);
  if (events.some((event) => event.accountId !== accountId || event.calendarId !== calendarId)) throw new Error("calendar event page contains a different target");
  if (new Set(events.map((event) => event.eventId)).size !== events.length) throw new Error("calendar event page contains duplicate event identifiers");
  return Object.freeze({ type: "calendar.events" as const, providerId: target.providerId, accountId, calendarId, events: Object.freeze(events), contentTrust: "external-untrusted" as const });
}

export async function readCalendarEvent(provider: CalendarReadProvider, input: unknown, signal?: AbortSignal) {
  const source = assertRecord(input, "calendar.read input");
  rejectUnknownFields(source, new Set(["accountId", "calendarId", "eventId"]), "calendar.read input");
  const request = {
    accountId: boundedIdentifier(source.accountId, "calendar.read accountId"),
    calendarId: boundedIdentifier(source.calendarId, "calendar.read calendarId"),
    eventId: boundedIdentifier(source.eventId, "calendar.read eventId")
  };
  const target = targetSnapshot(provider);
  abortIfRequested(signal);
  const event = normalizeEvent(await provider.read({ ...request, signal }), true) as CalendarEvent;
  abortIfRequested(signal);
  assertStableTarget(provider, target);
  if (event.accountId !== request.accountId || event.calendarId !== request.calendarId || event.eventId !== request.eventId) {
    throw new Error("calendar event target does not match the request");
  }
  return Object.freeze({ type: "calendar.read" as const, providerId: target.providerId, ...event, contentTrust: "external-untrusted" as const });
}
