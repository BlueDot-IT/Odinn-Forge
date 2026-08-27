import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createGatewayServer } from "../apps/gateway/src/server.ts";
import {
  REMOTE_NODE_DIAGNOSTICS_PATH,
  REMOTE_NODE_READ_PLUGIN_MANIFEST,
  REMOTE_NODE_STATUS_PATH,
  configuredCredentialEnvironmentKeys,
  createApprovalStore,
  createAuditStore,
  createBuiltInRegistry,
  createRemoteNodeReadClient,
  createRunLedger,
  diagnoseRemoteNodeReadIntegration,
  materializeHostCapabilityPlugin,
  normalizeRemoteNodeDiagnosticsResponse,
  normalizeRemoteNodeReadConfig,
  normalizeRemoteNodeStatusResponse,
  remoteNodeReadHostCapabilityPlugin,
  runTask,
  type RemoteNodeHttpRequest,
  type RemoteNodeHttpResponse
} from "../packages/kernel/src/index.ts";
import { pinnedAddressLookup } from "../packages/kernel/src/web.ts";
import { createDefaultPolicy, evaluateTaskPolicy } from "../packages/policy/src/index.ts";
import { projectDurableToolInput, projectDurableToolOutput } from "../packages/protocol/src/index.ts";
import { createAuthenticatedRemoteNodeFixture } from "./fixtures/remote-node-responder.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const nodeId = "worker-one";
const tokenEnv = "ODINN_TEST_REMOTE_NODE_TOKEN";
const credential = "synthetic-remote-node-credential";
const environment = { [tokenEnv]: credential };
const nodeConfig = Object.freeze({
  nodeId,
  origin: "https://worker-one.internal.example:9443",
  addresses: ["192.168.10.42", "fd00::42"],
  tokenEnv
});
const config = Object.freeze({ enabled: true, nodes: [nodeConfig] });
const observedAt = "2026-08-27T12:00:00.000Z";

function jsonResponse(value: unknown, status = 200): RemoteNodeHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: Buffer.from(JSON.stringify(value), "utf8")
  };
}

function statusWire(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    type: "node.status",
    nodeId,
    observedAt,
    status: "ready",
    uptimeSeconds: 3_600,
    activeTasks: 2,
    queuedTasks: 1,
    ...overrides
  };
}

function diagnosticsWire(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    type: "node.diagnostics",
    nodeId,
    observedAt,
    status: "degraded",
    checks: [
      { name: "runtime", status: "pass" },
      { name: "storage", status: "warn" }
    ],
    ...overrides
  };
}

function client(requests: RemoteNodeHttpRequest[] = []) {
  return createRemoteNodeReadClient(config, {
    environment,
    transport: async (request) => {
      requests.push(request);
      return jsonResponse(request.kind === "status" ? statusWire() : diagnosticsWire());
    }
  });
}

