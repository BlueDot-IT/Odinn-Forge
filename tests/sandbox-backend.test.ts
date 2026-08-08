import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  buildNetworkDeniedOciArgs,
  attestContainerConfiguration,
  compileSandboxProfile,
  detectOciBackend,
  digestOciEngineBinding,
  executeOciProfile,
  MAX_SANDBOX_STDIN_BYTES,
  OciSandboxBackend,
  probeOciBackend,
  SandboxBackendRefusalError,
  SandboxExecutionError,
  selectOciBackend,
  validateDigestPinnedOciImage,
  type OciCapabilityProbe,
  type OciLifecycleAdapter,
  type SandboxProfileInput
} from "../packages/kernel/src/sandbox-backend.ts";

const image = `ghcr.io/bluedot-it/odinn-agent@sha256:${"a".repeat(64)}`;
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function profile(overrides: Partial<SandboxProfileInput> = {}) {
  return compileSandboxProfile({
    backend: "podman",
    image,
    network: "denied",
    argv: ["node", "/bundle/main.js"],
    cwd: "/home/odinn",
    environment: { LANG: "C.UTF-8", ODINN_TEST: "yes" },
    mounts: [{ source: "/srv/odinn/bundle", target: "/bundle", access: "read-only" }],
    limits: {
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      memoryBytes: 256 * 1024 * 1024,
      cpuCount: 0.5,
      processCount: 64,
      tmpfsBytes: 64 * 1024 * 1024
    },
    ...overrides
  });
}

function capability(backend: "podman" | "docker", overrides: Partial<OciCapabilityProbe> = {}): OciCapabilityProbe {
  return Object.freeze({
    schemaVersion: 1,
    backend,
    command: `/usr/bin/${backend}`,
    available: true,
    compatible: true,
    runtimeVersion: "5.0.0",
    containerOs: "linux",
    rootless: backend === "podman",
    hostPlatform: process.platform,
    resourceControls: Object.freeze({ memory: true, memorySwap: true, cpuPeriod: true, cpuQuota: true, pids: true, seccomp: true, evidence: "engine-reported" as const }),
    controlEvidence: Object.freeze({
      status: "capabilities-reported" as const,
      requiredOptions: Object.freeze(["--network=none"]),
      note: "fixture"
    }),
    diagnostic: "fixture",
    ...overrides
  });
}

class FakeChild extends EventEmitter {
  pid = 99_999;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
}

function fakeAdapter(child: FakeChild, controls: string[], capture?: { options?: any; args?: readonly string[] }): OciLifecycleAdapter {
  return {
    prepare: async () => undefined,
    attestContainer: async () => undefined,
    spawn: (_command, args, options) => {
      if (capture) { capture.args = args; capture.options = options; }
      return child;
    },
    control: async (_command, args) => { controls.push(args.join(" ")); },
    terminate: () => { controls.push("terminate-client"); },
    locateManagedContainer: async () => "absent"
  };
}

test("compiled profiles are deterministic, deeply frozen, sorted, and content-bound", () => {
  const first = profile();
  const second = profile({
    environment: { ODINN_TEST: "yes", LANG: "C.UTF-8" },
    mounts: [{ target: "/bundle", access: "read-only", source: "/srv/odinn/bundle" }]
  });
  assert.equal(first.digest, second.digest);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.argv), true);
  assert.equal(Object.isFrozen(first.environment), true);
  assert.equal(Object.isFrozen(first.mounts), true);
  assert.equal(Object.isFrozen(first.mounts[0]), true);
  assert.equal(Object.isFrozen(first.limits), true);
  assert.notEqual(first.digest, profile({ argv: ["node", "/bundle/other.js"] }).digest);
});

test("images require an exact lowercase sha256 digest and reject option injection or mutable tags", () => {
  assert.equal(validateDigestPinnedOciImage(image), image);
  assert.equal(validateDigestPinnedOciImage(`node:24-alpine@sha256:${"b".repeat(64)}`), `node:24-alpine@sha256:${"b".repeat(64)}`);
  for (const invalid of [
    "node:24-alpine",
    `node@sha512:${"a".repeat(128)}`,
    `node@sha256:${"A".repeat(64)}`,
    `--privileged@sha256:${"a".repeat(64)}`,
    `${image}\n--privileged`,
    `registry.example:70000/team/tool@sha256:${"a".repeat(64)}`
  ]) {
    assert.throws(() => validateDigestPinnedOciImage(invalid), SandboxBackendRefusalError);
  }
});

