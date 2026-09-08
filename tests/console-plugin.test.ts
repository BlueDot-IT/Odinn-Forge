import assert from "node:assert/strict";
import test from "node:test";
import { formatPluginLiveResult, pluginJobRequest, pluginReadiness, renderPluginCard, renderPluginChecks, renderPluginToolFields } from "../apps/gateway/src/public/console/src/views/plugins.ts";

test("console distinguishes enabled plugins from verified runtime readiness and escapes third-party metadata", () => {
  const plugin = { enabled: true, reviewed: true, manifest: { id: "example-plugin", name: '<img src=x onerror="alert(1)">', version: "1.0.0", description: "<script>untrusted</script>" } };
  assert.equal(pluginReadiness(plugin), "Enabled · runtime unchecked");
  assert.equal(pluginReadiness(plugin, { ready: false }), "Enabled · needs setup");
  assert.equal(pluginReadiness(plugin, { ready: true }), "Ready");
  assert.equal(pluginReadiness({ ...plugin, enabled: false }), "Disabled");
  assert.equal(pluginReadiness({ ...plugin, reviewed: false }), "Needs review");
  const card = renderPluginCard(plugin, true);
  assert.doesNotMatch(card, /<img|<script>/u);
  assert.match(card, /&lt;img/u);
  assert.doesNotMatch(renderPluginChecks({ checks: [{ ok: false, detail: "<script>bad</script>", remediation: "Run setup" }] }), /<script>/u);
});

test("console requests a durable mcp.invoke job pinned to the reviewed discovery identity", () => {
  const snapshot = { type: "mcp.discovery", serverId: "weather-connector", generation: 7, fingerprint: "a".repeat(64), extensionFingerprint: "b".repeat(64), tools: [{ name: "weather-connector.current", schemaFingerprint: "c".repeat(64) }] };
  const args = { latitude: 40.7, longitude: -74 };
  const request = pluginJobRequest(snapshot, "weather-connector.current", args);
  assert.equal(request.task.tool, "mcp.invoke");
  assert.deepEqual(request.task.input, { serverId: "weather-connector", generation: 7, snapshotFingerprint: "a".repeat(64), extensionFingerprint: "b".repeat(64), toolName: "weather-connector.current", toolSchemaFingerprint: "c".repeat(64), arguments: args });
  assert.equal(request.task.approved, undefined);
  assert.equal(request.task.durableExecution, undefined, "the UI must not self-assert a trusted runtime context");
  assert.throws(() => pluginJobRequest(snapshot, "unknown-tool", args), /Select a discovered tool/u);
  assert.throws(() => pluginJobRequest({ ...snapshot, extensionFingerprint: undefined }, "weather-connector.current", args), /Discover/u);
  assert.throws(() => pluginJobRequest(snapshot, "weather-connector.current", []), /object arguments/u);
});

test("plugin tool forms preserve schema constraints without interpreting schema text as markup", () => {
  const fields = renderPluginToolFields({ inputSchema: { type: "object", required: ["latitude"], properties: {
    latitude: { type: "number", minimum: -90, maximum: 90, description: "<b>Latitude</b>" },
    scale: { type: "string", enum: ["celsius", '"><script>bad</script>'] },
    include: { type: "boolean" }
  } } });
  assert.match(fields, /data-plugin-argument="latitude"[^>]*required/u);
  assert.match(fields, /min="-90" max="90"/u);
  assert.match(fields, /type="number" step="any"/u);
  assert.doesNotMatch(fields, /<script>|<b>/u);
});

test("plugin live result displays provider content, completion status, and no internal execution envelope", () => {
  const execution = { tool: "mcp.invoke", ok: true, output: { status: "completed", toolName: "weather.current", callId: "internal-call-id", resultDigest: "internal-digest", result: { content: [{ type: "text", text: '{"current":{"temperature_2m":28}}' }] } } };
  const text = formatPluginLiveResult(execution);
  assert.match(text, /weather.current · Completed · live only/u);
  assert.match(text, /"temperature_2m": 28/u);
  assert.doesNotMatch(text, /internal-call-id|internal-digest/u);
  assert.match(formatPluginLiveResult({ result: { ...execution, output: { ...execution.output, result: { structuredContent: { note: "<script>plain text only</script>" } } } } }), /"note": "<script>plain text only<\/script>"/u);
});
