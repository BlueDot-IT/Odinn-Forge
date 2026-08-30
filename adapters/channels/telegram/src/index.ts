import { Bot, InputFile, type Context } from "grammy";
import {
  ChannelDeliveryError,
  ChannelRetryableError,
  type ChannelAcknowledgement,
  type ChannelAdapter,
  type ChannelAccountConfig,
  type ChannelCapabilities,
  type ChannelDeliveryReceipt,
  type ChannelPlugin,
  type ChannelStartContext,
  type InboundChannelMessage,
  type OutboundChannelMessage,
  splitChannelText
} from "@odinn/channels";

const TELEGRAM_ACKNOWLEDGEMENTS: Record<ChannelAcknowledgement, string> = {
  processing: "👀",
  succeeded: "👍",
  failed: "👎"
};

interface TelegramBotLike {
  botInfo?: { id: number; username?: string };
  api: any;
  on(filter: any, middleware: (context: any) => Promise<void> | void): unknown;
  catch(handler: (error: any) => unknown): void;
  start(options?: Record<string, unknown>): Promise<void>;
  stop(): Promise<void>;
}

export interface TelegramAdapterOptions {
  token: string;
  accountId?: string;
  pollTimeoutSeconds?: number;
  requireMention?: boolean;
  acknowledgementEmoji?: Partial<Record<ChannelAcknowledgement, string>>;
  nativeCommands?: boolean;
  nativeCommandName?: string;
  botFactory?: (token: string) => TelegramBotLike;
  onError?: (error: unknown) => void;
}

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly channel = "telegram";
  readonly accountId: string;
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["direct", "group", "channel", "thread"],
    reactions: true,
    replies: true,
    typing: true,
    threads: true,
    media: true,
    edits: true,
    deletes: true,
    components: true,
    nativeCommands: true
  };
  readonly #token: string;
  readonly #pollTimeoutSeconds: number;
  readonly #requireMention: boolean;
  readonly #acknowledgements: Record<ChannelAcknowledgement, string>;
  readonly #nativeCommands: boolean;
  readonly #nativeCommandName: string;
  readonly #botFactory: (token: string) => TelegramBotLike;
  readonly #onError?: (error: unknown) => void;
  #bot?: TelegramBotLike;
  #poll?: Promise<void>;
  #context?: ChannelStartContext;
  #running = false;
  #connectedAt?: string;
  #lastEventAt?: string;
  #reconnectAttempts = 0;
  #lastError?: string;

  constructor(options: TelegramAdapterOptions) {
    if (!options.token.trim()) throw new Error("Telegram channel requires a bot token");
    this.#token = options.token;
    this.accountId = options.accountId?.trim() || "default";
    this.id = `telegram:${this.accountId}`;
    this.#pollTimeoutSeconds = Math.min(50, Math.max(1, options.pollTimeoutSeconds ?? 30));
    this.#requireMention = options.requireMention === true;
    this.#acknowledgements = { ...TELEGRAM_ACKNOWLEDGEMENTS, ...options.acknowledgementEmoji };
    this.#nativeCommands = options.nativeCommands === true;
    this.#nativeCommandName = normalizeCommandName(options.nativeCommandName ?? "odinn");
    this.#botFactory = options.botFactory ?? ((token) => new Bot(token));
    this.#onError = options.onError;
  }

  async start(context: ChannelStartContext): Promise<void> {
    if (this.#running) throw new Error("Telegram channel is already running");
    this.#running = true;
    this.#context = context;
    this.#reconnectAttempts = 0;
    context.updateStatus({ state: "starting", error: undefined });
    const bot = this.#botFactory(this.#token);
    this.#bot = bot;
    bot.on(["message", "channel_post"], async (telegramContext: Context) => {
      this.#lastEventAt = new Date().toISOString();
      context.updateStatus({ lastEventAt: this.#lastEventAt });
      const normalized = normalizeTelegramUpdate(telegramContext.update, this.accountId, {
        botUserId: bot.botInfo?.id,
        botUsername: bot.botInfo?.username,
        requireMention: this.#requireMention,
        nativeCommandName: this.#nativeCommandName
      });
      if (normalized) await context.deliver(normalized);
    });
    bot.on("callback_query:data", async (telegramContext: Context) => {
      await telegramContext.answerCallbackQuery().catch(() => undefined);
      const normalized = normalizeTelegramCallbackQuery(telegramContext.update, this.accountId);
      if (normalized) await context.deliver(normalized);
    });
    bot.catch((error) => {
      this.#reconnectAttempts += 1;
      this.#lastError = telegramErrorMessage(error);
      context.updateStatus({
        state: "degraded",
        reconnectAttempts: this.#reconnectAttempts,
        error: this.#lastError
      });
      this.#onError?.(error);
    });
    context.signal.addEventListener("abort", () => {
      void this.stop();
    }, { once: true });
    this.#poll = bot.start({
      timeout: this.#pollTimeoutSeconds,
      allowed_updates: ["message", "channel_post", "callback_query"],
      onStart: async (botInfo: { id: number; username?: string }) => {
        this.#connectedAt = new Date().toISOString();
        this.#lastError = undefined;
        this.#reconnectAttempts = 0;
        context.updateStatus({
          state: "connected",
          connectedAt: this.#connectedAt,
          reconnectAttempts: 0,
          error: undefined,
          details: { botUserId: String(botInfo.id), botUsername: botInfo.username }
        });
        if (this.#nativeCommands) {
          await bot.api.setMyCommands([{
            command: this.#nativeCommandName,
            description: "Send a prompt to Ódinn"
          }]);
        }
      }
    }).catch((error) => {
      if (!this.#running) return;
      this.#lastError = telegramErrorMessage(error);
      context.updateStatus({ state: "failed", error: this.#lastError });
      this.#onError?.(error);
    });
  }

  async stop(): Promise<void> {
    if (!this.#running && !this.#bot) return;
    this.#running = false;
    const bot = this.#bot;
    this.#bot = undefined;
    this.#context?.updateStatus({ state: "stopped" });
    this.#context = undefined;
    await bot?.stop().catch(() => undefined);
    await this.#poll?.catch(() => undefined);
    this.#poll = undefined;
  }

  async send(message: OutboundChannelMessage): Promise<ChannelDeliveryReceipt> {
    if (message.address.channel !== "telegram") throw new Error("Telegram adapter cannot send to another channel");
    const api = this.#requiredBot().api;
    const chatId = message.address.conversationId;
    const chunks = message.text?.trim() ? splitChannelText(message.text, 4_096) : [];
    const messageIds: string[] = [];
    const totalChunks = chunks.length + (message.attachments?.length ?? 0);
    try {
      for (const attachment of message.attachments ?? []) {
        const source = telegramAttachmentSource(attachment);
        const sent = await api.sendDocument(chatId, source, {
          ...(attachment.description ? { caption: attachment.description } : {}),
          ...(message.address.threadId ? { message_thread_id: numericId(message.address.threadId) } : {})
        });
        if (sent?.message_id !== undefined) messageIds.push(String(sent.message_id));
      }
      let first = true;
      for (const text of chunks) {
        const sent = await api.sendMessage(chatId, text, {
          ...(first && message.replyToId ? {
            reply_parameters: { message_id: numericId(message.replyToId), allow_sending_without_reply: true }
          } : {}),
          ...(message.address.threadId ? { message_thread_id: numericId(message.address.threadId) } : {}),
          ...(first && message.silent ? { disable_notification: true } : {}),
          ...(first && message.components?.length ? {
            reply_markup: {
              inline_keyboard: [message.components.slice(0, 8).map((component) => ({
                text: component.label,
                callback_data: component.customId
              }))]
            }
          } : {})
        });
        if (sent?.message_id !== undefined) messageIds.push(String(sent.message_id));
        first = false;
      }
    } catch (error) {
      const receipt: ChannelDeliveryReceipt = {
        status: messageIds.length ? "partial" : "failed",
        messageIds,
        conversationId: chatId,
        sentChunks: messageIds.length,
        totalChunks
      };
      if (messageIds.length) throw new ChannelDeliveryError("Telegram delivery partially completed", receipt, { cause: error });
      if (telegramErrorRetryable(error)) {
        throw new ChannelRetryableError(`Telegram delivery failed: ${telegramErrorMessage(error)}`, { cause: error });
      }
      throw error;
    }
    return {
      status: "sent",
      messageIds,
      conversationId: chatId,
      sentChunks: messageIds.length,
      totalChunks
    };
  }

  async acknowledge(message: InboundChannelMessage, acknowledgement: ChannelAcknowledgement): Promise<void> {
    if (message.address.channel !== "telegram") return;
    const emoji = this.#acknowledgements[acknowledgement];
    if (!emoji) return;
    await this.#requiredBot().api.setMessageReaction(
      message.address.conversationId,
      numericId(message.id),
      [{ type: "emoji", emoji }],
      { is_big: acknowledgement !== "processing" }
    );
  }

  async sendTyping(address: InboundChannelMessage["address"]): Promise<void> {
    await this.#requiredBot().api.sendChatAction(address.conversationId, "typing", {
      ...(address.threadId ? { message_thread_id: numericId(address.threadId) } : {})
    });
  }

  async edit(address: InboundChannelMessage["address"], messageId: string, message: OutboundChannelMessage): Promise<void> {
    await this.#requiredBot().api.editMessageText(
      address.conversationId,
      numericId(messageId),
      message.text ?? "",
      message.components?.length ? {
        reply_markup: {
          inline_keyboard: [message.components.slice(0, 8).map((component) => ({
            text: component.label,
            callback_data: component.customId
          }))]
        }
      } : {}
    );
  }

  async delete(address: InboundChannelMessage["address"], messageId: string): Promise<void> {
    await this.#requiredBot().api.deleteMessage(address.conversationId, numericId(messageId));
  }

  async probe() {
    const startedAt = Date.now();
    try {
      const me = await this.#requiredBot().api.getMe();
      return {
        channel: this.channel,
        accountId: this.accountId,
        state: "connected" as const,
        connectedAt: this.#connectedAt,
        lastEventAt: this.#lastEventAt,
        reconnectAttempts: this.#reconnectAttempts,
        latencyMs: Date.now() - startedAt,
        error: undefined,
        details: { botUserId: String(me.id), botUsername: me.username }
      };
    } catch (error) {
      return {
        channel: this.channel,
        accountId: this.accountId,
        state: this.#running ? "degraded" as const : "stopped" as const,
        connectedAt: this.#connectedAt,
        lastEventAt: this.#lastEventAt,
        reconnectAttempts: this.#reconnectAttempts,
        latencyMs: Date.now() - startedAt,
        error: telegramErrorMessage(error)
      };
    }
  }

  #requiredBot(): TelegramBotLike {
    if (!this.#bot || !this.#running) throw new Error("Telegram channel is not running");
    return this.#bot;
  }
}

