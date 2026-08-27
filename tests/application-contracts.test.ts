import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { spawnPnpmSync } from "../scripts/lib/package-manager.ts";
import * as applicationRoot from "../packages/application/src/index.ts";
import {
  MAX_APPLICATION_CONTRACT_BYTES,
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
  isSensitiveApplicationMetadataKey,
  parseApplicationEnvelopeV1,
  parseDiagnosticsReportV1,
  parseSessionPageV1,
  parseStatusSnapshotV1,
  validateApplicationEnvelopeV1,
  validateChannelDeliveryReceiptV1,
  validateDiagnosticsReportV1,
  validateExecutionRequestV1,
  validateExecutionResultV1,
  validateGatewayChannelDiagnosticsV1,
  validateInboundEnvelopeV1,
  validateOutboundEnvelopeV1,
  validatePendingApprovalSummariesV1,
  validateSessionPageV1,
  validateStatusSnapshotV1,
  type ChannelPort,
  type DiagnosticsReportV1,
  type DiagnosticsReadRequestV1,
  type ExecutionPort,
  type ExecutionReceiptV1,
  type ExecutionRequestV1,
  type ExecutionResultV1,
  type InboundEnvelopeV1,
  type OutboundEnvelopeV1,
  type SessionPageV1,
  type SessionListRequestV1,
  type StatusSnapshotV1,
  type StatusReadRequestV1
} from "../packages/application/src/index.ts";
import { normalizeReadContractJsonValueV1 } from "../packages/application/src/read-contract-json.ts";
import * as validationFacade from "../packages/application/src/validation.ts";

const timestamp = "2026-08-11T12:00:00.000Z";
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const readContractFixtures = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "application-read-contracts-v1.json"), "utf8")) as {
  statusCli: StatusSnapshotV1;
  statusGateway: StatusSnapshotV1;
  diagnostics: DiagnosticsReportV1;
  sessionPage: SessionPageV1;
};
const validationFixtures = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "application-validation-v1.json"), "utf8")) as {
  inbound: InboundEnvelopeV1;
  executionRequest: ExecutionRequestV1;
  outbound: OutboundEnvelopeV1;
  expected: {
    canonicalApplicationEnvelope: string;
    executionRequestDigest: string;
    approvedExecutionRequestDigest: string;
    executionOperationDigest: string;
    outboundEnvelopeDigest: string;
  };
};

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

test("validation facade preserves its exact public surface and error identity", () => {
  const expectedExports = [
    "ApplicationContractValidationError",
    "assertChannelDeliveryReceiptMatchesEnvelopeV1",
    "assertExecutionResultMatchesRequestV1",
    "canonicalizeApplicationContractV1",
    "digestExecutionOperationV1",
    "digestExecutionRequestV1",
    "digestOutboundEnvelopeV1",
    "parseApplicationEnvelopeV1",
    "validateApplicationEnvelopeV1",
    "validateChannelDeliveryReceiptV1",
    "validateExecutionRequestV1",
    "validateExecutionResultV1",
    "validateInboundEnvelopeV1",
    "validateOutboundEnvelopeV1"
  ] as const;
  assert.deepEqual(Object.keys(validationFacade).sort(), [...expectedExports].sort());
  for (const key of expectedExports) assert.equal(validationFacade[key], applicationRoot[key], key);

  const capture = (operation: () => unknown): unknown => {
    try { operation(); } catch (error) { return error; }
    assert.fail("expected validation failure");
  };
  const wireError = capture(() => validateInboundEnvelopeV1({}));
  const readError = capture(() => validateSessionPageV1({ sessions: "not-an-array" }));
  assert.equal(wireError instanceof ApplicationContractValidationError, true);
  assert.equal(readError instanceof ApplicationContractValidationError, true);
  assert.equal((wireError as Error).constructor, (readError as Error).constructor);
});

test("application contract canonical and digest golden vectors remain stable", () => {
  const { inbound: inboundFixture, executionRequest, outbound: outboundFixture, expected } = validationFixtures;
  const approvedRequest = { ...executionRequest, approvalReference: "approval:claim-1" };
  assert.equal(canonicalizeApplicationContractV1(inboundFixture), expected.canonicalApplicationEnvelope);
  assert.equal(digestExecutionRequestV1(executionRequest), expected.executionRequestDigest);
  assert.equal(digestExecutionRequestV1(approvedRequest), expected.approvedExecutionRequestDigest);
  assert.equal(digestExecutionOperationV1(executionRequest), expected.executionOperationDigest);
  assert.equal(digestExecutionOperationV1(approvedRequest), expected.executionOperationDigest);
  assert.equal(digestOutboundEnvelopeV1(outboundFixture), expected.outboundEnvelopeDigest);
  assert.notEqual(digestExecutionRequestV1(approvedRequest), digestExecutionRequestV1(executionRequest));
  assert.notEqual(digestExecutionOperationV1({ ...executionRequest, input: { path: "CHANGELOG.md" } }), expected.executionOperationDigest);
  assert.notEqual(digestExecutionOperationV1({ ...executionRequest, idempotencyKey: "idempotency:002" }), expected.executionOperationDigest);
});

