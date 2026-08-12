import type { ChannelAgentToolDefinition, ChannelAgentToolDefinitions } from "@odinn/channels";
import { DiscordRestClient } from "./rest.ts";

type DiscordToolOptions = {
  config?: Record<string, any>;
  fetch?: typeof globalThis.fetch;
};

export const DISCORD_AGENT_TOOL_SCHEMAS = [
  { type: "function", function: { name: "discord.listChannels", description: "List channels visible to a configured Discord bot in a guild.", parameters: { type: "object", properties: { guildId: { type: "string" }, accountId: { type: "string" } }, required: ["guildId"] } } },
  { type: "function", function: { name: "discord.readMessages", description: "Read recent messages from a Discord channel visible to a configured bot.", parameters: { type: "object", properties: { channelId: { type: "string" }, limit: { type: "integer" }, before: { type: "string" }, after: { type: "string" }, accountId: { type: "string" } }, required: ["channelId"] } } },
  { type: "function", function: { name: "discord.sendMessage", description: "Send a Discord message.", parameters: { type: "object", properties: { channelId: { type: "string" }, content: { type: "string" }, replyToId: { type: "string" }, accountId: { type: "string" } }, required: ["channelId", "content"] } } },
  { type: "function", function: { name: "discord.editMessage", description: "Edit a Discord message sent by the configured bot.", parameters: { type: "object", properties: { channelId: { type: "string" }, messageId: { type: "string" }, content: { type: "string" }, accountId: { type: "string" } }, required: ["channelId", "messageId", "content"] } } },
  { type: "function", function: { name: "discord.deleteMessage", description: "Delete a Discord message.", parameters: { type: "object", properties: { channelId: { type: "string" }, messageId: { type: "string" }, accountId: { type: "string" } }, required: ["channelId", "messageId"] } } },
  { type: "function", function: { name: "discord.addReaction", description: "Add a reaction to a Discord message.", parameters: { type: "object", properties: { channelId: { type: "string" }, messageId: { type: "string" }, emoji: { type: "string" }, accountId: { type: "string" } }, required: ["channelId", "messageId", "emoji"] } } },
  { type: "function", function: { name: "discord.removeReaction", description: "Remove the configured bot's reaction from a Discord message.", parameters: { type: "object", properties: { channelId: { type: "string" }, messageId: { type: "string" }, emoji: { type: "string" }, accountId: { type: "string" } }, required: ["channelId", "messageId", "emoji"] } } },
  { type: "function", function: { name: "discord.listReactions", description: "List users who added a reaction to a Discord message.", parameters: { type: "object", properties: { channelId: { type: "string" }, messageId: { type: "string" }, emoji: { type: "string" }, limit: { type: "integer" }, accountId: { type: "string" } }, required: ["channelId", "messageId", "emoji"] } } },
  { type: "function", function: { name: "discord.pinMessage", description: "Pin a Discord message.", parameters: { type: "object", properties: { channelId: { type: "string" }, messageId: { type: "string" }, accountId: { type: "string" } }, required: ["channelId", "messageId"] } } },
  { type: "function", function: { name: "discord.unpinMessage", description: "Unpin a Discord message.", parameters: { type: "object", properties: { channelId: { type: "string" }, messageId: { type: "string" }, accountId: { type: "string" } }, required: ["channelId", "messageId"] } } },
  { type: "function", function: { name: "discord.listPins", description: "List pinned messages in a Discord channel.", parameters: { type: "object", properties: { channelId: { type: "string" }, accountId: { type: "string" } }, required: ["channelId"] } } },
  { type: "function", function: { name: "discord.sendPoll", description: "Create a native Discord poll.", parameters: { type: "object", properties: { channelId: { type: "string" }, question: { type: "string" }, answers: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 10 }, durationHours: { type: "integer" }, allowMultiselect: { type: "boolean" }, accountId: { type: "string" } }, required: ["channelId", "question", "answers"] } } },
  { type: "function", function: { name: "discord.createThread", description: "Create a Discord thread.", parameters: { type: "object", properties: { channelId: { type: "string" }, name: { type: "string" }, messageId: { type: "string" }, autoArchiveDuration: { type: "integer", enum: [60, 1440, 4320, 10080] }, accountId: { type: "string" } }, required: ["channelId", "name"] } } },
  { type: "function", function: { name: "discord.listThreads", description: "List active Discord threads in a guild.", parameters: { type: "object", properties: { guildId: { type: "string" }, accountId: { type: "string" } }, required: ["guildId"] } } },
  { type: "function", function: { name: "discord.replyThread", description: "Reply inside a Discord thread.", parameters: { type: "object", properties: { threadId: { type: "string" }, content: { type: "string" }, replyToId: { type: "string" }, accountId: { type: "string" } }, required: ["threadId", "content"] } } },
  { type: "function", function: { name: "discord.searchMessages", description: "Search Discord messages in a guild.", parameters: { type: "object", properties: { guildId: { type: "string" }, query: { type: "string" }, channelId: { type: "string" }, limit: { type: "integer" }, accountId: { type: "string" } }, required: ["guildId", "query"] } } }
] as const;

