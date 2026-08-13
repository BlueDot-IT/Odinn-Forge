import type { ApplicationInvocationOptions } from "./ports.ts";
import {
  APPLICATION_CONTRACT_VERSION,
  type ExecutionContextV1,
} from "./contracts.ts";
import {
  OPERATOR_SNAPSHOT_DEFAULT_PAGE_SIZE,
  OPERATOR_SNAPSHOT_MAX_PAGE_SIZE,
  OPERATOR_SNAPSHOT_SECTION_NAMES,
  defaultOperatorSnapshotActionsV1,
  validateOperatorSnapshotV1,
  type OperatorApprovalItemV1,
  type OperatorAuditItemV1,
  type OperatorAutomationCountsV1,
  type OperatorBrowserRecoveryItemV1,
  type OperatorContextItemV1,
  type OperatorEventWatchItemV1,
  type OperatorExecutionAttemptStateV1,
  type OperatorExecutionAttemptSummaryV1,
  type OperatorHealthV1,
  type OperatorItemV1,
  type OperatorJobItemV1,
  type OperatorPaginationV1,
  type OperatorProcessRecoveryItemV1,
  type OperatorRecoveryItemV1,
  type OperatorRunItemV1,
  type OperatorRuntimeItemV1,
  type OperatorSandboxRecoveryItemV1,
  type OperatorScheduleItemV1,
  type OperatorSectionV1,
  type OperatorSnapshotSectionNameV1,
  type OperatorSnapshotV1,
  type OperatorSurfaceItemV1,
  type OperatorSurfaceV1,
  type OperatorWorkflowItemV1,
  type OperatorWorkCountsV1,
  type OperatorBaseCountsV1,
  type OperatorApprovalCountsV1,
  type OperatorAuditCountsV1,
} from "./operator-snapshot-contracts.ts";
import {
  validatePendingApprovalSummariesV1,
  type ApprovalEffectSummaryV1,
  type PendingApprovalSummaryV1,
} from "./read-output-contracts.ts";
import { ApplicationContractValidationError, validateExecutionRequestV1 } from "./validation.ts";

export const OPERATOR_SNAPSHOT_READ_OPERATION_ID = "operator.snapshot.read" as const;

export interface OperatorSnapshotReadInputV1 {
  readonly surface?: OperatorSurfaceV1;
  readonly page?: number;
  readonly pageSize?: number;
  readonly query?: string;
  readonly status?: string;
  readonly pages?: Partial<Record<OperatorSnapshotSectionNameV1, number>>;
}

export interface NormalizedOperatorSnapshotReadInputV1 {
  readonly surface: OperatorSurfaceV1;
  readonly page: number;
  readonly pageSize: number;
  readonly query: string;
  readonly status: string;
  readonly pages: Readonly<Partial<Record<OperatorSnapshotSectionNameV1, number>>>;
}

export interface OperatorSnapshotReadRequestV1 {
  readonly version: typeof APPLICATION_CONTRACT_VERSION;
  readonly kind: "operator-snapshot-read-request";
  readonly requestId: string;
  readonly context: ExecutionContextV1;
  readonly operation: { readonly kind: "query"; readonly id: typeof OPERATOR_SNAPSHOT_READ_OPERATION_ID };
  readonly input: OperatorSnapshotReadInputV1;
}

export interface OperatorSnapshotReadResultV1 {
  readonly version: typeof APPLICATION_CONTRACT_VERSION;
  readonly kind: "operator-snapshot-read-result";
  readonly requestId: string;
  readonly correlationId: string;
  readonly output: OperatorSnapshotV1;
}

export interface OperatorSnapshotSourceQueryV1 {
  readonly offset: number;
  readonly limit: number;
  readonly query: string;
  readonly status: string;
}

export interface OperatorSnapshotSourcePageV1<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly attention: number;
}

export interface OperatorJobSourceV1 {
  readonly id: string;
  readonly status: OperatorJobItemV1["status"];
  readonly tool: string;
  readonly attempts: number;
  readonly retrySafe: boolean;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly completedAt?: string;
  readonly executionRunId?: string;
  readonly envelopeDigest?: string;
  readonly auditCorrelationId?: string;
}

export interface OperatorRunSourceV1 {
  readonly id: string;
  readonly status: OperatorRunItemV1["status"];
  readonly tool?: string;
  readonly message?: string;
  readonly eventCount: number;
  readonly actor: string;
  readonly lastEventAt?: string;
  readonly completedAt?: string;
  readonly startedAt?: string;
}

export interface OperatorExecutionAttemptSourceV1 {
  readonly id: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly state: OperatorExecutionAttemptStateV1;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly settledAt?: string;
  readonly outcomeDigest?: string;
  readonly errorCode?: string;
}

export interface OperatorApprovalSourceV1 {
  readonly id: string;
  readonly status: "pending" | "claimed";
  readonly createdAt: string;
  readonly expiresAt: number;
  readonly tool: string;
  readonly type?: string;
  readonly approvedAt?: string;
  readonly runId?: string;
  readonly accountId?: string;
  readonly summary?: string;
  readonly effect?: ApprovalEffectSummaryV1;
  readonly recovery?: string;
  readonly expectedUrl?: string;
  readonly snapshotId?: string;
}

export interface OperatorWorkflowSourceV1 {
  readonly runId: string;
  readonly definitionDigest: string;
  readonly status: OperatorWorkflowItemV1["status"];
  readonly updatedAt: string;
}

