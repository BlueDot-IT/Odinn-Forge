import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  CALENDAR_READ_PLUGIN_MANIFEST,
  EMAIL_READ_PLUGIN_MANIFEST,
  createApprovalStore,
  createAuditStore,
  createBuiltInRegistry,
  createMicrosoftGraphReadAdapter,
  createRunLedger,
  createStateBackup,
  diagnoseMicrosoftGraphReadIntegration,
  ensureStateCompatibility,
  materializeHostCapabilityPlugin,
  normalizeMicrosoftGraphReadConfig,
  runTask,
  SqliteJobStore,
  SqliteRecordStore,
  SqliteWorkflowStore,
  calendarReadHostCapabilityPlugin,
  emailReadHostCapabilityPlugin,
  type MicrosoftGraphHttpRequest,
  type MicrosoftGraphHttpResponse
} from "../packages/kernel/src/index.ts";
import { CronStore } from "../apps/gateway/src/server.ts";
import { createDefaultPolicy, evaluateTaskPolicy } from "../packages/policy/src/index.ts";
import { projectDurableToolInput, projectDurableToolOutput, workflowDefinitionDigest } from "../packages/protocol/src/index.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const accountId = "11111111-1111-4111-8111-111111111111";
const tokenEnv = "ODINN_TEST_MICROSOFT_GRAPH_TOKEN";
const syntheticToken = "synthetic-graph-test-token";
const environment = { [tokenEnv]: syntheticToken };
const config = Object.freeze({ enabled: true, tokenEnv, accountId, resources: ["email", "calendar"] });
const publicResolver = async () => ["93.184.216.34"];

const message = {
  id: "message-1",
  conversationId: "conversation-1",
  subject: "PRIVATE_GRAPH_SUBJECT_7f2d",
  from: { emailAddress: { address: "sensitive.sender@example.test" } },
  receivedDateTime: "2026-08-26T12:00:00Z",
  bodyPreview: "Private email preview",
  hasAttachments: false,
  toRecipients: [{ emailAddress: { address: "operator@example.test" } }],
  ccRecipients: [],
  body: { contentType: "text", content: "PRIVATE_GRAPH_EMAIL_BODY_63ac" }
};

const event = {
  id: "event-1",
  subject: "PRIVATE_GRAPH_EVENT_8be1",
  start: { dateTime: "2026-08-27T13:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-08-27T14:00:00.0000000", timeZone: "UTC" },
  organizer: { emailAddress: { address: "organizer@example.test" } },
  location: { displayName: "Private room" },
  bodyPreview: "Private event preview",
  isCancelled: false,
  body: { contentType: "text", content: "PRIVATE_GRAPH_EVENT_BODY_219d" },
  attendees: [{ emailAddress: { address: "attendee@example.test" } }]
};

function jsonResponse(value: unknown, status = 200): MicrosoftGraphHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: Buffer.from(JSON.stringify(value), "utf8")
  };
}

function fixture(request: MicrosoftGraphHttpRequest): MicrosoftGraphHttpResponse {
  const path = request.url.pathname;
  if (path === `/v1.0/users/${accountId}`) return jsonResponse({
    id: accountId,
    displayName: "Private Operator",
    mail: "operator@example.test",
    userPrincipalName: "operator@example.test"
  });
  if (path === `/v1.0/users/${accountId}/messages` && request.url.searchParams.has("$search")) return jsonResponse({ value: [message] });
  if (path === `/v1.0/users/${accountId}/messages` && request.url.searchParams.has("$filter")) return jsonResponse({ value: [message] });
  if (path.startsWith(`/v1.0/users/${accountId}/messages/`)) {
    const requested = decodeURIComponent(path.slice(`/v1.0/users/${accountId}/messages/`.length));
    return jsonResponse({ ...message, id: requested });
  }
  if (path === `/v1.0/users/${accountId}/calendars`) return jsonResponse({
    value: [{ id: "calendar-1", name: "Private calendar", canEdit: true, isDefaultCalendar: true }]
  });
  if (path === `/v1.0/users/${accountId}/calendars/calendar-1/calendarView`) return jsonResponse({ value: [event] });
  if (path === `/v1.0/users/${accountId}/calendars/calendar-1/events/event-1`) return jsonResponse(event);
  return jsonResponse({ error: { message: "not found" } }, 404);
}

function adapter(requests: MicrosoftGraphHttpRequest[] = []) {
  return createMicrosoftGraphReadAdapter(config, {
    environment,
    resolveNetworkAddresses: publicResolver,
    transport: async (request) => {
      requests.push(request);
      return fixture(request);
    }
  });
}

async function initializeBackupCompatibleState(state: string): Promise<void> {
  await mkdir(state, { recursive: true });
  await writeFile(join(state, "config.json"), `${JSON.stringify({ version: 1, auditLog: "audit.jsonl" })}\n`);
  await writeFile(join(state, "records.jsonl"), "");
  await writeFile(join(state, "jobs.json"), `${JSON.stringify({ schemaVersion: 1, jobs: {} })}\n`);
  await writeFile(join(state, "approvals.json"), `${JSON.stringify({ schemaVersion: 1, approvals: [] })}\n`);
  await writeFile(join(state, "browser-recovery.json"), `${JSON.stringify({ schemaVersion: 1, status: "clear" })}\n`);
  await writeFile(join(state, "channel-bindings.json"), `${JSON.stringify({ schemaVersion: 1, bindings: {} })}\n`);
  await writeFile(join(state, "channel-dedupe.json"), `${JSON.stringify({ schemaVersion: 1, entries: {} })}\n`);
  await writeFile(join(state, "audit.jsonl"), "");
  await ensureStateCompatibility(state, { applicationVersion: "1.0.0", applicationCommit: "graph-durable-boundary" });
}

async function treePayload(rootPath: string): Promise<Buffer> {
  const files: Buffer[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(await readFile(path));
    }
  };
  await visit(rootPath);
  return Buffer.concat(files);
}

