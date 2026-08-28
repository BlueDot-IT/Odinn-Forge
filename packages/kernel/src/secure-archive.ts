import { chmodSync, createReadStream, closeSync, constants, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { dirname, join, parse, resolve, sep } from "node:path";
import { Unzip, UnzipInflate } from "fflate";
import { canonicalPortableArchivePath, portableArchivePathIdentity } from "./portable-archive-path.ts";

export type SecureArchiveEntry = {
  name: string;
  type: "file" | "directory" | "link" | "device";
  bytes: number;
  mode: number;
};

export type SecureArchiveOptions = {
  expectedRoot: string;
  maximumArchiveBytes?: number;
  maximumEntries?: number;
  maximumEntryBytes?: number;
  maximumExpandedBytes?: number;
};

const DEFAULT_MAXIMUM_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAXIMUM_ENTRIES = 50_000;
const DEFAULT_MAXIMUM_ENTRY_BYTES = 768 * 1024 * 1024;
const DEFAULT_MAXIMUM_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
const ZIP_EOCD_MAXIMUM_BYTES = 65_557;
const ZIP_CENTRAL_DIRECTORY_MAXIMUM_BYTES = 64 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;
const TAR_METADATA_MAXIMUM_BYTES = 2 * 1024 * 1024;
const TAR_PAX_MAXIMUM_RECORDS = 4_096;
const TAR_PAX_KEY_MAXIMUM_BYTES = 4_096;

type ResolvedOptions = Required<SecureArchiveOptions>;
type ZipEntry = SecureArchiveEntry & {
  compressedBytes: number;
  compression: number;
  crc32: number;
};
type TarHooks = {
  onEntry?: (entry: SecureArchiveEntry) => void | Promise<void>;
  onData?: (entry: SecureArchiveEntry, data: Buffer) => void | Promise<void>;
  onEnd?: (entry: SecureArchiveEntry) => void | Promise<void>;
};

function resolvedOptions(options: SecureArchiveOptions): ResolvedOptions {
  const result = {
    expectedRoot: normalizeArchivePath(options.expectedRoot),
    maximumArchiveBytes: options.maximumArchiveBytes ?? DEFAULT_MAXIMUM_ARCHIVE_BYTES,
    maximumEntries: options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES,
    maximumEntryBytes: options.maximumEntryBytes ?? DEFAULT_MAXIMUM_ENTRY_BYTES,
    maximumExpandedBytes: options.maximumExpandedBytes ?? DEFAULT_MAXIMUM_EXPANDED_BYTES
  };
  for (const [name, value] of Object.entries(result).filter(([name]) => name !== "expectedRoot")) {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`secure archive ${name} is invalid`);
  }
  return result;
}

function normalizeArchivePath(raw: string): string {
  const label = archivePathLabel(raw);
  try {
    return canonicalPortableArchivePath(raw);
  } catch {
    throw new Error(`release archive contains an unsafe path: ${label}`);
  }
}

function archivePathLabel(raw: string): string {
  const prefix = raw.slice(0, 160).replace(/[\0-\x1f\x7f]/gu, "?");
  return `${JSON.stringify(prefix)}${raw.length > prefix.length ? `…(${raw.length} characters)` : ""}`;
}

function paxMetadataKeyLabel(raw: string): string {
  const prefix = raw.slice(0, 160).replace(/[\0-\x1f\x7f]/gu, "?");
  return `${JSON.stringify(prefix)}${raw.length > prefix.length ? `…(${raw.length} characters)` : ""}`;
}

function archiveIdentity(name: string): string {
  return portableArchivePathIdentity(name);
}

