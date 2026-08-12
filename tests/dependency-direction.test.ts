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
  type AllowedDependencyGraph,
} from "../scripts/ci/check-dependency-direction.ts";

interface ManifestOptions {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: unknown;
  imports?: unknown;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function manifest(name: string, options: ManifestOptions = {}): string {
  return `${JSON.stringify({
    name,
    private: true,
    type: "module",
    exports: options.exports === undefined ? { ".": "./src/index.ts" } : options.exports,
    ...(options.imports === undefined ? {} : { imports: options.imports }),
    ...(options.dependencies ? { dependencies: options.dependencies } : {}),
    ...(options.devDependencies ? { devDependencies: options.devDependencies } : {}),
    ...(options.optionalDependencies ? { optionalDependencies: options.optionalDependencies } : {}),
    ...(options.peerDependencies ? { peerDependencies: options.peerDependencies } : {}),
  }, null, 2)}\n`;
}

const defaultWorkspace = [
  "packages:",
  "  - apps/**",
  "  - packages/**",
  "  - adapters/**",
  "",
].join("\n");

const crossPackageExportTargetRule = "workspace package exports cannot target another workspace package";

async function repositoryFixture(t: test.TestContext, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "odinn-dependency-direction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureFiles = { "pnpm-workspace.yaml": defaultWorkspace, ...files };
  await Promise.all(Object.entries(fixtureFiles).map(async ([path, content]) => {
    const absolutePath = join(root, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }));
  return root;
}

function checkFixture(
  root: string,
  allowedGraph: AllowedDependencyGraph,
  baseline = LEGACY_DEPENDENCY_BASELINE,
) {
  return checkDependencyDirection(root, baseline, allowedGraph);
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

test("dependency checker permits the current graph, canonical manifests, and public subpaths", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/application/package.json": manifest("@odinn/application"),
    "packages/application/src/index.ts": 'import type { PathLike } from "node:fs"; export type Example = PathLike;\n',
    "packages/protocol/package.json": manifest("@odinn/protocol"),
    "packages/protocol/src/index.ts": "export interface Protocol {}\n",
    "packages/policy/package.json": manifest("@odinn/policy"),
    "packages/policy/src/index.ts": "export interface Policy {}\n",
    "packages/store-file/package.json": manifest("@odinn/store-file", {
      dependencies: { "@odinn/protocol": "workspace:*" },
    }),
    "packages/store-file/src/index.ts": 'export type { Protocol } from "@odinn/protocol";\n',
    "packages/store-sqlite/package.json": manifest("@odinn/store-sqlite", {
      dependencies: { "@odinn/protocol": "workspace:*" },
      exports: { ".": "./src/index.ts", "./memory-index": "./src/memory-index.ts" },
    }),
    "packages/store-sqlite/src/index.ts": 'export type { Protocol } from "@odinn/protocol";\n',
    "packages/store-sqlite/src/memory-index.ts": "export class MemoryIndex {}\n",
    "packages/channels/package.json": manifest("@odinn/channels", {
      dependencies: { "@odinn/store-file": "workspace:*" },
    }),
    "packages/channels/src/index.ts": 'export { store } from "@odinn/store-file";\n',
    "adapters/channels/discord/package.json": manifest("@odinn/channel-discord", {
      dependencies: { "@odinn/channels": "workspace:*" },
    }),
    "adapters/channels/discord/src/index.ts": 'export type { Channel } from "@odinn/channels";\n',
    "packages/kernel/package.json": manifest("@odinn/kernel", {
      dependencies: {
        "@odinn/channels": "workspace:*",
        "@odinn/policy": "workspace:*",
        "@odinn/protocol": "workspace:*",
        "@odinn/store-file": "workspace:*",
        "@odinn/store-sqlite": "workspace:*",
      },
      exports: { ".": "./src/index.ts", "./browser-worker-host": "./src/browser-worker-host.ts" },
    }),
    "packages/kernel/src/index.ts": [
      'import type { Channel } from "@odinn/channels";',
      'import { MemoryIndex } from "@odinn/store-sqlite/memory-index";',
      "export { MemoryIndex };",
    ].join("\n"),
    "packages/kernel/src/browser-worker-host.ts": "export function installBrowserWorker() {}\n",
    "packages/runtime/package.json": manifest("@odinn/runtime", {
      dependencies: {
        "@odinn/channel-discord": "workspace:*",
        "@odinn/kernel": "workspace:*",
      },
    }),
    "packages/runtime/src/index.ts": [
      'import "@odinn/channel-discord";',
      'export { installBrowserWorker } from "@odinn/kernel/browser-worker-host";',
    ].join("\n"),
    "apps/gateway/package.json": manifest("@odinn/gateway", {
      dependencies: {
        "@odinn/application": "workspace:*",
        "@odinn/channel-discord": "workspace:*",
        "@odinn/kernel": "workspace:*",
      },
    }),
    "apps/gateway/src/index.ts": [
      'import "@odinn/application";',
      'import "@odinn/kernel";',
      'void import("@odinn/channel-discord");',
    ].join("\n"),
    "apps/cli/package.json": manifest("@odinn/cli", {
      dependencies: { "@odinn/gateway": "workspace:*" },
      exports: undefined,
    }),
    "apps/cli/src/index.ts": 'void import("@odinn/gateway");\n',
  });
  const graph = {
    "@odinn/application": [],
    "@odinn/protocol": [],
    "@odinn/policy": [],
    "@odinn/store-file": ["@odinn/protocol"],
    "@odinn/store-sqlite": ["@odinn/protocol"],
    "@odinn/channels": ["@odinn/store-file"],
    "@odinn/channel-discord": ["@odinn/channels"],
    "@odinn/kernel": [
      "@odinn/channels",
      "@odinn/policy",
      "@odinn/protocol",
      "@odinn/store-file",
      "@odinn/store-sqlite",
    ],
    "@odinn/runtime": ["@odinn/channel-discord", "@odinn/kernel"],
    "@odinn/gateway": ["@odinn/application", "@odinn/channel-discord", "@odinn/kernel"],
    "@odinn/cli": ["@odinn/gateway"],
  };

  const result = await checkFixture(root, graph, []);

  assert.equal(result.scannedManifestCount, 11);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.baselineErrors, []);
});

