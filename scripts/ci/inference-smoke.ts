import { createServer as createProviderServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GATEWAY_STARTUP_TIMEOUT_MS = 20_000;

export type InferenceSmokeOptions = {
  root?: string;
  gatewayCommand?: string;
  gatewayArgs?: string[];
};

export async function runInferenceProtocolSmoke(options: InferenceSmokeOptions = {}) {
  const root = options.root ?? sourceRoot;
  const gatewayCommand = options.gatewayCommand ?? process.execPath;
  const gatewayArgs = options.gatewayArgs ?? [join(root, "apps", "gateway", "src", "server.ts")];
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-packaged-gateway-") );
  const provider = createProviderServer(async (request: any, response: any) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== "Bearer ci-provider-key") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "missing provider credential" } }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    if (payload.model !== "odinn-ci-provider" || !Array.isArray(payload.messages)) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid configured-provider request" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "odinn-ci-provider-response",
      object: "chat.completion",
      model: payload.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ODINN_PACKAGED_GATEWAY_OK" } }],
      usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 }
    }));
  });
  await listen(provider);
  const providerPort = (provider.address() as any).port;
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify({
    version: 1,
    auditLog: "audit.jsonl",
    policy: {},
    defaultModel: "ci:odinn-ci-provider",
    providers: {
      ci: {
        type: "openai-compatible",
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        apiKeyEnv: "ODINN_CI_PROVIDER_API_KEY",
        models: ["odinn-ci-provider"]
      }
    }
  }, null, 2)}\n`);

  const child = spawn(gatewayCommand, gatewayArgs, {
    shell: process.platform === "win32" && gatewayCommand.toLowerCase().endsWith(".cmd"),
    cwd: root,
    env: { ...process.env, INIT_CWD: root, ODINN_HOST: "127.0.0.1", ODINN_PORT: "0", ODINN_STATE_DIR: stateDir, ODINN_CI_PROVIDER_API_KEY: "ci-provider-key" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let childError = "";
  let childOutput = "";
  let childExited = false;
  let childSpawnError: Error | undefined;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: any) => { childOutput += chunk; });
  child.on("error", (error: Error) => {
    childSpawnError = error;
    childError += `\n[child error] ${error.message}`;
  });
  child.on("exit", (code: any, signal: any) => {
    childExited = true;
    childOutput += `\n[child exit code=${code} signal=${signal}]`;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: any) => { childError += chunk; });
  try {
    const gatewayPort = await waitForChildPort(
      child,
      () => childOutput,
      () => childError,
      () => childSpawnError,
      () => childExited,
    );
    const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
    const bootstrap = await fetch(`${gatewayBase}/`);
    const setCookie = typeof bootstrap.headers.getSetCookie === "function"
      ? bootstrap.headers.getSetCookie()[0]
      : bootstrap.headers.get("set-cookie");
    const cookie = setCookie?.split(";", 1)[0];
    if (!cookie) {
      throw new Error(`packaged gateway did not issue an authentication cookie: status=${bootstrap.status}; auth=${bootstrap.headers.get("x-odinn-auth") ?? ""}`);
    }
    await waitForStatus(`${gatewayBase}/status`, cookie, child, () => `${childOutput}${childError}`);
    const response = await fetch(`${gatewayBase}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: gatewayBase, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        id: "run_ci_packaged_gateway",
        tool: "model.chat",
        input: { messages: [{ role: "user", content: "ping" }] }
      })
    });
    if (!response.ok) throw new Error(`packaged gateway returned HTTP ${response.status}: ${await response.text()}`);
    const result: any = await response.json();
    const run: any = await (await fetch(`${gatewayBase}/runs/run_ci_packaged_gateway`, { headers: { cookie } })).json();
    const persisted = run.events?.find((event: any) => event.type === "task.completed")?.data?.output?.content;
    if (result.output?.content !== "ODINN_PACKAGED_GATEWAY_OK" || persisted !== "ODINN_PACKAGED_GATEWAY_OK") {
      throw new Error(`configured provider response was not persisted: ${JSON.stringify({ result, persisted })}`);
    }
    return result.output;
  } catch (error: any) {
    throw new Error(`${error.message}${error.cause ? ` (${error.cause.message})` : ""}; child=${childOutput}${childError}`);
  } finally {
    await terminateChild(child);
    await close(provider);
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function terminateChild(child: any) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve: any) => child.once("close", resolve));
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      encoding: "utf8",
      windowsHide: true
    });
  } else {
    child.kill();
  }
  await Promise.race([
    closed,
    new Promise((resolve: any) => setTimeout(resolve, 5_000))
  ]);
}

async function listen(server: any) {
  await new Promise((resolve: any, reject: any) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server: any) {
  await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
}

async function waitForChildPort(child: any, getOutput: any, getError: any, getSpawnError: any, hasExited: any) {
  const deadline = performance.now() + GATEWAY_STARTUP_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const match = getOutput().match(/"port"\s*:\s*(\d+)/);
    if (match && Number(match[1]) > 0) return Number(match[1]);
    const spawnError = getSpawnError();
    if (spawnError) throw new Error(`packaged gateway failed to start: ${spawnError.message}`);
    if (hasExited() || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`packaged gateway exited before binding: ${getError() || getOutput() || "no output"}`);
    }
    await new Promise((resolve: any) => setTimeout(resolve, 100));
  }
  const spawnError = getSpawnError();
  if (spawnError) throw new Error(`packaged gateway failed to start: ${spawnError.message}`);
  if (hasExited() || child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`packaged gateway exited before binding: ${getError() || getOutput() || "no output"}`);
  }
  throw new Error(`packaged gateway did not report a port within ${GATEWAY_STARTUP_TIMEOUT_MS}ms: ${getError() || getOutput() || "no output"}`);
}

async function waitForStatus(url: any, cookie: any, child: any, getChildError: any) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { cookie } });
      if (response.ok) return response.json();
      lastError = new Error(`gateway status returned ${response.status}`);
    } catch (error: any) {
      lastError = error;
      if (child.exitCode !== null) throw new Error(`packaged gateway exited with ${child.exitCode}: ${getChildError() || "no stderr"}`);
    }
    await new Promise((resolve: any) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for packaged gateway: ${lastError?.message ?? "unknown error"}; child=${getChildError() || "no output"}`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const result = await runInferenceProtocolSmoke();
  console.log(result.content);
}
