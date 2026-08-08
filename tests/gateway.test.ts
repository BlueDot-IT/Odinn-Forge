process.env.ODINN_GATEWAY_AUTH = "off";
process.env.ODINN_BROWSER_HEADLESS = "1";
process.env.ODINN_BROWSER_ACTION_TIMEOUT_MS = "500";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createGatewayServer } from "../apps/gateway/src/server.ts";
import { TeamsChannelAdapter, teamsChannelPlugin } from "../adapters/channels/teams/src/index.ts";
import { createRunLedger } from "../packages/kernel/src/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const normalizedRoot = resolve(root);

async function readSseIds(response: Response, count: number) {
  const reader = response.body!.getReader(); const decoder = new TextDecoder(); const ids: number[] = []; let buffer = "";
  while (ids.length < count) { const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true }); const frames = buffer.split("\n\n"); buffer = frames.pop()!; for (const frame of frames) { const match = /^id: (\d+)$/mu.exec(frame); if (match && ids.length < count) ids.push(Number(match[1])); } }
  return ids;
}

test("gateway exposes status, run execution, plans, and run summaries", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  let admittedRunId = "";
  try {
    const status = await getJson(`${base}/status`);
    assert.equal(status.ok, true);
    assert.equal(status.workspaceRoot, normalizedRoot);
    assert.ok(status.tools.includes("text.echo"));
    assert.ok(status.tools.includes("web.search"));
    assert.ok(status.tools.includes("browser.open"));
    assert.ok(status.tools.includes("agent.run"));
    assert.deepEqual(status.coreAdvanced, ["proof", "sentinel", "rewind", "darwin"]);
    assert.deepEqual(status.pluginModules.map((plugin: any) => plugin.id), ["capabilities", "capsules", "counterfactual"]);
    assert.ok(status.pluginModules.every((plugin: any) => plugin.enabled === false));
    assert.equal(status.security.web.allowPrivateNetwork, false);
    assert.equal(status.security.browser.requireApproval, true);
    assert.equal(status.capabilityRegistryVersion, 1);
    assert.ok(status.capabilityRegistry.some((capability: any) => capability.id === "process.shell"));
    assert.ok(status.toolDetails.some((tool: any) => tool.name === "text.echo" && tool.capability === "workspace.inspect" && tool.capabilities.includes("workspace.inspect")));
    assert.ok(status.allowedTools.includes("agent.run"));
    assert.equal(status.capabilityMigration.automaticWidening, false);

    const runsBeforePreview = await getJson(`${base}/runs`);
    const preview = await postJson(`${base}/gatewatch/preview`, {
      toolName: "browser.open",
      input: { url: "https://example.com" },
      parentCapabilities: ["browser.read"],
      requestedCapabilities: ["browser.read", "network.access"]
    });
    assert.equal(preview.allowed, false);
    assert.equal(preview.details.code, "CHILD_CAPABILITY_ESCALATION");
    assert.equal(preview.executes, false);
    assert.deepEqual(preview.effectiveCapabilities, []);
    assert.deepEqual(await getJson(`${base}/runs`), runsBeforePreview);

    await postJson(`${base}/run`, { id: "core-proof-run", tool: "text.echo", input: { text: "proof source" } });
    const coreProof = await fetch(`${base}/proof`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, id: "core-proof", runId: "core-proof-run", assertions: [{ id: "fixture", type: "file", path: "README.md", expect: { exists: true } }] })
    });
    assert.equal(coreProof.status, 200);
    assert.equal((await coreProof.json()).status, "passed");

    const run = await postJson(`${base}/run`, { tool: "text.echo", input: { text: "ODINN_GATEWAY_OK" } });
    admittedRunId = run.id;
    assert.equal(run.ok, true);
    assert.equal(run.output.text, "ODINN_GATEWAY_OK");

    const projects = await getJson(`${base}/projects`);
    assert.ok(Array.isArray(projects.projects));

    const plan = await postJson(`${base}/plan`, {
      id: "plan_gateway",
      name: "gateway-plan",
      steps: [{ id: "echo", tool: "text.echo", input: { text: "ODINN_GATEWAY_PLAN_OK" } }]
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.steps[0].result.output.text, "ODINN_GATEWAY_PLAN_OK");

    const runs = await getJson(`${base}/runs`);
    assert.ok(runs.some((summary: any) => summary.id === run.id && summary.status === "completed"));
    assert.ok(runs.some((summary: any) => summary.id === "plan_gateway" && summary.status === "completed"));

    const runDetail = await getJson(`${base}/runs/${encodeURIComponent(run.id)}`);
    assert.equal(runDetail.id, run.id);
    assert.equal(runDetail.events.length, 4);
    assert.ok(runDetail.events.some((event: any) => event.type === "execution.admitted"));
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
  const ledger = createRunLedger({ stateDir, workspaceRoot: root });
  try {
    assert.equal(ledger.getExecutionEnvelope(admittedRunId)?.envelope.execution.id, "text.echo");
    const envelopes = ledger.database.db.prepare("SELECT envelope_json FROM execution_envelopes").all() as Array<{ envelope_json: string }>;
    assert.ok(envelopes.some((row) => JSON.parse(row.envelope_json).execution.id === "project.list"));
  } finally {
    ledger.close();
  }
});

test("audit SSE uses exclusive durable sequence cursors across reconnects", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-audit-sse-")); const server = await createGatewayServer({ stateDir, workspaceRoot: root }); await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const baseline = (await getJson(`${base}/audit`)).length; const firstAbort = new AbortController(); const first = await fetch(`${base}/events?since=${baseline}&subscriber=sse-regression`, { signal: firstAbort.signal });
    await postJson(`${base}/run`, { id: "sse-regression-run", tool: "text.echo", input: { text: "stream" } }); const firstIds = await readSseIds(first, 4); firstAbort.abort(); assert.deepEqual(firstIds, [baseline + 1, baseline + 2, baseline + 3, baseline + 4]);
    const unackedAbort = new AbortController(); const unacked = await fetch(`${base}/events?since=${baseline}&subscriber=sse-regression`, { signal: unackedAbort.signal }); const unackedIds = await readSseIds(unacked, 1); unackedAbort.abort(); assert.deepEqual(unackedIds, [baseline + 1]);
    assert.deepEqual(await postJson(`${base}/events/ack`, { subscriber: "sse-regression", sequence: baseline + 3 }), { ok: true, subscriber: "sse-regression", sequence: baseline + 3 });
    const reconnectAbort = new AbortController(); const reconnect = await fetch(`${base}/events?since=${baseline}&subscriber=sse-regression`, { signal: reconnectAbort.signal }); const reconnectIds = await readSseIds(reconnect, 1); reconnectAbort.abort(); assert.deepEqual(reconnectIds, [baseline + 4]);
    const headerAbort = new AbortController(); const headerReconnect = await fetch(`${base}/events?since=${baseline}&subscriber=sse-regression`, { headers: { "last-event-id": String(baseline + 3) }, signal: headerAbort.signal }); const headerIds = await readSseIds(headerReconnect, 1); headerAbort.abort(); assert.deepEqual(headerIds, [baseline + 4]);
    await postJson(`${base}/events/ack`, { subscriber: "sse-regression", sequence: baseline + 100 }, 409);
  } finally { await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve())); }
});

