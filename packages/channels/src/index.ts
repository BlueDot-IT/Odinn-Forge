import { SecureJsonFileStore } from "@odinn/store-file";

export * from "./plugin.ts";

export type ChannelConversationKind = "direct" | "group" | "channel" | "thread";
export interface ChannelAddress { channel: string; accountId: string; conversationId: string; conversationKind: ChannelConversationKind; threadId?: string }
export interface ChannelSender { id: string; displayName?: string; username?: string }
export interface ChannelAttachment {
  id?: string;
  filename?: string;
  contentType?: string;
  size?: number;
  url?: string;
  path?: string;
  description?: string;
}
export interface ChannelComponent {
  type: "button";
  customId: string;
  label: string;
  style?: "primary" | "secondary" | "success" | "danger";
  disabled?: boolean;
}
export interface InboundChannelMessage {
  id: string;
  address: ChannelAddress;
  sender: ChannelSender;
  text: string;
  receivedAt: string;
  replyToId?: string;
  attachments?: ChannelAttachment[];
  metadata?: Record<string, unknown>;
}
export type ChannelExecutionState = "accepted" | "running" | "uncertain" | "reconciled" | "completed" | "delivery-failed";
export interface ChannelExecutionStateEvent {
  executionKey: string;
  state: ChannelExecutionState;
  message: InboundChannelMessage;
  error?: string;
}
export interface OutboundChannelMessage {
  address: ChannelAddress;
  text?: string;
  replyToId?: string;
  attachments?: ChannelAttachment[];
  components?: ChannelComponent[];
  silent?: boolean;
  suppressEmbeds?: boolean;
}
export interface ChannelCapabilities {
  chatTypes: ChannelConversationKind[];
  reactions?: boolean;
  replies?: boolean;
  typing?: boolean;
  threads?: boolean;
  media?: boolean;
  edits?: boolean;
  deletes?: boolean;
  components?: boolean;
  nativeCommands?: boolean;
  streaming?: boolean;
}
export type ChannelConnectionState = "stopped" | "starting" | "connected" | "degraded" | "failed";
export interface ChannelStatus {
  channel: string;
  accountId: string;
  state: ChannelConnectionState;
  connectedAt?: string;
  lastEventAt?: string;
  reconnectAttempts?: number;
  latencyMs?: number;
  error?: string;
  details?: Record<string, unknown>;
}
export interface ChannelDeliveryReceipt {
  status: "sent" | "partial" | "failed";
  messageIds: string[];
  conversationId: string;
  sentChunks: number;
  totalChunks: number;
}
export type ChannelAcknowledgement = "processing" | "succeeded" | "failed";
export interface ChannelStartContext {
  signal: AbortSignal;
  deliver(message: InboundChannelMessage): Promise<boolean>;
  updateStatus(status: Partial<ChannelStatus>): void;
}
export interface ChannelWebhookRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: Buffer;
  rawRequest?: unknown;
  rawResponse?: unknown;
}
export interface ChannelWebhookResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}
export interface ChannelAdapter {
  readonly id: string;
  readonly channel: string;
  readonly accountId: string;
  readonly capabilities: ChannelCapabilities;
  start(context: ChannelStartContext): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundChannelMessage): Promise<ChannelDeliveryReceipt>;
  acknowledge?(message: InboundChannelMessage, acknowledgement: ChannelAcknowledgement): Promise<void>;
  sendTyping?(address: ChannelAddress): Promise<void>;
  edit?(address: ChannelAddress, messageId: string, message: OutboundChannelMessage): Promise<void>;
  delete?(address: ChannelAddress, messageId: string): Promise<void>;
  probe?(): Promise<ChannelStatus>;
  handleWebhook?(request: ChannelWebhookRequest): Promise<ChannelWebhookResponse | void>;
}
export interface ChannelMessageHandlerContext {
  signal: AbortSignal;
  onDelta?(delta: string): void | Promise<void>;
}
export interface ChannelMessageHandler {
  handle(message: InboundChannelMessage, context: ChannelMessageHandlerContext): Promise<string | undefined>;
}
export interface ChannelAccessPolicy { allows(message: InboundChannelMessage): boolean | Promise<boolean> }
export interface ChannelDedupeStore {
  claim(key: string): Promise<boolean>;
  commit(key: string): Promise<void>;
  release(key: string): Promise<void>;
}
export interface ChannelRouterOptions {
  access?: ChannelAccessPolicy;
  dedupe?: ChannelDedupeStore;
  dedupeSize?: number;
  dedupeTtlMs?: number;
  maxConcurrency?: number;
  maxQueueSize?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  maximumPendingGlobal?: number;
  maximumPendingPerConversation?: number;
  maximumMessagesPerSenderWindow?: number;
  maximumTrackedSenders?: number;
  senderWindowMs?: number;
  onExecutionState?: (event: ChannelExecutionStateEvent) => void | Promise<void>;
  clock?: () => number;
  onError?: (error: unknown, message: InboundChannelMessage) => void;
}

