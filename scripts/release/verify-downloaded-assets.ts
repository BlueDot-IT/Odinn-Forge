import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const archiveNames = [`odinn-v${pkg.version}.zip`, `odinn-v${pkg.version}.tar.gz`];
if (!Array.isArray(manifest.artifacts)
  || manifest.artifacts.length !== archiveNames.length
  || archiveNames.some((name) => !manifest.artifacts.includes(name))) {
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
  || provenance.checksumFile !== "SHA256SUMS.txt") {
  throw new Error("downloaded release provenance does not match the tagged checkout");
}
for (const name of archiveNames) {
  if (provenance.archiveSha256?.[name] !== checksums.get(name)) {
    throw new Error(`downloaded release provenance archive digest mismatch: ${name}`);
  }
}

console.log(`verified ${checksums.size} downloaded assets for ${pkg.version} at ${expectedCommit}`);
