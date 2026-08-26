import { escapeHtml } from "./message-item.ts";

export type ToolCallProgress = { message?: string; tool?: string; status?: string; terminalReason?: string };

export function toolCallStatus(progress: ToolCallProgress): string {
  return String(progress.message || progress.terminalReason || progress.status || (progress.tool ? `Running ${progress.tool}` : "Working…"));
}

export function renderToolCall(progress: ToolCallProgress): string {
  const label = toolCallStatus(progress);
  return '<div class="tool-call" role="status"><strong>' + escapeHtml(progress.tool || "Tool activity") + "</strong><span>" + escapeHtml(label) + "</span></div>";
}
