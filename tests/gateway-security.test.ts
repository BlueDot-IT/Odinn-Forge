import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { assertGatewayBinding } from "../apps/gateway/src/security.ts";
import { createGatewayServer } from "../apps/gateway/src/server.ts";
import { gatewayTestHooksFor, withGatewayTestHooks } from "../apps/gateway/src/testing.ts";
import { createApprovalStore, createAuditStore, createBuiltInRegistry, createRunLedger, isOwnerOnlyPath, runTask } from "../packages/kernel/src/index.ts";
import { createApprovalStoreWithTestHooks } from "../packages/kernel/src/approvals.ts";
import { createDefaultPolicy } from "../packages/policy/src/index.ts";
import { createRuntimeIsolatedTaskExecutor } from "../packages/runtime/src/index.ts";

test("approval fault-injection hooks are absent from public package roots", async () => {
  const kernel = await import("../packages/kernel/src/index.ts") as Record<string, unknown>;
  assert.equal("createApprovalStoreWithTestHooks" in kernel, false);
  assert.equal("isApprovalStoreContentionError" in kernel, false);
  const gateway = await import("../apps/gateway/src/server.ts") as Record<string, unknown>;
  assert.equal("withGatewayTestHooks" in gateway, false);
  assert.equal("gatewayTestHooksFor" in gateway, false);
  const gatewayPackage = JSON.parse(await readFile(new URL("../apps/gateway/package.json", import.meta.url), "utf8"));
  assert.deepEqual(gatewayPackage.exports, { ".": "./src/server.ts" });
  assert.equal(gatewayTestHooksFor({ __testOnlyAfterApprovalJobClaimed() {} }), undefined);
});

type ApprovalContentionChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  value?: { code?: string; message?: string; outcome?: string };
};

const RAW_APPROVAL_CONTENTION = /APPROVAL_STORE_(?:BUSY|CONTENDED)|approval store is busy|approval state (?:is temporarily unavailable|could not be accessed before the bounded deadline)/iu;

function spawnApprovalContentionWorker(input: Record<string, unknown>) {
  const worker = join(process.cwd(), "tests/fixtures/approval-contention-worker.ts");
  const child = spawn(process.execPath, [worker, JSON.stringify(input)], { stdio: ["ignore", "pipe", "pipe"] });
  const result = new Promise<ApprovalContentionChildResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      let value;
      try { value = stdout.trim() ? JSON.parse(stdout.trim()) : undefined; }
      catch { value = undefined; }
      resolve({ code, signal, stdout, stderr, value });
    });
  });
  return { child, result };
}

