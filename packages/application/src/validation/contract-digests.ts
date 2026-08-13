import { createHash } from "node:crypto";
import type {
  ExecutionRequestV1,
  OutboundEnvelopeV1
} from "../contracts.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  validateApplicationEnvelopeV1,
  validateOutboundEnvelopeV1
} from "./envelopes.ts";
import { validateExecutionRequestV1 } from "./execution-request.ts";

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
