import { durableEmailProviderIdentifier } from "@odinn/protocol";
import { listEmailAccounts, readEmail, searchEmail, threadEmail } from "../email.ts";
import { validatePluginManifest, type PluginManifest } from "../plugin-contracts.ts";
import type { HostCapabilityPlugin, HostCapabilityPluginContext, HostCapabilityTool } from "./host-capability.ts";

const emailReadManifest = {
  schemaVersion: 1,
  id: "email-read",
  version: "0.1.0",
  kind: "host-capability",
  runtime: "host-adapter",
  displayName: "Email read access",
  activation: { enabledByDefault: false },
  tools: [
    {
      name: "email.accounts",
      description: "List configured email accounts and bounded provider health metadata.",
      capabilities: ["email.read", "network.access"],
      safety: { effects: ["read", "network", "credential"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: false },
      resourceFields: ["providerId", "generation"],
      modelVisible: true
    },
    {
      name: "email.search",
      description: "Search messages in one explicitly selected email account.",
      capabilities: ["email.read", "network.access"],
      safety: { effects: ["read", "network", "credential"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: false },
      resourceFields: ["providerId", "generation", "accountId"],
      modelVisible: true
    },
    {
      name: "email.read",
      description: "Read one message from one explicitly selected email account.",
      capabilities: ["email.read", "network.access"],
      safety: { effects: ["read", "network", "credential"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: false },
      resourceFields: ["providerId", "generation", "accountId"],
      modelVisible: true
    },
    {
      name: "email.thread",
      description: "Read a bounded message thread from one explicitly selected email account.",
      capabilities: ["email.read", "network.access"],
      safety: { effects: ["read", "network", "credential"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: false },
      resourceFields: ["providerId", "generation", "accountId"],
      modelVisible: true
    }
  ]
} as const;

export const EMAIL_READ_PLUGIN_MANIFEST: PluginManifest = validatePluginManifest(emailReadManifest);

export const emailReadHostCapabilityPlugin: HostCapabilityPlugin = {
  manifest: EMAIL_READ_PLUGIN_MANIFEST,
  createTools: (pluginContext: HostCapabilityPluginContext): ReadonlyMap<string, HostCapabilityTool> => {
    if (!pluginContext.emailReadProvider) throw new Error("email read plugin requires a configured provider");
    const resourceForProvider = () => {
      const target = pluginContext.emailReadProvider!.target;
      return {
        providerId: durableEmailProviderIdentifier(target.providerId, "email provider target.providerId", 128),
        generation: durableEmailProviderIdentifier(target.generation, "email provider target.generation", 128)
      };
    };
    const resourceForAccount = (input: Record<string, unknown>) => {
      if (typeof input.accountId !== "string" || input.accountId.length === 0 || input.accountId.length > 256) throw new Error("email accountId is required for resource binding");
      return {
        ...resourceForProvider(),
        accountId: durableEmailProviderIdentifier(input.accountId, "email resource accountId")
      };
    };
    return new Map([
      ["email.accounts", {
        capability: "email.read",
        description: "List configured email accounts and bounded provider health metadata.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        resourceForInput: resourceForProvider,
        execute: async (_input: unknown, context: Record<string, any> = {}) => listEmailAccounts(pluginContext.emailReadProvider!, context.signal)
      }],
      ["email.search", {
        capability: "email.read",
        description: "Search messages in one explicitly selected email account.",
        inputSchema: {
          type: "object",
          properties: {
            accountId: { type: "string", minLength: 1, maxLength: 256 },
            query: { type: "string", minLength: 1, maxLength: 2_048 },
            limit: { type: "integer", minimum: 1, maximum: 100 },
            cursor: { type: "string", minLength: 1, maxLength: 4_096 }
          },
          required: ["accountId", "query"],
          additionalProperties: false
        },
        resourceForInput: resourceForAccount,
        execute: async (input: Record<string, unknown>, context: Record<string, any> = {}) => searchEmail(pluginContext.emailReadProvider!, input, context.signal)
      }],
      ["email.read", {
        capability: "email.read",
        description: "Read one message from one explicitly selected email account.",
        inputSchema: {
          type: "object",
          properties: {
            accountId: { type: "string", minLength: 1, maxLength: 256 },
            messageId: { type: "string", minLength: 1, maxLength: 256 }
          },
          required: ["accountId", "messageId"],
          additionalProperties: false
        },
        resourceForInput: resourceForAccount,
        execute: async (input: Record<string, unknown>, context: Record<string, any> = {}) => readEmail(pluginContext.emailReadProvider!, input, context.signal)
      }],
      ["email.thread", {
        capability: "email.read",
        description: "Read a bounded message thread from one explicitly selected email account.",
        inputSchema: {
          type: "object",
          properties: {
            accountId: { type: "string", minLength: 1, maxLength: 256 },
            threadId: { type: "string", minLength: 1, maxLength: 256 },
            limit: { type: "integer", minimum: 1, maximum: 100 }
          },
          required: ["accountId", "threadId"],
          additionalProperties: false
        },
        resourceForInput: resourceForAccount,
        execute: async (input: Record<string, unknown>, context: Record<string, any> = {}) => threadEmail(pluginContext.emailReadProvider!, input, context.signal)
      }]
    ]);
  }
};
