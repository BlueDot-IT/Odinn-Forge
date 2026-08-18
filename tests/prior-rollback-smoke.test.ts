import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  BASELINE_DIGESTS,
  BASELINE_TAG_COMMIT,
  BASELINE_VERSION,
  validatePriorRollback
} from "../scripts/release/validate-prior-rollback.ts";

test("baseline rollback constants match the immutable published v1.0.0 release", () => {
  assert.equal(BASELINE_VERSION, "1.0.0");
  assert.equal(BASELINE_TAG_COMMIT, "5114dbe9a46cfed1570d062eb22238773be3de26");
  assert.equal(
    BASELINE_DIGESTS["odinn-v1.0.0.tar.gz"],
    "e7389045bc2e5f671ce58b45cde8b053a2017f8f6120d70cde11a4c221ab6215"
  );
  assert.equal(
    BASELINE_DIGESTS["odinn-v1.0.0.zip"],
    "d96e0fb96039230f9b66e99bd5562844861b043424e2a67e01397d003b019b7d"
  );
});

test("release workflows and scripts define the prior rollback smoke gate", async () => {
  const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  assert.equal(
    pkg.scripts["release:rollback-smoke"],
    "node scripts/release/validate-prior-rollback.ts"
  );

  const integrity = await readFile(join(process.cwd(), ".github/workflows/package-integrity.yml"), "utf8");
  assert.match(integrity, /pnpm release:rollback-smoke/);

  const release = await readFile(join(process.cwd(), ".github/workflows/release.yml"), "utf8");
  assert.match(release, /validate-prior-rollback\.ts --candidate-release downloaded-release-assets/);
});

test("validatePriorRollback rejects missing candidate release directories", async () => {
  await assert.rejects(
    () => validatePriorRollback({ candidateDir: "/nonexistent/path/to/release" }),
    /ENOENT/
  );
});
