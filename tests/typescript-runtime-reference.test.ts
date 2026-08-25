import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { retainsTypeScriptRuntimeReference } from "../scripts/release/typescript-runtime-reference.ts";

const recorderAsset = "node_modules/playwright-core/lib/vite/recorder/assets/index-example.js";
const generatedBase = 'new URL(e, new URL("../../../src/node/plugins/importAnalysisBuild.ts", import.meta.url)).href';

test("allows only Playwright's inert Vite modulepreload resolution base", () => {
  assert.equal(retainsTypeScriptRuntimeReference(recorderAsset, generatedBase), false);
  assert.equal(retainsTypeScriptRuntimeReference(
    "node_modules/playwright-core/lib/vite/traceViewer/assets/index-example.js",
    generatedBase
  ), false);
});

test("retains the general TypeScript runtime-reference rejection", () => {
  for (const source of [
    'import "./source.ts";',
    'export { value } from "./source.ts";',
    'require("./source.ts");',
    'import("./source.ts");',
    'new URL("./source.ts", import.meta.url);'
  ]) assert.equal(retainsTypeScriptRuntimeReference(recorderAsset, source), true, source);
});

test("rejects mutations of the narrow Playwright Vite exception", () => {
  assert.equal(retainsTypeScriptRuntimeReference("dist/app.js", generatedBase), true);
  assert.equal(retainsTypeScriptRuntimeReference(
    recorderAsset,
    'new URL("./dependency.ts", new URL("../../../src/node/plugins/importAnalysisBuild.ts", import.meta.url)).href'
  ), true);
  assert.equal(retainsTypeScriptRuntimeReference(
    recorderAsset,
    'const base = new URL("../../../src/node/plugins/importAnalysisBuild.ts", import.meta.url)'
  ), true);
  assert.equal(retainsTypeScriptRuntimeReference(
    recorderAsset,
    'new Worker(new URL("../../../src/node/plugins/importAnalysisBuild.ts", import.meta.url))'
  ), true);
});

test("the pinned Playwright package has only the reviewed generated occurrences", async () => {
  const root = join(process.cwd(), "packages/kernel/node_modules/playwright-core/lib/vite");
  const paths: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".js")) paths.push(path);
    }
  }
  await walk(root);
  const matches: string[] = [];
  for (const path of paths) {
    const content = await readFile(path, "utf8");
    if (content.includes("../../../src/node/plugins/importAnalysisBuild.ts")) matches.push(path);
  }
  assert.deepEqual(matches.map((path) => path.slice(root.length + 1).replaceAll("\\", "/")).sort(), [
    "recorder/assets/index-DYjdXIbE.js",
    "traceViewer/assets/defaultSettingsView-B-dXF5JN.js"
  ]);
  for (const path of matches) {
    const archivePath = `node_modules/playwright-core/lib/vite/${path.slice(root.length + 1).replaceAll("\\", "/")}`;
    assert.equal(retainsTypeScriptRuntimeReference(archivePath, await readFile(path, "utf8")), false);
  }
});
