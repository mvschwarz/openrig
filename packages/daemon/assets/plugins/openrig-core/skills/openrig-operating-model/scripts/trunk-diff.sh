#!/usr/bin/env bash
# trunk-diff.sh <root-dir> <state-file> [--name FILE ...]
# The governance pull loop: render the subtree, diff against your PREVIOUS
# render, update state. Reading the diff = updating your mental model of a
# changing topology without reading everything or being told anything.
set -euo pipefail
ROOT="${1:?usage: trunk-diff.sh <root-dir> <state-file> [--name FILE ...]}"
STATE="${2:?state-file required}"; shift 2
NAMES=("$@"); [[ ${#NAMES[@]} -eq 0 ]] && NAMES=(--name CULTURE.md --name PLAYBOOK.md --name LEARNED.md --name INTENT.md)
HERE="$(cd "$(dirname "$0")" && pwd)"
NEW="$(mktemp)"
python3 "$HERE/compose.py" down "$ROOT" "${NAMES[@]}" | grep -v '^<!-- GENERATED' > "$NEW"
if [[ -f "$STATE" ]]; then
  if diff -u "$STATE" "$NEW"; then echo "── no changes since your last render ──"; fi
else
  echo "── first render (no previous state); full content is the baseline ──"
fi
mv "$NEW" "$STATE"
