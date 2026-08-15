import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMultiUserHost, hashPassword } from "../apps/gateway/src/host.ts";
import { createGatewayDiagnosticsReadRequest, createGatewaySessionListPort, createGatewaySessionListRequest, createGatewayStatusReadRequest } from "../apps/gateway/src/server.ts";

function assertLabeledInput(html: string, name: string) {
  const input = new RegExp(`<input\\b[^>]*\\bname=["']${name}["'][^>]*>`, "iu").exec(html)?.[0];
  assert.ok(input, `missing ${name} input`);
  const id = /\bid=["']([^"']+)["']/iu.exec(input)?.[1];
  assert.ok(id, `${name} input needs an id for its label`);
  assert.match(html, new RegExp(`<label\\b[^>]*\\bfor=["']${id}["'][^>]*>`, "iu"), `${name} input needs a visible label`);
}

test("hosted status application contexts isolate authenticated users", () => {
  const alice = createGatewayStatusReadRequest({ applicationRequestId: "request:alice", hostedUserId: "alice", authentication: "bearer" });
  const aliceSecondTenant = createGatewayStatusReadRequest({ applicationRequestId: "request:alice-second", hostedUserId: "alice", hostedTenantId: "second", authentication: "bearer" });
  const bob = createGatewayStatusReadRequest({ applicationRequestId: "request:bob", hostedUserId: "bob", authentication: "bearer" });
  assert.equal(alice.context.principal.principalId, "host-user:alice");
  assert.equal(alice.context.scope.tenantId, "tenant:alice");
  assert.equal(aliceSecondTenant.context.principal.principalId, "host-user:alice");
  assert.equal(aliceSecondTenant.context.scope.tenantId, "tenant:second");
  assert.equal(bob.context.principal.principalId, "host-user:bob");
  assert.equal(bob.context.scope.tenantId, "tenant:bob");
  assert.notEqual(alice.context.principal.principalId, bob.context.principal.principalId);
  assert.notEqual(alice.context.scope.tenantId, bob.context.scope.tenantId);
});

test("hosted diagnostics application contexts isolate authenticated users", () => {
  const alice = createGatewayDiagnosticsReadRequest({ applicationRequestId: "request:diagnostics-alice", hostedUserId: "alice", authentication: "bearer" });
  const bob = createGatewayDiagnosticsReadRequest({ applicationRequestId: "request:diagnostics-bob", hostedUserId: "bob", authentication: "bearer" });
  assert.equal(alice.context.principal.principalId, "host-user:alice");
  assert.equal(alice.context.scope.tenantId, "tenant:alice");
  assert.equal(bob.context.principal.principalId, "host-user:bob");
  assert.equal(bob.context.scope.tenantId, "tenant:bob");
  assert.notEqual(alice.context.principal.principalId, bob.context.principal.principalId);
  assert.notEqual(alice.context.scope.tenantId, bob.context.scope.tenantId);
});

test("hosted session-list application contexts isolate authenticated users", () => {
  const alice = createGatewaySessionListRequest({ applicationRequestId: "request:sessions-alice", hostedUserId: "alice", authentication: "bearer", limit: 20 });
  const bob = createGatewaySessionListRequest({ applicationRequestId: "request:sessions-bob", hostedUserId: "bob", authentication: "bearer", limit: 20 });
  assert.equal(alice.context.principal.principalId, "host-user:alice");
  assert.equal(alice.context.scope.tenantId, "tenant:alice");
  assert.equal(bob.context.principal.principalId, "host-user:bob");
  assert.equal(bob.context.scope.tenantId, "tenant:bob");
  assert.notEqual(alice.context.principal.principalId, bob.context.principal.principalId);
  assert.notEqual(alice.context.scope.tenantId, bob.context.scope.tenantId);
});

test("gateway session-list adapter passes cancellation through executor options", async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const port = createGatewaySessionListPort({
    execute: async (_request: unknown, options?: { signal?: AbortSignal }) => {
      observedSignal = options?.signal;
      await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener("abort", () => {
        const error = new Error("cancelled");
        error.name = "AbortError";
        reject(error);
      }, { once: true }));
      return { output: { sessions: [] } };
    },
    auditStore: {},
    policy: {},
    registry: {}
  });
  const pending = port.readSessions({ limit: 20 }, {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, { name: "AbortError" });
  assert.equal(observedSignal, controller.signal);
});

