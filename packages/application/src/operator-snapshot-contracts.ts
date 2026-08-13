import type { JsonObject } from "./contracts.ts";
import {
  normalizeReadContractJsonObjectV1,
  parseReadContractJsonObjectV1,
} from "./read-contract-json.ts";
import { containsSensitiveApplicationValue } from "./sensitive-metadata.ts";
import { ApplicationContractValidationError } from "./validation/errors.ts";
import type { ApprovalEffectSummaryV1 } from "./read-output-contracts.ts";

export const OPERATOR_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const OPERATOR_SNAPSHOT_DEFAULT_PAGE_SIZE = 10;
export const OPERATOR_SNAPSHOT_MAX_PAGE_SIZE = 50;

export const OPERATOR_SNAPSHOT_SECTION_NAMES = [
  "runtime",
  "work",
  "approvals",
  "automation",
  "context",
  "recovery",
  "audit",
  "surfaces",
] as const;

export type OperatorSnapshotSectionNameV1 = typeof OPERATOR_SNAPSHOT_SECTION_NAMES[number];
export type OperatorSurfaceV1 = "cli" | "tui" | "http" | "console";
export type OperatorHealthV1 = "healthy" | "attention" | "degraded";
export type OperatorActionNameV1 =
  | "cancel-job"
  | "approve"
  | "deny-approval"
  | "cancel-workflow"
  | "verify-audit";

export type OperatorExecutionAttemptStateV1 =
  | "proposed"
  | "admitted"
  | "queued"
  | "running"
  | "awaiting-approval"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "needs-review";

