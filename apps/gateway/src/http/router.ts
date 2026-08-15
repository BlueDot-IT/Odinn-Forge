export type AuthenticatedRouteContext = Readonly<{
  request: any;
  response: any;
  url: URL;
  requestId: string;
  applicationRequestId: string;
  authentication: string;
  hostedUserId?: string;
  hostedTenantId?: string;
  signal: AbortSignal;
}>;

export type AuthenticatedRouteHandler = (context: AuthenticatedRouteContext) => void | Promise<void>;

type RouteDefinition = Readonly<{
  method: string;
  path: string;
  handler: AuthenticatedRouteHandler;
}>;

export class AuthenticatedRouter {
  readonly #routes = new Map<string, RouteDefinition>();

  register(method: string, path: string, handler: AuthenticatedRouteHandler): this {
    const normalizedMethod = method.trim().toUpperCase();
    if (!normalizedMethod || !path.startsWith("/") || typeof handler !== "function") {
      throw new Error("authenticated route requires a method, absolute path, and handler");
    }
    const key = routeKey(normalizedMethod, path);
    if (this.#routes.has(key)) throw new Error(`duplicate authenticated route ${normalizedMethod} ${path}`);
    this.#routes.set(key, Object.freeze({ method: normalizedMethod, path, handler }));
    return this;
  }

  async dispatch(context: AuthenticatedRouteContext): Promise<boolean> {
    const route = this.#routes.get(routeKey(context.request.method, context.url.pathname));
    if (!route) return false;
    await route.handler(context);
    return true;
  }

  definitions(): readonly Readonly<{ method: string; path: string }>[] {
    return Object.freeze(Array.from(this.#routes.values(), ({ method, path }) => Object.freeze({ method, path })));
  }
}

function routeKey(method: unknown, path: string): string {
  return `${String(method ?? "").trim().toUpperCase()} ${path}`;
}
