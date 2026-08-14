import { createHash } from "node:crypto";
import { assertCapabilityIds, type CapabilityId, type TrustedToolSafetyPolicy } from "@odinn/policy";

export const PLUGIN_CONTRACT_SCHEMA_VERSION = 1 as const;

export type PluginKind = "host-capability" | "provider" | "mcp" | "skill";
export type PluginRuntime = "host-adapter" | "node-host" | "oci-mcp" | "reference";
export type PluginToolIdempotency = "not-applicable" | "optional" | "required";

export type PluginToolContract = Readonly<{
  name: string;
  description: string;
  capabilities: readonly CapabilityId[];
  safety: TrustedToolSafetyPolicy;
  idempotency: PluginToolIdempotency;
  resourceFields: readonly string[];
  modelVisible: boolean;
}>;

export type PluginManifest = Readonly<{
  schemaVersion: typeof PLUGIN_CONTRACT_SCHEMA_VERSION;
  id: string;
  version: string;
  kind: PluginKind;
  runtime: PluginRuntime;
  displayName: string;
  activation: Readonly<{ enabledByDefault: boolean }>;
  tools: readonly PluginToolContract[];
  configSchemaRef?: string;
}>;

type RecordValue = Record<string, unknown>;
type ToolEffect = TrustedToolSafetyPolicy["effects"][number];

const PLUGIN_KINDS = new Set<PluginKind>(["host-capability", "provider", "mcp", "skill"]);
const PLUGIN_RUNTIMES = new Set<PluginRuntime>(["host-adapter", "node-host", "oci-mcp", "reference"]);
const TOOL_IDEMPOTENCY = new Set<PluginToolIdempotency>(["not-applicable", "optional", "required"]);
const TOOL_EFFECTS = new Set<ToolEffect>(["read", "filesystem-write", "process", "network", "credential", "external-state"]);
const REVERSIBILITY = new Set<TrustedToolSafetyPolicy["reversibility"]>(["pure", "snapshot-reversible", "compensatable", "irreversible"]);
const PLUGIN_FIELDS = new Set(["schemaVersion", "id", "version", "kind", "runtime", "displayName", "activation", "tools", "configSchemaRef"]);
const ACTIVATION_FIELDS = new Set(["enabledByDefault"]);
const TOOL_FIELDS = new Set(["name", "description", "capabilities", "safety", "idempotency", "resourceFields", "modelVisible"]);
const SAFETY_FIELDS = new Set(["effects", "reversibility", "requiresCapability", "requiresApproval", "retrySafe"]);

const runtimeKinds: Readonly<Record<PluginKind, readonly PluginRuntime[]>> = Object.freeze({
  "host-capability": Object.freeze(["host-adapter", "node-host"] as const),
  provider: Object.freeze(["host-adapter", "oci-mcp"] as const),
  mcp: Object.freeze(["oci-mcp"] as const),
  skill: Object.freeze(["reference"] as const)
});

