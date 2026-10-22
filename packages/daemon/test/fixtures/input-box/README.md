# Input-box frames

Real frames of Claude Code 2.1.296 (`claude-code-2.1.296/`) and Codex 0.160.0 (`codex-0.160.0/`), captured in a
120x40 tmux pane in an empty git work dir, and two frames of idle Claude Code 2.1.296 seats that OpenRig launched
(`claude-code-2.1.296/openrig-seat-*`, see below). `texts/` holds the texts that were sent.
`input-box-reading.test.ts` and `session-transport-input-box.test.ts` read them.

## Versions and their limits

Every frame here is of one client version, named by its folder; the idle allow-list and the box readers were built
from them. A frame that names another version in a row the client prints it in (Claude Code's welcome banner, Codex's
session header or update notice) reads `unknown` before the paste and `unrecognized` in the box; the
tests make such frames by editing the version in a real banner or header. Most frames show no version, and there a
matching layout is evidence about the layout only, not proof of the client version: another version that draws the
same rows reads the same.

## How they were captured

- Text was pasted the way OpenRig pastes it: `tmux load-buffer`, then `paste-buffer -d -r -p`.
- `*.J.txt` were captured with `capture-pane -p -J -S -80`, `*.raw.txt` without `-J`. The two idle frames
  without a suffix were taken before any paste.
- `staged-*` frames show the text in the input box before Enter.
- `cleared-without-enter` frames were cleared with C-c and never submitted.
- `submit-staged` shows `submit.txt` in the box; the `after-enter-*` frames follow that one submitted prompt by the
  stated number of seconds.
- The `product-path-*` Codex frames were captured with `--no-daemon`. The other Codex frames show
  `⚠ 1 warning · f2 to view` because on that launch path a local Codex background-server version mismatch added a
  warning.

| Text | Shape |
|---|---|
| `short.txt` | one line, 53 bytes |
| `envelope.txt` | a 7-line From/To message (219 bytes); Claude collapses it to `[Pasted text #1 +6 lines]`, Codex shows it inline |
| `wrapped.txt` | one 337-character line that soft-wraps into 3 rows |
| `large.txt` | 60 lines; Claude shows `[Pasted text #2 +59 lines]`, Codex `[Pasted Content 6770 chars]` |
| `submit.txt` | `Reply with the single word OK.` |

## Edits

The only changes from the captures are same-length replacements of local identifiers, applied to the frames and
the texts alike: the user's work-dir path segments became `workspace1` and `composer-demo`, the rig name became
`sample-rig`, and two ids became `0123456789abcdef01234567` and `0a1b2c3d`. In `wrapped.txt` and the
`staged-wrapped` frames, a few words of the sample sentence were replaced by words of the same length, so the
rows wrap at the captured places. Every other byte is as captured, including trailing cells, blank rows and the
no-break space after Claude's `❯` in the live input box.

## Strings that were not captured

Claude's `Press up to edit queued messages` label appears in no frame here (upstream's 2.1.289 crops in
`../claude-startup-paste-2.1.289.json` have it). Tests that need it, and the other states that were never
captured (a person's draft, an unknown footer, a missing separator, text staged while a Codex turn runs), edit
one line of a real frame in the test and say so where they do it. No frame shows a Codex message queued behind a
running turn; the tests that need one add a row under the real `• Working` row, and its shape is illustrative.
No frame shows a Claude message queued behind a running turn either. Claude Code 2.1.296 draws its queued label
only while a per-user hint counter is low, so the tests stage the text in the box of the real running frame
`after-enter-0.4s.J` and use that frame unedited as the empty box after Enter.

## The idle allow-list

`SEAT_IDLE_SHAPES` in `session-transport.ts` lists the screens a seat may show before the paste for a send to verify.
These entries come from the frames here: Claude Code `after-enter-15s.J` (empty box, blank row above the rule, the
bypass footer), `idle-fresh-suggestion` (Try suggestion, effort row), `cleared-without-enter.J` (tmux mouse notice)
and the tmux focus-events notice row of `staged-short`; Codex `idle` and `product-path-idle.J` (fresh session, the
two hint rows) and `after-enter-15s.J` (the completion row of a finished turn, 12-hour clock).

The frames above were captured from a plain `claude` and `codex`. Two frames are of idle Claude Code 2.1.296 seats
that OpenRig launched and that had each finished their startup turn:

- `openrig-seat-bypass-idle.txt` (seat `orch-advisor@sample-rig`, `--dangerously-skip-permissions`) and
  `openrig-seat-accept-edits-idle.txt` (seat `review-r1@sample-rig`, `--permission-mode acceptEdits`), captured with
  `capture-pane -p -S -400` from an 80-column pane, so they hold the seat's whole transcript. They show what OpenRig's
  launch draws: the classic renderer (the box follows the transcript), the session name on the box's opening rule,
  the posture's footer, no statusLine row, and in the status slot two rows above the opening rule the completion row
  of the seat's last turn (`✻ Crunched for 9s · done 10:50 PM`). The idle allow-list accepts that row by the grammar
  of the Claude Code 2.1.296 bundle (`CLAUDE_COMPLETION_ROW`); the tests edit the slot row of the bypass frame for
  each other verb, duration and clock form, for malformed rows and for running ones.
- Edits: same-length replacements of the shell prompt's user and host (`user@machine`), the user's home
  (`/srv/agenthome`), the work-tree path segments (`workspace1/run/work/proj1`), the rig name (`sample-rig`), the
  pid and random id of a send temp file (`100001-00000000-0000-4000-8000-000000000001` and `…0002`) and an agent-spec
  prefix (`demo-core`). Every other byte is as captured, including trailing cells and the no-break spaces after `❯`
  and `⎿`.

Upstream's real Claude Code 2.1.289 idle frame in `../claude-question-picker-2.1.289.json` (`dismissed100`) has the
same status slot (a completion row, then the effort row) and reads idle too.

Each entry for OpenRig's launch below also has a source besides those two frames (the other permission modes have no
captured frame), and the tests also make them by editing one line of a plain-`claude` frame, named where they do it:

