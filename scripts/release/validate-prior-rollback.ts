import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const BASELINE_VERSION = "1.0.0";
export const BASELINE_TAG_COMMIT = "5114dbe9a46cfed1570d062eb22238773be3de26";
export const BASELINE_DIGESTS: Record<string, string> = {
  "odinn-v1.0.0.tar.gz": "e7389045bc2e5f671ce58b45cde8b053a2017f8f6120d70cde11a4c221ab6215",
  "odinn-v1.0.0.zip": "d96e0fb96039230f9b66e99bd5562844861b043424e2a67e01397d003b019b7d"
};
const BASELINE_RELEASE_URL_BASE = "https://github.com/BlueDot-IT/Odinn-Forge/releases/download/v1.0.0";

type ValidationOutcome = {
  step: number;
  name: string;
  ok: boolean;
  detail?: string;
};

type EvidenceRecord = {
  os: string;
  arch: string;
  node: string;
  baseline: {
    version: string;
    commit: string;
    archive: string;
    checksum: string;
  };
  candidate: {
    version: string;
    commit: string;
    archive: string;
    checksum: string;
  };
  outcomes: ValidationOutcome[];
  result: "passed" | "failed";
  timestamp: string;
};

function runCommand(command: string, args: string[], cwd: string, env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const baseEnv = { ...process.env };
  delete baseEnv.ODINN_RELEASE_COMMIT;
  delete baseEnv.ODINN_ARTIFACT_SHA256;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...baseEnv, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && (command.endsWith(".cmd") || command.endsWith(".bat"))
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error?.message ?? "")
  };
}

