process.env.ODINN_GATEWAY_AUTH = "off";

import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayServer } from "../apps/gateway/src/server.ts";
import { createRunLedger } from "../packages/kernel/src/index.ts";

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
    const retryDeadline = Date.now() + 10_000;
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