test("dependency checker rejects forbidden source and manifest directions", async (t) => {
  const root = await repositoryFixture(t, {
    "apps/gateway/package.json": manifest("@odinn/gateway"),
    "apps/gateway/src/index.ts": "export const gateway = true;\n",
    "packages/application/package.json": manifest("@odinn/application", {
      dependencies: { "@odinn/gateway": "workspace:*" },
    }),
    "packages/application/src/index.ts": 'import "@odinn/gateway";\n',
    "adapters/channels/discord/package.json": manifest("@odinn/channel-discord", {
      dependencies: { "@odinn/channel-slack": "workspace:*" },
    }),
    "adapters/channels/discord/src/index.ts": 'export * from "@odinn/channel-slack";\n',
    "adapters/channels/slack/package.json": manifest("@odinn/channel-slack"),
    "adapters/channels/slack/src/index.ts": "export const slack = true;\n",
    "packages/kernel/package.json": manifest("@odinn/kernel"),
    "packages/kernel/src/index.ts": "export const kernel = true;\n",
    "packages/protocol/package.json": manifest("@odinn/protocol", {
      dependencies: { "@odinn/kernel": "workspace:*" },
    }),
    "packages/protocol/src/index.ts": 'const kernel = require("@odinn/kernel"); export { kernel };\n',
  });
  const graph = {
    "@odinn/gateway": [],
    "@odinn/application": [],
    "@odinn/channel-discord": [],
    "@odinn/channel-slack": [],
    "@odinn/kernel": [],
    "@odinn/protocol": [],
  };

  const result = await checkFixture(root, graph, []);

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

test("exports resolution honors Node array fallbacks, conditions, and selected null exclusions", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/kernel/package.json": manifest("@odinn/kernel", {
      exports: {
        ".": { import: "./src/index.ts", require: null },
        "./features/*": "./src/features/*.ts",
        "./features/private/*": null,
        "./*": "./src/*.ts",
        "./blocked": null,
        "./conditional": { node: { import: "./src/conditional.ts", require: null }, default: null },
        "./fallback": ["invalid-target", "./src/fallback.ts"],
        "./null-first": [null, "./src/reached.ts"],
      },
    }),
    "packages/kernel/src/index.ts": "export const kernel = true;\n",
    "packages/runtime/package.json": manifest("@odinn/runtime", {
      dependencies: { "@odinn/kernel": "workspace:*" },
    }),
    "packages/runtime/src/index.ts": [
      'import "@odinn/kernel";',
      'require("@odinn/kernel");',
      'import "@odinn/kernel/features/public/tool";',
      'import "@odinn/kernel/features/private/tool";',
      'import "@odinn/kernel/blocked";',
      'import "@odinn/kernel/conditional";',
      'require("@odinn/kernel/conditional");',
      'import "@odinn/kernel/fallback";',
      'import "@odinn/kernel/null-first";',
    ].join("\n"),
  });

  const result = await checkFixture(root, {
    "@odinn/kernel": [],
    "@odinn/runtime": ["@odinn/kernel"],
  }, []);

  assert.deepEqual(result.violations.map(({ specifier, kind, rule }) => ({ specifier, kind, rule })), [
    {
      specifier: "@odinn/kernel",
      kind: "require-call",
      rule: DEPENDENCY_RULES.privateWorkspaceSubpath,
    },
    {
      specifier: "@odinn/kernel/features/private/tool",
      kind: "import-declaration",
      rule: DEPENDENCY_RULES.privateWorkspaceSubpath,
    },
    {
      specifier: "@odinn/kernel/blocked",
      kind: "import-declaration",
      rule: DEPENDENCY_RULES.privateWorkspaceSubpath,
    },
    {
      specifier: "@odinn/kernel/conditional",
      kind: "require-call",
      rule: DEPENDENCY_RULES.privateWorkspaceSubpath,
    },
  ]);
});

