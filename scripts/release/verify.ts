import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_SCHEMA_MINIMUM_APPLICATION_VERSION, targetStateSchemaVersions } from "../../packages/kernel/src/state/schema-registry.ts";
import { extractSecureArchive } from "../../packages/kernel/src/secure-archive.ts";
import { readRuntimePolicy, runtimePolicySha256, verifyRuntimeExecutableIdentity, type RuntimeTarget } from "./node-runtime.ts";
import { verifyNativeLauncher } from "./native-launcher.ts";
import { retainsTypeScriptRuntimeReference } from "./typescript-runtime-reference.ts";

const PLAYWRIGHT_VERSION = "1.62.1";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const releaseDir = join(root, "dist", "release");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const expectedRoot = `odinn-v${pkg.version}`;
const manifest = JSON.parse(await readFile(join(releaseDir, "release-manifest.json"), "utf8"));
const runtimePolicy = await readRuntimePolicy(root);
const policySha256 = await runtimePolicySha256(root);

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
const standaloneArtifacts = Array.isArray(manifest.standaloneArtifacts) ? manifest.standaloneArtifacts : [];
const hasStandaloneArtifacts = standaloneArtifacts.length > 0;
const expectedStandaloneNames = Object.keys(runtimePolicy.targets).sort().map((target) => `odinn-v${pkg.version}-standalone-${target}.${target === "win32-x64" ? "zip" : "tar.gz"}`);
if (!hasStandaloneArtifacts && (manifest.standaloneArtifacts !== undefined
  || manifest.nodeRuntimePolicySha256 !== undefined
  || manifest.standaloneSbom !== undefined
  || provenanceHasStandaloneFields(manifest))) {
  throw new Error("release manifest contains an incomplete controlled standalone runtime matrix");
}
if (hasStandaloneArtifacts && (standaloneArtifacts.length !== expectedStandaloneNames.length
  || manifest.nodeRuntimePolicySha256 !== policySha256
  || manifest.standaloneSbom !== "odinn-standalone.spdx.json"
  || expectedStandaloneNames.some((name) => !standaloneArtifacts.some((entry: any) => entry.name === name)))) {
  throw new Error("release manifest must name the controlled standalone runtime matrix");
}

