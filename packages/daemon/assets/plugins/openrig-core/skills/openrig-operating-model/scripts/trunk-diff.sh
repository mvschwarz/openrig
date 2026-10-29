#!/usr/bin/env bash
# Compatibility entry; native rendering/diff/state update uses Node + Git.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
exec node "$HERE/trunk-diff.mjs" "$@"
