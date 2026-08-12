import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  createCachedMcpHost,
  MCP_HOST_MAX_DISCOVERY_BYTES,
  MCP_HOST_MAX_RECEIPT_BYTES,
  MCP_HOST_MAX_SCHEMA_DEPTH,
  type McpCallRequest,
  type McpDiscoveryRequest,
  type McpToolSnapshot
} from "../packages/kernel/src/mcp-host.ts";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    count: { type: "integer", minimum: 1, maximum: 10 },
    message: { type: "string", minLength: 1, maxLength: 20 }
  },
  required: ["message"],
  additionalProperties: false
};

const REVIEW_PROTECTED_IDENTIFIERS = [
  "sessionid", "tokenvalue", "refreshtoken", "jwttoken", "grantref",
  "approvalref", "authorizationref", "grantapproved", "approvalapproved",
  "sessionId", "TOKENVALUE", "refreshToken", "JWTToken", "grantRef",
  "ApprovalRef", "authorizationRef", "GrantApproved", "APPROVALAPPROVED"
] as const;

const REVIEW_SUBJECT_COMPOSITIONS = [
  "clientauth", "oauthclient", "serviceauth", "accountauth", "bearerauth",
  "authorizationoauth", "CLIENTAUTH", "OAUTHCLIENT", "SERVICEAUTH",
  "ACCOUNTAUTH", "BEARERAUTH", "AUTHORIZATIONOAUTH"
] as const;

function discoveryResult(
  request: McpDiscoveryRequest,
  generation = 1,
  tools: unknown[] = [{ name: "notes.create", inputSchema: INPUT_SCHEMA }],
  validForMs = 1_000
): string {
  return JSON.stringify({
    schemaVersion: 1,
    requestId: request.requestId,
    serverId: request.serverId,
    generation,
    validForMs,
    tools
  });
}

function completedReceiptObject(request: McpCallRequest): Record<string, unknown> {
  return {
    schemaVersion: 1,
    callId: request.callId,
    principalNamespace: request.principalNamespace,
    serverId: request.serverId,
    generation: request.generation,
    snapshotFingerprint: request.snapshotFingerprint,
    toolName: request.toolName,
    toolSchemaFingerprint: request.toolSchemaFingerprint,
    argumentDigest: request.argumentDigest,
    requestDigest: request.requestDigest,
    authorizationRef: "authorization:approved",
    auditRef: "audit:entry-1",
    status: "completed",
    resultRef: "artifact:item-1",
    resultDigest: "a".repeat(64)
  };
}

function completedReceipt(request: McpCallRequest): string {
  return JSON.stringify(completedReceiptObject(request));
}

function paddedUtf8Json(json: string, byteLength: number): Uint8Array {
  const encoded = new TextEncoder().encode(json);
  assert.ok(encoded.byteLength <= byteLength);
  const output = new Uint8Array(byteLength);
  output.fill(0x20);
  output.set(encoded);
  return output;
}

function jsonOnBacking(json: string, backing: ArrayBufferLike): Uint8Array {
  const encoded = new TextEncoder().encode(json);
  assert.ok(encoded.byteLength <= new Uint8Array(backing).byteLength);
  const output = new Uint8Array(backing, 0, encoded.byteLength);
  output.set(encoded);
  return output;
}