export interface OperatorEventWatchSourceV1 {
  readonly watchId: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

export interface OperatorScheduleSourceV1 {
  readonly id: string;
  readonly name?: string;
  readonly enabled: boolean;
  readonly lastStatus?: string;
  readonly updatedAt?: string;
  readonly nextRunAt?: string | null;
}

export interface OperatorEnvironmentSourceV1 {
  readonly identity: {
    readonly state: string;
    readonly workspaceRoot: string;
    readonly version?: string;
    readonly commit?: string;
  };
  readonly runtime: {
    readonly gateway: "running" | "available";
    readonly mcp: boolean;
    readonly workflows: boolean;
    readonly eventIngress: boolean;
    readonly projectContext: boolean;
  };
}

export interface OperatorAuditSourceV1 {
  readonly summary: {
    readonly events: number;
    readonly runs: number;
    readonly attentionRuns: number;
  };
  readonly integrity: {
    readonly valid: boolean;
    readonly checked: boolean;
    readonly unsigned: number;
    readonly failures: readonly OperatorAuditFailureSourceV1[];
  };
}

export interface OperatorAuditFailureSourceV1 {
  readonly code?: string;
  readonly message?: string;
}

export interface OperatorBrowserRecoverySourceV1 {
  readonly invalid: boolean;
  readonly status?: string;
}

export interface OperatorPendingRecoverySourceV1 {
  readonly invalid: boolean;
  readonly pendingCount?: number;
}

export interface OperatorRecoverySourceV1 {
  readonly browser: OperatorBrowserRecoverySourceV1;
  readonly sandbox: OperatorPendingRecoverySourceV1;
  readonly process: OperatorPendingRecoverySourceV1;
}

/**
 * Query-only boundary for the operator read plane. Implementations expose
 * authoritative projections but no reconcile, retry, approve, cancel, or
 * lifecycle-transition capability.
 */
export interface OperatorSnapshotReadPort {
  readEnvironment(context: ExecutionContextV1, options?: ApplicationInvocationOptions): Promise<OperatorEnvironmentSourceV1>;
  queryJobs(query: OperatorSnapshotSourceQueryV1, context: ExecutionContextV1, options?: ApplicationInvocationOptions): Promise<OperatorSnapshotSourcePageV1<OperatorJobSourceV1>>;
  queryRuns(query: OperatorSnapshotSourceQueryV1, context: ExecutionContextV1, options?: ApplicationInvocationOptions): Promise<OperatorSnapshotSourcePageV1<OperatorRunSourceV1>>;
  readLatestAttempts(runIds: readonly string[], context: ExecutionContextV1, options?: ApplicationInvocationOptions): Promise<readonly OperatorExecutionAttemptSourceV1[]>;
  readApprovals(context: ExecutionContextV1, options?: ApplicationInvocationOptions): Promise<readonly OperatorApprovalSourceV1[]>;
  queryWorkflows(query: OperatorSnapshotSourceQueryV1, context: ExecutionContextV1, options?: ApplicationInvocationOptions): Promise<OperatorSnapshotSourcePageV1<OperatorWorkflowSourceV1>>;
  queryEventWatches(query: OperatorSnapshotSourceQueryV1, context: ExecutionContextV1, options?: ApplicationInvocationOptions): Promise<OperatorSnapshotSourcePageV1<OperatorEventWatchSourceV1>>;
  readSchedules(context: ExecutionContextV1, options?: ApplicationInvocationOptions): Promise<readonly OperatorScheduleSourceV1[]>;
  readRecovery(context: ExecutionContextV1, options?: ApplicationInvocationOptions): Promise<OperatorRecoverySourceV1>;
  readAudit(context: ExecutionContextV1, options?: ApplicationInvocationOptions): Promise<OperatorAuditSourceV1>;
}

export interface OperatorSnapshotReadUseCase {
  execute(request: OperatorSnapshotReadRequestV1, options?: ApplicationInvocationOptions): Promise<OperatorSnapshotReadResultV1>;
}

type UseCaseOptions = { readonly now?: () => Date };
type WorkSourceItem = { readonly item: OperatorJobItemV1 | OperatorRunItemV1; readonly attemptRunId?: string };

const SOURCE_ITEM_LIMIT = 512;
const SOURCE_TEXT_BYTES = 2_048;
const SECRET_TEXT = [
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie|credentials?|password|passwd|secret|client[_-]?secret|private[_-]?key)\s*[:=]\s*[^\s,;]+/iu,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/iu,
  /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/iu,
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u,
];
const ATTEMPT_STATES = new Set<OperatorExecutionAttemptStateV1>([
  "proposed", "admitted", "queued", "running", "awaiting-approval", "cancelling", "completed", "failed", "cancelled", "needs-review",
]);

