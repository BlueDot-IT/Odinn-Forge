import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  ChannelAdmissionError, ChannelRetryableError, ChannelRouter, ChannelRunUncertainError, FileChannelDedupeStore, FileSessionBindingStore,
  GatewayChannelHandler, channelConversationKey, channelExecutionKey, createAllowlistPolicy, splitChannelText,
  type ChannelAcknowledgement, type ChannelAdapter, type ChannelStartContext,
  type InboundChannelMessage, type OutboundChannelMessage
} from "../packages/channels/src/index.ts";
import {
  TelegramChannelAdapter, normalizeTelegramCallbackQuery, normalizeTelegramUpdate
} from "../adapters/channels/telegram/src/index.ts";
import {
  DiscordChannelAdapter, createDiscordAccessPolicy, discordChannelPlugin,
  normalizeDiscordInteraction, normalizeDiscordMessage
} from "../adapters/channels/discord/src/index.ts";
import { ensureSecureStateDirectory, isOwnerOnlyPath, SecureJsonFileStore } from "../packages/store-file/src/index.ts";

const execFile = promisify(execFileCallback);
const channelStoreWorker = fileURLToPath(new URL("./fixtures/channel-store-worker.ts", import.meta.url));

function message(overrides: Partial<InboundChannelMessage> = {}): InboundChannelMessage {
  return {
    id: "10",
    address: { channel: "telegram", accountId: "personal", conversationId: "200", conversationKind: "direct" },
    sender: { id: "100", displayName: "Jason" },
    text: "Hello",
    receivedAt: "2026-07-26T12:00:00.000Z",
    ...overrides
  };
}
class FixtureAdapter implements ChannelAdapter {
  readonly id = "fixture";
  readonly channel = "fixture";
  readonly accountId = "default";
  readonly capabilities = { chatTypes: ["direct" as const], streaming: true, edits: true };
  readonly sent: OutboundChannelMessage[] = [];
  readonly edits: Array<{ messageId: string; message: OutboundChannelMessage }> = [];
  readonly acknowledgements: Array<{ id: string; acknowledgement: ChannelAcknowledgement }> = [];
  deliver?: (message: InboundChannelMessage) => Promise<boolean>;
  async start(context: ChannelStartContext): Promise<void> { this.deliver = context.deliver; }
  async stop(): Promise<void> {}
  async send(output: OutboundChannelMessage) {
    this.sent.push(output);
    return {
      status: "sent" as const,
      messageIds: [String(this.sent.length)],
      conversationId: output.address.conversationId,
      sentChunks: 1,
      totalChunks: 1
    };
  }
  async acknowledge(input: InboundChannelMessage, acknowledgement: ChannelAcknowledgement): Promise<void> {
    this.acknowledgements.push({ id: input.id, acknowledgement });
  }
  async edit(_address: InboundChannelMessage["address"], messageId: string, output: OutboundChannelMessage): Promise<void> {
    this.edits.push({ messageId, message: output });
  }
}

test("channel router enforces allowlists, deduplicates deliveries, and returns replies", async () => {
  const adapter = new FixtureAdapter();
  const handled: string[] = [];
  const router = new ChannelRouter({
    async handle(input) { handled.push(input.id); return `reply:${input.text}`; }
  }, { access: createAllowlistPolicy(["telegram:100"]) });
  await router.attach(adapter);
  await adapter.deliver?.(message());
  await adapter.deliver?.(message());
  await adapter.deliver?.(message({ id: "11", sender: { id: "blocked" } }));
  assert.deepEqual(handled, ["10"]);
  assert.deepEqual(adapter.sent.map((entry) => entry.text), ["reply:Hello"]);
  assert.deepEqual(adapter.acknowledgements, [
    { id: "10", acknowledgement: "processing" },
    { id: "10", acknowledgement: "succeeded" }
  ]);
});

test("channel acknowledgements report failures without changing delivery semantics", async () => {
  const adapter = new FixtureAdapter();
  const errors: string[] = [];
  const router = new ChannelRouter({
    async handle() { throw new Error("model failed"); }
  }, {
    onError(error) { errors.push(error instanceof Error ? error.message : String(error)); }
  });
  await router.attach(adapter);
  await adapter.deliver?.(message());
  assert.deepEqual(adapter.acknowledgements, [
    { id: "10", acknowledgement: "processing" },
    { id: "10", acknowledgement: "failed" }
  ]);
  assert.deepEqual(errors, ["model failed"]);

  adapter.acknowledge = async () => { throw new Error("reaction denied"); };
  const successful = new ChannelRouter({ async handle() { return "reply"; } });
  await successful.attach(adapter);
  await adapter.deliver?.(message({ id: "11" }));
  assert.equal(adapter.sent.at(-1)?.text, "reply");
});

