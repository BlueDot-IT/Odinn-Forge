import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type Message
} from "discord.js";
import {
  ChannelDeliveryError,
  ChannelRetryableError,
  type ChannelAcknowledgement,
  type ChannelAccessPolicy,
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

const ACKNOWLEDGEMENT_EMOJI: Record<ChannelAcknowledgement, string> = {
  processing: "👀",
  succeeded: "✅",
  failed: "❌"
};

interface DiscordClientLike {
  user?: { id: string; username?: string } | null;
  application?: {
    id: string;
    commands?: { set: (...args: any[]) => Promise<any> };
  } | null;
  ws?: { ping?: number };
  channels: {
    fetch(id: string): Promise<any>;
  };
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  login(token: string): Promise<string>;
  destroy(): Promise<void> | void;
  isReady?(): boolean;
}

export interface DiscordAdapterOptions {
  token: string;
  accountId?: string;
  requireMention?: boolean;
  acknowledgementEmoji?: Partial<Record<ChannelAcknowledgement, string>>;
  allowBots?: boolean | "mentions";
  botLoopProtection?: {
    maxEventsPerWindow?: number;
    windowSeconds?: number;
    cooldownSeconds?: number;
  };
  nativeCommands?: boolean;
  nativeCommandName?: string;
  nativeCommandEphemeral?: boolean;
  clientFactory?: () => DiscordClientLike;
  onError?: (error: unknown) => void;
}

export class DiscordChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly channel = "discord";
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
    nativeCommands: true,
    streaming: true
  };
  readonly #token: string;
  readonly #requireMention: boolean;
  readonly #acknowledgements: Record<ChannelAcknowledgement, string>;
  readonly #allowBots: boolean | "mentions";
  readonly #botLoop: Required<NonNullable<DiscordAdapterOptions["botLoopProtection"]>>;
  readonly #clientFactory: () => DiscordClientLike;
  readonly #onError?: (error: unknown) => void;
  readonly #nativeCommands: boolean;
  readonly #nativeCommandName: string;
  readonly #nativeCommandEphemeral: boolean;
  #client?: DiscordClientLike;
  #context?: ChannelStartContext;
  #running = false;
  #connectedAt?: string;
  #lastEventAt?: string;
  #reconnectAttempts = 0;
  #lastError?: string;
  readonly #botEvents = new Map<string, { events: number[]; blockedUntil: number }>();
  readonly #pendingInteractions = new Map<string, any>();

  constructor(options: DiscordAdapterOptions) {
    if (!options.token.trim()) throw new Error("Discord channel requires a bot token");
    this.#token = options.token;
    this.accountId = options.accountId?.trim() || "default";
    this.id = `discord:${this.accountId}`;
    this.#requireMention = options.requireMention !== false;
    this.#acknowledgements = { ...ACKNOWLEDGEMENT_EMOJI, ...options.acknowledgementEmoji };
    this.#allowBots = options.allowBots ?? false;
    this.#botLoop = {
      maxEventsPerWindow: Math.max(1, options.botLoopProtection?.maxEventsPerWindow ?? 20),
      windowSeconds: Math.max(1, options.botLoopProtection?.windowSeconds ?? 60),
      cooldownSeconds: Math.max(1, options.botLoopProtection?.cooldownSeconds ?? 60)
    };
    this.#nativeCommands = options.nativeCommands === true;
    this.#nativeCommandName = normalizeCommandName(options.nativeCommandName ?? "odinn");
    this.#nativeCommandEphemeral = options.nativeCommandEphemeral !== false;
    this.#clientFactory = options.clientFactory ?? (() => new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Channel, Partials.Message, Partials.User],
      allowedMentions: { parse: [], repliedUser: false },
      failIfNotExists: false
    }));
    this.#onError = options.onError;
  }

  async start(context: ChannelStartContext): Promise<void> {
    if (this.#running) throw new Error("Discord channel is already running");
    this.#running = true;
    this.#context = context;
    this.#reconnectAttempts = 0;
    context.updateStatus({ state: "starting", error: undefined });
    const client = this.#clientFactory();
    this.#client = client;
    this.#installListeners(client, context);
    context.signal.addEventListener("abort", () => {
      void this.stop();
    }, { once: true });
    try {
      await client.login(this.#token);
      if (!this.#connectedAt) this.#markConnected();
    } catch (error) {
      this.#running = false;
      this.#lastError = errorMessage(error);
      context.updateStatus({ state: "failed", error: this.#lastError });
      this.#onError?.(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.#running && !this.#client) return;
    this.#running = false;
    const client = this.#client;
    this.#client = undefined;
    this.#context?.updateStatus({ state: "stopped" });
    this.#context = undefined;
    await client?.destroy();
  }

  async send(message: OutboundChannelMessage): Promise<ChannelDeliveryReceipt> {
    const interaction = message.replyToId ? this.#pendingInteractions.get(message.replyToId) : undefined;
    if (interaction) return this.#sendInteraction(interaction, message);
    const client = this.#requiredClient();
    if (message.address.channel !== "discord") throw new Error("Discord adapter cannot send to another channel");
    const conversationId = message.address.threadId ?? message.address.conversationId;
    const channel = await client.channels.fetch(conversationId);
    if (!channel?.isTextBased?.() || typeof channel.send !== "function") {
      throw new Error(`Discord target is not a sendable text channel: ${conversationId}`);
    }
    const chunks = message.text?.trim() ? splitChannelText(message.text, 2_000) : [""];
    const messageIds: string[] = [];
    let first = true;
    try {
      for (const content of chunks) {
        const sent = await channel.send({
          ...(content ? { content } : {}),
          ...first && message.replyToId ? {
            reply: { messageReference: message.replyToId, failIfNotExists: false }
          } : {},
          ...first && message.attachments?.length ? {
            files: message.attachments.map((attachment) => ({
              attachment: requiredAttachmentSource(attachment),
              ...(attachment.filename ? { name: attachment.filename } : {}),
              ...(attachment.description ? { description: attachment.description } : {})
            }))
          } : {},
          ...first && message.components?.length ? {
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
              ...message.components.slice(0, 5).map((component) => new ButtonBuilder()
                .setCustomId(component.customId)
                .setLabel(component.label)
                .setStyle(buttonStyle(component.style))
                .setDisabled(component.disabled === true))
            )]
          } : {},
          flags: messageFlags(message)
        });
        messageIds.push(String(sent.id));
        first = false;
      }
    } catch (error) {
      const receipt: ChannelDeliveryReceipt = {
        status: messageIds.length ? "partial" : "failed",
        messageIds,
        conversationId,
        sentChunks: messageIds.length,
        totalChunks: chunks.length
      };
      if (!messageIds.length) {
        throw new ChannelRetryableError(`Discord delivery failed: ${errorMessage(error)}`, { cause: error });
      }
      throw new ChannelDeliveryError("Discord delivery partially completed", receipt, { cause: error });
    }
    return {
      status: "sent",
      messageIds,
      conversationId,
      sentChunks: messageIds.length,
      totalChunks: chunks.length
    };
  }

  async acknowledge(message: InboundChannelMessage, acknowledgement: ChannelAcknowledgement): Promise<void> {
    if (message.address.channel !== "discord") return;
    const channel = await this.#requiredClient().channels.fetch(message.address.threadId ?? message.address.conversationId);
    if (!channel?.messages?.fetch) return;
    const target = await channel.messages.fetch(message.id);
    const processing = this.#acknowledgements.processing;
    if (acknowledgement !== "processing" && processing) {
      await target.reactions?.resolve?.(processing)?.users?.remove?.(this.#requiredClient().user?.id).catch((error: unknown) => {
        this.#onError?.(error);
      });
    }
    const emoji = this.#acknowledgements[acknowledgement];
    if (emoji) await target.react(emoji);
  }

  async sendTyping(address: InboundChannelMessage["address"]): Promise<void> {
    const channel = await this.#requiredClient().channels.fetch(address.threadId ?? address.conversationId);
    if (typeof channel?.sendTyping === "function") await channel.sendTyping();
  }

  async edit(address: InboundChannelMessage["address"], messageId: string, message: OutboundChannelMessage): Promise<void> {
    const channel = await this.#requiredClient().channels.fetch(address.threadId ?? address.conversationId);
    if (!channel?.messages?.edit) throw new Error("Discord target does not support message editing");
    await channel.messages.edit(messageId, {
      content: message.text ?? "",
      allowedMentions: { parse: [], repliedUser: false },
      flags: messageFlags(message)
    });
  }

  async delete(address: InboundChannelMessage["address"], messageId: string): Promise<void> {
    const channel = await this.#requiredClient().channels.fetch(address.threadId ?? address.conversationId);
    if (!channel?.messages?.delete) throw new Error("Discord target does not support message deletion");
    await channel.messages.delete(messageId);
  }

  async probe() {
    const client = this.#client;
    return {
      channel: this.channel,
      accountId: this.accountId,
      state: client?.isReady?.() ? "connected" as const : this.#running ? "degraded" as const : "stopped" as const,
      connectedAt: this.#connectedAt,
      lastEventAt: this.#lastEventAt,
      reconnectAttempts: this.#reconnectAttempts,
      latencyMs: typeof client?.ws?.ping === "number" && Number.isFinite(client.ws.ping) ? client.ws.ping : undefined,
      error: this.#lastError,
      details: {
        botUserId: client?.user?.id,
        botUsername: client?.user?.username,
        applicationId: client?.application?.id
      }
    };
  }

  #installListeners(client: DiscordClientLike, context: ChannelStartContext): void {
    client.once(Events.ClientReady, () => {
      this.#markConnected();
      void this.#registerNativeCommands(client).catch((error) => {
        this.#lastError = errorMessage(error);
        context.updateStatus({ state: "degraded", error: this.#lastError });
        this.#onError?.(error);
      });
    });
    client.on(Events.ShardReady, () => this.#markConnected());
    client.on(Events.ShardResume, () => this.#markConnected());
    client.on(Events.ShardReconnecting, () => {
      this.#reconnectAttempts += 1;
      context.updateStatus({ state: "degraded", reconnectAttempts: this.#reconnectAttempts });
    });
    client.on(Events.ShardDisconnect, (event: { code?: number }) => {
      context.updateStatus({
        state: "degraded",
        details: { closeCode: event?.code },
        reconnectAttempts: this.#reconnectAttempts
      });
    });
    client.on(Events.Error, (error: unknown) => {
      this.#lastError = errorMessage(error);
      context.updateStatus({ state: "degraded", error: this.#lastError });
      this.#onError?.(error);
    });
    client.on(Events.MessageCreate, (message: Message | Record<string, any>) => {
      this.#lastEventAt = new Date().toISOString();
      context.updateStatus({ lastEventAt: this.#lastEventAt });
      const normalized = normalizeDiscordMessage(message, {
        accountId: this.accountId,
        botUserId: client.user?.id ?? "",
        requireMention: this.#requireMention,
        allowBots: this.#allowBots
      });
      if (!normalized) return;
      if (normalized.metadata?.authorBot === true && !this.#acceptBotMessage(normalized)) return;
      void context.deliver(normalized).catch((error) => {
        this.#onError?.(error);
      });
    });
    client.on(Events.InteractionCreate, (interaction: any) => {
      void this.#handleInteraction(interaction, context).catch((error) => {
        this.#onError?.(error);
      });
    });
  }

  #markConnected(): void {
    this.#connectedAt = new Date().toISOString();
    this.#lastError = undefined;
    this.#reconnectAttempts = 0;
    this.#context?.updateStatus({
      state: "connected",
      connectedAt: this.#connectedAt,
      reconnectAttempts: 0,
      error: undefined
    });
  }

  #requiredClient(): DiscordClientLike {
    const client = this.#client;
    if (!client || !this.#running) throw new Error("Discord channel is not running");
    return client;
  }

  #acceptBotMessage(message: InboundChannelMessage): boolean {
    const key = `${message.address.conversationId}:${message.sender.id}`;
    const now = Date.now();
    const current = this.#botEvents.get(key) ?? { events: [], blockedUntil: 0 };
    if (current.blockedUntil > now) return false;
    const windowStart = now - this.#botLoop.windowSeconds * 1_000;
    current.events = current.events.filter((eventAt) => eventAt >= windowStart);
    current.events.push(now);
    if (current.events.length > this.#botLoop.maxEventsPerWindow) {
      current.blockedUntil = now + this.#botLoop.cooldownSeconds * 1_000;
      current.events = [];
      this.#botEvents.set(key, current);
      return false;
    }
    this.#botEvents.set(key, current);
    return true;
  }

  async #registerNativeCommands(client: DiscordClientLike): Promise<void> {
    if (!this.#nativeCommands || !client.application?.commands?.set) return;
    await client.application.commands.set([{
      name: this.#nativeCommandName,
      description: "Send a prompt to Ódinn",
      options: [{
        type: ApplicationCommandOptionType.String,
        name: "prompt",
        description: "What should Ódinn do?",
        required: true,
        maxLength: 2_000
      }]
    }]);
  }

  async #handleInteraction(interaction: any, context: ChannelStartContext): Promise<void> {
    const normalized = normalizeDiscordInteraction(interaction, {
      accountId: this.accountId,
      commandName: this.#nativeCommandName
    });
    if (!normalized) return;
    this.#lastEventAt = new Date().toISOString();
    context.updateStatus({ lastEventAt: this.#lastEventAt });
    if (typeof interaction.deferReply === "function") {
      await interaction.deferReply({ ephemeral: this.#nativeCommandEphemeral });
    }
    this.#pendingInteractions.set(normalized.id, interaction);
    try {
      const accepted = await context.deliver(normalized);
      if (!accepted && this.#pendingInteractions.has(normalized.id) && typeof interaction.editReply === "function") {
        await interaction.editReply({ content: "This Discord interaction is not allowed." });
      }
    } finally {
      this.#pendingInteractions.delete(normalized.id);
    }
  }

  async #sendInteraction(interaction: any, message: OutboundChannelMessage): Promise<ChannelDeliveryReceipt> {
    const chunks = message.text?.trim() ? splitChannelText(message.text, 2_000) : [""];
    const messageIds: string[] = [];
    let first = true;
    try {
      for (const content of chunks) {
        const body = discordSendBody(message, content, first);
        const sent = first
          ? await interaction.editReply(body)
          : await interaction.followUp({ ...body, ephemeral: this.#nativeCommandEphemeral });
        messageIds.push(String(sent?.id ?? interaction.id));
        first = false;
      }
    } catch (error) {
      const receipt: ChannelDeliveryReceipt = {
        status: messageIds.length ? "partial" : "failed",
        messageIds,
        conversationId: message.address.threadId ?? message.address.conversationId,
        sentChunks: messageIds.length,
        totalChunks: chunks.length
      };
      if (!messageIds.length) {
        throw new ChannelRetryableError(`Discord interaction delivery failed: ${errorMessage(error)}`, { cause: error });
      }
      throw new ChannelDeliveryError("Discord interaction delivery partially completed", receipt, { cause: error });
    }
    return {
      status: "sent",
      messageIds,
      conversationId: message.address.threadId ?? message.address.conversationId,
      sentChunks: messageIds.length,
      totalChunks: chunks.length
    };
  }
}

export function normalizeDiscordInteraction(value: unknown, {
  accountId = "default",
  commandName = "odinn"
}: {
  accountId?: string;
  commandName?: string;
} = {}): InboundChannelMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const interaction = value as Record<string, any>;
  const id = optionalString(interaction.id);
  const channelId = optionalString(interaction.channelId);
  const senderId = optionalString(interaction.user?.id ?? interaction.member?.user?.id);
  if (!id || !channelId || !senderId) return undefined;
  let text = "";
  let interactionType = "";
  if (interaction.isChatInputCommand?.() === true) {
    if (interaction.commandName !== commandName) return undefined;
    text = optionalString(interaction.options?.getString?.("prompt", true)) ?? "";
    interactionType = "command";
  } else if (interaction.isButton?.() === true) {
    text = `Discord component selected: ${optionalString(interaction.customId) ?? "button"}`;
    interactionType = "button";
  } else if (interaction.isStringSelectMenu?.() === true) {
    const values = Array.isArray(interaction.values) ? interaction.values.map(String) : [];
    text = `Discord component selected: ${optionalString(interaction.customId) ?? "select"}${values.length ? ` (${values.join(", ")})` : ""}`;
    interactionType = "select";
  } else {
    return undefined;
  }
  if (!text.trim()) return undefined;
  const guildId = optionalString(interaction.guildId);
  const isThread = Boolean(interaction.channel?.isThread?.());
  const parentId = optionalString(interaction.channel?.parentId);
  const roles = interaction.member?.roles;
  return {
    id,
    address: {
      channel: "discord",
      accountId,
      conversationId: parentId ?? channelId,
      conversationKind: isThread ? "thread" : guildId ? "channel" : "direct",
      ...(isThread ? { threadId: channelId } : {})
    },
    sender: {
      id: senderId,
      displayName: optionalString(interaction.member?.displayName)
        ?? optionalString(interaction.user?.globalName)
        ?? optionalString(interaction.user?.username),
      ...(optionalString(interaction.user?.username) ? { username: optionalString(interaction.user.username) } : {})
    },
    text,
    receivedAt: new Date().toISOString(),
    metadata: {
      interactionType,
      ...(optionalString(interaction.customId) ? { customId: optionalString(interaction.customId) } : {}),
      ...(guildId ? { guildId } : {}),
      ...(parentId ? { parentChannelId: parentId } : {}),
      ...Array.isArray(roles) ? { roleIds: roles.map(String) } : {},
      ...roles?.cache ? { roleIds: [...roles.cache.keys()] } : {},
      mentionedBot: true
    }
  };
}

export function normalizeDiscordMessage(value: unknown, {
  accountId = "default",
  botUserId = "",
  requireMention = true,
  allowBots = false
}: {
  accountId?: string;
  botUserId?: string;
  requireMention?: boolean;
  allowBots?: boolean | "mentions";
} = {}): InboundChannelMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = value as Record<string, any>;
  const id = optionalString(message.id);
  const channelId = optionalString(message.channelId ?? message.channel_id);
  const author = message.author;
  const authorId = optionalString(author?.id);
  if (!id || !channelId || !authorId || authorId === botUserId) return undefined;
  const content = optionalString(message.content)?.trim() ?? "";
  const attachments = discordAttachments(message.attachments);
  if (!content && !attachments.length) return undefined;
  const guildId = optionalString(message.guildId ?? message.guild_id);
  const direct = !guildId;
  const mentioned = discordMentionsUser(message.mentions, botUserId);
  const repliedToBot = optionalString(message.mentions?.repliedUser?.id) === botUserId;
  if (author?.bot === true && (allowBots === false || allowBots === "mentions" && !mentioned && !repliedToBot)) return undefined;
  if (!direct && requireMention && (!botUserId || (!mentioned && !repliedToBot))) return undefined;
  const text = botUserId
    ? content.replace(new RegExp(`<@!?${escapeRegExp(botUserId)}>`, "gu"), "").trim()
    : content;
  const isThread = Boolean(message.channel?.isThread?.());
  const threadId = isThread ? channelId : undefined;
  const parentId = optionalString(message.channel?.parentId);
  return {
    id,
    address: {
      channel: "discord",
      accountId,
      conversationId: parentId ?? channelId,
      conversationKind: isThread ? "thread" : direct ? "direct" : "channel",
      ...(threadId ? { threadId } : {})
    },
    sender: {
      id: authorId,
      displayName: discordDisplayName(message),
      ...optionalString(author?.username) ? { username: optionalString(author.username) } : {}
    },
    text,
    receivedAt: discordTimestamp(message),
    ...optionalString(message.reference?.messageId ?? message.message_reference?.message_id) ? {
      replyToId: optionalString(message.reference?.messageId ?? message.message_reference?.message_id)
    } : {},
    ...(attachments.length ? { attachments } : {}),
    metadata: {
      ...(guildId ? { guildId } : {}),
      ...optionalString(message.webhookId ?? message.webhook_id) ? {
        webhookId: optionalString(message.webhookId ?? message.webhook_id)
      } : {},
      ...Array.isArray(message.member?.roles) ? { roleIds: message.member.roles.map(String) } : {},
      ...message.member?.roles?.cache ? { roleIds: [...message.member.roles.cache.keys()] } : {},
      ...(parentId ? { parentChannelId: parentId } : {}),
      ...(mentioned ? { mentionedBot: true } : {}),
      ...(repliedToBot ? { repliedToBot: true } : {}),
      ...(author?.bot === true ? { authorBot: true } : {})
    }
  };
}

function discordMentionsUser(mentions: unknown, userId: string): boolean {
  if (!userId || !mentions) return false;
  if (Array.isArray(mentions)) return mentions.some((user) => optionalString(user?.id) === userId);
  const users = (mentions as Record<string, any>).users;
  if (typeof users?.has === "function") return users.has(userId);
  if (typeof (mentions as Record<string, any>).has === "function") return (mentions as Record<string, any>).has(userId);
  return false;
}

function discordAttachments(value: unknown) {
  const entries = Array.isArray(value)
    ? value
    : value && typeof (value as Record<string, unknown>).values === "function"
      ? [...(value as { values(): Iterable<any> }).values()]
      : [];
  return entries.map((attachment: any) => ({
    id: optionalString(attachment.id),
    filename: optionalString(attachment.name ?? attachment.filename),
    contentType: optionalString(attachment.contentType ?? attachment.content_type),
    size: Number.isSafeInteger(attachment.size) ? Number(attachment.size) : undefined,
    url: optionalString(attachment.url),
    description: optionalString(attachment.description)
  })).filter((attachment) => attachment.url);
}

function discordDisplayName(message: Record<string, any>): string {
  for (const value of [
    message.member?.displayName,
    message.member?.nickname,
    message.member?.nick,
    message.author?.globalName,
    message.author?.global_name,
    message.author?.username
  ]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return optionalString(message.author?.id) ?? "Discord user";
}

function discordTimestamp(message: Record<string, any>): string {
  const date = new Date(message.createdTimestamp ?? message.timestamp);
  return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
}

function requiredAttachmentSource(attachment: NonNullable<OutboundChannelMessage["attachments"]>[number]): string {
  const source = attachment.path ?? attachment.url;
  if (!source?.trim()) throw new Error("Discord attachment requires a path or URL");
  return source;
}

function buttonStyle(style: NonNullable<OutboundChannelMessage["components"]>[number]["style"]): ButtonStyle {
  switch (style) {
    case "primary": return ButtonStyle.Primary;
    case "success": return ButtonStyle.Success;
    case "danger": return ButtonStyle.Danger;
    case "secondary":
    case undefined:
      return ButtonStyle.Secondary;
  }
}

function messageFlags(message: OutboundChannelMessage): MessageFlags | undefined {
  let flags = 0;
  if (message.silent) flags |= MessageFlags.SuppressNotifications;
  if (message.suppressEmbeds !== false) flags |= MessageFlags.SuppressEmbeds;
  return flags || undefined;
}

function discordSendBody(message: OutboundChannelMessage, content: string, first: boolean): Record<string, unknown> {
  return {
    ...(content ? { content } : {}),
    ...first && message.attachments?.length ? {
      files: message.attachments.map((attachment) => ({
        attachment: requiredAttachmentSource(attachment),
        ...(attachment.filename ? { name: attachment.filename } : {}),
        ...(attachment.description ? { description: attachment.description } : {})
      }))
    } : {},
    ...first && message.components?.length ? {
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...message.components.slice(0, 5).map((component) => new ButtonBuilder()
          .setCustomId(component.customId)
          .setLabel(component.label)
          .setStyle(buttonStyle(component.style))
          .setDisabled(component.disabled === true))
      )]
    } : {},
    flags: messageFlags(message)
  };
}

function normalizeCommandName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/u.test(normalized)) throw new Error("Discord native command name is invalid");
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export type DiscordDirectMessagePolicy = "disabled" | "allowlist" | "open";
export type DiscordGroupPolicy = "disabled" | "allowlist" | "open";
export interface DiscordGuildChannelPolicy {
  enabled?: boolean;
  requireMention?: boolean;
  users?: string[];
  roles?: string[];
}
export interface DiscordGuildPolicy {
  requireMention?: boolean;
  users?: string[];
  roles?: string[];
  channels?: Record<string, DiscordGuildChannelPolicy>;
}
export interface DiscordChannelAccountConfig extends ChannelAccountConfig {
  requireMention: boolean;
  dmPolicy: DiscordDirectMessagePolicy;
  groupPolicy: DiscordGroupPolicy;
  allowBots: boolean | "mentions";
  acknowledgementEmoji: Partial<Record<ChannelAcknowledgement, string>>;
  guilds: Record<string, DiscordGuildPolicy>;
  botLoopProtection: {
    maxEventsPerWindow: number;
    windowSeconds: number;
    cooldownSeconds: number;
  };
  nativeCommands: boolean;
  nativeCommandName: string;
  nativeCommandEphemeral: boolean;
}

export const discordChannelPlugin: ChannelPlugin<DiscordChannelAccountConfig> = {
  id: "discord",
  displayName: "Discord",
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
    nativeCommands: true,
    streaming: true
  },
  normalizeAccountConfig(_accountId, value) {
    const record = objectRecord(value);
    const botLoop = objectRecord(record.botLoopProtection);
    return {
      enabled: record.enabled === true,
      tokenEnv: optionalString(record.tokenEnv) ?? "",
      allowlist: stringArray(record.allowlist),
      ...(optionalString(record.defaultModel) ? { defaultModel: optionalString(record.defaultModel) } : {}),
      historyLimit: positiveInteger(record.historyLimit, 40),
      requireMention: record.requireMention !== false,
      dmPolicy: oneOf(record.dmPolicy, ["disabled", "allowlist", "open"], "allowlist"),
      groupPolicy: oneOf(record.groupPolicy, ["disabled", "allowlist", "open"], "allowlist"),
      allowBots: record.allowBots === true || record.allowBots === "mentions" ? record.allowBots : false,
      acknowledgementEmoji: normalizeAcknowledgements(record.acknowledgementEmoji),
      guilds: normalizeGuilds(record.guilds),
      botLoopProtection: {
        maxEventsPerWindow: positiveInteger(botLoop.maxEventsPerWindow, 20),
        windowSeconds: positiveInteger(botLoop.windowSeconds, 60),
        cooldownSeconds: positiveInteger(botLoop.cooldownSeconds, 60)
      },
      nativeCommands: record.nativeCommands === true,
      nativeCommandName: normalizeCommandName(optionalString(record.nativeCommandName) ?? "odinn"),
      nativeCommandEphemeral: record.nativeCommandEphemeral !== false
    };
  },
  validateAccountConfig(accountId, config) {
    const errors: string[] = [];
    if (!config.tokenEnv) errors.push(`Discord account ${accountId} requires tokenEnv`);
    if (!config.allowlist.length && config.dmPolicy !== "open" && config.groupPolicy !== "open" && !Object.keys(config.guilds).length) {
      errors.push(`Discord account ${accountId} denies all inbound messages`);
    }
    return errors;
  },
  createAdapter({ accountId, config, credential, onError }) {
    return new DiscordChannelAdapter({
      token: credential,
      accountId,
      requireMention: false,
      acknowledgementEmoji: config.acknowledgementEmoji,
      allowBots: config.allowBots,
      botLoopProtection: config.botLoopProtection,
      nativeCommands: config.nativeCommands,
      nativeCommandName: config.nativeCommandName,
      nativeCommandEphemeral: config.nativeCommandEphemeral,
      onError
    });
  },
  createAccessPolicy(config) {
    return createDiscordAccessPolicy(config);
  }
};

export function createDiscordAccessPolicy(config: DiscordChannelAccountConfig): ChannelAccessPolicy {
  const allowlist = new Set(config.allowlist.map(normalizeAllowEntry).filter(Boolean));
  return {
    allows(message) {
      if (message.address.channel !== "discord") return false;
      const senderAllowed = allowlist.has(message.sender.id);
      const conversationAllowed = allowlist.has(message.address.conversationId)
        || Boolean(message.address.threadId && allowlist.has(message.address.threadId));
      if (message.address.conversationKind === "direct") {
        if (config.dmPolicy === "disabled") return false;
        return config.dmPolicy === "open" || senderAllowed || conversationAllowed;
      }
      if (config.groupPolicy === "disabled") return false;
      const guildId = optionalString(message.metadata?.guildId);
      const guild = guildId ? config.guilds[guildId] : undefined;
      if (config.groupPolicy === "open") {
        const channelId = optionalString(message.metadata?.parentChannelId)
          ?? message.address.threadId
          ?? message.address.conversationId;
        const requireMention = guild?.channels?.[channelId]?.requireMention ?? guild?.requireMention ?? config.requireMention;
        return !requireMention || message.metadata?.mentionedBot === true || message.metadata?.repliedToBot === true;
      }
      if (!guild) {
        const mentioned = message.metadata?.mentionedBot === true || message.metadata?.repliedToBot === true;
        return (senderAllowed || conversationAllowed) && (!config.requireMention || mentioned);
      }
      const channelId = optionalString(message.metadata?.parentChannelId)
        ?? message.address.threadId
        ?? message.address.conversationId;
      const channel = guild.channels?.[channelId];
      if (channel?.enabled === false) return false;
      if (guild.channels && !channel) return false;
      const requireMention = channel?.requireMention ?? guild.requireMention ?? config.requireMention;
      if (requireMention && message.metadata?.mentionedBot !== true && message.metadata?.repliedToBot !== true) return false;
      const roleIds = stringArray(message.metadata?.roleIds);
      const identityRulePresent = Boolean(
        guild.users?.length || guild.roles?.length || channel?.users?.length || channel?.roles?.length
      );
      const identityAllowed = senderAllowed
        || Boolean(guild.users?.includes(message.sender.id))
        || Boolean(channel?.users?.includes(message.sender.id))
        || roleIds.some((roleId) => guild.roles?.includes(roleId) || channel?.roles?.includes(roleId));
      return conversationAllowed || !identityRulePresent || identityAllowed;
    }
  };
}

function normalizeGuilds(value: unknown): Record<string, DiscordGuildPolicy> {
  return Object.fromEntries(Object.entries(objectRecord(value)).flatMap(([guildId, rawGuild]) => {
    if (!/^\d{1,20}$/u.test(guildId)) return [];
    const guild = objectRecord(rawGuild);
    const channels = Object.fromEntries(Object.entries(objectRecord(guild.channels)).flatMap(([channelId, rawChannel]) => {
      if (!/^\d{1,20}$/u.test(channelId)) return [];
      const channel = objectRecord(rawChannel);
      return [[channelId, {
        enabled: channel.enabled !== false,
        requireMention: channel.requireMention !== false,
        users: snowflakeArray(channel.users),
        roles: snowflakeArray(channel.roles)
      }]];
    }));
    return [[guildId, {
      requireMention: guild.requireMention !== false,
      users: snowflakeArray(guild.users),
      roles: snowflakeArray(guild.roles),
      ...(Object.keys(channels).length ? { channels } : {})
    }]];
  }));
}

function normalizeAcknowledgements(value: unknown): Partial<Record<ChannelAcknowledgement, string>> {
  const record = objectRecord(value);
  return Object.fromEntries(["processing", "succeeded", "failed"].flatMap((key) => {
    const emoji = typeof record[key] === "string" ? record[key].trim() : "";
    return emoji ? [[key, emoji]] : [];
  }));
}

function normalizeAllowEntry(value: string): string {
  return value.trim().replace(/^discord:/iu, "");
}

function snowflakeArray(value: unknown): string[] {
  return stringArray(value).filter((entry) => /^\d{1,20}$/u.test(entry));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))]
    : [];
}

function objectRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : fallback;
}

export { DiscordRestClient } from "./rest.ts";
export { createDiscordAgentToolDefinitions, DISCORD_AGENT_TOOL_SCHEMAS } from "./agent-tools.ts";
