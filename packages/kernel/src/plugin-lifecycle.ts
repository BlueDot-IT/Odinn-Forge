import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { assertCapabilityIds } from "@odinn/policy";
import { type PluginManifest, type PluginServiceBindings } from "@odinn/plugin-sdk";
import type { JsonObject } from "@odinn/protocol";
import { ExtensionRegistry, digestExtensionBundle, extensionIdentityFingerprint, resolveConfiguredOciBackend, validateOciImageReference, type ExtensionManifest, type ExtensionMutationOptions } from "./extensions.ts";
import { extractPluginPackageArchive, inspectPluginPackageArchive, verifyPluginPackageDirectory, type PluginPackageInspection } from "./plugin-packages.ts";
import { PluginRegistry, installedPluginMetadata, pluginRecordFromExtension, type InstalledPluginMetadata, type PluginRecord } from "./plugin-registry.ts";
import { normalizeSandboxConfig, type SandboxConfigInput } from "./sandbox-config.ts";

const execFile = promisify(execFileCallback);
const SHA256 = /^[a-f0-9]{64}$/u;
const PLUGIN_CAPABILITIES = new Set(["mcp.discover", "mcp.invoke", "network.access", "secret.reference.use"]);

export type PluginLifecycleContext = { actor?: string; signal?: AbortSignal };
export type PluginMutationOptions = PluginLifecycleContext & { expectedIdentityFingerprint?: string | null };
export type PluginInstallOptions = PluginMutationOptions & { expectedDigest?: string };
export type PluginLifecycleTransition = {
  id: string;
  action: "configure" | "review" | "grant" | "enable" | "disable" | "rollback" | "remove";
  expectedIdentityFingerprint?: string;
  serviceBindings?: PluginServiceBindings;
  grants?: string[];
  trust?: boolean;
};
export type PluginRuntimeReadiness = { ok: boolean; imageAvailable: boolean; detail: string };
export type PluginDoctorCheck = { code: string; ok: boolean; detail: string; remediation?: string };
export type PluginDoctorReport = { id: string; ok: boolean; ready: boolean; identityFingerprint: string; checks: PluginDoctorCheck[] };
export type PluginLifecycleOptions = {
  workspaceRoot: string;
  stateDir: string;
  registry?: ExtensionRegistry;
  auditStore?: { append(event: JsonObject): Promise<unknown> };
  config?: SandboxConfigInput;
  onInvalidate?: (id: string, reason: string) => void | Promise<void>;
  credentialAvailable?: (reference: string) => boolean | Promise<boolean>;
  probeRuntime?: (image: string, config: SandboxConfigInput) => Promise<PluginRuntimeReadiness>;
};

export class PluginLifecycleError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "PluginLifecycleError";
    this.code = code;
    this.status = status;
  }
}

/** One audited lifecycle for CLI and console, backed exclusively by ExtensionRegistry. */
export class PluginLifecycleService {
  readonly registry: ExtensionRegistry;
  readonly plugins: PluginRegistry;
  readonly workspaceRoot: string;
  readonly stateDir: string;
  private readonly options: PluginLifecycleOptions;

  constructor(options: PluginLifecycleOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.stateDir = resolve(options.stateDir);
    this.options = options;
    this.registry = options.registry ?? new ExtensionRegistry(join(this.stateDir, "extensions.json"));
    this.plugins = new PluginRegistry(this.registry);
  }

  list() { return this.plugins.list(); }
  get(id: string) { return this.plugins.get(id); }
  inspect(archivePath: string, expectedDigest?: string): Promise<PluginPackageInspection> { return inspectPluginPackageArchive(archivePath, expectedDigest); }

