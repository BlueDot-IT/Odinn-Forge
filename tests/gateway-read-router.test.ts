import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  ApplicationContractValidationError,
  OPERATOR_SNAPSHOT_CHANGED_CODE,
} from "../packages/application/src/index.ts";
import {
  createGatewayDiagnosticsReadRequest,
  createGatewayOperatorSnapshotReadRequest,
  createGatewaySessionListRequest,
  createGatewayStatusReadRequest,
  normalizeHostedUserId,
} from "../apps/gateway/src/http/request-context.ts";
import { gatewayOperatorSnapshotFailure } from "../apps/gateway/src/http/errors.ts";
import { AuthenticatedRouter } from "../apps/gateway/src/http/router.ts";
import { registerApplicationReadRoutes } from "../apps/gateway/src/routes/application-reads.ts";

function responseFixture() {
  const headers = new Map<string, string>();
  let status: number | undefined;
  let body = "";
  return {
    response: {
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
      },
      writeHead(nextStatus: number, nextHeaders: Record<string, string>) {
        status = nextStatus;
        for (const [name, value] of Object.entries(nextHeaders)) headers.set(name.toLowerCase(), value);
      },
      end(value?: string) {
        body = value ?? "";
      },
    },
    headers,
    get status() {
      return status;
    },
    get body() {
      return body;
    },
  };
}

function routeContext(path: string, response: any, signal: AbortSignal) {
  return {
    request: { method: "GET" },
    response,
    url: new URL(`http://127.0.0.1${path}`),
    requestId: "http-request-1",
    applicationRequestId: "application-request-1",
    authentication: "bearer",
    hostedUserId: "alice",
    signal,
  };
}

test("authenticated application read routes are registered once and preserve request context", async () => {
  const calls: Array<{ name: string; request: any; signal?: AbortSignal }> = [];
  const controller = new AbortController();
  const operatorError = new ApplicationContractValidationError(
    "snapshot changed",
    OPERATOR_SNAPSHOT_CHANGED_CODE,
  );
  const dependencies = {
    statusRead: {
      execute: async (request: any, options: { signal?: AbortSignal }) => {
        calls.push({ name: "status", request, signal: options.signal });
        return { output: { ok: true, service: "gateway" } };
      },
    },
    diagnosticsRead: {
      execute: async (request: any, options: { signal?: AbortSignal }) => {
        calls.push({ name: "diagnostics", request, signal: options.signal });
        return { output: { ok: true, issues: [] } };
      },
    },
    sessionList: {
      execute: async (request: any, options: { signal?: AbortSignal }) => {
        calls.push({ name: "sessions", request, signal: options.signal });
        return { output: { sessions: [] } };
      },
    },
    operatorSnapshotRead: {
      execute: async (request: any, options: { signal?: AbortSignal }) => {
        calls.push({ name: "operator", request, signal: options.signal });
        throw operatorError;
      },
    },
  };
  const router = registerApplicationReadRoutes(new AuthenticatedRouter(), dependencies);
  assert.deepEqual(router.definitions(), [
    { method: "GET", path: "/status" },
    { method: "GET", path: "/diagnostics" },
    { method: "GET", path: "/operator" },
    { method: "GET", path: "/operator/snapshot" },
    { method: "GET", path: "/sessions" },
  ]);

  const statusResponse = responseFixture();
  assert.equal(await router.dispatch(routeContext("/status", statusResponse.response, controller.signal)), true);
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(JSON.parse(statusResponse.body), { ok: true, service: "gateway" });

  const diagnosticsResponse = responseFixture();
  assert.equal(await router.dispatch(routeContext("/diagnostics", diagnosticsResponse.response, controller.signal)), true);
  assert.equal(diagnosticsResponse.status, 200);
  assert.deepEqual(JSON.parse(diagnosticsResponse.body), { ok: true, issues: [] });

  const operatorResponse = responseFixture();
  assert.equal(
    await router.dispatch(routeContext("/operator?surface=console&page=2&runtimePage=3&q=needle", operatorResponse.response, controller.signal)),
    true,
  );
  assert.equal(operatorResponse.status, 503);
  assert.equal(operatorResponse.headers.get("retry-after"), "1");
  assert.deepEqual(JSON.parse(operatorResponse.body), {
    ok: false,
    error: "operator snapshot changed while it was being read; retry the request",
    code: OPERATOR_SNAPSHOT_CHANGED_CODE,
    retryable: true,
    requestId: "http-request-1",
  });

  const sessionsResponse = responseFixture();
  const sessionsContext = routeContext("/sessions?limit=20&projectId=project-alpha", sessionsResponse.response, controller.signal);
  assert.equal(await router.dispatch(sessionsContext), true);
  assert.equal(sessionsResponse.status, 200);
  assert.deepEqual(JSON.parse(sessionsResponse.body), { sessions: [] });

  assert.equal(await router.dispatch({ ...routeContext("/missing", responseFixture().response, controller.signal), request: { method: "GET" } }), false);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.signal === controller.signal));
  assert.equal(calls[0]?.request.context.principal.principalId, "host-user:alice");
  assert.equal(calls[0]?.request.context.scope.tenantId, "tenant:alice");
  assert.equal(calls[0]?.request.context.sourceReference, "http:GET:/status");
  assert.equal(calls[2]?.request.input.surface, "console");
  assert.equal(calls[2]?.request.input.page, 2);
  assert.deepEqual(calls[2]?.request.input.pages, { runtime: 3 });
  assert.equal(calls[3]?.request.input.limit, 20);
  assert.equal(calls[3]?.request.input.projectId, "project-alpha");
});

