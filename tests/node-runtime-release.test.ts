import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { readRuntimePolicy, validateArchiveEntries } from "../scripts/release/node-runtime.ts";

const root = resolve(import.meta.dirname, "..");

test("controlled Node runtime policy pins an exact reviewed x64 matrix", async () => {
  const policy = await readRuntimePolicy(root);
  assert.match(policy.version, /^24\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(policy.targets).sort(), ["darwin-x64", "linux-x64", "win32-x64"]);
  assert.ok(policy.keyring.allowedPrimaryFingerprints.length >= 3);
});

test("runtime archive validation rejects traversal, duplicates, links, and alien roots", () => {
  const valid = [{ name: "node-v24/bin/node", type: "file" as const }];
  assert.doesNotThrow(() => validateArchiveEntries(valid, "node-v24"));
  assert.throws(() => validateArchiveEntries([{ name: "node-v24/../escape", type: "file" }], "node-v24"), /unsafe/);
  assert.throws(() => validateArchiveEntries([...valid, ...valid], "node-v24"), /duplicate/);
  assert.throws(() => validateArchiveEntries([{ name: "node-v24/node", type: "link" }], "node-v24"), /unsupported/);
  assert.throws(() => validateArchiveEntries([{ name: "other/node", type: "file" }], "node-v24"), /top-level/);
});

test("standalone launchers use only the relative embedded runtime and sanitize Node hooks", async () => {
  const source = await readFile(resolve(root, "scripts/release/package-standalone.ts"), "utf8");
  assert.match(source, /runtime\/node/);
  assert.match(source, /unset NODE_OPTIONS NODE_PATH/);
  assert.doesNotMatch(source, /exec node /);
});
