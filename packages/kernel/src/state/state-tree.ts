import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { ensureSecureStateTree } from "@odinn/store-file";

/** Keep installed package payloads sealed while applying owner-only state permissions. */
export async function secureStateTree(root: string, stateRoot = root): Promise<void> {
  if (process.platform === "win32") {
    await ensureSecureStateTree(root);
    return;
  }
  const packages = join(resolve(stateRoot), "plugins", "packages");
  const walk = async (path: string): Promise<void> => {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error("state tree must not contain symbolic links");
    const packagePath = relative(packages, path);
    const sealed = !packagePath.startsWith(`..${sep}`) && packagePath !== ".." && packagePath.split(sep).length >= 2;
    if (metadata.isDirectory()) {
      await chmod(path, sealed ? 0o500 : 0o700);
      for (const name of await readdir(path)) await walk(join(path, name));
    } else if (metadata.isFile() && metadata.nlink === 1) {
      await chmod(path, sealed ? 0o400 : 0o600);
    } else {
      throw new Error("state tree contains an unsupported or hard-linked file");
    }
  };
  await walk(resolve(root));
}

/** Only host-created staging/displaced siblings may be unsealed for disposal. */
export async function removeManagedStateTree(path: string, targetRoot: string): Promise<void> {
  const root = resolve(path);
  const target = resolve(targetRoot);
  const prefix = `.${basename(target)}.`;
  const name = basename(root);
  if (dirname(root) !== dirname(target) || !name.startsWith(prefix)
    || !/^(?:migration-(?:stage|old)|restore-(?:stage|old)|backup-stage)-[A-Za-z0-9-]+$/u.test(name.slice(prefix.length))) {
    throw new Error("unsafe lifecycle cleanup path");
  }
  let admitted;
  try { admitted = await lstat(root); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (admitted.isSymbolicLink() || !admitted.isDirectory()) throw new Error("lifecycle cleanup root must be a physical directory");
  const writable = async (directory: string): Promise<void> => {
    const metadata = await lstat(directory);
    // rm unlinks these entries; never chmod or traverse their targets.
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return;
    await chmod(directory, 0o700);
    for (const name of await readdir(directory)) await writable(join(directory, name));
  };
  await writable(root);
  const current = await lstat(root);
  if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== admitted.dev || current.ino !== admitted.ino) {
    throw new Error("lifecycle cleanup root changed during cleanup");
  }
  await rm(root, { recursive: true, force: true });
}
