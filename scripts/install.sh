#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(dirname "$SCRIPT_DIR")
if [ -f "$ROOT/dist/install/install.js" ]; then
  exec node "$ROOT/dist/install/install.js" install --source "$ROOT" "$@"
fi
exec node "$SCRIPT_DIR/install.ts" install --source "$ROOT" "$@"
