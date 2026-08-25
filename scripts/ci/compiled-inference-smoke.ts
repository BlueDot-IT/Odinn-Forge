import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInferenceProtocolSmoke } from "./inference-smoke.ts";
import { spawnPnpmSync } from "../lib/package-manager.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export async function runCompiledInferenceSmoke(): Promise<void> {
  const build = spawnPnpmSync(["build"], { cwd: root, encoding: "utf8", env: process.env });
  if (build.stdout) process.stdout.write(build.stdout);
  if (build.stderr) process.stderr.write(build.stderr);
  if (build.error || build.status !== 0) throw new Error(`pnpm build failed: ${build.error?.message ?? `exit ${build.status ?? "unknown"}`}`);
  const packaged = spawnPnpmSync(["release:package"], { cwd: root, encoding: "utf8", env: process.env });
  if (packaged.stdout) process.stdout.write(packaged.stdout);
  if (packaged.stderr) process.stderr.write(packaged.stderr);
  if (packaged.error || packaged.status !== 0) throw new Error(`pnpm release:package failed: ${packaged.error?.message ?? `exit ${packaged.status ?? "unknown"}`}`);

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