export interface OperatorExecutionAttemptSummaryV1 {
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

interface OperatorItemBaseV1 {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly summary?: string;
  readonly updatedAt?: string;
  readonly attention?: true;
}

export interface OperatorRuntimeItemV1 extends OperatorItemBaseV1 {
  readonly kind: "runtime";
  readonly status: "running" | "available" | "enabled" | "disabled" | "degraded";
}

export interface OperatorJobItemV1 extends OperatorItemBaseV1 {
  readonly kind: "job";
  readonly status: "queued" | "running" | "awaiting-approval" | "cancelling" | "completed" | "failed" | "cancelled" | "needs-review";
  readonly controls?: readonly "cancel-job"[];
  readonly details: {
    readonly attempts: number;
    readonly retrySafe: boolean;
    readonly executionRunId?: string;
    readonly envelopeDigest?: string;
    readonly auditCorrelationId?: string;
    readonly latestAttempt?: OperatorExecutionAttemptSummaryV1;
  };
}

export interface OperatorRunItemV1 extends OperatorItemBaseV1 {
  readonly kind: "run";
  readonly status: "unknown" | "running" | "awaiting_approval" | "completed" | "failed" | "blocked" | "cancelled" | "denied" | "needs-review";
  readonly details: {
    readonly eventCount: number;
    readonly actor: string;
    readonly latestAttempt?: OperatorExecutionAttemptSummaryV1;
  };
}

export interface OperatorApprovalItemV1 extends OperatorItemBaseV1 {
  readonly kind: "approval";
  readonly status: "pending" | "claimed";
  readonly controls?: readonly ("approve" | "deny-approval")[];
  readonly details: {
    readonly runId?: string;
    readonly expiresAt?: number;
    readonly effect?: ApprovalEffectSummaryV1;
  };
}

export interface OperatorWorkflowItemV1 extends OperatorItemBaseV1 {
  readonly kind: "workflow";
  readonly status: "queued" | "running" | "awaiting-approval" | "stopping" | "cancelling" | "completed" | "failed" | "cancelled" | "needs-review";
  readonly controls?: readonly "cancel-workflow"[];
}

export interface OperatorEventWatchItemV1 extends OperatorItemBaseV1 {
  readonly kind: "event-watch";
  readonly status: "enabled" | "disabled";
  readonly details: { readonly enabled: boolean };
}

export interface OperatorScheduleItemV1 extends OperatorItemBaseV1 {
  readonly kind: "schedule";
  readonly status: "enabled" | "disabled" | "needs-review";
  readonly details: { readonly nextRunAt: string | null };
}

export interface OperatorContextItemV1 extends OperatorItemBaseV1 {
  readonly kind: "context";
  readonly status: "enabled" | "disabled";
}

export interface OperatorBrowserRecoveryItemV1 extends OperatorItemBaseV1 {
  readonly id: "browser-recovery";
  readonly kind: "recovery";
  readonly status: "clear" | "executing" | "unknown" | "resolved" | "completed" | "needs-review";
  readonly details: { readonly pending: boolean };
}

export interface OperatorSandboxRecoveryItemV1 extends OperatorItemBaseV1 {
  readonly id: "sandbox-recovery";
  readonly kind: "recovery";
  readonly status: "clear" | "needs-review";
  readonly details: { readonly pending: number | null };
}

export interface OperatorProcessRecoveryItemV1 extends OperatorItemBaseV1 {
  readonly id: "process-recovery";
  readonly kind: "recovery";
  readonly status: "clear" | "needs-review";
  readonly details: { readonly pending: number | null };
}

export type OperatorRecoveryItemV1 =
  | OperatorBrowserRecoveryItemV1
  | OperatorSandboxRecoveryItemV1
  | OperatorProcessRecoveryItemV1;

export interface OperatorAuditItemV1 extends OperatorItemBaseV1 {
  readonly id: "audit-journal";
  readonly kind: "audit";
  readonly status: "verified" | "unknown" | "needs-review";
  readonly controls?: readonly "verify-audit"[];
  readonly details: {
    readonly events: number;
    readonly runs: number;
    readonly unsigned: number;
    readonly failures: number;
    readonly checked: boolean;
  };
}

export interface OperatorSurfaceItemV1 extends OperatorItemBaseV1 {
  readonly kind: "surface";
  readonly status: "available";
}

export type OperatorItemV1 =
  | OperatorRuntimeItemV1
  | OperatorJobItemV1
  | OperatorRunItemV1
  | OperatorApprovalItemV1
  | OperatorWorkflowItemV1
  | OperatorEventWatchItemV1
  | OperatorScheduleItemV1
  | OperatorContextItemV1
  | OperatorRecoveryItemV1
  | OperatorAuditItemV1
  | OperatorSurfaceItemV1;

export interface OperatorPaginationV1 {
  readonly page: number;
  readonly pageSize: number;
  readonly pages: number;
  readonly total: number;
  readonly from: number;
  readonly to: number;
}

export interface OperatorBaseCountsV1 {
  readonly total: number;
  readonly attention: number;
}

export interface OperatorWorkCountsV1 extends OperatorBaseCountsV1 {
  readonly jobs: number;
  readonly runs: number;
}

export interface OperatorApprovalCountsV1 extends OperatorBaseCountsV1 {
  readonly pending: number;
  readonly claimed: number;
}

export interface OperatorAutomationCountsV1 extends OperatorBaseCountsV1 {
  readonly workflows: number;
  readonly watches: number;
  readonly schedules: number;
}

export interface OperatorAuditCountsV1 extends OperatorBaseCountsV1 {
  readonly events: number;
  readonly runs: number;
}

export interface OperatorSectionV1<TItem extends OperatorItemV1, TCounts extends OperatorBaseCountsV1 = OperatorBaseCountsV1> {
  readonly status: OperatorHealthV1;
  readonly counts: TCounts;
  readonly items: readonly TItem[];
  readonly pagination: OperatorPaginationV1;
}

export interface OperatorActionDescriptorV1 {
  readonly action: OperatorActionNameV1;
  readonly label: string;
  readonly mutation: boolean;
  readonly requiresTarget: boolean;
  readonly confirmation: boolean;
}

export interface OperatorSnapshotV1 {
  readonly schemaVersion: typeof OPERATOR_SNAPSHOT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly surface: OperatorSurfaceV1;
  readonly identity: {
    readonly state: string;
    readonly workspaceRoot: string;
    readonly version?: string;
    readonly commit?: string;
  };
  readonly health: {
    readonly status: OperatorHealthV1;
    readonly ok: boolean;
    readonly attention: number;
    readonly summary: string;
  };
  readonly sections: {
    readonly runtime: OperatorSectionV1<OperatorRuntimeItemV1>;
    readonly work: OperatorSectionV1<OperatorJobItemV1 | OperatorRunItemV1, OperatorWorkCountsV1>;
    readonly approvals: OperatorSectionV1<OperatorApprovalItemV1, OperatorApprovalCountsV1>;
    readonly automation: OperatorSectionV1<OperatorWorkflowItemV1 | OperatorEventWatchItemV1 | OperatorScheduleItemV1, OperatorAutomationCountsV1>;
    readonly context: OperatorSectionV1<OperatorContextItemV1>;
    readonly recovery: OperatorSectionV1<OperatorRecoveryItemV1>;
    readonly audit: OperatorSectionV1<OperatorAuditItemV1, OperatorAuditCountsV1>;
    readonly surfaces: OperatorSectionV1<OperatorSurfaceItemV1>;
  };
  readonly actions: readonly OperatorActionDescriptorV1[];
}

export type OperatorSnapshotResponseV1 = OperatorSnapshotV1 & { readonly ok: true };

const SNAPSHOT_KEYS = ["schemaVersion", "generatedAt", "surface", "identity", "health", "sections", "actions"] as const;
const ITEM_BASE_KEYS = ["id", "kind", "label", "status", "summary", "updatedAt", "attention"] as const;
const OPERATOR_IDENTIFIER_MAX_BYTES = 512;
const OPERATOR_IDENTIFIER_CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const ATTEMPT_STATES: readonly OperatorExecutionAttemptStateV1[] = [
  "proposed", "admitted", "queued", "running", "awaiting-approval", "cancelling", "completed", "failed", "cancelled", "needs-review",
];
const ACTIONS: Readonly<Record<OperatorActionNameV1, Omit<OperatorActionDescriptorV1, "action">>> = Object.freeze({
  "cancel-job": { label: "Cancel job", mutation: true, requiresTarget: true, confirmation: true },
  approve: { label: "Approve once", mutation: true, requiresTarget: true, confirmation: true },
  "deny-approval": { label: "Deny approval", mutation: true, requiresTarget: true, confirmation: true },
  "cancel-workflow": { label: "Cancel workflow", mutation: true, requiresTarget: true, confirmation: true },
  "verify-audit": { label: "Verify audit", mutation: false, requiresTarget: false, confirmation: false },
});

export function defaultOperatorSnapshotActionsV1(): readonly OperatorActionDescriptorV1[] {
  return Object.freeze((Object.entries(ACTIONS) as Array<[OperatorActionNameV1, Omit<OperatorActionDescriptorV1, "action">]>).map(([action, descriptor]) => Object.freeze({ action, ...descriptor })));
}

/**
 * Validate an opaque identity used to join operator records or target a
 * governed action. These values must remain byte-for-byte stable: unlike
 * presentation text, they are never trimmed, whitespace-normalized,
 * truncated, or redacted into a potentially colliding value.
 */
export function validateOperatorIdentifierV1(input: unknown, path = "operator identifier"): string {
  if (typeof input !== "string" || input.length === 0) fail(`${path} must be a non-empty string`, path);
  if (Buffer.byteLength(input, "utf8") > OPERATOR_IDENTIFIER_MAX_BYTES) {
    fail(`${path} exceeds ${OPERATOR_IDENTIFIER_MAX_BYTES} bytes`, path);
  }
  if (OPERATOR_IDENTIFIER_CONTROL_PATTERN.test(input)) fail(`${path} contains control characters`, path);
  if (input.normalize("NFC") !== input) fail(`${path} must use canonical NFC normalization`, path);
  if (input.replace(/\s+/gu, " ").trim() !== input) fail(`${path} is not a canonical operator identifier`, path);
  if (containsSensitiveApplicationValue(input)) {
    fail(`${path} contains secret-like material`, path, "UNREDACTED_APPLICATION_METADATA");
  }
  return input;
}

export function parseOperatorSnapshotV1(source: string): OperatorSnapshotV1 {
  return assertOperatorSnapshotV1(parseReadContractJsonObjectV1(source, "operator snapshot"), "operator snapshot", false) as OperatorSnapshotV1;
}

export function validateOperatorSnapshotV1(input: unknown): OperatorSnapshotV1 {
  return assertOperatorSnapshotV1(normalizeReadContractJsonObjectV1(input, "operator snapshot"), "operator snapshot", false) as OperatorSnapshotV1;
}

export function parseOperatorSnapshotResponseV1(source: string): OperatorSnapshotResponseV1 {
  return assertOperatorSnapshotV1(parseReadContractJsonObjectV1(source, "operator snapshot response"), "operator snapshot response", true) as OperatorSnapshotResponseV1;
}

export function validateOperatorSnapshotResponseV1(input: unknown): OperatorSnapshotResponseV1 {
  return assertOperatorSnapshotV1(normalizeReadContractJsonObjectV1(input, "operator snapshot response"), "operator snapshot response", true) as OperatorSnapshotResponseV1;
}

function assertOperatorSnapshotV1(input: JsonObject, path: string, response: boolean): OperatorSnapshotV1 | OperatorSnapshotResponseV1 {
  object(input, path, response ? ["ok", ...SNAPSHOT_KEYS] : SNAPSHOT_KEYS);
  if (response) literal(input.ok, `${path}.ok`, true);
  literal(input.schemaVersion, `${path}.schemaVersion`, OPERATOR_SNAPSHOT_SCHEMA_VERSION);
  timestamp(input.generatedAt, `${path}.generatedAt`);
  oneOf(input.surface, `${path}.surface`, ["cli", "tui", "http", "console"]);

  const identity = object(input.identity, `${path}.identity`, ["state", "workspaceRoot", "version", "commit"], ["state", "workspaceRoot"]);
  text(identity.state, `${path}.identity.state`);
  text(identity.workspaceRoot, `${path}.identity.workspaceRoot`);
  optionalText(identity.version, `${path}.identity.version`);
  optionalText(identity.commit, `${path}.identity.commit`);

  const health = object(input.health, `${path}.health`, ["status", "ok", "attention", "summary"]);
  oneOf(health.status, `${path}.health.status`, ["healthy", "attention", "degraded"]);
  bool(health.ok, `${path}.health.ok`);
  count(health.attention, `${path}.health.attention`);
  text(health.summary, `${path}.health.summary`);
  if (health.ok !== (health.status === "healthy")) fail(`${path}.health.ok must match healthy status`, `${path}.health.ok`);

  const sections = object(input.sections, `${path}.sections`, OPERATOR_SNAPSHOT_SECTION_NAMES);
  validateSection(sections.runtime, `${path}.sections.runtime`, "runtime", ["total", "attention"]);
  validateSection(sections.work, `${path}.sections.work`, "work", ["total", "jobs", "runs", "attention"]);
  validateSection(sections.approvals, `${path}.sections.approvals`, "approvals", ["total", "pending", "claimed", "attention"]);
  validateSection(sections.automation, `${path}.sections.automation`, "automation", ["total", "workflows", "watches", "schedules", "attention"]);
  validateSection(sections.context, `${path}.sections.context`, "context", ["total", "attention"]);
  validateSection(sections.recovery, `${path}.sections.recovery`, "recovery", ["total", "attention"]);
  validateSection(sections.audit, `${path}.sections.audit`, "audit", ["total", "events", "runs", "attention"]);
  validateSection(sections.surfaces, `${path}.sections.surfaces`, "surfaces", ["total", "attention"]);
  validateUniqueOperatorTargets(sections, `${path}.sections`);

  if ((health.status === "healthy") !== (Number(health.attention) === 0)) fail(`${path}.health.status must reflect attention totals`, `${path}.health.status`);
  const visibleSectionAttention = OPERATOR_SNAPSHOT_SECTION_NAMES.reduce((total, name) => {
    const section = sections[name] as Record<string, unknown>;
    const counts = section.counts as Record<string, unknown>;
    return total + Number(counts.attention);
  }, 0);
  if (Number(health.attention) < visibleSectionAttention) {
    fail(`${path}.health.attention cannot be lower than visible section attention`, `${path}.health.attention`);
  }

  if (!Array.isArray(input.actions)) fail(`${path}.actions must be an array`, `${path}.actions`);
  const seen = new Set<string>();
  input.actions.forEach((entry, index) => {
    const actionPath = `${path}.actions[${index}]`;
    const action = object(entry, actionPath, ["action", "label", "mutation", "requiresTarget", "confirmation"]);
    oneOf(action.action, `${actionPath}.action`, Object.keys(ACTIONS));
    const name = action.action as OperatorActionNameV1;
    if (seen.has(name)) fail(`${path}.actions contains duplicate action: ${name}`, `${actionPath}.action`);
    seen.add(name);
    const expected = ACTIONS[name];
    literal(action.label, `${actionPath}.label`, expected.label);
    literal(action.mutation, `${actionPath}.mutation`, expected.mutation);
    literal(action.requiresTarget, `${actionPath}.requiresTarget`, expected.requiresTarget);
    literal(action.confirmation, `${actionPath}.confirmation`, expected.confirmation);
  });
  if (seen.size !== Object.keys(ACTIONS).length) fail(`${path}.actions must contain every V1 operator action`, `${path}.actions`);
  return input as unknown as OperatorSnapshotV1 | OperatorSnapshotResponseV1;
}

function validateUniqueOperatorTargets(sections: Record<string, unknown>, path: string): void {
  const itemIdentities = new Set<string>();
  const actionTargets = new Set<string>();
  for (const sectionName of OPERATOR_SNAPSHOT_SECTION_NAMES) {
    const section = sections[sectionName] as Record<string, unknown>;
    const items = section.items as readonly Record<string, unknown>[];
    items.forEach((item, index) => {
      const itemPath = `${path}.${sectionName}.items[${index}]`;
      const identity = JSON.stringify([item.kind, item.id]);
      if (itemIdentities.has(identity)) fail(`${itemPath} duplicates a public operator identity`, `${itemPath}.id`);
      itemIdentities.add(identity);
      if (!Array.isArray(item.controls)) return;
      for (const action of item.controls) {
        const target = JSON.stringify([action, item.id]);
        if (actionTargets.has(target)) fail(`${itemPath} duplicates an operator action target`, `${itemPath}.id`);
        actionTargets.add(target);
      }
    });
  }
}

function validateSection(input: unknown, path: string, name: OperatorSnapshotSectionNameV1, countKeys: readonly string[]): void {
  const section = object(input, path, ["status", "counts", "items", "pagination"]);
  oneOf(section.status, `${path}.status`, ["healthy", "attention", "degraded"]);
  const counts = object(section.counts, `${path}.counts`, countKeys);
  for (const key of countKeys) count(counts[key], `${path}.counts.${key}`);
  if (Number(counts.attention) > Number(counts.total)) fail(`${path}.counts.attention cannot exceed total`, `${path}.counts.attention`);
  if (name === "work" && Number(counts.jobs) + Number(counts.runs) !== Number(counts.total)) fail(`${path}.counts jobs and runs must equal total`, `${path}.counts.total`);
  if (name === "approvals" && Number(counts.pending) + Number(counts.claimed) !== Number(counts.total)) fail(`${path}.counts pending and claimed must equal total`, `${path}.counts.total`);
  if (name === "automation" && Number(counts.workflows) + Number(counts.watches) + Number(counts.schedules) !== Number(counts.total)) fail(`${path}.counts automation categories must equal total`, `${path}.counts.total`);
  if ((section.status === "healthy") !== (Number(counts.attention) === 0)) fail(`${path}.status must reflect section attention`, `${path}.status`);

  const pagination = object(section.pagination, `${path}.pagination`, ["page", "pageSize", "pages", "total", "from", "to"]);
  positiveCount(pagination.page, `${path}.pagination.page`);
  positiveCount(pagination.pageSize, `${path}.pagination.pageSize`);
  if (Number(pagination.pageSize) > OPERATOR_SNAPSHOT_MAX_PAGE_SIZE) fail(`${path}.pagination.pageSize cannot exceed ${OPERATOR_SNAPSHOT_MAX_PAGE_SIZE}`, `${path}.pagination.pageSize`);
  positiveCount(pagination.pages, `${path}.pagination.pages`);
  count(pagination.total, `${path}.pagination.total`);
  count(pagination.from, `${path}.pagination.from`);
  count(pagination.to, `${path}.pagination.to`);
  if (pagination.total !== counts.total) fail(`${path}.pagination.total must equal counts.total`, `${path}.pagination.total`);
  const expectedPages = Math.max(1, Math.ceil(Number(pagination.total) / Number(pagination.pageSize)));
  if (pagination.pages !== expectedPages) fail(`${path}.pagination.pages is inconsistent`, `${path}.pagination.pages`);
  if (Number(pagination.page) > expectedPages) fail(`${path}.pagination.page cannot exceed pages`, `${path}.pagination.page`);
  const offset = (Number(pagination.page) - 1) * Number(pagination.pageSize);
  const expectedFrom = Number(pagination.total) ? offset + 1 : 0;
  const expectedTo = Number(pagination.total) ? Math.min(offset + Number(pagination.pageSize), Number(pagination.total)) : 0;
  if (pagination.from !== expectedFrom || pagination.to !== expectedTo) fail(`${path}.pagination range is inconsistent`, `${path}.pagination`);

  if (!Array.isArray(section.items)) fail(`${path}.items must be an array`, `${path}.items`);
  const expectedItems = expectedTo === 0 ? 0 : expectedTo - expectedFrom + 1;
  if (section.items.length !== expectedItems) fail(`${path}.items length does not match pagination`, `${path}.items`);
  section.items.forEach((item, index) => validateItem(item, `${path}.items[${index}]`, name));
  const visibleAttention = section.items.filter((item) => (item as Record<string, unknown>).attention === true).length;
  if (visibleAttention > Number(counts.attention)) {
    fail(`${path}.counts.attention cannot be lower than visible item attention`, `${path}.counts.attention`);
  }
}

function validateItem(input: unknown, path: string, section: OperatorSnapshotSectionNameV1): void {
  const header = openObject(input, path);
  text(header.kind, `${path}.kind`);
  const kind = header.kind;
  const allowedBySection: Readonly<Record<OperatorSnapshotSectionNameV1, readonly string[]>> = {
    runtime: ["runtime"],
    work: ["job", "run"],
    approvals: ["approval"],
    automation: ["workflow", "event-watch", "schedule"],
    context: ["context"],
    recovery: ["recovery"],
    audit: ["audit"],
    surfaces: ["surface"],
  };
  if (typeof kind !== "string" || !allowedBySection[section].includes(kind)) fail(`${path}.kind is not valid in ${section}`, `${path}.kind`);
  switch (kind) {
    case "runtime": {
      const value = itemBase(input, path, []);
      oneOf(value.status, `${path}.status`, ["running", "available", "enabled", "disabled", "degraded"]);
      attentionFlag(value, path, value.status === "degraded");
      return;
    }
    case "job": {
      const value = itemBase(input, path, ["controls", "details"]);
      oneOf(value.status, `${path}.status`, ["queued", "running", "awaiting-approval", "cancelling", "completed", "failed", "cancelled", "needs-review"]);
      attentionFlag(value, path, value.status === "failed" || value.status === "needs-review");
      const jobCanCancel = ["queued", "running", "awaiting-approval", "cancelling"].includes(String(value.status));
      if (jobCanCancel) exactActionList(value.controls, `${path}.controls`, ["cancel-job"]);
      else if (value.controls !== undefined) fail(`${path}.controls is not allowed for a terminal job`, `${path}.controls`);
      const details = object(value.details, `${path}.details`, ["attempts", "retrySafe", "executionRunId", "envelopeDigest", "auditCorrelationId", "latestAttempt"], ["attempts", "retrySafe"]);
      count(details.attempts, `${path}.details.attempts`);
      bool(details.retrySafe, `${path}.details.retrySafe`);
      if (details.executionRunId !== undefined) validateOperatorIdentifierV1(details.executionRunId, `${path}.details.executionRunId`);
      if (details.envelopeDigest !== undefined) sha256(details.envelopeDigest, `${path}.details.envelopeDigest`);
      if (details.auditCorrelationId !== undefined) validateOperatorIdentifierV1(details.auditCorrelationId, `${path}.details.auditCorrelationId`);
      if (details.latestAttempt !== undefined) {
        validateAttempt(details.latestAttempt, `${path}.details.latestAttempt`);
        if (details.executionRunId === undefined) fail(`${path}.details.latestAttempt requires executionRunId`, `${path}.details.latestAttempt`);
        if ((details.latestAttempt as Record<string, unknown>).runId !== details.executionRunId) {
          fail(`${path}.details.latestAttempt.runId must match executionRunId`, `${path}.details.latestAttempt.runId`);
        }
        validateAttemptBinding("job", String(value.status), String((details.latestAttempt as Record<string, unknown>).state), `${path}.details.latestAttempt.state`);
      }
      return;
    }
    case "run": {
      const value = itemBase(input, path, ["details"]);
      oneOf(value.status, `${path}.status`, ["unknown", "running", "awaiting_approval", "completed", "failed", "blocked", "cancelled", "denied", "needs-review"]);
      attentionFlag(value, path, ["unknown", "failed", "blocked", "needs-review"].includes(String(value.status)));
      const details = object(value.details, `${path}.details`, ["eventCount", "actor", "latestAttempt"], ["eventCount", "actor"]);
      count(details.eventCount, `${path}.details.eventCount`);
      text(details.actor, `${path}.details.actor`);
      if (details.latestAttempt !== undefined) {
        validateAttempt(details.latestAttempt, `${path}.details.latestAttempt`);
        if ((details.latestAttempt as Record<string, unknown>).runId !== value.id) {
          fail(`${path}.details.latestAttempt.runId must match run id`, `${path}.details.latestAttempt.runId`);
        }
        validateAttemptBinding("run", String(value.status), String((details.latestAttempt as Record<string, unknown>).state), `${path}.details.latestAttempt.state`);
      }
      return;
    }
    case "approval": {
      const value = itemBase(input, path, ["controls", "details"]);
      oneOf(value.status, `${path}.status`, ["pending", "claimed"]);
      attentionFlag(value, path, true);
      if (value.status === "pending") exactActionList(value.controls, `${path}.controls`, ["approve", "deny-approval"]);
      else if (value.controls !== undefined) fail(`${path}.controls is not allowed while approval execution is claimed`, `${path}.controls`);
      const details = object(value.details, `${path}.details`, ["runId", "expiresAt", "effect"], []);
      if (details.runId !== undefined) validateOperatorIdentifierV1(details.runId, `${path}.details.runId`);
      if (details.expiresAt !== undefined) count(details.expiresAt, `${path}.details.expiresAt`);
      if (details.effect !== undefined) validateApprovalEffect(details.effect, `${path}.details.effect`);
      return;
    }
    case "workflow": {
      const value = itemBase(input, path, ["controls"]);
      oneOf(value.status, `${path}.status`, ["queued", "running", "awaiting-approval", "stopping", "cancelling", "completed", "failed", "cancelled", "needs-review"]);
      attentionFlag(value, path, ["awaiting-approval", "failed", "needs-review"].includes(String(value.status)));
      const workflowControl = ["queued", "running", "awaiting-approval", "stopping", "cancelling"].includes(String(value.status))
          ? ["cancel-workflow"]
          : undefined;
      if (workflowControl) exactActionList(value.controls, `${path}.controls`, workflowControl);
      else if (value.controls !== undefined) fail(`${path}.controls is not allowed for a terminal workflow`, `${path}.controls`);
      return;
    }
    case "event-watch": {
      const value = itemBase(input, path, ["details"]);
      oneOf(value.status, `${path}.status`, ["enabled", "disabled"]);
      attentionFlag(value, path, false);
      const details = object(value.details, `${path}.details`, ["enabled"]);
      bool(details.enabled, `${path}.details.enabled`);
      return;
    }
    case "schedule": {
      const value = itemBase(input, path, ["details"]);
      oneOf(value.status, `${path}.status`, ["enabled", "disabled", "needs-review"]);
      attentionFlag(value, path, value.status === "needs-review");
      const details = object(value.details, `${path}.details`, ["nextRunAt"]);
      if (details.nextRunAt !== null) timestamp(details.nextRunAt, `${path}.details.nextRunAt`);
      return;
    }
    case "context": {
      const value = itemBase(input, path, []);
      oneOf(value.status, `${path}.status`, ["enabled", "disabled"]);
      attentionFlag(value, path, false);
      return;
    }
    case "recovery": validateRecoveryItem(input, path); return;
    case "audit": {
      const value = itemBase(input, path, ["controls", "details"]);
      literal(value.id, `${path}.id`, "audit-journal");
      oneOf(value.status, `${path}.status`, ["verified", "unknown", "needs-review"]);
      attentionFlag(value, path, value.status !== "verified");
      if (value.status === "verified") {
        if (value.controls !== undefined) fail(`${path}.controls is not allowed for verified audit state`, `${path}.controls`);
      } else exactActionList(value.controls, `${path}.controls`, ["verify-audit"]);
      const details = object(value.details, `${path}.details`, ["events", "runs", "unsigned", "failures", "checked"]);
      for (const key of ["events", "runs", "unsigned", "failures"] as const) count(details[key], `${path}.details.${key}`);
      bool(details.checked, `${path}.details.checked`);
      if (value.status === "verified" && details.checked !== true) fail(`${path}.details.checked must be true for verified audit status`, `${path}.details.checked`);
      if (value.status === "unknown" && (details.checked !== false || Number(details.failures) !== 0)) fail(`${path}.status is inconsistent with audit evidence`, `${path}.status`);
      if (Number(details.failures) > 0 && value.status !== "needs-review") fail(`${path}.status must reflect audit failures`, `${path}.status`);
      return;
    }
    case "surface": {
      const value = itemBase(input, path, []);
      literal(value.status, `${path}.status`, "available");
      attentionFlag(value, path, false);
      return;
    }
    default: fail(`${path}.kind is unsupported`, `${path}.kind`);
  }
}

function validateRecoveryItem(input: unknown, path: string): void {
  const value = itemBase(input, path, ["details"]);
  const details = object(value.details, `${path}.details`, ["pending"]);
  switch (value.id) {
    case "browser-recovery":
      oneOf(value.status, `${path}.status`, ["clear", "executing", "unknown", "resolved", "completed", "needs-review"]);
      bool(details.pending, `${path}.details.pending`);
      attentionFlag(value, path, !["clear", "resolved", "completed"].includes(String(value.status)));
      if (details.pending !== (value.attention === true)) fail(`${path}.details.pending must match recovery attention`, `${path}.details.pending`);
      break;
    case "sandbox-recovery":
    case "process-recovery":
      oneOf(value.status, `${path}.status`, ["clear", "needs-review"]);
      if (details.pending !== null) count(details.pending, `${path}.details.pending`);
      attentionFlag(value, path, value.status === "needs-review");
      if (value.status === "clear" && details.pending !== 0) fail(`${path}.details.pending must be zero when recovery is clear`, `${path}.details.pending`);
      if (value.status === "needs-review" && details.pending === 0) fail(`${path}.details.pending must be positive or unknown when recovery needs review`, `${path}.details.pending`);
      break;
    default: fail(`${path}.id is not a V1 recovery source`, `${path}.id`);
  }
}

function itemBase(input: unknown, path: string, extra: readonly string[]): Record<string, unknown> {
  const value = object(input, path, [...ITEM_BASE_KEYS, ...extra], ["id", "kind", "label", "status"]);
  validateOperatorIdentifierV1(value.id, `${path}.id`);
  text(value.kind, `${path}.kind`);
  text(value.label, `${path}.label`);
  text(value.status, `${path}.status`);
  optionalText(value.summary, `${path}.summary`, true);
  if (value.updatedAt !== undefined) timestamp(value.updatedAt, `${path}.updatedAt`);
  if (value.attention !== undefined) literal(value.attention, `${path}.attention`, true);
  return value;
}

function validateAttempt(input: unknown, path: string): void {
  const value = object(input, path, ["id", "runId", "attemptNumber", "state", "createdAt", "startedAt", "settledAt", "outcomeDigest", "errorCode"], ["id", "runId", "attemptNumber", "state", "createdAt"]);
  validateOperatorIdentifierV1(value.id, `${path}.id`);
  validateOperatorIdentifierV1(value.runId, `${path}.runId`);
  positiveCount(value.attemptNumber, `${path}.attemptNumber`);
  oneOf(value.state, `${path}.state`, ATTEMPT_STATES);
  timestamp(value.createdAt, `${path}.createdAt`);
  if (value.startedAt !== undefined) timestamp(value.startedAt, `${path}.startedAt`);
  if (value.settledAt !== undefined) timestamp(value.settledAt, `${path}.settledAt`);
  if (value.outcomeDigest !== undefined) sha256(value.outcomeDigest, `${path}.outcomeDigest`);
  if (value.errorCode !== undefined) {
    text(value.errorCode, `${path}.errorCode`);
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(value.errorCode as string)) fail(`${path}.errorCode is invalid`, `${path}.errorCode`);
  }
}

