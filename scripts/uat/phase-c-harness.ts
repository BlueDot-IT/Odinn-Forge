import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createGatewayServer } from "../../apps/gateway/src/server.ts";
import { AGENT_GRAPH_REGISTRY_REF } from "../../packages/kernel/src/agent-graph-runtime.ts";
import { validateAgentRunGraph, validateExecutableAgentManifest } from "../../packages/kernel/src/agent-run-graphs.ts";
import { closeBrowserManagers } from "../../packages/kernel/src/browser.ts";
import { inspectStateSchemas } from "../../packages/kernel/src/state/migration-manager.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const playwrightPath = "../../packages/kernel/node_modules/playwright-core";
const { chromium } = require(playwrightPath);
const playwrightPackage = require(`${playwrightPath}/package.json`) as { version: string };
const browserRegistry = require(`${playwrightPath}/browsers.json`) as {
  browsers: Array<{ name: string; browserVersion?: string; revision: string }>;
};
const pinnedChromium = browserRegistry.browsers.find((entry) => entry.name === "chromium");

export type PinnedBrowser = {
  browser: any;
  executablePath: string;
  browserVersion: string;
  playwrightVersion: string;
  revision: string;
};

export type PhaseCHarness = {
  stateDir: string;
  workspaceRoot: string;
  base: string;
  port: number;
  providerRequests: any[];
  startGateway: (port?: number) => Promise<void>;
  stopGateway: () => Promise<void>;
  close: () => Promise<void>;
};

export type PhaseCSeed = {
  approvalId: string;
  checkpointId: string;
  durableJobId: string;
  durableJobCapabilityToken: string;
  graphJobId: string;
  graphRunId: string;
};

function delay(milliseconds: number) {
  return new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function listen(server: HttpServer, port = 0) {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind a TCP port");
  return address.port;
}

async function closeServer(server?: HttpServer) {
  if (!server?.listening) return;
  const closed = new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

async function waitForClosedStateStores(stateDir: string) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await inspectStateSchemas(stateDir);
      return;
    } catch (error: any) {
      if (!/database is locked/iu.test(String(error?.message)) || Date.now() >= deadline) throw error;
      await delay(25);
    }
  }
}

async function readRequestJson(request: any) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return JSON.parse(raw || "{}");
}

async function writeSse(response: any, events: any[], pauseMs = 0) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  for (const event of events) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
    if (pauseMs > 0) await delay(pauseMs);
  }
  response.end("data: [DONE]\n\n");
}

function requestText(body: any) {
  return JSON.stringify(body?.messages ?? body?.input ?? []);
}

function hasToolResult(body: any) {
  return Array.isArray(body?.messages) && body.messages.some((message: any) => message?.role === "tool");
}

async function providerResponse(response: any, body: any, recoveryUrl: string) {
  const text = requestText(body);
  if (text.includes("PHASE_C_CHILD_ACTIVITY")) {
    await writeSse(response, [{
      id: "phase_c_child_result",
      choices: [{ delta: { role: "assistant", content: "Child recovery check completed with retained evidence." } }],
      usage: { prompt_tokens: 2, completion_tokens: 7, total_tokens: 9 },
    }]);
    return;
  }
  if (!hasToolResult(body)) {
    await writeSse(response, [{
      id: "phase_c_browser_tool",
      choices: [{ delta: { role: "assistant", tool_calls: [{
        index: 0,
        id: "phase_c_browser_open",
        type: "function",
        function: { name: "browser_x2e_open", arguments: JSON.stringify({ url: recoveryUrl }) },
      }] } }],
    }]);
    return;
  }
  await writeSse(response, [
    { id: "phase_c_chat_result", choices: [{ delta: { role: "assistant", content: "Recovery notes verified. " } }] },
    { choices: [{ delta: { content: "The durable checkpoint remains operator-controlled." } }], usage: { prompt_tokens: 8, completion_tokens: 10, total_tokens: 18 } },
  ], 80);
}

export async function launchPinnedChromium({ headless }: { headless: boolean }): Promise<PinnedBrowser> {
  if (!pinnedChromium?.browserVersion) throw new Error("playwright-core does not declare a pinned Chromium version");
  const executablePath = process.env.ODINN_CHROMIUM_PATH?.trim() || chromium.executablePath();
  await access(executablePath);
  const browser = await chromium.launch({ executablePath, headless });
  const browserVersion = browser.version();
  if (browserVersion !== pinnedChromium.browserVersion) {
    await browser.close();
    throw new Error(`Phase C UAT requires Chromium ${pinnedChromium.browserVersion}; ${await realpath(executablePath)} reported ${browserVersion}`);
  }
  return {
    browser,
    executablePath: await realpath(executablePath),
    browserVersion,
    playwrightVersion: playwrightPackage.version,
    revision: pinnedChromium.revision,
  };
}

