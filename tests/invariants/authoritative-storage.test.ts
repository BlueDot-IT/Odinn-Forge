import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browseMemory, searchMemory } from "../../packages/kernel/src/memory.ts";
import {
  listGoals,
  listProjects,
  listSessions,
  readSession,
  resolveProject
} from "../../packages/kernel/src/workspace-records.ts";
import { SqliteRecordStore } from "../../packages/store-sqlite/src/authoritative.ts";

const RECORD_COUNT = 10_000;
const PROJECT_COUNT = 10;
const SESSION_COUNT = 1_000;
const GOAL_COUNT = 500;

test("large authoritative stores preserve mixed projection and scope invariants", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-authoritative-storage-invariant-"));
  const store = new SqliteRecordStore(join(root, "records.sqlite"));
  let appended = 0;
  const append = (record: Record<string, unknown>) => {
    store.appendSync({ at: new Date(appended).toISOString(), ...record });
    appended += 1;
  };

  try {
    store.transaction(() => {
      while (appended < RECORD_COUNT) {
        const index = appended;
        if (index < PROJECT_COUNT) {
          append({ id: `project-${index}`, type: "project.created", status: "active", name: `Project ${index}` });
          continue;
        }
        if (index < PROJECT_COUNT + SESSION_COUNT) {
          const session = index - PROJECT_COUNT;
          append({ id: `session-${session}`, type: "session.created", status: "open", projectId: `project-${session % PROJECT_COUNT}`, title: `Session ${session}` });
          continue;
        }
        if (index < PROJECT_COUNT + SESSION_COUNT + GOAL_COUNT) {
          const goal = index - PROJECT_COUNT - SESSION_COUNT;
          const session = goal % SESSION_COUNT;
          append({ id: `goal-${goal}`, type: "goal.created", status: "active", sessionId: `session-${session}`, projectId: `project-${session % PROJECT_COUNT}`, title: `Goal ${goal}` });
          continue;
        }

        const mixed = index - PROJECT_COUNT - SESSION_COUNT - GOAL_COUNT;
        const selector = mixed % 20;
        if (selector < 10) {
          const session = mixed % SESSION_COUNT;
          append({ id: `message-${mixed}`, type: "message.appended", sessionId: `session-${session}`, externalId: `external-${mixed}`, role: mixed % 2 ? "assistant" : "user", content: `message ${mixed}` });
        } else if (selector < 19) {
          const project = Math.floor(mixed / 20) % PROJECT_COUNT;
          append({ id: `memory-${mixed}`, type: "memory", status: "active", scopeType: "project", scopeId: `project-${project}`, projectId: `project-${project}`, namespace: `projects/${project}/facts`, kind: "project", subject: `subject-${mixed % 1_000}`, tier: mixed % 3 === 0 ? "l0" : "l1", text: `authoritative invariant fact ${mixed}` });
        } else {
          const goal = mixed % GOAL_COUNT;
          append({ id: `goal-update-${mixed}`, type: "goal.updated", goalId: `goal-${goal}`, status: mixed % 40 === 19 ? "completed" : "active", note: `update ${mixed}` });
        }
      }
    });

    assert.equal(appended, RECORD_COUNT);
    assert.equal(await store.countRecords(), RECORD_COUNT);
    assert.equal((await listProjects(store, { limit: 20 })).projects[0]?.id, "project_default");

    for (let project = 0; project < PROJECT_COUNT; project += 1) {
      const projectId = `project-${project}`;
      assert.equal((await resolveProject(store, projectId))?.id, projectId);
      const sessions = await listSessions(store, { projectId, limit: 20 });
      assert.equal(sessions.sessions.length, 20);
      assert.ok(sessions.sessions.every((session) => session.projectId === projectId));
      const goals = await listGoals(store, { projectId, limit: 20 });
      assert.ok(goals.goals.length > 0);
      assert.ok(goals.goals.every((goal) => goal.projectId === projectId));

      const sessionId = `session-${project}`;
      assert.ok((await readSession(store, { sessionId, limit: 20 })).messages.length > 0);
      assert.equal((await store.findMessageByExternalId(sessionId, `external-${project}`))?.id, `message-${project}`);

      const memories = await searchMemory(store, { projectId, query: "authoritative invariant", limit: 8 });
      assert.equal(memories.memories.length, 8);
      assert.ok(memories.memories.every((memory) => memory.projectId === projectId));
      const browse = await browseMemory(store, { projectId, namespace: `projects/${project}`, limit: 20 });
      assert.ok(browse.records.length > 0);
      assert.ok(browse.records.every((record) => record.projectId === projectId && record.namespace.startsWith(`projects/${project}/`)));
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