export function createOperatorSnapshotReadUseCase(port: OperatorSnapshotReadPort, options: UseCaseOptions = {}): OperatorSnapshotReadUseCase {
  assertPort(port);
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async execute(request: OperatorSnapshotReadRequestV1, invocation: ApplicationInvocationOptions = {}) {
      const validated = validateOperatorSnapshotReadRequestV1(request);
      const input = normalizeOperatorSnapshotReadInputV1(validated.input);
      throwIfCancelled(invocation.signal);

      const sourceQuery = { offset: 0, limit: 0, query: input.query, status: input.status } as const;
      const globalQuery = { offset: 0, limit: 0, query: "", status: "" } as const;
      const hasFilter = Boolean(input.query || input.status);
      const filteredJobsPromise = port.queryJobs(sourceQuery, validated.context, invocation);
      const filteredRunsPromise = port.queryRuns(sourceQuery, validated.context, invocation);
      const filteredWorkflowsPromise = port.queryWorkflows(sourceQuery, validated.context, invocation);
      const filteredWatchesPromise = port.queryEventWatches(sourceQuery, validated.context, invocation);
      const globalJobsPromise = hasFilter ? port.queryJobs(globalQuery, validated.context, invocation) : filteredJobsPromise;
      const globalRunsPromise = hasFilter ? port.queryRuns(globalQuery, validated.context, invocation) : filteredRunsPromise;
      const globalWorkflowsPromise = hasFilter ? port.queryWorkflows(globalQuery, validated.context, invocation) : filteredWorkflowsPromise;
      const globalWatchesPromise = hasFilter ? port.queryEventWatches(globalQuery, validated.context, invocation) : filteredWatchesPromise;

      const [
        environmentSource,
        filteredJobsSource,
        filteredRunsSource,
        globalJobsSource,
        globalRunsSource,
        approvalsSource,
        filteredWorkflowsSource,
        filteredWatchesSource,
        globalWorkflowsSource,
        globalWatchesSource,
        schedulesSource,
        recoverySource,
        auditSource,
      ] = await Promise.all([
        port.readEnvironment(validated.context, invocation),
        filteredJobsPromise,
        filteredRunsPromise,
        globalJobsPromise,
        globalRunsPromise,
        port.readApprovals(validated.context, invocation),
        filteredWorkflowsPromise,
        filteredWatchesPromise,
        globalWorkflowsPromise,
        globalWatchesPromise,
        port.readSchedules(validated.context, invocation),
        port.readRecovery(validated.context, invocation),
        port.readAudit(validated.context, invocation),
      ]);
      throwIfCancelled(invocation.signal);

      const environment = projectEnvironment(environmentSource);
      const filteredJobs = sourcePage(filteredJobsSource, "operator jobs");
      const filteredRuns = sourcePage(filteredRunsSource, "operator runs");
      const globalJobs = sourcePage(globalJobsSource, "operator global jobs");
      const globalRuns = sourcePage(globalRunsSource, "operator global runs");
      const filteredWorkflows = sourcePage(filteredWorkflowsSource, "operator workflows");
      const filteredWatches = sourcePage(filteredWatchesSource, "operator event watches");
      const globalWorkflows = sourcePage(globalWorkflowsSource, "operator global workflows");
      const globalWatches = sourcePage(globalWatchesSource, "operator global event watches");
      const allApprovals = projectApprovals(approvalsSource);
      const approvals = allApprovals.filter((item) => matches(item, input));
      const allSchedules = sourceArray<OperatorScheduleSourceV1>(schedulesSource, "operator schedules")
        .map((item, index) => projectSchedule(item, `operator schedules[${index}]`));
      const schedules = allSchedules.filter((item) => matches(item, input));
      const recoveryItems = projectRecovery(recoverySource);
      const audit = projectAudit(auditSource);

      const workPagination = pagination(filteredJobs.total + filteredRuns.total, pageFor(input, "work"), input.pageSize);
      const projectedWork = await selectCombinedPage<WorkSourceItem>(workPagination, [
        {
          total: filteredJobs.total,
          fetch: async (offset, limit) => sourcePage(await port.queryJobs({ ...sourceQuery, offset, limit }, validated.context, invocation), "operator jobs page").items
            .map((item, index) => projectJob(item, `operator jobs page[${offset + index}]`)),
        },
        {
          total: filteredRuns.total,
          fetch: async (offset, limit) => sourcePage(await port.queryRuns({ ...sourceQuery, offset, limit }, validated.context, invocation), "operator runs page").items
            .map((item, index) => projectRun(item, `operator runs page[${offset + index}]`)),
        },
      ], invocation.signal);
      throwIfCancelled(invocation.signal);

      const attemptRunIds = [...new Set(projectedWork.map((entry) => entry.attemptRunId).filter((entry): entry is string => Boolean(entry)))];
      const latestAttempts = attemptRunIds.length
        ? projectLatestAttempts(await port.readLatestAttempts(Object.freeze(attemptRunIds), validated.context, invocation), attemptRunIds)
        : new Map<string, OperatorExecutionAttemptSummaryV1>();
      throwIfCancelled(invocation.signal);
      const workItems = projectedWork.map(({ item, attemptRunId }) => {
        const latestAttempt = attemptRunId ? latestAttempts.get(attemptRunId) : undefined;
        if (!latestAttempt) return item;
        if (item.kind === "job") {
          return Object.freeze({ ...item, details: Object.freeze({ ...item.details, latestAttempt }) } satisfies OperatorJobItemV1);
        }
        return Object.freeze({ ...item, details: Object.freeze({ ...item.details, latestAttempt }) } satisfies OperatorRunItemV1);
      });

      const automationPagination = pagination(filteredWorkflows.total + filteredWatches.total + schedules.length, pageFor(input, "automation"), input.pageSize);
      const automationItems = await selectCombinedPage<OperatorWorkflowItemV1 | OperatorEventWatchItemV1 | OperatorScheduleItemV1>(automationPagination, [
        {
          total: filteredWorkflows.total,
          fetch: async (offset, limit) => sourcePage(await port.queryWorkflows({ ...sourceQuery, offset, limit }, validated.context, invocation), "operator workflows page").items
            .map((item, index) => projectWorkflow(item, `operator workflows page[${offset + index}]`)),
        },
        {
          total: filteredWatches.total,
          fetch: async (offset, limit) => sourcePage(await port.queryEventWatches({ ...sourceQuery, offset, limit }, validated.context, invocation), "operator event watches page").items
            .map((item, index) => projectWatch(item, `operator event watches page[${offset + index}]`)),
        },
        { total: schedules.length, fetch: async (offset, limit) => schedules.slice(offset, offset + limit) },
      ], invocation.signal);
      throwIfCancelled(invocation.signal);

      const runtimeItems = runtimeSourceItems(environment).filter((item) => matches(item, input));
      const allContextItems: OperatorContextItemV1[] = [{
        id: "project-context",
        kind: "context",
        label: "Project context",
        status: environment.runtime.projectContext ? "enabled" : "disabled",
        summary: environment.runtime.projectContext ? "Context retrieval is available through the governed context surface." : "Project context is disabled by default.",
      }];
      const contextItems = allContextItems.filter((item) => matches(item, input));
      const surfaceItems = operatorSurfaceItems().filter((item) => matches(item, input));
      const visibleRecovery = recoveryItems.filter((item) => matches(item, input));
      const visibleAudit = [audit.item].filter((item) => matches(item, input));

      const sections = {
        runtime: staticSection(runtimeItems, pageFor(input, "runtime"), input.pageSize),
        work: queriedSection(workItems, workPagination, {
          total: workPagination.total,
          jobs: filteredJobs.total,
          runs: filteredRuns.total,
          attention: filteredJobs.attention + filteredRuns.attention,
        } satisfies OperatorWorkCountsV1),
        approvals: staticCountedSection(
          approvals,
          pageFor(input, "approvals"),
          input.pageSize,
          (total, attention) => ({ total, pending: total, attention } satisfies OperatorApprovalCountsV1),
        ),
        automation: queriedSection(automationItems, automationPagination, {
          total: automationPagination.total,
          workflows: filteredWorkflows.total,
          watches: filteredWatches.total,
          schedules: schedules.length,
          attention: filteredWorkflows.attention + filteredWatches.attention + schedules.filter(isAttention).length,
        } satisfies OperatorAutomationCountsV1),
        context: staticSection(contextItems, pageFor(input, "context"), input.pageSize),
        recovery: staticSection(visibleRecovery, pageFor(input, "recovery"), input.pageSize),
        audit: staticCountedSection(
          visibleAudit,
          pageFor(input, "audit"),
          input.pageSize,
          (total, attention) => ({ total, events: audit.events, runs: audit.runs, attention } satisfies OperatorAuditCountsV1),
        ),
        surfaces: staticSection(surfaceItems, pageFor(input, "surfaces"), input.pageSize),
      } satisfies OperatorSnapshotV1["sections"];

      const globalAttention = globalJobs.attention
        + globalRuns.attention
        + allApprovals.length
        + globalWorkflows.attention
        + globalWatches.attention
        + allSchedules.filter(isAttention).length
        + recoveryItems.filter(isAttention).length
        + (audit.item.attention ? 1 : 0);
      const healthStatus: OperatorHealthV1 = globalAttention ? "attention" : "healthy";
      const generatedAt = canonicalDate(now(), "operator snapshot generatedAt");
      const output = validateOperatorSnapshotV1({
        schemaVersion: 1,
        generatedAt,
        surface: input.surface,
        identity: environment.identity,
        health: {
          status: healthStatus,
          ok: healthStatus === "healthy",
          attention: globalAttention,
          summary: globalAttention ? `${globalAttention} item(s) need operator attention.` : "All governed surfaces are operating normally.",
        },
        sections,
        actions: defaultOperatorSnapshotActionsV1(),
      });
      throwIfCancelled(invocation.signal);
      return Object.freeze({
        version: APPLICATION_CONTRACT_VERSION,
        kind: "operator-snapshot-read-result" as const,
        requestId: validated.requestId,
        correlationId: validated.context.correlationId,
        output,
      });
    },
  });
}

