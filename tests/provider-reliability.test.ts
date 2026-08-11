import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuditStore, createBuiltInRegistry, CUSTOM_PROVIDER_SUPPORT, listProviderPresets, normalizeModelConfig, normalizeUsage, providerSupport, PROVIDER_PRESETS, PROVIDER_REGISTRY, runTask } from "../packages/kernel/src/index.ts";

async function listen(handler: any) {
  const server = createServer(handler);
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

test("provider usage is normalized across chat, responses, and camel-case payloads", () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }), {
    inputTokens: 2, prompt_tokens: 2, outputTokens: 3, completion_tokens: 3, totalTokens: 5, total_tokens: 5, source: "provider"
  });
  assert.deepEqual(normalizeUsage({ input_tokens: 4, output_tokens: 6 }), {
    inputTokens: 4, prompt_tokens: 4, outputTokens: 6, completion_tokens: 6, totalTokens: 10, total_tokens: 10, source: "provider"
  });
  assert.equal(normalizeUsage({}), undefined);
});

test("provider catalog has a conformance contract for every preset", () => {
  const presets = listProviderPresets();
  assert.equal(presets.length, Object.keys(PROVIDER_PRESETS).length);
  for (const preset of presets) {
    const source = PROVIDER_PRESETS[preset.name];
    assert.equal(source.id, preset.name);
    assert.equal(source.supportTier, preset.supportTier);
    assert.ok(["first-class", "compatible", "experimental"].includes(source.supportTier));
    assert.ok(source.authModes.length > 0);
    assert.equal(typeof source.locallyTested, "boolean");
    assert.equal(typeof source.genericCompatibilityMode, "boolean");
    const config = normalizeModelConfig({ providers: { [preset.name]: { ...source, auth: source.oauth?.auth ?? (source.defaultAuth ? { mode: source.defaultAuth } : undefined), transport: source.oauth?.transport ?? source.transport } } });
    const provider = config.providers[preset.name];
    assert.ok(provider, `${preset.name} normalized`);
    assert.ok(["openai-chat-completions", "openai-responses", "openai-chatgpt-responses", "cli-antigravity"].includes(provider.transport), `${preset.name} transport`);
    assert.ok(provider.auth.mode, `${preset.name} auth`);
  }
  assert.ok(Object.isFrozen(PROVIDER_REGISTRY));
  assert.deepEqual(
    presets.filter((preset) => preset.supportTier === "first-class").map((preset) => preset.name).sort(),
    ["ollama", "openai", "openrouter"]
  );
  assert.equal(providerSupport("groq").supportTier, "compatible");
  assert.equal(providerSupport("github-copilot").supportTier, "experimental");
  assert.equal(providerSupport("private-gateway").supportTier, CUSTOM_PROVIDER_SUPPORT.supportTier);
  assert.equal(providerSupport("private-gateway").displayName, "Private Gateway");
});

test("every first-class provider executes through the stable inference contract", async () => {
  const requests: Array<{ provider: string; authorization: string }> = [];
  let activeProvider = "";
  const server = await listen((request: any, response: any) => {
    requests.push({
      provider: activeProvider,
      authorization: String(request.headers.authorization ?? "")
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `response-${activeProvider}`,
      choices: [{ message: { role: "assistant", content: `ready:${activeProvider}` } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }));
  });
  const root = await mkdtemp(join(tmpdir(), "odinn-first-class-providers-"));
  const previous: Record<string, string | undefined> = {};
  try {
    for (const providerName of ["openai", "openrouter", "ollama"]) {
      activeProvider = providerName;
      const definition = PROVIDER_REGISTRY[providerName];
      const envName = providerName === "ollama" ? "" : `ODINN_TEST_${providerName.toUpperCase()}_KEY`;
      if (envName) {
        previous[envName] = process.env[envName];
        process.env[envName] = `${providerName}-secret`;
      }
      const stateDir = join(root, providerName);
      const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
      const registry = createBuiltInRegistry({
        workspaceRoot: root,
        stateDir,
        config: {
          defaultModel: `${providerName}:contract-model`,
          providers: {
            [providerName]: {
              ...definition,
              baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
              apiKeyEnv: envName,
              models: ["contract-model"],
              transport: "openai-chat-completions",
              auth: { mode: "api-key" }
            }
          }
        }
      });
      const result = await runTask({
        task: {
          id: `first_class_${providerName}`,
          tool: "model.chat",
          input: { model: `${providerName}:contract-model`, messages: [{ role: "user", content: "ping" }] }
        },
        auditStore,
        registry
      });
      assert.equal(result.output.content, `ready:${providerName}`);
      assert.equal(result.output.usage.total_tokens, 2);
    }
    assert.deepEqual(
      requests.map((request) => ({
        provider: request.provider,
        authenticated: Boolean(request.authorization)
      })),
      [
        { provider: "openai", authenticated: true },
        { provider: "openrouter", authenticated: true },
        { provider: "ollama", authenticated: false }
      ]
    );
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise((resolve: any) => server.close(resolve));
  }
});

test("provider failures redact configured credentials", async () => {
  const secret = "provider-secret-that-must-not-escape";
  const server = await listen((_request: any, response: any) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: {
        message: `authorization=Bearer ${secret}; api_key=${secret}`
      }
    }));
  });
  const root = await mkdtemp(join(tmpdir(), "odinn-provider-redaction-"));
  const previous = process.env.ODINN_PROVIDER_REDACTION_API_KEY;
  process.env.ODINN_PROVIDER_REDACTION_API_KEY = secret;
  try {
    const auditStore = createAuditStore(join(root, "audit.jsonl"));
    const registry = createBuiltInRegistry({
      workspaceRoot: root,
      stateDir: join(root, ".odinn"),
      config: {
        defaultModel: "openai:redaction-model",
        providers: {
          openai: {
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            apiKeyEnv: "ODINN_PROVIDER_REDACTION_API_KEY",
            models: ["redaction-model"]
          }
        }
      }
    });
    await assert.rejects(
      () => runTask({
        task: {
          id: "provider_redaction",
          tool: "model.chat",
          input: { messages: [{ role: "user", content: "ping" }] }
        },
        auditStore,
        registry
      }),
      (error: any) => {
        assert.doesNotMatch(error.message, new RegExp(secret, "u"));
        assert.match(error.message, /\[redacted\]/u);
        return true;
      }
    );
    assert.doesNotMatch(JSON.stringify(await auditStore.readAll()), new RegExp(secret, "u"));
  } finally {
    if (previous === undefined) delete process.env.ODINN_PROVIDER_REDACTION_API_KEY;
    else process.env.ODINN_PROVIDER_REDACTION_API_KEY = previous;
    await new Promise((resolve: any) => server.close(resolve));
  }
});

