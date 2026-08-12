import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { isMainModule, runCompiledInferenceSmoke } from "../scripts/ci/compiled-inference-smoke.ts";

test("compiled inference smoke recognizes the host platform entrypoint", () => {
  const nativePath = fileURLToPath(import.meta.url);
  assert.equal(isMainModule(pathToFileURL(nativePath).href, nativePath), true);
  assert.equal(isMainModule(import.meta.url, ""), false);
});

test("staged compiled gateway routes a configured provider and persists its response", async () => {
  await runCompiledInferenceSmoke();
});