  async install(input: string | ({ archivePath: string } & PluginInstallOptions), context: PluginInstallOptions = {}): Promise<PluginRecord> {
    const options = typeof input === "string" ? context : { ...input, ...context };
    const archivePath = typeof input === "string" ? input : input.archivePath;
    this.assertWritable(options);
    const inspected = await this.inspect(archivePath, options.expectedDigest);
    const capabilities = pluginCapabilities(inspected.manifest);
    const expected = options.expectedIdentityFingerprint ?? null;
    if (expected !== null) requiredIdentity({ ...options, expectedIdentityFingerprint: expected });
    const current = await this.registry.get(inspected.manifest.id);
    if ((current ? extensionIdentityFingerprint(current) : null) !== expected) throw staleIdentity();
    if (current && current.permissions?.plugin === undefined) throw new PluginLifecycleError("PLUGIN_ID_COLLISION", "plugin id is already used by a non-plugin extension", 409);
    const managedParent = await this.preparePackageParent(inspected.manifest.id);
    throwIfAborted(options.signal);
    const destination = join(managedParent, `${inspected.digest}-${randomUUID()}`);
    const extracted = await extractPluginPackageArchive(archivePath, destination, inspected.digest);
    throwIfAborted(options.signal);
    const packageRoot = await realpath(extracted.root);
    await this.assertManagedPackageRoot(packageRoot);
    const bundleDigest = await digestExtensionBundle(packageRoot);
    const metadata: InstalledPluginMetadata = {
      schemaVersion: 1,
      manifest: extracted.manifest,
      packageDigest: extracted.digest,
      contentDigest: extracted.contentDigest,
      fileDigests: extracted.fileDigests,
      packageRoot,
      serviceBindings: normalizeServiceBindings(extracted.manifest, {})
    };
    const installed = await this.registry.install({
      id: extracted.manifest.id, version: extracted.manifest.version, name: extracted.manifest.name,
      type: "mcp", sandbox: "container", entrypoint: join(packageRoot, extracted.manifest.entrypoint),
      bundleRoot: packageRoot, bundleDigest, containerImage: extracted.manifest.containerImage,
      capabilities, permissions: { plugin: metadata }
    }, {
      source: "verified-plugin-package", provenance: "operator-supplied; publisher identity unverified",
      ...this.mutationOptions(current ? "update" : "install", extracted.manifest.id, { ...options, expectedIdentityFingerprint: expected })
    });
    return pluginRecordFromExtension(installed);
  }

  async update(id: string, archivePath: string, options: PluginInstallOptions): Promise<PluginRecord> {
    requiredIdentity(options);
    if ((await this.inspect(archivePath, options.expectedDigest)).manifest.id !== id) throw new PluginLifecycleError("PLUGIN_ID_MISMATCH", "updated package id does not match the installed plugin");
    return this.install(archivePath, options);
  }

  async configure(id: string, configuration: { serviceBindings: PluginServiceBindings }, options: PluginMutationOptions): Promise<PluginRecord> {
    this.assertWritable(options);
    requiredIdentity(options);
    if (!configuration || Object.keys(configuration).some((key) => key !== "serviceBindings")) throw new PluginLifecycleError("PLUGIN_CONFIGURATION_INVALID", "plugin setup accepts only serviceBindings; credentials must remain host-owned references");
    const extension = await this.requireExtension(id);
    const metadata = installedPluginMetadata(extension);
    const serviceBindings = normalizeServiceBindings(metadata.manifest, configuration.serviceBindings);
    const configured = await this.registry.configurePermissions(id, { ...extension.permissions, plugin: { ...metadata, serviceBindings } }, this.mutationOptions("configure", id, options));
    return pluginRecordFromExtension(configured);
  }

  async review(id: string, options: PluginMutationOptions): Promise<PluginRecord> {
    this.assertWritable(options);
    requiredIdentity(options);
    await this.verifyInstalled(await this.requireExtension(id));
    return pluginRecordFromExtension(await this.registry.review(id, this.mutationOptions("review", id, options)));
  }

  async grant(id: string, grants: string[], options: PluginMutationOptions): Promise<PluginRecord> {
    this.assertWritable(options);
    requiredIdentity(options);
    await this.requireExtension(id);
    assertCapabilityIds(grants, "plugin grants");
    return pluginRecordFromExtension(await this.registry.grant(id, grants, this.mutationOptions("grant", id, options)));
  }

  async enable(id: string, options: PluginMutationOptions & { grants?: string[]; trust?: boolean }): Promise<PluginRecord> {
    this.assertWritable(options);
    requiredIdentity(options);
    const extension = await this.requireExtension(id);
    const metadata = installedPluginMetadata(extension);
    await this.verifyInstalled(extension);
    const checks = await this.readinessChecks(extension, metadata);
    const failed = checks.filter((check) => !check.ok);
    if (failed.length) throw new PluginLifecycleError("PLUGIN_NOT_READY", failed.map((check) => `${check.detail}${check.remediation ? ` ${check.remediation}` : ""}`).join("; "), 409);
    const grants = options.grants ?? extension.grants ?? [];
    assertCapabilityIds(grants, "plugin grants");
    if (options.trust !== true && JSON.stringify([...new Set(grants)].sort()) !== JSON.stringify([...(extension.grants ?? [])].sort())) throw new PluginLifecycleError("PLUGIN_REVIEW_REQUIRED", "grant selection changed since review; grant and review the new identity, or explicitly acknowledge trust for this selection", 409);
    if (!grants.includes("mcp.discover") || !grants.includes("mcp.invoke")) throw new PluginLifecycleError("PLUGIN_GRANTS_REQUIRED", "plugin enablement requires explicit mcp.discover and mcp.invoke grants", 409);
    for (const service of metadata.manifest.services) {
      if (!metadata.serviceBindings[service.id]?.enabled) continue;
      if (!grants.includes("network.access") || (service.credential && !grants.includes("secret.reference.use"))) throw new PluginLifecycleError("PLUGIN_GRANTS_REQUIRED", "enabled services require their declared network.access and secret.reference.use grants", 409);
    }
    return pluginRecordFromExtension(await this.registry.enable(id, { ...this.mutationOptions("enable", id, options), grants, trust: options.trust === true }));
  }

