# Bounded workspace inspection

Odinn exposes five read-only tools for inspecting the assigned workspace:

| Tool | Purpose | Important output |
| --- | --- | --- |
| `workspace.list` | List a directory, optionally recursively | Deterministically ordered entries, an opaque continuation cursor, traversal counts, and effective limits |
| `workspace.stat` | Inspect one regular file or directory | Type, size, modification time, mode, binary classification, and a bounded SHA-256 digest for files |
| `workspace.search` | Search for a literal string in text files | Bounded file and byte counts, per-file digest metadata, line numbers, and bounded matching lines |
| `workspace.read` | Read one regular file | Text content or a binary indication, byte counts, truncation state, and a bounded SHA-256 digest |
| `workspace.diff` | Compare one text file with another workspace file or a provided text baseline | A bounded unified diff plus current, baseline, and rendered-diff digests |

All five are trusted built-ins mapped to `workspace.inspect`. They are
classified as pure, retry-safe reads and still pass through the normal policy,
Gatewatch, admission, cancellation, audit, and ledger boundaries. Tool names
or capability declarations supplied by a model, Skill, MCP server, or request
cannot grant this authority.

## Path and file boundary

Paths are portable, workspace-relative paths. The resolver rejects absolute,
drive-relative, UNC, backslash-delimited, parent-traversal, alternate-stream,
reserved-device, and trailing-dot-or-space forms. The workspace root must be a
real directory. Content-bearing inspection rejects symbolic links, junctions,
hard-linked regular files, and special files instead of following or rendering
them. Directory traversal never follows links or hard-linked files and may
report a non-file, non-directory entry as `other` metadata.

Before and after opening or enumerating a target, the runtime compares the
target and ancestor filesystem identities and relevant file metadata. Linux
also validates an opened file descriptor through `/proc/self/fd`. These checks
detect the tested replacement and link races, but the implementation uses
portable Node.js filesystem operations. It does **not** claim a single
kernel-atomic path-resolution primitive or complete ABA-race exclusion on
macOS or Windows. A platform that cannot provide stable nonzero device and
inode identities fails closed.

These tools inspect data; they do not contain hostile code. The planned Stage
4 sandbox backend remains the hard execution boundary for untrusted programs.

## Sensitive files and ignore rules

Direct inspection is denied by default for these case-insensitive glob
patterns:

```text
.env
.env.*
**/.env
**/.env.*
**/*.key
**/*.pem
**/.ssh/**
.git/**
.odinn/**
```

`workspace.list` and `workspace.search` omit matching entries and do not
descend into matching directories. `workspace.stat`, `workspace.read`,
`workspace.diff`, and the compatibility `workspace.readText` tool reject a
matching target. Operators may replace the patterns with
`security.workspace.deniedPatterns`; an empty array explicitly disables this
application-level sensitive-file denylist and should be treated as a security
decision.

List and search traversal load `.gitignore` and `.odinnignore` by default from
the workspace root and, when a subdirectory is selected, from that start
directory. The parser supports bounded line-oriented glob rules, comments
beginning with `#`, and `!` negation. It is intentionally a small compatible
subset, not a promise to reproduce every Git ignore edge case. Unsafe,
hard-linked, linked, non-file, or larger-than-256-KiB ignore files fail closed.
`ignoreFiles` may select up to 16 file names either in policy or per request;
a per-request value replaces the policy list for that operation. Sensitive-file
policy still applies to ignore sources. Across the selected files, at most
4,096 non-comment patterns are accepted and each pattern is limited to 1,024
UTF-8 bytes; the bounded patterns are compiled once per operation.

## Bounds and cursors

`workspace.list` and `workspace.search` default `path` to the workspace root
(`.`) and require a directory. `workspace.stat` requires `path` and accepts a
regular file or directory. Read and diff require `path` to name a regular file.
Diff accepts either a confined `basePath` file or a bounded UTF-8 `before`
string with an optional display-only `beforePath`; without either, it compares
against an empty baseline. A search query is required, cannot contain NUL, and
is limited to 1,024 characters.

