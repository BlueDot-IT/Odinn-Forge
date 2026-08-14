import { browserAction, browserOpen, browserRecoveryResolve, browserRecoveryStatus, browserSnapshot, browserTabs } from "../browser.ts";
import { validatePluginManifest, type PluginManifest } from "../plugin-contracts.ts";
import type { HostCapabilityPlugin, HostCapabilityPluginContext, HostCapabilityTool } from "./host-capability.ts";

const browserManifest = {
  schemaVersion: 1,
  id: "browser-control",
  version: "0.1.0",
  kind: "host-capability",
  runtime: "host-adapter",
  displayName: "Browser control",
  activation: { enabledByDefault: true },
  tools: [
    {
      name: "browser.tabs",
      description: "List tabs in Ódinn Forge's persistent browser profile.",
      capabilities: ["browser.read"],
      safety: { effects: ["read", "network"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: false },
      resourceFields: [],
      modelVisible: true
    },
    {
      name: "browser.open",
      description: "Open a public page in the isolated Forge browser.",
      capabilities: ["browser.read", "network.access"],
      safety: { effects: ["read", "network"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: false },
      resourceFields: ["url", "tabId"],
      modelVisible: true
    },
    {
      name: "browser.snapshot",
      description: "Read the visible page, title, and links from a browser tab.",
      capabilities: ["browser.read"],
      safety: { effects: ["read", "network"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: false },
      resourceFields: ["tabId"],
      modelVisible: true
    },
    {
      name: "browser.click",
      description: "Click a browser control after explicit user approval.",
      capabilities: ["browser.mutate", "network.access"],
      safety: { effects: ["network", "credential", "external-state"], reversibility: "irreversible", requiresCapability: true, requiresApproval: true, retrySafe: false },
      idempotency: "required",
      resourceFields: ["tabId", "snapshotId", "selector", "role", "name", "text"],
      modelVisible: true
    },
    {
      name: "browser.type",
      description: "Fill a browser field after explicit user approval.",
      capabilities: ["browser.mutate", "network.access"],
      safety: { effects: ["network", "credential", "external-state"], reversibility: "irreversible", requiresCapability: true, requiresApproval: true, retrySafe: false },
      idempotency: "required",
      resourceFields: ["tabId", "snapshotId", "selector", "name", "value"],
      modelVisible: true
    },
    {
      name: "browser.press",
      description: "Press a browser key after explicit user approval.",
      capabilities: ["browser.mutate", "network.access"],
      safety: { effects: ["network", "credential", "external-state"], reversibility: "irreversible", requiresCapability: true, requiresApproval: true, retrySafe: false },
      idempotency: "required",
      resourceFields: ["tabId", "snapshotId", "key"],
      modelVisible: true
    },
    {
      name: "browser.recovery.status",
      description: "Inspect unresolved browser mutations after a crash, tab loss, or uncertain action outcome.",
      capabilities: ["browser.read"],
      safety: { effects: ["read", "network"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: false },
      resourceFields: [],
      modelVisible: true
    },
    {
      name: "browser.recovery.resolve",
      description: "Resolve an uncertain browser mutation after operator inspection.",
      capabilities: ["browser.mutate"],
      safety: { effects: ["filesystem-write", "external-state"], reversibility: "compensatable", requiresCapability: true, requiresApproval: false, retrySafe: false },
      idempotency: "required",
      resourceFields: ["outcome"],
      modelVisible: false
    }
  ]
} as const;

export const BROWSER_PLUGIN_MANIFEST: PluginManifest = validatePluginManifest(browserManifest);

function browserActionExecution(input: Record<string, unknown>, context: Record<string, any>, tool: string, pluginContext: HostCapabilityPluginContext) {
  return browserAction(
    pluginContext.stateDir,
    pluginContext.approvalStore,
    tool,
    input,
    context.policy?.security?.browser,
    {
      approvalId: context.trustedApprovalId,
      approvalContinuation: context.trustedApprovalContinuation,
      runId: context.trustedApprovalRunId ?? context.request?.id,
      actor: context.request?.actor,
      signal: context.signal
    }
  );
}

export const browserHostCapabilityPlugin: HostCapabilityPlugin = {
  manifest: BROWSER_PLUGIN_MANIFEST,
  createTools: (pluginContext: HostCapabilityPluginContext): ReadonlyMap<string, HostCapabilityTool> => new Map([
    ["browser.tabs", {
      capability: "browser.read",
      description: "List tabs in Ódinn Forge's persistent browser profile.",
      inputSchema: { type: "object", properties: {} },
      execute: async (_input: unknown, context: Record<string, any> = {}) => browserTabs(pluginContext.stateDir, context.policy?.security?.browser)
    }],
    ["browser.open", {
      capability: "browser.read",
      description: "Open a URL and return its title, URL, visible text, links, and snapshot id. Use browser.snapshot only after the page changes.",
      inputSchema: { type: "object", properties: { url: { type: "string" }, tabId: { type: "string" } }, required: ["url"] },
      execute: async (input: Record<string, unknown>, context: Record<string, any> = {}) => browserOpen(pluginContext.stateDir, input, context.policy?.security?.browser, pluginContext.resolveNetworkAddresses)
    }],
    ["browser.snapshot", {
      capability: "browser.read",
      description: "Read the visible page, title, and links from a browser tab.",
      inputSchema: { type: "object", properties: { tabId: { type: "string" } } },
      execute: async (input: Record<string, unknown>, context: Record<string, any> = {}) => browserSnapshot(pluginContext.stateDir, input, context.policy?.security?.browser)
    }],
    ["browser.click", {
      capability: "browser.act",
      capabilityApprovalContinuation: "browser-policy",
      approvalInputNoopKeys: ["confirmed", "approvalId"],
      description: "Click a browser control after explicit user approval.",
      inputSchema: { type: "object", properties: { tabId: { type: "string" }, snapshotId: { type: "string" }, selector: { type: "string" }, role: { type: "string" }, name: { type: "string" }, text: { type: "string" } } },
      execute: async (input: Record<string, unknown>, context: Record<string, any> = {}) => browserActionExecution(input, context, "browser.click", pluginContext)
    }],
    ["browser.type", {
      capability: "browser.act",
      capabilityApprovalContinuation: "browser-policy",
      approvalInputNoopKeys: ["confirmed", "approvalId"],
      description: "Fill a browser field after explicit user approval.",
      inputSchema: { type: "object", properties: { tabId: { type: "string" }, snapshotId: { type: "string" }, selector: { type: "string" }, name: { type: "string" }, value: { type: "string" }, sensitive: { type: "boolean" } }, required: ["value"] },
      execute: async (input: Record<string, unknown>, context: Record<string, any> = {}) => browserActionExecution(input, context, "browser.type", pluginContext)
    }],
    ["browser.press", {
      capability: "browser.act",
      capabilityApprovalContinuation: "browser-policy",
      approvalInputNoopKeys: ["confirmed", "approvalId"],
      description: "Press a browser key after explicit user approval.",
      inputSchema: { type: "object", properties: { tabId: { type: "string" }, snapshotId: { type: "string" }, key: { type: "string" } }, required: ["key"] },
      execute: async (input: Record<string, unknown>, context: Record<string, any> = {}) => browserActionExecution(input, context, "browser.press", pluginContext)
    }],
    ["browser.recovery.status", {
      capability: "browser.read",
      description: "Inspect unresolved browser mutations after a crash, tab loss, or uncertain action outcome.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => browserRecoveryStatus(pluginContext.stateDir)
    }],
    ["browser.recovery.resolve", {
      capability: "browser.act",
      description: "Resolve an uncertain browser mutation after operator inspection.",
      execute: async (input: Record<string, unknown>) => browserRecoveryResolve(pluginContext.stateDir, input)
    }]
  ])
};
