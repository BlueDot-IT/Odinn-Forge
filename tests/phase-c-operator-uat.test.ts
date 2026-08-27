process.env.ODINN_GATEWAY_AUTH = "off";
process.env.ODINN_BROWSER_HEADLESS = "1";

import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayServer } from "../apps/gateway/src/server.ts";

const workspaceRoot = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const { chromium } = createRequire(import.meta.url)("../packages/kernel/node_modules/playwright-core");

function json(route: any, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function operatorSection(items: any[], counts: Record<string, number> = {}) {
  return {
    items,
    counts: { total: items.length, ...counts },
    pagination: { page: 1, pageSize: 25, pages: 1, total: items.length, from: items.length ? 1 : 0, to: items.length },
  };
}

test("a source-blind operator can complete the Phase C daily-driver and recovery walkthrough", { timeout: 60_000 }, async () => {
  const chromiumPath = process.env.ODINN_CHROMIUM_PATH || chromium.executablePath();
  await access(chromiumPath).catch((error) => assert.fail(`Pinned Chromium is required for Phase C UAT (${chromiumPath}): ${String(error)}`));

  const stateDir = await mkdtemp(join(tmpdir(), "odinn-phase-c-uat-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const now = new Date().toISOString();
  const approvals = [{
    id: "approval-uat-1",
    tool: "browser.click",
    effect: { summary: "Submit the reviewed recovery form", capability: "browser.mutate", reversible: "reversible", idempotency: "idempotent" },
  }];
  const schedules: any[] = [];
  const captured: { streamBody?: any; operatorActions: string[]; approved: string[] } = { operatorActions: [], approved: [] };
  let recovered = false;
  let browser: any;

  const recoveryItem = () => ({
    id: "workflow-uat-recovery",
    kind: "workflow",
    label: "Interrupted scheduled report",
    status: recovered ? "running" : "needs-review",
    summary: recovered ? "Resumed from the durable checkpoint" : "Restart interrupted one step; review before resuming",
    attention: !recovered,
    controls: recovered ? [] : ["resume-workflow"],
    updatedAt: now,
    details: {},
  });

  try {
    browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    page.on("dialog", (dialog: any) => dialog.accept());

    await page.route("**/*", async (route: any) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();

      if (url.pathname === "/status") {
        const response = await route.fetch();
        const status = await response.json();
        const tools = new Set([...(status.tools || []), "agent.run", "session.list", "goal.list", "memory.browse", "browser.tabs"]);
        const allowedTools = new Set([...(status.allowedTools || []), ...tools]);
        await json(route, {
          ...status,
          defaultModel: "uat:daily-driver",
          providers: [{ name: "uat", displayName: "UAT provider", configured: true, models: ["daily-driver"], supportTier: "test", authMode: "none" }],
          models: [{ id: "uat:daily-driver", provider: "uat", model: "daily-driver" }],
          tools: [...tools],
          allowedTools: [...allowedTools],
        });
        return;
      }

      if (url.pathname === "/run/stream" && method === "POST") {
        captured.streamBody = request.postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: [
            'event: progress\ndata: {"tool":"workspace.read","status":"running","message":"Reading attached recovery notes"}\n\n',
            'event: delta\ndata: {"delta":"Recovery notes verified. "}\n\n',
            'event: delta\ndata: {"delta":"No source inspection required."}\n\n',
            'event: result\ndata: {"output":{"content":"Recovery notes verified. No source inspection required.","model":"daily-driver","provider":"uat"}}\n\n',
          ].join(""),
        });
        return;
      }

      if (url.pathname === "/approvals" && method === "GET") {
        await json(route, approvals);
        return;
      }
      if (/^\/approvals\/[^/]+\/approve$/u.test(url.pathname) && method === "POST") {
        const id = decodeURIComponent(url.pathname.split("/")[2] || "");
        captured.approved.push(id);
        approvals.splice(0, approvals.length);
        await json(route, { ok: true, approvalId: id, result: { status: "completed" } });
        return;
      }
      if (url.pathname === "/run" && method === "POST") {
        const body = request.postDataJSON();
        if (body.tool === "browser.tabs") await json(route, { output: { tabs: [] } });
        else await json(route, { output: {} });
        return;
      }

      if (url.pathname === "/operator/snapshot" && method === "GET") {
        const item = recoveryItem();
        await json(route, {
          ok: true,
          schemaVersion: 1,
          generatedAt: now,
          surface: "console",
          identity: { principalId: "operator:uat" },
          health: { status: recovered ? "healthy" : "needs-attention", attention: recovered ? 0 : 1 },
          actions: ["resume-workflow"],
          sections: {
            runtime: operatorSection([{ id: "gateway", kind: "runtime", label: "Local gateway", status: "running", summary: "Ready", details: {} }]),
            work: operatorSection([]),
            approvals: operatorSection([], { pending: 0 }),
            automation: operatorSection([]),
            context: operatorSection([]),
            recovery: operatorSection(recovered ? [] : [item]),
            audit: operatorSection([{ id: "audit", kind: "audit", label: "Signed history", status: "verified", summary: "Integrity verified", details: {} }]),
            surfaces: operatorSection([]),
          },
        });
        return;
      }
      if (url.pathname === "/operator/actions" && method === "POST") {
        const body = request.postDataJSON();
        captured.operatorActions.push(body.action);
        recovered = body.action === "resume-workflow";
        await json(route, { ok: true, action: body.action, targetId: body.targetId });
        return;
      }

      if (url.pathname === "/cron" && method === "GET") {
        await json(route, { enabled: true, jobs: schedules, nextWake: schedules.length ? now : null });
        return;
      }
      if (url.pathname === "/cron" && method === "POST") {
        const body = request.postDataJSON();
        schedules.push({ id: "cron-uat-1", enabled: true, lastStatus: "active", lastRunAt: now, ...body });
        await json(route, { ok: true, job: schedules[0] }, 201);
        return;
      }

      if (url.pathname === "/memory/status") {
        await json(route, { records: 1, latestAt: now, integration: { readAllowed: true, writeAllowed: true, autoRecall: true, autoLearn: true } });
        return;
      }
      if (url.pathname === "/memory" && method === "GET") {
        await json(route, { memories: [{ id: "memory-uat-1", kind: "procedure", subject: "Recovery preference", summary: "Use the operator page first", text: "Use the operator page before raw logs.", scopeType: "global", at: now, authority: "user", source: "console" }] });
        return;
      }
      if (url.pathname === "/memory/browse") {
        await json(route, { namespaces: [{ namespace: "procedures/recovery", count: 1, tiers: { l1: 1 } }] });
        return;
      }
      if (url.pathname === "/memory/candidates") {
        await json(route, { candidates: [] });
        return;
      }

      if (url.pathname === "/usage") {
        await json(route, { summary: { totalTokens: 42, modelRuns: 1, runs: 1, errors: 0 }, days: [{ day: "2026-08-26", events: 1, tokens: 42 }], runs: [{ id: "run-uat-1", status: "completed", tool: "agent.run", createdAt: now }] });
        return;
      }
      if (url.pathname === "/audit/query") {
        await json(route, {
          events: [{ id: "event-uat-1", at: now, type: "agent.progress", runId: "run-uat-1", actor: "operator", tool: "agent.run", decision: "allow", message: "Recovery completed" }],
          pagination: { page: 1, pages: 1, total: 1, from: 1, to: 1 },
          summary: { events: 1, runs: 1, modelRuns: 1, errors: 0 },
          facets: { types: [], tools: [], actors: [], outcomes: [] },
        });
        return;
      }

      if (url.pathname === "/agent-graphs" && method === "GET") {
        await json(route, { graphs: [{ graphRunId: "graph-uat-1", parentRunId: "run-uat-1", requestDigest: "a".repeat(64), status: "needs-review", errorCode: "CHILD_OUTCOME_UNCERTAIN", maxConcurrency: 2, maxRunMs: 60_000, createdAt: now, nodes: [{ nodeId: "child-uat-1", manifestId: "research", status: "needs-review", errorCode: "CHILD_OUTCOME_UNCERTAIN" }] }] });
        return;
      }
      if (url.pathname === "/agent-graphs/graph-uat-1" && method === "GET") {
        await json(route, { graph: { graphRunId: "graph-uat-1", parentRunId: "run-uat-1", requestDigest: "a".repeat(64), status: "needs-review", errorCode: "CHILD_OUTCOME_UNCERTAIN", maxConcurrency: 2, maxRunMs: 60_000, createdAt: now, nodes: [{ nodeId: "child-uat-1", manifestId: "research", status: "needs-review", errorCode: "CHILD_OUTCOME_UNCERTAIN" }] } });
        return;
      }

      await route.continue();
    });

    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });
    await page.locator("#chat-input").waitFor({ state: "visible" });
    await page.waitForFunction(() => !(document.querySelector<HTMLTextAreaElement>("#chat-input")?.disabled ?? true));

    await page.setInputFiles("#chat-file-input", { name: "recovery-notes.md", mimeType: "text/markdown", buffer: Buffer.from("Use the Operator page and resume from the durable checkpoint.") });
    await page.locator("#chat-file-list").getByText("recovery-notes.md").waitFor();
    await page.locator("#chat-input").fill("Confirm the recovery steps");
    await page.locator("#send-chat").click();
    await page.getByText("Recovery notes verified. No source inspection required.").waitFor();
    await page.locator("#chat-file-list").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#chat-file-list").isHidden(), true, "successful sends clear local attachments");
    assert.match(JSON.stringify(captured.streamBody), /BEGIN UNTRUSTED LOCAL FILE/u);
    assert.equal(captured.streamBody?.tool, "agent.run");

    await page.locator('[data-view="capabilities"]').click();
    await page.getByText("Submit the reviewed recovery form").waitFor();
    await page.locator('[data-approval-action="approve"]').click();
    await page.getByText("Nothing is waiting").waitFor();
    assert.deepEqual(captured.approved, ["approval-uat-1"]);

    await page.locator('[data-view="cron"]').click();
    await page.locator("#new-cron").click();
    await page.locator("#cron-name").fill("Daily recovery check");
    await page.locator("#save-cron").click();
    await page.getByText("Daily recovery check").waitFor();
    assert.equal(schedules.length, 1);

    await page.locator('[data-view="memory"]').click();
    await page.locator("#memory-tab-saved").click();
    await page.getByText("Recovery preference").first().waitFor();

    await page.locator('[data-view="usage"]').click();
    await page.locator("#activity-tab-history").click();
    await page.waitForFunction(() => document.querySelector("#audit-count")?.textContent === "1");
    assert.match(await page.locator("#audit-events").innerText(), /Recovery completed|Agent progress/u);

    await page.locator('[data-view="delegation"]').click();
    await page.getByText("CHILD_OUTCOME_UNCERTAIN").first().waitFor();

    await page.locator('[data-view="operator"]').click();
    await page.getByText("Restart interrupted one step; review before resuming").first().waitFor();
    await page.locator('[data-operator-action="resume-workflow"]').first().click();
    await page.waitForFunction(() => document.querySelector("#operator-attention")?.textContent === "0");
    assert.deepEqual(captured.operatorActions, ["resume-workflow"]);

    assert.equal(await page.locator("#model-select").inputValue(), "uat:daily-driver");
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
  }
});
