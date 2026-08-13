import { createHash } from "node:crypto";
import {
  APPLICATION_CONTRACT_VERSION,
  MAX_APPLICATION_CONTRACT_BYTES,
  type ApplicationEnvelopeV1,
  type ApplicationPrincipalV1,
  type ApplicationScopeV1,
  type ApprovalStateV1,
  type ChannelDeliveryReceiptV1,
  type ExecutionContextV1,
  type ExecutionReceiptV1,
  type ExecutionRequestV1,
  type ExecutionResultV1,
  type ExecutionUncertaintyV1,
  type InboundEnvelopeV1,
  type JsonObject,
  type JsonValue,
  type NormalizedExecutionErrorV1,
  type OutboundEnvelopeV1
} from "./contracts.ts";
import {
  isAmbiguousApplicationMetadataKey,
  isSensitiveApplicationMetadataKey
} from "./sensitive-metadata.ts";

const MAX_ID_BYTES = 256;
const MAX_REFERENCE_BYTES = 2_048;
const MAX_STRING_BYTES = 65_536;
const MAX_LIST_ITEMS = 256;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 8_192;
const MAX_RETRY_AFTER_MS = 86_400_000;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SENSITIVE_VALUES = [
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|capability(?:[_-]?token)?|token|authorization|cookie|credentials?|password(?:[_-]?hash)?|passwd|secret|client[_-]?secret|bot[_-]?(?:secret|token)|private[_-]?key)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/iu,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/iu,
  /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/iu,
  /\b(?:gh[pousr]_|github_pat_|glpat-|npm_|xox[baprs]-)[A-Za-z0-9_-]{10,}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bAIza[A-Za-z0-9_-]{30,}\b/u,
  /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{16,}\b/u,
  /\b(?:sk|rk)(?:[_-](?:live|test))?[_-][A-Za-z0-9_-]{8,}\b/u,
  /\b(?:access|refresh|id|api|client|bot)[ _-]?(?:key|token|secret)\s*(?:is|[:=])?\s*[A-Za-z0-9._~+\/-]{8,}\b/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\b(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,})\b/u,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/iu,
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u
];

export class ApplicationContractValidationError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(message: string, code = "INVALID_APPLICATION_CONTRACT", path?: string) {
    super(message);
    this.name = "ApplicationContractValidationError";
    this.code = code;
    this.path = path;
  }
}