test("application envelope dispatch remains wire-only", () => {
  const outboundFixture = validationFixtures.outbound;
  const delivery = {
    version: 1,
    kind: "channel-delivery-receipt",
    envelopeId: outboundFixture.envelopeId,
    envelopeDigest: digestOutboundEnvelopeV1(outboundFixture),
    correlationId: outboundFixture.correlationId,
    status: "sent",
    messageReferences: ["message:001"],
    uncertainty: { state: "none" },
    settledAt: timestamp
  };
  assert.equal(validateApplicationEnvelopeV1(validationFixtures.inbound).kind, "inbound");
  assert.equal(validateApplicationEnvelopeV1(outboundFixture).kind, "outbound");
  assert.equal(validateApplicationEnvelopeV1(delivery).kind, "channel-delivery-receipt");
  for (const trusted of [validationFixtures.executionRequest, completedResult()]) {
    assert.throws(
      () => validateApplicationEnvelopeV1(trusted),
      (error: unknown) => error instanceof ApplicationContractValidationError
        && error.message === "application envelope kind is not wire-admissible"
        && error.code === "UNSUPPORTED_APPLICATION_ENVELOPE_KIND"
        && error.path === "kind"
    );
  }
});

test("wire and read JSON limits remain intentionally distinct", () => {
  const wireList = Array.from({ length: 256 }, (_, index) => index);
  assert.equal((validateInboundEnvelopeV1(inbound({ payload: wireList })).payload as readonly number[]).length, 256);
  assert.throws(() => validateInboundEnvelopeV1(inbound({ payload: [...wireList, 256] })), /more than 256/u);

  const wireFields = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`field${index}`, index]));
  assert.equal(Object.keys(validateInboundEnvelopeV1(inbound({ payload: wireFields })).payload as object).length, 256);
  assert.throws(() => validateInboundEnvelopeV1(inbound({ payload: { ...wireFields, overflow: true } })), /more than 256/u);

  const readList = Array.from({ length: 512 }, (_, index) => index);
  assert.equal((normalizeReadContractJsonValueV1(readList, "read list") as readonly number[]).length, 512);
  assert.throws(() => normalizeReadContractJsonValueV1([...readList, 512], "read list"), /more than 512/u);
  const readFields = Object.fromEntries(Array.from({ length: 512 }, (_, index) => [`field${index}`, index]));
  assert.equal(Object.keys(normalizeReadContractJsonValueV1(readFields, "read fields") as object).length, 512);
  assert.throws(() => normalizeReadContractJsonValueV1({ ...readFields, overflow: true }, "read fields"), /more than 512/u);

  const nested = (depth: number): unknown => {
    let value: unknown = true;
    for (let index = 0; index < depth; index += 1) value = { value };
    return value;
  };
  assert.doesNotThrow(() => validateInboundEnvelopeV1(inbound({ payload: nested(32) as InboundEnvelopeV1["payload"] })));
  assert.throws(
    () => validateInboundEnvelopeV1(inbound({ payload: nested(33) as InboundEnvelopeV1["payload"] })),
    (error: unknown) => error instanceof ApplicationContractValidationError && error.code === "APPLICATION_JSON_TOO_DEEP"
  );
  assert.doesNotThrow(() => normalizeReadContractJsonValueV1(nested(32), "read depth"));
  assert.throws(
    () => normalizeReadContractJsonValueV1(nested(33), "read depth"),
    (error: unknown) => error instanceof ApplicationContractValidationError && error.code === "APPLICATION_JSON_TOO_DEEP"
  );

  const nodeBoundary = Array.from({ length: 256 }, (_, index) => Array.from({ length: index === 255 ? 30 : 31 }, () => true));
  assert.doesNotThrow(() => validateInboundEnvelopeV1(inbound({ payload: nodeBoundary })));
  nodeBoundary[255]!.push(true);
  assert.throws(
    () => validateInboundEnvelopeV1(inbound({ payload: nodeBoundary })),
    (error: unknown) => error instanceof ApplicationContractValidationError && error.code === "APPLICATION_JSON_TOO_COMPLEX"
  );

  const source = JSON.stringify(inbound());
  const exactLimitSource = `${source}${" ".repeat(MAX_APPLICATION_CONTRACT_BYTES - Buffer.byteLength(source, "utf8"))}`;
  assert.equal(Buffer.byteLength(exactLimitSource, "utf8"), MAX_APPLICATION_CONTRACT_BYTES);
  assert.doesNotThrow(() => parseApplicationEnvelopeV1(exactLimitSource));
  assert.throws(
    () => parseApplicationEnvelopeV1(`${exactLimitSource} `),
    (error: unknown) => error instanceof ApplicationContractValidationError && error.code === "APPLICATION_CONTRACT_TOO_LARGE"
  );
});

