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
  "token",
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
const SECRET_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|capability(?:[_-]?token)?|token|authorization|cookie|credentials?|password(?:[_-]?hash)?|passwd|secret|client[_-]?secret|bot[_-]?(?:secret|token)|private[_-]?key)\s*([:=])\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu;
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

const WORKSPACE_CONTENT_TOOLS = new Set(["workspace.readText", "workspace.read", "workspace.search", "workspace.diff", "git.status", "git.diff", "git.log"]);
const WORKSPACE_MUTATION_TOOLS = new Set(["workspace.mutate", "workspace.patch"]);
const PROCESS_TOOLS = new Set(["process.exec"]);
const AGENT_TOOLS = new Set(["agent.run", "agent.delegate"]);
const SKILL_CATALOG_TOOLS = new Set(["skill.catalog"]);
const SKILL_HYDRATE_TOOLS = new Set(["skill.hydrate"]);
const SKILL_LIFECYCLE_TOOLS = new Set(["skill.install", "skill.lifecycle"]);
const MCP_DISCOVER_TOOLS = new Set(["mcp.discover"]);
const MCP_INVOKE_TOOLS = new Set(["mcp.invoke"]);
const EMAIL_TOOLS = new Set(["email.accounts", "email.search", "email.read", "email.thread"]);
const REPLAY_UNAVAILABLE_TOOLS = new Set(["computer.screen", ...EMAIL_TOOLS]);

export function isWorkspaceContentTool(toolName: unknown): boolean {
  return typeof toolName === "string" && WORKSPACE_CONTENT_TOOLS.has(toolName);
}

export function isEmailTool(toolName: unknown): boolean {
  return typeof toolName === "string" && EMAIL_TOOLS.has(toolName);
}

export function isReplayUnavailableTool(toolName: unknown): boolean {
  return typeof toolName === "string" && REPLAY_UNAVAILABLE_TOOLS.has(toolName);
}

/**
 * Remove workspace content-bearing request fields before durable persistence.
 * The live request remains unchanged for first dispatch; only this projection
 * may cross audit, ledger, or runtime-job persistence boundaries.
 */
