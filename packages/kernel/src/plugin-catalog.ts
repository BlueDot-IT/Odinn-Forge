import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { validatePluginId, validatePluginVersion } from "@odinn/plugin-sdk";
import { dnsLookupAll, isPrivateAddress, pinnedAddressLookup } from "./web.ts";
import { inspectPluginPackageBytes, PLUGIN_PACKAGE_MAX_ARCHIVE_BYTES, readBoundedPluginFile, type PluginPackageInspection } from "./plugin-packages.ts";

const MAX_CATALOG_BYTES = 256 * 1024;
const HEX = /^[a-f0-9]{64}$/u;
export type PluginCatalogEntry = Readonly<{ id: string; version: string; sdkVersion: "1.0"; name: string; description: string; artifact: string; digest: string; publisher?: string }>;
export type PluginCatalog = Readonly<{ schemaVersion: 1; plugins: readonly PluginCatalogEntry[]; source: string }>;
/** Resolver injection is trusted test infrastructure, never plugin/catalog data. */
export type PluginCatalogNetworkOptions = Readonly<{ resolveNetworkAddresses?: (hostname: string) => Promise<string[]> }>;
function fail(message: string): never { throw new Error(`plugin catalog: ${message}`); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("expected an ordinary object");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: string[]): void { if (Object.keys(value).some((key) => !fields.includes(key))) fail("unsupported metadata field"); }
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || /[\0-\x1f\x7f]/u.test(value)) fail("metadata string exceeds bounds");
  return value;
}
export function assertPluginCatalogUrl(value: string): URL {
  if (value.length > 2048 || /[\0-\x20\x7f\\]/u.test(value)) fail("invalid HTTPS URL");
  let url: URL; try { url = new URL(value); } catch { return fail("invalid HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || isIP(url.hostname) || isPrivateAddress(url.hostname) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(url.hostname)) fail("only credential-free public HTTPS on port 443 is supported");
  return url;
}
async function publicBytes(source: string, maximum: number, options: PluginCatalogNetworkOptions): Promise<Buffer> {
  const url = assertPluginCatalogUrl(source), controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("plugin catalog request timed out")), { once: true }));
  try {
    const operation = (async (): Promise<Buffer> => {
      let addresses: string[];
      try { addresses = await (options.resolveNetworkAddresses ?? dnsLookupAll)(url.hostname); } catch { return fail("DNS validation failed"); }
      if (controller.signal.aborted) fail("request timed out");
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > 64 || addresses.some((address) => typeof address !== "string" || !isIP(address) || isPrivateAddress(address))) fail("DNS validation refused non-public addresses");
      return await new Promise<Buffer>((resolveBody, rejectBody) => {
        const chunks: Buffer[] = [];
        let bytes = 0, settled = false;
        const finish = (error?: Error, body?: Buffer): void => {
          if (settled) return; settled = true;
          if (error) rejectBody(error); else resolveBody(body!);
        };
        const request = httpsRequest(url, { method: "GET", headers: { accept: "application/json, application/zip, application/octet-stream", "accept-encoding": "identity" }, lookup: pinnedAddressLookup(addresses[0]!), agent: false, rejectUnauthorized: true, signal: controller.signal }, (response) => {
          const status = response.statusCode ?? 0;
          const declared = response.headers["content-length"];
          if (status < 200 || status >= 300 || response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity" || declared && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
            finish(new Error(status >= 300 && status < 400 ? "plugin catalog redirects are refused" : "plugin catalog response refused"));
            response.destroy(); request.destroy(); return;
          }
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maximum) { finish(new Error("plugin catalog response exceeds size limit")); response.destroy(); request.destroy(); }
            else chunks.push(chunk);
          });
          response.on("end", () => finish(undefined, Buffer.concat(chunks, bytes)));
          response.on("error", () => finish(new Error("plugin catalog response failed")));
          response.on("aborted", () => finish(new Error("plugin catalog response interrupted")));
        });
        request.on("error", () => finish(new Error("plugin catalog request failed")));
        request.end();
      });
    })();
    return await Promise.race([operation, aborted]);
  } finally { clearTimeout(timeout); }
}
function contained(root: string, target: string): boolean { const path = relative(root, target); return path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`); }
export async function loadPluginCatalog(source: string, options: PluginCatalogNetworkOptions = {}): Promise<PluginCatalog> {
  const remote = source.startsWith("https://");
  if (!remote && /^[a-z][a-z0-9+.-]*:/iu.test(source)) fail("catalog source must be a local file or public HTTPS");
  const normalizedSource = remote ? assertPluginCatalogUrl(source).href : resolve(source);
  const bytes = remote ? await publicBytes(normalizedSource, MAX_CATALOG_BYTES, options) : await readBoundedPluginFile(normalizedSource, MAX_CATALOG_BYTES);
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return fail("catalog must be UTF-8 JSON"); }
  const catalog = object(raw); exact(catalog, ["schemaVersion", "plugins"]);
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.plugins) || catalog.plugins.length > 128) fail("unsupported schema or entry limit");
  const identities = new Set<string>();
  const plugins = catalog.plugins.map((rawEntry): PluginCatalogEntry => {
    const entry = object(rawEntry); exact(entry, ["id", "version", "sdkVersion", "name", "description", "artifact", "digest", "publisher"]);
    const id = validatePluginId(entry.id), version = validatePluginVersion(entry.version), identity = `${id}@${version}`;
    if (identities.has(identity)) fail("duplicate plugin version"); identities.add(identity);
    if (entry.sdkVersion !== "1.0" || typeof entry.digest !== "string" || !HEX.test(entry.digest)) fail("requires SDK v1 and SHA-256 archive identity");
    const artifactInput = text(entry.artifact, 2048);
    let artifact: string;
    if (artifactInput.startsWith("https://")) artifact = assertPluginCatalogUrl(artifactInput).href;
    else {
      if (remote || isAbsolute(artifactInput) || /^[a-z][a-z0-9+.-]*:/iu.test(artifactInput) || artifactInput.includes("\\")) fail("remote artifacts must be public HTTPS; local artifacts must be relative");
      artifact = resolve(dirname(normalizedSource), artifactInput);
      if (!contained(dirname(normalizedSource), artifact)) fail("artifact path escapes catalog directory");
    }
    return Object.freeze({ id, version, sdkVersion: "1.0", name: text(entry.name, 120), description: text(entry.description, 2000), artifact, digest: entry.digest, ...(entry.publisher === undefined ? {} : { publisher: text(entry.publisher, 120) }) });
  });
  return Object.freeze({ schemaVersion: 1, plugins: Object.freeze(plugins), source: normalizedSource });
}
export async function fetchPluginPackage(url: string, expectedDigest: string, output: string, options: PluginCatalogNetworkOptions = {}): Promise<PluginPackageInspection> {
  if (!HEX.test(expectedDigest)) fail("download requires a SHA-256 digest");
  const bytes = await publicBytes(url, PLUGIN_PACKAGE_MAX_ARCHIVE_BYTES, options);
  const inspection = inspectPluginPackageBytes(bytes, expectedDigest), archivePath = resolve(output);
  await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
  return Object.freeze({ ...inspection, archivePath });
}
export async function fetchCatalogPlugin(catalog: PluginCatalog, pluginId: string, version: string, output: string, options: PluginCatalogNetworkOptions = {}): Promise<PluginPackageInspection> {
  const entry = catalog.plugins.find((plugin) => plugin.id === pluginId && plugin.version === version);
  if (!entry) fail("requested plugin version is not in catalog");
  let bytes: Buffer;
  if (entry.artifact.startsWith("https://")) bytes = await publicBytes(entry.artifact, PLUGIN_PACKAGE_MAX_ARCHIVE_BYTES, options);
  else {
    if (catalog.source.startsWith("https://") || !contained(dirname(resolve(catalog.source)), resolve(entry.artifact))) fail("local artifact escapes catalog directory");
    bytes = await readBoundedPluginFile(entry.artifact, PLUGIN_PACKAGE_MAX_ARCHIVE_BYTES);
  }
  const inspection = inspectPluginPackageBytes(bytes, entry.digest);
  if (inspection.manifest.id !== entry.id || inspection.manifest.version !== entry.version || inspection.manifest.sdkVersion !== entry.sdkVersion) fail("artifact identity does not match catalog");
  const archivePath = resolve(output);
  await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
  return Object.freeze({ ...inspection, archivePath });
}