test("wire descriptor safety preserves plain-container and freezing behavior", () => {
  const nullPrototypePayload = Object.assign(Object.create(null) as Record<string, unknown>, { nested: { value: true } });
  const normalized = validateInboundEnvelopeV1(inbound({ payload: nullPrototypePayload as InboundEnvelopeV1["payload"] }));
  assert.deepEqual(normalized.payload, { nested: { value: true } });
  assert.equal(Object.isFrozen(normalized.payload), true);
  assert.equal(Object.isFrozen((normalized.payload as { nested: object }).nested), true);

  const sparse = new Array<unknown>(1);
  assert.throws(() => validateInboundEnvelopeV1(inbound({ payload: sparse })), /sparse entries/u);
  const nonEnumerable = [true];
  Object.defineProperty(nonEnumerable, "0", { enumerable: false, value: true });
  assert.throws(() => validateInboundEnvelopeV1(inbound({ payload: nonEnumerable })), /enumerable data field/u);
  const outOfRange = [true];
  Object.defineProperty(outOfRange, "4294967295", { enumerable: true, value: false });
  assert.throws(() => validateInboundEnvelopeV1(inbound({ payload: outOfRange })), /out-of-range numeric field/u);
  const exoticArray = [true];
  Object.setPrototypeOf(exoticArray, null);
  assert.throws(() => validateInboundEnvelopeV1(inbound({ payload: exoticArray })), /plain array/u);
});

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

