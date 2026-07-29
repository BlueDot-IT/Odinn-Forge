import { App } from "@slack/bolt";
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

interface SlackAppLike {
  client: any;
  message(pattern: RegExp, handler: (args: any) => Promise<void> | void): void;
  event(name: string, handler: (args: any) => Promise<void> | void): void;
  action(pattern: RegExp, handler: (args: any) => Promise<void> | void): void;
  command(name: string, handler: (args: any) => Promise<void> | void): void;
  error(handler: (error: unknown) => Promise<void> | void): void;
  start(): Promise<any>;
  stop(): Promise<any>;
}

export interface SlackAdapterOptions {
  token: string;
  appToken: string;
  accountId?: string;
  requireMention?: boolean;
  nativeCommandName?: string;
  appFactory?: (options: Record<string, unknown>) => SlackAppLike;
  onError?: (error: unknown) => void;
}

export class SlackChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly channel = "slack";
  readonly accountId: string;
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["direct", "group", "channel", "thread"],
    reactions: true,
    replies: true,
    threads: true,
    media: true,
    edits: true,
    deletes: true,
    components: true,
    nativeCommands: true,
    streaming: true
  };
  readonly #token: string;
  readonly #appToken: string;
  readonly #requireMention: boolean;
  readonly #nativeCommandName: string;
  readonly #appFactory: (options: Record<string, unknown>) => SlackAppLike;
  readonly #onError?: (error: unknown) => void;
  #app?: SlackAppLike;
  #context?: ChannelStartContext;
  #running = false;
  #connectedAt?: string;
  #lastEventAt?: string;
  #botUserId?: string;

  constructor(options: SlackAdapterOptions) {
    if (!options.token.trim() || !options.appToken.trim()) throw new Error("Slack channel requires bot and app tokens");
    this.#token = options.token;
    this.#appToken = options.appToken;
    this.accountId = options.accountId?.trim() || "default";
    this.id = `slack:${this.accountId}`;
    this.#requireMention = options.requireMention !== false;
    this.#nativeCommandName = normalizeSlackCommandName(options.nativeCommandName ?? "/odinn");
    this.#appFactory = options.appFactory ?? ((settings) => new App(settings as any));
    this.#onError = options.onError;
  }

  async start(context: ChannelStartContext): Promise<void> {
    if (this.#running) throw new Error("Slack channel is already running");
    this.#running = true;
    this.#context = context;
    context.updateStatus({ state: "starting", error: undefined });
    const app = this.#appFactory({
      token: this.#token,
      appToken: this.#appToken,
      socketMode: true,
      processBeforeResponse: true
    });
    this.#app = app;
    app.error(async (error) => {
      context.updateStatus({ state: "degraded", error: slackError(error) });
      this.#onError?.(error);
    });
    const receive = async (event: any) => {
      this.#lastEventAt = new Date().toISOString();
      context.updateStatus({ lastEventAt: this.#lastEventAt });
      const normalized = normalizeSlackMessage(event, {
        accountId: this.accountId,
        botUserId: this.#botUserId,
        requireMention: this.#requireMention
      });
      if (normalized) await context.deliver(normalized);
    };
    app.message(/[\s\S]*/u, async ({ message }: any) => receive(message));
    app.action(/.*/u, async ({ ack, body, action }: any) => {
      await ack();
      const normalized = normalizeSlackInteraction(body, action, this.accountId);
      if (normalized) await context.deliver(normalized);
    });
    app.command(this.#nativeCommandName, async ({ ack, command }: any) => {
      await ack();
      const normalized = normalizeSlackSlashCommand(command, this.accountId);
      if (normalized) await context.deliver(normalized);
    });
    context.signal.addEventListener("abort", () => void this.stop(), { once: true });
    try {
      await app.start();
      const auth = await app.client.auth.test();
      this.#botUserId = string(auth.user_id);
      this.#connectedAt = new Date().toISOString();
      context.updateStatus({
        state: "connected",
        connectedAt: this.#connectedAt,
        error: undefined,
        details: { botUserId: this.#botUserId, teamId: string(auth.team_id) }
      });
    } catch (error) {
      this.#running = false;
      context.updateStatus({ state: "failed", error: slackError(error) });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.#running && !this.#app) return;
    this.#running = false;
    const app = this.#app;
    this.#app = undefined;
    this.#context?.updateStatus({ state: "stopped" });
    this.#context = undefined;
    await app?.stop();
  }

  async send(message: OutboundChannelMessage): Promise<ChannelDeliveryReceipt> {
    if (message.address.channel !== "slack") throw new Error("Slack adapter cannot send to another channel");
    const client = this.#requiredApp().client;
    const chunks = message.text?.trim() ? splitChannelText(message.text, 40_000) : [];
    const messageIds: string[] = [];
    const channel = message.address.conversationId;
    try {
      for (const attachment of message.attachments ?? []) {
        const uploaded = await client.files.uploadV2({
          channel_id: channel,
          ...attachment.path ? { file: attachment.path } : { file: attachment.url },
          filename: attachment.filename,
          initial_comment: attachment.description,
          thread_ts: message.address.threadId
        });
        const id = uploaded?.files?.[0]?.shares
          ? String(uploaded.files[0].id)
          : string(uploaded?.files?.[0]?.id);
        if (id) messageIds.push(id);
      }
      let first = true;
      for (const text of chunks) {
        const sent = await client.chat.postMessage({
          channel,
          text,
          thread_ts: message.address.threadId,
          ...(first && message.replyToId ? { thread_ts: message.address.threadId ?? message.replyToId } : {}),
          ...(first && message.components?.length ? { blocks: slackBlocks(text, message.components) } : {}),
          unfurl_links: message.suppressEmbeds === false,
          unfurl_media: message.suppressEmbeds === false
        });
        if (sent.ts) messageIds.push(String(sent.ts));
        first = false;
      }
    } catch (error) {
      const receipt: ChannelDeliveryReceipt = {
        status: messageIds.length ? "partial" : "failed",
        messageIds,
        conversationId: channel,
        sentChunks: messageIds.length,
        totalChunks: chunks.length + (message.attachments?.length ?? 0)
      };
      if (messageIds.length) throw new ChannelDeliveryError("Slack delivery partially completed", receipt, { cause: error });
      throw new ChannelRetryableError(`Slack delivery failed: ${slackError(error)}`, { cause: error });
    }
    return {
      status: "sent",
      messageIds,
      conversationId: channel,
      sentChunks: messageIds.length,
      totalChunks: chunks.length + (message.attachments?.length ?? 0)
    };
  }

  async acknowledge(message: InboundChannelMessage, acknowledgement: ChannelAcknowledgement): Promise<void> {
    const emoji = acknowledgement === "processing" ? "eyes" : acknowledgement === "succeeded" ? "white_check_mark" : "x";
    const client = this.#requiredApp().client;
    if (acknowledgement !== "processing") {
      await client.reactions.remove({
        channel: message.address.conversationId,
        timestamp: message.id,
        name: "eyes"
      }).catch(() => undefined);
    }
    await client.reactions.add({ channel: message.address.conversationId, timestamp: message.id, name: emoji });
  }

  async edit(address: InboundChannelMessage["address"], messageId: string, message: OutboundChannelMessage): Promise<void> {
    await this.#requiredApp().client.chat.update({
      channel: address.conversationId,
      ts: messageId,
      text: message.text ?? "",
      ...(message.components?.length ? { blocks: slackBlocks(message.text ?? "", message.components) } : {})
    });
  }

  async delete(address: InboundChannelMessage["address"], messageId: string): Promise<void> {
    await this.#requiredApp().client.chat.delete({ channel: address.conversationId, ts: messageId });
  }

  async probe() {
    const startedAt = Date.now();
    try {
      const auth = await this.#requiredApp().client.auth.test();
      return {
        channel: this.channel,
        accountId: this.accountId,
        state: "connected" as const,
        connectedAt: this.#connectedAt,
        lastEventAt: this.#lastEventAt,
        latencyMs: Date.now() - startedAt,
        details: { botUserId: string(auth.user_id), teamId: string(auth.team_id) }
      };
    } catch (error) {
      return {
        channel: this.channel,
        accountId: this.accountId,
        state: this.#running ? "degraded" as const : "stopped" as const,
        latencyMs: Date.now() - startedAt,
        error: slackError(error)
      };
    }
  }

  #requiredApp(): SlackAppLike {
    if (!this.#app || !this.#running) throw new Error("Slack channel is not running");
    return this.#app;
  }
}

