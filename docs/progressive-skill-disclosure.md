# Progressive skill disclosure

Odinn's progressive skill disclosure separates skill selection from instruction
loading. The kernel and gateway contain the implementation, but both runtime
disclosure and managed lifecycle writes remain explicitly disabled by default.
The first live slice is caller-selected: it exposes a bounded catalog and one
exact hydration operation. It does not let a model create, enable, or replace
skills, and it does not treat skill text as a system instruction.

## Default-inert behavior

`ProgressiveSkillDisclosure.catalog()` returns a deterministic, compact list of
skills whose lifecycle state was enabled and trusted when Odinn last completed
an atomic registry/index mutation. Catalog creation reads only the separately
persisted, bounded `skills/disclosure-index.json`; it does not read or parse the
full registry, `SKILL.md`, or `skill.json`. File integrity is deliberately
checked only if a skill is selected for hydration. Each entry contains only the skill
identity, version, selection description, and requested tool/capability names.
It excludes `SKILL.md`, instructions, tests, secrets, network policy, managed
paths, and integrity internals. A catalog entry is selection metadata, not a
fresh integrity attestation.

Registry schema 1 remains unchanged for compatibility. New installs and
lifecycle mutations maintain the compact index automatically. An existing
pre-index state fails catalog reads closed until an operator explicitly calls
`SkillPackageStore.migrateDisclosureIndex()`. A dirty marker spans registry and
index replacement; if a process dies between those writes, catalog reads remain
disabled until that explicit migration rebuilds the index.

If legacy enabled records cannot fit the disclosure contract,
`migrateDisclosureIndex()` fails without changing lifecycle state. Operators can
instead call `SkillPackageStore.recoverDisclosureIndex()`. Recovery is a
deterministic, safety-reducing batch:

- invalid-integrity records are quarantined;
- metadata-incompatible records are disabled;
- entries beyond the count or byte budget are disabled from the
  lexicographically greatest identifier backward;
- compatible entries retained by the budget remain enabled and trusted.

The returned report lists every retained identifier and every lifecycle action
with its reason. Package records are never dropped, and recovery never enables
or trusts a package. Catalog access remains fail closed while the dirty marker
exists; a successful batch writes the reduced registry and compact index before
clearing it.

`hydrate(id)` loads `SKILL.md` only after an exact skill identifier is selected.
Hydration is serialized with skill lifecycle mutations and succeeds only while
the package is enabled, trusted, stored under the managed path, and valid
against its manifest, metadata, and file digests. Unknown, disabled,
quarantined, missing, tampered, and traversal-shaped identifiers fail closed.
No hydrated-content cache is used, so lifecycle and integrity changes cannot
serve stale instructions.

## Resource bounds

Defaults are deliberately finite:

- 128 eligible catalog entries;
- 64 KiB for the UTF-8 JSON catalog;
- 256 KiB for hydrated `SKILL.md` content;
- 1 MiB for managed `skill.json` verification during hydration.
- 256 KiB and 1,024 entries for the persisted disclosure index;
- 120 UTF-8 bytes for names, 2 KiB for descriptions, and 64 tool or
  capability names of at most 128 UTF-8 bytes each.
- 8 MiB per managed package file during install collision, lifecycle, and
  general integrity verification.

Limits use UTF-8 byte counts rather than JavaScript character counts. Callers
may lower them through the constructor, but all configured limits must be
positive safe integers.

Hydration rejects symbolic links in managed package roots, skill directories,
version directories, `SKILL.md`, and `skill.json`. Files are opened with
`O_NOFOLLOW` and checked against their pre-open device/inode identity. Node does
not expose portable `openat(2)` directory-handle traversal, so the residual
assumption is that the owner-only state directory is not concurrently writable
by an adversarial local process. Content digests still prevent swapped content
from being accepted as the selected package.

## Activation gates

Runtime disclosure requires `config.runtime.enableProgressiveSkills: true` and
explicit policy grants for `skill.catalog` and/or `skill.hydrate`. Managed
creation, workshop writes, and lifecycle changes separately require
`config.runtime.enableSkillLifecycle: true`, the `skill.manage` policy grant,
and an authenticated control-plane request. A future integration must still
independently demonstrate:

1. no skill-derived instructions or tool schemas enter the default prompt;
2. exact selection occurs before hydration;
3. catalog and hydration limits remain fail closed at every transport boundary;
4. lifecycle and integrity checks cannot be bypassed by caches or races;
5. hydrated text remains clearly delimited untrusted reference material and
   cannot grant capabilities or bypass execution admission;
6. external comparative evaluation shows no unacceptable inference regression;
7. security review covers prompt injection, package tampering, path traversal,
   and unintended capability disclosure.

`GET /skills` is an operator inspection surface and returns bounded managed
metadata; it never returns package instructions, tests, secret names, network
policy, managed paths, or file-integrity internals. `GET /skills/catalog` and
`GET /skills/:id/hydrate` are unavailable while progressive disclosure is off.
`POST /skills`, lifecycle transitions, and workshop save are rejected before
their request bodies are parsed while lifecycle governance is off. Enablement
uses a one-time approval bound to the exact package version and integrity
digest; approval is invalid after replacement or tampering.

Comparative inference evaluation belongs in
[BlueDot-IT/agent-benchmarks](https://github.com/BlueDot-IT/agent-benchmarks).