test("gateway diagnostics expose safe state and errors carry correlation metadata", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-diagnostics-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const diagnosticsResponse = await fetch(`${base}/diagnostics`, { headers: { "x-odinn-request-id": "diagnostics-test-request" } });
    assert.equal(diagnosticsResponse.status, 200);
    assert.equal(diagnosticsResponse.headers.get("x-odinn-request-id"), "diagnostics-test-request");
    const diagnostics = await diagnosticsResponse.json();
    assert.equal(diagnostics.command, "diagnostics");
    assert.equal(diagnostics.audit.valid, true);
    assert.equal(diagnostics.state.ownerOnly, true);
    assert.equal(diagnostics.state.runtimeStateOutsideSourceCheckout, true);
    assert.equal(diagnostics.state.secretsExcludedFromDiagnostics, true);
    assert.equal(JSON.stringify(diagnostics).includes(stateDir), false);

    const invalid = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-odinn-request-id": "diagnostics-error-request" },
      body: "{"
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get("x-odinn-request-id"), "diagnostics-error-request");
    const error = await invalid.json();
    assert.equal(error.ok, false);
    assert.equal(error.category, "validation");
    assert.equal(error.requestId, "diagnostics-error-request");
    assert.match(error.nextAction, /doctor/);
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("gateway supervises configured channels without exposing credentials", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-channels-"));
  await writeFile(join(stateDir, "config.json"), JSON.stringify({
    version: 1,
    channels: {
      personal: {
        type: "telegram",
        enabled: true,
        tokenEnv: "ODINN_TEST_MISSING_TELEGRAM_TOKEN",
        allowlist: ["telegram:100"]
      },
      community: {
        type: "discord",
        enabled: true,
        tokenEnv: "ODINN_TEST_MISSING_DISCORD_TOKEN",
        allowlist: ["discord:100"],
        requireMention: true
      }
    }
  }));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await new Promise((resolveWait) => setImmediate(resolveWait));
    const result = await getJson(`${base}/channels`);
    assert.equal(result.ok, true);
    assert.equal(result.channels[0].name, "personal");
    assert.equal(result.channels[0].running, false);
    assert.equal(result.channels[0].credentialConfigured, true);
    assert.equal(result.channels[0].credentialPresent, false);
    assert.match(result.channels[0].error, /credential is unavailable/);
    const discord = result.channels.find((channel: any) => channel.name === "community");
    assert.equal(discord.type, "discord");
    assert.equal(discord.running, false);
    assert.equal(discord.credentialPresent, false);
    const diagnostics = await getJson(`${base}/diagnostics`);
    assert.ok(diagnostics.channels.every((channel: any) => channel.credentialPresent === false));
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("gateway exposes only provider-authenticated channel webhook routes before control-plane auth", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-whatsapp-"));
  const environment = {
    ODINN_TEST_WHATSAPP_ACCESS_TOKEN: process.env.ODINN_TEST_WHATSAPP_ACCESS_TOKEN,
    ODINN_TEST_WHATSAPP_APP_SECRET: process.env.ODINN_TEST_WHATSAPP_APP_SECRET,
    ODINN_TEST_WHATSAPP_VERIFY_TOKEN: process.env.ODINN_TEST_WHATSAPP_VERIFY_TOKEN
  };
  process.env.ODINN_TEST_WHATSAPP_ACCESS_TOKEN = "access-token";
  process.env.ODINN_TEST_WHATSAPP_APP_SECRET = "app-secret";
  process.env.ODINN_TEST_WHATSAPP_VERIFY_TOKEN = "verify-token";
  await writeFile(join(stateDir, "config.json"), JSON.stringify({
    version: 1,
    channels: {
      business: {
        type: "whatsapp",
        enabled: true,
        tokenEnv: "ODINN_TEST_WHATSAPP_ACCESS_TOKEN",
        appSecretEnv: "ODINN_TEST_WHATSAPP_APP_SECRET",
        verifyTokenEnv: "ODINN_TEST_WHATSAPP_VERIFY_TOKEN",
        phoneNumberId: "123",
        allowlist: ["whatsapp:15550002222"]
      }
    }
  }));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await new Promise((resolveWait) => setImmediate(resolveWait));
    const verified = await fetch(
      `${base}/channels/webhook/whatsapp/business?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=challenge`
    );
    assert.equal(verified.status, 200);
    assert.equal(await verified.text(), "challenge");
    const rejected = await fetch(
      `${base}/channels/webhook/whatsapp/business?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge`
    );
    assert.equal(rejected.status, 403);
    const unknown = await fetch(`${base}/channels/webhook/whatsapp/missing`);
    assert.equal(unknown.status, 404);
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("gateway bounds and authenticates Microsoft Teams webhook activities end to end", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-teams-"));
  const previousEnvironment = {
    ODINN_TEST_TEAMS_APP_ID: process.env.ODINN_TEST_TEAMS_APP_ID,
    ODINN_TEST_TEAMS_APP_PASSWORD: process.env.ODINN_TEST_TEAMS_APP_PASSWORD,
    ODINN_TEST_TEAMS_PROVIDER_KEY: process.env.ODINN_TEST_TEAMS_PROVIDER_KEY
  };
  process.env.ODINN_TEST_TEAMS_APP_ID = "teams-test-app";
  process.env.ODINN_TEST_TEAMS_APP_PASSWORD = "teams-test-password";
  process.env.ODINN_TEST_TEAMS_PROVIDER_KEY = "teams-provider-key";
  const outbound: any[] = [];
  const authenticated: any[] = [];
  let providerCalls = 0;
  const provider = createHttpServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    providerCalls += 1;
    for await (const _chunk of request) {
      // Consume the complete bounded provider request.
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "teams-provider-response",
      object: "chat.completion",
      model: "teams-test-model",
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "ODINN_TEAMS_WEBHOOK_OK" }
      }]
    }));
  });
  await new Promise((resolve: any) => provider.listen(0, "127.0.0.1", resolve));
  const providerPort = (provider.address() as any).port;
  const signedToken = createHmac("sha256", "teams-test-signing-key").update("activity-1").digest("hex");
  const connector = {
    conversations: {
      async sendToConversation(_conversationId: string, activity: any) {
        outbound.push(activity);
        return { id: `teams-out-${outbound.length}` };
      },
      async replyToActivity(_conversationId: string, _replyToId: string, activity: any) {
        outbound.push(activity);
        return { id: `teams-out-${outbound.length}` };
      },
      async updateActivity(_conversationId: string, _messageId: string, activity: any) {
        outbound.push(activity);
        return { id: activity.id };
      },
      async deleteActivity() {}
    }
  };
  const botFrameworkAuthentication: any = {
    async authenticateRequest(activity: any, authorization: string) {
      assert.equal(authorization, `Bearer ${signedToken}`);
      authenticated.push(activity);
      return {
        audience: "teams-test-audience",
        callerId: "teams-test-caller",
        claimsIdentity: { claims: [], isAuthenticated: true },
        connectorFactory: { async create() { return connector; } }
      };
    },
    createConnectorFactory() {
      return { async create() { return connector; } };
    },
    async createUserTokenClient() { return {}; }
  };
  const testTeamsPlugin = {
    ...teamsChannelPlugin,
    createAdapter({ accountId, config, credential, credentials, onError }: any) {
      return new TeamsChannelAdapter({
        accountId,
        appPassword: credential,
        appId: credentials.appId,
        tenantId: credentials.tenantId,
        requireMention: config.requireMention,
        botFrameworkAuthentication,
        onError
      });
    }
  };
  await writeFile(join(stateDir, "config.json"), JSON.stringify({
    version: 1,
    defaultModel: "ci:teams-test-model",
    providers: {
      ci: {
        type: "openai-compatible",
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        apiKeyEnv: "ODINN_TEST_TEAMS_PROVIDER_KEY",
        models: ["teams-test-model"]
      }
    },
    channels: {
      work: {
        type: "teams",
        enabled: true,
        tokenEnv: "ODINN_TEST_TEAMS_APP_PASSWORD",
        appIdEnv: "ODINN_TEST_TEAMS_APP_ID",
        allowlist: ["teams:aad-user-1"],
        requireMention: false
      }
    }
  }));
  const server = await createGatewayServer({
    stateDir,
    workspaceRoot: root,
    requestMaxBytes: 2_048,
    async channelPluginLoader(type: string) {
      assert.equal(type, "teams");
      return testTeamsPlugin;
    }
  });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await new Promise((resolveWait) => setImmediate(resolveWait));
    const activity = {
      type: "message",
      id: "activity-1",
      timestamp: "2026-07-29T12:00:00.000Z",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      channelId: "msteams",
      text: "hello Odinn",
      from: { id: "teams-user-1", aadObjectId: "aad-user-1", name: "Jason" },
      recipient: { id: "teams-test-app", name: "Odinn" },
      conversation: { id: "teams-conversation-1" },
      channelData: { tenant: { id: "teams-tenant-1" } }
    };
    const accepted = await fetch(`${base}/channels/webhook/teams/work`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${signedToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(activity)
    });
    assert.equal(accepted.status, 200);
    assert.equal(authenticated.length, 1);
    assert.equal(authenticated[0].id, "activity-1");
    assert.equal(providerCalls, 1);
    assert.ok(
      outbound.some((message) => message.text === "ODINN_TEAMS_WEBHOOK_OK"),
      `expected Teams reply in outbound activities: ${JSON.stringify(outbound)}`
    );

    const oversized = await fetch(`${base}/channels/webhook/teams/work`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(2_049)
    });
    assert.equal(oversized.status, 413);
    assert.equal(authenticated.length, 1);
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
    await new Promise((resolve: any, reject: any) => provider.close((error: any) => error ? reject(error) : resolve()));
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("gateway permits capability inspection and revocation after the feature is disabled", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-capability-cleanup-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "odinn-gateway-capability-workspace-"));
  const enabledConfig = {
    version: 1,
    experimental: { capsules: false, capabilities: true, counterfactual: false }
  };
  await writeFile(join(stateDir, "config.json"), JSON.stringify(enabledConfig));
  let server = await createGatewayServer({ stateDir, workspaceRoot });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const issued = await postJson(`${base}/capabilities/issue`, {
      runId: "capability-cleanup-run",
      stepId: "capability-cleanup-step",
      toolName: "text.echo",
      scopes: ["text:echo"]
    });
    assert.ok(issued.claims.id);
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }

  await writeFile(join(stateDir, "config.json"), JSON.stringify({ ...enabledConfig, experimental: { ...enabledConfig.experimental, capabilities: false } }));
  server = await createGatewayServer({ stateDir, workspaceRoot });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const listed = await getJson(`${base}/capabilities/capability-cleanup-run`);
    assert.equal(listed.length, 1);
    const revoked = await postJson(`${base}/capabilities/${encodeURIComponent(listed[0].id)}/revoke`, {});
    assert.equal(revoked.status, "revoked");
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("gateway serves the local console shell", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-console-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /Odinn Forge Console/);
    assert.match(html, /Ódinn Forge/);
    assert.match(html, /odinn-logo\.png/);
    assert.match(html, /Work in one place/);
    assert.match(html, /Scheduled work/);
    assert.match(html, /Build reusable agents/);
    assert.match(html, /Build reusable workflows/);
    assert.doesNotMatch(html, /data-title="Instances"/);
    assert.doesNotMatch(html, /<h1>Run tools<\/h1>/);
    assert.match(html, /Memory/);
    assert.match(html, /Goals/);
    assert.match(html, /class="nav-labs"/);
    assert.match(html, /Automatic improvements/);
    for (const view of ["lab-run-checks", "lab-safety-preview", "lab-temporary-access", "lab-restore-points", "lab-portable-runs", "lab-scenario-compare", "lab-model-routing"]) {
      assert.match(html, new RegExp(`id="view-${view}"`));
    }
    assert.match(html, /availableWhenDisabled/);
    assert.match(html, /Projects/);
    assert.doesNotMatch(html, /Register Agent SDK manifest/);
    assert.match(html, /Agent SDK/);
    assert.match(html, /Skills SDK/);
    assert.match(html, /Searchable history/);
    assert.doesNotMatch(html, /Skill Workshop/);
    assert.match(html, /modelOverride/);
    assert.match(html, /allowedTools\?\.includes\("agent\.run"\) \? "agent\.run" : "model\.chat"/);
    assert.match(html, /provider \+ ":" \+ message\.model/);
    assert.match(html, /chat-empty/);
    assert.match(html, /data-chat-prompt/);
    assert.match(html, /composer-footer/);
    assert.match(html, /renderMarkdown/);
    assert.match(html, /\uE000ODINNCODE/);
    assert.doesNotMatch(html, /__ODINN_CODE_/);
    assert.match(html, /memory-tree/);
    assert.match(html, /memory-namespace/);
    assert.match(html, /Web tools/);
    assert.match(html, /web-search-run/);
    assert.match(html, /Gatewatch admission preview/);
    assert.match(html, /gatewatch-preview-run/);
    assert.match(html, /\/gatewatch\/preview/);
    assert.match(html, /id="browser-approval-mode"[^>]*>\s*Checking safeguards/);
    assert.match(html, /requireApproval/);
    assert.doesNotMatch(html, /catch \(error: any\)/);
    assert.match(html, /sidebar-collapsed/);
    assert.match(html, /data-session-action="rename"/);
    assert.match(html, /data-session-action="delete"/);
    assert.match(html, /method: "PATCH"/);
    const logo = await fetch("http://127.0.0.1:" + port + "/odinn-logo.png");
    assert.equal(logo.status, 200);
    assert.match(logo.headers.get("content-type"), /image\/png/);
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("gateway governed workspace routes support preview/apply and stale/conflict handling", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-governed-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "odinn-gateway-governed-workspace-"));
  await writeFile(join(stateDir, "config.json"), JSON.stringify({
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
  }, null, 2));
  await writeFile(join(workspaceRoot, "seed.txt"), "baseline");
  const server = await createGatewayServer({ stateDir, workspaceRoot });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const status = await getJson(`${base}/status`);
    assert.equal(status.tools.includes("workspace.mutate"), true);
    assert.equal(status.tools.includes("workspace.writeText"), false);
    const mutatePreviewToken = (await postJson(`${base}/capabilities/issue`, {
      runId: "governed-mutate-preview",
      stepId: "governed-mutate-preview-step",
      toolName: "workspace.mutate",
      scopes: ["workspace:mutate"]
    })).token;
    const mutateApplyToken = (await postJson(`${base}/capabilities/issue`, {
      runId: "governed-mutate-apply",
      stepId: "governed-mutate-apply-step",
      toolName: "workspace.mutate",
      scopes: ["workspace:mutate"]
    })).token;
    const restorePreviewToken = (await postJson(`${base}/capabilities/issue`, {
      runId: "governed-restore-preview",
      stepId: "governed-restore-preview-step",
      toolName: "restore.create",
      scopes: ["restore:create"]
    })).token;
    const restoreApplyToken = (await postJson(`${base}/capabilities/issue`, {
      runId: "governed-restore-apply",
      stepId: "governed-restore-apply-step",
      toolName: "restore.apply",
      scopes: ["restore:apply"]
    })).token;
    const patchPreviewToken = (await postJson(`${base}/capabilities/issue`, {
      runId: "governed-patch-preview",
      stepId: "governed-patch-preview-step",
      toolName: "workspace.patch",
      scopes: ["workspace:patch"]
    })).token;
    const patchApplyToken = (await postJson(`${base}/capabilities/issue`, {
      runId: "governed-patch-apply",
      stepId: "governed-patch-apply-step",
      toolName: "workspace.patch",
      scopes: ["workspace:patch"]
    })).token;

    const mutatePreview = await postJson(`${base}/governed/workspace/mutate`, {
      runId: "governed-mutate-preview",
      capabilityToken: mutatePreviewToken,
      operation: "write",
      path: "seed.txt",
      content: "candidate-preview"
    });
    assert.equal(mutatePreview.output?.preview, true);
    assert.equal(mutatePreview.output?.status, "ready");
    assert.notEqual(mutatePreview.output?.applied, true);

    const mutateApply = await postJson(`${base}/governed/workspace/mutate`, {
      runId: "governed-mutate-apply",
      capabilityToken: mutateApplyToken,
      operation: "write",
      path: "seed.txt",
      content: "candidate-applied",
      apply: true
    });
    assert.equal(mutateApply.output?.applied, true);
    assert.equal(mutateApply.output?.preview, false);
    const checkpointId = mutateApply.output?.checkpointId;
    assert.equal(typeof checkpointId, "string");

    const restorePreview = await postJson(`${base}/governed/restore/create`, {
      runId: "governed-restore-preview",
      capabilityToken: restorePreviewToken,
      checkpointId
    });
    assert.equal(restorePreview.output?.preview, true);
    assert.equal(restorePreview.output?.status, "ready");

    await writeFile(join(workspaceRoot, "seed.txt"), "externally changed");
    const restoreApply = await postJson(`${base}/governed/restore/apply`, {
      runId: "governed-restore-apply",
      capabilityToken: restoreApplyToken,
      checkpointId
    });
    assert.match(restoreApply.output?.status, /needs-review|conflict/);
    assert.equal(restoreApply.output?.applied, false);
    assert.equal(restoreApply.output?.preview, true);
    assert.equal(Array.isArray(restoreApply.output?.conflicts), true);
    assert.equal(restoreApply.output?.conflicts.length > 0, true);

    const patchPreview = await postJson(`${base}/governed/workspace/patch`, {
      runId: "governed-patch-preview",
      capabilityToken: patchPreviewToken,
      operation: "edit",
      path: "seed.txt",
      find: "externally",
      replace: "restored",
      apply: false
    });
    assert.equal(patchPreview.output?.preview, true);
    assert.equal(patchPreview.output?.status, "ready");

    const patchApply = await postJson(`${base}/governed/workspace/patch`, {
      runId: "governed-patch-apply",
      capabilityToken: patchApplyToken,
      operation: "edit",
      path: "seed.txt",
      find: "externally",
      replace: "restored",
      apply: true
    });
    assert.equal(patchApply.output?.preview, false);
    assert.equal(patchApply.output?.applied, true);
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("assistant Markdown images remain inert for every network-capable URL form", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-markdown-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
    const rendererStart = html.indexOf("function escapeHtml(value)");
    const rendererEnd = html.indexOf("\n    function compactPath", rendererStart);
    assert.ok(rendererStart >= 0 && rendererEnd > rendererStart, "console Markdown renderer source must be present");
    const renderer = runInNewContext(`${html.slice(rendererStart, rendererEnd)}\n({ renderMarkdown });`);
    const targets = [
      "https://attacker.example/pixel",
      "http://attacker.example/pixel",
      "/same-site-secret",
      "https://odinn.test/same-site-secret",
      "http://localhost:8080/private",
      "http://127.0.0.1:8080/private",
      "http://10.0.0.8/private",
      "http://172.16.0.8/private",
      "http://192.168.0.8/private",
      "https://user:password@attacker.example/pixel",
      "data:image/svg+xml;base64,PHN2Zy8+",
      "blob:https://odinn.test/00000000-0000-0000-0000-000000000000"
    ];
    for (const [index, target] of targets.entries()) {
      const rendered = renderer.renderMarkdown(`![private image ${index}](${target})`);
      assert.match(rendered, new RegExp(`\\[Image: private image ${index}\\]`), `alt text must survive for ${target}`);
      assert.doesNotMatch(rendered, /<(?:img|iframe|object|embed|script|link|video|audio|source)\b/iu, `requesting element survived for ${target}`);
      assert.doesNotMatch(rendered, /\b(?:src|srcset|href|poster|data)\s*=|url\s*\(/iu, `browser request primitive survived for ${target}`);
      assert.doesNotMatch(rendered, /(?:https?:|data:|blob:|\/same-site-secret)/iu, `image target survived for ${target}`);
    }
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("gateway backs cron, Agent SDK packages, skills, and workshop with persisted APIs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "odinn-console-data-"));
  const stateDir = join(workspace, ".odinn");
  await mkdir(join(workspace, "skills", "fixture"), { recursive: true });
  await writeFile(join(workspace, "skills", "fixture", "SKILL.md"), '---\nname: "fixture-skill"\ndescription: "Use for fixture validation work."\n---\n\n# Fixture\n');
  const server = await createGatewayServer({ stateDir, workspaceRoot: workspace });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cron = await postJson(`${base}/cron`, { name: "Health wake", schedule: "*/15 * * * *", timezone: "UTC", tool: "job.healthcheck", input: {} });
    assert.equal(cron.job.name, "Health wake");
    assert.equal((await getJson(`${base}/cron`)).jobs.length, 1);
    const missingTimezone = await fetch(`${base}/cron`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "No timezone", schedule: "* * * * *", tool: "text.echo", input: {} }) });
    assert.equal(missingTimezone.status, 400);
    const metadataTamper = await fetch(`${base}/cron/${encodeURIComponent(cron.job.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dispatchLease: { occurrenceKey: "forged" } }) });
    assert.equal(metadataTamper.status, 400);

    const initialAgents = await getJson(`${base}/agents`);
    assert.equal(initialAgents.sdkVersion, "1.0");
    assert.ok(initialAgents.agents.some((agent: any) => agent.id === "main" && agent.kind === "runtime" && agent.primary));
    await postJson(`${base}/agents/main/lifecycle`, { action: "disable" }, 409);
    await postJson(`${base}/agents`, { sdkVersion: "1.0", id: "main", version: "2.0.0", name: "Replacement" }, 409);

    const manifest = { sdkVersion: "0.3", id: "fixture-agent", version: "1.0.0", name: "Fixture Agent", tools: ["job.healthcheck"] };
    assert.equal((await postJson(`${base}/agents/validate`, manifest)).manifest.validation.valid, true);
    assert.equal((await postJson(`${base}/agents`, manifest)).agent.status, "disabled");
    assert.equal((await postJson(`${base}/agents/fixture-agent/lifecycle`, { action: "enable" })).agent.status, "enabled");

    const skills = await getJson(`${base}/skills`);
    assert.ok(skills.skills.some((skill: any) => skill.name === "fixture-skill"));
    const draft = { name: "draft-skill", description: "Use when a validated draft workflow is needed.", instructions: "## Workflow\n\n1. Inspect state.\n2. Execute a bounded action.\n3. Verify the evidence artifact." };
    assert.equal((await postJson(`${base}/skills/workshop/validate`, draft)).valid, true);
    assert.equal((await postJson(`${base}/skills/workshop/save`, draft)).status, "draft");
    assert.ok((await getJson(`${base}/skills`)).skills.some((skill: any) => skill.name === "draft-skill" && skill.status === "draft"));
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("gateway stops browser state changes for explicit approval", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-approvals-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const response = await postJson(`${base}/run`, {
      tool: "browser.click",
      input: { selector: "button#send", tabId: "tab_test", confirmed: true },
      actor: "user-approved",
      approvalId: "spoofed"
    });
    assert.equal(response.ok, true);
    assert.equal(response.output.type, "approval.required");
    assert.match(response.output.summary, /Click/);
    const typed = await postJson(`${base}/run`, {
      tool: "browser.type",
      input: { selector: "input#password", value: "must-never-enter-audit", tabId: "tab_test" }
    });
    assert.equal(typed.output.type, "approval.required");
    assert.doesNotMatch(typed.output.summary, /must-never-enter-audit/);
    const approvals = await getJson(`${base}/approvals`);
    assert.equal(approvals.length, 2);
    assert.doesNotMatch(JSON.stringify(approvals), /must-never-enter-audit/);
    const runs = await getJson(`${base}/runs`);
    assert.equal(runs[0].status, "awaiting_approval");
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("gateway approval POST restores and executes the exact volatile browser input", async (t: any) => {
  const chromiumPath = process.env.ODINN_CHROMIUM_PATH || "/usr/bin/chromium";
  try { await access(chromiumPath); } catch { t.skip(`Chromium not available at ${chromiumPath}`); return; }
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-sealed-approval-"));
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify({
    policy: { security: { browser: { allowPrivateNetwork: true } } }
  }, null, 2)}\n`, { mode: 0o600 });
  const sentinel = "SENTINEL_EXACT_APPROVED_VALUE_91f3";
  const fixture = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>before</title><input id="secretary"><script>
      const field = document.querySelector("#secretary");
      field.addEventListener("input", () => { document.title = field.value; });
    </script>`);
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixtureAddress = fixture.address();
  if (!fixtureAddress || typeof fixtureAddress === "string") throw new Error("browser fixture did not bind a TCP port");
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const opened = await postJson(`${base}/run`, { tool: "browser.open", input: { url: `http://127.0.0.1:${fixtureAddress.port}/` } });
    const requested = await postJson(`${base}/run`, {
      id: "sealed-browser-type",
      tool: "browser.type",
      input: {
        tabId: opened.output.id,
        snapshotId: opened.output.snapshotId,
        expectedUrl: opened.output.url,
        selector: "#secretary",
        value: sentinel
      }
    });
    assert.equal(requested.output.type, "approval.required");
    assert.doesNotMatch(await readFile(join(stateDir, "approvals.json"), "utf8"), new RegExp(sentinel));

    const approvedResponse = await fetch(`${base}/approvals/${requested.output.approvalId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    const approved = await approvedResponse.json();
    assert.equal(approvedResponse.status, 200);
    assert.equal(approved.output.type, "browser.action.completed");
    assert.equal(approved.output.title, sentinel);
    assert.deepEqual(JSON.parse(await readFile(join(stateDir, "approvals.json"), "utf8")).approvals, []);

    const snapshot = await postJson(`${base}/run`, { tool: "browser.snapshot", input: { tabId: opened.output.id } });
    const jobSentinel = "SENTINEL_APPROVED_JOB_VALUE_2b71";
    const jobResponse = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "sealed-browser-job" },
      body: JSON.stringify({ task: { tool: "browser.type", input: {
        tabId: opened.output.id,
        snapshotId: snapshot.output.snapshotId,
        expectedUrl: snapshot.output.url,
        selector: "#secretary",
        value: jobSentinel
      } } })
    });
    assert.equal(jobResponse.status, 202);
    let approvalJob: any;
    const approvalDeadline = Date.now() + 10_000;
    while (Date.now() < approvalDeadline) {
      approvalJob = await (await fetch(`${base}/jobs/sealed-browser-job`)).json();
      if (approvalJob.status === "awaiting-approval") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(approvalJob.status, "awaiting-approval");
    const jobApproval = (await getJson(`${base}/approvals`)).find((approval: any) => approval.runId === approvalJob.id);
    assert.ok(jobApproval?.id);
    const jobApprovalResponse = await fetch(`${base}/approvals/${jobApproval.id}/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    assert.equal(jobApprovalResponse.status, 200);
    assert.equal((await jobApprovalResponse.json()).output.title, jobSentinel);
    const completionDeadline = Date.now() + 10_000;
    while (Date.now() < completionDeadline) {
      approvalJob = await (await fetch(`${base}/jobs/sealed-browser-job`)).json();
      if (approvalJob.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(approvalJob.status, "completed");
    assert.equal(approvalJob.result.output.title, jobSentinel);
    const jobLedger = createRunLedger({ stateDir, workspaceRoot: root });
    assert.equal(jobLedger.getExecutionAttempt(approvalJob.executionAttemptId)?.state, "completed");
    jobLedger.close();
  } finally {
    await new Promise((resolve: any) => server.close(() => resolve()));
    await new Promise((resolve: any) => fixture.close(() => resolve()));
  }
});

