import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ChannelRetryableError,
  type ChannelAcknowledgement,
  type ChannelAdapter,
  type ChannelAccountConfig,
  type ChannelCapabilities,
  type ChannelDeliveryReceipt,
  type ChannelPlugin,
  type ChannelStartContext,
  type ChannelWebhookRequest,
  type ChannelWebhookResponse,
  type InboundChannelMessage,
  type OutboundChannelMessage,
  splitChannelText
} from "@odinn/channels";

export interface WhatsAppAdapterOptions {
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  phoneNumberId: string;
  apiVersion?: string;
  accountId?: string;
  fetch?: typeof globalThis.fetch;
  onError?: (error: unknown) => void;
}

export class WhatsAppChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly channel = "whatsapp";
  readonly accountId: string;
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["direct"],
    reactions: true,
    replies: true,
    media: true,
    components: true
  };
  readonly #accessToken: string;
  readonly #appSecret: string;
  readonly #verifyToken: string;
  readonly #phoneNumberId: string;
  readonly #apiVersion: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #onError?: (error: unknown) => void;
  #context?: ChannelStartContext;
  #running = false;
  #connectedAt?: string;
  #lastEventAt?: string;

  constructor(options: WhatsAppAdapterOptions) {
    for (const [label, value] of [
      ["access token", options.accessToken],
      ["app secret", options.appSecret],
      ["verify token", options.verifyToken],
      ["phone number ID", options.phoneNumberId]
    ]) {
      if (!value.trim()) throw new Error(`WhatsApp channel requires ${label}`);
    }
    this.#accessToken = options.accessToken;
    this.#appSecret = options.appSecret;
    this.#verifyToken = options.verifyToken;
    this.#phoneNumberId = numeric(options.phoneNumberId, "phoneNumberId");
    this.#apiVersion = /^v\d+\.\d+$/u.test(options.apiVersion ?? "") ? String(options.apiVersion) : "v23.0";
    this.accountId = options.accountId?.trim() || "default";
    this.id = `whatsapp:${this.accountId}`;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#onError = options.onError;
  }

  async start(context: ChannelStartContext): Promise<void> {
    if (this.#running) throw new Error("WhatsApp channel is already running");
    this.#running = true;
    this.#context = context;
    this.#connectedAt = new Date().toISOString();
    context.updateStatus({
      state: "connected",
      connectedAt: this.#connectedAt,
      error: undefined,
      details: { mode: "signed-webhook", phoneNumberId: this.#phoneNumberId, apiVersion: this.#apiVersion }
    });
    context.signal.addEventListener("abort", () => void this.stop(), { once: true });
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#context?.updateStatus({ state: "stopped" });
    this.#context = undefined;
  }

  async handleWebhook(request: ChannelWebhookRequest): Promise<ChannelWebhookResponse> {
    if (!this.#running || !this.#context) return { status: 503, body: "channel unavailable" };
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET") {
      const valid = url.searchParams.get("hub.mode") === "subscribe"
        && url.searchParams.get("hub.verify_token") === this.#verifyToken;
      return valid
        ? { status: 200, body: url.searchParams.get("hub.challenge") ?? "" }
        : { status: 403, body: "verification failed" };
    }
    if (request.method !== "POST" || !request.body) return { status: 405, body: "method not allowed" };
    if (!validWhatsAppSignature(request.body, header(request.headers, "x-hub-signature-256"), this.#appSecret)) {
      return { status: 401, body: "invalid signature" };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(request.body.toString("utf8"));
    } catch {
      return { status: 400, body: "invalid JSON" };
    }
    for (const message of normalizeWhatsAppWebhook(payload, this.accountId)) {
      this.#lastEventAt = new Date().toISOString();
      this.#context.updateStatus({ lastEventAt: this.#lastEventAt });
      await this.#context.deliver(message);
    }
    return { status: 200, body: "EVENT_RECEIVED" };
  }

  async send(message: OutboundChannelMessage): Promise<ChannelDeliveryReceipt> {
    if (message.address.channel !== "whatsapp") throw new Error("WhatsApp adapter cannot send to another channel");
    const chunks = message.text?.trim() ? splitChannelText(message.text, 4_096) : [];
    const messageIds: string[] = [];
    for (const attachment of message.attachments ?? []) {
      const type = whatsappMediaType(attachment.contentType);
      const result = await this.#request({
        messaging_product: "whatsapp",
        to: message.address.conversationId,
        type,
        [type]: {
          ...(attachment.url ? { link: attachment.url } : {}),
          ...(attachment.id ? { id: attachment.id } : {}),
          ...(attachment.description ? { caption: attachment.description } : {}),
          ...(attachment.filename && type === "document" ? { filename: attachment.filename } : {})
        }
      });
      if (result.messages?.[0]?.id) messageIds.push(String(result.messages[0].id));
    }
    for (let index = 0; index < chunks.length; index += 1) {
      const text = chunks[index];
      const components = index === 0 ? message.components?.slice(0, 3) : undefined;
      const result = await this.#request(components?.length ? {
        messaging_product: "whatsapp",
        to: message.address.conversationId,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text },
          action: {
            buttons: components.map((component) => ({
              type: "reply",
              reply: { id: component.customId, title: component.label.slice(0, 20) }
            }))
          }
        },
        ...(message.replyToId ? { context: { message_id: message.replyToId } } : {})
      } : {
        messaging_product: "whatsapp",
        to: message.address.conversationId,
        type: "text",
        text: { body: text, preview_url: message.suppressEmbeds === false },
        ...(index === 0 && message.replyToId ? { context: { message_id: message.replyToId } } : {})
      });
      if (result.messages?.[0]?.id) messageIds.push(String(result.messages[0].id));
    }
    return {
      status: "sent",
      messageIds,
      conversationId: message.address.conversationId,
      sentChunks: messageIds.length,
      totalChunks: chunks.length + (message.attachments?.length ?? 0)
    };
  }

  async acknowledge(message: InboundChannelMessage, acknowledgement: ChannelAcknowledgement): Promise<void> {
    const emoji = acknowledgement === "processing" ? "👀" : acknowledgement === "succeeded" ? "✅" : "❌";
    await this.#request({
      messaging_product: "whatsapp",
      to: message.address.conversationId,
      type: "reaction",
      reaction: { message_id: message.id, emoji }
    });
  }

  async probe() {
    const startedAt = Date.now();
    try {
      const response = await this.#fetch(
        `https://graph.facebook.com/${this.#apiVersion}/${this.#phoneNumberId}?fields=id,display_phone_number,verified_name`,
        { headers: { authorization: `Bearer ${this.#accessToken}` }, signal: AbortSignal.timeout(30_000) }
      );
      const value = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(`WhatsApp probe failed with ${response.status}`);
      return {
        channel: this.channel,
        accountId: this.accountId,
        state: "connected" as const,
        connectedAt: this.#connectedAt,
        lastEventAt: this.#lastEventAt,
        latencyMs: Date.now() - startedAt,
        details: {
          mode: "signed-webhook",
          phoneNumberId: this.#phoneNumberId,
          displayPhoneNumber: value.display_phone_number,
          verifiedName: value.verified_name
        }
      };
    } catch (error) {
      return {
        channel: this.channel,
        accountId: this.accountId,
        state: this.#running ? "degraded" as const : "stopped" as const,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async #request(body: Record<string, unknown>): Promise<any> {
    const response = await this.#fetch(
      `https://graph.facebook.com/${this.#apiVersion}/${this.#phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#accessToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000)
      }
    );
    const value = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok) {
      const message = value.error?.message ?? `WhatsApp request failed with ${response.status}`;
      if ([408, 429].includes(response.status) || response.status >= 500) {
        throw new ChannelRetryableError(message);
      }
      throw new Error(message);
    }
    return value;
  }
}

export function validWhatsAppSignature(body: Buffer, signature: string | undefined, appSecret: string): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const provided = Buffer.from(signature.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", appSecret).update(body).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function normalizeWhatsAppWebhook(value: unknown, accountId = "default"): InboundChannelMessage[] {
  const payload = objectRecord(value);
  const messages: InboundChannelMessage[] = [];
  for (const entry of array(payload.entry)) {
    for (const change of array(entry?.changes)) {
      const body = objectRecord(change?.value);
      const contacts = new Map(array(body.contacts).map((contact: any) => [
        String(contact.wa_id),
        text(contact.profile?.name)
      ]));
      for (const raw of array(body.messages)) {
        const id = text(raw.id);
        const from = text(raw.from);
        const content = whatsappInboundText(raw);
        if (!id || !from || !content) continue;
        const attachment = whatsappInboundAttachment(raw);
        messages.push({
          id,
          address: {
            channel: "whatsapp",
            accountId,
            conversationId: from,
            conversationKind: "direct"
          },
          sender: { id: from, displayName: contacts.get(from) },
          text: content,
          receivedAt: new Date(Number(raw.timestamp) * 1_000).toISOString(),
          ...(text(raw.context?.id) ? { replyToId: text(raw.context.id) } : {}),
          ...(attachment ? { attachments: [attachment] } : {}),
          metadata: {
            phoneNumberId: text(body.metadata?.phone_number_id),
            displayPhoneNumber: text(body.metadata?.display_phone_number),
            messageType: text(raw.type)
          }
        });
      }
    }
  }
  return messages;
}

function whatsappInboundText(message: any): string | undefined {
  if (message.type === "text") return text(message.text?.body);
  if (message.type === "button") return text(message.button?.text ?? message.button?.payload);
  if (message.type === "interactive") {
    return text(message.interactive?.button_reply?.title)
      ?? text(message.interactive?.button_reply?.id)
      ?? text(message.interactive?.list_reply?.title)
      ?? text(message.interactive?.list_reply?.id);
  }
  if (["image", "audio", "video", "document", "sticker"].includes(message.type)) {
    return text(message[message.type]?.caption) ?? `[WhatsApp ${message.type}]`;
  }
  return undefined;
}

function whatsappInboundAttachment(message: any) {
  if (!["image", "audio", "video", "document", "sticker"].includes(message.type)) return undefined;
  const media = message[message.type];
  return {
    id: text(media?.id),
    filename: text(media?.filename),
    contentType: text(media?.mime_type),
    description: text(media?.caption)
  };
}

function whatsappMediaType(contentType: string | undefined): "image" | "audio" | "video" | "document" {
  if (contentType?.startsWith("image/")) return "image";
  if (contentType?.startsWith("audio/")) return "audio";
  if (contentType?.startsWith("video/")) return "video";
  return "document";
}

function header(headers: ChannelWebhookRequest["headers"], name: string): string | undefined {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function numeric(value: unknown, field: string): string {
  const clean = String(value ?? "").trim();
  if (!/^\d{1,32}$/u.test(clean)) throw new Error(`WhatsApp ${field} must be numeric`);
  return clean;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function array(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function objectRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))]
    : [];
}

export interface WhatsAppChannelAccountConfig extends ChannelAccountConfig {
  appSecretEnv: string;
  verifyTokenEnv: string;
  phoneNumberId: string;
  apiVersion: string;
}

export const whatsappChannelPlugin: ChannelPlugin<WhatsAppChannelAccountConfig> = {
  id: "whatsapp",
  displayName: "WhatsApp Business",
  capabilities: {
    chatTypes: ["direct"],
    reactions: true,
    replies: true,
    media: true,
    components: true
  },
  normalizeAccountConfig(_accountId, value) {
    const record = objectRecord(value);
    const appSecretEnv = text(record.appSecretEnv) ?? "";
    const verifyTokenEnv = text(record.verifyTokenEnv) ?? "";
    return {
      enabled: record.enabled === true,
      tokenEnv: text(record.tokenEnv) ?? "",
      credentialEnvs: { appSecret: appSecretEnv, verifyToken: verifyTokenEnv },
      allowlist: stringArray(record.allowlist),
      ...(text(record.defaultModel) ? { defaultModel: text(record.defaultModel) } : {}),
      historyLimit: Number.isSafeInteger(record.historyLimit) ? Math.min(200, Math.max(1, Number(record.historyLimit))) : 40,
      appSecretEnv,
      verifyTokenEnv,
      phoneNumberId: text(record.phoneNumberId) ?? "",
      apiVersion: /^v\d+\.\d+$/u.test(String(record.apiVersion ?? "")) ? String(record.apiVersion) : "v23.0"
    };
  },
  validateAccountConfig(accountId, config) {
    const errors = [];
    if (!config.tokenEnv) errors.push(`WhatsApp account ${accountId} requires tokenEnv`);
    if (!config.appSecretEnv) errors.push(`WhatsApp account ${accountId} requires appSecretEnv`);
    if (!config.verifyTokenEnv) errors.push(`WhatsApp account ${accountId} requires verifyTokenEnv`);
    if (!/^\d{1,32}$/u.test(config.phoneNumberId)) errors.push(`WhatsApp account ${accountId} requires phoneNumberId`);
    if (!config.allowlist.length) errors.push(`WhatsApp account ${accountId} denies all inbound messages`);
    return errors;
  },
  createAdapter({ accountId, config, credential, credentials, onError }) {
    return new WhatsAppChannelAdapter({
      accountId,
      accessToken: credential,
      appSecret: credentials.appSecret ?? "",
      verifyToken: credentials.verifyToken ?? "",
      phoneNumberId: config.phoneNumberId,
      apiVersion: config.apiVersion,
      onError
    });
  },
  webhookPath(accountId) {
    return `/channels/webhook/whatsapp/${encodeURIComponent(accountId)}`;
  },
  webhookRequestMode: "buffer"
};