async function waitForApprovalBarrier(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for approval test barrier: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function activeApprovalLockArtifacts(approvalPath: string, files: string[]): string[] {
  return files.filter((name) => name === `${basename(approvalPath)}.lock` || name.startsWith(".odinn-approval-lock-recovery."));
}

function waitForChild(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; stdout: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr!.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
}

test("gateway control surfaces require bootstrap authentication and reject cross-origin mutations", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-security-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/status`)).status, 401);
    assert.equal((await fetch(`${base}/config`)).status, 401);
    const bootstrap = await fetch(`${base}/`);
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    assert.equal((await fetch(`${base}/status`, { headers: { cookie } })).status, 200);
    const configResponse = await fetch(`${base}/config`, { headers: { cookie } });
    assert.equal(configResponse.status, 200);
    const currentConfig = await configResponse.json();

    for (const invalidConfig of [
      { ...currentConfig.config, providers: { malicious: { type: "openai-compatible", apiKeyEnv: "ODINN_CHROMIUM_PATH", models: ["malicious"] } } },
      { ...currentConfig.config, channels: { malicious: { type: "discord", tokenEnv: "ODINN_GATEWAY_AUTH" } } },
      { ...currentConfig.config, plugins: { entries: { discord: { enabled: true, config: { accounts: { malicious: { tokenEnv: "ODINN_USER_PASSWORD" } } } } } } }
    ]) {
      const response = await fetch(`${base}/config`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ config: invalidConfig, fingerprint: currentConfig.fingerprint })
      });
      const body: any = await response.json();
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.match(body.error, /credential-oriented.*reserved runtime control/iu);
    }

    const missingConfigOrigin = await fetch(`${base}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ config: currentConfig.config, fingerprint: currentConfig.fingerprint })
    });
    assert.equal(missingConfigOrigin.status, 403);

    const crossOriginConfig = await fetch(`${base}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie, origin: "https://evil.example" },
      body: JSON.stringify({ config: currentConfig.config, fingerprint: currentConfig.fingerprint })
    });
    assert.equal(crossOriginConfig.status, 403);

    const missingCookieOrigin = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ id: "run_missing_cookie_origin", tool: "text.echo", input: { text: "blocked" } })
    });
    assert.equal(missingCookieOrigin.status, 403);

    const crossPort = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: `http://127.0.0.1:${server.address().port + 1}` },
      body: JSON.stringify({ id: "run_cross_port", tool: "text.echo", input: { text: "blocked" } })
    });
    assert.equal(crossPort.status, 403);

    const sameOrigin = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ id: "run_same_origin", tool: "text.echo", input: { text: "allowed" } })
    });
    assert.equal(sameOrigin.status, 200);

    const token = decodeURIComponent(cookie.split("=").slice(1).join("="));
    const bearer = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: "run_bearer_no_origin", tool: "text.echo", input: { text: "allowed" } })
    });
    assert.equal(bearer.status, 200);

    const rejected = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://evil.example" },
      body: JSON.stringify({ id: "run_cross_origin", tool: "text.echo", input: { text: "blocked" } })
    });
    assert.equal(rejected.status, 403);

    const hostileBootstrap = await requestRaw({ port: server.address().port, path: "/", headers: { host: "attacker.example" } });
    assert.equal(hostileBootstrap.status, 421);
    const hostileOrigin = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "http://attacker.example", host: `127.0.0.1:${server.address().port}` },
      body: JSON.stringify({ id: "run_hostile_origin", tool: "text.echo", input: { text: "blocked" } })
    });
    assert.equal(hostileOrigin.status, 403);
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("remote gateway binding never bootstraps the control token through a spoofed loopback Host", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-remote-bootstrap-"));
  const previousRemote = process.env.ODINN_ALLOW_REMOTE;
  process.env.ODINN_ALLOW_REMOTE = "1";
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise((resolve: any) => server.listen(0, "0.0.0.0", resolve));
  try {
    const token = (await readFile(join(stateDir, "gateway.token"), "utf8")).trim();
    const bootstrap: any = await requestRaw({
      port: server.address().port,
      path: "/",
      headers: { host: `localhost:${server.address().port}` }
    });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.headers["set-cookie"], undefined);
    assert.equal(bootstrap.headers["x-odinn-auth"], "authentication-required");
    assert.equal(bootstrap.body.includes(token), false);

    const status: any = await requestRaw({
      port: server.address().port,
      path: "/status",
      headers: { host: `localhost:${server.address().port}` }
    });
    assert.equal(status.status, 401);
  } finally {
    if (previousRemote === undefined) delete process.env.ODINN_ALLOW_REMOTE;
    else process.env.ODINN_ALLOW_REMOTE = previousRemote;
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("remote gateway binding cannot disable authentication", () => {
  assert.doesNotThrow(() => assertGatewayBinding("127.0.0.1", { allowRemote: false, authenticationDisabled: true }));
  assert.doesNotThrow(() => assertGatewayBinding("::1", { allowRemote: false, authenticationDisabled: true }));
  assert.doesNotThrow(() => assertGatewayBinding("0.0.0.0", { allowRemote: true, authenticationDisabled: false }));
  assert.throws(
    () => assertGatewayBinding("0.0.0.0", { allowRemote: false, authenticationDisabled: false }),
    /refusing non-loopback gateway host/u
  );
  assert.throws(
    () => assertGatewayBinding("0.0.0.0", { allowRemote: true, authenticationDisabled: true }),
    /refusing to disable gateway authentication/u
  );
});

test("approval records survive restart and consume exactly once for the bound action", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-restart-"));
  const path = join(stateDir, "approvals.json");
  const first = createApprovalStore({ path });
  const action = { tool: "browser.click", runId: "run-browser-click", accountId: "home", input: { selector: "#send", confirmed: true }, summary: "Click" };
  const id = first.create(action);
  const restarted = createApprovalStore({ path });
  const claimed = restarted.claim(id);
  assert.equal(claimed.status, "approved");
  assert.equal(claimed.runId, "run-browser-click");
  assert.equal(createApprovalStore({ path }).list()[0].status, "claimed");
  const secondClaim = createApprovalStore({ path }).claim(id);
  assert.equal(secondClaim.status, "approved");
  assert.equal(secondClaim.runId, claimed.runId);
  for (const mismatch of [
    { tool: "browser.press", runId: action.runId, accountId: action.accountId, input: { selector: "#send" } },
    { tool: action.tool, runId: "different-run", accountId: action.accountId, input: { selector: "#send" } },
    { tool: action.tool, runId: action.runId, accountId: "different-account", input: { selector: "#send" } },
    { tool: action.tool, runId: action.runId, accountId: action.accountId, input: { selector: "#other" } }
  ]) {
    assert.equal(createApprovalStore({ path }).consume(id, mismatch), undefined);
  }
  const consumed = createApprovalStore({ path }).consume(id, {
    tool: action.tool,
    runId: action.runId,
    accountId: action.accountId,
    input: { selector: "#send" }
  });
  assert.equal(consumed?.id, id);
  assert.equal(createApprovalStore({ path }).consume(id, action), undefined);
  assert.deepEqual(createApprovalStore({ path }).list(), []);
});

test("separate processes wait on the real approval lock and dispatch exactly once", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-process-race-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const path = join(stateDir, "approvals.json");
  const ownerReadyPath = join(stateDir, "owner-ready");
  const contentionReadyPath = join(stateDir, "contender-collided");
  const releasePath = join(stateDir, "release-owner");
  const dispatchPath = join(stateDir, "dispatches.log");
  const action = { tool: "process.exec", runId: "cross-process-continuation", actor: "operator", input: { command: "/bin/true", args: [], cwd: "." } };
  const id = createApprovalStore({ path }).create(action);
  assert.ok(createApprovalStore({ path }).claim(id));
  const owner = spawnApprovalContentionWorker({ action, barrierTimeoutMs: 60_000, dispatchPath, id, operation: "consume", ownerReadyPath, path, releasePath });
  t.after(() => { if (owner.child.exitCode === null) owner.child.kill(); });
  await waitForApprovalBarrier(ownerReadyPath);
  const contender = spawnApprovalContentionWorker({ action, contentionReadyPath, dispatchPath, id, operation: "consume", path });
  t.after(() => { if (contender.child.exitCode === null) contender.child.kill(); });
  await waitForApprovalBarrier(contentionReadyPath);
  await writeFile(releasePath, "release\n", { mode: 0o600 });
  const results = await Promise.all([owner.result, contender.result]);
  assert.ok(results.every(({ code }) => code === 0), results.map(({ stderr }) => stderr).join("\n"));
  assert.deepEqual(results.map(({ value }) => value?.outcome).sort(), ["approved", "denied"]);
  assert.doesNotMatch(JSON.stringify(results), RAW_APPROVAL_CONTENTION);
  assert.equal((await readFile(dispatchPath, "utf8")).trim().split("\n").length, 1);
  assert.deepEqual(createApprovalStore({ path }).list(), []);
  assert.deepEqual(activeApprovalLockArtifacts(path, await readdir(stateDir)), []);
});

