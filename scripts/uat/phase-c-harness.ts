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
import { closeBrowserManagers, prepareBrowserProfileDirectory } from "../../packages/kernel/src/browser.ts";
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

export const PHASE_C_POST_RESTART_PROMPT = "PHASE_C_POST_RESTART_PROVIDER_MODEL_PROBE";

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
  controlledEffectUrl: string;
  controlledEffectRequests: Array<{ sequence: number; method: string; path: string; receivedAt: string }>;
  startGateway: (port?: number) => Promise<void>;
  stopGateway: () => Promise<void>;
  close: () => Promise<void>;
};

export type PhaseCHarnessSetupPhase = "state-dir-created" | "workspace-created" | "provider-listening" | "gateway-listening";

export type PhaseCHarnessOptions = {
  testHooks?: {
    afterSetupPhase?: (phase: PhaseCHarnessSetupPhase, resources: {
      stateDir?: string;
      workspaceRoot?: string;
      browserProfileDir?: string;
      providerPort?: number;
      gatewayPort?: number;
    }) => void | Promise<void>;
  };
};

export type PhaseCUncertainEffect = {
  jobId: string;
  approvalId: string;
  requestBody: Record<string, unknown>;
  approvalCompletion: Promise<{ status: number; body?: unknown; error?: string }>;
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

function cleanupFailure(primary: unknown, cleanupErrors: unknown[]) {
  if (!cleanupErrors.length) return primary;
  return new AggregateError([primary, ...cleanupErrors], "Phase C setup failed and cleanup also reported errors");
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

async function closeGatewayServer(server?: HttpServer) {
  if (!server) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    const finish = (error?: NodeJS.ErrnoException | null) => {
      if (!error || error.code === "ERR_SERVER_NOT_RUNNING") resolveClose();
      else rejectClose(error);
    };
    try {
      server.close(finish);
    } catch (error) {
      finish(error as NodeJS.ErrnoException);
    }
  });
}

