import { $ } from "./dom.js";
import { state } from "./state.js";

export async function api(path, options) {
      const response = await fetch(path, options);
      if (response.headers.get("x-odinn-hosted") === "true") {
        state.hosted = true;
        state.hostUser = response.headers.get("x-odinn-host-user") || "";
        $("remote-signout").hidden = false;
        $("gateway-context").textContent = state.hostUser ? "Remote tenant · " + state.hostUser : "Remote tenant gateway";
      }
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || response.statusText);
      return data;
    }
export async function streamApi(path, options, onDelta, onProgress = () => {}) {
      const response = await fetch(path, options);
      if (!response.ok || !response.body) throw new Error(response.statusText || "stream request failed");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = /^event:\s*(.+)$/mu.exec(block)?.[1] || "message";
          const raw = /^data:\s*(.+)$/mu.exec(block)?.[1] || "{}";
          const value = JSON.parse(raw);
          if (event === "delta") onDelta(value.delta || "");
          if (event === "progress") onProgress(value);
          if (event === "result") result = value;
          if (event === "error") throw new Error(value.error || "stream failed");
        }
      }
      if (!result) throw new Error("stream ended without a result");
      return result;
    }