export function validateOperatorSnapshotReadRequestV1(request: unknown): OperatorSnapshotReadRequestV1 {
  const value = exactSourceRecord(request, "operator snapshot read request");
  const allowed = new Set(["version", "kind", "requestId", "context", "operation", "input"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) sourceFail(`operator snapshot read request contains unknown field: ${unknown}`, `operator snapshot read request.${unknown}`, "UNKNOWN_APPLICATION_FIELD");
  const missing = [...allowed].find((key) => !Object.hasOwn(value, key));
  if (missing) sourceFail(`operator snapshot read request is missing required field: ${missing}`, `operator snapshot read request.${missing}`);
  if (dataField(value, "kind", "operator snapshot read request") !== "operator-snapshot-read-request") {
    sourceFail("operator snapshot read request kind must be operator-snapshot-read-request", "operator snapshot read request.kind");
  }
  const operation = exactSourceRecord(dataField(value, "operation", "operator snapshot read request"), "operator snapshot read request.operation");
  if (dataField(operation, "kind", "operator snapshot read request.operation") !== "query"
    || dataField(operation, "id", "operator snapshot read request.operation") !== OPERATOR_SNAPSHOT_READ_OPERATION_ID) {
    sourceFail(
      `operator snapshot read operation must be query:${OPERATOR_SNAPSHOT_READ_OPERATION_ID}`,
      "operator snapshot read request.operation",
    );
  }
  const validated = validateExecutionRequestV1({
    version: dataField(value, "version", "operator snapshot read request"),
    kind: "execution-request",
    requestId: dataField(value, "requestId", "operator snapshot read request"),
    context: dataField(value, "context", "operator snapshot read request"),
    operation,
    input: dataField(value, "input", "operator snapshot read request"),
    responseMode: "sync",
  });
  return Object.freeze({
    version: APPLICATION_CONTRACT_VERSION,
    kind: "operator-snapshot-read-request" as const,
    requestId: validated.requestId,
    context: validated.context,
    operation: Object.freeze({ kind: "query" as const, id: OPERATOR_SNAPSHOT_READ_OPERATION_ID }),
    input: normalizeOperatorSnapshotReadInputV1(validated.input),
  });
}

export function normalizeOperatorSnapshotReadInputV1(input: unknown): NormalizedOperatorSnapshotReadInputV1 {
  const value = exactSourceRecord(input, "operator snapshot input");
  const allowed = new Set(["surface", "page", "pageSize", "query", "status", "pages"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) sourceFail(`operator snapshot input contains unknown field: ${unknown}`, `operator snapshot input.${unknown}`, "UNKNOWN_APPLICATION_FIELD");
  const surface = value.surface === undefined ? "http" : sourceEnum(value.surface, "operator snapshot input.surface", ["cli", "tui", "http", "console"] as const);
  const page = normalizePageNumber(value.page, 1);
  const pageSize = Math.min(OPERATOR_SNAPSHOT_MAX_PAGE_SIZE, normalizePageNumber(value.pageSize, OPERATOR_SNAPSHOT_DEFAULT_PAGE_SIZE));
  const query = inputText(value.query, "operator snapshot input.query").toLowerCase();
  const requestedStatus = inputText(value.status, "operator snapshot input.status");
  const status = requestedStatus === "all" ? "" : requestedStatus;
  const pages: Partial<Record<OperatorSnapshotSectionNameV1, number>> = {};
  if (value.pages !== undefined) {
    const pageValues = exactSourceRecord(value.pages, "operator snapshot input.pages");
    const unknownPage = Object.keys(pageValues).find((key) => !(OPERATOR_SNAPSHOT_SECTION_NAMES as readonly string[]).includes(key));
    if (unknownPage) sourceFail(`operator snapshot input.pages contains unknown field: ${unknownPage}`, `operator snapshot input.pages.${unknownPage}`, "UNKNOWN_APPLICATION_FIELD");
    for (const name of OPERATOR_SNAPSHOT_SECTION_NAMES) {
      if (pageValues[name] !== undefined) pages[name] = normalizePageNumber(pageValues[name], page);
    }
  }
  return Object.freeze({ surface, page, pageSize, query, status, pages: Object.freeze(pages) });
}

function assertPort(port: OperatorSnapshotReadPort): void {
  const methods: readonly (keyof OperatorSnapshotReadPort)[] = [
    "readEnvironment", "queryJobs", "queryRuns", "readLatestAttempts", "readApprovals", "queryWorkflows", "queryEventWatches", "readSchedules", "readRecovery", "readAudit",
  ];
  if (!port || methods.some((method) => typeof port[method] !== "function")) throw new Error("operator snapshot read port is incomplete");
}

function sourcePage<T>(input: OperatorSnapshotSourcePageV1<T>, path: string): OperatorSnapshotSourcePageV1<T> {
  const value = exactSourceRecord(input, path);
  const items = sourceArray<T>(dataField(value, "items", path), `${path}.items`);
  const total = sourceCount(dataField(value, "total", path), `${path}.total`);
  const attention = sourceCount(dataField(value, "attention", path), `${path}.attention`);
  if (attention > total) sourceFail(`${path}.attention cannot exceed total`, `${path}.attention`);
  if (items.length > total) sourceFail(`${path}.items cannot exceed total`, `${path}.items`);
  return Object.freeze({ items, total, attention });
}

function projectEnvironment(input: OperatorEnvironmentSourceV1): OperatorEnvironmentSourceV1 {
  const value = exactSourceRecord(input, "operator environment");
  const identity = exactSourceRecord(dataField(value, "identity", "operator environment"), "operator environment.identity");
  const runtime = exactSourceRecord(dataField(value, "runtime", "operator environment"), "operator environment.runtime");
  return Object.freeze({
    identity: Object.freeze({
      state: requiredSourceText(dataField(identity, "state", "operator environment.identity"), "operator environment.identity.state"),
      workspaceRoot: requiredSourceText(dataField(identity, "workspaceRoot", "operator environment.identity"), "operator environment.identity.workspaceRoot"),
      ...optionalProjectedText(identity, "version", "operator environment.identity"),
      ...optionalProjectedText(identity, "commit", "operator environment.identity"),
    }),
    runtime: Object.freeze({
      gateway: sourceEnum(dataField(runtime, "gateway", "operator environment.runtime"), "operator environment.runtime.gateway", ["running", "available"] as const),
      mcp: sourceBoolean(dataField(runtime, "mcp", "operator environment.runtime"), "operator environment.runtime.mcp"),
      workflows: sourceBoolean(dataField(runtime, "workflows", "operator environment.runtime"), "operator environment.runtime.workflows"),
      eventIngress: sourceBoolean(dataField(runtime, "eventIngress", "operator environment.runtime"), "operator environment.runtime.eventIngress"),
      projectContext: sourceBoolean(dataField(runtime, "projectContext", "operator environment.runtime"), "operator environment.runtime.projectContext"),
    }),
  });
}

function runtimeSourceItems(environment: OperatorEnvironmentSourceV1): OperatorRuntimeItemV1[] {
  const runtime = environment.runtime;
  return [
    { id: "gateway", kind: "runtime", label: "Gateway", status: runtime.gateway, summary: "Authenticated local control plane" },
    { id: "mcp", kind: "runtime", label: "MCP", status: runtime.mcp ? "enabled" : "disabled", summary: runtime.mcp ? "Governed MCP activation" : "Disabled by default" },
    { id: "workflows", kind: "runtime", label: "Durable workflows", status: runtime.workflows ? "enabled" : "disabled", summary: runtime.workflows ? "Durable workflow runtime" : "Disabled by default" },
    { id: "event-ingress", kind: "runtime", label: "Event ingress", status: runtime.eventIngress ? "enabled" : "disabled", summary: runtime.eventIngress ? "Authenticated event and heartbeat ingress" : "Disabled by default" },
    { id: "project-context", kind: "runtime", label: "Project context", status: runtime.projectContext ? "enabled" : "disabled", summary: runtime.projectContext ? "Bounded context retrieval" : "Disabled by default" },
  ];
}

function projectJob(input: OperatorJobSourceV1, path: string): WorkSourceItem {
  const value = exactSourceRecord(input, path);
  const status = sourceEnum(dataField(value, "status", path), `${path}.status`, ["queued", "running", "awaiting-approval", "cancelling", "completed", "failed", "cancelled", "needs-review"] as const);
  const executionRunId = optionalSourceText(value, "executionRunId", path);
  const envelopeDigest = optionalSourceDigest(value, "envelopeDigest", path);
  const auditCorrelationId = optionalSourceText(value, "auditCorrelationId", path);
  const attempts = sourceCount(dataField(value, "attempts", path), `${path}.attempts`);
  const retrySafe = sourceBoolean(dataField(value, "retrySafe", path), `${path}.retrySafe`);
  const attention = status === "failed" || status === "needs-review";
  const item: OperatorJobItemV1 = {
    id: requiredSourceText(dataField(value, "id", path), `${path}.id`),
    kind: "job",
    label: requiredSourceText(dataField(value, "tool", path), `${path}.tool`),
    status,
    summary: attention ? "Execution needs operator attention." : `${attempts} attempt(s) · ${retrySafe ? "retry-safe" : "effectful"}`,
    ...optionalTimestampProjection(value, ["updatedAt", "completedAt", "createdAt"], path),
    ...(attention ? { attention: true as const } : {}),
    ...(["queued", "running", "cancelling", "awaiting-approval"].includes(status) ? { controls: ["cancel-job"] as const } : {}),
    details: {
      attempts,
      retrySafe,
      ...(executionRunId ? { executionRunId } : {}),
      ...(envelopeDigest ? { envelopeDigest } : {}),
      ...(auditCorrelationId ? { auditCorrelationId } : {}),
    },
  };
  return Object.freeze({ item: Object.freeze(item), ...(executionRunId ? { attemptRunId: executionRunId } : {}) });
}

function projectRun(input: OperatorRunSourceV1, path: string): WorkSourceItem {
  const value = exactSourceRecord(input, path);
  const status = sourceEnum(dataField(value, "status", path, "unknown"), `${path}.status`, ["unknown", "running", "awaiting_approval", "completed", "failed", "blocked", "cancelled", "denied", "needs-review"] as const);
  const id = requiredSourceText(dataField(value, "id", path), `${path}.id`);
  const attention = ["failed", "blocked", "needs-review"].includes(status);
  const item: OperatorRunItemV1 = {
    id,
    kind: "run",
    label: sourceText(dataField(value, "tool", path, "run"), "run", `${path}.tool`),
    status,
    summary: sourceText(dataField(value, "message", path, "Audited run"), "Audited run", `${path}.message`),
    ...optionalTimestampProjection(value, ["lastEventAt", "completedAt", "startedAt"], path),
    ...(attention ? { attention: true as const } : {}),
    details: {
      eventCount: sourceCount(dataField(value, "eventCount", path), `${path}.eventCount`),
      actor: requiredSourceText(dataField(value, "actor", path), `${path}.actor`),
    },
  };
  return Object.freeze({ item: Object.freeze(item), attemptRunId: id });
}

function projectApprovals(input: readonly OperatorApprovalSourceV1[]): OperatorApprovalItemV1[] {
  const approvals = validatePendingApprovalSummariesV1(input);
  return approvals.map((approval, index) => projectApproval(approval, `operator approvals[${index}]`));
}

function projectApproval(approval: PendingApprovalSummaryV1, path: string): OperatorApprovalItemV1 {
  const status = sourceEnum(approval.status, `${path}.status`, ["pending", "claimed"] as const);
  return Object.freeze({
    id: requiredSourceText(approval.id, `${path}.id`),
    kind: "approval" as const,
    label: requiredSourceText(approval.tool, `${path}.tool`),
    status,
    summary: sourceText(approval.effect?.summary || approval.summary, "Review the bounded effect details before deciding.", `${path}.summary`),
    updatedAt: canonicalTimestamp(approval.createdAt, `${path}.createdAt`),
    attention: true as const,
    controls: ["approve", "deny-approval"] as const,
    details: Object.freeze({
      ...(approval.runId ? { runId: sourceText(approval.runId, "", `${path}.runId`) } : {}),
      expiresAt: sourceCount(approval.expiresAt, `${path}.expiresAt`),
      ...(approval.effect ? { effect: approval.effect } : {}),
    }),
  });
}

function projectWorkflow(input: OperatorWorkflowSourceV1, path: string): OperatorWorkflowItemV1 {
  const value = exactSourceRecord(input, path);
  const status = sourceEnum(dataField(value, "status", path), `${path}.status`, ["queued", "running", "awaiting-approval", "stopping", "cancelling", "completed", "failed", "cancelled", "needs-review"] as const);
  const attention = ["failed", "needs-review", "awaiting-approval"].includes(status);
  const controls = ["queued", "running", "awaiting-approval", "stopping", "cancelling"].includes(status)
    ? ["cancel-workflow"] as const
    : status === "needs-review" ? ["resume-workflow"] as const : undefined;
  return Object.freeze({
    id: requiredSourceText(dataField(value, "runId", path), `${path}.runId`),
    kind: "workflow" as const,
    label: requiredSourceText(dataField(value, "definitionDigest", path), `${path}.definitionDigest`),
    status,
    summary: "Durable workflow run",
    updatedAt: canonicalTimestamp(dataField(value, "updatedAt", path), `${path}.updatedAt`),
    ...(attention ? { attention: true as const } : {}),
    ...(controls ? { controls } : {}),
  });
}

function projectWatch(input: OperatorEventWatchSourceV1, path: string): OperatorEventWatchItemV1 {
  const value = exactSourceRecord(input, path);
  const enabled = sourceBoolean(dataField(value, "enabled", path), `${path}.enabled`);
  return Object.freeze({
    id: requiredSourceText(dataField(value, "watchId", path), `${path}.watchId`),
    kind: "event-watch" as const,
    label: "Event watch",
    status: enabled ? "enabled" as const : "disabled" as const,
    summary: "Durable event ingress declaration",
    updatedAt: canonicalTimestamp(dataField(value, "updatedAt", path), `${path}.updatedAt`),
    details: Object.freeze({ enabled }),
  });
}

function projectSchedule(input: OperatorScheduleSourceV1, path: string): OperatorScheduleItemV1 {
  const value = exactSourceRecord(input, path);
  const lastStatus = optionalSourceText(value, "lastStatus", path);
  const enabled = dataField(value, "enabled", path);
  const isEnabled = sourceBoolean(enabled, `${path}.enabled`);
  const status = lastStatus === "error" ? "needs-review" as const : isEnabled ? "enabled" as const : "disabled" as const;
  const nextRunAtValue = dataField(value, "nextRunAt", path, null);
  const nextRunAt = nextRunAtValue === null || nextRunAtValue === undefined ? null : canonicalTimestamp(nextRunAtValue, `${path}.nextRunAt`);
  return Object.freeze({
    id: requiredSourceText(dataField(value, "id", path), `${path}.id`),
    kind: "schedule" as const,
    label: sourceText(dataField(value, "name", path, dataField(value, "id", path, "schedule")), "schedule", `${path}.name`),
    status,
    summary: lastStatus ? `Last run: ${sourceText(lastStatus, "unknown", `${path}.lastStatus`)}` : "Scheduled automation",
    ...optionalTimestampProjection(value, ["updatedAt"], path),
    ...(status === "needs-review" ? { attention: true as const } : {}),
    details: Object.freeze({ nextRunAt }),
  });
}

function projectLatestAttempts(input: readonly OperatorExecutionAttemptSourceV1[], requestedRunIds: readonly string[]): Map<string, OperatorExecutionAttemptSummaryV1> {
  const values = sourceArray<OperatorExecutionAttemptSourceV1>(input, "operator latest attempts");
  if (values.length > requestedRunIds.length) sourceFail("operator latest attempts exceeds the requested run count", "operator latest attempts");
  const requested = new Set(requestedRunIds);
  const attempts = new Map<string, OperatorExecutionAttemptSummaryV1>();
  values.forEach((entry, index) => {
    const path = `operator latest attempts[${index}]`;
    const value = exactSourceRecord(entry, path);
    const runId = sourceText(dataField(value, "runId", path), "", `${path}.runId`);
    if (!requested.has(runId)) sourceFail(`${path}.runId was not requested`, `${path}.runId`);
    if (attempts.has(runId)) sourceFail(`operator latest attempts contains duplicate runId: ${runId}`, `${path}.runId`);
    const state = sourceEnum(dataField(value, "state", path), `${path}.state`, [...ATTEMPT_STATES] as OperatorExecutionAttemptStateV1[]);
    const attempt = Object.freeze({
      id: sourceText(dataField(value, "id", path), "", `${path}.id`),
      runId,
      attemptNumber: positiveSourceCount(dataField(value, "attemptNumber", path), `${path}.attemptNumber`),
      state,
      createdAt: canonicalTimestamp(dataField(value, "createdAt", path), `${path}.createdAt`),
      ...optionalCanonicalTimestamp(value, "startedAt", path),
      ...optionalCanonicalTimestamp(value, "settledAt", path),
      ...optionalDigestProjection(value, "outcomeDigest", path),
      ...optionalCodeProjection(value, "errorCode", path),
    }) satisfies OperatorExecutionAttemptSummaryV1;
    attempts.set(runId, attempt);
  });
  return attempts;
}

function projectRecovery(input: OperatorRecoverySourceV1): OperatorRecoveryItemV1[] {
  const value = exactSourceRecord(input, "operator recovery");
  const browser = browserRecoveryRecord(dataField(value, "browser", "operator recovery"), "operator recovery.browser");
  const sandbox = pendingRecoveryRecord(dataField(value, "sandbox", "operator recovery"), "operator recovery.sandbox");
  const process = pendingRecoveryRecord(dataField(value, "process", "operator recovery"), "operator recovery.process");

  const browserInvalid = browser.invalid || typeof browser.status !== "string";
  const rawBrowserStatus = browserInvalid ? "needs-review" : browser.status;
  const browserStatus: OperatorBrowserRecoveryItemV1["status"] = rawBrowserStatus && isBrowserRecoveryStatus(rawBrowserStatus)
    ? rawBrowserStatus
    : "needs-review";
  const browserPending = !["clear", "resolved", "completed"].includes(browserStatus);
  const browserItem: OperatorBrowserRecoveryItemV1 = {
    id: "browser-recovery",
    kind: "recovery",
    label: "Browser recovery",
    status: browserStatus,
    summary: browserPending ? "Browser action recovery is required." : "No browser action is awaiting resolution.",
    ...(browserPending ? { attention: true as const } : {}),
    details: { pending: browserPending },
  };

  const sandboxPending = sandbox.invalid ? null : sandbox.pendingCount ?? null;
  const sandboxAttention = sandbox.invalid || sandboxPending === null || sandboxPending > 0;
  const sandboxItem: OperatorSandboxRecoveryItemV1 = {
    id: "sandbox-recovery",
    kind: "recovery",
    label: "Sandbox recovery",
    status: sandboxAttention ? "needs-review" : "clear",
    summary: "Sandbox process recovery state",
    ...(sandboxAttention ? { attention: true as const } : {}),
    details: { pending: sandboxPending },
  };

  const processPending = process.invalid ? null : process.pendingCount ?? null;
  const processAttention = process.invalid || processPending === null || processPending > 0;
  const processItem: OperatorProcessRecoveryItemV1 = {
    id: "process-recovery",
    kind: "recovery",
    label: "Process recovery",
    status: processAttention ? "needs-review" : "clear",
    summary: "Durable process recovery state",
    ...(processAttention ? { attention: true as const } : {}),
    details: { pending: processPending },
  };
  return [Object.freeze(browserItem), Object.freeze(sandboxItem), Object.freeze(processItem)];
}

function browserRecoveryRecord(input: unknown, path: string): OperatorBrowserRecoverySourceV1 {
  try {
    const value = exactSourceRecord(input, path);
    const invalid = sourceBoolean(dataField(value, "invalid", path), `${path}.invalid`);
    if (invalid) return Object.freeze({ invalid: true });
    return Object.freeze({
      invalid: false,
      status: sourceText(dataField(value, "status", path), "", `${path}.status`),
    });
  } catch {
    return Object.freeze({ invalid: true });
  }
}

function pendingRecoveryRecord(input: unknown, path: string): OperatorPendingRecoverySourceV1 {
  try {
    const value = exactSourceRecord(input, path);
    const invalid = sourceBoolean(dataField(value, "invalid", path), `${path}.invalid`);
    if (invalid) return Object.freeze({ invalid: true });
    return Object.freeze({
      invalid: false,
      pendingCount: sourceCount(dataField(value, "pendingCount", path), `${path}.pendingCount`),
    });
  } catch {
    return Object.freeze({ invalid: true });
  }
}

function isBrowserRecoveryStatus(value: string): value is Exclude<OperatorBrowserRecoveryItemV1["status"], "needs-review"> {
  return new Set<string>(["clear", "executing", "unknown", "resolved", "completed"]).has(value);
}

function projectAudit(input: OperatorAuditSourceV1): { readonly item: OperatorAuditItemV1; readonly events: number; readonly runs: number } {
  const value = exactSourceRecord(input, "operator audit");
  const summary = exactSourceRecord(dataField(value, "summary", "operator audit"), "operator audit.summary");
  const integrity = exactSourceRecord(dataField(value, "integrity", "operator audit"), "operator audit.integrity");
  const events = sourceCount(dataField(summary, "events", "operator audit.summary"), "operator audit.summary.events");
  const runs = sourceCount(dataField(summary, "runs", "operator audit.summary"), "operator audit.summary.runs");
  const attentionRuns = sourceCount(dataField(summary, "attentionRuns", "operator audit.summary"), "operator audit.summary.attentionRuns");
  if (attentionRuns > runs) sourceFail("operator audit.summary.attentionRuns cannot exceed runs", "operator audit.summary.attentionRuns");
  const valid = sourceBoolean(dataField(integrity, "valid", "operator audit.integrity"), "operator audit.integrity.valid");
  const checked = sourceBoolean(dataField(integrity, "checked", "operator audit.integrity"), "operator audit.integrity.checked");
  const failures = sourceArray<OperatorAuditFailureSourceV1>(
    dataField(integrity, "failures", "operator audit.integrity"),
    "operator audit.integrity.failures",
  ).length;
  const unsigned = sourceCount(dataField(integrity, "unsigned", "operator audit.integrity"), "operator audit.integrity.unsigned");
  const attention = !valid || !checked;
  const item: OperatorAuditItemV1 = {
    id: "audit-journal",
    kind: "audit",
    label: "Audit journal",
    status: !valid ? "needs-review" : !checked ? "unknown" : "verified",
    summary: !valid ? "Audit integrity needs attention." : !checked ? "Audit integrity has not been explicitly verified in this process." : "Hash-chain verification passed.",
    ...(attention ? { attention: true as const } : {}),
    details: { events, runs, unsigned, failures, checked },
  };
  return Object.freeze({ item: Object.freeze(item), events, runs });
}

function operatorSurfaceItems(): OperatorSurfaceItemV1[] {
  return ["CLI", "TUI", "HTTP JSON", "Web console"].map((label) => Object.freeze({
    id: label.toLowerCase().replace(/\s+/gu, "-"),
    kind: "surface" as const,
    label,
    status: "available" as const,
    summary: "Uses the shared operator contract",
  }));
}

function staticSection<TItem extends OperatorItemV1>(items: readonly TItem[], requestedPage: number, pageSize: number): OperatorSectionV1<TItem> {
  const page = pagination(items.length, requestedPage, pageSize);
  const selected = items.slice(page.from ? page.from - 1 : 0, page.to);
  return queriedSection(selected, page, { total: items.length, attention: items.filter(isAttention).length });
}

function staticCountedSection<TItem extends OperatorItemV1, TCounts extends OperatorBaseCountsV1>(
  items: readonly TItem[],
  requestedPage: number,
  pageSize: number,
  counts: (total: number, attention: number) => TCounts,
): OperatorSectionV1<TItem, TCounts> {
  const page = pagination(items.length, requestedPage, pageSize);
  const selected = items.slice(page.from ? page.from - 1 : 0, page.to);
  return queriedSection(selected, page, counts(items.length, items.filter(isAttention).length));
}

function queriedSection<TItem extends OperatorItemV1, TCounts extends OperatorBaseCountsV1>(items: readonly TItem[], page: OperatorPaginationV1, counts: TCounts): OperatorSectionV1<TItem, TCounts> {
  const status: OperatorHealthV1 = Number(counts.attention) > 0 ? "attention" : "healthy";
  return Object.freeze({ status, counts: Object.freeze({ ...counts }), items: Object.freeze([...items]), pagination: Object.freeze({ ...page }) });
}

function pagination(total: number, requestedPage: number, pageSize: number): OperatorPaginationV1 {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, requestedPage), pages);
  const offset = (page - 1) * pageSize;
  return Object.freeze({ page, pageSize, pages, total, from: total ? offset + 1 : 0, to: total ? Math.min(offset + pageSize, total) : 0 });
}

