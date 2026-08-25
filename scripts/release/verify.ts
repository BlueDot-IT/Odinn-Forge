import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_SCHEMA_MINIMUM_APPLICATION_VERSION, targetStateSchemaVersions } from "../../packages/kernel/src/state/schema-registry.ts";
import { retainsTypeScriptRuntimeReference } from "./typescript-runtime-reference.ts";

const PLAYWRIGHT_VERSION = "1.62.1";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const releaseDir = join(root, "dist", "release");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const expectedRoot = `odinn-v${pkg.version}`;
const manifest = JSON.parse(await readFile(join(releaseDir, "release-manifest.json"), "utf8"));

if (manifest.name !== pkg.name || manifest.distributionName !== "@bluedot-it/odinn" || manifest.version !== pkg.version || manifest.distribution !== "compiled") {
  throw new Error("release manifest must identify the compiled production package");
}
const lockDigest = createHash("sha256").update(await readFile(join(root, "pnpm-lock.yaml"))).digest("hex");
if (manifest.lockfileSha256 !== lockDigest) throw new Error("release manifest lockfile digest mismatch");
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (head.status === 0 && manifest.commit !== head.stdout.trim()) {
  throw new Error("release manifest commit does not match checked-out HEAD");
}
if (!Array.isArray(manifest.artifacts)
  || !manifest.artifacts.includes(`${expectedRoot}.zip`)
  || !manifest.artifacts.includes(`${expectedRoot}.tar.gz`)) {
  throw new Error("release manifest must name both production archives");
}
if ((manifest.stateSchemas !== undefined && JSON.stringify(manifest.stateSchemas) !== JSON.stringify(targetStateSchemaVersions()))
  || manifest.minimumApplicationVersionForTargetState !== STATE_SCHEMA_MINIMUM_APPLICATION_VERSION) {
  throw new Error("release manifest state compatibility metadata is missing or inconsistent");
}

const sums = (await readFile(join(releaseDir, "SHA256SUMS.txt"), "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line: string) => {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`invalid checksum line: ${line}`);
    return { digest: match[1], name: match[2] };
  });
for (const { digest, name } of sums) {
  const actual = createHash("sha256").update(await readFile(join(releaseDir, name))).digest("hex");
  if (actual !== digest) throw new Error(`checksum mismatch for ${name}`);
}

const releaseFiles = new Set((await readdir(releaseDir)).filter((name) => name !== "SHA256SUMS.txt"));
const checksumFiles = new Set(sums.map(({ name }) => name));
if (releaseFiles.size !== checksumFiles.size || [...releaseFiles].some((name) => !checksumFiles.has(name))) {
  throw new Error("checksum file does not cover exactly the release assets");
}
for (const archiveName of manifest.artifacts) {
  const digest = createHash("sha256").update(await readFile(join(releaseDir, archiveName))).digest("hex");
  if (manifest.archiveSha256?.[archiveName] !== digest) {
    throw new Error(`release manifest archive digest mismatch for ${archiveName}`);
  }
}

