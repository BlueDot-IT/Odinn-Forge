import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isAllowedCredentialEnvironmentKey } from "./environment.ts";
import { dnsLookupAll, isPrivateAddress, pinnedAddressLookup } from "./web.ts";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_HOST = "api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_DEFAULT_TOKEN_ENV = "ODINN_GITHUB_TOKEN";
const GITHUB_TIMEOUT_MS = 15_000;
const GITHUB_MAX_RESPONSE_BYTES = 1_048_576;
const GITHUB_MAX_CONCURRENT_REQUESTS = 4;
const GITHUB_MAX_REPOSITORIES = 64;
const GITHUB_MAX_CHECKS = 100;
const GITHUB_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/u;
const GITHUB_COMMIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const GITHUB_ALLOWED_CONFIG_FIELDS = new Set(["enabled", "tokenEnv", "repositories"]);

let activeGitHubRequests = 0;
type GitHubRequestWaiter = {
  active: boolean;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
  readonly resolve: () => void;
};
const githubRequestWaiters: GitHubRequestWaiter[] = [];

export type GitHubReadConfig = Readonly<{
  enabled: boolean;
  tokenEnv: string;
  repositories: readonly string[];
}>;

export type GitHubReadDiagnostic = Readonly<{
  enabled: boolean;
  configured: boolean;
  repositoryCount: number;
  endpoint: "api.github.com";
  readOnly: true;
  mutationsAvailable: false;
  redirectsAllowed: false;
}>;

export type GitHubReadTarget = Readonly<{
  endpoint: "api.github.com";
  generation: string;
}>;

export type GitHubHttpRequest = Readonly<{
  url: URL;
  address: string;
  headers: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}>;

export type GitHubHttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Buffer;
}>;

export type GitHubHttpTransport = (request: GitHubHttpRequest) => Promise<GitHubHttpResponse>;

