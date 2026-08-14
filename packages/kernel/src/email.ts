const MAX_ID_BYTES = 256;
const MAX_PROVIDER_ID_BYTES = 128;
const MAX_GENERATION_BYTES = 128;
const MAX_QUERY_BYTES = 2_048;
const MAX_CURSOR_BYTES = 4_096;
const MAX_BODY_BYTES = 128 * 1024;
const MAX_SNIPPET_BYTES = 8 * 1024;
const MAX_ACCOUNTS = 32;
const MAX_SEARCH_RESULTS = 100;
const MAX_THREAD_MESSAGES = 100;
const MAX_RECIPIENTS = 64;
const MAX_ATTACHMENTS = 32;

export type EmailProviderTarget = Readonly<{
  providerId: string;
  generation: string;
}>;

export type EmailProviderHealth = Readonly<{
  status: "ready" | "degraded" | "unavailable" | "unknown";
  checkedAt?: string;
}>;

export type EmailAccount = Readonly<{
  accountId: string;
  address: string;
  displayName?: string;
  provider: string;
  status: "ready" | "reauth-required" | "unavailable";
}>;

export type EmailMessageSummary = Readonly<{
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  receivedAt: string;
  snippet?: string;
  hasAttachments: boolean;
}>;

export type EmailAttachment = Readonly<{
  name: string;
  mimeType?: string;
  sizeBytes?: number;
}>;

export type EmailMessage = EmailMessageSummary & Readonly<{
  accountId: string;
  to: readonly string[];
  cc: readonly string[];
  bodyText: string;
  attachments: readonly EmailAttachment[];
}>;

export type EmailSearchResponse = Readonly<{
  accountId: string;
  nextCursor?: string;
  messages: readonly EmailMessageSummary[];
}>;

export type EmailThreadResponse = Readonly<{
  accountId: string;
  threadId: string;
  messages: readonly EmailMessage[];
}>;

export type EmailReadProvider = Readonly<{
  target: EmailProviderTarget;
  health?: (request: { signal?: AbortSignal }) => Promise<EmailProviderHealth>;
  accounts: (request: { signal?: AbortSignal }) => Promise<readonly EmailAccount[]>;
  search: (request: { accountId: string; query: string; limit: number; cursor?: string; signal?: AbortSignal }) => Promise<EmailSearchResponse>;
  read: (request: { accountId: string; messageId: string; signal?: AbortSignal }) => Promise<EmailMessage>;
  thread: (request: { accountId: string; threadId: string; limit: number; signal?: AbortSignal }) => Promise<EmailThreadResponse>;
  close?: () => void | Promise<void>;
}>;

type EmailRecord = Record<string, unknown>;

function assertRecord(value: unknown, label: string): EmailRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as EmailRecord;
}

function rejectUnknownFields(value: EmailRecord, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a bounded visible string`);
  }
  return value;
}

function boundedBody(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be bounded email text`);
  }
  return value;
}

function optionalBoundedString(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, maximum);
}

