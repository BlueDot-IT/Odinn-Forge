import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  digestExtensionBundle,
  ExtensionExecutor,
  ExtensionRegistry,
  resolveConfiguredOciBackend,
  validateOciImageReference
} from "../packages/kernel/src/extensions.ts";
import { SandboxBackendRefusalError } from "../packages/kernel/src/sandbox-backend.ts";
import { normalizeSandboxConfig } from "../packages/kernel/src/sandbox-config.ts";
import { createAuditStore, createDifferentiatedRuntime } from "../packages/kernel/src/index.ts";
import { createDefaultPolicy } from "../packages/policy/src/index.ts";

const digest = (source: string) => createHash("sha256").update(source).digest("hex");
const PINNED_IMAGE = `ghcr.io/bluedot-it/odinn-extension:1.2.3@sha256:${"a".repeat(64)}`;
const unsafeExecutorOptions = (root: string) => ({ workspaceRoot: root, defaultTimeoutMs: 2_000, config: { runtime: { allowUnconfinedProcessExec: true } } });
const invocationOptions = <T extends Record<string, unknown>>(options: T) => options;

function auditedExtensionRuntime(root: any, name: any) {
  const stateDir = join(root, `.odinn-${name}`);
  const differentiated = createDifferentiatedRuntime({ stateDir, workspaceRoot: root });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  return {
    differentiated,
    value: { runId: `run-${name}`, runLedger: differentiated.ledger, auditStore, policy: createDefaultPolicy(), workspaceRoot: root }
  };
}

test("extension manifests are disabled, grant-scoped, provenance-aware, and rollbackable", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-extensions-"));
  const registry = new ExtensionRegistry(join(root, "extensions.json"));
  const installed = await registry.install({
    id: "example-tool",
    version: "1.0.0",
    type: "mcp",
    entrypoint: "node server.ts",
    capabilities: ["web.read"],
    sandbox: "unconfined-process",
    contentDigest: "a".repeat(64)
  });
  assert.equal(installed.enabled, false);
  await assert.rejects(() => registry.enable("example-tool", { grants: ["web.read"] }), /untrusted/);
  await assert.rejects(() => registry.enable("example-tool", { grants: ["web.read"], trust: true }), /explicit unsafe-sandbox acknowledgement/);
  const enabled = await registry.enable("example-tool", { grants: ["web.read"], trust: true, allowUnsafeSandbox: true });
  assert.equal(enabled.enabled, true);
  assert.deepEqual(enabled.grants, ["web.read"]);
  await registry.install({ id: "example-tool", version: "1.1.0", type: "mcp", capabilities: ["web.read"], sandbox: "unconfined-process", contentDigest: "b".repeat(64) });
  const rolledBack = await registry.rollback("example-tool");
  assert.equal(rolledBack.version, "1.0.0");
  assert.equal(rolledBack.enabled, false);
  assert.equal(rolledBack.trusted, false);
});

test("container extensions bind integrity to the complete immutable bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-extension-bundle-"));
  const bundle = join(root, "bundle");
  await mkdir(bundle);
  await writeFile(join(bundle, "main.ts"), "import './support.ts';\n");
  await writeFile(join(bundle, "support.ts"), "export const value = 1;\n");
  const bundleDigest = await digestExtensionBundle(bundle);
  const registry = new ExtensionRegistry(join(root, "extensions.json"));
  await registry.install({ id: "container-tool", version: "1.0.0", type: "tool", entrypoint: "bundle/main.ts", bundleRoot: "bundle", capabilities: ["text.echo"], sandbox: "container", bundleDigest, containerImage: PINNED_IMAGE });
  const enabled = await registry.enable("container-tool", { grants: ["text.echo"], trust: true });
  assert.equal(enabled.integrity, "bundle-verified");
  await writeFile(join(bundle, "support.ts"), "export const value = 2;\n");
  const runtime = auditedExtensionRuntime(root, "bundle");
  try {
    await assert.rejects(() => new ExtensionExecutor(registry, { workspaceRoot: root }).invoke("container-tool", {}, { runtime: runtime.value }), /bundle integrity check failed/);
  } finally { runtime.differentiated.ledger.close(); }
});