test("provider transport retries transient failures and normalizes streaming output", async () => {
  let attempts = 0;
  const server = await listen(async (request: any, response: any) => {
    attempts += 1;
    if (attempts === 1) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "try again" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({ id: "stream_1", choices: [{ delta: { role: "assistant", content: "ODINN_" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "STREAM_OK" } }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })}`,
      "data: [DONE]",
      ""
    ].join("\n"));
  });
  const root = await mkdtemp(join(tmpdir(), "odinn-provider-"));
  const auditStore = createAuditStore(join(root, "audit.jsonl"));
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir: join(root, ".odinn"),
    config: {
      defaultModel: "test:stream-model",
      providers: { test: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: "ODINN_PROVIDER_TEST_API_KEY", models: ["stream-model"] } }
    }
  });
  const previous = process.env.ODINN_PROVIDER_TEST_API_KEY;
  process.env.ODINN_PROVIDER_TEST_API_KEY = "provider-key";
  try {
    const result = await runTask({
      task: { id: "provider_retry_stream", tool: "model.chat", input: { stream: true, retries: 2, messages: [{ role: "user", content: "ping" }] } },
      auditStore,
      registry
    });
    assert.equal(attempts, 2);
    assert.equal(result.output.content, "ODINN_STREAM_OK");
    assert.equal(result.output.usage.total_tokens, 4);
  } finally {
    if (previous === undefined) delete process.env.ODINN_PROVIDER_TEST_API_KEY;
    else process.env.ODINN_PROVIDER_TEST_API_KEY = previous;
    await new Promise((resolve: any) => server.close(resolve));
  }
});

test("provider responses are terminated at the model body limit", async () => {
  const server = await listen((_request: any, response: any) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "A".repeat(8 * 1024 * 1024 + 1) } }] }));
  });
  const root = await mkdtemp(join(tmpdir(), "odinn-provider-limit-"));
  const auditStore = createAuditStore(join(root, "audit.jsonl"));
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir: join(root, ".odinn"), config: { defaultModel: "test:limited", providers: { test: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: ["limited"] } } } });
  try {
    await assert.rejects(() => runTask({ task: { tool: "model.chat", input: { messages: [{ role: "user", content: "ping" }] } }, auditStore, registry }), /response exceeded 8388608 bytes/);
  } finally { await new Promise((resolve: any) => server.close(resolve)); }
});

test("Antigravity receives prompts over stdin instead of process arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-antigravity-"));
  const command = join(root, "agy-fixture.mjs");
  await writeFile(command, `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input })));
`, "utf8");
  await chmod(command, 0o700);
  const previous = process.env.ODINN_ANTIGRAVITY_CLI;
  process.env.ODINN_ANTIGRAVITY_CLI = command;
  const auditStore = createAuditStore(join(root, "audit.jsonl"));
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir: join(root, ".odinn"),
    config: {
      defaultModel: "antigravity:test-model",
      providers: {
        antigravity: {
          transport: "cli-antigravity",
          models: ["test-model"],
          auth: { mode: "cli", commandEnv: "ODINN_ANTIGRAVITY_CLI" }
        }
      }
    }
  });
  try {
    const result = await runTask({ task: { tool: "model.chat", input: { messages: [{ role: "user", content: "secret prompt" }] } }, auditStore, registry });
    const captured = JSON.parse(result.output.content);
    assert.deepEqual(captured.args, ["--print", "--model", "test-model"]);
    assert.equal(captured.input, "user: secret prompt");
  } finally {
    if (previous === undefined) delete process.env.ODINN_ANTIGRAVITY_CLI;
    else process.env.ODINN_ANTIGRAVITY_CLI = previous;
  }
});
