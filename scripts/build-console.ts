#!/usr/bin/env node
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import viteConfig from "../apps/gateway/src/public/console/vite.config.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "apps/gateway/public/console");
const manifestPath = join(output, "manifest.json");

type ConsoleManifestEntry = {
  file?: unknown;
  css?: unknown;
  assets?: unknown;
  imports?: unknown;
  dynamicImports?: unknown;
};

function safeRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`console build manifest contains an invalid ${label}`);
  }
  if (value.endsWith(".map")) throw new Error(`console build manifest contains a source map: ${value}`);
  return value;
}

function manifestFiles(manifest: Record<string, ConsoleManifestEntry>): Set<string> {
  const files = new Set<string>(["index.html"]);
  const seen = new Set<string>();
  const visit = (entry: ConsoleManifestEntry) => {
    if (seen.has(JSON.stringify(entry))) return;
    seen.add(JSON.stringify(entry));
    for (const key of ["file", "css", "assets"] as const) {
      const value = entry[key];
      if (typeof value === "string") files.add(safeRelativePath(value, key));
      if (Array.isArray(value)) for (const item of value) files.add(safeRelativePath(item, key));
    }
    if (Array.isArray(entry.imports)) for (const item of entry.imports) {
      if (typeof item !== "string") throw new Error("console build manifest imports must be strings");
      const imported = manifest[item];
      if (!imported) throw new Error(`console build manifest import is missing: ${item}`);
      visit(imported);
    }
    if (Array.isArray(entry.dynamicImports)) for (const item of entry.dynamicImports) {
      if (typeof item !== "string") throw new Error("console build manifest dynamic imports must be strings");
      const imported = manifest[item];
      if (!imported) throw new Error(`console build manifest dynamic import is missing: ${item}`);
      visit(imported);
    }
  };
  for (const entry of Object.values(manifest)) visit(entry);
  return files;
}

async function walk(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path, name));
    else files.push(name);
  }
  return files;
}

export async function buildConsole(): Promise<void> {
  await build(viteConfig);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, ConsoleManifestEntry>;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const indexPath = join(output, "index.html");
  const normalizedIndex = (await readFile(indexPath, "utf8")).replace(/[ \t]+$/gmu, "");
  await writeFile(indexPath, normalizedIndex);
  const allowed = manifestFiles(manifest);
  const outputFiles = await walk(output);
  if (!allowed.has("index.html")) throw new Error("console build manifest does not include index.html");
  for (const name of outputFiles) {
    if (name === "manifest.json") continue;
    if (!allowed.has(name)) throw new Error(`console build emitted an unlisted file: ${name}`);
    const metadata = await lstat(join(output, name));
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`console build emitted a non-regular file: ${name}`);
  }
  const index = await readFile(indexPath, "utf8");
  if (/<script(?![^>]*\bsrc=)[^>]*>/iu.test(index) || /<style(?:\s|>)/iu.test(index)) {
    throw new Error("console build index contains inline script or style content");
  }
  if (/unsafe-(?:inline|eval)/iu.test(index)) throw new Error("console build index contains an unsafe CSP directive");
  console.log(`built console assets (${outputFiles.filter((name) => name !== "manifest.json").length} files) at ${relative(root, output).split(sep).join("/")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildConsole();