test("container execution honors process disablement and ordered rootless backend preference", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-extension-disabled-"));
  const registry = new ExtensionRegistry(join(root, "extensions.json"));
  await registry.install({ id: "disabled-tool", version: "1.0.0", type: "tool", entrypoint: "missing.ts", capabilities: ["text.echo"], sandbox: "container", bundleDigest: "a".repeat(64), containerImage: PINNED_IMAGE });
  await registry.enable("disabled-tool", { grants: ["text.echo"], trust: true });
  const executor = new ExtensionExecutor(registry, { workspaceRoot: root, config: { sandbox: { process: { enabled: false, shell: false } } } });
  await assert.rejects(() => executor.invoke("disabled-tool", {}), /disabled by config\.sandbox\.process\.enabled/u);

  const requirements: string[] = [];
  const rootlessOnly = normalizeSandboxConfig({ sandbox: { backend: { mode: "auto", preference: ["rootless-oci"], unavailable: "refuse" } } });
  await assert.rejects(
    () => resolveConfiguredOciBackend(rootlessOnly, async (_selection, _runner, options) => {
      requirements.push(options.rootless!);
      throw new SandboxBackendRefusalError("unavailable", "SANDBOX_BACKEND_UNAVAILABLE");
    }),
    /unavailable/u
  );
  assert.deepEqual(requirements, ["required"]);
});

test("container images reject option injection, controls, whitespace, and malformed OCI references", async () => {
  assert.equal(
    validateOciImageReference(`registry.example.com/team/tool@sha256:${"a".repeat(64)}`),
    `registry.example.com/team/tool@sha256:${"a".repeat(64)}`
  );
  for (const image of [
    "--privileged",
    "node:24-alpine --privileged",
    "node:24-alpine\n--privileged",
    "node:24-alpine\u0000--privileged",
    "UPPERCASE/repository:latest",
    "registry.example.com:70000/team/tool:latest",
    "registry.example.com/team//tool:latest"
  ]) {
    assert.throws(() => validateOciImageReference(image), /digest-pinned OCI image reference/);
  }

  const root = await mkdtemp(join(tmpdir(), "odinn-extension-image-"));
  const registry = new ExtensionRegistry(join(root, "extensions.json"));
  await assert.rejects(
    () => registry.install({
      id: "bad-image",
      version: "1.0.0",
      type: "tool",
      capabilities: [],
      sandbox: "container",
      containerImage: "--privileged"
    }),
    /digest-pinned OCI image reference/
  );
});

test("extensions require content integrity and bound non-terminated output", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-extension-limits-"));
  const registry = new ExtensionRegistry(join(root, "extensions.json"));
  await registry.install({ id: "missing-digest", version: "1.0.0", type: "tool", entrypoint: "missing.ts", capabilities: ["text.echo"], sandbox: "unconfined-process" });
  await assert.rejects(() => registry.enable("missing-digest", { grants: ["text.echo"], trust: true, allowUnsafeSandbox: true }), /requires a full SHA-256 contentDigest/);

  const source = `process.stdout.write("A".repeat(1_000_001)); setInterval(() => {}, 1_000);\n`;
  await writeFile(join(root, "flood.ts"), source);
  await registry.install({ id: "output-flood", version: "1.0.0", type: "tool", entrypoint: "flood.ts", capabilities: ["text.echo"], sandbox: "unconfined-process", contentDigest: digest(source) });
  await registry.enable("output-flood", { grants: ["text.echo"], trust: true, allowUnsafeSandbox: true });
  const runtime = auditedExtensionRuntime(root, "output-flood");
  try {
    await assert.rejects(() => new ExtensionExecutor(registry, unsafeExecutorOptions(root)).invoke("output-flood", {}, invocationOptions({ runtime: runtime.value })), /unconfined extension execution is unavailable/u);
  } finally {
    runtime.differentiated.ledger.close();
  }
});

