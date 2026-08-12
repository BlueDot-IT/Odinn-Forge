import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInferenceProtocolSmoke } from "./inference-smoke.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    shell: process.platform === "win32"
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.error?.message ?? `exit ${result.status ?? "unknown"}`}`
    );
  }
}

export async function runCompiledInferenceSmoke(): Promise<void> {
  run("corepack", ["pnpm", "build"]);
  run("corepack", ["pnpm", "release:package"]);

  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const packageRoot = join(root, "dist", "package-stage", `odinn-v${pkg.version}`);
  const gatewayCommand = join(
    packageRoot,
    "bin",
    process.platform === "win32" ? "odinn-gateway.cmd" : "odinn-gateway"
  );
  const launcher = await readFile(gatewayCommand, "utf8");
  if (!/dist[\\/]gateway[\\/]server\.js/u.test(launcher)) {
    throw new Error(`compiled gateway launcher does not target the packaged server: ${gatewayCommand}`);
  }

  const output = await runInferenceProtocolSmoke({
    root: packageRoot,
    gatewayCommand,
    gatewayArgs: []
  });
  if (output.content !== "ODINN_PACKAGED_GATEWAY_OK") {
    throw new Error(`compiled gateway inference smoke returned unexpected content: ${JSON.stringify(output)}`);
  }
  console.log(output.content);
}

export function isMainModule(moduleUrl: string, argv1 = process.argv[1]): boolean {
  return Boolean(argv1) && moduleUrl === pathToFileURL(argv1).href;
}

if (isMainModule(import.meta.url)) {
  await runCompiledInferenceSmoke();
}
