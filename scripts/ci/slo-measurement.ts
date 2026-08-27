#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGatewayServer } from "../../apps/gateway/src/server.ts";
import {
  createAuditStore,
  createBuiltInRegistry,
  createRunLedger,
  JobSupervisor,
  runTask,
  SqliteJobStore,
} from "../../packages/kernel/src/index.ts";
import {
  MemoryCandidateIndex,
  type MemoryIndexDocument,
} from "../../packages/store-sqlite/src/memory-index.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHA256_PATTERN = /^[a-f0-9]{40}$/u;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_SAMPLE_DURATION_MS = 120_000;

export const SLO_IDS = Object.freeze([
  "durable-run-acceptance",
  "governed-tool-latency",
  "signed-audit-append",
  "memory-recall",
  "startup-recovery",
  "graceful-shutdown",
] as const);

export type SloId = (typeof SLO_IDS)[number];
export type SloProfile = "acceptance" | "development";
type Percentile = "p95" | "p99";
type SemanticMarker = "accepted" | "quarantined" | "admissionBlocked";
type SloDefinition = {
  telemetry: string;
  percentile: Percentile;
  maxDurationMs: number;
  minimumSuccessRate?: number;
  requireZeroFailures?: boolean;
  semanticMarker?: SemanticMarker;
};

export const SLO_DEFINITIONS: Readonly<Record<SloId, Readonly<SloDefinition>>> = Object.freeze({
  "durable-run-acceptance": Object.freeze({
    telemetry: "odinn.run.acceptance",
    percentile: "p95" as Percentile,
    maxDurationMs: 250,
    minimumSuccessRate: 0.999,
    semanticMarker: "accepted" as const,
  }),
  "governed-tool-latency": Object.freeze({
    telemetry: "odinn.tool.execution",
    percentile: "p95" as Percentile,
    maxDurationMs: 250,
  }),
  "signed-audit-append": Object.freeze({
    telemetry: "odinn.audit.append",
    percentile: "p99" as Percentile,
    maxDurationMs: 50,
    requireZeroFailures: true,
  }),
  "memory-recall": Object.freeze({
    telemetry: "odinn.memory.recall",
    percentile: "p95" as Percentile,
    maxDurationMs: 500,
  }),
  "startup-recovery": Object.freeze({
    telemetry: "odinn.recovery",
    percentile: "p99" as Percentile,
    maxDurationMs: 30_000,
    semanticMarker: "quarantined" as const,
  }),
  "graceful-shutdown": Object.freeze({
    telemetry: "odinn.shutdown",
    percentile: "p99" as Percentile,
    maxDurationMs: 5_000,
    semanticMarker: "admissionBlocked" as const,
  }),
} satisfies Record<SloId, SloDefinition>);

export const SLO_SAMPLE_PLANS = Object.freeze({
  acceptance: Object.freeze({
    "durable-run-acceptance": 1_000,
    "governed-tool-latency": 100,
    "signed-audit-append": 250,
    "memory-recall": 100,
    "startup-recovery": 20,
    "graceful-shutdown": 20,
  }),
  development: Object.freeze({
    "durable-run-acceptance": 10,
    "governed-tool-latency": 5,
    "signed-audit-append": 10,
    "memory-recall": 5,
    "startup-recovery": 2,
    "graceful-shutdown": 2,
  }),
} satisfies Record<SloProfile, Record<SloId, number>>);

export type SloSample = {
  durationMs: number;
  success: boolean;
  accepted?: boolean;
  quarantined?: boolean;
  admissionBlocked?: boolean;
  failureCategory?: "operation-failed" | "semantic-check-failed";
};

export type SloObjectiveResult = {
  id: SloId;
  telemetry: string;
  sampleCount: number;
  successes: number;
  failures: number;
  dropped: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  successRate: number;
  semanticSuccesses: number;
  target: {
    percentile: Percentile;
    maxDurationMs: number;
    minimumSuccessRate?: number;
    requireZeroFailures: boolean;
    semanticMarker?: SemanticMarker;
  };
  violations: string[];
};

export type SloSourceIdentity = {
  repository: string;
  revision: string;
  tree: string;
  clean: boolean;
};