  async disable(id: string, options: PluginMutationOptions = {}): Promise<PluginRecord> {
    this.assertWritable(options);
    await this.requireExtension(id);
    return pluginRecordFromExtension(await this.registry.disable(id, "operator disabled plugin", this.mutationOptions("disable", id, options)));
  }

  async rollback(id: string, options: PluginMutationOptions): Promise<PluginRecord> {
    this.assertWritable(options);
    requiredIdentity(options);
    await this.requireExtension(id);
    return pluginRecordFromExtension(await this.registry.rollback(id, this.mutationOptions("rollback", id, options)));
  }

  async remove(id: string, options: PluginMutationOptions) {
    this.assertWritable(options);
    requiredIdentity(options);
    await this.requireExtension(id);
    // Immutable versions and all operator data remain on disk for recovery. No recursive deletion.
    return this.registry.remove(id, this.mutationOptions("remove", id, options));
  }

  async transition(request: PluginLifecycleTransition, context: PluginLifecycleContext = {}) {
    const options = { ...context, expectedIdentityFingerprint: request?.expectedIdentityFingerprint };
    switch (request?.action) {
      case "configure": return this.configure(request.id, { serviceBindings: request.serviceBindings ?? {} }, options);
      case "review": return this.review(request.id, options);
      case "grant": return this.grant(request.id, request.grants ?? [], options);
      case "enable": return this.enable(request.id, { ...options, grants: request.grants, trust: request.trust });
      case "disable": return this.disable(request.id, options);
      case "rollback": return this.rollback(request.id, options);
      case "remove": return this.remove(request.id, options);
      default: throw new PluginLifecycleError("PLUGIN_ACTION_INVALID", "unsupported plugin lifecycle action");
    }
  }

  async doctor(id?: string): Promise<PluginDoctorReport[]> {
    const extensions = id ? [await this.requireExtension(id)] : (await this.registry.list()).filter((entry) => entry.permissions?.plugin !== undefined);
    return Promise.all(extensions.map(async (extension) => {
      const checks: PluginDoctorCheck[] = [];
      try {
        const metadata = installedPluginMetadata(extension);
        try { await this.verifyInstalled(extension); checks.push({ code: "PACKAGE_INTEGRITY", ok: true, detail: "Installed package files, manifest, entrypoint and image identity match the verified artifact." }); }
        catch { checks.push({ code: "PACKAGE_INTEGRITY", ok: false, detail: "Installed package integrity or containment verification failed.", remediation: "Reinstall the original digest-verified artifact; do not enable this copy." }); }
        checks.push(...await this.readinessChecks(extension, metadata));
        checks.push({ code: "REVIEW", ok: extension.trusted === true, detail: extension.trusted ? "Current package, grants and service bindings are reviewed." : "Current plugin identity has not been reviewed.", ...(!extension.trusted ? { remediation: "Inspect the package and selected access, grant capabilities, then review this exact identity." } : {}) });
        checks.push({ code: "GRANTS", ok: (extension.grants ?? []).includes("mcp.discover") && (extension.grants ?? []).includes("mcp.invoke"), detail: "MCP discovery and invocation need explicit grants.", remediation: "Grant mcp.discover and mcp.invoke, plus selected service capabilities, before review and enablement." });
      } catch {
        checks.push({ code: "PLUGIN_METADATA", ok: false, detail: "Installed plugin metadata is invalid or unsupported.", remediation: "Reinstall a compatible, verified plugin package." });
      }
      const ready = checks.every((check) => check.ok);
      return { id: extension.id, ok: ready, ready, identityFingerprint: extensionIdentityFingerprint(extension), checks };
    }));
  }

