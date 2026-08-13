import type {
  ApplicationPrincipalV1,
  ApplicationScopeV1,
  ExecutionContextV1
} from "../contracts.ts";
import {
  enumValue,
  exactObject,
  identifier,
  reference,
  timestamp
} from "./json-safety.ts";

export function executionContext(input: unknown): ExecutionContextV1 {
  const value = exactObject(input, "context", [
    "principal", "scope", "sourceReference", "correlationId", "causationId", "deadlineAt", "cancellationControlReference"
  ]);
  const context: ExecutionContextV1 = {
    principal: principal(value.principal),
    scope: scope(value.scope),
    sourceReference: reference(value.sourceReference, "context.sourceReference"),
    correlationId: identifier(value.correlationId, "context.correlationId"),
    ...(value.causationId === undefined ? {} : { causationId: identifier(value.causationId, "context.causationId") }),
    ...(value.deadlineAt === undefined ? {} : { deadlineAt: timestamp(value.deadlineAt, "context.deadlineAt") }),
    cancellationControlReference: reference(value.cancellationControlReference, "context.cancellationControlReference")
  };
  return context;
}

export function principal(input: unknown): ApplicationPrincipalV1 {
  const value = exactObject(input, "principal", ["principalId", "actorId", "kind", "authenticationReference", "delegatedByPrincipalId"]);
  return {
    principalId: identifier(value.principalId, "principal.principalId"),
    actorId: identifier(value.actorId, "principal.actorId"),
    kind: enumValue(value.kind, "principal.kind", ["operator", "host-user", "channel-user", "automation", "agent", "system"]),
    ...(value.authenticationReference === undefined ? {} : { authenticationReference: reference(value.authenticationReference, "principal.authenticationReference") }),
    ...(value.delegatedByPrincipalId === undefined ? {} : { delegatedByPrincipalId: identifier(value.delegatedByPrincipalId, "principal.delegatedByPrincipalId") })
  };
}

export function scope(input: unknown): ApplicationScopeV1 {
  const value = exactObject(input, "scope", ["tenantId", "projectId", "sessionId", "conversationId"]);
  return {
    tenantId: identifier(value.tenantId, "scope.tenantId"),
    ...(value.projectId === undefined ? {} : { projectId: identifier(value.projectId, "scope.projectId") }),
    ...(value.sessionId === undefined ? {} : { sessionId: identifier(value.sessionId, "scope.sessionId") }),
    ...(value.conversationId === undefined ? {} : { conversationId: identifier(value.conversationId, "scope.conversationId") })
  };
}