function validateAttemptBinding(kind: "job" | "run", status: string, state: string, path: string): void {
  if (state === "needs-review" && status !== "needs-review") {
    fail(`${path} is inconsistent with the public ${kind} status`, path);
  }
}

function validateApprovalEffect(input: unknown, path: string): void {
  const value = object(input, path, ["version", "tool", "summary", "capability", "inputDigest", "reversible", "idempotency", "effectClass", "isolation", "command", "cwd", "argsCount", "commandDigest", "recovery", "target", "tabId", "expectedUrl", "selector", "mutation", "server", "mcpTool", "argsDigest", "payloadDigest", "skillId", "skillVersion", "action", "inputKeys"], ["version", "tool", "summary", "capability", "inputDigest", "reversible", "idempotency"]);
  literal(value.version, `${path}.version`, 1);
  text(value.tool, `${path}.tool`);
  text(value.summary, `${path}.summary`);
  text(value.capability, `${path}.capability`, true);
  text(value.inputDigest, `${path}.inputDigest`);
  oneOf(value.reversible, `${path}.reversible`, ["reversible", "irreversible", "uncertain"]);
  oneOf(value.idempotency, `${path}.idempotency`, ["idempotent", "non-idempotent", "unknown"]);
  for (const key of ["effectClass", "isolation", "cwd", "commandDigest", "recovery", "target", "tabId", "expectedUrl", "selector", "mutation", "server", "mcpTool", "argsDigest", "payloadDigest", "skillId", "skillVersion", "action"] as const) optionalText(value[key], `${path}.${key}`, true);
  if (value.command !== undefined) literal(value.command, `${path}.command`, "[redacted]");
  if (value.argsCount !== undefined) count(value.argsCount, `${path}.argsCount`);
  if (value.inputKeys !== undefined) stringList(value.inputKeys, `${path}.inputKeys`);
}

