import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DEPENDENCY_RULES,
  LEGACY_DEPENDENCY_BASELINE,
  checkDependencyDirection,
  formatDependencyViolation,
} from "../scripts/ci/check-dependency-direction.ts";

async function repositoryFixture(t: test.TestContext, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "odinn-dependency-direction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(["packages/kernel/src", "packages/application/src"].map((directory) =>
    mkdir(join(root, directory), { recursive: true })));
  await Promise.all(Object.entries(files).map(async ([path, content]) => {
    const absolutePath = join(root, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }));
  return root;
}

test("dependency direction checker permits transport-neutral imports and ignores import-like text", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/kernel/src/good.ts": [
      'import type { ChannelPlugin } from "@odinn/channels";',
      '// import "@odinn/channel-comment";',
      'const example = "import(\\"adapters/example\\")";',
    ].join("\n"),
    "packages/application/src/good.ts": 'export type { AgentRequest } from "@odinn/protocol";\n',
  });

  const result = await checkDependencyDirection(root, []);

  assert.equal(result.scannedFileCount, 2);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.baselineErrors, []);
});

test("dependency direction checker reports every forbidden edge and import form", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/kernel/src/bad.ts": [
      'import type { DiscordRestClient } from "@odinn/channel-discord";',
      'type DiscordClient = import("@odinn/channel-discord").DiscordRestClient;',
      'export { adapter } from "../../../adapters/channels/discord/src/index.ts";',
      'import adapter = require("adapters/channels/slack");',
      'const provider = require("@odinn/provider-example");',
    ].join("\n"),
    "packages/application/src/bad.ts": [
      'export * from "@odinn/channel-telegram";',
      'const adapter = import("../../../adapters/channels/teams/src/index.ts");',
      'const gateway = require("../../../apps/gateway/src/server.ts");',
      'export { gateway } from "apps/gateway";',
      'import "@odinn/gateway";',
      'export { provider } from "@odinn/provider-example/client";',
    ].join("\n"),
    "apps/gateway/package.json": '{"name":"@odinn/gateway"}\n',
    "adapters/providers/example/package.json": '{"name":"@odinn/provider-example"}\n',
  });

  const result = await checkDependencyDirection(root, []);

  assert.deepEqual(result.violations.map(({ specifier, kind, rule }) => ({ specifier, kind, rule })), [
    {
      specifier: "@odinn/channel-telegram",
      kind: "export-declaration",
      rule: DEPENDENCY_RULES.applicationChannels,
    },
    {
      specifier: "../../../adapters/channels/teams/src/index.ts",
      kind: "dynamic-import",
      rule: DEPENDENCY_RULES.applicationAdapters,
    },
    {
      specifier: "../../../apps/gateway/src/server.ts",
      kind: "require-call",
      rule: DEPENDENCY_RULES.applicationApps,
    },
    {
      specifier: "apps/gateway",
      kind: "export-declaration",
      rule: DEPENDENCY_RULES.applicationApps,
    },
    {
      specifier: "@odinn/gateway",
      kind: "import-declaration",
      rule: DEPENDENCY_RULES.applicationApps,
    },
    {
      specifier: "@odinn/provider-example/client",
      kind: "export-declaration",
      rule: DEPENDENCY_RULES.applicationAdapters,
    },
    {
      specifier: "@odinn/channel-discord",
      kind: "import-declaration",
      rule: DEPENDENCY_RULES.kernelChannels,
    },
    {
      specifier: "@odinn/channel-discord",
      kind: "import-type",
      rule: DEPENDENCY_RULES.kernelChannels,
    },
    {
      specifier: "../../../adapters/channels/discord/src/index.ts",
      kind: "export-declaration",
      rule: DEPENDENCY_RULES.kernelAdapters,
    },
    {
      specifier: "adapters/channels/slack",
      kind: "import-equals",
      rule: DEPENDENCY_RULES.kernelAdapters,
    },
    {
      specifier: "@odinn/provider-example",
      kind: "require-call",
      rule: DEPENDENCY_RULES.kernelAdapters,
    },
  ]);
  assert.equal(
    formatDependencyViolation(result.violations[0]!),
    'packages/application/src/bad.ts:1:15: forbidden import "@odinn/channel-telegram" [rule: packages/application cannot import @odinn/channel-*]',
  );
});

test("dependency direction checker fails closed on non-literal dynamic module loads", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/kernel/src/dynamic.ts": [
      'const moduleName = "@odinn/channel-discord";',
      "void import(moduleName);",
    ].join("\n"),
    "packages/application/src/dynamic.ts": [
      'const moduleName = "@odinn/gateway";',
      "require(moduleName);",
    ].join("\n"),
  });

  const result = await checkDependencyDirection(root, []);

  assert.deepEqual(result.violations.map(({ sourceFile, specifier, kind, rule }) => ({
    sourceFile,
    specifier,
    kind,
    rule,
  })), [
    {
      sourceFile: "packages/application/src/dynamic.ts",
      specifier: "<non-literal module specifier>",
      kind: "require-call",
      rule: DEPENDENCY_RULES.applicationDynamicImports,
    },
    {
      sourceFile: "packages/kernel/src/dynamic.ts",
      specifier: "<non-literal module specifier>",
      kind: "dynamic-import",
      rule: DEPENDENCY_RULES.kernelDynamicImports,
    },
  ]);
});

test("default architecture check has no legacy dependency exemptions", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/kernel/src/discord.ts": [
      'import type { DiscordRestClient } from "@odinn/channel-discord";',
      'const client = import("@odinn/channel-discord");',
    ].join("\n"),
  });

  const result = await checkDependencyDirection(root, LEGACY_DEPENDENCY_BASELINE);

  assert.deepEqual(LEGACY_DEPENDENCY_BASELINE, []);
  assert.equal(result.violations.length, 2);
  assert.deepEqual(result.baselineErrors, []);
  assert.equal(result.acceptedLegacyOccurrences, 0);
});
