import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { createDifferentiatedRuntime, ProofVerifier } from "../packages/kernel/src/index.ts";
import { isPrivateAddress } from "../packages/kernel/src/web.ts";

const { zipSync } = createRequire(new URL("../packages/kernel/package.json", import.meta.url))("fflate");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "odinn-security-capsules-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  await mkdir(workspace);
  const runtime = createDifferentiatedRuntime({
    stateDir: state,
    workspaceRoot: workspace,
    featureFlags: { capsules: true, capabilities: false, counterfactual: false }
  });
  return { root, workspace, runtime };
}

test("capsule export rejects paths beneath a parent symlink", async () => {
  const { root, workspace, runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "symlink-export", objective: "confinement" });
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(workspace, "linked-parent"), "dir");
    await assert.rejects(
      runtime.capsules.export("symlink-export", { output: join(workspace, "linked-parent", "escaped.odinn") }),
      (error: any) => error.code === "CAPSULE_INVALID" && /symbolic link/.test(error.message)
    );
  } finally {
    runtime.ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("capsule verification enforces compressed, entry, and expansion limits", async () => {
  const { root, workspace, runtime } = await fixture();
  try {
    const oversizedCompressed = join(workspace, "oversized-compressed.odinn");
    const sparse = await open(oversizedCompressed, "w");
    await sparse.truncate(64 * 1024 * 1024 + 1);
    await sparse.close();
    await assert.rejects(
      runtime.capsules.verify(oversizedCompressed),
      (error: any) => error.code === "CAPSULE_INVALID" && /compressed-size limit/.test(error.message)
    );

    const entries: Record<string, Uint8Array> = {};
    for (let index = 0; index < 513; index += 1) entries[`entry-${index}.txt`] = new Uint8Array();
    const entryBomb = join(workspace, "entry-bomb.odinn");
    await writeFile(entryBomb, zipSync(entries));
    await assert.rejects(
      runtime.capsules.verify(entryBomb),
      (error: any) => error.code === "CAPSULE_INVALID" && /512-entry limit/.test(error.message)
    );

    const expansionBomb = join(workspace, "expansion-bomb.odinn");
    await writeFile(expansionBomb, zipSync({ "oversized.txt": new Uint8Array(32 * 1024 * 1024 + 1) }, { level: 9 }));
    await assert.rejects(
      runtime.capsules.verify(expansionBomb),
      (error: any) => error.code === "CAPSULE_INVALID" && /expanded-size limit/.test(error.message)
    );
  } finally {
    runtime.ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("network address classification blocks special and encoded forms", () => {
  for (const address of [
    "127.1",
    "2130706433",
    "0x7f000001",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::7f00:1",
    "2001::1",
    "2002:7f00:1::",
    "3fff::1",
    "5f00::1",
    "fec0::1"
  ]) assert.equal(isPrivateAddress(address), true, `${address} must not be treated as public`);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPrivateAddress(address), false, `${address} should remain public`);
  }
});

test("proof regex execution is terminated within a bounded time", async () => {
  const { root, workspace, runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "regex-bound", objective: "bounded matcher" });
    await writeFile(join(workspace, "evidence.txt"), `${"a".repeat(40)}!`);
    const started = Date.now();
    const result = await new ProofVerifier({ runLedger: runtime.ledger, allowedRoot: workspace }).verify({
      schemaVersion: 1,
      id: "regex-bound-contract",
      runId: "regex-bound",
      assertions: [{
        id: "evil-regex",
        type: "file",
        path: "evidence.txt",
        expect: { exists: true, content: { matches: "(a+)+$" } }
      }]
    });
    assert.equal(result.status, "failed");
    assert.ok(Date.now() - started < 2_000, "catastrophic matcher must not block the verifier");
    assert.match(result.assertions[0].message, /regular expression exceeded 250ms execution limit/);
  } finally {
    runtime.ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});
