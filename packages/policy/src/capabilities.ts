export const CAPABILITY_REGISTRY_VERSION = 1 as const;

const capability = <Id extends string>(id: Id, description: string) => Object.freeze({ id, description });

export const CAPABILITY_REGISTRY = Object.freeze([
  capability("workspace.inspect", "Inspect bounded workspace and local runtime state."),
  capability("workspace.mutate", "Create, update, or remove workspace and local runtime state."),
  capability("workspace.patch", "Apply a bounded, reviewable workspace patch."),
  capability("git.read", "Inspect bounded status, diffs, and history from the assigned local Git worktree."),
  capability("github.read", "Read bounded metadata and content from explicitly allowed GitHub repositories."),
  capability("process.execute", "Execute a bounded process without an implicit shell."),
  capability("process.interactive", "Control an interactive process or terminal session."),
  capability("process.shell", "Interpret shell syntax; separate from argument-array process execution."),
  capability("network.access", "Access a configured network service or public network resource."),
  capability("browser.read", "Inspect browser tabs, pages, and recovery state."),
  capability("browser.mutate", "Change browser or remote page state."),
  capability("computer.read", "Inspect a paired computer display."),
  capability("email.read", "Read bounded content from explicitly selected email accounts."),
  capability("agent.delegate", "Delegate bounded work to a child agent."),
  capability("mcp.discover", "Discover tools from a configured MCP server."),
  capability("mcp.invoke", "Invoke a tool on a configured MCP server."),
  capability("skill.catalog", "List bounded metadata for explicitly enabled skill packages."),
  capability("skill.hydrate", "Hydrate a trusted, selected skill package."),
  capability("skill.manage", "Create or change the lifecycle of a managed skill package."),
  capability("event.register", "Register a durable event source or trigger."),
  capability("secret.reference.use", "Use an opaque operator-provided secret reference."),
  capability("restore.create", "Create a bounded recovery snapshot."),
  capability("restore.apply", "Apply an operator-reviewed recovery snapshot.")
] as const);

export type CapabilityId = typeof CAPABILITY_REGISTRY[number]["id"];
export type CapabilityGrant = Readonly<{ capability: CapabilityId; tool: string }>;

export const CAPABILITY_IDS = Object.freeze(CAPABILITY_REGISTRY.map((entry) => entry.id)) as readonly CapabilityId[];
export const DEFAULT_ALLOWED_CAPABILITIES = Object.freeze([
  "workspace.inspect",
  "workspace.mutate",
  "network.access",
  "browser.read",
  "browser.mutate",
  "agent.delegate"
] as const satisfies readonly CapabilityId[]);

type ToolCapabilityEntry = Readonly<{
  tool: string;
  capabilities: readonly CapabilityId[];
  legacyCapabilities: readonly string[];
  approval?: "required" | "not-required";
  safety?: TrustedToolSafetyPolicy;
  approvalEffect?: TrustedApprovalEffectPolicy;
}>;

export type TrustedToolSafetyPolicy = Readonly<{
  effects: readonly ("read" | "filesystem-write" | "process" | "network" | "credential" | "external-state")[];
  reversibility: "pure" | "snapshot-reversible" | "compensatable" | "irreversible";
  requiresCapability: boolean;
  requiresApproval: boolean;
  retrySafe: boolean;
}>;

export type TrustedApprovalEffectPolicy = Readonly<{
  effectClass: string;
  summaryAction: string;
  targetFallback: string;
  targetFields: readonly string[];
  mutation: string;
  recovery: string;
  reversible: "reversible" | "irreversible" | "uncertain";
  idempotency: "idempotent" | "non-idempotent" | "unknown";
}>;

const tool = (
  name: string,
  capabilities: readonly CapabilityId[],
  legacyCapabilities: readonly string[],
  options: Pick<ToolCapabilityEntry, "approval" | "safety" | "approvalEffect"> = {},
): ToolCapabilityEntry => Object.freeze({
  tool: name,
  capabilities: Object.freeze([...capabilities]),
  legacyCapabilities: Object.freeze([...legacyCapabilities]),
  ...options,
});