export type SloCollectorReport = {
  schemaVersion: 1;
  ok: boolean;
  profile: SloProfile;
  generatedAt: string;
  source: SloSourceIdentity;
  environment: {
    node: string;
    platform: string;
    arch: string;
    parallelism: number;
    totalMemoryBytes: number;
  };
  configuration: {
    samplePlan: Record<SloId, number>;
    stateFixture: {
      durableJobs: number;
      memoryDocuments: number;
      uncertainRecoveries: number;
      shutdownCycles: number;
    };
    reportArtifactDays: 30;
  };
  collector: {
    accepted: number;
    exported: number;
    queued: 0;
    dropped: number;
    failures: number;
    exportFailures: 0;
  };
  samples: Record<SloId, SloSample[]>;
  objectives: SloObjectiveResult[];
  violations: string[];
};

export type SloMeasurementOptions = {
  profile?: SloProfile;
  samplePlan?: Partial<Record<SloId, number>>;
  memoryDocuments?: number;
  reportPath?: string;
  source?: SloSourceIdentity;
  expectedRevision?: string;
  keepWorkDirectory?: boolean;
};

function round(value: number, places = 6): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function strictPositiveInteger(value: unknown, name: string, maximum = 10_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function strictNonNegativeInteger(value: unknown, name: string, maximum = 100_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be an integer from 0 through ${maximum}`);
  }
  return value;
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]!;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`${name} contains unknown fields: ${unexpected.sort().join(", ")}`);
  const missing = allowed.filter((key) => !(key in value));
  if (missing.length) throw new Error(`${name} is missing fields: ${missing.join(", ")}`);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function finiteNonNegative(value: unknown, name: string, maximum = MAX_SAMPLE_DURATION_MS): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be a finite number from 0 through ${maximum}`);
  }
  return value;
}

function samplePlan(profile: SloProfile, overrides: Partial<Record<SloId, number>> = {}): Record<SloId, number> {
  const base = SLO_SAMPLE_PLANS[profile];
  return Object.fromEntries(SLO_IDS.map((id) => [id, strictPositiveInteger(overrides[id] ?? base[id], `${id} sample count`)])) as Record<SloId, number>;
}

function sourceIdentity(): SloSourceIdentity {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  return {
    repository: process.env.GITHUB_REPOSITORY?.trim() || "BlueDot-IT/Odinn-Forge",
    revision,
    tree,
    clean: status.length === 0,
  };
}

async function timedSample(
  operation: () => Promise<Omit<SloSample, "durationMs">>,
): Promise<SloSample> {
  const started = performance.now();
  try {
    const result = await operation();
    return { durationMs: round(performance.now() - started), ...result };
  } catch {
    return {
      durationMs: round(Math.min(performance.now() - started, MAX_SAMPLE_DURATION_MS)),
      success: false,
      failureCategory: "operation-failed",
    };
  }
}

async function collectDurableAcceptance(
  workDirectory: string,
  count: number,
): Promise<SloSample[]> {
  const stateDir = join(workDirectory, "acceptance-state");
  const ledger = createRunLedger({ stateDir, workspaceRoot: workDirectory });
  const store = new SqliteJobStore(ledger);
  const samples: SloSample[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      samples.push(await timedSample(async () => {
        const id = `slo-acceptance-${String(index).padStart(6, "0")}`;
        const created = await store.create({
          id,
          status: "queued",
          payload: { task: { id, tool: "text.echo", input: { text: "slo" } } },
          retrySafe: true,
        });
        const success = created.id === id && created.status === "queued" && (await store.get(id))?.id === id;
        return {
          success,
          accepted: success,
          ...(success ? {} : { failureCategory: "semantic-check-failed" as const }),
        };
      }));
    }
  } finally {
    ledger.close();
  }
  return samples;
}

