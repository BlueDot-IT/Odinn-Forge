process.env.ODINN_GATEWAY_AUTH = "off";
process.env.ODINN_BROWSER_HEADLESS = "1";

import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayOperatorSnapshotReadRequest, createGatewayServer } from "../apps/gateway/src/server.ts";
import { validateOperatorSnapshotReadRequestV1, validateOperatorSnapshotResponseV1 } from "../packages/application/src/index.ts";
import { createApprovalStore, createRunLedger, SqliteJobStore } from "../packages/kernel/src/index.ts";

async function requestJson(url: string, init: RequestInit = {}, expectedStatus = 200): Promise<any> {
  const response = await fetch(url, init);
  assert.equal(response.status, expectedStatus, `${init.method ?? "GET"} ${url}`);
  return response.json();
}

async function submitJob(base: string, id: string): Promise<void> {
  const body = await requestJson(`${base}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": id },
    body: JSON.stringify({ task: { tool: "text.echo", input: { text: id } } })
  }, 202);
  assert.equal(body.job.id, id);
}

async function waitForJob(base: string, id: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = await requestJson(`${base}/jobs/${encodeURIComponent(id)}`);
    if (["completed", "failed", "cancelled", "needs-review"].includes(job.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`job did not settle: ${id}`);
}

function withoutGenerationTime(value: any) {
  const clone = structuredClone(value);
  delete clone.generatedAt;
  return clone;
}

test("Gateway constructs the operator application context and forwards every read option", () => {
  const request = createGatewayOperatorSnapshotReadRequest({
    applicationRequestId: "operator-context-request",
    hostedUserId: "tenant-user",
    authentication: "bearer",
    sourcePath: "/operator/snapshot",
    input: {
      surface: "console",
      page: 3,
      pageSize: 17,
      query: "durable",
      status: "all",
      pages: { runtime: 2, work: 3, approvals: 4, automation: 5, context: 6, recovery: 7, audit: 8, surfaces: 9 },
    },
  });
  assert.equal(request.input.status, "all", "the transport must forward the explicit all-status option");
  const validated = validateOperatorSnapshotReadRequestV1(request);

  assert.deepEqual(validated.context, {
    principal: {
      principalId: "host-user:tenant-user",
      actorId: "gateway",
      kind: "host-user",
      authenticationReference: "gateway:bearer",
    },
    scope: { tenantId: "tenant:tenant-user" },
    sourceReference: "http:GET:/operator/snapshot",
    correlationId: "operator-context-request",
    cancellationControlReference: "http:request:operator-context-request",
  });
  assert.deepEqual(validated.operation, { kind: "query", id: "operator.snapshot.read" });
  assert.deepEqual(validated.input, {
    surface: "console",
    page: 3,
    pageSize: 17,
    query: "durable",
    status: "",
    pages: { runtime: 2, work: 3, approvals: 4, automation: 5, context: 6, recovery: 7, audit: 8, surfaces: 9 },
  });
});

test("both Gateway operator routes expose the strict application snapshot without reconciling recovery state", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-operator-gateway-"));
  const server: any = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    await submitJob(base, "operator-job-a");
    await submitJob(base, "operator-job-b");
    await waitForJob(base, "operator-job-a");
    await waitForJob(base, "operator-job-b");

    const ledger = createRunLedger({ stateDir, workspaceRoot: stateDir });
    const jobs = new SqliteJobStore(ledger);
    const oldTimestamp = "2020-01-01T00:00:00.000Z";
    for (let index = 1; index <= 505; index += 1) {
      await jobs.create({
        id: `deep-job-${String(index).padStart(4, "0")}`,
        status: "completed",
        payload: { task: { tool: "text.echo", input: { text: "bounded" } } },
        attempts: 1,
        timeoutMs: 1_000,
        retrySafe: true,
        createdAt: oldTimestamp,
        updatedAt: oldTimestamp,
        completedAt: oldTimestamp,
      });
    }
    const attempt = ledger.database.db.prepare("SELECT id FROM execution_attempts WHERE run_id = ? ORDER BY attempt_number DESC LIMIT 1").get("operator-job-b") as { id?: string } | undefined;
    assert.ok(attempt?.id);
    ledger.database.db.prepare("UPDATE execution_attempts SET state = 'needs-review', settled_at = ?, outcome_digest = NULL, error_code = 'OUTCOME_UNKNOWN' WHERE id = ?").run(new Date().toISOString(), attempt.id);
    ledger.database.db.prepare("UPDATE runtime_jobs SET status = 'needs-review', error = 'outcome needs review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), "operator-job-b");
    ledger.close();

    const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
    const approvalId = approvalStore.create({
      actor: "operator-gateway-test",
      accountId: "local",
      runId: "operator-claimed-run",
      tool: "process.exec",
      input: { command: "printf", args: ["bounded"] }
    });
    assert.equal(approvalStore.claim(approvalId)?.status, "approved");

    const recoverySources = {
      browser: join(stateDir, "browser-recovery.json"),
      sandbox: join(stateDir, "sandbox-recovery.json"),
      process: join(stateDir, "process-recovery.json")
    };
    await writeFile(recoverySources.browser, `${JSON.stringify({ status: "executing", privatePayload: "must-not-leak" })}\n`, { mode: 0o600 });
    await writeFile(recoverySources.sandbox, `${JSON.stringify({ pending: [{ privatePayload: "must-not-leak" }] })}\n`, { mode: 0o600 });
    await writeFile(recoverySources.process, "{malformed-recovery-json", { mode: 0o600 });
    const before = Object.fromEntries(await Promise.all(Object.entries(recoverySources).map(async ([name, path]) => [name, {
      content: await readFile(path, "utf8"),
      mtimeMs: (await stat(path)).mtimeMs
    }])));

    const query = "surface=http&pageSize=1&status=all&workPage=2&approvalsPage=1&recoveryPage=2";
    const alias = validateOperatorSnapshotResponseV1(await requestJson(`${base}/operator?${query}`));
    const canonical = validateOperatorSnapshotResponseV1(await requestJson(`${base}/operator/snapshot?${query}`));
    assert.deepEqual(Object.keys(alias).sort(), ["actions", "generatedAt", "health", "identity", "ok", "schemaVersion", "sections", "surface"]);
    assert.equal(alias.ok, true);
    assert.equal(alias.schemaVersion, 1);
    assert.equal(alias.sections.work.pagination.page, 2);
    assert.equal(alias.sections.work.items.length, 1);
    assert.equal(alias.sections.approvals.items[0]?.status, "claimed");
    assert.deepEqual(withoutGenerationTime(alias), withoutGenerationTime(canonical));

    const deep = validateOperatorSnapshotResponseV1(await requestJson(`${base}/operator/snapshot?surface=http&pageSize=50&status=all&workPage=11`));
    assert.ok(deep.sections.work.counts.jobs > 500);
    assert.equal(deep.sections.work.pagination.from, 501);
    assert.ok(deep.sections.work.items.some((item) => item.kind === "job" && item.id === "deep-job-0499"), JSON.stringify(deep.sections.work.items));

    const full = validateOperatorSnapshotResponseV1(await requestJson(`${base}/operator/snapshot?surface=http&pageSize=50&status=all`));
    const job = full.sections.work.items.find((item) => item.kind === "job" && item.id === "operator-job-a");
    assert.ok(job && job.kind === "job");
    assert.equal(job.details.latestAttempt?.runId, "operator-job-a", JSON.stringify(job));
    assert.equal(job.details.latestAttempt?.attemptNumber, 1);
    assert.equal(job.details.latestAttempt?.state, "completed");
    assert.deepEqual(
      Object.keys(job.details.latestAttempt ?? {}).sort(),
      ["attemptNumber", "createdAt", "id", "outcomeDigest", "runId", "settledAt", "startedAt", "state"].sort()
    );
    const reviewJob = full.sections.work.items.find((item) => item.kind === "job" && item.id === "operator-job-b");
    assert.ok(reviewJob && reviewJob.kind === "job");
    assert.equal(reviewJob.status, "needs-review");
    assert.equal(reviewJob.details.latestAttempt?.state, "needs-review");
    assert.equal(reviewJob.details.latestAttempt?.errorCode, "OUTCOME_UNKNOWN");
    assert.equal(reviewJob.details.latestAttempt?.outcomeDigest, undefined);
    assert.equal(full.sections.approvals.items.find((item) => item.id === approvalId)?.status, "claimed");
    assert.equal(full.sections.recovery.items.find((item) => item.id === "browser-recovery")?.status, "executing");
    assert.equal(full.sections.recovery.items.find((item) => item.id === "sandbox-recovery")?.status, "needs-review");
    assert.equal(full.sections.recovery.items.find((item) => item.id === "process-recovery")?.status, "needs-review");
    assert.doesNotMatch(JSON.stringify(full), /must-not-leak|malformed-recovery-json/u);

    const after = Object.fromEntries(await Promise.all(Object.entries(recoverySources).map(async ([name, path]) => [name, {
      content: await readFile(path, "utf8"),
      mtimeMs: (await stat(path)).mtimeMs
    }])));
    assert.deepEqual(after, before, "operator GETs must not reconcile or rewrite recovery journals");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve()));
  }
});