const DISCORD_MUTATION_TOOLS = new Set([
  "discord.sendMessage",
  "discord.editMessage",
  "discord.deleteMessage",
  "discord.addReaction",
  "discord.removeReaction",
  "discord.pinMessage",
  "discord.unpinMessage",
  "discord.sendPoll",
  "discord.createThread",
  "discord.replyThread"
]);

export function createDiscordAgentToolDefinitions({
  config = {},
  fetch = globalThis.fetch
}: DiscordToolOptions = {}): ChannelAgentToolDefinitions {
  const plugin = resolveDiscordPluginConfig(config);
  if (!plugin.enabled) return new Map();
  const clients = new Map<string, DiscordRestClient>();
  const clientFor = (input: Record<string, unknown>) => {
    const account = resolveDiscordAccount(plugin.accounts, input.accountId);
    const existing = clients.get(account.accountId);
    const client = existing ?? new DiscordRestClient({ token: account.token, fetch });
    clients.set(account.accountId, client);
    return client;
  };
  const invoke = async (tool: string, input: Record<string, unknown>) => {
    const client = clientFor(input);
    if (tool === "discord.listChannels") {
      return client.listChannels(snowflake(input.guildId, "guildId"));
    }
    if (tool === "discord.readMessages") {
      return client.readMessages(snowflake(input.channelId, "channelId"), {
        limit: Number(input.limit) || 50,
        ...(input.before ? { before: snowflake(input.before, "before") } : {}),
        ...(input.after ? { after: snowflake(input.after, "after") } : {})
      });
    }
    if (tool === "discord.sendMessage") {
      return client.sendMessage(
        snowflake(input.channelId, "channelId"),
        requiredText(input.content, "content", 2_000),
        input.replyToId ? snowflake(input.replyToId, "replyToId") : undefined
      );
    }
    if (tool === "discord.editMessage") {
      return client.editMessage(
        snowflake(input.channelId, "channelId"),
        snowflake(input.messageId, "messageId"),
        requiredText(input.content, "content", 2_000)
      );
    }
    if (tool === "discord.deleteMessage") {
      return client.deleteMessage(
        snowflake(input.channelId, "channelId"),
        snowflake(input.messageId, "messageId")
      );
    }
    if (tool === "discord.addReaction") {
      return client.addReaction(
        snowflake(input.channelId, "channelId"),
        snowflake(input.messageId, "messageId"),
        requiredText(input.emoji, "emoji", 128)
      );
    }
    if (tool === "discord.removeReaction") {
      return client.removeReaction(
        snowflake(input.channelId, "channelId"),
        snowflake(input.messageId, "messageId"),
        requiredText(input.emoji, "emoji", 128)
      );
    }
    if (tool === "discord.listReactions") {
      return client.listReactions(
        snowflake(input.channelId, "channelId"),
        snowflake(input.messageId, "messageId"),
        requiredText(input.emoji, "emoji", 128),
        Number(input.limit) || 100
      );
    }
    if (tool === "discord.pinMessage" || tool === "discord.unpinMessage") {
      const method = tool === "discord.pinMessage" ? client.pinMessage.bind(client) : client.unpinMessage.bind(client);
      return method(snowflake(input.channelId, "channelId"), snowflake(input.messageId, "messageId"));
    }
    if (tool === "discord.listPins") {
      return client.listPins(snowflake(input.channelId, "channelId"));
    }
    if (tool === "discord.sendPoll") {
      return client.sendPoll(
        snowflake(input.channelId, "channelId"),
        requiredText(input.question, "question", 300),
        requiredStringArray(input.answers, "answers", 10, 55),
        {
          durationHours: Number(input.durationHours) || 24,
          allowMultiselect: input.allowMultiselect === true
        }
      );
    }
    if (tool === "discord.createThread") {
      const duration = Number(input.autoArchiveDuration);
      return client.createThread(
        snowflake(input.channelId, "channelId"),
        requiredText(input.name, "name", 100),
        {
          ...(input.messageId ? { messageId: snowflake(input.messageId, "messageId") } : {}),
          autoArchiveDuration: [60, 1440, 4320, 10080].includes(duration)
            ? duration as 60 | 1440 | 4320 | 10080
            : 1440
        }
      );
    }
    if (tool === "discord.listThreads") {
      return client.listThreads(snowflake(input.guildId, "guildId"));
    }
    if (tool === "discord.replyThread") {
      return client.replyThread(
        snowflake(input.threadId, "threadId"),
        requiredText(input.content, "content", 2_000),
        input.replyToId ? snowflake(input.replyToId, "replyToId") : undefined
      );
    }
    if (tool === "discord.searchMessages") {
      return client.searchMessages(
        snowflake(input.guildId, "guildId"),
        requiredText(input.query, "query", 1_024),
        {
          ...(input.channelId ? { channelId: snowflake(input.channelId, "channelId") } : {}),
          limit: Number(input.limit) || 25
        }
      );
    }
    throw new Error(`unsupported Discord tool: ${tool}`);
  };
  return new Map(DISCORD_AGENT_TOOL_SCHEMAS
    .filter((schema) => plugin.tools[schema.function.name] !== false)
    .map((schema) => {
      const name = schema.function.name;
      const definition: ChannelAgentToolDefinition = {
        description: schema.function.description,
        inputSchema: schema.function.parameters,
        resourceBinding: (input: Record<string, unknown>) => discordResourceBinding(name, plugin.accounts, input),
        ...(DISCORD_MUTATION_TOOLS.has(name) ? {
          approvalBinding: (input: Record<string, unknown>) => {
            const account = resolveDiscordAccount(plugin.accounts, input.accountId);
            const normalizedInput = { ...input };
            delete normalizedInput.confirmed;
            delete normalizedInput.approvalId;
            return {
              accountId: account.accountId,
              input: normalizedInput,
              summary: discordMutationSummary(name, input)
            };
          },
          approvalFailureMessage: "Discord action approval is missing, expired, already used, or does not match this action"
        } : {}),
        invoke: (input: Record<string, unknown>) => invoke(name, input)
      };
      return [name, definition] as const;
    }));
}