function invocation(snapshot: McpToolSnapshot, extra: Record<string, unknown> = {}): any {
  return {
    callId: "call-1",
    principalNamespace: "principal:operator",
    generation: snapshot.generation,
    snapshotFingerprint: snapshot.fingerprint,
    toolName: snapshot.tools[0].name,
    toolSchemaFingerprint: snapshot.tools[0].schemaFingerprint,
    arguments: { message: "hello", count: 2 },
    ...extra
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("subpath resolves while root and active runtime remain isolated", async () => {
  const probe = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "const m=await import('@odinn/kernel/mcp-host'); if(typeof m.createCachedMcpHost!=='function') process.exit(2)"
  ], { cwd: new URL("../apps/cli", import.meta.url), encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const root = await readFile("packages/kernel/src/index.ts", "utf8");
  assert.doesNotMatch(root, /mcp-host/u);
  for (const path of [
    "apps/cli/src/cli.ts",
    "apps/gateway/src/host.ts",
    "packages/runtime/src/task-worker.ts",
    "packages/kernel/src/providers/runtime.ts"
  ]) {
    assert.doesNotMatch(await readFile(path, "utf8"), /mcp-host/u, path);
  }
});

test("import and construction are inert until explicit start", async () => {
  let discoveries = 0;
  let dispatches = 0;
  let clockReads = 0;
  const host = createCachedMcpHost({
    serverId: "local-mcp",
    now: () => { clockReads += 1; return 1_000; },
    discovery: { discover: (request) => { discoveries += 1; return discoveryResult(request); } },
    dispatcher: { dispatch: (request) => { dispatches += 1; return completedReceipt(request); } }
  });
  assert.equal(discoveries, 0);
  assert.equal(dispatches, 0);
  assert.equal(clockReads, 0);
  assert.equal(host.snapshot(), undefined);
  assert.deepEqual(host.status(), {
    lifecycle: "idle",
    snapshotState: "empty",
    discoveryInFlight: false,
    discoveryPhysicallyPending: false,
    logicalCalls: 0,
    physicalCalls: 0,
    pendingPhysicalCalls: 0,
    completedCalls: 0,
    failedCalls: 0,
    uncertainCalls: 0,
    invalidReceipts: 0,
    lateSettlements: 0,
    trackedCallIds: 0
  });
});

test("explicit start is single-flight and publishes canonical immutable snapshots", async () => {
  let release!: (value: string) => void;
  const pending = new Promise<string>((resolve) => { release = resolve; });
  let calls = 0;
  let request!: McpDiscoveryRequest;
  const host = createCachedMcpHost({
    serverId: "local-mcp",
    now: () => 10_000,
    maxStaleMs: 500,
    discovery: {
      discover: (input) => {
        calls += 1;
        request = input;
        return pending;
      }
    },
    dispatcher: { dispatch: () => { throw new Error("unused"); } }
  });
  const first = host.start();
  const second = host.start();
  assert.equal(first, second);
  assert.equal(calls, 0, "discovery starts after the current stack yields");
  await Promise.resolve();
  assert.equal(calls, 1);
  release(discoveryResult(request, 4, [
    { name: "zeta.read", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } },
    { name: "alpha.read", inputSchema: INPUT_SCHEMA }
  ], 1_000));
  const snapshot = await first;
  assert.equal(snapshot.generation, 4);
  assert.equal(snapshot.discoveredAtMs, 10_000);
  assert.equal(snapshot.expiresAtMs, 11_000);
  assert.equal(snapshot.staleUntilMs, 11_500);
  assert.deepEqual(snapshot.tools.map((tool) => tool.name), ["alpha.read", "zeta.read"]);
  assert.match(snapshot.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.tools), true);
  assert.equal(Object.isFrozen(snapshot.tools[0].inputSchema), true);
  assert.throws(() => { (snapshot.tools as any).push("x"); }, TypeError);
  assert.equal(host.status().snapshotState, "fresh");
});