test("remote node configuration is explicit, immutable, and contains references instead of credentials", () => {
  assert.deepEqual(normalizeRemoteNodeReadConfig(), { enabled: false, nodes: [] });
  assert.throws(() => normalizeRemoteNodeReadConfig({ enabled: true, nodes: [] }), /at least one explicitly allowed node/u);
  assert.throws(() => normalizeRemoteNodeReadConfig({ ...config, token: credential }), /unsupported field/u);
  assert.throws(() => normalizeRemoteNodeReadConfig({ enabled: true, nodes: [{ ...nodeConfig, token: credential }] }), /unsupported field/u);
  assert.throws(() => normalizeRemoteNodeReadConfig({ enabled: true, nodes: [{ ...nodeConfig, origin: "http://worker-one.internal.example" }] }), /HTTPS authority/u);
  assert.throws(() => normalizeRemoteNodeReadConfig({ enabled: true, nodes: [{ ...nodeConfig, origin: "https://worker-one.internal.example/path" }] }), /without a path/u);
  assert.throws(() => normalizeRemoteNodeReadConfig({ enabled: true, nodes: [{ ...nodeConfig, origin: "https://user@worker-one.internal.example" }] }), /without a path/u);
  assert.throws(() => normalizeRemoteNodeReadConfig({ enabled: true, nodes: [{ ...nodeConfig, addresses: [] }] }), /nonempty explicit IP allowlist/u);
  assert.throws(() => normalizeRemoteNodeReadConfig({ enabled: true, nodes: [{ ...nodeConfig, addresses: Array(1) }] }), /literal IP/u);
  assert.throws(() => normalizeRemoteNodeReadConfig({ enabled: true, nodes: [{ ...nodeConfig, addresses: ["worker-one.internal.example"] }] }), /literal IP/u);
  assert.throws(() => normalizeRemoteNodeReadConfig({ enabled: true, nodes: [{ ...nodeConfig, tokenEnv: "PATH" }] }), /credential environment reference/u);
  assert.throws(() => normalizeRemoteNodeReadConfig({ enabled: true, nodes: [{ ...nodeConfig, tokenEnv: `${"A".repeat(128)}_TOKEN` }] }), /credential environment reference/u);
  assert.throws(() => normalizeRemoteNodeReadConfig({ enabled: true, nodes: [nodeConfig, { ...nodeConfig }] }), /duplicate node identifiers/u);
  assert.throws(() => normalizeRemoteNodeReadConfig({ enabled: true, nodes: Array(33).fill(nodeConfig) }), /at most 32/u);
  assert.throws(() => normalizeRemoteNodeReadConfig({ enabled: true, nodes: Array(1) }), /ordinary object/u);
  assert.throws(() => normalizeRemoteNodeReadConfig({ enabled: true, nodes: [{ ...nodeConfig, origin: "https://127.0.0.1", addresses: ["192.168.10.42"] }] }), /include its literal-IP origin/u);

  const normalized = normalizeRemoteNodeReadConfig(config);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.nodes), true);
  assert.equal(Object.isFrozen(normalized.nodes[0]), true);
  assert.equal(Object.isFrozen(normalized.nodes[0]!.addresses), true);
  assert.deepEqual([...configuredCredentialEnvironmentKeys({ integrations: { remoteNode: config } })], [tokenEnv]);
  assert.equal(JSON.stringify(normalized).includes(credential), false);
});

test("remote node client exposes only two fixed authenticated pinned-address reads", async (t) => {
  const requests: RemoteNodeHttpRequest[] = [];
  const remote = client(requests);
  t.after(() => remote.close());
  const status = await remote.status({ nodeId });
  const diagnostics = await remote.diagnostics({ nodeId });

  assert.equal(status.type, "node.status");
  assert.equal(status.contentTrust, "external-untrusted");
  assert.equal(diagnostics.type, "node.diagnostics");
  assert.deepEqual(diagnostics.checks.map((check) => check.name), ["runtime", "storage"]);
  assert.deepEqual(requests.map((request) => request.url.origin), [nodeConfig.origin, nodeConfig.origin]);
  assert.deepEqual(requests.map((request) => request.url.pathname), [REMOTE_NODE_STATUS_PATH, REMOTE_NODE_DIAGNOSTICS_PATH]);
  assert.deepEqual(requests.map((request) => request.address), nodeConfig.addresses);
  assert.ok(requests.every((request) => request.headers.authorization === `Bearer ${credential}`));
  assert.ok(requests.every((request) => request.headers["x-odinn-node-protocol"] === "1"));
  assert.ok(requests.every((request) => !request.url.href.includes(credential)));
  await assert.rejects(() => remote.status({ nodeId, path: "/arbitrary" }), /unsupported field/u);
  assert.throws(() => remote.resourceFor("status", { nodeId: "other-node" }), /outside the configured allowlist/u);
});

