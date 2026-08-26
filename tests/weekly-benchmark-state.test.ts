import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertCredentialFresh,
  parseOAuthCredential,
} from "../scripts/ci/weekly-benchmark-state.ts";

function token(expirySeconds: number): string {
  const payload = Buffer.from(JSON.stringify({
    exp: expirySeconds,
    "https://api.openai.com/auth": { chatgpt_account_id: "benchmark-account" },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

test("weekly benchmark state accepts the synchronized OAuth record contract", () => {
  const expiry = Date.now() + 8 * 60 * 60 * 1_000;
  assert.deepEqual(parseOAuthCredential(JSON.stringify({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: expiry,
  })), {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: expiry,
  });
  assert.deepEqual(parseOAuthCredential({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_at: Math.floor(expiry / 1_000),
  }), {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Math.floor(expiry / 1_000) * 1_000,
  });
});

test("weekly benchmark state rejects stale credentials before launching runtimes", () => {
  const now = Date.now();
  assert.doesNotThrow(() => assertCredentialFresh({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: now + 5 * 60 * 60 * 1_000,
  }, now));
  assert.throws(() => assertCredentialFresh({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: now + 3 * 60 * 60 * 1_000,
  }, now), /not fresh enough/u);
});

test("weekly benchmark preparation keeps credentials out of adapter configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-weekly-state-"));
  const bin = join(root, "bin");
  const harness = join(root, "harness");
  const state = join(root, "state");
  const config = join(root, "adapters.json");
  await Promise.all([mkdir(bin), mkdir(harness)]);
  const executable = "#!/bin/sh\nexit 0\n";
  for (const name of ["odinn", "openclaw", "hermes", "pnpm"]) {
    const path = join(bin, name);
    await writeFile(path, executable, { mode: 0o700 });
    await chmod(path, 0o700);
  }
  const expiry = Date.now() + 8 * 60 * 60 * 1_000;
  const accessToken = token(Math.floor(expiry / 1_000));
  const refreshToken = "synthetic-refresh-token";
  const result = spawnSync(process.execPath, [
    new URL("../scripts/ci/weekly-benchmark-state.ts", import.meta.url).pathname,
    "prepare",
    "--state-root", state,
    "--harness", harness,
    "--odinn", join(bin, "odinn"),
    "--openclaw", join(bin, "openclaw"),
    "--hermes", join(bin, "hermes"),
    "--config-output", config,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ODINN_OPENAI_OAUTH_JSON: JSON.stringify({
        accessToken,
        refreshToken,
        expiresAt: expiry,
      }),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const adapterConfig = await readFile(config, "utf8");
  assert.doesNotMatch(adapterConfig, new RegExp(accessToken, "u"));
  assert.doesNotMatch(adapterConfig, new RegExp(refreshToken, "u"));
  assert.match(adapterConfig, /"provider": "openai-oauth"/u);
  assert.match(adapterConfig, /"model": "gpt-5\.6-luna"/u);
  assert.match(adapterConfig, /openclaw-benchmark-adapter\.ts/u);
  assert.doesNotMatch(adapterConfig, /"--local"/u);
  assert.doesNotMatch(adapterConfig, /--durable-process|--confirm-process/u);
  const adapters = JSON.parse(adapterConfig).adapters as Array<{
    id: string;
    capabilities: string[];
    args: string[];
  }>;
  const odinn = adapters.find((adapter) => adapter.id === "odinn-forge");
  assert.deepEqual(odinn?.capabilities, ["text.generate", "workspace.read", "workspace.write"]);
  assert.deepEqual(odinn?.args, ["run", "--tool", "agent.run", "--input-file", "{inputFile}", "--state", "{state}"]);
  assert.equal((await stat(config)).mode & 0o777, 0o600);
  const openclawAuth = await readFile(join(state, "openclaw", "agents", "main", "agent", "auth-profiles.json"), "utf8");
  assert.match(openclawAuth, new RegExp(accessToken, "u"));
  assert.match(openclawAuth, new RegExp(refreshToken, "u"));
  assert.equal((await stat(join(state, "openclaw", "agents", "main", "agent", "auth-profiles.json"))).mode & 0o777, 0o600);
});
