import type { ChannelAgentToolApprovalBinding, ChannelAgentToolDefinitions } from "@odinn/channels";
import { approvalRequirementForTool, capabilitiesForTool, legacyCapabilitiesForTool } from "@odinn/policy";
import type { ApprovalStore } from "./approvals.ts";

type ToolRegistry = Map<string, Record<string, unknown>>;

function validatedBinding(value: ChannelAgentToolApprovalBinding, toolName: string): ChannelAgentToolApprovalBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`channel tool ${toolName} returned an invalid approval binding`);
  }
  if (!value.input || typeof value.input !== "object" || Array.isArray(value.input)) {
    throw new Error(`channel tool ${toolName} approval binding requires an input object`);
  }
  if (typeof value.summary !== "string" || !value.summary.trim()) {
    throw new Error(`channel tool ${toolName} approval binding requires a summary`);
  }
  if (value.accountId !== undefined && (typeof value.accountId !== "string" || !value.accountId.trim())) {
    throw new Error(`channel tool ${toolName} approval binding has an invalid accountId`);
  }
  return value;
}

export function registerChannelAgentTools(
  registry: ToolRegistry,
  definitions: ChannelAgentToolDefinitions,
  approvalStore: ApprovalStore,
): void {
  for (const [name, definition] of definitions) {
    if (!name.trim()) throw new Error("channel agent tool requires a name");
    if (registry.has(name)) throw new Error(`channel agent tool conflicts with an existing tool: ${name}`);
    const requiresApproval = approvalRequirementForTool(name);
    if (requiresApproval === undefined) {
      throw new Error(`channel agent tool has no trusted approval policy: ${name}`);
    }
    if (requiresApproval !== Boolean(definition.approvalBinding)) {
      throw new Error(`channel agent tool approval declaration does not match trusted safety policy: ${name}`);
    }
    const legacyCapability = legacyCapabilitiesForTool(name)[0] ?? capabilitiesForTool(name)[0];
    registry.set(name, {
      capability: legacyCapability,
      description: definition.description,
      inputSchema: definition.inputSchema,
      resourceForInput: (input: Record<string, unknown>) => definition.resourceBinding(input),
      execute: async (rawInput: Record<string, unknown>, context: Record<string, any> = {}) => {
        if (context.signal?.aborted) {
          throw context.signal.reason instanceof Error ? context.signal.reason : new Error("channel agent tool aborted");
        }
        let input = rawInput;
        if (definition.approvalBinding) {
          const binding = validatedBinding(definition.approvalBinding(rawInput), name);
          input = binding.input;
          if (!context.trustedApprovalId) {
            const approvalId = approvalStore.create({
              type: "approval.required",
              tool: name,
              runId: context.request?.id,
              accountId: binding.accountId,
              summary: binding.summary,
              input,
            });
            return {
              type: "approval.required",
              approvalId,
              tool: name,
              summary: binding.summary,
              expiresInSeconds: 300,
            };
          }
          const approved = approvalStore.consume(context.trustedApprovalId, {
            tool: name,
            runId: context.trustedApprovalRunId ?? context.request?.id,
            accountId: binding.accountId,
            input,
          });
          if (!approved) {
            throw new Error(definition.approvalFailureMessage
              ?? "Channel action approval is missing, expired, already used, or does not match this action");
          }
          const approvedInput = approved.input;
          if (!approvedInput || typeof approvedInput !== "object" || Array.isArray(approvedInput)) {
            throw new Error(`channel tool ${name} approval did not recover exact execution input`);
          }
          input = {
            ...approvedInput,
            ...(typeof approved.accountId === "string" && approved.accountId
              ? { accountId: approved.accountId }
              : {}),
          };
        }
        if (context.signal?.aborted) {
          throw context.signal.reason instanceof Error ? context.signal.reason : new Error("channel agent tool aborted");
        }
        return definition.invoke(input);
      },
    });
  }
}
