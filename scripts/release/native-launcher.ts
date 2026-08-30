import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizedReleaseEnvironment, trustedTool } from "./trusted-tools.ts";

export type NativeLauncherTarget = "linux-x64" | "darwin-x64";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = join(root, "scripts/release/native-launcher.c");

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: sanitizedReleaseEnvironment({ SOURCE_DATE_EPOCH: "315532800", ZERO_AR_DATE: "1" })
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed while building the native launcher: ${result.stderr || result.stdout || result.error?.message}`);
  }
}

export async function buildNativeLauncher(target: NativeLauncherTarget, destination: string): Promise<void> {
  const hostTarget = `${process.platform}-${process.arch}`;
  if (hostTarget !== target) throw new Error(`native launcher ${target} must be built on its matching reviewed host`);
  await mkdir(dirname(destination), { recursive: true });
  const common = [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-fstack-protector-strong",
    "-D_FORTIFY_SOURCE=2",
    source,
    "-o",
    destination
  ];
  if (target === "linux-x64") {
    run(trustedTool("cc"), [
      ...common,
      "-static-pie",
      "-Wl,-z,relro,-z,now,--build-id=none",
      "-s"
    ]);
  } else {
    run(trustedTool("cc"), [
      ...common,
      "-arch",
      "x86_64",
      "-mmacosx-version-min=13.0",
      "-Wl,-dead_strip"
    ]);
    run(trustedTool("codesign"), [
      "--force",
      "--sign",
      "-",
      "--identifier",
      "com.bluedot.odinn.native-launcher",
      "--options",
      "runtime",
      "--timestamp=none",
      destination
    ]);
    run(trustedTool("codesign"), ["--verify", "--strict", "--verbose=2", destination]);
  }
  await chmod(destination, 0o755);
  verifyNativeLauncher(await readFile(destination), target);
}

export function verifyNativeLauncher(bytes: Buffer, target: NativeLauncherTarget): void {
  if (target === "linux-x64") verifyStaticLinuxLauncher(bytes);
  else verifyHardenedDarwinLauncher(bytes);
}

function verifyStaticLinuxLauncher(bytes: Buffer): void {
  if (bytes.length < 64
    || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    || bytes[4] !== 2
    || bytes[5] !== 1
    || bytes.readUInt16LE(16) !== 3
    || bytes.readUInt16LE(18) !== 0x3e) {
    throw new Error("Linux native launcher must be an x64 static PIE ELF executable");
  }
  const programOffset = safeNumber(bytes.readBigUInt64LE(32), "ELF program header offset");
  const programEntryBytes = bytes.readUInt16LE(54);
  const programEntries = bytes.readUInt16LE(56);
  if (programEntryBytes < 56 || programEntries === 0 || programOffset + programEntryBytes * programEntries > bytes.length) {
    throw new Error("Linux native launcher has malformed ELF program headers");
  }
  let loadSegments = 0;
  for (let index = 0; index < programEntries; index += 1) {
    const offset = programOffset + index * programEntryBytes;
    const type = bytes.readUInt32LE(offset);
    if (type === 3) throw new Error("Linux native launcher must not contain a dynamic interpreter");
    if (type === 1) loadSegments += 1;
    if (type !== 2) continue;
    const dynamicOffset = safeNumber(bytes.readBigUInt64LE(offset + 8), "ELF dynamic offset");
    const dynamicBytes = safeNumber(bytes.readBigUInt64LE(offset + 32), "ELF dynamic size");
    if (dynamicBytes % 16 !== 0 || dynamicOffset + dynamicBytes > bytes.length) {
      throw new Error("Linux native launcher has a malformed dynamic segment");
    }
    for (let entry = dynamicOffset; entry < dynamicOffset + dynamicBytes; entry += 16) {
      if (bytes.readBigUInt64LE(entry) === 1n) throw new Error("Linux native launcher must not depend on shared libraries");
    }
  }
  if (loadSegments === 0) throw new Error("Linux native launcher has no loadable segments");
}

function verifyHardenedDarwinLauncher(bytes: Buffer): void {
  if (bytes.length < 32
    || bytes.readUInt32LE(0) !== 0xfeedfacf
    || bytes.readUInt32LE(4) !== 0x01000007
    || bytes.readUInt32LE(12) !== 2
    || (bytes.readUInt32LE(24) & 0x20_0000) === 0) {
    throw new Error("macOS native launcher must be an x64 PIE Mach-O executable");
  }
  const commandCount = bytes.readUInt32LE(16);
  const commandBytes = bytes.readUInt32LE(20);
  if (commandCount === 0 || 32 + commandBytes > bytes.length) throw new Error("macOS native launcher has malformed load commands");
  let offset = 32;
  let signature: { offset: number; bytes: number } | undefined;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > 32 + commandBytes) throw new Error("macOS native launcher has a truncated load command");
    const command = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > 32 + commandBytes) throw new Error("macOS native launcher has a malformed load command");
    if (command === 0x1d) {
      if (size < 16 || signature) throw new Error("macOS native launcher has invalid code-signature commands");
      signature = { offset: bytes.readUInt32LE(offset + 8), bytes: bytes.readUInt32LE(offset + 12) };
    }
    offset += size;
  }
  if (offset !== 32 + commandBytes || !signature || signature.offset + signature.bytes > bytes.length) {
    throw new Error("macOS native launcher is missing its embedded code signature");
  }
  verifyHardenedCodeSignature(bytes.subarray(signature.offset, signature.offset + signature.bytes));
}

function verifyHardenedCodeSignature(signature: Buffer): void {
  if (signature.length < 12 || signature.readUInt32BE(0) !== 0xfade0cc0) {
    throw new Error("macOS native launcher has a malformed embedded code signature");
  }
  const declaredLength = signature.readUInt32BE(4);
  if (declaredLength < 12 || declaredLength > signature.length
    || signature.subarray(declaredLength).some((byte) => byte !== 0)) {
    throw new Error("macOS native launcher has a malformed embedded code signature");
  }
  signature = signature.subarray(0, declaredLength);
  const count = signature.readUInt32BE(8);
  if (count === 0 || 12 + count * 8 > signature.length) throw new Error("macOS native launcher has an empty embedded code signature");
  let hardenedCodeDirectory = false;
  for (let index = 0; index < count; index += 1) {
    const type = signature.readUInt32BE(12 + index * 8);
    const offset = signature.readUInt32BE(16 + index * 8);
    if (offset + 8 > signature.length) throw new Error("macOS native launcher has a malformed signature slot");
    const length = signature.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > signature.length) throw new Error("macOS native launcher has a truncated signature slot");
    if (type === 5 || type === 7) throw new Error("macOS native launcher must not carry security-relaxing entitlements");
    if ((type === 0 || (type >= 0x1000 && type <= 0x1005))
      && signature.readUInt32BE(offset) === 0xfade0c02
      && length >= 16
      && (signature.readUInt32BE(offset + 12) & 0x1_0000) !== 0) {
      hardenedCodeDirectory = true;
    }
  }
  if (!hardenedCodeDirectory) throw new Error("macOS native launcher code signature does not enable the hardened runtime");
}

function safeNumber(value: bigint, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} is outside the supported range`);
  return result;
}

// Bundlers inline this module into the installer. In that case import.meta.url
// points at the installer bundle, so comparing it with argv[1] would wrongly
// execute this module's CLI during every normal install.
const invokedAsNativeLauncher = /(?:^|[\\/])native-launcher(?:\.[cm]?[jt]s)?$/u.test(process.argv[1] ?? "");
if (invokedAsNativeLauncher && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] as NativeLauncherTarget;
  const destination = process.argv[3];
  if ((target !== "linux-x64" && target !== "darwin-x64") || !destination) {
    throw new Error("usage: native-launcher.ts linux-x64|darwin-x64 OUTPUT");
  }
  await buildNativeLauncher(target, resolve(destination));
}
