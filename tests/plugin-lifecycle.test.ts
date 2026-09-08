import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digestExtensionBundle, extensionIdentityFingerprint } from "../packages/kernel/src/extensions.ts";
import { PluginLifecycleService, type PluginLifecycleOptions } from "../packages/kernel/src/plugin-lifecycle.ts";
import { PluginRegistry, type PluginRecord } from "../packages/kernel/src/plugin-registry.ts";
import { packPluginPackage } from "../packages/kernel/src/plugin-packages.ts";

const IMAGE = `node@sha256:${"a".repeat(64)}`;
const READY_CONFIG = { runtime: { enableMcp: true }, sandbox: { process: { enabled: true } } };
const GRANTS = ["mcp.discover", "mcp.invoke", "network.access"];
const readyProbe = async () => ({ ok: true, imageAvailable: true, detail: "mocked compatible OCI engine; execution is verified separately" });
const identity = (record: PluginRecord) => ({ expectedIdentityFingerprint: record.identityFingerprint });

function manifest(overrides: Record<string, unknown> = {}) {
  const credential = Array.isArray(overrides.secrets) && overrides.secrets.length > 0;
  return {
    schemaVersion: 1, sdkVersion: "1.0", id: "fixture-plugin", version: "1.0.0", name: "Fixture plugin",
    description: "A package lifecycle verification fixture.", kind: "connector", runtime: "oci-mcp-stdio", transport: "mcp-jsonrpc-stdio",
    containerImage: IMAGE, entrypoint: "server.mjs",
    tools: [{ name: "fixture-plugin.read", description: "Read fixture status.", capabilities: ["network.access", ...(credential ? ["secret.reference.use"] : [])], inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false }, effects: ["read", "network", ...(credential ? ["credential"] : [])], requiresApproval: false, retrySafe: true }],
    services: [{ id: "fixture", origin: "https://api.example.test", paths: ["/status"], queryKeys: [] }],
    egress: { protocol: "https", hosts: ["api.example.test"], port: 443 }, secrets: [], ...overrides
  };
}

async function removeFixture(root: string) {
  async function writable(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    await chmod(path, info.isDirectory() ? 0o700 : 0o600);
    if (info.isDirectory()) for (const entry of await readdir(path)) await writable(join(path, entry));
  }
  await writable(root);
  await rm(root, { recursive: true, force: true });
}

async function fixture(t: test.TestContext, overrides: Partial<PluginLifecycleOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "odinn-plugin-lifecycle-"));
  t.after(() => removeFixture(root));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const stateDir = join(workspace, ".odinn");
  const events: Record<string, unknown>[] = [];
  const invalidated: string[] = [];
  const options: PluginLifecycleOptions = {
    workspaceRoot: workspace, stateDir, config: READY_CONFIG, auditStore: { append: async (event) => { events.push(event); } },
    probeRuntime: readyProbe, credentialAvailable: async () => false, onInvalidate: async (id) => { invalidated.push(id); }, ...overrides
  };
  const service = new PluginLifecycleService(options);
  async function archive(version = "1.0.0", extra: Record<string, unknown> = {}) {
    const source = join(root, `source-${version}-${Math.random().toString(16).slice(2)}`);
    await mkdir(source);
    await writeFile(join(source, "plugin.json"), JSON.stringify(manifest({ version, ...extra })));
    await writeFile(join(source, "server.mjs"), "// This fixture is not executed. OCI end-to-end evidence is separate.\n");
    await mkdir(join(source, "lib"));
    await writeFile(join(source, "lib", "support.mjs"), "export const fixture = true;\n");
    const path = `${source}.zip`;
    const packed = await packPluginPackage(source, path);
    return { source, path, packed };
  }
  return { root, workspace, stateDir, service, options, events, invalidated, archive };
}

async function configured(service: PluginLifecycleService, installed: PluginRecord) {
  return service.configure(installed.extensionId, { serviceBindings: { fixture: { enabled: true } } }, identity(installed));
}

