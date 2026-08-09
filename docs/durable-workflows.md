# Durable workflows

Stage 10 adds a bounded first-class workflow runtime. A workflow definition is
versioned and content-addressed; its steps form a validated acyclic graph and
each step records its action, dependencies, retry safety, approval requirement,
and bounded input projection.

Workflow runs and step leases are stored in the runtime SQLite database. A
checkpoint is committed before a step is dispatched. Retry-safe steps may be
requeued after an expired lease. Effectful or otherwise uncertain work is
quarantined as `needs-review` and is never replayed automatically.

The Gateway surface is disabled by default. Enable it explicitly with
`config.runtime.enableDurableWorkflows: true`, then use `POST /workflows`,
`GET /workflows`, `GET /workflows/<id>`, and the cancel/resume/event endpoints.
Workflow action references still pass through the normal execution admission,
policy, capability, approval, audit, and ledger boundaries.

Raw secrets and unbounded content are not a workflow recovery store. Durable
records retain bounded projections and digests; input changed by persistence
redaction must be supplied again after restart.