export async function jsonRequest(base: string, path: string, init: RequestInit = {}, expected: number | number[] = 200) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...(init.headers ?? {}) },
  });
  const raw = await response.text();
  let body: any;
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
  const expectedStatuses = Array.isArray(expected) ? expected : [expected];
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

export async function waitForJob(base: string, jobId: string, terminal = new Set(["completed", "failed", "needs-review", "cancelled"]), timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let job: any;
  while (Date.now() < deadline) {
    job = await jsonRequest(base, `/jobs/${encodeURIComponent(jobId)}`);
    if (terminal.has(job.status)) return job;
    await delay(50);
  }
  throw new Error(`job ${jobId} did not settle: ${JSON.stringify(job)}`);
}

export async function createPhaseCHarness(): Promise<PhaseCHarness> {
  process.env.ODINN_GATEWAY_AUTH = "off";
  process.env.ODINN_BROWSER_HEADLESS = "1";
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-phase-c-state-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "odinn-phase-c-workspace-"));
  await writeFile(join(workspaceRoot, "recovery-state.txt"), "checkpoint-before-interruption\n", { mode: 0o600 });
  const providerRequests: any[] = [];
  let recoveryUrl = "";
  const provider = createHttpServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/recovery-note") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end("<!doctype html><title>Recovery note</title><main><h1>Durable recovery note</h1><p>The operator must explicitly restore the retained checkpoint.</p></main>");
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const body = await readRequestJson(request);
      providerRequests.push(body);
      await providerResponse(response, body, recoveryUrl);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "fixture route not found" }));
  });
  const providerPort = await listen(provider);
  recoveryUrl = `http://127.0.0.1:${providerPort}/recovery-note`;
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify({
    version: 1,
    defaultModel: "uat:daily-driver-a",
    providers: {
      uat: {
        type: "openai-compatible",
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        models: ["daily-driver-a", "daily-driver-b"],
      },
    },
    runtime: { enableAgentGraphs: true },
    experimental: { capabilities: true, capsules: false, counterfactual: false },
    policy: {
      allowedCapabilities: [
        "agent.run", "model.chat",
        "workspace.inspect", "workspace.mutate", "network.access", "browser.read", "browser.mutate",
        "agent.delegate", "restore.create", "restore.apply",
      ],
      security: { browser: { allowPrivateNetwork: true } },
    },
    channels: {},
  }, null, 2)}\n`, { mode: 0o600 });

  let gateway: any;
  let port = 0;
  let base = "";
  const harness: PhaseCHarness = {
    stateDir,
    workspaceRoot,
    base,
    port,
    providerRequests,
    startGateway: async (requestedPort = 0) => {
      if (gateway) throw new Error("Phase C Gateway is already running");
      gateway = await createGatewayServer({ stateDir, workspaceRoot });
      await new Promise<void>((resolveListen, rejectListen) => {
        gateway.once("error", rejectListen);
        gateway.listen(requestedPort, "127.0.0.1", () => {
          gateway.off("error", rejectListen);
          resolveListen();
        });
      });
      const address = gateway.address();
      if (!address || typeof address === "string") throw new Error("Phase C Gateway did not bind a TCP port");
      port = address.port;
      base = `http://127.0.0.1:${port}`;
      harness.port = port;
      harness.base = base;
    },
    stopGateway: async () => {
      if (gateway) {
        const active = gateway;
        gateway = undefined;
        await new Promise<void>((resolveClose, rejectClose) => active.close((error?: Error) => error ? rejectClose(error) : resolveClose()));
        await waitForClosedStateStores(stateDir);
      }
      await closeBrowserManagers();
    },
    close: async () => {
      await harness.stopGateway().catch(() => undefined);
      await closeServer(provider).catch(() => undefined);
      await Promise.all([
        rm(stateDir, { recursive: true, force: true }),
        rm(workspaceRoot, { recursive: true, force: true }),
      ]);
    },
  };
  await harness.startGateway();
  return harness;
}

