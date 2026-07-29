import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type ChannelConversationKind = "direct" | "group" | "channel" | "thread";
export interface ChannelAddress { channel: string; accountId: string; conversationId: string; conversationKind: ChannelConversationKind; threadId?: string }
export interface ChannelSender { id: string; displayName?: string; username?: string }
export interface InboundChannelMessage { id: string; address: ChannelAddress; sender: ChannelSender; text: string; receivedAt: string; replyToId?: string; metadata?: Record<string, unknown> }
export interface OutboundChannelMessage { address: ChannelAddress; text: string; replyToId?: string }
export type ChannelAcknowledgement = "processing" | "succeeded" | "failed";
export interface ChannelAdapter {
  readonly id: string;
  start(deliver: (message: InboundChannelMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundChannelMessage): Promise<void>;
  acknowledge?(message: InboundChannelMessage, acknowledgement: ChannelAcknowledgement): Promise<void>;
}
export interface ChannelMessageHandler { handle(message: InboundChannelMessage): Promise<string | undefined> }
export interface ChannelAccessPolicy { allows(message: InboundChannelMessage): boolean }
export interface ChannelRouterOptions { access?: ChannelAccessPolicy; dedupeSize?: number; onError?: (error: unknown, message: InboundChannelMessage) => void }

export function channelConversationKey(address: ChannelAddress): string {
  return [address.channel, address.accountId, address.conversationKind, address.conversationId, address.threadId ?? ""].map(encodeURIComponent).join(":");
}

export function createAllowlistPolicy(entries: string[]): ChannelAccessPolicy {
  const allowed = new Set(entries.map((entry) => entry.trim()).filter(Boolean));
  return {
    allows(message) {
      if (allowed.size === 0) return false;
      return allowed.has(`${message.address.channel}:${message.sender.id}`)
        || allowed.has(`${message.address.channel}:${message.address.conversationId}`);
    }
  };
}

export class ChannelRouter {
  readonly #handler: ChannelMessageHandler;
  readonly #options: ChannelRouterOptions & { dedupeSize: number };
  readonly #seen = new Set<string>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(handler: ChannelMessageHandler, options: ChannelRouterOptions = {}) {
    this.#handler = handler;
    this.#options = { ...options, dedupeSize: Math.max(1, options.dedupeSize ?? 2_000) };
  }

  attach(adapter: ChannelAdapter): Promise<void> {
    return adapter.start((message) => this.#enqueue(adapter, message));
  }

  async #enqueue(adapter: ChannelAdapter, message: InboundChannelMessage): Promise<void> {
    validateInboundMessage(message);
    if (this.#options.access && !this.#options.access.allows(message)) return;
    const deliveryKey = `${message.address.channel}:${message.address.accountId}:${message.id}`;
    if (this.#seen.has(deliveryKey)) return;
    this.#remember(deliveryKey);
    await this.#acknowledge(adapter, message, "processing");
    const conversationKey = channelConversationKey(message.address);
    const previous = this.#queues.get(conversationKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      try {
        const reply = await this.#handler.handle(message);
        if (reply?.trim()) await adapter.send({ address: message.address, text: reply, replyToId: message.id });
        await this.#acknowledge(adapter, message, "succeeded");
      } catch (error) {
        await this.#acknowledge(adapter, message, "failed");
        throw error;
      }
    }).catch((error) => this.#options.onError?.(error, message)).finally(() => {
      if (this.#queues.get(conversationKey) === current) this.#queues.delete(conversationKey);
    });
    this.#queues.set(conversationKey, current);
    await current;
  }

  async #acknowledge(adapter: ChannelAdapter, message: InboundChannelMessage, acknowledgement: ChannelAcknowledgement): Promise<void> {
    await adapter.acknowledge?.(message, acknowledgement).catch(() => undefined);
  }

  #remember(key: string): void {
    this.#seen.add(key);
    while (this.#seen.size > this.#options.dedupeSize) {
      const oldest = this.#seen.values().next().value;
      if (typeof oldest !== "string") break;
      this.#seen.delete(oldest);
    }
  }
}

export interface SessionBindingStore {
  get(address: ChannelAddress): Promise<string | undefined>;
  set(address: ChannelAddress, sessionId: string): Promise<void>;
}
interface BindingState { schemaVersion: 1; bindings: Record<string, string> }