test("strict discovery rejects authority material, schema extensions, non-plain values, and bad generations", async () => {
  const cases: Array<[unknown[], RegExp]> = [
    [[{ name: "auth.token", inputSchema: INPUT_SCHEMA }], /non-sensitive/u],
    [[{ name: "notes.create", inputSchema: { ...INPUT_SCHEMA, description: "text" } }], /unknown field/u],
    [[{ name: "notes.create", inputSchema: { ...INPUT_SCHEMA, properties: { token: { type: "string" } } } }], /unsafe property/u],
    [[{ name: "notes.create", inputSchema: { ...INPUT_SCHEMA, properties: { apiKey: { type: "string" } } } }], /unsafe property/u],
    [[{ name: "notes.create", inputSchema: { ...INPUT_SCHEMA, properties: { endpointUrl: { type: "string" } } } }], /unsafe property/u],
    [[{ name: "notes.create", inputSchema: { ...INPUT_SCHEMA, properties: { clientSecret: { type: "string" } } } }], /unsafe property/u],
    ...[
      "passwordHash", "bearerToken", "authorizationHeader", "cookieValue",
      "credentialValue", "authheader", "oauthsecret", "clientpassword",
      "bearercredential", "passworddigest", "usernamevalue", "PASSWORDHASH",
      "BEARERTOKEN", "AUTHHEADER", "OAUTHSECRET", "CLIENTPASSWORD",
      ...REVIEW_PROTECTED_IDENTIFIERS,
      ...REVIEW_SUBJECT_COMPOSITIONS
    ]
      .map((property): [unknown[], RegExp] => [[{
        name: "notes.create",
        inputSchema: { ...INPUT_SCHEMA, properties: { [property]: { type: "string" } } }
      }], /unsafe property/u]),
    [[{ name: "notes.create", inputSchema: { ...INPUT_SCHEMA, additionalProperties: true } }], /must be false/u],
    [[{ name: "notes.create", inputSchema: { oneOf: [] } }], /allowlisted/u],
    [[{ name: "notes.create", inputSchema: { type: "boolean", minimum: 0 } }], /unknown field/u],
    [[{ name: "notes.create", inputSchema: { type: "string", items: { type: "string" } } }], /unknown field/u],
    [[{ name: "notes.create", inputSchema: { type: "array", items: { type: "string" }, properties: {} } }], /unknown field/u],
    [[{ name: "notes.create", inputSchema: { type: "number", required: [] } }], /unknown field/u]
  ];
  for (const [tools, error] of cases) {
    const host = createCachedMcpHost({
      serverId: "local-mcp",
      discovery: { discover: (request) => discoveryResult(request, 1, tools) },
      dispatcher: { dispatch: () => { throw new Error("unused"); } }
    });
    await assert.rejects(host.start(), error);
  }

  let getterRuns = 0;
  const objectResult = {
    get schemaVersion() {
      getterRuns += 1;
      return 1;
    }
  };
  const objectHost = createCachedMcpHost({
    serverId: "local-mcp",
    discovery: { discover: () => objectResult as any },
    dispatcher: { dispatch: () => { throw new Error("unused"); } }
  });
  await assert.rejects(objectHost.start(), /raw UTF-8 JSON|exact Uint8Array/u);
  assert.equal(getterRuns, 0);

  const deep = { type: "string" } as any;
  let nested = deep;
  for (let index = 0; index <= MCP_HOST_MAX_SCHEMA_DEPTH; index += 1) {
    nested = { type: "array", items: nested };
  }
  const depthHost = createCachedMcpHost({
    serverId: "local-mcp",
    discovery: { discover: (request) => discoveryResult(request, 1, [{ name: "notes.create", inputSchema: nested }]) },
    dispatcher: { dispatch: () => { throw new Error("unused"); } }
  });
  await assert.rejects(depthHost.start(), /exceeds depth/u);

  const duplicateHost = createCachedMcpHost({
    serverId: "local-mcp",
    discovery: { discover: (request) => discoveryResult(request, 1, [
      { name: "notes.create", inputSchema: INPUT_SCHEMA },
      { name: "notes.create", inputSchema: INPUT_SCHEMA }
    ]) },
    dispatcher: { dispatch: () => { throw new Error("unused"); } }
  });
  await assert.rejects(duplicateHost.start(), /duplicate tool/u);

  const benignNamesHost = createCachedMcpHost({
    serverId: "local-mcp",
    discovery: {
      discover: (request) => discoveryResult(request, 1, [{
        name: "notes.create",
        inputSchema: {
          type: "object",
          properties: {
            authorName: { type: "string" },
            hockey: { type: "boolean" },
            keynote: { type: "string" },
            monkey: { type: "integer" },
            sessional: { type: "string" },
            tokenize: { type: "boolean" },
            grantor: { type: "integer" },
            policyholder: { type: "string" },
            clientele: { type: "string" },
            accounting: { type: "integer" },
            serviceable: { type: "boolean" }
          },
          required: [],
          additionalProperties: false
        }
      }])
    },
    dispatcher: { dispatch: () => { throw new Error("unused"); } }
  });
  assert.equal((await benignNamesHost.start()).tools.length, 1);
});

