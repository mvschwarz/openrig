# Scenario-resolved stub scripts

Per the 51-01 scripted-response contract, a scenario may resolve a per-seat stub script
delivered at `up`; 51-01's built-in DEFAULT script (come-up → readiness) applies when a
scenario names none.

## Current state (authored before 51-01 items 5–8 land)
- The lifecycle / send / queue / policy / ps scenarios (#1, #2, #3, #4, #7, #9, #10)
  need only the 51-01 built-in default come-up-ready script — no custom script here.
- The emit-behavior scenarios (#6 compaction, #8 slow_output) consume the 51-01 FOUR
  behaviors {compaction, slow_output, mid_turn_death, restore}, which land in 51-01
  items 5–8 (R-01). Their behavior scripts are NOT authored here yet: the emit seam does
  not exist until 51-01 lands it, and authoring a script against an unbuilt seam would be
  the exact fabrication this system exists to prevent. They are ROUTED (R-01/R-02) and
  drop in when the repertoire lands.
- No script names `usage_limit` — it is real-runtime-only and must fail validation loud
  in a stub topology.

This directory is intentionally light: 51-03 is compose-only, and a stub behavior it
cannot yet honestly script routes back to 51-01 rather than being faked here.