async function activated(service: PluginLifecycleService, installed: PluginRecord) {
  let record = await configured(service, installed);
  record = await service.grant(record.extensionId, GRANTS, identity(record));
  record = await service.review(record.extensionId, identity(record));
  return service.enable(record.extensionId, identity(record));
}

test("empty plugin inspection is read-only and never creates a second authority registry", async (t) => {
  const { workspace, stateDir } = await fixture(t);
  const service = new PluginLifecycleService({ workspaceRoot: workspace, stateDir });
  assert.deepEqual(await service.list(), []);
  assert.deepEqual(await service.doctor(), []);
  assert.equal(await service.get("fixture-plugin"), undefined);
  await assert.rejects(lstat(stateDir), { code: "ENOENT" });
  assert.throws(() => new PluginRegistry(join(stateDir, "plugins.json")), /not an authority store/u);
  await assert.rejects(() => service.install("missing.zip"), /audit store/u);
  await assert.rejects(lstat(stateDir), { code: "ENOENT" });
});

test("a portable archive installs a sealed executable extension, with explicit lifecycle and audited identity", async (t) => {
  const { service, archive, stateDir, events, invalidated } = await fixture(t);
  const artifact = await archive();
  const inspected = await service.inspect(artifact.path, artifact.packed.digest);
  const installed = await service.install(artifact.path, { expectedDigest: inspected.digest });
  assert.equal(installed.packageDigest, artifact.packed.digest);
  assert.equal(installed.enabled, false);
  assert.equal(installed.reviewed, false);
  assert.deepEqual(installed.grants, []);
  await rm(artifact.source, { recursive: true });
  const extension = (await service.registry.get(installed.extensionId))!;
  assert.equal(extension.type, "mcp");
  assert.equal(extension.sandbox, "container");
  assert.equal(await digestExtensionBundle(extension.bundleRoot), extension.bundleDigest);
  assert.equal((await lstat(extension.entrypoint)).mode & 0o222, 0);
  assert.equal((extension.permissions.plugin as any).packageDigest, installed.packageDigest);
  await assert.rejects(lstat(join(stateDir, "plugins.json")), { code: "ENOENT" });
  const enabled = await activated(service, installed);
  assert.equal(enabled.status, "enabled");
  assert.equal((await service.registry.get(enabled.extensionId))?.enabled, true);
  assert.notEqual(enabled.identityFingerprint, installed.identityFingerprint);
  assert.equal((await service.doctor(enabled.extensionId))[0]?.ready, true);
  assert.equal(invalidated.length, 5);
  assert.equal(events.filter((event) => event.type === "plugin.lifecycle.completed").length, 5);
  assert.doesNotMatch(JSON.stringify(events), /server\.mjs|api\.example|serviceBindings|credentialRef/u);
});

test("service and credential-reference changes revoke review and grants, while raw secret fields are refused", async (t) => {
  const { service, archive, events } = await fixture(t, { credentialAvailable: async () => true });
  const artifact = await archive("1.0.0", {
    services: [{ id: "fixture", origin: "https://api.example.test", paths: ["/status"], queryKeys: [], credential: "FIXTURE_API_TOKEN" }],
    secrets: [{ name: "FIXTURE_API_TOKEN", purpose: "test credential reference" }]
  });
  let record = await service.install(artifact.path);
  record = await service.configure(record.extensionId, { serviceBindings: { fixture: { enabled: true, credentialRef: "env:FIXTURE_FIRST_TOKEN" } } }, identity(record));
  record = await service.enable(record.extensionId, { ...identity(record), grants: [...GRANTS, "secret.reference.use"], trust: true });
  const oldIdentity = record.identityFingerprint;
  record = await service.configure(record.extensionId, { serviceBindings: { fixture: { enabled: true, credentialRef: "env:FIXTURE_SECOND_TOKEN" } } }, identity(record));
  assert.notEqual(record.identityFingerprint, oldIdentity);
  assert.equal(record.enabled, false);
  assert.equal(record.reviewed, false);
  assert.deepEqual(record.grants, []);
  await assert.rejects(() => service.review(record.extensionId, { expectedIdentityFingerprint: oldIdentity }), /precondition failed/u);
  const before = await readFile(service.registry.path, "utf8");
  await assert.rejects(() => service.configure(record.extensionId, { serviceBindings: { fixture: { enabled: true, credentialRef: "not-a-reference" as any } } }, identity(record)), /opaque env:NAME/u);
  await assert.rejects(() => service.configure(record.extensionId, { serviceBindings: { fixture: { enabled: true, token: "forbidden-test-value" } } as any }, identity(record)), /no secret values/u);
  assert.equal(await readFile(service.registry.path, "utf8"), before);
  assert.doesNotMatch(JSON.stringify(events), /FIRST_TOKEN|SECOND_TOKEN|forbidden-test-value/u);
});

