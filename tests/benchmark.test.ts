import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseP95Threshold, percentile } from "../scripts/ci/benchmark.ts";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("benchmark p95 threshold defaults and rejects invalid values", () => {
  assert.equal(parseP95Threshold(undefined), 2_000);
  assert.equal(parseP95Threshold(""), 2_000);
  assert.equal(parseP95Threshold("1250.5"), 1_250.5);
  for (const value of ["NaN", "Infinity", "-1", "0", "not-a-number"]) {
    assert.throws(() => parseP95Threshold(value), /finite number greater than zero/u);
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
  assert.match(smoke, /gatewayCommand/u);
  assert.doesNotMatch(benchmark, /apps\/gateway\/src\/server\.ts/u);
});
