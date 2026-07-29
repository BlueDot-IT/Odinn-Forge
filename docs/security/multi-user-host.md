# Multi-user host

The default Ódinn Forge gateway is a single-user loopback service and must not be bound to a public interface. Remote deployments use the separate multi-user host, which terminates TLS and proxies each authenticated user to an independent loopback gateway.

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

A non-loopback bind refuses to start without a certificate, private key, and exact public origin. Mutating requests require that exact origin. Authentication is durably throttled per client address and user across restarts, sessions are signed HttpOnly/SameSite cookies, and logout revokes the active session. Public responses use generic errors while internal details remain in server logs. Sessions are intentionally held in memory, so a host restart signs every user out.

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

Every user receives a separate:

- state directory and SQLite ledger;
- workspace root;
- loopback gateway and bearer token;
- OAuth and audit stores;
- browser profile and recovery journal.

This is application-level tenant separation. It is not a sandbox for mutually hostile users running arbitrary local code. Deploy mutually untrusted tenants under separate operating-system users, containers, or machines. Do not share workspace roots between tenants.

Hosted tenant gateways accept only the built-in public provider endpoints and credential environment names. Custom provider URLs, private/local endpoints, CLI providers, and custom OAuth endpoints are rejected because a tenant-selected endpoint must never receive a shared host credential or become an SSRF primitive. Use a separate OS/container deployment when a private or custom provider is required.
