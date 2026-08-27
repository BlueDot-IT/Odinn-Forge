import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EMAIL_READ_PLUGIN_MANIFEST,
  createApprovalStore,
  createBuiltInRegistry,
  emailReadHostCapabilityPlugin,
  materializeHostCapabilityPlugin
} from "../packages/kernel/src/index.ts";
import { createDefaultPolicy, evaluateTaskPolicy } from "../packages/policy/src/index.ts";
import { durableEmailProviderIdentifier, hashEmailProviderIdentifier, projectDurableToolInput, projectDurableToolOutput } from "../packages/protocol/src/index.ts";

const target = Object.freeze({ providerId: "gmail", generation: "oauth-1" });
const message = Object.freeze({
  accountId: "account-1",
  messageId: "message-1",
  threadId: "thread-1",
  subject: "Quarterly credentials rotation",
  from: "security@example.test",
  receivedAt: "2026-08-14T12:00:00.000Z",
  snippet: "This is external mail content.",
  hasAttachments: true,
  to: ["operator@example.test"],
  cc: [],
  bodyText: "Untrusted message body with a token=do-not-persist value.",
  attachments: [{ name: "report.txt", mimeType: "text/plain", sizeBytes: 42 }]
});

function provider(overrides: Record<string, unknown> = {}) {
  return {
    target,
    health: async () => ({ status: "ready" as const, checkedAt: "2026-08-14T12:00:00.000Z" }),
    accounts: async () => [{ accountId: "account-1", address: "operator@example.test", displayName: "Operator", provider: "gmail", status: "ready" as const }],
    search: async (request: { accountId: string; query: string; limit: number; cursor?: string }) => ({
      accountId: request.accountId,
      messages: [{
        accountId: message.accountId,
        messageId: message.messageId,
        threadId: message.threadId,
        subject: message.subject,
        from: message.from,
        receivedAt: message.receivedAt,
        snippet: message.snippet,
        hasAttachments: message.hasAttachments
      }],
      nextCursor: "cursor-2"
    }),
    read: async () => message,
    thread: async (request: { accountId: string; threadId: string; limit: number }) => ({
      accountId: request.accountId,
      threadId: request.threadId,
      messages: [message]
    }),
    ...overrides
  };
}

function context(emailReadProvider: ReturnType<typeof provider>) {
  return { stateDir: "/tmp/odinn-email-test", approvalStore: createApprovalStore(), emailReadProvider };
}

test("email read tools are bounded, account-scoped, and redact durable content", async () => {
  const tools = materializeHostCapabilityPlugin(emailReadHostCapabilityPlugin, context(provider()));
  assert.deepEqual([...tools.keys()], ["email.accounts", "email.search", "email.read", "email.thread"]);
  const accounts = await tools.get("email.accounts")?.execute({}, { signal: undefined });
  assert.equal(accounts.contentTrust, "operator-configured-metadata");
  assert.equal(accounts.accounts[0].address, "operator@example.test");

  const search = await tools.get("email.search")?.execute({ accountId: "account-1", query: "quarterly" }, { signal: undefined });
  assert.equal(search.contentTrust, "external-untrusted");
  assert.equal(search.messages[0].subject, message.subject);
  const read = await tools.get("email.read")?.execute({ accountId: "account-1", messageId: "message-1" }, { signal: undefined });
  assert.equal(read.bodyText, message.bodyText);
  const thread = await tools.get("email.thread")?.execute({ accountId: "account-1", threadId: "thread-1" }, { signal: undefined });
  assert.equal(thread.messages.length, 1);

  const durableInput = projectDurableToolInput("email.search", { accountId: "account-1", query: "private search phrase", limit: 20 });
  const projectedInput = durableInput as Record<string, any>;
  assert.equal("query" in projectedInput, false);
  assert.match(projectedInput.queryDigest, /^sha256:/u);
  const durableOutput = projectDurableToolOutput("email.read", read) as Record<string, any>;
  const serialized = JSON.stringify(durableOutput);
  const durableAccounts = projectDurableToolOutput("email.accounts", accounts) as Record<string, any>;
  assert.equal(durableOutput.contentUnavailableOnReplay, true);
  assert.match(durableOutput.targetDigest, /^sha256:/u);
  assert.match(durableOutput.payloadDigest, /^sha256:/u);
  assert.equal(typeof durableOutput.payloadBytes, "number");
  assert.equal("bodyText" in durableOutput, false);
  assert.equal("subject" in durableOutput, false);
  assert.equal("from" in durableOutput, false);
  assert.equal(serialized.includes("do-not-persist"), false);
  assert.equal(serialized.includes("operator@example.test"), false);
  assert.equal(JSON.stringify(durableAccounts).includes("operator@example.test"), false);
});

