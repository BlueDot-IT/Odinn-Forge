import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEnvironmentValues, assertPhysicalDirectory, configuredCredentialEnvironmentKeys, readEnvironmentFiles } from "@odinn/kernel";
import { assertGatewayBinding } from "./security.ts";

type GatewayFactory = (options: { stateDir: string; workspaceRoot: string }) => Promise<any>;

export async function runGatewayEntrypoint({ createGatewayServer, compiledRuntime, moduleUrl, argv = process.argv, environment = process.env }: {
  createGatewayServer: GatewayFactory;
  compiledRuntime: boolean;
  moduleUrl: string;
  argv?: string[];
  environment?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  if (!isGatewayEntrypoint({ argv, compiledRuntime, moduleUrl })) return false;
  const parentEnvironment = { ...environment };
  const parentEnvironmentKeys = new Set(Object.keys(parentEnvironment));
  const workspaceRoot = resolve(parentEnvironment.INIT_CWD ?? process.cwd());
  const stateDir = parentEnvironment.ODINN_STATE_DIR
    ? resolve(workspaceRoot, parentEnvironment.ODINN_STATE_DIR)
    : resolve(homedir(), ".odinn");
  const legacyProjectState = resolve(workspaceRoot, ".odinn");
  if (!parentEnvironment.ODINN_STATE_DIR && existsSync(join(legacyProjectState, "config.json"))) {
    console.error("Notice: repository-local .odinn state is no longer selected automatically. Set ODINN_STATE_DIR=.odinn to adopt it explicitly, or migrate it to ~/.odinn.");
  }
  assertPhysicalDirectory(stateDir);
  const environmentFiles = readEnvironmentFiles({ workspaceRoot, stateDir });
  let config: unknown;
  try { config = JSON.parse(await readFile(join(stateDir, "config.json"), "utf8")); }
  catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  const workspaceCredentialKeys = configuredCredentialEnvironmentKeys(config);
  applyEnvironmentValues(environmentFiles.workspace, process.env, { protectedKeys: parentEnvironmentKeys, allowedKeys: workspaceCredentialKeys });
  applyEnvironmentValues(environmentFiles.state, process.env, { protectedKeys: parentEnvironmentKeys });
  const host = process.env.ODINN_HOST ?? "127.0.0.1";
  assertGatewayBinding(host, {
    allowRemote: process.env.ODINN_ALLOW_REMOTE === "1",
    authenticationDisabled: process.env.ODINN_GATEWAY_AUTH === "off"
  });
  const port = Number.parseInt(process.env.ODINN_PORT ?? "18790", 10);
  const server = await createGatewayServer({ stateDir, workspaceRoot });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close((error: unknown) => {
      if (error) console.error(error);
      process.exitCode = error ? 1 : 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.listen(port, host, () => {
    console.log(JSON.stringify({ ok: true, host, port: server.address().port, stateDir }, null, 2));
  });
  return true;
}

function isGatewayEntrypoint({ argv, compiledRuntime, moduleUrl }: { argv: string[]; compiledRuntime: boolean; moduleUrl: string }): boolean {
  if (!argv[1]) return false;
  const modulePath = fileURLToPath(moduleUrl);
  if (compiledRuntime) return basename(argv[1]) === "server.js" && basename(modulePath) === "server.js";
  try { return realpathSync(resolve(argv[1])) === realpathSync(modulePath); }
  catch { return resolve(argv[1]) === modulePath; }
}