export function projectDurableToolInput(toolName: string, input: unknown): unknown {
  if (WORKSPACE_MUTATION_TOOLS.has(toolName)) return projectMutationPayload(input);
  if (PROCESS_TOOLS.has(toolName)) return projectProcessInput(input);
  if (AGENT_TOOLS.has(toolName)) return projectAgentInput(input, toolName === "agent.delegate");
  if (SKILL_CATALOG_TOOLS.has(toolName)) return {};
  if (SKILL_HYDRATE_TOOLS.has(toolName)) return projectSkillHydrateInput(input);
  if (SKILL_LIFECYCLE_TOOLS.has(toolName)) return projectSkillLifecycleInput(input);
  if (MCP_DISCOVER_TOOLS.has(toolName)) return projectMcpDiscoverInput(input);
  if (MCP_INVOKE_TOOLS.has(toolName)) return projectMcpInvokeInput(input);
  if (EMAIL_TOOLS.has(toolName)) return projectEmailInput(input);
  if (toolName.startsWith("git.")) return projectGitInput(input);
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
  if (PROCESS_TOOLS.has(toolName)) return projectProcessOutput(output);
  if (AGENT_TOOLS.has(toolName)) return projectAgentOutput(output, toolName === "agent.delegate");
  if (SKILL_CATALOG_TOOLS.has(toolName)) return projectSkillCatalogOutput(output);
  if (SKILL_HYDRATE_TOOLS.has(toolName)) return projectSkillHydrateOutput(output);
  if (SKILL_LIFECYCLE_TOOLS.has(toolName)) return projectSkillLifecycleOutput(output);
  if (MCP_DISCOVER_TOOLS.has(toolName)) return projectMcpDiscoverOutput(output);
  if (MCP_INVOKE_TOOLS.has(toolName)) return projectMcpInvokeOutput(output);
  if (EMAIL_TOOLS.has(toolName)) return projectEmailOutput(toolName, output);
  if (toolName.startsWith("git.")) return projectGitOutput(toolName, output);
  if (REPLAY_UNAVAILABLE_TOOLS.has(toolName)) return projectComputerScreenOutput(output);
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

function projectGitInput(input: unknown): JsonObject {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const source = input as JsonObject;
  const projected: JsonObject = {};
  for (const key of ["path", "ref"] as const) {
    if (typeof source[key] === "string") {
      projected[`${key}Digest`] = sha256Reference(source[key]);
      projected[`${key}Bytes`] = Buffer.byteLength(source[key], "utf8");
    }
  }
  for (const key of ["limit", "maxBytes", "staged"] as const) {
    if (typeof source[key] === "number" || typeof source[key] === "boolean") projected[key] = source[key];
  }
  return projected;
}

function projectGitOutput(toolName: string, output: unknown): JsonObject {
  if (!output || typeof output !== "object" || Array.isArray(output)) return {};
  const record = output as JsonObject;
  const common = pickWorkspaceMetadata(record, ["type", "repositoryId", "worktreeId", "headState", "headOid", "truncated"]);
  if (toolName === "git.status") {
    return { ...common, entryCount: Array.isArray(record.entries) ? record.entries.length : 0 };
  }
  if (toolName === "git.diff") {
    return { ...common, ...pickWorkspaceMetadata(record, ["patchBytes", "patchDigest", "digestComplete", "staged"]) };
  }
  return { ...common, commitCount: Array.isArray(record.commits) ? record.commits.length : 0 };
}

function projectComputerScreenOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { type: "computer.screen", contentUnavailableOnReplay: true };
  const record = value as JsonObject;
  const target = record.target && typeof record.target === "object" && !Array.isArray(record.target) ? record.target as JsonObject : {};
  const projected: JsonObject = {
    type: "computer.screen",
    contentUnavailableOnReplay: true
  };
  for (const key of ["frameId", "capturedAt"] as const) {
    if (typeof record[key] === "string" && record[key].length <= 256) projected[key] = record[key];
  }
  const nodeId = typeof target.nodeId === "string" && target.nodeId.length <= 128 ? target.nodeId : undefined;
  const displayId = typeof target.displayId === "string" && target.displayId.length <= 128 ? target.displayId : undefined;
  if (nodeId !== undefined && displayId !== undefined) projected.target = { nodeId, displayId };
  for (const key of ["width", "height"] as const) {
    if (Number.isSafeInteger(record[key]) && Number(record[key]) > 0) projected[key] = record[key];
  }
  if (record.mimeType === "image/png" || record.mimeType === "image/jpeg") projected.mimeType = record.mimeType;
  if (typeof record.imageBase64 === "string") {
    projected.imageDigest = sha256Reference(record.imageBase64);
    projected.imageBytes = Buffer.byteLength(record.imageBase64, "base64");
  }
  return projected;
}

function boundedEmailString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximum ? value : undefined;
}

const EMAIL_IDENTIFIER_MAX_BYTES = 256;
const EMAIL_IDENTIFIER_CONTEXT = "odinn:email-provider-identifier:";
const OPAQUE_EMAIL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/u;

/**
 * Hash a provider identifier for durable use. Callers should normally use
 * durableEmailProviderIdentifier(), which preserves existing opaque IDs and
 * hashes identifiers that do not satisfy the opaque provider-reference form.
 */