test("email read resources bind provider generation and account identity", async () => {
  const tools = materializeHostCapabilityPlugin(emailReadHostCapabilityPlugin, context(provider()));
  assert.deepEqual(tools.get("email.search")?.resourceForInput({ accountId: "account-1" }), {
    providerDigest: hashEmailProviderIdentifier(target.providerId, "email provider target.providerId", 128),
    generationDigest: hashEmailProviderIdentifier(target.generation, "email provider target.generation", 128),
    accountDigest: hashEmailProviderIdentifier("account-1")
  });
  const piiResource = tools.get("email.search")?.resourceForInput?.({ accountId: "operator@example.test" });
  assert.equal(piiResource?.accountDigest, hashEmailProviderIdentifier("operator@example.test"));
  assert.throws(
    () => tools.get("email.search")?.resourceForInput({ accountId: "unsafe\u0000identifier" }),
    /bounded visible provider identifier/u
  );
  await assert.rejects(
    () => tools.get("email.search")?.execute({ accountId: "account-1", query: "" }, { signal: undefined }),
    /query must not be empty/u
  );
  await assert.rejects(
    () => materializeHostCapabilityPlugin(emailReadHostCapabilityPlugin, context(provider({
      read: async () => ({ ...message, accountId: "account-2" })
    }))).get("email.read")?.execute({ accountId: "account-1", messageId: "message-1" }, { signal: undefined }),
    /does not match the requested account/u
  );
});

test("email provider target rotation is rejected and close revokes the seam", async () => {
  let currentTarget = target;
  const rotatingProvider = {
    ...provider(),
    get target() {
      return currentTarget;
    },
    search: async (request: { accountId: string; query: string; limit: number }) => {
      currentTarget = { ...target, generation: "oauth-2" };
      return { accountId: request.accountId, messages: [message] };
    }
  };
  const tools = materializeHostCapabilityPlugin(emailReadHostCapabilityPlugin, context(rotatingProvider));
  await assert.rejects(
    () => tools.get("email.search")?.execute({ accountId: "account-1", query: "x" }, { signal: undefined }),
    /target changed/u
  );

  const root = await mkdtemp(join(tmpdir(), "odinn-email-"));
  let closed = false;
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir: join(root, ".odinn"),
    enableEmail: true,
    emailReadProvider: { ...provider(), close: () => { closed = true; } }
  });
  try {
    const tool = registry.get("email.read");
    assert.equal(typeof tool?.execute, "function");
    assert.equal(evaluateTaskPolicy({ policy: createDefaultPolicy(), request: { tool: "email.read", input: { accountId: "account-1", messageId: "message-1" } }, tool }).allowed, false);
    assert.equal(evaluateTaskPolicy({ policy: createDefaultPolicy({ allowedCapabilities: ["email.read", "network.access"] }), request: { tool: "email.read", input: { accountId: "account-1", messageId: "message-1" } }, tool }).allowed, false);
    assert.equal(evaluateTaskPolicy({ policy: createDefaultPolicy({ allowedCapabilities: ["email.read", "network.access", "secret.reference.use"] }), request: { tool: "email.read", input: { accountId: "account-1", messageId: "message-1" } }, tool }).allowed, true);
    assert.deepEqual(EMAIL_READ_PLUGIN_MANIFEST.tools.map((entry) => entry.name), ["email.accounts", "email.search", "email.read", "email.thread"]);
    registry.close();
    assert.equal(closed, true);
    await assert.rejects(() => tool.execute({ accountId: "account-1", messageId: "message-1" }, { signal: undefined }), /provider is closed/u);
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("email durable projections hash provider identifiers and reject unsafe values", () => {
  const accountId = "operator@example.test";
  const messageId = "operator@example.test/message/123";
  const threadId = "operator@example.test/thread/456";
  const input = projectDurableToolInput("email.read", { accountId, messageId }) as Record<string, any>;
  const output = projectDurableToolOutput("email.thread", {
    type: "email.thread",
    providerId: "provider-for-operator@example.test",
    accountId,
    threadId,
    messages: [{ messageId, threadId, receivedAt: "2026-08-14T12:00:00.000Z" }]
  }) as Record<string, any>;
  const accounts = projectDurableToolOutput("email.accounts", {
    type: "email.accounts",
    providerId: "provider-for-operator@example.test",
    accounts: [{ accountId, provider: "gmail", status: "ready" }]
  }) as Record<string, any>;

  assert.deepEqual(Object.keys(input), ["targetDigest"]);
  assert.match(input.targetDigest, /^sha256:/u);
  assert.match(output.targetDigest, /^sha256:/u);
  assert.match(output.payloadDigest, /^sha256:/u);
  assert.equal(output.messageCount, 1);
  assert.match(accounts.targetDigest, /^sha256:/u);
  assert.equal(accounts.accountCount, 1);
  assert.doesNotMatch(JSON.stringify({ input, output, accounts }), /operator@example\.test/u);
  assert.equal(durableEmailProviderIdentifier("account-1"), "account-1");
  assert.equal(durableEmailProviderIdentifier("message-1"), "message-1");

  assert.throws(
    () => projectDurableToolInput("email.read", { accountId: "unsafe\u0000identifier", messageId }),
    /bounded visible provider identifier/u
  );
  assert.throws(
    () => projectDurableToolOutput("email.read", {
      type: "email.read",
      providerId: "gmail",
      accountId,
      messageId: 42,
      threadId
    }),
    /email email\.read output\.messageId must be a bounded visible provider identifier/u
  );
});
