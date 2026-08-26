import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayServer } from "../apps/gateway/src/server.ts";
import {
  createGatewayTelemetry,
  instrumentAuditStore,
  recordGatewayEvent,
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
    dropped: 0
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
    await response.arrayBuffer();
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