test("channel router serializes messages within a conversation", async () => {
  const adapter = new FixtureAdapter();
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstWait = new Promise<void>((resolveWait) => { releaseFirst = resolveWait; });
  const router = new ChannelRouter({
    async handle(input) {
      events.push(`start:${input.id}`);
      if (input.id === "10") await firstWait;
      events.push(`end:${input.id}`);
      return input.id;
    }
  });
  await router.attach(adapter);
  const first = adapter.deliver?.(message());
  await new Promise((resolveWait) => setImmediate(resolveWait));
  const second = adapter.deliver?.(message({ id: "11" }));
  await new Promise((resolveWait) => setImmediate(resolveWait));
  assert.deepEqual(events, ["start:10"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["start:10", "end:10", "start:11", "end:11"]);
});

test("channel router bounds retained work while preserving per-conversation serialization", async () => {
  const adapter = new FixtureAdapter();
  const events: string[] = [];
  const errors: Array<{ error: unknown; id: string }> = [];
  let releaseFirst: (() => void) | undefined;
  const firstWait = new Promise<void>((resolveWait) => { releaseFirst = resolveWait; });
  const router = new ChannelRouter({
    async handle(input) {
      events.push(`start:${input.id}`);
      if (input.id === "10" || input.id === "13") await firstWait;
      events.push(`end:${input.id}`);
      return input.id;
    }
  }, {
    maximumPendingGlobal: 3,
    maximumPendingPerConversation: 2,
    onError(error, input) { errors.push({ error, id: input.id }); }
  });
  await router.attach(adapter);

  const first = adapter.deliver?.(message());
  await new Promise((resolveWait) => setImmediate(resolveWait));
  const second = adapter.deliver?.(message({ id: "11" }));
  const rejectedConversation = adapter.deliver?.(message({ id: "12" }));
  const otherConversation = adapter.deliver?.(message({
    id: "13",
    address: { ...message().address, conversationId: "201" }
  }));
  const rejectedGlobal = adapter.deliver?.(message({
    id: "14",
    address: { ...message().address, conversationId: "202" }
  }));
  assert.equal(await rejectedConversation, false);
  assert.equal(await rejectedGlobal, false);
  await new Promise((resolveWait) => setImmediate(resolveWait));

  assert.deepEqual(events, ["start:10", "start:13"]);
  assert.deepEqual(errors.map(({ id }) => id), ["12", "14"]);
  assert.deepEqual(errors.map(({ error }) => error instanceof ChannelAdmissionError && error.scope), ["conversation", "global"]);
  releaseFirst?.();
  await Promise.all([first, second, otherConversation]);
  assert.ok(events.indexOf("end:10") < events.indexOf("start:11"));
  assert.ok(events.indexOf("start:11") < events.indexOf("end:11"));

  assert.equal(await adapter.deliver?.(message({ id: "12" })), true);
  assert.equal(events.at(-2), "start:12", "a rejected message must remain eligible for later delivery");
});

test("channel router rate-limits each sender with bounded admission state", async () => {
  const adapter = new FixtureAdapter();
  const handled: string[] = [];
  const errors: Array<{ error: unknown; id: string }> = [];
  let now = 1_000;
  const router = new ChannelRouter({
    async handle(input) { handled.push(input.id); return input.id; }
  }, {
    clock: () => now,
    maximumMessagesPerSenderWindow: 2,
    maximumTrackedSenders: 2,
    senderWindowMs: 1_000,
    onError(error, input) { errors.push({ error, id: input.id }); }
  });
  await router.attach(adapter);

  await adapter.deliver?.(message({ id: "10" }));
  await adapter.deliver?.(message({ id: "11" }));
  assert.equal(await adapter.deliver?.(message({ id: "12" })), false);
  await adapter.deliver?.(message({ id: "13", sender: { id: "101" } }));
  assert.equal(await adapter.deliver?.(message({ id: "14", sender: { id: "102" } })), false);

  assert.deepEqual(handled, ["10", "11", "13"]);
  assert.deepEqual(errors.map(({ id }) => id), ["12", "14"]);
  assert.deepEqual(
    errors.map(({ error }) => error instanceof ChannelAdmissionError && error.scope),
    ["sender", "sender-state"]
  );

  now += 1_001;
  await adapter.deliver?.(message({ id: "12" }));
  await adapter.deliver?.(message({ id: "14", sender: { id: "102" } }));
  assert.deepEqual(handled, ["10", "11", "13", "12", "14"]);
});

test("channel router retries transient failures and releases exhausted deliveries", async () => {
  const adapter = new FixtureAdapter();
  let attempts = 0;
  const errors: string[] = [];
  const router = new ChannelRouter({
    async handle() {
      attempts += 1;
      if (attempts < 3) throw new ChannelRetryableError("gateway unavailable");
      return "recovered";
    }
  }, {
    maxAttempts: 3,
    retryDelayMs: 10,
    onError(error) { errors.push(error instanceof Error ? error.message : String(error)); }
  });
  await router.attach(adapter);
  await adapter.deliver?.(message());
  assert.equal(attempts, 3);
  assert.equal(adapter.sent[0]?.text, "recovered");
  assert.deepEqual(errors, []);

  const exhausted = new ChannelRouter({
    async handle() { throw new ChannelRetryableError("still unavailable"); }
  }, { maxAttempts: 2, retryDelayMs: 10 });
  await exhausted.attach(adapter);
  await adapter.deliver?.(message({ id: "20" }));
  await adapter.deliver?.(message({ id: "20" }));
  assert.equal(adapter.acknowledgements.filter((entry) => entry.id === "20" && entry.acknowledgement === "failed").length, 2);
});

test("channel delivery retries reuse the completed model response", async () => {
  const adapter = new FixtureAdapter();
  let sendAttempts = 0;
  adapter.send = async (output) => {
    sendAttempts += 1;
    if (sendAttempts === 1) throw new ChannelRetryableError("transport unavailable");
    adapter.sent.push(output);
    return {
      status: "sent",
      messageIds: ["sent"],
      conversationId: output.address.conversationId,
      sentChunks: 1,
      totalChunks: 1
    };
  };
  let modelRuns = 0;
  const router = new ChannelRouter({
    async handle() {
      modelRuns += 1;
      return "one model result";
    }
  }, { retryDelayMs: 10 });
  await router.attach(adapter);
  await adapter.deliver?.(message({ id: "25" }));
  assert.equal(sendAttempts, 2);
  assert.equal(modelRuns, 1);
  assert.equal(adapter.sent[0].text, "one model result");
});

test("channel delivery records a terminal delivery failure without rerunning the handler", async () => {
  const adapter = new FixtureAdapter();
  adapter.send = async () => { throw new ChannelRetryableError("transport unavailable"); };
  const states: string[] = [];
  let modelRuns = 0;
  const router = new ChannelRouter({
    async handle() {
      modelRuns += 1;
      return "one model result";
    }
  }, {
    maxAttempts: 1,
    onExecutionState(event) { states.push(event.state); }
  });
  await router.attach(adapter);
  await adapter.deliver?.(message({ id: "26" }));
  assert.equal(modelRuns, 1);
  assert.deepEqual(states, ["delivery-failed"]);
  assert.equal(adapter.acknowledgements.at(-1)?.acknowledgement, "failed");
});

test("gateway channel handler submits one durable run and reconciles its result", async () => {
  const input = message({ id: "durable-1" });
  const executionKey = channelExecutionKey(input);
  const calls: Array<{ url: string; method: string; headers: Headers }> = [];
  const states: string[] = [];
  let jobReads = 0;
  const fetch = async (inputUrl: string | URL, init: RequestInit = {}) => {
    const url = String(inputUrl);
    const method = init.method ?? "GET";
    calls.push({ url, method, headers: new Headers(init.headers) });
    if (method === "GET" && url.endsWith("/sessions/sess_1")) {
      return new Response(JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }), { status: 200 });
    }
    if (method === "POST" && url.endsWith("/sessions/sess_1/messages")) return new Response("{}", { status: 200 });
    if (method === "POST" && url.endsWith("/jobs")) {
      return new Response(JSON.stringify({ ok: true, replayed: false, job: { id: executionKey, status: "queued" } }), { status: 202 });
    }
    if (method === "GET" && url.endsWith(`/jobs/${encodeURIComponent(executionKey)}`)) {
      jobReads += 1;
      const job = jobReads === 1
        ? { id: executionKey, status: "running" }
        : { id: executionKey, status: "completed", result: { output: { content: "durable answer" } } };
      return new Response(JSON.stringify(job), { status: 200 });
    }
    throw new Error(`unexpected fake gateway request: ${method} ${url}`);
  };
  const handler = new GatewayChannelHandler({
    token: "test-token",
    bindings: { async get() { return "sess_1"; }, async set() {} },
    fetch,
    pollIntervalMs: 10,
    reconciliationTimeoutMs: 1_000,
    onExecutionState(event) { states.push(event.state); }
  });

  const reply = await handler.handle(input, { signal: new AbortController().signal });
  assert.equal(reply, "durable answer");
  assert.deepEqual(states, ["accepted", "running", "completed"]);
  assert.equal(calls.filter((call) => call.method === "POST" && call.url.endsWith("/jobs")).length, 1);
  assert.equal(calls.find((call) => call.url.endsWith("/jobs"))?.headers.get("idempotency-key"), executionKey);
});

