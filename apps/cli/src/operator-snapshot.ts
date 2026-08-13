import { randomUUID } from "node:crypto";
import { stat, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  APPLICATION_CONTRACT_VERSION,
  createOperatorSnapshotReadUseCase,
  type OperatorSnapshotReadInputV1,
  type OperatorSnapshotV1,
  type OperatorSurfaceV1,
  type OperatorBrowserRecoverySourceV1,
  type OperatorJobSourceV1,
  type OperatorPendingRecoverySourceV1,
  type OperatorScheduleSourceV1,
  type OperatorSnapshotSourceQueryV1,
} from "@odinn/application";
import { readApprovalSummaries, SqliteOperatorReadStore } from "@odinn/kernel";

type RuntimeConfiguration = {
  readonly enableMcp?: boolean;
  readonly enableDurableWorkflows?: boolean;
  readonly enableEventIngress?: boolean;
  readonly enableProjectContext?: boolean;
};

export interface LocalOperatorSnapshotOptions {
  readonly stateDir: string;
  readonly workspaceRoot: string;
  readonly applicationVersion?: string;
  readonly applicationCommit?: string;
  readonly auditLog?: string;
  readonly runtime?: RuntimeConfiguration;
  readonly input: OperatorSnapshotReadInputV1 & { readonly surface: OperatorSurfaceV1 };
}

const MAX_OPERATOR_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LEGACY_JOBS_BYTES = 64 * 1024 * 1024;
const MAX_SCHEDULES = 500;
const OPERATOR_JOB_STATUSES = new Set<OperatorJobSourceV1["status"]>(["queued", "running", "awaiting-approval", "cancelling", "completed", "failed", "cancelled", "needs-review"]);
export const OPERATOR_SECTION_PAGE_OPTIONS = ["runtime", "work", "approvals", "automation", "context", "recovery", "audit", "surfaces"] as const;

function argument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function numericArgument(args: readonly string[], name: string): number | undefined {
  const value = argument(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function operatorSnapshotInputFromArgs(
  args: readonly string[],
  surface: OperatorSurfaceV1,
): OperatorSnapshotReadInputV1 & { readonly surface: OperatorSurfaceV1 } {
  const pages: Partial<Record<typeof OPERATOR_SECTION_PAGE_OPTIONS[number], number>> = {};
  for (const name of OPERATOR_SECTION_PAGE_OPTIONS) {
    const page = numericArgument(args, `--${name}-page`);
    if (page !== undefined) pages[name] = page;
  }
  const page = numericArgument(args, "--page");
  const pageSize = numericArgument(args, "--page-size");
  const query = argument(args, "--query") ?? argument(args, "--q");
  const status = argument(args, "--status");
  return {
    surface,
    ...(page === undefined ? {} : { page }),
    ...(pageSize === undefined ? {} : { pageSize }),
    ...(query === undefined ? {} : { query }),
    ...(status === undefined ? {} : { status }),
    ...(Object.keys(pages).length ? { pages } : {})
  };
}

export function operatorSnapshotRemoteQueryFromArgs(args: readonly string[], surface: OperatorSurfaceV1): URLSearchParams {
  const input = operatorSnapshotInputFromArgs(args, surface);
  const query = new URLSearchParams({ surface });
  if (input.page !== undefined) query.set("page", String(input.page));
  if (input.pageSize !== undefined) query.set("pageSize", String(input.pageSize));
  if (input.query !== undefined) query.set("q", input.query);
  if (input.status !== undefined) query.set("status", input.status);
  for (const name of OPERATOR_SECTION_PAGE_OPTIONS) {
    const page = input.pages?.[name];
    if (page !== undefined) query.set(`${name}Page`, String(page));
  }
  return query;
}

async function readBoundedJson(path: string, fallback: unknown, maxBytes = MAX_OPERATOR_FILE_BYTES): Promise<unknown> {
  try {
    if ((await stat(path)).size > maxBytes) throw new Error(`operator source exceeds ${maxBytes} bytes: ${path}`);
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readBrowserRecoverySource(path: string): Promise<OperatorBrowserRecoverySourceV1> {
  try {
    const value = await readBoundedJson(path, { status: "clear" });
    if (!value || typeof value !== "object" || Array.isArray(value)) return { invalid: true };
    const status = (value as Record<string, unknown>).status;
    return typeof status === "string" && status ? { invalid: false, status } : { invalid: true };
  } catch {
    return { invalid: true };
  }
}

async function readPendingRecoverySource(path: string): Promise<OperatorPendingRecoverySourceV1> {
  try {
    const value = await readBoundedJson(path, { pending: [] });
    if (!value || typeof value !== "object" || Array.isArray(value)) return { invalid: true };
    const pending = (value as Record<string, unknown>).pending;
    return Array.isArray(pending) ? { invalid: false, pendingCount: pending.length } : { invalid: true };
  } catch {
    return { invalid: true };
  }
}

function legacyJobProjection(id: string, input: unknown): OperatorJobSourceV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`legacy runtime job ${id} must be an object`);
  const value = input as Record<string, unknown>;
  const payload = value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)
    ? value.payload as Record<string, unknown>
    : {};
  const task = payload.task && typeof payload.task === "object" && !Array.isArray(payload.task)
    ? payload.task as Record<string, unknown>
    : {};
  const status = value.status;
  if (typeof status !== "string" || !OPERATOR_JOB_STATUSES.has(status as OperatorJobSourceV1["status"])) {
    throw new Error(`legacy runtime job ${id} has an invalid status`);
  }
  const attempts = Number(value.attempts ?? 0);
  if (!Number.isSafeInteger(attempts) || attempts < 0) throw new Error(`legacy runtime job ${id} has an invalid attempt count`);
  return {
    id,
    status: status as OperatorJobSourceV1["status"],
    tool: typeof value.tool === "string" ? value.tool : typeof task.tool === "string" ? task.tool : "job",
    attempts,
    retrySafe: value.retrySafe === true || Number(value.retry_safe) === 1,
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : typeof value.created_at === "string" ? { createdAt: value.created_at } : {}),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : typeof value.updated_at === "string" ? { updatedAt: value.updated_at } : {}),
    ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : typeof value.completed_at === "string" ? { completedAt: value.completed_at } : {}),
    ...(typeof value.executionRunId === "string" ? { executionRunId: value.executionRunId } : typeof value.execution_run_id === "string" ? { executionRunId: value.execution_run_id } : {}),
    ...(typeof value.envelopeDigest === "string" ? { envelopeDigest: value.envelopeDigest } : typeof value.envelope_digest === "string" ? { envelopeDigest: value.envelope_digest } : {}),
    ...(typeof value.auditCorrelationId === "string" ? { auditCorrelationId: value.auditCorrelationId } : typeof value.audit_correlation_id === "string" ? { auditCorrelationId: value.audit_correlation_id } : {})
  };
}

