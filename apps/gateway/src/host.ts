#!/usr/bin/env node
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { realpathSync } from "node:fs";
import { chmod, lstat, readFile, realpath, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { exit as exitProcess } from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ensureSecureStateDirectory } from "@odinn/store-file";
import { createStateBackup, withStateMutationLock } from "@odinn/kernel";
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
  const sessionsPath = join(root, "sessions.json");
  const sessionKeyPath = join(root, "session-key");
  const sessions: Map<string, any> = new Map();
  let configuredUsers = users;
  let usersById: Map<string, any> = new Map();
  let tenantsById: Map<string, any> = new Map();
  let membershipsByUser: Map<string, any[]> = new Map();
  let rolesById: Map<string, any> = new Map();
  let controlPlaneMigrated = false;
  const loadUsers = async (override?: any) => {
    const records: any = override ?? (configuredUsers ?? JSON.parse(await readFile(usersPath, "utf8")));
    const controlPlane = normalizeHostControlPlane(records, root);
    if (!configuredUsers && override === undefined && records.schemaVersion !== 2 && !controlPlaneMigrated) {
      await withStateMutationLock(root, async () => {
        let current: any;
        try { current = JSON.parse(await readFile(usersPath, "utf8")); } catch (error: any) { if (error?.code !== "ENOENT") throw error; current = records; }
        const migrated = normalizeHostControlPlane(current, root);
        const temporary = `${usersPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
        await writeFile(temporary, `${JSON.stringify(migrated, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, usersPath);
        await chmod(usersPath, 0o600);
      });
      controlPlaneMigrated = true;
    }
    const active: any[] = [];
    const configuredTenants: any[] = [];
    for (const rawTenant of controlPlane.tenants) {
      const id = normalizeAcceptedTenantId(rawTenant.id);
      if (!id || id !== rawTenant.id) throw new Error("host tenant ids must be canonical lowercase identifiers");
      const workspaceRoot = await realpath(resolve(rawTenant.workspaceRoot));
      const stateDir = resolve(root, rawTenant.stateDirectory || join("tenants", id));
      assertInsideRoot(root, stateDir, "tenant state path");
      await assertPhysicalPathInside(root, stateDir, "tenant state path");
      if (stateDir === root) throw new Error("tenant state path must not be the host state root");
      const status = normalizeTenantStatus(rawTenant.status, rawTenant.disabled);
      configuredTenants.push({ ...rawTenant, id, status, disabled: status === "suspended", workspaceRoot, stateDir });
    }
    if (new Set(configuredTenants.map((tenant: any) => tenant.id)).size !== configuredTenants.length) throw new Error("duplicate host tenant id");
    assertNonOverlappingStateDirectories(root, configuredTenants);
    await assertTenantBoundaries(root, configuredTenants);
    for (const user of controlPlane.users) {
      if (user.disabled) continue;
      const id = normalizeAcceptedUserId(user.id);
      if (!id || id !== user.id) throw new Error("host user ids must be canonical lowercase identifiers");
      const memberships = controlPlane.memberships
        .filter((membership: any) => membership.userId === id && membership.disabled !== true)
        .map((membership: any) => ({ ...membership, userId: id, tenantId: normalizeAcceptedTenantId(membership.tenantId) }))
        .filter((membership: any) => membership.tenantId && configuredTenants.some((tenant: any) => tenant.id === membership.tenantId));
      if (!memberships.length) continue;
      active.push({ ...user, id, memberships, defaultTenantId: memberships.some((item: any) => item.tenantId === user.defaultTenantId) ? user.defaultTenantId : memberships[0].tenantId });
    }
    assertNonOverlappingWorkspaces(configuredTenants);
    if (new Set(active.map((user: any) => user.id)).size !== active.length) throw new Error("duplicate host user id");
    usersById = new Map(active.map((user: any) => [user.id, user]));
    tenantsById = new Map(configuredTenants.map((tenant: any) => [tenant.id, tenant]));
    membershipsByUser = new Map(active.map((user: any) => [user.id, user.memberships]));
    rolesById = new Map(controlPlane.roles.map((role: any) => [role.id, role]));
    for (const [id, session] of sessions) {
      if (!usersById.has(session.userId) || !hasTenantMembership(membershipsByUser, tenantsById, session.userId, session.tenantId)) sessions.delete(id);
    }
    return usersById;
  };
  const mutateControlPlane = async <T>(mutator: (controlPlane: any) => Promise<T> | T): Promise<T> => {
    let result!: T;
    let next: any;
    await withStateMutationLock(root, async () => {
      const current = configuredUsers ?? JSON.parse(await readFile(usersPath, "utf8"));
      const controlPlane = normalizeHostControlPlane(current, root);
      result = await mutator(controlPlane);
      next = normalizeHostControlPlane(controlPlane, root);
      if (configuredUsers) {
        configuredUsers = next;
        return;
      }
      const temporary = `${usersPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, usersPath);
      await chmod(usersPath, 0o600);
    });
    await loadUsers(next);
    return result;
  };
  await loadUsers();
  const sessionKey = await loadOrCreateSessionKey(sessionKeyPath);
  await loadPersistedSessions(sessionsPath, sessions, usersById, membershipsByUser, tenantsById);
  let sessionWritePromise: Promise<void> | undefined;
  let sessionWriteDirty = false;
  const persistSessions = () => {
    sessionWriteDirty = true;
    if (!sessionWritePromise) {
      sessionWritePromise = (async () => {
        while (sessionWriteDirty) {
          sessionWriteDirty = false;
          await withStateMutationLock(root, async () => {
            const snapshot = {
              schemaVersion: 1,
              sessions: [...sessions.values()].map((session: any) => ({
                id: session.id,
                userId: session.userId,
                tenantId: session.tenantId,
                issuedAt: session.issuedAt,
                expiresAt: session.expiresAt
              }))
            };
            const temporary = `${sessionsPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
            await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
            await rename(temporary, sessionsPath);
            await chmod(sessionsPath, 0o600);
          });
        }
      })().finally(() => { sessionWritePromise = undefined; });
    }
    return sessionWritePromise;
  };
  const maximumSessionsGlobal = boundedInteger(sessionLimits.maximumGlobal, 500, 1, 10_000);
  const maximumSessionsPerUser = Math.min(
    maximumSessionsGlobal,
    boundedInteger(sessionLimits.maximumPerUser, 5, 1, 100)
  );
  const sessionDurationMs = boundedInteger(sessionLimits.durationMs, 8 * 60 * 60 * 1000, 1_000, 30 * 24 * 60 * 60 * 1000);
  const sessionSweepMs = boundedInteger(sessionLimits.sweepIntervalMs, Math.min(sessionDurationMs, 60_000), 100, 60_000);
  const sweepSessions = (now = Date.now()) => {
    let changed = false;
    for (const [id, session] of sessions) {
      if (!Number.isFinite(session?.expiresAt) || session.expiresAt <= now) {
        sessions.delete(id);
        changed = true;
      }
    }
    return changed;
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
    let changed = false;
    while (owned.length >= maximumSessionsPerUser) {
      const oldest = owned.shift();
      if (oldest) changed = sessions.delete(oldest[0]) || changed;
    }
    return changed;
  };
  const tenants: Map<string, any> = new Map();
  const tenantIdleMs = Math.max(30_000, Number(tenantLimits.idleMs ?? 15 * 60 * 1000));
  const maximumTenantStorageBytes = Math.max(1_000_000, Number(tenantLimits.maximumStorageBytes ?? 2 * 1024 * 1024 * 1024));
  const maximumActiveTenants = Math.max(1, Number(tenantLimits.maximumActiveTenants ?? 50));
  const maximumTenantBackups = boundedInteger(tenantLimits.maximumBackups, 10, 1, 100);
  const attemptsPath = join(root, "login-attempts.json");
  const loginAttempts: Map<string, any> = new Map();
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

  async function tenant(user: any, tenantId: string) {
    const key = `${user.id}:${tenantId}`;
    const tenantRecord = tenantsById.get(tenantId);
    if (!tenantRecord || !hasTenantMembership(membershipsByUser, tenantsById, user.id, tenantId)) throw new Error("tenant membership is no longer active");
    if (tenantRecord.status !== "active") throw hostError("HOST_TENANT_SUSPENDED", "tenant is suspended");
    if (tenants.has(key)) {
      const current = tenants.get(key);
      current.lastUsedAt = Date.now();
      return current;
    }
    if (tenants.size >= maximumActiveTenants) await evictOldestTenant(tenants);
    const userState = tenantRecord.stateDir;
    assertInsideRoot(root, userState, "tenant state path");
    const workspaceRoot = tenantRecord.workspaceRoot;
    const gateway = await createGatewayServer({ stateDir: userState, workspaceRoot, quotas: tenantRecord.quotas ?? user.quotas ?? tenantLimits, hosted: true, hostedUserId: user.id, hostedTenantId: tenantRecord.id });
    await new Promise((resolveListen: any) => gateway.listen(0, "127.0.0.1", resolveListen));
    const value = { gateway, port: (gateway.address() as any).port, token: (gateway as any).odinnAuthToken, stateDir: userState, lastUsedAt: Date.now() };
    tenants.set(key, value);
    return value;
  }

  const tenantAdministration = (userId: string, tenantId: unknown) => {
    const normalizedTenantId = normalizeAcceptedTenantId(tenantId);
    if (!normalizedTenantId || !hasTenantMembership(membershipsByUser, tenantsById, userId, normalizedTenantId)) {
      throw hostError("HOST_TENANT_ADMIN_FORBIDDEN", "tenant administration requires an active membership");
    }
    if (!hasTenantPermission(membershipsByUser, tenantsById, rolesById, userId, normalizedTenantId, "tenant.manage")) {
      throw hostError("HOST_TENANT_ADMIN_FORBIDDEN", "tenant administration permission required");
    }
    return tenantsById.get(normalizedTenantId);
  };

  const createTenantBackup = async (tenantRecord: any) => {
    const backupParent = join(root, "tenant-backups", tenantRecord.id);
    const backupId = `backup-${Date.now()}-${randomBytes(6).toString("hex")}`;
    const destination = join(backupParent, backupId);
    let report: Awaited<ReturnType<typeof createStateBackup>> | undefined;
    await withStateMutationLock(root, async () => {
      if (await countTenantBackups(backupParent) >= maximumTenantBackups) throw hostError("HOST_TENANT_BACKUP_LIMIT", "tenant backup capacity reached");
      report = await createStateBackup(tenantRecord.stateDir, destination, {
        applicationVersion: process.env.ODINN_VERSION,
        applicationCommit: process.env.ODINN_COMMIT
      });
    });
    if (!report) throw hostError("HOST_TENANT_BACKUP_UNAVAILABLE", "tenant backup did not produce a report");
    return {
      backupId,
      backupPath: relative(root, report.destination).replaceAll("\\", "/"),
      createdAt: report.manifest.createdAt,
      files: report.manifest.files.length,
      includesSensitiveState: report.manifest.includesSensitiveState,
      excluded: report.manifest.excluded
    };
  };

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
  const sessionSweepTimer = setInterval(() => { if (sweepSessions()) void persistSessions().catch(() => undefined); }, sessionSweepMs);
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
        const expiredSessions = sweepSessions(now);
        if (expiredSessions) await persistSessions();
        if (replaceOldestUserSessionAtCapacity(user.id)) await persistSessions();
        if (sessions.size >= maximumSessionsGlobal) {
          response.setHeader("retry-after", String(Math.max(1, Math.ceil(sessionSweepMs / 1_000))));
          return send(response, 503, { error: "host session capacity reached" });
        }
        const id = randomBytes(32).toString("base64url");
        const expiresAt = now + sessionDurationMs;
        const requestedTenantId = body.tenantId === undefined ? undefined : normalizeAcceptedTenantId(body.tenantId);
        if (body.tenantId !== undefined && !requestedTenantId) return send(response, 403, { error: "tenant membership is not active" });
        const tenantId = requestedTenantId && hasTenantMembership(membershipsByUser, tenantsById, user.id, requestedTenantId)
          ? requestedTenantId
          : requestedTenantId
            ? undefined
            : user.defaultTenantId;
        if (!tenantId || !hasTenantMembership(membershipsByUser, tenantsById, user.id, tenantId)) return send(response, 403, { error: "tenant membership is not active" });
        sessions.set(id, { id, userId: user.id, tenantId, issuedAt: now, expiresAt });
        await persistSessions();
        const signature = createHmac("sha256", sessionKey).update(id).digest("base64url");
        response.setHeader("set-cookie", `odinn_host_session=${id}.${signature}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(sessionDurationMs / 1_000)}${tls ? "; Secure" : ""}`);
        return send(response, 200, { ok: true, userId: user.id, tenantId, tenants: membershipsForUser(membershipsByUser, tenantsById, user.id) });
      }
      const expiredBeforeAuth = sweepSessions();
      if (expiredBeforeAuth) await persistSessions();
      const session = authenticate(request, sessions, sessionKey);
      if (!session && request.method === "GET" && request.url === "/") { response.writeHead(302, { location: "/auth/login", "cache-control": "no-store" }); return response.end(); }
      if (!session) return send(response, 401, { error: "host authentication required" });
      if (request.method === "POST" && request.url === "/auth/logout") {
        sessions.delete(session.id);
        await persistSessions();
        response.setHeader("set-cookie", `odinn_host_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${tls ? "; Secure" : ""}`);
        return send(response, 200, { ok: true });
      }
      const user = usersById.get(session.userId);
      if (!user) {
        revokeUserSessions(session.userId);
        await closeUserTenants(session.userId, tenants);
        await persistSessions();
        return send(response, 403, { error: "user disabled" });
      }
      if (!hasTenantMembership(membershipsByUser, tenantsById, user.id, session.tenantId)) {
        sessions.delete(session.id);
        await persistSessions();
        await closeTenant(`${user.id}:${session.tenantId}`, tenants.get(`${user.id}:${session.tenantId}`), tenants).catch(() => undefined);
        return send(response, 403, { error: "tenant membership is not active" });
      }
      if (request.method === "GET" && request.url === "/auth/tenants") {
        return send(response, 200, { ok: true, userId: user.id, tenantId: session.tenantId, tenants: membershipsForUser(membershipsByUser, tenantsById, user.id) });
      }
      if (request.method === "GET" && request.url === "/auth/tenant") {
        const tenantRecord = tenantsById.get(session.tenantId);
        const membership = tenantMembershipForUser(membershipsByUser, user.id, session.tenantId);
        if (!tenantRecord || !membership) return send(response, 403, { error: "tenant membership is not active" });
        return send(response, 200, {
          ok: true,
          userId: user.id,
          tenantId: tenantRecord.id,
          name: tenantRecord.name,
          status: tenantRecord.status,
          role: membership.role,
          permissions: rolePermissions(rolesById, membership.role)
        });
      }
      if (request.method === "POST" && request.url === "/auth/select-tenant") {
        const body = await readBody(request);
        const tenantId = normalizeAcceptedTenantId(body.tenantId);
        if (!tenantId || !hasTenantMembership(membershipsByUser, tenantsById, user.id, tenantId)) return send(response, 403, { error: "tenant membership is not active" });
        const stored = sessions.get(session.id);
        if (!stored) return send(response, 401, { error: "host authentication required" });
        stored.tenantId = tenantId;
        await persistSessions();
        return send(response, 200, { ok: true, userId: user.id, tenantId, tenants: membershipsForUser(membershipsByUser, tenantsById, user.id) });
      }
      if (request.method === "POST" && request.url === "/auth/tenant/lifecycle") {
        const body = await readBody(request);
        const tenantId = normalizeAcceptedTenantId(body.tenantId ?? session.tenantId);
        const status = requestedTenantStatus(body.status);
        if (!tenantId) return send(response, 403, { error: "tenant administration is not permitted" });
        tenantAdministration(user.id, tenantId);
        const result = await mutateControlPlane(async (controlPlane) => {
          if (!hasControlPlaneTenantPermission(controlPlane, user.id, tenantId, "tenant.manage")) {
            throw hostError("HOST_TENANT_ADMIN_FORBIDDEN", "tenant administration permission required");
          }
          const target = controlPlane.tenants.find((tenant: any) => tenant.id === tenantId);
          if (!target) throw hostError("HOST_TENANT_ADMIN_FORBIDDEN", "tenant administration requires an active membership");
          const changed = normalizeTenantStatus(target.status, target.disabled) !== status;
          target.status = status;
          target.disabled = status === "suspended";
          return { tenantId, status, changed };
        });
        if (result.status === "suspended") await closeTenantInstances(result.tenantId, tenants);
        return send(response, 200, { ok: true, ...result });
      }
      if (request.method === "POST" && request.url === "/auth/tenant/backup") {
        const body = await readBody(request);
        const tenantRecord = tenantAdministration(user.id, body.tenantId ?? session.tenantId);
        try {
          return send(response, 200, { ok: true, tenantId: tenantRecord.id, status: tenantRecord.status, backup: await createTenantBackup(tenantRecord) });
        } catch (error: any) {
          if (error?.code === "ENOENT") throw hostError("HOST_TENANT_BACKUP_UNAVAILABLE", "tenant state is not initialized");
          throw error;
        }
      }
      const selectedTenant = tenantsById.get(session.tenantId);
      if (selectedTenant?.status !== "active") return send(response, 423, { error: "tenant is suspended", tenantId: session.tenantId, status: selectedTenant?.status ?? "suspended" });
      const backend = await tenant(user, session.tenantId);
      if (!['GET', 'HEAD'].includes(request.method || 'GET') && await directorySize(backend.stateDir) > maximumTenantStorageBytes) return send(response, 507, { error: "tenant storage quota exceeded" });
      proxy(request, response, backend, session.userId, session.tenantId);
    } catch (error: any) {
      if (error?.code === "HOST_TENANT_SUSPENDED") return send(response, 423, { error: "tenant is suspended", status: "suspended" });
      if (error?.code === "HOST_TENANT_ADMIN_FORBIDDEN") return send(response, 403, { error: "tenant administration is not permitted" });
      if (error?.code === "HOST_TENANT_BACKUP_LIMIT") return send(response, 429, { error: "tenant backup capacity reached" });
      if (error?.code === "HOST_TENANT_BACKUP_UNAVAILABLE") return send(response, 409, { error: "tenant state is not initialized" });
      if (error?.code === "HOST_TENANT_STATUS_INVALID") return send(response, 400, { error: "tenant status must be active or suspended" });
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
    void persistSessions().catch(() => undefined).finally(() => Promise.allSettled([...tenants.values()].map(({ gateway }: any) => new Promise((done: any) => gateway.close(() => done())))).then(() => close(callback)));
    return server;
  };
  return server;
}

