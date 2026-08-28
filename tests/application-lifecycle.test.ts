import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { STATE_SCHEMA_TARGETS } from "../packages/kernel/src/state/schema-registry.ts";
import { buildNativeLauncher } from "../scripts/release/native-launcher.ts";
import { trustedTool } from "../scripts/release/trusted-tools.ts";
import {
  HOSTILE_WINDOWS_RUNTIME_ENVIRONMENT_VARIABLES,
  standaloneUnixLauncher
} from "../scripts/release/standalone-launchers.ts";
import {
  checkForUpdate,
  resolveGitHubTagCommit,
  verifyGitHubReleaseAttestation,
  rollbackApplication,
  uninstallApplication,
  updateApplication
} from "../apps/cli/src/lifecycle.ts";

const PRIOR_COMMIT = "a".repeat(40);
const NEXT_COMMIT = "b".repeat(40);
const root = resolve(import.meta.dirname, "..");

test("remote release tag resolution binds assets to the immutable commit", async () => {
  const annotatedTag = "c".repeat(40);
  const responses = [
    new Response(JSON.stringify({ ref: "refs/tags/v1.0.0", object: { type: "tag", sha: annotatedTag } }), { status: 200 }),
    new Response(JSON.stringify({ object: { type: "commit", sha: NEXT_COMMIT } }), { status: 200 })
  ];
  const requested: string[] = [];
  const resolved = await resolveGitHubTagCommit("v1.0.0", async (url) => {
    requested.push(String(url));
    return responses.shift()!;
  });
  assert.equal(resolved, NEXT_COMMIT);
  assert.match(requested[0]!, /\/git\/ref\/tags\/v1\.0\.0$/u);
  assert.match(requested[1]!, new RegExp(`/git/tags/${annotatedTag}$`, "u"));
});

test("remote release tag resolution rejects mismatched and malformed refs", async () => {
  await assert.rejects(
    () => resolveGitHubTagCommit("v1.0.0", async () => new Response(JSON.stringify({
      ref: "refs/tags/v1.0.1",
      object: { type: "commit", sha: NEXT_COMMIT }
    }), { status: 200 })),
    /wrong ref/u
  );
  await assert.rejects(() => resolveGitHubTagCommit("../main", async () => new Response()), /tag name is invalid/u);
});

test("updater accepts only a verified GitHub attestation bound to the release artifact and source", async () => {
  const artifactName = "odinn-v1.0.0.tar.gz";
  const digest = "d".repeat(64);
  const commit = NEXT_COMMIT;
  const statement = {
    subject: [{ name: artifactName, digest: { sha256: digest } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: "BlueDot-IT/Odinn-Forge",
            ref: "refs/tags/v1.0.0",
            sha: commit,
            path: ".github/workflows/release.yml"
          }
        }
      }
    }
  };
  const fetchImplementation = async () => new Response(JSON.stringify({ attestations: [{ verification_status: "verified", bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } } }] }), { status: 200 });
  await verifyGitHubReleaseAttestation({ artifactName, artifactDigest: digest, version: "1.0.0", commit, fetchImplementation });
  await assert.rejects(() => verifyGitHubReleaseAttestation({ artifactName, artifactDigest: "e".repeat(64), version: "1.0.0", commit, fetchImplementation }), /no verified GitHub build attestation/u);
});

async function lifecycleFixture() {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-application-lifecycle-"));
  const prefix = join(temporary, "install");
  const state = join(temporary, "state");
  const priorId = `0.9.0-${PRIOR_COMMIT.slice(0, 12)}`;
  const priorRoot = join(prefix, "versions", priorId);
  await mkdir(state, { recursive: true });
  await writeFile(join(state, "config.json"), "{\"version\":1}\n");
  await writeFile(join(state, "state-schema.json"), `${JSON.stringify({
    schemaVersion: 1,
    applicationVersion: "0.9.0",
    applicationCommit: PRIOR_COMMIT,
    minimumApplicationVersion: "0.9.0",
    storeVersions: STATE_SCHEMA_TARGETS,
    updatedAt: "2026-07-25T00:00:00.000Z"
  }, null, 2)}\n`);
  await writeFakePackage(priorRoot, "0.9.0", PRIOR_COMMIT, { health: true });
  await mkdir(prefix, { recursive: true });
  await writeFile(join(prefix, "install-state.json"), `${JSON.stringify({
    schemaVersion: 1,
    current: priorId,
    currentVersion: "0.9.0",
    currentCommit: PRIOR_COMMIT,
    previous: null,
    operation: "install"
  }, null, 2)}\n`);
  return { temporary, prefix, state, priorId };
}

type TestLauncherActivationPhase = "prepared" | "waiting" | "applying" | "failed";

function runInstallerCommand(prefix: string, command: string, extra: string[] = []) {
  return spawnSync(process.execPath, [
    join(root, "scripts", "install.ts"),
    command,
    "--prefix",
    prefix,
    ...extra
  ], {
    cwd: root,
    encoding: "utf8",
    shell: false
  });
}

function assertInstallerSuccess(result: ReturnType<typeof spawnSync>) {
  assert.equal(result.status, 0, String(result.stderr || result.stdout));
}

async function initializeInstallerPointer(prefix: string) {
  assertInstallerSuccess(runInstallerCommand(prefix, "status"));
}

async function writeTestLauncherActivationMarker(options: {
  prefix: string;
  token: string;
  versionId: string;
  waitForPid: number;
  phase?: TestLauncherActivationPhase;
  operation?: "upgrade" | "rollback";
  deadlineAt?: string;
  attempts?: number;
  sourceVersionId?: string | null;
  previousVersionId?: string | null;
}) {
  const now = new Date().toISOString();
  await writeFile(join(options.prefix, ".launcher-activation.json"), `${JSON.stringify({
    schemaVersion: 3,
    token: options.token,
    operation: options.operation ?? "upgrade",
    phase: options.phase ?? "waiting",
    versionId: options.versionId,
    sourceVersionId: options.sourceVersionId ?? null,
    previousVersionId: options.previousVersionId ?? null,
    activationAt: now,
    waitForPid: options.waitForPid,
    createdAt: now,
    updatedAt: now,
    deadlineAt: options.deadlineAt ?? new Date(Date.now() + 60_000).toISOString(),
    attempts: options.attempts ?? 0
  }, null, 2)}\n`, { mode: 0o600 });
}

