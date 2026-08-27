import { $ } from "./dom.ts";
import { api, streamApi } from "./api.ts";
import { state } from "./state.ts";
import { renderChatMessages as renderChatMessagesView, suggestedChatTitle as suggestedChatTitleView } from "./views/chat.ts";
import { renderApproval as renderApprovalView } from "./views/approvals.ts";
import { renderToolCall, toolCallStatus } from "./components/tool-call.ts";
import { closeDialog, openDialog } from "./components/dialog.ts";
import { escapeHtml, renderMarkdown, safeHref } from "./components/message-item.ts";
import { relativeTime as sessionRelativeTime } from "./views/sessions.ts";
import { cloneConfig as cloneStructuredConfig, configLines as structuredConfigLines, configNumber as structuredConfigNumber } from "./views/settings.ts";
import { auditFacetLabel as typedAuditFacetLabel } from "./views/audit.ts";
import { composeMessageWithLocalAttachments, readLocalTextAttachmentBatch, renderLocalAttachmentList } from "./components/local-attachments.ts";
import { agentGraphStatusClass, agentGraphStatusLabel, canReassignAgentGraph, isAgentGraphActive, renderAgentGraphDetail, renderAgentGraphRow } from "./views/agent-graphs.ts";

    let chatAttachments = [];

    function renderChatAttachments() {
      const list = $("chat-file-list");
      list.hidden = chatAttachments.length === 0;
      list.innerHTML = renderLocalAttachmentList(chatAttachments);
      $("attach-chat-file").setAttribute("aria-label", chatAttachments.length
        ? `Attach local text files. ${chatAttachments.length} currently attached.`
        : "Attach local text files");
    }

    function clearChatAttachments() {
      chatAttachments = [];
      $("chat-file-input").value = "";
      renderChatAttachments();
    }

    async function addChatFiles(files) {
      const selected = Array.from(files || []);
      if (!selected.length) return;
      const button = $("attach-chat-file");
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      try {
        const prepared = await readLocalTextAttachmentBatch(selected, chatAttachments);
        chatAttachments = prepared;
        renderChatAttachments();
      } finally {
        $("chat-file-input").value = "";
        button.removeAttribute("aria-busy");
        button.disabled = !providerReady(state.status);
      }
    }

    const advancedFeatureBrands = {"proof":{"name":"Runemark","descriptor":"Run verification","legacyName":"Proof"},"sentinel":{"name":"Gatewatch","descriptor":"Policy safety","legacyName":"Sentinel"},"rewind":{"name":"Norn Restore","descriptor":"Restore points","legacyName":"Rewind"},"darwin":{"name":"Raven Route","descriptor":"Model routing","legacyName":"Darwin"},"capabilities":{"name":"Rune Key","descriptor":"Scoped temporary access","legacyName":"Capability Tokens"},"capsules":{"name":"Saga Archive","descriptor":"Portable run bundles","legacyName":"Capsules"},"counterfactual":{"name":"Worldtree Paths","descriptor":"Scenario comparison","legacyName":"Counterfactual"}};
    const experimentalFeatures = {
      proof: {
        core: true,
        title: "Run Checks",
        technicalName: advancedFeatureBrands.proof.name,
        view: "lab-run-checks",
        summary: "Confirm that a completed run produced the result you expected.",
        endpoint: "/proof",
        actions: [
          { id: "verify", label: "Run a check", method: "POST", path: "/proof", description: "Check whether a recent piece of work produced the result you expected.", sample: () => ({ schemaVersion: 1, id: "ui-proof-" + Date.now(), runId: defaultExperimentalRunId(), assertions: [{ id: "readme-exists", type: "file", path: "README.md", expect: { exists: true } }] }) },
          { id: "inspect", label: "View check results", method: "GET", path: "/proof/{target}", target: "Run ID", description: "Review the checks already recorded for a piece of work.", availableWhenDisabled: true, sample: () => ({}) }
        ]
      },
      sentinel: {
        core: true,
        title: "Safety Preview",
        technicalName: advancedFeatureBrands.sentinel.name,
        view: "lab-safety-preview",
        summary: "Preview whether a planned action fits your safety rules.",
        endpoint: "/gatewatch/preview",
        actions: [
          { id: "evaluate", label: "Preview a decision", method: "POST", path: "/gatewatch/preview", description: "See the complete current admission decision without running the tool.", sample: () => ({ toolName: "text.echo", input: { text: "safe input" } }) }
        ]
      },
      capabilities: {
        title: "Temporary Access",
        technicalName: advancedFeatureBrands.capabilities.name,
        view: "lab-temporary-access",
        summary: "Grant narrow, short-lived permission for one action.",
        endpoint: "/capabilities",
        actions: [
          { id: "issue", label: "Create an access pass", method: "POST", path: "/capabilities/issue", description: "Create short-lived permission for one specific action.", sample: () => ({ runId: "ui-capability-" + Date.now(), stepId: "operator-step", toolName: "text.echo", scopes: ["text:echo"], expiresInMs: 60000, maxUses: 1 }) },
          { id: "consume", label: "Use an access pass", method: "POST", path: "/capabilities/use", description: "Use a pass once for the action it was created for.", sample: () => ({ token: "paste-issued-token", runId: "replace-with-token-run-id", toolName: "text.echo", resource: {} }) },
          { id: "list", label: "View active passes", method: "GET", path: "/capabilities/{target}", target: "Run ID", description: "See the access passes associated with a piece of work.", availableWhenDisabled: true, sample: () => ({}) },
          { id: "revoke", label: "Cancel an access pass", method: "POST", path: "/capabilities/{target}/revoke", target: "Capability ID", description: "Make an access pass unusable immediately.", dangerous: true, availableWhenDisabled: true, sample: () => ({}) }
        ]
      },
      rewind: {
        core: true,
        title: "Restore Points",
        technicalName: advancedFeatureBrands.rewind.name,
        view: "lab-restore-points",
        summary: "Save selected files and preview a restore before changing anything.",
        endpoint: "/checkpoints · /rewind",
        actions: [
          { id: "checkpoint", label: "Create a restore point", method: "POST", path: "/checkpoints", description: "Save the selected workspace files so you can return to them later.", sample: () => ({ runId: "ui-rewind-" + Date.now(), stepId: "operator-checkpoint", paths: ["README.md"], label: "operator checkpoint" }) },
          { id: "preview", label: "Preview a restore", method: "POST", path: "/rewind/{target}", target: "Snapshot ID", description: "See which files would change without changing them.", sample: () => ({ apply: false }) },
          { id: "apply", label: "Restore files", method: "POST", path: "/rewind/{target}", target: "Snapshot ID", description: "Return the saved files to their earlier state.", dangerous: true, sample: () => ({ apply: true }) }
        ]
      },
      governance: {
        core: true,
        title: "Controlled Workspace Governance",
        technicalName: "Norn Governance",
        view: "lab-governed-workspace",
        summary: "Use governed preview/apply for workspace mutation and restore operations.",
        endpoint: "/governed/workspace/mutate · /governed/workspace/patch · /governed/restore/create · /governed/restore/apply",
        actions: [
          { id: "mutate-preview", label: "Preview write/mkdir/remove/move", method: "POST", path: "/governed/workspace/mutate", description: "Preview a bounded change before anything is applied.", sample: () => ({ runId: "ui-governance-" + Date.now(), operation: "write", path: "README.md", content: "governed content" }) },
          { id: "mutate-apply", label: "Apply workspace mutation", method: "POST", path: "/governed/workspace/mutate", description: "Apply a prepared workspace mutation after reviewing the preview.", dangerous: true, requiresConfirmation: true, confirmationLabel: "Apply mutation", sample: () => ({ runId: "ui-governance-" + Date.now(), operation: "write", path: "README.md", content: "governed content", apply: true }) },
          { id: "patch-preview", label: "Preview patch edit", method: "POST", path: "/governed/workspace/patch", description: "Preview a bounded text replacement before applying it.", sample: () => ({ runId: "ui-governance-" + Date.now(), operation: "edit", path: "README.md", find: "old", replace: "governed", apply: false }) },
          { id: "patch-apply", label: "Apply patch edit", method: "POST", path: "/governed/workspace/patch", description: "Apply a bounded text replacement after reviewing preview output.", dangerous: true, requiresConfirmation: true, confirmationLabel: "Apply patch", sample: () => ({ runId: "ui-governance-" + Date.now(), operation: "edit", path: "README.md", find: "old", replace: "governed", apply: true }) },
          { id: "restore-preview", label: "Prepare restore plan", method: "POST", path: "/governed/restore/create", target: "Checkpoint ID", description: "Create a governed restore plan and show what would be changed.", sample: () => ({ runId: "ui-governance-" + Date.now(), checkpointId: "replace-with-checkpoint-id" }) },
          { id: "restore-apply", label: "Apply governed restore", method: "POST", path: "/governed/restore/apply", target: "Checkpoint ID", description: "Apply a governed restore only after validating the preview.", dangerous: true, requiresConfirmation: true, confirmationLabel: "Apply restore", sample: () => ({ runId: "ui-governance-" + Date.now(), checkpointId: "replace-with-checkpoint-id" }) }
        ]
      },
      capsules: {
        title: "Portable Runs",
        technicalName: advancedFeatureBrands.capsules.name,
        view: "lab-portable-runs",
        summary: "Package a completed run so it can be checked or replayed later.",
        endpoint: "/capsules",
        actions: [
          { id: "export", label: "Create a portable copy", method: "POST", path: "/capsules/export", description: "Package a completed piece of work for later use.", sample: () => ({ runId: defaultExperimentalRunId() }) },
          { id: "verify", label: "Check a portable copy", method: "POST", path: "/capsules/verify", description: "Confirm that a saved copy is complete and unchanged.", sample: () => ({ path: "paste-exported-capsule-path" }) },
          { id: "replay", label: "Replay safely", method: "POST", path: "/capsules/replay", description: "Replay the saved steps without running external actions.", sample: () => ({ path: "paste-exported-capsule-path", mode: "tool-mocked" }) }
        ]
      },
      counterfactual: {
        title: "Compare Approaches",
        technicalName: advancedFeatureBrands.counterfactual.name,
        view: "lab-scenario-compare",
        summary: "Try multiple approaches in separate workspace copies and compare the outcomes.",
        endpoint: "/counterfactual",
        actions: [
          { id: "create", label: "Create alternatives", method: "POST", path: "/counterfactual", description: "Make separate workspace copies for two different approaches.", sample: () => ({ sourceRunId: defaultExperimentalRunId(), sourceStepId: "operator-branch", plans: [{ id: "read", title: "Inspect README", summary: "Read the project README", tasks: [{ tool: "workspace.readText", input: { path: "README.md", maxBytes: 2048 }, readOnly: true }] }, { id: "echo", title: "Echo probe", summary: "Run a bounded echo probe", tasks: [{ tool: "text.echo", input: { text: "counterfactual probe" }, readOnly: true }] }] }) },
          { id: "inspect", label: "Compare results", method: "GET", path: "/counterfactual/{target}", target: "Group ID", description: "See the approaches and outcomes side by side.", sample: () => ({}) },
          { id: "execute", label: "Try every approach", method: "POST", path: "/counterfactual/{target}/execute", target: "Group ID", description: "Run each approach in its own workspace copy.", dangerous: true, sample: () => ({}) },
          { id: "select", label: "Preview your choice", method: "POST", path: "/counterfactual/{target}/select", target: "Group ID", description: "See what choosing one result would change.", sample: () => ({ runId: "paste-candidate-run-id", apply: false }) },
          { id: "apply", label: "Keep this result", method: "POST", path: "/counterfactual/{target}/select", target: "Group ID", description: "Replace the original workspace with the result you chose.", dangerous: true, sample: () => ({ runId: "paste-candidate-run-id", apply: true }) }
        ]
      },
      darwin: {
        core: true,
        title: "Smart Routing",
        technicalName: advancedFeatureBrands.darwin.name,
        view: "lab-model-routing",
        summary: "Learn which configured model works best for different kinds of work.",
        endpoint: "/routing",
        actions: [
          { id: "observe", label: "Record an outcome", method: "POST", path: "/routing/observe", description: "Tell Ódinn how a model performed on one kind of work.", sample: () => ({ runId: defaultExperimentalRunId(), providerId: "operator", modelId: "candidate", taskClass: "general", verified: true, durationMs: 1000, toolCalls: 1, toolErrors: 0 }) },
          { id: "stats", label: "See what was learned", method: "GET", path: "/routing/stats?taskClass={target}", target: "Task class", defaultTarget: "general", description: "Compare model results for this kind of work.", sample: () => ({}) },
          { id: "choose", label: "Recommend a model", method: "POST", path: "/routing/choose", description: "Ask Ódinn which configured model has performed best here.", sample: () => ({ taskClass: "general" }) }
        ]
      }
    };
    let toastTimer;
    function showToast(message, tone = "status") {
      const toast = $("toast-region");
      const text = String(message || "").trim();
      if (!toast || !text) return;
      toast.textContent = text.length > 260 ? text.slice(0, 257) + "..." : text;
      toast.className = "toast-region visible" + (tone === "error" ? " error" : "");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.className = "toast-region"; }, tone === "error" ? 7000 : 4200);
    }

    function showOutput(value) {
      $("output").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      const message = typeof value === "string"
        ? value
        : value?.error || value?.message || (value?.ok === false ? "Action failed." : "Action completed.");
      showToast(message, /error|fail|denied|unavailable|offline|invalid/i.test(String(message)) ? "error" : "status");
    }

    function compactPath(value) {
      const text = String(value || "");
      return text.length > 46 ? "..." + text.slice(-43) : text;
    }

    function setBusy(button, busy) {
      if (!button) return;
      button.disabled = busy;
    }

    function viewFromHash() {
      const params = new URLSearchParams(location.hash.replace(/^#/, ""));
      const candidate = params.get("view") || "overview";
      if (candidate === "audit" || candidate === "experiments") return candidate;
      return document.getElementById("view-" + candidate) ? candidate : "overview";
    }

    function closeMobileNavigation() {
      $("shell").classList.remove("nav-open");
      const mobile = matchMedia("(max-width: 980px)").matches;
      const collapsed = $("shell").classList.contains("sidebar-collapsed");
      const label = mobile ? "Open navigation" : collapsed ? "Expand navigation" : "Collapse navigation";
      $("sidebar-toggle").title = label;
      $("sidebar-toggle").setAttribute("aria-label", label);
      $("sidebar-toggle").setAttribute("aria-expanded", String(!mobile && !collapsed));
    }

    function renderOperatorItem(item) {
      const controls = (item.controls || []).map((action) => '<button class="secondary" data-operator-action="' + escapeHtml(action) + '" data-operator-target="' + escapeHtml(item.id) + '" type="button">' + escapeHtml(friendlyStatus(action)) + '</button>').join("");
      const effectView = item.kind === "approval" && item.details.effect?.summary ? '<div class="muted">Effect: ' + escapeHtml(item.details.effect.summary) + '</div>' : "";
      const latestAttempt = item.kind === "job" || item.kind === "run" ? item.details.latestAttempt : undefined;
      const attemptView = latestAttempt ? '<div class="muted">Latest attempt #' + escapeHtml(latestAttempt.attemptNumber) + ': ' + escapeHtml(friendlyStatus(latestAttempt.state)) + (latestAttempt.errorCode ? ' · ' + escapeHtml(latestAttempt.errorCode) : "") + '</div>' : "";
      return '<div class="item"><div class="item-line"><strong>' + escapeHtml(item.label || item.kind) + '</strong><span class="chip ' + (item.attention ? "danger" : item.status === "enabled" || item.status === "running" || item.status === "verified" || item.status === "available" ? "ok" : "warn") + '">' + escapeHtml(friendlyStatus(item.status)) + '</span></div><div>' + escapeHtml(item.summary || "") + '</div>' + effectView + attemptView + '<div class="muted">' + escapeHtml(item.id || "") + (item.updatedAt ? " · " + escapeHtml(relativeTime(item.updatedAt)) : "") + '</div>' + (controls ? '<div class="row">' + controls + '</div>' : "") + '</div>';
    }

    async function refreshOperator() {
      state.operatorPages = state.operatorPages || { work: 1 };
      const params = new URLSearchParams({ surface: "console", pageSize: "25", workPage: String(state.operatorPages.work || 1) });
      const snapshot = await api("/operator/snapshot?" + params.toString());
      state.operatorSnapshot = snapshot;
      const section = (name) => snapshot.sections[name];
      const work = section("work");
      const attention = [...work.items, ...section("approvals").items, ...section("automation").items, ...section("recovery").items, ...section("audit").items].filter((item) => item.attention || ["failed", "needs-review", "unknown"].includes(item.status));
      $("operator-health").textContent = friendlyStatus(snapshot.health.status);
      $("operator-health").className = "chip " + (snapshot.health.status === "healthy" ? "ok" : "danger");
      $("operator-attention").textContent = String(snapshot.health.attention);
      $("operator-work-count").textContent = String(work.counts.total);
      $("operator-approval-count").textContent = String(section("approvals").counts.pending);
      $("operator-audit-status").textContent = friendlyStatus(section("audit").items[0].status);
      $("operator-generated").textContent = snapshot.generatedAt ? relativeTime(snapshot.generatedAt) : "—";
      $("operator-runtime").innerHTML = section("runtime").items.map(renderOperatorItem).join("") || '<div class="empty-state"><strong>No runtime surfaces</strong><span>Nothing is registered.</span></div>';
      $("operator-attention-list").innerHTML = attention.map(renderOperatorItem).join("") || '<div class="empty-state"><strong>Nothing needs attention</strong><span>Governed work is proceeding normally.</span></div>';
      $("operator-work").innerHTML = work.items.map(renderOperatorItem).join("") || '<div class="empty-state"><strong>No recent work</strong><span>There is no durable work to show.</span></div>';
      $("operator-work-page").textContent = work.pagination.total + " items · page " + work.pagination.page + " of " + work.pagination.pages;
      state.operatorPages.work = work.pagination.page;
      $("operator-work-prev").disabled = state.operatorPages.work <= 1;
      $("operator-work-next").disabled = state.operatorPages.work >= work.pagination.pages;
      $("operator-payload").textContent = JSON.stringify(snapshot, null, 2);
      $("nav-operator-attention").textContent = String(snapshot.health.attention);
      $("nav-operator-attention").className = "badge " + (snapshot.health.attention ? "danger" : "ok");
      return snapshot;
    }

    async function runOperatorAction(action, targetId) {
      if (!state.operatorSnapshot) throw new Error("Refresh the operator snapshot before applying an action.");
      const matchingItems = Object.values(state.operatorSnapshot.sections)
        .flatMap((section) => section.items)
        .filter((candidate) => candidate.id === targetId && candidate.controls?.includes(action));
      if (matchingItems.length !== 1) throw new Error("The selected operator action target is no longer unique in the current snapshot.");
      const item = matchingItems[0];
      const effect = item.kind === "approval" ? item.details.effect : undefined;
      const effectSummary = effect?.summary || item.summary || "the selected operator item";
      const labels = { "cancel-job": "Cancel this job?", "deny-approval": "Deny this pending approval?", "cancel-workflow": "Cancel this workflow?" };
      if (action === "approve") {
        if (!window.confirm("Approve this effect once?\n\n" + effectSummary + "\n\nCapability: " + String(effect?.capability || item.label || "unknown") + ".")) return;
        if (effect?.reversible !== "reversible" || effect?.idempotency !== "idempotent") {
          if (window.prompt("This effect is irreversible or its outcome is uncertain. Type APPROVE to continue.") !== "APPROVE") return;
        }
      } else if (labels[action] && !window.confirm(labels[action] + "\n\n" + (action === "deny-approval" ? effectSummary : ""))) return;
      const result = await api("/operator/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, targetId, confirm: true, surface: "console" }) });
      showOutput(result);
      await refreshOperator();
    }

    function switchView(name, options = {}) {
      if (name === "audit") {
        name = "usage";
        options = { ...options, activityTab: "history" };
      }
      if (name === "experiments") name = "lab-run-checks";
      if (!document.getElementById("view-" + name)) name = "overview";
      state.activeView = name;
      document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === "view-" + name));
      document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
      if (name.startsWith("lab-")) document.querySelector(".nav-labs").open = true;
      const button = document.querySelector('[data-view="' + name + '"]');
      const title = button?.dataset.title || button?.textContent?.trim() || "Chat";
      $("view-title").textContent = title;
      document.title = title + " · Ódinn Forge";
      $("chat-context-sep").style.display = name === "overview" ? "" : "none";
      $("chat-title").style.display = name === "overview" ? "" : "none";
      if (options.updateHash !== false) {
        const nextHash = "#view=" + encodeURIComponent(name);
        if (location.hash !== nextHash) {
          if (options.replace === true) history.replaceState(null, "", nextHash);
          else history.pushState(null, "", nextHash);
        }
      }
      if (matchMedia("(max-width: 980px)").matches) closeMobileNavigation();
      if (name === "operator") refreshOperator().catch((error) => showOutput(error.message));
      if (name === "capabilities") {
        refreshApprovals().catch((error) => showOutput(error.message));
        refreshBrowser().catch((error) => showOutput(error.message));
      }
      if (name === "sessions") {
        if (state.status?.allowedTools?.includes("session.list")) refreshSessions().catch((error) => showOutput(error.message));
        else $("session-list").innerHTML = '<div class="empty-state"><strong>Sessions are disabled by policy</strong><span>Grant the required workspace capabilities to manage conversations.</span></div>';
      }
      if (name === "tasks") refreshTasks().catch((error) => showOutput(error.message));
      if (name === "delegation") refreshAgentGraphs().catch((error) => showOutput(error.message));
      if (name === "usage") {
        setActivityTab(options.activityTab || "overview");
        refreshUsage().catch((error) => showOutput(error.message));
      }
      if (name === "cron") refreshCron().catch((error) => showOutput(error.message));
      if (name === "agents") refreshAgents().catch((error) => showOutput(error.message));
      if (name === "skills") refreshSkills().catch((error) => showOutput(error.message));
      if (name === "automatic-improvements" || name.startsWith("lab-")) refreshExperiments().catch((error) => showOutput(error.message));
      if (name === "projects") refreshProjects().catch((error) => showOutput(error.message));
      if (name === "memory") refreshMemory().catch((error) => showOutput(error.message));
      if (name === "goals") refreshGoals().catch((error) => showOutput(error.message));
      if (name === "config") refreshConfig().catch((error) => {
        $("config-error").textContent = error.message;
        showOutput(error.message);
      });
    }

    function setActivityTab(tab) {
      const next = tab === "history" ? "history" : "overview";
      state.activityTab = next;
      const history = next === "history";
      $("activity-tab-overview").classList.toggle("active", !history);
      $("activity-tab-overview").setAttribute("aria-selected", String(!history));
      $("activity-tab-history").classList.toggle("active", history);
      $("activity-tab-history").setAttribute("aria-selected", String(history));
      $("activity-overview").classList.toggle("active", !history);
      $("activity-overview").hidden = history;
      $("activity-history").classList.toggle("active", history);
      $("activity-history").hidden = !history;
      if (history) refreshAudit().catch((error) => showOutput(error.message));
    }

    function defaultExperimentalRunId() {
      return state.experimentalRuns[0]?.id || "";
    }

    function experimentalPage(featureKey) {
      return document.querySelector('[data-experimental-page="' + featureKey + '"]');
    }

    function selectedExperimentalAction(featureKey) {
      const feature = experimentalFeatures[featureKey];
      const selected = state.experimentalActions?.[featureKey];
      return feature?.actions.find((action) => action.id === selected) || feature?.actions[0];
    }

    function experimentalPath(action, target = "", requireTarget = false) {
      const effectiveTarget = target || (action.target === "Run ID" ? defaultExperimentalRunId() : "");
      if (action.target && requireTarget && !effectiveTarget) throw new Error("Choose the item you want to use first.");
      return action.path.replace("{target}", encodeURIComponent(effectiveTarget || "target"));
    }

    function renderSelfImprovementStatus(status) {
      const settings = status?.selfImprovement || { enabled: true, mode: "propose", intervalMs: 300000, maxChangesPerCycle: 1, rollbackOnFailure: true };
      const automatic = settings.enabled === true && settings.mode === "auto";
      $("improvement-controller-state").textContent = automatic ? "Running" : "Paused";
      const model = settings.advisor?.model || "";
      $("improvement-mode").textContent = model ? modelDisplayName(model) : "Waiting for model";
      $("improvement-mode-chip").textContent = automatic ? "Working automatically" : "Paused";
      $("improvement-mode-chip").className = "chip " + (automatic ? "ok" : "warn");
      $("self-improvement-model").textContent = model ? modelDisplayName(model) + " · configured provider" : "Connect a provider";
      $("self-improvement-limit").textContent = String(settings.maxChangesPerCycle || 1) + " maximum per check";
      $("self-improvement-config").querySelector(".detail-card strong").textContent = describeInterval(settings.intervalMs);
      const canWrite = status?.allowedTools?.includes("improve.propose") === true;
      $("learn-improvements").disabled = !canWrite || !automatic;
    }

    function selectedImprovement() {
      return state.improvements.find((item) => item.id === state.selectedImprovementId);
    }

    function renderImprovementDetail() {
      const improvement = selectedImprovement();
      if (!improvement) {
        $("improvement-detail-status").textContent = "No selection";
        $("improvement-detail-status").className = "chip";
        $("improvement-detail").className = "empty-state";
        $("improvement-detail").innerHTML = '<strong>Select an observation</strong><span>The reason, result, and recovery option will appear here.</span>';
        $("improvement-rollback").disabled = true;
        return;
      }
      const status = improvement.status || "proposed";
      const tone = ["approved", "applied"].includes(status) ? "ok" : ["rejected", "failed"].includes(status) ? "danger" : "warn";
      $("improvement-detail-status").textContent = friendlyImprovementStatus(status);
      $("improvement-detail-status").className = "chip " + tone;
      $("improvement-detail").className = "agent-inspector";
      $("improvement-detail").innerHTML = '<div class="agent-section"><strong>' + escapeHtml(friendlyImprovementTitle(improvement)) + '</strong><p>' + escapeHtml(improvement.rationale) + '</p></div>' +
        '<div class="detail-grid">' +
          '<div class="detail-card"><span>Area</span><strong>' + escapeHtml(friendlyArea(improvement.target)) + '</strong></div>' +
          '<div class="detail-card"><span>Importance</span><strong>' + escapeHtml(friendlyStatus(improvement.priority || "normal")) + '</strong></div>' +
          '<div class="detail-card"><span>Similar occurrences</span><strong>' + escapeHtml(String((improvement.evidence || []).length)) + '</strong></div>' +
          '<div class="detail-card"><span>Last updated</span><strong>' + escapeHtml(relativeTime(improvement.updatedAt)) + '</strong></div></div>' +
        renderImprovementHistory(improvement);
      const canWrite = state.status?.allowedTools?.includes("improve.decide") === true;
      $("improvement-rollback").disabled = !canWrite || status !== "applied";
    }

    function renderImprovements() {
      $("improvement-count").textContent = String(state.improvements.length);
      $("improvement-review-count").textContent = String(state.improvements.filter((item) => item.status === "applied").length);
      $("improvement-list").innerHTML = state.improvements.map((improvement) => {
        const selected = improvement.id === state.selectedImprovementId;
        const tone = ["approved", "applied"].includes(improvement.status) ? "ok" : ["rejected", "failed"].includes(improvement.status) ? "danger" : "warn";
        return '<div class="item clickable ' + (selected ? "selected" : "") + '" role="button" tabindex="0" data-improvement-id="' + escapeHtml(improvement.id) + '"><div class="item-line"><strong>' + escapeHtml(friendlyImprovementTitle(improvement)) + '</strong><span class="chip ' + tone + '">' + escapeHtml(friendlyImprovementStatus(improvement.status || "proposed")) + '</span></div><div class="muted">' + escapeHtml(friendlyArea(improvement.target)) + ' · ' + escapeHtml(relativeTime(improvement.updatedAt)) + '</div><div>' + renderItemText(improvement.rationale, "Ódinn is monitoring this pattern.") + '</div></div>';
      }).join("") || '<div class="empty-state"><strong>Nothing needs attention</strong><span>Ódinn will keep watching in the background.</span></div>';
      renderImprovementDetail();
    }

    async function refreshImprovements() {
      if (state.status?.allowedTools?.includes("improve.list") !== true) {
        state.improvements = [];
        $("improvement-list").innerHTML = '<div class="empty-state"><strong>Improvement history is unavailable</strong><span>This workspace does not allow improvement history to be read.</span></div>';
        renderImprovementDetail();
        return;
      }
      const result = await api("/improvements?limit=100");
      state.improvements = result.improvements || [];
      if (state.selectedImprovementId && !selectedImprovement()) state.selectedImprovementId = "";
      renderImprovements();
    }

    async function rollbackImprovement() {
      const improvement = selectedImprovement();
      if (!improvement) throw new Error("select an applied improvement first");
      if (!window.confirm("Undo the automatic change for “" + improvement.title + "” and restore the previous setting?")) return;
      const result = await api("/improvements/" + encodeURIComponent(improvement.id) + "/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      showOutput("The previous setting was restored.");
      await refreshImprovements();
    }

    async function learnImprovements() {
      const button = $("learn-improvements");
      setBusy(button, true);
      try {
        const result = await api("/improvements/learn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 1000 }) });
        const applied = result.applied?.length || 0;
        showOutput(applied ? "Ódinn found and applied " + applied + " reversible improvement." : "Automatic check complete. No change was needed.");
        await refreshImprovements();
      } finally { setBusy(button, false); }
    }

    function renderExperimentalFeaturePage(featureKey) {
      const page = experimentalPage(featureKey);
      const feature = experimentalFeatures[featureKey];
      if (!page || !feature) return;
      state.experimentalActions ||= {};
      if (!state.experimentalActions[featureKey]) state.experimentalActions[featureKey] = feature.actions[0]?.id;
      const action = selectedExperimentalAction(featureKey);
      const enabled = feature.core === true || state.status?.experimental?.[featureKey] === true;
      const available = enabled || action.availableWhenDisabled === true;
      const status = page.querySelector('[data-role="feature-status"]');
      status.textContent = feature.core ? "Core" : enabled ? "Available" : "Currently off";
      status.className = "chip " + (enabled ? "ok" : "warn");
      const list = page.querySelector('[data-role="action-list"]');
      list.innerHTML = feature.actions.map((item) =>
        '<button class="feature-action ' + (item.id === action.id ? "selected" : "") + '" data-feature-action="' + escapeHtml(item.id) + '" type="button"><strong>' + escapeHtml(item.label) + '</strong><span>' + escapeHtml(item.description) + '</span></button>'
      ).join("");
      page.querySelector('[data-role="action-title"]').textContent = action.label;
      page.querySelector('[data-role="action-description"]').textContent = action.description;
      const risk = page.querySelector('[data-role="action-risk"]');
      risk.textContent = action.dangerous ? "Changes local state" : action.method === "GET" ? "View only" : "Reversible or recorded";
      risk.className = "chip " + (action.dangerous ? "danger" : action.method === "GET" ? "ok" : "warn");
      const targetField = page.querySelector('[data-role="target-field"]');
      targetField.hidden = !action.target;
      const targetLabel = friendlyTargetLabel(action.target);
      page.querySelector('[data-role="target-label"]').textContent = targetLabel;
      const target = page.querySelector('[data-role="target"]');
      target.setAttribute("aria-label", targetLabel);
      if (target.dataset.action !== action.id) {
        target.dataset.action = action.id;
        target.value = action.defaultTarget || "";
      }
      const advanced = page.querySelector(".advanced-options");
      advanced.hidden = action.method === "GET";
      const payload = page.querySelector('[data-role="payload"]');
      if (payload.dataset.action !== action.id) {
        payload.dataset.action = action.id;
        payload.value = JSON.stringify(action.sample(), null, 2);
      }
      const run = page.querySelector('[data-role="run"]');
      run.disabled = !available;
      run.className = action.dangerous ? "danger" : "";
      run.textContent = available ? action.label : "Enable this plugin to continue";
    }

    function renderExperimentalHome(status) {
      const entries = Object.entries(experimentalFeatures);
      const plugins = entries.filter(([, feature]) => feature.core !== true);
      const flags = status?.experimental || {};
      const enabledCount = plugins.filter(([key]) => flags[key] === true).length;
      $("nav-experimental-count").textContent = enabledCount + "/" + plugins.length + " plugins";
      $("nav-experimental-count").className = "badge " + (enabledCount ? "ok" : "warn");
      renderSelfImprovementStatus(status);
      entries.forEach(([key]) => renderExperimentalFeaturePage(key));
    }

    async function refreshExperiments() {
      state.status = await api("/status");
      renderExperimentalHome(state.status);
      await refreshImprovements();
    }

    async function runExperimentalAction(featureKey) {
      const page = experimentalPage(featureKey);
      const action = selectedExperimentalAction(featureKey);
      if (!page || !action) return;
      const feature = experimentalFeatures[featureKey];
      if (feature?.core !== true && state.status?.experimental?.[featureKey] !== true && action.availableWhenDisabled !== true) throw new Error("This plugin is currently off. Enable it in Odinn settings and restart before using this action.");
      const target = page.querySelector('[data-role="target"]').value.trim();
      const path = experimentalPath(action, target, true);
      if (action.dangerous && action.requiresConfirmation !== true && !window.confirm('Continue with “' + action.label + '”? ' + action.description + " A preview is recommended whenever one is available.")) return;
      const options = { method: action.method };
      let payload;
      if (action.method !== "GET") {
        try { payload = JSON.parse(page.querySelector('[data-role="payload"]').value || "{}"); }
        catch { throw new Error("The advanced options are not valid. Reset them or correct the formatting."); }
        options.headers = { "content-type": "application/json" };
        options.body = JSON.stringify(payload);
      }
      if (action.requiresConfirmation && !window.confirm('Apply only after review: ' + (action.confirmationLabel || action.label) + ". This cannot be undone if external effects are not fully reversible.")) return;
      const button = page.querySelector('[data-role="run"]');
      const resultArea = page.querySelector('[data-role="result"]');
      setBusy(button, true);
      resultArea.innerHTML = '<div class="empty-state"><strong>Working…</strong><span>Ódinn is completing ' + escapeHtml(action.label.toLowerCase()) + '.</span></div>';
      try {
        const result = await api(path, options);
        renderFriendlyResult(resultArea, result, featureKey, action, payload);
        showOutput(action.label + " completed.");
      } catch (error) {
        resultArea.innerHTML = '<div class="result-summary error"><strong>That did not work</strong><p>' + escapeHtml(error.message) + '</p></div>';
        throw error;
      } finally {
        setBusy(button, false);
        renderExperimentalFeaturePage(featureKey);
      }
    }

    function friendlyStatus(value) {
      const text = String(value || "unknown");
      const labels = {
        "completed-unverified": "Completed",
        verified: "Verified",
        completed: "Completed",
        passed: "Passed",
        failed: "Needs attention",
        denied: "Stopped safely",
        running: "In progress",
        proposed: "Observed",
        applied: "Applied",
        rejected: "Dismissed",
        "rolled-back": "Undone",
        high: "High",
        normal: "Normal",
        low: "Low"
      };
      return labels[text] || text.replace(/[._-]+/g, " ").replace(/w/g, (letter) => letter.toUpperCase());
    }

    function friendlyImprovementStatus(value) {
      const labels = {
        proposed: "Watching",
        approved: "Ready",
        applied: "Improved automatically",
        failed: "Change not applied",
        rejected: "Dismissed",
        "rolled-back": "Undone"
      };
      return labels[value] || friendlyStatus(value);
    }

    function friendlyImprovementTitle(improvement) {
      if (/^Improve reliability for /i.test(improvement?.title || "")) {
        return "Make " + friendlyArea(improvement.target).toLowerCase() + " more reliable";
      }
      return improvement?.title || "Reliability observation";
    }

    function friendlyEventTitle(event) {
      const labels = {
        "task.policy": "Safety check",
        "task.started": "Started",
        "task.completed": "Completed",
        "task.failed": "Needs attention",
        "task.blocked": "Stopped safely",
        "task.approval_required": "Waiting for approval",
        "task.cancelled": "Cancelled",
        "agent.progress": "Agent progress",
        "provider.attempt": "Connected to model",
        "memory.curate": "Memory updated"
      };
      return labels[event?.type] || (event?.tool ? friendlyArea(event.tool) : friendlyStatus(event?.type || "Update"));
    }

    function friendlyActor(value) {
      const text = String(value || "Odinn");
      if (/autonomous|automation|cron|scheduler/i.test(text)) return "Automatic workflow";
      if (/gateway|console|user/i.test(text)) return "You";
      if (/agent/i.test(text)) return "Agent SDK";
      return friendlyStatus(text);
    }

    function friendlyErrorMessage(value) {
      const text = String(value || "");
      if (!text) return "";
      if (/429|rate.?limit/i.test(text)) return "The model service was busy. Ódinn will retry automatically.";
      if (/timed? ?out|timeout/i.test(text)) return "The operation took too long and stopped safely.";
      if (/policy|capability|approval|denied|blocked/i.test(text)) return "A safety rule stopped this action.";
      if (/provider|model/i.test(text) && /failed|error|unavailable|returned|empty|assistant content/i.test(text)) return "The connected model did not return a usable response.";
      if (/policy allowed task/i.test(text)) return "The action passed its safety checks.";
      return "This action did not complete as expected.";
    }

    function friendlyArea(value) {
      const key = String(value || "").replace(/^runtime\//, "");
      const labels = {
        "model.chat": "Model conversations",
        "agent.run": "Agent work",
        "web.fetch": "Web reading",
        "web.search": "Web search",
        "session.create": "Conversation setup",
        "session.list": "Conversations",
        "session.read": "Conversation history",
        "session.delete": "Conversation cleanup",
        "project.list": "Projects",
        "project.create": "Projects",
        "project.update": "Projects",
        "goal.list": "Goals",
        "goal.create": "Goals",
        "goal.update": "Goals",
        "memory.search": "Memory search",
        "memory.recall": "Memory recall",
        "memory.remember": "Memory",
        "memory.forget": "Memory",
        "memory.browse": "Memory library",
        "memory.curate": "Memory organization",
        "improve.learn": "Automatic improvements",
        "improve.list": "Automatic improvements",
        "improve.rollback": "Automatic improvements",
        runtime: "General reliability"
      };
      return labels[key] || key.replace(/[._/-]+/g, " ").replace(/w/g, (letter) => letter.toUpperCase()) || "General reliability";
    }

    function friendlyTaskTitle(task) {
      const labels = {
        "improve.learn": "Automatic improvement check",
        "improve.rollback": "Undo an automatic improvement",
        "model.chat": "Model conversation",
        "agent.run": "Agent SDK work",
        "memory.search": "Search memory",
        "memory.recall": "Find useful memories",
        "memory.remember": "Save a memory",
        "memory.forget": "Forget a memory",
        "memory.curate": "Organize memory",
        "memory.browse": "Browse memory",
        "session.create": "Start a conversation",
        "session.list": "Review conversations",
        "session.read": "Open a conversation",
        "session.delete": "Delete a conversation"
      };
      return labels[task?.tool] || task?.title || friendlyArea(task?.tool);
    }

    function friendlyTaskOrigin(value) {
      const labels = { user: "You", agent: "Agent SDK", automation: "Automatic", system: "System" };
      return labels[value] || friendlyStatus(value);
    }

    function describeInterval(value) {
      const minutes = Math.max(1, Math.round(Number(value || 300000) / 60000));
      return minutes === 1 ? "Every minute" : "Every " + minutes + " minutes";
    }

    function modelDisplayName(value) {
      const text = String(value || "");
      return text.includes(":") ? text.slice(text.indexOf(":") + 1) : text || "Connected model";
    }

    function friendlyTargetLabel(value) {
      const labels = {
        "Run ID": "Run to use (leave blank for the most recent)",
        "Snapshot ID": "Restore point reference",
        "Group ID": "Comparison reference",
        "Capability ID": "Access pass reference",
        "Task class": "Kind of work"
      };
      return labels[value] || "Item to use";
    }

    function renderImprovementHistory(improvement) {
      const decisions = improvement.decisions || [];
      if (!decisions.length) return '<div class="agent-section"><strong>Current result</strong><p>Ódinn is watching this pattern. No runtime setting has been changed.</p></div>';
      return '<div class="agent-section"><strong>What happened</strong><ul class="human-list">' + decisions.map((decision) => {
        let description = decision.note || friendlyImprovementStatus(decision.decision);
        if (decision.action?.path === "runtime.modelRetries") {
          description = decision.decision === "applied"
            ? "Ódinn increased the retry buffer from " + decision.action.previousValue + " to " + decision.action.value + "."
            : description;
        }
        return '<li><strong>' + escapeHtml(friendlyImprovementStatus(decision.decision)) + '</strong><div class="muted">' + escapeHtml(description) + ' · ' + escapeHtml(relativeTime(decision.at)) + '</div></li>';
      }).join("") + '</ul></div>';
    }

    function renderGovernanceProposal(payload, action) {
      const operation = payload?.operation;
      if (operation) {
        const details = [payload.path ? "path: " + payload.path : "", payload.checkpointId ? "checkpoint: " + payload.checkpointId : "", payload.find ? "find: “" + payload.find + "”" : "", payload.replace ? "replace: “" + payload.replace + "”" : ""].filter(Boolean);
        return operation + (details.length ? " • " + details.join(" • ") : "");
      }
      if (action?.id === "restore-preview" || action?.id === "restore-apply") {
        return payload?.checkpointId ? "restore checkpoint: " + payload.checkpointId : "restore request";
      }
      if (payload?.runId) return "run " + payload.runId;
      return action?.label;
    }

    function renderGovernanceSummary(result, action, payload) {
      const output = (result && typeof result === "object" && "output" in result) ? result.output : result;
      if (!output || typeof output !== "object") return "";
      const conflicts = Array.isArray(output.conflicts) ? output.conflicts : [];
      const entries = Array.isArray(output.entries) ? output.entries : [];
      const needsReview = output.status === "needs-review" || output.status === "conflict" || conflicts.length > 0;
      const digestFacts = entries.map((entry) => {
        const expectedDigest = String((entry.expected || {}).digest || entry.before?.digest || "not specified");
        const currentDigest = String(entry.before?.digest || "not present");
        const resultingDigest = String(entry.after?.digest || entry.resultDigest || "not computed");
        return '<div class="result-fact"><small>Path</small><strong>' + escapeHtml(String(entry.path || "(root)")) + '</strong></div>' +
          '<div class="result-fact"><small>Expected digest</small><strong>' + escapeHtml(expectedDigest) + '</strong></div>' +
          '<div class="result-fact"><small>Current digest</small><strong>' + escapeHtml(currentDigest) + '</strong></div>' +
          '<div class="result-fact"><small>Resulting digest</small><strong>' + escapeHtml(resultingDigest) + '</strong></div>';
      }).join("");
      const conflictRows = conflicts.map((conflict, index) => '<li><strong>' + escapeHtml(friendlyStatus(conflict.code || "Needs review")) + '</strong><span>' + escapeHtml((conflict.path || "") + (conflict.message ? ": " + conflict.message : "")) + '</span></li>').join("");
      const digestSection = digestFacts ? '<section class="agent-section"><strong>Digest report</strong><div class="result-grid">' + digestFacts + '</div></section>' : "";
      const conflictSection = conflicts.length ? '<section class="agent-section"><strong>Conflicts</strong><ul class="human-list">' + conflictRows + '</ul></section>' : "";
      const status = output.status || (output.applied === true ? "applied" : output.applied === false ? "needs-review" : "ready");
      const statusText = needsReview ? "needs-review" : status;
      return '<section class="agent-section"><strong>Proposed operation</strong><p>' + escapeHtml(renderGovernanceProposal(payload, action)) + '</p><div class="result-grid"><div class="result-fact"><small>Apply</small><strong>' + escapeHtml(output.applied === true ? "Applied" : output.applied === false ? "Not applied" : "Preview") + '</strong></div><div class="result-fact"><small>Status</small><strong>' + escapeHtml(friendlyStatus(statusText)) + '</strong></div><div class="result-fact"><small>Needs review</small><strong>' + escapeHtml(needsReview ? "Yes" : "No") + '</strong></div><div class="result-fact"><small>Action</small><strong>' + escapeHtml(String(output.operation || action?.id || "")) + '</strong></div></div></section>' + digestSection + conflictSection;
    }

    function renderFriendlyResult(target, result, featureKey, action, requestPayload) {
      if (featureKey === "capabilities" && typeof result?.token === "string") state.lastCapabilityToken = result.token;
      const output = featureKey === "governance" && result && typeof result === "object" && "output" in result ? result.output : result;
      const facts = [];
      const labels = {
        status: "Status",
        decision: "Decision",
        verified: "Verified",
        provider: "Provider",
        model: "Model",
        taskClass: "Kind of work",
        maxUses: "Maximum uses",
        remainingUses: "Uses remaining",
        applied: "Files changed",
        durationMs: "Duration",
        selected: "Selected option",
        assertions: "Checks",
        candidates: "Approaches",
        records: "Records"
      };
      for (const [key, value] of Object.entries(output || {})) {
        if (!labels[key] || value === undefined || value === null) continue;
        const display = typeof value === "boolean"
          ? value ? "Yes" : "No"
          : Array.isArray(value) ? value.length + " total"
            : key === "durationMs" ? formatDuration(value)
              : key === "model" ? modelDisplayName(value)
                : typeof value === "object" ? Object.keys(value).length + " items" : friendlyStatus(value);
        facts.push('<div class="result-fact"><small>' + escapeHtml(labels[key]) + '</small><strong>' + escapeHtml(display) + '</strong></div>');
      }
      const message = output?.message || output?.summary || action.label + " completed successfully.";
      const tokenNotice = state.lastCapabilityToken && featureKey === "capabilities" && action.id === "issue"
        ? '<div class="agent-section"><strong>Your access pass is ready</strong><p>For safety, it is not displayed on this page. Copy it now and store it only where it is needed.</p><button class="secondary" data-copy-access-pass type="button">Copy access pass</button></div>'
        : "";
      const list = Array.isArray(result?.assertions)
        ? '<ul class="human-list">' + result.assertions.map((item) => '<li><strong>' + escapeHtml(item.passed === false ? "Needs attention" : "Passed") + '</strong><div class="muted">' + escapeHtml(item.message || item.id || "Check completed") + '</div></li>').join("") + '</ul>'
        : "";
      const safeDetails = redactTechnicalResult(result);
      const governanceSection = featureKey === "governance" ? renderGovernanceSummary(output, action, requestPayload || {}) : "";
      target.innerHTML = '<div class="result-summary success"><div><strong>' + escapeHtml(action.label + " complete") + '</strong><p>' + escapeHtml(message) + '</p></div>' +
        (facts.length ? '<div class="result-grid">' + facts.join("") + '</div>' : "") + governanceSection + tokenNotice + list +
        '<details class="activity-details technical-details"><summary>Developer details</summary><pre>' + escapeHtml(JSON.stringify(safeDetails, null, 2)) + '</pre></details></div>';
    }

    function redactTechnicalResult(value, key = "") {
      if (/token|secret|password|authorization|cookie/i.test(key)) return "[hidden]";
      if (Array.isArray(value)) return value.map((item) => redactTechnicalResult(item));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactTechnicalResult(item, name)]));
      return value;
    }

    function renderItemText(text, fallback) {
      const value = String(text || fallback || "");
      return escapeHtml(value.length > 180 ? value.slice(0, 177) + "..." : value);
    }

    function renderRun(run) {
      const tone = run.status === "completed" ? "ok" : run.status === "running" ? "warn" : "danger";
      return '<div class="item clickable" role="button" tabindex="0" data-run-id="' + escapeHtml(run.id) + '">' +
        '<div class="item-line"><span class="item-title">' + escapeHtml(friendlyArea(run.tool) || "Odinn activity") + '</span>' +
        '<span class="chip ' + tone + '">' + escapeHtml(friendlyStatus(run.status)) + '</span></div>' +
        '<div class="muted">' + escapeHtml(friendlyErrorMessage(run.message) || "Completed work") + '</div>' +
      '</div>';
    }

    function renderAuditEvent(event) {
      const outcome = ["task.failed", "plan.failed"].includes(event.type) ? "failed" : (event.type === "task.blocked" || event.decision === "deny") ? "denied" : event.type === "task.completed" ? "completed" : event.type === "task.started" ? "running" : "recorded";
      const isError = ["failed", "denied"].includes(outcome);
      const isModel = ["model.chat", "agent.run"].includes(event.tool);
      const tone = isError ? "danger" : isModel ? "ok" : "";
      const title = friendlyEventTitle(event);
      const summary = event.type === "task.policy" && event.decision !== "deny"
        ? "The action passed its safety checks."
        : event.type === "task.started"
          ? "Work began."
          : event.type === "task.completed"
            ? "Work finished successfully."
            : friendlyErrorMessage(event.message) || friendlyArea(event.tool);
      const metadata = [event.actor && "Started by " + friendlyActor(event.actor), event.tool && friendlyArea(event.tool)].filter(Boolean);
      return '<div class="item activity-event ' + (isError ? "error" : "") + '"><div class="item-line"><strong>' + escapeHtml(title) + '</strong><span class="chip ' + tone + '">' + escapeHtml(friendlyStatus(outcome)) + '</span></div><div class="muted">' + escapeHtml(relativeTime(event.at || event.timestamp)) + '</div><p class="activity-summary">' + escapeHtml(summary) + '</p><div class="activity-meta">' + metadata.map((value) => '<span>' + escapeHtml(value) + '</span>').join("") + '</div><details class="activity-details"><summary>More context</summary><div class="detail-grid"><div class="detail-card"><span>When</span><strong>' + escapeHtml(new Date(event.at || event.timestamp || Date.now()).toLocaleString()) + '</strong></div><div class="detail-card"><span>Started by</span><strong>' + escapeHtml(friendlyActor(event.actor)) + '</strong></div><div class="detail-card"><span>Area</span><strong>' + escapeHtml(friendlyArea(event.tool)) + '</strong></div><div class="detail-card"><span>Result</span><strong>' + escapeHtml(friendlyStatus(event.decision || outcome)) + '</strong></div></div></details></div>';
    }

    function renderProvider(provider) {
      const configured = provider.configured && (provider.models || []).length > 0;
      const status = configured ? "Ready" : provider.configured ? "Choose a model" : "Connect account";
      const connection = provider.name === "ollama" || provider.name === "lmstudio" ? "On this computer" : "Connected service";
      const support = provider.supportTier === "first-class"
        ? "First-class support"
        : provider.supportTier === "compatible"
          ? "Compatibility preset"
          : provider.supportTier === "experimental"
            ? "Experimental"
            : "Custom compatibility mode";
      const boundary = provider.genericCompatibilityMode
        ? " Uses the shared OpenAI-compatible connection; the external service is not live-tested by Odinn."
        : provider.modelAvailability === "provider-dependent"
          ? " Models and service availability are controlled by the provider."
          : " Model availability depends on the local server.";
      return '<div class="provider-card"><div class="provider-head"><strong>' + escapeHtml(provider.displayName || friendlyStatus(provider.name)) + '</strong><span class="chip ' + (configured ? "ok" : "warn") + '">' + status + '</span></div><div class="chip-row"><span class="chip">' + escapeHtml(support) + '</span><span class="chip">' + escapeHtml(connection) + '</span><span class="chip">' + escapeHtml((provider.models || []).length + " model" + ((provider.models || []).length === 1 ? "" : "s")) + '</span></div><div class="muted">' + escapeHtml((configured ? "Available for chat and automatic improvements." : "Finish setup to use this provider.") + boundary) + '</div></div>';
    }

    function providerReady(status = state.status) {
      const readyProviders = new Set((status?.providers || [])
        .filter((provider) => provider.configured && (provider.models || []).length > 0)
        .map((provider) => provider.name));
      return (status?.models || []).some((model) => readyProviders.has(model.provider));
    }

    function renderSessionTranscript(detail) {
      const messages = detail?.messages || [];
      $("selected-session-route").textContent = detail?.session?.title || "Selected session";
      $("session-transcript").innerHTML = messages.length
        ? messages.map((message) => '<div class="timeline-row"><span class="timeline-dot"></span><div class="item"><div class="item-line"><strong>' + escapeHtml(message.role === "user" ? "You" : message.role === "assistant" ? "Ódinn" : friendlyStatus(message.role || "message")) + '</strong><span class="chip">' + escapeHtml(message.model ? modelDisplayName(message.model) : "Default model") + '</span></div><div class="markdown-body">' + renderMarkdown(message.content) + '</div></div></div>').join("")
        : '<div class="empty-state"><strong>No messages yet</strong><span>Send the first message from Chat.</span></div>';
    }

    function renderChatSession(session) {
      const attrs = 'data-chat-session-id="' + escapeHtml(session.id) + '"';
      const active = session.id === state.activeChatId ? " active" : "";
      return '<div class="menu-chat' + active + '" ' + attrs + '>' +
        '<div class="menu-chat-main"><strong>' + renderItemText(session.title, "Untitled chat") + '</strong>' +
        '<span>' + escapeHtml(session.lastMessageRole === "assistant" ? "Ódinn replied" : session.lastMessageRole === "user" ? "Waiting for Ódinn" : "Ready") + ' · ' + escapeHtml((session.messageCount || 0) + ((session.messageCount || 0) === 1 ? " message" : " messages")) + '</span></div>' +
        '<div class="menu-chat-actions"><button class="chat-action" data-session-action="rename" data-session-id="' + escapeHtml(session.id) + '" title="Rename chat" aria-label="Rename chat" type="button"><svg class="icon-svg"><use href="#icon-edit"></use></svg></button><button class="chat-action delete" data-session-action="delete" data-session-id="' + escapeHtml(session.id) + '" title="Delete chat" aria-label="Delete chat" type="button"><svg class="icon-svg"><use href="#icon-trash"></use></svg></button></div>' +
      '</div>';
    }

    function renderSessionRecord(session) {
      const updated = session.updatedAt || session.createdAt || "";
      const project = state.projects.find((entry) => entry.id === session.projectId);
      const knownProjectOptions = state.projects.filter((entry) => entry.status === "active" || entry.id === session.projectId).map((entry) => '<option value="' + escapeHtml(entry.id) + '"' + (entry.id === session.projectId ? " selected" : "") + '>' + escapeHtml(entry.name + (entry.status === "archived" ? " (archived)" : "")) + '</option>').join("");
      const projectOptions = project ? knownProjectOptions : '<option value="' + escapeHtml(session.projectId) + '" selected>Unavailable project</option>' + knownProjectOptions;
      return '<div class="data-row clickable session-record" data-session-id="' + escapeHtml(session.id) + '">' +
        '<span class="data-primary"><strong>' + renderItemText(session.title, "Untitled session") + '</strong><small>' + escapeHtml(modelDisplayName(session.model || session.route || "") || "Default model") + '</small></span>' +
        '<span>' + escapeHtml(project?.name || "Workspace") + (project?.status === "archived" ? ' <span class="chip">archived</span>' : '') + '</span>' +
        '<span class="chip">' + escapeHtml(friendlySessionSource(session.source)) + '</span>' +
        '<span class="chip ' + (session.status === "archived" ? "" : "ok") + '">' + escapeHtml(friendlyStatus(session.status || "open")) + '</span>' +
        '<span class="muted">' + escapeHtml(relativeTime(updated)) + '</span>' +
        '<span>' + escapeHtml(session.messageCount || 0) + '</span>' +
        '<span class="row"><select class="session-project-select" data-session-project="' + escapeHtml(session.id) + '" aria-label="Move session to project">' + projectOptions + '</select><button class="session-action" data-session-action="rename" data-session-id="' + escapeHtml(session.id) + '" title="Rename session" aria-label="Rename session" type="button">Rename</button><button class="session-action delete" data-session-action="delete" data-session-id="' + escapeHtml(session.id) + '" title="Delete session" aria-label="Delete session" type="button">Delete</button></span>' +
      '</div>';
    }

    function friendlySessionSource(value) {
      const text = String(value || "direct");
      if (/chat|console/i.test(text)) return "Chat";
      if (/agent/i.test(text)) return "Agent";
      if (/cron|schedule|automation/i.test(text)) return "Automatic";
      return friendlyStatus(text);
    }

    function relativeTime(value) {
      return sessionRelativeTime(value);
    }

    function sessionDisplayTitle(sessionId) {
      return state.sessions.find((session) => session.id === sessionId)?.title || "Untitled chat";
    }

    async function renameChat(sessionId) {
      const title = window.prompt("Rename chat", sessionDisplayTitle(sessionId));
      if (title === null || !title.trim()) return;
      await api("/sessions/" + encodeURIComponent(sessionId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim(), source: "console-chat" })
      });
      await refreshSessions();
      if (state.activeChatId === sessionId) await loadChat(sessionId);
      if (state.selectedSessionId === sessionId && state.activeChatId !== sessionId) {
        renderSessionTranscript(await api("/sessions/" + encodeURIComponent(sessionId)));
      }
    }

    async function deleteChat(sessionId) {
      const title = sessionDisplayTitle(sessionId);
      if (!window.confirm('Remove session "' + title + '" from active lists? Its append-only history remains stored, but this console does not currently provide a restore action.')) return;
      await api("/sessions/" + encodeURIComponent(sessionId), { method: "DELETE" });
      if (state.activeChatId === sessionId) {
        state.activeChatId = "";
        state.messages = [];
        $("chat-title").textContent = "New chat";
        $("chat-subtitle").textContent = "Your local assistant";
      }
      if (state.selectedSessionId === sessionId) {
        state.selectedSessionId = "";
        $("session-transcript").innerHTML = '<div class="empty-state"><strong>Select a session</strong><span>Its messages and model route will appear here.</span></div>';
      }
      await refreshSessions();
      await refreshRuns();
    }

    function renderChatMessages(messages) {
      return renderChatMessagesView($, messages, providerReady(state.status));
    }

    async function createChat(title = "New chat") {
      const selectedProject = state.projects.find((project) => project.id === state.selectedProjectId && project.status === "active");
      const session = await api("/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, source: "console-chat", tags: ["chat"], projectId: selectedProject?.id || "project_default" })
      });
      state.activeChatId = session.id;
      state.selectedSessionId = session.id;
      await loadChat(session.id);
      await refreshSessions();
      await refreshRuns();
      return session;
    }

    async function loadChat(sessionId) {
      const detail = await api("/sessions/" + encodeURIComponent(sessionId));
      state.activeChatId = sessionId;
      state.selectedSessionId = sessionId;
      state.messages = detail.messages || [];
      $("chat-title").textContent = detail.session?.title || "Untitled chat";
      $("chat-subtitle").textContent = detail.session?.projectId && detail.session.projectId !== "project_default"
        ? "Saved with a project"
        : "Saved in this workspace";
      renderChatMessages(state.messages);
    }

    async function ensureChat() {
      if (state.activeChatId) return state.activeChatId;
      const session = await createChat("New chat");
      return session.id;
    }

    function suggestedChatTitle(content) {
      return suggestedChatTitleView(content);
    }

    async function sendChatMessage(text, options = {}) {
      const plainText = String(text || "").trim();
      const attachments = options.tool === "job.healthcheck" ? [] : chatAttachments;
      const content = composeMessageWithLocalAttachments(plainText, attachments);
      if (!content) return;
      if (options.tool !== "job.healthcheck" && !providerReady(state.status)) {
        showOutput("Connect a model provider with odinn onboard, then refresh before sending a message.");
        return;
      }
      $("chat-status").textContent = "Thinking";
      $("chat-tool-progress").hidden = true;
      $("chat-tool-progress").replaceChildren();
      const sessionId = await ensureChat();
      const currentTitle = $("chat-title").textContent.trim();
      if (!state.messages.length && ["Gateway chat", "Chat", "New chat"].includes(currentTitle)) {
        const title = suggestedChatTitle(plainText || attachments.map((attachment) => attachment.name).join(", "));
        if (title) {
          await api("/sessions/" + encodeURIComponent(sessionId), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title, source: "console-chat-auto-title" })
          });
        }
      }
      await api("/sessions/" + encodeURIComponent(sessionId) + "/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "user", content, source: "console-chat" })
      });
      const toolRequest = options.tool === "job.healthcheck"
          ? { tool: "job.healthcheck", input: {} }
        : {
            tool: state.status?.allowedTools?.includes("agent.run") ? "agent.run" : "model.chat",
            input: {
              model: state.modelOverride || state.status?.defaultModel,
              sessionId,
              messages: [...state.messages, { role: "user", content }]
                .filter((message) => ["user", "assistant", "system", "tool"].includes(message.role))
                .map((message) => ({ role: message.role, content: message.content }))
            }
          };
      let streamed = "";
      if (options.tool !== "job.healthcheck") {
        state.messages = [...state.messages, { role: "user", content }, { role: "assistant", content: "" }];
        renderChatMessages(state.messages);
      }
      const result = options.tool === "job.healthcheck"
        ? await api("/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(toolRequest) })
        : await streamApi(
            "/run/stream",
            { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(toolRequest) },
            (delta) => {
              streamed += delta;
              state.messages[state.messages.length - 1].content = streamed;
              renderChatMessages(state.messages);
            },
            (progress) => {
              $("chat-status").textContent = toolCallStatus(progress);
              if (progress.tool || progress.stage === "page-opened") {
                $("chat-tool-progress").hidden = false;
                $("chat-tool-progress").innerHTML = renderToolCall({
                  ...progress,
                  tool: progress.tool || "browser.open"
                });
              }
            }
          );
      const reply = options.tool === "job.healthcheck"
        ? "System check passed. Ódinn is working normally."
        : result.output.content;
      const durableProjection = result.output?.durableSessionProjection;
      const retainLiveOnly = durableProjection?.schemaVersion === 1
        && durableProjection?.mode === "live-only-provider-read"
        && durableProjection?.contentUnavailable === true
        && typeof durableProjection?.content === "string"
        && /^sha256:[a-f0-9]{64}$/.test(String(durableProjection?.contentDigest || ""))
        && Number.isSafeInteger(durableProjection?.contentBytes)
        && durableProjection.contentBytes >= 0;
      await api("/sessions/" + encodeURIComponent(sessionId) + "/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "assistant",
          content: retainLiveOnly ? durableProjection.content : reply,
          source: "console-chat",
          ...(retainLiveOnly ? { contentRetention: {
            schemaVersion: 1,
            mode: "live-only-provider-read",
            contentUnavailable: true,
            contentDigest: durableProjection.contentDigest,
            contentBytes: durableProjection.contentBytes
          } } : {}),
          ...(options.tool === "job.healthcheck" ? {} : {
            model: result.output?.model,
            provider: result.output?.provider
          })
        })
      });
      $("chat-input").value = "";
      clearChatAttachments();
      $("chat-status").textContent = "Ready";
      await loadChat(sessionId);
      await refreshSessions();
      await refreshRuns();
      if (result.output?.pendingApproval) await refreshApprovals();
      showOutput(result);
    }

    function renderRecord(record, title, meta, attrs) {
      return '<div class="item clickable" role="button" tabindex="0" ' + (attrs || "") + '>' +
        '<div class="item-line"><span class="item-title">' + renderItemText(title, "Untitled") + '</span>' +
        '<span class="muted">' + renderItemText(record.status || record.type || "", "") + '</span></div>' +
        '<div>' + renderItemText(record.text || record.rationale || record.description || record.content || "", "") + '</div>' +
        '<div class="muted">' + renderItemText(meta, "") + '</div>' +
      '</div>';
    }

    function renderWebResult(result) {
      return '<div class="item web-result"><div class="item-line"><a href="' + escapeHtml(safeHref(result.url)) + '" target="_blank" rel="noreferrer noopener">' + escapeHtml(result.title || result.url) + '</a><span class="chip">web</span></div><p>' + escapeHtml(result.snippet || "No snippet available.") + '</p><div class="muted">' + escapeHtml(result.url || "") + '</div></div>';
    }

    function renderBrowserTab(tab) {
      return '<div class="item browser-tab" role="button" tabindex="0" data-browser-tab-id="' + escapeHtml(tab.id) + '"><div class="item-line"><strong>' + escapeHtml(tab.title || "Untitled page") + '</strong><span class="chip">open</span></div><div class="muted">' + escapeHtml(tab.url || "about:blank") + '</div></div>';
    }

    function renderApproval(approval) {
      return renderApprovalView(approval, friendlyArea);
    }

    async function refreshApprovals() {
      const approvals = await api("/approvals");
      state.approvals = approvals;
      $("cap-approval-count").textContent = approvals.length;
      $("approval-list").innerHTML = approvals.map(renderApproval).join("") || '<div class="empty-state"><strong>Nothing is waiting</strong><span>Ódinn will pause before changing an external account.</span></div>';
    }

    async function refreshBrowser() {
      try {
        const result = await api("/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "browser.tabs", input: {} }) });
        const tabs = result.output?.tabs || [];
        $("browser-tabs").innerHTML = tabs.map(renderBrowserTab).join("") || '<div class="empty-state"><strong>Browser is waiting</strong><span>Open a site to begin.</span></div>';
        if (!state.browserTabId && tabs[0]) state.browserTabId = tabs[0].id;
        if (state.browserTabId) await inspectBrowserTab(state.browserTabId);
        $("cap-browser-status").textContent = "READY";
      } catch (error) {
        $("cap-browser-status").textContent = "OFFLINE";
        showOutput(error.message);
      }
    }

    async function inspectBrowserTab(tabId) {
      const result = await api("/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "browser.snapshot", input: { tabId } }) });
      state.browserTabId = tabId;
      $("browser-page-title").textContent = result.output?.title || "Untitled page";
      $("browser-page-url").textContent = result.output?.url || "—";
      $("browser-page-text").textContent = result.output?.text || "No visible page text.";
    }

    async function runWebSearch() {
      const query = $("web-search-query").value.trim();
      if (!query) return;
      setBusy($("web-search-run"), true);
      try {
        const result = await api("/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "web.search", input: { query, limit: 6 } }) });
        $("web-search-results").innerHTML = (result.output?.results || []).map(renderWebResult).join("") || '<div class="empty-state"><strong>No results</strong><span>Try a broader query.</span></div>';
        showOutput(result);
      } catch (error) { showOutput(error.message); }
      finally { setBusy($("web-search-run"), false); }
    }

    async function runGatewatchPreview() {
      const button = $("gatewatch-preview-run");
      setBusy(button, true);
      try {
        const parentCapabilities = configLines($("gatewatch-preview-parent").value);
        const requestedCapabilities = configLines($("gatewatch-preview-requested").value);
        const body = {
          toolName: $("gatewatch-preview-tool").value,
          input: JSON.parse($("gatewatch-preview-input").value || "{}"),
          ...(parentCapabilities.length ? { parentCapabilities } : {}),
          ...(requestedCapabilities.length ? { requestedCapabilities } : {}),
          skillCapabilities: configLines($("gatewatch-preview-skill").value),
          mcpCapabilities: configLines($("gatewatch-preview-mcp").value)
        };
        const result = await api("/gatewatch/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
        $("gatewatch-preview-output").textContent = JSON.stringify(result, null, 2);
        showOutput(result);
      } catch (error) {
        $("gatewatch-preview-output").textContent = error.message;
        showOutput(error.message);
      } finally {
        setBusy(button, false);
      }
    }

    async function openBrowserUrl() {
      const url = $("browser-url").value.trim();
      if (!url) return;
      setBusy($("browser-open"), true);
      try {
        const result = await api("/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "browser.open", input: { url, tabId: state.browserTabId || undefined } }) });
        state.browserTabId = result.output?.id || state.browserTabId;
        await refreshBrowser();
        showOutput(result);
      } catch (error) { showOutput(error.message); }
      finally { setBusy($("browser-open"), false); }
    }

    async function approveAction(id) {
      const approval = (state.approvals || []).find((candidate) => candidate.id === id);
      const effect = approval?.effect || {};
      if (!window.confirm("Approve this effect once?\n\n" + String(effect.summary || "Review the bounded effect details before deciding.") + "\n\nCapability: " + String(effect.capability || approval?.tool || "unknown") + ".")) return;
      if (effect.reversible !== "reversible" || effect.idempotency !== "idempotent") {
        if (window.prompt("This effect is irreversible or its outcome is uncertain. Type APPROVE to continue.") !== "APPROVE") return;
      }
      const result = await api("/approvals/" + encodeURIComponent(id) + "/approve", { method: "POST" });
      await refreshApprovals();
      await refreshBrowser();
      showOutput(result);
    }

    async function denyAction(id) {
      const result = await api("/approvals/" + encodeURIComponent(id) + "/deny", { method: "POST" });
      await refreshApprovals();
      showOutput(result);
    }

    function cloneConfig(value) {
      return cloneStructuredConfig(value && typeof value === "object" ? value : {});
    }

    function configLines(value) {
      return structuredConfigLines(value);
    }

    function configNumber(value, fallback) {
      return structuredConfigNumber(value, fallback);
    }

    function configField(container, name) {
      return container.querySelector('[data-config-field="' + name + '"]');
    }

    function selectedOption(value, current) {
      return String(value) === String(current) ? " selected" : "";
    }

    function renderOptions(values, current) {
      const options = values.map((value) => '<option value="' + escapeHtml(value) + '"' + selectedOption(value, current) + '>' + escapeHtml(value) + '</option>');
      if (current && !values.includes(current)) options.unshift('<option value="' + escapeHtml(current) + '" selected>' + escapeHtml(current) + '</option>');
      return options.join("");
    }

    function renderAuthParams(params) {
      return Object.entries(params && typeof params === "object" && !Array.isArray(params) ? params : {}).map(([key, value]) => `
        <div class="config-list-row" data-auth-param-row>
          <div class="grid-2"><div class="field"><label>Parameter name</label><input data-auth-param-key value="${escapeHtml(key)}" autocomplete="off"></div><div class="field"><label>Value</label><input data-auth-param-value value="${escapeHtml(value)}" autocomplete="off"></div></div>
          <button class="danger-button" data-remove-auth-param type="button" aria-label="Remove OAuth authorization parameter">Remove</button>
        </div>`).join("");
    }

    function renderProviderForm(name, provider = {}) {
      const auth = provider.auth && typeof provider.auth === "object" ? provider.auth : {};
      return `
        <article class="config-card" data-provider-card data-original-name="${escapeHtml(name)}">
          <div class="config-card-head"><div><h3>Provider</h3><p>Configure the connection metadata. Never paste an API key or OAuth token here.</p></div><button class="danger-button" data-remove-provider type="button">Remove provider</button></div>
          <div class="grid-2">
            <div class="field"><label>Provider name</label><input data-provider-field="name" value="${escapeHtml(name)}" placeholder="openai" autocomplete="off"></div>
            <div class="field"><label>Provider type</label><select data-provider-field="type">${renderOptions(["openai-compatible", "cli"], provider.type || "openai-compatible")}</select></div>
            <div class="field"><label>Base URL</label><input data-provider-field="baseUrl" value="${escapeHtml(provider.baseUrl || "")}" placeholder="https://api.example.com/v1" autocomplete="off"></div>
            <div class="field"><label>API key environment variable</label><input data-provider-field="apiKeyEnv" value="${escapeHtml(provider.apiKeyEnv || "")}" placeholder="OPENAI_API_KEY" autocomplete="off"></div>
            <div class="field"><label>Transport</label><input data-provider-field="transport" value="${escapeHtml(provider.transport || "")}" placeholder="openai-chat-completions" autocomplete="off"></div>
            <div class="field"><label>Models</label><textarea data-provider-field="models" rows="3" placeholder="gpt-4.1-mini\none-model-per-line">${escapeHtml(Array.isArray(provider.models) ? provider.models.join("\n") : "")}</textarea></div>
          </div>
          <div class="config-subsection">
            <div><h3>Authentication</h3><p class="config-help">Select the authentication flow for this provider. Secrets remain in the environment or private OAuth store.</p></div>
            <div class="grid-2">
              <div class="field"><label>Authentication mode</label><select data-provider-auth="mode">${renderOptions(["api-key", "oauth", "device", "cli"], auth.mode || "api-key")}</select></div>
              <div class="field"><label>Authentication flow</label><input data-provider-auth="flow" value="${escapeHtml(auth.flow || "")}" placeholder="generic-pkce" autocomplete="off"></div>
              <div class="field"><label>Authorization URL</label><input data-provider-auth="authorizationUrl" value="${escapeHtml(auth.authorizationUrl || "")}" placeholder="https://login.example.com/authorize" autocomplete="off"></div>
              <div class="field"><label>Token URL</label><input data-provider-auth="tokenUrl" value="${escapeHtml(auth.tokenUrl || "")}" placeholder="https://login.example.com/token" autocomplete="off"></div>
              <div class="field"><label>Client ID</label><input data-provider-auth="clientId" value="${escapeHtml(auth.clientId || "")}" autocomplete="off"></div>
              <div class="field"><label>Client ID environment variable</label><input data-provider-auth="clientIdEnv" value="${escapeHtml(auth.clientIdEnv || "")}" autocomplete="off"></div>
              <div class="field"><label>Client secret environment variable</label><input data-provider-auth="clientSecretEnv" value="${escapeHtml(auth.clientSecretEnv || "")}" autocomplete="off"></div>
              <div class="field"><label>CLI command environment variable</label><input data-provider-auth="commandEnv" value="${escapeHtml(auth.commandEnv || "")}" placeholder="ODINN_ANTIGRAVITY_CLI" autocomplete="off"><span class="config-help">Used when authentication mode is CLI.</span></div>
              <div class="field"><label>Scopes</label><textarea data-provider-auth="scopes" rows="3" placeholder="openid\noffline_access">${escapeHtml(Array.isArray(auth.scopes) ? auth.scopes.join("\n") : "")}</textarea></div>
              <div class="field"><label>Redirect URI</label><input data-provider-auth="redirectUri" value="${escapeHtml(auth.redirectUri || "")}" placeholder="http://localhost:1455/auth/callback" autocomplete="off"></div>
              <div class="field"><label>OAuth token filename</label><input data-provider-auth="tokenFile" value="${escapeHtml(auth.tokenFile || "")}" placeholder="oauth/provider.json" autocomplete="off"></div>
            </div>
            <div class="config-subsection"><div><h3>Authorization parameters</h3><p class="config-help">Optional name/value pairs added to the authorization request.</p></div><div class="config-list" data-auth-params>${renderAuthParams(auth.authorizationParams)}</div><button class="secondary" data-add-auth-param type="button">Add authorization parameter</button></div>
          </div>
        </article>`;
    }

    function renderChannelForm(name, channel = {}) {
      return `
        <article class="config-card" data-channel-card data-original-name="${escapeHtml(name)}">
          <div class="config-card-head"><div><h3>Messaging channel</h3><p>Only allowlisted user or conversation identifiers can reach this bot.</p></div><button class="danger-button" data-remove-channel type="button">Remove channel</button></div>
          <div class="grid-2">
            <div class="field"><label>Channel name</label><input data-channel-field="name" value="${escapeHtml(name)}" placeholder="personal" autocomplete="off"></div>
            <div class="field"><label>Type</label><select data-channel-field="type">${renderOptions(["telegram", "discord", "slack", "teams", "whatsapp"], channel.type || "telegram")}</select></div>
            <div class="field"><label>Bot token environment variable</label><input data-channel-field="tokenEnv" value="${escapeHtml(channel.tokenEnv || "")}" placeholder="ODINN_TELEGRAM_BOT_TOKEN" autocomplete="off"></div>
            <div class="field"><label>Slack app token environment</label><input data-channel-field="appTokenEnv" value="${escapeHtml(channel.appTokenEnv || "")}" placeholder="ODINN_SLACK_APP_TOKEN" autocomplete="off"></div>
            <div class="field"><label>Teams app ID environment</label><input data-channel-field="appIdEnv" value="${escapeHtml(channel.appIdEnv || "")}" placeholder="ODINN_TEAMS_APP_ID" autocomplete="off"></div>
            <div class="field"><label>Teams tenant ID environment</label><input data-channel-field="tenantIdEnv" value="${escapeHtml(channel.tenantIdEnv || "")}" placeholder="ODINN_TEAMS_TENANT_ID" autocomplete="off"></div>
            <div class="field"><label>WhatsApp app secret environment</label><input data-channel-field="appSecretEnv" value="${escapeHtml(channel.appSecretEnv || "")}" placeholder="ODINN_WHATSAPP_APP_SECRET" autocomplete="off"></div>
            <div class="field"><label>WhatsApp verify token environment</label><input data-channel-field="verifyTokenEnv" value="${escapeHtml(channel.verifyTokenEnv || "")}" placeholder="ODINN_WHATSAPP_VERIFY_TOKEN" autocomplete="off"></div>
            <div class="field"><label>WhatsApp phone number ID</label><input data-channel-field="phoneNumberId" value="${escapeHtml(channel.phoneNumberId || "")}" autocomplete="off"></div>
            <div class="field"><label>WhatsApp Graph API version</label><input data-channel-field="apiVersion" value="${escapeHtml(channel.apiVersion || "v23.0")}" autocomplete="off"></div>
            <div class="field"><label>Default model override</label><input data-channel-field="defaultModel" value="${escapeHtml(channel.defaultModel || "")}" placeholder="provider:model" autocomplete="off"></div>
            <div class="field"><label>History limit</label><input data-channel-field="historyLimit" type="number" min="1" max="200" value="${escapeHtml(channel.historyLimit || 40)}"></div>
            <div class="field"><label>Native command name</label><input data-channel-field="nativeCommandName" value="${escapeHtml(channel.nativeCommandName || "odinn")}" autocomplete="off"></div>
            <div class="field"><label>Discord DM policy</label><select data-channel-field="dmPolicy">${renderOptions(["disabled", "allowlist", "open"], channel.dmPolicy || "allowlist")}</select></div>
            <div class="field"><label>Discord server policy</label><select data-channel-field="groupPolicy">${renderOptions(["disabled", "allowlist", "open"], channel.groupPolicy || "allowlist")}</select></div>
            <div class="field"><label>Discord bot messages</label><select data-channel-field="allowBots">${renderOptions(["false", "mentions", "true"], String(channel.allowBots ?? false))}</select></div>
          </div>
          <div class="field"><label>Allowlist</label><textarea data-channel-field="allowlist" rows="4" placeholder="discord:123456789&#10;telegram:123456789">${escapeHtml(Array.isArray(channel.allowlist) ? channel.allowlist.join("\n") : "")}</textarea><span class="config-help">One platform user or conversation entry per line. Empty means nobody is allowed.</span></div>
          <div class="field"><label>Discord guild policy JSON</label><textarea data-channel-field="guilds" rows="7" spellcheck="false">${escapeHtml(JSON.stringify(channel.guilds || {}, null, 2))}</textarea><span class="config-help">Optional guild, channel, user, role, and mention rules keyed by numeric Discord IDs.</span></div>
          <label class="switch-label"><input data-channel-field="enabled" type="checkbox"${channel.enabled === true ? " checked" : ""}> Enable after gateway restart</label>
          <label class="switch-label"><input data-channel-field="requireMention" type="checkbox"${channel.requireMention !== false ? " checked" : ""}> Require an @mention in group/server channels</label>
          <label class="switch-label"><input data-channel-field="nativeCommands" type="checkbox"${channel.nativeCommands === true ? " checked" : ""}> Register native bot commands</label>
        </article>`;
    }

    function renderInvariantForm(invariant = {}) {
      return `<div class="config-card" data-invariant-row><div class="config-list-row"><div class="grid-2"><div class="field"><label>Invariant ID</label><input data-invariant-field="id" value="${escapeHtml(invariant.id || "")}" placeholder="deny-shell" autocomplete="off"></div><div class="field"><label>Type</label><select data-invariant-field="type">${renderOptions(["command.deny-pattern", "tool.requires-approval", "filesystem.allowed-roots"], invariant.type || "command.deny-pattern")}</select></div><div class="field"><label>Values</label><textarea data-invariant-field="values" rows="3" placeholder="One value per line">${escapeHtml(Array.isArray(invariant.values) ? invariant.values.join("\n") : "")}</textarea></div><div class="field"><label>Enforcement</label><select data-invariant-field="enforcement">${renderOptions(["log", "warn", "pause", "block", "rollback", "terminate"], invariant.enforcement || "block")}</select></div></div><button class="danger-button" data-remove-invariant type="button">Remove</button></div></div>`;
    }

    function renderProofCommand(command = []) {
      return `<div class="config-list-row" data-proof-command><div class="field"><label>Exact command arguments</label><textarea data-command-args rows="3" placeholder="/usr/bin/git\nstatus\n--short">${escapeHtml(Array.isArray(command) ? command.join("\n") : "")}</textarea></div><button class="danger-button" data-remove-command type="button">Remove</button></div>`;
    }

    function renderConfigForm(config) {
      const value = cloneConfig(config);
      const policy = value.policy || {};
      const security = policy.security || {};
      const web = security.web || {};
      const browser = security.browser || {};
      const experimental = value.experimental || {};
      const selfImprovement = value.selfImprovement || {};
      const memory = value.memory || {};
      $("config-version").value = configNumber(value.version, 1);
      $("config-audit-log").value = value.auditLog || "audit.jsonl";
      $("config-default-model").value = value.defaultModel || "";
      $("config-policy-max-input").value = configNumber(policy.maxInputBytes, 16384);
      $("config-policy-id").value = policy.id || "";
      $("config-policy-version").value = policy.version || "";
      $("config-policy-allowed").value = Array.isArray(policy.allowedCapabilities) ? policy.allowedCapabilities.join("\n") : "";
      $("config-policy-denied").value = Array.isArray(policy.deniedTools) ? policy.deniedTools.join("\n") : "";
      for (const [surface, source] of [["web", web], ["browser", browser]]) {
        for (const key of ["enabled", "allowPrivateNetwork", "requireApproval", "allowDownloads", "allowUploads"]) {
          const input = document.querySelector('[data-config-security="' + surface + "." + key + '"]');
          if (input) input.checked = source[key] === true;
        }
        for (const key of ["allowedDomains", "blockedDomains"]) {
          const input = document.querySelector('[data-config-security-list="' + surface + "." + key + '"]');
          if (input) input.value = Array.isArray(source[key]) ? source[key].join("\n") : "";
        }
      }
      for (const key of ["capabilities", "capsules", "counterfactual"]) {
        const input = document.querySelector('[data-config-experimental="' + key + '"]');
        if (input) input.checked = experimental[key] === true;
      }
      for (const key of ["enabled", "rollbackOnFailure"]) {
        const input = document.querySelector('[data-config-self="' + key + '"]');
        if (input) input.checked = selfImprovement[key] !== false;
      }
      $("config-self-mode").value = selfImprovement.mode || "propose";
      $("config-self-interval").value = configNumber(selfImprovement.intervalMs, 300000);
      $("config-self-max").value = configNumber(selfImprovement.maxChangesPerCycle, 1);
      $("config-runtime-retries").value = configNumber(value.runtime?.modelRetries, 0);
      for (const key of ["autoRecall", "autoLearn", "autoCompact"]) {
        const input = document.querySelector('[data-config-memory="' + key + '"]');
        if (input) input.checked = memory[key] !== false;
      }
      $("config-providers").innerHTML = Object.entries(value.providers || {}).map(([name, provider]) => renderProviderForm(name, provider)).join("") || '<div class="empty-state"><strong>No providers configured</strong><span>Add a provider to make model conversations available.</span></div>';
      $("config-channels").innerHTML = Object.entries(value.channels || {}).map(([name, channel]) => renderChannelForm(name, channel)).join("") || '<div class="empty-state"><strong>No messaging channels configured</strong><span>Add Telegram when you want to talk to Ódinn outside this console.</span></div>';
      $("config-invariants").innerHTML = (Array.isArray(policy.invariants) ? policy.invariants : []).map(renderInvariantForm).join("") || '<div class="empty-state"><strong>No Gatewatch rules</strong><span>Add a rule only when you need a policy check beyond the default capability controls.</span></div>';
      $("config-proof-commands").innerHTML = (Array.isArray(value.proof?.allowedCommands) ? value.proof.allowedCommands : []).map(renderProofCommand).join("") || '<div class="empty-state"><strong>No Runemark commands allowed</strong><span>Runemark command checks remain unavailable until you add an exact executable argument vector.</span></div>';
      $("config-field-count").textContent = "Advanced and unknown fields are preserved but are not all shown here.";
    }

    function readStructuredConfig() {
      const config = cloneConfig(state.config || {});
      config.version = configNumber($("config-version").value, 1);
      config.auditLog = $("config-audit-log").value.trim();
      config.defaultModel = $("config-default-model").value.trim();
      const policy = { ...(config.policy || {}) };
      policy.maxInputBytes = configNumber($("config-policy-max-input").value, 16384);
      const policyId = $("config-policy-id").value.trim();
      if (policyId) policy.id = policyId; else delete policy.id;
      const policyVersion = $("config-policy-version").value.trim();
      if (policyVersion) policy.version = configNumber(policyVersion, 1); else delete policy.version;
      policy.allowedCapabilities = configLines($("config-policy-allowed").value);
      policy.deniedTools = configLines($("config-policy-denied").value);
      policy.security = { ...(policy.security || {}) };
      for (const surface of ["web", "browser"]) {
        const current = { ...(policy.security[surface] || {}) };
        for (const key of ["enabled", "allowPrivateNetwork", "requireApproval", "allowDownloads", "allowUploads"]) {
          const input = document.querySelector('[data-config-security="' + surface + "." + key + '"]');
          if (input) current[key] = input.checked;
        }
        for (const key of ["allowedDomains", "blockedDomains"]) {
          const input = document.querySelector('[data-config-security-list="' + surface + "." + key + '"]');
          current[key] = configLines(input?.value);
        }
        policy.security[surface] = current;
      }
      policy.invariants = Array.from(document.querySelectorAll("[data-invariant-row]")).map((row) => ({
        id: row.querySelector('[data-invariant-field="id"]').value.trim(),
        type: row.querySelector('[data-invariant-field="type"]').value,
        values: configLines(row.querySelector('[data-invariant-field="values"]').value),
        enforcement: row.querySelector('[data-invariant-field="enforcement"]').value
      }));
      config.policy = policy;
      config.experimental = { ...(config.experimental || {}) };
      for (const key of ["capabilities", "capsules", "counterfactual"]) config.experimental[key] = document.querySelector('[data-config-experimental="' + key + '"]').checked;
      config.selfImprovement = { ...(config.selfImprovement || {}) };
      for (const key of ["enabled", "rollbackOnFailure"]) config.selfImprovement[key] = document.querySelector('[data-config-self="' + key + '"]').checked;
      config.selfImprovement.mode = $("config-self-mode").value;
      config.selfImprovement.intervalMs = configNumber($("config-self-interval").value, 300000);
      config.selfImprovement.maxChangesPerCycle = configNumber($("config-self-max").value, 1);
      config.runtime = { ...(config.runtime || {}), modelRetries: configNumber($("config-runtime-retries").value, 0) };
      config.memory = { ...(config.memory || {}) };
      for (const key of ["autoRecall", "autoLearn", "autoCompact"]) config.memory[key] = document.querySelector('[data-config-memory="' + key + '"]').checked;
      const providers = {};
      for (const card of document.querySelectorAll("[data-provider-card]")) {
        const name = card.querySelector('[data-provider-field="name"]').value.trim();
        if (!name) throw new Error("Every provider needs a name.");
        if (providers[name]) throw new Error("Provider names must be unique: " + name);
        const original = config.providers?.[card.dataset.originalName] || {};
        const provider = { ...original, type: card.querySelector('[data-provider-field="type"]').value, models: configLines(card.querySelector('[data-provider-field="models"]').value) };
        for (const key of ["baseUrl", "apiKeyEnv", "transport"]) {
          const input = card.querySelector('[data-provider-field="' + key + '"]');
          if (input.value.trim()) provider[key] = input.value.trim(); else delete provider[key];
        }
        const auth = { ...(provider.auth || {}) };
        for (const key of ["mode", "flow", "authorizationUrl", "tokenUrl", "clientId", "clientIdEnv", "clientSecretEnv", "commandEnv", "redirectUri", "tokenFile"]) {
          const input = card.querySelector('[data-provider-auth="' + key + '"]');
          if (input.value.trim()) auth[key] = input.value.trim(); else delete auth[key];
        }
        auth.scopes = configLines(card.querySelector('[data-provider-auth="scopes"]').value);
        const authorizationParams = {};
        for (const row of card.querySelectorAll("[data-auth-param-row]")) {
          const key = row.querySelector("[data-auth-param-key]").value.trim();
          const value = row.querySelector("[data-auth-param-value]").value;
          if (key) authorizationParams[key] = value;
        }
        auth.authorizationParams = authorizationParams;
        provider.auth = auth;
        providers[name] = provider;
      }
      config.providers = providers;
      const channels = {};
      for (const card of document.querySelectorAll("[data-channel-card]")) {
        const name = card.querySelector('[data-channel-field="name"]').value.trim();
        if (!name) throw new Error("Every messaging channel needs a name.");
        if (channels[name]) throw new Error("Messaging channel names must be unique: " + name);
        let guilds;
        try {
          guilds = JSON.parse(card.querySelector('[data-channel-field="guilds"]').value || "{}");
        } catch {
          throw new Error("Discord guild policy must be valid JSON for channel " + name + ".");
        }
        const allowBots = card.querySelector('[data-channel-field="allowBots"]').value;
        channels[name] = {
          type: card.querySelector('[data-channel-field="type"]').value,
          enabled: card.querySelector('[data-channel-field="enabled"]').checked,
          requireMention: card.querySelector('[data-channel-field="requireMention"]').checked,
          nativeCommands: card.querySelector('[data-channel-field="nativeCommands"]').checked,
          nativeCommandName: card.querySelector('[data-channel-field="nativeCommandName"]').value.trim() || "odinn",
          historyLimit: Number(card.querySelector('[data-channel-field="historyLimit"]').value || 40),
          dmPolicy: card.querySelector('[data-channel-field="dmPolicy"]').value,
          groupPolicy: card.querySelector('[data-channel-field="groupPolicy"]').value,
          allowBots: allowBots === "mentions" ? "mentions" : allowBots === "true",
          ...(Object.keys(guilds).length ? { guilds } : {}),
          tokenEnv: card.querySelector('[data-channel-field="tokenEnv"]').value.trim(),
          appTokenEnv: card.querySelector('[data-channel-field="appTokenEnv"]').value.trim(),
          appIdEnv: card.querySelector('[data-channel-field="appIdEnv"]').value.trim(),
          tenantIdEnv: card.querySelector('[data-channel-field="tenantIdEnv"]').value.trim(),
          appSecretEnv: card.querySelector('[data-channel-field="appSecretEnv"]').value.trim(),
          verifyTokenEnv: card.querySelector('[data-channel-field="verifyTokenEnv"]').value.trim(),
          phoneNumberId: card.querySelector('[data-channel-field="phoneNumberId"]').value.trim(),
          apiVersion: card.querySelector('[data-channel-field="apiVersion"]').value.trim() || "v23.0",
          allowlist: configLines(card.querySelector('[data-channel-field="allowlist"]').value),
          ...(card.querySelector('[data-channel-field="defaultModel"]').value.trim() ? { defaultModel: card.querySelector('[data-channel-field="defaultModel"]').value.trim() } : {})
        };
      }
      config.channels = channels;
      const commands = Array.from(document.querySelectorAll("[data-proof-command]")).map((row) => configLines(row.querySelector("[data-command-args]").value)).filter((command) => command.length);
      config.proof = { ...(config.proof || {}), allowedCommands: commands };
      return config;
    }

    function renderConfigState(message = "") {
      const restartRequired = state.configRestartRequired === true;
      $("config-state").textContent = restartRequired ? "Restart required" : "Loaded";
      $("config-state").className = "chip " + (restartRequired ? "warn" : "ok");
      $("config-restart").hidden = !restartRequired;
      $("config-restart-title").textContent = message || "Restart required";
      $("config-restart-copy").textContent = "Restart the Ódinn gateway when you are ready to apply these settings.";
    }

    async function refreshConfig() {
      $("config-error").textContent = "";
      const result = await api("/config");
      state.configFingerprint = result.fingerprint;
      state.configRestartRequired = result.restartRequired === true;
      state.config = result.config;
      renderConfigForm(result.config);
      renderConfigState();
    }

    async function saveConfig() {
      const button = $("save-config");
      $("config-error").textContent = "";
      try {
        const config = readStructuredConfig();
        setBusy(button, true);
        const result = await api("/config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config, fingerprint: state.configFingerprint })
        });
        state.configFingerprint = result.fingerprint;
        state.configRestartRequired = result.restartRequired === true;
        state.config = result.config;
        renderConfigForm(result.config);
        renderConfigState("Configuration saved");
        showToast(state.configRestartRequired
          ? "Configuration saved. Restart the gateway to apply it."
          : "Configuration saved. No restart is needed.");
      } catch (error) {
        $("config-error").textContent = error.message;
        showToast(error.message, "error");
      } finally {
        setBusy(button, false);
      }
    }

    async function refresh() {
      try {
        const status = await api("/status");
        state.status = status;
        $("gatewatch-preview-tool").innerHTML = (status.toolDetails || []).map((tool) =>
          '<option value="' + escapeHtml(tool.name) + '">' + escapeHtml(tool.name) + ' · ' + escapeHtml((tool.capabilities || []).join(", ")) + '</option>'
        ).join("");
        renderExperimentalHome(status);
        $("nav-health").textContent = "online";
        $("status-pill").textContent = "Online";
        $("workspace").textContent = compactPath(status.workspaceRoot) + " | " + compactPath(status.state);
        $("status-workspace").textContent = status.workspaceRoot;
        $("status-state").textContent = status.state;
        $("tool-count").textContent = status.tools.length + " capabilities";
        $("product-version").textContent = "v" + (status.version || "development");
        $("provider-list").innerHTML = status.providers?.length
          ? status.providers.map(renderProvider).join("")
          : '<div class="empty-state"><strong>No providers connected</strong><span>Run <code>odinn onboard</code> in a terminal, then refresh this page.</span></div>';
        const modelSelect = $("model-select");
        const selectedModel = state.modelOverride || status.defaultModel;
        const readyProviderNames = new Set((status.providers || []).filter((provider) => provider.configured && (provider.models || []).length > 0).map((provider) => provider.name));
        const readyModels = (status.models || []).filter((model) => readyProviderNames.has(model.provider));
        modelSelect.innerHTML = readyModels.length
          ? readyModels.map((model) => '<option value="' + escapeHtml(model.id) + '">' + escapeHtml(model.id) + '</option>').join("")
          : '<option value="">Configure a provider first</option>';
        const resolvedModel = readyModels.some((model) => model.id === selectedModel)
          ? selectedModel
          : (readyModels[0]?.id || "");
        modelSelect.value = resolvedModel;
        if (state.modelOverride && resolvedModel !== state.modelOverride) state.modelOverride = "";
        if (resolvedModel && resolvedModel !== status.defaultModel) state.modelOverride = resolvedModel;
        const ready = readyModels.length > 0;
        $("model-chip").textContent = ready ? "provider ready" : "provider required";
        $("model-chip").className = "chip " + (ready ? "ok" : "warn");
        $("model-select").disabled = !ready;
        $("chat-input").disabled = !ready;
        $("send-chat").disabled = !ready;
        $("attach-chat-file").disabled = !ready;
        $("provider-cta").hidden = ready;
        $("chat-input").placeholder = ready ? "Message Ódinn Forge..." : "Connect a provider to start chatting";
        $("chat-status").textContent = ready ? "Ready" : "Provider required";
        $("metric-tools").textContent = status.tools.length;
        $("metric-policy").textContent = status.allowedCapabilities.length;
        $("runtime-chips").innerHTML = [
          '<span class="chip ok">online</span>',
          '<span class="chip">loopback</span>',
          '<span class="chip">' + escapeHtml(status.tools.length) + ' tools</span>',
          '<span class="chip">' + escapeHtml(status.allowedCapabilities.length) + ' caps</span>'
        ].join("");
        const webReady = status.security?.web?.enabled !== false && status.tools.includes("web.search");
        const browserReady = status.security?.browser?.enabled !== false && status.tools.includes("browser.tabs");
        const approvalRequired = status.security?.browser?.requireApproval !== false;
        $("cap-web-status").textContent = webReady ? "READY" : "OFF";
        $("cap-browser-status").textContent = browserReady ? "READY" : "OFF";
        $("cap-security-mode").textContent = approvalRequired ? "REVIEW" : "DIRECT";
        $("browser-approval-mode").textContent = approvalRequired ? "Approval required" : "Approval disabled";
        $("browser-approval-mode").className = "chip " + (approvalRequired ? "ok" : "warn");
        $("browser-approval-copy").textContent = approvalRequired
          ? "Clicks, typing, and key presses pause here for explicit approval."
          : "Browser actions can proceed without console approval under the current policy.";
        $("tool").innerHTML = status.tools.map((tool) => '<option value="' + escapeHtml(tool) + '">' + escapeHtml(tool) + '</option>').join("");
        $("cron-tool").innerHTML = status.tools.map((tool) => '<option value="' + escapeHtml(tool) + '">' + escapeHtml(tool) + '</option>').join("");
        $("tool-list").innerHTML = status.toolDetails.map((tool) => renderRecord(tool, tool.name, (tool.capabilities || []).join(", ") + " | " + tool.description)).join("");
        const background = [refreshRuns()];
        background.push((async () => {
          const canReadSessions = status.allowedTools.includes("session.list");
          const canReadGoals = status.allowedTools.includes("goal.list");
          if (canReadSessions && canReadGoals) await refreshProjects();
          if (canReadSessions) await refreshSessions();
          if (canReadGoals) await refreshGoals();
          if (status.allowedTools.includes("memory.browse")) await refreshMemory();
        })());
        await Promise.allSettled(background);
        await refreshApprovals();
      } catch (error) {
        $("nav-health").textContent = "error";
        $("status-pill").textContent = "Error";
        $("status-pill").className = "pill danger";
        showOutput(error.message);
      }
    }

    async function refreshRuns() {
      const runs = await api("/runs");
      state.runs = runs;
      $("metric-runs").textContent = runs.length;
      $("metric-completed").textContent = runs.filter((run) => run.status === "completed").length;
      $("runs").innerHTML = runs.slice(0, 4).map(renderRun).join("") || '<div class="muted">No runs yet.</div>';
      const planRuns = runs.filter((run) => run.tool === "plan" || String(run.id).startsWith("plan_"));
      $("run-history").innerHTML = runs.slice(0, 8).map(renderRun).join("") || '<div class="empty-state"><strong>No executions yet</strong><span>Run a capability to see its evidence here.</span></div>';
      $("plan-runs").innerHTML = planRuns.slice(0, 12).map(renderRun).join("") || '<div class="empty-state"><strong>No plan runs yet</strong><span>Choose a starter template and run it.</span></div>';
      $("plan-run-count").textContent = planRuns.length;
      $("plan-last-status").textContent = planRuns[0]?.status || "—";
    }

    async function refreshTasks() {
      const params = new URLSearchParams({
        includeSystem: String($("task-system-toggle")?.checked === true),
        page: String(state.taskPage || 1),
        pageSize: $("task-page-size")?.value || "25",
        status: $("task-status-filter")?.value || "all",
        category: $("task-category-filter")?.value || "all"
      });
      const query = $("task-query")?.value.trim();
      if (query) params.set("q", query);
      const data = await api("/tasks?" + params);
      state.tasks = data.tasks || [];
      state.taskPagination = data.pagination || { page: 1, pages: 1, total: state.tasks.length, from: 0, to: state.tasks.length };
      state.taskPage = state.taskPagination.page;
      for (const task of state.tasks) if (state.taskSelection.has(task.id)) state.taskSelection.set(task.id, task);
      renderTasks();
      $("task-total").textContent = data.summary.total;
      $("task-running").textContent = data.summary.running;
      $("task-passed").textContent = data.summary.completed;
      $("task-failed").textContent = data.summary.needsReview;
    }

    function renderTasks() {
      const tasks = state.tasks || [];
      $("task-table").innerHTML = tasks.map((task) => {
        const tone = task.status === "completed" ? "ok" : ["queued", "running", "cancelling", "awaiting_approval"].includes(task.status) ? "warn" : "danger";
        const record = task.evidenceCount ? task.evidenceCount + " checks" : task.eventCount + " updates";
        const checked = state.taskSelection.has(task.id) ? " checked" : "";
        const rowActions = '<button class="secondary" data-task-inspect="' + escapeHtml(task.id) + '" type="button">Inspect</button>' +
          (task.replayable ? '<button class="secondary" data-task-replay="' + escapeHtml(task.id) + '" type="button">Run again</button>' : "") +
          (task.cancellable ? '<button class="secondary" data-task-cancel="' + escapeHtml(task.id) + '" type="button">Stop</button>' : "");
        return '<div class="data-row task-row" data-task-id="' + escapeHtml(task.id) + '"><label class="task-select-label"><input data-task-select="' + escapeHtml(task.id) + '" type="checkbox"' + checked + '><span class="task-select-copy"><strong>' + escapeHtml(friendlyTaskTitle(task)) + '</strong><small>' + escapeHtml(friendlyArea(task.tool)) + '</small></span></label><span class="chip ' + tone + '">' + escapeHtml(friendlyStatus(task.status)) + '</span><span>' + escapeHtml(friendlyTaskOrigin(task.category)) + '</span><span class="muted">' + escapeHtml(relativeTime(task.updatedAt)) + (task.durationMs !== null ? '<small> · ' + escapeHtml(formatDuration(task.durationMs)) + '</small>' : '') + '</span><span>' + escapeHtml(record) + '</span><span class="row">' + rowActions + '</span></div>';
      }).join("") || '<div class="empty-state"><strong>No matching tasks</strong><span>There is no matching activity right now.</span></div>';
      const pagination = state.taskPagination || { page: 1, pages: 1, total: 0, from: 0, to: 0 };
      $("task-page-label").textContent = pagination.total ? "Page " + pagination.page + " of " + pagination.pages + " · " + pagination.from + "–" + pagination.to + " of " + pagination.total : "Page 1 of 1 · 0 tasks";
      $("task-prev").disabled = pagination.page <= 1;
      $("task-next").disabled = pagination.page >= pagination.pages;
      updateTaskManagement();
    }

    function updateTaskManagement() {
      const tasks = state.tasks || [];
      const selected = state.taskSelection.size;
      const selectedOnPage = tasks.filter((task) => state.taskSelection.has(task.id)).length;
      $("task-select-page").checked = tasks.length > 0 && selectedOnPage === tasks.length;
      $("task-select-page").indeterminate = selectedOnPage > 0 && selectedOnPage < tasks.length;
      $("task-selection-count").textContent = selected ? selected + " selected" : "No tasks selected";
      $("task-rerun-selected").disabled = !Array.from(state.taskSelection.values()).some((task) => task.replayable);
      $("task-cancel-selected").disabled = !Array.from(state.taskSelection.values()).some((task) => task.cancellable);
      $("task-clear-selection").disabled = selected === 0;
    }

    async function replayTask(id, { confirm = true } = {}) {
      const task = state.taskSelection.get(id) || (state.tasks || []).find((entry) => entry.id === id);
      if (!task?.replayable) return;
      if (confirm && !window.confirm('Run “' + friendlyTaskTitle(task) + '” again with the same saved input?')) return;
      return api("/runs/" + encodeURIComponent(id) + "/replay", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    }

    async function cancelTask(id, { confirm = true } = {}) {
      const task = state.taskSelection.get(id) || (state.tasks || []).find((entry) => entry.id === id);
      if (!task?.cancellable) return;
      if (confirm && !window.confirm('Stop “' + friendlyTaskTitle(task) + '”?')) return;
      return api("/jobs/" + encodeURIComponent(id) + "/cancel", { method: "POST" });
    }

    async function runSelectedTaskAction(action) {
      const eligible = Array.from(state.taskSelection.values()).filter((task) => action === "replay" ? task.replayable : task.cancellable);
      if (!eligible.length) return;
      const verb = action === "replay" ? "run again" : "stop";
      if (!window.confirm(verb.charAt(0).toUpperCase() + verb.slice(1) + " " + eligible.length + " selected " + (eligible.length === 1 ? "task" : "tasks") + "?")) return;
      const results = await Promise.allSettled(eligible.map((task) => action === "replay" ? replayTask(task.id, { confirm: false }) : cancelTask(task.id, { confirm: false })));
      const failures = results.filter((result) => result.status === "rejected");
      showOutput(failures.length ? (eligible.length - failures.length) + " completed; " + failures.length + " could not be changed." : eligible.length + (action === "replay" ? " tasks started again." : " tasks stopped."));
      state.taskSelection.clear();
      await refreshTasks();
    }

    function formatDuration(value) {
      if (!Number.isFinite(value)) return "—";
      if (value < 1000) return value + "ms";
      if (value < 60000) return (value / 1000).toFixed(1) + "s";
      return Math.floor(value / 60000) + "m " + Math.round(value % 60000 / 1000) + "s";
    }

    async function inspectTask(id) {
      const detail = await api("/tasks/" + encodeURIComponent(id));
      state.selectedTaskId = id;
      const task = detail.task || {};
      $("task-detail-label").textContent = friendlyTaskTitle(task);
      $("task-summary").innerHTML = [
        ["Outcome", friendlyStatus(task.status || "unknown")], ["Started by", friendlyTaskOrigin(task.category || task.actor || "unknown")],
        ["Duration", formatDuration(task.durationMs)], ["Run again", task.replayable ? "Available" : "Not available"]
      ].map(([label, value]) => '<div class="item"><div class="muted">' + escapeHtml(label) + '</div><strong>' + escapeHtml(value) + '</strong></div>').join("");
      $("task-evidence").innerHTML = (detail.run?.events || []).map((event) => '<div class="timeline-row"><span class="timeline-dot"></span><div class="item"><div class="item-line"><strong>' + escapeHtml(friendlyEventTitle(event)) + '</strong><span class="chip">' + escapeHtml(friendlyStatus(event.decision || "recorded")) + '</span></div><div class="muted">' + escapeHtml(relativeTime(event.at)) + '</div><div>' + escapeHtml(event.message || friendlyArea(event.tool) || "") + '</div></div></div>').join("") || '<div class="empty-state"><strong>No timeline yet</strong><span>This task has no recorded updates.</span></div>';
      $("task-verify").disabled = !detail.ledger;
      $("task-replay").disabled = !task.replayable;
      $("task-cancel").disabled = !task.cancellable;
    }

    async function refreshUsage() {
      const data = await api("/usage");
      const summary = data.summary || {};
      $("usage-total-tokens").textContent = Number(summary.totalTokens || 0).toLocaleString();
      $("usage-model-calls").textContent = summary.modelRuns || 0;
      $("metric-runs").textContent = summary.runs || 0;
      $("usage-errors").textContent = summary.errors || 0;
      const max = Math.max(1, ...(data.days || []).map((day) => day.events));
      $("usage-chart").innerHTML = (data.days || []).map((day) => '<span class="bar-column" title="' + escapeHtml(day.day + ': ' + day.events + ' events · ' + day.tokens + ' tokens') + '"><i class="bar-height-' + Math.max(3, Math.round(day.events / max * 165)) + '"></i><small>' + escapeHtml(day.day.slice(5)) + '</small></span>').join("");
      $("runs").innerHTML = (data.runs || []).slice(0, 4).map(renderRun).join("") || '<div class="empty-state"><strong>No model usage yet</strong><span>Completed model and agent runs will appear here.</span></div>';
    }

    async function refreshCron() {
      const data = await api("/cron");
      state.cronJobs = data.jobs || [];
      const query = $("cron-query")?.value.trim().toLowerCase() || "";
      const jobs = state.cronJobs.filter((job) => !query || JSON.stringify(job).toLowerCase().includes(query));
      $("cron-enabled").textContent = data.enabled ? "On" : "Off";
      $("cron-count").textContent = data.jobs.length;
      $("cron-next").textContent = data.nextWake ? new Date(data.nextWake).toLocaleString() : "—";
      $("cron-shown").textContent = jobs.length + " shown of " + data.jobs.length;
      $("cron-list").innerHTML = jobs.map((job) => '<div class="cron-card"><div class="item-line"><strong>' + escapeHtml(job.name) + '</strong><span class="chip ' + (job.lastStatus === "error" ? "danger" : job.enabled ? "ok" : "") + '">' + escapeHtml(job.enabled ? friendlyStatus(job.lastStatus || "active") : "Paused") + '</span></div><div class="cron-meta"><span>' + escapeHtml(describeSchedule(job.schedule, job.timezone)) + '</span><span>' + escapeHtml(friendlyArea(job.tool)) + '</span><span>Last run ' + escapeHtml(relativeTime(job.lastRunAt)) + '</span></div><div class="row"><button class="secondary" data-cron-run="' + escapeHtml(job.id) + '" type="button">Run now</button><button class="secondary" data-cron-toggle="' + escapeHtml(job.id) + '" data-enabled="' + escapeHtml(job.enabled) + '" type="button">' + (job.enabled ? "Pause" : "Resume") + '</button><button class="secondary" data-cron-delete="' + escapeHtml(job.id) + '" type="button">Delete</button></div></div>').join("") || '<div class="empty-state"><strong>No schedules yet</strong><span>Create one when you want Ódinn to repeat an action.</span></div>';
    }

    function describeSchedule(value, timezone) {
      const parts = String(value || "").trim().split(/s+/);
      if (parts.length !== 5) return "Custom schedule";
      const [minute, hour, day, month, weekday] = parts;
      const time = hour !== "*" && minute !== "*" ? new Date(2000, 0, 1, Number(hour), Number(minute)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
      const zone = timezone ? " · " + timezone.replace(/_/g, " ") : "";
      if (minute === "0" && hour === "*" && day === "*" && month === "*" && weekday === "*") return "Every hour" + zone;
      if (day === "*" && month === "*" && weekday === "1-5") return "Weekdays at " + time + zone;
      if (day === "*" && month === "*" && weekday === "*") return "Every day at " + time + zone;
      if (day === "*" && month === "*" && /^[0-6]$/.test(weekday)) {
        const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        return "Every " + days[Number(weekday)] + " at " + time + zone;
      }
      return "Custom schedule" + zone;
    }

    function updateSchedulePattern() {
      const frequency = $("cron-frequency").value;
      const [hour, minute] = ($("cron-time").value || "09:00").split(":");
      $("cron-weekday-field").hidden = frequency !== "weekly";
      $("cron-time-field").hidden = frequency === "hourly" || frequency === "custom";
      $("cron-custom-options").open = frequency === "custom";
      if (frequency === "custom") return;
      $("cron-schedule").value = frequency === "hourly"
        ? "0 * * * *"
        : frequency === "weekdays"
          ? minute + " " + hour + " * * 1-5"
          : frequency === "weekly"
            ? minute + " " + hour + " * * " + $("cron-weekday").value
            : minute + " " + hour + " * * *";
    }

    async function refreshAgents() {
      const data = await api("/agents");
      state.agents = data.agents || [];
      const query = $("agent-query")?.value.trim().toLowerCase() || "";
      const agents = state.agents.filter((agent) => !query || JSON.stringify(agent).toLowerCase().includes(query));
      $("agent-total").textContent = state.agents.length;
      $("agent-enabled").textContent = state.agents.filter((agent) => agent.status === "enabled").length;
      $("agent-quarantined").textContent = state.agents.filter((agent) => agent.status === "quarantined").length;
      $("agent-list").innerHTML = agents.map((agent) => '<div class="item agent-package ' + (agent.id === state.selectedAgentId ? "selected" : "") + '" role="button" tabindex="0" data-agent-id="' + escapeHtml(agent.id) + '"><div class="item-line"><strong>' + escapeHtml(agent.name) + '</strong><span class="chip ' + (agent.status === "enabled" ? "ok" : agent.status === "quarantined" ? "danger" : "") + '">' + escapeHtml(friendlyAgentStatus(agent.status)) + '</span></div><div class="muted">' + escapeHtml(agent.description || agent.identity?.description || "Specialized agent") + '</div><div class="chip-row"><span class="chip">' + escapeHtml((agent.tools || []).length + " action" + ((agent.tools || []).length === 1 ? "" : "s")) + '</span><span class="chip">' + escapeHtml((agent.plugins || []).length + " add-on" + ((agent.plugins || []).length === 1 ? "" : "s")) + '</span><span class="chip">Version ' + escapeHtml(agent.version || "1") + '</span></div></div>').join("") || '<div class="empty-state"><strong>No agents yet</strong><span>Add one when you have a recurring kind of work to delegate.</span></div>';
      if (state.selectedAgentId) renderAgentDetail(state.agents.find((agent) => agent.id === state.selectedAgentId));
    }

    function renderAgentDetail(agent) {
      if (!agent) return;
      state.selectedAgentId = agent.id;
      $("agent-detail-status").textContent = friendlyAgentStatus(agent.status);
      $("agent-detail-status").className = "chip " + (agent.status === "enabled" ? "ok" : agent.status === "quarantined" ? "danger" : "");
      const sections = [
        ["Identity", agent.identity],
        ["Instructions", agent.instructions],
        ["Available actions", agent.tools],
        ["Add-ons", agent.plugins],
        ["Connected services", agent.network?.allow || agent.network],
        ["Scheduled work", agent.schedules],
        ["Memory", agent.memory],
        ["Checks", agent.tests],
        ["Package health", agent.integrity ? "Recorded and ready to verify" : "No package health information"]
      ];
      $("agent-detail").className = "agent-inspector";
      $("agent-detail").innerHTML = sections.filter(([, value]) => hasHumanValue(value)).map(([label, value]) => renderHumanSection(label, value)).join("") || '<div class="empty-state"><strong>No additional setup</strong><span>This agent has no extra requirements.</span></div>';
      ["agent-enable", "agent-disable", "agent-quarantine"].forEach((id) => $(id).disabled = false);
      document.querySelectorAll("[data-agent-id]").forEach((item) => item.classList.toggle("selected", item.dataset.agentId === agent.id));
    }

    function friendlyAgentStatus(value) {
      return value === "enabled" ? "Available" : value === "quarantined" ? "Set aside" : "Off";
    }

    function hasHumanValue(value) {
      if (Array.isArray(value)) return value.length > 0;
      if (value && typeof value === "object") return Object.keys(value).length > 0;
      return value !== undefined && value !== null && value !== "";
    }

    function renderHumanSection(label, value) {
      let content;
      if (Array.isArray(value)) {
        content = '<div class="chip-row">' + (value.length ? value.map((item) => '<span class="chip">' + escapeHtml(friendlyArea(typeof item === "string" ? item : item?.name || "Configured")) + '</span>').join("") : '<span class="muted">None</span>') + '</div>';
      } else if (value && typeof value === "object") {
        const entries = Object.entries(value).filter(([key]) => !/id|hash|digest|path|token|secret/i.test(key));
        content = '<div class="detail-grid">' + entries.map(([key, item]) => '<div class="detail-card"><span>' + escapeHtml(friendlyStatus(key)) + '</span><strong>' + escapeHtml(Array.isArray(item) ? item.map((entry) => typeof entry === "string" ? friendlyArea(entry) : "Configured").join(", ") || "None" : typeof item === "boolean" ? item ? "Yes" : "No" : typeof item === "object" ? "Configured" : friendlyStatus(item)) + '</strong></div>').join("") + '</div>';
      } else {
        content = '<p>' + escapeHtml(String(value)) + '</p>';
      }
      return '<div class="agent-section"><strong>' + escapeHtml(label) + '</strong>' + content + '</div>';
    }

    async function refreshSkills() {
      const data = await api("/skills");
      state.skills = data.skills || [];
      const query = $("skill-query")?.value.trim().toLowerCase() || "";
      const status = $("skill-status-filter")?.value || "all";
      const skills = state.skills.filter((skill) => (status === "all" || skill.status === status) && (!query || JSON.stringify(skill).toLowerCase().includes(query)));
      $("skill-total").textContent = state.skills.length;
      $("skill-enabled").textContent = state.skills.filter((skill) => skill.status === "enabled").length;
      $("skill-unmanaged").textContent = state.skills.filter((skill) => skill.status === "unmanaged" || skill.status === "draft").length;
      $("skill-quarantined").textContent = state.skills.filter((skill) => skill.status === "quarantined").length;
      $("skills-list").innerHTML = skills.map((skill) => '<div class="item skill-card ' + (skill.id === state.selectedSkillId ? "selected" : "") + '" role="button" tabindex="0" data-skill-id="' + escapeHtml(skill.id) + '"><div class="item-line"><strong>' + escapeHtml(skill.name) + '</strong><span class="chip ' + (skill.status === "enabled" ? "ok" : skill.status === "quarantined" ? "danger" : "warn") + '">' + escapeHtml(friendlySkillStatus(skill.status)) + '</span></div><p>' + escapeHtml(skill.description || "No description yet") + '</p><div class="chip-row"><span class="chip">' + escapeHtml(friendlySkillSource(skill.source)) + '</span><span class="chip">' + escapeHtml(skill.version ? "Version " + skill.version : "Local skill") + '</span></div></div>').join("") || '<div class="empty-state"><strong>No matching skills</strong><span>Create a skill or change the filter.</span></div>';
      if (state.selectedSkillId) renderSkillDetail(state.skills.find((skill) => skill.id === state.selectedSkillId));
    }

    function renderSkillDetail(skill) {
      if (!skill) return;
      state.selectedSkillId = skill.id;
      $("skill-detail-status").textContent = friendlySkillStatus(skill.status);
      $("skill-detail-status").className = "chip " + (skill.status === "enabled" ? "ok" : skill.status === "quarantined" ? "danger" : "warn");
      const requirements = [
        ["Actions it can use", skill.requestedTools || []], ["Access it requests", skill.requestedCapabilities || []], ["Connected accounts", skill.requestedSecrets || []],
        ["Websites it can contact", skill.network?.allow || []], ["Package check", skill.verification?.valid === true ? "Passed" : skill.verification?.valid === false ? "Needs attention" : skill.integrity ? "Ready to check" : "Local skill"], ["Where it came from", friendlySkillSource(skill.source)]
      ];
      $("skill-detail").className = "agent-inspector";
      $("skill-detail").innerHTML = '<div class="agent-section"><strong>' + escapeHtml(skill.name) + '</strong><p>' + escapeHtml(skill.description || "No description") + '</p></div>' + requirements.map(([label, value]) => renderHumanSection(label, value)).join("");
      const managed = skill.source === "managed";
      $("skill-enable").disabled = !managed || skill.status === "enabled";
      $("skill-disable").disabled = !managed || skill.status === "disabled";
      $("skill-verify").disabled = !managed;
      $("skill-quarantine").disabled = !managed || skill.status === "quarantined";
      document.querySelectorAll("[data-skill-id]").forEach((item) => item.classList.toggle("selected", item.dataset.skillId === skill.id));
    }

    function friendlySkillStatus(value) {
      if (value === "enabled") return "Available";
      if (value === "quarantined") return "Set aside";
      if (value === "unmanaged" || value === "draft") return "Found locally";
      return "Off";
    }

    function friendlySkillSource(value) {
      if (value === "managed") return "Created in Ódinn";
      if (value === "legacy-extension") return "Imported extension";
      return "Found in this workspace";
    }

    async function refreshProjects() {
      const projectData = await api("/projects?includeArchived=true");
      const sessionData = await api("/sessions?limit=100");
      const goalData = await api("/goals?limit=100");
      state.projects = projectData.projects || [];
      state.sessions = sessionData.sessions || [];
      state.goals = goalData.goals || [];
      if (!state.selectedProjectId || !state.projects.some((project) => project.id === state.selectedProjectId)) state.selectedProjectId = projectData.defaultProjectId || state.projects[0]?.id || "";
      const query = $("project-query")?.value.trim().toLowerCase() || "";
      const projects = state.projects.filter((project) => !query || JSON.stringify(project).toLowerCase().includes(query));
      $("project-total").textContent = state.projects.filter((project) => project.status === "active").length;
      $("project-session-count").textContent = state.projects.reduce((sum, project) => sum + Number(project.sessionCount || 0), 0);
      $("project-goal-count").textContent = state.projects.reduce((sum, project) => sum + Number(project.goalCount || 0), 0);
      $("project-active-goal-count").textContent = state.projects.reduce((sum, project) => sum + Number(project.activeGoalCount || 0), 0);
      $("project-list").innerHTML = projects.map((project) => '<div class="item project-card ' + (project.id === state.selectedProjectId ? "selected" : "") + '" role="button" tabindex="0" data-project-id="' + escapeHtml(project.id) + '"><div class="item-line"><strong>' + escapeHtml(project.name) + '</strong><span class="chip ' + (project.status === "active" ? "ok" : "") + '">' + escapeHtml(project.status) + '</span></div><p>' + escapeHtml(project.description || "No description") + '</p><div class="chip-row"><span class="chip">' + escapeHtml(project.sessionCount + " sessions") + '</span><span class="chip">' + escapeHtml(project.goalCount + " goals") + '</span></div></div>').join("") || '<div class="empty-state"><strong>No matching projects</strong><span>Create one or clear the filter.</span></div>';
      populateScopeSelectors();
      renderProjectDetail(state.projects.find((project) => project.id === state.selectedProjectId));
    }

    function renderProjectDetail(project) {
      if (!project) return;
      state.selectedProjectId = project.id;
      const sessions = (state.sessions || []).filter((session) => session.projectId === project.id);
      const goals = (state.goals || []).filter((goal) => goal.projectId === project.id);
      $("project-detail-status").textContent = project.status;
      $("project-detail").className = "agent-inspector";
      $("project-detail").innerHTML = '<div class="agent-section"><strong>' + escapeHtml(project.name) + '</strong><p>' + escapeHtml(project.description || "No description") + '</p></div>' +
        '<div class="agent-section"><strong>Sessions</strong>' + renderNamedList(sessions.map((session) => session.title), "No sessions yet") + '</div>' +
        '<div class="agent-section"><strong>Goals</strong>' + renderNamedList(goals.map((goal) => friendlyStatus(goal.status) + " · " + goal.title), "No goals yet") + '</div>';
      $("project-open-sessions").disabled = false;
      $("project-open-goals").disabled = false;
      $("project-archive").disabled = project.id === "project_default" || project.status === "archived";
      document.querySelectorAll("[data-project-id]").forEach((item) => item.classList.toggle("selected", item.dataset.projectId === project.id));
    }

    function renderNamedList(values, emptyText) {
      return values.length ? '<ul class="human-list">' + values.map((value) => '<li>' + escapeHtml(value) + '</li>').join("") + '</ul>' : '<p class="muted">' + escapeHtml(emptyText) + '</p>';
    }

    function populateScopeSelectors() {
      const projectOptions = (state.projects || []).map((project) => '<option value="' + escapeHtml(project.id) + '">' + escapeHtml(project.name + (project.status === "archived" ? " (archived)" : "")) + '</option>').join("");
      const allProjectOptions = '<option value="all">All projects</option>' + projectOptions;
      if ($("session-project-filter")) { const selected = $("session-project-filter").value; $("session-project-filter").innerHTML = allProjectOptions; $("session-project-filter").value = selected && [...$("session-project-filter").options].some((option) => option.value === selected) ? selected : "all"; }
      if ($("goal-project-filter")) { const selected = $("goal-project-filter").value; $("goal-project-filter").innerHTML = allProjectOptions; $("goal-project-filter").value = selected && [...$("goal-project-filter").options].some((option) => option.value === selected) ? selected : "all"; }
      updateGoalScopeOptions();
      updateMemoryScopeOptions();
      if (state.memoryCandidates?.length) renderMemoryCandidates();
      if (state.memories?.length) renderMemoryLibrary();
    }

    function updateGoalScopeOptions() {
      const type = $("goal-scope-type")?.value || "project";
      const values = type === "session" ? (state.sessions || []).map((session) => [session.id, session.title]) : (state.projects || []).filter((project) => project.status === "active").map((project) => [project.id, project.name]);
      $("goal-scope-id").innerHTML = values.map(([id, name]) => '<option value="' + escapeHtml(id) + '">' + escapeHtml(name) + '</option>').join("");
    }

    function updateMemoryScopeOptions() {
      const type = $("memory-scope-type")?.value || "global";
      $("memory-scope-target-field").hidden = type === "global";
      $("memory-scope-id").disabled = type === "global";
      const values = type === "session" ? (state.sessions || []).map((session) => [session.id, session.title]) : type === "project" ? (state.projects || []).map((project) => [project.id, project.name]) : [["", "Available everywhere"]];
      $("memory-scope-id").innerHTML = values.map(([id, name]) => '<option value="' + escapeHtml(id) + '">' + escapeHtml(name) + '</option>').join("");
    }

    function setMemoryTab(tab, userInitiated = false) {
      const next = tab === "saved" ? "saved" : "suggestions";
      state.memoryTab = next;
      if (userInitiated) state.memoryTabInitialized = true;
      const suggestions = next === "suggestions";
      $("memory-tab-suggestions").classList.toggle("active", suggestions);
      $("memory-tab-suggestions").setAttribute("aria-selected", String(suggestions));
      $("memory-tab-suggestions").tabIndex = suggestions ? 0 : -1;
      $("memory-tab-saved").classList.toggle("active", !suggestions);
      $("memory-tab-saved").setAttribute("aria-selected", String(!suggestions));
      $("memory-tab-saved").tabIndex = suggestions ? -1 : 0;
      $("memory-suggestions-panel").hidden = !suggestions;
      $("memory-saved-panel").hidden = suggestions;
    }

    async function refreshMemory() {
      const health = await api("/memory/status");
      state.memoryHealth = health;
      $("memory-new-toggle").disabled = !health.integration?.writeAllowed;
      if (!health.integration?.readAllowed) {
        $("memory-record-count").textContent = "—";
        $("memory-candidate-count").textContent = "—";
        $("memory-recall-status").textContent = "Recall off";
        $("memory-last-update").textContent = "Unavailable";
        $("memory-health").textContent = "Memory permission required";
        $("memory-health").className = "chip danger";
        $("memory-status-copy").textContent = "Ódinn cannot read or manage memory under the current policy.";
        $("memory-result-count").textContent = "Unavailable";
        $("memory-candidate-badge").textContent = "Unavailable";
        $("memory-tab-suggestions-count").textContent = "—";
        $("memory-tab-saved-count").textContent = "—";
        $("memory-candidate-list").innerHTML = '<div class="empty-state memory-empty"><strong>Suggestions are unavailable</strong><span>Memory access is turned off for this workspace.</span></div>';
        $("memory-list").innerHTML = '<div class="empty-state memory-empty"><strong>Saved memories are unavailable</strong><span>Memory access is turned off for this workspace.</span></div>';
        $("memory-tree").innerHTML = '<div class="empty-state"><strong>Organization unavailable</strong><span>No saved context was read.</span></div>';
        return;
      }
      const [data, tree, candidateData] = await Promise.all([
        api("/memory?limit=100"),
        api("/memory/browse?limit=100"),
        api("/memory/candidates?status=pending&limit=100")
      ]);
      state.memories = data.memories || [];
      state.memoryCandidates = candidateData.candidates || [];
      $("memory-record-count").textContent = health.records || 0;
      $("memory-candidate-count").textContent = state.memoryCandidates.length;
      $("memory-tab-suggestions-count").textContent = state.memoryCandidates.length;
      $("memory-tab-saved-count").textContent = health.records || 0;
      $("memory-recall-status").textContent = health.integration?.autoRecall ? "Recall on" : "Recall off";
      $("memory-last-update").textContent = health.latestAt ? "Updated " + relativeTime(health.latestAt) : "No saved memories yet";
      const healthy = health.integration?.readAllowed && health.integration?.writeAllowed;
      $("memory-health").textContent = healthy ? "On" : "Read only";
      $("memory-health").className = "chip " + (healthy ? "ok" : "danger");
      $("memory-status-copy").textContent = health.integration?.autoLearn
        ? (health.integration?.autoRecall ? "Ódinn suggests useful details and recalls only the memories you keep." : "Ódinn can suggest useful details, but automatic recall is turned off.")
        : "Automatic suggestions are off. You can still add and manage saved memories here.";
      $("memory-tree").innerHTML = (tree.namespaces || []).map((entry) => '<div class="item"><div class="item-line"><strong>' + escapeHtml(friendlyMemoryNamespace(entry.namespace)) + '</strong><span class="chip">' + escapeHtml(entry.count + " memories") + '</span></div><div class="muted">' + escapeHtml(Object.entries(entry.tiers || {}).map(([tier, count]) => memoryTierLabel(tier) + ": " + count).join(" · ")) + '</div></div>').join("") || '<div class="empty-state"><strong>No memory groups yet</strong><span>New durable context will appear here.</span></div>';
      renderMemoryLibrary();
      renderMemoryCandidates();
      if (!state.memoryTabInitialized) {
        setMemoryTab(state.memoryCandidates.length ? "suggestions" : "saved");
        state.memoryTabInitialized = true;
      } else {
        setMemoryTab(state.memoryTab);
      }
    }

    function renderMemoryLibrary() {
      const query = $("memory-query").value.trim().toLowerCase();
      const kind = $("memory-kind-filter").value;
      const scopeType = $("memory-scope-filter").value;
      const memories = (state.memories || []).filter((memory) => {
        if (kind && memory.kind !== kind) return false;
        if (scopeType && (memory.scopeType || "global") !== scopeType) return false;
        if (!query) return true;
        const searchable = [memory.subject, memory.summary, memory.text, ...(memory.tags || [])].filter(Boolean).join(" ").toLowerCase();
        return query.split(/s+/).filter(Boolean).every((term) => searchable.includes(term));
      });
      $("memory-result-count").textContent = memories.length + (memories.length === 1 ? " saved memory" : " saved memories");
      $("memory-list").innerHTML = memories.map((memory) => '<button class="item memory-card ' + (memory.id === state.selectedMemoryId ? "selected" : "") + '" type="button" data-memory-id="' + escapeHtml(memory.id) + '"><div class="item-line"><strong>' + escapeHtml(memory.subject || friendlyStatus(memory.kind)) + '</strong><span class="chip">' + escapeHtml(friendlyStatus(memory.kind)) + '</span></div><p>' + escapeHtml(memory.summary || memory.text) + '</p><div class="scope-label">' + escapeHtml(memoryScopeLabel(memory)) + '</div><div class="muted">' + escapeHtml(memorySourceLabel(memory)) + ' · ' + escapeHtml(relativeTime(memory.at)) + '</div></button>').join("") || '<div class="empty-state memory-empty"><strong>No saved memories found</strong><span>' + (query || kind || scopeType ? "Try clearing a filter." : "Add a lasting preference, fact, or decision when you want Ódinn to remember it.") + '</span></div>';
      const selectedMemory = memories.find((memory) => memory.id === state.selectedMemoryId)
        || (matchMedia("(max-width: 600px)").matches ? undefined : memories[0]);
      if (selectedMemory) renderMemoryDetail(selectedMemory);
      else clearMemoryDetail();
    }

    function renderMemoryCandidates() {
      const candidates = state.memoryCandidates || [];
      const canDecide = state.memoryHealth?.integration?.writeAllowed === true;
      $("memory-candidate-badge").textContent = candidates.length + (candidates.length === 1 ? " to review" : " to review");
      $("memory-candidate-badge").className = "chip " + (candidates.length ? "warn" : "ok");
      $("memory-candidate-list").innerHTML = candidates.map((candidate) => {
        const destinationOptions = [
          ["original", "Suggested · " + memoryScopeLabel(candidate)],
          ["global", "Everywhere"],
          ...(state.projects || []).filter((project) => project.status === "active").map((project) => ["project:" + project.id, "Project · " + project.name])
        ];
        return '<article class="memory-suggestion-card"><div class="memory-suggestion-meta"><span class="chip">' + escapeHtml(friendlyStatus(candidate.kind)) + '</span><span class="muted">' + escapeHtml(memoryCandidateOriginLabel(candidate)) + ' · ' + escapeHtml(relativeTime(candidate.at)) + '</span></div><h3>' + escapeHtml(candidate.subject || "Suggested memory") + '</h3><p>' + escapeHtml(candidate.summary || candidate.text) + '</p><label class="memory-destination"><span>Use this memory in</span><select data-memory-candidate-destination="' + escapeHtml(candidate.id) + '" aria-label="Where to use ' + escapeHtml(candidate.subject || "this memory") + '">' + destinationOptions.map(([value, label]) => '<option value="' + escapeHtml(value) + '">' + escapeHtml(label) + '</option>').join("") + '</select></label><div class="memory-suggestion-actions"><button type="button" data-memory-candidate-keep="' + escapeHtml(candidate.id) + '"' + (canDecide ? "" : " disabled") + '>Keep memory</button><button class="secondary" type="button" data-memory-candidate-dismiss="' + escapeHtml(candidate.id) + '"' + (canDecide ? "" : " disabled") + '>Dismiss</button></div></article>';
      }).join("") || '<div class="empty-state memory-empty"><strong>You are all caught up</strong><span>New suggestions will appear here after Ódinn notices something useful in a conversation.</span><div class="row"><button class="secondary" type="button" data-memory-tab-target="saved">View saved memories</button></div></div>';
    }

    async function decideMemoryCandidate(candidateId, decision, button) {
      const candidate = state.memoryCandidates.find((entry) => entry.id === candidateId);
      if (!candidate) return;
      if (decision === "rejected" && !window.confirm('Dismiss "' + (candidate.subject || "this suggestion") + '"?')) return;
      const destination = document.querySelector('[data-memory-candidate-destination="' + CSS.escape(candidateId) + '"]')?.value || "original";
      const body = { decision };
      if (decision === "accepted" && destination === "global") body.scopeType = "global";
      if (decision === "accepted" && destination.startsWith("project:")) {
        body.scopeType = "project";
        body.scopeId = destination.slice("project:".length);
      }
      setBusy(button, true);
      const result = await api("/memory/candidates/" + encodeURIComponent(candidateId) + "/decision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (result.memory?.id) state.selectedMemoryId = result.memory.id;
      const wasLast = state.memoryCandidates.length === 1;
      if (decision === "accepted" && wasLast) setMemoryTab("saved");
      showOutput(decision === "accepted" ? "Memory saved." : "Suggestion dismissed.");
      await refreshMemory();
    }

    function clearMemoryDetail() {
      state.selectedMemoryId = "";
      $("memory-detail-panel").hidden = true;
      $("memory-detail-kind").textContent = "No selection";
      $("memory-detail").className = "empty-state";
      $("memory-detail").innerHTML = '<strong>Choose a saved memory</strong><span>You will see what Ódinn remembers and where it can use it.</span>';
      $("memory-correct").disabled = true;
      $("memory-forget").disabled = true;
      $("memory-recall-result").hidden = true;
    }

    function renderMemoryDetail(memory) {
      if (!memory) return;
      state.selectedMemoryId = memory.id;
      $("memory-detail-panel").hidden = false;
      $("memory-detail-kind").textContent = friendlyStatus(memory.kind);
      $("memory-detail").className = "agent-inspector";
      $("memory-detail").innerHTML = '<div class="agent-section"><strong>' + escapeHtml(memory.subject || friendlyStatus(memory.kind)) + '</strong><p>' + escapeHtml(memory.text) + '</p></div><div class="detail-grid">' +
        [["Applies to", memoryScopeLabel(memory)], ["Added", memorySourceLabel(memory)], ["Saved", relativeTime(memory.at)]].map(([label, value]) => '<div class="detail-card"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>').join("") + '</div><details class="advanced-options"><summary>Technical details</summary><p>Confidence: ' + escapeHtml(memoryConfidenceLabel(memory.confidence)) + ' · Type: ' + escapeHtml(friendlyStatus(memory.kind)) + '</p></details>';
      $("memory-correct").disabled = !state.memoryHealth?.integration?.writeAllowed;
      $("memory-forget").disabled = !state.memoryHealth?.integration?.writeAllowed;
      $("memory-recall-result").hidden = true;
      document.querySelectorAll("[data-memory-id]").forEach((item) => item.classList.toggle("selected", item.dataset.memoryId === memory.id));
    }

    function memoryScopeLabel(memory) {
      if (memory.scopeType === "project") return "Project · " + ((state.projects || []).find((project) => project.id === memory.scopeId)?.name || "One project");
      if (memory.scopeType === "session") return "Conversation · " + ((state.sessions || []).find((session) => session.id === memory.scopeId)?.title || "One conversation");
      return "Everywhere";
    }

    function memorySourceLabel(memory) {
      const value = String((memory.authority || "") + " " + (memory.source || ""));
      if (/user/i.test(value)) return "Added manually";
      if (/agent|auto/i.test(value)) return "Suggested by Ódinn";
      if (/import/i.test(value)) return "Imported";
      return "Saved locally";
    }

    function memoryCandidateOriginLabel(candidate) {
      const sessionId = candidate.sessionId || (candidate.scopeType === "session" ? candidate.scopeId : "");
      const session = (state.sessions || []).find((entry) => entry.id === sessionId);
      if (session) return "From " + session.title;
      const projectId = candidate.projectId || (candidate.scopeType === "project" ? candidate.scopeId : "");
      const project = (state.projects || []).find((entry) => entry.id === projectId);
      if (project) return "From " + project.name;
      return "From a recent conversation";
    }

    function memoryConfidenceLabel(value) {
      const score = Number(value);
      if (!Number.isFinite(score)) return "Not rated";
      if (score >= .9) return "High";
      if (score >= .65) return "Medium";
      return "Low";
    }

    function memoryTierLabel(value) {
      return value === "l0" ? "Summaries" : value === "l2" ? "Supporting details" : "Facts";
    }

    function friendlyMemoryNamespace(value) {
      return String(value || "General").split("/").map((part) => friendlyStatus(part)).join(" · ");
    }

    async function refreshSessions() {
      const data = await api("/sessions");
      const sessions = data.sessions || [];
      state.sessions = sessions;
      const chatSessions = sessions.filter((session) => Number(session.messageCount || 0) > 0 || session.id === state.activeChatId);
      const recent = [];
      const seenGenericTitles = new Set();
      for (const session of chatSessions) {
        const title = String(session.title || "").trim();
      const generic = /^(gateway chat|chat|new chat)$/i.test(title);
        if (generic && seenGenericTitles.has(title.toLowerCase()) && session.id !== state.activeChatId) continue;
        if (generic) seenGenericTitles.add(title.toLowerCase());
        recent.push(session);
        if (recent.length >= 8) break;
      }
      const pinned = chatSessions.filter((session) => session.pinned === true).slice(0, 6);
      $("pinned-chat-list").innerHTML = pinned.map(renderChatSession).join("");
      $("pinned-count").textContent = pinned.length;
      $("chat-session-list").innerHTML = recent.map(renderChatSession).join("") || '<div class="muted session-empty">Your saved chats will appear here.</div>';
      $("chat-session-count").textContent = sessions.length;
      $("session-page-count").textContent = sessions.length + " sessions";
      $("session-count-badge").textContent = sessions.length;
      if (!state.activeChatId && sessions.length) {
        const initial = sessions.find((session) => Number(session.messageCount || 0) === 0) || sessions[0];
        await loadChat(initial.id);
      } else {
        renderChatMessages(state.messages);
      }
      renderSessionTable();
    }

    function renderSessionTable() {
      const query = $("session-query")?.value.trim().toLowerCase() || "";
      const status = $("session-status-filter")?.value || "all";
      const projectId = $("session-project-filter")?.value || "all";
      const groupBy = $("session-group")?.value || "none";
      const sessions = (state.sessions || []).filter((session) => (!query || JSON.stringify(session).toLowerCase().includes(query)) && (status === "all" || (session.status || "open") === status) && (projectId === "all" || session.projectId === projectId));
      if (groupBy === "none") {
        $("session-list").innerHTML = sessions.map(renderSessionRecord).join("") || '<div class="empty-state"><strong>No matching sessions</strong><span>Change the filters or create a new session.</span></div>';
        return;
      }
      const groups = new Map();
      for (const session of sessions) {
        const key = groupBy === "project" ? (state.projects.find((project) => project.id === session.projectId)?.name || "Workspace") : groupBy === "source" ? friendlySessionSource(session.source) : friendlyStatus(session.status || "open");
        groups.set(key, [...(groups.get(key) || []), session]);
      }
      $("session-list").innerHTML = Array.from(groups.entries()).map(([label, entries]) => '<div class="data-row data-group"><span class="data-group-label"><strong>' + escapeHtml(label) + '</strong> <span class="muted">' + escapeHtml(entries.length + " sessions") + '</span></span></div>' + entries.map(renderSessionRecord).join("")).join("") || '<div class="empty-state"><strong>No matching sessions</strong><span>Change the filters or create a new session.</span></div>';
    }

    function selectedAgentGraph() {
      return state.agentGraphs.find((graph) => graph.graphRunId === state.selectedAgentGraphId);
    }

    function renderSelectedAgentGraph(graph) {
      const status = $("agent-graph-detail-status");
      const cancel = $("agent-graph-cancel");
      const reassign = $("agent-graph-reassign");
      const checkpoint = $("agent-graph-checkpoint");
      if (!graph) {
        status.textContent = "No selection";
        status.className = "chip";
        cancel.disabled = true;
        reassign.disabled = true;
        checkpoint.disabled = true;
        $("agent-graph-detail").innerHTML = '<div class="empty-state"><strong>Select delegated work</strong><span>Its child progress, budgets, result references, and terminal reason will appear here.</span></div>';
        return;
      }
      status.textContent = agentGraphStatusLabel(graph.status);
      status.className = "chip " + agentGraphStatusClass(graph.status);
      cancel.disabled = !isAgentGraphActive(graph.status);
      reassign.disabled = !canReassignAgentGraph(graph.status);
      checkpoint.disabled = graph.status !== "completed" || !graph.nodes.some((node) => node.status === "completed" && node.resultDigest);
      $("agent-graph-detail").innerHTML = renderAgentGraphDetail(graph);
    }

    function renderAgentGraphList() {
      const status = $("agent-graph-status-filter").value;
      const graphs = state.agentGraphs.filter((graph) => !status || graph.status === status);
      const active = state.agentGraphs.filter((graph) => isAgentGraphActive(graph.status)).length;
      const completed = state.agentGraphs.filter((graph) => graph.status === "completed").length;
      const attention = state.agentGraphs.filter((graph) => ["failed", "cancelled", "needs-review"].includes(graph.status)).length;
      $("agent-graph-total").textContent = String(state.agentGraphs.length);
      $("agent-graph-active").textContent = String(active);
      $("agent-graph-completed").textContent = String(completed);
      $("agent-graph-review").textContent = String(attention);
      $("nav-delegation-attention").textContent = String(attention);
      $("nav-delegation-attention").className = "badge" + (attention ? " danger" : "");
      $("agent-graph-count").textContent = graphs.length + (graphs.length === 1 ? " graph" : " graphs");
      $("agent-graph-list").innerHTML = graphs.map((graph) => renderAgentGraphRow(graph, graph.graphRunId === state.selectedAgentGraphId)).join("") || '<div class="empty-state"><strong>No matching delegated work</strong><span>Change the status filter or start a child graph.</span></div>';
      renderSelectedAgentGraph(selectedAgentGraph());
    }

    async function selectAgentGraph(graphRunId) {
      const data = await api("/agent-graphs/" + encodeURIComponent(graphRunId));
      const graph = data.graph;
      const index = state.agentGraphs.findIndex((item) => item.graphRunId === graphRunId);
      if (index >= 0) state.agentGraphs[index] = graph;
      else state.agentGraphs.unshift(graph);
      state.selectedAgentGraphId = graphRunId;
      renderAgentGraphList();
    }

    async function refreshAgentGraphs() {
      const data = await api("/agent-graphs?limit=200");
      state.agentGraphs = data.graphs || [];
      if (state.selectedAgentGraphId && !state.agentGraphs.some((graph) => graph.graphRunId === state.selectedAgentGraphId)) state.selectedAgentGraphId = "";
      renderAgentGraphList();
      if (!state.selectedAgentGraphId && state.agentGraphs.length) await selectAgentGraph(state.agentGraphs[0].graphRunId);
    }

    async function cancelSelectedAgentGraph() {
      const graph = selectedAgentGraph();
      if (!graph || !isAgentGraphActive(graph.status)) return;
      if (!window.confirm("Stop this child graph? Any uncertain in-flight child work will be quarantined for review.")) return;
      const result = await api("/agent-graphs/" + encodeURIComponent(graph.graphRunId) + "/cancel", { method: "POST" });
      showOutput(result);
      await refreshAgentGraphs();
      await selectAgentGraph(graph.graphRunId);
    }

    function openAgentGraphReassignment() {
      const graph = selectedAgentGraph();
      if (!graph || !canReassignAgentGraph(graph.status)) return;
      $("agent-graph-reassign-form").reset();
      $("agent-graph-replacement-id").value = "agent-graph-reassignment-" + Date.now();
      openDialog($("agent-graph-reassign-dialog"));
    }

    function clearAgentGraphCheckpointToken() {
      $("agent-graph-checkpoint-token").value = "";
    }

    function openAgentGraphCheckpoint() {
      const graph = selectedAgentGraph();
      if (!graph || graph.status !== "completed") return;
      const completed = graph.nodes.filter((node) => node.status === "completed" && node.resultDigest);
      if (!completed.length) return;
      $("agent-graph-checkpoint-form").reset();
      clearAgentGraphCheckpointToken();
      $("agent-graph-checkpoint-node").innerHTML = completed.map((node) => '<option value="' + escapeHtml(node.nodeId) + '">' + escapeHtml(node.nodeId) + '</option>').join("");
      $("agent-graph-checkpoint-run").value = "agent-graph-checkpoint-" + Date.now();
      openDialog($("agent-graph-checkpoint-dialog"));
    }

    async function refreshGoals() {
      const data = await api("/goals?limit=100");
      state.goals = data.goals || [];
      const projectId = $("goal-project-filter")?.value || "all";
      const status = $("goal-status-filter")?.value || "all";
      const query = $("goal-query")?.value.trim().toLowerCase() || "";
      const goals = state.goals.filter((goal) =>
        (projectId === "all" || goal.projectId === projectId)
        && (status === "all" || goal.status === status)
        && (!query || [goal.title, goal.description, goal.notes?.at(-1)?.note].some((value) => String(value || "").toLowerCase().includes(query))));
      $("goal-active-count").textContent = state.goals.filter((goal) => goal.status === "active").length;
      $("goal-paused-count").textContent = state.goals.filter((goal) => goal.status === "paused").length;
      $("goal-blocked-count").textContent = state.goals.filter((goal) => goal.status === "blocked").length;
      $("goal-completed-count").textContent = state.goals.filter((goal) => goal.status === "completed").length;
      $("goal-list").innerHTML = goals.map((goal) => {
        const project = state.projects.find((entry) => entry.id === goal.projectId);
        const session = state.sessions.find((entry) => entry.id === goal.sessionId);
        const tone = goal.status === "completed" ? "ok" : goal.status === "blocked" || goal.status === "cancelled" ? "danger" : "warn";
        const resumeLabel = goal.status === "completed" ? "Reopen" : "Resume";
        const quickActions = goal.status === "active"
          ? '<button class="secondary" data-goal-action="paused" type="button">Pause</button><button data-goal-action="completed" type="button">Complete</button>'
          : goal.status === "paused" || goal.status === "blocked" || goal.status === "completed" || goal.status === "cancelled"
            ? '<button class="secondary" data-goal-action="active" type="button">' + resumeLabel + '</button>' + (goal.status === "completed" ? "" : '<button data-goal-action="completed" type="button">Complete</button>')
            : "";
        return '<article class="item goal-card ' + (goal.id === state.selectedGoalId ? "selected" : "") + '" data-goal-id="' + escapeHtml(goal.id) + '"><div class="item-line"><strong>' + escapeHtml(goal.title) + '</strong><span class="chip ' + tone + '">' + escapeHtml(friendlyStatus(goal.status)) + '</span></div><p>' + escapeHtml(goal.description || "No success criteria recorded") + '</p><div class="scope-label">' + escapeHtml(goal.scopeType === "session" ? "Conversation · " + (session?.title || "Unavailable conversation") : "Project · " + (project?.name || "Unavailable project")) + '</div><div class="muted">' + (goal.notes?.length ? escapeHtml(goal.notes.at(-1).note) + " · " : "") + 'Updated ' + escapeHtml(relativeTime(goal.updatedAt)) + '</div><div class="row goal-actions"><button class="secondary" data-goal-edit type="button">Edit</button>' + quickActions + '</div></article>';
      }).join("") || '<div class="empty-state"><strong>No matching goals</strong><span>Create a goal or choose another project.</span></div>';
    }

    function openGoalEditor(goal) {
      state.selectedGoalId = goal?.id || "";
      $("goal-form").reset();
      $("goal-title").value = goal?.title || "";
      $("goal-description").value = goal?.description || "";
      $("goal-status").value = goal?.status || "active";
      $("goal-scope-type").value = goal?.scopeType || "project";
      updateGoalScopeOptions();
      if (goal) $("goal-scope-id").value = goal.scopeId || goal.projectId || goal.sessionId || "";
      $("goal-scope-type").disabled = Boolean(goal);
      $("goal-scope-id").disabled = Boolean(goal);
      $("goal-editor-title").textContent = goal ? "Edit goal" : "Create goal";
      $("goal-status-field").hidden = !goal;
      $("create-goal").hidden = Boolean(goal);
      $("update-goal").hidden = !goal;
      openDialog($("goal-dialog"));
    }

    async function quickUpdateGoal(goal, status) {
      const verb = status === "completed" ? "Mark this goal complete?" : status === "paused" ? "Pause this goal?" : "Make this goal active again?";
      if (!window.confirm(verb)) return;
      await api("/goals/" + encodeURIComponent(goal.id) + "/updates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, note: status === "completed" ? "Marked complete from the goal board." : status === "paused" ? "Paused from the goal board." : "Resumed from the goal board.", source: "console" })
      });
      await refreshGoals();
    }

    async function refreshAudit() {
      const params = new URLSearchParams({ page: String(state.auditPage || 1), pageSize: $("audit-page-size").value });
      const filters = { q: "audit-query", type: "audit-type-filter", tool: "audit-tool-filter", actor: "audit-actor-filter", outcome: "audit-outcome-filter", from: "audit-from", to: "audit-to" };
      for (const [key, id] of Object.entries(filters)) if ($(id).value) params.set(key, $(id).value);
      const result = await api("/audit/query?" + params);
      state.audit = result.events || [];
      state.auditPagination = result.pagination || { page: 1, pages: 1, total: 0, from: 0, to: 0 };
      state.auditPage = state.auditPagination.page;
      const summary = result.summary || {};
      $("audit-count").textContent = summary.events || 0;
      $("audit-run-count").textContent = summary.runs || 0;
      $("audit-model-count").textContent = summary.modelRuns || 0;
      $("audit-error-count").textContent = summary.errors || 0;
      $("audit-events").innerHTML = state.audit.map(renderAuditEvent).join("") || '<div class="empty-state"><strong>No matching activity</strong><span>Try another filter or start some work.</span></div>';
      $("audit-log").textContent = JSON.stringify(state.audit, null, 2);
      $("audit-showing").textContent = state.auditPagination.total ? state.auditPagination.from + "–" + state.auditPagination.to + " of " + state.auditPagination.total + " matching" : "0 matching events";
      $("audit-page-label").textContent = "Page " + state.auditPagination.page + " of " + state.auditPagination.pages;
      $("audit-prev").disabled = state.auditPagination.page <= 1;
      $("audit-next").disabled = state.auditPagination.page >= state.auditPagination.pages;
      const facetTargets = { types: "audit-type-filter", tools: "audit-tool-filter", actors: "audit-actor-filter", outcomes: "audit-outcome-filter" };
      for (const [facet, id] of Object.entries(facetTargets)) {
        const select = $(id);
        const selected = select.value;
        const label = select.options[0]?.textContent || "All";
        select.innerHTML = '<option value="">' + escapeHtml(label) + '</option>' + (result.facets?.[facet] || []).map((entry) => '<option value="' + escapeHtml(entry.value) + '">' + escapeHtml(auditFacetLabel(facet, entry.value) + " (" + entry.count + ")") + '</option>').join("");
        if ([...select.options].some((option) => option.value === selected)) select.value = selected;
      }
    }

    function auditFacetLabel(facet, value) {
      if (facet === "types") return friendlyEventTitle({ type: value });
      if (facet === "tools") return friendlyArea(value);
      if (facet === "actors") return friendlyActor(value);
      return typedAuditFacetLabel(facet, value);
    }

    async function showRunDetail(runId) {
      const detail = await api("/runs/" + encodeURIComponent(runId));
      if ($("detail-label")) $("detail-label").textContent = runId;
      if ($("run-detail")) $("run-detail").textContent = JSON.stringify(detail, null, 2);
      showOutput(detail);
    }

    document.querySelectorAll("[data-view]").forEach((button) => {
      button.addEventListener("click", () => switchView(button.dataset.view));
    });
    document.querySelectorAll("[data-view-jump]").forEach((button) => {
      button.addEventListener("click", () => switchView(button.dataset.viewJump));
    });
    $("refresh-operator").addEventListener("click", () => refreshOperator().catch((error) => showOutput(error.message)));
    $("operator-work-prev").addEventListener("click", () => { state.operatorPages = state.operatorPages || { work: 1 }; state.operatorPages.work = Math.max(1, (state.operatorPages.work || 1) - 1); refreshOperator().catch((error) => showOutput(error.message)); });
    $("operator-work-next").addEventListener("click", () => { state.operatorPages = state.operatorPages || { work: 1 }; state.operatorPages.work = (state.operatorPages.work || 1) + 1; refreshOperator().catch((error) => showOutput(error.message)); });
    $("operator-attention-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-operator-action]");
      if (button) runOperatorAction(button.dataset.operatorAction, button.dataset.operatorTarget).catch((error) => showOutput(error.message));
    });
    $("operator-runtime").addEventListener("click", (event) => {
      const button = event.target.closest("[data-operator-action]");
      if (button) runOperatorAction(button.dataset.operatorAction, button.dataset.operatorTarget).catch((error) => showOutput(error.message));
    });
    $("operator-work").addEventListener("click", (event) => {
      const button = event.target.closest("[data-operator-action]");
      if (button) runOperatorAction(button.dataset.operatorAction, button.dataset.operatorTarget).catch((error) => showOutput(error.message));
    });

    $("activity-tab-overview").addEventListener("click", () => setActivityTab("overview"));
    $("activity-tab-history").addEventListener("click", () => setActivityTab("history"));
    document.querySelectorAll("[data-experimental-page]").forEach((page) => {
      page.addEventListener("click", async (event) => {
        const featureKey = page.dataset.experimentalPage;
        const action = event.target.closest("[data-feature-action]");
        if (action) {
          state.experimentalActions ||= {};
          state.experimentalActions[featureKey] = action.dataset.featureAction;
          renderExperimentalFeaturePage(featureKey);
          return;
        }
        if (event.target.closest("[data-role=run]")) {
          runExperimentalAction(featureKey).catch((error) => showOutput(error.message));
          return;
        }
        if (event.target.closest("[data-refresh-experimental]")) {
          refreshExperiments().catch((error) => showOutput(error.message));
          return;
        }
        if (event.target.closest("[data-copy-access-pass]") && state.lastCapabilityToken) {
          await navigator.clipboard?.writeText(state.lastCapabilityToken);
          showOutput("Access pass copied. It remains hidden on screen.");
        }
      });
    });
    $("refresh-improvements").addEventListener("click", () => refreshImprovements().catch((error) => showOutput(error.message)));
    $("learn-improvements").addEventListener("click", () => learnImprovements().catch((error) => showOutput(error.message)));
    $("improvement-list").addEventListener("click", (event) => {
      const item = event.target.closest("[data-improvement-id]");
      if (!item) return;
      state.selectedImprovementId = item.dataset.improvementId;
      renderImprovements();
    });
    $("improvement-rollback").addEventListener("click", () => rollbackImprovement().catch((error) => showOutput(error.message)));

    $("sidebar-toggle").addEventListener("click", () => {
      if (matchMedia("(max-width: 980px)").matches) {
        const open = $("shell").classList.toggle("nav-open");
        $("sidebar-toggle").title = open ? "Close navigation" : "Open navigation";
        $("sidebar-toggle").setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
        $("sidebar-toggle").setAttribute("aria-expanded", String(open));
        return;
      }
      const collapsed = $("shell").classList.toggle("sidebar-collapsed");
      $("sidebar-toggle").title = collapsed ? "Expand navigation" : "Collapse navigation";
      $("sidebar-toggle").setAttribute("aria-label", collapsed ? "Expand navigation" : "Collapse navigation");
      $("sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
    });
    $("mobile-scrim").addEventListener("click", closeMobileNavigation);
    window.addEventListener("hashchange", () => switchView(viewFromHash(), { updateHash: false }));
    window.addEventListener("resize", closeMobileNavigation);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMobileNavigation();
      const target = event.target.closest?.('[role="button"][tabindex="0"]');
      if (target && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        target.click();
      }
    });
    $("web-search-run").addEventListener("click", runWebSearch);
    $("gatewatch-preview-run").addEventListener("click", runGatewatchPreview);
    $("web-search-query").addEventListener("keydown", (event) => {
      if (event.key === "Enter") runWebSearch();
    });
    $("browser-open").addEventListener("click", openBrowserUrl);
    $("browser-refresh").addEventListener("click", refreshBrowser);
    $("browser-tabs").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-browser-tab-id]");
      if (tab) inspectBrowserTab(tab.dataset.browserTabId).catch((error) => showOutput(error.message));
    });
    $("approval-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-approve-id]");
      if (!button) return;
      const action = button.dataset.approvalAction === "deny" ? denyAction : approveAction;
      action(button.dataset.approveId).catch((error) => showOutput(error.message));
    });

    $("refresh").addEventListener("click", refresh);
    $("config-form").addEventListener("submit", (event) => event.preventDefault());
    $("config-add-provider").addEventListener("click", () => {
      try {
        const draft = readStructuredConfig();
        const providers = draft.providers || {};
        let name = "new-provider";
        let index = 2;
        while (providers[name]) name = "new-provider-" + index++;
        providers[name] = { type: "openai-compatible", baseUrl: "", apiKeyEnv: "", models: [""] };
        draft.providers = providers;
        state.config = draft;
        renderConfigForm(draft);
      } catch (error) { $("config-error").textContent = error.message; }
    });
    $("config-add-channel").addEventListener("click", () => {
      try {
        const draft = readStructuredConfig();
        const channels = draft.channels || {};
        let name = "telegram";
        let index = 2;
        while (channels[name]) name = "telegram-" + index++;
        channels[name] = { type: "telegram", enabled: false, tokenEnv: "ODINN_TELEGRAM_BOT_TOKEN", allowlist: [] };
        draft.channels = channels;
        state.config = draft;
        renderConfigForm(draft);
      } catch (error) { $("config-error").textContent = error.message; }
    });
    $("config-channels").addEventListener("click", (event) => {
      const removeChannel = event.target.closest("[data-remove-channel]");
      if (removeChannel) removeChannel.closest("[data-channel-card]").remove();
    });
    $("config-providers").addEventListener("click", (event) => {
      const removeProvider = event.target.closest("[data-remove-provider]");
      if (removeProvider) {
        removeProvider.closest("[data-provider-card]").remove();
        return;
      }
      const addParam = event.target.closest("[data-add-auth-param]");
      if (addParam) {
        const list = addParam.parentElement.querySelector("[data-auth-params]");
        const row = document.createElement("div");
        row.className = "config-list-row";
        row.setAttribute("data-auth-param-row", "");
        row.innerHTML = '<div class="grid-2"><div class="field"><label>Parameter name</label><input data-auth-param-key autocomplete="off"></div><div class="field"><label>Value</label><input data-auth-param-value autocomplete="off"></div></div><button class="danger-button" data-remove-auth-param type="button" aria-label="Remove OAuth authorization parameter">Remove</button>';
        list.appendChild(row);
        row.querySelector("[data-auth-param-key]").focus();
        return;
      }
      const removeParam = event.target.closest("[data-remove-auth-param]");
      if (removeParam) removeParam.closest("[data-auth-param-row]").remove();
    });
    $("config-add-invariant").addEventListener("click", () => {
      const list = $("config-invariants");
      if (list.querySelector(".empty-state")) list.innerHTML = "";
      const row = document.createElement("div");
      row.innerHTML = renderInvariantForm({ id: "", type: "command.deny-pattern", values: [], enforcement: "block" });
      list.appendChild(row.firstElementChild);
      list.lastElementChild.querySelector('[data-invariant-field="id"]').focus();
    });
    $("config-invariants").addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove-invariant]");
      if (remove) remove.closest("[data-invariant-row]").remove();
    });
    $("config-add-command").addEventListener("click", () => {
      const list = $("config-proof-commands");
      if (list.querySelector(".empty-state")) list.innerHTML = "";
      const row = document.createElement("div");
      row.innerHTML = renderProofCommand([]);
      list.appendChild(row.firstElementChild);
      list.lastElementChild.querySelector("[data-command-args]").focus();
    });
    $("config-proof-commands").addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove-command]");
      if (remove) remove.closest("[data-proof-command]").remove();
    });
    $("reload-config").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      try {
        setBusy(button, true);
        await refreshConfig();
        showToast("Configuration reloaded from disk.");
      } catch (error) {
        $("config-error").textContent = error.message;
        showToast(error.message, "error");
      } finally {
        setBusy(button, false);
      }
    });
    $("save-config").addEventListener("click", saveConfig);
    $("sidebar-search").addEventListener("click", () => {
      const query = window.prompt("Search sessions", "");
      if (query === null) return;
      const normalized = query.trim().toLowerCase();
      document.querySelectorAll(".menu-chat").forEach((item) => {
        item.hidden = Boolean(normalized) && !item.textContent.toLowerCase().includes(normalized);
      });
    });
    $("sidebar-settings").addEventListener("click", () => switchView("config"));
    $("sidebar-console").addEventListener("click", () => switchView("capabilities"));
    $("sidebar-theme").addEventListener("click", () => {
      document.body.classList.toggle("soft-contrast");
      showOutput(document.body.classList.contains("soft-contrast") ? "Soft contrast enabled." : "Soft contrast disabled.");
    });
    $("model-select").addEventListener("change", (event) => {
      state.modelOverride = event.currentTarget.value;
    });
    $("copy-onboard-command").addEventListener("click", async () => {
      await navigator.clipboard?.writeText("odinn onboard");
      showOutput("Copied odinn onboard.");
    });
    $("remote-signout").addEventListener("click", async (event) => {
      if (!state.hosted) return;
      const button = event.currentTarget;
      setBusy(button, true);
      try {
        await api("/auth/logout", { method: "POST" });
        location.assign("/auth/login");
      } catch (error) {
        setBusy(button, false);
        showOutput("Sign out failed: " + error.message);
      }
    });
    $("new-chat").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      try {
        setBusy(button, true);
        clearChatAttachments();
        await createChat("New chat");
      } catch (error) {
        showOutput(error.message);
      } finally {
        setBusy(button, false);
      }
    });
    function handleChatRailClick(event) {
      const action = event.target.closest("[data-session-action]");
      if (action) {
        event.stopPropagation();
        const operation = action.dataset.sessionAction === "rename" ? renameChat : deleteChat;
        operation(action.dataset.sessionId).catch((error) => showOutput(error.message));
        return;
      }
      const item = event.target.closest("[data-chat-session-id]");
      if (item) {
        clearChatAttachments();
        loadChat(item.dataset.chatSessionId).catch((error) => showOutput(error.message));
      }
    }
    $("chat-session-list").addEventListener("click", handleChatRailClick);
    $("pinned-chat-list").addEventListener("click", handleChatRailClick);
    $("chat-thread").addEventListener("click", (event) => {
      const prompt = event.target.closest("[data-chat-prompt]");
      if (!prompt) return;
      $("chat-input").value = prompt.dataset.chatPrompt || "";
      $("chat-input").focus();
    });
    $("send-chat").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      try {
        setBusy(button, true);
        await sendChatMessage($("chat-input").value);
      } catch (error) {
        $("chat-status").textContent = "Error";
        showOutput(error.message);
      } finally {
        setBusy(button, false);
      }
    });
    $("attach-chat-file").addEventListener("click", () => $("chat-file-input").click());
    $("chat-file-input").addEventListener("change", (event) => {
      addChatFiles(event.target.files).catch((error) => showOutput(error.message));
    });
    $("chat-file-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-local-attachment-remove]");
      if (!button) return;
      const index = Number(button.dataset.localAttachmentRemove);
      if (!Number.isInteger(index) || index < 0 || index >= chatAttachments.length) return;
      chatAttachments = chatAttachments.filter((_, attachmentIndex) => attachmentIndex !== index);
      renderChatAttachments();
    });
    $("chat-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        $("send-chat").click();
      }
    });
    $("clear-output").addEventListener("click", () => showOutput("Ready."));
    $("copy-audit").addEventListener("click", async () => {
      await navigator.clipboard?.writeText($("audit-log").textContent);
      showOutput("Current audit page copied.");
    });
    $("refresh-audit").addEventListener("click", () => refreshAudit().catch((error) => showOutput(error.message)));
    let auditDebounce;
    const changeAuditFilters = () => {
      state.auditPage = 1;
      clearTimeout(auditDebounce);
      auditDebounce = setTimeout(() => refreshAudit().catch((error) => showOutput(error.message)), 180);
    };
    ["audit-query", "audit-type-filter", "audit-tool-filter", "audit-actor-filter", "audit-outcome-filter", "audit-from", "audit-to"].forEach((id) => {
      $(id).addEventListener(id === "audit-query" ? "input" : "change", changeAuditFilters);
    });
    $("audit-page-size").addEventListener("change", changeAuditFilters);
    $("audit-prev").addEventListener("click", () => { state.auditPage = Math.max(1, state.auditPage - 1); refreshAudit().catch((error) => showOutput(error.message)); });
    $("audit-next").addEventListener("click", () => { state.auditPage = Math.min(state.auditPagination.pages || 1, state.auditPage + 1); refreshAudit().catch((error) => showOutput(error.message)); });
    $("audit-reset").addEventListener("click", () => {
      ["audit-query", "audit-type-filter", "audit-tool-filter", "audit-actor-filter", "audit-outcome-filter", "audit-from", "audit-to"].forEach((id) => { $(id).value = ""; });
      changeAuditFilters();
    });
    $("audit-verify").addEventListener("click", async () => {
      try {
        const result = await api("/audit/verify");
        const valid = result.valid !== false;
        $("audit-integrity").textContent = valid ? "Journal chain valid" : "Integrity failure";
        $("audit-integrity").className = "chip " + (valid ? "ok" : "danger");
        showOutput(result);
      } catch (error) { showOutput(error.message); }
    });
    $("export-audit").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(state.audit, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "odinn-audit-page-" + String(state.auditPage) + ".json";
      link.click();
      URL.revokeObjectURL(link.href);
    });

    $("runs").addEventListener("click", (event) => {
      const item = event.target.closest("[data-run-id]");
      if (item) showRunDetail(item.dataset.runId).catch((error) => showOutput(error.message));
    });
    $("plan-runs").addEventListener("click", (event) => {
      const item = event.target.closest("[data-run-id]");
      if (item) showRunDetail(item.dataset.runId).catch((error) => showOutput(error.message));
    });
    $("goal-list").addEventListener("click", (event) => {
      const card = event.target.closest("[data-goal-id]");
      if (!card) return;
      const goal = state.goals.find((entry) => entry.id === card.dataset.goalId);
      if (!goal) return;
      const action = event.target.closest("[data-goal-action]");
      if (action) {
        quickUpdateGoal(goal, action.dataset.goalAction).catch((error) => showOutput(error.message));
        return;
      }
      if (event.target.closest("[data-goal-edit]")) openGoalEditor(goal);
    });
    $("session-list").addEventListener("click", async (event) => {
      const action = event.target.closest("[data-session-action]");
      if (action) {
        event.stopPropagation();
        const operation = action.dataset.sessionAction === "rename" ? renameChat : deleteChat;
        await operation(action.dataset.sessionId).catch((error) => showOutput(error.message));
        return;
      }
      const item = event.target.closest("[data-session-id]");
      if (!item) return;
      state.selectedSessionId = item.dataset.sessionId;
      const detail = await api("/sessions/" + encodeURIComponent(state.selectedSessionId));
      renderSessionTranscript(detail);
      showOutput(detail);
    });
    $("session-list").addEventListener("change", async (event) => {
      const select = event.target.closest("[data-session-project]");
      if (!select) return;
      try {
        const detail = await api("/sessions/" + encodeURIComponent(select.dataset.sessionProject), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: select.value }) });
        state.selectedProjectId = select.value;
        showOutput(detail);
        await refreshProjects();
        await refreshSessions();
      } catch (error) { showOutput(error.message); }
    });

    $("create-session").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      try {
        const title = window.prompt("Session title", "New session");
        if (!title?.trim()) return;
        setBusy(button, true);
        const session = await api("/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: title.trim(), source: "console", projectId: state.projects.find((project) => project.id === $("session-project-filter").value && project.status === "active")?.id || state.projects.find((project) => project.id === state.selectedProjectId && project.status === "active")?.id || "project_default" })
        });
        state.selectedSessionId = session.id;
        showOutput(session);
        await refreshSessions();
        await refreshRuns();
      } catch (error) {
        showOutput(error.message);
      } finally {
        setBusy(button, false);
      }
    });
    $("new-goal").addEventListener("click", () => openGoalEditor());
    $("goal-form").addEventListener("submit", async (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      const button = event.submitter;
      try {
        setBusy(button, true);
        const scopeType = $("goal-scope-type").value;
        const scopeId = $("goal-scope-id").value;
        if (!scopeId) throw new Error("Choose where this goal belongs.");
        let result;
        if (state.selectedGoalId) {
          result = await api("/goals/" + encodeURIComponent(state.selectedGoalId) + "/updates", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: $("goal-title").value.trim(), description: $("goal-description").value.trim(), status: $("goal-status").value, note: $("goal-note").value.trim(), source: "console" })
          });
        } else {
          result = await api("/goals", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: $("goal-title").value.trim(), description: $("goal-description").value.trim(), source: "console", ...(scopeType === "session" ? { sessionId: scopeId } : { projectId: scopeId }) })
          });
          state.selectedGoalId = result.id;
        }
        closeDialog($("goal-dialog"));
        showOutput(result);
        await refreshGoals();
        await refreshRuns();
      } catch (error) {
        showOutput(error.message);
      } finally {
        setBusy(button, false);
      }
    });
    $("refresh-sessions").addEventListener("click", () => refreshSessions().catch((error) => showOutput(error.message)));
    $("session-query").addEventListener("input", renderSessionTable);
    $("session-status-filter").addEventListener("change", renderSessionTable);
    $("session-project-filter").addEventListener("change", renderSessionTable);
    $("session-group").addEventListener("change", renderSessionTable);
    $("refresh-agent-graphs").addEventListener("click", () => refreshAgentGraphs().catch((error) => showOutput(error.message)));
    $("agent-graph-status-filter").addEventListener("change", renderAgentGraphList);
    $("agent-graph-list").addEventListener("click", (event) => {
      const item = event.target.closest("[data-agent-graph-id]");
      if (item) selectAgentGraph(item.dataset.agentGraphId).catch((error) => showOutput(error.message));
    });
    $("agent-graph-cancel").addEventListener("click", () => cancelSelectedAgentGraph().catch((error) => showOutput(error.message)));
    $("agent-graph-reassign").addEventListener("click", openAgentGraphReassignment);
    $("agent-graph-checkpoint").addEventListener("click", openAgentGraphCheckpoint);
    $("agent-graph-checkpoint-dialog").addEventListener("cancel", clearAgentGraphCheckpointToken);
    $("agent-graph-checkpoint-dialog").addEventListener("close", clearAgentGraphCheckpointToken);
    $("agent-graph-reassign-form").addEventListener("submit", async (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      const graph = selectedAgentGraph();
      if (!graph) return;
      try {
        const replacement = JSON.parse($("agent-graph-replacement-json").value);
        const replacementId = $("agent-graph-replacement-id").value.trim();
        replacement.id = replacementId;
        const result = await api("/agent-graphs/" + encodeURIComponent(graph.graphRunId) + "/reassign", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": replacementId },
          body: JSON.stringify({ expectedRequestDigest: graph.requestDigest, replacement })
        });
        closeDialog($("agent-graph-reassign-dialog"));
        showOutput(result);
        await refreshAgentGraphs();
      } catch (error) { showOutput(error.message); }
    });
    $("agent-graph-checkpoint-form").addEventListener("submit", async (event) => {
      if (event.submitter?.value === "cancel") {
        clearAgentGraphCheckpointToken();
        return;
      }
      event.preventDefault();
      const graph = selectedAgentGraph();
      const node = graph?.nodes.find((item) => item.nodeId === $("agent-graph-checkpoint-node").value);
      try {
        if (!graph || !node?.resultDigest) throw new Error("The selected child result is no longer available.");
        const payload = JSON.parse($("agent-graph-checkpoint-json").value);
        const runId = $("agent-graph-checkpoint-run").value.trim();
        const capabilityToken = $("agent-graph-checkpoint-token").value;
        const serializedRequest = JSON.stringify({ ...payload, runId, nodeId: node.nodeId, expectedResultDigest: node.resultDigest, capabilityToken });
        clearAgentGraphCheckpointToken();
        const result = await api("/agent-graphs/" + encodeURIComponent(graph.graphRunId) + "/checkpoint", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": runId },
          body: serializedRequest
        });
        closeDialog($("agent-graph-checkpoint-dialog"));
        showOutput(result);
        await selectAgentGraph(graph.graphRunId);
      } catch (error) { showOutput(error.message); }
      finally { clearAgentGraphCheckpointToken(); }
    });
    $("refresh-goals").addEventListener("click", () => refreshGoals().catch((error) => showOutput(error.message)));
    $("goal-query").addEventListener("input", () => refreshGoals().catch((error) => showOutput(error.message)));
    $("goal-status-filter").addEventListener("change", () => refreshGoals().catch((error) => showOutput(error.message)));
    $("goal-project-filter").addEventListener("change", () => refreshGoals().catch((error) => showOutput(error.message)));
    $("goal-scope-type").addEventListener("change", updateGoalScopeOptions);

    $("refresh-tasks").addEventListener("click", () => refreshTasks().catch((error) => showOutput(error.message)));
    let taskDebounce;
    const changeTaskFilters = () => {
      state.taskPage = 1;
      clearTimeout(taskDebounce);
      taskDebounce = setTimeout(() => refreshTasks().catch((error) => showOutput(error.message)), 180);
    };
    $("task-query").addEventListener("input", changeTaskFilters);
    ["task-status-filter", "task-category-filter", "task-system-toggle", "task-page-size"].forEach((id) => $(id).addEventListener("change", changeTaskFilters));
    $("task-prev").addEventListener("click", () => { state.taskPage = Math.max(1, state.taskPage - 1); refreshTasks().catch((error) => showOutput(error.message)); });
    $("task-next").addEventListener("click", () => { state.taskPage = Math.min(state.taskPagination.pages || 1, state.taskPage + 1); refreshTasks().catch((error) => showOutput(error.message)); });
    $("task-select-page").addEventListener("change", (event) => {
      for (const task of state.tasks || []) {
        if (event.target.checked) state.taskSelection.set(task.id, task);
        else state.taskSelection.delete(task.id);
      }
      renderTasks();
    });
    $("task-clear-selection").addEventListener("click", () => { state.taskSelection.clear(); renderTasks(); });
    $("task-rerun-selected").addEventListener("click", () => runSelectedTaskAction("replay").catch((error) => showOutput(error.message)));
    $("task-cancel-selected").addEventListener("click", () => runSelectedTaskAction("cancel").catch((error) => showOutput(error.message)));
    $("task-table").addEventListener("change", (event) => {
      const input = event.target.closest("[data-task-select]");
      if (!input) return;
      const task = (state.tasks || []).find((entry) => entry.id === input.dataset.taskSelect);
      if (input.checked && task) state.taskSelection.set(task.id, task);
      else state.taskSelection.delete(input.dataset.taskSelect);
      updateTaskManagement();
    });
    $("task-table").addEventListener("click", async (event) => {
      const inspect = event.target.closest("[data-task-inspect]");
      const replay = event.target.closest("[data-task-replay]");
      const cancel = event.target.closest("[data-task-cancel]");
      try {
        if (inspect) await inspectTask(inspect.dataset.taskInspect);
        if (replay) { const result = await replayTask(replay.dataset.taskReplay); if (result) showOutput(result); await refreshTasks(); }
        if (cancel) { const result = await cancelTask(cancel.dataset.taskCancel); if (result) showOutput(result); await refreshTasks(); }
      } catch (error) {
        showOutput(error.message);
      }
    });
    $("task-verify").addEventListener("click", async () => {
      if (!state.selectedTaskId) return;
      try {
        const result = await api("/runtime/runs/" + encodeURIComponent(state.selectedTaskId) + "/verify");
        $("task-summary").insertAdjacentHTML("beforeend", '<div class="item"><div class="muted">History check</div><strong>' + escapeHtml(result.valid === false ? "Needs attention" : "Passed") + '</strong></div>');
        showOutput(result.valid === false ? "The task history may have changed." : "The task history is intact.");
      } catch (error) { showOutput("Verification unavailable: " + error.message); }
    });
    $("task-replay").addEventListener("click", async () => {
      const result = await replayTask(state.selectedTaskId);
      if (result) showOutput(result);
      await refreshTasks();
    });
    $("task-cancel").addEventListener("click", async () => {
      const result = await cancelTask(state.selectedTaskId);
      if (result) showOutput(result);
      await refreshTasks();
    });

    $("new-cron").addEventListener("click", () => { updateSchedulePattern(); openDialog($("cron-dialog")); });
    $("refresh-cron").addEventListener("click", () => refreshCron().catch((error) => showOutput(error.message)));
    $("cron-query").addEventListener("input", () => refreshCron().catch((error) => showOutput(error.message)));
    ["cron-frequency", "cron-time", "cron-weekday"].forEach((id) => $(id).addEventListener("change", updateSchedulePattern));
    $("cron-form").addEventListener("submit", async (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      try {
        updateSchedulePattern();
        await api("/cron", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: $("cron-name").value, schedule: $("cron-schedule").value, timezone: $("cron-timezone").value, tool: $("cron-tool").value, input: JSON.parse($("cron-input").value || "{}") }) });
        closeDialog($("cron-dialog"));
        await refreshCron();
      } catch (error) { showOutput(/JSON/i.test(error.message) ? "The advanced action input needs valid structured data." : error.message); }
    });
    $("cron-list").addEventListener("click", async (event) => {
      const run = event.target.closest("[data-cron-run]");
      const toggle = event.target.closest("[data-cron-toggle]");
      const remove = event.target.closest("[data-cron-delete]");
      try {
        if (run) {
          const job = (state.cronJobs || []).find((entry) => entry.id === run.dataset.cronRun);
          if (job && window.confirm('Run “' + job.name + '” now with its saved settings?')) {
            showOutput(await api("/cron/" + encodeURIComponent(run.dataset.cronRun) + "/run", { method: "POST" }));
          }
        }
        if (toggle) await api("/cron/" + encodeURIComponent(toggle.dataset.cronToggle), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: toggle.dataset.enabled !== "true" }) });
        if (remove) {
          const job = (state.cronJobs || []).find((entry) => entry.id === remove.dataset.cronDelete);
          if (job && window.confirm('Delete "' + job.name + '"? Its schedule and saved input will be removed. This cannot be undone from the console.')) {
            await api("/cron/" + encodeURIComponent(remove.dataset.cronDelete), { method: "DELETE" });
          }
        }
        await refreshCron();
      } catch (error) { showOutput(error.message); }
    });

    function manifestList(id) {
      return $(id).value.split(",").map((value) => value.trim()).filter(Boolean);
    }

    function readAgentManifestFields() {
      return {
        ...(state.agentManifestDraft || {}),
        sdkVersion: "1.0",
        id: $("agent-id").value.trim(),
        version: $("agent-version").value.trim(),
        name: $("agent-name").value.trim(),
        identity: { ...(state.agentManifestDraft?.identity || {}), name: $("agent-identity").value.trim() },
        instructions: manifestList("agent-instructions"),
        tools: manifestList("agent-tools"),
        plugins: manifestList("agent-plugins"),
        secrets: manifestList("agent-secrets"),
        sandbox: { ...(state.agentManifestDraft?.sandbox || {}), mode: $("agent-sandbox").value },
        network: { ...(state.agentManifestDraft?.network || {}), default: "deny", allow: manifestList("agent-network") },
        schedules: state.agentManifestDraft?.schedules || [],
        channels: state.agentManifestDraft?.channels || [],
        memory: state.agentManifestDraft?.memory || {},
        tests: state.agentManifestDraft?.tests || []
      };
    }

    function writeAgentManifestFields(manifest) {
      $("agent-id").value = manifest.id || "";
      $("agent-version").value = manifest.version || "1.0.0";
      $("agent-name").value = manifest.name || "";
      $("agent-identity").value = manifest.identity?.name || "";
      $("agent-instructions").value = (manifest.instructions || []).join(", ");
      $("agent-tools").value = (manifest.tools || []).join(", ");
      $("agent-plugins").value = (manifest.plugins || []).join(", ");
      $("agent-secrets").value = (manifest.secrets || []).join(", ");
      $("agent-sandbox").value = manifest.sandbox?.mode || "workspace-write";
      $("agent-network").value = (manifest.network?.allow || []).join(", ");
    }

    function setAgentAdvanced(enabled) {
      $("agent-manifest-error").textContent = "";
      if (enabled) {
        $("agent-manifest").value = JSON.stringify(readAgentManifestFields(), null, 2);
      } else if (!$("agent-manifest").hidden && $("agent-manifest").value.trim()) {
        state.agentManifestDraft = JSON.parse($("agent-manifest").value);
        writeAgentManifestFields(state.agentManifestDraft);
      }
      $("agent-advanced-toggle").checked = enabled;
      $("agent-manifest").hidden = !enabled;
      $("manifest-fields").hidden = enabled;
    }

    $("new-agent").addEventListener("click", () => {
      $("agent-form").reset();
      state.agentManifestDraft = null;
      $("agent-manifest").hidden = true;
      $("manifest-fields").hidden = false;
      $("agent-manifest-error").textContent = "";
      $("agent-manifest").value = JSON.stringify(readAgentManifestFields(), null, 2);
      openDialog($("agent-dialog"));
    });
    $("agent-advanced-toggle").addEventListener("change", (event) => {
      try { setAgentAdvanced(event.target.checked); }
      catch (error) {
        event.target.checked = true;
        $("agent-manifest").hidden = false;
        $("manifest-fields").hidden = true;
        $("agent-manifest-error").textContent = "Fix the JSON before returning to the guided fields: " + error.message;
      }
    });
    $("refresh-agents").addEventListener("click", () => refreshAgents().catch((error) => showOutput(error.message)));
    $("agent-query").addEventListener("input", () => refreshAgents().catch((error) => showOutput(error.message)));
    $("agent-form").addEventListener("submit", async (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      try {
        const manifest = $("agent-advanced-toggle").checked ? JSON.parse($("agent-manifest").value) : readAgentManifestFields();
        await api("/agents/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(manifest) });
        const result = await api("/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(manifest) });
        state.selectedAgentId = result.agent.id;
        closeDialog($("agent-dialog"));
        await refreshAgents();
        renderAgentDetail(result.agent);
      } catch (error) {
        $("agent-manifest-error").textContent = error.message;
        showOutput(error.message);
      }
    });
    $("agent-list").addEventListener("click", (event) => {
      const item = event.target.closest("[data-agent-id]");
      if (item) renderAgentDetail(state.agents.find((agent) => agent.id === item.dataset.agentId));
    });
    for (const [buttonId, action] of [["agent-enable", "enable"], ["agent-disable", "disable"], ["agent-quarantine", "quarantine"]]) {
      $(buttonId).addEventListener("click", async () => {
        if (!state.selectedAgentId) return;
        const agent = state.agents.find((entry) => entry.id === state.selectedAgentId);
        const effect = action === "enable"
          ? "This makes the agent available, but does not start any work."
          : action === "quarantine"
            ? "Its setup will be kept, but it cannot be used until you restore it."
            : "Its setup will be kept, but it cannot be selected.";
        if (!agent || !window.confirm(action[0].toUpperCase() + action.slice(1) + ' "' + agent.name + '"? ' + effect)) return;
        await api("/agents/" + encodeURIComponent(state.selectedAgentId) + "/lifecycle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
        await refreshAgents();
      });
    }

    $("refresh-skills").addEventListener("click", () => refreshSkills().catch((error) => showOutput(error.message)));
    $("skill-query").addEventListener("input", () => refreshSkills().catch((error) => showOutput(error.message)));
    $("skill-status-filter").addEventListener("change", () => refreshSkills().catch((error) => showOutput(error.message)));
    $("skills-list").addEventListener("click", (event) => {
      const item = event.target.closest("[data-skill-id]");
      if (item) renderSkillDetail(state.skills.find((skill) => skill.id === item.dataset.skillId));
    });
    $("new-skill").addEventListener("click", () => {
      $("skill-form").reset();
      openDialog($("skill-dialog"));
    });
    $("skill-form").addEventListener("submit", async (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      const list = (id) => $(id).value.split(",").map((value) => value.trim()).filter(Boolean);
      const manifest = {
        sdkVersion: "0.1", id: $("skill-id").value.trim() || $("skill-name").value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63), version: $("skill-version").value.trim(), name: $("skill-name").value.trim(),
        description: $("skill-description").value.trim(), instructions: $("skill-instructions").value.trim(),
        requestedTools: list("skill-tools"), requestedCapabilities: list("skill-capabilities"), requestedSecrets: list("skill-secrets"),
        network: { default: "deny", allow: list("skill-network") }, tests: []
      };
      try {
        await api("/skills/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(manifest) });
        const result = await api("/skills", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(manifest) });
        state.selectedSkillId = result.skill.id;
        closeDialog($("skill-dialog"));
        await refreshSkills();
        renderSkillDetail(state.skills.find((skill) => skill.id === state.selectedSkillId));
        showOutput(result);
      } catch (error) { showOutput(error.message); }
    });
    for (const [buttonId, action] of [["skill-enable", "enable"], ["skill-disable", "disable"], ["skill-quarantine", "quarantine"]]) {
      $(buttonId).addEventListener("click", async () => {
        if (!state.selectedSkillId) return;
        const skill = state.skills.find((entry) => entry.id === state.selectedSkillId);
        const effect = action === "enable"
          ? "This makes the skill available to Ódinn."
          : action === "quarantine"
            ? "Its setup will be kept, but it cannot be turned on until you restore it."
            : "Its setup will be kept, but Ódinn cannot use it.";
        if (!skill || !window.confirm(action[0].toUpperCase() + action.slice(1) + ' "' + skill.name + '"? ' + effect)) return;
        await api("/skills/" + encodeURIComponent(state.selectedSkillId) + "/lifecycle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
        await refreshSkills();
        renderSkillDetail(state.skills.find((skill) => skill.id === state.selectedSkillId));
      });
    }
    $("skill-verify").addEventListener("click", async () => {
      if (!state.selectedSkillId) return;
      const result = await api("/skills/" + encodeURIComponent(state.selectedSkillId) + "/verify");
      showOutput(result);
      await refreshSkills();
      renderSkillDetail(state.skills.find((skill) => skill.id === state.selectedSkillId));
    });

    $("new-project").addEventListener("click", () => {
      $("project-form").reset();
      openDialog($("project-dialog"));
    });
    $("refresh-projects").addEventListener("click", () => refreshProjects().catch((error) => showOutput(error.message)));
    $("project-query").addEventListener("input", () => refreshProjects().catch((error) => showOutput(error.message)));
    $("project-list").addEventListener("click", (event) => {
      const item = event.target.closest("[data-project-id]");
      if (item) renderProjectDetail(state.projects.find((project) => project.id === item.dataset.projectId));
    });
    $("project-form").addEventListener("submit", async (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      try {
        const result = await api("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: $("project-name").value.trim(), description: $("project-description").value.trim(), source: "console" }) });
        state.selectedProjectId = result.id;
        closeDialog($("project-dialog"));
        await refreshProjects();
        showOutput(result);
      } catch (error) { showOutput(error.message); }
    });
    $("project-archive").addEventListener("click", async () => {
      const project = state.projects.find((entry) => entry.id === state.selectedProjectId);
      if (!project || state.selectedProjectId === "project_default" || !window.confirm('Archive "' + project.name + '"? Its sessions and goals will remain stored and viewable.')) return;
      const result = await api("/projects/" + encodeURIComponent(state.selectedProjectId), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "archived", source: "console" }) });
      state.selectedProjectId = "project_default";
      await refreshProjects();
      showOutput(result);
    });
    $("project-open-sessions").addEventListener("click", () => {
      $("session-project-filter").value = state.selectedProjectId;
      renderSessionTable();
      switchView("sessions");
    });
    $("project-open-goals").addEventListener("click", () => {
      $("goal-project-filter").value = state.selectedProjectId;
      refreshGoals().catch((error) => showOutput(error.message));
      switchView("goals");
    });

    $("memory-query").addEventListener("input", renderMemoryLibrary);
    $("memory-kind-filter").addEventListener("change", renderMemoryLibrary);
    $("memory-scope-filter").addEventListener("change", renderMemoryLibrary);
    $("refresh-memory-tree").addEventListener("click", () => refreshMemory().catch((error) => showOutput(error.message)));
    document.querySelectorAll("[data-memory-tab]").forEach((button) => {
      button.addEventListener("click", () => setMemoryTab(button.dataset.memoryTab, true));
      button.addEventListener("keydown", (event) => {
        const tabs = [$("memory-tab-suggestions"), $("memory-tab-saved")];
        const current = tabs.indexOf(event.currentTarget);
        const next = event.key === "ArrowRight" ? (current + 1) % tabs.length
          : event.key === "ArrowLeft" ? (current - 1 + tabs.length) % tabs.length
          : event.key === "Home" ? 0
          : event.key === "End" ? tabs.length - 1
          : -1;
        if (next < 0) return;
        event.preventDefault();
        const target = tabs[next];
        setMemoryTab(target.dataset.memoryTab, true);
        target.focus();
      });
    });
    $("memory-candidate-list").addEventListener("click", (event) => {
      const tabTarget = event.target.closest("[data-memory-tab-target]");
      if (tabTarget) {
        setMemoryTab(tabTarget.dataset.memoryTabTarget, true);
        return;
      }
      const keep = event.target.closest("[data-memory-candidate-keep]");
      if (keep) {
        decideMemoryCandidate(keep.dataset.memoryCandidateKeep, "accepted", keep).catch((error) => {
          setBusy(keep, false);
          showOutput(error.message);
        });
        return;
      }
      const dismiss = event.target.closest("[data-memory-candidate-dismiss]");
      if (dismiss) {
        decideMemoryCandidate(dismiss.dataset.memoryCandidateDismiss, "rejected", dismiss).catch((error) => {
          setBusy(dismiss, false);
          showOutput(error.message);
        });
      }
    });
    $("memory-new-toggle").addEventListener("click", () => {
      $("memory-form").reset();
      updateMemoryScopeOptions();
      openDialog($("memory-dialog"));
    });
    $("memory-dialog-close").addEventListener("click", () => closeDialog($("memory-dialog")));
    $("memory-correction-dialog-close").addEventListener("click", () => closeDialog($("memory-correction-dialog")));
    $("memory-scope-type").addEventListener("change", updateMemoryScopeOptions);
    $("memory-list").addEventListener("click", (event) => {
      const item = event.target.closest("[data-memory-id]");
      if (item) {
        renderMemoryDetail(state.memories.find((memory) => memory.id === item.dataset.memoryId));
        if (matchMedia("(max-width: 600px)").matches) $("memory-detail-panel").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    $("memory-form").addEventListener("submit", async (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      const scopeType = $("memory-scope-type").value;
      const scopeId = $("memory-scope-id").value;
      try {
        const result = await api("/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          kind: $("memory-kind").value, subject: $("memory-subject").value.trim(), namespace: $("memory-namespace").value.trim(), tier: $("memory-tier").value,
          text: $("memory-text").value.trim(), tags: $("memory-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean), source: "console", authority: "user",
          scopeType, ...(scopeType === "global" ? {} : { scopeId }), ...(scopeType === "project" ? { projectId: scopeId } : {}), ...(scopeType === "session" ? { sessionId: scopeId } : {})
        }) });
        state.selectedMemoryId = result.id;
        setMemoryTab("saved", true);
        closeDialog($("memory-dialog"));
        await refreshMemory();
        showOutput(result);
      } catch (error) { showOutput(error.message); }
    });
    $("memory-correct").addEventListener("click", () => {
      const memory = state.memories.find((entry) => entry.id === state.selectedMemoryId);
      if (!memory) return;
      $("memory-correction-form").reset();
      $("memory-correction-text").value = memory.text || "";
      openDialog($("memory-correction-dialog"));
    });
    $("memory-correction-form").addEventListener("submit", async (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      try {
        const result = await api("/memory/corrections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetId: state.selectedMemoryId, text: $("memory-correction-text").value.trim(), reason: $("memory-correction-reason").value.trim(), source: "console", authority: "user-correction" }) });
        state.selectedMemoryId = result.id;
        setMemoryTab("saved");
        closeDialog($("memory-correction-dialog"));
        await refreshMemory();
        showOutput(result);
      } catch (error) { showOutput(error.message); }
    });
    $("memory-forget").addEventListener("click", async () => {
      const memory = state.memories.find((entry) => entry.id === state.selectedMemoryId);
      if (!memory || !window.confirm('Forget "' + (memory.subject || "this memory") + '"? Ódinn will stop using it.')) return;
      const result = await api("/memory/" + encodeURIComponent(memory.id) + "/forget", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "console", authority: "user" }) });
      state.selectedMemoryId = "";
      await refreshMemory();
      showOutput(result.forgotten ? "Memory forgotten." : "Memory could not be forgotten.");
    });
    $("memory-recall-test").addEventListener("click", async () => {
      const query = window.prompt("What are you working on?", $("memory-query").value || "project decisions");
      if (!query?.trim()) return;
      const params = new URLSearchParams({ query: query.trim(), limit: "8" });
      if (state.selectedProjectId) params.set("projectId", state.selectedProjectId);
      if (state.activeChatId) params.set("sessionId", state.activeChatId);
      const result = await api("/memory/recall?" + params);
      const recalled = result.memories || [];
      $("memory-recall-result").hidden = false;
      $("memory-recall-result").innerHTML = recalled.length
        ? '<strong>Ódinn would use ' + recalled.length + (recalled.length === 1 ? " saved memory" : " saved memories") + ' for this topic.</strong><ul class="human-list">' + recalled.map((memory) => '<li><strong>' + escapeHtml(memory.subject || friendlyStatus(memory.kind)) + '</strong><span class="muted"> ' + escapeHtml(memory.summary || memory.text) + '</span></li>').join("") + '</ul>'
        : '<strong>No saved memories match this topic.</strong><p class="muted">Ódinn would continue without adding memory context.</p>';
      showOutput(recalled.length ? "Recall preview ready." : "No matching memories found.");
      const recalledIds = new Set(recalled.map((memory) => memory.id));
      document.querySelectorAll("[data-memory-id]").forEach((item) => item.classList.toggle("selected", recalledIds.has(item.dataset.memoryId)));
    });
    switchView(viewFromHash(), { updateHash: false });
    refresh();