export interface GitHubReadClient {
  readonly target: GitHubReadTarget;
  readonly diagnostic: GitHubReadDiagnostic;
  resourceFor(kind: "repository" | "issue" | "pull-request" | "checks", input: Record<string, unknown>): Readonly<Record<string, string>>;
  repository(input: Record<string, unknown>, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
  issue(input: Record<string, unknown>, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
  pullRequest(input: Record<string, unknown>, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
  checks(input: Record<string, unknown>, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
}

type ClientOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  resolveNetworkAddresses?: (hostname: string) => Promise<string[]>;
  transport?: GitHubHttpTransport;
  __testOnlyRequestTimeoutMs?: number;
}>;

function ordinaryObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be an ordinary object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
}

export function normalizeGitHubReadConfig(value: unknown = {}): GitHubReadConfig {
  const source = ordinaryObject(value, "GitHub read configuration");
  rejectUnknownFields(source, GITHUB_ALLOWED_CONFIG_FIELDS, "GitHub read configuration");
  if (source.enabled !== undefined && typeof source.enabled !== "boolean") throw new Error("GitHub read configuration.enabled must be boolean");
  const enabled = source.enabled === true;
  if (source.tokenEnv !== undefined && typeof source.tokenEnv !== "string") {
    throw new Error("GitHub read configuration.tokenEnv must be an allowed credential environment reference");
  }
  const tokenEnv = source.tokenEnv ?? GITHUB_DEFAULT_TOKEN_ENV;
  if (!isAllowedCredentialEnvironmentKey(tokenEnv)) {
    throw new Error("GitHub read configuration.tokenEnv must be an allowed credential environment reference");
  }
  if (source.repositories !== undefined && !Array.isArray(source.repositories)) {
    throw new Error("GitHub read configuration.repositories must be an array");
  }
  const repositories = (source.repositories ?? []).map((repository, index) => normalizeRepository(repository, `GitHub read configuration.repositories[${index}]`));
  if (repositories.length > GITHUB_MAX_REPOSITORIES) throw new Error(`GitHub read configuration.repositories must contain at most ${GITHUB_MAX_REPOSITORIES} entries`);
  const canonical = repositories.map((repository) => repository.toLowerCase());
  if (new Set(canonical).size !== canonical.length) throw new Error("GitHub read configuration.repositories must not contain duplicates");
  if (enabled && repositories.length === 0) throw new Error("enabled GitHub read access requires at least one explicitly allowed repository");
  return Object.freeze({ enabled, tokenEnv, repositories: Object.freeze(repositories) });
}

export function diagnoseGitHubReadIntegration(value: unknown = {}, environment: NodeJS.ProcessEnv = process.env): GitHubReadDiagnostic {
  const config = normalizeGitHubReadConfig(value);
  return Object.freeze({
    enabled: config.enabled,
    configured: config.enabled && validToken(environment[config.tokenEnv]) !== undefined,
    repositoryCount: config.repositories.length,
    endpoint: GITHUB_API_HOST,
    readOnly: true,
    mutationsAvailable: false,
    redirectsAllowed: false
  });
}

export function createGitHubReadClient(value: unknown = {}, options: ClientOptions = {}): GitHubReadClient {
  const config = normalizeGitHubReadConfig(value);
  if (!config.enabled) throw new Error("GitHub read integration is disabled");
  const environment = options.environment ?? process.env;
  const resolveNetworkAddresses = options.resolveNetworkAddresses ?? dnsLookupAll;
  const transport = options.transport ?? nativeGitHubTransport;
  const requestTimeoutMs = normalizeRequestTimeout(options.__testOnlyRequestTimeoutMs);
  const allowedRepositories = new Map(config.repositories.map((repository) => [repository.toLowerCase(), repository]));
  const generation = digest(`github-read:${config.tokenEnv}:${[...allowedRepositories.keys()].sort().join("\n")}`);
  const target: GitHubReadTarget = Object.freeze({ endpoint: "api.github.com", generation });
  const diagnostic = diagnoseGitHubReadIntegration(config, environment);

  const selectedRepository = (input: Record<string, unknown>) => {
    const repository = normalizeRepository(input.repository, "GitHub repository");
    const allowed = allowedRepositories.get(repository.toLowerCase());
    if (!allowed) throw new Error("GitHub repository is outside the configured read allowlist");
    return allowed;
  };
  const request = async (path: string, signal?: AbortSignal) => {
    const token = validToken(environment[config.tokenEnv]);
    if (token === undefined) throw new Error("GitHub read credential is not configured");
    return requestGitHubJson(path, token, { signal, resolveNetworkAddresses, transport, requestTimeoutMs });
  };
  const resourceFor = (kind: "repository" | "issue" | "pull-request" | "checks", input: Record<string, unknown>) => {
    rejectUnknownInput(
      input,
      kind === "repository"
        ? new Set(["repository"])
        : kind === "issue"
          ? new Set(["repository", "issueNumber"])
          : kind === "pull-request"
            ? new Set(["repository", "pullNumber"])
            : new Set(["repository", "ref", "limit"]),
      `github.${kind} input`
    );
    const repository = selectedRepository(input);
    const targetValue = kind === "issue"
      ? String(normalizeNumber(input.issueNumber, "GitHub issueNumber"))
      : kind === "pull-request"
        ? String(normalizeNumber(input.pullNumber, "GitHub pullNumber"))
        : kind === "checks"
          ? normalizeCommitOid(input.ref)
          : "repository";
    return Object.freeze({
      configurationDigest: generation,
      repositoryDigest: digest(`github-repository:${repository.toLowerCase()}`),
      targetDigest: digest(`github-target:${kind}:${repository.toLowerCase()}:${targetValue.toLowerCase()}`)
    });
  };

  const client: GitHubReadClient = {
    target,
    diagnostic,
    resourceFor,
    repository: async (input, signal) => {
      rejectUnknownInput(input, new Set(["repository"]), "github.repository input");
      const repository = selectedRepository(input);
      const raw = ordinaryObject(await request(`/repos/${encodedRepository(repository)}`, signal), "GitHub repository response");
      return normalizeRepositoryResponse(raw, repository);
    },
    issue: async (input, signal) => {
      rejectUnknownInput(input, new Set(["repository", "issueNumber"]), "github.issue input");
      const repository = selectedRepository(input);
      const issueNumber = normalizeNumber(input.issueNumber, "GitHub issueNumber");
      const raw = ordinaryObject(await request(`/repos/${encodedRepository(repository)}/issues/${issueNumber}`, signal), "GitHub issue response");
      return normalizeIssueResponse(raw, repository, issueNumber);
    },
    pullRequest: async (input, signal) => {
      rejectUnknownInput(input, new Set(["repository", "pullNumber"]), "github.pullRequest input");
      const repository = selectedRepository(input);
      const pullNumber = normalizeNumber(input.pullNumber, "GitHub pullNumber");
      const raw = ordinaryObject(await request(`/repos/${encodedRepository(repository)}/pulls/${pullNumber}`, signal), "GitHub pull request response");
      return normalizePullResponse(raw, repository, pullNumber);
    },
    checks: async (input, signal) => {
      rejectUnknownInput(input, new Set(["repository", "ref", "limit"]), "github.checks input");
      const repository = selectedRepository(input);
      const ref = normalizeCommitOid(input.ref);
      const limit = normalizeLimit(input.limit);
      const raw = ordinaryObject(await request(`/repos/${encodedRepository(repository)}/commits/${ref}/check-runs?per_page=${limit}`, signal), "GitHub checks response");
      return normalizeChecksResponse(raw, repository, ref, limit);
    }
  };
  return Object.freeze(client);
}

function rejectUnknownInput(input: Record<string, unknown>, fields: ReadonlySet<string>, label: string): void {
  const source = ordinaryObject(input, label);
  rejectUnknownFields(source, fields, label);
}

function normalizeRepository(value: unknown, label: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 140 || !GITHUB_REPOSITORY.test(value)) {
    throw new Error(`${label} must be an owner/repository identifier`);
  }
  const [owner, repository] = value.split("/");
  if (owner === "." || owner === ".." || repository === "." || repository === ".." || repository?.endsWith(".git")) {
    throw new Error(`${label} must be an owner/repository identifier`);
  }
  return value;
}

function normalizeNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function normalizeLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > GITHUB_MAX_CHECKS) throw new Error(`GitHub checks limit must be an integer from 1 through ${GITHUB_MAX_CHECKS}`);
  return Number(value);
}