function resolveDiscordPluginConfig(config: Record<string, any>) {
  const entry = config.plugins?.entries?.discord;
  const pluginConfig = entry?.config && typeof entry.config === "object" ? entry.config : {};
  const channelAccounts = Object.fromEntries(Object.entries(config.channels ?? {})
    .filter(([, value]: any) => value?.type === "discord"));
  const pluginAccounts = pluginConfig.accounts && typeof pluginConfig.accounts === "object" ? pluginConfig.accounts : {};
  return {
    enabled: entry && typeof entry === "object"
      ? entry.enabled === true
      : Object.keys(channelAccounts).length > 0 || Object.keys(pluginAccounts).length > 0,
    accounts: { ...pluginAccounts, ...channelAccounts },
    tools: pluginConfig.tools && typeof pluginConfig.tools === "object" ? pluginConfig.tools : {}
  };
}

function resolveDiscordAccount(accounts: Record<string, any>, requestedAccountId: unknown) {
  const account = resolveDiscordAccountIdentity(accounts, requestedAccountId);
  const token = account.tokenEnv ? process.env[account.tokenEnv] : "";
  if (!token) throw new Error(`Discord credential is unavailable in ${account.tokenEnv || "the configured token environment variable"}`);
  return { accountId: account.accountId, token };
}