test("validation preserves first-failure message, code, and path", () => {
  assert.throws(
    () => validateExecutionRequestV1({ ...request(), version: 2, actor: "untrusted" }),
    (error: unknown) => error instanceof ApplicationContractValidationError
      && error.message === "execution request contains unknown field: actor"
      && error.code === "UNKNOWN_APPLICATION_FIELD"
      && error.path === "execution request.actor"
  );
  assert.throws(
    () => validateExecutionResultV1({ ...completedResult(), status: "failed" }),
    (error: unknown) => error instanceof ApplicationContractValidationError
      && error.message === "failed result requires a matching normalized error and no uncertainty"
      && error.code === "INVALID_EXECUTION_RESULT"
      && error.path === undefined
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
    completedResult(requestValue, { operation: { kind: "tool", id: "process.exec" } }),
    completedResult(requestValue, { cancellationControlReference: "cancel:other" }),
    completedResult(requestValue, { requestDigest: digestA }),
    completedResult(requestValue, { operationDigest: digestA })
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

test("execution result status matrix retains approval, admission, uncertainty, output, and error semantics", () => {
  const requestValue = validateExecutionRequestV1(request());
  const withoutAdmission = {
    executionEnvelopeReference: undefined,
    executionEnvelopeDigest: undefined,
    runId: undefined,
    attemptId: undefined,
    admittedAt: undefined
  } as const;
  const withoutOutput = { outputReference: undefined, outputDigest: undefined } as const;
  const uncertain = {
    state: "needs-review",
    reasonCode: "DISPATCH_DID_NOT_STOP",
    recoveryReference: "recovery:001",
    physicalExecutionPending: true,
    retryAllowed: false
  } as const;
  const pendingApproval = {
    state: "pending",
    approvalReference: "approval:claim-1",
    operationDigest: digestExecutionOperationV1(requestValue),
    expiresAt: "2026-08-11T12:05:00.000Z"
  } as const;

  const completed = completedResult(requestValue);
  const failed = completedResult(requestValue, { status: "failed", ...withoutOutput, errorCode: "DEPENDENCY_FAILURE" });
  const cancelled = completedResult(requestValue, { status: "cancelled", ...withoutOutput });
  const awaitingApproval = completedResult(requestValue, { status: "awaiting-approval", approval: pendingApproval, ...withoutAdmission, ...withoutOutput });
  const needsReview = completedResult(requestValue, { status: "needs-review", uncertainty: uncertain, ...withoutOutput });
  const denied = completedResult(requestValue, { status: "denied", approval: { state: "denied" }, ...withoutAdmission, ...withoutOutput, errorCode: "APPROVAL_DENIED" });
  const validResults: readonly ExecutionResultV1[] = [
    completed,
    { ...failed, output: undefined, error: { code: "DEPENDENCY_FAILURE", message: "provider unavailable", category: "dependency", retryable: true } },
    { ...cancelled, output: undefined },
    { ...awaitingApproval, output: undefined },
    { ...needsReview, output: undefined },
    { ...denied, output: undefined, error: { code: "APPROVAL_DENIED", message: "approval denied", category: "authorization", retryable: false } }
  ];
  for (const result of validResults) assert.doesNotThrow(() => validateExecutionResultV1(result), result.status);

  const query = validateExecutionRequestV1(request({ operation: { kind: "query", id: "status.read" } }));
  const queryCompleted = completedResult(query, withoutAdmission);
  assert.doesNotThrow(() => validateExecutionResultV1(queryCompleted));
  assert.throws(
    () => validateExecutionResultV1({ ...queryCompleted, status: "needs-review", uncertainty: uncertain, receipt: { ...queryCompleted.receipt, status: "needs-review", uncertainty: uncertain }, output: undefined }),
    /read-only query cannot report an uncertain physical execution/u
  );
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
  const compoundSensitiveKeys = [
    "databasePassword",
    "database_password",
    "DATABASEPASSWORD",
    "databasePasswordValue",
    "databasePasswordDigest",
    "databasepassworddigest",
    "passwordCiphertext",
    "passwordencoded",
    "sessionCookie",
    "session-cookie",
    "sessionCookieHeader",
    "oauthCredential",
    "oauth_credential",
    "oauthCredentialMaterial",
    "authHeader",
    "authToken",
    "servicePrivateKey",
    "service_private_key",
    "servicePrivateKeyPem",
    "httpAuthorization",
    "httpAuthorizationHeader",
    "clientSecretValue",
    "clientsecrethash",
    "tokendigestsha256",
    "passwordhashhex",
    "passwordciphertextbase64",
    "privatekeyfingerprint",
    "clientsecretvaluebase64",
    "oauthcredentialmaterialsha256",
    "dbPwd",
    "oauthCred"
  ];
  for (const key of compoundSensitiveKeys) {
    assert.equal(isSensitiveApplicationMetadataKey(key), true, key);
    assert.throws(
      () => validateExecutionResultV1({ ...base, error: { ...base.error, redactedDetails: { [key]: "compound-secret-sentinel" } } }),
      (error: unknown) => error instanceof ApplicationContractValidationError && error.code === "UNREDACTED_APPLICATION_METADATA",
      key
    );
    assert.doesNotThrow(() => validateExecutionResultV1({ ...base, error: { ...base.error, redactedDetails: { [key]: "[redacted]" } } }));
  }
  const genericSensitiveProjectionMetadata = {
    credentialPresent: true,
    credentialConfigured: true,
    tokenEnv: "ODINN_CHANNEL_TOKEN",
    apiKeyEnv: "ODINN_PROVIDER_API_KEY",
    authMode: "oauth",
    authentication: "mutual-tls",
    secretsExcludedFromDiagnostics: true,
    secretReferences: 0,
    authorizationDecisionReferences: ["decision-1"],
    cookiePolicy: "strict",
    authorizationStatus: "allowed"
  };
  for (const [key, value] of Object.entries(genericSensitiveProjectionMetadata)) {
    assert.equal(isSensitiveApplicationMetadataKey(key), true, key);
    assert.throws(
      () => validateExecutionResultV1({ ...base, error: { ...base.error, redactedDetails: { nested: [{ [key]: value }] } } }),
      (error: unknown) => error instanceof ApplicationContractValidationError && error.code === "UNREDACTED_APPLICATION_METADATA",
      key
    );
  }
  const ambiguousKeys = [
    "passw\u043erd",
    "t\u043eken",
    "secr\u0435t",
    "\uff50\uff41\uff53\uff53\uff57\uff4f\uff52\uff44",
    "pass\u200bword"
  ];
  for (const key of ambiguousKeys) {
    assert.equal(isSensitiveApplicationMetadataKey(key), true, key);
    assert.throws(
      () => validateExecutionResultV1({ ...base, error: { ...base.error, redactedDetails: { nested: [{ [key]: "ambiguous-secret-sentinel" }] } } }),
      (error: unknown) => error instanceof ApplicationContractValidationError && error.code === "AMBIGUOUS_APPLICATION_METADATA_KEY",
      key
    );
  }
  const safeMetadata = {
    secretary: "Alice",
    tokenize: false,
    monkey: 1,
    privateNetworkAccess: false
  };
  for (const key of Object.keys(safeMetadata)) assert.equal(isSensitiveApplicationMetadataKey(key), false, key);
  assert.doesNotThrow(() => validateExecutionResultV1({ ...base, error: { ...base.error, redactedDetails: safeMetadata } }));
  let objectAccessorInvoked = false;
  const objectAccessor = {};
  Object.defineProperty(objectAccessor, "authentication", {
    enumerable: true,
    get() {
      objectAccessorInvoked = true;
      return "ACCESSOR_SECRET_SENTINEL";
    }
  });
  assert.throws(
    () => validateExecutionResultV1({ ...base, error: { ...base.error, redactedDetails: objectAccessor } }),
    (error: unknown) => error instanceof ApplicationContractValidationError && error.code === "NON_JSON_APPLICATION_FIELD"
  );
  assert.equal(objectAccessorInvoked, false);
  let arrayAccessorInvoked = false;
  const arrayAccessor: unknown[] = [];
  Object.defineProperty(arrayAccessor, "0", {
    enumerable: true,
    get() {
      arrayAccessorInvoked = true;
      return { authentication: "ARRAY_ACCESSOR_SECRET_SENTINEL" };
    }
  });
  arrayAccessor.length = 1;
  assert.throws(
    () => validateExecutionResultV1({ ...base, error: { ...base.error, redactedDetails: { nested: arrayAccessor } } }),
    (error: unknown) => error instanceof ApplicationContractValidationError && error.code === "NON_JSON_APPLICATION_FIELD"
  );
  assert.equal(arrayAccessorInvoked, false);
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
  for (const [envelopeValue, receiptValue] of [
    [{ ...outbound, envelopeId: "outbound:other" }, delivery],
    [{ ...outbound, correlationId: "correlation:other" }, delivery],
    [{ ...outbound, payload: { text: "changed" } }, delivery],
    [outbound, { ...delivery, envelopeId: "outbound:other" }],
    [outbound, { ...delivery, correlationId: "correlation:other" }],
    [outbound, { ...delivery, envelopeDigest: digestA }]
  ] as const) {
    assert.throws(
      () => assertChannelDeliveryReceiptMatchesEnvelopeV1(envelopeValue, receiptValue),
      (error: unknown) => error instanceof ApplicationContractValidationError && error.code === "CHANNEL_RECEIPT_BINDING_MISMATCH"
    );
  }
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
      return { ...structuredClone(readContractFixtures.statusCli), omitted: undefined } as any;
    }
  });
  const result = await statusRead.execute(request);
  assert.equal(result.requestId, request.requestId);
  assert.equal(result.correlationId, request.context.correlationId);
  assert.deepEqual(observedContext, request.context);
  assert.deepEqual(result.output, readContractFixtures.statusCli);
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
      return structuredClone(readContractFixtures.statusGateway);
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
      return { ...structuredClone(readContractFixtures.diagnostics), omitted: undefined } as any;
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
  assert.deepEqual(result.output, readContractFixtures.diagnostics);
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
      return { ...structuredClone(readContractFixtures.sessionPage), omitted: undefined } as any;
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
  assert.deepEqual(result.output, readContractFixtures.sessionPage);
  assert.equal(Object.isFrozen(observedInput), true);
  assert.equal(Object.isFrozen(observedContext), true);
  assert.equal(Object.isFrozen(result.output), true);
  assert.equal(Object.isFrozen(result.output.sessions[0]), true);
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

test("versioned read-model golden fixtures retain CLI and gateway compatibility shapes", () => {
  const statusCli = parseStatusSnapshotV1(JSON.stringify(readContractFixtures.statusCli));
  const statusGateway = parseStatusSnapshotV1(JSON.stringify(readContractFixtures.statusGateway));
  const diagnostics = parseDiagnosticsReportV1(JSON.stringify(readContractFixtures.diagnostics));
  const sessionPage = parseSessionPageV1(JSON.stringify(readContractFixtures.sessionPage));
  assert.deepEqual(statusCli, readContractFixtures.statusCli);
  assert.deepEqual(statusGateway, readContractFixtures.statusGateway);
  assert.deepEqual(diagnostics, readContractFixtures.diagnostics);
  assert.deepEqual(sessionPage, readContractFixtures.sessionPage);
  assert.equal(Object.isFrozen(statusCli), true);
  assert.equal(Object.isFrozen((statusGateway as any).toolDetails[0]), true);
  assert.equal(Object.isFrozen(diagnostics.sandbox.configured), true);
  assert.equal(Object.isFrozen(sessionPage.sessions[0]), true);
});

test("status output contract rejects missing, extra, mistyped, accessor, and leaking fields", () => {
  const fixture: any = structuredClone(readContractFixtures.statusGateway);
  const { allowedTools: _missing, ...missing } = fixture;
  assert.throws(() => validateStatusSnapshotV1(missing), /missing required field: allowedTools/u);
  assert.throws(() => validateStatusSnapshotV1({ ...fixture, kernelRegistry: {} }), /unknown field: kernelRegistry/u);
  assert.throws(() => validateStatusSnapshotV1({ ...fixture, ok: "yes" }), /status snapshot\.ok must be true/u);
  const telemetry = {
    enabled: true,
    state: "running",
    exporterState: "idle",
    queued: 1,
    accepted: 3,
    exported: 2,
    dropped: 1,
    rejectedInvalid: 1,
    rejectedAfterShutdown: 0,
    exportFailures: 0
  };
  assert.doesNotThrow(() => validateStatusSnapshotV1({ ...fixture, telemetry }));
  assert.throws(
    () => validateStatusSnapshotV1({ ...fixture, telemetry: { ...telemetry, enabled: false } }),
    /inconsistent with disabled telemetry/u
  );
  assert.throws(
    () => validateStatusSnapshotV1({ ...fixture, telemetry: { ...telemetry, exported: 4 } }),
    /cannot exceed accepted/u
  );
  assert.throws(
    () => validateStatusSnapshotV1({ ...fixture, telemetry: { ...telemetry, accepted: 2, queued: 1, exported: 2 } }),
    /queued plus exported cannot exceed accepted/u
  );
  assert.throws(
    () => validateStatusSnapshotV1({ ...fixture, telemetry: { ...telemetry, exportFailures: 2, dropped: 1 } }),
    /exportFailures cannot exceed dropped/u
  );
  assert.throws(
    () => validateStatusSnapshotV1({ ...fixture, telemetry: { ...telemetry, enabled: false, state: "disabled", exporterState: "idle", queued: 0, exported: 0, dropped: 0, rejectedInvalid: 0, rejectedAfterShutdown: 0, exportFailures: 0 } }),
    /accepted must be zero when telemetry is disabled/u
  );
  const cliFixture: any = structuredClone(readContractFixtures.statusCli);
  assert.throws(
    () => validateStatusSnapshotV1({ ...cliFixture, providers: [{ ...cliFixture.providers[0], apiKeyEnv: "opaquecredentialvalue1234" }] }),
    (error: unknown) => error instanceof ApplicationContractValidationError && error.code === "UNREDACTED_APPLICATION_METADATA"
  );
  assert.doesNotThrow(() => validateStatusSnapshotV1({
    ...cliFixture,
    providers: [{ ...cliFixture.providers[0], authMode: "cli", baseUrl: "" }]
  }));
  assert.throws(
    () => validateStatusSnapshotV1({ ...cliFixture, providers: [{ ...cliFixture.providers[0], authMode: "api-key", baseUrl: "" }] }),
    /baseUrl must be a non-empty string/u
  );
  assert.throws(
    () => validateStatusSnapshotV1({ ...fixture, accessToken: "top-secret-value" }),
    (error: any) => error instanceof ApplicationContractValidationError && error.code === "UNREDACTED_APPLICATION_METADATA"
  );
  const accessor = structuredClone(fixture);
  Object.defineProperty(accessor, "state", { enumerable: true, get: () => "/stolen" });
  assert.throws(
    () => validateStatusSnapshotV1(accessor),
    (error: any) => error instanceof ApplicationContractValidationError && error.code === "NON_JSON_APPLICATION_FIELD"
  );
  const accessorArray: unknown[] = [];
  let accessorInvoked = false;
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      accessorInvoked = true;
      return "text.echo";
    }
  });
  assert.throws(
    () => validateStatusSnapshotV1({ ...fixture, tools: accessorArray }),
    (error: any) => error instanceof ApplicationContractValidationError && error.code === "NON_JSON_APPLICATION_FIELD"
  );
  assert.equal(accessorInvoked, false);
  const nonEnumerableArray = ["text.echo"];
  Object.defineProperty(nonEnumerableArray, "0", { enumerable: false, value: "text.echo" });
  assert.throws(
    () => validateStatusSnapshotV1({ ...fixture, tools: nonEnumerableArray }),
    (error: any) => error instanceof ApplicationContractValidationError && error.code === "NON_JSON_APPLICATION_FIELD"
  );
  const outOfRangeArray = ["text.echo"];
  Object.defineProperty(outOfRangeArray, "4294967295", { enumerable: true, value: "hidden.kernel.tool" });
  assert.throws(
    () => validateStatusSnapshotV1({ ...fixture, tools: outOfRangeArray }),
    (error: any) => error instanceof ApplicationContractValidationError && error.code === "NON_JSON_APPLICATION_FIELD"
  );
});

