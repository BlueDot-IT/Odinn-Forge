# Policy Schema Reference

Policies must have `version: 1` and an `invariants` array. Each invariant has an `id`, `type`, and an enforcement action: `log`, `warn`, `pause`, `block`, `rollback`, or `terminate`.

Gatewatch's first policy slice implements `command.deny-pattern`,
`tool.requires-approval`, and `filesystem.allowed-roots`. The `Sentinel` SDK
name remains a compatibility identifier. Unimplemented invariant types fail
validation instead of pretending to enforce them.

Runtime policy also carries capability registry version `1`:

- `allowedCapabilities` contains registry capability identifiers that are
  available globally.
- `scopedCapabilities` contains exact `{ tool, capability }` grants produced by
  legacy migration or explicit operator configuration.
- `capabilityMigration` reports legacy identifiers and their exact mappings;
  migration never widens authority automatically.

Unknown capability identifiers fail validation. A tool must satisfy every
capability in its trusted registry declaration; request input, Skill metadata,
and MCP metadata cannot grant capabilities. See
[Capability Registry and Gatewatch Preview](../capability-gatewatch.md) for the
registry, delegation intersection, and non-executing preview contract.
