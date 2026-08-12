import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ApplicationContractValidationError,
  assertChannelDeliveryReceiptMatchesEnvelopeV1,
  assertExecutionResultMatchesRequestV1,
  canonicalizeApplicationContractV1,
  createDiagnosticsReadUseCase,
  createSessionListUseCase,
  createStatusReadUseCase,
  digestExecutionOperationV1,
  digestExecutionRequestV1,
  digestOutboundEnvelopeV1,
  parseApplicationEnvelopeV1,
  validateChannelDeliveryReceiptV1,
  validateExecutionRequestV1,
  validateExecutionResultV1,
  validateInboundEnvelopeV1,
  validateOutboundEnvelopeV1,
  type ChannelPort,
  type DiagnosticsReadRequestV1,
  type ExecutionPort,
  type ExecutionReceiptV1,
  type ExecutionRequestV1,
  type ExecutionResultV1,
  type InboundEnvelopeV1,
  type OutboundEnvelopeV1,
  type SessionListRequestV1,
  type StatusReadRequestV1
} from "../packages/application/src/index.ts";

const timestamp = "2026-08-11T12:00:00.000Z";
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

function inbound(overrides: Partial<InboundEnvelopeV1> = {}): InboundEnvelopeV1 {
  return {
    version: 1,
    kind: "inbound",
    envelopeId: "envelope:inbound-1",
    source: { kind: "channel", adapterId: "discord", accountReference: "account:primary" },
    sourceEventId: "event:001",
    receivedAt: timestamp,
    correlationId: "correlation:001",
    identityClaims: { claimedSubject: "remote-user", claimedTenant: "untrusted-tenant" },
    scopeClaims: { claimedConversation: "conversation:001", claimedThread: "thread:001" },
    payload: { text: "status" },
    redactedMetadata: { delivery: "webhook", secret: "[redacted]" },
    ...overrides
  };
}

function request(overrides: Partial<ExecutionRequestV1> = {}): ExecutionRequestV1 {
  return {
    version: 1,
    kind: "execution-request",
    requestId: "request:001",
    context: {
      principal: {
        principalId: "principal:operator",
        actorId: "actor:operator",
        kind: "operator",
        authenticationReference: "auth:session-1"
      },
      scope: {
        tenantId: "tenant:local",
        projectId: "project:001",
        sessionId: "session:001",
        conversationId: "conversation:001"
      },
      sourceReference: "inbound:envelope-1",
      correlationId: "correlation:001",
      cancellationControlReference: "cancel:001"
    },
    operation: { kind: "tool", id: "workspace.read" },
    input: { path: "README.md" },
    responseMode: "sync",
    idempotencyKey: "idempotency:001",
    ...overrides
  };
}

function completedResult(requestValue = request(), overrides: Partial<ExecutionReceiptV1> = {}): ExecutionResultV1 {
  const receipt: ExecutionReceiptV1 = {
    requestId: requestValue.requestId,
    requestDigest: digestExecutionRequestV1(requestValue),
    operationDigest: digestExecutionOperationV1(requestValue),
    executionEnvelopeReference: "execution-envelope:run-1",
    executionEnvelopeDigest: digestA,
    runId: "run:001",
    attemptId: "attempt:001",
    principal: requestValue.context.principal,
    scope: requestValue.context.scope,
    correlationId: requestValue.context.correlationId,
    operation: requestValue.operation,
    authorizationDecisionReferences: ["policy:decision-1"],
    auditReferences: ["audit:admission-1", "audit:settlement-1"],
    cancellationControlReference: requestValue.context.cancellationControlReference,
    approval: { state: "not-required" },
    status: "completed",
    uncertainty: { state: "none" },
    outputReference: "artifact:output-1",
    outputDigest: digestB,
    admittedAt: timestamp,
    observedAt: "2026-08-11T12:00:01.000Z",
    ...overrides
  };
  return {
    version: 1,
    kind: "execution-result",
    requestId: receipt.requestId,
    correlationId: receipt.correlationId,
    status: receipt.status,
    approval: receipt.approval,
    uncertainty: receipt.uncertainty,
    receipt,
    output: { text: "ok" }
  };
}

