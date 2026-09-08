/** Public host-neutral v1 connector contract. Metadata never grants authority. */
export const PLUGIN_SDK_VERSION = "1.0" as const;
export const DEFAULT_PLUGIN_IMAGE = "node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b";
export type PluginKind = "connector";
export type PluginRuntime = "oci-mcp-stdio";
export type ConnectorTransport = "mcp-jsonrpc-stdio";
export type PluginCapability = "mcp.discover" | "mcp.invoke" | "network.access" | "secret.reference.use";
export type SecretReference = Readonly<{ name: string; purpose: string }>;
export type EgressDeclaration = Readonly<{ protocol: "https"; hosts: readonly string[]; port: 443 }>;
export type PluginService = Readonly<{ id: string; origin: string; paths: readonly string[]; queryKeys: readonly string[]; credential?: string }>;
export type PluginServiceBinding = Readonly<{ enabled: boolean; credentialRef?: `env:${string}` }>;
export type PluginServiceBindings = Readonly<Record<string, PluginServiceBinding>>;
export type PluginTool = Readonly<{ name: string; description: string; capabilities: readonly PluginCapability[]; inputSchema: Readonly<Record<string, unknown>>; effects: readonly ("read" | "network" | "credential")[]; requiresApproval: boolean; retrySafe: boolean }>;
export type PluginManifest = Readonly<{ schemaVersion: 1; sdkVersion: typeof PLUGIN_SDK_VERSION; id: string; version: string; name: string; description: string; kind: PluginKind; runtime: PluginRuntime; transport: ConnectorTransport; tools: readonly PluginTool[]; egress: EgressDeclaration; secrets: readonly SecretReference[]; services: readonly PluginService[]; containerImage: string; entrypoint: string }>;

const PROTECTED = new Set(["__proto__", "constructor", "prototype"]);
const CAPABILITIES = new Set(["mcp.discover", "mcp.invoke", "network.access", "secret.reference.use"]);
// Kept in parity with the v1 host identifier privacy contract.
const SENSITIVE_IDENTITY_ATOMS = new Set([
  "auth", "authentication", "authorization", "bearer", "cookie", "cookies",
  "credential", "credentials", "endpoint", "endpoints", "header", "headers",
  "host", "key", "oauth", "password", "passwd", "path", "secret", "secrets",
  "session", "token", "tokens", "uri", "url", "username", "approval",
  "capability", "grant", "permission", "policy", "refresh", "jwt", "api"
]);
const CREDENTIAL_AUTHORITY_SUBJECTS = Object.freeze([
  "auth", "authentication", "authorization", "oauth", "client", "bearer",
  "password", "passwd", "username", "cookie", "cookies", "credential",
  "credentials", "api", "token", "tokens", "session", "refresh", "jwt",
  "grant", "approval", "policy", "secret", "secrets", "key", "access",
  "private", "account", "service", "callback", "endpoint", "webhook", "base",
  "internal", "remote", "server", "capability", "permission"
] as const);
const CREDENTIAL_AUTHORITY_MATERIALS = Object.freeze([
  "id", "value", "token", "tokens", "key", "keys", "header", "headers",
  "secret", "secrets", "password", "passwd", "credential", "credentials",
  "digest", "hash", "grant", "session", "ref", "reference", "approved",
  "handle", "cookie", "cookies", "url", "uri", "endpoint", "host", "approval",
  "capability", "permission", "policy"
] as const);
const CREDENTIAL_AUTHORITY_PARTS = Object.freeze([
  ...new Set([...CREDENTIAL_AUTHORITY_SUBJECTS, ...CREDENTIAL_AUTHORITY_MATERIALS])
]);
const CREDENTIAL_AUTHORITY_SUBJECT_SET = new Set<string>(CREDENTIAL_AUTHORITY_SUBJECTS);
const CREDENTIAL_AUTHORITY_MATERIAL_SET = new Set<string>(CREDENTIAL_AUTHORITY_MATERIALS);
function identityTokens(value: string): string[] {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

function normalizedAlphanumeric(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/gu, "").toLowerCase();
}