test("credential classifier covers exact subject/material and subject/subject products without substring false positives", () => {
  const subjects = [
    "auth", "authentication", "authorization", "oauth", "client", "bearer",
    "password", "passwd", "username", "cookie", "cookies", "credential",
    "credentials", "api", "token", "tokens", "session", "refresh", "jwt",
    "grant", "approval", "policy", "secret", "secrets", "key", "access",
    "private", "account", "service", "callback", "endpoint", "webhook", "base",
    "internal", "remote", "server", "capability", "permission"
  ];
  const materials = [
    "id", "value", "token", "tokens", "key", "keys", "header", "headers",
    "secret", "secrets", "password", "passwd", "credential", "credentials",
    "digest", "hash", "grant", "session", "ref", "reference", "approved",
    "handle", "cookie", "cookies", "url", "uri", "endpoint", "host", "approval",
    "capability", "permission", "policy"
  ];
  const discovery = { discover: () => "{}" };
  const dispatcher = { dispatch: () => "{}" };
  for (const subject of subjects) {
    for (const material of materials) {
      assert.throws(
        () => createCachedMcpHost({
          serverId: `${subject}${material}`,
          discovery,
          dispatcher
        }),
        /non-sensitive/u,
        `${subject}+${material}`
      );
    }
    for (const laterSubject of subjects) {
      assert.throws(
        () => createCachedMcpHost({
          serverId: `${subject}${laterSubject}`,
          discovery,
          dispatcher
        }),
        /non-sensitive/u,
        `${subject}+${laterSubject}`
      );
    }
  }
  for (const identifier of [
    "clientauthorizationheader",
    "oauthaccesstoken",
    "servicecredentialdigest",
    "authorizationgrantref",
    "refreshsessionhandle",
    "jwttokenvalue",
    "CLIENTAUTHORIZATIONHEADER",
    "OauthAccessToken",
    "AuthorizationGrantRef",
    "RefreshSessionHandle"
  ]) {
    assert.throws(
      () => createCachedMcpHost({ serverId: identifier.toLowerCase(), discovery, dispatcher }),
      /non-sensitive/u,
      identifier
    );
  }
  for (const identifier of [
    "author-name", "hockey", "keynote", "monkey", "turkey", "sessional",
    "tokenize", "grantor", "policyholder", "clientele", "accounting",
    "serviceable"
  ]) {
    assert.doesNotThrow(() => createCachedMcpHost({ serverId: identifier, discovery, dispatcher }), identifier);
  }
});

