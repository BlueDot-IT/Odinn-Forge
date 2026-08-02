import { resolve, sep } from "node:path";
import {
  CAPABILITY_REGISTRY_VERSION,
  DEFAULT_ALLOWED_CAPABILITIES,
  CapabilityRegistryError,
  assertCapabilityIds,
  capabilitiesForTool,
  isCapabilityId,
  migrateLegacyCapabilityPolicy,
  type CapabilityGrant,
  type CapabilityId,
  type CapabilityMigrationReport
} from "./capabilities.ts";

export {
  CAPABILITY_IDS,
  CAPABILITY_REGISTRY,
  CAPABILITY_REGISTRY_VERSION,
  DEFAULT_ALLOWED_CAPABILITIES,
  TOOL_CAPABILITY_REGISTRY,
  CapabilityRegistryError,
  assertCapabilityIds,
  capabilitiesForTool,
  intersectChildCapabilities,
  isCapabilityId,
  migrateLegacyCapabilityPolicy
} from "./capabilities.ts";
export type { CapabilityGrant, CapabilityId, CapabilityMigrationEntry, CapabilityMigrationReport } from "./capabilities.ts";

export type SecuritySurface = {
  enabled: boolean;
  allowPrivateNetwork: boolean;
  allowedDomains: string[];
  blockedDomains: string[];
  requireApproval?: boolean;
  allowDownloads?: boolean;
  allowUploads?: boolean;
};

export interface RuntimePolicy {
  id?: string;
  deniedTools: string[];
  capabilityRegistryVersion: 1;
  allowedCapabilities: CapabilityId[];
  scopedCapabilities: CapabilityGrant[];
  capabilityMigration: CapabilityMigrationReport;
  maxInputBytes: number;
  security: { web: SecuritySurface; browser: SecuritySurface };
  invariants: PolicyInvariant[];
}

export interface PolicyTool { capability?: string; capabilities?: readonly string[] }
export interface PolicyRequest { tool: string; input: Record<string, unknown> }
export type PolicyEnforcement = "log" | "warn" | "pause" | "block" | "rollback" | "terminate";
export type PolicyInvariantType = "command.deny-pattern" | "tool.requires-approval" | "filesystem.allowed-roots";
export interface PolicyInvariant {
  id: string;
  type: PolicyInvariantType;
  values: string[];
  enforcement: PolicyEnforcement;
}
export interface PolicyInvariantEvaluation {
  invariantId: string;
  violated: boolean;
  decision: "allow" | PolicyEnforcement;
  enforcement: PolicyEnforcement;
  reason: string;
}
export type PolicyDecision =
  | { allowed: true; decision: "allow"; capability: CapabilityId; capabilities: readonly CapabilityId[] }
  | { allowed: false; decision: "deny"; reason: string; details: Record<string, unknown> };

type PolicyOverrides = Partial<Omit<RuntimePolicy, "security" | "allowedCapabilities" | "scopedCapabilities" | "capabilityMigration" | "capabilityRegistryVersion">> & {
  capabilityRegistryVersion?: 1;
  allowedCapabilities?: string[];
  scopedCapabilities?: CapabilityGrant[];
  security?: { web?: Partial<SecuritySurface>; browser?: Partial<SecuritySurface> };
};

export class PolicyError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "PolicyError";
    this.details = details;
  }
}

export function createDefaultPolicy(overrides: PolicyOverrides = {}): RuntimePolicy {
  const configuredCapabilities = Array.isArray(overrides.allowedCapabilities) ? overrides.allowedCapabilities : undefined;
  if (overrides.capabilityRegistryVersion !== undefined && overrides.capabilityRegistryVersion !== CAPABILITY_REGISTRY_VERSION) {
    throw new CapabilityRegistryError("INVALID_CAPABILITY_SET", `unsupported capability registry version: ${String(overrides.capabilityRegistryVersion)}`);
  }
  const migrated = migrateLegacyCapabilityPolicy(configuredCapabilities ?? DEFAULT_ALLOWED_CAPABILITIES, {
    versionless: configuredCapabilities !== undefined && overrides.capabilityRegistryVersion === undefined
  });
  const scopedCapabilities = mergeScopedCapabilityGrants(migrated.scopedCapabilities, overrides.scopedCapabilities);
  const defaults = {
    deniedTools: [],
    maxInputBytes: 16_384,
    ...overrides,
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
    invariants: normalizePolicyInvariants(overrides.invariants ?? []),
    allowedCapabilities: [...migrated.allowedCapabilities],
    scopedCapabilities,
    capabilityMigration: migrated.report,
    security: {
      ...defaultsSecurity,
      ...(overrides.security ?? {}),
      web: { ...defaultsSecurity.web, ...(overrides.security?.web ?? {}) },
      browser: { ...defaultsSecurity.browser, ...(overrides.security?.browser ?? {}) }
    }
  };
  return defaults;
}