test("gateway reuses one browser worker across sequential browser tasks", async (t: any) => {
  const chromiumPath = process.env.ODINN_CHROMIUM_PATH || "/usr/bin/chromium";
  try {
    await access(chromiumPath);
  } catch {
    t.skip(`Chromium not available at ${chromiumPath}`);
    return;
  }
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-browser-worker-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const tabs = await postJson(`${base}/run`, { tool: "browser.tabs", input: {} });
    assert.equal(tabs.ok, true);
    assert.ok(tabs.output.tabs.length >= 1);
    const snapshot = await postJson(`${base}/run`, {
      tool: "browser.snapshot",
      input: { tabId: tabs.output.tabs[0].id }
    });
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.output.id, tabs.output.tabs[0].id);
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("gateway closes and reopens the persistent browser profile cleanly", async (t: any) => {
  const chromiumPath = process.env.ODINN_CHROMIUM_PATH || "/usr/bin/chromium";
  try {
    await access(chromiumPath);
  } catch {
    t.skip(`Chromium not available at ${chromiumPath}`);
    return;
  }
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-browser-restart-"));
  const first = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve: any) => first.listen(0, "127.0.0.1", resolve));
  const firstBase = `http://127.0.0.1:${first.address().port}`;
  let stableTabId;
  try {
    const opened = await postJson(`${firstBase}/run`, { tool: "browser.open", input: { url: "https://example.com" } });
    assert.equal(opened.ok, true);
    stableTabId = opened.output.id;
  } finally {
    await new Promise((resolve: any, reject: any) => first.close((error: any) => error ? reject(error) : resolve()));
  }

  const second = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve: any) => second.listen(0, "127.0.0.1", resolve));
  const secondBase = `http://127.0.0.1:${second.address().port}`;
  try {
    const tabs = await postJson(`${secondBase}/run`, { tool: "browser.tabs", input: {} });
    assert.equal(tabs.ok, true);
    const snapshot = await postJson(`${secondBase}/run`, {
      tool: "browser.snapshot",
      input: { tabId: stableTabId }
    });
    assert.equal(snapshot.ok, true);
  } finally {
    await new Promise((resolve: any, reject: any) => second.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("gateway blocks retries after an uncertain browser mutation until recovery is resolved", async (t: any) => {
  const chromiumPath = process.env.ODINN_CHROMIUM_PATH || "/usr/bin/chromium";
  try { await access(chromiumPath); } catch { t.skip(`Chromium not available at ${chromiumPath}`); return; }
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-browser-recovery-"));
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify({
    policy: { security: { browser: { allowPrivateNetwork: true } } }
  }, null, 2)}\n`, { mode: 0o600 });
  const fixture = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Browser recovery fixture</title><main>Stable fixture</main>");
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixtureAddress = fixture.address();
  if (!fixtureAddress || typeof fixtureAddress === "string") throw new Error("browser fixture did not bind a TCP port");
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const opened = await postJson(`${base}/run`, { tool: "browser.open", input: { url: `http://127.0.0.1:${fixtureAddress.port}/` } });
    const requested = await postJson(`${base}/run`, { tool: "browser.click", input: { tabId: opened.output.id, snapshotId: opened.output.snapshotId, selector: "#definitely-missing" } });
    const failedResponse = await fetch(`${base}/approvals/${requested.output.approvalId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const failed = await failedResponse.json();
    assert.equal(failedResponse.status, 400);
    assert.match(failed.error, /outcome is unknown/);
    assert.equal(failed.category, "browser-recovery");
    assert.match(failed.nextAction, /recovery/);
    const status = await postJson(`${base}/run`, { tool: "browser.recovery.status", input: {} });
    assert.equal(status.output.recovery.status, "unknown");
    const spoofed = await postJson(`${base}/run`, { tool: "browser.press", input: { tabId: opened.output.id, key: "Escape", confirmed: true } });
    assert.equal(spoofed.output.type, "approval.required");
    const blockedResponse = await fetch(`${base}/approvals/${spoofed.output.approvalId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const blocked = await blockedResponse.json();
    assert.equal(blockedResponse.status, 400);
    assert.match(blocked.error, /uncertain outcome/);
    assert.equal(blocked.category, "browser-recovery");
    const resolved = await postJson(`${base}/run`, { tool: "browser.recovery.resolve", input: { outcome: "not-applied", note: "missing selector did not mutate the page" } });
    assert.equal(resolved.output.recovery.status, "resolved");
  } finally {
    await new Promise((resolve: any) => server.close(() => resolve()));
    await new Promise((resolve: any) => fixture.close(() => resolve()));
  }
});

test("gateway rejects invalid and oversized JSON bodies", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-limits-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root, requestMaxBytes: 32 });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const invalid = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    assert.equal(invalid.status, 400);
    const invalidBody = await invalid.json();
    assert.match(invalidBody.error, /valid JSON/);
    assert.equal(invalidBody.category, "validation");

    const oversized = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "text.echo", input: { text: "x".repeat(200) } })
    });
    assert.equal(oversized.status, 413);
    const oversizedBody = await oversized.json();
    assert.match(oversizedBody.error, /exceeds 32 bytes/);
    assert.equal(oversizedBody.category, "validation");
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("gateway can replay a persisted task with a new id", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-replay-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const original = await postJson(`${base}/run`, { id: "run_replay_source", tool: "text.echo", input: { text: "replay me" } });
    assert.equal(original.output.text, "replay me");
    const replay = await fetch(`${base}/runs/run_replay_source/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "run_replay_copy" })
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).output.text, "replay me");
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("gateway exposes memory remember, search, correction, curation, and forgetting", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-memory-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const stored = await postJson(`${base}/memory`, {
      kind: "project",
      subject: "memory",
      text: "Memory records must preserve provenance.",
      tags: ["memory", "provenance"],
      source: "gateway-test"
    });
    assert.equal(stored.kind, "project");

    const found = await getJson(`${base}/memory?query=provenance`);
    assert.equal(found.memories[0].id, stored.id);

    const recalled = await getJson(`${base}/memory/recall?query=preserve%20provenance`);
    assert.equal(recalled.memories[0].id, stored.id);

    const browsed = await getJson(`${base}/memory/browse?namespace=project`);
    assert.ok(browsed.namespaces.some((entry: any) => entry.namespace === "project/memory"));

    const corrected = await postJson(`${base}/memory/corrections`, {
      targetId: stored.id,
      text: "Memory records must preserve provenance and supersession.",
      reason: "added supersession"
    });
    assert.equal(corrected.supersedes, stored.id);

    const curated = await getJson(`${base}/memory/curated`);
    assert.equal(curated.count, 1);
    assert.equal(curated.kinds.correction[0].text, "Memory records must preserve provenance and supersession.");

    const suggested = await postJson(`${base}/run`, {
      tool: "memory.suggest",
      input: { kind: "preference", subject: "user", text: "Prefer concise release summaries.", scopeType: "global" }
    });
    assert.equal(suggested.output.status, "pending");
    const candidates = await getJson(`${base}/memory/candidates?status=pending`);
    assert.equal(candidates.count, 1);
    assert.equal(candidates.candidates[0].id, suggested.output.id);
    const accepted = await postJson(`${base}/memory/candidates/${encodeURIComponent(suggested.output.id)}/decision`, { decision: "accepted" });
    assert.equal(accepted.candidate.status, "accepted");
    assert.equal(accepted.memory.authority, "user-curated");
    const pendingAfterDecision = await getJson(`${base}/memory/candidates?status=pending`);
    assert.equal(pendingAfterDecision.count, 0);

    const forgotten = await postJson(`${base}/memory/${encodeURIComponent(corrected.id)}/forget`, {});
    assert.equal(forgotten.forgotten, true);
    const afterForget = await getJson(`${base}/memory?query=provenance`);
    assert.deepEqual(afterForget.memories, []);
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("gateway exposes sessions, goals, and improvement proposals", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-records-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const session = await postJson(`${base}/sessions`, { title: "Gateway session" });
    assert.equal(session.type, "session.created");

    const message = await postJson(`${base}/sessions/${encodeURIComponent(session.id)}/messages`, {
      role: "user",
      content: "Track this.",
      provider: "openai",
      model: "gpt-5.5"
    });
    assert.equal(message.type, "message.appended");

    const sessionDetail = await getJson(`${base}/sessions/${encodeURIComponent(session.id)}`);
    assert.equal(sessionDetail.session.messageCount, 1);
    assert.equal(sessionDetail.messages[0].content, "Track this.");
    assert.equal(sessionDetail.messages[0].provider, "openai");
    assert.equal(sessionDetail.messages[0].model, "gpt-5.5");

    const renamedResponse = await fetch(`${base}/sessions/${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed gateway chat" })
    });
    assert.equal(renamedResponse.status, 200);
    const renamed = await renamedResponse.json();
    assert.equal(renamed.type, "session.updated");
    assert.equal(renamed.session.title, "Renamed gateway chat");
    assert.equal((await getJson(`${base}/sessions/${encodeURIComponent(session.id)}`)).session.title, "Renamed gateway chat");

    const deletedResponse = await fetch(`${base}/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
    assert.equal(deletedResponse.status, 200);
    assert.equal((await deletedResponse.json()).type, "session.deleted");
    const sessions = await getJson(`${base}/sessions`);
    assert.equal(sessions.sessions.some((entry: any) => entry.id === session.id), false);

    const goal = await postJson(`${base}/goals`, { title: "Reach launch" });
    assert.equal(goal.type, "goal.created");

    const update = await postJson(`${base}/goals/${encodeURIComponent(goal.id)}/updates`, {
      status: "blocked",
      note: "Needs release proof."
    });
    assert.equal(update.type, "goal.updated");

    const goals = await getJson(`${base}/goals`);
    assert.equal(goals.goals[0].status, "blocked");

    const improvement = await postJson(`${base}/improvements`, {
      title: "Add install smoke",
      rationale: "The installed command path needs proof."
    });
    assert.equal(improvement.type, "improvement.proposed");

    const decision = await postJson(`${base}/improvements/${encodeURIComponent(improvement.id)}/decisions`, {
      decision: "approved",
      note: "Safe next step."
    });
    assert.equal(decision.type, "improvement.approved");

    const improvements = await getJson(`${base}/improvements`);
    assert.equal(improvements.improvements[0].status, "approved");
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("gateway exposes the experimental runtime against persisted SQLite state", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-runtime-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "odinn-gateway-workspace-"));
  const attackerRoot = await mkdtemp(join(tmpdir(), "odinn-gateway-attacker-root-"));
  await writeFile(join(workspaceRoot, "fixture.txt"), "before\n");
  await writeFile(join(stateDir, "config.json"), JSON.stringify({
    version: 1,
    experimental: { capsules: true, capabilities: true, counterfactual: true }
  }));
  const server = await createGatewayServer({ stateDir, workspaceRoot });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const status = await getJson(`${base}/status`);
    assert.deepEqual(status.coreAdvanced, ["proof", "sentinel", "rewind", "darwin"]);
    assert.equal(status.experimental.capabilities, true);

    const issued = await postJson(`${base}/capabilities/issue`, {
      runId: "gateway-runtime-run",
      stepId: "step-gateway-runtime",
      toolName: "text.echo",
      scopes: ["text:echo"]
    });
    assert.equal(issued.claims.toolName, "text.echo");
    assert.ok(issued.token);

    const run = await postJson(`${base}/run`, {
      id: "gateway-runtime-run",
      tool: "text.echo",
      input: { text: "gateway runtime proof", capabilityToken: issued.token }
    });
    assert.equal(run.output.text, "gateway runtime proof");

    const timeline = await getJson(`${base}/runtime/runs/gateway-runtime-run`);
    assert.equal(timeline.status, "completed-unverified");
    assert.ok(timeline.events.some((event: any) => event.type === "capability-consumed"));
    assert.equal(JSON.stringify(timeline).includes(issued.token), false);
    assert.equal((await getJson(`${base}/runtime/runs/gateway-runtime-run/verify`)).valid, true);

    const proof = await postJson(`${base}/proof`, {
      schemaVersion: 1,
      id: "gateway-runtime-proof",
      runId: "gateway-runtime-run",
      assertions: [{ id: "fixture", type: "file", path: "fixture.txt", expect: { exists: true, content: { contains: "before" } } }]
    });
    assert.equal(proof.status, "passed");
    assert.deepEqual(proof.assertions[0].actual.content, { retained: false, bytes: 7 });
    assert.equal((await getJson(`${base}/proof/gateway-runtime-run`)).assertions.length, 1);

    const legacyProof = await fetch(`${base}/proof`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "gateway-runtime-run", workspaceRoot: attackerRoot, contract: { version: 1, acceptance: [{ id: "command", type: "command", command: "node", args: ["-e", "process.exit(0)"] }] } })
    });
    assert.equal(legacyProof.status, 400);

    const checkpoint = await postJson(`${base}/checkpoints`, {
      runId: "gateway-runtime-run",
      stepId: "step-gateway-checkpoint",
      paths: ["fixture.txt"],
      label: "before-change",
      workspaceRoot: attackerRoot
    });
    await writeFile(join(workspaceRoot, "fixture.txt"), "after\n");
    const preview = await postJson(`${base}/rewind/${encodeURIComponent(checkpoint.snapshotId)}`, {});
    assert.equal(preview.applied, false);
    const restored = await postJson(`${base}/rewind/${encodeURIComponent(checkpoint.snapshotId)}`, { apply: true });
    assert.equal(restored.applied, true);
    assert.equal(await readFile(join(workspaceRoot, "fixture.txt"), "utf8"), "before\n");

    const policyResult = await postJson(`${base}/policy/evaluate`, {
      runId: "gateway-runtime-run",
      toolName: "text.echo",
      input: { text: "safe" },
      policy: { version: 1, invariants: [{ id: "allow-safe", type: "command.deny-pattern", values: ["never-match"], enforcement: "block" }] }
    });
    assert.equal(policyResult.allowed, true);
    const capsule = await postJson(`${base}/capsules/export`, { runId: "gateway-runtime-run" });
    const verifiedCapsule = await postJson(`${base}/capsules/verify`, { path: capsule.path });
    assert.equal(verifiedCapsule.valid, true);
    assert.ok(verifiedCapsule.entries.includes("contract.json"));
    assert.ok(verifiedCapsule.entries.includes("policy.json"));
    assert.ok(verifiedCapsule.entries.some((entry: any) => entry.startsWith("artifacts/")));

    const observed = await postJson(`${base}/routing/observe`, {
      runId: "gateway-runtime-run", providerId: "test", modelId: "verified", taskClass: "general", verified: true, durationMs: 10
    });
    assert.equal(observed.modelId, "verified");
    const choice = await postJson(`${base}/routing/choose`, { taskClass: "general" });
    assert.equal(choice.model, "test:verified");
    assert.match(choice.runId, /^routing-/);
    const routingTimeline = await getJson(`${base}/runtime/runs/${choice.runId}`);
    assert.ok(routingTimeline.events.some((event: any) => event.type === "model-routing-decision" && event.payload.model === "test:verified"));

    await writeFile(join(workspaceRoot, "branch-evidence.txt"), "candidate-only evidence\n");
    const branch = await postJson(`${base}/counterfactual`, {
      sourceRunId: "gateway-runtime-run",
      sourceStepId: timeline.steps[0].id,
      workspaceRoot: attackerRoot,
      plans: [{
        id: "a",
        title: "A",
        summary: "candidate A",
        tasks: [{ tool: "workspace.readText", input: { path: "branch-evidence.txt" }, readOnly: true }],
        contract: {
          schemaVersion: 1,
          id: "gateway-candidate-contract",
          assertions: [{ id: "branch-evidence", type: "file", path: "branch-evidence.txt", expect: { exists: true, content: { contains: "candidate-only" } } }]
        }
      }, {
        id: "b",
        title: "B",
        summary: "candidate B",
        tasks: [{ tool: "text.echo", input: { text: "candidate B" }, readOnly: true }]
      }]
    });
    assert.equal(branch.candidates.length, 2);
    assert.ok(branch.candidates.every((candidate: any) => candidate.workspaceRoot.startsWith(`${join(workspaceRoot, ".odinn-worktrees")}${sep}`)));
    assert.equal((await getJson(`${base}/counterfactual/${branch.groupId}`)).candidates.length, 2);
    await rm(join(workspaceRoot, "branch-evidence.txt"));
    const executed = await postJson(`${base}/counterfactual/${branch.groupId}/execute`, {});
    const verifiedCandidate = executed.results.find((result: any) => result.planId === "a");
    assert.equal(verifiedCandidate.status, "verified");
    assert.equal(verifiedCandidate.proof.status, "passed");
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("gateway entrypoint resolves filtered pnpm workspace root from the invocation root", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-entrypoint-"));
  const port = await openPort();
  const child = spawn("node", ["src/server.ts"], {
    cwd: join(root, "apps/gateway"),
    env: {
      ...process.env,
      INIT_CWD: root,
      ODINN_PORT: String(port),
      ODINN_STATE_DIR: stateDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForStatus(`${base}/status`);
    const plan = await postJson(`${base}/plan`, {
      id: "plan_gateway_entrypoint",
      name: "gateway-entrypoint-plan",
      steps: [{ id: "health", tool: "job.healthcheck" }]
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.steps[0].result.output.workspaceRoot, normalizedRoot);
  } finally {
    child.kill();
    await new Promise((resolve: any) => child.once("close", resolve));
  }
});

async function getJson(url: any) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}

async function postJson(url: any, body: any, expectedStatus = 200) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, expectedStatus);
  return response.json();
}

async function waitForStatus(url: any) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await getJson(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve: any) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

async function openPort() {
  const server = createTcpServer();
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  return port;
}
