process.env.ODINN_GATEWAY_AUTH = "off";
process.env.ODINN_BROWSER_HEADLESS = "1";

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createGatewayServer } from "../apps/gateway/src/server.ts";
import { handlePluginRoute } from "../apps/gateway/src/plugin-routes.ts";
import { createApprovalStore, ExtensionRegistry, isPhysicalPathInside, packPluginPackage, scaffoldPlugin } from "../packages/kernel/src/index.ts";

const execFile = promisify(execFileCallback);
const cliPath = fileURLToPath(new URL("../apps/cli/src/cli.ts", import.meta.url));

async function cli(workspace: string, args: string[]) {
  const result = await execFile(process.execPath, [cliPath, "plugin", ...args, "--state", join(workspace, ".odinn")], {
    cwd: workspace, env: { ...process.env, INIT_CWD: workspace }, timeout: 60_000, maxBuffer: 2 * 1024 * 1024
  });
  return JSON.parse(result.stdout);
}

async function removeFixture(root: string): Promise<void> {
  async function writable(directory: string): Promise<void> {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) await writable(join(directory, entry.name));
    }
  }
  await writable(root);
  await rm(root, { recursive: true, force: true });
}

async function request(base: string, path: string, body?: unknown, status = 200): Promise<any> {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(value)}`);
  return value;
}

test("plugin HTTP lifecycle installs a verified artifact into the execution registry and rejects stale identities", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "odinn-plugin-http-"));
  const stateDir = join(workspace, ".odinn");
  const source = join(workspace, "source");
  const manifest = await scaffoldPlugin(source, "surface-plugin");
  const archive = join(workspace, "surface.odinn-plugin.zip");
  const packed = await packPluginPackage(source, archive);
  const archiveBase64 = (await readFile(archive)).toString("base64");
  await mkdir(stateDir);
  await writeFile(join(stateDir, "config.json"), JSON.stringify({ version: 1, runtime: { enableMcp: true }, sandbox: { process: { enabled: true } } }));
  const server: any = await createGatewayServer({ workspaceRoot: workspace, stateDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const registry = new ExtensionRegistry(join(stateDir, "extensions.json"));
  try {
    assert.deepEqual((await request(base, "/plugins")).plugins, []);
    await request(base, "/plugins", { manifest, packageDigest: packed.digest }, 400);
    await request(base, "/plugins", { path: cliPath }, 400);
    await request(base, "/plugins", { archiveBase64, expectedDigest: "0".repeat(64) }, 400);
    assert.equal((await registry.list()).length, 0);
    const inspected = await request(base, "/plugins/inspect", { archiveBase64 });
    assert.equal(inspected.metadata.digest, packed.digest);
    assert.equal(inspected.metadata.archivePath, undefined);
    assert.equal((await registry.list()).length, 0, "inspection must not install or activate code");
    let plugin = (await request(base, "/plugins", { archiveBase64, expectedDigest: packed.digest })).plugin;
    assert.equal(plugin.enabled, false);
    assert.equal(plugin.reviewed, false);
    assert.equal(plugin.packageDigest, packed.digest);
    const execution = await registry.get(manifest.id);
    assert.equal(execution?.type, "mcp");
    assert.ok(isPhysicalPathInside(workspace, execution!.entrypoint));
    await assert.rejects(access(join(stateDir, "plugins.json")), /ENOENT/u);
    const initialIdentity = plugin.identityFingerprint;
    const transition = async (action: string, fields = {}, status = 200) => {
      const response = await request(base, `/plugins/${manifest.id}/lifecycle`, { action, expectedIdentityFingerprint: plugin.identityFingerprint, ...fields }, status);
      if (status === 200 && response.plugin?.identityFingerprint) plugin = response.plugin;
      return response;
    };
    await transition("configure", { serviceBindings: Object.fromEntries(manifest.services.map((service) => [service.id, { enabled: true }])) });
    const grants = [...new Set(["mcp.discover", "mcp.invoke", ...manifest.tools.flatMap((tool) => [...tool.capabilities])])];
    await transition("grant", { grants });
    await transition("review", { expectedIdentityFingerprint: initialIdentity }, 409);
    await transition("review");
    await transition("enable");
    assert.equal((await registry.get(manifest.id))?.enabled, true, "enablement must reach the actual execution registry");
    const doctor = (await request(base, `/plugins/doctor?id=${manifest.id}`)).checks[0];
    assert.equal(typeof doctor.ready, "boolean");
    assert.ok(doctor.checks.some((check: any) => /OCI|image/iu.test(`${check.code} ${check.detail} ${check.remediation}`)), "doctor independently checks the runtime image");
    await transition("disable");
    await writeFile(join(source, "plugin.json"), JSON.stringify({ ...manifest, version: "1.1.0" }));
    const nextArchive = join(workspace, "next.odinn-plugin.zip");
    const next = await packPluginPackage(source, nextArchive);
    plugin = (await request(base, "/plugins", { path: nextArchive, expectedDigest: next.digest, expectedIdentityFingerprint: plugin.identityFingerprint })).plugin;
    assert.equal(plugin.manifest.version, "1.1.0");
    assert.equal(plugin.enabled, false);
    assert.equal(plugin.reviewed, false);
    await transition("rollback");
    assert.equal(plugin.manifest.version, manifest.version);
    assert.equal(plugin.enabled, false);
    const removed = await transition("remove");
    assert.equal(removed.plugin.removed, true);
    assert.equal(removed.plugin.userDataPreserved, true);
    assert.equal(await registry.get(manifest.id), undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve()));
    await removeFixture(workspace);
  }
});

test("plugin CLI authoring and lifecycle use the same extension records without mutating inspection state", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "odinn-plugin-cli-"));
  try {
    await cli(workspace, ["list"]);
    assert.deepEqual(await readdir(workspace), [], "list must not initialize configuration or audit state");
    const scaffold = await cli(workspace, ["scaffold", "--id", "cli-plugin", "--output", "source"]);
    assert.equal(scaffold.manifest.id, "cli-plugin");
    const packed = await cli(workspace, ["pack", "--input", "source", "--output", "plugin.zip"]);
    const inspected = await cli(workspace, ["inspect", "--input", "plugin.zip", "--digest", packed.digest]);
    assert.equal(inspected.digest, packed.digest);
    let record = await cli(workspace, ["install", "--input", "plugin.zip", "--digest", packed.digest]);
    const transition = async (action: string, more: string[] = []) => {
      record = await cli(workspace, [action, "--id", "cli-plugin", "--identity", record.identityFingerprint, ...more]);
    };
    await transition("configure", ["--bindings-json", JSON.stringify(Object.fromEntries(scaffold.manifest.services.map((service: any) => [service.id, { enabled: true }])))]);
    await transition("grant", ["--grant", [...new Set(["mcp.discover", "mcp.invoke", ...scaffold.manifest.tools.flatMap((tool: any) => tool.capabilities)])].join(",")]);
    await transition("review");
    const configPath = join(workspace, ".odinn", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(configPath, JSON.stringify({ ...config, runtime: { ...config.runtime, enableMcp: true } }));
    await transition("enable");
    assert.equal(record.enabled, true);
    assert.equal((await new ExtensionRegistry(join(workspace, ".odinn", "extensions.json")).get("cli-plugin"))?.enabled, true);
    const details = await cli(workspace, ["info", "--id", "cli-plugin"]);
    assert.equal(details.identityFingerprint, record.identityFingerprint);
    await transition("disable");
    await transition("uninstall");
    assert.equal(record.userDataPreserved, true);
  } finally { await removeFixture(workspace); }
});

test("hosted plugin routes do not read host package metadata, credentials, or runtime state", async () => {
  for (const [method, path] of [["GET", "/plugins"], ["GET", "/plugins/doctor"], ["GET", "/plugins/catalog"], ["POST", "/plugins"], ["POST", "/plugins/test-plugin/discover"]]) {
    const reply = await handlePluginRoute({
      method: method!, url: new URL(path!, "http://localhost"), workspaceRoot: "/unused", hosted: true, bodyLimitBytes: 65536,
      lifecycle: new Proxy({} as any, { get() { assert.fail("hosted route touched host lifecycle state"); } }),
      readBody: async () => assert.fail("hosted route read a mutation body"),
      mutate: async () => assert.fail("hosted route mutated state"), discover: async () => assert.fail("hosted route dispatched code")
    });
    assert.equal(reply?.status, 403);
    assert.doesNotMatch(JSON.stringify(reply), /credentialRef|packageRoot|fileDigests/u);
  }
});

test("gateway plugin paths reject symlink aliases before archive inspection", { skip: process.platform === "win32" }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "odinn-plugin-path-"));
  try {
    const outside = join(workspace, "..", `odinn-plugin-outside-${Date.now()}.zip`);
    await writeFile(outside, "not a package");
    try {
      await symlink(outside, join(workspace, "alias.zip"));
      const reply = await handlePluginRoute({
        method: "POST", url: new URL("/plugins/inspect", "http://localhost"), workspaceRoot: workspace, hosted: false, bodyLimitBytes: 65536,
        lifecycle: {} as any, readBody: async () => ({ path: "alias.zip" }),
        mutate: async () => assert.fail("inspection mutated registry"), discover: async () => assert.fail("inspection dispatched code")
      });
      assert.equal(reply?.status, 400);
      assert.match(JSON.stringify(reply?.body), /physically inside|regular file/u);
    } finally { await rm(outside, { force: true }); }
  } finally { await removeFixture(workspace); }
});

test("gateway refuses and revokes plugin approvals without a direct durable originating job", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "odinn-plugin-unlinked-approval-"));
  const stateDir = join(workspace, ".odinn");
  const server: any = await createGatewayServer({ workspaceRoot: workspace, stateDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
    const id = approvalStore.create({ runId: "nested-plugin-approval", tool: "mcp.invoke", actor: "local", input: { serverId: "weather-connector", toolName: "weather-connector.current", arguments: {} } });
    await request(base, `/approvals/${id}/approve`, {}, 409);
    assert.equal(approvalStore.list().some((approval: any) => approval.id === id), false, "unlinked plugin authority must be revoked before dispatch");
    assert.equal(approvalStore.recover(id), undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve()));
    await removeFixture(workspace);
  }
});