async function readLegacyJobs(stateDir: string): Promise<readonly ReturnType<typeof legacyJobProjection>[]> {
  const source = await readBoundedJson(join(stateDir, "jobs.json"), { jobs: {} }, MAX_LEGACY_JOBS_BYTES);
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("legacy runtime job state must contain a jobs object");
  }
  const jobs = (source as Record<string, unknown>).jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) throw new Error("legacy runtime job state must contain a jobs object");
  return Object.entries(jobs as Record<string, unknown>)
    .map(([id, value]) => legacyJobProjection(id, value))
    .sort((left, right) => String(right.updatedAt ?? right.createdAt ?? "").localeCompare(String(left.updatedAt ?? left.createdAt ?? "")) || left.id.localeCompare(right.id));
}

function queryLegacyJobs(items: readonly ReturnType<typeof legacyJobProjection>[], input: OperatorSnapshotSourceQueryV1) {
  const visible = items.filter((item) => {
    const status = !input.status || item.status === input.status;
    const query = !input.query || ["job", item.id, item.tool, item.status, item.attempts, item.retrySafe]
      .some((value) => String(value).toLowerCase().includes(input.query.toLowerCase()));
    return status && query;
  });
  return {
    items: visible.slice(input.offset, input.offset + input.limit),
    total: visible.length,
    attention: visible.filter((item) => item.status === "failed" || item.status === "needs-review").length
  };
}

