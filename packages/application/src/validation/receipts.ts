import {
  APPLICATION_CONTRACT_VERSION,
  type ChannelDeliveryReceiptV1,
  type ExecutionReceiptV1
} from "../contracts.ts";
import { approvalState, uncertainty } from "./approval-uncertainty.ts";
import { finish } from "./canonical-json.ts";
import { principal, scope } from "./execution-context.ts";
import { invalid } from "./errors.ts";
import {
  enumValue,
  exactObject,
  identifier,
  reference,
  referenceList,
  sha256,
  timestamp,
  versionAndKind
} from "./json-safety.ts";
import { normalizedError } from "./normalized-execution-error.ts";

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

export function executionReceipt(input: unknown): ExecutionReceiptV1 {
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
