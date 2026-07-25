import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { STATE_SCHEMA_TARGETS } from "../packages/kernel/src/state/schema-registry.ts";
import {
  checkForUpdate,
  rollbackApplication,
  uninstallApplication,
  updateApplication
} from "../apps/cli/src/lifecycle.ts";

const PRIOR_COMMIT = "a".repeat(40);
const NEXT_COMMIT = "b".repeat(40);

async function lifecycleFixture() {
  const temporary = await mkdtemp(join(tmpdir(), "odinn-application-lifecycle-"));
  const prefix = join(temporary, "install");
  const state = join(temporary, "state");
  const priorId = `0.9.0-${PRIOR_COMMIT.slice(0, 12)}`;
  const priorRoot = join(prefix, "versions", priorId);
  await mkdir(state, { recursive: true });
  await writeFile(join(state, "config.json"), "{\"version\":1}\n");
  await writeFile(join(state, "state-schema.json"), `${JSON.stringify({
    schemaVersion: 1,
    applicationVersion: "0.9.0",
    applicationCommit: PRIOR_COMMIT,
    minimumApplicationVersion: "0.9.0",
    storeVersions: STATE_SCHEMA_TARGETS,
    updatedAt: "2026-07-25T00:00:00.000Z"
  }, null, 2)}\n`);
  await writeFakePackage(priorRoot, "0.9.0", PRIOR_COMMIT, { health: true });
  await mkdir(prefix, { recursive: true });
  await writeFile(join(prefix, "install-state.json"), `${JSON.stringify({
    schemaVersion: 1,
    current: priorId,
    currentVersion: "0.9.0",
    currentCommit: PRIOR_COMMIT,
    previous: null,
    operation: "install"
  }, null, 2)}\n`);
  return { temporary, prefix, state, priorId };
}