function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): string {
  const result = runCommand(command, args, cwd, env);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function parseOption(args: string[], name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function getOrDownloadAsset(
  filename: string,
  cacheDir: string | undefined,
  downloadUrl: string
): Promise<Buffer> {
  if (cacheDir) {
    const cachedPath = join(cacheDir, filename);
    try {
      return await readFile(cachedPath);
    } catch {
      // Not cached yet, fetch from network
    }
  }
  const data = await fetchBuffer(downloadUrl);
  if (cacheDir) {
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(join(cacheDir, filename), data);
    } catch {
      // Ignore cache write errors
    }
  }
  return data;
}

export async function validatePriorRollback(options: {
  candidateDir?: string;
  baselineCacheDir?: string;
  evidenceOutput?: string;
} = {}): Promise<EvidenceRecord> {
  let candidateDir = resolve(options.candidateDir ?? join(root, "dist", "release"));
  try {
    candidateDir = await realpath(candidateDir);
  } catch {
    // Keep resolved candidateDir if not yet present
  }
  const cacheDir = options.baselineCacheDir ? resolve(options.baselineCacheDir) : undefined;
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const candidateVersion = String(pkg.version);

  const outcomes: ValidationOutcome[] = [];
  const recordOutcome = (step: number, name: string, ok: boolean, detail?: string) => {
    outcomes.push({ step, name, ok, detail });
    if (!ok) {
      throw new Error(`Rollback validation failed at step ${step} (${name}): ${detail ?? "unknown error"}`);
    }
  };

  // Determine platform-specific archives
  const isWindows = process.platform === "win32";
  const baselineArchiveName = isWindows ? "odinn-v1.0.0.zip" : "odinn-v1.0.0.tar.gz";
  const expectedBaselineDigest = BASELINE_DIGESTS[baselineArchiveName];
  if (!expectedBaselineDigest) {
    throw new Error(`No pinned baseline digest found for ${baselineArchiveName}`);
  }

  const candidateArchiveName = isWindows ? `odinn-v${candidateVersion}.zip` : `odinn-v${candidateVersion}.tar.gz`;
  const candidateArchivePath = join(candidateDir, candidateArchiveName);
  const candidateManifestPath = join(candidateDir, "release-manifest.json");
  const candidateChecksumsPath = join(candidateDir, "SHA256SUMS.txt");

  const candidateManifest = JSON.parse(await readFile(candidateManifestPath, "utf8"));
  const candidateCommit = String(candidateManifest.commit);
  const candidateArchiveBuffer = await readFile(candidateArchivePath);
  const candidateArchiveDigest = createHash("sha256").update(candidateArchiveBuffer).digest("hex");

  // Step 1: Download v1.0.0 release metadata and archive
  console.log(`[Step 1] Downloading baseline v1.0.0 release metadata and ${baselineArchiveName}...`);
  const baselineArchiveBuffer = await getOrDownloadAsset(
    baselineArchiveName,
    cacheDir,
    `${BASELINE_RELEASE_URL_BASE}/${baselineArchiveName}`
  );
  const baselineSumsText = await fetchText(`${BASELINE_RELEASE_URL_BASE}/SHA256SUMS.txt`);
  const baselineManifestText = await fetchText(`${BASELINE_RELEASE_URL_BASE}/release-manifest.json`);
  const baselineManifest = JSON.parse(baselineManifestText);
  recordOutcome(1, "Download baseline metadata and archive", true);

  // Step 2: Verify archive digest against pinned value and checksum metadata
  console.log("[Step 2] Verifying baseline archive digest against pinned constant and checksum manifest...");
  const actualBaselineDigest = createHash("sha256").update(baselineArchiveBuffer).digest("hex");
  if (actualBaselineDigest !== expectedBaselineDigest) {
    recordOutcome(2, "Verify baseline archive digest", false, `Digest ${actualBaselineDigest} did not match pinned ${expectedBaselineDigest}`);
  }
  const baselineSumsMatch = baselineSumsText.includes(actualBaselineDigest);
  if (!baselineSumsMatch) {
    recordOutcome(2, "Verify baseline archive in SHA256SUMS.txt", false, "SHA256SUMS.txt does not contain archive digest");
  }
  if (baselineManifest.version !== BASELINE_VERSION || baselineManifest.commit !== BASELINE_TAG_COMMIT) {
    recordOutcome(2, "Verify baseline manifest identity", false, `Manifest metadata mismatch: version=${baselineManifest.version}, commit=${baselineManifest.commit}`);
  }
  recordOutcome(2, "Verify baseline archive digest and manifest", true);

  const rawWorkDir = await mkdtemp(join(tmpdir(), "odinn-validate-rollback-"));
  const workDir = await realpath(rawWorkDir);
  const baselineExtractDir = join(workDir, "baseline-extract");
  const baselineArchiveLocal = join(workDir, baselineArchiveName);
  await writeFile(baselineArchiveLocal, baselineArchiveBuffer);

  const prefix = join(workDir, "installed");
  const workspace = join(workDir, "workspace");
  const stateDir = join(workDir, "state");
  await mkdir(workspace, { recursive: true });

  try {
    // Step 3: Safely extract archive into isolated temp dir
    console.log("[Step 3] Extracting baseline archive...");
    await mkdir(baselineExtractDir, { recursive: true });
    if (baselineArchiveName.endsWith(".zip")) {
      if (isWindows) {
        const escArchive = baselineArchiveLocal.replaceAll("'", "''");
        const escDest = baselineExtractDir.replaceAll("'", "''");
        run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${escArchive}' -DestinationPath '${escDest}' -Force`], root);
      } else {
        run("unzip", ["-q", baselineArchiveLocal, "-d", baselineExtractDir], root);
      }
    } else {
      run("tar", ["-xzf", baselineArchiveLocal, "-C", baselineExtractDir], root);
    }
    const baselinePackageRoot = join(baselineExtractDir, "odinn-v1.0.0");
    recordOutcome(3, "Extract baseline archive safely", true);

    // Step 4: Install v1.0.0 compiled distribution into isolated prefix
    console.log("[Step 4] Installing v1.0.0 distribution into isolated prefix...");
    if (isWindows) {
      run("powershell", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(baselinePackageRoot, "install", "install.ps1"),
        "-Prefix",
        prefix
      ], workspace, {
        ODINN_RELEASE_COMMIT: BASELINE_TAG_COMMIT,
        ODINN_ARTIFACT_SHA256: expectedBaselineDigest
      });
    } else {
      run(join(baselinePackageRoot, "install", "install.sh"), ["--prefix", prefix], workspace, {
        ODINN_RELEASE_COMMIT: BASELINE_TAG_COMMIT,
        ODINN_ARTIFACT_SHA256: expectedBaselineDigest
      });
    }
    const cli = join(prefix, "bin", isWindows ? "odinn.cmd" : "odinn");
    recordOutcome(4, "Install baseline binary", true);

    // Step 5: Execute v1.0.0 binary: version, onboard, state, session, text.echo, audit verify
    console.log("[Step 5] Executing v1.0.0 binary checks...");
    const v1Version = run(cli, ["--version"], workspace).trim();
    if (v1Version !== BASELINE_VERSION) {
      recordOutcome(5, "Baseline version output", false, `Expected ${BASELINE_VERSION}, got ${v1Version}`);
    }
    run(cli, ["onboard", "--state", stateDir], workspace, { INIT_CWD: workspace });
    const sess1Res = JSON.parse(run(cli, ["session", "create", "--title", "v1.0.0-original-session", "--state", stateDir], workspace, { INIT_CWD: workspace }));
    if (!sess1Res.id) {
      recordOutcome(5, "Baseline session create", false, "Failed to create session in v1.0.0");
    }

    const echoFile1 = join(workspace, "echo-baseline.json");
    await writeFile(echoFile1, `${JSON.stringify({ text: "ODINN_BASELINE_ECHO_OK" })}\n`);
    const echo1Res = run(cli, ["run", "--tool", "text.echo", "--input-file", echoFile1, "--state", stateDir], workspace, { INIT_CWD: workspace });
    if (!echo1Res.includes("ODINN_BASELINE_ECHO_OK")) {
      recordOutcome(5, "Baseline text.echo run", false, "text.echo did not output expected text");
    }

    const audit1Res = JSON.parse(run(cli, ["audit", "verify", "--state", stateDir], workspace, { INIT_CWD: workspace }));
    if (!audit1Res.valid) {
      recordOutcome(5, "Baseline audit verify", false, "Audit verification failed in v1.0.0");
    }
    recordOutcome(5, "Execute baseline binary sequence", true);

    // Step 6: Use v1.0.0 update path to install candidate archive using candidate manifest and checksums
    console.log(`[Step 6] Updating v1.0.0 installation to candidate v${candidateVersion}...`);
    const updateResult = runCommand(cli, [
      "update",
      "--manifest", candidateManifestPath,
      "--checksums", candidateChecksumsPath,
      "--artifact", candidateArchivePath,
      "--prefix", prefix,
      "--state", stateDir
    ], workspace, {
      INIT_CWD: workspace,
      ODINN_NONINTERACTIVE: "1",
      ODINN_RELEASE_COMMIT: candidateCommit,
      ODINN_ARTIFACT_SHA256: candidateArchiveDigest
    });

    if (updateResult.status !== 0) {
      recordOutcome(6, "Execute candidate update from v1.0.0 binary", false, updateResult.stderr || updateResult.stdout);
    }
    const updateData = JSON.parse(updateResult.stdout);
    if (!updateData.ok || updateData.version !== candidateVersion) {
      recordOutcome(6, "Candidate update output", false, `Update output mismatch: ${JSON.stringify(updateData)}`);
    }
    recordOutcome(6, "Execute candidate update from v1.0.0 binary", true);

    // Step 7: Verify candidate version, commit, installed pointer, and health
    console.log("[Step 7] Verifying candidate installation metadata and health...");
    const candVersion = run(cli, ["--version"], workspace).trim();
    if (candVersion !== candidateVersion) {
      recordOutcome(7, "Candidate active version", false, `Expected ${candidateVersion}, got ${candVersion}`);
    }
    const installState = JSON.parse(await readFile(join(prefix, "install-state.json"), "utf8"));
    if (installState.currentVersion !== candidateVersion || installState.currentCommit !== candidateCommit) {
      recordOutcome(7, "Candidate install state pointer", false, `Install state mismatch: ${JSON.stringify(installState)}`);
    }
    const candDoctor = JSON.parse(run(cli, ["doctor", "--state", stateDir], workspace, { INIT_CWD: workspace }));
    if (!candDoctor.ok || candDoctor.version !== candidateVersion) {
      recordOutcome(7, "Candidate doctor health", false, `Candidate doctor failed: ${JSON.stringify(candDoctor)}`);
    }
    recordOutcome(7, "Verify candidate version, commit, and health", true);

    // Step 8 & 9: Create candidate-only state and verify pre-migration state backup
    console.log("[Step 8 & 9] Creating candidate-only session and verifying state migration backup...");
    const recoveryBackup = updateData.stateBackup;
    if (!recoveryBackup || typeof recoveryBackup !== "string") {
      recordOutcome(8, "Verify pre-migration state backup created", false, "updateData.stateBackup is missing");
    }
    const candSessRes = JSON.parse(run(cli, ["session", "create", "--title", "v1.1.0-candidate-only-session", "--state", stateDir], workspace, { INIT_CWD: workspace }));
    if (!candSessRes.id) {
      recordOutcome(9, "Create candidate-only session", false, "Failed to create candidate session");
    }
    recordOutcome(8, "Verify pre-migration state backup path recorded", true);
    recordOutcome(9, "Create candidate-only state", true);

    // Step 10: Attempt rollback before restore and require fail-closed refusal
    console.log("[Step 10] Testing fail-closed rollback refusal before backup restoration...");
    const prematureRollback = runCommand(cli, ["rollback", "--prefix", prefix, "--state", stateDir], workspace, { INIT_CWD: workspace });
    if (prematureRollback.status === 0) {
      recordOutcome(10, "Fail-closed rollback refusal before restore", false, "Rollback unexpectedly succeeded before state backup was restored");
    }
    const rollbackErrMsg = prematureRollback.stderr || prematureRollback.stdout;
    if (!rollbackErrMsg.includes("rollback refused: state requires Odinn")) {
      recordOutcome(10, "Fail-closed rollback refusal error message", false, `Unexpected error message: ${rollbackErrMsg}`);
    }
    recordOutcome(10, "Attempt rollback before restore and fail closed", true);

    // Step 11: Restore matching pre-migration backup through supported restoration path
    console.log(`[Step 11] Restoring matching backup from ${recoveryBackup}...`);
    const restoreResult = runCommand(cli, [
      "state",
      "restore",
      "--input", recoveryBackup,
      "--confirm",
      "--state", stateDir
    ], workspace, { INIT_CWD: workspace });
    if (restoreResult.status !== 0) {
      recordOutcome(11, "Restore matching pre-migration state backup", false, restoreResult.stderr || restoreResult.stdout);
    }
    const restoreData = JSON.parse(restoreResult.stdout);
    if (!restoreData.ok || restoreData.sourceVersion !== BASELINE_VERSION) {
      recordOutcome(11, "Restore report validation", false, `Restore report unexpected: ${JSON.stringify(restoreData)}`);
    }
    recordOutcome(11, "Restore matching pre-migration backup", true);

    // Step 12: Perform rollback through candidate lifecycle command
    console.log("[Step 12] Performing application rollback after backup restoration...");
    const rollbackResult = runCommand(cli, [
      "rollback",
      "--prefix", prefix,
      "--state", stateDir
    ], workspace, { INIT_CWD: workspace });
    if (rollbackResult.status !== 0) {
      recordOutcome(12, "Perform rollback after restore", false, rollbackResult.stderr || rollbackResult.stdout);
    }
    recordOutcome(12, "Perform rollback after restore", true);

    // Step 13: Verify exact v1.0.0 is active again
    console.log("[Step 13] Verifying exact v1.0.0 is active again...");
    const rolledBackVersion = run(cli, ["--version"], workspace).trim();
    if (rolledBackVersion !== BASELINE_VERSION) {
      recordOutcome(13, "Verify active version after rollback", false, `Expected ${BASELINE_VERSION}, got ${rolledBackVersion}`);
    }
    const rolledBackInstallState = JSON.parse(await readFile(join(prefix, "install-state.json"), "utf8"));
    if (rolledBackInstallState.currentVersion !== BASELINE_VERSION || rolledBackInstallState.currentCommit !== BASELINE_TAG_COMMIT) {
      recordOutcome(13, "Verify install state pointer after rollback", false, `Expected ${BASELINE_VERSION}@${BASELINE_TAG_COMMIT}, got ${JSON.stringify(rolledBackInstallState)}`);
    }
    recordOutcome(13, "Verify exact baseline installation active", true);

    // Step 14: Verify sessions, doctor, text.echo, audit verify on rolled-back binary
    console.log("[Step 14] Verifying post-rollback state integrity...");
    const sessionList = JSON.parse(run(cli, ["session", "list", "--state", stateDir], workspace, { INIT_CWD: workspace }));
    const sessionTitles = (sessionList.sessions ?? []).map((s: any) => s.title);
    if (!sessionTitles.includes("v1.0.0-original-session")) {
      recordOutcome(14, "Original pre-upgrade session presence", false, "Original session missing from restored state");
    }
    if (sessionTitles.includes("v1.1.0-candidate-only-session")) {
      recordOutcome(14, "Candidate-only session absence", false, "Candidate session leaked into restored state");
    }

    const postDoctor = JSON.parse(run(cli, ["doctor", "--state", stateDir], workspace, { INIT_CWD: workspace }));
    if (!postDoctor.ok || postDoctor.version !== BASELINE_VERSION) {
      recordOutcome(14, "Baseline doctor pass after rollback", false, `Doctor check failed: ${JSON.stringify(postDoctor)}`);
    }

    const echoFile2 = join(workspace, "echo-post-rollback.json");
    await writeFile(echoFile2, `${JSON.stringify({ text: "ODINN_POST_ROLLBACK_ECHO_OK" })}\n`);
    const echo2Res = run(cli, ["run", "--tool", "text.echo", "--input-file", echoFile2, "--state", stateDir], workspace, { INIT_CWD: workspace });
    if (!echo2Res.includes("ODINN_POST_ROLLBACK_ECHO_OK")) {
      recordOutcome(14, "Baseline text.echo pass after rollback", false, "text.echo execution failed after rollback");
    }

    const postAudit = JSON.parse(run(cli, ["audit", "verify", "--state", stateDir], workspace, { INIT_CWD: workspace }));
    if (!postAudit.valid) {
      recordOutcome(14, "Audit log verification after rollback", false, `Audit verification failed: ${JSON.stringify(postAudit)}`);
    }
    recordOutcome(14, "Verify session state, doctor, tool execution, and audit log after rollback", true);

  } finally {
    await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  // Step 15: Emit machine-readable JSON evidence
  const evidence: EvidenceRecord = {
    os: process.platform,
    arch: process.arch,
    node: process.version,
    baseline: {
      version: BASELINE_VERSION,
      commit: BASELINE_TAG_COMMIT,
      archive: baselineArchiveName,
      checksum: actualBaselineDigest
    },
    candidate: {
      version: candidateVersion,
      commit: candidateCommit,
      archive: candidateArchiveName,
      checksum: candidateArchiveDigest
    },
    outcomes,
    result: "passed",
    timestamp: new Date().toISOString()
  };

  const evidenceOutputPath = resolve(options.evidenceOutput ?? join(candidateDir, "prior-rollback-evidence.json"));
  await mkdir(dirname(evidenceOutputPath), { recursive: true });
  await writeFile(evidenceOutputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[Step 15] Prior rollback validation PASSED. Evidence written to: ${evidenceOutputPath}`);

  return evidence;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const candidateDir = parseOption(process.argv.slice(2), "--candidate-release", process.argv[2]);
  const baselineCacheDir = parseOption(process.argv.slice(2), "--baseline-cache");
  const evidenceOutput = parseOption(process.argv.slice(2), "--evidence-output");

  validatePriorRollback({ candidateDir, baselineCacheDir, evidenceOutput })
    .then((evidence) => {
      console.log(JSON.stringify({ ok: true, result: evidence.result, outcomesCount: evidence.outcomes.length }));
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
