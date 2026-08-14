process.env.ODINN_GATEWAY_AUTH = "off";

import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayServer } from "../apps/gateway/src/server.ts";
import { createAuditStore, createRunLedger, SqliteJobStore } from "../packages/kernel/src/index.ts";
import { validateAgentRunGraph, validateExecutableAgentManifest } from "../packages/kernel/src/agent-run-graphs.ts";
import { AGENT_GRAPH_REGISTRY_REF } from "../packages/kernel/src/agent-graph-runtime.ts";

test("gateway exposes durable jobs with idempotent submission", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-jobs-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "job_gateway_idempotent" },
      body: JSON.stringify({ task: { tool: "text.echo", input: { text: "ODINN_GATEWAY_JOB_OK" } } })
    });
    assert.equal(first.status, 202);
    const firstBody = await first.json();
    assert.equal(firstBody.job.id, "job_gateway_idempotent");

    const replay = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "job_gateway_idempotent" },
      body: JSON.stringify({ task: { tool: "text.echo", input: { text: "ODINN_GATEWAY_JOB_OK" } } })
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).replayed, true);

    const conflict = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "job_gateway_idempotent" },
      body: JSON.stringify({ task: { tool: "text.echo", input: { text: "different payload" } } })
    });
    assert.equal(conflict.status, 409);

    let job;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      job = await (await fetch(`${base}/jobs/job_gateway_idempotent`)).json();
      if (job.status === "completed") break;
      await new Promise((resolve: any) => setTimeout(resolve, 50));
    }
    assert.equal(job.status, "completed");
    assert.equal(job.result.output.text, "ODINN_GATEWAY_JOB_OK");
    assert.equal(job.executionRunId, "job_gateway_idempotent");
    assert.ok(job.executionAttemptId);
    assert.ok(job.envelopeDigest);
    const ledger = createRunLedger({ stateDir, workspaceRoot: stateDir });
    assert.equal(ledger.getExecutionEnvelope(job.id)?.envelope.execution.id, "text.echo");
    assert.equal(ledger.getExecutionAttempt(job.executionAttemptId)?.state, "completed");
    const retryResponse = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "job_gateway_retry" },
      body: JSON.stringify({ task: { tool: "workspace.readText", input: { path: "missing-retry-fixture.txt" } } })
    });
    assert.equal(retryResponse.status, 202);
    let retriedJob: any;
    const retryDeadline = Date.now() + 30_000;
    while (Date.now() < retryDeadline) {
      retriedJob = await (await fetch(`${base}/jobs/job_gateway_retry`)).json();
      if (retriedJob.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(retriedJob.status, "failed");
    assert.equal(retriedJob.attempts, 3);
    assert.deepEqual(ledger.listExecutionAttempts("job_gateway_retry").map((attempt) => attempt.state), ["failed", "failed", "failed"]);

    const approvalSubmission = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "job_gateway_cancel_approval" },
      body: JSON.stringify({ task: { tool: "browser.click", input: { tabId: "tab_fixture", selector: "#apply" } } })
    });
    assert.equal(approvalSubmission.status, 202);
    let approvalJob: any;
    const approvalDeadline = Date.now() + 10_000;
    while (Date.now() < approvalDeadline) {
      approvalJob = await (await fetch(`${base}/jobs/job_gateway_cancel_approval`)).json();
      if (approvalJob.status === "awaiting-approval") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(approvalJob.status, "awaiting-approval");
    const pendingApproval = (await (await fetch(`${base}/approvals`)).json()).find((approval: any) => approval.runId === approvalJob.id);
    assert.ok(pendingApproval?.id);
    const cancelledApproval = await fetch(`${base}/jobs/${approvalJob.id}/cancel`, { method: "POST" });
    assert.equal(cancelledApproval.status, 200);
    assert.equal((await cancelledApproval.json()).job.status, "cancelled");
    assert.equal((await (await fetch(`${base}/approvals`)).json()).some((approval: any) => approval.id === pendingApproval.id), false);
    const lateApproval = await fetch(`${base}/approvals/${pendingApproval.id}/approve`, { method: "POST" });
    assert.equal(lateApproval.status, 404);
    ledger.close();
    await assert.rejects(() => access(join(stateDir, "jobs.json")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("gateway rejects disabled agent graphs before durable job admission", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-agent-graph-disabled-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const response = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "disabled_agent_graph" },
      body: JSON.stringify({ kind: "agent-graph", task: { tool: "agent.delegate", input: {} } })
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /agent graph execution is disabled/u);
    const jobs = await (await fetch(`${base}/jobs`)).json();
    assert.equal(jobs.jobs.some((job: any) => job.id === "disabled_agent_graph"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("gateway rejects enabled agent graphs without explicit parent capabilities", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-agent-graph-capabilities-"));
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify({
    version: 1,
    runtime: { enableAgentGraphs: true },
    channels: {}
  }, null, 2)}\n`, { mode: 0o600 });
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const response = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "missing_graph_capabilities" },
      body: JSON.stringify({ kind: "agent-graph", task: { tool: "agent.delegate", input: {} } })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /parentCapabilities/u);
    assert.equal((await (await fetch(`${base}/jobs`)).json()).jobs.some((job: any) => job.id === "missing_graph_capabilities"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("gateway runs one explicitly enabled read-only agent graph through durable admission and audit", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-agent-graph-"));
  const provider = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    for await (const _chunk of request) {
      // Consume the complete bounded request before writing the deterministic response.
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "graph-child-response",
      choices: [{ message: { role: "assistant", content: "PRIVATE_GRAPH_PROVIDER_OUTPUT" } }],
      usage: { total_tokens: 3 }
    }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerPort = (provider.address() as any).port;
  const configPath = join(stateDir, "config.json");
  const previousKey = process.env.ODINN_STAGE7_PROVIDER_API_KEY;
  process.env.ODINN_STAGE7_PROVIDER_API_KEY = "stage7-test-key";
  const manifest = validateExecutableAgentManifest(JSON.stringify({
    schemaVersion: 1,
    id: "reader",
    revision: 1,
    registryRef: AGENT_GRAPH_REGISTRY_REF,
    requestedTools: ["text.echo"],
    requestedCapabilities: ["workspace.inspect"],
    maxChildren: 1,
    defaultTimeoutMs: 120_000
  }));
  const graph = validateAgentRunGraph(JSON.stringify({
    schemaVersion: 1,
    id: "one-child",
    nodes: [{ id: "child", manifestId: manifest.id, manifestDigest: manifest.manifestDigest, inputRef: "input:child", resultRef: "result:child", dependsOn: [] }]
  }));
  await mkdir(stateDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    version: 1,
    runtime: { enableAgentGraphs: true },
    defaultModel: "test:test-model",
    providers: { test: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKeyEnv: "ODINN_STAGE7_PROVIDER_API_KEY", models: ["test-model"] } },
    channels: {}
  }, null, 2)}\n`, { mode: 0o600 });
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const submission = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "stage7_graph_job" },
      body: JSON.stringify({ kind: "agent-graph", parentCapabilities: ["agent.delegate", "network.access", "workspace.inspect"], task: {
        tool: "agent.delegate",
        input: {
          graph: JSON.stringify(graph),
          manifests: JSON.stringify([manifest]),
          principalNamespace: "operator",
          inputs: { "input:child": { prompt: "PRIVATE_GRAPH_PROMPT", model: "test:test-model", maxTurns: 1, maxTokens: 128 } }
        }
      } })
    });
    assert.equal(submission.status, 202);
    let job: any;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      job = await (await fetch(`${base}/jobs/stage7_graph_job`)).json();
      if (["completed", "failed", "needs-review"].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(job.status, "completed");
    assert.equal(job.result.terminalStatus, "completed");
    assert.equal(job.result.output.status, "completed");
    assert.equal(job.result.output.nodes[0].status, "completed");
    assert.doesNotMatch(JSON.stringify(job), /PRIVATE_GRAPH_PROVIDER_OUTPUT|PRIVATE_GRAPH_PROMPT/u);
    const graphRunId = job.result.output.graphRunId;
    const ledger = createRunLedger({ stateDir, workspaceRoot: stateDir });
    try {
      const graphRun = ledger.getAgentGraphRun(graphRunId);
      assert.equal(graphRun?.status, "completed");
      assert.equal(graphRun?.nodes[0]?.status, "completed");
      assert.match(graphRun?.principalNamespace ?? "", /^sha256:[a-f0-9]{64}$/u);
      assert.ok(graphRun?.nodes[0]?.executionAttemptId);
      assert.equal(ledger.getExecutionEnvelope(job.id)?.envelope.execution.kind, "agent");
    } finally {
      ledger.close();
    }
    const audit = await (await fetch(`${base}/audit`)).json();
    assert.ok(audit.some((event: any) => event.type === "agent.graph.validated" && event.runId === job.id));
    assert.ok(audit.some((event: any) => event.type === "agent.graph.node.started" && event.runId === job.id));
    assert.ok(audit.some((event: any) => event.type === "agent.graph.completed" && event.runId === job.id));
    const childRunId = String(job.result.output.nodes[0].auditRef).slice("audit:".length);
    assert.ok(audit.some((event: any) => event.runId === childRunId && event.type === "task.completed"));
    assert.doesNotMatch(JSON.stringify(audit), /PRIVATE_GRAPH_PROVIDER_OUTPUT|PRIVATE_GRAPH_PROMPT/u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    if (previousKey === undefined) delete process.env.ODINN_STAGE7_PROVIDER_API_KEY;
    else process.env.ODINN_STAGE7_PROVIDER_API_KEY = previousKey;
  }
});

