import type {
  ApprovalStateV1,
  ExecutionUncertaintyV1
} from "../contracts.ts";
import { invalid } from "./errors.ts";
import {
  exactObject,
  identifier,
  reference,
  sha256,
  timestamp
} from "./json-safety.ts";

export function approvalState(input: unknown): ApprovalStateV1 {
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

export function uncertainty(input: unknown): ExecutionUncertaintyV1 {
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