test("application envelopes round-trip canonically and freeze normalized data", () => {
  const first = validateInboundEnvelopeV1(inbound());
  const second = parseApplicationEnvelopeV1(JSON.stringify({ ...inbound(), payload: { z: 1, text: "status", a: [true, null] } }));
  const reordered = validateInboundEnvelopeV1({ ...inbound(), payload: { a: [true, null], text: "status", z: 1 } });
  assert.equal(canonicalizeApplicationContractV1(second), canonicalizeApplicationContractV1(reordered));
  assert.equal(first.correlationId, "correlation:001");
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.source), true);
  assert.equal(Object.isFrozen(first.payload), true);
});

test("inbound claims remain distinct from effective execution authority", () => {
  const claimed = validateInboundEnvelopeV1(inbound());
  const effective = validateExecutionRequestV1(request());
  assert.equal(claimed.identityClaims.claimedTenant, "untrusted-tenant");
  assert.equal(effective.context.scope.tenantId, "tenant:local");
  assert.equal(effective.context.principal.principalId, "principal:operator");
  for (const field of [{ actor: "remote-user" }, { grantedCapabilities: ["*"] }, { approved: true }, { retrySafety: "retry-safe" }]) {
    assert.throws(
      () => validateExecutionRequestV1({ ...request(), ...field }),
      (error: unknown) => error instanceof ApplicationContractValidationError && error.code === "UNKNOWN_APPLICATION_FIELD"
    );
  }
  assert.throws(
    () => parseApplicationEnvelopeV1(JSON.stringify(request())),
    (error: unknown) => error instanceof ApplicationContractValidationError && error.code === "UNSUPPORTED_APPLICATION_ENVELOPE_KIND"
  );
});

test("external ingress requires stable source event and correlation identities", () => {
  const parsed = validateInboundEnvelopeV1(inbound());
  assert.equal(validateInboundEnvelopeV1(parsed).sourceEventId, "event:001");
  assert.equal(validateInboundEnvelopeV1(parsed).correlationId, "correlation:001");
  assert.throws(
    () => validateInboundEnvelopeV1({ ...inbound(), sourceEventId: undefined }),
    (error: unknown) => error instanceof ApplicationContractValidationError && error.code === "SOURCE_EVENT_ID_REQUIRED"
  );
  assert.doesNotThrow(() => validateInboundEnvelopeV1({ ...inbound(), source: { kind: "cli", adapterId: "terminal" }, sourceEventId: undefined }));
});

test("read-only application queries have a transport-neutral operation identity", () => {
  const statusRequest = validateExecutionRequestV1(request({ operation: { kind: "query", id: "status.read" } }));
  const diagnosticsRequest = validateExecutionRequestV1(request({ operation: { kind: "query", id: "diagnostics.read" } }));
  assert.equal(statusRequest.operation.kind, "query");
  assert.equal(diagnosticsRequest.operation.id, "diagnostics.read");
  const result = completedResult(statusRequest, {
    executionEnvelopeReference: undefined,
    executionEnvelopeDigest: undefined,
    runId: undefined,
    attemptId: undefined,
    admittedAt: undefined
  });
  assert.doesNotThrow(() => assertExecutionResultMatchesRequestV1(statusRequest, result));
  assert.throws(() => validateExecutionResultV1(completedResult(statusRequest)), /cannot contain execution admission evidence/u);
});

test("parsing rejects duplicate keys at every nesting level", () => {
  const nested = JSON.stringify(inbound()).replace('"text":"status"', '"text":"status","text":"override"');
  const root = JSON.stringify(inbound()).replace('"kind":"inbound"', '"kind":"inbound","kind":"outbound"');
  for (const source of [nested, root]) {
    assert.throws(
      () => parseApplicationEnvelopeV1(source),
      (error: unknown) => error instanceof ApplicationContractValidationError && error.code === "DUPLICATE_APPLICATION_FIELD"
    );
  }
});