Traversal inputs use these bounds:

| Input | Default | Maximum | Meaning |
| --- | ---: | ---: | --- |
| `limit` | 100 | 1,000 | Returned list entries or files containing matches |
| `maxDepth` | 8 | 32 | Recursive traversal depth below the selected directory |
| `maxFiles` | 10,000 | 100,000 | Traversal-entry ceiling |
| `maxBytes` | 4 MiB | 8 MiB | Search content and serialized-result ceiling; list serialized-result ceiling |

`workspace.list` recurses only when `recursive: true`. `workspace.search`
always traverses recursively, reads at most 1,000,000 bytes from any one file,
skips detected binary files, returns at most 100 matching lines per file, and
limits each returned line to 2,048 UTF-8 bytes. Search and diff reject a source
above the explicit 100,000-line processing ceiling. Matching is literal and
case-insensitive by default; `caseSensitive: true` changes that behavior.

List and search use deterministic component-wise recursive preorder before
pagination, so a directory and its descendants precede a later sibling. A
continuation cursor is opaque, checksummed, and bound to the operation,
workspace identity, start
path, search and traversal options, ignore-file contents, and sensitive-file
policy. Changing those inputs invalidates the cursor. The checksum catches
cursor corruption; it is not an authentication token.

Read and diff limits are byte limits. `workspace.read` defaults to 65,536 bytes
and `workspace.diff` defaults to 256 KiB; both cap `maxBytes` at 8 MiB.
Truncation preserves a valid UTF-8 boundary. A digest covers the retained
bounded bytes, and `digestComplete` states whether it covers the entire file.
`workspace.stat` uses the traversal byte default of 4 MiB for a file digest.
Binary reads return `content: null`. Diff rejects binary inputs and compares
bounded, UTF-8-safe source prefixes;
`digestComplete` states whether the current-file digest covers the whole file,
while the result's `truncated` field states whether the rendered diff itself
was shortened to `maxBytes`. File modes and modification times report host
filesystem metadata and remain platform-dependent values.

## Durable evidence and cancellation

File contents, search queries, matching-line text, supplied diff baselines,
and rendered diffs are available to the live caller but are not copied into
audit events or run-ledger artifacts. Those projections contain bounded
metadata such as normalized paths, counts, sizes, truncation state, and SHA-256
digests. For agent runs, live tool output can still be sent to the configured
model provider; the provider privacy boundary remains unchanged. This
tool-boundary projection also cannot prevent a downstream model response from
quoting inspected content into the ordinary persisted agent result.

For a durable runtime job, the live first dispatch receives the volatile full
input. Persisted job input and output use the same content-free projections.
If a content-bearing workspace job is later opened through the replay surface,
its persisted result explicitly includes `contentUnavailableOnReplay: true`;
the replay contains metadata and digests, not reconstructed file content,
queries, matching lines, supplied baselines, or rendered diffs.

Every tool accepts the run's cancellation signal. Cancellation is checked
before work and during read, traversal, search, and diff loops and fails with
an `AbortError`. Cancellation is cooperative: it does not claim to interrupt an
operating-system filesystem call already in progress.

## `workspace.readText` compatibility

`workspace.readText` remains available for existing clients and legacy policy
files. It now uses the same resolver, sensitive-file policy, race detection,
bounded secure read, and cancellation path as `workspace.read`. Its established
text-only response remains compatible and adds a SHA-256 `digest` field.

A versionless legacy `workspace.readText` capability grant migrates only to an
exact `{ tool: "workspace.readText", capability: "workspace.inspect" }` scoped
grant. It does not authorize the other inspection tools and never widens into
a global `workspace.inspect` grant. Operators must explicitly grant registry
version 1 `workspace.inspect` to authorize these tools. That registry
capability also authorizes every other trusted built-in mapped to
`workspace.inspect`; inspect the Gatewatch preview and status mapping rather
than assuming it is limited to these five tools.