test("multi-user host authenticates and isolates each tenant gateway state", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-"));
  const aliceRoot = await mkdtemp(join(tmpdir(), "odinn-alice-"));
  const bobRoot = await mkdtemp(join(tmpdir(), "odinn-bob-"));
  const alice = await hashPassword("alice-password-long");
  const bob = await hashPassword("bob-password-longer");
  const publicOrigin = "https://odinn.test";
  const server = await createMultiUserHost({ stateDir: root, publicOrigin, users: { schemaVersion: 1, users: [
    { id: "alice", workspaceRoot: aliceRoot, salt: alice.salt, passwordHash: alice.hash },
    { id: "bob", workspaceRoot: bobRoot, salt: bob.salt, passwordHash: bob.hash }
  ] } });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const loginPage = await fetch(`${base}/auth/login`);
    assert.equal(loginPage.status, 200);
    const loginHtml = await loginPage.text();
    assertLabeledInput(loginHtml, "userId");
    assertLabeledInput(loginHtml, "password");
    const loginFeedback = [...loginHtml.matchAll(/<[^>]+>/gu)]
      .map((match) => match[0])
      .find((tag) => /\bid=["'][^"']*(?:error|feedback|status)[^"']*["']/iu.test(tag));
    assert.ok(loginFeedback, "login needs a dedicated error region");
    assert.match(loginFeedback, /\b(?:role=["']alert["']|aria-live=["'](?:polite|assertive)["'])/iu, "login failures need to be announced");

    assert.equal((await fetch(`${base}/status`)).status, 401);
    assert.equal((await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: "alice", password: "alice-password-long" }) })).status, 403);
    const aliceLogin = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: publicOrigin }, body: JSON.stringify({ userId: "alice", password: "alice-password-long" }) });
    assert.equal(aliceLogin.status, 200);
    const aliceCookie = aliceLogin.headers.get("set-cookie").split(";")[0];
    const aliceStatusResponse = await fetch(`${base}/status`, { headers: { cookie: aliceCookie } });
    assert.equal(aliceStatusResponse.headers.get("x-odinn-hosted"), "true");
    assert.equal(aliceStatusResponse.headers.get("x-odinn-host-user"), "alice");
    const aliceStatus = await aliceStatusResponse.json();
    assert.equal(aliceStatus.workspaceRoot, aliceRoot);
    const aliceSessionResponse = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: aliceCookie, origin: publicOrigin },
      body: JSON.stringify({ title: "Alice private session" })
    });
    assert.equal(aliceSessionResponse.status, 200);
    const aliceSession = await aliceSessionResponse.json();
    const aliceConfig = await (await fetch(`${base}/config`, { headers: { cookie: aliceCookie } })).json();
    const escapedAudit = await fetch(`${base}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: aliceCookie, origin: publicOrigin },
      body: JSON.stringify({ config: { ...aliceConfig.config, auditLog: "../bob/audit.jsonl" }, fingerprint: aliceConfig.fingerprint })
    });
    assert.equal(escapedAudit.status, 400);
    assert.match((await escapedAudit.json()).error, /audit-\*\.jsonl filename/);
    const aliceConsole = await (await fetch(`${base}/`, { headers: { cookie: aliceCookie } })).text();
    assert.match(aliceConsole, /<button\b[^>]*\bid=["']remote-signout["'][^>]*\bhidden\b[^>]*>/iu, "the shared shell must keep sign out hidden until hosted status is known");
    assert.match(aliceConsole, /id=["']remote-signout["'][\s\S]{0,160}(?:Sign out|Log out)/iu);
    const consoleScriptReference = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/iu.exec(aliceConsole)?.[1];
    assert.ok(consoleScriptReference, "the hosted console must reference a built script asset");
    const consoleScriptResponse = await fetch(`${base}${consoleScriptReference}`, { headers: { cookie: aliceCookie } });
    assert.equal(consoleScriptResponse.status, 200);
    const consoleScript = await consoleScriptResponse.text();
    assert.match(
      consoleScript,
      /remote-signout[\s\S]{0,500}(?:hidden\s*=\s*false|removeAttribute\(["']hidden["']\))|(?:hidden\s*=\s*false|removeAttribute\(["']hidden["']\))[\s\S]{0,500}remote-signout/iu,
      "hosted status must reveal the sign-out control"
    );
    assert.match(consoleScript, /\/auth\/logout/u, "the sign-out control must call the host logout route");
    const bobLogin = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: publicOrigin }, body: JSON.stringify({ userId: "bob", password: "bob-password-longer" }) });
    const bobCookie = bobLogin.headers.get("set-cookie").split(";")[0];
    const bobStatus = await (await fetch(`${base}/status`, { headers: { cookie: bobCookie } })).json();
    assert.equal(bobStatus.workspaceRoot, bobRoot);
    assert.notEqual(aliceStatus.state, bobStatus.state);
    const bobSessionResponse = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: bobCookie, origin: publicOrigin },
      body: JSON.stringify({ title: "Bob private session" })
    });
    assert.equal(bobSessionResponse.status, 200);
    const bobSession = await bobSessionResponse.json();
    const aliceSessions = await (await fetch(`${base}/sessions`, { headers: { cookie: aliceCookie } })).json();
    const bobSessions = await (await fetch(`${base}/sessions`, { headers: { cookie: bobCookie } })).json();
    assert.deepEqual(aliceSessions.sessions.map((entry: any) => entry.id), [aliceSession.id]);
    assert.deepEqual(bobSessions.sessions.map((entry: any) => entry.id), [bobSession.id]);
    assert.equal(aliceSessions.sessions.some((entry: any) => entry.id === bobSession.id), false);
    assert.equal(bobSessions.sessions.some((entry: any) => entry.id === aliceSession.id), false);
    assert.equal((await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie: aliceCookie, origin: publicOrigin } })).status, 200);
    assert.equal((await fetch(`${base}/status`, { headers: { cookie: aliceCookie } })).status, 401);
  } finally { await new Promise((resolve: any) => server.close(() => resolve())); }
});

test("host derives tenant scope from durable membership and restores revocable sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-memberships-"));
  const firstWorkspace = await mkdtemp(join(tmpdir(), "odinn-membership-first-"));
  const secondWorkspace = await mkdtemp(join(tmpdir(), "odinn-membership-second-"));
  const password = await hashPassword("multi-tenant-password-long");
  const publicOrigin = "https://odinn.test";
  const config = {
    schemaVersion: 2,
    users: [{ id: "alice", defaultTenantId: "first", salt: password.salt, passwordHash: password.hash, disabled: false }],
    tenants: [
      { id: "first", name: "First tenant", workspaceRoot: firstWorkspace, stateDirectory: "tenants/first" },
      { id: "second", name: "Second tenant", workspaceRoot: secondWorkspace, stateDirectory: "tenants/second" }
    ],
    memberships: [
      { userId: "alice", tenantId: "first", role: "owner" },
      { userId: "alice", tenantId: "second", role: "member" }
    ],
    roles: [{ id: "owner", permissions: ["tenant.manage", "tenant.use"] }, { id: "member", permissions: ["tenant.use"] }],
    serviceAccounts: []
  };
  await writeFile(join(root, "users.json"), `${JSON.stringify(config)}\n`, { mode: 0o600 });
  const first = await createMultiUserHost({ stateDir: root, publicOrigin });
  await new Promise((resolve: any) => first.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${first.address().port}`;
  let cookie = "";
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: publicOrigin },
      body: JSON.stringify({ userId: "alice", password: "multi-tenant-password-long", tenantId: "first" })
    });
    assert.equal(login.status, 200);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.deepEqual((await login.json()).tenants.map((tenant: any) => tenant.tenantId), ["first", "second"]);
    assert.equal((await (await fetch(`${base}/status`, { headers: { cookie } })).json()).workspaceRoot, firstWorkspace);
    assert.equal((await fetch(`${base}/auth/tenants`, { headers: { cookie } })).status, 200);
    const selected = await fetch(`${base}/auth/select-tenant`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: publicOrigin },
      body: JSON.stringify({ tenantId: "second" })
    });
    assert.equal(selected.status, 200);
    assert.equal((await (await fetch(`${base}/status`, { headers: { cookie } })).json()).workspaceRoot, secondWorkspace);
  } finally {
    await new Promise((resolve: any) => first.close(() => resolve()));
  }

  const restarted = await createMultiUserHost({ stateDir: root, publicOrigin });
  await new Promise((resolve: any) => restarted.listen(0, "127.0.0.1", resolve));
  const restartedBase = `http://127.0.0.1:${restarted.address().port}`;
  try {
    assert.equal((await fetch(`${restartedBase}/status`, { headers: { cookie } })).status, 200);
    await writeFile(join(root, "users.json"), `${JSON.stringify({ ...config, memberships: [{ ...config.memberships[0] }, { ...config.memberships[1], disabled: true }] })}\n`, { mode: 0o600 });
    assert.equal((await fetch(`${restartedBase}/status`, { headers: { cookie } })).status, 401, "revoking the selected membership must revoke the durable session");
  } finally {
    await new Promise((resolve: any) => restarted.close(() => resolve()));
  }
});

