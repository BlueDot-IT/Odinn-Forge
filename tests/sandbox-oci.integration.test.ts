import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OciSandboxBackend,
  SandboxBackendRefusalError,
  SandboxExecutionError,
  compileSandboxProfile,
  probeOciBackend,
  reconcileSandboxRecovery,
  type OciBackendId
} from "../packages/kernel/src/sandbox-backend.ts";

const backend = String(process.env.ODINN_TEST_OCI_BACKEND ?? "docker") as OciBackendId;
const image = String(process.env.ODINN_TEST_OCI_IMAGE ?? "");
const enabled = process.env.ODINN_RUN_OCI_TESTS === "1" && Boolean(image);
const volumeImage = String(process.env.ODINN_TEST_OCI_VOLUME_IMAGE ?? "");

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for real OCI lifecycle evidence");
}

function containerExists(command: string, name: string): boolean {
  return spawnSync(command, ["container", "inspect", name], { encoding: "utf8", shell: false, timeout: 10_000 }).status === 0;
}

function containerIsRunning(command: string, name: string): boolean {
  const result = spawnSync(command, ["container", "inspect", name, "--format", "{{json .State}}"], { encoding: "utf8", shell: false, timeout: 10_000 });
  if (result.status !== 0) return false;
  try { return JSON.parse(String(result.stdout)).Running === true; }
  catch { return false; }
}

