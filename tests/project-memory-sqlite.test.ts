import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuditStore, createBuiltInRegistry, runTask } from "../packages/kernel/src/index.ts";
import { createDefaultPolicy } from "../packages/policy/src/index.ts";

const roots: string[] = [];
const registries: Array<ReturnType<typeof createBuiltInRegistry>> = [];

test.after(async () => {
  for (const registry of registries) registry.close();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("SQLite authoritative path preserves workspace and scoped memory behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-project-memory-sqlite-"));
  roots.push(root);
  const stateDir = join(root, ".odinn");
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir, auditStore });
  registries.push(registry);
  const policy = createDefaultPolicy();
  const execute = async (id: string, tool: string, input: Record<string, unknown> = {}) => (await runTask({ task: { id, tool, input, actor: "test" }, auditStore, policy, registry })).output;

  const project = await execute("project-create", "project.create", { name: "SQLite project" });
  const session = await execute("session-create", "session.create", { projectId: project.id, title: "SQLite session" });
  await execute("message-1", "session.message", { sessionId: session.id, role: "user", content: "indexed history", externalId: "external-1" });
  const replay = await execute("message-2", "session.message", { sessionId: session.id, role: "user", content: "different content", externalId: "external-1" });
  assert.equal(replay.content, "indexed history");
  const read = await execute("session-read", "session.read", { sessionId: session.id, limit: 20 });
  assert.equal(read.messages.length, 1);

  const memory = await execute("memory-write", "memory.remember", {
    text: "SQLite records preserve provenance", kind: "decision", namespace: "project/sqlite",
    subject: "storage", scopeType: "project", scopeId: project.id, projectId: project.id
  });
  const search = await execute("memory-search", "memory.search", { query: "preserve provenance", projectId: project.id, limit: 20 });
  assert.equal(search.memories[0]?.id, memory.id);
  const projects = await execute("project-list", "project.list", { limit: 10 });
  assert.equal(projects.projects.find((entry: any) => entry.id === project.id)?.name, "SQLite project");

  await execute("memory-forget", "memory.forget", { targetId: memory.id });
  const recalled = await execute("memory-recall-after-forget", "memory.recall", { query: "preserve provenance", projectId: project.id, limit: 20 });
  assert.equal(recalled.memories.some((entry: any) => entry.id === memory.id), false);
});
