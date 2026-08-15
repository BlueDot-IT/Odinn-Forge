import {
  normalizeSessionListLimit,
  validateOperatorSnapshotResponseV1,
  type OperatorSurfaceV1,
} from "@odinn/application";
import { gatewayOperatorSnapshotFailure } from "../http/errors.ts";
import {
  createGatewayDiagnosticsReadRequest,
  createGatewayOperatorSnapshotReadRequest,
  createGatewaySessionListRequest,
  createGatewayStatusReadRequest,
} from "../http/request-context.ts";
import { writeJsonResponse } from "../http/responses.ts";
import { AuthenticatedRouter, type AuthenticatedRouteContext } from "../http/router.ts";

type ReadUseCase = Readonly<{
  execute(request: any, options?: { signal?: AbortSignal }): Promise<{ output: any }>;
}>;

export type ApplicationReadRouteDependencies = Readonly<{
  statusRead: ReadUseCase;
  diagnosticsRead: ReadUseCase;
  sessionList: ReadUseCase;
  operatorSnapshotRead: ReadUseCase;
}>;

const GATEWAY_OPERATOR_SURFACES = new Set<OperatorSurfaceV1>(["cli", "tui", "http", "console"]);
const OPERATOR_PAGE_NAMES = ["runtime", "work", "approvals", "automation", "context", "recovery", "audit", "surfaces"] as const;

export function registerApplicationReadRoutes(
  router: AuthenticatedRouter,
  dependencies: ApplicationReadRouteDependencies,
): AuthenticatedRouter {
  router.register("GET", "/status", async (context) => {
    const result = await dependencies.statusRead.execute(createGatewayStatusReadRequest(identity(context)), { signal: context.signal });
    writeJsonResponse(context.response, 200, result.output);
  });
  router.register("GET", "/diagnostics", async (context) => {
    const result = await dependencies.diagnosticsRead.execute(createGatewayDiagnosticsReadRequest(identity(context)), { signal: context.signal });
    writeJsonResponse(context.response, 200, result.output);
  });
  const operatorHandler = async (context: AuthenticatedRouteContext) => {
    const input = operatorInput(context.url);
    try {
      const result = await dependencies.operatorSnapshotRead.execute(createGatewayOperatorSnapshotReadRequest({
        ...identity(context),
        sourcePath: context.url.pathname === "/operator" ? "/operator" : "/operator/snapshot",
        input,
      }), { signal: context.signal });
      writeJsonResponse(context.response, 200, validateOperatorSnapshotResponseV1({ ok: true, ...result.output }));
    } catch (error) {
      const failure = gatewayOperatorSnapshotFailure(error, context.requestId);
      if (!failure) throw error;
      context.response.setHeader("retry-after", failure.retryAfter);
      writeJsonResponse(context.response, failure.status, failure.body);
    }
  };
  router.register("GET", "/operator", operatorHandler);
  router.register("GET", "/operator/snapshot", operatorHandler);
  router.register("GET", "/sessions", async (context) => {
    const limit = Number.parseInt(context.url.searchParams.get("limit") ?? "100", 10);
    const projectId = context.url.searchParams.get("projectId") ?? "";
    const result = await dependencies.sessionList.execute(createGatewaySessionListRequest({
      ...identity(context),
      limit: normalizeSessionListLimit(limit),
      projectId,
    }), { signal: context.signal });
    writeJsonResponse(context.response, 200, result.output);
  });
  return router;
}

function identity(context: AuthenticatedRouteContext) {
  return {
    applicationRequestId: context.applicationRequestId,
    hostedUserId: context.hostedUserId,
    hostedTenantId: context.hostedTenantId,
    authentication: context.authentication,
  };
}

function operatorInput(url: URL) {
  const requestedSurface = String(url.searchParams.get("surface") || "http");
  const surface = GATEWAY_OPERATOR_SURFACES.has(requestedSurface as OperatorSurfaceV1)
    ? requestedSurface as OperatorSurfaceV1
    : "http";
  const numericParameter = (name: string) => {
    if (!url.searchParams.has(name)) return undefined;
    const value = Number(url.searchParams.get(name));
    return Number.isFinite(value) ? value : undefined;
  };
  const pages = Object.fromEntries(OPERATOR_PAGE_NAMES
    .map((name) => [name, numericParameter(`${name}Page`)] as const)
    .filter((entry): entry is readonly [typeof OPERATOR_PAGE_NAMES[number], number] => entry[1] !== undefined));
  const page = numericParameter("page");
  const pageSize = numericParameter("pageSize");
  return {
    surface,
    ...(page === undefined ? {} : { page }),
    ...(pageSize === undefined ? {} : { pageSize }),
    ...(url.searchParams.has("q") ? { query: url.searchParams.get("q") ?? "" } : {}),
    ...(url.searchParams.has("status") ? { status: url.searchParams.get("status") ?? "" } : {}),
    ...(Object.keys(pages).length ? { pages } : {}),
  };
}
