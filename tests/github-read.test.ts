import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  GITHUB_READ_PLUGIN_MANIFEST,
  createApprovalStore,
  createAuditStore,
  createBuiltInRegistry,
  createGitHubReadClient,
  createRunLedger,
  diagnoseGitHubReadIntegration,
  githubReadHostCapabilityPlugin,
  materializeHostCapabilityPlugin,
  normalizeGitHubReadConfig,
  runTask,
  type GitHubHttpRequest,
  type GitHubHttpResponse
} from "../packages/kernel/src/index.ts";
import { createDefaultPolicy, evaluateTaskPolicy } from "../packages/policy/src/index.ts";
import { projectDurableToolInput, projectDurableToolOutput } from "../packages/protocol/src/index.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const repository = "BlueDot-IT/Odinn-Forge";
const commitOid = "a".repeat(40);
const baseOid = "b".repeat(40);
const tokenEnv = "ODINN_TEST_GITHUB_TOKEN";
const environment = { [tokenEnv]: "synthetic-test-value" };
const config = Object.freeze({ enabled: true, tokenEnv, repositories: [repository] });
const publicResolver = async () => ["93.184.216.34"];

function jsonResponse(value: unknown, status = 200): GitHubHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: Buffer.from(JSON.stringify(value), "utf8")
  };
}

function fixtures(path: string): GitHubHttpResponse {
  if (path === "/repos/BlueDot-IT/Odinn-Forge") return jsonResponse({
    full_name: repository,
    name: "Odinn-Forge",
    owner: { login: "BlueDot-IT" },
    visibility: "public",
    archived: false,
    disabled: false,
    default_branch: "main",
    description: "A bounded repository response"
  });
  if (path === "/repos/BlueDot-IT/Odinn-Forge/issues/178") return jsonResponse({
    number: 178,
    state: "open",
    title: "Roadmap",
    body: "PRIVATE_GITHUB_BODY_5f3b1e",
    locked: false,
    labels: [{ name: "roadmap" }],
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-26T00:00:00Z",
    closed_at: null
  });
  if (path === "/repos/BlueDot-IT/Odinn-Forge/pulls/198") return jsonResponse({
    number: 198,
    state: "open",
    title: "Console attachments",
    body: "Pull request body",
    draft: false,
    merged: false,
    head: { ref: "feat/attachments", sha: commitOid },
    base: { ref: "main", sha: baseOid },
    created_at: "2026-08-25T00:00:00Z",
    updated_at: "2026-08-26T00:00:00Z",
    merged_at: null
  });
  if (path === `/repos/BlueDot-IT/Odinn-Forge/commits/${commitOid}/check-runs?per_page=2`) return jsonResponse({
    total_count: 2,
    check_runs: [
      { name: "CI", status: "completed", conclusion: "success", started_at: "2026-08-26T00:00:00Z", completed_at: "2026-08-26T00:01:00Z" },
      { name: "Security", status: "in_progress", conclusion: null, started_at: "2026-08-26T00:00:00Z", completed_at: null }
    ]
  });
  return jsonResponse({ message: "not found" }, 404);
}

function client(requests: GitHubHttpRequest[] = []) {
  return createGitHubReadClient(config, {
    environment,
    resolveNetworkAddresses: publicResolver,
    transport: async (request) => {
      requests.push(request);
      return fixtures(`${request.url.pathname}${request.url.search}`);
    }
  });
}

test("GitHub read client exposes only bounded allowlisted GET surfaces", async () => {
  const requests: GitHubHttpRequest[] = [];
  const github = client(requests);
  const repositoryResult = await github.repository({ repository });
  const issue = await github.issue({ repository, issueNumber: 178 });
  const pull = await github.pullRequest({ repository, pullNumber: 198 });
  const checks = await github.checks({ repository, ref: commitOid, limit: 2 });

  assert.equal(repositoryResult.type, "github.repository");
  assert.equal(issue.body, "PRIVATE_GITHUB_BODY_5f3b1e");
  assert.equal((pull.head as Record<string, unknown>).oid, commitOid);
  assert.equal(checks.checkCount, 2);
  assert.deepEqual(requests.map((request) => request.url.origin), Array(4).fill("https://api.github.com"));
  assert.deepEqual(requests.map((request) => `${request.url.pathname}${request.url.search}`), [
    "/repos/BlueDot-IT/Odinn-Forge",
    "/repos/BlueDot-IT/Odinn-Forge/issues/178",
    "/repos/BlueDot-IT/Odinn-Forge/pulls/198",
    `/repos/BlueDot-IT/Odinn-Forge/commits/${commitOid}/check-runs?per_page=2`
  ]);
  assert.ok(requests.every((request) => request.headers.authorization.startsWith("Bearer ")));
  assert.ok(requests.every((request) => !request.url.href.includes("synthetic-test-value")));
});