test("doctor reports runtime, image, explicit server override and missing-reference gates without writes", async (t) => {
  const { service, options, archive } = await fixture(t);
  const artifact = await archive("1.0.0", {
    services: [{ id: "fixture", origin: "https://api.example.test", paths: ["/status"], queryKeys: [], credential: "FIXTURE_API_TOKEN" }],
    secrets: [{ name: "FIXTURE_API_TOKEN", purpose: "test credential reference" }]
  });
  let record = await service.install(artifact.path);
  record = await service.configure(record.extensionId, { serviceBindings: { fixture: { enabled: true, credentialRef: "env:FIXTURE_MISSING_TOKEN" } } }, identity(record));
  const blocked = new PluginLifecycleService({ ...options, config: { runtime: { enableMcp: false }, sandbox: { process: { enabled: false, shell: false } }, mcp: { servers: { "fixture-plugin": { enabled: false, extensionId: "fixture-plugin" } } } }, probeRuntime: async () => ({ ok: false, imageAvailable: false, detail: "mocked unavailable OCI engine" }) });
  const before = await readFile(service.registry.path, "utf8");
  const report = (await blocked.doctor(record.extensionId))[0]!;
  for (const code of ["MCP_ENABLED", "PROCESS_ENABLED", "MCP_SERVER_OVERRIDE", "OCI_RUNTIME", "OCI_IMAGE", "CREDENTIAL_REFERENCE:fixture"]) {
    const check = report.checks.find((entry) => entry.code === code)!;
    assert.ok(check, JSON.stringify(report));
    assert.equal(check.ok, false, code);
    assert.ok(check.remediation, code);
  }
  await assert.rejects(() => blocked.enable(record.extensionId, { ...identity(record), grants: [...GRANTS, "secret.reference.use"], trust: true }), /Governed MCP runtime/u);
  assert.equal(await readFile(service.registry.path, "utf8"), before);
});

test("review does not authorize a different grant selection, and unchanged calls cannot reuse stale identities", async (t) => {
  const { service, archive } = await fixture(t);
  let record = await configured(service, await service.install((await archive()).path));
  record = await service.review(record.extensionId, identity(record));
  await assert.rejects(() => service.enable(record.extensionId, { ...identity(record), grants: GRANTS }), /grant selection changed/u);
  const previous = record;
  record = await service.grant(record.extensionId, GRANTS, identity(record));
  assert.equal(record.reviewed, false);
  await assert.rejects(() => service.review(record.extensionId, identity(previous)), /precondition failed/u);
  await assert.rejects(() => service.grant(record.extensionId, ["workspace.mutate"], identity(record)), /exceeds manifest capabilities/u);
  await assert.rejects(() => service.review(record.extensionId, {}), /expected identityFingerprint/u);
});

