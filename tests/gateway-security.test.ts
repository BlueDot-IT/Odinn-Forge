import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { assertGatewayBinding } from "../apps/gateway/src/security.ts";
import { createGatewayServer } from "../apps/gateway/src/server.ts";
import { createApprovalStore, isOwnerOnlyPath } from "../packages/kernel/src/index.ts";

test("gateway control surfaces require bootstrap authentication and reject cross-origin mutations", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-security-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/status`)).status, 401);
    assert.equal((await fetch(`${base}/config`)).status, 401);
    const bootstrap = await fetch(`${base}/`);
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    assert.equal((await fetch(`${base}/status`, { headers: { cookie } })).status, 200);
    const configResponse = await fetch(`${base}/config`, { headers: { cookie } });
    assert.equal(configResponse.status, 200);
    const currentConfig = await configResponse.json();

    for (const invalidConfig of [
      { ...currentConfig.config, providers: { malicious: { type: "openai-compatible", apiKeyEnv: "ODINN_CHROMIUM_PATH", models: ["malicious"] } } },
      { ...currentConfig.config, channels: { malicious: { type: "discord", tokenEnv: "ODINN_GATEWAY_AUTH" } } },
      { ...currentConfig.config, plugins: { entries: { discord: { enabled: true, config: { accounts: { malicious: { tokenEnv: "ODINN_USER_PASSWORD" } } } } } } }
    ]) {
      const response = await fetch(`${base}/config`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ config: invalidConfig, fingerprint: currentConfig.fingerprint })
      });
      const body: any = await response.json();
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.match(body.error, /credential-oriented.*reserved runtime control/iu);
    }

    const missingConfigOrigin = await fetch(`${base}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ config: currentConfig.config, fingerprint: currentConfig.fingerprint })
    });
    assert.equal(missingConfigOrigin.status, 403);

    const crossOriginConfig = await fetch(`${base}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie, origin: "https://evil.example" },
      body: JSON.stringify({ config: currentConfig.config, fingerprint: currentConfig.fingerprint })
    });
    assert.equal(crossOriginConfig.status, 403);

    const missingCookieOrigin = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ id: "run_missing_cookie_origin", tool: "text.echo", input: { text: "blocked" } })
    });
    assert.equal(missingCookieOrigin.status, 403);

    const crossPort = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: `http://127.0.0.1:${server.address().port + 1}` },
      body: JSON.stringify({ id: "run_cross_port", tool: "text.echo", input: { text: "blocked" } })
    });
    assert.equal(crossPort.status, 403);

    const sameOrigin = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ id: "run_same_origin", tool: "text.echo", input: { text: "allowed" } })
    });
    assert.equal(sameOrigin.status, 200);

    const token = decodeURIComponent(cookie.split("=").slice(1).join("="));
    const bearer = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: "run_bearer_no_origin", tool: "text.echo", input: { text: "allowed" } })
    });
    assert.equal(bearer.status, 200);

    const rejected = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://evil.example" },
      body: JSON.stringify({ id: "run_cross_origin", tool: "text.echo", input: { text: "blocked" } })
    });
    assert.equal(rejected.status, 403);

    const hostileBootstrap = await requestRaw({ port: server.address().port, path: "/", headers: { host: "attacker.example" } });
    assert.equal(hostileBootstrap.status, 421);
    const hostileOrigin = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "http://attacker.example", host: `127.0.0.1:${server.address().port}` },
      body: JSON.stringify({ id: "run_hostile_origin", tool: "text.echo", input: { text: "blocked" } })
    });
    assert.equal(hostileOrigin.status, 403);
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("remote gateway binding never bootstraps the control token through a spoofed loopback Host", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-remote-bootstrap-"));
  const previousRemote = process.env.ODINN_ALLOW_REMOTE;
  process.env.ODINN_ALLOW_REMOTE = "1";
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise((resolve: any) => server.listen(0, "0.0.0.0", resolve));
  try {
    const token = (await readFile(join(stateDir, "gateway.token"), "utf8")).trim();
    const bootstrap: any = await requestRaw({
      port: server.address().port,
      path: "/",
      headers: { host: `localhost:${server.address().port}` }
    });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.headers["set-cookie"], undefined);
    assert.equal(bootstrap.headers["x-odinn-auth"], "authentication-required");
    assert.equal(bootstrap.body.includes(token), false);

    const status: any = await requestRaw({
      port: server.address().port,
      path: "/status",
      headers: { host: `localhost:${server.address().port}` }
    });
    assert.equal(status.status, 401);
  } finally {
    if (previousRemote === undefined) delete process.env.ODINN_ALLOW_REMOTE;
    else process.env.ODINN_ALLOW_REMOTE = previousRemote;
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("remote gateway binding cannot disable authentication", () => {
  assert.doesNotThrow(() => assertGatewayBinding("127.0.0.1", { allowRemote: false, authenticationDisabled: true }));
  assert.doesNotThrow(() => assertGatewayBinding("::1", { allowRemote: false, authenticationDisabled: true }));
  assert.doesNotThrow(() => assertGatewayBinding("0.0.0.0", { allowRemote: true, authenticationDisabled: false }));
  assert.throws(
    () => assertGatewayBinding("0.0.0.0", { allowRemote: false, authenticationDisabled: false }),
    /refusing non-loopback gateway host/u
  );
  assert.throws(
    () => assertGatewayBinding("0.0.0.0", { allowRemote: true, authenticationDisabled: true }),
    /refusing to disable gateway authentication/u
  );
});

test("approval records survive restart and consume exactly once for the bound action", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-restart-"));
  const path = join(stateDir, "approvals.json");
  const first = createApprovalStore({ path });
  const action = { tool: "browser.click", runId: "run-browser-click", accountId: "home", input: { selector: "#send", confirmed: true }, summary: "Click" };
  const id = first.create(action);
  const restarted = createApprovalStore({ path });
  const claimed = restarted.claim(id);
  assert.equal(claimed.status, "approved");
  assert.equal(claimed.runId, "run-browser-click");
  assert.equal(createApprovalStore({ path }).list()[0].status, "claimed");
  const secondClaim = createApprovalStore({ path }).claim(id);
  assert.equal(secondClaim.status, "approved");
  assert.equal(secondClaim.runId, claimed.runId);
  for (const mismatch of [
    { tool: "browser.press", runId: action.runId, accountId: action.accountId, input: { selector: "#send" } },
    { tool: action.tool, runId: "different-run", accountId: action.accountId, input: { selector: "#send" } },
    { tool: action.tool, runId: action.runId, accountId: "different-account", input: { selector: "#send" } },
    { tool: action.tool, runId: action.runId, accountId: action.accountId, input: { selector: "#other" } }
  ]) {
    assert.equal(createApprovalStore({ path }).consume(id, mismatch), undefined);
  }
  const consumed = createApprovalStore({ path }).consume(id, {
    tool: action.tool,
    runId: action.runId,
    accountId: action.accountId,
    input: { selector: "#send" }
  });
  assert.equal(consumed?.id, id);
  assert.equal(createApprovalStore({ path }).consume(id, action), undefined);
  assert.deepEqual(createApprovalStore({ path }).list(), []);
});