test("trusted process extensions remain inactive until the host-approved backend exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-extension-runtime-"));
  const entrypoint = join(root, "tool.ts");
  const extensionSource = `process.stdin.setEncoding("utf8"); let raw=""; process.stdin.on("data", c => raw += c).on("end", () => { const request = JSON.parse(raw); process.stdout.write(JSON.stringify({ result: { echoed: request.input.text, capability: request.capability, inheritedSecret: process.env.ODINN_EXTENSION_TEST_SECRET } }) + "\\n"); });\n`;
  await writeFile(entrypoint, extensionSource);
  const registry = new ExtensionRegistry(join(root, "extensions.json"));
  await registry.install({ id: "process-tool", version: "1.0.0", type: "tool", entrypoint: "tool.ts", capabilities: ["text.echo"], sandbox: "unconfined-process", contentDigest: digest(extensionSource) });
  const executor = new ExtensionExecutor(registry, unsafeExecutorOptions(root));
  await assert.rejects(() => executor.invoke("process-tool", { text: "blocked" }), /not enabled and trusted/);
  await registry.enable("process-tool", { grants: ["text.echo"], trust: true, allowUnsafeSandbox: true });
  await assert.rejects(() => executor.invoke("process-tool", { text: "bypass" }), /unconfined extension execution is unavailable/u);
  const runtime = auditedExtensionRuntime(root, "process");
  await assert.rejects(() => executor.invoke("process-tool", { text: "ODINN_EXTENSION_OK" }, invocationOptions({ runtime: runtime.value })), /unconfined extension execution is unavailable/u);
  runtime.differentiated.ledger.close();
});

test("inactive unconfined extensions never reach snapshot execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-extension-snapshot-"));
  const bundle = join(root, "bundle");
  await mkdir(bundle);
  const entrypointSource = `process.stdin.resume(); setTimeout(async () => { const payload = await import("./payload.ts"); process.stdout.write(JSON.stringify({ result: { value: payload.value } }) + "\\n"); }, 150);\n`;
  await writeFile(join(bundle, "tool.ts"), entrypointSource);
  await writeFile(join(bundle, "payload.ts"), 'export const value = "verified";\n');
  const registry = new ExtensionRegistry(join(root, "extensions.json"));
  await registry.install({
    id: "snapshot-tool",
    version: "1.0.0",
    type: "tool",
    entrypoint: "bundle/tool.ts",
    bundleRoot: "bundle",
    capabilities: ["text.echo"],
    sandbox: "unconfined-process",
    contentDigest: digest(entrypointSource)
  });
  await registry.enable("snapshot-tool", { grants: ["text.echo"], trust: true, allowUnsafeSandbox: true });
  const runtime = auditedExtensionRuntime(root, "snapshot");
  try {
    await assert.rejects(
      new ExtensionExecutor(registry, unsafeExecutorOptions(root)).invoke("snapshot-tool", {}, invocationOptions({ runtime: runtime.value })),
      /unconfined extension execution is unavailable/u
    );
  } finally {
    runtime.differentiated.ledger.close();
  }
});

