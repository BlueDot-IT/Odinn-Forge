import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  assessProviderCompatibility,
  createProviderCapabilityMetadata,
  PROVIDER_CAPABILITY_IDS,
  PROVIDER_CAPABILITY_SCHEMA_VERSION
} from "../packages/kernel/src/provider-capabilities.ts";

test("HTTP capability metadata distinguishes adapter support from unknown provider support", () => {
  const metadata = createProviderCapabilityMetadata({
    providerId: "openai",
    modelId: "gpt-example",
    transport: "openai-responses"
  });
  assert.equal(metadata.schemaVersion, PROVIDER_CAPABILITY_SCHEMA_VERSION);
  assert.equal(metadata.capabilities["text-generation"].transportStatus, "supported");
  assert.equal(metadata.capabilities["text-generation"].providerStatus, "unknown");
  assert.equal(metadata.capabilities["text-generation"].status, "unknown");
  assert.equal(metadata.capabilities.streaming.transportStatus, "unsupported");
  assert.equal(metadata.capabilities.streaming.status, "unsupported");
  assert.equal(metadata.capabilities["tool-calling"].status, "unknown");
  assert.equal(metadata.capabilities["image-input"].status, "unsupported");
  assert.equal(Object.isFrozen(metadata), true);
  assert.equal(Object.isFrozen(metadata.capabilities), true);
  assert.equal(Object.isFrozen(metadata.capabilities.streaming), true);
});

test("each HTTP transport reports its actual streaming contract", () => {
  const chat = createProviderCapabilityMetadata({
    providerId: "chat",
    transport: "openai-chat-completions"
  });
  const responses = createProviderCapabilityMetadata({
    providerId: "responses",
    transport: "openai-responses"
  });
  const chatGpt = createProviderCapabilityMetadata({
    providerId: "chatgpt",
    transport: "openai-chatgpt-responses"
  });
  assert.equal(chat.capabilities.streaming.transportStatus, "supported");
  assert.equal(responses.capabilities.streaming.transportStatus, "unsupported");
  assert.equal(chatGpt.capabilities.streaming.transportStatus, "supported");
});

test("CLI metadata records the narrower transport contract", () => {
  const metadata = createProviderCapabilityMetadata({
    providerId: "antigravity",
    transport: "cli-antigravity"
  });
  assert.equal(metadata.capabilities["text-generation"].transportStatus, "supported");
  assert.equal(metadata.capabilities["text-generation"].status, "unknown");
  for (const capability of PROVIDER_CAPABILITY_IDS.filter((item) => item !== "text-generation")) {
    assert.equal(metadata.capabilities[capability].status, "unsupported");
  }
});

test("explicit bounded claims can resolve unknown support", () => {
  const metadata = createProviderCapabilityMetadata({
    providerId: "openrouter",
    modelId: "vendor/model",
    transport: "openai-chat-completions",
    claims: [{
      capability: "text-generation",
      status: "supported",
      source: "operator-configured"
    }, {
      capability: "tool-calling",
      status: "supported",
      source: "operator-configured",
      note: "Verified for this exact configured model."
    }]
  });
  assert.deepEqual(
    assessProviderCompatibility(metadata, ["text-generation", "tool-calling"]),
    {
      status: "compatible",
      providerId: "openrouter",
      modelId: "vendor/model",
      required: ["text-generation", "tool-calling"],
      unsupported: [],
      unknown: []
    }
  );
});

test("compatibility assessment fails closed for unknown and unsupported capabilities", () => {
  const metadata = createProviderCapabilityMetadata({
    providerId: "compatible-endpoint",
    transport: "openai-chat-completions"
  });
  assert.equal(assessProviderCompatibility(metadata, ["text-generation"]).status, "unknown");
  assert.deepEqual(
    assessProviderCompatibility(metadata, ["image-input", "text-generation"]),
    {
      status: "incompatible",
      providerId: "compatible-endpoint",
      required: ["image-input", "text-generation"],
      unsupported: ["image-input"],
      unknown: ["text-generation"]
    }
  );
});

