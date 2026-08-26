import { escapeHtml } from "../components/message-item.ts";
import type { ConsoleSession } from "../types.ts";

export function relativeTime(value: unknown, now = Date.now()): string {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "—";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return seconds + "s ago";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
  return Math.floor(seconds / 86400) + "d ago";
}

export function renderSessionRow(session: ConsoleSession, selected: boolean): string {
  return '<div class="item clickable' + (selected ? " selected" : "") + '" role="button" tabindex="0" data-session-id="' + escapeHtml(session.id) + '"><div class="item-line"><strong>' + escapeHtml(session.title || "Untitled session") + '</strong><span class="muted">' + escapeHtml(relativeTime(session.updatedAt || session.createdAt)) + "</span></div></div>";
}