test("live approval lock timeout denies safely, observes interruption, and permits one retry after release", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-approval-live-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, ".odinn");
  const path = join(stateDir, "approvals.json");
  const ownerReadyPath = join(stateDir, "owner-ready");
  const releasePath = join(stateDir, "release-owner");
  const action = { tool: "process.exec", runId: "live-timeout-continuation", actor: "operator", input: { command: "/bin/true", args: [], cwd: "." } };
  const id = createApprovalStore({ path }).create(action);
  assert.ok(createApprovalStore({ path }).claim(id));
  const owner = spawnApprovalContentionWorker({ action, barrierTimeoutMs: 60_000, id, operation: "list", ownerReadyPath, path, releasePath });
  t.after(() => { if (owner.child.exitCode === null) owner.child.kill(); });
  await waitForApprovalBarrier(ownerReadyPath);

  const interrupted = new AbortController();
  const interruption = new Error("approval wait cancelled by caller");
  let observeContention!: () => void;
  const contentionObserved = new Promise<void>((resolve) => { observeContention = resolve; });
  const interruptible = createApprovalStoreWithTestHooks({
    path,
    lockTimeoutMs: 1_000,
    __testOnlyOnLockContention: observeContention
  });
  const interruptedRecovery = interruptible.recoverAsync!(id, { signal: interrupted.signal });
  await contentionObserved;
  interrupted.abort(interruption);
  await assert.rejects(interruptedRecovery, (error) => error === interruption);

  let contentionObservations = 0;
  const contendedStore = createApprovalStoreWithTestHooks({
    path,
    lockTimeoutMs: 75,
    __testOnlyOnLockContention: () => { contentionObservations += 1; }
  });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  let dispatches = 0;
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir,
    approvalStore: contendedStore,
    auditStore,
    processExecutor: async () => { dispatches += 1; return { exitCode: 0 }; }
  });
  t.after(() => { registry.close(); auditStore.close(); });
  const execution = {
    task: { id: action.runId, tool: action.tool, input: action.input, actor: action.actor },
    auditStore,
    approvalStore: contendedStore,
    policy: createDefaultPolicy({ allowedCapabilities: ["process.exec"] }),
    registry,
    durableExecution: true,
    trustedApprovalId: id,
    trustedApprovalRunId: action.runId
  };
  await assert.rejects(
    runTask(execution),
    (error: any) => error?.code === "APPROVAL_CONTINUATION_DENIED"
      && !RAW_APPROVAL_CONTENTION.test(`${error?.code} ${error?.message}`)
  );
  assert.ok(contentionObservations > 0);
  assert.equal(dispatches, 0);

  await writeFile(releasePath, "release\n", { mode: 0o600 });
  const ownerResult = await owner.result;
  assert.equal(ownerResult.value?.outcome, "listed", ownerResult.stderr);
  const restartedStore = createApprovalStore({ path });
  const restartedRegistry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir,
    approvalStore: restartedStore,
    auditStore,
    processExecutor: async () => { dispatches += 1; return { exitCode: 0 }; }
  });
  t.after(() => restartedRegistry.close());
  const retryExecution = { ...execution, approvalStore: restartedStore, registry: restartedRegistry };
  const retry = await runTask(retryExecution);
  assert.equal(retry.ok, true);
  await assert.rejects(runTask(retryExecution), (error: any) => error?.code === "APPROVAL_CONTINUATION_DENIED");
  assert.equal(dispatches, 1);
  assert.deepEqual(createApprovalStore({ path }).list(), []);
  assert.deepEqual(activeApprovalLockArtifacts(path, await readdir(stateDir)), []);
});