test("inactive unconfined extensions cannot execute symlinked dependencies", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-extension-symlink-snapshot-"));
  const bundle = join(root, "bundle");
  const executionMarker = join(root, "external-code-ran");
  const externalDependency = join(root, "mutable-payload.ts");
  await mkdir(bundle);
  const entrypointSource = `process.stdin.resume(); const payload = await import("./payload.ts"); process.stdout.write(JSON.stringify({ result: { value: payload.value } }) + "\\n");\n`;
  await writeFile(join(bundle, "tool.ts"), entrypointSource);
  await writeFile(externalDependency, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(executionMarker)}, "executed"); export const value = "external";\n`);
  await symlink(externalDependency, join(bundle, "payload.ts"), "file");
  const registry = new ExtensionRegistry(join(root, "extensions.json"));
  await registry.install({
    id: "symlink-snapshot-tool",
    version: "1.0.0",
    type: "tool",
    entrypoint: "bundle/tool.ts",
    bundleRoot: "bundle",
    capabilities: ["text.echo"],
    sandbox: "unconfined-process",
    contentDigest: digest(entrypointSource)
  });
  await registry.enable("symlink-snapshot-tool", { grants: ["text.echo"], trust: true, allowUnsafeSandbox: true });
  const runtime = auditedExtensionRuntime(root, "symlink-snapshot");
  try {
    await assert.rejects(
      () => new ExtensionExecutor(registry, unsafeExecutorOptions(root))
        .invoke("symlink-snapshot-tool", {}, invocationOptions({ runtime: runtime.value })),
      /unconfined extension execution is unavailable/u
    );
    await assert.rejects(access(executionMarker), { code: "ENOENT" });
  } finally {
    runtime.differentiated.ledger.close();
  }
});

test("unconfined MCP manifests remain inactive until the host-approved backend exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-mcp-runtime-"));
  const entrypoint = join(root, "mcp.ts");
  const extensionSource = `process.stdin.setEncoding("utf8"); let raw=""; process.stdin.on("data", c => raw += c).on("end", () => { const request = JSON.parse(raw); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "ODINN_MCP_OK" }] } }) + "\\n"); });\n`;
  await writeFile(entrypoint, extensionSource);
  const registry = new ExtensionRegistry(join(root, "extensions.json"));
  await registry.install({ id: "mcp-tool", version: "1.0.0", type: "mcp", entrypoint: "mcp.ts", capabilities: ["mcp.call"], sandbox: "unconfined-process", contentDigest: digest(extensionSource) });
  await registry.enable("mcp-tool", { grants: ["mcp.call"], trust: true, allowUnsafeSandbox: true });
  const executor = new ExtensionExecutor(registry, unsafeExecutorOptions(root));
  const runtime = auditedExtensionRuntime(root, "mcp");
  await assert.rejects(
    executor.invoke("mcp-tool", { name: "fixture", arguments: {} }, invocationOptions({ capability: "mcp.call", runtime: runtime.value })),
    /unconfined extension execution is unavailable/u
  );
  runtime.differentiated.ledger.close();
});

test("host execution config and capability tokens cannot reactivate unconfined extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-extension-guarded-"));
  const entrypoint = join(root, "tool.ts");
  const extensionSource = 'process.stdin.setEncoding("utf8"); let raw=""; process.stdin.on("data", c => raw += c).on("end", () => { const request = JSON.parse(raw); process.stdout.write(JSON.stringify({ result: { echoed: request.input.text } }) + "\\n"); });\n';
  await writeFile(entrypoint, extensionSource);
  const registry = new ExtensionRegistry(join(root, "extensions.json"));
  await registry.install({ id: "guarded-tool", version: "1.0.0", type: "tool", entrypoint: "tool.ts", capabilities: ["text.echo"], sandbox: "unconfined-process", contentDigest: digest(extensionSource) });
  await registry.enable("guarded-tool", { grants: ["text.echo"], trust: true, allowUnsafeSandbox: true });
  const stateDir = join(root, ".odinn");
  const runtime = createDifferentiatedRuntime({ stateDir, workspaceRoot: root, featureFlags: { capabilities: true } });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  const executor = new ExtensionExecutor(registry, unsafeExecutorOptions(root));
  const runId = "extension-guarded-run";
  await assert.rejects(() => executor.invoke("guarded-tool", { text: "blocked" }, invocationOptions({ capability: "text.echo", runtime: { runId, runLedger: runtime.ledger, auditStore, policy: createDefaultPolicy(), workspaceRoot: root } })), /unconfined extension execution is unavailable/u);
  await assert.rejects(
    executor.invoke("guarded-tool", { text: "ODINN_EXTENSION_GUARDED_OK" }, invocationOptions({ capability: "text.echo", capabilityToken: "forged-token-cannot-reactivate-host-execution", runtime: { runId, runLedger: runtime.ledger, auditStore, policy: createDefaultPolicy(), workspaceRoot: root } })),
    /unconfined extension execution is unavailable/u
  );
  runtime.ledger.close();
});
