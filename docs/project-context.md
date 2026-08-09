# Project context and retrieval

Stage 12 adds a bounded project-context service over the authoritative record
store and optional memory candidate index. A request selects global, project,
and session scope; session/project mismatches and archived or deleted records
are rejected. Retrieved memories retain provenance, scope, authority, and
confidence metadata, and ranking uses deterministic score/time/id tie-breaks.

Indexed retrieval refuses stale or incomplete snapshots. All result, byte, and
query limits are bounded. Recalled text is context data only; it cannot grant
capabilities, change policy, or become an instruction source.

Durable workflow and audit projections retain a context digest, source
generation/fingerprint, and selected memory identifiers rather than raw
private text. Gateway activation is explicit with
`config.runtime.enableProjectContext: true`; use `/context` or
`/projects/<id>/context` after activation.
