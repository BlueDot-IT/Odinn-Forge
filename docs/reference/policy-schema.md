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

## Workspace inspection security

`security.workspace` configures application-level filtering for the bounded
workspace inspection tools:

```json
{
  "security": {
    "workspace": {
      "deniedPatterns": [
        ".env",
        ".env.*",
        "**/.env",
        "**/.env.*",
        "**/*.key",
        "**/*.pem",
        "**/.ssh/**",
        ".git/**",
        ".odinn/**"
      ],
      "ignoreFiles": [".gitignore", ".odinnignore"]
    }
  }
}
```

`deniedPatterns` accepts at most 128 non-empty glob strings of at most 256
characters. Direct access to a matching target fails closed; list and search
omit matching entries and do not descend into matching directories. An empty
array disables the default sensitive-file patterns and therefore represents an
explicit weakening of the application-level filter.

`ignoreFiles` accepts at most 16 non-empty file names of at most 256 characters.
Names cannot contain path separators or be `.` or `..`. Traversal reads these
files from the workspace root and selected start directory, subject to the
safety and size limits in
[Bounded workspace inspection](../workspace-inspection.md). A per-request
`ignoreFiles` value replaces this policy list for that operation.
