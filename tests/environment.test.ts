import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEnvironmentFiles } from "../packages/kernel/src/environment.ts";

test("loads workspace and state .env files with safe precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-env-"));
  const state = join(root, ".odinn");
  await mkdir(state);
  await writeFile(join(root, ".env"), "ROOT_ONLY=root\nSHARED=root\nPARENT=from-file\n", { mode: 0o600 });
  await writeFile(join(state, ".env"), "STATE_ONLY=state\nSHARED=state\n", { mode: 0o600 });
  const environment: NodeJS.ProcessEnv = { PARENT: "from-parent" };

  const loaded = loadEnvironmentFiles({ workspaceRoot: root, stateDir: state, environment });

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

  loadEnvironmentFiles({ workspaceRoot: root, stateDir: root, environment, protectedKeys });
  loadEnvironmentFiles({
    workspaceRoot: root,
    stateDir: environment.ODINN_STATE_DIR!,
    environment,
    protectedKeys
  });

  assert.equal(environment.ODINN_STATE_DIR, "private-state");
  assert.equal(environment.SHARED, "state");
});
