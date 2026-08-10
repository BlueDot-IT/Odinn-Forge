import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyEnvironmentValues, assertPhysicalDirectory, configuredCredentialEnvironmentKeys, loadEnvironmentFiles, readEnvironmentFiles } from "../packages/kernel/src/environment.ts";
import { sanitizedWorkerEnvironment } from "../packages/kernel/src/jobs.ts";

test("loads workspace and state .env files with safe precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-env-"));
  const state = join(root, ".odinn");
  await mkdir(state);
  await writeFile(join(root, ".env"), "ROOT_ONLY=root\nSHARED=root\nPARENT=from-file\n", { mode: 0o600 });
  await writeFile(join(state, ".env"), "STATE_ONLY=state\nSHARED=state\n", { mode: 0o600 });
  const environment: NodeJS.ProcessEnv = { PARENT: "from-parent" };

  const loaded = loadEnvironmentFiles({ workspaceRoot: root, stateDir: state, environment, workspaceAllowedKeys: ["ROOT_ONLY", "SHARED", "PARENT"] });

  assert.equal(environment.ROOT_ONLY, "root");
  assert.equal(environment.STATE_ONLY, "state");
  assert.equal(environment.SHARED, "state");
  assert.equal(environment.PARENT, "from-parent");
  assert.equal(loaded.length, 2);
  assert.deepEqual(loaded[1].keys, ["SHARED", "STATE_ONLY"]);
});

test("loads a state .env file only once when it is also the workspace file", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-env-same-"));
  const path = join(root, ".env");
  await writeFile(path, "TOKEN=secret\n", { mode: 0o600 });
  await chmod(path, 0o600);
  const environment: NodeJS.ProcessEnv = {};

  const loaded = loadEnvironmentFiles({ workspaceRoot: root, stateDir: root, environment });

  assert.equal(environment.TOKEN, "secret");
  assert.equal(loaded.length, 1);
});

test("supports bootstrapping a state directory from the workspace .env file", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-env-bootstrap-"));
  const state = join(root, "private-state");
  await mkdir(state);
  await writeFile(join(root, ".env"), "ODINN_STATE_DIR=private-state\nSHARED=root\n", { mode: 0o600 });
  await writeFile(join(state, ".env"), "SHARED=state\n", { mode: 0o600 });
  const environment: NodeJS.ProcessEnv = {};
  const protectedKeys = new Set(Object.keys(environment));

  loadEnvironmentFiles({ workspaceRoot: root, stateDir: state, environment, protectedKeys, workspaceAllowedKeys: [] });
  loadEnvironmentFiles({ workspaceRoot: root, stateDir: state, environment, protectedKeys });

  assert.equal(environment.ODINN_STATE_DIR, undefined);
  assert.equal(environment.SHARED, "state");
});

test("workspace .env cannot select operator executables or network endpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-env-untrusted-controls-"));
  const state = join(root, ".odinn");
  await mkdir(state);
  await writeFile(join(root, ".env"), [
    "ODINN_CHROMIUM_PATH=/workspace/chromium",
    "ODINN_EXTENSION_CONTAINER_RUNTIME=/workspace/runtime",
    "ODINN_SEARCH_ENDPOINT=http://127.0.0.1/",
    "SAFE_WORKSPACE_VALUE=loaded"
  ].join("\n"));
  await writeFile(join(state, ".env"), [
    "ODINN_CHROMIUM_PATH=/operator/chromium",
    "ODINN_EXTENSION_CONTAINER_RUNTIME=/operator/runtime",
    "ODINN_SEARCH_ENDPOINT=https://search.example/"
  ].join("\n"));
  const environment: NodeJS.ProcessEnv = {};

  loadEnvironmentFiles({ workspaceRoot: root, stateDir: state, environment, workspaceAllowedKeys: ["SAFE_WORKSPACE_VALUE"] });

  assert.equal(environment.SAFE_WORKSPACE_VALUE, "loaded");
  assert.equal(environment.ODINN_CHROMIUM_PATH, "/operator/chromium");
  assert.equal(environment.ODINN_EXTENSION_CONTAINER_RUNTIME, "/operator/runtime");
  assert.equal(environment.ODINN_SEARCH_ENDPOINT, "https://search.example/");
});