export function normalizeTelegramUpdate(value: unknown, accountId = "default", {
  botUserId,
  botUsername,
  requireMention = false,
  nativeCommandName = "odinn"
}: {
  botUserId?: number;
  botUsername?: string;
  requireMention?: boolean;
  nativeCommandName?: string;
} = {}): InboundChannelMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const update = value as Record<string, any>;
  const message = update.message ?? update.channel_post;
  if (!message || typeof message !== "object") return undefined;
  if (!message.chat || !["private", "group", "supergroup", "channel"].includes(message.chat.type)) return undefined;
  const senderId = message.from?.id ?? message.sender_chat?.id;
  if (!Number.isSafeInteger(senderId)) return undefined;
  const textValue = typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : "";
  const attachments = telegramAttachments(message);
  if (!textValue.trim() && !attachments.length) return undefined;
  const direct = message.chat.type === "private";
  const mention = botUsername ? new RegExp(`@${escapeRegExp(botUsername)}\\b`, "iu") : undefined;
  const repliedToBot = botUserId !== undefined && Number(message.reply_to_message?.from?.id) === botUserId;
  const command = new RegExp(`^/${escapeRegExp(nativeCommandName)}(?:@${escapeRegExp(botUsername ?? "")})?\\s*`, "iu");
  const isCommand = command.test(textValue);
  if (!direct && requireMention && !isCommand && !repliedToBot && !mention?.test(textValue)) return undefined;
  const withoutCommand = textValue.replace(command, "");
  const text = (mention ? withoutCommand.replace(mention, "") : withoutCommand).trim();
  const updateId = telegramUpdateId(update);
  return {
    id: String(numericId(message.message_id)),
    address: {
      channel: "telegram",
      accountId,
      conversationId: String(message.chat.id),
      conversationKind: direct ? "direct" : message.chat.type === "channel" ? "channel" : "group",
      ...message.message_thread_id === undefined ? {} : { threadId: String(numericId(message.message_thread_id)) }
    },
    sender: {
      id: String(senderId),
      ...telegramDisplayName(message.from, message.sender_chat) ? {
        displayName: telegramDisplayName(message.from, message.sender_chat)
      } : {},
      ...typeof message.from?.username === "string" ? { username: message.from.username } : {}
    },
    text: text || (attachments.length ? "[Telegram attachment]" : ""),
    receivedAt: new Date(Number(message.date) * 1_000).toISOString(),
    ...message.reply_to_message?.message_id === undefined ? {} : {
      replyToId: String(numericId(message.reply_to_message.message_id))
    },
    ...(attachments.length ? { attachments } : {}),
    metadata: {
      updateId,
      ...(isCommand ? { nativeCommand: nativeCommandName } : {}),
      ...(repliedToBot ? { repliedToBot: true } : {}),
      ...(mention?.test(textValue) ? { mentionedBot: true } : {})
    }
  };
}