test("gateway channel handler safely resubmits the same key after an accepted receipt is lost", async () => {
  const input = message({ id: "receipt-lost-1" });
  const executionKey = channelExecutionKey(input);
  let submissions = 0;
  let accepted = false;
  const states: string[] = [];
  const fetch = async (inputUrl: string | URL, init: RequestInit = {}) => {
    const url = String(inputUrl);
    const method = init.method ?? "GET";
    if (method === "GET" && url.endsWith("/sessions/sess_1")) return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    if (method === "POST" && url.endsWith("/sessions/sess_1/messages")) return new Response("{}", { status: 200 });
    if (method === "POST" && url.endsWith("/jobs")) {
      submissions += 1;
      if (submissions === 1) {
        accepted = true;
        throw new TypeError("socket closed after durable acceptance");
      }
      assert.equal(accepted, true);
      return new Response(JSON.stringify({ ok: true, replayed: true, job: {
        id: executionKey,
        status: "completed",
        result: { output: { content: "reconciled answer" } }
      } }), { status: 200 });
    }
    throw new Error(`unexpected fake gateway request: ${method} ${url}`);
  };
  const handler = new GatewayChannelHandler({
    token: "test-token",
    bindings: { async get() { return "sess_1"; }, async set() {} },
    fetch,
    onExecutionState(event) { states.push(event.state); }
  });
  await assert.rejects(
    () => handler.handle(input, { signal: new AbortController().signal }),
    (error: unknown) => error instanceof ChannelRetryableError
  );
  assert.equal(await handler.handle(input, { signal: new AbortController().signal }), "reconciled answer");
  assert.equal(submissions, 2);
  assert.deepEqual(states, ["reconciled", "completed"]);
});