const inspectTools = [
  ["job.healthcheck", "job.healthcheck"], ["text.echo", "text.echo"], ["workspace.readText", "workspace.readText"],
  ["workspace.list", "workspace.list"], ["workspace.stat", "workspace.stat"], ["workspace.search", "workspace.search"],
  ["workspace.read", "workspace.read"], ["workspace.diff", "workspace.diff"],
  ["memory.candidates", "memory.read"], ["memory.search", "memory.read"], ["memory.recall", "memory.read"],
  ["memory.browse", "memory.read"], ["memory.open", "memory.read"], ["memory.curate", "memory.read"],
  ["session.list", "session.read"], ["session.read", "session.read"], ["project.list", "session.read"],
  ["goal.list", "goal.read"], ["improve.list", "improve.read"]
] as const;
const mutateTools = [
  ["memory.remember", "memory.write"], ["memory.suggest", "memory.write"], ["memory.decide", "memory.write"],
  ["memory.compact", "memory.write"], ["memory.correct", "memory.write"], ["memory.forget", "memory.write"],
  ["session.create", "session.write"], ["session.message", "session.write"], ["session.rename", "session.write"],
  ["session.assign", "session.write"], ["session.update", "session.write"], ["session.delete", "session.write"],
  ["project.create", "session.write"], ["project.update", "session.write"], ["goal.create", "goal.write"],
  ["goal.update", "goal.write"], ["improve.propose", "improve.write"], ["improve.learn", "improve.write"],
  ["improve.decide", "improve.write"], ["improve.rollback", "improve.write"]
] as const;
const discordReadTools = [
  "discord.listChannels", "discord.readMessages", "discord.listReactions", "discord.listPins",
  "discord.listThreads", "discord.searchMessages"
] as const;
const discordMutationTools = [
  "discord.sendMessage", "discord.editMessage", "discord.deleteMessage", "discord.addReaction",
  "discord.removeReaction", "discord.pinMessage", "discord.unpinMessage", "discord.sendPoll",
  "discord.createThread", "discord.replyThread"
] as const;

const discordReadSafety: TrustedToolSafetyPolicy = Object.freeze({
  effects: Object.freeze(["read", "network"] as const),
  reversibility: "pure",
  requiresCapability: true,
  requiresApproval: false,
  retrySafe: false
});

function discordMutationSafety(name: string): TrustedToolSafetyPolicy | undefined {
  if (name === "discord.sendMessage" || name === "discord.addReaction") {
    return Object.freeze({
      effects: Object.freeze(["network", "credential", "external-state"] as const),
      reversibility: "compensatable",
      requiresCapability: true,
      requiresApproval: true,
      retrySafe: false
    });
  }
  if (name === "discord.createThread") {
    return Object.freeze({
      effects: Object.freeze(["network", "credential", "external-state"] as const),
      reversibility: "irreversible",
      requiresCapability: true,
      requiresApproval: true,
      retrySafe: false
    });
  }
  return undefined;
}

function discordApprovalEffect(name: string): TrustedApprovalEffectPolicy {
  return Object.freeze({
    effectClass: "Discord mutation",
    summaryAction: "Discord mutation",
    targetFallback: "the configured Discord target",
    targetFields: Object.freeze(["channelId", "threadId", "messageId"]),
    mutation: name.slice("discord.".length),
    recovery: "An uncertain external mutation requires operator review before retry.",
    reversible: name.includes("delete") ? "irreversible" : "uncertain",
    idempotency: "non-idempotent"
  });
}

