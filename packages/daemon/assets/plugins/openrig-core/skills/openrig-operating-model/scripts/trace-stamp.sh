#!/usr/bin/env bash
set -euo pipefail
exec node "$(dirname "$0")/trace-stamp.mjs" "$@"