export class ChannelAdmissionError extends Error {
  readonly code = "CHANNEL_CAPACITY_REACHED";
  readonly scope: "global" | "conversation" | "sender" | "sender-state";
  readonly limit: number;

  constructor(scope: "global" | "conversation" | "sender" | "sender-state", limit: number) {
    super(`channel ${scope} admission limit reached (${limit})`);
    this.name = "ChannelAdmissionError";
    this.scope = scope;
    this.limit = limit;
  }
}

export class ChannelRetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChannelRetryableError";
  }
}

export class ChannelDeliveryError extends Error {
  readonly receipt: ChannelDeliveryReceipt;

  constructor(message: string, receipt: ChannelDeliveryReceipt, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChannelDeliveryError";
    this.receipt = receipt;
  }
}

export class ChannelRunUncertainError extends Error {
  readonly code = "CHANNEL_RUN_UNCERTAIN";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChannelRunUncertainError";
  }
}

export class MemoryChannelDedupeStore implements ChannelDedupeStore {
  readonly #entries = new Map<string, { state: "claimed" | "committed"; expiresAt: number }>();
  readonly #maximum: number;
  readonly #ttlMs: number;

  constructor({ maximum = 5_000, ttlMs = 5 * 60_000 }: { maximum?: number; ttlMs?: number } = {}) {
    this.#maximum = Math.max(1, maximum);
    this.#ttlMs = Math.max(1_000, ttlMs);
  }

  async claim(key: string): Promise<boolean> {
    this.#prune();
    if (this.#entries.has(key)) return false;
    this.#entries.set(key, { state: "claimed", expiresAt: Date.now() + this.#ttlMs });
    this.#prune();
    return true;
  }

  async commit(key: string): Promise<void> {
    if (!this.#entries.has(key)) return;
    this.#entries.set(key, { state: "committed", expiresAt: Date.now() + this.#ttlMs });
  }

  async release(key: string): Promise<void> {
    if (this.#entries.get(key)?.state === "claimed") this.#entries.delete(key);
  }

  #prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
    while (this.#entries.size > this.#maximum) {
      const oldest = this.#entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#entries.delete(oldest);
    }
  }
}

interface ChannelDedupeFileState {
  schemaVersion: 1;
  entries: Record<string, { state: "claimed" | "committed"; expiresAt: number }>;
}

export class FileChannelDedupeStore implements ChannelDedupeStore {
  readonly #claimTtlMs: number;
  readonly #commitTtlMs: number;
  readonly #maximum: number;
  readonly #store: SecureJsonFileStore<ChannelDedupeFileState>;

  constructor(path: string, {
    claimTtlMs = 2 * 60_000,
    commitTtlMs = 5 * 60_000,
    maximum = 10_000,
    lockTimeoutMs = 30_000
  }: { claimTtlMs?: number; commitTtlMs?: number; maximum?: number; lockTimeoutMs?: number } = {}) {
    this.#claimTtlMs = Math.max(1_000, claimTtlMs);
    this.#commitTtlMs = Math.max(1_000, commitTtlMs);
    this.#maximum = Math.max(1, maximum);
    this.#store = new SecureJsonFileStore(path, {
      label: "channel dedupe state",
      create: () => ({ schemaVersion: 1, entries: {} }),
      validate: validateChannelDedupeState,
      lockTimeoutMs
    });
  }

