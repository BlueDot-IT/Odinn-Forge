process.env.ODINN_GATEWAY_AUTH = "off";
process.env.ODINN_BROWSER_HEADLESS = "1";

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import {
  beginPhaseCUncertainEffect,
  createPhaseCHarness,
  humanUatExitCode,
  jsonRequest,
  launchPinnedChromium,
  PHASE_C_POST_RESTART_PROMPT,
  runHumanPhaseCUat,
  seedPhaseCRecovery,
  setPhaseCCapabilityAdmission,
  waitForJob,
  type PhaseCHarness,
  type PhaseCHarnessSetupPhase,
  type PinnedBrowser,
} from "../scripts/uat/phase-c-harness.ts";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function exactUserMessage(request: any, content: string) {
  return request.messages?.some((message: any) => message.role === "user" && message.content === content) === true;
}

async function assertPathMissing(path: string | undefined) {
  if (!path) return;
  await assert.rejects(() => access(path), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
}

async function assertPortClosed(port: number | undefined) {
  if (!port) return;
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) }));
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

async function selectAgentGraphWithReadiness(page: any, graphRunId: string) {
  const graphDetail = page.locator("#agent-graph-detail");
  const detailPath = `/agent-graphs/${encodeURIComponent(graphRunId)}`;
  const detailResponse = page.waitForResponse((response: any) => response.url().includes(detailPath)
    && response.request().method() === "GET"
    && response.ok());
  await page.keyboard.press("Enter");
  await detailResponse;
  const terminalSummary = graphDetail.locator(".agent-graph-summary .item").filter({ hasText: "Terminal reason" });
  await terminalSummary.getByText("Terminal reason", { exact: true }).waitFor({ timeout: 15_000 });
  await terminalSummary.getByText("Completed", { exact: true }).waitFor({ timeout: 15_000 });
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

test("Phase C harness rolls back every staged setup resource", async () => {
  const phases: PhaseCHarnessSetupPhase[] = ["state-dir-created", "workspace-created", "provider-listening", "gateway-listening"];
  const originalAuth = process.env.ODINN_GATEWAY_AUTH;
  const originalHeadless = process.env.ODINN_BROWSER_HEADLESS;
  process.env.ODINN_GATEWAY_AUTH = "restore-auth-after-adversarial-setup";
  process.env.ODINN_BROWSER_HEADLESS = "restore-headless-after-adversarial-setup";
  try {
    for (const injectedPhase of phases) {
      let captured: { stateDir?: string; workspaceRoot?: string; browserProfileDir?: string; providerPort?: number; gatewayPort?: number } = {};
      await assert.rejects(
        () => createPhaseCHarness({
          testHooks: {
            afterSetupPhase: async (phase, resources) => {
              if (phase !== injectedPhase) return;
              captured = resources;
              throw new Error(`injected setup failure at ${phase}`);
            },
          },
        }),
        (error: unknown) => {
          const nested = error instanceof AggregateError ? error.errors : [error];
          return nested.some((entry) => String(entry).includes(`injected setup failure at ${injectedPhase}`));
        },
      );
      await assertPathMissing(captured.stateDir);
      await assertPathMissing(captured.workspaceRoot);
      await assertPathMissing(captured.browserProfileDir);
      await assertPortClosed(captured.providerPort);
      await assertPortClosed(captured.gatewayPort);
      assert.equal(process.env.ODINN_GATEWAY_AUTH, "restore-auth-after-adversarial-setup");
      assert.equal(process.env.ODINN_BROWSER_HEADLESS, "restore-headless-after-adversarial-setup");
    }
  } finally {
    if (originalAuth === undefined) delete process.env.ODINN_GATEWAY_AUTH;
    else process.env.ODINN_GATEWAY_AUTH = originalAuth;
    if (originalHeadless === undefined) delete process.env.ODINN_BROWSER_HEADLESS;
    else process.env.ODINN_BROWSER_HEADLESS = originalHeadless;
  }
});

test("Phase C Gateway bind failure closes the partial server and remains restartable", async () => {
  const blocker = createHttpServer((_request, response) => response.end("occupied"));
  await new Promise<void>((resolveListen, rejectListen) => {
    blocker.once("error", rejectListen);
    blocker.listen(0, "127.0.0.1", () => {
      blocker.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = blocker.address();
  if (!address || typeof address === "string") throw new Error("port blocker did not bind");
  const harness = await createPhaseCHarness();
  try {
    await harness.stopGateway();
    await assert.rejects(() => harness.startGateway(address.port), /EADDRINUSE/u);
    await harness.startGateway();
    const status = await jsonRequest(harness.base, "/status");
    assert.equal(status.ok, true);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => blocker.close((error) => error ? rejectClose(error) : resolveClose()));
    await harness.close();
  }
});

test("pinned Chromium closes when post-launch validation fails", async () => {
  let closes = 0;
  const fakeBrowser = { version: () => "123.0.0", close: async () => { closes += 1; } };
  await assert.rejects(() => launchPinnedChromium({
    headless: true,
    testHooks: {
      chromium: { executablePath: () => "/controlled/chromium", launch: async () => fakeBrowser },
      pinnedChromium: { browserVersion: "123.0.0", revision: "controlled-revision" },
      access: async () => undefined,
      realpath: async () => { throw new Error("injected realpath failure"); },
    },
  }), /injected realpath failure/u);
  assert.equal(closes, 1);
});

test("human setup failure closes readline, Chromium, context, and harness", async () => {
  const closed: string[] = [];
  const page = { on: () => undefined };
  const context = {
    addInitScript: async () => undefined,
    newPage: async () => page,
    close: async () => { closed.push("context"); },
  };
  const pinned = {
    browser: {
      newContext: async () => context,
      close: async () => { closed.push("chromium"); },
    },
    executablePath: "/controlled/chromium",
    browserVersion: "123.0.0",
    playwrightVersion: "1.62.1",
    revision: "controlled-revision",
  };
  const harness = { close: async () => { closed.push("harness"); } } as unknown as PhaseCHarness;
  await assert.rejects(() => runHumanPhaseCUat({
    commitIdentity: async () => ({ commit: "a".repeat(40), tree: "b".repeat(40), dirty: false }),
    createHarness: async () => harness,
    seedRecovery: async () => ({ approvalId: "approval", checkpointId: "checkpoint", durableJobId: "job", durableJobCapabilityToken: "token", graphJobId: "graph-job", graphRunId: "graph-run" }),
    setCapabilityAdmission: async () => undefined,
    launchBrowser: async () => pinned,
    createReadline: () => ({ close: () => { closed.push("readline"); } }),
    afterReadlineCreated: async () => { throw new Error("injected failure after readline setup"); },
  }), /injected failure after readline setup/u);
  assert.deepEqual(closed, ["readline", "context", "chromium", "harness"]);
});

test("human HOLD, blocked, and unattested reports exit nonzero", () => {
  const passing = {
    pass: true,
    results: [{ result: "pass" }],
    attestations: { nonDeveloper: true, sourceBlind: true, browserOnly: true, keyboardOnlyNarrowSegment: true },
  };
  assert.equal(humanUatExitCode(passing), 0);
  assert.equal(humanUatExitCode({ ...passing, pass: false }), 1);
  assert.equal(humanUatExitCode({ ...passing, results: [{ result: "blocked" }] }), 1);
  assert.equal(humanUatExitCode({ ...passing, attestations: { ...passing.attestations, sourceBlind: false } }), 1);
});

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
    const selectedModelRequest = harness.providerRequests.find((request) => request.model === "daily-driver-b" && JSON.stringify(request.messages).includes("BEGIN UNTRUSTED LOCAL FILE"));
    assert.ok(selectedModelRequest, "the selected model and bounded attachment reached the real local provider adapter");
    assert.ok(selectedModelRequest.tools?.some((tool: any) => tool.function?.name === "browser_x2e_open"), "the real agent loop offered the bounded browser tool");

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
    await selectAgentGraphWithReadiness(first.page, seed.graphRunId);
    assert.match(await first.page.locator("#agent-graph-detail").innerText(), /Terminal reason\s+Completed/u);
    assert.match(await first.page.locator("#agent-graph-detail").innerText(), /checkpoint-reader/u);

    await first.page.setViewportSize({ width: 375, height: 812 });
    const responsive = await first.page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(responsive.document <= responsive.viewport && responsive.body <= responsive.viewport, JSON.stringify(responsive));
    const navigationToggle = first.page.getByRole("button", { name: /Open navigation/u });
    await navigationToggle.focus();
    await first.page.keyboard.press("Enter");
    assert.equal(await first.page.locator("#sidebar-toggle").getAttribute("aria-expanded"), "true");
    await navigateWithKeyboard(first.page, /^Operator/u);
    await first.page.getByRole("heading", { name: "Operator", exact: true }).waitFor();
    await first.context.close();
    await firstBrowser.browser.close();
    firstBrowser = undefined;

    const providerRequestRestartBoundary = harness.providerRequests.length;
    const uncertainEffect = await beginPhaseCUncertainEffect(harness);
    assert.equal(harness.controlledEffectRequests.length, 1, "the controlled local effect must cross its physical POST boundary before restart");
    const originalPort = harness.port;
    await harness.stopGateway();
    await uncertainEffect.approvalCompletion;
    await harness.startGateway(originalPort);
    assert.equal(await readFile(join(harness.workspaceRoot, "recovery-state.txt"), "utf8"), "interrupted-after-checkpoint\n", "startup must not replay a retained checkpoint");
    const recoveredUncertainEffect = await waitForJob(harness.base, uncertainEffect.jobId);
    assert.equal(recoveredUncertainEffect.status, "needs-review");
    assert.equal(recoveredUncertainEffect.attempts, 1);
    const uncertainReplay = await jsonRequest(harness.base, "/jobs", {
      method: "POST",
      headers: { "idempotency-key": uncertainEffect.jobId },
      body: JSON.stringify(uncertainEffect.requestBody),
    });
    assert.equal(uncertainReplay.replayed, true);
    assert.equal(uncertainReplay.job.status, "needs-review");
    assert.equal(uncertainReplay.job.attempts, 1);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    assert.equal(harness.controlledEffectRequests.length, 1, "restart and an identical idempotent submission must not dispatch the uncertain effect again");
    assert.equal(await readFile(join(harness.workspaceRoot, "controlled-effect-count.txt"), "utf8"), "1\n");
    const browserRecovery = await jsonRequest(harness.base, "/run", {
      method: "POST",
      body: JSON.stringify({ id: "phase-c-browser-recovery-evidence", tool: "browser.recovery.status", input: {} }),
    });
    assert.ok(["unknown", "executing"].includes(browserRecovery.output.recovery.status), JSON.stringify(browserRecovery));

    secondBrowser = await launchPinnedChromium({ headless: true });
    assert.equal(secondBrowser.browserVersion, requiredBrowserVersion);
    const second = await openConsole(secondBrowser, harness.base);
    attachBrowserEvidence(second.page, pageErrors, expectedDialogs, unexpectedDialogs);
    await second.page.getByText("Recovery notes verified. The durable checkpoint remains operator-controlled.").waitFor();
    await second.page.getByLabel("Model", { exact: true }).selectOption("uat:daily-driver-b");
    const restartedComposer = second.page.getByLabel("Message Ódinn Forge");
    await restartedComposer.fill(PHASE_C_POST_RESTART_PROMPT);
    await restartedComposer.press("Enter");
    await second.page.getByText("Post-restart provider and model request verified.", { exact: true }).waitFor({ timeout: 15_000 });
    const restartedToolPresentation = second.page.locator("#chat-tool-progress");
    await restartedToolPresentation.getByText("browser.open", { exact: true }).waitFor();
    assert.match(await restartedToolPresentation.innerText(), /Page opened and snapshot captured/u);
    const exactPostRestartRequests = harness.providerRequests.slice(providerRequestRestartBoundary)
      .filter((request) => request.model === "daily-driver-b"
        && exactUserMessage(request, PHASE_C_POST_RESTART_PROMPT)
        && !request.messages?.some((message: any) => message.role === "tool"));
    assert.equal(exactPostRestartRequests.length, 1, JSON.stringify(harness.providerRequests.slice(providerRequestRestartBoundary)));
    assert.ok(harness.providerRequests.slice(providerRequestRestartBoundary).some((request) => request.model === "daily-driver-b"
      && exactUserMessage(request, PHASE_C_POST_RESTART_PROMPT)
      && request.messages?.some((message: any) => message.role === "tool")), "the post-restart browser result returned to the exact selected-model request");
    const restartedChatAudit = await jsonRequest(harness.base, "/audit/query?pageSize=100");
    assert.ok(restartedChatAudit.events.some((event: any) => event.type === "task.completed" && event.tool === "browser.open"), "post-restart browser.open completed through the governed task boundary");

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
    const restartedGraphRow = second.page.getByRole("button", { name: new RegExp(escapeRegExp(seed.graphRunId), "u") });
    await restartedGraphRow.waitFor();
    await restartedGraphRow.focus();
    await selectAgentGraphWithReadiness(second.page, seed.graphRunId);
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
