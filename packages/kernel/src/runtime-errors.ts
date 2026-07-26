export const ODINN_ERROR_CODES = Object.freeze([
  "POLICY_VIOLATION", "CAPABILITY_DENIED", "CAPABILITY_EXPIRED", "CAPABILITY_SCOPE_MISMATCH",
  "VERIFICATION_FAILED", "SNAPSHOT_FAILED", "ROLLBACK_CONFLICT", "COMPENSATION_FAILED",
  "CAPSULE_INVALID", "CAPSULE_TAMPERED", "REPLAY_UNSUPPORTED", "BUDGET_EXCEEDED",
  "WORKSPACE_CONFLICT", "MODEL_ROUTING_UNAVAILABLE"
]);

export class OdinnRuntimeError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "OdinnRuntimeError";
    this.code = code;
    this.details = details;
  }
}
