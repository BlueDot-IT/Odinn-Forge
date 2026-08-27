import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { unzipSync } from "fflate";
import { createApprovalStore, createAuditStore, createBuiltInRegistry, createDifferentiatedRuntime, OdinnRuntimeError, ProofVerifier, SnapshotManager, runTask } from "../packages/kernel/src/index.ts";
import { createDefaultPolicy } from "../packages/policy/src/index.ts";

const flags = { capsules: true, capabilities: true, counterfactual: true };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "odinn-diff-"));
  const state = join(root, ".odinn");
  const workspace = join(root, "workspace");
  await writeFile(join(root, "seed.txt"), "before\n");
  return { root, state, workspace, runtime: createDifferentiatedRuntime({ stateDir: state, workspaceRoot: root, featureFlags: flags }) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test("Sentinel blocks a denied command before execution and records the decision", async () => {
  const { runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "run-sentinel", objective: "policy test" });
    let transactions = 0;
    const transaction = runtime.ledger.database.transaction.bind(runtime.ledger.database);
    runtime.ledger.database.transaction = (callback: any) => {
      transactions += 1;
      return transaction(callback);
    };
    assert.throws(() => runtime.sentinel.evaluate({
      runId: "run-sentinel",
      toolName: "process.exec",
      input: { command: "terraform apply" },
      policy: {
        version: 1,
        invariants: [
          { id: "allow-unrelated", type: "command.deny-pattern", values: ["rm -rf"], enforcement: "block" },
          { id: "deny", type: "command.deny-pattern", values: ["terraform apply"], enforcement: "block" }
        ]
      }
    }), (error: any) => error instanceof OdinnRuntimeError && error.code === "POLICY_VIOLATION");
    assert.equal(transactions, 1);
    assert.equal(runtime.ledger.database.db.prepare("SELECT COUNT(*) count FROM policy_evaluations WHERE run_id = ?").get("run-sentinel").count, 2);
    assert.equal(runtime.ledger.getRun("run-sentinel").events.filter((event: any) => event.type === "policy-check").length, 2);
    assert.equal(runtime.ledger.verify("run-sentinel").valid, true);
  } finally { runtime.ledger.close(); }
});

test("Sentinel applies typed invariants without matching command text in unrelated tool input", async () => {
  const { root, runtime } = await fixture();
  try {
    for (const runId of ["sentinel-text", "sentinel-root"]) runtime.ledger.ensureRun({ runId, objective: "typed policy test" });
    const commandPolicy = { version: 1, invariants: [{ id: "deny-command", type: "command.deny-pattern", values: ["terraform apply"], enforcement: "block" }] };
    assert.equal(runtime.sentinel.evaluate({ runId: "sentinel-text", toolName: "text.echo", input: { text: "terraform apply" }, policy: commandPolicy }).allowed, true);
    const rootPolicy = { version: 1, invariants: [{ id: "workspace-only", type: "filesystem.allowed-roots", values: ["safe"], enforcement: "block" }] };
    assert.equal(runtime.sentinel.evaluate({ runId: "sentinel-root", toolName: "workspace.readText", input: { path: "safe/file.txt" }, policy: rootPolicy, workspaceRoot: root }).allowed, true);
    assert.throws(
      () => runtime.sentinel.evaluate({ runId: "sentinel-root", toolName: "workspace.readText", input: { path: "outside.txt" }, policy: rootPolicy, workspaceRoot: root }),
      (error: any) => error.code === "POLICY_VIOLATION"
    );
  } finally { runtime.ledger.close(); }
});

test("Sentinel rolls back the complete evaluation batch when evidence persistence fails", async () => {
  const { runtime } = await fixture();
  try {
    const runId = "sentinel-atomic-batch";
    runtime.ledger.ensureRun({ runId, objective: "atomic policy evidence" });
    const appendEventUnsafe = runtime.ledger.appendEventUnsafe.bind(runtime.ledger);
    let events = 0;
    runtime.ledger.appendEventUnsafe = (...args: any[]) => {
      events += 1;
      if (events === 2) throw new Error("injected policy evidence failure");
      return appendEventUnsafe(...args);
    };
    assert.throws(() => runtime.sentinel.evaluate({
      runId,
      toolName: "text.echo",
      input: { text: "safe" },
      policy: {
        version: 1,
        invariants: [
          { id: "first", type: "command.deny-pattern", values: ["never"], enforcement: "block" },
          { id: "second", type: "command.deny-pattern", values: ["still-never"], enforcement: "block" }
        ]
      }
    }), /injected policy evidence failure/);
    runtime.ledger.appendEventUnsafe = appendEventUnsafe;
    assert.equal(runtime.ledger.database.db.prepare("SELECT COUNT(*) count FROM policies WHERE run_id = ?").get(runId).count, 0);
    assert.equal(runtime.ledger.database.db.prepare("SELECT COUNT(*) count FROM policy_evaluations WHERE run_id = ?").get(runId).count, 0);
    assert.equal(runtime.ledger.getRun(runId).events.length, 0);
  } finally { runtime.ledger.close(); }
});

