import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createBufferedTelemetry,
  TELEMETRY_ATTRIBUTE_KEYS,
  TELEMETRY_NAMES,
  type TelemetryEnvelope
} from "../packages/kernel/src/async-telemetry.ts";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("disabled telemetry has no exporter, queue, timer, or validation behavior", async () => {
  const telemetry = createBufferedTelemetry();
  assert.equal(telemetry.enabled, false);
  assert.equal(telemetry.recordEvent({ name: "not-allowlisted" } as any), false);
  assert.deepEqual(telemetry.status(), {
    state: "disabled",
    queued: 0,
    queuedBytes: 0,
    inFlight: 0,
    inFlightBytes: 0,
    accepted: 0,
    exported: 0,
    droppedOverflow: 0,
    droppedExportFailure: 0,
    rejectedAfterShutdown: 0,
    exportFailures: 0,
    consecutiveFailures: 0,
    exporterState: "idle"
  });
  assert.equal(await telemetry.flush(), true);
  assert.deepEqual(await telemetry.shutdown(), { flushed: true, remaining: 0, exporterShutdown: true });
});

test("recording is synchronous, bounded, immutable, and exports only after the stack yields", async () => {
  const exported: TelemetryEnvelope[][] = [];
  const telemetry = createBufferedTelemetry({
    enabled: true,
    exporter: { export: (batch) => { exported.push([...batch]); } },
    now: () => 123
  });
  assert.equal(telemetry.recordEvent({
    name: "odinn.runtime.lifecycle",
    attributes: { component: "kernel", outcome: "ready" }
  }), true);
  assert.equal(exported.length, 0);
  assert.equal(telemetry.status().queued, 1);
  await waitFor(() => exported.length === 1);
  assert.equal(exported[0][0].timeUnixMs, 123);
  assert.equal(Object.isFrozen(exported[0][0]), true);
  assert.equal(Object.isFrozen(exported[0][0].attributes), true);
  assert.throws(() => { (exported[0][0].attributes as any).component = "changed"; }, TypeError);
  assert.deepEqual(telemetry.status(), {
    state: "running",
    queued: 0,
    queuedBytes: 0,
    inFlight: 0,
    inFlightBytes: 0,
    accepted: 1,
    exported: 1,
    droppedOverflow: 0,
    droppedExportFailure: 0,
    rejectedAfterShutdown: 0,
    exportFailures: 0,
    consecutiveFailures: 0,
    exporterState: "idle"
  });
  await telemetry.shutdown();
});

test("privacy boundary rejects arbitrary names, keys, structures, content fields, and oversized values", async () => {
  const telemetry = createBufferedTelemetry({
    enabled: true,
    exporter: { export: () => {} },
    autoPump: false
  });
  assert.throws(() => telemetry.recordEvent({ name: "prompt.secret" } as any), /name is not allowlisted/u);
  assert.throws(() => telemetry.recordEvent({
    name: "odinn.task",
    attributes: { prompt: "private input" }
  } as any), /attribute is not allowlisted/u);
  assert.throws(() => telemetry.recordEvent({
    name: "odinn.task",
    attributes: { component: { nested: "payload" } }
  } as any), /string, number, or boolean/u);
  assert.throws(() => telemetry.recordEvent({
    name: "odinn.task",
    attributes: { component: "private prompt prose" }
  }), /operational label/u);
  assert.throws(() => telemetry.recordEvent({
    name: "odinn.task",
    attributes: { component: "x".repeat(129) }
  }), /at most 128 UTF-8 bytes/u);
  assert.throws(() => telemetry.recordEvent({
    name: "odinn.task",
    attributes: { retryable: "true" }
  } as any), /operational label/u);
  for (const sensitive of [
    "bearer-secret-value",
    "abcdefgh.ijklmnop.qrstuvwx",
    `sk-proj-${"A".repeat(32)}`,
    `ghp_${"B".repeat(36)}`,
    `AKIA${"C".repeat(16)}`,
    "https://example.invalid/path",
    "user@example.invalid",
    "C:/Users/private",
    "../private",
    "host/path"
  ]) {
    assert.throws(() => telemetry.recordEvent({
      name: "odinn.task",
      attributes: { component: sensitive }
    }), /operational label/u);
  }
  assert.equal(telemetry.recordEvent({
    name: "odinn.model.request",
    attributes: {
      "provider.id": "openrouter",
      "model.id": "vendor/model",
      "tool.name": "model.chat"
    }
  }), true);
  assert.throws(() => telemetry.recordEvent({
    name: "odinn.task",
    prompt: "private input"
  } as any), /unknown field: prompt/u);
  await telemetry.shutdown();
});

