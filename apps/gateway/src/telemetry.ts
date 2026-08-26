import { randomBytes } from "node:crypto";
import {
  createBufferedTelemetry,
  type BufferedTelemetry,
  type TelemetryAttributes,
  type TelemetryName,
  type TelemetryStatus
} from "@odinn/kernel/async-telemetry";
import { createOtlpHttpExporter } from "@odinn/kernel/otlp-http-exporter";

export type GatewayTelemetry = Pick<BufferedTelemetry,
  "enabled" | "recordEvent" | "recordSpan" | "recordMetric" | "status" | "flush" | "shutdown"
>;

export function createGatewayTelemetry({ environment = process.env, serviceVersion = "unknown", fetch }: {
  environment?: NodeJS.ProcessEnv;
  serviceVersion?: string;
  fetch?: typeof globalThis.fetch;
} = {}): GatewayTelemetry {
  const endpoint = environment.ODINN_OTLP_ENDPOINT;
  if (endpoint === undefined) return createBufferedTelemetry();
  return createBufferedTelemetry({
    enabled: true,
    exporter: createOtlpHttpExporter({
      endpoint,
      serviceName: "odinn-gateway",
      serviceVersion,
      ...(fetch ? { fetch } : {})
    })
  });
}

export function recordGatewayEvent(telemetry: GatewayTelemetry, input: {
  name: TelemetryName;
  attributes?: TelemetryAttributes;
}): boolean {
  try { return telemetry.recordEvent(input); }
  catch { return false; }
}

export function recordGatewaySpan(telemetry: GatewayTelemetry, input: {
  name: TelemetryName;
  startedAt: number;
  status: "ok" | "error" | "unset";
  attributes?: TelemetryAttributes;
}): boolean {
  try {
    const endedAt = Date.now();
    return telemetry.recordSpan({
      name: input.name,
      timeUnixMs: endedAt,
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      durationMs: Math.max(0, endedAt - input.startedAt),
      status: input.status,
      attributes: {
        ...input.attributes,
        "duration.ms": Math.max(0, endedAt - input.startedAt)
      }
    });
  } catch {
    return false;
  }
}

export function telemetryStatusProjection(telemetry: GatewayTelemetry): Readonly<{
  enabled: boolean;
  state: TelemetryStatus["state"];
  exporterState: TelemetryStatus["exporterState"];
  queued: number;
  dropped: number;
}> {
  const status = telemetry.status();
  return Object.freeze({
    enabled: telemetry.enabled,
    state: status.state,
    exporterState: status.exporterState,
    queued: status.queued + status.inFlight,
    dropped: status.droppedOverflow + status.droppedExportFailure
  });
}

export function instrumentAuditStore<T extends { append: (...args: any[]) => Promise<any> }>(
  store: T,
  telemetry: GatewayTelemetry
): T {
  return new Proxy(store, {
    get(target, property) {
      if (property === "append") {
        return async (...args: any[]) => {
          const startedAt = Date.now();
          try {
            const result = await target.append(...args);
            recordGatewaySpan(telemetry, {
              name: "odinn.audit.append",
              startedAt,
              status: "ok",
              attributes: { component: "audit", operation: "append", outcome: "completed" }
            });
            return result;
          } catch (error) {
            recordGatewaySpan(telemetry, {
              name: "odinn.audit.append",
              startedAt,
              status: "error",
              attributes: { component: "audit", operation: "append", outcome: "failed" }
            });
            throw error;
          }
        };
      }
      const value = target[property as keyof T];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