const sbom = JSON.parse(await readFile(join(releaseDir, manifest.sbom ?? "odinn.spdx.json"), "utf8"));
if (sbom.spdxVersion !== "SPDX-2.3" || !Array.isArray(sbom.files) || !Array.isArray(sbom.packages)) {
  throw new Error("release SBOM is not a valid SPDX production inventory");
}
const sbomPackageKeys = new Set(sbom.packages.map((entry: any) => `${String(entry.name)}@${String(entry.versionInfo)}`));
for (const dependency of Array.isArray(manifest.bundledDependencies) ? manifest.bundledDependencies : []) {
  const key = `${String(dependency.name)}@${String(dependency.version)}`;
  if (!sbomPackageKeys.has(key)) throw new Error(`release SBOM is missing bundled component ${key}`);
}
const provenance = JSON.parse(await readFile(join(releaseDir, manifest.provenance ?? "release-provenance.json"), "utf8"));
if (provenance.commit !== manifest.commit
  || provenance.distributionName !== manifest.distributionName
  || provenance.version !== manifest.version
  || provenance.distribution !== "compiled"
  || provenance.runtimeSha256 !== manifest.runtimeSha256) {
  throw new Error("release provenance does not match the compiled package manifest");
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.stdout}`);
  }
}

async function walk(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`production archive contains a symbolic link: ${name}`);
    if (entry.isDirectory()) {
      files.push(...await walk(path, name));
      continue;
    }
    if (!entry.isFile()) throw new Error(`production archive contains an unsupported file type: ${name}`);
    const metadata = await lstat(path);
    if (metadata.nlink !== 1) throw new Error(`production archive contains a hard-linked file: ${name}`);
    files.push(name);
  }
  return files;
}

function forbiddenArchivePath(name: string): boolean {
  return /(^|\/)(?:\.git|\.odinn|tests?|coverage|\.pnpm-store)(\/|$)/i.test(name)
    || /(?:^|\/)(?:\.env(?:\..*)?|gateway\.token|[^/]+\.sqlite(?:-(?:shm|wal))?|[^/]*\.keys\.json|[^/]*recovery[^/]*\.(?:json|jsonl|db))$/i.test(name)
    || /(^|\/)(?:oauth|browser-profiles?|cookies?)(\/|$)/i.test(name)
    || /\.(?:ts|tsx|mts|cts)$/i.test(name);
}

const extracted: Array<Map<string, string>> = [];
for (const extension of ["zip", "tar.gz"]) {
  const archive = join(releaseDir, `${expectedRoot}.${extension}`);
  const destination = await mkdtemp(join(tmpdir(), "odinn-production-package-"));
  try {
    if (extension === "zip") {
      if (process.platform === "win32") {
        const escapedArchive = archive.replaceAll("'", "''");
        const escapedDestination = destination.replaceAll("'", "''");
        run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`]);
      } else {
        run("unzip", ["-q", archive, "-d", destination]);
      }
    } else {
      run("tar", ["-xzf", archive, "-C", destination]);
    }

    const packageRoot = join(destination, expectedRoot);
    const files = (await walk(packageRoot)).sort();
    const forbidden = files.filter(forbiddenArchivePath);
    if (forbidden.length) throw new Error(`archive contains forbidden files: ${forbidden.join(", ")}`);

    for (const required of [
      "CHANGELOG.md",
      "README.md",
      "LICENSE",
      "SECURITY.md",
      "package.json",
      "release-info.json",
      "bin/odinn",
      "bin/odinn.cmd",
      "bin/odinn-gateway",
      "bin/odinn-gateway.cmd",
      "dist/cli/index.js",
      "dist/cli/index.js.map",
      "dist/gateway/server.js",
      "dist/gateway/server.js.map",
      "dist/workers/task-worker.js",
      "dist/workers/browser-worker.js",
      "dist/install/install.js",
      "node_modules/playwright-core/package.json"
    ]) {
      if (!files.includes(required)) throw new Error(`${basename(archive)} is missing ${required}`);
    }

    const archivedPackage = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const recognizedPackageName = archivedPackage.name === "odinn" || archivedPackage.name === "@bluedot-it/odinn";
    if (!recognizedPackageName
      || archivedPackage.version !== pkg.version
      || archivedPackage.engines?.node !== ">=24.0.0"
      || archivedPackage.dependencies?.["playwright-core"] !== PLAYWRIGHT_VERSION) {
      throw new Error(`archive production metadata mismatch in ${basename(archive)}`);
    }
    for (const forbiddenKey of ["devDependencies", "packageManager", "workspaces", "scripts"]) {
      if (forbiddenKey in archivedPackage) {
        throw new Error(`archive package.json contains development field ${forbiddenKey}`);
      }
    }

    const releaseInfo = JSON.parse(await readFile(join(packageRoot, "release-info.json"), "utf8"));
    if (releaseInfo.name !== manifest.name
      || releaseInfo.distributionName !== manifest.distributionName
      || releaseInfo.commit !== manifest.commit
      || releaseInfo.version !== manifest.version
      || releaseInfo.distribution !== "compiled"
      || releaseInfo.runtimeSha256 !== manifest.runtimeSha256
      || (manifest.stateSchemas !== undefined && JSON.stringify(releaseInfo.stateSchemas) !== JSON.stringify(manifest.stateSchemas))
      || releaseInfo.minimumApplicationVersionForTargetState !== manifest.minimumApplicationVersionForTargetState) {
      throw new Error(`archive release identity mismatch in ${basename(archive)}`);
    }

    for (const launcher of ["bin/odinn", "bin/odinn.cmd", "bin/odinn-gateway", "bin/odinn-gateway.cmd"]) {
      const content = await readFile(join(packageRoot, launcher), "utf8");
      if (/apps[/\\].*src|\.ts\b|pnpm|corepack/i.test(content)) {
        throw new Error(`${launcher} executes a development or TypeScript path`);
      }
    }
    for (const path of files.filter((name) => name.endsWith(".js"))) {
      const content = await readFile(join(packageRoot, path), "utf8");
      if (retainsTypeScriptRuntimeReference(path, content)) {
        throw new Error(`${path} retains a runtime reference to TypeScript source`);
      }
    }

    const contents = new Map<string, string>();
    for (const path of files) {
      contents.set(path, createHash("sha256").update(await readFile(join(packageRoot, path))).digest("hex"));
    }
    extracted.push(contents);
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

const [zipContents, tarContents] = extracted;
if (zipContents.size !== tarContents.size
  || [...zipContents].some(([path, digest]) => tarContents.get(path) !== digest)) {
  throw new Error("ZIP and tarball production contents are not equivalent");
}

const sbomFiles = new Map(sbom.files.map((file: any) => [String(file.fileName), file]));
if (sbomFiles.size !== zipContents.size || [...zipContents.keys()].some((path) => !sbomFiles.has(path))) {
  throw new Error("release SBOM does not cover the complete production package");
}

console.log(`verified ${sums.length} checksums and ${zipContents.size} equivalent compiled runtime files in both Odinn Forge ${pkg.version} production archives`);