test("gateway channel handler treats a recovered uncertain job as non-replayable", async () => {
  const input = message({ id: "uncertain-1" });
  const executionKey = channelExecutionKey(input);
  const states: string[] = [];
  const fetch = async (inputUrl: string | URL, init: RequestInit = {}) => {
    const url = String(inputUrl);
    const method = init.method ?? "GET";
    if (method === "GET" && url.endsWith("/sessions/sess_1")) return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    if (method === "POST" && url.endsWith("/sessions/sess_1/messages")) return new Response("{}", { status: 200 });
    if (method === "POST" && url.endsWith("/jobs")) return new Response(JSON.stringify({ ok: true, job: { id: executionKey, status: "queued" } }), { status: 202 });
    if (method === "GET" && url.endsWith(`/jobs/${encodeURIComponent(executionKey)}`)) {
      return new Response(JSON.stringify({ id: executionKey, status: "needs-review", error: "gateway restarted during execution" }), { status: 200 });
    }
    throw new Error(`unexpected fake gateway request: ${method} ${url}`);
  };
  const handler = new GatewayChannelHandler({
    token: "test-token",
    bindings: { async get() { return "sess_1"; }, async set() {} },
    fetch,
    pollIntervalMs: 10,
    reconciliationTimeoutMs: 1_000,
    onExecutionState(event) { states.push(event.state); }
  });
  await assert.rejects(
    () => handler.handle(input, { signal: new AbortController().signal }),
    (error: unknown) => error instanceof ChannelRunUncertainError && error.code === "CHANNEL_RUN_UNCERTAIN"
  );
  assert.deepEqual(states, ["accepted", "uncertain"]);
});

test("channel router streams drafts through one message and finalizes by editing", async () => {
  const adapter = new FixtureAdapter();
  const router = new ChannelRouter({
    async handle(_input, context) {
      await context.onDelta?.("partial ");
      await context.onDelta?.("reply");
      return "partial reply";
    }
  });
  await router.attach(adapter);
  await adapter.deliver?.(message({ id: "30" }));
  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0].text, "partial ");
  assert.equal(adapter.sent[0].replyToId, "30");
  assert.equal(adapter.edits.at(-1)?.message.text, "partial reply");
});

test("file channel dedupe survives restarts and permits released claims", async () => {
  const directory = await mkdtemp(join(tmpdir(), "odinn-channel-dedupe-"));
  const path = join(directory, "dedupe.json");
  const first = new FileChannelDedupeStore(path);
  assert.equal(await first.claim("discord:home:10"), true);
  await first.commit("discord:home:10");
  const second = new FileChannelDedupeStore(path);
  assert.equal(await second.claim("discord:home:10"), false);
  assert.equal(await second.claim("discord:home:11"), true);
  await second.release("discord:home:11");
  assert.equal(await second.claim("discord:home:11"), true);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.schemaVersion, 1);
});

test("file session bindings isolate channel conversations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "odinn-channel-bindings-"));
  const path = join(directory, "bindings.json");
  const store = new FileSessionBindingStore(path);
  const address = message().address;
  await store.set(address, "sess_1");
  assert.equal(await store.get(address), "sess_1");
  assert.equal(await store.get({ ...address, conversationId: "other" }), undefined);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.bindings[channelConversationKey(address)], "sess_1");
});