test("Gateway, CLI, worker, and durable-job continuations hide live approval lock contention", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-surface-timeout-"));
  const approvalPath = join(stateDir, "approvals.json");
  const ownerReadyPath = join(stateDir, "owner-ready");
  const releasePath = join(stateDir, "release-owner");
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const token = (await readFile(join(stateDir, "gateway.token"), "utf8")).trim();
  const authorization = { authorization: `Bearer ${token}` };
  const workerAction = {
    tool: "process.exec",
    runId: "surface-timeout-worker",
    actor: "operator",
    input: { command: "/bin/true", args: [], cwd: "." }
  };
  const workerApprovalId = createApprovalStore({ path: approvalPath }).create(workerAction);
  assert.ok(createApprovalStore({ path: approvalPath }).claim(workerApprovalId));
  const workerExecutor = createRuntimeIsolatedTaskExecutor({
    stateDir,
    workspaceRoot: stateDir,
    policy: createDefaultPolicy({ allowedCapabilities: ["process.exec"] })
  });
  let owner: ReturnType<typeof spawnApprovalContentionWorker> | undefined;
  let cli: ReturnType<typeof spawn> | undefined;
  t.after(async () => {
    await writeFile(releasePath, "release\n", { mode: 0o600 }).catch(() => undefined);
    if (cli?.exitCode === null) cli.kill();
    if (owner?.child.exitCode === null) owner.child.kill();
    await workerExecutor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  });

  const submitApprovalJob = async (id: string) => {
    const submitted = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json", "idempotency-key": id },
      body: JSON.stringify({ task: { tool: "browser.click", input: { tabId: "tab_fixture", selector: "#apply" } } })
    });
    assert.equal(submitted.status, 202, await submitted.text());
    const deadline = Date.now() + 10_000;
    let job: any;
    while (Date.now() < deadline) {
      const response = await fetch(`${base}/jobs/${id}`, { headers: authorization });
      job = await response.json();
      if (job.status === "awaiting-approval" || job.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(job?.status, "awaiting-approval", JSON.stringify(job));
    return job;
  };

  const [httpJob, cliJob] = await Promise.all([
    submitApprovalJob("surface-timeout-http-job"),
    submitApprovalJob("surface-timeout-cli-job")
  ]);
  const approvalsResponse = await fetch(`${base}/approvals`, { headers: authorization });
  assert.equal(approvalsResponse.status, 200);
  const approvals = await approvalsResponse.json() as any[];
  const httpApproval = approvals.find((approval) => approval.runId === httpJob.id);
  const cliApproval = approvals.find((approval) => approval.runId === cliJob.id);
  assert.ok(httpApproval?.id);
  assert.ok(cliApproval?.id);

  owner = spawnApprovalContentionWorker({
    action: workerAction,
    barrierTimeoutMs: 60_000,
    id: workerApprovalId,
    operation: "list",
    ownerReadyPath,
    path: approvalPath,
    releasePath
  });
  await waitForApprovalBarrier(ownerReadyPath);

  const httpContinuation = fetch(`${base}/approvals/${httpApproval.id}/approve`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: "{}"
  }).then(async (response) => ({ body: await response.text(), status: response.status }));
  cli = spawn(process.execPath, [
    join(process.cwd(), "apps/cli/src/cli.ts"),
    "operator", "action", "approve",
    "--target", cliApproval.id,
    "--confirm",
    "--gateway-url", base,
    "--state", stateDir
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  const cliContinuation = waitForChild(cli);
  const workerContinuation = workerExecutor({
    approvalId: workerApprovalId,
    approvalRunId: workerAction.runId,
    durableExecution: true,
    task: { id: workerAction.runId, tool: workerAction.tool, input: workerAction.input, actor: workerAction.actor }
  }).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error) => ({ error, status: "rejected" as const })
  );

  const [httpResult, cliResult, workerResult] = await Promise.all([httpContinuation, cliContinuation, workerContinuation]);
  const exposed = `${httpResult.body}\n${cliResult.stdout}\n${cliResult.stderr}\n${workerResult.status === "rejected" ? workerResult.error?.message : JSON.stringify(workerResult.value)}`;
  assert.equal(httpResult.status, 400, httpResult.body);
  assert.match(httpResult.body, /blocked by policy or approval state/iu);
  assert.equal(cliResult.code, 1, cliResult.stderr || cliResult.stdout);
  assert.match(cliResult.stderr, /blocked by policy or approval state/iu);
  assert.equal(workerResult.status, "rejected");
  if (workerResult.status === "rejected") assert.match(workerResult.error?.message ?? "", /claimed approval continuation is missing/iu);
  assert.doesNotMatch(exposed, RAW_APPROVAL_CONTENTION);

  const ledger = createRunLedger({ stateDir, workspaceRoot: stateDir });
  try {
    for (const job of [httpJob, cliJob]) {
      const current = await (await fetch(`${base}/jobs/${job.id}`, { headers: authorization })).json();
      assert.equal(current.status, "awaiting-approval", JSON.stringify(current));
      assert.equal(ledger.getExecutionAttempt(job.executionAttemptId)?.state, "awaiting-approval");
    }
  } finally {
    ledger.close();
  }
  const persisted = JSON.parse(await readFile(approvalPath, "utf8"));
  assert.equal(persisted.approvals.find((approval: any) => approval.id === httpApproval.id)?.status, "pending");
  assert.equal(persisted.approvals.find((approval: any) => approval.id === cliApproval.id)?.status, "pending");
  assert.equal(persisted.approvals.find((approval: any) => approval.id === workerApprovalId)?.status, "approved");
  assert.equal(existsSync(join(stateDir, "process-recovery.json")), false);
  assert.equal(existsSync(join(stateDir, "sandbox-recovery.json")), false);

  await writeFile(releasePath, "release\n", { mode: 0o600 });
  const ownerResult = await owner.result;
  assert.equal(ownerResult.value?.outcome, "listed", ownerResult.stderr);
  for (const job of [httpJob, cliJob]) {
    const cancelled = await fetch(`${base}/jobs/${job.id}/cancel`, { method: "POST", headers: authorization });
    assert.equal(cancelled.status, 200, await cancelled.text());
  }
  assert.equal(createApprovalStore({ path: approvalPath }).revoke(workerApprovalId), true);
  assert.deepEqual(activeApprovalLockArtifacts(approvalPath, await readdir(stateDir)), []);
});