test("discovery admission bounds raw bytes before parsing and accepts only exact raw envelopes", async () => {
  const validBytesHost = createCachedMcpHost({
    serverId: "local-mcp",
    discovery: { discover: (request) => new TextEncoder().encode(discoveryResult(request)) },
    dispatcher: { dispatch: () => { throw new Error("unused"); } }
  });
  assert.equal((await validBytesHost.start()).generation, 1);

  const oversizedStringHost = createCachedMcpHost({
    serverId: "local-mcp",
    discovery: { discover: (request) => `${discoveryResult(request)}${" ".repeat(MCP_HOST_MAX_DISCOVERY_BYTES)}` },
    dispatcher: { dispatch: () => { throw new Error("unused"); } }
  });
  await assert.rejects(oversizedStringHost.start(), /raw byte limit/u);

  const shadowedHost = createCachedMcpHost({
    serverId: "local-mcp",
    discovery: {
      discover: (request) => {
        const bytes = paddedUtf8Json(discoveryResult(request), MCP_HOST_MAX_DISCOVERY_BYTES + 1);
        Object.defineProperty(bytes, "byteLength", { value: 1 });
        return bytes;
      }
    },
    dispatcher: { dispatch: () => { throw new Error("unused"); } }
  });
  await assert.rejects(shadowedHost.start(), /raw byte limit/u);

  const invalidUtf8Host = createCachedMcpHost({
    serverId: "local-mcp",
    discovery: { discover: () => new Uint8Array([0xc3, 0x28]) },
    dispatcher: { dispatch: () => { throw new Error("unused"); } }
  });
  await assert.rejects(invalidUtf8Host.start(), /valid UTF-8/u);

  const invalidStringHost = createCachedMcpHost({
    serverId: "local-mcp",
    discovery: { discover: () => "{\"bad\":\"\ud800\"}" },
    dispatcher: { dispatch: () => { throw new Error("unused"); } }
  });
  await assert.rejects(invalidStringHost.start(), /valid UTF-8/u);

  class SubclassedBytes extends Uint8Array {}
  const detached = new Uint8Array([0x7b, 0x7d]);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  for (const output of [
    new SubclassedBytes([0x7b, 0x7d]),
    new Proxy(new Uint8Array([0x7b, 0x7d]), {}),
    new Uint8Array(new SharedArrayBuffer(2)),
    detached
  ]) {
    const host = createCachedMcpHost({
      serverId: "local-mcp",
      discovery: { discover: () => output },
      dispatcher: { dispatch: () => { throw new Error("unused"); } }
    });
    await assert.rejects(host.start(), /exact Uint8Array/u);
  }

  const discoveryJson = discoveryResult({
    schemaVersion: 1,
    requestId: "discovery-1",
    serverId: "local-mcp",
    reason: "start"
  });
  const mutatedShared = new SharedArrayBuffer(MCP_HOST_MAX_DISCOVERY_BYTES);
  Object.setPrototypeOf(mutatedShared, ArrayBuffer.prototype);
  const crossRealmShared = runInNewContext(
    `new SharedArrayBuffer(${MCP_HOST_MAX_DISCOVERY_BYTES})`
  ) as SharedArrayBuffer;
  for (const backing of [mutatedShared, crossRealmShared]) {
    const host = createCachedMcpHost({
      serverId: "local-mcp",
      discovery: { discover: () => jsonOnBacking(discoveryJson, backing) },
      dispatcher: { dispatch: () => { throw new Error("unused"); } }
    });
    await assert.rejects(host.start(), /exact Uint8Array/u);
  }
});

test("discovery transport failures expose only a categorical error", async () => {
  const host = createCachedMcpHost({
    serverId: "local-mcp",
    discovery: {
      discover: () => {
        throw new Error("https://private.internal bearer secret-token-value");
      }
    },
    dispatcher: { dispatch: () => { throw new Error("unused"); } }
  });
  await assert.rejects(host.start(), (error: Error) => {
    assert.equal(error.message, "MCP discovery transport failed");
    assert.doesNotMatch(error.message, /private|bearer|secret|token|https/u);
    return true;
  });
});

test("refresh is explicit, monotonic, and invocation never discovers", async () => {
  let now = 1_000;
  let generation = 0;
  let discoveries = 0;
  const host = createCachedMcpHost({
    serverId: "local-mcp",
    now: () => now,
    maxStaleMs: 100,
    discovery: {
      discover: (request) => {
        discoveries += 1;
        generation += 1;
        return discoveryResult(request, generation, undefined, 10);
      }
    },
    dispatcher: { dispatch: (request) => completedReceipt(request) }
  });
  const initial = await host.start();
  now = 1_010;
  assert.equal(host.status().snapshotState, "stale");
  await assert.rejects(host.invoke(invocation(initial)), /explicit refresh/u);
  assert.equal(discoveries, 1);
  now = 1_111;
  assert.equal(host.status().snapshotState, "expired");
  await assert.rejects(host.invoke(invocation(initial)), /explicit refresh/u);
  assert.equal(discoveries, 1);
  const refreshed = await host.refresh();
  assert.equal(refreshed.generation, 2);
  assert.equal(discoveries, 2);
  await assert.rejects(host.invoke(invocation(initial)), /snapshot pin/u);
});

