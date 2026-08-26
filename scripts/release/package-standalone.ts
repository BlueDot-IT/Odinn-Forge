import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireNodeRuntime, readRuntimePolicy, runtimePolicySha256, type RuntimeTarget } from "./node-runtime.ts";
import { createDeterministicStandaloneArchive, normalizeStandaloneTree } from "./standalone-archive.ts";
import { standalonePowerShellInstaller, standaloneUnixLauncher, standaloneWindowsLauncher } from "./standalone-launchers.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = join(root, "dist/release");
const staging = join(root, "dist/package-stage");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const base = `odinn-v${pkg.version}`;
const source = join(staging, base);
const policy = await readRuntimePolicy(root);
const policySha256 = await runtimePolicySha256(root);
const requested = process.argv.slice(2).filter((argument) => !argument.startsWith("--")) as RuntimeTarget[];
const targets = (requested.length ? requested : Object.keys(policy.targets) as RuntimeTarget[]).sort();
if (new Set(targets).size !== targets.length || targets.some((target) => !policy.targets[target])) {
  throw new Error("standalone packaging target list is invalid");
}
const cache = process.env.ODINN_NODE_RUNTIME_CACHE || join(root, ".cache/node-runtime");
const manifestPath = join(output, "release-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const standaloneArtifacts: Array<{ name: string; target: RuntimeTarget; bytes: number; sha256: string; embeddedRuntime: Record<string, unknown> }> = [];
const sbomPackages: any[] = [{ SPDXID: "SPDXRef-Package-Odinn", name: pkg.name, versionInfo: pkg.version, downloadLocation: "NOASSERTION", filesAnalyzed: true }];
const sbomFiles: any[] = [];
const sbomRelationships: any[] = [{ spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: "SPDXRef-Package-Odinn" }];
const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

for (const target of targets) {
  const selected = policy.targets[target];
  const temporary = await mkdtemp(join(tmpdir(), `odinn-standalone-${target}-`));
  const packageRoot = join(temporary, `${base}-standalone-${target}`);
  let runtimeTemporary: string | null = null;
  try {
    await cp(source, packageRoot, { recursive: true, dereference: false });
    const acquired = await acquireNodeRuntime(root, target, cache);
    runtimeTemporary = acquired.temporaryRoot;
    const evidence = acquired.evidence;
    await mkdir(join(packageRoot, "runtime"), { recursive: true });
    await mkdir(join(packageRoot, "THIRD_PARTY_NOTICES"), { recursive: true });
    const runtimeName = target === "win32-x64" ? "node.exe" : "node";
    await cp(join(acquired.runtimeRoot, selected.nodePath), join(packageRoot, "runtime", runtimeName), { dereference: false });
    await cp(join(acquired.runtimeRoot, "LICENSE"), join(packageRoot, "THIRD_PARTY_NOTICES", "NODE_LICENSE"), { dereference: false });
    await cp(join(root, "release", "node-runtime-policy.json"), join(packageRoot, "THIRD_PARTY_NOTICES", "node-runtime-policy.json"), { dereference: false });
    await writeFile(join(packageRoot, "THIRD_PARTY_NOTICES", "NODE_RUNTIME.json"), `${JSON.stringify(evidence, null, 2)}\n`);

    const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    packageManifest.odinnStandalone = {
      runtime: "node",
      version: policy.version,
      target,
      runtimePolicySha256: policySha256,
      executableSha256: selected.executableSha256
    };
    await writeFile(join(packageRoot, "package.json"), `${JSON.stringify(packageManifest, null, 2)}\n`);
    const releaseInfo = JSON.parse(await readFile(join(packageRoot, "release-info.json"), "utf8"));
    releaseInfo.distribution = "standalone";
    releaseInfo.embeddedRuntime = evidence;
    await writeFile(join(packageRoot, "release-info.json"), `${JSON.stringify(releaseInfo, null, 2)}\n`);

    const unixTarget = target === "darwin-x64" ? "darwin-x64" : "linux-x64";
    await writeFile(join(packageRoot, "bin", "odinn"), standaloneUnixLauncher("dist/cli/index.js", unixTarget, selected.executableSha256), { mode: 0o755 });
    await writeFile(join(packageRoot, "bin", "odinn-gateway"), standaloneUnixLauncher("dist/gateway/server.js", unixTarget, selected.executableSha256), { mode: 0o755 });
    await writeFile(join(packageRoot, "bin", "odinn.cmd"), standaloneWindowsLauncher("dist/cli/index.js", selected.executableSha256));
    await writeFile(join(packageRoot, "bin", "odinn-gateway.cmd"), standaloneWindowsLauncher("dist/gateway/server.js", selected.executableSha256));
    await writeFile(
      join(packageRoot, "install", "install.sh"),
      standaloneUnixLauncher("dist/install/install.js", unixTarget, selected.executableSha256).replace(
        'exec "$NODE" "$ROOT/dist/install/install.js" "$@"',
        'exec "$NODE" "$ROOT/dist/install/install.js" install --source "$ROOT" "$@"'
      ),
      { mode: 0o755 }
    );
    await writeFile(
      join(packageRoot, "install", "install.ps1"),
      standalonePowerShellInstaller("dist/install/install.js", selected.executableSha256)
    );

    const files = await normalizeStandaloneTree(packageRoot);
    for (const path of files) {
      const absolute = join(packageRoot, path);
      sbomFiles.push({
        SPDXID: `SPDXRef-Standalone-File-${sbomFiles.length + 1}`,
        fileName: `${target}/${path}`,
        checksums: [{ algorithm: "SHA256", checksumValue: await digest(absolute) }],
        licenseConcluded: "NOASSERTION",
        licenseInfoInFile: path === "THIRD_PARTY_NOTICES/NODE_LICENSE" ? ["MIT"] : ["NOASSERTION"]
      });
    }
    const packageId = `SPDXRef-Package-Node-${target}`;
    sbomPackages.push({
      SPDXID: packageId,
      name: "Node.js",
      versionInfo: policy.version,
      downloadLocation: evidence.sourceUrl,
      checksums: [{ algorithm: "SHA256", checksumValue: evidence.archiveSha256 }],
      filesAnalyzed: true,
      licenseConcluded: "MIT"
    });
    sbomRelationships.push({ spdxElementId: "SPDXRef-Package-Odinn", relationshipType: "CONTAINS", relatedSpdxElement: packageId });

    const extension = target === "win32-x64" ? "zip" : "tar.gz";
    const archiveName = `${base}-standalone-${target}.${extension}`;
    const first = join(temporary, `first.${extension}`);
    const second = join(temporary, `second.${extension}`);
    createDeterministicStandaloneArchive(packageRoot, target, first, temporary, files);
    createDeterministicStandaloneArchive(packageRoot, target, second, temporary, files);
    const firstDigest = await digest(first);
    const secondDigest = await digest(second);
    if (firstDigest !== secondDigest) throw new Error(`standalone archive is not reproducible for ${target}`);
    const firstBytes = (await lstat(first)).size;
    await rm(join(output, archiveName), { force: true });
    await rename(first, join(output, archiveName));
    standaloneArtifacts.push({ name: archiveName, target, bytes: firstBytes, sha256: firstDigest, embeddedRuntime: evidence });
  } finally {
    if (runtimeTemporary) await rm(runtimeTemporary, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

const standaloneSbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `${pkg.name}-${pkg.version}-standalone`,
  documentNamespace: `https://odinn.local/releases/${pkg.version}/${manifest.commit}/standalone`,
  creationInfo: { created: new Date(0).toISOString(), creators: ["Tool: Odinn Forge standalone packager"] },
  packages: sbomPackages,
  files: sbomFiles,
  relationships: sbomRelationships
};
await writeFile(join(output, "odinn-standalone.spdx.json"), `${JSON.stringify(standaloneSbom, null, 2)}\n`);
manifest.standaloneArtifacts = standaloneArtifacts;
manifest.standaloneSbom = "odinn-standalone.spdx.json";
manifest.nodeRuntimePolicySha256 = policySha256;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const provenancePath = join(output, manifest.provenance ?? "release-provenance.json");
const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
provenance.standaloneArtifacts = standaloneArtifacts;
provenance.standaloneSbom = manifest.standaloneSbom;
provenance.nodeRuntimePolicySha256 = policySha256;
await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`built and reproduced ${standaloneArtifacts.length} controlled Node ${policy.version} standalone artifacts`);