test("capabilities are scoped and consumed exactly once", async () => {
  const { runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "run-cap", objective: "capability test" });
    const issued = runtime.capabilities.issue({ runId: "run-cap", stepId: "step-1", toolName: "github.create", scopes: ["create"], resourceConstraints: { repository: "owner/repo" } });
    runtime.capabilities.consume(issued.token, { runId: "run-cap", toolName: "github.create", resource: { repository: "owner/repo" } });
    assert.throws(() => runtime.capabilities.consume(issued.token, { runId: "run-cap", toolName: "github.create", resource: { repository: "owner/repo" } }), /use limit/);
    assert.throws(() => runtime.capabilities.consume(issued.token, { runId: "run-other", toolName: "github.create", resource: { repository: "owner/repo" } }), /not valid/);
    assert.throws(() => runtime.capabilities.issue({ runId: "run-cap", stepId: "step-2", toolName: "github.create", expiresInMs: 0 }), /expiresInMs/);
    assert.throws(() => runtime.capabilities.issue({ runId: "run-cap", stepId: "step-3", toolName: "github.create", maxUses: 101 }), /maxUses/);
  } finally { runtime.ledger.close(); }
});

test("capability expiry is rechecked after waiting for the SQLite writer", async () => {
  const { runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "run-cap-expiry", objective: "contention expiry test" });
    const issued = runtime.capabilities.issue({
      runId: "run-cap-expiry",
      stepId: "step-expiry",
      toolName: "github.create",
      expiresInMs: 1_000
    });
    const child = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      `import { DatabaseSync } from "node:sqlite";
       const database = new DatabaseSync(process.argv[1]);
       database.exec("BEGIN IMMEDIATE");
       process.stdout.write("locked\\n");
       setTimeout(() => { database.exec("COMMIT"); database.close(); }, 1_800);`,
      runtime.ledger.database.path
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exit = new Promise<number | null>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", resolveExit);
    });
    await new Promise<void>((resolveReady, rejectReady) => {
      child.once("error", rejectReady);
      child.stdout.once("data", (chunk) => String(chunk).includes("locked") ? resolveReady() : rejectReady(new Error(`unexpected writer output: ${String(chunk)}`)));
    });
    assert.throws(
      () => runtime.capabilities.consume(issued.token, { runId: "run-cap-expiry", toolName: "github.create" }),
      (error: any) => error instanceof OdinnRuntimeError && error.code === "CAPABILITY_EXPIRED"
    );
    assert.equal(await exit, 0, stderr);
    assert.equal(runtime.ledger.database.db.prepare("SELECT uses FROM capabilities WHERE id = ?").get(issued.claims.id).uses, 0);
    assert.equal(runtime.ledger.database.db.prepare("SELECT COUNT(*) AS count FROM capability_uses WHERE capability_id = ?").get(issued.claims.id).count, 0);
  } finally { runtime.ledger.close(); }
});

test("snapshots restore a modified file and remove an agent-created file", async () => {
  const { root, runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "run-rewind", objective: "rewind test" });
    const snapshot = runtime.snapshots.create({ runId: "run-rewind", stepId: "step-1", paths: ["seed.txt", "created.txt"], workspaceRoot: root });
    await writeFile(join(root, "seed.txt"), "after\n"); await writeFile(join(root, "created.txt"), "new\n");
    const preview = runtime.snapshots.restore(snapshot.snapshotId);
    assert.equal(preview.applied, false); assert.equal(preview.actions.length, 2);
    const restored = runtime.snapshots.restore(snapshot.snapshotId, { apply: true });
    assert.match(restored.recoverySnapshotId, /^snap_/);
    assert.equal(await readFile(join(root, "seed.txt"), "utf8"), "before\n");
    await assert.rejects(readFile(join(root, "created.txt"), "utf8"), { code: "ENOENT" });
    runtime.snapshots.restore(restored.recoverySnapshotId, { apply: true });
    assert.equal(await readFile(join(root, "seed.txt"), "utf8"), "after\n");
    assert.equal(await readFile(join(root, "created.txt"), "utf8"), "new\n");
  } finally { runtime.ledger.close(); }
});