test("invocation validates arguments and accepts only fully content-bound audited receipts", async () => {
  let captured!: McpCallRequest;
  const host = createCachedMcpHost({
    serverId: "local-mcp",
    discovery: { discover: (request) => discoveryResult(request) },
    dispatcher: {
      dispatch: (request) => {
        captured = request;
        return new TextEncoder().encode(completedReceipt(request));
      }
    }
  });
  const snapshot = await host.start();
  const outcome = await host.invoke(invocation(snapshot));
  assert.equal(outcome.status, "completed");
  assert.equal(captured.requiresAuthorization, true);
  assert.equal(captured.requiresAudit, true);
  assert.equal(captured.snapshotFingerprint, snapshot.fingerprint);
  assert.equal(captured.toolSchemaFingerprint, snapshot.tools[0].schemaFingerprint);
  assert.match(captured.argumentDigest, /^[a-f0-9]{64}$/u);
  assert.match(captured.requestDigest, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(captured.arguments), true);
  assert.equal(host.status().completedCalls, 1);

  await assert.rejects(host.invoke(invocation(snapshot, { arguments: { message: "ok", unknown: true } })), /do not match/u);
  await assert.rejects(host.invoke(invocation(snapshot, { arguments: { message: "", count: 2 } })), /do not match/u);
  await assert.rejects(host.invoke(invocation(snapshot, { arguments: { message: "ok", count: 11 } })), /do not match/u);
  await assert.rejects(host.invoke(invocation(snapshot, { toolSchemaFingerprint: "b".repeat(64) })), /tool\/schema pin/u);
  await assert.rejects(host.invoke(invocation(snapshot)), /callId has already been used/u);
});

test("receipt mismatch and dispatch rejection fail once without retry or fallback", async () => {
  let dispatches = 0;
  const host = createCachedMcpHost({
    serverId: "local-mcp",
    discovery: { discover: (request) => discoveryResult(request) },
    dispatcher: {
      dispatch: (request) => {
        dispatches += 1;
        return JSON.stringify({ ...completedReceiptObject(request), requestDigest: "b".repeat(64) });
      }
    }
  });
  const snapshot = await host.start();
  await assert.rejects(host.invoke(invocation(snapshot)), /failed or returned an invalid receipt/u);
  assert.equal(dispatches, 1);
  assert.equal(host.status().invalidReceipts, 1);
  assert.equal(host.status().failedCalls, 1);

  let rejects = 0;
  const rejecting = createCachedMcpHost({
    serverId: "other-mcp",
    discovery: { discover: (request) => discoveryResult(request) },
    dispatcher: { dispatch: () => { rejects += 1; throw new Error("private upstream failure"); } }
  });
  const second = await rejecting.start();
  await assert.rejects(rejecting.invoke(invocation(second)), /failed or returned an invalid receipt/u);
  assert.equal(rejects, 1);
});