async function selectCombinedPage<T>(page: OperatorPaginationV1, categories: readonly { readonly total: number; readonly fetch: (offset: number, limit: number) => Promise<readonly T[]> }[], signal?: AbortSignal): Promise<T[]> {
  let skip = (page.page - 1) * page.pageSize;
  let remaining = page.pageSize;
  const selected: T[] = [];
  for (const category of categories) {
    throwIfCancelled(signal);
    if (skip >= category.total) { skip -= category.total; continue; }
    const limit = Math.min(remaining, category.total - skip);
    if (limit > 0) {
      const values = await category.fetch(skip, limit);
      throwIfCancelled(signal);
      if (!Array.isArray(values) || values.length !== limit) sourceFail("operator source page did not match its authoritative count", "operator source page");
      selected.push(...values);
    }
    remaining -= limit;
    skip = 0;
    if (remaining <= 0) break;
  }
  return selected;
}

function matches(item: OperatorItemV1, input: NormalizedOperatorSnapshotReadInputV1): boolean {
  const queryMatch = !input.query || [item.id, item.label, item.status, item.summary, item.kind].some((value) => String(value ?? "").toLowerCase().includes(input.query));
  return queryMatch && (!input.status || item.status === input.status);
}

function isAttention(item: OperatorItemV1): boolean {
  return item.attention === true || ["failed", "needs-review", "blocked", "degraded", "unknown"].includes(item.status);
}

