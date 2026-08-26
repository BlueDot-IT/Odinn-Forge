import type { ConsoleMessage } from "../types.ts";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeHref(value: unknown): string {
  const raw = String(value || "").trim();
  if (/^(https?:|mailto:)/i.test(raw) || raw.startsWith("/")) return raw;
  return "#";
}

function markdownInline(value: unknown): string {
  let text = escapeHtml(value);
  const code: string[] = [];
  const codeSpan = new RegExp(String.fromCharCode(96) + "([^" + String.fromCharCode(96) + "\n]+)" + String.fromCharCode(96), "g");
  text = text.replace(codeSpan, (_, content) => {
    const key = "ODINNCODE" + code.length + "";
    code.push("<code>" + content + "</code>");
    return key;
  });
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, alt, _href, title) => {
    const label = alt || "Image";
    return '<span class="markdown-image-alt" role="img" aria-label="' + label + '"' + (title ? ' title="' + title + '"' : "") + ">[Image: " + label + "]</span>";
  });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, label, href, title) => '<a href="' + escapeHtml(safeHref(href)) + '" target="_blank" rel="noreferrer noopener"' + (title ? ' title="' + title + '"' : "") + ">" + label + "</a>");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  text = text.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
  return text.replace(/ODINNCODE(\d+)/g, (_, index) => code[Number(index)] || "");
}

export function renderMarkdown(source: unknown): string {
  const lines = String(source ?? "").replaceAll("\r", "").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { type: "ol" | "ul" } | null = null;
  let code: { lang: string; lines: string[] } | null = null;
  const flushParagraph = () => { if (paragraph.length) { out.push("<p>" + markdownInline(paragraph.join(" ")) + "</p>"); paragraph = []; } };
  const closeList = () => { if (list) { out.push("</" + list.type + ">"); list = null; } };
  for (const line of lines) {
    const fence = line.match(new RegExp("^\\s*" + String.fromCharCode(96).repeat(3) + "(.*)$"));
    if (fence) {
      flushParagraph(); closeList();
      if (!code) code = { lang: fence[1].trim(), lines: [] };
      else { out.push('<pre><code class="language-' + escapeHtml(code.lang || "text") + '">' + escapeHtml(code.lines.join("\n")) + "</code></pre>"); code = null; }
      continue;
    }
    if (code) { code.lines.push(line); continue; }
    if (!line.trim()) { flushParagraph(); closeList(); continue; }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { flushParagraph(); closeList(); const level = heading[1].length; out.push("<h" + level + ">" + markdownInline(heading[2]) + "</h" + level + ">"); continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flushParagraph(); closeList(); out.push("<hr>"); continue; }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) { flushParagraph(); closeList(); out.push("<blockquote>" + markdownInline(quote[1]) + "</blockquote>"); continue; }
    const item = line.match(/^\s*([-+*]|\d+\.)\s+(.*)$/);
    if (item) {
      flushParagraph(); const type = /\d+\./.test(item[1]) ? "ol" : "ul";
      if (!list || list.type !== type) { closeList(); list = { type }; out.push("<" + type + ">"); }
      let content = item[2]; const task = content.match(/^\[([ xX])\]\s+(.*)$/);
      content = task ? '<span class="task-list-item"><input type="checkbox" disabled' + (task[1].toLowerCase() === "x" ? " checked" : "") + ">" + markdownInline(task[2]) + "</span>" : markdownInline(content);
      out.push("<li>" + content + "</li>"); continue;
    }
    closeList(); paragraph.push(line.trim());
  }
  flushParagraph(); closeList();
  if (code) out.push('<pre><code class="language-' + escapeHtml(code.lang || "text") + '">' + escapeHtml(code.lines.join("\n")) + "</code></pre>");
  return out.join("") || '<p class="muted">No content.</p>';
}

export function renderMessageItem(message: ConsoleMessage): string {
  const route = message.provider && message.model ? '<span class="chip ok">' + escapeHtml(message.provider + ":" + message.model) + "</span>" : "";
  return '<div class="message ' + escapeHtml(message.role) + '"><div class="message-role">' +
    (message.role === "assistant" ? '<span class="message-assistant-head"><span class="message-avatar"><img src="/odinn-logo.png" alt=""></span><span>Ódinn Forge</span></span>' : escapeHtml(message.role)) + route +
    '</div><div class="markdown-body">' + renderMarkdown(message.content) + "</div></div>";
}
