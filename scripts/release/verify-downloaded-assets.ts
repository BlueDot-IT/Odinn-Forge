import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRuntimePolicy, runtimePolicySha256 } from "./node-runtime.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const releaseDirectory = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: verify-downloaded-assets.ts RELEASE_DIRECTORY");

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const expectedCommit = process.env.ODINN_RELEASE_COMMIT;
if (!/^[a-f0-9]{40}$/u.test(expectedCommit ?? "")) {
  throw new Error("ODINN_RELEASE_COMMIT must be the exact 40-character release commit");
}

const entries = await readdir(releaseDirectory, { withFileTypes: true });
const files = new Set<string>();
for (const entry of entries) {
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`downloaded release contains a non-regular entry: ${entry.name}`);
  }
  const metadata = await lstat(join(releaseDirectory, entry.name));
  if (metadata.nlink !== 1) throw new Error(`downloaded release contains a hard-linked file: ${entry.name}`);
  files.add(entry.name);
}

const checksumText = await readFile(join(releaseDirectory, "SHA256SUMS.txt"), "utf8");
const checksums = new Map<string, string>();
for (const line of checksumText.trim().split("\n")) {
  const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(line);
  if (!match) throw new Error(`invalid downloaded checksum line: ${line}`);
  const [, digest, name] = match;
  if (name === "SHA256SUMS.txt" || basename(name) !== name || checksums.has(name)) {
    throw new Error(`unsafe or duplicate downloaded checksum entry: ${name}`);
  }
  checksums.set(name, digest);
}

const expectedFiles = new Set([...files].filter((name) => name !== "SHA256SUMS.txt"));
if (expectedFiles.size !== checksums.size || [...expectedFiles].some((name) => !checksums.has(name))) {
  throw new Error("downloaded checksum manifest does not cover exactly the downloaded release assets");
}
for (const [name, expectedDigest] of checksums) {
  const actualDigest = createHash("sha256").update(await readFile(join(releaseDirectory, name))).digest("hex");
  if (actualDigest !== expectedDigest) throw new Error(`downloaded asset checksum mismatch: ${name}`);
}

const manifest = JSON.parse(await readFile(join(releaseDirectory, "release-manifest.json"), "utf8"));
if (manifest.name !== pkg.name
  || manifest.distributionName !== "@bluedot-it/odinn"
  || manifest.version !== pkg.version
  || manifest.commit !== expectedCommit
  || manifest.distribution !== "compiled") {
  throw new Error("downloaded release manifest identity does not match the tagged checkout");
}

const runtimePolicy = await readRuntimePolicy(root);
const policySha256 = await runtimePolicySha256(root);
const standaloneNames = Object.keys(runtimePolicy.targets).sort().map((target) => `odinn-v${pkg.version}-standalone-${target}.${target === "win32-x64" ? "zip" : "tar.gz"}`);
const archiveNames = [`odinn-v${pkg.version}.zip`, `odinn-v${pkg.version}.tar.gz`, ...standaloneNames];
if (!Array.isArray(manifest.artifacts)
  || manifest.artifacts.length !== 2
  || archiveNames.slice(0, 2).some((name) => !manifest.artifacts.includes(name))
  || !Array.isArray(manifest.standaloneArtifacts)
  || manifest.standaloneArtifacts.length !== standaloneNames.length
  || manifest.nodeRuntimePolicySha256 !== policySha256
  || standaloneNames.some((name) => !manifest.standaloneArtifacts.some((entry: any) => entry.name === name))) {
  throw new Error("downloaded release manifest does not name the exact production archives");
}
for (const name of archiveNames) {
  if (manifest.archiveSha256?.[name] !== checksums.get(name)) {
    throw new Error(`downloaded release manifest archive digest mismatch: ${name}`);
  }
}

