---
kind: as-built
title: Transport, Transcripts, Chat, Ask
status: active
topics: [coordination, observability]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need to know how rig send/capture/broadcast works, how transcript capture
  (periodic tmux capture-pane) and rg/grep search behave, how durable rig chat
  (SQLite + SSE) is modeled, what rig ask gathers, or the exact MCP-tool-name
  vs tmux-metadata-key naming distinction.
siblings: [daemon-core.md, lifecycle-snapshot-restore.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: e8f0ab340db773392ec8be75b072d1c0f3068a50
last-updated: 2026-10-08
---

# Transport, Transcripts, Chat, Ask

The communication-and-history layer: tmux is transport, not truth. Send/
capture/broadcast wrap tmux with honest errors; transcripts are bounded
`tmux capture-pane` snapshots written to files; chat is daemon-backed SQLite;
the daemon's `rig ask` service gathers evidence and never calls an LLM.

> Verified against source at main `e8f0ab340db773392ec8be75b072d1c0f3068a50`. Each count below sits beside the
> command that produces it; run the command from the repository root to refresh
> it.

## 1. The naming axes (read this first)

Two independent naming axes meet in this layer. They must not be conflated or
blanket-replaced: `rigged` → `rig` is a per-occurrence question, not a global
substitution.

**Axis 1 — MCP tool names are `rig_*`.** `packages/cli/src/mcp-server.ts`
registers **23** tools, all named `rig_*`
(`grep -c 'server.tool(' packages/cli/src/mcp-server.ts`), including
`rig_rig_nodes` (`mcp-server.ts:290`), `rig_send` (`:307`),
`rig_capture` (`:341`), `rig_chatroom_send` (`:366`) and `rig_chatroom_watch`
(`:402`), and the five queue tools `rig_queue_create`, `_show`, `_list`, `_claim`
and `_update`. No `rigged_*` name other than the tmux keys below remains in product
source: **0** hits
(`git grep -n 'rigged_' -- ':(glob)packages/*/src/**' | grep -v -c '@rigged_'`).

**Axis 2 — tmux metadata keys are `@rigged_*`, and are correct as-is.** The
tmux metadata keys written at claim/bind time are a separate thing from MCP
tool names and were not renamed. `setRiggedMetadata` in
`packages/daemon/src/domain/claim-service.ts:182`–`186` writes exactly **5**
keys (`grep -c '@rigged_' packages/daemon/src/domain/claim-service.ts`):
`@rigged_node_id`, `@rigged_session_name`, `@rigged_rig_id`,
`@rigged_rig_name`, `@rigged_logical_id`. Do not blanket-sed `rigged` → `rig`.
The metadata-key axis is detailed in `agent-spec-and-startup.md` (identity:
whoami, bind, adopt).

## 2. Transport and communication domain services

All under `packages/daemon/src/domain/`:

- `session-transport.ts` — communication primitives: send/capture/broadcast
  with session resolution, send-readiness classification (interactive-prompt
  and mid-work detection), honest error reporting, and list/pod/rig/global
  targeting.
- `transcript-store.ts` — transcript file management: path convention, ANSI
  stripping for tail and grep reads, boundary markers, `readTail`, `readFull`, `grep`.
  Filesystem-backed, NOT SQLite. The capture that writes the files is
  `transcript-rotation.ts` (§4).
- `history-query.ts` — transcript + chat search. Prefers `rg`, falls back to
  `grep -E`, surfaces which backend was used: `history-query.ts:8`
  `backend: "rg" | "grep" | "none"`; `:252` runs
  `rg -i --no-filename -e <pattern>` over the rig's transcript directory;
  `:267` falls back to `grep -E -i -h -e <pattern>`.
- `ask-service.ts` — context-engineering evidence pack: gathers rig summary
  plus transcript excerpts, chat excerpts, insufficiency state, guidance.
  Does NOT call an external LLM.
- `chat-repository.ts` — durable rig-scoped chat over the `chat_messages`
  table (`send`, `sendTopic`, `history`, `latest`, `searchChat`, `clear`). The
  repository emits no events: `routes/chat.ts` emits `chat.message` on the
  event bus after each send or topic, and `/watch` streams those as SSE.

Routes: `packages/daemon/src/routes/{transport,transcripts,ask,chat,whoami}.ts`
— all present.

## 3. Communication flow

`rig send <session> "message"` → CLI → `POST /api/transport/send` →
`SessionTransport.send()`:

1. Resolve the session name (`resolveBySessionName`,
   `session-transport.ts:963`): not found → 404; the same name in more than
   one rig → 409. A tmux probe of the session can also refuse it as missing or
   tmux as unavailable (`:1317`–`1334`). Pod, rig, global and `--to` list
   targets go through `POST /api/transport/broadcast`, which resolves them
   with `resolveSessions` and sends to each recipient in turn.
2. Take the seat's delivery lease. Every write runs under a per-seat,
   serialized lease from the seat delivery guard, installed at daemon start
   (`send`, `:1155`). With the seat's typing guard on, the message is held
   instead of typed: the result is `outcome: "retained"` with HTTP 200
   (`routes/transport.ts:115`); operators use `rig seat set-typing-guard` and
   `rig seat held-messages`. This same typing guard has `off` (default),
   `draft-aware`, and `hold` modes. The legacy enabled boolean selects hold/off.
   `DraftAwareDelivery` makes one attempt for opted-in seats and immediately returns
   the exact refusal reason and original held IDs when input is unavailable.
   Migration `100_typing_guard_modes` extends existing guard/audit rows and adds
   non-executable receipt metadata to the original outbox; it creates no tables
   or retry scheduler. Combined wakes preserve every original ID/body.
   Legacy storage bits fail safe to hold on rollback; newer legacy audit writes
   supersede older saved modes on re-upgrade, including same-value writes.
3. Classify send readiness. Only a positive interactive-prompt reading
   (`needs_input`) refuses, with `target_needs_input`
   (`session-transport.ts:1482`), unless the caller passes
   `--dangerously-interact --reason`; that override persists an audit record
   before sending and refuses the send if it can't
   (`prompt_override_audit_unavailable`, `:1471`). A pane that reads `unknown` while the seat's
   latest runtime hook says it waits on a person reads as `needs_input` (`session-transport.ts:1878–1889`). A mid-work reading (`running`, from a
   fresh runtime hook or the pane's mid-work patterns,
   `findPatternEvidence(recentLines, [...MID_WORK_PATTERNS, CLAUDE_LIVE_STATUS_PATTERN])`,
   `:311–315`) or an `unknown` one proceeds with an advisory `warning` (`:1495`,
   `:1503`). `--force` has no effect on this path, and combining it with
   `--wait-for-idle` is refused with 400 (`routes/transport.ts:66`–`73`).
4. Two-step tmux send: a unique file/buffer pasted with `paste-buffer -d -r -p`
   (`packages/daemon/src/adapters/tmux.ts:625`) → ~200ms delay
   (`session-transport.ts:1558`) → separate named `Enter` (`session-transport.ts:1573–1578`). The paste
   targets the seat's registered pane ID, not the session name, and is refused
   with no input written if the session no longer holds exactly that pane.
   Bracketed paste preserves multiline input in supporting TUIs; the payload
   never enters a shell argument. A `--dangerously-interact` answer is pasted
   without `-p` (`session-transport.ts:1541`) and Enter is pressed only if the
   whole answer is still staged (`:1562`–`1570`). A successful paste proves
   transport execution, not runtime consumption.
   The transport's prompt reader uses the shared `composer-prompts.ts` matchers
   from Mr-Neutr0n's #635. Its cursor-aware extension preserves capture styling
   and excludes a wholly dim autocomplete suffix after the cursor. The daemon
   directly depends on `string-width` to compare Unicode terminal cell widths
   with cursor positions and exact staged text; a dependency hoisted from the
   TUI would not declare this daemon runtime requirement. Default seats retain
   their existing advisory recognition and staged-text verification behavior.
   For draft-aware seats, `TmuxAdapter` checks the current composer after buffer
   preparation and again immediately before keys. The delivery lease records
   the pasted text and any observed collapsed-paste label; Enter requires that
   owned input. Late human input, changed recipients or stopped queue wakes refuse
   further input or hold the message; ambiguous writes remain indeterminate. Nothing
   is retried automatically. Unicode cell widths use the daemon's direct
   `string-width` dependency. See [per-seat terminal delivery](../../reference/seat-delivery.md)
   for activation, persistence, inspection and lifecycle tradeoffs.
5. Optional `--verify`: capture the last 30 pane lines before the paste and,
   500 ms after Enter, again, leaving out the current input box (the last
   prompt line and its continuation, `verificationTranscript`). A send
   carrying OpenRig's From/To header is matched as the whole message with
   whitespace normalized (`countEnvelopeOccurrences`); a raw send is matched
   by its first 40 characters (`verificationSnippet`). More occurrences after
   the send report `outcome: "delivered"`; otherwise the outcome is
   `rendered-unconfirmed`: text and Enter landed but the capture could not
   re-confirm the render, which is not a failure. The outcome values are
   `delivered`, `rendered-unconfirmed`, `failed` and `retained`.
   With `transport.verify_input_box` on (off by default), a Claude Code or
   Codex send is verified only when the seat was proven idle before the paste
   and the input box shows the message, and is unconfirmed otherwise:

   - **Seat idle before the paste** (`readSeatBeforePaste`). The `--verify`
     capture taken before the paste (the whole screen) must match an idle
     allow-list (`SEAT_IDLE_SHAPES`) built from real Claude Code 2.1.296 and
     Codex 0.160.0 frames and, where no frame was captured, from the Claude
     Code 2.1.296 bundle, the Codex 0.160.0 source and OpenRig's own launch
     code. Claude Code: the empty box or its `Try "…"` suggestion between two
     rules; the opening rule plain, or carrying this seat's own session name
     the way Claude Code draws `--name` (`─…─ <session> ─`, or `──` as in
     earlier versions, as wide as the closing rule; OpenRig launches every
     Claude seat with `--name`); the footer row of the seat's permission
     posture, one for each mode OpenRig can launch: bypass
     (`⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`), accept
     edits (OpenRig's default), auto, don't ask, plan, and default
     (`⏸ manual mode on · ← for agents`); no statusLine row between the
     closing rule and the footer (OpenRig's statusLine collector prints
     nothing); a blank, effort or tmux-notice row above the box; and above
     that, in the status slot, the completion row of the seat's last turn
     (`✻ <verb> for <duration> · done <time>` at column 0, matched by the
     Claude Code 2.1.296 bundle's grammar: one of its eight past-tense verbs,
     its duration format, and the time of a turn finished today on a 12- or
     24-hour en-US clock). A blank slot counts only under that completion
     row, with only blank rows between them (as in the fullscreen renderer),
     or, before the first turn, under the last row of the Claude Code v2.1.296
     welcome banner. OpenRig launches Claude in the classic renderer, where the
     box follows the transcript, so an idle seat that has finished a turn
     shows that turn's completion row in the slot; real frames of idle seats
     OpenRig launched show it. A configured statusLine, which OpenRig installs
     on every Claude seat, makes Claude Code drop the footer's hints, so a
     running turn draws the same footer row as an idle one, without
     `esc to interrupt`: the status slot is what tells them apart. The 2.1.296
     bundle draws the live status row (the spinner) there only while no
     streamed text with a complete line is on screen
     (`isLoading && (!hasDisplayedStreamingText || tailBlank || …)`); while
     streamed text is shown it draws nothing in its place, and the last
     streamed row moves into the slot. That row never matches the completion
     row, because Claude Code draws a message behind its `●` column. The
     bundle does not show that the last streamed row is never blank, so a
     blank slot under transcript text reads `unknown`: that case is left
     unconfirmed rather than read as idle. Codex: the empty box over its
     status line and a `? for shortcuts` hint row, with the completion row or
     the fresh session's greeting as the last row above the box. The
     completion row is matched by the grammar Codex 0.160.0 prints it with
     (`Worked for <elapsed> • <time>`, a 12- or 24-hour clock, a date before
     the time on another day, runtime metrics after it). No row anywhere may
     be a running, streaming, queued, pending-input or paste-hint row (a live
     status row, `esc to interrupt`, `paste again to expand`, a queued label,
     Codex's pending-input headers or `↳` rows, a spinner). Any other frame,
     including every running, streaming, steer-preview, paste-hint or unknown
     layout, another seat's name, a statusLine that prints a row, a background
     shell in the footer and a fullscreen renderer with a statusLine (which
     reserves a row for it), reads `seat: not-idle` or
     `unknown`, and the send reads unconfirmed. This holds when a running turn
     hides its signal (Codex hides its `• Working` row while it streams;
     Claude Code shows only `paste again to expand` in its footer for 8 s
     after a paste, and no `esc to interrupt` under a statusLine). So a send to
     a busy or unknown seat always reads unconfirmed.

     **Versions.** The layouts were recorded from Claude Code 2.1.296 and
     Codex 0.160.0 (the versioned frames under
     `packages/daemon/test/fixtures/input-box/`, with their limits in that
     folder's README). A frame that visibly names another client version reads
     `unknown` before the paste and `unrecognized` in the box: Claude Code's
     welcome banner (`Claude Code v2.1.297`), Codex's session header
     (`>_ OpenAI Codex (v0.161.0)`) or its update notice, whose first version
     is the running one (`Update available! 0.159.0 -> …`). Most frames
     show no version (the banner and header scroll away), and there a matching
     layout is evidence about the layout only, not proof of the client
     version: another version that draws the same rows reads the same. There is
     no version discovery and no extra read for it.

     Which Claude seats OpenRig launches can verify: an idle Claude Code
     seat in any posture OpenRig launches, after any number of turns, whose
     status slot holds its last turn's completion row as above, or a fresh
     seat whose slot is blank under the welcome banner. It reads `unknown`
     when that row is anything else: a blank row under transcript text, a
     completion row with more after the time (a still-running note, hidden
     messages, a budget), the weekday or date of a turn that finished on an
     earlier day, another locale's or a custom time format, an interrupted
     turn, or a row printed after the turn. And only a text Claude Code shows
     inline in its box can verify (see the box reading below): a multi-line
     text, which includes every `rig send` envelope and every queue wake,
     collapses to a paste label and stays unconfirmed.
   - **The box held exactly this message before Enter.** One extra capture
     between the paste and Enter must show exactly the sent text in the input
     box with its word boundaries kept (`readInputBox`, `boxHoldsText`): runs
     of whitespace, including Unicode spaces, compare as one space, so a box
     holding `nowhere` is not the text `now here`. A row break counts as a
     space only where it must be whitespace of the box's text. Claude Code
     2.1.296 wraps its input at spaces only (wrap-ansi). Codex 0.160.0 wraps
     it with textwrap (FirstFit, UAX #14 break opportunities, the hyphen
     splitter), which also breaks with no space drawn after a hyphen or a
     slash and between ideographs. So a break counts where the next row's
     first word would have fit on the row before it (both wrappers fill a row
     first, so the text has a line break there), or where it falls between
     two ASCII letters or digits, or before a hyphen, a slash, a closing
     bracket or `.,:;!?`, and the two words it separates, joined, fit in the
     box's widest row, but only after a row whose text starts at its first
     cell with a printable ASCII character and whose last word is ASCII
     letters, digits, `'` and `.,:;` only. Codex keeps a word that fits in a
     row whole only where the word starts on a row that already holds text:
     a row holding only indentation absorbs the next word and splits it
     where the row fills, and a word after a hyphen or a slash can be split
     the same way in a row that took the next textwrap line. So on Codex a
     split between two letters is not always the text's space; after an
     indented row, or after a last word with a break opportunity inside it,
     only the first rule reads the break. The first rule has one known
     residual on Codex, found in a model of the rust-v0.160.0 source, not in
     a live capture: once an indented row has absorbed and split a word, the
     re-pass can end a later row early at a hyphen, so a break with no
     whitespace can pass the first rule. Every such box in that model also
     holds the earlier split after the indented row, which reads `ambiguous`,
     so the box never reads `exact`. The widest row is counted in
     printable ASCII cells only, so combining marks, joiners and zero-width
     characters never widen it. Any other break, and a break inside a word of
     the text, reads `ambiguous` and the send stays unconfirmed. A collapsed paste label, Claude's
     queued-messages label or `Try "…"` suggestion, or another draft is never
     the message. The default `--verify` matcher above is unchanged.
   - **The box is empty after Enter on the same pane process.** The capture
     after Enter must show the box empty, with the pane process
     (`#{pane_pid}`) and the seat's binding unchanged.

   The result's `inputBox: { seat, before, after, sameProcess }` says which
   reading failed. An empty box reads `queued` instead of `empty` where the
   frames say the message may wait behind a turn: Codex's pending-input rows
   or a row under its running-turn status, or a running turn in the frame
   read before Enter (Codex's `• Working` row; for Claude Code,
   `esc to interrupt` or a live status row above the box, including above a
   box of several rows). The verdict uses these readings: verified needs
   `empty`, so for a seat that was idle before the paste they are the only
   check that rejects a message queued behind a turn that started after the
   pre-paste capture. An audited prompt answer (step 4) reads no box: with
   the setting on its `inputBox` reads `unchecked` for `seat`, `before` and
   `after`, `sameProcess` is `false` (it stays a boolean), and the send reads
   unconfirmed, whatever the default matcher would say.
   It reports only: the seat is read from the capture `--verify` already
   takes, and none of the extra reads decides whether Enter is sent. Each has
   a 500 ms deadline, which is a budget, not a guarantee: the pre-Enter read
   comes after the existing 200 ms wait and can add about 500 ms before
   Enter, and the post-Enter process read can add about another 500 ms
   before the reply. A read that misses its deadline reads `unavailable`, the
   send stays unconfirmed, and Enter is still sent once. With a deliberately
   slowed screen read, review measured about 718 to 721 ms from paste to
   Enter, against about 216 to 219 ms on main under the same slowdown.
   Limits: the seat is read once, before the paste, and Enter
   follows about 200 ms later. A turn can start in that window, from a person
   typing in the pane or from the agent itself (Claude Code and Codex start
   turns on their own when a background task finishes, a scheduled wake-up
   fires or a teammate's message arrives). Such a turn is caught only when
   the frame read before Enter shows it; a Codex turn already streaming
   there hides its `• Working` row and is not seen. An empty box after an
   exact one means the box was cleared, normally by our Enter; a clear by
   something else at that moment (a person's C-c) looks the same, and so
   does a text the TUI runs as a command (a Claude Code `/command`, a Codex
   `!command`), which clears the box without the model reading a message.
   `#{pane_pid}` is the pane's root process (the shell for most launches), so
   an agent restarted under the same shell is not caught by the pane process
   check, and the same pane and binding are not proof of the same native
   conversation.
   An empty box means the TUI took the text, not that the model read it.
   Consumers see only the report. With the setting on, a queue wake that
   reads unconfirmed records the existing `delivered-ack-pending` state, as
   an unconfirmed wake does today. Every queue wake to Claude Code is
   unconfirmed under the setting, because its multi-line envelope collapses
   to a paste label, and so is a wake to a busy or not-proven-idle Claude
   Code or Codex seat. A pending, unclaimed handoff with no pickup evidence
   can then enter the wake ladder's existing escalation path after
   `queue.wake_unconfirmed_window_minutes` (default 30). It is not blindly
   re-sent: the ladder's unconfirmed path skips its retry rung
   (`queue-wake-ladder.ts`), and nothing in the send path retries or
   re-sends.
6. CLI `--verify` goes further (`packages/cli/src/commands/send.ts:596`): it
   looks for the text still unsubmitted at the prompt, makes one guarded
   Enter-only retry through the daemon's `submitOnly` path
   (`session-transport.ts:1344`, which refuses with `staged_mismatch` unless the
   pane shows the expected staged text), and ends `staged-not-consumed` with
   exit code 1 if it is still there.
7. Honest result with reason on failure. Reasons missing from the send
   route's status map (among them the runtime-identity refusals) are returned
   with HTTP 500 (`routes/transport.ts:118`–`140`).

The sender comes from the `X-OpenRig-Session` header; an unsigned send gets an
unknown-sender notice. The CLI adds a From/To envelope, and the daemon appends
a delivered-latency note for delays of 10 s or more.

Architecture rule 18 (`architecture-rules-and-event-system.md`): tmux is
transport, not truth — `send/capture/broadcast` wrap tmux reliably with honest
errors.

The daemon runs tmux without a shell: argv straight to the tmux binary found on
`PATH`. `OPENRIG_TMUX_SHELL=1` at daemon start runs every tmux call through
`/bin/sh` instead (Linux and macOS; Windows always uses argv). A binary that
can't be started at all (a script without `#!`, a missing interpreter) runs
through `/bin/sh -c 'exec "$0" "$@"' tmux …`, which finds tmux as the shell
path does; nothing ran before, so no command runs twice. The resolved path is
cached, so a different tmux installed earlier on `PATH` takes effect after a
daemon restart.

### 3b. Cross-host coordination verbs

`rig send/capture/transcript/broadcast --host <id>` (and the `agent@rig@host`
target sugar on the session-target verbs) cross the host boundary through the
remote daemon's ordinary local routes; the cross-host logic is in the CLI.

- **Sidedness and caller pick the seam.** One-sided remote operations from a
  caller that can resolve the registry bearer locally (the CLI) go
  **CLI-direct** through `runRemoteHttpOp`
  (`packages/cli/src/remote-host-ops.ts:25`) — one hop, no local-daemon
  involvement, as `rig ps --all-hosts` does. Two-sided operations (a
  cross-host queue handoff closes the local source and creates the remote
  successor, so the local daemon owns half the transaction) and callers
  without the bearer (the browser: Mission Control actions and the `?host=`
  read-through) go through the local daemon, which forwards to the remote.
  These four verbs are one-sided remote operations from the CLI.
- **The host entry dictates the transport (ssh or http), never a per-call
  choice.** ssh hosts shell out over ssh for send/capture
  (`packages/cli/src/cross-host-executor.ts`); http hosts (the kind
  `rig host pair` registers) go CLI-direct to
  `POST /api/transport/send|capture|broadcast` / `GET /api/transcripts/*` with
  the same bodies and paths the local CLI uses. transcript and broadcast are
  http-only (no ssh path exists for them); on an ssh host they fail with a
  structured error naming the transport requirement
  (`remote-host-ops.ts:47`), never a fallback.
- **Terminal-bearer posture (`/api/transport/*` only).** The remote's
  transport routes (send/capture/broadcast) gate on its terminal bearer
  (`routes/transport.ts:26`; `OPENRIG_TERMINAL_BEARER_TOKEN`,
  `packages/daemon/src/index.ts:291`). With no token configured the
  middleware passes every request through
  (`packages/daemon/src/middleware/auth-bearer-token.ts:99`) — the tailnet is
  the auth boundary by design — except that a daemon bound to an explicit
  address that is neither local nor tailnet falls back to
  `OPENRIG_AUTH_BEARER_TOKEN`
  (`index.ts:297`). The CLI presents the registry bearer from `hosts.yaml`
  when one is configured; for a URL-only anonymous host the `Authorization`
  header is omitted. A remote enforcing a different terminal bearer answers
  401, which surfaces as the structured `permission-gate` step
  (`packages/cli/src/host-registry.ts:53`) — never a hang, never silent.
  Remedy: set the remote terminal bearer equal to the paired registry bearer,
  or rely on the tailnet boundary. **The transcript read is deliberately
  outside this class:** `/api/transcripts/*` mounts with no bearer middleware
  (`packages/daemon/src/server.ts:748`, beside the gated `/api/transport` at
  `:749`), and credential-shaped text is redacted on the `/full` route only
  (`routes/transcripts.ts:292`). So a wrong terminal bearer that
  permission-gates `send --host` does NOT gate `transcript --host` — the read
  keeps succeeding for a Host name the remote's browser boundary accepts
  (`server.ts:647`; it applies to every `/api/*` route), and the auth-failure
  class is not uniform across the four verbs. The route's own comment (`routes/transcripts.ts:250`) leaves a
  coherent transcript-read auth policy across tail/grep/full for later.
- **The 3-part form is CLI-edge sugar only.** `resolveCrossHostTarget`
  (`packages/cli/src/cross-host-target.ts:58`) strips the suffix only when it
  resolves to a registered host, or equals this host's own id, which routes
  home (`:95`; only `rig send` passes the self id,
  `packages/cli/src/commands/send.ts:398`, so `capture` and `transcript` treat
  their own id as unknown); otherwise the string passes through unchanged with a loud
  host hint. Every session string that reaches any daemon stays
  `member@rig`; the host travels out-of-band. Durable cross-host
  coordination stays the queue's cross-host routing
  (`coordination-primitive.md`); these four verbs add no queue surface.

## 4. Transcript flow

1. `NodeLauncher` starts transcript rotation right after tmux session
   creation, before the harness boots
   (`NodeLauncher`, `startTranscriptRotation`).
2. Each rotation tick captures the trailing lines and atomically overwrites
   (temp file + rename in `startTranscriptRotation`)
   `transcripts/{rig-name}/{session-name}.log` under the OpenRig home (or
   the `transcripts.path` setting). It skips the write when the captured bytes
   are unchanged. Defaults: 1000 trailing lines every 2 s
   (`DEFAULT_TRANSCRIPT_LINES`, `DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS`); an idle seat is captured less often,
   within the 10-second freshness window. Both are tunable with
   `OPENRIG_TRANSCRIPTS_LINES` and `OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS`
   or the matching `transcripts.*` settings. This bounded capture replaced the
   earlier `tmux pipe-pane` stream (see the header comment of `transcript-rotation.ts`), so the file
   holds a trailing window, not the whole session. Sessions on one adapter
   tick on one shared timer, and the captures due in a tick share
   `capturePanesContent`: one chained call per chunk of 24, with a
   `list-sessions` started beside it on every batch, whose result is consulted
   only when the chain fails, each chunk on its own (`captureBatch` in
   `transcript-rotation.ts` → `capturePanesContent` in `adapters/tmux.ts`).
   A session the batch leaves out, a lone due session, or a pane or window
   target reads per target with `capturePaneContent` (`adapters/tmux.ts`).
3. `TranscriptStore` owns path convention, ANSI stripping for `readTail` and
   `grep`, boundary
   markers, `readTail`, `readFull`, `grep`. `readFull` returns the raw bytes
   (`TranscriptStore.readFull`); the `/full` route redacts them. The transcript
   routes check capture health first and can start capture lazily for a seat
   that has none.
4. `rig transcript <session> --tail N / --grep "pattern"` provides
   agent-facing access.
5. On restore: a `--- SESSION BOUNDARY: … ---` marker is written before
   re-launch (`RestoreOrchestrator`); each rotation tick keeps each
   distinct boundary line once, as a header above the fresh capture
   (`startTranscriptRotation`, boundary header). (Restore-side detail in
   `lifecycle-snapshot-restore.md`.)
6. `rig ask` gathers rig summary plus transcript excerpts, chat excerpts,
   insufficiency state, and guidance.

Architecture rule 19, as the code implements it: transcripts are a bounded
`capture-pane` snapshot (not pipe-pane), ANSI-stripped on tail and grep reads; `rg`
preferred, `grep -E` fallback. Rule 22: the daemon's `rig ask` is context
engineering — it gathers evidence and does NOT call an external LLM; the
agent IS the LLM. The one exception is the explicit CLI flag `rig ask --wake`
(`packages/cli/src/commands/ask.ts:88`), which runs a headless resume of a
Claude or Codex session (`claude -p --resume` / `codex exec resume`,
`packages/cli/src/ask-wake.ts:58`–`60`) to answer one question.

## 5. Chat flow

1. `rig chatroom send <rig> "message"` → `POST
   /api/rigs/:rigId/chat/send` → `ChatRepository.send()`
   (`routes/chat.ts:43`); the route then emits `chat.message` (`:45`).
2. SSE: `GET /api/rigs/:rigId/chat/watch` delivers real-time messages.
3. History: `GET /api/rigs/:rigId/chat/history` returns channel history in id
   order, 100 messages unless `limit` says otherwise
   (`chat-repository.ts:68`), filterable by `topic`, `after`, `since` and
   `sender` (a `since` SQLite cannot parse is refused with 400,
   `routes/chat.ts:73`); `POST /api/rigs/:rigId/chat/topic` persists topic markers.
4. UI: a `RigChatPanel` component exists
   (`packages/ui/src/components/RigChatPanel.tsx`), but no UI view mounts it:
   **1** file under `packages/ui/src` names it, its own
   (`git grep -l 'RigChatPanel' -- packages/ui/src | wc -l`).
5. MCP: **`rig_chatroom_send` + `rig_chatroom_watch`** (`mcp-server.ts:366`,
   `:402`).
6. Source of truth: daemon-backed SQLite (`chat_messages` table), NOT tmux
   scrollback.

**ChatMessage** type (`chat-repository.ts:6`): durable rig-scoped message —
`id`, `rigId`, `sender`, `kind`, `body`, `topic`, `createdAt`.

## 6. Compatibility notes

The intentional limits in this layer (numbered as in
`architecture-rules-and-event-system.md`):

- Note 4 — the daemon's `rig ask` gathers context only; it does not call an
  external LLM. The agent reasons about the gathered evidence. Only the
  explicit `--wake` flag executes a runtime (§4).
- Note 5 — transcript search prefers `rg` but falls back to `grep -E`;
  search quality/performance varies by backend.
- Note 6 — chat is rig-scoped only: no cross-rig channels or DMs.
- Note 7 — `--verify` on `rig send` reports what the pane shows, not agent
  acknowledgement. By default it compares the message (whole for a
  header-carrying send, the first 40 characters for a raw one) in captures
  before and after the send, leaving out the current input box; with
  `transport.verify_input_box` on, Claude Code and Codex sends are verified
  only for a seat proven idle before the paste and on input-box evidence; a
  busy or unknown seat reads unconfirmed (§3 step 5). When it cannot confirm,
  it reports `rendered-unconfirmed`, not a failure.

(The full compatibility-notes list lives in
`architecture-rules-and-event-system.md`.)

## See also

- `daemon-core.md` — the route-mount surface these routes sit in, and the MCP
  tool count.
- `agent-spec-and-startup.md` — the tmux `@rigged_*` metadata-key axis detail
  (whoami/adopt).
- `lifecycle-snapshot-restore.md` — restore-side transcript boundary
  markers.
- `coordination-primitive.md` — cross-host queue routing (the two-sided
  daemon-forward twin of §3b's one-sided CLI-direct verbs).
- `../cli-reference.md` — each verb's registered `--host <id>` option; run
  `rig <verb> --help` for its cross-host behaviour.
- Source roots: `packages/daemon/src/domain/{session-transport,transcript-store,transcript-rotation,history-query,ask-service,chat-repository}.ts`,
  `packages/daemon/src/routes/{transport,transcripts,ask,chat}.ts`,
  `packages/cli/src/mcp-server.ts`,
  `packages/cli/src/{remote-host-ops,cross-host-target,cross-host-executor,ask-wake}.ts`.