test("package exports cannot hide a transition into a nested workspace package", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host", {
      exports: {
        ".": "./src/index.ts",
        "./owned": "./src/owned.ts",
        "./nested": "./nested/src/index.ts",
      },
    }),
    "packages/host/src/index.ts": "export const host = true;\n",
    "packages/host/src/owned.ts": "export const owned = true;\n",
    "packages/host/nested/package.json": manifest("@odinn/nested"),
    "packages/host/nested/src/index.ts": "export const nested = true;\n",
    "packages/consumer/package.json": manifest("@odinn/consumer", {
      dependencies: { "@odinn/host": "workspace:*" },
    }),
    "packages/consumer/src/index.ts": [
      'import "@odinn/host/owned";',
      'import "@odinn/host/nested";',
    ].join("\n"),
  });

  const result = await checkFixture(root, {
    "@odinn/consumer": ["@odinn/host"],
    "@odinn/host": [],
    "@odinn/nested": [],
  }, []);

  assert.deepEqual(result.violations.map(({ specifier, kind, rule }) => ({ specifier, kind, rule })), [{
    specifier: "@odinn/host/nested",
    kind: "import-declaration",
    rule: crossPackageExportTargetRule,
  }]);
});

test("dependency checker rejects source-only paths across package boundaries", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/kernel/package.json": manifest("@odinn/kernel"),
    "packages/kernel/src/index.ts": "export const kernel = true;\n",
    "packages/runtime/package.json": manifest("@odinn/runtime", {
      dependencies: { "@odinn/kernel": "workspace:*" },
    }),
    "packages/runtime/src/index.ts": [
      'import "../../kernel/src/index.ts";',
      'import "packages/kernel/src/index.ts";',
    ].join("\n"),
  });

  const result = await checkFixture(root, {
    "@odinn/kernel": [],
    "@odinn/runtime": ["@odinn/kernel"],
  }, []);

  assert.deepEqual(result.violations.map(({ specifier, rule }) => ({ specifier, rule })), [
    { specifier: "../../kernel/src/index.ts", rule: DEPENDENCY_RULES.crossPackageSourcePath },
    { specifier: "packages/kernel/src/index.ts", rule: DEPENDENCY_RULES.crossPackageSourcePath },
  ]);
});

