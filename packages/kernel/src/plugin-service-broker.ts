import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { validatePluginManifest } from "@odinn/plugin-sdk";
import { dnsLookupAll, isPrivateAddress, pinnedAddressLookup } from "./web.ts";

const MAX_BODY_BYTES = 128 * 1024;
const MAX_REQUESTS = 8;
const MAX_ACTIVE_REQUESTS = 16;
let activeRequests = 0;

type Service = { id: string; origin: string; paths: readonly string[]; queryKeys: readonly string[]; credential?: string };
type Binding = { enabled?: boolean; credentialRef?: string };
type BrokerExtension = { permissions?: Record<string, unknown>; grants?: readonly string[] };
export type PluginHttpRequest = Readonly<{ url: URL; address: string; headers: Readonly<Record<string, string>>; signal: AbortSignal }>;
export type PluginHttpResponse = Readonly<{ status: number; contentType: string; body: Buffer }>;
export type PluginServiceBroker = ((input: unknown) => Promise<{ status: number; body: unknown }>) & { settle(): Promise<void> };
export type PluginServiceBrokerOptions = {
  extension: BrokerExtension;
  assertAuthority: () => Promise<void>;
  effectiveCapabilities: readonly string[];
  signal?: AbortSignal;
  environment?: Readonly<Record<string, string | undefined>>;
  resolveNetworkAddresses?: (hostname: string) => Promise<string[]>;
  transport?: (request: PluginHttpRequest) => Promise<PluginHttpResponse>;
  timeoutMs?: number;
  onEvent?: (event: { phase: "requested" | "completed"; serviceId: string; requestDigest: string; responseDigest?: string; responseBytes?: number }) => Promise<void>;
};

function refused(): Error {
  return Object.assign(new Error("Plugin service request refused or unavailable"), { code: "PLUGIN_SERVICE_UNAVAILABLE" });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw refused();
  return value as Record<string, unknown>;
}