test("Rewind restores selected directory roots exactly and enforces capture bounds", async () => {
  const { root, runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "run-rewind-tree", objective: "rewind tree test" });
    await mkdir(join(root, "tree"));
    await writeFile(join(root, "tree", "kept.txt"), "before\n");
    const snapshot = runtime.snapshots.create({ runId: "run-rewind-tree", paths: ["tree"], workspaceRoot: root });
    await writeFile(join(root, "tree", "kept.txt"), "after\n");
    await writeFile(join(root, "tree", "extra.txt"), "extra\n");
    runtime.snapshots.restore(snapshot.snapshotId, { apply: true });
    assert.equal(await readFile(join(root, "tree", "kept.txt"), "utf8"), "before\n");
    await assert.rejects(readFile(join(root, "tree", "extra.txt"), "utf8"), { code: "ENOENT" });
    assert.throws(
      () => runtime.snapshots.create({ runId: "run-rewind-tree", paths: ["tree", "tree/kept.txt"], workspaceRoot: root }),
      /must not overlap/
    );
    await writeFile(join(root, "tree", "second.txt"), "second\n");
    const bounded = new SnapshotManager({ ledger: runtime.ledger, maxFiles: 1 });
    assert.throws(
      () => bounded.create({ runId: "run-rewind-tree", paths: ["tree"], workspaceRoot: root }),
      /file limit/
    );
  } finally { runtime.ledger.close(); }
});

test("Proof persists evidence and refuses model claims without passing assertions", async () => {
  const { root, runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "run-proof", objective: "proof test" });
    runtime.darwin.observe({ runId: "run-proof", providerId: "p", modelId: "m", taskClass: "proof-test", partiallyVerified: true, durationMs: 10 });
    const proof = await new ProofVerifier({ runLedger: runtime.ledger, allowedRoot: root }).verify({ schemaVersion: 1, id: "contract-proof", runId: "run-proof", assertions: [{ id: "file", type: "file", path: "seed.txt", expect: { exists: true, content: { contains: "before" } } }] });
    assert.equal(proof.status, "passed");
    assert.equal(runtime.ledger.getRun("run-proof").status, "verified");
    assert.equal(runtime.ledger.database.db.prepare("SELECT COUNT(*) count FROM assertion_results WHERE run_id = ?").get("run-proof").count, 1);
    assert.deepEqual({ ...runtime.ledger.database.db.prepare("SELECT verified, partially_verified FROM model_observations WHERE run_id = ?").get("run-proof") }, { verified: 1, partially_verified: 0 });
    assert.ok(runtime.ledger.getRun("run-proof").events.some((event: any) => event.type === "model-observation-verification" && event.payload.observationIds.length === 1));
  } finally { runtime.ledger.close(); }
});

test("capsules verify their checksums and detect tampering", async () => {
  const { root, runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "run-capsule", objective: "capsule test" });
    const step = runtime.ledger.beginTool({ runId: "run-capsule", toolName: "external.fixture", input: { text: "capsule full replay" }, safety: { effects: ["external-state"], reversibility: "compensatable" } });
    runtime.ledger.finishTool({ runId: "run-capsule", stepId: step.stepId, output: { text: "capsule full replay" } });
    const output = join(root, "run.odinn");
    await runtime.capsules.export("run-capsule", { output });
    assert.equal((await runtime.capsules.verify(output)).valid, true);
    const replay = await runtime.capsules.replay(output, { mode: "tool-mocked" });
    assert.equal(replay.executed, true);
    assert.equal(runtime.ledger.getRun(replay.replayRunId).status, "completed-unverified");
    const fullWorkspace = join(root, "full-replay");
    const executed = [];
    await assert.rejects(runtime.capsules.replay(output, { mode: "full", workspace: fullWorkspace, executor: async () => ({ ok: true }) }), (error: any) => error.code === "CAPABILITY_DENIED");
    const full = await runtime.capsules.replay(output, { mode: "full", workspace: fullWorkspace, approveExternal: true, executor: async (task: any) => { executed.push(task); return { ok: true }; } });
    assert.equal(full.executed, true);
    assert.equal(executed[0].tool, "external.fixture");
    assert.equal(executed[0].external, true);
    assert.equal(executed[0].input.text, "capsule full replay");
    const bytes = await readFile(output); bytes[bytes.length - 1] ^= 1; await writeFile(output, bytes);
    await assert.rejects(runtime.capsules.verify(output), (error: any) => error.code === "CAPSULE_TAMPERED");
  } finally { runtime.ledger.close(); }
});

