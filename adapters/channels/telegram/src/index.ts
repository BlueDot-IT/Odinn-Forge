import { type ChannelAdapter, type InboundChannelMessage, type OutboundChannelMessage, splitChannelText } from "@odinn/channels";

interface TelegramAdapterOptions {
  token: string;
  accountId?: string;
  pollTimeoutSeconds?: number;
  retryDelayMs?: number;
  fetch?: typeof globalThis.fetch;
  onError?: (error: unknown) => void;
}
interface TelegramResponse { ok?: boolean; description?: string; result?: unknown }

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly #token: string;
  readonly #accountId: string;
  readonly #pollTimeoutSeconds: number;
  readonly #retryDelayMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #onError?: (error: unknown) => void;
  #offset = 0;
  #running = false;
  #poll?: Promise<void>;
  #abort?: AbortController;

  constructor(options: TelegramAdapterOptions) {
    if (!options.token.trim()) throw new Error("Telegram channel requires a bot token");
    this.#token = options.token;
    this.#accountId = options.accountId?.trim() || "default";
    this.id = `telegram:${this.#accountId}`;
    this.#pollTimeoutSeconds = Math.min(50, Math.max(1, options.pollTimeoutSeconds ?? 30));
    this.#retryDelayMs = Math.max(100, options.retryDelayMs ?? 1_000);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#onError = options.onError;
  }

  async start(deliver: (message: InboundChannelMessage) => Promise<void>): Promise<void> {
    if (this.#running) throw new Error("Telegram channel is already running");
    this.#running = true;
    this.#abort = new AbortController();
    this.#poll = this.#pollLoop(deliver);
  }
  async stop(): Promise<void> {
    this.#running = false;
    this.#abort?.abort();
    await this.#poll?.catch(() => undefined);
    this.#poll = undefined;
    this.#abort = undefined;
  }
  async send(message: OutboundChannelMessage): Promise<void> {
    if (message.address.channel !== "telegram") throw new Error("Telegram adapter cannot send to another channel");
    for (const text of splitChannelText(message.text, 4_096)) {
      await this.#api("sendMessage", {
        chat_id: message.address.conversationId, text,
        ...message.replyToId ? { reply_parameters: { message_id: numericId(message.replyToId) } } : {}
      });
    }
  }

  async #pollLoop(deliver: (message: InboundChannelMessage) => Promise<void>): Promise<void> {
    while (this.#running) {
      try {
        const result = await this.#api("getUpdates", {
          offset: this.#offset, timeout: this.#pollTimeoutSeconds, allowed_updates: ["message"]
        });
        if (!Array.isArray(result)) throw new Error("Telegram getUpdates returned an invalid result");
        for (const update of result) {
          const normalized = normalizeTelegramUpdate(update, this.#accountId);
          const updateId = telegramUpdateId(update);
          if (updateId >= this.#offset) this.#offset = updateId + 1;
          if (normalized) await deliver(normalized);
        }
      } catch (error: unknown) {
        if (!this.#running) break;
        this.#onError?.(error);
        await delay(this.#retryDelayMs, this.#abort?.signal).catch(() => undefined);
      }
    }
  }
  async #api(method: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.#fetch(`https://api.telegram.org/bot${this.#token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: this.#abort?.signal
    });
    const value = await response.json().catch(() => ({})) as TelegramResponse;
    if (!response.ok || value.ok !== true) throw new Error(value.description || `Telegram ${method} failed with ${response.status}`);
    return value.result;
  }
}

export function normalizeTelegramUpdate(value: unknown, accountId = "default"): InboundChannelMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const update = value as Record<string, any>;
  const message = update.message;
  if (!message || typeof message !== "object" || typeof message.text !== "string" || !message.text.trim()) return undefined;
  if (!message.chat || !["private", "group", "supergroup", "channel"].includes(message.chat.type)) return undefined;
  const senderId = message.from?.id ?? message.sender_chat?.id;
  if (!Number.isSafeInteger(senderId)) return undefined;
  const updateId = telegramUpdateId(update);
  return {
    id: String(numericId(message.message_id)),
    address: {
      channel: "telegram", accountId, conversationId: String(message.chat.id),
      conversationKind: message.chat.type === "private" ? "direct" : message.chat.type === "channel" ? "channel" : "group",
      ...message.message_thread_id === undefined ? {} : { threadId: String(numericId(message.message_thread_id)) }
    },
    sender: {
      id: String(senderId),
      ...telegramDisplayName(message.from, message.sender_chat) ? { displayName: telegramDisplayName(message.from, message.sender_chat) } : {},
      ...typeof message.from?.username === "string" ? { username: message.from.username } : {}
    },
    text: message.text.trim(),
    receivedAt: new Date(Number(message.date) * 1_000).toISOString(),
    ...message.reply_to_message?.message_id === undefined ? {} : { replyToId: String(numericId(message.reply_to_message.message_id)) },
    metadata: { updateId }
  };
}

function telegramUpdateId(value: unknown): number {
  const updateId = (value as Record<string, unknown> | undefined)?.update_id;
  if (!Number.isSafeInteger(updateId) || Number(updateId) < 0) throw new Error("Telegram update requires a valid update_id");
  return Number(updateId);
}
function numericId(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("Telegram message requires a numeric identifier");
  return number;
}
function telegramDisplayName(from: any, senderChat: any): string | undefined {
  const person = [
    typeof from?.first_name === "string" ? from.first_name.trim() : "",
    typeof from?.last_name === "string" ? from.last_name.trim() : ""
  ].filter(Boolean).join(" ");
  if (person) return person;
  return typeof senderChat?.title === "string" && senderChat.title.trim() ? senderChat.title.trim() : undefined;
}
function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