test("ordinary Windows startup reconciles a power-loss activation with the candidate runtime", {
  skip: process.platform !== "win32"
}, async () => {
  const fixture = await lifecycleFixture();
  const candidateSource = join(fixture.temporary, "standalone-power-loss-candidate");
  const fakeBin = join(fixture.temporary, "hostile-bin");
  const ambientNodeSentinel = join(fixture.temporary, "ambient-node-used");
  const powerShellModuleSentinel = join(fixture.temporary, "powershell-module-used");
  const powerShellModules = join(fixture.temporary, "hostile-powershell-modules");
  const utilityModule = join(powerShellModules, "Microsoft.PowerShell.Utility");
  const waitingParent = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true
  });
  try {
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      waitingParent.once("spawn", resolveSpawn);
      waitingParent.once("error", rejectSpawn);
    });
    await writeFakePackage(candidateSource, "1.0.0", NEXT_COMMIT, { health: true });
    const candidate = await makePackageStandalone(candidateSource);
    const installerUrl = new URL("../scripts/install.ts", import.meta.url).href;
    await writeFile(
      join(candidateSource, "dist", "install", "install.js"),
      `import ${JSON.stringify(installerUrl)};\n`
    );
    const upgrade = spawnSync(candidate.runtime, [
      join(root, "scripts", "install.ts"),
      "upgrade",
      "--source",
      candidateSource,
      "--prefix",
      fixture.prefix,
      "--version",
      "1.0.0",
      "--commit",
      NEXT_COMMIT,
      "--artifact-sha256",
      "8".repeat(64),
      "--defer-launchers-until-pid",
      String(waitingParent.pid)
    ], { cwd: root, encoding: "utf8", shell: false });
    assert.equal(upgrade.status, 0, String(upgrade.stderr || upgrade.stdout));

    const markerPath = join(fixture.prefix, ".launcher-activation.json");
    const pending = JSON.parse(await readFile(markerPath, "utf8"));
    assert.equal(pending.phase, "waiting");
    const generationName = (await readdir(join(fixture.prefix, "bin")))
      .find((name) => /^odinn\.[0-9a-f-]{36}\.cmd$/iu.test(name));
    assert.ok(generationName);
    const generationPath = join(fixture.prefix, "bin", generationName);
    const generationBefore = await lstat(generationPath);
    const generationBytes = await readFile(generationPath, "utf8");
    const powershellIndex = generationBytes.indexOf("C:\\Windows\\System32\\WindowsPowerShell");
    assert.ok(powershellIndex > 0);
    for (const name of HOSTILE_WINDOWS_RUNTIME_ENVIRONMENT_VARIABLES) {
      const clearIndex = generationBytes.indexOf(`set "${name}="`);
      assert.ok(clearIndex >= 0 && clearIndex < powershellIndex, `${name} must be cleared before PowerShell starts`);
    }
    assert.doesNotMatch(generationBytes, /Get-FileHash|Get-Item/u);
    assert.match(generationBytes, /\[System\.Security\.Cryptography\.SHA256\]::Create\(\)/u);

    await mkdir(fakeBin);
    await mkdir(utilityModule, { recursive: true });
    await writeFile(
      join(fakeBin, "node.cmd"),
      `@echo hostile>"${ambientNodeSentinel}"\r\n@exit /b 99\r\n`
    );
    await writeFile(join(utilityModule, "Microsoft.PowerShell.Utility.psm1"), `
[System.IO.File]::WriteAllText($env:ODINN_MODULE_SENTINEL, 'loaded')
function Get-FileHash {
  param([string]$LiteralPath, [string]$Algorithm)
  [pscustomobject]@{ Hash = $env:ODINN_FORGED_SHA256 }
}
Export-ModuleMember -Function Get-FileHash
`);
    const launcherPath = join(fixture.prefix, "bin", "odinn.cmd");
    const launched = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `call "${launcherPath}" --version`], {
      cwd: fixture.prefix,
      encoding: "utf8",
      shell: false,
      env: {
        ...process.env,
        PATH: `${fakeBin};${process.env.PATH ?? ""}`,
        COR_ENABLE_PROFILING: "1",
        COR_PROFILER_PATH: join(fixture.temporary, "hostile-profiler.dll"),
        COMPlus_EnableProfiling: "1",
        COMPlus_ProfilerPath: join(fixture.temporary, "hostile-complus-profiler.dll"),
        DOTNET_STARTUP_HOOKS: join(fixture.temporary, "hostile-startup-hook.dll"),
        PSModulePath: powerShellModules,
        ODINN_MODULE_SENTINEL: powerShellModuleSentinel,
        ODINN_FORGED_SHA256: candidate.executableSha256
      }
    });
    assert.equal(launched.status, 0, String(launched.stderr || launched.stdout));
    assert.equal(launched.stdout.trim(), "1.0.0");
    await assert.rejects(() => readFile(markerPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(ambientNodeSentinel, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(powerShellModuleSentinel, "utf8"), { code: "ENOENT" });
    const settled = JSON.parse(await readFile(join(fixture.prefix, "install-state.json"), "utf8"));
    assert.equal(settled.currentVersion, "1.0.0");
    assert.equal((await readFile(join(fixture.prefix, "current"), "utf8")).split(/\r?\n/u)[0], settled.current);
    const generationAfter = await lstat(generationPath);
    if (generationBefore.ino !== 0 && generationAfter.ino !== 0) {
      assert.equal(generationAfter.ino, generationBefore.ino, "equal generation bytes must preserve the physical file");
    }
  } finally {
    waitingParent.kill();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
    await rm(fixture.temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});

test("Windows launcher activation attempt 100 remains a valid terminal marker", {
  skip: process.platform !== "win32"
}, async () => {
  const fixture = await lifecycleFixture();
  const markerPath = join(fixture.prefix, ".launcher-activation.json");
  try {
    await initializeInstallerPointer(fixture.prefix);
    await writeTestLauncherActivationMarker({
      prefix: fixture.prefix,
      token: "88888888-8888-4888-8888-888888888888",
      versionId: fixture.priorId,
      waitForPid: 2_147_483_647,
      phase: "applying",
      attempts: 100
    });
    assertInstallerSuccess(runInstallerCommand(fixture.prefix, "status"));
    const first = JSON.parse(await readFile(markerPath, "utf8"));
    assert.equal(first.phase, "failed");
    assert.equal(first.attempts, 100);
    assert.match(first.lastError, /retry limit/u);
    assertInstallerSuccess(runInstallerCommand(fixture.prefix, "status"));
    const second = JSON.parse(await readFile(markerPath, "utf8"));
    assert.equal(second.attempts, 100);
    assert.equal(second.phase, "failed");
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("Windows deferred launcher activation recovers after finalizer crash and applying-phase power loss", {
  skip: process.platform !== "win32"
}, async () => {
  const fixture = await lifecycleFixture();
  const markerPath = join(fixture.prefix, ".launcher-activation.json");
  const launcherPath = join(fixture.prefix, "bin", "odinn.cmd");
  try {
    await initializeInstallerPointer(fixture.prefix);
    await writeTestLauncherActivationMarker({
      prefix: fixture.prefix,
      token: "11111111-1111-4111-8111-111111111111",
      versionId: fixture.priorId,
      waitForPid: 2_147_483_647,
      phase: "waiting"
    });
    assertInstallerSuccess(runInstallerCommand(fixture.prefix, "status"));
    await assert.rejects(() => readFile(markerPath), { code: "ENOENT" });
    assert.match(await readActiveWindowsGeneration(fixture.prefix), /ODINN_CURRENT/u);

    await writeFile(launcherPath, "partial launcher from interrupted activation\r\n");
    await writeTestLauncherActivationMarker({
      prefix: fixture.prefix,
      token: "22222222-2222-4222-8222-222222222222",
      versionId: fixture.priorId,
      waitForPid: 2_147_483_647,
      phase: "applying",
      attempts: 1
    });
    assertInstallerSuccess(runInstallerCommand(fixture.prefix, "status"));
    await assert.rejects(() => readFile(markerPath), { code: "ENOENT" });
    assert.doesNotMatch(await readFile(launcherPath, "utf8"), /partial launcher/u);
    assert.match(await readActiveWindowsGeneration(fixture.prefix), /ODINN_CURRENT/u);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("Windows deferred launcher activation records timeout and retires stale markers", {
  skip: process.platform !== "win32"
}, async () => {
  const fixture = await lifecycleFixture();
  const markerPath = join(fixture.prefix, ".launcher-activation.json");
  try {
    await initializeInstallerPointer(fixture.prefix);
    await writeTestLauncherActivationMarker({
      prefix: fixture.prefix,
      token: "33333333-3333-4333-8333-333333333333",
      versionId: fixture.priorId,
      waitForPid: process.pid,
      phase: "waiting",
      deadlineAt: new Date(Date.now() - 1_000).toISOString()
    });
    assertInstallerSuccess(runInstallerCommand(fixture.prefix, "status"));
    const timedOut = JSON.parse(await readFile(markerPath, "utf8"));
    assert.equal(timedOut.phase, "failed");
    assert.match(timedOut.lastError, /timed out/u);

    await writeTestLauncherActivationMarker({
      prefix: fixture.prefix,
      token: "44444444-4444-4444-8444-444444444444",
      versionId: "9.9.9-stale-candidate",
      waitForPid: 2_147_483_647,
      phase: "waiting"
    });
    assertInstallerSuccess(runInstallerCommand(fixture.prefix, "status"));
    await assert.rejects(() => readFile(markerPath), { code: "ENOENT" });
    const state = JSON.parse(await readFile(join(fixture.prefix, "install-state.json"), "utf8"));
    assert.equal(state.current, fixture.priorId);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("Windows deferred launcher activation persists write failure and retries safely", {
  skip: process.platform !== "win32"
}, async () => {
  const fixture = await lifecycleFixture();
  const markerPath = join(fixture.prefix, ".launcher-activation.json");
  const token = "55555555-5555-4555-8555-555555555555";
  const bin = join(fixture.prefix, "bin");
  const launcher = join(bin, "odinn.cmd");
  const externalLink = join(fixture.temporary, "linked-odinn.cmd");
  try {
    await initializeInstallerPointer(fixture.prefix);
    await mkdir(bin, { recursive: true });
    await writeFile(launcher, "old launcher\r\n");
    await link(launcher, externalLink);
    await writeTestLauncherActivationMarker({
      prefix: fixture.prefix,
      token,
      versionId: fixture.priorId,
      waitForPid: 2_147_483_647,
      phase: "applying",
      attempts: 1
    });
    assertInstallerSuccess(runInstallerCommand(fixture.prefix, "finalize-launchers", [
      "--wait-for-pid",
      "2147483647",
      "--version-id",
      fixture.priorId,
      "--activation-token",
      token
    ]));
    const failed = JSON.parse(await readFile(markerPath, "utf8"));
    assert.equal(failed.phase, "failed");
    assert.match(failed.lastError, /physical file|unrelated launcher entry/u);

    await rm(externalLink);
    assertInstallerSuccess(runInstallerCommand(fixture.prefix, "status"));
    await assert.rejects(() => readFile(markerPath), { code: "ENOENT" });
    assert.match(await readActiveWindowsGeneration(fixture.prefix), /ODINN_CURRENT/u);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("Windows installer cleans activation retirement debris left by power loss", {
  skip: process.platform !== "win32"
}, async () => {
  const fixture = await lifecycleFixture();
  const token = "66666666-6666-4666-8666-666666666666";
  const retiredPath = join(fixture.prefix, `.launcher-activation.json.retired-${token}`);
  const temporaryPath = join(fixture.prefix, ".launcher-activation.json.interrupted.tmp");
  try {
    await initializeInstallerPointer(fixture.prefix);
    await writeFile(retiredPath, "retired marker\n");
    await writeFile(temporaryPath, "partial marker\n");
    assertInstallerSuccess(runInstallerCommand(fixture.prefix, "status"));
    await assert.rejects(() => readFile(retiredPath), { code: "ENOENT" });
    await assert.rejects(() => readFile(temporaryPath), { code: "ENOENT" });
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("synchronous Windows health rollback cancels pending candidate launcher activation", {
  skip: process.platform !== "win32"
}, async () => {
  const fixture = await lifecycleFixture();
  const candidateId = `1.0.0-${NEXT_COMMIT.slice(0, 12)}`;
  const candidateRoot = join(fixture.prefix, "versions", candidateId);
  const markerPath = join(fixture.prefix, ".launcher-activation.json");
  try {
    await writeFakePackage(candidateRoot, "1.0.0", NEXT_COMMIT, { health: false });
    await writeFile(join(fixture.prefix, "install-state.json"), `${JSON.stringify({
      schemaVersion: 1,
      current: candidateId,
      currentVersion: "1.0.0",
      currentCommit: NEXT_COMMIT,
      previous: fixture.priorId,
      operation: "upgrade"
    }, null, 2)}\n`);
    await writeFile(join(fixture.prefix, "current"), `${candidateId}\r\ncompiled\r\n\r\n`);
    await writeTestLauncherActivationMarker({
      prefix: fixture.prefix,
      token: "77777777-7777-4777-8777-777777777777",
      versionId: candidateId,
      waitForPid: process.pid,
      phase: "waiting"
    });

    assertInstallerSuccess(runInstallerCommand(fixture.prefix, "rollback"));
    await assert.rejects(() => readFile(markerPath), { code: "ENOENT" });
    const state = JSON.parse(await readFile(join(fixture.prefix, "install-state.json"), "utf8"));
    assert.equal(state.current, fixture.priorId);
    const [currentVersionId] = (await readFile(join(fixture.prefix, "current"), "utf8")).split(/\r?\n/u);
    assert.equal(currentVersionId, fixture.priorId);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

async function makePackageStandalone(packageRoot: string) {
  const installedReleaseInfoPath = join(packageRoot, "release-info.json");
  const installedReleaseInfo = JSON.parse(await readFile(installedReleaseInfoPath, "utf8"));
  const runtimeBytes = await readFile(process.execPath);
  const executableSha256 = createHash("sha256").update(runtimeBytes).digest("hex");
  const target = `${process.platform}-${process.arch}`;
  const policyBytes = runtimePolicyFixture(process.version.slice(1), target, runtimeBytes.byteLength, executableSha256);
  const runtimePolicySha256 = createHash("sha256").update(policyBytes).digest("hex");
  const runtimeName = process.platform === "win32" ? "node.exe" : "node";
  await mkdir(join(packageRoot, "runtime"), { recursive: true });
  await writeFile(join(packageRoot, "runtime", runtimeName), runtimeBytes, { mode: 0o755 });
  await mkdir(join(packageRoot, "THIRD_PARTY_NOTICES"), { recursive: true });
  await writeFile(join(packageRoot, "THIRD_PARTY_NOTICES", "node-runtime-policy.json"), policyBytes);
  installedReleaseInfo.distribution = "standalone";
  installedReleaseInfo.embeddedRuntime = {
    version: process.version.slice(1),
    target,
    executableBytes: runtimeBytes.byteLength,
    executableSha256,
    runtimePolicySha256
  };
  await writeFile(installedReleaseInfoPath, `${JSON.stringify(installedReleaseInfo, null, 2)}\n`);
  const installedPackagePath = join(packageRoot, "package.json");
  const installedPackage = JSON.parse(await readFile(installedPackagePath, "utf8"));
  installedPackage.odinnStandalone = {
    runtime: "node",
    version: process.version.slice(1),
    target,
    executableSha256,
    runtimePolicySha256,
    runtimeBoundary: process.platform === "win32"
      ? "win32-system-launcher"
      : process.platform === "linux"
        ? "linux-static-pie"
        : "darwin-hardened-runtime"
  };
  await writeFile(installedPackagePath, `${JSON.stringify(installedPackage, null, 2)}\n`);
  return { executableSha256, runtime: join(packageRoot, "runtime", runtimeName), target };
}

function runtimePolicyFixture(version: string, target: string, executableBytes: number, executableSha256: string, archiveSha256 = "a".repeat(64)): Buffer {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    version,
    origin: "https://nodejs.org",
    signedManifest: {
      sha256: "b".repeat(64),
      cleartextSha256: "c".repeat(64)
    },
    keyring: {
      sha256: "d".repeat(64),
      allowedPrimaryFingerprints: ["E".repeat(40)]
    },
    targets: {
      [target]: {
        sha256: archiveSha256,
        executableBytes,
        executableSha256
      }
    }
  }, null, 2)}\n`);
}

async function addNativeStandaloneLaunchers(packageRoot: string, executableSha256: string): Promise<void> {
  const target = `${process.platform}-${process.arch}` as "linux-x64" | "darwin-x64";
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await mkdir(join(packageRoot, "install"), { recursive: true });
  const launcher = join(packageRoot, "bin", "odinn");
  await buildNativeLauncher(target, launcher);
  const launcherBytes = await readFile(launcher);
  await writeFile(join(packageRoot, "bin", "odinn-gateway"), launcherBytes, { mode: 0o755 });
  await writeFile(join(packageRoot, "install", "install.sh"), launcherBytes, { mode: 0o755 });
  await writeFile(join(packageRoot, "bin", "odinn.runtime.sh"), standaloneUnixLauncher("dist/cli/index.js", target, executableSha256));
  await writeFile(join(packageRoot, "bin", "odinn-gateway.runtime.sh"), standaloneUnixLauncher("dist/gateway/server.js", target, executableSha256));
  await writeFile(join(packageRoot, "install", "install.sh.runtime.sh"), standaloneUnixLauncher("dist/install/install.js", target, executableSha256));
  const packagePath = join(packageRoot, "package.json");
  const packageMetadata = JSON.parse(await readFile(packagePath, "utf8"));
  packageMetadata.odinnStandalone.launcherSha256 = createHash("sha256").update(launcherBytes).digest("hex");
  await writeFile(packagePath, `${JSON.stringify(packageMetadata, null, 2)}\n`);
}

test("verified local update installs immutably, reports identity, and remains rollbackable", async () => {
  const fixture = await lifecycleFixture();
  try {
    const release = await createRelease(fixture.temporary, "1.0.0", NEXT_COMMIT, { health: true });
    const options = {
      identity: { applicationVersion: "0.9.0", applicationCommit: PRIOR_COMMIT },
      stateDir: fixture.state,
      packageRoot: join(fixture.prefix, "versions", fixture.priorId),
      prefix: fixture.prefix,
      manifest: release.manifest,
      checksums: release.checksums,
      artifact: release.artifact
    };
    const stateBeforeCheck = await readFile(join(fixture.state, "state-schema.json"), "utf8");
    const check = await checkForUpdate(options);
    assert.equal(check.updateAvailable, true);
    assert.equal(check.availableVersion, "1.0.0");
    assert.equal(check.stateMigrationRequired, false);
    assert.ok(check.downloadSize > 0);
    assert.equal(await readFile(join(fixture.state, "state-schema.json"), "utf8"), stateBeforeCheck);

    const updated = await updateApplication(options);
    assert.equal(updated.ok, true);
    assert.equal(updated.version, "1.0.0");
    assert.equal(updated.previousVersionId, fixture.priorId);
    const installed = JSON.parse(await readFile(join(fixture.prefix, "install-state.json"), "utf8"));
    assert.equal(installed.currentVersion, "1.0.0");
    assert.equal(installed.previous, fixture.priorId);

    const rolledBack = await rollbackApplication({
      identity: { applicationVersion: "1.0.0", applicationCommit: NEXT_COMMIT },
      stateDir: fixture.state,
      packageRoot: join(fixture.prefix, "versions", installed.current),
      prefix: fixture.prefix
    });
    assert.equal(rolledBack.version, "0.9.0");
    assert.equal(rolledBack.versionId, fixture.priorId);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("installed standalone native lifecycle completes runtime N-to-N+1 update, rollback, and uninstall on Unix", {
  skip: process.platform === "win32" || process.arch !== "x64"
}, async () => {
  const fixture = await lifecycleFixture();
  try {
    await rm(fixture.prefix, { recursive: true, force: true });
    const priorSource = join(fixture.temporary, "prior-standalone-package");
    await writeFakePackage(priorSource, "0.9.0", PRIOR_COMMIT, { health: true });
    const priorRuntime = await makePackageStandalone(priorSource);
    await addNativeStandaloneLaunchers(priorSource, priorRuntime.executableSha256);
    const installedResult = spawnSync(priorRuntime.runtime, [
      join(root, "scripts", "install.ts"),
      "install",
      "--source",
      priorSource,
      "--prefix",
      fixture.prefix,
      "--artifact-sha256",
      "1".repeat(64)
    ], { cwd: root, encoding: "utf8", shell: false });
    assert.equal(installedResult.status, 0, installedResult.stderr || installedResult.stdout);
    const installedPrior = JSON.parse(await readFile(join(fixture.prefix, "install-state.json"), "utf8"));
    for (const name of ["odinn", "odinn.runtime.sh", "odinn-gateway", "odinn-gateway.runtime.sh"]) {
      const metadata = await lstat(join(fixture.prefix, "bin", name));
      assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1, name);
    }

    const release = await createStandaloneRelease(fixture.temporary, "1.0.0", NEXT_COMMIT, {
      runtimeVersion: "24.20.0",
      reportedRuntimeVersion: "24.20.0"
    });
    const updated = await updateApplication({
      identity: { applicationVersion: "0.9.0", applicationCommit: PRIOR_COMMIT },
      stateDir: fixture.state,
      packageRoot: join(fixture.prefix, "versions", installedPrior.current),
      prefix: fixture.prefix,
      manifest: release.manifest,
      checksums: release.checksums,
      artifact: release.artifact
    });
    assert.equal(updated.version, "1.0.0");
    const installedCandidate = JSON.parse(await readFile(join(fixture.prefix, "install-state.json"), "utf8"));
    const candidateInfo = JSON.parse(await readFile(join(fixture.prefix, "versions", installedCandidate.current, "release-info.json"), "utf8"));
    assert.equal(candidateInfo.embeddedRuntime.version, "24.20.0");
    assert.notEqual(candidateInfo.embeddedRuntime.version, process.version.slice(1));

    const rolledBack = await rollbackApplication({
      identity: { applicationVersion: "1.0.0", applicationCommit: NEXT_COMMIT },
      stateDir: fixture.state,
      packageRoot: join(fixture.prefix, "versions", installedCandidate.current),
      prefix: fixture.prefix
    });
    assert.equal(rolledBack.version, "0.9.0");
    assert.equal(rolledBack.versionId, installedPrior.current);

    const removed = await uninstallApplication({ prefix: fixture.prefix, stateDir: fixture.state });
    assert.equal(removed.ok, true);
    assert.equal(removed.stateRemoved, false);
    assert.equal(await readFile(join(fixture.state, "config.json"), "utf8"), "{\"version\":1}\n");
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("standalone candidate rejects authenticated policy/version mismatches before installation", {
  skip: process.platform === "win32" || (process.platform === "darwin" && process.arch !== "x64")
}, async () => {
  for (const mismatch of ["runtime-output", "policy"] as const) {
    const fixture = await lifecycleFixture();
    try {
      const priorRoot = join(fixture.prefix, "versions", fixture.priorId);
      await makePackageStandalone(priorRoot);
      const sentinel = join(fixture.temporary, `${mismatch}-executed`);
      const release = await createStandaloneRelease(fixture.temporary, "1.0.0", NEXT_COMMIT, {
        runtimeVersion: "24.20.0",
        reportedRuntimeVersion: mismatch === "runtime-output" ? "24.21.0" : "24.20.0",
        policyVersion: mismatch === "policy" ? "24.21.0" : "24.20.0",
        executionSentinel: mismatch === "policy" ? sentinel : undefined
      });
      await assert.rejects(
        () => updateApplication({
          identity: { applicationVersion: "0.9.0", applicationCommit: PRIOR_COMMIT },
          stateDir: fixture.state,
          packageRoot: priorRoot,
          prefix: fixture.prefix,
          manifest: release.manifest,
          checksums: release.checksums,
          artifact: release.artifact
        }),
        mismatch === "policy" ? /policy does not match authenticated runtime metadata/u : /version output does not match authenticated metadata/u
      );
      assert.equal(JSON.parse(await readFile(join(fixture.prefix, "install-state.json"), "utf8")).current, fixture.priorId);
      if (mismatch === "policy") await assert.rejects(() => readFile(sentinel), { code: "ENOENT" });
    } finally {
      await rm(fixture.temporary, { recursive: true, force: true });
    }
  }
});

test("standalone update checks accept the trusted macOS /var alias and enforce the controlled platform matrix", async () => {
  const fixture = await lifecycleFixture();
  try {
    const packageRoot = join(fixture.prefix, "versions", fixture.priorId);
    await makePackageStandalone(packageRoot);
    if (process.platform === "darwin") {
      assert.equal((await lstat("/var")).isSymbolicLink(), true);
      assert.notEqual(resolve(await realpath(fixture.temporary)), resolve(fixture.temporary));
    }

    const release = await createRelease(fixture.temporary, "1.0.0", NEXT_COMMIT, { health: true });
    const manifest = JSON.parse(await readFile(release.manifest, "utf8"));
    manifest.nodeRuntimePolicySha256 = "f".repeat(64);
    manifest.standaloneArtifacts = ["darwin-x64", "linux-x64", "win32-x64"].map((target, index) => {
      const name = `odinn-v1.0.0-standalone-${target}.${target === "win32-x64" ? "zip" : "tar.gz"}`;
      const sha256 = String(index + 3).repeat(64);
      manifest.archiveSha256[name] = sha256;
      return {
        name,
        target,
        bytes: 1,
        sha256,
        embeddedRuntime: {
          version: "24.19.0",
          target,
          archiveSha256: String(index + 6).repeat(64),
          executableBytes: 1,
          executableSha256: String(index + 7).repeat(64),
          runtimePolicySha256: manifest.nodeRuntimePolicySha256
        }
      };
    });
    await writeFile(release.manifest, `${JSON.stringify(manifest, null, 2)}\n`);

    const options = {
      identity: { applicationVersion: "0.9.0", applicationCommit: PRIOR_COMMIT },
      stateDir: fixture.state,
      packageRoot,
      prefix: fixture.prefix,
      manifest: release.manifest,
      checksums: release.checksums,
      artifact: release.artifact
    };
    const target = `${process.platform}-${process.arch}`;
    const supportedTargets = new Set(["darwin-x64", "linux-x64", "win32-x64"]);
    if (!supportedTargets.has(target)) {
      await assert.rejects(() => checkForUpdate(options), new RegExp(`no controlled standalone artifact for ${target}`, "u"));
      return;
    }

    const check = await checkForUpdate(options);
    assert.equal(
      check.artifact,
      `odinn-v1.0.0-standalone-${process.platform}-${process.arch}.${process.platform === "win32" ? "zip" : "tar.gz"}`
    );
    assert.notEqual(check.artifact, basename(release.artifact));
    assert.ok(check.verificationRequirements.includes("embedded runtime and policy identity"));
    await assert.rejects(
      () => updateApplication(options),
      /does not match the required standalone artifact/u
    );
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("standalone runtime validation rejects a user-created symlink or reparse-point ancestor", async () => {
  const fixture = await lifecycleFixture();
  try {
    const packageRoot = join(fixture.prefix, "versions", fixture.priorId);
    await makePackageStandalone(packageRoot);
    const release = await createRelease(fixture.temporary, "1.0.0", NEXT_COMMIT, { health: true });
    const linkedVersions = join(fixture.temporary, "linked-versions");
    await symlink(dirname(packageRoot), linkedVersions, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      () => checkForUpdate({
        identity: { applicationVersion: "0.9.0", applicationCommit: PRIOR_COMMIT },
        stateDir: fixture.state,
        packageRoot: join(linkedVersions, basename(packageRoot)),
        prefix: fixture.prefix,
        manifest: release.manifest,
        checksums: release.checksums,
        artifact: release.artifact
      }),
      /symbolic link|reparse point|linked ancestor/u
    );
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("update check follows semantic prerelease ordering", async () => {
  const fixture = await lifecycleFixture();
  try {
    const release = await createRelease(fixture.temporary, "1.0.0-rc.10", NEXT_COMMIT, { health: true });
    const check = await checkForUpdate({
      identity: { applicationVersion: "1.0.0-rc.2", applicationCommit: PRIOR_COMMIT },
      stateDir: fixture.state,
      packageRoot: join(fixture.prefix, "versions", fixture.priorId),
      prefix: fixture.prefix,
      manifest: release.manifest,
      checksums: release.checksums,
      artifact: release.artifact
    });
    assert.equal(check.updateAvailable, true);
    assert.equal(check.availableReleaseChannel, "local");
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("failed post-update health restores the previous application pointer", async () => {
  const fixture = await lifecycleFixture();
  try {
    const release = await createRelease(fixture.temporary, "1.0.0", NEXT_COMMIT, { health: false });
    await assert.rejects(() => updateApplication({
      identity: { applicationVersion: "0.9.0", applicationCommit: PRIOR_COMMIT },
      stateDir: fixture.state,
      packageRoot: join(fixture.prefix, "versions", fixture.priorId),
      prefix: fixture.prefix,
      manifest: release.manifest,
      checksums: release.checksums,
      artifact: release.artifact
    }), /post-update health check failed/u);
    const installed = JSON.parse(await readFile(join(fixture.prefix, "install-state.json"), "utf8"));
    assert.equal(installed.current, fixture.priorId);
    assert.equal(installed.currentVersion, "0.9.0");
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("migration-required update restores the complete pre-update state after health failure", async () => {
  const fixture = await lifecycleFixture();
  try {
    const originalConfig = await readFile(join(fixture.state, "config.json"), "utf8");
    await writeFile(join(fixture.state, "gateway.token"), "private-token\n");
    const release = await createRelease(fixture.temporary, "1.0.0", NEXT_COMMIT, {
      health: false,
      migration: true,
      mutateStateBeforeHealthFailure: true
    });
    await assert.rejects(() => updateApplication({
      identity: { applicationVersion: "0.9.0", applicationCommit: PRIOR_COMMIT },
      stateDir: fixture.state,
      packageRoot: join(fixture.prefix, "versions", fixture.priorId),
      prefix: fixture.prefix,
      manifest: release.manifest,
      checksums: release.checksums,
      artifact: release.artifact
    }), /post-update health check failed/u);
    assert.equal(await readFile(join(fixture.state, "config.json"), "utf8"), originalConfig);
    assert.equal(await readFile(join(fixture.state, "gateway.token"), "utf8"), "private-token\n");
    const history = (await readFile(join(fixture.prefix, "lifecycle-history.jsonl"), "utf8"))
      .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.equal(history.at(-1).status, "failed");
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("update rejects checksum disagreement before installing files", async () => {
  const fixture = await lifecycleFixture();
  try {
    const release = await createRelease(fixture.temporary, "1.0.0", NEXT_COMMIT, { health: true });
    await writeFile(release.checksums, `${"0".repeat(64)}  ${basename(release.artifact)}\n`);
    await assert.rejects(() => updateApplication({
      identity: { applicationVersion: "0.9.0", applicationCommit: PRIOR_COMMIT },
      stateDir: fixture.state,
      packageRoot: join(fixture.prefix, "versions", fixture.priorId),
      prefix: fixture.prefix,
      manifest: release.manifest,
      checksums: release.checksums,
      artifact: release.artifact
    }), /artifact checksum mismatch/u);
    const installed = JSON.parse(await readFile(join(fixture.prefix, "install-state.json"), "utf8"));
    assert.equal(installed.current, fixture.priorId);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("update rejects archive traversal before extraction", { skip: process.platform !== "linux" }, async () => {
  const fixture = await lifecycleFixture();
  try {
    const release = await createRelease(fixture.temporary, "1.0.0", NEXT_COMMIT, { health: true });
    const releaseRoot = join(fixture.temporary, "release-1.0.0-healthy");
    run("tar", [
      "--transform",
      "s,^,../,",
      "-czf",
      release.artifact,
      "-C",
      releaseRoot,
      "odinn-v1.0.0"
    ], releaseRoot);
    const digest = createHash("sha256").update(await readFile(release.artifact)).digest("hex");
    const manifest = JSON.parse(await readFile(release.manifest, "utf8"));
    manifest.archiveSha256[basename(release.artifact)] = digest;
    await writeFile(release.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(release.checksums, `${digest}  ${basename(release.artifact)}\n`);
    await assert.rejects(() => updateApplication({
      identity: { applicationVersion: "0.9.0", applicationCommit: PRIOR_COMMIT },
      stateDir: fixture.state,
      packageRoot: join(fixture.prefix, "versions", fixture.priorId),
      prefix: fixture.prefix,
      manifest: release.manifest,
      checksums: release.checksums,
      artifact: release.artifact
    }), /unsafe path/u);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("rollback refuses an application that cannot read current state", async () => {
  const fixture = await lifecycleFixture();
  try {
    const nextId = `1.0.0-${NEXT_COMMIT.slice(0, 12)}`;
    await writeFakePackage(join(fixture.prefix, "versions", nextId), "1.0.0", NEXT_COMMIT, { health: true });
    await writeFile(join(fixture.prefix, "install-state.json"), `${JSON.stringify({
      schemaVersion: 1,
      current: nextId,
      currentVersion: "1.0.0",
      currentCommit: NEXT_COMMIT,
      previous: fixture.priorId,
      operation: "upgrade"
    }, null, 2)}\n`);
    const stateMetadata = JSON.parse(await readFile(join(fixture.state, "state-schema.json"), "utf8"));
    stateMetadata.minimumApplicationVersion = "1.0.0";
    await writeFile(join(fixture.state, "state-schema.json"), `${JSON.stringify(stateMetadata, null, 2)}\n`);
    await assert.rejects(() => rollbackApplication({
      identity: { applicationVersion: "1.0.0", applicationCommit: NEXT_COMMIT },
      stateDir: fixture.state,
      packageRoot: join(fixture.prefix, "versions", nextId),
      prefix: fixture.prefix
    }), /rollback refused: state requires Odinn 1\.0\.0 or newer/u);
    const installed = JSON.parse(await readFile(join(fixture.prefix, "install-state.json"), "utf8"));
    assert.equal(installed.current, nextId);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("uninstall preserves state by default and requires explicit destructive confirmation", async () => {
  const fixture = await lifecycleFixture();
  try {
    const preserved = await uninstallApplication({ prefix: fixture.prefix, stateDir: fixture.state });
    assert.equal(preserved.stateRemoved, false);
    assert.equal(await readFile(join(fixture.state, "config.json"), "utf8"), "{\"version\":1}\n");
    await assert.rejects(() => uninstallApplication({
      prefix: fixture.prefix,
      stateDir: fixture.state,
      removeState: true
    }), /requires --confirm or --force/u);
    const removed = await uninstallApplication({
      prefix: fixture.prefix,
      stateDir: fixture.state,
      removeState: true,
      force: true
    });
    assert.equal(removed.stateRemoved, true);
    await assert.rejects(() => readFile(join(fixture.state, "config.json"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("uninstall refuses an active installer finalizer lock without deleting installation state", async () => {
  const fixture = await lifecycleFixture();
  const lockPath = join(fixture.prefix, ".install.lock");
  try {
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      token: "active-finalizer-test",
      startedAt: new Date().toISOString()
    })}\n`);
    await assert.rejects(
      () => uninstallApplication({ prefix: fixture.prefix, stateDir: fixture.state }),
      /another installer command is active/u
    );
    assert.equal(JSON.parse(await readFile(join(fixture.prefix, "install-state.json"), "utf8")).current, fixture.priorId);
    assert.equal((await lstat(join(fixture.prefix, "versions", fixture.priorId))).isDirectory(), true);

    await rm(lockPath, { recursive: true, force: false });
    const removed = await uninstallApplication({ prefix: fixture.prefix, stateDir: fixture.state });
    assert.equal(removed.ok, true);
    await assert.rejects(() => lstat(lockPath), { code: "ENOENT" });
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("uninstall refuses a symlinked installation prefix", { skip: process.platform === "win32" }, async () => {
  const fixture = await lifecycleFixture();
  const linkedPrefix = join(fixture.temporary, "linked-install");
  try {
    await symlink(fixture.prefix, linkedPrefix, "dir");
    await assert.rejects(() => uninstallApplication({
      prefix: linkedPrefix,
      stateDir: fixture.state
    }), /install prefix must be a physical directory/u);
    assert.equal(JSON.parse(await readFile(join(fixture.prefix, "install-state.json"), "utf8")).current, fixture.priorId);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("standalone lifecycle admits physical native launcher companions and rejects hard-linked companions", {
  skip: process.platform === "win32"
}, async () => {
  const fixture = await lifecycleFixture();
  try {
    const bin = join(fixture.prefix, "bin");
    await mkdir(bin, { recursive: true });
    for (const name of [
      "odinn",
      "odinn.runtime.sh",
      "odinn-gateway",
      "odinn-gateway.runtime.sh",
      "odinn.99999999-9999-4999-8999-999999999999.cmd",
      "odinn-gateway.99999999-9999-4999-8999-999999999999.cmd"
    ]) {
      await writeFile(join(bin, name), `${name}\n`, { mode: name.endsWith(".runtime.sh") ? 0o600 : 0o755 });
    }
    const companion = join(bin, "odinn.runtime.sh");
    const externalLink = join(fixture.temporary, "linked-launcher-companion");
    await link(companion, externalLink);
    await assert.rejects(
      () => uninstallApplication({ prefix: fixture.prefix, stateDir: fixture.state }),
      /unexpected launcher entry: odinn\.runtime\.sh/u
    );
    await assert.rejects(() => lstat(join(fixture.prefix, ".install.lock")), { code: "ENOENT" });
    await rm(externalLink);
    const removed = await uninstallApplication({ prefix: fixture.prefix, stateDir: fixture.state });
    assert.equal(removed.ok, true);
    assert.equal(removed.stateRemoved, false);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

async function createRelease(
  temporary: string,
  version: string,
  commit: string,
  options: { health: boolean; migration?: boolean; mutateStateBeforeHealthFailure?: boolean }
) {
  const releases = join(temporary, `release-${version}-${options.health ? "healthy" : "failed"}`);
  const packageRoot = join(releases, `odinn-v${version}`);
  await writeFakePackage(packageRoot, version, commit, options);
  const artifactName = process.platform === "win32" ? `odinn-v${version}.zip` : `odinn-v${version}.tar.gz`;
  const artifact = join(releases, artifactName);
  if (process.platform === "win32") {
    run(trustedTool("tar"), ["-a", "-cf", artifact, "-C", releases, basename(packageRoot)], releases);
  } else {
    run("tar", ["-czf", artifact, "-C", releases, basename(packageRoot)], releases);
  }
  const digest = createHash("sha256").update(await readFile(artifact)).digest("hex");
  const runtimeSha256 = "c".repeat(64);
  const manifest = join(releases, "release-manifest.json");
  await writeFile(manifest, `${JSON.stringify({
    name: "odinn",
    version,
    commit,
    distribution: "compiled",
    runtimeSha256,
    artifacts: [artifactName],
    archiveSha256: { [artifactName]: digest },
    stateSchemas: STATE_SCHEMA_TARGETS,
    minimumApplicationVersionForTargetState: "0.9.0"
  }, null, 2)}\n`);
  const checksums = join(releases, "SHA256SUMS.txt");
  await writeFile(checksums, `${digest}  ${artifactName}\n`);
  return { artifact, manifest, checksums };
}

async function readActiveWindowsGeneration(prefix: string): Promise<string> {
  const bin = join(prefix, "bin");
  const trampoline = await readFile(join(bin, "odinn.cmd"), "utf8");
  const match = trampoline.match(/^@echo off\r?\n(?:call )?"%~dp0([^"\r\n]+\.cmd)" %\*/iu);
  assert.ok(match?.[1], "installed Windows launcher must point to an immutable generation");
  return await readFile(join(bin, match[1]), "utf8");
}

async function createStandaloneRelease(
  temporary: string,
  version: string,
  commit: string,
  options: {
    runtimeVersion: string;
    reportedRuntimeVersion: string;
    policyVersion?: string;
    executionSentinel?: string;
  }
) {
  const target = `${process.platform}-${process.arch}`;
  const releases = join(temporary, `standalone-release-${version}-${options.reportedRuntimeVersion}-${options.policyVersion ?? "matching"}`);
  const packageRootName = `odinn-v${version}-standalone-${target}`;
  const packageRoot = join(releases, packageRootName);
  await writeFakePackage(packageRoot, version, commit, { health: true });
  const runtimePath = join(packageRoot, "runtime", "node");
  await mkdir(dirname(runtimePath), { recursive: true });
  const executionMark = options.executionSentinel ? `: > ${shellQuote(options.executionSentinel)}\n` : "";
  await writeFile(runtimePath, `#!/bin/sh\nset -eu\n${executionMark}if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then\n  printf '%s\\n' ${shellQuote(`v${options.reportedRuntimeVersion}`)}\n  exit 0\nfi\nexec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o755 });
  const runtimeBytes = await readFile(runtimePath);
  const executableSha256 = createHash("sha256").update(runtimeBytes).digest("hex");
  const archiveSha256 = "9".repeat(64);
  const policyBytes = runtimePolicyFixture(
    options.policyVersion ?? options.runtimeVersion,
    target,
    runtimeBytes.byteLength,
    executableSha256,
    archiveSha256
  );
  const runtimePolicySha256 = createHash("sha256").update(policyBytes).digest("hex");
  await mkdir(join(packageRoot, "THIRD_PARTY_NOTICES"), { recursive: true });
  await writeFile(join(packageRoot, "THIRD_PARTY_NOTICES", "node-runtime-policy.json"), policyBytes);
  const embeddedRuntime = {
    version: options.runtimeVersion,
    target,
    archiveSha256,
    executableBytes: runtimeBytes.byteLength,
    executableSha256,
    runtimePolicySha256
  };
  const releaseInfoPath = join(packageRoot, "release-info.json");
  const releaseInfo = JSON.parse(await readFile(releaseInfoPath, "utf8"));
  releaseInfo.distribution = "standalone";
  releaseInfo.embeddedRuntime = embeddedRuntime;
  await writeFile(releaseInfoPath, `${JSON.stringify(releaseInfo, null, 2)}\n`);
  const packagePath = join(packageRoot, "package.json");
  const packageMetadata = JSON.parse(await readFile(packagePath, "utf8"));
  packageMetadata.odinnStandalone = {
    runtime: "node",
    version: options.runtimeVersion,
    target,
    executableSha256,
    runtimePolicySha256,
    runtimeBoundary: process.platform === "linux" ? "linux-static-pie" : "darwin-hardened-runtime"
  };
  await writeFile(packagePath, `${JSON.stringify(packageMetadata, null, 2)}\n`);

  const artifactName = `${packageRootName}.tar.gz`;
  const artifact = join(releases, artifactName);
  run("tar", ["-czf", artifact, "-C", releases, packageRootName], releases);
  const artifactBytes = await readFile(artifact);
  const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
  const archiveSha256ByName: Record<string, string> = {};
  const standaloneArtifacts = ["darwin-x64", "linux-x64", "win32-x64"].map((matrixTarget, index) => {
    const name = `odinn-v${version}-standalone-${matrixTarget}.${matrixTarget === "win32-x64" ? "zip" : "tar.gz"}`;
    const selected = matrixTarget === target;
    const sha256 = selected ? artifactSha256 : String(index + 3).repeat(64);
    archiveSha256ByName[name] = sha256;
    return {
      name,
      target: matrixTarget,
      bytes: selected ? artifactBytes.byteLength : 1,
      sha256,
      embeddedRuntime: selected ? embeddedRuntime : {
        version: options.runtimeVersion,
        target: matrixTarget,
        archiveSha256: String(index + 6).repeat(64),
        executableBytes: 1,
        executableSha256: String(index + 7).repeat(64),
        runtimePolicySha256
      }
    };
  });
  const compiledName = `odinn-v${version}.tar.gz`;
  archiveSha256ByName[compiledName] = "1".repeat(64);
  const manifest = join(releases, "release-manifest.json");
  await writeFile(manifest, `${JSON.stringify({
    name: "odinn",
    version,
    commit,
    distribution: "compiled",
    runtimeSha256: "c".repeat(64),
    artifacts: [compiledName],
    standaloneArtifacts,
    nodeRuntimePolicySha256: runtimePolicySha256,
    archiveSha256: archiveSha256ByName,
    stateSchemas: STATE_SCHEMA_TARGETS,
    minimumApplicationVersionForTargetState: "0.9.0"
  }, null, 2)}\n`);
  const checksums = join(releases, "SHA256SUMS.txt");
  await writeFile(checksums, `${artifactSha256}  ${artifactName}\n`);
  return { artifact, manifest, checksums };
}

async function writeFakePackage(
  root: string,
  version: string,
  commit: string,
  options: { health: boolean; migration?: boolean; mutateStateBeforeHealthFailure?: boolean }
) {
  await mkdir(join(root, "dist", "cli"), { recursive: true });
  await mkdir(join(root, "dist", "gateway"), { recursive: true });
  await mkdir(join(root, "dist", "install"), { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "@bluedot-it/odinn", version, type: "module" }, null, 2)}\n`);
  await writeFile(join(root, "release-info.json"), `${JSON.stringify({
    schemaVersion: 2,
    name: "odinn",
    version,
    commit,
    distribution: "compiled",
    runtimeSha256: "c".repeat(64)
  }, null, 2)}\n`);
  const cli = `import{writeFileSync}from"node:fs";import{join}from"node:path";const args=process.argv.slice(2);if(args[0]==="--version"){console.log(${JSON.stringify(version)});}else if(args[0]==="state"&&args[1]==="migrate"){console.log(JSON.stringify({steps:${options.migration ? "[{id:'test-migration'}]" : "[]"},blockingIncompatibilities:[]}));}else if(args[0]==="doctor"){${options.mutateStateBeforeHealthFailure ? 'const index=args.indexOf("--state");writeFileSync(join(args[index+1],"config.json"),"{invalid\\n");' : ""}console.log(JSON.stringify({ok:${String(options.health)}}));}else{console.error("unsupported fake CLI command");process.exitCode=1;}\n`;
  await writeFile(join(root, "dist", "cli", "index.js"), cli);
  await writeFile(join(root, "dist", "gateway", "server.js"), "export {};\n");
  await writeFile(join(root, "dist", "install", "install.js"), FAKE_INSTALLER);
  await chmod(join(root, "dist", "install", "install.js"), 0o755);
  await writeFile(join(root, "install-metadata.json"), `${JSON.stringify({
    schemaVersion: 2,
    version,
    commit,
    runtimeSha256: "c".repeat(64),
    artifactSha256: "unknown",
    toolchain: { node: process.version, distribution: "compiled" }
  }, null, 2)}\n`);
}

const FAKE_INSTALLER = `
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
const [command,...args]=process.argv.slice(2);
const option=(name)=>{const index=args.indexOf(name);return index>=0?args[index+1]:"";};
const prefix=option("--prefix");
const statePath=join(prefix,"install-state.json");
const currentPath=join(prefix,"current");
const readState=async()=>{try{return JSON.parse(await readFile(statePath,"utf8"));}catch(error){if(error.code==="ENOENT")return{schemaVersion:1,current:null,previous:null};throw error;}};
const writeState=async(value)=>{await mkdir(prefix,{recursive:true});const temporary=statePath+".tmp";await writeFile(temporary,JSON.stringify(value,null,2)+"\\n");await rename(temporary,statePath);};
const writeCurrent=async(id,distribution,runtimeSha256)=>{await writeFile(currentPath,id+"\\n"+distribution+"\\n"+runtimeSha256+"\\n");};
if(command==="upgrade"||command==="install"){
  const source=option("--source");
  const pkg=JSON.parse(await readFile(join(source,"package.json"),"utf8"));
  const info=JSON.parse(await readFile(join(source,"release-info.json"),"utf8"));
  const id=pkg.version+"-"+info.commit.slice(0,12);
  const destination=join(prefix,"versions",id);
  await mkdir(join(prefix,"versions"),{recursive:true});
  try{await cp(source,destination,{recursive:true,errorOnExist:true,force:false});}catch(error){if(error.code!=="ERR_FS_CP_EEXIST"&&error.code!=="EEXIST")throw error;}
  const distribution=info.distribution??"source";
  const toolchain={node:process.version,distribution,...(distribution==="standalone"?{embeddedRuntime:info.embeddedRuntime}:{})};
  await writeFile(join(destination,"install-metadata.json"),JSON.stringify({schemaVersion:2,version:pkg.version,commit:info.commit,runtimeSha256:info.runtimeSha256,artifactSha256:option("--artifact-sha256"),toolchain},null,2)+"\\n");
  const previous=await readState();
  await writeState({schemaVersion:1,current:id,currentVersion:pkg.version,currentCommit:info.commit,previous:previous.current&&previous.current!==id?previous.current:previous.previous??null,operation:command});
  await writeCurrent(id,distribution,distribution==="standalone"?info.embeddedRuntime.executableSha256:"");
}else if(command==="rollback"){
  const current=await readState();
  if(!current.previous)throw new Error("no previous");
  const metadata=JSON.parse(await readFile(join(prefix,"versions",current.previous,"install-metadata.json"),"utf8"));
  await writeState({...current,current:current.previous,currentVersion:metadata.version,currentCommit:metadata.commit,previous:current.current,operation:"rollback"});
  await writeCurrent(current.previous,metadata.toolchain.distribution,metadata.toolchain.distribution==="standalone"?metadata.toolchain.embeddedRuntime.executableSha256:"");
}else{throw new Error("unsupported fake installer command");}
`;

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