test("validation rejects transport objects, exotic objects, cycles, and unbounded JSON", () => {
  const withPayload = (payload: unknown) => ({ ...inbound(), payload });
  assert.throws(() => validateInboundEnvelopeV1(withPayload(new Request("https://example.invalid"))), /plain object/u);
  assert.throws(() => validateInboundEnvelopeV1(withPayload(Buffer.from("raw"))), /plain object/u);
  assert.throws(() => validateInboundEnvelopeV1(withPayload(new URL("https://example.invalid"))), /plain object/u);
  class SdkResponse { value = "raw"; }
  assert.throws(() => validateInboundEnvelopeV1(withPayload(new SdkResponse())), /plain object/u);
  const accessor = {};
  Object.defineProperty(accessor, "value", { enumerable: true, get: () => "surprise" });
  assert.throws(() => validateInboundEnvelopeV1(withPayload(accessor)), /enumerable data field/u);
  const hidden = {};
  Object.defineProperty(hidden, "value", { enumerable: false, value: "hidden" });
  assert.throws(() => validateInboundEnvelopeV1(withPayload(hidden)), /enumerable data field/u);
  assert.throws(() => validateInboundEnvelopeV1(withPayload({ [Symbol("sdk")]: true })), /symbol fields/u);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => validateInboundEnvelopeV1(withPayload(cyclic)), /cycle/u);
  assert.throws(() => validateInboundEnvelopeV1(withPayload({ value: Number.POSITIVE_INFINITY })), /finite safe number/u);
  assert.throws(() => validateInboundEnvelopeV1(withPayload({ value: Number.MAX_VALUE })), /finite safe number/u);
  assert.equal((validateInboundEnvelopeV1(withPayload({ value: 1.5 })).payload as { readonly value: number }).value, 1.5);
  assert.throws(() => validateInboundEnvelopeV1(withPayload(Array.from({ length: 257 }, (_, index) => index))), /more than 256/u);
  assert.throws(() => validateInboundEnvelopeV1(withPayload({ text: "x".repeat(65_537) })), /exceeds 65536 bytes/u);
  assert.throws(() => parseApplicationEnvelopeV1(JSON.stringify(inbound()).replace('"text":"status"', '"__proto__":"blocked"')), /reserved field/u);
});

test("results require durable admission, authorization, audit, and outcome evidence", () => {
  const requestValue = validateExecutionRequestV1(request());
  const result = validateExecutionResultV1(completedResult(requestValue));
  assert.doesNotThrow(() => assertExecutionResultMatchesRequestV1(requestValue, result));
  assert.throws(() => validateExecutionResultV1(completedResult(requestValue, { auditReferences: [] })), /invalid item count/u);
  assert.throws(() => validateExecutionResultV1(completedResult(requestValue, { executionEnvelopeDigest: undefined })), /present together/u);
  assert.throws(() => validateExecutionResultV1(completedResult(requestValue, { outputDigest: undefined })), /present together/u);
  assert.throws(() => validateExecutionResultV1({ ...completedResult(requestValue), output: undefined }), /requires output and evidence/u);
});

test("receipt binding rejects cross-principal, scope, correlation, request, and operation substitution", () => {
  const requestValue = validateExecutionRequestV1(request());
  const variants: ExecutionResultV1[] = [
    completedResult(requestValue, { principal: { ...requestValue.context.principal, principalId: "principal:other" } }),
    completedResult(requestValue, { scope: { ...requestValue.context.scope, tenantId: "tenant:other" } }),
    completedResult(requestValue, { scope: { ...requestValue.context.scope, projectId: "project:other" } }),
    completedResult(requestValue, { scope: { ...requestValue.context.scope, sessionId: "session:other" } }),
    completedResult(requestValue, { scope: { ...requestValue.context.scope, conversationId: "conversation:other" } }),
    completedResult(requestValue, { correlationId: "correlation:other" }),
    completedResult(requestValue, { requestId: "request:other" }),
    completedResult(requestValue, { operation: { kind: "tool", id: "process.exec" } })
  ];
  for (const result of variants) {
    assert.throws(
      () => assertExecutionResultMatchesRequestV1(requestValue, result),
      (error: unknown) => error instanceof ApplicationContractValidationError && error.code === "EXECUTION_RECEIPT_BINDING_MISMATCH"
    );
  }
});