async function waitForClosedStateStores(stateDir: string) {
  const deadline = Date.now() + 5_000;
  let stableSince = 0;
  for (;;) {
    try {
      await inspectStateSchemas(stateDir);
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 300) return;
    } catch (error: any) {
      if (!/database is locked/iu.test(String(error?.message)) || Date.now() >= deadline) throw error;
      stableSince = 0;
    }
    if (Date.now() >= deadline) throw new Error("Phase C state stores did not remain unlocked during shutdown");
    await delay(25);
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

function hasExactUserMessage(body: any, content: string) {
  return Array.isArray(body?.messages)
    && body.messages.some((message: any) => message?.role === "user" && message?.content === content);
}

async function providerResponse(response: any, body: any, recoveryUrl: string) {
  const text = requestText(body);
  if (hasExactUserMessage(body, PHASE_C_POST_RESTART_PROMPT)) {
    if (!hasToolResult(body)) {
      await writeSse(response, [{
        id: "phase_c_post_restart_browser_tool",
        choices: [{ delta: { role: "assistant", tool_calls: [{
          index: 0,
          id: "phase_c_post_restart_browser_open",
          type: "function",
          function: { name: "browser_x2e_open", arguments: JSON.stringify({ url: recoveryUrl }) },
        }] } }],
      }]);
      return;
    }
    await writeSse(response, [{
      id: "phase_c_post_restart_result",
      choices: [{ delta: { role: "assistant", content: "Post-restart provider and model request verified." } }],
      usage: { prompt_tokens: 4, completion_tokens: 7, total_tokens: 11 },
    }]);
    return;
  }
  if (text.includes("Confirm the Phase C recovery steps") && text.includes("BEGIN UNTRUSTED LOCAL FILE")) {
    await writeSse(response, [
      { id: "phase_c_chat_result", choices: [{ delta: { role: "assistant", content: "Recovery notes verified. " } }] },
      { choices: [{ delta: { content: "The durable checkpoint remains operator-controlled." } }], usage: { prompt_tokens: 8, completion_tokens: 10, total_tokens: 18 } },
    ], 80);
    return;
  }
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

export async function launchPinnedChromium({ headless, testHooks }: {
  headless: boolean;
  testHooks?: {
    chromium?: any;
    pinnedChromium?: { browserVersion?: string; revision: string };
    access?: typeof access;
    realpath?: typeof realpath;
  };
}): Promise<PinnedBrowser> {
  const selectedChromium = testHooks?.chromium ?? chromium;
  const selectedPin = testHooks?.pinnedChromium ?? pinnedChromium;
  const accessPath = testHooks?.access ?? access;
  const resolveRealpath = testHooks?.realpath ?? realpath;
  if (!selectedPin?.browserVersion) throw new Error("playwright-core does not declare a pinned Chromium version");
  const executablePath = process.env.ODINN_CHROMIUM_PATH?.trim() || selectedChromium.executablePath();
  await accessPath(executablePath);
  let browser: any;
  try {
    browser = await selectedChromium.launch({ executablePath, headless });
    const browserVersion = browser.version();
    const resolvedExecutablePath = await resolveRealpath(executablePath);
    if (browserVersion !== selectedPin.browserVersion) {
      throw new Error(`Phase C UAT requires Chromium ${selectedPin.browserVersion}; ${resolvedExecutablePath} reported ${browserVersion}`);
    }
    return {
      browser,
      executablePath: resolvedExecutablePath,
      browserVersion,
      playwrightVersion: playwrightPackage.version,
      revision: selectedPin.revision,
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (browser) await browser.close().catch((cleanupError: unknown) => cleanupErrors.push(cleanupError));
    throw cleanupFailure(error, cleanupErrors);
  }
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

async function waitForJobStatus(base: string, jobId: string, statuses: Set<string>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let job: any;
  while (Date.now() < deadline) {
    job = await jsonRequest(base, `/jobs/${encodeURIComponent(jobId)}`);
    if (statuses.has(job.status)) return job;
    await delay(50);
  }
  throw new Error(`job ${jobId} did not reach ${Array.from(statuses).join("/")}: ${JSON.stringify(job)}`);
}

async function waitForControlledEffect(harness: PhaseCHarness, count: number, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (harness.controlledEffectRequests.length >= count) return;
    await delay(25);
  }
  throw new Error(`controlled effect did not dispatch ${count} time(s): ${JSON.stringify(harness.controlledEffectRequests)}`);
}

export async function createPhaseCHarness(options: PhaseCHarnessOptions = {}): Promise<PhaseCHarness> {
  const previousEnvironment = {
    gatewayAuth: process.env.ODINN_GATEWAY_AUTH,
    browserHeadless: process.env.ODINN_BROWSER_HEADLESS,
  };
  process.env.ODINN_GATEWAY_AUTH = "off";
  process.env.ODINN_BROWSER_HEADLESS = "1";
  let stateDir = "";
  let workspaceRoot = "";
  let browserProfileDir = "";
  let provider: HttpServer | undefined;
  let harness: PhaseCHarness | undefined;
  const restoreEnvironment = () => {
    if (previousEnvironment.gatewayAuth === undefined) delete process.env.ODINN_GATEWAY_AUTH;
    else process.env.ODINN_GATEWAY_AUTH = previousEnvironment.gatewayAuth;
    if (previousEnvironment.browserHeadless === undefined) delete process.env.ODINN_BROWSER_HEADLESS;
    else process.env.ODINN_BROWSER_HEADLESS = previousEnvironment.browserHeadless;
  };
  try {
    stateDir = await mkdtemp(join(tmpdir(), "odinn-phase-c-state-"));
    browserProfileDir = await prepareBrowserProfileDirectory(stateDir);
    await options.testHooks?.afterSetupPhase?.("state-dir-created", { stateDir, browserProfileDir });
    workspaceRoot = await mkdtemp(join(tmpdir(), "odinn-phase-c-workspace-"));
    await options.testHooks?.afterSetupPhase?.("workspace-created", { stateDir, workspaceRoot, browserProfileDir });
    await writeFile(join(workspaceRoot, "recovery-state.txt"), "checkpoint-before-interruption\n", { mode: 0o600 });
    const providerRequests: any[] = [];
    const controlledEffectRequests: PhaseCHarness["controlledEffectRequests"] = [];
    let recoveryUrl = "";
    let controlledEffectUrl = "";
    provider = createHttpServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/recovery-note") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end("<!doctype html><title>Recovery note</title><main><h1>Durable recovery note</h1><p>The operator must explicitly restore the retained checkpoint.</p></main>");
      return;
    }
    if (request.method === "GET" && request.url === "/controlled-effect") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end('<!doctype html><title>Controlled effect</title><main><h1>Controlled local effect</h1><button id="phase-c-controlled-effect" type="button" onclick="const request=new XMLHttpRequest();request.open(\'POST\',\'/controlled-effect/commit\',false);request.send();const deadline=performance.now()+30000;while(performance.now()<deadline){}">Commit controlled effect</button></main>');
      return;
    }
    if (request.method === "POST" && request.url === "/controlled-effect/commit") {
      const sequence = controlledEffectRequests.length + 1;
      await writeFile(join(workspaceRoot, "controlled-effect-count.txt"), `${sequence}\n`, { mode: 0o600 });
      controlledEffectRequests.push({ sequence, method: request.method, path: request.url, receivedAt: new Date().toISOString() });
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end("<!doctype html><title>Controlled effect received</title><p>The controlled effect was received.</p>");
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
    controlledEffectUrl = `http://127.0.0.1:${providerPort}/controlled-effect`;
    await options.testHooks?.afterSetupPhase?.("provider-listening", { stateDir, workspaceRoot, browserProfileDir, providerPort });
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
    let closed = false;
    harness = {
    stateDir,
    workspaceRoot,
    base,
    port,
    providerRequests,
    controlledEffectUrl,
    controlledEffectRequests,
    startGateway: async (requestedPort = 0) => {
      if (closed) throw new Error("Phase C harness is already closed");
      if (gateway) throw new Error("Phase C Gateway is already running");
      let candidate: any;
      try {
        candidate = await createGatewayServer({ stateDir, workspaceRoot });
        await new Promise<void>((resolveListen, rejectListen) => {
          const onError = (error: Error) => rejectListen(error);
          candidate.once("error", onError);
          candidate.listen(requestedPort, "127.0.0.1", () => {
            candidate.off("error", onError);
            resolveListen();
          });
        });
        const address = candidate.address();
        if (!address || typeof address === "string") throw new Error("Phase C Gateway did not bind a TCP port");
        gateway = candidate;
        port = address.port;
        base = `http://127.0.0.1:${port}`;
        harness!.port = port;
        harness!.base = base;
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        if (candidate) await closeGatewayServer(candidate).catch((cleanupError) => cleanupErrors.push(cleanupError));
        await closeBrowserManagers().catch((cleanupError) => cleanupErrors.push(cleanupError));
        await waitForClosedStateStores(stateDir).catch((cleanupError) => cleanupErrors.push(cleanupError));
        throw cleanupFailure(error, cleanupErrors);
      }
    },
    stopGateway: async () => {
      const cleanupErrors: unknown[] = [];
      if (gateway) {
        const active = gateway;
        gateway = undefined;
        await closeGatewayServer(active).catch((error) => cleanupErrors.push(error));
      }
      await closeBrowserManagers().catch((error) => cleanupErrors.push(error));
      await waitForClosedStateStores(stateDir).catch((error) => cleanupErrors.push(error));
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Phase C Gateway cleanup failed");
    },
    close: async () => {
      if (closed) return;
      closed = true;
      const cleanupErrors: unknown[] = [];
      await harness!.stopGateway().catch((error) => cleanupErrors.push(error));
      await closeServer(provider).catch((error) => cleanupErrors.push(error));
      await rm(browserProfileDir, { recursive: true, force: true }).catch((error) => cleanupErrors.push(error));
      await rm(stateDir, { recursive: true, force: true }).catch((error) => cleanupErrors.push(error));
      await rm(workspaceRoot, { recursive: true, force: true }).catch((error) => cleanupErrors.push(error));
      restoreEnvironment();
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Phase C harness cleanup failed");
    },
    };
    await harness.startGateway();
    await options.testHooks?.afterSetupPhase?.("gateway-listening", { stateDir, workspaceRoot, browserProfileDir, providerPort, gatewayPort: harness.port });
    return harness;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (harness) await harness.close().catch((cleanupError) => cleanupErrors.push(cleanupError));
    else {
      await closeServer(provider).catch((cleanupError) => cleanupErrors.push(cleanupError));
      if (browserProfileDir) await rm(browserProfileDir, { recursive: true, force: true }).catch((cleanupError) => cleanupErrors.push(cleanupError));
      if (stateDir) await rm(stateDir, { recursive: true, force: true }).catch((cleanupError) => cleanupErrors.push(cleanupError));
      if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true }).catch((cleanupError) => cleanupErrors.push(cleanupError));
      restoreEnvironment();
    }
    throw cleanupFailure(error, cleanupErrors);
  }
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

export async function beginPhaseCUncertainEffect(harness: PhaseCHarness): Promise<PhaseCUncertainEffect> {
  let opened: any;
  try {
    opened = await jsonRequest(harness.base, "/run", {
      method: "POST",
      body: JSON.stringify({
        id: "phase-c-controlled-effect-open",
        tool: "browser.open",
        input: { url: harness.controlledEffectUrl },
      }),
    });
  } catch (error) {
    const audit = await jsonRequest(harness.base, "/audit/query?pageSize=100").catch(() => ({ events: [] }));
    const failures = audit.events?.filter((event: any) => event.runId === "phase-c-controlled-effect-open" && event.type === "task.failed")
      .map((event: any) => event.message);
    throw new Error(`controlled effect browser setup failed: ${error instanceof Error ? error.message : String(error)}; audit=${JSON.stringify(failures)}`);
  }
  if (!opened.output?.id || !opened.output?.snapshotId || !opened.output?.url) {
    throw new Error(`controlled effect browser fixture did not open: ${JSON.stringify(opened)}`);
  }
  const jobId = "phase-c-uncertain-browser-effect";
  const requestBody = {
    task: {
      tool: "browser.click",
      input: {
        tabId: opened.output.id,
        snapshotId: opened.output.snapshotId,
        expectedUrl: opened.output.url,
        selector: "#phase-c-controlled-effect",
        timeoutMs: 30_000,
      },
    },
  };
  await jsonRequest(harness.base, "/jobs", {
    method: "POST",
    headers: { "idempotency-key": jobId },
    body: JSON.stringify(requestBody),
  }, 202);
  const awaitingApproval = await waitForJobStatus(harness.base, jobId, new Set(["awaiting-approval", "failed", "needs-review"]));
  if (awaitingApproval.status !== "awaiting-approval") {
    throw new Error(`controlled effect did not await approval: ${JSON.stringify(awaitingApproval)}`);
  }
  const approvals = await jsonRequest(harness.base, "/approvals");
  const approval = approvals.find((entry: any) => entry.runId === jobId);
  if (!approval?.id) throw new Error(`controlled effect approval was not retained: ${JSON.stringify(approvals)}`);
  const expectedDispatchCount = harness.controlledEffectRequests.length + 1;
  const approvalCompletion = fetch(`${harness.base}/approvals/${encodeURIComponent(approval.id)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then(async (response) => {
    const raw = await response.text();
    let body: unknown;
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
    return { status: response.status, body };
  }).catch((error: unknown) => ({ status: 0, error: error instanceof Error ? error.message : String(error) }));
  await waitForControlledEffect(harness, expectedDispatchCount);
  const running = await jsonRequest(harness.base, `/jobs/${encodeURIComponent(jobId)}`);
  if (running.status !== "running" || running.attempts !== 1) {
    throw new Error(`controlled effect was not durably in flight: ${JSON.stringify(running)}`);
  }
  return { jobId, approvalId: approval.id, requestBody, approvalCompletion };
}

async function commitIdentity() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["show", "-s", "--format=%T", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8" }).trim().length > 0;
  return { commit, tree, dirty };
}

export function humanUatExitCode(report: {
  pass?: boolean;
  results?: Array<{ result?: string }>;
  attestations?: Record<string, boolean>;
} | undefined) {
  const requiredAttestations = ["nonDeveloper", "sourceBlind", "browserOnly", "keyboardOnlyNarrowSegment"];
  if (report?.pass !== true || !report.results?.length || report.results.some((entry) => entry.result !== "pass")) return 1;
  if (requiredAttestations.some((key) => report.attestations?.[key] !== true)) return 1;
  return 0;
}

export type HumanPhaseCTestDependencies = {
  commitIdentity?: typeof commitIdentity;
  createHarness?: typeof createPhaseCHarness;
  seedRecovery?: typeof seedPhaseCRecovery;
  setCapabilityAdmission?: typeof setPhaseCCapabilityAdmission;
  launchBrowser?: typeof launchPinnedChromium;
  createReadline?: () => any;
  afterReadlineCreated?: (resources: { harness: PhaseCHarness; pinned: PinnedBrowser; context: any; page: any; readline: any }) => void | Promise<void>;
};

async function installHumanKeyboardEvidence(context: any) {
  await context.addInitScript(() => {
    const storageKey = "phase-c-trusted-keyboard-evidence";
    if (!sessionStorage.getItem(storageKey)) sessionStorage.setItem(storageKey, "[]");
    document.addEventListener("keydown", (event) => {
      const accepted = new Set(["Tab", "Enter", " ", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
      if (!event.isTrusted || !accepted.has(event.key)) return;
      const element = event.target instanceof HTMLElement ? event.target : undefined;
      const interactive = element?.closest("button, a, summary, input, select, textarea, [role]") as HTMLElement | null | undefined;
      const target = interactive ?? element;
      const name = target?.getAttribute("aria-label")
        || (["BUTTON", "A", "SUMMARY"].includes(target?.tagName ?? "") ? target?.textContent?.trim().replace(/\s+/gu, " ").slice(0, 80) : "")
        || "";
      let evidence: unknown[] = [];
      // The value is non-sensitive UI navigation evidence, not credential material.
      // lgtm[js/clear-text-storage-of-sensitive-data]
      try { evidence = JSON.parse(sessionStorage.getItem(storageKey) || "[]"); } catch {}
      evidence.push({
        key: event.key === " " ? "Space" : event.key,
        shift: event.shiftKey,
        viewportWidth: innerWidth,
        target: { tag: target?.tagName?.toLowerCase() ?? "unknown", role: target?.getAttribute("role") ?? "", name },
      });
      sessionStorage.setItem(storageKey, JSON.stringify(evidence.slice(-120)));
    }, true);
  });
}

async function readHumanKeyboardEvidence(page: any) {
  return page.evaluate(() => {
    try { return JSON.parse(sessionStorage.getItem("phase-c-trusted-keyboard-evidence") || "[]"); } catch { return []; }
  }) as Promise<Array<{ key: string; shift: boolean; viewportWidth: number; target: { tag: string; role: string; name: string } }>>;
}

async function askHumanGoalResult(rl: any, goal: string) {
  for (;;) {
    const result = (await rl.question(`${goal} result (pass/fail/blocked): `)).trim().toLowerCase();
    if (["pass", "fail", "blocked"].includes(result)) {
      const notes = (await rl.question(`${goal} notes (blank if none): `)).trim();
      return { goal, result, notes };
    }
    output.write("Enter exactly pass, fail, or blocked.\n");
  }
}

export async function runHumanPhaseCUat(dependencies: HumanPhaseCTestDependencies = {}) {
  const resolveIdentity = dependencies.commitIdentity ?? commitIdentity;
  const createHarness = dependencies.createHarness ?? createPhaseCHarness;
  const seedRecovery = dependencies.seedRecovery ?? seedPhaseCRecovery;
  const setCapabilityAdmission = dependencies.setCapabilityAdmission ?? setPhaseCCapabilityAdmission;
  const launchBrowser = dependencies.launchBrowser ?? launchPinnedChromium;
  const createReadline = dependencies.createReadline ?? (() => createInterface({ input, output }));
  let harness: PhaseCHarness | undefined;
  let pinned: PinnedBrowser | undefined;
  let context: any;
  let rl: any;
  let resultCode = 1;
  let failure: unknown;
  try {
    const identity = await resolveIdentity();
    harness = await createHarness();
    const seed = await seedRecovery(harness);
    await setCapabilityAdmission(harness, false);
    pinned = await launchBrowser({ headless: false });
    context = await pinned.browser.newContext({ viewport: { width: 1280, height: 900 } });
    await installHumanKeyboardEvidence(context);
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
    rl = createReadline();
    await dependencies.afterReadlineCreated?.({ harness, pinned, context, page, readline: rl });
    const results: Array<{ goal: string; result: string; notes: string }> = [];
    await page.goto(harness.base, { waitUntil: "domcontentloaded" });
    output.write(["", "PHASE C SOURCE-BLIND TEST", `URL: ${harness.base}`, "", "Give the tester only the URL and these goals:", "1. Choose the second model and complete one chat with an attachment; describe the streaming progress.", "2. Create a daily schedule named Daily recovery check.", "3. Find the waiting one-use browser approval without consuming it yet.", "4. Search Activity history for text.echo.", "5. Inspect delegated work and state the child terminal reason and activity.", "6. Complete part of the workflow using keyboard-only navigation and check the narrow layout for overflow.", "7. Report confusing labels, missing notifications, overflow, or any need for terminal/source access.", ""].join("\n"));
    await rl.question("Facilitator: press Enter after the tester completes the pre-restart goals. ");
    const providerRequestRestartBoundary = harness.providerRequests.length;
    const uncertainEffect = await beginPhaseCUncertainEffect(harness);
    const port = harness.port;
    await harness.stopGateway();
    const interruptedApproval = await uncertainEffect.approvalCompletion;
    await harness.startGateway(port);
    await page.reload({ waitUntil: "domcontentloaded" });
    const recoveredUncertainJob = await waitForJob(harness.base, uncertainEffect.jobId);
    const uncertainReplay = await jsonRequest(harness.base, "/jobs", {
      method: "POST",
      headers: { "idempotency-key": uncertainEffect.jobId },
      body: JSON.stringify(uncertainEffect.requestBody),
    });
    await delay(250);
    const browserRecovery = await jsonRequest(harness.base, "/run", {
      method: "POST",
      body: JSON.stringify({ id: "phase-c-browser-recovery-evidence", tool: "browser.recovery.status", input: {} }),
    });
    output.write(["", "Gateway restarted on the same URL.", "Ask the tester to reload, confirm the original chat/schedule/approval/child state survived, deny the waiting approval, and observe the status notification.", `Then select the second model and send this exact visible test message: ${PHASE_C_POST_RESTART_PROMPT}`, "They should observe the browser-tool feedback and then see: Post-restart provider and model request verified.", ""].join("\n"));
    await rl.question("Facilitator: press Enter after the tester completes the post-restart goals. ");
    await page.evaluate(() => sessionStorage.setItem("phase-c-trusted-keyboard-evidence", "[]"));
    await page.setViewportSize({ width: 375, height: 812 });
    output.write("\nThe harness has set the tester browser to exactly 375×812. Ask the tester to use only Tab/Shift+Tab and Enter/Space to open navigation and reach Operator or Advanced → Restore Points, then report any horizontal overflow.\n");
    await rl.question("Facilitator: press Enter after the keyboard-only narrow-layout segment. ");
    const narrowViewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      visibleHeading: Array.from(document.querySelectorAll("main h1, main h2"))
        .find((element) => (element as HTMLElement).offsetParent !== null)?.textContent?.trim() ?? "",
    }));
    const keyboardEvidence = await readHumanKeyboardEvidence(page);
    const trustedTabAt375 = keyboardEvidence.some((entry) => entry.key === "Tab" && entry.viewportWidth === 375);
    const trustedNavigationActivationAt375 = keyboardEvidence.some((entry) => ["Enter", "Space"].includes(entry.key)
      && entry.viewportWidth === 375
      && /Open navigation|Close navigation|Operator|Advanced|Restore Points/iu.test(entry.target.name));
    await page.setViewportSize({ width: 1280, height: 900 });
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
      results.push(await askHumanGoalResult(rl, goal));
    }
    const attestations = {
      nonDeveloper: (await rl.question("Tester attests they are not an Ódinn Forge developer or contributor (yes/no): ")).trim().toLowerCase() === "yes",
      sourceBlind: (await rl.question("Tester attests they did not inspect source, selectors, SQLite, raw audit records, or implementation notes (yes/no): ")).trim().toLowerCase() === "yes",
      browserOnly: (await rl.question("Tester attests they used only the supplied browser URL, visible goals, and restore point reference—no terminal or direct APIs (yes/no): ")).trim().toLowerCase() === "yes",
      keyboardOnlyNarrowSegment: (await rl.question("Tester attests the controlled 375px segment used only keyboard navigation (yes/no): ")).trim().toLowerCase() === "yes",
    };
    const [cron, approvals, job, graph, audit, controlledEffectFile] = await Promise.all([
      jsonRequest(harness.base, "/cron"),
      jsonRequest(harness.base, "/approvals"),
      jsonRequest(harness.base, `/jobs/${encodeURIComponent(seed.durableJobId)}`),
      jsonRequest(harness.base, `/agent-graphs/${encodeURIComponent(seed.graphRunId)}`),
      jsonRequest(harness.base, "/audit/verify"),
      readFile(join(harness.workspaceRoot, "controlled-effect-count.txt"), "utf8").catch(() => ""),
    ]);
    const consumedApproval = await jsonRequest(harness.base, `/approvals/${encodeURIComponent(seed.approvalId)}/approve`, { method: "POST" }, 404);
    const selectedModelUsed = harness.providerRequests.some((request) => request.model === "daily-driver-b");
    const browserToolRoundTrip = harness.providerRequests.some((request) => request.model === "daily-driver-b"
      && request.messages?.some((message: any) => message.role === "tool"));
    const exactPostRestartProviderRequests = harness.providerRequests.slice(providerRequestRestartBoundary)
      .filter((request) => request.model === "daily-driver-b"
        && hasExactUserMessage(request, PHASE_C_POST_RESTART_PROMPT)
        && !hasToolResult(request));
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
    const noUncertainEffectReplay = recoveredUncertainJob.status === "needs-review"
      && recoveredUncertainJob.attempts === 1
      && uncertainReplay.replayed === true
      && uncertainReplay.job?.status === "needs-review"
      && uncertainReplay.job?.attempts === 1
      && harness.controlledEffectRequests.length === 1
      && controlledEffectFile === "1\n";
    const exactNarrowViewport = narrowViewport.width === 375 && narrowViewport.height === 812;
    const noNarrowOverflow = exactNarrowViewport
      && narrowViewport.documentScrollWidth <= narrowViewport.width
      && narrowViewport.bodyScrollWidth <= narrowViewport.width;
    const report = {
      schemaVersion: 3,
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
        consumedApprovalUnavailable: consumedApproval.error === "approval not found or expired",
        selectedModelUsed,
        browserToolRoundTrip,
        postRestartProviderModel: {
          prompt: PHASE_C_POST_RESTART_PROMPT,
          expectedModel: "daily-driver-b",
          exactRequestCount: exactPostRestartProviderRequests.length,
        },
        durableJobStatus: job.status,
        graphStatus: graph.graph?.status,
        uncertainEffect: {
          jobId: uncertainEffect.jobId,
          preRestartDispatchCount: 1,
          interruptedApprovalStatus: interruptedApproval.status,
          recoveredStatus: recoveredUncertainJob.status,
          attempts: recoveredUncertainJob.attempts,
          idempotentReplay: uncertainReplay.replayed === true,
          replayStatus: uncertainReplay.job?.status,
          replayAttempts: uncertainReplay.job?.attempts,
          controlledDispatches: harness.controlledEffectRequests,
          controlledEffectFile,
          browserRecoveryStatus: browserRecovery.output?.recovery?.status,
          noReplay: noUncertainEffectReplay,
          scope: "controlled loopback browser effect; no live external service",
        },
        responsiveKeyboard: {
          viewport: narrowViewport,
          exactNarrowViewport,
          noHorizontalOverflow: noNarrowOverflow,
          trustedTabAt375,
          trustedNavigationActivationAt375,
          events: keyboardEvidence,
        },
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
        && cron.jobs[0]?.name === "Daily recovery check"
        && approvals.length === 0
        && consumedApproval.error === "approval not found or expired"
        && selectedModelUsed
        && browserToolRoundTrip
        && exactPostRestartProviderRequests.length === 1
        && job.status === "completed"
        && graph.graph?.status === "completed"
        && noUncertainEffectReplay
        && ["unknown", "executing"].includes(browserRecovery.output?.recovery?.status)
        && noNarrowOverflow
        && trustedTabAt375
        && trustedNavigationActivationAt375
        && exactAuditValid,
    };
    const reportDir = join(repositoryRoot, "dist", "uat");
    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, `phase-c-human-${identity.commit.slice(0, 12)}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    output.write(`\nHuman UAT report: ${reportPath}\nResult: ${report.pass ? "PASS" : "HOLD"}\n`);
    resultCode = humanUatExitCode(report);
  } catch (error) {
    failure = error;
  }
  const cleanupErrors: unknown[] = [];
  try { rl?.close(); } catch (error) { cleanupErrors.push(error); }
  if (context) await context.close().catch((error: unknown) => cleanupErrors.push(error));
  if (pinned) await pinned.browser.close().catch((error: unknown) => cleanupErrors.push(error));
  if (harness) await harness.close().catch((error: unknown) => cleanupErrors.push(error));
  if (failure) throw cleanupFailure(failure, cleanupErrors);
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Phase C human UAT cleanup failed");
  return resultCode;
}

async function main() {
  process.exitCode = await runHumanPhaseCUat();
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