function validateEntries(entries: SecureArchiveEntry[], options: ResolvedOptions): SecureArchiveEntry[] {
  if (!entries.length) throw new Error("release archive is empty");
  if (entries.length > options.maximumEntries) throw new Error("release archive exceeds the entry limit");
  const seen = new Map<string, SecureArchiveEntry>();
  let expandedBytes = 0;
  for (const entry of entries) {
    entry.name = normalizeArchivePath(entry.name);
    const identity = archiveIdentity(entry.name);
    if (seen.has(identity)) throw new Error(`release archive contains a duplicate or case-colliding path: ${archivePathLabel(entry.name)}`);
    seen.set(identity, entry);
    if (entry.name !== options.expectedRoot && !entry.name.startsWith(`${options.expectedRoot}/`)) {
      throw new Error(`release archive contains an unexpected top-level path: ${archivePathLabel(entry.name)}`);
    }
    if (entry.type === "link") throw new Error(`release archive contains a symbolic or hard link: ${archivePathLabel(entry.name)}`);
    if (entry.type === "device") throw new Error(`release archive contains a device, FIFO, socket, or unsupported entry: ${archivePathLabel(entry.name)}`);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > options.maximumEntryBytes) {
      throw new Error(`release archive entry exceeds the expanded-size limit: ${archivePathLabel(entry.name)}`);
    }
    expandedBytes += entry.bytes;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > options.maximumExpandedBytes) {
      throw new Error("release archive exceeds the expanded-size limit");
    }
  }
  const orderedIdentities = [...seen.keys()].sort();
  for (let orderedIndex = 0; orderedIndex < orderedIdentities.length; orderedIndex += 1) {
    const identity = orderedIdentities[orderedIndex]!;
    const entry = seen.get(identity)!;
    const parts = entry.name.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = seen.get(archiveIdentity(parts.slice(0, index).join("/")));
      if (ancestor && ancestor.type !== "directory") {
        throw new Error(`release archive path descends through a non-directory: ${archivePathLabel(entry.name)}`);
      }
    }
    if (entry.type === "file") {
      const prefix = `${identity}/`;
      if (orderedIdentities[orderedIndex + 1]?.startsWith(prefix)) {
        throw new Error(`release archive file shadows another path: ${archivePathLabel(entry.name)}`);
      }
    }
  }
  return entries;
}

async function assertPhysicalArchive(path: string, maximumBytes: number): Promise<number> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("release archive must be a physical regular file");
  }
  if (metadata.size <= 0 || metadata.size > maximumBytes) throw new Error("release archive exceeds the compressed-size limit");
  return metadata.size;
}

