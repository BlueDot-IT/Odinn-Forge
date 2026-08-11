# Sandboxed execution

Ódinn treats model output, skills, extensions, MCP servers, child agents,
scripts, packages, and workspace-controlled configuration as untrusted. The
sandbox configuration in the selected state `config.json` (by default
`~/.odinn/config.json`) is operator-owned authority. A repository-local
`.odinn/config.json` is workspace content unless the operator explicitly selects
that directory with `--state` or `ODINN_STATE_DIR`. A
tool, manifest, child, or workspace file may request less authority, but cannot
grant itself more authority than this configuration allows.

The configuration contract is designed to preserve ordinary computer use. As
later enforcement slices activate, an agent can have a persistent personal
home, run tools, install user-scoped packages, access the public internet
through a broker, and use explicitly granted host locations.
A repository is only one possible granted location; documents, media, shared
folders, removable storage, and generated artifacts use the same mechanism.

## Configuration

The `sandbox` object is optional. Omitting it selects the balanced defaults.
Unknown fields inside this object are rejected so a misspelled security control
cannot silently disappear.

```json
{
  "sandbox": {
    "backend": {
      "mode": "auto",
      "preference": ["rootless-oci", "oci", "confined-native"],
      "unavailable": "refuse",
      "enginePaths": {
        "podman": "/usr/bin/podman",
        "docker": "/usr/bin/docker"
      }
    },
    "home": {
      "mode": "persistent",
      "maxBytes": 10737418240
    },
    "filesystem": {
      "sandboxHome": "read-write",
      "grants": [
        {
          "source": "/absolute/operator-selected/path",
          "target": "/work/files",
          "access": "read-write"
        }
      ]
    },
    "network": {
      "mode": "brokered-public",
      "allow": [],
      "deny": [],
      "allowPrivate": false,
      "allowLoopback": false,
      "ports": [80, 443],
      "maxResponseBytes": 16777216
    },
    "process": {
      "enabled": true,
      "shell": true,
      "image": "docker.io/library/odinn-process@sha256:<64 lowercase hex characters>",
      "limits": {
        "timeoutMs": 120000,
        "cpu": 2,
        "memoryBytes": 2147483648,
        "pids": 256,
        "tmpfsBytes": 536870912,
        "outputBytes": 1000000
      }
    },
    "environment": {
      "inherit": [],
      "set": {},
      "secrets": []
    },
    "devices": {
      "grants": []
    },
    "hostExecution": {
      "mode": "deny",
      "scope": "restricted",
      "allowedCommands": [],
      "allowedRoots": []
    }
  }
}
```

This example includes an external writable grant to show its shape. The actual
default has no external host grants. Broad access is configured by naming a
broad absolute source explicitly; an empty array never means unrestricted
access.

OCI engine programs are exact operator-owned authority too. Newly generated
Linux defaults use `/usr/bin/podman` and `/usr/bin/docker`. Stage 4 OCI
activation is Linux-only: the executable and every path ancestor must be
root-owned, non-link, and non-writable by group or other users. macOS and
Windows configuration can represent future exact native paths, but execution
refuses there until equivalent executable-trust validation exists. Relative
command names are rejected, and execution never searches `PATH` or falls back
from a configured path to another program. Diagnostics report only whether
each path is configured, never the path itself.

### Target defaults and current enforcement

- The target default gives the sandbox a persistent per-agent home; this first
  backend cutover does not activate general sandbox homes.
- Its own home is writable; the host filesystem is not ambiently visible.
- Public networking is configured through the governed egress-broker contract.
  Until that broker is active, arbitrary sandbox processes requiring it refuse.
  Loopback,
  link-local, metadata, and private destinations remain denied unless the
  operator grants them.
- Processes and shells are allowed inside a proven sandbox and remain subject
  to policy capabilities and resource limits.
- Host execution is denied. It is never an automatic fallback.
- No host environment variables, provider credentials, Gateway credentials,
  SSH agents, container sockets, devices, or external roots are inherited.

### Configurable broad authority

Operators may deliberately configure:

