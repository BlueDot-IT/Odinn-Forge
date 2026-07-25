import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export const WEB_TIMEOUT_MS = 20_000;
const WEB_MAX_BYTES = 2_000_000;
const WEB_MAX_CONCURRENT_REQUESTS = 8;
let activeWebRequests = 0;
const webRequestWaiters: Array<() => void> = [];

export async function withWebRequestSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeWebRequests >= WEB_MAX_CONCURRENT_REQUESTS) await new Promise<void>((resolveSlot) => webRequestWaiters.push(resolveSlot));
  activeWebRequests += 1;
  try { return await operation(); }
  finally {
    activeWebRequests -= 1;
    webRequestWaiters.shift()?.();
  }
}

export async function searchWeb(input: any = {}) {
  const query = cleanRequired(input.query, "web.search requires query");
  const limit = Math.min(normalizeLimit(input.limit, 5), 10);
  const endpoint = process.env.ODINN_SEARCH_ENDPOINT || "https://html.duckduckgo.com/html/";
  const response = await fetch(`${endpoint}?q=${encodeURIComponent(query)}`, {
      headers: { "user-agent": "Odinn-Forge/0.1 web-search" },
    signal: AbortSignal.timeout(WEB_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`web search returned ${response.status}`);
  const html = (await readBoundedFetchBody(response, WEB_MAX_BYTES, "web search")).toString("utf8");
  const results = [];
  const pattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    results.push({
      title: decodeHtml(match[2]),
      url: normalizeSearchUrl(decodeHtml(match[1])),
      snippet: decodeHtml(match[3])
    });
    if (results.length >= limit) break;
  }
  return { query, results, source: "duckduckgo", fetchedAt: new Date().toISOString() };
}

function normalizeSearchUrl(value: any) {
  const raw = String(value || "").startsWith("//") ? `https:${value}` : String(value || "");
  try {
    const parsed = new URL(raw);
    return parsed.hostname === "duckduckgo.com" && parsed.searchParams.get("uddg")
      ? decodeURIComponent(parsed.searchParams.get("uddg")!)
      : parsed.href;
  } catch {
    return raw;
  }
}

export async function fetchWebPage(input: any = {}, security: any = {}, resolveNetworkAddresses: any = dnsLookupAll) {
  const url = assertPublicWebUrl(input.url, security);
  const response: any = await fetchPublicUrl(url, security, resolveNetworkAddresses);
  const bytes = response.body;
  if (bytes.byteLength > WEB_MAX_BYTES) throw new Error(`web page exceeds ${WEB_MAX_BYTES} bytes`);
  const raw = bytes.toString("utf8");
  const contentType = response.headers["content-type"] || "";
  const title = contentType.includes("html") ? decodeHtml(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "") : "";
  const content = contentType.includes("html") ? htmlToText(raw) : raw;
  return {
    url: assertPublicWebUrl(response.url, security),
    status: response.status,
    title,
    content: content.slice(0, input.maxChars ? normalizeLimit(input.maxChars, 30_000) : 30_000),
    truncated: content.length > 30_000,
    contentType
  };
}

async function fetchPublicUrl(url: any, security: any, resolveNetworkAddresses: any = dnsLookupAll) {
  let current = url;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response: any = await requestValidatedUrl(current, security, resolveNetworkAddresses);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.location;
    if (!location) return response;
    current = assertPublicWebUrl(new URL(location, current).href, security);
  }
  throw new Error("web.fetch exceeded the redirect limit");
}

export function assertPublicWebUrl(value: any, security: any = {}) {
  let parsed;
  try { parsed = new URL(cleanRequired(value, "web.fetch requires url")); } catch { throw new Error("web.fetch requires a valid http(s) url"); }
  const host = parsed.hostname.toLowerCase();
  const privateHost = isPrivateAddress(host);
  if (!/^https?:$/.test(parsed.protocol) || (privateHost && security.allowPrivateNetwork !== true)) {
    throw new Error("web.fetch only allows public http(s) URLs");
  }
  assertDomainAllowed(host, security);
  return parsed.href;
}

async function requestValidatedUrl(value: any, security: any = {}, resolveNetworkAddresses: any = dnsLookupAll) {
  const parsed = new URL(assertPublicWebUrl(value, security));
  const transport = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  const addresses = await resolveNetworkAddresses(parsed.hostname);
  if (security.allowPrivateNetwork !== true && addresses.some(isPrivateAddress)) {
    throw new Error("web.fetch resolved to a private or link-local network address");
  }
  const address = addresses[0];
  return new Promise((resolveResponse: any, rejectResponse: any) => {
    let settled = false;
    const finish = (error?: Error, value?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) rejectResponse(error);
      else resolveResponse(value);
    };
    const request = transport(parsed, {
      headers: { "user-agent": "Odinn-Forge/0.1 web-fetch" },
      lookup: pinnedAddressLookup(address)
    }, (response: any) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: any) => {
        bytes += chunk.length;
        if (bytes > WEB_MAX_BYTES) {
          const error = new Error(`web page exceeds ${WEB_MAX_BYTES} bytes`);
          response.destroy(error);
          request.destroy(error);
          finish(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(undefined, {
        status: response.statusCode ?? 0,
        headers: response.headers,
        url: parsed.href,
        body: Buffer.concat(chunks)
      }));
      response.on("error", (error: Error) => finish(error));
    });
    const deadline = setTimeout(() => request.destroy(new Error("web.fetch request timed out")), WEB_TIMEOUT_MS);
    request.on("error", (error: Error) => finish(error));
    request.end();
  });
}