const defaultsSecurity = {
  web: {
    enabled: true,
    allowPrivateNetwork: false,
    allowedDomains: [],
    blockedDomains: []
  },
  browser: {
    enabled: true,
    allowPrivateNetwork: false,
    allowedDomains: [],
    blockedDomains: [],
    requireApproval: true,
    allowDownloads: false,
    allowUploads: false
  }
};

function mergeScopedCapabilityGrants(migrated: readonly CapabilityGrant[], configured: unknown): CapabilityGrant[] {
  const grants = new Map<string, CapabilityGrant>(migrated.map((grant) => [`${grant.tool}\0${grant.capability}`, grant]));
  if (configured !== undefined) {
    if (!Array.isArray(configured) || configured.length > 512) throw new PolicyError("scopedCapabilities must be an array of at most 512 grants");
    for (const value of configured) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new PolicyError("scoped capability grants must be objects");
      const tool = String((value as Record<string, unknown>).tool ?? "").trim();
      const capabilities = assertCapabilityIds([(value as Record<string, unknown>).capability], "scoped capability grant");
      if (!tool || !capabilitiesForTool(tool).includes(capabilities[0]!)) throw new PolicyError(`scoped capability grant does not match trusted tool declaration: ${tool}`);
      const grant = Object.freeze({ tool, capability: capabilities[0]! });
      grants.set(`${tool}\0${grant.capability}`, grant);
    }
  }
  return [...grants.values()].sort((left, right) => left.tool.localeCompare(right.tool) || left.capability.localeCompare(right.capability));
}

function resolveToolCapabilities(toolName: string, tool: PolicyTool):
  | { capabilities: readonly CapabilityId[] }
  | { error: string; details: Record<string, unknown> } {
  let registered: readonly CapabilityId[] | undefined;
  try {
    registered = capabilitiesForTool(toolName);
  } catch {
    registered = undefined;
  }
  if (tool.capabilities !== undefined) {
    let declared: readonly CapabilityId[];
    try {
      declared = assertCapabilityIds(tool.capabilities, `tool ${toolName} capabilities`);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : `tool ${toolName} has invalid capabilities`,
        details: { code: "UNKNOWN_CAPABILITY", tool: toolName }
      };
    }
    if (!declared.length) return { error: `tool has no declared capabilities: ${toolName}`, details: { code: "CAPABILITY_DECLARATION_MISSING", tool: toolName } };
    if (registered && (declared.length !== registered.length || declared.some((capability) => !registered!.includes(capability)))) {
      return {
        error: `tool capability declaration does not match trusted registry: ${toolName}`,
        details: { code: "CAPABILITY_DECLARATION_MISMATCH", tool: toolName, declared, registered }
      };
    }
    return { capabilities: registered ?? declared };
  }
  if (registered) return { capabilities: registered };
  if (isCapabilityId(tool.capability)) return { capabilities: Object.freeze([tool.capability]) };
  return {
    error: `tool has no trusted capability declaration: ${toolName}`,
    details: { code: "CAPABILITY_DECLARATION_MISSING", tool: toolName }
  };
}

function policyAllowsCapability(policy: RuntimePolicy, tool: string, capability: CapabilityId): boolean {
  return policy.allowedCapabilities.includes(capability)
    || policy.scopedCapabilities.some((grant) => grant.tool === tool && grant.capability === capability);
}

export function evaluateTaskPolicy({ policy = createDefaultPolicy(), request, tool }: { policy?: RuntimePolicy; request: PolicyRequest; tool?: PolicyTool }): PolicyDecision {
  if (!tool) {
    return deny(`unknown tool: ${request.tool}`, { code: "UNKNOWN_TOOL" });
  }
  if (policy.deniedTools?.includes(request.tool)) {
    return deny(`tool is denied by policy: ${request.tool}`, { code: "TOOL_DENIED" });
  }
  const declared = resolveToolCapabilities(request.tool, tool);
  if ("error" in declared) return deny(declared.error, declared.details);
  const missing = declared.capabilities.filter((capability) => !policyAllowsCapability(policy, request.tool, capability));
  if (missing.length) {
    return deny(`capability is not allowed: ${missing.join(", ")}`, { code: "CAPABILITY_DENIED", capabilities: missing });
  }
  if (request.tool.startsWith("web.") || request.tool.startsWith("browser.")) {
    const surface = request.tool.startsWith("web.") ? policy.security?.web : policy.security?.browser;
    if (surface?.enabled === false) return deny(`security policy disabled ${request.tool}`, { code: "SECURITY_SURFACE_DISABLED" });
  }
  const inputBytes = Buffer.byteLength(JSON.stringify(request.input), "utf8");
  if (inputBytes > (policy.maxInputBytes ?? 16_384)) {
    return deny(`input exceeds policy limit: ${inputBytes} bytes`, { code: "INPUT_TOO_LARGE", inputBytes });
  }
  return { allowed: true, decision: "allow", capability: declared.capabilities[0]!, capabilities: declared.capabilities };
}