test("span and metric envelopes validate trace shape and bounded numeric fields", async () => {
  const batches: TelemetryEnvelope[][] = [];
  const telemetry = createBufferedTelemetry({
    enabled: true,
    exporter: { export: (batch) => { batches.push([...batch]); } },
    autoPump: false
  });
  assert.equal(telemetry.recordSpan({
    name: "odinn.model.request",
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    durationMs: 14.5,
    status: "ok",
    attributes: { "provider.id": "provider", "duration.ms": 14.5 }
  }), true);
  assert.equal(telemetry.recordMetric({
    name: "odinn.queue.depth",
    instrument: "gauge",
    value: 2,
    unit: "1",
    attributes: { "queue.depth": 2 }
  }), true);
  assert.throws(() => telemetry.recordSpan({
    name: "odinn.task",
    traceId: "0".repeat(32),
    spanId: SPAN_ID,
    durationMs: 1
  }), /nonzero W3C/u);
  assert.throws(() => telemetry.recordMetric({
    name: "odinn.queue.depth",
    instrument: "gauge",
    value: Number.POSITIVE_INFINITY,
    unit: "1"
  }), /bounded finite number/u);
  assert.equal(await telemetry.flush(), true);
  assert.deepEqual(batches[0].map((item) => item.kind), ["span", "metric"]);
  await telemetry.shutdown();
});

test("caller timestamps use milliseconds and reject unsafe or far-future values", async () => {
  const now = 1_000_000;
  const telemetry = createBufferedTelemetry({
    enabled: true,
    exporter: { export: () => {} },
    autoPump: false,
    now: () => now
  });
  assert.equal(telemetry.recordEvent({
    name: "odinn.task",
    timeUnixMs: now + 60_000
  }), true);
  assert.throws(() => telemetry.recordEvent({
    name: "odinn.task",
    timeUnixMs: now + 60_001
  }), /future-skew limit/u);
  assert.throws(() => telemetry.recordEvent({
    name: "odinn.task",
    timeUnixMs: Number.MAX_SAFE_INTEGER + 1
  }), /non-negative safe integer/u);
  await telemetry.shutdown();
});

test("queue overflow drops newest deterministically and reports exact accounting", async () => {
  const batches: TelemetryEnvelope[][] = [];
  const telemetry = createBufferedTelemetry({
    enabled: true,
    exporter: { export: (batch) => { batches.push([...batch]); } },
    maxQueue: 2,
    maxBatch: 2,
    autoPump: false
  });
  assert.equal(telemetry.recordEvent({ name: "odinn.task", attributes: { operation: "first" } }), true);
  assert.equal(telemetry.recordEvent({ name: "odinn.task", attributes: { operation: "second" } }), true);
  assert.equal(telemetry.recordEvent({ name: "odinn.task", attributes: { operation: "third" } }), false);
  assert.equal(telemetry.status().droppedOverflow, 1);
  assert.equal(await telemetry.flush(), true);
  assert.deepEqual(batches[0].map((item) => item.attributes.operation), ["first", "second"]);
  await telemetry.shutdown();
});

