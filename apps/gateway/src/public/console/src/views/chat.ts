import { renderMessageItem } from "../components/message-item.ts";
import type { ConsoleMessage, ElementLookup } from "../types.ts";

export function suggestedChatTitle(content: unknown): string {
  const title = String(content || "").replace(/^\s*[-*#>]+\s*/, "").replace(/\s+/g, " ").trim();
  return title.length > 38 ? title.slice(0, 35).trimEnd() + "..." : title;
}

export function renderChatMessages($: ElementLookup, messages: ConsoleMessage[], providerConfigured: boolean): void {
  const thread = $("chat-thread");
  if (!thread) return;
  if (!messages.length) {
    thread.innerHTML = '<div class="chat-empty"><div class="chat-avatar"><img src="/odinn-logo.png" alt=""></div><h1>Ódinn Forge</h1><span class="pill ' + (providerConfigured ? "" : "warn") + '">' + (providerConfigured ? "Provider connected" : "Connect a model provider") + "</span><p>" +
      (providerConfigured ? "Choose a model and send a message. Use Web tools when you need current information or work on a website." : "Run odinn onboard in a terminal, then refresh this page.") + "</p>" +
      (providerConfigured ? '<div class="chat-prompts"><button class="chat-prompt" data-chat-prompt="What can you do?">What can you do?</button><button class="chat-prompt" data-chat-prompt="Search the web for current information about Ódinn Forge.">Search the web</button><button class="chat-prompt" data-chat-prompt="Open the browser workspace and show me the current page.">Open browser workspace</button><button class="chat-prompt" data-chat-prompt="Summarize my recent activity and tasks.">Review recent activity</button></div>' : "") + "</div>";
    return;
  }
  thread.innerHTML = messages.map(renderMessageItem).join("");
  thread.scrollTop = thread.scrollHeight;
}
