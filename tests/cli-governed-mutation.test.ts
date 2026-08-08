import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDifferentiatedRuntime } from "../packages/kernel/src/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "apps/cli/src/cli.ts");

function invoke(workspace: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, INIT_CWD: workspace }
  });
}

function ensureSuccess(result: ReturnType<typeof invoke>) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
}

async function configureMutationState(state: string) {
  const configPath = join(state, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.experimental = { ...(config.experimental ?? {}), capabilities: true };
  const allowedCapabilities = new Set([
    ...(config.policy?.allowedCapabilities ?? []),
    "workspace.mutate",
    "workspace.patch",
    "restore.create",
    "restore.apply"
  ]);
  config.policy = { ...(config.policy ?? {}), allowedCapabilities: [...allowedCapabilities] };
  await writeFile(configPath, `${JSON.stringify(config)}\n`);
}

function issueCapability(state: string, runId: string, toolName: string) {
  const runtime = createDifferentiatedRuntime({
    workspaceRoot: state,
    stateDir: state,
    featureFlags: { capabilities: true, capsules: false, counterfactual: false }
  });
  try {
    runtime.ledger.ensureRun({ runId, objective: `cli-${toolName}-${runId}` });
    const issued = runtime.capabilities.issue({ runId, stepId: `${runId}-step`, toolName });
    return issued.token;
  } finally {
    runtime.ledger.close();
  }
}

test("CLI workspace mutation and restore command paths are governed and preserve checkpoint semantics", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "odinn-cli-workspace-"));
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-state-"));

  ensureSuccess(invoke(workspace, ["init", "--state", state]));
  await configureMutationState(state);

  const mutateRunId = "cli-mutate-run-preview";
  const mutateApplyRunId = "cli-mutate-run-apply";
  const mutateToken = issueCapability(state, mutateRunId, "workspace.mutate");
  const mutatePreview = ensureSuccess(invoke(workspace, [
    "workspace",
    "mutate",
    "--run",
    mutateRunId,
    "--operation",
    "write",
    "--path",
    "governed.txt",
    "--content",
    "preview",
    "--state",
    state,
    "--capability-token",
    mutateToken
  ]));
  assert.equal(mutatePreview.preview, true);
  assert.equal(mutatePreview.status, "ready");

  const mutateApply = ensureSuccess(invoke(workspace, [
    "workspace",
    "mutate",
    "--run",
    mutateApplyRunId,
    "--operation",
    "write",
    "--path",
    "governed.txt",
    "--content",
    "applied",
    "--apply",
    "--state",
    state,
    "--capability-token",
    issueCapability(state, mutateApplyRunId, "workspace.mutate")
  ]));
  assert.equal(mutateApply.applied, true);
  assert.equal(mutateApply.preview, false);

  const checkpointId = mutateApply.checkpointId ?? mutatePreview.checkpointId;
  assert.equal(typeof checkpointId, "string");

  const preview = ensureSuccess(invoke(workspace, [
    "checkpoint",
    "preview",
    checkpointId,
    "--run",
    "cli-restore-preview-run",
    "--state",
    state,
    "--capability-token",
    issueCapability(state, "cli-restore-preview-run", "restore.create")
  ]));
  assert.equal(preview.status, "ready");
  assert.equal(preview.preview, true);

  const restoreApply = ensureSuccess(invoke(workspace, [
    "checkpoint",
    "apply",
    checkpointId,
    "--checkpoint-manifest-digest",
    preview.manifestDigest,
    "--run",
    "cli-restore-apply-run",
    "--state",
    state,
    "--capability-token",
    issueCapability(state, "cli-restore-apply-run", "restore.apply")
  ]));
  assert.equal(restoreApply.status, "ready");
  assert.equal(restoreApply.applied, true);
  assert.equal(restoreApply.preview, false);
});

test("CLI preview/apply preserve stale-conflict and external-effects semantics", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "odinn-cli-workspace-"));
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-state-"));
  ensureSuccess(invoke(workspace, ["init", "--state", state]));
  await configureMutationState(state);

  const mutateRunId = "cli-mutate-stale";
  const mutation = ensureSuccess(invoke(workspace, [
    "workspace",
    "mutate",
    "--run",
    mutateRunId,
    "--operation",
    "write",
    "--path",
    "seed.txt",
    "--content",
    "initial",
    "--apply",
    "--state",
    state,
    "--capability-token",
    issueCapability(state, mutateRunId, "workspace.mutate")
  ]));
  const checkpointId = mutation.checkpointId;
  assert.equal(typeof checkpointId, "string");

  await writeFile(join(workspace, "seed.txt"), "externally-changed");
  const stale = ensureSuccess(invoke(workspace, [
    "checkpoint",
    "apply",
    checkpointId,
    "--run",
    "cli-restore-stale-run",
    "--state",
    state,
    "--capability-token",
    issueCapability(state, "cli-restore-stale-run", "restore.apply")
  ]));
  assert.equal(stale.status, "conflict");
  assert.equal(stale.preview, true);
  assert.equal(stale.applied, false);
  assert.equal(stale.conflicts.length > 0, true);

  const rewindMissingToken = invoke(workspace, [
    "rewind",
    checkpointId,
    "--run",
    "cli-rewind-preview-run-without-token",
    "--state",
    state
  ]);
  assert.equal(rewindMissingToken.status, 1);
  assert.match(rewindMissingToken.stderr, /capability token required|CAPABILITY_DENIED|capability is not allowed: restore\.create/);

  const rewindPreview = ensureSuccess(invoke(workspace, [
    "rewind",
    checkpointId,
    "--run",
    "cli-rewind-preview-run",
    "--state",
    state,
    "--capability-token",
    issueCapability(state, "cli-rewind-preview-run", "restore.create")
  ]));
  assert.equal(rewindPreview.preview, true);
});

test("CLI cannot bypass capability scoping for workspace.mutate", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "odinn-cli-workspace-"));
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-state-"));
  ensureSuccess(invoke(workspace, ["init", "--state", state]));
  await configureMutationState(state);

  const token = issueCapability(state, "cli-scope-run", "workspace.mutate");
  const blocked = invoke(workspace, [
    "workspace",
    "mutate",
    "--run",
    "different-run",
    "--operation",
    "write",
    "--path",
    "invalid.txt",
    "--content",
    "nope",
    "--state",
    state,
    "--capability-token",
    token
  ]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /CAPABILITY_SCOPE_MISMATCH|capability is not valid for this run or tool|CAPABILITY_DENIED/);
});
