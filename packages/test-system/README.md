# 51-03 seed scenarios — the ten (+ one)

Compose-only L2 scenario set for the OpenRig containerized test system (mission
release-0.5.1). Each scenario pins a NAMED defect class from the 0.4.8/0.5.0 marathon
and becomes standing infrastructure instead of a hand-built probe.

## Authoring authority (verified at authoring time)
- 51-03 spec: README `99f35af5c2d854a7` / PRD `aa0638f161cc3b82` (hash-verified).
- **Format is the LOCKED 51-02 spec** (README `b157f5bc68940963` / PRD `1bf3340188e39212`)
  and the BINDING arch shape `ARCH-SHAPE-scenario-format-and-runner` sha256
  `fc30a736c104863a…`. The daemon-lifecycle step verb for #11 is arch-ruled in
  `ARCH-RULING-51-09-host-identity-and-51-02-step-verb` (`daemon: {op: sigterm|restart}`
  on the shared env-helper's lifecycle surface).
- `emit.behavior` vocabulary = 51-01's LOCKED FOUR {compaction, slow_output,
  mid_turn_death, restore}. `usage_limit` is real-runtime-only and MUST fail validation
  loud in a stub topology — no scenario here names it.
- Assertions ride the shipped-observable surface set ONLY: `ps` · `queue` · `stream` ·
  `scope` · `proof` · `pane` · `transcript` · `tui_socket` · `policy_provenance`. No
  internal DB pokes.

## Layout
- `scenarios/*.yaml` — the eleven scenarios (§6 ten + the A1 eleventh), one file each,
  the scenario name naming its defect class.
- `fixtures/*.yaml` — topology rig specs, seats `runtime: stub`.
- `scripts/` — scenario-resolved stub scripts (per the 51-01 scripted-response
  contract); 51-01's built-in default script applies when a scenario names none.
- `ROUTING.md` — every capability this set needs that the LOCKED 51-02/51-01 build must
  land BEFORE these run. Per 51-03 mini-req 2 these are ROUTED, never shimmed here.

## The seed contract (per-scenario, binding — kills the unfalsifiable-RED risk)
Every scenario carries a `seed_regression: {class: …}` step and, in its header, a
**SEED definition**: exactly what a seeded regression of its class plants, and why the
scenario's `expect` legs MUST catch it. Acceptance per scenario = the PAIR: GREEN on the
shipped tip + RED on the seeded run whose runner diff (expected vs last-observed) names
the class. A scenario that cannot be shown RED is not delivered.

## Run status honesty (authored before the runner exists)
YAML authoring is cleared ahead of the 51-02 runner (dispatch authority). These files
are the runner's acceptance targets; they are authored to the locked format and DO NOT
run until 51-02 lands the runner + env-helper and 51-01 lands the emit repertoire (items
5–8). Scenario #11 is RED-FIRST: its GREEN gates on the 51-06 transactional
execution-closure fix; until then its expected-RED runs are recorded as expected-RED,
never massaged. See `ROUTING.md` for the exact per-item dependencies.
