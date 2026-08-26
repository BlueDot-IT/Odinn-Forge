import assert from "node:assert/strict";
import test from "node:test";
import { createOtlpHttpExporter, validateOtlpHttpEndpoint } from "../packages/kernel/src/otlp-http-exporter.ts";
import type { TelemetryEnvelope } from "../packages/kernel/src/async-telemetry.ts";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

test("OTLP endpoint policy permits HTTPS and loopback HTTP without URL credentials", () => {
  assert.equal(validateOtlpHttpEndpoint("https://collector.example/otlp").href, "https://collector.example/otlp/");
  assert.equal(validateOtlpHttpEndpoint("http://127.0.0.1:4318/").href, "http://127.0.0.1:4318/");
  assert.throws(() => validateOtlpHttpEndpoint("http://collector.example/"), /loopback/u);
  assert.throws(() => validateOtlpHttpEndpoint("https://user:secret@collector.example/"), /must not contain credentials/u);
  assert.throws(() => validateOtlpHttpEndpoint("https://collector.example/?token=secret"), /query parameters/u);
  assert.throws(() => validateOtlpHttpEndpoint(" https://collector.example/"), /bounded URL/u);
  assert.throws(() => validateOtlpHttpEndpoint("https://collector.example/\n"), /bounded URL/u);
  assert.throws(() => validateOtlpHttpEndpoint("file:///tmp/collector"), /HTTPS or loopback HTTP/u);
});

test("OTLP exporter emits bounded trace, metric, and log JSON without redirects or credentials", async () => {
  const requests: Array<{ url: string; init: RequestInit; body: any }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 200 });
  };
  const exporter = createOtlpHttpExporter({
    endpoint: "https://collector.example/tenant/",
    serviceName: "odinn-gateway",
    serviceVersion: "1.2.3",
    fetch: fakeFetch as typeof fetch
  });
  const batch: TelemetryEnvelope[] = [
    {
      schemaVersion: 1,
      kind: "span",
      name: "odinn.tool.execution",
      timeUnixMs: 1_000,
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      durationMs: 25,
      status: "ok",
      attributes: Object.freeze({ "tool.name": "memory.search", "duration.ms": 25 })
    },
    {
      schemaVersion: 1,
      kind: "metric",
      name: "odinn.queue.depth",
      timeUnixMs: 1_001,
      instrument: "gauge",
      value: 2,
      unit: "1",
      attributes: Object.freeze({ "queue.depth": 2 })
    },
    {
      schemaVersion: 1,
      kind: "event",
      name: "odinn.runtime.lifecycle",
      timeUnixMs: 1_002,
      attributes: Object.freeze({ component: "gateway", operation: "startup", outcome: "ready" })
    }
  ];
  await exporter.export(batch, new AbortController().signal);
  assert.deepEqual(requests.map((request) => request.url), [
    "https://collector.example/tenant/v1/traces",
    "https://collector.example/tenant/v1/metrics",
    "https://collector.example/tenant/v1/logs"
  ]);
  for (const request of requests) {
    assert.equal(request.init.method, "POST");
    assert.equal(request.init.redirect, "error");
    assert.equal(request.init.credentials, "omit");
    assert.equal((request.init.headers as Record<string, string>)["content-type"], "application/json");
  }
  const span = requests[0].body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.startTimeUnixNano, "975000000");
  assert.equal(span.endTimeUnixNano, "1000000000");
  assert.equal(span.status.code, 1);
  assert.equal(span.attributes[0].value.stringValue, "memory.search");
  const metric = requests[1].body.resourceMetrics[0].scopeMetrics[0].metrics[0];
  assert.equal(metric.gauge.dataPoints[0].asDouble, 2);
  const log = requests[2].body.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(log.body.stringValue, "odinn.runtime.lifecycle");
  assert.doesNotMatch(JSON.stringify(requests), /secret|token=/u);
});

test("OTLP exporter settles categorical request failures without copying endpoint details", async () => {
  let requests = 0;
  const exporter = createOtlpHttpExporter({
    endpoint: "https://collector.example/private/",
    fetch: (async () => {
      requests += 1;
      throw new Error("network exposed collector.example/private");
    }) as typeof fetch
  });
  await exporter.export([], new AbortController().signal);
  assert.equal(requests, 0);
  const event: TelemetryEnvelope = {
    schemaVersion: 1,
    kind: "event",
    name: "odinn.runtime.lifecycle",
    timeUnixMs: 1,
    attributes: Object.freeze({})
  };
  assert.deepEqual(await exporter.export([event], new AbortController().signal), {
    exported: 0,
    rejected: 1
  });
});

test("OTLP exporter preserves earlier kind settlement when a later request fails", async () => {
  const requests: string[] = [];
  const exporter = createOtlpHttpExporter({
    endpoint: "https://collector.example/",
    fetch: (async (input: string | URL | Request) => {
      requests.push(String(input));
      return String(input).endsWith("/v1/metrics")
        ? new Response(null, { status: 503 })
        : new Response(null, { status: 200 });
    }) as typeof fetch
  });
  const batch: TelemetryEnvelope[] = [
    {
      schemaVersion: 1,
      kind: "span",
      name: "odinn.tool.execution",
      timeUnixMs: 1,
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      durationMs: 1,
      status: "ok",
      attributes: Object.freeze({})
    },
    {
      schemaVersion: 1,
      kind: "metric",
      name: "odinn.queue.depth",
      timeUnixMs: 2,
      instrument: "gauge",
      value: 1,
      unit: "1",
      attributes: Object.freeze({})
    },
    {
      schemaVersion: 1,
      kind: "event",
      name: "odinn.runtime.lifecycle",
      timeUnixMs: 3,
      attributes: Object.freeze({})
    }
  ];
  assert.deepEqual(await exporter.export(batch, new AbortController().signal), {
    exported: 1,
    rejected: 2
  });
  assert.deepEqual(requests, [
    "https://collector.example/v1/traces",
    "https://collector.example/v1/metrics"
  ]);
});

test("OTLP exporter honors bounded partial-success settlement", async () => {
  const exporter = createOtlpHttpExporter({
    endpoint: "https://collector.example/",
    fetch: (async () => new Response(JSON.stringify({
      partialSuccess: { rejectedLogRecords: "1", errorMessage: "private collector detail" }
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch
  });
  const event: TelemetryEnvelope = {
    schemaVersion: 1,
    kind: "event",
    name: "odinn.runtime.lifecycle",
    timeUnixMs: 1,
    attributes: Object.freeze({})
  };
  assert.deepEqual(await exporter.export([event], new AbortController().signal), {
    exported: 0,
    rejected: 1
  });
});
