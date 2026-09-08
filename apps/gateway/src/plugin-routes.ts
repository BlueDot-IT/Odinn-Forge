import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fetchCatalogPlugin, fetchPluginPackage, inspectPluginPackageArchive, inspectPluginPackageDirectory, isPhysicalPathInside, loadPluginCatalog, type PluginLifecycleService } from "@odinn/kernel";

// JSON upload is deliberately smaller than the package format's disk limit.
// The gateway's configured request-body limit may lower this further.
export const MAX_PLUGIN_UPLOAD_BYTES = 512 * 1024;

type Reply = { status: number; body: unknown };
type PluginRouteContext = {
  method: string;
  url: URL;
  workspaceRoot: string;
  hosted: boolean;
  bodyLimitBytes: number;
  lifecycle: PluginLifecycleService;
  readBody: () => Promise<any>;
  mutate: <T>(surface: string, operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  discover: (task: any) => Promise<any>;
};

function failure(message: string, status = 400): never {
  throw Object.assign(new Error(message), { statusCode: status });
}

function objectFields(value: any, allowed: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) failure("plugin request must be an object");
  if (Object.keys(value).some((key) => !allowed.includes(key))) failure("plugin request contains unsupported fields");
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) failure(`${name} is required`);
  return value as string;
}

function localOwner(context: PluginRouteContext): void {
  if (context.hosted) failure("third-party plugins require the local gateway owner; hosted tenant plugin access is unsupported", 403);
}

async function workspacePath(root: string, input: unknown): Promise<string> {
  const path = resolve(root, text(input, "workspace artifact path"));
  if (!isPhysicalPathInside(root, path)) failure("plugin artifact must be physically inside the selected workspace");
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) failure("plugin artifact must be a regular file or directory");
  return path;
}

async function catalogSource(root: string, input: unknown): Promise<string> {
  const source = text(input, "catalog source");
  return source.startsWith("https://") ? source : workspacePath(root, source);
}

function publicInspection(inspection: any): unknown {
  return { manifest: inspection.manifest, digest: inspection.digest, contentDigest: inspection.contentDigest, files: inspection.files, fileDigests: inspection.fileDigests };
}

