import type { ApprovalStore } from "./approvals.ts";

const DISCORD_API = "https://discord.com/api/v10";

type DiscordToolOptions = {
  config?: Record<string, any>;
  approvalStore: ApprovalStore;
  fetch?: typeof globalThis.fetch;
};

export const DISCORD_AGENT_TOOL_SCHEMAS = [
  { type: "function", function: { name: "discord.listChannels", description: "List channels visible to a configured Discord bot in a guild.", parameters: { type: "object", properties: { guildId: { type: "string" }, accountId: { type: "string" } }, required: ["guildId"] } } },
  { type: "function", function: { name: "discord.readMessages", description: "Read recent messages from a Discord channel visible to a configured bot.", parameters: { type: "object", properties: { channelId: { type: "string" }, limit: { type: "integer" }, before: { type: "string" }, after: { type: "string" }, accountId: { type: "string" } }, required: ["channelId"] } } },
  { type: "function", function: { name: "discord.sendMessage", description: "Send a Discord message after explicit user approval.", parameters: { type: "object", properties: { channelId: { type: "string" }, content: { type: "string" }, replyToId: { type: "string" }, accountId: { type: "string" } }, required: ["channelId", "content"] } } },
  { type: "function", function: { name: "discord.addReaction", description: "Add a reaction to a Discord message after explicit user approval.", parameters: { type: "object", properties: { channelId: { type: "string" }, messageId: { type: "string" }, emoji: { type: "string" }, accountId: { type: "string" } }, required: ["channelId", "messageId", "emoji"] } } },
  { type: "function", function: { name: "discord.createThread", description: "Create a Discord thread after explicit user approval.", parameters: { type: "object", properties: { channelId: { type: "string" }, name: { type: "string" }, messageId: { type: "string" }, autoArchiveDuration: { type: "integer", enum: [60, 1440, 4320, 10080] }, accountId: { type: "string" } }, required: ["channelId", "name"] } } }
] as const;

export function createDiscordAgentTools({ config = {}, approvalStore, fetch = globalThis.fetch }: DiscordToolOptions) {
  const plugin = resolveDiscordPluginConfig(config);
  if (!plugin.enabled) return new Map();
  const execute = async (tool: string, input: Record<string, any>, context: Record<string, any> = {}) => {
    const account = resolveDiscordAccount(plugin.accounts, input.accountId);
    if (tool === "discord.listChannels") {
      return discordRequest(fetch, account.token, "GET", `/guilds/${snowflake(input.guildId, "guildId")}/channels`);
    }
    if (tool === "discord.readMessages") {
      const query = new URLSearchParams({ limit: String(Math.min(Math.max(Number(input.limit) || 50, 1), 100)) });
      if (input.before) query.set("before", snowflake(input.before, "before"));
      if (input.after) query.set("after", snowflake(input.after, "after"));
      return discordRequest(fetch, account.token, "GET", `/channels/${snowflake(input.channelId, "channelId")}/messages?${query}`);
    }
    if (context.request?.actor !== "user-approved") {
      const summary = discordMutationSummary(tool, input);
      const approvalId = approvalStore.create({
        type: "approval.required",
        tool,
        summary,
        input: { ...input, confirmed: true }
      });
      return { type: "approval.required", approvalId, tool, summary, expiresInSeconds: 300 };
    }
    if (tool === "discord.sendMessage") {
      const content = requiredText(input.content, "content", 2_000);
      return discordRequest(fetch, account.token, "POST", `/channels/${snowflake(input.channelId, "channelId")}/messages`, {
        content,
        allowed_mentions: { parse: [], replied_user: false },
        ...(input.replyToId ? { message_reference: { message_id: snowflake(input.replyToId, "replyToId"), fail_if_not_exists: false } } : {})
      });
    }
    if (tool === "discord.addReaction") {
      const emoji = encodeURIComponent(requiredText(input.emoji, "emoji", 128));
      return discordRequest(fetch, account.token, "PUT", `/channels/${snowflake(input.channelId, "channelId")}/messages/${snowflake(input.messageId, "messageId")}/reactions/${emoji}/@me`);
    }
    if (tool === "discord.createThread") {
      const channelId = snowflake(input.channelId, "channelId");
      const messageId = input.messageId ? snowflake(input.messageId, "messageId") : "";
      const path = messageId ? `/channels/${channelId}/messages/${messageId}/threads` : `/channels/${channelId}/threads`;
      return discordRequest(fetch, account.token, "POST", path, {
        name: requiredText(input.name, "name", 100),
        auto_archive_duration: [60, 1440, 4320, 10080].includes(Number(input.autoArchiveDuration)) ? Number(input.autoArchiveDuration) : 1440,
        ...messageId ? {} : { type: 11 }
      });
    }
    throw new Error(`unsupported Discord tool: ${tool}`);
  };
  return new Map(DISCORD_AGENT_TOOL_SCHEMAS.filter((schema) => plugin.tools[schema.function.name] !== false).map((schema) => {
    const name = schema.function.name;
    return [name, {
      capability: name === "discord.listChannels" || name === "discord.readMessages" ? "discord.read" : "discord.write",
      description: schema.function.description,
      execute: (input: Record<string, any>, context: Record<string, any>) => execute(name, input, context)
    }];
  }));
}