export const TOOL_CAPABILITY_REGISTRY = Object.freeze([
  ...inspectTools.map(([name, legacy]) => tool(name, ["workspace.inspect"], [legacy])),
  ...mutateTools.map(([name, legacy]) => tool(name, ["workspace.mutate"], [legacy])),
  // These governed Stage 5 surfaces are new capability names, not legacy aliases.
  // Keeping their alias lists empty preserves versionless capability policies.
  tool("workspace.mutate", ["workspace.mutate"], []),
  tool("workspace.patch", ["workspace.patch"], []),
  ...["git.status", "git.diff", "git.log"].map((name) => tool(name, ["git.read"], [], {
    approval: "not-required",
    safety: Object.freeze({
      effects: Object.freeze(["read"] as const),
      reversibility: "pure",
      requiresCapability: true,
      requiresApproval: false,
      retrySafe: true
    })
  })),
  ...["github.repository", "github.issue", "github.pull-request", "github.checks"].map((name) => tool(name, ["github.read", "network.access", "secret.reference.use"], [], {
    approval: "not-required",
    safety: Object.freeze({
      effects: Object.freeze(["read", "network", "credential"] as const),
      reversibility: "pure",
      requiresCapability: true,
      requiresApproval: false,
      retrySafe: true
    })
  })),
  tool("restore.create", ["restore.create"], []),
  tool("restore.apply", ["restore.apply"], []),
  tool("snapshot.create", ["restore.create"], []),
  tool("snapshot.restore", ["restore.apply"], []),
  tool("process.exec", ["process.execute"], ["process.exec"]),
  tool("agent.delegate", ["agent.delegate"], ["agent.delegate"]),
  tool("web.search", ["network.access"], ["web.read"]),
  tool("web.fetch", ["network.access"], ["web.read"]),
  tool("browser.tabs", ["browser.read"], ["browser.read"]),
  tool("browser.open", ["browser.read", "network.access"], ["browser.read"]),
  tool("browser.snapshot", ["browser.read"], ["browser.read"]),
  tool("browser.recovery.status", ["browser.read"], ["browser.read"]),
  tool("browser.click", ["browser.mutate", "network.access"], ["browser.act"]),
  tool("browser.type", ["browser.mutate", "network.access"], ["browser.act"]),
  tool("browser.press", ["browser.mutate", "network.access"], ["browser.act"]),
  tool("browser.recovery.resolve", ["browser.mutate"], ["browser.act"], {
    approval: "not-required",
    safety: Object.freeze({
      effects: Object.freeze(["filesystem-write", "external-state"] as const),
      reversibility: "compensatable",
      requiresCapability: true,
      requiresApproval: false,
      retrySafe: false
    })
  }),
  tool("computer.screen", ["computer.read"], ["computer.screen"], {
    approval: "not-required",
    safety: Object.freeze({
      effects: Object.freeze(["read", "credential"] as const),
      reversibility: "pure",
      requiresCapability: true,
      requiresApproval: false,
      retrySafe: false
    })
  }),
  ...["email.accounts", "email.search", "email.read", "email.thread"].map((name) => tool(name, ["email.read", "network.access"], [], {
    approval: "not-required",
    safety: Object.freeze({
      effects: Object.freeze(["read", "network", "credential"] as const),
      reversibility: "pure",
      requiresCapability: true,
      requiresApproval: false,
      retrySafe: false
    })
  })),
  tool("agent.run", ["agent.delegate", "network.access"], ["agent.run"]),
  tool("model.chat", ["network.access"], ["model.chat"]),
  tool("mcp.discover", ["mcp.discover"], []),
  tool("mcp.invoke", ["mcp.invoke"], []),
  tool("skill.catalog", ["skill.catalog"], ["skill.catalog"]),
  tool("skill.hydrate", ["skill.hydrate"], ["skill.hydrate"]),
  tool("skill.install", ["skill.manage"], ["skill.install"]),
  tool("skill.lifecycle", ["skill.manage"], ["skill.lifecycle"]),
  ...discordReadTools.map((name) => tool(name, ["network.access"], ["discord.read"], {
    approval: "not-required",
    ...(["discord.listChannels", "discord.readMessages"].includes(name) ? { safety: discordReadSafety } : {})
  })),
  ...discordMutationTools.map((name) => tool(name, ["network.access"], ["discord.write"], {
    approval: "required",
    ...(discordMutationSafety(name) ? { safety: discordMutationSafety(name) } : {}),
    approvalEffect: discordApprovalEffect(name)
  }))
] as const);

const capabilitySet = new Set<string>(CAPABILITY_IDS);
const toolCapabilities = new Map(TOOL_CAPABILITY_REGISTRY.map((entry) => [entry.tool, entry]));

export class CapabilityRegistryError extends Error {
  readonly code: "UNKNOWN_CAPABILITY" | "UNKNOWN_TOOL" | "INVALID_CAPABILITY_SET" | "CAPABILITY_ESCALATION";
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: CapabilityRegistryError["code"], message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CapabilityRegistryError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === "string" && capabilitySet.has(value);
}

export function assertCapabilityIds(value: unknown, label = "capabilities"): readonly CapabilityId[] {
  if (!Array.isArray(value) || value.length > 128 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new CapabilityRegistryError("INVALID_CAPABILITY_SET", `${label} must be an array of at most 128 non-empty capability identifiers`);
  }
  const result = [...new Set(value.map(String))].sort();
  const unknown = result.filter((item) => !isCapabilityId(item));
  if (unknown.length) {
    throw new CapabilityRegistryError("UNKNOWN_CAPABILITY", `unknown capability identifier: ${unknown.join(", ")}`, { unknown });
  }
  return Object.freeze(result as CapabilityId[]);
}

export function capabilitiesForTool(toolName: string): readonly CapabilityId[] {
  const entry = toolCapabilities.get(toolName);
  if (!entry) throw new CapabilityRegistryError("UNKNOWN_TOOL", `tool has no trusted capability declaration: ${toolName}`, { tool: toolName });
  return entry.capabilities;
}

export function legacyCapabilitiesForTool(toolName: string): readonly string[] {
  const entry = toolCapabilities.get(toolName);
  if (!entry) throw new CapabilityRegistryError("UNKNOWN_TOOL", `tool has no trusted capability declaration: ${toolName}`, { tool: toolName });
  return entry.legacyCapabilities;
}

export function approvalRequirementForTool(toolName: string): boolean | undefined {
  const approval = toolCapabilities.get(toolName)?.approval;
  return approval === undefined ? undefined : approval === "required";
}

export function safetyPolicyForTool(toolName: string): TrustedToolSafetyPolicy | undefined {
  return toolCapabilities.get(toolName)?.safety;
}