test("a concurrent disable fences a pending enable across separate registry instances", async (t) => {
  const { service, options, archive } = await fixture(t);
  let record = await configured(service, await service.install((await archive()).path));
  record = await service.grant(record.extensionId, GRANTS, identity(record));
  record = await service.review(record.extensionId, identity(record));
  let entered!: () => void;
  let release!: () => void;
  const probing = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const slow = new PluginLifecycleService({ ...options, probeRuntime: async () => { entered(); await barrier; return readyProbe(); } });
  const pending = slow.enable(record.extensionId, identity(record));
  await probing;
  const disabled = await service.disable(record.extensionId);
  release();
  await assert.rejects(pending, /precondition failed/u);
  const current = (await service.get(record.extensionId))!;
  assert.equal(current.enabled, false);
  assert.equal(current.identityFingerprint, disabled.identityFingerprint);
});

test("shared state locking serializes independent lifecycle writers without nested-lock deadlock", async (t) => {
  const { service, options, archive } = await fixture(t);
  const installed = await service.install((await archive()).path);
  let entered!: () => void;
  let release!: () => void;
  const admitted = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const first = new PluginLifecycleService({ ...options, auditStore: { append: async (event) => {
    if (event.type === "plugin.lifecycle.admitted") { entered(); await barrier; }
  } } });
  const writing = first.grant(installed.extensionId, GRANTS, identity(installed));
  await admitted;
  const reviewing = service.review(installed.extensionId, identity(installed));
  release();
  const written = await writing;
  await assert.rejects(reviewing, /precondition failed/u);
  assert.deepEqual((await service.get(installed.extensionId))?.grants, [...GRANTS].sort());
  assert.equal((await service.get(installed.extensionId))?.identityFingerprint, written.identityFingerprint);
});

test("admission audit failure and cancellation cannot commit authority changes", async (t) => {
  const { service, archive, options } = await fixture(t);
  const record = await service.install((await archive()).path);
  const before = await readFile(service.registry.path, "utf8");
  const failedAudit = new PluginLifecycleService({ ...options, auditStore: { append: async () => { throw new Error("audit unavailable"); } } });
  await assert.rejects(() => failedAudit.grant(record.extensionId, GRANTS, identity(record)), /audit unavailable/u);
  assert.equal(await readFile(service.registry.path, "utf8"), before);
  const abort = new AbortController();
  const cancelled = new PluginLifecycleService({ ...options, auditStore: { append: async () => { abort.abort(new Error("operator cancelled")); } } });
  await assert.rejects(() => cancelled.grant(record.extensionId, GRANTS, { ...identity(record), signal: abort.signal }), /operator cancelled/u);
  assert.equal(await readFile(service.registry.path, "utf8"), before);
});

test("cleanup uncertainty is explicit after revocation and cannot restore enabled authority", async (t) => {
  const { service, options, events, archive } = await fixture(t);
  const enabled = await activated(service, await service.install((await archive()).path));
  const uncertain = new PluginLifecycleService({ ...options, onInvalidate: async () => { throw new Error("transport cleanup unsettled"); } });
  await assert.rejects(() => uncertain.disable(enabled.extensionId, identity(enabled)), (error: any) => error.code === "PLUGIN_CLEANUP_UNCERTAIN");
  assert.equal((await service.get(enabled.extensionId))?.enabled, false);
  assert.ok(events.some((event) => event.type === "plugin.lifecycle.cleanup_uncertain"));
});

test("an artifact identity mismatch is refused before workspace-managed staging", async (t) => {
  const { service, stateDir, archive } = await fixture(t);
  const artifact = await archive();
  await assert.rejects(() => service.install(artifact.path, { expectedDigest: "f".repeat(64) }), /digest|identity|checksum/u);
  await assert.rejects(lstat(stateDir), { code: "ENOENT" });
});