test("all dependency fields require canonical names and exact workspace protocol identity", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/kernel/package.json": manifest("@odinn/kernel"),
    "packages/kernel/src/index.ts": "export const kernel = true;\n",
    "packages/runtime/package.json": manifest("@odinn/runtime", {
      dependencies: { "@odinn/kernel": "^1.1.0" },
      devDependencies: { "kernel-file-alias": "file:../kernel" },
      optionalDependencies: { "kernel-npm-alias": "npm:@odinn/kernel@1.1.0" },
      peerDependencies: { "kernel-workspace-alias": "workspace:@odinn/kernel@*" },
    }),
    "packages/runtime/src/index.ts": "export const runtime = true;\n",
  });

  const result = await checkFixture(root, {
    "@odinn/kernel": [],
    "@odinn/runtime": ["@odinn/kernel"],
  }, []);

  assert.deepEqual(result.violations.map(({ specifier, rule }) => ({ specifier, rule })), [
    { specifier: "@odinn/kernel", rule: DEPENDENCY_RULES.workspaceDependencyIdentity },
    { specifier: "kernel-file-alias", rule: DEPENDENCY_RULES.dependencyAliasSpecifier },
    { specifier: "kernel-npm-alias", rule: DEPENDENCY_RULES.dependencyAliasSpecifier },
    { specifier: "kernel-workspace-alias", rule: DEPENDENCY_RULES.workspaceDependencyIdentity },
  ]);
});

test("dependency checker rejects allowed imports omitted from the source manifest", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/kernel/package.json": manifest("@odinn/kernel"),
    "packages/kernel/src/index.ts": "export const kernel = true;\n",
    "packages/runtime/package.json": manifest("@odinn/runtime"),
    "packages/runtime/src/index.ts": 'import "@odinn/kernel";\n',
  });

  const result = await checkFixture(root, {
    "@odinn/kernel": [],
    "@odinn/runtime": ["@odinn/kernel"],
  }, []);

  assert.deepEqual(result.violations.map(({ specifier, rule }) => ({ specifier, rule })), [{
    specifier: "@odinn/kernel",
    rule: DEPENDENCY_RULES.undeclaredWorkspaceDependency,
  }]);
});

test("dependency checker rejects unresolved workspace names in manifests and source", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/application/package.json": manifest("@odinn/application", {
      dependencies: { "@odinn/not-installed": "workspace:*" },
    }),
    "packages/application/src/index.ts": 'import "@odinn/not-installed/private";\n',
  });

  const result = await checkFixture(root, { "@odinn/application": [] }, []);

  assert.deepEqual(result.violations.map(({ kind, rule }) => ({ kind, rule })), [
    { kind: "manifest-dependency", rule: DEPENDENCY_RULES.unknownWorkspaceTarget },
    { kind: "import-declaration", rule: DEPENDENCY_RULES.unknownWorkspaceTarget },
  ]);
});

test("module.require is inspected and indirect require or createRequire loaders fail closed", async (t) => {
  const root = await repositoryFixture(t, {
    "apps/gateway/package.json": manifest("@odinn/gateway"),
    "apps/gateway/src/index.ts": "export const gateway = true;\n",
    "packages/application/package.json": manifest("@odinn/application", {
      dependencies: { "@odinn/gateway": "workspace:*" },
    }),
    "packages/application/src/index.ts": [
      'module.require("@odinn/gateway");',
      "module.require(moduleName);",
      "const indirect = module.require;",
      "const { require: loadRequired } = module;",
      'import { createRequire as makeRequire } from "node:module";',
      "const load = makeRequire(import.meta.url);",
      'load("@odinn/gateway");',
      'import * as nodeModule from "node:module";',
      "const loadAgain = nodeModule.createRequire(import.meta.url);",
      'export { createRequire as exportedLoader } from "node:module";',
      'module["re" + "quire"]("../../../apps/gateway/src/index.ts");',
      'const computedLoader = module["re" + "quire"];',
      'const { ["re" + "quire"]: destructuredLoader } = module;',
      'const harmlessString = "re" + "quire";',
    ].join("\n"),
  });

  const result = await checkFixture(root, {
    "@odinn/gateway": [],
    "@odinn/application": [],
  }, []);

  assert.deepEqual(result.violations.map(({ kind, rule }) => ({ kind, rule })), [
    { kind: "manifest-dependency", rule: DEPENDENCY_RULES.packageToApp },
    { kind: "require-call", rule: DEPENDENCY_RULES.packageToApp },
    { kind: "require-call", rule: DEPENDENCY_RULES.workspaceDynamicImports },
    { kind: "module-loader", rule: DEPENDENCY_RULES.unsupportedModuleLoader },
    { kind: "module-loader", rule: DEPENDENCY_RULES.unsupportedModuleLoader },
    { kind: "module-loader", rule: DEPENDENCY_RULES.unsupportedModuleLoader },
    { kind: "module-loader", rule: DEPENDENCY_RULES.unsupportedModuleLoader },
    { kind: "module-loader", rule: DEPENDENCY_RULES.unsupportedModuleLoader },
    { kind: "require-call", rule: DEPENDENCY_RULES.crossPackageSourcePath },
    { kind: "module-loader", rule: DEPENDENCY_RULES.unsupportedModuleLoader },
    { kind: "module-loader", rule: DEPENDENCY_RULES.unsupportedModuleLoader },
  ]);
});