export function normalizeTelegramCallbackQuery(value: unknown, accountId = "default"): InboundChannelMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const update = value as Record<string, any>;
  const callback = update.callback_query;
  const message = callback?.message;
  if (!callback || !message || typeof callback.data !== "string" || !callback.data.trim()) return undefined;
  if (!message.chat || !["private", "group", "supergroup", "channel"].includes(message.chat.type)) return undefined;
  return {
    id: String(callback.id),
    address: {
      channel: "telegram",
      accountId,
      conversationId: String(message.chat.id),
      conversationKind: message.chat.type === "private" ? "direct" : message.chat.type === "channel" ? "channel" : "group",
      ...message.message_thread_id === undefined ? {} : { threadId: String(numericId(message.message_thread_id)) }
    },
    sender: {
      id: String(callback.from.id),
      ...telegramDisplayName(callback.from, undefined) ? { displayName: telegramDisplayName(callback.from, undefined) } : {},
      ...typeof callback.from.username === "string" ? { username: callback.from.username } : {}
    },
    text: `Telegram component selected: ${callback.data.trim()}`,
    receivedAt: new Date().toISOString(),
    replyToId: String(numericId(message.message_id)),
    metadata: {
      updateId: telegramUpdateId(update),
      interactionType: "callback",
      customId: callback.data.trim()
    }
  };
}

