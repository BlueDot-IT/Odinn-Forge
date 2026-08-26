import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const releaseDir = resolve(process.argv[2] ?? join(root, "dist/release"));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const target = `${process.platform}-${process.arch}`;
if (!['linux-x64', 'darwin-x64', 'win32-x64'].includes(target)) throw new Error(`unsupported standalone smoke platform: ${target}`);
const extension = target === "win32-x64" ? "zip" : "tar.gz";
const archive = join(releaseDir, `odinn-v${pkg.version}-standalone-${target}.${extension}`);
const temporary = await mkdtemp(join(tmpdir(), "odinn standalone ünicode "));
function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, shell: process.platform === "win32" && command.endsWith(".cmd") });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout || result.error?.message}`);
  return result.stdout;
}
try {
  if (process.platform === "win32") run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${temporary.replaceAll("'", "''")}' -Force`], root);
  else run("tar", ["-xzf", archive, "-C", temporary], root);
  const packageRoot = join(temporary, `odinn-v${pkg.version}-standalone-${target}`);
  const fakeBin = join(temporary, "hostile-path"); await mkdir(fakeBin);
  if (process.platform === "win32") await writeFile(join(fakeBin, "node.cmd"), "@exit /b 99\r\n");
  else { await writeFile(join(fakeBin, "node"), "#!/bin/sh\nexit 99\n"); await chmod(join(fakeBin, "node"), 0o755); }
  const launcher = join(packageRoot, "bin", process.platform === "win32" ? "odinn.cmd" : "odinn");
  const version = run(launcher, ["--version"], packageRoot, { PATH: `${fakeBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`, NODE_OPTIONS: "--require=/definitely/not/allowed.js", NODE_PATH: "/hostile/modules" }).trim();
  if (version !== pkg.version) throw new Error(`standalone launcher reported ${version}`);
  const prefix = join(temporary, "installed ünicode");
  if (process.platform === "win32") run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(packageRoot, "install", "install.ps1"), "-Prefix", prefix], packageRoot, { NODE_OPTIONS: "--require=/definitely/not/allowed.js" });
  else run(join(packageRoot, "install", "install.sh"), ["--prefix", prefix], packageRoot, { NODE_OPTIONS: "--require=/definitely/not/allowed.js" });
  const installed = join(prefix, "bin", process.platform === "win32" ? "odinn.cmd" : "odinn");
  if (run(installed, ["--version"], temporary, { PATH: `${fakeBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`, NODE_OPTIONS: "--require=/definitely/not/allowed.js" }).trim() !== pkg.version) throw new Error("installed standalone launcher failed");
  const state = JSON.parse(await readFile(join(prefix, "install-state.json"), "utf8"));
  const metadata = JSON.parse(await readFile(join(prefix, "versions", state.current, "install-metadata.json"), "utf8"));
  if (metadata.toolchain?.distribution !== "standalone" || metadata.toolchain?.embeddedRuntime?.version !== "24.19.0") throw new Error("installed runtime identity is incomplete");
  console.log(`verified controlled standalone runtime on ${target}`);
} finally { await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
