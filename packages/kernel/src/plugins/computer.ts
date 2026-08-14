import { captureComputerScreen } from "../computer.ts";
import { validatePluginManifest, type PluginManifest } from "../plugin-contracts.ts";
import type { HostCapabilityPlugin, HostCapabilityPluginContext, HostCapabilityTool } from "./host-capability.ts";

const computerScreenManifest = {
  schemaVersion: 1,
  id: "computer-screen",
  version: "0.1.0",
  kind: "host-capability",
  runtime: "node-host",
  displayName: "Computer screen",
  activation: { enabledByDefault: false },
  tools: [{
    name: "computer.screen",
    description: "Capture the current frame from an explicitly paired computer display.",
    capabilities: ["computer.read"],
    safety: { effects: ["read", "credential"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: false },
    resourceFields: ["nodeId", "displayId", "pairingGeneration"],
    modelVisible: true
  }]
} as const;

export const COMPUTER_SCREEN_PLUGIN_MANIFEST: PluginManifest = validatePluginManifest(computerScreenManifest);

export const computerScreenHostCapabilityPlugin: HostCapabilityPlugin = {
  manifest: COMPUTER_SCREEN_PLUGIN_MANIFEST,
  createTools: (pluginContext: HostCapabilityPluginContext): ReadonlyMap<string, HostCapabilityTool> => {
    if (!pluginContext.computerScreenProvider) throw new Error("computer screen plugin requires a paired host provider");
    return new Map([
      ["computer.screen", {
        capability: "computer.read",
        description: "Capture the current frame from an explicitly paired computer display.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        resourceForInput: () => {
          const target = pluginContext.computerScreenProvider!.target;
          return { nodeId: target.nodeId, displayId: target.displayId, pairingGeneration: target.pairingGeneration };
        },
        execute: async (_input: unknown, context: Record<string, any> = {}) => captureComputerScreen(pluginContext.computerScreenProvider!, context.signal)
      }]
    ]);
  }
};
