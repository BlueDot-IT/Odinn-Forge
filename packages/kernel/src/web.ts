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

export async function searchWeb(input: any = {}, security: any = {}, resolveNetworkAddresses: any = dnsLookupAll) {
  const query = cleanRequired(input.query, "web.search requires query");
  const limit = Math.min(normalizeLimit(input.limit, 5), 10);
  const endpoint = process.env.ODINN_SEARCH_ENDPOINT || "https://html.duckduckgo.com/html/";
  const separator = endpoint.includes("?") ? "&" : "?";
  const url = assertPublicWebUrl(`${endpoint}${separator}q=${encodeURIComponent(query)}`, security);
  const response: any = await fetchPublicUrl(url, security, resolveNetworkAddresses);
  if (response.status < 200 || response.status >= 300) throw new Error(`web search returned ${response.status}`);
  const html = response.body.toString("utf8");
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

function normalizedAddress(value: unknown) {
  let address = String(value || "").trim().toLowerCase();
  if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
  address = address.replace(/%[^%]+$/, "");
  if (isIP(address)) return address;
  try {
    const hostname = new URL(`http://${address}/`).hostname.toLowerCase();
    const normalized = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    return isIP(normalized) ? normalized : address;
  } catch {
    return address;
  }
}

function ipv4Number(address: string) {
  const parts = address.split(".").map(Number);
  return parts.length === 4
    ? (((parts[0]! * 0x1000000) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0)
    : null;
}

function inIpv4Cidr(address: number, base: number, bits: number) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (base & mask);
}

const NON_PUBLIC_IPV4_CIDRS = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const;

function ipv6Bytes(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string) => {
    if (!half) return [] as number[];
    const words: number[] = [];
    for (const part of half.split(":")) {
      if (part.includes(".")) {
        const normalized = normalizedAddress(part);
        if (isIP(normalized) !== 4) return null;
        const bytes = normalized.split(".").map(Number);
        words.push((bytes[0]! << 8) | bytes[1]!, (bytes[2]! << 8) | bytes[3]!);
      } else {
        if (!/^[a-f0-9]{1,4}$/.test(part)) return null;
        words.push(Number.parseInt(part, 16));
      }
    }
    return words;
  };
  const left = parseHalf(halves[0]!);
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array(missing).fill(0), ...right];
  if (words.length !== 8) return null;
  return words.flatMap((word) => [word >>> 8, word & 0xff]);
}

function ipv6Prefix(bytes: number[], prefix: number[], bits: number) {
  const fullBytes = Math.floor(bits / 8);
  const remainder = bits % 8;
  for (let index = 0; index < fullBytes; index += 1) if (bytes[index] !== prefix[index]) return false;
  if (!remainder) return true;
  const mask = 0xff << (8 - remainder);
  return (bytes[fullBytes]! & mask) === (prefix[fullBytes]! & mask);
}

export function isPrivateAddress(value: any) {
  const address = normalizedAddress(value);
  if (address === "localhost" || address.endsWith(".localhost") || address.endsWith(".local") || address === "metadata.google.internal") return true;
  if (isIP(address) === 4) {
    const numeric = ipv4Number(address)!;
    return NON_PUBLIC_IPV4_CIDRS.some(([base, bits]) => inIpv4Cidr(numeric, ipv4Number(base)!, bits));
  }
  if (isIP(address) === 6) {
    const bytes = ipv6Bytes(address);
    if (!bytes) return true;
    const embeddedIpv4 = (offset: number) => {
      const numeric = ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
      return NON_PUBLIC_IPV4_CIDRS.some(([base, bits]) => inIpv4Cidr(numeric, ipv4Number(base)!, bits));
    };
    const prefix = (literal: string, bits: number) => ipv6Prefix(bytes, ipv6Bytes(literal)!, bits);
    // IPv4-compatible, mapped, NAT64, and 6to4 forms can otherwise disguise
    // an internal IPv4 destination. Treat the translation-only prefixes as
    // non-public, and inspect the embedded address where that is meaningful.
    if (prefix("::", 96)) return true;
    if (prefix("::ffff:0:0", 96)) return embeddedIpv4(12);
    if (prefix("64:ff9b::", 96)) return embeddedIpv4(12);
    if (prefix("64:ff9b:1::", 48) || prefix("100::", 64) || prefix("2001::", 23)) return true;
    if (prefix("2002::", 16)) return true;
    // Public unicast is currently allocated from 2000::/3. Explicitly reject
    // special-use blocks within it and every non-global address outside it.
    if (!prefix("2000::", 3)) return true;
    return prefix("2001:db8::", 32)
      || prefix("3fff::", 20)
      || prefix("5f00::", 16);
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