test("tenant lifecycle administration is membership-scoped and suspensions fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-tenant-lifecycle-"));
  const aliceWorkspace = await mkdtemp(join(tmpdir(), "odinn-tenant-lifecycle-alice-"));
  const alicePassword = await hashPassword("tenant-owner-password-long");
  const bobPassword = await hashPassword("tenant-member-password-long");
  const publicOrigin = "https://odinn.test";
  const config = {
    schemaVersion: 2,
    users: [
      { id: "alice", defaultTenantId: "acme", salt: alicePassword.salt, passwordHash: alicePassword.hash, disabled: false },
      { id: "bob", defaultTenantId: "acme", salt: bobPassword.salt, passwordHash: bobPassword.hash, disabled: false }
    ],
    tenants: [{ id: "acme", name: "Acme", workspaceRoot: aliceWorkspace, stateDirectory: "tenants/acme", status: "active" }],
    memberships: [
      { userId: "alice", tenantId: "acme", role: "owner" },
      { userId: "bob", tenantId: "acme", role: "member" }
    ],
    roles: [
      { id: "owner", permissions: ["tenant.manage", "tenant.use"] },
      { id: "member", permissions: ["tenant.use"] }
    ],
    serviceAccounts: []
  };
  await writeFile(join(root, "users.json"), `${JSON.stringify(config)}\n`, { mode: 0o600 });
  const server = await createMultiUserHost({ stateDir: root, publicOrigin, tenantLimits: { maximumBackups: 1 } });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (userId: string, password: string) => fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: publicOrigin },
    body: JSON.stringify({ userId, password })
  });
  const post = (path: string, cookie: string, body: any) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: publicOrigin },
    body: JSON.stringify(body)
  });
  try {
    const aliceLogin = await login("alice", "tenant-owner-password-long");
    const aliceCookie = aliceLogin.headers.get("set-cookie")!.split(";")[0];
    const bobLogin = await login("bob", "tenant-member-password-long");
    const bobCookie = bobLogin.headers.get("set-cookie")!.split(";")[0];

    const aliceTenant = await (await fetch(`${base}/auth/tenant`, { headers: { cookie: aliceCookie } })).json();
    const bobTenant = await (await fetch(`${base}/auth/tenant`, { headers: { cookie: bobCookie } })).json();
    assert.equal(aliceTenant.status, "active");
    assert.ok(aliceTenant.permissions.includes("tenant.manage"));
    assert.equal(bobTenant.permissions.includes("tenant.manage"), false);
    assert.equal((await post("/auth/tenant/lifecycle", bobCookie, { tenantId: "acme", status: "suspended" })).status, 403);
    assert.equal((await post("/auth/tenant/lifecycle", aliceCookie, { tenantId: "acme", status: "deleted" })).status, 400);

    assert.equal((await fetch(`${base}/status`, { headers: { cookie: aliceCookie } })).status, 200, "initialize tenant state before backup");
    const suspended = await post("/auth/tenant/lifecycle", aliceCookie, { tenantId: "acme", status: "suspended" });
    assert.equal(suspended.status, 200);
    assert.deepEqual(await suspended.json(), { ok: true, tenantId: "acme", status: "suspended", changed: true });
    const persisted = JSON.parse(await readFile(join(root, "users.json"), "utf8"));
    assert.equal(persisted.tenants[0].status, "suspended");
    assert.equal(persisted.tenants[0].disabled, true);
    assert.equal((await fetch(`${base}/status`, { headers: { cookie: aliceCookie } })).status, 423);
    assert.equal((await fetch(`${base}/status`, { headers: { cookie: bobCookie } })).status, 423);
    assert.equal((await (await fetch(`${base}/auth/tenants`, { headers: { cookie: bobCookie } })).json()).tenants[0].status, "suspended");

    const memberBackup = await post("/auth/tenant/backup", bobCookie, { tenantId: "acme" });
    assert.equal(memberBackup.status, 403);
    const ownerBackup = await post("/auth/tenant/backup", aliceCookie, { tenantId: "acme" });
    assert.equal(ownerBackup.status, 200);
    const ownerBackupPayload = await ownerBackup.json();
    assert.equal(ownerBackupPayload.backup.includesSensitiveState, false);
    assert.match(ownerBackupPayload.backup.backupPath, /^tenant-backups\/acme\/backup-/u);
    const backupRoot = join(root, ownerBackupPayload.backup.backupPath);
    const manifest = JSON.parse(await readFile(join(backupRoot, "backup-manifest.json"), "utf8"));
    assert.equal(manifest.includesSensitiveState, false);
    assert.ok(manifest.excluded.includes("users.json"));
    assert.ok(manifest.excluded.includes("gateway.token"));
    assert.equal(manifest.files.some((file: any) => ["users.json", "session-key", "gateway.token"].includes(file.path)), false);
    assert.equal((await post("/auth/tenant/backup", aliceCookie, { tenantId: "acme" })).status, 429, "backup count must remain bounded");

    const resumed = await post("/auth/tenant/lifecycle", aliceCookie, { tenantId: "acme", status: "active" });
    assert.deepEqual(await resumed.json(), { ok: true, tenantId: "acme", status: "active", changed: true });
    assert.equal((await fetch(`${base}/status`, { headers: { cookie: aliceCookie } })).status, 200);
  } finally {
    await new Promise((resolve: any) => server.close(() => resolve()));
  }
});

