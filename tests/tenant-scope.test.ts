import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayServer } from "../apps/gateway/src/server.ts";
import {
  assertTenantClaims,
  createGatewayTenantScope,
  createTenantScopedAuditStore,
  scopedJobPayload,
} from "../apps/gateway/src/http/tenant-scope.ts";

test("tenant scope is derived from trusted host identity", () => {
  const scope = createGatewayTenantScope({ hosted: true, userId: "Alice", tenantId: "Acme" });
  assert.deepEqual(scope, {
    hosted: true,
    principalId: "host-user:alice",
    tenantId: "tenant:acme",
    userId: "alice",
  });
  assert.equal(createGatewayTenantScope().tenantId, "tenant:local");
});

test("tenant claims must agree with the trusted scope", () => {
  const scope = createGatewayTenantScope({ hosted: true, userId: "alice", tenantId: "acme" });
  assertTenantClaims({ tenantId: "acme", nested: { scope: { tenantId: "tenant:acme" } } }, scope);
  assert.throws(() => assertTenantClaims({ task: { tenantId: "other" } }, scope), /does not match/);
  assert.throws(() => assertTenantClaims({ tenantId: 42 }, scope), /must be a string/);
});

test("durable job payload carries immutable tenant scope", () => {
  const scope = createGatewayTenantScope({ hosted: true, userId: "alice", tenantId: "acme" });
  assert.deepEqual(scopedJobPayload({ task: { tool: "text.echo" } }, scope), {
    task: { tool: "text.echo" },
    scope: { tenantId: "tenant:acme", principalId: "host-user:alice" },
  });
  assert.throws(() => scopedJobPayload({ scope: { tenantId: "other" } }, scope), /does not match/);
});

test("audit adapter binds the trusted tenant without replacing store methods", async () => {
  const scope = createGatewayTenantScope({ hosted: true, userId: "alice", tenantId: "acme" });
  const events: any[] = [];
  const store = {
    append: async (event: unknown) => { events.push(event); return event; },
    verifyIntegrity() { return { valid: true }; },
  };
  const scoped = createTenantScopedAuditStore(store, scope);
  await scoped.append({ runId: "run-1", type: "task.started", actor: "gateway", data: { marker: "safe" } });
  assert.equal(events[0].data.tenantId, "tenant:acme");
  assert.deepEqual(scoped.verifyIntegrity(), { valid: true });
  await assert.rejects(() => scoped.append({ runId: "run-2", type: "task.started", actor: "gateway", data: { tenantId: "other" } }), /does not match/);
});

test("gateway jobs inherit trusted tenant scope and reject forged claims", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-tenant-scope-state-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "odinn-tenant-scope-workspace-"));
  const previousAuth = process.env.ODINN_GATEWAY_AUTH;
  process.env.ODINN_GATEWAY_AUTH = "off";
  const server = await createGatewayServer({
    stateDir,
    workspaceRoot,
    hosted: true,
    hostedUserId: "alice",
    hostedTenantId: "acme",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const accepted = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "tenant-job", tenantId: "acme", task: { tool: "text.echo", input: { text: "scoped" } } }),
    });
    assert.equal(accepted.status, 202);
    const acceptedBody = await accepted.json() as any;
    assert.equal(acceptedBody.job.payload.scope.tenantId, "tenant:acme");
    assert.equal(acceptedBody.job.payload.scope.principalId, "host-user:alice");

    const rejected = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "forged-job", tenantId: "other", task: { tool: "text.echo", input: { text: "forged" } } }),
    });
    assert.equal(rejected.status, 403);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined)));
    await Promise.all([rm(stateDir, { recursive: true, force: true }), rm(workspaceRoot, { recursive: true, force: true })]);
    if (previousAuth === undefined) delete process.env.ODINN_GATEWAY_AUTH;
    else process.env.ODINN_GATEWAY_AUTH = previousAuth;
  }
});