  claim(key: string): Promise<boolean> {
    return this.#mutate((state) => {
      if (state.entries[key]) return false;
      state.entries[key] = { state: "claimed", expiresAt: Date.now() + this.#claimTtlMs };
      return true;
    });
  }

  commit(key: string): Promise<void> {
    return this.#mutate((state) => {
      if (state.entries[key]) {
        state.entries[key] = { state: "committed", expiresAt: Date.now() + this.#commitTtlMs };
      }
    });
  }

  release(key: string): Promise<void> {
    return this.#mutate((state) => {
      if (state.entries[key]?.state === "claimed") delete state.entries[key];
    });
  }

  #mutate<Result>(operation: (state: ChannelDedupeFileState) => Result): Promise<Result> {
    return this.#store.mutate((state) => {
      this.#prune(state);
      const result = operation(state);
      return result;
    });
  }

  #prune(state: ChannelDedupeFileState): void {
    const now = Date.now();
    for (const [key, entry] of Object.entries(state.entries)) {
      if (!entry || entry.expiresAt <= now || !["claimed", "committed"].includes(entry.state)) {
        delete state.entries[key];
      }
    }
    const entries = Object.entries(state.entries).sort((left, right) => left[1].expiresAt - right[1].expiresAt);
    while (entries.length > this.#maximum) {
      const oldest = entries.shift();
      if (oldest) delete state.entries[oldest[0]];
    }
  }
}

export function channelConversationKey(address: ChannelAddress): string {
  return [address.channel, address.accountId, address.conversationKind, address.conversationId, address.threadId ?? ""].map(encodeURIComponent).join(":");
}