test("multi-user host rate limits repeated authentication failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-limit-"));
  const workspace = await mkdtemp(join(tmpdir(), "odinn-limit-user-"));
  const password = await hashPassword("correct-password-long");
  const publicOrigin = "https://odinn.test";
  const server = await createMultiUserHost({
    stateDir: root,
    publicOrigin,
    loginLimits: { maximumAttempts: 2, windowMs: 60_000 },
    users: { schemaVersion: 1, users: [{ id: "alice", workspaceRoot: workspace, salt: password.salt, passwordHash: password.hash }] }
  });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (value: any) => fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: publicOrigin }, body: JSON.stringify({ userId: "alice", password: value }) });
  try {
    assert.equal((await login("wrong-password-long")).status, 401);
    assert.equal((await login("still-wrong-password")).status, 401);
    const blocked = await login("correct-password-long");
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  } finally { await new Promise((resolve: any) => server.close(() => resolve())); }
});

test("multi-user host bounds sessions per user and globally", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-session-limit-"));
  const aliceRoot = await mkdtemp(join(tmpdir(), "odinn-session-alice-"));
  const bobRoot = await mkdtemp(join(tmpdir(), "odinn-session-bob-"));
  const charlieRoot = await mkdtemp(join(tmpdir(), "odinn-session-charlie-"));
  const alice = await hashPassword("alice-password-long");
  const bob = await hashPassword("bob-password-longer");
  const charlie = await hashPassword("charlie-password-long");
  const publicOrigin = "https://odinn.test";
  const server = await createMultiUserHost({
    stateDir: root,
    publicOrigin,
    sessionLimits: { maximumPerUser: 2, maximumGlobal: 3 },
    users: { schemaVersion: 1, users: [
      { id: "alice", workspaceRoot: aliceRoot, salt: alice.salt, passwordHash: alice.hash },
      { id: "bob", workspaceRoot: bobRoot, salt: bob.salt, passwordHash: bob.hash },
      { id: "charlie", workspaceRoot: charlieRoot, salt: charlie.salt, passwordHash: charlie.hash }
    ] }
  });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (userId: string, password: string) => fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: publicOrigin },
    body: JSON.stringify({ userId, password })
  });
  try {
    const aliceOne = await login("alice", "alice-password-long");
    const aliceOneCookie = aliceOne.headers.get("set-cookie")!.split(";")[0];
    const aliceTwo = await login("alice", "alice-password-long");
    const aliceTwoCookie = aliceTwo.headers.get("set-cookie")!.split(";")[0];
    const aliceThree = await login("alice", "alice-password-long");
    const aliceThreeCookie = aliceThree.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await fetch(`${base}/status`, { headers: { cookie: aliceOneCookie } })).status, 401, "oldest user session must be revoked at capacity");
    assert.equal((await fetch(`${base}/status`, { headers: { cookie: aliceTwoCookie } })).status, 200);
    assert.equal((await fetch(`${base}/status`, { headers: { cookie: aliceThreeCookie } })).status, 200);

    assert.equal((await login("bob", "bob-password-longer")).status, 200);
    const capacity = await login("charlie", "charlie-password-long");
    assert.equal(capacity.status, 503);
    assert.match((await capacity.json()).error, /session capacity/);
    assert.ok(Number(capacity.headers.get("retry-after")) >= 1);
  } finally {
    await new Promise((resolve: any) => server.close(() => resolve()));
  }
});

