import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SANDBOX_CONFIG,
  assertHostedSandboxConfig,
  normalizeSandboxConfig,
  summarizeSandboxRisk,
  validateSandboxConfig
} from "../packages/kernel/src/sandbox-config.ts";

test("sandbox defaults are useful, secure, composable, and deeply immutable", () => {
  const config = normalizeSandboxConfig({});
  assert.deepEqual(config.backend, {
    mode: "auto",
    preference: ["rootless-oci", "oci", "confined-native"],
    unavailable: "refuse",
    enginePaths: process.platform === "linux" ? { podman: "/usr/bin/podman", docker: "/usr/bin/docker" } : {}
  });
  assert.equal(config.home.mode, "persistent");
  assert.equal(config.filesystem.sandboxHome, "read-write");
  assert.deepEqual(config.filesystem.grants, []);
  assert.equal(config.network.mode, "brokered-public");
  assert.equal(config.network.allowPrivate, false);
  assert.equal(config.network.allowLoopback, false);
  assert.equal(config.process.enabled, true);
  assert.equal(config.process.shell, true);
  assert.deepEqual(config.environment.inherit, []);
  assert.deepEqual(config.devices.grants, []);
  assert.equal(config.hostExecution.mode, "deny");
  assert.equal(config.hostExecution.scope, "restricted");
  assert.equal(Object.isFrozen(DEFAULT_SANDBOX_CONFIG), true);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.process.limits), true);
  assert.equal(Object.isFrozen(config.backend.preference), true);
  assert.throws(() => (config.network.ports as number[]).push(8080), TypeError);
  assert.throws(() => ((config.process.limits as any).pids = 999), TypeError);
});

test("sandbox accepts explicit broad filesystem, network, device, process, and host access", () => {
  const config = validateSandboxConfig({
    futureTopLevelField: { preserved: true },
    sandbox: {
      backend: { mode: "oci", preference: ["oci"], unavailable: "refuse" },
      home: { mode: "ephemeral", maxBytes: 1024 ** 3 },
      filesystem: {
        sandboxHome: "read-write",
        grants: [{ source: "/home/example", target: "/host-home", access: "read-write" }]
      },
      network: {
        mode: "unrestricted",
        allow: [],
        deny: [{ host: "metadata.example.test", ports: [80] }],
        allowPrivate: true,
        allowLoopback: true,
        ports: [22, 80, 443],
        maxResponseBytes: 32 * 1024 * 1024
      },
      process: {
        enabled: true,
        shell: true,
        limits: { timeoutMs: 600_000, cpu: 4.5, memoryBytes: 4 * 1024 ** 3, pids: 512, tmpfsBytes: 1024 ** 3, outputBytes: 8 * 1024 ** 2 }
      },
      environment: {
        inherit: ["LANG"],
        set: { NODE_ENV: "development" },
        secrets: [{ name: "registry-auth", sourceEnv: "NPM_TOKEN", targetEnv: "NPM_TOKEN" }]
      },
      devices: { grants: [{ source: "/dev/video0", target: "/dev/video0", access: "read-write" }] },
      hostExecution: { mode: "prompt", scope: "all", allowedCommands: [], allowedRoots: [] }
    }
  });
  assert.equal(config.filesystem.grants[0].access, "read-write");
  assert.equal(config.network.mode, "unrestricted");
  assert.equal(config.process.limits.cpu, 4.5);
  assert.equal(config.devices.grants.length, 1);
  assert.equal(config.hostExecution.scope, "all");
});

test("unknown fields fail closed inside sandbox while unrelated top-level fields remain compatible", () => {
  assert.doesNotThrow(() => normalizeSandboxConfig({ nextVersionField: true }));
  assert.throws(() => normalizeSandboxConfig({ sandbox: { surprise: true } }), /config\.sandbox contains unknown field: surprise/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { process: { surprise: true } } }), /config\.sandbox\.process contains unknown field/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { network: { allow: [{ host: "example.com", ports: [443], path: "\/" }] } } }), /contains unknown field: path/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { backend: { enginePaths: { nerdctl: "/usr/bin/nerdctl" } } } }), /contains unknown field: nerdctl/u);
});

test("OCI engine paths are trusted normalized absolutes and never PATH names", () => {
  const posixConfig = normalizeSandboxConfig({ sandbox: { backend: { enginePaths: {
    podman: "/opt/odinn/bin/podman",
    docker: "/usr/local/bin/docker"
  } } } });
  assert.deepEqual(posixConfig.backend.enginePaths, { podman: "/opt/odinn/bin/podman", docker: "/usr/local/bin/docker" });
  const windowsConfig = normalizeSandboxConfig({ sandbox: { backend: { enginePaths: {
    podman: "C:\\Program Files\\RedHat\\Podman\\podman.exe",
    docker: "C:\\Program Files\\Docker\\docker.exe"
  } } } });
  assert.equal(windowsConfig.backend.enginePaths.podman, "C:\\Program Files\\RedHat\\Podman\\podman.exe");
  assert.throws(() => normalizeSandboxConfig({ sandbox: { backend: { enginePaths: { docker: "docker" } } } }), /must be an absolute path/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { backend: { enginePaths: { docker: "/usr/bin/..\/bin/docker" } } } }), /must be a normalized absolute path/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { backend: { enginePaths: { docker: "/usr/bin/podman" } } } }), /must name the docker executable/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { backend: { enginePaths: { docker: "/usr/bin/docker\n--host=attacker" } } } }), /control characters or NUL/u);
});

