#!/usr/bin/env node
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { realpathSync } from "node:fs";
import { chmod, lstat, readFile, realpath, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ensureSecureStateDirectory } from "@odinn/store-file";
import { withStateMutationLock } from "@odinn/kernel";
import { createGatewayServer } from "./server.ts";

const scrypt: any = promisify(scryptCallback);
declare const __ODINN_COMPILED__: boolean | undefined;
const compiledRuntime = typeof __ODINN_COMPILED__ !== "undefined";
const isMain = isHostEntrypoint();

function isHostEntrypoint() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  if (compiledRuntime) {
    return basename(process.argv[1]) === "host.js" && basename(modulePath) === "host.js";
  }
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(modulePath);
  } catch {
    return resolve(process.argv[1]) === modulePath;
  }
}

export async function hashPassword(password: any, salt: any = randomBytes(16).toString("base64url")) {
  if (String(password).length < 12) throw new Error("gateway host passwords require at least 12 characters");
  return { salt, hash: Buffer.from(await scrypt(password, salt, 32)).toString("base64url") };
}

export async function verifyPassword(password: any, record: any) {
  const actual = Buffer.from(await scrypt(password, record.salt, 32));
  const expected = Buffer.from(record.passwordHash, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function createMultiUserHost({
  stateDir = ".odinn-host",
  users,
  publicOrigin,
  tls,
  loginLimits = {},
  sessionLimits = {},
  tenantLimits = {}
}: any = {}) {
  const root = resolve(stateDir);
  await ensureSecureStateDirectory(root);
  const usersPath = join(root, "users.json");
  const sessions: Map<string, any> = new Map();
  let usersById: Map<string, any> = new Map();
  const loadUsers = async () => {
    const records: any = users ?? JSON.parse(await readFile(usersPath, "utf8"));
    const active = [];
    for (const user of records.users ?? []) {
      if (user.disabled) continue;
      const id = normalizeAcceptedUserId(user.id);
      if (!id || id !== user.id) throw new Error("host user ids must be canonical lowercase identifiers");
      active.push({ ...user, id, workspaceRoot: await realpath(resolve(user.workspaceRoot)) });
    }
    assertNonOverlappingWorkspaces(active);
    if (new Set(active.map((user: any) => user.id)).size !== active.length) throw new Error("duplicate host user id");
    usersById = new Map(active.map((user: any) => [user.id, user]));
    for (const [id, session] of sessions) {
      if (!usersById.has(session.userId)) sessions.delete(id);
    }
    return usersById;
  };
  await loadUsers();
  const maximumSessionsGlobal = boundedInteger(sessionLimits.maximumGlobal, 500, 1, 10_000);
  const maximumSessionsPerUser = Math.min(
    maximumSessionsGlobal,
    boundedInteger(sessionLimits.maximumPerUser, 5, 1, 100)
  );
  const sessionDurationMs = boundedInteger(sessionLimits.durationMs, 8 * 60 * 60 * 1000, 1_000, 30 * 24 * 60 * 60 * 1000);
  const sessionSweepMs = boundedInteger(sessionLimits.sweepIntervalMs, Math.min(sessionDurationMs, 60_000), 100, 60_000);
  const sweepSessions = (now = Date.now()) => {
    for (const [id, session] of sessions) {
      if (!Number.isFinite(session?.expiresAt) || session.expiresAt <= now) sessions.delete(id);
    }
  };
  const revokeUserSessions = (userId: string) => {
    for (const [id, session] of sessions) {
      if (session.userId === userId) sessions.delete(id);
    }
  };
  const replaceOldestUserSessionAtCapacity = (userId: string) => {
    const owned = Array.from(sessions.entries())
      .filter(([, session]) => session.userId === userId)
      .sort((left, right) => left[1].issuedAt - right[1].issuedAt);
    while (owned.length >= maximumSessionsPerUser) {
      const oldest = owned.shift();
      if (oldest) sessions.delete(oldest[0]);
    }
  };
  const tenants: Map<string, any> = new Map();
  const tenantIdleMs = Math.max(30_000, Number(tenantLimits.idleMs ?? 15 * 60 * 1000));
  const maximumTenantStorageBytes = Math.max(1_000_000, Number(tenantLimits.maximumStorageBytes ?? 2 * 1024 * 1024 * 1024));
  const maximumActiveTenants = Math.max(1, Number(tenantLimits.maximumActiveTenants ?? 50));
  const attemptsPath = join(root, "login-attempts.json");
  const loginAttempts: Map<string, any> = new Map();
  const sessionKey = randomBytes(32);
  const maximumLoginAttempts = boundedInteger(loginLimits.maximumAttempts, 5, 1, 1_000);
  const maximumIpLoginAttempts = boundedInteger(loginLimits.maximumAttemptsPerIp, Math.max(50, maximumLoginAttempts * 20), maximumLoginAttempts, 100_000);
  const maximumLoginAttemptRecords = boundedInteger(loginLimits.maximumRecords, 1_000, 4, 10_000);
  const maximumGlobalLoginAttempts = boundedInteger(
    loginLimits.maximumAttemptsGlobal,
    Math.max(200, maximumIpLoginAttempts * 10),
    maximumIpLoginAttempts,
    1_000_000
  );
  const loginWindowMs = boundedInteger(loginLimits.windowMs, 5 * 60 * 1000, 1_000, 24 * 60 * 60 * 1000);
  const sweepLoginAttempts = (now = Date.now()) => {
    let changed = false;
    for (const [key, value] of loginAttempts) {
      if (!Number.isInteger(value?.count) || value.count < 1 || !Number.isFinite(value?.resetAt) || value.resetAt <= now) {
        loginAttempts.delete(key);
        changed = true;
      }
    }
    return changed;
  };
  const trimLoginAttempts = () => {
    if (loginAttempts.size <= maximumLoginAttemptRecords) return false;
    const retained = Array.from(loginAttempts.entries())
      .sort((left, right) =>
        Number(right[1]?.count ?? 0) - Number(left[1]?.count ?? 0)
        || Number(right[1]?.updatedAt ?? 0) - Number(left[1]?.updatedAt ?? 0)
      )
      .slice(0, maximumLoginAttemptRecords);
    loginAttempts.clear();
    for (const [key, value] of retained) loginAttempts.set(key, value);
    return true;
  };
  try {
    const persisted = JSON.parse(await readFile(attemptsPath, "utf8"));
    if (![1, 2].includes(persisted?.schemaVersion) || !persisted.attempts || typeof persisted.attempts !== "object") throw new Error("invalid login attempt store");
    for (const [key, value] of Object.entries(persisted.attempts) as any) {
      if (Number.isInteger(value?.count) && value.count > 0 && Number(value.resetAt) > Date.now()) {
        const persistedKey = persisted.schemaVersion === 1 ? migrateLegacyLoginAttemptKey(key) : String(key).slice(0, 256);
        if (!persistedKey) continue;
        loginAttempts.set(persistedKey, {
          count: value.count,
          resetAt: Number(value.resetAt),
          updatedAt: Number(value.updatedAt) || Date.now()
        });
      }
    }
    trimLoginAttempts();
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  let attemptWritePromise: Promise<void> | undefined;
  let attemptWriteDirty = false;
  const persistLoginAttempts = () => {
    attemptWriteDirty = true;
    if (!attemptWritePromise) {
      attemptWritePromise = (async () => {
        while (attemptWriteDirty) {
          attemptWriteDirty = false;
          await withStateMutationLock(root, async () => {
            const merged = new Map<string, any>();
            try {
              const persisted = JSON.parse(await readFile(attemptsPath, "utf8"));
              if (persisted?.schemaVersion === 2 && persisted.attempts && typeof persisted.attempts === "object") {
                for (const [key, value] of Object.entries(persisted.attempts) as any) {
                  if (Number.isInteger(value?.count) && value.count > 0 && Number(value.resetAt) > Date.now()) merged.set(String(key).slice(0, 256), {
                    count: value.count,
                    resetAt: Number(value.resetAt),
                    updatedAt: Number(value.updatedAt) || Date.now()
                  });
                }
              }
            } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
            for (const [key, value] of loginAttempts) {
              const previous = merged.get(key);
              merged.set(key, previous && previous.count > value.count
                ? previous
                : { count: Math.max(previous?.count ?? 0, value.count), resetAt: Math.max(previous?.resetAt ?? 0, value.resetAt), updatedAt: Math.max(previous?.updatedAt ?? 0, value.updatedAt) });
            }
            loginAttempts.clear();
            for (const [key, value] of merged) loginAttempts.set(key, value);
            trimLoginAttempts();
            const snapshot = `${JSON.stringify({ schemaVersion: 2, attempts: Object.fromEntries(loginAttempts) })}\n`;
            const temporary = `${attemptsPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
            await writeFile(temporary, snapshot, { mode: 0o600 });
            await rename(temporary, attemptsPath);
            await chmod(attemptsPath, 0o600);
          });
        }
      })().finally(() => {
        attemptWritePromise = undefined;
      });
    }
    return attemptWritePromise;
  };

  async function tenant(user: any) {
    if (tenants.has(user.id)) {
      const current = tenants.get(user.id);
      current.lastUsedAt = Date.now();
      return current;
    }
    if (tenants.size >= maximumActiveTenants) await evictOldestTenant(tenants);
    const userState = resolve(root, "users", user.id);
    if (!userState.startsWith(`${root}${sep}`)) throw new Error("invalid tenant state path");
    const workspaceRoot = await realpath(resolve(user.workspaceRoot));
    const gateway = await createGatewayServer({ stateDir: userState, workspaceRoot, quotas: user.quotas ?? tenantLimits, hosted: true });
    await new Promise((resolveListen: any) => gateway.listen(0, "127.0.0.1", resolveListen));
    const value = { gateway, port: (gateway.address() as any).port, token: (gateway as any).odinnAuthToken, stateDir: userState, lastUsedAt: Date.now() };
    tenants.set(user.id, value);
    return value;
  }

  const evictionTimer = setInterval(() => {
    const cutoff = Date.now() - tenantIdleMs;
    for (const [id, value] of tenants) {
      if (value.lastUsedAt < cutoff) closeTenant(id, value, tenants).catch(() => undefined);
    }
  }, Math.min(tenantIdleMs, 60_000));
  evictionTimer.unref();
  const loginAttemptSweepTimer = setInterval(() => {
    if (sweepLoginAttempts()) void persistLoginAttempts().catch(() => undefined);
  }, Math.min(loginWindowMs, 60_000));
  loginAttemptSweepTimer.unref();
  const sessionSweepTimer = setInterval(sweepSessions, sessionSweepMs);
  sessionSweepTimer.unref();

  const handler = async (request: any, response: any) => {
    try {
      if (!users) await loadUsers();
      const origin = request.headers.origin;
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method || "GET");
      if (publicOrigin && mutating && origin !== publicOrigin) return send(response, 403, { error: "origin rejected" });
      if (origin && publicOrigin && origin !== publicOrigin) return send(response, 403, { error: "origin rejected" });
      if (request.method === "GET" && request.url === "/auth/login") return loginPage(response);
      if (request.method === "POST" && request.url === "/auth/login") {
        const body = await readBody(request);
        const now = Date.now();
        const swept = sweepLoginAttempts(now);
        const normalizedUserId = normalizeAcceptedUserId(body.userId);
        const clientIp = normalizeClientIp(request.socket.remoteAddress);
        const attemptKey = `pair:${clientIp}:${normalizedUserId ?? "<invalid>"}`;
        const ipAttemptKey = `ip:${clientIp}`;
        const globalAttemptKey = "global";
        const attempt = loginAttempts.get(attemptKey);
        const ipAttempt = loginAttempts.get(ipAttemptKey);
        const globalAttempt = loginAttempts.get(globalAttemptKey);
        const blocked = globalAttempt?.count >= maximumGlobalLoginAttempts
          ? globalAttempt
          : attempt?.count >= maximumLoginAttempts
            ? attempt
            : ipAttempt?.count >= maximumIpLoginAttempts
            ? ipAttempt
            : undefined;
        if (blocked) {
          if (swept) await persistLoginAttempts();
          response.setHeader("retry-after", String(Math.max(1, Math.ceil((blocked.resetAt - now) / 1000))));
          return send(response, 429, { error: "too many authentication attempts" });
        }
        const user = normalizedUserId ? usersById.get(normalizedUserId) : undefined;
        if (!user || !await verifyPassword(String(body.password || ""), user)) {
          const requiredRecords = [attemptKey, ipAttemptKey, globalAttemptKey]
            .filter((key) => !loginAttempts.has(key)).length;
          if (loginAttempts.size + requiredRecords > maximumLoginAttemptRecords) {
            if (swept) await persistLoginAttempts();
            response.setHeader("retry-after", String(Math.max(1, Math.ceil(loginWindowMs / 1000))));
            return send(response, 429, { error: "authentication throttle capacity reached" });
          }
          incrementLoginAttempt(loginAttempts, attemptKey, now, loginWindowMs);
          incrementLoginAttempt(loginAttempts, ipAttemptKey, now, loginWindowMs);
          incrementLoginAttempt(loginAttempts, globalAttemptKey, now, loginWindowMs);
          await persistLoginAttempts();
          return send(response, 401, { error: "invalid credentials" });
        }
        const pairAttemptCleared = loginAttempts.delete(attemptKey);
        if (pairAttemptCleared || swept) await persistLoginAttempts();
        sweepSessions(now);
        replaceOldestUserSessionAtCapacity(user.id);
        if (sessions.size >= maximumSessionsGlobal) {
          response.setHeader("retry-after", String(Math.max(1, Math.ceil(sessionSweepMs / 1_000))));
          return send(response, 503, { error: "host session capacity reached" });
        }
        const id = randomBytes(32).toString("base64url");
        const expiresAt = now + sessionDurationMs;
        sessions.set(id, { userId: user.id, issuedAt: now, expiresAt });
        const signature = createHmac("sha256", sessionKey).update(id).digest("base64url");
        response.setHeader("set-cookie", `odinn_host_session=${id}.${signature}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(sessionDurationMs / 1_000)}${tls ? "; Secure" : ""}`);
        return send(response, 200, { ok: true, userId: user.id });
      }
      const session = authenticate(request, sessions, sessionKey);
      if (!session && request.method === "GET" && request.url === "/") { response.writeHead(302, { location: "/auth/login", "cache-control": "no-store" }); return response.end(); }
      if (!session) return send(response, 401, { error: "host authentication required" });
      if (request.method === "POST" && request.url === "/auth/logout") {
        sessions.delete(session.id);
        response.setHeader("set-cookie", `odinn_host_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${tls ? "; Secure" : ""}`);
        return send(response, 200, { ok: true });
      }
      const user = usersById.get(session.userId);
      if (!user) {
        revokeUserSessions(session.userId);
        const current = tenants.get(session.userId);
        if (current) await closeTenant(session.userId, current, tenants);
        return send(response, 403, { error: "user disabled" });
      }
      const backend = await tenant(user);
      if (!['GET', 'HEAD'].includes(request.method || 'GET') && await directorySize(backend.stateDir) > maximumTenantStorageBytes) return send(response, 507, { error: "tenant storage quota exceeded" });
      proxy(request, response, backend, session.userId);
    } catch (error: any) {
      console.error("Odinn host request failed:", error);
      send(response, 500, { error: "internal host error" });
    }
  };
  const server: any = tls ? createHttpsServer(tls, handler) : createHttpServer(handler);
  const close = server.close.bind(server);
  server.close = (callback: any) => {
    clearInterval(evictionTimer);
    clearInterval(loginAttemptSweepTimer);
    clearInterval(sessionSweepTimer);
    void Promise.allSettled([...tenants.values()].map(({ gateway }: any) => new Promise((done: any) => gateway.close(() => done())))).then(() => close(callback));
    return server;
  };
  return server;
}

function boundedInteger(value: any, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function normalizeAcceptedUserId(value: any) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(normalized) ? normalized : null;
}

function normalizeClientIp(value: any) {
  const normalized = String(value || "unknown").trim().toLowerCase().replace(/^::ffff:/u, "");
  return /^[a-f0-9:.]{1,64}$/u.test(normalized) ? normalized : "unknown";
}

function migrateLegacyLoginAttemptKey(value: any) {
  const key = String(value);
  const separator = key.lastIndexOf(":");
  if (separator < 1) return null;
  const userId = normalizeAcceptedUserId(key.slice(separator + 1));
  if (!userId) return null;
  return `pair:${normalizeClientIp(key.slice(0, separator))}:${userId}`;
}

function incrementLoginAttempt(attempts: Map<string, any>, key: string, now: number, windowMs: number) {
  const current = attempts.get(key);
  attempts.delete(key);
  attempts.set(key, {
    count: (current?.count ?? 0) + 1,
    resetAt: current?.resetAt ?? now + windowMs,
    updatedAt: now
  });
}

export async function addHostUser({ stateDir = ".odinn-host", id, password, workspaceRoot }: any) {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(String(id || ""))) throw new Error("user id must contain 2-64 lowercase letters, digits, underscores, or hyphens");
  const root = resolve(stateDir); await ensureSecureStateDirectory(root);
  const workspace = await realpath(resolve(workspaceRoot));
  const credentials = await hashPassword(password);
  const path = join(root, "users.json");
  await withStateMutationLock(root, async () => {
    let config: any = { schemaVersion: 1, users: [] };
    try { config = JSON.parse(await readFile(path, "utf8")); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    const user = { id, workspaceRoot: workspace, salt: credentials.salt, passwordHash: credentials.hash, disabled: false };
    config.users = [...(config.users ?? []).filter((item: any) => item.id !== id), user];
    const temporary = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path); await chmod(path, 0o600);
  });
  return { id, workspaceRoot: workspace };
}

function proxy(incoming: any, outgoing: any, backend: any, userId = "") {
  const headers: Record<string, string | string[] | undefined> = {
    host: `127.0.0.1:${backend.port}`,
    authorization: `Bearer ${backend.token}`,
    "content-type": incoming.headers["content-type"],
    "content-length": incoming.headers["content-length"],
    accept: incoming.headers.accept,
    "accept-encoding": incoming.headers["accept-encoding"],
    "last-event-id": incoming.headers["last-event-id"],
    "idempotency-key": incoming.headers["idempotency-key"],
    origin: incoming.headers.origin ? `http://127.0.0.1:${backend.port}` : undefined,
    "sec-fetch-site": incoming.headers["sec-fetch-site"]
  };
  const sanitizedHeaders = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
  const request = httpRequest({ hostname: "127.0.0.1", port: backend.port, path: incoming.url, method: incoming.method, headers: sanitizedHeaders }, (response: any) => {
    const forwarded = { ...response.headers }; delete forwarded["set-cookie"];
    forwarded["x-odinn-hosted"] = "true";
    forwarded["x-odinn-host-user"] = userId;
    outgoing.writeHead(response.statusCode ?? 502, forwarded); response.pipe(outgoing);
  });
  request.on("error", (error: any) => {
    console.error("Odinn tenant gateway proxy failed:", error);
    send(outgoing, 502, { error: "tenant gateway unavailable" });
  });
  incoming.pipe(request);
}

function assertNonOverlappingWorkspaces(users: any[]) {
  for (let leftIndex = 0; leftIndex < users.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < users.length; rightIndex += 1) {
      const left = resolve(users[leftIndex].workspaceRoot);
      const right = resolve(users[rightIndex].workspaceRoot);
      if (left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`)) {
        throw new Error(`tenant workspaces overlap: ${users[leftIndex].id} and ${users[rightIndex].id}`);
      }
    }
  }
}

async function directorySize(root: string): Promise<number> {
  let total = 0;
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) await walk(path);
      else if (metadata.isFile()) total += metadata.size;
    }
  };
  try { await walk(root); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  return total;
}

async function closeTenant(id: string, value: any, tenants: Map<string, any>) {
  tenants.delete(id);
  await new Promise<void>((resolveClose) => value.gateway.close(() => resolveClose()));
}

async function evictOldestTenant(tenants: Map<string, any>) {
  const oldest = [...tenants.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
  if (oldest) await closeTenant(oldest[0], oldest[1], tenants);
}

function authenticate(request: any, sessions: any, key: any) {
  const raw = String(request.headers.cookie || "").split(/;\s*/).find((item: any) => item.startsWith("odinn_host_session="))?.split("=").slice(1).join("=");
  const [id, signature] = String(raw || "").split(".");
  if (!id || !signature) return null;
  const expected = createHmac("sha256", key).update(id).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const session = sessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) sessions.delete(id);
    return null;
  }
  return { ...session, id };
}
async function readBody(request: any) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > 16_384) throw new Error("request too large"); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
function send(response: any, status: any, value: any) { if (response.headersSent) return; response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(`${JSON.stringify(value)}\n`); }
function loginPage(response: any) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'" });
  response.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in to Ódinn Forge</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#080a0d;color:#e7e9ee;font:15px system-ui;display:grid;place-items:center;min-height:100vh;padding:20px}
    form{width:min(390px,100%);display:grid;gap:14px;padding:28px;border:1px solid #343b47;border-radius:16px;background:#11141a;box-shadow:0 18px 54px rgba(0,0,0,.35)}
    h1,p{margin:0}p{color:#aeb8c7;line-height:1.5}label{display:grid;gap:7px;font-weight:700}
    input,button{min-height:46px;padding:12px;border-radius:9px;border:1px solid #4a5566;background:#0b0e13;color:inherit;font:inherit}
    button{background:#d6a84b;color:#111;font-weight:800;cursor:pointer}button:disabled{cursor:wait;opacity:.72}
    input:focus-visible,button:focus-visible{outline:3px solid #8baeff;outline-offset:2px}
    #error{min-height:22px;color:#ff9eaa;font-weight:700}
  </style>
</head>
<body>
  <form id="login">
    <h1>Sign in to Ódinn Forge</h1>
    <p>Use the account provided by this host's administrator. Each account has a separate workspace and state.</p>
    <label for="user-id">User ID<input id="user-id" name="userId" autocomplete="username" required></label>
    <label for="password">Password<input id="password" name="password" type="password" autocomplete="current-password" required></label>
    <button id="sign-in" type="submit">Sign in</button>
    <div id="error" role="alert" aria-live="assertive"></div>
  </form>
  <script>
    const form=document.getElementById('login');
    const button=document.getElementById('sign-in');
    const error=document.getElementById('error');
    form.addEventListener('submit',async(event)=>{
      event.preventDefault();
      error.textContent='';
      button.disabled=true;
      button.textContent='Signing in…';
      try{
        const fields=new FormData(form);
        const response=await fetch('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(fields))});
        if(response.ok){location.assign('/');return;}
        const payload=await response.json().catch(()=>({}));
        error.textContent=response.status===429
          ? 'Too many sign-in attempts. Wait a few minutes and try again.'
          : payload.error==='user disabled'
            ? 'This account is disabled. Contact the host administrator.'
            : 'Sign-in failed. Check your user ID and password.';
        document.getElementById('user-id').focus();
      }catch{
        error.textContent='The sign-in service is unavailable. Check your connection and try again.';
        document.getElementById('user-id').focus();
      }finally{
        button.disabled=false;
        button.textContent='Sign in';
      }
    });
  </script>
</body>
</html>`);
}

if (isMain) {
  const stateDir = resolve(process.env.ODINN_HOST_STATE || ".odinn-host");
  if (process.argv[2] === "user-add") {
    const value = (name: any) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : ""; };
    const result = await addHostUser({ stateDir, id: value("--id"), password: process.env.ODINN_USER_PASSWORD, workspaceRoot: value("--workspace") });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    process.exit(0);
  }
  const host = process.env.ODINN_HOST || "127.0.0.1";
  const port = Number(process.env.ODINN_PORT || 18791);
  const remote = !["127.0.0.1", "::1", "localhost"].includes(host);
  if (process.env.ODINN_CONFIRM_IMPACT !== "true") {
    console.error("Multi-user host impact summary\n\nAuthority changes: starts an authenticated multi-user service with separate application-level tenant state and loopback gateways.\nApproval gates: TLS, public-origin, password, session, quota, and tenant routing controls remain active; this is not hostile-user operating-system isolation.\nRollback or disable: stop the host and remove or disable its configuration; tenant state remains on disk until deliberately removed.\nAudit record: each tenant audit journal and the host state directory retain the operational records.\n\nExplicit confirmation required: set ODINN_CONFIRM_IMPACT=true after reviewing this summary.");
    throw new Error("impact confirmation required for multi-user-host");
  }
  const cert = process.env.ODINN_TLS_CERT; const key = process.env.ODINN_TLS_KEY;
  if (remote && (!cert || !key || !process.env.ODINN_PUBLIC_ORIGIN)) throw new Error("remote hosting requires ODINN_TLS_CERT, ODINN_TLS_KEY, and ODINN_PUBLIC_ORIGIN");
  const tls = cert && key ? { cert: await readFile(cert), key: await readFile(key) } : undefined;
  const server = await createMultiUserHost({
    stateDir,
    publicOrigin: process.env.ODINN_PUBLIC_ORIGIN,
    tls,
    sessionLimits: {
      maximumPerUser: process.env.ODINN_HOST_SESSION_MAX_PER_USER,
      maximumGlobal: process.env.ODINN_HOST_SESSION_MAX_GLOBAL,
      durationMs: process.env.ODINN_HOST_SESSION_DURATION_MS,
      sweepIntervalMs: process.env.ODINN_HOST_SESSION_SWEEP_MS
    }
  });
  server.listen(port, host, () => console.log(`Odinn Forge multi-user host listening on ${tls ? "https" : "http"}://${host}:${port}`));
}
