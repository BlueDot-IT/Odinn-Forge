import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
  scripts?: Record<string, string>;
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
    ...(options.scripts ? { scripts: options.scripts } : {}),
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
const physicalExportTargetRule = "workspace exports must resolve to an existing regular file inside their package";
const productionSymlinkRule = "production workspace packages cannot contain symbolic links";

async function linkRuntimePackage(
  t: test.TestContext,
  root: string,
  packageName: string,
  packageDirectory: string,
): Promise<boolean> {
  const segments = packageName.split("/");
  const linkPath = join(root, "node_modules", ...segments);
  await mkdir(dirname(linkPath), { recursive: true });
  try {
    await symlink(packageDirectory, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
      t.skip(`runtime package links are unavailable on ${process.platform}: ${code}`);
      return false;
    }
    throw error;
  }
}

function runNodeProbe(root: string, file: string): string {
  return execFileSync(process.execPath, [join(root, file)], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

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
    "packages/kernel/src/conditional.ts": "export const conditional = true;\n",
    "packages/kernel/src/fallback.ts": "export const fallback = true;\n",
    "packages/kernel/src/features/public/tool.ts": "export const tool = true;\n",
    "packages/kernel/src/reached.ts": "export const reached = true;\n",
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
      specifier: "invalid-target",
      kind: "manifest-export",
      rule: DEPENDENCY_RULES.physicalExportTarget,
    },
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

test("Node 24 active export conditions and the checker select the same nested workspace targets", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host", {
      exports: {
        ".": { "node-addons": "./nested/src/addons.js", default: "./src/safe.js" },
        "./sync": { "module-sync": "./nested/src/sync.js", default: "./src/safe.js" },
      },
    }),
    "packages/host/src/safe.js": 'export const selected = "safe";\n',
    "packages/host/nested/package.json": manifest("@odinn/nested"),
    "packages/host/nested/src/index.ts": "export const nested = true;\n",
    "packages/host/nested/src/addons.js": 'export const selected = "node-addons";\n',
    "packages/host/nested/src/sync.js": 'export const selected = "module-sync";\n',
    "packages/consumer/package.json": manifest("@odinn/consumer", {
      dependencies: { "@odinn/host": "workspace:*" },
    }),
    "packages/consumer/src/index.ts": [
      'import "@odinn/host";',
      'import "@odinn/host/sync";',
      'require("@odinn/host");',
      'require("@odinn/host/sync");',
    ].join("\n"),
    "runtime-import-probe.mjs": [
      'import { selected as addons } from "@odinn/host";',
      'import { selected as sync } from "@odinn/host/sync";',
      "console.log(JSON.stringify([addons, sync]));",
    ].join("\n"),
    "runtime-require-probe.cjs": [
      'const { selected: addons } = require("@odinn/host");',
      'const { selected: sync } = require("@odinn/host/sync");',
      "console.log(JSON.stringify([addons, sync]));",
    ].join("\n"),
  });
  if (!await linkRuntimePackage(t, root, "@odinn/host", join(root, "packages/host"))) return;

  assert.equal(runNodeProbe(root, "runtime-import-probe.mjs"), '["node-addons","module-sync"]');
  assert.equal(runNodeProbe(root, "runtime-require-probe.cjs"), '["node-addons","module-sync"]');

  const result = await checkFixture(root, {
    "@odinn/consumer": ["@odinn/host"],
    "@odinn/host": [],
    "@odinn/nested": [],
  }, []);

  assert.deepEqual(result.violations.map(({ specifier, kind, rule }) => ({ specifier, kind, rule })), [
    { specifier: "@odinn/host", kind: "import-declaration", rule: crossPackageExportTargetRule },
    { specifier: "@odinn/host/sync", kind: "import-declaration", rule: crossPackageExportTargetRule },
    { specifier: "@odinn/host", kind: "require-call", rule: crossPackageExportTargetRule },
    { specifier: "@odinn/host/sync", kind: "require-call", rule: crossPackageExportTargetRule },
    { specifier: "./nested/src/addons.js", kind: "manifest-export", rule: crossPackageExportTargetRule },
    { specifier: "./nested/src/sync.js", kind: "manifest-export", rule: crossPackageExportTargetRule },
  ]);
});

test("type-only imports select the TypeScript types condition before physical ownership checks", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host", {
      exports: { ".": { types: "./nested/src/index.d.ts", import: "./src/index.js" } },
    }),
    "packages/host/src/index.js": "export const safe = true;\n",
    "packages/host/nested/package.json": manifest("@odinn/nested"),
    "packages/host/nested/src/index.d.ts": "export interface Nested { readonly value: string }\n",
    "packages/host/nested/src/index.ts": "export const nested = true;\n",
    "packages/consumer/package.json": manifest("@odinn/consumer", {
      dependencies: { "@odinn/host": "workspace:*" },
    }),
    "packages/consumer/src/index.ts": 'import type { Nested } from "@odinn/host"; export type Value = Nested["value"];\n',
  });

  const result = await checkFixture(root, {
    "@odinn/consumer": ["@odinn/host"],
    "@odinn/host": [],
    "@odinn/nested": [],
  }, []);

  assert(result.violations.some(({ sourceFile, rule }) =>
    sourceFile === "packages/consumer/src/index.ts" && rule === crossPackageExportTargetRule),
  JSON.stringify(result.violations));
});

test("static imports in cts files select the Node require export condition", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host", {
      exports: { ".": { import: "./src/safe.js", require: "./nested/src/index.cjs" } },
    }),
    "packages/host/src/safe.js": "export const selected = 'safe';\n",
    "packages/host/nested/package.json": manifest("@odinn/nested"),
    "packages/host/nested/src/index.cjs": "exports.selected = 'nested';\n",
    "packages/host/nested/src/index.ts": "export const nested = true;\n",
    "packages/consumer/package.json": manifest("@odinn/consumer", {
      dependencies: { "@odinn/host": "workspace:*" },
      exports: { ".": "./src/index.cts" },
    }),
    "packages/consumer/src/index.cts": 'import { selected } from "@odinn/host"; export { selected };\n',
  });

  const result = await checkFixture(root, {
    "@odinn/consumer": ["@odinn/host"],
    "@odinn/host": [],
    "@odinn/nested": [],
  }, []);

  assert(result.violations.some(({ sourceFile, rule }) =>
    sourceFile === "packages/consumer/src/index.cts" && rule === crossPackageExportTargetRule),
  JSON.stringify(result.violations));
});

test("executable export targets in dist remain in the architecture source inventory", async (t) => {
  const root = await repositoryFixture(t, {
    "apps/gateway/package.json": manifest("@odinn/gateway"),
    "apps/gateway/src/index.ts": "export const gateway = true;\n",
    "packages/host/package.json": manifest("@odinn/host", {
      exports: { ".": "./dist/index.mjs", "./extensionless": "./dist/runner" },
    }),
    "packages/host/src/source.ts": "export const source = true;\n",
    "packages/host/dist/index.mjs": 'import "@odinn/gateway"; export const host = true;\n',
    "packages/host/dist/runner": 'import "@odinn/gateway"; export const runner = true;\n',
  });

  const result = await checkFixture(root, {
    "@odinn/gateway": [],
    "@odinn/host": [],
  }, []);

  assert.deepEqual(result.violations.filter(({ rule }) => rule === DEPENDENCY_RULES.packageToApp)
    .map(({ sourceFile }) => sourceFile), [
    "packages/host/dist/index.mjs",
    "packages/host/dist/runner",
  ]);
});

test("repository file URL imports cannot cross a workspace package boundary", async (t) => {
  const root = await repositoryFixture(t, {
    "apps/gateway/package.json": manifest("@odinn/gateway", { exports: { ".": "./src/index.mjs" } }),
    "apps/gateway/src/index.mjs": "export const gateway = true;\n",
    "packages/host/package.json": manifest("@odinn/host", { exports: { ".": "./src/index.mjs" } }),
    "packages/host/src/index.mjs": "export const host = true;\n",
  });
  await writeFile(
    join(root, "packages/host/src/index.mjs"),
    [
      'import "file:///proc/self/cwd/apps/gateway/src/index.mjs";',
      'import "data:text/javascript,import%20%22@odinn/gateway%22";',
    ].join("\n"),
  );

  const result = await checkFixture(root, {
    "@odinn/gateway": [],
    "@odinn/host": [],
  }, []);

  assert.deepEqual(result.violations.filter(({ sourceFile }) => sourceFile === "packages/host/src/index.mjs")
    .map(({ line, rule }) => ({ line, rule })), [
    { line: 1, rule: DEPENDENCY_RULES.urlModuleSpecifier },
    { line: 2, rule: DEPENDENCY_RULES.urlModuleSpecifier },
  ]);
});

test("encoded traversal, build-output, repository-tool, and outside-file references fail closed", async (t) => {
  const root = await repositoryFixture(t, {
    "apps/gateway/package.json": manifest("@odinn/gateway"),
    "apps/gateway/src/index.ts": "export const gateway = true;\n",
    "packages/host/package.json": manifest("@odinn/host"),
    "packages/host/src/safe.ts": "export const safe = true;\n",
    "packages/host/src/data.json": "{}\n",
    "packages/host/dist/hidden.js": 'import "@odinn/gateway";\n',
    "scripts/repository-tool.ts": 'import "@odinn/gateway";\n',
  });
  const outsidePath = join(dirname(root), `${root.split(/[\\/]/u).at(-1)}-outside.mjs`);
  t.after(() => rm(outsidePath, { force: true }));
  await writeFile(outsidePath, 'import "@odinn/gateway";\n');
  await writeFile(join(root, "packages/host/src/index.ts"), [
    'import "%2e%2e/../../apps/gateway/src/index.ts";',
    'import "../dist/hidden.js";',
    'import "../../../scripts/repository-tool.ts";',
    `import ${JSON.stringify(outsidePath)};`,
    'import "./safe.ts";',
    'import data from "./data.json" with { type: "json" };',
    'import type ts from "typescript";',
    "export { data };",
  ].join("\n"));

  const result = await checkFixture(root, {
    "@odinn/gateway": [],
    "@odinn/host": [],
  }, []);

  assert.deepEqual(result.violations.filter(({ sourceFile }) => sourceFile === "packages/host/src/index.ts")
    .map(({ line, rule }) => ({ line, rule })), [
    { line: 1, rule: DEPENDENCY_RULES.encodedModuleSpecifier },
    { line: 2, rule: DEPENDENCY_RULES.unscannedSourcePath },
    { line: 3, rule: DEPENDENCY_RULES.crossPackageSourcePath },
    { line: 4, rule: DEPENDENCY_RULES.crossPackageSourcePath },
  ]);
});