function pageFor(input: NormalizedOperatorSnapshotReadInputV1, section: OperatorSnapshotSectionNameV1): number {
  return input.pages[section] ?? input.page;
}

function exactSourceRecord(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) sourceFail(`${path} must be an object`, path);
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) sourceFail(`${path} must be a plain object`, path, "NON_PLAIN_APPLICATION_OBJECT");
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") sourceFail(`${path} cannot contain symbol fields`, path, "NON_JSON_APPLICATION_FIELD");
    if (["__proto__", "constructor", "prototype"].includes(key)) sourceFail(`${path} contains a reserved field`, `${path}.${key}`, "RESERVED_APPLICATION_FIELD");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) sourceFail(`${path}.${key} must be an enumerable data field`, `${path}.${key}`, "NON_JSON_APPLICATION_FIELD");
  }
  return input as Record<string, unknown>;
}

function sourceArray<T>(input: unknown, path: string): readonly T[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) sourceFail(`${path} must be a plain array`, path, "NON_PLAIN_APPLICATION_OBJECT");
  const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > SOURCE_ITEM_LIMIT) sourceFail(`${path} cannot contain more than ${SOURCE_ITEM_LIMIT} items`, path);
  const keys = Reflect.ownKeys(input);
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length) sourceFail(`${path} cannot contain extra fields`, path, "NON_JSON_APPLICATION_FIELD");
  }
  const output: T[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) sourceFail(`${path}[${index}] must be an enumerable data field`, `${path}[${index}]`, "NON_JSON_APPLICATION_FIELD");
    output.push(descriptor.value as T);
  }
  return Object.freeze(output);
}