test("Gateway sanitizes contention acquired after a durable approval job is claimed", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-post-claim-contention-"));
  const approvalPath = join(stateDir, "approvals.json");
  const ownerReadyPath = join(stateDir, "owner-ready");
  const releasePath = join(stateDir, "release-owner");
  const jobId = "post-claim-contention-job";
  let owner: ReturnType<typeof spawnApprovalContentionWorker> | undefined;
  const serverOptions = withGatewayTestHooks({ stateDir, workspaceRoot: stateDir }, {
    afterApprovalJobClaimed: async ({ approvalId, jobId: claimedJobId }) => {
      if (claimedJobId !== jobId) return;
      owner = spawnApprovalContentionWorker({
        action: { tool: "browser.click", runId: jobId, input: { tabId: "tab_fixture", selector: "#apply" } },
        barrierTimeoutMs: 60_000,
        id: approvalId,
        operation: "list",
        ownerReadyPath,
        path: approvalPath,
        releasePath
      });
      await waitForApprovalBarrier(ownerReadyPath);
    }
  });
  const server = await createGatewayServer(serverOptions);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const token = (await readFile(join(stateDir, "gateway.token"), "utf8")).trim();
  const authorization = { authorization: `Bearer ${token}` };
  t.after(async () => {
    await writeFile(releasePath, "release\n", { mode: 0o600 }).catch(() => undefined);
    if (owner?.child.exitCode === null) owner.child.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  });

  const submitted = await fetch(`${base}/jobs`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json", "idempotency-key": jobId },
    body: JSON.stringify({ task: { tool: "browser.click", input: { tabId: "tab_fixture", selector: "#apply" } } })
  });
  assert.equal(submitted.status, 202, await submitted.text());
  const deadline = Date.now() + 10_000;
  let awaiting: any;
  while (Date.now() < deadline) {
    awaiting = await (await fetch(`${base}/jobs/${jobId}`, { headers: authorization })).json();
    if (awaiting.status === "awaiting-approval" || awaiting.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(awaiting?.status, "awaiting-approval", JSON.stringify(awaiting));
  const approvals = await (await fetch(`${base}/approvals`, { headers: authorization })).json() as any[];
  const approval = approvals.find((entry) => entry.runId === jobId);
  assert.ok(approval?.id);

  const responsePromise = fetch(`${base}/operator/actions`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({ action: "approve", targetId: approval.id, confirm: true, surface: "http" })
  }).then(async (response) => ({ body: await response.text(), status: response.status }));
  await waitForApprovalBarrier(ownerReadyPath);
  assert.ok(owner);

  let claimed: any;
  const claimDeadline = Date.now() + 5_000;
  while (Date.now() < claimDeadline) {
    claimed = await (await fetch(`${base}/jobs/${jobId}`, { headers: authorization })).json();
    if (claimed.status === "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(claimed?.status, "running", JSON.stringify(claimed));
  const response = await responsePromise;
  assert.equal(response.status, 400, response.body);
  assert.match(response.body, /blocked by policy or approval state/iu);
  assert.doesNotMatch(response.body, RAW_APPROVAL_CONTENTION);

  const settled = await (await fetch(`${base}/jobs/${jobId}`, { headers: authorization })).json();
  assert.equal(settled.status, "needs-review", JSON.stringify(settled));
  assert.equal(settled.dispatchLease, undefined);
  assert.match(settled.error, /claimed approval continuation is missing or does not match the exact request/iu);
  assert.doesNotMatch(JSON.stringify(settled), RAW_APPROVAL_CONTENTION);
  const ledger = createRunLedger({ stateDir, workspaceRoot: stateDir });
  try {
    const attempt = ledger.getExecutionAttempt(awaiting.executionAttemptId);
    assert.equal(attempt?.state, "needs-review");
    assert.equal(attempt?.errorCode, "EXECUTION_OUTCOME_UNCERTAIN");
    assert.doesNotMatch(JSON.stringify(attempt), RAW_APPROVAL_CONTENTION);
  } finally {
    ledger.close();
  }
  const audit = createAuditStore(join(stateDir, "audit.jsonl"));
  try {
    const run = await audit.readRun(jobId);
    const denial = run?.events?.find((event: any) => event.type === "operator.approval_continuation_denied");
    assert.equal(denial?.decision, "deny");
    assert.equal(denial?.data?.code, "APPROVAL_CONTINUATION_DENIED");
    assert.equal(denial?.data?.dispatchStarted, false);
    assert.doesNotMatch(JSON.stringify(run), RAW_APPROVAL_CONTENTION);
  } finally {
    audit.close();
  }
  assert.equal(existsSync(join(stateDir, "process-recovery.json")), false);
  assert.equal(existsSync(join(stateDir, "sandbox-recovery.json")), false);

  await writeFile(releasePath, "release\n", { mode: 0o600 });
  const ownerResult = await owner.result;
  assert.equal(ownerResult.value?.outcome, "listed", ownerResult.stderr);
  const retry = await fetch(`${base}/operator/actions`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({ action: "approve", targetId: approval.id, confirm: true, surface: "http" })
  });
  const retryBody = await retry.text();
  assert.equal(retry.status, 409, retryBody);
  assert.doesNotMatch(retryBody, RAW_APPROVAL_CONTENTION);
  const afterRetry = await (await fetch(`${base}/jobs/${jobId}`, { headers: authorization })).json();
  assert.equal(afterRetry.status, "needs-review", JSON.stringify(afterRetry));
  const remainingApprovals = await (await fetch(`${base}/approvals`, { headers: authorization })).json() as any[];
  assert.equal(remainingApprovals.some((entry) => entry.id === approval.id), false);
  assert.deepEqual(activeApprovalLockArtifacts(approvalPath, await readdir(stateDir)), []);
});

test("a contender recovers a killed approval-lock owner and a restarted retry stays denied", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-owner-crash-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const path = join(stateDir, "approvals.json");
  const ownerReadyPath = join(stateDir, "owner-ready");
  const contentionReadyPath = join(stateDir, "contender-collided");
  const releasePath = join(stateDir, "never-release-owner");
  const dispatchPath = join(stateDir, "dispatches.log");
  const action = { tool: "process.exec", runId: "crashed-owner-continuation", actor: "operator", input: { command: "/bin/true", args: [], cwd: "." } };
  const id = createApprovalStore({ path }).create(action);
  assert.ok(createApprovalStore({ path }).claim(id));
  const owner = spawnApprovalContentionWorker({ action, ageOwnedLock: true, barrierTimeoutMs: 60_000, id, operation: "list", ownerReadyPath, path, releasePath });
  t.after(() => { if (owner.child.exitCode === null) owner.child.kill(); });
  await waitForApprovalBarrier(ownerReadyPath);
  const contender = spawnApprovalContentionWorker({ action, contentionReadyPath, dispatchPath, id, lockTimeoutMs: 2_000, operation: "consume", path });
  t.after(() => { if (contender.child.exitCode === null) contender.child.kill(); });
  await waitForApprovalBarrier(contentionReadyPath);
  owner.child.kill("SIGKILL");
  const ownerResult = await owner.result;
  assert.ok(ownerResult.signal || ownerResult.code !== 0);
  const contenderResult = await contender.result;
  assert.equal(contenderResult.code, 0, contenderResult.stderr);
  assert.equal(contenderResult.value?.outcome, "approved", contenderResult.stdout);

  const restarted = spawnApprovalContentionWorker({ action, dispatchPath, id, operation: "consume", path });
  t.after(() => { if (restarted.child.exitCode === null) restarted.child.kill(); });
  const restartedResult = await restarted.result;
  assert.equal(restartedResult.code, 0, restartedResult.stderr);
  assert.equal(restartedResult.value?.outcome, "denied", restartedResult.stdout);
  assert.equal((await readFile(dispatchPath, "utf8")).trim().split("\n").length, 1);
  assert.deepEqual(createApprovalStore({ path }).list(), []);
  const files = await readdir(stateDir);
  assert.deepEqual(activeApprovalLockArtifacts(path, files), []);
  assert.equal(files.some((name) => name.startsWith(".odinn-approval-stale-lock.")), true);
});

