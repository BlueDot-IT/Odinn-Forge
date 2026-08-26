import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export type TrustedToolName = "gpg" | "gpgv" | "gzip" | "sha256sum" | "shasum" | "tar" | "unzip" | "zip" | "zipinfo";

const UNIX_TOOLS: Record<TrustedToolName, string[]> = {
  gpg: ["/usr/bin/gpg"],
  gpgv: ["/usr/bin/gpgv"],
  gzip: ["/usr/bin/gzip"],
  sha256sum: ["/usr/bin/sha256sum"],
  shasum: ["/usr/bin/shasum"],
  tar: ["/usr/bin/tar"],
  unzip: ["/usr/bin/unzip"],
  zip: ["/usr/bin/zip"],
  zipinfo: ["/usr/bin/zipinfo"]
};

const WINDOWS_TOOLS: Partial<Record<TrustedToolName, string[]>> = {
  tar: [String.raw`C:\Windows\System32\tar.exe`]
};

const ARCHIVER_ENVIRONMENT = [
  "BZIP", "BZIP2", "GZIP", "GZIP_OPT", "POSIXLY_CORRECT", "TAR_OPTIONS",
  "UNZIP", "UNZIPOPT", "XZ_DEFAULTS", "XZ_OPT", "ZIP", "ZIPOPT"
];
const PROCESS_LOADER_ENVIRONMENT = [
  "DYLD_FALLBACK_FRAMEWORK_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "GCONV_PATH", "LD_AUDIT", "LD_LIBRARY_PATH",
  "LD_PRELOAD", "LOCPATH", "NLSPATH"
];

function samePhysicalPath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

export function trustedTool(name: TrustedToolName): string {
  const candidates = process.platform === "win32" ? WINDOWS_TOOLS[name] ?? [] : UNIX_TOOLS[name];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const metadata = lstatSync(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      accessSync(candidate, constants.X_OK);
      if (!samePhysicalPath(realpathSync(candidate), candidate)) continue;
      const parent = dirname(candidate);
      if (!samePhysicalPath(realpathSync(parent), parent)) continue;
      return candidate;
    } catch {
      // Try the next reviewed, absolute system location.
    }
  }
  throw new Error(`required trusted system tool is unavailable: ${name}`);
}

export function sanitizedReleaseEnvironment(additions: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...additions,
    LC_ALL: "C",
    TZ: "UTC",
    PATH: process.platform === "win32" ? String.raw`C:\Windows\System32;C:\Windows` : "/usr/bin:/bin"
  };
  for (const name of [...ARCHIVER_ENVIRONMENT, ...PROCESS_LOADER_ENVIRONMENT]) delete environment[name];
  delete environment.GNUPGHOME;
  delete environment.GPG_AGENT_INFO;
  return environment;
}
