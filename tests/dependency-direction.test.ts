import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DEPENDENCY_RULES,
  LEGACY_DEPENDENCY_BASELINE,
  WORKSPACE_DEPENDENCY_GRAPH,
  checkDependencyDirection,
  formatDependencyViolation,
} from "../scripts/ci/check-dependency-direction.ts";

function manifest(
  name: string,
  dependencies: Record<string, string> = {},
  exportsValue: unknown = { ".": "./src/index.ts" },
): string {
  return `${JSON.stringify({
    name,
    private: true,
    type: "module",
    exports: exportsValue,
    dependencies,
  }, null, 2)}\n`;
}

async function repositoryFixture(t: test.TestContext, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "odinn-dependency-direction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(Object.entries(files).map(async ([path, content]) => {
    const absolutePath = join(root, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }));
  return root;
}

test("allowed workspace dependency graph is explicit and pinned", () => {
  assert.deepEqual(WORKSPACE_DEPENDENCY_GRAPH, {
    "@odinn/application": [],
    "@odinn/channel-discord": ["@odinn/channels"],
    "@odinn/channel-slack": ["@odinn/channels"],
    "@odinn/channel-teams": ["@odinn/channels"],
    "@odinn/channel-telegram": ["@odinn/channels"],
    "@odinn/channel-whatsapp": ["@odinn/channels"],
    "@odinn/channels": ["@odinn/store-file"],
    "@odinn/cli": [
      "@odinn/application",
      "@odinn/gateway",
      "@odinn/kernel",
      "@odinn/policy",
      "@odinn/runtime",
    ],
    "@odinn/gateway": [
      "@odinn/application",
      "@odinn/channel-discord",
      "@odinn/channel-slack",
      "@odinn/channel-teams",
      "@odinn/channel-telegram",
      "@odinn/channel-whatsapp",
      "@odinn/channels",
      "@odinn/kernel",
      "@odinn/policy",
      "@odinn/runtime",
      "@odinn/store-file",
    ],
    "@odinn/kernel": [
      "@odinn/channels",
      "@odinn/policy",
      "@odinn/protocol",
      "@odinn/store-file",
      "@odinn/store-sqlite",
    ],
    "@odinn/policy": [],
    "@odinn/protocol": [],
    "@odinn/runtime": ["@odinn/channel-discord", "@odinn/kernel"],
    "@odinn/store-file": ["@odinn/protocol"],
    "@odinn/store-sqlite": ["@odinn/protocol"],
  });
});

test("dependency checker permits the current package graph and exported subpaths", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/application/package.json": manifest("@odinn/application"),
    "packages/application/src/index.ts": 'import type { PathLike } from "node:fs"; export type Example = PathLike;\n',
    "packages/protocol/package.json": manifest("@odinn/protocol"),
    "packages/protocol/src/index.ts": "export interface Protocol {}\n",
    "packages/policy/package.json": manifest("@odinn/policy"),
    "packages/policy/src/index.ts": "export interface Policy {}\n",
    "packages/store-file/package.json": manifest("@odinn/store-file", { "@odinn/protocol": "workspace:*" }),
    "packages/store-file/src/index.ts": 'export type { Protocol } from "@odinn/protocol";\n',
    "packages/store-sqlite/package.json": manifest(
      "@odinn/store-sqlite",
      { "@odinn/protocol": "workspace:*" },
      { ".": "./src/index.ts", "./memory-index": "./src/memory-index.ts" },
    ),
    "packages/store-sqlite/src/index.ts": 'export type { Protocol } from "@odinn/protocol";\n',
    "packages/store-sqlite/src/memory-index.ts": "export class MemoryIndex {}\n",
    "packages/channels/package.json": manifest("@odinn/channels", { "@odinn/store-file": "workspace:*" }),
    "packages/channels/src/index.ts": 'export { store } from "@odinn/store-file";\n',
    "adapters/channels/discord/package.json": manifest("@odinn/channel-discord", { "@odinn/channels": "workspace:*" }),
    "adapters/channels/discord/src/index.ts": 'export type { Channel } from "@odinn/channels";\n',
    "packages/kernel/package.json": manifest(
      "@odinn/kernel",
      {
        "@odinn/channels": "workspace:*",
        "@odinn/policy": "workspace:*",
        "@odinn/protocol": "workspace:*",
        "@odinn/store-file": "workspace:*",
        "@odinn/store-sqlite": "workspace:*",
      },
      { ".": "./src/index.ts", "./browser-worker-host": "./src/browser-worker-host.ts" },
    ),
    "packages/kernel/src/index.ts": [
      'import type { Channel } from "@odinn/channels";',
      'import { MemoryIndex } from "@odinn/store-sqlite/memory-index";',
      "export { MemoryIndex };",
    ].join("\n"),
    "packages/kernel/src/browser-worker-host.ts": "export function installBrowserWorker() {}\n",
    "packages/runtime/package.json": manifest("@odinn/runtime", {
      "@odinn/channel-discord": "workspace:*",
      "@odinn/kernel": "workspace:*",
    }),
    "packages/runtime/src/index.ts": [
      'import "@odinn/channel-discord";',
      'export { installBrowserWorker } from "@odinn/kernel/browser-worker-host";',
    ].join("\n"),
    "apps/gateway/package.json": manifest("@odinn/gateway", {
      "@odinn/application": "workspace:*",
      "@odinn/channel-discord": "workspace:*",
      "@odinn/kernel": "workspace:*",
    }),
    "apps/gateway/src/index.ts": [
      'import "@odinn/application";',
      'import "@odinn/kernel";',
      'void import("@odinn/channel-discord");',
    ].join("\n"),
    "apps/cli/package.json": manifest("@odinn/cli", { "@odinn/gateway": "workspace:*" }, undefined),
    "apps/cli/src/index.ts": 'void import("@odinn/gateway");\n',
  });

  const result = await checkDependencyDirection(root, []);

  assert.equal(result.scannedManifestCount, 11);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.baselineErrors, []);
});