function dataField(value: Record<string, unknown>, key: string, path: string, fallback?: unknown): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return fallback;
  if (!("value" in descriptor) || !descriptor.enumerable) sourceFail(`${path}.${key} must be an enumerable data field`, `${path}.${key}`, "NON_JSON_APPLICATION_FIELD");
  return descriptor.value;
}

function sourceText(input: unknown, fallback: string, path: string): string {
  if (input === undefined || input === null || input === "") return fallback;
  if (typeof input !== "string") sourceFail(`${path} must be a string`, path);
  const normalized = input.replace(/\s+/gu, " ").trim();
  if (!normalized) return fallback;
  if (SECRET_TEXT.some((pattern) => pattern.test(normalized))) return "[redacted]";
  if (Buffer.byteLength(normalized, "utf8") <= SOURCE_TEXT_BYTES) return normalized;
  let output = normalized;
  while (output && Buffer.byteLength(`${output}...`, "utf8") > SOURCE_TEXT_BYTES) output = output.slice(0, -1);
  return `${output}...`;
}

function requiredSourceText(input: unknown, path: string): string {
  const value = sourceText(input, "", path);
  if (!value) sourceFail(`${path} must not be empty`, path);
  return value;
}

function inputText(input: unknown, path: string): string {
  if (input === undefined) return "";
  if (typeof input !== "string") sourceFail(`${path} must be a string`, path);
  const value = input.trim();
  if (Buffer.byteLength(value, "utf8") > SOURCE_TEXT_BYTES) sourceFail(`${path} exceeds ${SOURCE_TEXT_BYTES} bytes`, path);
  return value;
}