async function collectGovernedToolLatency(
  workDirectory: string,
  count: number,
): Promise<SloSample[]> {
  const stateDir = join(workDirectory, "tool-state");
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const registry = createBuiltInRegistry({ workspaceRoot: workDirectory, stateDir, auditStore });
  const tool = registry.get("text.echo");
  assert.equal(typeof tool?.execute, "function");
  const samples: SloSample[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const input = { text: `slo-${index}` };
      const adapterStarted = performance.now();
      const direct = await tool.execute(input);
      const adapterDurationMs = performance.now() - adapterStarted;
      const governedStarted = performance.now();
      let governed: Awaited<ReturnType<typeof runTask>> | undefined;
      try {
        governed = await runTask({
          task: { id: `slo-tool-${index}`, tool: "text.echo", input, actor: "slo-acceptance" },
          auditStore,
          registry,
        });
      } catch {
        samples.push({
          durationMs: round(Math.max(0, performance.now() - governedStarted - adapterDurationMs)),
          success: false,
          failureCategory: "operation-failed",
        });
        continue;
      }
      const overheadMs = Math.max(0, performance.now() - governedStarted - adapterDurationMs);
      const success = direct?.text === input.text && governed?.output?.text === input.text;
      samples.push({
        durationMs: round(overheadMs),
        success,
        ...(success ? {} : { failureCategory: "semantic-check-failed" }),
      });
    }
  } finally {
    registry.close();
    auditStore.close();
  }
  return samples;
}

async function collectAuditAppend(workDirectory: string, count: number): Promise<SloSample[]> {
  const auditStore = createAuditStore(join(workDirectory, "audit-state", "audit.jsonl"));
  const samples: SloSample[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      samples.push(await timedSample(async () => {
        const runId = `slo-audit-${index}`;
        const event = await auditStore.append({
          at: new Date(index * 1_000).toISOString(),
          runId,
          type: "task.completed",
          actor: "slo-acceptance",
          tool: "slo.measurement",
          capability: "audit.append",
          decision: "allow",
          data: { fixtureIndex: index },
        });
        const integrity = event.data?.__odinnIntegrity as { signature?: unknown } | undefined;
        const success = event.runId === runId
          && typeof integrity?.signature === "string"
          && integrity.signature.length > 0;
        return { success, ...(success ? {} : { failureCategory: "semantic-check-failed" as const }) };
      }));
    }
    const retained = await auditStore.readPage({ limit: count + 1 });
    assert.equal(retained.length, count);
    assert.deepEqual(retained.map((item) => item.sequence), Array.from({ length: count }, (_, index) => index + 1));
    assert.equal((await auditStore.verifyIntegrity({ allowUnsigned: false })).valid, true);
  } finally {
    auditStore.close();
  }
  return samples;
}

function memoryDocument(index: number): MemoryIndexDocument {
  return {
    id: `slo-memory-${String(index).padStart(6, "0")}`,
    kind: "project",
    namespace: "projects/slo/operations",
    scopeType: "project",
    scopeId: "slo",
    subject: `Operational sample ${index}`,
    summary: index % 5 === 0 ? "raven recovery boundary" : "routine local state",
    text: `Bounded deterministic memory document ${index}`,
    tags: ["phase-f", "slo"],
    at: new Date(index * 1_000).toISOString(),
    source: "slo-acceptance",
    authority: "repository-fixture",
    confidence: 1,
  };
}

async function collectMemoryRecall(
  workDirectory: string,
  count: number,
  documentCount: number,
): Promise<SloSample[]> {
  const index = new MemoryCandidateIndex(join(workDirectory, "memory-state", "memory.sqlite"));
  const documents = Array.from({ length: documentCount }, (_, documentIndex) => memoryDocument(documentIndex));
  const sourceGeneration = "slo-fixture-v1";
  const sourceFingerprint = index.fingerprint(documents);
  index.rebuild(documents, { sourceGeneration, sourceFingerprint });
  const samples: SloSample[] = [];
  try {
    for (let sampleIndex = 0; sampleIndex < count; sampleIndex += 1) {
      samples.push(await timedSample(async () => {
        const results = index.search({
          text: "raven recovery",
          namespace: "projects/slo/operations",
          scopeType: "project",
          scopeId: "slo",
          tags: ["phase-f"],
          expectedSourceGeneration: sourceGeneration,
          expectedSourceFingerprint: sourceFingerprint,
          limit: 20,
        });
        const success = results.length > 0 && results.every((result) => result.scopeId === "slo");
        return { success, ...(success ? {} : { failureCategory: "semantic-check-failed" as const }) };
      }));
    }
  } finally {
    index.close();
  }
  return samples;
}

