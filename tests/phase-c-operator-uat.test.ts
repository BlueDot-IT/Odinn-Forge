process.env.ODINN_GATEWAY_AUTH = "off";
process.env.ODINN_BROWSER_HEADLESS = "1";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createPhaseCHarness,
  jsonRequest,
  launchPinnedChromium,
  seedPhaseCRecovery,
  setPhaseCCapabilityAdmission,
  type PhaseCHarness,
  type PinnedBrowser,
} from "../scripts/uat/phase-c-harness.ts";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function attachBrowserEvidence(page: any, pageErrors: string[], expectedDialogs: string[], unexpectedDialogs: string[]) {
  page.on("pageerror", (error: Error) => pageErrors.push(error.message));
  page.on("dialog", async (dialog: any) => {
    const evidence = `${dialog.type()}: ${dialog.message()}`;
    if (dialog.type() === "confirm" && dialog.message().includes("Restore files")) {
      expectedDialogs.push(evidence);
      await dialog.accept();
      return;
    }
    unexpectedDialogs.push(evidence);
    await dialog.dismiss();
  });
}

async function openConsole(pinned: PinnedBrowser, base: string, viewport = { width: 1280, height: 900 }) {
  const context = await pinned.browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Message Ódinn Forge").waitFor({ state: "visible" });
  await page.waitForFunction(() => !(document.querySelector<HTMLTextAreaElement>('[aria-label="Message Ódinn Forge"]')?.disabled ?? true));
  return { context, page };
}

async function navigateWithKeyboard(page: any, name: string | RegExp) {
  const button = page.getByRole("button", { name }).first();
  await button.focus();
  assert.equal(await button.evaluate((element: Element) => element === document.activeElement), true);
  await page.keyboard.press("Enter");
}

async function openAdvancedNavigation(page: any) {
  const advanced = page.locator("details.nav-labs");
  if (!await advanced.evaluate((element: HTMLDetailsElement) => element.open)) {
    const summary = advanced.locator("summary");
    await summary.focus();
    assert.equal(await summary.evaluate((element: Element) => element === document.activeElement), true);
    await page.keyboard.press("Enter");
  }
  assert.equal(await advanced.evaluate((element: HTMLDetailsElement) => element.open), true);
}