test("diagnostics output contract rejects unstable fields and unredacted material", () => {
  const fixture: any = structuredClone(readContractFixtures.diagnostics);
  const legacy = structuredClone(fixture);
  delete legacy.browserEngine;
  assert.doesNotThrow(() => validateDiagnosticsReportV1(legacy));
  const { state: _missing, ...missing } = fixture;
  assert.throws(() => validateDiagnosticsReportV1(missing), /missing required field: state/u);
  assert.throws(() => validateDiagnosticsReportV1({ ...fixture, stateDirectory: "/private/state" }), /unknown field: stateDirectory/u);
  assert.throws(() => validateDiagnosticsReportV1({ ...fixture, jobs: { ...fixture.jobs, failed: "0" } }), /jobs\.failed must be a non-negative safe integer/u);
  for (const browserEngine of [
    { available: false, configured: false, source: "platform" },
    { available: true, configured: true, source: "configured-unverified" },
    { available: true, configured: false, source: "unavailable" }
  ]) {
    assert.throws(
      () => validateDiagnosticsReportV1({ ...fixture, browserEngine }),
      /browserEngine fields are inconsistent/u
    );
  }
  assert.doesNotThrow(() => validateDiagnosticsReportV1({
    ...fixture,
    telemetry: {
      enabled: false,
      state: "disabled",
      exporterState: "idle",
      queued: 0,
      accepted: 0,
      exported: 0,
      dropped: 0,
      rejectedInvalid: 0,
      rejectedAfterShutdown: 0,
      exportFailures: 0
    }
  }));
  assert.throws(
    () => validateDiagnosticsReportV1({ ...fixture, privateKey: "-----BEGIN PRIVATE KEY-----" }),
    (error: any) => error instanceof ApplicationContractValidationError && error.code === "UNREDACTED_APPLICATION_METADATA"
  );
});