async function readBoundedFetchBody(response: any, maxBytes: number, label: string) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel(`${label} response exceeded ${maxBytes} bytes`).catch(() => undefined);
        throw new Error(`${label} response exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

export async function dnsLookupAll(hostnameValue: any) {
  if (isIP(hostnameValue)) return [hostnameValue];
  try {
    const results = await dnsLookup(hostnameValue, { all: true, verbatim: true });
    if (!results.length) throw new Error("hostname did not resolve");
    return results.map((result: any) => result.address);
  } catch (error) {
    throw new Error(`web.fetch DNS validation failed for ${hostnameValue}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function isPrivateAddress(value: any) {
  const address = String(value || "").toLowerCase().replace(/^::ffff:/, "");
  if (address === "localhost" || address.endsWith(".localhost") || address.endsWith(".local") || address === "metadata.google.internal") return true;
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return a === 0
      || a === 10
      || a === 100 && b >= 64 && b <= 127
      || a === 127
      || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31
      || a === 192 && b === 0 && (c === 0 || c === 2)
      || a === 192 && b === 88 && c === 99
      || a === 192 && b === 168
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
      || a === 203 && b === 0 && c === 113
      || a >= 224;
  }
  if (isIP(address) === 6) {
    return address === "::"
      || address === "::1"
      || address.startsWith("fc")
      || address.startsWith("fd")
      || address.startsWith("fe8")
      || address.startsWith("fe9")
      || address.startsWith("fea")
      || address.startsWith("feb")
      || address.startsWith("ff")
      || address.startsWith("100:")
      || address.startsWith("2001:2:")
      || address.startsWith("2001:db8:");
  }
  return false;
}

export async function validateBrowserNetworkUrl(value: any, security: any = {}, resolveNetworkAddresses: any = dnsLookupAll) {
  let parsed;
  try { parsed = new URL(String(value)); } catch { throw new Error("browser blocked an invalid network URL"); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error("browser only allows credential-free http(s) URLs");
  assertDomainAllowed(parsed.hostname, security);
  const addresses = await resolveNetworkAddresses(parsed.hostname);
  if (security.allowPrivateNetwork !== true && addresses.some(isPrivateAddress)) {
    throw new Error(`browser blocked non-public DNS answer for ${parsed.hostname}`);
  }
  return { parsed, address: addresses[0] };
}

export function browserSecurityFingerprint(security: any = {}) {
  return JSON.stringify({
    allowPrivateNetwork: security.allowPrivateNetwork === true,
    allowedDomains: [...(security.allowedDomains ?? [])].map(String).sort(),
    blockedDomains: [...(security.blockedDomains ?? [])].map(String).sort()
  });
}

export function assertDomainAllowed(host: any, security: any = {}) {
  const normalized = String(host || "").toLowerCase();
  const blocked = (security.blockedDomains || []).some((domain: any) => domainMatches(normalized, domain));
  if (blocked) throw new Error(`security policy blocked domain: ${normalized}`);
  const allowed = (security.allowedDomains || []).map((domain: any) => String(domain).toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.some((domain: any) => domainMatches(normalized, domain))) {
    throw new Error(`security policy does not allow domain: ${normalized}`);
  }
}

function domainMatches(host: any, domain: any) {
  const normalized = String(domain || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  return Boolean(normalized) && (host === normalized || host.endsWith(`.${normalized}`));
}

function htmlToText(html: any) {
  return decodeHtml(html
    .replace(/<script\b[^>]*>[\s\S]*?<\s*\/\s*script\b[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\s*\/\s*style\b[^>]*>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\s*\/\s*noscript\b[^>]*>/gi, " ")
    .replace(/<br\s*\/?>(?=.)/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|main|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function decodeHtml(value: any) {
  const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (entity: any) => entities[entity] ?? entity)
    .replace(/\s+/g, " ")
    .trim();
}

export function pinnedAddressLookup(address: string) {
  const family = isIP(address);
  return (_hostname: any, options: any, callback: any) => {
    if (options?.all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function cleanRequired(value: unknown, message: string) {
  const cleaned = String(value ?? "").trim();
  if (!cleaned) throw new Error(message);
  return cleaned;
}

function normalizeLimit(value: unknown, fallback: number) {
  const limit = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(limit) ? Math.max(1, Math.min(limit, 500)) : fallback;
}
