# Policy Schema Reference

Policies must have `version: 1` and an `invariants` array. Each invariant has an `id`, `type`, and an enforcement action: `log`, `warn`, `pause`, `block`, `rollback`, or `terminate`.

Gatewatch's first policy slice implements `command.deny-pattern`,
`tool.requires-approval`, and `filesystem.allowed-roots`. The `Sentinel` SDK
name remains a compatibility identifier. Unimplemented invariant types fail
validation instead of pretending to enforce them.
