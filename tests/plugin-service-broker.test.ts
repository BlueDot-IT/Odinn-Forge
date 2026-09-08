import assert from "node:assert/strict";
import test from "node:test";
import { createPluginServiceBroker, type PluginHttpRequest, type PluginServiceBrokerOptions } from "../packages/kernel/src/plugin-service-broker.ts";

const image = `node:24@sha256:${"a".repeat(64)}`;
const capabilities = ["mcp.invoke", "network.access", "secret.reference.use"];
function fixture(authenticated = false) {
  const manifest = {
    schemaVersion: 1, sdkVersion: "1.0", id: "broker-fixture", version: "1.0.0", name: "Broker fixture", description: "A bounded service connector fixture.",
    kind: "connector", runtime: "oci-mcp-stdio", transport: "mcp-jsonrpc-stdio", entrypoint: "server.mjs", containerImage: image,
    tools: [{ name: "broker-fixture.read", description: "Read fixture status.", capabilities: authenticated ? capabilities : capabilities.slice(0, 2), inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false }, effects: authenticated ? ["read", "network", "credential"] : ["read", "network"], requiresApproval: true, retrySafe: true }],
    egress: { protocol: "https", hosts: ["api.example.com"], port: 443 },
    secrets: authenticated ? [{ name: "FIXTURE_API_TOKEN", purpose: "Read the explicitly selected fixture account." }] : [],
    services: [{ id: "fixture", origin: "https://api.example.com", paths: ["/v1/status"], queryKeys: ["account"], ...(authenticated ? { credential: "FIXTURE_API_TOKEN" } : {}) }]
  };
  const extension = { grants: capabilities, permissions: { plugin: { manifest, serviceBindings: { fixture: { enabled: true, ...(authenticated ? { credentialRef: "env:FIXTURE_API_TOKEN" } : {}) } } } } };
  const requests: PluginHttpRequest[] = [];
  let authorized = true;
  const options: PluginServiceBrokerOptions = {
    extension, effectiveCapabilities: capabilities,
    assertAuthority: async () => { if (!authorized) throw new Error("revoked"); },
    resolveNetworkAddresses: async () => ["93.184.216.34"],
    transport: async (request) => { requests.push(request); return { status: 200, contentType: "application/json", body: Buffer.from('{"status":"ok"}') }; }
  };
  return { options, requests, revoke: () => { authorized = false; } };
}
const request = { serviceId: "fixture", path: "/v1/status", query: { account: "approved" } };

test("plugin broker pins public DNS and exposes bounded JSON, not response headers or credential authority", async () => {
  const f = fixture(true);
  f.options.environment = { FIXTURE_API_TOKEN: "synthetic-fixture-value" };
  const result = await createPluginServiceBroker(f.options)!(request);
  assert.deepEqual(result, { status: 200, body: { status: "ok" } });
  assert.equal(f.requests[0]!.address, "93.184.216.34");
  assert.equal(f.requests[0]!.url.href, "https://api.example.com/v1/status?account=approved");
  assert.equal(f.requests[0]!.headers.authorization, "Bearer synthetic-fixture-value");
  assert.equal("headers" in result, false);
});

test("service scopes and all effective host capabilities are required before egress", async () => {
  for (const input of [
    { ...request, serviceId: "unselected" },
    { ...request, path: "/v1/other" },
    { ...request, query: { unapproved: "x" } },
    { ...request, method: "POST" }
  ]) {
    const f = fixture();
    await assert.rejects(() => createPluginServiceBroker(f.options)!(input), /refused or unavailable/u);
    assert.equal(f.requests.length, 0);
  }
  const f = fixture();
  f.options.effectiveCapabilities = ["mcp.invoke"];
  await assert.rejects(() => createPluginServiceBroker(f.options)!(request), /refused or unavailable/u);
  assert.equal(f.requests.length, 0);
});

test("credential absence, revocation and mixed public/private DNS cannot reach transport", async () => {
  const missing = fixture(true);
  missing.options.environment = {};
  await assert.rejects(() => createPluginServiceBroker(missing.options)!(request));
  assert.equal(missing.requests.length, 0);
  const revoked = fixture();
  revoked.options.resolveNetworkAddresses = async () => { revoked.revoke(); return ["93.184.216.34"]; };
  await assert.rejects(() => createPluginServiceBroker(revoked.options)!(request));
  assert.equal(revoked.requests.length, 0);
  const privateDns = fixture();
  privateDns.options.resolveNetworkAddresses = async () => ["93.184.216.34", "127.0.0.1"];
  await assert.rejects(() => createPluginServiceBroker(privateDns.options)!(request));
  assert.equal(privateDns.requests.length, 0);
});

test("redirects, oversized bodies and provider error text are refused without leaking content", async () => {
  for (const response of [
    { status: 302, contentType: "application/json", body: Buffer.from("{}") },
    { status: 200, contentType: "text/html", body: Buffer.from("private provider diagnostic") },
    { status: 200, contentType: "application/json", body: Buffer.alloc(128 * 1024 + 1) }
  ]) {
    const f = fixture();
    f.options.transport = async () => response;
    await assert.rejects(() => createPluginServiceBroker(f.options)!(request), { message: "Plugin service request refused or unavailable" });
  }
});

test("provider-reflected credential values are stripped from parsed keys and values", async () => {
  const f = fixture(true);
  f.options.environment = { FIXTURE_API_TOKEN: "synthetic-fixture-value" };
  f.options.transport = async () => ({ status: 200, contentType: "application/json; charset=utf-8", body: Buffer.from('{"synthetic-fixture-value":"prefix synthetic-fixture-value"}') });
  const result = await createPluginServiceBroker(f.options)!(request);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-fixture-value/u);
});

test("timeout retains a busy broker until its underlying request physically settles", async () => {
  const f = fixture();
  f.options.timeoutMs = 10;
  let finish!: () => void;
  let called = 0;
  f.options.transport = async () => { called += 1; await new Promise<void>((resolve) => { finish = resolve; }); return { status: 200, contentType: "application/json", body: Buffer.from("{}") }; };
  const broker = createPluginServiceBroker(f.options)!;
  await assert.rejects(() => broker(request));
  await assert.rejects(() => broker(request));
  assert.equal(called, 1);
  let physicallySettled = false;
  const settlement = broker.settle().then(() => { physicallySettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(physicallySettled, false);
  finish();
  await settlement;
  assert.equal(physicallySettled, true);
});
