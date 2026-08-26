import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  dispatchGovernedWorkflowStep,
  eventJobRequestForCandidate,
  eventDeliveryStatusForJob,
  submitDurableEventJob,
  waitForDurableJobTerminal,
  workflowDispatchResultForExecution
} from "../apps/gateway/src/durable-dispatch.ts";
import { createGatewayTenantScope } from "../apps/gateway/src/http/tenant-scope.ts";
import { createRunLedger, DurableEventIngress, JobSupervisor, SqliteJobStore } from "../packages/kernel/src/index.ts";
import {
  createScheduleCandidate,
  validateAutomationDeclaration,
  type AutomationCandidate
} from "../packages/kernel/src/automation-primitives.ts";
import { projectDurableJobPayload, type JsonObject } from "../packages/protocol/src/index.ts";

function durableEventDeclaration(actionRef = "remote.mutate", declarationId = "gateway-durable-event") {
  return validateAutomationDeclaration({
    schemaVersion: 1,
    id: declarationId,
    revision: 1,
    enabled: true,
    actionRef,
    kind: "schedule",
    schedule: { type: "at", atUnixMs: 100 }
  });
}

function durableEventCandidate(actionRef = "remote.mutate", declarationId = "gateway-durable-event"): AutomationCandidate {
  const declaration = durableEventDeclaration(actionRef, declarationId);
  const candidate = createScheduleCandidate(declaration, 100);
  assert.ok(candidate);
  return candidate;
}

