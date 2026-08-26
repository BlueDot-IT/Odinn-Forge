import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

export type RuntimeTarget = "linux-x64" | "darwin-x64" | "win32-x64";
export interface RuntimePolicy {
  schemaVersion: 1;
  version: string;
  origin: string;
  keyring: { url: string; sha256: string; allowedPrimaryFingerprints: string[] };
  targets: Record<RuntimeTarget, { archive: string; sha256: string; nodePath: string }>;
}

export async function readRuntimePolicy(root: string): Promise<RuntimePolicy> {
  const policy = JSON.parse(await readFile(join(root, "release/node-runtime-policy.json"), "utf8"));
  if (policy.schemaVersion !== 1 || !/^24\.\d+\.\d+$/.test(policy.version)) throw new Error("invalid pinned Node runtime policy");
  if (policy.origin !== "https://nodejs.org") throw new Error("Node runtime origin must be the reviewed HTTPS origin");
  if (!/^[a-f0-9]{64}$/.test(policy.keyring?.sha256) || !Array.isArray(policy.keyring?.allowedPrimaryFingerprints)) throw new Error("invalid reviewed Node release key policy");
  for (const [target, entry] of Object.entries(policy.targets ?? {}) as Array<[string, { archive: string; sha256: string; nodePath: string }]>) {
    if (!/^(?:linux|darwin|win32)-x64$/.test(target) || basename(entry.archive) !== entry.archive || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`invalid Node runtime target policy: ${target}`);
    if (!entry.archive.startsWith(`node-v${policy.version}-`)) throw new Error(`Node archive does not match pinned version: ${target}`);
  }
  return policy;
}

export function validateArchiveEntries(entries: Array<{ name: string; type: "file" | "directory" | "link" | "device" }>, expectedRoot: string): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = entry.name.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!name || name.startsWith("/") || /^[A-Za-z]:\//.test(name) || name.split("/").includes("..")) throw new Error(`unsafe Node archive path: ${entry.name}`);
    if (seen.has(name)) throw new Error(`duplicate Node archive path: ${name}`);
    seen.add(name);
    if (entry.type === "link" || entry.type === "device") throw new Error(`unsupported Node archive entry: ${name}`);
    if (name !== expectedRoot && !name.startsWith(`${expectedRoot}/`)) throw new Error(`unexpected Node archive top-level layout: ${name}`);
  }
  if (!seen.size) throw new Error("empty Node runtime archive");
}