test("multi-user host sweeps expired sessions and reclaims global capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-session-expiry-"));
  const aliceRoot = await mkdtemp(join(tmpdir(), "odinn-session-expiry-alice-"));
  const bobRoot = await mkdtemp(join(tmpdir(), "odinn-session-expiry-bob-"));
  const alice = await hashPassword("alice-password-long");
  const bob = await hashPassword("bob-password-longer");
  const publicOrigin = "https://odinn.test";
  const server = await createMultiUserHost({
    stateDir: root,
    publicOrigin,
    sessionLimits: { maximumPerUser: 1, maximumGlobal: 1, durationMs: 1_000, sweepIntervalMs: 100 },
    users: { schemaVersion: 1, users: [
      { id: "alice", workspaceRoot: aliceRoot, salt: alice.salt, passwordHash: alice.hash },
      { id: "bob", workspaceRoot: bobRoot, salt: bob.salt, passwordHash: bob.hash }
    ] }
  });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (userId: string, password: string) => fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: publicOrigin },
    body: JSON.stringify({ userId, password })
  });
  try {
    const aliceLogin = await login("alice", "alice-password-long");
    const aliceCookie = aliceLogin.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await login("bob", "bob-password-longer")).status, 503);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
    assert.equal((await fetch(`${base}/status`, { headers: { cookie: aliceCookie } })).status, 401);
    assert.equal((await login("bob", "bob-password-longer")).status, 200, "expiry sweep must reclaim global capacity");
  } finally {
    await new Promise((resolve: any) => server.close(() => resolve()));
  }
});

