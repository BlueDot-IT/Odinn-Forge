#!/usr/bin/env bash
set -euo pipefail

repository=${1:?repository is required}
release_id=${2:?release id is required}
destination=${3:?destination is required}

[[ $release_id =~ ^[1-9][0-9]*$ ]] || {
  echo "release id must be a positive integer" >&2
  exit 2
}

mkdir -p "$destination"

while IFS=$'\t' read -r asset_id asset_name; do
  [[ $asset_id =~ ^[1-9][0-9]*$ ]] || {
    echo "release asset id is invalid" >&2
    exit 1
  }
  [[ -n $asset_name && $asset_name != */* && $asset_name != . && $asset_name != .. ]] || {
    echo "release asset name is unsafe" >&2
    exit 1
  }
  gh api \
    -H 'Accept: application/octet-stream' \
    "repos/${repository}/releases/assets/${asset_id}" \
    > "${destination}/${asset_name}"
done < <(
  gh api --paginate "repos/${repository}/releases/${release_id}/assets" \
    --jq '.[] | [(.id | tostring), .name] | @tsv'
)

test -n "$(find "$destination" -mindepth 1 -maxdepth 1 -type f -print -quit)"
