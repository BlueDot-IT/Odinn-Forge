import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createStateBackup,
  createApprovalStore,
  ensureStateCompatibility,
  inspectStateBackup,
  restoreStateBackup,
  stateLifecycleStatus
} from "../packages/kernel/src/index.ts";
import { migrateLegacyRecordsToSqlite, SqliteRecordStore } from "../packages/store-sqlite/src/authoritative.ts";
import { SqliteAuditStore } from "../packages/store-sqlite/src/audit.ts";

async function preparedState() {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-state-lifecycle-"));
  const state = join(temporary, "state");
  await mkdir(state);
  await writeFile(join(state, "config.json"), `${JSON.stringify({ version: 1, auditLog: "audit.jsonl" })}\n`);
  await writeFile(join(state, "records.jsonl"), `${JSON.stringify({
    version: 1,
    id: "memory_1",
    type: "memory.fact",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    data: { text: "keep me" }
  })}\n`);
  await writeFile(join(state, "jobs.json"), `${JSON.stringify({ schemaVersion: 1, jobs: {} })}\n`);
  await writeFile(join(state, "approvals.json"), `${JSON.stringify({ schemaVersion: 1, approvals: [] })}\n`);
  await writeFile(join(state, "browser-recovery.json"), `${JSON.stringify({ schemaVersion: 1, status: "clear" })}\n`);
  await writeFile(join(state, "audit.jsonl"), "");
  await ensureStateCompatibility(state, { applicationVersion: "1.0.0", applicationCommit: "test-commit" });
  return { temporary, state };
}