test("separate processes atomically serialize one approval continuation owner", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-process-race-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const path = join(stateDir, "approvals.json");
  const barrier = join(stateDir, "start");
  const action = { tool: "process.exec", runId: "cross-process-continuation", actor: "operator", input: { command: "/bin/true", args: [], cwd: "." } };
  const id = createApprovalStore({ path }).create(action);
  assert.ok(createApprovalStore({ path }).claim(id));
  const moduleUrl = pathToFileURL(join(process.cwd(), "packages/kernel/src/approvals.ts")).href;
  const childCode = [
    `import { existsSync } from "node:fs";`,
    `import { createApprovalStore } from ${JSON.stringify(moduleUrl)};`,
    `while (!existsSync(${JSON.stringify(barrier)})) await new Promise((resolve) => setTimeout(resolve, 5));`,
    `const result = createApprovalStore({ path: ${JSON.stringify(path)} }).consume(${JSON.stringify(id)}, ${JSON.stringify(action)});`,
    `process.stdout.write(result ? "won" : "lost");`
  ].join("\n");
  const execute = () => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  const left = execute();
  const right = execute();
  await writeFile(barrier, "start\n", { mode: 0o600 });
  const results = await Promise.all([left, right]);
  assert.ok(results.every(({ code }) => code === 0), results.map(({ stderr }) => stderr).join("\n"));
  assert.deepEqual(results.map(({ stdout }) => stdout).sort(), ["lost", "won"]);
  assert.deepEqual(createApprovalStore({ path }).list(), []);
});