test("GitHub read configuration, resources, and trusted policy fail closed", async () => {
  assert.throws(() => normalizeGitHubReadConfig({ enabled: true, tokenEnv, repositories: [] }), /at least one explicitly allowed/u);
  assert.throws(() => normalizeGitHubReadConfig({ enabled: true, tokenEnv, repositories: [repository], token: "raw" }), /unsupported field: token/u);
  assert.throws(() => normalizeGitHubReadConfig({ enabled: true, tokenEnv: { toString: () => { throw new Error("must not execute"); } }, repositories: [repository] }), /allowed credential environment reference/u);
  assert.throws(() => normalizeGitHubReadConfig({ enabled: true, tokenEnv, repositories: [repository, repository.toLowerCase()] }), /must not contain duplicates/u);
  assert.throws(() => normalizeGitHubReadConfig({ enabled: true, tokenEnv, repositories: ["https://github.com/BlueDot-IT/Odinn-Forge"] }), /owner\/repository/u);
  assert.deepEqual(normalizeGitHubReadConfig({ enabled: true, tokenEnv, repositories: ["BlueDot-IT/.github"] }).repositories, ["BlueDot-IT/.github"]);

  const github = client();
  const tools = materializeHostCapabilityPlugin(githubReadHostCapabilityPlugin, {
    stateDir: "/tmp/odinn-github-test",
    approvalStore: createApprovalStore(),
    githubReadClient: github
  });
  const resource = tools.get("github.issue")?.resourceForInput?.({ repository, issueNumber: 178 });
  assert.deepEqual(Object.keys(resource ?? {}).sort(), ["configurationDigest", "repositoryDigest", "targetDigest"]);
  assert.doesNotMatch(JSON.stringify(resource), /BlueDot|Odinn|178/u);
  assert.throws(() => tools.get("github.issue")?.resourceForInput?.({ repository: "other/repository", issueNumber: 1 }), /outside the configured read allowlist/u);
  assert.throws(() => tools.get("github.issue")?.resourceForInput?.({ repository, issueNumber: 178, ignored: true }), /unsupported field/u);
  await assert.rejects(() => github.checks({ repository, ref: "main" }), /full commit object ID/u);
  assert.deepEqual(GITHUB_READ_PLUGIN_MANIFEST.tools.map((tool) => tool.name), ["github.repository", "github.issue", "github.pull-request", "github.checks"]);
});

test("GitHub read network boundary refuses private resolution, redirects, and remote error content", async () => {
  let calls = 0;
  const privateClient = createGitHubReadClient(config, {
    environment,
    resolveNetworkAddresses: async () => ["127.0.0.1"],
    transport: async () => { calls += 1; return jsonResponse({}); }
  });
  await assert.rejects(() => privateClient.repository({ repository }), /non-public address/u);
  assert.equal(calls, 0);

  const invalidAddressClient = createGitHubReadClient(config, {
    environment,
    resolveNetworkAddresses: async () => ["public.example.invalid"],
    transport: async () => { calls += 1; return jsonResponse({}); }
  });
  await assert.rejects(() => invalidAddressClient.repository({ repository }), /non-public address/u);
  assert.equal(calls, 0);

  const redirectClient = createGitHubReadClient(config, {
    environment,
    resolveNetworkAddresses: publicResolver,
    transport: async () => ({ status: 302, headers: { location: "https://attacker.invalid/collect" }, body: Buffer.from("", "utf8") })
  });
  await assert.rejects(() => redirectClient.repository({ repository }), /redirects are refused/u);

  const errorClient = createGitHubReadClient(config, {
    environment,
    resolveNetworkAddresses: publicResolver,
    transport: async () => jsonResponse({ message: "synthetic-test-value" }, 403)
  });
  await assert.rejects(
    () => errorClient.repository({ repository }),
    (error: any) => /status 403/u.test(error.message) && !/synthetic-test-value/u.test(error.message)
  );
  assert.throws(() => normalizeGitHubReadConfig({ ...config, endpoint: "https://attacker.invalid" }), /unsupported field: endpoint/u);
});