test("multi-user host preserves a configured global session ceiling below the per-user limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-session-hard-global-"));
  const aliceRoot = await mkdtemp(join(tmpdir(), "odinn-session-hard-global-alice-"));
  const bobRoot = await mkdtemp(join(tmpdir(), "odinn-session-hard-global-bob-"));
  const alice = await hashPassword("alice-password-long");
  const bob = await hashPassword("bob-password-longer");
  const publicOrigin = "https://odinn.test";
  const server = await createMultiUserHost({
    stateDir: root,
    publicOrigin,
    sessionLimits: { maximumPerUser: 5, maximumGlobal: 1 },
    users: { schemaVersion: 1, users: [
      { id: "alice", workspaceRoot: aliceRoot, salt: alice.salt, passwordHash: alice.hash },
      { id: "bob", workspaceRoot: bobRoot, salt: bob.salt, passwordHash: bob.hash }
    ] }
  });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (userId: string, password: string) => fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: publicOrigin },
    body: JSON.stringify({ userId, password })
  });
  try {
    const aliceOne = await login("alice", "alice-password-long");
    const aliceOneCookie = aliceOne.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await login("bob", "bob-password-longer")).status, 503, "the configured global limit must remain the hard ceiling");

    const aliceTwo = await login("alice", "alice-password-long");
    assert.equal(aliceTwo.status, 200, "the effective per-user limit should clamp to permit replacement");
    assert.equal((await fetch(`${base}/status`, { headers: { cookie: aliceOneCookie } })).status, 401);
  } finally {
    await new Promise((resolve: any) => server.close(() => resolve()));
  }
});

test("multi-user host canonicalizes accepted login IDs before throttling", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-normalized-limit-"));
  const workspace = await mkdtemp(join(tmpdir(), "odinn-normalized-limit-user-"));
  const password = await hashPassword("correct-password-long");
  const publicOrigin = "https://odinn.test";
  const server = await createMultiUserHost({
    stateDir: root,
    publicOrigin,
    loginLimits: { maximumAttempts: 2, maximumAttemptsPerIp: 100, windowMs: 60_000 },
    users: { schemaVersion: 1, users: [{ id: "alice", workspaceRoot: workspace, salt: password.salt, passwordHash: password.hash }] }
  });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (userId: string, passwordValue: string) => fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: publicOrigin },
    body: JSON.stringify({ userId, password: passwordValue })
  });
  try {
    assert.equal((await login(" Alice ", "wrong-password-long")).status, 401);
    assert.equal((await login("ALICE", "still-wrong-password")).status, 401);
    assert.equal((await login("alice", "correct-password-long")).status, 429);
  } finally {
    await new Promise((resolve: any) => server.close(() => resolve()));
  }
});

