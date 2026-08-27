#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { SqliteAuditStore } from "../../packages/store-sqlite/src/audit.ts";
import { SqliteRecordStore } from "../../packages/store-sqlite/src/authoritative.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const FULL_STATE_GROWTH_TIERS = Object.freeze([10_000, 100_000, 1_000_000]);
const PROJECT_COUNT = 20;
const SESSION_COUNT = 200;
const GOAL_COUNT = 100;
const IMPROVEMENT_COUNT = 50;
const SEEDED_RECORDS = PROJECT_COUNT + SESSION_COUNT + GOAL_COUNT + IMPROVEMENT_COUNT;
const DEFAULT_BATCH_SIZE = 5_000;
const QUERY_SAMPLES = 9;
const DEFAULT_AUDIT_EVENTS = 1_000;

export const STATE_GROWTH_BUDGETS = Object.freeze({
  maxDatabaseBytes: 3 * 1024 * 1024 * 1024,
  maxDatabaseBytesPerRecord: 3_072,
  maxRssBytes: 1536 * 1024 * 1024,
  minAppendRecordsPerSecond: 250,
  maxQueryP95Ms: 1_000,
  maxReopenMs: 120_000,
  maxIntegrityCheckMs: 120_000,
  maxAuditDatabaseBytes: 64 * 1024 * 1024,
});

type RecordInput = Parameters<SqliteRecordStore["appendSync"]>[0];
type StateGrowthBudgets = typeof STATE_GROWTH_BUDGETS;
type QueryMeasurement = { name: string; p50Ms: number; p95Ms: number; maxMs: number };
type StateGrowthTier = {
  records: number;
  appendedRecords: number;
  appendDurationMs: number;
  appendRecordsPerSecond: number;
  reopenMs: number;
  integrityCheckMs: number;
  databaseBytes: number;
  databaseBytesPerRecord: number;
  rssBytes: number;
  queries: QueryMeasurement[];
};

export type StateGrowthReport = {
  schemaVersion: 1;
  ok: boolean;
  profile: "full" | "development";
  generatedAt: string;
  sourceRevision: string;
  environment: { node: string; platform: NodeJS.Platform; arch: string; parallelism: number; totalMemoryBytes: number };
  configuration: {
    tiers: number[];
    batchSize: number;
    budgets: StateGrowthBudgets;
    retentionPolicy: {
      authoritativeRecords: "append-only";
      auditEvents: "verified-archive-before-online-retention";
      reportArtifactDays: 30;
    };
  };
  tiers: StateGrowthTier[];
  retention: {
    events: number;
    retainedThrough: number;
    deletedOnlineEvents: number;
    onlineEventsAfterRetention: number;
    archiveBytes: number;
    databaseBytes: number;
    restartIntegrityValid: boolean;
  };
  violations: string[];
};

export type StateGrowthOptions = {
  tiers?: number[];
  batchSize?: number;
  auditEvents?: number;
  reportPath?: string;
  budgets?: StateGrowthBudgets;
  enforceBudgets?: boolean;
  keepWorkDirectory?: boolean;
};

function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function parseStateGrowthTiers(value: string | undefined): number[] {
  if (!value?.trim()) return [...FULL_STATE_GROWTH_TIERS];
  const tiers = value.split(",").map((item) => positiveInteger(item.trim(), "state-growth tier"));
  if (!tiers.length || tiers.length > 8) throw new Error("state-growth tiers must contain between one and eight values");
  if (new Set(tiers).size !== tiers.length || tiers.some((tier, index) => index > 0 && tier <= tiers[index - 1]!)) {
    throw new Error("state-growth tiers must be unique and strictly ascending");
  }
  if (tiers.at(-1)! > 1_000_000) throw new Error("state-growth tiers cannot exceed the supported 1,000,000-record fixture");
  return tiers;
}

function at(index: number): string {
  return new Date(index * 1_000).toISOString();
}