test("remote node response schemas bind targets and refuse arbitrary content before return", async (t) => {
  assert.equal(normalizeRemoteNodeStatusResponse(statusWire(), nodeId).status, "ready");
  assert.equal(normalizeRemoteNodeDiagnosticsResponse(diagnosticsWire(), nodeId).checks.length, 2);
  assert.throws(() => normalizeRemoteNodeStatusResponse(statusWire({ nodeId: "other-node" }), nodeId), /target does not match/u);
  assert.throws(() => normalizeRemoteNodeStatusResponse(statusWire({ message: "remote-log-content" }), nodeId), /unsupported field/u);
  assert.throws(() => normalizeRemoteNodeDiagnosticsResponse(diagnosticsWire({ checks: [{ name: "runtime", status: "pass" }, { name: "runtime", status: "warn" }] }), nodeId), /duplicates/u);
  assert.throws(() => normalizeRemoteNodeDiagnosticsResponse(diagnosticsWire({ checks: Array(1) }), nodeId), /ordinary object/u);
  assert.throws(() => normalizeRemoteNodeDiagnosticsResponse(diagnosticsWire({ checks: [{ name: "logs", status: "pass" }] }), nodeId), /unsupported/u);
  assert.throws(() => normalizeRemoteNodeStatusResponse(statusWire({ uptimeSeconds: 315_576_001 }), nodeId), /bounded nonnegative/u);

  const remoteSecret = "REMOTE_SCHEMA_CONTENT_MUST_NOT_PERSIST";
  const malformed = createRemoteNodeReadClient(config, {
    environment,
    transport: async () => jsonResponse(statusWire({ [remoteSecret]: remoteSecret }))
  });
  t.after(() => malformed.close());
  await assert.rejects(
    () => malformed.status({ nodeId }),
    (error: any) => /failed schema validation/u.test(error.message) && !error.message.includes(remoteSecret)
  );
});

test("remote node transport refuses redirects, remote error bodies, oversized responses, and missing credentials", async (t) => {
  const redirect = createRemoteNodeReadClient(config, {
    environment,
    transport: async () => ({ status: 302, headers: { location: "https://attacker.invalid" }, body: Buffer.alloc(0) })
  });
  const errorBody = "REMOTE_ERROR_BODY_MUST_NOT_ESCAPE";
  const failed = createRemoteNodeReadClient(config, {
    environment,
    transport: async () => jsonResponse({ error: errorBody }, 503)
  });
  const oversized = createRemoteNodeReadClient(config, {
    environment,
    transport: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.alloc(65_537, 0x20) })
  });
  const missing = createRemoteNodeReadClient(config, { environment: {}, transport: async () => jsonResponse(statusWire()) });
  t.after(() => { redirect.close(); failed.close(); oversized.close(); missing.close(); });

  await assert.rejects(() => redirect.status({ nodeId }), /redirects are refused/u);
  await assert.rejects(() => failed.status({ nodeId }), (error: any) => /status 503/u.test(error.message) && !error.message.includes(errorBody));
  await assert.rejects(() => oversized.status({ nodeId }), /bounded size limit/u);
  await assert.rejects(() => missing.status({ nodeId }), /credential is not configured/u);
});

test("remote node transport failures are content-free and response metadata is strict", async (t) => {
  const transportSecret = "REMOTE_TRANSPORT_FAILURE_MUST_NOT_ESCAPE";
  const rejected = createRemoteNodeReadClient(config, {
    environment,
    transport: async () => { throw new Error(transportSecret); }
  });
  const invalidStatus = createRemoteNodeReadClient(config, {
    environment,
    transport: async () => ({ ...jsonResponse(statusWire()), status: Number.NaN })
  });
  const invalidEnvelope = createRemoteNodeReadClient(config, {
    environment,
    transport: async () => null as unknown as RemoteNodeHttpResponse
  });
  const misleadingType = createRemoteNodeReadClient(config, {
    environment,
    transport: async () => ({ ...jsonResponse(statusWire()), headers: { "content-type": "text/plain; profile=application/json" } })
  });
  t.after(() => { rejected.close(); invalidStatus.close(); invalidEnvelope.close(); misleadingType.close(); });

  await assert.rejects(
    () => rejected.status({ nodeId }),
    (error: any) => /request failed/u.test(error.message) && !error.message.includes(transportSecret)
  );
  await assert.rejects(() => invalidStatus.status({ nodeId }), /response status was invalid/u);
  await assert.rejects(() => invalidEnvelope.status({ nodeId }), /response envelope was invalid/u);
  await assert.rejects(() => misleadingType.status({ nodeId }), /response was not JSON/u);
});