export type GatewatchPreview = Readonly<{
  schemaVersion: 1;
  registryVersion: 1;
  allowed: boolean;
  decision: "allow" | "deny";
  reason: string;
  tool: string;
  declaredCapabilities: readonly CapabilityId[];
  policyCapabilities: readonly CapabilityId[];
  parentCapabilities: readonly CapabilityId[];
  requestedCapabilities: readonly CapabilityId[];
  effectiveCapabilities: readonly CapabilityId[];
  declarationRequests: Readonly<{
    skill: readonly CapabilityId[];
    mcp: readonly CapabilityId[];
    grantsAuthority: false;
  }>;
  invariants: readonly PolicyInvariantEvaluation[];
  migration: CapabilityMigrationReport;
  details: Readonly<Record<string, unknown>>;
  executes: false;
}>;

export function previewGatewatchDecision({
  policy = createDefaultPolicy(),
  request,
  tool,
  parentCapabilities,
  requestedCapabilities,
  skillCapabilities = [],
  mcpCapabilities = [],
  workspaceRoot = process.cwd()
}: {
  policy?: RuntimePolicy;
  request: PolicyRequest;
  tool?: PolicyTool;
  parentCapabilities?: unknown;
  requestedCapabilities?: unknown;
  skillCapabilities?: unknown;
  mcpCapabilities?: unknown;
  workspaceRoot?: string;
}): GatewatchPreview {
  const base = evaluateTaskPolicy({ policy, request, tool });
  const resolved = tool ? resolveToolCapabilities(request.tool, tool) : { error: `unknown tool: ${request.tool}`, details: { code: "UNKNOWN_TOOL" } };
  const declared = "capabilities" in resolved ? resolved.capabilities : [];
  const policyCapabilities = declared.filter((capability) => policyAllowsCapability(policy, request.tool, capability));
  const parent = parentCapabilities === undefined ? policyCapabilities : assertCapabilityIds(parentCapabilities, "parentCapabilities");
  const requested = requestedCapabilities === undefined ? declared : assertCapabilityIds(requestedCapabilities, "requestedCapabilities");
  const skill = assertCapabilityIds(skillCapabilities, "skillCapabilities");
  const mcp = assertCapabilityIds(mcpCapabilities, "mcpCapabilities");
  const outsideParent = requested.filter((capability) => !parent.includes(capability));
  const outsideTool = requested.filter((capability) => !declared.includes(capability));
  const missingForTool = declared.filter((capability) => !requested.includes(capability));
  const missingFromPolicy = declared.filter((capability) => !policyCapabilities.includes(capability));
  const invariants = evaluatePolicyInvariants({ policy, request, workspaceRoot });
  const blockingInvariant = invariants.find((item) => ["pause", "block", "rollback", "terminate"].includes(item.decision));
  const escalation = outsideParent.length > 0 || outsideTool.length > 0 || missingForTool.length > 0;
  const allowed = base.allowed && !escalation && !blockingInvariant;
  const reason = !base.allowed ? base.reason
    : outsideParent.length ? "child capability request exceeds parent grants"
      : outsideTool.length ? "requested capability exceeds the trusted tool declaration"
        : missingForTool.length ? "requested capabilities omit authority required by the tool"
          : blockingInvariant ? blockingInvariant.reason
            : "Gatewatch would allow this execution";
  const details = !base.allowed ? base.details : {
    ...(outsideParent.length ? { code: "CHILD_CAPABILITY_ESCALATION", outsideParent } : {}),
    ...(outsideTool.length ? { code: "TOOL_CAPABILITY_MISMATCH", outsideTool } : {}),
    ...(missingForTool.length ? { code: "REQUIRED_CAPABILITY_MISSING", missingForTool } : {}),
    ...(missingFromPolicy.length ? { missingFromPolicy } : {}),
    ...(blockingInvariant ? { code: "POLICY_INVARIANT_BLOCKED", invariantId: blockingInvariant.invariantId } : {})
  };
  return Object.freeze({
    schemaVersion: 1,
    registryVersion: CAPABILITY_REGISTRY_VERSION,
    allowed,
    decision: allowed ? "allow" : "deny",
    reason,
    tool: request.tool,
    declaredCapabilities: Object.freeze([...declared]),
    policyCapabilities: Object.freeze([...policyCapabilities]),
    parentCapabilities: Object.freeze([...parent]),
    requestedCapabilities: Object.freeze([...requested]),
    effectiveCapabilities: Object.freeze(allowed ? declared.filter((capability) => policyCapabilities.includes(capability) && parent.includes(capability) && requested.includes(capability)) : []),
    declarationRequests: Object.freeze({ skill, mcp, grantsAuthority: false }),
    invariants: Object.freeze(invariants),
    migration: policy.capabilityMigration,
    details: Object.freeze(details),
    executes: false
  });
}