export function stateGrowthRecord(index: number): RecordInput {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 1_000_000) throw new Error("state-growth record index is outside the supported fixture");
  if (index < PROJECT_COUNT) {
    return { id: `project-${index}`, type: "project.created", at: at(index), status: "active", name: `Project ${index}` };
  }
  if (index < PROJECT_COUNT + SESSION_COUNT) {
    const session = index - PROJECT_COUNT;
    const project = session % PROJECT_COUNT;
    return { id: `session-${session}`, type: "session.created", at: at(index), status: "open", projectId: `project-${project}`, title: `Session ${session}` };
  }
  if (index < PROJECT_COUNT + SESSION_COUNT + GOAL_COUNT) {
    const goal = index - PROJECT_COUNT - SESSION_COUNT;
    const session = goal % SESSION_COUNT;
    return { id: `goal-${goal}`, type: "goal.created", at: at(index), status: "active", sessionId: `session-${session}`, projectId: `project-${session % PROJECT_COUNT}`, title: `Goal ${goal}` };
  }
  if (index < SEEDED_RECORDS) {
    const improvement = index - PROJECT_COUNT - SESSION_COUNT - GOAL_COUNT;
    return { id: `improvement-${improvement}`, type: "improvement.proposed", at: at(index), status: "proposed", observationKey: `observation-${improvement}`, title: `Improvement ${improvement}`, rationale: "deterministic state-growth fixture", target: "runtime", priority: "normal" };
  }

  const mixed = index - SEEDED_RECORDS;
  const selector = mixed % 100;
  const session = mixed % SESSION_COUNT;
  const project = session % PROJECT_COUNT;
  const goal = mixed % GOAL_COUNT;
  const improvement = mixed % IMPROVEMENT_COUNT;
  if (selector < 40) {
    return {
      id: `message-${index}`,
      type: "message.appended",
      at: at(index),
      sessionId: `session-${session}`,
      projectId: `project-${project}`,
      externalId: `external-${index}`,
      role: selector % 2 ? "assistant" : "user",
      content: `deterministic state-growth message ${index}`,
    };
  }
  if (selector < 70) {
    return {
      id: `memory-${index}`,
      type: "memory",
      at: at(index),
      status: "active",
      scopeType: "project",
      scopeId: `project-${project}`,
      projectId: `project-${project}`,
      namespace: `projects/${project}/operations`,
      kind: "project",
      subject: `subject-${mixed % 1_000}`,
      tier: selector % 3 === 0 ? "l0" : "l1",
      text: `deterministic retained memory ${index}`,
    };
  }
  if (selector < 75) return { id: `goal-update-${index}`, type: "goal.updated", at: at(index), goalId: `goal-${goal}`, status: selector % 2 ? "active" : "completed", note: `state-growth update ${index}` };
  if (selector < 80) return { id: `session-update-${index}`, type: "session.updated", at: at(index), sessionId: `session-${session}`, title: `Session ${session} revision ${index}` };
  if (selector < 85) return { id: `project-update-${index}`, type: "project.updated", at: at(index), projectId: `project-${project}`, name: `Project ${project} revision ${index}` };
  if (selector < 90) return { id: `improvement-decision-${index}`, type: "improvement.reviewed", at: at(index), improvementId: `improvement-${improvement}`, decision: selector % 2 ? "accepted" : "rejected", note: `state-growth decision ${index}` };
  return { id: `task-${index}`, type: selector % 2 ? "task.started" : "task.completed", at: at(index), runId: `run-${mixed % 10_000}`, status: selector % 2 ? "running" : "completed" };
}

function databaseBytes(path: string): number {
  return [path, `${path}-wal`, `${path}-shm`].reduce((total, candidate) => total + (existsSync(candidate) ? statSync(candidate).size : 0), 0);
}

function maxRssBytes(): number {
  return Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024);
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function latestIndex(tier: number, type: string): number {
  for (let index = tier - 1; index >= 0; index -= 1) if (stateGrowthRecord(index).type === type) return index;
  throw new Error(`fixture tier ${tier} does not contain ${type}`);
}