test("producer-only plugin details and approval identity/input are omitted without traversal", () => {
  let detailAccessorInvoked = false;
  const details = { foo: "SENTINEL_OPAQUE_SECRET_123456" };
  Object.defineProperty(details, "hidden", {
    enumerable: true,
    get() {
      detailAccessorInvoked = true;
      return "SENTINEL_DETAIL_ACCESSOR_SECRET";
    }
  });
  const channels = validateGatewayChannelDiagnosticsV1([{
    name: "test",
    type: "custom",
    enabled: true,
    running: true,
    state: "connected",
    credentialConfigured: true,
    credentialPresent: true,
    allowlistEntries: 1,
    capabilities: { chatTypes: ["direct"] },
    error: "",
    details
  }]);
  assert.equal("details" in channels[0]!, false);
  assert.equal(detailAccessorInvoked, false);

  let inputAccessorInvoked = false;
  const input = { foo: "SENTINEL_OPAQUE_SECRET_123456" };
  Object.defineProperty(input, "hidden", {
    enumerable: true,
    get() {
      inputAccessorInvoked = true;
      return "SENTINEL_INPUT_ACCESSOR_SECRET";
    }
  });
  const approvals = validatePendingApprovalSummariesV1([{
    id: "approval:1",
    status: "pending",
    actor: "SENTINEL_OPAQUE_ACTOR_123456",
    tool: "browser.click",
    input
  }]);
  assert.equal("input" in approvals[0]!, false);
  assert.equal("actor" in approvals[0]!, false);
  assert.equal(inputAccessorInvoked, false);

  const channel = {
    ...channels[0],
    connectedAt: "2026-08-12T12:00:00.000Z",
    lastEventAt: "2026-08-12T12:01:00.000Z"
  };
  assert.equal(validateGatewayChannelDiagnosticsV1([channel])[0]!.connectedAt, channel.connectedAt);
  for (const [field, value] of [
    ["connectedAt", "SENTINEL_OPAQUE_CONNECTED_AT"],
    ["lastEventAt", "2026-99-99T99:99:99.999Z"]
  ] as const) {
    assert.throws(
      () => validateGatewayChannelDiagnosticsV1([{ ...channel, [field]: value }]),
      (error: any) => error instanceof ApplicationContractValidationError
        && error.code === "INVALID_APPLICATION_READ_CONTRACT"
        && !error.message.includes(value)
    );
  }
});

