import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTags } from "./tags.mjs";

test("normalizes case and surrounding whitespace", () => {
  assert.deepEqual(normalizeTags([" Red ", "BLUE"]), ["red", "blue"]);
});

test("removes empty and non-string values", () => {
  assert.deepEqual(normalizeTags(["alpha", "", "  ", null, 7, "beta"]), ["alpha", "beta"]);
});

test("deduplicates while preserving first-seen order", () => {
  assert.deepEqual(normalizeTags(["Blue", "red", " blue ", "RED", "green"]), ["blue", "red", "green"]);
});
