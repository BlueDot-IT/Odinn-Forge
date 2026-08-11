import { timingSafeEqual } from "node:crypto";

export type GatewayAuthenticationMode = "bearer" | "cookie" | "disabled";

export function authenticationMode(request: any, expectedToken: string): Exclude<GatewayAuthenticationMode, "disabled"> | undefined {
  const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "";
  const cookie = String(request.headers.cookie ?? "").split(";").map((item) => item.trim()).find((item) => item.startsWith("odinn_gateway_token="))?.slice("odinn_gateway_token=".length) ?? "";
  let decodedCookie = "";
  try { decodedCookie = decodeURIComponent(cookie); } catch { return undefined; }
  for (const [mode, presented] of [["bearer", bearer], ["cookie", decodedCookie]] as const) {
    if (!presented || presented.length !== expectedToken.length) continue;
    if (timingSafeEqual(Buffer.from(presented), Buffer.from(expectedToken))) return mode;
  }
  return undefined;
}

export function authorizedRequest(request: any, expectedToken: string): boolean {
  return authenticationMode(request, expectedToken) !== undefined;
}

export function isMutatingMethod(method: unknown): boolean {
  return ["POST", "PATCH", "PUT", "DELETE"].includes(String(method));
}

export function validMutationOrigin(request: any, authentication: GatewayAuthenticationMode | undefined): boolean {
  if (authentication === "disabled") return true;
  if (!authentication) return false;
  const origin = request.headers.origin;
  if (authentication === "bearer" && !origin) return true;
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const expected = `http://${String(request.headers.host ?? "").trim().toLowerCase()}`;
    if (parsed.origin.toLowerCase() !== expected || !validLoopbackHost(parsed.host)) return false;
    const fetchSite = String(request.headers["sec-fetch-site"] ?? "").toLowerCase();
    return !fetchSite || fetchSite === "same-origin" || authentication === "bearer";
  } catch { return false; }
}

export function validHostHeader(request: any): boolean {
  const host = request.headers.host;
  return typeof host === "string" && validLoopbackHost(host);
}

export function permitsGatewayTokenBootstrap(request: any, server: any): boolean {
  const address = server.address?.();
  if (!address || typeof address === "string" || !validLoopbackAddress(address.address)) return false;
  return validLoopbackAddress(request.socket?.localAddress);
}

export function validLoopbackAddress(value: unknown): boolean {
  const address = String(value || "").trim().toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function validLoopbackHost(value: unknown): boolean {
  const host = String(value || "").trim().toLowerCase();
  if (host === "::1") return true;
  const match = host.match(/^([^:]+)(?::\d{1,5})?$/) || host.match(/^(\[[0-9a-f:]+\])(?::\d{1,5})?$/);
  if (!match) return false;
  return new Set(["localhost", "127.0.0.1", "[::1]"]).has(match[1]);
}

export function assertGatewayBinding(host: unknown, options: { allowRemote: boolean; authenticationDisabled: boolean }): void {
  if (validLoopbackHost(host)) return;
  if (!options.allowRemote) throw new Error(`refusing non-loopback gateway host ${String(host)}; set ODINN_ALLOW_REMOTE=1 to override`);
  if (options.authenticationDisabled) throw new Error("refusing to disable gateway authentication on a non-loopback bind");
}