test("multi-user host bounds unique-ID throttle persistence and applies per-IP admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-cardinality-limit-"));
  const workspace = await mkdtemp(join(tmpdir(), "odinn-cardinality-limit-user-"));
  const password = await hashPassword("correct-password-long");
  const publicOrigin = "https://odinn.test";
  const users = { schemaVersion: 1, users: [{ id: "alice", workspaceRoot: workspace, salt: password.salt, passwordHash: password.hash }] };
  const options = {
    stateDir: root,
    publicOrigin,
    loginLimits: { maximumAttempts: 100, maximumAttemptsPerIp: 1_000, maximumRecords: 8, windowMs: 60_000 },
    users
  };
  const server = await createMultiUserHost(options);
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let capacityRejected = false;
    for (let index = 0; index < 60; index += 1) {
      const response = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: publicOrigin },
        body: JSON.stringify({ userId: `probe-${String(index).padStart(3, "0")}`, password: "wrong-password-long" })
      });
      assert.ok([401, 429].includes(response.status));
      capacityRejected ||= response.status === 429;
    }
    assert.equal(capacityRejected, true, "new throttle identities must fail closed when the bounded store is full");
    const attemptsPath = join(root, "login-attempts.json");
    const persisted = JSON.parse(await readFile(attemptsPath, "utf8"));
    assert.equal(persisted.schemaVersion, 2);
    assert.ok(Object.keys(persisted.attempts).length <= 8, "persisted throttle record count must remain capped");
    assert.ok((await stat(attemptsPath)).size < 4_096, "bounded records must produce a bounded small persistence file");
  } finally {
    await new Promise((resolve: any) => server.close(() => resolve()));
  }

  const restarted = await createMultiUserHost(options);
  await new Promise((resolve: any) => restarted.listen(0, "127.0.0.1", resolve));
  try {
    const persisted = JSON.parse(await readFile(join(root, "login-attempts.json"), "utf8"));
    assert.ok(Object.keys(persisted.attempts).length <= 8, "restart must not expand persisted throttle cardinality");
  } finally {
    await new Promise((resolve: any) => restarted.close(() => resolve()));
  }

  const ipRoot = await mkdtemp(join(tmpdir(), "odinn-host-ip-limit-"));
  const ipServer = await createMultiUserHost({
    stateDir: ipRoot,
    publicOrigin,
    loginLimits: { maximumAttempts: 2, maximumAttemptsPerIp: 3, maximumRecords: 16, windowMs: 60_000 },
    users
  });
  await new Promise((resolve: any) => ipServer.listen(0, "127.0.0.1", resolve));
  const ipBase = `http://127.0.0.1:${ipServer.address().port}`;
  const ipLogin = (userId: string, passwordValue = "wrong-password-long") => fetch(`${ipBase}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: publicOrigin },
    body: JSON.stringify({ userId, password: passwordValue })
  });
  try {
    assert.equal((await ipLogin("probe-one")).status, 401);
    assert.equal((await ipLogin("probe-two")).status, 401);
    assert.equal((await ipLogin("alice", "correct-password-long")).status, 200);
    assert.equal((await ipLogin("probe-three")).status, 401);
    const blocked = await ipLogin("alice", "correct-password-long");
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  } finally {
    await new Promise((resolve: any) => ipServer.close(() => resolve()));
  }
});

test("multi-user host rejects tenant-controlled provider destinations and credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-provider-policy-"));
  const workspace = await mkdtemp(join(tmpdir(), "odinn-provider-policy-user-"));
  const password = await hashPassword("provider-policy-password-long");
  const publicOrigin = "https://odinn.test";
  const server = await createMultiUserHost({
    stateDir: root,
    publicOrigin,
    users: { schemaVersion: 1, users: [{ id: "alice", workspaceRoot: workspace, salt: password.salt, passwordHash: password.hash }] }
  });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: publicOrigin }, body: JSON.stringify({ userId: "alice", password: "provider-policy-password-long" }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const current = await (await fetch(`${base}/config`, { headers: { cookie } })).json();
    const save = (provider: any) => fetch(`${base}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie, origin: publicOrigin },
      body: JSON.stringify({
        config: { ...current.config, providers: { probe: provider }, defaultModel: "probe:model" },
        fingerprint: current.fingerprint
      })
    });

    const privateEndpoint = await save({ type: "openai-compatible", baseUrl: "http://127.0.0.1:4000/v1", apiKeyEnv: "OPENAI_API_KEY", models: ["model"] });
    assert.equal(privateEndpoint.status, 400);
    assert.match((await privateEndpoint.json()).error, /approved provider endpoints/);

    const customCredential = await save({ type: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "TENANT_CONTROLLED_SECRET", models: ["model"] });
    assert.equal(customCredential.status, 400);
    assert.match((await customCredential.json()).error, /credential environment variable/);

    const approved = await save({ type: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", models: ["model"] });
    assert.equal(approved.status, 200);
  } finally {
    await new Promise((resolve: any) => server.close(() => resolve()));
  }
});

