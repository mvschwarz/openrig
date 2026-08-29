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
example="$root/../world-example"

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

prose=$(cat "$root/start-here.md" "$root/build-your-world.md" "$root/boundaries.md" "$example/your-world.md")
claim_ids=$(sed -n 's/^[[:space:]]*- id:[[:space:]]*//p' "$root/claims.yaml")
claim_count=$(printf '%s\n' "$claim_ids" | sed '/^$/d' | wc -l | tr -d ' ')
marker_count=$(printf '%s\n' "$prose" | grep -Ec '<!--[[:space:]]*world-claim:[[:space:]]*[a-z0-9-]+[[:space:]]*-->')
disposition_count=$(grep -Ec '^[[:space:]]+(check|flagged):' "$root/claims.yaml")
kind_count=$(grep -Ec '^[[:space:]]+kind:[[:space:]]+(judgment|operational|structural)[[:space:]]*$' "$root/claims.yaml")
claims_ok=1
[ "$claim_count" -ge 8 ] || claims_ok=0
[ "$claim_count" -eq "$marker_count" ] || claims_ok=0
[ "$claim_count" -eq "$disposition_count" ] || claims_ok=0
[ "$claim_count" -eq "$kind_count" ] || claims_ok=0
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
   rig context profile --help >/dev/null 2>&1 &&
   rig context add --help >/dev/null 2>&1 &&
   rig context rm --help >/dev/null 2>&1; then
  pass rig-command-surface 'every taught rig command exists on the live CLI'
else
  fail rig-command-surface 'a taught rig command is absent from the live CLI'
fi

public_get_output=$(rig context get world-public 2>/dev/null)
public_get_status=$?
public_get_ok=1
[ "$public_get_status" -eq 0 ] || public_get_ok=0
printf '%s\n' "$public_get_output" | grep -Fq '# Enter the world' || public_get_ok=0
printf '%s\n' "$public_get_output" | grep -Fq '# Build your world' || public_get_ok=0
printf '%s\n' "$public_get_output" | grep -Fq '# Boundaries' || public_get_ok=0
if [ "$public_get_ok" -eq 1 ]; then
  pass retrieve-public-pack 'context get returned the assembled public world content'
else
  fail retrieve-public-pack 'context get did not return the assembled public world content'
fi

