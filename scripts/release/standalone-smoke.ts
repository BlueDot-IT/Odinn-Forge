import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, appendFile, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractSecureArchive } from "../../packages/kernel/src/secure-archive.ts";
import { readRuntimePolicy } from "./node-runtime.ts";

const root = resolve(import.meta.dirname, "../..");
const releaseDir = resolve(process.argv[2] ?? join(root, "dist/release"));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const runtimePolicy = await readRuntimePolicy(root);
const hostTarget = `${process.platform}-${process.arch}`;
const target = process.argv[3] ?? hostTarget;
if (!['linux-x64', 'darwin-x64', 'win32-x64'].includes(target)) throw new Error(`unsupported standalone smoke platform: ${target}`);
if (target !== hostTarget) throw new Error(`standalone smoke target ${target} requires a matching ${target} runner; current runner is ${hostTarget}`);
const extension = target === "win32-x64" ? "zip" : "tar.gz";
const archive = join(releaseDir, `odinn-v${pkg.version}-standalone-${target}.${extension}`);
const temporary = await mkdtemp(join(tmpdir(), "odinn standalone ünicode "));
function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, shell: process.platform === "win32" && command.endsWith(".cmd") });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout || result.error?.message}`);
  return result.stdout;
}
function runFailure(command: string, args: string[], cwd: string, env: Record<string, string> = {}): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, shell: process.platform === "win32" && command.endsWith(".cmd") });
  if (result.status === 0) throw new Error(`${command} unexpectedly succeeded`);
  return `${result.stderr || result.stdout || result.error?.message}`;
}
try {
  const standaloneRoot = `odinn-v${pkg.version}-standalone-${target}`;
  await extractSecureArchive(archive, temporary, { expectedRoot: standaloneRoot });
  const packageRoot = join(temporary, standaloneRoot);
  const fakeBin = join(temporary, "hostile-path"); await mkdir(fakeBin);
  if (process.platform === "win32") await writeFile(join(fakeBin, "node.cmd"), "@exit /b 99\r\n");
  else { await writeFile(join(fakeBin, "node"), "#!/bin/sh\nexit 99\n"); await chmod(join(fakeBin, "node"), 0o755); }
  const launcher = join(packageRoot, "bin", process.platform === "win32" ? "odinn.cmd" : "odinn");
  const hostileEnvironment: Record<string, string> = {
    PATH: `${fakeBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
    NODE_OPTIONS: "--require=/definitely/not/allowed.js",
    NODE_PATH: "/hostile/modules",
    NODE_EXTRA_CA_CERTS: "/hostile/ca.pem",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    NODE_V8_COVERAGE: join(temporary, "hostile-coverage"),
    OPENSSL_CONF: "/hostile/openssl.cnf"
  };
  const loaderSentinel = join(temporary, "hostile-loader-ran");
  if (process.platform !== "win32") {
    const loaderSource = join(temporary, "hostile-loader.c");
    const loaderLibrary = join(temporary, process.platform === "darwin" ? "hostile-loader.dylib" : "hostile-loader.so");
    await writeFile(loaderSource, `
#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>
__attribute__((constructor)) static void mark_loader(void) {
  const char *path = getenv("ODINN_LOADER_SENTINEL");
  if (path == NULL) return;
  const int descriptor = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0600);
  if (descriptor >= 0) close(descriptor);
}
`);
    const loaderBuild = spawnSync("/usr/bin/cc", [
      ...(process.platform === "darwin" ? ["-dynamiclib"] : ["-shared", "-fPIC"]),
      loaderSource,
      "-o",
      loaderLibrary
    ], { encoding: "utf8" });
    if (loaderBuild.status !== 0) throw new Error(`hostile loader probe failed to build: ${loaderBuild.stderr || loaderBuild.stdout}`);
    hostileEnvironment[process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD"] = loaderLibrary;
    hostileEnvironment.ODINN_LOADER_SENTINEL = loaderSentinel;
  }
  const assertLoaderDidNotRun = async () => {
    try {
      await access(loaderSentinel);
      throw new Error("standalone native boundary admitted a hostile loader before environment sanitization");
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
  const version = run(launcher, ["--version"], packageRoot, hostileEnvironment).trim();
  if (version !== pkg.version) throw new Error(`standalone launcher reported ${version}`);
  await assertLoaderDidNotRun();
  const runtimeName = process.platform === "win32" ? "node.exe" : "node";
  const packagedRuntime = join(packageRoot, "runtime", runtimeName);
  const missingRuntime = `${packagedRuntime}.missing`;
  await rename(packagedRuntime, missingRuntime);
  const missing = runFailure(launcher, ["--version"], packageRoot, hostileEnvironment);
  if (!/missing|not executable/i.test(missing)) throw new Error("standalone launcher did not fail closed for a missing runtime");
  await rename(missingRuntime, packagedRuntime);
  const prefix = join(temporary, "installed ünicode");
  if (process.platform === "win32") run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(packageRoot, "install", "install.ps1"), "-Prefix", prefix], packageRoot, { NODE_OPTIONS: "--require=/definitely/not/allowed.js" });
  else run(join(packageRoot, "install", "install.sh"), ["--prefix", prefix], packageRoot, hostileEnvironment);
  await assertLoaderDidNotRun();
  const installed = join(prefix, "bin", process.platform === "win32" ? "odinn.cmd" : "odinn");
  if (run(installed, ["--version"], temporary, hostileEnvironment).trim() !== pkg.version) throw new Error("installed standalone launcher failed");
  await assertLoaderDidNotRun();
  const state = JSON.parse(await readFile(join(prefix, "install-state.json"), "utf8"));
  const metadata = JSON.parse(await readFile(join(prefix, "versions", state.current, "install-metadata.json"), "utf8"));
  if (metadata.toolchain?.distribution !== "standalone" || metadata.toolchain?.embeddedRuntime?.version !== runtimePolicy.version) throw new Error("installed runtime identity is incomplete");
  const installedRuntime = await readFile(join(prefix, "versions", state.current, "runtime", runtimeName));
  if (createHash("sha256").update(installedRuntime).digest("hex") !== metadata.toolchain.embeddedRuntime.executableSha256) {
    throw new Error("installed runtime digest does not match installation metadata");
  }
  const tamperedPrefix = join(temporary, "tampered install");
  await appendFile(packagedRuntime, Buffer.from([0]));
  const tamperedInstall = process.platform === "win32"
    ? runFailure("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(packageRoot, "install", "install.ps1"), "-Prefix", tamperedPrefix], packageRoot)
    : runFailure(join(packageRoot, "install", "install.sh"), ["--prefix", tamperedPrefix], packageRoot);
  if (!/digest|runtime|identity/i.test(tamperedInstall)) throw new Error("standalone installer did not reject a tampered runtime");
  console.log(`verified controlled standalone runtime on ${target}`);
} finally { await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