test("remote node transport failure audit and ledger evidence omit arbitrary error content", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "odinn-remote-node-failure-evidence-"));
  const stateDir = join(workspace, ".odinn");
  const audit = createAuditStore(join(stateDir, "audit.jsonl"));
  const ledger = createRunLedger({ stateDir, workspaceRoot: workspace });
  const transportSecret = "REMOTE_TRANSPORT_AUDIT_CONTENT_MUST_NOT_PERSIST";
  const remote = createRemoteNodeReadClient(config, {
    environment,
    transport: async () => { throw new Error(transportSecret); }
  });
  const registry = createBuiltInRegistry({
    workspaceRoot: workspace,
    stateDir,
    auditStore: audit,
    config: { integrations: { remoteNode: config }, runLedger: ledger },
    remoteNodeReadClient: remote
  });
  t.after(async () => {
    registry.close();
    ledger.close();
    audit.close();
    await rm(workspace, { recursive: true, force: true });
  });

  await assert.rejects(() => runTask({
    task: { id: "remote-node-transport-failure", tool: "node.status", input: { nodeId }, actor: "remote-node-test" },
    auditStore: audit,
    registry,
    runLedger: ledger,
    policy: createDefaultPolicy({ allowedCapabilities: ["node.read", "network.access", "secret.reference.use"] })
  }), (error: any) => /request failed/u.test(error.message) && !error.message.includes(transportSecret));
  assert.doesNotMatch(await readStateText(stateDir), new RegExp(transportSecret, "u"));
});

test("remote node request admission bounds concurrency and queued cancellation", async (t) => {
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  let announceFour!: () => void;
  const fourStarted = new Promise<void>((resolveStarted) => { announceFour = resolveStarted; });
  const releases: Array<() => void> = [];
  const remote = createRemoteNodeReadClient(config, {
    environment,
    transport: async () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 4) announceFour();
      await new Promise<void>((resolveRequest) => releases.push(resolveRequest));
      active -= 1;
      return jsonResponse(statusWire());
    }
  });
  t.after(() => remote.close());
  const admitted = Array.from({ length: 4 }, () => remote.status({ nodeId }));
  await fourStarted;
  const controller = new AbortController();
  const queued = remote.status({ nodeId }, controller.signal);
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  controller.abort();
  await assert.rejects(() => queued, { name: "AbortError" });
  assert.equal(calls, 4);
  for (const release of releases.splice(0)) release();
  await Promise.all(admitted);
  assert.equal(maximumActive, 4);
});

test("remote node deadline and close settle stalled reads without widening live concurrency", async (t) => {
  let calls = 0;
  const releases: Array<() => void> = [];
  const remote = createRemoteNodeReadClient(config, {
    environment,
    __testOnlyRequestTimeoutMs: 30,
    transport: async () => {
      calls += 1;
      return new Promise<RemoteNodeHttpResponse>((resolveRequest) => releases.push(() => resolveRequest(jsonResponse(statusWire()))));
    }
  });
  t.after(() => {
    for (const release of releases.splice(0)) release();
    remote.close();
  });
  const settled = await Promise.allSettled(Array.from({ length: 9 }, () => remote.status({ nodeId })));
  assert.equal(settled.every((result) => result.status === "rejected" && /timed out/u.test(String(result.reason?.message))), true);
  assert.equal(calls, 4);

  const closing = createRemoteNodeReadClient(config, {
    environment,
    transport: async () => new Promise<RemoteNodeHttpResponse>((resolveRequest) => releases.push(() => resolveRequest(jsonResponse(statusWire()))))
  });
  const pending = closing.status({ nodeId });
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  closing.close();
  await assert.rejects(() => pending, /client is closed/u);
  assert.throws(() => closing.resourceFor("status", { nodeId }), /client is closed/u);
});

