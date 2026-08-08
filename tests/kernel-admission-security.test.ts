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
      /CAPABILITY_DENIED|POLICY_VIOLATION|capability is not allowed: text\.echo/
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
    const staleRestore = await runTask({
      task: {
        id: "restore-stale",
        tool: "restore.apply",
        input: { checkpointId }
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