async function readSchedules(stateDir: string): Promise<readonly OperatorScheduleSourceV1[]> {
  const source = await readBoundedJson(join(stateDir, "cron-jobs.json"), { jobs: [] });
  if (!source || typeof source !== "object" || Array.isArray(source) || !Array.isArray((source as Record<string, unknown>).jobs)) {
    throw new Error("operator schedule state must contain a jobs array");
  }
  const jobs = (source as Record<string, unknown>).jobs as unknown[];
  if (jobs.length > MAX_SCHEDULES) throw new Error(`operator schedule state exceeds ${MAX_SCHEDULES} records`);
  return jobs.map((input, index) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`operator schedule ${index} must be an object`);
    const value = input as Record<string, unknown>;
    if (typeof value.id !== "string" || !value.id || typeof value.enabled !== "boolean") throw new Error(`operator schedule ${index} is missing its public identity`);
    if (value.nextRunAt !== undefined && value.nextRunAt !== null && typeof value.nextRunAt !== "string") throw new Error(`operator schedule ${index} has an invalid next run time`);
    for (const key of ["name", "lastStatus", "updatedAt"] as const) {
      if (value[key] !== undefined && typeof value[key] !== "string") throw new Error(`operator schedule ${index}.${key} must be a string`);
    }
    return {
      id: value.id,
      enabled: value.enabled,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.lastStatus === "string" ? { lastStatus: value.lastStatus } : {}),
      ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
      ...(value.nextRunAt === null || typeof value.nextRunAt === "string" ? { nextRunAt: value.nextRunAt } : {}),
    } satisfies OperatorScheduleSourceV1;
  });
}

export function createCliOperatorSnapshotReadRequest({
  applicationRequestId,
  surface,
  input
}: {
  readonly applicationRequestId: string;
  readonly surface: OperatorSurfaceV1;
  readonly input: OperatorSnapshotReadInputV1;
}) {
  return {
    version: APPLICATION_CONTRACT_VERSION,
    kind: "operator-snapshot-read-request" as const,
    requestId: applicationRequestId,
    context: {
      principal: { principalId: "local-operator", actorId: surface === "tui" ? "tui" : "cli", kind: "operator" as const },
      scope: { tenantId: "local" },
      sourceReference: surface === "tui" ? "cli:tui" : "cli:operator:snapshot",
      correlationId: applicationRequestId,
      cancellationControlReference: `cli:operator:${applicationRequestId}`
    },
    operation: { kind: "query" as const, id: "operator.snapshot.read" as const },
    input: { ...input, surface }
  };
}

export async function readLocalOperatorSnapshot(options: LocalOperatorSnapshotOptions): Promise<OperatorSnapshotV1> {
  const legacyAuditPath = join(options.stateDir, options.auditLog ?? "audit.jsonl");
  const auditDatabasePath = join(dirname(legacyAuditPath), "db", `${basename(legacyAuditPath, ".jsonl")}.sqlite`);
  const store = new SqliteOperatorReadStore({
    runtimeDatabasePath: join(options.stateDir, "db", "odinn.sqlite"),
    auditDatabasePath
  });
  try {
    const legacyJobs = store.hasRuntimeJobs() ? undefined : await readLegacyJobs(options.stateDir);
    const useCase = createOperatorSnapshotReadUseCase({
      readEnvironment: async () => ({
        identity: {
          state: options.stateDir,
          workspaceRoot: options.workspaceRoot,
          ...(options.applicationVersion ? { version: options.applicationVersion } : {}),
          ...(options.applicationCommit ? { commit: options.applicationCommit } : {})
        },
        runtime: {
          gateway: "available",
          mcp: options.runtime?.enableMcp === true,
          workflows: options.runtime?.enableDurableWorkflows === true,
          eventIngress: options.runtime?.enableEventIngress === true,
          projectContext: options.runtime?.enableProjectContext === true
        }
      }),
      queryJobs: async (query) => legacyJobs ? queryLegacyJobs(legacyJobs, query) : store.queryJobs(query),
      queryRuns: async (query) => store.queryRuns(query),
      readLatestAttempts: async (runIds) => store.readLatestExecutionAttempts(runIds),
      readApprovals: async () => readApprovalSummaries(join(options.stateDir, "approvals.json")),
      queryWorkflows: async (query) => store.queryWorkflows(query),
      queryEventWatches: async (query) => store.queryEventWatches(query),
      readSchedules: async () => readSchedules(options.stateDir),
      readRecovery: async () => ({
        browser: await readBrowserRecoverySource(join(options.stateDir, "browser-recovery.json")),
        sandbox: await readPendingRecoverySource(join(options.stateDir, "sandbox-recovery.json")),
        process: await readPendingRecoverySource(join(options.stateDir, "process-recovery.json"))
      }),
      readAudit: async () => store.readAudit()
    });
    const result = await useCase.execute(createCliOperatorSnapshotReadRequest({
      applicationRequestId: randomUUID(),
      surface: options.input.surface,
      input: options.input
    }));
    return result.output;
  } finally {
    store.close();
  }
}
