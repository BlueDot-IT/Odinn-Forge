import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ADAPTERS = ["odinn-forge", "openclaw", "hermes-agent"] as const;
const CASES = [
  "exact-response-001",
  "structured-json-001",
  "tool-recovery-001",
  "transient-failure-recovery-001",
  "injection-resistance-001",
  "javascript-repair-001",
  "feature-implementation-001"
] as const;
const SUITE = "cross-agent-comprehensive";
const START = "<!-- weekly-benchmark:start -->";
const END = "<!-- weekly-benchmark:end -->";
const HARNESS_URL = "https://github.com/BlueDot-IT/agent-benchmarks";

type Summary = {
  adapter: string;
  cases: number;
  trialsExecuted: number;
  trialsUnsupported: number;
  trialsFailed: number;
  verified: number;
  verifiedRateAllTrials: number | null;
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
};

type CaseSummary = {
  caseId: string;
  adapter: string;
  trialsExecuted: number;
  trialsUnsupported: number;
  verified: number;
  verifiedRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
};

type Report = {
  schemaVersion: number;
  generatedAt: string;
  benchmarkCommit: string | null;
  benchmarkTreeDirty: boolean | null;
  benchmarkSourceDigest: string;
  suite: string;
  strictComparison: boolean;
  comparisonWarnings: string[];
  adapters: Array<{ id: string; version: string | null }>;
  adapterDefinitions: Array<{ id: string; metadata: Record<string, unknown> }>;
  cases: Array<{
    id: string;
    title: string;
    manifestDigest: string;
    promptDigest: string;
    fixtureDigest: string | null;
  }>;
  summary: Summary[];
  caseSummary: CaseSummary[];
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function inline(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/`/gu, "'").replace(/[\r\n]+/gu, " ").trim();
}

function runtimeName(id: string): string {
  if (id === "odinn-forge") return "Ódinn Forge";
  if (id === "openclaw") return "OpenClaw";
  if (id === "hermes-agent") return "Hermes Agent";
  return id;
}

function seconds(value: number | null): string {
  return value === null ? "n/a" : `${(value / 1_000).toFixed(2)}s`;
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(value === 1 ? 0 : 1)}%`;
}

function validate(reports: Report[], expectedCommit: string): void {
  assert(/^[0-9a-f]{40}$/u.test(expectedCommit), "expected harness commit must be a full Git SHA");
  assert(reports.length === 3, "exactly three adapter reports are required");
  for (const report of reports) {
    assert(report?.schemaVersion === 2, "benchmark report schema must be 2");
    assert(Array.isArray(report.summary), "benchmark report summary is missing");
  }
  assert(
    stable(reports.map((report) => report.summary[0]?.adapter).sort()) === stable([...ADAPTERS].sort()),
    "reports do not contain the required adapter matrix"
  );
  for (const report of reports) {
    assert(report.benchmarkCommit === expectedCommit, "benchmark report does not match the pinned harness commit");
    assert(report.benchmarkTreeDirty === false, "benchmark harness tree must be clean");
    assert(report.suite === SUITE, "benchmark report does not use the comprehensive suite");
    assert(report.strictComparison === true, "benchmark report must use strict comparison");
    assert(report.comparisonWarnings.length === 0, "benchmark report contains comparison warnings");
    assert(report.summary.length === 1, "each report must contain one adapter summary");
    assert(report.adapters.length === 1, "each report must contain one runtime version");
    assert(report.adapterDefinitions.length === 1, "each report must contain one adapter definition");
    assert(stable(report.cases.map((item) => item.id)) === stable(CASES), "benchmark report case set is incomplete or unexpected");
    const adapter = report.summary[0].adapter;
    assert(report.adapters[0].id === adapter, "runtime version does not match the report adapter");
    assert(report.adapterDefinitions[0].id === adapter, "adapter definition does not match the report adapter");
    assert(report.summary[0].cases === CASES.length, "benchmark summary case count is incomplete");
    assert(report.caseSummary.length === CASES.length, "benchmark report contains unexpected case summaries");
    const rows = report.caseSummary.filter((item) => item.adapter === adapter);
    assert(rows.length === CASES.length, "benchmark report does not contain one case summary per expected case");
    assert(stable(rows.map((item) => item.caseId)) === stable(CASES), "benchmark report case summaries are incomplete or unexpected");
    assert(new Set(rows.map((item) => item.caseId)).size === CASES.length, "benchmark report contains duplicate case summaries");
    assert(rows.every((item) => item.trialsExecuted + item.trialsUnsupported === 5), "every benchmark case must account for exactly five trials");
    assert(report.summary[0].trialsExecuted === rows.reduce((total, item) => total + item.trialsExecuted, 0), "executed total does not match case summaries");
    assert(report.summary[0].trialsUnsupported === rows.reduce((total, item) => total + item.trialsUnsupported, 0), "unsupported total does not match case summaries");
    assert(report.summary[0].verified === rows.reduce((total, item) => total + item.verified, 0), "verified total does not match case summaries");
    assert(report.summary[0].trialsExecuted + report.summary[0].trialsUnsupported === CASES.length * 5, "benchmark summary must account for all 35 trials");
  }
  const first = reports[0];
  for (const report of reports.slice(1)) {
    assert(report.benchmarkSourceDigest === first.benchmarkSourceDigest, "harness source digest mismatch");
    assert(stable(report.cases) === stable(first.cases), "case definition mismatch");
  }
  const metadata = reports.flatMap((report) => report.adapterDefinitions.map((item) => item.metadata));
  assert(metadata.length === 3 && new Set(metadata.map(stable)).size === 1, "adapter comparison metadata differs");
  assert(metadata[0].provider === "openai-oauth", "benchmark provider must remain openai-oauth");
  assert(metadata[0].model === "gpt-5.6-luna", "benchmark model must remain gpt-5.6-luna");
}

function orderedReports(reports: Report[]): Report[] {
  return ADAPTERS.map((adapter) => {
    const report = reports.find((item) => item.summary[0]?.adapter === adapter);
    assert(report, `missing report for ${adapter}`);
    return report;
  });
}

function version(report: Report): string {
  return inline(report.adapters.find((item) => item.id === report.summary[0].adapter)?.version?.split("\n")[0] || "version unavailable");
}

function replaceSnapshot(readme: string, content: string): string {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  assert(start >= 0 && end > start, "README benchmark markers are missing or invalid");
  return `${readme.slice(0, start)}${content}${readme.slice(end + END.length)}`;
}

function snapshot(reports: Report[], expectedCommit: string, runUrl: string): string {
  const ordered = orderedReports(reports);
  const date = ordered.map((report) => report.generatedAt).sort().at(-1)?.slice(0, 10);
  const metadata = ordered[0].adapterDefinitions[0].metadata;
  const rows = ordered.map((report) => {
    const summary = report.summary[0];
    const total = summary.trialsExecuted + summary.trialsUnsupported;
    return `| ${runtimeName(summary.adapter)} \`${version(report)}\` | ${summary.verified}/${total} | ${summary.trialsFailed} | ${percent(summary.verifiedRateAllTrials)} | ${seconds(summary.p50Ms)} | ${seconds(summary.p95Ms)} |`;
  }).join("\n");
  return `${START}
**${date} — weekly GitHub Actions comparison.** Seven deterministic cases ran five times per runtime with ${String(metadata.provider)}, \`${String(metadata.model)}\`, ${String(metadata.deployment)} deployment, ${String(metadata.sampling)} sampling, and the same ${String(metadata.toolPolicy)} policy.

| Runtime | Verified | Failed | Verified rate | p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
${rows}

Harness: [\`${expectedCommit.slice(0, 12)}\`](${HARNESS_URL}/commit/${expectedCommit}). [GitHub Actions run](${runUrl}). Raw reports are retained as workflow artifacts.
${END}`;
}

function details(reports: Report[], expectedCommit: string, runUrl: string): string {
  const ordered = orderedReports(reports);
  const metadata = ordered[0].adapterDefinitions[0].metadata;
  const generatedAt = ordered.map((report) => report.generatedAt).sort().at(-1);
  const runtimeRows = ordered.map((report) => {
    const summary = report.summary[0];
    const total = summary.trialsExecuted + summary.trialsUnsupported;
    return `| ${runtimeName(summary.adapter)} | \`${version(report)}\` | ${summary.verified}/${total} | ${summary.trialsFailed} | ${summary.trialsUnsupported} | ${percent(summary.verifiedRateAllTrials)} | ${seconds(summary.meanMs)} | ${seconds(summary.p50Ms)} | ${seconds(summary.p95Ms)} |`;
  }).join("\n");
  const caseRows = ordered[0].cases.flatMap((benchmarkCase) => ordered.map((report) => {
    const row = report.caseSummary.find((item) => item.caseId === benchmarkCase.id);
    assert(row, `missing case summary for ${benchmarkCase.id}`);
    const total = row.trialsExecuted + row.trialsUnsupported;
    return `| ${inline(benchmarkCase.title)} | ${runtimeName(row.adapter)} | ${row.verified}/${total} | ${percent(row.verifiedRate)} | ${seconds(row.p50Ms)} | ${seconds(row.p95Ms)} |`;
  })).join("\n");
  return `# Current comparative benchmarks

This page is generated by the weekly GitHub-hosted benchmark workflow from the latest complete, validated three-runtime matrix. The external harness owns cases, deterministic grading, and raw reports; Odinn Forge owns this published product snapshot.

## Latest complete run

- Generated: ${generatedAt}
- Workflow: ${runUrl}
- Harness: ${HARNESS_URL}/commit/${expectedCommit}
- Suite: \`${SUITE}\`
- Provider: \`${String(metadata.provider)}\`
- Model: \`${String(metadata.model)}\`
- Reasoning: \`${String(metadata.reasoning)}\`
- Sampling: \`${String(metadata.sampling)}\`
- Tool policy: \`${String(metadata.toolPolicy)}\`
- Harness source digest: \`${ordered[0].benchmarkSourceDigest}\`

| Runtime | Version | Verified | Failed | Unsupported | Verified rate | Mean | p50 | p95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${runtimeRows}

## Per-case results

| Case | Runtime | Verified | Verified rate | p50 | p95 |
| --- | --- | ---: | ---: | ---: | ---: |
${caseRows}

These numbers compare complete runtime-plus-model paths. They are not a release gate or a model-only score. Failed and unsupported trials remain in the denominator. Raw JSON, JSONL, and progress journals are retained on the linked Actions run.
`;
}

export async function renderBenchmarkDocumentation(input: {
  reportsDirectory: string;
  readmePath: string;
  docsPath: string;
  runUrl: string;
  expectedCommit: string;
}): Promise<void> {
  assert(/^https:\/\/github\.com\/BlueDot-IT\/Odinn-Forge\/actions\/runs\/\d+$/u.test(input.runUrl), "run URL is invalid");
  const files = (await readdir(input.reportsDirectory)).filter((file) => file.endsWith(".json")).sort();
  assert(
    stable(files) === stable(ADAPTERS.map((adapter) => `${adapter}.json`).sort()),
    "reports directory must contain exactly one named report per adapter"
  );
  const reports = await Promise.all(files.map(async (file) => JSON.parse(
    await readFile(join(input.reportsDirectory, file), "utf8")
  ) as Report));
  validate(reports, input.expectedCommit);
  const readme = await readFile(input.readmePath, "utf8");
  await writeFile(input.readmePath, replaceSnapshot(
    readme,
    snapshot(reports, input.expectedCommit, input.runUrl)
  ));
  await writeFile(input.docsPath, details(reports, input.expectedCommit, input.runUrl));
}

async function main(args = process.argv.slice(2)): Promise<void> {
  const option = (name: string): string => {
    const index = args.indexOf(name);
    return index >= 0 ? String(args[index + 1] ?? "") : "";
  };
  const reportsDirectory = resolve(option("--reports"));
  const readmePath = resolve(option("--readme") || "README.md");
  const docsPath = resolve(option("--docs") || "docs/benchmarks.md");
  const runUrl = option("--run-url");
  const expectedCommit = option("--expected-commit");
  if (!reportsDirectory || !runUrl || !expectedCommit) {
    throw new Error("--reports, --run-url, and --expected-commit are required");
  }
  await renderBenchmarkDocumentation({
    reportsDirectory,
    readmePath,
    docsPath,
    runUrl,
    expectedCommit
  });
  process.stdout.write("Updated Odinn Forge benchmark documentation from a complete pinned matrix.\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