test("filesystem and device grants require unambiguous absolute sources and targets", () => {
  assert.throws(() => normalizeSandboxConfig({ sandbox: { filesystem: { grants: [{ source: "relative", target: "/work", access: "read-only" }] } } }), /source must be an absolute path/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { filesystem: { grants: [{ source: "/safe", target: "relative", access: "read-only" }] } } }), /target must be a normalized absolute POSIX path/u);
  const windowsSource = normalizeSandboxConfig({ sandbox: { filesystem: { grants: [{ source: "C:\\Users\\example", target: "/work", access: "read-only" }] } } });
  assert.equal(windowsSource.filesystem.grants[0].source, "C:\\Users\\example");
  assert.equal(windowsSource.filesystem.grants[0].target, "/work");
  assert.throws(() => normalizeSandboxConfig({ sandbox: { filesystem: { grants: [{ source: "C:\\Users\\example", target: "C:\\work", access: "read-only" }] } } }), /normalized absolute POSIX path/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { devices: { grants: [{ source: "C:\\Devices\\camera", target: "C:\\dev\\camera", access: "read-only" }] } } }), /normalized absolute POSIX path/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { filesystem: { grants: [{ source: "/safe", target: "/work\/..\/escape", access: "read-only" }] } } }), /normalized absolute POSIX path/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { filesystem: { grants: [
    { source: "/one", target: "/work", access: "read-only" },
    { source: "/two", target: "/work/nested", access: "read-only" }
  ] } } }), /targets must not overlap/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { devices: { grants: [{ source: "/dev/../etc/passwd", target: "/dev/x", access: "read-only" }] } } }), /must not contain dot segments/u);
});

test("network rules are exact bounded host and port objects", () => {
  const config = normalizeSandboxConfig({ sandbox: { network: {
    mode: "allowlisted",
    allow: [
      { host: "registry.npmjs.org", ports: [443] },
      { host: "*.example.com", ports: [80, 443] },
      { host: "2001:db8::1", ports: [443] }
    ],
    deny: [], allowPrivate: false, allowLoopback: false, ports: [80, 443], maxResponseBytes: 4096
  } } });
  assert.equal(config.network.allow.length, 3);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { network: { mode: "allowlisted", allow: [] } } }), /requires at least one allow rule/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { network: { allow: [{ host: "https:\/\/example.com/path", ports: [443] }] } } }), /without a scheme, path, or credentials/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { network: { allow: [{ host: "Example.com", ports: [443] }] } } }), /must be lowercase/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { network: { allow: [{ host: "example.com", ports: [0] }] } } }), /integer from 1 through 65535/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { network: { allow: [{ host: "example.com", ports: [] }] } } }), /ports must not be empty/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { network: { allow: [{ host: "example.com", ports: [22] }] } } }), /must be a subset/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { network: { mode: "denied", allowPrivate: true } } }), /denied mode cannot grant/u);
});

test("numeric, array, string, and semantic bounds fail closed", () => {
  assert.throws(() => normalizeSandboxConfig({ sandbox: { process: { limits: { pids: 4097 } } } }), /pids must be an integer/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { process: { enabled: false } } }), /shell cannot be enabled/u);
  assert.doesNotThrow(() => normalizeSandboxConfig({ sandbox: { process: { enabled: false, shell: false } } }));
  assert.throws(() => normalizeSandboxConfig({ sandbox: { backend: { preference: ["oci", "oci"] } } }), /must not contain duplicates/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { environment: { inherit: ["lowercase"] } } }), /uppercase environment variable/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { environment: { set: { API_KEY: "raw" } } } }), /use a secret reference/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { environment: { set: { SAFE_NAME: "line one\nline two" } } } }), /control characters or NUL/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { filesystem: { grants: [{ source: `/tmp/${"é".repeat(2046)}`, target: "/work", access: "read-only" }] } } }), /at most 4096 UTF-8 bytes/u);
});

test("explicit confined-native mode is filesystem confinement, not process isolation", () => {
  assert.throws(() => normalizeSandboxConfig({ sandbox: {
    backend: { mode: "confined-native" },
    process: { enabled: true, shell: true }
  } }), /confined-native cannot isolate process execution/u);
  const inspectionOnly = normalizeSandboxConfig({ sandbox: {
    backend: { mode: "confined-native" },
    process: { enabled: false, shell: false }
  } });
  assert.equal(inspectionOnly.backend.mode, "confined-native");
  assert.equal(inspectionOnly.process.enabled, false);
});