test("gateway serves completed agent.run channel output only through the ephemeral result route", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-channel-result-"));
  const provider = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    for await (const _chunk of request) {
      // Consume the complete bounded request before writing the deterministic response.
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "channel-response",
      choices: [{ message: { role: "assistant", content: "PRIVATE_CHANNEL_OUTPUT" } }],
      usage: { total_tokens: 2 }
    }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerPort = (provider.address() as any).port;
  const previousKey = process.env.ODINN_STAGE7_CHANNEL_API_KEY;
  process.env.ODINN_STAGE7_CHANNEL_API_KEY = "stage7-channel-key";
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify({
    version: 1,
    defaultModel: "test:test-model",
    providers: { test: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKeyEnv: "ODINN_STAGE7_CHANNEL_API_KEY", models: ["test-model"] } },
    channels: {}
  }, null, 2)}\n`, { mode: 0o600 });
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const executionKey = "stage7-channel-result";
    const submission = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": executionKey },
      body: JSON.stringify({
        executionKey,
        task: { tool: "agent.run", input: { model: "test:test-model", prompt: "PRIVATE_CHANNEL_PROMPT", maxTurns: 1, maxTokens: 128 } }
      })
    });
    assert.equal(submission.status, 202);
    let job: any;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      job = await (await fetch(`${base}/jobs/${executionKey}`)).json();
      if (["completed", "failed", "needs-review"].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(job.status, "completed");
    assert.doesNotMatch(JSON.stringify(job), /PRIVATE_CHANNEL_OUTPUT|PRIVATE_CHANNEL_PROMPT/u);

    const result = await fetch(`${base}/jobs/${executionKey}/result`);
    assert.equal(result.status, 200);
    const resultBody = await result.json();
    assert.equal(resultBody.ok, true);
    assert.equal(resultBody.result.output.content, "PRIVATE_CHANNEL_OUTPUT");
    assert.doesNotMatch(JSON.stringify(resultBody), /PRIVATE_CHANNEL_PROMPT/u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    if (previousKey === undefined) delete process.env.ODINN_STAGE7_CHANNEL_API_KEY;
    else process.env.ODINN_STAGE7_CHANNEL_API_KEY = previousKey;
  }
});

test("durable graph node transitions cannot be overwritten after quarantine or parent cancellation", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-graph-transitions-"));
  const ledger = createRunLedger({ stateDir, workspaceRoot: stateDir });
  const digestValue = "a".repeat(64);
  const node = { nodeId: "first", manifestId: "reader", manifestDigest: digestValue, inputRef: "input:first", inputDigest: digestValue, resultRef: "result:first", dependsOn: [] };
  try {
    ledger.ensureRun({ runId: "parent-late", objective: "parent" });
    ledger.createAgentGraphRun({
      graphRunId: "graph:late", parentRunId: "parent-late", graphDigest: digestValue, manifestsDigest: digestValue,
      graphBytes: 12, manifestsBytes: 12, principalNamespace: "operator", requestDigest: digestValue, maxConcurrency: 3, maxRunMs: 1_000, nodes: [node]
    });
    assert.equal(ledger.getAgentGraphRun("graph:late")?.maxConcurrency, 3);
    assert.throws(
      () => ledger.createAgentGraphRun({
        graphRunId: "graph:late", parentRunId: "parent-late", graphDigest: digestValue, manifestsDigest: digestValue,
        graphBytes: 12, manifestsBytes: 12, principalNamespace: "operator", requestDigest: digestValue, maxConcurrency: 2, maxRunMs: 1_000, nodes: [node]
      }),
      (error: any) => error?.code === "AGENT_GRAPH_IDEMPOTENCY_CONFLICT"
    );
    ledger.recordAgentGraphNodeResult({ graphRunId: "graph:late", nodeId: "first", status: "completed", nodeCallId: "call:stale", requestDigest: digestValue, resultDigest: digestValue });
    assert.equal(ledger.getAgentGraphRun("graph:late")?.nodes[0]?.status, "queued");
    assert.throws(
      () => ledger.startAgentGraphNode({ graphRunId: "graph:late", nodeId: "first", nodeCallId: "call:first", requestDigest: digestValue, executionRunId: "child:first", executionAttemptId: "attempt:first", resultRef: "result:forged", auditRef: "audit:child:first" }),
      (error: any) => error?.code === "AGENT_GRAPH_STALE_DISPATCH"
    );
    ledger.startAgentGraphNode({ graphRunId: "graph:late", nodeId: "first", nodeCallId: "call:first", requestDigest: digestValue, executionRunId: "child:first", executionAttemptId: "attempt:first", resultRef: "result:first", auditRef: "audit:child:first" });
    ledger.recordAgentGraphNodeResult({ graphRunId: "graph:late", nodeId: "first", status: "completed", nodeCallId: "call:first", requestDigest: digestValue, executionRunId: "child:forged", executionAttemptId: "attempt:forged", resultDigest: digestValue, resultRef: "result:forged", auditRef: "audit:forged" });
    assert.equal(ledger.getAgentGraphRun("graph:late")?.nodes[0]?.status, "running");
    ledger.recordAgentGraphNodeResult({ graphRunId: "graph:late", nodeId: "first", status: "needs-review", nodeCallId: "call:first", requestDigest: digestValue, executionRunId: "child:first", executionAttemptId: "attempt:first", resultDigest: digestValue, resultRef: "result:first", auditRef: "audit:child:first", errorCode: "CHILD_UNCERTAIN" });
    ledger.recordAgentGraphNodeResult({ graphRunId: "graph:late", nodeId: "first", status: "completed", resultDigest: digestValue, executionRunId: "child:first", executionAttemptId: "attempt:first", resultRef: "result:first", auditRef: "audit:child:first" });
    assert.equal(ledger.getAgentGraphRun("graph:late")?.nodes[0]?.status, "needs-review");

    ledger.ensureRun({ runId: "parent-cancel", objective: "parent" });
    ledger.createAgentGraphRun({
      graphRunId: "graph:cancel", parentRunId: "parent-cancel", graphDigest: digestValue, manifestsDigest: digestValue,
      graphBytes: 12, manifestsBytes: 12, principalNamespace: "operator", requestDigest: digestValue, maxRunMs: 1_000, nodes: [node]
    });
    const jobs = new SqliteJobStore(ledger);
    await jobs.create({
      id: "job:cancel", status: "cancelled", payload: { task: { id: "parent-cancel", tool: "text.echo", input: { text: "x" } } },
      attempts: 0, timeoutMs: 1_000, retrySafe: false
    });
    ledger.reconcileAgentGraphRuns();
    assert.equal(ledger.getAgentGraphRun("graph:cancel")?.status, "cancelled");
    assert.equal(ledger.getAgentGraphRun("graph:cancel")?.nodes[0]?.status, "cancelled");
    ledger.completeAgentGraphRun({ graphRunId: "graph:cancel", status: "completed" });
    assert.equal(ledger.getAgentGraphRun("graph:cancel")?.status, "cancelled");

    ledger.ensureRun({ runId: "parent-unsettled", objective: "parent" });
    ledger.createAgentGraphRun({
      graphRunId: "graph:unsettled", parentRunId: "parent-unsettled", graphDigest: digestValue, manifestsDigest: digestValue,
      graphBytes: 12, manifestsBytes: 12, principalNamespace: "operator", requestDigest: digestValue, maxRunMs: 1_000, nodes: [node]
    });
    const quarantined = ledger.completeAgentGraphRun({ graphRunId: "graph:unsettled", status: "needs-review", errorCode: "GRAPH_OUTCOME_UNCERTAIN" });
    assert.equal(quarantined.status, "needs-review");
    assert.equal(ledger.getAgentGraphRun("graph:unsettled")?.status, "needs-review");
    assert.equal(ledger.getAgentGraphRun("graph:unsettled")?.nodes[0]?.status, "needs-review");

    ledger.ensureRun({ runId: "parent-terminal", objective: "parent" });
    ledger.createAgentGraphRun({
      graphRunId: "graph:terminal", parentRunId: "parent-terminal", graphDigest: digestValue, manifestsDigest: digestValue,
      graphBytes: 12, manifestsBytes: 12, principalNamespace: "operator", requestDigest: digestValue, maxRunMs: 1_000, nodes: [node]
    });
    ledger.database.db.prepare("UPDATE agent_graph_runs SET status='completed', completed_at=? WHERE id=?").run(new Date().toISOString(), "graph:terminal");
    ledger.reconcileAgentGraphRuns();
    assert.equal(ledger.getAgentGraphRun("graph:terminal")?.status, "needs-review");
    assert.equal(ledger.getAgentGraphRun("graph:terminal")?.nodes[0]?.status, "needs-review");

    ledger.ensureRun({ runId: "parent-publishing", objective: "parent" });
    ledger.createAgentGraphRun({
      graphRunId: "graph:publishing", parentRunId: "parent-publishing", graphDigest: digestValue, manifestsDigest: digestValue,
      graphBytes: 12, manifestsBytes: 12, principalNamespace: "operator", requestDigest: digestValue, maxRunMs: 1_000, nodes: [node]
    });
    ledger.beginAgentGraphCompletion({ graphRunId: "graph:publishing" });
    assert.equal(ledger.getAgentGraphRun("graph:publishing")?.status, "publishing");
    ledger.reconcileAgentGraphRuns();
    assert.equal(ledger.getAgentGraphRun("graph:publishing")?.status, "needs-review");
    assert.equal(ledger.getAgentGraphRun("graph:publishing")?.nodes[0]?.status, "needs-review");

    ledger.ensureRun({ runId: "parent-blocked", objective: "parent" });
    const dependent = { ...node, nodeId: "second", inputRef: "input:second", inputDigest: digestValue, resultRef: "result:second", dependsOn: ["first"] };
    ledger.createAgentGraphRun({
      graphRunId: "graph:blocked", parentRunId: "parent-blocked", graphDigest: digestValue, manifestsDigest: digestValue,
      graphBytes: 12, manifestsBytes: 12, principalNamespace: "operator", requestDigest: digestValue, maxConcurrency: 2, maxRunMs: 1_000, nodes: [node, dependent]
    });
    ledger.recordAgentGraphNodeResult({ graphRunId: "graph:blocked", nodeId: "second", status: "blocked", resultRef: "result:second", errorCode: "DEPENDENCY_FAILED" });
    assert.equal(ledger.getAgentGraphRun("graph:blocked")?.nodes.find((item: any) => item.nodeId === "second")?.status, "blocked");
  } finally {
    ledger.close();
  }
});

test("gateway startup reconciles a publishing graph into matching signed recovery evidence", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-graph-recovery-"));
  const digestValue = "b".repeat(64);
  const node = { nodeId: "first", manifestId: "reader", manifestDigest: digestValue, inputRef: "input:first", inputDigest: digestValue, resultRef: "result:first", dependsOn: [] };
  const ledger = createRunLedger({ stateDir, workspaceRoot: stateDir });
  ledger.ensureRun({ runId: "parent-recovery", objective: "parent" });
  ledger.createAgentGraphRun({
    graphRunId: "graph:recovery", parentRunId: "parent-recovery", graphDigest: digestValue, manifestsDigest: digestValue,
    graphBytes: 12, manifestsBytes: 12, principalNamespace: "operator", requestDigest: digestValue, maxRunMs: 1_000, nodes: [node]
  });
  ledger.beginAgentGraphCompletion({ graphRunId: "graph:recovery" });
  ledger.close();
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const audit = createAuditStore(join(stateDir, "audit.jsonl"));
    try {
      const events = await audit.readAll();
      assert.ok(events.some((event: any) => event.type === "agent.graph.needs-review" && event.runId === "parent-recovery" && event.data?.graphRunId === "graph:recovery" && event.data?.recovered === true));
    } finally {
      audit.close();
    }
    const recovered = createRunLedger({ stateDir, workspaceRoot: stateDir });
    try {
      assert.equal(recovered.getAgentGraphRun("graph:recovery")?.status, "needs-review");
      assert.ok(recovered.getRun("parent-recovery")?.events.some((event: any) => event.type === "agent-graph-needs-review" && event.payload?.graphRunId === "graph:recovery"));
    } finally {
      recovered.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
