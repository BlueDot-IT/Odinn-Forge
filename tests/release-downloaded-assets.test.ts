import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const commit = "a".repeat(40);

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "odinn-downloaded-release-"));
  const policy = JSON.parse(await readFile(join(root, "release/node-runtime-policy.json"), "utf8"));
  const standaloneArtifacts = Object.entries(policy.targets).map(([target, entry]: [string, any]) => ({
    name: `odinn-v${pkg.version}-standalone-${target}.${target === "win32-x64" ? "zip" : "tar.gz"}`,
    target,
    embeddedRuntime: { version: policy.version, sourceUrl: `${policy.origin}/dist/v${policy.version}/${entry.archive}`, archiveSha256: entry.sha256 }
  }));
  const archives = [`odinn-v${pkg.version}.zip`, `odinn-v${pkg.version}.tar.gz`, ...standaloneArtifacts.map((entry) => entry.name)];
  for (const name of archives) await writeFile(join(directory, name), `archive:${name}`);
  const archiveSha256 = Object.fromEntries(await Promise.all(archives.map(async (name) => [
    name,
    createHash("sha256").update(await readFile(join(directory, name))).digest("hex")
  ])));
  await writeFile(join(directory, "odinn.spdx.json"), JSON.stringify({
    spdxVersion: "SPDX-2.3",
    name: `${pkg.name}-${pkg.version}-production`,
    documentNamespace: `https://odinn.local/releases/${pkg.version}/${commit}`,
    packages: [{ name: pkg.name, versionInfo: pkg.version }],
    files: [{ fileName: "bin/odinn", checksums: [{ algorithm: "SHA256", checksumValue: "b".repeat(64) }] }]
  }));
  await writeFile(join(directory, "odinn-anchore.spdx.json"), JSON.stringify({ spdxVersion: "SPDX-2.3" }));
  await writeFile(join(directory, "odinn-standalone.spdx.json"), JSON.stringify({ spdxVersion: "SPDX-2.3", packages: [{ name: "Node.js", versionInfo: policy.version }] }));
  await writeFile(join(directory, "release-manifest.json"), JSON.stringify({
    name: pkg.name,
    distributionName: "@bluedot-it/odinn",
    version: pkg.version,
    commit,
    distribution: "compiled",
    runtimeSha256: "c".repeat(64),
    artifacts: archives.slice(0, 2),
    standaloneArtifacts,
    standaloneSbom: "odinn-standalone.spdx.json",
    archiveSha256,
    sbom: "odinn.spdx.json",
    provenance: "release-provenance.json"
  }));
  await writeFile(join(directory, "release-provenance.json"), JSON.stringify({
    commit,
    version: pkg.version,
    distributionName: "@bluedot-it/odinn",
    distribution: "compiled",
    runtimeSha256: "c".repeat(64),
    archiveSha256,
    checksumFile: "SHA256SUMS.txt"
  }));
  const files = [
    ...archives,
    "odinn.spdx.json",
    "odinn-anchore.spdx.json",
    "odinn-standalone.spdx.json",
    "release-manifest.json",
    "release-provenance.json"
  ].sort();
  const sums = await Promise.all(files.map(async (name) =>
    `${createHash("sha256").update(await readFile(join(directory, name))).digest("hex")}  ${name}`));
  await writeFile(join(directory, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
  return directory;
}

function verify(directory: string) {
  return spawnSync(process.execPath, [join(root, "scripts/release/verify-downloaded-assets.ts"), directory], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ODINN_RELEASE_COMMIT: commit }
  });
}

test("downloaded release verification binds checksums, SBOM, provenance, and tagged identity", async () => {
  const directory = await fixture();
  try {
    const result = verify(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /verified 10 downloaded assets/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("downloaded release verification rejects an asset changed after checksumming", async () => {
  const directory = await fixture();
  try {
    await writeFile(join(directory, `odinn-v${pkg.version}.zip`), "tampered archive");
    const result = verify(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /downloaded asset checksum mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
