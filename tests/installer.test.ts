import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  access,
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("native installer upgrades by atomic pointer and rolls back to the previous application", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "odinn-native-install-"));
  run(["install", "--source", root, "--prefix", prefix, "--version", "0.1.0", "--skip-deps"]);
  const first = JSON.parse(await readFile(join(prefix, "install-state.json"), "utf8"));
  const metadata = JSON.parse(await readFile(join(prefix, "versions", first.current, "install-metadata.json"), "utf8"));
  assert.equal(metadata.version, "0.1.0");
  assert.equal(first.currentVersion, "0.1.0");
  assert.match(metadata.lockfileSha256, /^[a-f0-9]{64}$/);
  assert.equal(metadata.toolchain.node, process.version);
  assert.equal(metadata.toolchain.packageManager, "pnpm@10.14.0");
  run(["upgrade", "--source", root, "--prefix", prefix, "--version", "0.1.1", "--skip-deps"]);
  const upgraded = JSON.parse(await readFile(join(prefix, "install-state.json"), "utf8"));
  assert.notEqual(upgraded.current, first.current);
  assert.equal(upgraded.previous, first.current);
  assert.equal(upgraded.currentVersion, "0.1.1");
  run(["rollback", "--prefix", prefix]);
  const rolledBack = JSON.parse(await readFile(join(prefix, "install-state.json"), "utf8"));
  assert.equal(rolledBack.current, first.current);
  assert.equal(rolledBack.previous, upgraded.current);
  assert.equal(rolledBack.currentVersion, "0.1.0");
});

