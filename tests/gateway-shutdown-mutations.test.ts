import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayServer } from "../apps/gateway/src/server.ts";
import { withGatewayTestHooks } from "../apps/gateway/src/testing.ts";
import { createAuditStore, createRunLedger, sourceAuthDigest, SqliteRecordStore, workflowDefinitionFromSteps } from "../packages/kernel/src/index.ts";

type Deferred = { promise: Promise<void>; resolve(): void };
type PreparedShutdownRequest = { path?: string; body?: unknown };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function readJsonIfPresent(path: string): Promise<any | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function listen(server: any): Promise<string> {
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("gateway did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function postJson(base: string, path: string, body: unknown, expectedStatus = 200): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "connection": "close", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(payload));
  return payload;
}

async function runShutdownFence({
  root,
  surface,
  path,
  body,
  config,
  channelPluginLoader,
  prepare,
  afterLock = false,
  verify
}: {
  root: string;
  surface: string;
  path: string;
  body: unknown;
  config?: Record<string, unknown>;
  channelPluginLoader?: (type: string) => Promise<any>;
  prepare?: (base: string) => Promise<PreparedShutdownRequest | void>;
  afterLock?: boolean;
  verify(): Promise<void>;
}): Promise<void> {
  const stateDir = join(root, "state");
  await mkdir(stateDir, { recursive: true });
  if (config) await writeFile(join(stateDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const entered = deferred();
  const release = deferred();
  const pause = async ({ surface: observed }: { surface: string }) => {
    if (observed !== surface) return;
    entered.resolve();
    await release.promise;
  };
  const options = withGatewayTestHooks({
    stateDir,
    workspaceRoot: root,
    ...(channelPluginLoader ? { channelPluginLoader } : {})
  }, {
    shutdownTimeoutMs: 500,
    ...(afterLock
      ? { afterControlPlaneMutationLockAcquired: pause }
      : { beforeControlPlaneMutationCommit: pause })
  });
  const server: any = await createGatewayServer(options);
  try {
    const base = await listen(server);
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    const prepared = await prepare?.(base) ?? {};
    const request = fetch(`${base}${prepared.path ?? path}`, {
      method: "POST",
      headers: { "connection": "close", "content-type": "application/json" },
      body: JSON.stringify(prepared.body ?? body)
    }).then(async (response) => {
      await response.arrayBuffer();
      return response.status;
    }).catch(() => 0);
    await entered.promise;
    const closed = new Promise<Error | undefined>((resolveClose) => server.close((error?: Error) => resolveClose(error)));
    release.resolve();
    const [status, closeError] = await Promise.all([request, closed]);
    assert.ok(status === 0 || status === 503, `${surface} returned ${status} after shutdown admission closed`);
    assert.equal(closeError, undefined, `${surface} did not drain before the bounded shutdown deadline`);
    await verify();
  } finally {
    release.resolve();
    if (server.listening) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

test("Gateway shutdown fences lock-held cron, agent, skill, and draft mutations", async () => {
  const previousAuth = process.env.ODINN_GATEWAY_AUTH;
  process.env.ODINN_GATEWAY_AUTH = "off";
  const roots: string[] = [];
  try {
    const cronRoot = await mkdtemp(join(tmpdir(), "odinn-shutdown-cron-lock-"));
    roots.push(cronRoot);
    await runShutdownFence({
      root: cronRoot,
      surface: "cron.create",
      path: "/cron",
      body: { id: "must-not-exist", name: "Must not exist", schedule: "*/15 * * * *", timezone: "UTC", tool: "text.echo", input: { text: "ignored" } },
      afterLock: true,
      async verify() {
        const state = await readJsonIfPresent(join(cronRoot, "state", "cron-jobs.json"));
        assert.equal(state?.jobs?.some((entry: any) => entry.id === "must-not-exist") ?? false, false);
      }
    });

    const agentRoot = await mkdtemp(join(tmpdir(), "odinn-shutdown-agent-lock-"));
    roots.push(agentRoot);
    await runShutdownFence({
      root: agentRoot,
      surface: "agent.install",
      path: "/agents",
      body: { sdkVersion: "0.3", id: "must-not-exist", version: "1.0.0", name: "Must Not Exist", tools: ["text.echo"] },
      afterLock: true,
      async verify() {
        const state = await readJsonIfPresent(join(agentRoot, "state", "agents.json"));
        assert.equal(state?.agents?.some((entry: any) => entry.id === "must-not-exist") ?? false, false);
      }
    });

    const skillRoot = await mkdtemp(join(tmpdir(), "odinn-shutdown-skill-lock-"));
    roots.push(skillRoot);
    await runShutdownFence({
      root: skillRoot,
      surface: "skill.create",
      path: "/skills",
      config: {
        version: 1,
        runtime: { enableSkillLifecycle: true },
        policy: { allowedCapabilities: ["skill.manage"] }
      },
      body: {
        sdkVersion: "0.1",
        id: "must-not-exist",
        version: "1.0.0",
        name: "Must Not Exist",
        description: "Use only for the shutdown mutation regression.",
        instructions: "Inspect the fixture, perform no external effects, and return a bounded verified result.",
        requestedTools: [],
        requestedCapabilities: [],
        requestedSecrets: [],
        network: { default: "deny", allow: [] },
        tests: []
      },
      afterLock: true,
      async verify() {
        const state = await readJsonIfPresent(join(skillRoot, "state", "skills", "registry.json"));
        assert.equal(state?.packages?.some((entry: any) => entry.id === "must-not-exist") ?? false, false);
      }
    });

    const draftRoot = await mkdtemp(join(tmpdir(), "odinn-shutdown-draft-lock-"));
    roots.push(draftRoot);
    await runShutdownFence({
      root: draftRoot,
      surface: "skill.draft",
      path: "/skills/workshop/save",
      config: {
        version: 1,
        runtime: { enableSkillLifecycle: true },
        policy: { allowedCapabilities: ["skill.manage"] }
      },
      body: {
        name: "must-not-exist",
        description: "Use only for the shutdown mutation regression.",
        instructions: "Inspect the fixture, perform no external effects, and return a bounded verified result."
      },
      afterLock: true,
      async verify() {
        await assert.rejects(
          readFile(join(draftRoot, "state", "skill-workshop", "must-not-exist", "SKILL.md"), "utf8"),
          (error: any) => error?.code === "ENOENT"
        );
      }
    });
  } finally {
    if (previousAuth === undefined) delete process.env.ODINN_GATEWAY_AUTH;
    else process.env.ODINN_GATEWAY_AUTH = previousAuth;
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("Gateway shutdown fences lock-held agent transitions and approved skill enablement", async () => {
  const previousAuth = process.env.ODINN_GATEWAY_AUTH;
  process.env.ODINN_GATEWAY_AUTH = "off";
  const roots: string[] = [];
  try {
    const agentRoot = await mkdtemp(join(tmpdir(), "odinn-shutdown-agent-transition-lock-"));
    roots.push(agentRoot);
    await runShutdownFence({
      root: agentRoot,
      surface: "agent.lifecycle",
      path: "/agents/must-remain-disabled/lifecycle",
      body: { action: "enable" },
      afterLock: true,
      async prepare(base) {
        const installed = await postJson(base, "/agents", {
          sdkVersion: "0.3",
          id: "must-remain-disabled",
          version: "1.0.0",
          name: "Must Remain Disabled",
          tools: ["text.echo"]
        });
        assert.equal(installed.agent.status, "disabled");
      },
      async verify() {
        const state = await readJsonIfPresent(join(agentRoot, "state", "agents.json"));
        const agent = state?.agents?.find((entry: any) => entry.id === "must-remain-disabled");
        assert.equal(agent?.status, "disabled");
      }
    });

    const skillRoot = await mkdtemp(join(tmpdir(), "odinn-shutdown-approved-skill-lock-"));
    roots.push(skillRoot);
    await runShutdownFence({
      root: skillRoot,
      surface: "skill.approved-enable",
      path: "/approvals/placeholder/approve",
      config: {
        version: 1,
        runtime: { enableSkillLifecycle: true },
        policy: { allowedCapabilities: ["skill.manage"] }
      },
      body: {},
      afterLock: true,
      async prepare(base) {
        const created = await postJson(base, "/skills", {
          sdkVersion: "0.1",
          id: "must-remain-disabled",
          version: "1.0.0",
          name: "Must Remain Disabled",
          description: "Use only for the approved shutdown regression.",
          instructions: "Inspect the fixture, perform no external effects, and return a bounded verified result.",
          requestedTools: [],
          requestedCapabilities: [],
          requestedSecrets: [],
          network: { default: "deny", allow: [] },
          tests: []
        });
        assert.equal(created.skill.status, "disabled");
        const approval = await postJson(base, "/skills/must-remain-disabled/lifecycle", {
          action: "enable",
          version: created.skill.version,
          integrity: created.skill.integrity
        }, 202);
        assert.equal(approval.skill.type, "approval.required");
        return { path: `/approvals/${encodeURIComponent(approval.skill.approvalId)}/approve`, body: {} };
      },
      async verify() {
        const state = await readJsonIfPresent(join(skillRoot, "state", "skills", "registry.json"));
        const skill = state?.packages?.find((entry: any) => entry.id === "must-remain-disabled");
        assert.equal(skill?.status, "disabled");
        assert.equal(skill?.trusted, false);
      }
    });
  } finally {
    if (previousAuth === undefined) delete process.env.ODINN_GATEWAY_AUTH;
    else process.env.ODINN_GATEWAY_AUTH = previousAuth;
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("Gateway shutdown fences workflow and event commits after request admission", async () => {
  const previousAuth = process.env.ODINN_GATEWAY_AUTH;
  process.env.ODINN_GATEWAY_AUTH = "off";
  const roots: string[] = [];
  try {
    const workflowRoot = await mkdtemp(join(tmpdir(), "odinn-shutdown-workflow-"));
    roots.push(workflowRoot);
    const definition = workflowDefinitionFromSteps({
      id: "shutdown.workflow",
      name: "Shutdown workflow",
      steps: [{ id: "only", actionRef: "text.echo", input: { text: "must not execute" } }]
    });
    await runShutdownFence({
      root: workflowRoot,
      surface: "workflow.submit",
      path: "/workflows",
      config: { version: 1, runtime: { enableDurableWorkflows: true } },
      body: { runId: "must-not-exist", idempotencyKey: "must-not-exist", definition, input: {} },
      async verify() {
        const ledger = createRunLedger({ stateDir: join(workflowRoot, "state"), workspaceRoot: workflowRoot });
        try {
          const row = ledger.database.db.prepare("SELECT count(*) AS count FROM workflow_runs WHERE run_id=?").get("must-not-exist") as { count: number };
          assert.equal(Number(row.count), 0);
        } finally { ledger.close(); }
      }
    });

    const eventRoot = await mkdtemp(join(tmpdir(), "odinn-shutdown-event-"));
    roots.push(eventRoot);
    await runShutdownFence({
      root: eventRoot,
      surface: "event.source",
      path: "/event-sources",
      config: { version: 1, runtime: { enableEventIngress: true } },
      body: { source: "must-not-exist", authDigest: sourceAuthDigest("shutdown-fixture-secret") },
      async verify() {
        const ledger = createRunLedger({ stateDir: join(eventRoot, "state"), workspaceRoot: eventRoot });
        try {
          const row = ledger.database.db.prepare("SELECT count(*) AS count FROM event_sources WHERE source=?").get("must-not-exist") as { count: number };
          assert.equal(Number(row.count), 0);
        } finally { ledger.close(); }
      }
    });
  } finally {
    if (previousAuth === undefined) delete process.env.ODINN_GATEWAY_AUTH;
    else process.env.ODINN_GATEWAY_AUTH = previousAuth;
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("Gateway shutdown fences direct control-plane mutations before synchronous commit", async () => {
  const previousAuth = process.env.ODINN_GATEWAY_AUTH;
  process.env.ODINN_GATEWAY_AUTH = "off";
  const root = await mkdtemp(join(tmpdir(), "odinn-shutdown-direct-mutation-"));
  try {
    await runShutdownFence({
      root,
      surface: "policy.evaluate",
      path: "/policy/evaluate",
      body: {
        runId: "must-not-exist",
        toolName: "text.echo",
        input: { text: "must not be evaluated" },
        policy: {
          version: 1,
          invariants: [{ id: "allow-safe", type: "command.deny-pattern", values: ["never-match"], enforcement: "block" }]
        }
      },
      async verify() {
        const ledger = createRunLedger({ stateDir: join(root, "state"), workspaceRoot: root });
        try { assert.equal(ledger.hasRun("must-not-exist"), false); }
        finally { ledger.close(); }
      }
    });
  } finally {
    if (previousAuth === undefined) delete process.env.ODINN_GATEWAY_AUTH;
    else process.env.ODINN_GATEWAY_AUTH = previousAuth;
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway shutdown aborts a stalled loopback Proof assertion without post-barrier settlement", async () => {
  const previousAuth = process.env.ODINN_GATEWAY_AUTH;
  process.env.ODINN_GATEWAY_AUTH = "off";
  const root = await mkdtemp(join(tmpdir(), "odinn-shutdown-proof-http-"));
  const stateDir = join(root, "state");
  const runId = "proof-must-remain-unsettled";
  const contractId = "proof_stalled_during_shutdown";
  const assertionEntered = deferred();
  const assertionServer: any = createHttpServer(() => { assertionEntered.resolve(); });
  let gateway: any;
  try {
    await mkdir(stateDir, { recursive: true });
    const setupLedger = createRunLedger({ stateDir, workspaceRoot: root });
    setupLedger.ensureRun({ runId, objective: "remain unsettled across the shutdown barrier" });
    const statusBefore = setupLedger.getRun(runId).status;
    setupLedger.close();

    const assertionBase = await listen(assertionServer);
    gateway = await createGatewayServer(withGatewayTestHooks({ stateDir, workspaceRoot: root }, { shutdownTimeoutMs: 1_500 }));
    const gatewayBase = await listen(gateway);
    const request = fetch(`${gatewayBase}/proof`, {
      method: "POST",
      headers: { "connection": "close", "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        id: contractId,
        runId,
        assertions: [{
          id: "stalled-loopback",
          type: "http",
          url: `${assertionBase}/never-settles`,
          timeoutMs: 30_000,
          expect: { status: 200 }
        }]
      })
    }).then(async (response) => {
      await response.arrayBuffer();
      return response.status;
    }).catch(() => 0);

    await assertionEntered.promise;
    const closed = new Promise<Error | undefined>((resolveClose) => gateway.close((error?: Error) => resolveClose(error)));
    const [status, closeError] = await Promise.all([request, closed]);
    assert.ok(status === 0 || status === 503, `Proof returned ${status} after shutdown admission closed`);
    assert.equal(closeError, undefined);

    const ledger = createRunLedger({ stateDir, workspaceRoot: root });
    try {
      assert.equal(ledger.database.db.prepare("SELECT COUNT(*) AS count FROM verification_contracts WHERE id = ?").get(contractId).count, 1);
      assert.equal(ledger.database.db.prepare("SELECT COUNT(*) AS count FROM assertion_results WHERE contract_id = ?").get(contractId).count, 0);
      assert.equal(ledger.getRun(runId).status, statusBefore);
      const proofEvents = ledger.getRun(runId).events.filter((event: any) => event.type.startsWith("verification") || event.type === "assertion-result");
      assert.deepEqual(proofEvents.map((event: any) => event.type), ["verification-started"]);
      assert.equal(ledger.database.db.prepare("SELECT COUNT(*) AS count FROM artifacts").get().count, 1);
    } finally {
      ledger.close();
    }
  } finally {
    assertionServer.closeAllConnections?.();
    if (assertionServer.listening) await new Promise<void>((resolveClose) => assertionServer.close(() => resolveClose()));
    if (gateway?.listening) await new Promise<void>((resolveClose) => gateway.close(() => resolveClose()));
    if (previousAuth === undefined) delete process.env.ODINN_GATEWAY_AUTH;
    else process.env.ODINN_GATEWAY_AUTH = previousAuth;
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway shutdown aborts a stalled automatic improvement before durable or config effects", async () => {
  const previousAuth = process.env.ODINN_GATEWAY_AUTH;
  process.env.ODINN_GATEWAY_AUTH = "off";
  const root = await mkdtemp(join(tmpdir(), "odinn-shutdown-improvement-"));
  const stateDir = join(root, "state");
  const providerEntered = deferred();
  let providerCalls = 0;
  const provider: any = createHttpServer(async (request, _response) => {
    providerCalls += 1;
    for await (const _chunk of request) {}
    providerEntered.resolve();
    // Deliberately never settle. Gateway shutdown must abort the provider
    // request and drain the active improvement cycle without local fallback.
  });
  let gateway: any;
  try {
    await mkdir(stateDir, { recursive: true });
    const providerBase = await listen(provider);
    const config = {
      version: 1,
      defaultModel: "test:advisor",
      providers: {
        test: {
          type: "openai-compatible",
          baseUrl: `${providerBase}/v1`,
          models: ["advisor"]
        }
      },
      runtime: { modelRetries: 1 },
      selfImprovement: {
        enabled: true,
        mode: "auto",
        intervalMs: 30_000,
        maxChangesPerCycle: 1,
        rollbackOnFailure: true
      }
    };
    await writeFile(join(stateDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const seedAudit = createAuditStore(join(stateDir, "audit.jsonl"));
    await seedAudit.append({ runId: "stalled-improvement-a", type: "task.failed", actor: "test", tool: "model.chat", message: "model provider returned 429: rate limit" });
    await seedAudit.append({ runId: "stalled-improvement-b", type: "task.failed", actor: "test", tool: "model.chat", message: "model provider returned 429: rate limit" });
    seedAudit.close?.();

    gateway = await createGatewayServer(withGatewayTestHooks({ stateDir, workspaceRoot: root }, {
      improvementStartupDelayMs: 0,
      shutdownTimeoutMs: 1_500
    }));
    await listen(gateway);
    await providerEntered.promise;

    const closeError = await new Promise<Error | undefined>((resolveClose) => gateway.close((error?: Error) => resolveClose(error)));
    assert.equal(closeError, undefined, "stalled improvement did not cooperatively drain before the shutdown deadline");
    assert.equal(providerCalls, 1);
    assert.equal(JSON.parse(await readFile(join(stateDir, "config.json"), "utf8")).runtime.modelRetries, 1);

    const records = new SqliteRecordStore(join(stateDir, "db", "records.sqlite"));
    try {
      const improvements = await records.queryRecordsPage({ typePrefix: "improvement.", limit: 100 });
      assert.deepEqual(improvements.records, [], "cancelled automatic improvement persisted a proposal or settlement");
    } finally {
      records.close();
    }
  } finally {
    provider.closeAllConnections?.();
    if (provider.listening) await new Promise<void>((resolveClose) => provider.close(() => resolveClose()));
    if (gateway?.listening) await new Promise<void>((resolveClose) => gateway.close(() => resolveClose()));
    if (previousAuth === undefined) delete process.env.ODINN_GATEWAY_AUTH;
    else process.env.ODINN_GATEWAY_AUTH = previousAuth;
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway shutdown fences webhook effects before adapter dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-shutdown-webhook-"));
  const credentialEnvironment = "ODINN_SHUTDOWN_WEBHOOK_TOKEN";
  const previousCredential = process.env[credentialEnvironment];
  process.env[credentialEnvironment] = "configured-for-test";
  let effects = 0;
  const capabilities = { chatTypes: ["direct"] } as any;
  const plugin: any = {
    id: "telegram",
    displayName: "Shutdown test channel",
    capabilities,
    webhookRequestMode: "buffer",
    webhookPath: (accountId: string) => `/channels/webhook/shutdown-test/${accountId}`,
    normalizeAccountConfig(_accountId: string, value: any) {
      return { enabled: value.enabled === true, tokenEnv: value.tokenEnv, credentialEnvs: {}, allowlist: [] };
    },
    validateAccountConfig() { return []; },
    createAdapter({ accountId }: any) {
      return {
        id: `shutdown-test:${accountId}`,
        channel: "telegram",
        accountId,
        capabilities,
        async start({ updateStatus }: any) { updateStatus({ state: "connected" }); },
        async stop() {},
        async send() { return { status: "sent", messageIds: [], conversationId: "none", sentChunks: 0, totalChunks: 0 }; },
        async handleWebhook() { effects += 1; return { status: 200, body: "accepted" }; }
      };
    }
  };
  try {
    await runShutdownFence({
      root,
      surface: "channel.webhook",
      path: "/channels/webhook/shutdown-test/fixture",
      config: {
        version: 1,
        channels: { fixture: { type: "telegram", enabled: true, tokenEnv: credentialEnvironment, allowlist: [] } }
      },
      body: { event: "must-not-dispatch" },
      channelPluginLoader: async (type: string) => {
        assert.equal(type, "telegram");
        return plugin;
      },
      async verify() { assert.equal(effects, 0); }
    });
  } finally {
    if (previousCredential === undefined) delete process.env[credentialEnvironment];
    else process.env[credentialEnvironment] = previousCredential;
    await rm(root, { recursive: true, force: true });
  }
});
