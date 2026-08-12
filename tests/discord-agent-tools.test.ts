import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { DISCORD_AGENT_TOOL_SCHEMAS } from "../adapters/channels/discord/src/index.ts";
import { createApprovalStore, createAuditStore, createBuiltInRegistry, createDifferentiatedRuntime, runTask, toolSafetyDescriptor } from "../packages/kernel/src/index.ts";
import { approvalRequirementForTool, createDefaultPolicy } from "../packages/policy/src/index.ts";
import { createRuntimeIsolatedTaskExecutor, createRuntimeRegistry } from "../packages/runtime/src/index.ts";

const DISCORD_MUTATIONS = [
  ["discord.sendMessage", { channelId: "123", content: "hello" }],
  ["discord.editMessage", { channelId: "123", messageId: "456", content: "hello" }],
  ["discord.deleteMessage", { channelId: "123", messageId: "456" }],
  ["discord.addReaction", { channelId: "123", messageId: "456", emoji: "👍" }],
  ["discord.removeReaction", { channelId: "123", messageId: "456", emoji: "👍" }],
  ["discord.pinMessage", { channelId: "123", messageId: "456" }],
  ["discord.unpinMessage", { channelId: "123", messageId: "456" }],
  ["discord.sendPoll", { channelId: "123", question: "Deploy?", answers: ["Yes", "No"] }],
  ["discord.createThread", { channelId: "123", name: "Review" }],
  ["discord.replyThread", { threadId: "789", content: "hello" }]
] as const;

const DISCORD_RESOURCE_FIELDS = new Map<string, readonly string[]>([
  ["discord.listChannels", ["guildId"]],
  ["discord.readMessages", ["channelId"]],
  ["discord.sendMessage", ["channelId", "replyToId"]],
  ["discord.editMessage", ["channelId", "messageId"]],
  ["discord.deleteMessage", ["channelId", "messageId"]],
  ["discord.addReaction", ["channelId", "messageId", "emoji"]],
  ["discord.removeReaction", ["channelId", "messageId", "emoji"]],
  ["discord.listReactions", ["channelId", "messageId", "emoji"]],
  ["discord.pinMessage", ["channelId", "messageId"]],
  ["discord.unpinMessage", ["channelId", "messageId"]],
  ["discord.listPins", ["channelId"]],
  ["discord.sendPoll", ["channelId"]],
  ["discord.createThread", ["channelId", "messageId"]],
  ["discord.listThreads", ["guildId"]],
  ["discord.replyThread", ["threadId", "replyToId"]],
  ["discord.searchMessages", ["guildId", "channelId"]]
]);

function configuredDiscord() {
  return {
    plugins: {
      entries: {
        discord: {
          enabled: true,
          config: {
            accounts: {
              home: { enabled: true, tokenEnv: "ODINN_TEST_DISCORD_TOKEN" }
            }
          }
        }
      }
    }
  };
}

test("Discord agent definitions exist only in the composed runtime registry", () => {
  const kernel = createBuiltInRegistry({ config: configuredDiscord() });
  const runtime = createRuntimeRegistry({ config: configuredDiscord() });
  const expected = DISCORD_AGENT_TOOL_SCHEMAS.map((schema) => schema.function.name).sort();
  try {
    assert.deepEqual([...kernel.keys()].filter((name) => name.startsWith("discord.")), []);
    assert.deepEqual([...runtime.keys()].filter((name) => name.startsWith("discord.")).sort(), expected);
    assert.equal(expected.length, 16);
    for (const schema of DISCORD_AGENT_TOOL_SCHEMAS) {
      const tool = runtime.get(schema.function.name);
      assert.equal(tool.description, schema.function.description);
      assert.deepEqual(tool.inputSchema, schema.function.parameters);
      assert.equal(
        approvalRequirementForTool(schema.function.name),
        DISCORD_MUTATIONS.some(([name]) => name === schema.function.name)
      );
    }
  } finally {
    kernel.close();
    runtime.close();
  }
});

