import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { createDifferentiatedRuntime, ProofVerifier } from "../packages/kernel/src/index.ts";
import { isPrivateAddress } from "../packages/kernel/src/web.ts";

const { zipSync } = createRequire(new URL("../packages/kernel/package.json", import.meta.url))("fflate");

function forgeZipExpandedSize(archive: Uint8Array, claimedSize: number) {
  const forged = Buffer.from(archive);
  for (let offset = 0; offset <= forged.length - 30; offset += 1) {
    const signature = forged.readUInt32LE(offset);
    if (signature === 0x04034b50) forged.writeUInt32LE(claimedSize, offset + 22);
    if (signature === 0x02014b50) forged.writeUInt32LE(claimedSize, offset + 24);
  }
  return forged;
}

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
    const nestedParent = join(workspace, "new-parent");
    await assert.rejects(
      runtime.capsules.export("symlink-export", { output: join(nestedParent, "nested.odinn") }),
      (error: any) => error.code === "CAPSULE_INVALID" && /directly inside/.test(error.message)
    );
    await assert.rejects(access(nestedParent), /ENOENT/);
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

    const forgedExpansionBomb = join(workspace, "forged-expansion-bomb.odinn");
    const forgedArchive = forgeZipExpandedSize(
      zipSync({ "forged.txt": new Uint8Array(32 * 1024 * 1024 + 1) }, { level: 9 }),
      1
    );
    await writeFile(forgedExpansionBomb, forgedArchive);
    await assert.rejects(
      runtime.capsules.verify(forgedExpansionBomb),
      (error: any) => error.code === "CAPSULE_INVALID" && /expanded-size limit/.test(error.message)
    );
  } finally {
    runtime.ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("capsule export enforces verifier limits and valid exports round-trip", async () => {
  const { root, workspace, runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "oversized-export", objective: "reject oversized export" });
    const artifact = runtime.ledger.artifacts.put(Buffer.alloc(32 * 1024 * 1024 + 1), { mediaType: "application/octet-stream" });
    runtime.ledger.database.db.prepare(
      "INSERT INTO artifacts(digest, path, media_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(artifact.digest, artifact.path, artifact.mediaType, artifact.sizeBytes, new Date().toISOString());
    runtime.ledger.appendEvent({ runId: "oversized-export", type: "tool-request", payload: { inputDigest: artifact.digest } });
    const rejectedOutput = join(workspace, "oversized-export.odinn");
    await assert.rejects(
      runtime.capsules.export("oversized-export", { output: rejectedOutput }),
      (error: any) => error.code === "CAPSULE_INVALID" && /expanded-size limit/.test(error.message)
    );
    await assert.rejects(access(rejectedOutput), /ENOENT/);

    runtime.ledger.ensureRun({ runId: "round-trip-export", objective: "round trip" });
    const validOutput = join(workspace, "round-trip.odinn");
    await runtime.capsules.export("round-trip-export", { output: validOutput });
    const verification = await runtime.capsules.verify(validOutput);
    assert.equal(verification.valid, true);
    const replaced = await open(validOutput, "w");
    await replaced.truncate(64 * 1024 * 1024 + 1);
    await replaced.close();
    await assert.rejects(
      runtime.capsules.verify(validOutput),
      (error: any) => error.code === "CAPSULE_INVALID" && /compressed-size limit/.test(error.message)
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

test("benign proof regex workers tolerate concurrent startup load", async () => {
  const { root, workspace, runtime } = await fixture();
  try {
    await writeFile(join(workspace, "evidence.txt"), "NOTICE");
    const verifications = Array.from({ length: 12 }, async (_, index) => {
      const runId = `regex-concurrent-${index}`;
      runtime.ledger.ensureRun({ runId, objective: "concurrent benign matcher" });
      return await new ProofVerifier({ runLedger: runtime.ledger, allowedRoot: workspace }).verify({
        schemaVersion: 1,
        id: `regex-concurrent-contract-${index}`,
        runId,
        assertions: [{
          id: "benign-regex",
          type: "file",
          path: "evidence.txt",
          expect: { exists: true, content: { matches: "^notice$", flags: "i" } }
        }]
      });
    });
    const results = await Promise.all(verifications);
    assert.ok(results.every((result) => result.status === "passed"));
  } finally {
    runtime.ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});