test("relative runtime loads name existing regular auditable files explicitly", async (t) => {
  const root = await repositoryFixture(t, {
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
    "apps/gateway/package.json": manifest("@odinn/gateway", {
      exports: { ".": "./src/index.cjs" },
    }),
    "apps/gateway/src/index.cjs": "module.exports = { gateway: true };\n",
    "packages/host/package.json": manifest("@odinn/host", {
      exports: { ".": "./src/public.cjs" },
    }),
    "packages/host/src/public.cjs": "module.exports = { host: true };\n",
    "packages/host/src/index.cjs": [
      "require('./shim');",
      "require('..');",
      "require('./native');",
      "require('./safe.cjs');",
      "require('./data.json');",
    ].join("\n"),
    "packages/host/src/safe.cjs": "module.exports = { safe: true };\n",
    "packages/host/src/data.json": "{}\n",
    "packages/host/src/native.node": "not-a-real-native-addon\n",
    "packages/host/src/shim/package.json": `${JSON.stringify({
      private: true,
      main: "../../../../apps/gateway/src/index.cjs",
    })}\n`,
  });

  const result = await checkFixture(root, {
    "@odinn/gateway": [],
    "@odinn/host": [],
  }, []);

  assert.deepEqual(result.violations.filter(({ sourceFile }) => sourceFile === "packages/host/src/index.cjs")
    .map(({ line, rule }) => ({ line, rule })), [
    { line: 1, rule: DEPENDENCY_RULES.unscannedSourcePath },
    { line: 2, rule: DEPENDENCY_RULES.unscannedSourcePath },
    { line: 3, rule: DEPENDENCY_RULES.unscannedSourcePath },
  ]);
});

test("dot-prefixed bare packages cannot hide behind same-named local source files", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host", {
      exports: { ".": "./src/index.cjs" },
    }),
    "packages/host/src/index.cjs": [
      "console.log(JSON.stringify([require('.hidden.js'), require('.bin'), require('.pnpm')]));",
    ].join("\n"),
    "packages/host/src/.hidden.js": "module.exports = 'local-decoy';\n",
    "packages/host/node_modules/.hidden.js/package.json": `${JSON.stringify({
      name: ".hidden.js",
      version: "1.0.0",
      main: "index.cjs",
    })}\n`,
    "packages/host/node_modules/.hidden.js/index.cjs": "module.exports = 'node-modules-payload';\n",
    "packages/host/node_modules/.bin/package.json": `${JSON.stringify({
      name: ".bin",
      version: "1.0.0",
      main: "index.cjs",
    })}\n`,
    "packages/host/node_modules/.bin/index.cjs": "module.exports = 'bin-payload';\n",
    "packages/host/node_modules/.pnpm/package.json": `${JSON.stringify({
      name: ".pnpm",
      version: "1.0.0",
      main: "index.cjs",
    })}\n`,
    "packages/host/node_modules/.pnpm/index.cjs": "module.exports = 'pnpm-payload';\n",
  });

  assert.equal(
    runNodeProbe(root, "packages/host/src/index.cjs"),
    '["node-modules-payload","bin-payload","pnpm-payload"]',
  );

  const result = await checkFixture(root, { "@odinn/host": [] }, []);

  assert.deepEqual(result.violations
    .filter(({ rule }) => rule === DEPENDENCY_RULES.unmanagedNodeModulesLink)
    .map(({ sourceFile, specifier }) => ({ sourceFile, specifier })), [
    { sourceFile: "packages/host/node_modules/.bin", specifier: ".bin" },
    { sourceFile: "packages/host/node_modules/.hidden.js", specifier: ".hidden.js" },
    { sourceFile: "packages/host/node_modules/.pnpm", specifier: ".pnpm" },
  ]);
});

test("CommonJS literal filename semantics cannot diverge through query, fragment, or backslash spelling", async (t) => {
  const runtimeFiles = process.platform === "win32" ? {} : {
    "packages/host/src/safe.cjs?hidden": "module.exports = 'query-payload';\n",
    "packages/host/src/safe.cjs#hidden": "module.exports = 'fragment-payload';\n",
    "packages/host/node_modules/safe\\payload/package.json": `${JSON.stringify({
      name: "safe\\payload",
      version: "1.0.0",
      main: "index.cjs",
    })}\n`,
    "packages/host/node_modules/safe\\payload/index.cjs": "module.exports = 'backslash-payload';\n",
  };
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host", {
      dependencies: { safe: "1.0.0" },
      exports: { ".": "./src/index.cjs" },
    }),
    "packages/host/src/index.cjs": [
      "const query = require('./safe.cjs?hidden');",
      "const fragment = require('./safe.cjs#hidden');",
      "const backslash = require('safe\\\\payload');",
      "console.log(JSON.stringify([query, fragment, backslash]));",
    ].join("\n"),
    "packages/host/src/safe.cjs": "module.exports = 'local-decoy';\n",
    ...runtimeFiles,
  });

  if (process.platform !== "win32") {
    assert.equal(
      runNodeProbe(root, "packages/host/src/index.cjs"),
      '["query-payload","fragment-payload","backslash-payload"]',
    );
  }

  const result = await checkFixture(root, { "@odinn/host": [] }, []);
  assert.deepEqual(result.violations
    .filter(({ sourceFile }) => sourceFile === "packages/host/src/index.cjs")
    .map(({ line, rule }) => ({ line, rule })), [
    { line: 1, rule: DEPENDENCY_RULES.ambiguousModuleSpecifier },
    { line: 2, rule: DEPENDENCY_RULES.ambiguousModuleSpecifier },
    { line: 3, rule: DEPENDENCY_RULES.ambiguousModuleSpecifier },
  ]);
});

test("workspace exports reject text and native executable targets while preserving inert JSON", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host", {
      exports: {
        ".": "./src/index.ts",
        "./data": "./dist/data.json",
        "./native": "./dist/native.node",
        "./text-loader": "./dist/loader.txt",
      },
    }),
    "packages/host/src/index.ts": "export const host = true;\n",
    "packages/host/dist/data.json": "{}\n",
    "packages/host/dist/loader.txt": 'import "@odinn/gateway";\n',
    "packages/host/dist/native.node": "not-a-real-native-addon\n",
    "packages/consumer/package.json": manifest("@odinn/consumer", {
      dependencies: { "@odinn/host": "workspace:*" },
    }),
    "packages/consumer/src/index.ts": [
      'import data from "@odinn/host/data" with { type: "json" };',
      'import "@odinn/host/native";',
      'import "@odinn/host/text-loader";',
      "export { data };",
    ].join("\n"),
  });

  const result = await checkFixture(root, {
    "@odinn/consumer": ["@odinn/host"],
    "@odinn/host": [],
  }, []);

  assert.deepEqual(result.violations.filter(({ rule }) => rule === DEPENDENCY_RULES.executableExportTarget)
    .map(({ sourceFile, specifier, kind }) => ({ sourceFile, specifier, kind })), [
    {
      sourceFile: "packages/consumer/src/index.ts",
      specifier: "@odinn/host/native",
      kind: "import-declaration",
    },
    {
      sourceFile: "packages/consumer/src/index.ts",
      specifier: "@odinn/host/text-loader",
      kind: "import-declaration",
    },
    {
      sourceFile: "packages/host/package.json",
      specifier: "./dist/native.node",
      kind: "manifest-export",
    },
    {
      sourceFile: "packages/host/package.json",
      specifier: "./dist/loader.txt",
      kind: "manifest-export",
    },
  ]);
});

test("computed and private Node module loader primitives fail closed", async (t) => {
  const root = await repositoryFixture(t, {
    "apps/gateway/package.json": manifest("@odinn/gateway"),
    "apps/gateway/src/index.ts": "export const gateway = true;\n",
    "packages/host/package.json": manifest("@odinn/host"),
    "packages/host/src/index.ts": [
      "const loaderName = 'require';",
      "module[loaderName].bind(module)('@odinn/gateway');",
      'import { Module } from "node:module";',
      "Module._load('@odinn/gateway', module, false);",
      'const moduleObject = require("node:module");',
      "const moduleAlias = moduleObject;",
      "moduleAlias._load('@odinn/gateway', module, false);",
      'const { Module: RenamedModule } = require("node:module");',
      "RenamedModule._load('@odinn/gateway', module, false);",
      'require("node:module")._load("@odinn/gateway", module, false);',
      'process.getBuiltinModule("module")._load("@odinn/gateway", module, false);',
      "process.getBuiltinModule(loaderName);",
    ].join("\n"),
  });

  const result = await checkFixture(root, {
    "@odinn/gateway": [],
    "@odinn/host": [],
  }, []);

  const loaderLines = new Set(result.violations.filter(({ sourceFile, kind, rule }) =>
    sourceFile === "packages/host/src/index.ts"
      && kind === "module-loader"
      && rule === DEPENDENCY_RULES.unsupportedModuleLoader).map(({ line }) => line));
  assert.deepEqual([...loaderLines], [2, 3, 4, 5, 7, 8, 9, 10, 11, 12]);
});

test("derived Module authority and synchronous loader-hook redirects fail closed", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host"),
    "packages/host/src/index.ts": [
      'import { Module, builtinModules, registerHooks as installHooks } from "node:module";',
      "Reflect.get(Module, '_load')('@odinn/gateway', module, false);",
      "class DerivedModule extends Module {}",
      "const instance = new DerivedModule('derived');",
      "instance.load('@odinn/gateway');",
      "const ExpressionModule = class extends Module {};",
      "new ExpressionModule('expression').load('@odinn/gateway');",
      "const inherited = Object.create(Module.prototype);",
      "inherited.load('@odinn/gateway');",
      "Module.registerHooks({ resolve: (specifier) => ({ shortCircuit: true, url: specifier }) });",
      "installHooks({ load: (url) => ({ format: 'module', shortCircuit: true, source: url }) });",
      "const safeMetadata = builtinModules.includes('node:fs');",
      "const safeReflect = Reflect.get({ load: () => true }, 'load');",
      "safeReflect();",
      "export { safeMetadata };",
    ].join("\n"),
  });

  const result = await checkFixture(root, { "@odinn/host": [] }, []);
  const loaderLines = new Set(result.violations.filter(({ sourceFile, kind, rule }) =>
    sourceFile === "packages/host/src/index.ts"
      && kind === "module-loader"
      && rule === DEPENDENCY_RULES.unsupportedModuleLoader).map(({ line }) => line));

  assert.deepEqual([...loaderLines], [1, 2, 5, 7, 9, 10]);
  assert(!loaderLines.has(12));
  assert(!loaderLines.has(13));
  assert(!loaderLines.has(14));
});

