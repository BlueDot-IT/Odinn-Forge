import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { browseMemory, searchMemory } from "../../packages/kernel/src/memory.ts";
import { listGoals, listProjects, listSessions, readSession, resolveProject } from "../../packages/kernel/src/workspace-records.ts";
import { SqliteRecordStore } from "../../packages/store-sqlite/src/authoritative.ts";

const sizes = (process.env.BENCHMARK_SIZES ?? "10000,100000,1000000")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isSafeInteger(value) && value >= 10_000);
const samples = Number(process.env.BENCHMARK_SAMPLES ?? 100);
const chunkSize = Number(process.env.BENCHMARK_CHUNK_SIZE ?? 5_000);

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

function metrics(values: number[]) {
  return {
    p50: Number(percentile(values, 0.50).toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
    p99: Number(percentile(values, 0.99).toFixed(3))
  };
}

for (const size of sizes) {
  const root = await mkdtemp(join(tmpdir(), `odinn-authoritative-benchmark-${size}-`));
  const store = new SqliteRecordStore(join(root, "records.sqlite"));
  const projectCount = Math.max(10, Math.min(1_000, Math.floor(size / 1_000)));
  const sessionCount = Math.max(100, Math.min(20_000, Math.floor(size / 10)));
  const goalCount = Math.max(100, Math.min(10_000, Math.floor(size / 20)));
  const baseline = process.memoryUsage();
  let peakHeap = baseline.heapUsed;
  let peakRss = baseline.rss;
  let appended = 0;
  const sampleMemory = () => {
    const usage = process.memoryUsage();
    peakHeap = Math.max(peakHeap, usage.heapUsed);
    peakRss = Math.max(peakRss, usage.rss);
  };
  const append = (record: Record<string, unknown>) => {
    store.appendSync({ at: new Date(appended).toISOString(), ...record });
    appended += 1;
    if (appended % 1_024 === 0) sampleMemory();
  };

  const appendStart = performance.now();
  for (let start = 0; start < size; start += chunkSize) {
    store.transaction(() => {
      while (appended < Math.min(size, start + chunkSize)) {
        const index = appended;
        if (index < projectCount) {
          append({ id: `project-${index}`, type: "project.created", status: "active", name: `Project ${index}` });
        } else if (index < projectCount + sessionCount) {
          const session = index - projectCount;
          append({ id: `session-${session}`, type: "session.created", status: "open", projectId: `project-${session % projectCount}`, title: `Session ${session}` });
        } else if (index < projectCount + sessionCount + goalCount) {
          const goal = index - projectCount - sessionCount;
          const session = goal % sessionCount;
          append({ id: `goal-${goal}`, type: "goal.created", status: "active", sessionId: `session-${session}`, projectId: `project-${session % projectCount}`, title: `Goal ${goal}` });
        } else {
          const mixed = index - projectCount - sessionCount - goalCount;
          const session = mixed % sessionCount;
          if (mixed % 10 < 6) {
            append({ id: `message-${mixed}`, type: "message.appended", sessionId: `session-${session}`, externalId: `external-${mixed}`, role: mixed % 2 ? "assistant" : "user", content: `message ${mixed}` });
          } else if (mixed % 10 < 9) {
            append({ id: `memory-${mixed}`, type: "memory", status: "active", scopeType: "project", scopeId: `project-${mixed % projectCount}`, projectId: `project-${mixed % projectCount}`, namespace: `projects/${mixed % projectCount}/facts`, kind: "project", subject: `subject-${mixed % 1_000}`, tier: mixed % 3 === 0 ? "l0" : "l1", text: `authoritative storage benchmark fact ${mixed}` });
          } else {
            const goal = mixed % goalCount;
            append({ id: `goal-update-${mixed}`, type: "goal.updated", goalId: `goal-${goal}`, status: mixed % 20 === 9 ? "completed" : "active", note: `update ${mixed}` });
          }
        }
      }
    });
  }
  const appendMs = performance.now() - appendStart;
  sampleMemory();
  assert.equal(appended, size);
  assert.equal(await store.countRecords(), size);

  const operationLatencies: Record<string, number[]> = {
    sessions: [], projects: [], goals: [], messages: [], memory_search: [], memory_browse: [], external_id: []
  };
  for (let sample = 0; sample < samples; sample += 1) {
    const projectId = `project-${sample % projectCount}`;
    const messageNumber = (sample * 10) % Math.max(10, size - projectCount - sessionCount - goalCount);
    const messageSessionId = `session-${messageNumber % sessionCount}`;
    const timed = async (name: keyof typeof operationLatencies, operation: () => Promise<unknown>) => {
      const start = performance.now();
      const result = await operation();
      operationLatencies[name].push(performance.now() - start);
      sampleMemory();
      return result;
    };
    const sessions = await timed("sessions", () => listSessions(store, { projectId, limit: 20 })) as Awaited<ReturnType<typeof listSessions>>;
    assert.ok(sessions.sessions.every((session) => session.projectId === projectId));
    const projects = await timed("projects", () => listProjects(store, { limit: 20 })) as Awaited<ReturnType<typeof listProjects>>;
    assert.equal(projects.projects[0]?.id, "project_default");
    assert.equal((await resolveProject(store, projectId))?.id, projectId);
    const goals = await timed("goals", () => listGoals(store, { projectId, limit: 20 })) as Awaited<ReturnType<typeof listGoals>>;
    assert.ok(goals.goals.every((goal) => goal.projectId === projectId));
    const messages = await timed("messages", () => readSession(store, { sessionId: messageSessionId, limit: 20 })) as Awaited<ReturnType<typeof readSession>>;
    assert.ok(messages.messages.length > 0);
    const found = await timed("external_id", async () => store.findMessageByExternalId(messageSessionId, `external-${messageNumber}`));
    assert.equal((found as Record<string, unknown> | undefined)?.id, `message-${messageNumber}`);
    const memories = await timed("memory_search", () => searchMemory(store, { projectId, query: "authoritative storage benchmark", limit: 8 })) as Awaited<ReturnType<typeof searchMemory>>;
    assert.ok(memories.memories.length <= 8);
    const browse = await timed("memory_browse", () => browseMemory(store, { projectId, namespace: `projects/${sample % projectCount}`, limit: 20 })) as Awaited<ReturnType<typeof browseMemory>>;
    assert.ok(browse.records.every((record: any) => String(record.namespace).startsWith(`projects/${sample % projectCount}`)));
  }

  store.close();
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({
    rows: size,
    shape: { projects: projectCount, sessions: sessionCount, goals: goalCount, mixed: size - projectCount - sessionCount - goalCount },
    append_ms: Number(appendMs.toFixed(3)),
    operations_ms: Object.fromEntries(Object.entries(operationLatencies).map(([name, values]) => [name, metrics(values)])),
    peak_heap_delta_mb: Number(((peakHeap - baseline.heapUsed) / 1024 / 1024).toFixed(3)),
    peak_rss_delta_mb: Number(((peakRss - baseline.rss) / 1024 / 1024).toFixed(3))
  }));
}
