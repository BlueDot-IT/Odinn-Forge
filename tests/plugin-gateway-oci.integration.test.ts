process.env.ODINN_GATEWAY_AUTH = "off";

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createGatewayServer } from "../apps/gateway/src/server.ts";
import { packPluginPackage } from "../packages/kernel/src/index.ts";

const execFile = promisify(execFileCallback);
const cliPath = fileURLToPath(new URL("../apps/cli/src/cli.ts", import.meta.url));
const enabled = process.env.ODINN_RUN_PLUGIN_LIVE_TESTS === "1";

async function cleanFixture(path: string): Promise<void> {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await cleanFixture(join(path, entry.name));
  await rm(path, { recursive: true, force: true });
}

test("plugin CLI and gateway approval return a real OCI service result and settle the durable job exactly once", { skip: !enabled, timeout: 120_000 }, async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "odinn-plugin-gateway-live-"));
  const stateDir = join(workspaceRoot, ".odinn");
  const source = join(workspaceRoot, "author");
  await cp(new URL("../examples/plugins/weather-connector/", import.meta.url), source, { recursive: true });
  const manifest = JSON.parse(await readFile(join(source, "plugin.json"), "utf8"));
  if (process.env.ODINN_TEST_EXTENSION_OCI_IMAGE) {
    manifest.containerImage = process.env.ODINN_TEST_EXTENSION_OCI_IMAGE;
    await writeFile(join(source, "plugin.json"), JSON.stringify(manifest));
  }
  const archive = join(workspaceRoot, "weather.odinn-plugin.zip");
  const packed = await packPluginPackage(source, archive);
  await mkdir(stateDir, { mode: 0o700 });
  await writeFile(join(stateDir, "config.json"), JSON.stringify({
    version: 1, runtime: { enableMcp: true },
    sandbox: { backend: { mode: "oci", preference: ["oci"], unavailable: "refuse" }, process: { enabled: true }, network: { mode: "denied" } },
    policy: { allowedCapabilities: ["mcp.discover", "mcp.invoke", "network.access"] }
  }), { mode: 0o600 });
  const server: any = await createGatewayServer({ workspaceRoot, stateDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
    await cleanFixture(workspaceRoot);
  });
  const request = async (path: string, body?: unknown): Promise<any> => {
    const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.ok, true, `${path}: ${JSON.stringify(value)}`);
    return value;
  };
  const cli = async (args: string[]): Promise<any> => {
    const { stdout } = await execFile(process.execPath, [cliPath, "plugin", ...args, "--state", stateDir, "--gateway-url", base], {
      cwd: workspaceRoot, env: { ...process.env, INIT_CWD: workspaceRoot }, timeout: 60_000, maxBuffer: 2 * 1024 * 1024
    });
    return JSON.parse(stdout);
  };
  let plugin = (await request("/plugins", { path: archive, expectedDigest: packed.digest })).plugin;
  const transition = async (action: string, fields = {}) => {
    plugin = (await request(`/plugins/${manifest.id}/lifecycle`, { action, expectedIdentityFingerprint: plugin.identityFingerprint, ...fields })).plugin;
  };
  await transition("configure", { serviceBindings: { "open-meteo": { enabled: true } } });
  await transition("grant", { grants: ["mcp.discover", "mcp.invoke", "network.access"] });
  await transition("review");
  await transition("enable");
  const discovery = await cli(["discover", "--id", manifest.id]);
  assert.equal((discovery.output ?? discovery).type, "mcp.discovery");
  const submitted = await cli(["invoke", "--id", manifest.id, "--tool", `${manifest.id}.current`, "--input-json", JSON.stringify({ latitude: 40, longitude: -74 })]);
  const jobId = submitted.job?.id ?? submitted.id;
  assert.equal(typeof jobId, "string", "CLI must return the originating durable job");
  let job: any;
  const deadline = Date.now() + 15_000;
  do {
    job = await request(`/jobs/${jobId}`);
    if (job.status !== "queued" && job.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(job.status, "awaiting-approval", JSON.stringify(job));
  const approval = (await cli(["approvals", "--id", manifest.id])).approvals.find((value: any) => value.runId === jobId);
  assert.equal(typeof approval?.id, "string", "CLI approval filtering must match the plugin");
  const completed = await cli(["approve", "--approval", approval.id, "--confirm"]);
  assert.equal(completed.ok, true, "approved CLI invocation must return the live successful task result");
  const weather = JSON.parse(completed.output.result.content[0].text);
  assert.equal(typeof weather.current.temperature_2m, "number");
  job = await request(`/jobs/${jobId}`);
  assert.equal(job.status, "completed", "the supervisor must retain settlement ownership through the approved run");
  assert.doesNotMatch(JSON.stringify(job), /temperature_2m/u, "provider body must not enter the saved job projection");
  const replay = await fetch(`${base}/approvals/${approval.id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.ok([404, 409].includes(replay.status), "an approval cannot execute twice");
  await transition("disable");
  t.diagnostic("CLI discovery/invocation/approval, real host-brokered Open-Meteo response, durable terminal settlement, private replay projection, and one-time approval verified.");
});