export function hashEmailProviderIdentifier(value: unknown, label = "email provider identifier", maximum = EMAIL_IDENTIFIER_MAX_BYTES): string {
  if (typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a bounded visible provider identifier`);
  }
  return sha256Reference(`${EMAIL_IDENTIFIER_CONTEXT}${value}`);
}

/**
 * Keep the established durable projection for opaque provider references,
 * while preventing address-shaped or otherwise non-opaque identifiers from
 * crossing the persistence boundary in cleartext.
 */
export function durableEmailProviderIdentifier(value: unknown, label = "email provider identifier", maximum = EMAIL_IDENTIFIER_MAX_BYTES): string {
  const validated = typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
  if (validated === undefined) return hashEmailProviderIdentifier(value, label, maximum);
  return OPAQUE_EMAIL_IDENTIFIER.test(validated) ? validated : hashEmailProviderIdentifier(validated, label, maximum);
}

function hasOwn(record: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function projectEmailInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as JsonObject;
  const projected: JsonObject = {};
  for (const key of ["accountId", "messageId", "threadId"] as const) {
    if (hasOwn(source, key)) projected[key] = durableEmailProviderIdentifier(source[key], `email input ${key}`);
  }
  if (Number.isSafeInteger(source.limit)) projected.limit = source.limit;
  for (const [sourceKey, digestKey] of [["query", "queryDigest"], ["cursor", "cursorDigest"]] as const) {
    const raw = boundedEmailString(source[sourceKey], 4_096);
    const existingDigest = boundedEmailString(source[digestKey], 128);
    if (raw !== undefined) {
      projected[digestKey] = sha256Reference(raw);
      projected[`${sourceKey}Bytes`] = Buffer.byteLength(raw, "utf8");
    } else if (existingDigest !== undefined) {
      projected[digestKey] = existingDigest;
      if (Number.isSafeInteger(source[`${sourceKey}Bytes`])) projected[`${sourceKey}Bytes`] = source[`${sourceKey}Bytes`];
    }
  }
  return projected;
}

function projectEmailMessageMetadata(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as JsonObject;
  const projected: JsonObject = {};
  if (hasOwn(record, "messageId")) projected.messageId = durableEmailProviderIdentifier(record.messageId, "email message.messageId");
  if (hasOwn(record, "threadId")) projected.threadId = durableEmailProviderIdentifier(record.threadId, "email message.threadId");
  const receivedAt = boundedEmailString(record.receivedAt, 256);
  if (receivedAt !== undefined) projected.receivedAt = receivedAt;
  for (const [sourceKey, digestKey] of [["subject", "subjectDigest"], ["from", "fromDigest"], ["snippet", "snippetDigest"], ["bodyText", "bodyDigest"]] as const) {
    const raw = boundedEmailString(record[sourceKey], 128 * 1024);
    if (raw !== undefined) {
      projected[digestKey] = sha256Reference(raw);
      projected[`${sourceKey}Bytes`] = Buffer.byteLength(raw, "utf8");
    }
  }
  if (typeof record.hasAttachments === "boolean") projected.hasAttachments = record.hasAttachments;
  if (Array.isArray(record.to)) projected.toCount = record.to.length;
  if (Array.isArray(record.cc)) projected.ccCount = record.cc.length;
  if (Array.isArray(record.attachments)) projected.attachmentCount = record.attachments.length;
  return projected;
}

function projectEmailOutput(toolName: string, value: unknown): unknown {
  const base: JsonObject = { type: toolName, contentUnavailableOnReplay: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  const record = value as JsonObject;
  for (const key of ["providerId", "accountId", "threadId"] as const) {
    if (hasOwn(record, key)) base[key] = durableEmailProviderIdentifier(record[key], `email ${toolName} output.${key}`);
  }
  if (typeof record.contentTrust === "string" && record.contentTrust.length <= 64) base.contentTrust = record.contentTrust;
  if (toolName === "email.accounts") {
    const health = record.health && typeof record.health === "object" && !Array.isArray(record.health) ? record.health as JsonObject : {};
    if (typeof health.status === "string" && health.status.length <= 32) base.health = { status: health.status };
    const accounts = Array.isArray(record.accounts) ? record.accounts.slice(0, 32).flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const account = value as JsonObject;
      if (!hasOwn(account, "accountId")) return [];
      const accountId = durableEmailProviderIdentifier(account.accountId, "email account.accountId");
      const provider = boundedEmailString(account.provider, 128);
      const status = boundedEmailString(account.status, 32);
      return [{ accountId, ...(provider === undefined ? {} : { provider }), ...(status === undefined ? {} : { status }) }];
    }) : [];
    base.accounts = accounts;
    base.accountCount = accounts.length;
  } else if (toolName === "email.search") {
    const nextCursor = boundedEmailString(record.nextCursor, 4_096);
    if (nextCursor !== undefined) {
      base.nextCursorDigest = sha256Reference(nextCursor);
      base.nextCursorBytes = Buffer.byteLength(nextCursor, "utf8");
    }
    const messages = Array.isArray(record.messages) ? record.messages.slice(0, 100).map(projectEmailMessageMetadata) : [];
    base.messages = messages;
    base.messageCount = messages.length;
  } else if (toolName === "email.read") {
    Object.assign(base, projectEmailMessageMetadata(record));
  } else if (toolName === "email.thread") {
    const messages = Array.isArray(record.messages) ? record.messages.slice(0, 100).map(projectEmailMessageMetadata) : [];
    base.messages = messages;
    base.messageCount = messages.length;
  }
  return base;
}

function sha256Reference(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function projectSkillHydrateInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const id = boundedSkillString((value as JsonObject).id, 64);
  return id === undefined ? {} : { id };
}

function projectSkillLifecycleInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as JsonObject;
  const projected: JsonObject = {};
  for (const key of ["skillId", "action", "version", "integrity", "requestDigest", "approvalId"] as const) {
    const item = boundedSkillString(input[key], key === "integrity" || key === "requestDigest" ? 128 : 256);
    if (item !== undefined) projected[key] = item;
  }
  if (Object.keys(projected).length === 0) projected.manifestDigest = sha256Reference(JSON.stringify(value));
  return projected;
}

function projectSkillCatalogOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as JsonObject;
  const rawEntries = Array.isArray(record.entries) ? record.entries : [];
  const entries = rawEntries.slice(0, 128).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const entry = item as JsonObject;
    const id = boundedSkillString(entry.id, 64);
    const version = boundedSkillString(entry.version, 128);
    const name = boundedSkillString(entry.name, 120);
    const description = boundedSkillString(entry.description, 64 * 1024);
    if (id === undefined || version === undefined || name === undefined) return [];
    return [{
      id,
      version,
      name,
      ...(description === undefined ? {} : { descriptionDigest: sha256Reference(description), descriptionBytes: Buffer.byteLength(description, "utf8") }),
      requestedTools: boundedSkillList(entry.requestedTools),
      requestedCapabilities: boundedSkillList(entry.requestedCapabilities)
    }];
  });
  return { ...(typeof record.type === "string" ? { type: record.type } : {}), count: entries.length, entries };
}

function projectSkillHydrateOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as JsonObject;
  const result: JsonObject = {};
  for (const key of ["id", "version", "name", "integrity"] as const) {
    const item = boundedSkillString(record[key], 256);
    if (item !== undefined) result[key] = item;
  }
  const description = boundedSkillString(record.description, 64 * 1024);
  const markdown = boundedSkillString(record.skillMarkdown ?? record.content, 256 * 1024);
  if (description !== undefined) {
    result.descriptionDigest = sha256Reference(description);
    result.descriptionBytes = Buffer.byteLength(description, "utf8");
  }
  if (markdown !== undefined) {
    result.skillMarkdownDigest = sha256Reference(markdown);
    result.skillMarkdownBytes = Buffer.byteLength(markdown, "utf8");
  }
  result.requestedTools = boundedSkillList(record.requestedTools);
  result.requestedCapabilities = boundedSkillList(record.requestedCapabilities);
  return result;
}

function projectSkillLifecycleOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as JsonObject;
  const projected = projectSkillLifecycleInput({ ...record, skillId: record.skillId ?? record.id }) as JsonObject;
  for (const key of ["type", "status", "trusted", "expiresInSeconds"] as const) {
    if (typeof record[key] === "string" || typeof record[key] === "boolean" || typeof record[key] === "number") projected[key] = record[key];
  }
  if (record.skill && typeof record.skill === "object" && !Array.isArray(record.skill)) {
    const skill = record.skill as JsonObject;
    projected.skill = projectSkillLifecycleInput({ ...skill, skillId: skill.skillId ?? skill.id });
  }
  return projected;
}

function projectMcpDiscoverInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as JsonObject;
  const projected: JsonObject = {};
  if (typeof input.serverId === "string" && input.serverId.length <= 64) projected.serverId = input.serverId;
  if (typeof input.refresh === "boolean") projected.refresh = input.refresh;
  return projected;
}

function projectMcpInvokeInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as JsonObject;
  const projected: JsonObject = {};
  for (const key of ["serverId", "snapshotFingerprint", "extensionFingerprint", "toolName", "toolSchemaFingerprint"] as const) {
    if (typeof input[key] === "string" && input[key].length <= 256) projected[key] = input[key];
  }
  for (const key of ["generation", "timeoutMs"] as const) {
    if (Number.isSafeInteger(input[key])) projected[key] = input[key];
  }
  if (input.arguments !== undefined) {
    const encoded = JSON.stringify(input.arguments) ?? "null";
    projected.argumentsDigest = sha256Reference(encoded);
    projected.argumentsBytes = Buffer.byteLength(encoded, "utf8");
  }
  return projected;
}

function projectMcpDiscoverOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = value as JsonObject;
  const projected: JsonObject = {};
  for (const key of ["type", "serverId", "fingerprint", "extensionFingerprint"] as const) {
    if (typeof output[key] === "string" && output[key].length <= 256) projected[key] = output[key];
  }
  for (const key of ["generation", "discoveredAtMs", "expiresAtMs", "staleUntilMs"] as const) {
    if (Number.isSafeInteger(output[key])) projected[key] = output[key];
  }
  const tools = Array.isArray(output.tools) ? output.tools : [];
  projected.toolCount = tools.length;
  projected.tools = tools.slice(0, 128).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const tool = item as JsonObject;
    return typeof tool.name === "string" && typeof tool.schemaFingerprint === "string"
      ? [{ name: tool.name, schemaFingerprint: tool.schemaFingerprint }]
      : [];
  });
  return projected;
}

function projectMcpInvokeOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = value as JsonObject;
  const projected: JsonObject = {};
  for (const key of ["status", "callId", "requestDigest", "argumentDigest", "resultRef", "resultDigest", "authorizationRef", "auditRef", "errorCode"] as const) {
    if (typeof output[key] === "string" && output[key].length <= 256) projected[key] = output[key];
  }
  if (output.status === "needs-review") projected.physicalPending = true;
  return projected;
}

function boundedSkillString(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes <= maxBytes ? value : undefined;
}

function boundedSkillList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 128).flatMap((item) => {
    const text = boundedSkillString(item, 256);
    return text === undefined ? [] : [text];
  });
}

function projectProcessInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as JsonObject;
  const projected: JsonObject = {};
  const command = boundedProcessString(input.command, 4_096);
  if (command !== undefined) {
    projected.commandDigest = sha256Reference(command);
    projected.commandBytes = Buffer.byteLength(command, "utf8");
  }
  const args = boundedProcessArgs(input.args);
  if (args !== undefined) {
    projected.argsDigest = sha256Reference(JSON.stringify(args));
    projected.argsCount = args.length;
    projected.argsBytes = args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0);
  }
  const cwd = boundedProcessString(input.cwd, 4_096);
  if (cwd !== undefined) projected.cwd = cwd;
  const timeoutMs = boundedProcessInteger(input.timeoutMs, 1, 86_400_000);
  if (timeoutMs !== undefined) projected.timeoutMs = timeoutMs;
  const maxOutputBytes = boundedProcessInteger(input.maxOutputBytes, 1, 16 * 1024 * 1024);
  if (maxOutputBytes !== undefined) projected.maxOutputBytes = maxOutputBytes;
  return projected;
}

function projectProcessOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = value as JsonObject;
  const projected: JsonObject = {};
  const command = boundedProcessString(output.command, 4_096);
  if (command !== undefined) {
    projected.commandDigest = sha256Reference(command);
    projected.commandBytes = Buffer.byteLength(command, "utf8");
  }
  const args = boundedProcessArgs(output.args);
  if (args !== undefined) {
    projected.argsDigest = sha256Reference(JSON.stringify(args));
    projected.argsCount = args.length;
  }
  const cwd = boundedProcessString(output.cwd, 4_096);
  if (cwd !== undefined) projected.cwd = cwd;
  const exitCode = boundedProcessInteger(output.exitCode, -32_768, 32_768);
  if (exitCode !== undefined) projected.exitCode = exitCode;
  const signal = boundedProcessString(output.signal, 64);
  if (signal !== undefined) projected.signal = signal;
  for (const key of ["stdoutBytes", "stderrBytes"] as const) {
    const bytes = boundedProcessInteger(output[key], 0, 16 * 1024 * 1024);
    if (bytes !== undefined) projected[key] = bytes;
  }
  for (const key of ["timedOut", "outputTruncated"] as const) {
    if (typeof output[key] === "boolean") projected[key] = output[key];
  }
  const durationMs = boundedProcessInteger(output.durationMs, 0, 86_400_000);
  if (durationMs !== undefined) projected.durationMs = durationMs;
  for (const key of ["stdout", "stderr"] as const) {
    const text = boundedProcessString(output[key], 16 * 1024 * 1024);
    if (text !== undefined) {
      projected[`${key}Digest`] = sha256Reference(text);
      projected[`${key}Bytes`] = Buffer.byteLength(text, "utf8");
    }
  }
  return projected;
}

const AGENT_MESSAGE_ROLES = new Set(["system", "user", "assistant"]);
const AGENT_INPUT_REFERENCE = /^(?:input|artifact|memory):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const AGENT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const AGENT_FORBIDDEN_IDENTITY = /(?:token|secret|auth|credential|approval)/iu;
const MAX_AGENT_PROJECTED_TEXT_BYTES = 256 * 1024;

function boundedAgentText(value: unknown, maxBytes: number): string | undefined {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function boundedAgentIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && AGENT_IDENTIFIER.test(value) && !AGENT_FORBIDDEN_IDENTITY.test(value)
    ? value
    : undefined;
}

function boundedAgentPrincipalReference(value: unknown): string | undefined {
  return boundedAgentIdentifier(value) === undefined ? undefined : sha256Reference(String(value));
}

function boundedAgentInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : undefined;
}

function copyAgentField(
  projected: JsonObject,
  key: string,
  value: unknown,
  validate: (candidate: unknown) => string | number | boolean | undefined
): void {
  if (value === undefined) return;
  const safe = validate(value);
  if (safe === undefined) projected[`${key}Invalid`] = true;
  else projected[key] = safe;
}

function projectAgentInput(value: unknown, delegation: boolean): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as JsonObject;
  const projected: JsonObject = {};
  copyAgentField(projected, "model", input.model, (candidate) => boundedAgentText(candidate, 256));
  copyAgentField(projected, "maxTurns", input.maxTurns, (candidate) => boundedAgentInteger(candidate, 1, 4));
  copyAgentField(projected, "maxTokens", input.maxTokens, (candidate) => boundedAgentInteger(candidate, 1, 4_096));
  copyAgentField(projected, "sessionId", input.sessionId, (candidate) => boundedAgentText(candidate, 256));
  copyAgentField(projected, "projectId", input.projectId, (candidate) => boundedAgentText(candidate, 256));
  copyAgentField(projected, "reasoningBudgetRecovery", input.reasoningBudgetRecovery, (candidate) => typeof candidate === "boolean" ? candidate : undefined);
  copyAgentField(projected, "principalNamespace", input.principalNamespace, boundedAgentPrincipalReference);
  copyAgentField(projected, "maxConcurrency", input.maxConcurrency, (candidate) => boundedAgentInteger(candidate, 1, 1));
  copyAgentField(projected, "maxRunMs", input.maxRunMs, (candidate) => boundedAgentInteger(candidate, 1, 300_000));
  const prompt = boundedAgentText(input.prompt, MAX_AGENT_PROJECTED_TEXT_BYTES);
  if (prompt !== undefined) {
    projected.promptDigest = sha256Reference(prompt);
    projected.promptBytes = Buffer.byteLength(prompt, "utf8");
  } else if (input.prompt !== undefined) {
    projected.promptInvalid = true;
  }
  if (Array.isArray(input.messages)) {
    projected.messages = input.messages.slice(0, 128).map((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return { invalid: true };
      const record = message as JsonObject;
      if (typeof record.role !== "string" || !AGENT_MESSAGE_ROLES.has(record.role)) return { invalid: true };
      const result: JsonObject = { role: record.role };
      const content = boundedAgentText(record.content, MAX_AGENT_PROJECTED_TEXT_BYTES);
      if (content !== undefined) {
        result.contentDigest = sha256Reference(content);
        result.contentBytes = Buffer.byteLength(content, "utf8");
      } else if (record.content !== undefined) {
        result.contentInvalid = true;
      }
      return result;
    });
    if (input.messages.length > 128) projected.messagesTruncated = true;
  } else if (input.messages !== undefined) {
    projected.messagesInvalid = true;
  }
  if (delegation) {
    for (const key of ["graph", "manifests"] as const) {
      const value = input[key];
      if (typeof value === "string") {
        projected[`${key}InputDigest`] = sha256Reference(value);
        projected[`${key}InputBytes`] = Buffer.byteLength(value, "utf8");
      } else if (value !== undefined) {
        projected[`${key}InputInvalid`] = true;
      }
    }
    if (input.inputs && typeof input.inputs === "object" && !Array.isArray(input.inputs)) {
      const entries = Object.entries(input.inputs as JsonObject);
      const safeInputs: Record<string, unknown> = {};
      for (const [reference, child] of entries.slice(0, 128)) {
        if (AGENT_INPUT_REFERENCE.test(reference)) safeInputs[reference] = projectAgentInput(child, false);
        else projected.inputsInvalid = true;
      }
      if (entries.length > 128) projected.inputsTruncated = true;
      projected.inputs = safeInputs;
    } else if (input.inputs !== undefined) {
      projected.inputsInvalid = true;
    }
  }
  return projected;
}

function projectAgentOutput(value: unknown, delegation: boolean): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = value as JsonObject;
  if (delegation) {
    const report: JsonObject = {};
    copyAgentField(report, "graphRunId", output.graphRunId, boundedAgentIdentifier);
    copyAgentField(report, "principalNamespace", output.principalNamespace, boundedAgentPrincipalReference);
    copyAgentField(report, "graphDigest", output.graphDigest, (candidate) => typeof candidate === "string" && /^[a-f0-9]{64}$/u.test(candidate) ? candidate : undefined);
    copyAgentField(report, "status", output.status, (candidate) => typeof candidate === "string" && ["completed", "failed", "cancelled", "needs-review"].includes(candidate) ? candidate : undefined);
    copyAgentField(report, "pendingPhysicalDispatches", output.pendingPhysicalDispatches, (candidate) => boundedAgentInteger(candidate, 0, 32));
    if (Array.isArray(output.nodes)) {
      report.nodes = output.nodes.slice(0, 32).map((node) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return { invalid: true };
        const record = node as JsonObject;
        const projected: JsonObject = {};
        copyAgentField(projected, "nodeId", record.nodeId, boundedAgentIdentifier);
        copyAgentField(projected, "status", record.status, (candidate) => typeof candidate === "string" && ["completed", "failed", "cancelled", "needs-review", "blocked"].includes(candidate) ? candidate : undefined);
        copyAgentField(projected, "nodeCallId", record.nodeCallId, boundedAgentIdentifier);
        for (const key of ["requestDigest", "resultDigest"] as const) {
          copyAgentField(projected, key, record[key], (candidate) => typeof candidate === "string" && /^[a-f0-9]{64}$/u.test(candidate) ? candidate : undefined);
        }
        copyAgentField(projected, "auditRef", record.auditRef, (candidate) => typeof candidate === "string" && /^audit:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate) ? candidate : undefined);
        copyAgentField(projected, "resultRef", record.resultRef, (candidate) => typeof candidate === "string" && /^(?:input|result|artifact|memory):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(candidate) ? candidate : undefined);
        copyAgentField(projected, "errorCode", record.errorCode, (candidate) => typeof candidate === "string" && /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/u.test(candidate) ? candidate : undefined);
        return projected;
      });
      if (output.nodes.length > 32) report.nodesTruncated = true;
    } else if (output.nodes !== undefined) {
      report.nodesInvalid = true;
    }
    return report;
  }
  const projected: JsonObject = {};
  if (typeof output.content === "string") {
    projected.contentDigest = sha256Reference(output.content);
    projected.contentBytes = Buffer.byteLength(output.content, "utf8");
  }
  for (const key of ["provider", "model", "usage", "answerShape", "memory", "modelRecovery"] as const) {
    if (output[key] !== undefined) projected[key] = redactDurableValue(output[key]);
  }
  if (output.pendingApproval && typeof output.pendingApproval === "object") {
    const approval = output.pendingApproval as JsonObject;
    projected.pendingApproval = { type: approval.type, tool: approval.tool, expiresInSeconds: approval.expiresInSeconds };
  }
  return projected;
}

function boundedProcessString(value: unknown, maxBytes: number): string | undefined {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function boundedProcessArgs(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 256 || value.some((arg) => boundedProcessString(arg, 64 * 1024) === undefined)) return undefined;
  const args = value as string[];
  return args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0) <= 16 * 1024 * 1024 ? args : undefined;
}

function boundedProcessInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : undefined;
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
      const processCommandValue = toolName === "process.exec" && isInput && key === "command";
      const processArgumentValue = toolName === "process.exec" && isInput && key === "args";
      if (browserTypeValue || processCommandValue || (markedSensitive && key === "value")) return [key, REDACTED];
      if (processArgumentValue) return [key, [REDACTED]];
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

export * from "./workflow.ts";