test("legacy unconfined process setting maps to acknowledged host execution without silent host fallback", () => {
  const enabled = normalizeSandboxConfig({ runtime: { allowUnconfinedProcessExec: true } });
  assert.deepEqual(enabled.hostExecution, { mode: "prompt", scope: "all", allowedCommands: [], allowedRoots: [] });
  const disabled = normalizeSandboxConfig({ runtime: { allowUnconfinedProcessExec: false } });
  assert.deepEqual(disabled.hostExecution, { mode: "deny", scope: "restricted", allowedCommands: [], allowedRoots: [] });
  assert.doesNotThrow(() => normalizeSandboxConfig({
    runtime: { allowUnconfinedProcessExec: true },
    sandbox: { hostExecution: { mode: "prompt", scope: "all", allowedCommands: [], allowedRoots: [] } }
  }));
  assert.throws(() => normalizeSandboxConfig({
    runtime: { allowUnconfinedProcessExec: true },
    sandbox: { hostExecution: { mode: "deny", scope: "restricted", allowedCommands: [], allowedRoots: [] } }
  }), /conflicts with runtime\.allowUnconfinedProcessExec/u);
  assert.throws(() => normalizeSandboxConfig({ runtime: { allowUnconfinedProcessExec: "yes" } }), /must be true or false/u);
});

test("host execution requires explicit unambiguous scope", () => {
  assert.throws(() => normalizeSandboxConfig({ sandbox: { hostExecution: {
    mode: "prompt", scope: "all", allowedCommands: ["/usr/bin/git"], allowedRoots: []
  } } }), /all scope cannot also declare/u);
  assert.throws(() => normalizeSandboxConfig({ sandbox: { hostExecution: {
    mode: "deny", scope: "all", allowedCommands: [], allowedRoots: []
  } } }), /deny mode cannot declare/u);
  const restricted = normalizeSandboxConfig({ sandbox: { hostExecution: {
    mode: "prompt", scope: "restricted", allowedCommands: ["/usr/bin/git"], allowedRoots: ["/home/example"]
  } } });
  assert.deepEqual(restricted.hostExecution.allowedCommands, ["/usr/bin/git"]);
});

test("hosted mode rejects host authority while accepting a confined denied-network profile", () => {
  assert.doesNotThrow(() => assertHostedSandboxConfig({}));
  const hosted = assertHostedSandboxConfig({ sandbox: {
    network: { mode: "denied", allow: [], deny: [], allowPrivate: false, allowLoopback: false, ports: [443], maxResponseBytes: 4096 },
    process: { enabled: true, shell: true },
    hostExecution: { mode: "deny", scope: "restricted", allowedCommands: [], allowedRoots: [] }
  } });
  assert.equal(hosted.network.mode, "denied");
  assert.throws(() => assertHostedSandboxConfig({ sandbox: {
    filesystem: { grants: [{ source: "/data", target: "/data", access: "read-only" }] },
    hostExecution: { mode: "deny", scope: "restricted", allowedCommands: [], allowedRoots: [] }
  } }), /external filesystem grants/u);
  assert.throws(() => assertHostedSandboxConfig({ sandbox: {
    network: { mode: "unrestricted" },
    hostExecution: { mode: "deny", scope: "restricted", allowedCommands: [], allowedRoots: [] }
  } }), /unrestricted network access/u);
  assert.throws(() => assertHostedSandboxConfig({ sandbox: {
    environment: { secrets: [{ name: "provider", sourceEnv: "OPENAI_API_KEY", targetEnv: "PROVIDER_TOKEN" }] }
  } }), /tenant-selected secret references/u);
});

test("risk summaries flag broad grants without disclosing paths, commands, environment names, or secret references", () => {
  const sensitiveValues = [
    "/home/example", "/usr/bin/git", "LANG", "NPM_TOKEN", "registry-auth",
    "/sensitive/engines/podman", "/sensitive/engines/docker"
  ];
  const summary = summarizeSandboxRisk({ sandbox: {
    backend: { enginePaths: { podman: sensitiveValues[5], docker: sensitiveValues[6] } },
    filesystem: { grants: [{ source: sensitiveValues[0], target: "/mounted-home", access: "read-write" }] },
    network: { mode: "unrestricted", allowPrivate: true, allowLoopback: true },
    environment: { inherit: [sensitiveValues[2]], secrets: [{ name: sensitiveValues[4], sourceEnv: sensitiveValues[3], targetEnv: sensitiveValues[3] }] },
    hostExecution: { mode: "prompt", scope: "all", allowedCommands: [], allowedRoots: [] }
  } });
  assert.equal(summary.elevated, true);
  assert.equal(summary.broadFilesystemGrants, 1);
  assert.equal(summary.writableFilesystemGrants, 1);
  assert.ok(summary.risks.includes("broad-filesystem-access"));
  assert.ok(summary.risks.includes("broad-host-execution-prompt"));
  assert.deepEqual(summary.enginePathsConfigured, { podman: true, docker: true });
  const serialized = JSON.stringify(summary);
  for (const sensitive of sensitiveValues) assert.doesNotMatch(serialized, new RegExp(sensitive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.risks), true);
});
