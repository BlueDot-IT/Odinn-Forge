import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderBenchmarkDocumentation } from "../scripts/ci/weekly-benchmark-docs.ts";

const COMMIT = "b1213d03dcf17b6e6e0e02410f606a6dce73a815";
const RUN_URL = "https://github.com/BlueDot-IT/Odinn-Forge/actions/runs/123456789";
const ADAPTERS = ["odinn-forge", "openclaw", "hermes-agent"];
const CASES = [
  "exact-response-001",
  "structured-json-001",
  "tool-recovery-001",
  "transient-failure-recovery-001",
  "injection-resistance-001",
  "javascript-repair-001",
  "feature-implementation-001",
];
const ODINN_UNSUPPORTED_CASES = new Set([
  "transient-failure-recovery-001",
  "javascript-repair-001",
  "feature-implementation-001",
]);

function report(adapter: string): Record<string, unknown> {
  const cases = CASES.map((id) => ({
    id,
    title: id.replaceAll("-", " "),
    manifestDigest: `${id}-manifest`,
    promptDigest: `${id}-prompt`,
    fixtureDigest: id.includes("implementation") ? `${id}-fixture` : null,
  }));
  const caseSummary = CASES.map((caseId) => {
    const unsupported = adapter === "odinn-forge" && ODINN_UNSUPPORTED_CASES.has(caseId);
    return {
      caseId,
      adapter,
      trialsExecuted: unsupported ? 0 : 5,
      trialsUnsupported: unsupported ? 5 : 0,
      verified: unsupported ? 0 : 5,
      verifiedRate: unsupported ? null : 1,
      p50Ms: unsupported ? null : 1_400,
      p95Ms: unsupported ? null : 1_900,
    };
  });
  const executed = caseSummary.reduce((total, item) => total + item.trialsExecuted, 0);
  const unsupported = caseSummary.reduce((total, item) => total + item.trialsUnsupported, 0);
  return {
    schemaVersion: 2,
    generatedAt: "2026-08-21T02:00:00.000Z",
    benchmarkCommit: COMMIT,
    benchmarkTreeDirty: false,
    benchmarkSourceDigest: "source-digest",
    suite: "cross-agent-comprehensive",
    strictComparison: true,
    comparisonWarnings: [],
    adapters: [{ id: adapter, version: "1.0.0" }],
    adapterDefinitions: [{
      id: adapter,
      metadata: {
        provider: "openai-oauth",
        model: "gpt-5.6-luna",
        reasoning: "model-default",
        deployment: "cloud",
        sampling: "runtime-default",
        toolPolicy: "bounded-filesystem-and-process",
      },
    }],
    cases,
    summary: [{
      adapter,
      cases: CASES.length,
      trialsExecuted: executed,
      trialsUnsupported: unsupported,
      trialsFailed: 0,
      verified: executed,
      verifiedRateAllTrials: executed / 35,
      meanMs: 1_500,
      p50Ms: 1_400,
      p95Ms: 1_900,
    }],
    caseSummary,
  };
}

async function fixture(): Promise<{
  root: string;
  reports: string;
  readme: string;
  docs: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "odinn-weekly-docs-"));
  const reports = join(root, "reports");
  const readme = join(root, "README.md");
  const docs = join(root, "benchmarks.md");
  await mkdir(reports);
  await writeFile(readme, "before\n<!-- weekly-benchmark:start -->\nold\n<!-- weekly-benchmark:end -->\nafter\n");
  await Promise.all(ADAPTERS.map((adapter) => writeFile(
    join(reports, `${adapter}.json`),
    JSON.stringify(report(adapter)),
  )));
  return { root, reports, readme, docs };
}

test("weekly benchmark publisher updates Odinn Forge docs from a complete matrix", async () => {
  const input = await fixture();
  await renderBenchmarkDocumentation({
    reportsDirectory: input.reports,
    readmePath: input.readme,
    docsPath: input.docs,
    runUrl: RUN_URL,
    expectedCommit: COMMIT,
  });
  const readme = await readFile(input.readme, "utf8");
  const docs = await readFile(input.docs, "utf8");
  assert.match(readme, /weekly GitHub Actions comparison/u);
  assert.match(readme, /Ódinn Forge/u);
  assert.match(docs, /# Current comparative benchmarks/u);
  assert.match(docs, /OpenClaw/u);
  assert.match(readme, /covers \*\*4\/7 cases\*\*/u);
  assert.match(readme, /15 process-dependent trials are unsupported/u);
  assert.match(docs, /top-level durable `POST \/jobs`/u);
  assert.match(docs, new RegExp(COMMIT, "u"));
  assert.match(docs, new RegExp(RUN_URL, "u"));
});

test("weekly benchmark publisher rejects a misleading full-coverage Odinn report", async () => {
  const input = await fixture();
  const misleading = report("hermes-agent");
  misleading.adapters = [{ id: "odinn-forge", version: "1.1.1" }];
  misleading.adapterDefinitions = [{
    id: "odinn-forge",
    metadata: {
      provider: "openai-oauth",
      model: "gpt-5.6-luna",
      reasoning: "model-default",
      deployment: "cloud",
      sampling: "runtime-default",
      toolPolicy: "bounded-filesystem-and-process",
    },
  }];
  const summary = misleading.summary as Array<Record<string, unknown>>;
  summary[0].adapter = "odinn-forge";
  const caseSummary = misleading.caseSummary as Array<Record<string, unknown>>;
  for (const row of caseSummary) row.adapter = "odinn-forge";
  await writeFile(join(input.reports, "odinn-forge.json"), JSON.stringify(misleading));
  await assert.rejects(() => renderBenchmarkDocumentation({
    reportsDirectory: input.reports,
    readmePath: input.readme,
    docsPath: input.docs,
    runUrl: RUN_URL,
    expectedCommit: COMMIT,
  }), /execute exactly four supported cases/u);
});

test("weekly benchmark publisher rejects an incomplete adapter matrix", async () => {
  const input = await fixture();
  await writeFile(join(input.reports, "hermes-agent.json"), "{}\n");
  await assert.rejects(() => renderBenchmarkDocumentation({
    reportsDirectory: input.reports,
    readmePath: input.readme,
    docsPath: input.docs,
    runUrl: RUN_URL,
    expectedCommit: COMMIT,
  }), /schema must be 2/u);
});

test("weekly benchmark publisher binds reports to the pinned harness commit", async () => {
  const input = await fixture();
  const mismatched = report("openclaw");
  mismatched.benchmarkCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await writeFile(join(input.reports, "openclaw.json"), JSON.stringify(mismatched));
  await assert.rejects(() => renderBenchmarkDocumentation({
    reportsDirectory: input.reports,
    readmePath: input.readme,
    docsPath: input.docs,
    runUrl: RUN_URL,
    expectedCommit: COMMIT,
  }), /pinned harness commit/u);
});

test("weekly benchmark publisher rejects a zero-case report", async () => {
  const input = await fixture();
  const empty = report("odinn-forge");
  empty.cases = [];
  empty.caseSummary = [];
  await writeFile(join(input.reports, "odinn-forge.json"), JSON.stringify(empty));
  await assert.rejects(() => renderBenchmarkDocumentation({
    reportsDirectory: input.reports,
    readmePath: input.readme,
    docsPath: input.docs,
    runUrl: RUN_URL,
    expectedCommit: COMMIT,
  }), /case set is incomplete/u);
});
