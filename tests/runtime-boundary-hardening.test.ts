import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractSecureArchive } from "../packages/kernel/src/secure-archive.ts";
import { createDeterministicStandaloneArchive, normalizeStandaloneTree } from "../scripts/release/standalone-archive.ts";
import { buildNativeLauncher, verifyNativeLauncher } from "../scripts/release/native-launcher.ts";
import { standaloneUnixLauncher } from "../scripts/release/standalone-launchers.ts";
import { sanitizedReleaseEnvironment, trustedTool, type TrustedToolName } from "../scripts/release/trusted-tools.ts";

const root = join(import.meta.dirname, "..");

test("packaged and installed launchers remove hostile TLS settings and ignore PATH tool substitutions", {
  skip: process.platform !== "linux"
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-runtime-boundary-"));
  let server: ReturnType<typeof spawn> | null = null;
  try {
    const fakeBin = join(temporary, "hostile-bin");
    const sentinelRoot = join(temporary, "sentinels");
    await mkdir(fakeBin);
    await mkdir(sentinelRoot);
    const sentinelNames = ["dirname", "tar", "unzip", "zipinfo", "gpg", "gpgv"];
    for (const name of sentinelNames) {
      const sentinel = join(sentinelRoot, name);
      const executable = join(fakeBin, name);
      await writeFile(executable, `#!/bin/sh\n: > ${shellQuote(sentinel)}\nexit 99\n`, { mode: 0o755 });
    }

    const packageRoot = join(temporary, "standalone-package");
    const runtime = join(packageRoot, "runtime", "node");
    const policyPath = join(packageRoot, "THIRD_PARTY_NOTICES", "node-runtime-policy.json");
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await mkdir(join(packageRoot, "dist", "cli"), { recursive: true });
    await mkdir(join(packageRoot, "dist", "gateway"), { recursive: true });
    await mkdir(join(packageRoot, "install"), { recursive: true });
    await mkdir(join(packageRoot, "runtime"), { recursive: true });
    await mkdir(join(packageRoot, "THIRD_PARTY_NOTICES"), { recursive: true });
    await copyFile(process.execPath, runtime);
    await chmod(runtime, 0o755);
    const runtimeBytes = await readFile(runtime);
    const executableSha256 = createHash("sha256").update(runtimeBytes).digest("hex");
    const policyBytes = Buffer.from("test controlled runtime policy\n");
    const runtimePolicySha256 = createHash("sha256").update(policyBytes).digest("hex");
    await writeFile(policyPath, policyBytes);
    const launcher = join(packageRoot, "bin", "odinn");
    await buildNativeLauncher("linux-x64", launcher);
    const launcherBytes = await readFile(launcher);
    const launcherSha256 = createHash("sha256").update(launcherBytes).digest("hex");
    verifyNativeLauncher(launcherBytes, "linux-x64");
    await writeFile(join(packageRoot, "bin", "odinn-gateway"), launcherBytes, { mode: 0o755 });
    await writeFile(join(packageRoot, "install", "install.sh"), launcherBytes, { mode: 0o755 });
    const preloadSource = join(temporary, "hostile-preload.c");
    const preloadLibrary = join(temporary, "hostile-preload.so");
    const preloadSentinel = join(sentinelRoot, "preload");
    await writeFile(preloadSource, `
#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>
__attribute__((constructor)) static void mark_preload(void) {
  const char *path = getenv("ODINN_PRELOAD_SENTINEL");
  if (path == NULL) return;
  const int descriptor = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0600);
  if (descriptor >= 0) close(descriptor);
}
`);
    const preloadBuild = spawnSync(trustedTool("cc"), ["-shared", "-fPIC", preloadSource, "-o", preloadLibrary], {
      encoding: "utf8",
      env: sanitizedReleaseEnvironment()
    });
    assert.equal(preloadBuild.status, 0, preloadBuild.stderr);
    const target = `${process.platform}-${process.arch}`;
    const embeddedRuntime = {
      version: process.version.slice(1),
      target,
      executableBytes: runtimeBytes.byteLength,
      executableSha256,
      runtimePolicySha256
    };
    await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
      name: "@bluedot-it/odinn",
      version: "1.0.0",
      type: "module",
      odinnStandalone: { runtime: "node", ...embeddedRuntime, runtimeBoundary: "linux-static-pie", launcherSha256 }
    }, null, 2)}\n`);
    await writeFile(join(packageRoot, "release-info.json"), `${JSON.stringify({
      schemaVersion: 2,
      name: "odinn",
      version: "1.0.0",
      commit: "a".repeat(40),
      distribution: "standalone",
      runtimeSha256: "b".repeat(64),
      embeddedRuntime
    }, null, 2)}\n`);
    await writeFile(join(packageRoot, "dist", "cli", "index.js"), `
