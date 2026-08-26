import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  TurnContext
} from "botbuilder";
import {
  ChannelDeliveryError,
  ChannelRetryableError,
  type ChannelAdapter,
  type ChannelAccountConfig,
  type ChannelCapabilities,
  type ChannelDeliveryReceipt,
  type ChannelPlugin,
  type ChannelStartContext,
  type ChannelWebhookRequest,
  type InboundChannelMessage,
  type OutboundChannelMessage,
  splitChannelText
} from "@odinn/channels";

export interface TeamsAdapterOptions {
  appId: string;
  appPassword: string;
  tenantId?: string;
  accountId?: string;
  requireMention?: boolean;
  botFrameworkAuthentication?: ConstructorParameters<typeof CloudAdapter>[0];
  onError?: (error: unknown) => void;
}

export class TeamsChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly channel = "teams";
  readonly accountId: string;
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["direct", "group", "channel", "thread"],
    replies: true,
    typing: true,
    threads: true,
    media: true,
    edits: true,
    deletes: true,
    components: true
  };
  readonly #appId: string;
  readonly #adapter: CloudAdapter;
  readonly #requireMention: boolean;
  readonly #onError?: (error: unknown) => void;
  readonly #references = new Map<string, any>();
  #context?: ChannelStartContext;
  #running = false;
  #connectedAt?: string;
  #lastEventAt?: string;

  constructor(options: TeamsAdapterOptions) {
    if (!options.appId.trim() || !options.appPassword.trim()) {
      throw new Error("Microsoft Teams channel requires an app ID and app password");
    }
    this.#appId = options.appId;
    this.accountId = options.accountId?.trim() || "default";
    this.id = `teams:${this.accountId}`;
    this.#onError = options.onError;
    this.#requireMention = options.requireMention !== false;
    const authentication = options.botFrameworkAuthentication ?? new ConfigurationBotFrameworkAuthentication({
        MicrosoftAppType: options.tenantId ? "SingleTenant" : "MultiTenant",
        MicrosoftAppId: options.appId,
        MicrosoftAppPassword: options.appPassword,
        MicrosoftAppTenantId: options.tenantId ?? ""
      } as any);
    this.#adapter = new CloudAdapter(authentication);
    this.#adapter.onTurnError = async (_turnContext, error) => {
      this.#onError?.(error);
      this.#context?.updateStatus({ state: "degraded", error: teamsError(error) });
    };
  }

  async start(context: ChannelStartContext): Promise<void> {
    if (this.#running) throw new Error("Microsoft Teams channel is already running");
    this.#running = true;
    this.#context = context;
    this.#connectedAt = new Date().toISOString();
    context.updateStatus({
      state: "connected",
      connectedAt: this.#connectedAt,
      error: undefined,
      details: { mode: "authenticated-webhook", appIdSuffix: this.#appId.slice(-6) }
    });
    context.signal.addEventListener("abort", () => void this.stop(), { once: true });
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#context?.updateStatus({ state: "stopped" });
    this.#context = undefined;
    this.#references.clear();
  }

  async handleWebhook(request: ChannelWebhookRequest): Promise<void> {
    if (!this.#running || !this.#context) throw new Error("Microsoft Teams channel is not running");
    const rawRequest = request.rawRequest as any;
    const rawResponse = request.rawResponse as any;
    if (!rawRequest || !rawResponse) throw new Error("Microsoft Teams webhook requires an HTTP request and response");
    let body: unknown = {};
    if ((request.method ?? rawRequest.method) === "POST") {
      if (!Buffer.isBuffer(request.body)) throw new Error("Microsoft Teams webhook requires a bounded request body");
      try {
        body = JSON.parse(request.body.toString("utf8"));
      } catch {
        rawResponse.writeHead(400, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff"
        });
        rawResponse.end("invalid Microsoft Teams webhook JSON");
        return;
      }
    }
    await this.#adapter.process({
      method: request.method ?? rawRequest.method,
      headers: rawRequest.headers,
      body
    } as any, botFrameworkResponse(rawResponse), async (turnContext) => {
      const normalized = normalizeTeamsActivity(turnContext.activity, this.accountId, {
        requireMention: this.#requireMention
      });
      if (!normalized) return;
      this.#lastEventAt = new Date().toISOString();
      this.#references.set(normalized.address.conversationId, TurnContext.getConversationReference(turnContext.activity));
      this.#context?.updateStatus({ lastEventAt: this.#lastEventAt });
      await this.#context?.deliver(normalized);
    });
  }

  async send(message: OutboundChannelMessage): Promise<ChannelDeliveryReceipt> {
    if (message.address.channel !== "teams") throw new Error("Teams adapter cannot send to another channel");
    const reference = this.#references.get(message.address.conversationId);
    if (!reference) throw new Error("Teams conversation reference is unavailable until the bot receives a message");
    const chunks = message.text?.trim() ? splitChannelText(message.text, 28_000) : [];
    const messageIds: string[] = [];
    try {
      await this.#adapter.continueConversationAsync(this.#appId, reference, async (turnContext) => {
        let first = true;
        for (const text of chunks) {
          const activity: any = {
            type: "message",
            text,
            ...(first && message.replyToId ? { replyToId: message.replyToId } : {}),
            ...(first && message.attachments?.length ? {
              attachments: message.attachments.filter((item) => item.url).map((item) => ({
                contentType: item.contentType ?? "application/octet-stream",
                contentUrl: item.url,
                name: item.filename
              }))
            } : {}),
            ...(first && message.components?.length ? {
              suggestedActions: {
                actions: message.components.map((component) => ({
                  type: "imBack",
                  title: component.label,
                  value: component.customId
                }))
              }
            } : {})
          };
          const sent = await turnContext.sendActivity(activity);
          if (sent?.id) messageIds.push(String(sent.id));
          first = false;
        }
      });
    } catch (error) {
      const receipt: ChannelDeliveryReceipt = {
        status: messageIds.length ? "partial" : "failed",
        messageIds,
        conversationId: message.address.conversationId,
        sentChunks: messageIds.length,
        totalChunks: chunks.length
      };
      if (messageIds.length) throw new ChannelDeliveryError("Teams delivery partially completed", receipt, { cause: error });
      throw new ChannelRetryableError(`Teams delivery failed: ${teamsError(error)}`, { cause: error });
    }
    return {
      status: "sent",
      messageIds,
      conversationId: message.address.conversationId,
      sentChunks: messageIds.length,
      totalChunks: chunks.length
    };
  }

  async sendTyping(address: InboundChannelMessage["address"]): Promise<void> {
    await this.#continue(address, (turnContext) => turnContext.sendActivity({ type: "typing" }));
  }

  async edit(address: InboundChannelMessage["address"], messageId: string, message: OutboundChannelMessage): Promise<void> {
    await this.#continue(address, (turnContext) => turnContext.updateActivity({
      id: messageId,
      type: "message",
      text: message.text ?? ""
    }));
  }

  async delete(address: InboundChannelMessage["address"], messageId: string): Promise<void> {
    await this.#continue(address, (turnContext) => turnContext.deleteActivity(messageId));
  }

  async probe() {
    return {
      channel: this.channel,
      accountId: this.accountId,
      state: this.#running ? "connected" as const : "stopped" as const,
      connectedAt: this.#connectedAt,
      lastEventAt: this.#lastEventAt,
      details: { mode: "authenticated-webhook", knownConversations: this.#references.size }
    };
  }

  async #continue(address: InboundChannelMessage["address"], operation: (turnContext: any) => Promise<any>): Promise<void> {
    const reference = this.#references.get(address.conversationId);
    if (!reference) throw new Error("Teams conversation reference is unavailable");
    await this.#adapter.continueConversationAsync(this.#appId, reference, operation);
  }
}