test("receipt admission is raw-byte bounded and evidence references are namespace-bound", async () => {
  let getterRuns = 0;
  const objectReceiptHost = createCachedMcpHost({
    serverId: "local-mcp",
    discovery: { discover: (request) => discoveryResult(request) },
    dispatcher: {
      dispatch: () => ({
        get schemaVersion() {
          getterRuns += 1;
          return 1;
        }
      }) as any
    }
  });
  const objectSnapshot = await objectReceiptHost.start();
  await assert.rejects(objectReceiptHost.invoke(invocation(objectSnapshot)), /invalid receipt/u);
  assert.equal(getterRuns, 0);

  const oversizedReceiptHost = createCachedMcpHost({
    serverId: "other-mcp",
    discovery: { discover: (request) => discoveryResult(request) },
    dispatcher: {
      dispatch: (request) => {
        const bytes = paddedUtf8Json(completedReceipt(request), MCP_HOST_MAX_RECEIPT_BYTES + 1);
        Object.defineProperty(bytes, "byteLength", { value: 1 });
        return bytes;
      }
    }
  });
  const oversizedSnapshot = await oversizedReceiptHost.start();
  await assert.rejects(oversizedReceiptHost.invoke(invocation(oversizedSnapshot)), /invalid receipt/u);

  for (const patch of [
    { authorizationRef: "grant:approved" },
    { authorizationRef: "authorization:secret-token" },
    { auditRef: "record:entry-1" },
    { auditRef: "audit:credential-key" },
    { resultRef: "result:item-1" },
    { resultRef: "artifact:auth-token" },
    { resultRef: "artifact:grant-approved" },
    { authorizationRef: "authorization:passwordHash" },
    { authorizationRef: "authorization:PASSWORDHASH" },
    { authorizationRef: "authorization:grantApproved" },
    { auditRef: "audit:bearerToken" },
    { auditRef: "audit:BEARERTOKEN" },
    { auditRef: "audit:PolicyValue" },
    { resultRef: "artifact:authorizationHeader" },
    { resultRef: "record:cookieValue" },
    { resultRef: "artifact:credentialValue" },
    { authorizationRef: "authorization:authheader" },
    { auditRef: "audit:oauthsecret" },
    { resultRef: "artifact:clientpassword" },
    { resultRef: "record:bearercredential" },
    { resultRef: "artifact:passworddigest" },
    { resultRef: "record:usernamevalue" },
    { authorizationRef: "authorization:AUTHHEADER" },
    { auditRef: "audit:OAUTHSECRET" },
    ...REVIEW_PROTECTED_IDENTIFIERS.flatMap((identifier) => [
      { authorizationRef: `authorization:${identifier}` },
      { auditRef: `audit:${identifier}` },
      { resultRef: `artifact:${identifier}` }
    ]),
    ...REVIEW_SUBJECT_COMPOSITIONS.flatMap((identifier) => [
      { authorizationRef: `authorization:${identifier}` },
      { auditRef: `audit:${identifier}` },
      { resultRef: `artifact:${identifier}` }
    ])
  ]) {
    const host = createCachedMcpHost({
      serverId: "reference-mcp",
      discovery: { discover: (request) => discoveryResult(request) },
      dispatcher: {
        dispatch: (request) => JSON.stringify({ ...completedReceiptObject(request), ...patch })
      }
    });
    const snapshot = await host.start();
    await assert.rejects(host.invoke(invocation(snapshot)), /invalid receipt/u);
    assert.equal(host.status().invalidReceipts, 1);
  }

  const receiptBackings = [
    (() => {
      const backing = new SharedArrayBuffer(MCP_HOST_MAX_RECEIPT_BYTES);
      Object.setPrototypeOf(backing, ArrayBuffer.prototype);
      return backing;
    })(),
    runInNewContext(`new SharedArrayBuffer(${MCP_HOST_MAX_RECEIPT_BYTES})`) as SharedArrayBuffer
  ];
  for (const backing of receiptBackings) {
    const host = createCachedMcpHost({
      serverId: "reference-mcp",
      discovery: { discover: (request) => discoveryResult(request) },
      dispatcher: { dispatch: (request) => jsonOnBacking(completedReceipt(request), backing) }
    });
    const snapshot = await host.start();
    await assert.rejects(host.invoke(invocation(snapshot)), /invalid receipt/u);
  }

  const ordinaryBackingHost = createCachedMcpHost({
    serverId: "ordinary-mcp",
    discovery: { discover: (request) => discoveryResult(request) },
    dispatcher: {
      dispatch: (request) => jsonOnBacking(
        completedReceipt(request),
        new ArrayBuffer(MCP_HOST_MAX_RECEIPT_BYTES)
      )
    }
  });
  const ordinarySnapshot = await ordinaryBackingHost.start();
  assert.equal((await ordinaryBackingHost.invoke(invocation(ordinarySnapshot))).status, "completed");
});

