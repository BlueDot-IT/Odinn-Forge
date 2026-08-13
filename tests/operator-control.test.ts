import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  APPLICATION_CONTRACT_VERSION,
  ApplicationContractValidationError,
  createOperatorSnapshotReadUseCase,
  parseOperatorSnapshotResponseV1,
  validateOperatorSnapshotReadRequestV1,
  validateOperatorSnapshotResponseV1,
  validateOperatorSnapshotV1,
  type OperatorSnapshotReadPort,
  type OperatorSnapshotReadRequestV1,
  type OperatorRecoverySourceV1,
  type OperatorSnapshotSourceQueryV1,
} from "../packages/application/src/index.ts";
import {
  OPERATOR_SECTION_PAGE_OPTIONS,
  operatorSnapshotInputFromArgs,
  operatorSnapshotRemoteQueryFromArgs,
  readLocalOperatorSnapshot,
} from "../apps/cli/src/operator-snapshot.ts";

const NOW = "2026-08-12T12:00:00.000Z";
const EARLIER = "2026-08-12T11:00:00.000Z";
const DIGEST = "a".repeat(64);

const jobs = [
  { id: "job-1", status: "completed", tool: "text.echo", attempts: 1, retrySafe: true, createdAt: EARLIER, updatedAt: NOW, executionRunId: "execution-1", envelopeDigest: DIGEST, auditCorrelationId: "correlation-1" },
  { id: "job-2", status: "failed", tool: "process.exec", attempts: 2, retrySafe: false, createdAt: EARLIER, updatedAt: NOW, executionRunId: "execution-2" },
  { id: "job-3", status: "running", tool: "workspace.readText", attempts: 3, retrySafe: true, createdAt: EARLIER, updatedAt: NOW, executionRunId: "execution-3" },
] as const;
const runs = [
  { id: "run-1", status: "completed", tool: "text.echo", message: "Audited run", eventCount: 2, actor: "local", lastEventAt: NOW },
  { id: "run-2", status: "needs-review", tool: "browser.click", message: "Outcome needs review", eventCount: 3, actor: "gateway", lastEventAt: NOW },
] as const;
const workflows = [
  { runId: "workflow-1", definitionDigest: DIGEST, status: "running", updatedAt: NOW },
  { runId: "workflow-2", definitionDigest: DIGEST, status: "failed", updatedAt: NOW },
] as const;
const watches = [{ watchId: "watch-1", enabled: true, updatedAt: NOW }] as const;

function itemStatus(item: any): string { return String(item.status ?? (item.enabled ? "enabled" : "disabled")); }

