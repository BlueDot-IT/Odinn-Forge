import { basename } from "node:path";
import { validatePluginManifest, type PluginManifest, type PluginServiceBindings } from "@odinn/plugin-sdk";
import { ExtensionRegistry, extensionIdentityFingerprint, type ExtensionManifest } from "./extensions.ts";

/** Package metadata is subordinate to the executable extension record, never a second authority store. */
export type InstalledPluginMetadata = {
  schemaVersion: 1;
  manifest: PluginManifest;
  packageDigest: string;
  contentDigest: string;
  fileDigests: Readonly<Record<string, string>>;
  packageRoot: string;
  serviceBindings: PluginServiceBindings;
};

export type PluginRecord = {
  manifest: PluginManifest;
  extensionId: string;
  packageDigest: string;
  contentDigest: string;
  packageRoot: string;
  installedAt: string;
  enabled: boolean;
  reviewed: boolean;
  grants: string[];
  requestedCapabilities: string[];
  status: "disabled" | "enabled" | "needs-review";
  identityFingerprint: string;
  serviceBindings: PluginServiceBindings;
};

export function installedPluginMetadata(extension: ExtensionManifest): InstalledPluginMetadata {
  const raw = extension.permissions.plugin;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("installed extension is not a managed plugin package");
  const metadata = raw as InstalledPluginMetadata;
  const manifest = validatePluginManifest(metadata.manifest);
  if (metadata.schemaVersion !== 1 || manifest.id !== extension.id || manifest.version !== extension.version
      || !/^[a-f0-9]{64}$/u.test(metadata.packageDigest) || !/^[a-f0-9]{64}$/u.test(metadata.contentDigest)
      || typeof metadata.packageRoot !== "string" || !metadata.packageRoot
      || !metadata.fileDigests || typeof metadata.fileDigests !== "object" || Array.isArray(metadata.fileDigests)
      || !metadata.serviceBindings || typeof metadata.serviceBindings !== "object" || Array.isArray(metadata.serviceBindings)) {
    throw new Error("installed plugin package metadata is invalid; reinstall the verified package");
  }
  return { ...metadata, manifest };
}

export function pluginRecordFromExtension(extension: ExtensionManifest): PluginRecord {
  const plugin = installedPluginMetadata(extension);
  return {
    manifest: plugin.manifest, extensionId: extension.id, packageDigest: plugin.packageDigest,
    contentDigest: plugin.contentDigest, packageRoot: plugin.packageRoot, installedAt: extension.installedAt ?? "",
    enabled: extension.enabled === true, reviewed: extension.trusted === true,
    grants: [...(extension.grants ?? [])], requestedCapabilities: [...extension.capabilities],
    status: extension.enabled && extension.trusted ? "enabled" : extension.trusted ? "disabled" : "needs-review",
    identityFingerprint: extensionIdentityFingerprint(extension), serviceBindings: structuredClone(plugin.serviceBindings)
  };
}

/** Read-only projection. All application mutations belong to PluginLifecycleService. */
export class PluginRegistry {
  readonly extensions: ExtensionRegistry;
  readonly path: string;
  constructor(registry: ExtensionRegistry | string) {
    if (typeof registry === "string" && basename(registry) === "plugins.json") throw new Error("plugins.json is not an authority store; use the existing extensions.json registry");
    this.extensions = typeof registry === "string" ? new ExtensionRegistry(registry) : registry;
    this.path = this.extensions.path;
  }
  async list(): Promise<PluginRecord[]> {
    return (await this.extensions.list()).filter((extension) => extension.permissions?.plugin !== undefined).map(pluginRecordFromExtension);
  }
  async get(id: string): Promise<PluginRecord | undefined> {
    const extension = await this.extensions.get(id);
    return extension?.permissions?.plugin !== undefined ? pluginRecordFromExtension(extension) : undefined;
  }
}
