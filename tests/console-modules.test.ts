import assert from "node:assert/strict";
import test from "node:test";

import { renderApproval } from "../apps/gateway/src/public/console/src/views/approvals.ts";
import { auditFacetLabel } from "../apps/gateway/src/public/console/src/views/audit.ts";
import { suggestedChatTitle } from "../apps/gateway/src/public/console/src/views/chat.ts";
import { relativeTime, renderSessionRow } from "../apps/gateway/src/public/console/src/views/sessions.ts";
import { cloneConfig, configLines, configNumber, renderOptions } from "../apps/gateway/src/public/console/src/views/settings.ts";
import { renderMarkdown, renderMessageItem, safeHref } from "../apps/gateway/src/public/console/src/components/message-item.ts";
import { renderToolCall, toolCallStatus } from "../apps/gateway/src/public/console/src/components/tool-call.ts";

test("chat and message components preserve safe rendering behavior", () => {
  assert.equal(suggestedChatTitle("  # A   concise   title  "), "A concise title");
  assert.equal(safeHref("javascript:alert(1)"), "#");
  assert.match(renderMarkdown("**safe** <script>"), /<strong>safe<\/strong> &lt;script&gt;/u);
  assert.match(renderMessageItem({ role: "assistant", content: "hello", provider: "local", model: "test" }), /local:test/u);
});

test("session, settings, approval, audit, and tool modules expose deterministic projections", () => {
  assert.equal(relativeTime("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T00:01:00.000Z")), "1m ago");
  assert.match(renderSessionRow({ id: "session-1", title: "Work" }, true), /data-session-id="session-1"/u);
  const source = { nested: { enabled: true } };
  const cloned = cloneConfig(source);
  cloned.nested.enabled = false;
  assert.equal(source.nested.enabled, true);
  assert.deepEqual(configLines(" one\n\n two "), ["one", "two"]);
  assert.equal(configNumber("12", 1), 12);
  assert.match(renderOptions(["safe"], "safe"), /selected/u);
  assert.match(renderApproval({ id: "approval-1", tool: "workspace.write", effect: { summary: "Write a file" } }, String), /Allow once/u);
  assert.equal(auditFacetLabel("outcome", "failed"), "Needs attention");
  assert.equal(toolCallStatus({ tool: "workspace.read" }), "Running workspace.read");
  assert.match(renderToolCall({ tool: "workspace.read", status: "running" }), /role="status"/u);
});
