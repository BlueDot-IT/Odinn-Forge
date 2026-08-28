#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const defaultReportPath = join(root, "dist", "reports", "phase-f-long-soak", "long-soak-report.json");
const fullShaPattern = /^[a-f0-9]{40}$/u;

export type LongSoakProfile = "development" | "nightly";

export interface LongSoakConfig {
  profile: LongSoakProfile;
  targetDurationMs: number;
  minimumCycles: number;
  cycleIntervalMs: number;
  auditEvents: number;
  commandTimeoutMs: number;
  reportPath: string;
  allowDirty: boolean;
  budgets: {
    maximumFailedCycles: number;
    maximumCycleDurationMs: number;
    maximumPeakProcessTreeRssBytes: number;
    minimumRestartsPerCycle: number;
    minimumPowerLossesPerCycle: number;
    minimumRecoveredJobsPerCycle: number;
    maximumUnresolvedApprovals: number;
  };
}

interface CommandResult {
  stdout: string;
  durationMs: number;
  peakProcessTreeRssBytes: number | null;
  resourceMeasurement: "linux-process-tree" | "unavailable";
}

interface CycleEvidence {
  index: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  peakProcessTreeRssBytes: number | null;
  resourceMeasurement: "linux-process-tree" | "unavailable";
  release: Record<string, unknown> | null;
  audit: Record<string, unknown> | null;
  violations: string[];
  ok: boolean;
  failure?: { stage: "release" | "audit" | "validation"; category: string };
}

const profileDefaults: Record<LongSoakProfile, Omit<LongSoakConfig, "profile" | "reportPath" | "allowDirty">> = {
  development: {
    targetDurationMs: 0,
    minimumCycles: 2,
    cycleIntervalMs: 0,
    auditEvents: 200,
    commandTimeoutMs: 15 * 60_000,
    budgets: {
      maximumFailedCycles: 0,
      maximumCycleDurationMs: 15 * 60_000,
      maximumPeakProcessTreeRssBytes: 3 * 1024 ** 3,
      minimumRestartsPerCycle: 2,
      minimumPowerLossesPerCycle: 1,
      minimumRecoveredJobsPerCycle: 1,
      maximumUnresolvedApprovals: 0
    }
  },
  nightly: {
    targetDurationMs: 2 * 60 * 60_000,
    minimumCycles: 12,
    cycleIntervalMs: 5 * 60_000,
    auditEvents: 5_000,
    commandTimeoutMs: 20 * 60_000,
    budgets: {
      maximumFailedCycles: 0,
      maximumCycleDurationMs: 20 * 60_000,
      maximumPeakProcessTreeRssBytes: 4 * 1024 ** 3,
      minimumRestartsPerCycle: 2,
      minimumPowerLossesPerCycle: 1,
      minimumRecoveredJobsPerCycle: 1,
      maximumUnresolvedApprovals: 0
    }
  }
};

function parseInteger(name: string, raw: string, minimum: number): number {
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be at least ${minimum}`);
  return value;
}

export function resolveLongSoakConfig(args = process.argv.slice(2)): LongSoakConfig {
  const values = new Map<string, string>();
  let allowDirty = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--allow-dirty") {
      allowDirty = true;
      continue;
    }
    if (!argument.startsWith("--")) throw new Error(`unexpected long-soak argument: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    values.set(argument, value);
    index += 1;
  }
  const allowed = new Set([
    "--profile",
    "--duration-ms",
    "--min-cycles",
    "--cycle-interval-ms",
    "--audit-events",
    "--command-timeout-ms",
    "--max-cycle-ms",
    "--max-rss-bytes",
    "--report"
  ]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`unsupported long-soak option: ${key}`);

  const profile = (values.get("--profile") ?? "development") as LongSoakProfile;
  if (!(profile in profileDefaults)) throw new Error(`unsupported long-soak profile: ${profile}`);
  const defaults = profileDefaults[profile];
  const config: LongSoakConfig = {
    profile,
    targetDurationMs: values.has("--duration-ms")
      ? parseInteger("--duration-ms", values.get("--duration-ms")!, 0)
      : defaults.targetDurationMs,
    minimumCycles: values.has("--min-cycles")
      ? parseInteger("--min-cycles", values.get("--min-cycles")!, 1)
      : defaults.minimumCycles,
    cycleIntervalMs: values.has("--cycle-interval-ms")
      ? parseInteger("--cycle-interval-ms", values.get("--cycle-interval-ms")!, 0)
      : defaults.cycleIntervalMs,
    auditEvents: values.has("--audit-events")
      ? parseInteger("--audit-events", values.get("--audit-events")!, 1)
      : defaults.auditEvents,
    commandTimeoutMs: values.has("--command-timeout-ms")
      ? parseInteger("--command-timeout-ms", values.get("--command-timeout-ms")!, 1_000)
      : defaults.commandTimeoutMs,
    reportPath: resolve(values.get("--report") ?? defaultReportPath),
    allowDirty,
    budgets: {
      ...defaults.budgets,
      maximumCycleDurationMs: values.has("--max-cycle-ms")
        ? parseInteger("--max-cycle-ms", values.get("--max-cycle-ms")!, 1_000)
        : defaults.budgets.maximumCycleDurationMs,
      maximumPeakProcessTreeRssBytes: values.has("--max-rss-bytes")
        ? parseInteger("--max-rss-bytes", values.get("--max-rss-bytes")!, 1024 ** 2)
        : defaults.budgets.maximumPeakProcessTreeRssBytes
    }
  };
  if (profile === "nightly" && config.targetDurationMs < 60 * 60_000) {
    throw new Error("the nightly long-soak duration must be at least one hour");
  }
  if (profile === "nightly" && config.minimumCycles < 8) {
    throw new Error("the nightly long-soak must execute at least eight complete cycles");
  }
  return config;
}