test("profile compilation refuses every network mode until its enforcement backend exists", () => {
  for (const network of ["brokered-public", "allowlisted", "allowlisted-private", "unrestricted"] as const) {
    assert.throws(
      () => profile({ network }),
      (error: unknown) => error instanceof SandboxBackendRefusalError && error.code === "SANDBOX_NETWORK_BROKER_UNAVAILABLE"
    );
  }
});

test("OCI argv enforces the denied profile and carries bounded runtime metadata", () => {
  const compiled = profile();
  const args = buildNetworkDeniedOciArgs(compiled, "odinn-fixture-container");
  const joined = args.join(" ");
  for (const required of [
    "--pull=never", "--network none", "--read-only", "--user 65532:65532", "--cap-drop ALL",
    "--security-opt no-new-privileges", "--pids-limit 64", "--memory 268435456", "--cpus 0.5",
    "--tmpfs /tmp:rw,noexec,nosuid,nodev,size=67108864", `odinn.profile-digest=${compiled.digest}`,
    "odinn.timeout-ms=1000", "odinn.max-output-bytes=1024"
  ]) assert.match(joined, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  assert.equal(args.at(-3), image);
  assert.deepEqual(args.slice(-2), ["node", "/bundle/main.js"]);
  assert.equal(Object.isFrozen(args), true);
  const dockerArgs = buildNetworkDeniedOciArgs(profile({ backend: "docker" }), "odinn-docker-seccomp-fixture");
  assert.ok(dockerArgs.some((value, index) => value === "--security-opt" && dockerArgs[index + 1] === "seccomp=builtin"));
});

test("backend probing produces immutable evidence and selection never falls back from an explicit backend", async () => {
  const runner = (command: string) => command.endsWith("/podman")
    ? { status: 0, stdout: JSON.stringify({ version: { Version: "5.4.0" }, host: { os: "linux", cgroupVersion: "v2", cgroupManager: "systemd", cgroupControllers: ["cpu", "memory", "pids"], security: { rootless: true, seccompEnabled: true } } }), stderr: "" }
    : { status: 0, stdout: JSON.stringify({ OSType: "linux", MemoryLimit: true, SwapLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true, PidsLimit: true, SecurityOptions: ["name=seccomp,profile=builtin"] }), stderr: "" };
  const podman = await probeOciBackend("podman", runner);
  assert.equal(podman.available, true);
  assert.equal(podman.compatible, false);
  assert.equal(podman.rootless, true);
  assert.equal(Object.isFrozen(podman), true);
  assert.equal(Object.isFrozen(podman.controlEvidence), true);
  assert.equal(podman.controlEvidence.status, "unavailable");
  assert.equal((await detectOciBackend("auto", runner)).backend, "docker");
  assert.equal(selectOciBackend("auto", [capability("docker"), capability("podman")]).backend, "podman");
  assert.throws(
    () => selectOciBackend("podman", [capability("docker")]),
    (error: unknown) => error instanceof SandboxBackendRefusalError && error.code === "SANDBOX_BACKEND_UNAVAILABLE"
  );
  assert.throws(
    () => selectOciBackend("auto", [capability("podman", { rootless: "unknown" })], { rootless: "required" }),
    (error: unknown) => error instanceof SandboxBackendRefusalError && error.code === "SANDBOX_BACKEND_UNAVAILABLE"
  );
  const unknownOs = await probeOciBackend("podman", () => ({ status: 0, stdout: JSON.stringify({ version: { Version: "5.4.0" } }), stderr: "" }));
  assert.equal(unknownOs.containerOs, "unknown");
  assert.equal(unknownOs.compatible, false);
});

test("backend probing fails closed when Docker or Podman omits a required resource control", async () => {
  const dockerInfo = {
    OSType: "linux", MemoryLimit: true, SwapLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true, PidsLimit: true,
    SecurityOptions: ["name=rootless", "name=seccomp,profile=builtin"]
  };
  for (const key of ["MemoryLimit", "SwapLimit", "CpuCfsPeriod", "CpuCfsQuota", "PidsLimit"] as const) {
    const info = { ...dockerInfo, [key]: false };
    const probe = await probeOciBackend("docker", () => ({ status: 0, stdout: JSON.stringify(info), stderr: "" }));
    assert.equal(probe.compatible, false, key);
    assert.equal(probe.controlEvidence.status, "unavailable");
  }
  assert.equal((await probeOciBackend("docker", () => ({
    status: 0,
    stdout: JSON.stringify({ ...dockerInfo, SecurityOptions: ["name=seccomp,profile=unconfined"] }),
    stderr: ""
  }))).compatible, false);
  assert.equal((await probeOciBackend("docker", () => ({
    status: 0,
    stdout: JSON.stringify({ ...dockerInfo, SecurityOptions: ["name=seccomp,profile=builtin", "name=seccomp,profile=unconfined"] }),
    stderr: ""
  }))).compatible, false);
  const podmanInfo = { host: { os: "linux", cgroupVersion: "v2", cgroupManager: "systemd", cgroupControllers: ["cpu", "memory", "pids"], security: { rootless: true, seccompEnabled: true } } };
  assert.equal((await probeOciBackend("podman", () => ({ status: 0, stdout: JSON.stringify(podmanInfo), stderr: "" }))).compatible, false);
  for (const info of [
    { host: { ...podmanInfo.host, cgroupControllers: ["cpu", "memory"] } },
    { host: { ...podmanInfo.host, cgroupManager: "disabled" } },
    { host: { ...podmanInfo.host, cgroupVersion: "v1" } }
  ]) assert.equal((await probeOciBackend("podman", () => ({ status: 0, stdout: JSON.stringify(info), stderr: "" }))).compatible, false);
});

test("stopped-container attestation rejects missing, coerced, or changed controls", () => {
  const compiled = profile();
  const identity = { namespaceId: `sbx_${"d".repeat(36)}`, executionId: `sbxexec_${"e".repeat(32)}`, backend: "podman" as const, containerName: "odinn-attestation-fixture", engineBindingDigest: "a".repeat(64) };
  const inspection = {
    State: { Running: false, Paused: false, Restarting: false, Status: "created" },
    Config: { User: "65532:65532", Labels: {
      "odinn.managed": "true",
      "odinn.namespace-id": identity.namespaceId,
      "odinn.execution-id": identity.executionId,
      "odinn.profile-digest": compiled.digest,
      "odinn.image-ref": compiled.image
    } },
    HostConfig: {
      NetworkMode: "none",
      IpcMode: "private",
      CgroupnsMode: "private",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      PidsLimit: compiled.limits.processCount,
      Memory: compiled.limits.memoryBytes,
      MemorySwap: compiled.limits.memoryBytes,
      NanoCpus: Math.round(compiled.limits.cpuCount * 1_000_000_000),
      Tmpfs: { "/tmp": `rw,noexec,nosuid,nodev,size=${compiled.limits.tmpfsBytes}` },
      Mounts: [{ Type: "bind", Source: "/srv/odinn/bundle", Target: "/bundle", ReadOnly: true }]
    }
  };
  assert.doesNotThrow(() => attestContainerConfiguration(compiled, inspection, identity));
  for (const [field, value] of [
    ["PidsLimit", String(compiled.limits.processCount)],
    ["Memory", compiled.limits.memoryBytes - 1],
    ["MemorySwap", undefined],
    ["NanoCpus", 0]
  ] as const) {
    const changed = structuredClone(inspection) as any;
    changed.HostConfig[field] = value;
    assert.throws(() => attestContainerConfiguration(compiled, changed, identity), SandboxBackendRefusalError, field);
  }
  const relabeled = structuredClone(inspection);
  relabeled.Config.Labels["odinn.execution-id"] = `sbxexec_${"f".repeat(32)}`;
  assert.throws(() => attestContainerConfiguration(compiled, relabeled, identity), SandboxBackendRefusalError);
  for (const tmpfs of [
    `rw,noexec,nosuid,nodev,size=${compiled.limits.tmpfsBytes}0`,
    `rw,nosuid,nodev,size=${compiled.limits.tmpfsBytes}`,
    `rw,exec,nosuid,nodev,size=${compiled.limits.tmpfsBytes}`,
    `rw,noexec,nodev,size=${compiled.limits.tmpfsBytes}`,
    `rw,noexec,nosuid,dev,size=${compiled.limits.tmpfsBytes}`
  ]) {
    const changed = structuredClone(inspection) as any;
    changed.HostConfig.Tmpfs["/tmp"] = tmpfs;
    assert.throws(() => attestContainerConfiguration(compiled, changed, identity), SandboxBackendRefusalError, tmpfs);
  }
  const running = structuredClone(inspection) as any;
  running.State.Running = true;
  running.State.Status = "running";
  assert.throws(() => attestContainerConfiguration(compiled, running, identity), SandboxBackendRefusalError);
  for (const readOnly of ["false", 1, undefined]) {
    const changed = structuredClone(inspection) as any;
    changed.HostConfig.Mounts[0].ReadOnly = readOnly;
    assert.throws(() => attestContainerConfiguration(compiled, changed, identity), SandboxBackendRefusalError);
  }
  const dockerProfile = profile({ backend: "docker" });
  const dockerInspection = structuredClone(inspection) as any;
  dockerInspection.Config.Labels["odinn.profile-digest"] = dockerProfile.digest;
  dockerInspection.HostConfig.SecurityOpt.push("seccomp=builtin");
  assert.doesNotThrow(() => attestContainerConfiguration(dockerProfile, dockerInspection, { ...identity, backend: "docker" }));
  dockerInspection.HostConfig.SecurityOpt = ["no-new-privileges", "seccomp=unconfined"];
  assert.throws(() => attestContainerConfiguration(dockerProfile, dockerInspection, { ...identity, backend: "docker" }), SandboxBackendRefusalError);
  for (const selectors of [
    ["no-new-privileges", "seccomp=builtin", "seccomp=unconfined"],
    ["no-new-privileges", "seccomp=unconfined", "seccomp=builtin"]
  ]) {
    dockerInspection.HostConfig.SecurityOpt = selectors;
    assert.throws(() => attestContainerConfiguration(dockerProfile, dockerInspection, { ...identity, backend: "docker" }), SandboxBackendRefusalError);
  }
  for (const selectors of [
    ["no-new-privileges", "no-new-privileges=false", "seccomp=builtin"],
    ["no-new-privileges=false", "no-new-privileges", "seccomp=builtin"],
    ["no-new-privileges", "no-new-privileges=true", "seccomp=builtin"]
  ]) {
    dockerInspection.HostConfig.SecurityOpt = selectors;
    assert.throws(() => attestContainerConfiguration(dockerProfile, dockerInspection, { ...identity, backend: "docker" }), SandboxBackendRefusalError);
  }
  for (const field of ["Privileged", "Devices", "DeviceRequests", "Binds", "PidMode", "IpcMode", "UTSMode", "UsernsMode"]) {
    const changed = structuredClone(inspection) as any;
    changed.HostConfig[field] = ["Devices", "DeviceRequests", "Binds"].includes(field) ? [{}] : field.endsWith("Mode") ? "host" : true;
    assert.throws(() => attestContainerConfiguration(compiled, changed, identity), SandboxBackendRefusalError, field);
  }
});

test("normal OCI execution waits, removes the named container, bounds host environment, and returns bounded output", async (t) => {
  const child = new FakeChild();
  const controls: string[] = [];
  const capture: { options?: any; args?: readonly string[] } = {};
  const state = await mkdtemp(join(tmpdir(), "odinn-sandbox-backend-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const backend = new OciSandboxBackend(capability("podman"), fakeAdapter(child, controls, capture), { recoveryStateDir: state });
  process.env.ODINN_SANDBOX_TEST_SECRET = "must-not-cross";
  const execution = backend.execute(profile());
  for (let index = 0; index < 100 && !capture.args; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(capture.args);
  child.stdout.write("hello");
  child.stderr.write("warning");
  child.emit("close", 0, null);
  const result = await execution;
  delete process.env.ODINN_SANDBOX_TEST_SECRET;
  assert.equal(result.stdout, "hello");
  assert.equal(result.stderr, "warning");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(controls, [`wait ${result.containerName}`, `rm --force --volumes ${result.containerName}`]);
  assert.equal(capture.options.env.ODINN_SANDBOX_TEST_SECRET, undefined);
  assert.deepEqual(Object.keys(capture.options.env).filter((key) => !["PATH", "SystemRoot"].includes(key)), []);
  assert.match(result.containerName, /^odinn-[a-z0-9-]{8,100}$/u);
});

test("the validated absolute engine path remains bound through execution and recovery cleanup", async (t) => {
  const child = new FakeChild();
  const state = await mkdtemp(join(tmpdir(), "odinn-sandbox-engine-binding-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const engine = "/opt/odinn/bin/docker";
  const observed: string[] = [];
  const adapter: OciLifecycleAdapter = {
    prepare: async (command) => { observed.push(`prepare:${command}`); },
    attestContainer: async (command) => { observed.push(`attest:${command}`); },
    spawn: (command) => { observed.push(`spawn:${command}`); return child; },
    control: async (command, args) => { observed.push(`${args[0]}:${command}`); },
    terminate: () => undefined,
    locateManagedContainer: async (command) => { observed.push(`locate:${command}`); return "absent"; }
  };
  const backend = new OciSandboxBackend(capability("docker", { command: engine }), adapter, { recoveryStateDir: state });
  const execution = backend.execute(profile({ backend: "docker" }));
  for (let index = 0; index < 100 && !observed.some((entry) => entry.startsWith("spawn:")); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  child.emit("close", 0, null);
  await execution;

  assert.ok(observed.some((entry) => entry.startsWith("prepare:")));
  assert.ok(observed.some((entry) => entry.startsWith("attest:")));
  assert.ok(observed.some((entry) => entry.startsWith("spawn:")));
  assert.ok(observed.some((entry) => entry.startsWith("wait:")));
  assert.ok(observed.some((entry) => entry.startsWith("rm:")));
  assert.ok(observed.some((entry) => entry.startsWith("locate:")));
  assert.deepEqual(new Set(observed.map((entry) => entry.slice(entry.indexOf(":") + 1))), new Set([engine]));
});

test("normal dispatch cannot clear recovery through a changed engine binding", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "odinn-sandbox-dispatch-binding-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const namespaceId = `sbx_${"a".repeat(36)}`;
  const oldEngine = "/opt/odinn-old/docker";
  const newEngine = "/opt/odinn-new/docker";
  await writeFile(join(state, "sandbox-recovery.json"), `${JSON.stringify({
    schemaVersion: 1,
    namespaceId,
    pending: [{
      namespaceId,
      executionId: `sbxexec_${"b".repeat(32)}`,
      backend: "docker",
      containerName: "odinn-changed-engine-fixture",
      engineBindingDigest: digestOciEngineBinding("docker", oldEngine),
      profileDigest: "c".repeat(64),
      imageDigest: `sha256:${"d".repeat(64)}`,
      phase: "running",
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      reconciliationAttempts: 0
    }]
  })}\n`, { mode: 0o600 });
  let prepareCalled = false;
  let locateCalled = false;
  const adapter: OciLifecycleAdapter = {
    prepare: async () => { prepareCalled = true; },
    attestContainer: async () => undefined,
    spawn: () => new FakeChild(),
    control: async () => undefined,
    terminate: () => undefined,
    locateManagedContainer: async () => { locateCalled = true; return "absent"; }
  };
  const backend = new OciSandboxBackend(capability("docker", { command: newEngine }), adapter, { recoveryStateDir: state });
  await assert.rejects(backend.execute(profile({ backend: "docker" })), /remains quarantined/u);
  assert.equal(prepareCalled, false);
  assert.equal(locateCalled, false);
  const journal = JSON.parse(await readFile(join(state, "sandbox-recovery.json"), "utf8"));
  assert.equal(journal.pending.length, 1);
  assert.equal(journal.pending[0].engineBindingDigest, digestOciEngineBinding("docker", oldEngine));
});

test("invocation stdin is delivered exactly and does not affect the immutable profile digest", async () => {
  const child = new FakeChild();
  const controls: string[] = [];
  const compiled = profile();
  const beforeDigest = compiled.digest;
  const expected = Buffer.from("line one\n\u2603 binary-adjacent\u0000tail", "utf8");
  const received: Buffer[] = [];
  child.stdin.on("data", (chunk: Buffer) => received.push(Buffer.from(chunk)));
  const ended = new Promise<void>((resolve) => child.stdin.once("end", resolve));
  const execution = executeOciProfile("podman", compiled, { stdin: expected, adapter: fakeAdapter(child, controls) });
  await ended;
  child.emit("close", 0, null);
  const result = await execution;
  assert.deepEqual(Buffer.concat(received), expected);
  assert.equal(compiled.digest, beforeDigest);
  assert.equal(result.profileDigest, beforeDigest);
});

test("dispatch evidence is committed before spawn and invocation stdin", async () => {
  const child = new FakeChild();
  const controls: string[] = [];
  const order: string[] = [];
  child.stdin.on("data", () => order.push("stdin"));
  const adapter = fakeAdapter(child, controls);
  const spawn = adapter.spawn;
  adapter.spawn = (...args) => { order.push("spawn"); return spawn(...args); };
  const execution = executeOciProfile("podman", profile(), {
    stdin: "request",
    adapter,
    onDispatchAuthorized: async (evidence) => {
      order.push("dispatch");
      assert.equal(evidence.backend, "podman");
      assert.match(evidence.containerName, /^odinn-/u);
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("close", 0, null);
  await execution;
  assert.deepEqual(order, ["dispatch", "spawn", "stdin"]);
});

test("execution cannot start before asynchronous dispatch evidence commits", async () => {
  const child = new FakeChild();
  const controls: string[] = [];
  let releaseDispatch!: () => void;
  const dispatch = new Promise<void>((resolve) => { releaseDispatch = resolve; });
  let spawned = false;
  const adapter = fakeAdapter(child, controls);
  const spawn = adapter.spawn;
  adapter.spawn = (...args) => { spawned = true; return spawn(...args); };
  const execution = executeOciProfile("podman", profile(), {
    adapter,
    onDispatchAuthorized: () => dispatch
  });
  await nextTurn();
  assert.equal(spawned, false);
  releaseDispatch();
  await nextTurn();
  assert.equal(spawned, true);
  child.emit("close", 0, null);
  assert.equal((await execution).exitCode, 0);
});

test("failed pre-start audit removes the stopped container and never spawns hostile code", async () => {
  const child = new FakeChild();
  const controls: string[] = [];
  let spawned = false;
  const adapter = fakeAdapter(child, controls);
  adapter.spawn = () => { spawned = true; return child; };
  await assert.rejects(
    executeOciProfile("podman", profile(), { adapter, onDispatchAuthorized: () => { throw new Error("audit unavailable"); } }),
    (error: unknown) => error instanceof SandboxBackendRefusalError && error.code === "SANDBOX_AUDIT_COMMIT_FAILED"
  );
  assert.equal(spawned, false);
  assert.match(controls[0] ?? "", /^rm --force --volumes odinn-/u);
});

test("a delayed daemon create remains durably quarantined after the control client fails", async (t) => {
  const child = new FakeChild();
  const state = await mkdtemp(join(tmpdir(), "odinn-sandbox-create-uncertain-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  let containerPresent = false;
  let enteredSecondExecution = false;
  const adapter: OciLifecycleAdapter = {
    prepare: async () => {
      setTimeout(() => { containerPresent = true; }, 100);
      throw new Error("control client timed out before the daemon request settled");
    },
    attestContainer: async () => undefined,
    spawn: () => child,
    control: async (_command, args) => {
      if (args[0] === "rm") containerPresent = false;
    },
    terminate: () => undefined,
    locateManagedContainer: async () => containerPresent ? "present" : "absent"
  };
  const backend = new OciSandboxBackend(capability("podman"), adapter, { recoveryStateDir: state });

  await assert.rejects(
    backend.execute(profile()),
    (error: unknown) => error instanceof SandboxBackendRefusalError && error.code === "SANDBOX_CREATE_UNCERTAIN"
  );
  const firstJournal = JSON.parse(await readFile(join(state, "sandbox-recovery.json"), "utf8"));
  assert.equal(firstJournal.pending.length, 1);
  assert.equal(firstJournal.pending[0].reasonCode, "SANDBOX_CREATE_UNCERTAIN");

  await assert.rejects(
    backend.recovery.runExclusive(adapter, async () => { enteredSecondExecution = true; }),
    /backend remains quarantined/u
  );
  assert.equal(enteredSecondExecution, false);
  const quarantinedJournal = JSON.parse(await readFile(join(state, "sandbox-recovery.json"), "utf8"));
  assert.equal(quarantinedJournal.pending.length, 1);
  assert.equal(quarantinedJournal.pending[0].reasonCode, "SANDBOX_CREATE_UNCERTAIN");

  await new Promise((resolve) => setTimeout(resolve, 125));
  assert.equal(containerPresent, true, "the delayed daemon create must materialize after the point-in-time absence observation");
});

test("oversized stdin is refused before backend dispatch", async () => {
  const child = new FakeChild();
  let spawned = false;
  const adapter: OciLifecycleAdapter = {
    prepare: async () => undefined,
    attestContainer: async () => undefined,
    spawn: () => { spawned = true; return child; },
    control: async () => undefined,
    terminate: () => undefined,
    locateManagedContainer: async () => "absent"
  };
  await assert.rejects(
    executeOciProfile("podman", profile(), { stdin: Buffer.alloc(MAX_SANDBOX_STDIN_BYTES + 1), adapter }),
    (error: unknown) => error instanceof SandboxBackendRefusalError && error.code === "SANDBOX_STDIN_TOO_LARGE"
  );
  assert.equal(spawned, false);
});

test("images declaring writable OCI volumes are refused before dispatch", async () => {
  const child = new FakeChild();
  let spawned = false;
  const adapter: OciLifecycleAdapter = {
    prepare: async () => undefined,
    attestContainer: async () => undefined,
    spawn: () => { spawned = true; return child; },
    control: async () => undefined,
    terminate: () => undefined,
    locateManagedContainer: async () => "absent",
    inspectImage: async () => ({ declaredVolumes: ["/data"] })
  };
  await assert.rejects(
    executeOciProfile("podman", profile(), { adapter }),
    (error: unknown) => error instanceof SandboxBackendRefusalError && error.code === "SANDBOX_IMAGE_VOLUME_UNSUPPORTED"
  );
  assert.equal(spawned, false);
});

test("stdin pipe errors settle the named container", async () => {
  const child = new FakeChild();
  const controls: string[] = [];
  const execution = executeOciProfile("podman", profile(), { stdin: "request", adapter: fakeAdapter(child, controls) });
  await nextTurn();
  child.stdin.emit("error", new Error("stdin closed"));
  await assert.rejects(
    execution,
    (error: unknown) => error instanceof SandboxExecutionError && error.code === "SANDBOX_RUNTIME_ERROR"
  );
  assert.equal(controls[0], "terminate-client");
  assert.match(controls[1]!, /^kill odinn-/u);
});

test("abort kills and waits for the named container before removing it", async () => {
  const child = new FakeChild();
  const controls: string[] = [];
  const controller = new AbortController();
  const execution = executeOciProfile("podman", profile(), { signal: controller.signal, adapter: fakeAdapter(child, controls) });
  await nextTurn();
  controller.abort();
  await assert.rejects(
    execution,
    (error: unknown) => error instanceof SandboxExecutionError
      && error.code === "SANDBOX_CANCELLED"
      && error.result.cancelled === true
      && error.result.stdoutBytes <= 1_024
  );
  const name = controls[1]!.split(" ")[1];
  assert.deepEqual(controls, ["terminate-client", `kill ${name}`, `wait ${name}`, `rm --force --volumes ${name}`]);
});

test("output floods are retained only to the configured ceiling and settle the container tree", async () => {
  const child = new FakeChild();
  const controls: string[] = [];
  const execution = executeOciProfile("podman", profile(), { adapter: fakeAdapter(child, controls) });
  await nextTurn();
  child.stdout.write(Buffer.alloc(2_048, 0x61));
  await assert.rejects(
    execution,
    (error: unknown) => error instanceof SandboxExecutionError
      && error.code === "SANDBOX_OUTPUT_LIMIT"
      && error.result.outputTruncated === true
      && error.result.stdoutBytes === 1_024
      && Buffer.byteLength(error.result.stdout) === 1_024
  );
  assert.equal(controls[0], "terminate-client");
  assert.match(controls[1]!, /^kill odinn-/u);
});

test("timeout settles through kill and wait", async () => {
  const child = new FakeChild();
  const controls: string[] = [];
  const execution = executeOciProfile("podman", profile({
    limits: { timeoutMs: 100, maxOutputBytes: 1_024, memoryBytes: 256 * 1024 * 1024, cpuCount: 0.5, processCount: 64, tmpfsBytes: 64 * 1024 * 1024 }
  }), { adapter: fakeAdapter(child, controls) });
  await assert.rejects(
    execution,
    (error: unknown) => error instanceof SandboxExecutionError && error.code === "SANDBOX_TIMEOUT" && error.result.timedOut
  );
  assert.equal(controls[0], "terminate-client");
  assert.match(controls[1]!, /^kill odinn-/u);
});

test("failed lifecycle controls still settle and report uncertain cleanup", async () => {
  const child = new FakeChild();
  const controller = new AbortController();
  const adapter: OciLifecycleAdapter = {
    prepare: async () => undefined,
    attestContainer: async () => undefined,
    spawn: () => child,
    control: async (_command, args) => { throw new Error(`${args[0]} unavailable`); },
    terminate: () => undefined
  };
  const execution = executeOciProfile("podman", profile(), { signal: controller.signal, adapter });
  await nextTurn();
  controller.abort();
  await assert.rejects(
    execution,
    (error: unknown) => error instanceof SandboxExecutionError
      && error.code === "SANDBOX_CANCELLED"
      && error.result.cleanupUncertain
      && error.result.cleanupDiagnostics.some((entry) => entry.startsWith("kill:"))
      && error.result.cleanupDiagnostics.some((entry) => entry.startsWith("wait:"))
      && error.result.cleanupDiagnostics.some((entry) => entry.startsWith("rm:"))
  );
});

test("normal close refuses when failed cleanup cannot prove absence", async () => {
  const child = new FakeChild();
  const adapter: OciLifecycleAdapter = {
    prepare: async () => undefined,
    attestContainer: async () => undefined,
    spawn: () => child,
    control: async (_command, args) => { throw new Error(`${args[0]} unavailable`); },
    terminate: () => undefined
  };
  const execution = executeOciProfile("podman", profile(), { adapter });
  await nextTurn();
  child.emit("close", 0, null);
  await assert.rejects(
    execution,
    (error: unknown) => error instanceof SandboxExecutionError
      && error.code === "SANDBOX_CLEANUP_UNCERTAIN"
      && error.result.cleanupUncertain
      && error.result.cleanupDiagnostics.some((entry) => entry.startsWith("wait:"))
      && error.result.cleanupDiagnostics.some((entry) => entry.startsWith("rm:"))
  );
});

test("runtime-client errors reject after bounded cleanup even when termination throws", async () => {
  const child = new FakeChild();
  const adapter: OciLifecycleAdapter = {
    prepare: async () => undefined,
    attestContainer: async () => undefined,
    spawn: () => child,
    control: async () => undefined,
    terminate: () => { throw new Error("termination fixture"); }
  };
  const execution = executeOciProfile("podman", profile(), { adapter });
  await nextTurn();
  child.emit("error", new Error("runtime pipe failed"));
  await assert.rejects(
    execution,
    (error: unknown) => error instanceof SandboxExecutionError
      && error.code === "SANDBOX_RUNTIME_ERROR"
      && error.result.cleanupUncertain
      && error.result.cleanupDiagnostics.some((entry) => entry.startsWith("client-termination:"))
  );
});

test("an abort racing spawn is rechecked and settled", async () => {
  const child = new FakeChild();
  const controls: string[] = [];
  const controller = new AbortController();
  const adapter = fakeAdapter(child, controls);
  const racing: OciLifecycleAdapter = {
    ...adapter,
    spawn: (...args) => {
      const spawned = adapter.spawn(...args);
      controller.abort();
      return spawned;
    }
  };
  await assert.rejects(
    executeOciProfile("podman", profile(), { signal: controller.signal, adapter: racing }),
    (error: unknown) => error instanceof SandboxExecutionError && error.code === "SANDBOX_CANCELLED"
  );
  assert.equal(controls[0], "terminate-client");
  assert.match(controls[1]!, /^kill odinn-/u);
});
