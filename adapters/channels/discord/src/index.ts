import { type ChannelAdapter, type InboundChannelMessage, type OutboundChannelMessage, splitChannelText } from "@odinn/channels";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_INTENTS = 1 | 512 | 4_096 | 32_768;

interface SocketLike {
  addEventListener(type: string, listener: (event: any) => void): void;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}
interface DiscordAdapterOptions {
  token: string;
  accountId?: string;
  requireMention?: boolean;
  retryDelayMs?: number;
  fetch?: typeof globalThis.fetch;
  socketFactory?: (url: string) => SocketLike;
  onError?: (error: unknown) => void;
}

export class DiscordChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly #token: string;
  readonly #accountId: string;
  readonly #requireMention: boolean;
  readonly #retryDelayMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #socketFactory: (url: string) => SocketLike;
  readonly #onError?: (error: unknown) => void;
  #running = false;
  #loop?: Promise<void>;
  #socket?: SocketLike;
  #botUserId = "";

  constructor(options: DiscordAdapterOptions) {
    if (!options.token.trim()) throw new Error("Discord channel requires a bot token");
    this.#token = options.token;
    this.#accountId = options.accountId?.trim() || "default";
    this.id = `discord:${this.#accountId}`;
    this.#requireMention = options.requireMention !== false;
    this.#retryDelayMs = Math.max(100, options.retryDelayMs ?? 1_000);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.#onError = options.onError;
  }

  async start(deliver: (message: InboundChannelMessage) => Promise<void>): Promise<void> {
    if (this.#running) throw new Error("Discord channel is already running");
    this.#running = true;
    this.#loop = this.#connectionLoop(deliver);
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#socket?.close(1_000, "Odinn gateway stopping");
    await this.#loop?.catch(() => undefined);
    this.#loop = undefined;
    this.#socket = undefined;
  }

  async send(message: OutboundChannelMessage): Promise<void> {
    if (message.address.channel !== "discord") throw new Error("Discord adapter cannot send to another channel");
    let first = true;
    for (const content of splitChannelText(message.text, 2_000)) {
      await this.#api(`/channels/${encodeURIComponent(message.address.conversationId)}/messages`, {
        content,
        allowed_mentions: { parse: [], replied_user: false },
        ...first && message.replyToId ? {
          message_reference: { message_id: message.replyToId, fail_if_not_exists: false }
        } : {}
      });
      first = false;
    }
  }

  async #connectionLoop(deliver: (message: InboundChannelMessage) => Promise<void>): Promise<void> {
    while (this.#running) {
      try {
        const gateway = await this.#gatewayUrl();
        await this.#connect(gateway, deliver);
      } catch (error: unknown) {
        if (!this.#running) break;
        this.#onError?.(error);
      }
      if (this.#running) await delay(this.#retryDelayMs);
    }
  }

  async #connect(gateway: string, deliver: (message: InboundChannelMessage) => Promise<void>): Promise<void> {
    await new Promise<void>((resolveConnection, rejectConnection) => {
      const socket = this.#socketFactory(`${gateway.replace(/\/+$/u, "")}?v=10&encoding=json`);
      this.#socket = socket;
      let sequence: number | null = null;
      let heartbeat: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (heartbeat) clearInterval(heartbeat);
        if (error) rejectConnection(error);
        else resolveConnection();
      };
      socket.addEventListener("message", (event) => {
        void (async () => {
          const payload = JSON.parse(String(event.data));
          if (Number.isSafeInteger(payload.s)) sequence = payload.s;
          if (payload.op === 10) {
            const interval = Number(payload.d?.heartbeat_interval);
            if (!Number.isFinite(interval) || interval < 1_000) throw new Error("Discord Gateway returned an invalid heartbeat interval");
            const beat = () => socket.send(JSON.stringify({ op: 1, d: sequence }));
            heartbeat = setInterval(beat, interval);
            socket.send(JSON.stringify({
              op: 2,
              d: {
                token: this.#token,
                intents: DISCORD_INTENTS,
                properties: { os: process.platform, browser: "odinn", device: "odinn" }
              }
            }));
            return;
          }
          if (payload.op === 7 || payload.op === 9) {
            socket.close(4_000, "Discord requested reconnect");
            return;
          }
          if (payload.op !== 0) return;
          if (payload.t === "READY") {
            this.#botUserId = String(payload.d?.user?.id ?? "");
            return;
          }
          if (payload.t !== "MESSAGE_CREATE") return;
          const normalized = normalizeDiscordMessage(payload.d, {
            accountId: this.#accountId,
            botUserId: this.#botUserId,
            requireMention: this.#requireMention
          });
          if (normalized) await deliver(normalized);
        })().catch((error) => {
          this.#onError?.(error);
          socket.close(4_000, "Discord event handling failed");
        });
      });
      socket.addEventListener("error", () => finish(new Error("Discord Gateway connection failed")));
      socket.addEventListener("close", () => finish());
    });
  }

  async #gatewayUrl(): Promise<string> {
    const response = await this.#fetch(`${DISCORD_API}/gateway/bot`, {
      headers: { authorization: `Bot ${this.#token}` }
    });
    const value = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || typeof value.url !== "string") throw new Error(discordError(value, response.status));
    return value.url;
  }

  async #api(path: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.#fetch(`${DISCORD_API}${path}`, {
      method: "POST",
      headers: { authorization: `Bot ${this.#token}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const value = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(discordError(value, response.status));
    return value;
  }
}

export function normalizeDiscordMessage(value: unknown, {
  accountId = "default",
  botUserId = "",
  requireMention = true
}: { accountId?: string; botUserId?: string; requireMention?: boolean } = {}): InboundChannelMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = value as Record<string, any>;
  if (typeof message.id !== "string" || typeof message.channel_id !== "string") return undefined;
  if (message.author?.bot === true || typeof message.author?.id !== "string") return undefined;
  if (message.author.id === botUserId || typeof message.content !== "string" || !message.content.trim()) return undefined;
  const direct = typeof message.guild_id !== "string";
  const mentioned = Array.isArray(message.mentions) && message.mentions.some((user: any) => String(user?.id) === botUserId);
  if (!direct && requireMention && (!botUserId || !mentioned)) return undefined;
  const text = botUserId
    ? message.content.replace(new RegExp(`<@!?${escapeRegExp(botUserId)}>`, "gu"), "").trim()
    : message.content.trim();
  if (!text) return undefined;
  return {
    id: message.id,
    address: {
      channel: "discord",
      accountId,
      conversationId: message.channel_id,
      conversationKind: direct ? "direct" : "channel"
    },
    sender: {
      id: message.author.id,
      displayName: discordDisplayName(message),
      ...typeof message.author.username === "string" ? { username: message.author.username } : {}
    },
    text,
    receivedAt: discordTimestamp(message),
    ...typeof message.message_reference?.message_id === "string" ? { replyToId: message.message_reference.message_id } : {},
    metadata: {
      ...typeof message.guild_id === "string" ? { guildId: message.guild_id } : {},
      ...typeof message.webhook_id === "string" ? { webhookId: message.webhook_id } : {}
    }
  };
}

function discordDisplayName(message: Record<string, any>): string {
  for (const value of [message.member?.nick, message.author?.global_name, message.author?.username]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return String(message.author?.id ?? "Discord user");
}
function discordTimestamp(message: Record<string, any>): string {
  const date = new Date(message.timestamp);
  return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
}
function discordError(value: Record<string, unknown>, status: number): string {
  return typeof value.message === "string" ? `Discord API: ${value.message}` : `Discord API request failed with ${status}`;
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
