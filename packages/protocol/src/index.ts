import { createHash, randomUUID } from "node:crypto";

export {
  EXECUTION_ENVELOPE_VERSION,
  MAX_EXECUTION_ENVELOPE_BYTES,
  ExecutionEnvelopeValidationError,
  canonicalizeExecutionEnvelopeV1,
  digestExecutionEnvelopeV1,
  parseExecutionEnvelopeV1,
  validateExecutionEnvelopeV1
} from "./execution-envelope.ts";
export type {
  ExecutionApprovalRequirementV1,
  ExecutionEnvelopeV1,
  ExecutionIdentityV1,
  ExecutionKindV1,
  ExecutionResourceLimitsV1,
  ExecutionRetrySafetyV1
} from "./execution-envelope.ts";

export const AUDIT_SCHEMA_VERSION = 1;

export type JsonObject = { [key: string]: unknown };

export type DurableRedactionContext = {
  toolName?: string;
  input?: boolean;
};

const REDACTED = "[redacted]";
const SECRET_KEYS = new Set([
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "capability",
  "capabilitytoken",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "password",
  "passwordhash",
  "passwd",
  "secret",
  "clientsecret",
  "botsecret",
  "bottoken",
  "privatekey"
]);
const SECRET_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|capability(?:[_-]?token)?|authorization|cookie|credentials?|password(?:[_-]?hash)?|passwd|secret|client[_-]?secret|bot[_-]?(?:secret|token)|private[_-]?key)\s*([:=])\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu;
const URL_CREDENTIAL = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/giu;
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gu;
const SECRET_VALUES = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+/giu,
  /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/giu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,})\b/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bAIza[A-Za-z0-9_-]{30,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/gu,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  /\b(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,})\b/gu
];

/**
 * The single persistence-boundary sanitizer used by audit, approval, ledger,
 * and portable-export stores. Tool semantics are deliberately applied here,
 * after authorization/idempotency digests have been computed from the real
 * request, so redaction cannot weaken action binding.
 */
export function redactDurableValue(value: unknown, context: DurableRedactionContext = {}): unknown {
  return redactDurableNode(value, {
    toolName: context.toolName,
    input: context.input === true,
    depth: 0,
    key: ""
  });
}

const WORKSPACE_CONTENT_TOOLS = new Set(["workspace.readText", "workspace.read", "workspace.search", "workspace.diff"]);
const WORKSPACE_MUTATION_TOOLS = new Set(["workspace.mutate", "workspace.patch"]);

export function isWorkspaceContentTool(toolName: unknown): boolean {
  return typeof toolName === "string" && WORKSPACE_CONTENT_TOOLS.has(toolName);
}

/**
 * Remove workspace content-bearing request fields before durable persistence.
 * The live request remains unchanged for first dispatch; only this projection
 * may cross audit, ledger, or runtime-job persistence boundaries.
 */
export function projectDurableToolInput(toolName: string, input: unknown): unknown {
  if (WORKSPACE_MUTATION_TOOLS.has(toolName)) return projectMutationPayload(input);
  if (!isWorkspaceContentTool(toolName) || !input || typeof input !== "object" || Array.isArray(input)) return input;
  const projected = { ...(input as JsonObject) };
  if (typeof projected.before === "string") {
    projected.beforeDigest = sha256Reference(projected.before);
    projected.beforeBytes = Buffer.byteLength(projected.before, "utf8");
    delete projected.before;
  }
  if (toolName === "workspace.search" && typeof projected.query === "string") {
    projected.queryDigest = sha256Reference(projected.query);
    projected.queryBytes = Buffer.byteLength(projected.query, "utf8");
    delete projected.query;
  }
  return projected;
}

/** Project workspace results to bounded metadata before durable persistence. */
export function projectDurableToolOutput(toolName: string, output: unknown): unknown {
  if (WORKSPACE_MUTATION_TOOLS.has(toolName)) return projectMutationPayload(output);
  if (!toolName.startsWith("workspace.") || !output || typeof output !== "object" || Array.isArray(output)) return output;
  const record = output as JsonObject;
  if (toolName === "workspace.read" || toolName === "workspace.readText") {
    return pickWorkspaceMetadata(record, ["path", "resolvedPath", "type", "binary", "bytes", "bytesRead", "truncated", "digest", "digestComplete"]);
  }
  if (toolName === "workspace.search") {
    return {
      ...pickWorkspaceMetadata(record, ["path", "resolvedPath", "nextCursor", "searchedFiles", "searchedBytes"]),
      matchCount: Array.isArray(record.matches) ? record.matches.length : 0,
      matches: Array.isArray(record.matches) ? record.matches.map((match) => ({
        ...pickWorkspaceMetadata(match as JsonObject, ["path", "resolvedPath", "digest", "digestComplete", "truncated"]),
        matchCount: Array.isArray((match as JsonObject).matches) ? ((match as JsonObject).matches as unknown[]).length : 0
      })) : []
    };
  }
  if (toolName === "workspace.diff") {
    return pickWorkspaceMetadata(record, ["path", "resolvedPath", "basePath", "beforeDigest", "digest", "digestComplete", "diffDigest", "truncated"]);
  }
  if (toolName === "workspace.list") {
    return {
      ...pickWorkspaceMetadata(record, ["path", "resolvedPath", "nextCursor", "visited", "omittedSensitive", "limits"]),
      entryCount: Array.isArray(record.entries) ? record.entries.length : 0
    };
  }
  if (toolName === "workspace.stat") {
    return pickWorkspaceMetadata(record, ["path", "resolvedPath", "type", "binary", "bytes", "modifiedAt", "mode", "digest", "digestComplete"]);
  }
  return output;
}