test("Microsoft Graph adapter exposes fixed-origin bounded email and calendar reads", async () => {
  const requests: MicrosoftGraphHttpRequest[] = [];
  const graph = adapter(requests);
  assert.ok(graph.emailProvider);
  assert.ok(graph.calendarProvider);

  const accounts = await graph.emailProvider!.accounts({});
  const search = await graph.emailProvider!.search({ accountId, query: 'quarterly "review"', limit: 2 });
  const read = await graph.emailProvider!.read({ accountId, messageId: "message-1" });
  const thread = await graph.emailProvider!.thread({ accountId, threadId: "conversation-1", limit: 2 });
  const calendars = await graph.calendarProvider!.calendars({ accountId });
  const events = await graph.calendarProvider!.events({
    accountId,
    calendarId: "calendar-1",
    start: "2026-08-27T00:00:00.000Z",
    end: "2026-08-28T00:00:00.000Z",
    limit: 2
  });
  const readEvent = await graph.calendarProvider!.read({ accountId, calendarId: "calendar-1", eventId: "event-1" });

  assert.equal(accounts[0]?.address, "operator@example.test");
  assert.equal(search.messages[0]?.subject, message.subject);
  assert.equal(read.bodyText, message.body.content);
  assert.equal(thread.messages[0]?.threadId, "conversation-1");
  assert.equal(calendars[0]?.calendarId, "calendar-1");
  assert.equal(events.events[0]?.start, "2026-08-27T13:00:00.000Z");
  assert.equal(readEvent.bodyText, event.body.content);
  assert.equal(requests.length, 7);
  assert.ok(requests.every((request) => request.url.origin === "https://graph.microsoft.com"));
  assert.ok(requests.every((request) => request.address === "93.184.216.34"));
  assert.ok(requests.every((request) => request.headers.authorization === `Bearer ${syntheticToken}`));
  assert.ok(requests.every((request) => !request.url.href.includes(syntheticToken)));
  assert.equal(requests[1]?.url.searchParams.get("$search"), JSON.stringify('quarterly "review"'));
  assert.equal(requests[1]?.headers["consistency-level"], "eventual");
  assert.equal(requests[3]?.url.searchParams.get("$filter"), "conversationId eq 'conversation-1'");
  assert.equal(requests[5]?.url.searchParams.get("$top"), "2");
});

test("the built-in Graph registry preserves external-untrusted account metadata trust", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "odinn-graph-registry-trust-"));
  const stateDir = join(workspace, ".odinn");
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const ledger = createRunLedger({ stateDir, workspaceRoot: workspace });
  const registry = createBuiltInRegistry({
    workspaceRoot: workspace,
    stateDir,
    auditStore,
    config: { integrations: { microsoftGraph: config }, runLedger: ledger },
    microsoftGraphReadAdapter: adapter()
  });
  try {
    const policy = createDefaultPolicy({ allowedCapabilities: ["email.read", "network.access", "secret.reference.use"] });
    const result = await runTask({
      task: { id: "graph-account-trust", tool: "email.accounts", input: {}, actor: "graph-test" },
      auditStore,
      registry,
      runLedger: ledger,
      policy
    });
    assert.equal(result.output.contentTrust, "external-untrusted");
    assert.equal(result.output.accounts[0]?.address, "operator@example.test");
  } finally {
    registry.close();
    ledger.close();
    auditStore.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Microsoft Graph configuration and diagnostics contain only references, booleans, and counts", () => {
  assert.deepEqual(normalizeMicrosoftGraphReadConfig(config), config);
  assert.throws(() => normalizeMicrosoftGraphReadConfig({ ...config, token: syntheticToken }), /unsupported field: token/u);
  assert.throws(() => normalizeMicrosoftGraphReadConfig({ ...config, tokenEnv: syntheticToken }), /allowed credential environment reference/u);
  assert.throws(() => normalizeMicrosoftGraphReadConfig({ ...config, accountId: "operator@example.test" }), /directory object ID/u);
  assert.throws(() => normalizeMicrosoftGraphReadConfig({ ...config, resources: [] }), /at least one explicit resource/u);
  assert.throws(() => normalizeMicrosoftGraphReadConfig({ ...config, resources: ["email", "email"] }), /must not contain duplicates/u);
  assert.throws(() => normalizeMicrosoftGraphReadConfig({ ...config, resources: ["files"] }), /email or calendar/u);
  assert.deepEqual(diagnoseMicrosoftGraphReadIntegration(config, environment), {
    enabled: true,
    configured: true,
    accountCount: 1,
    emailEnabled: true,
    calendarEnabled: true,
    endpoint: "graph.microsoft.com",
    readOnly: true,
    mutationsAvailable: false,
    redirectsAllowed: false
  });
  assert.doesNotMatch(JSON.stringify(diagnoseMicrosoftGraphReadIntegration(config, environment)), /ODINN_TEST|11111111|synthetic|operator/u);
});

test("Microsoft Graph tools bind digest-only resources and require exact capability sets", async () => {
  const graph = adapter();
  const approvalStore = createApprovalStore();
  const emailTools = materializeHostCapabilityPlugin(emailReadHostCapabilityPlugin, {
    stateDir: "/tmp/odinn-graph-email-test",
    approvalStore,
    emailReadProvider: graph.emailProvider
  });
  const calendarTools = materializeHostCapabilityPlugin(calendarReadHostCapabilityPlugin, {
    stateDir: "/tmp/odinn-graph-calendar-test",
    approvalStore,
    calendarReadProvider: graph.calendarProvider
  });
  assert.deepEqual([...emailTools.keys()], ["email.accounts", "email.search", "email.read", "email.thread"]);
  assert.deepEqual([...calendarTools.keys()], ["calendar.calendars", "calendar.events", "calendar.read"]);
  assert.deepEqual(EMAIL_READ_PLUGIN_MANIFEST.tools[2]?.capabilities, ["email.read", "network.access", "secret.reference.use"]);
  assert.deepEqual(CALENDAR_READ_PLUGIN_MANIFEST.tools.map((tool) => tool.name), ["calendar.calendars", "calendar.events", "calendar.read"]);

  const emailResource = emailTools.get("email.read")?.resourceForInput?.({ accountId, messageId: "message-1" });
  const calendarResource = calendarTools.get("calendar.read")?.resourceForInput?.({ accountId, calendarId: "calendar-1", eventId: "event-1" });
  assert.deepEqual(Object.keys(emailResource ?? {}).sort(), ["accountDigest", "generationDigest", "messageDigest", "providerDigest"]);
  assert.deepEqual(Object.keys(calendarResource ?? {}).sort(), ["accountDigest", "calendarDigest", "eventDigest", "generationDigest", "providerDigest"]);
  assert.doesNotMatch(JSON.stringify({ emailResource, calendarResource }), /11111111|message-1|calendar-1|event-1|microsoft-graph/u);

  const emailTool = emailTools.get("email.read");
  const calendarTool = calendarTools.get("calendar.read");
  const accounts = await emailTools.get("email.accounts")?.execute({}, {});
  assert.equal(accounts.contentTrust, "external-untrusted");
  assert.equal(evaluateTaskPolicy({ policy: createDefaultPolicy({ allowedCapabilities: ["email.read", "network.access"] }), request: { tool: "email.read", input: { accountId, messageId: "message-1" } }, tool: emailTool }).allowed, false);
  assert.equal(evaluateTaskPolicy({ policy: createDefaultPolicy({ allowedCapabilities: ["email.read", "network.access", "secret.reference.use"] }), request: { tool: "email.read", input: { accountId, messageId: "message-1" } }, tool: emailTool }).allowed, true);
  assert.equal(evaluateTaskPolicy({ policy: createDefaultPolicy({ allowedCapabilities: ["calendar.read", "network.access", "secret.reference.use"] }), request: { tool: "calendar.read", input: { accountId, calendarId: "calendar-1", eventId: "event-1" } }, tool: calendarTool }).allowed, true);
});

