import { ApplicationContractValidationError, OPERATOR_SNAPSHOT_CHANGED_CODE } from "@odinn/application";

export function gatewayOperatorSnapshotFailure(error: unknown, requestId: string) {
  if (!(error instanceof ApplicationContractValidationError)
    || error.code !== OPERATOR_SNAPSHOT_CHANGED_CODE) return undefined;
  return Object.freeze({
    status: 503 as const,
    retryAfter: "1",
    body: Object.freeze({
      ok: false as const,
      error: "operator snapshot changed while it was being read; retry the request",
      code: OPERATOR_SNAPSHOT_CHANGED_CODE,
      retryable: true as const,
      requestId,
    }),
  });
}
