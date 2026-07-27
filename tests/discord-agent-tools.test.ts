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

test("Discord agent mutations require approval before external state changes", async () => {
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
    const pending = await registry.get("discord.sendMessage").execute({ channelId: "123", content: "hello" });
    assert.equal(pending.type, "approval.required");
    assert.equal(requests, 0);
    assert.equal(approvalStore.list().length, 1);
    const bypass = await registry.get("discord.sendMessage").execute({ channelId: "123", content: "hello", confirmed: true });
    assert.equal(bypass.type, "approval.required");
    assert.equal(requests, 0);
    const sent = await registry.get("discord.sendMessage").execute(
      { channelId: "123", content: "hello", confirmed: true },
      { request: { actor: "user-approved" } }
    );
    assert.equal(sent.id, "456");
    assert.equal(requests, 1);
    assert.equal(toolSafetyDescriptor("discord.sendMessage", registry.get("discord.sendMessage")).requiresApproval, true);
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
