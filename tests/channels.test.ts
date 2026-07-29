import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ChannelAdmissionError, ChannelRouter, FileSessionBindingStore, channelConversationKey, createAllowlistPolicy, splitChannelText,
  type ChannelAcknowledgement, type ChannelAdapter, type InboundChannelMessage, type OutboundChannelMessage
} from "../packages/channels/src/index.ts";
import { normalizeTelegramUpdate } from "../adapters/channels/telegram/src/index.ts";
import { DiscordChannelAdapter, normalizeDiscordMessage } from "../adapters/channels/discord/src/index.ts";

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
  readonly sent: OutboundChannelMessage[] = [];
  readonly acknowledgements: Array<{ id: string; acknowledgement: ChannelAcknowledgement }> = [];
  deliver?: (message: InboundChannelMessage) => Promise<void>;
  async start(deliver: (message: InboundChannelMessage) => Promise<void>): Promise<void> { this.deliver = deliver; }
  async stop(): Promise<void> {}
  async send(output: OutboundChannelMessage): Promise<void> { this.sent.push(output); }
  async acknowledge(input: InboundChannelMessage, acknowledgement: ChannelAcknowledgement): Promise<void> {
    this.acknowledgements.push({ id: input.id, acknowledgement });
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
  await Promise.all([rejectedConversation, rejectedGlobal]);
  await new Promise((resolveWait) => setImmediate(resolveWait));

  assert.deepEqual(events, ["start:10", "start:13"]);
  assert.deepEqual(errors.map(({ id }) => id), ["12", "14"]);
  assert.deepEqual(errors.map(({ error }) => error instanceof ChannelAdmissionError && error.scope), ["conversation", "global"]);
  releaseFirst?.();
  await Promise.all([first, second, otherConversation]);
  assert.ok(events.indexOf("end:10") < events.indexOf("start:11"));
  assert.ok(events.indexOf("start:11") < events.indexOf("end:11"));

  await adapter.deliver?.(message({ id: "12" }));
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
  await adapter.deliver?.(message({ id: "12" }));
  await adapter.deliver?.(message({ id: "13", sender: { id: "101" } }));
  await adapter.deliver?.(message({ id: "14", sender: { id: "102" } }));

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

test("Discord replies disable mention parsing and respect the 2000-character limit", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const adapter = new DiscordChannelAdapter({
    token: "test-token",
    fetch: async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ id: String(requests.length) }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  await adapter.send({
    address: { channel: "discord", accountId: "community", conversationId: "800", conversationKind: "channel" },
    text: "x".repeat(2_001),
    replyToId: "900"
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.content.length, 2_000);
  assert.deepEqual(requests[0].body.allowed_mentions, { parse: [], replied_user: false });
  assert.equal(requests[0].body.message_reference.message_id, "900");
  assert.equal(requests[1].body.message_reference, undefined);
});

test("Discord acknowledgements replace the processing reaction with a terminal reaction", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  const adapter = new DiscordChannelAdapter({
    token: "test-token",
    fetch: async (input, init) => {
      requests.push({ method: String(init?.method), url: String(input) });
      return new Response(null, { status: 204 });
    }
  });
  const input = message({
    id: "900",
    address: { channel: "discord", accountId: "community", conversationId: "800", conversationKind: "channel" }
  });

  await adapter.acknowledge(input, "processing");
  await adapter.acknowledge(input, "succeeded");

  assert.deepEqual(requests.map((entry) => entry.method), ["PUT", "DELETE", "PUT"]);
  assert.match(requests[0].url, /reactions\/%F0%9F%91%80\/@me$/u);
  assert.match(requests[2].url, /reactions\/%E2%9C%85\/@me$/u);
});

test("Discord Gateway identifies and delivers normalized message events", async () => {
  class FixtureSocket {
    readonly listeners = new Map<string, Array<(event: any) => void>>();
    readonly sent: any[] = [];
    addEventListener(type: string, listener: (event: any) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() { this.emit("close", {}); }
    emit(type: string, event: any) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }
  const socket = new FixtureSocket();
  const delivered: InboundChannelMessage[] = [];
  const adapter = new DiscordChannelAdapter({
    token: "test-token",
    retryDelayMs: 100,
    fetch: async () => new Response(JSON.stringify({ url: "wss://gateway.discord.test" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
    socketFactory: () => socket
  });
  await adapter.start(async (input) => { delivered.push(input); });
  await new Promise((resolveWait) => setImmediate(resolveWait));
  socket.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }) });
  socket.emit("message", { data: JSON.stringify({ op: 0, t: "READY", s: 1, d: { user: { id: "600" } } }) });
  socket.emit("message", { data: JSON.stringify({ op: 1, d: null }) });
  socket.emit("message", { data: JSON.stringify({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 2,
    d: {
      id: "900",
      channel_id: "800",
      guild_id: "700",
      content: "<@600> hello",
      timestamp: "2026-07-26T12:00:00.000Z",
      author: { id: "500", username: "jason", bot: false },
      mentions: [{ id: "600" }]
    }
  }) });
  await new Promise((resolveWait) => setImmediate(resolveWait));
  assert.equal(socket.sent[0].op, 2);
  assert.equal(socket.sent[0].d.intents, 37_377);
  assert.deepEqual(socket.sent[1], { op: 1, d: 1 });
  assert.equal(delivered[0].text, "hello");
  await adapter.stop();
});