test("dynamic evaluators and createRequire aliases fail closed at their capability boundary", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host"),
    "packages/host/src/index.ts": [
      'import * as nodeModule from "node:module";',
      'eval("require(\\"@odinn/gateway\\")");',
      '(0, eval)("import(\\"@odinn/gateway\\")");',
      'globalThis.eval("require(\\"@odinn/gateway\\")");',
      'Function("return import(\\"@odinn/gateway\\")")();',
      'new Function("return require(\\"@odinn/gateway\\")");',
      'Function.call(null, "return require(\\"@odinn/gateway\\")");',
      'Reflect.construct(Function, ["return require(\\"@odinn/gateway\\")"]);',
      '(() => undefined).constructor("return require(\\"@odinn/gateway\\")")();',
      'const loaderName = "createRequire";',
      'const computedFactory = nodeModule[loaderName];',
      'const staticFactory = nodeModule["create" + "Require"];',
      'const { createRequire: destructuredFactory } = nodeModule;',
    ].join("\n"),
  });

  const result = await checkFixture(root, { "@odinn/host": [] }, []);
  const loaderLines = [...new Set(result.violations
    .filter(({ sourceFile, kind, rule }) => sourceFile === "packages/host/src/index.ts"
      && kind === "module-loader"
      && rule === DEPENDENCY_RULES.unsupportedModuleLoader)
    .map(({ line }) => line))];

  assert.deepEqual(loaderLines, [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13]);
});

test("global evaluator aliases remain rejected while lookalike object methods stay ordinary", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host"),
    "packages/host/src/index.ts": [
      "const realm = globalThis;",
      "const evaluate = realm.eval;",
      'evaluate("import(\\"@odinn/gateway\\")");',
      "let assigned;",
      "assigned = Reflect.get(realm, 'eval');",
      'assigned("require(\\"@odinn/gateway\\")");',
      "const { eval: destructured } = realm;",
      'destructured("require(\\"@odinn/gateway\\")");',
      "const evaluatorKey = 'eval';",
      "const computed = realm[evaluatorKey];",
      'computed("require(\\"@odinn/gateway\\")");',
      "const harmless = { eval: () => true };",
      "harmless.eval();",
      "const safeReflect = Reflect.get(harmless, 'eval');",
      "safeReflect();",
    ].join("\n"),
  });

  const result = await checkFixture(root, { "@odinn/host": [] }, []);
  const loaderLines = new Set(result.violations.filter(({ sourceFile, kind, rule }) =>
    sourceFile === "packages/host/src/index.ts"
      && kind === "module-loader"
      && rule === DEPENDENCY_RULES.unsupportedModuleLoader).map(({ line }) => line));

  assert.deepEqual([...loaderLines], [1, 2, 3, 5, 6, 7, 8, 10, 11]);
  assert(!loaderLines.has(13));
  assert(!loaderLines.has(14));
  assert(!loaderLines.has(15));
});

test("runtime Module and VM authority is rejected before capability-preserving transforms", async (t) => {
  const hostileSources: Record<string, string> = {
    "array-eval.ts": [
      "const [hidden] = [eval];",
      "hidden('import(\\\"@odinn/gateway\\\")');",
    ].join("\n"),
    "callback-function.ts": [
      "const hidden = ((value: unknown) => value)(Function) as FunctionConstructor;",
      "hidden('return import(\\\"@odinn/gateway\\\")')();",
    ].join("\n"),
    "aliased-object-create.cjs": [
      "const { Module: RuntimeCtor } = require('node:module');",
      "const inherit = Object.create;",
      "inherit(RuntimeCtor.prototype).load('/tmp/forbidden.cjs');",
    ].join("\n"),
    "array-derived-constructor.cjs": [
      "const { Module: RuntimeCtor } = require('node:module');",
      "const [HiddenCtor] = [RuntimeCtor];",
      "new HiddenCtor('hidden').load('/tmp/forbidden.cjs');",
    ].join("\n"),
    "bound-constructor.cjs": [
      "const { Module: RuntimeCtor } = require('node:module');",
      "const BoundCtor = RuntimeCtor.bind(null);",
      "new BoundCtor('hidden').load('/tmp/forbidden.cjs');",
    ].join("\n"),
    "callback-alias.cjs": [
      "import('node:module').then(({ Module: RuntimeCtor }) =>",
      "  new RuntimeCtor('hidden').load('/tmp/forbidden.cjs'));",
    ].join("\n"),
    "copied-extensions.cjs": [
      "const { Module: RuntimeCtor } = require('node:module');",
      "const copied = { ...RuntimeCtor._extensions };",
      "copied['.json'] = copied['.js'];",
      "RuntimeCtor._extensions = copied;",
      "require('./payload.json');",
    ].join("\n"),
    "descriptor-bind.cjs": [
      "const { Module: RuntimeCtor } = require('node:module');",
      "Object.getOwnPropertyDescriptor(RuntimeCtor, '_load').value.bind(RuntimeCtor)('@odinn/gateway');",
    ].join("\n"),
    "descriptor-load.cjs": [
      "const { Module: RuntimeCtor } = require('node:module');",
      "Object.getOwnPropertyDescriptor(RuntimeCtor, '_load').value('@odinn/gateway');",
    ].join("\n"),
    "process-builtin-alias.cjs": [
      "const hiddenBuiltin = process.getBuiltinModule;",
      "const RuntimeCtor = hiddenBuiltin('node:module').Module;",
      "RuntimeCtor._load('@odinn/gateway', module, false);",
    ].join("\n"),
    "process-default-import.ts": [
      "import runtime from 'node:process';",
      "runtime.getBuiltinModule('module');",
    ].join("\n"),
    "process-forbidden-named-import.ts": [
      "import { getBuiltinModule } from 'node:process';",
      "getBuiltinModule('module');",
    ].join("\n"),
    "process-namespace-import.ts": [
      "import * as runtime from 'node:process';",
      "runtime.getBuiltinModule('module');",
    ].join("\n"),
    "proxy-load.cjs": [
      "const { Module: RuntimeCtor } = require('node:module');",
      "Reflect.get(new Proxy(RuntimeCtor, {}), '_load')('@odinn/gateway', module, false);",
    ].join("\n"),
    "reflect-get-bind.cjs": [
      "const { Module: RuntimeCtor } = require('node:module');",
      "Reflect.get.bind(Reflect)(RuntimeCtor, '_load')('@odinn/gateway', module, false);",
    ].join("\n"),
    "run-main.cjs": [
      "const { Module: RuntimeCtor } = require('node:module');",
      "RuntimeCtor.runMain();",
    ].join("\n"),
    "set-prototype.cjs": [
      "const { Module: RuntimeCtor } = require('node:module');",
      "Object.setPrototypeOf({}, RuntimeCtor.prototype).load('/tmp/forbidden.cjs');",
    ].join("\n"),
    "spread-load.cjs": [
      "const { Module: RuntimeCtor } = require('node:module');",
      "({ ...RuntimeCtor })._load('@odinn/gateway', module, false);",
    ].join("\n"),
    "spread-register.cjs": [
      "const { register, registerHooks } = { ...require('node:module') };",
      "register('data:text/javascript,export default 1');",
      "registerHooks({ resolve: () => ({ shortCircuit: true, url: 'node:fs' }) });",
    ].join("\n"),
    "vm-context.cjs": [
      "const { runInThisContext } = require('node:vm');",
      "runInThisContext('require(\\\"@odinn/gateway\\\")');",
    ].join("\n"),
  };
  const root = await repositoryFixture(t, {
    "apps/gateway/package.json": manifest("@odinn/gateway"),
    "apps/gateway/src/index.ts": "export const gateway = true;\n",
    "packages/host/package.json": manifest("@odinn/host"),
    "packages/host/src/index.ts": "export const host = true;\n",
    ...Object.fromEntries(Object.entries(hostileSources)
      .map(([name, source]) => [`packages/host/src/${name}`, `${source}\n`])),
  });

  const result = await checkFixture(root, { "@odinn/gateway": [], "@odinn/host": [] }, []);
  const rejectedFiles = new Set(result.violations
    .filter(({ kind, rule }) => kind === "module-loader"
      && rule === DEPENDENCY_RULES.unsupportedModuleLoader)
    .map(({ sourceFile }) => sourceFile.replace("packages/host/src/", "")));

  assert.deepEqual([...rejectedFiles].sort(), Object.keys(hostileSources).sort());
});

test("descriptor, Reflect.apply, constructor alias, and global Proxy evaluators fail closed", async (t) => {
  const hostileSources: Record<string, string> = {
    "constructor-alias.ts": [
      "const HiddenConstructor = (() => undefined).constructor;",
      "HiddenConstructor('return import(\\\"@odinn/gateway\\\")')();",
    ].join("\n"),
    "descriptor-alias.ts": [
      "const descriptor = Object.getOwnPropertyDescriptor;",
      "const hidden = descriptor(globalThis, 'eval').value;",
      "hidden('import(\\\"@odinn/gateway\\\")');",
    ].join("\n"),
    "descriptor-eval.ts": [
      "const hidden = Object.getOwnPropertyDescriptor(globalThis, 'eval')!.value;",
      "hidden('import(\\\"@odinn/gateway\\\")');",
    ].join("\n"),
    "global-proxy.ts": [
      "const realm = new Proxy(globalThis, {});",
      "realm.eval('import(\\\"@odinn/gateway\\\")');",
    ].join("\n"),
    "proxy-alias.ts": [
      "const HiddenProxy = Proxy;",
      "const realm = new HiddenProxy(globalThis, {});",
      "realm.eval('import(\\\"@odinn/gateway\\\")');",
    ].join("\n"),
    "proxy-revocable.ts": [
      "const { proxy: realm } = Proxy.revocable(globalThis, {});",
      "realm.eval('import(\\\"@odinn/gateway\\\")');",
    ].join("\n"),
    "reflect-apply.ts": "Reflect.apply(eval, undefined, ['import(\\\"@odinn/gateway\\\")']);",
    "reflect-get-alias.ts": [
      "const get = Reflect.get.bind(Reflect);",
      "get(globalThis, 'eval')('import(\\\"@odinn/gateway\\\")');",
    ].join("\n"),
    "reflect-get-call.ts": "Reflect.get.call(Reflect, () => undefined, 'constructor')('return 42')();",
    "reflect-get-apply.ts": "Reflect.get.apply(Reflect, [() => undefined, 'constructor'])('return 42')();",
    "reflect-get-destructured.ts": [
      "const { get } = Reflect;",
      "get(() => undefined, 'constructor')('return 42')();",
    ].join("\n"),
    "reflect-get-assignment.ts": [
      "let get;",
      "({ get } = Reflect);",
      "get(() => undefined, 'constructor')('return 42')();",
    ].join("\n"),
    "descriptor-destructured.ts": [
      "const { getOwnPropertyDescriptor: descriptor } = Object;",
      "descriptor(globalThis, 'eval')!.value('42');",
    ].join("\n"),
    "array-global.ts": "[globalThis][0].eval('42');",
    "conditional-global.ts": "(true ? globalThis : globalThis).eval('42');",
    "logical-global.ts": "(globalThis || globalThis).eval('42');",
  };
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host"),
    "packages/host/src/index.ts": "export const host = true;\n",
    ...Object.fromEntries(Object.entries(hostileSources)
      .map(([name, source]) => [`packages/host/src/${name}`, `${source}\n`])),
  });

  const result = await checkFixture(root, { "@odinn/host": [] }, []);
  const rejectedFiles = new Set(result.violations
    .filter(({ kind, rule }) => kind === "module-loader"
      && rule === DEPENDENCY_RULES.unsupportedModuleLoader)
    .map(({ sourceFile }) => sourceFile.replace("packages/host/src/", "")));

  assert.deepEqual([...rejectedFiles].sort(), Object.keys(hostileSources).sort());
});