test("claimed approvals expire and release durable capacity after an interrupted claim", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-claim-expiry-"));
  const path = join(stateDir, "approvals.json");
  const store = createApprovalStore({ path });
  const id = store.create({ tool: "browser.click", runId: "interrupted-claim", input: { selector: "#send" } });
  assert.equal(store.claim(id)?.status, "approved");
  const persisted = JSON.parse(await readFile(path, "utf8"));
  persisted.approvals[0].expiresAt = Date.now() - 1;
  await writeFile(path, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
  assert.equal(createApprovalStore({ path }).recover(id), undefined);
  assert.deepEqual(createApprovalStore({ path }).list(), []);
  assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(id));
  assert.ok(createApprovalStore({ path }).create({ tool: "browser.click", input: { selector: "#new" } }));
});

test("process approval bindings survive a worker restart without persisting command contents", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-worker-restart-"));
  const path = join(stateDir, "approvals.json");
  const command = "opaque-worker-command";
  const argument = "opaque-worker-argument";
  const id = createApprovalStore({ path }).create({
    tool: "process.exec",
    runId: "run-process-worker-restart",
    input: { command, args: [argument], cwd: "." }
  });
  createApprovalStore({ path }).claim(id);
  const persisted = await readFile(path, "utf8");
  assert.doesNotMatch(persisted, new RegExp(command));
  assert.doesNotMatch(persisted, new RegExp(argument));
  if (process.platform !== "win32") assert.equal((await stat(`${path}.key`)).mode & 0o777, 0o600);

  const moduleUrl = pathToFileURL(join(process.cwd(), "packages/kernel/src/approvals.ts")).href;
  const childCode = [
    `import { createApprovalStore } from ${JSON.stringify(moduleUrl)};`,
    `const store = createApprovalStore({ path: ${JSON.stringify(path)} });`,
    `const result = store.consume(${JSON.stringify(id)}, { tool: "process.exec", runId: "run-process-worker-restart", input: { command: "[redacted]", args: ["[redacted]"], cwd: "." } });`,
    `if (!result || result.input?.command !== ${JSON.stringify(command)} || result.input?.args?.[0] !== ${JSON.stringify(argument)}) process.exit(2);`
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.deepEqual(createApprovalStore({ path }).list(), []);
});

test("approval persistence redacts browser values without weakening action binding", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-redaction-"));
  const path = join(stateDir, "approvals.json");
  const sentinel = "SENTINEL_APPROVAL_BROWSER_VALUE_4f91";
  const action = {
    tool: "browser.type",
    runId: "run-browser-type",
    input: { selector: "#password", value: sentinel, sensitive: true }
  };
  const id = createApprovalStore({ path }).create(action);
  const persisted = await readFile(path, "utf8");
  assert.doesNotMatch(persisted, new RegExp(sentinel));
  assert.doesNotMatch(persisted, /bindingDigest/u);
  assert.doesNotMatch(persisted, /ciphertext|sealedAction/u);

  const restarted = createApprovalStore({ path });
  const claimed = restarted.claim(id);
  assert.equal(claimed?.input?.value, "[redacted]");
  assert.equal(claimed?.input?.selector, "#password");
  assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(sentinel));
  assert.equal(restarted.consume(id, {
    ...action,
    input: { ...action.input, value: "wrong-value" }
  }), undefined);
  assert.equal(restarted.consume(id, claimed!)?.input?.value, sentinel);
  assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(sentinel));
});

test("approval take restores exact volatile input once without persisting the payload", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-take-"));
  const path = join(stateDir, "approvals.json");
  const action = { tool: "browser.type", runId: "run-take", input: { selector: "#secretary", value: "exact value" } };
  const id = createApprovalStore({ path }).create(action);
  const taken = createApprovalStore({ path }).take(id);
  assert.deepEqual(taken?.input, action.input);
  assert.equal(createApprovalStore({ path }).take(id), undefined);
  assert.doesNotMatch(await readFile(path, "utf8"), /exact value|ciphertext|sealedAction/u);
});