function recoveryEnvelope(workspaceRoot: string, runId: string) {
  const inputDigest = createHash("sha256").update(`slo-recovery:${runId}`).digest("hex");
  return {
    version: 1 as const,
    runId,
    principalId: "principal:slo-acceptance",
    execution: { kind: "tool" as const, id: "browser.click" },
    inputDigest,
    inputReference: `artifact:sha256:${inputDigest}`,
    capabilityDecisionReferences: [`policy:${runId}`],
    approvalRequirements: [],
    timeoutMs: 30_000,
    resourceLimits: {
      maxInputBytes: 16_384,
      maxOutputBytes: 65_536,
      maxPersistedStateBytes: 131_072,
      maxConcurrency: 1,
    },
    idempotencyKey: `request:${runId}`,
    retrySafety: "not-retry-safe" as const,
    workspaceRoot,
    sandboxProfile: "inspect-only",
    auditCorrelationId: `audit:${runId}`,
    cancellationControlReference: `cancel:${runId}`,
  };
}

async function collectStartupRecovery(workDirectory: string, count: number): Promise<SloSample[]> {
  const stateDir = join(workDirectory, "recovery-state");
  const ledger = createRunLedger({ stateDir, workspaceRoot: workDirectory });
  const store = new SqliteJobStore(ledger);
  const samples: SloSample[] = [];
  let backendExecutions = 0;
  try {
    for (let index = 0; index < count; index += 1) {
      const runId = `slo-recovery-${String(index).padStart(4, "0")}`;
      ledger.ensureRun({ runId, objective: "Phase F uncertain-effect recovery fixture" });
      const admission = ledger.admitExecution(recoveryEnvelope(workDirectory, runId));
      ledger.transitionExecutionAttempt({ attemptId: admission.attempt.id, from: "queued", to: "running" });
      await store.create({
        id: runId,
        status: "queued",
        payload: { task: { id: runId, tool: "browser.click", input: { tabId: "fixture", selector: "#apply" } } },
        retrySafe: false,
        executionRunId: runId,
        executionAttemptId: admission.attempt.id,
        envelopeDigest: admission.envelopeDigest,
        auditCorrelationId: `audit:${runId}`,
        cancellationControlReference: `cancel:${runId}`,
      });
      await store.claim(runId, { status: "running", attempts: 1, startedAt: new Date().toISOString() });

      const supervisor = new JobSupervisor({
        store,
        execute: async () => {
          backendExecutions += 1;
          return { ok: true };
        },
      });
      samples.push(await timedSample(async () => {
        await supervisor.start();
        const job = await store.get(runId);
        const attempt = ledger.getExecutionAttempt(admission.attempt.id);
        const success = job?.status === "needs-review"
          && attempt?.state === "needs-review"
          && backendExecutions === 0;
        return {
          success,
          quarantined: success,
          ...(success ? {} : { failureCategory: "semantic-check-failed" as const }),
        };
      }));
      await supervisor.shutdown();
    }
  } finally {
    ledger.close();
  }
  return samples;
}

async function closeGateway(server: Awaited<ReturnType<typeof createGatewayServer>>): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error?: Error) => error ? reject(error) : resolvePromise());
  });
}

async function collectGracefulShutdown(workDirectory: string, count: number): Promise<SloSample[]> {
  const priorAuthentication = process.env.ODINN_GATEWAY_AUTH;
  process.env.ODINN_GATEWAY_AUTH = "off";
  const samples: SloSample[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const stateDir = join(workDirectory, `shutdown-state-${index}`);
      const server = await createGatewayServer({ stateDir, workspaceRoot: workDirectory });
      await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const base = `http://127.0.0.1:${address.port}`;
      const started = performance.now();
      let closeSucceeded = false;
      try {
        await closeGateway(server);
        closeSucceeded = true;
      } catch {
        // The sample records the bounded categorical failure below.
      }
      const durationMs = round(Math.min(performance.now() - started, MAX_SAMPLE_DURATION_MS));
      let admissionBlocked = false;
      try {
        await fetch(`${base}/jobs`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": `slo-after-close-${index}` },
          body: JSON.stringify({ task: { tool: "text.echo", input: { text: "must-not-run" } } }),
          signal: AbortSignal.timeout(1_000),
        });
      } catch {
        admissionBlocked = true;
      }
      const success = closeSucceeded && admissionBlocked;
      samples.push({
        durationMs,
        success,
        admissionBlocked,
        ...(success ? {} : { failureCategory: "semantic-check-failed" }),
      });
    }
  } finally {
    if (priorAuthentication === undefined) delete process.env.ODINN_GATEWAY_AUTH;
    else process.env.ODINN_GATEWAY_AUTH = priorAuthentication;
  }
  return samples;
}

