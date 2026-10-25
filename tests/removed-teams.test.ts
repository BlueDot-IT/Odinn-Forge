process.env.ODINN_GATEWAY_AUTH = "off";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createGatewayServer } from "../apps/gateway/src/server.ts";
import { telegramChannelPlugin } from "../adapters/channels/telegram/src/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const legacyConfig = () => ({
  version: 1,
  providers: {},
  channels: {
    work: { type: "teams", enabled: true, tokenEnv: "ODINN_TEAMS_APP_PASSWORD", appIdEnv: "ODINN_TEAMS_APP_ID", allowlist: ["teams:user-1"] },
    personal: { type: "telegram", enabled: false, tokenEnv: "ODINN_TELEGRAM_BOT_TOKEN", allowlist: ["telegram:123"] }
  }
});

test("removed Teams accounts cannot load, receive webhooks, or be re-enabled through configuration", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-removed-teams-"));
  const configPath = join(stateDir, "config.json");
  const original = `${JSON.stringify(legacyConfig(), null, 2)}\n`;
  await writeFile(configPath, original, { mode: 0o600 });
  const loaded: string[] = [];
  const server: any = await createGatewayServer({
    stateDir,
    workspaceRoot: root,
    channelPluginLoader: async (type: string) => {
      loaded.push(type);
      assert.equal(type, "telegram", "removed Teams must never reach the plugin loader");
      return telegramChannelPlugin;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(loaded, ["telegram"]);
    assert.equal(await readFile(configPath, "utf8"), original, "startup must not rewrite saved configuration");
    const status: any = await (await fetch(`${base}/channels`)).json();
    assert.equal(status.channels.length, 2);
    const teams = status.channels.find((channel: any) => channel.type === "teams");
    assert.equal(teams.enabled, false);
    assert.equal(teams.running, false);
    assert.equal(teams.credentialPresent, false);
    assert.deepEqual(teams.capabilities.chatTypes, []);
    assert.match(teams.error, /Microsoft Teams integration has been removed/);
    assert.equal(status.channels.find((channel: any) => channel.name === "personal").type, "telegram");
    const webhook = await fetch(`${base}/channels/webhook/teams/work`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"type":"message"}' });
    assert.equal(webhook.status, 404);
    await webhook.text();

    const editable: any = await (await fetch(`${base}/config`)).json();
    const save = (config: any, fingerprint = editable.fingerprint) => fetch(`${base}/config`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config, fingerprint })
    });
    const refused = await save(editable.config);
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /Microsoft Teams integration has been removed/);
    assert.equal(await readFile(configPath, "utf8"), original);
    editable.config.channels.work.enabled = false;
    const disabled = await save(editable.config);
    assert.equal(disabled.status, 200);
    const saved: any = await disabled.json();
    delete saved.config.channels.work;
    const removed = await save(saved.config, saved.fingerprint);
    assert.equal(removed.status, 200);
    await removed.json();
    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(persisted.channels, { personal: legacyConfig().channels.personal });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("CLI refuses Teams creation and reactivation but can remove legacy accounts", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-removed-teams-cli-"));
  const path = join(stateDir, "config.json");
  const original = `${JSON.stringify(legacyConfig(), null, 2)}\n`;
  await writeFile(path, original, { mode: 0o600 });
  const cli = (...args: string[]) => spawnSync(process.execPath, ["apps/cli/src/cli.ts", "config", "channel", ...args, "--state", stateDir], { cwd: root, encoding: "utf8", timeout: 30_000 });
  try {
    const add = cli("add", "teams", "new", "--token-env", "ODINN_TEAMS_APP_PASSWORD");
    assert.notEqual(add.status, 0);
    assert.match(add.stderr, /requires telegram\|discord\|slack\|whatsapp/);
    const enable = cli("enable", "work");
    assert.notEqual(enable.status, 0);
    assert.match(enable.stderr, /Microsoft Teams integration has been removed/);
    assert.equal(await readFile(path, "utf8"), original);
    const listed = cli("list");
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).find((entry: any) => entry.name === "work").enabled, false);
    const removed = cli("remove", "work");
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).channels, { personal: legacyConfig().channels.personal });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