test("real HTTPS responder authenticates the fixed protocol and preserves TLS hostname verification", async (t) => {
  const fixture = await createAuthenticatedRemoteNodeFixture();
  if (!fixture) return t.skip("OpenSSL is unavailable for the real TLS fixture");
  t.after(() => fixture.close());
  const fixtureConfig = {
    enabled: true,
    nodes: [{ nodeId: fixture.nodeId, origin: fixture.origin, addresses: [fixture.address], tokenEnv: fixture.tokenEnv }]
  };
  const remote = createRemoteNodeReadClient(fixtureConfig, {
    environment: fixture.environment,
    __testOnlyTlsCa: fixture.certificate
  });
  t.after(() => remote.close());
  const status = await remote.status({ nodeId: fixture.nodeId });
  const diagnostics = await remote.diagnostics({ nodeId: fixture.nodeId });
  assert.equal(status.uptimeSeconds, fixture.statusSnapshot.uptimeSeconds);
  assert.equal(diagnostics.status, fixture.diagnosticsSnapshot.status);

  const wrongCredential = createRemoteNodeReadClient(fixtureConfig, {
    environment: { [fixture.tokenEnv]: "wrong-synthetic-credential" },
    __testOnlyTlsCa: fixture.certificate
  });
  const untrustedCertificate = createRemoteNodeReadClient(fixtureConfig, { environment: fixture.environment });
  t.after(() => { wrongCredential.close(); untrustedCertificate.close(); });
  await assert.rejects(() => wrongCredential.status({ nodeId: fixture.nodeId }), /authentication failed/u);
  await assert.rejects(() => untrustedCertificate.status({ nodeId: fixture.nodeId }), /request failed/u);

  const unauthenticated = await fixtureRawRequest(fixture, REMOTE_NODE_STATUS_PATH, "GET");
  const mutation = await fixtureRawRequest(fixture, "/odinn/node/v1/mutate", "POST");
  const wrongMethod = await fixtureRawRequest(fixture, REMOTE_NODE_STATUS_PATH, "POST");
  assert.equal(unauthenticated.status, 401);
  assert.equal(mutation.status, 404);
  assert.equal(wrongMethod.status, 405);
});

test("remote node tools require exact policy authority but no approval", async (t) => {
  const remote = client();
  t.after(() => remote.close());
  const tools = materializeHostCapabilityPlugin(remoteNodeReadHostCapabilityPlugin, {
    stateDir: "/tmp/odinn-remote-node-test",
    approvalStore: createApprovalStore(),
    remoteNodeReadClient: remote
  });
  assert.deepEqual(REMOTE_NODE_READ_PLUGIN_MANIFEST.tools.map((tool) => tool.name), ["node.status", "node.diagnostics"]);
  assert.equal(tools.size, 2);
  const resource = tools.get("node.status")?.resourceForInput?.({ nodeId });
  assert.deepEqual(Object.keys(resource ?? {}).sort(), ["configurationDigest", "nodeDigest", "targetDigest"]);
  assert.doesNotMatch(JSON.stringify(resource), /worker-one|internal|192\.168|fd00/u);
  const tool = { ...tools.get("node.status"), capabilities: ["node.read", "network.access", "secret.reference.use"], capability: "node.read" };
  const denied = evaluateTaskPolicy({ policy: createDefaultPolicy(), request: { tool: "node.status", input: { nodeId } }, tool });
  const allowed = evaluateTaskPolicy({
    policy: createDefaultPolicy({ allowedCapabilities: ["node.read", "network.access", "secret.reference.use"] }),
    request: { tool: "node.status", input: { nodeId } },
    tool
  });
  assert.equal(denied.allowed, false);
  assert.equal(allowed.allowed, true);
  assert.equal(REMOTE_NODE_READ_PLUGIN_MANIFEST.tools.every((manifestTool) => manifestTool.safety.requiresApproval === false), true);
});

