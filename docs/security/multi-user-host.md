# Multi-user host

The default Ódinn Forge gateway is a single-user loopback service and must not be bound to a public interface. Remote deployments use the separate multi-user host, which terminates TLS and proxies each authenticated membership context to an independent loopback gateway.

## Provision a user

Passwords are read from the environment and stored only as scrypt hashes in an owner-only user database:

```bash
ODINN_CONFIRM_IMPACT=true ODINN_HOST_STATE=/srv/odinn-host \
ODINN_USER_PASSWORD='use-a-password-manager-generated-secret' \
node apps/gateway/src/host.ts user-add \
  --id alice \
  --workspace /srv/odinn-workspaces/alice
```

There is no public signup endpoint. Provisioning is an operator action.

Additional tenants and memberships are operator-managed records. They do not
grant access until the membership is present and active:

```bash
ODINN_HOST_STATE=/srv/odinn-host node apps/gateway/src/host.ts tenant-add \
  --id acme --name "Acme" --workspace /srv/odinn-workspaces/acme
ODINN_HOST_STATE=/srv/odinn-host node apps/gateway/src/host.ts membership-add \
  --user alice --tenant acme --role member
```

## Tenant lifecycle and operations

Tenant records have an explicit `status`: `active` or `suspended`. Legacy
`disabled: true` tenant records are treated as suspended. Suspension is a
fail-closed application control: cached tenant gateways are closed, ordinary
gateway proxy requests return `423`, and the tenant state remains on disk.
Active memberships are retained so a member with `tenant.manage` can resume
the tenant or create a recovery backup. Suspension is not hostile-tenant
isolation and does not change the operating-system boundary.

After authentication, the host exposes these membership-scoped routes:

- `GET /auth/tenants` lists only the caller's memberships and each tenant's
  lifecycle status.
- `GET /auth/tenant` returns the selected tenant, the caller's role, and the
  permissions resolved from the durable role record.
- `POST /auth/tenant/lifecycle` accepts `{ "tenantId": "acme", "status":
  "suspended" }` or `"active"`. The caller must have an active membership in
  that target tenant and the role must grant `tenant.manage`; a tenant ID in a
  request does not grant access.
- `POST /auth/tenant/backup` accepts `{ "tenantId": "acme" }` and creates a
  verified state backup for a caller with `tenant.manage`. Backups are stored
  below `tenant-backups/<tenant-id>/` in the owner-only host state directory,
  are created under the host and tenant state mutation locks, and are capped
  at ten retained backup directories by default. The existing state-backup
  verifier excludes host credentials, sessions, OAuth/browser material,
  gateway tokens, and other protected ephemeral state; the route never accepts
  an `includeSensitiveState` override. A suspended tenant may be backed up.

This tranche intentionally has no authenticated tenant-deletion endpoint.
Deletion and retention remain an explicit operator workflow after a verified
backup; the host does not turn a tenant-controlled request into irreversible
filesystem removal.

## Start the host

```bash
ODINN_CONFIRM_IMPACT=true ODINN_HOST_STATE=/srv/odinn-host \
ODINN_HOST=0.0.0.0 \
ODINN_PORT=18791 \
ODINN_PUBLIC_ORIGIN=https://odinn.example.com \
ODINN_TLS_CERT=/etc/letsencrypt/live/odinn.example.com/fullchain.pem \
ODINN_TLS_KEY=/etc/letsencrypt/live/odinn.example.com/privkey.pem \
pnpm host:start
```

A non-loopback bind refuses to start without a certificate, private key, and exact public origin. Mutating requests require that exact origin. Authentication is durably throttled per client address and user across restarts, sessions are signed HttpOnly/SameSite cookies, and logout revokes the active session. Public responses use generic errors while internal details remain in server logs. Host sessions are owner-only, revocable records and are restored across a host restart; disabling a user or membership removes access on the next request, while suspending a tenant blocks gateway access but retains its membership-scoped administration path.

Hosted sessions expire after eight hours and are swept from memory at least
once per minute. The host retains at most five sessions per user and 500
sessions globally by default. A login at the per-user limit replaces that
user's oldest session; a new user login at the global limit fails closed until
capacity is available. Operators can adjust the bounded defaults with
`ODINN_HOST_SESSION_MAX_PER_USER`, `ODINN_HOST_SESSION_MAX_GLOBAL`,
`ODINN_HOST_SESSION_DURATION_MS`, and `ODINN_HOST_SESSION_SWEEP_MS`.
The global limit is always the hard ceiling. If the configured per-user limit
is higher, the host clamps it to the global limit.

## Isolation boundary

The host persists a versioned control plane containing users, tenants, memberships, roles, and service-account records. A user may belong to more than one tenant; the active tenant is selected only after the authenticated membership is checked. Each tenant receives a separate:

- state directory and SQLite ledger;
- workspace root;
- loopback gateway and bearer token;
- OAuth and audit stores;
- browser profile and recovery journal.

This is application-level tenant separation. It is not a sandbox for mutually hostile users running arbitrary local code. Deploy mutually untrusted tenants under separate operating-system users, containers, or machines. Do not share workspace roots between tenants.

Hosted tenant gateways accept only the built-in public provider endpoints and credential environment names. Custom provider URLs, private/local endpoints, CLI providers, and custom OAuth endpoints are rejected because a tenant-selected endpoint must never receive a shared host credential or become an SSRF primitive. Use a separate OS/container deployment when a private or custom provider is required.
