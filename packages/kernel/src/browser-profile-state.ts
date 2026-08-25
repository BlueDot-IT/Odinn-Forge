import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, realpath, rename } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

type NodeError = Error & { code?: string };

export async function prepareBrowserProfileDirectory(stateDir: string): Promise<string> {
  await relocateLegacyBrowserProfiles(stateDir);
  const { ownerUid, profileRoot } = await browserProfileLocation(stateDir);
  await ensureOwnerPrivateDirectory(profileRoot, ownerUid);
  return profileRoot;
}

export async function relocateLegacyBrowserProfiles(stateDir: string): Promise<string[]> {
  const stateRoot = await realpath(resolve(stateDir));
  const { ownerUid, profileRoot } = await browserProfileLocation(stateRoot);
  const relocated: string[] = [];
  for (const name of ["browser-profile", "browser-profiles"]) {
    const source = join(stateRoot, name);
    let metadata;
    try {
      metadata = await lstat(source);
    } catch (error) {
      if ((error as NodeError | undefined)?.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`state contains an invalid legacy browser profile root: ${name}`);
    }
    if (process.platform !== "win32" && metadata.uid !== ownerUid) {
      throw new Error(`legacy browser profile root must be owned by the current user: ${name}`);
    }
    const destination = name === "browser-profile" ? profileRoot : `${profileRoot}-legacy-${name}`;
    try {
      await lstat(destination);
      throw new Error(`legacy browser profile destination already exists: ${basename(destination)}`);
    } catch (error) {
      if ((error as NodeError | undefined)?.code !== "ENOENT") throw error;
    }
    await rename(source, destination);
    await chmod(destination, 0o700);
    relocated.push(destination);
  }
  return relocated;
}

async function browserProfileLocation(stateDir: string): Promise<{ ownerUid: number; profileRoot: string }> {
  const canonicalStateRoot = await realpath(resolve(stateDir));
  const physicalParent = dirname(canonicalStateRoot);
  const identity = userInfo();
  const ownerUid = identity.uid;
  const userIdentity = `${ownerUid}-${createHash("sha256").update(homedir(), "utf8").digest("hex").slice(0, 12)}`;
  const profilesRoot = join(physicalParent, `.odinn-browser-profiles-${userIdentity}`);
  const stateIdentity = createHash("sha256").update(canonicalStateRoot, "utf8").digest("hex").slice(0, 24);
  await ensureOwnerPrivateDirectory(profilesRoot, ownerUid);
  return { ownerUid, profileRoot: join(profilesRoot, stateIdentity) };
}

async function ensureOwnerPrivateDirectory(path: string, ownerUid: number): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeError | undefined)?.code !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("browser profile path must be a physical directory");
  if (process.platform !== "win32" && metadata.uid !== ownerUid) {
    throw new Error("browser profile path must be owned by the current user");
  }
  await chmod(path, 0o700);
  await readdir(path);
}