test("channel binding writes recover after failure and reject corrupt or insecure state", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-channel-binding-recovery-"));
  const blockedParent = join(root, "blocked");
  const address = message().address;
  try {
    await writeFile(blockedParent, "not a directory\n", "utf8");
    const recovering = new FileSessionBindingStore(join(blockedParent, "bindings.json"));
    await assert.rejects(() => recovering.set(address, "first"), /directory/u);
    await rm(blockedParent);
    await mkdir(blockedParent);
    await recovering.set(address, "second");
    assert.equal(await recovering.get(address), "second");

    const path = join(root, "schema", "bindings.json");
    const invalid = new FileSessionBindingStore(path);
    await invalid.set(address, "valid-before-corruption");
    await writeFile(path, `${JSON.stringify({ schemaVersion: 2, bindings: {} })}\n`, { mode: 0o600 });
    await assert.rejects(() => invalid.get(address), /unsupported channel binding state/u);

    await writeFile(path, `${JSON.stringify({ schemaVersion: 1, bindings: {} })}\n`, { mode: 0o600 });
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot;
      assert.ok(systemRoot);
      await execFile(join(systemRoot, "System32", "icacls.exe"), [path, "/grant", "*S-1-1-0:R"], { windowsHide: true });
    } else {
      await chmod(path, 0o644);
    }
    assert.equal(await isOwnerOnlyPath(path), false);
    await assert.rejects(() => invalid.get(address), /owner-only/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("independent processes preserve all bindings and permit only one dedupe claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-channel-processes-"));
  const bindingPath = join(root, "bindings.json");
  const bindingGate = join(root, "bindings.go");
  const dedupePath = join(root, "dedupe.json");
  const dedupeGate = join(root, "dedupe.go");
  try {
    await ensureSecureStateDirectory(root);
    const bindingWorkers = Array.from({ length: 4 }, (_, index) => execFile(process.execPath, [
      channelStoreWorker, "bindings", bindingPath, bindingGate, `worker-${index}`, "3"
    ], { windowsHide: true }));
    await writeFile(bindingGate, "go\n", "utf8");
    await Promise.all(bindingWorkers);
    const bindingState = JSON.parse(await readFile(bindingPath, "utf8"));
    assert.equal(Object.keys(bindingState.bindings).length, 12);
    for (let worker = 0; worker < 4; worker += 1) {
      for (let index = 0; index < 3; index += 1) {
        const key = channelConversationKey({
          channel: "fixture", accountId: `worker-${worker}`, conversationKind: "direct", conversationId: String(index)
        });
        assert.equal(bindingState.bindings[key], `worker-${worker}-session-${index}`);
      }
    }

    const claims = Array.from({ length: 6 }, () => execFile(process.execPath, [
      channelStoreWorker, "claim", dedupePath, dedupeGate, "shared-delivery"
    ], { windowsHide: true }));
    await writeFile(dedupeGate, "go\n", "utf8");
    const claimResults = await Promise.all(claims);
    assert.equal(claimResults.filter(({ stdout }) => JSON.parse(stdout).claimed === true).length, 1);
    assert.equal(claimResults.filter(({ stdout }) => JSON.parse(stdout).claimed === false).length, 5);

    const dedupe = new FileChannelDedupeStore(dedupePath);
    await dedupe.commit("shared-delivery");
    assert.equal(await dedupe.claim("shared-delivery"), false);
    assert.equal(await dedupe.claim("commit-concurrently"), true);
    assert.equal(await dedupe.claim("released-delivery"), true);
    const mutationGate = join(root, "dedupe-mutations.go");
    const mutations = [
      execFile(process.execPath, [channelStoreWorker, "commit", dedupePath, mutationGate, "commit-concurrently"], { windowsHide: true }),
      execFile(process.execPath, [channelStoreWorker, "release", dedupePath, mutationGate, "released-delivery"], { windowsHide: true })
    ];
    await writeFile(mutationGate, "go\n", "utf8");
    await Promise.all(mutations);
    assert.equal(await dedupe.claim("commit-concurrently"), false);
    assert.equal(await dedupe.claim("released-delivery"), true);

    assert.equal(await dedupe.claim("expired-delivery"), true);
    const expiredState = JSON.parse(await readFile(dedupePath, "utf8"));
    expiredState.entries["expired-delivery"].expiresAt = 0;
    await writeFile(dedupePath, `${JSON.stringify(expiredState, null, 2)}\n`, "utf8");
    assert.equal(await new FileChannelDedupeStore(dedupePath).claim("expired-delivery"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("channel store locks are token-owned and crash locks fail closed until explicit recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-channel-locks-"));
  const path = join(root, "bindings.json");
  const crashPath = join(root, "crash-bindings.json");
  const gate = join(root, "crash.go");
  const marker = join(root, "locked.marker");
  try {
    await ensureSecureStateDirectory(root);
    const tokenStore = new SecureJsonFileStore<{ schemaVersion: 1; values: Record<string, string> }>(path, {
      label: "token fixture",
      create: () => ({ schemaVersion: 1, values: {} }),
      validate: (value) => value as { schemaVersion: 1; values: Record<string, string> }
    });
    let releaseMutation!: () => void;
    const mutationMayFinish = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const mutation = tokenStore.mutate(async (state) => {
      await mutationMayFinish;
      state.values.first = "written";
    });
    await waitForFile(tokenStore.lockPath);
    const replacementToken = "replacement-owner-token-0001";
    await writeFile(tokenStore.lockPath, `${JSON.stringify({ token: replacementToken, pid: process.pid, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    releaseMutation();
    await mutation;
    assert.equal(JSON.parse(await readFile(tokenStore.lockPath, "utf8")).token, replacementToken);
    await rm(tokenStore.lockPath);

    const invalidLockStore = new FileSessionBindingStore(join(root, "invalid-lock-bindings.json"), { lockTimeoutMs: 25 });
    await writeFile(join(root, "invalid-lock-bindings.json.lock"), "not-json\n", { mode: 0o600 });
    await assert.rejects(() => invalidLockStore.set(message().address, "blocked"), /lock metadata is invalid/u);
    await rm(join(root, "invalid-lock-bindings.json.lock"));

    await writeFile(gate, "go\n", "utf8");
    await assert.rejects(
      () => execFile(process.execPath, [channelStoreWorker, "crash-lock", crashPath, gate, marker], { windowsHide: true }),
      (error: unknown) => (error as { code?: number }).code === 73
    );
    await waitForFile(marker);
    const bindings = new FileSessionBindingStore(crashPath, { lockTimeoutMs: 50 });
    await assert.rejects(() => bindings.set(message().address, "blocked"), /orphaned lock/u);
    const recoveredLock = `${crashPath}.lock.recovered`;
    await rename(`${crashPath}.lock`, recoveredLock);
    await bindings.set(message().address, "recovered");
    assert.equal(await bindings.get(message().address), "recovered");
    assert.equal(JSON.parse(await readFile(recoveredLock, "utf8")).pid > 0, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("channel binding readers observe only complete old or new replacement states", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-channel-replacement-"));
  const path = join(root, "bindings.json");
  try {
    const left = new FileSessionBindingStore(path);
    const right = new FileSessionBindingStore(path);
    const address = message().address;
    await left.set(address, "initial");
    let writesRemaining = 12;
    let invalidObservation: string | undefined;
    const observer = new FileSessionBindingStore(path);
    const writes = Array.from({ length: 12 }, (_, index) => (index % 2 ? left : right)
      .set({ ...address, conversationId: String(index) }, `session-${index}`)
      .finally(() => { writesRemaining -= 1; }));
    const reader = (async () => {
      while (writesRemaining > 0) {
        try {
          const value = await observer.get(address);
          if (value !== "initial") invalidObservation = `unexpected binding: ${String(value)}`;
        } catch (error) {
          invalidObservation = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();
    await Promise.all(writes);
    await reader;
    assert.equal(invalidObservation, undefined);
    assert.equal(Object.keys(JSON.parse(await readFile(path, "utf8")).bindings).length, 13);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForFile(path: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for file: ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

test("Telegram updates normalize into the shared channel shape", () => {
  const normalized = normalizeTelegramUpdate({
    update_id: 900,
    message: {
      message_id: 10, date: 1785081600, text: " Hello ", message_thread_id: 7,
      chat: { id: -200, type: "supergroup" },
      from: { id: 100, first_name: "Jason", last_name: "O", username: "jason" }
    }
  }, "personal");
  assert.equal(normalized?.address.conversationKind, "group");
  assert.equal(normalized?.address.threadId, "7");
  assert.equal(normalized?.sender.displayName, "Jason O");
  assert.equal(normalized?.text, "Hello");
  assert.deepEqual(normalized?.metadata, { updateId: 900 });
});

test("Telegram adapter supports rich delivery, reactions, typing, edits, and components", async () => {
  const calls: Array<{ method: string; args: any[] }> = [];
  const handlers = new Map<string, (context: any) => Promise<void> | void>();
  const fakeBot = {
    botInfo: { id: 600, username: "odinn_bot" },
    api: new Proxy({}, {
      get(_target, method: string) {
        return async (...args: any[]) => {
          calls.push({ method, args });
          if (method === "sendMessage" || method === "sendDocument") return { message_id: calls.length };
          if (method === "getMe") return { id: 600, username: "odinn_bot" };
          return true;
        };
      }
    }),
    on(filter: string | string[], handler: (context: any) => Promise<void> | void) {
      for (const entry of Array.isArray(filter) ? filter : [filter]) handlers.set(entry, handler);
    },
    catch() {},
    async start(options: any) { await options.onStart(this.botInfo); },
    async stop() {}
  };
  const adapter = new TelegramChannelAdapter({
    token: "test-token",
    nativeCommands: true,
    botFactory: () => fakeBot as any
  });
  const controller = new AbortController();
  await adapter.start({ signal: controller.signal, async deliver() { return true; }, updateStatus() {} });
  const address = {
    channel: "telegram",
    accountId: "personal",
    conversationId: "-200",
    conversationKind: "group" as const,
    threadId: "7"
  };
  const receipt = await adapter.send({
    address,
    text: "hello",
    components: [{ type: "button", customId: "confirm", label: "Confirm" }]
  });
  assert.equal(receipt.status, "sent");
  assert.equal(calls.find((call) => call.method === "sendMessage")?.args[2].reply_markup.inline_keyboard[0][0].callback_data, "confirm");
  const inbound = message({ id: "10", address });
  await adapter.acknowledge(inbound, "processing");
  await adapter.sendTyping(address);
  await adapter.edit(address, "11", { address, text: "updated" });
  await adapter.delete(address, "11");
  assert.ok(calls.some((call) => call.method === "setMessageReaction"));
  assert.ok(calls.some((call) => call.method === "sendChatAction"));
  assert.ok(calls.some((call) => call.method === "editMessageText"));
  assert.ok(calls.some((call) => call.method === "deleteMessage"));
  assert.ok(calls.some((call) => call.method === "setMyCommands"));
  assert.equal(normalizeTelegramCallbackQuery({
    update_id: 901,
    callback_query: {
      id: "callback-1",
      data: "confirm",
      from: { id: 100, first_name: "Jason" },
      message: { message_id: 10, chat: { id: -200, type: "supergroup" } }
    }
  })?.text, "Telegram component selected: confirm");
  await adapter.stop();
});

test("channel text splitting preserves Unicode and prefers word boundaries", () => {
  assert.deepEqual(splitChannelText("alpha beta gamma", 10), ["alpha", "beta gamma"]);
  assert.deepEqual(splitChannelText("🪁🪁🪁", 2), ["🪁🪁", "🪁"]);
  assert.throws(() => splitChannelText("text", 0), /positive integer/);
});

test("Discord messages require mentions in guilds and normalize DMs", () => {
  const guildMessage = {
    id: "900",
    channel_id: "800",
    guild_id: "700",
    content: "<@600> hello Odinn",
    timestamp: "2026-07-26T12:00:00.000Z",
    author: { id: "500", username: "jason", global_name: "Jason", bot: false },
    mentions: [{ id: "600" }]
  };
  const normalized = normalizeDiscordMessage(guildMessage, { accountId: "community", botUserId: "600" });
  assert.equal(normalized?.text, "hello Odinn");
  assert.equal(normalized?.address.conversationKind, "channel");
  assert.equal(normalized?.metadata?.guildId, "700");
  assert.equal(normalizeDiscordMessage({ ...guildMessage, mentions: [] }, { botUserId: "600" }), undefined);
  const direct = normalizeDiscordMessage({
    ...guildMessage, guild_id: undefined, content: "hello in a DM", mentions: []
  }, { botUserId: "600" });
  assert.equal(direct?.address.conversationKind, "direct");
  assert.equal(direct?.text, "hello in a DM");
});

test("Discord plugin enforces DM, guild, channel, role, and mention policy", async () => {
  const config = discordChannelPlugin.normalizeAccountConfig("home", {
    enabled: true,
    tokenEnv: "DISCORD_BOT_TOKEN",
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    allowlist: ["discord:500"],
    guilds: {
      "700": {
        requireMention: true,
        roles: ["900"],
        channels: {
          "800": { enabled: true, requireMention: true },
          "801": { enabled: false }
        }
      }
    }
  });
  const policy = createDiscordAccessPolicy(config);
  const guildMessage = message({
    address: { channel: "discord", accountId: "home", conversationId: "800", conversationKind: "channel" },
    sender: { id: "501" },
    metadata: { guildId: "700", roleIds: ["900"], mentionedBot: true }
  });
  assert.equal(await policy.allows(guildMessage), true);
  assert.equal(await policy.allows({ ...guildMessage, metadata: { guildId: "700", roleIds: ["900"] } }), false);
  assert.equal(await policy.allows({
    ...guildMessage,
    address: { ...guildMessage.address, conversationId: "801" }
  }), false);
  assert.equal(await policy.allows({
    ...guildMessage,
    address: { ...guildMessage.address, conversationId: "999" }
  }), false);
  assert.equal(await policy.allows(message({
    address: { channel: "discord", accountId: "home", conversationId: "500", conversationKind: "direct" },
    sender: { id: "500" }
  })), true);
  assert.equal(await policy.allows(message({
    address: { channel: "discord", accountId: "home", conversationId: "501", conversationKind: "direct" },
    sender: { id: "501" }
  })), false);
});

test("Discord replies disable mention parsing and respect the 2000-character limit", async () => {
  const sent: any[] = [];
  const client = fixtureDiscordClient({
    channel: {
      isTextBased: () => true,
      async send(body: any) {
        sent.push(body);
        return { id: String(sent.length) };
      }
    }
  });
  const adapter = new DiscordChannelAdapter({
    token: "test-token",
    clientFactory: () => client
  });
  const controller = new AbortController();
  await adapter.start({ signal: controller.signal, deliver: async () => true, updateStatus() {} });
  try {
    const receipt = await adapter.send({
      address: { channel: "discord", accountId: "community", conversationId: "800", conversationKind: "channel" },
      text: "x".repeat(2_001),
      replyToId: "900"
    });
    assert.equal(sent.length, 2);
    assert.equal(sent[0].content.length, 2_000);
    assert.deepEqual(sent[0].reply, { messageReference: "900", failIfNotExists: false });
    assert.equal(sent[1].reply, undefined);
    assert.deepEqual(receipt.messageIds, ["1", "2"]);
  } finally {
    await adapter.stop();
  }
});

test("Discord acknowledgements replace the processing reaction with a terminal reaction", async () => {
  const reactions: string[] = [];
  const removals: string[] = [];
  const target = {
    reactions: {
      resolve(emoji: string) {
        return { users: { async remove() { removals.push(emoji); } } };
      }
    },
    async react(emoji: string) { reactions.push(emoji); }
  };
  const client = fixtureDiscordClient({
    channel: {
      messages: { async fetch() { return target; } }
    }
  });
  const adapter = new DiscordChannelAdapter({
    token: "test-token",
    clientFactory: () => client
  });
  const input = message({
    id: "900",
    address: { channel: "discord", accountId: "community", conversationId: "800", conversationKind: "channel" }
  });

  const controller = new AbortController();
  await adapter.start({ signal: controller.signal, deliver: async () => true, updateStatus() {} });
  try {
    await adapter.acknowledge(input, "processing");
    await adapter.acknowledge(input, "succeeded");
    assert.deepEqual(reactions, ["👀", "✅"]);
    assert.deepEqual(removals, ["👀"]);
  } finally {
    await adapter.stop();
  }
});

test("Discord client lifecycle reports ready state and delivers normalized message events", async () => {
  const client = fixtureDiscordClient();
  const delivered: InboundChannelMessage[] = [];
  const states: string[] = [];
  const adapter = new DiscordChannelAdapter({
    token: "test-token",
    clientFactory: () => client
  });
  const controller = new AbortController();
  await adapter.start({
    signal: controller.signal,
    async deliver(input) { delivered.push(input); return true; },
    updateStatus(status) { if (status.state) states.push(status.state); }
  });
  client.emit("messageCreate", {
    id: "900",
    channelId: "800",
    guildId: "700",
    content: "<@600> hello",
    createdTimestamp: Date.parse("2026-07-26T12:00:00.000Z"),
    author: { id: "500", username: "jason", bot: false },
    mentions: [{ id: "600" }]
  });
  await new Promise((resolveWait) => setImmediate(resolveWait));
  assert.deepEqual(states.slice(0, 2), ["starting", "connected"]);
  assert.equal(delivered[0].text, "hello");
  await adapter.stop();
});

test("Discord native commands and components enter the shared router and use interaction replies", async () => {
  const commands: unknown[][] = [];
  const edits: any[] = [];
  const client = fixtureDiscordClient({
    application: {
      id: "601",
      commands: { async set(value: unknown[]) { commands.push(value); } }
    }
  });
  const adapter = new DiscordChannelAdapter({
    token: "test-token",
    nativeCommands: true,
    clientFactory: () => client
  });
  const controller = new AbortController();
  await adapter.start({
    signal: controller.signal,
    async deliver(input) {
      await adapter.send({ address: input.address, text: `reply:${input.text}`, replyToId: input.id });
      return true;
    },
    updateStatus() {}
  });
  const interaction = {
    id: "950",
    channelId: "800",
    guildId: "700",
    commandName: "odinn",
    user: { id: "500", username: "jason", globalName: "Jason" },
    member: { roles: { cache: new Map([["900", {}]]) } },
    options: { getString() { return "run diagnostics"; } },
    isChatInputCommand() { return true; },
    isButton() { return false; },
    isStringSelectMenu() { return false; },
    async deferReply() {},
    async editReply(body: any) { edits.push(body); return { id: "951" }; },
    async followUp() { throw new Error("unexpected follow-up"); }
  };
  client.emit("interactionCreate", interaction);
  await new Promise((resolveWait) => setImmediate(resolveWait));
  assert.equal(commands.length, 1);
  assert.equal(edits[0].content, "reply:run diagnostics");
  const normalized = normalizeDiscordInteraction({
    ...interaction,
    id: "952",
    isChatInputCommand() { return false; },
    isButton() { return true; },
    customId: "confirm"
  });
  assert.equal(normalized?.text, "Discord component selected: confirm");
  assert.deepEqual(normalized?.metadata?.roleIds, ["900"]);
  await adapter.stop();
});

function fixtureDiscordClient({
  channel = {} as any,
  application = { id: "601" } as any
}: {
  channel?: any;
  application?: any;
} = {}) {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  return {
    user: { id: "600", username: "Odinn" },
    application,
    ws: { ping: 10 },
    channels: {
      async fetch() { return channel; }
    },
    on(event: string, listener: (...args: any[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return this;
    },
    once(event: string, listener: (...args: any[]) => void) {
      const wrapper = (...args: any[]) => {
        listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== wrapper));
        listener(...args);
      };
      listeners.set(event, [...(listeners.get(event) ?? []), wrapper]);
      return this;
    },
    async login() {
      this.emit("clientReady", this);
      return "test-token";
    },
    async destroy() {},
    isReady() { return true; },
    emit(event: string, ...args: any[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    }
  };
}