test("remote node live results replay as digest, count, and status evidence only across restart", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "odinn-remote-node-replay-"));
  const stateDir = join(workspace, ".odinn");
  const policy = createDefaultPolicy({ allowedCapabilities: ["node.read", "network.access", "secret.reference.use"] });
  const request = { id: "remote-node-replay", tool: "node.diagnostics", input: { nodeId }, actor: "remote-node-test" };
  let liveCalls = 0;
  const liveClient = createRemoteNodeReadClient(config, {
    environment,
    transport: async () => {
      liveCalls += 1;
      return jsonResponse(diagnosticsWire());
    }
  });
  let audit = createAuditStore(join(stateDir, "audit.jsonl"));
  let ledger = createRunLedger({ stateDir, workspaceRoot: workspace });
  let registry = createBuiltInRegistry({
    workspaceRoot: workspace,
    stateDir,
    auditStore: audit,
    config: { integrations: { remoteNode: config }, runLedger: ledger },
    remoteNodeReadClient: liveClient
  });
  const first = await runTask({ task: request, auditStore: audit, registry, runLedger: ledger, policy });
  assert.equal(first.output.status, "degraded");
  assert.equal(first.output.checks[0].name, "runtime");
  assert.equal(liveCalls, 1);
  registry.close(); ledger.close(); audit.close(); liveClient.close();

  let replayTransportCalls = 0;
  const replayClient = createRemoteNodeReadClient(config, {
    environment,
    transport: async () => {
      replayTransportCalls += 1;
      throw new Error("replay must not contact the node");
    }
  });
  audit = createAuditStore(join(stateDir, "audit.jsonl"));
  ledger = createRunLedger({ stateDir, workspaceRoot: workspace });
  registry = createBuiltInRegistry({
    workspaceRoot: workspace,
    stateDir,
    auditStore: audit,
    config: { integrations: { remoteNode: config }, runLedger: ledger },
    remoteNodeReadClient: replayClient
  });
  t.after(async () => {
    registry.close(); ledger.close(); audit.close(); replayClient.close();
    await rm(workspace, { recursive: true, force: true });
  });
  const replay = await runTask({ task: request, auditStore: audit, registry, runLedger: ledger, policy });
  assert.equal(replay.replayed, true);
  assert.equal(replay.contentUnavailableOnReplay, true);
  assert.equal(replayTransportCalls, 0);
  assert.deepEqual(Object.keys(projectDurableToolInput(request.tool, request.input) as Record<string, unknown>), ["targetDigest"]);
  assert.deepEqual(Object.keys(projectDurableToolOutput(request.tool, first.output) as Record<string, unknown>).sort(), [
    "contentUnavailableOnReplay", "itemCount", "payloadBytes", "payloadDigest", "schemaVersion", "status", "targetDigest", "type"
  ]);
  const durableEvidence = JSON.stringify(await audit.readAll());
  assert.doesNotMatch(durableEvidence, /worker-one|internal\.example|192\.168\.10\.42|fd00::42|synthetic-remote-node-credential|runtime|storage|2026-08-27T12:00:00/u);
  const persistedState = await readStateText(stateDir);
  assert.doesNotMatch(persistedState, /worker-one|internal\.example|192\.168\.10\.42|fd00::42|synthetic-remote-node-credential|2026-08-27T12:00:00/u);
});

test("remote node cancellation fails closed without a durable completion", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "odinn-remote-node-cancel-"));
  const stateDir = join(workspace, ".odinn");
  const audit = createAuditStore(join(stateDir, "audit.jsonl"));
  const ledger = createRunLedger({ stateDir, workspaceRoot: workspace });
  let release!: () => void;
  let started!: () => void;
  const transportStarted = new Promise<void>((resolveStarted) => { started = resolveStarted; });
  const remote = createRemoteNodeReadClient(config, {
    environment,
    transport: async () => {
      started();
      await new Promise<void>((resolveRequest) => { release = resolveRequest; });
      return jsonResponse(statusWire());
    }
  });
  const registry = createBuiltInRegistry({ workspaceRoot: workspace, stateDir, auditStore: audit, config: { integrations: { remoteNode: config }, runLedger: ledger }, remoteNodeReadClient: remote });
  t.after(async () => {
    release?.();
    registry.close(); remote.close(); ledger.close(); audit.close();
    await rm(workspace, { recursive: true, force: true });
  });
  const controller = new AbortController();
  const pending = runTask({
    task: { id: "remote-node-cancelled", tool: "node.status", input: { nodeId }, actor: "remote-node-test" },
    auditStore: audit,
    registry,
    runLedger: ledger,
    policy: createDefaultPolicy({ allowedCapabilities: ["node.read", "network.access", "secret.reference.use"] }),
    signal: controller.signal
  });
  await transportStarted;
  controller.abort();
  await assert.rejects(() => pending, { name: "AbortError" });
  release();
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  const events = await audit.readAll();
  assert.equal(events.some((event: any) => event.runId === "remote-node-cancelled" && event.type === "task.completed"), false);
  assert.equal(events.some((event: any) => event.runId === "remote-node-cancelled" && event.type === "task.cancelled"), true);
});

