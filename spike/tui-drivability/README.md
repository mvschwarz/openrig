# Slice-11 Phase-0 spike — agent-drivability harness

Throwaway-grade harness answering the three Phase-0 spike questions (IMPL-PLAN
2026-08-02): mechanism form, rendering substrate, safe-core grammar. Zero
dependencies; plain node ESM + `node:test`; stub data stands in for the §4.A
daemon reads (the spike makes no daemon calls).

Run interactively (ideally inside a tmux pane):

    node spike/tui-drivability/harness.mjs --instance tui-a --socket /tmp/tui-a.sock

Type commands in the bar (`:topology` `:specs` `:needs`, `/filter`,
`rig <name>`, `agent <name>`, `spec-of <agent>`, `running <spec>`); arrows +
Enter navigate the explorer; mouse clicks hit the same targets; `q` quits.
The optional control socket accepts the same grammar one command per line
(plus `state` for a JSON state query) — the "addressable-screen API" candidate.

Tests: `node --test spike/tui-drivability/*.test.mjs`

The recorded verdict lives in the slice folder's `proof/` (see
SPIKE-VERDICT-2026-08-02-dev50-driver.md); this code is evidence, not the
Phase-1 implementation.
