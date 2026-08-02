import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceList, workspaceSearch } from "../../packages/kernel/src/index.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Stage 3 gates are declared here before any fixture is created or operation is
// measured. Environment overrides support slower platform evidence without
// silently changing the committed defaults used by CI.
const gates = Object.freeze({
  fileCount: boundedEnvironment("ODINN_WORKSPACE_BENCHMARK_FILES", 10_000, 1_000, 100_000),
  maxDepth: 4,
  maxResultsPerPage: 128,
  maxScannedBytes: 1_048_576,
  maxHeapGrowthBytes: 96 * 1024 * 1024,
  maxDurationMs: boundedEnvironment("ODINN_WORKSPACE_BENCHMARK_MAX_MS", 15_000, 1_000, 120_000),
  maxPaginationDurationMs: boundedEnvironment("ODINN_WORKSPACE_BENCHMARK_PAGINATION_MAX_MS", 120_000, 1_000, 600_000)
});

function boundedEnvironment(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

// This is intentionally independent of the production implementation. The
// public pagination contract is depth-first, component-wise preorder: a
// directory's descendants precede a later sibling such as `a.txt`.
function compareExpectedPaths(left: string, right: string) {
  const leftParts = left.split("/");
  const rightParts = right.split("/");
  const sharedLength = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const comparison = leftParts[index]!.localeCompare(rightParts[index]!, "en");
    if (comparison !== 0) return comparison;
  }
  return leftParts.length - rightParts.length;
}

async function seedFiles(workspace: string) {
  const expectedPaths: string[] = [];
  const batchSize = 200;
  for (let start = 0; start < gates.fileCount; start += batchSize) {
    const end = Math.min(gates.fileCount, start + batchSize);
    await Promise.all(Array.from({ length: end - start }, async (_, offset) => {
      const index = start + offset;
      const name = `file-${String(index).padStart(6, "0")}.txt`;
      await writeFile(join(workspace, name), `fixture ${index}\n`, "utf8");
      expectedPaths.push(name);
    }));
  }
  await mkdir(join(workspace, "a"));
  await writeFile(join(workspace, "a", "z"), "interleaved child\n", "utf8");
  await writeFile(join(workspace, "a.txt"), "interleaved sibling\n", "utf8");
  expectedPaths.push("a", "a/z", "a.txt");
  let directory = join(workspace, "depth");
  let relativeDirectory = "depth";
  expectedPaths.push(relativeDirectory);
  for (let depth = 0; depth <= gates.maxDepth + 1; depth += 1) {
    directory = join(directory, `level-${depth}`);
    relativeDirectory = `${relativeDirectory}/level-${depth}`;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `depth-${depth}.txt`), `depth ${depth}\n`, "utf8");
    if (depth < gates.maxDepth) expectedPaths.push(relativeDirectory);
    if (depth < gates.maxDepth - 1) expectedPaths.push(`${relativeDirectory}/depth-${depth}.txt`);
  }
  return expectedPaths.sort(compareExpectedPaths);
}

