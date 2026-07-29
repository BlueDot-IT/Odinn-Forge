#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "usage: $0 <pull-request-body> <changed-files>" >&2
  exit 2
fi

body_file="$1"
changed_files_file="$2"

if [[ ! -f "$body_file" || ! -f "$changed_files_file" ]]; then
  echo "pull request body and changed-files inputs must exist" >&2
  exit 2
fi

section="$(
  tr -d '\r' < "$body_file" |
    awk '
      /^##[[:space:]]+Documentation impact[[:space:]]*$/ {
        inside = 1
        next
      }
      /^##[[:space:]]+/ {
        if (inside) {
          exit
        }
      }
      inside {
        print
      }
    '
)"

if [[ -z "$section" ]]; then
  echo "Add the '## Documentation impact' section from the pull request template." >&2
  exit 1
fi

updated_count="$(
  grep -Eic '^[[:space:]]*-[[:space:]]*\[[xX]\][[:space:]]+Documentation updated[[:space:]]*$' \
    <<< "$section" || true
)"
not_required_count="$(
  grep -Eic '^[[:space:]]*-[[:space:]]*\[[xX]\][[:space:]]+Documentation not required[[:space:]]*$' \
    <<< "$section" || true
)"

if [[ "$((updated_count + not_required_count))" -ne 1 ]]; then
  echo "Select exactly one documentation outcome in the pull request template." >&2
  exit 1
fi

details="$(
  sed -n 's/^[[:space:]]*Documentation details:[[:space:]]*//p' <<< "$section" |
    head -n 1
)"

if [[ -z "$details" || "$details" == *"Replace this text"* ]]; then
  echo "Replace the documentation details placeholder with paths or a concrete rationale." >&2
  exit 1
fi

if [[ "$updated_count" -eq 1 ]] &&
  ! grep -Eiq '(^|/)(docs/|[^/]+\.(md|mdx)$)' "$changed_files_file"; then
  echo "Documentation was marked updated, but no Markdown/MDX or docs/ path changed." >&2
  exit 1
fi

echo "Documentation impact declaration is valid."
