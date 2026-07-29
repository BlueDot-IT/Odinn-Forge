import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve("scripts/ci/check-docs-impact.sh");

async function runPolicy(body: string, changedFiles: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "odinn-docs-impact-"));
  const bodyFile = join(directory, "body.md");
  const changedFilesFile = join(directory, "changed-files.txt");

  try {
    await writeFile(bodyFile, body);
    await writeFile(changedFilesFile, `${changedFiles.join("\n")}\n`);
    return spawnSync(script, [bodyFile, changedFilesFile], {
      encoding: "utf8",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function body(selection: "updated" | "not-required" | "both", details: string) {
  const updated = selection === "updated" || selection === "both" ? "x" : " ";
  const notRequired = selection === "not-required" || selection === "both" ? "x" : " ";

  return `## Documentation impact

- [${updated}] Documentation updated
- [${notRequired}] Documentation not required

Documentation details: ${details}

## Validation
`;
}

test("accepts an updated declaration with a documentation path", async () => {
  const result = await runPolicy(body("updated", "Updated docs/configuration.md."), [
    "src/config.ts",
    "docs/configuration.md",
  ]);

  assert.equal(result.status, 0, result.stderr);
});

test("accepts a concrete not-required declaration without documentation changes", async () => {
  const result = await runPolicy(
    body("not-required", "Internal test refactor with no user-visible behavior change."),
    ["tests/config.test.ts"],
  );

  assert.equal(result.status, 0, result.stderr);
});

test("rejects multiple selected outcomes", async () => {
  const result = await runPolicy(body("both", "This declaration is ambiguous."), ["README.md"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Select exactly one documentation outcome/);
});

test("rejects the unchanged details placeholder", async () => {
  const result = await runPolicy(
    body("not-required", "_Replace this text with updated paths or a concrete rationale._"),
    ["tests/config.test.ts"],
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Replace the documentation details placeholder/);
});

test("rejects an updated declaration without a documentation path", async () => {
  const result = await runPolicy(body("updated", "Updated inline implementation comments."), [
    "src/config.ts",
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /no Markdown\/MDX or docs\/ path changed/);
});

test("rejects updated details that do not identify a changed documentation path", async () => {
  for (const details of [
    "Updated docs/not-actually-changed.md.",
    "Updated docs/configuration.md.bak.",
    "Updated backup/docs/configuration.md.",
  ]) {
    const result = await runPolicy(body("updated", details), [
      "src/config.ts",
      "docs/configuration.md",
    ]);
    assert.equal(result.status, 1, `expected rejection for: ${details}`);
    assert.match(result.stderr, /identify at least one changed documentation path/);
  }
});

test("rejects a generic documentation-not-required assertion", async () => {
  for (const details of [
    "N/A",
    "None",
    "Not required",
    "Documentation not required",
    "No docs",
    "No documentation is required.",
  ]) {
    const result = await runPolicy(body("not-required", details), ["tests/config.test.ts"]);
    assert.equal(result.status, 1, `expected rejection for: ${details}`);
    assert.match(result.stderr, /must provide a specific rationale/);
  }
});