const result = await fetch(process.argv[2])
  .then((response) => ({ ok: true, status: response.status }))
  .catch((error) => ({ ok: false, code: error?.cause?.code ?? error?.code ?? "unknown" }));
console.log(JSON.stringify({ tls: process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? null, ...result }));
`);
    await writeFile(join(packageRoot, "dist", "gateway", "server.js"), "export {};\n");
    await writeFile(`${launcher}.runtime.sh`, standaloneUnixLauncher("dist/cli/index.js", "linux-x64", executableSha256));
    await writeFile(join(packageRoot, "bin", "odinn-gateway.runtime.sh"), standaloneUnixLauncher("dist/gateway/server.js", "linux-x64", executableSha256));
    await writeFile(join(packageRoot, "install", "install.sh.runtime.sh"), standaloneUnixLauncher("dist/install/install.js", "linux-x64", executableSha256));

    const key = join(temporary, "key.pem");
    const certificate = join(temporary, "certificate.pem");
    const openssl = spawnSync("/usr/bin/openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-keyout", key, "-out", certificate
    ], { encoding: "utf8" });
    assert.equal(openssl.status, 0, openssl.stderr);
    const serverEntry = join(temporary, "https-server.mjs");
    await writeFile(serverEntry, `
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
const server = createServer({ key: readFileSync(process.argv[2]), cert: readFileSync(process.argv[3]) }, (_request, response) => response.end("ok"));
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`);
    server = spawn(process.execPath, [serverEntry, key, certificate], { stdio: ["ignore", "pipe", "pipe"] });
    const port = await firstLine(server);
    const url = `https://127.0.0.1:${port}/release`;
    const hostileEnvironment = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      NODE_TLS_REJECT_UNAUTHORIZED: "0"
    };
    const hostileLoaderEnvironment = {
      ...hostileEnvironment,
      LD_PRELOAD: preloadLibrary,
      ODINN_PRELOAD_SENTINEL: preloadSentinel
    };

    const bypassed = await run(runtime, [join(packageRoot, "dist", "cli", "index.js"), url], temporary, hostileEnvironment);
    assert.equal(bypassed.status, 0, bypassed.stderr);
    assert.deepEqual(JSON.parse(bypassed.stdout), { tls: "0", ok: true, status: 200 });

    const packaged = await run(launcher, [url], temporary, hostileLoaderEnvironment);
    assert.equal(packaged.status, 0, packaged.stderr);
    assert.equal(JSON.parse(packaged.stdout).tls, null);
    assert.equal(JSON.parse(packaged.stdout).ok, false);
    await assert.rejects(() => access(preloadSentinel), { code: "ENOENT" });

    const prefix = join(temporary, "installed");
    const installed = await run(runtime, [
      join(root, "scripts", "install.ts"), "install", "--source", packageRoot,
      "--prefix", prefix, "--skip-deps"
    ], root, hostileEnvironment);
    assert.equal(installed.status, 0, installed.stderr);
    const installedLauncher = join(prefix, "bin", "odinn");
    const installedProbe = await run(installedLauncher, [url], temporary, hostileLoaderEnvironment);
    assert.equal(installedProbe.status, 0, installedProbe.stderr);
    assert.equal(JSON.parse(installedProbe.stdout).tls, null);
    assert.equal(JSON.parse(installedProbe.stdout).ok, false);
    await assert.rejects(() => access(preloadSentinel), { code: "ENOENT" });

    for (const name of ["gpg", "gpgv"] as TrustedToolName[]) {
      const result = spawnSync(trustedTool(name), ["--version"], { encoding: "utf8", env: sanitizedReleaseEnvironment({ PATH: fakeBin }) });
      assert.equal(result.status, 0, result.stderr);
    }
    const sanitized = sanitizedReleaseEnvironment({
      LD_PRELOAD: "/hostile/loader.so",
      DYLD_INSERT_LIBRARIES: "/hostile/loader.dylib",
      TAR_OPTIONS: "--checkpoint-action=exec=/hostile/tool",
      ZIPOPT: "-T"
    });
    for (const name of ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "TAR_OPTIONS", "ZIPOPT"]) {
      assert.equal(sanitized[name], undefined);
    }
    for (const name of sentinelNames) await assert.rejects(() => access(join(sentinelRoot, name)), { code: "ENOENT" });
  } finally {
    server?.kill("SIGTERM");
    await rm(temporary, { recursive: true, force: true });
  }
});

