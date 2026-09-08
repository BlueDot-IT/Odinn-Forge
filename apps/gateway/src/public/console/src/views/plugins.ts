import { escapeHtml } from "../components/message-item.ts";

export function pluginReadiness(plugin: any, doctor?: any): string {
  if (doctor?.ready === true) return "Ready";
  if (!plugin.reviewed) return "Needs review";
  if (!plugin.enabled) return "Disabled";
  return doctor ? "Enabled · needs setup" : "Enabled · runtime unchecked";
}

export function renderPluginCard(plugin: any, selected: boolean): string {
  return `<button class="item plugin-card${selected ? " selected" : ""}" data-plugin-select="${escapeHtml(plugin.manifest.id)}" type="button"><span class="item-line"><strong>${escapeHtml(plugin.manifest.name)}</strong><span class="chip">${escapeHtml(pluginReadiness(plugin))}</span></span><span>${escapeHtml(plugin.manifest.description)}</span><span class="muted">${escapeHtml(plugin.manifest.id)} · ${escapeHtml(plugin.manifest.version)}</span></button>`;
}

export function renderPluginChecks(report: any): string {
  return (report?.checks || []).map((check: any) => `<div class="item"><div class="item-line"><strong>${escapeHtml(check.detail)}</strong><span class="chip ${check.ok ? "ok" : "warn"}">${check.ok ? "Passed" : "Needs attention"}</span></div>${!check.ok && check.remediation ? `<p>${escapeHtml(check.remediation)}</p>` : ""}</div>`).join("") || '<p class="muted">Run setup checks to verify package, permissions, and runtime prerequisites.</p>';
}

export function formatPluginLiveResult(value: any): string {
  const execution = value?.result?.output ? value.result : value;
  const output = execution?.output;
  if (execution?.tool !== "mcp.invoke" || !output) return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const payload = output.result;
  const status = execution.ok === false || payload?.isError ? "Failed" : output.status === "completed" ? "Completed" : String(output.status || "Result unavailable");
  const texts = payload?.structuredContent !== undefined
    ? [JSON.stringify(payload.structuredContent, null, 2)]
    : (payload?.content || []).filter((item: any) => item.type === "text" && typeof item.text === "string").map((item: any) => {
      try { return JSON.stringify(JSON.parse(item.text), null, 2); } catch { return item.text; }
    });
  return `${output.toolName || "Plugin run"} · ${status} · live only\n\n${texts.join("\n\n") || "No live text result was returned."}`;
}