function normalizeCommitOid(value: unknown): string {
  if (typeof value !== "string" || !GITHUB_COMMIT_OID.test(value)) throw new Error("GitHub checks ref must be a full commit object ID");
  return value.toLowerCase();
}

function encodedRepository(repository: string): string {
  const [owner, name] = repository.split("/") as [string, string];
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function validToken(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 8_192
    && !/[\s\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

async function requestGitHubJson(
  path: string,
  token: string,
  options: Readonly<{
    signal?: AbortSignal;
    resolveNetworkAddresses: (hostname: string) => Promise<string[]>;
    transport: GitHubHttpTransport;
    requestTimeoutMs: number;
  }>
): Promise<unknown> {
  const url = assertTrustedGitHubApiUrl(new URL(path, `${GITHUB_API_ORIGIN}/`));
  const headers = Object.freeze({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "Odinn-Forge/github-read",
    "x-github-api-version": GITHUB_API_VERSION
  });
  const budget = createGitHubRequestBudget(options.signal, options.requestTimeoutMs);
  let acquired = false;
  try {
    await acquireGitHubRequestSlot(budget.signal);
    acquired = true;
    if (budget.signal.aborted) throw budget.failure();
    const operation = performGitHubRequest(url, headers, {
      signal: budget.signal,
      resolveNetworkAddresses: options.resolveNetworkAddresses,
      transport: options.transport
    });
    void operation.then(releaseGitHubRequestSlot, releaseGitHubRequestSlot);
    acquired = false;
    const response = await settleWithinGitHubRequestBudget(operation, budget);
    if (response.status >= 300 && response.status < 400) throw new Error("GitHub API redirects are refused");
    if (response.status < 200 || response.status >= 300) throw new Error(`GitHub API returned status ${response.status}`);
    if (!Buffer.isBuffer(response.body)) throw new Error("GitHub API response body was invalid");
    if (response.body.byteLength > GITHUB_MAX_RESPONSE_BYTES) throw new Error("GitHub API response exceeded the bounded size limit");
    const contentType = firstHeader(response.headers["content-type"]);
    if (!contentType.toLowerCase().includes("json")) throw new Error("GitHub API response was not JSON");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)); }
    catch { throw new Error("GitHub API returned invalid JSON"); }
  } catch (error) {
    if (budget.signal.aborted) throw budget.failure();
    throw error;
  } finally {
    if (acquired) releaseGitHubRequestSlot();
    budget.dispose();
  }
}