function boundedDate(value: unknown, label: string): string {
  const result = boundedString(value, label, 128);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${label} must be an ISO timestamp`);
  return result;
}

function boundedIdentifier(value: unknown, label: string, maximum = MAX_ID_BYTES): string {
  return boundedString(value, label, maximum);
}

function boundedLimit(value: unknown, label: string, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > MAX_SEARCH_RESULTS) throw new Error(`${label} must be an integer from 1 to ${MAX_SEARCH_RESULTS}`);
  return Number(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("email operation aborted");
}

function targetSnapshot(provider: EmailReadProvider): EmailProviderTarget {
  const target = assertRecord(provider.target, "email provider target");
  return Object.freeze({
    providerId: boundedIdentifier(target.providerId, "email provider target.providerId", MAX_PROVIDER_ID_BYTES),
    generation: boundedIdentifier(target.generation, "email provider target.generation", MAX_GENERATION_BYTES)
  });
}

function assertStableTarget(provider: EmailReadProvider, expected: EmailProviderTarget): void {
  const actual = targetSnapshot(provider);
  if (actual.providerId !== expected.providerId || actual.generation !== expected.generation) {
    throw new Error("email provider target changed during operation");
  }
}

function normalizeHealth(value: unknown): EmailProviderHealth {
  const source = assertRecord(value, "email provider health");
  rejectUnknownFields(source, new Set(["status", "checkedAt"]), "email provider health");
  const status = boundedString(source.status, "email provider health.status", 32) as EmailProviderHealth["status"];
  if (!["ready", "degraded", "unavailable", "unknown"].includes(status)) throw new Error("email provider health.status is unsupported");
  const checkedAt = source.checkedAt === undefined ? undefined : boundedDate(source.checkedAt, "email provider health.checkedAt");
  return Object.freeze({ status, ...(checkedAt === undefined ? {} : { checkedAt }) });
}

function normalizeAccount(value: unknown): EmailAccount {
  const source = assertRecord(value, "email account");
  rejectUnknownFields(source, new Set(["accountId", "address", "displayName", "provider", "status"]), "email account");
  const status = boundedString(source.status, "email account.status", 32) as EmailAccount["status"];
  if (!["ready", "reauth-required", "unavailable"].includes(status)) throw new Error("email account.status is unsupported");
  return Object.freeze({
    accountId: boundedIdentifier(source.accountId, "email account.accountId"),
    address: boundedString(source.address, "email account.address", 320),
    ...(source.displayName === undefined ? {} : { displayName: boundedString(source.displayName, "email account.displayName", 256) }),
    provider: boundedIdentifier(source.provider, "email account.provider", MAX_PROVIDER_ID_BYTES),
    status
  });
}

function normalizeRecipientList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_RECIPIENTS) throw new Error(`${label} must contain at most ${MAX_RECIPIENTS} recipients`);
  const recipients = value.map((item, index) => boundedString(item, `${label}[${index}]`, 320));
  if (new Set(recipients).size !== recipients.length) throw new Error(`${label} must not contain duplicate recipients`);
  return Object.freeze(recipients);
}

function normalizeAttachments(value: unknown): readonly EmailAttachment[] {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) throw new Error(`email attachments must contain at most ${MAX_ATTACHMENTS} entries`);
  const attachments = value.map((item, index) => {
    const source = assertRecord(item, `email attachments[${index}]`);
    rejectUnknownFields(source, new Set(["name", "mimeType", "sizeBytes"]), `email attachments[${index}]`);
    if (source.sizeBytes !== undefined && (!Number.isSafeInteger(source.sizeBytes) || Number(source.sizeBytes) < 0 || Number(source.sizeBytes) > 100 * 1024 * 1024)) {
      throw new Error(`email attachments[${index}].sizeBytes is out of bounds`);
    }
    return Object.freeze({
      name: boundedString(source.name, `email attachments[${index}].name`, 256),
      ...(source.mimeType === undefined ? {} : { mimeType: boundedString(source.mimeType, `email attachments[${index}].mimeType`, 128) }),
      ...(source.sizeBytes === undefined ? {} : { sizeBytes: Number(source.sizeBytes) })
    });
  });
  return Object.freeze(attachments);
}

function normalizeSummary(value: unknown, accountId: string, allowMessageFields = false): EmailMessageSummary {
  const source = assertRecord(value, "email message summary");
  rejectUnknownFields(source, new Set([
    "accountId", "messageId", "threadId", "subject", "from", "receivedAt", "snippet", "hasAttachments",
    ...(allowMessageFields ? ["to", "cc", "bodyText", "attachments"] : [])
  ]), "email message summary");
  if (source.accountId !== undefined && source.accountId !== accountId) throw new Error("email message account does not match the requested account");
  if (typeof source.hasAttachments !== "boolean") throw new Error("email message hasAttachments must be boolean");
  return Object.freeze({
    messageId: boundedIdentifier(source.messageId, "email message.messageId"),
    threadId: boundedIdentifier(source.threadId, "email message.threadId"),
    subject: boundedBody(source.subject, "email message.subject", 8 * 1024),
    from: boundedString(source.from, "email message.from", 320),
    receivedAt: boundedDate(source.receivedAt, "email message.receivedAt"),
    ...(source.snippet === undefined ? {} : { snippet: boundedBody(source.snippet, "email message.snippet", MAX_SNIPPET_BYTES) }),
    hasAttachments: source.hasAttachments
  });
}

function normalizeMessage(value: unknown, accountId: string): EmailMessage {
  const source = assertRecord(value, "email message");
  const summary = normalizeSummary(source, accountId, true);
  rejectUnknownFields(source, new Set(["accountId", "messageId", "threadId", "subject", "from", "receivedAt", "snippet", "hasAttachments", "to", "cc", "bodyText", "attachments"]), "email message");
  return Object.freeze({
    ...summary,
    accountId,
    to: normalizeRecipientList(source.to, "email message.to"),
    cc: normalizeRecipientList(source.cc ?? [], "email message.cc"),
    bodyText: boundedBody(source.bodyText, "email message.bodyText", MAX_BODY_BYTES),
    attachments: normalizeAttachments(source.attachments ?? [])
  });
}

function normalizeInput(input: unknown, label: string, allowed: ReadonlySet<string>): EmailRecord {
  const source = assertRecord(input, label);
  rejectUnknownFields(source, allowed, label);
  return source;
}

function searchInput(input: unknown) {
  const source = normalizeInput(input, "email.search input", new Set(["accountId", "query", "limit", "cursor"]));
  const query = boundedBody(source.query, "email.search query", MAX_QUERY_BYTES);
  if (query.trim().length === 0) throw new Error("email.search query must not be empty");
  return {
    accountId: boundedIdentifier(source.accountId, "email.search accountId"),
    query,
    limit: boundedLimit(source.limit, "email.search limit", 20),
    cursor: optionalBoundedString(source.cursor, "email.search cursor", MAX_CURSOR_BYTES)
  };
}

function readInput(input: unknown) {
  const source = normalizeInput(input, "email.read input", new Set(["accountId", "messageId"]));
  return {
    accountId: boundedIdentifier(source.accountId, "email.read accountId"),
    messageId: boundedIdentifier(source.messageId, "email.read messageId")
  };
}

function threadInput(input: unknown) {
  const source = normalizeInput(input, "email.thread input", new Set(["accountId", "threadId", "limit"]));
  return {
    accountId: boundedIdentifier(source.accountId, "email.thread accountId"),
    threadId: boundedIdentifier(source.threadId, "email.thread threadId"),
    limit: boundedLimit(source.limit, "email.thread limit", 50)
  };
}

export async function listEmailAccounts(provider: EmailReadProvider, signal?: AbortSignal) {
  const target = targetSnapshot(provider);
  throwIfAborted(signal);
  const rawAccounts = await provider.accounts({ signal });
  throwIfAborted(signal);
  assertStableTarget(provider, target);
  if (!Array.isArray(rawAccounts) || rawAccounts.length > MAX_ACCOUNTS) throw new Error(`email provider returned more than ${MAX_ACCOUNTS} accounts`);
  const accounts = rawAccounts.map(normalizeAccount);
  if (new Set(accounts.map((account) => account.accountId)).size !== accounts.length) throw new Error("email provider returned duplicate account identifiers");
  const health = provider.health
    ? normalizeHealth(await provider.health({ signal }))
    : Object.freeze({ status: "unknown" as const });
  throwIfAborted(signal);
  assertStableTarget(provider, target);
  return {
    type: "email.accounts" as const,
    providerId: target.providerId,
    health,
    accounts,
    contentTrust: "operator-configured-metadata" as const
  };
}

export async function searchEmail(provider: EmailReadProvider, input: unknown, signal?: AbortSignal) {
  const request = searchInput(input);
  const target = targetSnapshot(provider);
  throwIfAborted(signal);
  const result = await provider.search({ ...request, signal });
  throwIfAborted(signal);
  assertStableTarget(provider, target);
  const source = assertRecord(result, "email search response");
  rejectUnknownFields(source, new Set(["accountId", "nextCursor", "messages"]), "email search response");
  if (source.accountId !== request.accountId) throw new Error("email search response account does not match the requested account");
  if (!Array.isArray(source.messages) || source.messages.length > request.limit) throw new Error("email search response exceeds the requested result limit");
  const messages = source.messages.map((message) => normalizeSummary(message, request.accountId));
  const nextCursor = optionalBoundedString(source.nextCursor, "email search response.nextCursor", MAX_CURSOR_BYTES);
  return { type: "email.search" as const, providerId: target.providerId, accountId: request.accountId, messages, ...(nextCursor === undefined ? {} : { nextCursor }), contentTrust: "external-untrusted" as const };
}

export async function readEmail(provider: EmailReadProvider, input: unknown, signal?: AbortSignal) {
  const request = readInput(input);
  const target = targetSnapshot(provider);
  throwIfAborted(signal);
  const message = normalizeMessage(await provider.read({ ...request, signal }), request.accountId);
  throwIfAborted(signal);
  assertStableTarget(provider, target);
  return { type: "email.read" as const, providerId: target.providerId, ...message, contentTrust: "external-untrusted" as const };
}

export async function threadEmail(provider: EmailReadProvider, input: unknown, signal?: AbortSignal) {
  const request = threadInput(input);
  const target = targetSnapshot(provider);
  throwIfAborted(signal);
  const result = assertRecord(await provider.thread({ ...request, signal }), "email thread response");
  throwIfAborted(signal);
  assertStableTarget(provider, target);
  rejectUnknownFields(result, new Set(["accountId", "threadId", "messages"]), "email thread response");
  if (result.accountId !== request.accountId || result.threadId !== request.threadId) throw new Error("email thread response target does not match the requested account or thread");
  if (!Array.isArray(result.messages) || result.messages.length > request.limit) throw new Error("email thread response exceeds the requested message limit");
  const messages = result.messages.map((message) => normalizeMessage(message, request.accountId));
  if (messages.some((message) => message.threadId !== request.threadId)) throw new Error("email thread response contains a different thread");
  return { type: "email.thread" as const, providerId: target.providerId, accountId: request.accountId, threadId: request.threadId, messages, contentTrust: "external-untrusted" as const };
}