function itemSearchText(item: any): string {
  return Object.values(item).filter((value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean").join(" ").toLowerCase();
}

function page<T>(items: readonly T[], query: OperatorSnapshotSourceQueryV1, attentionStatuses: readonly string[]) {
  const visible = items.filter((item) => (!query.status || itemStatus(item) === query.status)
    && (!query.query || itemSearchText(item).includes(query.query.toLowerCase())));
  return {
    items: visible.slice(query.offset, query.offset + query.limit),
    total: visible.length,
    attention: visible.filter((item) => attentionStatuses.includes(itemStatus(item))).length
  };
}

function basePort(overrides: Partial<OperatorSnapshotReadPort> = {}): OperatorSnapshotReadPort {
  return {
    readEnvironment: async () => ({
      identity: { state: "/state", workspaceRoot: "/workspace", version: "1.1.0", commit: "abc123" },
      runtime: { gateway: "available", mcp: true, workflows: true, eventIngress: true, projectContext: true }
    }),
    queryJobs: async (query) => page(jobs, query, ["failed", "needs-review"]),
    queryRuns: async (query) => page(runs, query, ["failed", "blocked", "needs-review"]),
    readLatestAttempts: async (runIds) => runIds.map((runId, index) => ({
      id: `attempt-${index + 1}`,
      runId,
      attemptNumber: index + 1,
      state: runId === "run-2" ? "needs-review" : "completed",
      createdAt: EARLIER,
      startedAt: EARLIER,
      settledAt: NOW,
      outcomeDigest: DIGEST,
      ...(runId === "run-2" ? { errorCode: "OUTCOME_UNKNOWN" } : {})
    })),
    readApprovals: async () => [{
      id: "approval-1",
      status: "claimed",
      createdAt: EARLIER,
      expiresAt: Date.parse(NOW) + 60_000,
      runId: "run-approval",
      tool: "process.exec",
      effect: {
        version: 1,
        tool: "process.exec",
        summary: "Run one approved process.",
        capability: "process.exec",
        inputDigest: DIGEST,
        reversible: "uncertain",
        idempotency: "unknown",
        command: "[redacted]"
      }
    }],
    queryWorkflows: async (query) => page(workflows, query, ["failed", "needs-review", "awaiting-approval"]),
    queryEventWatches: async (query) => page(watches, query, []),
    readSchedules: async () => [
      { id: "schedule-1", name: "Healthy schedule", enabled: true, updatedAt: NOW, nextRunAt: NOW },
      { id: "schedule-2", name: "Failed schedule", enabled: true, lastStatus: "error", updatedAt: NOW, nextRunAt: null }
    ],
    readRecovery: async () => ({
      browser: { invalid: false, status: "clear" },
      sandbox: { invalid: false, pendingCount: 0 },
      process: { invalid: false, pendingCount: 1 },
    }),
    readAudit: async () => ({
      summary: { events: 12, runs: 2, attentionRuns: 1 },
      integrity: { valid: true, checked: true, unsigned: 0, failures: [] }
    }),
    ...overrides
  };
}

function request(input: Record<string, unknown> = {}): OperatorSnapshotReadRequestV1 {
  const value: OperatorSnapshotReadRequestV1 = {
    version: APPLICATION_CONTRACT_VERSION,
    kind: "operator-snapshot-read-request",
    requestId: "operator-request-1",
    context: {
      principal: { principalId: "local-operator", actorId: "test", kind: "operator" },
      scope: { tenantId: "local" },
      sourceReference: "test:operator",
      correlationId: "operator-correlation-1",
      cancellationControlReference: "test:operator:cancel"
    },
    operation: { kind: "query", id: "operator.snapshot.read" },
    input
  };
  return value;
}

async function snapshot(input: Record<string, unknown> = {}, port = basePort()) {
  return (await createOperatorSnapshotReadUseCase(port, { now: () => new Date(NOW) }).execute(request(input))).output;
}

test("operator application use case owns deterministic paging, counts, filters, health, and latest-attempt enrichment", async () => {
  const attemptReads: readonly string[][] = [];
  const readLatestAttempts = async (runIds: readonly string[]) => {
    (attemptReads as string[][]).push([...runIds]);
    return runIds.map((runId) => ({ id: `latest-${runId}`, runId, attemptNumber: 2, state: "completed", createdAt: EARLIER, settledAt: NOW }));
  };
  const output = await snapshot({ surface: "tui", pageSize: 2, pages: { work: 2, automation: 2, recovery: 2 } }, basePort({ readLatestAttempts }));

  assert.equal(output.schemaVersion, 1);
  assert.equal(output.generatedAt, NOW);
  assert.equal(output.surface, "tui");
  assert.deepEqual(output.sections.work.counts, { total: 5, jobs: 3, runs: 2, attention: 2 });
  assert.deepEqual(output.sections.work.pagination, { page: 2, pageSize: 2, pages: 3, total: 5, from: 3, to: 4 });
  assert.deepEqual(output.sections.work.items.map((item) => item.id), ["job-3", "run-1"]);
  assert.equal(output.sections.work.items[0]?.details.latestAttempt?.runId, "execution-3");
  assert.equal(output.sections.work.items[1]?.details.latestAttempt?.runId, "run-1");
  assert.deepEqual(attemptReads, [["execution-3", "run-1"]]);
  assert.deepEqual(output.sections.automation.counts, { total: 5, workflows: 2, watches: 1, schedules: 2, attention: 2 });
  assert.deepEqual(output.sections.automation.items.map((item) => item.kind), ["event-watch", "schedule"]);
  assert.equal(output.sections.approvals.items[0]?.status, "claimed");
  assert.equal(output.sections.recovery.items.find((item) => item.id === "process-recovery")?.status, "needs-review");
  assert.equal(output.health.status, "attention");
  assert.equal(output.health.attention, 6);
  assert.ok(Object.isFrozen(output));
  validateOperatorSnapshotV1(output);

  const filtered = await snapshot({ query: "process.exec", status: "all", pageSize: 50 });
  assert.deepEqual(filtered.sections.work.items.map((item) => item.id), ["job-2"]);
  assert.deepEqual(filtered.sections.work.counts, { total: 1, jobs: 1, runs: 0, attention: 1 });
  assert.equal(filtered.health.attention, output.health.attention, "global health must not change with filters");
});

test("application paging reaches jobs and runs beyond the legacy in-memory caps", async () => {
  const jobTotal = 650;
  const runTotal = 250;
  const virtualPage = (
    total: number,
    query: OperatorSnapshotSourceQueryV1,
    create: (index: number) => Record<string, unknown>,
  ) => ({
    items: Array.from({ length: Math.min(query.limit, Math.max(0, total - query.offset)) }, (_, index) => create(query.offset + index + 1)),
    total,
    attention: 0,
  });
  const port = basePort({
    queryJobs: async (query) => virtualPage(jobTotal, query, (index) => ({
      id: `deep-job-${index}`,
      status: "completed",
      tool: "text.echo",
      attempts: 1,
      retrySafe: true,
      createdAt: EARLIER,
      executionRunId: `deep-execution-${index}`,
    })),
    queryRuns: async (query) => virtualPage(runTotal, query, (index) => ({
      id: `deep-run-${index}`,
      status: "completed",
      tool: "text.echo",
      eventCount: 1,
      actor: "test",
      lastEventAt: NOW,
    })),
    readLatestAttempts: async () => [],
  });

  const jobPage = await snapshot({ pageSize: 50, pages: { work: 12 } }, port);
  assert.deepEqual(jobPage.sections.work.pagination, { page: 12, pageSize: 50, pages: 18, total: 900, from: 551, to: 600 });
  assert.deepEqual(jobPage.sections.work.items.map((item) => item.id), Array.from({ length: 50 }, (_, index) => `deep-job-${551 + index}`));

  const runPage = await snapshot({ pageSize: 50, pages: { work: 18 } }, port);
  assert.deepEqual(runPage.sections.work.pagination, { page: 18, pageSize: 50, pages: 18, total: 900, from: 851, to: 900 });
  assert.deepEqual(runPage.sections.work.items.map((item) => item.id), Array.from({ length: 50 }, (_, index) => `deep-run-${201 + index}`));
});

test("application preserves pending and claimed approvals plus terminal and review attempt states", async () => {
  const output = await snapshot({ pageSize: 50 }, basePort({
    readApprovals: async () => [
      { id: "approval-pending", status: "pending", tool: "browser.click", createdAt: EARLIER, expiresAt: Date.parse(NOW) + 60_000 },
      { id: "approval-claimed", status: "claimed", tool: "process.exec", createdAt: NOW, expiresAt: Date.parse(NOW) + 60_000 },
    ],
    readLatestAttempts: async (runIds) => runIds.map((runId, index) => ({
      id: `state-attempt-${index + 1}`,
      runId,
      attemptNumber: index + 1,
      state: runId === "execution-2" ? "awaiting-approval" : runId === "run-2" ? "needs-review" : "completed",
      createdAt: EARLIER,
      ...(runId === "run-2" ? { settledAt: NOW, errorCode: "OUTCOME_UNKNOWN" } : {}),
    })),
  }));

  assert.deepEqual(output.sections.approvals.items.map((item) => [item.id, item.status]), [
    ["approval-pending", "pending"],
    ["approval-claimed", "claimed"],
  ]);
  const attempts = new Map(output.sections.work.items
    .filter((item) => item.kind === "job" || item.kind === "run")
    .map((item) => [item.id, item.details.latestAttempt]));
  assert.equal(attempts.get("job-2")?.state, "awaiting-approval");
  assert.equal(attempts.get("run-2")?.state, "needs-review");
  assert.equal(attempts.get("run-2")?.errorCode, "OUTCOME_UNKNOWN");
});

test("malformed recovery components become bounded needs-review records", async () => {
  let getterInvoked = false;
  const hostile: Record<string, unknown> = {};
  Object.defineProperty(hostile, "pendingCount", { enumerable: true, get() { getterInvoked = true; return 0; } });
  const output = await snapshot({ pageSize: 50 }, basePort({
    readRecovery: async () => ({ browser: 42, sandbox: hostile, process: { invalid: false, pendingCount: "not-a-count" } } as unknown as OperatorRecoverySourceV1),
  }));

  assert.equal(getterInvoked, false);
  assert.deepEqual(output.sections.recovery.items.map((item) => [item.id, item.status, item.details.pending]), [
    ["browser-recovery", "needs-review", true],
    ["sandbox-recovery", "needs-review", null],
    ["process-recovery", "needs-review", null],
  ]);
  assert.equal(output.sections.recovery.counts.attention, 3);
  validateOperatorSnapshotV1(output);
});

test("operator V1 validators reject unknown fields and every non-JSON shape before serialization", async () => {
  const valid = await snapshot({ pageSize: 50 });
  const clone = () => structuredClone(valid) as any;
  const failures: Array<[string, (value: any) => void]> = [
    ["unknown field", (value) => { value.sections.work.items[0].details.rawResult = "hidden"; }],
    ["symbol metadata", (value) => { value[Symbol("metadata")] = "hidden"; }],
    ["BigInt", (value) => { value.health.attention = 1n; }],
    ["non-finite number", (value) => { value.health.attention = Number.POSITIVE_INFINITY; }],
    ["malformed timestamp", (value) => { value.generatedAt = "2026-08-12"; }],
    ["malformed count", (value) => { value.sections.work.counts.total = -1; }],
  ];
  for (const [name, mutate] of failures) {
    const value = clone();
    mutate(value);
    assert.throws(() => validateOperatorSnapshotV1(value), ApplicationContractValidationError, name);
  }

  const accessor = clone();
  let getterInvoked = false;
  Object.defineProperty(accessor.health, "summary", { enumerable: true, get() { getterInvoked = true; return "unsafe"; } });
  assert.throws(() => validateOperatorSnapshotV1(accessor), ApplicationContractValidationError);
  assert.equal(getterInvoked, false);

  const cyclic = clone();
  cyclic.identity.loop = cyclic;
  assert.throws(() => validateOperatorSnapshotV1(cyclic), ApplicationContractValidationError);

  assert.throws(
    () => parseOperatorSnapshotResponseV1(`{"ok":true,"ok":true,${JSON.stringify(valid).slice(1)}`),
    ApplicationContractValidationError
  );
  assert.equal(validateOperatorSnapshotResponseV1({ ok: true, ...valid }).ok, true);

  assert.throws(
    () => validateOperatorSnapshotReadRequestV1({ ...request(), unexpected: true }),
    ApplicationContractValidationError,
  );
  const hostileRequest: Record<string, unknown> = { ...request() };
  let requestGetterInvoked = false;
  Object.defineProperty(hostileRequest, "kind", {
    enumerable: true,
    get() {
      requestGetterInvoked = true;
      return "operator-snapshot-read-request";
    },
  });
  assert.throws(() => validateOperatorSnapshotReadRequestV1(hostileRequest), ApplicationContractValidationError);
  assert.equal(requestGetterInvoked, false);
});

test("operator use case fails closed on malformed adapters without invoking hostile accessors", async () => {
  let getterInvoked = false;
  const hostile: any = { status: "completed", tool: "text.echo", attempts: 1, retrySafe: true, createdAt: NOW };
  Object.defineProperty(hostile, "id", { enumerable: true, get() { getterInvoked = true; return "job-hostile"; } });
  const port = basePort({
    queryJobs: async (query) => ({ items: query.limit ? [hostile] : [], total: 1, attention: 0 })
  });
  await assert.rejects(() => snapshot({ pageSize: 50 }, port), ApplicationContractValidationError);
  assert.equal(getterInvoked, false);

  const symbolRecord: any = { id: "job-symbol", status: "completed", tool: "text.echo", attempts: 1, retrySafe: true, createdAt: NOW };
  symbolRecord[Symbol("internal")] = "hidden";
  await assert.rejects(() => snapshot({ pageSize: 50 }, basePort({
    queryJobs: async (query) => ({ items: query.limit ? [symbolRecord] : [], total: 1, attention: 0 })
  })), ApplicationContractValidationError);

  await assert.rejects(() => snapshot({}, basePort({
    queryRuns: async () => ({ items: [], total: Number.NaN, attention: 0 })
  })), ApplicationContractValidationError);
  await assert.rejects(() => snapshot({ pageSize: 50 }, basePort({
    queryJobs: async (query) => ({ items: query.limit ? [{ ...jobs[0], updatedAt: "not-a-time" }] : [], total: 1, attention: 0 })
  })), ApplicationContractValidationError);
  await assert.rejects(() => snapshot({ pageSize: 50 }, basePort({
    queryJobs: async (query) => ({ items: query.limit ? [{ ...jobs[0], updatedAt: "2026-08-12T12:00:00Z" }] : [], total: 1, attention: 0 })
  })), ApplicationContractValidationError);
});

test("operator projection redacts secret-like source text and does not expose raw tool input or output", async () => {
  const secret = "authorization=Bearer abcdefghijklmnop";
  const output = await snapshot({ pageSize: 50 }, basePort({
    queryJobs: async (query) => ({
      items: query.limit ? [{ ...jobs[0], tool: secret, rawInput: { password: "never" }, rawResult: "never" }] : [],
      total: 1,
      attention: 0
    }),
    queryRuns: async () => ({ items: [], total: 0, attention: 0 })
  }));
  const serialized = JSON.stringify(output);
  assert.equal(output.sections.work.items[0]?.label, "[redacted]");
  assert.doesNotMatch(serialized, /abcdefghijklmnop|password|rawInput|rawResult|never/u);
});

test("operator read honors cancellation before querying authoritative sources", async () => {
  let reads = 0;
  const controller = new AbortController();
  controller.abort();
  const port = basePort({ readEnvironment: async () => { reads += 1; return basePort().readEnvironment(request().context); } });
  await assert.rejects(
    () => createOperatorSnapshotReadUseCase(port).execute(request(), { signal: controller.signal }),
    (error: any) => error?.name === "AbortError"
  );
  assert.equal(reads, 0);
});

test("CLI and TUI local snapshots share the application use case without creating or reconciling state", async () => {
  const parent = await mkdtemp(join(tmpdir(), "odinn-operator-local-"));
  const stateDir = join(parent, "missing-state");
  const common = {
    stateDir,
    workspaceRoot: parent,
    applicationVersion: "1.1.0",
    applicationCommit: "test-commit",
    input: { surface: "cli" as const, pageSize: 25 }
  };
  const cli = await readLocalOperatorSnapshot(common);
  const tui = await readLocalOperatorSnapshot({ ...common, input: { ...common.input, surface: "tui" } });
  validateOperatorSnapshotV1(cli);
  validateOperatorSnapshotV1(tui);
  assert.equal(cli.surface, "cli");
  assert.equal(tui.surface, "tui");
  assert.deepEqual(cli.sections, tui.sections);
  assert.deepEqual(cli.health, tui.health);
  await assert.rejects(() => access(stateDir), (error: any) => error?.code === "ENOENT");
});

test("remote operator mode forwards status=all and every section-specific page", () => {
  const argumentsList = [
    "--page", "3",
    "--page-size", "17",
    "--query", "durable",
    "--status", "all",
    ...OPERATOR_SECTION_PAGE_OPTIONS.flatMap((name, index) => [`--${name}-page`, String(index + 2)])
  ];
  const input = operatorSnapshotInputFromArgs(argumentsList, "cli");
  assert.equal(input.status, "all");
  assert.equal(input.pages?.surfaces, 9);
  const query = operatorSnapshotRemoteQueryFromArgs(argumentsList, "cli");
  assert.equal(query.get("surface"), "cli");
  assert.equal(query.get("page"), "3");
  assert.equal(query.get("pageSize"), "17");
  assert.equal(query.get("q"), "durable");
  assert.equal(query.get("status"), "all");
  OPERATOR_SECTION_PAGE_OPTIONS.forEach((name, index) => assert.equal(query.get(`${name}Page`), String(index + 2)));
});