test("sensitive tool input is absent from every durable file and capsule entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-sensitive-durable-"));
  const state = join(root, ".odinn");
  const runtime = createDifferentiatedRuntime({
    stateDir: state,
    workspaceRoot: root,
    featureFlags: { capsules: true }
  });
  const sentinel = "SENTINEL_DURABLE_BROWSER_VALUE_77d2";
  const markedSentinel = "SENTINEL_EXPLICIT_SENSITIVE_INPUT_a193";
  try {
    const approvalStore = createApprovalStore({ path: join(state, "approvals.json") });
    const auditStore = createAuditStore(join(state, "audit.jsonl"));
    const result = await runTask({
      task: {
        id: "run-sensitive-capsule",
        tool: "browser.type",
        actor: "test",
        input: {
          selector: "#password",
          value: sentinel,
          metadata: {
            label: "ordinary metadata remains available",
            note: { sensitive: true, value: markedSentinel }
          }
        }
      },
      auditStore,
      registry: createBuiltInRegistry({ workspaceRoot: root, stateDir: state, auditStore, approvalStore }),
      runLedger: runtime.ledger
    });
    assert.equal(result.output.type, "approval.required");

    const beforeExport = await readdir(state, { recursive: true, withFileTypes: true });
    for (const entry of beforeExport) {
      if (!entry.isFile()) continue;
      const bytes = await readFile(join(entry.parentPath, entry.name));
      for (const secret of [sentinel, markedSentinel]) {
        assert.equal(bytes.includes(Buffer.from(secret)), false, `${join(entry.parentPath, entry.name)} retained ${secret}`);
      }
    }

    const output = join(root, "sensitive.odinn");
    await runtime.capsules.export("run-sensitive-capsule", { output });
    const entries = unzipSync(await readFile(output));
    assert.ok(Object.keys(entries).some((name) => name.startsWith("artifacts/")));
    for (const [name, bytes] of Object.entries(entries)) {
      for (const secret of [sentinel, markedSentinel]) {
        assert.equal(Buffer.from(bytes).includes(Buffer.from(secret)), false, `${name} retained ${secret}`);
      }
    }
  } finally { runtime.ledger.close(); }
});

test("Darwin chooses a model using observed verification outcomes", async () => {
  const { runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "run-darwin-a", objective: "routing" }); runtime.ledger.ensureRun({ runId: "run-darwin-b", objective: "routing" });
    let hydratedRun = false;
    const getRun = runtime.ledger.getRun.bind(runtime.ledger);
    runtime.ledger.getRun = (...args: any[]) => {
      hydratedRun = true;
      return getRun(...args);
    };
    runtime.darwin.observe({ runId: "run-darwin-a", providerId: "p", modelId: "good", taskClass: "bug-fix", verified: true, durationMs: 10, toolCalls: 1 });
    runtime.darwin.observe({ runId: "run-darwin-b", providerId: "p", modelId: "bad", taskClass: "bug-fix", verified: false, durationMs: 1, toolCalls: 1, toolErrors: 1 });
    assert.equal(runtime.darwin.choose("bug-fix").model, "p:good");
    assert.equal(hydratedRun, false);
    runtime.ledger.getRun = getRun;
    assert.ok(runtime.ledger.getRun("run-darwin-a").events.some((event: any) => event.type === "model-observation" && event.payload.modelId === "good"));
  } finally { runtime.ledger.close(); }
});

test("counterfactual candidates receive isolated workspaces", async () => {
  const { root, runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "run-source", objective: "branch" });
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "should-not-copy.txt"), "generated\n");
    const group = await runtime.counterfactual.create({ sourceRunId: "run-source", sourceStepId: "step-1", workspaceRoot: root, plans: [{ id: "a", title: "A", summary: "first" }, { id: "b", title: "B", summary: "second" }] });
    assert.equal(group.candidates.length, 2); assert.notEqual(group.candidates[0].workspaceRoot, group.candidates[1].workspaceRoot);
    assert.equal(runtime.counterfactual.compare(group.groupId).candidates.length, 2);
    await writeFile(join(group.candidates[0].workspaceRoot, "only-a.txt"), "a\n");
    await assert.rejects(readFile(join(group.candidates[1].workspaceRoot, "only-a.txt"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(join(group.candidates[0].workspaceRoot, "node_modules", "should-not-copy.txt"), "utf8"), { code: "ENOENT" });
  } finally { runtime.ledger.close(); }
});