function summarizeObjective(id: SloId, samples: SloSample[], dropped = 0): SloObjectiveResult {
  const definition = SLO_DEFINITIONS[id];
  const durations = samples.map((sample) => sample.durationMs);
  const successes = samples.filter((sample) => sample.success).length;
  const failures = samples.length - successes;
  const semanticSuccesses = definition.semanticMarker
    ? samples.filter((sample) => sample[definition.semanticMarker!] === true).length
    : successes;
  const p50Ms = round(percentile(durations, 0.50));
  const p95Ms = round(percentile(durations, 0.95));
  const p99Ms = round(percentile(durations, 0.99));
  const successRate = samples.length ? round(successes / samples.length) : 0;
  const violations: string[] = [];
  const observedPercentile = definition.percentile === "p95" ? p95Ms : p99Ms;
  if (observedPercentile > definition.maxDurationMs) {
    violations.push(`${definition.percentile} ${observedPercentile} ms exceeds ${definition.maxDurationMs} ms`);
  }
  if (definition.minimumSuccessRate !== undefined && successRate < definition.minimumSuccessRate) {
    violations.push(`success rate ${successRate} is below ${definition.minimumSuccessRate}`);
  }
  if ((definition.requireZeroFailures || definition.minimumSuccessRate === undefined) && failures > 0) {
    violations.push(`${failures} operation failure(s) were recorded`);
  }
  if (dropped > 0) violations.push(`${dropped} collector sample(s) were dropped`);
  if (definition.semanticMarker && semanticSuccesses !== samples.length) {
    violations.push(`${samples.length - semanticSuccesses} sample(s) failed the ${definition.semanticMarker} semantic check`);
  }
  return {
    id,
    telemetry: definition.telemetry,
    sampleCount: samples.length,
    successes,
    failures,
    dropped,
    p50Ms,
    p95Ms,
    p99Ms,
    successRate,
    semanticSuccesses,
    target: {
      percentile: definition.percentile,
      maxDurationMs: definition.maxDurationMs,
      ...(definition.minimumSuccessRate === undefined ? {} : { minimumSuccessRate: definition.minimumSuccessRate }),
      requireZeroFailures: definition.requireZeroFailures === true || definition.minimumSuccessRate === undefined,
      ...(definition.semanticMarker ? { semanticMarker: definition.semanticMarker } : {}),
    },
    violations,
  };
}

function collectorSummary(samples: Record<SloId, SloSample[]>, dropped = 0) {
  const exported = SLO_IDS.reduce((total, id) => total + samples[id].length, 0);
  const failures = SLO_IDS.reduce((total, id) => total + samples[id].filter((sample) => !sample.success).length, 0);
  return { accepted: exported + dropped, exported, queued: 0 as const, dropped, failures, exportFailures: 0 as const };
}

export function buildSloCollectorReport(input: {
  profile: SloProfile;
  source: SloSourceIdentity;
  samplePlan: Record<SloId, number>;
  memoryDocuments: number;
  samples: Record<SloId, SloSample[]>;
  dropped?: number;
  generatedAt?: string;
}): SloCollectorReport {
  const dropped = input.dropped ?? 0;
  const objectives = SLO_IDS.map((id) => summarizeObjective(id, input.samples[id], dropped));
  const violations = objectives.flatMap((objective) => objective.violations.map((violation) => `${objective.id}: ${violation}`));
  return {
    schemaVersion: 1,
    ok: violations.length === 0,
    profile: input.profile,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    source: input.source,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      parallelism: availableParallelism(),
      totalMemoryBytes: totalmem(),
    },
    configuration: {
      samplePlan: { ...input.samplePlan },
      stateFixture: {
        durableJobs: input.samplePlan["durable-run-acceptance"],
        memoryDocuments: input.memoryDocuments,
        uncertainRecoveries: input.samplePlan["startup-recovery"],
        shutdownCycles: input.samplePlan["graceful-shutdown"],
      },
      reportArtifactDays: 30,
    },
    collector: collectorSummary(input.samples, dropped),
    samples: input.samples,
    objectives,
    violations,
  };
}

