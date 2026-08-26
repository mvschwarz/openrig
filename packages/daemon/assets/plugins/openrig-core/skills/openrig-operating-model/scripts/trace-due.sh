#!/usr/bin/env bash
# trace-due.sh <seat-dir> [work-dir ...]
# Deterministic due-check for the alignment trace. Exit 0 + reason when DUE;
# exit 1 SILENTLY when not (the no-op path is the point: schedulers may fire
# this on cadence; the ACTION stays evidence-gated — fixed-cadence traces were
# empirically falsified; see SKILL.md §4).
set -euo pipefail
SEAT_DIR="${1:?usage: trace-due.sh <seat-dir> [work-dir ...]}"; shift || true
STAMP="$SEAT_DIR/.last-trace"
MIN_HOURS="${TRACE_MIN_HOURS:-6}"      # never due more often than this
FORCE_HOURS="${TRACE_FORCE_HOURS:-72}" # due regardless of activity after this
now=$(date +%s)
if [[ ! -f "$STAMP" ]]; then
  # never traced: due only if the seat shows any life at all
  if [[ -n "$(find "$SEAT_DIR" "$@" -type f -newermt '-7 days' -print -quit 2>/dev/null)" ]]; then
    echo "DUE: no trace on record and recent activity exists"; exit 0
  fi
  exit 1
fi
last=$(stat -f %m "$STAMP" 2>/dev/null || stat -c %Y "$STAMP")  # BSD then GNU; date -r means different things on the two OSes
age_h=$(( (now - last) / 3600 ))
(( age_h < MIN_HOURS )) && exit 1
if (( age_h >= FORCE_HOURS )); then
  echo "DUE: ${age_h}h since last trace (force threshold ${FORCE_HOURS}h)"; exit 0
fi
# due only if meaningful work accumulated since the stamp
for d in "$SEAT_DIR" "$@"; do
  if [[ -n "$(find "$d" -type f -newer "$STAMP" ! -name '.last-trace' -print -quit 2>/dev/null)" ]]; then
    echo "DUE: ${age_h}h since last trace and new activity under $d"; exit 0
  fi
done
exit 1