test("updates and rollback remain disabled and untrusted; removal preserves package and operator data", async (t) => {
  const { service, stateDir, archive } = await fixture(t);
  const first = await service.install((await archive()).path);
  const enabled = await activated(service, first);
  const secondArtifact = await archive("1.1.0");
  await assert.rejects(() => service.install(secondArtifact.path), /precondition failed/u);
  const updated = await service.update(enabled.extensionId, secondArtifact.path, identity(enabled));
  assert.equal(updated.manifest.version, "1.1.0");
  assert.equal(updated.enabled, false);
  assert.equal(updated.reviewed, false);
  assert.deepEqual(updated.grants, []);
  const rolledBack = await service.rollback(updated.extensionId, identity(updated));
  assert.equal(rolledBack.manifest.version, "1.0.0");
  assert.equal(rolledBack.enabled, false);
  assert.equal(rolledBack.reviewed, false);
  assert.deepEqual(rolledBack.grants, []);
  assert.notEqual(rolledBack.identityFingerprint, first.identityFingerprint);
  const data = join(stateDir, "plugin-user-data.txt");
  await writeFile(data, "preserved operator data");
  const removed = await service.remove(rolledBack.extensionId, identity(rolledBack));
  assert.deepEqual(removed, { id: rolledBack.extensionId, removed: true, userDataPreserved: true });
  assert.equal(await readFile(data, "utf8"), "preserved operator data");
  assert.ok((await lstat(first.packageRoot)).isDirectory());
  assert.ok((await lstat(updated.packageRoot)).isDirectory());
  assert.equal(await service.get(rolledBack.extensionId), undefined);
});

test("package tampering is diagnosed without mutating registry state, and enablement refuses altered bundles", async (t) => {
  const { service, archive } = await fixture(t);
  const enabled = await activated(service, await service.install((await archive()).path));
  const support = join(enabled.packageRoot, "lib", "support.mjs");
  await chmod(support, 0o600);
  await writeFile(support, "export const altered = true;\n");
  await chmod(support, 0o444);
  const before = await readFile(service.registry.path, "utf8");
  const report = (await service.doctor(enabled.extensionId))[0]!;
  assert.equal(report.checks.find((check) => check.code === "PACKAGE_INTEGRITY")?.ok, false);
  await assert.rejects(() => service.enable(enabled.extensionId, identity(enabled)), (error: any) => error.code === "PLUGIN_PACKAGE_INTEGRITY");
  assert.equal(await readFile(service.registry.path, "utf8"), before);
});

test("managed package storage refuses symlinked parents before staging", { skip: process.platform === "win32" }, async (t) => {
  const { service, workspace, root, archive } = await fixture(t);
  const outside = join(root, "outside");
  await mkdir(outside);
  await symlink(outside, join(workspace, ".odinn"));
  const artifact = await archive();
  await assert.rejects(() => service.install(artifact.path), /without links/u);
  assert.deepEqual(await readdir(outside), []);
});

test("extension identity binds permissions, service references, schemas and lifecycle state deterministically", () => {
  const extension = { id: "identity-plugin", installId: "installation", version: "1.0.0", capabilities: GRANTS, grants: GRANTS, permissions: { plugin: { serviceBindings: { fixture: { enabled: true, credentialRef: "env:FIRST_TOKEN" } }, manifest: { tools: [{ inputSchema: { type: "object" } }] } } }, enabled: true, trusted: true, sandbox: "container" };
  const fingerprint = extensionIdentityFingerprint(extension);
  const changedReference = structuredClone(extension);
  changedReference.permissions.plugin.serviceBindings.fixture.credentialRef = "env:SECOND_TOKEN";
  assert.notEqual(extensionIdentityFingerprint(changedReference), fingerprint);
  const changedSchema = structuredClone(extension);
  changedSchema.permissions.plugin.manifest.tools[0]!.inputSchema.type = "string";
  assert.notEqual(extensionIdentityFingerprint(changedSchema), fingerprint);
  assert.notEqual(extensionIdentityFingerprint({ ...extension, enabled: false }), fingerprint);
  assert.notEqual(extensionIdentityFingerprint({ ...extension, sandbox: "unconfined-process" }), fingerprint);
  assert.equal(extensionIdentityFingerprint({ ...extension, capabilities: [...GRANTS].reverse(), grants: [...GRANTS].reverse() }), fingerprint);
  assert.equal(extensionIdentityFingerprint(Object.fromEntries(Object.entries(extension).reverse())), fingerprint);
});
