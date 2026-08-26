import { escapeHtml } from "../components/message-item.ts";

export function renderApproval(approval: any, friendlyArea: (value: unknown) => string): string {
  const effectSummary = approval.effect?.summary || "Review the bounded effect details before deciding.";
  return '<div class="item approval-card"><div class="item-line"><strong>' + escapeHtml(friendlyArea(approval.tool || "browser action")) + '</strong><span class="chip warn">waiting for you</span></div><div class="approval-summary">' + escapeHtml(effectSummary) + '</div><div class="row"><span class="muted">This permission will be used once.</span><button data-approve-id="' + escapeHtml(approval.id) + '" data-approval-action="approve" type="button">Allow once</button><button class="secondary" data-approve-id="' + escapeHtml(approval.id) + '" data-approval-action="deny" type="button">Deny</button></div></div>';
}