async function performGitHubRequest(
  url: URL,
  headers: Readonly<Record<string, string>>,
  options: Readonly<{
    signal: AbortSignal;
    resolveNetworkAddresses: (hostname: string) => Promise<string[]>;
    transport: GitHubHttpTransport;
  }>
): Promise<GitHubHttpResponse> {
  let addresses: string[];
  try {
    addresses = await options.resolveNetworkAddresses(url.hostname);
  } catch {
    if (options.signal.aborted) throw abortError();
    throw new Error("GitHub API DNS validation failed");
  }
  if (options.signal.aborted) throw abortError();
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((address) => typeof address !== "string" || isIP(address) === 0 || isPrivateAddress(address))) {
    throw new Error("GitHub API DNS validation refused a non-public address");
  }
  try {
    const response = await options.transport({ url, address: addresses[0]!, headers, signal: options.signal });
    if (options.signal.aborted) throw abortError();
    return response;
  } catch (error) {
    if (options.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
    throw new Error("GitHub API request failed");
  }
}

function assertTrustedGitHubApiUrl(url: URL): URL {
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== GITHUB_API_HOST || (url.port && url.port !== "443") || url.username || url.password || url.hash) {
    throw new Error("GitHub read access only permits the trusted api.github.com origin");
  }
  if (!url.pathname.startsWith("/repos/") || url.pathname.includes("//") || /(?:^|\/)\.\.?(?:\/|$)/u.test(url.pathname)) {
    throw new Error("GitHub API path is outside the read-only repository surface");
  }
  const allowedQuery = url.searchParams.size === 0
    || (url.searchParams.size === 1 && url.searchParams.has("per_page") && /^\d{1,3}$/u.test(url.searchParams.get("per_page") ?? ""));
  if (!allowedQuery) throw new Error("GitHub API query is outside the bounded read surface");
  return url;
}

