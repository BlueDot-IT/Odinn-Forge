import { REST, Routes } from "discord.js";

export class DiscordRestClient {
  readonly #token: string;
  readonly #rest: REST;
  readonly #fetch?: typeof globalThis.fetch;

  constructor({ token, fetch }: { token: string; fetch?: typeof globalThis.fetch }) {
    if (!token.trim()) throw new Error("Discord REST client requires a bot token");
    this.#token = token;
    this.#fetch = fetch;
    this.#rest = new REST({ version: "10", timeout: 30_000 }).setToken(token);
  }

  listChannels(guildId: string): Promise<unknown> {
    return this.#request("GET", Routes.guildChannels(discordSnowflake(guildId, "guildId")));
  }

  readMessages(channelId: string, options: { limit?: number; before?: string; after?: string } = {}): Promise<unknown> {
    const query = new URLSearchParams({
      limit: String(Math.min(Math.max(Number(options.limit) || 50, 1), 100))
    });
    if (options.before) query.set("before", discordSnowflake(options.before, "before"));
    if (options.after) query.set("after", discordSnowflake(options.after, "after"));
    return this.#request("GET", `${Routes.channelMessages(discordSnowflake(channelId, "channelId"))}?${query}`);
  }

  sendMessage(channelId: string, content: string, replyToId?: string): Promise<unknown> {
    return this.#request("POST", Routes.channelMessages(discordSnowflake(channelId, "channelId")), {
      content: discordText(content, "content", 2_000),
      allowed_mentions: { parse: [], replied_user: false },
      ...(replyToId ? {
        message_reference: {
          message_id: discordSnowflake(replyToId, "replyToId"),
          fail_if_not_exists: false
        }
      } : {})
    });
  }

  editMessage(channelId: string, messageId: string, content: string): Promise<unknown> {
    return this.#request(
      "PATCH",
      Routes.channelMessage(discordSnowflake(channelId, "channelId"), discordSnowflake(messageId, "messageId")),
      {
        content: discordText(content, "content", 2_000),
        allowed_mentions: { parse: [], replied_user: false }
      }
    );
  }

  deleteMessage(channelId: string, messageId: string): Promise<unknown> {
    return this.#request(
      "DELETE",
      Routes.channelMessage(discordSnowflake(channelId, "channelId"), discordSnowflake(messageId, "messageId"))
    );
  }

  addReaction(channelId: string, messageId: string, emoji: string): Promise<unknown> {
    return this.#request(
      "PUT",
      Routes.channelMessageOwnReaction(
        discordSnowflake(channelId, "channelId"),
        discordSnowflake(messageId, "messageId"),
        encodeURIComponent(discordText(emoji, "emoji", 128))
      )
    );
  }

  removeReaction(channelId: string, messageId: string, emoji: string): Promise<unknown> {
    return this.#request(
      "DELETE",
      Routes.channelMessageOwnReaction(
        discordSnowflake(channelId, "channelId"),
        discordSnowflake(messageId, "messageId"),
        encodeURIComponent(discordText(emoji, "emoji", 128))
      )
    );
  }

  listReactions(channelId: string, messageId: string, emoji: string, limit = 100): Promise<unknown> {
    const query = new URLSearchParams({ limit: String(Math.min(Math.max(Number(limit) || 100, 1), 100)) });
    return this.#request(
      "GET",
      `${Routes.channelMessageReaction(
        discordSnowflake(channelId, "channelId"),
        discordSnowflake(messageId, "messageId"),
        encodeURIComponent(discordText(emoji, "emoji", 128))
      )}?${query}`
    );
  }

  pinMessage(channelId: string, messageId: string): Promise<unknown> {
    return this.#request(
      "PUT",
      Routes.channelPin(discordSnowflake(channelId, "channelId"), discordSnowflake(messageId, "messageId"))
    );
  }

  unpinMessage(channelId: string, messageId: string): Promise<unknown> {
    return this.#request(
      "DELETE",
      Routes.channelPin(discordSnowflake(channelId, "channelId"), discordSnowflake(messageId, "messageId"))
    );
  }

  listPins(channelId: string): Promise<unknown> {
    return this.#request("GET", Routes.channelPins(discordSnowflake(channelId, "channelId")));
  }

  sendPoll(channelId: string, question: string, answers: string[], options: {
    durationHours?: number;
    allowMultiselect?: boolean;
  } = {}): Promise<unknown> {
    if (answers.length < 2 || answers.length > 10) throw new Error("Discord poll requires between 2 and 10 answers");
    const duration = Math.min(Math.max(Number(options.durationHours) || 24, 1), 768);
    return this.#request("POST", Routes.channelMessages(discordSnowflake(channelId, "channelId")), {
      poll: {
        question: { text: discordText(question, "question", 300) },
        answers: answers.map((answer) => ({ poll_media: { text: discordText(answer, "answer", 55) } })),
        duration,
        allow_multiselect: options.allowMultiselect === true,
        layout_type: 1
      },
      allowed_mentions: { parse: [], replied_user: false }
    });
  }

  createThread(channelId: string, name: string, options: {
    messageId?: string;
    autoArchiveDuration?: 60 | 1440 | 4320 | 10080;
  } = {}): Promise<unknown> {
    const cleanChannelId = discordSnowflake(channelId, "channelId");
    const path = options.messageId
      ? Routes.threads(cleanChannelId, discordSnowflake(options.messageId, "messageId"))
      : Routes.threads(cleanChannelId);
    return this.#request("POST", path, {
      name: discordText(name, "name", 100),
      auto_archive_duration: options.autoArchiveDuration ?? 1_440,
      ...options.messageId ? {} : { type: 11 }
    });
  }

  listThreads(guildId: string): Promise<unknown> {
    return this.#request("GET", Routes.guildActiveThreads(discordSnowflake(guildId, "guildId")));
  }

  replyThread(threadId: string, content: string, replyToId?: string): Promise<unknown> {
    return this.sendMessage(threadId, content, replyToId);
  }

  searchMessages(guildId: string, query: string, options: {
    channelId?: string;
    limit?: number;
  } = {}): Promise<unknown> {
    const parameters = new URLSearchParams({
      content: discordText(query, "query", 1_024),
      limit: String(Math.min(Math.max(Number(options.limit) || 25, 1), 25))
    });
    if (options.channelId) parameters.set("channel_id", discordSnowflake(options.channelId, "channelId"));
    return this.#request(
      "GET",
      `${Routes.guildMessagesSearch(discordSnowflake(guildId, "guildId"))}?${parameters}`
    );
  }

  async probe(): Promise<{ ok: boolean; bot?: unknown; application?: unknown; latencyMs: number; error?: string }> {
    const startedAt = Date.now();
    try {
      const [bot, application] = await Promise.all([
        this.#request("GET", Routes.user("@me")),
        this.#request("GET", Routes.oauth2CurrentApplication())
      ]);
      return { ok: true, bot, application, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
    }
  }

  async #request(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: `/${string}`,
    body?: Record<string, unknown>
  ): Promise<unknown> {
    if (this.#fetch) {
      const response = await this.#fetch(`https://discord.com/api/v10${path}`, {
        method,
        headers: {
          authorization: `Bot ${this.#token}`,
          ...(body ? { "content-type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      if (response.status === 204) return { ok: true };
      const value = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = value && typeof value === "object" && typeof (value as Record<string, unknown>).message === "string"
          ? String((value as Record<string, unknown>).message)
          : `request failed with ${response.status}`;
        throw new Error(`Discord API: ${message}`);
      }
      return value;
    }
    switch (method) {
      case "GET": return this.#rest.get(path);
      case "POST": return this.#rest.post(path, body ? { body } : {});
      case "PATCH": return this.#rest.patch(path, body ? { body } : {});
      case "PUT": return this.#rest.put(path, body ? { body } : {});
      case "DELETE": return this.#rest.delete(path);
    }
  }
}

function discordSnowflake(value: unknown, field: string): string {
  const clean = String(value ?? "").trim();
  if (!/^\d{1,20}$/u.test(clean)) throw new Error(`Discord ${field} must be a numeric identifier`);
  return clean;
}

function discordText(value: unknown, field: string, maximum: number): string {
  const clean = String(value ?? "").trim();
  if (!clean) throw new Error(`Discord ${field} is required`);
  if (Array.from(clean).length > maximum) throw new Error(`Discord ${field} exceeds ${maximum} characters`);
  return clean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
