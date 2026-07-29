import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  GATEWAY_PROTOCOL_VERSION,
  GatewayValidationError,
  assertGatewayIdempotencyMatch,
  createGatewayCursor,
  createGatewayIdempotencyBinding,
  negotiateGatewayProtocol,
  parseGatewayWireFrame,
  replayGatewayEvents,
  validateAuthorizedGatewayRequest,
  validateAuthorizedGatewayEvent,
  validateClientDeclaration,
  validateDiscovery,
  validateGatewayEvent,
  validateGatewayFrame,
  validateGatewayRequest,
  validateStructuredError,
  validateTraceparent,
  type GatewayEventFrame,
  type GatewayEventDiscovery,
  type GatewayIdempotencyRecord,
  type GatewayMethodDiscovery
} from "../packages/protocol/src/gateway-v2.ts";
import { GatewayV2Client } from "../packages/protocol/src/gateway-v2-client.ts";
import {
  GATEWAY_V2_JSON_SCHEMA,
  serializeGatewayV2JsonSchema
} from "../packages/protocol/src/gateway-v2-schema.ts";

const methods: GatewayMethodDiscovery[] = [
  { name: "system.status", mutating: false, requiredScopes: ["status:read"] },
  { name: "agent.run", mutating: true, requiredScopes: ["agent:run"] }
];
const events: GatewayEventDiscovery[] = [
  { name: "run.updated", requiredScopes: ["status:read"] }
];
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function request(overrides: Record<string, unknown> = {}) {
  return {
    v: GATEWAY_PROTOCOL_VERSION,
    type: "request",
    id: "req-1",
    method: "system.status",
    ...overrides
  };
}

function event(sequence: number): GatewayEventFrame {
  return {
    v: GATEWAY_PROTOCOL_VERSION,
    type: "event",
    event: "run.updated",
    sequence,
    cursor: createGatewayCursor(sequence),
    data: { state: "running" }
  };
}

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof GatewayValidationError && error.code === code);
}

test("Gateway v2 rejects malformed and non-strict frames", () => {
  expectCode(() => validateGatewayFrame(null), "INVALID_FRAME");
  expectCode(() => validateGatewayFrame(request({ extra: true })), "UNKNOWN_FIELD");
  expectCode(() => validateGatewayFrame(request({ v: 1 })), "UNSUPPORTED_PROTOCOL");
  expectCode(() => validateGatewayFrame({ ...request(), type: "unknown" }), "INVALID_FRAME_TYPE");
  expectCode(() => validateGatewayFrame({
    v: 2,
    type: "response",
    id: "req-1",
    result: {},
    error: { code: "FAILED", message: "failed", retryable: false }
  }), "INVALID_RESPONSE");
  expectCode(() => validateGatewayFrame({
    v: 2,
    type: "response",
    id: "req-1",
    error: { code: "temporary", message: "failed", retryable: true }
  }), "INVALID_ERROR");
});

test("Gateway v2 raw ingress bounds bytes before decoding or parsing", () => {
  const wire = JSON.stringify(request());
  assert.deepEqual(parseGatewayWireFrame(wire), request());
  assert.deepEqual(parseGatewayWireFrame(new TextEncoder().encode(wire)), request());
  expectCode(() => parseGatewayWireFrame(`{${"x".repeat(200)}`, { maxPayloadBytes: 100 }), "PAYLOAD_TOO_LARGE");
  expectCode(() => parseGatewayWireFrame(new Uint8Array([0xff])), "INVALID_UTF8");
  expectCode(() => parseGatewayWireFrame("{"), "INVALID_JSON");
});

test("Gateway v2 negotiates only overlapping valid protocol ranges", () => {
  assert.equal(negotiateGatewayProtocol({ min: 1, max: 2 }, { min: 2, max: 3 }), 2);
  expectCode(() => negotiateGatewayProtocol({ min: 1, max: 1 }, { min: 2, max: 2 }), "INCOMPATIBLE_PROTOCOL");
  expectCode(() => negotiateGatewayProtocol({ min: 3, max: 2 }, { min: 2, max: 2 }), "INVALID_PROTOCOL_RANGE");
});

