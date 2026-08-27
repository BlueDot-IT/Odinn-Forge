import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SLO_DEFINITIONS,
  SLO_IDS,
  buildSloCollectorReport,
  runSloMeasurement,
  validateSloCollectorReport,
  type SloId,
  type SloSample,
} from "../scripts/ci/slo-measurement.ts";

const REVISION = "a".repeat(40);
const TREE = "b".repeat(40);

function passingSamples(count = 2): Record<SloId, SloSample[]> {
  return Object.fromEntries(SLO_IDS.map((id) => [id, Array.from({ length: count }, () => ({
    durationMs: 1,
    success: true,
    ...(id === "durable-run-acceptance" ? { accepted: true } : {}),
    ...(id === "startup-recovery" ? { quarantined: true } : {}),
    ...(id === "graceful-shutdown" ? { admissionBlocked: true } : {}),
    ...(id === "graceful-shutdown" ? { barrierToCloseMs: 1 } : {}),
  }))])) as Record<SloId, SloSample[]>;
}

function developmentReport(count = 2) {
  const samplePlan = Object.fromEntries(SLO_IDS.map((id) => [id, count])) as Record<SloId, number>;
  return buildSloCollectorReport({
    profile: "development",
    source: { repository: "BlueDot-IT/Odinn-Forge", revision: REVISION, tree: TREE, clean: true },
    samplePlan,
    memoryDocuments: 100,
    samples: passingSamples(count),
    generatedAt: "2026-08-27T12:00:00.000Z",
  });
}

test("SLO contract names all six exact objectives and budgets", () => {
  assert.deepEqual(SLO_IDS, [
    "durable-run-acceptance",
    "governed-tool-latency",
    "signed-audit-append",
    "memory-recall",
    "startup-recovery",
    "graceful-shutdown",
  ]);
  assert.deepEqual(Object.values(SLO_DEFINITIONS).map((definition) => definition.telemetry), [
    "odinn.run.acceptance",
    "odinn.tool.execution",
    "odinn.audit.append",
    "odinn.memory.recall",
    "odinn.recovery",
    "odinn.shutdown",
  ]);
  assert.equal(SLO_DEFINITIONS["durable-run-acceptance"].maxDurationMs, 250);
  assert.equal(SLO_DEFINITIONS["durable-run-acceptance"].minimumSuccessRate, 0.999);
  assert.equal(SLO_DEFINITIONS["signed-audit-append"].maxDurationMs, 50);
  assert.equal(SLO_DEFINITIONS["startup-recovery"].maxDurationMs, 30_000);
  assert.equal(SLO_DEFINITIONS["graceful-shutdown"].maxDurationMs, 5_000);
});

test("validator recomputes aggregates and fails closed on tamper, drops, misses, and identity drift", () => {
  const report = developmentReport();
  assert.equal(validateSloCollectorReport(report, { expectedRevision: REVISION }).ok, true);

  const tamperedAggregate = structuredClone(report);
  tamperedAggregate.objectives[0]!.p95Ms = 0;
  assert.throws(() => validateSloCollectorReport(tamperedAggregate), /aggregates do not match/u);

  const wrongRevision = structuredClone(report);
  wrongRevision.source.revision = "c".repeat(40);
  assert.throws(() => validateSloCollectorReport(wrongRevision, { expectedRevision: REVISION }), /does not match expected/u);

  const wrongTree = structuredClone(report);
  wrongTree.source.tree = "c".repeat(40);
  assert.throws(() => validateSloCollectorReport(wrongTree, { expectedTree: TREE }), /does not match expected/u);

  const irrelevantMarker = structuredClone(report);
  irrelevantMarker.samples["memory-recall"][0]!.accepted = true;
  assert.throws(() => validateSloCollectorReport(irrelevantMarker), /unknown fields/u);

  const dropped = buildSloCollectorReport({
    profile: "development",
    source: report.source,
    samplePlan: report.configuration.samplePlan,
    memoryDocuments: 100,
    samples: passingSamples(),
    dropped: 1,
  });
  assert.equal(validateSloCollectorReport(dropped).ok, false);
  assert.match(dropped.violations.join("\n"), /collector sample\(s\) were dropped/u);

  const slowSamples = passingSamples();
  slowSamples["memory-recall"][1]!.durationMs = 501;
  const slow = buildSloCollectorReport({
    profile: "development",
    source: report.source,
    samplePlan: report.configuration.samplePlan,
    memoryDocuments: 100,
    samples: slowSamples,
  });
  assert.equal(validateSloCollectorReport(slow).ok, false);
  assert.match(slow.violations.join("\n"), /memory-recall: p95 501 ms exceeds 500 ms/u);

  const incomplete = structuredClone(report) as any;
  delete incomplete.samples["graceful-shutdown"];
  assert.throws(() => validateSloCollectorReport(incomplete), /missing fields/u);
});

