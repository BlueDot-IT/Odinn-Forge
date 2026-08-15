import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const releaseDir = resolve(process.argv[2] ?? join(root, "dist", "release"));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const expectedRoot = `odinn-v${pkg.version}`;

function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && command.endsWith(".cmd")
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return result.stdout;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function startGateway(command: string, args: string[], cwd: string, state: string) {
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      INIT_CWD: cwd,
      ODINN_STATE_DIR: state,
      ODINN_HOST: "127.0.0.1",
      ODINN_PORT: "0"
    },
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const match = stdout.match(/"port"\s*:\s*(\d+)/);
    if (match && Number(match[1]) > 0) {
      const base = `http://127.0.0.1:${match[1]}`;
      const bootstrap = await fetch(`${base}/`);
      const setCookie = typeof bootstrap.headers.getSetCookie === "function"
        ? bootstrap.headers.getSetCookie()[0]
        : bootstrap.headers.get("set-cookie");
      const cookie = setCookie?.split(";", 1)[0];
      if (!cookie) throw new Error("compiled gateway did not issue its bootstrap cookie");
      return { child, base, cookie };
    }
    if (child.exitCode !== null) {
      throw new Error(`compiled gateway exited before binding: ${stderr || stdout || "no output"}`);
    }
    await delay(100);
  }
  child.kill();
  throw new Error(`compiled gateway did not bind: ${stderr || stdout || "no output"}`);
}

async function stopGateway(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveClose, rejectClose) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectClose(new Error("compiled gateway did not stop cleanly"));
    }, 10_000);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || signal === "SIGTERM") resolveClose();
      else rejectClose(new Error(`compiled gateway stopped with ${code ?? signal}`));
    });
  });
}

for (const extension of ["zip", "tar.gz"]) {
  const archive = join(releaseDir, `${expectedRoot}.${extension}`);
  const destination = await mkdtemp(join(tmpdir(), "odinn-install-smoke-"));
  try {
    if (extension === "zip") {
      if (process.platform === "win32") {
        const escapedArchive = archive.replaceAll("'", "''");
        const escapedDestination = destination.replaceAll("'", "''");
        run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`], root);
      } else {
        run("unzip", ["-q", archive, "-d", destination], root);
      }
    } else {
      run("tar", ["-xzf", archive, "-C", destination], root);
    }

    const packageRoot = join(destination, expectedRoot);
    const prefix = join(destination, "installed");
    const workspace = join(destination, "workspace");
    const state = join(destination, "state");
    await mkdir(workspace, { recursive: true });

    if (process.platform === "win32") {
      run("powershell", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(packageRoot, "install", "install.ps1"),
        "-Prefix",
        prefix
      ], workspace);
    } else {
      run(join(packageRoot, "install", "install.sh"), ["--prefix", prefix], workspace);
    }

    const cli = join(prefix, "bin", process.platform === "win32" ? "odinn.cmd" : "odinn");
    let gatewayCommand = join(prefix, "bin", "odinn-gateway");
    let gatewayArgs: string[] = [];
    if (process.platform === "win32") {
      const installState = JSON.parse(await readFile(join(prefix, "install-state.json"), "utf8"));
      gatewayCommand = process.execPath;
      gatewayArgs = [join(prefix, "versions", installState.current, "dist", "gateway", "server.js")];
    }
    const version = run(cli, ["--version"], workspace).trim();
    if (version !== pkg.version) throw new Error(`installed ${basename(archive)} reported version ${version}`);

    run(cli, ["onboard", "--state", state], workspace, { INIT_CWD: workspace });
    const inputFile = join(workspace, "compiled-smoke-input.json");
    await writeFile(inputFile, `${JSON.stringify({ text: "ODINN_COMPILED_INSTALL_OK" })}\n`);
    const tool = run(cli, [
      "run",
      "--tool",
      "text.echo",
      "--input-file",
      inputFile,
      "--state",
      state
    ], workspace, { INIT_CWD: workspace });
    if (!tool.includes("ODINN_COMPILED_INSTALL_OK")) {
      throw new Error(`installed ${basename(archive)} did not execute the compiled CLI smoke`);
    }

    const gateway = await startGateway(gatewayCommand, gatewayArgs, workspace, state);
    try {
      const diagnostics = await fetch(`${gateway.base}/diagnostics`, {
        headers: { cookie: gateway.cookie }
      });
      if (!diagnostics.ok) {
        throw new Error(`installed ${basename(archive)} diagnostics returned ${diagnostics.status}`);
      }
      const body = await diagnostics.json();
      if (body?.version !== pkg.version || body?.state?.runtimeStateOutsideSourceCheckout !== true) {
        throw new Error(`installed ${basename(archive)} diagnostics did not report healthy compiled state`);
      }
    } finally {
      await stopGateway(gateway.child);
    }

    const reopened = JSON.parse(run(cli, ["doctor", "--state", state], workspace, { INIT_CWD: workspace }));
    if (!reopened.ok || reopened.version !== pkg.version || reopened.audit?.events < 1) {
      throw new Error(`installed ${basename(archive)} could not reopen persisted state`);
    }
  } finally {
    await rm(destination, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

console.log(`verified compiled install, onboarding, tool execution, gateway diagnostics, clean stop, and state reopen for both Odinn Forge ${pkg.version} archives`);