test("GitHub read concurrency is bounded and queued cancellation never starts a request", async () => {
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  let blocking = true;
  let announceFour!: () => void;
  const fourStarted = new Promise<void>((resolveStarted) => { announceFour = resolveStarted; });
  const releases: Array<() => void> = [];
  const github = createGitHubReadClient(config, {
    environment,
    resolveNetworkAddresses: publicResolver,
    transport: async (request) => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 4) announceFour();
      if (blocking) await new Promise<void>((resolveRequest) => releases.push(resolveRequest));
      active -= 1;
      return fixtures(`${request.url.pathname}${request.url.search}`);
    }
  });

  const admitted = Array.from({ length: 4 }, () => github.repository({ repository }));
  await fourStarted;
  const controller = new AbortController();
  const queued = github.repository({ repository }, controller.signal);
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  controller.abort();
  await assert.rejects(() => queued, (error: any) => error?.name === "AbortError");
  assert.equal(calls, 4);

  blocking = false;
  for (const release of releases.splice(0)) release();
  await Promise.all(admitted);
  await github.repository({ repository });
  assert.equal(calls, 5);
  assert.equal(maximumActive, 4);
});

test("GitHub live content is unavailable on replay and persists as digests only", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "odinn-github-read-"));
  const stateDir = join(workspace, ".odinn");
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const ledger = createRunLedger({ stateDir, workspaceRoot: workspace });
  const registry = createBuiltInRegistry({
    workspaceRoot: workspace,
    stateDir,
    auditStore,
    config: { integrations: { github: config }, runLedger: ledger },
    githubReadClient: client()
  });
  t.after(async () => {
    registry.close();
    ledger.close();
    auditStore.close();
    await rm(workspace, { recursive: true, force: true });
  });
  const tool = registry.get("github.issue");
  assert.equal(evaluateTaskPolicy({ policy: createDefaultPolicy(), request: { tool: "github.issue", input: { repository, issueNumber: 178 } }, tool }).allowed, false);
  const policy = createDefaultPolicy({ allowedCapabilities: ["github.read", "network.access", "secret.reference.use"] });
  assert.equal(evaluateTaskPolicy({ policy, request: { tool: "github.issue", input: { repository, issueNumber: 178 } }, tool }).allowed, true);

  const request = { id: "github-read-private", tool: "github.issue", input: { repository, issueNumber: 178 }, actor: "github-test" };
  const first = await runTask({ task: request, auditStore, registry, runLedger: ledger, policy });
  assert.equal(first.output.body, "PRIVATE_GITHUB_BODY_5f3b1e");
  const replay = await runTask({ task: request, auditStore, registry, runLedger: ledger, policy });
  assert.equal(replay.replayed, true);
  assert.equal(replay.contentUnavailableOnReplay, true);
  assert.equal("body" in replay.output, false);

  const durableInput = projectDurableToolInput("github.issue", request.input) as Record<string, unknown>;
  const durableOutput = projectDurableToolOutput("github.issue", first.output) as Record<string, unknown>;
  assert.deepEqual(Object.keys(durableInput).sort(), ["targetDigest"]);
  assert.deepEqual(Object.keys(durableOutput).sort(), ["contentUnavailableOnReplay", "itemCount", "payloadBytes", "payloadDigest", "targetDigest", "type"]);
  const durable = `${(await auditStore.readAll()).map(JSON.stringify).join("\n")}\n${await readFile(join(stateDir, "runs.jsonl"), "utf8").catch(() => "")}`;
  assert.doesNotMatch(durable, /PRIVATE_GITHUB_BODY|BlueDot-IT|Odinn-Forge|synthetic-test-value/u);
});

test("GitHub diagnostics expose booleans and counts without credential or repository identifiers", async () => {
  assert.deepEqual(diagnoseGitHubReadIntegration(config, environment), {
    enabled: true,
    configured: true,
    repositoryCount: 1,
    endpoint: "api.github.com",
    readOnly: true,
    mutationsAvailable: false,
    redirectsAllowed: false
  });
  const state = await mkdtemp(join(tmpdir(), "odinn-github-doctor-"));
  try {
    const init = spawnSync("node", ["apps/cli/src/cli.ts", "init", "--state", state], { cwd: root, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr || init.stdout);
    const configPath = join(state, "config.json");
    const stored = JSON.parse(await readFile(configPath, "utf8"));
    stored.integrations = { github: config };
    await writeFile(configPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    const doctor = spawnSync("node", ["apps/cli/src/cli.ts", "doctor", "--state", state], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...environment }
    });
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    const report = JSON.parse(doctor.stdout);
    assert.deepEqual(report.githubRead, diagnoseGitHubReadIntegration(config, environment));
    assert.doesNotMatch(doctor.stdout, /ODINN_TEST_GITHUB_TOKEN|synthetic-test-value|BlueDot-IT|Odinn-Forge/u);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