function provenanceHasStandaloneFields(value: any): boolean {
  return value?.standaloneArtifacts !== undefined
    || value?.nodeRuntimePolicySha256 !== undefined
    || value?.standaloneSbom !== undefined;
}
for (const entry of standaloneArtifacts) {
  const policy = runtimePolicy.targets[entry.target as RuntimeTarget];
  if (!policy
    || entry.embeddedRuntime?.version !== runtimePolicy.version
    || entry.embeddedRuntime?.target !== entry.target
    || entry.embeddedRuntime?.archive !== policy.archive
    || entry.embeddedRuntime?.archiveBytes !== policy.bytes
    || entry.embeddedRuntime?.archiveSha256 !== policy.sha256
    || entry.embeddedRuntime?.executableBytes !== policy.executableBytes
    || entry.embeddedRuntime?.executableSha256 !== policy.executableSha256
    || entry.embeddedRuntime?.runtimePolicySha256 !== policySha256
    || entry.sha256 !== manifest.archiveSha256?.[entry.name]
    || !Number.isSafeInteger(entry.bytes)
    || entry.bytes <= 0) {
    throw new Error(`standalone runtime identity does not match policy: ${String(entry.target)}`);
  }
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
for (const archiveName of [...manifest.artifacts, ...standaloneArtifacts.map((entry: any) => entry.name)]) {
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
if (hasStandaloneArtifacts && (provenance.nodeRuntimePolicySha256 !== policySha256
  || provenance.standaloneSbom !== manifest.standaloneSbom
  || JSON.stringify(provenance.standaloneArtifacts) !== JSON.stringify(standaloneArtifacts)
  || JSON.stringify(provenance.archiveSha256) !== JSON.stringify(manifest.archiveSha256))) {
  throw new Error("release provenance does not bind the standalone runtime artifacts");
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
    await extractSecureArchive(archive, destination, { expectedRoot });

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

if (hasStandaloneArtifacts) {
const standaloneSbom = JSON.parse(await readFile(join(releaseDir, manifest.standaloneSbom), "utf8"));
if (standaloneSbom.spdxVersion !== "SPDX-2.3"
  || !Array.isArray(standaloneSbom.files)
  || !Array.isArray(standaloneSbom.packages)
  || !Array.isArray(standaloneSbom.relationships)) {
  throw new Error("standalone SBOM is not a complete SPDX inventory");
}
const standaloneSbomFiles = new Map(standaloneSbom.files.map((file: any) => [String(file.fileName), file]));
const standaloneNodePackages = new Map(standaloneSbom.packages
  .filter((entry: any) => entry.name === "Node.js")
  .map((entry: any) => [String(entry.SPDXID).replace("SPDXRef-Package-Node-", ""), entry]));
if (standaloneNodePackages.size !== standaloneArtifacts.length) throw new Error("standalone SBOM does not inventory every embedded Node runtime");

for (const artifact of standaloneArtifacts) {
  const target = artifact.target as RuntimeTarget;
  const policy = runtimePolicy.targets[target];
  const destination = await mkdtemp(join(tmpdir(), `odinn-standalone-verify-${target}-`));
  try {
    const archive = join(releaseDir, artifact.name);
    const standaloneRoot = `odinn-v${pkg.version}-standalone-${target}`;
    await extractSecureArchive(archive, destination, { expectedRoot: standaloneRoot });
    const packageRoot = join(destination, standaloneRoot);
    const files = (await walk(packageRoot)).sort();
    const unixLauncherFiles = [
      "bin/odinn",
      "bin/odinn.runtime.sh",
      "bin/odinn-gateway",
      "bin/odinn-gateway.runtime.sh",
      "install/install.sh",
      "install/install.sh.runtime.sh"
    ];
    for (const required of [
      "runtime/node",
      "runtime/node.exe",
      "THIRD_PARTY_NOTICES/NODE_LICENSE",
      "THIRD_PARTY_NOTICES/NODE_RUNTIME.json",
      "THIRD_PARTY_NOTICES/node-runtime-policy.json",
      "release-info.json",
      "bin/odinn.cmd",
      "bin/odinn-gateway.cmd",
      target === "win32-x64" ? "install/install.cmd" : "install/install.ps1",
      ...(target === "win32-x64" ? [] : unixLauncherFiles)
    ].filter((path) => !path.startsWith("runtime/") || path === `runtime/${target === "win32-x64" ? "node.exe" : "node"}`)) {
      if (!files.includes(required)) throw new Error(`${artifact.name} is missing ${required}`);
    }
    const executableName = target === "win32-x64" ? "runtime/node.exe" : "runtime/node";
    const executable = await readFile(join(packageRoot, executableName));
    if (executable.byteLength !== policy.executableBytes
      || createHash("sha256").update(executable).digest("hex") !== policy.executableSha256) {
      throw new Error(`${artifact.name} embedded runtime digest mismatch`);
    }
    verifyRuntimeExecutableIdentity(executable, target);
    if (createHash("sha256").update(await readFile(join(packageRoot, "THIRD_PARTY_NOTICES/node-runtime-policy.json"))).digest("hex") !== policySha256) {
      throw new Error(`${artifact.name} embedded runtime policy mismatch`);
    }
    const releaseInfo = JSON.parse(await readFile(join(packageRoot, "release-info.json"), "utf8"));
    const runtimeEvidence = JSON.parse(await readFile(join(packageRoot, "THIRD_PARTY_NOTICES/NODE_RUNTIME.json"), "utf8"));
    if (releaseInfo.distribution !== "standalone"
      || JSON.stringify(releaseInfo.embeddedRuntime) !== JSON.stringify(artifact.embeddedRuntime)
      || JSON.stringify(runtimeEvidence) !== JSON.stringify(artifact.embeddedRuntime)) {
      throw new Error(`${artifact.name} release metadata does not bind the embedded runtime`);
    }
    const textLaunchers = target === "win32-x64"
      ? ["bin/odinn.cmd", "bin/odinn-gateway.cmd", "install/install.cmd"]
      : ["bin/odinn.runtime.sh", "bin/odinn-gateway.runtime.sh", "install/install.sh.runtime.sh", "bin/odinn.cmd", "bin/odinn-gateway.cmd", "install/install.ps1"];
    for (const launcher of textLaunchers) {
      const content = await readFile(join(packageRoot, launcher), "utf8");
      if (!content.includes("NODE_OPTIONS")
        || !content.includes("NODE_PATH")
        || !content.includes("NODE_TLS_REJECT_UNAUTHORIZED")
        || !content.includes("runtime")) {
        throw new Error(`${artifact.name} ${launcher} does not enforce the controlled runtime environment`);
      }
      if (launcher.endsWith(".runtime.sh")) {
        if (/exec node\b/u.test(content)) throw new Error(`${artifact.name} ${launcher} falls back to ambient Node`);
        if (!content.includes("ODINN_NATIVE_BOUNDARY")) throw new Error(`${artifact.name} ${launcher} can bypass the native runtime boundary`);
      }
    }
    if (target === "win32-x64") {
      if (files.includes("install/install.ps1")) throw new Error(`${artifact.name} contains a pre-sanitization PowerShell installer`);
      for (const path of unixLauncherFiles) {
        if (files.includes(path)) throw new Error(`${artifact.name} contains an unsupported Unix launcher: ${path}`);
      }
    } else {
      for (const launcher of ["bin/odinn", "bin/odinn-gateway", "install/install.sh"]) {
        verifyNativeLauncher(await readFile(join(packageRoot, launcher)), target);
      }
    }
    for (const path of files) {
      const key = `${target}/${path}`;
      const record: any = standaloneSbomFiles.get(key);
      const actual = createHash("sha256").update(await readFile(join(packageRoot, path))).digest("hex");
      if (!record || !record.checksums?.some((entry: any) => entry.algorithm === "SHA256" && entry.checksumValue === actual)) {
        throw new Error(`standalone SBOM does not bind ${key}`);
      }
    }
    if ([...standaloneSbomFiles.keys()].filter((key) => String(key).startsWith(`${target}/`)).length !== files.length) {
      throw new Error(`standalone SBOM contains stale file records for ${target}`);
    }
    const nodePackage: any = standaloneNodePackages.get(target);
    if (nodePackage?.versionInfo !== runtimePolicy.version
      || !nodePackage.checksums?.some((entry: any) => entry.algorithm === "SHA256" && entry.checksumValue === policy.sha256)) {
      throw new Error(`standalone SBOM Node package identity mismatch for ${target}`);
    }
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}
}

console.log(`verified ${sums.length} checksums, ${zipContents.size} equivalent compiled runtime files, and ${standaloneArtifacts.length} controlled standalone archives for Odinn Forge ${pkg.version}`);