export function pluginJobRequest(snapshot: any, toolName: string, args: unknown): any {
  if (snapshot?.type !== "mcp.discovery" || !snapshot.extensionFingerprint || !snapshot.fingerprint) throw new Error("Discover this plugin again before requesting a run.");
  const tool = snapshot.tools?.find((item: any) => item.name === toolName);
  if (!tool || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("Select a discovered tool and provide object arguments.");
  return { task: { tool: "mcp.invoke", input: {
    serverId: snapshot.serverId, generation: snapshot.generation,
    snapshotFingerprint: snapshot.fingerprint, extensionFingerprint: snapshot.extensionFingerprint,
    toolName, toolSchemaFingerprint: tool.schemaFingerprint, arguments: args
  } } };
}

export function renderPluginToolFields(tool: any): string {
  const schema = tool?.inputSchema || {};
  return Object.entries(schema.properties || {}).map(([name, raw]: [string, any], index) => {
    const property = raw || {};
    const kind = property.type || "string";
    const required = (schema.required || []).includes(name) ? " required" : "";
    const label = property.title || name.replaceAll("_", " ");
    const attributes = `id="plugin-argument-${index}" data-plugin-argument="${escapeHtml(name)}" data-argument-type="${escapeHtml(kind)}"${required}`;
    const value = property.default === undefined ? "" : String(property.default);
    let input: string;
    if (Array.isArray(property.enum)) input = `<select ${attributes}><option value="">Choose…</option>${property.enum.map((item: any) => `<option value="${escapeHtml(JSON.stringify(item))}">${escapeHtml(String(item))}</option>`).join("")}</select>`;
    else if (kind === "boolean") input = `<select ${attributes}><option value="">Not set</option><option value="true">Yes</option><option value="false">No</option></select>`;
    else if (kind === "object" || kind === "array") input = `<textarea ${attributes} placeholder="${kind === "array" ? "[]" : "{}"}"></textarea>`;
    else input = `<input ${attributes} type="${kind === "number" || kind === "integer" ? "number" : "text"}"${kind === "number" ? ' step="any"' : ""} value="${escapeHtml(value)}"${typeof property.minimum === "number" ? ` min="${property.minimum}"` : ""}${typeof property.maximum === "number" ? ` max="${property.maximum}"` : ""}>`;
    return `<div class="field"><label for="plugin-argument-${index}">${escapeHtml(label)}${required ? " *" : ""}</label>${input}${property.description ? `<span class="muted">${escapeHtml(property.description)}</span>` : ""}</div>`;
  }).join("") || '<p class="muted">This tool does not require any inputs.</p>';
}

type PluginViewOptions = { api: (path: string, options?: RequestInit) => Promise<any>; onError: (message: string) => void };

export function mountPluginView(options: PluginViewOptions): { refresh: () => Promise<void> } {
  const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const root = element("view-plugins");
  const post = (path: string, body: unknown = {}) => options.api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let plugins: any[] = [];
  let selectedId = "";
  let writable = true;
  let maximumUpload = 40_000;
  let preview: { metadata: any; source: any } | undefined;
  let catalog: any;
  let snapshot: any;
  let jobId = "";
  let pendingInput: any;
  let poll: ReturnType<typeof setTimeout> | undefined;
  const selected = () => plugins.find((plugin) => plugin.manifest.id === selectedId);
  const result = (value: unknown) => { element("plugin-result").textContent = formatPluginLiveResult(value); };
  const message = (text: string) => { element("plugin-message").textContent = text; };
  const action = async (button: HTMLButtonElement | null, work: () => Promise<unknown>) => {
    if (button) button.disabled = true;
    try { message(""); await work(); }
    catch (error) { const text = error instanceof Error ? error.message : "Plugin operation failed."; message(text); options.onError(text); }
    finally { if (button?.isConnected) button.disabled = false; }
  };

  function renderList(): void {
    element("plugin-installed-count").textContent = `${plugins.length} installed`;
    element("plugin-list").innerHTML = plugins.map((plugin) => renderPluginCard(plugin, plugin.manifest.id === selectedId)).join("") || '<div class="empty-state"><strong>No plugins installed</strong><span>Inspect a package or browse a catalog to get started.</span></div>';
  }

  function renderDetail(): void {
    const plugin = selected();
    snapshot = undefined;
    element("plugin-tools").hidden = true;
    if (!plugin) { element("plugin-detail").innerHTML = '<div class="empty-state"><strong>Select an installed plugin</strong><span>Setup, access, and controls will appear here.</span></div>'; return; }
    const capabilities = [...new Set(["mcp.discover", ...(plugin.manifest.tools || []).flatMap((tool: any) => tool.capabilities)])] as string[];
    const services = plugin.manifest.services || [];
    const disabled = writable ? "" : " disabled";
    const serviceFields = services.map((service: any, index: number) => {
      const binding = plugin.serviceBindings?.[service.id];
      return `<div class="item"><label><input type="checkbox" data-plugin-service="${escapeHtml(service.id)}"${binding?.enabled ? " checked" : ""}${disabled}> Allow ${escapeHtml(service.id)}</label><p class="muted">${escapeHtml(service.origin)} · ${(service.paths || []).map(escapeHtml).join(", ")}</p>${service.credential ? `<div class="field"><label for="plugin-service-ref-${index}">Saved credential reference</label><input id="plugin-service-ref-${index}" data-plugin-service-ref="${escapeHtml(service.id)}" value="${escapeHtml(binding?.credentialRef || "")}" placeholder="env:SERVICE_TOKEN" autocomplete="off"${disabled}><span class="muted">Use an existing host-owned reference. Secret values are never entered here.</span></div>` : '<p class="muted">No account credential required.</p>'}</div>`;
    }).join("");
    element("plugin-detail").innerHTML = `<div class="panel-head"><div><h2>${escapeHtml(plugin.manifest.name)}</h2><p>${escapeHtml(plugin.manifest.description)}</p></div><span class="chip" id="plugin-readiness">${escapeHtml(pluginReadiness(plugin))}</span></div>
      <p class="muted">Version ${escapeHtml(plugin.manifest.version)} · Publisher identity unverified</p>
      <details><summary>Package identity and requested tools</summary><pre>${escapeHtml(JSON.stringify({ packageDigest: plugin.packageDigest, identityFingerprint: plugin.identityFingerprint, tools: plugin.manifest.tools }, null, 2))}</pre></details>
      <h3>1. Service setup</h3>${serviceFields || '<p class="muted">This plugin does not request service access.</p>'}<button type="button" class="secondary" data-plugin-action="configure"${disabled}>Save service setup</button>
      <h3>2. Access</h3><p class="muted">Select the access this version may request. Changes turn the plugin off and require a new review.</p><div class="stack">${capabilities.map((capability) => `<label><input type="checkbox" data-plugin-grant="${escapeHtml(capability)}"${plugin.grants?.includes(capability) ? " checked" : ""}${disabled}> ${escapeHtml(capability)}</label>`).join("")}</div><button type="button" class="secondary" data-plugin-action="grant"${disabled}>Save selected access</button>
      <h3>3. Review and activate</h3><p class="muted">Trust only a package whose source and requested access you have reviewed. A checksum verifies its contents, not its publisher. Tool calls still require approval.</p>
      <div class="row"><button type="button" class="secondary" data-plugin-action="review"${disabled}>Trust reviewed package</button><button type="button" data-plugin-action="enable"${disabled}${!plugin.reviewed || plugin.enabled ? " disabled" : ""}>Enable</button><button type="button" class="secondary" data-plugin-action="disable"${disabled}>Disable</button></div>
      <div class="row"><button type="button" class="secondary" data-plugin-action="doctor">Run setup checks</button><button type="button" class="secondary" data-plugin-action="discover"${!plugin.enabled ? " disabled" : ""}>Discover tools</button><button type="button" class="secondary" data-plugin-action="rollback"${disabled}>Roll back version</button><button type="button" class="danger-button" data-plugin-action="remove"${disabled}>Uninstall</button></div>
      <p class="muted">To update, inspect the new package above. Updates and rollback remain disabled until reviewed. Uninstall preserves user data.</p>
      <h3>Setup checks</h3><div id="plugin-checks">${renderPluginChecks(undefined)}</div>`;
  }

  async function refresh(): Promise<void> {
    let data: any;
    try { data = await options.api("/plugins"); }
    catch (error) {
      if (error instanceof Error && /hosted tenant plugin access/iu.test(error.message)) {
        writable = false; plugins = []; selectedId = "";
        element("plugin-local-owner").hidden = false;
        element("plugin-install-panel").hidden = true;
        renderList(); renderDetail(); return;
      }
      throw error;
    }
    plugins = data.plugins || [];
    writable = data.writable === true;
    maximumUpload = data.maxUploadBytes || maximumUpload;
    element("plugin-local-owner").hidden = writable;
    element("plugin-install-panel").hidden = !writable;
    element("plugin-upload-limit").textContent = `Archive uploads up to ${Math.floor(maximumUpload / 1024)} KiB; larger packages can be selected by workspace path.`;
    if (!selected()) selectedId = plugins[0]?.manifest.id || "";
    renderList(); renderDetail();
  }

  async function inspect(source: any): Promise<void> {
    const data = await post("/plugins/inspect", source);
    preview = { source, metadata: data.metadata };
    const manifest = preview.metadata.manifest;
    element("plugin-preview").hidden = false;
    element("plugin-preview-title").textContent = `${manifest.name} · ${manifest.version}`;
    element("plugin-preview-description").textContent = manifest.description;
    element("plugin-preview-data").textContent = JSON.stringify({ packageDigest: preview.metadata.digest, files: preview.metadata.files, services: manifest.services, tools: manifest.tools, publisherVerification: "not-verified" }, null, 2);
    element("plugin-install").textContent = plugins.some((plugin) => plugin.manifest.id === manifest.id) ? "Update to this package" : "Install disabled";
  }

  async function refreshPending(): Promise<void> {
    const values = await options.api("/approvals");
    const approvals = (Array.isArray(values) ? values : values.approvals || []).filter((approval: any) => approval.tool === "mcp.invoke" && (!selectedId || approval.input?.serverId === selectedId || approval.resource?.serverId === selectedId || approval.effect?.server === selectedId));
    element("plugin-approvals").innerHTML = approvals.map((approval: any) => `<div class="item"><strong>Review this tool run</strong><pre>${escapeHtml(JSON.stringify({ summary: approval.summary, input: approval.runId === jobId ? pendingInput : approval.input, effect: approval.effect }, null, 2))}</pre><div class="row"><button type="button" data-plugin-approval="${escapeHtml(approval.id)}">Allow once and show result</button><button type="button" class="secondary" data-plugin-deny="${escapeHtml(approval.id)}">Deny</button></div></div>`).join("") || '<p class="muted">No pending plugin approvals.</p>';
    if (jobId) {
      const job = await options.api(`/jobs/${encodeURIComponent(jobId)}`);
      element("plugin-job-status").textContent = `Run ${job.id}: ${job.status}. Saved runs contain status only; service responses are shown live when approved.`;
    }
  }

  root.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!button || button.disabled || button.type === "submit") return;
    if (button.dataset.pluginSelect) { selectedId = button.dataset.pluginSelect; renderList(); renderDetail(); return; }
    void action(button, async () => {
      if (button.id === "plugin-refresh") return refresh();
      if (button.id === "plugin-inspect") {
        const file = element<HTMLInputElement>("plugin-file").files?.[0];
        const path = element<HTMLInputElement>("plugin-package-path").value.trim();
        if (Boolean(file) === Boolean(path)) throw new Error("Select one archive file or one workspace package path.");
        if (file) {
          if (!file.size || file.size > maximumUpload) throw new Error("This archive exceeds the upload limit. Put it in the workspace and use its path.");
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
          return inspect({ archiveBase64: btoa(binary) });
        }
        return inspect({ path });
      }
      if (button.id === "plugin-catalog-browse") {
        const source = element<HTMLInputElement>("plugin-catalog-source").value.trim();
        catalog = (await options.api(`/plugins/catalog?source=${encodeURIComponent(source)}`)).catalog;
        element("plugin-catalog-list").innerHTML = catalog.plugins.map((entry: any, index: number) => `<div class="item"><strong>${escapeHtml(entry.name)} · ${escapeHtml(entry.version)}</strong><p>${escapeHtml(entry.description)}</p><span class="muted">Publisher unverified · SDK ${escapeHtml(entry.sdkVersion)}</span><button type="button" class="secondary" data-plugin-catalog-index="${index}">Inspect package</button></div>`).join("") || '<p class="muted">This catalog has no compatible packages.</p>';
        return;
      }
      if (button.dataset.pluginCatalogIndex !== undefined) {
        const entry = catalog.plugins[Number(button.dataset.pluginCatalogIndex)];
        return inspect({ catalogSource: catalog.source, id: entry.id, version: entry.version, expectedDigest: entry.digest });
      }
      if (button.id === "plugin-install") {
        if (!preview) throw new Error("Inspect a package first.");
        const current = plugins.find((plugin) => plugin.manifest.id === preview!.metadata.manifest.id);
        const installed = await post("/plugins", { ...preview.source, expectedDigest: preview.metadata.digest, expectedIdentityFingerprint: current?.identityFingerprint });
        selectedId = installed.plugin.manifest.id;
        preview = undefined; element("plugin-preview").hidden = true;
        await refresh(); message("Package installed disabled. Complete service setup, access, and review."); return;
      }
      if (button.dataset.pluginApproval || button.dataset.pluginDeny) {
        const id = button.dataset.pluginApproval || button.dataset.pluginDeny;
        const approved = Boolean(button.dataset.pluginApproval);
        const response = await post(`/approvals/${encodeURIComponent(id!)}/${approved ? "approve" : "deny"}`);
        if (approved) result(response);
        await refreshPending(); return;
      }
      if (button.id === "plugin-refresh-pending") return refreshPending();
      if (button.id === "plugin-clear-result") { result("Live results cleared."); return; }
      const operation = button.dataset.pluginAction;
      if (!operation) return;
      const plugin = selected();
      if (!plugin) throw new Error("Select a plugin first.");
      if (operation === "doctor") {
        const data = await options.api(`/plugins/doctor?id=${encodeURIComponent(selectedId)}`);
        const report = data.checks.find((item: any) => item.id === selectedId);
        element("plugin-checks").innerHTML = renderPluginChecks(report);
        element("plugin-readiness").textContent = pluginReadiness(plugin, report); return;
      }
      if (operation === "discover") {
        const data = await post(`/plugins/${encodeURIComponent(selectedId)}/discover`);
        snapshot = data.output || data;
        if (snapshot.type !== "mcp.discovery") { result(data); throw new Error("Discovery was not admitted. Check policy, permissions, and runtime setup."); }
        element<HTMLSelectElement>("plugin-tool").innerHTML = snapshot.tools.map((tool: any) => `<option value="${escapeHtml(tool.name)}">${escapeHtml(tool.name)}</option>`).join("");
        element("plugin-tools").hidden = false;
        renderArguments(); return;
      }
      if (operation === "remove" && !window.confirm("Uninstall this plugin? New calls will be blocked; user data is preserved.")) return;
      if (operation === "rollback" && !window.confirm("Restore the previous package version? It will remain disabled until setup and review are complete.")) return;
      const body: any = { action: operation, expectedIdentityFingerprint: plugin.identityFingerprint };
      if (operation === "grant") body.grants = Array.from(root.querySelectorAll<HTMLInputElement>("[data-plugin-grant]:checked")).map((input) => input.dataset.pluginGrant!);
      if (operation === "configure") {
        body.serviceBindings = Object.fromEntries(Array.from(root.querySelectorAll<HTMLInputElement>("[data-plugin-service]")).map((input) => {
          const reference = Array.from(root.querySelectorAll<HTMLInputElement>("[data-plugin-service-ref]")).find((field) => field.dataset.pluginServiceRef === input.dataset.pluginService)?.value.trim();
          return [input.dataset.pluginService!, { enabled: input.checked, ...(reference ? { credentialRef: reference } : {}) }];
        }));
      }
      await post(`/plugins/${encodeURIComponent(selectedId)}/lifecycle`, body);
      await refresh(); message(operation === "enable" ? "Plugin enabled. Run setup checks before using its tools." : "Plugin state updated.");
    });
  });

  function renderArguments(): void {
    const tool = snapshot?.tools.find((item: any) => item.name === element<HTMLSelectElement>("plugin-tool").value);
    element("plugin-tool-fields").innerHTML = renderPluginToolFields(tool);
  }
  element("plugin-tool").addEventListener("change", renderArguments);
  element<HTMLFormElement>("plugin-run-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void action(element<HTMLButtonElement>("plugin-run"), async () => {
      const args = Object.fromEntries(Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-plugin-argument]")).filter((input) => input.value !== "").map((input) => {
        const kind = input.dataset.argumentType;
        const value = input instanceof HTMLSelectElement || ["object", "array", "boolean", "integer", "number"].includes(kind || "") ? JSON.parse(input.value) : input.value;
        return [input.dataset.pluginArgument!, value];
      }));
      const request = pluginJobRequest(snapshot, element<HTMLSelectElement>("plugin-tool").value, args);
      const response = await post("/jobs", request);
      pendingInput = request.task.input;
      jobId = response.job?.id || "";
      message("Run requested. Review the exact approval below before allowing it.");
      await refreshPending();
      clearTimeout(poll);
      poll = setTimeout(() => { void refreshPending().catch((error) => message(error.message)); }, 1200);
    });
  });
  return { refresh };
}
