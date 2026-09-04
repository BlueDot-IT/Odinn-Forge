import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  evaluateLongSoakCycle,
  resolveLongSoakConfig
} from "../scripts/ci/long-soak.ts";

const passingCycle = {
  index: 1,
  startedAt: "2026-08-27T00:00:00.000Z",
  endedAt: "2026-08-27T00:01:00.000Z",
  durationMs: 60_000,
  peakProcessTreeRssBytes: 512 * 1024 ** 2,
  resourceMeasurement: "linux-process-tree" as const,
  release: {
    finalState: "passed",
    restartCount: 2,
    powerLossCount: 1,
    recoveredJobs: 1,
    unresolvedApprovals: 0,
    auditVerification: true,
    browserRecoveryBlocked: true,
    rollbackVerified: true
  },
  audit: {
    ok: true,
    restart: true,
    rotation: true,
    archive: true,
    retention: true
  },
  violations: [],
  ok: true
};

test("development long-soak profile is deterministic and still repeats", () => {
  const config = resolveLongSoakConfig(["--profile", "development"]);
  assert.equal(config.targetDurationMs, 0);
  assert.equal(config.minimumCycles, 2);
  assert.equal(config.cycleIntervalMs, 0);
  assert.equal(config.auditEvents, 200);
  assert.equal(config.budgets.minimumPowerLossesPerCycle, 1);
});

test("nightly long-soak profile cannot collapse into a one-shot", () => {
  assert.throws(
    () => resolveLongSoakConfig([
      "--profile", "nightly",
      "--duration-ms", "3599999",
      "--min-cycles", "12"
    ]),
    /at least one hour/u
  );
  assert.throws(
    () => resolveLongSoakConfig([
      "--profile", "nightly",
      "--duration-ms", "3600000",
      "--min-cycles", "7"
    ]),
    /at least eight complete cycles/u
  );
});

test("cycle budgets require restart, power-loss, recovery, audit, and rollback evidence", () => {
  const config = resolveLongSoakConfig(["--profile", "development"]);
  assert.deepEqual(evaluateLongSoakCycle(passingCycle, config), []);
  const failed = {
    ...passingCycle,
    durationMs: config.budgets.maximumCycleDurationMs + 1,
    peakProcessTreeRssBytes: config.budgets.maximumPeakProcessTreeRssBytes + 1,
    release: {
      ...passingCycle.release,
      powerLossCount: 0,
      recoveredJobs: 0,
      unresolvedApprovals: 1,
      rollbackVerified: false
    },
    audit: { ...passingCycle.audit, retention: false }
  };
  assert.deepEqual(evaluateLongSoakCycle(failed, config), [
    "approval-budget-exceeded",
    "audit-retention-failed",
    "cycle-duration-budget-exceeded",
    "power-loss-budget-missed",
    "process-tree-rss-budget-exceeded",
    "recovery-budget-missed",
    "rollback-not-verified"
  ]);
});

test("nightly workflow retains exact-commit long-soak evidence on failure", async () => {
  const [workflow, pkg, releaseSoak, documentation] = await Promise.all([
    readFile(new URL("../.github/workflows/nightly.yml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/release/soak.ts", import.meta.url), "utf8"),
    readFile(new URL("../docs/phase-f-long-soak.md", import.meta.url), "utf8")
  ]);
  assert.equal(JSON.parse(pkg).scripts["soak:long"], "node scripts/ci/long-soak.ts");
  assert.match(workflow, /--duration-ms 7200000/u);
  assert.match(workflow, /--min-cycles 12/u);
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}/u);
  assert.match(workflow, /retention-days: 30/u);
  assert.match(workflow, /phase-f-long-soak-\$\{\{ github\.sha \}\}/u);
  assert.match(releaseSoak, /ODINN_SOAK_POWER_LOSS/u);
  assert.match(releaseSoak, /"SIGKILL"/u);
  assert.match(releaseSoak, /if \(interruptionSignal === "SIGKILL"\) await delay\(30_100\)/u);
  assert.match(documentation, /not an\s+alias for the one-shot release soak/u);
  assert.match(documentation, /exact 40-character source commit/u);
});