export function approvalEffectPolicyForTool(toolName: string): TrustedApprovalEffectPolicy | undefined {
  return toolCapabilities.get(toolName)?.approvalEffect;
}

export type CapabilityMigrationEntry = Readonly<{
  legacyCapability: string;
  disposition: "scoped";
  capabilities: readonly CapabilityId[];
  tools: readonly string[];
  automaticWidening: false;
}>;

export type CapabilityMigrationReport = Readonly<{
  registryVersion: 1;
  required: boolean;
  legacyCapabilities: readonly string[];
  entries: readonly CapabilityMigrationEntry[];
  automaticWidening: false;
}>;

export function migrateLegacyCapabilityPolicy(input: unknown, { versionless = false }: { versionless?: boolean } = {}): {
  allowedCapabilities: readonly CapabilityId[];
  scopedCapabilities: readonly CapabilityGrant[];
  report: CapabilityMigrationReport;
} {
  if (!Array.isArray(input)) throw new CapabilityRegistryError("INVALID_CAPABILITY_SET", "allowedCapabilities must be an array");
  const values = [...new Set(input.map((item) => String(item).trim()))].filter(Boolean).sort();
  const legacyAliases = new Set(TOOL_CAPABILITY_REGISTRY.flatMap((entry) => entry.legacyCapabilities));
  const isLegacy = (value: string) => !isCapabilityId(value) || (versionless && legacyAliases.has(value));
  const allowedCapabilities = values.filter((value) => !isLegacy(value)) as CapabilityId[];
  const legacyCapabilities = values.filter(isLegacy);
  const entries: CapabilityMigrationEntry[] = [];
  const scoped = new Map<string, CapabilityGrant>();
  for (const legacyCapability of legacyCapabilities) {
    const matches = TOOL_CAPABILITY_REGISTRY.filter((entry) => entry.legacyCapabilities.includes(legacyCapability));
    if (!matches.length) {
      throw new CapabilityRegistryError("UNKNOWN_CAPABILITY", `unknown capability identifier: ${legacyCapability}`, { unknown: [legacyCapability] });
    }
    const tools = [...new Set(matches.map((entry) => entry.tool))].sort();
    const capabilities = [...new Set(matches.flatMap((entry) => entry.capabilities))].sort() as CapabilityId[];
    for (const match of matches) for (const capability of match.capabilities) {
      scoped.set(`${match.tool}\0${capability}`, Object.freeze({ tool: match.tool, capability }));
    }
    entries.push(Object.freeze({
      legacyCapability,
      disposition: "scoped",
      capabilities: Object.freeze(capabilities),
      tools: Object.freeze(tools),
      automaticWidening: false
    }));
  }
  return {
    allowedCapabilities: Object.freeze([...allowedCapabilities].sort()),
    scopedCapabilities: Object.freeze([...scoped.values()].sort((left, right) => left.tool.localeCompare(right.tool) || left.capability.localeCompare(right.capability))),
    report: Object.freeze({
      registryVersion: CAPABILITY_REGISTRY_VERSION,
      required: entries.length > 0,
      legacyCapabilities: Object.freeze(legacyCapabilities),
      entries: Object.freeze(entries),
      automaticWidening: false
    })
  };
}

export function intersectChildCapabilities({
  parentCapabilities,
  requestedCapabilities,
  requestedTools
}: {
  parentCapabilities: unknown;
  requestedCapabilities: unknown;
  requestedTools: unknown;
}): readonly CapabilityId[] {
  const parent = new Set(assertCapabilityIds(parentCapabilities, "parentCapabilities"));
  const requested = assertCapabilityIds(requestedCapabilities, "requestedCapabilities");
  if (!Array.isArray(requestedTools) || requestedTools.length > 128 || requestedTools.some((item) => typeof item !== "string" || !item.trim())) {
    throw new CapabilityRegistryError("INVALID_CAPABILITY_SET", "requestedTools must be an array of at most 128 non-empty tool identifiers");
  }
  const declared = new Set<CapabilityId>();
  for (const toolName of [...new Set(requestedTools.map(String))]) {
    for (const capability of capabilitiesForTool(toolName)) declared.add(capability);
  }
  const outsideParent = requested.filter((capability) => !parent.has(capability));
  const outsideTools = requested.filter((capability) => !declared.has(capability));
  const missingForTools = [...declared].filter((capability) => !requested.includes(capability));
  if (outsideParent.length || outsideTools.length || missingForTools.length) {
    throw new CapabilityRegistryError("CAPABILITY_ESCALATION", "child capability request exceeds its parent or trusted tool declarations", {
      outsideParent,
      outsideTools,
      missingForTools
    });
  }
  return Object.freeze(requested.filter((capability) => parent.has(capability) && declared.has(capability)));
}