test("metadata-only node:module and ordinary reflection, Proxy, and lookalikes remain compatible", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host"),
    "packages/host/src/index.ts": [
      'import { builtinModules as runtimeNames } from "node:module";',
      'import type { Module as ModuleType } from "node:module";',
      'import { type Module as InlineModuleType } from "node:module";',
      'export { builtinModules as exportedRuntimeNames } from "node:module";',
      'export type { Module as ExportedModuleType } from "node:module";',
      "const input = { value: 1, eval: () => true, load: () => true };",
      "type CallableMetadata = Function;",
      "const descriptor = Object.getOwnPropertyDescriptor(input, 'value');",
      "const reflected = Reflect.apply((value: number) => value + 1, undefined, [1]);",
      "const proxied = new Proxy(input, {});",
      "input.eval(); input.load();",
      "export type { CallableMetadata, InlineModuleType, ModuleType };",
      "export { descriptor, proxied, reflected, runtimeNames };",
    ].join("\n"),
  });

  const result = await checkFixture(root, { "@odinn/host": [] }, []);
  assert.deepEqual(result.violations, []);
});

test("evaluator authority stays rejected across comma, global, reflection, and constructor transforms", async (t) => {
  const hostileSources: Record<string, string> = {
    "comma-global-function.ts": "(0, globalThis).Function('return 42')();",
    "nested-global-function.ts": "globalThis.globalThis.Function('return 42')();",
    "reflect-function-constructor.ts": "Reflect.get(() => undefined, 'constructor')('return 42')();",
    "reflect-computed-constructor.ts": [
      "const key = ['con', 'structor'].join('');",
      "Reflect.get(() => undefined, key)('return 42')();",
    ].join("\n"),
    "computed-function-constructor.ts": [
      "const key = ['con', 'structor'].join('');",
      "(() => undefined)[key]('return 42')();",
    ].join("\n"),
    "destructured-function-constructor.ts": [
      "const { constructor: HiddenEvaluator } = (() => undefined);",
      "HiddenEvaluator('return 42')();",
    ].join("\n"),
    "computed-destructured-constructor.ts": [
      "const key = ['con', 'structor'].join('');",
      "const { [key]: HiddenEvaluator } = (() => undefined);",
      "HiddenEvaluator('return 42')();",
    ].join("\n"),
    "comma-global-reflect-get.ts": "Reflect.get((0, globalThis), 'Function')('return 42')();",
    "declared-eval.ts": [
      "declare const eval: (source: string) => unknown;",
      "eval('return 42');",
    ].join("\n"),
    "comma-proxy-global-eval.ts": [
      "const HiddenProxy = (0, Proxy);",
      "const realm = new HiddenProxy((0, globalThis), {});",
      "realm.eval('42');",
    ].join("\n"),
  };
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host"),
    "packages/host/src/index.ts": "export const host = true;\n",
    ...Object.fromEntries(Object.entries(hostileSources)
      .map(([name, source]) => [`packages/host/src/${name}`, `${source}\n`])),
  });

  const result = await checkFixture(root, { "@odinn/host": [] }, []);
  const rejectedFiles = new Set(result.violations
    .filter(({ kind, rule }) => kind === "module-loader"
      && rule === DEPENDENCY_RULES.unsupportedModuleLoader)
    .map(({ sourceFile }) => sourceFile.replace("packages/host/src/", "")));

  assert.deepEqual([...rejectedFiles].sort(), Object.keys(hostileSources).sort());
});

test("ordinary reflection aliases and shadowed authority lookalikes remain compatible", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host"),
    "packages/host/src/index.ts": [
      "const get = Reflect.get;",
      "const descriptor = Object.getOwnPropertyDescriptor;",
      "const create = Object.create;",
      "const input = { value: 7 };",
      "const module = { require: () => 1 };",
      "const localRequire = module.require;",
      "class Module { load() { return 2; } }",
      "const registry = { getBuiltinModule() { return 3; } };",
      "const localFunction = { constructor() { return 4; } };",
      "function reflectedGlobal() { return globalThis.Math; }",
      "function shadowedRealm(realm: { eval(): boolean }) { return realm.eval(); }",
      "function reflectedValue() { const get = Reflect.get; return get(input, 'value'); }",
      "function shadowedGet(get: () => number) { return get(); }",
      "const { get: destructuredGet } = Reflect;",
      "const calledGet = Reflect.get.call(Reflect, input, 'value');",
      "const appliedGet = Reflect.get.apply(Reflect, [input, 'value']);",
      "console.log(get(input, 'value'), descriptor(input, 'value')?.value, create(null));",
      "console.log(localRequire(), new Module().load(), registry.getBuiltinModule(), localFunction.constructor());",
      "console.log(reflectedGlobal(), shadowedRealm({ eval: () => true }), reflectedValue(), shadowedGet(() => 8));",
      "console.log(destructuredGet(input, 'value'), calledGet, appliedGet);",
    ].join("\n"),
    "packages/host/src/arguments-lookalike.cjs": [
      "function nested() { return arguments['1']; }",
      "module.exports = nested('left', 'right');",
    ].join("\n"),
  });

  const result = await checkFixture(root, { "@odinn/host": [] }, []);
  assert.deepEqual(result.violations, []);
});

test("ambient module and process authority reject transformed loaders and direct dlopen", async (t) => {
  const hostileSources: Record<string, string> = {
    "comma-module.cjs": "(0, module)._compile('module.exports = 1', __filename);",
    "declared-module.cts": [
      "declare const module: { _compile(source: string, filename: string): void };",
      "module._compile('module.exports = 1', __filename);",
    ].join("\n"),
    "computed-module.cjs": [
      "const key = ['re', 'quire'].join('');",
      "const { [key]: hiddenLoad } = module;",
      "hiddenLoad.call(module, '@odinn/gateway');",
    ].join("\n"),
    "computed-process.cjs": [
      "const key = ['getBuiltin', 'Module'].join('');",
      "(0, process)[key]('module');",
    ].join("\n"),
    "computed-process-alias.cjs": [
      "const runtime = process;",
      "const key = ['getBuiltin', 'Module'].join('');",
      "runtime[key]('module');",
    ].join("\n"),
    "process-dlopen.cjs": "process.dlopen(module, '/tmp/native.node');",
    "global-process.cjs": "globalThis.process.getBuiltinModule('module');",
    "assignment-process.cjs": [
      "let hiddenBuiltin;",
      "({ getBuiltinModule: hiddenBuiltin } = process);",
      "hiddenBuiltin('module');",
    ].join("\n"),
    "array-module.cjs": "[process.mainModule][0].require('@odinn/gateway');",
    "conditional-module.cjs": "(true ? process.mainModule : module).require('@odinn/gateway');",
    "logical-module.cjs": "(process.mainModule || module).require('@odinn/gateway');",
    "wrapper-arguments.cjs": "arguments['1']('@odinn/gateway');",
    "wrapper-module-arguments.cjs": "arguments['2'].require('@odinn/gateway');",
  };
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host", {
      exports: { ".": "./src/index.cjs" },
    }),
    "packages/host/src/index.cjs": "module.exports = { host: true };\n",
    ...Object.fromEntries(Object.entries(hostileSources)
      .map(([name, source]) => [`packages/host/src/${name}`, `${source}\n`])),
  });

  const result = await checkFixture(root, { "@odinn/host": [] }, []);
  const rejectedFiles = new Set(result.violations
    .filter(({ kind, rule }) => kind === "module-loader"
      && rule === DEPENDENCY_RULES.unsupportedModuleLoader)
    .map(({ sourceFile }) => sourceFile.replace("packages/host/src/", "")));

  assert.deepEqual([...rejectedFiles].sort(), Object.keys(hostileSources).sort());
});

