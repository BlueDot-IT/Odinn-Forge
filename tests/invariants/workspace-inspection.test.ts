import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workspaceList } from "../../packages/kernel/src/index.ts";

const FILE_COUNT = 10_000;
const PAGE_SIZE = 1_000;
const MAX_HEAP_GROWTH_BYTES = 96 * 1024 * 1024;

test("large workspace traversal remains exact, unique, and heap bounded", { timeout: 180_000 }, async () => {
  assert.ok(globalThis.gc, "workspace resource invariants require --expose-gc");
  const workspace = await mkdtemp(join(tmpdir(), "odinn-workspace-invariant-"));
  try {
    const expected = Array.from(
      { length: FILE_COUNT },
      (_, index) => `file-${String(index).padStart(6, "0")}.txt`
    );
    const batchSize = 200;
    for (let start = 0; start < expected.length; start += batchSize) {
      await Promise.all(expected.slice(start, start + batchSize).map(
        async (name, offset) => writeFile(join(workspace, name), `fixture ${start + offset}\n`, "utf8")
      ));
    }

    globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    let peakHeapGrowthBytes = 0;
    const paths: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    const observeHeap = () => {
      peakHeapGrowthBytes = Math.max(
        peakHeapGrowthBytes,
        Math.max(0, process.memoryUsage().heapUsed - heapBefore)
      );
    };
    do {
      const page = await workspaceList(workspace, {
        recursive: true,
        limit: PAGE_SIZE,
        maxDepth: 4,
        maxFiles: FILE_COUNT,
        maxBytes: 1_048_576,
        ...(cursor ? { cursor } : {})
      }, {
        hooks: { beforeDirectoryPostValidation: observeHeap }
      });
      assert.ok(page.entries.length <= PAGE_SIZE, String(page.entries.length));
      assert.ok(page.resultBytes <= 1_048_576, String(page.resultBytes));
      paths.push(...page.entries.map((entry: { path: string }) => entry.path));
      cursor = page.nextCursor;
      pages += 1;
      assert.ok(pages <= Math.ceil(FILE_COUNT / PAGE_SIZE), String(pages));
      observeHeap();
      globalThis.gc();
      observeHeap();
    } while (cursor);

    assert.deepEqual(paths, expected);
    assert.equal(new Set(paths).size, paths.length);
    assert.ok(
      peakHeapGrowthBytes <= MAX_HEAP_GROWTH_BYTES,
      `heap growth ${peakHeapGrowthBytes} exceeded ${MAX_HEAP_GROWTH_BYTES}`
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