test("approval references are output state, never broad approved authority", () => {
  const originalRequest = validateExecutionRequestV1(request());
  const initialDigest = digestExecutionOperationV1(originalRequest);
  const pendingApproval = { state: "pending", approvalReference: "approval:claim-1", operationDigest: initialDigest, expiresAt: "2026-08-11T12:05:00.000Z" } as const;
  const pendingReceipt: ExecutionReceiptV1 = {
    requestId: originalRequest.requestId,
    requestDigest: digestExecutionRequestV1(originalRequest),
    operationDigest: initialDigest,
    principal: originalRequest.context.principal,
    scope: originalRequest.context.scope,
    correlationId: originalRequest.context.correlationId,
    operation: originalRequest.operation,
    authorizationDecisionReferences: ["policy:approval-required"],
    auditReferences: ["audit:approval-pending"],
    cancellationControlReference: originalRequest.context.cancellationControlReference,
    approval: pendingApproval,
    status: "awaiting-approval",
    uncertainty: { state: "none" },
    observedAt: timestamp
  };
  assert.doesNotThrow(() => assertExecutionResultMatchesRequestV1(originalRequest, {
    version: 1,
    kind: "execution-result",
    requestId: originalRequest.requestId,
    correlationId: originalRequest.context.correlationId,
    status: "awaiting-approval",
    approval: pendingApproval,
    uncertainty: { state: "none" },
    receipt: pendingReceipt
  }));

  const requestValue = validateExecutionRequestV1({ ...originalRequest, approvalReference: "approval:claim-1" });
  const operationDigest = digestExecutionOperationV1(originalRequest);
  assert.equal(digestExecutionOperationV1(requestValue), operationDigest);
  assert.notEqual(digestExecutionRequestV1(requestValue), digestExecutionRequestV1(originalRequest));
  const approval = { state: "consumed", approvalReference: "approval:claim-1", operationDigest } as const;
  const result = completedResult(requestValue, { approval });
  result.approval = approval;
  assert.doesNotThrow(() => assertExecutionResultMatchesRequestV1(requestValue, result));
  assert.throws(
    () => assertExecutionResultMatchesRequestV1(requestValue, {
      ...result,
      approval: { ...approval, operationDigest: digestA },
      receipt: { ...result.receipt, approval: { ...approval, operationDigest: digestA } }
    }),
    (error: unknown) => error instanceof ApplicationContractValidationError && error.code === "APPROVAL_BINDING_MISMATCH"
  );
  assert.throws(
    () => assertExecutionResultMatchesRequestV1(requestValue, {
      ...result,
      approval: { ...approval, approvalReference: "approval:different" },
      receipt: { ...result.receipt, approval: { ...approval, approvalReference: "approval:different" } }
    }),
    (error: unknown) => error instanceof ApplicationContractValidationError && error.code === "APPROVAL_REFERENCE_MISMATCH"
  );
  assert.throws(() => validateExecutionResultV1({ ...result, approval: { approved: true } }), /unsupported value/u);
});

