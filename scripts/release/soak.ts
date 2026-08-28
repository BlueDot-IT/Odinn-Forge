#!/usr/bin/env node
import { createServer as createProviderServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSecureArchive } from "../../packages/kernel/src/secure-archive.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const releaseDir = join(root, "dist", "release");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(releaseDir, "release-manifest.json"), "utf8"));
const archive = join(releaseDir, `odinn-v${pkg.version}.tar.gz`);
const providerCredentialEnv = "ODINN_SOAK_API_KEY";
const startedAt = Date.now();
const steps: any[] = [];
const soakReleaseA = { commit: "a".repeat(40), artifactSha256: "a".repeat(64) };
const soakReleaseB = { commit: "b".repeat(40), artifactSha256: "b".repeat(64) };

async function run(command: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  return await new Promise<string>((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        rejectRun(new Error(`${command} ${args.join(" ")} timed out after 180000 ms`));
      }
    }, 180_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      rejectRun(new Error(`${command} ${args.join(" ")} failed: ${error.message}`));
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (status !== 0) {
        rejectRun(new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout || `exit ${status ?? signal}`}`));
        return;
      }
      resolveRun(stdout);
    });
  });
}

async function listen(server: any) {
  await new Promise((resolveListen: any, reject: any) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
}

async function close(server: any) {
  await new Promise((resolveClose: any, reject: any) => server.close((error: any) => error ? reject(error) : resolveClose()));
}

async function delay(ms: number) { await new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

async function startGateway(packageRoot: string, workspace: string, state: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [join(packageRoot, "dist/gateway/server.js")], {
    cwd: workspace,
    env: { ...process.env, ...env, INIT_CWD: workspace, ODINN_STATE_DIR: state, ODINN_PORT: "0", ODINN_HOST: "127.0.0.1" },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errorOutput += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const match = output.match(/"port"\s*:\s*(\d+)/);
    if (match && Number(match[1]) > 0) {
      const base = `http://127.0.0.1:${match[1]}`;
      const bootstrap = await fetch(`${base}/`);
      const setCookie = typeof bootstrap.headers.getSetCookie === "function"
        ? bootstrap.headers.getSetCookie()[0]
        : bootstrap.headers.get("set-cookie");
      const cookie = setCookie?.split(";", 1)[0];
      if (!cookie) throw new Error("packaged gateway did not issue a bootstrap cookie");
      return { child, base, cookie, output, errorOutput };
    }
    if (child.exitCode !== null) throw new Error(`packaged gateway exited before binding: ${errorOutput || output || "no output"}`);
    await delay(100);
  }
  child.kill();
  throw new Error(`packaged gateway did not bind: ${errorOutput || output || "no output"}`);
}

async function stopGateway(gateway: any, signal: NodeJS.Signals = "SIGTERM") {
  if (gateway.child.exitCode !== null) return;
  const closed = new Promise((resolveClose) => gateway.child.once("close", resolveClose));
  if (process.platform !== "win32" && typeof gateway.child.pid === "number") {
    process.kill(-gateway.child.pid, signal);
  } else {
    gateway.child.kill(signal);
  }
  await closed;
}