test("real OCI execution enforces the network-denied read-only boundary", { skip: !enabled }, async () => {
  if (backend !== "docker" && backend !== "podman") throw new Error("ODINN_TEST_OCI_BACKEND must be docker or podman");
  const directory = await mkdtemp(join(tmpdir(), "odinn-sandbox-oci-"));
  const grant = join(directory, "grant");
  await mkdir(grant);
  await writeFile(join(grant, "input.txt"), "immutable-input\n");
  process.env.ODINN_SANDBOX_HOST_SECRET = "must-not-cross-boundary";
  try {
    const capability = await probeOciBackend(backend);
    assert.equal(capability.available, true, capability.diagnostic);
    assert.equal(capability.compatible, true, capability.diagnostic);
    const script = [
      "set -eu",
      "printf 'uid=%s\\n' \"$(id -u)\"",
      "printf 'cap=%s\\n' \"$(awk '/^CapEff:/{print $2}' /proc/self/status)\"",
      "printf 'nnp=%s\\n' \"$(awk '/^NoNewPrivs:/{print $2}' /proc/self/status)\"",
      "printf 'seccomp=%s\\n' \"$(awk '/^Seccomp:/{print $2}' /proc/self/status)\"",
      "printf 'rootopts=%s\\n' \"$(awk '$2==\"/\"{print $4}' /proc/mounts)\"",
      "printf 'grantopts=%s\\n' \"$(awk '$2==\"/grant\"{print $4}' /proc/mounts)\"",
      "printf 'routes=%s\\n' \"$(tail -n +2 /proc/net/route | wc -l | tr -d ' ')\"",
      "printf 'secret=%s\\n' \"${ODINN_SANDBOX_HOST_SECRET-unset}\"",
      "printf 'visible=%s\\n' \"${VISIBLE-unset}\"",
      "printf 'input=%s\\n' \"$(cat /grant/input.txt)\"",
      "printf 'memory_max=%s\\n' \"$(cat /sys/fs/cgroup/memory.max)\"",
      "printf 'memory_swap_max=%s\\n' \"$(cat /sys/fs/cgroup/memory.swap.max)\"",
      "printf 'cpu_max=%s\\n' \"$(cat /sys/fs/cgroup/cpu.max)\"",
      "printf 'pids_max=%s\\n' \"$(cat /sys/fs/cgroup/pids.max)\"",
      "touch /tmp/writable",
      "if touch /grant/blocked 2>/dev/null; then echo grant_write=allowed; else echo grant_write=denied; fi",
      "if touch /rootfs-proof 2>/dev/null; then echo root_write=allowed; else echo root_write=denied; fi",
      "if test -S /var/run/docker.sock || test -S /run/docker.sock; then echo socket=present; else echo socket=absent; fi"
    ].join("; ");
    const profile = compileSandboxProfile({
      backend,
      image,
      network: "denied",
      argv: ["/bin/sh", "-c", script],
      cwd: "/tmp",
      environment: { VISIBLE: "approved" },
      mounts: [{ source: grant, target: "/grant", access: "read-only" }],
      limits: {
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
        memoryBytes: 256 * 1024 * 1024,
        cpuCount: 1,
        processCount: 64,
        tmpfsBytes: 64 * 1024 * 1024
      }
    });
    const result = await new OciSandboxBackend(capability, undefined, { recoveryStateDir: join(directory, "state") }).execute(profile);
    assert.equal(result.exitCode, 0, result.stderr);
    const values = Object.fromEntries(result.stdout.trim().split("\n").map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    assert.equal(values.uid, "65532");
    assert.equal(values.cap, "0000000000000000");
    assert.equal(values.nnp, "1");
    assert.equal(values.seccomp, "2");
    assert.match(values.rootopts, /(?:^|,)ro(?:,|$)/u);
    assert.match(values.grantopts, /(?:^|,)ro(?:,|$)/u);
    assert.equal(values.routes, "0");
    assert.equal(values.secret, "unset");
    assert.equal(values.visible, "approved");
    assert.equal(values.input, "immutable-input");
    assert.equal(values.memory_max, String(256 * 1024 * 1024));
    assert.equal(values.memory_swap_max, "0");
    const [cpuQuota, cpuPeriod] = values.cpu_max.split(" ").map(Number);
    assert.equal(cpuQuota / cpuPeriod, 1);
    assert.equal(values.pids_max, "64");
    assert.equal(values.grant_write, "denied");
    assert.equal(values.root_write, "denied");
    assert.equal(values.socket, "absent");
    const inspection = spawnSync(capability.command, ["container", "inspect", result.containerName], {
      encoding: "utf8",
      shell: false,
      timeout: 10_000
    });
    assert.notEqual(inspection.status, 0, "the settled sandbox container must be removed");
  } finally {
    delete process.env.ODINN_SANDBOX_HOST_SECRET;
    await rm(directory, { recursive: true, force: true });
  }
});

test("real OCI execution refuses images with declared writable volumes", { skip: !enabled || !volumeImage }, async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-sandbox-volume-"));
  const capability = await probeOciBackend(backend);
  const profile = compileSandboxProfile({
    backend,
    image: volumeImage,
    network: "denied",
    argv: ["/bin/true"],
    cwd: "/tmp",
    limits: {
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
      memoryBytes: 256 * 1024 * 1024,
      cpuCount: 1,
      processCount: 64,
      tmpfsBytes: 64 * 1024 * 1024
    }
  });
  try {
    await assert.rejects(
      new OciSandboxBackend(capability, undefined, { recoveryStateDir: state }).execute(profile),
      (error: unknown) => error instanceof SandboxBackendRefusalError && error.code === "SANDBOX_IMAGE_VOLUME_UNSUPPORTED"
    );
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test("real OCI cancellation and timeout settle the whole container tree and recovery journal", { skip: !enabled }, async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-sandbox-lifecycle-"));
  try {
    const capability = await probeOciBackend(backend);
    for (const mode of ["cancel", "timeout"] as const) {
      const state = join(root, mode);
      const controller = new AbortController();
      const profile = compileSandboxProfile({
        backend,
        image,
        network: "denied",
        argv: ["/bin/sh", "-c", "sleep 30 & wait"],
        cwd: "/tmp",
        limits: {
          timeoutMs: mode === "timeout" ? 300 : 10_000,
          maxOutputBytes: 16 * 1024,
          memoryBytes: 256 * 1024 * 1024,
          cpuCount: 1,
          processCount: 32,
          tmpfsBytes: 32 * 1024 * 1024
        }
      });
      const execution = new OciSandboxBackend(capability, undefined, { recoveryStateDir: state }).execute(profile, { signal: controller.signal });
      if (mode === "cancel") {
        await waitFor(async () => {
          try {
            const journal = JSON.parse(await readFile(join(state, "sandbox-recovery.json"), "utf8"));
            const pending = journal.pending?.[0];
            return pending?.phase === "running" && containerIsRunning(capability.command, pending.containerName) ? true : undefined;
          } catch { return undefined; }
        });
        controller.abort();
      }
      let failure: SandboxExecutionError | undefined;
      try { await execution; }
      catch (error) { if (error instanceof SandboxExecutionError) failure = error; else throw error; }
      assert.ok(failure);
      assert.equal(failure.code, mode === "cancel" ? "SANDBOX_CANCELLED" : "SANDBOX_TIMEOUT");
      assert.equal(containerExists(capability.command, failure.result.containerName), false);
      const journal = JSON.parse(await readFile(join(state, "sandbox-recovery.json"), "utf8"));
      assert.equal(journal.pending.length, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real OCI crash reconciliation removes the exact identity-bound container", { skip: !enabled }, async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-sandbox-crash-"));
  const state = join(root, "state");
  const childScript = join(root, "crash-child.mjs");
  const backendModule = new URL("../packages/kernel/src/sandbox-backend.ts", import.meta.url).href;
  const capability = await probeOciBackend(backend);
  await writeFile(childScript, `
    import { OciSandboxBackend, compileSandboxProfile, probeOciBackend } from ${JSON.stringify(backendModule)};
    const backend = ${JSON.stringify(backend)};
    const command = ${JSON.stringify(capability.command)};
    const capability = await probeOciBackend(backend, undefined, { executablePaths: { [backend]: command } });
    const profile = compileSandboxProfile({ backend, image: ${JSON.stringify(image)}, network: "denied", argv: ["/bin/sh", "-c", "sleep 60 & wait"], cwd: "/tmp", limits: { timeoutMs: 120000, maxOutputBytes: 16384, memoryBytes: 268435456, cpuCount: 1, processCount: 32, tmpfsBytes: 33554432 } });
    await new OciSandboxBackend(capability, undefined, { recoveryStateDir: ${JSON.stringify(state)} }).execute(profile);
  `);
  const child = spawn(process.execPath, [childScript], { stdio: ["ignore", "ignore", "pipe"], env: { PATH: "/usr/bin:/bin" } });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const record = await waitFor(async () => {
      try {
        const journal = JSON.parse(await readFile(join(state, "sandbox-recovery.json"), "utf8"));
        const pending = journal.pending?.[0];
        return pending?.phase === "running" && containerIsRunning(capability.command, pending.containerName) ? pending : undefined;
      } catch { return undefined; }
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    await reconcileSandboxRecovery(state, { [backend]: capability.command });
    assert.equal(containerExists(capability.command, record.containerName), false, stderr);
    const journal = JSON.parse(await readFile(join(state, "sandbox-recovery.json"), "utf8"));
    assert.equal(journal.pending.length, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