export function channelExecutionKey(message: InboundChannelMessage): string {
  return `${channelConversationKey(message.address)}:${encodeURIComponent(message.id)}`;
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
  readonly #options: ChannelRouterOptions & {
    maxConcurrency: number;
    maxQueueSize: number;
    maxAttempts: number;
    retryDelayMs: number;
    maximumPendingGlobal: number;
    maximumPendingPerConversation: number;
    maximumMessagesPerSenderWindow: number;
    maximumTrackedSenders: number;
    senderWindowMs: number;
  };
  readonly #clock: () => number;
  readonly #dedupe: ChannelDedupeStore;
  readonly #queues = new Map<string, Array<{
    adapter: ChannelAdapter;
    message: InboundChannelMessage;
    deliveryKey: string;
    resolve(): void;
  }>>();
  readonly #activeKeys = new Set<string>();
  readonly #activeJobs = new Set<Promise<void>>();
  readonly #pendingByConversation = new Map<string, number>();
  readonly #senderWindows = new Map<string, { count: number; resetAt: number }>();
  #active = 0;
  #queued = 0;
  #pendingGlobal = 0;
  #abort = new AbortController();

  constructor(handler: ChannelMessageHandler, options: ChannelRouterOptions = {}) {
    this.#handler = handler;
    this.#options = {
      ...options,
      maxConcurrency: Math.max(1, options.maxConcurrency ?? 8),
      maxQueueSize: Math.max(1, options.maxQueueSize ?? 1_000),
      maxAttempts: Math.max(1, options.maxAttempts ?? 3),
      retryDelayMs: Math.max(10, options.retryDelayMs ?? 1_000),
      maximumPendingGlobal: boundedPositiveInteger(options.maximumPendingGlobal, 100),
      maximumPendingPerConversation: boundedPositiveInteger(options.maximumPendingPerConversation, 8),
      maximumMessagesPerSenderWindow: boundedPositiveInteger(options.maximumMessagesPerSenderWindow, 30),
      maximumTrackedSenders: boundedPositiveInteger(options.maximumTrackedSenders, 2_000),
      senderWindowMs: boundedPositiveInteger(options.senderWindowMs, 60_000)
    };
    this.#clock = options.clock ?? Date.now;
    this.#dedupe = options.dedupe ?? new MemoryChannelDedupeStore({
      maximum: options.dedupeSize ?? 5_000,
      ttlMs: options.dedupeTtlMs ?? 5 * 60_000
    });
  }

  attach(adapter: ChannelAdapter, updateStatus: (status: Partial<ChannelStatus>) => void = () => {}): Promise<void> {
    if (this.#abort.signal.aborted) this.#abort = new AbortController();
    return adapter.start({
      signal: this.#abort.signal,
      deliver: (message) => this.#enqueue(adapter, message),
      updateStatus
    });
  }

  async #enqueue(adapter: ChannelAdapter, message: InboundChannelMessage): Promise<boolean> {
    validateInboundMessage(message);
    if (this.#options.access && !await this.#options.access.allows(message)) return false;
    const deliveryKey = `${message.address.channel}:${message.address.accountId}:${message.id}`;
    if (!await this.#dedupe.claim(deliveryKey)) return false;
    const conversationKey = channelConversationKey(message.address);
    const conversationPending = this.#pendingByConversation.get(conversationKey) ?? 0;
    const admissionError = this.#pendingGlobal >= this.#options.maximumPendingGlobal
      ? new ChannelAdmissionError("global", this.#options.maximumPendingGlobal)
      : conversationPending >= this.#options.maximumPendingPerConversation
        ? new ChannelAdmissionError("conversation", this.#options.maximumPendingPerConversation)
        : this.#admitSender(message);
    if (admissionError) {
      await this.#dedupe.release(deliveryKey);
      this.#options.onError?.(admissionError, message);
      return false;
    }
    if (this.#queued >= this.#options.maxQueueSize) {
      await this.#dedupe.release(deliveryKey);
      throw new ChannelRetryableError(`channel ingress queue is full (${this.#queued}/${this.#options.maxQueueSize})`);
    }
    this.#pendingGlobal += 1;
    this.#pendingByConversation.set(conversationKey, conversationPending + 1);
    await new Promise<void>((resolveQueued) => {
      const queue = this.#queues.get(conversationKey) ?? [];
      queue.push({ adapter, message, deliveryKey, resolve: resolveQueued });
      this.#queues.set(conversationKey, queue);
      this.#queued += 1;
      this.#drain();
    });
    return true;
  }

  async #acknowledge(adapter: ChannelAdapter, message: InboundChannelMessage, acknowledgement: ChannelAcknowledgement): Promise<void> {
    await adapter.acknowledge?.(message, acknowledgement).catch(() => undefined);
  }

  #drain(): void {
    while (this.#active < this.#options.maxConcurrency) {
      const entry = [...this.#queues.entries()].find(([key, queue]) => queue.length > 0 && !this.#activeKeys.has(key));
      if (!entry) break;
      const [conversationKey, queue] = entry;
      const job = queue.shift();
      if (!job) continue;
      this.#queued -= 1;
      this.#active += 1;
      this.#activeKeys.add(conversationKey);
      const activeJob = this.#run(job).finally(() => {
        job.resolve();
        this.#active -= 1;
        this.#pendingGlobal -= 1;
        const remaining = (this.#pendingByConversation.get(conversationKey) ?? 1) - 1;
        if (remaining > 0) this.#pendingByConversation.set(conversationKey, remaining);
        else this.#pendingByConversation.delete(conversationKey);
        this.#activeKeys.delete(conversationKey);
        if (queue.length === 0) this.#queues.delete(conversationKey);
        this.#activeJobs.delete(activeJob);
        this.#drain();
      });
      this.#activeJobs.add(activeJob);
    }
  }

  async #run({ adapter, message, deliveryKey }: {
    adapter: ChannelAdapter;
    message: InboundChannelMessage;
    deliveryKey: string;
  }): Promise<void> {
    await this.#acknowledge(adapter, message, "processing");
    let draftId: string | undefined;
    let draftText = "";
    let lastDraftUpdateAt = 0;
    let reply: string | undefined;
    let handlerCompleted = false;
    const editDraft = adapter.edit?.bind(adapter);
    for (let attempt = 1; attempt <= this.#options.maxAttempts; attempt += 1) {
      try {
        if (this.#abort.signal.aborted) throw new ChannelRetryableError("channel router stopped");
        await adapter.sendTyping?.(message.address).catch(() => undefined);
        if (!handlerCompleted) {
          reply = await this.#handler.handle(message, {
            signal: this.#abort.signal,
            ...adapter.capabilities.streaming && editDraft ? {
              onDelta: async (delta: string) => {
                draftText += delta;
                if (!draftText.trim()) return;
                const now = Date.now();
                if (!draftId) {
                  const receipt = await adapter.send({
                    address: message.address,
                    text: draftText,
                    replyToId: message.id,
                    suppressEmbeds: true
                  });
                  draftId = receipt.messageIds[0];
                  lastDraftUpdateAt = now;
                } else if (now - lastDraftUpdateAt >= 750) {
                  await editDraft(message.address, draftId, {
                    address: message.address,
                    text: draftText,
                    suppressEmbeds: true
                  });
                  lastDraftUpdateAt = now;
                }
              }
            } : {}
          });
          handlerCompleted = true;
        }
        if (reply?.trim()) {
          try {
            if (draftId && editDraft) {
              await editDraft(message.address, draftId, {
                address: message.address,
                text: reply,
                suppressEmbeds: true
              });
            } else {
              await adapter.send({
                address: message.address,
                text: reply,
                replyToId: message.id
              });
            }
          } catch (error) {
            throw new ChannelDeliveryError("channel reply delivery failed", {
              status: "failed",
              messageIds: draftId ? [draftId] : [],
              conversationId: message.address.conversationId,
              sentChunks: draftId ? 1 : 0,
              totalChunks: 1
            }, { cause: error });
          }
        }
        await this.#acknowledge(adapter, message, "succeeded");
        await this.#dedupe.commit(deliveryKey);
        return;
      } catch (error) {
        const retryable = isRetryableChannelError(error);
        if (retryable && attempt < this.#options.maxAttempts && !this.#abort.signal.aborted) {
          if (!handlerCompleted && draftId) {
            draftText = "";
            lastDraftUpdateAt = 0;
          }
          await delay(this.#options.retryDelayMs * 2 ** (attempt - 1), this.#abort.signal).catch(() => undefined);
          continue;
        }
        await this.#acknowledge(adapter, message, "failed");
        if (error instanceof ChannelDeliveryError) {
          await this.#reportExecutionState(message, "delivery-failed", error.message);
        }
        if (retryable) await this.#dedupe.release(deliveryKey);
        else await this.#dedupe.commit(deliveryKey);
        this.#options.onError?.(error, message);
        return;
      }
    }
  }

  async #reportExecutionState(message: InboundChannelMessage, state: ChannelExecutionState, error?: string): Promise<void> {
    try {
      await this.#options.onExecutionState?.({ executionKey: channelExecutionKey(message), state, message, ...(error ? { error } : {}) });
    } catch (reportingError) {
      this.#options.onError?.(reportingError, message);
    }
  }

  #admitSender(message: InboundChannelMessage): ChannelAdmissionError | undefined {
    const now = this.#clock();
    const senderKey = [message.address.channel, message.address.accountId, message.sender.id]
      .map(encodeURIComponent)
      .join(":");
    const current = this.#senderWindows.get(senderKey);
    if (current && current.resetAt > now) {
      if (current.count >= this.#options.maximumMessagesPerSenderWindow) {
        return new ChannelAdmissionError("sender", this.#options.maximumMessagesPerSenderWindow);
      }
      current.count += 1;
      return undefined;
    }
    if (current) this.#senderWindows.delete(senderKey);
    if (this.#senderWindows.size >= this.#options.maximumTrackedSenders) {
      for (const [key, window] of this.#senderWindows) {
        if (window.resetAt <= now) this.#senderWindows.delete(key);
      }
    }
    if (this.#senderWindows.size >= this.#options.maximumTrackedSenders) {
      return new ChannelAdmissionError("sender-state", this.#options.maximumTrackedSenders);
    }
    this.#senderWindows.set(senderKey, {
      count: 1,
      resetAt: now + this.#options.senderWindowMs
    });
    return undefined;
  }

  async stop(adapters: ChannelAdapter[]): Promise<void> {
    this.#abort.abort(new Error("channel router stopping"));
    await Promise.allSettled(adapters.map((adapter) => adapter.stop()));
    for (const queue of this.#queues.values()) {
      for (const job of queue) {
        await this.#dedupe.release(job.deliveryKey);
        job.resolve();
      }
    }
    this.#queues.clear();
    this.#queued = 0;
    this.#pendingGlobal = this.#active;
    this.#pendingByConversation.clear();
    await Promise.allSettled([...this.#activeJobs]);
  }
}

export interface SessionBindingStore {
  get(address: ChannelAddress): Promise<string | undefined>;
  set(address: ChannelAddress, sessionId: string): Promise<void>;
}
interface BindingState { schemaVersion: 1; bindings: Record<string, string> }

export class FileSessionBindingStore implements SessionBindingStore {
  readonly #store: SecureJsonFileStore<BindingState>;

  constructor(path: string, { lockTimeoutMs = 30_000 }: { lockTimeoutMs?: number } = {}) {
    this.#store = new SecureJsonFileStore(path, {
      label: "channel binding state",
      create: () => ({ schemaVersion: 1, bindings: {} }),
      validate: validateBindingState,
      lockTimeoutMs
    });
  }

  async get(address: ChannelAddress): Promise<string | undefined> {
    return (await this.#store.read()).bindings[channelConversationKey(address)];
  }

  async set(address: ChannelAddress, sessionId: string): Promise<void> {
    const cleanSessionId = sessionId.trim();
    if (!cleanSessionId) throw new Error("channel session binding requires a session identifier");
    await this.#store.mutate((state) => {
      state.bindings[channelConversationKey(address)] = cleanSessionId;
    });
  }
}

