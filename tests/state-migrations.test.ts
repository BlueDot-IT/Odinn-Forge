import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ensureStateCompatibility, inspectStateSchemas, planStateMigration, STATE_SCHEMA_TARGETS } from "../packages/kernel/src/index.ts";
import { inspectExistingSqliteSchema, SqliteStore } from "../packages/store-sqlite/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "tests", "fixtures", "state");

async function fixture(name: string): Promise<{ temporary: string; state: string }> {
  const temporary = await mkdtemp(join(tmpdir(), `odinn-state-${name}-`));
  const state = join(temporary, "state");
  await cp(join(fixtures, name), state, { recursive: true });
  return { temporary, state };
}

test("latest pre-v1 state plans, backs up, migrates atomically, and preserves stable data", async () => {
  const { temporary, state } = await fixture("latest-pre-v1");
  try {
    const before = {
      records: await readFile(join(state, "records.jsonl"), "utf8"),
      jobs: await readFile(join(state, "jobs.json"), "utf8"),
      approvals: await readFile(join(state, "approvals.json"), "utf8"),
      recovery: await readFile(join(state, "browser-recovery.json"), "utf8")
    };
    const dryRun = await planStateMigration(state, { applicationVersion: "1.0.0", applicationCommit: "fixture-v1" });
    assert.deepEqual(dryRun.steps.map((step) => step.id), ["host-metadata-v0-to-v1"]);
    assert.equal(dryRun.rollbackCompatible, true);
    assert.ok(dryRun.backupLocation);
    await assert.rejects(() => readFile(join(state, "state-schema.json"), "utf8"), { code: "ENOENT" });

    const report = await ensureStateCompatibility(state, { applicationVersion: "1.0.0", applicationCommit: "fixture-v1" });
    assert.ok(report);
    assert.equal(report.rollbackCompatible, true);
    assert.equal(report.auditIntegrity.valid, true);
    assert.ok(report.backupLocation);
    assert.equal(await readFile(join(state, "records.jsonl"), "utf8"), before.records);
    assert.equal(await readFile(join(state, "jobs.json"), "utf8"), before.jobs);
    assert.equal(await readFile(join(state, "approvals.json"), "utf8"), before.approvals);
    assert.equal(await readFile(join(state, "browser-recovery.json"), "utf8"), before.recovery);
    assert.equal(await readFile(join(report.backupLocation!, "records.jsonl"), "utf8"), before.records);
    if (process.platform !== "win32") {
      assert.equal((await stat(report.backupLocation!)).mode & 0o777, 0o700);
      assert.equal((await stat(join(report.backupLocation!, "config.json"))).mode & 0o777, 0o600);
    }

    const manifest = JSON.parse(await readFile(join(state, "state-schema.json"), "utf8"));
    assert.deepEqual(manifest.storeVersions, STATE_SCHEMA_TARGETS);
    const inspection = await inspectStateSchemas(state);
    assert.equal(inspection.healthy, true);
    assert.deepEqual(inspection.currentVersions, STATE_SCHEMA_TARGETS);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("release-candidate and empty state need no migration", async () => {
  const candidate = await fixture("release-candidate");
  const empty = await mkdtemp(join(tmpdir(), "odinn-state-empty-"));
  try {
    assert.deepEqual((await planStateMigration(candidate.state)).steps, []);
    assert.deepEqual((await planStateMigration(join(empty, "state"))).steps, []);
    assert.equal(await ensureStateCompatibility(join(empty, "state")), undefined);
  } finally {
    await rm(candidate.temporary, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
  }
});

test("release-candidate SQLite state migrates transactionally and preserves its compatible rollback floor", async () => {
  const candidate = await fixture("release-candidate");
  const databasePath = join(candidate.state, "db", "odinn.sqlite");
  try {
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new SqliteStore(databasePath, { targetVersion: 2 });
    database.close();
    const plan = await planStateMigration(candidate.state, { applicationVersion: "1.0.0", applicationCommit: "fixture-v1" });
    assert.deepEqual(plan.steps.map((step) => step.id), ["runtime-database-v2-to-v3"]);
    assert.equal(plan.rollbackCompatible, true);
    const report = await ensureStateCompatibility(candidate.state, { applicationVersion: "1.0.0", applicationCommit: "fixture-v1" });
    assert.ok(report?.backupLocation);
    assert.equal(inspectExistingSqliteSchema(databasePath), 3);
    assert.equal(inspectExistingSqliteSchema(join(report.backupLocation!, "db", "odinn.sqlite")), 2);
    const manifest = JSON.parse(await readFile(join(candidate.state, "state-schema.json"), "utf8"));
    assert.equal(manifest.minimumApplicationVersion, "1.0.0-rc.1");
    assert.equal(manifest.applicationVersion, "1.0.0");
    assert.equal(manifest.storeVersions.runtimeDatabase, 3);
  } finally {
    await rm(candidate.temporary, { recursive: true, force: true });
  }
});

test("legacy config, approvals, and browser recovery use explicit deterministic migrations", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-state-legacy-"));
  const state = join(temporary, "state");
  try {
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "config.json"), `${JSON.stringify({ auditLog: "audit.jsonl", policy: { browser: { requireApproval: true } }, futureField: { preserve: true } }, null, 2)}\n`);
    await writeFile(join(state, "approvals.json"), `${JSON.stringify([{ id: "approval_legacy", status: "pending", unknown: "preserve" }], null, 2)}\n`);
    await writeFile(join(state, "browser-recovery.json"), `${JSON.stringify({ status: "unknown", id: "legacy", unknown: "preserve" }, null, 2)}\n`);
    const plan = await planStateMigration(state);
    assert.deepEqual(plan.steps.map((step) => step.id), [
      "config-v0-to-v1",
      "approvals-v0-to-v1",
      "browser-recovery-v0-to-v1",
      "host-metadata-v0-to-v1"
    ]);
    await ensureStateCompatibility(state, { applicationVersion: "1.0.0" });
    const config = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
    const approvals = JSON.parse(await readFile(join(state, "approvals.json"), "utf8"));
    const recovery = JSON.parse(await readFile(join(state, "browser-recovery.json"), "utf8"));
    assert.equal(config.version, 1);
    assert.deepEqual(config.futureField, { preserve: true });
    assert.equal(config.policy.browser.requireApproval, true);
    assert.equal(approvals.schemaVersion, 1);
    assert.equal(approvals.approvals[0].unknown, "preserve");
    assert.equal(recovery.schemaVersion, 1);
    assert.equal(recovery.status, "unknown");
    assert.equal(recovery.unknown, "preserve");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("cron migration refuses invalid legacy definitions before cutover", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-state-cron-invalid-"));
  const state = join(temporary, "state");
  try {
    await mkdir(state, { recursive: true });
    const legacy = { schemaVersion: 1, jobs: [{ id: "broken", schedule: "60 * * * *", timezone: "UTC", tool: "text.echo" }] };
    await writeFile(join(state, "cron-jobs.json"), `${JSON.stringify(legacy, null, 2)}\n`);
    await assert.rejects(
      () => ensureStateCompatibility(state, { applicationVersion: "1.0.0", applicationCommit: "cron-v2" }),
      /cron migration refused legacy job broken/u
    );
    assert.deepEqual(JSON.parse(await readFile(join(state, "cron-jobs.json"), "utf8")), legacy);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("cron schema v1 migrates with a protected rollback backup and preserves definitions", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-state-cron-v1-"));
  const state = join(temporary, "state");
  try {
    await mkdir(state, { recursive: true });
    const legacy = {
      schemaVersion: 1,
      jobs: [{ id: "cron_legacy", name: "Legacy", schedule: "0 9 * * 1-5", timezone: "UTC", tool: "text.echo", futureField: { preserve: true } }]
    };
    await writeFile(join(state, "cron-jobs.json"), `${JSON.stringify(legacy, null, 2)}\n`);
    const plan = await planStateMigration(state, { applicationVersion: "1.0.0", applicationCommit: "cron-v2" });
    assert.ok(plan.steps.some((step) => step.id === "cron-v1-to-v2"));
    assert.equal(plan.rollbackCompatible, false);
    const report = await ensureStateCompatibility(state, { applicationVersion: "1.0.0", applicationCommit: "cron-v2" });
    assert.ok(report?.backupLocation);
    const migrated = JSON.parse(await readFile(join(state, "cron-jobs.json"), "utf8"));
    assert.equal(migrated.schemaVersion, 2);
    assert.deepEqual(migrated.jobs[0].futureField, { preserve: true });
    const backup = JSON.parse(await readFile(join(report!.backupLocation!, "cron-jobs.json"), "utf8"));
    assert.equal(backup.schemaVersion, 1);
    assert.deepEqual(backup.jobs, legacy.jobs);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("corrupted and unknown future state fail closed without replacing working files", async () => {
  const corrupted = await fixture("corrupted");
  const future = await fixture("future");
  try {
    await writeFile(join(corrupted.state, "config.json"), "{\"version\":1,\"auditLog\":");
    await assert.rejects(() => planStateMigration(corrupted.state), /Unexpected end of JSON input|JSON/u);
    const futureJobs = await readFile(join(future.state, "jobs.json"), "utf8");
    const plan = await planStateMigration(future.state);
    assert.match(plan.blockingIncompatibilities.join("\n"), /jobs schema 99 is newer/u);
    await assert.rejects(() => ensureStateCompatibility(future.state), /jobs schema 99 is newer/u);
    assert.equal(await readFile(join(future.state, "jobs.json"), "utf8"), futureJobs);
  } finally {
    await rm(corrupted.temporary, { recursive: true, force: true });
    await rm(future.temporary, { recursive: true, force: true });
  }
});

test("migration inspection rejects unsafe links and state-root path escapes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-state-links-"));
  const symlinkState = join(temporary, "symlink-state");
  const hardLinkState = join(temporary, "hardlink-state");
  const escapedState = join(temporary, "escaped-state");
  try {
    await mkdir(symlinkState);
    await writeFile(join(symlinkState, "config.json"), "{\"version\":1}\n");
    await symlink(join(symlinkState, "config.json"), join(symlinkState, "linked-config.json"));
    await assert.rejects(() => planStateMigration(symlinkState), /symbolic link/u);

    await mkdir(hardLinkState);
    await writeFile(join(hardLinkState, "config.json"), "{\"version\":1}\n");
    await link(join(hardLinkState, "config.json"), join(hardLinkState, "hard-linked-config.json"));
    await assert.rejects(() => planStateMigration(hardLinkState), /hard-linked file/u);

    await mkdir(escapedState);
    await writeFile(join(escapedState, "config.json"), `${JSON.stringify({ version: 1, auditLog: "../outside.jsonl" })}\n`);
    await assert.rejects(
      () => planStateMigration(escapedState),
      /auditLog must be audit\.jsonl or an audit-\*\.jsonl filename/u
    );
    await assert.rejects(() => readFile(join(temporary, "outside.jsonl"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("unknown future SQLite schemas are rejected before migration", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-state-future-sqlite-"));
  const state = join(temporary, "state");
  const databasePath = join(state, "db", "odinn.sqlite");
  try {
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(99, new Date().toISOString());
    database.close();
    const before = await readFile(databasePath);
    const plan = await planStateMigration(state);
    assert.match(plan.blockingIncompatibilities.join("\n"), /runtimeDatabase schema 99 is newer/u);
    await assert.rejects(() => ensureStateCompatibility(state), /runtimeDatabase schema 99 is newer/u);
    assert.throws(() => new SqliteStore(databasePath), /newer than this Odinn version supports/u);
    assert.deepEqual(await readFile(databasePath), before);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("interrupted cutover recovers the original state and completes on the next run", async () => {
  const { temporary, state } = await fixture("latest-pre-v1");
  try {
    const originalRecords = await readFile(join(state, "records.jsonl"), "utf8");
    await assert.rejects(
      () => ensureStateCompatibility(state, {
        applicationVersion: "1.0.0",
        onPhase(phase) {
          if (phase === "cutover-started") throw new Error("fixture crash after original state rename");
        }
      }),
      /fixture crash/u
    );
    const report = await ensureStateCompatibility(state, { applicationVersion: "1.0.0" });
    assert.ok(report);
    assert.equal(report.recoveredInterruptedMigration, true);
    assert.equal(await readFile(join(state, "records.jsonl"), "utf8"), originalRecords);
    assert.equal((await inspectStateSchemas(state)).healthy, true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("interruption after activation verifies the new state and records recovery", async () => {
  const { temporary, state } = await fixture("latest-pre-v1");
  try {
    await assert.rejects(
      () => ensureStateCompatibility(state, {
        applicationVersion: "1.0.0",
        onPhase(phase) {
          if (phase === "activated") throw new Error("fixture crash after activation");
        }
      }),
      /fixture crash/u
    );
    assert.equal(await ensureStateCompatibility(state, { applicationVersion: "1.0.0" }), undefined);
    const history = (await readFile(join(state, "migration-history.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(history.at(-1).type, "state.migration.recovered");
    assert.equal(history.at(-1).outcome, "activated-state-verified");
    assert.equal((await inspectStateSchemas(state)).healthy, true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("CLI migration dry-run reports the plan without modifying state", async () => {
  const { temporary, state } = await fixture("latest-pre-v1");
  try {
    const before = await readFile(join(state, "records.jsonl"), "utf8");
    const result = spawnSync(process.execPath, [
      "apps/cli/src/cli.ts",
      "state",
      "migrate",
      "--dry-run",
      "--state",
      state
    ], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.dryRun, true);
    assert.deepEqual(plan.steps.map((step: any) => step.id), ["host-metadata-v0-to-v1"]);
    assert.equal(await readFile(join(state, "records.jsonl"), "utf8"), before);
    await assert.rejects(() => readFile(join(state, "state-schema.json"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("state-free provider catalog does not migrate an invocation workspace", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-state-free-command-"));
  const state = join(temporary, ".odinn");
  try {
    await cp(join(fixtures, "latest-pre-v1"), state, { recursive: true });
    const result = spawnSync(process.execPath, [
      join(root, "apps", "cli", "src", "cli.ts"),
      "config",
      "provider",
      "catalog"
    ], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, INIT_CWD: temporary }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    await assert.rejects(() => readFile(join(state, "state-schema.json"), "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(join(temporary, ".odinn.backups"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
