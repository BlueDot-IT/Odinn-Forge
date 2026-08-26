import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createRunLedger, createStateBackup, ensureStateCompatibility, inspectStateSchemas, isOwnerOnlyPath, planStateMigration, STATE_SCHEMA_TARGETS, stateLifecycleStatus } from "../packages/kernel/src/index.ts";
import { ArtifactStore, inspectExistingSqliteSchema, RunLedger, SqliteJobStore, SqliteStore } from "../packages/store-sqlite/src/index.ts";

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
    assert.deepEqual(dryRun.steps.map((step) => step.id), ["records-v0-to-v1", "audit-v0-to-v1", "host-metadata-v0-to-v1"]);
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
    assert.ok((await stat(join(state, "db", "records.sqlite"))).isFile());
    assert.ok((await stat(join(state, "db", "audit.sqlite"))).isFile());
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

test("Windows migration hardens the activated state tree", { skip: process.platform !== "win32" }, async () => {
  const { temporary, state } = await fixture("latest-pre-v1");
  try {
    await ensureStateCompatibility(state, { applicationVersion: "1.0.0", applicationCommit: "windows-migration" });
    assert.equal(await isOwnerOnlyPath(state), true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("release-candidate and empty state need no migration", async () => {
  const candidate = await fixture("release-candidate");
  const empty = await mkdtemp(join(tmpdir(), "odinn-state-empty-"));
  try {
    assert.deepEqual((await planStateMigration(candidate.state)).steps, []);
    const legacyManifestPath = join(candidate.state, "state-schema.json");
    const legacyManifest = JSON.parse(await readFile(legacyManifestPath, "utf8"));
    delete legacyManifest.storeVersions.channelBindings;
    delete legacyManifest.storeVersions.channelDedupe;
    await writeFile(legacyManifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);
    assert.deepEqual((await planStateMigration(candidate.state)).steps, []);
    assert.equal((await inspectStateSchemas(candidate.state)).healthy, true);
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
    const legacyJobs = `${JSON.stringify({ schemaVersion: 1, jobs: {
      migrated_job: { schemaVersion: 1, id: "migrated_job", status: "queued", payload: { task: { id: "migrated_job", tool: "text.echo", input: { text: "preserve" } } }, retrySafe: true, attempts: 0, timeoutMs: 1_000 }
    } }, null, 2)}\n`;
    await writeFile(join(candidate.state, "jobs.json"), legacyJobs);
    const plan = await planStateMigration(candidate.state, { applicationVersion: "1.0.0", applicationCommit: "fixture-v1" });
    assert.deepEqual(plan.steps.map((step) => step.id), ["runtime-database-v2-to-v3", "runtime-database-v3-to-v4", "runtime-database-v4-to-v5", "runtime-database-v5-to-v6", "runtime-database-v6-to-v7", "runtime-database-v7-to-v8", "runtime-database-v8-to-v9", "runtime-database-v9-to-v10"]);
    assert.equal(plan.rollbackCompatible, false);
    const report = await ensureStateCompatibility(candidate.state, { applicationVersion: "1.0.0", applicationCommit: "fixture-v1" });
    assert.ok(report?.backupLocation);
    assert.equal(inspectExistingSqliteSchema(databasePath), 10);
    assert.equal(inspectExistingSqliteSchema(join(report.backupLocation!, "db", "odinn.sqlite")), 2);
    const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal((migratedDatabase.prepare("SELECT status FROM runtime_jobs WHERE id = 'migrated_job'").get() as { status: string }).status, "queued");
    migratedDatabase.close();
    assert.equal(await readFile(join(candidate.state, "jobs.json"), "utf8"), legacyJobs);
    const manifest = JSON.parse(await readFile(join(candidate.state, "state-schema.json"), "utf8"));
    assert.equal(manifest.minimumApplicationVersion, "1.0.0");
    assert.equal(manifest.applicationVersion, "1.0.0");
    assert.equal(manifest.storeVersions.runtimeDatabase, 10);
  } finally {
    await rm(candidate.temporary, { recursive: true, force: true });
  }
});

test("release-candidate migration from runtime schema 5 persists checkpoint journal tables", async () => {
  const candidate = await fixture("release-candidate");
  const databasePath = join(candidate.state, "db", "odinn.sqlite");
  try {
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new SqliteStore(databasePath, { targetVersion: 5 });
    database.close();
    const report = await planStateMigration(candidate.state, { applicationVersion: "1.0.0", applicationCommit: "fixture-v1" });
    assert.deepEqual(report.steps.map((step) => step.id), ["runtime-database-v5-to-v6", "runtime-database-v6-to-v7", "runtime-database-v7-to-v8", "runtime-database-v8-to-v9", "runtime-database-v9-to-v10"]);
    const migration = await ensureStateCompatibility(candidate.state, { applicationVersion: "1.0.0", applicationCommit: "fixture-v1" });
    assert.ok(migration?.backupLocation);
    assert.equal(inspectExistingSqliteSchema(databasePath), 10);
    const sqlite = new DatabaseSync(databasePath);
    try {
      const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('mutation_groups','mutation_checkpoints','mutation_journal_entries','checkpoint_manifest_artifacts','agent_graph_runs','agent_graph_nodes','agent_graph_edges','agent_graph_reassignments')").all() as Array<{ name: string }>).map((row) => row.name).sort();
      assert.deepEqual(tables, ["agent_graph_edges", "agent_graph_nodes", "agent_graph_reassignments", "agent_graph_runs", "checkpoint_manifest_artifacts", "mutation_checkpoints", "mutation_groups", "mutation_journal_entries"]);
    } finally {
      sqlite.close();
    }
  } finally {
    await rm(candidate.temporary, { recursive: true, force: true });
  }
});

test("a true runtime schema 6 fixture preserves jobs and supports graph read/write after migration", async () => {
  const candidate = await fixture("release-candidate");
  const databasePath = join(candidate.state, "db", "odinn.sqlite");
  try {
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new SqliteStore(databasePath, { targetVersion: 6 });
    const ledger = new RunLedger({
      database,
      artifacts: new ArtifactStore(join(candidate.state, "artifacts")),
      workspaceRoot: candidate.state,
      stateDir: candidate.state
    });
    const jobs = new SqliteJobStore(ledger);
    await jobs.create({
      id: "schema6-preserved-job",
      status: "queued",
      payload: { task: { id: "schema6-preserved-job", tool: "text.echo", input: { text: "preserve-v6" } } },
      retrySafe: true,
      attempts: 0,
      timeoutMs: 1_000
    });
    ledger.close();

    const plan = await planStateMigration(candidate.state, { applicationVersion: "1.0.0", applicationCommit: "fixture-v1" });
    assert.deepEqual(plan.steps.map((step) => step.id), ["runtime-database-v6-to-v7", "runtime-database-v7-to-v8", "runtime-database-v8-to-v9", "runtime-database-v9-to-v10"]);
    const report = await ensureStateCompatibility(candidate.state, { applicationVersion: "1.0.0", applicationCommit: "fixture-v1" });
    assert.ok(report?.backupLocation);
    assert.equal(inspectExistingSqliteSchema(databasePath), 10);

    const sqlite = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const preserved = sqlite.prepare("SELECT status, payload_json FROM runtime_jobs WHERE id = ?").get("schema6-preserved-job") as { status: string; payload_json: string };
      assert.equal(preserved.status, "queued");
      assert.match(preserved.payload_json, /preserve-v6/u);
      assert.ok(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_graph_runs'").get());
    } finally {
      sqlite.close();
    }

    const migrated = createRunLedger({ stateDir: candidate.state, workspaceRoot: candidate.state });
    try {
      const digest = "c".repeat(64);
      migrated.ensureRun({ runId: "schema6-parent", objective: "post-migration graph" });
      migrated.createAgentGraphRun({
        graphRunId: "schema6-graph",
        parentRunId: "schema6-parent",
        graphDigest: digest,
        manifestsDigest: digest,
        graphBytes: 32,
        manifestsBytes: 32,
        principalNamespace: "operator",
        requestDigest: digest,
        maxRunMs: 10_000,
        nodes: [{
          nodeId: "child",
          manifestId: "reader",
          manifestDigest: digest,
          inputRef: "input:child",
          inputDigest: digest,
          resultRef: "result:child",
          dependsOn: []
        }]
      });
      const graph = migrated.getAgentGraphRun("schema6-graph");
      assert.equal(graph?.status, "validated");
      assert.equal(graph?.nodes[0]?.status, "queued");
      assert.equal(graph?.nodes[0]?.resultRef, "result:child");
    } finally {
      migrated.close();
    }
  } finally {
    await rm(candidate.temporary, { recursive: true, force: true });
  }
});

test("runtime schema 10 preserves schema 7 graph state and admits bounded concurrency", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-schema8-"));
  const databasePath = join(state, "db", "odinn.sqlite");
  const digest = "d".repeat(64);
  const node = { nodeId: "child", manifestId: "reader", manifestDigest: digest, inputRef: "input:child", inputDigest: digest, resultRef: "result:child", dependsOn: [] };
  try {
    const database = new SqliteStore(databasePath, { targetVersion: 7 });
    const ledger = new RunLedger({ database, artifacts: new ArtifactStore(join(state, "artifacts")), workspaceRoot: state, stateDir: state });
    ledger.ensureRun({ runId: "schema7-parent", objective: "preserve graph" });
    ledger.createAgentGraphRun({ graphRunId: "schema7-graph", parentRunId: "schema7-parent", graphDigest: digest, manifestsDigest: digest, graphBytes: 12, manifestsBytes: 12, principalNamespace: "operator", requestDigest: digest, maxRunMs: 1_000, nodes: [node] });
    ledger.close();

    const migrated = createRunLedger({ stateDir: state, workspaceRoot: state });
    assert.equal(inspectExistingSqliteSchema(databasePath), 10);
    assert.equal(migrated.getAgentGraphRun("schema7-graph")?.maxConcurrency, 1);
    migrated.ensureRun({ runId: "schema8-parent", objective: "parallel graph" });
    migrated.createAgentGraphRun({ graphRunId: "schema8-graph", parentRunId: "schema8-parent", graphDigest: digest, manifestsDigest: digest, graphBytes: 12, manifestsBytes: 12, principalNamespace: "operator", requestDigest: digest, maxConcurrency: 4, maxRunMs: 1_000, nodes: [node] });
    assert.equal(migrated.getAgentGraphRun("schema8-graph")?.maxConcurrency, 4);
    migrated.close();
  } finally {
    await rm(state, { recursive: true, force: true });
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

test("audit-only legacy state plans and applies using the default audit filename", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-state-audit-only-"));
  const state = join(temporary, "state");
  try {
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "audit.jsonl"), `${JSON.stringify({
      schemaVersion: 1,
      at: "2026-07-01T00:08:00.000Z",
      runId: "audit-only-run",
      type: "task.completed",
      actor: "fixture",
      tool: "text.echo"
    })}\n`);
    const plan = await planStateMigration(state, { applicationVersion: "1.1.0-rc.1", applicationCommit: "audit-only" });
    assert.ok(plan.steps.some((step) => step.id === "audit-v0-to-v1"));
    const report = await ensureStateCompatibility(state, { applicationVersion: "1.1.0-rc.1", applicationCommit: "audit-only" });
    assert.ok(report?.steps.some((step) => step.id === "audit-v0-to-v1"));
    assert.ok((await stat(join(state, "db", "audit.sqlite"))).isFile());
    assert.equal(JSON.parse(await readFile(join(state, "state-schema.json"), "utf8")).storeVersions.audit, STATE_SCHEMA_TARGETS.audit);
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
    const plan = await planStateMigration(state, { applicationVersion: "1.0.0", applicationCommit: "cron-v2" });
    assert.equal(plan.rollbackCompatible, false);
    await assert.rejects(
      () => ensureStateCompatibility(state, { applicationVersion: "1.0.0", applicationCommit: "cron-v2" }),
      /cron migration refused legacy job broken/u
    );
    assert.deepEqual(JSON.parse(await readFile(join(state, "cron-jobs.json"), "utf8")), legacy);
    const backupIds = await readdir(join(temporary, "state.backups"));
    assert.equal(backupIds.length, 1);
    const backup = JSON.parse(await readFile(join(temporary, "state.backups", backupIds[0], "state", "cron-jobs.json"), "utf8"));
    assert.deepEqual(backup, legacy);
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
    assert.match(plan.blockingIncompatibilities.join("\n"), /channelBindings schema 99 is newer/u);
    assert.match(plan.blockingIncompatibilities.join("\n"), /channelDedupe schema 99 is newer/u);
    const inspection = await inspectStateSchemas(future.state);
    assert.equal(inspection.healthy, false);
    assert.equal(inspection.currentVersions.channelBindings, 99);
    assert.equal(inspection.currentVersions.channelDedupe, 99);
    const status = await stateLifecycleStatus(future.state);
    assert.equal(status.ok, false);
    assert.equal(status.schemas.find((surface) => surface.surface === "channelBindings")?.healthy, false);
    assert.equal(status.schemas.find((surface) => surface.surface === "channelDedupe")?.healthy, false);
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

test("runtime schema v10 rejects incomplete tables, constraints, foreign keys, migration ledgers, and indexes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-state-malformed-v10-"));
  const state = join(temporary, "state");
  const databasePath = join(state, "db", "odinn.sqlite");
  try {
    await mkdir(dirname(databasePath), { recursive: true });
    const incomplete = new SqliteStore(databasePath, { targetVersion: 9 });
    incomplete.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(10, new Date().toISOString());
    incomplete.close();
    assert.throws(() => inspectExistingSqliteSchema(databasePath), /schema v10 execution_attempts shape is invalid/u);
    assert.throws(() => new SqliteStore(databasePath), /schema v10 execution_attempts shape is invalid/u);
    await assert.rejects(() => inspectStateSchemas(state), /schema v10 execution_attempts shape is invalid/u);
    await assert.rejects(
      () => createStateBackup(state, join(temporary, "rejected-incomplete-v10-backup")),
      /schema v10 execution_attempts shape is invalid/u
    );

    await rm(state, { recursive: true, force: true });
    await mkdir(dirname(databasePath), { recursive: true });
    const malformedStateIndex = new SqliteStore(databasePath);
    malformedStateIndex.db.exec(`DROP INDEX idx_execution_attempts_state;
      CREATE INDEX idx_execution_attempts_state
      ON execution_attempts(created_at, state)`);
    malformedStateIndex.close();
    assert.throws(() => inspectExistingSqliteSchema(databasePath), /execution state index/u);
    assert.throws(() => new SqliteStore(databasePath), /execution state index/u);

    await rm(state, { recursive: true, force: true });
    await mkdir(dirname(databasePath), { recursive: true });
    const malformedIndex = new SqliteStore(databasePath);
    malformedIndex.db.exec(`DROP INDEX idx_execution_attempts_owner;
      CREATE INDEX idx_execution_attempts_owner
      ON execution_attempts(state DESC, owner_pid COLLATE NOCASE, owner_heartbeat_at)`);
    malformedIndex.close();
    assert.throws(() => inspectExistingSqliteSchema(databasePath), /execution owner index/u);
    assert.throws(() => new SqliteStore(databasePath), /execution owner index/u);

    await rm(state, { recursive: true, force: true });
    await mkdir(dirname(databasePath), { recursive: true });
    const unexpectedIndex = new SqliteStore(databasePath);
    unexpectedIndex.db.exec("CREATE INDEX idx_execution_attempts_unexpected ON execution_attempts(owner_token)");
    unexpectedIndex.close();
    assert.throws(() => inspectExistingSqliteSchema(databasePath), /execution attempt index set is invalid/u);
    assert.throws(() => new SqliteStore(databasePath), /execution attempt index set is invalid/u);

    await rm(state, { recursive: true, force: true });
    await mkdir(dirname(databasePath), { recursive: true });
    new SqliteStore(databasePath).close();
    const unconstrained = new DatabaseSync(databasePath);
    unconstrained.exec(`PRAGMA foreign_keys=OFF;
      PRAGMA legacy_alter_table=ON;
      DROP INDEX idx_execution_attempts_owner;
      DROP INDEX idx_execution_attempts_state;
      ALTER TABLE execution_attempts RENAME TO execution_attempts_old;
      CREATE TABLE execution_attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES execution_envelopes(run_id),
        attempt_number INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        settled_at TEXT,
        outcome_digest TEXT,
        error_code TEXT,
        owner_token TEXT,
        owner_pid INTEGER,
        owner_heartbeat_at TEXT,
        owner_released_at TEXT,
        UNIQUE(run_id, attempt_number)
      );
      INSERT INTO execution_attempts SELECT * FROM execution_attempts_old;
      DROP TABLE execution_attempts_old;
      CREATE INDEX idx_execution_attempts_state ON execution_attempts(state, created_at);
      CREATE INDEX idx_execution_attempts_owner ON execution_attempts(state, owner_pid, owner_heartbeat_at);
      PRAGMA foreign_keys=ON;`);
    unconstrained.close();
    assert.throws(() => inspectExistingSqliteSchema(databasePath), /execution_attempts constraints are invalid/u);
    assert.throws(() => new SqliteStore(databasePath), /execution_attempts constraints are invalid/u);
    await assert.rejects(() => inspectStateSchemas(state), /execution_attempts constraints are invalid/u);
    await assert.rejects(
      () => createStateBackup(state, join(temporary, "rejected-unconstrained-v10-backup")),
      /execution_attempts constraints are invalid/u
    );

    await rm(state, { recursive: true, force: true });
    await mkdir(dirname(databasePath), { recursive: true });
    new SqliteStore(databasePath).close();
    const malformedForeignKey = new DatabaseSync(databasePath);
    malformedForeignKey.exec(`PRAGMA foreign_keys=OFF;
      PRAGMA legacy_alter_table=ON;
      DROP INDEX idx_execution_attempts_owner;
      DROP INDEX idx_execution_attempts_state;
      ALTER TABLE execution_attempts RENAME TO execution_attempts_old;
      CREATE TABLE execution_attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES execution_envelopes(run_id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
        state TEXT NOT NULL CHECK(state IN ('proposed', 'admitted', 'queued', 'running', 'awaiting-approval', 'cancelling', 'completed', 'failed', 'cancelled', 'needs-review')),
        created_at TEXT NOT NULL,
        started_at TEXT,
        settled_at TEXT,
        outcome_digest TEXT,
        error_code TEXT,
        owner_token TEXT,
        owner_pid INTEGER,
        owner_heartbeat_at TEXT,
        owner_released_at TEXT,
        UNIQUE(run_id, attempt_number)
      );
      INSERT INTO execution_attempts SELECT * FROM execution_attempts_old;
      DROP TABLE execution_attempts_old;
      CREATE INDEX idx_execution_attempts_state ON execution_attempts(state, created_at);
      CREATE INDEX idx_execution_attempts_owner ON execution_attempts(state, owner_pid, owner_heartbeat_at);
      PRAGMA foreign_keys=ON;`);
    malformedForeignKey.close();
    assert.throws(() => inspectExistingSqliteSchema(databasePath), /execution attempt foreign key is invalid/u);
    assert.throws(() => new SqliteStore(databasePath), /execution attempt foreign key is invalid/u);
    await assert.rejects(() => inspectStateSchemas(state), /execution attempt foreign key is invalid/u);

    await rm(state, { recursive: true, force: true });
    await mkdir(dirname(databasePath), { recursive: true });
    new SqliteStore(databasePath).close();
    const malformedLedger = new DatabaseSync(databasePath);
    malformedLedger.exec(`ALTER TABLE schema_migrations RENAME TO schema_migrations_old;
      CREATE TABLE schema_migrations(version INTEGER, applied_at TEXT);
      INSERT INTO schema_migrations SELECT * FROM schema_migrations_old;
      DROP TABLE schema_migrations_old;`);
    malformedLedger.close();
    assert.throws(() => inspectExistingSqliteSchema(databasePath), /schema_migrations shape is invalid/u);
    assert.throws(() => new SqliteStore(databasePath), /schema_migrations shape is invalid/u);
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
    assert.deepEqual(plan.steps.map((step: any) => step.id), ["records-v0-to-v1", "audit-v0-to-v1", "host-metadata-v0-to-v1"]);
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