test("a source-blind operator completes Phase C against durable state across a real Gateway restart", { timeout: 180_000 }, async () => {
  let harness: PhaseCHarness | undefined;
  let firstBrowser: PinnedBrowser | undefined;
  let secondBrowser: PinnedBrowser | undefined;
  let requiredBrowserVersion = "";
  const pageErrors: string[] = [];
  const expectedDialogs: string[] = [];
  const unexpectedDialogs: string[] = [];
  try {
    harness = await createPhaseCHarness();
    const seed = await seedPhaseCRecovery(harness);
    await setPhaseCCapabilityAdmission(harness, false);
    firstBrowser = await launchPinnedChromium({ headless: true });
    requiredBrowserVersion = firstBrowser.browserVersion;
    assert.equal(firstBrowser.playwrightVersion, "1.62.1");
    const first = await openConsole(firstBrowser, harness.base);
    attachBrowserEvidence(first.page, pageErrors, expectedDialogs, unexpectedDialogs);

    await first.page.getByLabel("Model", { exact: true }).selectOption("uat:daily-driver-b");
    assert.equal(await first.page.getByLabel("Model", { exact: true }).inputValue(), "uat:daily-driver-b");
    await first.page.evaluate(() => {
      const status = document.querySelector('[role="status"].chat-status');
      const values: string[] = [];
      const record = () => {
        const value = status?.textContent?.trim();
        if (value && values.at(-1) !== value) values.push(value);
      };
      record();
      new MutationObserver(record).observe(status!, { childList: true, subtree: true, characterData: true });
      (window as any).__phaseCProgress = values;
    });
    await first.page.locator('input[type="file"][accept*="text"]').setInputFiles({
      name: "recovery-notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("Use the retained checkpoint and require an explicit operator restore."),
    });
    const composer = first.page.getByLabel("Message Ódinn Forge");
    await composer.fill("Confirm the Phase C recovery steps");
    await composer.press("Enter");
    await first.page.getByText("Recovery notes verified. The durable checkpoint remains operator-controlled.").waitFor({ timeout: 15_000 }).catch(async (error: unknown) => {
      const audit = await jsonRequest(harness!.base, "/audit/query?pageSize=100").catch((auditError: unknown) => ({ error: String(auditError) }));
      assert.fail(JSON.stringify({
        error: String(error),
        status: await first.page.locator('[role="status"].chat-status').textContent(),
        toast: await first.page.locator("#toast-region").textContent(),
        output: await first.page.locator("#output").textContent(),
        pageErrors,
        providerRequests: harness?.providerRequests.map((request) => ({
          model: request.model,
          roles: request.messages?.map((message: any) => message.role),
          tools: request.tools?.map((tool: any) => tool.function?.name),
        })),
        failures: audit.events?.filter((event: any) => event.type === "task.failed").map((event: any) => ({
          runId: event.runId,
          tool: event.tool,
          message: event.message,
        })),
      }));
    });
    await first.page.getByText("recovery-notes.md", { exact: true }).waitFor({ state: "hidden" });
    const progress = await first.page.evaluate(() => (window as any).__phaseCProgress as string[]);
    assert.ok(progress.some((value) => /Drafting the answer/u.test(value)), JSON.stringify(progress));
    const toolPresentation = first.page.locator("#chat-tool-progress");
    await toolPresentation.getByText("browser.open", { exact: true }).waitFor();
    assert.match(await toolPresentation.innerText(), /Page opened and snapshot captured/u);
    const selectedModelRequest = harness.providerRequests.find((request) => request.model === "daily-driver-b" && JSON.stringify(request.messages).includes("BEGIN UNTRUSTED LOCAL FILE"));
    assert.ok(selectedModelRequest, "the selected model and bounded attachment reached the real local provider adapter");
    assert.ok(selectedModelRequest.tools?.some((tool: any) => tool.function?.name === "browser_x2e_open"), "the real agent loop offered the bounded browser tool");
    assert.ok(harness.providerRequests.some((request) => request.model === "daily-driver-b" && request.messages?.some((message: any) => message.role === "tool")), "the real browser result returned to the selected model");
    const chatAudit = await jsonRequest(harness.base, "/audit/query?pageSize=100");
    assert.ok(chatAudit.events.some((event: any) => event.type === "task.completed" && event.tool === "browser.open"), "browser.open completed through the governed task boundary");

    await navigateWithKeyboard(first.page, /^Schedules$/u);
    await first.page.getByRole("heading", { name: "Schedules", exact: true }).waitFor();
    await first.page.getByRole("button", { name: "New schedule" }).click();
    await first.page.getByLabel("Name", { exact: true }).fill("Daily recovery check");
    await first.page.getByLabel("Action", { exact: true }).selectOption("text.echo");
    await first.page.getByText("Advanced action input").click();
    await first.page.getByLabel("Structured input").fill('{"text":"scheduled recovery evidence"}');
    await first.page.getByRole("button", { name: "Save schedule" }).click();
    await first.page.getByText("Daily recovery check").waitFor();
    const firstCron = await jsonRequest(harness.base, "/cron");
    assert.equal(firstCron.jobs.length, 1);
    assert.equal(firstCron.jobs[0].name, "Daily recovery check");

    await navigateWithKeyboard(first.page, /^Memory$/u);
    await first.page.getByRole("button", { name: "Add memory" }).click();
    await first.page.getByLabel("Short title").fill("Recovery preference");
    await first.page.getByLabel("What should Ódinn remember?").fill("Use the Operator and Activity pages before raw logs.");
    await first.page.getByRole("button", { name: "Save memory" }).click();
    await first.page.getByText("Recovery preference").first().waitFor();

    await navigateWithKeyboard(first.page, /^Web tools$/u);
    await first.page.getByRole("button", { name: "Deny" }).waitFor();
    assert.match(await first.page.getByText(/Click/u).first().innerText(), /Click/u);

    await navigateWithKeyboard(first.page, /^Activity$/u);
    await first.page.getByRole("tab", { name: "History" }).click();
    const unfilteredEvents = await first.page.locator(".activity-event").count();
    assert.ok(unfilteredEvents > 1);
    await first.page.getByLabel("Search activity").fill("text.echo");
    await first.page.waitForResponse((response: any) => response.url().includes("/audit/query?") && response.url().includes("q=text.echo"));
    await first.page.waitForFunction(() => document.querySelector("#audit-showing")?.textContent?.includes("matching"));
    const filteredEvents = first.page.locator(".activity-event");
    assert.ok(await filteredEvents.count() > 0);
    for (const text of await filteredEvents.allInnerTexts()) assert.match(text, /text echo/iu);

    await navigateWithKeyboard(first.page, /^Delegation\b/u);
    const graphRow = first.page.getByRole("button", { name: new RegExp(escapeRegExp(seed.graphRunId), "u") });
    await graphRow.waitFor();
    await graphRow.focus();
    await first.page.keyboard.press("Enter");
    await first.page.getByText("Terminal reason").waitFor();
    assert.match(await first.page.locator("#agent-graph-detail").innerText(), /Terminal reason\s+Completed/u);
    assert.match(await first.page.locator("#agent-graph-detail").innerText(), /checkpoint-reader/u);

    await first.page.setViewportSize({ width: 375, height: 812 });
    const responsive = await first.page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(responsive.document <= responsive.viewport, JSON.stringify(responsive));
    const navigationToggle = first.page.getByRole("button", { name: /Open navigation/u });
    await navigationToggle.focus();
    await first.page.keyboard.press("Enter");
    assert.equal(await first.page.locator("#sidebar-toggle").getAttribute("aria-expanded"), "true");
    await navigateWithKeyboard(first.page, /^Operator/u);
    await first.page.getByRole("heading", { name: "Operator", exact: true }).waitFor();
    await first.context.close();
    await firstBrowser.browser.close();
    firstBrowser = undefined;

    const originalPort = harness.port;
    await harness.stopGateway();
    await harness.startGateway(originalPort);
    assert.equal(await readFile(join(harness.workspaceRoot, "recovery-state.txt"), "utf8"), "interrupted-after-checkpoint\n", "startup must not replay a retained checkpoint");

    secondBrowser = await launchPinnedChromium({ headless: true });
    assert.equal(secondBrowser.browserVersion, requiredBrowserVersion);
    const second = await openConsole(secondBrowser, harness.base);
    attachBrowserEvidence(second.page, pageErrors, expectedDialogs, unexpectedDialogs);
    await second.page.getByText("Recovery notes verified. The durable checkpoint remains operator-controlled.").waitFor();

    await navigateWithKeyboard(second.page, /^Schedules$/u);
    await second.page.getByText("Daily recovery check").waitFor();
    const restartedCron = await jsonRequest(harness.base, "/cron");
    assert.equal(restartedCron.jobs.length, 1);

    await navigateWithKeyboard(second.page, /^Memory$/u);
    await second.page.getByRole("tab", { name: /Saved memories/u }).click();
    await second.page.getByText("Recovery preference").first().waitFor();

    await navigateWithKeyboard(second.page, /^Web tools$/u);
    const deny = second.page.getByRole("button", { name: "Deny" });
    await deny.focus();
    assert.equal(await deny.evaluate((element: Element) => element === document.activeElement), true);
    await second.page.keyboard.press("Enter");
    await second.page.locator('[role="status"]').filter({ hasText: "Action completed." }).waitFor();
    await second.page.getByText("Nothing is waiting").waitFor();
    assert.deepEqual(await jsonRequest(harness.base, "/approvals"), []);
    await jsonRequest(harness.base, `/approvals/${encodeURIComponent(seed.approvalId)}/approve`, { method: "POST" }, 404);

    const recoveredJob = await jsonRequest(harness.base, `/jobs/${encodeURIComponent(seed.durableJobId)}`);
    assert.equal(recoveredJob.status, "completed");
    assert.equal(recoveredJob.result.output.text, "PHASE_C_DURABLE_JOB_RESULT");
    const replay = await jsonRequest(harness.base, "/jobs", {
      method: "POST",
      headers: { "idempotency-key": seed.durableJobId },
      body: JSON.stringify({ task: { tool: "text.echo", input: { text: "PHASE_C_DURABLE_JOB_RESULT", capabilityToken: seed.durableJobCapabilityToken } } }),
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.job.attempts, recoveredJob.attempts);

    const beforeRestore = await readFile(join(harness.workspaceRoot, "recovery-state.txt"), "utf8");
    await openAdvancedNavigation(second.page);
    await navigateWithKeyboard(second.page, /^Restore Points$/u);
    const restoreView = second.page.locator("#view-lab-restore-points");
    await restoreView.getByRole("heading", { name: "Restore Points", exact: true }).waitFor();
    await restoreView.getByRole("button", { name: /Preview a restore/u }).click();
    await restoreView.getByRole("textbox", { name: "Restore point reference" }).fill(seed.checkpointId);
    await restoreView.getByRole("button", { name: "Preview a restore", exact: true }).last().click();
    const previewResult = restoreView.locator('[data-role="result"]');
    await previewResult.getByText("Preview a restore complete", { exact: true }).waitFor();
    assert.match(await previewResult.innerText(), /Files changed\s+No/iu);
    assert.equal(await readFile(join(harness.workspaceRoot, "recovery-state.txt"), "utf8"), beforeRestore, "preview must not mutate recovery state");
    await restoreView.getByRole("button", { name: /Restore files/u }).first().click();
    await restoreView.getByRole("textbox", { name: "Restore point reference" }).fill(seed.checkpointId);
    await restoreView.getByRole("button", { name: "Restore files", exact: true }).last().click();
    const appliedResult = restoreView.locator('[data-role="result"]');
    await appliedResult.getByText("Restore files complete", { exact: true }).waitFor();
    assert.match(await appliedResult.innerText(), /Files changed\s+Yes/iu);
    assert.equal(await readFile(join(harness.workspaceRoot, "recovery-state.txt"), "utf8"), "checkpoint-before-interruption\n");
    assert.equal(expectedDialogs.length, 1, JSON.stringify(expectedDialogs));

    await navigateWithKeyboard(second.page, /^Delegation\b/u);
    await second.page.getByRole("button", { name: new RegExp(escapeRegExp(seed.graphRunId), "u") }).waitFor();
    assert.match(await second.page.locator("#agent-graph-detail").innerText(), /Terminal reason\s+Completed/u);
    const auditIntegrity = await jsonRequest(harness.base, "/audit/verify");
    assert.equal(auditIntegrity.valid, true);
    assert.ok(Number.isSafeInteger(auditIntegrity.events) && auditIntegrity.events > 0);
    assert.equal(auditIntegrity.unsigned, 0);
    assert.deepEqual(auditIntegrity.failures, []);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(unexpectedDialogs, []);
  } finally {
    await firstBrowser?.browser.close().catch(() => undefined);
    await secondBrowser?.browser.close().catch(() => undefined);
    await harness?.close();
  }
});
