import assert from "node:assert/strict";
import test from "node:test";
import { clamp } from "./calculator.mjs";

test("clamp preserves a value inside the range", () => {
  assert.equal(clamp(5, 0, 10), 5);
});

test("clamp raises a value below the minimum", () => {
  assert.equal(clamp(-2, 0, 10), 0);
});

test("clamp lowers a value above the maximum", () => {
  assert.equal(clamp(12, 0, 10), 10);
});