async function nativeGitHubTransport(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
  return new Promise((resolveResponse, rejectResponse) => {
    if (input.signal?.aborted) return rejectResponse(abortError());
    let settled = false;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const finish = (error?: Error, response?: GitHubHttpResponse) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      if (error) rejectResponse(error); else resolveResponse(response!);
    };
    const request = httpsRequest(input.url, {
      method: "GET",
      headers: input.headers,
      lookup: pinnedAddressLookup(input.address),
      rejectUnauthorized: true,
      agent: false
    }, (response) => {
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > GITHUB_MAX_RESPONSE_BYTES) {
          response.destroy();
          request.destroy();
          finish(new Error("GitHub API response exceeded the bounded size limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(undefined, {
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
      response.on("error", () => finish(new Error("GitHub API response failed")));
    });
    const onAbort = () => {
      request.destroy();
      finish(abortError());
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    request.on("error", () => finish(new Error("GitHub API request failed")));
    request.end();
  });
}

type GitHubRequestBudget = Readonly<{
  signal: AbortSignal;
  failure: () => Error;
  dispose: () => void;
}>;

function normalizeRequestTimeout(value: unknown): number {
  if (value === undefined) return GITHUB_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > GITHUB_TIMEOUT_MS) {
    throw new Error(`GitHub request timeout must be an integer from 1 through ${GITHUB_TIMEOUT_MS}`);
  }
  return Number(value);
}

function createGitHubRequestBudget(callerSignal: AbortSignal | undefined, timeoutMs: number): GitHubRequestBudget {
  const controller = new AbortController();
  let reason: "cancelled" | "timed-out" | undefined;
  const abort = (nextReason: "cancelled" | "timed-out") => {
    if (controller.signal.aborted) return;
    reason = nextReason;
    controller.abort();
  };
  const onCallerAbort = () => abort("cancelled");
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const deadline = setTimeout(() => abort("timed-out"), timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    failure: () => reason === "timed-out" ? new Error("GitHub API request timed out") : abortError(),
    dispose: () => {
      clearTimeout(deadline);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  });
}

function settleWithinGitHubRequestBudget<T>(operation: Promise<T>, budget: GitHubRequestBudget): Promise<T> {
  if (budget.signal.aborted) return Promise.reject(budget.failure());
  return new Promise<T>((resolveOperation, rejectOperation) => {
    let settled = false;
    const succeed = (result: T) => {
      if (settled) return;
      settled = true;
      budget.signal.removeEventListener("abort", onAbort);
      resolveOperation(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      budget.signal.removeEventListener("abort", onAbort);
      rejectOperation(error);
    };
    const onAbort = () => fail(budget.failure());
    budget.signal.addEventListener("abort", onAbort, { once: true });
    operation.then(succeed, fail);
  });
}

async function acquireGitHubRequestSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  if (activeGitHubRequests < GITHUB_MAX_CONCURRENT_REQUESTS) {
    activeGitHubRequests += 1;
    return;
  }
  await new Promise<void>((resolveSlot, rejectSlot) => {
    const waiter: GitHubRequestWaiter = {
      active: true,
      signal,
      resolve: () => {
        if (!waiter.active) return;
        waiter.active = false;
        signal?.removeEventListener("abort", waiter.onAbort!);
        resolveSlot();
      }
    };
    waiter.onAbort = () => {
      if (!waiter.active) return;
      waiter.active = false;
      const index = githubRequestWaiters.indexOf(waiter);
      if (index >= 0) githubRequestWaiters.splice(index, 1);
      rejectSlot(abortError());
    };
    githubRequestWaiters.push(waiter);
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
  });
}

function releaseGitHubRequestSlot(): void {
  let waiter = githubRequestWaiters.shift();
  while (waiter && !waiter.active) waiter = githubRequestWaiters.shift();
  if (waiter) {
    waiter.resolve();
    return;
  }
  activeGitHubRequests = Math.max(0, activeGitHubRequests - 1);
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function boundedText(value: unknown, label: string, maxBytes: number, { optional = false }: { optional?: boolean } = {}): string | undefined {
  if (value === null || value === undefined) {
    if (optional) return undefined;
    throw new Error(`${label} is required`);
  }
  if (typeof value !== "string" || value.includes("\u0000")) throw new Error(`${label} must be text`);
  return utf8Prefix(value, maxBytes);
}

function utf8Prefix(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  let prefix = encoded.subarray(0, maxBytes).toString("utf8");
  if (prefix.endsWith("\ufffd")) prefix = prefix.slice(0, -1);
  return prefix;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, label: string, allowed: T): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${label} is unsupported`);
  return value as T[number];
}

function timestamp(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 64 || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be a timestamp`);
  return new Date(value).toISOString();
}

function exactResponseNumber(value: unknown, expected: number, label: string): number {
  if (value !== expected) throw new Error(`${label} does not match the requested target`);
  return expected;
}

function normalizeRepositoryResponse(raw: Record<string, unknown>, repository: string): Readonly<Record<string, unknown>> {
  const fullName = boundedText(raw.full_name, "GitHub repository.full_name", 140)!;
  if (fullName.toLowerCase() !== repository.toLowerCase()) throw new Error("GitHub repository response does not match the requested target");
  const owner = ordinaryObject(raw.owner, "GitHub repository.owner");
  return Object.freeze({
    type: "github.repository",
    repository,
    name: boundedText(raw.name, "GitHub repository.name", 100)!,
    owner: boundedText(owner.login, "GitHub repository.owner.login", 39)!,
    visibility: enumValue(raw.visibility, "GitHub repository.visibility", ["public", "private", "internal"] as const),
    archived: requiredBoolean(raw.archived, "GitHub repository.archived"),
    disabled: requiredBoolean(raw.disabled, "GitHub repository.disabled"),
    defaultBranch: boundedText(raw.default_branch, "GitHub repository.default_branch", 256)!,
    description: boundedText(raw.description, "GitHub repository.description", 4_096, { optional: true }),
    contentTrust: "external-untrusted"
  });
}

