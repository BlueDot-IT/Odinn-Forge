import type {
  TelemetryAttributes,
  TelemetryEnvelope,
  TelemetryEvent,
  TelemetryExportResult,
  TelemetryExporter,
  TelemetryMetric,
  TelemetrySpan
} from "./async-telemetry.ts";

export type OtlpHttpExporterOptions = Readonly<{
  endpoint: string;
  serviceName?: string;
  serviceVersion?: string;
  fetch?: typeof globalThis.fetch;
}>;

const SERVICE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u;
const MAX_ENDPOINT_BYTES = 2_048;
const MAX_SERVICE_LABEL_BYTES = 128;
const MAX_RESPONSE_BYTES = 16 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);

type OtlpAttribute = Readonly<{
  key: string;
  value: Readonly<Partial<Record<"stringValue" | "intValue" | "doubleValue" | "boolValue", string | number | boolean>>>;
}>;

function serviceLabel(value: unknown, fallback: string, label: string): string {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== "string"
    || !SERVICE_LABEL.test(result)
    || Buffer.byteLength(result, "utf8") > MAX_SERVICE_LABEL_BYTES
  ) {
    throw new Error(`${label} must be an operational label of at most ${MAX_SERVICE_LABEL_BYTES} UTF-8 bytes`);
  }
  return result;
}

export function validateOtlpHttpEndpoint(value: unknown): URL {
  if (
    typeof value !== "string"
    || !value
    || value.trim() !== value
    || Buffer.byteLength(value, "utf8") > MAX_ENDPOINT_BYTES
  ) {
    throw new Error("OTLP endpoint must be a non-empty bounded URL");
  }
  let endpoint: URL;
  try { endpoint = new URL(value); }
  catch { throw new Error("OTLP endpoint must be an absolute URL"); }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("OTLP endpoint must use HTTPS or loopback HTTP");
  }
  if (endpoint.protocol === "http:" && !LOOPBACK_HOSTS.has(endpoint.hostname.toLowerCase())) {
    throw new Error("unencrypted OTLP endpoint must use a loopback host");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("OTLP endpoint must not contain credentials, query parameters, or fragments");
  }
  if (/%/u.test(endpoint.pathname) || value.includes("\\")) {
    throw new Error("OTLP endpoint path must not contain encoded or backslash segments");
  }
  endpoint.pathname = endpoint.pathname.endsWith("/") ? endpoint.pathname : `${endpoint.pathname}/`;
  return endpoint;
}

function nanosFromMilliseconds(value: number): string {
  return BigInt(Math.max(0, Math.round(value * 1_000_000))).toString();
}

function otlpAttributes(attributes: Readonly<TelemetryAttributes>): OtlpAttribute[] {
  return Object.entries(attributes).map(([key, value]) => {
    if (typeof value === "string") return Object.freeze({ key, value: Object.freeze({ stringValue: value }) });
    if (typeof value === "boolean") return Object.freeze({ key, value: Object.freeze({ boolValue: value }) });
    if (Number.isSafeInteger(value)) return Object.freeze({ key, value: Object.freeze({ intValue: String(value) }) });
    return Object.freeze({ key, value: Object.freeze({ doubleValue: value }) });
  });
}

function resource(serviceName: string, serviceVersion: string): Readonly<{ attributes: OtlpAttribute[] }> {
  return Object.freeze({
    attributes: [
      Object.freeze({ key: "service.name", value: Object.freeze({ stringValue: serviceName }) }),
      Object.freeze({ key: "service.version", value: Object.freeze({ stringValue: serviceVersion }) })
    ]
  });
}

function tracePayload(spans: readonly TelemetrySpan[], serviceName: string, serviceVersion: string): unknown {
  return {
    resourceSpans: [{
      resource: resource(serviceName, serviceVersion),
      scopeSpans: [{
        scope: { name: "odinn.telemetry", version: "1" },
        spans: spans.map((span) => {
          const endMs = span.timeUnixMs;
          const startMs = Math.max(0, endMs - span.durationMs);
          return {
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
            name: span.name,
            startTimeUnixNano: nanosFromMilliseconds(startMs),
            endTimeUnixNano: nanosFromMilliseconds(endMs),
            attributes: otlpAttributes(span.attributes),
            status: { code: span.status === "ok" ? 1 : span.status === "error" ? 2 : 0 }
          };
        })
      }]
    }]
  };
}

function metricPoint(metric: TelemetryMetric): Record<string, unknown> {
  const common = {
    attributes: otlpAttributes(metric.attributes),
    timeUnixNano: nanosFromMilliseconds(metric.timeUnixMs)
  };
  if (metric.instrument === "counter") {
    return {
      name: metric.name,
      unit: metric.unit,
      sum: {
        aggregationTemporality: 1,
        isMonotonic: true,
        dataPoints: [{ ...common, asDouble: metric.value }]
      }
    };
  }
  if (metric.instrument === "histogram") {
    return {
      name: metric.name,
      unit: metric.unit,
      histogram: {
        aggregationTemporality: 1,
        dataPoints: [{ ...common, count: "1", sum: metric.value, bucketCounts: ["1"], explicitBounds: [] }]
      }
    };
  }
  return {
    name: metric.name,
    unit: metric.unit,
    gauge: { dataPoints: [{ ...common, asDouble: metric.value }] }
  };
}