test("registry close aborts injected remote node clients and multi-user hosting refuses shared credentials", async (t) => {
  let calls = 0;
  let started!: () => void;
  const transportStarted = new Promise<void>((resolveStarted) => { started = resolveStarted; });
  const remote = createRemoteNodeReadClient(config, {
    environment,
    transport: async ({ signal }) => {
      calls += 1;
      started();
      return new Promise<RemoteNodeHttpResponse>((_resolveRequest, rejectRequest) => {
        signal?.addEventListener("abort", () => rejectRequest(new Error("transport observed close")), { once: true });
      });
    }
  });
  const registry = createBuiltInRegistry({ config: { integrations: { remoteNode: config } }, remoteNodeReadClient: remote });
  const tool = registry.get("node.status");
  const pending = tool.execute({ nodeId });
  await transportStarted;
  registry.close();
  await assert.rejects(() => pending, /client is closed/u);
  await assert.rejects(() => tool.execute({ nodeId }), /client is closed/u);
  assert.equal(calls, 1);
  remote.close();

  const stateDir = await mkdtemp(join(tmpdir(), "odinn-hosted-remote-node-"));
  const workspace = await mkdtemp(join(tmpdir(), "odinn-hosted-remote-workspace-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify({ version: 1, integrations: { remoteNode: config } }, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(
    () => createGatewayServer({ stateDir, workspaceRoot: workspace, hosted: true, hostedUserId: "alice", hostedTenantId: "tenant-a" }),
    /does not allow shared remote node credentials/u
  );
});

test("onboarding state, diagnostics, status, and Gatewatch expose safe remote-node controls", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-remote-node-onboarding-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const init = spawnSync("node", ["apps/cli/src/cli.ts", "init", "--state", stateDir], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  if (process.platform !== "win32") assert.equal((await stat(join(stateDir, "config.json"))).mode & 0o777, 0o600);
  const stored = JSON.parse(await readFile(join(stateDir, "config.json"), "utf8"));
  stored.integrations = { remoteNode: config };
  stored.policy = createDefaultPolicy({ allowedCapabilities: ["node.read", "network.access", "secret.reference.use"] });
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  const childEnvironment = { ...process.env, [tokenEnv]: credential };
  const doctor = spawnSync("node", ["apps/cli/src/cli.ts", "doctor", "--state", stateDir], { cwd: root, encoding: "utf8", env: childEnvironment });
  assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
  const diagnostic = JSON.parse(doctor.stdout);
  assert.deepEqual(diagnostic.remoteNodeRead, diagnoseRemoteNodeReadIntegration(config, environment));
  assert.doesNotMatch(doctor.stdout, /worker-one|internal\.example|192\.168|fd00|ODINN_TEST_REMOTE_NODE_TOKEN|synthetic-remote-node-credential/u);

  const statusResult = spawnSync("node", ["apps/cli/src/cli.ts", "status", "--state", stateDir], { cwd: root, encoding: "utf8", env: childEnvironment });
  assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
  const runtimeStatus = JSON.parse(statusResult.stdout);
  assert.ok(runtimeStatus.toolDetails.some((tool: any) => tool.name === "node.status" && tool.capabilities.includes("node.read")));
  const preview = spawnSync("node", [
    "apps/cli/src/cli.ts", "gatewatch", "preview",
    "--tool", "node.status",
    "--input-json", JSON.stringify({ nodeId }),
    "--state", stateDir
  ], { cwd: root, encoding: "utf8", env: childEnvironment });
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  const admission = JSON.parse(preview.stdout);
  assert.equal(admission.allowed, true);
  assert.equal(admission.executes, false);
  assert.deepEqual(admission.approval, { required: false, source: "none" });
});

async function fixtureRawRequest(
  fixture: NonNullable<Awaited<ReturnType<typeof createAuthenticatedRemoteNodeFixture>>>,
  path: string,
  method: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest(new URL(path, `${fixture.origin}/`), {
      method,
      ca: fixture.certificate,
      lookup: pinnedAddressLookup(fixture.address),
      headers: { "x-odinn-node-protocol": "1" },
      rejectUnauthorized: true,
      agent: false
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolveRequest({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", rejectRequest);
    request.end();
  });
}

async function readStateText(stateDir: string): Promise<string> {
  const entries = await readdir(stateDir, { recursive: true, withFileTypes: true });
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    chunks.push(await readFile(join(entry.parentPath, entry.name)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