test("startup environment loading keeps workspace controls out of process.env", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-env-boundary-"));
  const state = join(root, ".odinn");
  await mkdir(state);
  await writeFile(join(root, ".env"), [
    "NODE_OPTIONS=--import=./payload.mjs",
    "ODINN_STATE_DIR=attacker-state",
    "ODINN_GATEWAY_AUTH=off",
    "ODINN_ANTIGRAVITY_CLI=/workspace/agy",
    "OPENAI_API_KEY=workspace-key"
  ].join("\n"));
  await writeFile(join(state, ".env"), "OPENAI_API_KEY=operator-key\n", { mode: 0o600 });
  await writeFile(join(state, "config.json"), JSON.stringify({ providers: { openai: { auth: { apiKeyEnv: "OPENAI_API_KEY" } } } }));
  const parent = { PATH: "/system", NODE_OPTIONS: "--no-warnings" };
  const environment = { ...parent };
  const parsed = readEnvironmentFiles({ workspaceRoot: root, stateDir: state });
  applyEnvironmentValues(parsed.workspace, environment, { protectedKeys: Object.keys(parent), allowedKeys: configuredCredentialEnvironmentKeys(JSON.parse(await readFile(join(state, "config.json"), "utf8"))) });
  applyEnvironmentValues(parsed.state, environment, { protectedKeys: Object.keys(parent) });
  assert.equal(environment.NODE_OPTIONS, "--no-warnings");
  assert.equal(environment.ODINN_STATE_DIR, undefined);
  assert.equal(environment.ODINN_GATEWAY_AUTH, undefined);
  assert.equal(environment.ODINN_ANTIGRAVITY_CLI, undefined);
  assert.equal(environment.OPENAI_API_KEY, "operator-key");
  assertPhysicalDirectory(state);
});

test("environment files and state directories reject symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-env-links-"));
  const state = join(root, ".odinn");
  await mkdir(state);
  const target = join(root, "outside.env");
  await writeFile(target, "TOKEN=secret\n");
  await symlink(target, join(root, ".env"));
  assert.throws(() => readEnvironmentFiles({ workspaceRoot: root, stateDir: state }), /must not be a symbolic link/u);
  const linkedState = join(root, "linked-state");
  await symlink(state, linkedState);
  assert.throws(() => assertPhysicalDirectory(linkedState), /physical directory/u);
});

test("fork worker environment strips preload and routing controls while preserving trusted runtime selectors", () => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    NODE_OPTIONS: "--import=./payload.mjs",
    NODE_PATH: "/workspace/node_modules",
    INIT_CWD: "/workspace",
    PATH: "/workspace/bin",
    ODINN_STATE_DIR: "/workspace/state",
    ODINN_GATEWAY_AUTH: "off",
    ODINN_ANTIGRAVITY_CLI: "/workspace/agy",
    ODINN_CHROMIUM_PATH: "/workspace/chromium",
    LD_PRELOAD: "/workspace/payload.so",
    ODINN_TEST_API_KEY: "preserved"
  });
  try {
    const environment = sanitizedWorkerEnvironment();
    for (const key of ["NODE_OPTIONS", "NODE_PATH", "INIT_CWD", "ODINN_STATE_DIR", "ODINN_GATEWAY_AUTH", "LD_PRELOAD"]) assert.equal(environment[key], undefined, key);
    assert.equal(environment.PATH, "/workspace/bin");
    assert.equal(environment.ODINN_ANTIGRAVITY_CLI, "/workspace/agy");
    assert.equal(environment.ODINN_CHROMIUM_PATH, "/workspace/chromium");
    assert.equal(environment.ODINN_TEST_API_KEY, "preserved");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    for (const [key, value] of Object.entries(previous)) process.env[key] = value;
  }
});