test("Microsoft Graph account and identifiers cannot widen the fixed network scope", async () => {
  const requests: MicrosoftGraphHttpRequest[] = [];
  const graph = adapter(requests);
  await assert.rejects(() => graph.emailProvider!.read({ accountId: "22222222-2222-4222-8222-222222222222", messageId: "message-1" }), /outside the configured read scope/u);
  await assert.rejects(() => graph.emailProvider!.search({ accountId, query: "x", limit: 1, cursor: "https://attacker.invalid/collect" }), /pagination cursors are not supported/u);
  const hostileId = "//attacker.invalid/%2e%2e/collect";
  const result = await graph.emailProvider!.read({ accountId, messageId: hostileId });
  assert.equal(result.messageId, hostileId);
  const request = requests.at(-1)!;
  assert.equal(request.url.origin, "https://graph.microsoft.com");
  assert.equal(request.url.pathname.split("/").length, 6);
  assert.match(request.url.pathname, /%2F%2Fattacker\.invalid%2F%252e%252e%2Fcollect$/u);
});

test("Microsoft Graph network boundary rejects private DNS, redirects, oversized bodies, and remote errors", async () => {
  let calls = 0;
  const make = (overrides: Record<string, unknown>) => createMicrosoftGraphReadAdapter(config, {
    environment,
    resolveNetworkAddresses: publicResolver,
    transport: async () => { calls += 1; return jsonResponse({}); },
    ...overrides
  });
  const privateGraph = make({ resolveNetworkAddresses: async () => ["127.0.0.1"] });
  await assert.rejects(() => privateGraph.emailProvider!.accounts({}), /non-public address/u);
  assert.equal(calls, 0);
  const mixedGraph = make({ resolveNetworkAddresses: async () => ["93.184.216.34", "169.254.169.254"] });
  await assert.rejects(() => mixedGraph.emailProvider!.accounts({}), /non-public address/u);
  assert.equal(calls, 0);

  const redirectGraph = make({ transport: async () => ({ status: 302, headers: { location: "https://attacker.invalid" }, body: Buffer.alloc(0) }) });
  await assert.rejects(() => redirectGraph.emailProvider!.accounts({}), /redirects are refused/u);
  const errorGraph = make({ transport: async () => jsonResponse({ error: { message: "PRIVATE_REMOTE_ERROR" } }, 403) });
  await assert.rejects(
    () => errorGraph.emailProvider!.accounts({}),
    (error: any) => /status 403/u.test(error.message) && !/PRIVATE_REMOTE_ERROR/u.test(error.message)
  );
  const oversizedGraph = make({ transport: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.alloc(1_048_577, 0x20) }) });
  await assert.rejects(() => oversizedGraph.emailProvider!.accounts({}), /bounded size limit/u);
  const nonJsonGraph = make({ transport: async () => ({ status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("<html>secret</html>") }) });
  await assert.rejects(() => nonJsonGraph.emailProvider!.accounts({}), /was not JSON/u);
});

test("Microsoft Graph enforces response targets, content types, and collection limits", async () => {
  const wrongAccount = createMicrosoftGraphReadAdapter(config, {
    environment,
    resolveNetworkAddresses: publicResolver,
    transport: async () => jsonResponse({ id: "22222222-2222-4222-8222-222222222222", mail: "wrong@example.test" })
  });
  await assert.rejects(() => wrongAccount.emailProvider!.accounts({}), /does not match the configured account/u);

  const wrongBody = createMicrosoftGraphReadAdapter(config, {
    environment,
    resolveNetworkAddresses: publicResolver,
    transport: async () => jsonResponse({ ...message, body: { contentType: "html", content: "<b>unsafe</b>" } })
  });
  await assert.rejects(() => wrongBody.emailProvider!.read({ accountId, messageId: "message-1" }), /contentType must be text/u);

  const tooMany = createMicrosoftGraphReadAdapter(config, {
    environment,
    resolveNetworkAddresses: publicResolver,
    transport: async () => jsonResponse({ value: [message, { ...message, id: "message-2" }] })
  });
  await assert.rejects(() => tooMany.emailProvider!.search({ accountId, query: "x", limit: 1 }), /exceeds the requested result limit/u);
});

test("Microsoft Graph request admission and timeout are globally bounded", async (t) => {
  let startedResolvers = 0;
  let activeResolvers = 0;
  let maximumActiveResolvers = 0;
  const releases: Array<() => void> = [];
  t.after(() => { for (const release of releases.splice(0)) release(); });
  const graph = createMicrosoftGraphReadAdapter(config, {
    environment,
    __testOnlyRequestTimeoutMs: 40,
    resolveNetworkAddresses: async () => {
      startedResolvers += 1;
      activeResolvers += 1;
      maximumActiveResolvers = Math.max(maximumActiveResolvers, activeResolvers);
      return new Promise<string[]>((resolveAddresses) => releases.push(() => {
        activeResolvers -= 1;
        resolveAddresses(["93.184.216.34"]);
      }));
    },
    transport: async () => jsonResponse({})
  });
  const settled = await Promise.allSettled(Array.from({ length: 10 }, () => graph.emailProvider!.accounts({})));
  assert.equal(settled.every((result) => result.status === "rejected" && /timed out/u.test(String(result.reason?.message))), true);
  assert.equal(startedResolvers, 4);
  assert.equal(activeResolvers, 4);
  assert.equal(maximumActiveResolvers, 4);
  for (const release of releases.splice(0)) release();
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(activeResolvers, 0);
});