test("claimed approvals expire and release durable capacity after an interrupted claim", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-claim-expiry-"));
  const path = join(stateDir, "approvals.json");
  const store = createApprovalStore({ path });
  const id = store.create({ tool: "browser.click", runId: "interrupted-claim", input: { selector: "#send" } });
  assert.equal(store.claim(id)?.status, "approved");
  const persisted = JSON.parse(await readFile(path, "utf8"));
  persisted.approvals[0].expiresAt = Date.now() - 1;
  await writeFile(path, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
  assert.equal(createApprovalStore({ path }).recover(id), undefined);
  assert.deepEqual(createApprovalStore({ path }).list(), []);
  assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(id));
  assert.ok(createApprovalStore({ path }).create({ tool: "browser.click", input: { selector: "#new" } }));
});

test("process approval bindings survive a worker restart without persisting command contents", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-worker-restart-"));
  const path = join(stateDir, "approvals.json");
  const command = "opaque-worker-command";
  const argument = "opaque-worker-argument";
  const id = createApprovalStore({ path }).create({
    tool: "process.exec",
    runId: "run-process-worker-restart",
    input: { command, args: [argument], cwd: "." }
  });
  createApprovalStore({ path }).claim(id);
  const persisted = await readFile(path, "utf8");
  assert.doesNotMatch(persisted, new RegExp(command));
  assert.doesNotMatch(persisted, new RegExp(argument));
  if (process.platform !== "win32") assert.equal((await stat(`${path}.key`)).mode & 0o777, 0o600);

  const moduleUrl = pathToFileURL(join(process.cwd(), "packages/kernel/src/approvals.ts")).href;
  const childCode = [
    `import { createApprovalStore } from ${JSON.stringify(moduleUrl)};`,
    `const store = createApprovalStore({ path: ${JSON.stringify(path)} });`,
    `const result = store.consume(${JSON.stringify(id)}, { tool: "process.exec", runId: "run-process-worker-restart", input: { command: "[redacted]", args: ["[redacted]"], cwd: "." } });`,
    `if (!result || result.input?.command !== ${JSON.stringify(command)} || result.input?.args?.[0] !== ${JSON.stringify(argument)}) process.exit(2);`
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.deepEqual(createApprovalStore({ path }).list(), []);
});

test("approval persistence redacts browser values without weakening action binding", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-redaction-"));
  const path = join(stateDir, "approvals.json");
  const sentinel = "SENTINEL_APPROVAL_BROWSER_VALUE_4f91";
  const action = {
    tool: "browser.type",
    runId: "run-browser-type",
    input: { selector: "#password", value: sentinel, sensitive: true }
  };
  const id = createApprovalStore({ path }).create(action);
  const persisted = await readFile(path, "utf8");
  assert.doesNotMatch(persisted, new RegExp(sentinel));
  assert.doesNotMatch(persisted, /bindingDigest/u);
  assert.doesNotMatch(persisted, /ciphertext|sealedAction/u);

  const restarted = createApprovalStore({ path });
  const claimed = restarted.claim(id);
  assert.equal(claimed?.input?.value, "[redacted]");
  assert.equal(claimed?.input?.selector, "#password");
  assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(sentinel));
  assert.equal(restarted.consume(id, {
    ...action,
    input: { ...action.input, value: "wrong-value" }
  }), undefined);
  assert.equal(restarted.consume(id, claimed!)?.input?.value, sentinel);
  assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(sentinel));
});

test("approval take restores exact volatile input once without persisting the payload", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-take-"));
  const path = join(stateDir, "approvals.json");
  const action = { tool: "browser.type", runId: "run-take", input: { selector: "#secretary", value: "exact value" } };
  const id = createApprovalStore({ path }).create(action);
  const taken = createApprovalStore({ path }).take(id);
  assert.deepEqual(taken?.input, action.input);
  assert.equal(createApprovalStore({ path }).take(id), undefined);
  assert.doesNotMatch(await readFile(path, "utf8"), /exact value|ciphertext|sealedAction/u);
});