function actionList(input: unknown, path: string, allowed: readonly string[]): void {
  if (!Array.isArray(input)) fail(`${path} must be an array`, path);
  const seen = new Set<string>();
  input.forEach((entry, index) => {
    oneOf(entry, `${path}[${index}]`, allowed);
    if (seen.has(entry as string)) fail(`${path} cannot contain duplicate actions`, `${path}[${index}]`);
    seen.add(entry as string);
  });
}

function exactActionList(input: unknown, path: string, expected: readonly string[]): void {
  actionList(input, path, expected);
  if (!Array.isArray(input) || input.length !== expected.length
    || input.some((entry, index) => entry !== expected[index])) {
    fail(`${path} must contain the exact actions for this item state`, path);
  }
}

function attentionFlag(value: Record<string, unknown>, path: string, required: boolean): void {
  if ((value.attention === true) !== required) fail(`${path}.attention must match item state`, `${path}.attention`);
}

function object(input: unknown, path: string, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(`${path} must be an object`, path);
  const value = input as Record<string, unknown>;
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) fail(`${path} contains unknown field: ${unknown}`, `${path}.${unknown}`, "UNKNOWN_APPLICATION_FIELD");
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) fail(`${path} is missing required field: ${missing}`, `${path}.${missing}`);
  return value;
}

