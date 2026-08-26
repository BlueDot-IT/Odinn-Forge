# Bounded GitHub reads

The optional GitHub integration exposes four read-only tools for the local,
single-user runtime:

- `github.repository`
- `github.issue`
- `github.pull-request`
- `github.checks`

It is disabled by default and requires the separate `github.read`,
`network.access`, and `secret.reference.use` capabilities. The integration has
no mutation, comment, merge, workflow-dispatch, artifact-download, GraphQL, or
arbitrary-URL surface.

## Configuration and credentials

Configuration names the credential environment key and an explicit repository
allowlist. It never contains the credential value:

```json
{
  "integrations": {
    "github": {
      "enabled": true,
      "tokenEnv": "ODINN_GITHUB_TOKEN",
      "repositories": ["example-owner/example-repository"]
    }
  }
}
```

Install the credential through the operator-controlled environment or the
owner-only state environment file using a secure local editor. Do not put it in
configuration, task input, shell history, logs, or chat. A fine-grained token
should grant only the repository-read permissions required for the configured
allowlist. Disabling the integration or removing its environment reference
removes runtime access.

The TLS multi-user host rejects this shared-credential integration. Run it only
inside the supported local single-user boundary.

## Network and data boundary

Every request is an authenticated `GET` to the fixed
`https://api.github.com` origin. Repository identifiers must match the explicit
allowlist. Issue and pull-request numbers are positive bounded integers;
check-run reads require a full commit object ID and a bounded result limit.

The client:

- resolves and pins a public IP address before connecting;
- refuses invalid, private, loopback, link-local, and redirect targets;
- uses verified HTTPS, a fixed GitHub API version, bounded concurrency, and one
  enforceable timeout/cancellation budget across queueing, DNS validation, and
  transport, plus a one-mebibyte response ceiling;
- accepts only JSON and never includes remote error bodies in local errors;
- returns bounded fields and marks all remote text as
  `external-untrusted`.

GitHub issue and pull-request text is available only to the live authorized
caller. Audit records and the run ledger retain target and payload digests,
bounded counts, and sizes—not repository names, credential values, titles,
bodies, labels, refs, or check names. A replay reports that live content is
unavailable instead of persisting or reconstructing it.

## Diagnostics and recovery

`odinn doctor` and `GET /diagnostics` optionally report only whether the
integration is enabled and configured, the allowlist count, fixed endpoint,
read-only status, and redirect policy. They do not disclose the token
environment name, token, or repository identifiers.

Reads have no repository-side mutation to roll back. A timeout, cancellation,
network failure, malformed response, or restart fails the request closed. A
later authorized retry performs a new live read and may observe newer GitHub
state.