export function normalizeTeamsActivity(value: unknown, accountId = "default", {
  requireMention = false
}: {
  requireMention?: boolean;
} = {}): InboundChannelMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const activity = value as Record<string, any>;
  if (activity.type !== "message") return undefined;
  const id = text(activity.id);
  const conversationId = text(activity.conversation?.id);
  const senderId = text(activity.from?.aadObjectId ?? activity.from?.id);
  let content = text(activity.text) ?? text(activity.value?.text) ?? "";
  const attachments = Array.isArray(activity.attachments)
    ? activity.attachments.map((attachment: any) => ({
        filename: text(attachment.name),
        contentType: text(attachment.contentType),
        url: text(attachment.contentUrl)
      })).filter((attachment: any) => attachment.url)
    : [];
  if (!id || !conversationId || !senderId || (!content && !attachments.length)) return undefined;
  const channelData = activity.channelData ?? {};
  const threadId = text(activity.replyToId);
  const teamId = text(channelData.team?.id);
  const channelId = text(channelData.channel?.id);
  const recipientId = text(activity.recipient?.id);
  const mention = array(activity.entities).find((entity: any) => (
    entity?.type === "mention" && (!recipientId || text(entity?.mentioned?.id) === recipientId)
  ));
  if (teamId && requireMention && !mention && !threadId) return undefined;
  if (text(mention?.text)) content = content.replace(String(mention.text), "").trim();
  return {
    id,
    address: {
      channel: "teams",
      accountId,
      conversationId,
      conversationKind: threadId ? "thread" : teamId ? "channel" : "direct",
      ...(threadId ? { threadId } : {})
    },
    sender: { id: senderId, displayName: text(activity.from?.name) },
    text: content || "[Teams attachment]",
    receivedAt: validDate(activity.timestamp),
    ...(threadId ? { replyToId: threadId } : {}),
    ...(attachments.length ? { attachments } : {}),
    metadata: {
      ...(teamId ? { teamId } : {}),
      ...(channelId ? { channelId } : {}),
      tenantId: text(channelData.tenant?.id),
      ...(mention ? { mentionedBot: true } : {})
    }
  };
}

