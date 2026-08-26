# Odinn Maintainer remediation control-plane review

This record reviews the credential-bearing reusable remediation workflow before
Odinn Forge changes its immutable caller pin.

## Reviewed revisions

- Previous Forge caller pin:
  `0c5f7b0dea200979ea96107b6856ed3dc5e7bcc0`
- Originally proposed feature pin:
  `0bbdd667c594dac8daa964edaf972aa56662014e`
- Accepted protected-main control plane:
  `b16502b1bb0e897fd7664c240489fe5811418b46`
- Immutable scanner-material revision used by the accepted workflows:
  `bb1d0a74bc2d5076040af18312bc0a2cfc3a0045`

The accepted revision is deliberately newer than the original proposal. It
contains the two-stage protected-main landing from
[odinn-maintainer PR #30](https://github.com/BlueDot-IT/odinn-maintainer/pull/30)
and
[odinn-maintainer PR #31](https://github.com/BlueDot-IT/odinn-maintainer/pull/31).
The review relies on exact content, tests, and protected-branch history rather
than commit-signature presentation alone.

## Commit-by-commit comparison

Every commit in the accepted range
`0c5f7b0..b16502b` and every changed path was inspected.

| Commit | Paths | Review result |
|---|---|---|
| `f3012fa` | daily workflow and its contract test | Raised the scanner's optional cost ceiling. No permission, secret, artifact, caller, or publication boundary changed. |
| `fda7834` | daily/remediation workflows and daily contract test | Removed the optional scanner cost argument. This can increase spend but does not widen repository or credential authority. The approved model remains pinned. |
| `07bb70b` | CODEOWNERS; maintainer README/targets; daily and test workflows; SECURITY; workflow/entrypoint/target tests | Added owner review surfaces, fail-closed target validation, deterministic dependency preparation, complete-coverage semantics, authenticated encrypted artifacts, platform tests, and fair scheduled target rotation. |
| `2ed0779` | scanner package/lock; README; daily/remediation workflows; workflow tests | Replaced runtime lock generation with `npm ci --ignore-scripts` from committed dependency material. This intermediate commit still used mutable `ref: main`; the accepted revision removes that path. |
| `e3bbd81` | daily workflow | Changed the internal scan cadence to weekly. No workflow-call, permission, or credential boundary changed. |
| `bb1d0a7` | scanner package/lock and scanner contract test | Staged `@openai/codex-security@0.1.16` and its complete lock on protected `main`, making an immutable material revision available before workflow pinning. |
| `b16502b` | README; daily/remediation workflows; workflow tests | Pinned scanner checkout to `bb1d0a7`, added exact manifest/lock hashes, separated OAuth generation from credential-free validation and write-token publication, bound candidates to the scanned SHA, and checksummed the handoff artifact. |

The complete changed-path inventory is:

- `.github/CODEOWNERS`
- `.github/codex-security/package.json`
- `.github/codex-security/package-lock.json`
- `.github/maintainer/README.md`
- `.github/maintainer/targets.mjs`
- `.github/workflows/codex-security-daily.yml`
- `.github/workflows/codex-security-remediation.yml`
- `.github/workflows/test.yml`
- `SECURITY.md`
- `tests/codex-security-remediation-workflow.test.ts`
- `tests/codex-security-workflow.test.ts`
- `tests/entrypoints.test.ts`
- `tests/targets.test.ts`

## Accepted security properties

### Caller and target restrictions

- The reusable remediation workflow accepts only
  `BlueDot-IT/Odinn-Forge` at `main`.
- The reusable daily scan rejects targets outside `BlueDot-IT`; a reusable
  caller may request only its own repository and `main`.
- Target checkout uses `persist-credentials: false`, and scan/candidate state
  is bound to the exact checked-out revision.

### Credential and permission domains

- Top-level permissions default to none.
- `prepare` has read-only contents access and is the only remediation job
  receiving ChatGPT OAuth.
- OAuth is written under a mode-0700 temporary home, the record is mode 0600,
  and that home is removed before candidate handoff.
- `validate` receives neither OAuth nor write permission and is the only job
  that executes the model-generated candidate through the Forge check suite.
- `publish` receives scoped write permission but no OAuth and reconstructs the
  already checksummed and validated patch without executing repository code.
- Publication can create only a draft pull request and explicitly cannot merge.

### Immutable scanner supply chain

- Both credential-bearing workflows check out scanner dependency material from
  `bb1d0a74bc2d5076040af18312bc0a2cfc3a0045`, never `main`,
  `master`, a tag, or `HEAD`.
- The canonical LF-normalized SHA-256 values are:
  - package manifest:
    `765c031b941ace16d816a3f0d3c9004556f3d67a26b9a446d36bd6b63edae01b`
  - package lock:
    `b7745c09606d5a77bc3fb4b539066e9608a09c3adbc393b84460f9e8ac6320b1`
- Installation uses `npm ci --ignore-scripts`; workflows do not regenerate
  or float the dependency graph.
- The installed scanner must report version `0.1.16`.

### Artifact and mutation boundaries

- Daily scan evidence is encrypted with AES-256-CBC/PBKDF2 and accompanied by
  a keyed SHA-256 authentication sidecar. Raw findings are not uploaded.
- Remediation candidates are bounded by exact base SHA, affected paths, file
  count, diff size, text-only content, and explicit denials for workflows,
  scripts, manifests, locks, secrets, credentials, deletions, modes, symlinks,
  submodules, and binaries.
- Candidate handoff includes `base-sha`, deterministic branch identity, the
  patch, and `candidate.patch.sha256`, retained for one day.
- The write job rechecks the live `main` tip before creating a draft pull
  request and explicitly dispatches ordinary Forge CI.

## Verification evidence

- odinn-maintainer PR #30: 49 tests passed; exact manifest/lock hashes
  recomputed; isolated `npm ci --ignore-scripts`; actionlint and verified
  secret scan passed.
- odinn-maintainer PR #31: 49 tests passed on Linux and Windows; workflow
  contract tests, actionlint, and verified secret scan passed.
- Forge caller tests require the accepted exact workflow SHA and keep the
  credential-bearing control plane excluded from grouped dependency updates.

## Remaining acceptance gate

The source review and immutable caller evidence are complete. Issue #126 must
remain open until the exact accepted workflow also completes a controlled
non-production dry run with a dedicated non-production OAuth credential. The
production remediation secret is not a substitute, and no credential value may
be placed in this repository, a pull request, logs, or artifacts.