test("approval records fail closed after process-volatile input is unavailable", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-legacy-"));
  const path = join(stateDir, "approvals.json");
  const legacySecret = "LEGACY_BROWSER_VALUE_MUST_BE_SCRUBBED";
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    approvals: [{
      id: "approval_without_volatile_input",
      tool: "browser.type",
      runId: "legacy",
      input: { selector: "#password", value: legacySecret },
      bindingTag: "unrecoverable",
      status: "pending",
      expiresAt: Date.now() + 60_000
    }]
  })}\n`, { mode: 0o600 });
  const store = createApprovalStore({ path });
  const claimed = store.claim("approval_without_volatile_input");
  assert.equal(claimed?.input?.value, "[redacted]");
  assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(legacySecret));
  assert.equal(store.consume("approval_without_volatile_input", claimed!), undefined);
});

test("approval store recovers a crash-stale lock owned by a dead process", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-stale-lock-"));
  const path = join(stateDir, "approvals.json");
  await writeFile(`${path}.lock`, JSON.stringify({
    pid: 2_147_483_647,
    token: "abandoned",
    createdAt: Date.now() - 60_000
  }), { mode: 0o600 });
  const id = createApprovalStore({ path }).create({ tool: "browser.click", input: { selector: "#send" } });
  assert.match(id, /^approval_/);
  const quarantined = (await readdir(stateDir)).filter((name) => name.startsWith(".odinn-approval-stale-lock."));
  assert.equal(quarantined.length, 1);
  assert.equal((await readdir(stateDir)).some((name) => name.startsWith(".odinn-approval-lock-recovery.")), false);
});

for (const [label, contents] of [["partial", "{"], ["empty", ""]] as const) {
  test(`approval store identity-quarantines an old ${label} lock file`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), `odinn-approval-${label}-lock-`));
    const path = join(stateDir, "approvals.json");
    const lockPath = `${path}.lock`;
    await writeFile(lockPath, contents, { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const id = createApprovalStore({ path }).create({ tool: "browser.click", input: { selector: "#send" } });
    assert.match(id, /^approval_/u);
    const quarantined = (await readdir(stateDir)).filter((name) => name.startsWith(".odinn-approval-stale-lock."));
    assert.equal(quarantined.length, 1);
    assert.equal(await readFile(join(stateDir, quarantined[0]!), "utf8"), contents);
    assert.equal(existsSync(lockPath), false);
  });
}

test("approval stale-lock recovery never removes a lock while another recovery owns its token", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-stale-lock-race-"));
  const path = join(stateDir, "approvals.json");
  const lock = { pid: 2_147_483_647, token: "contended-abandoned-lock", createdAt: Date.now() - 60_000 };
  const recoveryPath = join(stateDir, `.odinn-approval-lock-recovery.${createHash("sha256").update(`${path}.lock\0${lock.token}`).digest("hex")}`);
  await writeFile(`${path}.lock`, JSON.stringify(lock), { mode: 0o600 });
  await writeFile(recoveryPath, JSON.stringify({ pid: process.pid, token: "live-recovery" }), { mode: 0o600 });
  assert.throws(
    () => createApprovalStore({ path, lockTimeoutMs: 50 }).create({ tool: "browser.click", input: { selector: "#send" } }),
    (error: any) => error?.code === "APPROVAL_STORE_CONTENDED"
      && /approval state could not be accessed before the bounded deadline/iu.test(error?.message)
      && !/APPROVAL_STORE_BUSY|approval store is busy|approval state is temporarily unavailable/iu.test(`${error?.code} ${error?.message}`)
  );
  assert.deepEqual(JSON.parse(await readFile(`${path}.lock`, "utf8")), lock);
  assert.equal((await readdir(stateDir)).some((name) => name.startsWith(".odinn-approval-stale-lock.")), false);
});

test("approval stale-lock recovery replaces a recovery marker abandoned by a dead owner", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-recovery-marker-"));
  const path = join(stateDir, "approvals.json");
  const lock = { pid: 2_147_483_647, token: "abandoned-primary", createdAt: Date.now() - 60_000 };
  const recoveryName = `.odinn-approval-lock-recovery.${createHash("sha256").update(`${path}.lock\0${lock.token}`).digest("hex")}`;
  await writeFile(`${path}.lock`, JSON.stringify(lock), { mode: 0o600 });
  await writeFile(join(stateDir, recoveryName), JSON.stringify({
    pid: 2_147_483_647,
    token: "abandoned-recovery",
    createdAt: Date.now() - 60_000
  }), { mode: 0o600 });
  const id = createApprovalStore({ path }).create({ tool: "browser.click", input: { selector: "#send" } });
  assert.match(id, /^approval_/u);
  const files = await readdir(stateDir);
  assert.equal(files.some((name) => name.startsWith(".odinn-approval-stale-lock.")), true);
  assert.equal(files.includes(recoveryName), false);
});

test("gateway state files and directory are owner-only", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-permissions-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  try {
    await stat(join(stateDir, "config.json"));
    if (process.platform === "win32") assert.equal(await isOwnerOnlyPath(stateDir), true);
    else {
      assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
      assert.equal((await stat(join(stateDir, "config.json"))).mode & 0o777, 0o600);
    }
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("gateway rejects an audit path that escapes state before startup", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-unsafe-audit-"));
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify({ version: 1, auditLog: "../other-tenant/audit.jsonl" })}\n`, { mode: 0o600 });
  await assert.rejects(
    () => createGatewayServer({ stateDir, workspaceRoot: stateDir }),
    /auditLog must be audit\.jsonl or an audit-\*\.jsonl filename/
  );
});

