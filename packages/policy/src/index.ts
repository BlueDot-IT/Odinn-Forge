import { resolve, sep } from "node:path";

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
  allowedCapabilities: string[];
  maxInputBytes: number;
  security: { web: SecuritySurface; browser: SecuritySurface };
  invariants: PolicyInvariant[];
}

export interface PolicyTool { capability: string }
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
  | { allowed: true; decision: "allow"; capability: string }
  | { allowed: false; decision: "deny"; reason: string; details: Record<string, unknown> };

type PolicyOverrides = Partial<Omit<RuntimePolicy, "security">> & {
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
  const defaultCapabilities = [
    "job.healthcheck",
    "text.echo",
    "workspace.readText",
    "model.chat",
    "agent.run",
    "web.read",
    "browser.read",
    "browser.act",
    "discord.read",
    "discord.write",
    "session.read",
    "session.write",
    "goal.read",
    "goal.write",
    "memory.read",
    "memory.write",
    "improve.read",
    "improve.write"
  ];
  const configuredCapabilities = Array.isArray(overrides.allowedCapabilities) ? overrides.allowedCapabilities : undefined;
  const allowedCapabilities = configuredCapabilities ?? defaultCapabilities;
  const defaults = {
    deniedTools: [],
    maxInputBytes: 16_384,
    ...overrides,
    invariants: normalizePolicyInvariants(overrides.invariants ?? []),
    allowedCapabilities,
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

export function evaluateTaskPolicy({ policy = createDefaultPolicy(), request, tool }: { policy?: RuntimePolicy; request: PolicyRequest; tool?: PolicyTool }): PolicyDecision {
  if (!tool) {
    return deny(`unknown tool: ${request.tool}`, { code: "UNKNOWN_TOOL" });
  }
  if (policy.deniedTools?.includes(request.tool)) {
    return deny(`tool is denied by policy: ${request.tool}`, { code: "TOOL_DENIED" });
  }
  if (!policy.allowedCapabilities?.includes(tool.capability)) {
    return deny(`capability is not allowed: ${tool.capability}`, { code: "CAPABILITY_DENIED" });
  }
  if (["web.read", "browser.read", "browser.act"].includes(tool.capability)) {
    const surface = tool.capability.startsWith("web.") ? policy.security?.web : policy.security?.browser;
    if (surface?.enabled === false) return deny(`security policy disabled ${tool.capability}`, { code: "SECURITY_SURFACE_DISABLED" });
  }
  const inputBytes = Buffer.byteLength(JSON.stringify(request.input), "utf8");
  if (inputBytes > (policy.maxInputBytes ?? 16_384)) {
    return deny(`input exceeds policy limit: ${inputBytes} bytes`, { code: "INPUT_TOO_LARGE", inputBytes });
  }
  return { allowed: true, decision: "allow", capability: tool.capability };
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