test("multi-user host preserves authentication throttles across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-limit-restart-"));
  const workspace = await mkdtemp(join(tmpdir(), "odinn-limit-restart-user-"));
  const password = await hashPassword("correct-password-long");
  const publicOrigin = "https://odinn.test";
  const options = {
    stateDir: root,
    publicOrigin,
    loginLimits: { maximumAttempts: 1, windowMs: 60_000 },
    users: { schemaVersion: 1, users: [{ id: "alice", workspaceRoot: workspace, salt: password.salt, passwordHash: password.hash }] }
  };
  const first = await createMultiUserHost(options);
  await new Promise((resolve: any) => first.listen(0, "127.0.0.1", resolve));
  const firstBase = `http://127.0.0.1:${first.address().port}`;
  assert.equal((await fetch(`${firstBase}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: publicOrigin }, body: JSON.stringify({ userId: "alice", password: "wrong-password-long" }) })).status, 401);
  await new Promise((resolve: any) => first.close(() => resolve()));

  const second = await createMultiUserHost(options);
  await new Promise((resolve: any) => second.listen(0, "127.0.0.1", resolve));
  const secondBase = `http://127.0.0.1:${second.address().port}`;
  try {
    assert.equal((await fetch(`${secondBase}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: publicOrigin }, body: JSON.stringify({ userId: "alice", password: "correct-password-long" }) })).status, 429);
  } finally {
    await new Promise((resolve: any) => second.close(() => resolve()));
  }
});

test("multi-user host rejects overlapping tenant workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-overlap-"));
  const workspace = await mkdtemp(join(tmpdir(), "odinn-overlap-workspace-"));
  const nested = join(workspace, "nested");
  await mkdir(nested);
  const alice = await hashPassword("alice-password-long");
  const bob = await hashPassword("bob-password-longer");
  await assert.rejects(() => createMultiUserHost({ stateDir: root, users: { schemaVersion: 1, users: [
    { id: "alice", workspaceRoot: workspace, salt: alice.salt, passwordHash: alice.hash },
    { id: "bob", workspaceRoot: nested, salt: bob.salt, passwordHash: bob.hash }
  ] } }), /workspaces overlap/);
});

test("multi-user host rejects overlapping tenant state directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-state-overlap-"));
  const firstWorkspace = await mkdtemp(join(tmpdir(), "odinn-state-overlap-first-"));
  const secondWorkspace = await mkdtemp(join(tmpdir(), "odinn-state-overlap-second-"));
  const alice = await hashPassword("alice-password-long");
  const config = {
    schemaVersion: 2,
    users: [
      { id: "alice", defaultTenantId: "first", salt: alice.salt, passwordHash: alice.hash },
      { id: "bob", defaultTenantId: "second", salt: alice.salt, passwordHash: alice.hash }
    ],
    tenants: [
      { id: "first", workspaceRoot: firstWorkspace, stateDirectory: "tenants/shared" },
      { id: "second", workspaceRoot: secondWorkspace, stateDirectory: "tenants/shared/nested" }
    ],
    memberships: [
      { userId: "alice", tenantId: "first", role: "owner" },
      { userId: "bob", tenantId: "second", role: "owner" }
    ],
    roles: [],
    serviceAccounts: []
  };
  await writeFile(join(root, "users.json"), `${JSON.stringify(config)}\n`, { mode: 0o600 });
  await assert.rejects(() => createMultiUserHost({ stateDir: root, publicOrigin: "https://odinn.test" }), /state directories overlap/);
});

test("multi-user host reloads disabled users without restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-reload-"));
  const aliceWorkspace = await mkdtemp(join(tmpdir(), "odinn-reload-alice-workspace-"));
  const bobWorkspace = await mkdtemp(join(tmpdir(), "odinn-reload-bob-workspace-"));
  const alicePassword = await hashPassword("correct-password-long");
  const bobPassword = await hashPassword("another-correct-password");
  const alice = { id: "alice", workspaceRoot: aliceWorkspace, salt: alicePassword.salt, passwordHash: alicePassword.hash, disabled: false };
  const bob = { id: "bob", workspaceRoot: bobWorkspace, salt: bobPassword.salt, passwordHash: bobPassword.hash, disabled: false };
  await writeFile(join(root, "users.json"), JSON.stringify({ schemaVersion: 1, users: [alice, bob] }));
  const publicOrigin = "https://odinn.test";
  const server = await createMultiUserHost({ stateDir: root, publicOrigin, sessionLimits: { maximumGlobal: 1 } });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: publicOrigin }, body: JSON.stringify({ userId: "alice", password: "correct-password-long" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(`${base}/status`, { headers: { cookie } })).status, 200);
    await writeFile(join(root, "users.json"), JSON.stringify({ schemaVersion: 1, users: [{ ...alice, disabled: true }, bob] }));
    const bobLogin = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: publicOrigin }, body: JSON.stringify({ userId: "bob", password: "another-correct-password" }) });
    assert.equal(bobLogin.status, 200, "disabling a user must promptly reclaim that user's session capacity");
    assert.equal((await fetch(`${base}/status`, { headers: { cookie } })).status, 401);
  } finally { await new Promise((resolve: any) => server.close(() => resolve())); }
});