test("Gateway v2 validates client declarations and discovery", () => {
  assert.deepEqual(validateClientDeclaration({
    role: "agent",
    scopes: ["agent:run"],
    capabilities: [{ name: "events.replay", version: "1" }]
  }), {
    role: "agent",
    scopes: ["agent:run"],
    capabilities: [{ name: "events.replay", version: "1" }]
  });
  assert.deepEqual(validateDiscovery({
    protocol: { min: 2, max: 2 },
    methods,
    events: [{ name: "run.updated", requiredScopes: ["status:read"] }]
  }).methods, methods);
  expectCode(() => validateClientDeclaration({ role: "root", scopes: [], capabilities: [] }), "INVALID_CLIENT_ROLE");
  expectCode(() => validateDiscovery({
    protocol: { min: 2, max: 2 },
    methods: [methods[0], methods[0]],
    events: []
  }), "DUPLICATE_VALUE");
});

test("Gateway v2 enforces discovered method scopes", () => {
  expectCode(
    () => validateAuthorizedGatewayRequest(request(), { methods, grantedScopes: [] }),
    "INSUFFICIENT_SCOPE"
  );
  assert.equal(
    validateAuthorizedGatewayRequest(request(), { methods, grantedScopes: ["status:read"] }).method,
    "system.status"
  );
  expectCode(
    () => validateAuthorizedGatewayRequest(request({ method: "not.discovered" }), { methods, grantedScopes: ["status:read"] }),
    "METHOD_NOT_FOUND"
  );
});

test("Gateway v2 requires bounded idempotency keys for mutating methods", () => {
  expectCode(
    () => validateAuthorizedGatewayRequest(request({ method: "agent.run" }), { methods, grantedScopes: ["agent:run"] }),
    "IDEMPOTENCY_KEY_REQUIRED"
  );
  assert.equal(validateAuthorizedGatewayRequest(request({
    method: "agent.run",
    idempotencyKey: "run-request-0001"
  }), {
    methods,
    grantedScopes: ["agent:run"]
  }).idempotencyKey, "run-request-0001");
  expectCode(
    () => validateAuthorizedGatewayRequest(request({ method: "agent.run", idempotencyKey: "short" }), {
      methods,
      grantedScopes: ["agent:run"]
    }),
    "INVALID_IDEMPOTENCY_KEY"
  );
  expectCode(
    () => validateGatewayRequest(request({ idempotencyKey: "invalid\nkey" })),
    "INVALID_IDEMPOTENCY_KEY"
  );
});

test("Gateway v2 bounds payload bytes and JSON complexity", () => {
  expectCode(() => validateGatewayFrame(request({ params: { text: "x".repeat(200) } }), { maxPayloadBytes: 100 }), "PAYLOAD_TOO_LARGE");
  let nested: unknown = null;
  for (let depth = 0; depth < 34; depth += 1) nested = { nested };
  expectCode(() => validateGatewayRequest(request({ params: nested })), "JSON_COMPLEXITY_EXCEEDED");
  expectCode(() => validateGatewayRequest(request({ params: { invalid: Number.NaN } })), "INVALID_JSON");
});

test("Gateway v2 validates and propagates W3C traceparent", () => {
  assert.equal(validateTraceparent(traceparent), traceparent);
  assert.equal(validateGatewayRequest(request({ traceparent })).traceparent, traceparent);
  expectCode(
    () => validateTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01"),
    "INVALID_TRACEPARENT"
  );
  expectCode(
    () => validateTraceparent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01"),
    "INVALID_TRACEPARENT"
  );
  expectCode(
    () => validateTraceparent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
    "INVALID_TRACEPARENT"
  );
});

test("Gateway v2 enforces monotonic event ordering and matching cursors", () => {
  assert.equal(validateGatewayEvent(event(4), { previousSequence: 3 }).sequence, 4);
  expectCode(() => validateGatewayEvent(event(4), { previousSequence: 4 }), "EVENT_OUT_OF_ORDER");
  expectCode(() => validateGatewayEvent({ ...event(4), cursor: "v2:3" }), "INVALID_REPLAY_CURSOR");
});