function telegramAttachments(message: Record<string, any>) {
  const attachments = [];
  const photo = Array.isArray(message.photo) ? message.photo.at(-1) : undefined;
  if (photo?.file_id) attachments.push({
    id: String(photo.file_id),
    filename: "photo.jpg",
    contentType: "image/jpeg",
    size: Number.isSafeInteger(photo.file_size) ? Number(photo.file_size) : undefined
  });
  for (const [field, fallbackType] of [
    ["document", "application/octet-stream"],
    ["audio", "audio/mpeg"],
    ["video", "video/mp4"],
    ["voice", "audio/ogg"],
    ["animation", "image/gif"],
    ["sticker", "application/octet-stream"]
  ] as const) {
    const item = message[field];
    if (!item?.file_id) continue;
    attachments.push({
      id: String(item.file_id),
      filename: typeof item.file_name === "string" ? item.file_name : field,
      contentType: typeof item.mime_type === "string" ? item.mime_type : fallbackType,
      size: Number.isSafeInteger(item.file_size) ? Number(item.file_size) : undefined
    });
  }
  return attachments;
}

function telegramAttachmentSource(attachment: NonNullable<OutboundChannelMessage["attachments"]>[number]): string | InputFile {
  if (attachment.path?.trim()) return new InputFile(attachment.path);
  if (attachment.url?.trim()) return attachment.url;
  if (attachment.id?.trim()) return attachment.id;
  throw new Error("Telegram attachment requires a path, URL, or Telegram file identifier");
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

function telegramErrorMessage(error: unknown): string {
  const nested = (error as Record<string, any> | undefined)?.error;
  return nested?.description
    ?? (error instanceof Error ? error.message : String(error));
}

function telegramErrorRetryable(error: unknown): boolean {
  const nested = (error as Record<string, any> | undefined)?.error;
  const code = Number(nested?.error_code ?? (error as Record<string, any> | undefined)?.error_code);
  return !Number.isFinite(code) || code === 408 || code === 429 || code >= 500;
}

function normalizeCommandName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,31}$/u.test(normalized)) throw new Error("Telegram native command name is invalid");
  return normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export interface TelegramChannelAccountConfig extends ChannelAccountConfig {
  pollTimeoutSeconds: number;
  requireMention: boolean;
  acknowledgementEmoji: Partial<Record<ChannelAcknowledgement, string>>;
  nativeCommands: boolean;
  nativeCommandName: string;
}