async function withArtifact<T>(context: PluginRouteContext, body: any, operation: (archivePath: string, digest?: string) => Promise<T>): Promise<T> {
  const sources = ["path", "archiveBase64", "catalogSource", "artifactUrl"].filter((key) => body[key] !== undefined);
  if (sources.length !== 1) failure("select exactly one workspace package path, uploaded archive, or catalog source");
  if (body.expectedDigest !== undefined && (typeof body.expectedDigest !== "string" || !/^[a-f0-9]{64}$/u.test(body.expectedDigest))) failure("expectedDigest must be a SHA-256 digest");
  if (sources[0] === "path") {
    const path = await workspacePath(context.workspaceRoot, body.path);
    if (!(await lstat(path)).isFile()) failure("installation requires a packed .odinn-plugin.zip archive");
    return operation(path, body.expectedDigest);
  }
  const temporary = await mkdtemp(join(tmpdir(), "odinn-plugin-upload-"));
  try {
    const archivePath = join(temporary, "package.odinn-plugin.zip");
    if (sources[0] === "artifactUrl") {
      const artifact = await fetchPluginPackage(text(body.artifactUrl, "artifact URL"), text(body.expectedDigest, "expectedDigest"), archivePath);
      return await operation(archivePath, artifact.digest);
    }
    if (sources[0] === "archiveBase64") {
      const encoded = text(body.archiveBase64, "archiveBase64");
      if (encoded.length > Math.ceil(MAX_PLUGIN_UPLOAD_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) failure("uploaded plugin archive is invalid or exceeds 512 KiB");
      const bytes = Buffer.from(encoded, "base64");
      if (!bytes.length || bytes.length > MAX_PLUGIN_UPLOAD_BYTES) failure("uploaded plugin archive is empty or exceeds 512 KiB");
      await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
      return await operation(archivePath, body.expectedDigest);
    }
    const catalog = await loadPluginCatalog(await catalogSource(context.workspaceRoot, body.catalogSource));
    const id = text(body.id, "catalog plugin id");
    const version = text(body.version, "catalog plugin version");
    const entry = catalog.plugins.find((item: any) => item.id === id && item.version === version);
    if (!entry) failure("selected plugin version is not in this catalog", 404);
    if (!entry.artifact.startsWith("https://")) await workspacePath(context.workspaceRoot, entry.artifact);
    if (body.expectedDigest && entry.digest !== body.expectedDigest) failure("catalog package digest changed; inspect it again", 409);
    const artifact = await fetchCatalogPlugin(catalog, id, version, archivePath);
    return await operation(archivePath, artifact.digest);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Called after gateway authentication, CSRF/origin checks, and mutation admission. */
export async function handlePluginRoute(context: PluginRouteContext): Promise<Reply | undefined> {
  const { method, url, lifecycle } = context;
  if (url.pathname !== "/plugins" && !url.pathname.startsWith("/plugins/")) return undefined;
  try {
    localOwner(context);
    if (method === "GET" && url.pathname === "/plugins") {
      return { status: 200, body: { ok: true, sdkVersion: "1.0", supportedRuntime: "oci-mcp-stdio", writable: !context.hosted, maxUploadBytes: Math.min(MAX_PLUGIN_UPLOAD_BYTES, Math.floor(Math.max(0, context.bodyLimitBytes - 4096) / 4) * 3), plugins: await lifecycle.list() } };
    }
    if (method === "GET" && url.pathname === "/plugins/doctor") {
      return { status: 200, body: { ok: true, checks: await lifecycle.doctor(url.searchParams.get("id") || undefined) } };
    }
    if (method === "GET" && url.pathname === "/plugins/catalog") {
      localOwner(context);
      const catalog = await loadPluginCatalog(await catalogSource(context.workspaceRoot, url.searchParams.get("source")));
      const id = url.searchParams.get("id");
      const version = url.searchParams.get("version");
      return { status: 200, body: { ok: true, catalog: { ...catalog, plugins: catalog.plugins.filter((plugin: any) => (!id || plugin.id === id) && (!version || plugin.version === version)) }, publisherVerification: "not-verified" } };
    }
    if (method === "POST" && ["/plugins/inspect", "/plugins/validate"].includes(url.pathname)) {
      localOwner(context);
      const body = await context.readBody();
      objectFields(body, ["path", "archiveBase64", "expectedDigest", "catalogSource", "artifactUrl", "id", "version"]);
      if (url.pathname.endsWith("/validate") && body.path) {
        const path = await workspacePath(context.workspaceRoot, body.path);
        if ((await lstat(path)).isDirectory()) return { status: 200, body: { ok: true, metadata: publicInspection(await inspectPluginPackageDirectory(path)) } };
      }
      const metadata = await withArtifact(context, body, async (path, digest) => publicInspection(await inspectPluginPackageArchive(path, digest)));
      return { status: 200, body: { ok: true, metadata } };
    }
    if (method === "POST" && url.pathname === "/plugins") {
      localOwner(context);
      const body = await context.readBody();
      objectFields(body, ["path", "archiveBase64", "expectedDigest", "expectedIdentityFingerprint", "catalogSource", "artifactUrl", "id", "version"]);
      const plugin = await context.mutate("plugin.install", (signal) => withArtifact(context, body, (archivePath, expectedDigest) => lifecycle.install(archivePath, { expectedDigest, expectedIdentityFingerprint: body.expectedIdentityFingerprint, actor: "gateway", signal })));
      return { status: 200, body: { ok: true, plugin } };
    }
    const lifecycleMatch = /^\/plugins\/([a-z0-9][a-z0-9._-]{1,63})\/lifecycle$/u.exec(url.pathname);
    if (method === "POST" && lifecycleMatch) {
      localOwner(context);
      const body = await context.readBody();
      objectFields(body, ["action", "expectedIdentityFingerprint", "grants", "serviceBindings", "trust"]);
      const plugin = await context.mutate("plugin.lifecycle", (signal) => lifecycle.transition({ ...body, id: lifecycleMatch[1]! }, { actor: "gateway", signal }));
      return { status: 200, body: { ok: true, plugin } };
    }
    const discoverMatch = /^\/plugins\/([a-z0-9][a-z0-9._-]{1,63})\/discover$/u.exec(url.pathname);
    if (method === "POST" && discoverMatch) {
      const body = await context.readBody();
      objectFields(body, ["refresh"]);
      if (body.refresh !== undefined && typeof body.refresh !== "boolean") failure("refresh must be boolean");
      const result = await context.discover({ tool: "mcp.discover", input: { serverId: discoverMatch[1], refresh: body.refresh === true }, actor: "gateway" });
      return { status: 200, body: result };
    }
    const detailMatch = /^\/plugins\/([a-z0-9][a-z0-9._-]{1,63})$/u.exec(url.pathname);
    if (method === "GET" && detailMatch) {
      const plugin = await lifecycle.get(detailMatch[1]!);
      return plugin ? { status: 200, body: { ok: true, plugin } } : { status: 404, body: { ok: false, error: "plugin not found" } };
    }
    return { status: 404, body: { ok: false, error: "plugin route not found" } };
  } catch (error: any) {
    const status = Number(error?.statusCode || error?.status) || 400;
    return { status, body: { ok: false, error: error instanceof Error ? error.message : "plugin operation failed" } };
  }
}