test("runtime observations require valid timestamps and remain explicit evidence", () => {
  const now = Date.parse("2026-07-29T12:00:00.000Z");
  const metadata = createProviderCapabilityMetadata({
    providerId: "local",
    modelId: "model",
    transport: "openai-chat-completions",
    now,
    claims: [{
      capability: "tool-calling",
      status: "supported",
      source: "runtime-observed",
      observedAt: "2026-07-29T12:00:00.000Z"
    }]
  });
  assert.equal(metadata.capabilities["tool-calling"].source, "runtime-observed");
  assert.equal(metadata.capabilities["tool-calling"].observedAt, "2026-07-29T12:00:00.000Z");
  assert.throws(
    () => createProviderCapabilityMetadata({
      providerId: "local",
      modelId: "model",
      transport: "openai-chat-completions",
      now,
      claims: [{ capability: "tool-calling", status: "supported", source: "runtime-observed" }]
    }),
    /require observedAt/u
  );
  assert.throws(
    () => createProviderCapabilityMetadata({
      providerId: "local",
      modelId: "model",
      transport: "openai-chat-completions",
      now,
      claims: [{
        capability: "tool-calling",
        status: "supported",
        source: "operator-configured",
        observedAt: "2026-07-29T12:00:00.000Z"
      }]
    }),
    /only runtime-observed/u
  );
  assert.throws(
    () => createProviderCapabilityMetadata({
      providerId: "local",
      modelId: "model",
      transport: "openai-chat-completions",
      now,
      claims: [{
        capability: "tool-calling",
        status: "supported",
        source: "runtime-observed",
        observedAt: "2026-07-29T12:01:00.001Z"
      }]
    }),
    /future-skew limit/u
  );
});

test("metadata validation rejects ambiguity, unbounded input, and impossible overrides", () => {
  assert.throws(
    () => createProviderCapabilityMetadata({
      providerId: "local",
      modelId: "model",
      transport: "cli-antigravity",
      claims: [{ capability: "streaming", status: "supported", source: "operator-configured" }]
    }),
    /unsupported by transport/u
  );
  assert.throws(
    () => createProviderCapabilityMetadata({
      providerId: "local",
      modelId: "model",
      transport: "openai-chat-completions",
      claims: [
        { capability: "tool-calling", status: "supported", source: "operator-configured" },
        { capability: "tool-calling", status: "unsupported", source: "operator-configured" }
      ]
    }),
    /duplicate capability claim/u
  );
  assert.throws(
    () => assessProviderCompatibility(
      createProviderCapabilityMetadata({ providerId: "local", transport: "openai-chat-completions" }),
      ["streaming", "streaming"]
    ),
    /duplicate provider capability requirement/u
  );
  assert.throws(
    () => createProviderCapabilityMetadata({
      providerId: "x".repeat(129),
      transport: "openai-chat-completions"
    }),
    /exceeds 128/u
  );
  assert.throws(
    () => createProviderCapabilityMetadata({
      providerId: "local",
      transport: "openai-chat-completions",
      claims: [{ capability: "text-generation", status: "supported", source: "operator-configured" }]
    }),
    /require an exact modelId/u
  );
  assert.throws(
    () => createProviderCapabilityMetadata({
      providerId: "local",
      transport: "openai-chat-completions",
      hiddenFallback: "other-provider"
    } as any),
    /unknown field: hiddenFallback/u
  );
});

test("exported identifiers and nested metadata resist consumer mutation", () => {
  const metadata = createProviderCapabilityMetadata({
    providerId: "local",
    modelId: "model",
    transport: "openai-chat-completions",
    claims: [{ capability: "text-generation", status: "supported", source: "operator-configured" }]
  });
  assert.equal(Object.isFrozen(PROVIDER_CAPABILITY_IDS), true);
  assert.throws(() => (PROVIDER_CAPABILITY_IDS as any).push("hidden-capability"), TypeError);
  assert.throws(() => {
    (metadata.capabilities["text-generation"] as any).status = "unsupported";
  }, TypeError);
  assert.equal(metadata.capabilities["text-generation"].status, "supported");
  assert.deepEqual([...PROVIDER_CAPABILITY_IDS], [
    "text-generation",
    "streaming",
    "tool-calling",
    "structured-output",
    "image-input",
    "audio-input",
    "embeddings"
  ]);
});

test("provider capability metadata is demand-loaded and absent from active imports", async () => {
  const root = join(import.meta.dirname, "..");
  const packageJson = JSON.parse(await readFile(join(root, "packages/kernel/package.json"), "utf8"));
  assert.equal(packageJson.exports["./provider-capabilities"], "./src/provider-capabilities.ts");
  for (const path of [
    "packages/kernel/src/index.ts",
    "packages/kernel/src/providers/runtime.ts",
    "packages/kernel/src/providers/registry.ts",
    "apps/cli/src/cli.ts",
    "apps/gateway/src/server.ts"
  ]) {
    const source = await readFile(join(root, path), "utf8");
    assert.doesNotMatch(source, /provider-capabilities/u, `${path} must not import the optional metadata module`);
  }
  const packageConsumer = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", "import('@odinn/kernel/provider-capabilities').then((value) => { if (value.PROVIDER_CAPABILITY_SCHEMA_VERSION !== 1) process.exit(2); })"],
    { cwd: join(root, "apps/cli"), encoding: "utf8" }
  );
  assert.equal(packageConsumer.status, 0, packageConsumer.stderr || packageConsumer.stdout);
});
