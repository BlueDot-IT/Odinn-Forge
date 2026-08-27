import { captureComputerScreen, inspectComputerRecovery, normalizeComputerActionInput, performComputerAction, resolveComputerRecovery } from "../computer.ts";
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

const computerControlManifest = {
  schemaVersion: 1,
  id: "computer-control",
  version: "0.1.0",
  kind: "host-capability",
  runtime: "node-host",
  displayName: "Computer control",
  activation: { enabledByDefault: false },
  tools: [
    {
      name: "computer.act",
      description: "Send one approved, bounded input action to the exact paired display frame.",
      capabilities: ["computer.mutate"],
      safety: { effects: ["credential", "external-state"], reversibility: "irreversible", requiresCapability: true, requiresApproval: true, retrySafe: false },
      idempotency: "required",
      resourceFields: ["nodeId", "displayId", "pairingGeneration", "frameId"],
      modelVisible: true
    },
    {
      name: "computer.recovery.status",
      description: "Inspect unresolved paired-computer actions after cancellation, timeout, or transport loss.",
      capabilities: ["computer.read"],
      safety: { effects: ["read"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: true },
      resourceFields: ["nodeId", "displayId", "pairingGeneration"],
      modelVisible: true
    },
    {
      name: "computer.recovery.resolve",
      description: "Resolve an uncertain paired-computer action after operator inspection.",
      capabilities: ["computer.mutate"],
      safety: { effects: ["filesystem-write", "external-state"], reversibility: "compensatable", requiresCapability: true, requiresApproval: false, retrySafe: false },
      idempotency: "required",
      resourceFields: ["nodeId", "displayId", "pairingGeneration", "recoveryId", "outcome"],
      modelVisible: false
    }
  ]
} as const;

export const COMPUTER_CONTROL_PLUGIN_MANIFEST: PluginManifest = validatePluginManifest(computerControlManifest);

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

function providerTarget(pluginContext: HostCapabilityPluginContext) {
  const target = pluginContext.computerControlProvider!.target;
  return { nodeId: target.nodeId, displayId: target.displayId, pairingGeneration: target.pairingGeneration };
}

function exactComputerActionInput(input: unknown): Readonly<Record<string, unknown>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) normalizeComputerActionInput(input);
  const source: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  delete source.confirmed;
  delete source.approvalId;
  normalizeComputerActionInput(source);
  return Object.freeze(source);
}

export const computerControlHostCapabilityPlugin: HostCapabilityPlugin = {
  manifest: COMPUTER_CONTROL_PLUGIN_MANIFEST,
  createTools: (pluginContext: HostCapabilityPluginContext): ReadonlyMap<string, HostCapabilityTool> => {
    if (!pluginContext.computerControlProvider) throw new Error("computer control plugin requires a paired control provider");
    return new Map([
      ["computer.act", {
        capability: "computer.mutate",
        capabilityApprovalContinuation: "required",
        approvalInputNoopKeys: ["confirmed", "approvalId"],
        description: "Send one approved input action to the exact frame returned by computer.screen.",
        inputSchema: {
          type: "object",
          properties: {
            frameId: { type: "string" },
            action: { type: "string", enum: ["click", "type", "key", "move", "scroll", "wait"] },
            x: { type: "integer" }, y: { type: "integer" }, button: { type: "string", enum: ["left", "middle", "right"] },
            text: { type: "string" }, sensitive: { type: "boolean" }, key: { type: "string" },
            deltaX: { type: "integer" }, deltaY: { type: "integer" }, durationMs: { type: "integer" }
          },
          required: ["frameId", "action"],
          additionalProperties: false
        },
        resourceForInput: (input: Record<string, unknown>) => ({ ...providerTarget(pluginContext), frameId: input.frameId }),
        execute: async (input: unknown, context: Record<string, any> = {}) => {
          if (context.durableExecution !== true) {
            throw new Error("computer.act direct execution remains refused; paired-computer mutations are available only through the durable /jobs execution surface");
          }
          const exactInput = exactComputerActionInput(input);
          if (!context.trustedApprovalId) {
            const summary = "Send one approved input action to the exact paired computer frame";
            const approvalId = pluginContext.approvalStore.create({
              type: "approval.required",
              tool: "computer.act",
              runId: context.request?.id,
              actor: context.request?.actor,
              summary,
              input: exactInput,
              executionInput: exactInput
            }, { signal: context.signal });
            return { type: "approval.required", approvalId, tool: "computer.act", summary, expiresInSeconds: 300 };
          }
          const authorized = context.trustedApprovalContinuation ?? pluginContext.approvalStore.consume(context.trustedApprovalId, {
            tool: "computer.act",
            runId: context.trustedApprovalRunId ?? context.request?.id,
            actor: context.request?.actor,
            input: exactInput
          }, { signal: context.signal });
          if (!authorized) throw new Error("computer action approval is missing, expired, already used, or does not match this exact frame action");
          return performComputerAction(pluginContext.computerControlProvider!, authorized.input ?? exactInput, context.signal);
        }
      }],
      ["computer.recovery.status", {
        capability: "computer.read",
        description: "Inspect an unresolved paired-computer action.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        resourceForInput: () => providerTarget(pluginContext),
        execute: async () => inspectComputerRecovery(pluginContext.computerControlProvider!)
      }],
      ["computer.recovery.resolve", {
        capability: "computer.mutate",
        description: "Resolve an uncertain paired-computer action after operator inspection.",
        inputSchema: {
          type: "object",
          properties: {
            recoveryId: { type: "string" },
            outcome: { type: "string", enum: ["confirmed-applied", "confirmed-not-applied"] }
          },
          required: ["recoveryId", "outcome"],
          additionalProperties: false
        },
        resourceForInput: (input: Record<string, unknown>) => ({ ...providerTarget(pluginContext), recoveryId: input.recoveryId, outcome: input.outcome }),
        execute: async (input: unknown, context: Record<string, any> = {}) => resolveComputerRecovery(pluginContext.computerControlProvider!, input, context.signal)
      }]
    ]);
  }
};
