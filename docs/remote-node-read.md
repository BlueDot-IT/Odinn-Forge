# Authenticated remote-node reads

The optional remote-node integration exposes the smallest supported node
protocol: two read-only tools for explicitly configured nodes.

- `node.status`
- `node.diagnostics`

Both tools require `node.read`, `network.access`, and
`secret.reference.use`. They are pure reads and do not require approval. The
integration has no command execution, process, file, log, arbitrary URL,
arbitrary endpoint, or mutation surface.

## Onboarding and configuration

Remote-node access is disabled by default and is not enabled by the interactive
AI-provider onboarding flow. Complete normal onboarding first, then use an
owner-controlled editor to add an explicit node allowlist to `config.json`:

```json
{
  "integrations": {
    "remoteNode": {
      "enabled": true,
      "nodes": [
        {
          "nodeId": "compute-one",
          "origin": "https://compute-one.example.internal:9443",
          "addresses": ["192.0.2.42"],
          "tokenEnv": "ODINN_REMOTE_NODE_TOKEN"
        }
      ]
    }
  }
}
```

Each entry has exactly four fields:

- `nodeId` is the canonical lowercase identifier accepted in tool input.
- `origin` is one canonical HTTPS authority. User information, paths, queries,
  and fragments are refused. An explicit bounded port is allowed.
- `addresses` is a nonempty allowlist of at most eight literal IP addresses.
  Private LAN or VPN addresses are allowed because they are explicit operator
  authority, not model-selected targets.
- `tokenEnv` names an allowed credential environment variable. It is a
  reference of at most 128 UTF-8 bytes, never the credential value.

At most 32 nodes may be configured. Node identifiers and address entries must
be unique. A literal-IP origin must also appear in its address allowlist.

Install each credential through the operator-controlled environment or the
owner-only state environment file using a secure local editor. Do not put a
credential value in configuration, task input, shell history, logs, or chat.
The state environment loader admits only explicitly referenced credential keys
from a workspace environment file; operator state remains the preferred
location.

Add `node.read`, `network.access`, and `secret.reference.use` to the applicable
policy. Inspect the result without executing a node request:

```text
odinn status
odinn doctor
odinn gatewatch preview --tool node.status --input-json '{"nodeId":"compute-one"}'
```

`status` lists the two tools only when the integration is enabled. Gatewatch
shows the exact capability intersection, `requiresApproval: false`, and
`executes: false`. `doctor` exposes only booleans and counts: it does not show
node identifiers, origins, IP addresses, environment-variable names, or
credential values.

The TLS multi-user host refuses this integration because environment-backed
node credentials would otherwise be shared across authenticated tenants. Use
a separate operating-system user or container for each mutually isolated
deployment.

## Fixed HTTPS protocol

Task input is exactly:

```json
{ "nodeId": "compute-one" }
```

The model cannot supply an origin, address, port, path, header, or credential.
For each admitted request, the client selects only an address from the
operator-owned entry, connects directly to that pinned address without runtime
DNS, and preserves the configured origin for HTTP authority, TLS SNI, and
certificate verification. Multiple configured addresses are selected in
bounded round-robin order; there is no transparent request retry. The
certificate must validate the configured hostname or literal IP through the
normal trusted TLS roots.

Only authenticated `GET` requests to these paths exist:

- `/odinn/node/v1/status`
- `/odinn/node/v1/diagnostics`

Redirects are refused. Ambient proxy credentials and ambient URL credentials
are not used. Queueing, transport, and response handling share a ten-second
deadline, at most four requests per client are live, and the response ceiling
is 65,536 bytes.

### Status schema

The responder returns schema version 1, the exact requested node ID, one
canonical timestamp, one fixed status enum (`ready`, `degraded`, or
`unavailable`), and bounded nonnegative `uptimeSeconds`, `activeTasks`, and
`queuedTasks` counts. Unknown fields are refused.

### Diagnostics schema

The responder returns schema version 1, the exact requested node ID, one
canonical timestamp, one fixed overall status enum (`healthy`, `degraded`, or
`unavailable`), and a nonempty unique list of at most five checks. Check names
are limited to `runtime`, `storage`, `network`, `clock`, and `work-queue`;
check states are limited to `pass`, `warn`, `fail`, and `unknown`. Messages,
logs, paths, hostnames, process data, and arbitrary content are not part of the
schema.

The kernel also exports an opt-in HTTPS responder constructor that uses these
same validators. A host adapter must explicitly enable it, provide TLS material
through its secure host boundary, name an environment credential reference,
and provide both bounded snapshots. No responder daemon is installed or
started automatically. The authenticated integration fixture exercises that
constructor over real TLS.

## Durable evidence, cancellation, and recovery

Live validated status is available to the authorized caller and may be sent to
the configured model as untrusted external tool output. Before audit or
run-ledger persistence, input becomes a target digest and output becomes only:

- tool/schema identity;
- target and payload digests;
- payload byte and check counts; and
- the fixed overall status enum.

Node identifiers, origins, addresses, credential references and values,
timestamps, individual checks, and all other live fields are not persisted.
Replay reports `contentUnavailableOnReplay` and never contacts the node or
reconstructs the live response.

A timeout, TLS failure, authentication failure, redirect, malformed response,
target mismatch, cancellation, restart-uncertain read, or registry shutdown
fails closed. Partial or post-cancellation data is discarded and is never
recorded as a completed read. Because the protocol has no mutation, there is
nothing to roll back; retry under a new run ID performs a new live read and may
observe newer state. Reorder or replace configured addresses, rotate the
environment credential, or correct the responder certificate, then restart the
runtime before retrying.