- **The named box.** OpenRig launches every Claude seat with `--name <session>` (`claude-code-adapter.ts`), and
  Claude Code draws the name on the box's opening rule. The grammar `─…─ <session> ─`, as wide as the closing rule,
  comes from the Claude Code 2.1.296 bundle (the prompt-border banner: the rule, the name padded by one space each
  side, one rule cell). Real frames of OpenRig seats from earlier Claude Code versions end it with two rule cells
  (`session-transport.test.ts`, `fixtures/walk-staged-specimen`), so one or two are accepted; the `openrig-seat-*`
  frames have one. Only the seat's own session name is accepted.
- **The permission postures.** `claudePostureFlag` (`yolo-mode.ts`) launches `--permission-mode acceptEdits` by
  default, `--dangerously-skip-permissions` under YOLO or a full-bypass policy, `--permission-mode auto`, or any
  mode the installed Claude Code offers (2.1.296: acceptEdits, auto, bypassPermissions, default, dontAsk, plan). The
  idle footer row of each comes from the 2.1.296 bundle: the mode's symbol and indicator plus ` on`, then
  ` (shift+tab to cycle)` for every mode but default, then ` · ← for agents` while the box is empty. Bypass and
  accept edits are also real (`openrig-seat-*`; bypass also `after-enter-15s.J`, accept edits also a real Claude
  Code 2.1.220 capture in `claude-warning-footer-readiness.test.ts`).
- **The statusLine.** OpenRig installs its statusLine collector on every Claude seat (`provisionContextCollector`,
  `assets/claude-statusline-context.cjs`). The collector prints nothing to stdout, and the 2.1.296 bundle draws no
  row for an empty statusLine in the classic renderer OpenRig launches with, so the entry is "no row between the
  closing rule and the footer", as the `openrig-seat-*` frames show. A configured statusLine also makes Claude Code drop the footer's hints
  (`esc to interrupt`, `? for shortcuts`), so a running turn draws the idle footer row; the status row above the box
  is then the only running signal, and the allow-list requires a completion row there, or a blank slot whose first
  non-blank row above is that completion row or the last row of the welcome banner. While streamed text is shown
  Claude Code hides that row and draws nothing in its place (2.1.296 bundle), so the last streamed row moves into the
  slot; it never matches the completion row, and since the bundle does not show it is never blank, a blank slot under
  transcript text reads unknown. No frame here shows a streaming Claude seat; the tests' streaming frames are edits
  of the `openrig-seat-*` frames, named where they are made. The tests' OpenRig-shaped running frames are
  `after-enter-0.4s.J` with the named box and the accept-edits footer row in place of its own, and the
  `openrig-seat-*` frames with a live status row in the slot.

The Codex completion row is matched by the grammar Codex 0.160.0 prints it with (`tui/src/history_cell/separators.rs`
and `tui/src/clock_format.rs` at `rust-v0.160.0`): 12- and 24-hour clocks, a date before the time on another day,
runtime metrics after it. Only the 12-hour form was captured; the tests edit the row of `after-enter-15s.J` for each
other variant and for malformed ones.

No frame shows a Codex turn streaming (Codex hides its `• Working` row then) or a pending steer; the tests that need
them edit one or two lines of a real frame, with the row shapes taken from the Codex 0.160 source, and say so where
they do it.
