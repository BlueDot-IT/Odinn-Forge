import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuditStore, createBuiltInRegistry, runTask } from "../packages/kernel/src/index.ts";
import { recallMemory, searchMemory } from "../packages/kernel/src/memory.ts";

class MemoryFixtureStore {
  records: any[];

  constructor(records: any[]) {
    this.records = records;
  }

  async append(record: any) {
    const stored = { ...record, at: record.at ?? new Date().toISOString() };
    this.records.push(stored);
    return stored;
  }

  async queryRecordsPage(query: any = {}) {
    const all = this.records.filter((record) => {
      if (query.types?.length && !query.types.includes(record.type)) return false;
      if (query.ids?.length && !query.ids.includes(record.id)) return false;
      if (query.candidateIds?.length && !query.candidateIds.includes(record.candidateId)) return false;
      if (query.namespacePrefix && !(record.namespace === query.namespacePrefix || String(record.namespace ?? "").startsWith(`${query.namespacePrefix}/`))) return false;
      if (query.scopeAny?.length && !query.scopeAny.some((scope: any) => String(record.scopeType ?? "global") === scope.scopeType && String(record.scopeId ?? "") === String(scope.scopeId ?? ""))) return false;
      if (query.activeMemoryOnly) {
        if (record.type !== "memory" || record.status !== "active") return false;
        if (record.expiresAt && String(record.expiresAt) <= new Date().toISOString()) return false;
        if (this.records.some((entry) => entry.supersedes === record.id || (entry.type === "memory.deactivation" && entry.targetId === record.id))) return false;
      }
      return true;
    });
    if (query.order === "desc") all.reverse();
    const start = query.cursor ? Number(Buffer.from(query.cursor, "base64url").toString("utf8")) : 0;
    const limit = Math.min(Number(query.limit ?? 50), 200);
    const records = all.slice(start, start + limit);
    const hasMore = start + records.length < all.length;
    return { records, hasMore, ...(hasMore ? { nextCursor: Buffer.from(String(start + records.length), "utf8").toString("base64url") } : {}) };
  }
}