test("Gateway v2 event authorization is fail-closed against server metadata", () => {
  assert.equal(validateAuthorizedGatewayEvent(event(1), {
    events,
    grantedScopes: ["status:read"]
  }).event, "run.updated");
  expectCode(() => validateAuthorizedGatewayEvent(event(1), {
    events,
    grantedScopes: []
  }), "INSUFFICIENT_SCOPE");
  expectCode(() => validateAuthorizedGatewayEvent({ ...event(1), event: "other.event" }, {
    events,
    grantedScopes: ["status:read"]
  }), "EVENT_NOT_FOUND");
});

test("Gateway v2 cursor replay is exclusive and rejects unordered stores", () => {
  assert.deepEqual(replayGatewayEvents([event(2), event(3)], {
    afterCursor: "v2:1",
    oldestAvailableSequence: 1,
    newestAvailableSequence: 3
  }).events.map((item) => item.sequence), [2, 3]);
  assert.deepEqual(replayGatewayEvents([], {
    afterCursor: "v2:2",
    oldestAvailableSequence: 1,
    newestAvailableSequence: 2
  }).events, []);
  expectCode(() => replayGatewayEvents([event(2), event(1)]), "EVENT_OUT_OF_ORDER");
  expectCode(() => validateGatewayEvent(event(2), { replayAfterCursor: "v2:2" }), "EVENT_BEFORE_CURSOR");
});

test("Gateway v2 replay pages are bounded and reject stale or future cursors", () => {
  const page = replayGatewayEvents([event(10), event(11), event(12)], {
    afterCursor: "v2:9",
    limit: 2,
    oldestAvailableSequence: 10,
    newestAvailableSequence: 12
  });
  assert.deepEqual(page.events.map((item) => item.sequence), [10, 11]);
  assert.equal(page.nextCursor, "v2:11");
  assert.equal(page.hasMore, true);
  expectCode(() => replayGatewayEvents([event(10)], {
    afterCursor: "v2:8",
    oldestAvailableSequence: 10,
    newestAvailableSequence: 10
  }), "REPLAY_CURSOR_STALE");
  expectCode(() => replayGatewayEvents([event(10)], {
    afterCursor: "v2:11",
    oldestAvailableSequence: 10,
    newestAvailableSequence: 10
  }), "REPLAY_CURSOR_FUTURE");
  expectCode(() => replayGatewayEvents([], {
    afterCursor: "v2:999",
    oldestAvailableSequence: 10,
    newestAvailableSequence: 12
  }), "REPLAY_CURSOR_FUTURE");
  expectCode(() => replayGatewayEvents([event(10)], {
    afterCursor: "v2:9"
  }), "REPLAY_WINDOW_REQUIRED");
  expectCode(() => replayGatewayEvents([event(1)], { limit: 1_001 }), "INVALID_REPLAY_LIMIT");
});

test("Gateway v2 replay enforces aggregate scan and result byte budgets", () => {
  const large = (sequence: number) => ({
    ...event(sequence),
    data: { text: "x".repeat(600_000) }
  });
  const bytePage = replayGatewayEvents([large(1), large(2)], {
    afterCursor: "v2:0",
    limit: 2,
    oldestAvailableSequence: 1,
    newestAvailableSequence: 2
  });
  assert.equal(bytePage.events.length, 1);
  assert.equal(bytePage.hasMore, true);

  const scan = Array.from({ length: 5 }, (_, index) => ({
    ...event(index + 1),
    data: { text: "x".repeat(900_000) }
  }));
  expectCode(() => replayGatewayEvents(scan, {
    afterCursor: "v2:5",
    oldestAvailableSequence: 1,
    newestAvailableSequence: 5
  }), "REPLAY_SCAN_TOO_LARGE");

  const malformedTail = { ...event(3), cursor: "v2:2" };
  const bounded = replayGatewayEvents([event(1), event(2), malformedTail], {
    afterCursor: "v2:0",
    limit: 1,
    oldestAvailableSequence: 1,
    newestAvailableSequence: 3
  });
  assert.deepEqual(bounded.events.map((item) => item.sequence), [1]);
  assert.equal(bounded.hasMore, true);
});