function metricPayload(metrics: readonly TelemetryMetric[], serviceName: string, serviceVersion: string): unknown {
  return {
    resourceMetrics: [{
      resource: resource(serviceName, serviceVersion),
      scopeMetrics: [{
        scope: { name: "odinn.telemetry", version: "1" },
        metrics: metrics.map(metricPoint)
      }]
    }]
  };
}

function logPayload(events: readonly TelemetryEvent[], serviceName: string, serviceVersion: string): unknown {
  return {
    resourceLogs: [{
      resource: resource(serviceName, serviceVersion),
      scopeLogs: [{
        scope: { name: "odinn.telemetry", version: "1" },
        logRecords: events.map((event) => ({
          timeUnixNano: nanosFromMilliseconds(event.timeUnixMs),
          severityNumber: 9,
          body: { stringValue: event.name },
          attributes: otlpAttributes(event.attributes)
        }))
      }]
    }]
  };
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("OTLP export response exceeded the bounded body limit");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    try { await reader.cancel(); } catch { /* cleanup is best-effort */ }
    throw new Error("OTLP export response was invalid");
  }
}

function rejectedCount(path: "v1/traces" | "v1/metrics" | "v1/logs", body: string, itemCount: number): number {
  if (!body.trim()) return 0;
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch { throw new Error("OTLP export response was invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OTLP export response was invalid");
  const partial = (parsed as Record<string, unknown>).partialSuccess;
  if (partial === undefined) return 0;
  if (!partial || typeof partial !== "object" || Array.isArray(partial)) throw new Error("OTLP export response was invalid");
  const key = path === "v1/traces"
    ? "rejectedSpans"
    : path === "v1/metrics"
      ? "rejectedDataPoints"
      : "rejectedLogRecords";
  const value = (partial as Record<string, unknown>)[key] ?? 0;
  const count = typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > itemCount) {
    throw new Error("OTLP export response was invalid");
  }
  return Number(count);
}

export function createOtlpHttpExporter(options: OtlpHttpExporterOptions): TelemetryExporter {
  if (!options || typeof options !== "object") throw new Error("OTLP exporter options are required");
  const endpoint = validateOtlpHttpEndpoint(options.endpoint);
  const serviceName = serviceLabel(options.serviceName, "odinn", "OTLP serviceName");
  const serviceVersion = serviceLabel(options.serviceVersion, "unknown", "OTLP serviceVersion");
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") throw new Error("OTLP exporter requires fetch");

  const post = async (
    path: "v1/traces" | "v1/metrics" | "v1/logs",
    payload: unknown,
    itemCount: number,
    signal: AbortSignal
  ): Promise<number> => {
    let response: Response;
    try {
      response = await fetchImplementation(new URL(path, endpoint), {
        method: "POST",
        headers: Object.freeze({ accept: "application/json", "content-type": "application/json" }),
        body: JSON.stringify(payload),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal
      });
    } catch {
      throw new Error("OTLP export request failed");
    }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* cleanup is best-effort */ }
      throw new Error(`OTLP export failed with HTTP status ${response.status}`);
    }
    return rejectedCount(path, await boundedResponseText(response), itemCount);
  };

  return Object.freeze({
    export: async (
      batch: readonly TelemetryEnvelope[],
      signal: AbortSignal,
      reportSettlement?: (
        kind: TelemetryEnvelope["kind"],
        settlement: TelemetryExportResult
      ) => void
    ): Promise<TelemetryExportResult> => {
      const spans = batch.filter((item): item is TelemetrySpan => item.kind === "span");
      const metrics = batch.filter((item): item is TelemetryMetric => item.kind === "metric");
      const events = batch.filter((item): item is TelemetryEvent => item.kind === "event");
      const groups = [
        { kind: "span" as const, path: "v1/traces" as const, items: spans, payload: () => tracePayload(spans, serviceName, serviceVersion) },
        { kind: "metric" as const, path: "v1/metrics" as const, items: metrics, payload: () => metricPayload(metrics, serviceName, serviceVersion) },
        { kind: "event" as const, path: "v1/logs" as const, items: events, payload: () => logPayload(events, serviceName, serviceVersion) }
      ];
      let exported = 0;
      let rejected = 0;
      for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index];
        if (!group.items.length) continue;
        let groupRejected: number;
        try {
          groupRejected = await post(group.path, group.payload(), group.items.length, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          rejected += groups.slice(index).reduce((count, remaining) => count + remaining.items.length, 0);
          return Object.freeze({ exported, rejected });
        }
        const groupExported = group.items.length - groupRejected;
        rejected += groupRejected;
        exported += groupExported;
        reportSettlement?.(group.kind, Object.freeze({ exported: groupExported, rejected: groupRejected }));
      }
      return Object.freeze({ exported, rejected });
    }
  });
}
