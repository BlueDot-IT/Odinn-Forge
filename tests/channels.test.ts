import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ChannelRouter, FileSessionBindingStore, channelConversationKey, createAllowlistPolicy, splitChannelText,
  type ChannelAdapter, type InboundChannelMessage, type OutboundChannelMessage
} from "../packages/channels/src/index.ts";
import { normalizeTelegramUpdate } from "../adapters/channels/telegram/src/index.ts";

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
  deliver?: (message: InboundChannelMessage) => Promise<void>;
  async start(deliver: (message: InboundChannelMessage) => Promise<void>): Promise<void> { this.deliver = deliver; }
  async stop(): Promise<void> {}
  async send(output: OutboundChannelMessage): Promise<void> { this.sent.push(output); }
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
