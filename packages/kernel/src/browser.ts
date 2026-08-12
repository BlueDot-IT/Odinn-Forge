import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import type { ApprovalStore } from "./approvals.ts";
import { assertPublicWebUrl, browserSecurityFingerprint, dnsLookupAll, pinnedAddressLookup, validateBrowserNetworkUrl, WEB_TIMEOUT_MS } from "./web.ts";

type NodeError = Error & { code?: string };

const browserManagers = new Map<string, BrowserManager>();

async function getBrowserManager(stateDir: any): Promise<BrowserManager> {
  const key = resolve(stateDir);
  const existing = browserManagers.get(key);
  if (existing) return existing;
  const manager = new BrowserManager(key);
  browserManagers.set(key, manager);
  return manager;
}

class BrowserNetworkProxy {
  [key: string]: any;
  constructor(security: any) {
    this.security = security ?? {};
    this.server = null;
    this.sockets = new Set();
  }

  async start() {
    if (this.server?.listening) return;
    this.server = createHttpServer((request, response) => void this.forwardHttp(request, response));
    this.server.on("connect", (request: any, socket: any, head: Buffer) => void this.forwardTunnel(request, socket, head));
    this.server.on("connection", (socket: any) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      socket.on("error", () => socket.destroy());
    });
    await new Promise((resolveReady, rejectReady) => {
      this.server.once("error", rejectReady);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", rejectReady);
        resolveReady(undefined);
      });
    });
  }

  url() {
    const address = this.server?.address();
    if (!address || typeof address === "string") throw new Error("browser network proxy is not listening");
    return `http://127.0.0.1:${address.port}`;
  }

  async forwardHttp(request: any, response: any) {
    try {
      const { parsed, address } = await validateBrowserNetworkUrl(request.url, this.security);
      const transport = parsed.protocol === "https:" ? httpsRequest : httpRequest;
      const headers = { ...request.headers, host: parsed.host };
      delete headers["proxy-connection"];
      const upstream = transport({
        protocol: parsed.protocol,
        hostname: address,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        method: request.method,
        path: `${parsed.pathname}${parsed.search}`,
        headers,
        servername: parsed.hostname,
        lookup: pinnedAddressLookup(address)
      }, (upstreamResponse: any) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      const deadline = setTimeout(() => upstream.destroy(new Error("browser proxy request timed out")), WEB_TIMEOUT_MS);
      upstream.once("close", () => clearTimeout(deadline));
      upstream.once("error", (error: Error) => {
        if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
        response.end("browser proxy request failed");
      });
      request.pipe(upstream);
    } catch {
      response.writeHead(403, { "content-type": "text/plain", connection: "close" });
      response.end("browser proxy rejected request");
    }
  }

  async forwardTunnel(request: any, client: any, head: Buffer) {
    let upstream: any;
    try {
      const authority = new URL(`http://${request.url}`);
      const port = Number(authority.port || 443);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("browser proxy blocked invalid CONNECT port");
      const { address } = await validateBrowserNetworkUrl(`https://${authority.hostname}:${port}/`, this.security);
      upstream = netConnect({ host: address, port, family: isIP(address) });
      this.sockets.add(upstream);
      upstream.once("close", () => this.sockets.delete(upstream));
      const deadline = setTimeout(() => upstream.destroy(new Error("browser proxy CONNECT timed out")), WEB_TIMEOUT_MS);
      await new Promise((resolveConnected, rejectConnected) => {
        upstream.once("connect", resolveConnected);
        upstream.once("error", rejectConnected);
      });
      clearTimeout(deadline);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      upstream.pipe(client);
      client.pipe(upstream);
    } catch (error) {
      upstream?.destroy();
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server?.listening) await new Promise((resolveClosed) => server.close(() => resolveClosed(undefined)));
  }
}

async function resolveChromiumExecutable() {
  const configured = process.env.ODINN_CHROMIUM_PATH;
  const candidates = [
    configured,
    process.platform === "win32" ? join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe") : undefined,
    process.platform === "win32" ? join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
    process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined,
    process.platform === "darwin" ? "/Applications/Chromium.app/Contents/MacOS/Chromium" : undefined,
    process.platform === "linux" ? "/usr/bin/chromium" : undefined,
    process.platform === "linux" ? "/usr/bin/chromium-browser" : undefined,
    process.platform === "linux" ? "/usr/bin/google-chrome" : undefined,
    process.platform === "linux" ? join(homedir(), ".cache", "ms-playwright", "chromium", "chrome-linux", "chrome") : undefined
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next platform-native browser location.
    }
  }
  throw new Error(`Chromium was not found for ${process.platform}; install Chromium or set ODINN_CHROMIUM_PATH`);
}

