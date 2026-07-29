import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { withStateMutationLock } from "../state-mutation.ts";

type AnyRecord = Record<string, any>;
type NodeError = Error & { code?: string; details?: AnyRecord };

const MAX_MODEL_RESPONSE_BYTES = 8 * 1024 * 1024;

export function normalizeModelConfig(config: any = {}) {
  const providers: AnyRecord = {};
  for (const [name, value] of Object.entries(config.providers ?? {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const provider = value as AnyRecord;
    const transport = modelString(provider.transport, "openai-chat-completions");
    const type = modelString(provider.type, "openai-compatible");
    const baseUrl = modelString(provider.baseUrl, "");
    if (!baseUrl && type !== "cli" && !transport.startsWith("cli-")) continue;
    const models = Array.isArray(provider.models)
      ? provider.models.map((model: any) => modelString(model, "")).filter(Boolean)
      : [];
    providers[name] = {
      type,
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKeyEnv: modelString(provider.apiKeyEnv, ""),
      models,
      transport,
      auth: normalizeProviderAuth(provider.auth, name)
    };
  }
  const models = listConfiguredModels({ providers, defaultModel: config.defaultModel });
  return {
    defaultModel: models.some((model: any) => model.id === config.defaultModel)
      ? config.defaultModel
      : models[0]?.id ?? "",
    providers
  };
}

export function normalizeProviderAuth(value: any, providerName: any = "provider") {
  const auth = value && typeof value === "object" ? value : {};
  const mode = modelString(auth.mode, "api-key");
  if (!["api-key", "oauth", "device", "cli"].includes(mode)) throw new Error(`unsupported auth mode for ${providerName}: ${mode}`);
  if (mode === "api-key") return { mode: "api-key" };
  if (mode === "cli") {
    return {
      mode,
      flow: modelString(auth.flow, ""),
      commandEnv: modelString(auth.commandEnv, "")
    };
  }
  return {
    mode,
    flow: modelString(auth.flow, "generic-pkce"),
    authorizationUrl: modelString(auth.authorizationUrl, ""),
    tokenUrl: modelString(auth.tokenUrl, ""),
    clientId: modelString(auth.clientId, ""),
    clientIdEnv: modelString(auth.clientIdEnv, ""),
    clientSecretEnv: modelString(auth.clientSecretEnv, ""),
    scopes: Array.isArray(auth.scopes) ? auth.scopes.map((scope: any) => modelString(scope, "")).filter(Boolean) : [],
    redirectUri: modelString(auth.redirectUri, ""),
    tokenFile: modelString(auth.tokenFile, join("oauth", `${providerName}.json`)),
    authorizationParams: auth.authorizationParams && typeof auth.authorizationParams === "object" && !Array.isArray(auth.authorizationParams)
      ? Object.fromEntries(Object.entries(auth.authorizationParams).map(([key, item]: any) => [key, modelString(item, "")]).filter(([, item]: any) => item))
      : {}
  };
}

export function normalizeUsage(value: any) {
  if (!value || typeof value !== "object") return undefined;
  const inputTokens = integerOrUndefined(value.input_tokens ?? value.prompt_tokens ?? value.inputTokens);
  const outputTokens = integerOrUndefined(value.output_tokens ?? value.completion_tokens ?? value.outputTokens);
  const totalTokens = integerOrUndefined(value.total_tokens ?? value.totalTokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens, prompt_tokens: inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens, completion_tokens: outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens, total_tokens: totalTokens }),
    source: "provider"
  };
}

export function mergeUsage(current: any, next: any) {
  if (!next) return current;
  if (!current) return { ...next };
  const inputTokens = (current.inputTokens ?? 0) + (next.inputTokens ?? 0);
  const outputTokens = (current.outputTokens ?? 0) + (next.outputTokens ?? 0);
  const totalTokens = (current.totalTokens ?? 0) + (next.totalTokens ?? 0);
  return {
    ...((current.inputTokens !== undefined || next.inputTokens !== undefined) ? { inputTokens, prompt_tokens: inputTokens } : {}),
    ...((current.outputTokens !== undefined || next.outputTokens !== undefined) ? { outputTokens, completion_tokens: outputTokens } : {}),
    ...((current.totalTokens !== undefined || next.totalTokens !== undefined) ? { totalTokens, total_tokens: totalTokens } : {}),
    source: "provider"
  };
}