async function waitForDelivery(ingress: DurableEventIngress, idempotencyKey: string, status: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const delivery = ingress.delivery(idempotencyKey);
    if (delivery?.status === status) return delivery;
    if (delivery && delivery.status !== "queued") {
      throw new Error(`event delivery ${idempotencyKey} settled as ${delivery.status} (${delivery.errorCode ?? "no error code"})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`event delivery ${idempotencyKey} did not reach ${status}: ${JSON.stringify(ingress.delivery(idempotencyKey))}`);
}

async function waitForStoredJob(store: SqliteJobStore, id: string, status: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await store.get(id);
    if (job?.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`runtime job ${id} did not reach ${status}`);
}

test("event job adoption rejects unrelated, payload-changed, cross-scope, and missing-hash records", async (t) => {
  const candidate = durableEventCandidate();
  const scope = createGatewayTenantScope({ hosted: true, userId: "alice", tenantId: "acme" });
  const otherScope = createGatewayTenantScope({ hosted: true, userId: "alice", tenantId: "other" });
  const request = eventJobRequestForCandidate(candidate, scope);
  const otherScopeRequest = eventJobRequestForCandidate(candidate, otherScope);
  assert.notEqual(request.requestHash, otherScopeRequest.requestHash);

  const conflicts = [
    {
      name: "unrelated request",
      job: { id: request.id, status: "queued", payload: { unrelated: true }, requestHash: "f".repeat(64), retrySafe: false }
    },
    {
      name: "changed payload",
      job: { ...request, status: "queued", payload: { ...request.payload, unrelated: true } }
    },
    {
      name: "different authenticated scope",
      job: { ...otherScopeRequest, status: "queued" }
    },
    {
      name: "missing request hash",
      job: { id: request.id, status: "queued", payload: request.payload, retrySafe: false }
    }
  ];

  for (const conflict of conflicts) {
    await t.test(conflict.name, async () => {
      let submits = 0;
      await assert.rejects(
        () => submitDurableEventJob({
          get: async () => conflict.job,
          submit: async () => {
            submits += 1;
            throw new Error("conflicting jobs must not be resubmitted");
          }
        }, candidate, scope),
        /bound to a different request, payload, or scope/u
      );
      assert.equal(submits, 0);
    });
  }

  await t.test("raced submit cannot return a hashless conflicting job", async () => {
    await assert.rejects(
      () => submitDurableEventJob({
        get: async () => undefined,
        submit: async () => ({ id: request.id, status: "queued", payload: request.payload, retrySafe: false })
      }, candidate, scope),
      /bound to a different request, payload, or scope/u
    );
  });

  await t.test("an exactly bound record remains idempotently adoptable", async () => {
    let submits = 0;
    const adopted = await submitDurableEventJob({
      get: async () => ({ ...request, status: "awaiting-approval" }),
      submit: async () => {
        submits += 1;
        throw new Error("an existing exact match must be adopted");
      }
    }, candidate, scope);
    assert.equal(submits, 0);
    assert.equal(adopted.job.status, "awaiting-approval");
    assert.deepEqual(adopted.request, request);
  });
});

test("event job binding adopts canonical SQLite projections across restart without replaying effects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-event-job-projection-"));
  const ledger = createRunLedger({ stateDir: join(root, ".odinn"), workspaceRoot: root });
  t.after(async () => {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  });
  const store = new SqliteJobStore(ledger);
  const scope = createGatewayTenantScope({ hosted: true, userId: "alice", tenantId: "acme" });
  const cases = [
    { tool: "text.echo", declarationId: "event-projection-identity", projectedInput: "identity" },
    { tool: "skill.catalog", declarationId: "event-projection-skill", projectedInput: "empty" },
    { tool: "process.exec", declarationId: "event-projection-process", projectedInput: "empty" },
    { tool: "mcp.invoke", declarationId: "event-projection-mcp", projectedInput: "empty" },
    { tool: "git.status", declarationId: "event-projection-git", projectedInput: "empty" }
  ] as const;
  const candidates = cases.map(({ tool, declarationId }) => durableEventCandidate(tool, declarationId));
  const liveInputs = new Map<string, JsonObject>();
  let effects = 0;
  const first = new JobSupervisor({
    store,
    execute: async (payload) => {
      effects += 1;
      const task = payload.task as JsonObject;
      liveInputs.set(String(task.tool), task.input as JsonObject);
      return { ok: true };
    }
  });
  await first.start();

  for (const [index, candidate] of candidates.entries()) {
    const { job, request } = await submitDurableEventJob(first, candidate, scope);
    assert.equal(job.requestHash, request.requestHash);
    assert.deepEqual(job.payload, projectDurableJobPayload(request.payload));
    const storedInput = ((job.payload.task as JsonObject).input ?? {}) as JsonObject;
    if (cases[index]!.projectedInput === "empty") assert.deepEqual(storedInput, {});
    else assert.deepEqual(storedInput, {
      candidateId: candidate.candidateId,
      idempotencyKey: candidate.idempotencyKey
    });
    await waitForStoredJob(store, candidate.idempotencyKey, "completed");
    assert.deepEqual(liveInputs.get(candidate.actionRef), {
      candidateId: candidate.candidateId,
      idempotencyKey: candidate.idempotencyKey
    });
  }
  assert.equal(effects, cases.length);
  await first.shutdown();

  let replayedEffects = 0;
  const restarted = new JobSupervisor({
    store,
    execute: async () => {
      replayedEffects += 1;
      return { ok: true };
    }
  });
  await restarted.start();
  for (const candidate of candidates) {
    const adopted = await submitDurableEventJob(restarted, candidate, scope);
    assert.equal(adopted.job.status, "completed");
    assert.deepEqual(adopted.job.payload, projectDurableJobPayload(adopted.request.payload));
  }
  assert.equal(replayedEffects, 0);
  await restarted.shutdown();
});

test("supervisor startup precedes tokenless event recovery for every durable projector", async () => {
  const cases = ["text.echo", "skill.catalog", "process.exec", "mcp.invoke", "git.status"] as const;
  const scope = createGatewayTenantScope({ hosted: true, userId: "alice", tenantId: "acme" });
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const root = await mkdtemp(join(tmpdir(), `odinn-event-startup-order-${iteration}-`));
    const state = join(root, ".odinn");
    const ledger = createRunLedger({ stateDir: state, workspaceRoot: root });
    const store = new SqliteJobStore(ledger, { legacyPath: join(state, "jobs.json") });
    let supervisor: JobSupervisor | undefined;
    let ingress: DurableEventIngress | undefined;
    try {
      const seed = new DurableEventIngress({ database: ledger.database });
      for (const [index, tool] of cases.entries()) {
        seed.registerWatch(`startup-order-${iteration}-${index}`, durableEventDeclaration(tool, `startup-order-${iteration}-${index}`));
      }
      const candidates = await seed.heartbeat(100);
      assert.equal(candidates.length, cases.length);
      await seed.shutdown();

      let effects = 0;
      supervisor = new JobSupervisor({
        store,
        execute: async () => {
          effects += 1;
          return { ok: true };
        }
      });
      await supervisor.start();
      ingress = new DurableEventIngress({
        database: ledger.database,
        dispatch: async (candidate, { signal, renewLease }) => {
          const { job, request } = await submitDurableEventJob(supervisor!, candidate, scope);
          return waitForDurableJobTerminal({
            initialJob: job,
            getJob: (id) => supervisor!.get(id),
            signal,
            renewLease,
            expectedRequest: request,
            pollIntervalMs: 1,
            leaseRenewIntervalMs: 1
          });
        }
      });
      for (const candidate of candidates) {
        await waitForDelivery(ingress, candidate.idempotencyKey, "completed");
        assert.equal((await store.get(candidate.idempotencyKey))?.status, "completed");
      }
      assert.equal(effects, cases.length);

      await ingress.shutdown();
      ingress = undefined;
      await supervisor.shutdown();
      supervisor = undefined;
      let replayed = 0;
      const restarted = new JobSupervisor({
        store,
        execute: async () => {
          replayed += 1;
          return { ok: true };
        }
      });
      await restarted.start();
      for (const candidate of candidates) {
        assert.equal((await submitDurableEventJob(restarted, candidate, scope)).job.status, "completed");
      }
      assert.equal(replayed, 0);
      await restarted.shutdown();
    } finally {
      await ingress?.shutdown().catch(() => undefined);
      await supervisor?.shutdown().catch(() => undefined);
      ledger.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("event ingress resumes monitoring an idempotent nonterminal job through approval to its durable terminal state", async () => {
  const controller = new AbortController();
  const states = ["running", "awaiting-approval", "completed"];
  let reads = 0;
  let renewals = 0;
  const result = await waitForDurableJobTerminal({
    initialJob: { id: "event-job-restarted", status: "queued" },
    getJob: async (id) => ({ id, status: states[Math.min(reads++, states.length - 1)]! }),
    signal: controller.signal,
    renewLease: () => { renewals += 1; return true; },
    pollIntervalMs: 1,
    leaseRenewIntervalMs: 1
  });

  assert.equal(result, "completed");
  assert.ok(reads >= 3);
  assert.ok(renewals >= 2);
});

test("event ingress maps only durable job terminal states and fails closed for an unknown state", async () => {
  assert.equal(eventDeliveryStatusForJob({ id: "queued", status: "queued" }), undefined);
  assert.equal(eventDeliveryStatusForJob({ id: "approval", status: "awaiting-approval" }), undefined);
  assert.equal(eventDeliveryStatusForJob({ id: "completed", status: "completed" }), "completed");
  assert.equal(eventDeliveryStatusForJob({ id: "failed", status: "failed" }), "failed");
  assert.equal(eventDeliveryStatusForJob({ id: "cancelled", status: "cancelled" }), "failed");
  assert.equal(eventDeliveryStatusForJob({ id: "unknown", status: "future-state" }), "needs-review");

  let reads = 0;
  let renewals = 0;
  const missing = await waitForDurableJobTerminal({
    initialJob: { id: "missing-after-restart", status: "running" },
    getJob: async () => { reads += 1; return undefined; },
    signal: new AbortController().signal,
    renewLease: () => { renewals += 1; return true; },
    pollIntervalMs: 1,
    leaseRenewIntervalMs: 1
  });
  assert.equal(missing, "needs-review");
  assert.equal(reads, 1);
  assert.equal(renewals, 1);
});

test("event ingress reports a durable job failure instead of declaring its accepted submission complete", async () => {
  let reads = 0;
  const result = await waitForDurableJobTerminal({
    initialJob: { id: "event-job-failure", status: "running" },
    getJob: async (id) => ({ id, status: reads++ === 0 ? "running" : "failed" }),
    signal: new AbortController().signal,
    renewLease: () => true,
    pollIntervalMs: 1,
    leaseRenewIntervalMs: 1
  });
  assert.equal(result, "failed");
  assert.ok(reads >= 2);
});

test("workflow gateway admission binds the workflow parent and preserves terminal outcomes", async () => {
  let captured: Record<string, any> | undefined;
  const context = {
    run: { runId: "workflow-parent" },
    step: { stepId: "mutate", attempt: 2, actionRef: "workspace.mutate", input: { path: "notes.txt" } },
    signal: new AbortController().signal,
    renewLease: () => true
  } as any;
  const result = await dispatchGovernedWorkflowStep(context, async (request) => {
    captured = request as Record<string, any>;
    return { terminalStatus: "needs-review", errorCode: "EFFECT_RECEIPT_UNCERTAIN" };
  }, 1);

  assert.equal(captured?.parentRunId, "workflow-parent");
  assert.equal(captured?.durableExecution, true);
  assert.deepEqual(captured?.task, {
    id: "workflow-parent:mutate:2",
    tool: "workspace.mutate",
    input: { path: "notes.txt" },
    actor: "workflow",
    reason: "workflow:workflow-parent"
  });
  assert.deepEqual(result, { status: "needs-review", errorCode: "EFFECT_RECEIPT_UNCERTAIN" });
});

test("workflow gateway terminal mapping preserves approval, failure, and explicit no-effect cancellation", () => {
  assert.deepEqual(workflowDispatchResultForExecution({ output: { type: "approval.required" } }), { status: "awaiting-approval" });
  assert.deepEqual(workflowDispatchResultForExecution({ terminalStatus: "failed", errorCode: "WORK_FAILED" }), { status: "failed", errorCode: "WORK_FAILED" });
  assert.deepEqual(workflowDispatchResultForExecution({ terminalStatus: "failed", errorCode: "A".repeat(64) }), { status: "failed", errorCode: "A".repeat(64) });
  assert.deepEqual(workflowDispatchResultForExecution({ terminalStatus: "failed", errorCode: "A".repeat(65) }), { status: "failed", errorCode: "WORKFLOW_STEP_FAILED" });
  assert.deepEqual(workflowDispatchResultForExecution({ terminalStatus: "failed", errorCode: "arbitrary operator message" }), { status: "failed", errorCode: "WORKFLOW_STEP_FAILED" });
  assert.deepEqual(workflowDispatchResultForExecution({ output: { status: "needs-review", errorCode: "EFFECT_UNKNOWN" } }), { status: "needs-review", errorCode: "EFFECT_UNKNOWN" });
  assert.deepEqual(workflowDispatchResultForExecution({ output: { status: "cancelled", effectApplied: false } }), { status: "cancelled", effectApplied: false });
  assert.deepEqual(workflowDispatchResultForExecution({ output: { status: "cancelled" } }), { status: "needs-review", errorCode: "WORKFLOW_CANCELLATION_EFFECT_UNCONFIRMED" });
  assert.deepEqual(workflowDispatchResultForExecution({ terminalStatus: "future-state" }), { status: "needs-review", errorCode: "WORKFLOW_TERMINAL_STATUS_UNKNOWN" });
  assert.deepEqual(workflowDispatchResultForExecution({ output: { status: "domain-specific", text: "done" } }), { status: "completed", result: { output: { status: "domain-specific", text: "done" } } });
  assert.deepEqual(workflowDispatchResultForExecution({ output: { text: "done" } }), { status: "completed", result: { output: { text: "done" } } });
});