test("cancellation cannot conceal uncertain physical execution", () => {
  const requestValue = validateExecutionRequestV1(request());
  const cancelled = completedResult(requestValue, { status: "cancelled", outputReference: undefined, outputDigest: undefined });
  assert.doesNotThrow(() => validateExecutionResultV1({ ...cancelled, status: "cancelled", output: undefined }));
  const uncertain = {
    state: "needs-review",
    reasonCode: "DISPATCH_DID_NOT_STOP",
    recoveryReference: "recovery:001",
    physicalExecutionPending: true,
    retryAllowed: false
  } as const;
  const needsReview = completedResult(requestValue, { status: "needs-review", uncertainty: uncertain, outputReference: undefined, outputDigest: undefined });
  assert.doesNotThrow(() => validateExecutionResultV1({ ...needsReview, status: "needs-review", uncertainty: uncertain, receipt: { ...needsReview.receipt, uncertainty: uncertain }, output: undefined }));
  assert.throws(() => validateExecutionResultV1({ ...cancelled, status: "cancelled", uncertainty: uncertain, receipt: { ...cancelled.receipt, uncertainty: uncertain }, output: undefined }), /cannot hide output or an uncertain physical outcome/u);
  assert.throws(() => validateExecutionResultV1({
    ...needsReview,
    status: "needs-review",
    uncertainty: uncertain,
    receipt: { ...needsReview.receipt, uncertainty: uncertain, errorCode: "DISPATCH_TIMEOUT" },
    output: undefined,
    error: { code: "DISPATCH_TIMEOUT", message: "dispatch timed out", category: "timeout", retryable: true }
  }), /cannot be marked retryable/u);
});

test("normalized errors reject exception internals and secret-like material", () => {
  const failed = completedResult(request(), { status: "failed", outputReference: undefined, outputDigest: undefined, errorCode: "DEPENDENCY_FAILURE" });
  const base = {
    ...failed,
    status: "failed" as const,
    output: undefined,
    error: { code: "DEPENDENCY_FAILURE", message: "provider unavailable", category: "dependency" as const, retryable: true, retryAfterMs: 500 }
  };
  assert.doesNotThrow(() => validateExecutionResultV1(base));
  assert.throws(() => validateExecutionResultV1({ ...base, error: { ...base.error, stack: "private path" } }), /unknown field/u);
  assert.throws(() => validateExecutionResultV1({ ...base, error: { ...base.error, message: "Bearer secret-token-value" } }), /secret-like/u);
  assert.throws(() => validateExecutionResultV1({ ...base, error: { ...base.error, redactedDetails: { api_token: "visible" } } }), /not permitted in redacted metadata/u);
  for (const key of ["accessToken", "refreshToken", "clientSecret", "credentials"]) {
    assert.throws(() => validateExecutionResultV1({ ...base, error: { ...base.error, redactedDetails: { [key]: "visible" } } }), /not permitted in redacted metadata/u);
  }
  for (const message of ["OpenAI key sk-do-not-log-this", "access token actual-secret-value"]) {
    assert.throws(() => validateExecutionResultV1({ ...base, error: { ...base.error, message } }), /secret-like/u);
  }
  for (const message of [
    ["eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiJvcGVyYXRvciJ9", ".", "signaturevalue"].join(""),
    "postgres://operator:actual-secret@db.invalid/state",
    "AKIAIOSFODNN7EXAMPLE",
    ["https://hooks", ".slack.com/services/", "T00000000/B00000000/", "XXXXXXXXXXXXXXXXXXXXXXXX"].join(""),
    `AIza${"F".repeat(35)}`,
    `mfa.${"L".repeat(24)}`,
    `${"L".repeat(24)}.ABCDEF.${"M".repeat(27)}`,
    "password=hunter2",
    "Authorization: opaque-secret-value",
    "Cookie: session=opaque-secret-value",
    "capability_token=opaque-secret-value",
    "private_key=opaque-secret-value"
  ]) {
    assert.throws(() => validateExecutionResultV1({ ...base, error: { ...base.error, message } }), /secret-like/u);
  }
});