export const telegramChannelPlugin: ChannelPlugin<TelegramChannelAccountConfig> = {
  id: "telegram",
  displayName: "Telegram",
  capabilities: {
    chatTypes: ["direct", "group", "channel", "thread"],
    reactions: true,
    replies: true,
    typing: true,
    threads: true,
    media: true,
    edits: true,
    deletes: true,
    components: true,
    nativeCommands: true
  },
  normalizeAccountConfig(_accountId, value) {
    const record = objectRecord(value);
    return {
      enabled: record.enabled === true,
      tokenEnv: typeof record.tokenEnv === "string" ? record.tokenEnv.trim() : "",
      allowlist: stringArray(record.allowlist),
      ...(typeof record.defaultModel === "string" && record.defaultModel.trim() ? {
        defaultModel: record.defaultModel.trim()
      } : {}),
      historyLimit: Number.isSafeInteger(record.historyLimit)
        ? Math.min(200, Math.max(1, Number(record.historyLimit)))
        : 40,
      pollTimeoutSeconds: Number.isSafeInteger(record.pollTimeoutSeconds)
        ? Math.min(50, Math.max(1, Number(record.pollTimeoutSeconds)))
        : 30,
      requireMention: record.requireMention !== false,
      acknowledgementEmoji: normalizeAcknowledgements(record.acknowledgementEmoji),
      nativeCommands: record.nativeCommands === true,
      nativeCommandName: normalizeCommandName(
        typeof record.nativeCommandName === "string" ? record.nativeCommandName : "odinn"
      )
    };
  },
  validateAccountConfig(accountId, config) {
    const errors: string[] = [];
    if (!config.tokenEnv) errors.push(`Telegram account ${accountId} requires tokenEnv`);
    if (!config.allowlist.length) errors.push(`Telegram account ${accountId} denies all inbound messages`);
    return errors;
  },
  createAdapter({ accountId, config, credential, onError }) {
    return new TelegramChannelAdapter({
      token: credential,
      accountId,
      pollTimeoutSeconds: config.pollTimeoutSeconds,
      requireMention: config.requireMention,
      acknowledgementEmoji: config.acknowledgementEmoji,
      nativeCommands: config.nativeCommands,
      nativeCommandName: config.nativeCommandName,
      onError
    });
  }
};

function normalizeAcknowledgements(value: unknown): Partial<Record<ChannelAcknowledgement, string>> {
  const record = objectRecord(value);
  return Object.fromEntries(["processing", "succeeded", "failed"].flatMap((key) => {
    const emoji = typeof record[key] === "string" ? record[key].trim() : "";
    return emoji ? [[key, emoji]] : [];
  }));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))]
    : [];
}

function objectRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