  private async requireExtension(id: string): Promise<ExtensionManifest> {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/u.test(String(id))) throw new PluginLifecycleError("PLUGIN_ID_INVALID", "plugin id is invalid");
    const extension = await this.registry.get(id);
    if (!extension || extension.permissions?.plugin === undefined) throw new PluginLifecycleError("PLUGIN_NOT_FOUND", "plugin package not found", 404);
    installedPluginMetadata(extension);
    return extension;
  }

  private assertWritable(context: PluginLifecycleContext = {}) {
    throwIfAborted(context.signal);
    if (!this.options.auditStore) throw new PluginLifecycleError("PLUGIN_AUDIT_REQUIRED", "plugin lifecycle mutation requires the host audit store", 503);
  }

  private mutationOptions(action: string, id: string, options: PluginMutationOptions): ExtensionMutationOptions {
    const operationId = `plugin_${randomUUID()}`;
    const event = (type: string, fingerprint?: string) => this.options.auditStore!.append({
      at: new Date().toISOString(), type, actor: options.actor ?? "operator", tool: "plugin.lifecycle", runId: operationId,
      data: { action, pluginId: id, ...(fingerprint ? { identityFingerprint: fingerprint } : {}) }
    });
    return {
      expectedIdentityFingerprint: options.expectedIdentityFingerprint,
      signal: options.signal,
      beforeCommit: async ({ previous, next }) => {
        throwIfAborted(options.signal);
        if (previous && previous.permissions?.plugin === undefined) throw new PluginLifecycleError("PLUGIN_ID_COLLISION", "plugin id is now used by a non-plugin extension", 409);
        if (next) installedPluginMetadata(next);
        await event("plugin.lifecycle.admitted", previous ? extensionIdentityFingerprint(previous) : undefined);
        throwIfAborted(options.signal);
      },
      afterCommit: async ({ next }) => {
        try { await this.options.onInvalidate?.(id, action); }
        catch {
          await event("plugin.lifecycle.cleanup_uncertain", next ? extensionIdentityFingerprint(next) : undefined);
          throw new PluginLifecycleError("PLUGIN_CLEANUP_UNCERTAIN", "plugin state changed and old identities are fenced, but runtime cleanup is unconfirmed", 503);
        }
        await event("plugin.lifecycle.completed", next ? extensionIdentityFingerprint(next) : undefined);
      }
    };
  }

  private async preparePackageParent(id: string): Promise<string> {
    const root = await realpath(this.workspaceRoot);
    let current = root;
    for (const part of [".odinn", "plugins", "packages", id]) {
      current = join(current, part);
      try { await mkdir(current, { mode: 0o700 }); } catch (error: unknown) { if (!isCode(error, "EEXIST")) throw error; }
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) throw new PluginLifecycleError("PLUGIN_PACKAGE_ROOT_INVALID", "managed plugin package location must be a contained directory without links");
    }
    return current;
  }

  private async assertManagedPackageRoot(packageRoot: string) {
    const workspace = await realpath(this.workspaceRoot);
    const managed = join(workspace, ".odinn", "plugins", "packages");
    const lexical = resolve(packageRoot);
    const path = relative(managed, lexical);
    if (!path || path.startsWith("..") || !lexical.startsWith(`${managed}${sep}`)) throw new PluginLifecycleError("PLUGIN_PACKAGE_ROOT_INVALID", "installed plugin package must remain in workspace-managed package storage");
    let current = workspace;
    for (const part of relative(workspace, lexical).split(sep)) {
      current = join(current, part);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new PluginLifecycleError("PLUGIN_PACKAGE_ROOT_INVALID", "plugin package directories must not contain links");
    }
    if (await realpath(lexical) !== lexical) throw new PluginLifecycleError("PLUGIN_PACKAGE_ROOT_INVALID", "plugin package root changed during verification");
  }

  private async verifyInstalled(extension: ExtensionManifest) {
    try {
      const metadata = installedPluginMetadata(extension);
      await this.assertManagedPackageRoot(metadata.packageRoot);
      const verified = await verifyPluginPackageDirectory(metadata.packageRoot, metadata.contentDigest);
      if (JSON.stringify(verified.manifest) !== JSON.stringify(metadata.manifest)
        || JSON.stringify(verified.fileDigests) !== JSON.stringify(metadata.fileDigests)
        || extension.bundleRoot !== metadata.packageRoot
        || extension.entrypoint !== join(metadata.packageRoot, metadata.manifest.entrypoint)
        || extension.containerImage !== metadata.manifest.containerImage
        || await digestExtensionBundle(metadata.packageRoot) !== extension.bundleDigest) throw new Error("installed plugin artifact identity mismatch");
      pluginCapabilities(metadata.manifest);
      normalizeServiceBindings(metadata.manifest, metadata.serviceBindings);
    } catch {
      throw new PluginLifecycleError("PLUGIN_PACKAGE_INTEGRITY", "installed plugin package integrity or containment verification failed; reinstall the verified artifact", 409);
    }
  }

  private async readinessChecks(extension: ExtensionManifest, metadata: InstalledPluginMetadata): Promise<PluginDoctorCheck[]> {
    const config = this.options.config ?? {};
    const runtime = config.runtime && typeof config.runtime === "object" ? config.runtime as Record<string, unknown> : {};
    let sandbox;
    try { sandbox = normalizeSandboxConfig(config); }
    catch { return [{ code: "HOST_CONFIG", ok: false, detail: "Host sandbox configuration is invalid.", remediation: "Validate the host sandbox configuration before plugin activation; disabled process execution also requires shell execution disabled." }]; }
    const checks: PluginDoctorCheck[] = [
      { code: "MCP_ENABLED", ok: runtime.enableMcp === true, detail: "Governed MCP runtime must be explicitly enabled.", remediation: "Set runtime.enableMcp to true in reviewed host configuration." },
      { code: "PROCESS_ENABLED", ok: sandbox.process.enabled, detail: "OCI sandbox process execution must be enabled.", remediation: "Set sandbox.process.enabled to true in reviewed host configuration." }
    ];
    const mcp = config.mcp && typeof config.mcp === "object" ? config.mcp as Record<string, unknown> : {};
    const servers = mcp.servers && typeof mcp.servers === "object" ? mcp.servers as Record<string, unknown> : {};
    const override = Object.hasOwn(servers, extension.id) ? servers[extension.id] : undefined;
    if (override !== undefined) {
      const selected = override && typeof override === "object" ? override as Record<string, unknown> : {};
      checks.push({ code: "MCP_SERVER_OVERRIDE", ok: selected.enabled === true && selected.extensionId === extension.id, detail: "An explicit MCP server configuration takes precedence over automatic plugin discovery.", remediation: "Review the matching mcp.servers entry; it must enable and identify this exact plugin extension." });
    }
    try {
      const probe = await (this.options.probeRuntime ?? probePluginRuntime)(extension.containerImage, config);
      checks.push({ code: "OCI_RUNTIME", ok: probe.ok, detail: probe.detail, ...(!probe.ok ? { remediation: "Install or start a compatible configured OCI engine with the required isolation controls." } : {}) });
      checks.push({ code: "OCI_IMAGE", ok: probe.imageAvailable, detail: probe.imageAvailable ? "Digest-pinned runtime image is available locally with no declared writable volumes." : "Digest-pinned runtime image is unavailable or unsuitable.", ...(!probe.imageAvailable ? { remediation: "Have the operator provision the manifest's exact image digest; plugin setup never pulls mutable image tags." } : {}) });
    } catch {
      checks.push({ code: "OCI_RUNTIME", ok: false, detail: "No compatible configured OCI runtime is available.", remediation: "Install or start the configured Docker/Podman engine; host-process fallback is not supported." });
    }
    const bindings = normalizeServiceBindings(metadata.manifest, metadata.serviceBindings);
    if (metadata.manifest.services.length && !metadata.manifest.services.some((service) => bindings[service.id]?.enabled)) checks.push({ code: "SERVICE_SCOPE", ok: false, detail: "No declared service is enabled.", remediation: "Configure the explicit service scope before granting and reviewing this plugin." });
    for (const service of metadata.manifest.services) {
      const binding = bindings[service.id];
      if (!binding?.enabled) continue;
      checks.push({ code: `SERVICE_SCOPE:${service.id}`, ok: true, detail: `Service ${service.id} is enabled with the package's exact origin, paths, and query-key scope.` });
      if (!service.credential) continue;
      const present = !!binding.credentialRef && await (this.options.credentialAvailable ?? credentialReferenceAvailable)(binding.credentialRef);
      checks.push({ code: `CREDENTIAL_REFERENCE:${service.id}`, ok: present, detail: present ? `Host-owned credential reference for ${service.id} is available.` : `Host-owned credential reference for ${service.id} is missing.`, ...(!present ? { remediation: "Use protected host setup, then configure an opaque env:NAME reference. Never paste credential values into plugin fields." } : {}) });
    }
    return checks;
  }
}