async function assertPhysicalAncestors(path: string, label: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const relative = absolute.slice(root.length).split(sep).filter(Boolean);
  let cursor = root;
  for (const part of relative) {
    cursor = join(cursor, part);
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) {
        const physicalPath = await realpath(cursor);
        const physical = await lstat(physicalPath);
        const reviewedDarwinRootAlias = process.platform === "darwin"
          && metadata.uid === 0
          && physical.isDirectory()
          && !physical.isSymbolicLink()
          && physical.uid === 0
          && (physical.mode & 0o022) === 0;
        if (!reviewedDarwinRootAlias) throw new Error(`${label} must not traverse a symbolic link or reparse point`);
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
}

function zipEntryType(name: string, madeBy: number, attributes: number): SecureArchiveEntry["type"] {
  const host = madeBy >>> 8;
  const unixMode = host === 3 ? attributes >>> 16 : 0;
  const kind = unixMode & 0o170000;
  if (name.endsWith("/") || kind === 0o040000 || (attributes & 0x10) !== 0) return "directory";
  if (kind === 0o120000) return "link";
  if (kind !== 0 && kind !== 0o100000) return "device";
  return "file";
}

async function inspectZip(path: string, archiveBytes: number, options: ResolvedOptions): Promise<ZipEntry[]> {
  const descriptor = await open(path, "r");
  try {
    const tailBytes = Math.min(archiveBytes, ZIP_EOCD_MAXIMUM_BYTES);
    const tail = Buffer.allocUnsafe(tailBytes);
    await descriptor.read(tail, 0, tailBytes, archiveBytes - tailBytes);
    let endOffset = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break; }
    }
    if (endOffset < 0) throw new Error("release ZIP archive is missing its central directory");
    const disk = tail.readUInt16LE(endOffset + 4);
    const centralDisk = tail.readUInt16LE(endOffset + 6);
    const diskEntries = tail.readUInt16LE(endOffset + 8);
    const entries = tail.readUInt16LE(endOffset + 10);
    const centralBytes = tail.readUInt32LE(endOffset + 12);
    const centralOffset = tail.readUInt32LE(endOffset + 16);
    const commentBytes = tail.readUInt16LE(endOffset + 20);
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries || entries === 0xffff
      || centralBytes === 0xffffffff || centralOffset === 0xffffffff
      || endOffset + 22 + commentBytes !== tail.length
      || centralBytes > ZIP_CENTRAL_DIRECTORY_MAXIMUM_BYTES
      || centralOffset + centralBytes > archiveBytes) {
      throw new Error("release ZIP archive uses an unsupported, multi-disk, ZIP64, or malformed layout");
    }
    const central = Buffer.allocUnsafe(centralBytes);
    await descriptor.read(central, 0, centralBytes, centralOffset);
    const result: ZipEntry[] = [];
    let offset = 0;
    for (let index = 0; index < entries; index += 1) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) {
        throw new Error("release ZIP archive has an invalid central directory entry");
      }
      const madeBy = central.readUInt16LE(offset + 4);
      const flags = central.readUInt16LE(offset + 8);
      const compression = central.readUInt16LE(offset + 10);
      const crc32 = central.readUInt32LE(offset + 16);
      const compressedBytes = central.readUInt32LE(offset + 20);
      const bytes = central.readUInt32LE(offset + 24);
      const nameBytes = central.readUInt16LE(offset + 28);
      const extraBytes = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const diskStart = central.readUInt16LE(offset + 34);
      const attributes = central.readUInt32LE(offset + 38);
      const localOffset = central.readUInt32LE(offset + 42);
      const end = offset + 46 + nameBytes + extraBytes + commentLength;
      if ((flags & 1) !== 0 || (flags & 0x40) !== 0 || diskStart !== 0
        || compressedBytes === 0xffffffff || bytes === 0xffffffff || localOffset === 0xffffffff
        || (compression !== 0 && compression !== 8) || end > central.length || localOffset >= centralOffset) {
        throw new Error("release ZIP archive contains an encrypted, ZIP64, unsupported, or malformed entry");
      }
      const rawName = central.subarray(offset + 46, offset + 46 + nameBytes)
        .toString((flags & 0x800) !== 0 ? "utf8" : "latin1");
      result.push({
        name: normalizeArchivePath(rawName),
        type: zipEntryType(rawName, madeBy, attributes),
        bytes,
        mode: madeBy >>> 8 === 3 ? (attributes >>> 16) & 0o777 : 0,
        compressedBytes,
        compression,
        crc32
      });
      offset = end;
    }
    if (offset !== central.length) throw new Error("release ZIP central directory length is inconsistent");
    return validateEntries(result, options) as ZipEntry[];
  } finally {
    await descriptor.close();
  }
}

function tarString(block: Buffer, offset: number, length: number): string {
  const end = block.indexOf(0, offset);
  const sliceEnd = end >= offset && end < offset + length ? end : offset + length;
  return new TextDecoder("utf-8", { fatal: true }).decode(block.subarray(offset, sliceEnd));
}

function tarNumber(block: Buffer, offset: number, length: number, label: string): number {
  const field = block.subarray(offset, offset + length);
  if ((field[0]! & 0x80) !== 0) throw new Error(`release tar archive uses an unsupported base-256 ${label}`);
  const terminator = field.indexOf(0);
  const text = field.subarray(0, terminator < 0 ? field.length : terminator).toString("ascii").trim();
  if (!/^[0-7]*$/u.test(text)) throw new Error(`release tar archive has an invalid ${label}`);
  const value = text ? Number.parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`release tar archive has an invalid ${label}`);
  return value;
}