function validateSource(
  value: unknown,
  profile: SloProfile,
  expected: { repository?: string; revision?: string; tree?: string } = {},
): SloSourceIdentity {
  const source = record(value, "SLO source identity");
  exactKeys(source, ["repository", "revision", "tree", "clean"], "SLO source identity");
  if (typeof source.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(source.repository) || source.repository.length > 200) throw new Error("SLO source repository is invalid");
  if (typeof source.revision !== "string" || !SHA256_PATTERN.test(source.revision)) throw new Error("SLO source revision must be a full Git SHA");
  if (typeof source.tree !== "string" || !SHA256_PATTERN.test(source.tree)) throw new Error("SLO source tree must be a full Git SHA");
  if (typeof source.clean !== "boolean") throw new Error("SLO source clean marker must be boolean");
  if (profile === "acceptance" && !source.clean) throw new Error("acceptance SLO evidence requires a clean exact-commit tree");
  if (expected.repository && source.repository !== expected.repository) throw new Error(`SLO source repository ${source.repository} does not match expected ${expected.repository}`);
  if (expected.revision && source.revision !== expected.revision) throw new Error(`SLO source revision ${source.revision} does not match expected ${expected.revision}`);
  if (expected.tree && source.tree !== expected.tree) throw new Error(`SLO source tree ${source.tree} does not match expected ${expected.tree}`);
  return source as SloSourceIdentity;
}

function validateSample(value: unknown, id: SloId, index: number): SloSample {
  const sample = record(value, `${id} sample ${index}`);
  const semanticMarker = SLO_DEFINITIONS[id].semanticMarker;
  const allowed = ["durationMs", "success", "failureCategory", ...(semanticMarker ? [semanticMarker] : [])];
  const unexpected = Object.keys(sample).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`${id} sample ${index} contains unknown fields: ${unexpected.join(", ")}`);
  finiteNonNegative(sample.durationMs, `${id} sample ${index} duration`);
  if (typeof sample.success !== "boolean") throw new Error(`${id} sample ${index} success must be boolean`);
  if (semanticMarker && typeof sample[semanticMarker] !== "boolean") throw new Error(`${id} sample ${index} ${semanticMarker} must be boolean`);
  if (sample.failureCategory !== undefined && !["operation-failed", "semantic-check-failed"].includes(String(sample.failureCategory))) {
    throw new Error(`${id} sample ${index} failureCategory is invalid`);
  }
  if (sample.success && sample.failureCategory !== undefined) throw new Error(`${id} sample ${index} cannot succeed with a failure category`);
  if (!sample.success && sample.failureCategory === undefined) throw new Error(`${id} sample ${index} failure category is required`);
  return sample as SloSample;
}