test("exporter failures are isolated, retried with backoff, and never reject recording", async () => {
  let attempts = 0;
  const telemetry = createBufferedTelemetry({
    enabled: true,
    exporter: {
      export: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("export destination included a secret that must not escape");
      }
    },
    baseBackoffMs: 10,
    maxBackoffMs: 10
  });
  assert.doesNotThrow(() => telemetry.recordEvent({ name: "odinn.task" }));
  await waitFor(() => telemetry.status().exportFailures === 1);
  assert.equal(telemetry.status().droppedExportFailure, 1);
  await waitFor(() => telemetry.status().exporterState === "backing-off");
  assert.doesNotThrow(() => telemetry.recordEvent({ name: "odinn.task" }));
  assert.equal(attempts, 1);
  await waitFor(() => telemetry.status().exported === 1);
  const status = telemetry.status();
  assert.equal(attempts, 2);
  assert.equal(status.exportFailures, 1);
  assert.equal(status.consecutiveFailures, 0);
  assert.equal(status.lastFailure, undefined);
  assert.doesNotMatch(JSON.stringify(status), /secret|destination/u);
  await telemetry.shutdown();
});

test("an abort-ignoring timeout wedges without overlap and drops the uncertain batch", async () => {
  let attempts = 0;
  let sawAbort = false;
  let releaseHung!: () => void;
  const hung = new Promise<void>((resolve) => { releaseHung = resolve; });
  const telemetry = createBufferedTelemetry({
    enabled: true,
    exporter: {
      export: (_batch, signal) => {
        attempts += 1;
        if (attempts > 1) return;
        signal.addEventListener("abort", () => { sawAbort = true; }, { once: true });
        return hung;
      }
    },
    exportTimeoutMs: 10,
    autoPump: false
  });
  telemetry.recordEvent({ name: "odinn.task" });
  assert.equal(await telemetry.flush(), false);
  assert.equal(sawAbort, true);
  assert.equal(telemetry.status().lastFailure, "timeout");
  assert.equal(telemetry.status().queued, 0);
  assert.equal(telemetry.status().droppedExportFailure, 1);
  assert.equal(telemetry.status().exporterState, "wedged");
  telemetry.recordEvent({ name: "odinn.task" });
  assert.equal(await telemetry.flush(), false);
  assert.equal(attempts, 1);
  releaseHung();
  await waitFor(() => telemetry.status().exporterState === "idle");
  assert.equal(await telemetry.flush(), false);
  assert.equal(telemetry.status().exported, 1);
  await telemetry.shutdown();
});

test("failed watermark remains failed across repeated, concurrent, and post-shutdown flushes", async () => {
  let attempts = 0;
  const telemetry = createBufferedTelemetry({
    enabled: true,
    exporter: {
      export: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("failed");
      }
    },
    autoPump: false
  });
  telemetry.recordEvent({ name: "odinn.task" });
  const [first, concurrent] = await Promise.all([telemetry.flush(), telemetry.flush()]);
  assert.equal(first, false);
  assert.equal(concurrent, false);
  telemetry.recordEvent({ name: "odinn.task" });
  assert.equal(await telemetry.flush(), false);
  assert.equal(telemetry.status().exported, 1);
  await telemetry.shutdown();
  assert.equal(await telemetry.flush(), false);
});

test("serialized batch byte bound includes array overhead for the first record", async () => {
  const batches: Array<readonly TelemetryEnvelope[]> = [];
  const telemetry = createBufferedTelemetry({
    enabled: true,
    exporter: { export: (batch) => { batches.push(batch); } },
    maxBatchBytes: 256,
    autoPump: false,
    now: () => 1
  });
  const exactAttributes = { component: "x".repeat(128), operation: "y".repeat(12) };
  assert.equal(telemetry.recordEvent({ name: "odinn.task", attributes: exactAttributes }), true);
  assert.equal(telemetry.recordEvent({
    name: "odinn.task",
    attributes: { ...exactAttributes, operation: "y".repeat(13) }
  }), false);
  assert.equal(await telemetry.flush(), true);
  assert.equal(Buffer.byteLength(JSON.stringify(batches[0]), "utf8"), 256);
  assert.equal(telemetry.status().droppedOverflow, 1);
  await telemetry.shutdown();
});

