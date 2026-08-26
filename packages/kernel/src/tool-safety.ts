import { safetyPolicyForTool } from "@odinn/policy";

const READ_TOOLS = new Set(["job.healthcheck", "text.echo", "workspace.readText", "workspace.list", "workspace.stat", "workspace.search", "workspace.read", "workspace.diff", "web.search", "web.fetch", "browser.tabs", "browser.open", "browser.snapshot", "browser.recovery.status", "email.accounts", "email.search", "email.read", "email.thread", "github.repository", "github.issue", "github.pull-request", "github.checks", "memory.search", "memory.recall", "memory.browse", "memory.open", "memory.curate", "session.list", "session.read", "project.list", "goal.list", "improve.list", "mcp.discover", "skill.catalog", "skill.hydrate"]);
const WRITE_TOOLS = new Set(["memory.remember", "memory.suggest", "memory.decide", "memory.compact", "memory.correct", "memory.forget", "session.create", "session.message", "session.rename", "session.assign", "session.update", "session.delete", "project.create", "project.update", "goal.create", "goal.update", "improve.propose", "improve.learn", "improve.decide", "improve.rollback"]);
const GOVERNED_WORKSPACE_WRITE_TOOLS = new Set(["workspace.mutate", "workspace.patch", "restore.create", "restore.apply", "snapshot.create", "snapshot.restore"]);
const RETRY_SAFE_TOOLS = new Set(["job.healthcheck", "text.echo", "workspace.readText", "workspace.list", "workspace.stat", "workspace.search", "workspace.read", "workspace.diff", "web.search", "web.fetch", "memory.search", "memory.recall", "memory.browse", "memory.open", "memory.curate", "session.list", "session.read", "project.list", "goal.list", "improve.list", "mcp.discover", "skill.catalog", "skill.hydrate"]);

export type ToolEffect = "read" | "filesystem-write" | "process" | "network" | "credential" | "external-state";
export type Reversibility = "pure" | "snapshot-reversible" | "compensatable" | "irreversible";

export interface ToolSafetyDescriptor {
  toolName: string;
  effects: ToolEffect[];
  reversibility: Reversibility;
  requiresCapability: boolean;
  requiresApproval: boolean;
  retrySafe: boolean;
}

export function toolSafetyDescriptor(toolName: unknown, tool: unknown): ToolSafetyDescriptor {
  const name = String(toolName || "unknown");
  if (!tool) return { toolName: name, effects: ["read", "filesystem-write", "process", "network", "credential", "external-state"], reversibility: "irreversible", requiresCapability: true, requiresApproval: true, retrySafe: false };
  const trusted = safetyPolicyForTool(name);
  if (trusted) return { toolName: name, effects: [...trusted.effects], reversibility: trusted.reversibility, requiresCapability: trusted.requiresCapability, requiresApproval: trusted.requiresApproval, retrySafe: trusted.retrySafe };
  if (["browser.click", "browser.type", "browser.press"].includes(name)) return { toolName: name, effects: ["network", "credential", "external-state"], reversibility: "irreversible", requiresCapability: true, requiresApproval: true, retrySafe: false };
  if (name === "model.chat" || name === "agent.run") return { toolName: name, effects: ["network", "credential"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: false };
  if (name === "agent.delegate") return { toolName: name, effects: ["network", "credential"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: false };
  if (name === "process.exec") return { toolName: name, effects: ["process"], reversibility: "irreversible", requiresCapability: true, requiresApproval: true, retrySafe: false };
  if (name === "mcp.invoke") return { toolName: name, effects: ["network", "external-state"], reversibility: "irreversible", requiresCapability: true, requiresApproval: true, retrySafe: false };
  if (name === "skill.install" || name === "skill.lifecycle") return { toolName: name, effects: ["filesystem-write"], reversibility: "snapshot-reversible", requiresCapability: true, requiresApproval: true, retrySafe: false };
  if (GOVERNED_WORKSPACE_WRITE_TOOLS.has(name)) return { toolName: name, effects: ["filesystem-write"], reversibility: "snapshot-reversible", requiresCapability: true, requiresApproval: false, retrySafe: false };
  if (READ_TOOLS.has(name)) return { toolName: name, effects: name.startsWith("github.") ? ["read", "network", "credential"] : name.startsWith("web.") || name.startsWith("browser.") || name === "mcp.discover" ? ["read", "network"] : ["read"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: RETRY_SAFE_TOOLS.has(name) || name.startsWith("github.") };
  if (WRITE_TOOLS.has(name)) return { toolName: name, effects: ["filesystem-write"], reversibility: "snapshot-reversible", requiresCapability: true, requiresApproval: false, retrySafe: false };
  return { toolName: name, effects: ["read", "filesystem-write", "process", "network", "credential", "external-state"], reversibility: "irreversible", requiresCapability: true, requiresApproval: true, retrySafe: false };
}