export function parseApplicationEnvelopeV1(source: string): ApplicationEnvelopeV1 {
  if (typeof source !== "string") throw invalid("application envelope source must be a JSON string");
  if (Buffer.byteLength(source, "utf8") > MAX_APPLICATION_CONTRACT_BYTES) {
    throw invalid(`application envelope exceeds ${MAX_APPLICATION_CONTRACT_BYTES} bytes`, "APPLICATION_CONTRACT_TOO_LARGE");
  }
  rejectDuplicateJsonObjectKeys(source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw invalid(`application envelope is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateApplicationEnvelopeV1(parsed);
}

export function validateApplicationEnvelopeV1(input: unknown): ApplicationEnvelopeV1 {
  const header = exactObject(input, "application envelope", ["kind"], { allowAdditional: true });
  switch (header.kind) {
    case "inbound": return validateInboundEnvelopeV1(input);
    case "outbound": return validateOutboundEnvelopeV1(input);
    case "channel-delivery-receipt": return validateChannelDeliveryReceiptV1(input);
    default: throw invalid("application envelope kind is not wire-admissible", "UNSUPPORTED_APPLICATION_ENVELOPE_KIND", "kind");
  }
}

export function validateInboundEnvelopeV1(input: unknown): InboundEnvelopeV1 {
  const value = exactObject(input, "inbound envelope", [
    "version", "kind", "envelopeId", "source", "sourceEventId", "receivedAt", "correlationId", "causationId",
    "identityClaims", "scopeClaims", "payload", "redactedMetadata"
  ]);
  versionAndKind(value, "inbound");
  const sourceValue = exactObject(value.source, "source", ["kind", "adapterId", "accountReference"]);
  const source = {
    kind: enumValue(sourceValue.kind, "source.kind", ["cli", "http", "channel", "job", "workflow", "event", "agent", "mcp"]),
    adapterId: identifier(sourceValue.adapterId, "source.adapterId"),
    ...(sourceValue.accountReference === undefined ? {} : { accountReference: reference(sourceValue.accountReference, "source.accountReference") })
  } as const;
  if (source.kind !== "cli" && value.sourceEventId === undefined) {
    throw invalid("sourceEventId is required for retryable or externally delivered ingress", "SOURCE_EVENT_ID_REQUIRED", "sourceEventId");
  }
  const identityValue = exactObject(value.identityClaims, "identityClaims", ["claimedSubject", "claimedTenant", "claimedProject"]);
  const scopeValue = exactObject(value.scopeClaims, "scopeClaims", ["claimedConversation", "claimedSession", "claimedThread"]);
  const envelope: InboundEnvelopeV1 = {
    version: APPLICATION_CONTRACT_VERSION,
    kind: "inbound",
    envelopeId: identifier(value.envelopeId, "envelopeId"),
    source,
    ...(value.sourceEventId === undefined ? {} : { sourceEventId: identifier(value.sourceEventId, "sourceEventId") }),
    receivedAt: timestamp(value.receivedAt, "receivedAt"),
    correlationId: identifier(value.correlationId, "correlationId"),
    ...(value.causationId === undefined ? {} : { causationId: identifier(value.causationId, "causationId") }),
    identityClaims: {
      ...(identityValue.claimedSubject === undefined ? {} : { claimedSubject: boundedString(identityValue.claimedSubject, "identityClaims.claimedSubject", MAX_ID_BYTES) }),
      ...(identityValue.claimedTenant === undefined ? {} : { claimedTenant: boundedString(identityValue.claimedTenant, "identityClaims.claimedTenant", MAX_ID_BYTES) }),
      ...(identityValue.claimedProject === undefined ? {} : { claimedProject: boundedString(identityValue.claimedProject, "identityClaims.claimedProject", MAX_ID_BYTES) })
    },
    scopeClaims: {
      ...(scopeValue.claimedConversation === undefined ? {} : { claimedConversation: boundedString(scopeValue.claimedConversation, "scopeClaims.claimedConversation", MAX_REFERENCE_BYTES) }),
      ...(scopeValue.claimedSession === undefined ? {} : { claimedSession: boundedString(scopeValue.claimedSession, "scopeClaims.claimedSession", MAX_REFERENCE_BYTES) }),
      ...(scopeValue.claimedThread === undefined ? {} : { claimedThread: boundedString(scopeValue.claimedThread, "scopeClaims.claimedThread", MAX_REFERENCE_BYTES) })
    },
    payload: jsonValue(value.payload, "payload"),
    ...(value.redactedMetadata === undefined ? {} : { redactedMetadata: jsonObject(value.redactedMetadata, "redactedMetadata", true) })
  };
  return finish(envelope);
}

export function validateExecutionRequestV1(input: unknown): ExecutionRequestV1 {
  const value = exactObject(input, "execution request", [
    "version", "kind", "requestId", "context", "operation", "input", "responseMode", "idempotencyKey", "approvalReference"
  ]);
  versionAndKind(value, "execution-request");
  const operation = exactObject(value.operation, "operation", ["kind", "id"]);
  const request: ExecutionRequestV1 = {
    version: APPLICATION_CONTRACT_VERSION,
    kind: "execution-request",
    requestId: identifier(value.requestId, "requestId"),
    context: executionContext(value.context),
    operation: {
      kind: enumValue(operation.kind, "operation.kind", ["query", "tool", "agent", "skill", "mcp-tool", "workflow-node"]),
      id: identifier(operation.id, "operation.id")
    },
    input: jsonValue(value.input, "input"),
    responseMode: enumValue(value.responseMode, "responseMode", ["sync", "async", "stream"]),
    ...(value.idempotencyKey === undefined ? {} : { idempotencyKey: identifier(value.idempotencyKey, "idempotencyKey") }),
    ...(value.approvalReference === undefined ? {} : { approvalReference: reference(value.approvalReference, "approvalReference") })
  };
  return finish(request);
}

export function validateExecutionResultV1(input: unknown): ExecutionResultV1 {
  const value = exactObject(input, "execution result", [
    "version", "kind", "requestId", "correlationId", "status", "approval", "uncertainty", "receipt", "output", "error"
  ]);
  versionAndKind(value, "execution-result");
  const result: ExecutionResultV1 = {
    version: APPLICATION_CONTRACT_VERSION,
    kind: "execution-result",
    requestId: identifier(value.requestId, "requestId"),
    correlationId: identifier(value.correlationId, "correlationId"),
    status: enumValue(value.status, "status", ["completed", "failed", "cancelled", "awaiting-approval", "needs-review", "denied"]),
    approval: approvalState(value.approval),
    uncertainty: uncertainty(value.uncertainty),
    receipt: executionReceipt(value.receipt),
    ...(value.output === undefined ? {} : { output: jsonValue(value.output, "output") }),
    ...(value.error === undefined ? {} : { error: normalizedError(value.error, "error") })
  };
  validateResultSemantics(result);
  if (result.requestId !== result.receipt.requestId || result.correlationId !== result.receipt.correlationId || result.status !== result.receipt.status) {
    throw invalid("execution result does not match its receipt", "RESULT_RECEIPT_MISMATCH");
  }
  if (canonicalJson(result.approval) !== canonicalJson(result.receipt.approval) || canonicalJson(result.uncertainty) !== canonicalJson(result.receipt.uncertainty)) {
    throw invalid("execution result approval or uncertainty does not match its receipt", "RESULT_RECEIPT_MISMATCH");
  }
  if ("operationDigest" in result.approval && result.approval.operationDigest !== result.receipt.operationDigest) {
    throw invalid("approval evidence does not match the receipt operation digest", "APPROVAL_BINDING_MISMATCH");
  }
  return finish(result);
}

export function validateOutboundEnvelopeV1(input: unknown): OutboundEnvelopeV1 {
  const value = exactObject(input, "outbound envelope", [
    "version", "kind", "envelopeId", "correlationId", "causationId", "destination", "payload", "replyToReference", "redactedMetadata"
  ]);
  versionAndKind(value, "outbound");
  const destination = exactObject(value.destination, "destination", ["transport", "accountReference", "conversationReference", "threadReference"]);
  return finish({
    version: APPLICATION_CONTRACT_VERSION,
    kind: "outbound",
    envelopeId: identifier(value.envelopeId, "envelopeId"),
    correlationId: identifier(value.correlationId, "correlationId"),
    ...(value.causationId === undefined ? {} : { causationId: identifier(value.causationId, "causationId") }),
    destination: {
      transport: identifier(destination.transport, "destination.transport"),
      ...(destination.accountReference === undefined ? {} : { accountReference: reference(destination.accountReference, "destination.accountReference") }),
      conversationReference: reference(destination.conversationReference, "destination.conversationReference"),
      ...(destination.threadReference === undefined ? {} : { threadReference: reference(destination.threadReference, "destination.threadReference") })
    },
    payload: jsonValue(value.payload, "payload"),
    ...(value.replyToReference === undefined ? {} : { replyToReference: reference(value.replyToReference, "replyToReference") }),
    ...(value.redactedMetadata === undefined ? {} : { redactedMetadata: jsonObject(value.redactedMetadata, "redactedMetadata", true) })
  } satisfies OutboundEnvelopeV1);
}

export function validateChannelDeliveryReceiptV1(input: unknown): ChannelDeliveryReceiptV1 {
  const value = exactObject(input, "channel delivery receipt", [
    "version", "kind", "envelopeId", "envelopeDigest", "correlationId", "status", "messageReferences", "uncertainty", "settledAt", "error"
  ]);
  versionAndKind(value, "channel-delivery-receipt");
  const receipt: ChannelDeliveryReceiptV1 = {
    version: APPLICATION_CONTRACT_VERSION,
    kind: "channel-delivery-receipt",
    envelopeId: identifier(value.envelopeId, "envelopeId"),
    envelopeDigest: sha256(value.envelopeDigest, "envelopeDigest"),
    correlationId: identifier(value.correlationId, "correlationId"),
    status: enumValue(value.status, "status", ["sent", "partial", "failed"]),
    messageReferences: referenceList(value.messageReferences, "messageReferences", true),
    uncertainty: uncertainty(value.uncertainty),
    settledAt: timestamp(value.settledAt, "settledAt"),
    ...(value.error === undefined ? {} : { error: normalizedError(value.error, "error") })
  };
  if (receipt.status === "sent" && (receipt.messageReferences.length === 0 || receipt.error !== undefined || receipt.uncertainty.state !== "none")) {
    throw invalid("sent delivery requires message evidence and no error", "INVALID_DELIVERY_RESULT");
  }
  if (receipt.status === "partial" && (receipt.messageReferences.length === 0 || receipt.error === undefined || receipt.error.retryable || receipt.uncertainty.state !== "needs-review")) {
    throw invalid("partial delivery requires message evidence, a non-retryable error, and needs-review uncertainty", "INVALID_DELIVERY_RESULT");
  }
  if (receipt.status === "failed" && (receipt.error === undefined || receipt.messageReferences.length !== 0)) {
    throw invalid("failed delivery requires a normalized error", "INVALID_DELIVERY_RESULT");
  }
  if (receipt.uncertainty.state === "needs-review" && receipt.error?.retryable !== false) {
    throw invalid("uncertain delivery cannot be marked retryable", "CONTRADICTORY_RETRY_SEMANTICS");
  }
  return finish(receipt);
}

export function canonicalizeApplicationContractV1(input: unknown): string {
  return canonicalJson(validateApplicationEnvelopeV1(input));
}

export function digestExecutionRequestV1(input: ExecutionRequestV1 | unknown): string {
  return createHash("sha256").update(canonicalJson(validateExecutionRequestV1(input)), "utf8").digest("hex");
}

/** Stable approval/idempotency binding that excludes the presented approval claim. */
export function digestExecutionOperationV1(input: ExecutionRequestV1 | unknown): string {
  const request = validateExecutionRequestV1(input);
  const { approvalReference: _approvalReference, ...operationRequest } = request;
  return createHash("sha256").update(canonicalJson(operationRequest), "utf8").digest("hex");
}

export function digestOutboundEnvelopeV1(input: OutboundEnvelopeV1 | unknown): string {
  return createHash("sha256").update(canonicalJson(validateOutboundEnvelopeV1(input)), "utf8").digest("hex");
}

export function assertChannelDeliveryReceiptMatchesEnvelopeV1(envelopeInput: unknown, receiptInput: unknown): void {
  const envelope = validateOutboundEnvelopeV1(envelopeInput);
  const receipt = validateChannelDeliveryReceiptV1(receiptInput);
  if (receipt.envelopeId !== envelope.envelopeId
    || receipt.correlationId !== envelope.correlationId
    || receipt.envelopeDigest !== digestOutboundEnvelopeV1(envelope)) {
    throw invalid("channel delivery receipt is not bound to the outbound envelope", "CHANNEL_RECEIPT_BINDING_MISMATCH");
  }
}

export function assertExecutionResultMatchesRequestV1(requestInput: unknown, resultInput: unknown): void {
  const request = validateExecutionRequestV1(requestInput);
  const result = validateExecutionResultV1(resultInput);
  const receipt = result.receipt;
  const mismatch = request.requestId !== receipt.requestId
    || request.context.correlationId !== receipt.correlationId
    || request.context.cancellationControlReference !== receipt.cancellationControlReference
    || canonicalJson(request.context.principal) !== canonicalJson(receipt.principal)
    || canonicalJson(request.context.scope) !== canonicalJson(receipt.scope)
    || canonicalJson(request.operation) !== canonicalJson(receipt.operation)
    || digestExecutionRequestV1(request) !== receipt.requestDigest
    || digestExecutionOperationV1(request) !== receipt.operationDigest;
  if (mismatch) throw invalid("execution receipt is not bound to the request", "EXECUTION_RECEIPT_BINDING_MISMATCH");
  const approvalDigest = "operationDigest" in receipt.approval ? receipt.approval.operationDigest : undefined;
  if (approvalDigest !== undefined && approvalDigest !== receipt.operationDigest) {
    throw invalid("approval evidence is not bound to the request digest", "APPROVAL_BINDING_MISMATCH");
  }
  if (receipt.approval.state === "consumed" && request.approvalReference !== receipt.approval.approvalReference) {
    throw invalid("consumed approval reference does not match the presented claim", "APPROVAL_REFERENCE_MISMATCH");
  }
  if ((receipt.approval.state === "expired" || receipt.approval.state === "denied")
    && receipt.approval.approvalReference !== undefined
    && request.approvalReference !== receipt.approval.approvalReference) {
    throw invalid("approval outcome does not match the presented claim", "APPROVAL_REFERENCE_MISMATCH");
  }
}

function executionContext(input: unknown): ExecutionContextV1 {
  const value = exactObject(input, "context", [
    "principal", "scope", "sourceReference", "correlationId", "causationId", "deadlineAt", "cancellationControlReference"
  ]);
  const context: ExecutionContextV1 = {
    principal: principal(value.principal),
    scope: scope(value.scope),
    sourceReference: reference(value.sourceReference, "context.sourceReference"),
    correlationId: identifier(value.correlationId, "context.correlationId"),
    ...(value.causationId === undefined ? {} : { causationId: identifier(value.causationId, "context.causationId") }),
    ...(value.deadlineAt === undefined ? {} : { deadlineAt: timestamp(value.deadlineAt, "context.deadlineAt") }),
    cancellationControlReference: reference(value.cancellationControlReference, "context.cancellationControlReference")
  };
  return context;
}

function principal(input: unknown): ApplicationPrincipalV1 {
  const value = exactObject(input, "principal", ["principalId", "actorId", "kind", "authenticationReference", "delegatedByPrincipalId"]);
  return {
    principalId: identifier(value.principalId, "principal.principalId"),
    actorId: identifier(value.actorId, "principal.actorId"),
    kind: enumValue(value.kind, "principal.kind", ["operator", "host-user", "channel-user", "automation", "agent", "system"]),
    ...(value.authenticationReference === undefined ? {} : { authenticationReference: reference(value.authenticationReference, "principal.authenticationReference") }),
    ...(value.delegatedByPrincipalId === undefined ? {} : { delegatedByPrincipalId: identifier(value.delegatedByPrincipalId, "principal.delegatedByPrincipalId") })
  };
}

function scope(input: unknown): ApplicationScopeV1 {
  const value = exactObject(input, "scope", ["tenantId", "projectId", "sessionId", "conversationId"]);
  return {
    tenantId: identifier(value.tenantId, "scope.tenantId"),
    ...(value.projectId === undefined ? {} : { projectId: identifier(value.projectId, "scope.projectId") }),
    ...(value.sessionId === undefined ? {} : { sessionId: identifier(value.sessionId, "scope.sessionId") }),
    ...(value.conversationId === undefined ? {} : { conversationId: identifier(value.conversationId, "scope.conversationId") })
  };
}

function executionReceipt(input: unknown): ExecutionReceiptV1 {
  const value = exactObject(input, "receipt", [
    "requestId", "requestDigest", "operationDigest", "executionEnvelopeReference", "executionEnvelopeDigest", "runId", "attemptId", "principal", "scope",
    "correlationId", "operation", "authorizationDecisionReferences", "auditReferences", "cancellationControlReference", "approval",
    "status", "uncertainty", "outputReference", "outputDigest", "errorCode", "admittedAt", "observedAt"
  ]);
  const operation = exactObject(value.operation, "receipt.operation", ["kind", "id"]);
  const receipt: ExecutionReceiptV1 = {
    requestId: identifier(value.requestId, "receipt.requestId"),
    requestDigest: sha256(value.requestDigest, "receipt.requestDigest"),
    operationDigest: sha256(value.operationDigest, "receipt.operationDigest"),
    ...(value.executionEnvelopeReference === undefined ? {} : { executionEnvelopeReference: reference(value.executionEnvelopeReference, "receipt.executionEnvelopeReference") }),
    ...(value.executionEnvelopeDigest === undefined ? {} : { executionEnvelopeDigest: sha256(value.executionEnvelopeDigest, "receipt.executionEnvelopeDigest") }),
    ...(value.runId === undefined ? {} : { runId: identifier(value.runId, "receipt.runId") }),
    ...(value.attemptId === undefined ? {} : { attemptId: identifier(value.attemptId, "receipt.attemptId") }),
    principal: principal(value.principal),
    scope: scope(value.scope),
    correlationId: identifier(value.correlationId, "receipt.correlationId"),
    operation: {
      kind: enumValue(operation.kind, "receipt.operation.kind", ["query", "tool", "agent", "skill", "mcp-tool", "workflow-node"]),
      id: identifier(operation.id, "receipt.operation.id")
    },
    authorizationDecisionReferences: referenceList(value.authorizationDecisionReferences, "receipt.authorizationDecisionReferences", false),
    auditReferences: referenceList(value.auditReferences, "receipt.auditReferences", false),
    cancellationControlReference: reference(value.cancellationControlReference, "receipt.cancellationControlReference"),
    approval: approvalState(value.approval),
    status: enumValue(value.status, "receipt.status", ["completed", "failed", "cancelled", "awaiting-approval", "needs-review", "denied"]),
    uncertainty: uncertainty(value.uncertainty),
    ...(value.outputReference === undefined ? {} : { outputReference: reference(value.outputReference, "receipt.outputReference") }),
    ...(value.outputDigest === undefined ? {} : { outputDigest: sha256(value.outputDigest, "receipt.outputDigest") }),
    ...(value.errorCode === undefined ? {} : { errorCode: identifier(value.errorCode, "receipt.errorCode") }),
    ...(value.admittedAt === undefined ? {} : { admittedAt: timestamp(value.admittedAt, "receipt.admittedAt") }),
    observedAt: timestamp(value.observedAt, "receipt.observedAt")
  };
  const paired = [receipt.executionEnvelopeReference, receipt.executionEnvelopeDigest, receipt.runId, receipt.attemptId];
  if (paired.some((item) => item !== undefined) && paired.some((item) => item === undefined)) {
    throw invalid("execution admission references, digest, run, and attempt must be present together", "INCOMPLETE_ADMISSION_EVIDENCE");
  }
  if ((receipt.outputReference === undefined) !== (receipt.outputDigest === undefined)) {
    throw invalid("output reference and digest must be present together", "INCOMPLETE_OUTPUT_EVIDENCE");
  }
  if (receipt.admittedAt !== undefined && receipt.admittedAt > receipt.observedAt) {
    throw invalid("receipt observedAt cannot precede admittedAt", "INVALID_RECEIPT_TIME");
  }
  const consequential = receipt.operation.kind !== "query";
  const admittedStatus = consequential && ["completed", "failed", "cancelled", "needs-review"].includes(receipt.status);
  if (admittedStatus && (receipt.admittedAt === undefined || receipt.executionEnvelopeReference === undefined)) {
    throw invalid("terminal execution receipt requires durable admission evidence", "MISSING_ADMISSION_EVIDENCE");
  }
  if (!admittedStatus && receipt.admittedAt !== undefined) {
    throw invalid("non-admitted result cannot contain execution admission evidence", "UNEXPECTED_ADMISSION_EVIDENCE");
  }
  if (!consequential && paired.some((item) => item !== undefined)) {
    throw invalid("read-only query receipt cannot contain execution admission evidence", "UNEXPECTED_ADMISSION_EVIDENCE");
  }
  if (!consequential && receipt.status === "needs-review") {
    throw invalid("read-only query cannot report an uncertain physical execution", "INVALID_EXECUTION_RESULT");
  }
  return receipt;
}

function approvalState(input: unknown): ApprovalStateV1 {
  const header = exactObject(input, "approval", ["state"], { allowAdditional: true });
  switch (header.state) {
    case "not-required": {
      exactObject(input, "approval", ["state"]);
      return { state: "not-required" };
    }
    case "pending": {
      const value = exactObject(input, "approval", ["state", "approvalReference", "operationDigest", "expiresAt"]);
      return { state: "pending", approvalReference: reference(value.approvalReference, "approval.approvalReference"), operationDigest: sha256(value.operationDigest, "approval.operationDigest"), expiresAt: timestamp(value.expiresAt, "approval.expiresAt") };
    }
    case "claimed":
    case "consumed": {
      const value = exactObject(input, "approval", ["state", "approvalReference", "operationDigest"]);
      return { state: header.state, approvalReference: reference(value.approvalReference, "approval.approvalReference"), operationDigest: sha256(value.operationDigest, "approval.operationDigest") };
    }
    case "denied":
    case "expired": {
      const value = exactObject(input, "approval", ["state", "approvalReference"]);
      return { state: header.state, ...(value.approvalReference === undefined ? {} : { approvalReference: reference(value.approvalReference, "approval.approvalReference") }) };
    }
    default: throw invalid("approval.state has an unsupported value", "INVALID_APPROVAL_STATE", "approval.state");
  }
}

function uncertainty(input: unknown): ExecutionUncertaintyV1 {
  const header = exactObject(input, "uncertainty", ["state"], { allowAdditional: true });
  if (header.state === "none") {
    exactObject(input, "uncertainty", ["state"]);
    return { state: "none" };
  }
  if (header.state === "needs-review") {
    const value = exactObject(input, "uncertainty", ["state", "reasonCode", "recoveryReference", "physicalExecutionPending", "retryAllowed"]);
    if (typeof value.physicalExecutionPending !== "boolean" || value.retryAllowed !== false) {
      throw invalid("needs-review uncertainty must explicitly forbid retry and declare physical execution state", "INVALID_EXECUTION_UNCERTAINTY");
    }
    return {
      state: "needs-review",
      reasonCode: identifier(value.reasonCode, "uncertainty.reasonCode"),
      recoveryReference: reference(value.recoveryReference, "uncertainty.recoveryReference"),
      physicalExecutionPending: value.physicalExecutionPending,
      retryAllowed: false
    };
  }
  throw invalid("uncertainty.state has an unsupported value", "INVALID_EXECUTION_UNCERTAINTY", "uncertainty.state");
}

function normalizedError(input: unknown, name: string): NormalizedExecutionErrorV1 {
  const value = exactObject(input, name, ["code", "message", "category", "retryable", "retryAfterMs", "redactedDetails"]);
  if (typeof value.retryable !== "boolean") throw invalid(`${name}.retryable must be a boolean`);
  const error: NormalizedExecutionErrorV1 = {
    code: identifier(value.code, `${name}.code`),
    message: safeString(value.message, `${name}.message`, 4_096),
    category: enumValue(value.category, `${name}.category`, ["authorization", "validation", "conflict", "cancelled", "dependency", "timeout", "internal"]),
    retryable: value.retryable,
    ...(value.retryAfterMs === undefined ? {} : { retryAfterMs: nonnegativeInteger(value.retryAfterMs, `${name}.retryAfterMs`, MAX_RETRY_AFTER_MS) }),
    ...(value.redactedDetails === undefined ? {} : { redactedDetails: jsonObject(value.redactedDetails, `${name}.redactedDetails`, true) })
  };
  if (!error.retryable && error.retryAfterMs !== undefined) throw invalid(`${name}.retryAfterMs requires retryable=true`);
  return error;
}

function validateResultSemantics(result: ExecutionResultV1): void {
  const admitted = result.receipt.admittedAt !== undefined;
  const consequential = result.receipt.operation.kind !== "query";
  const terminalApproval = result.approval.state === "not-required" || result.approval.state === "consumed";
  if ((result.error === undefined) !== (result.receipt.errorCode === undefined)) {
    throw invalid("normalized error and receipt error code must be present together", "INVALID_EXECUTION_RESULT");
  }
  if (result.error !== undefined && result.receipt.errorCode !== result.error.code) {
    throw invalid("normalized error does not match receipt error evidence", "INVALID_EXECUTION_RESULT");
  }
  if (result.uncertainty.state === "needs-review" && result.error?.retryable !== false && result.error !== undefined) {
    throw invalid("uncertain execution cannot be marked retryable", "CONTRADICTORY_RETRY_SEMANTICS");
  }
  switch (result.status) {
    case "completed":
      if (result.output === undefined || result.error !== undefined || result.uncertainty.state !== "none" || result.receipt.outputDigest === undefined || admitted !== consequential || !terminalApproval) {
        throw invalid("completed result requires output and evidence with no error or uncertainty", "INVALID_EXECUTION_RESULT");
      }
      break;
    case "failed":
      if (result.error === undefined || result.output !== undefined || result.uncertainty.state !== "none" || admitted !== consequential || !terminalApproval) {
        throw invalid("failed result requires a matching normalized error and no uncertainty", "INVALID_EXECUTION_RESULT");
      }
      break;
    case "cancelled":
      if (result.output !== undefined || result.uncertainty.state !== "none" || admitted !== consequential || !terminalApproval || (result.error !== undefined && result.error.category !== "cancelled")) {
        throw invalid("cancelled result cannot hide output or an uncertain physical outcome", "INVALID_EXECUTION_RESULT");
      }
      break;
    case "awaiting-approval":
      if (result.approval.state !== "pending" || result.output !== undefined || result.error !== undefined || result.uncertainty.state !== "none" || admitted) {
        throw invalid("awaiting-approval result requires pending approval and no execution outcome", "INVALID_EXECUTION_RESULT");
      }
      break;
    case "needs-review":
      if (result.uncertainty.state !== "needs-review" || result.output !== undefined || !consequential || !admitted || !terminalApproval) {
        throw invalid("needs-review result requires recovery evidence from an admitted execution", "INVALID_EXECUTION_RESULT");
      }
      break;
    case "denied":
      if ((result.approval.state !== "denied" && result.approval.state !== "expired") || result.error?.category !== "authorization" || result.output !== undefined || result.uncertainty.state !== "none" || admitted) {
        throw invalid("denied result requires authorization evidence without an executable attempt", "INVALID_EXECUTION_RESULT");
      }
      break;
  }
}

function jsonObject(input: unknown, name: string, rejectSensitive: boolean): JsonObject {
  const value = jsonValue(input, name, { rejectSensitive });
  if (value === null || Array.isArray(value) || typeof value !== "object") throw invalid(`${name} must be a JSON object`, undefined, name);
  return value as JsonObject;
}

function jsonValue(input: unknown, name: string, options: { rejectSensitive?: boolean } = {}): JsonValue {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, path: string, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw invalid(`${name} exceeds ${MAX_JSON_NODES} JSON nodes`, "APPLICATION_JSON_TOO_COMPLEX", path);
    if (depth > MAX_JSON_DEPTH) throw invalid(`${name} exceeds JSON depth ${MAX_JSON_DEPTH}`, "APPLICATION_JSON_TOO_DEEP", path);
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      const value = boundedString(current, path, MAX_STRING_BYTES, true);
      if (options.rejectSensitive && SENSITIVE_VALUES.some((pattern) => pattern.test(value))) throw invalid(`${path} contains secret-like material`, "UNREDACTED_APPLICATION_METADATA", path);
      return value;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Math.abs(current) > Number.MAX_SAFE_INTEGER) throw invalid(`${path} must be a finite safe number`, undefined, path);
      return current;
    }
    if (!current || typeof current !== "object") throw invalid(`${path} contains a non-JSON value`, undefined, path);
    if (seen.has(current)) throw invalid(`${path} contains a cycle`, "CYCLIC_APPLICATION_JSON", path);
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        const items = plainArrayValues(current, path);
        if (items.length > MAX_LIST_ITEMS) throw invalid(`${path} cannot contain more than ${MAX_LIST_ITEMS} items`, undefined, path);
        return items.map((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      }
      const value = exactObject(current, path, [], { allowAdditional: true });
      const output: Record<string, JsonValue> = {};
      const keys = Object.keys(value).sort();
      if (keys.length > MAX_LIST_ITEMS) throw invalid(`${path} cannot contain more than ${MAX_LIST_ITEMS} fields`, undefined, path);
      for (const key of keys) {
        if (RESERVED_KEYS.has(key)) throw invalid(`${path} contains reserved field ${key}`, "RESERVED_APPLICATION_FIELD", `${path}.${key}`);
        if (Buffer.byteLength(key, "utf8") > MAX_ID_BYTES) throw invalid(`${path} field name exceeds ${MAX_ID_BYTES} bytes`, undefined, `${path}.${key}`);
        if (options.rejectSensitive && isAmbiguousApplicationMetadataKey(key)) {
          throw invalid(`${path} contains an ambiguous metadata field`, "AMBIGUOUS_APPLICATION_METADATA_KEY", path);
        }
        if (options.rejectSensitive && isSensitiveApplicationMetadataKey(key) && value[key] !== "[redacted]") {
          throw invalid(`${path}.${key} is not permitted in redacted metadata`, "UNREDACTED_APPLICATION_METADATA", `${path}.${key}`);
        }
        output[key] = visit(value[key], `${path}.${key}`, depth + 1);
      }
      return output;
    } finally {
      seen.delete(current);
    }
  };
  return visit(input, name, 0);
}

function exactObject(
  input: unknown,
  name: string,
  allowedKeys: readonly string[],
  options: { allowAdditional?: boolean } = {}
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid(`${name} must be a plain object`, undefined, name);
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw invalid(`${name} must be a plain object`, "NON_PLAIN_APPLICATION_OBJECT", name);
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string")) throw invalid(`${name} cannot contain symbol fields`, "NON_JSON_APPLICATION_FIELD", name);
  const stringKeys = keys as string[];
  const allowed = new Set(allowedKeys);
  if (!options.allowAdditional) {
    const unknownKey = stringKeys.find((key) => !allowed.has(key));
    if (unknownKey !== undefined) throw invalid(`${name} contains unknown field: ${unknownKey}`, "UNKNOWN_APPLICATION_FIELD", `${name}.${unknownKey}`);
  }
  for (const key of stringKeys) {
    if (RESERVED_KEYS.has(key)) throw invalid(`${name} contains reserved field: ${key}`, "RESERVED_APPLICATION_FIELD", `${name}.${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid(`${name}.${key} must be an enumerable data field`, "NON_JSON_APPLICATION_FIELD", `${name}.${key}`);
  }
  return input as Record<string, unknown>;
}

function plainArrayValues(input: readonly unknown[], name: string): readonly unknown[] {
  if (Object.getPrototypeOf(input) !== Array.prototype) throw invalid(`${name} must be a plain array`, "NON_PLAIN_APPLICATION_OBJECT", name);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    throw invalid(`${name}.length must be a safe data field`, "NON_JSON_APPLICATION_FIELD", `${name}.length`);
  }
  const length = Number(lengthDescriptor.value);
  if (length > MAX_LIST_ITEMS) throw invalid(`${name} cannot contain more than ${MAX_LIST_ITEMS} items`, undefined, name);
  const keys = Reflect.ownKeys(input);
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key)) {
      throw invalid(`${name} cannot contain extra fields`, "NON_JSON_APPLICATION_FIELD", name);
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index >= length) {
      throw invalid(`${name} cannot contain an out-of-range numeric field`, "NON_JSON_APPLICATION_FIELD", `${name}.${key}`);
    }
  }
  const output = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor) throw invalid(`${name} cannot contain sparse entries`, "NON_JSON_APPLICATION_FIELD", `${name}[${index}]`);
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw invalid(`${name}[${index}] must be an enumerable data field`, "NON_JSON_APPLICATION_FIELD", `${name}[${index}]`);
    }
    output[index] = descriptor.value;
  }
  return output;
}

