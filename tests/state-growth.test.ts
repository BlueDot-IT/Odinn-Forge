import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FULL_STATE_GROWTH_TIERS,
  parseStateGrowthTiers,
  runStateGrowthAcceptance,
  stateGrowthRecord,
} from "../scripts/ci/state-growth.ts";

test("state-growth fixtures and tier parsing are deterministic and bounded", () => {
  assert.deepEqual(parseStateGrowthTiers(undefined), FULL_STATE_GROWTH_TIERS);
  assert.deepEqual(parseStateGrowthTiers("500,2000"), [500, 2_000]);
  assert.deepEqual(stateGrowthRecord(0), stateGrowthRecord(0));
  assert.equal(stateGrowthRecord(410).type, "memory");
  assert.equal(stateGrowthRecord(410).id, "memory-410");
  assert.throws(() => parseStateGrowthTiers("100,100"), /unique and strictly ascending/u);
  assert.throws(() => parseStateGrowthTiers("1000,999"), /unique and strictly ascending/u);
  assert.throws(() => parseStateGrowthTiers("1000001"), /cannot exceed/u);
  assert.throws(() => stateGrowthRecord(1_000_000), /outside the supported fixture/u);
});

test("development state-growth profile reopens mixed production stores and verifies archive retention", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-state-growth-test-"));
  const reportPath = join(root, "state-growth-report.json");
  try {
    const report = await runStateGrowthAcceptance({
      tiers: [500, 2_000],
      batchSize: 250,
      auditEvents: 40,
      reportPath,
      enforceBudgets: false,
    });
    assert.equal(report.ok, true);
    assert.equal(report.profile, "development");
    assert.deepEqual(report.configuration.tiers, [500, 2_000]);
    assert.equal(report.configuration.retentionPolicy.authoritativeRecords, "append-only");
    assert.equal(report.configuration.retentionPolicy.auditEvents, "verified-archive-before-online-retention");
    assert.equal(report.configuration.retentionPolicy.reportArtifactDays, 30);
    assert.deepEqual(report.tiers.map((tier) => tier.records), [500, 2_000]);
    assert.ok(report.tiers.every((tier) => tier.databaseBytes > 0 && tier.rssBytes > 0));
    assert.ok(report.tiers.every((tier) => tier.queries.length === 7 && tier.queries.every((query) => query.p95Ms >= 0)));
    assert.equal(report.retention.retainedThrough, 20);
    assert.equal(report.retention.deletedOnlineEvents, 20);
    assert.equal(report.retention.onlineEventsAfterRetention, 21);
    assert.equal(report.retention.restartIntegrityValid, true);
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), report);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nightly workflow owns the full 10K/100K/1M acceptance artifact", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts["state:growth"], "node scripts/ci/state-growth.ts");
  const workflow = await readFile(new URL("../.github/workflows/nightly.yml", import.meta.url), "utf8");
  const documentation = await readFile(new URL("../docs/audit-storage.md", import.meta.url), "utf8");
  assert.match(workflow, /name: State growth and retention/u);
  assert.match(workflow, /pnpm state:growth/u);
  assert.match(workflow, /dist\/reports\/state-growth-report\.json/u);
  assert.match(workflow, /if: always\(\)/u);
  assert.match(workflow, /retention-days: 30/u);
  assert.doesNotMatch(workflow, /ODINN_STATE_GROWTH_TIERS/u);
  assert.doesNotMatch(workflow, /secrets\.|contents: write|pull-requests: write/u);
  assert.match(documentation, /pnpm state:growth/u);
  assert.match(documentation, /1,000,000\s+records/u);
  assert.match(documentation, /30 days/u);
});
