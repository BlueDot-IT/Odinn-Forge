import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listMemoryCandidates, searchMemory } from "../packages/kernel/src/memory.ts";
import { listGoals, listSessions, readSession, reduceGoals, reduceProjects, reduceSessions, resolveSession } from "../packages/kernel/src/workspace-records.ts";
import { SqliteRecordStore } from "../packages/store-sqlite/src/authoritative.ts";

const roots: string[] = [];

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "odinn-workspace-pagination-"));
  roots.push(root);
  return new SqliteRecordStore(join(root, "records.sqlite"));
}

test.after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("current projections page more than 2,000 sessions without caps, skips, or duplicates", async () => {
  const store = await createStore();
  try {
    store.transaction(() => {
      for (let index = 0; index < 2_501; index += 1) {
        store.appendSync({ id: `session-${index}`, type: "session.created", status: "open", projectId: "project_default", title: `Session ${index}` });
      }
    });
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listSessions(store, { limit: 137, ...(cursor ? { cursor } : {}) });
      ids.push(...page.sessions.map((session) => session.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(ids.length, 2_501);
    assert.equal(new Set(ids).size, 2_501);
    assert.deepEqual(ids.slice(0, 3), ["session-0", "session-1", "session-2"]);
  } finally {
    store.close();
  }
});

test("session reassignment updates projected session and scoped goal state atomically", async () => {
  const store = await createStore();
  try {
    await store.append({ id: "project-a", type: "project.created", status: "active", name: "A" });
    await store.append({ id: "project-b", type: "project.created", status: "active", name: "B" });
    await store.append({ id: "session-1", type: "session.created", status: "open", projectId: "project-a" });
    await store.append({ id: "goal-1", type: "goal.created", status: "active", sessionId: "session-1", projectId: "project-a", title: "Move with session" });
    await store.append({ id: "assign-1", type: "session.assigned", sessionId: "session-1", projectId: "project-b" });
    assert.equal((await resolveSession(store, "session-1"))?.projectId, "project-b");
    assert.deepEqual((await listGoals(store, { projectId: "project-a" })).goals, []);
    assert.deepEqual((await listGoals(store, { projectId: "project-b" })).goals.map((goal) => goal.id), ["goal-1"]);
    assert.deepEqual(await store.projectEntityCounts("project-a"), { sessionCount: 0, goalCount: 0, activeGoalCount: 0 });
    assert.deepEqual(await store.projectEntityCounts("project-b"), { sessionCount: 1, goalCount: 1, activeGoalCount: 1 });
  } finally {
    store.close();
  }
});

test("session message pages use stable sequence cursors across backdated events", async () => {
  const store = await createStore();
  try {
    await store.append({ id: "session-messages", type: "session.created", status: "open", projectId: "project_default" });
    for (let index = 0; index < 17; index += 1) {
      await store.append({ id: `message-${index}`, type: "message.appended", sessionId: "session-messages", role: "user", content: String(index), at: index === 12 ? "2020-01-01T00:00:00.000Z" : `2026-08-01T00:00:${String(index).padStart(2, "0")}.000Z` });
    }
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await readSession(store, { sessionId: "session-messages", limit: 5, ...(cursor ? { cursor } : {}) });
      ids.push(...page.messages.map((message) => message.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(ids, Array.from({ length: 17 }, (_, index) => `message-${index}`));
  } finally {
    store.close();
  }
});

test("workspace projections preserve reducer parity on production-shaped event histories", async () => {
  const store = await createStore();
  try {
    const events = [
      { id: "project-1", type: "project.created", status: "active", name: "Original", description: "Before" },
      { id: "project-event-1", type: "project.updated", projectId: "project-1", name: "Current", description: "After" },
      { id: "session-1", type: "session.created", status: "open", projectId: "project-1", title: "Original" },
      { id: "session-event-1", type: "session.renamed", sessionId: "session-1", title: "Current" },
      { id: "message-1", type: "message.appended", sessionId: "session-1", role: "user", content: "one" },
      { id: "message-2", type: "message.appended", sessionId: "session-1", role: "assistant", content: "two" },
      { id: "goal-1", type: "goal.created", status: "active", sessionId: "session-1", projectId: "project-1", title: "Original goal" },
      { id: "goal-event-1", type: "goal.updated", goalId: "goal-1", status: "completed", title: "Current goal", note: "done" }
    ];
    for (const event of events) await store.append(event);
    const records = (await store.queryRecordsPage({ limit: 200, order: "asc" })).records;
    assert.deepEqual(await store.getCurrentProject("project-1"), reduceProjects(records).find((project) => project.id === "project-1"));
    assert.deepEqual(await store.getCurrentSession("session-1"), reduceSessions(records).find((session) => session.id === "session-1"));
    assert.deepEqual(await store.getCurrentGoal("goal-1"), reduceGoals(records).find((goal) => goal.id === "goal-1"));
  } finally {
    store.close();
  }
});

test("ranked memory cursors drain candidate windows without skipping or duplicating matches", async () => {
  const store = await createStore();
  try {
    store.transaction(() => {
      for (let index = 0; index < 75; index += 1) {
        store.appendSync({
          id: `memory-${index}`, type: "memory", status: "active", scopeType: "global",
          namespace: "tests/pagination", kind: "project", subject: "pagination",
          tier: "l1", confidence: 1, text: `needle ranked memory ${index}`
        });
      }
    });
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await searchMemory(store, { query: "needle ranked memory", namespace: "tests/pagination", limit: 7, ...(cursor ? { cursor } : {}) });
      ids.push(...page.memories.map((memory: any) => String(memory.id)));
      cursor = page.nextCursor;
      assert.equal(page.hasMore, Boolean(cursor));
    } while (cursor);
    assert.equal(ids.length, 75);
    assert.equal(new Set(ids).size, 75);
  } finally {
    store.close();
  }
});

test("filtered candidate pagination does not discard over-fetched pending records", async () => {
  const store = await createStore();
  try {
    store.transaction(() => {
      for (let index = 0; index < 30; index += 1) {
        store.appendSync({ id: `candidate-${index}`, type: "memory.candidate", status: "pending", kind: "project", subject: "pagination", namespace: "tests/candidates", text: `candidate ${index}` });
        if (index % 2 === 0) store.appendSync({ id: `decision-${index}`, type: "memory.candidate.decision", candidateId: `candidate-${index}`, decision: "rejected" });
      }
    });
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listMemoryCandidates(store, { status: "pending", limit: 7, ...(cursor ? { cursor } : {}) });
      ids.push(...page.candidates.map((candidate: any) => String(candidate.id)));
      cursor = page.nextCursor;
      assert.equal(page.hasMore, Boolean(cursor));
    } while (cursor);
    assert.equal(ids.length, 15);
    assert.equal(new Set(ids).size, 15);
    assert.ok(ids.every((id) => Number(id.split("-")[1]) % 2 === 1));
  } finally {
    store.close();
  }
});