test("ports keep runtime cancellation outside serialized transport-neutral DTOs", async () => {
  const outbound: OutboundEnvelopeV1 = {
    version: 1,
    kind: "outbound",
    envelopeId: "outbound:001",
    correlationId: "correlation:001",
    destination: { transport: "discord", conversationReference: "conversation:001" },
    payload: { text: "ready" }
  };
  const channel: ChannelPort = {
    async deliver(envelope, options) {
      if (options?.signal?.aborted) throw options.signal.reason;
      return validateChannelDeliveryReceiptV1({ version: 1, kind: "channel-delivery-receipt", envelopeId: envelope.envelopeId, envelopeDigest: digestOutboundEnvelopeV1(envelope), correlationId: envelope.correlationId, status: "sent", messageReferences: ["message:001"], uncertainty: { state: "none" }, settledAt: timestamp });
    }
  };
  const execution: ExecutionPort = {
    async execute(value, options) {
      if (options?.signal?.aborted) throw options.signal.reason;
      return validateExecutionResultV1(completedResult(value));
    }
  };
  const delivery = await channel.deliver(validateOutboundEnvelopeV1(outbound), { signal: new AbortController().signal });
  assert.equal(delivery.status, "sent");
  assert.doesNotThrow(() => assertChannelDeliveryReceiptMatchesEnvelopeV1(outbound, delivery));
  assert.throws(() => assertChannelDeliveryReceiptMatchesEnvelopeV1({ ...outbound, payload: { text: "changed" } }, delivery), /not bound/u);
  assert.throws(() => validateChannelDeliveryReceiptV1({ ...delivery, status: "partial", messageReferences: [], error: undefined }), /partial delivery requires/u);
  assert.throws(() => validateChannelDeliveryReceiptV1({ ...delivery, status: "partial", error: { code: "TIMEOUT", message: "delivery timed out", category: "timeout", retryable: true } }), /partial delivery requires/u);
  assert.throws(() => validateChannelDeliveryReceiptV1({
    ...delivery,
    status: "failed",
    messageReferences: [],
    uncertainty: { state: "needs-review", reasonCode: "DELIVERY_TIMEOUT", recoveryReference: "recovery:delivery-1", physicalExecutionPending: true, retryAllowed: false },
    error: { code: "TIMEOUT", message: "delivery timed out", category: "timeout", retryable: true }
  }), /cannot be marked retryable/u);
  assert.equal((await execution.execute(validateExecutionRequestV1(request()), { signal: new AbortController().signal })).status, "completed");
  assert.equal(JSON.stringify(outbound).includes("AbortSignal"), false);
});

test("status.read preserves authenticated principal scope and normalizes transport-neutral output", async () => {
  const request: StatusReadRequestV1 = {
    version: 1,
    kind: "status-read-request",
    requestId: "request:status-001",
    context: {
      principal: { principalId: "principal:operator", actorId: "actor:cli", kind: "operator" },
      scope: { tenantId: "tenant:local", projectId: "project:001" },
      sourceReference: "cli:status",
      correlationId: "correlation:status-001",
      cancellationControlReference: "cancel:status-001"
    },
    operation: { kind: "query", id: "status.read" }
  };
  let observedContext: unknown;
  const statusRead = createStatusReadUseCase({
    async readStatus(context) {
      observedContext = context;
      return { ok: true, tools: ["text.echo"], nested: { omitted: undefined } } as any;
    }
  });
  const result = await statusRead.execute(request);
  assert.equal(result.requestId, request.requestId);
  assert.equal(result.correlationId, request.context.correlationId);
  assert.deepEqual(observedContext, request.context);
  assert.deepEqual(result.output, { nested: {}, ok: true, tools: ["text.echo"] });
  assert.equal(Object.isFrozen(result.output), true);
  assert.equal(Object.isFrozen(result), true);
  await assert.rejects(
    () => statusRead.execute({ ...request, operation: { kind: "query", id: "diagnostics.read" as any } }),
    /status read operation/u
  );
});