async function writeReport(report: Record<string, unknown>) {
  const output = process.env.ODINN_WORKSPACE_BENCHMARK_JSON
    ?? join(root, "dist", "benchmark", "workspace-inspection.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`workspace inspection benchmark report: ${relative(root, output)}`);
}

const workspace = await mkdtemp(join(tmpdir(), "odinn-workspace-benchmark-"));
try {
  const expectedPaths = await seedFiles(workspace);
  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const first = await workspaceList(workspace, {
    recursive: true,
    limit: gates.maxResultsPerPage,
    maxDepth: gates.maxDepth,
    maxFiles: gates.fileCount + 32,
    maxBytes: gates.maxScannedBytes
  });
  const durationMs = performance.now() - started;
  const heapAfter = process.memoryUsage().heapUsed;
  const heapGrowthBytes = Math.max(0, heapAfter - heapBefore);
  const allPaths: string[] = first.entries.map((entry: { path: string }) => entry.path);
  let cursor = first.nextCursor;
  let pageCount = 1;
  let peakHeapGrowthBytes = heapGrowthBytes;
  const paginationStarted = performance.now();
  while (cursor) {
    const page = await workspaceList(workspace, {
      recursive: true,
      limit: gates.maxResultsPerPage,
      maxDepth: gates.maxDepth,
      maxFiles: gates.fileCount + 32,
      maxBytes: gates.maxScannedBytes,
      cursor
    });
    if (page.entries.length > gates.maxResultsPerPage) throw new Error("workspace inspection page exceeded the result gate");
    allPaths.push(...page.entries.map((entry: { path: string }) => entry.path));
    cursor = page.nextCursor;
    pageCount += 1;
    if (pageCount > Math.ceil(expectedPaths.length / gates.maxResultsPerPage) + 1) throw new Error("workspace inspection pagination did not terminate");
    globalThis.gc?.();
    peakHeapGrowthBytes = Math.max(peakHeapGrowthBytes, Math.max(0, process.memoryUsage().heapUsed - heapBefore));
  }
  const paginationDurationMs = performance.now() - paginationStarted;
  const repeated = await workspaceList(workspace, {
    recursive: true,
    limit: gates.maxResultsPerPage,
    maxDepth: gates.maxDepth,
    maxFiles: gates.fileCount + 32,
    maxBytes: gates.maxScannedBytes
  });

  let fileCeilingEnforced = false;
  try {
    await workspaceList(workspace, { limit: 1, maxFiles: gates.fileCount - 1 });
  } catch (error) {
    fileCeilingEnforced = error instanceof Error && /maxFiles traversal ceiling/u.test(error.message);
  }
  let byteCeilingEnforced = false;
  const byteLimited = await workspaceSearch(workspace, {
    query: "not-present-in-fixture",
    limit: 1,
    maxDepth: gates.maxDepth,
    maxFiles: gates.fileCount + 32,
    maxBytes: 1_024
  });
  byteCeilingEnforced = byteLimited.searchedBytes <= 1_024 && typeof byteLimited.nextCursor === "string";

  const firstPaths = first.entries.map((entry: { path: string }) => entry.path);
  const repeatedPaths = repeated.entries.map((entry: { path: string }) => entry.path);
  const deepestReturned = allPaths
    .reduce((maximum, path) => Math.max(maximum, path.split("/").length - 1), 0);
  const uniquePaths = new Set(allPaths);
  const checks = {
    fileCeilingEnforced,
    depthBounded: deepestReturned <= gates.maxDepth + 1,
    resultBounded: first.entries.length <= gates.maxResultsPerPage,
    byteCeilingEnforced,
    heapBounded: peakHeapGrowthBytes <= gates.maxHeapGrowthBytes,
    timeBounded: durationMs <= gates.maxDurationMs,
    paginationTimeBounded: paginationDurationMs <= gates.maxPaginationDurationMs,
    deterministic: JSON.stringify(firstPaths) === JSON.stringify(repeatedPaths),
    paginationExact: JSON.stringify(allPaths) === JSON.stringify(expectedPaths),
    paginationUnique: uniquePaths.size === allPaths.length
  };
  const report = {
    schemaVersion: 1,
    benchmark: "bounded-large-workspace-inspection",
    environment: { platform: process.platform, architecture: process.arch, node: process.version },
    gates,
    measurements: {
      durationMs: Number(durationMs.toFixed(3)),
      heapBeforeBytes: heapBefore,
      heapAfterBytes: heapAfter,
      heapGrowthBytes,
      peakHeapGrowthBytes,
      firstPageResults: first.entries.length,
      totalResults: allPaths.length,
      expectedResults: expectedPaths.length,
      pageCount,
      paginationDurationMs: Number(paginationDurationMs.toFixed(3)),
      deepestReturned,
      firstVisited: first.visited
    },
    checks,
    passed: Object.values(checks).every(Boolean)
  };
  await writeReport(report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) throw new Error(`workspace inspection benchmark gates failed: ${Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name).join(", ")}`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