function withoutTrailingNulBytes(data: Buffer): Buffer {
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end -= 1;
  return data.subarray(0, end);
}

function tarChecksum(block: Buffer): void {
  const declared = tarNumber(block, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < block.length; index += 1) actual += index >= 148 && index < 156 ? 0x20 : block[index]!;
  if (actual !== declared) throw new Error("release tar archive header checksum mismatch");
}

function parsePax(data: Buffer): Map<string, string> {
  if (data.byteLength > TAR_METADATA_MAXIMUM_BYTES) throw new Error("release tar archive metadata exceeds its limit");
  const result = new Map<string, string>();
  let offset = 0;
  let recordCount = 0;
  while (offset < data.length) {
    recordCount += 1;
    if (recordCount > TAR_PAX_MAXIMUM_RECORDS) throw new Error("release tar archive PAX metadata exceeds its record limit");
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error("release tar archive contains malformed PAX metadata");
    const lengthText = data.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/u.test(lengthText)) throw new Error("release tar archive contains malformed PAX metadata");
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > data.length || data[end - 1] !== 0x0a) {
      throw new Error("release tar archive contains malformed PAX metadata");
    }
    const record = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(space + 1, end - 1));
    const equals = record.indexOf("=");
    if (equals <= 0) throw new Error("release tar archive contains malformed PAX metadata");
    const key = record.slice(0, equals);
    if (Buffer.byteLength(key, "utf8") > TAR_PAX_KEY_MAXIMUM_BYTES) {
      throw new Error("release tar archive contains an oversized PAX metadata key");
    }
    if (result.has(key)) throw new Error(`release tar archive contains duplicate PAX metadata: ${paxMetadataKeyLabel(key)}`);
    result.set(key, record.slice(equals + 1));
    offset = end;
  }
  return result;
}

function tarType(type: string): SecureArchiveEntry["type"] {
  if (type === "" || type === "\0" || type === "0" || type === "7") return "file";
  if (type === "5") return "directory";
  if (type === "1" || type === "2") return "link";
  return "device";
}