class BrowserManager {
  [key: string]: any;
  constructor(stateDir: any) {
    this.stateDir = stateDir;
    this.context = null;
    this.proxy = null;
    this.securityFingerprint = "";
    this.ids = new WeakMap();
    this.handles = new Map();
    this.handlesPath = join(stateDir, "browser-tabs.json");
    this.handlesLoaded = false;
    this.recoveryPath = join(stateDir, "browser-recovery.json");
  }

  async start(security: any = {}) {
    const fingerprint = browserSecurityFingerprint(security);
    if (this.context && !this.context.isClosed() && this.securityFingerprint === fingerprint) return this.context;
    if (this.context || this.proxy) await this.close();
    this.context = null;
    if (!this.handlesLoaded) {
      try {
        const saved = JSON.parse(await readFile(this.handlesPath, "utf8"));
        if (saved?.schemaVersion === 1 && saved.handles && typeof saved.handles === "object") this.handles = new Map(Object.entries(saved.handles));
      } catch (error) { if ((error as NodeError | undefined)?.code !== "ENOENT") this.handles.clear(); }
      this.handlesLoaded = true;
    }
    const userDataDir = join(this.stateDir, "browser-profile");
    await mkdir(userDataDir, { recursive: true });
    const executablePath = await resolveChromiumExecutable();
    const headedRequested = process.env.ODINN_BROWSER_HEADLESS !== "1";
    const displayAvailable = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    this.proxy = new BrowserNetworkProxy(security);
    await this.proxy.start();
    this.context = await chromium.launchPersistentContext(userDataDir, {
      headless: !headedRequested || !displayAvailable,
      executablePath,
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
      proxy: { server: this.proxy.url() },
      args: ["--no-first-run", "--no-default-browser-check"]
    });
    this.securityFingerprint = fingerprint;
    await this.context.route("**/*", async (route: any) => {
      try {
        await validateBrowserNetworkUrl(route.request().url(), security);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    if (typeof this.context.routeWebSocket === "function") {
      await this.context.routeWebSocket("**/*", async (socket: any) => {
        try {
          await validateBrowserNetworkUrl(socket.url(), security);
          socket.connectToServer();
        } catch {
          socket.close({ code: 1008, reason: "blocked by browser network policy" });
        }
      });
    }
    return this.context;
  }

  async close() {
    const context = this.context;
    this.context = null;
    if (context) await context.close().catch(() => undefined);
    const proxy = this.proxy;
    this.proxy = null;
    this.securityFingerprint = "";
    if (proxy) await proxy.close().catch(() => undefined);
  }

  async page(tabId: any, security: any = {}) {
    let context = await this.start(security);
    let pages;
    try { pages = context.pages(); } catch { await this.close(); context = await this.start(security); pages = context.pages(); }
    if (!pages.length) pages = [await context.newPage()];
    if (tabId) {
      const selected = pages.find((page: any) => this.tabId(page) === tabId);
      if (!selected) {
        const handle = this.handles.get(tabId);
        if (!handle?.url || isPrivateBrowserUrl(handle.url)) throw new Error(`browser tab not found or cannot be safely rehydrated: ${tabId}`);
        const recovered = await context.newPage();
        try { await recovered.goto(handle.url, { waitUntil: "domcontentloaded", timeout: WEB_TIMEOUT_MS }); }
        catch (error) { await recovered.close().catch(() => undefined); throw new Error(`browser tab recovery failed: ${error instanceof Error ? error.message : String(error)}`); }
        this.ids.set(recovered, tabId);
        return recovered;
      }
      return selected;
    }
    return pages[0];
  }

  tabId(page: any) {
    if (!this.ids.has(page)) this.ids.set(page, `tab_${randomUUID().slice(0, 8)}`);
    return this.ids.get(page);
  }

  async describe(page: any) {
    const id = this.tabId(page);
    const description = {
      id,
      url: page.url(),
      title: await page.title().catch(() => "")
    };
    if (description.url && description.url !== "about:blank") {
      this.handles.set(id, { url: description.url, title: description.title, updatedAt: new Date().toISOString() });
      await ensureBrowserHandles(this.handlesPath, this.handles);
    }
    return description;
  }

  async recovery() {
    try {
      const value = JSON.parse(await readFile(this.recoveryPath, "utf8"));
      if (value?.schemaVersion !== 1) throw new Error("invalid browser recovery journal");
      if (value.status === "executing") value.status = "unknown";
      return value;
    } catch (error) {
      if ((error as NodeError | undefined)?.code === "ENOENT") return { schemaVersion: 1, status: "clear" };
      throw error;
    }
  }

  async writeRecovery(value: any) {
    await mkdir(dirname(this.recoveryPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.recoveryPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, ...value }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.recoveryPath);
    await chmod(this.recoveryPath, 0o600);
  }
}

function isPrivateBrowserUrl(value: any) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host.endsWith(".local") || host === "::1" || host === "127.0.0.1" || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\./.test(host);
  } catch { return true; }
}

async function ensureBrowserHandles(path: any, handles: any) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, handles: Object.fromEntries(handles) }, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function browserTabs(stateDir: any, security: any = {}) {
  const manager = await getBrowserManager(stateDir);
  const context = await manager.start(security);
  return { tabs: await Promise.all(context.pages().map((page: any) => manager.describe(page))) };
}

