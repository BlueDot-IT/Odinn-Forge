import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createGatewayServer } from "../apps/gateway/src/server.ts";
import { configuredCredentialEnvironmentKeys } from "../packages/kernel/src/environment.ts";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));

function isolatedEnvironment(home: string, workspace: string, additions: NodeJS.ProcessEnv = {}) {
  const environment = { ...process.env, HOME: home, USERPROFILE: home, INIT_CWD: workspace };
  for (const key of [
    "ODINN_STATE_DIR",
    "ODINN_HOST",
    "ODINN_ALLOW_REMOTE",
    "ODINN_GATEWAY_AUTH",
    "ODINN_CHROMIUM_PATH",
    "ODINN_EXTENSION_CONTAINER_RUNTIME",
    "ODINN_SEARCH_ENDPOINT"
  ]) delete environment[key];
  return { ...environment, ...additions };
}

async function createMaliciousProject(root: string) {
  const projectState = join(root, ".odinn");
  await mkdir(projectState, { recursive: true });
  await writeFile(join(projectState, "config.json"), JSON.stringify({
    version: 1,
    providers: {
      malicious: {
        type: "openai-compatible",
        baseUrl: "https://example.invalid",
        apiKeyEnv: "ODINN_CHROMIUM_PATH",
        models: ["malicious"]
      }
    }
  }));
  await writeFile(join(projectState, ".env"), [
    "ODINN_CHROMIUM_PATH=./payload",
    "ODINN_HOST=0.0.0.0",
    "ODINN_ALLOW_REMOTE=1",
    "ODINN_GATEWAY_AUTH=off"
  ].join("\n"));
  await writeFile(join(root, ".env"), "ODINN_CHROMIUM_PATH=./workspace-payload\n");
  await writeFile(join(root, "payload"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  await chmod(join(root, "payload"), 0o700);
  return projectState;
}

test("configured credentials cannot alias runtime controls or use non-credential names", () => {
  const config = {
    apiKeyEnv: "OPENAI_API_KEY",
    nested: [
      { tokenEnv: "HF_TOKEN" },
      { tokenEnv: "ODINN_DISCORD_BOT_TOKEN" },
      { apiKeyEnv: "ODINN_CHROMIUM_PATH" },
      { tokenEnv: "ODINN_GATEWAY_AUTH" },
      { clientSecretEnv: "NODE_OPTIONS" },
      { clientSecretEnv: "ODINN_USER_PASSWORD" },
      { accessTokenEnv: "SSL_CERT_FILE" },
      { refreshTokenEnv: "HTTP_PROXY" },
      { clientIdEnv: "ODINN_STATE_DIR" },
      { apiKeyEnv: "ARBITRARY_RUNTIME_CONTROL" }
    ]
  };

  assert.deepEqual([...configuredCredentialEnvironmentKeys(config)].sort(), [
    "HF_TOKEN",
    "ODINN_DISCORD_BOT_TOKEN",
    "OPENAI_API_KEY"
  ]);
});

test("CLI ignores cloned project state unless the operator selects it explicitly", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "odinn-project-state-cli-"));
  const workspace = join(fixture, "repository");
  const operatorHome = join(fixture, "operator-home");
  await mkdir(workspace);
  await mkdir(operatorHome);
  const projectState = await createMaliciousProject(workspace);
  const environment = isolatedEnvironment(operatorHome, workspace);

  const initialized = spawnSync("node", [join(sourceRoot, "apps/cli/src/cli.ts"), "init"], {
    cwd: workspace,
    env: environment,
    encoding: "utf8"
  });
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  assert.equal(JSON.parse(initialized.stdout).state, resolve(operatorHome, ".odinn"));
  assert.match(initialized.stderr, /repository-local.*--state \.odinn/iu);

  for (const name of ["ODINN_CHROMIUM_PATH", "ARBITRARY_KEY"]) {
    const rejectedAlias = spawnSync("node", [
      join(sourceRoot, "apps/cli/src/cli.ts"), "config", "provider", "add", "malicious",
      "--base-url", "https://example.invalid", "--model", "malicious", "--api-key-env", name
    ], { cwd: workspace, env: environment, encoding: "utf8" });
    assert.notEqual(rejectedAlias.status, 0, rejectedAlias.stdout);
    assert.match(rejectedAlias.stderr, /credential.*reserved runtime control/iu);
  }

  const explicit = spawnSync("node", [join(sourceRoot, "apps/cli/src/cli.ts"), "init", "--state", ".odinn"], {
    cwd: workspace,
    env: environment,
    encoding: "utf8"
  });
  assert.equal(explicit.status, 0, explicit.stderr || explicit.stdout);
  assert.equal(JSON.parse(explicit.stdout).state, resolve(projectState));

  const explicitEnvironment = spawnSync("node", [join(sourceRoot, "apps/cli/src/cli.ts"), "init"], {
    cwd: workspace,
    env: isolatedEnvironment(operatorHome, workspace, { ODINN_STATE_DIR: ".odinn" }),
    encoding: "utf8"
  });
  assert.equal(explicitEnvironment.status, 0, explicitEnvironment.stderr || explicitEnvironment.stdout);
  assert.equal(JSON.parse(explicitEnvironment.stdout).state, resolve(projectState));

  const defaultDiagnostics = spawnSync("node", [join(sourceRoot, "apps/cli/src/cli.ts"), "doctor"], {
    cwd: workspace,
    env: environment,
    encoding: "utf8"
  });
  assert.equal(defaultDiagnostics.status, 0, defaultDiagnostics.stderr || defaultDiagnostics.stdout);
  assert.equal(JSON.parse(defaultDiagnostics.stdout).state.runtimeStateOutsideSourceCheckout, true);
  assert.match(defaultDiagnostics.stderr, /repository-local.*--state \.odinn/iu);

  const projectDiagnostics = spawnSync("node", [join(sourceRoot, "apps/cli/src/cli.ts"), "doctor", "--state", ".odinn"], {
    cwd: workspace,
    env: environment,
    encoding: "utf8"
  });
  assert.equal(projectDiagnostics.status, 0, projectDiagnostics.stderr || projectDiagnostics.stdout);
  assert.equal(JSON.parse(projectDiagnostics.stdout).state.runtimeStateOutsideSourceCheckout, false);
});

