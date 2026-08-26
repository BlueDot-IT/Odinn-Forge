process.env.ODINN_GATEWAY_AUTH = "off";
process.env.ODINN_BROWSER_HEADLESS = "1";

import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { createGatewayServer } from "../apps/gateway/src/server.ts";

const workspaceRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { chromium } = createRequire(import.meta.url)("../packages/kernel/node_modules/playwright-core");

function section(html: string, start: RegExp, end: RegExp) {
  const startMatch = start.exec(html);
  assert.ok(startMatch, `missing section start ${start}`);
  const tail = html.slice(startMatch.index);
  const endMatch = end.exec(tail.slice(startMatch[0].length));
  assert.ok(endMatch, `missing section end ${end}`);
  return tail.slice(0, startMatch[0].length + endMatch.index + endMatch[0].length);
}

function assertIds(html: string, ids: string[]) {
  for (const id of ids) assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
}

function openingTagById(html: string, id: string) {
  const match = new RegExp(`<[^>]+\\bid=["']${id}["'][^>]*>`, "iu").exec(html);
  assert.ok(match, `missing opening tag for #${id}`);
  return match[0];
}

function cssBlocks(source: string, header: RegExp) {
  const flags = header.flags.includes("g") ? header.flags : `${header.flags}g`;
  const matches = source.matchAll(new RegExp(header.source, flags));
  const blocks: string[] = [];
  for (const match of matches) {
    const matchIndex = match.index ?? 0;
    const openingBrace = source.indexOf("{", matchIndex);
    assert.notEqual(openingBrace, -1, `missing opening brace for ${header}`);
    let depth = 0;
    for (let index = openingBrace; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
      if (depth === 0) {
        blocks.push(source.slice(matchIndex, index + 1));
        break;
      }
    }
  }
  return blocks;
}

