import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAuditStore, createBuiltInRegistry, createDifferentiatedRuntime, runTask } from "../packages/kernel/src/index.ts";
import { createDefaultPolicy } from "../packages/policy/src/index.ts";
import { createRunLedger } from "../packages/kernel/src/run-ledger.ts";
import { existsSync } from "node:fs";

function withTempRoot() {
  return mkdtemp(join(tmpdir(), "odinn-stage5-admission-"));
}


test("governed mutation and restore tools are registered; legacy workspace.writeText is unavailable", async () => {
  const root = await withTempRoot();
  const registry = createBuiltInRegistry({ workspaceRoot: root });
  assert.equal(registry.has("workspace.mutate"), true);
  assert.equal(registry.has("workspace.patch"), true);
  assert.equal(registry.has("restore.create"), true);
  assert.equal(registry.has("restore.apply"), true);
  assert.equal(registry.has("snapshot.create"), true);
  assert.equal(registry.has("snapshot.restore"), true);
  assert.equal(registry.has("workspace.writeText"), false);
});

test("workspace.mutate requires capability/policy admission and rejects model-declared authority overrides", async () => {
  const root = await withTempRoot();
  const state = join(root, ".odinn");
  const auditStore = createAuditStore(join(state, "audit.jsonl"));
  const runtime = createDifferentiatedRuntime({ workspaceRoot: root, stateDir: state, featureFlags: { capabilities: true, counterfactual: false, capsules: false } });

  try {
    runtime.ledger.ensureRun({ runId: "mutate-no-token", objective: "mutation denied without token" });
    const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir: state, auditStore, config: { runLedger: runtime.ledger } });
    const policy = createDefaultPolicy({ allowedCapabilities: ["job.healthcheck", "text.echo", "workspace.mutate", "workspace.patch", "restore.create", "restore.apply"] });

    await assert.rejects(
      runTask({
        task: { id: "mutate-no-token", tool: "workspace.mutate", input: { operation: "write", path: "seed.txt", content: "value" } },
        auditStore,
        policy,
        registry,
        runLedger: runtime.ledger
      }),
      /CAPABILITY_DENIED|capability token required/
    );

    runtime.ledger.ensureRun({ runId: "mutate-by-model-declared", objective: "model-declared capability is ignored" });
    const overrideToken = runtime.capabilities.issue({ runId: "mutate-by-model-declared", stepId: "declared-step", toolName: "text.echo" });
    await assert.rejects(
      runTask({
        task: {
          id: "mutate-by-model-declared",
          tool: "text.echo",
          input: { text: "ignored", capabilityToken: overrideToken?.token },
          capability: "workspace.mutate",
        },
        auditStore,
        policy: createDefaultPolicy({ allowedCapabilities: ["workspace.mutate"] }),
        registry,
        runLedger: runtime.ledger
      }),
      /CAPABILITY_DENIED|POLICY_VIOLATION|capability is not allowed: (?:text\.echo|workspace\.inspect)/
    );

    runtime.ledger.ensureRun({ runId: "mutate-with-token", objective: "mutation allowed with token" });
    const issued = runtime.capabilities.issue({ runId: "mutate-with-token", stepId: "mutation-step", toolName: "workspace.mutate" });
    const tokenized = await runTask({
      task: { id: "mutate-with-token", tool: "workspace.mutate", input: { operation: "write", path: "seed.txt", content: "value", apply: false, capabilityToken: issued.token } },
      auditStore,
      policy,
      registry,
      runLedger: runtime.ledger
    });
    assert.equal(tokenized.output.status, "ready");
    assert.equal(existsSync(join(root, "seed.txt")), false);
  } finally {
    runtime.ledger.close();
    await rm(state, { recursive: true, force: true });
  }
});

test("capability resource constraints bind to the canonical workspace mutation target", async () => {
  const root = await withTempRoot();
  const state = join(root, ".odinn");
  const auditStore = createAuditStore(join(state, "audit.jsonl"));
  const runtime = createDifferentiatedRuntime({ workspaceRoot: root, stateDir: state, featureFlags: { capabilities: true, counterfactual: false, capsules: false } });
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir: state, auditStore, config: { runLedger: runtime.ledger } });

  try {
    const runId = "mutation-resource-mismatch";
    runtime.ledger.ensureRun({ runId, objective: "reject a mismatched mutation target" });
    const issued = runtime.capabilities.issue({
      runId,
      stepId: "mutation-step",
      toolName: "workspace.mutate",
      resourceConstraints: { path: "safe.txt" }
    });
    await assert.rejects(
      runTask({
        task: {
          id: runId,
          tool: "workspace.mutate",
          input: { operation: "write", path: "evil.txt", content: "must not publish", capabilityToken: issued.token }
        },
        auditStore,
        policy: createDefaultPolicy({ allowedCapabilities: ["workspace.mutate"] }),
        registry,
        runLedger: runtime.ledger
      }),
      (error: any) => error.code === "CAPABILITY_SCOPE_MISMATCH"
    );
    assert.equal(existsSync(join(root, "evil.txt")), false);
  } finally {
    registry.close();
    auditStore.close();
    runtime.ledger.close();
    await rm(state, { recursive: true, force: true });
  }
});

