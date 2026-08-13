import {
  APPLICATION_CONTRACT_VERSION,
  type ExecutionResultV1
} from "../contracts.ts";
import { approvalState, uncertainty } from "./approval-uncertainty.ts";
import { canonicalJson, finish } from "./canonical-json.ts";
import { invalid } from "./errors.ts";
import {
  enumValue,
  exactObject,
  identifier,
  jsonValue,
  versionAndKind
} from "./json-safety.ts";
import { normalizedError } from "./normalized-execution-error.ts";
import { executionReceipt } from "./receipts.ts";

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
