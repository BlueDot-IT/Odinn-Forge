# Bounded Microsoft Graph email and calendar reads

The optional Microsoft Graph integration exposes a read-only email and calendar
slice for one explicitly configured Microsoft 365 account:

- `email.accounts`, `email.search`, `email.read`, and `email.thread`;
- `calendar.calendars`, `calendar.events`, and `calendar.read`.

It is disabled by default. Email tools require `email.read`; calendar tools
require `calendar.read`. Every tool also requires `network.access` and
`secret.reference.use`. The integration installs no draft, send, archive,
label, event-create, event-update, event-delete, arbitrary-URL, or generic
Microsoft Graph request surface.

## Configure the local integration

Configuration stores only a credential environment reference, one Microsoft
directory object ID, and the selected read resources:

```sh
odinn config integration add microsoft-graph \
  --token-env ODINN_MICROSOFT_GRAPH_TOKEN \
  --account-id 11111111-1111-4111-8111-111111111111 \
  --resources email,calendar
odinn config integration enable microsoft-graph --confirm-impact
odinn config integration list
```

The example object ID is synthetic. Replace it locally with the intended
account's Microsoft directory object ID. Do not put a bearer token in the
configuration, a command argument, task input, chat, logs, or shell history.
Install the token through the operator-controlled environment or the owner-only
state environment file using a secure local editor. The environment name must
be credential-oriented and cannot alias an Odinn runtime control.

Grant the token only the Microsoft Graph read permissions required by the
selected resources, normally `Mail.Read` and/or `Calendars.Read`, plus the
minimum account-directory read permission required by the tenant's token mode.
Token issuance, consent, refresh, revocation, conditional-access rules, and
tenant policy remain Microsoft/provider operations. An expired or revoked token
makes the integration unavailable; Odinn does not silently switch accounts or
request broader authority.

Disable or remove the local integration with:

```sh
odinn config integration disable microsoft-graph
odinn config integration remove microsoft-graph
```

The TLS multi-user host rejects this shared-credential integration. It is
supported only inside the local single-user boundary.

## Network, permission, and content boundary

Every provider request is an authenticated `GET` beneath the fixed
`https://graph.microsoft.com/v1.0/users/<configured-account-id>` surface. The
adapter constructs the allowed message, thread, calendar, calendar-view, and
event paths itself. Provider identifiers are encoded as single path segments;
task input cannot select another origin, account, endpoint, query key, or
mutation method.

The client:

- resolves and pins a public IP address before connecting;
- rejects private, loopback, link-local, invalid, mixed-public/private, and
  redirect targets;
- uses verified HTTPS, a global four-request concurrency ceiling, one bounded
  queue/DNS/transport timeout, and a one-mebibyte response ceiling;
- accepts only bounded UTF-8 JSON and never includes a remote response body in
  a local error;
- validates the configured account and every returned provider identifier;
- accepts plain-text message and event bodies only; and
- labels all provider text as external untrusted content.

Read tools do not require a per-call mutation approval because they cannot
change Microsoft 365 state. Enabling the integration requires an explicit
impact confirmation, and normal capability policy still decides whether an
agent may invoke each tool.

## Diagnostics, durable evidence, and recovery

`odinn doctor`, `odinn config integration list`, and authenticated
`GET /diagnostics` report only whether the integration is enabled and
configured, whether email and calendar reads are selected, the fixed endpoint,
the single-account count, read-only status, and redirect policy. They do not
disclose the token environment name, token, account ID, message IDs, calendar
IDs, event IDs, or provider content.

Email and calendar results are returned only to the live authorized caller.
Audit records and the run ledger retain target and payload digests, byte and
item counts, and categorical outcomes—not addresses, subjects, snippets,
bodies, attendee names, locations, provider identifiers, or credentials. After
a restart, an idempotent task record reports that live content is unavailable;
it does not replay a provider request or reconstruct private content.

These tools are deliberately unavailable as durable workflow steps or cron
targets. Workflow definitions and cron schedules are ordinary backed-up state,
so admitting a live-only provider target there would retain private inputs or
results beyond the authorized call. Submit a new interactive authorized read
instead. Existing completed email runs from the immediately preceding durable
format remain recognizable for content-unavailable replay after upgrade; that
compatibility check is limited to an exact completed-run binding and never
replays Graph or writes a legacy identifier projection.

Reads have no provider-side effect to roll back. Cancellation, timeout, DNS or
TLS failure, malformed data, credential loss, or restart fails closed. A later
authorized invocation is a new live read and may observe newer Microsoft 365
state.

## Repository acceptance

The retained tests use an injected Graph transport and synthetic account data;
they never contact Microsoft or load a real credential. They cover
configuration, capability admission, fixed-origin and account confinement,
DNS pinning, redirects, bounds, timeout/concurrency behavior, hostile provider
responses, provider-specific untrusted account metadata, durable
workflow/cron refusal, whole-state and ordinary-backup sentinel scans, exact
immediate-base upgrade replay, durable redaction, and restart no-replay
behavior. Live service
availability, tenant consent, account permissions, throttling, and conditional
access remain provider-dependent acceptance gates.