export class FileSessionBindingStore implements SessionBindingStore {
  readonly #path: string;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = resolve(path);
  }

  async get(address: ChannelAddress): Promise<string | undefined> {
    return (await this.#read()).bindings[channelConversationKey(address)];
  }

  async set(address: ChannelAddress, sessionId: string): Promise<void> {
    const cleanSessionId = sessionId.trim();
    if (!cleanSessionId) throw new Error("channel session binding requires a session identifier");
    this.#writeQueue = this.#writeQueue.then(async () => {
      const state = await this.#read();
      state.bindings[channelConversationKey(address)] = cleanSessionId;
      await mkdir(dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#path);
      await chmod(this.#path, 0o600);
    });
    await this.#writeQueue;
  }

  async #read(): Promise<BindingState> {
    try {
      const value = JSON.parse(await readFile(this.#path, "utf8")) as BindingState;
      if (value.schemaVersion !== 1 || !value.bindings || typeof value.bindings !== "object") throw new Error("unsupported channel binding state");
      return value;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, bindings: {} };
      throw error;
    }
  }
}

export interface GatewayChannelHandlerOptions {
  baseUrl?: string;
  token: string;
  bindings: SessionBindingStore;
  defaultModel?: string;
  fetch?: typeof globalThis.fetch;
}

export class GatewayChannelHandler implements ChannelMessageHandler {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #bindings: SessionBindingStore;
  readonly #defaultModel?: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: GatewayChannelHandlerOptions) {
    if (!options.token.trim()) throw new Error("channel gateway handler requires a gateway token");
    let baseUrl = options.baseUrl ?? "http://127.0.0.1:18790";
    while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
    this.#baseUrl = baseUrl;
    this.#token = options.token;
    this.#bindings = options.bindings;
    this.#defaultModel = options.defaultModel;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async handle(message: InboundChannelMessage): Promise<string> {
    let sessionId = await this.#bindings.get(message.address);
    if (!sessionId) {
      const created = await this.#request("/sessions", {
        title: channelSessionTitle(message), tags: ["channel", message.address.channel], source: `channel:${message.address.channel}`
      });
      sessionId = requiredString(created.id, "gateway did not return a session identifier");
      await this.#bindings.set(message.address, sessionId);
    }
    await this.#request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      role: "user", content: message.text, source: `channel:${message.address.channel}`, actor: `channel:${message.address.channel}:${message.sender.id}`
    });
    const detail = await this.#get(`/sessions/${encodeURIComponent(sessionId)}`);
    const messages = Array.isArray(detail.messages)
      ? detail.messages.filter(isChatMessage).map((entry) => ({ role: entry.role, content: entry.content }))
      : [];
    const result = await this.#request("/run", {
      tool: "agent.run",
      input: { sessionId, messages, ...this.#defaultModel ? { model: this.#defaultModel } : {} },
      actor: `channel:${message.address.channel}`
    });
    const output = result.output && typeof result.output === "object" ? result.output as Record<string, unknown> : {};
    const reply = requiredString(output.content, "gateway model run returned no assistant content");
    await this.#request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      role: "assistant", content: reply, source: `channel:${message.address.channel}`,
      ...typeof output.model === "string" ? { model: output.model } : {},
      ...typeof output.provider === "string" ? { provider: output.provider } : {}
    });
    return reply;
  }

  #get(path: string): Promise<Record<string, unknown>> {
    return this.#call(path, { method: "GET" });
  }

  #request(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  async #call(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init, headers: { ...init.headers, authorization: `Bearer ${this.#token}` }
    });
    const value = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `gateway request failed with ${response.status}`);
    return value;
  }
}

export function splitChannelText(text: string, maximumCodePoints: number): string[] {
  if (!Number.isSafeInteger(maximumCodePoints) || maximumCodePoints < 1) throw new Error("channel text limit must be a positive integer");
  const codePoints = Array.from(text);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < codePoints.length) {
    if (codePoints.length - offset <= maximumCodePoints) {
      chunks.push(codePoints.slice(offset).join(""));
      break;
    }
    const candidate = codePoints.slice(offset, offset + maximumCodePoints);
    const splitAt = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "));
    const length = splitAt >= Math.floor(maximumCodePoints / 2) ? splitAt + 1 : maximumCodePoints;
    chunks.push(codePoints.slice(offset, offset + length).join("").trimEnd());
    offset += length;
    while (codePoints[offset] === " " || codePoints[offset] === "\n") offset += 1;
  }
  return chunks;
}

function validateInboundMessage(message: InboundChannelMessage): void {
  if (!message.id.trim()) throw new Error("channel message requires an identifier");
  if (!message.text.trim()) throw new Error("channel message requires text");
  if (!message.address.channel.trim() || !message.address.accountId.trim() || !message.address.conversationId.trim()) throw new Error("channel message requires a complete address");
  if (!message.sender.id.trim()) throw new Error("channel message requires a sender identifier");
}
function channelSessionTitle(message: InboundChannelMessage): string {
  const sender = message.sender.displayName || message.sender.username || message.sender.id;
  return `${message.address.channel}: ${sender}`.slice(0, 120);
}
function isChatMessage(value: unknown): value is { role: string; content: string } {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return ["user", "assistant", "system", "tool"].includes(String(message.role)) && typeof message.content === "string";
}
function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value;
}
