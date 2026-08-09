import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_SCHEMA_MINIMUM_APPLICATION_VERSION, targetStateSchemaVersions } from "../../packages/kernel/src/state/schema-registry.ts";
import { assertReleaseCommit } from "./commit.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dist = join(root, "dist");
const output = join(dist, "release");
const staging = join(dist, "package-stage");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const base = `odinn-v${pkg.version}`;
const packageRoot = join(staging, base);
const compiledInfoPath = join(dist, "production-build-info.json");
const compiledInfo = JSON.parse(await readFile(compiledInfoPath, "utf8"));
const DISTRIBUTION_PACKAGE_NAME = "@bluedot-it/odinn";

await rm(output, { recursive: true, force: true });
await rm(staging, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(packageRoot, { recursive: true });

function currentCommit(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git rev-parse HEAD failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function commandOutput(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32" && command.endsWith(".cmd")
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function run(command: string, args: string[], cwd = root): void {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32" && command.endsWith(".cmd")
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.stdout}`);
  }
}

async function walk(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path, name));
    else if (entry.isFile()) files.push(name);
  }
  return files;
}

async function copyFileOrDirectory(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

const commit = currentCommit();
assertReleaseCommit(commit);
if (compiledInfo.name !== pkg.name || compiledInfo.version !== pkg.version || compiledInfo.commit !== commit) {
  throw new Error("compiled production build metadata does not match the release package or commit");
}

for (const directory of ["cli", "gateway", "workers", "install"]) {
  await copyFileOrDirectory(join(dist, directory), join(packageRoot, "dist", directory));
}
await copyFileOrDirectory(compiledInfoPath, join(packageRoot, "dist", "production-build-info.json"));

const playwrightSource = await realpath(join(root, "packages", "kernel", "node_modules", "playwright-core"));
await mkdir(join(packageRoot, "node_modules"), { recursive: true });
await cp(playwrightSource, join(packageRoot, "node_modules", "playwright-core"), {
  recursive: true,
  filter: (path) => {
    const packagePath = relative(playwrightSource, path).replaceAll("\\", "/");
    return !packagePath.endsWith(".d.ts") && !/(^|\/)(test|tests)(\/|$)/i.test(packagePath);
  }
});

for (const path of [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "docs/getting-started.md",
  "docs/operator-console.md",
  "docs/provider-support.md",
  "docs/surface-matrix.md",
  "docs/user-guide.md",
  "docs/v1-compatibility.md"
]) {
  await copyFileOrDirectory(join(root, path), join(packageRoot, path));
}

const productionPackage = {
  name: DISTRIBUTION_PACKAGE_NAME,
  version: pkg.version,
  description: pkg.description,
  private: false,
  type: "module",
  bin: {
    odinn: "bin/odinn.js",
    "odinn-gateway": "bin/odinn-gateway.js"
  },
  engines: { node: ">=24.0.0" },
  dependencies: { "playwright-core": "1.61.1" },
  license: pkg.license,
  repository: {
    type: "git",
    url: "git+https://github.com/BlueDot-IT/Odinn-Forge.git"
  },
  homepage: "https://github.com/BlueDot-IT/Odinn-Forge#readme",
  bugs: {
    url: "https://github.com/BlueDot-IT/Odinn-Forge/issues"
  },
  publishConfig: {
    access: "public"
  }
};
await writeFile(join(packageRoot, "package.json"), `${JSON.stringify(productionPackage, null, 2)}\n`);

const runtimeSha256 = createHash("sha256").update(await readFile(compiledInfoPath)).digest("hex");
const stateSchemas = targetStateSchemaVersions();
const releaseInfo = {
  schemaVersion: 2,
  name: pkg.name,
  distributionName: productionPackage.name,
  version: pkg.version,
  commit,
  distribution: "compiled",
  node: ">=24.0.0",
  runtimeSha256,
  stateSchemas,
  minimumApplicationVersionForTargetState: STATE_SCHEMA_MINIMUM_APPLICATION_VERSION
};
await writeFile(join(packageRoot, "release-info.json"), `${JSON.stringify(releaseInfo, null, 2)}\n`);

const unixLauncher = (entry: string) =>
  `#!/bin/sh\nset -eu\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nROOT=$(dirname "$SCRIPT_DIR")\nexec node "$ROOT/${entry}" "$@"\n`;
const windowsLauncher = (entry: string) =>
  `@echo off\r\nset "ODINN_ROOT=%~dp0.."\r\nnode "%ODINN_ROOT%\\${entry.replaceAll("/", "\\")}" %*\r\n`;

await mkdir(join(packageRoot, "bin"), { recursive: true });
await writeFile(join(packageRoot, "bin", "odinn"), unixLauncher("dist/cli/index.js"), { mode: 0o755 });
await writeFile(join(packageRoot, "bin", "odinn-gateway"), unixLauncher("dist/gateway/server.js"), { mode: 0o755 });
await writeFile(join(packageRoot, "bin", "odinn.js"), "#!/usr/bin/env node\nawait import('../dist/cli/index.js');\n", { mode: 0o755 });
await writeFile(join(packageRoot, "bin", "odinn-gateway.js"), "#!/usr/bin/env node\nawait import('../dist/gateway/server.js');\n", { mode: 0o755 });
await writeFile(join(packageRoot, "bin", "odinn.cmd"), windowsLauncher("dist/cli/index.js"));
await writeFile(join(packageRoot, "bin", "odinn-gateway.cmd"), windowsLauncher("dist/gateway/server.js"));
await chmod(join(packageRoot, "bin", "odinn"), 0o755).catch(() => undefined);
await chmod(join(packageRoot, "bin", "odinn-gateway"), 0o755).catch(() => undefined);
await chmod(join(packageRoot, "bin", "odinn.js"), 0o755).catch(() => undefined);
await chmod(join(packageRoot, "bin", "odinn-gateway.js"), 0o755).catch(() => undefined);

await mkdir(join(packageRoot, "install"), { recursive: true });
await writeFile(
  join(packageRoot, "install", "install.sh"),
  `${unixLauncher("dist/install/install.js").replace('exec node "$ROOT/dist/install/install.js" "$@"', 'exec node "$ROOT/dist/install/install.js" install --source "$ROOT" "$@"')}`,
  { mode: 0o755 }
);
await writeFile(
  join(packageRoot, "install", "install.ps1"),
  `param([string]$Prefix = "$HOME/.local/share/odinn")\n$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)\n& node "$Root/dist/install/install.js" install --source "$Root" --prefix "$Prefix" @args\nexit $LASTEXITCODE\n`
);
await chmod(join(packageRoot, "install", "install.sh"), 0o755).catch(() => undefined);

const archiveFiles = (await walk(packageRoot)).sort();
if (archiveFiles.some((path) => path.endsWith(".ts") || /(^|\/)(test|tests)(\/|$)/i.test(path))) {
  throw new Error("production package contains TypeScript source or tests");
}

const tarName = `${base}.tar.gz`;
const zipName = `${base}.zip`;
run("tar", ["-czf", join(output, tarName), "-C", staging, base]);
if (process.platform === "win32") {
  const source = packageRoot.replaceAll("'", "''");
  const destination = join(output, zipName).replaceAll("'", "''");
  run("powershell", ["-NoProfile", "-Command", `Compress-Archive -LiteralPath '${source}' -DestinationPath '${destination}' -Force`]);
} else {
  run("zip", ["-q", "-r", join(output, zipName), base], staging);
}

const sbomFiles = [];
for (const path of archiveFiles) {
  const absolute = join(packageRoot, path);
  sbomFiles.push({
    SPDXID: `SPDXRef-File-${sbomFiles.length + 1}`,
    fileName: path.replaceAll("\\", "/"),
    checksums: [{
      algorithm: "SHA256",
      checksumValue: createHash("sha256").update(await readFile(absolute)).digest("hex")
    }],
    licenseConcluded: "NOASSERTION",
    licenseInfoInFile: ["NOASSERTION"]
  });
}
const productionMeta = JSON.parse(await readFile(join(dist, "production-esbuild-meta.json"), "utf8"));
const bundledPackages = new Map<string, { name: string; version: string }>();
for (const input of Object.keys(productionMeta.inputs ?? {})) {
  const normalized = input.replaceAll("\\", "/");
  if (!normalized.includes("/node_modules/")) continue;
  let current = dirname(resolve(root, input));
  for (;;) {
    if (current === root) break;
    try {
      const metadata = JSON.parse(await readFile(join(current, "package.json"), "utf8"));
      if (typeof metadata.name === "string" && typeof metadata.version === "string") {
        bundledPackages.set(`${metadata.name}@${metadata.version}`, { name: metadata.name, version: metadata.version });
        break;
      }
    } catch {
      // Keep walking toward the workspace root; generated metafile inputs are untrusted paths.
    }
    const parent = dirname(current);
    if (parent === current || (parent !== root && !parent.startsWith(`${root}${sep}`))) break;
    current = parent;
  }
}
const sbomPackages = [
  { name: pkg.name, version: pkg.version },
  { name: "playwright-core", version: "1.61.1" },
  ...bundledPackages.values()
].filter((entry, index, entries) => entries.findIndex((candidate) => candidate.name === entry.name && candidate.version === entry.version) === index);
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `${pkg.name}-${pkg.version}-production`,
  documentNamespace: `https://odinn.local/releases/${pkg.version}/${commit}`,
  creationInfo: {
    created: new Date().toISOString(),
    creators: ["Tool: Odinn Forge production packager"]
  },
  packages: sbomPackages.map((entry, index) => ({
    SPDXID: `SPDXRef-Package-${index + 1}`,
    name: entry.name,
    versionInfo: entry.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: true
  })),
  files: sbomFiles
};
await writeFile(join(output, "odinn.spdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);

const lockfile = await readFile(join(root, "pnpm-lock.yaml"));
const createdAt = new Date().toISOString();
const manifest = {
  name: pkg.name,
  distributionName: productionPackage.name,
  version: pkg.version,
  commit,
  distribution: "compiled",
  runtimeSha256,
  lockfileSha256: createHash("sha256").update(lockfile).digest("hex"),
  toolchain: {
    node: process.version,
    pnpm: commandOutput(process.platform === "win32" ? "corepack.cmd" : "corepack", ["pnpm", "--version"])
  },
  artifacts: [zipName, tarName],
  sbom: "odinn.spdx.json",
  provenance: "release-provenance.json",
  runtimeDependencies: productionPackage.dependencies,
  bundledDependencies: [...bundledPackages.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version)),
  sourceMaps: { included: true, sourcesContent: false, purpose: "post-release debugging without distributing source content" },
  stateSchemas,
  minimumApplicationVersionForTargetState: STATE_SCHEMA_MINIMUM_APPLICATION_VERSION,
  runtimeStateExcluded: [
    ".odinn/",
    "OAuth credentials",
    "provider keys",
    "browser profiles",
    "browser cookies",
    "gateway tokens",
    "audit signing keys",
    "runtime databases",
    "recovery journals",
    "local prompts",
    "provider responses"
  ],
  createdAt
};
await writeFile(join(output, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
  join(output, manifest.provenance),
  `${JSON.stringify({
    schemaVersion: 1,
    subject: pkg.name,
    distributionName: productionPackage.name,
    version: pkg.version,
    commit,
    distribution: "compiled",
    runtimeSha256,
    toolchain: manifest.toolchain,
    archiveSha256: {},
    generatedAt: createdAt
  }, null, 2)}\n`
);

const packageBytes = (await Promise.all(archiveFiles.map(async (path) => (await stat(join(packageRoot, path))).size)))
  .reduce((total, size) => total + size, 0);
console.log(JSON.stringify({
  ...manifest,
  packageRoot: relative(root, packageRoot),
  packageFiles: archiveFiles.length,
  packageBytes
}, null, 2));