test("development profile measures real local operations and writes a bound collector report", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-slo-test-"));
  const reportPath = join(root, "slo-collector-report.json");
  try {
    const report = await runSloMeasurement({
      profile: "development",
      samplePlan: Object.fromEntries(SLO_IDS.map((id) => [id, 2])) as Record<SloId, number>,
      memoryDocuments: 50,
      reportPath,
    });
    assert.equal(report.ok, true, report.violations.join("\n"));
    assert.equal(report.collector.exported, 12);
    assert.equal(report.collector.dropped, 0);
    assert.equal(report.source.revision, execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    assert.equal(report.source.tree, execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim());
    assert.deepEqual(report.objectives.map((objective) => objective.id), SLO_IDS);
    assert.equal(report.objectives.find((objective) => objective.id === "startup-recovery")?.semanticSuccesses, 2);
    assert.equal(report.objectives.find((objective) => objective.id === "graceful-shutdown")?.semanticSuccesses, 2);
    const persisted = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(validateSloCollectorReport(persisted), report);
    assert.doesNotMatch(JSON.stringify(report), /odinn-slo-acceptance-|\.odinn|selector|must-not-run/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runSloMeasurement rejects caller-supplied identity that is not the live Git identity", async () => {
  await assert.rejects(() => runSloMeasurement({
    profile: "development",
    samplePlan: Object.fromEntries(SLO_IDS.map((id) => [id, 1])) as Record<SloId, number>,
    memoryDocuments: 1,
    source: { repository: "BlueDot-IT/Odinn-Forge", revision: REVISION, tree: TREE, clean: true },
  }), /current Git HEAD\/tree/u);
});

test("nightly retains exact-commit SLO evidence without write authority or secrets", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts["slo:measure"], "node scripts/ci/slo-measurement.ts run");
  assert.equal(packageJson.scripts["slo:validate"], "node scripts/ci/slo-measurement.ts validate");
  const workflow = await readFile(new URL("../.github/workflows/nightly.yml", import.meta.url), "utf8");
  const documentation = await readFile(new URL("../docs/slo-acceptance.md", import.meta.url), "utf8");
  assert.match(workflow, /name: Exact-commit SLO measurement/u);
  assert.match(workflow, /ODINN_SLO_EXPECTED_SHA: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /pnpm slo:measure/u);
  assert.match(workflow, /pnpm slo:validate/u);
  assert.match(workflow, /dist\/reports\/slo-collector-report\.json/u);
  assert.match(workflow, /if: always\(\)/u);
  assert.match(workflow, /retention-days: 30/u);
  const job = workflow.slice(workflow.indexOf("  slo-acceptance:"));
  assert.doesNotMatch(job, /secrets\.|contents: write|pull-requests: write/u);
  for (const definition of Object.values(SLO_DEFINITIONS)) assert.match(documentation, new RegExp(definition.telemetry.replaceAll(".", "\\."), "u"));
  assert.match(documentation, /sample count, p50, p95, p99, failures, and dropped samples/u);
});
