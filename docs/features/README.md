# Features index

This page groups Ódinn Forge's advanced services and optional plugin modules.
It is a navigation aid, not a separate compatibility promise. The
[surface matrix](../surface-matrix.md), [v1 compatibility policy](../v1-compatibility.md),
and each feature page remain authoritative for support boundaries and behavior.

## Core advanced services

These services are available without enabling a feature flag. Their advanced
CLI and gateway contracts remain outside the stable public-SDK promise unless
the surface matrix says otherwise.

| Service | Technical page | Technical identifier | Boundary |
| --- | --- | --- | --- |
| Gatewatch — policy safety | [sentinel.md](sentinel.md) | Sentinel | Policy and capability decisions are evaluated before execution. |
| Runemark — run verification | [proof.md](proof.md) | Proof | Only explicit assertions can verify a run; model output cannot. |
| Norn Restore — restore points | [rewind.md](rewind.md) | Rewind | Selected local files can be snapshotted and restored through the audited path. |
| Raven Route — model routing | [darwin.md](darwin.md) | DarwinRouter / `routing` | Evidence-backed model selection records bounded decision and outcome evidence. |
| Self-improvement — reliability loop | [self-improvement.md](self-improvement.md) | `improve` / `self-improvement` | The default-on loop may tune only explicitly allowlisted reliability settings. |

## Optional plugin modules

These modules are disabled by default and must be explicitly enabled. Enabling
one can change ordinary CLI behavior immediately; read its feature page before
activation.

| Module | Technical page | Enable command |
| --- | --- | --- |
| Rune Key — scoped temporary access | [capability-tokens.md](capability-tokens.md) | `odinn config experimental enable capabilities --confirm-impact` |
| Saga Archive — portable run bundles | [capsules.md](capsules.md) | `odinn config experimental enable capsules --confirm-impact` |
| Worldtree Paths — scenario comparison | [counterfactual.md](counterfactual.md) | `odinn config experimental enable counterfactual --confirm-impact` |

## Supporting runtime foundations

These pages describe related runtime, policy, and execution foundations. They
are not additional plugin switches:

- [Execution admission](../architecture/execution-admission.md)
- [Capability registry and Gatewatch preview](../capability-gatewatch.md)
- [Sandboxing](../sandboxing.md)
- [Bounded workspace inspection](../workspace-inspection.md)
- [Progressive skill disclosure](../progressive-skill-disclosure.md)
- [Durable session lanes](../durable-session-lanes.md)
- [Async telemetry](../async-telemetry.md)
- [Runtime event ledger](../architecture/event-ledger.md)
- [SQLite memory index](../sqlite-memory-index.md)
- [Provider capability metadata](../provider-capability-metadata.md)
- [Gateway Protocol v2](../gateway-protocol-v2.md)
- [Messaging channels](../channels.md) (experimental)

## Related boundaries

- [Surface matrix](../surface-matrix.md) — stable, experimental,
  provider-dependent, platform-dependent, internal, and unsupported surfaces.
- [Security guide](../../SECURITY.md) — operation and vulnerability reporting.
- [Repository policy](../repository-policy.md) — contribution and release
  requirements.
