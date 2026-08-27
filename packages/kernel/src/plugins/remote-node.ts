import { validatePluginManifest, type PluginManifest } from "../plugin-contracts.ts";
import type { HostCapabilityPlugin, HostCapabilityPluginContext, HostCapabilityTool } from "./host-capability.ts";

const remoteNodeReadManifest = {
  schemaVersion: 1,
  id: "remote-node-read",
  version: "0.1.0",
  kind: "host-capability",
  runtime: "node-host",
  displayName: "Remote node read access",
  activation: { enabledByDefault: false },
  tools: [
    {
      name: "node.status",
      description: "Read bounded status counters from one explicitly allowed authenticated node.",
      capabilities: ["node.read", "network.access", "secret.reference.use"],
      safety: { effects: ["read", "network", "credential"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: false },
      resourceFields: ["configurationDigest", "nodeDigest", "targetDigest"],
      modelVisible: true
    },
    {
      name: "node.diagnostics",
      description: "Read bounded enumerated diagnostics from one explicitly allowed authenticated node.",
      capabilities: ["node.read", "network.access", "secret.reference.use"],
      safety: { effects: ["read", "network", "credential"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: false },
      resourceFields: ["configurationDigest", "nodeDigest", "targetDigest"],
      modelVisible: true
    }
  ]
} as const;

export const REMOTE_NODE_READ_PLUGIN_MANIFEST: PluginManifest = validatePluginManifest(remoteNodeReadManifest);

export const remoteNodeReadHostCapabilityPlugin: HostCapabilityPlugin = {
  manifest: REMOTE_NODE_READ_PLUGIN_MANIFEST,
  createTools: (pluginContext: HostCapabilityPluginContext): ReadonlyMap<string, HostCapabilityTool> => {
    const client = pluginContext.remoteNodeReadClient;
    if (!client) throw new Error("remote node read plugin requires a configured client");
    const inputSchema = {
      type: "object",
      properties: { nodeId: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["nodeId"],
      additionalProperties: false
    } as const;
    return new Map([
      ["node.status", {
        capability: "node.read",
        description: "Read bounded status counters from one explicitly allowed authenticated node.",
        inputSchema,
        resourceForInput: (input: Record<string, unknown>) => client.resourceFor("status", input),
        execute: async (input: Record<string, unknown>, context: Record<string, any> = {}) => client.status(input, context.signal)
      }],
      ["node.diagnostics", {
        capability: "node.read",
        description: "Read bounded enumerated diagnostics from one explicitly allowed authenticated node.",
        inputSchema,
        resourceForInput: (input: Record<string, unknown>) => client.resourceFor("diagnostics", input),
        execute: async (input: Record<string, unknown>, context: Record<string, any> = {}) => client.diagnostics(input, context.signal)
      }]
    ]);
  }
};
