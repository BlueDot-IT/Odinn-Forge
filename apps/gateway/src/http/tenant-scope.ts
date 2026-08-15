/**
 * The tenant context used by a hosted gateway is derived from the host's
 * authenticated session, never from a request body or transport header.
 *
 * Each hosted tenant currently has its own state root and gateway instance.
 * This module makes that boundary explicit at the gateway composition root so
 * durable jobs, audit projections, and inbound claims carry the same trusted
 * scope as the application read plane.
 */

export type GatewayTenantScope = Readonly<{
  tenantId: string;
  principalId: string;
  userId?: string;
  hosted: boolean;
}>;

const ACCEPTED_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/u;

export function createGatewayTenantScope({
  hosted = false,
  userId,
  tenantId,
}: {
  hosted?: boolean;
  userId?: unknown;
  tenantId?: unknown;
} = {}): GatewayTenantScope {
  if (!hosted) {
    return Object.freeze({ tenantId: "tenant:local", principalId: "local-gateway-user", hosted: false });
  }
  const normalizedUserId = canonicalId(userId, "hosted user id");
  const normalizedTenantId = canonicalId(tenantId, "hosted tenant id");
  return Object.freeze({
    tenantId: `tenant:${normalizedTenantId}`,
    principalId: `host-user:${normalizedUserId}`,
    userId: normalizedUserId,
    hosted: true,
  });
}

export function canonicalId(value: unknown, label: string): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!ACCEPTED_ID.test(normalized)) throw new Error(`${label} must be a canonical lowercase identifier`);
  return normalized;
}

/**
 * Validate tenant claims carried by an inbound body. Claims are accepted only
 * when they agree with the trusted scope. They never replace it.
 */
export function assertTenantClaims(value: unknown, scope: GatewayTenantScope, path = "request"): void {
  walkTenantClaims(value, scope, path, new Set<object>());
}

function walkTenantClaims(value: unknown, scope: GatewayTenantScope, path: string, seen: Set<object>): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new Error(`${path} contains a cyclic tenant claim`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkTenantClaims(entry, scope, `${path}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    if (key === "tenantId" || key === "claimedTenant") {
      if (entry !== undefined && entry !== null) assertTenantId(entry, scope, entryPath);
    }
    walkTenantClaims(entry, scope, entryPath, seen);
  }
  seen.delete(value);
}

export function assertTenantId(value: unknown, scope: GatewayTenantScope, path = "tenantId"): void {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  const normalized = value.trim().toLowerCase();
  if (normalized !== scope.tenantId && normalized !== scope.tenantId.slice("tenant:".length)) {
    throw new Error(`${path} does not match the authenticated tenant scope`);
  }
}

export function scopedJobPayload<T extends Record<string, unknown>>(payload: T, scope: GatewayTenantScope): T & {
  scope: { tenantId: string; principalId: string };
} {
  const existing = payload.scope;
  if (existing !== undefined && (!existing || typeof existing !== "object" || Array.isArray(existing))) {
    throw new Error("job scope must be an object");
  }
  const existingTenantId = existing && typeof existing === "object" ? (existing as Record<string, unknown>).tenantId : undefined;
  if (existingTenantId !== undefined) assertTenantId(existingTenantId, scope, "job.scope.tenantId");
  const scoped: T & { scope: { tenantId: string; principalId: string } } = {
    ...payload,
    scope: {
      ...(existing as Record<string, unknown> | undefined),
      tenantId: scope.tenantId,
      principalId: scope.principalId,
    },
  };
  return scoped;
}

/**
 * Add a non-sensitive tenant marker to every durable audit event emitted by a
 * gateway. The underlying store remains the authority and all methods stay
 * bound to it, including integrity verification and subscriptions.
 */
class TenantScopedAuditStoreAdapter {
  private readonly target: Record<string, unknown>;
  private readonly scope: GatewayTenantScope;

  constructor(
    target: Record<string, unknown>,
    scope: GatewayTenantScope,
  ) {
    this.target = target;
    this.scope = scope;
  }

  private call(name: string, args: unknown[] = []): unknown {
    const method = this.target[name];
    if (typeof method !== "function") throw new Error(`audit store does not implement ${name}`);
    return method.apply(this.target, args);
  }

  async append(event: unknown): Promise<unknown> {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("audit event must be an object");
    const record = event as Record<string, unknown>;
    const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? record.data as Record<string, unknown>
      : {};
    const existing = data.tenantId;
    if (existing !== undefined) assertTenantId(existing, this.scope, "audit.data.tenantId");
    return this.call("append", [{ ...record, data: { ...data, tenantId: this.scope.tenantId } }]);
  }

  readPage(options?: unknown): unknown { return this.call("readPage", [options]); }
  readSince(sequence?: unknown, limit?: unknown): unknown { return this.call("readSince", [sequence, limit]); }
  readAll(): unknown { return this.call("readAll"); }
  readRuns(): unknown { return this.call("readRuns"); }
  readRunPage(options?: unknown): unknown { return this.call("readRunPage", [options]); }
  queryRuns(options?: unknown): unknown { return this.call("queryRuns", [options]); }
  readSummary(): unknown { return this.call("readSummary"); }
  readFailurePage(options?: unknown): unknown { return this.call("readFailurePage", [options]); }
  getIntegrityStatus(): unknown { return this.call("getIntegrityStatus"); }
  readRun(id: unknown): unknown { return this.call("readRun", [id]); }
  getCursor(id: unknown): unknown { return this.call("getCursor", [id]); }
  ackCursor(id: unknown, sequence: unknown): unknown { return this.call("ackCursor", [id, sequence]); }
  subscribe(listener: unknown): unknown { return this.call("subscribe", [listener]); }
  verifyIntegrity(options?: unknown): unknown { return this.call("verifyIntegrity", [options]); }
  rotateKey(): unknown { return this.call("rotateKey"); }
  rotateSegment(): unknown { return this.call("rotateSegment"); }
  exportArchive(path: unknown, throughSequence?: unknown): unknown { return this.call("exportArchive", [path, throughSequence]); }
  applyRetention(throughSequence: unknown): unknown { return this.call("applyRetention", [throughSequence]); }
  backup(destination?: unknown): unknown { return this.call("backup", [destination]); }
  close(): unknown { return this.call("close"); }
}

export function createTenantScopedAuditStore<T extends { append(event: unknown): Promise<unknown> }>(store: T, scope: GatewayTenantScope): T {
  return new TenantScopedAuditStoreAdapter(store as unknown as Record<string, unknown>, scope) as unknown as T;
}