function validateChannelDedupeState(value: unknown): ChannelDedupeFileState {
  if (!isPlainRecord(value) || value.schemaVersion !== 1 || !isPlainRecord(value.entries)) {
    throw new Error("unsupported channel dedupe state");
  }
  const entries: ChannelDedupeFileState["entries"] = {};
  for (const [key, entry] of Object.entries(value.entries)) {
    if (
      !key
      || !isPlainRecord(entry)
      || !["claimed", "committed"].includes(String(entry.state))
      || !Number.isSafeInteger(entry.expiresAt)
      || Number(entry.expiresAt) < 0
    ) {
      throw new Error(`invalid channel dedupe entry: ${key || "<empty>"}`);
    }
    entries[key] = { state: entry.state as "claimed" | "committed", expiresAt: Number(entry.expiresAt) };
  }
  return { schemaVersion: 1, entries };
}

function validateBindingState(value: unknown): BindingState {
  if (!isPlainRecord(value) || value.schemaVersion !== 1 || !isPlainRecord(value.bindings)) {
    throw new Error("unsupported channel binding state");
  }
  const bindings: Record<string, string> = {};
  for (const [key, sessionId] of Object.entries(value.bindings)) {
    if (!key || typeof sessionId !== "string" || !sessionId.trim()) {
      throw new Error(`invalid channel binding entry: ${key || "<empty>"}`);
    }
    bindings[key] = sessionId;
  }
  return { schemaVersion: 1, bindings };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export interface GatewayChannelHandlerOptions {
  baseUrl?: string;
  token: string;
  bindings: SessionBindingStore;
  defaultModel?: string;
  historyLimit?: number;
  pollIntervalMs?: number;
  reconciliationTimeoutMs?: number;
  onExecutionState?: (event: ChannelExecutionStateEvent) => void | Promise<void>;
  fetch?: typeof globalThis.fetch;
}

export class GatewayChannelHandler implements ChannelMessageHandler {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #bindings: SessionBindingStore;
  readonly #defaultModel?: string;
  readonly #historyLimit: number;
  readonly #pollIntervalMs: number;
  readonly #reconciliationTimeoutMs: number;
  readonly #onExecutionState?: GatewayChannelHandlerOptions["onExecutionState"];
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: GatewayChannelHandlerOptions) {
    if (!options.token.trim()) throw new Error("channel gateway handler requires a gateway token");
    let baseUrl = options.baseUrl ?? "http://127.0.0.1:18790";
    while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
    this.#baseUrl = baseUrl;
    this.#token = options.token;
    this.#bindings = options.bindings;
    this.#defaultModel = options.defaultModel;
    this.#historyLimit = Math.max(1, Math.min(options.historyLimit ?? 40, 200));
    this.#pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 250);
    this.#reconciliationTimeoutMs = Math.max(1_000, options.reconciliationTimeoutMs ?? 120_000);
    this.#onExecutionState = options.onExecutionState;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async handle(message: InboundChannelMessage, context: ChannelMessageHandlerContext): Promise<string> {
    let sessionId = await this.#bindings.get(message.address);
    if (!sessionId) {
      const created = await this.#request("/sessions", {
        title: channelSessionTitle(message), tags: ["channel", message.address.channel], source: `channel:${message.address.channel}`
      }, context.signal);
      sessionId = requiredString(created.id, "gateway did not return a session identifier");
      await this.#bindings.set(message.address, sessionId);
    }
    await this.#request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      role: "user",
      content: formatInboundChannelContent(message),
      source: `channel:${message.address.channel}`,
      actor: `channel:${message.address.channel}:${message.sender.id}`,
      externalId: channelExternalMessageId(message, "user")
    }, context.signal);
    const detail = await this.#get(`/sessions/${encodeURIComponent(sessionId)}`, context.signal);
    const messages = Array.isArray(detail.messages)
      ? detail.messages.filter(isChatMessage).slice(-this.#historyLimit).map((entry) => ({ role: entry.role, content: entry.content }))
      : [];
    const runBody = {
      tool: "agent.run",
      input: { sessionId, messages, ...this.#defaultModel ? { model: this.#defaultModel } : {} },
      actor: `channel:${message.address.channel}`
    };
    const executionKey = channelExecutionKey(message);
    const result = await this.#submitAndReconcile(executionKey, runBody, message, context.signal);
    const output = result.output && typeof result.output === "object" ? result.output as Record<string, unknown> : {};
    const reply = requiredString(output.content, "gateway model run returned no assistant content");
    await this.#request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      role: "assistant", content: reply, source: `channel:${message.address.channel}`,
      externalId: channelExternalMessageId(message, "assistant"),
      ...typeof output.model === "string" ? { model: output.model } : {},
      ...typeof output.provider === "string" ? { provider: output.provider } : {}
    }, context.signal);
    return reply;
  }

  async #submitAndReconcile(executionKey: string, task: Record<string, unknown>, message: InboundChannelMessage, signal: AbortSignal): Promise<Record<string, unknown>> {
    const submitted = await this.#request("/jobs", { task, executionKey }, signal, { "idempotency-key": executionKey });
    const job = requiredRecord(submitted.job, "gateway did not return a durable channel run receipt");
    await this.#reportExecutionState({ executionKey, state: submitted.replayed === true ? "reconciled" : "accepted", message });
    return this.#reconcileJob(executionKey, job, message, signal);
  }

  async #reconcileJob(executionKey: string, initial: Record<string, unknown>, message: InboundChannelMessage, signal: AbortSignal): Promise<Record<string, unknown>> {
    const deadline = Date.now() + this.#reconciliationTimeoutMs;
    let job = initial;
    let lastState = "";
    while (true) {
      const status = String(job.status ?? "");
      if (status === "completed") {
        await this.#reportExecutionState({ executionKey, state: "completed", message });
        return requiredRecord(job.result, "gateway completed a channel run without a result");
      }
      if (status === "needs-review") {
        const error = typeof job.error === "string" ? job.error : "gateway lost the channel run outcome during restart";
        await this.#reportExecutionState({ executionKey, state: "uncertain", message, error });
        throw new ChannelRunUncertainError(error);
      }
      if (["failed", "cancelled"].includes(status)) {
        throw new Error(typeof job.error === "string" ? job.error : `gateway channel run ended with ${status || "an unknown status"}`);
      }
      const state = status === "running" ? "running" : undefined;
      if (state && state !== lastState) {
        lastState = state;
        await this.#reportExecutionState({ executionKey, state, message });
      }
      if (Date.now() >= deadline) throw new ChannelRetryableError("gateway channel run reconciliation timed out");
      await delay(this.#pollIntervalMs, signal);
      job = await this.#getJob(executionKey, signal);
    }
  }

  async #reportExecutionState(event: ChannelExecutionStateEvent): Promise<void> {
    try {
      await this.#onExecutionState?.(event);
    } catch (error) {
      throw new ChannelRetryableError(`channel execution audit state could not be recorded: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  async #getJob(executionKey: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const value = await this.#get(`/jobs/${encodeURIComponent(executionKey)}`, signal);
    return requiredRecord(value, "gateway returned an invalid channel run status");
  }

  #get(path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    return this.#call(path, { method: "GET" }, signal);
  }

  #request(path: string, body: Record<string, unknown>, signal: AbortSignal, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
    return this.#call(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, signal);
  }

  async #call(path: string, init: RequestInit, signal: AbortSignal): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${this.#token}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      });
    } catch (error) {
      throw new ChannelRetryableError(`gateway request failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error
      });
    }
    const value = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const message = typeof value.error === "string" ? value.error : `gateway request failed with ${response.status}`;
      if ([408, 425, 429].includes(response.status) || response.status >= 500) {
        throw new ChannelRetryableError(message);
      }
      throw new Error(message);
    }
    return value;
  }

  async #streamRequest(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
    onDelta: (delta: string) => void | Promise<void>
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
          accept: "text/event-stream"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      });
    } catch (error) {
      throw new ChannelRetryableError(`gateway stream failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error
      });
    }
    if (!response.ok || !response.body) {
      const value = await response.json().catch(() => ({})) as Record<string, unknown>;
      const message = typeof value.error === "string" ? value.error : `gateway stream failed with ${response.status}`;
      if ([408, 425, 429].includes(response.status) || response.status >= 500) throw new ChannelRetryableError(message);
      throw new Error(message);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: Record<string, unknown> | undefined;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = /^event:\s*(.+)$/mu.exec(block)?.[1] ?? "message";
        const raw = /^data:\s*(.+)$/mu.exec(block)?.[1] ?? "{}";
        const value = JSON.parse(raw) as Record<string, unknown>;
        if (event === "delta" && typeof value.delta === "string") await onDelta(value.delta);
        if (event === "result") result = value;
        if (event === "error") {
          const error = value.error;
          throw new Error(typeof error === "string" ? error : "gateway stream failed");
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    if (!result) throw new ChannelRetryableError("gateway stream ended without a result");
    return result;
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
  return `${message.address.channel}: ${message.address.conversationKind} ${message.address.threadId ?? message.address.conversationId}`.slice(0, 120);
}
function formatInboundChannelContent(message: InboundChannelMessage): string {
  const context = {
    channel: message.address.channel,
    accountId: message.address.accountId,
    conversationId: message.address.conversationId,
    conversationKind: message.address.conversationKind,
    threadId: message.address.threadId,
    messageId: message.id,
    replyToId: message.replyToId,
    sender: message.sender,
    receivedAt: message.receivedAt,
    attachments: message.attachments,
    metadata: message.metadata
  };
  return `[Untrusted channel context]\n${JSON.stringify(context)}\n[/Untrusted channel context]\n\n${message.text}`;
}
function channelExternalMessageId(message: InboundChannelMessage, role: "user" | "assistant"): string {
  return [
    "channel",
    role,
    message.address.channel,
    message.address.accountId,
    message.id
  ].map(encodeURIComponent).join(":");
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

function requiredRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function isRetryableChannelError(error: unknown): boolean {
  return error instanceof ChannelRetryableError
    || error instanceof ChannelDeliveryError && error.cause instanceof ChannelRetryableError;
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