test("wedged timeouts retain exponential backoff growth through physical settlement", async () => {
  const releases: Array<() => void> = [];
  let attempts = 0;
  const telemetry = createBufferedTelemetry({
    enabled: true,
    exporter: {
      export: () => {
        attempts += 1;
        return new Promise<void>((resolve) => { releases.push(resolve); });
      }
    },
    exportTimeoutMs: 10,
    baseBackoffMs: 10,
    maxBackoffMs: 20
  });

  telemetry.recordEvent({ name: "odinn.task" });
  await waitFor(() => telemetry.status().exportFailures === 1);
  assert.equal(telemetry.status().nextRetryDelayMs, 10);
  telemetry.recordEvent({ name: "odinn.task" });
  releases[0]();
  await waitFor(() => telemetry.status().exportFailures === 2);
  assert.equal(telemetry.status().nextRetryDelayMs, 20);
  telemetry.recordEvent({ name: "odinn.task" });
  releases[1]();
  await waitFor(() => telemetry.status().exportFailures === 3);
  assert.equal(telemetry.status().nextRetryDelayMs, 20);
  assert.equal(attempts, 3);
  releases[2]();
  await waitFor(() => telemetry.status().exporterState === "idle");
  await telemetry.shutdown();
});

test("aggregate byte bounds and batch byte bounds are enforced independently of counts", async () => {
  const batches: Array<readonly TelemetryEnvelope[]> = [];
  const telemetry = createBufferedTelemetry({
    enabled: true,
    exporter: { export: (batch) => { batches.push(batch); } },
    maxQueue: 256,
    maxQueueBytes: 4096,
    maxBatch: 256,
    maxBatchBytes: 4096,
    autoPump: false
  });
  let accepted = 0;
  while (telemetry.recordEvent({
    name: "odinn.task",
    attributes: { operation: `value-${String(accepted).padStart(3, "0")}-${"x".repeat(100)}` }
  })) accepted += 1;
  assert.ok(accepted > 0 && accepted < 256);
  assert.equal(telemetry.status().droppedOverflow, 1);
  assert.ok(telemetry.status().queuedBytes <= 4096);
  assert.equal(await telemetry.flush(), true);
  assert.ok(batches.length >= 1);
  for (const batch of batches) {
    assert.ok(Buffer.byteLength(JSON.stringify(batch), "utf8") <= 4096);
  }
  await telemetry.shutdown();
});

test("pump serializes exporter calls and counts in-flight records against queue capacity", async () => {
  let active = 0;
  let maxActive = 0;
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const telemetry = createBufferedTelemetry({
    enabled: true,
    exporter: {
      export: async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls === 1) await first;
        active -= 1;
      }
    },
    maxQueue: 2,
    maxBatch: 1
  });
  telemetry.recordEvent({ name: "odinn.task", attributes: { operation: "first" } });
  await waitFor(() => telemetry.status().inFlight === 1);
  assert.equal(telemetry.recordEvent({ name: "odinn.task", attributes: { operation: "second" } }), true);
  assert.equal(telemetry.recordEvent({ name: "odinn.task", attributes: { operation: "third" } }), false);
  releaseFirst();
  await waitFor(() => telemetry.status().exported === 2);
  assert.equal(maxActive, 1);
  await telemetry.shutdown();
});

test("shutdown is idempotent, rejects later records, and bounds exporter shutdown", async () => {
  let shutdownCalls = 0;
  const telemetry = createBufferedTelemetry({
    enabled: true,
    exporter: {
      export: () => {},
      shutdown: (_signal) => {
        shutdownCalls += 1;
        return Promise.resolve();
      }
    },
    autoPump: false
  });
  telemetry.recordEvent({ name: "odinn.runtime.lifecycle" });
  const first = telemetry.shutdown();
  const second = telemetry.shutdown();
  assert.equal(first, second);
  assert.deepEqual(await first, { flushed: true, remaining: 0, exporterShutdown: true });
  assert.equal(shutdownCalls, 1);
  assert.equal(telemetry.recordEvent({ name: "odinn.task" }), false);
  assert.equal(telemetry.status().rejectedAfterShutdown, 1);
  assert.equal(telemetry.status().state, "stopped");
});

