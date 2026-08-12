export const APPLICATION_CONTRACT_VERSION = 1 as const;
export const MAX_APPLICATION_CONTRACT_BYTES = 262_144;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue }

export type InboundSourceKindV1 = "cli" | "http" | "channel" | "job" | "workflow" | "event" | "agent" | "mcp";

export interface InboundIdentityClaimsV1 {
  readonly claimedSubject?: string;
  readonly claimedTenant?: string;
  readonly claimedProject?: string;
}

export interface InboundScopeClaimsV1 {
  readonly claimedConversation?: string;
  readonly claimedSession?: string;
  readonly claimedThread?: string;
}

export interface InboundEnvelopeV1 {
  readonly version: typeof APPLICATION_CONTRACT_VERSION;
  readonly kind: "inbound";
  readonly envelopeId: string;
  readonly source: {
    readonly kind: InboundSourceKindV1;
    readonly adapterId: string;
    readonly accountReference?: string;
  };
  readonly sourceEventId?: string;
  readonly receivedAt: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly identityClaims: InboundIdentityClaimsV1;
  readonly scopeClaims: InboundScopeClaimsV1;
  readonly payload: JsonValue;
  readonly redactedMetadata?: JsonObject;
}

export type PrincipalKindV1 = "operator" | "host-user" | "channel-user" | "automation" | "agent" | "system";

export interface ApplicationPrincipalV1 {
  readonly principalId: string;
  readonly actorId: string;
  readonly kind: PrincipalKindV1;
  readonly authenticationReference?: string;
  readonly delegatedByPrincipalId?: string;
}

export interface ApplicationScopeV1 {
  readonly tenantId: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly conversationId?: string;
}

/**
 * Effective authorization context. Transports must construct this from
 * authenticated server-side state; inbound claims never confer authority.
 */
export interface ExecutionContextV1 {
  readonly principal: ApplicationPrincipalV1;
  readonly scope: ApplicationScopeV1;
  readonly sourceReference: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly deadlineAt?: string;
  readonly cancellationControlReference: string;
}

export type ExecutionResponseModeV1 = "sync" | "async" | "stream";

export type ApplicationOperationKindV1 = "query" | "tool" | "agent" | "skill" | "mcp-tool" | "workflow-node";

export interface ApplicationOperationV1 {
  readonly kind: ApplicationOperationKindV1;
  readonly id: string;
}

export interface ExecutionRequestV1 {
  readonly version: typeof APPLICATION_CONTRACT_VERSION;
  readonly kind: "execution-request";
  readonly requestId: string;
  readonly context: ExecutionContextV1;
  readonly operation: ApplicationOperationV1;
  readonly input: JsonValue;
  readonly responseMode: ExecutionResponseModeV1;
  readonly idempotencyKey?: string;
  /** A claim for the kernel to validate and consume; never authority itself. */
  readonly approvalReference?: string;
}

export type ApprovalStateV1 =
  | { readonly state: "not-required" }
  | { readonly state: "pending"; readonly approvalReference: string; readonly operationDigest: string; readonly expiresAt: string }
  | { readonly state: "claimed"; readonly approvalReference: string; readonly operationDigest: string }
  | { readonly state: "consumed"; readonly approvalReference: string; readonly operationDigest: string }
  | { readonly state: "denied" | "expired"; readonly approvalReference?: string };

export type ExecutionUncertaintyV1 =
  | { readonly state: "none" }
  | {
      readonly state: "needs-review";
      readonly reasonCode: string;
      readonly recoveryReference: string;
      readonly physicalExecutionPending: boolean;
      readonly retryAllowed: false;
    };

export type ExecutionErrorCategoryV1 = "authorization" | "validation" | "conflict" | "cancelled" | "dependency" | "timeout" | "internal";

export interface NormalizedExecutionErrorV1 {
  readonly code: string;
  readonly message: string;
  readonly category: ExecutionErrorCategoryV1;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly redactedDetails?: JsonObject;
}

export type ExecutionStatusV1 = "completed" | "failed" | "cancelled" | "awaiting-approval" | "needs-review" | "denied";

export interface ExecutionReceiptV1 {
  readonly requestId: string;
  readonly requestDigest: string;
  readonly operationDigest: string;
  readonly executionEnvelopeReference?: string;
  readonly executionEnvelopeDigest?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly principal: ApplicationPrincipalV1;
  readonly scope: ApplicationScopeV1;
  readonly correlationId: string;
  readonly operation: ApplicationOperationV1;
  readonly authorizationDecisionReferences: readonly string[];
  readonly auditReferences: readonly string[];
  readonly cancellationControlReference: string;
  readonly approval: ApprovalStateV1;
  readonly status: ExecutionStatusV1;
  readonly uncertainty: ExecutionUncertaintyV1;
  readonly outputReference?: string;
  readonly outputDigest?: string;
  readonly errorCode?: string;
  readonly admittedAt?: string;
  readonly observedAt: string;
}

export interface ExecutionResultV1 {
  readonly version: typeof APPLICATION_CONTRACT_VERSION;
  readonly kind: "execution-result";
  readonly requestId: string;
  readonly correlationId: string;
  readonly status: ExecutionStatusV1;
  readonly approval: ApprovalStateV1;
  readonly uncertainty: ExecutionUncertaintyV1;
  readonly receipt: ExecutionReceiptV1;
  readonly output?: JsonValue;
  readonly error?: NormalizedExecutionErrorV1;
}

export interface OutboundEnvelopeV1 {
  readonly version: typeof APPLICATION_CONTRACT_VERSION;
  readonly kind: "outbound";
  readonly envelopeId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly destination: {
    readonly transport: string;
    readonly accountReference?: string;
    readonly conversationReference: string;
    readonly threadReference?: string;
  };
  readonly payload: JsonValue;
  readonly replyToReference?: string;
  readonly redactedMetadata?: JsonObject;
}

export interface ChannelDeliveryReceiptV1 {
  readonly version: typeof APPLICATION_CONTRACT_VERSION;
  readonly kind: "channel-delivery-receipt";
  readonly envelopeId: string;
  readonly envelopeDigest: string;
  readonly correlationId: string;
  readonly status: "sent" | "partial" | "failed";
  readonly messageReferences: readonly string[];
  readonly uncertainty: ExecutionUncertaintyV1;
  readonly settledAt: string;
  readonly error?: NormalizedExecutionErrorV1;
}

/** Wire-admissible transport envelopes. Trusted execution DTOs are excluded. */
export type ApplicationEnvelopeV1 = InboundEnvelopeV1 | OutboundEnvelopeV1 | ChannelDeliveryReceiptV1;
