import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInferenceProtocolSmoke } from "./inference-smoke.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_P95_MAX_MS = 2_000;
const DEFAULT_SAMPLE_COUNT = 20;

export function parseP95Threshold(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_P95_MAX_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`ODINN_BENCHMARK_P95_MAX_MS must be a finite number greater than zero; received ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function parseSampleCount(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SAMPLE_COUNT;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`ODINN_BENCHMARK_SAMPLES must be a positive safe integer; received ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function percentile(samples: readonly number[], quantile: number): number {
  if (samples.length === 0) throw new Error("benchmark requires at least one sample");
  if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1) {
    throw new Error(`benchmark quantile must be greater than zero and at most one; received ${quantile}`);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]!;
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    shell: process.platform === "win32"
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}

async function preparePackagedRelease(): Promise<string> {
  run("corepack", ["pnpm", "build"]);
  run("corepack", ["pnpm", "release:package"]);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const packageRoot = join(root, "dist", "package-stage", `odinn-v${pkg.version}`);
  const gatewayLauncher = join(
    packageRoot,
    "bin",
    process.platform === "win32" ? "odinn-gateway.cmd" : "odinn-gateway"
  );
  const launcher = await readFile(gatewayLauncher, "utf8");
  if (!/dist[\\/]gateway[\\/]server\.js/u.test(launcher)) {
    throw new Error(`packaged gateway launcher is missing or does not target the compiled gateway: ${gatewayLauncher}`);
  }
  return packageRoot;
}

async function writeReport(report: Record<string, unknown>): Promise<void> {
  const output = process.env.ODINN_BENCHMARK_JSON ?? join(root, "dist", "benchmark", "benchmark.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`benchmark report: ${relative(root, output)}`);
}

function commandVersion(command: string, args: string[], fallback: string): string {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", env: process.env, shell: process.platform === "win32" });
  return result.status === 0 ? result.stdout.trim() : fallback;
}

export function isMainModule(moduleUrl: string, argv1 = process.argv[1]): boolean {
  return Boolean(argv1) && moduleUrl === pathToFileURL(argv1).href;
}

export async function main(): Promise<void> {
  const maxP95Ms = parseP95Threshold(process.env.ODINN_BENCHMARK_P95_MAX_MS);
  const sampleCount = parseSampleCount(process.env.ODINN_BENCHMARK_SAMPLES);
  const packageRoot = await preparePackagedRelease();
  const gatewayCommand = join(
    packageRoot,
    "bin",
    process.platform === "win32" ? "odinn-gateway.cmd" : "odinn-gateway"
  );
  const samples: number[] = [];
  const startedAt = new Date().toISOString();
  let failure: string | undefined;

  for (let index = 0; index < sampleCount; index += 1) {
    const started = performance.now();
    try {
      await runInferenceProtocolSmoke({ root: packageRoot, gatewayCommand, gatewayArgs: [] });
      samples.push(Number((performance.now() - started).toFixed(3)));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      break;
    }
  }

  const report: Record<string, unknown> = {
    schemaVersion: 1,
    benchmark: "packaged-gateway-inference-smoke",
    startedAt,
    completedAt: new Date().toISOString(),
    sampleTarget: sampleCount,
    samples,
    p95MaxMs: maxP95Ms,
    packageRoot: relative(root, packageRoot),
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    provenance: {
      command: "pnpm benchmark:ci",
      commit: process.env.GITHUB_SHA ?? commandVersion("git", ["rev-parse", "HEAD"], "unknown"),
      packageVersion: JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
      pnpm: commandVersion("corepack", ["pnpm", "--version"], "unknown")
    },
    ...(samples.length === 0 ? {} : {
      p50Ms: Number(percentile(samples, 0.5).toFixed(2)),
      p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
      maxMs: Number(Math.max(...samples).toFixed(2))
    }),
    ...(failure === undefined ? {} : { failure })
  };
  await writeReport(report);

  if (failure !== undefined) throw new Error(`packaged benchmark failed after ${samples.length} samples: ${failure}`);
  const p95Ms = report.p95Ms as number;
  if (p95Ms > maxP95Ms) {
    throw new Error(`packaged gateway p95 exceeded ${maxP95Ms} ms: ${p95Ms} ms`);
  }
  console.log(JSON.stringify(report, null, 2));
}

if (isMainModule(import.meta.url)) {
  await main();
}
