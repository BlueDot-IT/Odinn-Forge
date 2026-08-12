import type {
  ChannelAccessPolicy,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelStatus
} from "./index.ts";

export interface ChannelAccountConfig {
  enabled: boolean;
  tokenEnv: string;
  credentialEnvs?: Record<string, string>;
  allowlist: string[];
  defaultModel?: string;
  historyLimit?: number;
}

export interface ChannelPluginAccountContext<Config extends ChannelAccountConfig> {
  accountId: string;
  config: Config;
  credential: string;
  credentials: Record<string, string>;
  onError(error: unknown): void;
}

export interface ChannelPlugin<Config extends ChannelAccountConfig = ChannelAccountConfig> {
  id: string;
  displayName: string;
  capabilities: ChannelCapabilities;
  normalizeAccountConfig(accountId: string, value: unknown): Config;
  validateAccountConfig(accountId: string, config: Config): string[];
  createAdapter(context: ChannelPluginAccountContext<Config>): ChannelAdapter;
  createAccessPolicy?(config: Config): ChannelAccessPolicy;
  webhookPath?(accountId: string, config: Config): string;
  webhookRequestMode?: "buffer" | "raw-stream";
}

/**
 * Transport-owned definition for an agent-visible channel tool. The kernel is
 * responsible for turning these definitions into governed runtime tools; an
 * adapter only describes the external operation and how to invoke it.
 */
export interface ChannelAgentToolApprovalBinding {
  accountId?: string;
  input: Record<string, unknown>;
  summary: string;
}

export interface ChannelAgentToolDefinition {
  description: string;
  inputSchema?: Record<string, unknown>;
  /**
   * Runs before resource-scoped capability admission. It must be deterministic,
   * side-effect free, and credential free, and may return only identifiers the
   * selected external operation actually consumes as authority-bearing targets.
   */
  resourceBinding(input: Record<string, unknown>): Record<string, unknown>;
  approvalBinding?(input: Record<string, unknown>): ChannelAgentToolApprovalBinding;
  approvalFailureMessage?: string;
  invoke(input: Record<string, unknown>): Promise<unknown>;
}

export type ChannelAgentToolDefinitions = ReadonlyMap<string, ChannelAgentToolDefinition>;

export interface ChannelAccountSnapshot {
  name: string;
  type: string;
  enabled: boolean;
  credentialConfigured: boolean;
  credentialPresent: boolean;
  allowlistEntries: number;
  status: ChannelStatus;
}

export class ChannelPluginRegistry {
  readonly #plugins = new Map<string, ChannelPlugin<any>>();

  constructor(plugins: ChannelPlugin<any>[] = []) {
    for (const plugin of plugins) this.register(plugin);
  }

  register(plugin: ChannelPlugin<any>): void {
    if (!plugin.id.trim()) throw new Error("channel plugin requires an identifier");
    if (this.#plugins.has(plugin.id)) throw new Error(`channel plugin is already registered: ${plugin.id}`);
    this.#plugins.set(plugin.id, plugin);
  }

  get(id: string): ChannelPlugin<any> {
    const plugin = this.#plugins.get(id);
    if (!plugin) throw new Error(`unsupported channel plugin: ${id}`);
    return plugin;
  }

  list(): ChannelPlugin<any>[] {
    return [...this.#plugins.values()];
  }
}
