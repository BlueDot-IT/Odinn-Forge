# OpenSSF Scorecard triage

> **Historical snapshot (July 22, 2026).** This record preserves the five
> Scorecard dispositions reviewed before the repository moved to
> `BlueDot-IT/Odinn-Forge`. It is not a current score, alert count, rescan
> tracker, or repository-policy attestation. Current evidence observed on
> July 30, 2026 is separated below.

The reviewed scan evaluated `main` at
[`31c3034`](https://github.com/BlueDot-IT/Odinn-Forge/commit/31c3034f287932cc157d622d39df5632c2b127bd).
The original workflow run and API record use the repository's former
`jason-allen-oneal/Odinn` identity.

## Historical production alert snapshot

At the time of the July 22 review, the GitHub APIs reported no open CodeQL,
Dependabot, or secret-scanning alerts, and the corresponding
[pre-migration security workflow](https://github.com/jason-allen-oneal/Odinn/actions/runs/29892689978)
completed successfully. Those counts are a point-in-time record only. Current
alert APIs are permission-gated and change independently, so this document does
not restate them as current facts.

The current repository's
[security workflow on `a93e5f6`](https://github.com/BlueDot-IT/Odinn-Forge/actions/runs/30565879712)
reported successful job conclusions for CodeQL, dependency audit, secret scan,
and OpenSSF Scorecard on July 30. Those workflow conclusions are repository
evidence; they are not an aggregate Scorecard API score.

## Dispositions and later evidence

| Finding | July 22 snapshot | Evidence observed July 30, 2026 |
| --- | --- | --- |
| Security Policy | Open pending a later default-branch scan after the policy gained private-reporting and disclosure-timeline guidance. | [`SECURITY.md`](../../SECURITY.md) is present in the current repository. The legacy API record dated July 26 scored this check 10, but no current-repository aggregate score is claimed. |
| Fuzzing | Open pending scanner recognition of generated-input testing in the normal test path. | [PR #50](https://github.com/BlueDot-IT/Odinn-Forge/pull/50) merged bounded continuous security fuzzing, including the [workflow](../../.github/workflows/continuous-fuzz.yml) and [scope/evidence contract](continuous-fuzzing.md). This is implementation evidence, not a claim that the public Scorecard API has rescanned it. |
| Code Review | Recorded as remediated based on the repository settings observed during the original review. | The current [`CODEOWNERS`](../../.github/CODEOWNERS) file identifies owners. The earlier branch-protection statement is not carried forward as current policy; verify live GitHub rulesets before making an enforcement claim. |
| Maintained | Age-bound rather than evidence of maintainer inactivity. | The [current public repository metadata](https://api.github.com/repos/BlueDot-IT/Odinn-Forge) records the migrated repository as created July 26, 2026, so the age-sensitive check remains time-dependent. |
| CII Best Practices | Deferred during prerelease; no badge was claimed in this snapshot. | The current [OpenSSF Best Practices project](https://www.bestpractices.dev/projects/13830) reports Passing, and the current [README](../../README.md) displays that badge. |

## Current Scorecard source boundary

As observed July 30, 2026, the public Scorecard API endpoint for
`github.com/BlueDot-IT/Odinn-Forge` returns `404 Not Found`. The
[legacy API record](https://api.scorecard.dev/projects/github.com/jason-allen-oneal/Odinn)
is dated July 26 and names the former repository identity at commit `5ec2a9b`.
It is useful historical evidence but is not authoritative for current `main`.
Do not claim a current aggregate score or successful API rescan until the
BlueDot repository endpoint publishes a result.

For current operational evidence, use the repository's
[security workflow](https://github.com/BlueDot-IT/Odinn-Forge/actions/workflows/security.yml),
[security overview](https://github.com/BlueDot-IT/Odinn-Forge/security), and
individual source or workflow links above. Each source answers a narrower
question; none should be generalized beyond its timestamp and scope.
