import { spawnSync } from "node:child_process";
import { chmod, lstat, readdir, utimes } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RuntimeTarget } from "./node-runtime.ts";
import { sanitizedReleaseEnvironment, trustedTool } from "./trusted-tools.ts";

const ARCHIVE_DATE = new Date("1980-01-01T00:00:00.000Z");

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: sanitizedReleaseEnvironment() });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout || result.error?.message}`);
}

async function walk(directory: string, prefix = ""): Promise<{ files: string[]; directories: string[] }> {
  const files: string[] = [];
  const directories: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`standalone stage contains a symbolic link: ${relative}`);
    if (metadata.isDirectory()) {
      directories.push(relative);
      const child = await walk(path, relative);
      files.push(...child.files);
      directories.push(...child.directories);
    } else if (metadata.isFile() && metadata.nlink === 1) files.push(relative);
    else throw new Error(`standalone stage contains an unsupported or hard-linked entry: ${relative}`);
  }
  return { files, directories };
}

function isExecutable(path: string): boolean {
  return path === "runtime/node" || path === "runtime/node.exe"
    || path === "bin/odinn" || path === "bin/odinn-gateway" || path === "install/install.sh";
}

export async function normalizeStandaloneTree(packageRoot: string): Promise<string[]> {
  const { files, directories } = await walk(packageRoot);
  for (const relative of files.sort()) {
    const absolute = join(packageRoot, relative);
    await chmod(absolute, isExecutable(relative) ? 0o755 : 0o644);
    await utimes(absolute, ARCHIVE_DATE, ARCHIVE_DATE);
  }
  for (const relative of directories.sort((left, right) => right.split("/").length - left.split("/").length || right.localeCompare(left))) {
    const absolute = join(packageRoot, relative);
    await chmod(absolute, 0o755);
    await utimes(absolute, ARCHIVE_DATE, ARCHIVE_DATE);
  }
  await chmod(packageRoot, 0o755);
  await utimes(packageRoot, ARCHIVE_DATE, ARCHIVE_DATE);
  return files.sort();
}

export function createDeterministicStandaloneArchive(
  packageRoot: string,
  target: RuntimeTarget,
  destination: string,
  workingRoot: string,
  files: string[]
): void {
  const archiveRoot = basename(packageRoot);
  const storedFiles = files.map((path) => `${archiveRoot}/${path}`);
  if (target === "win32-x64") {
    run(trustedTool("zip"), ["-X", "-q", destination, ...storedFiles], workingRoot);
    return;
  }
  run(trustedTool("tar"), [
    "--sort=name",
    "--mtime=@315532800",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--mode=u+rwX,go+rX,go-w",
    "--format=posix",
    "--pax-option=delete=atime,delete=ctime",
    `--use-compress-program=${trustedTool("gzip")} -n`,
    "-cf",
    destination,
    "-C",
    workingRoot,
    archiveRoot
  ], workingRoot);
}