async function parseTarGzip(path: string, options: ResolvedOptions, hooks: TarHooks = {}): Promise<SecureArchiveEntry[]> {
  const entries: SecureArchiveEntry[] = [];
  let buffer = Buffer.alloc(0);
  let current: SecureArchiveEntry | null = null;
  let remaining = 0;
  let padding = 0;
  let metadataType: "pax" | "global-pax" | "long-name" | null = null;
  let metadataChunks: Buffer[] = [];
  let metadataBytes = 0;
  let nextPax = new Map<string, string>();
  let longName = "";
  let ended = false;
  let headerCount = 0;
  let declaredPayloadBytes = 0;
  let inflatedBytes = 0;
  const maximumInflatedBytes = options.maximumExpandedBytes
    + options.maximumEntries * TAR_BLOCK_BYTES * 2
    + TAR_BLOCK_BYTES * 20;
  if (!Number.isSafeInteger(maximumInflatedBytes)) throw new Error("secure archive expanded-size limits are invalid");

  const finishEntry = async (): Promise<void> => {
    if (metadataType) {
      const data = Buffer.concat(metadataChunks, metadataBytes);
      if (metadataType === "long-name") {
        longName = new TextDecoder("utf-8", { fatal: true }).decode(withoutTrailingNulBytes(data));
      } else {
        const parsed = parsePax(data);
        if (parsed.has("size") || (metadataType === "global-pax" && parsed.has("path"))) {
          throw new Error("release tar archive contains unsupported PAX path or size metadata");
        }
        // Global PAX path and size overrides are rejected above and no other
        // global key influences admission or extraction. Validate every record,
        // then discard it so work remains linear in the admitted metadata bytes
        // instead of repeatedly copying an ever-growing map.
        if (metadataType !== "global-pax") nextPax = parsed;
      }
      metadataType = null;
      metadataChunks = [];
      metadataBytes = 0;
      return;
    }
    if (current) await hooks.onEnd?.(current);
    current = null;
  };

  const consume = async (chunk: Buffer): Promise<void> => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
    while (buffer.length) {
      if (remaining > 0) {
        const take = Math.min(remaining, buffer.length);
        const data = buffer.subarray(0, take);
        buffer = buffer.subarray(take);
        remaining -= take;
        if (metadataType) {
          metadataBytes += data.length;
          if (metadataBytes > TAR_METADATA_MAXIMUM_BYTES) throw new Error("release tar archive metadata exceeds its limit");
          metadataChunks.push(Buffer.from(data));
        } else if (current && data.length) await hooks.onData?.(current, data);
        if (remaining === 0) {
          await finishEntry();
          if (padding === 0) continue;
        }
        continue;
      }
      if (padding > 0) {
        const take = Math.min(padding, buffer.length);
        buffer = buffer.subarray(take);
        padding -= take;
        if (padding > 0) continue;
      }
      if (buffer.length < TAR_BLOCK_BYTES) return;
      const header = buffer.subarray(0, TAR_BLOCK_BYTES);
      buffer = buffer.subarray(TAR_BLOCK_BYTES);
      if (header.every((byte) => byte === 0)) { ended = true; continue; }
      if (ended) throw new Error("release tar archive contains data after its end marker");
      tarChecksum(header);
      headerCount += 1;
      if (headerCount > options.maximumEntries) throw new Error("release tar archive exceeds the entry limit");
      const rawName = tarString(header, 0, 100);
      const prefix = tarString(header, 345, 155);
      const headerName = prefix ? `${prefix}/${rawName}` : rawName;
      const size = tarNumber(header, 124, 12, "entry size");
      if (size > options.maximumEntryBytes) throw new Error("release tar archive entry exceeds the expanded-size limit");
      declaredPayloadBytes += size;
      if (!Number.isSafeInteger(declaredPayloadBytes) || declaredPayloadBytes > options.maximumExpandedBytes) {
        throw new Error("release tar archive exceeds the expanded-size limit");
      }
      const mode = tarNumber(header, 100, 8, "entry mode") & 0o777;
      const type = String.fromCharCode(header[156] ?? 0);
      remaining = size;
      padding = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
      if (type === "x" || type === "g" || type === "L") {
        if (size > TAR_METADATA_MAXIMUM_BYTES) throw new Error("release tar archive metadata exceeds its limit");
        metadataType = type === "x" ? "pax" : type === "g" ? "global-pax" : "long-name";
        if (remaining === 0) await finishEntry();
        continue;
      }
      const paxPath = nextPax.get("path");
      const name = normalizeArchivePath(paxPath || longName || headerName);
      nextPax = new Map();
      longName = "";
      current = { name, type: tarType(type), bytes: size, mode };
      entries.push(current);
      await hooks.onEntry?.(current);
      if (remaining === 0) await finishEntry();
    }
  };

  const stream = createReadStream(path).pipe(createGunzip());
  for await (const chunk of stream) {
    inflatedBytes += chunk.length;
    if (!Number.isSafeInteger(inflatedBytes) || inflatedBytes > maximumInflatedBytes) {
      throw new Error("release tar archive exceeds the inflated-stream limit");
    }
    await consume(Buffer.from(chunk));
  }
  if (remaining !== 0 || padding !== 0 || metadataType || current || buffer.some((byte) => byte !== 0)) {
    throw new Error("release tar archive is truncated or malformed");
  }
  if (!ended) throw new Error("release tar archive is missing its end marker");
  return entries;
}

async function inspectTarGzip(path: string, options: ResolvedOptions): Promise<SecureArchiveEntry[]> {
  return validateEntries(await parseTarGzip(path, options), options);
}