export async function seedPhaseCRecovery(harness: PhaseCHarness): Promise<PhaseCSeed> {
  const checkpointTaskId = "phase-c-checkpoint-create";
  const checkpointCapability = await jsonRequest(harness.base, "/capabilities/issue", {
    method: "POST",
    body: JSON.stringify({ runId: checkpointTaskId, stepId: "phase-c-checkpoint-step", toolName: "snapshot.create" }),
  });
  const checkpoint = await jsonRequest(harness.base, "/checkpoints", {
    method: "POST",
    body: JSON.stringify({
      runId: "phase-c-recovery-source",
      taskId: checkpointTaskId,
      stepId: "phase-c-checkpoint-step",
      paths: ["recovery-state.txt"],
      label: "Phase C before interruption",
      capabilityToken: checkpointCapability.token,
    }),
  });
  await writeFile(join(harness.workspaceRoot, "recovery-state.txt"), "interrupted-after-checkpoint\n", { mode: 0o600 });

  const durableJobId = "phase-c-durable-job";
  const durableJobCapability = await jsonRequest(harness.base, "/capabilities/issue", {
    method: "POST",
    body: JSON.stringify({ runId: durableJobId, stepId: "phase-c-durable-job-step", toolName: "text.echo" }),
  });
  await jsonRequest(harness.base, "/jobs", {
    method: "POST",
    headers: { "idempotency-key": durableJobId },
    body: JSON.stringify({ task: { tool: "text.echo", input: { text: "PHASE_C_DURABLE_JOB_RESULT", capabilityToken: durableJobCapability.token } } }),
  }, 202);
  const durableJob = await waitForJob(harness.base, durableJobId);
  if (durableJob.status !== "completed") throw new Error(`durable Phase C fixture failed: ${JSON.stringify(durableJob)}`);

  const approvalCapability = await jsonRequest(harness.base, "/capabilities/issue", {
    method: "POST",
    body: JSON.stringify({ runId: "phase-c-approval", stepId: "phase-c-approval-step", toolName: "browser.click" }),
  });
  const approvalRequest = await jsonRequest(harness.base, "/run", {
    method: "POST",
    body: JSON.stringify({ id: "phase-c-approval", tool: "browser.click", input: { tabId: "phase-c-restart-tab", selector: "#continue", capabilityToken: approvalCapability.token } }),
  });
  if (approvalRequest.output?.type !== "approval.required") throw new Error(`approval fixture was not retained: ${JSON.stringify(approvalRequest)}`);

  const manifest = validateExecutableAgentManifest(JSON.stringify({
    schemaVersion: 1,
    id: "phase-c-reader",
    revision: 1,
    registryRef: AGENT_GRAPH_REGISTRY_REF,
    requestedTools: ["text.echo"],
    requestedCapabilities: ["workspace.inspect"],
    maxChildren: 1,
    defaultTimeoutMs: 60_000,
  }));
  const graph = validateAgentRunGraph(JSON.stringify({
    schemaVersion: 1,
    id: "phase-c-recovery-graph",
    nodes: [{ id: "checkpoint-reader", manifestId: manifest.id, manifestDigest: manifest.manifestDigest, inputRef: "input:checkpoint-reader", resultRef: "result:checkpoint-reader", dependsOn: [] }],
  }));
  const graphJobId = "phase-c-graph-job";
  const graphCapability = await jsonRequest(harness.base, "/capabilities/issue", {
    method: "POST",
    body: JSON.stringify({ runId: graphJobId, stepId: "phase-c-graph-step", toolName: "agent.delegate" }),
  });
  await jsonRequest(harness.base, "/jobs", {
    method: "POST",
    headers: { "idempotency-key": graphJobId },
    body: JSON.stringify({
      kind: "agent-graph",
      parentCapabilities: ["agent.delegate", "network.access", "workspace.inspect"],
      task: {
        tool: "agent.delegate",
        input: {
          graph: JSON.stringify(graph),
          manifests: JSON.stringify([manifest]),
          principalNamespace: "phase-c-operator",
          capabilityToken: graphCapability.token,
          inputs: { "input:checkpoint-reader": { prompt: "PHASE_C_CHILD_ACTIVITY: inspect retained recovery evidence", model: "uat:daily-driver-a", maxTurns: 1, maxTokens: 128 } },
        },
      },
    }),
  }, 202);
  const graphJob = await waitForJob(harness.base, graphJobId);
  if (graphJob.status !== "completed") throw new Error(`agent graph fixture failed: ${JSON.stringify(graphJob)}`);
  return {
    approvalId: approvalRequest.output.approvalId,
    checkpointId: checkpoint.snapshotId,
    durableJobId,
    durableJobCapabilityToken: durableJobCapability.token,
    graphJobId,
    graphRunId: graphJob.result.output.graphRunId,
  };
}

