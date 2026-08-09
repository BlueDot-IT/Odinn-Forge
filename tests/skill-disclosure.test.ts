import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  ProgressiveSkillDisclosure,
  SkillDisclosureError
} from "../packages/kernel/src/skill-disclosure.ts";
import * as kernelRoot from "../packages/kernel/src/index.ts";
import { SkillPackageStore, validateSkillPackage } from "../packages/kernel/src/index.ts";

const execFileAsync = promisify(execFile);

function manifest(id: string, overrides: Record<string, unknown> = {}) {
  return {
    sdkVersion: "0.1",
    id,
    version: "1.0.0",
    name: id.split("-").map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`).join(" "),
    description: `Select ${id} when a bounded workflow needs this exact capability.`,
    instructions: `Run the ${id} workflow only after selection, validate each input, and return bounded evidence.`,
    requestedTools: [`${id}.read`],
    requestedCapabilities: [`${id}.use`],
    requestedSecrets: ["NOT_DISCLOSED"],
    network: { default: "deny", allow: ["example.com"] },
    tests: [{ name: `large private test body for ${id}`, body: "x".repeat(4_096) }],
    ...overrides
  };
}

async function fixture(t: test.TestContext) {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-skill-disclosure-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = new SkillPackageStore(stateDir);
  return { stateDir, store };
}

async function installEnabled(store: SkillPackageStore, id: string, overrides: Record<string, unknown> = {}) {
  const installed = await store.install(manifest(id, overrides));
  await store.transition(id, "enable");
  return installed;
}

test("package subpath and kernel root export expose progressive disclosure explicitly", async () => {
  const probe = [
    "import('@odinn/kernel/skill-disclosure')",
    ".then((module) => process.stdout.write(typeof module.ProgressiveSkillDisclosure))"
  ].join("");
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", probe], {
    cwd: join(process.cwd(), "apps", "gateway")
  });

  assert.equal(stdout, "function");
  assert.equal("ProgressiveSkillDisclosure" in kernelRoot, true);
});

test("catalog is compact, deterministic, and excludes instructions and private package fields", async (t) => {
  const { store } = await fixture(t);
  await installEnabled(store, "zeta-skill", {
    instructions: `Perform the selected zeta workflow.\n${"instruction ".repeat(4_000)}`
  });
  await installEnabled(store, "alpha-skill");
  await store.install(manifest("disabled-skill"));
  const disclosure = new ProgressiveSkillDisclosure(store);

  const first = await disclosure.catalog();
  const second = await disclosure.catalog();
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((entry) => entry.id), ["alpha-skill", "zeta-skill"]);
  const serialized = JSON.stringify(first);
  assert.ok(Buffer.byteLength(serialized, "utf8") < 1_024);
  assert.doesNotMatch(serialized, /Perform the selected zeta workflow/u);
  assert.doesNotMatch(serialized, /NOT_DISCLOSED|large private test body|packagePath|integrity|network/u);
  assert.equal(Object.hasOwn(first[0]!, "instructions"), false);
  assert.equal(Object.hasOwn(first[0]!, "tests"), false);
});

test("catalog reads only the compact disclosure index, not oversized full manifests or registry state", async (t) => {
  const { stateDir, store } = await fixture(t);
  await installEnabled(store, "oversized-manifest", {
    instructions: `Use only after exact selection.\n${"full instruction body ".repeat(100_000)}`,
    tests: [{ body: "private test body ".repeat(100_000) }]
  });
  const indexPath = join(stateDir, "skills", "disclosure-index.json");
  assert.ok((await stat(indexPath)).size < 4_096);
  await writeFile(join(stateDir, "skills", "registry.json"), "{ intentionally unreadable registry", "utf8");

  const catalog = await new ProgressiveSkillDisclosure(store).catalog();
  assert.deepEqual(catalog.map((entry) => entry.id), ["oversized-manifest"]);
  assert.ok(Buffer.byteLength(JSON.stringify(catalog), "utf8") < 512);
});

test("missing legacy disclosure index fails closed until explicit migration", async (t) => {
  const { stateDir, store } = await fixture(t);
  await installEnabled(store, "legacy-skill");
  await rm(join(stateDir, "skills", "disclosure-index.json"));
  const disclosure = new ProgressiveSkillDisclosure(store);

  await assert.rejects(() => disclosure.catalog(), /disclosure index is missing.*explicit.*migration/u);
  await store.migrateDisclosureIndex();
  assert.deepEqual((await disclosure.catalog()).map((entry) => entry.id), ["legacy-skill"]);
});

test("batch recovery disables incompatible legacy entries while preserving compatible enabled skills", async (t) => {
  const { stateDir, store } = await fixture(t);
  await installEnabled(store, "compatible-skill");
  await store.install(manifest("oversized-first", { description: `First ${"é".repeat(1_100)}` }));
  await store.install(manifest("oversized-second", { description: `Second ${"é".repeat(1_100)}` }));
  const registryPath = join(stateDir, "skills", "registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  for (const record of registry.packages) {
    if (record.id.startsWith("oversized-")) {
      record.status = "enabled";
      record.trusted = true;
    }
  }
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await writeFile(join(stateDir, "skills", ".disclosure-index-dirty"), "dirty\n", "utf8");
  const disclosure = new ProgressiveSkillDisclosure(store);

  await assert.rejects(() => disclosure.catalog(), /disclosure index is dirty/u);
  const report = await store.recoverDisclosureIndex();
  assert.deepEqual(report.retainedEnabled, ["compatible-skill"]);
  assert.deepEqual(report.actions, [
    { id: "oversized-first", action: "disable", reason: "incompatible-metadata" },
    { id: "oversized-second", action: "disable", reason: "incompatible-metadata" }
  ]);
  assert.deepEqual((await disclosure.catalog()).map((entry) => entry.id), ["compatible-skill"]);
  const recoveredRegistry = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(recoveredRegistry.packages.length, 3);
  assert.equal(recoveredRegistry.packages.find((entry: any) => entry.id === "compatible-skill").status, "enabled");
  assert.ok(recoveredRegistry.packages
    .filter((entry: any) => entry.id.startsWith("oversized-"))
    .every((entry: any) => entry.status === "disabled" && entry.trusted === false));
});

test("batch recovery deterministically reduces 1026 enabled legacy entries without dropping packages", async (t) => {
  const { stateDir, store } = await fixture(t);
  const skillsRoot = join(stateDir, "skills");
  await mkdir(skillsRoot, { recursive: true });
  const packages = Array.from({ length: 1_026 }, (_, index) => {
    const id = `bulk-${String(index).padStart(4, "0")}`;
    const validated = validateSkillPackage(manifest(id, {
      name: `B${index}`,
      description: "Bulk skill ok",
      instructions: "Perform this exact selected bulk workflow and return bounded output.",
      requestedTools: [],
      requestedCapabilities: [],
      requestedSecrets: [],
      network: { default: "deny", allow: [] },
      tests: []
    }));
    return {
      ...validated.manifest,
      status: "enabled",
      trusted: true,
      installedAt: "2026-01-01T00:00:00.000Z",
      packagePath: join(skillsRoot, "packages", id, "1.0.0"),
      fileIntegrity: validated.fileIntegrity,
      integrity: validated.integrity
    };
  });
  const registryPath = join(skillsRoot, "registry.json");
  await writeFile(registryPath, `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`, "utf8");
  await writeFile(join(skillsRoot, ".disclosure-index-dirty"), "dirty\n", "utf8");
  const disclosure = new ProgressiveSkillDisclosure(store, {
    maxCatalogEntries: 1_024,
    maxCatalogBytes: 256 * 1024
  });

  await assert.rejects(() => disclosure.catalog(), /disclosure index is dirty/u);
  const report = await store.recoverDisclosureIndex();
  assert.equal(report.recovered, true);
  assert.equal(report.retainedEnabled[0], "bulk-0000");
  assert.ok(report.actions.some((action) => action.id === "bulk-1024" && action.reason === "entry-limit"));
  assert.ok(report.actions.some((action) => action.id === "bulk-1025" && action.reason === "entry-limit"));
  assert.equal(new Set([...report.retainedEnabled, ...report.actions.map((action) => action.id)]).size, 1_026);
  const catalog = await disclosure.catalog();
  assert.deepEqual(catalog.map((entry) => entry.id), report.retainedEnabled);
  const recoveredRegistry = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(recoveredRegistry.packages.length, 1_026);
  assert.equal(recoveredRegistry.packages.filter((entry: any) => entry.status === "enabled").length, report.retainedEnabled.length);
});

test("hydrate loads the selected enabled skill and no other skill instructions", async (t) => {
  const { store } = await fixture(t);
  await installEnabled(store, "alpha-skill", { instructions: "ALPHA_ONLY ".repeat(20) });
  await installEnabled(store, "beta-skill", { instructions: "BETA_ONLY ".repeat(20) });
  const disclosure = new ProgressiveSkillDisclosure(store);

  const hydrated = await disclosure.hydrate("alpha-skill");
  assert.equal(hydrated.id, "alpha-skill");
  assert.match(hydrated.skillMarkdown, /ALPHA_ONLY/u);
  assert.doesNotMatch(hydrated.skillMarkdown, /BETA_ONLY/u);
  assert.match(hydrated.integrity, /^[a-f0-9]{64}$/u);
});

test("catalog and hydration return canonical integrity-bound metadata after normalized registry injection", async (t) => {
  const { stateDir, store } = await fixture(t);
  const canonicalName = "N".repeat(120);
  await installEnabled(store, "canonical-skill", {
    name: canonicalName,
    requestedTools: ["tool.read", "tool.write"]
  });
  const registryPath = join(stateDir, "skills", "registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  registry.packages[0].name = `${canonicalName}INJECTED_SUFFIX`;
  registry.packages[0].requestedTools = [" tool.read ", "tool.read", "tool.write", ""];
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  const disclosure = new ProgressiveSkillDisclosure(store);

  const [catalogEntry] = await disclosure.catalog();
  assert.equal(catalogEntry?.name, canonicalName);
  assert.deepEqual(catalogEntry?.requestedTools, ["tool.read", "tool.write"]);
  const hydrated = await disclosure.hydrate("canonical-skill");
  assert.equal(hydrated.name, canonicalName);
  assert.deepEqual(hydrated.requestedTools, ["tool.read", "tool.write"]);
});

test("catalog does not open managed content and only selected hydration verifies files", async (t) => {
  const { store } = await fixture(t);
  const unselected = await installEnabled(store, "unselected-skill");
  await installEnabled(store, "selected-skill");
  await writeFile(join(unselected.packagePath, "SKILL.md"), "tampered ".repeat(100_000), "utf8");
  const disclosure = new ProgressiveSkillDisclosure(store, { maxHydratedBytes: 1_024 });

  assert.deepEqual((await disclosure.catalog()).map((entry) => entry.id), ["selected-skill", "unselected-skill"]);
  assert.equal((await disclosure.hydrate("selected-skill")).id, "selected-skill");
  await assert.rejects(() => disclosure.hydrate("unselected-skill"), /SKILL\.md exceeds 1024 UTF-8 bytes/u);

  const records = await store.list();
  const quarantined = records.find((record) => record.id === "unselected-skill");
  assert.equal(quarantined?.status, "quarantined");
  assert.equal(quarantined?.trusted, false);
});

test("catalog count and UTF-8 byte limits fail closed with measured errors", async (t) => {
  const { store } = await fixture(t);
  await installEnabled(store, "alpha-skill", { description: `Select unicode evidence ${"🦇".repeat(20)} for the bounded workflow.` });
  await installEnabled(store, "beta-skill");

  await assert.rejects(
    () => new ProgressiveSkillDisclosure(store, { maxCatalogEntries: 1 }).catalog(),
    (error: unknown) => error instanceof SkillDisclosureError
      && error.code === "CATALOG_COUNT_LIMIT"
      && /contains 2 entries; limit is 1/u.test(error.message)
  );
  await assert.rejects(
    () => new ProgressiveSkillDisclosure(store, { maxCatalogBytes: 120 }).catalog(),
    (error: unknown) => error instanceof SkillDisclosureError
      && error.code === "CATALOG_BYTE_LIMIT"
      && /UTF-8 bytes/u.test(error.message)
  );
});

test("hydration enforces a UTF-8 content byte limit before returning instructions", async (t) => {
  const { store } = await fixture(t);
  await installEnabled(store, "unicode-skill", {
    instructions: `Process the selected Unicode evidence safely. ${"🦇".repeat(50)}`
  });

  await assert.rejects(
    () => new ProgressiveSkillDisclosure(store, { maxHydratedBytes: 180 }).hydrate("unicode-skill"),
    (error: unknown) => error instanceof SkillDisclosureError
      && error.code === "HYDRATION_REJECTED"
      && /SKILL\.md exceeds 180 UTF-8 bytes/u.test(error.message)
  );
});

test("metadata limits prevent enabling or returning oversized disclosure fields", async (t) => {
  const { store } = await fixture(t);
  await store.install(manifest("metadata-heavy", {
    description: `Bounded workflow ${"é".repeat(1_100)}`
  }));

  await assert.rejects(
    () => store.transition("metadata-heavy", "enable"),
    /description must be 12-2048 UTF-8 bytes/u
  );
  assert.deepEqual(await new ProgressiveSkillDisclosure(store).catalog(), []);
});

test("disabled, quarantined, unknown, and traversal-shaped skill identifiers fail closed", async (t) => {
  const { store } = await fixture(t);
  await store.install(manifest("disabled-skill"));
  await installEnabled(store, "quarantined-skill");
  await store.transition("quarantined-skill", "quarantine");
  const disclosure = new ProgressiveSkillDisclosure(store);

  await assert.rejects(() => disclosure.hydrate("disabled-skill"), /not enabled and trusted/u);
  await assert.rejects(() => disclosure.hydrate("quarantined-skill"), /not enabled and trusted/u);
  await assert.rejects(() => disclosure.hydrate("unknown-skill"), /skill package not found/u);
  await assert.rejects(
    () => disclosure.hydrate("../disabled-skill"),
    (error: unknown) => error instanceof SkillDisclosureError && error.code === "INVALID_ID"
  );
  assert.deepEqual(await disclosure.catalog(), []);
});

test("tampered or missing managed content is rejected and persistently quarantined", async (t) => {
  const { store } = await fixture(t);
  const tampered = await installEnabled(store, "tampered-skill");
  const missing = await installEnabled(store, "missing-skill");
  await writeFile(join(tampered.packagePath, "SKILL.md"), "tampered content\n", "utf8");
  await rm(join(missing.packagePath, "SKILL.md"));
  const disclosure = new ProgressiveSkillDisclosure(store);

  await assert.rejects(() => disclosure.hydrate("tampered-skill"), /digest mismatch/u);
  await assert.rejects(() => disclosure.hydrate("missing-skill"), /managed package file is missing/u);
  const records = await store.list();
  for (const id of ["tampered-skill", "missing-skill"]) {
    const record = records.find((entry) => entry.id === id);
    assert.equal(record?.status, "quarantined");
    assert.equal(record?.trusted, false);
  }
});

test("hydration rejects managed package directory and file symlinks", async (t) => {
  const { store } = await fixture(t);
  const directorySkill = await installEnabled(store, "directory-link");
  const realDirectory = `${directorySkill.packagePath}.real`;
  await rename(directorySkill.packagePath, realDirectory);
  await symlink(realDirectory, directorySkill.packagePath, "dir");
  await assert.rejects(
    () => new ProgressiveSkillDisclosure(store).hydrate("directory-link"),
    /managed skill version directory must be a real directory/u
  );

  const fileSkill = await installEnabled(store, "file-link");
  const skillPath = join(fileSkill.packagePath, "SKILL.md");
  const realSkillPath = join(fileSkill.packagePath, "SKILL.real.md");
  await rename(skillPath, realSkillPath);
  await symlink(realSkillPath, skillPath, "file");
  await assert.rejects(
    () => new ProgressiveSkillDisclosure(store).hydrate("file-link"),
    /SKILL\.md must not be a symbolic link/u
  );
});

test("lifecycle integrity verification rejects managed file symlinks before enablement", async (t) => {
  const { store } = await fixture(t);
  const installed = await store.install(manifest("enable-link"));
  const skillPath = join(installed.packagePath, "SKILL.md");
  const realSkillPath = join(installed.packagePath, "SKILL.real.md");
  await rename(skillPath, realSkillPath);
  await symlink(realSkillPath, skillPath, "file");

  await assert.rejects(
    () => store.transition("enable-link", "enable"),
    /failed integrity verification and was quarantined/u
  );
  const [record] = await store.list();
  assert.equal(record?.status, "quarantined");
  assert.equal(record?.trusted, false);
});

test("lifecycle changes are observed on every hydration and cannot serve stale content", async (t) => {
  const { store } = await fixture(t);
  await installEnabled(store, "lifecycle-skill");
  const disclosure = new ProgressiveSkillDisclosure(store);

  assert.equal((await disclosure.hydrate("lifecycle-skill")).id, "lifecycle-skill");
  await store.transition("lifecycle-skill", "disable");
  await assert.rejects(() => disclosure.hydrate("lifecycle-skill"), /not enabled and trusted/u);
});