function plainObject(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be an ordinary object`);
  }
  return value as RecordValue;
}

function rejectUnknownFields(value: RecordValue, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
}

function boundedString(value: unknown, label: string, { min = 1, max = 256 }: { min?: number; max?: number } = {}): string {
  if (typeof value !== "string" || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function boundedStringArray(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be an array of at most ${maximum} strings`);
  const values = value.map((item, index) => boundedString(item, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`);
  return values;
}

function normalizeSafety(value: unknown, label: string): TrustedToolSafetyPolicy {
  const source = plainObject(value, label);
  rejectUnknownFields(source, SAFETY_FIELDS, label);
  const effects = boundedStringArray(source.effects, `${label}.effects`, 6) as ToolEffect[];
  if (!effects.length || effects.some((effect) => !TOOL_EFFECTS.has(effect))) throw new Error(`${label}.effects contains an unsupported effect`);
  const reversibility = boundedString(source.reversibility, `${label}.reversibility`) as TrustedToolSafetyPolicy["reversibility"];
  if (!REVERSIBILITY.has(reversibility)) throw new Error(`${label}.reversibility is unsupported`);
  if (source.requiresCapability !== true) throw new Error(`${label}.requiresCapability must be true`);
  if (typeof source.requiresApproval !== "boolean" || typeof source.retrySafe !== "boolean") {
    throw new Error(`${label}.requiresApproval and ${label}.retrySafe must be boolean`);
  }
  return Object.freeze({
    effects: Object.freeze(effects),
    reversibility,
    requiresCapability: true,
    requiresApproval: source.requiresApproval,
    retrySafe: source.retrySafe
  });
}

function normalizeTool(value: unknown, index: number): PluginToolContract {
  const label = `tools[${index}]`;
  const source = plainObject(value, label);
  rejectUnknownFields(source, TOOL_FIELDS, label);
  const name = boundedString(source.name, `${label}.name`, { max: 128 });
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/u.test(name)) throw new Error(`${label}.name is not a namespaced tool name`);
  const description = boundedString(source.description, `${label}.description`, { max: 1_024 });
  const capabilities = assertCapabilityIds(source.capabilities, `${label}.capabilities`);
  const idempotency = source.idempotency === undefined ? "not-applicable" : boundedString(source.idempotency, `${label}.idempotency`) as PluginToolIdempotency;
  if (!TOOL_IDEMPOTENCY.has(idempotency)) throw new Error(`${label}.idempotency is unsupported`);
  const resourceFields = source.resourceFields === undefined
    ? []
    : boundedStringArray(source.resourceFields, `${label}.resourceFields`, 32);
  if (source.modelVisible !== undefined && typeof source.modelVisible !== "boolean") throw new Error(`${label}.modelVisible must be boolean`);
  return Object.freeze({
    name,
    description,
    capabilities: Object.freeze([...capabilities]),
    safety: normalizeSafety(source.safety, `${label}.safety`),
    idempotency,
    resourceFields: Object.freeze(resourceFields),
    modelVisible: source.modelVisible !== false
  });
}

export function validatePluginManifest(input: unknown): PluginManifest {
  const source = plainObject(input, "plugin manifest");
  rejectUnknownFields(source, PLUGIN_FIELDS, "plugin manifest");
  if (source.schemaVersion !== PLUGIN_CONTRACT_SCHEMA_VERSION) throw new Error(`unsupported plugin manifest schema: ${String(source.schemaVersion)}`);
  const id = boundedString(source.id, "plugin manifest.id", { max: 64 });
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(id)) throw new Error("plugin manifest.id must be lowercase and 2-64 characters");
  const version = boundedString(source.version, "plugin manifest.version", { max: 64 });
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error(`invalid plugin version: ${version}`);
  const kind = boundedString(source.kind, "plugin manifest.kind") as PluginKind;
  if (!PLUGIN_KINDS.has(kind)) throw new Error(`unsupported plugin kind: ${kind}`);
  const runtime = boundedString(source.runtime, "plugin manifest.runtime") as PluginRuntime;
  if (!PLUGIN_RUNTIMES.has(runtime) || !runtimeKinds[kind].includes(runtime)) throw new Error(`plugin runtime ${runtime} is not valid for ${kind}`);
  const displayName = boundedString(source.displayName, "plugin manifest.displayName", { max: 120 });
  const activationSource = plainObject(source.activation, "plugin manifest.activation");
  rejectUnknownFields(activationSource, ACTIVATION_FIELDS, "plugin manifest.activation");
  if (typeof activationSource.enabledByDefault !== "boolean") throw new Error("plugin manifest.activation.enabledByDefault must be boolean");
  if (!Array.isArray(source.tools) || source.tools.length > 128) throw new Error("plugin manifest.tools must contain at most 128 tools");
  const tools = source.tools.map(normalizeTool);
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error("plugin manifest.tools must not contain duplicate names");
  if (kind === "skill" && tools.length > 0) throw new Error("skill plugins cannot declare executable tools");
  const configSchemaRef = source.configSchemaRef === undefined ? undefined : boundedString(source.configSchemaRef, "plugin manifest.configSchemaRef", { max: 256 });
  return Object.freeze({
    schemaVersion: PLUGIN_CONTRACT_SCHEMA_VERSION,
    id,
    version,
    kind,
    runtime,
    displayName,
    activation: Object.freeze({ enabledByDefault: activationSource.enabledByDefault }),
    tools: Object.freeze(tools),
    ...(configSchemaRef === undefined ? {} : { configSchemaRef })
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as RecordValue).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as RecordValue)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function pluginIdentityFingerprint(input: unknown): string {
  const manifest = validatePluginManifest(input);
  return createHash("sha256").update(stableJson(manifest), "utf8").digest("hex");
}
