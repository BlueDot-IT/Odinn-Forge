import assert from "node:assert/strict";
import { gunzipSync, gzipSync } from "node:zlib";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractSecureArchive, inspectSecureArchive } from "../packages/kernel/src/secure-archive.ts";

type ArchiveEntry = {
  name: string;
  data?: Buffer | string;
  mode?: number;
  type?: string;
};

test("secure extraction accepts bounded physical ZIP and tar archives", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-secure-archive-ok-"));
  try {
    for (const format of ["zip", "tar.gz"] as const) {
      const archive = join(temporary, `package.${format}`);
      const destination = join(temporary, `extract-${format}`);
      const entries = [
        { name: "pkg/package.json", data: "{}\n" },
        { name: "pkg/dist/cli/index.js", data: "console.log('ok');\n", mode: 0o100755 }
      ];
      await writeFile(archive, format === "zip" ? zip(entries) : tarGzip(entries));
      const admitted = await extractSecureArchive(archive, destination, {
        expectedRoot: "pkg",
        maximumExpandedBytes: 1024
      });
      assert.equal(admitted.length, 2);
      assert.equal(await readFile(join(destination, "pkg", "package.json"), "utf8"), "{}\n");
      if (process.platform !== "win32") {
        assert.equal((await stat(join(destination, "pkg", "dist", "cli", "index.js"))).mode & 0o777, 0o755);
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("secure extraction rejects an untrusted symbolic-link destination ancestor", {
  skip: process.platform === "win32"
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-secure-archive-destination-"));
  try {
    const physical = join(temporary, "physical");
    const alias = join(temporary, "alias");
    const archive = join(temporary, "package.tar.gz");
    await mkdir(physical);
    await symlink(physical, alias, "dir");
    await writeFile(archive, tarGzip([{ name: "pkg/file", data: "x" }]));
    await assert.rejects(
      () => extractSecureArchive(archive, join(alias, "destination"), { expectedRoot: "pkg" }),
      /must not traverse a symbolic link or reparse point/u
    );
    await assert.rejects(() => access(join(physical, "destination")), { code: "ENOENT" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("secure archive admission rejects unsafe paths and collisions before writing", async () => {
  const malicious: Array<{ name: string; entries: ArchiveEntry[] }> = [
    { name: "traversal", entries: [{ name: "pkg/../outside", data: "x" }] },
    { name: "absolute", entries: [{ name: "/pkg/file", data: "x" }] },
    { name: "drive", entries: [{ name: "C:/pkg/file", data: "x" }] },
    { name: "backslash", entries: [{ name: "pkg\\outside", data: "x" }] },
    { name: "duplicate", entries: [{ name: "pkg/file", data: "x" }, { name: "pkg/file", data: "y" }] },
    { name: "case collision", entries: [{ name: "pkg/File", data: "x" }, { name: "pkg/file", data: "y" }] },
    { name: "unicode collision", entries: [{ name: "pkg/café", data: "x" }, { name: "pkg/cafe\u0301", data: "y" }] },
    { name: "alien root", entries: [{ name: "other/file", data: "x" }] },
    { name: "file shadow", entries: [{ name: "pkg/file", data: "x" }, { name: "pkg/file/child", data: "y" }] }
  ];
  const temporary = await mkdtemp(join(tmpdir(), "odinn-secure-archive-paths-"));
  try {
    for (const format of ["zip", "tar.gz"] as const) {
      for (const fixture of malicious) {
        const archive = join(temporary, `${fixture.name.replaceAll(" ", "-")}.${format}`);
        const destination = join(temporary, `output-${format}-${fixture.name.replaceAll(" ", "-")}`);
        await writeFile(archive, format === "zip" ? zip(fixture.entries) : tarGzip(fixture.entries));
        await assert.rejects(
          () => extractSecureArchive(archive, destination, { expectedRoot: "pkg" }),
          /unsafe path|duplicate|colliding|unexpected top-level|non-directory|shadows/u,
          `${format} ${fixture.name}`
        );
        await assert.rejects(() => access(destination), { code: "ENOENT" });
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("secure archive admission rejects links, devices, FIFOs, and expanded-size bombs", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-secure-archive-types-"));
  try {
    const tarCases: Array<{ name: string; type: string }> = [
      { name: "symlink", type: "2" },
      { name: "hardlink", type: "1" },
      { name: "character-device", type: "3" },
      { name: "block-device", type: "4" },
      { name: "fifo", type: "6" }
    ];
    for (const fixture of tarCases) {
      const archive = join(temporary, `${fixture.name}.tar.gz`);
      await writeFile(archive, tarGzip([{ name: "pkg/unsafe", type: fixture.type }]));
      await assert.rejects(
        () => inspectSecureArchive(archive, { expectedRoot: "pkg" }),
        /symbolic or hard link|device, FIFO, socket/u,
        fixture.name
      );
    }

    const zipCases = [
      { name: "symlink", mode: 0o120777 },
      { name: "character-device", mode: 0o020600 },
      { name: "fifo", mode: 0o010600 }
    ];
    for (const fixture of zipCases) {
      const archive = join(temporary, `${fixture.name}.zip`);
      await writeFile(archive, zip([{ name: "pkg/unsafe", mode: fixture.mode }]));
      await assert.rejects(
        () => inspectSecureArchive(archive, { expectedRoot: "pkg" }),
        /symbolic or hard link|device, FIFO, socket/u,
        fixture.name
      );
    }

    for (const format of ["zip", "tar.gz"] as const) {
      const archive = join(temporary, `bomb.${format}`);
      const entries = [
        { name: "pkg/one", data: Buffer.alloc(16) },
        { name: "pkg/two", data: Buffer.alloc(16) }
      ];
      await writeFile(archive, format === "zip" ? zip(entries) : tarGzip(entries));
      await assert.rejects(
        () => inspectSecureArchive(archive, { expectedRoot: "pkg", maximumEntryBytes: 20, maximumExpandedBytes: 31 }),
        /expanded-size limit/u
      );
    }

    const paddedTar = join(temporary, "inflated-padding.tar.gz");
    const admittedTar = gunzipSync(tarGzip([{ name: "pkg/file", data: "x" }]));
    await writeFile(paddedTar, gzipSync(Buffer.concat([admittedTar, Buffer.alloc(64 * 1024)]), { level: 9, mtime: 0 }));
    await assert.rejects(
      () => inspectSecureArchive(paddedTar, {
        expectedRoot: "pkg",
        maximumEntries: 2,
        maximumEntryBytes: 16,
        maximumExpandedBytes: 16
      }),
      /inflated-stream limit/u
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

function tarGzip(entries: ArchiveEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    writeOctal(header, 100, 8, entry.mode ?? (entry.type === "5" ? 0o755 : 0o644));
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, data.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "binary");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 });
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function zip(entries: ArchiveEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "");
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x800, 6);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    local.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x800, 8);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    central.push(centralHeader, name);
    localOffset += localHeader.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