function optionalProjectedText(value: Record<string, unknown>, key: "version" | "commit", path: string): Record<string, string> {
  const projected = optionalSourceText(value, key, path);
  return projected ? { [key]: projected } : {};
}

function optionalSourceText(value: Record<string, unknown>, key: string, path: string): string | undefined {
  const input = dataField(value, key, path, undefined);
  return input === undefined || input === null || input === "" ? undefined : sourceText(input, "", `${path}.${key}`);
}

function optionalSourceDigest(value: Record<string, unknown>, key: string, path: string): string | undefined {
  const input = dataField(value, key, path, undefined);
  if (input === undefined || input === null || input === "") return undefined;
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input)) sourceFail(`${path}.${key} must be a lowercase SHA-256 digest`, `${path}.${key}`);
  return input;
}

function optionalTimestampProjection(value: Record<string, unknown>, keys: readonly string[], path: string): { readonly updatedAt?: string } {
  for (const key of keys) {
    const input = dataField(value, key, path, undefined);
    if (input !== undefined && input !== null && input !== "") return { updatedAt: canonicalTimestamp(input, `${path}.${key}`) };
  }
  return {};
}

function optionalCanonicalTimestamp(value: Record<string, unknown>, key: "startedAt" | "settledAt", path: string): Record<string, string> {
  const input = dataField(value, key, path, undefined);
  return input === undefined || input === null || input === "" ? {} : { [key]: canonicalTimestamp(input, `${path}.${key}`) };
}

function optionalDigestProjection(value: Record<string, unknown>, key: "outcomeDigest", path: string): Record<string, string> {
  const digest = optionalSourceDigest(value, key, path);
  return digest ? { [key]: digest } : {};
}

function optionalCodeProjection(value: Record<string, unknown>, key: "errorCode", path: string): Record<string, string> {
  const input = dataField(value, key, path, undefined);
  if (input === undefined || input === null || input === "") return {};
  if (typeof input !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(input)) sourceFail(`${path}.${key} is invalid`, `${path}.${key}`);
  return { [key]: input };
}

function canonicalTimestamp(input: unknown, path: string): string {
  if (typeof input !== "string") sourceFail(`${path} must be a timestamp string`, path);
  const parsed = Date.parse(input);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input)
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== input) {
    sourceFail(`${path} must be a canonical UTC-millisecond timestamp`, path);
  }
  return input;
}

function canonicalDate(input: Date, path: string): string {
  if (!(input instanceof Date) || !Number.isFinite(input.getTime())) sourceFail(`${path} clock returned an invalid date`, path);
  return input.toISOString();
}

function sourceCount(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || Number(input) < 0) sourceFail(`${path} must be a non-negative safe integer`, path);
  return Number(input);
}

function positiveSourceCount(input: unknown, path: string): number {
  const value = sourceCount(input, path);
  if (value < 1) sourceFail(`${path} must be positive`, path);
  return value;
}

function sourceBoolean(input: unknown, path: string): boolean {
  if (typeof input !== "boolean") sourceFail(`${path} must be a boolean`, path);
  return input;
}

function sourceEnum<const T extends readonly string[]>(input: unknown, path: string, values: T): T[number] {
  if (typeof input !== "string" || !values.includes(input)) sourceFail(`${path} has an unsupported value`, path);
  return input as T[number];
}

function normalizePageNumber(input: unknown, fallback: number): number {
  return Number.isSafeInteger(input) && Number(input) > 0 ? Number(input) : fallback;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("operator snapshot read cancelled");
  error.name = "AbortError";
  throw error;
}

function sourceFail(message: string, path: string, code = "INVALID_APPLICATION_READ_CONTRACT"): never {
  throw new ApplicationContractValidationError(message, code, path);
}