test("standalone install uses only its bundled runtime and rolls back byte-equivalently across legacy packages", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-controlled-runtime-"));
  const prefix = join(temporary, "install");
  try {
    const standalone = await writeStandaloneFixture(temporary, "1.0.0", "a".repeat(40));
    runWithRuntime(standalone.runtime, [
      "install",
      "--source",
      standalone.root,
      "--prefix",
      prefix,
      "--version",
      "1.0.0",
      "--commit",
      "a".repeat(40),
      "--artifact-sha256",
      "1".repeat(64)
    ]);
    const first = JSON.parse(await readFile(join(prefix, "install-state.json"), "utf8"));
    const firstRoot = join(prefix, "versions", first.current);
  const firstTree = await treeDigest(firstRoot);
    const firstRuntimeDigest = standalone.executableSha256;
    assert.equal(await readFile(join(prefix, "current"), "utf8"), `${first.current}\nstandalone\n${firstRuntimeDigest}\n`);

    const fakeBin = join(temporary, "hostile-bin");
    await mkdir(fakeBin);
    if (process.platform === "win32") await writeFile(join(fakeBin, "node.cmd"), "@exit /b 99\r\n");
    else {
      await writeFile(join(fakeBin, "node"), "#!/bin/sh\nexit 99\n");
      await chmod(join(fakeBin, "node"), 0o755);
    }
    const hostileEnvironment = {
      PATH: `${fakeBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      NODE_OPTIONS: "--require=/definitely/not/allowed.js",
      NODE_PATH: "/hostile/modules",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      OPENSSL_CONF: "/hostile/openssl.cnf"
    };
    const firstProbe = JSON.parse(runInstalled(prefix, ["probe"], hostileEnvironment));
    assert.equal(firstProbe.version, "1.0.0");
    assert.equal(firstProbe.nodeOptions, null);
    assert.equal(firstProbe.nodePath, null);
    assert.equal(firstProbe.tlsRejectUnauthorized, null);
    assert.equal(firstProbe.opensslConfig, null);
    assert.equal(await realpath(firstProbe.execPath), await realpath(join(firstRoot, "runtime", runtimeName())));
    const installedRuntimePath = join(firstRoot, "runtime", runtimeName());
    const installedRuntimeBytes = await readFile(installedRuntimePath);
    const tamperedRuntime = `${installedRuntimePath}.tampered`;
    await writeFile(tamperedRuntime, Buffer.concat([installedRuntimeBytes, Buffer.from([0])]), { mode: 0o755 });
    await rename(tamperedRuntime, installedRuntimePath);
    assert.match(runInstalledFailure(prefix, ["--version"], hostileEnvironment), /digest mismatch|identity check/u);
    const restoredRuntime = `${installedRuntimePath}.restored`;
    await writeFile(restoredRuntime, installedRuntimeBytes, { mode: 0o755 });
    await rename(restoredRuntime, installedRuntimePath);

    const legacy = await writeCompiledFixture(temporary, "1.1.0", "b".repeat(40));
    await mkdir(join(legacy, ".cache", "node-runtime"), { recursive: true });
    await writeFile(join(legacy, ".cache", "node-runtime", "must-not-install"), "generated\n");
    const missingInstalledRuntime = `${installedRuntimePath}.missing`;
    await rename(installedRuntimePath, missingInstalledRuntime);
    assert.match(runWithRuntimeFailure(process.execPath, [
      "upgrade", "--source", legacy, "--prefix", prefix, "--version", "1.1.0",
      "--commit", "b".repeat(40), "--artifact-sha256", "2".repeat(64)
    ]), /runtime|ENOENT/u);
    await rename(missingInstalledRuntime, installedRuntimePath);
    runWithRuntime(process.execPath, [
      "upgrade",
      "--source",
      legacy,
      "--prefix",
      prefix,
      "--version",
      "1.1.0",
      "--commit",
      "b".repeat(40),
      "--artifact-sha256",
      "2".repeat(64)
    ]);
    const upgraded = JSON.parse(await readFile(join(prefix, "install-state.json"), "utf8"));
    assert.equal(await readFile(join(prefix, "current"), "utf8"), `${upgraded.current}\ncompiled\n\n`);
    assert.equal(runInstalled(prefix, ["--version"]).trim(), "1.1.0");
    await assert.rejects(() => access(join(prefix, "versions", upgraded.current, ".cache")), { code: "ENOENT" });

    if (process.platform !== "win32") {
      await rm(installedRuntimePath);
      await symlink(process.execPath, installedRuntimePath);
      assert.match(runWithRuntimeFailure(process.execPath, ["rollback", "--prefix", prefix]), /symbolic link|reparse|physical/u);
      await rm(installedRuntimePath);
      await copyFile(standalone.runtime, installedRuntimePath);
      await chmod(installedRuntimePath, 0o755);
    }
    runWithRuntime(process.execPath, ["rollback", "--prefix", prefix]);
    const rolledBack = JSON.parse(await readFile(join(prefix, "install-state.json"), "utf8"));
    assert.equal(rolledBack.current, first.current);
    assert.equal(await readFile(join(prefix, "current"), "utf8"), `${first.current}\nstandalone\n${firstRuntimeDigest}\n`);
    assert.equal((await treeDigest(firstRoot)), firstTree);
    assert.equal(JSON.parse(runInstalled(prefix, ["probe"], hostileEnvironment)).version, "1.0.0");

    runWithRuntime(process.execPath, ["rollback", "--prefix", prefix]);
    assert.equal(runInstalled(prefix, ["--version"]).trim(), "1.1.0");

    await mkdir(join(prefix, "versions", ".staging-interrupted"));
    await writeFile(join(prefix, ".install-state-100-stale.tmp"), "stale");
    await writeFile(join(prefix, "current.100.stale.tmp"), "stale");
    await writeFile(join(prefix, "bin", "odinn.100.stale.tmp"), "stale");
    await writeFile(join(prefix, "current"), `${first.current}\nstandalone\n${firstRuntimeDigest}\n`);
    const recovered = JSON.parse(runWithRuntime(process.execPath, ["status", "--prefix", prefix]));
    assert.equal(recovered.current, first.current);
    assert.equal(recovered.previous, upgraded.current);
    assert.equal(recovered.operation, "recover-interrupted-activation");
    for (const stale of [
      join(prefix, "versions", ".staging-interrupted"),
      join(prefix, ".install-state-100-stale.tmp"),
      join(prefix, "current.100.stale.tmp"),
      join(prefix, "bin", "odinn.100.stale.tmp")
    ]) {
      await assert.rejects(() => access(stale), { code: "ENOENT" });
    }
    assert.equal(await treeDigest(firstRoot), firstTree);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("standalone installer fails closed for missing or tampered runtime policy and executable identity", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-controlled-runtime-invalid-"));
  try {
    const fixture = await writeStandaloneFixture(temporary, "1.0.0", "c".repeat(40));
    const executable = fixture.runtime;
    const missing = `${executable}.missing`;
    await rename(executable, missing);
    const missingResult = runWithRuntimeFailure(process.execPath, [
      "install", "--source", fixture.root, "--prefix", join(temporary, "missing-install"), "--version", "1.0.0"
    ]);
    assert.match(missingResult, /declared platform runtime/u);
    await rename(missing, executable);

    const policyPath = join(fixture.root, "THIRD_PARTY_NOTICES", "node-runtime-policy.json");
    const policy = await readFile(policyPath);
    await appendFile(policyPath, "\n");
    const policyResult = runWithRuntimeFailure(executable, [
      "install", "--source", fixture.root, "--prefix", join(temporary, "policy-install"), "--version", "1.0.0"
    ]);
    assert.match(policyResult, /runtime policy digest/u);
    await writeFile(policyPath, policy);

    await appendFile(executable, Buffer.from([0]));
    const runtimeResult = runWithRuntimeFailure(executable, [
      "install", "--source", fixture.root, "--prefix", join(temporary, "runtime-install"), "--version", "1.0.0"
    ]);
    assert.match(runtimeResult, /runtime executable digest/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("native installer refuses a shared launcher directory", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "odinn-unsafe-install-"));
  await mkdir(join(prefix, "bin"));
  await writeFile(join(prefix, "bin", "unrelated-tool"), "keep\n");
  const result = spawnSync(process.execPath, [
    join(root, "scripts", "install.ts"),
    "install",
    "--source",
    root,
    "--prefix",
    prefix,
    "--skip-deps"
  ], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unrelated launcher entry/u);
  assert.equal(await readFile(join(prefix, "bin", "unrelated-tool"), "utf8"), "keep\n");
});

test("installer lock refuses concurrent commands and preserves the active staging tree", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "odinn-active-install-lock-"));
  const staging = join(prefix, "versions", ".staging-active");
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, "in-progress"), "keep\n");
  await mkdir(join(prefix, ".install.lock"));
  await writeFile(join(prefix, ".install.lock", "owner.json"), `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    token: "active-test-owner",
    startedAt: new Date().toISOString()
  })}\n`);
  const result = spawnSync(process.execPath, [join(root, "scripts", "install.ts"), "status", "--prefix", prefix], {
    cwd: root,
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /another installer command is active/u);
  assert.equal(await readFile(join(staging, "in-progress"), "utf8"), "keep\n");
  await rm(prefix, { recursive: true, force: true });
});

test("installer refuses symlinked prefix ancestors and generated cache is ignored", {
  skip: process.platform === "win32"
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-linked-install-prefix-"));
  try {
    const physical = join(temporary, "physical");
    const linked = join(temporary, "linked");
    await mkdir(physical);
    await symlink(physical, linked);
    const result = spawnSync(process.execPath, [
      join(root, "scripts", "install.ts"), "status", "--prefix", join(linked, "install")
    ], { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symbolic link|reparse point|linked ancestor/u);

    const ignored = spawnSync("git", ["check-ignore", ".cache/runtime-probe"], { cwd: root, encoding: "utf8" });
    assert.equal(ignored.status, 0, ignored.stderr);
    assert.equal(ignored.stdout.trim(), ".cache/runtime-probe");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("installer revalidates source and staging runtime identity after a copy race", {
  skip: process.platform === "win32"
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-runtime-copy-race-"));
  try {
    const fixture = await writeStandaloneFixture(temporary, "2.0.0", "d".repeat(40));
    const delayDirectory = join(fixture.root, "zz-copy-delay");
    await mkdir(delayDirectory);
    const delayBytes = Buffer.alloc(1024 * 1024, 0x5a);
    for (let index = 0; index < 24; index += 1) await writeFile(join(delayDirectory, `${index}.bin`), delayBytes);
    const prefix = join(temporary, "install");
    const child = spawn(fixture.runtime, [
      join(root, "scripts", "install.ts"), "install", "--source", fixture.root,
      "--prefix", prefix, "--skip-deps"
    ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    let stagingObserved = false;
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const entries = await readdir(join(prefix, "versions")).catch(() => []);
      if (entries.some((entry) => entry.startsWith(".staging-"))) {
        stagingObserved = true;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
    }
    assert.equal(stagingObserved, true, "installer staging copy did not start");
    const tampered = `${fixture.runtime}.race-tampered`;
    await writeFile(tampered, Buffer.from("not the reviewed Node runtime"), { mode: 0o755 });
    await rename(tampered, fixture.runtime);
    const status = await new Promise<number | null>((resolveStatus, reject) => {
      child.once("error", reject);
      child.once("close", resolveStatus);
    });
    assert.notEqual(status, 0, stdout);
    assert.match(stderr, /runtime executable digest|declared platform runtime/u);
    await assert.rejects(() => access(join(prefix, "install-state.json")), { code: "ENOENT" });
    assert.deepEqual((await readdir(join(prefix, "versions"))).filter((entry) => !entry.startsWith(".")), []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

async function writeStandaloneFixture(temporary: string, version: string, commit: string) {
  const source = join(temporary, `standalone-${version}`);
  const runtime = join(source, "runtime", runtimeName());
  const policySource = join(root, "release", "node-runtime-policy.json");
  const policyDestination = join(source, "THIRD_PARTY_NOTICES", "node-runtime-policy.json");
  await mkdir(join(source, "dist", "cli"), { recursive: true });
  await mkdir(join(source, "dist", "gateway"), { recursive: true });
  await mkdir(dirname(runtime), { recursive: true });
  await mkdir(dirname(policyDestination), { recursive: true });
  await copyFile(process.execPath, runtime);
  await chmod(runtime, 0o755).catch(() => undefined);
  await copyFile(policySource, policyDestination);
  const policy = JSON.parse(await readFile(policySource, "utf8"));
  const executableSha256 = createHash("sha256").update(await readFile(runtime)).digest("hex");
  const runtimePolicySha256 = createHash("sha256").update(await readFile(policyDestination)).digest("hex");
  assert.equal(policy.version, process.version.slice(1), "test runner must use the controlled Node runtime version");
  const executableBytes = (await lstat(runtime)).size;
  const odinnStandalone = {
    runtime: "node",
    version: policy.version,
    target: `${process.platform}-${process.arch}`,
    executableSha256,
    runtimePolicySha256
  };
  await writeFile(join(source, "package.json"), `${JSON.stringify({ name: "@bluedot-it/odinn", version, type: "module", odinnStandalone }, null, 2)}\n`);
  await writeFile(join(source, "release-info.json"), `${JSON.stringify({
    schemaVersion: 2,
    name: "odinn",
    version,
    commit,
    distribution: "standalone",
    runtimeSha256: "d".repeat(64),
    embeddedRuntime: {
      version: policy.version,
      target: `${process.platform}-${process.arch}`,
      executableBytes,
      executableSha256,
      runtimePolicySha256
    }
  }, null, 2)}\n`);
  await writeFile(join(source, "dist", "cli", "index.js"), fixtureCli(version));
  await writeFile(join(source, "dist", "gateway", "server.js"), "export {};\n");
  return { root: source, runtime, executableSha256 };
}

async function writeCompiledFixture(temporary: string, version: string, commit: string) {
  const source = join(temporary, `compiled-${version}`);
  await mkdir(join(source, "dist", "cli"), { recursive: true });
  await mkdir(join(source, "dist", "gateway"), { recursive: true });
  await writeFile(join(source, "package.json"), `${JSON.stringify({ name: "@bluedot-it/odinn", version, type: "module" }, null, 2)}\n`);
  await writeFile(join(source, "release-info.json"), `${JSON.stringify({
    schemaVersion: 2,
    name: "odinn",
    version,
    commit,
    distribution: "compiled",
    runtimeSha256: "e".repeat(64)
  }, null, 2)}\n`);
  await writeFile(join(source, "dist", "cli", "index.js"), fixtureCli(version));
  await writeFile(join(source, "dist", "gateway", "server.js"), "export {};\n");
  return source;
}

function fixtureCli(version: string) {
  return `const args=process.argv.slice(2);if(args[0]==="--version")console.log(${JSON.stringify(version)});else console.log(JSON.stringify({version:${JSON.stringify(version)},execPath:process.execPath,nodeOptions:process.env.NODE_OPTIONS??null,nodePath:process.env.NODE_PATH??null,tlsRejectUnauthorized:process.env.NODE_TLS_REJECT_UNAUTHORIZED??null,opensslConfig:process.env.OPENSSL_CONF??null}));\n`;
}

function runtimeName() {
  return process.platform === "win32" ? "node.exe" : "node";
}

function runWithRuntime(runtime: string, args: string[], environment: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(runtime, [join(root, "scripts", "install.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...environment }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return result.stdout;
}

function runWithRuntimeFailure(runtime: string, args: string[]) {
  const result = spawnSync(runtime, [join(root, "scripts", "install.ts"), ...args], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0, result.stdout);
  return `${result.stderr || result.stdout || result.error?.message}`;
}

function runInstalled(prefix: string, args: string[], environment: NodeJS.ProcessEnv = {}) {
  const launcher = join(prefix, "bin", process.platform === "win32" ? "odinn.cmd" : "odinn");
  const result = spawnSync(launcher, args, {
    cwd: prefix,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    shell: process.platform === "win32"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return result.stdout;
}

function runInstalledFailure(prefix: string, args: string[], environment: NodeJS.ProcessEnv = {}) {
  const launcher = join(prefix, "bin", process.platform === "win32" ? "odinn.cmd" : "odinn");
  const result = spawnSync(launcher, args, {
    cwd: prefix,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    shell: process.platform === "win32"
  });
  assert.notEqual(result.status, 0, result.stdout);
  return `${result.stderr || result.stdout || result.error?.message}`;
}

async function treeDigest(rootPath: string) {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      const name = relative(rootPath, path).replaceAll("\\", "/");
      hash.update(`${entry.isDirectory() ? "d" : "f"}:${name}:${metadata.size}\0`);
      if (entry.isDirectory()) await visit(path);
      else {
        assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1);
        hash.update(await readFile(path));
      }
    }
  };
  await visit(rootPath);
  return hash.digest("hex");
}

function run(args: any) {
  const result = spawnSync(process.execPath, [join(root, "scripts", "install.ts"), ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
