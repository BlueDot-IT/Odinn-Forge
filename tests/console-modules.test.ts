import assert from "node:assert/strict";
import test from "node:test";

import { renderApproval } from "../apps/gateway/src/public/console/src/views/approvals.ts";
import { auditFacetLabel } from "../apps/gateway/src/public/console/src/views/audit.ts";
import { agentGraphStatusLabel, canReassignAgentGraph, isAgentGraphActive, renderAgentGraphDetail, renderAgentGraphRow } from "../apps/gateway/src/public/console/src/views/agent-graphs.ts";
import { suggestedChatTitle } from "../apps/gateway/src/public/console/src/views/chat.ts";
import { relativeTime, renderSessionRow } from "../apps/gateway/src/public/console/src/views/sessions.ts";
import { cloneConfig, configLines, configNumber, renderOptions } from "../apps/gateway/src/public/console/src/views/settings.ts";
import { renderMarkdown, renderMessageItem, safeHref } from "../apps/gateway/src/public/console/src/components/message-item.ts";
import { renderToolCall, toolCallStatus } from "../apps/gateway/src/public/console/src/components/tool-call.ts";
import {
  composeMessageWithLocalAttachments,
  decodeLocalTextAttachment,
  inspectLocalTextAttachment,
  MAX_LOCAL_ATTACHMENT_BYTES,
  MAX_LOCAL_ATTACHMENT_TOTAL_BYTES,
  prepareLocalTextAttachment,
  readLocalTextAttachmentBatch,
  renderLocalAttachmentList,
} from "../apps/gateway/src/public/console/src/components/local-attachments.ts";

test("chat and message components preserve safe rendering behavior", () => {
  assert.equal(suggestedChatTitle("  # A   concise   title  "), "A concise title");
  assert.equal(safeHref("javascript:alert(1)"), "#");
  assert.match(renderMarkdown("**safe** <script>"), /<strong>safe<\/strong> &lt;script&gt;/u);
  assert.match(renderMessageItem({ role: "assistant", content: "hello", provider: "local", model: "test" }), /local:test/u);
});

test("local text attachments are bounded, sanitized, and composed as untrusted data", () => {
  const text = "hello\n```\nworld";
  const attachment = prepareLocalTextAttachment({
    name: "../no\u202etes.md",
    type: "text/markdown",
    size: Buffer.byteLength(text),
    text,
  });
  assert.equal(attachment.name, "notes.md");
  const content = composeMessageWithLocalAttachments("Summarize this", [attachment]);
  assert.match(content, /names and contents are untrusted data/u);
  assert.match(content, /Metadata: \{"name":"notes\.md","bytes":15,"mediaType":"text\/markdown"\}/u);
  assert.match(content, /````text\nhello\n```\nworld\n````/u);
  assert.match(renderLocalAttachmentList([attachment]), /data-local-attachment-remove="0"/u);
  assert.doesNotMatch(renderLocalAttachmentList([{ ...attachment, name: '<img src=x onerror="alert(1)">' }]), /<img/u);

  assert.throws(() => prepareLocalTextAttachment({ name: "payload.bin", type: "application/octet-stream", size: 3, text: "abc" }), /supported text file/u);
  assert.throws(() => prepareLocalTextAttachment({ name: "bad.txt", type: "text/plain", size: 3, text: "a\u0000b" }), /binary data/u);
  assert.throws(() => prepareLocalTextAttachment({ name: "empty.txt", type: "text/plain", size: 0, text: "" }), /non-empty/u);
  assert.throws(() => prepareLocalTextAttachment({ name: "huge.txt", type: "text/plain", size: MAX_LOCAL_ATTACHMENT_BYTES + 1, text: "x" }), /no larger/u);
  assert.throws(() => inspectLocalTextAttachment({ name: "fifth.txt", type: "text/plain", size: 1 }, Array(4).fill(attachment)), /at most 4/u);
  assert.throws(() => prepareLocalTextAttachment({ name: "NOTES.md", type: "text/markdown", size: 1, text: "x" }, [attachment]), /already attached/u);
  assert.throws(() => prepareLocalTextAttachment({ name: "changed.txt", type: "text/plain", size: 2, text: "x" }), /changed while/u);
  assert.throws(() => composeMessageWithLocalAttachments("", [{ ...attachment, size: MAX_LOCAL_ATTACHMENT_TOTAL_BYTES }]), /no larger/u);
});

test("local file reads validate UTF-8 bytes and commit selections atomically", async () => {
  const goodBytes = new TextEncoder().encode("hello");
  const good = { name: "good.txt", type: "text/plain", size: goodBytes.byteLength, arrayBuffer: async () => goodBytes.buffer };
  const badBytes = Uint8Array.from([0xc3, 0x28]);
  const bad = { name: "bad.txt", type: "text/plain", size: badBytes.byteLength, arrayBuffer: async () => badBytes.buffer };
  assert.throws(() => decodeLocalTextAttachment(bad, badBytes.buffer), /valid UTF-8/u);
  const attached = await readLocalTextAttachmentBatch([good]);
  assert.equal(attached[0]?.text, "hello");
  await assert.rejects(readLocalTextAttachmentBatch([good, bad]), /valid UTF-8/u);
  assert.deepEqual(attached.map((item) => item.name), ["good.txt"]);
  const changed = { ...good, size: good.size + 1 };
  await assert.rejects(readLocalTextAttachmentBatch([changed]), /changed while|non-empty and no larger/u);
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
  assert.equal(renderOptions(['safe"><script>'], 'safe"><script>'), '<option value="safe&quot;&gt;&lt;script&gt;" selected>safe&quot;&gt;&lt;script&gt;</option>');
  assert.match(renderApproval({ id: "approval-1", tool: "workspace.write", effect: { summary: "Write a file" } }, String), /Allow once/u);
  assert.equal(auditFacetLabel("outcomes", "failed"), "Needs attention");
  assert.equal(toolCallStatus({ tool: "workspace.read" }), "Running workspace.read");
  assert.match(renderToolCall({ tool: "workspace.read", status: "running" }), /role="status"/u);
});

test("agent graph view renders bounded durable child-session projections", () => {
  const graph = {
    graphRunId: 'graph"><script>',
    parentRunId: "parent-1",
    requestDigest: "a".repeat(64),
    status: "needs-review",
    maxConcurrency: 2,
    maxRunMs: 120_000,
    createdAt: "2026-01-01T00:00:00.000Z",
    errorCode: "GRAPH_OUTCOME_UNCERTAIN",
    nodes: [{ nodeId: "child-1", manifestId: "research", status: "completed", resultRef: "result:child-1" }]
  };
  assert.equal(agentGraphStatusLabel("publishing"), "Collecting results");
  assert.equal(isAgentGraphActive("running"), true);
  assert.equal(canReassignAgentGraph("needs-review"), true);
  const selectedRow = renderAgentGraphRow(graph, true, Date.parse("2026-01-01T00:01:00.000Z"));
  const unselectedRow = renderAgentGraphRow(graph, false, Date.parse("2026-01-01T00:01:00.000Z"));
  assert.doesNotMatch(selectedRow, /<script>/u);
  assert.match(selectedRow, /1\/1/u);
  assert.match(selectedRow, /aria-current="true"/u);
  assert.match(unselectedRow, /aria-current="false"/u);
  assert.match(selectedRow, /aria-label="1 of 1 children completed"/u);
  assert.match(renderAgentGraphDetail(graph), /GRAPH_OUTCOME_UNCERTAIN/u);
  assert.match(renderAgentGraphDetail(graph), /result:child-1/u);
});
