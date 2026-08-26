import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayServer } from "../apps/gateway/src/server.ts";
import { withGatewayTestHooks } from "../apps/gateway/src/testing.ts";
import {
  createGatewayTelemetry,
  gatewayToolTelemetryCategory,
  instrumentAuditStore,
  recordGatewayEvent,
  recordGatewayTelemetryHealth,
  telemetryStatusProjection
} from "../apps/gateway/src/telemetry.ts";

test("gateway telemetry is disabled without explicit endpoint configuration", async () => {
  const telemetry = createGatewayTelemetry({ environment: {}, serviceVersion: "1.2.3" });
  assert.equal(telemetry.enabled, false);
  assert.equal(recordGatewayEvent(telemetry, {
    name: "odinn.runtime.lifecycle",
    attributes: { component: "gateway", operation: "startup", outcome: "ready" }
  }), false);
  assert.deepEqual(telemetryStatusProjection(telemetry), {
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
  });
  await telemetry.shutdown();
});

test("gateway telemetry activates only through a policy-valid explicit endpoint", async () => {
  const requests: string[] = [];
  const telemetry = createGatewayTelemetry({
    environment: { ODINN_OTLP_ENDPOINT: "http://127.0.0.1:4318/" },
    serviceVersion: "1.2.3",
    fetch: (async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(null, { status: 200 });
    }) as typeof fetch
  });
  assert.equal(telemetry.enabled, true);
  assert.equal(recordGatewayEvent(telemetry, {
    name: "odinn.runtime.lifecycle",
    attributes: { component: "gateway", operation: "startup", outcome: "ready" }
  }), true);
  assert.equal(await telemetry.flush(), true);
  assert.deepEqual(requests, ["http://127.0.0.1:4318/v1/logs"]);
  await telemetry.shutdown();
  assert.throws(
    () => createGatewayTelemetry({ environment: { ODINN_OTLP_ENDPOINT: "http://collector.example/" } }),
    /loopback/u
  );
});

test("Gateway telemetry health reports drop counters as deltas", () => {
  const metrics: any[] = [];
  let dropped = 3;
  const telemetry: any = {
    enabled: true,
    status: () => ({
      state: "running",
      exporterState: "idle",
      queued: 2,
      inFlight: 1,
      accepted: 0,
      exported: 0,
      droppedOverflow: dropped,
      droppedExportFailure: 0,
      rejectedInvalid: 0,
      rejectedAfterShutdown: 0,
      exportFailures: 0,
      consecutiveFailures: 0,
      queuedBytes: 0,
      inFlightBytes: 0
    }),
    recordMetric: (input: any) => { metrics.push(input); return true; }
  };
  recordGatewayTelemetryHealth(telemetry);
  recordGatewayTelemetryHealth(telemetry);
  dropped = 4;
  recordGatewayTelemetryHealth(telemetry);
  assert.deepEqual(
    metrics.filter((metric) => metric.name === "odinn.export.dropped").map((metric) => metric.value),
    [3, 1]
  );
  assert.deepEqual(
    metrics.filter((metric) => metric.name === "odinn.queue.depth").map((metric) => metric.value),
    [3, 3, 3]
  );
});

test("Gateway telemetry health retains an unadmitted drop watermark", () => {
  const counters: number[] = [];
  let dropped = 3;
  let firstGauge = true;
  let admitCounter = false;
  const telemetry: any = {
    enabled: true,
    status: () => ({
      state: "running",
      exporterState: "idle",
      queued: 1,
      inFlight: 0,
      accepted: 1,
      exported: 0,
      droppedOverflow: dropped,
      droppedExportFailure: 0,
      rejectedInvalid: 0,
      rejectedAfterShutdown: 0,
      exportFailures: 0,
      consecutiveFailures: 0,
      queuedBytes: 0,
      inFlightBytes: 0
    }),
    recordMetric: (input: any) => {
      if (input.name === "odinn.queue.depth") {
        if (firstGauge) {
          firstGauge = false;
          dropped += 1;
        }
        return true;
      }
      if (!admitCounter) return false;
      counters.push(input.value);
      return true;
    }
  };
  recordGatewayTelemetryHealth(telemetry);
  admitCounter = true;
  recordGatewayTelemetryHealth(telemetry);
  recordGatewayTelemetryHealth(telemetry);
  assert.deepEqual(counters, [4]);
});

