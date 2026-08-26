#!/usr/bin/env bash
# trace-stamp.sh <seat-dir>  — record that a trace was performed now.
set -euo pipefail
touch "${1:?usage: trace-stamp.sh <seat-dir>}/.last-trace"
echo "stamped: $1/.last-trace ($(date '+%Y-%m-%d %H:%M %Z'))"