function sha256Reference(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

const MUTATION_PAYLOAD_FIELDS = new Set(["content", "find", "replace"]);

function projectMutationPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => projectMutationPayload(item));
  if (!value || typeof value !== "object") return value;
  const projected: JsonObject = {};
  for (const [key, item] of Object.entries(value as JsonObject)) {
    if (MUTATION_PAYLOAD_FIELDS.has(key) && typeof item === "string") {
      projected[`${key}Digest`] = sha256Reference(item);
      projected[`${key}Bytes`] = Buffer.byteLength(item, "utf8");
    } else {
      projected[key] = projectMutationPayload(item);
    }
  }
  return projected;
}

function pickWorkspaceMetadata(value: JsonObject, keys: readonly string[]) {
  return Object.fromEntries(keys.flatMap((key) => value[key] === undefined ? [] : [[key, value[key]]]));
}

function redactDurableNode(value: unknown, state: DurableRedactionContext & { depth: number; key: string }): unknown {
  if (state.depth > 8) return "[redacted-depth]";
  if (isSecretKey(state.key)) return REDACTED;
  if (typeof value === "string") {
    let redacted = value
      .replace(PRIVATE_KEY_BLOCK, REDACTED)
      .replace(URL_CREDENTIAL, `$1${REDACTED}@`);
    for (const pattern of SECRET_VALUES) redacted = redacted.replace(pattern, REDACTED);
    return redacted.replace(SECRET_ASSIGNMENT, `$1$2${REDACTED}`).slice(0, 100_000);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 1_000).map((item) => redactDurableNode(item, { ...state, key: "", depth: state.depth + 1 }));
  }
  if (!value || typeof value !== "object") return value;

  const record = value as JsonObject;
  const toolName = typeof record.toolName === "string"
    ? record.toolName
    : typeof record.tool === "string"
      ? record.tool
      : state.toolName;
  const markedSensitive = record.sensitive === true;
  return Object.fromEntries(Object.entries(record)
    .slice(0, 1_000)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => {
      const isInput = state.input || key === "input";
      const browserTypeValue = toolName === "browser.type" && isInput && key === "value";
      if (browserTypeValue || (markedSensitive && key === "value")) return [key, REDACTED];
      return [key, redactDurableNode(item, {
        toolName,
        input: isInput,
        depth: state.depth + 1,
        key
      })];
    }));
}

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.replaceAll("_", "").replaceAll("-", "").toLowerCase());
}

export interface TaskRequest {
  id: string;
  tool: string;
  input: JsonObject;
  actor: string;
  reason?: string;
}

export interface AuditEvent {
  schemaVersion: number;
  at: string;
  runId: string;
  type: string;
  actor: string;
  tool?: string;
  capability?: string;
  decision?: string;
  message?: string;
  data?: JsonObject;
}

export class ProtocolError extends Error {
  readonly details: JsonObject;

  constructor(message: string, details: JsonObject = {}) {
    super(message);
    this.name = "ProtocolError";
    this.details = details;
  }
}

export function createRunId() {
  return `run_${randomUUID()}`;
}

export function normalizeTaskRequest(input: unknown): TaskRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProtocolError("task request must be an object");
  }
  const value = input as JsonObject;
  if (typeof value.tool !== "string" || value.tool.trim() === "") {
    throw new ProtocolError("task request requires a non-empty tool");
  }
  const request: TaskRequest = {
    id: typeof value.id === "string" && value.id.trim() ? value.id : createRunId(),
    tool: (value.tool as string).trim(),
    input: value.input && typeof value.input === "object" && !Array.isArray(value.input) ? value.input as JsonObject : {},
    actor: typeof value.actor === "string" && value.actor.trim() ? value.actor.trim() : "local"
  };
  if (typeof value.reason === "string" && value.reason.trim()) request.reason = value.reason.trim();
  return request;
}

export function normalizeAuditEvent(input: unknown): AuditEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProtocolError("audit event must be an object");
  }
  const value = input as JsonObject;
  if (typeof value.runId !== "string" || value.runId.trim() === "") {
    throw new ProtocolError("audit event requires runId");
  }
  if (typeof value.type !== "string" || value.type.trim() === "") {
    throw new ProtocolError("audit event requires type");
  }
  const event: AuditEvent = {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    at: typeof value.at === "string" ? value.at : new Date().toISOString(),
    runId: value.runId,
    type: value.type,
    actor: typeof value.actor === "string" ? value.actor : "local"
  };
  if (typeof value.tool === "string") event.tool = value.tool;
  if (typeof value.capability === "string") event.capability = value.capability;
  if (typeof value.decision === "string") event.decision = value.decision;
  if (typeof value.message === "string") event.message = value.message;
  if (value.data && typeof value.data === "object" && !Array.isArray(value.data)) event.data = value.data as JsonObject;
  return event;
}
