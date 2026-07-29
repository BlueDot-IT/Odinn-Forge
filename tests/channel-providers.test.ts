import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  normalizeSlackInteraction,
  normalizeSlackMessage,
  slackChannelPlugin
} from "../adapters/channels/slack/src/index.ts";
import {
  normalizeTeamsActivity,
  teamsChannelPlugin
} from "../adapters/channels/teams/src/index.ts";
import {
  WhatsAppChannelAdapter,
  normalizeWhatsAppWebhook,
  validWhatsAppSignature,
  whatsappChannelPlugin
} from "../adapters/channels/whatsapp/src/index.ts";

test("Slack normalizes mentions, threads, and interactive actions", () => {
  const message = normalizeSlackMessage({
    ts: "1785280000.100",
    channel: "C100",
    user: "U100",
    text: "<@U999> inspect this",
    thread_ts: "1785279999.000",
    team: "T100"
  }, { accountId: "work", botUserId: "U999" });
  assert.equal(message?.text, "inspect this");
  assert.equal(message?.address.conversationKind, "thread");
  assert.equal(message?.address.threadId, "1785279999.000");
  assert.equal(normalizeSlackMessage({
    ts: "1785280000.101",
    channel: "C100",
    user: "U100",
    text: "no mention"
  }, { botUserId: "U999" }), undefined);
  assert.equal(normalizeSlackInteraction({
    trigger_id: "trigger",
    channel: { id: "C100" },
    user: { id: "U100", name: "Jason" },
    container: { message_ts: "1785280000.100" }
  }, { action_id: "confirm" })?.text, "Slack component selected: confirm");
});

test("Teams normalizes authenticated Bot Framework activities", () => {
  const message = normalizeTeamsActivity({
    type: "message",
    id: "activity-1",
    timestamp: "2026-07-29T12:00:00.000Z",
    text: "hello",
    from: { id: "user-1", aadObjectId: "aad-1", name: "Jason" },
    conversation: { id: "conversation-1" },
    channelData: {
      team: { id: "team-1" },
      channel: { id: "channel-1" },
      tenant: { id: "tenant-1" }
    }
  }, "work");
  assert.equal(message?.address.channel, "teams");
  assert.equal(message?.address.conversationKind, "channel");
  assert.equal(message?.sender.id, "aad-1");
  assert.equal(message?.metadata?.tenantId, "tenant-1");
});

test("WhatsApp validates webhook signatures and normalizes text, media, and replies", () => {
  const body = Buffer.from(JSON.stringify({
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: "123", display_phone_number: "15550001111" },
          contacts: [{ wa_id: "15550002222", profile: { name: "Jason" } }],
          messages: [{
            id: "wamid.1",
            from: "15550002222",
            timestamp: "1785280000",
            type: "document",
            document: { id: "media-1", filename: "proof.pdf", mime_type: "application/pdf", caption: "Review" },
            context: { id: "wamid.0" }
          }]
        }
      }]
    }]
  }));
  const secret = "app-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(validWhatsAppSignature(body, signature, secret), true);
  assert.equal(validWhatsAppSignature(body, signature, "wrong"), false);
  const messages = normalizeWhatsAppWebhook(JSON.parse(body.toString("utf8")), "business");
  assert.equal(messages[0].text, "Review");
  assert.equal(messages[0].attachments?.[0].filename, "proof.pdf");
  assert.equal(messages[0].replyToId, "wamid.0");
});

test("WhatsApp adapter authenticates webhooks before delivery and sends interactive replies", async () => {
  const delivered: any[] = [];
  const requests: any[] = [];
  const adapter = new WhatsAppChannelAdapter({
    accountId: "business",
    accessToken: "access-token",
    appSecret: "app-secret",
    verifyToken: "verify-token",
    phoneNumberId: "123",
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const controller = new AbortController();
  await adapter.start({
    signal: controller.signal,
    async deliver(message) { delivered.push(message); return true; },
    updateStatus() {}
  });
  const payload = Buffer.from(JSON.stringify({
    entry: [{
      changes: [{
        value: {
          messages: [{
            id: "wamid.in",
            from: "15550002222",
            timestamp: "1785280000",
            type: "text",
            text: { body: "hello" }
          }]
        }
      }]
    }]
  }));
  const signature = `sha256=${createHmac("sha256", "app-secret").update(payload).digest("hex")}`;
  assert.equal((await adapter.handleWebhook({
    method: "POST",
    headers: { "x-hub-signature-256": signature },
    body: payload
  }))?.status, 200);
  assert.equal(delivered.length, 1);
  assert.equal((await adapter.handleWebhook({
    method: "POST",
    headers: { "x-hub-signature-256": "sha256=00" },
    body: payload
  }))?.status, 401);
  await adapter.send({
    address: {
      channel: "whatsapp",
      accountId: "business",
      conversationId: "15550002222",
      conversationKind: "direct"
    },
    text: "Choose",
    components: [{ type: "button", customId: "confirm", label: "Confirm" }]
  });
  assert.equal(requests[0].type, "interactive");
  assert.equal(requests[0].interactive.action.buttons[0].reply.id, "confirm");
  await adapter.stop();
});

test("major-provider plugins require all credential references and deny empty allowlists", () => {
  const slack = slackChannelPlugin.normalizeAccountConfig("work", {});
  assert.equal(slackChannelPlugin.validateAccountConfig("work", slack).length, 3);
  const teams = teamsChannelPlugin.normalizeAccountConfig("work", {});
  assert.equal(teamsChannelPlugin.validateAccountConfig("work", teams).length, 3);
  const whatsapp = whatsappChannelPlugin.normalizeAccountConfig("business", {});
  assert.equal(whatsappChannelPlugin.validateAccountConfig("business", whatsapp).length, 5);
});
