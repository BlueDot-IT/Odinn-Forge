// @odinn/plugin-sdk v1. No network, secrets or external runtime dependencies.
import { createInterface } from "node:readline";
const tools = [{"name":"weather-connector.current","description":"Read current temperature at latitude/longitude.","inputSchema":{"type":"object","properties":{"latitude":{"type":"number","minimum":-90,"maximum":90},"longitude":{"type":"number","minimum":-180,"maximum":180}},"required":["latitude","longitude"],"additionalProperties":false}}];
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
let initialized = false, activeCall, sequence = 0, bytes = 0;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdin.on("data", (chunk) => { bytes += chunk.length; if (bytes > 1024 * 1024) process.exit(1); });
input.on("line", (line) => {
  if (line.length > 512 * 1024) return process.exit(1);
  let request;
  try { request = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: "Invalid JSON" } }); }
  if (!request || request.jsonrpc !== "2.0") return send({ id: null, error: { code: -32600, message: "Invalid request" } });
  if (activeCall && request.id === activeCall.serviceId && !request.method) {
    const call = activeCall; activeCall = undefined;
    if (request.error) return send({ id: call.id, result: { isError: true, content: [{ type: "text", text: "Weather service unavailable or access denied." }] } });
    if (request.result?.status !== 200 || !request.result?.body || typeof request.result.body !== "object") return send({ id: call.id, result: { isError: true, content: [{ type: "text", text: "Invalid weather service response." }] } });
    return send({ id: call.id, result: { content: [{ type: "text", text: JSON.stringify(request.result.body) }] } });
  }
  if (request.method === "initialize") {
    if (!["2024-11-05", "2025-03-26", "2025-06-18"].includes(request.params?.protocolVersion)) return send({ id: request.id, error: { code: -32602, message: "Unsupported protocol version" } });
    return send({ id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "weather-connector", version: "0.1.0" } } });
  }
  if (request.method === "notifications/initialized") { initialized = true; return; }
  if (request.id === undefined) return;
  if (!initialized) return send({ id: request.id, error: { code: -32002, message: "Not initialized" } });
  if (request.method === "tools/list") return send({ id: request.id, result: { tools } });
  if (request.method !== "tools/call") return send({ id: request.id, error: { code: -32601, message: "Method not supported" } });
  const args = request.params?.arguments;
  if (request.params?.name !== tools[0].name || !args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 2 || !Number.isFinite(args.latitude) || args.latitude < -90 || args.latitude > 90 || !Number.isFinite(args.longitude) || args.longitude < -180 || args.longitude > 180) return send({ id: request.id, error: { code: -32602, message: "Expected bounded latitude and longitude" } });
  if (activeCall) return send({ id: request.id, error: { code: -32000, message: "Only one call at a time" } });
  const serviceId = "service-" + (++sequence);
  activeCall = { id: request.id, serviceId };
  send({ id: serviceId, method: "odinn/service.request", params: { serviceId: "open-meteo", path: "/v1/forecast", query: { latitude: String(args.latitude), longitude: String(args.longitude), current: "temperature_2m" } } });
});
