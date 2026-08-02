import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAuditStore,
  createBuiltInRegistry,
  createDifferentiatedRuntime,
  ExecutionAdmissionService,
  runTask,
  toolSafetyDescriptor
} from "../../packages/kernel/src/index.ts";
import { createDefaultPolicy } from "../../packages/policy/src/index.ts";

type BenchmarkResult = {
  name: string;
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
};

const sampleCount = positiveIntegerEnvironment("ODINN_ASSURANCE_BENCHMARK_SAMPLES", 80);
const warmupCount = positiveIntegerEnvironment("ODINN_ASSURANCE_BENCHMARK_WARMUPS", 10);

function positiveIntegerEnvironment(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new Error(`${name} must be an integer from 1 through 10000`);
  }
  return parsed;
}

function percentile(samples: number[], value: number) {
  return samples[Math.min(samples.length - 1, Math.ceil(samples.length * value) - 1)] ?? 0;
}

async function measure(name: string, operation: (index: number) => unknown): Promise<BenchmarkResult> {
  for (let index = 0; index < warmupCount; index += 1) await operation(index);
  const samples: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const started = performance.now();
    await operation(index + warmupCount);
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return {
    name,
    samples: samples.length,
    p50Ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    maxMs: Number((samples.at(-1) ?? 0).toFixed(3))
  };
}

function invariantPolicy(count: number) {
  return createDefaultPolicy({
    id: `benchmark-policy-${count}`,
    invariants: Array.from({ length: count }, (_, index) => ({
      id: `approval-${index + 1}`,
      type: "tool.requires-approval" as const,
      values: [`benchmark.unused-${index + 1}`],
      enforcement: "block" as const
    }))
  });
}