test("normal backup is checksummed and excludes credentials while preserving stable state", async () => {
  const fixture = await preparedState();
  const backup = join(fixture.temporary, "backup");
  try {
    await mkdir(join(fixture.state, "oauth"));
    await mkdir(join(fixture.state, "browser-profile"));
    await mkdir(join(fixture.state, "credentials"));
    await writeFile(join(fixture.state, "oauth", "openai.json"), "{\"access_token\":\"do-not-copy\"}\n");
    const config = JSON.parse(await readFile(join(fixture.state, "config.json"), "utf8"));
    config.providers = { custom: { auth: { mode: "oauth", tokenFile: "credentials/custom-oauth.json" } } };
    await writeFile(join(fixture.state, "config.json"), `${JSON.stringify(config)}\n`);
    await writeFile(join(fixture.state, "credentials", "custom-oauth.json"), "{\"access_token\":\"do-not-copy\"}\n");
    await writeFile(join(fixture.state, "browser-profile", "Cookies"), "do-not-copy\n");
    await writeFile(join(fixture.state, "gateway.token"), "do-not-copy\n");
    await writeFile(join(fixture.state, "capability-signing.key"), "do-not-copy\n");
    const approvalSecret = "do-not-copy-process-command";
    createApprovalStore({ path: join(fixture.state, "approvals.json") }).create({
      tool: "process.exec",
      runId: "backup-secret",
      input: { command: approvalSecret, args: ["private-argument"] }
    });
    await mkdir(join(fixture.state, "bundles", "sha256", "bundle"), { recursive: true });
    await writeFile(join(fixture.state, "bundles", "sha256", "bundle", "workspace-secret.txt"), "workspace-secret-must-not-copy\n");
    await mkdir(join(fixture.state, "db"), { recursive: true });
    for (const sidecar of ["custom-audit.sqlite-wal", "custom-audit.sqlite-shm", "custom-audit.sqlite.notify"]) {
      await writeFile(join(fixture.state, "db", sidecar), "ephemeral\n");
    }

    const created = await createStateBackup(fixture.state, backup, {
      applicationVersion: "1.0.0",
      applicationCommit: "test-commit"
    });
    assert.equal(created.manifest.includesSensitiveState, false);
    assert.ok(created.manifest.files.some((file) => file.path === "records.jsonl"));
    assert.ok(created.manifest.files.some((file) => file.path === "audit.jsonl.keys.json"));
    for (const forbidden of ["oauth/openai.json", "credentials/custom-oauth.json", "browser-profile/Cookies", "gateway.token", "capability-signing.key", "approvals.json", "approvals.json.key", "bundles/sha256/bundle/workspace-secret.txt"]) {
      assert.equal(created.manifest.files.some((file) => file.path === forbidden), false);
    }
    assert.equal(created.manifest.files.some((file) => /^db\/custom-audit\.sqlite(?:-(?:wal|shm)|\.notify)$/u.test(file.path)), false);
    for (const sidecar of ["custom-audit.sqlite-wal", "custom-audit.sqlite-shm", "custom-audit.sqlite.notify", "audit.sqlite.notify"]) {
      await assert.rejects(access(join(backup, "db", sidecar)), { code: "ENOENT" });
    }
    assert.ok(created.manifest.excluded.includes("credentials/custom-oauth.json"));
    assert.ok(created.manifest.excluded.includes("approvals.json"));
    assert.ok(created.manifest.excluded.includes("approvals.json.key"));
    assert.ok(created.manifest.excluded.includes("bundles/"));
    assert.doesNotMatch(JSON.stringify(created), /do-not-copy|workspace-secret-must-not-copy|private-argument/u);
    const inspected = await inspectStateBackup(backup);
    assert.equal(inspected.valid, true);
    assert.equal(inspected.manifest.sourceApplication.version, "1.0.0");
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("backup inspection rejects an unmanifested excluded sidecar", async () => {
  const fixture = await preparedState();
  const backup = join(fixture.temporary, "unmanifested-sidecar-backup");
  try {
    await createStateBackup(fixture.state, backup);
    await mkdir(join(backup, "db"), { recursive: true });
    await writeFile(join(backup, "db", "audit.sqlite.notify"), "unexpected\n");
    await assert.rejects(() => inspectStateBackup(backup), /backup contents do not match the manifest/u);
    await rm(join(backup, "db", "audit.sqlite.notify"));
    await mkdir(join(backup, "unexpected-empty-directory"));
    await assert.rejects(() => inspectStateBackup(backup), /backup contents do not match the manifest/u);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("legacy Chromium profile links are excluded while arbitrary state links remain forbidden", { skip: process.platform === "win32" }, async () => {
  const fixture = await preparedState();
  const outside = join(fixture.temporary, "chromium-runtime");
  try {
    await mkdir(outside);
    const legacyProfile = join(fixture.state, "browser-profile");
    await mkdir(legacyProfile);
    for (const link of ["RunningChromeVersion", "SingletonSocket", "SingletonCookie", "SingletonLock"]) {
      await symlink(outside, join(legacyProfile, link));
    }
    const backup = join(fixture.temporary, "legacy-browser-backup");
    const created = await createStateBackup(fixture.state, backup);
    assert.equal(created.manifest.files.some((file) => file.path.startsWith("browser-profile/")), false);

    await rm(legacyProfile, { recursive: true, force: true });
    await symlink(outside, legacyProfile);
    await assert.rejects(
      () => createStateBackup(fixture.state, join(fixture.temporary, "rejected-profile-root-backup")),
      /invalid legacy browser profile root/u
    );
    await rm(legacyProfile);
    await symlink(outside, join(fixture.state, "unexpected-link"));
    await assert.rejects(
      () => createStateBackup(fixture.state, join(fixture.temporary, "rejected-link-backup")),
      /state contains a symbolic link: unexpected-link/u
    );
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("backup tampering and future schemas fail before restore", async () => {
  const fixture = await preparedState();
  const backup = join(fixture.temporary, "backup");
  try {
    await createStateBackup(fixture.state, backup);
    await writeFile(join(backup, "records.jsonl"), "tampered\n");
    await assert.rejects(() => inspectStateBackup(backup), /checksum mismatch/u);

    const manifestPath = join(backup, "backup-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const records = manifest.files.find((file: { path: string }) => file.path === "records.jsonl");
    const content = await readFile(join(backup, "records.jsonl"));
    records.bytes = content.byteLength;
    records.sha256 = createHash("sha256").update(content).digest("hex");
    manifest.stateSchemas.config = 999;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(() => inspectStateBackup(backup), /future config schema/u);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("backup inspection rejects protected approval and bundle payloads", async () => {
  const fixture = await preparedState();
  const backup = join(fixture.temporary, "protected-state-backup");
  try {
    await createStateBackup(fixture.state, backup);
    const protectedContent = `${JSON.stringify({ schemaVersion: 1, approvals: [] })}\n`;
    await writeFile(join(backup, "approvals.json"), protectedContent);
    const manifestPath = join(backup, "backup-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files.push({
      path: "approvals.json",
      bytes: Buffer.byteLength(protectedContent),
      sha256: createHash("sha256").update(protectedContent).digest("hex")
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(() => inspectStateBackup(backup), /protected ephemeral state/u);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("backup refuses a corrupt authoritative SQLite audit journal", async () => {
  const fixture = await preparedState(); const backup = join(fixture.temporary, "corrupt-audit-backup"); const auditPath = join(fixture.state, "db", "audit.sqlite");
  try {
    const store = new SqliteAuditStore(auditPath, { keyringPath: join(fixture.state, "audit.jsonl.keys.json") }); await store.append({ at: new Date().toISOString(), runId: "corrupt-audit", type: "task.started", actor: "test" }); store.db.prepare("UPDATE audit_events SET event_json=? WHERE sequence=1").run(JSON.stringify({ at: new Date().toISOString(), runId: "tampered", type: "task.started", actor: "test" })); store.close();
    await assert.rejects(createStateBackup(fixture.state, backup), /(?:active state is unhealthy|staged audit snapshot is inconsistent)/u);
  } finally { await rm(fixture.temporary, { recursive: true, force: true }); }
});

test("backup refuses while sandbox cleanup recovery is pending", async () => {
  const fixture = await preparedState();
  try {
    await writeFile(join(fixture.state, "sandbox-recovery.json"), `${JSON.stringify({
      schemaVersion: 1,
      namespaceId: `sbx_${"a".repeat(36)}`,
      pending: [{ executionId: `sbxexec_${"b".repeat(32)}` }]
    })}\n`, { mode: 0o600 });
    await assert.rejects(createStateBackup(fixture.state, join(fixture.temporary, "blocked-backup")), /sandbox cleanup recovery is pending/u);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("restore and migration refuse pending sandbox recovery even when current backup is skipped", async () => {
  const fixture = await preparedState();
  const backup = join(fixture.temporary, "pre-recovery-backup");
  try {
    await createStateBackup(fixture.state, backup);
    await writeFile(join(fixture.state, "sandbox-recovery.json"), `${JSON.stringify({
      schemaVersion: 1,
      namespaceId: `sbx_${"a".repeat(36)}`,
      pending: [{ executionId: `sbxexec_${"b".repeat(32)}` }]
    })}\n`, { mode: 0o600 });
    await assert.rejects(
      restoreStateBackup(backup, fixture.state, { skipCurrentBackup: true }),
      /restore refused while sandbox cleanup recovery is pending/u
    );
    await assert.rejects(
      ensureStateCompatibility(fixture.state),
      /migration refused while sandbox cleanup recovery is pending/u
    );
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("restore verifies into staging, backs up current state, and activates atomically", async () => {
  const fixture = await preparedState();
  const backup = join(fixture.temporary, "backup");
  try {
    await createStateBackup(fixture.state, backup, {
      applicationVersion: "1.0.0",
      applicationCommit: "backup-commit"
    });
    await writeFile(join(fixture.state, "records.jsonl"), "{\"changed\":true}\n");
    const restored = await restoreStateBackup(backup, fixture.state, {
      applicationVersion: "1.0.1",
      applicationCommit: "restore-commit"
    });
    assert.equal(restored.ok, true);
    assert.ok(restored.preRestoreBackup);
    assert.match(await readFile(join(fixture.state, "records.jsonl"), "utf8"), /keep me/u);
    assert.equal((await inspectStateBackup(restored.preRestoreBackup!)).manifest.includesSensitiveState, true);
    const status = await stateLifecycleStatus(fixture.state);
    assert.equal(status.ok, true);
    assert.equal(status.pendingMigration, false);
    assert.equal(status.compatibility.minimumApplicationVersion, "0.4.0");
    assert.ok(status.audit.events >= 1);
    assert.ok(status.backups.available >= 1);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("Windows restore hardens the activated state tree and reports owner-only status", { skip: process.platform !== "win32" }, async () => {
  const fixture = await preparedState();
  const backup = join(fixture.temporary, "windows-backup");
  try {
    await createStateBackup(fixture.state, backup, { applicationVersion: "1.0.0", applicationCommit: "windows-backup" });
    const restored = await restoreStateBackup(backup, fixture.state, { applicationVersion: "1.0.1", applicationCommit: "windows-restore" });
    assert.equal(restored.ok, true);
    const status = await stateLifecycleStatus(fixture.state);
    assert.equal(status.ok, true);
    assert.equal(status.stateDirectory.ownerOnly, true);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("backup snapshots and restores the authoritative record database without WAL sidecars", async () => {
  const fixture = await preparedState();
  const backup = join(fixture.temporary, "sqlite-backup");
  const legacyPath = join(fixture.state, "records.jsonl");
  const databasePath = join(fixture.state, "db", "records.sqlite");
  try {
    migrateLegacyRecordsToSqlite({ legacyPath, databasePath });
    const created = await createStateBackup(fixture.state, backup, { applicationVersion: "1.0.0", applicationCommit: "sqlite-records" });
    assert.ok(created.manifest.files.some((file) => file.path === "db/records.sqlite"));
    assert.equal(created.manifest.files.some((file) => /db\/records\.sqlite-(?:wal|shm)$/u.test(file.path)), false);
    const backupStore = new SqliteRecordStore(join(backup, "db", "records.sqlite"));
    try {
      assert.equal(await backupStore.countRecords(), 1);
    } finally {
      backupStore.close();
    }
    const liveStore = new SqliteRecordStore(databasePath);
    try {
      await liveStore.append({ id: "memory-2", type: "memory", status: "active", namespace: "tests/backup", text: "newer" });
      assert.equal(await liveStore.countRecords(), 2);
    } finally {
      liveStore.close();
    }
    await restoreStateBackup(backup, fixture.state, { applicationVersion: "1.0.1", applicationCommit: "sqlite-restore" });
    const restoredStore = new SqliteRecordStore(databasePath);
    try {
      assert.equal(await restoredStore.countRecords(), 1);
    } finally {
      restoredStore.close();
    }
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("backup refuses a symlinked destination parent", { skip: process.platform === "win32" }, async () => {
  const fixture = await preparedState();
  const outside = join(fixture.temporary, "outside");
  const linked = join(fixture.temporary, "linked-backups");
  try {
    await mkdir(outside);
    await symlink(outside, linked, "dir");
    await assert.rejects(
      () => createStateBackup(fixture.state, join(linked, "backup")),
      /backup destination parent must be a physical directory/u
    );
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("state status reports corruption and interrupted migration without exposing raw state", async () => {
  const fixture = await preparedState();
  try {
    await writeFile(join(fixture.state, "config.json"), "{\"apiKey\":\"never-print-me\"\n");
    await writeFile(
      join(fixture.temporary, ".state.migration-in-progress.json"),
      "{\"schemaVersion\":1}\n"
    );
    const status = await stateLifecycleStatus(fixture.state);
    assert.equal(status.ok, false);
    assert.equal(status.stateDirectory.healthy, false);
    assert.ok(status.warnings.some((warning) => /JSON|inspection|config/iu.test(warning)));
    assert.ok(status.warnings.some((warning) => /interrupted state migration/iu.test(warning)));
    assert.doesNotMatch(JSON.stringify(status), /never-print-me/u);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});