function isCredentialAuthorityComposition(value: string): boolean {
  const visit = (offset: number, depth: number, materialSeen: boolean): boolean => {
    if (offset === value.length) return depth >= 2 && materialSeen;
    if (depth >= 3) return false;
    const candidates = depth === 0 ? CREDENTIAL_AUTHORITY_SUBJECTS : CREDENTIAL_AUTHORITY_PARTS;
    for (const part of candidates) {
      if (
        value.startsWith(part, offset)
        && visit(
          offset + part.length,
          depth + 1,
          materialSeen || (
            depth > 0
            && (CREDENTIAL_AUTHORITY_MATERIAL_SET.has(part) || CREDENTIAL_AUTHORITY_SUBJECT_SET.has(part))
          )
        )
      ) {
        return true;
      }
    }
    return false;
  };
  return visit(0, 0, false);
}

function hasProtectedIdentity(value: string): boolean {
  const normalized = normalizedAlphanumeric(value);
  return identityTokens(value).some((token) => SENSITIVE_IDENTITY_ATOMS.has(token))
    || SENSITIVE_IDENTITY_ATOMS.has(normalized)
    || isCredentialAuthorityComposition(normalized);
}

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/u;
function fail(message: string): never { throw new Error(`invalid plugin manifest: ${message}`); }
function plain(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be an ordinary object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) fail(`${label} has unsupported fields`);
}
function bounded(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.length || value.length > max || /[\0-\x1f\x7f]/u.test(value)) fail(`${label} is not bounded`);
  return value;
}
function strings(value: unknown, label: string, max: number, valid: (value: string) => boolean): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || !valid(item)) || new Set(value).size !== value.length) fail(`${label} must be a bounded unique array`);
  return value as string[];
}
export function validatePluginId(value: unknown): string {
  const id = bounded(value, "id", 64);
  if (id.length < 2 || !ID.test(id) || PROTECTED.has(id) || hasProtectedIdentity(id)) fail("id must be lowercase kebab-case");
  return id;
}
export function validatePluginVersion(value: unknown): string {
  const version = bounded(value, "version", 64);
  if (!VERSION.test(version)) fail("version must be semantic without build metadata");
  return version;
}
export function validatePluginImage(value: unknown): string {
  const image = bounded(value, "containerImage", 512);
  if (!/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$/u.test(image)) fail("containerImage must be an exact digest-pinned OCI reference");
  const slash = image.indexOf("/");
  const registry = slash < 0 ? "" : image.slice(0, slash);
  if (registry.includes(":")) { const port = Number(registry.split(":").at(-1)); if (!Number.isInteger(port) || port < 1 || port > 65535) fail("invalid image registry port"); }
  return image;
}
/** Forge's bounded MCP schema subset, deliberately not general JSON Schema. */
export function validatePluginInputSchema(input: unknown): Readonly<Record<string, unknown>> {
  let nodes = 0;
  const visit = (raw: unknown, depth: number): Record<string, unknown> => {
    if (++nodes > 1024 || depth > 12) fail("inputSchema exceeds complexity limits");
    const value = plain(raw, "inputSchema");
    const result: Record<string, unknown> = { type: value.type };
    if (value.type === "object") {
      exact(value, ["type", "properties", "required", "additionalProperties"], "object schema");
      if (value.additionalProperties !== false) fail("object schema additionalProperties must be false");
      const properties = plain(value.properties, "schema properties");
      if (Object.keys(properties).length > 128) fail("schema has too many properties");
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(properties).sort()) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key) || PROTECTED.has(key) || hasProtectedIdentity(key)) fail("unsafe schema property");
        normalized[key] = visit(properties[key], depth + 1);
      }
      result.properties = Object.freeze(normalized);
      result.required = Object.freeze(strings(value.required, "schema required", 128, (key) => Object.hasOwn(properties, key)).slice().sort());
      result.additionalProperties = false;
    } else if (["array", "string", "number", "integer"].includes(String(value.type))) {
      const fields = value.type === "array" ? ["minItems", "maxItems"] : value.type === "string" ? ["minLength", "maxLength"] : ["minimum", "maximum"];
      exact(value, ["type", ...fields, ...(value.type === "array" ? ["items"] : [])], "value schema");
      if (value.type === "array") result.items = visit(value.items, depth + 1);
      for (const key of fields) {
        const bound = value[key]; if (bound === undefined) continue;
        if (typeof bound !== "number" || !Number.isFinite(bound) || Math.abs(bound) > Number.MAX_SAFE_INTEGER) fail("schema bound must be finite");
        if (value.type !== "number" && !Number.isSafeInteger(bound)) fail("schema bound must be integral");
        if ((value.type === "array" || value.type === "string") && (bound < 0 || bound > (value.type === "array" ? 1024 : 16384))) fail("schema bound exceeds host limits");
        result[key] = bound;
      }
      if (typeof result[fields[0]!] === "number" && typeof result[fields[1]!] === "number" && Number(result[fields[0]!]) > Number(result[fields[1]!])) fail("schema minimum exceeds maximum");
    } else if (value.type === "boolean") exact(value, ["type"], "boolean schema");
    else fail("inputSchema type is not in the supported MCP subset");
    return Object.freeze(result);
  };
  const result = visit(input, 0);
  if (result.type !== "object" || JSON.stringify(result).length > 65536) fail("tool inputSchema must be a bounded object schema");
  return result;
}
export function validatePluginManifest(input: unknown): PluginManifest {
  const source = plain(input, "manifest");
  exact(source, ["schemaVersion", "sdkVersion", "id", "version", "name", "description", "kind", "runtime", "transport", "tools", "egress", "secrets", "services", "containerImage", "entrypoint"], "manifest");
  if (source.schemaVersion !== 1 || source.sdkVersion !== PLUGIN_SDK_VERSION) fail("unsupported schema or sdk version");
  const id = validatePluginId(source.id), version = validatePluginVersion(source.version);
  if (source.kind !== "connector" || source.runtime !== "oci-mcp-stdio" || source.transport !== "mcp-jsonrpc-stdio") fail("v1 only supports connector + oci-mcp-stdio + mcp-jsonrpc-stdio");
  const containerImage = validatePluginImage(source.containerImage);
  if (!Array.isArray(source.tools) || !source.tools.length || source.tools.length > 128) fail("tools must be a nonempty bounded array");
  const names = new Set<string>();
  const tools = source.tools.map((raw): PluginTool => {
    const tool = plain(raw, "tool"); exact(tool, ["name", "description", "capabilities", "inputSchema", "effects", "requiresApproval", "retrySafe"], "tool");
    const name = bounded(tool.name, "tool name", 128);
    if (!name.startsWith(`${id}.`) || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(name) || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/u.test(name) || hasProtectedIdentity(name) || names.has(name)) fail("tool names must be unique and prefixed with plugin id");
    names.add(name);
    const capabilities = strings(tool.capabilities, "capabilities", 4, (item) => CAPABILITIES.has(item)) as PluginCapability[];
    if (!capabilities.length) fail("tool capabilities are required");
    const effects = strings(tool.effects, "effects", 3, (item) => ["read", "network", "credential"].includes(item)) as PluginTool["effects"];
    if (!effects.includes("read") || capabilities.includes("network.access") !== effects.includes("network") || capabilities.includes("secret.reference.use") !== effects.includes("credential")) fail("tool effects and capabilities must agree");
    if (typeof tool.requiresApproval !== "boolean" || tool.retrySafe !== true) fail("v1 read tools require safety flags and retrySafe:true");
    return Object.freeze({ name, description: bounded(tool.description, "tool description", 1024), capabilities: Object.freeze([...capabilities]), inputSchema: validatePluginInputSchema(tool.inputSchema), effects: Object.freeze([...effects]), requiresApproval: tool.requiresApproval, retrySafe: true });
  });
  const egress = plain(source.egress, "egress"); exact(egress, ["protocol", "hosts", "port"], "egress");
  if (egress.protocol !== "https" || egress.port !== 443) fail("egress must use HTTPS on port 443");
  const hosts = strings(egress.hosts, "egress hosts", 32, (host) => host.length <= 253 && HOST.test(host) && !host.endsWith(".local") && !host.endsWith(".localhost"));
  if (!Array.isArray(source.secrets) || source.secrets.length > 32) fail("secrets must be bounded");
  const secretNames = new Set<string>();
  const secrets = source.secrets.map((raw): SecretReference => {
    const ref = plain(raw, "secret"); exact(ref, ["name", "purpose"], "secret");
    const name = bounded(ref.name, "secret name", 96);
    if (!/^[A-Z][A-Z0-9_]{1,95}$/u.test(name) || secretNames.has(name)) fail("secret names must be unique uppercase credential names");
    secretNames.add(name);
    return Object.freeze({ name, purpose: bounded(ref.purpose, "secret purpose", 256) });
  });
  if (!Array.isArray(source.services) || source.services.length > 32) fail("services must be bounded");
  const ids = new Set<string>(), serviceHosts = new Set<string>(), usedSecrets = new Set<string>();
  const services = source.services.map((raw): PluginService => {
    const service = plain(raw, "service"); exact(service, ["id", "origin", "paths", "queryKeys", "credential"], "service");
    const serviceId = validatePluginId(service.id); if (ids.has(serviceId)) fail("service ids must be unique"); ids.add(serviceId);
    const origin = bounded(service.origin, "service origin", 300);
    let url: URL; try { url = new URL(origin); } catch { return fail("invalid service origin"); }
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash || origin !== url.origin || !hosts.includes(url.hostname)) fail("service origin must be an exact declared HTTPS origin without credentials, path, or non443 port");
    serviceHosts.add(url.hostname);
    const paths = strings(service.paths, "service paths", 64, (path) => path.length <= 512 && /^\/(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\/)*[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/u.test(path) && !path.includes("//"));
    if (!paths.length) fail("service requires exact paths");
    const queryKeys = strings(service.queryKeys, "service queryKeys", 32, (key) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key) && !PROTECTED.has(key));
    const credential = service.credential;
    if (credential !== undefined && (typeof credential !== "string" || !secretNames.has(credential))) fail("service credential must refer to a declared secret");
    if (typeof credential === "string") usedSecrets.add(credential);
    return Object.freeze({ id: serviceId, origin, paths: Object.freeze([...paths]), queryKeys: Object.freeze([...queryKeys]), ...(typeof credential === "string" ? { credential } : {}) });
  });
  if (hosts.some((host) => !serviceHosts.has(host)) || secrets.some((ref) => !usedSecrets.has(ref.name))) fail("egress hosts and secrets must be used by services");
  if (Boolean(services.length) !== tools.some((tool) => tool.capabilities.includes("network.access"))) fail("services and network.access capabilities must agree");
  if (Boolean(secrets.length) !== tools.some((tool) => tool.capabilities.includes("secret.reference.use"))) fail("secrets and secret.reference.use capabilities must agree");
  const entrypoint = bounded(source.entrypoint, "entrypoint", 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(entrypoint) || entrypoint.split("/").some((part) => !part || part === "." || part === ".." || part.endsWith(".") || PROTECTED.has(part)) || !/\.(?:mjs|cjs|js)$/u.test(entrypoint)) fail("entrypoint must be a relative JavaScript package file");
  return Object.freeze({ schemaVersion: 1, sdkVersion: PLUGIN_SDK_VERSION, id, version, name: bounded(source.name, "name", 120), description: bounded(source.description, "description", 2000), kind: "connector", runtime: "oci-mcp-stdio", transport: "mcp-jsonrpc-stdio", tools: Object.freeze(tools), egress: Object.freeze({ protocol: "https", hosts: Object.freeze([...hosts]), port: 443 }), secrets: Object.freeze(secrets), services: Object.freeze(services), containerImage, entrypoint });
}
export function createManifest(input: Omit<PluginManifest, "schemaVersion" | "sdkVersion">): PluginManifest { return validatePluginManifest({ ...input, schemaVersion: 1, sdkVersion: PLUGIN_SDK_VERSION }); }