test("dependency checker rejects forbidden source and manifest directions", async (t) => {
  const root = await repositoryFixture(t, {
    "apps/gateway/package.json": manifest("@odinn/gateway"),
    "apps/gateway/src/index.ts": "export const gateway = true;\n",
    "packages/application/package.json": manifest("@odinn/application", { "@odinn/gateway": "workspace:*" }),
    "packages/application/src/index.ts": 'import "@odinn/gateway";\n',
    "adapters/channels/discord/package.json": manifest("@odinn/channel-discord", { "@odinn/channel-slack": "workspace:*" }),
    "adapters/channels/discord/src/index.ts": 'export * from "@odinn/channel-slack";\n',
    "adapters/channels/slack/package.json": manifest("@odinn/channel-slack"),
    "adapters/channels/slack/src/index.ts": "export const slack = true;\n",
    "packages/kernel/package.json": manifest("@odinn/kernel"),
    "packages/kernel/src/index.ts": "export const kernel = true;\n",
    "packages/protocol/package.json": manifest("@odinn/protocol", { "@odinn/kernel": "workspace:*" }),
    "packages/protocol/src/index.ts": 'const kernel = require("@odinn/kernel"); export { kernel };\n',
  });

  const result = await checkDependencyDirection(root, []);

  assert.deepEqual(result.violations.map(({ sourceFile, kind, rule }) => ({ sourceFile, kind, rule })), [
    {
      sourceFile: "adapters/channels/discord/package.json",
      kind: "manifest-dependency",
      rule: DEPENDENCY_RULES.adapterToAdapter,
    },
    {
      sourceFile: "adapters/channels/discord/src/index.ts",
      kind: "export-declaration",
      rule: DEPENDENCY_RULES.adapterToAdapter,
    },
    {
      sourceFile: "packages/application/package.json",
      kind: "manifest-dependency",
      rule: DEPENDENCY_RULES.packageToApp,
    },
    {
      sourceFile: "packages/application/src/index.ts",
      kind: "import-declaration",
      rule: DEPENDENCY_RULES.packageToApp,
    },
    {
      sourceFile: "packages/protocol/package.json",
      kind: "manifest-dependency",
      rule: DEPENDENCY_RULES.workspaceGraph,
    },
    {
      sourceFile: "packages/protocol/src/index.ts",
      kind: "require-call",
      rule: DEPENDENCY_RULES.workspaceGraph,
    },
  ]);
});

test("dependency checker permits public exports and rejects private deep imports", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/kernel/package.json": manifest(
      "@odinn/kernel",
      {},
      { ".": "./src/index.ts", "./browser-worker-host": "./src/browser-worker-host.ts" },
    ),
    "packages/kernel/src/index.ts": "export const kernel = true;\n",
    "packages/kernel/src/browser-worker-host.ts": "export const host = true;\n",
    "packages/runtime/package.json": manifest("@odinn/runtime", { "@odinn/kernel": "workspace:*" }),
    "packages/runtime/src/index.ts": [
      'import "@odinn/kernel/browser-worker-host";',
      'import "@odinn/kernel/src/private.ts";',
    ].join("\n"),
  });

  const result = await checkDependencyDirection(root, []);

  assert.deepEqual(result.violations.map(({ specifier, rule }) => ({ specifier, rule })), [{
    specifier: "@odinn/kernel/src/private.ts",
    rule: DEPENDENCY_RULES.privateWorkspaceSubpath,
  }]);
});