async function measureQueries(store: SqliteRecordStore, tier: number): Promise<QueryMeasurement[]> {
  const message = stateGrowthRecord(latestIndex(tier, "message.appended"));
  const memory = stateGrowthRecord(latestIndex(tier, "memory"));
  const last = stateGrowthRecord(tier - 1);
  const sessionId = String(message.sessionId);
  const externalId = String(message.externalId);
  const projectId = String(memory.projectId);
  const cases: Array<{ name: string; run: () => unknown | Promise<unknown>; verify: (value: unknown) => boolean }> = [
    { name: "record-by-id", run: () => store.findByIdSync(String(last.id)), verify: (value) => (value as Record<string, unknown> | undefined)?.id === last.id },
    { name: "message-by-external-id", run: () => store.findMessageByExternalIdSync(sessionId, externalId), verify: (value) => (value as Record<string, unknown> | undefined)?.id === message.id },
    { name: "project-message-page", run: () => store.queryRecordsPageSync({ projectId, types: ["message.appended"], order: "desc", limit: 50 }), verify: (value) => (value as { records: unknown[] }).records.length > 0 },
    { name: "active-memory-page", run: () => store.queryRecordsPageSync({ scopeType: "project", scopeId: projectId, namespacePrefix: `projects/${projectId.slice("project-".length)}`, activeMemoryOnly: true, limit: 50 }), verify: (value) => (value as { records: unknown[] }).records.length > 0 },
    { name: "current-session", run: () => store.getCurrentSession(sessionId), verify: (value) => (value as Record<string, unknown> | undefined)?.id === sessionId },
    { name: "current-goals-page", run: () => store.queryCurrentGoalsPage({ projectId, limit: 50 }), verify: (value) => (value as { records: unknown[] }).records.length > 0 },
    { name: "project-entity-counts", run: () => store.projectEntityCounts(projectId), verify: (value) => Number((value as { sessionCount: number }).sessionCount) > 0 },
  ];

  const results: QueryMeasurement[] = [];
  for (const query of cases) {
    assert.ok(query.verify(await query.run()), `${query.name} warmup returned invalid state`);
    const samples: number[] = [];
    for (let sample = 0; sample < QUERY_SAMPLES; sample += 1) {
      const started = performance.now();
      const value = await query.run();
      samples.push(performance.now() - started);
      assert.ok(query.verify(value), `${query.name} returned invalid state`);
    }
    results.push({ name: query.name, p50Ms: round(percentile(samples, 0.5)), p95Ms: round(percentile(samples, 0.95)), maxMs: round(Math.max(...samples)) });
  }
  return results;
}