test("Microsoft Graph content is live-only and restart replay remains digest-only", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "odinn-microsoft-graph-read-"));
  const stateDir = join(workspace, ".odinn");
  let transportCalls = 0;
  const createGraph = () => createMicrosoftGraphReadAdapter(config, {
    environment,
    resolveNetworkAddresses: publicResolver,
    transport: async (request) => {
      transportCalls += 1;
      return fixture(request);
    }
  });
  const policy = createDefaultPolicy({ allowedCapabilities: ["email.read", "calendar.read", "network.access", "secret.reference.use"] });
  const request = { id: "graph-email-private", tool: "email.read", input: { accountId, messageId: "message-1" }, actor: "graph-test" };

  let auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  let ledger = createRunLedger({ stateDir, workspaceRoot: workspace });
  let registry = createBuiltInRegistry({
    workspaceRoot: workspace,
    stateDir,
    auditStore,
    config: { integrations: { microsoftGraph: config }, runLedger: ledger },
    microsoftGraphReadAdapter: createGraph()
  });
  try {
    const first = await runTask({ task: request, auditStore, registry, runLedger: ledger, policy });
    assert.equal(first.output.bodyText, message.body.content);
    assert.equal(transportCalls, 1);
  } finally {
    registry.close();
    ledger.close();
    auditStore.close();
  }

  auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  ledger = createRunLedger({ stateDir, workspaceRoot: workspace });
  registry = createBuiltInRegistry({
    workspaceRoot: workspace,
    stateDir,
    auditStore,
    config: { integrations: { microsoftGraph: config }, runLedger: ledger },
    microsoftGraphReadAdapter: createGraph()
  });
  try {
    const replay = await runTask({ task: request, auditStore, registry, runLedger: ledger, policy });
    assert.equal(replay.replayed, true);
    assert.equal(replay.contentUnavailableOnReplay, true);
    assert.equal("bodyText" in replay.output, false);
    assert.equal(transportCalls, 1);

    const emailInput = projectDurableToolInput("email.read", request.input) as Record<string, unknown>;
    const emailOutput = projectDurableToolOutput("email.read", { type: "email.read", providerId: "microsoft-graph", ...message, accountId, messageId: "message-1", threadId: "conversation-1", bodyText: message.body.content }) as Record<string, unknown>;
    const calendarInput = projectDurableToolInput("calendar.read", { accountId, calendarId: "calendar-1", eventId: "event-1" }) as Record<string, unknown>;
    const calendarOutput = projectDurableToolOutput("calendar.read", { type: "calendar.read", providerId: "microsoft-graph", accountId, calendarId: "calendar-1", eventId: "event-1", subject: event.subject, bodyText: event.body.content, attendees: ["attendee@example.test"] }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(emailInput).sort(), ["targetDigest"]);
    assert.deepEqual(Object.keys(calendarInput).sort(), ["targetDigest"]);
    assert.ok([emailOutput, calendarOutput].every((output) => output.contentUnavailableOnReplay === true && typeof output.payloadDigest === "string"));
    const durable = (await auditStore.readAll()).map(JSON.stringify).join("\n");
    assert.doesNotMatch(durable, /PRIVATE_GRAPH|example\.test|11111111|message-1|conversation-1|calendar-1|event-1|synthetic-graph/u);
  } finally {
    registry.close();
    ledger.close();
    auditStore.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("public Graph requests validate semantic live input before completed replay", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "odinn-graph-pre-replay-validation-"));
  const stateDir = join(workspace, ".odinn");
  let transportCalls = 0;
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const ledger = createRunLedger({ stateDir, workspaceRoot: workspace });
  const registry = createBuiltInRegistry({
    workspaceRoot: workspace,
    stateDir,
    auditStore,
    config: { integrations: { microsoftGraph: config }, runLedger: ledger },
    microsoftGraphReadAdapter: createMicrosoftGraphReadAdapter(config, {
      environment,
      resolveNetworkAddresses: publicResolver,
      transport: async (request) => {
        transportCalls += 1;
        return fixture(request);
      }
    })
  });
  const policy = createDefaultPolicy({ allowedCapabilities: ["email.read", "calendar.read", "network.access", "secret.reference.use"] });
  try {
    const searchInput = { accountId, query: "semantic replay binding", limit: 1 };
    const first = await runTask({
      task: { id: "graph-search-semantic-replay", tool: "email.search", input: searchInput, actor: "graph-test" },
      auditStore, registry, runLedger: ledger, policy
    });
    assert.equal(first.replayed, undefined);
    const projected = projectDurableToolInput("email.search", searchInput) as Record<string, unknown>;
    await assert.rejects(() => runTask({
      task: {
        id: "graph-search-semantic-replay",
        tool: "email.search",
        input: {
          accountId,
          limit: 1,
          queryDigest: projected.queryDigest,
          queryBytes: projected.queryBytes
        },
        actor: "graph-test"
      },
      auditStore, registry, runLedger: ledger, policy
    }), /email\.search input\.(?:queryDigest is not allowed|query is required)/u);
    assert.equal(transportCalls, 1, "forged persistence metadata must not replay or call Graph");

    const replay = await runTask({
      task: { id: "graph-search-semantic-replay", tool: "email.search", input: searchInput, actor: "graph-test" },
      auditStore, registry, runLedger: ledger, policy
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.contentUnavailableOnReplay, true);
    assert.equal(transportCalls, 1, "an exact valid completed request remains provider-no-replay");

    await assert.rejects(() => runTask({
      task: {
        id: "graph-calendar-missing-live-range",
        tool: "calendar.events",
        input: { accountId, calendarId: "calendar-1", targetDigest: "sha256:" + "0".repeat(64), limit: 1 },
        actor: "graph-test"
      },
      auditStore, registry, runLedger: ledger, policy
    }), /calendar\.events input\.(?:targetDigest is not allowed|start is required)/u);
    assert.equal(transportCalls, 1);
  } finally {
    registry.close();
    ledger.close();
    auditStore.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Graph-derived agent answers stay live while sessions and ordinary backups retain only a placeholder", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-graph-session-retention-"));
  const stateDir = join(temporary, "state");
  const backup = join(temporary, "backup");
  const finalSentinel = "SENTINEL_GRAPH_MODEL_ANSWER_7e41";
  const providerRequests: any[] = [];
  const provider = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    providerRequests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(providerRequests.length === 1 ? {
      id: "graph-agent-tool-call",
      choices: [{ message: { role: "assistant", content: "", tool_calls: [{
        id: "read-private-email",
        type: "function",
        function: { name: "email.read", arguments: JSON.stringify({ accountId, messageId: "message-1" }) }
      }] } }]
    } : {
      id: "graph-agent-final",
      choices: [{ message: { role: "assistant", content: `${finalSentinel}: ${message.subject} / ${message.body.content}` } }]
    }));
  });
  await new Promise<void>((resolveListen) => provider.listen(0, "127.0.0.1", resolveListen));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  let auditStore: ReturnType<typeof createAuditStore> | undefined;
  let ledger: ReturnType<typeof createRunLedger> | undefined;
  let registry: ReturnType<typeof createBuiltInRegistry> | undefined;
  try {
    await initializeBackupCompatibleState(stateDir);
    auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
    ledger = createRunLedger({ stateDir, workspaceRoot: temporary });
    registry = createBuiltInRegistry({
      workspaceRoot: temporary,
      stateDir,
      auditStore,
      config: {
        defaultModel: "synthetic:graph-model",
        providers: { synthetic: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: ["graph-model"] } },
        integrations: { microsoftGraph: config },
        runLedger: ledger
      },
      microsoftGraphReadAdapter: adapter()
    });
    const policy = createDefaultPolicy({ allowedCapabilities: ["agent.run", "session.write", "session.read", "email.read", "network.access", "secret.reference.use"] });
    const created = await runTask({ task: { id: "graph-session-create", tool: "session.create", input: { title: "Graph retention" }, actor: "graph-test" }, auditStore, registry, runLedger: ledger, policy });
    const sessionId = String(created.output.id);
    const live = await runTask({
      task: {
        id: "graph-agent-live-session",
        tool: "agent.run",
        input: { sessionId, model: "synthetic:graph-model", messages: [{ role: "user", content: "Read the selected message." }] },
        actor: "graph-test"
      },
      auditStore, registry, runLedger: ledger, policy
    });
    assert.match(live.output.content, new RegExp(finalSentinel, "u"));
    assert.match(providerRequests[1].messages.find((entry: any) => entry.role === "tool")?.content ?? "", /PRIVATE_GRAPH_EMAIL_BODY/u);
    assert.equal(live.output.durableSessionProjection.contentUnavailable, true);
    assert.doesNotMatch(live.output.durableSessionProjection.content, /PRIVATE_GRAPH|SENTINEL_GRAPH_MODEL/u);

    await runTask({
      task: {
        id: "graph-session-save-placeholder",
        tool: "session.message",
        input: {
          sessionId,
          role: "assistant",
          content: live.output.content,
          contentRetention: live.output.durableSessionProjection,
          model: live.output.model,
          provider: live.output.provider,
          source: "synthetic-console"
        },
        actor: "graph-test"
      },
      auditStore, registry, runLedger: ledger, policy
    });
    const saved = await runTask({ task: { id: "graph-session-read-placeholder", tool: "session.read", input: { sessionId }, actor: "graph-test" }, auditStore, registry, runLedger: ledger, policy });
    assert.equal(saved.output.messages[0].content, live.output.durableSessionProjection.content);
    assert.equal(saved.output.messages[0].contentRetention.contentUnavailable, true);

    registry.close(); registry = undefined;
    ledger.close(); ledger = undefined;
    auditStore.close(); auditStore = undefined;
    await createStateBackup(stateDir, backup, { applicationVersion: "1.1.2", applicationCommit: "graph-session-retention" });
    for (const payload of [await treePayload(stateDir), await treePayload(backup)]) {
      for (const sentinel of [finalSentinel, message.subject, message.body.content]) {
        assert.equal(payload.includes(sentinel), false, `durable session state retained ${sentinel}`);
      }
    }
  } finally {
    registry?.close();
    ledger?.close();
    auditStore?.close();
    await new Promise<void>((resolveClose, rejectClose) => provider.close((error) => error ? rejectClose(error) : resolveClose()));
    await rm(temporary, { recursive: true, force: true });
  }
});

