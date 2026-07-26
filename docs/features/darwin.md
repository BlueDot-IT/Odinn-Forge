# Raven Route — Model routing

Raven Route is Ódinn Forge's core evidence-based model-routing service. The
existing `routing` CLI command, gateway routes, event names, and `DarwinRouter`
SDK export remain compatibility identifiers. Raven Route records measured
outcomes in SQLite and uses a transparent weighted score across verification,
provisional success, reliability, rollback history, policy compliance, speed,
and known cost. An uncertainty penalty prevents a single lucky run from
becoming gospel.

```bash
odinn routing observe --run <run-id> --provider openai --model gpt --task-class bug-fix --verified true --duration-ms 1200
odinn routing stats --task-class bug-fix
odinn routing choose --task-class bug-fix
```

When `model.chat` does not pin a model, Raven Route selects only among models
in the active configuration. With no applicable observations it falls back to the
configured default. Provider success is recorded as provisional; a subsequent
Runemark result for the run marks the observation verified or failed. Prompts
and secrets are not stored in observation rows.

Each real routing choice appends a hash-chained `model-routing-decision` event
to the run with the selected model, decision source, reason, and bounded
candidate score summaries. Each measured outcome appends a
`model-observation` event linked to its SQLite observation row. Runemark then
appends `model-observation-verification` with the contract result and affected
observation IDs. This provides a causal trail from choice, through outcome, to
verification without persisting prompt content or credentials.