test("standalone archives are byte-identical across umasks and poisoned archiver environments", {
  skip: process.platform !== "linux"
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-reproducible-runtime-"));
  const originalUmask = process.umask();
  const originalEnvironment = {
    TAR_OPTIONS: process.env.TAR_OPTIONS,
    ZIPOPT: process.env.ZIPOPT,
    GZIP: process.env.GZIP
  };
  try {
    const trees = [join(temporary, "one", "pkg"), join(temporary, "two", "pkg")];
    for (const [index, tree] of trees.entries()) {
      process.umask(index === 0 ? 0o022 : 0o077);
      await mkdir(join(tree, "dist", "cli"), { recursive: true });
      await writeFile(join(tree, "dist", "cli", "index.js"), "console.log('deterministic');\n");
      await writeFile(join(tree, "package.json"), "{}\n");
    }
    process.env.TAR_OPTIONS = "--definitely-not-a-valid-tar-option";
    process.env.ZIPOPT = "--definitely-not-a-valid-zip-option";
    process.env.GZIP = "--definitely-not-a-valid-gzip-option";

    const normalized = await Promise.all(trees.map((tree) => normalizeStandaloneTree(tree)));
    for (const tree of trees) assert.equal((await lstat(join(tree, "dist"))).mode & 0o777, 0o755);
    for (const [extension, target] of [["tar.gz", "linux-x64"], ["zip", "win32-x64"]] as const) {
      const archives = trees.map((_tree, index) => join(temporary, `archive-${index}.${extension}`));
      for (let index = 0; index < trees.length; index += 1) {
        createDeterministicStandaloneArchive(trees[index]!, target, archives[index]!, join(temporary, index === 0 ? "one" : "two"), normalized[index]!);
      }
      assert.deepEqual(await readFile(archives[0]!), await readFile(archives[1]!), extension);
    }

    const stage = join(temporary, "extract-stage", "pkg");
    await mkdir(join(stage, "dist", "cli"), { recursive: true });
    await writeFile(join(stage, "dist", "cli", "index.js"), "trusted application bytes\n");
    const files = await normalizeStandaloneTree(stage);
    const archive = join(temporary, "secure-extractor.tar.gz");
    createDeterministicStandaloneArchive(stage, "linux-x64", archive, join(temporary, "extract-stage"), files);
    const destination = join(temporary, "secure-output");
    await extractSecureArchive(archive, destination, { expectedRoot: "pkg" });
    assert.equal(await readFile(join(destination, "pkg", "dist", "cli", "index.js"), "utf8"), "trusted application bytes\n");
  } finally {
    process.umask(originalUmask);
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(temporary, { recursive: true, force: true });
  }
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function firstLine(child: ReturnType<typeof spawn>): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    let output = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk) => {
      output += chunk;
      const line = output.split(/\r?\n/u)[0];
      if (line && /^\d+$/u.test(line)) resolvePort(Number(line));
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`HTTPS fixture exited before listening: ${code}`)));
  });
}

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise<number | null>((resolveStatus, reject) => {
    child.once("error", reject);
    child.once("close", resolveStatus);
  });
  return { status, stdout: stdout.trim(), stderr: stderr.trim() };
}