export function createConnectorScaffold(id: string, containerImage = DEFAULT_PLUGIN_IMAGE): Readonly<{ manifest: PluginManifest; files: Readonly<Record<string, string>> }> {
  const manifest = createManifest({ id, version: "0.1.0", name: `${id} connector`, description: "Read current temperature through Forge's approved Open-Meteo service broker.", kind: "connector", runtime: "oci-mcp-stdio", transport: "mcp-jsonrpc-stdio", containerImage, entrypoint: "server.mjs", tools: [{ name: `${id}.current`, description: "Read current temperature at latitude/longitude.", capabilities: ["mcp.invoke", "network.access"], inputSchema: { type: "object", properties: { latitude: { type: "number", minimum: -90, maximum: 90 }, longitude: { type: "number", minimum: -180, maximum: 180 } }, required: ["latitude", "longitude"], additionalProperties: false }, effects: ["read", "network"], requiresApproval: false, retrySafe: true }], egress: { protocol: "https", hosts: ["api.open-meteo.com"], port: 443 }, secrets: [], services: [{ id: "open-meteo", origin: "https://api.open-meteo.com", paths: ["/v1/forecast"], queryKeys: ["latitude", "longitude", "current"] }] });
  const server = `// @odinn/plugin-sdk v1. No network, secrets or external runtime dependencies.
import { createInterface } from "node:readline";
const tools = ${JSON.stringify(manifest.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })))};
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let initialized = false, activeCall, sequence = 0, bytes = 0;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdin.on("data", (chunk) => { bytes += chunk.length; if (bytes > 1024 * 1024) process.exit(1); });
input.on("line", (line) => {
  if (line.length > 512 * 1024) return process.exit(1);
  let request;
  try { request = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: "Invalid JSON" } }); }
  if (!request || request.jsonrpc !== "2.0") return send({ id: null, error: { code: -32600, message: "Invalid request" } });
  if (activeCall && request.id === activeCall.serviceId && !request.method) {
    const call = activeCall; activeCall = undefined;
    if (request.error) return send({ id: call.id, result: { isError: true, content: [{ type: "text", text: "Weather service unavailable or access denied." }] } });
    if (request.result?.status !== 200 || !request.result?.body || typeof request.result.body !== "object") return send({ id: call.id, result: { isError: true, content: [{ type: "text", text: "Invalid weather service response." }] } });
    return send({ id: call.id, result: { content: [{ type: "text", text: JSON.stringify(request.result.body) }] } });
  }
  if (request.method === "initialize") {
    if (!["2024-11-05", "2025-03-26", "2025-06-18"].includes(request.params?.protocolVersion)) return send({ id: request.id, error: { code: -32602, message: "Unsupported protocol version" } });
    return send({ id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: ${JSON.stringify(id)}, version: "0.1.0" } } });
  }
  if (request.method === "notifications/initialized") { initialized = true; return; }
  if (request.id === undefined) return;
  if (!initialized) return send({ id: request.id, error: { code: -32002, message: "Not initialized" } });
  if (request.method === "tools/list") return send({ id: request.id, result: { tools } });
  if (request.method !== "tools/call") return send({ id: request.id, error: { code: -32601, message: "Method not supported" } });
  const args = request.params?.arguments;
  if (request.params?.name !== tools[0].name || !args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 2 || !Number.isFinite(args.latitude) || args.latitude < -90 || args.latitude > 90 || !Number.isFinite(args.longitude) || args.longitude < -180 || args.longitude > 180) return send({ id: request.id, error: { code: -32602, message: "Expected bounded latitude and longitude" } });
  if (activeCall) return send({ id: request.id, error: { code: -32000, message: "Only one call at a time" } });
  const serviceId = "service-" + (++sequence);
  activeCall = { id: request.id, serviceId };
  send({ id: serviceId, method: "odinn/service.request", params: { serviceId: "open-meteo", path: "/v1/forecast", query: { latitude: String(args.latitude), longitude: String(args.longitude), current: "temperature_2m" } } });
});
`;
  return Object.freeze({ manifest, files: Object.freeze({ "plugin.json": `${JSON.stringify(manifest, null, 2)}\n`, "server.mjs": server }) });
}