test("Gateway v2 idempotency binding namespaces principals and binds content", () => {
  const first = createGatewayIdempotencyBinding("tenant-1", request({
    method: "agent.run",
    idempotencyKey: "run-request-0001",
    params: { second: 2, first: 1 }
  }));
  const reordered = createGatewayIdempotencyBinding("tenant-1", request({
    method: "agent.run",
    idempotencyKey: "run-request-0001",
    params: { first: 1, second: 2 }
  }));
  assert.equal(first.requestFingerprint, reordered.requestFingerprint);
  assert.equal(first.namespaceKey, reordered.namespaceKey);

  const otherPrincipal = createGatewayIdempotencyBinding("tenant-2", request({
    method: "agent.run",
    idempotencyKey: "run-request-0001",
    params: { first: 1, second: 2 }
  }));
  assert.notEqual(first.namespaceKey, otherPrincipal.namespaceKey);

  const record: GatewayIdempotencyRecord = {
    ...first,
    state: "in-flight",
    expiresAt: "2026-07-30T00:00:00.000Z"
  };
  assert.doesNotThrow(() => assertGatewayIdempotencyMatch(record, reordered));
  const changed = createGatewayIdempotencyBinding("tenant-1", request({
    method: "agent.run",
    idempotencyKey: "run-request-0001",
    params: { first: 2 }
  }));
  expectCode(() => assertGatewayIdempotencyMatch(record, changed), "IDEMPOTENCY_KEY_MISMATCH");
});

test("Gateway v2 reference client checks response correlation and event ordering", async () => {
  const seenTraceparents: Array<string | undefined> = [];
  const client = new GatewayV2Client(async (outbound) => {
    seenTraceparents.push(outbound.traceparent);
    return {
      v: 2,
      type: "response",
      id: outbound.id,
      result: { accepted: true },
      ...(outbound.traceparent === undefined ? {} : { traceparent: outbound.traceparent })
    };
  });
  assert.deepEqual(await client.request("system.status", undefined, { traceparent }), { accepted: true });
  assert.deepEqual(await client.request("system.status"), { accepted: true });
  assert.deepEqual(seenTraceparents, [traceparent, undefined]);
  client.acceptEvent(event(1), { events, grantedScopes: ["status:read"] });
  assert.equal(client.replayCursor, "v2:1");
  expectCode(() => client.acceptEvent(event(1)), "EVENT_OUT_OF_ORDER");

  const mismatched = new GatewayV2Client(async () => ({
    v: 2,
    type: "response",
    id: "other-request",
    result: null
  }));
  await assert.rejects(() => mismatched.request("system.status"), (error: unknown) => (
    error instanceof GatewayValidationError && error.code === "RESPONSE_ID_MISMATCH"
  ));

  const failed = new GatewayV2Client(async (outbound) => ({
    v: 2,
    type: "response",
    id: outbound.id,
    error: {
      code: "TEMPORARY_FAILURE",
      message: "retry later",
      retryable: true,
      retryAfterMs: 100,
      details: { upstream: "busy" }
    }
  }));
  await assert.rejects(() => failed.request("system.status"), (error: unknown) => (
    error instanceof GatewayValidationError &&
    error.code === "TEMPORARY_FAILURE" &&
    assert.deepEqual(error.details, { upstream: "busy" }) === undefined
  ));
});

test("checked-in Gateway v2 schema is the deterministic source artifact", async () => {
  const artifact = await readFile(
    new URL("../packages/protocol/gateway-v2.schema.json", import.meta.url),
    "utf8"
  );
  assert.equal(serializeGatewayV2JsonSchema(), artifact);
  assert.deepEqual(JSON.parse(artifact), GATEWAY_V2_JSON_SCHEMA);
  assert.deepEqual(JSON.parse(serializeGatewayV2JsonSchema()), JSON.parse(artifact));
});

test("runtime enforces semantic relationships and JavaScript string bounds beyond schema syntax", () => {
  expectCode(() => validateGatewayEvent({ ...event(2), cursor: "v2:1" }), "INVALID_REPLAY_CURSOR");
  expectCode(() => validateStructuredError({
    code: "FAILED",
    message: "😀".repeat(3_000),
    retryable: false
  }), "INVALID_STRING");
});