test("audit instrumentation preserves behavior while emitting categorical spans", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const telemetry = createGatewayTelemetry({
    environment: { ODINN_OTLP_ENDPOINT: "https://collector.example/" },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 200 });
    }) as typeof fetch
  });
  const raw = {
    count: 0,
    async append(value: string) {
      this.count += 1;
      if (value === "fail") throw new Error("private audit detail");
      return `stored:${value}`;
    },
    readCount() { return this.count; },
    get currentCount() { return this.count; }
  };
  const store = instrumentAuditStore(raw, telemetry);
  assert.equal(await store.append("ok"), "stored:ok");
  await assert.rejects(store.append("fail"), /private audit detail/u);
  assert.equal(store.readCount(), 2);
  assert.equal(store.currentCount, 2);
  assert.equal(await telemetry.flush(), true);
  assert.equal(requests.length, 2);
  const spans = requests.flatMap((request) => request.body.resourceSpans[0].scopeSpans[0].spans);
  assert.deepEqual(spans.map((span: any) => span.name), ["odinn.audit.append", "odinn.audit.append"]);
  assert.deepEqual(spans.map((span: any) => span.status.code), [1, 2]);
  assert.doesNotMatch(JSON.stringify(requests), /private audit detail/u);
  await telemetry.shutdown();
});