function pluginCapabilities(manifest: PluginManifest): string[] {
  const declared = assertCapabilityIds(manifest.tools.flatMap((tool) => [...tool.capabilities]), "plugin tool capabilities");
  if (declared.some((capability) => !PLUGIN_CAPABILITIES.has(capability))) throw new PluginLifecycleError("PLUGIN_CAPABILITY_UNSUPPORTED", "this plugin runtime supports only MCP discovery/invocation and declared host-brokered network/credential capabilities");
  return [...new Set(["mcp.discover", "mcp.invoke", ...declared, ...(manifest.services.length ? ["network.access"] : []), ...(manifest.services.some((service) => !!service.credential) ? ["secret.reference.use"] : [])])].sort();
}

export function normalizeServiceBindings(manifest: PluginManifest, input: unknown): PluginServiceBindings {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new PluginLifecycleError("PLUGIN_CONFIGURATION_INVALID", "serviceBindings must be a plain object of host-owned references");
  const source = input as Record<string, unknown>;
  const ids = new Set(manifest.services.map((service) => service.id));
  if (Object.keys(source).some((id) => !ids.has(id))) throw new PluginLifecycleError("PLUGIN_SERVICE_UNKNOWN", "service binding is not declared by this plugin package");
  return Object.fromEntries(manifest.services.map((service) => {
    const value = Object.hasOwn(source, service.id) ? source[service.id] : undefined;
    if (value === undefined) return [service.id, { enabled: false }];
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new PluginLifecycleError("PLUGIN_CONFIGURATION_INVALID", "service binding must be an object");
    const binding = value as Record<string, unknown>;
    if (Object.keys(binding).some((key) => !["enabled", "credentialRef"].includes(key)) || typeof binding.enabled !== "boolean") throw new PluginLifecycleError("PLUGIN_CONFIGURATION_INVALID", "service bindings accept only enabled and credentialRef; no secret values or arbitrary configuration");
    if (binding.credentialRef !== undefined && (!service.credential || typeof binding.credentialRef !== "string" || !/^env:[A-Z][A-Z0-9_]{1,95}$/u.test(binding.credentialRef))) throw new PluginLifecycleError("PLUGIN_CREDENTIAL_REFERENCE_INVALID", "credentialRef must be an opaque env:NAME reference for a declared credential service");
    return [service.id, { enabled: binding.enabled, ...(binding.credentialRef !== undefined ? { credentialRef: binding.credentialRef as `env:${string}` } : {}) }];
  }));
}