test("approval records fail closed after process-volatile input is unavailable", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-legacy-"));
  const path = join(stateDir, "approvals.json");
  const legacySecret = "LEGACY_BROWSER_VALUE_MUST_BE_SCRUBBED";
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    approvals: [{
      id: "approval_without_volatile_input",
      tool: "browser.type",
      runId: "legacy",
      input: { selector: "#password", value: legacySecret },
      bindingTag: "unrecoverable",
      status: "pending",
      expiresAt: Date.now() + 60_000
    }]
  })}\n`, { mode: 0o600 });
  const store = createApprovalStore({ path });
  const claimed = store.claim("approval_without_volatile_input");
  assert.equal(claimed?.input?.value, "[redacted]");
  assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(legacySecret));
  assert.equal(store.consume("approval_without_volatile_input", claimed!), undefined);
});

test("approval store recovers a crash-stale lock owned by a dead process", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-stale-lock-"));
  const path = join(stateDir, "approvals.json");
  await writeFile(`${path}.lock`, JSON.stringify({
    pid: 2_147_483_647,
    token: "abandoned",
    createdAt: Date.now() - 60_000
  }), { mode: 0o600 });
  const id = createApprovalStore({ path }).create({ tool: "browser.click", input: { selector: "#send" } });
  assert.match(id, /^approval_/);
  const quarantined = (await readdir(stateDir)).filter((name) => name.startsWith(".odinn-approval-stale-lock."));
  assert.equal(quarantined.length, 1);
  assert.equal((await readdir(stateDir)).some((name) => name.startsWith(".odinn-approval-lock-recovery.")), false);
});

for (const [label, contents] of [["partial", "{"], ["empty", ""]] as const) {
  test(`approval store identity-quarantines an old ${label} lock file`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), `odinn-approval-${label}-lock-`));
    const path = join(stateDir, "approvals.json");
    const lockPath = `${path}.lock`;
    await writeFile(lockPath, contents, { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const id = createApprovalStore({ path }).create({ tool: "browser.click", input: { selector: "#send" } });
    assert.match(id, /^approval_/u);
    const quarantined = (await readdir(stateDir)).filter((name) => name.startsWith(".odinn-approval-stale-lock."));
    assert.equal(quarantined.length, 1);
    assert.equal(await readFile(join(stateDir, quarantined[0]!), "utf8"), contents);
    assert.equal(existsSync(lockPath), false);
  });
}

test("approval stale-lock recovery never removes a lock while another recovery owns its token", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-stale-lock-race-"));
  const path = join(stateDir, "approvals.json");
  const lock = { pid: 2_147_483_647, token: "contended-abandoned-lock", createdAt: Date.now() - 60_000 };
  const recoveryPath = join(stateDir, `.odinn-approval-lock-recovery.${createHash("sha256").update(`${path}.lock\0${lock.token}`).digest("hex")}`);
  await writeFile(`${path}.lock`, JSON.stringify(lock), { mode: 0o600 });
  await writeFile(recoveryPath, JSON.stringify({ pid: process.pid, token: "live-recovery" }), { mode: 0o600 });
  assert.throws(
    () => createApprovalStore({ path }).create({ tool: "browser.click", input: { selector: "#send" } }),
    (error: any) => error?.code === "APPROVAL_STORE_BUSY"
  );
  assert.deepEqual(JSON.parse(await readFile(`${path}.lock`, "utf8")), lock);
  assert.equal((await readdir(stateDir)).some((name) => name.startsWith(".odinn-approval-stale-lock.")), false);
});

test("approval stale-lock recovery replaces a recovery marker abandoned by a dead owner", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-recovery-marker-"));
  const path = join(stateDir, "approvals.json");
  const lock = { pid: 2_147_483_647, token: "abandoned-primary", createdAt: Date.now() - 60_000 };
  const recoveryName = `.odinn-approval-lock-recovery.${createHash("sha256").update(`${path}.lock\0${lock.token}`).digest("hex")}`;
  await writeFile(`${path}.lock`, JSON.stringify(lock), { mode: 0o600 });
  await writeFile(join(stateDir, recoveryName), JSON.stringify({
    pid: 2_147_483_647,
    token: "abandoned-recovery",
    createdAt: Date.now() - 60_000
  }), { mode: 0o600 });
  const id = createApprovalStore({ path }).create({ tool: "browser.click", input: { selector: "#send" } });
  assert.match(id, /^approval_/u);
  const files = await readdir(stateDir);
  assert.equal(files.some((name) => name.startsWith(".odinn-approval-stale-lock.")), true);
  assert.equal(files.includes(recoveryName), false);
});

test("gateway state files and directory are owner-only", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-permissions-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  try {
    await stat(join(stateDir, "config.json"));
    if (process.platform === "win32") assert.equal(await isOwnerOnlyPath(stateDir), true);
    else {
      assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
      assert.equal((await stat(join(stateDir, "config.json"))).mode & 0o777, 0o600);
    }
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("gateway rejects an audit path that escapes state before startup", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-unsafe-audit-"));
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify({ version: 1, auditLog: "../other-tenant/audit.jsonl" })}\n`, { mode: 0o600 });
  await assert.rejects(
    () => createGatewayServer({ stateDir, workspaceRoot: stateDir }),
    /auditLog must be audit\.jsonl or an audit-\*\.jsonl filename/
  );
});

