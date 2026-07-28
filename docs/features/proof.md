# Runemark — Run verification

Runemark is Ódinn Forge's core evidence-backed run verification layer. The
existing `proof` CLI command, configuration key, gateway route, and SDK names
remain compatibility identifiers. Runemark is available without a feature
flag. A model response cannot mark a run verified; only passing assertions can
do that. Passing or failing Runemark also promotes or rejects Raven Route's
provisional observation for the same run.

Contracts use `schemaVersion: 1` and support exact-allowlisted command arrays, root-confined file assertions, bounded HTTP `GET`/`HEAD` assertions, and fixed Git working-tree assertions. Command assertions are denied by default. An operator may place exact argument vectors in `proof.allowedCommands` in the state `config.json`; allowing an executable name alone is deliberately unsupported. Approved commands receive a minimal environment without provider credentials or the parent process environment. Command and response output is bounded, but raw stdout, stderr, file content, HTTP bodies, and legacy evidence are omitted by default. Results retain only non-content fields plus byte/item metadata. Timed-out or flooding commands have their process tree terminated.

Raw evidence retention is an operator-owned configuration decision, never a verification-contract field. Set `proof.includeRawEvidence` to `true` only when the additional disclosure is necessary. Retained evidence still passes through mandatory credential redaction before it is returned or persisted. Existing historical artifacts are not rewritten by this setting.

```json
{
  "proof": {
    "allowedCommands": [["/absolute/path/to/pnpm", "test"]],
    "includeRawEvidence": false
  }
}
```

```bash
odinn proof contract validate ./contract.json
odinn proof run <run-id> --contract ./contract.json
odinn proof show <run-id>
```

The authenticated gateway exposes the same path through `POST /proof`, `GET /proof/<run-id>`, and `GET /runtime/runs/<run-id>/verify`; it uses the same operator-owned exact allowlist.

HTTP verification is loopback-only by default to prevent untrusted contracts from becoming an SSRF primitive. External verification requires an explicit runtime integration decision; it is not enabled by the gateway.