test("status.read honors cancellation without invoking or publishing its port", async () => {
  let calls = 0;
  const statusRead = createStatusReadUseCase({ async readStatus() { calls += 1; return { ok: true }; } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => statusRead.execute({
    version: 1,
    kind: "status-read-request",
    requestId: "request:status-cancelled",
    context: {
      principal: { principalId: "principal:operator", actorId: "actor:http", kind: "host-user" },
      scope: { tenantId: "tenant:hosted" },
      sourceReference: "http:GET:/status",
      correlationId: "correlation:status-cancelled",
      cancellationControlReference: "cancel:status-cancelled"
    },
    operation: { kind: "query", id: "status.read" }
  }, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("status.read snapshots authenticated authority before asynchronous port work", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let observedContext: any;
  const statusRead = createStatusReadUseCase({
    async readStatus(context) {
      await gate;
      observedContext = context;
      return { ok: true };
    }
  });
  const request: any = {
    version: 1,
    kind: "status-read-request",
    requestId: "request:status-authority",
    context: {
      principal: { principalId: "principal:alice", actorId: "actor:http", kind: "host-user" },
      scope: { tenantId: "tenant:alice" },
      sourceReference: "http:GET:/status",
      correlationId: "correlation:alice",
      cancellationControlReference: "cancel:alice"
    },
    operation: { kind: "query", id: "status.read" }
  };
  const pending = statusRead.execute(request);
  request.context.principal.principalId = "principal:bob";
  request.context.scope.tenantId = "tenant:bob";
  request.context.correlationId = "correlation:bob";
  release();
  const result = await pending;
  assert.equal(observedContext.principal.principalId, "principal:alice");
  assert.equal(observedContext.scope.tenantId, "tenant:alice");
  assert.equal(result.correlationId, "correlation:alice");
  assert.equal(Object.isFrozen(observedContext), true);
  assert.equal(Object.isFrozen(observedContext.principal), true);
  assert.equal(Object.isFrozen(observedContext.scope), true);
});

test("diagnostics.read snapshots authority, normalizes output, and rejects operation substitution", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let observedContext: any;
  const diagnosticsRead = createDiagnosticsReadUseCase({
    async readDiagnostics(context) {
      await gate;
      observedContext = context;
      return { ok: true, state: { safe: true, omitted: undefined } } as any;
    }
  });
  const request: DiagnosticsReadRequestV1 = {
    version: 1,
    kind: "diagnostics-read-request",
    requestId: "request:diagnostics-alice",
    context: {
      principal: { principalId: "principal:alice", actorId: "actor:http", kind: "host-user" },
      scope: { tenantId: "tenant:alice" },
      sourceReference: "http:GET:/diagnostics",
      correlationId: "correlation:diagnostics-alice",
      cancellationControlReference: "cancel:diagnostics-alice"
    },
    operation: { kind: "query", id: "diagnostics.read" }
  };
  const pending = diagnosticsRead.execute(request);
  (request as any).context.principal.principalId = "principal:bob";
  (request as any).context.scope.tenantId = "tenant:bob";
  (request as any).context.correlationId = "correlation:diagnostics-bob";
  release();
  const result = await pending;
  assert.equal(observedContext.principal.principalId, "principal:alice");
  assert.equal(observedContext.scope.tenantId, "tenant:alice");
  assert.equal(result.correlationId, "correlation:diagnostics-alice");
  assert.deepEqual(result.output, { ok: true, state: { safe: true } });
  assert.equal(Object.isFrozen(observedContext), true);
  assert.equal(Object.isFrozen(result.output), true);
  await assert.rejects(
    () => diagnosticsRead.execute({ ...request, operation: { kind: "query", id: "status.read" as any } }),
    /diagnostics read operation/u
  );
});

test("diagnostics.read honors cancellation before invoking its port", async () => {
  let calls = 0;
  const diagnosticsRead = createDiagnosticsReadUseCase({ async readDiagnostics() { calls += 1; return { ok: true }; } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => diagnosticsRead.execute({
    version: 1,
    kind: "diagnostics-read-request",
    requestId: "request:diagnostics-cancelled",
    context: {
      principal: { principalId: "principal:operator", actorId: "actor:cli", kind: "operator" },
      scope: { tenantId: "tenant:local" },
      sourceReference: "cli:doctor",
      correlationId: "correlation:diagnostics-cancelled",
      cancellationControlReference: "cancel:diagnostics-cancelled"
    },
    operation: { kind: "query", id: "diagnostics.read" }
  }, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("session.list snapshots authority and query input before asynchronous port work", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let observedContext: any;
  let observedInput: any;
  const sessionList = createSessionListUseCase({
    async readSessions(input, context) {
      await gate;
      observedInput = input;
      observedContext = context;
      return { sessions: [{ id: "session:001", title: "First" }], omitted: undefined } as any;
    }
  });
  const request: SessionListRequestV1 = {
    version: 1,
    kind: "session-list-request",
    requestId: "request:sessions-alice",
    context: {
      principal: { principalId: "principal:alice", actorId: "actor:http", kind: "host-user" },
      scope: { tenantId: "tenant:alice" },
      sourceReference: "http:GET:/sessions",
      correlationId: "correlation:sessions-alice",
      cancellationControlReference: "cancel:sessions-alice"
    },
    operation: { kind: "query", id: "session.list" },
    input: { limit: 25, projectId: "project:alice" }
  };
  const pending = sessionList.execute(request);
  (request as any).context.principal.principalId = "principal:bob";
  (request as any).context.scope.tenantId = "tenant:bob";
  (request as any).context.correlationId = "correlation:sessions-bob";
  (request as any).input.limit = 200;
  (request as any).input.projectId = "project:bob";
  release();
  const result = await pending;
  assert.deepEqual(observedInput, { limit: 25, projectId: "project:alice" });
  assert.equal(observedContext.principal.principalId, "principal:alice");
  assert.equal(observedContext.scope.tenantId, "tenant:alice");
  assert.equal(result.correlationId, "correlation:sessions-alice");
  assert.deepEqual(result.output, { sessions: [{ id: "session:001", title: "First" }] });
  assert.equal(Object.isFrozen(observedInput), true);
  assert.equal(Object.isFrozen(observedContext), true);
  assert.equal(Object.isFrozen(result.output), true);
  assert.equal(Object.isFrozen((result.output.sessions as any[])[0]), true);
  await assert.rejects(
    () => sessionList.execute({ ...request, operation: { kind: "query", id: "status.read" as any } }),
    /session list operation/u
  );
});

test("session.list validates bounded input and cancellation before invocation and publication", async () => {
  let calls = 0;
  const controller = new AbortController();
  const sessionList = createSessionListUseCase({
    async readSessions() {
      calls += 1;
      controller.abort();
      return { sessions: [] };
    }
  });
  const request: SessionListRequestV1 = {
    version: 1,
    kind: "session-list-request",
    requestId: "request:sessions-cancelled",
    context: {
      principal: { principalId: "principal:operator", actorId: "actor:cli", kind: "operator" },
      scope: { tenantId: "tenant:local" },
      sourceReference: "cli:session:list",
      correlationId: "correlation:sessions-cancelled",
      cancellationControlReference: "cancel:sessions-cancelled"
    },
    operation: { kind: "query", id: "session.list" },
    input: { limit: 20 }
  };
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  await assert.rejects(() => sessionList.execute(request, { signal: alreadyCancelled.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
  await assert.rejects(() => sessionList.execute(request, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
  await assert.rejects(() => sessionList.execute({ ...request, input: { limit: 201 } }), /integer from 1 to 200/u);
});

test("application package resolves independently and excludes implementation dependencies", () => {
  const packageRoot = join(import.meta.dirname, "..", "packages", "application");
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  assert.deepEqual(Object.keys(packageJson.dependencies ?? {}), []);
  const source = ["contracts.ts", "validation.ts", "ports.ts", "status.ts", "diagnostics.ts", "session-list.ts", "index.ts"].map((file) => readFileSync(join(packageRoot, "src", file), "utf8")).join("\n");
  assert.doesNotMatch(source, /discord\.js|@slack|telegram|whatsapp|express|playwright|apps\/gateway|apps\/cli|packages\/kernel/u);
  assert.doesNotMatch(readFileSync(join(packageRoot, "src", "contracts.ts"), "utf8"), /\b(?:AbortSignal|Request|Response|Buffer|Readable|Writable)\b/u);
  const probe = spawnSync(process.execPath, ["--input-type=module", "--eval", "const application = await import('@odinn/application'); if (application.APPLICATION_CONTRACT_VERSION !== 1) process.exit(2);"], { cwd: packageRoot, encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
});