test("ambient process authority cannot escape its closed direct-use grammar", async (t) => {
  const withTarget = (...lines: string[]) => [
    "const { resolve } = require('node:path');",
    "const target = resolve(__dirname, '../../../apps/gateway/src/index.cjs');",
    ...lines,
  ].join("\n");
  const hostileSources: Record<string, string> = {
    "01-original-callback.cjs": withTarget(
      "const transfer = (runtime, destination) => runtime.getBuiltinModule('module')._load(destination, undefined, false);",
      "console.log(transfer(process, target));",
    ),
    "02-original-alias-mainmodule.cjs": withTarget(
      "const runtime = process;",
      "console.log(runtime.mainModule.require(target));",
    ),
    "03-original-global-mainmodule.cjs": withTarget(
      "console.log(globalThis.process.mainModule.require(target));",
    ),
    "04-original-container.cjs": withTarget(
      "const holder = { runtime: process };",
      "console.log(holder.runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "05-original-spread.cjs": withTarget(
      "const runtime = { ...process };",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "06-original-prototype.cjs": withTarget(
      "const runtime = Object.setPrototypeOf({}, process);",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "07-original-proxy.cjs": withTarget(
      "const runtime = new Proxy(process, {});",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "08-nested-forwarding.cjs": withTarget(
      "const load = (runtime, destination) => runtime.getBuiltinModule('module')._load(destination, undefined, false);",
      "const inner = (runtime, callback, destination) => callback(runtime, destination);",
      "const outer = (runtime, callback, destination) => inner(runtime, callback, destination);",
      "console.log(outer(process, load, target));",
    ),
    "09-deep-forwarding.cjs": withTarget(
      "const sink = (runtime, destination) => runtime.getBuiltinModule('module')._load(destination, undefined, false);",
      "const hop3 = (runtime, callback, destination) => callback(runtime, destination);",
      "const hop2 = (runtime, callback, destination) => hop3(runtime, callback, destination);",
      "const hop1 = (runtime, callback, destination) => hop2(runtime, callback, destination);",
      "console.log(hop1(process, sink, target));",
    ),
    "10-identity-expression.cjs": withTarget(
      "const identity = (runtime) => runtime;",
      "const runtime = identity(process);",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "11-identity-block.cjs": withTarget(
      "function identity(runtime) { return runtime; }",
      "const runtime = identity(process);",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "12-callback-call.cjs": withTarget(
      "const transfer = (runtime, destination) => runtime.getBuiltinModule('module')._load(destination, undefined, false);",
      "console.log(transfer.call(undefined, process, target));",
    ),
    "13-callback-apply.cjs": withTarget(
      "const transfer = (runtime, destination) => runtime.getBuiltinModule('module')._load(destination, undefined, false);",
      "console.log(transfer.apply(undefined, [process, target]));",
    ),
    "14-callback-reflect-apply.cjs": withTarget(
      "const transfer = (runtime, destination) => runtime.getBuiltinModule('module')._load(destination, undefined, false);",
      "console.log(Reflect.apply(transfer, undefined, [process, target]));",
    ),
    "15-container-member-alias.cjs": withTarget(
      "const holder = { runtime: process };",
      "const runtime = holder.runtime;",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "16-container-destructure.cjs": withTarget(
      "const { runtime } = { runtime: process };",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "17-callback-member-call.cjs": withTarget(
      "const transfer = (runtime, destination) => runtime.getBuiltinModule('module')._load(destination, undefined, false);",
      "const callbacks = { transfer };",
      "console.log(callbacks.transfer(process, target));",
    ),
    "18-callback-member-alias.cjs": withTarget(
      "const transfer = (runtime, destination) => runtime.getBuiltinModule('module')._load(destination, undefined, false);",
      "const callbacks = { transfer };",
      "const alias = callbacks.transfer;",
      "console.log(alias(process, target));",
    ),
    "19-callback-destructured-alias.cjs": withTarget(
      "const transfer = (runtime, destination) => runtime.getBuiltinModule('module')._load(destination, undefined, false);",
      "const { transfer: alias } = { transfer };",
      "console.log(alias(process, target));",
    ),
    "20-object-method-forwarder.cjs": withTarget(
      "const callbacks = { transfer(runtime, destination) { return runtime.getBuiltinModule('module')._load(destination, undefined, false); } };",
      "console.log(callbacks.transfer(process, target));",
    ),
    "21-object-assign-process.cjs": withTarget(
      "const runtime = Object.assign({}, process);",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "22-object-assign-container.cjs": withTarget(
      "const holder = Object.assign({}, { runtime: process });",
      "console.log(holder.runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "23-object-assign-mutation.cjs": withTarget(
      "const holder = {};",
      "Object.assign(holder, { runtime: process });",
      "console.log(holder.runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "24-object-assign-callback.cjs": withTarget(
      "const transfer = (runtime, destination) => runtime.getBuiltinModule('module')._load(destination, undefined, false);",
      "const callbacks = Object.assign({}, { transfer });",
      "console.log(callbacks.transfer(process, target));",
    ),
    "25-proxy-revocable-process.cjs": withTarget(
      "const { proxy: runtime } = Proxy.revocable(process, {});",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "26-proxy-revocable-container.cjs": withTarget(
      "const holder = Proxy.revocable({ runtime: process }, {}).proxy;",
      "console.log(holder.runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "27-proxy-revocable-callback.cjs": withTarget(
      "const transfer = (runtime, destination) => runtime.getBuiltinModule('module')._load(destination, undefined, false);",
      "const callback = Proxy.revocable(transfer, {}).proxy;",
      "console.log(callback(process, target));",
    ),
    "28-composed-spread-container.cjs": withTarget(
      "const inner = { runtime: process };",
      "const outer = { ...inner };",
      "const { runtime } = outer;",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "29-composed-identity-container.cjs": withTarget(
      "const identity = (value) => value;",
      "const holder = identity({ runtime: process });",
      "console.log(holder.runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "30-composed-assign-revocable.cjs": withTarget(
      "const holder = Object.assign({}, { runtime: process });",
      "const { proxy } = Proxy.revocable(holder, {});",
      "console.log(proxy.runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "31-composed-callback-holder.cjs": withTarget(
      "const sink = (runtime, destination) => runtime.getBuiltinModule('module')._load(destination, undefined, false);",
      "const callbacks = { sink };",
      "const forward = (runtime, holder, destination) => holder.sink(runtime, destination);",
      "console.log(forward(process, callbacks, target));",
    ),
    "32-bound-callback.cjs": withTarget(
      "const transfer = (runtime, destination) => runtime.getBuiltinModule('module')._load(destination, undefined, false);",
      "const bound = transfer.bind(undefined, process, target);",
      "console.log(bound());",
    ),
    "33-default-parameter.cjs": withTarget(
      "const transfer = (runtime = process, destination = target) => runtime.getBuiltinModule('module')._load(destination, undefined, false);",
      "console.log(transfer());",
    ),
    "34-destructured-parameter.cjs": withTarget(
      "const transfer = ({ runtime }, destination) => runtime.getBuiltinModule('module')._load(destination, undefined, false);",
      "console.log(transfer({ runtime: process }, target));",
    ),
    "35-rest-parameter.cjs": withTarget(
      "const transfer = (...values) => values[0].getBuiltinModule('module')._load(values[1], undefined, false);",
      "console.log(transfer(process, target));",
    ),
    "36-fixed-point-return-chain.cjs": withTarget(
      "const first = () => second();",
      "const second = () => third();",
      "const third = () => process;",
      "const runtime = first();",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "37-callback-arguments.cjs": withTarget(
      "function inspect(runtime, destination) { void runtime.pid; return arguments[0].getBuiltinModule('module')._load(arguments[1], undefined, false); }",
      "console.log(inspect(process, target));",
    ),
    "38-reassigned-callback.cjs": withTarget(
      "let inspect = (runtime) => runtime.pid;",
      "inspect = (runtime, destination) => runtime.getBuiltinModule('module')._load(destination, undefined, false);",
      "console.log(inspect(process, target));",
    ),
    "39-reflect-process.cjs": withTarget(
      "const runtime = Reflect.get(globalThis, 'process');",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "40-descriptor-process.cjs": withTarget(
      "const runtime = Object.getOwnPropertyDescriptor(globalThis, 'process').get();",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "41-imported-process.cjs": withTarget(
      "const runtime = require('node:process');",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "42-event-return.cjs": withTarget(
      "const runtime = process.on('unused', () => undefined);",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "43-global-destructure.cjs": withTarget(
      "const { process: runtime } = globalThis;",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "44-global-assignment.cjs": withTarget(
      "let runtime;",
      "({ process: runtime } = globalThis);",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "45-reflect-descriptor.cjs": withTarget(
      "const runtime = Reflect.getOwnPropertyDescriptor(globalThis, 'process').get();",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "46-reassigned-callback-alias.cjs": withTarget(
      "const safe = (runtime) => runtime.pid;",
      "let inspect = safe;",
      "inspect = (runtime, destination) => runtime.getBuiltinModule('module')._load(destination, undefined, false);",
      "console.log(inspect(process, target));",
    ),
    "47-global-lookup-getter.cjs": withTarget(
      "const runtime = globalThis.__lookupGetter__('process').call(globalThis);",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "48-global-callback.cjs": withTarget(
      "const select = (scope) => scope.process;",
      "const runtime = select(globalThis);",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "49-global-container.cjs": withTarget(
      "const holder = { scope: globalThis };",
      "const runtime = holder.scope.process;",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "50-callback-this.cjs": withTarget(
      "function inspect(runtime) { void runtime.pid; return this.process.getBuiltinModule('module')._load(target, undefined, false); }",
      "console.log(inspect(process));",
    ),
    "51-container-method.cjs": withTarget(
      "const holder = { runtime: process, load() { return this.runtime.getBuiltinModule('module')._load(target, undefined, false); } };",
      "void (holder.runtime === process);",
      "console.log(holder.load());",
    ),
    "52-container-prototype.cjs": withTarget(
      "const proto = { load() { return this.runtime.getBuiltinModule('module')._load(target, undefined, false); } };",
      "const holder = { __proto__: proto, runtime: process, label: 'safe' };",
      "void (holder.runtime === process); void holder.label;",
      "console.log(holder.load());",
    ),
    "53-declaration-own-arguments.cjs": withTarget(
      "function inspect(runtime) { void runtime.pid; return inspect.arguments[0].getBuiltinModule('module')._load(target, undefined, false); }",
      "console.log(inspect(process));",
    ),
    "54-expression-own-arguments.cjs": withTarget(
      "const inspect = function internal(runtime) { void runtime.pid; return internal.arguments[0].getBuiltinModule('module')._load(target, undefined, false); };",
      "console.log(inspect(process));",
    ),
    "55-inherited-container-getter.cjs": withTarget(
      "Object.defineProperty(Object.prototype, 'runtimeAlias', { configurable: true, get() { return this.runtime; } });",
      "const holder = { runtime: process, label: 'safe' };",
      "void (holder.runtime === process); void holder.label;",
      "const runtime = holder.runtimeAlias;",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "56-global-self-callback.cjs": withTarget(
      "const identity = (value) => value;",
      "const realm = identity(globalThis['global']);",
      "console.log(realm.process.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "57-global-self-container.cjs": withTarget(
      "const holder = { realm: globalThis['global'] };",
      "console.log(holder.realm.process.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "58-global-self-return.cjs": withTarget(
      "const realm = (() => globalThis['global'])();",
      "console.log(realm.process.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "59-process-member-mutation.cjs": withTarget(
      "const original = process.cwd;",
      "let loaded;",
      "process.cwd = new Proxy(original, { apply(targetFunction, receiver) { loaded = receiver.getBuiltinModule('module')._load(target, undefined, false); return Reflect.apply(targetFunction, receiver, []); } });",
      "process.cwd();",
      "process.cwd = original;",
      "console.log(loaded);",
    ),
    "60-global-member-mutation.cjs": withTarget(
      "const original = globalThis.fetch;",
      "let loaded;",
      "globalThis.fetch = new Proxy(original, { apply(_targetFunction, receiver) { loaded = receiver.process.getBuiltinModule('module')._load(target, undefined, false); return Promise.resolve(); } });",
      "globalThis.fetch('data:,safe');",
      "globalThis.fetch = original;",
      "console.log(loaded);",
    ),
    "61-dynamic-process-import.cjs": withTarget(
      "import('node:process').then((runtime) => console.log(runtime.getBuiltinModule('module')._load(target, undefined, false)));",
    ),
    "62-process-require-alias.cjs": withTarget(
      "const runtime = require('process');",
      "console.log(runtime.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "63-reflected-global-self.cjs": withTarget(
      "const realm = Reflect.get(globalThis, 'global');",
      "console.log(realm.process.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "64-global-self-descriptor.cjs": withTarget(
      "const realm = Object.getOwnPropertyDescriptor(globalThis, 'global').value;",
      "console.log(realm.process.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "65-global-self-descriptor-map.cjs": withTarget(
      "const realm = Object.getOwnPropertyDescriptors(globalThis).global.value;",
      "console.log(realm.process.getBuiltinModule('module')._load(target, undefined, false));",
    ),
    "66-process-destructuring-mutation.cjs": withTarget(
      "const original = process.cwd;",
      "let loaded;",
      "({ replacement: process.cwd } = { replacement: new Proxy(original, { apply(_targetFunction, receiver) { loaded = receiver.getBuiltinModule('module')._load(target, undefined, false); return '/tmp'; } }) });",
      "process.cwd();",
      "process.cwd = original;",
      "console.log(loaded);",
    ),
    "67-global-destructuring-mutation.cjs": withTarget(
      "const original = globalThis.fetch;",
      "let loaded;",
      "({ replacement: globalThis.fetch } = { replacement: new Proxy(original, { apply(_targetFunction, receiver) { loaded = receiver.process.getBuiltinModule('module')._load(target, undefined, false); return Promise.resolve(); } }) });",
      "globalThis.fetch('data:,safe');",
      "globalThis.fetch = original;",
      "console.log(loaded);",
    ),
  };
  const compatibleSources: Record<string, string> = {
    "p01-shadowed-process.cjs": [
      "function ordinary(process) { return process.getBuiltinModule(); }",
      "console.log(ordinary({ getBuiltinModule: () => 'safe' }));",
    ].join("\n"),
    "p02-ordinary-callback.cjs": [
      "const read = (object) => object.value;",
      "console.log(read({ value: 'safe' }));",
    ].join("\n"),
    "p03-ordinary-nested-forward.cjs": [
      "const read = (object) => object.value;",
      "const inner = (object, callback) => callback(object);",
      "const outer = (object, callback) => inner(object, callback);",
      "console.log(outer({ value: 'safe' }, read));",
    ].join("\n"),
    "p04-ordinary-identity.cjs": [
      "const identity = (value) => value;",
      "console.log(identity({ value: 'safe' }).value);",
    ].join("\n"),
    "p05-ordinary-member-callback.cjs": [
      "const callbacks = { read: (object) => object.value };",
      "console.log(callbacks.read({ value: 'safe' }));",
    ].join("\n"),
    "p06-ordinary-destructured-callback.cjs": [
      "const read = (object) => object.value;",
      "const { read: alias } = { read };",
      "console.log(alias({ value: 'safe' }));",
    ].join("\n"),
    "p07-ordinary-object-assign.cjs": [
      "const holder = Object.assign({}, { runtime: { getBuiltinModule: () => 'safe' } });",
      "console.log(holder.runtime.getBuiltinModule());",
    ].join("\n"),
    "p08-ordinary-proxy-revocable.cjs": [
      "const { proxy } = Proxy.revocable({ value: 'safe' }, {});",
      "console.log(proxy.value);",
    ].join("\n"),
    "p09-ordinary-call.cjs": [
      "const read = (object) => object.value;",
      "console.log(read.call(undefined, { value: 'safe' }));",
    ].join("\n"),
    "p10-ordinary-apply.cjs": [
      "const read = (object) => object.value;",
      "console.log(read.apply(undefined, [{ value: 'safe' }]));",
    ].join("\n"),
    "p11-process-nonauthority.cjs": [
      "const inspect = (runtime) => typeof runtime.pid === 'number' ? 'safe' : 'bad';",
      "console.log(inspect(process));",
    ].join("\n"),
    "p12-process-container-nonauthority.cjs": [
      "const holder = { runtime: process };",
      "console.log(holder.runtime === process ? 'safe' : 'bad');",
    ].join("\n"),
    "p13-ordinary-require-method.cjs": [
      "const service = { require: () => 'safe' };",
      "console.log(service.require());",
    ].join("\n"),
    "p14-shadowed-object-assign.cjs": [
      "const Object = { assign: (_target, source) => source };",
      "console.log(Object.assign({}, { value: 'safe' }).value);",
    ].join("\n"),
    "p15-shadowed-proxy.cjs": [
      "const Proxy = function(value) { return value; };",
      "console.log(new Proxy({ value: 'safe' }, {}).value);",
    ].join("\n"),
  };
  const staticCompatibleSources: Record<string, string> = {
    "p16-process-namespace.ts": [
      "namespace process { export const pid = 'safe'; }",
      "console.log(process.pid);",
    ].join("\n"),
    "p17-process-enum-member.ts": [
      "enum Ordinary { process = 'safe' }",
      "console.log(Ordinary.process);",
    ].join("\n"),
    "p18-process-jsx-attribute.tsx": [
      "declare namespace JSX { interface IntrinsicElements { widget: { process: string } } }",
      "const View = () => <widget process='safe' />;",
      "export { View };",
    ].join("\n"),
    "p19-global-jsx-tags.tsx": [
      "declare namespace JSX { interface IntrinsicElements { process: object; globalThis: object } }",
      "const View = () => <><process /><globalThis /></>;",
      "export { View };",
    ].join("\n"),
    "p20-global-property-names.ts": [
      "const config = { global: 'safe', window: 'safe', self: 'safe', globalThis: 'safe' };",
      "console.log(config.global, config.window, config.self, config.globalThis);",
    ].join("\n"),
  };
  const allSources = { ...hostileSources, ...compatibleSources, ...staticCompatibleSources };
  const root = await repositoryFixture(t, {
    "apps/gateway/package.json": manifest("@odinn/gateway", {
      exports: { ".": "./src/index.cjs" },
    }),
    "apps/gateway/src/index.cjs": "module.exports = 'gateway-cjs';\n",
    "packages/host/package.json": manifest("@odinn/host", {
      exports: { ".": "./src/index.cjs" },
    }),
    "packages/host/src/index.cjs": "module.exports = { host: true };\n",
    ...Object.fromEntries(Object.entries(allSources)
      .map(([name, source]) => [`packages/host/src/${name}`, `${source}\n`])),
  });

  for (const name of Object.keys(hostileSources)) {
    assert.equal(runNodeProbe(root, `packages/host/src/${name}`), "gateway-cjs", name);
  }
  for (const name of Object.keys(compatibleSources)) {
    assert.equal(runNodeProbe(root, `packages/host/src/${name}`), "safe", name);
  }

  const result = await checkFixture(root, { "@odinn/gateway": [], "@odinn/host": [] }, []);
  const authorityViolations = result.violations.filter(({ kind, rule }) => kind === "module-loader"
    && rule === DEPENDENCY_RULES.unsupportedModuleLoader);
  const rejectedFiles = new Set(authorityViolations
    .map(({ sourceFile }) => sourceFile.replace("packages/host/src/", "")));
  assert.deepEqual([...rejectedFiles].sort(), Object.keys(hostileSources).sort());
  for (const [name, source] of Object.entries(hostileSources)) {
    const sourceLines = source.split("\n");
    assert(authorityViolations.some(({ sourceFile, line, column }) => {
      if (sourceFile !== `packages/host/src/${name}`) return false;
      const suffix = sourceLines[line - 1]?.slice(column - 1) ?? "";
      return /^(?:process\b|globalThis\b|Reflect\.(?:get|getOwnPropertyDescriptor)\b|Object\.getOwnPropertyDescriptors?\b|(?:import|require)\(['"](?:node:)?process['"]\)|['"]node:process['"]|(?:\(?\{\s*)?process:\s*runtime\b)/u
        .test(suffix);
    }), `expected ${name} to fail at its ambient process origin`);
  }
  for (const name of [...Object.keys(compatibleSources), ...Object.keys(staticCompatibleSources)]) {
    assert(!rejectedFiles.has(name), name);
  }
});

test("repository ambient process inventory and nested closed reads remain compatible", async (t) => {
  const auditedProperties = [
    "arch",
    "argv",
    "cwd",
    "env",
    "execPath",
    "exit",
    "exitCode",
    "getuid",
    "kill",
    "on",
    "once",
    "pid",
    "platform",
    "removeListener",
    "send",
    "stdin",
    "stdout",
    "version",
  ];
  const operationalMethods = new Set(["on", "once", "removeListener", "send"]);
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host"),
    "packages/host/src/index.ts": [
      "import { cwd as currentWorkingDirectory, exit as exitProcess, kill as killProcess } from 'node:process';",
      `const direct = [${auditedProperties.filter((name) => !operationalMethods.has(name))
        .map((name) => `process.${name}`).join(", ")}];`,
      "const getProcessUserId = process.getuid;",
      "const namedCalls = [currentWorkingDirectory(), getProcessUserId?.()];",
      "if (false) { exitProcess(0); killProcess(0, 0); }",
      "const readPid = (runtime) => runtime.pid;",
      "const inner = (runtime, callback) => callback(runtime);",
      "const outer = (runtime, callback) => inner(runtime, callback);",
      "const holder = { runtime: process };",
      "const environment = { runtime: process, label: 'safe' };",
      "const listener = () => undefined;",
      "process.on('odinn-test', listener);",
      "process.removeListener('odinn-test', listener);",
      "process.once('odinn-test', listener);",
      "process.removeListener('odinn-test', listener);",
      "if (false) process.send?.({ type: 'odinn-test' });",
      "process.exitCode = 0;",
      "console.log(direct.length, namedCalls.length, outer(process, readPid), holder.runtime === process);",
      "console.log(environment.runtime.pid, environment.label);",
    ].join("\n"),
  });

  const result = await checkFixture(root, { "@odinn/host": [] }, []);
  assert.deepEqual(result.violations, []);
});

test("runtime authority wrappers and transparent transforms cannot load forbidden code", async (t) => {
  const hostileSources: Record<string, { output: string; source: string }> = {
    "array-global.mjs": {
      output: "gateway-esm",
      source: [
        'import { resolve } from "node:path";',
        'import { pathToFileURL } from "node:url";',
        "const target = pathToFileURL(resolve(process.cwd(), 'apps/gateway/src/index.mjs')).href;",
        "const realm = [globalThis][0];",
        "const loaded = await realm.eval(`import(${JSON.stringify(target)})`);",
        "console.log(loaded.default);",
      ].join("\n"),
    },
    "array-module.cjs": {
      output: "gateway-cjs",
      source: [
        "const { resolve } = require('node:path');",
        "const runtimeModule = [process.mainModule][0];",
        "console.log(runtimeModule.require(resolve(process.cwd(), 'apps/gateway/src/index.cjs')));",
      ].join("\n"),
    },
    "assignment-process.cjs": {
      output: "gateway-cjs",
      source: [
        "const { resolve } = require('node:path');",
        "let hiddenBuiltin;",
        "({ getBuiltinModule: hiddenBuiltin } = process);",
        "const RuntimeModule = hiddenBuiltin('module').Module;",
        "console.log(RuntimeModule._load(resolve(process.cwd(), 'apps/gateway/src/index.cjs'), undefined, false));",
      ].join("\n"),
    },
    "destructured-reflect.mjs": {
      output: "gateway-esm",
      source: [
        'import { resolve } from "node:path";',
        'import { pathToFileURL } from "node:url";',
        "const target = pathToFileURL(resolve(process.cwd(), 'apps/gateway/src/index.mjs')).href;",
        "const { get } = Reflect;",
        "const HiddenFunction = get(() => undefined, 'constructor');",
        "const loaded = await HiddenFunction(`return import(${JSON.stringify(target)})`)();",
        "console.log(loaded.default);",
      ].join("\n"),
    },
    "global-process.cjs": {
      output: "gateway-cjs",
      source: [
        "const { resolve } = require('node:path');",
        "const RuntimeModule = globalThis.process.getBuiltinModule('module').Module;",
        "console.log(RuntimeModule._load(resolve(process.cwd(), 'apps/gateway/src/index.cjs'), undefined, false));",
      ].join("\n"),
    },
    "reflect-call.mjs": {
      output: "gateway-esm",
      source: [
        'import { resolve } from "node:path";',
        'import { pathToFileURL } from "node:url";',
        "const target = pathToFileURL(resolve(process.cwd(), 'apps/gateway/src/index.mjs')).href;",
        "const HiddenFunction = Reflect.get.call(Reflect, () => undefined, 'constructor');",
        "const loaded = await HiddenFunction(`return import(${JSON.stringify(target)})`)();",
        "console.log(loaded.default);",
      ].join("\n"),
    },
    "reflect-apply.mjs": {
      output: "gateway-esm",
      source: [
        'import { resolve } from "node:path";',
        'import { pathToFileURL } from "node:url";',
        "const target = pathToFileURL(resolve(process.cwd(), 'apps/gateway/src/index.mjs')).href;",
        "const HiddenFunction = Reflect.get.apply(Reflect, [() => undefined, 'constructor']);",
        "const loaded = await HiddenFunction(`return import(${JSON.stringify(target)})`)();",
        "console.log(loaded.default);",
      ].join("\n"),
    },
    "wrapper-arguments.cjs": {
      output: "gateway-cjs",
      source: [
        "const { resolve } = require('node:path');",
        "console.log(arguments['1'](resolve(process.cwd(), 'apps/gateway/src/index.cjs')));",
      ].join("\n"),
    },
    "wrapper-module-arguments.cjs": {
      output: "gateway-cjs",
      source: [
        "const { resolve } = require('node:path');",
        "console.log(arguments['2'].require(resolve(process.cwd(), 'apps/gateway/src/index.cjs')));",
      ].join("\n"),
    },
  };
  const root = await repositoryFixture(t, {
    "apps/gateway/package.json": manifest("@odinn/gateway", {
      exports: { ".": "./src/index.mjs" },
    }),
    "apps/gateway/src/index.cjs": "module.exports = 'gateway-cjs';\n",
    "apps/gateway/src/index.mjs": "export default 'gateway-esm';\n",
    "packages/host/package.json": manifest("@odinn/host", {
      exports: { ".": "./src/index.cjs" },
    }),
    "packages/host/src/index.cjs": "module.exports = { host: true };\n",
    ...Object.fromEntries(Object.entries(hostileSources)
      .map(([name, { source }]) => [`packages/host/src/${name}`, `${source}\n`])),
  });

  for (const [name, { output }] of Object.entries(hostileSources)) {
    assert.equal(runNodeProbe(root, `packages/host/src/${name}`), output, name);
  }

  const result = await checkFixture(root, { "@odinn/gateway": [], "@odinn/host": [] }, []);
  const rejectedFiles = new Set(result.violations
    .filter(({ kind, rule }) => kind === "module-loader"
      && rule === DEPENDENCY_RULES.unsupportedModuleLoader)
    .map(({ sourceFile }) => sourceFile.replace("packages/host/src/", "")));
  assert.deepEqual([...rejectedFiles].sort(), Object.keys(hostileSources).sort());
});

test("package-local node_modules redirects fail while canonical dependency links remain compatible", async (t) => {
  const root = await repositoryFixture(t, {
    "apps/gateway/package.json": manifest("@odinn/gateway"),
    "apps/gateway/src/index.ts": "export const gateway = true;\n",
    "packages/protocol/package.json": manifest("@odinn/protocol"),
    "packages/protocol/src/index.ts": "export const protocol = true;\n",
    "packages/host/package.json": manifest("@odinn/host", {
      dependencies: { "@odinn/protocol": "workspace:*", external: "^1.0.0", materialized: "^1.0.0" },
    }),
    "packages/host/src/index.ts": [
      'import "@odinn/protocol";',
      'import "external";',
      'import "gateway-alias";',
      'import "materialized";',
      'import "source-alias";',
      'import "tool-alias";',
    ].join("\n"),
    "scripts/tool.cjs": "module.exports = { tool: true };\n",
  });
  const scope = join(root, "packages/host/node_modules/@odinn");
  const externalPackage = join(root, "node_modules/.pnpm/external@1.0.0/node_modules/external");
  await mkdir(scope, { recursive: true });
  await mkdir(join(root, "packages/host/node_modules/materialized"), { recursive: true });
  await mkdir(externalPackage, { recursive: true });
  await writeFile(join(externalPackage, "package.json"), `${JSON.stringify({
    name: "external",
    version: "1.0.0",
    main: "index.cjs",
  })}\n`);
  await writeFile(join(externalPackage, "index.cjs"), "module.exports = { external: true };\n");
  await writeFile(
    join(root, "packages/host/node_modules/materialized/package.json"),
    `${JSON.stringify({ name: "materialized", version: "1.0.0", main: "index.cjs" })}\n`,
  );
  await writeFile(
    join(root, "packages/host/node_modules/materialized/index.cjs"),
    "module.exports = { materialized: true };\n",
  );
  try {
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(join(root, "packages/protocol"), join(scope, "protocol"), linkType);
    await symlink(externalPackage, join(root, "packages/host/node_modules/external"), linkType);
    await symlink(
      join(root, "apps/gateway"),
      join(root, "packages/host/node_modules/gateway-alias"),
      linkType,
    );
    await symlink(
      join(root, "packages/protocol/src/index.ts"),
      join(root, "packages/host/node_modules/source-alias"),
      "file",
    );
    await symlink(
      join(root, "scripts/tool.cjs"),
      join(root, "packages/host/node_modules/tool-alias"),
      "file",
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
      t.skip(`package-local links are unavailable on ${process.platform}: ${code}`);
      return;
    }
    throw error;
  }

  const result = await checkFixture(root, {
    "@odinn/gateway": [],
    "@odinn/host": ["@odinn/protocol"],
    "@odinn/protocol": [],
  }, []);
  assert.deepEqual(result.violations.map(({ sourceFile, specifier, kind, rule }) => ({
    sourceFile,
    specifier,
    kind,
    rule,
  })), ["gateway-alias", "materialized", "source-alias", "tool-alias"].map((specifier) => ({
    sourceFile: `packages/host/node_modules/${specifier}`,
    specifier,
    kind: "workspace-symlink" as const,
    rule: DEPENDENCY_RULES.unmanagedNodeModulesLink,
  })));
});

test("resolver-visible ancestor links preserve canonical workspace and external identities", async (t) => {
  const root = await repositoryFixture(t, {
    "apps/gateway/package.json": manifest("@odinn/gateway", {
      exports: { ".": "./src/index.cjs" },
    }),
    "apps/gateway/src/index.cjs": "module.exports = { gateway: true };\n",
    "packages/protocol/package.json": manifest("@odinn/protocol", {
      exports: { ".": "./src/index.cjs" },
    }),
    "packages/protocol/src/index.cjs": "module.exports = { protocol: true };\n",
    "packages/host/package.json": manifest("@odinn/host", {
      dependencies: { "@odinn/protocol": "workspace:*", declared: "1.0.0" },
      exports: { ".": "./src/index.cjs" },
    }),
    "packages/host/src/index.cjs": [
      "require('@odinn/protocol');",
      "require('declared');",
    ].join("\n"),
    "node_modules/.pnpm/other@1.0.0/node_modules/other/package.json": `${JSON.stringify({
      name: "other",
      version: "1.0.0",
      main: "index.cjs",
    })}\n`,
    "node_modules/.pnpm/other@1.0.0/node_modules/other/index.cjs": "module.exports = 'other';\n",
  });

  try {
    const linkType = process.platform === "win32" ? "junction" : "dir";
    const rootWorkspaceLink = join(root, "node_modules/@odinn/protocol");
    const localExternalLink = join(root, "packages/host/node_modules/declared");
    await mkdir(dirname(rootWorkspaceLink), { recursive: true });
    await mkdir(dirname(localExternalLink), { recursive: true });
    await symlink(join(root, "apps/gateway"), rootWorkspaceLink, linkType);
    await symlink(
      join(root, "node_modules/.pnpm/other@1.0.0/node_modules/other"),
      localExternalLink,
      linkType,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
      t.skip(`package links and junctions are unavailable on ${process.platform}: ${code}`);
      return;
    }
    throw error;
  }

  const result = await checkFixture(root, {
    "@odinn/gateway": [],
    "@odinn/host": ["@odinn/protocol"],
    "@odinn/protocol": [],
  }, []);

  assert.deepEqual(result.violations
    .filter(({ kind, rule }) => kind === "workspace-symlink"
      && rule === DEPENDENCY_RULES.unmanagedNodeModulesLink)
    .map(({ sourceFile, specifier }) => ({ sourceFile, specifier })), [
    {
      sourceFile: "node_modules/@odinn/protocol",
      specifier: "@odinn/protocol",
    },
    {
      sourceFile: "packages/host/node_modules/declared",
      specifier: "declared",
    },
  ]);
});

test("production package scripts use only closed-form audited entrypoints and typechecks", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host", {
      scripts: {
        start: "node ./dist/start.js",
        typecheck: "tsc -p tsconfig.json",
        loader: "node --loader ./src/loader.mjs ./src/index.ts",
        preload: "node --import ./src/preload.mjs ./src/index.ts",
        require: "node --require ./src/preload.cjs ./src/index.ts",
        shortRequire: "node -r ./src/preload.cjs ./src/index.ts",
        inlineEval: 'node -e "import(\\\"@odinn/gateway\\\")"',
        nodeOptions: "NODE_OPTIONS=--loader=./src/loader.mjs node ./src/index.ts",
        shellSplit: 'node --lo""ader ./src/loader.mjs ./src/index.ts',
        wrapper: "sh -c 'node ./src/index.ts'",
        escape: "node ../../../apps/gateway/src/index.ts",
        buildOutput: "node ./dist/hidden.js",
      },
    }),
    "packages/host/src/index.ts": "export const host = true;\n",
    "packages/host/dist/start.js": 'import "@odinn/gateway";\n',
    "packages/host/src/loader.mjs": "export const loader = true;\n",
    "packages/host/src/preload.mjs": "export const preload = true;\n",
    "packages/host/src/preload.cjs": "module.exports = {};\n",
    "packages/host/dist/hidden.js": "export const hidden = true;\n",
    "packages/host/tsconfig.json": "{}\n",
  });

  const result = await checkFixture(root, { "@odinn/host": [] }, []);
  const rejectedScripts = result.violations
    .filter(({ kind, rule }) => kind === "manifest-script" && rule === DEPENDENCY_RULES.moduleHookScript)
    .map(({ specifier }) => specifier)
    .sort();
  assert.deepEqual(rejectedScripts, [
    "escape",
    "inlineEval",
    "loader",
    "nodeOptions",
    "preload",
    "require",
    "shellSplit",
    "shortRequire",
    "wrapper",
  ]);
  assert(result.violations.some(({ sourceFile, rule }) =>
    sourceFile === "packages/host/dist/start.js" && rule === DEPENDENCY_RULES.unknownWorkspaceTarget));
});

test("safe conditional exports, extension modes, build targets, and ordinary code remain compatible", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/protocol/package.json": manifest("@odinn/protocol"),
    "packages/protocol/src/index.ts": "export interface Protocol {}\n",
    "packages/host/package.json": manifest("@odinn/host", {
      dependencies: { "@odinn/protocol": "workspace:*" },
      exports: {
        ".": {
          types: "./src/index.d.ts",
          import: "./src/index.mjs",
          require: "./src/index.cjs",
        },
        "./dist": "./dist/tool.mjs",
        "./features/*": "./dist/features/*.mjs",
        "./unused": { custom: "./src/custom.mjs", default: "./src/index.mjs" },
      },
    }),
    "packages/host/src/index.d.ts": "export interface HostType { readonly value: string }\n",
    "packages/host/src/index.mjs": "export const mode = 'import';\n",
    "packages/host/src/index.cjs": "exports.mode = 'require';\n",
    "packages/host/src/custom.mjs": "export const custom = true;\n",
    "packages/host/dist/tool.mjs": 'import "@odinn/protocol"; export const tool = true;\n',
    "packages/host/dist/features/one.mjs": "export const one = true;\n",
    "packages/consumer/package.json": manifest("@odinn/consumer", {
      dependencies: { "@odinn/host": "workspace:*" },
      exports: { ".": "./src/index.cts" },
    }),
    "packages/consumer/src/index.cts": [
      'import type { HostType } from "@odinn/host";',
      'import { mode } from "@odinn/host";',
      'import "@odinn/host/dist";',
      'import "@odinn/host/features/one";',
      'import "./local.cjs";',
      'const evaluatorName = "eval";',
      'const FunctionName = () => true;',
      'FunctionName();',
      'export type Value = HostType["value"];',
      'export { mode, evaluatorName };',
    ].join("\n"),
    "packages/consumer/src/importer.mts": 'import { mode } from "@odinn/host"; export { mode };\n',
    "packages/consumer/src/local.cjs": "exports.local = true;\n",
  });

  const result = await checkFixture(root, {
    "@odinn/consumer": ["@odinn/host"],
    "@odinn/host": ["@odinn/protocol"],
    "@odinn/protocol": [],
  }, []);

  assert.deepEqual(result.violations, []);
});

test("unreferenced conditional export targets cannot redirect into a nested workspace", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host", {
      exports: {
        ".": "./src/index.ts",
        "./unused": { "custom-condition": "./nested/src/index.ts", default: "./src/index.ts" },
      },
    }),
    "packages/host/src/index.ts": "export const host = true;\n",
    "packages/host/nested/package.json": manifest("@odinn/nested"),
    "packages/host/nested/src/index.ts": "export const nested = true;\n",
  });

  const result = await checkFixture(root, {
    "@odinn/host": [],
    "@odinn/nested": [],
  }, []);

  assert(result.violations.some(({ sourceFile, rule }) =>
    sourceFile === "packages/host/package.json" && rule === crossPackageExportTargetRule),
  JSON.stringify(result.violations));
});

test("every invalid export target is rejected even when no source imports it", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host", {
      exports: {
        ".": "./src/index.ts",
        "./escape": "../gateway/src/index.ts",
        "./percent": "./%2e%2e/gateway/src/index.ts",
        "./backslash": "./..\\gateway/src/index.ts",
        "./non-string": 42,
      },
    }),
    "packages/host/src/index.ts": "export const host = true;\n",
  });

  const result = await checkFixture(root, { "@odinn/host": [] }, []);
  assert.deepEqual(result.violations
    .filter(({ sourceFile, kind }) => sourceFile === "packages/host/package.json" && kind === "manifest-export")
    .map(({ specifier, rule }) => ({ specifier, rule })), [
    { specifier: "<invalid export target>", rule: DEPENDENCY_RULES.physicalExportTarget },
    { specifier: "../gateway/src/index.ts", rule: DEPENDENCY_RULES.physicalExportTarget },
    { specifier: "./%2e%2e/gateway/src/index.ts", rule: DEPENDENCY_RULES.physicalExportTarget },
    { specifier: "./..\\gateway/src/index.ts", rule: DEPENDENCY_RULES.physicalExportTarget },
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

  assert.deepEqual(result.violations.map(({ specifier, kind, rule }) => ({ specifier, kind, rule })), [
    {
      specifier: "@odinn/host/nested",
      kind: "import-declaration",
      rule: crossPackageExportTargetRule,
    },
    {
      specifier: "./nested/src/index.ts",
      kind: "manifest-export",
      rule: crossPackageExportTargetRule,
    },
  ]);
});

test("Node-resolved symlink exports cannot cross physical workspace ownership", {
  skip: process.platform === "win32" ? "unprivileged Windows CI cannot reliably create file symlinks" : false,
}, async (t) => {
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host", {
      exports: { ".": "./src/index.js", "./escape": "./src/escape.js" },
    }),
    "packages/host/src/index.js": 'export const selected = "host";\n',
    "packages/host/nested/package.json": manifest("@odinn/nested", { exports: { ".": "./src/index.js" } }),
    "packages/host/nested/src/index.js": 'export const selected = "nested";\n',
    "packages/consumer/package.json": manifest("@odinn/consumer", {
      dependencies: { "@odinn/host": "workspace:*" },
    }),
    "packages/consumer/src/index.ts": 'import "@odinn/host/escape";\n',
    "runtime-symlink-probe.mjs": [
      'import { selected } from "@odinn/host/escape";',
      "console.log(selected);",
    ].join("\n"),
  });
  await symlink("../nested/src/index.js", join(root, "packages/host/src/escape.js"), "file");
  if (!await linkRuntimePackage(t, root, "@odinn/host", join(root, "packages/host"))) return;

  assert.equal(runNodeProbe(root, "runtime-symlink-probe.mjs"), "nested");

  const result = await checkFixture(root, {
    "@odinn/consumer": ["@odinn/host"],
    "@odinn/host": [],
    "@odinn/nested": [],
  }, []);

  assert.deepEqual(result.violations.map(({ sourceFile, specifier, kind, rule }) => ({
    sourceFile,
    specifier,
    kind,
    rule,
  })), [
    {
      sourceFile: "packages/consumer/src/index.ts",
      specifier: "@odinn/host/escape",
      kind: "import-declaration",
      rule: crossPackageExportTargetRule,
    },
    {
      sourceFile: "packages/host/package.json",
      specifier: "./src/escape.js",
      kind: "manifest-export",
      rule: crossPackageExportTargetRule,
    },
    {
      sourceFile: "packages/host/src/escape.js",
      specifier: "packages/host/src/escape.js",
      kind: "workspace-symlink",
      rule: productionSymlinkRule,
    },
  ]);
});

test("broken and repository-escaping production symlinks fail closed", {
  skip: process.platform === "win32" ? "unprivileged Windows CI cannot reliably create file symlinks" : false,
}, async (t) => {
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host", {
      exports: { ".": "./src/index.js", "./broken": "./src/broken.js", "./outside": "./src/outside.js" },
    }),
    "packages/host/src/index.js": "export const host = true;\n",
    "packages/consumer/package.json": manifest("@odinn/consumer", {
      dependencies: { "@odinn/host": "workspace:*" },
    }),
    "packages/consumer/src/index.ts": [
      'import "@odinn/host/broken";',
      'import "@odinn/host/outside";',
    ].join("\n"),
  });
  const outside = join(dirname(root), `${root.split(/[\\/]/u).at(-1)}-outside.js`);
  t.after(() => rm(outside, { force: true }));
  await writeFile(outside, "export const outside = true;\n");
  await symlink("../missing.js", join(root, "packages/host/src/broken.js"), "file");
  await symlink(outside, join(root, "packages/host/src/outside.js"), "file");

  const result = await checkFixture(root, {
    "@odinn/consumer": ["@odinn/host"],
    "@odinn/host": [],
  }, []);

  assert.equal(result.violations.length, 6);
  assert.deepEqual(
    result.violations.map(({ rule }) => rule),
    [
      physicalExportTargetRule,
      physicalExportTargetRule,
      physicalExportTargetRule,
      physicalExportTargetRule,
      productionSymlinkRule,
      productionSymlinkRule,
    ],
  );
});

