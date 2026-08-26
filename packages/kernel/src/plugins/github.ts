import { validatePluginManifest, type PluginManifest } from "../plugin-contracts.ts";
import type { HostCapabilityPlugin, HostCapabilityPluginContext, HostCapabilityTool } from "./host-capability.ts";

const githubReadManifest = {
  schemaVersion: 1,
  id: "github-read",
  version: "0.1.0",
  kind: "host-capability",
  runtime: "host-adapter",
  displayName: "GitHub read access",
  activation: { enabledByDefault: false },
  tools: [
    {
      name: "github.repository",
      description: "Read bounded metadata for one explicitly allowed GitHub repository.",
      capabilities: ["github.read", "network.access", "secret.reference.use"],
      safety: { effects: ["read", "network", "credential"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: true },
      resourceFields: ["configurationDigest", "repositoryDigest", "targetDigest"],
      modelVisible: true
    },
    {
      name: "github.issue",
      description: "Read one bounded issue from one explicitly allowed GitHub repository.",
      capabilities: ["github.read", "network.access", "secret.reference.use"],
      safety: { effects: ["read", "network", "credential"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: true },
      resourceFields: ["configurationDigest", "repositoryDigest", "targetDigest"],
      modelVisible: true
    },
    {
      name: "github.pull-request",
      description: "Read one bounded pull request from one explicitly allowed GitHub repository.",
      capabilities: ["github.read", "network.access", "secret.reference.use"],
      safety: { effects: ["read", "network", "credential"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: true },
      resourceFields: ["configurationDigest", "repositoryDigest", "targetDigest"],
      modelVisible: true
    },
    {
      name: "github.checks",
      description: "Read bounded check-run metadata for one exact commit in an explicitly allowed GitHub repository.",
      capabilities: ["github.read", "network.access", "secret.reference.use"],
      safety: { effects: ["read", "network", "credential"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: true },
      resourceFields: ["configurationDigest", "repositoryDigest", "targetDigest"],
      modelVisible: true
    }
  ]
} as const;

export const GITHUB_READ_PLUGIN_MANIFEST: PluginManifest = validatePluginManifest(githubReadManifest);

export const githubReadHostCapabilityPlugin: HostCapabilityPlugin = {
  manifest: GITHUB_READ_PLUGIN_MANIFEST,
  createTools: (pluginContext: HostCapabilityPluginContext): ReadonlyMap<string, HostCapabilityTool> => {
    const client = pluginContext.githubReadClient;
    if (!client) throw new Error("GitHub read plugin requires a configured client");
    const repositorySchema = { type: "string", minLength: 3, maxLength: 140 } as const;
    return new Map([
      ["github.repository", {
        capability: "github.read",
        description: "Read bounded metadata for one explicitly allowed GitHub repository.",
        inputSchema: {
          type: "object",
          properties: { repository: repositorySchema },
          required: ["repository"],
          additionalProperties: false
        },
        resourceForInput: (input: Record<string, unknown>) => client.resourceFor("repository", input),
        execute: async (input: Record<string, unknown>, context: Record<string, any> = {}) => client.repository(input, context.signal)
      }],
      ["github.issue", {
        capability: "github.read",
        description: "Read one bounded issue from one explicitly allowed GitHub repository.",
        inputSchema: {
          type: "object",
          properties: {
            repository: repositorySchema,
            issueNumber: { type: "integer", minimum: 1, maximum: 2_147_483_647 }
          },
          required: ["repository", "issueNumber"],
          additionalProperties: false
        },
        resourceForInput: (input: Record<string, unknown>) => client.resourceFor("issue", input),
        execute: async (input: Record<string, unknown>, context: Record<string, any> = {}) => client.issue(input, context.signal)
      }],
      ["github.pull-request", {
        capability: "github.read",
        description: "Read one bounded pull request from one explicitly allowed GitHub repository.",
        inputSchema: {
          type: "object",
          properties: {
            repository: repositorySchema,
            pullNumber: { type: "integer", minimum: 1, maximum: 2_147_483_647 }
          },
          required: ["repository", "pullNumber"],
          additionalProperties: false
        },
        resourceForInput: (input: Record<string, unknown>) => client.resourceFor("pull-request", input),
        execute: async (input: Record<string, unknown>, context: Record<string, any> = {}) => client.pullRequest(input, context.signal)
      }],
      ["github.checks", {
        capability: "github.read",
        description: "Read bounded check-run metadata for one exact commit in an explicitly allowed GitHub repository.",
        inputSchema: {
          type: "object",
          properties: {
            repository: repositorySchema,
            ref: { type: "string", minLength: 40, maxLength: 64, pattern: "^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$" },
            limit: { type: "integer", minimum: 1, maximum: 100 }
          },
          required: ["repository", "ref"],
          additionalProperties: false
        },
        resourceForInput: (input: Record<string, unknown>) => client.resourceFor("checks", input),
        execute: async (input: Record<string, unknown>, context: Record<string, any> = {}) => client.checks(input, context.signal)
      }]
    ]);
  }
};
