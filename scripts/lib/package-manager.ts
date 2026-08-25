import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { basename, isAbsolute } from "node:path";

/** Run the repository's declared package manager without assuming Corepack is installed. */
export function spawnPnpmSync(
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding
): SpawnSyncReturns<string> {
  const activePackageManager = process.env.npm_execpath;
  if (activePackageManager && isAbsolute(activePackageManager) && /^pnpm(?:\.c?js|\.mjs)?$/u.test(basename(activePackageManager))) {
    if (/\.[cm]?js$/u.test(activePackageManager)) {
      return spawnSync(process.execPath, [activePackageManager, ...args], { ...options, shell: false });
    }
    return spawnSync(activePackageManager, [...args], { ...options, shell: false });
  }
  if (process.platform === "win32") {
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "pnpm.cmd", ...args], { ...options, shell: false });
  }
  return spawnSync("pnpm", [...args], { ...options, shell: false });
}
