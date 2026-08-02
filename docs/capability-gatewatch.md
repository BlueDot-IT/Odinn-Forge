# Capability Registry and Gatewatch Preview

Odinn's capability registry is a versioned, trusted runtime contract. Tools,
skills, MCP servers, model output, and request input cannot add authority. A
tool executes only when every capability in its trusted declaration is
permitted by policy and, for delegated work, is also present in the parent and
child request.

Registry version 1 defines these capability identifiers:

- `workspace.inspect`, `workspace.mutate`, `workspace.patch`
- `process.execute`, `process.interactive`, `process.shell`
- `network.access`
- `browser.read`, `browser.mutate`
- `agent.delegate`
- `mcp.discover`, `mcp.invoke`, `skill.hydrate`, `event.register`
- `secret.reference.use`
- `restore.create`, `restore.apply`

Unknown identifiers and tools without a trusted declaration fail closed.
`process.execute` does not imply shell interpretation or interactive-process
control. Those authorities remain separate even when one backend eventually
supports more than one of them.

## Legacy migration

Legacy tool-shaped capability names are converted into exact tool-scoped
grants. For example, a legacy `memory.read` grant authorizes the mapped memory
read tools; it does not become a global `workspace.inspect` grant. The runtime
reports the original identifiers, mapped tools and capabilities, registry
version, and `automaticWidening: false` in `capabilityMigration`.

Versionless policies are interpreted as legacy when an old identifier collides
with a registry v1 identifier. A policy that intentionally uses registry v1
semantics records `capabilityRegistryVersion: 1`; this prevents an existing
`browser.read` grant from silently becoming broader during migration.

## Delegation

A child request must name its tools and all capabilities required by those
tools. The effective set is the intersection of the trusted tool declaration,
policy authority, parent authority, and the child's request. Missing required
authority and any request outside the parent or tool declaration are denied.

Skill and MCP capability declarations are requests for authority only. They
appear in previews for inspection and always report `grantsAuthority: false`.

## Workspace inspection mapping

Registry v1 maps `workspace.list`, `workspace.stat`, `workspace.search`,
`workspace.read`, and `workspace.diff` to `workspace.inspect`. Gatewatch shows
that trusted mapping before execution; the input cannot select a different
capability. The legacy `workspace.readText` tool is mapped to the same registry
capability, but migration of a versionless `workspace.readText` grant creates
an exact tool-scoped grant for that compatibility tool only. It does not
authorize the five-tool inspection surface.

A global registry v1 `workspace.inspect` grant is not limited to filesystem
inspection. It authorizes every trusted built-in mapped to that capability;
operators should inspect the exact per-tool mapping in Gatewatch or `/status`.

The workspace policy's sensitive-file denylist and the resolver's path checks
remain runtime enforcement in addition to capability admission. A Gatewatch
allow decision means the caller has authority to request inspection; it is not
a promise that a particular path, file type, cursor, or filesystem identity
will pass live validation.

## Preview before execution

Use the CLI to inspect the complete decision without executing the tool:

```bash
odinn gatewatch preview \
  --tool browser.open \
  --input-json '{"url":"https://example.com"}' \
  --parent-capabilities browser.read,network.access \
  --request-capabilities browser.read,network.access
```

The authenticated loopback gateway provides the same operation at
`POST /gatewatch/preview`. The operator console exposes it in **Capabilities →
Gatewatch admission preview**. Preview responses include the trusted tool
declaration, policy/parent/request/effective capability sets, invariant
evaluations, approval and safety metadata, migration details, and
`executes: false`.

Preview is advisory inspection of the current policy state. Live execution
still performs authoritative admission immediately before backend dispatch.
