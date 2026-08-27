import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { CalendarReadProvider, CalendarEvent, CalendarEventSummary, CalendarSummary } from "./calendar.ts";
import type { EmailAccount, EmailMessage, EmailMessageSummary, EmailReadProvider } from "./email.ts";
import { isAllowedCredentialEnvironmentKey } from "./environment.ts";
import { dnsLookupAll, isPrivateAddress, pinnedAddressLookup } from "./web.ts";

const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH_HOST = "graph.microsoft.com";
const GRAPH_DEFAULT_TOKEN_ENV = "ODINN_MICROSOFT_GRAPH_TOKEN";
const GRAPH_TIMEOUT_MS = 15_000;
const GRAPH_MAX_RESPONSE_BYTES = 1_048_576;
const GRAPH_MAX_CONCURRENT_REQUESTS = 4;
const GRAPH_MAX_EMAIL_RESULTS = 100;
const GRAPH_MAX_CALENDARS = 64;
const GRAPH_MAX_EVENTS = 100;
const GRAPH_ACCOUNT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const GRAPH_ALLOWED_CONFIG_FIELDS = new Set(["enabled", "tokenEnv", "accountId", "resources"]);
const GRAPH_RESOURCES = ["email", "calendar"] as const;
const GRAPH_QUERY_KEYS = new Set(["$select", "$top", "$search", "$filter", "$orderby", "startDateTime", "endDateTime"]);

const EMAIL_SUMMARY_SELECT = "id,conversationId,subject,from,receivedDateTime,bodyPreview,hasAttachments";
const EMAIL_FULL_SELECT = `${EMAIL_SUMMARY_SELECT},toRecipients,ccRecipients,body`;
const CALENDAR_SELECT = "id,name,canEdit,isDefaultCalendar";
const EVENT_SUMMARY_SELECT = "id,subject,start,end,organizer,location,bodyPreview,isCancelled";
const EVENT_FULL_SELECT = `${EVENT_SUMMARY_SELECT},body,attendees`;

let activeGraphRequests = 0;
type GraphRequestWaiter = {
  active: boolean;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
  readonly resolve: () => void;
};
const graphRequestWaiters: GraphRequestWaiter[] = [];

export type MicrosoftGraphResource = typeof GRAPH_RESOURCES[number];

export type MicrosoftGraphReadConfig = Readonly<{
  enabled: boolean;
  tokenEnv: string;
  accountId: string;
  resources: readonly MicrosoftGraphResource[];
}>;

export type MicrosoftGraphReadDiagnostic = Readonly<{
  enabled: boolean;
  configured: boolean;
  accountCount: 0 | 1;
  emailEnabled: boolean;
  calendarEnabled: boolean;
  endpoint: "graph.microsoft.com";
  readOnly: true;
  mutationsAvailable: false;
  redirectsAllowed: false;
}>;

export type MicrosoftGraphReadTarget = Readonly<{
  providerId: "microsoft-graph";
  generation: string;
}>;

export type MicrosoftGraphHttpRequest = Readonly<{
  url: URL;
  address: string;
  headers: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}>;

export type MicrosoftGraphHttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Buffer;
}>;

export type MicrosoftGraphHttpTransport = (request: MicrosoftGraphHttpRequest) => Promise<MicrosoftGraphHttpResponse>;

export interface MicrosoftGraphReadAdapter {
  readonly target: MicrosoftGraphReadTarget;
  readonly diagnostic: MicrosoftGraphReadDiagnostic;
  readonly emailProvider?: EmailReadProvider;
  readonly calendarProvider?: CalendarReadProvider;
}

type MicrosoftGraphClientOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  resolveNetworkAddresses?: (hostname: string) => Promise<string[]>;
  transport?: MicrosoftGraphHttpTransport;
  __testOnlyRequestTimeoutMs?: number;
}>;

type GraphRecord = Record<string, unknown>;