function boundedInteger(value: any, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

async function loadOrCreateSessionKey(path: string): Promise<Buffer> {
  try {
    const key = Buffer.from((await readFile(path, "utf8")).trim(), "base64url");
    if (key.length !== 32) throw new Error("host session key is invalid");
    await chmod(path, 0o600);
    return key;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    const key = randomBytes(32);
    try {
      await writeFile(path, `${key.toString("base64url")}\n`, { flag: "wx", mode: 0o600 });
      return key;
    } catch (writeError: any) {
      if (writeError?.code !== "EEXIST") throw writeError;
      return loadOrCreateSessionKey(path);
    }
  }
}

async function loadPersistedSessions(path: string, sessions: Map<string, any>, usersById: Map<string, any>, membershipsByUser: Map<string, any[]>, tenantsById: Map<string, any>): Promise<void> {
  let persisted: any;
  try {
    persisted = JSON.parse(await readFile(path, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (persisted?.schemaVersion !== 1 || !Array.isArray(persisted.sessions)) throw new Error("invalid host session store");
  const now = Date.now();
  for (const record of persisted.sessions) {
    if (!record || typeof record !== "object") continue;
    const id = typeof record.id === "string" && /^[A-Za-z0-9_-]{32,128}$/u.test(record.id) ? record.id : undefined;
    const userId = normalizeAcceptedUserId(record.userId);
    const tenantId = normalizeAcceptedTenantId(record.tenantId);
    const issuedAt = Number(record.issuedAt);
    const expiresAt = Number(record.expiresAt);
    if (!id || !userId || !tenantId || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= now || !usersById.has(userId) || !tenantsById.has(tenantId) || !hasTenantMembership(membershipsByUser, tenantsById, userId, tenantId)) continue;
    sessions.set(id, { id, userId, tenantId, issuedAt, expiresAt });
  }
}

function normalizeHostControlPlane(input: any, root: string) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !Array.isArray(input.users)) throw new Error("host control plane must contain a users array");
  const explicitTenants = Array.isArray(input.tenants) && input.tenants.length > 0;
  const explicitMemberships = Array.isArray(input.memberships) && input.memberships.length > 0;
  const tenants = (explicitTenants
    ? input.tenants.map((tenant: any) => ({ ...tenant }))
    : input.users.map((user: any) => ({
      id: user.id,
      name: user.id,
      workspaceRoot: user.workspaceRoot,
      stateDirectory: join("users", String(user.id))
    }))).map((tenant: any) => {
      const status = normalizeTenantStatus(tenant.status, tenant.disabled);
      return { ...tenant, status, disabled: status === "suspended" };
    });
  const memberships = explicitMemberships
    ? input.memberships.map((membership: any) => ({ ...membership }))
    : input.users.map((user: any) => ({ userId: user.id, tenantId: user.id, role: "owner", disabled: user.disabled === true }));
  const roles = Array.isArray(input.roles) && input.roles.length > 0
    ? input.roles.map((role: any) => ({ ...role }))
    : [
      { id: "owner", name: "Owner", permissions: ["tenant.manage", "tenant.use"] },
      { id: "member", name: "Member", permissions: ["tenant.use"] }
    ];
  const serviceAccounts = Array.isArray(input.serviceAccounts) ? input.serviceAccounts.map((account: any) => ({ ...account })) : [];
  for (const tenant of tenants) {
    if (!tenant || typeof tenant !== "object" || typeof tenant.id !== "string" || typeof tenant.workspaceRoot !== "string") throw new Error("host tenant records require id and workspaceRoot");
    const stateDirectory = String(tenant.stateDirectory || join("tenants", tenant.id));
    if (stateDirectory.startsWith("/") || stateDirectory.split(/[\\/]+/u).includes("..")) throw new Error("host tenant stateDirectory must remain inside the host state root");
    tenant.stateDirectory = stateDirectory;
  }
  for (const membership of memberships) {
    if (!membership || typeof membership !== "object" || typeof membership.userId !== "string" || typeof membership.tenantId !== "string") throw new Error("host memberships require userId and tenantId");
    membership.role = typeof membership.role === "string" && membership.role ? membership.role : "member";
  }
  return { schemaVersion: 2, users: input.users.map((user: any) => ({ ...user })), tenants, memberships, roles, serviceAccounts };
}

function normalizeTenantStatus(value: unknown, legacyDisabled?: unknown): "active" | "suspended" {
  if (value === undefined || value === null || value === "") return legacyDisabled === true ? "suspended" : "active";
  if (value === "active" || value === "suspended") {
    if (value === "active" && legacyDisabled === true) throw new Error("host tenant status conflicts with disabled state");
    return value;
  }
  throw new Error("host tenant status must be active or suspended");
}

function requestedTenantStatus(value: unknown): "active" | "suspended" {
  if (value === "active" || value === "suspended") return value;
  throw hostError("HOST_TENANT_STATUS_INVALID", "tenant status must be active or suspended");
}

function membershipsForUser(membershipsByUser: Map<string, any[]>, tenantsById: Map<string, any>, userId: string): any[] {
  return (membershipsByUser.get(userId) ?? []).map((membership: any) => {
    const tenant = tenantsById.get(membership.tenantId);
    return {
      tenantId: membership.tenantId,
      role: membership.role,
      status: tenant?.status ?? "suspended",
      ...(tenant?.name ? { name: tenant.name } : {})
    };
  });
}

function tenantMembershipForUser(membershipsByUser: Map<string, any[]>, userId: string, tenantId: string): any | undefined {
  return (membershipsByUser.get(userId) ?? []).find((membership: any) => membership.tenantId === tenantId && membership.disabled !== true);
}

function rolePermissions(rolesById: Map<string, any>, roleId: unknown): string[] {
  const permissions = typeof roleId === "string" ? rolesById.get(roleId)?.permissions : undefined;
  return Array.isArray(permissions) ? permissions.filter((permission: unknown): permission is string => typeof permission === "string") : [];
}

function hasTenantPermission(membershipsByUser: Map<string, any[]>, tenantsById: Map<string, any>, rolesById: Map<string, any>, userId: string, tenantId: string, permission: string): boolean {
  const membership = tenantMembershipForUser(membershipsByUser, userId, tenantId);
  return Boolean(membership && tenantsById.has(tenantId) && rolePermissions(rolesById, membership.role).includes(permission));
}

function hasControlPlaneTenantPermission(controlPlane: any, userId: string, tenantId: string, permission: string): boolean {
  const user = controlPlane.users.find((candidate: any) => candidate.id === userId && candidate.disabled !== true);
  const tenant = controlPlane.tenants.find((candidate: any) => candidate.id === tenantId);
  const membership = controlPlane.memberships.find((candidate: any) => candidate.userId === userId && candidate.tenantId === tenantId && candidate.disabled !== true);
  const role = controlPlane.roles.find((candidate: any) => candidate.id === membership?.role);
  return Boolean(user && tenant && membership && Array.isArray(role?.permissions) && role.permissions.includes(permission));
}

function hasTenantMembership(membershipsByUser: Map<string, any[]>, tenantsById: Map<string, any>, userId: string, tenantId: unknown): boolean {
  const normalized = normalizeAcceptedTenantId(tenantId);
  return Boolean(normalized && tenantsById.has(normalized) && (membershipsByUser.get(userId) ?? []).some((membership: any) => membership.tenantId === normalized && membership.disabled !== true));
}

function assertInsideRoot(root: string, target: string, label: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) throw new Error(`invalid ${label}`);
}

async function assertPhysicalPathInside(root: string, target: string, label: string): Promise<void> {
  const physicalRoot = await realpath(root);
  let cursor = resolve(target);
  while (true) {
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) throw new Error(`invalid ${label}: symbolic links are not allowed`);
      const physical = await realpath(cursor);
      if (physical !== physicalRoot && !physical.startsWith(`${physicalRoot}${sep}`)) throw new Error(`invalid ${label}`);
      return;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      const parent = resolve(cursor, "..");
      if (parent === cursor) throw new Error(`invalid ${label}`);
      cursor = parent;
    }
  }
}

