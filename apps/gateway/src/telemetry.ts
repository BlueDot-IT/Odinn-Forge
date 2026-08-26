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

const DIRECT_TOOL_CATEGORIES = new Set([
  "agent", "browser", "computer", "email", "git", "github", "goal", "job", "mcp", "memory",
  "model", "process", "project", "sandbox", "session", "skill", "text", "web", "workflow", "workspace"
]);
const REPORTED_DROPPED = new WeakMap<object, number>();

export function gatewayToolTelemetryCategory(registeredToolName: string): string {
  const prefix = registeredToolName.split(".", 1)[0]?.toLowerCase() ?? "";
  if (["discord", "telegram", "channel"].includes(prefix)) return "channel";
  if (["improve", "improvement"].includes(prefix)) return "improvement";
  return DIRECT_TOOL_CATEGORIES.has(prefix) ? prefix : "other";
}

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

export function recordGatewayTelemetryHealth(telemetry: GatewayTelemetry): void {
  const initialStatus = telemetry.status();
  const queued = initialStatus.queued + initialStatus.inFlight;
  try {
    telemetry.recordMetric({
      name: "odinn.queue.depth",
      instrument: "gauge",
      value: queued,
      unit: "1",
      attributes: { component: "gateway", operation: "telemetry.observe", "queue.depth": queued }
    });
    const currentStatus = telemetry.status();
    const dropped = currentStatus.droppedOverflow
      + currentStatus.droppedExportFailure
      + currentStatus.rejectedInvalid
      + currentStatus.rejectedAfterShutdown;
    const previousDropped = REPORTED_DROPPED.get(telemetry as object) ?? 0;
    const newlyDropped = Math.max(0, dropped - previousDropped);
    if (newlyDropped > 0) {
      const admitted = telemetry.recordMetric({
        name: "odinn.export.dropped",
        instrument: "counter",
        value: newlyDropped,
        unit: "1",
        attributes: { component: "gateway", operation: "telemetry.observe", "item.count": newlyDropped }
      });
      if (admitted) REPORTED_DROPPED.set(telemetry as object, dropped);
    }
  } catch {
    // Invalid or post-shutdown telemetry is locally accounted by the buffer.
  }
}

export function telemetryStatusProjection(telemetry: GatewayTelemetry): Readonly<{
  enabled: boolean;
  state: TelemetryStatus["state"];
  exporterState: TelemetryStatus["exporterState"];
  queued: number;
  accepted: number;
  exported: number;
  dropped: number;
  rejectedInvalid: number;
  rejectedAfterShutdown: number;
  exportFailures: number;
}> {
  const status = telemetry.status();
  return Object.freeze({
    enabled: telemetry.enabled,
    state: status.state,
    exporterState: status.exporterState,
    queued: status.queued + status.inFlight,
    accepted: status.accepted,
    exported: status.exported,
    dropped: status.droppedOverflow
      + status.droppedExportFailure
      + status.rejectedInvalid
      + status.rejectedAfterShutdown,
    rejectedInvalid: status.rejectedInvalid,
    rejectedAfterShutdown: status.rejectedAfterShutdown,
    exportFailures: status.exportFailures
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