test("node module re-exports cannot relay createRequire or its containing namespace", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/application/package.json": manifest("@odinn/application"),
    "packages/application/src/index.ts": [
      'export { builtinModules as safeMetadata } from "node:module";',
      'export { createRequire as relayedLoader } from "node:module";',
      'export * as relayedModule from "node:module";',
      'export * from "node:module";',
    ].join("\n"),
  });

  const result = await checkFixture(root, { "@odinn/application": [] }, []);

  assert.deepEqual(result.violations.map(({ kind, rule }) => ({ kind, rule })), [
    { kind: "module-loader", rule: DEPENDENCY_RULES.unsupportedModuleLoader },
    { kind: "module-loader", rule: DEPENDENCY_RULES.unsupportedModuleLoader },
    { kind: "module-loader", rule: DEPENDENCY_RULES.unsupportedModuleLoader },
  ]);
});

test("package imports aliases are rejected in both manifest and source", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/application/package.json": manifest("@odinn/application", {
      imports: { "#gateway": "@odinn/gateway" },
    }),
    "packages/application/src/index.ts": 'import "#gateway";\n',
  });

  const result = await checkFixture(root, { "@odinn/application": [] }, []);

  assert.deepEqual(result.violations.map(({ kind, rule }) => ({ kind, rule })), [
    { kind: "package-import-alias", rule: DEPENDENCY_RULES.packageImportAlias },
    { kind: "import-declaration", rule: DEPENDENCY_RULES.packageImportAlias },
  ]);
});

test("TypeScript paths aliases fail closed before cross-package resolution", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/application/package.json": manifest("@odinn/application"),
    "packages/application/src/index.ts": 'import "hidden-gateway";\n',
    "tsconfig.base.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "hidden-gateway": ["apps/gateway/src/index.ts"] },
      },
    }),
    "packages/application/tsconfig.json": JSON.stringify({
      extends: "../../tsconfig.base.json",
      include: ["src/**/*.ts"],
    }),
  });

  const result = await checkFixture(root, { "@odinn/application": [] }, []);

  assert.deepEqual(result.violations.map(({ sourceFile, specifier, kind, rule }) => ({
    sourceFile,
    specifier,
    kind,
    rule,
  })), [
    {
      sourceFile: "packages/application/tsconfig.json",
      specifier: "hidden-gateway",
      kind: "typescript-path-alias",
      rule: DEPENDENCY_RULES.typescriptPathAlias,
    },
  ]);
});

test("tooling-only TypeScript paths remain outside the production package graph", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/application/package.json": manifest("@odinn/application"),
    "packages/application/src/index.ts": "export const application = true;\n",
    "packages/application/tsconfig.json": JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      include: ["src/**/*.ts"],
    }),
    "scripts/tsconfig.tools.json": JSON.stringify({
      compilerOptions: {
        baseUrl: "..",
        paths: { "tool-only-alias": ["apps/gateway/src/index.ts"] },
      },
      include: ["**/*.ts"],
    }),
  });

  const result = await checkFixture(root, { "@odinn/application": [] }, []);

  assert.deepEqual(result.violations, []);
});

test("package-owned TypeScript config variants enforce effective inherited paths", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/application/package.json": manifest("@odinn/application"),
    "packages/application/src/index.ts": "export const application = true;\n",
    "packages/application/tsconfig.shared.json": JSON.stringify({
      compilerOptions: {
        baseUrl: "../..",
        paths: { "variant-hidden-gateway": ["apps/gateway/src/index.ts"] },
      },
    }),
    "packages/application/tsconfig.build.json": JSON.stringify({
      extends: "./tsconfig.shared.json",
      include: ["src/**/*.ts"],
    }),
  });

  const result = await checkFixture(root, { "@odinn/application": [] }, []);

  assert.deepEqual(result.violations.map(({ sourceFile, specifier, kind, rule }) => ({
    sourceFile,
    specifier,
    kind,
    rule,
  })), [
    {
      sourceFile: "packages/application/tsconfig.build.json",
      specifier: "variant-hidden-gateway",
      kind: "typescript-path-alias",
      rule: DEPENDENCY_RULES.typescriptPathAlias,
    },
    {
      sourceFile: "packages/application/tsconfig.shared.json",
      specifier: "variant-hidden-gateway",
      kind: "typescript-path-alias",
      rule: DEPENDENCY_RULES.typescriptPathAlias,
    },
  ]);
});

