process.env.ODINN_GATEWAY_AUTH = "off";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayServer } from "../apps/gateway/src/server.ts";
import { withGatewayTestHooks } from "../apps/gateway/src/testing.ts";
import { createAuditStore, createRunLedger, SqliteJobStore, SqliteRecordStore } from "../packages/kernel/src/index.ts";
import { digestAgentRunValue, validateAgentRunGraph, validateExecutableAgentManifest } from "../packages/kernel/src/agent-run-graphs.ts";
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
  let failGraphControlAudit: "cancel" | "reassign" | "checkpoint" | undefined;
  let lastGraphControlError: unknown;
  let signalReassignmentAuditEntered!: () => void;
  let releaseReassignmentAudit!: () => void;
  const reassignmentAuditEntered = new Promise<void>((resolve) => { signalReassignmentAuditEntered = resolve; });
  const reassignmentAuditRelease = new Promise<void>((resolve) => { releaseReassignmentAudit = resolve; });
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
    experimental: { capabilities: true },
    policy: { allowedCapabilities: ["agent.delegate", "network.access", "workspace.inspect", "workspace.mutate"] },
    defaultModel: "test:test-model",
    providers: { test: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKeyEnv: "ODINN_STAGE7_PROVIDER_API_KEY", models: ["test-model"] } },
    channels: {}
  }, null, 2)}\n`, { mode: 0o600 });
  const server = await createGatewayServer(withGatewayTestHooks(
    { stateDir, workspaceRoot: stateDir },
    {
      beforeAgentGraphControlAudit: async ({ action, operationId }) => {
        if (action === "reassign" && operationId === "reassign:stage7_race_replacement") {
          signalReassignmentAuditEntered();
          await reassignmentAuditRelease;
        }
        if (action === failGraphControlAudit) throw new Error(`injected ${action} audit failure`);
      },
      onRequestError: ({ error }) => { lastGraphControlError = error; }
    }
  ));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const graphCapability = await (await fetch(`${base}/capabilities/issue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "stage7_graph_job", stepId: "stage7-graph", toolName: "agent.delegate" })
    })).json();
    const submission = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "stage7_graph_job" },
      body: JSON.stringify({ kind: "agent-graph", parentCapabilities: ["agent.delegate", "network.access", "workspace.inspect", "workspace.mutate"], task: {
        tool: "agent.delegate",
        input: {
          graph: JSON.stringify(graph),
          manifests: JSON.stringify([manifest]),
          principalNamespace: "operator",
          capabilityToken: graphCapability.token,
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
    const graphList = await (await fetch(`${base}/agent-graphs?status=completed&parentRunId=${encodeURIComponent(job.id)}`)).json();
    assert.equal(graphList.graphs.length, 1);
    assert.equal(graphList.graphs[0].graphRunId, graphRunId);
    assert.equal(graphList.graphs[0].maxConcurrency, 1);
    assert.equal(graphList.graphs[0].nodes[0].resultRef, "result:child");
    assert.match(graphList.graphs[0].nodes[0].resultDigest, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(graphList), /PRIVATE_GRAPH_PROVIDER_OUTPUT|PRIVATE_GRAPH_PROMPT/u);

    const graphDetail = await fetch(`${base}/agent-graphs/${encodeURIComponent(graphRunId)}`);
    assert.equal(graphDetail.status, 200);
    assert.equal((await graphDetail.json()).graph.requestDigest, graphList.graphs[0].requestDigest);

    const checkpointRunId = "stage7_graph_checkpoint_preview";
    const checkpointCapability = await (await fetch(`${base}/capabilities/issue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: checkpointRunId,
        stepId: "stage7-graph-checkpoint",
        toolName: "workspace.mutate",
        scopes: ["workspace:mutate"]
      })
    })).json();
    const staleCheckpoint = await fetch(`${base}/agent-graphs/${encodeURIComponent(graphRunId)}/checkpoint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "stage7_graph_checkpoint_stale",
        nodeId: "child",
        expectedResultDigest: "0".repeat(64),
        tool: "workspace.mutate",
        operation: "write",
        path: "must-not-exist.txt",
        content: "stale"
      })
    });
    assert.equal(staleCheckpoint.status, 409);
    const blockedCheckpointRunId = "stage7_graph_checkpoint_audit_blocked";
    const blockedCheckpointCapability = await (await fetch(`${base}/capabilities/issue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: blockedCheckpointRunId,
        stepId: "stage7-graph-checkpoint-audit-blocked",
        toolName: "workspace.mutate",
        scopes: ["workspace:mutate"]
      })
    })).json();
    failGraphControlAudit = "checkpoint";
    const auditBlockedCheckpoint = await fetch(`${base}/agent-graphs/${encodeURIComponent(graphRunId)}/checkpoint`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": blockedCheckpointRunId },
      body: JSON.stringify({
        runId: blockedCheckpointRunId,
        nodeId: "child",
        expectedResultDigest: graphList.graphs[0].nodes[0].resultDigest,
        tool: "workspace.mutate",
        operation: "write",
        path: "audit-blocked-child-checkpoint.txt",
        content: "must not execute",
        apply: true,
        capabilityToken: blockedCheckpointCapability.token
      })
    });
    const auditBlockedCheckpointBody = await auditBlockedCheckpoint.json();
    assert.equal(auditBlockedCheckpoint.status, 400, JSON.stringify(auditBlockedCheckpointBody));
    assert.match(String(lastGraphControlError), /injected checkpoint audit failure/u);
    await assert.rejects(() => access(join(stateDir, "audit-blocked-child-checkpoint.txt")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    assert.equal((await (await fetch(`${base}/jobs`)).json()).jobs.some((candidate: any) => candidate.id === blockedCheckpointRunId), false);
    failGraphControlAudit = undefined;
    const checkpoint = await fetch(`${base}/agent-graphs/${encodeURIComponent(graphRunId)}/checkpoint`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": checkpointRunId },
      body: JSON.stringify({
        runId: checkpointRunId,
        nodeId: "child",
        expectedResultDigest: graphList.graphs[0].nodes[0].resultDigest,
        tool: "workspace.mutate",
        operation: "write",
        path: "child-checkpoint.txt",
        content: "bounded child result",
        capabilityToken: checkpointCapability.token
      })
    });
    assert.equal(checkpoint.status, 200);
    const checkpointBody = await checkpoint.json();
    assert.equal(checkpointBody.result.output.preview, true);
    assert.notEqual(checkpointBody.result.output.applied, true);
    await assert.rejects(() => access(join(stateDir, "child-checkpoint.txt")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");

    const failedParentRunId = "stage7_graph_failed_parent";
    const failedGraphRunId = "graph:stage7-failed-fixture";
    const failedRequestDigest = "d".repeat(64);
    const activeParentRunId = "stage7_graph_active_parent";
    const activeParentGraphRunId = "graph:stage7-active-parent-fixture";
    const activeParentRequestDigest = "3".repeat(64);
    const leasedParentRunId = "stage7_graph_leased_parent";
    const leasedParentGraphRunId = "graph:stage7-leased-parent-fixture";
    const leasedParentRequestDigest = "4".repeat(64);
    const foreignParentRunId = "stage7_graph_foreign_parent";
    const foreignParentGraphRunId = "graph:stage7-foreign-parent-fixture";
    const foreignParentRequestDigest = "7".repeat(64);
    const raceParentRunId = "stage7_graph_race_parent";
    const raceGraphRunId = "graph:stage7-race-fixture";
    const raceRequestDigest = "8".repeat(64);
    const staleIntentParentRunId = "stage7_graph_stale_intent_parent";
    const staleIntentGraphRunId = "graph:stage7-stale-intent-fixture";
    const staleIntentRequestDigest = "9".repeat(64);
    const conflictingIntentParentRunId = "stage7_graph_conflicting_intent_parent";
    const conflictingIntentGraphRunId = "graph:stage7-conflicting-intent-fixture";
    const conflictingIntentRequestDigest = "a".repeat(64);
    const fixtureLedger = createRunLedger({ stateDir, workspaceRoot: stateDir });
    try {
      fixtureLedger.ensureRun({ runId: failedParentRunId, objective: "failed graph fixture" });
      fixtureLedger.createAgentGraphRun({
        graphRunId: failedGraphRunId,
        parentRunId: failedParentRunId,
        graphDigest: graph.graphDigest,
        manifestsDigest: "c".repeat(64),
        graphBytes: Buffer.byteLength(JSON.stringify(graph)),
        manifestsBytes: Buffer.byteLength(JSON.stringify([manifest])),
        principalNamespace: `sha256:${digestAgentRunValue("operator")}`,
        requestDigest: failedRequestDigest,
        maxConcurrency: 1,
        maxRunMs: 120_000,
        nodes: [{
          nodeId: "child",
          manifestId: manifest.id,
          manifestDigest: manifest.manifestDigest,
          inputRef: "input:child",
          inputDigest: "e".repeat(64),
          resultRef: "result:child",
          dependsOn: []
        }]
      });
      fixtureLedger.completeAgentGraphRun({ graphRunId: failedGraphRunId, status: "failed", errorCode: "FIXTURE_FAILED" });
      const jobs = new SqliteJobStore(fixtureLedger);
      await jobs.create({
        id: failedParentRunId,
        status: "failed",
        payload: {
          scope: { tenantId: "tenant:local", principalId: "local-gateway-user" },
          parentCapabilities: ["agent.delegate", "network.access", "workspace.inspect", "workspace.mutate"],
          task: { id: failedParentRunId, tool: "agent.delegate", input: { principalNamespace: "operator" } }
        },
        attempts: 1,
        timeoutMs: 150_000,
        retrySafe: false,
        error: "fixture failure"
      });
      const cancellationParentRunId = "stage7_graph_cancel_parent";
      const cancellationGraphRunId = "graph:stage7-cancel-fixture";
      fixtureLedger.ensureRun({ runId: cancellationParentRunId, objective: "graph cancellation fixture" });
      fixtureLedger.createAgentGraphRun({
        graphRunId: cancellationGraphRunId,
        parentRunId: cancellationParentRunId,
        graphDigest: graph.graphDigest,
        manifestsDigest: "f".repeat(64),
        graphBytes: Buffer.byteLength(JSON.stringify(graph)),
        manifestsBytes: Buffer.byteLength(JSON.stringify([manifest])),
        principalNamespace: `sha256:${digestAgentRunValue("operator")}`,
        requestDigest: "1".repeat(64),
        maxConcurrency: 1,
        maxRunMs: 120_000,
        nodes: [{
          nodeId: "child",
          manifestId: manifest.id,
          manifestDigest: manifest.manifestDigest,
          inputRef: "input:child",
          inputDigest: "2".repeat(64),
          resultRef: "result:child",
          dependsOn: []
        }]
      });
      await jobs.create({
        id: cancellationParentRunId,
        status: "queued",
        payload: {
          scope: { tenantId: "tenant:local", principalId: "local-gateway-user" },
          parentCapabilities: ["agent.delegate", "network.access", "workspace.inspect"],
          task: { id: cancellationParentRunId, tool: "agent.delegate", input: { principalNamespace: "operator" } }
        },
        attempts: 0,
        timeoutMs: 150_000,
        retrySafe: false
      });
      const createFailedFixture = async ({ parentRunId, graphRunId: fixtureGraphRunId, requestDigest, parentStatus }: {
        parentRunId: string;
        graphRunId: string;
        requestDigest: string;
        parentStatus: "cancelling" | "queued" | "failed";
      }) => {
        fixtureLedger.ensureRun({ runId: parentRunId, objective: "agent graph reassignment fence fixture" });
        fixtureLedger.createAgentGraphRun({
          graphRunId: fixtureGraphRunId,
          parentRunId,
          graphDigest: graph.graphDigest,
          manifestsDigest: "5".repeat(64),
          graphBytes: Buffer.byteLength(JSON.stringify(graph)),
          manifestsBytes: Buffer.byteLength(JSON.stringify([manifest])),
          principalNamespace: `sha256:${digestAgentRunValue("operator")}`,
          requestDigest,
          maxConcurrency: 1,
          maxRunMs: 120_000,
          nodes: [{
            nodeId: "child",
            manifestId: manifest.id,
            manifestDigest: manifest.manifestDigest,
            inputRef: "input:child",
            inputDigest: "6".repeat(64),
            resultRef: "result:child",
            dependsOn: []
          }]
        });
        fixtureLedger.completeAgentGraphRun({ graphRunId: fixtureGraphRunId, status: "failed", errorCode: "FIXTURE_FAILED" });
        await jobs.create({
          id: parentRunId,
          status: parentStatus,
          payload: {
            scope: { tenantId: "tenant:local", principalId: "local-gateway-user" },
            parentCapabilities: ["agent.delegate", "network.access", "workspace.inspect"],
            task: { id: parentRunId, tool: "agent.delegate", input: { principalNamespace: "operator" } }
          },
          attempts: parentStatus === "queued" ? 0 : 1,
          timeoutMs: 150_000,
          retrySafe: false,
          ...(parentStatus === "failed" ? { error: "fixture failure" } : {})
        });
      };
      await createFailedFixture({
        parentRunId: activeParentRunId,
        graphRunId: activeParentGraphRunId,
        requestDigest: activeParentRequestDigest,
        parentStatus: "cancelling"
      });
      await createFailedFixture({
        parentRunId: leasedParentRunId,
        graphRunId: leasedParentGraphRunId,
        requestDigest: leasedParentRequestDigest,
        parentStatus: "failed"
      });
      await createFailedFixture({
        parentRunId: foreignParentRunId,
        graphRunId: foreignParentGraphRunId,
        requestDigest: foreignParentRequestDigest,
        parentStatus: "failed"
      });
      await createFailedFixture({
        parentRunId: raceParentRunId,
        graphRunId: raceGraphRunId,
        requestDigest: raceRequestDigest,
        parentStatus: "failed"
      });
      await createFailedFixture({
        parentRunId: staleIntentParentRunId,
        graphRunId: staleIntentGraphRunId,
        requestDigest: staleIntentRequestDigest,
        parentStatus: "failed"
      });
      await createFailedFixture({
        parentRunId: conflictingIntentParentRunId,
        graphRunId: conflictingIntentGraphRunId,
        requestDigest: conflictingIntentRequestDigest,
        parentStatus: "failed"
      });
      const foreignParent = await jobs.get(foreignParentRunId);
      assert.ok(foreignParent);
      fixtureLedger.database.db.prepare("UPDATE runtime_jobs SET payload_json=? WHERE id=?")
        .run(JSON.stringify({
          ...foreignParent.payload,
          scope: { tenantId: "tenant:local", principalId: "different-host-user" }
        }), foreignParentRunId);
      const leaseAcquiredAt = new Date().toISOString();
      const leaseExpiresAt = new Date(Date.now() + 120_000).toISOString();
      fixtureLedger.database.db.prepare(`INSERT INTO runtime_job_leases(
        token, job_id, occurrence_key, owner, epoch, acquired_at, expires_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?)`).run(
        "stage7-live-lease",
        leasedParentRunId,
        "remote-gateway",
        "remote-epoch",
        leaseAcquiredAt,
        leaseExpiresAt
      );
      await jobs.create({
        id: "stage7_hashless_replacement_target",
        status: "completed",
        payload: {
          scope: { tenantId: "tenant:local", principalId: "local-gateway-user" },
          task: { id: "stage7_hashless_replacement_target", tool: "text.echo", input: { text: "unrelated" } }
        },
        attempts: 1,
        timeoutMs: 10_000,
        retrySafe: true,
        result: { output: { text: "unrelated" } }
      });
    } finally {
      fixtureLedger.close();
    }
    failGraphControlAudit = "cancel";
    const rejectedCancellation = await fetch(`${base}/agent-graphs/${encodeURIComponent("graph:stage7-cancel-fixture")}/cancel`, { method: "POST" });
    assert.equal(rejectedCancellation.status, 400);
    assert.match(String(lastGraphControlError), /injected cancel audit failure/u);
    assert.equal((await (await fetch(`${base}/jobs/${encodeURIComponent("stage7_graph_cancel_parent")}`)).json()).status, "queued");
    assert.equal((await (await fetch(`${base}/agent-graphs/${encodeURIComponent("graph:stage7-cancel-fixture")}`)).json()).graph.status, "validated");
    failGraphControlAudit = undefined;
    const cancellation = await fetch(`${base}/agent-graphs/${encodeURIComponent("graph:stage7-cancel-fixture")}/cancel`, { method: "POST" });
    assert.equal(cancellation.status, 200);
    const cancellationBody = await cancellation.json();
    assert.equal(cancellationBody.job.status, "cancelled");
    assert.equal(cancellationBody.graph.status, "needs-review");
    assert.equal(cancellationBody.graph.nodes[0].status, "needs-review");
    const replacementCapability = await (await fetch(`${base}/capabilities/issue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "stage7_graph_reassigned", stepId: "stage7-graph-reassigned", toolName: "agent.delegate" })
    })).json();
    const replacement = {
      kind: "agent-graph",
      id: "stage7_graph_reassigned",
      parentCapabilities: ["agent.delegate", "network.access", "workspace.inspect"],
      task: {
        tool: "agent.delegate",
        input: {
          graph: JSON.stringify(graph),
          manifests: JSON.stringify([manifest]),
          principalNamespace: "operator",
          capabilityToken: replacementCapability.token,
          inputs: { "input:child": { prompt: "PRIVATE_REASSIGNED_GRAPH_PROMPT", model: "test:test-model", maxTurns: 1, maxTokens: 128 } }
        }
      }
    };
    const attemptFixtureReassignment = (fixtureGraphRunId: string, requestDigest: string, replacementId: string) => fetch(
      `${base}/agent-graphs/${encodeURIComponent(fixtureGraphRunId)}/reassign`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": replacementId },
        body: JSON.stringify({
          expectedRequestDigest: requestDigest,
          replacement: { ...replacement, id: replacementId }
        })
      }
    );
    const activeParentReassignment = await attemptFixtureReassignment(
      activeParentGraphRunId,
      activeParentRequestDigest,
      "stage7_active_parent_replacement"
    );
    assert.equal(activeParentReassignment.status, 409);
    assert.match((await activeParentReassignment.json()).error, /parent job has not reached a terminal state/u);
    const leasedParentReassignment = await attemptFixtureReassignment(
      leasedParentGraphRunId,
      leasedParentRequestDigest,
      "stage7_leased_parent_replacement"
    );
    assert.equal(leasedParentReassignment.status, 409);
    assert.match((await leasedParentReassignment.json()).error, /unexpired durable dispatch lease/u);
    const foreignParentReassignment = await attemptFixtureReassignment(
      foreignParentGraphRunId,
      foreignParentRequestDigest,
      "stage7_foreign_parent_replacement"
    );
    assert.equal(foreignParentReassignment.status, 403);
    assert.match((await foreignParentReassignment.json()).error, /trusted tenant and principal/u);
    const hashlessTarget = await attemptFixtureReassignment(
      failedGraphRunId,
      failedRequestDigest,
      "stage7_hashless_replacement_target"
    );
    assert.equal(hashlessTarget.status, 409);
    assert.match((await hashlessTarget.json()).error, /already bound to another durable job/u);
    const reassignmentUrl = `${base}/agent-graphs/${encodeURIComponent(failedGraphRunId)}/reassign`;
    const staleReassignment = await fetch(reassignmentUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRequestDigest: "0".repeat(64), replacement })
    });
    assert.equal(staleReassignment.status, 409);
    const wrongKind = await fetch(reassignmentUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRequestDigest: failedRequestDigest, replacement: { ...replacement, kind: "ordinary" } })
    });
    assert.equal(wrongKind.status, 400);
    const widened = await fetch(reassignmentUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRequestDigest: failedRequestDigest, replacement: { ...replacement, parentCapabilities: [...replacement.parentCapabilities, "workspace.patch"] } })
    });
    assert.equal(widened.status, 403);
    const substituted = await fetch(reassignmentUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRequestDigest: failedRequestDigest, replacement: { ...replacement, task: { ...replacement.task, input: { ...replacement.task.input, principalNamespace: "other-principal" } } } })
    });
    assert.equal(substituted.status, 403);

    const raceCapability = await (await fetch(`${base}/capabilities/issue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "stage7_race_replacement", stepId: "stage7-race-replacement", toolName: "agent.delegate" })
    })).json();
    const raceReplacement = {
      ...replacement,
      id: "stage7_race_replacement",
      task: {
        ...replacement.task,
        input: { ...replacement.task.input, capabilityToken: raceCapability.token }
      }
    };
    const racingReassignment = fetch(`${base}/agent-graphs/${encodeURIComponent(raceGraphRunId)}/reassign`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": raceReplacement.id },
      body: JSON.stringify({ expectedRequestDigest: raceRequestDigest, replacement: raceReplacement })
    });
    await Promise.race([
      reassignmentAuditEntered,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("reassignment audit hook was not reached")), 5_000))
    ]);
    try {
      const competingSubmission = await fetch(`${base}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": raceReplacement.id },
        body: JSON.stringify({ task: { tool: "text.echo", input: { text: "must not claim a reserved reassignment id" } } })
      });
      const competingBody = await competingSubmission.json();
      assert.equal(competingSubmission.status, 409, JSON.stringify(competingBody));
      assert.match(competingBody.error, /reserved for an exact agent graph reassignment/u);
    } finally {
      releaseReassignmentAudit();
    }
    const racingReassignmentResponse = await racingReassignment;
    const racingReassignmentBody = await racingReassignmentResponse.json();
    assert.equal(racingReassignmentResponse.status, 202, JSON.stringify(racingReassignmentBody));
    const raceLedger = createRunLedger({ stateDir, workspaceRoot: stateDir });
    try {
      assert.equal(raceLedger.getAgentGraphReassignment(raceGraphRunId)?.status, "submitted");
    } finally {
      raceLedger.close();
    }

    const staleIntentCapability = await (await fetch(`${base}/capabilities/issue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "stage7_stale_intent_replacement", stepId: "stage7-stale-intent", toolName: "agent.delegate" })
    })).json();
    const staleIntentReplacement = {
      ...replacement,
      id: "stage7_stale_intent_replacement",
      task: {
        ...replacement.task,
        input: { ...replacement.task.input, capabilityToken: staleIntentCapability.token }
      }
    };
    const invalidBeforeIntent = await fetch(`${base}/agent-graphs/${encodeURIComponent(staleIntentGraphRunId)}/reassign`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": staleIntentReplacement.id },
      body: JSON.stringify({
        expectedRequestDigest: staleIntentRequestDigest,
        replacement: { ...staleIntentReplacement, task: { ...staleIntentReplacement.task, tool: "text.echo" } }
      })
    });
    assert.equal(invalidBeforeIntent.status, 400);
    assert.match((await invalidBeforeIntent.json()).error, /kind=agent-graph requires task\.tool=agent\.delegate/u);
    const auditBeforeCorrectedIntent = await (await fetch(`${base}/audit`)).json();
    assert.equal(auditBeforeCorrectedIntent.some((event: any) => event.type === "agent.graph.reassignment.requested"
      && event.data?.operationId === `reassign:${staleIntentReplacement.id}`), false);
    const correctedIntent = await fetch(`${base}/agent-graphs/${encodeURIComponent(staleIntentGraphRunId)}/reassign`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": staleIntentReplacement.id },
      body: JSON.stringify({ expectedRequestDigest: staleIntentRequestDigest, replacement: staleIntentReplacement })
    });
    const correctedIntentBody = await correctedIntent.json();
    assert.equal(correctedIntent.status, 202, JSON.stringify(correctedIntentBody));
    const correctedIntentLedger = createRunLedger({ stateDir, workspaceRoot: stateDir });
    const correctedReservation = correctedIntentLedger.getAgentGraphReassignment(staleIntentGraphRunId);
    correctedIntentLedger.close();
    const auditAfterCorrectedIntent = await (await fetch(`${base}/audit`)).json();
    const correctedIntentEvents = auditAfterCorrectedIntent.filter((event: any) => event.type === "agent.graph.reassignment.requested"
      && event.data?.operationId === `reassign:${staleIntentReplacement.id}`);
    assert.equal(correctedIntentEvents.length, 1);
    assert.equal(correctedIntentEvents[0].actor, "local-gateway-user");
    assert.equal(correctedIntentEvents[0].data.replacementRequestHash, correctedReservation?.replacementRequestHash);
    assert.equal(correctedIntentEvents[0].data.replacementIdentityDigest, correctedReservation?.replacementIdentityDigest);
    assert.match(correctedIntentEvents[0].data.controlDigest, /^[a-f0-9]{64}$/u);

    const conflictingIntentId = "stage7_conflicting_intent_replacement";
    const staleAudit = createAuditStore(join(stateDir, "audit.jsonl"));
    try {
      await staleAudit.append({
        at: new Date().toISOString(),
        runId: conflictingIntentParentRunId,
        type: "agent.graph.reassignment.requested",
        actor: "local-gateway-user",
        tool: "agent.delegate",
        capability: "agent.delegate",
        decision: "allow",
        data: {
          graphRunId: conflictingIntentGraphRunId,
          operationId: `reassign:${conflictingIntentId}`,
          controlDigest: "0".repeat(64)
        }
      });
    } finally {
      staleAudit.close();
    }
    const conflictingIntentCapability = await (await fetch(`${base}/capabilities/issue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: conflictingIntentId, stepId: "stage7-conflicting-intent", toolName: "agent.delegate" })
    })).json();
    const conflictingIntent = await fetch(`${base}/agent-graphs/${encodeURIComponent(conflictingIntentGraphRunId)}/reassign`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": conflictingIntentId },
      body: JSON.stringify({
        expectedRequestDigest: conflictingIntentRequestDigest,
        replacement: {
          ...replacement,
          id: conflictingIntentId,
          task: {
            ...replacement.task,
            input: { ...replacement.task.input, capabilityToken: conflictingIntentCapability.token }
          }
        }
      })
    });
    const conflictingIntentBody = await conflictingIntent.json();
    assert.equal(conflictingIntent.status, 409, JSON.stringify(conflictingIntentBody));
    assert.match(conflictingIntentBody.error, /conflicts with the signed immutable request/u);
    assert.equal((await fetch(`${base}/jobs/${conflictingIntentId}`)).status, 404);
    const conflictingIntentLedger = createRunLedger({ stateDir, workspaceRoot: stateDir });
    try {
      assert.equal(conflictingIntentLedger.getAgentGraphReassignment(conflictingIntentGraphRunId), undefined);
    } finally {
      conflictingIntentLedger.close();
    }

    failGraphControlAudit = "reassign";
    const auditBlockedReassignment = await fetch(reassignmentUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": replacement.id },
      body: JSON.stringify({ expectedRequestDigest: failedRequestDigest, replacement })
    });
    assert.equal(auditBlockedReassignment.status, 400);
    assert.match(String(lastGraphControlError), /injected reassign audit failure/u);
    assert.equal((await fetch(`${base}/jobs/${replacement.id}`)).status, 404);
    failGraphControlAudit = undefined;
    const reassigned = await fetch(reassignmentUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": replacement.id },
      body: JSON.stringify({ expectedRequestDigest: failedRequestDigest, replacement })
    });
    assert.equal(reassigned.status, 202);
    assert.equal((await reassigned.json()).reassignedFrom, failedGraphRunId);
    let reassignedJob: any;
    const reassignedDeadline = Date.now() + 20_000;
    while (Date.now() < reassignedDeadline) {
      reassignedJob = await (await fetch(`${base}/jobs/${replacement.id}`)).json();
      if (["completed", "failed", "needs-review"].includes(reassignedJob.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(reassignedJob.status, "completed");
    assert.equal(reassignedJob.payload.delegation.reassignedFromGraphRunId, failedGraphRunId);
    assert.doesNotMatch(JSON.stringify(reassignedJob), /PRIVATE_REASSIGNED_GRAPH_PROMPT/u);
    assert.equal(reassignedJob.payload.task.tool, replacement.task.tool);
    assert.equal(reassignedJob.payload.replayIdentity.tool, "agent.delegate");
    assert.equal(
      reassignedJob.payload.replayIdentity.principalNamespaceDigest,
      createHash("sha256").update("operator", "utf8").digest("hex")
    );
    for (const key of ["delegationDigest", "scopeDigest", "parentCapabilitiesDigest"]) {
      assert.match(reassignedJob.payload.replayIdentity[key], /^[a-f0-9]{64}$/u);
    }
    assert.deepEqual(reassignedJob.payload.parentCapabilities, replacement.parentCapabilities);
    assert.deepEqual(reassignedJob.payload.scope, { tenantId: "tenant:local", principalId: "local-gateway-user" });
    assert.deepEqual(reassignedJob.payload.delegation, {
      reassignedFromGraphRunId: failedGraphRunId,
      reassignedFromRequestDigest: failedRequestDigest
    });
    const replayLedger = createRunLedger({ stateDir, workspaceRoot: stateDir });
    try {
      assert.equal(
        reassignedJob.requestHash,
        replayLedger.getAgentGraphReassignment(failedGraphRunId)?.replacementRequestHash
      );
    } finally {
      replayLedger.close();
    }
    const reassignedReplay = await fetch(reassignmentUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": replacement.id },
      body: JSON.stringify({ expectedRequestDigest: failedRequestDigest, replacement })
    });
    const reassignedReplayBody = await reassignedReplay.json();
    assert.equal(reassignedReplay.status, 200, JSON.stringify(reassignedReplayBody));
    assert.equal(reassignedReplayBody.replayed, true);
    const secondSuccessor = await fetch(reassignmentUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "stage7_second_successor" },
      body: JSON.stringify({
        expectedRequestDigest: failedRequestDigest,
        replacement: { ...replacement, id: "stage7_second_successor" }
      })
    });
    assert.equal(secondSuccessor.status, 409);
    assert.match((await secondSuccessor.json()).error, /different durable successor/u);

    const terminalCancellation = await fetch(`${base}/agent-graphs/${encodeURIComponent(graphRunId)}/cancel`, { method: "POST" });
    assert.equal(terminalCancellation.status, 200);
    const terminalCancellationBody = await terminalCancellation.json();
    assert.equal(terminalCancellationBody.job.status, "completed");
    assert.equal(terminalCancellationBody.graph.status, "completed");
    const audit = await (await fetch(`${base}/audit`)).json();
    assert.ok(audit.some((event: any) => event.type === "agent.graph.validated" && event.runId === job.id));
    assert.ok(audit.some((event: any) => event.type === "agent.graph.node.started" && event.runId === job.id));
    assert.ok(audit.some((event: any) => event.type === "agent.graph.completed" && event.runId === job.id));
    assert.ok(audit.some((event: any) => event.type === "agent.graph.checkpoint" && event.runId === checkpointRunId && event.data?.resultDigest === graphList.graphs[0].nodes[0].resultDigest));
    assert.ok(audit.some((event: any) => event.type === "agent.graph.reassigned" && event.runId === failedParentRunId && event.data?.replacementJobId === replacement.id));
    assert.ok(audit.some((event: any) => event.type === "agent.graph.cancellation.requested" && event.data?.graphRunId === "graph:stage7-cancel-fixture"));
    assert.ok(audit.some((event: any) => event.type === "agent.graph.reassignment.requested" && event.data?.replacementJobId === replacement.id));
    assert.ok(audit.some((event: any) => event.type === "agent.graph.checkpoint.requested" && event.data?.checkpointRunId === checkpointRunId));
    assert.equal(audit.some((event: any) => event.type === "agent.graph.checkpoint.requested" && event.data?.checkpointRunId === blockedCheckpointRunId), false);
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