test("counterfactual execution rejects a substituted candidate workspace before dispatch", async (t) => {
  const { root, runtime } = await fixture();
  const attackerRoot = await mkdtemp(join(tmpdir(), "odinn-counterfactual-attacker-"));
  let candidateRoot = "";
  t.after(async () => {
    runtime.ledger.close();
    if (candidateRoot) await rm(dirname(candidateRoot), { recursive: true, force: true });
    await rm(attackerRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  runtime.ledger.ensureRun({ runId: "counterfactual-root-substitution", objective: "reject substituted branch roots" });
  const group = await runtime.counterfactual.create({
    sourceRunId: "counterfactual-root-substitution",
    sourceStepId: "step-1",
    workspaceRoot: root,
    plans: [{
      id: "candidate",
      title: "Candidate",
      summary: "must remain bound to its isolated root",
      tasks: [{ tool: "text.echo", input: { text: "never dispatch" }, readOnly: true }]
    }]
  });
  const candidate = group.candidates[0];
  candidateRoot = candidate.workspaceRoot;
  runtime.ledger.database.db.prepare("UPDATE runs SET workspace_root = ? WHERE id = ?").run(attackerRoot, candidate.runId);
  let dispatches = 0;
  await assert.rejects(
    runtime.counterfactual.execute(group.groupId, { executor: async () => { dispatches += 1; } }),
    (error: any) => error instanceof OdinnRuntimeError && error.code === "WORKSPACE_CONFLICT"
  );
  assert.equal(dispatches, 0);
});

test("counterfactual creation excludes protected components and an arbitrarily nested state root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-counterfactual-nested-state-"));
  const state = join(root, "config", "private-runtime-state");
  const protectedFiles = [
    join(root, "nested", ".git", "credential.txt"),
    join(root, "nested", ".odinn", "credential.txt"),
    join(root, "nested", ".odinn-worktrees", "credential.txt"),
    join(root, "nested", "node_modules", "generated.txt"),
    join(state, "credential.txt")
  ];
  for (const path of protectedFiles) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `private:${path}\n`);
  }
  await mkdir(join(root, "nested", "ordinary"), { recursive: true });
  await writeFile(join(root, "nested", "ordinary", "copied.txt"), "copied\n");
  const runtime = createDifferentiatedRuntime({ stateDir: state, workspaceRoot: root, featureFlags: flags });
  let candidateRoot = "";
  t.after(async () => {
    runtime.ledger.close();
    if (candidateRoot) await rm(dirname(dirname(candidateRoot)), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  runtime.ledger.ensureRun({ runId: "counterfactual-nested-state-create", objective: "exclude nested runtime state" });
  const group = await runtime.counterfactual.create({
    sourceRunId: "counterfactual-nested-state-create",
    sourceStepId: "step-1",
    workspaceRoot: root,
    plans: [{ id: "isolated", title: "Isolated", summary: "copy only workspace data" }]
  });
  candidateRoot = group.candidates[0].workspaceRoot;
  const candidateRelative = relative(root, candidateRoot);
  assert.ok(candidateRelative === ".." || candidateRelative.startsWith(`..${sep}`), "candidate copy must not be a descendant of its source");
  assert.equal(await readFile(join(candidateRoot, "nested", "ordinary", "copied.txt"), "utf8"), "copied\n");
  for (const path of [
    join(candidateRoot, "nested", ".git", "credential.txt"),
    join(candidateRoot, "nested", ".odinn", "credential.txt"),
    join(candidateRoot, "nested", ".odinn-worktrees", "credential.txt"),
    join(candidateRoot, "nested", "node_modules", "generated.txt"),
    join(candidateRoot, "config", "private-runtime-state", "credential.txt")
  ]) {
    await assert.rejects(readFile(path, "utf8"), (error: any) => error?.code === "ENOENT");
  }
});

test("counterfactual activation and rollback preserve nested state and protected workspace components", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odinn-counterfactual-nested-state-select-"));
  const state = join(root, "config", "private-runtime-state");
  const protectedRoots = [
    join(root, "nested", ".git"),
    join(root, "nested", ".odinn"),
    join(root, "nested", ".odinn-worktrees")
  ];
  for (const protectedRoot of protectedRoots) {
    await mkdir(protectedRoot, { recursive: true });
    await writeFile(join(protectedRoot, "preserved.txt"), "source-private\n");
  }
  await mkdir(state, { recursive: true });
  await writeFile(join(state, "credential.txt"), "state-private\n");
  await writeFile(join(root, "ordinary.txt"), "source\n");
  if (process.platform !== "win32") {
    await writeFile(join(root, "symlink-target.txt"), "source-link-target\n");
    await symlink("symlink-target.txt", join(root, "preserved-link.txt"));
  }
  const runtime = createDifferentiatedRuntime({ stateDir: state, workspaceRoot: root, featureFlags: flags });
  let candidateRoot = "";
  t.after(async () => {
    runtime.ledger.close();
    if (candidateRoot) await rm(dirname(dirname(candidateRoot)), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  runtime.ledger.ensureRun({ runId: "counterfactual-nested-state-select", objective: "preserve nested state during selection" });
  const group = await runtime.counterfactual.create({
    sourceRunId: "counterfactual-nested-state-select",
    sourceStepId: "step-1",
    workspaceRoot: root,
    plans: [{
      id: "candidate",
      title: "Candidate",
      summary: "activate without copying state",
      tasks: [{ tool: "text.echo", input: { text: "candidate" }, readOnly: true }]
    }]
  });
  const candidate = group.candidates[0];
  candidateRoot = candidate.workspaceRoot;
  await runtime.counterfactual.execute(group.groupId, { executor: async () => ({ output: { text: "completed" } }) });
  await writeFile(join(candidateRoot, "ordinary.txt"), "candidate\n");
  for (const protectedRoot of [
    join(candidateRoot, "nested", ".git"),
    join(candidateRoot, "nested", ".odinn"),
    join(candidateRoot, "nested", ".odinn-worktrees"),
    join(candidateRoot, "config", "private-runtime-state")
  ]) {
    await mkdir(protectedRoot, { recursive: true });
    await writeFile(join(protectedRoot, "must-not-activate.txt"), "candidate-private\n");
  }

  await assert.rejects(runtime.counterfactual.select(group.groupId, candidate.runId, {
    apply: true,
    __testOnlyAfterActivation: () => { throw new Error("injected activation settlement failure"); }
  }), /injected activation settlement failure/u);
  assert.equal(await readFile(join(root, "ordinary.txt"), "utf8"), "source\n");
  assert.equal(await readFile(join(state, "credential.txt"), "utf8"), "state-private\n");
  for (const protectedRoot of protectedRoots) {
    assert.equal(await readFile(join(protectedRoot, "preserved.txt"), "utf8"), "source-private\n");
    await assert.rejects(readFile(join(protectedRoot, "must-not-activate.txt"), "utf8"), (error: any) => error?.code === "ENOENT");
  }
  if (process.platform !== "win32") {
    assert.equal((await lstat(join(root, "preserved-link.txt"))).isSymbolicLink(), true);
    assert.equal(await readlink(join(root, "preserved-link.txt")), "symlink-target.txt");
  }

  const selected = await runtime.counterfactual.select(group.groupId, candidate.runId, { apply: true });
  assert.equal(selected.applied, true);
  assert.equal(await readFile(join(root, "ordinary.txt"), "utf8"), "candidate\n");
  assert.equal(await readFile(join(state, "credential.txt"), "utf8"), "state-private\n");
  await assert.rejects(readFile(join(state, "must-not-activate.txt"), "utf8"), (error: any) => error?.code === "ENOENT");
  for (const protectedRoot of protectedRoots) {
    assert.equal(await readFile(join(protectedRoot, "preserved.txt"), "utf8"), "source-private\n");
  }
  if (process.platform !== "win32") {
    assert.equal((await lstat(join(root, "preserved-link.txt"))).isSymbolicLink(), true);
    assert.equal(await readlink(join(root, "preserved-link.txt")), "symlink-target.txt");
  }
});

test("counterfactual execution runs real audited tasks and supports selection preview", async () => {
  const { root, state, runtime } = await fixture();
  const auditStore = createAuditStore(join(state, "audit.jsonl"));
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir: state, auditStore });
  try {
    runtime.ledger.ensureRun({ runId: "run-source-execute", objective: "branch execution" });
    await writeFile(join(root, "candidate-only.txt"), "before\n");
    const plans = ["a", "b"].map((id: any) => ({
      id,
      title: id.toUpperCase(),
      summary: `execute ${id}`,
      tasks: [{ tool: "workspace.readText", readOnly: true, input: { path: "candidate-only.txt" } }]
    }));
    const group = await runtime.counterfactual.create({ sourceRunId: "run-source-execute", sourceStepId: "step-1", workspaceRoot: root, plans });
    await rm(join(root, "candidate-only.txt"), { force: true });
    const execution = await runtime.counterfactual.execute(group.groupId, {
      policy: createDefaultPolicy(),
      proof: runtime.proof,
      capabilities: runtime.capabilities,
      executor: (task: any, context: any) => runTask({ task, auditStore, policy: context.policy, registry: createBuiltInRegistry({ workspaceRoot: context.workspaceRoot, stateDir: state, auditStore }), runLedger: runtime.ledger })
    });
    assert.deepEqual(execution.results.map((result: any) => result.status), ["completed-unverified", "completed-unverified"]);
    assert.deepEqual(execution.results.flatMap((result: any) => result.tasks.map((task: any) => task.output?.content)), ["before\n", "before\n"]);
    const preview = await runtime.counterfactual.select(group.groupId, group.candidates[0].runId);
    assert.equal(preview.applied, false);
    assert.match(preview.warning, /--apply/);
    assert.equal(runtime.counterfactual.compare(group.groupId).candidates.filter((candidate: any) => candidate.status === "completed").length, 2);
  } finally { runtime.ledger.close(); }
});

test("counterfactual creation removes copied workspaces and durable rows when cancelled before activation", async (t) => {
  const { root, runtime } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const entered = deferred();
  const release = deferred();
  const controller = new AbortController();
  try {
    runtime.ledger.ensureRun({ runId: "counterfactual-create-cancel", objective: "cancel branch creation" });
    const creation = runtime.counterfactual.create({
      sourceRunId: "counterfactual-create-cancel",
      sourceStepId: "step-1",
      workspaceRoot: root,
      plans: [{ id: "cancelled", title: "Cancelled", summary: "must not activate" }],
      signal: controller.signal,
      __testOnlyAfterWorkspaceCopy: async () => {
        entered.resolve();
        await release.promise;
      }
    });
    await entered.promise;
    controller.abort(new Error("gateway shutdown is in progress"));
    release.resolve();
    await assert.rejects(creation, /gateway shutdown is in progress/u);

    const database = runtime.ledger.database.db;
    assert.equal(Number((database.prepare("SELECT COUNT(*) AS count FROM counterfactual_groups").get() as any).count), 0);
    assert.equal(Number((database.prepare("SELECT COUNT(*) AS count FROM counterfactual_candidates").get() as any).count), 0);
    assert.equal(Number((database.prepare("SELECT COUNT(*) AS count FROM run_branches").get() as any).count), 0);
    assert.equal(runtime.ledger.getRun("counterfactual-create-cancel").events.some((event: any) => event.type === "branch-created"), false);
    const retainedWorktrees = await readdir(join(root, ".odinn-worktrees")).catch((error: any) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    assert.deepEqual(retainedWorktrees, []);
  } finally {
    release.resolve();
    runtime.ledger.close();
  }
});

test("counterfactual execution quarantines an in-flight task without failure or final group settlement", async (t) => {
  const { root, runtime } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const entered = deferred();
  const release = deferred();
  const controller = new AbortController();
  let startedRunId = "";
  try {
    runtime.ledger.ensureRun({ runId: "counterfactual-execute-cancel", objective: "cancel branch execution" });
    const group = await runtime.counterfactual.create({
      sourceRunId: "counterfactual-execute-cancel",
      sourceStepId: "step-1",
      workspaceRoot: root,
      plans: ["first", "second"].map((id) => ({
        id,
        title: id,
        summary: `${id} candidate`,
        tasks: [{ tool: "text.echo", input: { text: id }, readOnly: true }]
      }))
    });
    const execution = runtime.counterfactual.execute(group.groupId, {
      signal: controller.signal,
      executor: async (task: any, context: any) => {
        assert.equal(context.signal, controller.signal);
        startedRunId = String(task.id).split(":task:")[0];
        entered.resolve();
        await release.promise;
        return { output: { text: "must not settle" } };
      }
    });
    await entered.promise;
    const waitingRunId = group.candidates.find((candidate: any) => candidate.runId !== startedRunId)?.runId;
    assert.ok(startedRunId);
    assert.ok(waitingRunId);
    const eventsBeforeAbort = runtime.ledger.getRun(startedRunId).events.length;
    controller.abort(new Error("gateway shutdown is in progress"));
    release.resolve();
    await assert.rejects(execution, /gateway shutdown is in progress/u);

    const database = runtime.ledger.database.db;
    assert.equal((database.prepare("SELECT status FROM counterfactual_groups WHERE id = ?").get(group.groupId) as any).status, "created");
    assert.equal((database.prepare("SELECT status FROM counterfactual_candidates WHERE run_id = ?").get(startedRunId) as any).status, "executing");
    assert.equal((database.prepare("SELECT status FROM counterfactual_candidates WHERE run_id = ?").get(waitingRunId) as any).status, "created");
    const firstEvents = runtime.ledger.getRun(startedRunId).events;
    assert.equal(firstEvents.length, eventsBeforeAbort);
    assert.equal(firstEvents.some((event: any) => ["counterfactual-completed", "counterfactual-failed"].includes(event.type)), false);
    assert.equal(runtime.ledger.getRun(waitingRunId).events.some((event: any) => event.type === "counterfactual-started"), false);
  } finally {
    release.resolve();
    runtime.ledger.close();
  }
});

test("counterfactual selection cancelled after backup leaves the workspace and durable selection unchanged", async (t) => {
  const { root, state, runtime } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const entered = deferred();
  const release = deferred();
  const controller = new AbortController();
  try {
    runtime.ledger.ensureRun({ runId: "counterfactual-select-cancel", objective: "cancel branch selection" });
    const group = await runtime.counterfactual.create({
      sourceRunId: "counterfactual-select-cancel",
      sourceStepId: "step-1",
      workspaceRoot: root,
      plans: [{
        id: "candidate",
        title: "Candidate",
        summary: "candidate selection",
        tasks: [{ tool: "text.echo", input: { text: "candidate" }, readOnly: true }]
      }]
    });
    await runtime.counterfactual.execute(group.groupId, {
      executor: async () => ({ output: { text: "completed" } })
    });
    const candidate = group.candidates[0];
    await writeFile(join(candidate.workspaceRoot, "seed.txt"), "candidate\n");
    const sourceIdentity = await stat(join(root, "seed.txt"));
    const selection = runtime.counterfactual.select(group.groupId, candidate.runId, {
      apply: true,
      signal: controller.signal,
      __testOnlyAfterBackup: async () => {
        entered.resolve();
        await release.promise;
      }
    });
    await entered.promise;
    const sourceEventsBeforeAbort = runtime.ledger.getRun("counterfactual-select-cancel").events.length;
    controller.abort(new Error("gateway shutdown is in progress"));
    release.resolve();
    await assert.rejects(selection, /gateway shutdown is in progress/u);

    assert.equal(await readFile(join(root, "seed.txt"), "utf8"), "before\n");
    assert.equal((await stat(join(root, "seed.txt"))).ino, sourceIdentity.ino, "abort before activation must not replace source files");
    const database = runtime.ledger.database.db;
    assert.equal((database.prepare("SELECT status FROM counterfactual_groups WHERE id = ?").get(group.groupId) as any).status, "executed");
    assert.equal((database.prepare("SELECT status FROM counterfactual_candidates WHERE run_id = ?").get(candidate.runId) as any).status, "completed");
    const sourceEvents = runtime.ledger.getRun("counterfactual-select-cancel").events;
    assert.equal(sourceEvents.length, sourceEventsBeforeAbort);
    assert.equal(sourceEvents.some((event: any) => event.type === "branch-selected"), false);
    const retainedBackups = await readdir(join(state, "worktrees")).catch((error: any) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    assert.deepEqual(retainedBackups, []);
  } finally {
    release.resolve();
    runtime.ledger.close();
  }
});

test("kernel execution enforces Sentinel and capability tokens at the real tool boundary", async () => {
  const { root, state, runtime } = await fixture();
  const auditStore = createAuditStore(join(state, "audit.jsonl"));
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir: state });
  try {
    let executed = false;
    registry.set("process.exec", { capability: "process.exec", execute: async () => { executed = true; return { ok: true }; } });
    const policy = createDefaultPolicy({ allowedCapabilities: ["process.exec"], invariants: [{ id: "deny-prod", type: "command.deny-pattern", values: ["terraform apply"], enforcement: "block" }] });
    await assert.rejects(runTask({ task: { id: "run-kernel-block", tool: "process.exec", input: { command: "terraform apply" }, actor: "test" }, auditStore, policy, registry, runLedger: runtime.ledger }), (error: any) => error.code === "POLICY_VIOLATION");
    assert.equal(executed, false);
    assert.equal(runtime.ledger.getRun("run-kernel-block").status, "blocked");

    runtime.ledger.ensureRun({ runId: "run-kernel-cap", objective: "capability execution" });
    const issued = runtime.capabilities.issue({ runId: "run-kernel-cap", stepId: "step-cap", toolName: "text.echo" });
    const result = await runTask({ task: { id: "run-kernel-cap", tool: "text.echo", input: { text: "capability passed", capabilityToken: issued.token }, actor: "test" }, auditStore, policy: createDefaultPolicy(), registry, runLedger: runtime.ledger });
    assert.equal(result.output.text, "capability passed");
    assert.doesNotMatch(JSON.stringify(runtime.ledger.getRun("run-kernel-cap")), new RegExp(issued.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally { runtime.ledger.close(); }
});

test("core advanced services remain available while disabled plugin modules reject active operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-diff-disabled-"));
  const state = join(root, ".odinn");
  const runtime = createDifferentiatedRuntime({ stateDir: state, workspaceRoot: root, featureFlags: { capsules: false, capabilities: false, counterfactual: false } });
  try {
    for (const runId of ["core-proof", "core-sentinel", "core-rewind"]) runtime.ledger.ensureRun({ runId, objective: "core service test" });
    assert.equal((await runtime.proof.run("core-proof", { version: 1, goal: "available", acceptance: [{ id: "a", type: "file", path: "missing", expect: { exists: false } }] })).status, "verified");
    assert.equal(runtime.sentinel.evaluate({ runId: "core-sentinel", toolName: "text.echo", input: {}, policy: { version: 1, invariants: [] } }).allowed, true);
    assert.match(runtime.snapshots.create({ runId: "core-rewind", stepId: "step", paths: ["missing"], workspaceRoot: root }).snapshotId, /^snap_/);
    assert.equal(runtime.darwin.choose("general", { pinnedModel: "pinned:model" }).model, "pinned:model");
    assert.throws(() => runtime.capabilities.issue({ runId: "disabled-cap", stepId: "step", toolName: "text.echo" }), /experimental\.capabilities is disabled/);
    await assert.rejects(runtime.capsules.verify(join(root, "missing.odinn")), /experimental\.capsules is disabled/);
    await assert.rejects(runtime.counterfactual.create({ sourceRunId: "disabled-counterfactual", sourceStepId: "step", workspaceRoot: root, plans: [] }), /experimental\.counterfactual is disabled/);
    assert.deepEqual([...runtime.plugins.keys()], ["capabilities", "capsules", "counterfactual"]);
    assert.ok([...runtime.plugins.values()].every((plugin: any) => plugin.enabled === false));
    for (const feature of ["capabilities", "capsules", "counterfactual"]) {
      const run = runtime.ledger.getRun(`system:experimental:${feature}`);
      assert.ok(run?.events.some((event: any) => event.type === "experimental-feature-rejected" && event.payload.feature === feature));
    }
  } finally { runtime.ledger.close(); }
});
