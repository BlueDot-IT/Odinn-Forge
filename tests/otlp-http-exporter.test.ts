import assert from "node:assert/strict";
import test from "node:test";
import { createOtlpHttpExporter, validateOtlpHttpEndpoint } from "../packages/kernel/src/otlp-http-exporter.ts";
import { createBufferedTelemetry, type TelemetryEnvelope } from "../packages/kernel/src/async-telemetry.ts";

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

test("OTLP exporter declares repeated dropped-counter samples as deltas", async () => {
  const payloads: any[] = [];
  const exporter = createOtlpHttpExporter({
    endpoint: "https://collector.example/",
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    }) as typeof fetch
  });
  const dropped = (value: number, timeUnixMs: number): TelemetryEnvelope => ({
    schemaVersion: 1,
    kind: "metric",
    name: "odinn.export.dropped",
    timeUnixMs,
    instrument: "counter",
    value,
    unit: "1",
    attributes: Object.freeze({ component: "gateway", operation: "telemetry.observe", "item.count": value })
  });

  await exporter.export([dropped(3, 1_000)], new AbortController().signal);
  await exporter.export([dropped(1, 2_000)], new AbortController().signal);

  const sums = payloads.map((payload) => payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum);
  assert.deepEqual(sums.map((sum) => sum.aggregationTemporality), [1, 1]);
  assert.deepEqual(sums.map((sum) => sum.dataPoints[0].asDouble), [3, 1]);
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

test("buffer preserves an acknowledged earlier OTLP kind when a later request times out", async () => {
  const requests: string[] = [];
  const exporter = createOtlpHttpExporter({
    endpoint: "https://collector.example/",
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      requests.push(String(input));
      if (String(input).endsWith("/v1/traces")) return Promise.resolve(new Response(null, { status: 200 }));
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("missing cancellation signal"));
        if (signal.aborted) return reject(new Error("request aborted"));
        signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
      });
    }) as typeof fetch
  });
  const telemetry = createBufferedTelemetry({
    enabled: true,
    exporter,
    exportTimeoutMs: 10,
    autoPump: false
  });
  telemetry.recordSpan({
    name: "odinn.tool.execution",
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    durationMs: 1,
    status: "ok"
  });
  telemetry.recordMetric({
    name: "odinn.queue.depth",
    instrument: "gauge",
    value: 1,
    unit: "1"
  });

  assert.equal(await telemetry.flush(), false);
  assert.deepEqual(requests, [
    "https://collector.example/v1/traces",
    "https://collector.example/v1/metrics"
  ]);
  assert.deepEqual({
    exported: telemetry.status().exported,
    dropped: telemetry.status().droppedExportFailure,
    failures: telemetry.status().exportFailures,
    lastFailure: telemetry.status().lastFailure
  }, { exported: 1, dropped: 1, failures: 1, lastFailure: "timeout" });
  await telemetry.shutdown();
});

test("record settlement listeners preserve an exported metric when later logs time out", async () => {
  const requests: string[] = [];
  const exporter = createOtlpHttpExporter({
    endpoint: "https://collector.example/",
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      requests.push(String(input));
      if (String(input).endsWith("/v1/metrics")) return Promise.resolve(new Response(null, { status: 200 }));
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("missing cancellation signal"));
        if (signal.aborted) return reject(new Error("request aborted"));
        signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
      });
    }) as typeof fetch
  });
  const telemetry = createBufferedTelemetry({
    enabled: true,
    exporter,
    exportTimeoutMs: 10,
    autoPump: false
  });
  let metricSettlement: "exported" | "rejected" | undefined;
  telemetry.recordMetric({
    name: "odinn.export.dropped",
    instrument: "counter",
    value: 2,
    unit: "1"
  }, (settlement) => { metricSettlement = settlement; });
  telemetry.recordEvent({ name: "odinn.runtime.lifecycle" });

  assert.equal(await telemetry.flush(), false);
  assert.deepEqual(requests, [
    "https://collector.example/v1/metrics",
    "https://collector.example/v1/logs"
  ]);
  assert.equal(metricSettlement, "exported");
  assert.deepEqual({
    exported: telemetry.status().exported,
    dropped: telemetry.status().droppedExportFailure
  }, { exported: 1, dropped: 1 });
  await telemetry.shutdown();
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