export function normalizePolicyInvariants(value: unknown): PolicyInvariant[] {
  if (!Array.isArray(value)) throw new PolicyError("policy invariants must be an array");
  const ids = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new PolicyError(`policy invariant ${index + 1} must be an object`);
    const source = item as Partial<PolicyInvariant>;
    const id = String(source.id ?? "").trim();
    if (!id || ids.has(id)) throw new PolicyError("policy invariant ids must be unique non-empty strings");
    ids.add(id);
    if (!["command.deny-pattern", "tool.requires-approval", "filesystem.allowed-roots"].includes(String(source.type))) {
      throw new PolicyError(`unsupported policy invariant type: ${String(source.type ?? "missing")}`);
    }
    if (!Array.isArray(source.values) || source.values.length === 0 || source.values.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new PolicyError(`policy invariant ${id} requires non-empty string values`);
    }
    const enforcement = String(source.enforcement ?? "block") as PolicyEnforcement;
    if (!["log", "warn", "pause", "block", "rollback", "terminate"].includes(enforcement)) {
      throw new PolicyError(`invalid enforcement for policy invariant ${id}`);
    }
    return {
      id,
      type: source.type as PolicyInvariantType,
      values: source.values.map((entry) => entry.trim()),
      enforcement
    };
  });
}

export function evaluatePolicyInvariants({
  policy = createDefaultPolicy(),
  request,
  workspaceRoot = process.cwd()
}: {
  policy?: RuntimePolicy;
  request: PolicyRequest;
  tool?: PolicyTool;
  workspaceRoot?: string;
}): PolicyInvariantEvaluation[] {
  const invariants = normalizePolicyInvariants(policy.invariants ?? []);
  return invariants.map((invariant) => {
    const violated = invariantViolated(invariant, request, workspaceRoot);
    return {
      invariantId: invariant.id,
      violated,
      decision: violated ? invariant.enforcement : "allow",
      enforcement: invariant.enforcement,
      reason: violated ? `invariant violated: ${invariant.id}` : "invariant satisfied"
    };
  });
}

function invariantViolated(invariant: PolicyInvariant, request: PolicyRequest, workspaceRoot: string) {
  if (invariant.type === "tool.requires-approval") return invariant.values.includes(request.tool);
  if (invariant.type === "command.deny-pattern") {
    if (!/(?:^|[._-])(exec|process|shell|command)(?:$|[._-])/iu.test(request.tool)) return false;
    const command = Array.isArray(request.input.command)
      ? request.input.command.map(String).join(" ")
      : [request.input.command, request.input.args].flat().filter(Boolean).map(String).join(" ");
    return invariant.values.some((pattern) => command.includes(pattern));
  }
  const paths = [
    typeof request.input.path === "string" ? request.input.path : undefined,
    ...(Array.isArray(request.input.paths) ? request.input.paths.filter((item): item is string => typeof item === "string") : [])
  ].filter((item): item is string => Boolean(item));
  if (!paths.length) return false;
  const base = resolve(workspaceRoot);
  const roots = invariant.values.map((root) => resolve(base, root));
  return paths.some((path) => {
    const target = resolve(base, path);
    return !roots.some((root) => target === root || target.startsWith(`${root}${sep}`));
  });
}

export function assertAllowed(result: PolicyDecision): asserts result is Extract<PolicyDecision, { allowed: true }> {
  if (!result.allowed) throw new PolicyError(result.reason, result.details);
}

function deny(reason: string, details: Record<string, unknown>): PolicyDecision {
  return { allowed: false, decision: "deny", reason, details };
}