test("gateway persists a bound channel result before completion and serves it after restart", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-channel-result-"));
  let providerCalls = 0;
  const attemptStatesBeforeResultPersist = new Map<string, string>();
  let rejectPersistFor = "";
  const provider = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    providerCalls += 1;
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
  let server = await createGatewayServer(withGatewayTestHooks(
    { stateDir, workspaceRoot: stateDir },
    {
      beforeChannelResultPersist({ jobId }) {
        const ledger = createRunLedger({ stateDir, workspaceRoot: stateDir });
        try {
          const row = ledger.database.db.prepare(`SELECT attempt.state
            FROM execution_attempts AS attempt
            JOIN runtime_jobs AS job ON job.execution_run_id = attempt.run_id
            WHERE job.id = ?
            ORDER BY attempt.attempt_number DESC LIMIT 1`).get(jobId) as { state: string } | undefined;
          attemptStatesBeforeResultPersist.set(jobId, String(row?.state ?? "missing"));
        } finally {
          ledger.close();
        }
        if (jobId === rejectPersistFor) throw new Error("fixture protected result persistence failure");
      }
    }
  ));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let base = `http://127.0.0.1:${(server.address() as any).port}`;
  const closeGateway = async () => {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  try {
    const executionKey = "stage7-channel-result";
    const sessionResponse = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Durable channel result" })
    });
    assert.equal(sessionResponse.status, 200);
    const sessionId = String((await sessionResponse.json()).id);
    assert.ok(sessionId);
    const submitChannel = (executionKey: string, input: Record<string, unknown>, headerKey = executionKey) => fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": headerKey },
      body: JSON.stringify({
        executionKey,
        task: { tool: "agent.run", input: { model: "test:test-model", prompt: "PRIVATE_CHANNEL_PROMPT", maxTurns: 1, maxTokens: 128, ...input } }
      })
    });

    assert.equal((await submitChannel("channel-missing-session", {})).status, 400);
    assert.equal((await submitChannel("channel-oversized-session", { sessionId: "s".repeat(257) })).status, 400);
    assert.equal((await submitChannel("channel-unknown-session", { sessionId: "sess_missing" })).status, 409);
    assert.equal((await submitChannel("channel-identity-mismatch", { sessionId }, "different-idempotency-key")).status, 409);
    const foreignRecords = new SqliteRecordStore(join(stateDir, "db", "records.sqlite"));
    await foreignRecords.append({
      id: "sess_foreign",
      type: "session.created",
      status: "open",
      title: "Foreign session",
      actor: "foreign-principal",
      source: "test",
      projectId: "project_default"
    });
    foreignRecords.close();
    assert.equal((await submitChannel("channel-foreign-session", { sessionId: "sess_foreign" })).status, 403);
    const closedSessionResponse = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Closed channel session" })
    });
    const closedSessionId = String((await closedSessionResponse.json()).id);
    assert.equal((await fetch(`${base}/sessions/${encodeURIComponent(closedSessionId)}`, { method: "DELETE" })).status, 200);
    assert.equal((await submitChannel("channel-closed-session", { sessionId: closedSessionId })).status, 409);
    assert.equal(providerCalls, 0, "invalid channel bindings must be rejected before provider dispatch");

    const ordinaryId = "ordinary-agent-run";
    const ordinary = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ordinaryId },
      body: JSON.stringify({
        task: { tool: "agent.run", input: { sessionId, model: "test:test-model", prompt: "ordinary run", maxTurns: 1, maxTokens: 128 } }
      })
    });
    assert.equal(ordinary.status, 202);
    let ordinaryJob: any;
    const ordinaryDeadline = Date.now() + 20_000;
    while (Date.now() < ordinaryDeadline) {
      ordinaryJob = await (await fetch(`${base}/jobs/${ordinaryId}`)).json();
      if (["completed", "failed", "needs-review"].includes(ordinaryJob.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ordinaryJob.status, "completed", "ordinary agent.run jobs remain backward compatible without executionKey");

    rejectPersistFor = "channel-persist-failure";
    assert.equal((await submitChannel(rejectPersistFor, { sessionId })).status, 202);
    let rejectedPersistJob: any;
    const rejectedPersistDeadline = Date.now() + 20_000;
    while (Date.now() < rejectedPersistDeadline) {
      rejectedPersistJob = await (await fetch(`${base}/jobs/${rejectPersistFor}`)).json();
      if (["completed", "failed", "needs-review"].includes(rejectedPersistJob.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(rejectedPersistJob.status, "needs-review");
    assert.equal(attemptStatesBeforeResultPersist.get(rejectPersistFor), "running");
    assert.equal((await fetch(`${base}/jobs/${rejectPersistFor}/result`)).status, 409);
    rejectPersistFor = "";

    const submission = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": executionKey },
      body: JSON.stringify({
        executionKey,
        task: { tool: "agent.run", input: { sessionId, model: "test:test-model", prompt: "PRIVATE_CHANNEL_PROMPT", maxTurns: 1, maxTokens: 128 } }
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
    assert.equal(attemptStatesBeforeResultPersist.get(executionKey), "running", "the protected result must commit before attempt terminality");
    assert.doesNotMatch(JSON.stringify(job), /PRIVATE_CHANNEL_OUTPUT|PRIVATE_CHANNEL_PROMPT/u);

    const result = await fetch(`${base}/jobs/${executionKey}/result`);
    assert.equal(result.status, 200);
    const resultBody = await result.json();
    assert.equal(resultBody.ok, true);
    assert.equal(resultBody.result.output.content, "PRIVATE_CHANNEL_OUTPUT");
    assert.doesNotMatch(JSON.stringify(resultBody), /PRIVATE_CHANNEL_PROMPT/u);

    await closeGateway();
    // Model execution returned and the protected result committed, but the
    // public runtime job did not reach its terminal update before the process
    // died. Startup must adopt the bound result without replaying the model.
    const interrupted = createRunLedger({ stateDir, workspaceRoot: stateDir });
    interrupted.database.db.prepare(`UPDATE runtime_jobs
      SET status = 'running', result_json = NULL, completed_at = NULL
      WHERE id = ?`).run(executionKey);
    interrupted.database.db.prepare(`UPDATE execution_attempts
      SET state = 'running', settled_at = NULL, outcome_digest = NULL, error_code = NULL,
        owner_released_at = NULL, owner_heartbeat_at = ?
      WHERE id = (SELECT execution_attempt_id FROM runtime_jobs WHERE id = ?)`)
      .run(new Date().toISOString(), executionKey);
    interrupted.close();
    server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    const recoveredJob = await (await fetch(`${base}/jobs/${executionKey}`)).json();
    assert.equal(recoveredJob.status, "completed");
    assert.doesNotMatch(JSON.stringify(recoveredJob), /PRIVATE_CHANNEL_OUTPUT|PRIVATE_CHANNEL_PROMPT/u);
    const recoveredResult = await fetch(`${base}/jobs/${executionKey}/result`);
    assert.equal(recoveredResult.status, 200);
    assert.equal((await recoveredResult.json()).result.output.content, "PRIVATE_CHANNEL_OUTPUT");
    assert.equal(providerCalls, 3, "startup must adopt the protected result without replaying the model");

    await closeGateway();
    const records = new SqliteRecordStore(join(stateDir, "db", "records.sqlite"));
    const persisted = (await records.queryRecords({ types: ["channel.result.persisted"] }))[0] as any;
    assert.equal(persisted.jobId, executionKey);
    assert.equal(persisted.sessionId, sessionId);
    assert.equal(persisted.result.output.content, "PRIVATE_CHANNEL_OUTPUT");
    records.db.prepare("UPDATE record_events SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...persisted, sessionId: "session_substitution" }), persisted.id);
    records.close();
    server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    const corruptedJob = await (await fetch(`${base}/jobs/${executionKey}`)).json();
    assert.equal(corruptedJob.status, "needs-review");
    const substituted = await fetch(`${base}/jobs/${executionKey}/result`);
    assert.equal(substituted.status, 409);
    assert.doesNotMatch(await substituted.text(), /PRIVATE_CHANNEL_OUTPUT/u);

    await closeGateway();
    const missing = new SqliteRecordStore(join(stateDir, "db", "records.sqlite"));
    missing.db.prepare("DELETE FROM record_events WHERE id = ?").run(persisted.id);
    missing.close();
    const missingLedger = createRunLedger({ stateDir, workspaceRoot: stateDir });
    missingLedger.database.db.prepare("UPDATE runtime_jobs SET status = 'completed', error = NULL WHERE id = ?").run(executionKey);
    missingLedger.close();
    server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    const missingJob = await (await fetch(`${base}/jobs/${executionKey}`)).json();
    assert.equal(missingJob.status, "needs-review");
    assert.match(missingJob.error, /protected channel result is unavailable/u);
    assert.equal(providerCalls, 3, "missing-result quarantine must not replay the provider");
  } finally {
    await closeGateway();
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
    assert.deepEqual(
      ledger.listAgentGraphRuns({ parentRunId: "parent-blocked" }).map((run: any) => run.graphRunId),
      ["graph:blocked"]
    );
    assert.ok(ledger.listAgentGraphRuns({ status: "needs-review", limit: 10 }).some((run: any) => run.graphRunId === "graph:unsettled"));
    assert.throws(() => ledger.listAgentGraphRuns({ status: "unknown" }), /status filter is invalid/u);
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
