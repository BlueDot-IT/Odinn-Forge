import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireNodeRuntime, readRuntimePolicy, type RuntimeTarget } from "./node-runtime.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = join(root, "dist/release");
const staging = join(root, "dist/package-stage");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const base = `odinn-v${pkg.version}`;
const source = join(staging, base);
const policy = await readRuntimePolicy(root);
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("--")) as RuntimeTarget[];
const targets = requested.length ? requested : Object.keys(policy.targets) as RuntimeTarget[];
const cache = process.env.ODINN_NODE_RUNTIME_CACHE || join(root, ".cache/node-runtime");
const manifestPath = join(output, "release-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const standaloneArtifacts: any[] = [];
const sbomPackages: any[] = [{ SPDXID: "SPDXRef-Package-Odinn", name: pkg.name, versionInfo: pkg.version, downloadLocation: "NOASSERTION", filesAnalyzed: true }];
const sbomFiles: any[] = [];

function run(command: string, args: string[], cwd?: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout || result.error?.message}`);
}
async function walk(directory: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await walk(join(directory, entry.name), relative));
    else if (entry.isFile()) result.push(relative);
    else throw new Error(`standalone stage contains unsupported entry: ${relative}`);
  }
  return result;
}
const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

for (const target of targets) {
  const selected = policy.targets[target];
  if (!selected) throw new Error(`unsupported standalone target: ${target}`);
  const temporary = await mkdtemp(join(tmpdir(), `odinn-standalone-${target}-`));
  const packageRoot = join(temporary, `${base}-standalone-${target}`);
  try {
    await cp(source, packageRoot, { recursive: true });
    const { runtimeRoot, evidence } = await acquireNodeRuntime(root, target, cache);
    await mkdir(join(packageRoot, "runtime"), { recursive: true });
    await mkdir(join(packageRoot, "THIRD_PARTY_NOTICES"), { recursive: true });
    const runtimeName = target === "win32-x64" ? "node.exe" : "node";
    await cp(join(runtimeRoot, selected.nodePath), join(packageRoot, "runtime", runtimeName));
    await cp(join(runtimeRoot, "LICENSE"), join(packageRoot, "THIRD_PARTY_NOTICES", "NODE_LICENSE"));
    await chmod(join(packageRoot, "runtime", runtimeName), 0o755).catch(() => undefined);

    const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    packageManifest.odinnStandalone = { runtime: "node", version: policy.version, target };
    await writeFile(join(packageRoot, "package.json"), `${JSON.stringify(packageManifest, null, 2)}\n`);
    const releaseInfo = JSON.parse(await readFile(join(packageRoot, "release-info.json"), "utf8"));
    releaseInfo.distribution = "standalone";
    releaseInfo.embeddedRuntime = evidence;
    await writeFile(join(packageRoot, "release-info.json"), `${JSON.stringify(releaseInfo, null, 2)}\n`);

    const unixLauncher = (entry: string) => `#!/bin/sh\nset -eu\nunset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE NODE_EXTRA_CA_CERTS\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nNODE="$ROOT/runtime/node"\n[ -x "$NODE" ] || { echo "Ódinn embedded runtime is missing or not executable" >&2; exit 126; }\nexec "$NODE" "$ROOT/${entry}" "$@"\n`;
    const windowsLauncher = (entry: string) => `@echo off\r\nsetlocal\r\nset "NODE_OPTIONS="\r\nset "NODE_PATH="\r\nset "ROOT=%~dp0.."\r\nset "NODE=%ROOT%\\runtime\\node.exe"\r\nif not exist "%NODE%" (echo Odinn embedded runtime is missing 1>&2 & exit /b 126)\r\n"%NODE%" "%ROOT%\\${entry.replaceAll("/", "\\")}" %*\r\nexit /b %ERRORLEVEL%\r\n`;
    await writeFile(join(packageRoot, "bin", "odinn"), unixLauncher("dist/cli/index.js"), { mode: 0o755 });
    await writeFile(join(packageRoot, "bin", "odinn-gateway"), unixLauncher("dist/gateway/server.js"), { mode: 0o755 });
    await writeFile(join(packageRoot, "bin", "odinn.cmd"), windowsLauncher("dist/cli/index.js"));
    await writeFile(join(packageRoot, "bin", "odinn-gateway.cmd"), windowsLauncher("dist/gateway/server.js"));
    await writeFile(join(packageRoot, "install", "install.sh"), `${unixLauncher("dist/install/install.js").replace('exec "$NODE" "$ROOT/dist/install/install.js" "$@"', 'exec "$NODE" "$ROOT/dist/install/install.js" install --source "$ROOT" "$@"')}`, { mode: 0o755 });
    await writeFile(join(packageRoot, "install", "install.ps1"), `param([string]$Prefix = "$HOME/.local/share/odinn")\r\n$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)\r\n$env:NODE_OPTIONS = ""\r\n$env:NODE_PATH = ""\r\n& "$Root\\runtime\\node.exe" "$Root\\dist\\install\\install.js" install --source "$Root" --prefix "$Prefix" @args\r\nexit $LASTEXITCODE\r\n`);

    const files = (await walk(packageRoot)).sort();
    for (const path of files) {
      const absolute = join(packageRoot, path);
      await utimes(absolute, new Date(0), new Date(0)).catch(() => undefined);
      sbomFiles.push({ SPDXID: `SPDXRef-Standalone-File-${sbomFiles.length + 1}`, fileName: `${target}/${path}`, checksums: [{ algorithm: "SHA256", checksumValue: await digest(absolute) }], licenseConcluded: "NOASSERTION", licenseInfoInFile: ["NOASSERTION"] });
    }
    sbomPackages.push({ SPDXID: `SPDXRef-Package-Node-${target}`, name: "Node.js", versionInfo: policy.version, downloadLocation: evidence.sourceUrl, checksums: [{ algorithm: "SHA256", checksumValue: evidence.archiveSha256 }], filesAnalyzed: true, licenseConcluded: "MIT" });
    const archiveName = `${base}-standalone-${target}.${target === "win32-x64" ? "zip" : "tar.gz"}`;
    if (target === "win32-x64") run("zip", ["-X", "-q", "-r", join(output, archiveName), packageRoot.split("/").at(-1)!], temporary);
    else run("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", join(output, archiveName), "-C", temporary, packageRoot.split("/").at(-1)!]);
    standaloneArtifacts.push({ name: archiveName, target, embeddedRuntime: evidence });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

const standaloneSbom = {
  spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT",
  name: `${pkg.name}-${pkg.version}-standalone`,
  documentNamespace: `https://odinn.local/releases/${pkg.version}/${manifest.commit}/standalone`,
  creationInfo: { created: new Date(0).toISOString(), creators: ["Tool: Odinn Forge standalone packager"] },
  packages: sbomPackages, files: sbomFiles
};
await writeFile(join(output, "odinn-standalone.spdx.json"), `${JSON.stringify(standaloneSbom, null, 2)}\n`);
manifest.standaloneArtifacts = standaloneArtifacts;
manifest.standaloneSbom = "odinn-standalone.spdx.json";
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`built ${standaloneArtifacts.length} controlled Node ${policy.version} standalone artifacts`);
