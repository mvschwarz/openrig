#!/bin/sh

# The only optional surface is rig itself. Skip before using any external command so the
# missing-command case is honest even under an empty PATH.
if ! command -v rig >/dev/null 2>&1; then
  printf '%s\n' '[skip] rig-command-surface — rig is unavailable; command claims were not evaluated'
  printf '%s\n' '0 passed · 0 failed · 1 skipped'
  exit 0
fi

passed=0
failed=0
skipped=0
case "$0" in
  */*) root=${0%/*} ;;
  *) root=. ;;
esac
root=$(CDPATH= cd "$root" && pwd)

pass() {
  passed=$((passed + 1))
  printf '[ok] %s — %s\n' "$1" "$2"
}

fail() {
  failed=$((failed + 1))
  printf '[FAIL] %s — %s\n' "$1" "$2"
}

if grep -Eq '^taxonomy:[[:space:]]*world[[:space:]]*$' "$root/manifest.yaml"; then
  pass pack-taxonomy 'the pack declares taxonomy world'
else
  fail pack-taxonomy 'manifest taxonomy is not world'
fi

declared_ok=1
for file in boundaries.md build-your-world.md claims.yaml start-here.md verify-world.sh; do
  [ -f "$root/$file" ] || declared_ok=0
  grep -Fq "path: $file" "$root/manifest.yaml" || declared_ok=0
done
if [ "$declared_ok" -eq 1 ]; then
  pass declared-files 'every shipped file exists and is declared'
else
  fail declared-files 'a shipped file is missing or undeclared'
fi

regions_ok=1
for region in identity ontology terrain actors laws history state affordances; do
  grep -Eq "regions:.*(^|[^a-z])$region([^a-z]|$)" "$root/manifest.yaml" || regions_ok=0
done
if [ "$regions_ok" -eq 1 ]; then
  pass atom-regions 'atom metadata covers all eight regions'
else
  fail atom-regions 'one or more world regions are absent from atom metadata'
fi

prose=$(cat "$root/start-here.md" "$root/build-your-world.md" "$root/boundaries.md")
claim_ids=$(sed -n 's/^[[:space:]]*- id:[[:space:]]*//p' "$root/claims.yaml")
claim_count=$(printf '%s\n' "$claim_ids" | sed '/^$/d' | wc -l | tr -d ' ')
marker_count=$(printf '%s\n' "$prose" | grep -Ec '<!--[[:space:]]*world-claim:[[:space:]]*[a-z0-9-]+[[:space:]]*-->')
disposition_count=$(grep -Ec '^[[:space:]]+(check|flagged):' "$root/claims.yaml")
claims_ok=1
[ "$claim_count" -ge 8 ] || claims_ok=0
[ "$claim_count" -eq "$marker_count" ] || claims_ok=0
[ "$claim_count" -eq "$disposition_count" ] || claims_ok=0
seen=' '
for id in $claim_ids; do
  case "$seen" in *" $id "*) claims_ok=0 ;; esac
  seen="$seen$id "
  printf '%s\n' "$prose" | grep -Fq "<!-- world-claim: $id -->" || claims_ok=0
done
statements=$(sed -n 's/^[[:space:]]*statement: "\(.*\)"$/\1/p' "$root/claims.yaml")
while IFS= read -r statement; do
  [ -z "$statement" ] || printf '%s\n' "$prose" | grep -Fq "$statement" || claims_ok=0
done <<EOF
$statements
EOF
if [ "$claims_ok" -eq 1 ]; then
  pass claim-coverage 'every ledger claim is marked, stated, and dispositioned once'
else
  fail claim-coverage 'claim ids, markers, statements, or dispositions drifted'
fi

if rig --help >/dev/null 2>&1 &&
   rig context list --help >/dev/null 2>&1 &&
   rig context show --help >/dev/null 2>&1 &&
   rig context get --help >/dev/null 2>&1 &&
   rig context profile --help >/dev/null 2>&1; then
  pass rig-command-surface 'every taught rig command exists on the live CLI'
else
  fail rig-command-surface 'a taught rig command is absent from the live CLI'
fi

if grep -Fq 'rig whoami --json' "$root/start-here.md" &&
   grep -Fq 'rig ps' "$root/start-here.md" &&
   grep -Fq 'rig context list' "$root/start-here.md" &&
   grep -Fq 'rig --help' "$root/start-here.md"; then
  pass taught-commands 'volatile facts point at their deriving commands'
else
  fail taught-commands 'one or more deriving commands are not taught'
fi

if grep -Fq 'WORLD + LORE + SKILLS + MISSION' "$root/build-your-world.md"; then
  pass taxonomy-layout 'the authoring convention separates the four context kinds'
else
  fail taxonomy-layout 'the four-kind separation is absent'
fi

if grep -Fqi 'subset by region' "$root/build-your-world.md"; then
  pass subset-by-region 'large worlds teach region subsetting instead of meaning loss'
else
  fail subset-by-region 'region subsetting is not taught'
fi

if grep -Fq 'The reading cost is derived when a profile is composed, not copied into this pack.' "$root/build-your-world.md"; then
  pass derived-reading-cost 'reading cost remains derived at compose time'
else
  fail derived-reading-cost 'reading-cost derivation claim is absent'
fi

if grep -Fq 'If a repository uses AGENTS.md, keep repo instructions there; a world complements those instructions.' "$root/start-here.md"; then
  pass agents-md-complement 'the world complements repository instructions'
else
  fail agents-md-complement 'the repository-instruction boundary is absent'
fi

if grep -Fq 'Private world installs remain rig-local under their own refs and are never shadowed by this builtin.' "$root/boundaries.md"; then
  pass private-ref-boundary 'the builtin cannot shadow a rig-local world ref'
else
  fail private-ref-boundary 'the rig-local namespace rider is absent'
fi

example="$root/../world-example"
if grep -Fq 'atoms:' "$example/manifest.yaml" &&
   grep -Fq 'Book world' "$example/your-world.md" &&
   grep -Fq 'rig context get world-example' "$example/your-world.md"; then
  pass world-example-consistency 'the worked exercise uses the same atom convention'
else
  fail world-example-consistency 'the worked exercise is absent or ungraduated'
fi

printf '%s passed · %s failed · %s skipped\n' "$passed" "$failed" "$skipped"
[ "$failed" -eq 0 ]
