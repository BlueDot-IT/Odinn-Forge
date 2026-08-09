import { createHash } from "node:crypto";

export const WORKFLOW_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_MAX_STEPS = 64;
export const WORKFLOW_MAX_DEFINITION_BYTES = 128 * 1024;
export const WORKFLOW_MAX_INPUT_BYTES = 64 * 1024;
export const WORKFLOW_MAX_OUTPUT_BYTES = 64 * 1024;

export type WorkflowRetrySafety = "retry-safe" | "effectful";
export type WorkflowStepStatus = "queued" | "awaiting-approval" | "running" | "completed" | "failed" | "cancelled" | "needs-review";
export type WorkflowRunStatus = "queued" | "running" | "awaiting-approval" | "completed" | "failed" | "cancelled" | "needs-review";

export type WorkflowStepDefinition = {
  id: string;
  actionRef: string;
  dependsOn: string[];
  input: unknown;
  retrySafety: WorkflowRetrySafety;
  maxAttempts: number;
  requiresApproval: boolean;
};

export type WorkflowDefinition = {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  id: string;
  revision: number;
  name: string;
  steps: WorkflowStepDefinition[];
  definitionDigest: string;
};

export type WorkflowRunRequest = {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  runId: string;
  principalId: string;
  idempotencyKey: string;
  definition: WorkflowDefinition;
  input: unknown;
};

export type WorkflowStepRecord = {
  runId: string;
  stepId: string;
  actionRef: string;
  status: WorkflowStepStatus;
  attempt: number;
  retrySafety: WorkflowRetrySafety;
  maxAttempts: number;
  inputDigest: string;
  resultDigest?: string;
  errorCode?: string;
  leaseToken?: string;
  updatedAt: string;
};

export type WorkflowRunRecord = {
  runId: string;
  principalId: string;
  idempotencyKey: string;
  definitionId: string;
  definitionDigest: string;
  status: WorkflowRunStatus;
  inputDigest: string;
  recoveryInputAvailable: boolean;
  createdAt: string;
  updatedAt: string;
  steps: WorkflowStepRecord[];
};

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const ACTION = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/u;

function plain(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const prototype: object | null = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object`);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${label} cannot contain symbol properties`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) throw new TypeError(`${label} cannot contain accessors or hidden properties`);
    output[key] = descriptor.value;
  }
  return output;
}

function exact(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new TypeError(`${label} has unknown field: ${key}`);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new TypeError(`${label} must be a bounded identifier`);
  return value;
}

function action(value: unknown, label: string): string {
  if (typeof value !== "string" || !ACTION.test(value)) throw new TypeError(`${label} must be a bounded action reference`);
  return value;
}