test("dependency checker fails closed on non-literal module loads in every workspace layer", async (t) => {
  const root = await repositoryFixture(t, {
    "apps/gateway/package.json": manifest("@odinn/gateway"),
    "apps/gateway/src/index.ts": "void import(moduleName);\n",
    "adapters/channels/discord/package.json": manifest("@odinn/channel-discord"),
    "adapters/channels/discord/src/index.ts": "require(moduleName);\n",
  });

  const result = await checkFixture(root, {
    "@odinn/gateway": [],
    "@odinn/channel-discord": [],
  }, []);

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

test("workspace globs discover nested packages without double-scanning their source", async (t) => {
  const root = await repositoryFixture(t, {
    "pnpm-workspace.yaml": "packages:\n  - apps/**\n",
    "apps/gateway/package.json": manifest("@odinn/gateway"),
    "apps/gateway/src/index.ts": "export const gateway = true;\n",
    "apps/gateway/console/package.json": manifest("@odinn/console"),
    "apps/gateway/console/src/index.ts": "export const consoleApp = true;\n",
  });

  const result = await checkFixture(root, {
    "@odinn/gateway": [],
    "@odinn/console": [],
  }, []);

  assert.equal(result.scannedManifestCount, 2);
  assert.equal(result.scannedFileCount, 2);
  assert.deepEqual(result.violations, []);
});

test("workspace discovery includes explicitly matched dist packages and keeps pnpm node_modules exclusion", async (t) => {
  const root = await repositoryFixture(t, {
    "pnpm-workspace.yaml": "packages:\n  - packages/**\n  - '!packages/generated/**'\n",
    "packages/dist/feature/package.json": manifest("@odinn/dist-feature"),
    "packages/dist/feature/src/index.ts": "export const feature = true;\n",
    "packages/generated/ignored/package.json": manifest("@odinn/generated"),
    "packages/node_modules/ignored/package.json": manifest("@odinn/node-modules-ignored"),
  });

  const result = await checkFixture(root, { "@odinn/dist-feature": [] }, []);

  assert.equal(result.scannedManifestCount, 1);
  assert.equal(result.scannedFileCount, 1);
  assert.deepEqual(result.violations, []);
});

test("workspace discovery and graph keys and targets must agree bidirectionally", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/application/package.json": manifest("@odinn/application"),
    "packages/application/src/index.ts": "export const application = true;\n",
  });

  const result = await checkFixture(root, {
    "@odinn/application": ["@odinn/ghost-target"],
    "@odinn/stale-package": [],
  }, []);

  assert.deepEqual(result.violations.map(({ specifier, kind, rule }) => ({ specifier, kind, rule })), [
    {
      specifier: "@odinn/application -> @odinn/ghost-target",
      kind: "workspace-graph",
      rule: DEPENDENCY_RULES.unknownGraphTarget,
    },
    {
      specifier: "@odinn/stale-package",
      kind: "workspace-graph",
      rule: DEPENDENCY_RULES.missingGraphPackage,
    },
  ]);
});

test("dependency checker rejects new packages until the graph is deliberately updated", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/feature/package.json": manifest("@odinn/feature"),
    "packages/feature/src/index.ts": "export const feature = true;\n",
  });

  const result = await checkFixture(root, {}, []);

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

  const result = await checkFixture(root, { "@odinn/application": [] });

  assert.deepEqual(LEGACY_DEPENDENCY_BASELINE, []);
  assert.equal(result.violations.length, 1);
  assert.deepEqual(result.baselineErrors, []);
  assert.equal(result.acceptedLegacyOccurrences, 0);
  assert.equal(
    formatDependencyViolation(result.violations[0]!),
    'packages/application/src/index.ts:1:8: forbidden import "@odinn/not-installed" [rule: @odinn and workspace protocol dependencies must resolve to a workspace package]',
  );
});