- read-only or read-write host roots;
- larger or ephemeral agent homes;
- denied, brokered-public, allowlisted, or unrestricted networking;
- private-network or loopback access;
- named environment variables and per-invocation secret references;
- exact device grants;
- bounded process limits and shell availability; and
- operator-acknowledged host execution.

These choices are reported as risks in diagnostics and recorded in execution
evidence. They are never inferred from an empty list, workspace content, a
model request, or a failed backend probe.

## Authority intersection

Effective authority is the intersection of:

1. the operator-owned sandbox configuration;
2. the current runtime policy and capability grant;
3. the tool, skill, child, MCP, or workflow declaration; and
4. the immutable profile compiled for the admitted execution.

An active execution retains its compiled profile snapshot if configuration is
changed concurrently. The next execution receives the new configuration.

## Backends and platform truth

- Rootless OCI remains the strongest preferred Linux process backend. This
  cutover activates Docker (including rootless Docker when reported) with the
  explicit built-in seccomp profile. Podman remains unavailable until an
  operator-trusted explicit seccomp profile becomes part of the compiled
  contract; its daemon default is not treated as proof.
- OCI with a privileged daemon is reported separately and never described as
  rootless.
- Confined-native filesystem operations can safely implement bounded built-in
  file tools, but are not hostile-code process isolation.
- macOS and Windows container implementations must report their VM, mount,
  identity, and resource-limit behavior accurately.
- A missing required control makes that backend unavailable. Ódinn does not
  silently replace it with host execution.

Host execution is a distinct operator-approved backend. Even when configured,
a model, skill, workflow, MCP server, or child agent cannot approve its own
host execution.

## Network broker requirement

`brokered-public` and `allowlisted` are enforcement claims, not proxy
environment-variable labels. A conforming backend places workloads on an
internal-only network and routes egress through an Ódinn-controlled broker that
resolves and pins destinations, validates IPv4 and IPv6 results, blocks proxy
bypass, revalidates redirects and CONNECT requests, and bounds bytes, time, and
concurrency. Until that broker passes integration tests, those network modes
must be reported as unavailable for arbitrary sandbox processes.

## Activation boundaries

The first shared-backend cutover executes immutable read-only extension
bundles with a `network-denied` OCI profile. Digest-pinned images must already
exist locally; mutable tags are refused and the runtime uses `--pull=never`.
The Docker backend creates the stopped container with `seccomp=builtin`, inspects its effective host
configuration against the compiled profile, commits exact signed pre-start
audit evidence, and only then starts it. Engine capability reports establish
backend eligibility; stopped-container inspection attests configuration, while
effective kernel enforcement remains a disclosed runtime trust dependency. Images
that declare OCI `VOLUME` paths are refused because those paths would otherwise
create writable engine-managed storage outside the profile; cleanup also
removes anonymous volumes.
The extension declaration requests no network or host environment authority,
so a broader operator ceiling does not enlarge that individual run.

Every OCI execution is durably reserved before container creation in the
owner-only `sandbox-recovery.json` journal. Executions are serialized per state
directory. A normal or exceptional settlement clears its reservation only
after an exact namespace-and-execution label query proves the managed container
absent. Each reservation also binds a digest of the exact trusted engine path,
so changing daemon bindings cannot clear an older container as absent. If the runtime is unavailable or absence is uncertain, the journal
quarantines further sandbox dispatch until reconciliation succeeds; there is no
force-clear path.

Persistent homes, brokered process networking, secret injection, and writable
external mounts remain unavailable. Stage 6 adds the durable process supervisor
and the first public process slice: only `POST /jobs` may submit `process.exec`,
and only after explicit approval does it dispatch to a Linux OCI runtime. The
operator must configure `sandbox.process.image` as an exact `@sha256:` image
reference. The runtime receives a sealed read-only workspace bundle, denied
networking, no shell, no host mounts, and bounded resource controls. Direct run
routes and CLI execution continue to refuse the tool. The owner-only,
atomically replaced `process-recovery.json` journal remains available for the
host-supervised compatibility path, while OCI executions use the matching
durable `sandbox-recovery.json` container journal. Either journal quarantines
further dispatch when cleanup or absence cannot be proved.
