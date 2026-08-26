import { escapeHtml } from "../components/message-item.ts";
import type { AgentGraphRun } from "../types.ts";
import { relativeTime } from "./sessions.ts";

const activeStatuses = new Set(["validated", "running", "publishing"]);
const incompleteStatuses = new Set(["failed", "cancelled", "needs-review"]);

export function isAgentGraphActive(status: string): boolean {
  return activeStatuses.has(status);
}

export function canReassignAgentGraph(status: string): boolean {
  return incompleteStatuses.has(status);
}

export function agentGraphStatusLabel(status: string): string {
  if (status === "needs-review") return "Needs review";
  if (status === "validated") return "Queued";
  if (status === "publishing") return "Collecting results";
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : "Unknown";
}

export function agentGraphStatusClass(status: string): string {
  if (status === "completed") return "ok";
  if (isAgentGraphActive(status)) return "warn";
  if (incompleteStatuses.has(status)) return "danger";
  return "";
}

export function renderAgentGraphRow(graph: AgentGraphRun, selected: boolean, now = Date.now()): string {
  const completed = graph.nodes.filter((node) => node.status === "completed").length;
  return '<button class="agent-graph-row' + (selected ? " selected" : "") + '" data-agent-graph-id="' + escapeHtml(graph.graphRunId) + '" type="button">' +
    '<span class="data-primary"><strong>' + escapeHtml(graph.graphRunId) + '</strong><small>Parent ' + escapeHtml(graph.parentRunId) + '</small></span>' +
    '<span class="chip ' + agentGraphStatusClass(graph.status) + '">' + escapeHtml(agentGraphStatusLabel(graph.status)) + '</span>' +
    '<span>' + escapeHtml(completed + "/" + graph.nodes.length) + '</span>' +
    '<span class="muted">' + escapeHtml(relativeTime(graph.completedAt || graph.startedAt || graph.createdAt, now)) + '</span>' +
  '</button>';
}

export function renderAgentGraphDetail(graph: AgentGraphRun): string {
  const nodes = graph.nodes.map((node) =>
    '<div class="timeline-row"><span class="timeline-dot"></span><div class="item"><div class="item-line"><strong>' + escapeHtml(node.nodeId) + '</strong><span class="chip ' + agentGraphStatusClass(node.status) + '">' + escapeHtml(agentGraphStatusLabel(node.status)) + '</span></div>' +
    '<div class="muted">Manifest ' + escapeHtml(node.manifestId) + (node.resultRef ? ' · Result ' + escapeHtml(node.resultRef) : "") + '</div>' +
    (node.errorCode ? '<div class="result-summary error">' + escapeHtml(node.errorCode) + '</div>' : "") +
    '</div></div>'
  ).join("");
  return '<div class="record-grid agent-graph-summary">' +
    '<div class="item"><strong>Parent run</strong><span>' + escapeHtml(graph.parentRunId) + '</span></div>' +
    '<div class="item"><strong>Budget</strong><span>' + escapeHtml(graph.maxConcurrency + " concurrent · " + graph.maxRunMs + " ms") + '</span></div>' +
    '<div class="item"><strong>Request digest</strong><span class="code-inline">' + escapeHtml(graph.requestDigest) + '</span></div>' +
    '<div class="item"><strong>Terminal reason</strong><span>' + escapeHtml(graph.errorCode || (graph.status === "completed" ? "Completed" : "None recorded")) + '</span></div>' +
    '</div><div class="timeline agent-graph-nodes">' + (nodes || '<div class="empty-state"><strong>No child nodes</strong><span>This graph has no recorded child sessions.</span></div>') + '</div>';
}
