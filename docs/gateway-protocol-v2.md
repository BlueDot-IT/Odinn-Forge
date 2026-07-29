# Gateway Protocol v2

Gateway Protocol v2 is an additive, transport-agnostic contract in
`@odinn/protocol/gateway-v2`. It does not replace the existing REST v1 API.
REST v1 and `agent.run` continue to use their existing implementation.

## Compatibility and discovery

Clients and servers declare inclusive `min` and `max` protocol versions. They
select the highest overlapping version and reject non-overlapping ranges.
Discovery advertises method names, whether each method mutates state, required
scopes, event names, and event scopes. Clients declare a bounded role, scopes,
and capabilities.

Frames are strict request, response, or event objects. Every transport **MUST**
pass raw text or bytes through `parseGatewayWireFrame`. That function enforces
the 1 MiB byte limit before UTF-8 decoding or `JSON.parse`. The object
validators operate on already parsed, trusted-process values; they are not
raw-ingress protection. Unknown fields, unsupported versions, invalid JSON
values, and excessive JSON complexity are rejected.

Mutating methods require an idempotency key. Responses carry either a result
or a stable structured error with a `retryable` flag and optional
`retryAfterMs`.

W3C version `00` `traceparent` values with nonzero trace and parent identifiers
may be carried unchanged across request and response boundaries. Clients
provide trace context per request and must create a new parent identifier for
each child request.

Event sequences must increase monotonically. Transports **MUST** authorize
events with `validateAuthorizedGatewayEvent`, server-owned event discovery,
and authenticated scopes before delivery. A replay cursor is the exclusive
`v2:<sequence>` boundary: replay starts with the next event.

## Idempotency

The idempotency namespace is `(authenticated principal, idempotency key)`.
`createGatewayIdempotencyBinding` derives a namespace hash and a deterministic
method-and-params fingerprint using canonical, key-sorted JSON. The
authenticated principal is server-owned; a client-supplied identity must
never select this namespace.

For every mutating method, the transport/server **MUST** enforce these rules
in an atomic idempotency store:

1. The first request binds its principal/key namespace to the method and exact
   canonical params fingerprint before mutation starts.
2. A concurrent duplicate with the same fingerprint joins/coalesces with the
   in-flight operation; it must not execute a second mutation.
3. Reuse with a different method or params is rejected with
   `IDEMPOTENCY_KEY_MISMATCH`.
4. A completed duplicate replays the cached semantic response, re-enveloped
   with the duplicate request's correlation ID; it must not re-execute.
5. In-flight and completed records are retained for the server's advertised
   retention interval. The protocol default is 24 hours
   (`DEFAULT_GATEWAY_IDEMPOTENCY_RETENTION_MS`); expiry must never occur while
   the operation is still in flight.

The protocol types and fingerprint helpers do not replace atomic server-store
enforcement.

## Replay pagination and retention

`replayGatewayEvents` admits at most 10,000 source events, scans at most 4 MiB
of encoded event data, and returns at most 1,000 events and 1 MiB of encoded
event data; the default page is 100. It stops after the requested page plus
one validated lookahead event instead of cloning and validating an entire
large source. Server queries should fetch from the exclusive cursor in
sequence order and apply their own equivalent row and byte bounds.

`afterCursor` is exclusive. `nextCursor` is the last returned event and is
supplied as the next page's `afterCursor`; `hasMore` indicates another page.

Whenever `afterCursor` is present, servers **MUST** supply the authoritative
retained oldest and newest sequence bounds; the helper rejects their absence.
A cursor older than `oldestAvailableSequence - 1` fails with
`REPLAY_CURSOR_STALE`; a cursor newer than `newestAvailableSequence` fails
with `REPLAY_CURSOR_FUTURE`. Clients must resynchronize after a stale cursor,
not silently treat data loss as an empty replay. An empty source does not make
a future cursor valid, because the authoritative bounds are checked first.

## JSON Schema boundary

The checked-in JSON Schema is a deterministic syntactic frame artifact.
Runtime validators remain normative for semantic relationships JSON Schema
cannot express, including `event.cursor` encoding exactly `event.sequence`,
monotonic ordering, retained replay windows, authorization, aggregate byte
budgets, and idempotency content binding. Runtime `maxLength` checks use
JavaScript string length (UTF-16 code units); consumers must not substitute a
schema engine's Unicode-code-point length when enforcing runtime limits.

## Security properties

- Validators reject unknown fields and non-plain objects.
- Authorization uses the authenticated connection's granted scopes; a
  client's declared scopes never grant authority by themselves.
- Transports must pass their authenticated scopes and server-owned method
  metadata to `validateAuthorizedGatewayRequest`; this fail-closed entry point
  controls scope and idempotency enforcement.
- Transports must use `validateAuthorizedGatewayEvent` before emitting events.
- Trace identifiers are validated but are not authentication credentials.
- Raw payload bytes are bounded before parsing; depth, node, string, and
  collection bounds are applied before application dispatch.
- The reference client validates response correlation and event ordering. Its
  event authorization option should be used unless input is already
  authorized by the transport boundary.

## Enablement and latency

This tranche intentionally includes no WebSocket listener. A listener must
reuse the gateway's existing authentication and authorization boundary and is
deferred until that integration can be made and security-tested without
changing REST behavior.

The new modules are available only through explicit package subpaths:

```ts
import { validateGatewayFrame } from "@odinn/protocol/gateway-v2";
import { GatewayV2Client } from "@odinn/protocol/gateway-v2/client";
```

The root `@odinn/protocol` module used by the kernel is unchanged and does not
import Gateway v2. There is no listener, initialization, discovery, schema
generation, persistence, telemetry, or network work on the default REST or
kernel request path. The checked-in
`packages/protocol/gateway-v2.schema.json` artifact is deterministically
matched to the exported schema object by the focused test suite.