function normalizeAcceptedUserId(value: any) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(normalized) ? normalized : null;
}

function normalizeAcceptedTenantId(value: any) {
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
    let config: any = { schemaVersion: 2, users: [], tenants: [], memberships: [], roles: [], serviceAccounts: [] };
    try { config = JSON.parse(await readFile(path, "utf8")); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    config = normalizeHostControlPlane(config, root);
    const user = { id, defaultTenantId: id, salt: credentials.salt, passwordHash: credentials.hash, disabled: false };
    config.users = [...config.users.filter((item: any) => item.id !== id), user];
    config.tenants = [...config.tenants.filter((item: any) => item.id !== id), { id, name: id, workspaceRoot: workspace, stateDirectory: join("users", id), status: "active", disabled: false }];
    config.memberships = [...config.memberships.filter((item: any) => !(item.userId === id && item.tenantId === id)), { userId: id, tenantId: id, role: "owner", disabled: false }];
    const temporary = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path); await chmod(path, 0o600);
  });
  return { id, workspaceRoot: workspace };
}

function proxy(incoming: any, outgoing: any, backend: any, userId = "", tenantId = "") {
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
    forwarded["x-odinn-host-tenant"] = tenantId;
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

function assertNonOverlappingStateDirectories(root: string, tenants: any[]) {
  for (let leftIndex = 0; leftIndex < tenants.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < tenants.length; rightIndex += 1) {
      const left = resolve(root, tenants[leftIndex].stateDir ?? tenants[leftIndex].stateDirectory);
      const right = resolve(root, tenants[rightIndex].stateDir ?? tenants[rightIndex].stateDirectory);
      if (left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`)) {
        throw new Error(`tenant state directories overlap: ${tenants[leftIndex].id} and ${tenants[rightIndex].id}`);
      }
    }
  }
}

async function assertTenantBoundaries(root: string, tenants: any[]): Promise<void> {
  const physicalRoot = await realpath(root);
  for (const tenant of tenants) {
    if (pathsOverlap(tenant.workspaceRoot, physicalRoot)) {
      throw new Error(`tenant workspace overlaps host state: ${tenant.id}`);
    }
    for (const other of tenants) {
      if (pathsOverlap(tenant.workspaceRoot, resolve(root, other.stateDir))) {
        throw new Error(`tenant workspace overlaps tenant state: ${tenant.id} and ${other.id}`);
      }
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
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

export async function addHostTenant({ stateDir = ".odinn-host", id, name, workspaceRoot, quotas }: any) {
  const tenantId = normalizeAcceptedTenantId(id);
  if (!tenantId) throw new Error("tenant id must contain 2-64 lowercase letters, digits, underscores, or hyphens");
  const root = resolve(stateDir);
  await ensureSecureStateDirectory(root);
  const workspace = await realpath(resolve(workspaceRoot));
  const path = join(root, "users.json");
  await withStateMutationLock(root, async () => {
    let config: any = { schemaVersion: 2, users: [], tenants: [], memberships: [], roles: [], serviceAccounts: [] };
    try { config = JSON.parse(await readFile(path, "utf8")); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    config = normalizeHostControlPlane(config, root);
    config.tenants = [...config.tenants.filter((item: any) => item.id !== tenantId), { id: tenantId, name: String(name || tenantId).slice(0, 120), workspaceRoot: workspace, stateDirectory: join("tenants", tenantId), quotas, status: "active", disabled: false }];
    const temporary = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path); await chmod(path, 0o600);
  });
  return { id: tenantId, name: String(name || tenantId).slice(0, 120), workspaceRoot: workspace };
}

export async function addHostMembership({ stateDir = ".odinn-host", userId, tenantId, role = "member" }: any) {
  const normalizedUserId = normalizeAcceptedUserId(userId);
  const normalizedTenantId = normalizeAcceptedTenantId(tenantId);
  if (!normalizedUserId || !normalizedTenantId) throw new Error("membership requires canonical user and tenant ids");
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(String(role))) throw new Error("membership role is invalid");
  const root = resolve(stateDir);
  await ensureSecureStateDirectory(root);
  const path = join(root, "users.json");
  await withStateMutationLock(root, async () => {
    let config: any = { schemaVersion: 2, users: [], tenants: [], memberships: [], roles: [], serviceAccounts: [] };
    try { config = JSON.parse(await readFile(path, "utf8")); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    config = normalizeHostControlPlane(config, root);
    if (!config.users.some((item: any) => item.id === normalizedUserId)) throw new Error("host user not found");
    if (!config.tenants.some((item: any) => item.id === normalizedTenantId)) throw new Error("host tenant not found");
    config.memberships = [...config.memberships.filter((item: any) => !(item.userId === normalizedUserId && item.tenantId === normalizedTenantId)), { userId: normalizedUserId, tenantId: normalizedTenantId, role, disabled: false }];
    const temporary = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path); await chmod(path, 0o600);
  });
  return { userId: normalizedUserId, tenantId: normalizedTenantId, role };
}

async function closeTenant(id: string, value: any, tenants: Map<string, any>) {
  if (!value) return;
  tenants.delete(id);
  await new Promise<void>((resolveClose) => value.gateway.close(() => resolveClose()));
}

async function closeUserTenants(userId: string, tenants: Map<string, any>) {
  const owned = [...tenants.entries()].filter(([key]) => key.startsWith(`${userId}:`));
  await Promise.allSettled(owned.map(([key, value]) => closeTenant(key, value, tenants)));
}

async function closeTenantInstances(tenantId: string, tenants: Map<string, any>) {
  const owned = [...tenants.entries()].filter(([key]) => key.endsWith(`:${tenantId}`));
  await Promise.allSettled(owned.map(([key, value]) => closeTenant(key, value, tenants)));
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

function hostError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

async function countTenantBackups(path: string): Promise<number> {
  let entries: any[];
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("tenant backup directory must be a physical directory");
    entries = await readdir(path, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    const metadata = await lstat(child);
    if (metadata.isSymbolicLink()) throw new Error("tenant backup directory contains a symbolic link");
    if (metadata.isDirectory()) count += 1;
    else if (!metadata.isFile()) throw new Error("tenant backup directory contains an unsupported entry");
  }
  return count;
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
    exitProcess(0);
  }
  if (process.argv[2] === "tenant-add") {
    const value = (name: any) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : ""; };
    const result = await addHostTenant({ stateDir, id: value("--id"), name: value("--name"), workspaceRoot: value("--workspace") });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    exitProcess(0);
  }
  if (process.argv[2] === "membership-add") {
    const value = (name: any) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : ""; };
    const result = await addHostMembership({ stateDir, userId: value("--user"), tenantId: value("--tenant"), role: value("--role") || "member" });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    exitProcess(0);
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
