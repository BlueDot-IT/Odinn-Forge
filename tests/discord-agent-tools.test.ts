import assert from "node:assert/strict";
import test from "node:test";

import { createApprovalStore, createBuiltInRegistry, toolSafetyDescriptor } from "../packages/kernel/src/index.ts";

function configuredDiscord() {
  return {
    plugins: {
      entries: {
        discord: {
          enabled: true,
          config: {
            accounts: {
              home: { enabled: true, tokenEnv: "ODINN_TEST_DISCORD_TOKEN" }
            }
          }
        }
      }
    }
  };
}

test("Discord agent read tools use the configured bot account", async () => {
  const original = process.env.ODINN_TEST_DISCORD_TOKEN;
  process.env.ODINN_TEST_DISCORD_TOKEN = "test-token";
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const registry = createBuiltInRegistry({
    config: configuredDiscord(),
    discordFetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify([{ id: "1", content: "hello" }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  try {
    const output = await registry.get("discord.readMessages").execute({ channelId: "123", limit: 10 });
    assert.deepEqual(output, [{ id: "1", content: "hello" }]);
    assert.equal(calls[0].url, "https://discord.com/api/v10/channels/123/messages?limit=10");
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bot test-token");
    assert.equal(registry.get("discord.readMessages").capability, "discord.read");
  } finally {
    if (original === undefined) delete process.env.ODINN_TEST_DISCORD_TOKEN;
    else process.env.ODINN_TEST_DISCORD_TOKEN = original;
  }
});

test("Discord mutations require action-bound one-time approval before fetch", async () => {
  const original = process.env.ODINN_TEST_DISCORD_TOKEN;
  process.env.ODINN_TEST_DISCORD_TOKEN = "test-token";
  let requests = 0;
  const approvalStore = createApprovalStore();
  const registry = createBuiltInRegistry({
    config: configuredDiscord(),
    approvalStore,
    discordFetch: async () => {
      requests += 1;
      return new Response(JSON.stringify({ id: "456", content: "approved" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  try {
    const sendInput = { channelId: "123", content: "hello" };
    const pending = await registry.get("discord.sendMessage").execute(sendInput, { request: { id: "run-send" } });
    assert.equal(pending.type, "approval.required");
    assert.equal(requests, 0, "Discord must not fetch before approval is claimed");
    approvalStore.claim(pending.approvalId);
    const sent = await registry.get("discord.sendMessage").execute(sendInput, {
      request: { id: "run-send" },
      trustedApprovalId: pending.approvalId
    });
    assert.equal(sent.id, "456");
    assert.equal(requests, 1);
    await assert.rejects(
      registry.get("discord.sendMessage").execute(sendInput, {
        request: { id: "run-send" },
        trustedApprovalId: pending.approvalId
      }),
      /approval is missing, expired, already used, or does not match/
    );
    assert.equal(requests, 1, "a consumed approval must not reach Discord twice");
    assert.equal(approvalStore.list().length, 0);
    assert.equal(toolSafetyDescriptor("discord.sendMessage", registry.get("discord.sendMessage")).requiresApproval, true);
    assert.equal(toolSafetyDescriptor("discord.addReaction", registry.get("discord.addReaction")).requiresApproval, true);
  } finally {
    if (original === undefined) delete process.env.ODINN_TEST_DISCORD_TOKEN;
    else process.env.ODINN_TEST_DISCORD_TOKEN = original;
  }
});

test("Discord reaction and thread approvals are claimed before fetch and bound to exact input", async () => {
  const original = process.env.ODINN_TEST_DISCORD_TOKEN;
  process.env.ODINN_TEST_DISCORD_TOKEN = "test-token";
  let requests = 0;
  const approvalStore = createApprovalStore();
  const registry = createBuiltInRegistry({
    config: configuredDiscord(),
    approvalStore,
    discordFetch: async () => {
      requests += 1;
      return new Response(JSON.stringify({ id: "thread-1" }), { status: 200 });
    }
  });
  try {
    const reactionInput = { channelId: "123", messageId: "456", emoji: "👍" };
    const reaction = await registry.get("discord.addReaction").execute(reactionInput, { request: { id: "run-reaction" } });
    assert.equal(reaction.type, "approval.required");
    assert.equal(requests, 0);
    approvalStore.claim(reaction.approvalId);
    await assert.rejects(
      registry.get("discord.addReaction").execute(reactionInput, {
        request: { id: "different-run" },
        trustedApprovalId: reaction.approvalId
      }),
      /does not match/
    );
    await assert.rejects(
      registry.get("discord.addReaction").execute({ ...reactionInput, emoji: "👎" }, {
        request: { id: "run-reaction" },
        trustedApprovalId: reaction.approvalId
      }),
      /does not match/
    );
    assert.equal(requests, 0, "mismatched action must fail before Discord fetch");
    await registry.get("discord.addReaction").execute(reactionInput, {
      request: { id: "run-reaction" },
      trustedApprovalId: reaction.approvalId
    });
    assert.equal(requests, 1);

    const threadInput = { channelId: "123", name: "Review" };
    const thread = await registry.get("discord.createThread").execute(threadInput, { request: { id: "run-thread" } });
    assert.equal(thread.type, "approval.required");
    assert.equal(requests, 1);
    await assert.rejects(
      registry.get("discord.createThread").execute(threadInput, {
        request: { id: "run-thread" },
        trustedApprovalId: thread.approvalId
      }),
      /approval is missing/
    );
    assert.equal(requests, 1, "unclaimed approval must fail before Discord fetch");
    approvalStore.claim(thread.approvalId);
    const created = await registry.get("discord.createThread").execute(threadInput, {
      request: { id: "run-thread" },
      trustedApprovalId: thread.approvalId
    });
    assert.equal(created.id, "thread-1");
    assert.equal(requests, 2);
  } finally {
    if (original === undefined) delete process.env.ODINN_TEST_DISCORD_TOKEN;
    else process.env.ODINN_TEST_DISCORD_TOKEN = original;
  }
});

test("Discord agent tools fail closed without an enabled configured account", async () => {
  const registry = createBuiltInRegistry({
    config: { plugins: { entries: { discord: { enabled: true, config: { accounts: {} } } } } }
  });
  await assert.rejects(
    registry.get("discord.readMessages").execute({ channelId: "123" }),
    /no enabled Discord account is configured/
  );
});

test("Discord plugin activation and individual tools are config-controlled", () => {
  const disabled = createBuiltInRegistry({
    config: { plugins: { entries: { discord: { enabled: false } } } }
  });
  assert.equal(disabled.has("discord.readMessages"), false);

  const configured = configuredDiscord() as any;
  configured.plugins.entries.discord.config.tools = { "discord.sendMessage": false };
  const restricted = createBuiltInRegistry({ config: configured });
  assert.equal(restricted.has("discord.readMessages"), true);
  assert.equal(restricted.has("discord.sendMessage"), false);
});

test("legacy Discord channel config continues to activate the tool plugin", () => {
  const registry = createBuiltInRegistry({
    config: {
      channels: {
        home: { type: "discord", enabled: true, tokenEnv: "ODINN_TEST_DISCORD_TOKEN" }
      }
    }
  });
  assert.equal(registry.has("discord.readMessages"), true);
});

test("expanded Discord actions preserve read/write gates and native poll payloads", async () => {
  const original = process.env.ODINN_TEST_DISCORD_TOKEN;
  process.env.ODINN_TEST_DISCORD_TOKEN = "test-token";
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const approvalStore = createApprovalStore();
  const registry = createBuiltInRegistry({
    config: configuredDiscord(),
    approvalStore,
    discordFetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "poll-1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  try {
    await registry.get("discord.listPins").execute({ channelId: "123" });
    assert.equal(calls[0].url, "https://discord.com/api/v10/channels/123/pins");
    assert.equal(registry.get("discord.listPins").capability, "discord.read");
    const input = {
      channelId: "123",
      question: "Deploy?",
      answers: ["Yes", "No"],
      durationHours: 12
    };
    const pending = await registry.get("discord.sendPoll").execute(input, { request: { id: "run-poll" } });
    assert.equal(pending.type, "approval.required");
    assert.equal(calls.length, 1);
    approvalStore.claim(pending.approvalId);
    await registry.get("discord.sendPoll").execute(input, {
      request: { id: "run-poll" },
      trustedApprovalId: pending.approvalId
    });
    const payload = JSON.parse(String(calls[1].init.body));
    assert.equal(payload.poll.question.text, "Deploy?");
    assert.deepEqual(payload.poll.answers.map((answer: any) => answer.poll_media.text), ["Yes", "No"]);
    assert.equal(registry.get("discord.sendPoll").capability, "discord.write");
  } finally {
    if (original === undefined) delete process.env.ODINN_TEST_DISCORD_TOKEN;
    else process.env.ODINN_TEST_DISCORD_TOKEN = original;
  }
});