test("direct gateway ignores cloned state executable, bind, and authentication controls", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "odinn-project-state-gateway-"));
  const workspace = join(fixture, "repository");
  const operatorHome = join(fixture, "operator-home");
  await mkdir(workspace);
  await mkdir(operatorHome);
  await createMaliciousProject(workspace);
  await mkdir(join(operatorHome, ".odinn"));
  await writeFile(join(operatorHome, ".odinn", "config.json"), `${JSON.stringify({ version: 1 })}\n`);

  const child = spawn("node", [join(sourceRoot, "apps/gateway/src/server.ts")], {
    cwd: workspace,
    env: isolatedEnvironment(operatorHome, workspace, { ODINN_PORT: "0" }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => { if (!child.killed) child.kill("SIGTERM"); });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const started: any = await new Promise((resolveStarted, rejectStarted) => {
    let stdout = "";
    const timeout = setTimeout(() => rejectStarted(new Error(`gateway did not start: ${stderr}`)), 20_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      try {
        const parsed = JSON.parse(stdout);
        clearTimeout(timeout);
        resolveStarted(parsed);
      } catch {
        // Startup JSON is still incomplete.
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectStarted(new Error(`gateway exited with ${code}: ${stderr}`));
    });
  });

  assert.equal(started.host, "127.0.0.1");
  assert.equal(started.stateDir, resolve(operatorHome, ".odinn"));
  assert.match(stderr, /repository-local.*ODINN_STATE_DIR=\.odinn/iu);
  const status = await fetch(`http://127.0.0.1:${started.port}/status`);
  assert.equal(status.status, 401);
});

test("the exported gateway factory defaults to operator home state", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "odinn-project-state-factory-"));
  const workspace = join(fixture, "repository");
  const operatorHome = join(fixture, "operator-home");
  await mkdir(workspace);
  await mkdir(operatorHome);
  await createMaliciousProject(workspace);

  const script = [
    `import { createGatewayServer } from ${JSON.stringify(new URL("../apps/gateway/src/server.ts", import.meta.url).href)};`,
    "const server = await createGatewayServer();",
    "await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));",
    "console.log(JSON.stringify(server.address()));",
    "await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));"
  ].join("\n");
  const result = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: workspace,
    env: isolatedEnvironment(operatorHome, workspace),
    encoding: "utf8",
    timeout: 20_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  await access(join(operatorHome, ".odinn", "gateway.token"));
  await assert.rejects(access(join(workspace, ".odinn", "gateway.token")));
});

test("diagnostics report project-local explicit state as inside the workspace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "odinn-project-state-diagnostics-"));
  const stateDir = join(workspace, ".odinn");
  const server = await createGatewayServer({ stateDir, workspaceRoot: workspace });
  await new Promise((resolveListen: any) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const token = (await readFile(join(stateDir, "gateway.token"), "utf8")).trim();
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/diagnostics`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const diagnostics: any = await response.json();
    assert.equal(response.status, 200, JSON.stringify(diagnostics));
    assert.equal(diagnostics.state.runtimeStateOutsideSourceCheckout, false);
  } finally {
    await new Promise((resolveClose: any, rejectClose: any) => server.close((error: any) => error ? rejectClose(error) : resolveClose()));
  }
});

test("diagnostics use physical paths when the workspace is reached through a symlink", { skip: process.platform === "win32" }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "odinn-project-state-physical-"));
  const workspace = join(fixture, "workspace");
  const workspaceAlias = join(fixture, "workspace-alias");
  const stateDir = join(workspace, ".odinn");
  await mkdir(workspace);
  await symlink(workspace, workspaceAlias, "dir");
  const server = await createGatewayServer({ stateDir, workspaceRoot: workspaceAlias });
  await new Promise((resolveListen: any) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const token = (await readFile(join(stateDir, "gateway.token"), "utf8")).trim();
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/diagnostics`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const diagnostics: any = await response.json();
    assert.equal(response.status, 200, JSON.stringify(diagnostics));
    assert.equal(diagnostics.state.runtimeStateOutsideSourceCheckout, false);
  } finally {
    await new Promise((resolveClose: any, rejectClose: any) => server.close((error: any) => error ? rejectClose(error) : resolveClose()));
  }
});
