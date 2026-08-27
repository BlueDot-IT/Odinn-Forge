import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  readRuntimePolicy,
  runtimePolicySha256,
  validateArchiveEntries,
  verifyRuntimeExecutableIdentity
} from "../scripts/release/node-runtime.ts";

const root = resolve(import.meta.dirname, "..");

test("controlled Node runtime policy pins an exact reviewed x64 matrix", async () => {
  const policy = await readRuntimePolicy(root);
  const policyBytes = await readFile(resolve(root, "release/node-runtime-policy.json"));
  assert.match(policy.version, /^24\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(policy.targets).sort(), ["darwin-x64", "linux-x64", "win32-x64"]);
  assert.ok(policy.keyring.allowedPrimaryFingerprints.length >= 3);
  assert.match(policy.keyring.url, /\/nodejs\/release-keys\/[a-f0-9]{40}\/gpg-only-active-keys\/pubring\.kbx$/u);
  assert.match(policy.keyring.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(policy.keyring.bytes > 0);
  assert.match(policy.signedManifest.sha256, /^[a-f0-9]{64}$/u);
  assert.match(policy.signedManifest.cleartextSha256, /^[a-f0-9]{64}$/u);
  assert.equal(await runtimePolicySha256(root), createHash("sha256").update(policyBytes).digest("hex"));
  for (const target of Object.values(policy.targets)) {
    assert.ok(target.bytes > 0);
    assert.match(target.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(target.executableBytes > 0);
    assert.match(target.executableSha256, /^[a-f0-9]{64}$/u);
  }
});

test("runtime archive validation rejects traversal, absolute paths, aliases, links, devices, and alien roots", () => {
  const valid = [{ name: "node-v24/bin/node", type: "file" as const }];
  assert.doesNotThrow(() => validateArchiveEntries(valid, "node-v24"));
  assert.throws(() => validateArchiveEntries([{ name: "node-v24/../escape", type: "file" }], "node-v24"), /unsafe/);
  assert.throws(() => validateArchiveEntries([{ name: "/node-v24/bin/node", type: "file" }], "node-v24"), /unsafe/);
  assert.throws(() => validateArchiveEntries([{ name: "C:/node-v24/node.exe", type: "file" }], "node-v24"), /unsafe/);
  assert.throws(() => validateArchiveEntries([{ name: "node-v24\\node.exe", type: "file" }], "node-v24"), /unsafe/);
  assert.throws(() => validateArchiveEntries([{ name: "node-v24//node", type: "file" }], "node-v24"), /unsafe/);
  assert.throws(() => validateArchiveEntries([{ name: "node-v24/node:stream", type: "file" }], "node-v24"), /unsafe/);
  assert.throws(() => validateArchiveEntries([{ name: "node-v24/AUX.txt", type: "file" }], "node-v24"), /unsafe/);
  assert.throws(() => validateArchiveEntries([{ name: "node-v24/runtime. ", type: "file" }], "node-v24"), /unsafe/);
  assert.throws(() => validateArchiveEntries([...valid, ...valid], "node-v24"), /duplicate/);
  assert.throws(() => validateArchiveEntries([...valid, { name: "NODE-V24/BIN/NODE", type: "file" }], "node-v24"), /duplicate/);
  assert.throws(() => validateArchiveEntries([{ name: "node-v24/node", type: "link" }], "node-v24"), /unsupported/);
  assert.throws(() => validateArchiveEntries([{ name: "node-v24/node", type: "device" }], "node-v24"), /unsupported/);
  assert.throws(() => validateArchiveEntries([{ name: "other/node", type: "file" }], "node-v24"), /top-level/);
});

test("embedded runtime identity rejects executable formats for the wrong platform or architecture", () => {
  const elf = Buffer.alloc(64);
  Buffer.from("7f454c46", "hex").copy(elf);
  elf[4] = 2;
  elf[5] = 1;
  elf.writeUInt16LE(0x3e, 18);
  assert.doesNotThrow(() => verifyRuntimeExecutableIdentity(elf, "linux-x64"));
  assert.throws(() => verifyRuntimeExecutableIdentity(elf, "darwin-x64"), /macOS x64/u);

  const macho = Buffer.alloc(64);
  macho.writeUInt32LE(0xfeedfacf, 0);
  macho.writeUInt32LE(0x01000007, 4);
  assert.doesNotThrow(() => verifyRuntimeExecutableIdentity(macho, "darwin-x64"));
  macho.writeUInt32LE(0x0100000c, 4);
  assert.throws(() => verifyRuntimeExecutableIdentity(macho, "darwin-x64"), /macOS x64/u);

  const pe = Buffer.alloc(256);
  pe.write("MZ", 0, "ascii");
  pe.writeUInt32LE(0x80, 0x3c);
  pe.writeUInt32LE(0x00004550, 0x80);
  pe.writeUInt16LE(0x8664, 0x84);
  assert.doesNotThrow(() => verifyRuntimeExecutableIdentity(pe, "win32-x64"));
  pe.writeUInt16LE(0xaa64, 0x84);
  assert.throws(() => verifyRuntimeExecutableIdentity(pe, "win32-x64"), /Windows x64/u);
});

test("standalone launchers use only the relative embedded runtime and sanitize Node hooks", async () => {
  const source = await readFile(resolve(root, "scripts/release/package-standalone.ts"), "utf8");
  const launchers = await readFile(resolve(root, "scripts/release/standalone-launchers.ts"), "utf8");
  const installer = await readFile(resolve(root, "scripts/install.ts"), "utf8");
  assert.match(launchers, /runtime\/node/);
  assert.match(launchers, /"NODE_OPTIONS"/u);
  assert.match(launchers, /"NODE_PATH"/u);
  assert.match(launchers, /"NODE_TLS_REJECT_UNAUTHORIZED"/u);
  assert.match(launchers, /unset \$\{HOSTILE_NODE_ENVIRONMENT_VARIABLES\.join/u);
  assert.match(launchers, /Assert-OdinnPhysicalPath/u);
  assert.match(installer, /Assert-OdinnPhysicalPath/u);
  assert.match(launchers, /C:\\Windows\\System32\\WindowsPowerShell/u);
  assert.match(installer, /C:\\Windows\\System32\\WindowsPowerShell/u);
  assert.doesNotMatch(launchers, /%SystemRoot%/u);
  assert.doesNotMatch(installer, /%SystemRoot%/u);
  assert.match(source, /const first = join\(temporary, `first\.\$\{extension\}`\)/u);
  assert.match(source, /const second = join\(temporary, `second\.\$\{extension\}`\)/u);
  assert.match(source, /if \(firstDigest !== secondDigest\) throw new Error/u);
  assert.match(source, /const publicationStage = await mkdtemp\(join\(output, "\.standalone-stage-"\)\)/u);
  assert.match(source, /await copyFile\(first, stagedArchive\)/u);
  assert.match(source, /await stagedHandle\.sync\(\)/u);
  assert.match(source, /await rename\(stagedArchive, join\(output, archiveName\)\)/u);
  assert.doesNotMatch(source, /await rename\(first, join\(output, archiveName\)\)/u);
  assert.doesNotMatch(launchers, /exec node /);
});