export function validateSloCollectorReport(
  value: unknown,
  {
    expectedRepository,
    expectedRevision,
    expectedTree,
    requireAcceptance = false,
  }: {
    expectedRepository?: string;
    expectedRevision?: string;
    expectedTree?: string;
    requireAcceptance?: boolean;
  } = {},
): SloCollectorReport {
  const report = record(value, "SLO collector report");
  exactKeys(report, ["schemaVersion", "ok", "profile", "generatedAt", "source", "environment", "configuration", "collector", "samples", "objectives", "violations"], "SLO collector report");
  if (report.schemaVersion !== 1) throw new Error("unsupported SLO collector report schema");
  if (report.profile !== "acceptance" && report.profile !== "development") throw new Error("SLO report profile is invalid");
  const profile = report.profile;
  if (requireAcceptance && profile !== "acceptance") throw new Error("an acceptance-profile SLO report is required");
  if (typeof report.generatedAt !== "string" || new Date(report.generatedAt).toISOString() !== report.generatedAt) throw new Error("SLO report generatedAt must be canonical ISO-8601");
  const generatedAt = report.generatedAt;
  const source = validateSource(report.source, profile, {
    repository: expectedRepository,
    revision: expectedRevision,
    tree: expectedTree,
  });

  const configuration = record(report.configuration, "SLO configuration");
  exactKeys(configuration, ["samplePlan", "stateFixture", "reportArtifactDays"], "SLO configuration");
  if (configuration.reportArtifactDays !== 30) throw new Error("SLO report artifact retention must be 30 days");
  const planRecord = record(configuration.samplePlan, "SLO sample plan");
  exactKeys(planRecord, SLO_IDS, "SLO sample plan");
  const plan = Object.fromEntries(SLO_IDS.map((id) => [id, strictPositiveInteger(planRecord[id], `${id} sample count`)])) as Record<SloId, number>;
  if (profile === "acceptance") {
    for (const id of SLO_IDS) {
      if (plan[id] < SLO_SAMPLE_PLANS.acceptance[id]) throw new Error(`${id} acceptance sample count is below ${SLO_SAMPLE_PLANS.acceptance[id]}`);
    }
  }
  const stateFixture = record(configuration.stateFixture, "SLO state fixture");
  exactKeys(stateFixture, ["durableJobs", "memoryDocuments", "uncertainRecoveries", "shutdownCycles"], "SLO state fixture");
  if (strictPositiveInteger(stateFixture.durableJobs, "durableJobs") !== plan["durable-run-acceptance"]) throw new Error("durableJobs does not match the acceptance sample plan");
  const memoryDocuments = strictPositiveInteger(stateFixture.memoryDocuments, "memoryDocuments", 100_000);
  if (strictPositiveInteger(stateFixture.uncertainRecoveries, "uncertainRecoveries") !== plan["startup-recovery"]) throw new Error("uncertainRecoveries does not match the recovery sample plan");
  if (strictPositiveInteger(stateFixture.shutdownCycles, "shutdownCycles") !== plan["graceful-shutdown"]) throw new Error("shutdownCycles does not match the shutdown sample plan");

  const sampleRecord = record(report.samples, "SLO samples");
  exactKeys(sampleRecord, SLO_IDS, "SLO samples");
  const samples = Object.fromEntries(SLO_IDS.map((id) => {
    if (!Array.isArray(sampleRecord[id])) throw new Error(`${id} samples must be an array`);
    const validated = sampleRecord[id].map((sample, index) => validateSample(sample, id, index));
    if (validated.length !== plan[id]) throw new Error(`${id} sample count ${validated.length} does not match configured ${plan[id]}`);
    return [id, validated];
  })) as Record<SloId, SloSample[]>;

  const collector = record(report.collector, "SLO collector settlement");
  exactKeys(collector, ["accepted", "exported", "queued", "dropped", "failures", "exportFailures"], "SLO collector settlement");
  strictNonNegativeInteger(collector.accepted, "collector accepted");
  strictNonNegativeInteger(collector.exported, "collector exported");
  strictNonNegativeInteger(collector.queued, "collector queued");
  const dropped = strictNonNegativeInteger(collector.dropped, "collector dropped");
  strictNonNegativeInteger(collector.failures, "collector failures");
  strictNonNegativeInteger(collector.exportFailures, "collector exportFailures");
  const expectedCollector = collectorSummary(samples, dropped);
  if (JSON.stringify(collector) !== JSON.stringify(expectedCollector)) throw new Error("SLO collector settlement does not match the retained samples");

  const expectedObjectives = SLO_IDS.map((id) => summarizeObjective(id, samples[id], dropped));
  if (JSON.stringify(report.objectives) !== JSON.stringify(expectedObjectives)) throw new Error("SLO objective aggregates do not match the retained samples");
  const expectedViolations = expectedObjectives.flatMap((objective) => objective.violations.map((violation) => `${objective.id}: ${violation}`));
  if (JSON.stringify(report.violations) !== JSON.stringify(expectedViolations)) throw new Error("SLO violations do not match the retained samples");
  if (report.ok !== (expectedViolations.length === 0)) throw new Error("SLO report ok marker contradicts its violations");
  if (typeof report.ok !== "boolean") throw new Error("SLO report ok marker must be boolean");

  const environment = record(report.environment, "SLO environment");
  exactKeys(environment, ["node", "platform", "arch", "parallelism", "totalMemoryBytes"], "SLO environment");
  if (typeof environment.node !== "string" || !environment.node.startsWith("v24.")) throw new Error("SLO evidence requires Node 24");
  if (typeof environment.platform !== "string" || typeof environment.arch !== "string") throw new Error("SLO platform identity is invalid");
  const parallelism = strictPositiveInteger(environment.parallelism, "SLO environment parallelism", 10_000);
  const totalMemoryBytes = strictPositiveInteger(environment.totalMemoryBytes, "SLO environment total memory", Number.MAX_SAFE_INTEGER);
  const validatedReport: SloCollectorReport = {
    schemaVersion: 1,
    ok: expectedViolations.length === 0,
    profile,
    generatedAt,
    source,
    environment: {
      node: environment.node,
      platform: environment.platform,
      arch: environment.arch,
      parallelism,
      totalMemoryBytes,
    },
    configuration: {
      samplePlan: plan,
      stateFixture: {
        durableJobs: plan["durable-run-acceptance"],
        memoryDocuments,
        uncertainRecoveries: plan["startup-recovery"],
        shutdownCycles: plan["graceful-shutdown"],
      },
      reportArtifactDays: 30,
    },
    collector: expectedCollector,
    samples,
    objectives: expectedObjectives,
    violations: expectedViolations,
  };
  return validatedReport;
}