test("Gateway activation exports content-free request and bounded shutdown telemetry", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-gateway-telemetry-"));
  const requests: Array<{ url: string; body: any }> = [];
  const telemetry = createGatewayTelemetry({
    environment: { ODINN_OTLP_ENDPOINT: "http://127.0.0.1:4318/" },
    serviceVersion: "1.2.3",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 200 });
    }) as typeof fetch
  });
  const previousAuth = process.env.ODINN_GATEWAY_AUTH;
  process.env.ODINN_GATEWAY_AUTH = "off";
  const server: any = await createGatewayServer({ stateDir: join(root, "state"), workspaceRoot: root, telemetry });
  try {
    const startupStatus = server.odinnTelemetryStatus();
    assert.equal(startupStatus.enabled, true);
    assert.equal(startupStatus.state, "running");
    assert.ok(["idle", "exporting"].includes(startupStatus.exporterState));
    assert.ok(startupStatus.queued <= 1);
    assert.equal(startupStatus.dropped, 0);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("gateway did not bind");
    const response = await fetch(`http://127.0.0.1:${address.port}/status`);
    assert.equal(response.status, 200);
    const status = await response.json() as any;
    assert.equal(status.telemetry.enabled, true);
    assert.equal(typeof status.telemetry.accepted, "number");
    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/diagnostics`);
    assert.equal(diagnosticsResponse.status, 200);
    const diagnostics = await diagnosticsResponse.json() as any;
    assert.equal(diagnostics.telemetry.enabled, true);
    assert.equal(typeof diagnostics.telemetry.dropped, "number");
    await new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve()));
    const payload = JSON.stringify(requests);
    assert.match(payload, /odinn\.runtime\.lifecycle/u);
    assert.match(payload, /odinn\.task/u);
    assert.match(payload, /odinn\.shutdown/u);
    assert.doesNotMatch(payload, /\/status|x-odinn-request-id|state\/|ODINN_OTLP_ENDPOINT/u);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousAuth === undefined) delete process.env.ODINN_GATEWAY_AUTH;
    else process.env.ODINN_GATEWAY_AUTH = previousAuth;
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway telemetry maps registered tools to fixed categories and rejects attacker labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-gateway-telemetry-labels-"));
  const requests: unknown[] = [];
  const telemetry = createGatewayTelemetry({
    environment: { ODINN_OTLP_ENDPOINT: "http://127.0.0.1:4318/" },
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    }) as typeof fetch
  });
  const previousAuth = process.env.ODINN_GATEWAY_AUTH;
  process.env.ODINN_GATEWAY_AUTH = "off";
  const server: any = await createGatewayServer({ stateDir: join(root, "state"), workspaceRoot: root, telemetry });
  try {
    assert.equal(gatewayToolTelemetryCategory("workspace.readText"), "workspace");
    assert.equal(gatewayToolTelemetryCategory("discord.sendMessage"), "channel");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("gateway did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    const attackerLabel = "private.aabbccddeeff00112233445566778899";
    const unknown = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: attackerLabel, input: {} })
    });
    assert.equal(unknown.status, 400);
    await unknown.arrayBuffer();
    const registered = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "workspace.readText", input: { path: "missing.txt" } })
    });
    assert.equal(registered.status, 400);
    await registered.arrayBuffer();
    await telemetry.flush();
    const exported = JSON.stringify(requests);
    assert.doesNotMatch(exported, new RegExp(attackerLabel, "u"));
    assert.match(exported, /"tool\.name"[^}]*"workspace"/u);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousAuth === undefined) delete process.env.ODINN_GATEWAY_AUTH;
    else process.env.ODINN_GATEWAY_AUTH = previousAuth;
    await rm(root, { recursive: true, force: true });
  }
});

test("Unauthenticated job requests cannot poison acceptance telemetry", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-gateway-telemetry-auth-"));
  const requests: unknown[] = [];
  const telemetry = createGatewayTelemetry({
    environment: { ODINN_OTLP_ENDPOINT: "http://127.0.0.1:4318/" },
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    }) as typeof fetch
  });
  const previousAuth = process.env.ODINN_GATEWAY_AUTH;
  delete process.env.ODINN_GATEWAY_AUTH;
  const server: any = await createGatewayServer({ stateDir: join(root, "state"), workspaceRoot: root, telemetry });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("gateway did not bind");
    const response = await fetch(`http://127.0.0.1:${address.port}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: { tool: "text.echo", input: { text: "ignored" } } })
    });
    assert.equal(response.status, 401);
    await response.arrayBuffer();
    await telemetry.flush();
    const exported = JSON.stringify(requests);
    assert.doesNotMatch(exported, /odinn\.run\.acceptance/u);
    assert.match(exported, /odinn\.task/u);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousAuth === undefined) delete process.env.ODINN_GATEWAY_AUTH;
    else process.env.ODINN_GATEWAY_AUTH = previousAuth;
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway shutdown closes admission immediately and remains bounded when telemetry hangs", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-gateway-telemetry-shutdown-"));
  const baseTelemetry = createGatewayTelemetry({ environment: {} });
  const hangingTelemetry: any = {
    enabled: baseTelemetry.enabled,
    recordEvent: (...args: any[]) => (baseTelemetry.recordEvent as any)(...args),
    recordSpan: (...args: any[]) => (baseTelemetry.recordSpan as any)(...args),
    recordMetric: (...args: any[]) => (baseTelemetry.recordMetric as any)(...args),
    status: () => baseTelemetry.status(),
    flush: () => baseTelemetry.flush(),
    shutdown: () => new Promise(() => {})
  };
  const options = withGatewayTestHooks({
    stateDir: join(root, "state"),
    workspaceRoot: root,
    telemetry: hangingTelemetry
  }, { shutdownTimeoutMs: 75 });
  const previousAuth = process.env.ODINN_GATEWAY_AUTH;
  process.env.ODINN_GATEWAY_AUTH = "off";
  const server: any = await createGatewayServer(options);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("gateway did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    const startedAt = Date.now();
    let shutdownError: Error | undefined;
    const closed = new Promise<void>((resolve) => server.close((error?: Error) => {
      shutdownError = error;
      resolve();
    }));
    const admission = await fetch(`${base}/status`).then((response) => response.status).catch(() => 0);
    await closed;
    assert.ok(admission === 0 || admission === 503);
    assert.match(String(shutdownError?.message), /shutdown timed out/u);
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousAuth === undefined) delete process.env.ODINN_GATEWAY_AUTH;
    else process.env.ODINN_GATEWAY_AUTH = previousAuth;
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway shutdown aborts a delayed mutation body before config can change", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-gateway-shutdown-mutation-"));
  const stateDir = join(root, "state");
  const previousAuth = process.env.ODINN_GATEWAY_AUTH;
  process.env.ODINN_GATEWAY_AUTH = "off";
  const server: any = await createGatewayServer(withGatewayTestHooks({ stateDir, workspaceRoot: root }, { shutdownTimeoutMs: 250 }));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("gateway did not bind");
    const editable = await fetch(`http://127.0.0.1:${address.port}/config`).then((response) => response.json()) as any;
    const configPath = join(stateDir, "config.json");
    const before = await readFile(configPath, "utf8");
    const payload = JSON.stringify({
      config: { ...editable.config, defaultModel: "shutdown-must-not-write" },
      fingerprint: editable.fingerprint
    });
    const requestAccepted = new Promise<void>((resolve) => server.once("request", () => resolve()));
    let delayedRequest: ReturnType<typeof httpRequest>;
    const responseStatus = new Promise<number>((resolve) => {
      delayedRequest = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        path: "/config",
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload)
        }
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      delayedRequest.once("error", () => resolve(0));
      delayedRequest.flushHeaders();
    });
    await requestAccepted;
    const closeResult = new Promise<Error | undefined>((resolve) => server.close((error?: Error) => resolve(error)));
    delayedRequest!.end(payload);
    const [status] = await Promise.all([responseStatus, closeResult]);
    assert.ok(status === 0 || status === 503);
    assert.equal(await readFile(configPath, "utf8"), before);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousAuth === undefined) delete process.env.ODINN_GATEWAY_AUTH;
    else process.env.ODINN_GATEWAY_AUTH = previousAuth;
    await rm(root, { recursive: true, force: true });
  }
});