/** Host-owned, read-only HTTPS broker. The isolated plugin never receives a socket or credential. */
export function createPluginServiceBroker(options: PluginServiceBrokerOptions): PluginServiceBroker | undefined {
  const raw = options.extension.permissions?.plugin;
  if (!raw) return undefined;
  const metadata = record(raw);
  const manifest = validatePluginManifest(metadata.manifest) as ReturnType<typeof validatePluginManifest> & { services: readonly Service[] };
  const bindings = record(metadata.serviceBindings ?? {});
  const grants = new Set(options.extension.grants ?? []);
  const effective = new Set(options.effectiveCapabilities);
  const services = new Map(manifest.services.map((service) => [service.id, service]));
  const environment = options.environment ?? process.env;
  const resolveAddresses = options.resolveNetworkAddresses ?? dnsLookupAll;
  const transport = options.transport ?? nativePluginHttpTransport;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw refused();
  let calls = 0;
  let busy = false;
  const pending = new Set<Promise<unknown>>();

  const invoke = async (input: unknown) => {
    if (busy || ++calls > MAX_REQUESTS || activeRequests >= MAX_ACTIVE_REQUESTS || options.signal?.aborted) throw refused();
    if (!grants.has("network.access") || !effective.has("network.access")) throw refused();
    const request = record(input);
    if (Object.keys(request).some((key) => !["serviceId", "path", "query"].includes(key))) throw refused();
    if (typeof request.serviceId !== "string" || typeof request.path !== "string") throw refused();
    const service = services.get(request.serviceId);
    const binding = bindings[request.serviceId] as Binding | undefined;
    if (!service || !binding || binding.enabled !== true || !service.paths.includes(request.path)) throw refused();
    const url = new URL(request.path, service.origin);
    if (url.origin !== service.origin || url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.pathname !== request.path) throw refused();
    const query = record(request.query ?? {});
    if (Object.keys(query).length > 32) throw refused();
    for (const [key, value] of Object.entries(query)) {
      if (!service.queryKeys.includes(key) || typeof value !== "string" || value.length > 1024 || /[\x00-\x1f\x7f]/u.test(value)) throw refused();
      url.searchParams.set(key, value);
    }
    if (url.href.length > 4096) throw refused();
    let credential: string | undefined;
    if (service.credential) {
      if (!grants.has("secret.reference.use") || !effective.has("secret.reference.use") || typeof binding.credentialRef !== "string" || !/^env:[A-Z][A-Z0-9_]{1,95}$/u.test(binding.credentialRef)) throw refused();
      credential = environment[binding.credentialRef.slice(4)];
      if (!credential || credential.length > 8192 || /[\s\x00-\x1f\x7f]/u.test(credential)) throw refused();
    } else if (binding.credentialRef) throw refused();
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    const headers = Object.freeze({ accept: "application/json", "accept-encoding": "identity", "user-agent": "Odinn-Forge/plugin-service", ...(credential ? { authorization: `Bearer ${credential}` } : {}) });
    busy = true;
    activeRequests += 1;
    const operation = (async () => {
      await options.assertAuthority();
      if (signal.aborted) throw refused();
      const addresses = await resolveAddresses(url.hostname);
      if (signal.aborted || !Array.isArray(addresses) || !addresses.length || addresses.some((address) => typeof address !== "string" || !isIP(address) || isPrivateAddress(address))) throw refused();
      // Recheck after asynchronous DNS, immediately before credential-bearing egress.
      await options.assertAuthority();
      if (signal.aborted) throw refused();
      const requestDigest = createHash("sha256").update(url.href).digest("hex");
      await options.onEvent?.({ phase: "requested", serviceId: service.id, requestDigest });
      await options.assertAuthority();
      if (signal.aborted) throw refused();
      const response = await transport({ url, address: addresses[0]!, headers, signal });
      if (signal.aborted) throw refused();
      await options.assertAuthority();
      if (response.status < 200 || response.status >= 300 || !Buffer.isBuffer(response.body) || response.body.byteLength > MAX_BODY_BYTES || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/iu.test(response.contentType)) throw refused();
      const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
      await options.onEvent?.({ phase: "completed", serviceId: service.id, requestDigest, responseDigest: createHash("sha256").update(response.body).digest("hex"), responseBytes: response.body.byteLength });
      await options.assertAuthority();
      if (signal.aborted) throw refused();
      return { status: response.status, body: sanitizeServiceBody(body, credential) };
    })();
    pending.add(operation);
    // Keep physical ownership until the transport settles even when a caller stops waiting.
    const settled = () => { activeRequests -= 1; busy = false; pending.delete(operation); };
    void operation.then(settled, settled);
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        abort = () => reject(refused());
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      })]);
    } catch {
      throw refused();
    } finally {
      clearTimeout(deadline);
      if (abort) signal.removeEventListener("abort", abort);
    }
  };
  return Object.assign(invoke, { settle: async () => { await Promise.allSettled([...pending]); } });
}

function sanitizeServiceBody(value: unknown, credential?: string): unknown {
  let count = 0;
  const text = (input: string) => credential ? input.replaceAll(credential, "[redacted]") : input;
  const visit = (input: unknown, depth: number): unknown => {
    if (++count > 8192 || depth > 32) throw refused();
    if (typeof input === "string") return text(input);
    if (input === null || typeof input === "boolean" || typeof input === "number") return input;
    if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));
    const object = record(input);
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [text(key), visit(item, depth + 1)]));
  };
  return visit(value, 0);
}

async function nativePluginHttpTransport(input: PluginHttpRequest): Promise<PluginHttpResponse> {
  return new Promise((resolveResponse, rejectResponse) => {
    if (input.signal.aborted) return rejectResponse(refused());
    let settled = false;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const finish = (error?: Error, response?: PluginHttpResponse) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", abort);
      if (error) rejectResponse(error); else resolveResponse(response!);
    };
    const request = httpsRequest(input.url, {
      method: "GET", headers: input.headers, lookup: pinnedAddressLookup(input.address), rejectUnauthorized: true, agent: false
    }, (response) => {
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_BODY_BYTES) { response.destroy(); request.destroy(); finish(refused()); return; }
        chunks.push(chunk);
      });
      response.on("end", () => finish(undefined, { status: response.statusCode ?? 0, contentType: response.headers["content-type"] ?? "", body: Buffer.concat(chunks) }));
      response.on("error", () => finish(refused()));
    });
    const abort = () => request.destroy();
    input.signal.addEventListener("abort", abort, { once: true });
    request.on("error", () => finish(refused()));
    request.on("close", () => { if (!settled) finish(refused()); });
    if (input.signal.aborted) abort(); else request.end();
  });
}