function resolveDiscordAccountIdentity(accounts: Record<string, any>, requestedAccountId: unknown) {
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
  return account;
}

function discordResourceAccountId(accounts: Record<string, any>, requestedAccountId: unknown) {
  const requested = String(requestedAccountId ?? "").trim();
  if (requested) return requested;
  return resolveDiscordAccountIdentity(accounts, undefined).accountId;
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

function requiredStringArray(value: unknown, field: string, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > maximumItems) {
    throw new Error(`Discord ${field} requires between 2 and ${maximumItems} entries`);
  }
  return value.map((entry, index) => requiredText(entry, `${field}[${index}]`, maximumLength));
}

function discordMutationSummary(tool: string, input: Record<string, unknown>) {
  if (tool === "discord.sendMessage") return `Send a message to Discord channel ${String(input.channelId ?? "")}`;
  if (tool === "discord.editMessage") return `Edit Discord message ${String(input.messageId ?? "")}`;
  if (tool === "discord.deleteMessage") return `Delete Discord message ${String(input.messageId ?? "")}`;
  if (tool === "discord.addReaction") return `Add reaction ${String(input.emoji ?? "")} to Discord message ${String(input.messageId ?? "")}`;
  if (tool === "discord.removeReaction") return `Remove reaction ${String(input.emoji ?? "")} from Discord message ${String(input.messageId ?? "")}`;
  if (tool === "discord.pinMessage") return `Pin Discord message ${String(input.messageId ?? "")}`;
  if (tool === "discord.unpinMessage") return `Unpin Discord message ${String(input.messageId ?? "")}`;
  if (tool === "discord.sendPoll") return `Create Discord poll ${String(input.question ?? "")}`;
  if (tool === "discord.replyThread") return `Reply in Discord thread ${String(input.threadId ?? "")}`;
  return `Create Discord thread ${String(input.name ?? "")} in channel ${String(input.channelId ?? "")}`;
}

function discordResourceBinding(tool: string, accounts: Record<string, any>, input: Record<string, unknown>) {
  const resource: Record<string, unknown> = {
    accountId: discordResourceAccountId(accounts, input.accountId)
  };
  const fields = tool === "discord.listChannels" || tool === "discord.listThreads"
    ? ["guildId"] as const
    : tool === "discord.replyThread"
      ? ["threadId", "replyToId"] as const
      : tool === "discord.searchMessages"
        ? ["guildId", "channelId"] as const
        : tool === "discord.sendMessage"
          ? ["channelId", "replyToId"] as const
          : tool === "discord.listPins" || tool === "discord.readMessages" || tool === "discord.sendPoll"
            ? ["channelId"] as const
            : ["channelId", "messageId"] as const;
  for (const field of fields) {
    if (input[field] !== undefined && input[field] !== "") {
      resource[field] = snowflake(input[field], field);
    }
  }
  if (tool === "discord.addReaction" || tool === "discord.removeReaction" || tool === "discord.listReactions") {
    resource.emoji = requiredText(input.emoji, "emoji", 128);
  }
  return resource;
}