function sourceRevision(): string {
  const candidate = process.env.GITHUB_SHA;
  if (candidate && /^[a-f0-9]{40}$/u.test(candidate)) return candidate;
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

function isFullProfile(tiers: number[]): boolean {
  return tiers.length === FULL_STATE_GROWTH_TIERS.length && tiers.every((tier, index) => tier === FULL_STATE_GROWTH_TIERS[index]);
}

function recordBudgetViolations(result: StateGrowthTier, budgets: StateGrowthBudgets, violations: string[]): void {
  if (result.databaseBytes > budgets.maxDatabaseBytes) violations.push(`${result.records}: database bytes ${result.databaseBytes} exceed ${budgets.maxDatabaseBytes}`);
  if (result.databaseBytesPerRecord > budgets.maxDatabaseBytesPerRecord) violations.push(`${result.records}: database bytes per record ${result.databaseBytesPerRecord} exceed ${budgets.maxDatabaseBytesPerRecord}`);
  if (result.rssBytes > budgets.maxRssBytes) violations.push(`${result.records}: RSS bytes ${result.rssBytes} exceed ${budgets.maxRssBytes}`);
  if (result.appendRecordsPerSecond < budgets.minAppendRecordsPerSecond) violations.push(`${result.records}: append rate ${result.appendRecordsPerSecond} is below ${budgets.minAppendRecordsPerSecond}`);
  if (result.reopenMs > budgets.maxReopenMs) violations.push(`${result.records}: reopen ${result.reopenMs} ms exceeds ${budgets.maxReopenMs} ms`);
  if (result.integrityCheckMs > budgets.maxIntegrityCheckMs) violations.push(`${result.records}: integrity check ${result.integrityCheckMs} ms exceeds ${budgets.maxIntegrityCheckMs} ms`);
  const slowestP95 = Math.max(...result.queries.map((query) => query.p95Ms));
  if (slowestP95 > budgets.maxQueryP95Ms) violations.push(`${result.records}: query p95 ${slowestP95} ms exceeds ${budgets.maxQueryP95Ms} ms`);
}

async function runRetentionAcceptance(workDirectory: string, events: number) {
  if (!Number.isSafeInteger(events) || events < 2) throw new Error("audit retention acceptance requires at least two events");
  const databasePath = join(workDirectory, "audit.sqlite");
  const keyringPath = join(workDirectory, "audit-keys.json");
  const archivePath = join(workDirectory, "audit-archive.jsonl");
  const store = new SqliteAuditStore(databasePath, { keyringPath });
  for (let index = 0; index < events; index += 1) {
    await store.append({
      at: at(index),
      runId: `state-growth-retention-${index % 100}`,
      type: index % 2 ? "task.started" : "task.completed",
      actor: "state-growth",
      tool: "state.growth",
      capability: "audit.append",
      decision: "allow",
      data: { fixtureIndex: index },
    });
  }
  store.rotateSegment();
  const retainedThrough = Math.floor(events / 2);
  const archive = await store.exportArchive(archivePath, retainedThrough);
  const deletedOnlineEvents = await store.applyRetention(retainedThrough);
  assert.equal(deletedOnlineEvents, retainedThrough);
  assert.equal((await store.verifyIntegrity({ allowUnsigned: false })).valid, true);
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.close();

  const restarted = new SqliteAuditStore(databasePath, { keyringPath });
  const restartIntegrity = await restarted.verifyIntegrity({ allowUnsigned: false });
  const state = restarted.db.prepare("SELECT head_sequence, retained_sequence FROM audit_state WHERE singleton=1").get() as Record<string, unknown>;
  const online = restarted.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as Record<string, unknown>;
  const onlineEventsAfterRetention = Number(online.count);
  assert.equal(Number(state.retained_sequence), retainedThrough);
  assert.equal(Number(state.head_sequence), events + 1);
  assert.equal(onlineEventsAfterRetention, events + 1 - retainedThrough);
  assert.equal(restartIntegrity.valid, true);
  restarted.close();
  return {
    events,
    retainedThrough,
    deletedOnlineEvents: Number(deletedOnlineEvents),
    onlineEventsAfterRetention,
    archiveBytes: statSync(archivePath).size + statSync(`${archivePath}.manifest.json`).size,
    databaseBytes: databaseBytes(databasePath),
    restartIntegrityValid: restartIntegrity.valid,
    archiveEvents: archive.events,
  };
}

export async function runStateGrowthAcceptance(options: StateGrowthOptions = {}): Promise<StateGrowthReport> {
  const tiers = options.tiers ? parseStateGrowthTiers(options.tiers.join(",")) : [...FULL_STATE_GROWTH_TIERS];
  if (tiers[0]! <= SEEDED_RECORDS) throw new Error(`the first state-growth tier must exceed the ${SEEDED_RECORDS}-record mixed-state seed`);
  const batchSize = positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "state-growth batch size");
  const auditEvents = positiveInteger(options.auditEvents ?? DEFAULT_AUDIT_EVENTS, "audit retention event count");
  const budgets = options.budgets ?? STATE_GROWTH_BUDGETS;
  const enforceBudgets = options.enforceBudgets ?? true;
  const profile = isFullProfile(tiers) ? "full" : "development";
  const workDirectory = await mkdtemp(join(tmpdir(), "odinn-state-growth-"));
  const databasePath = join(workDirectory, "records.sqlite");
  const results: StateGrowthTier[] = [];
  const violations: string[] = [];
  let store = new SqliteRecordStore(databasePath);
  let appended = 0;
  let observedRssBytes = maxRssBytes();

  try {
    for (const tier of tiers) {
      const appendStarted = performance.now();
      const startingRecords = appended;
      while (appended < tier) {
        const boundary = Math.min(tier, appended + batchSize);
        store.transaction(() => {
          while (appended < boundary) {
            store.appendSync(stateGrowthRecord(appended));
            appended += 1;
          }
        });
        observedRssBytes = Math.max(observedRssBytes, maxRssBytes());
      }
      const appendDurationMs = performance.now() - appendStarted;
      const appendedRecords = appended - startingRecords;
      store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      store.close();

      const measuredDatabaseBytes = databaseBytes(databasePath);
      const reopenStarted = performance.now();
      store = new SqliteRecordStore(databasePath);
      const reopenMs = performance.now() - reopenStarted;
      assert.equal(await store.countRecords(), tier, `reopened record count differs at tier ${tier}`);
      assert.equal(store.findByIdSync(String(stateGrowthRecord(tier - 1).id))?.id, stateGrowthRecord(tier - 1).id);
      const integrityStarted = performance.now();
      const pragma = tier === tiers.at(-1) ? "integrity_check" : "quick_check";
      const integrity = store.db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown>;
      assert.equal(String(integrity[pragma]), "ok", `${pragma} failed at tier ${tier}`);
      const integrityCheckMs = performance.now() - integrityStarted;
      const queries = await measureQueries(store, tier);
      observedRssBytes = Math.max(observedRssBytes, maxRssBytes());
      const result: StateGrowthTier = {
        records: tier,
        appendedRecords,
        appendDurationMs: round(appendDurationMs),
        appendRecordsPerSecond: round(appendedRecords / (appendDurationMs / 1_000)),
        reopenMs: round(reopenMs),
        integrityCheckMs: round(integrityCheckMs),
        databaseBytes: measuredDatabaseBytes,
        databaseBytesPerRecord: round(measuredDatabaseBytes / tier),
        rssBytes: observedRssBytes,
        queries,
      };
      results.push(result);
      if (enforceBudgets) recordBudgetViolations(result, budgets, violations);
    }
    store.close();
    const retention = await runRetentionAcceptance(workDirectory, auditEvents);
    if (enforceBudgets && retention.databaseBytes > budgets.maxAuditDatabaseBytes) {
      violations.push(`audit database bytes ${retention.databaseBytes} exceed ${budgets.maxAuditDatabaseBytes}`);
    }
    const report: StateGrowthReport = {
      schemaVersion: 1,
      ok: violations.length === 0,
      profile,
      generatedAt: new Date().toISOString(),
      sourceRevision: sourceRevision(),
      environment: { node: process.version, platform: process.platform, arch: process.arch, parallelism: availableParallelism(), totalMemoryBytes: totalmem() },
      configuration: {
        tiers,
        batchSize,
        budgets,
        retentionPolicy: { authoritativeRecords: "append-only", auditEvents: "verified-archive-before-online-retention", reportArtifactDays: 30 },
      },
      tiers: results,
      retention: {
        events: retention.events,
        retainedThrough: retention.retainedThrough,
        deletedOnlineEvents: retention.deletedOnlineEvents,
        onlineEventsAfterRetention: retention.onlineEventsAfterRetention,
        archiveBytes: retention.archiveBytes,
        databaseBytes: retention.databaseBytes,
        restartIntegrityValid: retention.restartIntegrityValid,
      },
      violations,
    };
    const reportPath = resolve(options.reportPath ?? join(root, "dist", "reports", "state-growth-report.json"));
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return report;
  } finally {
    try { store.close(); } catch {}
    if (!options.keepWorkDirectory) await rm(workDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const tiers = parseStateGrowthTiers(process.env.ODINN_STATE_GROWTH_TIERS);
  const report = await runStateGrowthAcceptance({
    tiers,
    batchSize: process.env.ODINN_STATE_GROWTH_BATCH_SIZE ? positiveInteger(process.env.ODINN_STATE_GROWTH_BATCH_SIZE, "ODINN_STATE_GROWTH_BATCH_SIZE") : undefined,
    reportPath: process.env.ODINN_STATE_GROWTH_REPORT,
    keepWorkDirectory: process.env.ODINN_STATE_GROWTH_KEEP === "1",
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok) throw new Error(`state-growth resource budget failed: ${report.violations.join("; ")}`);
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url : false;
if (invoked) await main();