export async function inspectSecureArchive(path: string, options: SecureArchiveOptions): Promise<SecureArchiveEntry[]> {
  const resolved = resolvedOptions(options);
  const bytes = await assertPhysicalArchive(path, resolved.maximumArchiveBytes);
  if (path.toLowerCase().endsWith(".zip")) return inspectZip(path, bytes, resolved);
  if (path.toLowerCase().endsWith(".tar.gz") || path.toLowerCase().endsWith(".tgz")) return inspectTarGzip(path, resolved);
  throw new Error("release archive format is unsupported");
}

async function prepareDestination(destination: string): Promise<void> {
  await assertPhysicalAncestors(destination, "release extraction destination");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const metadata = await lstat(destination);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("release extraction destination must be a physical directory");
  if ((await readdir(destination)).length) throw new Error("release extraction destination must be empty");
}

function safeDestination(root: string, name: string): string {
  const base = resolve(root);
  const target = resolve(base, ...name.split("/"));
  if (target === base || !target.startsWith(`${base}${sep}`)) throw new Error(`release archive path escapes extraction root: ${name}`);
  return target;
}

function createPhysicalDirectory(root: string, name: string): string {
  const path = safeDestination(root, name);
  mkdirSync(path, { recursive: true, mode: 0o755 });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`release extraction created an unsafe directory: ${name}`);
  return path;
}

function writeAllSync(descriptor: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.byteLength) {
    const written = writeSync(descriptor, data, offset, data.byteLength - offset);
    if (written <= 0) throw new Error("release archive extraction could not complete a file write");
    offset += written;
  }
}

async function writeAll(descriptor: Awaited<ReturnType<typeof open>>, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const { bytesWritten } = await descriptor.write(data, offset, data.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("release archive extraction could not complete a file write");
    offset += bytesWritten;
  }
}

async function extractZip(path: string, destination: string, entries: ZipEntry[], options: ResolvedOptions): Promise<void> {
  const expected = new Map(entries.map((entry) => [archiveIdentity(entry.name), entry]));
  const completed = new Set<string>();
  let expandedBytes = 0;
  let callbackError: unknown;
  const unzipper = new Unzip((file) => {
    if (callbackError) return;
    try {
      const name = normalizeArchivePath(file.name);
      const identity = archiveIdentity(name);
      const entry = expected.get(identity);
      if (!entry || entry.name !== name || completed.has(identity)) throw new Error(`release ZIP local entry does not match its central directory: ${name}`);
      let descriptor: number | null = null;
      let bytes = 0;
      if (entry.type === "directory") createPhysicalDirectory(destination, entry.name);
      else {
        createPhysicalDirectory(destination, dirname(entry.name));
        const target = safeDestination(destination, entry.name);
        descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      }
      file.ondata = (error, data, final) => {
        if (callbackError) return;
        try {
          if (error) throw error;
          bytes += data.byteLength;
          expandedBytes += data.byteLength;
          if (bytes > entry.bytes || bytes > options.maximumEntryBytes || expandedBytes > options.maximumExpandedBytes) {
            throw new Error(`release ZIP entry exceeded its declared or configured size: ${entry.name}`);
          }
          if (descriptor !== null && data.byteLength) writeAllSync(descriptor, data);
          if (final) {
            if (descriptor !== null) { closeSync(descriptor); descriptor = null; }
            if (bytes !== entry.bytes) throw new Error(`release ZIP entry size does not match its central directory: ${entry.name}`);
            if (entry.type === "file" && process.platform !== "win32") {
              chmodSync(safeDestination(destination, entry.name), (entry.mode & 0o111) !== 0 ? 0o755 : 0o644);
            }
            completed.add(identity);
          }
        } catch (failure) {
          if (descriptor !== null) { closeSync(descriptor); descriptor = null; }
          callbackError = failure;
        }
      };
      file.start();
    } catch (failure) {
      callbackError = failure;
    }
  });
  unzipper.register(UnzipInflate);
  let previous: Buffer | null = null;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    if (previous) unzipper.push(previous, false);
    if (callbackError) throw callbackError;
    previous = Buffer.from(chunk);
  }
  unzipper.push(previous ?? Buffer.alloc(0), true);
  if (callbackError) throw callbackError;
  if (completed.size !== entries.length) throw new Error("release ZIP extraction did not materialize every admitted entry");
}