test("read request contexts enforce hosted identity and bind cancellation", () => {
  assert.equal(normalizeHostedUserId("alice_1"), "alice_1");
  assert.throws(() => normalizeHostedUserId("Alice"), /canonical host user identity/u);
  assert.throws(() => normalizeHostedUserId("x"), /canonical host user identity/u);

  const identity = {
    applicationRequestId: "application-request-2",
    hostedUserId: "alice",
    authentication: "bearer",
  };
  const status = createGatewayStatusReadRequest(identity);
  const diagnostics = createGatewayDiagnosticsReadRequest(identity);
  const operator = createGatewayOperatorSnapshotReadRequest({
    ...identity,
    sourcePath: "/operator/snapshot",
    input: { surface: "console", page: 2 },
  });
  const sessions = createGatewaySessionListRequest({ ...identity, limit: 20 });

  for (const request of [status, diagnostics, operator, sessions]) {
    assert.equal(request.requestId, "application-request-2");
    assert.equal(request.context.principal.authenticationReference, "gateway:bearer");
    assert.equal(request.context.scope.tenantId, "tenant:alice");
    assert.equal(request.context.cancellationControlReference, "http:request:application-request-2");
  }
  assert.equal(operator.context.sourceReference, "http:GET:/operator/snapshot");
  assert.equal(sessions.context.sourceReference, "http:GET:/sessions");
});

test("operator snapshot failures are translated without exposing internal error text", () => {
  const failure = gatewayOperatorSnapshotFailure(
    new ApplicationContractValidationError("secret internal state", OPERATOR_SNAPSHOT_CHANGED_CODE),
    "request-3",
  );
  assert.deepEqual(failure, {
    status: 503,
    retryAfter: "1",
    body: {
      ok: false,
      error: "operator snapshot changed while it was being read; retry the request",
      code: OPERATOR_SNAPSHOT_CHANGED_CODE,
      retryable: true,
      requestId: "request-3",
    },
  });
  assert.equal(gatewayOperatorSnapshotFailure(new Error("unrelated"), "request-3"), undefined);
});

test("gateway admits extracted reads only after control-plane authentication and mutation-origin checks", async () => {
  const source = await readFile(join(process.cwd(), "apps/gateway/src/server.ts"), "utf8");
  const authenticationIndex = source.indexOf("if (!authentication)");
  const originIndex = source.indexOf("if (isMutatingMethod(request.method) && !validMutationOrigin");
  const dispatchIndex = source.indexOf("applicationReadRouter.dispatch");
  assert.ok(authenticationIndex >= 0);
  assert.ok(originIndex > authenticationIndex);
  assert.ok(dispatchIndex > originIndex);
  assert.doesNotMatch(source, /url\.pathname === ["']\/status["']/u);
  assert.doesNotMatch(source, /url\.pathname === ["']\/diagnostics["']/u);
  assert.doesNotMatch(source, /request\.method === "GET" && url\.pathname === ["']\/sessions["']/u);
});