const sbomName = manifest.sbom;
const provenanceName = manifest.provenance;
for (const [kind, name] of [["SBOM", sbomName], ["provenance", provenanceName]] as const) {
  if (typeof name !== "string" || basename(name) !== name || !checksums.has(name)) {
    throw new Error(`downloaded release ${kind} is missing from the checksum manifest`);
  }
}
if (manifest.standaloneSbom !== "odinn-standalone.spdx.json" || !checksums.has(manifest.standaloneSbom)) {
  throw new Error("downloaded standalone SBOM is missing");
}
const standaloneSbom = JSON.parse(await readFile(join(releaseDirectory, manifest.standaloneSbom), "utf8"));
if (standaloneSbom.spdxVersion !== "SPDX-2.3"
  || !Array.isArray(standaloneSbom.files)
  || !Array.isArray(standaloneSbom.relationships)
  || standaloneSbom.packages?.filter((entry: any) => entry.name === "Node.js" && entry.versionInfo === runtimePolicy.version).length !== standaloneNames.length) {
  throw new Error("downloaded standalone SBOM does not inventory the embedded Node runtime");
}
for (const entry of manifest.standaloneArtifacts) {
  const policy = runtimePolicy.targets[entry.target as keyof typeof runtimePolicy.targets];
  const metadata = await lstat(join(releaseDirectory, entry.name));
  if (!policy
    || entry.bytes !== metadata.size
    || entry.sha256 !== checksums.get(entry.name)
    || entry.embeddedRuntime?.version !== runtimePolicy.version
    || entry.embeddedRuntime?.target !== entry.target
    || entry.embeddedRuntime?.archive !== policy.archive
    || entry.embeddedRuntime?.archiveBytes !== policy.bytes
    || entry.embeddedRuntime?.archiveSha256 !== policy.sha256
    || entry.embeddedRuntime?.executableBytes !== policy.executableBytes
    || entry.embeddedRuntime?.executableSha256 !== policy.executableSha256
    || entry.embeddedRuntime?.signedManifestSha256 !== runtimePolicy.signedManifest.sha256
    || entry.embeddedRuntime?.signedManifestCleartextSha256 !== runtimePolicy.signedManifest.cleartextSha256
    || !runtimePolicy.keyring.allowedPrimaryFingerprints.includes(entry.embeddedRuntime?.signerFingerprint)
    || entry.embeddedRuntime?.keyringUrl !== runtimePolicy.keyring.url
    || entry.embeddedRuntime?.keyringSha256 !== runtimePolicy.keyring.sha256
    || entry.embeddedRuntime?.runtimePolicySha256 !== policySha256
    || entry.embeddedRuntime?.sourceUrl !== `${runtimePolicy.origin}/dist/v${runtimePolicy.version}/${policy.archive}`) {
    throw new Error(`standalone runtime evidence mismatch: ${String(entry.target)}`);
  }
}

const sbom = JSON.parse(await readFile(join(releaseDirectory, sbomName), "utf8"));
if (sbom.spdxVersion !== "SPDX-2.3"
  || sbom.name !== `${pkg.name}-${pkg.version}-production`
  || sbom.documentNamespace !== `https://odinn.local/releases/${pkg.version}/${expectedCommit}`
  || !Array.isArray(sbom.files) || sbom.files.length === 0
  || !Array.isArray(sbom.packages)
  || !sbom.packages.some((entry: any) => entry.name === pkg.name && entry.versionInfo === pkg.version)) {
  throw new Error("downloaded release SBOM identity does not match the tagged checkout");
}
for (const file of sbom.files) {
  if (!Array.isArray(file.checksums)
    || !file.checksums.some((entry: any) => entry.algorithm === "SHA256" && /^[a-f0-9]{64}$/u.test(entry.checksumValue))) {
    throw new Error(`downloaded release SBOM file lacks SHA256 identity: ${String(file.fileName)}`);
  }
}

const anchoreSbom = JSON.parse(await readFile(join(releaseDirectory, "odinn-anchore.spdx.json"), "utf8"));
if (anchoreSbom.spdxVersion !== "SPDX-2.3" || !checksums.has("odinn-anchore.spdx.json")) {
  throw new Error("downloaded Anchore SBOM is missing or invalid");
}

const provenance = JSON.parse(await readFile(join(releaseDirectory, provenanceName), "utf8"));
if (provenance.commit !== expectedCommit
  || provenance.version !== pkg.version
  || provenance.distributionName !== manifest.distributionName
  || provenance.distribution !== manifest.distribution
  || provenance.runtimeSha256 !== manifest.runtimeSha256
  || provenance.checksumFile !== "SHA256SUMS.txt"
  || provenance.nodeRuntimePolicySha256 !== policySha256
  || provenance.standaloneSbom !== manifest.standaloneSbom
  || JSON.stringify(provenance.standaloneArtifacts) !== JSON.stringify(manifest.standaloneArtifacts)) {
  throw new Error("downloaded release provenance does not match the tagged checkout");
}
for (const name of archiveNames) {
  if (provenance.archiveSha256?.[name] !== checksums.get(name)) {
    throw new Error(`downloaded release provenance archive digest mismatch: ${name}`);
  }
}

console.log(`verified ${checksums.size} downloaded assets for ${pkg.version} at ${expectedCommit}`);