test("dependency checker rejects source-only paths across package boundaries", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/kernel/package.json": manifest("@odinn/kernel"),
    "packages/kernel/src/index.ts": "export const kernel = true;\n",
    "packages/runtime/package.json": manifest("@odinn/runtime", { "@odinn/kernel": "workspace:*" }),
    "packages/runtime/src/index.ts": [
      'import "../../kernel/src/index.ts";',
      'import "packages/kernel/src/index.ts";',
    ].join("\n"),
  });

  const result = await checkDependencyDirection(root, []);

  assert.deepEqual(result.violations.map(({ specifier, rule }) => ({ specifier, rule })), [
    { specifier: "../../kernel/src/index.ts", rule: DEPENDENCY_RULES.crossPackageSourcePath },
    { specifier: "packages/kernel/src/index.ts", rule: DEPENDENCY_RULES.crossPackageSourcePath },
  ]);
});

test("dependency checker rejects allowed imports omitted from the source manifest", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/kernel/package.json": manifest("@odinn/kernel"),
    "packages/kernel/src/index.ts": "export const kernel = true;\n",
    "packages/runtime/package.json": manifest("@odinn/runtime"),
    "packages/runtime/src/index.ts": 'import "@odinn/kernel";\n',
  });

  const result = await checkDependencyDirection(root, []);

  assert.deepEqual(result.violations.map(({ specifier, rule }) => ({ specifier, rule })), [{
    specifier: "@odinn/kernel",
    rule: DEPENDENCY_RULES.undeclaredWorkspaceDependency,
  }]);
});

test("dependency checker rejects unresolved workspace names in manifests and source", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/application/package.json": manifest("@odinn/application", { "@odinn/not-installed": "workspace:*" }),
    "packages/application/src/index.ts": 'import "@odinn/not-installed/private";\n',
  });

  const result = await checkDependencyDirection(root, []);

  assert.deepEqual(result.violations.map(({ kind, rule }) => ({ kind, rule })), [
    { kind: "manifest-dependency", rule: DEPENDENCY_RULES.unknownWorkspaceTarget },
    { kind: "import-declaration", rule: DEPENDENCY_RULES.unknownWorkspaceTarget },
  ]);
});

test("dependency checker fails closed on non-literal module loads in every workspace layer", async (t) => {
  const root = await repositoryFixture(t, {
    "apps/gateway/package.json": manifest("@odinn/gateway"),
    "apps/gateway/src/index.ts": "void import(moduleName);\n",
    "adapters/channels/discord/package.json": manifest("@odinn/channel-discord"),
    "adapters/channels/discord/src/index.ts": "require(moduleName);\n",
  });

  const result = await checkDependencyDirection(root, []);

  assert.deepEqual(result.violations.map(({ sourceFile, kind, rule }) => ({ sourceFile, kind, rule })), [
    {
      sourceFile: "adapters/channels/discord/src/index.ts",
      kind: "require-call",
      rule: DEPENDENCY_RULES.workspaceDynamicImports,
    },
    {
      sourceFile: "apps/gateway/src/index.ts",
      kind: "dynamic-import",
      rule: DEPENDENCY_RULES.workspaceDynamicImports,
    },
  ]);
});

test("dependency checker rejects new packages until the graph is deliberately updated", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/feature/package.json": manifest("@odinn/feature"),
    "packages/feature/src/index.ts": "export const feature = true;\n",
  });

  const result = await checkDependencyDirection(root, []);

  assert.deepEqual(result.violations.map(({ specifier, kind, rule }) => ({ specifier, kind, rule })), [{
    specifier: "@odinn/feature",
    kind: "workspace-package",
    rule: DEPENDENCY_RULES.unregisteredWorkspacePackage,
  }]);
});

test("default architecture check has no legacy dependency exemptions", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/application/package.json": manifest("@odinn/application"),
    "packages/application/src/index.ts": 'import "@odinn/not-installed";\n',
  });

  const result = await checkDependencyDirection(root, LEGACY_DEPENDENCY_BASELINE);

  assert.deepEqual(LEGACY_DEPENDENCY_BASELINE, []);
  assert.equal(result.violations.length, 1);
  assert.deepEqual(result.baselineErrors, []);
  assert.equal(result.acceptedLegacyOccurrences, 0);
  assert.equal(
    formatDependencyViolation(result.violations[0]!),
    'packages/application/src/index.ts:1:8: forbidden import "@odinn/not-installed" [rule: @odinn and workspace protocol dependencies must resolve to a workspace package]',
  );
});