export function normalizeSlackMessage(value: unknown, {
  accountId = "default",
  botUserId,
  requireMention = true
}: {
  accountId?: string;
  botUserId?: string;
  requireMention?: boolean;
} = {}): InboundChannelMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, any>;
  const id = string(event.ts);
  const channel = string(event.channel);
  const sender = string(event.user);
  const text = string(event.text) ?? "";
  if (!id || !channel || !sender || sender === botUserId || event.bot_id || event.subtype) return undefined;
  const direct = event.channel_type === "im";
  const mentioned = botUserId ? text.includes(`<@${botUserId}>`) : false;
  if (!direct && requireMention && !mentioned) return undefined;
  const threadId = string(event.thread_ts);
  return {
    id,
    address: {
      channel: "slack",
      accountId,
      conversationId: channel,
      conversationKind: threadId ? "thread" : direct ? "direct" : "channel",
      ...(threadId ? { threadId } : {})
    },
    sender: { id: sender },
    text: botUserId ? text.replaceAll(`<@${botUserId}>`, "").trim() : text.trim(),
    receivedAt: slackTimestamp(id),
    ...(threadId ? { replyToId: threadId } : {}),
    metadata: {
      ...(string(event.team) ? { teamId: string(event.team) } : {}),
      ...(mentioned ? { mentionedBot: true } : {})
    }
  };
}