function ordinaryObject(value: unknown, label: string): GraphRecord {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be an ordinary object`);
  }
  return value as GraphRecord;
}

function rejectUnknownFields(value: GraphRecord, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
}

export function normalizeMicrosoftGraphReadConfig(value: unknown = {}): MicrosoftGraphReadConfig {
  const source = ordinaryObject(value, "Microsoft Graph read configuration");
  rejectUnknownFields(source, GRAPH_ALLOWED_CONFIG_FIELDS, "Microsoft Graph read configuration");
  if (source.enabled !== undefined && typeof source.enabled !== "boolean") throw new Error("Microsoft Graph read configuration.enabled must be boolean");
  const enabled = source.enabled === true;
  if (source.tokenEnv !== undefined && typeof source.tokenEnv !== "string") {
    throw new Error("Microsoft Graph read configuration.tokenEnv must be an allowed credential environment reference");
  }
  const tokenEnv = source.tokenEnv ?? GRAPH_DEFAULT_TOKEN_ENV;
  if (!isAllowedCredentialEnvironmentKey(tokenEnv)) {
    throw new Error("Microsoft Graph read configuration.tokenEnv must be an allowed credential environment reference");
  }
  if (source.accountId !== undefined && typeof source.accountId !== "string") {
    throw new Error("Microsoft Graph read configuration.accountId must be a Microsoft directory object ID");
  }
  const accountId = source.accountId === undefined ? "" : normalizeAccountId(source.accountId);
  if (source.resources !== undefined && !Array.isArray(source.resources)) {
    throw new Error("Microsoft Graph read configuration.resources must be an array");
  }
  const resources = (source.resources ?? []).map((resource, index) => normalizeResource(resource, `Microsoft Graph read configuration.resources[${index}]`));
  if (new Set(resources).size !== resources.length) throw new Error("Microsoft Graph read configuration.resources must not contain duplicates");
  const orderedResources = GRAPH_RESOURCES.filter((resource) => resources.includes(resource));
  if (enabled && !accountId) throw new Error("enabled Microsoft Graph read access requires one explicit accountId");
  if (enabled && orderedResources.length === 0) throw new Error("enabled Microsoft Graph read access requires at least one explicit resource");
  return Object.freeze({ enabled, tokenEnv, accountId, resources: Object.freeze(orderedResources) });
}

export function diagnoseMicrosoftGraphReadIntegration(
  value: unknown = {},
  environment: NodeJS.ProcessEnv = process.env
): MicrosoftGraphReadDiagnostic {
  const config = normalizeMicrosoftGraphReadConfig(value);
  return Object.freeze({
    enabled: config.enabled,
    configured: config.enabled && validToken(environment[config.tokenEnv]) !== undefined,
    accountCount: config.accountId ? 1 : 0,
    emailEnabled: config.enabled && config.resources.includes("email"),
    calendarEnabled: config.enabled && config.resources.includes("calendar"),
    endpoint: GRAPH_HOST,
    readOnly: true,
    mutationsAvailable: false,
    redirectsAllowed: false
  });
}

export function createMicrosoftGraphReadAdapter(
  value: unknown = {},
  options: MicrosoftGraphClientOptions = {}
): MicrosoftGraphReadAdapter {
  const config = normalizeMicrosoftGraphReadConfig(value);
  if (!config.enabled) throw new Error("Microsoft Graph read integration is disabled");
  const environment = options.environment ?? process.env;
  const resolveNetworkAddresses = options.resolveNetworkAddresses ?? dnsLookupAll;
  const transport = options.transport ?? nativeMicrosoftGraphTransport;
  const requestTimeoutMs = normalizeRequestTimeout(options.__testOnlyRequestTimeoutMs);
  const generation = digest(`microsoft-graph-read:${config.tokenEnv}:${config.accountId}:${config.resources.join(",")}`);
  const target = Object.freeze({ providerId: "microsoft-graph" as const, generation });
  const diagnostic = diagnoseMicrosoftGraphReadIntegration(config, environment);
  const health = async () => Object.freeze({ status: validToken(environment[config.tokenEnv]) === undefined ? "unavailable" as const : "ready" as const });
  const request = async (
    segments: readonly string[],
    query: Readonly<Record<string, string>>,
    signal?: AbortSignal,
    extraHeaders: Readonly<Record<string, string>> = {}
  ) => {
    const token = validToken(environment[config.tokenEnv]);
    if (token === undefined) throw new Error("Microsoft Graph read credential is not configured");
    const url = graphUrl(config.accountId, segments, query);
    return requestMicrosoftGraphJson(url, token, {
      signal,
      resolveNetworkAddresses,
      transport,
      requestTimeoutMs,
      extraHeaders
    });
  };
  const requireAccount = (accountId: unknown) => {
    if (normalizeAccountId(accountId) !== config.accountId) throw new Error("Microsoft Graph account is outside the configured read scope");
  };

  const emailProvider: EmailReadProvider | undefined = config.resources.includes("email") ? Object.freeze({
    target,
    health,
    accounts: async ({ signal }) => {
      const raw = ordinaryObject(await request([], { "$select": "id,displayName,mail,userPrincipalName" }, signal), "Microsoft Graph account response");
      const responseAccount = normalizeAccountId(raw.id);
      if (responseAccount !== config.accountId) throw new Error("Microsoft Graph account response does not match the configured account");
      const address = emailAddressValue(raw.mail ?? raw.userPrincipalName, "Microsoft Graph account address");
      const account: EmailAccount = Object.freeze({
        accountId: config.accountId,
        address,
        ...(raw.displayName === null || raw.displayName === undefined ? {} : { displayName: graphText(raw.displayName, "Microsoft Graph account displayName", 256) }),
        provider: "microsoft-graph",
        status: "ready"
      });
      return Object.freeze([account]);
    },
    search: async ({ accountId, query, limit, cursor, signal }) => {
      requireAccount(accountId);
      if (cursor !== undefined) throw new Error("Microsoft Graph email pagination cursors are not supported");
      const raw = await request(["messages"], {
        "$search": JSON.stringify(query),
        "$top": String(limit),
        "$select": EMAIL_SUMMARY_SELECT
      }, signal, { "consistency-level": "eventual" });
      const messages = graphCollection(raw, "Microsoft Graph message search", limit)
        .map((entry, index) => normalizeEmailSummary(entry, `Microsoft Graph message search[${index}]`));
      return Object.freeze({ accountId: config.accountId, messages: Object.freeze(messages) });
    },
    read: async ({ accountId, messageId, signal }) => {
      requireAccount(accountId);
      const requestedMessageId = graphIdentifier(messageId, "Microsoft Graph messageId");
      const raw = ordinaryObject(await request(["messages", requestedMessageId], { "$select": EMAIL_FULL_SELECT }, signal), "Microsoft Graph message response");
      const message = normalizeEmailMessage(raw, config.accountId, "Microsoft Graph message");
      if (message.messageId !== requestedMessageId) throw new Error("Microsoft Graph message response does not match the requested message");
      return message;
    },
    thread: async ({ accountId, threadId, limit, signal }) => {
      requireAccount(accountId);
      const requestedThreadId = graphIdentifier(threadId, "Microsoft Graph threadId");
      const raw = await request(["messages"], {
        "$filter": `conversationId eq '${escapeODataString(requestedThreadId)}'`,
        "$orderby": "receivedDateTime asc",
        "$top": String(limit),
        "$select": EMAIL_FULL_SELECT
      }, signal);
      const messages = graphCollection(raw, "Microsoft Graph thread response", limit)
        .map((entry, index) => normalizeEmailMessage(entry, config.accountId, `Microsoft Graph thread response[${index}]`));
      if (messages.some((message) => message.threadId !== requestedThreadId)) throw new Error("Microsoft Graph thread response contains a different conversation");
      return Object.freeze({ accountId: config.accountId, threadId: requestedThreadId, messages: Object.freeze(messages) });
    }
  }) : undefined;

  const calendarProvider: CalendarReadProvider | undefined = config.resources.includes("calendar") ? Object.freeze({
    target,
    health,
    calendars: async ({ accountId, signal }) => {
      requireAccount(accountId);
      const raw = await request(["calendars"], { "$top": String(GRAPH_MAX_CALENDARS), "$select": CALENDAR_SELECT }, signal);
      return Object.freeze(graphCollection(raw, "Microsoft Graph calendar response", GRAPH_MAX_CALENDARS)
        .map((entry, index) => normalizeCalendar(entry, config.accountId, `Microsoft Graph calendar response[${index}]`)));
    },
    events: async ({ accountId, calendarId, start, end, limit, signal }) => {
      requireAccount(accountId);
      const requestedCalendarId = graphIdentifier(calendarId, "Microsoft Graph calendarId");
      const raw = await request(["calendars", requestedCalendarId, "calendarView"], {
        startDateTime: start,
        endDateTime: end,
        "$top": String(limit),
        "$select": EVENT_SUMMARY_SELECT
      }, signal);
      const events = graphCollection(raw, "Microsoft Graph calendar view response", limit)
        .map((entry, index) => normalizeEventSummary(entry, config.accountId, requestedCalendarId, `Microsoft Graph calendar view response[${index}]`));
      return Object.freeze({ accountId: config.accountId, calendarId: requestedCalendarId, events: Object.freeze(events) });
    },
    read: async ({ accountId, calendarId, eventId, signal }) => {
      requireAccount(accountId);
      const requestedCalendarId = graphIdentifier(calendarId, "Microsoft Graph calendarId");
      const requestedEventId = graphIdentifier(eventId, "Microsoft Graph eventId");
      const raw = ordinaryObject(await request(["calendars", requestedCalendarId, "events", requestedEventId], { "$select": EVENT_FULL_SELECT }, signal), "Microsoft Graph event response");
      const event = normalizeEvent(raw, config.accountId, requestedCalendarId, "Microsoft Graph event");
      if (event.eventId !== requestedEventId) throw new Error("Microsoft Graph event response does not match the requested event");
      return event;
    }
  }) : undefined;

  return Object.freeze({ target, diagnostic, ...(emailProvider ? { emailProvider } : {}), ...(calendarProvider ? { calendarProvider } : {}) });
}

function normalizeAccountId(value: unknown): string {
  if (typeof value !== "string" || !GRAPH_ACCOUNT_ID.test(value)) {
    throw new Error("Microsoft Graph read configuration.accountId must be a Microsoft directory object ID");
  }
  return value.toLowerCase();
}

function normalizeResource(value: unknown, label: string): MicrosoftGraphResource {
  if (typeof value !== "string" || !GRAPH_RESOURCES.includes(value as MicrosoftGraphResource)) throw new Error(`${label} must be email or calendar`);
  return value as MicrosoftGraphResource;
}

function validToken(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 8_192
    && !/[\s\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function graphUrl(accountId: string, suffix: readonly string[], query: Readonly<Record<string, string>>): URL {
  const segments = ["v1.0", "users", accountId, ...suffix].map((segment) => encodeURIComponent(graphIdentifier(segment, "Microsoft Graph path segment")));
  const url = new URL(`/${segments.join("/")}`, GRAPH_ORIGIN);
  for (const [key, value] of Object.entries(query)) {
    if (!GRAPH_QUERY_KEYS.has(key) || typeof value !== "string") throw new Error("Microsoft Graph query is outside the bounded read surface");
    url.searchParams.set(key, value);
  }
  return assertTrustedMicrosoftGraphUrl(url, accountId);
}

function assertTrustedMicrosoftGraphUrl(url: URL, accountId: string): URL {
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== GRAPH_HOST || (url.port && url.port !== "443") || url.username || url.password || url.hash) {
    throw new Error("Microsoft Graph read access only permits the trusted graph.microsoft.com origin");
  }
  const prefix = `/v1.0/users/${accountId}`;
  if (!url.pathname.startsWith(prefix) || url.pathname.includes("//") || /(?:^|\/)\.\.?(?:\/|$)/u.test(url.pathname)) {
    throw new Error("Microsoft Graph path is outside the configured read-only account surface");
  }
  const suffix = url.pathname.slice(prefix.length);
  const keys = new Set([...url.searchParams.keys()]);
  const exactKeys = (...expected: string[]) => keys.size === expected.length && expected.every((key) => keys.has(key));
  const boundedTop = () => /^\d{1,3}$/u.test(url.searchParams.get("$top") ?? "") && Number(url.searchParams.get("$top")) <= 100;
  const allowed = suffix === "" ? exactKeys("$select")
    : suffix === "/messages" ? (
        (exactKeys("$search", "$top", "$select") || exactKeys("$filter", "$orderby", "$top", "$select")) && boundedTop()
      )
      : /^\/messages\/[^/]+$/u.test(suffix) ? exactKeys("$select")
        : suffix === "/calendars" ? exactKeys("$top", "$select") && boundedTop()
          : /^\/calendars\/[^/]+\/calendarView$/u.test(suffix)
            ? exactKeys("startDateTime", "endDateTime", "$top", "$select") && boundedTop()
            : /^\/calendars\/[^/]+\/events\/[^/]+$/u.test(suffix) ? exactKeys("$select") : false;
  if (!allowed) throw new Error("Microsoft Graph path or query is outside the bounded read surface");
  return url;
}

async function requestMicrosoftGraphJson(
  url: URL,
  token: string,
  options: Readonly<{
    signal?: AbortSignal;
    resolveNetworkAddresses: (hostname: string) => Promise<string[]>;
    transport: MicrosoftGraphHttpTransport;
    requestTimeoutMs: number;
    extraHeaders: Readonly<Record<string, string>>;
  }>
): Promise<unknown> {
  const headers = Object.freeze({
    accept: "application/json",
    authorization: `Bearer ${token}`,
    prefer: 'outlook.body-content-type="text", outlook.timezone="UTC"',
    "user-agent": "Odinn-Forge/microsoft-graph-read",
    ...options.extraHeaders
  });
  const budget = createGraphRequestBudget(options.signal, options.requestTimeoutMs);
  let acquired = false;
  try {
    await acquireGraphRequestSlot(budget.signal);
    acquired = true;
    if (budget.signal.aborted) throw budget.failure();
    const operation = performMicrosoftGraphRequest(url, headers, {
      signal: budget.signal,
      resolveNetworkAddresses: options.resolveNetworkAddresses,
      transport: options.transport
    });
    void operation.then(releaseGraphRequestSlot, releaseGraphRequestSlot);
    acquired = false;
    const response = await settleWithinGraphRequestBudget(operation, budget);
    if (response.status >= 300 && response.status < 400) throw new Error("Microsoft Graph redirects are refused");
    if (response.status < 200 || response.status >= 300) throw new Error(`Microsoft Graph returned status ${response.status}`);
    if (!Buffer.isBuffer(response.body)) throw new Error("Microsoft Graph response body was invalid");
    if (response.body.byteLength > GRAPH_MAX_RESPONSE_BYTES) throw new Error("Microsoft Graph response exceeded the bounded size limit");
    const contentType = firstHeader(response.headers["content-type"]);
    if (!contentType.toLowerCase().includes("json")) throw new Error("Microsoft Graph response was not JSON");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)); }
    catch { throw new Error("Microsoft Graph returned invalid JSON"); }
  } catch (error) {
    if (budget.signal.aborted) throw budget.failure();
    throw error;
  } finally {
    if (acquired) releaseGraphRequestSlot();
    budget.dispose();
  }
}

async function performMicrosoftGraphRequest(
  url: URL,
  headers: Readonly<Record<string, string>>,
  options: Readonly<{
    signal: AbortSignal;
    resolveNetworkAddresses: (hostname: string) => Promise<string[]>;
    transport: MicrosoftGraphHttpTransport;
  }>
): Promise<MicrosoftGraphHttpResponse> {
  let addresses: string[];
  try {
    addresses = await options.resolveNetworkAddresses(url.hostname);
  } catch {
    if (options.signal.aborted) throw abortError();
    throw new Error("Microsoft Graph DNS validation failed");
  }
  if (options.signal.aborted) throw abortError();
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((address) => typeof address !== "string" || isIP(address) === 0 || isPrivateAddress(address))) {
    throw new Error("Microsoft Graph DNS validation refused a non-public address");
  }
  try {
    const response = await options.transport({ url, address: addresses[0]!, headers, signal: options.signal });
    if (options.signal.aborted) throw abortError();
    return response;
  } catch (error) {
    if (options.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
    throw new Error("Microsoft Graph request failed");
  }
}

async function nativeMicrosoftGraphTransport(input: MicrosoftGraphHttpRequest): Promise<MicrosoftGraphHttpResponse> {
  return new Promise((resolveResponse, rejectResponse) => {
    if (input.signal?.aborted) return rejectResponse(abortError());
    let settled = false;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const finish = (error?: Error, response?: MicrosoftGraphHttpResponse) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      if (error) rejectResponse(error); else resolveResponse(response!);
    };
    const request = httpsRequest(input.url, {
      method: "GET",
      headers: input.headers,
      lookup: pinnedAddressLookup(input.address),
      rejectUnauthorized: true,
      agent: false
    }, (response) => {
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > GRAPH_MAX_RESPONSE_BYTES) {
          response.destroy();
          request.destroy();
          finish(new Error("Microsoft Graph response exceeded the bounded size limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(undefined, {
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
      response.on("error", () => finish(new Error("Microsoft Graph response failed")));
    });
    const onAbort = () => {
      request.destroy();
      finish(abortError());
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    request.on("error", () => finish(new Error("Microsoft Graph request failed")));
    request.end();
  });
}

type GraphRequestBudget = Readonly<{
  signal: AbortSignal;
  failure: () => Error;
  dispose: () => void;
}>;

function normalizeRequestTimeout(value: unknown): number {
  if (value === undefined) return GRAPH_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > GRAPH_TIMEOUT_MS) {
    throw new Error(`Microsoft Graph request timeout must be an integer from 1 through ${GRAPH_TIMEOUT_MS}`);
  }
  return Number(value);
}

function createGraphRequestBudget(callerSignal: AbortSignal | undefined, timeoutMs: number): GraphRequestBudget {
  const controller = new AbortController();
  let reason: "cancelled" | "timed-out" | undefined;
  const abort = (nextReason: "cancelled" | "timed-out") => {
    if (controller.signal.aborted) return;
    reason = nextReason;
    controller.abort();
  };
  const onCallerAbort = () => abort("cancelled");
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const deadline = setTimeout(() => abort("timed-out"), timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    failure: () => reason === "timed-out" ? new Error("Microsoft Graph request timed out") : abortError(),
    dispose: () => {
      clearTimeout(deadline);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  });
}

function settleWithinGraphRequestBudget<T>(operation: Promise<T>, budget: GraphRequestBudget): Promise<T> {
  if (budget.signal.aborted) return Promise.reject(budget.failure());
  return new Promise<T>((resolveOperation, rejectOperation) => {
    let settled = false;
    const succeed = (result: T) => {
      if (settled) return;
      settled = true;
      budget.signal.removeEventListener("abort", onAbort);
      resolveOperation(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      budget.signal.removeEventListener("abort", onAbort);
      rejectOperation(error);
    };
    const onAbort = () => fail(budget.failure());
    budget.signal.addEventListener("abort", onAbort, { once: true });
    operation.then(succeed, fail);
  });
}

async function acquireGraphRequestSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  if (activeGraphRequests < GRAPH_MAX_CONCURRENT_REQUESTS) {
    activeGraphRequests += 1;
    return;
  }
  await new Promise<void>((resolveSlot, rejectSlot) => {
    const waiter: GraphRequestWaiter = {
      active: true,
      signal,
      resolve: () => {
        if (!waiter.active) return;
        waiter.active = false;
        signal?.removeEventListener("abort", waiter.onAbort!);
        resolveSlot();
      }
    };
    waiter.onAbort = () => {
      if (!waiter.active) return;
      waiter.active = false;
      const index = graphRequestWaiters.indexOf(waiter);
      if (index >= 0) graphRequestWaiters.splice(index, 1);
      rejectSlot(abortError());
    };
    graphRequestWaiters.push(waiter);
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
  });
}

function releaseGraphRequestSlot(): void {
  let waiter = graphRequestWaiters.shift();
  while (waiter && !waiter.active) waiter = graphRequestWaiters.shift();
  if (waiter) {
    waiter.resolve();
    return;
  }
  activeGraphRequests = Math.max(0, activeGraphRequests - 1);
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function graphCollection(value: unknown, label: string, limit: number): GraphRecord[] {
  const source = ordinaryObject(value, label);
  if (!Array.isArray(source.value)) throw new Error(`${label}.value must be an array`);
  if (source.value.length > limit) throw new Error(`${label} exceeds the requested result limit`);
  return source.value.map((entry, index) => ordinaryObject(entry, `${label}.value[${index}]`));
}

function graphIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a bounded visible identifier`);
  }
  return value;
}

