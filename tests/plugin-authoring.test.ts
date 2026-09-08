import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { createConnectorScaffold, validatePluginManifest } from "../packages/plugin-sdk/src/index.ts";
import { extractPluginPackageArchive, inspectPluginPackageArchive, inspectPluginPackageBytes, inspectPluginPackageDirectory, packPluginPackage, scaffoldPlugin, verifyPluginPackageDirectory } from "../packages/kernel/src/plugin-packages.ts";
const manifest = createConnectorScaffold("fixture-connector").manifest;
test("SDK rejects unsupported authority, runtime, identifiers, image and schema", () => {
  for (const invalid of [{ ...manifest, id: "a" }, { ...manifest, id: "api-client" }, { ...manifest, runtime: "host-adapter" }, { ...manifest, containerImage: "node:latest" }, { ...manifest, entrypoint: "../server.mjs" }, { ...manifest, tools: [{ ...manifest.tools[0], capabilities: ["weather.read"] }] }, { ...manifest, services: [{ ...manifest.services[0], origin: "https://api.open-meteo.com/path" }] }, { ...manifest, services: [{ ...manifest.services[0], credential: "MISSING_TOKEN" }] }, { ...manifest, tools: [{ ...manifest.tools[0], inputSchema: { type: "object", properties: { clientId: { type: "string" } }, required: [], additionalProperties: false } }] }, { ...manifest, tools: [{ ...manifest.tools[0], inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 16385 } }, required: [], additionalProperties: false } }] }]) assert.throws(() => validatePluginManifest(invalid), /invalid plugin manifest/);
});
test("deterministic ZIP binds archive bytes and every sealed extracted file", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-plugin-authoring-")), source = join(root, "source");
  await scaffoldPlugin(source, "fixture-connector"); await mkdir(join(source, "lib")); await writeFile(join(source, "lib/helper.mjs"), "export const value=1;\n");
  const first = await packPluginPackage(source, join(root, "first.zip")), second = await packPluginPackage(source, join(root, "second.zip"));
  assert.equal(first.digest, createHash("sha256").update(await readFile(first.archivePath!)).digest("hex")); assert.equal(first.digest, second.digest);
  assert.equal((await inspectPluginPackageDirectory(source)).digest, first.digest);
  assert.deepEqual((await inspectPluginPackageArchive(first.archivePath!, first.digest)).fileDigests, first.fileDigests);
  const installed = await extractPluginPackageArchive(first.archivePath!, join(root, "installed"), first.digest);
  assert.equal((await lstat(join(installed.root, "server.mjs"))).mode & 0o222, 0);
  assert.equal((await verifyPluginPackageDirectory(installed.root, first.contentDigest)).contentDigest, first.contentDigest);
  await assert.rejects(() => extractPluginPackageArchive(first.archivePath!, installed.root), /EEXIST/);
  await assert.rejects(() => inspectPluginPackageArchive(first.archivePath!, "0".repeat(64)), /digest/);
  await chmod(join(installed.root, "server.mjs"), 0o644); await writeFile(join(installed.root, "server.mjs"), "altered"); await chmod(join(installed.root, "server.mjs"), 0o444);
  await assert.rejects(() => verifyPluginPackageDirectory(installed.root, first.contentDigest), /sealed identity/);
});
test("source links and output overwrites are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-plugin-links-")), source = join(root, "source"); await scaffoldPlugin(source, "fixture-connector");
  await symlink(join(source, "server.mjs"), join(source, "alias.mjs")); await assert.rejects(() => inspectPluginPackageDirectory(source), /symbolic/);
  const hard = join(root, "hard"); await scaffoldPlugin(hard, "hard-fixture"); await link(join(hard, "server.mjs"), join(root, "outside.mjs")); await assert.rejects(() => inspectPluginPackageDirectory(hard), /unsupported|unlinked/);
  const clean = join(root, "clean"); await scaffoldPlugin(clean, "clean-fixture"); const output = join(root, "existing.zip"); await writeFile(output, "keep");
  await assert.rejects(() => packPluginPackage(clean, output), /EEXIST/); assert.equal(await readFile(output, "utf8"), "keep");
});
test("archive admission rejects unsafe paths, case collisions, special files and false expansion sizes", () => {
  const files = Object.fromEntries(Object.entries(createConnectorScaffold("fixture-connector").files).map(([name, content]) => [`plugin/${name}`, Buffer.from(content)]));
  const zip = (values: Parameters<typeof zipSync>[0]) => Buffer.from(zipSync(values, { level: 9, mtime: new Date(1980, 0, 1) }));
  for (const name of ["plugin/../escape", "elsewhere/file", "plugin/C:/escape", "plugin/SERVER.mjs"]) assert.throws(() => inspectPluginPackageBytes(zip({ ...files, [name]: Buffer.from("data") })), /path|root|duplicate|collid/i);
  assert.throws(() => inspectPluginPackageBytes(zip({ ...files, "plugin/special": [Buffer.from("link"), { os: 3, attrs: (0o120777 << 16) >>> 0 }] })), /special|link/);
  const archive = zip({ ...files, "plugin/large.txt": Buffer.alloc(128 * 1024, 65) }); const end = archive.length - 22; let central = archive.readUInt32LE(end + 16);
  while (central < end) { const n = archive.readUInt16LE(central + 28); if (archive.subarray(central + 46, central + 46 + n).toString() === "plugin/large.txt") { archive.writeUInt32LE(1, archive.readUInt32LE(central + 42) + 22); archive.writeUInt32LE(1, central + 24); break; } central += 46 + n + archive.readUInt16LE(central + 30) + archive.readUInt16LE(central + 32); }
  assert.throws(() => inspectPluginPackageBytes(archive), /decompression|size/);
});
test("npm tarball works in an unrelated JS/TS consumer without a kernel or TS loader", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-plugin-consumer-"));
  const run = (program: string, args: string[], cwd: string) => { const result = spawnSync(program, args, { cwd, encoding: "utf8", timeout: 30000 }); assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`); return result.stdout; };
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], resolve("packages/plugin-sdk")))[0].filename;
  const consumer = join(root, "consumer"); await mkdir(consumer); await writeFile(join(consumer, "package.json"), '{"name":"external-consumer","private":true,"type":"module"}\n');
  run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", join(root, packed)], consumer);
  assert.match(run(process.execPath, ["--input-type=module", "-e", "import {createConnectorScaffold} from '@odinn/plugin-sdk'; console.log(createConnectorScaffold('external-weather').manifest.id)"], consumer), /external-weather/);
  run(process.execPath, [join(consumer, "node_modules/@odinn/plugin-sdk/lib/cli.js"), "scaffold", "outside-weather"], consumer);
  await writeFile(join(consumer, "consumer.mts"), "import {createConnectorScaffold, type PluginManifest} from '@odinn/plugin-sdk'; const value: PluginManifest=createConnectorScaffold('typed-weather').manifest; void value;\n");
  run(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--module", "nodenext", "--target", "es2023", "consumer.mts"], consumer);
});