test("startup quarantines an exactly attributable pre-fix Graph-derived session reply and its durable copies", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-graph-session-upgrade-"));
  const stateDir = join(temporary, "state");
  const backup = join(temporary, "backup");
  const legacyReply = "SENTINEL_LEGACY_GRAPH_SESSION_REPLY_5a7c";
  const sessionMessageRunId = "legacy-graph-session-message-save";
  let auditStore: ReturnType<typeof createAuditStore> | undefined;
  let ledger: ReturnType<typeof createRunLedger> | undefined;
  let registry: ReturnType<typeof createBuiltInRegistry> | undefined;
  try {
    await initializeBackupCompatibleState(stateDir);
    auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
    ledger = createRunLedger({ stateDir, workspaceRoot: temporary });
    registry = createBuiltInRegistry({ workspaceRoot: temporary, stateDir, auditStore, config: { runLedger: ledger } });
    const policy = createDefaultPolicy({ allowedCapabilities: ["session.write"] });
    const created = await runTask({ task: { id: "legacy-graph-session-create", tool: "session.create", input: { title: "Legacy Graph reply" }, actor: "graph-test" }, auditStore, registry, runLedger: ledger, policy });
    const sessionId = String(created.output.id);

    ledger.ensureRun({ runId: "legacy-graph-agent-run", objective: "pre-fix Graph-backed answer" });
    const parentStep = ledger.beginTool({
      runId: "legacy-graph-agent-run",
      toolName: "agent.run",
      input: { sessionId, messages: [{ role: "user", contentDigest: "sha256:" + "2".repeat(64), contentBytes: 4 }] },
      safety: { effects: ["read"] }
    });
    ledger.ensureRun({ runId: "legacy-graph-child-read", parentRunId: "legacy-graph-agent-run", objective: "pre-fix Graph child" });
    const childStep = ledger.beginTool({
      runId: "legacy-graph-child-read",
      toolName: "email.read",
      input: projectDurableToolInput("email.read", { accountId, messageId: "message-1" }),
      safety: { effects: ["read", "network", "credential"] }
    });
    ledger.finishTool({
      runId: "legacy-graph-child-read",
      stepId: childStep.stepId,
      output: projectDurableToolOutput("email.read", { type: "email.read", accountId, messageId: "message-1", bodyText: message.body.content })
    });
    ledger.finishTool({
      runId: "legacy-graph-agent-run",
      stepId: parentStep.stepId,
      output: projectDurableToolOutput("agent.run", { content: legacyReply, provider: "synthetic", model: "graph-model" })
    });

    await runTask({
      task: {
        id: sessionMessageRunId,
        tool: "session.message",
        input: { sessionId, role: "assistant", content: legacyReply, source: "console-chat", provider: "synthetic", model: "graph-model" },
        actor: "graph-test"
      },
      auditStore, registry, runLedger: ledger, policy
    });
    registry.close(); registry = undefined;
    ledger.close(); ledger = undefined;
    auditStore.close(); auditStore = undefined;
    assert.equal((await treePayload(stateDir)).includes(legacyReply), true, "fixture must reproduce the pre-fix retention bug");

    await ensureStateCompatibility(stateDir, { applicationVersion: "1.1.2", applicationCommit: "graph-session-quarantine" });
    const records = new SqliteRecordStore(join(stateDir, "db", "records.sqlite"));
    try {
      const stored = await records.queryRecordsPage({ types: ["message.appended"], sessionId, limit: 10 });
      assert.equal(stored.records[0]?.contentRetention?.contentUnavailable, true);
      assert.doesNotMatch(String(stored.records[0]?.content), /SENTINEL_LEGACY_GRAPH_SESSION/u);
    } finally {
      records.close();
    }
    auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
    assert.equal((await auditStore.verifyIntegrity({ allowUnsigned: false })).valid, true);
    auditStore.close(); auditStore = undefined;
    ledger = createRunLedger({ stateDir, workspaceRoot: temporary });
    assert.equal(ledger.verify(sessionMessageRunId).valid, true);
    ledger.close(); ledger = undefined;

    await createStateBackup(stateDir, backup, { applicationVersion: "1.1.2", applicationCommit: "graph-session-quarantine" });
    for (const rootPath of [stateDir, backup]) {
      assert.equal((await treePayload(rootPath)).includes(legacyReply), false, `${rootPath} retained the quarantined reply`);
    }
  } finally {
    registry?.close();
    ledger?.close();
    auditStore?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Sentinel evaluates live Graph input while persisting only the tool-aware projection", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-graph-sentinel-projection-"));
  const stateDir = join(temporary, "state");
  const backup = join(temporary, "backup");
  const querySentinel = "SENTINEL_GRAPH_POLICY_QUERY_64c18f";
  let observedSearch: string | undefined;
  let auditStore: ReturnType<typeof createAuditStore> | undefined;
  let ledger: ReturnType<typeof createRunLedger> | undefined;
  let registry: ReturnType<typeof createBuiltInRegistry> | undefined;
  try {
    await initializeBackupCompatibleState(stateDir);
    auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
    ledger = createRunLedger({ stateDir, workspaceRoot: temporary });
    registry = createBuiltInRegistry({
      workspaceRoot: temporary,
      stateDir,
      auditStore,
      config: { integrations: { microsoftGraph: config }, runLedger: ledger },
      microsoftGraphReadAdapter: createMicrosoftGraphReadAdapter(config, {
        environment,
        resolveNetworkAddresses: publicResolver,
        transport: async (request) => {
          observedSearch = request.url.searchParams.get("$search") ?? undefined;
          return jsonResponse({ value: [] });
        }
      })
    });
    const policy = {
      ...createDefaultPolicy({ allowedCapabilities: ["email.read", "network.access", "secret.reference.use"] }),
      invariants: [{ id: "deny-unrelated-command", type: "command.deny-pattern", values: ["rm -rf"], enforcement: "block" }]
    };
    const result = await runTask({
      task: {
        id: "graph-policy-projection",
        tool: "email.search",
        input: { accountId, query: querySentinel, limit: 1 },
        actor: "graph-test"
      },
      auditStore,
      registry,
      runLedger: ledger,
      policy
    });
    assert.equal(result.ok, true);
    assert.equal(observedSearch, JSON.stringify(querySentinel), "the provider must receive the live query");
    const row = ledger.database.db.prepare("SELECT input_json FROM policy_evaluations WHERE run_id=?").get("graph-policy-projection") as { input_json: string };
    const durableInput = JSON.parse(row.input_json);
    assert.equal(durableInput.toolName, "email.search");
    assert.deepEqual(Object.keys(durableInput.input).sort(), ["limit", "queryBytes", "queryDigest", "targetDigest"]);
    assert.doesNotMatch(row.input_json, new RegExp(querySentinel, "u"));
    assert.equal(ledger.verify("graph-policy-projection").valid, true);

    registry.close();
    registry = undefined;
    ledger.close();
    ledger = undefined;
    auditStore.close();
    auditStore = undefined;
    await createStateBackup(stateDir, backup, {
      applicationVersion: "1.0.0",
      applicationCommit: "graph-sentinel-projection"
    });
    for (const payload of [await treePayload(stateDir), await treePayload(backup)]) {
      assert.equal(payload.includes(querySentinel), false, "Graph policy input crossed a durable state boundary");
    }
  } finally {
    registry?.close();
    ledger?.close();
    auditStore?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("live-only email and calendar targets never enter workflow, cron, SQLite, or ordinary backups", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-graph-durable-admission-"));
  const stateDir = join(temporary, "state");
  const backup = join(temporary, "backup");
  const sentinels = [
    "SENTINEL_GRAPH_ACCOUNT_b307",
    "SENTINEL_GRAPH_MESSAGE_36f2",
    "SENTINEL_GRAPH_SUBJECT_7dc1",
    "SENTINEL_GRAPH_BODY_dd9a",
    "SENTINEL_GRAPH_LOCATION_a13c",
    "sentinel-attendee-1a9f@example.test",
    "SENTINEL_GRAPH_CALENDAR_48e0",
    "SENTINEL_GRAPH_EVENT_e816"
  ];
  let ledger: ReturnType<typeof createRunLedger> | undefined;
  try {
    await initializeBackupCompatibleState(stateDir);
    ledger = createRunLedger({ stateDir, workspaceRoot: temporary });
    const workflows = new SqliteWorkflowStore(ledger.database);
    assert.throws(() => workflows.create({
      schemaVersion: 1,
      runId: "workflow_graph_live_only",
      principalId: "operator",
      idempotencyKey: "workflow_graph_live_only",
      definition: {
        schemaVersion: 1,
        id: "graph_live_only",
        revision: 1,
        name: "Rejected Graph workflow",
        steps: [{
          id: "read_mail",
          actionRef: "email.read",
          dependsOn: [],
          input: {
            accountId: sentinels[0],
            messageId: sentinels[1],
            subject: sentinels[2],
            body: sentinels[3],
            location: sentinels[4],
            attendee: sentinels[5]
          },
          retrySafety: "retry-safe",
          maxAttempts: 1,
          requiresApproval: false
        }],
        definitionDigest: undefined as unknown as string
      },
      input: {}
    }), /live-only and cannot be persisted/u);

    const cron = new CronStore(join(stateDir, "cron-jobs.json"));
    await assert.rejects(() => cron.create({
      id: "graph-live-only",
      schedule: "0 9 * * 1-5",
      timezone: "UTC",
      tool: "calendar.read",
      input: {
        accountId: sentinels[0],
        calendarId: sentinels[6],
        eventId: sentinels[7],
        location: sentinels[4],
        attendee: sentinels[5]
      }
    }), /live-only tool calendar\.read cannot be persisted in cron/u);
    ledger.close();
    ledger = undefined;

    await createStateBackup(stateDir, backup, {
      applicationVersion: "1.0.0",
      applicationCommit: "graph-durable-boundary"
    });
    for (const payload of [await treePayload(stateDir), await treePayload(backup)]) {
      for (const sentinel of sentinels) assert.equal(payload.includes(sentinel), false, `durable state contains ${sentinel}`);
    }
  } finally {
    ledger?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("startup quarantines immediate-parent cron, workflow, and runtime-job Graph inputs before backup", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-graph-live-only-upgrade-"));
  const stateDir = join(temporary, "state");
  const backup = join(temporary, "ordinary-backup");
  const sentinels = {
    account: "SENTINEL_LEGACY_GRAPH_ACCOUNT_2f81",
    message: "SENTINEL_LEGACY_GRAPH_MESSAGE_4ac2",
    query: "SENTINEL_LEGACY_GRAPH_QUERY_8d17",
    result: "SENTINEL_LEGACY_GRAPH_RESULT_4bb9"
  };
  let ledger: ReturnType<typeof createRunLedger> | undefined;
  try {
    await initializeBackupCompatibleState(stateDir);
    ledger = createRunLedger({ stateDir, workspaceRoot: temporary });
    const workflows = new SqliteWorkflowStore(ledger.database);
    const safeDefinitionBase = {
      schemaVersion: 1 as const,
      id: "legacy_graph_workflow",
      revision: 1,
      name: "Immediate-parent fixture",
      steps: [{
        id: "read_mail",
        actionRef: "text.echo",
        dependsOn: [],
        input: { text: "safe fixture" },
        retrySafety: "retry-safe" as const,
        maxAttempts: 1,
        requiresApproval: false
      }]
    };
    workflows.create({
      schemaVersion: 1,
      runId: "legacy_graph_workflow_run",
      principalId: "operator",
      idempotencyKey: "legacy_graph_workflow_run",
      definition: { ...safeDefinitionBase, definitionDigest: workflowDefinitionDigest(safeDefinitionBase) },
      input: {}
    });
    const legacyDefinitionBase = {
      ...safeDefinitionBase,
      name: "Immediate-parent Graph workflow",
      steps: [{
        ...safeDefinitionBase.steps[0],
        actionRef: "email.read",
        input: { accountId: sentinels.account, messageId: sentinels.message, query: sentinels.query }
      }]
    };
    const legacyDefinitionDigest = workflowDefinitionDigest(legacyDefinitionBase);
    const database = ledger.database.db;
    database.prepare("UPDATE workflow_definitions SET definition_digest=?,definition_json=? WHERE id=? AND revision=?").run(
      legacyDefinitionDigest,
      JSON.stringify({ ...legacyDefinitionBase, definitionDigest: legacyDefinitionDigest }),
      legacyDefinitionBase.id,
      legacyDefinitionBase.revision
    );
    database.prepare("UPDATE workflow_runs SET definition_digest=?,input_json=?,input_digest=?,recovery_input_available=1 WHERE run_id=?").run(
      legacyDefinitionDigest,
      JSON.stringify({ query: sentinels.query }),
      "legacy-run-input-digest",
      "legacy_graph_workflow_run"
    );
    database.prepare("UPDATE workflow_steps SET action_ref='email.read',input_json=?,input_digest=?,recovery_input_available=1,result_json=?,result_digest=? WHERE run_id=? AND step_id=?").run(
      JSON.stringify({ accountId: sentinels.account, messageId: sentinels.message, query: sentinels.query }),
      "legacy-step-input-digest",
      JSON.stringify({ type: "email.read", bodyText: sentinels.result, messageId: sentinels.message }),
      "legacy-step-result-digest",
      "legacy_graph_workflow_run",
      "read_mail"
    );

    const runtimeJobs = new SqliteJobStore(ledger);
    await runtimeJobs.create({
      id: "legacy_graph_runtime_job",
      status: "queued",
      payload: { task: { id: "legacy_graph_runtime_job", tool: "text.echo", input: { text: "safe fixture" } } },
      attempts: 0,
      timeoutMs: 120_000,
      retrySafe: true,
      requestHash: "legacy-runtime-request-hash"
    });
    await runtimeJobs.create({
      id: "current_safe_graph_runtime_job",
      status: "completed",
      payload: { task: { id: "current_safe_graph_runtime_job", tool: "email.read", input: { accountId: sentinels.account, messageId: sentinels.message } } },
      attempts: 1,
      timeoutMs: 120_000,
      retrySafe: false,
      requestHash: "current-safe-runtime-request-hash",
      result: {
        id: "current_safe_graph_runtime_job",
        tool: "email.read",
        capability: "email.read",
        capabilities: ["email.read", "network.access", "secret.reference.use"],
        ok: true,
        output: { type: "email.read", accountId: sentinels.account, messageId: sentinels.message, bodyText: sentinels.result }
      }
    });
    database.prepare("UPDATE runtime_jobs SET payload_json=?,payload_recoverable=1,retry_safe=1,result_json=? WHERE id=?").run(
      JSON.stringify({ task: { id: "legacy_graph_runtime_job", tool: "email.search", input: { accountId: sentinels.account, query: sentinels.query } } }),
      JSON.stringify({ output: { type: "email.search", messages: [{ subject: sentinels.result, messageId: sentinels.message }] } }),
      "legacy_graph_runtime_job"
    );

    await writeFile(join(stateDir, "jobs.json"), `${JSON.stringify({
      schemaVersion: 1,
      jobs: {
        legacy_graph_file_job: {
          schemaVersion: 1,
          id: "legacy_graph_file_job",
          status: "queued",
          payload: { task: { id: "legacy_graph_file_job", tool: "calendar.read", input: { accountId: sentinels.account, calendarId: sentinels.query, eventId: sentinels.message } } },
          attempts: 0,
          timeoutMs: 120_000,
          retrySafe: true,
          createdAt: "2026-08-26T12:00:00.000Z",
          updatedAt: "2026-08-26T12:00:00.000Z"
        }
      }
    })}\n`, { mode: 0o600 });
    await runtimeJobs.importLegacy();
    await writeFile(join(stateDir, "cron-jobs.json"), `${JSON.stringify({
      schemaVersion: 1,
      jobs: [{
        id: "legacy_graph_cron",
        name: "Immediate-parent Graph cron",
        schedule: "0 9 * * 1-5",
        timezone: "UTC",
        enabled: true,
        tool: "email.search",
        input: { accountId: sentinels.account, query: sentinels.query }
      }]
    })}\n`, { mode: 0o600 });
    ledger.close();
    ledger = undefined;

    const migration = await ensureStateCompatibility(stateDir, {
      applicationVersion: "1.1.2",
      applicationCommit: "graph-live-only-quarantine"
    });
    assert.ok(migration?.backupLocation, "the schema-v1 cron fixture must create a protected upgrade backup");

    const cronState = JSON.parse(await readFile(join(stateDir, "cron-jobs.json"), "utf8"));
    assert.equal(cronState.schemaVersion, 2);
    assert.equal(cronState.jobs[0].enabled, false);
    assert.equal(cronState.jobs[0].liveOnlyQuarantine.code, "LIVE_ONLY_AUTOMATION_INPUT_REMOVED");
    assert.equal(typeof cronState.jobs[0].input.targetDigest, "string");

    ledger = createRunLedger({ stateDir, workspaceRoot: temporary });
    const upgradedWorkflows = new SqliteWorkflowStore(ledger.database);
    assert.equal(upgradedWorkflows.get("legacy_graph_workflow_run")?.status, "needs-review");
    assert.equal(upgradedWorkflows.claimNext("legacy_graph_workflow_run"), undefined);
    const workflowStep = ledger.database.db.prepare("SELECT action_ref,recovery_input_available,error_code FROM workflow_steps WHERE run_id=? AND step_id=?").get(
      "legacy_graph_workflow_run",
      "read_mail"
    ) as Record<string, unknown>;
    assert.equal(workflowStep.action_ref, "automation.quarantined");
    assert.equal(workflowStep.recovery_input_available, 0);
    assert.equal(workflowStep.error_code, "WORKFLOW_LIVE_INPUT_QUARANTINED");
    const upgradedJobs = new SqliteJobStore(ledger, { legacyPath: join(stateDir, "jobs.json") });
    assert.equal((await upgradedJobs.get("legacy_graph_runtime_job"))?.status, "needs-review");
    assert.equal((await upgradedJobs.get("legacy_graph_runtime_job"))?.recoveryInputAvailable, false);
    assert.equal((await upgradedJobs.get("current_safe_graph_runtime_job"))?.status, "completed");
    await upgradedJobs.importLegacy();
    await upgradedJobs.recover();
    const legacyFileJob = await upgradedJobs.get("legacy_graph_file_job");
    assert.equal(legacyFileJob?.status, "needs-review");
    assert.equal(legacyFileJob?.recoveryInputAvailable, false);
    ledger.close();
    ledger = undefined;

    await createStateBackup(stateDir, backup, {
      applicationVersion: "1.1.2",
      applicationCommit: "graph-live-only-quarantine"
    });
    for (const rootPath of [stateDir, migration.backupLocation!, backup]) {
      const payload = await treePayload(rootPath);
      for (const sentinel of Object.values(sentinels)) {
        assert.equal(payload.includes(sentinel), false, `${rootPath} retained ${sentinel}`);
      }
    }
  } finally {
    ledger?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("immediate-base completed email runs replay after upgrade without persisting a compatibility digest", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "odinn-graph-email-upgrade-"));
  const stateDir = join(workspace, ".odinn");
  const runId = "graph-email-immediate-base";
  const legacyRequestDigest = "7d5fc5760f8825b3c92cf4d0973cf0fbcc4db2a5302c05d172127b17cbc037c9";
  let auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  let ledger = createRunLedger({ stateDir, workspaceRoot: workspace });
  try {
    ledger.ensureRun({ runId, objective: "immediate-base email fixture" });
    ledger.bindRunRequest({ runId, requestDigest: legacyRequestDigest });
    await auditStore.append({
      at: "2026-08-26T12:00:00.000Z",
      runId,
      type: "task.started",
      actor: "graph-test",
      tool: "email.read",
      capability: "email.read",
      decision: "allow",
      data: {
        requestDigest: legacyRequestDigest,
        input: { accountId, messageId: "message-1" }
      }
    });
    await auditStore.append({
      at: "2026-08-26T12:00:01.000Z",
      runId,
      type: "task.completed",
      actor: "graph-test",
      tool: "email.read",
      capability: "email.read",
      decision: "allow",
      data: { output: projectDurableToolOutput("email.read", { type: "email.read", accountId, messageId: "message-1", subject: message.subject, bodyText: message.body.content }) }
    });
    auditStore.close();
    ledger.close();

    let transportCalls = 0;
    auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
    ledger = createRunLedger({ stateDir, workspaceRoot: workspace });
    const registry = createBuiltInRegistry({
      workspaceRoot: workspace,
      stateDir,
      auditStore,
      config: { integrations: { microsoftGraph: config }, runLedger: ledger },
      microsoftGraphReadAdapter: createMicrosoftGraphReadAdapter(config, {
        environment,
        resolveNetworkAddresses: publicResolver,
        transport: async (request) => {
          transportCalls += 1;
          return fixture(request);
        }
      })
    });
    try {
      const policy = createDefaultPolicy({ allowedCapabilities: ["email.read", "network.access", "secret.reference.use"] });
      const replay = await runTask({
        task: { id: runId, tool: "email.read", input: { accountId, messageId: "message-1" }, actor: "graph-test" },
        auditStore,
        registry,
        runLedger: ledger,
        policy
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.contentUnavailableOnReplay, true);
      assert.equal(transportCalls, 0);
      assert.equal(ledger.readRunRequestBinding(runId)?.requestDigest, legacyRequestDigest);
      await assert.rejects(() => runTask({
        task: { id: runId, tool: "email.read", input: { accountId, messageId: "message-2" }, actor: "graph-test" },
        auditStore,
        registry,
        runLedger: ledger,
        policy
      }), (error: any) => error?.code === "IDEMPOTENCY_CONFLICT");
      assert.equal(transportCalls, 0);
      assert.equal(ledger.readRunRequestBinding(runId)?.requestDigest, legacyRequestDigest);
    } finally {
      registry.close();
    }
  } finally {
    try { ledger.close(); } catch { /* already closed */ }
    try { auditStore.close(); } catch { /* already closed */ }
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Microsoft Graph onboarding stores only a credential environment reference and diagnostics stay redacted", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-graph-onboarding-"));
  try {
    const init = spawnSync("node", ["apps/cli/src/cli.ts", "init", "--state", state], { cwd: root, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr || init.stdout);
    const add = spawnSync("node", [
      "apps/cli/src/cli.ts", "config", "integration", "add", "microsoft-graph",
      "--token-env", tokenEnv,
      "--account-id", accountId,
      "--resources", "email,calendar",
      "--state", state
    ], { cwd: root, encoding: "utf8", env: { ...process.env, ...environment } });
    assert.equal(add.status, 0, add.stderr || add.stdout);
    const storedAfterAdd = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
    assert.deepEqual(storedAfterAdd.integrations.microsoftGraph, { enabled: false, tokenEnv, accountId, resources: ["email", "calendar"] });
    assert.doesNotMatch(JSON.stringify(storedAfterAdd), new RegExp(syntheticToken, "u"));

    const refused = spawnSync("node", ["apps/cli/src/cli.ts", "config", "integration", "enable", "microsoft-graph", "--state", state], { cwd: root, encoding: "utf8", env: { ...process.env, ...environment } });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /impact confirmation required/u);
    assert.equal(JSON.parse(await readFile(join(state, "config.json"), "utf8")).integrations.microsoftGraph.enabled, false);

    const enable = spawnSync("node", ["apps/cli/src/cli.ts", "config", "integration", "enable", "microsoft-graph", "--confirm-impact", "--state", state], { cwd: root, encoding: "utf8", env: { ...process.env, ...environment } });
    assert.equal(enable.status, 0, enable.stderr || enable.stdout);
    const doctor = spawnSync("node", ["apps/cli/src/cli.ts", "doctor", "--state", state], { cwd: root, encoding: "utf8", env: { ...process.env, ...environment } });
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    const report = JSON.parse(doctor.stdout);
    assert.deepEqual(report.microsoftGraphRead, diagnoseMicrosoftGraphReadIntegration(config, environment));
    assert.doesNotMatch(doctor.stdout, /ODINN_TEST|11111111|synthetic-graph|example\.test/u);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
