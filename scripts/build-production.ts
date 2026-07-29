#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, version as esbuildVersion } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist");
const runtimeDirectories = ["cli", "gateway", "workers", "install"];
const metaFile = "production-esbuild-meta.json";
const buildInfoFile = "production-build-info.json";
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

await mkdir(output, { recursive: true });
for (const directory of runtimeDirectories) {
  await rm(join(output, directory), { recursive: true, force: true });
}
await rm(join(output, metaFile), { force: true });
await rm(join(output, buildInfoFile), { force: true });

await build({
  absWorkingDir: root,
  banner: {
    js: 'import { createRequire as __odinnCreateRequire } from "node:module"; const require = __odinnCreateRequire(import.meta.url);'
  },
  bundle: true,
  define: { __ODINN_COMPILED__: "true" },
  entryPoints: {
    "cli/index": "apps/cli/src/cli.ts",
    "gateway/server": "apps/gateway/src/server.ts",
    "gateway/host": "apps/gateway/src/host.ts",
    "workers/task-worker": "packages/kernel/src/task-worker.ts",
    "workers/browser-worker": "packages/kernel/src/browser-worker.ts",
    "install/install": "scripts/install.ts"
  },
  external: ["playwright-core"],
  format: "esm",
  legalComments: "none",
  logLevel: "info",
  metafile: true,
  minifySyntax: true,
  outdir: output,
  platform: "node",
  sourcemap: "external",
  sourcesContent: false,
  target: "node24"
}).then(async (result) => {
  await writeFile(join(output, metaFile), `${JSON.stringify(result.metafile, null, 2)}\n`);
});

await cp(join(root, "apps", "gateway", "public"), join(output, "gateway", "public"), {
  recursive: true
});

function currentCommit(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git rev-parse HEAD failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function walk(directory: string, prefix = ""): Promise<string[]> {
  const outputFiles: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) outputFiles.push(...await walk(path, name));
    else if (entry.isFile()) outputFiles.push(name);
  }
  return outputFiles;
}

const runtimeFiles = [
  metaFile,
  ...(await Promise.all(runtimeDirectories.map(async (directory) =>
    (await walk(join(output, directory), directory))
  ))).flat()
];
const files = [];
for (const name of runtimeFiles.sort()) {
  const path = join(output, name);
  const metadata = await stat(path);
  files.push({
    path: name.replaceAll("\\", "/"),
    bytes: metadata.size,
    sha256: createHash("sha256").update(await readFile(path)).digest("hex")
  });
}

const info = {
  schemaVersion: 1,
  name: pkg.name,
  version: pkg.version,
  commit: currentCommit(),
  nodeTarget: "node24",
  format: "esm",
  esbuild: esbuildVersion,
  files
};
await writeFile(join(output, buildInfoFile), `${JSON.stringify(info, null, 2)}\n`);
console.log(`compiled ${files.length} production files to ${relative(root, output)}`);