test("session page contract rejects projection drift, content leakage, and inconsistent cursors", () => {
  const fixture: any = structuredClone(readContractFixtures.sessionPage);
  const [session] = fixture.sessions;
  const { title: _missing, ...missingSession } = session;
  assert.throws(() => validateSessionPageV1({ ...fixture, sessions: [missingSession] }), /missing required field: title/u);
  assert.throws(() => validateSessionPageV1({ ...fixture, sessions: [{ ...session, messages: [{ content: "not part of summary" }] }] }), /unknown field: messages/u);
  assert.throws(() => validateSessionPageV1({ ...fixture, sessions: [{ ...session, messageCount: -1 }] }), /messageCount must be a non-negative safe integer/u);
  for (const field of ["createdAt", "updatedAt", "lastEventAt"] as const) {
    const invalid = `NOT_A_TIMESTAMP_${field}\0SENTINEL`;
    assert.throws(
      () => validateSessionPageV1({ ...fixture, sessions: [{ ...session, [field]: invalid }] }),
      (error: any) => error instanceof ApplicationContractValidationError
        && error.code === "INVALID_APPLICATION_READ_CONTRACT"
        && error.path === `session page.sessions[0].${field}`
        && !error.message.includes(invalid)
    );
  }
  assert.throws(() => validateSessionPageV1({ sessions: fixture.sessions, nextCursor: fixture.nextCursor }), /cursor and hasMore must appear together/u);
  assert.throws(
    () => validateSessionPageV1({ ...fixture, authToken: "Bearer abcdefghijklmnop" }),
    (error: any) => error instanceof ApplicationContractValidationError && error.code === "UNREDACTED_APPLICATION_METADATA"
  );
  assert.throws(() => parseSessionPageV1('{"sessions":[],"sessions":[]}'), /duplicate JSON object field/u);
  const deeplyNested = `{"sessions":${"[".repeat(10_000)}null${"]".repeat(10_000)}}`;
  assert.throws(
    () => parseSessionPageV1(deeplyNested),
    (error: any) => error instanceof ApplicationContractValidationError && error.code === "APPLICATION_JSON_TOO_DEEP"
  );
});