test("configuration reads refuse symbolic-link swaps", { skip: process.platform === "win32" }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-config-symlink-"));
  const outsideDir = await mkdtemp(join(tmpdir(), "odinn-config-outside-"));
  const outside = join(outsideDir, "outside.json");
  const outsideContents = '{"private":"must-not-be-returned"}\n';
  await writeFile(outside, outsideContents, { mode: 0o644 });
  const outsideMode = (await stat(outside)).mode & 0o777;
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bootstrap = await fetch(`${base}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    await rename(join(stateDir, "config.json"), join(stateDir, "config.original.json"));
    await symlink(outside, join(stateDir, "config.json"));
    const response = await fetch(`${base}/config`, { headers: { cookie } });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /symbolic link/);
    assert.equal(await readFile(outside, "utf8"), outsideContents);
    assert.equal((await stat(outside)).mode & 0o777, outsideMode);
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("governed workspace mutation endpoints require authenticated session and same-origin controls", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-governed-auth-"));
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify({ version: 1, experimental: { capabilities: true } })}\n`);
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const payload = JSON.stringify({ runId: "missing-auth", operation: "write", path: "seed.txt", content: "without-cookie" });
  try {
    const noAuth = await fetch(`${base}/governed/workspace/mutate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload
    });
    assert.equal(noAuth.status, 401);

    const bootstrap = await fetch(`${base}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const crossOrigin = await fetch(`${base}/governed/workspace/mutate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "https://evil.example"
      },
      body: payload
    });
    assert.equal(crossOrigin.status, 403);
    const sameOrigin = await fetch(`${base}/governed/workspace/mutate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: base,
        "sec-fetch-site": "same-origin"
      },
      body: payload
    });
    assert.equal(sameOrigin.status, 400);
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("governed mutation endpoints enforce capability gates and ignore nested request payload tokens", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-governed-capability-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "odinn-gateway-governed-capability-workspace-"));
  const tokenConfig = {
    version: 1,
    experimental: { capabilities: true },
    policy: {
      allowedCapabilities: [
        "job.healthcheck",
        "text.echo",
        "workspace.readText",
        "workspace.mutate",
        "workspace.patch",
        "restore.create",
        "restore.apply",
        "model.chat",
        "agent.run",
        "web.read",
        "browser.read",
        "browser.act",
        "discord.read",
        "discord.write",
        "session.read",
        "session.write",
        "goal.read",
        "goal.write",
        "memory.read",
        "memory.write",
        "improve.read",
        "improve.write"
      ]
    }
  };
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify(tokenConfig)}\n`);
  const server = await createGatewayServer({ stateDir, workspaceRoot });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(`${base}/`);
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  try {
    const mutateRequestBody = {
      runId: "governed-mutate-denied",
      operation: "write",
      path: "seed.txt",
      content: "before"
    };
    const denied = await fetch(`${base}/governed/workspace/mutate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ ...mutateRequestBody, runId: "governed-mutate-denied" })
    });
    assert.equal(denied.status, 400);
    const deniedBody = await denied.json();
    assert.equal(deniedBody.ok, false);
    assert.equal(typeof deniedBody.error, "string");

    const payloadOnly = await fetch(`${base}/governed/workspace/mutate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ ...mutateRequestBody, runId: "governed-mutate-payload-only", input: { capabilityToken: "forged" } })
    });
    assert.equal(payloadOnly.status, 400);
    const payloadOnlyBody = await payloadOnly.json();
    assert.equal(payloadOnlyBody.ok, false);
    assert.equal(typeof payloadOnlyBody.error, "string");

    const issued = await (await fetch(`${base}/capabilities/issue`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        runId: "governed-mutate-allowed",
        stepId: "governed-mutate-step",
        toolName: "workspace.mutate",
        scopes: ["workspace:mutate"]
      })
    })).json();
    const allowed = await fetch(`${base}/governed/workspace/mutate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ ...mutateRequestBody, runId: "governed-mutate-allowed", capabilityToken: issued.token })
    });
    assert.equal(allowed.status, 200);
    const allowedBody = await allowed.json();
    assert.equal(allowedBody.output?.preview, true);
    assert.equal(existsSync(join(workspaceRoot, "seed.txt")), false);
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("governed restore create/apply preserves restore conflict semantics", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-governed-restore-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "odinn-gateway-governed-restore-workspace-"));
  const tokenConfig = {
    version: 1,
    experimental: { capabilities: true },
    policy: {
      allowedCapabilities: [
        "job.healthcheck",
        "text.echo",
        "workspace.readText",
        "workspace.mutate",
        "workspace.patch",
        "restore.create",
        "restore.apply",
        "model.chat",
        "agent.run",
        "web.read",
        "browser.read",
        "browser.act",
        "discord.read",
        "discord.write",
        "session.read",
        "session.write",
        "goal.read",
        "goal.write",
        "memory.read",
        "memory.write",
        "improve.read",
        "improve.write"
      ]
    }
  };
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify(tokenConfig)}\n`);
  const server = await createGatewayServer({ stateDir, workspaceRoot });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(`${base}/`);
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  try {
    const issuedMutateToken = (await (await fetch(`${base}/capabilities/issue`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        runId: "governed-restore-source",
        stepId: "governed-restore-step",
        toolName: "workspace.mutate",
        scopes: ["workspace:mutate"]
      })
    })).json()).token;
    const issuedCreateToken = (await (await fetch(`${base}/capabilities/issue`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        runId: "governed-restore-create",
        stepId: "governed-restore-step",
        toolName: "restore.create",
        scopes: ["restore:create"]
      })
    })).json()).token;
    const issuedApplyToken = (await (await fetch(`${base}/capabilities/issue`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        runId: "governed-restore-apply",
        stepId: "governed-restore-step",
        toolName: "restore.apply",
        scopes: ["restore:apply"]
      })
    })).json()).token;

    await writeFile(join(workspaceRoot, "seed.txt"), "restored baseline");
    const mutateTicket = {
      runId: "governed-restore-source",
      operation: "remove",
      path: "seed.txt",
      apply: true,
      capabilityToken: issuedMutateToken
    };
    const mutate = await fetch(`${base}/governed/workspace/mutate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify(mutateTicket)
    });
    assert.equal(mutate.status, 200);
    const mutation = await mutate.json();
    const checkpointId = mutation.output?.checkpointId;
    assert.equal(typeof checkpointId, "string");
    const create = await fetch(`${base}/governed/restore/create`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ runId: "governed-restore-create", checkpointId, capabilityToken: issuedCreateToken })
    });
    assert.equal(create.status, 200);
    const createBody = await create.json();
    assert.equal(createBody.output?.preview, true);
    assert.equal(createBody.output?.status, "ready");

    await writeFile(join(workspaceRoot, "seed.txt"), "externally-changed");
    const apply = await fetch(`${base}/governed/restore/apply`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ runId: "governed-restore-apply", checkpointId, capabilityToken: issuedApplyToken })
    });
    assert.equal(apply.status, 200);
    const applyBody = await apply.json();
    assert.equal(applyBody.output?.status, "conflict");
    assert.equal(applyBody.output?.applied, false);
    assert.equal(applyBody.output?.preview, true);
    assert.equal(applyBody.output?.conflicts?.some((conflict: any) => typeof conflict.code === "string"), true);
    await writeFile(join(workspaceRoot, "seed.txt"), "externally-changed");
    assert.equal(await readFile(join(workspaceRoot, "seed.txt"), "utf8"), "externally-changed");
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

function requestRaw({ port, path, headers = {} }: any) {
  return new Promise((resolve: any, reject: any) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, headers }, (response: any) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    request.end();
  });
}