function memory(id: string, text: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: "memory",
    status: "active",
    kind: "project",
    subject: "Aurora payment exports",
    namespace: "projects/aurora/payment-exports",
    tier: "l1",
    summary: text,
    text,
    tags: ["aurora", "payments", "exports"],
    source: "reviewed-client-record",
    authority: "user-reviewed",
    confidence: 0.95,
    scopeType: "project",
    scopeId: "project_aurora",
    projectId: "project_aurora",
    at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function longHorizonStore() {
  const records = [
    memory("aurora_2022", "Aurora payment exports originally reconciled weekly before invoices were released.", {
      at: "2022-03-01T00:00:00.000Z"
    }),
    memory("aurora_2023", "Aurora payment export policy changed to daily reconciliation with finance approval.", {
      kind: "decision",
      at: "2023-05-15T00:00:00.000Z"
    }),
    memory("aurora_2024_wrong", "Aurora payment exports may ship without reconciliation.", {
      kind: "decision",
      confidence: 0.6,
      at: "2024-02-01T00:00:00.000Z"
    }),
    memory("aurora_2024_correction", "Correction: Aurora payment exports require reconciliation, finance approval, and a rollback control before release.", {
      kind: "correction",
      authority: "user-correction",
      confidence: 1,
      supersedes: "aurora_2024_wrong",
      at: "2024-02-02T00:00:00.000Z"
    }),
    memory("aurora_2025", "Aurora payment export incidents use the documented rollback control and preserve reconciliation evidence.", {
      kind: "procedure",
      at: "2025-08-20T00:00:00.000Z"
    }),
    memory("aurora_2026", "Aurora payment export review confirmed reconciliation and finance approval remain mandatory.", {
      at: "2026-07-20T00:00:00.000Z"
    }),
    memory("other_project_aurora", "Aurora payment exports in another client project use a different approval flow.", {
      scopeId: "project_other",
      projectId: "project_other",
      at: "2026-07-25T00:00:00.000Z"
    }),
    memory("global_preference", "Client recommendations should name finance approval and rollback controls when operational risk is material.", {
      kind: "preference",
      subject: "operator guidance",
      namespace: "user/preferences",
      tags: ["recommendations", "rollback", "controls"],
      scopeType: "global",
      scopeId: undefined,
      projectId: undefined,
      at: "2026-07-24T00:00:00.000Z"
    })
  ];
  for (let year = 2010; year < 2024; year += 1) {
    records.push(memory(
      `northwind_${year}`,
      `Northwind archive ${year}: no decision about Aurora payment exports or policy controls.`,
      {
        subject: "Northwind annual archive",
        namespace: `archives/northwind/${year}`,
        tags: ["northwind", "archive"],
        scopeType: "global",
        scopeId: undefined,
        projectId: undefined,
        source: "annual-archive",
        authority: "agent-derived",
        confidence: 0.7,
        at: `${year}-12-31T00:00:00.000Z`
      }
    ));
  }
  return new MemoryFixtureStore(records);
}

test("long-horizon recall prefers authoritative corrections and suppresses negative archive near-matches", async () => {
  const result = await recallMemory(longHorizonStore(), {
    query: "Summarize Aurora payment export history, corrections, policy, reconciliation, finance approval, and rollback controls.",
    projectId: "project_aurora",
    limit: 8
  });

  assert.equal(result.memories.some((entry: any) => entry.id === "aurora_2024_correction"), true);
  assert.equal(result.memories.some((entry: any) => entry.id === "aurora_2024_wrong"), false);
  assert.equal(result.memories.some((entry: any) => entry.id === "other_project_aurora"), false);
  assert.equal(result.memories.some((entry: any) => entry.id.startsWith("northwind_")), false);
  assert.equal(result.memories.some((entry: any) => entry.id === "global_preference"), true);
  assert.equal(result.selection.scope.mode, "project-default");
  assert.equal(result.selection.scope.includesGlobal, true);
  assert.equal(result.selection.excluded.suppressedNegative, 14);
  const selectedCorrection = result.selection.records.find((entry: any) => entry.id === "aurora_2024_correction");
  assert.ok(selectedCorrection.retrieval.weights.correction > 0);
  assert.ok(selectedCorrection.retrieval.weights.confidence > 0);
  assert.ok(selectedCorrection.retrieval.weights.sourceAuthority > 0);
  assert.match(selectedCorrection.title, /^Correction: Aurora payment exports/);
  assert.equal(selectedCorrection.provenance.source, "reviewed-client-record");
  assert.equal(selectedCorrection.provenance.authority, "user-correction");
  assert.equal(selectedCorrection.provenance.scopeId, "project_aurora");
  assert.equal(selectedCorrection.retrieval.relevanceFloor, 0.2);
});

test("negative archive statements are available only when contrary evidence is explicitly requested", async () => {
  const inventory = await searchMemory(longHorizonStore(), { limit: 30 });
  assert.equal(inventory.memories.filter((entry: any) => entry.id.startsWith("northwind_")).length, 14);

  const ordinary = await searchMemory(longHorizonStore(), {
    query: "Aurora payment exports policy controls",
    projectId: "project_aurora"
  });
  assert.equal(ordinary.memories.some((entry: any) => entry.id.startsWith("northwind_")), false);

  const contrary = await recallMemory(longHorizonStore(), {
    query: "Find contrary evidence and no decision records about Aurora payment exports.",
    projectId: "project_aurora",
    limit: 30
  });
  assert.equal(contrary.selection.includeContrary, true);
  assert.equal(contrary.selection.excluded.suppressedNegative, 0);
  assert.equal(contrary.memories.filter((entry: any) => entry.id.startsWith("northwind_")).length, 14);
});

test("generic browser prompts do not receive unrelated durable project history", async () => {
  const result = await recallMemory(longHorizonStore(), {
    query: "Open the public IANA reserved-domains page and return the domains shown.",
    projectId: "project_aurora"
  });

  assert.deepEqual(result.memories, []);
  assert.deepEqual(result.selection.records, []);
  assert.ok(result.selection.excluded.belowRelevanceFloor > 0);
});

test("session defaults include its project and global context but exclude other sessions and projects", async () => {
  const store = longHorizonStore();
  store.records.push(
    memory("session_current", "Aurora payment export review in this session requires a dry-run.", {
      kind: "procedure",
      scopeType: "session",
      scopeId: "session_current",
      sessionId: "session_current",
      at: "2026-07-27T00:00:00.000Z"
    }),
    memory("session_other", "Aurora payment export review in another session skipped the dry-run.", {
      kind: "procedure",
      scopeType: "session",
      scopeId: "session_other",
      sessionId: "session_other",
      at: "2026-07-28T00:00:00.000Z"
    })
  );

  const result = await recallMemory(store, {
    query: "Aurora payment export review rollback controls dry-run",
    sessionId: "session_current",
    projectId: "project_aurora"
  });

  assert.equal(result.selection.scope.mode, "session-default");
  assert.equal(result.memories.some((entry: any) => entry.id === "session_current"), true);
  assert.equal(result.memories.some((entry: any) => entry.id === "session_other"), false);
  assert.equal(result.memories.some((entry: any) => entry.id === "other_project_aurora"), false);
  assert.equal(result.memories.some((entry: any) => entry.id === "global_preference"), true);
});

test("automatic agent recall preserves selected IDs, titles, and provenance in the signed run record", async () => {
  const provider = createHttpServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request before replying.
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "memory_audit_response",
      choices: [{ message: { role: "assistant", content: "Use the reviewed Aurora controls." } }]
    }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("mock provider did not bind");
  const root = await mkdtemp(join(tmpdir(), "odinn-memory-audit-"));
  const stateDir = join(root, ".odinn");
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir,
    config: {
      defaultModel: "test:test-model",
      providers: {
        test: {
          type: "openai-compatible",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          models: ["test-model"]
        }
      }
    }
  });
  const execute = (id: string, tool: string, input: Record<string, unknown> = {}) => runTask({
    task: { id, tool, input, actor: "test" },
    auditStore,
    registry
  });

  try {
    await execute("audit_project", "project.create", { id: "project_aurora", name: "Aurora" });
    const session = await execute("audit_session", "session.create", { title: "Aurora review", projectId: "project_aurora" });
    const seeded = await execute("audit_memory_seed", "memory.remember", {
      kind: "procedure",
      subject: "Aurora controls",
      summary: "Aurora reconciliation controls",
      text: "Aurora payment exports require reconciliation, finance approval, and rollback controls.",
      projectId: "project_aurora"
    });
    await execute("audit_agent_run", "agent.run", {
      model: "test:test-model",
      sessionId: session.output.id,
      projectId: "project_aurora",
      memory: { autoLearn: false, autoCompact: false },
      messages: [{ role: "user", content: "Review Aurora payment export reconciliation and rollback controls." }]
    });

    const recallCompleted = (await auditStore.readAll()).find((event: any) =>
      event.actor === "agent-memory" && event.tool === "memory.recall" && event.type === "task.completed");
    assert.ok(recallCompleted);
    assert.equal(recallCompleted.data.output.selection.records[0].id, seeded.output.id);
    assert.equal(recallCompleted.data.output.selection.records[0].title, "Aurora reconciliation controls");
    assert.equal(recallCompleted.data.output.selection.records[0].scopeId, "project_aurora");
    assert.equal(recallCompleted.data.output.selection.records[0].authority, "user-reviewed");
  } finally {
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
});