test("shutdown timeout isolates an exporter that ignores cancellation", async () => {
  let sawAbort = false;
  const telemetry = createBufferedTelemetry({
    enabled: true,
    exporter: {
      export: () => {},
      shutdown: (signal) => {
        signal.addEventListener("abort", () => { sawAbort = true; }, { once: true });
        return new Promise(() => {});
      }
    },
    exportTimeoutMs: 10,
    flushTimeoutMs: 20,
    autoPump: false
  });
  const startedAt = Date.now();
  assert.deepEqual(await telemetry.shutdown(), {
    flushed: true,
    remaining: 0,
    exporterShutdown: false
  });
  assert.equal(sawAbort, true);
  assert.ok(Date.now() - startedAt < 500);
});

test("shutdown returns while a timed-out physical export remains wedged", async () => {
  let sawAbort = false;
  const telemetry = createBufferedTelemetry({
    enabled: true,
    exporter: {
      export: (_batch, signal) => {
        signal.addEventListener("abort", () => { sawAbort = true; }, { once: true });
        return new Promise(() => {});
      }
    },
    exportTimeoutMs: 10,
    flushTimeoutMs: 20,
    autoPump: false
  });
  telemetry.recordEvent({ name: "odinn.task" });
  const startedAt = Date.now();
  assert.deepEqual(await telemetry.shutdown(), {
    flushed: false,
    remaining: 0,
    exporterShutdown: false
  });
  assert.equal(sawAbort, true);
  assert.equal(telemetry.status().state, "stopped");
  assert.equal(telemetry.status().exporterState, "wedged");
  assert.ok(Date.now() - startedAt < 500);
});

test("constants and exporter batches are immutable", async () => {
  let batchReference: readonly TelemetryEnvelope[] | undefined;
  const telemetry = createBufferedTelemetry({
    enabled: true,
    exporter: { export: (batch) => { batchReference = batch; } },
    autoPump: false
  });
  telemetry.recordEvent({ name: "odinn.task" });
  await telemetry.flush();
  assert.equal(Object.isFrozen(TELEMETRY_NAMES), true);
  assert.equal(Object.isFrozen(TELEMETRY_ATTRIBUTE_KEYS), true);
  assert.equal(Object.isFrozen(batchReference), true);
  assert.throws(() => (TELEMETRY_NAMES as any).push("private"), TypeError);
  assert.throws(() => (batchReference as any).push({}), TypeError);
  await telemetry.shutdown();
});

test("async telemetry is package-resolvable and absent from active imports", async () => {
  const root = join(import.meta.dirname, "..");
  const packageJson = JSON.parse(await readFile(join(root, "packages/kernel/package.json"), "utf8"));
  assert.equal(packageJson.exports["./async-telemetry"], "./src/async-telemetry.ts");
  for (const path of [
    "packages/kernel/src/index.ts",
    "packages/kernel/src/providers/runtime.ts",
    "apps/cli/src/cli.ts",
    "apps/gateway/src/server.ts"
  ]) {
    const source = await readFile(join(root, path), "utf8");
    assert.doesNotMatch(source, /async-telemetry/u, `${path} must not import the optional telemetry module`);
  }
  const packageConsumer = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", "import('@odinn/kernel/async-telemetry').then((value) => { if (value.TELEMETRY_SCHEMA_VERSION !== 1) process.exit(2); })"],
    { cwd: join(root, "apps/cli"), encoding: "utf8" }
  );
  assert.equal(packageConsumer.status, 0, packageConsumer.stderr || packageConsumer.stdout);
});