function referenceList(input: unknown, name: string, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(input)) throw invalid(`${name} must be an array`, undefined, name);
  const items = plainArrayValues(input, name);
  if (items.length > MAX_LIST_ITEMS || (!allowEmpty && items.length === 0)) throw invalid(`${name} has an invalid item count`, undefined, name);
  const values = items.map((item, index) => reference(item, `${name}[${index}]`));
  if (new Set(values).size !== values.length) throw invalid(`${name} cannot contain duplicate references`, undefined, name);
  return values;
}

function versionAndKind(value: Record<string, unknown>, kind: string): void {
  if (value.version !== APPLICATION_CONTRACT_VERSION) throw invalid(`unsupported application contract version: ${String(value.version)}`, "UNSUPPORTED_APPLICATION_CONTRACT_VERSION", "version");
  if (value.kind !== kind) throw invalid(`expected application contract kind ${kind}`, "UNSUPPORTED_APPLICATION_ENVELOPE_KIND", "kind");
}

function identifier(input: unknown, name: string): string {
  const value = boundedString(input, name, MAX_ID_BYTES);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)) throw invalid(`${name} contains unsupported characters`, undefined, name);
  return value;
}

function reference(input: unknown, name: string): string {
  const value = boundedString(input, name, MAX_REFERENCE_BYTES);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/u.test(value)) throw invalid(`${name} must be an opaque non-secret reference`, undefined, name);
  return value;
}