function integerOrUndefined(value: any) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

export function createOAuthAuthorizationRequest(provider: any, { redirectUri, state = randomBytes(24).toString("hex") }: any = {}) {
  const auth = normalizeProviderAuth(provider.auth, "provider");
  if (auth.mode !== "oauth") throw new Error("provider auth mode must be oauth");
  const clientId = auth.clientId || (auth.clientIdEnv ? modelString(process.env[auth.clientIdEnv], "") : "");
  if (!auth.authorizationUrl || !clientId) throw new Error("OAuth provider requires authorizationUrl and clientId or clientIdEnv");
  const effectiveRedirectUri = redirectUri || auth.redirectUri;
  if (!effectiveRedirectUri) throw new Error("OAuth authorization requires a redirect URI");
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const url = new URL(auth.authorizationUrl);
  for (const [key, value] of Object.entries(auth.authorizationParams)) url.searchParams.set(key, String(value));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", effectiveRedirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (auth.scopes.length) url.searchParams.set("scope", auth.scopes.join(" "));
  return { authorizationUrl: url.toString(), state, codeVerifier, redirectUri: effectiveRedirectUri };
}

export async function exchangeOAuthCode(provider: any, { code, codeVerifier, redirectUri }: any = {}) {
  const auth = normalizeProviderAuth(provider.auth, "provider");
  if (auth.mode !== "oauth") throw new Error("provider auth mode must be oauth");
  const clientId = auth.clientId || (auth.clientIdEnv ? modelString(process.env[auth.clientIdEnv], "") : "");
  if (!auth.tokenUrl || !clientId) throw new Error("OAuth provider requires tokenUrl and clientId or clientIdEnv");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: modelString(code, ""),
    client_id: clientId,
    code_verifier: modelString(codeVerifier, ""),
    redirect_uri: redirectUri || auth.redirectUri
  });
  appendClientSecret(body, auth);
  return requestOAuthToken(auth.tokenUrl, body);
}

export async function saveOAuthToken(provider: any, stateDir: any, token: any, options: any = {}) {
  const auth = normalizeProviderAuth(provider.auth, "provider");
  const path = oauthTokenPath(provider, stateDir);
  const record: AnyRecord = {
    accessToken: modelString(token.access_token ?? token.accessToken, ""),
    refreshToken: modelString(token.refresh_token ?? token.refreshToken, ""),
    expiresAt: normalizeTokenExpiry(token)
  };
  for (const key of ["tokenEndpoint", "enterpriseDomain", "clientId", "baseUrl"]) {
    const value = modelString(token[key], "");
    if (value) record[key] = value;
  }
  if (!record.accessToken && !record.refreshToken) throw new Error("OAuth token response contained no usable token");
  return withStateMutationLock(resolve(stateDir), async () => {
    await mkdir(resolve(stateDir, "oauth"), { recursive: true, mode: 0o700 });
    if (typeof options.expectedTokenFingerprint === "string") {
      const currentFingerprint = await readFile(path, "utf8").then(contentFingerprint).catch((error: unknown) => {
        if ((error as NodeError | undefined)?.code === "ENOENT") return "missing";
        throw error;
      });
      if (currentFingerprint !== options.expectedTokenFingerprint) {
        throw new Error("OAuth credentials changed in another process while a refresh was running. The stale refresh was not written; retry the request.");
      }
    }
    const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
      await chmod(path, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
    return { path, expiresAt: record.expiresAt };
  });
}

export function oauthTokenPath(provider: any, stateDir: any) {
  const auth = normalizeProviderAuth(provider.auth, "provider");
  const root = resolve(stateDir);
  const path = resolve(root, auth.tokenFile);
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || rel.includes("..\\")) throw new Error("OAuth token path escapes state directory");
  return path;
}