function normalizeIssueResponse(raw: Record<string, unknown>, repository: string, issueNumber: number): Readonly<Record<string, unknown>> {
  const labels = Array.isArray(raw.labels) ? raw.labels.slice(0, 32).flatMap((entry) => {
    if (typeof entry === "string") return [utf8Prefix(entry, 256)];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const name = (entry as Record<string, unknown>).name;
    return typeof name === "string" ? [utf8Prefix(name, 256)] : [];
  }) : [];
  const body = boundedText(raw.body, "GitHub issue.body", 32_768, { optional: true });
  return Object.freeze({
    type: "github.issue",
    repository,
    issueNumber: exactResponseNumber(raw.number, issueNumber, "GitHub issue number"),
    state: enumValue(raw.state, "GitHub issue.state", ["open", "closed"] as const),
    title: boundedText(raw.title, "GitHub issue.title", 1_024)!,
    body,
    bodyTruncated: typeof raw.body === "string" && Buffer.byteLength(raw.body, "utf8") > 32_768,
    locked: requiredBoolean(raw.locked, "GitHub issue.locked"),
    labels: Object.freeze(labels),
    isPullRequest: Boolean(raw.pull_request),
    createdAt: timestamp(raw.created_at, "GitHub issue.created_at"),
    updatedAt: timestamp(raw.updated_at, "GitHub issue.updated_at"),
    closedAt: timestamp(raw.closed_at, "GitHub issue.closed_at"),
    contentTrust: "external-untrusted"
  });
}

function normalizePullResponse(raw: Record<string, unknown>, repository: string, pullNumber: number): Readonly<Record<string, unknown>> {
  const head = ordinaryObject(raw.head, "GitHub pull request.head");
  const base = ordinaryObject(raw.base, "GitHub pull request.base");
  const body = boundedText(raw.body, "GitHub pull request.body", 32_768, { optional: true });
  return Object.freeze({
    type: "github.pull-request",
    repository,
    pullNumber: exactResponseNumber(raw.number, pullNumber, "GitHub pull request number"),
    state: enumValue(raw.state, "GitHub pull request.state", ["open", "closed"] as const),
    title: boundedText(raw.title, "GitHub pull request.title", 1_024)!,
    body,
    bodyTruncated: typeof raw.body === "string" && Buffer.byteLength(raw.body, "utf8") > 32_768,
    draft: requiredBoolean(raw.draft, "GitHub pull request.draft"),
    merged: requiredBoolean(raw.merged, "GitHub pull request.merged"),
    head: Object.freeze({ ref: boundedText(head.ref, "GitHub pull request.head.ref", 256)!, oid: normalizeCommitOid(head.sha) }),
    base: Object.freeze({ ref: boundedText(base.ref, "GitHub pull request.base.ref", 256)!, oid: normalizeCommitOid(base.sha) }),
    createdAt: timestamp(raw.created_at, "GitHub pull request.created_at"),
    updatedAt: timestamp(raw.updated_at, "GitHub pull request.updated_at"),
    mergedAt: timestamp(raw.merged_at, "GitHub pull request.merged_at"),
    contentTrust: "external-untrusted"
  });
}

function normalizeChecksResponse(raw: Record<string, unknown>, repository: string, ref: string, limit: number): Readonly<Record<string, unknown>> {
  if (!Array.isArray(raw.check_runs)) throw new Error("GitHub checks response.check_runs must be an array");
  const checks = raw.check_runs.slice(0, limit).map((entry, index) => {
    const check = ordinaryObject(entry, `GitHub checks response.check_runs[${index}]`);
    return Object.freeze({
      name: boundedText(check.name, `GitHub check[${index}].name`, 512)!,
      status: enumValue(check.status, `GitHub check[${index}].status`, ["queued", "in_progress", "completed", "pending", "requested", "waiting"] as const),
      conclusion: check.conclusion === null || check.conclusion === undefined
        ? null
        : enumValue(check.conclusion, `GitHub check[${index}].conclusion`, ["action_required", "cancelled", "failure", "neutral", "skipped", "stale", "startup_failure", "success", "timed_out"] as const),
      startedAt: timestamp(check.started_at, `GitHub check[${index}].started_at`),
      completedAt: timestamp(check.completed_at, `GitHub check[${index}].completed_at`)
    });
  });
  return Object.freeze({
    type: "github.checks",
    repository,
    ref,
    checks: Object.freeze(checks),
    checkCount: checks.length,
    truncated: raw.check_runs.length > limit || (Number.isSafeInteger(raw.total_count) && Number(raw.total_count) > checks.length),
    contentTrust: "external-untrusted"
  });
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function abortError(): Error {
  const error = new Error("GitHub read cancelled");
  error.name = "AbortError";
  return error;
}