test("CLI and gateway producers compile against the explicit read contracts", () => {
  const repositoryRoot = join(import.meta.dirname, "..");
  for (const workspace of ["@odinn/gateway", "@odinn/cli"]) {
    const result = spawnPnpmSync(["--filter", workspace, "typecheck"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, `${workspace} typecheck failed:\n${result.stdout}\n${result.stderr}`);
  }
});

test("application package resolves independently and excludes implementation dependencies", () => {
  const packageRoot = join(import.meta.dirname, "..", "packages", "application");
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  assert.deepEqual(Object.keys(packageJson.dependencies ?? {}), []);
  const sourceRoot = join(packageRoot, "src");
  const sourceFiles = readdirSync(sourceRoot, { encoding: "utf8", recursive: true })
    .filter((file) => file.endsWith(".ts"))
    .sort();
  const source = sourceFiles.map((file) => readFileSync(join(sourceRoot, file), "utf8")).join("\n");
  assert.doesNotMatch(source, /discord\.js|@slack|telegram|whatsapp|express|playwright|apps\/gateway|apps\/cli|packages\/kernel/u);
  assert.equal(sourceFiles.includes("validation/index.ts"), false);
  const validationSources = sourceFiles
    .filter((file) => file.startsWith("validation/"))
    .map((file) => readFileSync(join(sourceRoot, file), "utf8"))
    .join("\n");
  assert.doesNotMatch(validationSources, /from ["']\.\.\/(?:index|validation)\.ts["']/u);
  assert.doesNotMatch(readFileSync(join(packageRoot, "src", "contracts.ts"), "utf8"), /\b(?:AbortSignal|Request|Response|Buffer|Readable|Writable)\b/u);
  const probe = spawnSync(process.execPath, ["--input-type=module", "--eval", "const application = await import('@odinn/application'); if (application.APPLICATION_CONTRACT_VERSION !== 1) process.exit(2);"], { cwd: packageRoot, encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
});