async function benchmarkToolDispatch(invariantCount: number) {
  const root = await mkdtemp(join(tmpdir(), `odinn-assurance-dispatch-${invariantCount}-`));
  const stateDir = join(root, ".odinn");
  const runtime = createDifferentiatedRuntime({ stateDir, workspaceRoot: root });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const registry = createBuiltInRegistry({ stateDir, workspaceRoot: root });
  const policy = invariantPolicy(invariantCount);
  try {
    return await measure(`tool_dispatch.invariants_${invariantCount}`, async (index) => {
      await runTask({
        task: {
          id: `benchmark-dispatch-${invariantCount}-${index}`,
          tool: "text.echo",
          input: { text: "benchmark" },
          actor: "benchmark"
        },
        auditStore,
        registry,
        policy,
        runLedger: runtime.ledger
      });
    });
  } finally {
    runtime.ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function benchmarkExecutionAdmission() {
  const root = await mkdtemp(join(tmpdir(), "odinn-assurance-admission-"));
  const stateDir = join(root, ".odinn");
  const runtime = createDifferentiatedRuntime({ stateDir, workspaceRoot: root });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const registry = createBuiltInRegistry({ stateDir, workspaceRoot: root, auditStore });
  const policy = invariantPolicy(0);
  const service = new ExecutionAdmissionService({ auditStore, registry, policy, runLedger: runtime.ledger });
  const tool = registry.get("text.echo");
  const safety = toolSafetyDescriptor("text.echo", tool);
  const contexts = Array.from({ length: sampleCount + warmupCount }, (_, index) => {
    const request = { id: `benchmark-admission-${index}`, tool: "text.echo", input: { text: "benchmark" }, actor: "benchmark" };
    runtime.ledger.ensureRun({ runId: request.id, objective: "benchmark admission" });
    const ledgerStep = runtime.ledger.beginTool({ runId: request.id, toolName: request.tool, input: request.input, safety, metadata: { actor: request.actor } });
    const policyEvent = runtime.ledger.recordPolicy({ runId: request.id, stepId: ledgerStep.stepId, decision: "allow", reason: "benchmark policy allowed task" });
    return { request, tool, safety, ledgerStep, policyEvent };
  });
  try {
    return await measure("execution_admission.with_signed_audit", (index) => service.admit(contexts[index]));
  } finally {
    registry.close();
    auditStore.close();
    runtime.ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function benchmarkExecutionEnvelopePersistence() {
  const root = await mkdtemp(join(tmpdir(), "odinn-assurance-envelope-"));
  const runtime = createDifferentiatedRuntime({ stateDir: join(root, ".odinn"), workspaceRoot: root });
  const envelopes = Array.from({ length: sampleCount + warmupCount }, (_, index) => {
    const runId = `benchmark-envelope-${index}`;
    runtime.ledger.ensureRun({ runId, objective: "benchmark envelope persistence" });
    return {
      version: 1,
      runId,
      principalId: "principal:benchmark",
      execution: { kind: "tool", id: "text.echo" },
      inputDigest: "a".repeat(64),
      inputReference: `artifact:sha256:${"b".repeat(64)}`,
      capabilityDecisionReferences: [`policy:benchmark-${index}`],
      approvalRequirements: [],
      timeoutMs: 120_000,
      resourceLimits: { maxInputBytes: 16_384, maxOutputBytes: 1_000_000, maxPersistedStateBytes: 1_000_000, maxConcurrency: 1 },
      idempotencyKey: `request:benchmark-${index}`,
      retrySafety: "retry-safe",
      workspaceRoot: root,
      sandboxProfile: "inspect-only",
      auditCorrelationId: `audit:benchmark-${index}`,
      cancellationControlReference: `cancel:benchmark-${index}`
    };
  });
  try {
    return await measure("execution_envelope.persist", (index) => runtime.ledger.admitExecution(envelopes[index]));
  } finally {
    runtime.ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}

function seedRoutingObservations(runtime: any, taskClass: string, count: number) {
  const runId = `benchmark-observations-${count}`;
  runtime.ledger.ensureRun({ runId, objective: `seed ${count} routing observations` });
  runtime.ledger.database.transaction((db: any) => {
    const insert = db.prepare(
      "INSERT INTO model_observations(id, run_id, provider_id, model_id, task_class, verified, partially_verified, cost_usd, duration_ms, tool_calls, tool_errors, retries, policy_violations, rolled_back, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (let index = 0; index < count; index += 1) {
      const model = index % 10;
      insert.run(
        `benchmark-observation-${count}-${index}`,
        runId,
        "benchmark",
        `model-${model}`,
        taskClass,
        index % 4 === 0 ? 0 : 1,
        index % 4 === 0 ? 1 : 0,
        (model + 1) / 1000,
        100 + model * 10,
        1,
        index % 20 === 0 ? 1 : 0,
        index % 25 === 0 ? 1 : 0,
        0,
        0,
        new Date(1_700_000_000_000 + index).toISOString()
      );
    }
  });
}

async function benchmarkRouting() {
  const root = await mkdtemp(join(tmpdir(), "odinn-assurance-routing-"));
  const runtime = createDifferentiatedRuntime({ stateDir: join(root, ".odinn"), workspaceRoot: root });
  const configuredModels = Array.from({ length: 10 }, (_, index) => `benchmark:model-${index}`);
  const results: BenchmarkResult[] = [];
  try {
    const totalRuns = sampleCount + warmupCount;
    for (let index = 0; index < totalRuns; index += 1) {
      runtime.ledger.ensureRun({ runId: `benchmark-pinned-${index}`, objective: "benchmark pinned routing" });
    }
    results.push(await measure("raven_route.pinned", (index) => {
      runtime.darwin.choose("general", {
        pinnedModel: "benchmark:model-0",
        availableModels: configuredModels,
        runId: `benchmark-pinned-${index}`
      });
    }));

    for (const observationCount of [100, 1_000, 10_000]) {
      const taskClass = `benchmark-${observationCount}`;
      seedRoutingObservations(runtime, taskClass, observationCount);
      for (let index = 0; index < totalRuns; index += 1) {
        runtime.ledger.ensureRun({
          runId: `benchmark-route-${observationCount}-${index}`,
          objective: `benchmark routing with ${observationCount} observations`
        });
      }
      results.push(await measure(`raven_route.observations_${observationCount}`, (index) => {
        runtime.darwin.choose(taskClass, {
          availableModels: configuredModels,
          runId: `benchmark-route-${observationCount}-${index}`
        });
      }));
    }
    return results;
  } finally {
    runtime.ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}

const dispatchWithoutInvariants = await benchmarkToolDispatch(0);
const dispatchWithOneInvariant = await benchmarkToolDispatch(1);
const dispatchWithThreeInvariants = await benchmarkToolDispatch(3);
const dispatchWithTenInvariants = await benchmarkToolDispatch(10);
const executionEnvelopePersistence = await benchmarkExecutionEnvelopePersistence();
const executionAdmission = await benchmarkExecutionAdmission();
const routing = await benchmarkRouting();
const report = {
  schemaVersion: 1,
  environment: {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    samples: sampleCount,
    warmups: warmupCount
  },
  scenarios: [
    dispatchWithoutInvariants,
    dispatchWithOneInvariant,
    dispatchWithThreeInvariants,
    dispatchWithTenInvariants,
    executionEnvelopePersistence,
    executionAdmission,
    ...routing
  ],
  comparisons: {
    gatewatchThreeInvariantP95AddedMs: Number(
      (dispatchWithThreeInvariants.p95Ms - dispatchWithoutInvariants.p95Ms).toFixed(3)
    ),
    executionEnvelopePersistenceP95Ms: executionEnvelopePersistence.p95Ms,
    executionAdmissionWithSignedAuditP95Ms: executionAdmission.p95Ms
  },
  gates: {
    executionEnvelopePersistenceP95MaxMs: 10,
    executionEnvelopePersistencePassed: executionEnvelopePersistence.p95Ms <= 10
  },
  enforcement: "execution envelope persistence gate is enforced; signed cross-store audit and other assurance comparisons remain observational"
};

console.log(JSON.stringify(report, null, 2));
if (!report.gates.executionEnvelopePersistencePassed) process.exitCode = 1;