function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${label} must be an integer from ${min} through ${max}`);
  return value;
}

function boundedJson(value: unknown, label: string, maxBytes: number): unknown {
  let nodes = 0;
  const visit = (candidate: unknown): unknown => {
    nodes += 1;
    if (nodes > 512) throw new RangeError(`${label} contains too many JSON nodes`);
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isSafeInteger(candidate)) throw new TypeError(`${label} contains an unsafe number`);
      return candidate;
    }
    if (Array.isArray(candidate)) return candidate.map(visit);
    const record = plain(candidate, label);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") throw new TypeError(`${label} contains a reserved key`);
      output[key] = visit(item);
    }
    return output;
  };
  const normalized = visit(value);
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > maxBytes) throw new RangeError(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  return normalized;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function workflowDefinitionDigest(definition: Omit<WorkflowDefinition, "definitionDigest">): string {
  return sha256(canonicalJson(definition));
}

export function validateWorkflowDefinition(input: unknown): WorkflowDefinition {
  const value = plain(input, "workflow definition");
  exact(value, new Set(["schemaVersion", "id", "revision", "name", "steps", "definitionDigest"]), "workflow definition");
  if (value.schemaVersion !== WORKFLOW_SCHEMA_VERSION) throw new TypeError("workflow definition has an unsupported schema version");
  const id = identifier(value.id, "workflow id");
  const name = typeof value.name === "string" && value.name.trim().length > 0 && Buffer.byteLength(value.name, "utf8") <= 256 ? value.name.trim() : (() => { throw new TypeError("workflow name is invalid"); })();
  const revision = integer(value.revision, "workflow revision", 1, 1_000_000);
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > WORKFLOW_MAX_STEPS) throw new RangeError(`workflow steps must contain 1-${WORKFLOW_MAX_STEPS} entries`);
  const ids = new Set<string>();
  const steps = value.steps.map((raw, index) => {
    const step = plain(raw, `workflow step ${index + 1}`);
    exact(step, new Set(["id", "actionRef", "dependsOn", "input", "retrySafety", "maxAttempts", "requiresApproval"]), `workflow step ${index + 1}`);
    const stepId = identifier(step.id, `workflow step ${index + 1} id`);
    if (ids.has(stepId)) throw new TypeError(`workflow contains duplicate step id: ${stepId}`);
    ids.add(stepId);
    if (!Array.isArray(step.dependsOn) || step.dependsOn.length > WORKFLOW_MAX_STEPS) throw new TypeError(`workflow step ${stepId} dependsOn must be an array`);
    const dependsOn = step.dependsOn.map((dependency, depIndex) => identifier(dependency, `workflow step ${stepId} dependency ${depIndex + 1}`));
    if (new Set(dependsOn).size !== dependsOn.length) throw new TypeError(`workflow step ${stepId} contains duplicate dependencies`);
    const retrySafety = step.retrySafety === "retry-safe" || step.retrySafety === "effectful" ? step.retrySafety : (() => { throw new TypeError(`workflow step ${stepId} retrySafety is invalid`); })();
    const maxAttempts = integer(step.maxAttempts, `workflow step ${stepId} maxAttempts`, 1, 8);
    const requiresApproval = typeof step.requiresApproval === "boolean" ? step.requiresApproval : (() => { throw new TypeError(`workflow step ${stepId} requiresApproval is invalid`); })();
    return { id: stepId, actionRef: action(step.actionRef, `workflow step ${stepId} actionRef`), dependsOn, input: boundedJson(step.input ?? {}, `workflow step ${stepId} input`, WORKFLOW_MAX_INPUT_BYTES), retrySafety, maxAttempts, requiresApproval } satisfies WorkflowStepDefinition;
  });
  for (const step of steps) for (const dependency of step.dependsOn) if (!ids.has(dependency)) throw new TypeError(`workflow step ${step.id} depends on unknown step: ${dependency}`);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new TypeError("workflow dependencies contain a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.id);
  const normalized: Omit<WorkflowDefinition, "definitionDigest"> = { schemaVersion: WORKFLOW_SCHEMA_VERSION, id, revision, name, steps };
  const definitionDigest = workflowDefinitionDigest(normalized);
  if (value.definitionDigest !== undefined && value.definitionDigest !== definitionDigest) throw new TypeError("workflow definition digest is invalid");
  const definition = freeze({ ...normalized, definitionDigest });
  if (Buffer.byteLength(canonicalJson(definition), "utf8") > WORKFLOW_MAX_DEFINITION_BYTES) throw new RangeError(`workflow definition exceeds ${WORKFLOW_MAX_DEFINITION_BYTES} UTF-8 bytes`);
  return definition;
}

export function validateWorkflowRunRequest(input: unknown): WorkflowRunRequest {
  const value = plain(input, "workflow run request");
  exact(value, new Set(["schemaVersion", "runId", "principalId", "idempotencyKey", "definition", "input"]), "workflow run request");
  if (value.schemaVersion !== WORKFLOW_SCHEMA_VERSION) throw new TypeError("workflow run request has an unsupported schema version");
  const request = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    runId: identifier(value.runId, "workflow run id"),
    principalId: identifier(value.principalId, "workflow principal id"),
    idempotencyKey: identifier(value.idempotencyKey, "workflow idempotency key"),
    definition: validateWorkflowDefinition(value.definition),
    input: boundedJson(value.input ?? {}, "workflow run input", WORKFLOW_MAX_INPUT_BYTES)
  } satisfies WorkflowRunRequest;
  return freeze(request);
}

export function projectWorkflowInput(value: unknown): { value: unknown; digest: string; recoveryInputAvailable: boolean } {
  const normalized = boundedJson(value, "workflow durable input", WORKFLOW_MAX_INPUT_BYTES);
  const json = canonicalJson(normalized);
  return { value: normalized, digest: sha256(json), recoveryInputAvailable: true };
}

export function projectWorkflowOutput(value: unknown): { digest: string; value: unknown } {
  const normalized = boundedJson(value, "workflow durable output", WORKFLOW_MAX_OUTPUT_BYTES);
  return { digest: sha256(canonicalJson(normalized)), value: normalized };
}

export function validateWorkflowTransition(from: WorkflowRunStatus | WorkflowStepStatus, to: WorkflowRunStatus | WorkflowStepStatus): void {
  const transitions: Record<string, ReadonlySet<string>> = {
    queued: new Set(["running", "awaiting-approval", "cancelled", "needs-review"]),
    "awaiting-approval": new Set(["running", "cancelled", "failed", "needs-review"]),
    running: new Set(["completed", "failed", "cancelled", "needs-review", "awaiting-approval"]),
    completed: new Set(),
    failed: new Set(["queued", "needs-review"]),
    cancelled: new Set(),
    "needs-review": new Set(["cancelled", "queued"])
  };
  if (from === to) return;
  if (!transitions[from]?.has(to)) throw new Error(`invalid workflow transition ${from} -> ${to}`);
}

export function workflowDefinitionForDigest(input: WorkflowDefinition): WorkflowDefinition {
  const definition = validateWorkflowDefinition(input);
  if (definition.definitionDigest !== input.definitionDigest) throw new Error("workflow definition is not canonical for its digest");
  return definition;
}