profile_output=$(rig context profile world-public --situation fresh --json 2>/dev/null)
profile_status=$?
profile_tokens=$(printf '%s\n' "$profile_output" | sed -n 's/.*"totalEstimatedTokens"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | sed -n '1p')
profile_ok=1
[ "$profile_status" -eq 0 ] || profile_ok=0
[ -n "$profile_tokens" ] && [ "$profile_tokens" -gt 0 ] || profile_ok=0
for atom in enter-the-world author-a-world know-the-edges; do
  printf '%s\n' "$profile_output" | grep -Eq "\"atomId\"[[:space:]]*:[[:space:]]*\"$atom\"" || profile_ok=0
done
if [ "$profile_ok" -eq 1 ]; then
  pass compose-fresh-profile 'context profile returned the fresh atom graph with a derived token total'
else
  fail compose-fresh-profile 'context profile did not return the fresh atom graph and derived token total'
fi

example_get_output=$(rig context get world-example 2>/dev/null)
example_get_status=$?
example_get_ok=1
[ "$example_get_status" -eq 0 ] || example_get_ok=0
printf '%s\n' "$example_get_output" | grep -Fq '# Your world' || example_get_ok=0
printf '%s\n' "$example_get_output" | grep -Fq '## Exercise: Book world' || example_get_ok=0
printf '%s\n' "$example_get_output" | grep -Fq '## Checks' || example_get_ok=0
if [ "$example_get_ok" -eq 1 ]; then
  pass retrieve-world-example 'context get returned the worked book-world template'
else
  fail retrieve-world-example 'context get did not return the worked book-world template'
fi

pack_output=$(rig context show world-public --json 2>/dev/null)
pack_status=$?
pack_source_path=$(printf '%s\n' "$pack_output" | sed -n 's/.*"sourcePath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | sed -n '1p')
pack_source_root=$(CDPATH= cd "$pack_source_path" 2>/dev/null && pwd)
pack_path_ok=1
[ "$pack_status" -eq 0 ] || pack_path_ok=0
printf '%s\n' "$pack_output" | grep -Eq '"relativePath"[[:space:]]*:[[:space:]]*"world-public"' || pack_path_ok=0
printf '%s\n' "$pack_output" | grep -Eq '"sourceType"[[:space:]]*:[[:space:]]*"builtin"' || pack_path_ok=0
[ "$pack_source_root" = "$root" ] || pack_path_ok=0
if [ "$pack_path_ok" -eq 1 ]; then
  pass derive-pack-path 'context show resolves this builtin at its usable source path'
else
  fail derive-pack-path 'context show did not resolve world-public to this builtin directory'
fi

if [ "$pack_path_ok" -eq 1 ] && [ -f "$pack_source_root/verify-world.sh" ]; then
  pass run-public-verifier 'this verifier is running from the directory returned by context show'
else
  fail run-public-verifier 'the directory returned by context show does not contain this verifier'
fi

list_output=$(rig context list --json 2>/dev/null)
list_status=$?
namespace_ok=1
[ "$list_status" -eq 0 ] || namespace_ok=0
printf '%s\n' "$list_output" | grep -Eq '"relativePath"[[:space:]]*:[[:space:]]*"world-public"' || namespace_ok=0
printf '%s\n' "$pack_output" | grep -Eq '"sourceType"[[:space:]]*:[[:space:]]*"builtin"' || namespace_ok=0
if printf '%s\n' "$list_output" | grep -Eq '"relativePath"[[:space:]]*:[[:space:]]*"world/install"'; then
  private_output=$(rig context show world/install --json 2>/dev/null)
  private_status=$?
  [ "$private_status" -eq 0 ] || namespace_ok=0
  printf '%s\n' "$private_output" | grep -Eq '"relativePath"[[:space:]]*:[[:space:]]*"world/install"' || namespace_ok=0
  printf '%s\n' "$private_output" | grep -Eq '"sourceType"[[:space:]]*:[[:space:]]*"(user_file|workspace)"' || namespace_ok=0
fi
if [ "$namespace_ok" -eq 1 ]; then
  pass private-ref-boundary 'the builtin is listed at world-public while a local world namespace remains local'
else
  fail private-ref-boundary 'the world-public or local-world namespace projection is false'
fi

configured_packs_root=$(rig config get context.packs_root 2>/dev/null)
configured_packs_status=$?
example_install_ok=1
[ "$configured_packs_status" -eq 0 ] || example_install_ok=0
[ -n "$configured_packs_root" ] || example_install_ok=0
if [ -n "${OPENRIG_CONTEXT_PACKS_ROOT:-}" ] && [ "$configured_packs_root" != "$OPENRIG_CONTEXT_PACKS_ROOT" ]; then
  example_install_ok=0
fi
rig context add --help >/dev/null 2>&1 || example_install_ok=0
rig context list --help >/dev/null 2>&1 || example_install_ok=0

probe_ref="world-public-verify-$$"
probe_target="$configured_packs_root/$probe_ref"
probe_installed=0
cleanup_probe() {
  [ "$probe_installed" -eq 1 ] || return 0
  if rig context rm "$probe_ref" --json >/dev/null 2>&1; then
    probe_installed=0
    return 0
  fi
  rm -rf -- "$probe_target" || return 1
  [ ! -e "$probe_target" ] || return 1
  probe_installed=0
}

if [ "$example_install_ok" -ne 1 ]; then
  :
elif [ -d "$probe_target" ] || printf '%s\n' "$list_output" | grep -Eq "\"relativePath\"[[:space:]]*:[[:space:]]*\"$probe_ref\""; then
  example_install_ok=0
else
  trap 'cleanup_probe >/dev/null 2>&1 || :' 0
  trap 'cleanup_probe >/dev/null 2>&1 || :; exit 130' 1 2 15

  probe_add_output=$(rig context add "$example" --name "$probe_ref" --json 2>/dev/null)
  probe_add_status=$?
  probe_installed_at=$(printf '%s\n' "$probe_add_output" | sed -n 's/.*"installedAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | sed -n '1p')
  [ "$probe_add_status" -eq 0 ] || example_install_ok=0
  [ "$probe_installed_at" = "$probe_target" ] || example_install_ok=0

  probe_list_output=$(rig context list --json 2>/dev/null)
  probe_list_status=$?
  if [ -d "$probe_target" ] || printf '%s\n' "$probe_list_output" | grep -Eq "\"relativePath\"[[:space:]]*:[[:space:]]*\"$probe_ref\""; then
    probe_installed=1
  fi
  [ "$probe_list_status" -eq 0 ] || example_install_ok=0
  printf '%s\n' "$probe_list_output" | grep -Eq "\"relativePath\"[[:space:]]*:[[:space:]]*\"$probe_ref\"" || example_install_ok=0

  if [ "$probe_installed" -eq 1 ]; then
    cleanup_probe || example_install_ok=0
  fi
  probe_cleanup_output=$(rig context list --json 2>/dev/null)
  probe_cleanup_status=$?
  [ "$probe_cleanup_status" -eq 0 ] || example_install_ok=0
  if [ -d "$probe_target" ] || printf '%s\n' "$probe_cleanup_output" | grep -Eq "\"relativePath\"[[:space:]]*:[[:space:]]*\"$probe_ref\""; then
    example_install_ok=0
  fi
fi
if [ "$example_install_ok" -eq 1 ]; then
  pass world-example-install 'context add installs the example, list exposes its ref, and cleanup removes it'
else
  fail world-example-install 'the typed context store or taught add/list effect is false'
fi

expected_session=${OPENRIG_SESSION_NAME:-${RIGGED_SESSION_NAME:-}}
identity_output=$(rig whoami --json 2>/dev/null)
identity_status=$?
identity_ok=1
[ "$identity_status" -eq 0 ] || identity_ok=0
printf '%s\n' "$identity_output" | grep -Eq '"rigName"[[:space:]]*:[[:space:]]*"[^"]+"' || identity_ok=0
printf '%s\n' "$identity_output" | grep -Eq '"memberId"[[:space:]]*:[[:space:]]*"[^"]+"' || identity_ok=0
printf '%s\n' "$identity_output" | grep -Eq '"sessionName"[[:space:]]*:[[:space:]]*"[^"]+@[^"]+"' || identity_ok=0
if [ -n "$expected_session" ]; then
  printf '%s\n' "$identity_output" | grep -Fq "\"sessionName\":\"$expected_session\"" || identity_ok=0
fi
if [ "$identity_ok" -eq 1 ]; then
  pass derive-identity 'rig whoami returned a complete managed-seat identity'
else
  fail derive-identity 'rig whoami did not return a complete managed-seat identity'
fi

topology_output=$(rig ps --nodes --json 2>/dev/null)
topology_status=$?
topology_ok=1
[ "$topology_status" -eq 0 ] || topology_ok=0
[ -n "$expected_session" ] || topology_ok=0
printf '%s\n' "$topology_output" | grep -Eq "\"canonicalSessionName\"[[:space:]]*:[[:space:]]*\"$expected_session\"" || topology_ok=0
printf '%s\n' "$topology_output" | grep -Eq '"rigName"[[:space:]]*:[[:space:]]*"[^\"]+"' || topology_ok=0
if [ "$topology_ok" -eq 1 ]; then
  pass derive-topology 'rig ps node detail returned this seat under its canonical session identity'
else
  fail derive-topology 'rig ps node detail did not include this seat under its canonical session identity'
fi

if grep -Fq 'rig whoami --json' "$root/start-here.md" &&
   grep -Fq 'rig ps --nodes --json' "$root/start-here.md" &&
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

if [ "$profile_ok" -eq 1 ] && [ -n "$profile_tokens" ] && [ "$profile_tokens" -gt 0 ]; then
  pass derived-reading-cost "the live composer reported a positive reading cost ($profile_tokens tokens)"
else
  fail derived-reading-cost 'the live composer did not report a positive reading cost'
fi

profile_help=$(rig context profile --help 2>/dev/null)
profile_help_status=$?
if [ "$profile_help_status" -eq 0 ] && ! printf '%s\n' "$profile_help" | grep -Eq -- '--region([[:space:]=]|$)'; then
  pass no-region-selector 'the live profile surface has no region selector'
else
  fail no-region-selector 'the stated no-selector boundary disagrees with the live profile surface'
fi

if grep -Fq 'If a repository uses AGENTS.md, keep repo instructions there; a world complements those instructions.' "$root/start-here.md"; then
  pass agents-md-complement 'the world complements repository instructions'
else
  fail agents-md-complement 'the repository-instruction boundary is absent'
fi

example_regions_ok=1
for region in identity ontology terrain actors laws history state affordances; do
  grep -Eq "regions:.*(^|[^a-z])$region([^a-z]|$)" "$example/manifest.yaml" || example_regions_ok=0
done
if [ "$example_regions_ok" -eq 1 ] &&
   grep -Fq 'Book world' "$example/your-world.md" &&
   grep -Fq 'rig context get world-example' "$example/your-world.md" &&
   grep -Fq 'rig context add <pack-directory>' "$example/your-world.md" &&
   grep -Fq 'rig context list' "$example/your-world.md" &&
   grep -Fq 'rig config get context.packs_root' "$example/your-world.md"; then
  pass world-example-consistency 'the worked exercise uses the same atom convention'
else
  fail world-example-consistency 'the worked exercise is absent or ungraduated'
fi

printf '%s passed · %s failed · %s skipped\n' "$passed" "$failed" "$skipped"
[ "$failed" -eq 0 ]