test("timeout retains a physical slot until a non-cooperative dispatcher settles", async () => {
  let release!: (value: string) => void;
  let captured!: McpCallRequest;
  const pending = new Promise<string>((resolve) => { release = resolve; });
  let dispatches = 0;
  const host = createCachedMcpHost({
    serverId: "local-mcp",
    maxConcurrency: 1,
    callTimeoutMs: 10,
    discovery: { discover: (request) => discoveryResult(request) },
    dispatcher: {
      dispatch: (request) => {
        dispatches += 1;
        captured = request;
        return pending;
      }
    }
  });
  const snapshot = await host.start();
  const outcome = await host.invoke(invocation(snapshot));
  assert.deepEqual(outcome, {
    schemaVersion: 1,
    callId: "call-1",
    requestDigest: captured.requestDigest,
    status: "needs-review",
    reason: "timeout",
    physicalPending: true
  });
  assert.equal(host.status().logicalCalls, 0);
  assert.equal(host.status().physicalCalls, 1);
  await assert.rejects(host.invoke(invocation(snapshot, { callId: "call-2" })), /capacity is exhausted/u);
  assert.equal(dispatches, 1);
  release(completedReceipt(captured));
  await waitFor(() => host.status().physicalCalls === 0);
  assert.equal(host.status().lateSettlements, 1);
  assert.equal(host.status().uncertainCalls, 1);
});

test("caller cancellation is uncertain after dispatch and does not reclaim the physical slot", async () => {
  let release!: (value: string) => void;
  let captured!: McpCallRequest;
  const pending = new Promise<string>((resolve) => { release = resolve; });
  const abort = new AbortController();
  const host = createCachedMcpHost({
    serverId: "local-mcp",
    maxConcurrency: 1,
    callTimeoutMs: 1_000,
    discovery: { discover: (request) => discoveryResult(request) },
    dispatcher: { dispatch: (request) => { captured = request; return pending; } }
  });
  const snapshot = await host.start();
  const call = host.invoke(invocation(snapshot, { signal: abort.signal }));
  await waitFor(() => host.status().physicalCalls === 1);
  abort.abort();
  assert.equal((await call as any).reason, "cancelled");
  assert.equal(host.status().physicalCalls, 1);
  release(completedReceipt(captured));
  await waitFor(() => host.status().physicalCalls === 0);
});

test("bounded shutdown marks active work uncertain and reports non-cooperative calls", async () => {
  let release!: (value: string) => void;
  let captured!: McpCallRequest;
  const pending = new Promise<string>((resolve) => { release = resolve; });
  const host = createCachedMcpHost({
    serverId: "local-mcp",
    callTimeoutMs: 1_000,
    shutdownTimeoutMs: 10,
    discovery: { discover: (request) => discoveryResult(request) },
    dispatcher: { dispatch: (request) => { captured = request; return pending; } }
  });
  const snapshot = await host.start();
  const call = host.invoke(invocation(snapshot));
  await waitFor(() => host.status().physicalCalls === 1);
  const shutdown = host.shutdown();
  assert.equal((await call as any).reason, "shutdown");
  assert.deepEqual(await shutdown, {
    stopped: true,
    pendingPhysicalCalls: 1,
    discoveryPhysicallyPending: false
  });
  assert.equal(host.status().lifecycle, "stopped");
  await assert.rejects(host.invoke(invocation(snapshot)), /not running/u);
  release(completedReceipt(captured));
  await waitFor(() => host.status().physicalCalls === 0);
  assert.equal((await host.shutdown()).stopped, true);
});

test("discovery timeout retains its physical single-flight and late results are never published", async () => {
  let release!: (value: string) => void;
  let captured!: McpDiscoveryRequest;
  const pending = new Promise<string>((resolve) => { release = resolve; });
  let calls = 0;
  const host = createCachedMcpHost({
    serverId: "local-mcp",
    discoveryTimeoutMs: 10,
    discovery: {
      discover: (request) => {
        calls += 1;
        captured = request;
        return pending;
      }
    },
    dispatcher: { dispatch: () => { throw new Error("unused"); } }
  });
  await assert.rejects(host.start(), /timed out/u);
  assert.equal(host.status().discoveryPhysicallyPending, true);
  await assert.rejects(host.refresh(), /physically pending/u);
  assert.equal(calls, 1);
  release(discoveryResult(captured));
  await waitFor(() => !host.status().discoveryPhysicallyPending);
  assert.equal(host.snapshot(), undefined);
  assert.equal(host.status().snapshotState, "empty");
});
