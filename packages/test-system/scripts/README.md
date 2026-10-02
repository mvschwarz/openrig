# Scenario-resolved stub scripts

Per the 51-01 scripted-response contract, a scenario may resolve a per-seat stub script
delivered at `up`; 51-01's built-in DEFAULT script (come-up → readiness) applies when a
scenario names none.

## Current state
- The lifecycle / send / queue / policy / ps scenarios (#1, #2, #3, #4, #7, #9, #10)
  need only the 51-01 built-in default come-up-ready script — no custom script here.
- The emit-behavior scenarios (#6 compaction, #8 slow_output) use step-time `emit`
  steps. The FOUR behaviors {compaction, slow_output, mid_turn_death, restore} now exist,
  but only inside a per-seat launch script: a JSON `{steps: [...]}` file of `say` and
  `emit` steps that a scenario maps to a seat with `env.stub_scripts` and that the stub
  reads from `<seat cwd>/.openrig/stub/script.json` at launch (host mode only). A
  step-time `emit` throws `UnboundActionError`. No behavior scripts are authored here
  yet, so #6 and #8 stop at their first `emit` step (R-01/R-02).
- No script names `usage_limit` — it is real-runtime-only and must fail validation loud
  in a stub topology.

This directory is intentionally light: 51-03 is compose-only, and a stub behavior it
cannot yet honestly script routes back to 51-01 rather than being faked here.