function requiredIdentity(options: PluginMutationOptions | undefined) {
  if (!options || typeof options.expectedIdentityFingerprint !== "string" || !SHA256.test(options.expectedIdentityFingerprint)) throw new PluginLifecycleError("PLUGIN_PRECONDITION_REQUIRED", "plugin lifecycle requires the expected identityFingerprint from a fresh inspection", 409);
}
function staleIdentity() { return new PluginLifecycleError("PLUGIN_PRECONDITION_FAILED", "plugin identity precondition failed; refresh the installed record and review its current identity", 409); }
function throwIfAborted(signal?: AbortSignal) { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("plugin lifecycle operation aborted"); }
function isCode(error: unknown, code: string) { return !!error && typeof error === "object" && "code" in error && error.code === code; }
function credentialReferenceAvailable(reference: string) { return /^env:[A-Z][A-Z0-9_]{1,95}$/u.test(reference) && !!process.env[reference.slice(4)]?.trim(); }

async function probePluginRuntime(image: string, config: SandboxConfigInput): Promise<PluginRuntimeReadiness> {
  validateOciImageReference(image);
  const backend = await resolveConfiguredOciBackend(normalizeSandboxConfig(config));
  let imageAvailable = false;
  try {
    const inspected = await execFile(backend.command, ["image", "inspect", image, "--format", "{{json .Config.Volumes}}"], { timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true });
    const volumes: unknown = JSON.parse(inspected.stdout.trim());
    imageAvailable = volumes === null || (!!volumes && typeof volumes === "object" && !Array.isArray(volumes) && Object.keys(volumes).length === 0);
  } catch { /* A read-only probe does not pull images or execute plugin code. */ }
  return { ok: backend.available && backend.compatible, imageAvailable, detail: `${backend.backend} isolation backend is ${backend.compatible ? "compatible" : "incompatible"}.` };
}
