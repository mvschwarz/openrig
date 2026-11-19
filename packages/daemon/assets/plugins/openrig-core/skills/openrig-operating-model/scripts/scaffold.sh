#!/usr/bin/env bash
# Compatibility entry; Node implements the operation on every platform.
set -euo pipefail
exec node "$(dirname "$0")/scaffold.mjs" "$@"