function openObject(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(`${path} must be an object`, path);
  return input as Record<string, unknown>;
}

function stringList(input: unknown, path: string): void {
  if (!Array.isArray(input)) fail(`${path} must be an array`, path);
  input.forEach((entry, index) => text(entry, `${path}[${index}]`, true));
}

function text(input: unknown, path: string, allowEmpty = false): void {
  if (typeof input !== "string" || (!allowEmpty && input.length === 0)) fail(`${path} must be ${allowEmpty ? "a" : "a non-empty"} string`, path);
}

function optionalText(input: unknown, path: string, allowEmpty = false): void {
  if (input !== undefined) text(input, path, allowEmpty);
}

function timestamp(input: unknown, path: string): void {
  text(input, path);
  const value = input as string;
  const parsed = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${path} must be a canonical UTC-millisecond timestamp`, path);
  }
}

function sha256(input: unknown, path: string): void {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input)) fail(`${path} must be a lowercase SHA-256 digest`, path);
}

function bool(input: unknown, path: string): void {
  if (typeof input !== "boolean") fail(`${path} must be a boolean`, path);
}

function count(input: unknown, path: string): void {
  if (!Number.isSafeInteger(input) || Number(input) < 0) fail(`${path} must be a non-negative safe integer`, path);
}

function positiveCount(input: unknown, path: string): void {
  if (!Number.isSafeInteger(input) || Number(input) < 1) fail(`${path} must be a positive safe integer`, path);
}

function oneOf(input: unknown, path: string, values: readonly string[]): void {
  if (typeof input !== "string" || !values.includes(input)) fail(`${path} has an unsupported value`, path);
}

function literal(input: unknown, path: string, expected: string | number | boolean): void {
  if (input !== expected) fail(`${path} must be ${JSON.stringify(expected)}`, path);
}

function fail(message: string, path: string, code = "INVALID_APPLICATION_READ_CONTRACT"): never {
  throw new ApplicationContractValidationError(message, code, path);
}