async function resolveOAuthAccessToken(provider: any, stateDir: any) {
  const auth = normalizeProviderAuth(provider.auth, "provider");
  const path = oauthTokenPath(provider, stateDir);
  let token;
  let tokenRaw;
  try {
    tokenRaw = await readFile(path, "utf8");
    token = JSON.parse(tokenRaw);
  } catch (error) {
    if ((error as NodeError | undefined)?.code === "ENOENT") throw new Error("OAuth provider is not connected; run `odinn onboard --provider <name> --auth oauth`");
    throw error;
  }
  if (token.accessToken && (!token.expiresAt || token.expiresAt > Date.now() + 60_000)) return token.accessToken;
  if (!token.refreshToken) throw new Error("OAuth access token expired and no refresh token is available; rerun provider onboarding");
  if (auth.flow === "github-copilot-device") {
    const domain = token.enterpriseDomain || "github.com";
    const copilotBase = token.baseUrl || (domain === "github.com" ? "https://api.individual.githubcopilot.com" : `https://copilot-api.${domain}`);
    const response = await fetch(`https://api.${domain}/copilot_internal/v2/token`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token.refreshToken}`,
        "user-agent": "GitHubCopilotChat/0.35.0",
        "editor-version": "vscode/1.107.0",
        "editor-plugin-version": "copilot-chat/0.35.0",
        "copilot-integration-id": "vscode-chat"
      }
    });
    const refreshed = await readModelResponse(response);
    if (!response.ok || !modelString(refreshed.token, "")) throw new Error(`GitHub Copilot token refresh returned ${response.status}: ${modelErrorMessage(refreshed)}`);
    await saveOAuthToken(provider, stateDir, {
      access_token: refreshed.token,
      refresh_token: token.refreshToken,
      expires_at: Number(refreshed.expires_at) * 1000,
      baseUrl: copilotBase,
      enterpriseDomain: token.enterpriseDomain
    }, { expectedTokenFingerprint: contentFingerprint(tokenRaw) });
    return refreshed.token;
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    client_id: auth.clientId || (auth.clientIdEnv ? process.env[auth.clientIdEnv] || "" : "")
  });
  appendClientSecret(body, auth);
  const refreshed = await requestOAuthToken(token.tokenEndpoint || auth.tokenUrl, body);
  if (!modelString(refreshed.access_token, "")) throw new Error("OAuth refresh response contained no access token");
  await saveOAuthToken(
    provider,
    stateDir,
    { ...refreshed, refresh_token: refreshed.refresh_token || token.refreshToken },
    { expectedTokenFingerprint: contentFingerprint(tokenRaw) }
  );
  return refreshed.access_token;
}

function contentFingerprint(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function appendClientSecret(body: any, auth: any) {
  if (!auth.clientSecretEnv) return;
  const secret = process.env[auth.clientSecretEnv];
  if (!secret) throw new Error(`missing OAuth client secret environment variable: ${auth.clientSecretEnv}`);
  body.set("client_secret", secret);
}

async function requestOAuthToken(tokenUrl: any, body: any) {
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body
  });
  const payload = await readModelResponse(response);
  if (!response.ok) throw new Error(`OAuth token endpoint returned ${response.status}: ${modelErrorMessage(payload)}`);
  return payload;
}

function normalizeTokenExpiry(token: any) {
  if (typeof token.expiresAt === "number") return token.expiresAt;
  if (typeof token.expires_at === "number") return token.expires_at > 1e12 ? token.expires_at : token.expires_at * 1000;
  const expiresIn = Number(token.expires_in ?? token.expiresIn);
  return Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined;
}

export function listConfiguredModels(config: any = {}) {
  const providers = config.providers ?? {};
  return Object.entries(providers).flatMap(([provider, value]: any) =>
    (value.models ?? []).map((model: any) => ({
      id: `${provider}:${model}`,
      provider,
      model,
      type: value.type ?? "openai-compatible",
      transport: value.transport ?? "openai-chat-completions"
    }))
  );
}

export async function chatWithModel(modelConfig: any, input: any = {}, { stateDir, signal, onDelta, onProviderAttempt }: any = {}) {
  const modelRef = modelString(input.model, modelConfig.defaultModel);
  if (!modelRef) {
    throw new Error("no model configured; run `odinn onboard --provider openai` or `odinn onboard --provider ollama --model <installed-model>`");
  }
  const parsed = parseModelRef(modelRef);
  const provider = modelConfig.providers[parsed.provider];
  if (!provider) throw new Error(`unknown model provider: ${parsed.provider}`);
  if (provider.type !== "openai-compatible" && provider.type !== "cli") throw new Error(`unsupported provider type: ${provider.type}`);
  if (!provider.models.includes(parsed.model)) {
    throw new Error(`model is not configured for provider ${parsed.provider}: ${parsed.model}`);
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new Error("model.chat requires messages");
  }
  const messages = input.messages.map((message: any, index: any) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error(`model.chat message ${index + 1} must be an object`);
    }
    const role = modelString(message.role, "");
    const content = modelString(message.content, "");
    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (!["system", "user", "assistant", "tool"].includes(role) || (!content && !hasToolCalls)) {
      throw new Error(`model.chat message ${index + 1} requires system, user, or assistant role and content`);
    }
    return {
      role,
      content,
      ...(hasToolCalls ? { tool_calls: message.tool_calls } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {})
    };
  });

  if (provider.transport === "cli-antigravity") {
    return chatWithAntigravity(provider, parsed, messages, input, signal);
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  const accessToken = ["oauth", "device"].includes(provider.auth.mode)
    ? await resolveOAuthAccessToken(provider, stateDir)
    : provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : "";
  if (provider.auth.mode === "api-key" && provider.apiKeyEnv && !accessToken) {
    throw new Error(`missing API key environment variable: ${provider.apiKeyEnv}`);
  }
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const isChatGptResponsesTransport = provider.transport === "openai-chatgpt-responses";
  const chatGptAccountId = isChatGptResponsesTransport && accessToken
    ? resolveOpenAICodexAccountId(accessToken)
    : "";
  if (isChatGptResponsesTransport) Object.assign(headers, {
    accept: "text/event-stream",
    "openai-beta": "responses=experimental",
    originator: process.env.ODINN_OPENAI_ORIGINATOR || "openclaw",
    version: process.env.ODINN_OPENAI_CLIENT_VERSION || "2026.6.11",
    "user-agent": `openclaw/${process.env.ODINN_OPENAI_CLIENT_VERSION || "2026.6.11"}`,
    ...(chatGptAccountId ? { "chatgpt-account-id": chatGptAccountId } : {})
  });
  if (provider.auth.flow === "github-copilot-device") Object.assign(headers, {
    accept: "application/json",
    "user-agent": "GitHubCopilotChat/0.35.0",
    "editor-version": "vscode/1.107.0",
    "editor-plugin-version": "copilot-chat/0.35.0",
    "copilot-integration-id": "vscode-chat"
  });

  const isResponsesTransport = provider.transport === "openai-responses" || provider.transport === "openai-chatgpt-responses";
  const streamRequested = input.stream === true && !isResponsesTransport;
  if (streamRequested) headers.accept = "text/event-stream";
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal.reason ?? new Error("model request aborted"));
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("model request timed out")), normalizeTimeout(input.timeoutMs));
  try {
    const baseUrl = await resolveProviderBaseUrl(provider, stateDir);
    const tools = Array.isArray(input.tools) ? input.tools : [];
    const responseMessages = isChatGptResponsesTransport
      ? messages.filter((message: any) => message.role !== "system")
      : messages;
    const requestBody = {
      model: parsed.model,
      ...(isResponsesTransport
        ? {
            input: responsesInput(responseMessages),
            ...(isChatGptResponsesTransport ? { instructions: chatGptResponsesInstructions(messages) } : {}),
            ...(tools.length ? { tools: responseTools(tools) } : {})
          }
        : { messages: chatCompletionMessages(messages), ...(tools.length ? { tools: chatCompletionTools(tools) } : {}) }),
      ...(isChatGptResponsesTransport || streamRequested ? { stream: true, ...(isChatGptResponsesTransport ? { store: false } : {}) } : {}),
      ...(input.temperature === undefined ? {} : { temperature: normalizeTemperature(input.temperature) }),
      ...(input.maxTokens === undefined
        ? {}
        : isResponsesTransport ? { max_output_tokens: normalizeMaxTokens(input.maxTokens) } : { max_tokens: normalizeMaxTokens(input.maxTokens) })
    };
    const maxRetries = normalizeRetries(input.retries ?? input.maxRetries);
    let response;
    let payload;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const attemptId = `provider_attempt_${randomUUID()}`;
      response = undefined;
      payload = undefined;
      try {
        response = await fetch(`${baseUrl}/${isResponsesTransport ? "responses" : "chat/completions"}`, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
        payload = isChatGptResponsesTransport
          ? await readResponsesModelResponse(response, onDelta)
          : streamRequested
            ? await readStreamingChatResponse(response, onDelta)
            : await readModelResponse(response);
      } catch (error) {
        const retryable = !controller.signal.aborted;
        await onProviderAttempt?.({ attemptId, providerId: parsed.provider, modelId: parsed.model, attempt: attempt + 1, status: "error", retryable });
        if (!retryable || attempt === maxRetries) throw error;
        await waitForRetry(undefined, attempt, controller.signal);
        continue;
      }
      const emptySuccess = response.ok
        && !(isResponsesTransport ? responseText(payload) : payload?.choices?.[0]?.message?.content)?.trim()
        && !extractToolCalls(payload, isResponsesTransport, tools).length;
      const retryable = emptySuccess || (!response.ok && isRetryableProviderStatus(response.status));
      await onProviderAttempt?.({ attemptId, providerId: parsed.provider, modelId: parsed.model, attempt: attempt + 1, status: emptySuccess ? "empty" : response.status, retryable });
      if (response.ok && !emptySuccess) break;
      if (!retryable || attempt === maxRetries) break;
      await waitForRetry(response, attempt, controller.signal);
    }
    if (!response) throw new Error("model provider returned no response");
    if (!response.ok) throw new Error(`model provider returned ${response.status}: ${modelErrorMessage(payload, [accessToken])}`);
    const content = isResponsesTransport ? responseText(payload) : payload?.choices?.[0]?.message?.content;
    const toolCalls = extractToolCalls(payload, isResponsesTransport, tools);
    if ((!content || !content.trim()) && !toolCalls.length) {
      const reasoning = payload?.choices?.[0]?.message?.reasoning;
      if (typeof reasoning === "string" && reasoning.trim()) {
        const error = new Error("model exhausted its output budget in reasoning before producing assistant content; increase maxTokens or use a non-reasoning model") as NodeError;
        error.code = "MODEL_REASONING_BUDGET_EXHAUSTED";
        error.details = {
          providerId: parsed.provider,
          modelId: parsed.model,
          maxTokens: input.maxTokens === undefined ? undefined : normalizeMaxTokens(input.maxTokens),
          nextAction: "Retry once with a larger response budget or use a non-reasoning model."
        };
        throw error;
      }
      throw new Error("model provider returned no assistant content");
    }
    return {
      provider: parsed.provider,
      model: parsed.model,
      content: content || "",
      toolCalls,
      id: typeof payload.id === "string" ? payload.id : undefined,
      usage: normalizeUsage(payload.usage)
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("model provider request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

function resolveOpenAICodexAccountId(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3) return "";
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof accountId === "string" ? accountId.trim() : "";
  } catch {
    return "";
  }
}

async function resolveProviderBaseUrl(provider: any, stateDir: any) {
  if (provider.auth.flow !== "github-copilot-device" || !stateDir) return provider.baseUrl;
  try {
    const token = JSON.parse(await readFile(oauthTokenPath(provider, stateDir), "utf8"));
    return modelString(token.baseUrl, provider.baseUrl);
  } catch {
    return provider.baseUrl;
  }
}

async function chatWithAntigravity(provider: any, parsed: any, messages: any, input: any, signal?: AbortSignal) {
  const command = process.env[provider.auth.commandEnv || "ODINN_ANTIGRAVITY_CLI"] || "agy";
  const commandArgs = ["--print", "--model", parsed.model];
  const nodeScript = process.platform === "win32" && /\.[cm]?[jt]s$/iu.test(command);
  const executable = nodeScript ? process.execPath : command;
  const executableArgs = nodeScript ? [command, ...commandArgs] : commandArgs;
  const prompt = messages.map((message: any) => `${message.role}: ${message.content}`).join("\n\n");
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const content = await new Promise<string>((resolveOutput, rejectOutput) => {
    const child = spawn(executable, executableArgs, {
      env: { PATH: process.env.PATH ?? "", ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) rejectOutput(error);
      else resolveOutput(Buffer.concat(chunks).toString("utf8").trim());
    };
    const abort = () => { child.kill("SIGKILL"); finish(new Error("Antigravity request aborted")); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("Antigravity request timed out")); }, timeoutMs);
    child.once("error", (error: NodeError) => finish(error.code === "ENOENT" ? new Error(`Antigravity CLI not found; install it or set ${provider.auth.commandEnv || "ODINN_ANTIGRAVITY_CLI"}`) : error));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_MODEL_RESPONSE_BYTES) { child.kill("SIGKILL"); finish(new Error(`Antigravity response exceeded ${MAX_MODEL_RESPONSE_BYTES} bytes`)); }
      else chunks.push(Buffer.from(chunk));
    });
    child.once("close", (code) => code === 0 ? finish() : finish(new Error(`Antigravity request failed with exit code ${code ?? "unknown"}`)));
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    child.stdin.end(prompt);
  });
  if (!content) throw new Error("Antigravity returned no assistant content");
  return { provider: parsed.provider, model: parsed.model, content };
}

function responseText(payload: any) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return (payload?.output ?? [])
    .flatMap((item: any) => item?.content ?? [])
    .map((item: any) => item?.text)
    .filter((text: any) => typeof text === "string")
    .join("\n");
}

function responsesInput(messages: any) {
  return messages.flatMap((message: any) => {
    if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      return message.tool_calls.map((call: any) => ({ type: "function_call", call_id: call.id, name: providerToolName(call.name || call.function?.name), arguments: call.arguments || call.function?.arguments || "{}" }));
    }
    return [{ role: message.role, content: message.content }];
  });
}

function chatGptResponsesInstructions(messages: any) {
  const instructions = messages
    .filter((message: any) => message.role === "system")
    .map((message: any) => message.content)
    .filter((content: any) => typeof content === "string" && content.trim())
    .join("\n\n")
    .trim();
  return instructions || "Follow the user request.";
}

function chatCompletionMessages(messages: any) {
  return messages.map((message: any) => message.role === "assistant" && Array.isArray(message.tool_calls)
    ? { ...message, tool_calls: message.tool_calls.map((call: any) => ({ id: call.id, type: "function", function: { name: providerToolName(call.name || call.function?.name), arguments: call.arguments || call.function?.arguments || "{}" } })) }
    : message);
}

function responseTools(tools: any) {
  assertDistinctProviderToolNames(tools);
  return tools.map((tool: any) => tool.function ? {
    type: "function",
    name: providerToolName(tool.function.name),
    description: tool.function.description,
    parameters: tool.function.parameters
  } : tool);
}

function chatCompletionTools(tools: any) {
  assertDistinctProviderToolNames(tools);
  return tools.map((tool: any) => tool.function
    ? { ...tool, function: { ...tool.function, name: providerToolName(tool.function.name) } }
    : tool);
}

function providerToolName(name: any) {
  return String(name ?? "").replace(/[^a-zA-Z0-9_-]/gu, (character) => `_x${character.codePointAt(0)?.toString(16)}_`);
}

function assertDistinctProviderToolNames(tools: any) {
  const names = new Set();
  for (const tool of tools) {
    const original = tool?.function?.name;
    if (!original) continue;
    const encoded = providerToolName(original);
    if (names.has(encoded)) throw new Error(`model tool names collide after provider encoding: ${encoded}`);
    names.add(encoded);
  }
}

function originalToolName(name: any, tools: any) {
  return tools.find((tool: any) => providerToolName(tool?.function?.name) === name)?.function?.name ?? name;
}

function extractToolCalls(payload: any, responsesTransport: any, tools: any = []) {
  if (responsesTransport) {
    return (payload?.output || [])
      .filter((item: any) => item?.type === "function_call")
      .map((item: any) => ({ id: item.call_id || item.id || prefixedId("call"), name: originalToolName(item.name, tools), arguments: item.arguments || "{}" }));
  }
  return (payload?.choices?.[0]?.message?.tool_calls || []).map((call: any) => ({
    id: call.id || prefixedId("call"),
    name: originalToolName(call.function?.name, tools),
    arguments: call.function?.arguments || "{}"
  }));
}

async function readModelResponse(response: any) {
  const raw = await readBoundedResponseText(response);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { error: raw.slice(0, 500) };
  }
}

async function readStreamingChatResponse(response: any, onDelta?: (delta: string) => void | Promise<void>) {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const raw = await readBoundedResponseText(response);
    try { return raw ? JSON.parse(raw) : {}; } catch { return { error: raw.slice(0, 500) }; }
  }
  let content = "";
  const toolCalls = [];
  let usage;
  let id;
  for await (const line of boundedResponseLines(response)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice("data:".length).trim();
    if (!value || value === "[DONE]") continue;
    let event;
    try { event = JSON.parse(value); } catch { continue; }
    id ||= event.id;
    usage ||= event.usage;
    const delta = event.choices?.[0]?.delta;
    if (typeof delta?.content === "string") {
      content += delta.content;
      await onDelta?.(delta.content);
    }
    for (const call of delta?.tool_calls ?? []) {
      const current: any = toolCalls[call.index ?? toolCalls.length] ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      current.id += call.id ?? "";
      current.function.name += call.function?.name ?? "";
      current.function.arguments += call.function?.arguments ?? "";
      toolCalls[call.index ?? toolCalls.length] = current;
    }
  }
  return {
    id,
    choices: [{ message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }],
    ...(usage ? { usage } : {})
  };
}

async function readResponsesModelResponse(response: any, onDelta?: (delta: string) => void | Promise<void>) {
  const contentType = response.headers.get("content-type");
  // ChatGPT's Codex responses endpoint currently streams SSE without a
  // Content-Type header. Treat a missing header as a stream; explicit JSON
  // responses still take the bounded JSON path below.
  if (contentType && !contentType.includes("text/event-stream")) {
    const raw = await readBoundedResponseText(response);
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      return { error: raw.slice(0, 500) };
    }
  }
  let completed: any = {};
  let content = "";
  let error;
  const output = [];
  for await (const line of boundedResponseLines(response)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice("data:".length).trim();
    if (!value || value === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(value);
    } catch {
      continue;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      content += event.delta;
      await onDelta?.(event.delta);
    }
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") output.push(event.item);
    if (event.type === "response.completed" && event.response && typeof event.response === "object") completed = event.response;
    if (event.type === "error" || event.type === "response.failed") error = event.error ?? event.response?.error ?? event;
  }
  const completedOutput = Array.isArray(completed.output) ? completed.output : [];
  const effectiveOutput = completedOutput.length ? completedOutput : output;
  return {
    ...completed,
    ...(content ? { output_text: content } : {}),
    ...(effectiveOutput.length ? { output: effectiveOutput } : {}),
    ...(error ? { error } : {})
  };
}

async function readBoundedResponseText(response: any, maxBytes = MAX_MODEL_RESPONSE_BYTES) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  if (!response.body) return "";
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      await response.body.cancel?.("model response exceeded configured limit").catch?.(() => undefined);
      throw new Error(`model provider response exceeded ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function* boundedResponseLines(response: any, maxBytes = MAX_MODEL_RESPONSE_BYTES) {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      await response.body.cancel?.("model response exceeded configured limit").catch?.(() => undefined);
      throw new Error(`model provider response exceeded ${maxBytes} bytes`);
    }
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) yield buffer.replace(/\r$/u, "");
}

