import { lstat, readFile } from "node:fs/promises";
import { lstatSync, readFileSync as readFileSyncNode } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

declare const __ODINN_COMPILED__: boolean | undefined;

const compiledRuntime = typeof __ODINN_COMPILED__ !== "undefined";
const CONSOLE_ROOT = fileURLToPath(new URL(compiledRuntime ? "./public/console/" : "../../public/console/", import.meta.url));
const ASSET_PREFIX = "/console/assets/";
export const CONSOLE_CSP = "default-src 'none'; base-uri 'none'; object-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'none'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'";
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

type ConsoleManifestEntry = {
  file?: unknown;
  css?: unknown;
  assets?: unknown;
  imports?: unknown;
  dynamicImports?: unknown;
};

export type ConsoleAsset = {
  body: Buffer;
  contentType: string;
};

export class ConsoleAssetError extends Error {}

function safeRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === ".." || part === "")) {
    throw new ConsoleAssetError(`console manifest contains an invalid ${label}`);
  }
  if (value.endsWith(".map")) throw new ConsoleAssetError(`console manifest contains a source map: ${value}`);
  return value;
}

function manifestFiles(manifest: Record<string, ConsoleManifestEntry>): Set<string> {
  const files = new Set<string>(["index.html"]);
  const visited = new Set<ConsoleManifestEntry>();
  const visit = (entry: ConsoleManifestEntry) => {
    if (visited.has(entry)) return;
    visited.add(entry);
    for (const key of ["file", "css", "assets"] as const) {
      const value = entry[key];
      if (typeof value === "string") files.add(safeRelativePath(value, key));
      if (Array.isArray(value)) for (const item of value) files.add(safeRelativePath(item, key));
    }
    for (const key of ["imports", "dynamicImports"] as const) {
      const imports = entry[key];
      if (!Array.isArray(imports)) continue;
      for (const item of imports) {
        if (typeof item !== "string" || !manifest[item]) throw new ConsoleAssetError(`console manifest ${key} reference is invalid`);
        visit(manifest[item]);
      }
    }
  };
  for (const entry of Object.values(manifest)) visit(entry);
  return files;
}

function loadManifest(): { manifest: Record<string, ConsoleManifestEntry>; files: Set<string> } {
  try {
    const manifest = JSON.parse(readFileSyncNode(resolve(CONSOLE_ROOT, "manifest.json"), "utf8")) as Record<string, ConsoleManifestEntry>;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new ConsoleAssetError("console manifest must be an object");
    return { manifest, files: manifestFiles(manifest) };
  } catch (error) {
    if (error instanceof ConsoleAssetError) throw error;
    throw new ConsoleAssetError("console frontend assets are unavailable; run pnpm build:console");
  }
}

function assertRegularFile(path: string, name: string): void {
  let metadata;
  try { metadata = lstatSync(path); } catch { throw new ConsoleAssetError(`console asset is missing: ${name}`); }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new ConsoleAssetError(`console asset is not a regular file: ${name}`);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function renderConsoleHtml(version = "development"): string {
  const { files } = loadManifest();
  const indexPath = resolve(CONSOLE_ROOT, "index.html");
  assertRegularFile(indexPath, "index.html");
  const html = readFileSyncNode(indexPath, "utf8");
  const references = [...html.matchAll(/(?:src|href)="(\/console\/assets\/[^"?#]+)"/gu)].map((match) => match[1]);
  if (!references.length || references.some((reference) => !files.has(reference.slice("/console/".length)))) {
    throw new ConsoleAssetError("console index references an unlisted or missing asset");
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>/iu.test(html) || /<style(?:\s|>)/iu.test(html)) {
    throw new ConsoleAssetError("console index contains inline script or style content");
  }
  if (/unsafe-(?:inline|eval)/iu.test(html)) throw new ConsoleAssetError("console index contains an unsafe CSP directive");
  const placeholder = "__ODINN_VERSION__";
  if (!html.includes(placeholder)) throw new ConsoleAssetError("console index is missing its version placeholder");
  return html.replaceAll(placeholder, escapeHtml(String(version)));
}

export async function readConsoleAsset(pathname: string): Promise<ConsoleAsset> {
  if (!pathname.startsWith(ASSET_PREFIX)) throw new ConsoleAssetError("console asset path is outside the asset prefix");
  let requested: string;
  try { requested = decodeURIComponent(pathname.slice(ASSET_PREFIX.length)); } catch { throw new ConsoleAssetError("console asset path is not valid UTF-8"); }
  if (!requested || requested.includes("\\") || requested.split("/").some((part) => part === ".." || part === "")) throw new ConsoleAssetError("console asset path is invalid");
  const name = `assets/${requested}`;
  const { files } = loadManifest();
  if (!files.has(name) || name === "index.html" || name === "manifest.json") throw new ConsoleAssetError("console asset is not listed");
  const path = resolve(CONSOLE_ROOT, name);
  const relativePath = relative(CONSOLE_ROOT, path);
  if (relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relativePath)) throw new ConsoleAssetError("console asset path escaped its root");
  const contentType = CONTENT_TYPES[extname(name).toLowerCase()];
  if (!contentType) throw new ConsoleAssetError("console asset type is not supported");
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new ConsoleAssetError("console asset is not a regular file");
  return { body: await readFile(path), contentType };
}