function gitOutput(args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args[0] ?? "command"} failed categorically`);
  }
  return result.stdout.trim();
}

function sampleLinuxProcessTreeRss(rootPid: number): number | null {
  if (process.platform !== "linux") return null;
  const result = spawnSync("ps", ["-e", "-o", "pid=,ppid=,rss="], {
    encoding: "utf8",
    shell: false,
    timeout: 5_000
  });
  if (result.error || result.status !== 0) return null;
  const rows = result.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).map(Number))
    .filter((row) => row.length === 3 && row.every(Number.isFinite))
    .map(([pid, parentPid, rssKiB]) => ({ pid: pid!, parentPid: parentPid!, rssKiB: rssKiB! }));
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.parentPid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return rows
    .filter((row) => descendants.has(row.pid))
    .reduce((total, row) => total + row.rssKiB * 1024, 0);
}

async function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv }
): Promise<CommandResult> {
  return await new Promise((resolveRun, rejectRun) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...(options.env ?? {}) },
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let peakProcessTreeRssBytes: number | null = null;
    const append = (current: string, chunk: unknown) => `${current}${String(chunk)}`.slice(-1_000_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const sample = () => {
      const measured = sampleLinuxProcessTreeRss(child.pid!);
      if (measured !== null) peakProcessTreeRssBytes = Math.max(peakProcessTreeRssBytes ?? 0, measured);
    };
    sample();
    const sampler = setInterval(sample, 1_000);
    sampler.unref();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform !== "win32" && typeof child.pid === "number") process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (process.platform !== "win32" && typeof child.pid === "number") {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* process group already exited */ }
        } else child.kill("SIGKILL");
      }, 5_000);
      force.unref();
    }, options.timeoutMs);
    child.once("error", (error) => {
      clearInterval(sampler);
      clearTimeout(timeout);
      rejectRun(new Error(`command-start-failed:${error.name}`));
    });
    child.once("close", (status, signal) => {
      clearInterval(sampler);
      clearTimeout(timeout);
      sample();
      if (timedOut) {
        rejectRun(new Error("command-timeout"));
        return;
      }
      if (status !== 0) {
        const category = stderr.length > 0 || stdout.length > 0 ? "command-failed-with-output" : "command-failed";
        rejectRun(new Error(`${category}:${status ?? signal ?? "unknown"}`));
        return;
      }
      resolveRun({
        stdout,
        durationMs: Date.now() - started,
        peakProcessTreeRssBytes,
        resourceMeasurement: peakProcessTreeRssBytes === null ? "unavailable" : "linux-process-tree"
      });
    });
  });
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} is missing from soak evidence`);
  return value;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} is missing from soak evidence`);
  return value;
}

export function evaluateLongSoakCycle(cycle: CycleEvidence, config: LongSoakConfig): string[] {
  const violations = [...cycle.violations];
  const release = cycle.release ?? {};
  const audit = cycle.audit ?? {};
  if (release.finalState !== "passed") violations.push("release-cycle-failed");
  if (requiredNumber(release.restartCount, "release.restartCount") < config.budgets.minimumRestartsPerCycle) {
    violations.push("restart-budget-missed");
  }
  if (requiredNumber(release.powerLossCount, "release.powerLossCount") < config.budgets.minimumPowerLossesPerCycle) {
    violations.push("power-loss-budget-missed");
  }
  if (requiredNumber(release.recoveredJobs, "release.recoveredJobs") < config.budgets.minimumRecoveredJobsPerCycle) {
    violations.push("recovery-budget-missed");
  }
  if (requiredNumber(release.unresolvedApprovals, "release.unresolvedApprovals") > config.budgets.maximumUnresolvedApprovals) {
    violations.push("approval-budget-exceeded");
  }
  if (!requiredBoolean(release.auditVerification, "release.auditVerification")) violations.push("release-audit-invalid");
  if (!requiredBoolean(release.browserRecoveryBlocked, "release.browserRecoveryBlocked")) violations.push("browser-recovery-not-enforced");
  if (!requiredBoolean(release.rollbackVerified, "release.rollbackVerified")) violations.push("rollback-not-verified");
  for (const field of ["ok", "restart", "rotation", "archive", "retention"] as const) {
    if (!requiredBoolean(audit[field], `audit.${field}`)) violations.push(`audit-${field}-failed`);
  }
  if (cycle.durationMs > config.budgets.maximumCycleDurationMs) violations.push("cycle-duration-budget-exceeded");
  if (
    cycle.peakProcessTreeRssBytes !== null
    && cycle.peakProcessTreeRssBytes > config.budgets.maximumPeakProcessTreeRssBytes
  ) violations.push("process-tree-rss-budget-exceeded");
  if (config.profile === "nightly" && cycle.peakProcessTreeRssBytes === null) {
    violations.push("process-tree-rss-measurement-unavailable");
  }
  return [...new Set(violations)].sort();
}

function parseLastJsonLine(output: string): Record<string, unknown> {
  const lines = output.trim().split("\n").filter(Boolean);
  const parsed = JSON.parse(lines.at(-1) ?? "null");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("command-result-invalid");
  return parsed as Record<string, unknown>;
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function categoricalFailure(error: unknown): string {
  if (!(error instanceof Error)) return "unknown-failure";
  return error.message.split(":", 1)[0]!.replaceAll(/[^a-z0-9-]/giu, "-").toLowerCase();
}

async function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function runLongSoak(config = resolveLongSoakConfig()): Promise<Record<string, unknown>> {
  const sourceCommit = gitOutput(["rev-parse", "HEAD"]);
  if (!fullShaPattern.test(sourceCommit)) throw new Error("long-soak source is not bound to a full Git commit");
  const dirty = gitOutput(["status", "--porcelain"]).length > 0;
  const startedAtMs = Date.now();
  const cycles: CycleEvidence[] = [];
  const report: Record<string, any> = {
    schemaVersion: 1,
    kind: "odinn.phase-f.long-soak",
    status: "running",
    source: { commit: sourceCommit, dirty, exactCommit: !dirty },
    profile: {
      name: config.profile,
      targetDurationMs: config.targetDurationMs,
      minimumCycles: config.minimumCycles,
      cycleIntervalMs: config.cycleIntervalMs,
      auditEvents: config.auditEvents
    },
    budgets: config.budgets,
    startedAt: new Date(startedAtMs).toISOString(),
    cycles,
    violations: []
  };
  await writeJsonAtomically(config.reportPath, report);
  if (dirty && !config.allowDirty) {
    report.status = "failed";
    report.violations = ["source-worktree-dirty"];
    report.endedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAtMs;
    await writeJsonAtomically(config.reportPath, report);
    throw new Error("long-soak acceptance requires a clean exact-commit checkout");
  }

  try {
    while (cycles.length < config.minimumCycles || Date.now() - startedAtMs < config.targetDurationMs) {
      const cycleStartedAtMs = Date.now();
      const cycle: CycleEvidence = {
        index: cycles.length + 1,
        startedAt: new Date(cycleStartedAtMs).toISOString(),
        endedAt: "",
        durationMs: 0,
        peakProcessTreeRssBytes: null,
        resourceMeasurement: "unavailable",
        release: null,
        audit: null,
        violations: [],
        ok: false
      };
      cycles.push(cycle);
      try {
        const releaseResult = await runCommand(process.execPath, [join(root, "scripts", "release", "soak.ts")], {
          timeoutMs: config.commandTimeoutMs,
          env: { ODINN_SOAK_POWER_LOSS: "1" }
        });
        cycle.peakProcessTreeRssBytes = releaseResult.peakProcessTreeRssBytes;
        cycle.resourceMeasurement = releaseResult.resourceMeasurement;
        cycle.release = JSON.parse(await readFile(join(root, "dist", "release", "soak-report.json"), "utf8"));
        if (cycle.release?.commit !== sourceCommit) cycle.violations.push("release-commit-mismatch");

        const auditResult = await runCommand(process.execPath, [join(root, "scripts", "ci", "audit-soak.ts")], {
          timeoutMs: config.commandTimeoutMs,
          env: { ODINN_AUDIT_SOAK_EVENTS: String(config.auditEvents) }
        });
        cycle.peakProcessTreeRssBytes = Math.max(
          cycle.peakProcessTreeRssBytes ?? 0,
          auditResult.peakProcessTreeRssBytes ?? 0
        ) || null;
        if (auditResult.resourceMeasurement === "linux-process-tree") cycle.resourceMeasurement = "linux-process-tree";
        cycle.audit = parseLastJsonLine(auditResult.stdout);
        cycle.endedAt = new Date().toISOString();
        cycle.durationMs = Date.now() - cycleStartedAtMs;
        cycle.violations = evaluateLongSoakCycle(cycle, config);
        cycle.ok = cycle.violations.length === 0;
      } catch (error) {
        cycle.endedAt = new Date().toISOString();
        cycle.durationMs = Date.now() - cycleStartedAtMs;
        cycle.failure = {
          stage: cycle.release === null ? "release" : cycle.audit === null ? "audit" : "validation",
          category: categoricalFailure(error)
        };
        cycle.violations = [...new Set([...cycle.violations, "cycle-execution-failed"])].sort();
      }
      await writeJsonAtomically(config.reportPath, report);
      if (!cycle.ok) break;
      const targetNextCycleAt = cycleStartedAtMs + config.cycleIntervalMs;
      if (cycles.length < config.minimumCycles || Date.now() - startedAtMs < config.targetDurationMs) {
        await delay(Math.max(0, targetNextCycleAt - Date.now()));
      }
    }

    const endedAtMs = Date.now();
    const failedCycles = cycles.filter((cycle) => !cycle.ok).length;
    const violations: string[] = [];
    if (failedCycles > config.budgets.maximumFailedCycles) violations.push("cycle-error-budget-exceeded");
    if (cycles.length < config.minimumCycles) violations.push("minimum-cycle-budget-missed");
    if (endedAtMs - startedAtMs < config.targetDurationMs) violations.push("duration-budget-missed");
    report.status = violations.length > 0
      ? "failed"
      : dirty
        ? "passed-nonqualifying"
        : "passed";
    report.endedAt = new Date(endedAtMs).toISOString();
    report.durationMs = endedAtMs - startedAtMs;
    report.summary = {
      totalCycles: cycles.length,
      passedCycles: cycles.length - failedCycles,
      failedCycles,
      totalRestarts: cycles.reduce((total, cycle) => total + Number(cycle.release?.restartCount ?? 0), 0),
      totalPowerLosses: cycles.reduce((total, cycle) => total + Number(cycle.release?.powerLossCount ?? 0), 0),
      totalRecoveredJobs: cycles.reduce((total, cycle) => total + Number(cycle.release?.recoveredJobs ?? 0), 0),
      peakProcessTreeRssBytes: Math.max(0, ...cycles.map((cycle) => cycle.peakProcessTreeRssBytes ?? 0)),
      resourceMeasurement: cycles.some((cycle) => cycle.resourceMeasurement === "linux-process-tree")
        ? "linux-process-tree"
        : "unavailable"
    };
    report.violations = violations;
    report.qualificationWarnings = dirty ? ["source-worktree-dirty"] : [];
    await writeJsonAtomically(config.reportPath, report);
    if (report.status === "failed") throw new Error(`long-soak failed: ${violations.join(", ")}`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report;
  } catch (error) {
    if (report.status === "running") {
      report.status = "failed";
      report.endedAt = new Date().toISOString();
      report.durationMs = Date.now() - startedAtMs;
      report.violations = [categoricalFailure(error)];
      await writeJsonAtomically(config.reportPath, report);
    }
    throw error;
  }
}

export function isMainModule(moduleUrl: string, argv1 = process.argv[1]): boolean {
  return Boolean(argv1) && moduleUrl === pathToFileURL(argv1).href;
}

if (isMainModule(import.meta.url)) {
  await runLongSoak();
}
