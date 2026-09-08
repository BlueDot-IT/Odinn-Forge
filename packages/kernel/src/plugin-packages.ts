import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { zipSync } from "fflate";
import { createConnectorScaffold, validatePluginManifest, type PluginManifest } from "@odinn/plugin-sdk";
import { canonicalPortableArchivePath, portableArchivePathIdentity } from "./portable-archive-path.ts";

export const PLUGIN_PACKAGE_MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 1024;
const HEX = /^[a-f0-9]{64}$/u;
type Entries = Record<string, Buffer>;
export type PluginPackageInspection = Readonly<{
  manifest: PluginManifest;
  /** SHA-256 of deterministic ZIP bytes (including for source-directory inspection). */
  digest: string;
  archiveDigest: string;
  /** SHA-256 of every sorted path, length and file digest. */
  contentDigest: string;
  files: readonly string[];
  fileDigests: Readonly<Record<string, string>>;
  archivePath?: string;
}>;
export type ExtractedPluginPackage = PluginPackageInspection & Readonly<{ root: string }>;
function sha256(data: Uint8Array | string): string { return createHash("sha256").update(data).digest("hex"); }
function fail(message: string): never { throw new Error(`plugin package: ${message}`); }
function safeName(name: string): string {
  if (name.length > 512 || name.split("/").length > 17 || !/^[\x21-\x7e]+$/u.test(name)) fail("unsafe or excessive path");
  const canonical = canonicalPortableArchivePath(name);
  if (canonical !== name || name.endsWith("/") || name.split("/").some((part) => ["__proto__", "constructor", "prototype"].includes(part))) fail("noncanonical or reserved path");
  return canonical;
}
function validateNames(names: string[]): void {
  if (!names.length || names.length > MAX_FILES) fail("file count exceeds limit");
  const identities = new Set<string>();
  for (const name of names) {
    safeName(name);
    const identity = portableArchivePathIdentity(name);
    if (identities.has(identity)) fail("duplicate or case-colliding path");
    identities.add(identity);
  }
  for (const identity of identities) {
    const parts = identity.split("/");
    for (let index = 1; index < parts.length; index++) if (identities.has(parts.slice(0, index).join("/"))) fail("file path shadows a directory");
  }
}
function same(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.nlink === right.nlink;
}
async function physicalDirectory(path: string): Promise<Stats> {
  const absolute = resolve(path);
  if (await realpath(absolute) !== absolute) fail("directory must not traverse a symbolic link");
  const metadata = await lstat(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("expected physical directory");
  return metadata;
}
/** Read from one no-follow descriptor into a fixed maximum-sized buffer. */
export async function readBoundedPluginFile(path: string, maximum: number): Promise<Buffer> {
  await physicalDirectory(dirname(resolve(path)));
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) fail("expected bounded unlinked regular file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!same(before, await handle.stat())) fail("file changed before read");
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== before.size || !same(before, await handle.stat()) || !same(before, await lstat(path))) fail("file changed during read");
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}
async function directoryEntries(root: string, requireSealed = false): Promise<Entries> {
  const absolute = resolve(root), entries: Entries = Object.create(null);
  let count = 0, total = 0, directories = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 16 || ++directories > MAX_FILES) fail("directory count or depth exceeds limit");
    const before = await physicalDirectory(directory);
    if (requireSealed && (before.mode & 0o222)) fail("installed package directory is not sealed");
    const children: string[] = [];
    const stream = await opendir(directory);
    for await (const child of stream) {
      if (children.length >= MAX_FILES) fail("directory entry count exceeds limit");
      children.push(child.name);
    }
    for (const child of children.sort()) {
      const path = join(directory, child), name = safeName(relative(absolute, path).split(sep).join("/"));
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) fail("symbolic links are not supported");
      if (metadata.isDirectory()) await visit(path, depth + 1);
      else {
        if (++count > MAX_FILES || !metadata.isFile() || metadata.nlink !== 1 || metadata.size > MAX_FILE_BYTES || (total += metadata.size) > MAX_EXPANDED_BYTES) fail("unsupported file or expanded-size limit exceeded");
        if (requireSealed && (metadata.mode & 0o222)) fail("installed package file is not sealed");
        entries[name] = await readBoundedPluginFile(path, MAX_FILE_BYTES);
      }
    }
    if (!same(before, await lstat(directory))) fail("directory changed during read");
  };
  await visit(absolute, 0);
  validateNames(Object.keys(entries));
  return entries;
}
function makeArchive(entries: Entries): Buffer {
  const files: Record<string, Uint8Array> = Object.create(null);
  for (const name of Object.keys(entries).sort()) files[`plugin/${name}`] = entries[name]!;
  const archive = Buffer.from(zipSync(files, { level: 9, mtime: new Date(1980, 0, 1), os: 3, attrs: (0o100444 << 16) >>> 0 }));
  if (archive.length > PLUGIN_PACKAGE_MAX_ARCHIVE_BYTES) fail("archive exceeds limit");
  return archive;
}
function describe(entries: Entries, archive: Buffer, archivePath?: string): PluginPackageInspection {
  const data = entries["plugin.json"];
  if (!data?.length || data.length > 256 * 1024) fail("requires plugin.json up to 256 KiB");
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); } catch { return fail("plugin.json must be UTF-8 JSON"); }
  const manifest = validatePluginManifest(raw);
  if (!Object.hasOwn(entries, manifest.entrypoint)) fail("manifest entrypoint is missing");
  const files = Object.keys(entries).sort(), fileDigests: Record<string, string> = {};
  for (const name of files) fileDigests[name] = sha256(entries[name]!);
  const contentDigest = sha256(JSON.stringify(files.map((name) => [name, entries[name]!.length, fileDigests[name]])));
  const digest = sha256(archive);
  return Object.freeze({ manifest, digest, archiveDigest: digest, contentDigest, files: Object.freeze(files), fileDigests: Object.freeze(fileDigests), ...(archivePath ? { archivePath } : {}) });
}
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => { let crc = value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); return crc >>> 0; });
function crc32(bytes: Buffer): number { let crc = 0xffffffff; for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
/** Parse the entire metadata graph before bounded decompression or any filesystem writes. */
function archiveEntries(archive: Buffer): Entries {
  if (archive.length < 22 || archive.length > PLUGIN_PACKAGE_MAX_ARCHIVE_BYTES) fail("archive exceeds size limits");
  const end = archive.length - 22;
  if (archive.readUInt32LE(end) !== 0x06054b50 || archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6) || archive.readUInt16LE(end + 20)) fail("ZIP must have an uncommented single-disk layout");
  const count = archive.readUInt16LE(end + 10), centralSize = archive.readUInt32LE(end + 12), centralStart = archive.readUInt32LE(end + 16);
  if (!count || count > MAX_FILES || archive.readUInt16LE(end + 8) !== count || centralStart + centralSize !== end) fail("invalid ZIP central directory");
  type Entry = { name: string; offset: number; size: number; compressed: number; method: number; crc: number };
  const metadata: Entry[] = [];
  let central = centralStart, expectedLocal = 0, total = 0;
  for (let index = 0; index < count; index++) {
    if (central + 46 > end || archive.readUInt32LE(central) !== 0x02014b50) fail("invalid central entry");
    const madeBy = archive.readUInt16LE(central + 4), needed = archive.readUInt16LE(central + 6), flags = archive.readUInt16LE(central + 8), method = archive.readUInt16LE(central + 10);
    const crc = archive.readUInt32LE(central + 16), compressed = archive.readUInt32LE(central + 20), size = archive.readUInt32LE(central + 24), nameLength = archive.readUInt16LE(central + 28);
    const extra = archive.readUInt16LE(central + 30), comment = archive.readUInt16LE(central + 32), attrs = archive.readUInt32LE(central + 38), local = archive.readUInt32LE(central + 42);
    if (needed > 20 || (flags & ~0x800) || ![0, 8].includes(method) || extra || comment || archive.readUInt16LE(central + 34) || central + 46 + nameLength > end) fail("unsupported ZIP entry metadata (links, ZIP64, encryption and descriptors are not supported)");
    const mode = attrs >>> 16, kind = mode & 0o170000;
    if (![0, 3].includes(madeBy >>> 8) || (kind && kind !== 0o100000) || (attrs & 0x10) || (mode & 0o7000)) fail("ZIP contains a link, directory or special file");
    const rawName = archive.subarray(central + 46, central + 46 + nameLength).toString("utf8");
    if (!rawName.startsWith("plugin/")) fail("ZIP requires plugin/ root");
    const name = safeName(rawName.slice(7));
    if (Buffer.byteLength(rawName) !== nameLength || size > MAX_FILE_BYTES || (total += size) > MAX_EXPANDED_BYTES || compressed > PLUGIN_PACKAGE_MAX_ARCHIVE_BYTES) fail("ZIP entry exceeds bounds");
    if (local !== expectedLocal || local + 30 + nameLength > centralStart || archive.readUInt32LE(local) !== 0x04034b50) fail("ZIP has overlapping or inconsistent local entries");
    const localNameLength = archive.readUInt16LE(local + 26), localExtra = archive.readUInt16LE(local + 28);
    if (archive.readUInt16LE(local + 4) !== needed || archive.readUInt16LE(local + 6) !== flags || archive.readUInt16LE(local + 8) !== method || archive.readUInt32LE(local + 14) !== crc || archive.readUInt32LE(local + 18) !== compressed || archive.readUInt32LE(local + 22) !== size || localNameLength !== nameLength || localExtra || !archive.subarray(local + 30, local + 30 + nameLength).equals(archive.subarray(central + 46, central + 46 + nameLength))) fail("ZIP local and central metadata disagree");
    const offset = local + 30 + nameLength;
    expectedLocal = offset + compressed;
    if (expectedLocal > centralStart || (method === 0 && compressed !== size)) fail("ZIP compressed size is inconsistent");
    metadata.push({ name, offset, size, compressed, method, crc });
    central += 46 + nameLength;
  }
  if (central !== end || expectedLocal !== centralStart) fail("ZIP contains unlisted data");
  validateNames(metadata.map((entry) => entry.name));
  const entries: Entries = Object.create(null);
  for (const entry of metadata) {
    const compressed = archive.subarray(entry.offset, entry.offset + entry.compressed);
    let bytes: Buffer;
    try { bytes = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: entry.size + 1 }); }
    catch { return fail("ZIP decompression failed or exceeded declared size"); }
    if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) fail("ZIP content size or checksum mismatch");
    entries[entry.name] = bytes;
  }
  return entries;
}
export function inspectPluginPackageBytes(archive: Uint8Array, expectedDigest?: string): PluginPackageInspection {
  const bytes = Buffer.from(archive);
  if (expectedDigest !== undefined && (!HEX.test(expectedDigest) || sha256(bytes) !== expectedDigest)) fail("archive digest does not match requested identity");
  return describe(archiveEntries(bytes), bytes);
}
export async function inspectPluginPackageDirectory(root: string): Promise<PluginPackageInspection> {
  const entries = await directoryEntries(root); return describe(entries, makeArchive(entries));
}
export async function packPluginPackage(source: string, output: string): Promise<PluginPackageInspection> {
  const entries = await directoryEntries(source), archive = makeArchive(entries), archivePath = resolve(output);
  const description = describe(entries, archive, archivePath);
  await physicalDirectory(dirname(archivePath));
  await writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
  return description;
}
export async function inspectPluginPackageArchive(archivePath: string, expectedDigest?: string): Promise<PluginPackageInspection> {
  const absolute = resolve(archivePath), archive = await readBoundedPluginFile(absolute, PLUGIN_PACKAGE_MAX_ARCHIVE_BYTES);
  return Object.freeze({ ...inspectPluginPackageBytes(archive, expectedDigest), archivePath: absolute });
}
export async function extractPluginPackageArchive(archivePath: string, destination: string, expectedDigest?: string): Promise<ExtractedPluginPackage> {
  const absolute = resolve(archivePath), archive = await readBoundedPluginFile(absolute, PLUGIN_PACKAGE_MAX_ARCHIVE_BYTES);
  const inspection = inspectPluginPackageBytes(archive, expectedDigest), entries = archiveEntries(archive), root = resolve(destination);
  await physicalDirectory(dirname(root));
  await mkdir(root, { mode: 0o700 }); // exclusive: never replace an existing or linked installation
  const directories = new Set([root]);
  for (const name of inspection.files) {
    const target = join(root, name), parent = dirname(target);
    let current = root;
    for (const segment of relative(root, parent).split(sep).filter(Boolean)) {
      current = join(current, segment);
      if (!directories.has(current)) { await mkdir(current, { mode: 0o700 }); directories.add(current); }
    }
    await physicalDirectory(parent);
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(entries[name]!); await handle.chmod(0o444); await handle.sync(); }
    finally { await handle.close(); }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) { await physicalDirectory(directory); await chmod(directory, 0o555); }
  await verifyPluginPackageDirectory(root, inspection.contentDigest);
  return Object.freeze({ ...inspection, archivePath: absolute, root });
}
export async function verifyPluginPackageDirectory(root: string, expectedContentDigest: string): Promise<PluginPackageInspection> {
  if (!HEX.test(expectedContentDigest)) fail("requires an expected content digest");
  const entries = await directoryEntries(root, true), inspection = describe(entries, makeArchive(entries));
  if (inspection.contentDigest !== expectedContentDigest) fail("installed content no longer matches sealed identity");
  return inspection;
}
export async function scaffoldPlugin(root: string, id: string, containerImage?: string): Promise<PluginManifest> {
  const scaffold = createConnectorScaffold(id, containerImage), destination = resolve(root);
  await physicalDirectory(dirname(destination));
  await mkdir(destination, { mode: 0o700 });
  for (const [name, content] of Object.entries(scaffold.files)) await writeFile(join(destination, name), content, { flag: "wx", mode: 0o600 });
  return scaffold.manifest;
}