export interface TeamsChannelAccountConfig extends ChannelAccountConfig {
  appIdEnv: string;
  tenantIdEnv: string;
  requireMention: boolean;
}

export const teamsChannelPlugin: ChannelPlugin<TeamsChannelAccountConfig> = {
  id: "teams",
  displayName: "Microsoft Teams",
  capabilities: {
    chatTypes: ["direct", "group", "channel", "thread"],
    replies: true,
    typing: true,
    threads: true,
    media: true,
    edits: true,
    deletes: true,
    components: true
  },
  normalizeAccountConfig(_accountId, value) {
    const record = objectRecord(value);
    const appIdEnv = text(record.appIdEnv) ?? "";
    const tenantIdEnv = text(record.tenantIdEnv) ?? "";
    return {
      enabled: record.enabled === true,
      tokenEnv: text(record.tokenEnv) ?? "",
      credentialEnvs: { appId: appIdEnv, ...(tenantIdEnv ? { tenantId: tenantIdEnv } : {}) },
      allowlist: stringArray(record.allowlist),
      ...(text(record.defaultModel) ? { defaultModel: text(record.defaultModel) } : {}),
      historyLimit: integer(record.historyLimit, 40),
      appIdEnv,
      tenantIdEnv,
      requireMention: record.requireMention !== false
    };
  },
  validateAccountConfig(accountId, config) {
    const errors = [];
    if (!config.tokenEnv) errors.push(`Teams account ${accountId} requires tokenEnv for the app password`);
    if (!config.appIdEnv) errors.push(`Teams account ${accountId} requires appIdEnv`);
    if (!config.allowlist.length) errors.push(`Teams account ${accountId} denies all inbound messages`);
    return errors;
  },
  createAdapter({ accountId, config, credential, credentials, onError }) {
    return new TeamsChannelAdapter({
      accountId,
      appPassword: credential,
      appId: credentials.appId ?? "",
      tenantId: credentials.tenantId,
      requireMention: config.requireMention,
      onError
    });
  },
  webhookPath(accountId) {
    return `/channels/webhook/teams/${encodeURIComponent(accountId)}`;
  },
  webhookRequestMode: "buffer"
};

function botFrameworkResponse(response: any) {
  return {
    socket: response.socket,
    status(code: number) {
      response.statusCode = code;
      return this;
    },
    header(name: string, value: unknown) {
      response.setHeader(name, String(value));
      return this;
    },
    send(body: unknown) {
      if (body === undefined || body === null) return this;
      if (Buffer.isBuffer(body) || typeof body === "string") {
        response.write(body);
      } else {
        if (!response.hasHeader("content-type")) response.setHeader("content-type", "application/json; charset=utf-8");
        response.write(JSON.stringify(body));
      }
      return this;
    },
    end() {
      if (!response.writableEnded) response.end();
      return this;
    }
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))]
    : [];
}

function array(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function integer(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) ? Math.min(200, Math.max(1, Number(value))) : fallback;
}

function validDate(value: unknown): string {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
}

function teamsError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