function resolveDiscordPluginConfig(config: Record<string, any>) {
  const entry = config.plugins?.entries?.discord;
  if (entry && typeof entry === "object") {
    const pluginConfig = entry.config && typeof entry.config === "object" ? entry.config : {};
    return {
      enabled: entry.enabled === true,
      accounts: pluginConfig.accounts && typeof pluginConfig.accounts === "object" ? pluginConfig.accounts : {},
      tools: pluginConfig.tools && typeof pluginConfig.tools === "object" ? pluginConfig.tools : {}
    };
  }
  const legacyAccounts = Object.fromEntries(Object.entries(config.channels ?? {})
    .filter(([, value]: any) => value?.type === "discord"));
  return { enabled: Object.keys(legacyAccounts).length > 0, accounts: legacyAccounts, tools: {} };
}

function resolveDiscordAccount(accounts: Record<string, any>, requestedAccountId: unknown) {
  const configured = Object.entries(accounts)
    .filter(([, value]: any) => value?.enabled === true)
    .map(([accountId, value]: any) => ({ accountId, tokenEnv: String(value.tokenEnv ?? "") }));
  const requested = String(requestedAccountId ?? "").trim();
  const account = requested
    ? configured.find((entry) => entry.accountId === requested)
    : configured.length === 1 ? configured[0] : undefined;
  if (!account) {
    if (!configured.length) throw new Error("no enabled Discord account is configured");
    throw new Error(requested ? `Discord account is not configured: ${requested}` : "multiple Discord accounts are configured; accountId is required");
  }
  const token = account.tokenEnv ? process.env[account.tokenEnv] : "";
  if (!token) throw new Error(`Discord credential is unavailable in ${account.tokenEnv || "the configured token environment variable"}`);
  return { accountId: account.accountId, token };
}

async function discordRequest(fetch: typeof globalThis.fetch, token: string, method: string, path: string, body?: Record<string, unknown>) {
  const response = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      authorization: `Bot ${token}`,
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (response.status === 204) return { ok: true };
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = value && typeof value === "object" && typeof (value as any).message === "string"
      ? (value as any).message
      : `request failed with ${response.status}`;
    throw new Error(`Discord API: ${message}`);
  }
  return value;
}

function snowflake(value: unknown, field: string) {
  const clean = String(value ?? "").trim();
  if (!/^\d{1,20}$/u.test(clean)) throw new Error(`Discord ${field} must be a numeric identifier`);
  return clean;
}

function requiredText(value: unknown, field: string, maximum: number) {
  const clean = String(value ?? "").trim();
  if (!clean) throw new Error(`Discord ${field} is required`);
  if (Array.from(clean).length > maximum) throw new Error(`Discord ${field} exceeds ${maximum} characters`);
  return clean;
}

function discordMutationSummary(tool: string, input: Record<string, any>) {
  if (tool === "discord.sendMessage") return `Send a message to Discord channel ${String(input.channelId ?? "")}`;
  if (tool === "discord.addReaction") return `Add reaction ${String(input.emoji ?? "")} to Discord message ${String(input.messageId ?? "")}`;
  return `Create Discord thread ${String(input.name ?? "")} in channel ${String(input.channelId ?? "")}`;
}
