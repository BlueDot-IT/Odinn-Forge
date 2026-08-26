# Local Git inspection

Odinn exposes a deliberately read-only local Git slice through `git.status`,
`git.diff`, and `git.log`. The tools inspect only the assigned worktree. They
do not fetch, push, contact remotes, invoke credential helpers, run hooks,
honor external diff drivers, or expose `.git/**` and `.odinn/**` paths.

## Authority and approval

All three tools require the explicit `git.read` capability. Because the tools
are pure, retry-safe local reads, they do not require an operator approval.
Generic workspace inspection still denies `.git/**`; granting `git.read` does
not widen `workspace.inspect`.

Supported inputs are bounded portable paths plus `HEAD`, a full object ID, or
a full local `refs/heads/**` or `refs/tags/**` reference. Remote shorthand,
revision expressions, URL-like references, absolute paths, traversal, and Git
metadata paths fail closed.

## Output and durable evidence

- `git.status` returns bounded porcelain status entries.
- `git.diff` returns a UTF-8 patch with byte limits and a SHA-256 digest.
- `git.log` returns bounded commit identifiers, parents, timestamps, and
  subjects.

Live content is returned only to the authorized caller. Durable audit and run
ledger projections retain counts and digests, never patch content, paths, or
commit subjects. Replays report that content is unavailable and require a new
authorized read.

Git execution uses fixed argument arrays with prompts, global/system config,
credential helpers, optional locks, external diff drivers, color, and network
protocol selection disabled. Set `ODINN_GIT_EXECUTABLE` only to an absolute
operator-controlled Git executable when the platform cannot resolve `git`.

## Recovery and diagnostics

The slice performs no repository mutation, so recovery is side-effect-free:
retry after correcting an invalid worktree, reference, executable, timeout, or
output bound. `diagnoseGitWorkspace()` reports whether Git and the assigned
worktree are available without reading remote configuration or credentials.