test("verified local update installs immutably, reports identity, and remains rollbackable", async () => {
  const fixture = await lifecycleFixture();
  try {
    const release = await createRelease(fixture.temporary, "1.0.0", NEXT_COMMIT, { health: true });
    const options = {
      identity: { applicationVersion: "0.9.0", applicationCommit: PRIOR_COMMIT },
      stateDir: fixture.state,
      packageRoot: join(fixture.prefix, "versions", fixture.priorId),
      prefix: fixture.prefix,
      manifest: release.manifest,
      checksums: release.checksums,
      artifact: release.artifact
    };
    const stateBeforeCheck = await readFile(join(fixture.state, "state-schema.json"), "utf8");
    const check = await checkForUpdate(options);
    assert.equal(check.updateAvailable, true);
    assert.equal(check.availableVersion, "1.0.0");
    assert.equal(check.stateMigrationRequired, false);
    assert.ok(check.downloadSize > 0);
    assert.equal(await readFile(join(fixture.state, "state-schema.json"), "utf8"), stateBeforeCheck);

    const updated = await updateApplication(options);
    assert.equal(updated.ok, true);
    assert.equal(updated.version, "1.0.0");
    assert.equal(updated.previousVersionId, fixture.priorId);
    const installed = JSON.parse(await readFile(join(fixture.prefix, "install-state.json"), "utf8"));
    assert.equal(installed.currentVersion, "1.0.0");
    assert.equal(installed.previous, fixture.priorId);

    const rolledBack = await rollbackApplication({
      identity: { applicationVersion: "1.0.0", applicationCommit: NEXT_COMMIT },
      stateDir: fixture.state,
      packageRoot: join(fixture.prefix, "versions", installed.current),
      prefix: fixture.prefix
    });
    assert.equal(rolledBack.version, "0.9.0");
    assert.equal(rolledBack.versionId, fixture.priorId);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("update check follows semantic prerelease ordering", async () => {
  const fixture = await lifecycleFixture();
  try {
    const release = await createRelease(fixture.temporary, "1.0.0-rc.10", NEXT_COMMIT, { health: true });
    const check = await checkForUpdate({
      identity: { applicationVersion: "1.0.0-rc.2", applicationCommit: PRIOR_COMMIT },
      stateDir: fixture.state,
      packageRoot: join(fixture.prefix, "versions", fixture.priorId),
      prefix: fixture.prefix,
      manifest: release.manifest,
      checksums: release.checksums,
      artifact: release.artifact
    });
    assert.equal(check.updateAvailable, true);
    assert.equal(check.availableReleaseChannel, "local");
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("failed post-update health restores the previous application pointer", async () => {
  const fixture = await lifecycleFixture();
  try {
    const release = await createRelease(fixture.temporary, "1.0.0", NEXT_COMMIT, { health: false });
    await assert.rejects(() => updateApplication({
      identity: { applicationVersion: "0.9.0", applicationCommit: PRIOR_COMMIT },
      stateDir: fixture.state,
      packageRoot: join(fixture.prefix, "versions", fixture.priorId),
      prefix: fixture.prefix,
      manifest: release.manifest,
      checksums: release.checksums,
      artifact: release.artifact
    }), /post-update health check failed/u);
    const installed = JSON.parse(await readFile(join(fixture.prefix, "install-state.json"), "utf8"));
    assert.equal(installed.current, fixture.priorId);
    assert.equal(installed.currentVersion, "0.9.0");
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("migration-required update restores the complete pre-update state after health failure", async () => {
  const fixture = await lifecycleFixture();
  try {
    const originalConfig = await readFile(join(fixture.state, "config.json"), "utf8");
    await writeFile(join(fixture.state, "gateway.token"), "private-token\n");
    const release = await createRelease(fixture.temporary, "1.0.0", NEXT_COMMIT, {
      health: false,
      migration: true,
      mutateStateBeforeHealthFailure: true
    });
    await assert.rejects(() => updateApplication({
      identity: { applicationVersion: "0.9.0", applicationCommit: PRIOR_COMMIT },
      stateDir: fixture.state,
      packageRoot: join(fixture.prefix, "versions", fixture.priorId),
      prefix: fixture.prefix,
      manifest: release.manifest,
      checksums: release.checksums,
      artifact: release.artifact
    }), /post-update health check failed/u);
    assert.equal(await readFile(join(fixture.state, "config.json"), "utf8"), originalConfig);
    assert.equal(await readFile(join(fixture.state, "gateway.token"), "utf8"), "private-token\n");
    const history = (await readFile(join(fixture.prefix, "lifecycle-history.jsonl"), "utf8"))
      .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.equal(history.at(-1).status, "failed");
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("update rejects checksum disagreement before installing files", async () => {
  const fixture = await lifecycleFixture();
  try {
    const release = await createRelease(fixture.temporary, "1.0.0", NEXT_COMMIT, { health: true });
    await writeFile(release.checksums, `${"0".repeat(64)}  ${basename(release.artifact)}\n`);
    await assert.rejects(() => updateApplication({
      identity: { applicationVersion: "0.9.0", applicationCommit: PRIOR_COMMIT },
      stateDir: fixture.state,
      packageRoot: join(fixture.prefix, "versions", fixture.priorId),
      prefix: fixture.prefix,
      manifest: release.manifest,
      checksums: release.checksums,
      artifact: release.artifact
    }), /artifact checksum mismatch/u);
    const installed = JSON.parse(await readFile(join(fixture.prefix, "install-state.json"), "utf8"));
    assert.equal(installed.current, fixture.priorId);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("update rejects archive traversal before extraction", { skip: process.platform !== "linux" }, async () => {
  const fixture = await lifecycleFixture();
  try {
    const release = await createRelease(fixture.temporary, "1.0.0", NEXT_COMMIT, { health: true });
    const releaseRoot = join(fixture.temporary, "release-1.0.0-healthy");
    run("tar", [
      "--transform",
      "s,^,../,",
      "-czf",
      release.artifact,
      "-C",
      releaseRoot,
      "odinn-v1.0.0"
    ], releaseRoot);
    const digest = createHash("sha256").update(await readFile(release.artifact)).digest("hex");
    const manifest = JSON.parse(await readFile(release.manifest, "utf8"));
    manifest.archiveSha256[basename(release.artifact)] = digest;
    await writeFile(release.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(release.checksums, `${digest}  ${basename(release.artifact)}\n`);
    await assert.rejects(() => updateApplication({
      identity: { applicationVersion: "0.9.0", applicationCommit: PRIOR_COMMIT },
      stateDir: fixture.state,
      packageRoot: join(fixture.prefix, "versions", fixture.priorId),
      prefix: fixture.prefix,
      manifest: release.manifest,
      checksums: release.checksums,
      artifact: release.artifact
    }), /unsafe path/u);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("rollback refuses an application that cannot read current state", async () => {
  const fixture = await lifecycleFixture();
  try {
    const nextId = `1.0.0-${NEXT_COMMIT.slice(0, 12)}`;
    await writeFakePackage(join(fixture.prefix, "versions", nextId), "1.0.0", NEXT_COMMIT, { health: true });
    await writeFile(join(fixture.prefix, "install-state.json"), `${JSON.stringify({
      schemaVersion: 1,
      current: nextId,
      currentVersion: "1.0.0",
      currentCommit: NEXT_COMMIT,
      previous: fixture.priorId,
      operation: "upgrade"
    }, null, 2)}\n`);
    const stateMetadata = JSON.parse(await readFile(join(fixture.state, "state-schema.json"), "utf8"));
    stateMetadata.minimumApplicationVersion = "1.0.0";
    await writeFile(join(fixture.state, "state-schema.json"), `${JSON.stringify(stateMetadata, null, 2)}\n`);
    await assert.rejects(() => rollbackApplication({
      identity: { applicationVersion: "1.0.0", applicationCommit: NEXT_COMMIT },
      stateDir: fixture.state,
      packageRoot: join(fixture.prefix, "versions", nextId),
      prefix: fixture.prefix
    }), /rollback refused: state requires Odinn 1\.0\.0 or newer/u);
    const installed = JSON.parse(await readFile(join(fixture.prefix, "install-state.json"), "utf8"));
    assert.equal(installed.current, nextId);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("uninstall preserves state by default and requires explicit destructive confirmation", async () => {
  const fixture = await lifecycleFixture();
  try {
    const preserved = await uninstallApplication({ prefix: fixture.prefix, stateDir: fixture.state });
    assert.equal(preserved.stateRemoved, false);
    assert.equal(await readFile(join(fixture.state, "config.json"), "utf8"), "{\"version\":1}\n");
    await assert.rejects(() => uninstallApplication({
      prefix: fixture.prefix,
      stateDir: fixture.state,
      removeState: true
    }), /requires --confirm or --force/u);
    const removed = await uninstallApplication({
      prefix: fixture.prefix,
      stateDir: fixture.state,
      removeState: true,
      force: true
    });
    assert.equal(removed.stateRemoved, true);
    await assert.rejects(() => readFile(join(fixture.state, "config.json"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("uninstall refuses a symlinked installation prefix", { skip: process.platform === "win32" }, async () => {
  const fixture = await lifecycleFixture();
  const linkedPrefix = join(fixture.temporary, "linked-install");
  try {
    await symlink(fixture.prefix, linkedPrefix, "dir");
    await assert.rejects(() => uninstallApplication({
      prefix: linkedPrefix,
      stateDir: fixture.state
    }), /install prefix must be a physical directory/u);
    assert.equal(JSON.parse(await readFile(join(fixture.prefix, "install-state.json"), "utf8")).current, fixture.priorId);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

async function createRelease(
  temporary: string,
  version: string,
  commit: string,
  options: { health: boolean; migration?: boolean; mutateStateBeforeHealthFailure?: boolean }
) {
  const releases = join(temporary, `release-${version}-${options.health ? "healthy" : "failed"}`);
  const packageRoot = join(releases, `odinn-v${version}`);
  await writeFakePackage(packageRoot, version, commit, options);
  const artifactName = process.platform === "win32" ? `odinn-v${version}.zip` : `odinn-v${version}.tar.gz`;
  const artifact = join(releases, artifactName);
  if (process.platform === "win32") {
    const command = `Compress-Archive -LiteralPath '${packageRoot.replaceAll("'", "''")}' -DestinationPath '${artifact.replaceAll("'", "''")}' -Force`;
    run("powershell", ["-NoProfile", "-Command", command], releases);
  } else {
    run("tar", ["-czf", artifact, "-C", releases, basename(packageRoot)], releases);
  }
  const digest = createHash("sha256").update(await readFile(artifact)).digest("hex");
  const runtimeSha256 = "c".repeat(64);
  const manifest = join(releases, "release-manifest.json");
  await writeFile(manifest, `${JSON.stringify({
    name: "odinn",
    version,
    commit,
    distribution: "compiled",
    runtimeSha256,
    artifacts: [artifactName],
    archiveSha256: { [artifactName]: digest },
    stateSchemas: STATE_SCHEMA_TARGETS,
    minimumApplicationVersionForTargetState: "0.9.0"
  }, null, 2)}\n`);
  const checksums = join(releases, "SHA256SUMS.txt");
  await writeFile(checksums, `${digest}  ${artifactName}\n`);
  return { artifact, manifest, checksums };
}

async function writeFakePackage(
  root: string,
  version: string,
  commit: string,
  options: { health: boolean; migration?: boolean; mutateStateBeforeHealthFailure?: boolean }
) {
  await mkdir(join(root, "dist", "cli"), { recursive: true });
  await mkdir(join(root, "dist", "gateway"), { recursive: true });
  await mkdir(join(root, "dist", "install"), { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "odinn", version, type: "module" }, null, 2)}\n`);
  await writeFile(join(root, "release-info.json"), `${JSON.stringify({
    schemaVersion: 2,
    name: "odinn",
    version,
    commit,
    distribution: "compiled",
    runtimeSha256: "c".repeat(64)
  }, null, 2)}\n`);
  const cli = `import{writeFileSync}from"node:fs";import{join}from"node:path";const args=process.argv.slice(2);if(args[0]==="--version"){console.log(${JSON.stringify(version)});}else if(args[0]==="state"&&args[1]==="migrate"){console.log(JSON.stringify({steps:${options.migration ? "[{id:'test-migration'}]" : "[]"},blockingIncompatibilities:[]}));}else if(args[0]==="doctor"){${options.mutateStateBeforeHealthFailure ? 'const index=args.indexOf("--state");writeFileSync(join(args[index+1],"config.json"),"{invalid\\n");' : ""}console.log(JSON.stringify({ok:${String(options.health)}}));}else{console.error("unsupported fake CLI command");process.exitCode=1;}\n`;
  await writeFile(join(root, "dist", "cli", "index.js"), cli);
  await writeFile(join(root, "dist", "gateway", "server.js"), "export {};\n");
  await writeFile(join(root, "dist", "install", "install.js"), FAKE_INSTALLER);
  await chmod(join(root, "dist", "install", "install.js"), 0o755);
  await writeFile(join(root, "install-metadata.json"), `${JSON.stringify({
    schemaVersion: 2,
    version,
    commit,
    runtimeSha256: "c".repeat(64),
    artifactSha256: "unknown",
    toolchain: { node: process.version, distribution: "compiled" }
  }, null, 2)}\n`);
}

const FAKE_INSTALLER = `
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
const [command,...args]=process.argv.slice(2);
const option=(name)=>{const index=args.indexOf(name);return index>=0?args[index+1]:"";};
const prefix=option("--prefix");
const statePath=join(prefix,"install-state.json");
const readState=async()=>{try{return JSON.parse(await readFile(statePath,"utf8"));}catch(error){if(error.code==="ENOENT")return{schemaVersion:1,current:null,previous:null};throw error;}};
const writeState=async(value)=>{await mkdir(prefix,{recursive:true});const temporary=statePath+".tmp";await writeFile(temporary,JSON.stringify(value,null,2)+"\\n");await rename(temporary,statePath);};
if(command==="upgrade"||command==="install"){
  const source=option("--source");
  const pkg=JSON.parse(await readFile(join(source,"package.json"),"utf8"));
  const info=JSON.parse(await readFile(join(source,"release-info.json"),"utf8"));
  const id=pkg.version+"-"+info.commit.slice(0,12);
  const destination=join(prefix,"versions",id);
  await mkdir(join(prefix,"versions"),{recursive:true});
  try{await cp(source,destination,{recursive:true,errorOnExist:true,force:false});}catch(error){if(error.code!=="ERR_FS_CP_EEXIST"&&error.code!=="EEXIST")throw error;}
  await writeFile(join(destination,"install-metadata.json"),JSON.stringify({schemaVersion:2,version:pkg.version,commit:info.commit,runtimeSha256:info.runtimeSha256,artifactSha256:option("--artifact-sha256"),toolchain:{node:process.version,distribution:"compiled"}},null,2)+"\\n");
  const previous=await readState();
  await writeState({schemaVersion:1,current:id,currentVersion:pkg.version,currentCommit:info.commit,previous:previous.current&&previous.current!==id?previous.current:previous.previous??null,operation:command});
}else if(command==="rollback"){
  const current=await readState();
  if(!current.previous)throw new Error("no previous");
  const metadata=JSON.parse(await readFile(join(prefix,"versions",current.previous,"install-metadata.json"),"utf8"));
  await writeState({...current,current:current.previous,currentVersion:metadata.version,currentCommit:metadata.commit,previous:current.current,operation:"rollback"});
}else{throw new Error("unsupported fake installer command");}
`;

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