function graphText(value: unknown, label: string, maximum: number, optional = false): string | undefined {
  if (value === null || value === undefined) {
    if (optional) return undefined;
    throw new Error(`${label} is required`);
  }
  if (typeof value !== "string" || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error(`${label} must be text`);
  return utf8Prefix(value, maximum);
}

function utf8Prefix(value: string, maximum: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximum) return value;
  let prefix = bytes.subarray(0, maximum).toString("utf8");
  if (prefix.endsWith("\ufffd")) prefix = prefix.slice(0, -1);
  return prefix;
}

function emailAddressValue(value: unknown, label: string): string {
  const address = graphText(value, label, 320);
  if (!address || /\s/u.test(address)) throw new Error(`${label} must be a bounded address`);
  return address;
}

function nestedEmailAddress(value: unknown, label: string): string {
  const source = ordinaryObject(value, label);
  return emailAddressValue(source.address, `${label}.address`);
}

function recipientList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error(`${label} must contain at most 64 recipients`);
  return Object.freeze(value.map((entry, index) => {
    const source = ordinaryObject(entry, `${label}[${index}]`);
    return nestedEmailAddress(source.emailAddress, `${label}[${index}].emailAddress`);
  }));
}

function graphTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)) {
    throw new Error(`${label} must be a UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a UTC timestamp`);
  return new Date(parsed).toISOString();
}

