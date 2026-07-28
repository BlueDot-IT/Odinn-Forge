# Task Contract Reference

The strict Runemark verification API currently uses the compatibility
identifier `proof`:

```json
{
  "schemaVersion": 1,
  "id": "contract-id",
  "runId": "run-id",
  "assertions": [
    {"id":"tests","type":"command","command":["/absolute/path/to/pnpm","test"],"expect":{"exitCode":0}},
    {"id":"marker","type":"file","path":"src/marker.txt","expect":{"exists":true}}
  ]
}
```

Command working directories and file paths are constrained to the run workspace. Command execution is denied unless the complete argument vector exactly matches an operator-owned `proof.allowedCommands` entry in state configuration. Approved commands receive a minimal environment. `matches` accepts a bounded regular expression with `i`, `m`, `s`, and `u` flags.

Verification contracts cannot request evidence disclosure. Raw command output, file content, HTTP bodies, and legacy evidence are omitted from results and durable artifacts by default; only an operator may opt in with `proof.includeRawEvidence: true`. Even when enabled, mandatory credential redaction remains active.