export async function setPhaseCCapabilityAdmission(harness: PhaseCHarness, enabled: boolean) {
  const configPath = join(harness.stateDir, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.experimental = { ...(config.experimental ?? {}), capabilities: enabled };
  const port = harness.port;
  await harness.stopGateway();
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await harness.startGateway(port);
}

async function commitIdentity() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["show", "-s", "--format=%T", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8" }).trim().length > 0;
  return { commit, tree, dirty };
}

async function main() {
  const identity = await commitIdentity();
  const harness = await createPhaseCHarness();
  const seed = await seedPhaseCRecovery(harness);
  await setPhaseCCapabilityAdmission(harness, false);
  const pinned = await launchPinnedChromium({ headless: false });
  const context = await pinned.browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const restorePath = `/rewind/${encodeURIComponent(seed.checkpointId)}`;
  const uiRestoreRequests: Array<{ path: string; apply: boolean }> = [];
  page.on("request", (request: any) => {
    const url = new URL(request.url());
    if (request.method() !== "POST" || url.pathname !== restorePath) return;
    try {
      const body = request.postDataJSON();
      uiRestoreRequests.push({ path: url.pathname, apply: body?.apply === true });
    } catch {
      uiRestoreRequests.push({ path: url.pathname, apply: false });
    }
  });
  const rl = createInterface({ input, output });
  const results: Array<{ goal: string; result: string; notes: string }> = [];
  let reportPath = "";
  try {
    await page.goto(harness.base, { waitUntil: "domcontentloaded" });
    output.write(["", "PHASE C SOURCE-BLIND TEST", `URL: ${harness.base}`, "", "Give the tester only the URL and these goals:", "1. Choose the second model and complete one chat with an attachment; describe the progress and browser-tool feedback.", "2. Create a daily schedule named Daily recovery check.", "3. Find the waiting one-use browser approval without consuming it yet.", "4. Search Activity history for text.echo.", "5. Inspect delegated work and state the child terminal reason and activity.", "6. Complete part of the workflow using keyboard-only navigation and check the narrow layout for overflow.", "7. Report confusing labels, missing notifications, overflow, or any need for terminal/source access.", ""].join("\n"));
    await rl.question("Facilitator: press Enter after the tester completes the pre-restart goals. ");
    const port = harness.port;
    await harness.stopGateway();
    await harness.startGateway(port);
    await page.reload({ waitUntil: "domcontentloaded" });
    output.write("\nGateway restarted on the same URL. Ask the tester to reload, confirm the chat/schedule/approval/child state survived, deny the approval, and observe the status notification.\n");
    await rl.question("Facilitator: press Enter after the tester completes the post-restart goals. ");
    const beforePreview = await readFile(join(harness.workspaceRoot, "recovery-state.txt"), "utf8");
    output.write(["", "Ask the tester to open Advanced → Restore Points, choose Preview a restore, and use this operator-visible restore point reference:", seed.checkpointId, "They must run the preview through the page and inspect the displayed result. Do not apply it yet.", ""].join("\n"));
    await rl.question("Facilitator: press Enter after the tester has inspected the preview result, before any apply action. ");
    const afterPreview = await readFile(join(harness.workspaceRoot, "recovery-state.txt"), "utf8");
    const previewResultText = await page.locator('#view-lab-restore-points [data-role="result"]').innerText().catch(() => "");
    output.write("\nState inspection confirms whether preview was non-mutating. Ask the tester to choose Restore files on the same page, use the same reference, review the confirmation, and apply it through the page.\n");
    await rl.question("Facilitator: press Enter after the tester has inspected the applied result. ");
    const afterRestore = await readFile(join(harness.workspaceRoot, "recovery-state.txt"), "utf8");
    const appliedResultText = await page.locator('#view-lab-restore-points [data-role="result"]').innerText().catch(() => "");
    const goals = ["model-chat-attachment", "progress-tool-and-notification-feedback", "schedule-persistence", "approval-persistence-and-consumption", "searchable-history", "child-activity-and-terminal-reason", "restore-points-preview-and-apply", "keyboard-and-responsive-use", "source-blind-usability"];
    for (const goal of goals) {
      const result = (await rl.question(`${goal} result (pass/fail/blocked): `)).trim().toLowerCase();
      const notes = (await rl.question(`${goal} notes (blank if none): `)).trim();
      results.push({ goal, result, notes });
    }
    const attestations = {
      nonDeveloper: (await rl.question("Tester attests they are not an Ódinn Forge developer or contributor (yes/no): ")).trim().toLowerCase() === "yes",
      sourceBlind: (await rl.question("Tester attests they did not inspect source, selectors, SQLite, raw audit records, or implementation notes (yes/no): ")).trim().toLowerCase() === "yes",
      browserOnly: (await rl.question("Tester attests they used only the supplied browser URL, visible goals, and restore point reference—no terminal or direct APIs (yes/no): ")).trim().toLowerCase() === "yes",
    };
    const [cron, approvals, job, graph, audit] = await Promise.all([
      jsonRequest(harness.base, "/cron"),
      jsonRequest(harness.base, "/approvals"),
      jsonRequest(harness.base, `/jobs/${encodeURIComponent(seed.durableJobId)}`),
      jsonRequest(harness.base, `/agent-graphs/${encodeURIComponent(seed.graphRunId)}`),
      jsonRequest(harness.base, "/audit/verify"),
    ]);
    const selectedModelUsed = harness.providerRequests.some((request) => request.model === "daily-driver-b");
    const browserToolRoundTrip = harness.providerRequests.some((request) => request.model === "daily-driver-b"
      && request.messages?.some((message: any) => message.role === "tool"));
    const restorePreviewFromUi = uiRestoreRequests.length === 2
      && uiRestoreRequests[0]?.path === restorePath
      && uiRestoreRequests[0]?.apply === false;
    const restoreApplyFromUi = uiRestoreRequests.length === 2
      && uiRestoreRequests[1]?.path === restorePath
      && uiRestoreRequests[1]?.apply === true;
    const exactAuditValid = audit.valid === true
      && Number.isSafeInteger(audit.events)
      && audit.events > 0
      && audit.unsigned === 0
      && Array.isArray(audit.failures)
      && audit.failures.length === 0;
    const report = {
      schemaVersion: 2,
      recordedAt: new Date().toISOString(),
      identity,
      browser: { playwright: pinned.playwrightVersion, chromium: pinned.browserVersion, revision: pinned.revision },
      results,
      attestations,
      automatedEvidence: {
        noAutomaticReplay: beforePreview === "interrupted-after-checkpoint\n",
        restorePreviewFromUi,
        restorePreviewOnly: restorePreviewFromUi && afterPreview === beforePreview && /Files changed\s+No/iu.test(previewResultText),
        restoreApplyFromUi,
        restoreApplied: restoreApplyFromUi && afterRestore === "checkpoint-before-interruption\n" && /Files changed\s+Yes/iu.test(appliedResultText),
        uiRestoreRequests,
        scheduleCount: cron.jobs?.length ?? 0,
        pendingApprovals: approvals.length,
        selectedModelUsed,
        browserToolRoundTrip,
        durableJobStatus: job.status,
        graphStatus: graph.graph?.status,
        audit: { valid: audit.valid, events: audit.events, unsigned: audit.unsigned, failures: audit.failures },
        exactAuditValid,
      },
      pass: !identity.dirty
        && results.every((entry) => entry.result === "pass")
        && Object.values(attestations).every(Boolean)
        && beforePreview === "interrupted-after-checkpoint\n"
        && restorePreviewFromUi
        && afterPreview === beforePreview
        && /Files changed\s+No/iu.test(previewResultText)
        && restoreApplyFromUi
        && afterRestore === "checkpoint-before-interruption\n"
        && /Files changed\s+Yes/iu.test(appliedResultText)
        && cron.jobs?.length === 1
        && approvals.length === 0
        && selectedModelUsed
        && browserToolRoundTrip
        && job.status === "completed"
        && graph.graph?.status === "completed"
        && exactAuditValid,
    };
    const reportDir = join(repositoryRoot, "dist", "uat");
    await mkdir(reportDir, { recursive: true });
    reportPath = join(reportDir, `phase-c-human-${identity.commit.slice(0, 12)}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    output.write(`\nHuman UAT report: ${reportPath}\nResult: ${report.pass ? "PASS" : "HOLD"}\n`);
  } finally {
    rl.close();
    await pinned.browser.close().catch(() => undefined);
    await harness.close();
  }
  if (!reportPath) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
