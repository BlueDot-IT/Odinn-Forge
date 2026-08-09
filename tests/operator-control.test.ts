import assert from "node:assert/strict";
import test from "node:test";
import { buildOperatorSnapshot, paginateOperatorItems, redactOperatorValue } from "../packages/kernel/src/operator-control.ts";

test("operator snapshot is bounded, paginated, and redacted", () => {
  const snapshot = buildOperatorSnapshot({
    surface: "tui",
    identity: { state: "/state", workspaceRoot: "/workspace", version: "1.0.0" },
    page: 2,
    pageSize: 1,
    sections: {
      work: {
        items: [
          { id: "job-1", kind: "job", label: "text.echo", status: "completed", details: { authorization: "secret", digest: "a".repeat(64) } },
          { id: "job-2", kind: "job", label: "process.exec", status: "needs-review", attention: true }
        ]
      }
    }
  });
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.surface, "tui");
  assert.equal(snapshot.sections.work.pagination.page, 2);
  assert.equal(snapshot.sections.work.pagination.total, 2);
  assert.equal(snapshot.sections.work.items[0]?.id, "job-2");
  assert.equal(snapshot.sections.work.items[0]?.attention, true);
  assert.equal(snapshot.sections.work.items[0]?.details, undefined);
  assert.equal(snapshot.health.status, "attention");
});

test("operator pagination clamps oversized pages and preserves deterministic order", () => {
  const page = paginateOperatorItems(["a", "b", "c"], 99, 500);
  assert.deepEqual(page.items, ["a", "b", "c"]);
  assert.deepEqual(page.pagination, { page: 1, pageSize: 50, pages: 1, total: 3, from: 1, to: 3 });
});

test("operator redaction removes authority-shaped fields and bounds arrays", () => {
  const value: any = redactOperatorValue({ authorization: "token", nested: { prompt: "private", safe: "ok" }, values: Array.from({ length: 100 }, (_, index) => index) });
  assert.equal(value.authorization, "[redacted]");
  assert.equal(value.nested.prompt, "[redacted]");
  assert.equal(value.nested.safe, "ok");
  assert.equal(value.values.length, 50);
});
