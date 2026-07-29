import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../scripts/benchmark/compare.ts";

test("cross-agent benchmark runner grades output, workspace changes, and capability coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-benchmark-test-"));
  const config = join(root, "adapters.json");
  const output = join(root, "reports");
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    adapters: [{
      id: "fixture-agent",
      capabilities: ["text.generate", "workspace.read", "workspace.write", "process.exec"],
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs');if(fs.existsSync('calculator.mjs'))fs.writeFileSync('calculator.mjs','export function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }\\n');process.stdout.write('BENCHMARK_OK\\n')"
      ],
      output: { format: "text" }
    }]
  }, null, 2)}\n`);
  try {
    await main(["--config", config, "--output", output, "--trials", "1"]);
    const reports = (await readdir(output)).filter((name) => name.endsWith(".json"));
    assert.equal(reports.length, 1);
    const report = JSON.parse(await readFile(join(output, reports[0]), "utf8"));
    assert.equal(report.results.length, 2);
    assert.ok(report.results.every((result: any) => result.verified));
    assert.equal(report.summary[0].verifiedRateExecuted, 1);
    assert.equal(report.summary[0].verifiedRateAllTrials, 1);
    assert.equal(report.summary[0].capabilityCoverage, 1);
    assert.equal(typeof report.summary[0].meanMs, "number");
    assert.equal(report.caseSummary.length, 2);
    assert.ok(report.caseSummary.every((row: any) => row.verifiedRate === 1 && typeof row.meanMs === "number"));
    assert.match(report.forgeCommit, /^[0-9a-f]{40}$/u);
    assert.equal(typeof report.forgeTreeDirty, "boolean");
    assert.match(report.cases[0].manifestDigest, /^[0-9a-f]{64}$/u);
    assert.match(report.cases[0].promptDigest, /^[0-9a-f]{64}$/u);
    const jsonl = (await readdir(output)).find((name) => name.endsWith(".jsonl"));
    const trialEnvelope = JSON.parse(await readFile(join(output, jsonl!), "utf8").then((value) => value.trim().split("\n")[0]));
    assert.equal(trialEnvelope.adapter.id, "fixture-agent");
    assert.equal(trialEnvelope.result.verified, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-agent benchmark runner records unsupported cases instead of hiding them", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-benchmark-unsupported-"));
  const config = join(root, "adapters.json");
  const output = join(root, "reports");
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    adapters: [{
      id: "text-only",
      capabilities: ["text.generate"],
      command: process.execPath,
      args: ["-e", "process.stdout.write('BENCHMARK_OK\\n')"],
      output: { format: "text" }
    }]
  }, null, 2)}\n`);
  try {
    await main(["--config", config, "--output", output, "--trials", "1"]);
    const reports = (await readdir(output)).filter((name) => name.endsWith(".json"));
    const report = JSON.parse(await readFile(join(output, reports[0]), "utf8"));
    assert.equal(report.results.find((result: any) => result.caseId === "javascript-repair-001").status, "unsupported");
    assert.equal(report.summary[0].trialsUnsupported, 1);
    assert.equal(report.summary[0].capabilityCoverage, 0.5);
    assert.equal(report.summary[0].verifiedRateExecuted, 1);
    assert.equal(report.summary[0].verifiedRateAllTrials, 0.5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-agent benchmark runner rejects local adapters under cloud-only policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-benchmark-cloud-only-"));
  const config = join(root, "adapters.json");
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    modelPolicy: "cloud-only",
    adapters: [{
      id: "local-agent",
      metadata: {
        provider: "ollama",
        model: "qwen3-vl:4b",
        deployment: "local"
      },
      capabilities: ["text.generate"],
      command: process.execPath,
      args: ["-e", "process.stdout.write('BENCHMARK_OK\\n')"],
      output: { format: "text" }
    }]
  }, null, 2)}\n`);
  try {
    await assert.rejects(
      main(["--config", config, "--output", join(root, "reports"), "--trials", "1"]),
      /cloud-only benchmark requires metadata\.deployment="cloud" for adapters: local-agent/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
