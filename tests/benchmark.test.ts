import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseP95Threshold, parseSampleCount, percentile } from "../scripts/ci/benchmark.ts";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("benchmark p95 threshold defaults and rejects invalid values", () => {
  assert.equal(parseP95Threshold(undefined), 2_000);
  assert.equal(parseP95Threshold(""), 2_000);
  assert.equal(parseP95Threshold("1250.5"), 1_250.5);
  for (const value of ["NaN", "Infinity", "-1", "0", "not-a-number"]) {
    assert.throws(() => parseP95Threshold(value), /finite number greater than zero/u);
  }
});

test("benchmark sample count defaults and rejects invalid values", () => {
  assert.equal(parseSampleCount(undefined), 20);
  assert.equal(parseSampleCount(""), 20);
  assert.equal(parseSampleCount("1"), 1);
  for (const value of ["NaN", "Infinity", "-1", "0", "1.5", "not-a-number"]) {
    assert.throws(() => parseSampleCount(value), /positive safe integer/u);
  }
});

test("benchmark percentile is deterministic and bounded", () => {
  assert.equal(percentile([30, 10, 20], 0.5), 20);
  assert.equal(percentile([10, 20, 30, 40], 0.95), 40);
  assert.throws(() => percentile([], 0.95), /at least one sample/u);
  assert.throws(() => percentile([1], 0), /greater than zero/u);
  assert.throws(() => percentile([1], 1.1), /at most one/u);
});

test("CI benchmark targets the staged packaged release and retains a JSON report", async () => {
  const benchmark = await read("scripts/ci/benchmark.ts");
  const smoke = await read("scripts/ci/inference-smoke.ts");
  assert.match(benchmark, /pnpm.*build/u);
  assert.match(benchmark, /release:package/u);
  assert.match(benchmark, /dist.*package-stage/u);
  assert.match(benchmark, /benchmark\.json/u);
  assert.match(benchmark, /gatewayCommand/u);
  assert.match(benchmark, /pathToFileURL/u);
  assert.match(benchmark, /provenance/u);
  assert.match(smoke, /gatewayCommand/u);
  assert.doesNotMatch(benchmark, /apps\/gateway\/src\/server\.ts/u);
});

test("benchmark subprocess writes a report when invoked directly", { timeout: 180_000 }, async () => {
  const workspace = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const script = fileURLToPath(new URL("../scripts/ci/benchmark.ts", import.meta.url));
  const temp = await mkdtemp(join(tmpdir(), "odinn-benchmark-entrypoint-"));
  const reportPath = join(temp, "benchmark.json");
  try {
    const result = spawnSync(process.execPath, [script], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        ODINN_BENCHMARK_JSON: reportPath,
        ODINN_BENCHMARK_P95_MAX_MS: "60000",
        ODINN_BENCHMARK_SAMPLES: "1"
      },
      timeout: 165_000
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.sampleTarget, 1);
    assert.equal(report.samples.length, 1);
    assert.equal(report.provenance.command, "pnpm benchmark:ci");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