async function gatewayRequest(gateway: any, path: string, init: any = {}) {
  const headers = { ...(init.headers ?? {}), cookie: gateway.cookie, origin: gateway.base };
  const response = await fetch(`${gateway.base}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

let providerMode = "normal";
let providerRequests = 0;
const provider = createProviderServer(async (request: any, response: any) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
  if (request.headers.authorization !== "Bearer odinn-soak-key") { response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "unauthorized" } })); return; }
  providerRequests += 1;
  if (providerMode === "timeout") { await delay(1_500); }
  if (providerMode === "fail-once" && providerRequests % 2 === 1) {
    response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "temporary provider failure" } }));
    return;
  }
  let raw = "";
  try {
    for await (const chunk of request) raw += chunk;
  } catch (error: any) {
    if (error?.code === "ECONNRESET" || request.destroyed || response.destroyed) return;
    throw error;
  }
  const payload = JSON.parse(raw);
  const content = payload.messages?.some((message: any) => String(message.content).includes("ODINN_CAPABILITY_OK")) ? "ODINN_CAPABILITY_OK" : "ODINN_SOAK_PROVIDER_OK";
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ id: `soak-response-${providerRequests}`, object: "chat.completion", model: payload.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } }));
});
await listen(provider);
const providerUrl = `http://127.0.0.1:${(provider.address() as any).port}/v1`;

async function record(name: string, operation: () => Promise<any> | any, summarize: (result: any) => Record<string, any> = (result) => result) {
  const started = Date.now();
  try {
    const result = await operation();
    const evidence = summarize(result);
    steps.push({ name, ok: true, durationMs: Date.now() - started, ...(evidence && typeof evidence === "object" ? evidence : {}) });
    return result;
  } catch (error: any) {
    steps.push({ name, ok: false, durationMs: Date.now() - started, category: "step-failed" });
    throw error;
  }
}

const temp = await mkdtemp(join(tmpdir(), "odinn-release-soak-"));
const workspace = join(temp, "workspace");
const state = join(temp, "state");
const installPrefix = join(temp, "installed");
await extractSecureArchive(archive, temp, { expectedRoot: `odinn-v${pkg.version}` });
const packageRoot = join(temp, `odinn-v${pkg.version}`);
const cliEntry = join(packageRoot, "dist/cli/index.js");
const installerEntry = join(packageRoot, "dist/install/install.js");
const planPath = join(workspace, "local-smoke.plan.json");
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "soak-output.txt"), "ODINN_SOAK_FILE\n");
await writeFile(planPath, `${JSON.stringify({
  id: "plan_local_smoke",
  name: "local-smoke",
  steps: [
    { id: "health", tool: "job.healthcheck" },
    { id: "echo", tool: "text.echo", input: { text: "ODINN_PLAN_OK" } }
  ]
}, null, 2)}\n`);
await run(process.execPath, [cliEntry, "init", "--state", state], workspace, { INIT_CWD: workspace });

