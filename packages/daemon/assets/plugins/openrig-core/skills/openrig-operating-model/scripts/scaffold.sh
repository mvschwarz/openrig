#!/usr/bin/env bash
# scaffold.sh topology <root> --node <relpath> [--node <relpath> ...]
# scaffold.sh work     <root> --node <relpath> [--node <relpath> ...]
# Creates missing chain files from templates at root + each named node dir.
# NEVER overwrites an existing file (brownfield-safe by construction; greenfield
# and brownfield are the same command with different starting states).
# Never deletes anything. Reports created vs existing.
set -euo pipefail
MODE="${1:?usage: scaffold.sh <topology|work> <root> --node <relpath> ...}"
ROOT="${2:?root dir required}"; shift 2
HERE="$(cd "$(dirname "$0")" && pwd)"; TPL="$HERE/../templates"
case "$MODE" in
  # Chains carry knowledge about a POSITION. SOP.md is knowledge about a KIND and now ships
  # in the rig's mode plugin (openrig-lab | openrig-factory | openrig-hq) — it is NOT a chain
  # and must not be scaffolded onto the tree. CULTURE.md ships with OpenRig.
  topology) FILES=(LEARNED.md) ; ROOT_FILES=(LEARNED.md) ;;
  # SPEC.md is the authored node (intent: in frontmatter). NOTES.md is the LIVED file — the
  # scaffold creates its surface only; lived entries are never generated or projected. PROGRESS is derived;
  # PROOF.md is authored by the prover when there is something to prove.
  work)     FILES=(SPEC.md NOTES.md) ; ROOT_FILES=(SPEC.md NOTES.md) ;;
  *) echo "mode must be topology|work" >&2; exit 2 ;;
esac
NODES=()
while [[ $# -gt 0 ]]; do case "$1" in --node) NODES+=("$2"); shift 2;; *) echo "unknown arg $1" >&2; exit 2;; esac; done
place(){ # $1=dir $2=file
  mkdir -p "$1"
  if [[ -e "$1/$2" ]]; then echo "  exists : $1/$2"
  else cp "$TPL/$2" "$1/$2"; echo "  CREATED: $1/$2 (template — UNSEEDED; the real owner seeds it)"; fi
}
echo "scaffold $MODE @ $ROOT"
touch "$ROOT/.compose-root" 2>/dev/null || true
for f in "${ROOT_FILES[@]}"; do place "$ROOT" "$f"; done
for n in ${NODES[@]+"${NODES[@]}"}; do for f in "${FILES[@]}"; do place "$ROOT/$n" "$f"; done; done
echo "done. Rules: existing files untouched; UNSEEDED templates await their owners; seat LEARNED.md is SELF-seeded (the audit) — never bulk-filled."