test("every Discord capability resource contains only endpoint-authoritative identifiers", () => {
  const registry = createRuntimeRegistry({ config: configuredDiscord() });
  const input = {
    accountId: " home ",
    guildId: "101",
    channelId: "202",
    threadId: "303",
    messageId: "404",
    replyToId: "505",
    emoji: "👍",
    content: "hello",
    question: "Deploy?",
    answers: ["Yes", "No"],
    name: "Review",
    query: "release"
  };
  try {
    assert.equal(DISCORD_RESOURCE_FIELDS.size, DISCORD_AGENT_TOOL_SCHEMAS.length);
    for (const schema of DISCORD_AGENT_TOOL_SCHEMAS) {
      const name = schema.function.name;
      const fields = DISCORD_RESOURCE_FIELDS.get(name);
      assert.ok(fields, name);
      const expected = Object.fromEntries([
        ["accountId", "home"],
        ...fields.map((field) => [field, input[field as keyof typeof input]])
      ]);
      assert.deepEqual(registry.get(name).resourceForInput(input), expected, name);
    }
  } finally {
    registry.close();
  }
});

test("trusted policy requires approval for every Discord mutation", async () => {
  const original = process.env.ODINN_TEST_DISCORD_TOKEN;
  process.env.ODINN_TEST_DISCORD_TOKEN = "test-token";
  let requests = 0;
  const registry = createRuntimeRegistry({
    config: configuredDiscord(),
    discordFetch: async () => {
      requests += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  });
  try {
    for (const [name, input] of DISCORD_MUTATIONS) {
      assert.equal(approvalRequirementForTool(name), true, name);
      const pending = await registry.get(name).execute({ ...input, confirmed: true, approvalId: "forged" }, {
        request: { id: `run-${name}` }
      });
      assert.equal(pending.type, "approval.required", name);
    }
    assert.equal(requests, 0, "no Discord mutation may fetch before trusted approval consumption");
  } finally {
    registry.close();
    if (original === undefined) delete process.env.ODINN_TEST_DISCORD_TOKEN;
    else process.env.ODINN_TEST_DISCORD_TOKEN = original;
  }
});

test("cancellation prevents Discord reads and approved mutations from dispatching", async () => {
  const original = process.env.ODINN_TEST_DISCORD_TOKEN;
  process.env.ODINN_TEST_DISCORD_TOKEN = "test-token";
  let requests = 0;
  const approvalStore = createApprovalStore();
  const registry = createRuntimeRegistry({
    config: configuredDiscord(),
    approvalStore,
    discordFetch: async () => {
      requests += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  });
  try {
    const readAbort = new AbortController();
    readAbort.abort(new Error("cancelled before read"));
    await assert.rejects(
      registry.get("discord.readMessages").execute(
        { channelId: "123" },
        { signal: readAbort.signal }
      ),
      /cancelled before read/
    );

    const input = { channelId: "123", content: "hello" };
    const pending = await registry.get("discord.sendMessage").execute(input, {
      request: { id: "run-cancelled-discord" }
    });
    approvalStore.claim(pending.approvalId);
    const mutationAbort = new AbortController();
    mutationAbort.abort(new Error("cancelled before mutation"));
    await assert.rejects(
      registry.get("discord.sendMessage").execute(input, {
        request: { id: "run-cancelled-discord" },
        trustedApprovalId: pending.approvalId,
        signal: mutationAbort.signal
      }),
      /cancelled before mutation/
    );
    assert.equal(requests, 0);
    assert.equal(approvalStore.list().length, 1, "pre-dispatch cancellation must leave the approval unconsumed");
  } finally {
    registry.close();
    if (original === undefined) delete process.env.ODINN_TEST_DISCORD_TOKEN;
    else process.env.ODINN_TEST_DISCORD_TOKEN = original;
  }
});

test("Discord agent read tools use the configured bot account", async () => {
  const original = process.env.ODINN_TEST_DISCORD_TOKEN;
  process.env.ODINN_TEST_DISCORD_TOKEN = "test-token";
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const registry = createRuntimeRegistry({
    config: configuredDiscord(),
    discordFetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify([{ id: "1", content: "hello" }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  try {
    const output = await registry.get("discord.readMessages").execute({ channelId: "123", limit: 10 });
    assert.deepEqual(output, [{ id: "1", content: "hello" }]);
    assert.equal(calls[0].url, "https://discord.com/api/v10/channels/123/messages?limit=10");
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bot test-token");
    assert.equal(registry.get("discord.readMessages").capability, "network.access");
    assert.deepEqual(registry.get("discord.readMessages").capabilities, ["network.access"]);
  } finally {
    if (original === undefined) delete process.env.ODINN_TEST_DISCORD_TOKEN;
    else process.env.ODINN_TEST_DISCORD_TOKEN = original;
  }
});

test("Discord mutations require action-bound one-time approval before fetch", async () => {
  const original = process.env.ODINN_TEST_DISCORD_TOKEN;
  process.env.ODINN_TEST_DISCORD_TOKEN = "test-token";
  let requests = 0;
  const approvalStore = createApprovalStore();
  const registry = createRuntimeRegistry({
    config: configuredDiscord(),
    approvalStore,
    discordFetch: async () => {
      requests += 1;
      return new Response(JSON.stringify({ id: "456", content: "approved" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  try {
    const sendInput = { channelId: "123", content: "hello" };
    const pending = await registry.get("discord.sendMessage").execute(sendInput, { request: { id: "run-send" } });
    assert.equal(pending.type, "approval.required");
    assert.equal(requests, 0, "Discord must not fetch before approval is claimed");
    approvalStore.claim(pending.approvalId);
    const sent = await registry.get("discord.sendMessage").execute(sendInput, {
      request: { id: "run-send" },
      trustedApprovalId: pending.approvalId
    });
    assert.equal(sent.id, "456");
    assert.equal(requests, 1);
    await assert.rejects(
      registry.get("discord.sendMessage").execute(sendInput, {
        request: { id: "run-send" },
        trustedApprovalId: pending.approvalId
      }),
      /approval is missing, expired, already used, or does not match/
    );
    assert.equal(requests, 1, "a consumed approval must not reach Discord twice");
    assert.equal(approvalStore.list().length, 0);
    assert.equal(toolSafetyDescriptor("discord.sendMessage", registry.get("discord.sendMessage")).requiresApproval, true);
    assert.equal(toolSafetyDescriptor("discord.addReaction", registry.get("discord.addReaction")).requiresApproval, true);
  } finally {
    if (original === undefined) delete process.env.ODINN_TEST_DISCORD_TOKEN;
    else process.env.ODINN_TEST_DISCORD_TOKEN = original;
  }
});

test("restarted composition executes the exact sealed Discord approval input", async () => {
  const original = process.env.ODINN_TEST_DISCORD_TOKEN;
  process.env.ODINN_TEST_DISCORD_TOKEN = "test-token";
  const root = await mkdtemp(join(tmpdir(), "odinn-discord-approval-restart-"));
  const approvalPath = join(root, "approvals.json");
  const approvalStore = createApprovalStore({ path: approvalPath });
  const registry = createRuntimeRegistry({
    config: configuredDiscord(),
    approvalStore,
    discordFetch: async () => new Response(JSON.stringify({ id: "unexpected" }), { status: 200 })
  });
  const content = "Bearer abcdefghijklmnopqrstuvwxyz";
  try {
    const pending = await registry.get("discord.sendMessage").execute(
      { channelId: "123", content },
      { request: { id: "run-discord-restart" } }
    );
    const claimed = createApprovalStore({ path: approvalPath }).claim(pending.approvalId);
    assert.equal(claimed?.input?.content, "[redacted]");
    assert.doesNotMatch(await readFile(approvalPath, "utf8"), /abcdefghijklmnopqrstuvwxyz/u);

    const runtimeUrl = pathToFileURL(join(process.cwd(), "packages/runtime/src/index.ts")).href;
    const kernelUrl = pathToFileURL(join(process.cwd(), "packages/kernel/src/index.ts")).href;
    const childCode = [
      `import { createApprovalStore } from ${JSON.stringify(kernelUrl)};`,
      `import { createRuntimeRegistry } from ${JSON.stringify(runtimeUrl)};`,
      `const approvalStore = createApprovalStore({ path: ${JSON.stringify(approvalPath)} });`,
      `let body;`,
      `const registry = createRuntimeRegistry({ config: ${JSON.stringify(configuredDiscord())}, approvalStore, discordFetch: async (_url, init) => { body = JSON.parse(String(init.body)); return new Response(JSON.stringify({ id: "sent" }), { status: 200, headers: { "content-type": "application/json" } }); } });`,
      `const result = await registry.get("discord.sendMessage").execute(${JSON.stringify(claimed?.input)}, { request: { id: "run-discord-restart" }, trustedApprovalId: ${JSON.stringify(pending.approvalId)} });`,
      `registry.close();`,
      `if (result?.id !== "sent" || body?.content !== ${JSON.stringify(content)}) process.exit(2);`
    ].join("\n");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
      encoding: "utf8",
      env: process.env
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.deepEqual(createApprovalStore({ path: approvalPath }).list(), []);
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
    if (original === undefined) delete process.env.ODINN_TEST_DISCORD_TOKEN;
    else process.env.ODINN_TEST_DISCORD_TOKEN = original;
  }
});

test("Discord reaction and thread approvals are claimed before fetch and bound to exact input", async () => {
  const original = process.env.ODINN_TEST_DISCORD_TOKEN;
  process.env.ODINN_TEST_DISCORD_TOKEN = "test-token";
  let requests = 0;
  const approvalStore = createApprovalStore();
  const registry = createRuntimeRegistry({
    config: configuredDiscord(),
    approvalStore,
    discordFetch: async () => {
      requests += 1;
      return new Response(JSON.stringify({ id: "thread-1" }), { status: 200 });
    }
  });
  try {
    const reactionInput = { channelId: "123", messageId: "456", emoji: "👍" };
    const reaction = await registry.get("discord.addReaction").execute(reactionInput, { request: { id: "run-reaction" } });
    assert.equal(reaction.type, "approval.required");
    assert.equal(requests, 0);
    approvalStore.claim(reaction.approvalId);
    await assert.rejects(
      registry.get("discord.addReaction").execute(reactionInput, {
        request: { id: "different-run" },
        trustedApprovalId: reaction.approvalId
      }),
      /does not match/
    );
    await assert.rejects(
      registry.get("discord.addReaction").execute({ ...reactionInput, emoji: "👎" }, {
        request: { id: "run-reaction" },
        trustedApprovalId: reaction.approvalId
      }),
      /does not match/
    );
    assert.equal(requests, 0, "mismatched action must fail before Discord fetch");
    await registry.get("discord.addReaction").execute(reactionInput, {
      request: { id: "run-reaction" },
      trustedApprovalId: reaction.approvalId
    });
    assert.equal(requests, 1);

    const threadInput = { channelId: "123", name: "Review" };
    const thread = await registry.get("discord.createThread").execute(threadInput, { request: { id: "run-thread" } });
    assert.equal(thread.type, "approval.required");
    assert.equal(requests, 1);
    await assert.rejects(
      registry.get("discord.createThread").execute(threadInput, {
        request: { id: "run-thread" },
        trustedApprovalId: thread.approvalId
      }),
      /approval is missing/
    );
    assert.equal(requests, 1, "unclaimed approval must fail before Discord fetch");
    approvalStore.claim(thread.approvalId);
    const created = await registry.get("discord.createThread").execute(threadInput, {
      request: { id: "run-thread" },
      trustedApprovalId: thread.approvalId
    });
    assert.equal(created.id, "thread-1");
    assert.equal(requests, 2);
  } finally {
    if (original === undefined) delete process.env.ODINN_TEST_DISCORD_TOKEN;
    else process.env.ODINN_TEST_DISCORD_TOKEN = original;
  }
});

test("Discord agent tools fail closed without an enabled configured account", async () => {
  const registry = createRuntimeRegistry({
    config: { plugins: { entries: { discord: { enabled: true, config: { accounts: {} } } } } }
  });
  await assert.rejects(
    registry.get("discord.readMessages").execute({ channelId: "123" }),
    /no enabled Discord account is configured/
  );
});

test("Discord plugin activation and individual tools are config-controlled", () => {
  const disabled = createRuntimeRegistry({
    config: { plugins: { entries: { discord: { enabled: false } } } }
  });
  assert.equal(disabled.has("discord.readMessages"), false);

  const configured = configuredDiscord() as any;
  configured.plugins.entries.discord.config.tools = { "discord.sendMessage": false };
  const restricted = createRuntimeRegistry({ config: configured });
  assert.equal(restricted.has("discord.readMessages"), true);
  assert.equal(restricted.has("discord.sendMessage"), false);
});

test("legacy Discord channel config continues to activate the tool plugin", () => {
  const registry = createRuntimeRegistry({
    config: {
      channels: {
        home: { type: "discord", enabled: true, tokenEnv: "ODINN_TEST_DISCORD_TOKEN" }
      }
    }
  });
  assert.equal(registry.has("discord.readMessages"), true);
});

test("expanded Discord actions preserve read/write gates and native poll payloads", async () => {
  const original = process.env.ODINN_TEST_DISCORD_TOKEN;
  process.env.ODINN_TEST_DISCORD_TOKEN = "test-token";
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const approvalStore = createApprovalStore();
  const registry = createRuntimeRegistry({
    config: configuredDiscord(),
    approvalStore,
    discordFetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "poll-1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  try {
    await registry.get("discord.listPins").execute({ channelId: "123" });
    assert.equal(calls[0].url, "https://discord.com/api/v10/channels/123/pins");
    assert.equal(registry.get("discord.listPins").capability, "network.access");
    const input = {
      channelId: "123",
      question: "Deploy?",
      answers: ["Yes", "No"],
      durationHours: 12
    };
    const pending = await registry.get("discord.sendPoll").execute(input, { request: { id: "run-poll" } });
    assert.equal(pending.type, "approval.required");
    assert.equal(calls.length, 1);
    approvalStore.claim(pending.approvalId);
    await registry.get("discord.sendPoll").execute(input, {
      request: { id: "run-poll" },
      trustedApprovalId: pending.approvalId
    });
    const payload = JSON.parse(String(calls[1].init.body));
    assert.equal(payload.poll.question.text, "Deploy?");
    assert.deepEqual(payload.poll.answers.map((answer: any) => answer.poll_media.text), ["Yes", "No"]);
    assert.equal(registry.get("discord.sendPoll").capability, "network.access");
  } finally {
    if (original === undefined) delete process.env.ODINN_TEST_DISCORD_TOKEN;
    else process.env.ODINN_TEST_DISCORD_TOKEN = original;
  }
});

test("Discord capability constraints use canonical account and target resources", async () => {
  const original = process.env.ODINN_TEST_DISCORD_TOKEN;
  process.env.ODINN_TEST_DISCORD_TOKEN = "test-token";
  const root = await mkdtemp(join(tmpdir(), "odinn-discord-resource-binding-"));
  const stateDir = join(root, ".odinn");
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const runtime = createDifferentiatedRuntime({
    workspaceRoot: root,
    stateDir,
    featureFlags: { capabilities: true, counterfactual: false, capsules: false }
  });
  let requests = 0;
  const registry = createRuntimeRegistry({
    workspaceRoot: root,
    stateDir,
    config: { ...configuredDiscord(), runLedger: runtime.ledger },
    auditStore,
    discordFetch: async () => {
      requests += 1;
      return new Response(JSON.stringify({ id: "sent" }), { status: 200 });
    }
  });
  try {
    const runId = "discord-resource-mismatch";
    runtime.ledger.ensureRun({ runId, objective: "reject a forged Discord capability resource" });
    const issued = runtime.capabilities.issue({
      runId,
      stepId: "discord-send",
      toolName: "discord.sendMessage",
      resourceConstraints: { accountId: "home", channelId: "123" }
    });
    await assert.rejects(
      runTask({
        task: {
          id: runId,
          tool: "discord.sendMessage",
          input: {
            channelId: "999",
            content: "must not send",
            resource: { accountId: "home", channelId: "123" },
            capabilityToken: issued.token
          }
        },
        auditStore,
        policy: createDefaultPolicy({ allowedCapabilities: ["network.access"] }),
        registry,
        runLedger: runtime.ledger
      }),
      (error: any) => error.code === "CAPABILITY_SCOPE_MISMATCH"
    );
    assert.equal(requests, 0);

    const replyRunId = "discord-resource-extraneous-target";
    runtime.ledger.ensureRun({ runId: replyRunId, objective: "reject an irrelevant Discord capability resource" });
    const replyCapability = runtime.capabilities.issue({
      runId: replyRunId,
      stepId: "discord-reply",
      toolName: "discord.replyThread",
      resourceConstraints: { accountId: "home", channelId: "123" }
    });
    await assert.rejects(
      runTask({
        task: {
          id: replyRunId,
          tool: "discord.replyThread",
          input: {
            threadId: "999",
            channelId: "123",
            content: "must remain out of scope",
            capabilityToken: replyCapability.token
          }
        },
        auditStore,
        policy: createDefaultPolicy({ allowedCapabilities: ["network.access"] }),
        registry,
        runLedger: runtime.ledger
      }),
      (error: any) => error.code === "CAPABILITY_SCOPE_MISMATCH"
    );
    assert.equal(requests, 0);
  } finally {
    registry.close();
    auditStore.close();
    runtime.ledger.close();
    await rm(root, { recursive: true, force: true });
    if (original === undefined) delete process.env.ODINN_TEST_DISCORD_TOKEN;
    else process.env.ODINN_TEST_DISCORD_TOKEN = original;
  }
});

test("Discord capability scope is checked before account or credential lookup", async () => {
  const original = process.env.ODINN_TEST_DISCORD_TOKEN;
  const originalOther = process.env.ODINN_TEST_DISCORD_OTHER;
  process.env.ODINN_TEST_DISCORD_TOKEN = "test-token";
  delete process.env.ODINN_TEST_DISCORD_OTHER;
  const root = await mkdtemp(join(tmpdir(), "odinn-discord-resource-preauth-"));
  const stateDir = join(root, ".odinn");
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const runtime = createDifferentiatedRuntime({
    workspaceRoot: root,
    stateDir,
    featureFlags: { capabilities: true, counterfactual: false, capsules: false }
  });
  let requests = 0;
  const registry = createRuntimeRegistry({
    workspaceRoot: root,
    stateDir,
    config: {
      plugins: { entries: { discord: { enabled: true, config: { accounts: {
        home: { enabled: true, tokenEnv: "ODINN_TEST_DISCORD_TOKEN" },
        other: { enabled: true, tokenEnv: "ODINN_TEST_DISCORD_OTHER" }
      } } } } },
      runLedger: runtime.ledger
    },
    auditStore,
    discordFetch: async () => {
      requests += 1;
      return new Response(JSON.stringify([]), { status: 200 });
    }
  });
  try {
    const runId = "discord-resource-preauth";
    runtime.ledger.ensureRun({ runId, objective: "authorize before credential lookup" });
    const issued = runtime.capabilities.issue({
      runId,
      stepId: "discord-read",
      toolName: "discord.readMessages",
      resourceConstraints: { accountId: "home", channelId: "123" }
    });
    await assert.rejects(
      runTask({
        task: {
          id: runId,
          tool: "discord.readMessages",
          input: { accountId: "other", channelId: "123", capabilityToken: issued.token }
        },
        auditStore,
        policy: createDefaultPolicy({ allowedCapabilities: ["network.access"] }),
        registry,
        runLedger: runtime.ledger
      }),
      (error: any) => error.code === "CAPABILITY_SCOPE_MISMATCH"
    );
    const unknownRunId = "discord-resource-preauth-unknown";
    runtime.ledger.ensureRun({ runId: unknownRunId, objective: "authorize before account lookup" });
    const unknownIssued = runtime.capabilities.issue({
      runId: unknownRunId,
      stepId: "discord-read",
      toolName: "discord.readMessages",
      resourceConstraints: { accountId: "home", channelId: "123" }
    });
    await assert.rejects(
      runTask({
        task: {
          id: unknownRunId,
          tool: "discord.readMessages",
          input: { accountId: "not-configured", channelId: "123", capabilityToken: unknownIssued.token }
        },
        auditStore,
        policy: createDefaultPolicy({ allowedCapabilities: ["network.access"] }),
        registry,
        runLedger: runtime.ledger
      }),
      (error: any) => error.code === "CAPABILITY_SCOPE_MISMATCH"
    );
    assert.equal(requests, 0);
  } finally {
    registry.close();
    auditStore.close();
    runtime.ledger.close();
    await rm(root, { recursive: true, force: true });
    if (original === undefined) delete process.env.ODINN_TEST_DISCORD_TOKEN;
    else process.env.ODINN_TEST_DISCORD_TOKEN = original;
    if (originalOther === undefined) delete process.env.ODINN_TEST_DISCORD_OTHER;
    else process.env.ODINN_TEST_DISCORD_OTHER = originalOther;
  }
});

test("forked runtime workers reconstruct Discord tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-discord-worker-composition-"));
  const stateDir = join(root, ".odinn");
  await mkdir(stateDir, { recursive: true });
  const executor = createRuntimeIsolatedTaskExecutor({
    stateDir,
    workspaceRoot: root,
    config: { plugins: { entries: { discord: { enabled: true, config: { accounts: {} } } } } },
    policy: createDefaultPolicy()
  });
  try {
    await assert.rejects(
      executor({
        task: {
          id: "discord-worker-registration",
          tool: "discord.readMessages",
          input: { channelId: "123" },
          actor: "test"
        }
      }),
      /no enabled Discord account is configured/
    );
  } finally {
    await executor.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
