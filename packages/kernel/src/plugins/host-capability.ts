import type { ApprovalStore } from "../approvals.ts";
import { capabilitiesForTool } from "@odinn/policy";
import type { ComputerScreenProvider } from "../computer.ts";
import type { EmailReadProvider } from "../email.ts";
import type { GitHubReadClient } from "../github.ts";
import { validatePluginManifest, type PluginManifest } from "../plugin-contracts.ts";
import { toolSafetyDescriptor } from "../tool-safety.ts";

export type HostCapabilityTool = Record<string, unknown> & {
  execute: (input: any, context?: any) => any;
  resourceForInput?: (input: Record<string, unknown>) => Readonly<Record<string, unknown>>;
};

export interface HostCapabilityPluginContext {
  readonly stateDir: string;
  readonly approvalStore: ApprovalStore;
  readonly resolveNetworkAddresses?: (...args: any[]) => any;
  readonly computerScreenProvider?: ComputerScreenProvider;
  readonly emailReadProvider?: EmailReadProvider;
  readonly githubReadClient?: GitHubReadClient;
}

export interface HostCapabilityPlugin {
  readonly manifest: PluginManifest;
  createTools(context: HostCapabilityPluginContext): ReadonlyMap<string, HostCapabilityTool>;
}

function validatedPlugin(plugin: HostCapabilityPlugin): PluginManifest {
  if (!plugin || typeof plugin.createTools !== "function") throw new Error("host capability plugin requires a tool factory");
  const manifest = validatePluginManifest(plugin.manifest);
  if (manifest.kind !== "host-capability" || !["host-adapter", "node-host"].includes(manifest.runtime)) {
    throw new Error(`host capability plugin ${manifest.id} must use the host-adapter or node-host runtime`);
  }
  for (const tool of manifest.tools) {
    const trustedCapabilities = capabilitiesForTool(tool.name);
    if (trustedCapabilities.length !== tool.capabilities.length || trustedCapabilities.some((capability) => !tool.capabilities.includes(capability))) {
      throw new Error(`host capability plugin ${manifest.id} capability declaration does not match trusted policy: ${tool.name}`);
    }
    const trustedSafety = toolSafetyDescriptor(tool.name, {});
    if (trustedSafety.requiresApproval !== tool.safety.requiresApproval
      || trustedSafety.retrySafe !== tool.safety.retrySafe
      || trustedSafety.reversibility !== tool.safety.reversibility
      || trustedSafety.effects.length !== tool.safety.effects.length
      || trustedSafety.effects.some((effect) => !tool.safety.effects.includes(effect))) {
      throw new Error(`host capability plugin ${manifest.id} safety declaration does not match trusted policy: ${tool.name}`);
    }
  }
  return manifest;
}

const RESERVED_RESOURCE_FIELDS = new Set(["__proto__", "constructor", "prototype"]);

function bindDeclaredResource(
  pluginId: string,
  toolName: string,
  resourceFields: readonly string[],
  definition: HostCapabilityTool
): HostCapabilityTool {
  if (typeof definition.resourceForInput !== "function") return definition;
  if (resourceFields.some((field) => RESERVED_RESOURCE_FIELDS.has(field))) {
    throw new Error(`host capability plugin ${pluginId} declares a reserved resource field: ${toolName}`);
  }
  const allowedFields = new Set(resourceFields);
  const resourceForInput = definition.resourceForInput;
  return {
    ...definition,
    resourceForInput: (input: Record<string, unknown>) => {
      const resource = resourceForInput(input);
      if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
        throw new Error(`host capability plugin ${pluginId} resource binding returned an invalid value: ${toolName}`);
      }
      const prototype = Object.getPrototypeOf(resource);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`host capability plugin ${pluginId} resource binding returned a non-plain value: ${toolName}`);
      }
      const projected: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(resource)) {
        if (typeof key !== "string" || !allowedFields.has(key)) {
          throw new Error(`host capability plugin ${pluginId} resource binding returned an undeclared field: ${toolName}.${String(key)}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(resource, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new Error(`host capability plugin ${pluginId} resource binding returned an accessor: ${toolName}.${key}`);
        }
        Object.defineProperty(projected, key, {
          configurable: false,
          enumerable: true,
          value: descriptor.value,
          writable: false
        });
      }
      return Object.freeze(projected);
    }
  };
}

export function materializeHostCapabilityPlugin(
  plugin: HostCapabilityPlugin,
  context: HostCapabilityPluginContext
): ReadonlyMap<string, HostCapabilityTool> {
  const manifest = validatedPlugin(plugin);
  const definitions = plugin.createTools(context);
  if (!definitions || typeof definitions !== "object" || typeof definitions.entries !== "function" || typeof (definitions as any)[Symbol.iterator] !== "function") {
    throw new Error(`host capability plugin ${manifest.id} returned an invalid tool map`);
  }
  const declared = new Set(manifest.tools.map((tool) => tool.name));
  const materialized = new Map<string, HostCapabilityTool>();
  for (const [name, definition] of definitions) {
    if (!declared.has(name)) throw new Error(`host capability plugin ${manifest.id} materialized undeclared tool: ${name}`);
    if (!definition || typeof definition !== "object" || typeof definition.execute !== "function") {
      throw new Error(`host capability plugin ${manifest.id} materialized an invalid tool: ${name}`);
    }
    if (materialized.has(name)) throw new Error(`host capability plugin ${manifest.id} materialized duplicate tool: ${name}`);
    const contract = manifest.tools.find((tool) => tool.name === name)!;
    const bound = bindDeclaredResource(manifest.id, name, contract.resourceFields, definition);
    materialized.set(name, contract.modelVisible ? bound : { ...bound, modelVisible: false });
  }
  const missing = manifest.tools.map((tool) => tool.name).filter((name) => !materialized.has(name));
  if (missing.length) throw new Error(`host capability plugin ${manifest.id} did not materialize declared tools: ${missing.join(", ")}`);
  return materialized;
}

export function registerHostCapabilityPlugin(
  registry: Map<string, Record<string, unknown>>,
  plugin: HostCapabilityPlugin,
  context: HostCapabilityPluginContext
): void {
  const materialized = materializeHostCapabilityPlugin(plugin, context);
  for (const [name, definition] of materialized) {
    if (registry.has(name)) throw new Error(`host capability plugin cannot replace an existing tool: ${name}`);
    registry.set(name, definition);
  }
}
