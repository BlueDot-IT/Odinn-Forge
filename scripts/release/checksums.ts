import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = join(root, "dist", "release");
const files = (await readdir(directory))
  .filter((name: any) => name !== "SHA256SUMS.txt")
  .sort();

const manifestPath = join(directory, "release-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const archiveNames = [...(manifest.artifacts ?? []), ...(manifest.standaloneArtifacts ?? []).map((entry: any) => entry.name)];
if (archiveNames.length !== new Set(archiveNames).size || archiveNames.some((name) => typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name))) {
  throw new Error("release manifest contains an invalid or duplicate archive name");
}
manifest.archiveSha256 = Object.fromEntries(await Promise.all(archiveNames.map(async (name: string) => {
  const value = await readFile(join(directory, name));
  const sha256 = createHash("sha256").update(value).digest("hex");
  const standalone = (manifest.standaloneArtifacts ?? []).find((entry: any) => entry.name === name);
  if (standalone && (standalone.sha256 !== sha256 || standalone.bytes !== value.byteLength)) {
    throw new Error(`standalone artifact identity changed before checksum finalization: ${name}`);
  }
  return [name, sha256] as const;
})));
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const provenancePath = join(directory, manifest.provenance ?? "release-provenance.json");
const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
provenance.archiveSha256 = manifest.archiveSha256;
provenance.checksumFile = "SHA256SUMS.txt";
if (manifest.standaloneArtifacts !== undefined) {
  provenance.standaloneArtifacts = manifest.standaloneArtifacts;
  provenance.standaloneSbom = manifest.standaloneSbom;
  provenance.nodeRuntimePolicySha256 = manifest.nodeRuntimePolicySha256;
}
await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

const lines = [];
for (const name of files) {
  const digest = createHash("sha256").update(await readFile(join(directory, name))).digest("hex");
  lines.push(`${digest}  ${name}`);
}

if (lines.length === 0) throw new Error("no release artifacts found for checksums");
await writeFile(join(directory, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