test("production symlinks remain forbidden inside skipped build output", async (t) => {
  const root = await repositoryFixture(t, {
    "packages/host/package.json": manifest("@odinn/host"),
    "packages/host/src/index.ts": "export const host = true;\n",
    "packages/host/dist/placeholder.txt": "generated output\n",
  });
  const linkPath = join(root, "packages/host/dist/source-link");
  try {
    await symlink(
      join(root, "packages/host/src"),
      linkPath,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
      t.skip(`directory links are unavailable on ${process.platform}: ${code}`);
      return;
    }
    throw error;
  }

  const result = await checkFixture(root, { "@odinn/host": [] }, []);

  assert.deepEqual(result.violations.map(({ sourceFile, kind, rule }) => ({
    sourceFile,
    kind,
    rule,
  })), [{
    sourceFile: "packages/host/dist/source-link",
    kind: "workspace-symlink",
    rule: productionSymlinkRule,
  }]);
});

test("workspace package roots cannot traverse symbolic links", {
  skip: process.platform === "win32" ? "unprivileged Windows CI cannot reliably create directory symlinks" : false,
}, async (t) => {
  const root = await repositoryFixture(t, {
    "pnpm-workspace.yaml": "packages:\n  - packages/host\n",
    "real-host/package.json": manifest("@odinn/host"),
    "real-host/src/index.ts": "export const host = true;\n",
  });
  await mkdir(join(root, "packages"), { recursive: true });
  await symlink(join(root, "real-host"), join(root, "packages/host"), "dir");

  await assert.rejects(
    checkFixture(root, { "@odinn/host": [] }, []),
    /package root must not traverse symbolic link packages\/host/u,
  );
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

test("TypeScript triple-slash path and type references obey the same package boundary", async (t) => {
  const root = await repositoryFixture(t, {
    "apps/gateway/package.json": manifest("@odinn/gateway"),
    "apps/gateway/src/index.ts": "export const gateway = true;\n",
    "packages/application/package.json": manifest("@odinn/application", {
      dependencies: { "@odinn/gateway": "workspace:*" },
      exports: { ".": "./src/index.d.ts" },
    }),
    "packages/application/src/local.d.ts": "export interface Local { readonly safe: true }\n",
    "packages/application/src/index.d.ts": [
      '/// <reference path="../../../apps/gateway/src/index.ts" />',
      '/// <reference types="@odinn/gateway" />',
      '/// <reference path="./local.d.ts" />',
      '/// <reference types="node" />',
      "export interface Application {}",
    ].join("\n"),
  });

  const result = await checkFixture(root, {
    "@odinn/application": [],
    "@odinn/gateway": [],
  }, []);

  assert.deepEqual(result.violations.filter(({ sourceFile, kind }) =>
    sourceFile === "packages/application/src/index.d.ts" && kind === "triple-slash-reference")
    .map(({ line, specifier, rule }) => ({ line, specifier, rule })), [
    {
      line: 1,
      specifier: "../../../apps/gateway/src/index.ts",
      rule: DEPENDENCY_RULES.crossPackageSourcePath,
    },
    {
      line: 2,
      specifier: "@odinn/gateway",
      rule: DEPENDENCY_RULES.packageToApp,
    },
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
