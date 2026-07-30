# Cached MCP host foundation

Ódinn exposes a dependency-light, optional MCP host foundation at
`@odinn/kernel/mcp-host`. The subpath is not imported by the kernel root,
Gateway, CLI, or runtime. Import and construction perform no discovery, network
access, process launch, filesystem access, environment lookup, timer creation,
or authentication. Existing request latency and runtime behavior are unchanged.

The module is deliberately not a ready-to-connect MCP client. An integrator
must explicitly call `start()` or `refresh()` and supply both a discovery
transport and an audited dispatcher. Those caller-owned adapters are the only
places that can connect to a server or obtain authorization. Ódinn supplies no
endpoint, headers, credentials, auth handles, subprocess transport, network
fallback, retry, or provider-specific behavior.

## Discovery and cache boundary

Discovery is explicit, single-flight, and never runs from `invoke()`. A result
must arrive as a UTF-8 JSON string or exact `Uint8Array`. Raw bytes are measured
with intrinsic typed-array accessors before decoding or parsing; arbitrary
objects, proxies, subclasses, shared backing buffers, invalid UTF-8, and
shadowed-size bypasses fail closed. Backing buffers are classified with captured
`ArrayBuffer` and `SharedArrayBuffer` internal-slot accessors rather than
prototype identity, so prototype-mutated and cross-realm shared buffers remain
rejected while genuine ordinary `ArrayBuffer` backing remains accepted. The
parsed result must match its request and
server, advance a positive generation, fit bounded tool/count/byte limits, and
use the strict supported JSON Schema subset. Discovery transport failures are
reduced to a categorical error; adapter exception text is never exposed or
stored.
Snapshots are canonical, content-fingerprinted, deeply immutable, and exclude
descriptions, defaults, examples, endpoints, headers, paths, and authorization
material. Tool and schema identifiers reject sensitive identity namespaces.

Each snapshot has fresh, stale, and expired states. Stale data remains
inspectable for diagnosis but cannot authorize invocation; callers must
explicitly refresh it. Every call pins the server generation, snapshot
fingerprint, tool name, and tool-schema fingerprint. Discovery only describes
tools. It grants no capability, approval, or authority.

Supported schemas are closed objects (`additionalProperties: false`), arrays,
strings, bounded numbers/integers, and booleans. Only structural bounds are
supported. Arbitrary regexes, references, combinators, executable formats,
descriptions, defaults, examples, and extension keys are rejected.
Each schema type has its own exact field allowlist, so fields recognized for a
different type are rejected rather than ignored. Credential-, authority-, and
endpoint-shaped property names are rejected at every nesting depth. Identifier
checks first split delimiters, camel-case transitions, and acronym transitions,
then remove non-alphanumeric characters and lowercase the compact form. The
classifier rejects exact sensitive atoms or an exact two- or three-part
composition beginning with an allowlisted credential/authority subject. The
subject set includes authentication and authorization terms, OAuth/client and
bearer identities, password/user/cookie/API identities, token/session/refresh/
JWT identities, grant/approval/policy identities, and credential/secret/key
identities. Material atoms include identifiers and values, tokens and keys,
headers and secrets, passwords and credentials, digests and hashes, grants and
sessions, references, approvals, and handles, plus bounded transport and
authority terms. Subject atoms may also serve as material atoms.

The classifier does not search for arbitrary substrings: the entire normalized
identifier must match the two- or three-atom segmentation. This catches
`authheader`, `sessionid`, `refreshtoken`, `jwttoken`, `grantref`,
`authorizationref`, `approvalapproved`, subject/subject compositions such as
`clientauth` and `authorizationoauth`, and case variants without treating
incomplete remainders in `authorName`, `hockey`, `keynote`, `monkey`, `turkey`,
`sessional`, `tokenize`, `grantor`, `policyholder`, `clientele`, `accounting`,
or `serviceable` as credentials.

## Audited dispatch and failure behavior

Arguments are validated against the pinned schema, bounded, canonicalized,
frozen, and hashed. The dispatcher receives a content-bound request carrying
`requiresAuthorization: true` and `requiresAudit: true`. A receipt is accepted
only as pre-parse-bounded raw UTF-8 JSON, when every request binding matches,
and when it includes an `authorization:` authority reference and an `audit:`
evidence reference. Completed results use only the non-authority `artifact:`
or `record:` namespaces plus a digest. Generic, credential-shaped, and
authority-shaped reference suffixes are rejected across all three namespaces;
the namespace carries the evidence role while the suffix remains a neutral
opaque identifier. The host does not cache model/tool content.

The host never retries or silently falls back. It owns concurrency across its
whole lifetime. When a dispatcher ignores cancellation after a timeout,
cancellation, or shutdown, the physical slot remains occupied until the
underlying promise settles. The logical caller receives `needs-review` because
execution outcome is uncertain. Capacity cannot be reclaimed by starting an
overlapping call. Late settlement and invalid receipts are isolated and
counted without unhandled rejections.

Call identifiers are one-use for the host lifetime. Their tracking set has a
fixed configured capacity and fails closed when full instead of evicting old
identifiers and permitting replay. Restarting or replacing the optional host is
the explicit way to begin a new identifier namespace.

Shutdown stops admission, aborts active discovery and calls, and returns within
its configured deadline. Its result reports physical work that remains. A
non-cooperative adapter cannot keep shutdown pending indefinitely.

This foundation adds no persistence, configuration, runtime activation, or
migration. Rollback consists of removing the optional subpath and explicit
integrator callers. Activating an MCP transport requires a separate review of
authentication, policy, approvals, auditing, privacy, lifecycle, and latency.