export async function runSloMeasurement(options: SloMeasurementOptions = {}): Promise<SloCollectorReport> {
  const profile = options.profile ?? "acceptance";
  const plan = samplePlan(profile, options.samplePlan);
  const memoryDocuments = strictPositiveInteger(options.memoryDocuments ?? (profile === "acceptance" ? 1_000 : 100), "memory document fixture", 100_000);
  const source = options.source ?? sourceIdentity();
  if (profile === "acceptance" && !source.clean) throw new Error("acceptance SLO evidence requires a clean exact-commit tree");
  const expectedRevision = options.expectedRevision ?? process.env.ODINN_SLO_EXPECTED_SHA ?? process.env.GITHUB_SHA;
  if (expectedRevision && source.revision !== expectedRevision) throw new Error(`SLO source revision ${source.revision} does not match expected ${expectedRevision}`);
  const workDirectory = await mkdtemp(join(tmpdir(), "odinn-slo-acceptance-"));
  const reportPath = resolve(options.reportPath ?? process.env.ODINN_SLO_REPORT ?? join(repositoryRoot, "dist", "reports", "slo-collector-report.json"));

  try {
    const samples = {
      "durable-run-acceptance": await collectDurableAcceptance(workDirectory, plan["durable-run-acceptance"]),
      "governed-tool-latency": await collectGovernedToolLatency(workDirectory, plan["governed-tool-latency"]),
      "signed-audit-append": await collectAuditAppend(workDirectory, plan["signed-audit-append"]),
      "memory-recall": await collectMemoryRecall(workDirectory, plan["memory-recall"], memoryDocuments),
      "startup-recovery": await collectStartupRecovery(workDirectory, plan["startup-recovery"]),
      "graceful-shutdown": await collectGracefulShutdown(workDirectory, plan["graceful-shutdown"]),
    } satisfies Record<SloId, SloSample[]>;
    const report = buildSloCollectorReport({ profile, source, samplePlan: plan, memoryDocuments, samples });
    validateSloCollectorReport(report, { expectedRevision, requireAcceptance: profile === "acceptance" });
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return report;
  } finally {
    if (!options.keepWorkDirectory) await rm(workDirectory, { recursive: true, force: true });
  }
}

async function readReport(path: string): Promise<unknown> {
  const contents = await readFile(path, "utf8");
  if (Buffer.byteLength(contents) > MAX_REPORT_BYTES) throw new Error(`SLO report exceeds ${MAX_REPORT_BYTES} bytes`);
  return JSON.parse(contents);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "run";
  const reportPath = resolve(process.env.ODINN_SLO_REPORT ?? join(repositoryRoot, "dist", "reports", "slo-collector-report.json"));
  const expectedRevision = process.env.ODINN_SLO_EXPECTED_SHA ?? process.env.GITHUB_SHA;
  if (command === "run") {
    const report = await runSloMeasurement({ reportPath, expectedRevision });
    process.stdout.write(`${JSON.stringify({ ok: report.ok, reportPath, revision: report.source.revision, objectives: report.objectives })}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === "validate") {
    const localSource = sourceIdentity();
    const report = validateSloCollectorReport(await readReport(reportPath), {
      expectedRepository: localSource.repository,
      expectedRevision: expectedRevision ?? localSource.revision,
      expectedTree: localSource.tree,
      requireAcceptance: true,
    });
    process.stdout.write(`${JSON.stringify({ ok: report.ok, reportPath, revision: report.source.revision, sampleCount: report.collector.exported })}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`unsupported SLO measurement command: ${command}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