export async function browserOpen(stateDir: any, input: any = {}, security: any = {}, resolveNetworkAddresses: any = dnsLookupAll) {
  const url = cleanRequired(input.url, "browser.open requires url");
  if (!/^https?:\/\//i.test(url)) throw new Error("browser.open requires an http(s) url");
  await validateBrowserNetworkUrl(url, security, resolveNetworkAddresses);
  const manager = await getBrowserManager(stateDir);
  const page = await manager.page(input.tabId, security);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: WEB_TIMEOUT_MS });
  assertBrowserPageAllowed(page, security);
  return { ...(await manager.describe(page)), ...(await browserPageSnapshot(page)) };
}

export async function browserSnapshot(stateDir: any, input: any = {}, security: any = {}) {
  const manager = await getBrowserManager(stateDir);
  const page = await manager.page(input.tabId, security);
  assertBrowserPageAllowed(page, security);
  return { ...(await manager.describe(page)), ...(await browserPageSnapshot(page)) };
}

function assertBrowserPageAllowed(page: any, security: any = {}) {
  const url = page.url();
  if (!url || url === "about:blank" || url.startsWith("chrome://")) return;
  assertPublicWebUrl(url, security);
}

async function browserPageSnapshot(page: any) {
  const text = (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 24_000);
  const links = await page.locator("a").evaluateAll((items: any) => items.slice(0, 80).map((item: any) => ({ text: item.textContent?.trim().slice(0, 160), href: item.href }))).catch(() => []);
  const title = await page.title().catch(() => "");
  const url = page.url();
  const snapshotId = createHash("sha256").update(JSON.stringify({ url, title, text, links })).digest("hex").slice(0, 24);
  return { snapshotId, text, links };
}

