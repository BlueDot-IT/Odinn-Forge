# Executable agent manifests and run graphs

`@odinn/kernel/agent-run-graphs` is a demand-loaded, default-inert foundation
for bounded child-agent execution. It is not imported by the kernel root,
Gateway, job supervisor, or Agent SDK registry.

Executable manifests contain only a registry identity claim, declarative
tool and capability requests, child and timeout limits, and a canonical
digest. They cannot contain commands, paths, endpoints, credentials, arbitrary
capability objects, or execution payloads. Requested tools and capabilities do
not authorize them. Registry claims are untrusted until resolved and checked
inside the caller's audited dispatcher. Token, secret, auth, credential, and
approval-oriented registry namespaces are rejected.
The same case-insensitive authority-word rejection applies independently to
principal namespaces and typed input, result, and audit references. Inputs
allow only `input:`, `artifact:`, or `memory:`; results allow only `result:` or
`artifact:`; receipts allow only `audit:`.

Run graphs are immutable canonical DAGs. Version 1 limits graphs to 32 nodes,
64 edges, depth 8, fanout 8, and 32 KiB canonical JSON. Nodes carry only an
exact manifest ID/digest and typed opaque input and result references. Cycles,
duplicate nodes, duplicate
edges, unknown dependencies, and digest mismatches fail closed.

Public manifest, manifest-collection, and graph admission accepts only UTF-8
JSON text or bytes and enforces the 32 KiB wire ceiling before decoding or
`JSON.parse`. Direct JavaScript objects are rejected because their key count
cannot be pre-bounded without enumeration. Successful parsing returns branded,
deeply frozen snapshots; the runner accepts only those snapshots. Strict
prototype/accessor/symbol checks remain internal defense-in-depth over data
already proven to originate within the raw-byte ceiling.

Byte input must have the exact built-in `Uint8Array` prototype and non-shared
backing memory. Size and backing-buffer checks use captured typed-array
intrinsic getters, so shadowed `byteLength`, `length`, `buffer`, or `byteOffset`
properties cannot weaken the ceiling. Subclasses, proxies, fake views, and
`SharedArrayBuffer` views fail closed. Backing memory classification does not
trust prototypes, constructors, or string tags: captured
`ArrayBuffer.prototype.byteLength` and
`SharedArrayBuffer.prototype.byteLength` getters probe the backing object's
internal slots. Shared memory rejects even after prototype mutation or across
realms; a buffer recognized by neither intrinsic fails closed.

`AgentRunGraphRunner` is a long-lived physical-slot owner and executes only
through a caller-supplied `dispatch` callback.
Every immutable dispatch request states `authorized: false` and
`requiresAuditedDispatch: true`; the caller must route it through Odinn's
existing policy, approval, job, and audit boundary. Readiness advances through
deterministic topological waves, launch order is canonical, and concurrency is
bounded. Completion must return the exact predeclared result reference; result
content never enters this layer. Dispatch completion requires a strict audited
receipt binding principal namespace, graph run, node call, graph, manifest,
request, producer node, result reference/digest, terminal status, and audit
reference.

Immutable run reports retain bounded graph-run and principal correlation and,
for dispatched nodes, only node-call ID, request digest, result
reference/digest, terminal status, and audit reference. They never retain raw
input, output, error, prompt, credential, or provider content. Overall status
uses the deterministic precedence `needs-review`, then failed/blocked, then
cancelled, then completed.

Timeout or cancellation never retries uncertain work. A noncooperative
dispatch retains its physical concurrency slot until it actually settles.
The graph-wide deadline returns a `needs-review` result without awaiting such
a dispatch; settled/rejected handlers remain attached to prevent unhandled
rejections. No new work starts after that boundary. The runner never retries
or recursively spawns nodes. Unresolved physical calls prevent admission of a
later run; cancellation and bounded shutdown retain ownership until late
physical settlement. A stopped instance cannot restart.

This module performs no registry loading, filesystem, network, environment,
provider, credential, or tool access. Timers are created only while the runner
is explicitly invoked. Runtime integration, durable graph state, recovery,
retries, and Gateway activation require separate review.