try {
  await record("fresh-onboarding-local-provider", () => run(process.execPath, [cliEntry, "onboard", "--provider", "ci", "--auth", "api-key", "--base-url", providerUrl, "--model", "odinn-soak-model", "--api-key-env", providerCredentialEnv, "--state", state], workspace, { INIT_CWD: workspace, [providerCredentialEnv]: "odinn-soak-key" }));
  await record("onboarding-provider-verification", () => run(process.execPath, [cliEntry, "onboard", "--verify", "--state", state], workspace, { INIT_CWD: workspace, [providerCredentialEnv]: "odinn-soak-key" }));
  await record("deterministic-tool", () => run(process.execPath, [cliEntry, "run", "--tool", "text.echo", "--input-json", JSON.stringify({ text: "ODINN_SOAK_TOOL" }), "--state", state], workspace, { INIT_CWD: workspace }));
  await record("multi-step-plan", () => run(process.execPath, [cliEntry, "plan", "--file", planPath, "--state", state], workspace, { INIT_CWD: workspace }));

  providerMode = "fail-once";
  providerRequests = 0;
  await record("provider-failure-retry-recovery", async () => {
    const output = await run(process.execPath, [cliEntry, "run", "--tool", "model.chat", "--input-json", JSON.stringify({ retries: 1, messages: [{ role: "user", content: "retry" }] }), "--state", state], workspace, { INIT_CWD: workspace, [providerCredentialEnv]: "odinn-soak-key" });
    if (!output.includes("ODINN_SOAK_PROVIDER_OK") || providerRequests < 2) throw new Error("provider retry did not recover after a transient failure");
    return { providerAttempts: providerRequests };
  });
  providerMode = "timeout";
  await record("provider-timeout", async () => {
    try {
      await run(process.execPath, [cliEntry, "run", "--tool", "model.chat", "--input-json", JSON.stringify({ timeoutMs: 1_000, retries: 0, messages: [{ role: "user", content: "timeout" }] }), "--state", state], workspace, { INIT_CWD: workspace, [providerCredentialEnv]: "odinn-soak-key" });
      throw new Error("provider timeout did not fail safely");
    } catch (error: any) {
      if (!/timed out|timeout/i.test(error.message)) throw error;
    }
    return { recovered: true };
  });
  providerMode = "normal";
  await record("provider-post-timeout-recovery", () => run(process.execPath, [cliEntry, "run", "--tool", "model.chat", "--input-json", JSON.stringify({ messages: [{ role: "user", content: "recover" }] }), "--state", state], workspace, { INIT_CWD: workspace, [providerCredentialEnv]: "odinn-soak-key" }));

  let gateway = await record("gateway-start", () => startGateway(packageRoot, workspace, state, { [providerCredentialEnv]: "odinn-soak-key" }), () => ({ bound: true }));
  await record("gateway-status", async () => { const result = await gatewayRequest(gateway, "/status"); if (!result.response.ok) throw new Error("gateway status failed"); return { status: "healthy" }; });
  const gatewayRun = await record("gateway-provider-run", async () => {
    const result = await gatewayRequest(gateway, "/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "soak-gateway-run", tool: "model.chat", input: { messages: [{ role: "user", content: "gateway" }] } }) });
    if (!result.response.ok || result.body.output?.content !== "ODINN_SOAK_PROVIDER_OK") throw new Error("gateway provider run failed");
    return { runId: result.body.id };
  });
  await stopGateway(gateway);
  gateway = await record("gateway-restart", () => startGateway(packageRoot, workspace, state, { [providerCredentialEnv]: "odinn-soak-key" }), () => ({ bound: true }));
  await record("persisted-output-after-restart", async () => {
    const result = await gatewayRequest(gateway, `/runs/${encodeURIComponent(gatewayRun.runId)}`);
    if (!result.response.ok || !result.body.events?.some((event: any) => event.type === "task.completed")) throw new Error("gateway restart lost persisted output");
    return { persisted: true };
  });

  providerMode = "timeout";
  const providerRequestsBeforeInterruption = providerRequests;
  const queuedJob = await record("queue-work", async () => {
    const result = await gatewayRequest(gateway, "/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "soak-interrupted-job", timeoutMs: 30_000, task: { tool: "model.chat", input: { timeoutMs: 30_000, retries: 0, messages: [{ role: "user", content: "interrupt this queued operation" }] } } }) });
    if (result.response.status !== 202 || !result.body.job?.id) throw new Error("gateway did not queue the soak job");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = await gatewayRequest(gateway, "/jobs/soak-interrupted-job");
      if (status.body.status === "running") return { jobId: status.body.id };
      await delay(100);
    }
    throw new Error("queued soak job never reached running state");
  });
  const interruptionSignal: NodeJS.Signals = process.env.ODINN_SOAK_POWER_LOSS === "1"
    ? "SIGKILL"
    : "SIGTERM";
  await record(
    interruptionSignal === "SIGKILL" ? "queue-power-loss" : "queue-stop",
    () => stopGateway(gateway, interruptionSignal),
    () => ({ signal: interruptionSignal })
  );
  providerMode = "normal";
  gateway = await record("queue-interruption-restart-recovery", () => startGateway(packageRoot, workspace, state, { [providerCredentialEnv]: "odinn-soak-key" }), () => ({ bound: true }));
  await record("recovered-job-state", async () => {
    let lastStatus = "unknown";
    // A hard process loss cannot release the durable execution lease. Wait
    // through the supervisor's minimum 120-second lease window so restart
    // recovery, rather than an artificial test hook, owns the transition.
    const maximumAttempts = interruptionSignal === "SIGKILL" ? 1_500 : 50;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const result = await gatewayRequest(gateway, `/jobs/${encodeURIComponent(queuedJob.jobId)}`);
      lastStatus = typeof result.body.status === "string" ? result.body.status : "missing";
      const providerAttempts = providerRequests - providerRequestsBeforeInterruption;
      if (result.body.status === "needs-review") {
        if (providerAttempts > 1) throw new Error("uncertain power-loss recovery replayed the provider request");
        return { recoveredJobs: 1, recoveryStatus: result.body.status, providerAttempts, retrySafeReplay: false };
      }
      if (result.body.status === "completed") {
        if (interruptionSignal !== "SIGKILL" || providerAttempts < 1 || providerAttempts > 2) {
          throw new Error("completed power-loss recovery exceeded the bounded retry-safe provider-attempt budget");
        }
        return { recoveredJobs: 1, recoveryStatus: result.body.status, providerAttempts, retrySafeReplay: providerAttempts === 2 };
      }
      await delay(100);
    }
    throw new Error(`interrupted job did not enter needs-review after restart (last status: ${lastStatus})`);
  });

  await writeFile(join(state, "browser-recovery.json"), `${JSON.stringify({ schemaVersion: 1, id: "soak-browser-transaction", status: "unknown" })}\n`, { mode: 0o600 });
  await record("browser-interruption-recovery-block", async () => {
    const status = await gatewayRequest(gateway, "/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "browser.recovery.status", input: {} }) });
    if (status.body.output?.recovery?.status !== "unknown") throw new Error("browser recovery journal was not observed");
    const requested = await gatewayRequest(gateway, "/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "browser.press", input: { key: "Escape", confirmed: true } }) });
    const approvalId = requested.body.output?.approvalId;
    if (requested.response.status !== 200 || requested.body.output?.type !== "approval.required" || typeof approvalId !== "string") {
      throw new Error("browser mutation did not enter explicit approval while recovery was unresolved");
    }
    const blocked = await gatewayRequest(gateway, `/approvals/${encodeURIComponent(approvalId)}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (blocked.response.status !== 400 || blocked.body.category !== "browser-recovery") throw new Error("browser mutation was not blocked by unresolved recovery");
    const resolved = await gatewayRequest(gateway, "/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "browser.recovery.resolve", input: { outcome: "not-applied" } }) });
    if (!resolved.response.ok || resolved.body.output?.recovery?.status !== "resolved") throw new Error("browser recovery could not be resolved");
    return { unresolvedApprovals: 0, browserRecoveryBlocked: true };
  });
  await stopGateway(gateway);

  const configPath = join(state, "config.json");
  const rewindRun = JSON.parse(await run(process.execPath, [cliEntry, "run", "--tool", "text.echo", "--input-json", JSON.stringify({ text: "ODINN_SOAK_REWIND" }), "--state", state], workspace, { INIT_CWD: workspace }));
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.experimental = { ...(config.experimental ?? {}), capabilities: true };
  config.policy = {
    ...(config.policy ?? {}),
    allowedCapabilities: [...new Set([...(config.policy?.allowedCapabilities ?? []), "restore.create", "restore.apply"])]
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const checkpointTaskId = `soak-checkpoint-${rewindRun.id}`;
  const checkpointToken = JSON.parse(await run(process.execPath, [cliEntry, "capability", "issue", "--run", checkpointTaskId, "--step", "checkpoint-create", "--tool", "snapshot.create", "--show-token", "--state", state], workspace, { INIT_CWD: workspace }));
  const checkpoint = JSON.parse(await run(process.execPath, [cliEntry, "checkpoint", "create", rewindRun.id, "--path", "soak-output.txt", "--task-run", checkpointTaskId, "--capability-token", checkpointToken.token, "--state", state], workspace, { INIT_CWD: workspace }));
  const rewindPreviewRunId = `soak-rewind-preview-${rewindRun.id}`;
  const rewindPreviewToken = JSON.parse(await run(process.execPath, [cliEntry, "capability", "issue", "--run", rewindPreviewRunId, "--step", "rewind-preview", "--tool", "snapshot.restore", "--constraints", JSON.stringify({ snapshotId: checkpoint.snapshotId }), "--show-token", "--state", state], workspace, { INIT_CWD: workspace }));
  await record("rewind-dry-run", async () => { const preview = JSON.parse(await run(process.execPath, [cliEntry, "rewind", checkpoint.snapshotId, "--run", rewindPreviewRunId, "--capability-token", rewindPreviewToken.token, "--state", state], workspace, { INIT_CWD: workspace })); if (preview.applied !== false) throw new Error("rewind dry-run applied a restore"); return { applied: false }; });
  await record("audit-integrity-and-persisted-output", async () => { const verification = JSON.parse(await run(process.execPath, [cliEntry, "audit", "verify", "--state", state], workspace, { INIT_CWD: workspace })); if (!verification.valid) throw new Error("audit verification failed"); await run(process.execPath, [cliEntry, "run", "show", rewindRun.id, "--state", state], workspace, { INIT_CWD: workspace }); return { auditVerification: true }; });

  await record("installer-upgrade-rollback", async () => {
    await run(process.execPath, [installerEntry, "install", "--source", packageRoot, "--prefix", installPrefix, "--version", pkg.version, "--commit", soakReleaseA.commit, "--artifact-sha256", soakReleaseA.artifactSha256], workspace);
    const first = JSON.parse(await run(process.execPath, [installerEntry, "status", "--prefix", installPrefix], workspace));
    await run(process.execPath, [installerEntry, "upgrade", "--source", packageRoot, "--prefix", installPrefix, "--version", `${pkg.version}-soak-b`, "--commit", soakReleaseB.commit, "--artifact-sha256", soakReleaseB.artifactSha256], workspace);
    const upgraded = JSON.parse(await run(process.execPath, [installerEntry, "status", "--prefix", installPrefix], workspace));
    if (upgraded.previous !== first.current) throw new Error("installer did not preserve the previous release pointer");
    await run(process.execPath, [installerEntry, "rollback", "--prefix", installPrefix], workspace);
    const rolledBack = JSON.parse(await run(process.execPath, [installerEntry, "status", "--prefix", installPrefix], workspace));
    if (rolledBack.current !== first.current) throw new Error("installer rollback did not restore the previous release");
    const rollbackRoot = join(installPrefix, "versions", rolledBack.current);
    const rollbackWorkspace = join(temp, "post-rollback-workspace");
    const rollbackState = join(temp, "post-rollback-state");
    await mkdir(rollbackWorkspace, { recursive: true });
    await run(process.execPath, [join(rollbackRoot, "dist/cli/index.js"), "onboard", "--state", rollbackState], rollbackWorkspace, { INIT_CWD: rollbackWorkspace });
    const smoke = await run(process.execPath, [join(rollbackRoot, "dist/cli/index.js"), "run", "--tool", "text.echo", "--input-json", JSON.stringify({ text: "ODINN_POST_ROLLBACK_OK" }), "--state", rollbackState], rollbackWorkspace, { INIT_CWD: rollbackWorkspace });
    if (!smoke.includes("ODINN_POST_ROLLBACK_OK")) throw new Error("post-rollback deterministic smoke failed");
    return { rollbackVerified: true, postRollbackOnboarding: true, postRollbackSmoke: true };
  });
  const report = { schemaVersion: 1, package: pkg.name, version: pkg.version, commit: manifest.commit, archive: basename(archive), durationMs: Date.now() - startedAt, restartCount: steps.filter((step) => step.name.includes("restart")).length, powerLossCount: steps.filter((step) => step.name === "queue-power-loss").length, recoveredJobs: steps.find((step) => step.name === "recovered-job-state")?.recoveredJobs ?? 0, powerLossRecoveryStatus: steps.find((step) => step.name === "recovered-job-state")?.recoveryStatus ?? "missing", powerLossProviderAttempts: steps.find((step) => step.name === "recovered-job-state")?.providerAttempts ?? 0, unresolvedApprovals: steps.find((step) => step.name === "browser-interruption-recovery-block")?.unresolvedApprovals ?? 0, auditVerification: steps.find((step) => step.name === "audit-integrity-and-persisted-output")?.auditVerification ?? false, browserRecoveryBlocked: steps.find((step) => step.name === "browser-interruption-recovery-block")?.browserRecoveryBlocked ?? false, rollbackVerified: steps.find((step) => step.name === "installer-upgrade-rollback")?.rollbackVerified ?? false, finalState: "passed", steps };
  await writeFile(join(releaseDir, "soak-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = { schemaVersion: 1, package: pkg.name, version: pkg.version, commit: manifest.commit, archive: basename(archive), durationMs: Date.now() - startedAt, restartCount: steps.filter((step) => step.name.includes("restart")).length, powerLossCount: steps.filter((step) => step.name === "queue-power-loss").length, recoveredJobs: steps.find((step) => step.name === "recovered-job-state")?.recoveredJobs ?? 0, unresolvedApprovals: 0, auditVerification: false, browserRecoveryBlocked: false, rollbackVerified: false, finalState: "failed", steps };
  await writeFile(join(releaseDir, "soak-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  throw error;
} finally {
  await close(provider);
  await rm(temp, { recursive: true, force: true });
}