test("mutation payloads are projected before durable audit and execution artifacts", async () => {
  const root = await withTempRoot();
  const state = join(root, ".odinn");
  const auditStore = createAuditStore(join(state, "audit.jsonl"));
  const runtime = createDifferentiatedRuntime({ workspaceRoot: root, stateDir: state, featureFlags: { capabilities: true, counterfactual: false, capsules: false } });
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir: state, auditStore, config: { runLedger: runtime.ledger } });
  const policy = createDefaultPolicy({ allowedCapabilities: ["workspace.mutate", "workspace.patch"] });
  const contentSecret = "private-mutation-content-7f43";
  const findSecret = "opaque-find-value-2c91";
  const replaceSecret = "opaque-replace-value-8a06";

  try {
    await writeFile(join(root, "seed.txt"), `${findSecret} ${findSecret}`);
    const mutationRunId = "mutation-durable-redaction";
    runtime.ledger.ensureRun({ runId: mutationRunId, objective: "project mutation content" });
    const mutationToken = runtime.capabilities.issue({ runId: mutationRunId, stepId: "mutation-step", toolName: "workspace.mutate" });
    await runTask({
      task: {
        id: mutationRunId,
        tool: "workspace.mutate",
        input: { operation: "write", path: "new.txt", content: contentSecret, capabilityToken: mutationToken.token }
      },
      auditStore,
      policy,
      registry,
      runLedger: runtime.ledger
    });

    const patchRunId = "patch-durable-redaction";
    runtime.ledger.ensureRun({ runId: patchRunId, objective: "project patch content" });
    const patchToken = runtime.capabilities.issue({ runId: patchRunId, stepId: "patch-step", toolName: "workspace.patch" });
    await runTask({
      task: {
        id: patchRunId,
        tool: "workspace.patch",
        input: { operation: "edit", path: "seed.txt", find: findSecret, replace: replaceSecret, capabilityToken: patchToken.token }
      },
      auditStore,
      policy,
      registry,
      runLedger: runtime.ledger
    });

    const audit = JSON.stringify(await auditStore.readAll());
    const rows = runtime.ledger.database.db.prepare(
      "SELECT input_digest, output_digest FROM run_steps WHERE run_id IN (?, ?)"
    ).all(mutationRunId, patchRunId) as Array<{ input_digest: string | null; output_digest: string | null }>;
    const durableArtifacts = await Promise.all(rows.flatMap((row) => [row.input_digest, row.output_digest].filter((digest): digest is string => Boolean(digest))).map(async (digest) => {
      const artifact = runtime.ledger.database.db.prepare("SELECT path FROM artifacts WHERE digest = ?").get(digest) as { path: string };
      return readFile(join(runtime.ledger.artifacts.root, artifact.path), "utf8");
    }));
    const durableText = `${audit}\n${durableArtifacts.join("\n")}`;
    assert.equal(durableText.includes(contentSecret), false);
    assert.equal(durableText.includes(findSecret), false);
    assert.equal(durableText.includes(replaceSecret), false);
    assert.equal(durableText.includes("contentDigest"), true);
    assert.equal(durableText.includes("findDigest"), true);
    assert.equal(durableText.includes("replaceDigest"), true);
  } finally {
    registry.close();
    auditStore.close();
    runtime.ledger.close();
    await rm(state, { recursive: true, force: true });
  }
});

test("registry workspace.mutate and restore wrappers preserve stale-state failure gates", async () => {
  const root = await withTempRoot();
  const state = join(root, ".odinn");
  await mkdir(state, { recursive: true });
  const auditStore = createAuditStore(join(state, "audit.jsonl"));
  const runLedger = createRunLedger({ workspaceRoot: root, stateDir: state });

  try {
    const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir: state, auditStore, config: { runLedger } });
    const policy = createDefaultPolicy({ allowedCapabilities: ["job.healthcheck", "workspace.mutate", "workspace.patch", "restore.create", "restore.apply"] });

    await writeFile(join(root, "seed.txt"), "before");

    runLedger.ensureRun({ runId: "mutate-preview", objective: "seed preview" });
    const mutate = await runTask({
      task: {
        id: "mutate-preview",
        tool: "workspace.mutate",
        input: { operation: "write", path: "seed.txt", content: "after", apply: true }
      },
      auditStore,
      policy,
      registry,
      runLedger
    });
    const checkpointId = mutate.output.checkpointId;
    assert.equal(mutate.output.status, "ready");

    await writeFile(join(root, "seed.txt"), "changed after first mutation");
    const restorePreview = await runTask({
      task: {
        id: "restore-preview",
        tool: "restore.create",
        input: { checkpointId }
      },
      auditStore,
      policy,
      registry,
      runLedger
    });
    const staleRestore = await runTask({
      task: {
        id: "restore-stale",
        tool: "restore.apply",
        input: { checkpointId, checkpointManifestDigest: restorePreview.output.manifestDigest }
      },
      auditStore,
      policy,
      registry,
      runLedger
    });
    assert.equal(staleRestore.output.status, "conflict");
    assert.equal(staleRestore.output.preview, true);
    assert.equal(staleRestore.output.applied, false);
    const staleConflicts = staleRestore.output.conflicts ?? [];
    assert.equal(Array.isArray(staleConflicts), true);
    assert.equal(staleConflicts.length > 0, true);
  } finally {
    runLedger.close();
    await rm(state, { recursive: true, force: true });
  }
});
