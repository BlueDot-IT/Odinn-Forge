import { canonicalJson } from "./canonical-json.ts";
import {
  digestExecutionOperationV1,
  digestExecutionRequestV1,
  digestOutboundEnvelopeV1
} from "./contract-digests.ts";
import { validateOutboundEnvelopeV1 } from "./envelopes.ts";
import { invalid } from "./errors.ts";
import { validateExecutionRequestV1 } from "./execution-request.ts";
import { validateExecutionResultV1 } from "./execution-result.ts";
import { validateChannelDeliveryReceiptV1 } from "./receipts.ts";

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