export async function browserAction(stateDir: any, approvalStore: ApprovalStore, tool: any, input: any = {}, security: any = {}, execution: any = {}) {
  const normalizedInput = { ...input };
  delete normalizedInput.confirmed;
  delete normalizedInput.approvalId;
  if (security.requireApproval !== false && !execution?.approvalId) {
    const approvalId = approvalStore.create({
      type: "approval.required",
      tool,
      runId: execution?.runId,
      actor: execution?.actor,
      summary: browserActionSummary(tool, input),
      expectedUrl: input.expectedUrl,
      snapshotId: input.snapshotId,
      input: normalizedInput,
      executionInput: normalizedInput
    });
    return { type: "approval.required", approvalId, tool, summary: browserActionSummary(tool, input), expiresInSeconds: 300 };
  }
  if (security.requireApproval !== false) {
    const approved = approvalStore.consume(execution.approvalId, {
      tool,
      runId: execution.runId,
      actor: execution.actor,
      input: normalizedInput
    });
    if (!approved) {
      throw new Error("browser action approval is missing, expired, already used, or does not match this action");
    }
    input = approved.input ?? normalizedInput;
  } else {
    input = normalizedInput;
  }
  const manager = await getBrowserManager(stateDir);
  const unresolved = await manager.recovery();
  if (["executing", "unknown"].includes(unresolved.status)) {
    const error = new Error(`browser mutation ${unresolved.id} has an uncertain outcome; inspect the current page and resolve recovery before another mutation`) as NodeError;
    error.code = "BROWSER_RECOVERY_REQUIRED";
    throw error;
  }
  const page = await manager.page(input.tabId, security);
  assertBrowserPageAllowed(page, security);
  const before = await browserPageSnapshot(page);
  if (input.expectedUrl && input.expectedUrl !== page.url()) {
    throw new Error("browser page URL changed while approval was pending; refusing a stale action");
  }
  if (input.snapshotId && input.snapshotId !== before.snapshotId) {
    throw new Error("browser page changed since the action was requested; take a fresh snapshot and retry");
  }
  const locator = input.selector
    ? page.locator(input.selector).first()
    : input.role && input.name
      ? page.getByRole(input.role, { name: input.name }).first()
      : input.text
        ? page.getByText(input.text, { exact: input.exact === true }).first()
        : null;
  const transaction = {
    id: `browser_tx_${randomUUID()}`,
    status: "executing",
    tool,
    tabId: manager.tabId(page),
    expectedUrl: page.url(),
    beforeSnapshotId: before.snapshotId,
    startedAt: new Date().toISOString(),
    input: redactBrowserInput(input)
  };
  await manager.writeRecovery(transaction);
  try {
    if (tool === "browser.press") {
      await page.keyboard.press(cleanRequired(input.key, "browser.press requires key"));
    } else {
      if (!locator) throw new Error(`${tool} requires selector, role/name, or text`);
      const configuredTimeout = Number.parseInt(String(input.timeoutMs ?? process.env.ODINN_BROWSER_ACTION_TIMEOUT_MS ?? "10000"), 10);
      const timeout = Number.isFinite(configuredTimeout) ? Math.max(100, Math.min(30_000, configuredTimeout)) : 10_000;
      if (tool === "browser.click") await locator.click({ timeout });
      else await locator.fill(String(input.value ?? ""), { timeout });
    }
  } catch (error) {
    const failure = (error instanceof Error ? error : new Error(String(error))) as NodeError;
    await manager.writeRecovery({ ...transaction, status: "unknown", failedAt: new Date().toISOString(), error: failure.message });
    failure.code = failure.code || "BROWSER_ACTION_OUTCOME_UNKNOWN";
    failure.message = `${failure.message}; browser mutation outcome is unknown, refresh the page and review before retrying`;
    throw failure;
  }
  await page.waitForTimeout(250);
  assertBrowserPageAllowed(page, security);
  const after = await browserPageSnapshot(page);
  await manager.writeRecovery({ ...transaction, status: "completed", completedAt: new Date().toISOString(), afterUrl: page.url(), afterSnapshotId: after.snapshotId });
  return { type: "browser.action.completed", transactionId: transaction.id, tool, ...(await manager.describe(page)), ...after };
}

export async function browserRecoveryStatus(stateDir: any) {
  const manager = await getBrowserManager(stateDir);
  return { type: "browser.recovery.status", recovery: await manager.recovery() };
}

export async function browserRecoveryResolve(stateDir: any, input: any = {}) {
  const manager = await getBrowserManager(stateDir);
  const current = await manager.recovery();
  if (!["executing", "unknown"].includes(current.status)) throw new Error("no uncertain browser mutation requires resolution");
  const outcome = cleanRequired(input.outcome, "browser.recovery.resolve requires outcome");
  if (!["completed", "not-applied", "manual-recovery"].includes(outcome)) throw new Error("browser recovery outcome must be completed, not-applied, or manual-recovery");
  const resolved = { ...current, status: "resolved", outcome, note: cleanString(input.note, ""), resolvedAt: new Date().toISOString() };
  await manager.writeRecovery(resolved);
  return { type: "browser.recovery.resolved", recovery: resolved };
}

function browserActionSummary(tool: any, input: any) {
  if (tool === "browser.click") return `Click ${input.text || input.name || input.selector || "the selected control"}`;
  if (tool === "browser.type") return `Fill ${input.selector || input.name || "the selected field"} with [redacted value]`;
  return `Press ${input.key || "the requested key"}`;
}

function redactBrowserInput(input: any = {}) {
  return "value" in input ? { ...input, value: "[redacted]", sensitive: true } : { ...input };
}

export async function closeBrowserManagers() {
  const managers = Array.from(browserManagers.values());
  browserManagers.clear();
  await Promise.allSettled(managers.map((manager) => manager.close()));
}

function cleanRequired(value: unknown, message: string) {
  const cleaned = String(value ?? "").trim();
  if (!cleaned) throw new Error(message);
  return cleaned;
}

function cleanString(value: unknown, fallback: string) {
  const cleaned = String(value ?? "").trim();
  return cleaned || fallback;
}