function sha256(input: unknown, name: string): string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input)) throw invalid(`${name} must be a lowercase SHA-256 digest`, undefined, name);
  return input;
}

function timestamp(input: unknown, name: string): string {
  const value = boundedString(input, name, 64);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) throw invalid(`${name} must be a canonical UTC ISO timestamp`, undefined, name);
  return value;
}

function boundedString(input: unknown, name: string, maxBytes: number, allowEmpty = false): string {
  if (typeof input !== "string" || (!allowEmpty && input.length === 0)) throw invalid(`${name} must be ${allowEmpty ? "a" : "a non-empty"} string`, undefined, name);
  if (input.trim() !== input && !allowEmpty) throw invalid(`${name} cannot have leading or trailing whitespace`, undefined, name);
  if (Buffer.byteLength(input, "utf8") > maxBytes) throw invalid(`${name} exceeds ${maxBytes} bytes`, undefined, name);
  return input;
}

function safeString(input: unknown, name: string, maxBytes: number): string {
  const value = boundedString(input, name, maxBytes);
  if (SENSITIVE_VALUES.some((pattern) => pattern.test(value))) throw invalid(`${name} contains secret-like material`, "UNREDACTED_APPLICATION_ERROR", name);
  return value;
}

function nonnegativeInteger(input: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(input) || Number(input) < 0 || Number(input) > maximum) throw invalid(`${name} must be a non-negative safe integer no greater than ${maximum}`, undefined, name);
  return Number(input);
}

