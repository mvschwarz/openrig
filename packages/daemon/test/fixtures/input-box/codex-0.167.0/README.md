# Codex 0.167.0 activity frames

Captured from an OpenRig-managed Codex terminal on Linux, at 120 columns. The
runtime reported `codex-cli 0.167.0` separately; neither captured tail displays
the client version. These frames establish the drawn layout, not a general
allow-list for every screen of that version.

- `completed.txt`: another agent captured the terminal at the completed prompt
  with `rig capture`, before waking it, on 2026-11-11. The transcript was replaced
  by a generic response, and the local path and task title were redacted. The
  completion, blank rows, composer, model and hint/warning rows are retained.
- `working.txt`: captured during a tool turn with `rig capture`. Command text,
  output, local path and task title were redacted. The working row, tip, blank
  rows, composer and footer are retained.

No spinner-hidden streaming frame was captured. Tests that replace the completion
row with unfinished response text are synthetic controls, not native captures.
No fresh-session header, staged input or submit sequence is represented here.