test("configuration reads refuse symbolic-link swaps", { skip: process.platform === "win32" }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-config-symlink-"));
  const outsideDir = await mkdtemp(join(tmpdir(), "odinn-config-outside-"));
  const outside = join(outsideDir, "outside.json");
  const outsideContents = '{"private":"must-not-be-returned"}\n';
  await writeFile(outside, outsideContents, { mode: 0o644 });
  const outsideMode = (await stat(outside)).mode & 0o777;
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bootstrap = await fetch(`${base}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    await rename(join(stateDir, "config.json"), join(stateDir, "config.original.json"));
    await symlink(outside, join(stateDir, "config.json"));
    const response = await fetch(`${base}/config`, { headers: { cookie } });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /symbolic link/);
    assert.equal(await readFile(outside, "utf8"), outsideContents);
    assert.equal((await stat(outside)).mode & 0o777, outsideMode);
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("governed workspace mutation endpoints require authenticated session and same-origin controls", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-governed-auth-"));
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify({ version: 1, experimental: { capabilities: true } })}\n`);
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const payload = JSON.stringify({ runId: "missing-auth", operation: "write", path: "seed.txt", content: "without-cookie" });
  try {
    const noAuth = await fetch(`${base}/governed/workspace/mutate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload
    });
    assert.equal(noAuth.status, 401);

    const bootstrap = await fetch(`${base}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const crossOrigin = await fetch(`${base}/governed/workspace/mutate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "https://evil.example"
      },
      body: payload
    });
    assert.equal(crossOrigin.status, 403);
    const sameOrigin = await fetch(`${base}/governed/workspace/mutate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: base,
        "sec-fetch-site": "same-origin"
      },
      body: payload
    });
    assert.equal(sameOrigin.status, 400);
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("governed mutation endpoints enforce capability gates and ignore nested request payload tokens", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-governed-capability-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "odinn-gateway-governed-capability-workspace-"));
  const tokenConfig = {
    version: 1,
    experimental: { capabilities: true },
    policy: {
      allowedCapabilities: [
        "job.healthcheck",
        "text.echo",
        "workspace.readText",
        "workspace.mutate",
        "workspace.patch",
        "restore.create",
        "restore.apply",
        "model.chat",
        "agent.run",
        "web.read",
        "browser.read",
        "browser.act",
        "discord.read",
        "discord.write",
        "session.read",
        "session.write",
        "goal.read",
        "goal.write",
        "memory.read",
        "memory.write",
        "improve.read",
        "improve.write"
      ]
    }
  };
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify(tokenConfig)}\n`);
  const server = await createGatewayServer({ stateDir, workspaceRoot });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(`${base}/`);
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  try {
    const mutateRequestBody = {
      runId: "governed-mutate-denied",
      operation: "write",
      path: "seed.txt",
      content: "before"
    };
    const denied = await fetch(`${base}/governed/workspace/mutate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ ...mutateRequestBody, runId: "governed-mutate-denied" })
    });
    assert.equal(denied.status, 400);
    const deniedBody = await denied.json();
    assert.equal(deniedBody.ok, false);
    assert.equal(typeof deniedBody.error, "string");

    const payloadOnly = await fetch(`${base}/governed/workspace/mutate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ ...mutateRequestBody, runId: "governed-mutate-payload-only", input: { capabilityToken: "forged" } })
    });
    assert.equal(payloadOnly.status, 400);
    const payloadOnlyBody = await payloadOnly.json();
    assert.equal(payloadOnlyBody.ok, false);
    assert.equal(typeof payloadOnlyBody.error, "string");

    const issued = await (await fetch(`${base}/capabilities/issue`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        runId: "governed-mutate-allowed",
        stepId: "governed-mutate-step",
        toolName: "workspace.mutate",
        scopes: ["workspace:mutate"]
      })
    })).json();
    const allowed = await fetch(`${base}/governed/workspace/mutate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ ...mutateRequestBody, runId: "governed-mutate-allowed", capabilityToken: issued.token })
    });
    assert.equal(allowed.status, 200);
    const allowedBody = await allowed.json();
    assert.equal(allowedBody.output?.preview, true);
    assert.equal(existsSync(join(workspaceRoot, "seed.txt")), false);
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("governed restore create/apply preserves restore conflict semantics", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-governed-restore-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "odinn-gateway-governed-restore-workspace-"));
  const tokenConfig = {
    version: 1,
    experimental: { capabilities: true },
    policy: {
      allowedCapabilities: [
        "job.healthcheck",
        "text.echo",
        "workspace.readText",
        "workspace.mutate",
        "workspace.patch",
        "restore.create",
        "restore.apply",
        "model.chat",
        "agent.run",
        "web.read",
        "browser.read",
        "browser.act",
        "discord.read",
        "discord.write",
        "session.read",
        "session.write",
        "goal.read",
        "goal.write",
        "memory.read",
        "memory.write",
        "improve.read",
        "improve.write"
      ]
    }
  };
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify(tokenConfig)}\n`);
  const server = await createGatewayServer({ stateDir, workspaceRoot });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(`${base}/`);
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  try {
    const issuedMutateToken = (await (await fetch(`${base}/capabilities/issue`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        runId: "governed-restore-source",
        stepId: "governed-restore-step",
        toolName: "workspace.mutate",
        scopes: ["workspace:mutate"]
      })
    })).json()).token;
    const issuedCreateToken = (await (await fetch(`${base}/capabilities/issue`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        runId: "governed-restore-create",
        stepId: "governed-restore-step",
        toolName: "restore.create",
        scopes: ["restore:create"]
      })
    })).json()).token;
    const issuedApplyToken = (await (await fetch(`${base}/capabilities/issue`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        runId: "governed-restore-apply",
        stepId: "governed-restore-step",
        toolName: "restore.apply",
        scopes: ["restore:apply"]
      })
    })).json()).token;

    await writeFile(join(workspaceRoot, "seed.txt"), "restored baseline");
    const mutateTicket = {
      runId: "governed-restore-source",
      operation: "remove",
      path: "seed.txt",
      apply: true,
      capabilityToken: issuedMutateToken
    };
    const mutate = await fetch(`${base}/governed/workspace/mutate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify(mutateTicket)
    });
    assert.equal(mutate.status, 200);
    const mutation = await mutate.json();
    const checkpointId = mutation.output?.checkpointId;
    assert.equal(typeof checkpointId, "string");
    const create = await fetch(`${base}/governed/restore/create`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ runId: "governed-restore-create", checkpointId, capabilityToken: issuedCreateToken })
    });
    assert.equal(create.status, 200);
    const createBody = await create.json();
    assert.equal(createBody.output?.preview, true);
    assert.equal(createBody.output?.status, "ready");

    await writeFile(join(workspaceRoot, "seed.txt"), "externally-changed");
    const apply = await fetch(`${base}/governed/restore/apply`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ runId: "governed-restore-apply", checkpointId, capabilityToken: issuedApplyToken })
    });
    assert.equal(apply.status, 200);
    const applyBody = await apply.json();
    assert.equal(applyBody.output?.status, "conflict");
    assert.equal(applyBody.output?.applied, false);
    assert.equal(applyBody.output?.preview, true);
    assert.equal(applyBody.output?.conflicts?.some((conflict: any) => typeof conflict.code === "string"), true);
    await writeFile(join(workspaceRoot, "seed.txt"), "externally-changed");
    assert.equal(await readFile(join(workspaceRoot, "seed.txt"), "utf8"), "externally-changed");
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

function requestRaw({ port, path, headers = {} }: any) {
  return new Promise((resolve: any, reject: any) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, headers }, (response: any) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    request.end();
  });
}