function enumValue<const Value extends string>(input: unknown, name: string, values: readonly Value[]): Value {
  if (typeof input !== "string" || !values.includes(input as Value)) throw invalid(`${name} has an unsupported value`, undefined, name);
  return input as Value;
}

function canonicalJson(input: unknown): string {
  if (input === null || typeof input === "string" || typeof input === "boolean") return JSON.stringify(input);
  if (typeof input === "number") {
    if (!Number.isFinite(input) || Math.abs(input) > Number.MAX_SAFE_INTEGER) throw invalid("application contract contains an unsupported number");
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
  if (input && typeof input === "object") {
    const value = input as Record<string, unknown>;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw invalid("application contract contains a non-JSON value");
}

function finish<T>(input: T): T {
  const canonical = canonicalJson(input);
  if (Buffer.byteLength(canonical, "utf8") > MAX_APPLICATION_CONTRACT_BYTES) {
    throw invalid(`application contract exceeds ${MAX_APPLICATION_CONTRACT_BYTES} bytes`, "APPLICATION_CONTRACT_TOO_LARGE");
  }
  return deepFreeze(input);
}

function deepFreeze<T>(input: T): T {
  if (input && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}

function rejectDuplicateJsonObjectKeys(source: string): void {
  let offset = 0;
  const whitespace = /\s/u;
  const skipWhitespace = () => { while (offset < source.length && whitespace.test(source[offset]!)) offset += 1; };
  const readString = (): string => {
    const start = offset;
    if (source[offset] !== '"') throw invalid(`invalid JSON string at offset ${offset}`);
    offset += 1;
    while (offset < source.length) {
      const character = source[offset]!;
      if (character === '"') {
        offset += 1;
        try {
          const value = JSON.parse(source.slice(start, offset)) as unknown;
          if (typeof value !== "string") throw invalid(`invalid JSON string at offset ${start}`);
          return value;
        } catch (error) {
          if (error instanceof ApplicationContractValidationError) throw error;
          throw invalid(`invalid JSON string at offset ${start}`);
        }
      }
      if (character === "\\") offset += 1;
      offset += 1;
    }
    throw invalid(`unterminated JSON string at offset ${start}`);
  };
  const readValue = (): void => {
    skipWhitespace();
    const character = source[offset];
    if (character === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[offset] === "}") { offset += 1; return; }
      while (offset < source.length) {
        skipWhitespace();
        const key = readString();
        if (keys.has(key)) throw invalid(`duplicate JSON object field: ${key}`, "DUPLICATE_APPLICATION_FIELD");
        keys.add(key);
        skipWhitespace();
        if (source[offset] !== ":") throw invalid(`expected ':' at offset ${offset}`);
        offset += 1;
        readValue();
        skipWhitespace();
        if (source[offset] === "}") { offset += 1; return; }
        if (source[offset] !== ",") throw invalid(`expected ',' or '}' at offset ${offset}`);
        offset += 1;
      }
      throw invalid("unterminated JSON object");
    }
    if (character === "[") {
      offset += 1;
      skipWhitespace();
      if (source[offset] === "]") { offset += 1; return; }
      while (offset < source.length) {
        readValue();
        skipWhitespace();
        if (source[offset] === "]") { offset += 1; return; }
        if (source[offset] !== ",") throw invalid(`expected ',' or ']' at offset ${offset}`);
        offset += 1;
      }
      throw invalid("unterminated JSON array");
    }
    if (character === '"') { readString(); return; }
    const start = offset;
    while (offset < source.length && !/[\s,}\]]/u.test(source[offset]!)) offset += 1;
    if (start === offset) throw invalid(`invalid JSON value at offset ${offset}`);
    try { JSON.parse(source.slice(start, offset)) as unknown; } catch { throw invalid(`invalid JSON value at offset ${start}`); }
  };
  readValue();
  skipWhitespace();
  if (offset !== source.length) throw invalid(`unexpected JSON content at offset ${offset}`);
}

function invalid(message: string, code?: string, path?: string): ApplicationContractValidationError {
  return new ApplicationContractValidationError(message, code, path);
}