async function extractTarGzip(path: string, destination: string, admitted: SecureArchiveEntry[], options: ResolvedOptions): Promise<void> {
  const expected = new Map(admitted.map((entry) => [archiveIdentity(entry.name), entry]));
  const completed = new Set<string>();
  const descriptors = new Map<string, { descriptor: Awaited<ReturnType<typeof open>>; bytes: number }>();
  let expandedBytes = 0;
  let parsed: SecureArchiveEntry[] = [];
  try {
    parsed = await parseTarGzip(path, options, {
      onEntry: async (entry) => {
      const identity = archiveIdentity(entry.name);
      const expectedEntry = expected.get(identity);
      if (!expectedEntry || JSON.stringify(entry) !== JSON.stringify(expectedEntry) || completed.has(identity)) {
        throw new Error(`release tar entry changed after admission: ${entry.name}`);
      }
      if (entry.type === "directory") createPhysicalDirectory(destination, entry.name);
      else {
        createPhysicalDirectory(destination, dirname(entry.name));
        const descriptor = await open(safeDestination(destination, entry.name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        descriptors.set(identity, { descriptor, bytes: 0 });
      }
      },
      onData: async (entry, data) => {
      const record = descriptors.get(archiveIdentity(entry.name));
      if (!record) throw new Error(`release tar wrote data for a non-file entry: ${entry.name}`);
      record.bytes += data.length;
      expandedBytes += data.length;
      if (record.bytes > entry.bytes || record.bytes > options.maximumEntryBytes || expandedBytes > options.maximumExpandedBytes) {
        throw new Error(`release tar entry exceeded its declared or configured size: ${entry.name}`);
      }
      await writeAll(record.descriptor, data);
      },
      onEnd: async (entry) => {
      const identity = archiveIdentity(entry.name);
      const record = descriptors.get(identity);
      if (record) {
        await record.descriptor.close();
        descriptors.delete(identity);
        if (record.bytes !== entry.bytes) throw new Error(`release tar entry size changed during extraction: ${entry.name}`);
        await chmod(safeDestination(destination, entry.name), (entry.mode & 0o111) !== 0 ? 0o755 : 0o644);
      }
      completed.add(identity);
      }
    });
  } finally {
    for (const record of descriptors.values()) await record.descriptor.close().catch(() => undefined);
  }
  if (parsed.length !== admitted.length || completed.size !== admitted.length) {
    throw new Error("release tar extraction did not materialize every admitted entry");
  }
}

async function validateExtractedTree(root: string): Promise<void> {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("release root must be a physical directory");
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const child = await lstat(path);
      if (child.isSymbolicLink()) throw new Error("release extraction produced a symbolic link or reparse point");
      if (child.isDirectory()) await walk(path);
      else if (!child.isFile() || child.nlink !== 1) throw new Error("release extraction produced an unsupported or hard-linked entry");
    }
  };
  await walk(root);
}

export async function extractSecureArchive(path: string, destination: string, options: SecureArchiveOptions): Promise<SecureArchiveEntry[]> {
  const resolved = resolvedOptions(options);
  const admitted = await inspectSecureArchive(path, resolved);
  await prepareDestination(destination);
  try {
    if (path.toLowerCase().endsWith(".zip")) await extractZip(path, destination, admitted as ZipEntry[], resolved);
    else await extractTarGzip(path, destination, admitted, resolved);
    await validateExtractedTree(join(destination, resolved.expectedRoot));
    return admitted;
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