export function normalizeSlackInteraction(body: any, action: any, accountId = "default"): InboundChannelMessage | undefined {
  const id = string(body?.trigger_id) ?? string(body?.container?.message_ts);
  const channel = string(body?.channel?.id);
  const sender = string(body?.user?.id);
  const customId = string(action?.action_id);
  if (!id || !channel || !sender || !customId) return undefined;
  return {
    id,
    address: {
      channel: "slack",
      accountId,
      conversationId: channel,
      conversationKind: body?.container?.thread_ts ? "thread" : "channel",
      ...(body?.container?.thread_ts ? { threadId: String(body.container.thread_ts) } : {})
    },
    sender: { id: sender, displayName: string(body?.user?.name) },
    text: `Slack component selected: ${customId}`,
    receivedAt: new Date().toISOString(),
    metadata: { interactionType: "action", customId }
  };
}

export function normalizeSlackSlashCommand(value: any, accountId = "default"): InboundChannelMessage | undefined {
  const id = string(value?.trigger_id);
  const channel = string(value?.channel_id);
  const sender = string(value?.user_id);
  const text = string(value?.text);
  if (!id || !channel || !sender || !text) return undefined;
  return {
    id,
    address: { channel: "slack", accountId, conversationId: channel, conversationKind: "channel" },
    sender: { id: sender, displayName: string(value?.user_name) },
    text,
    receivedAt: new Date().toISOString(),
    metadata: { interactionType: "command", nativeCommand: string(value?.command) }
  };
}

function slackBlocks(text: string, components: NonNullable<OutboundChannelMessage["components"]>) {
  return [
    ...(text ? [{ type: "section", text: { type: "mrkdwn", text } }] : []),
    {
      type: "actions",
      elements: components.slice(0, 5).map((component) => ({
        type: "button",
        action_id: component.customId,
        text: { type: "plain_text", text: component.label },
        style: component.style === "danger" ? "danger" : component.style === "primary" ? "primary" : undefined
      }))
    }
  ];
}

function normalizeSlackCommandName(value: string): string {
  const command = value.trim().toLowerCase();
  if (!/^\/[a-z0-9_-]{1,31}$/u.test(command)) throw new Error("Slack native command name is invalid");
  return command;
}

function slackTimestamp(value: string): string {
  const seconds = Number(value.split(".")[0]);
  return Number.isFinite(seconds) ? new Date(seconds * 1_000).toISOString() : new Date().toISOString();
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function slackError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SlackChannelAccountConfig extends ChannelAccountConfig {
  appTokenEnv: string;
  requireMention: boolean;
  nativeCommandName: string;
}

export const slackChannelPlugin: ChannelPlugin<SlackChannelAccountConfig> = {
  id: "slack",
  displayName: "Slack",
  capabilities: {
    chatTypes: ["direct", "group", "channel", "thread"],
    reactions: true,
    replies: true,
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
    const appTokenEnv = string(record.appTokenEnv) ?? "";
    return {
      enabled: record.enabled === true,
      tokenEnv: string(record.tokenEnv) ?? "",
      credentialEnvs: { appToken: appTokenEnv },
      allowlist: stringArray(record.allowlist),
      ...(string(record.defaultModel) ? { defaultModel: string(record.defaultModel) } : {}),
      historyLimit: integer(record.historyLimit, 40, 1, 200),
      appTokenEnv,
      requireMention: record.requireMention !== false,
      nativeCommandName: normalizeSlackCommandName(string(record.nativeCommandName) ?? "/odinn")
    };
  },
  validateAccountConfig(accountId, config) {
    const errors = [];
    if (!config.tokenEnv) errors.push(`Slack account ${accountId} requires tokenEnv`);
    if (!config.appTokenEnv) errors.push(`Slack account ${accountId} requires appTokenEnv`);
    if (!config.allowlist.length) errors.push(`Slack account ${accountId} denies all inbound messages`);
    return errors;
  },
  createAdapter({ accountId, config, credential, credentials, onError }) {
    return new SlackChannelAdapter({
      token: credential,
      appToken: credentials.appToken ?? "",
      accountId,
      requireMention: config.requireMention,
      nativeCommandName: config.nativeCommandName,
      onError
    });
  }
};

function objectRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))]
    : [];
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, Number(value))) : fallback;
}