function validateSelectedRuntimeEntries(entries: Array<{ name: string; type: "file" | "directory" | "link" | "device" }>, expectedRoot: string, required: string[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = entry.name.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!name || name.startsWith("/") || /^[A-Za-z]:\//.test(name) || name.split("/").includes("..")) throw new Error(`unsafe Node archive path: ${entry.name}`);
    if (seen.has(name)) throw new Error(`duplicate Node archive path: ${name}`);
    seen.add(name);
    if (name !== expectedRoot && !name.startsWith(`${expectedRoot}/`)) throw new Error(`unexpected Node archive top-level layout: ${name}`);
  }
  for (const path of required) {
    const entry = entries.find((candidate) => candidate.name.replaceAll("\\", "/").replace(/^\.\//, "") === path);
    if (!entry || entry.type !== "file") throw new Error(`required Node runtime entry is missing or not a regular file: ${path}`);
  }
}

function sha256(data: Buffer): string { return createHash("sha256").update(data).digest("hex"); }
function run(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout || result.error?.message}`);
  return result.stdout;
}
async function download(url: string, expectedOrigin?: string): Promise<Buffer> {
  let current = new URL(url);
  for (let redirects = 0; redirects < 4; redirects += 1) {
    if (current.protocol !== "https:" || (expectedOrigin && current.origin !== expectedOrigin)) throw new Error(`untrusted runtime download origin: ${current.origin}`);
    const response = await fetch(current, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("runtime download redirect omitted location");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`runtime download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error("too many runtime download redirects");
}

export async function acquireNodeRuntime(root: string, target: RuntimeTarget, cacheRoot: string): Promise<{ runtimeRoot: string; evidence: any }> {
  const policy = await readRuntimePolicy(root);
  const selected = policy.targets[target];
  if (!selected) throw new Error(`unsupported standalone target: ${target}`);
  const identity = `${policy.version}-${selected.sha256}`;
  const cache = join(cacheRoot, identity);
  await mkdir(cache, { recursive: true });
  const archivePath = join(cache, selected.archive);
  let archive: Buffer;
  try { archive = await readFile(archivePath); } catch { archive = await download(`${policy.origin}/dist/v${policy.version}/${selected.archive}`, policy.origin); await writeFile(archivePath, archive, { flag: "wx" }); }
  if (sha256(archive) !== selected.sha256) throw new Error(`Node runtime checksum mismatch: ${target}`);

  const [signedManifest, keyring] = await Promise.all([
    download(`${policy.origin}/dist/v${policy.version}/SHASUMS256.txt.asc`, policy.origin),
    download(policy.keyring.url)
  ]);
  if (sha256(keyring) !== policy.keyring.sha256) throw new Error("Node release keyring checksum mismatch");
  const keyringPath = join(cache, "node-release-keyring.kbx");
  const ascPath = join(cache, "SHASUMS256.txt.asc");
  const manifestPath = join(cache, "SHASUMS256.txt");
  await writeFile(keyringPath, keyring);
  await writeFile(ascPath, signedManifest);
  const fingerprints = run("gpg", ["--batch", "--no-default-keyring", "--keyring", keyringPath, "--with-colons", "--fingerprint"]).split("\n").filter((line) => line.startsWith("fpr:")).map((line) => line.split(":")[9]);
  if (!policy.keyring.allowedPrimaryFingerprints.every((fingerprint) => fingerprints.includes(fingerprint))) throw new Error("Node release keyring does not contain every reviewed primary key");
  run("gpgv", ["--keyring", keyringPath, "--output", manifestPath, ascPath]);
  const manifest = await readFile(manifestPath, "utf8");
  const expectedLine = `${selected.sha256}  ${selected.archive}`;
  if (!manifest.split(/\r?\n/).includes(expectedLine)) throw new Error("signed Node checksum manifest does not authorize selected archive");

  const expectedRoot = selected.archive.replace(/\.(?:tar\.xz|tar\.gz|zip)$/u, "");
  const required = [`${expectedRoot}/${selected.nodePath}`, `${expectedRoot}/LICENSE`];
  const extract = join(cache, "extracted");
  await rm(extract, { recursive: true, force: true }); await mkdir(extract);
  if (selected.archive.endsWith(".zip")) {
    const listing = run("zipinfo", ["-1", archivePath]).trim().split("\n").map((name) => ({ name, type: name.endsWith("/") ? "directory" as const : "file" as const }));
    validateSelectedRuntimeEntries(listing, expectedRoot, required);
    run("unzip", ["-q", archivePath, ...required, "-d", extract]);
  } else {
    const names = run("tar", ["-tf", archivePath]).trim().split("\n");
    const verbose = run("tar", ["-tvf", archivePath]).trim().split("\n");
    validateSelectedRuntimeEntries(names.map((name, index) => ({ name, type: verbose[index]?.startsWith("d") ? "directory" : verbose[index]?.startsWith("-") ? "file" : "link" })), expectedRoot, required);
    run("tar", ["-xf", archivePath, "-C", extract, ...required]);
  }
  const runtimeRoot = join(extract, expectedRoot);
  const node = resolve(runtimeRoot, selected.nodePath);
  if (!node.startsWith(`${resolve(runtimeRoot)}${sep}`)) throw new Error("unsafe runtime executable policy path");
  const nodeStat = await stat(node); if (!nodeStat.isFile()) throw new Error("Node runtime executable is missing");
  await chmod(node, 0o755).catch(() => undefined);
  const versionOutput = target === `${process.platform}-${process.arch}` ? run(node, ["--version"]).trim() : `v${policy.version}`;
  if (versionOutput !== `v${policy.version}`) throw new Error("Node runtime binary version mismatch");
  return { runtimeRoot, evidence: { version: policy.version, target, sourceUrl: `${policy.origin}/dist/v${policy.version}/${selected.archive}`, archive: selected.archive, archiveSha256: selected.sha256, executableSha256: sha256(await readFile(node)), signedManifest: "SHASUMS256.txt.asc", keyringSha256: policy.keyring.sha256 } };
}