function graphEventTimestamp(value: unknown, label: string): string {
  const source = ordinaryObject(value, label);
  if (source.timeZone !== "UTC") throw new Error(`${label}.timeZone must be UTC`);
  if (typeof source.dateTime !== "string" || source.dateTime.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/u.test(source.dateTime)) {
    throw new Error(`${label}.dateTime must be a UTC timestamp`);
  }
  return graphTimestamp(`${source.dateTime}Z`, `${label}.dateTime`);
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function normalizeEmailSummary(value: unknown, label: string): EmailMessageSummary {
  const source = ordinaryObject(value, label);
  const from = ordinaryObject(source.from, `${label}.from`);
  return Object.freeze({
    messageId: graphIdentifier(source.id, `${label}.id`),
    threadId: graphIdentifier(source.conversationId, `${label}.conversationId`),
    subject: graphText(source.subject ?? "", `${label}.subject`, 8_192)!,
    from: nestedEmailAddress(from.emailAddress, `${label}.from.emailAddress`),
    receivedAt: graphTimestamp(source.receivedDateTime, `${label}.receivedDateTime`),
    ...(source.bodyPreview === null || source.bodyPreview === undefined ? {} : { snippet: graphText(source.bodyPreview, `${label}.bodyPreview`, 8_192) }),
    hasAttachments: requiredBoolean(source.hasAttachments, `${label}.hasAttachments`)
  });
}

function normalizeEmailMessage(value: unknown, accountId: string, label: string): EmailMessage {
  const source = ordinaryObject(value, label);
  const summary = normalizeEmailSummary(source, label);
  const body = ordinaryObject(source.body, `${label}.body`);
  if (body.contentType !== "text") throw new Error(`${label}.body.contentType must be text`);
  return Object.freeze({
    ...summary,
    accountId,
    to: recipientList(source.toRecipients, `${label}.toRecipients`),
    cc: recipientList(source.ccRecipients ?? [], `${label}.ccRecipients`),
    bodyText: graphText(body.content ?? "", `${label}.body.content`, 128 * 1024)!,
    attachments: Object.freeze([])
  });
}

function normalizeCalendar(value: unknown, accountId: string, label: string): CalendarSummary {
  const source = ordinaryObject(value, label);
  return Object.freeze({
    accountId,
    calendarId: graphIdentifier(source.id, `${label}.id`),
    name: graphText(source.name, `${label}.name`, 512)!,
    canEdit: requiredBoolean(source.canEdit, `${label}.canEdit`),
    isDefault: requiredBoolean(source.isDefaultCalendar, `${label}.isDefaultCalendar`)
  });
}

function optionalEventAddress(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  const source = ordinaryObject(value, label);
  if (source.emailAddress === null || source.emailAddress === undefined) return undefined;
  return nestedEmailAddress(source.emailAddress, `${label}.emailAddress`);
}

function optionalLocation(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  const source = ordinaryObject(value, label);
  return source.displayName === null || source.displayName === undefined ? undefined : graphText(source.displayName, `${label}.displayName`, 4_096);
}

function normalizeEventSummary(value: unknown, accountId: string, calendarId: string, label: string): CalendarEventSummary {
  const source = ordinaryObject(value, label);
  const organizer = optionalEventAddress(source.organizer, `${label}.organizer`);
  const location = optionalLocation(source.location, `${label}.location`);
  return Object.freeze({
    accountId,
    calendarId,
    eventId: graphIdentifier(source.id, `${label}.id`),
    subject: graphText(source.subject ?? "", `${label}.subject`, 4_096)!,
    start: graphEventTimestamp(source.start, `${label}.start`),
    end: graphEventTimestamp(source.end, `${label}.end`),
    ...(organizer === undefined ? {} : { organizer }),
    ...(location === undefined ? {} : { location }),
    ...(source.bodyPreview === null || source.bodyPreview === undefined ? {} : { snippet: graphText(source.bodyPreview, `${label}.bodyPreview`, 8_192) }),
    cancelled: requiredBoolean(source.isCancelled, `${label}.isCancelled`)
  });
}

function normalizeEvent(value: unknown, accountId: string, calendarId: string, label: string): CalendarEvent {
  const source = ordinaryObject(value, label);
  const summary = normalizeEventSummary(source, accountId, calendarId, label);
  const body = ordinaryObject(source.body, `${label}.body`);
  if (body.contentType !== "text") throw new Error(`${label}.body.contentType must be text`);
  if (!Array.isArray(source.attendees) || source.attendees.length > 256) throw new Error(`${label}.attendees must contain at most 256 entries`);
  const attendees = source.attendees.map((entry, index) => {
    const attendee = ordinaryObject(entry, `${label}.attendees[${index}]`);
    return nestedEmailAddress(attendee.emailAddress, `${label}.attendees[${index}].emailAddress`);
  });
  return Object.freeze({
    ...summary,
    bodyText: graphText(body.content ?? "", `${label}.body.content`, 128 * 1024)!,
    attendees: Object.freeze(attendees)
  });
}

function escapeODataString(value: string): string {
  return value.replaceAll("'", "''");
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function abortError(): Error {
  const error = new Error("Microsoft Graph read cancelled");
  error.name = "AbortError";
  return error;
}