test("console presents the human-first product surfaces and dedicated Advanced pages", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-console-product-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    const statusResponse = await fetch(`http://127.0.0.1:${address.port}/status`);
    assert.equal(statusResponse.status, 200);
    const runtimeStatus = await statusResponse.json();
    const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/giu)].map((match) => match[1]);
    assert.equal(inlineScripts.length, 0, "the console must not ship inline executable JavaScript");
    const scriptReference = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/iu.exec(html)?.[1];
    assert.ok(scriptReference, "the console must reference a built JavaScript asset");
    const scriptResponse = await fetch(`http://127.0.0.1:${address.port}${scriptReference}`);
    assert.equal(scriptResponse.status, 200);
    const script = await scriptResponse.text();
    assert.doesNotThrow(() => new Script(script, { filename: "odinn-console.js" }));
    const productSource = `${html}\n${script}`;

    const navigation = section(html, /<nav class="nav"[^>]*>/, /<\/nav>/);
    assert.match(navigation, /data-view="overview"[\s\S]*data-view="sessions"/, "Sessions must sit directly below Chat");
    assert.match(navigation, /data-view="usage"[^>]*data-title="Activity"/);
    assert.doesNotMatch(navigation, /data-view="audit"/);
    assert.doesNotMatch(navigation, /data-view="experiments"/);
    assert.match(navigation, /<details class="nav-labs">/);
    assert.doesNotMatch(navigation, /data-view="(?:skill-workshop|workshop)"|>\s*Skill Workshop\s*</i);
    assert.match(navigation, /data-view="agents"[^>]*data-title="Agent SDK"/);
    assert.match(navigation, /data-view="skills"[^>]*data-title="Skills SDK"/);
    assert.match(navigation, /Agent SDK · Experimental/);
    assert.match(navigation, /Skills SDK · Experimental/);
    assert.match(navigation, /data-view="projects"[^>]*data-title="Projects"/);
    assert.match(navigation, /data-view="config"[^>]*data-title="Configuration"/);

    const viewMatches = [...html.matchAll(/<section\b[^>]*\bid=["']view-([^"']+)["'][^>]*>/giu)].map((match) => match[1]);
    const navigationMatches = [...navigation.matchAll(/\bdata-view=["']([^"']+)["']/giu)].map((match) => match[1]);
    const views = [...new Set(viewMatches)];
    const navigationTargets = [...new Set(navigationMatches)];
    assert.equal(views.length, 23, "the console must expose the product surface, operator controls, delegation, and eight dedicated Advanced pages");
    assert.equal(viewMatches.length, views.length, "console view ids must be unique");
    assert.equal(navigationMatches.length, navigationTargets.length, "console navigation targets must be unique");
    assert.deepEqual(
      [...navigationTargets].sort(),
      [...views].sort(),
      "every console view must have exactly one reachable navigation target"
    );
    assert.ok(navigationTargets.includes("capabilities"), "Web tools must be reachable from navigation");

    const operator = section(html, /<section id="view-operator"[^>]*>/, /<\/section>/);
    assertIds(operator, ["operator-health", "operator-attention", "operator-work", "operator-payload"]);
    const operatorPresenter = section(script, /function renderOperatorItem\s*\(/u, /function switchView\s*\(/u);
    assert.match(operatorPresenter, /item\.kind === ["']approval["'][\s\S]*item\.details\.effect/u);
    assert.match(operatorPresenter, /item\.kind === ["']job["'] \|\| item\.kind === ["']run["'][\s\S]*item\.details\.latestAttempt/u);
    assert.match(operatorPresenter, /snapshot\.sections\[name\]/u);
    assert.match(operatorPresenter, /snapshot\.health\.attention/u);
    assert.match(operatorPresenter, /section\(["']approvals["']\)\.counts\.pending/u);
    assert.match(operatorPresenter, /section\(["']recovery["']\)\.items/u);
    assert.match(operatorPresenter, /section\(["']audit["']\)\.items\[0\]\.status/u);
    assert.doesNotMatch(operatorPresenter, /item\?\.details|item\.details\?\.|snapshot\.sections\?\.|snapshot\.health\?\./u,
      "the console must present the validated item union instead of probing internal shapes");

    const skills = section(html, /<section id="view-skills"[^>]*>/, /<\/section>/);
    assert.match(skills, /<h1>Skills SDK<\/h1>/);
    assert.match(skills, /Experimental package/);
    assert.match(skills, /Build, review, and manage reusable instructions/);
    assert.match(skills, /Create (?:a )?skill/i);
    assertIds(skills, ["new-skill", "skill-status-filter", "skill-enable", "skill-disable", "skill-verify", "skill-quarantine"]);
    assert.doesNotMatch(skills, /Package ID|Network allowlist/);
    assert.doesNotMatch(skills, /Skill Workshop|id="view-(?:skill-workshop|workshop)"/i);

    const activity = section(html, /<section id="view-usage"[^>]*>/, /<section id="view-agents"[^>]*>/);
    assertIds(activity, [
      "activity-tab-overview",
      "activity-tab-history",
      "activity-overview",
      "activity-history",
      "audit-query",
      "audit-type-filter",
      "audit-tool-filter",
      "audit-actor-filter",
      "audit-outcome-filter",
      "audit-from",
      "audit-to",
      "audit-reset",
      "audit-verify",
      "export-audit",
      "audit-page-size",
      "audit-prev",
      "audit-next",
      "audit-page-label"
    ]);
    assert.match(activity, /Latest four conversations/);
    assert.match(productSource, /api\("\/audit\/query\?/);
    assert.match(productSource, /\.slice\(0,\s*4\)\.map\(renderRun\)/);

    const projects = section(html, /<section id="view-projects"[^>]*>/, /<\/section>/);
    assertIds(projects, ["new-project", "project-list", "project-detail", "project-open-sessions", "project-open-goals", "project-archive", "project-form"]);
    assert.match(projects, /Group related sessions/);

    const goals = section(html, /<section id="view-goals"[^>]*>/, /<\/section>/);
    assertIds(goals, ["new-goal", "goal-dialog", "goal-scope-type", "goal-scope-id", "goal-project-filter", "goal-status-filter", "goal-query", "goal-description", "goal-list"]);
    assert.match(goals, /update progress quickly/i);

    const config = section(html, /<section id="view-config"[^>]*>/, /<section id="view-automatic-improvements"[^>]*>/);
    assertIds(config, [
      "config-state", "config-error", "reload-config", "save-config", "config-restart", "config-form", "config-providers", "config-add-provider",
      "config-version", "config-audit-log", "config-default-model", "config-policy-max-input", "config-policy-id", "config-policy-version", "config-policy-allowed", "config-policy-denied",
      "config-web-allowed", "config-web-blocked", "config-browser-allowed", "config-browser-blocked", "config-invariants", "config-add-invariant",
      "config-self-mode", "config-self-interval", "config-self-max", "config-runtime-retries", "config-proof-commands", "config-add-command", "config-field-count"
    ]);
    assert.match(config, /Everything Ódinn can configure/);
    assert.match(config, /Model providers/);
    assert.match(config, /Gatewatch policy rules/);
    assert.match(config, /Optional plugin modules/);
    for (const plugin of ["capabilities", "capsules", "counterfactual"]) assert.match(config, new RegExp(`data-config-experimental="${plugin}"`));
    for (const core of ["proof", "sentinel", "rewind", "darwin"]) assert.doesNotMatch(config, new RegExp(`data-config-experimental="${core}"`));
    assert.match(config, /Runemark command allowlist/);
    assert.match(config, /data-config-security="web\.requireApproval"/u);
    assert.match(config, /data-config-security="web\.allowDownloads"/u);
    assert.match(config, /data-config-security="web\.allowUploads"/u);
    assert.doesNotMatch(config, /<textarea[^>]+id=["']config-editor["']/i);
    assert.match(config, /\.odinn\/config\.json/);
    assert.match(config, /restart/i);

    const memory = section(html, /<section id="view-memory"[^>]*>/, /<\/section>/);
    assertIds(memory, [
      "memory-health",
      "memory-record-count",
      "memory-candidate-count",
      "memory-tab-suggestions",
      "memory-tab-saved",
      "memory-suggestions-panel",
      "memory-saved-panel",
      "memory-candidate-list",
      "memory-recall-status",
      "memory-query",
      "memory-kind-filter",
      "memory-scope-filter",
      "memory-list",
      "memory-detail",
      "memory-correct",
      "memory-forget",
      "memory-recall-test",
      "memory-recall-result",
      "memory-scope-type",
      "memory-scope-id",
      "memory-scope-target-field",
      "memory-dialog-close",
      "memory-correction-dialog-close",
      "memory-correction-form"
    ]);
    assert.match(memory, /Review what Ódinn has noticed/i);
    assert.match(memory, /Review suggestions/i);
    assert.match(memory, /Saved memories/i);
    assert.match(productSource, /Keep memory/i);
    assert.match(productSource, /Suggestion dismissed/i);
    assert.doesNotMatch(memory, /Select all|Accept selected|Reject selected|Keep suggested scope/i);
    assert.doesNotMatch(memory, />namespaces</i);
    assert.match(productSource, /function setMemoryTab\s*\(/);
    assert.match(productSource, /function decideMemoryCandidate\s*\(/);
    assert.match(productSource, /data-memory-candidate-destination/);

    const agents = section(html, /<section id="view-agents"[^>]*>/, /<\/section>/);
    assert.match(agents, /<h1>Agent SDK<\/h1>/);
    assert.match(agents, /Experimental package/);
    assert.match(agents, /<label class="switch-label"><input type="checkbox" id="agent-advanced-toggle"> Developer setup<\/label>/);
    assertIds(agents, ["manifest-fields", "agent-manifest", "agent-manifest-error"]);
    assert.doesNotMatch(agents, /Register Agent SDK manifest|Package ID|Network allowlist/);
    assert.match(productSource, /function readAgentManifestFields\s*\(/);
    assert.match(productSource, /function writeAgentManifestFields\s*\(/);
    assert.match(productSource, /function setAgentAdvanced\s*\(/);
    assert.match(productSource, /setAgentAdvanced\(event\.target\.checked\)/);
    assert.match(productSource, /agentManifestDraft/);
    assert.match(productSource, /state\.agentManifestDraft = JSON\.parse/);
    assert.match(productSource, /\.\.\((?:state\.agentManifestDraft)|\.\.\.state\.agentManifestDraft(?:\?\.|\s*\|\|)/);

    const experiments = section(html, /<section id="view-automatic-improvements"[^>]*>/, /<section id="view-usage"[^>]*>/);
    assertIds(experiments, [
      "view-automatic-improvements",
      "view-lab-run-checks",
      "view-lab-safety-preview",
      "view-lab-temporary-access",
      "view-lab-restore-points",
      "view-lab-governed-workspace",
      "view-lab-portable-runs",
      "view-lab-scenario-compare",
      "view-lab-model-routing"
    ]);
    assert.equal(experiments.match(/data-experimental-page=/g)?.length ?? 0, 8);
    assert.match(experiments, /Runs quietly in the background/);
    assert.match(experiments, /Core capability/);
    assert.match(experiments, /Optional plugin module/);
    for (const brand of ["Runemark", "Gatewatch", "Norn Restore", "Norn Governance", "Raven Route", "Rune Key", "Saga Archive", "Worldtree Paths"]) {
      assert.match(experiments, new RegExp(brand));
    }
    assert.doesNotMatch(experiments, /release blocker|release-blocker|review queue|content-addressed artifact store/i);
    assert.doesNotMatch(html, /id="view-experiments"/);
    assert.match(script, /governance/);
    assert.match(script, /\bgovernance\b/);
    assert.match(script, /run-governed-workspace|lab-governed-workspace/);
    assert.match(script, /governed\/workspace\/mutate/);
    assert.match(script, /governed\/workspace\/patch/);
    assert.match(script, /governed\/restore\/create/);
    assert.match(script, /governed\/restore\/apply/);
    assert.match(script, /requiresConfirmation/);
    assert.match(script, /Apply only after review/);
    assert.match(script, /function renderGovernanceSummary/);
    assert.match(script, /Needs review/);
    assert.match(script, /Proposed operation/);
    assert.doesNotMatch(script, /workspace\\.writeText/);

    const globalFeedback = openingTagById(html, "toast-region");
    assert.match(globalFeedback, /\baria-live=["'](?:polite|assertive)["']/iu);
    assert.doesNotMatch(globalFeedback, /\bhidden\b/iu, "the shared feedback region must remain perceivable");

    const inlineStyles = [...html.matchAll(/<style(?:\s|>)/giu)];
    assert.equal(inlineStyles.length, 0, "the console must not ship inline CSS");
    const stylesheetReference = /<link\b[^>]*\b(?:rel=["']stylesheet["'][^>]*\bhref|href=["'][^"']+["'][^>]*\brel=["']stylesheet["'])=["']([^"']+)["']/iu.exec(html)?.[1]
      ?? /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/iu.exec(html)?.[1];
    assert.ok(stylesheetReference, "the console must reference a built stylesheet asset");
    const stylesheetResponse = await fetch(`http://127.0.0.1:${address.port}${stylesheetReference}`);
    assert.equal(stylesheetResponse.status, 200);
    const styles = await stylesheetResponse.text();
    const mobileStyles = cssBlocks(styles, /@media\s*\(max-width:\s*980px\)/iu).join("\n");
    assert.ok(mobileStyles, "missing narrow-screen console styles");
    assertIds(html, ["mobile-scrim"]);
    assert.match(mobileStyles, /\.sidebar\s*\{[^}]*position:\s*fixed/isu, "mobile navigation must become an off-canvas layer");
    assert.match(mobileStyles, /\.sidebar\s*\{[^}]*transform:\s*translateX/isu, "mobile navigation must move off canvas when closed");
    assert.match(mobileStyles, /\.content\s*\{[^}]*overflow(?:-y)?:\s*auto/isu, "mobile page content must remain scrollable");
    assert.doesNotMatch(mobileStyles, /\.content\s*\{[^}]*overflow:\s*hidden/isu);
    assert.match(styles, /\.(?:table-panel|table-scroll)\s*\{[^}]*overflow-x:\s*auto/isu, "wide data tables need a containing horizontal scroll viewport");

    assert.match(script, /location\.hash/u, "view selection must be reflected in the URL hash");
    assert.match(script, /addEventListener\(["']hashchange["']/u, "browser Back and direct hashes must restore the selected view");
    assert.match(script, /api\(["']\/config["']\)/u, "the configuration page must load config.json");
    assert.match(script, /function readStructuredConfig\s*\(/u, "configuration saves must collect structured fields");
    assert.match(script, /data-provider-field/u, "provider configuration must use individual fields");
    assert.match(script, /data-provider-auth="commandEnv"/u, "CLI provider authentication must be configurable");
    assert.match(script, /method:\s*["']PUT["'][\s\S]{0,320}fingerprint/u, "configuration saves must use conflict protection");
    assert.match(script, /sidebar-settings["']\)\.addEventListener\(["']click["'],\s*\(\)\s*=>\s*switchView\(["']config["']\)/u);
    assert.match(
      script,
      /chat-input["']\)\.addEventListener\(["']keydown["'][\s\S]*event\.key === ["']Enter["'] && !event\.shiftKey && !event\.isComposing && event\.keyCode !== 229[\s\S]*send-chat["']\)\.click\(\)/u,
      "Enter must send chat while Shift+Enter remains available for a newline"
    );
    const sessionControls = section(script, /function sessionDisplayTitle\s*\(/u, /function renderChatMessages\s*\(/u);
    assert.match(sessionControls, /window\.prompt\("Rename chat", sessionDisplayTitle\(sessionId\)\)/u);
    assert.match(sessionControls, /const title = sessionDisplayTitle\(sessionId\);[\s\S]*window\.confirm/u);
    assert.doesNotMatch(
      sessionControls,
      /const detail = await api\("\/sessions\/"/u,
      "rename and delete confirmations must stay directly attached to the click gesture"
    );
    assert.match(productSource, /data-session-action=\\?["']rename\\?["'][^>]*type=\\?["']button\\?["']/u);
    assert.match(productSource, /data-session-action=\\?["']delete\\?["'][^>]*type=\\?["']button\\?["']/u);
    assert.doesNotMatch(
      script,
      /finally\s*\{[^}]*setBusy\(event\.currentTarget,\s*false\)/u,
      "async handlers must retain their button reference so busy controls are re-enabled"
    );

    assert.doesNotMatch(html, /<span class="sidebar-version">\s*v0\.1\s*<\/span>/iu);
    const renderedVersion = /<span\b(?=[^>]*\bid=["']product-version["'])[^>]*>\s*([^<]+?)\s*<\/span>/iu.exec(html)?.[1];
    assert.equal(renderedVersion, `v${runtimeStatus.version}`, "the sidebar version must match runtime status");
    const capabilities = section(html, /<section id="view-capabilities"[^>]*>/, /<\/section>/);
    assert.match(capabilities, /<h1>Web tools<\/h1>/);
    assert.match(capabilities, /Public web search/);
    assert.match(capabilities, /Signed-in browser/);
    assert.doesNotMatch(capabilities, /id=["']cap-(?:web|browser)-status["'][^>]*>\s*READY\s*</iu, "provider-dependent capabilities must not claim READY before status loads");
    assert.doesNotMatch(capabilities, /id=["']cap-approval-count["'][^>]*>\s*0\s*</iu, "approval totals must not claim zero before status loads");
    assert.match(script, /cap-security-mode[\s\S]{0,180}requireApproval|requireApproval[\s\S]{0,180}cap-security-mode/u, "approval posture copy must come from runtime status");

    assert.match(activity, /id=["']audit-verify["'][^>]*>\s*Check history integrity\s*</iu);
    assert.doesNotMatch(activity, />\s*Verify (?:Chain|Ledger)\s*</iu);
    assert.match(
      script,
      /agent-quarantine[\s\S]{0,1200}(?:confirmDangerousAction|window\.confirm)|(?:confirmDangerousAction|window\.confirm)[\s\S]{0,1200}agent-quarantine/iu,
      "quarantining an agent needs explicit confirmation"
    );
    assert.match(
      script,
      /skill-quarantine[\s\S]{0,1200}(?:confirmDangerousAction|window\.confirm)|(?:confirmDangerousAction|window\.confirm)[\s\S]{0,1200}skill-quarantine/iu,
      "quarantining a skill needs explicit confirmation"
    );

    assertIds(html, ["provider-cta"]);
    assert.match(script, /\$\(["']provider-cta["']\)/u);
    const providerCopy = section(script, /function renderChatMessages\s*\(/u, /async function createChat\s*\(/u);
    assert.match(script, /providers[\s\S]{0,240}configured/u, "Chat readiness must use configured provider state");
    assert.match(script, /First-class support/u, "provider cards must show the first-class support boundary");
    assert.match(script, /Compatibility preset/u, "provider cards must distinguish compatibility presets");
    assert.match(script, /Custom compatibility mode/u, "provider cards must label custom endpoints");
    assert.doesNotMatch(providerCopy, /const configured = state\.status\?\.models\?\.length/u);
    assert.doesNotMatch(html, /id="(?:health|copy-status|quick-smoke|chat-smoke)"/u);
    assertIds(html, ["task-page-size", "task-prev", "task-next", "task-select-page", "task-rerun-selected", "task-cancel-selected"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
  }
});

test("delegation remains operable across responsive boundaries and clears checkpoint tokens across every exit", async () => {
  const chromiumPath = process.env.ODINN_CHROMIUM_PATH || chromium.executablePath();
  try {
    await access(chromiumPath);
  } catch (error) {
    assert.fail(`Pinned Chromium is required for the console regression (${chromiumPath}): ${String(error)}`);
  }

  const graph = {
    graphRunId: "graph-responsive-completed-with-a-long-identifier",
    parentRunId: "parent-responsive-with-a-long-identifier",
    requestDigest: "a".repeat(64),
    status: "completed",
    maxConcurrency: 2,
    maxRunMs: 120_000,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    nodes: [{
      nodeId: "child-mobile",
      manifestId: "research",
      status: "completed",
      resultRef: "result:child-mobile",
      resultDigest: "b".repeat(64),
    }],
  };
  const publishingGraph = {
    ...graph,
    graphRunId: "graph-responsive-publishing-with-a-long-identifier",
    parentRunId: "parent-responsive-publishing-with-a-long-identifier",
    status: "publishing",
    completedAt: undefined,
    startedAt: "2026-01-01T00:00:30.000Z",
    nodes: [{
      nodeId: "child-responsive-publishing",
      manifestId: "research",
      status: "running",
    }],
  };
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-console-delegation-browser-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  let browser: any;
  let checkpointMode: "reject" | "pending" = "reject";
  let releasePendingResponse = () => {};
  const pendingResponse = new Promise<void>((resolve) => { releasePendingResponse = resolve; });
  try {
    browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.route("**/agent-graphs**", async (route: any) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "POST" && url.pathname.endsWith("/checkpoint")) {
        if (checkpointMode === "reject") {
          await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "checkpoint rejected" }) });
          return;
        }
        await pendingResponse;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, applied: false }) });
        return;
      }
      if (url.pathname === "/agent-graphs") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ graphs: [graph, publishingGraph] }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ graph }) });
    });

    await page.goto(`http://127.0.0.1:${address.port}/#view=delegation`, { waitUntil: "domcontentloaded" });
    const graphRow = page.locator(".agent-graph-row").first();
    await graphRow.waitFor({ state: "visible" });
    await page.locator('.agent-graph-row[aria-current="true"]').waitFor({ state: "visible" });
    assert.equal(await page.locator('.agent-graph-row[aria-current="true"]').count(), 1);

    const responsiveWidths = [375, 600, 601, 980, 981, 1440];
    for (const width of responsiveWidths) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const metrics = await page.evaluate(() => {
        const content = document.querySelector<HTMLElement>(".content")!;
        const layout = document.querySelector<HTMLElement>(".agent-graph-layout")!;
        const panels = [...layout.querySelectorAll<HTMLElement>(":scope > .panel")];
        const listPanel = panels[0];
        const listBounds = listPanel.getBoundingClientRect();
        const detailBounds = panels[1].getBoundingClientRect();
        const rows = [...document.querySelectorAll<HTMLElement>(".agent-graph-row")].map((row) => {
          const bounds = row.getBoundingClientRect();
          return { left: bounds.left, right: bounds.right, clientWidth: row.clientWidth, scrollWidth: row.scrollWidth };
        });
        const controls = [
          "refresh-agent-graphs",
          "agent-graph-status-filter",
          "agent-graph-cancel",
          "agent-graph-reassign",
          "agent-graph-checkpoint",
        ].map((id) => {
          const control = document.getElementById(id)!;
          const bounds = control.getBoundingClientRect();
          const style = getComputedStyle(control);
          return { id, left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height, display: style.display, visibility: style.visibility };
        });
        return {
          viewportWidth: window.innerWidth,
          columns: getComputedStyle(layout).gridTemplateColumns,
          contentClientWidth: content.clientWidth,
          contentScrollWidth: content.scrollWidth,
          layoutClientWidth: layout.clientWidth,
          layoutScrollWidth: layout.scrollWidth,
          listClientWidth: listPanel.clientWidth,
          listScrollWidth: listPanel.scrollWidth,
          listLeft: listBounds.left,
          listRight: listBounds.right,
          listBottom: listBounds.bottom,
          detailLeft: detailBounds.left,
          detailTop: detailBounds.top,
          rows,
          controls,
          graphHeadDisplay: getComputedStyle(document.querySelector<HTMLElement>(".agent-graph-head")!).display,
        };
      });

      assert.equal(metrics.viewportWidth, width);
      const expectedColumns = width <= 980 ? 1 : 2;
      assert.equal(metrics.columns.trim().split(/\s+/u).length, expectedColumns, `delegation layout columns at ${width}px`);
      assert.ok(metrics.contentScrollWidth <= metrics.contentClientWidth, `console content must not overflow at ${width}px`);
      assert.ok(metrics.layoutScrollWidth <= metrics.layoutClientWidth, `delegation layout must not overflow at ${width}px`);
      assert.ok(metrics.listScrollWidth <= metrics.listClientWidth, `graph list must fit its panel at ${width}px`);
      for (const row of metrics.rows) {
        assert.ok(row.scrollWidth <= row.clientWidth, `graph row content must shrink at ${width}px`);
        assert.ok(row.left >= metrics.listLeft - 0.5 && row.right <= metrics.listRight + 0.5, `graph row must remain inside its panel at ${width}px`);
      }
      if (expectedColumns === 1) {
        assert.ok(metrics.detailTop >= metrics.listBottom, `graph detail must follow the list at ${width}px`);
      } else {
        assert.ok(metrics.detailLeft >= metrics.listRight, `graph panels must not overlap at ${width}px`);
      }
      for (const control of metrics.controls) {
        assert.ok(control.width > 0 && control.height > 0 && control.display !== "none" && control.visibility !== "hidden", `#${control.id} must remain rendered at ${width}px`);
        assert.ok(control.left >= -0.5 && control.right <= width + 0.5, `#${control.id} must remain horizontally accessible at ${width}px`);
      }

      if (width === 375 || width === 981) assert.equal(metrics.graphHeadDisplay, "none", `narrow graph components must use compact rows at ${width}px`);
      if (width === 600 || width === 601 || width === 980 || width === 1440) assert.notEqual(metrics.graphHeadDisplay, "none", `wide graph components must keep labeled tracks at ${width}px`);
    }

    await page.setViewportSize({ width: 375, height: 812 });

    const dialog = page.locator("#agent-graph-checkpoint-dialog");
    const token = page.locator("#agent-graph-checkpoint-token");
    const runId = page.locator("#agent-graph-checkpoint-run");
    const requestEditor = page.locator("#agent-graph-checkpoint-json");
    const submit = page.locator('#agent-graph-checkpoint-form button[value="default"]');
    const close = page.locator("#agent-graph-checkpoint-close");
    const openCheckpoint = async () => {
      await page.locator("#agent-graph-checkpoint").click();
      await dialog.waitFor({ state: "visible" });
    };

    await openCheckpoint();
    await runId.fill("");
    await token.fill("close-lifecycle-value");
    await close.click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await token.inputValue(), "", "Close must bypass validation and clear the token");

    await openCheckpoint();
    await token.fill("cancel-lifecycle-value");
    await page.evaluate(() => document.querySelector<HTMLDialogElement>("#agent-graph-checkpoint-dialog")!
      .dispatchEvent(new Event("cancel", { cancelable: true })));
    assert.equal(await token.inputValue(), "", "dialog cancellation must clear the token");
    await token.fill("escape-lifecycle-value");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await token.inputValue(), "", "Escape must clear the token");

    await openCheckpoint();
    await requestEditor.fill("{");
    await token.fill("serialization-failure-value");
    await submit.click();
    await page.waitForFunction(() => (document.querySelector<HTMLInputElement>("#agent-graph-checkpoint-token")?.value ?? "missing") === "");
    assert.equal(await dialog.getAttribute("open"), "", "local serialization failures must leave the dialog available for correction");
    await close.click();
    await dialog.waitFor({ state: "hidden" });

    await openCheckpoint();
    await token.fill("request-failure-value");
    const rejectedResponse = page.waitForResponse((response: any) => response.url().endsWith("/checkpoint") && response.status() === 500);
    await submit.click();
    await rejectedResponse;
    assert.equal(await token.inputValue(), "", "request failure must clear the token");
    assert.equal(await dialog.getAttribute("open"), "", "request failure must leave the dialog available for retry");
    await close.click();
    await dialog.waitFor({ state: "hidden" });

    checkpointMode = "pending";
    await openCheckpoint();
    await token.fill("success-lifecycle-value");
    const checkpointRequest = page.waitForRequest((request: any) => request.url().endsWith("/checkpoint") && request.method() === "POST");
    await submit.click();
    const serialized = await checkpointRequest;
    assert.equal(serialized.postDataJSON().capabilityToken, "success-lifecycle-value");
    assert.equal(await token.inputValue(), "", "the field must clear immediately after request serialization");
    assert.equal(await dialog.getAttribute("open"), "", "the dialog must remain open while the request is pending");
    const completedResponse = page.waitForResponse((response: any) => response.url().endsWith("/checkpoint") && response.status() === 200);
    releasePendingResponse();
    await completedResponse;
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await token.inputValue(), "", "success must leave the token cleared");
  } finally {
    releasePendingResponse();
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
  }
});
