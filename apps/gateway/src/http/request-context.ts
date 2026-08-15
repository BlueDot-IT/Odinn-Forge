import { APPLICATION_CONTRACT_VERSION, type OperatorSnapshotReadInputV1 } from "@odinn/application";

export type GatewayReadRequestIdentity = Readonly<{
  applicationRequestId: string;
  hostedUserId?: string;
  hostedTenantId?: string;
  authentication: string;
}>;

export function normalizeHostedUserId(value: unknown): string {
  const normalized = String(value ?? "");
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/u.test(normalized)) {
    throw new Error("hosted gateway requires a canonical host user identity");
  }
  return normalized;
}

function executionContext(
  identity: GatewayReadRequestIdentity,
  sourceReference: string,
) {
  const hostedUserId = identity.hostedUserId ? normalizeHostedUserId(identity.hostedUserId) : undefined;
  const hostedTenantId = identity.hostedTenantId ? normalizeHostedUserId(identity.hostedTenantId) : hostedUserId;
  return {
    principal: {
      principalId: hostedUserId ? `host-user:${hostedUserId}` : "local-gateway-user",
      actorId: "gateway",
      kind: "host-user" as const,
      authenticationReference: identity.authentication === "disabled"
        ? "gateway:auth-disabled"
        : `gateway:${identity.authentication}`,
    },
    scope: { tenantId: hostedTenantId ? `tenant:${hostedTenantId}` : "local" },
    sourceReference,
    correlationId: identity.applicationRequestId,
    cancellationControlReference: `http:request:${identity.applicationRequestId}`,
  };
}

export function createGatewayStatusReadRequest(identity: GatewayReadRequestIdentity) {
  return {
    version: APPLICATION_CONTRACT_VERSION,
    kind: "status-read-request" as const,
    requestId: identity.applicationRequestId,
    context: executionContext(identity, "http:GET:/status"),
    operation: { kind: "query" as const, id: "status.read" as const },
  };
}

export function createGatewayDiagnosticsReadRequest(identity: GatewayReadRequestIdentity) {
  return {
    version: APPLICATION_CONTRACT_VERSION,
    kind: "diagnostics-read-request" as const,
    requestId: identity.applicationRequestId,
    context: executionContext(identity, "http:GET:/diagnostics"),
    operation: { kind: "query" as const, id: "diagnostics.read" as const },
  };
}

export function createGatewayOperatorSnapshotReadRequest({
  sourcePath,
  input,
  ...identity
}: GatewayReadRequestIdentity & {
  sourcePath: "/operator" | "/operator/snapshot" | "/operator/actions";
  input: OperatorSnapshotReadInputV1;
}) {
  return {
    version: APPLICATION_CONTRACT_VERSION,
    kind: "operator-snapshot-read-request" as const,
    requestId: identity.applicationRequestId,
    context: executionContext(
      identity,
      `http:${sourcePath === "/operator/actions" ? "POST" : "GET"}:${sourcePath}`,
    ),
    operation: { kind: "query" as const, id: "operator.snapshot.read" as const },
    input,
  };
}

export function createGatewaySessionListRequest({
  limit,
  projectId,
  ...identity
}: GatewayReadRequestIdentity & { limit: number; projectId?: string }) {
  return {
    version: APPLICATION_CONTRACT_VERSION,
    kind: "session-list-request" as const,
    requestId: identity.applicationRequestId,
    context: executionContext(identity, "http:GET:/sessions"),
    operation: { kind: "query" as const, id: "session.list" as const },
    input: { limit, ...(projectId ? { projectId } : {}) },
  };
}