function modelErrorMessage(payload: any, secretValues: unknown[] = []) {
  let message = modelString(payload?.error?.message, modelString(payload?.error, "request failed"));
  for (const secret of secretValues) {
    if (typeof secret === "string" && secret.length >= 4) message = message.replaceAll(secret, "[redacted]");
  }
  message = message
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]");
  return message.slice(0, 1_000);
}

function parseModelRef(value: any) {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) throw new Error(`model must use provider:model format: ${value}`);
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

function modelString(value: any, fallback: any) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function normalizeTimeout(value: any) {
  const timeout = Number(value ?? 60_000);
  return Number.isFinite(timeout) && timeout >= 1_000 && timeout <= 300_000 ? timeout : 60_000;
}

function normalizeRetries(value: any) {
  const retries = Number.parseInt(String(value ?? 2), 10);
  return Number.isFinite(retries) ? Math.max(0, Math.min(4, retries)) : 2;
}

function isRetryableProviderStatus(status: any) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function waitForRetry(response: any, attempt: any, signal: any) {
  const retryAfter = Number(response?.headers?.get?.("retry-after"));
  const delay = Number.isFinite(retryAfter) && retryAfter >= 0
    ? Math.min(retryAfter * 1000, 30_000)
    : Math.min(500 * (2 ** attempt), 8_000) + Math.floor(Math.random() * 250);
  await new Promise((resolve: any, reject: any) => {
    const timer = setTimeout(resolve, delay);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("model request aborted"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function normalizeTemperature(value: any) {
  const temperature = Number(value);
  if (!Number.isFinite(temperature)) throw new Error("temperature must be a number");
  return Math.max(0, Math.min(2, temperature));
}

function normalizeMaxTokens(value: any) {
  const maxTokens = Number.parseInt(String(value), 10);
  if (!Number.isFinite(maxTokens) || maxTokens < 1) throw new Error("maxTokens must be a positive integer");
  return Math.min(maxTokens, 32_768);
}

function prefixedId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}
