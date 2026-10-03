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
last-verified-against-source: 254122872cf477511514979a4300b695d77cd1f7
last-updated: 2026-10-03
---

# Transport, Transcripts, Chat, Ask

The communication-and-history layer: tmux is transport, not truth. Send/
capture/broadcast wrap tmux with honest errors; transcripts are bounded
`tmux capture-pane` snapshots written to files; chat is daemon-backed SQLite;
the daemon's `rig ask` service gathers evidence and never calls an LLM.

> Verified against source at main `254122872cf477511514979a4300b695d77cd1f7`. Each count below sits beside the
> command that produces it; run the command from the repository root to refresh
> it.

## 1. The naming axes (read this first)

Two independent naming axes meet in this layer. They must not be conflated or
blanket-replaced: `rigged` → `rig` is a per-occurrence question, not a global
substitution.

**Axis 1 — MCP tool names are `rig_*`.** `packages/cli/src/mcp-server.ts`
registers **18** tools, all named `rig_*`
(`grep -c 'server.tool(' packages/cli/src/mcp-server.ts`), including
`rig_rig_nodes` (`mcp-server.ts:288`), `rig_send` (`:305`),
`rig_capture` (`:339`), `rig_chatroom_send` (`:364`) and `rig_chatroom_watch`
(`:400`). No `rigged_*` name other than the tmux keys below remains in product
source: **0** hits
(`git grep -n 'rigged_' -- ':(glob)packages/*/src/**' | grep -v -c '@rigged_'`).

**Axis 2 — tmux metadata keys are `@rigged_*`, and are correct as-is.** The
tmux metadata keys written at claim/bind time are a separate thing from MCP
tool names and were not renamed. `setRiggedMetadata` in
`packages/daemon/src/domain/claim-service.ts:180`–`184` writes exactly **5**
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
  stripping on read, boundary markers, `readTail`, `readFull`, `grep`.
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
   `session-transport.ts:729`): not found → 404; the same name in more than
   one rig → 409. Pod, rig, global and `--to` list targets go through
   `POST /api/transport/broadcast`, which resolves them with
   `resolveSessions`.
2. Classify send readiness. Only a positive interactive-prompt reading
   (`needs_input`) refuses, with `target_needs_input`
   (`session-transport.ts:1272`), unless the caller passes
   `--dangerously-interact --reason`. A mid-work reading (`running`, from a
   fresh runtime hook or the pane's mid-work patterns,
   `findPatternEvidence(recentLines, MID_WORK_PATTERNS)`, `:225`) or an
   `unknown` one proceeds with an advisory `warning` (`:1321`). `--force` has
   no effect on this path.
3. Two-step tmux send: a unique file/buffer pasted with `paste-buffer -d -r -p`
   at every payload size (`packages/daemon/src/adapters/tmux.ts:604`) →
   ~200ms delay (`session-transport.ts:1378`) → separate named `Enter` (`:1385`).
   Bracketed paste preserves multiline input in supporting TUIs; the payload
   never enters a shell argument. A successful paste proves transport
   execution, not runtime consumption.
4. Optional `--verify`: capture the last 30 pane lines before and after the
   send and count the message's first 40 characters in each. A higher count
   after the send reports `outcome: "delivered"`; otherwise the outcome is
   `rendered-unconfirmed` — text and Enter landed but the capture could not
   re-confirm the render, which is not a failure (`session-transport.ts:472`
   `verify?`; `:1403` `if (opts?.verify)`; `:1415`
   `verified = postCount > preCount`).
5. Honest result with reason on failure.

Architecture rule 18 (`architecture-rules-and-event-system.md`): tmux is
transport, not truth — `send/capture/broadcast` wrap tmux reliably with honest
errors.

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
  `packages/daemon/src/index.ts:283`). With no token configured the
  middleware passes every request through
  (`packages/daemon/src/middleware/auth-bearer-token.ts:99`) — the tailnet is
  the auth boundary by design — except that a daemon bound to an explicit
  address that is neither local nor tailnet falls back to
  `OPENRIG_AUTH_BEARER_TOKEN`
  (`index.ts:289`). The CLI presents the registry bearer from `hosts.yaml`
  when one is configured; for a URL-only anonymous host the `Authorization`
  header is omitted. A remote enforcing a different terminal bearer answers
  401, which surfaces as the structured `permission-gate` step
  (`packages/cli/src/host-registry.ts:53`) — never a hang, never silent.
  Remedy: set the remote terminal bearer equal to the paired registry bearer,
  or rely on the tailnet boundary. **The transcript read is deliberately
  outside this class:** `/api/transcripts/*` mounts with no bearer middleware
  (`packages/daemon/src/server.ts:749`, beside the gated `/api/transport` at
  `:750`), and credential-shaped text is redacted on the `/full` route only
  (`routes/transcripts.ts:292`). So a wrong terminal bearer that
  permission-gates `send --host` does NOT gate `transcript --host` — the read
  keeps succeeding, and the auth-failure class is not uniform across the four
  verbs. The route's own comment (`routes/transcripts.ts:250`) leaves a
  coherent transcript-read auth policy across tail/grep/full for later.
- **The 3-part form is CLI-edge sugar only.** `resolveCrossHostTarget`
  (`packages/cli/src/cross-host-target.ts:58`) strips the suffix only when it
  resolves to a registered host, or equals this host's own id, which routes
  home (`:95`); otherwise the string passes through unchanged with a loud
  host hint. Every session string that reaches any daemon stays
  `member@rig`; the host travels out-of-band. Durable cross-host
  coordination stays the queue's cross-host routing
  (`coordination-primitive.md`); these four verbs add no queue surface.

## 4. Transcript flow

1. `NodeLauncher` starts transcript rotation right after tmux session
   creation, before the harness boots
   (`packages/daemon/src/domain/node-launcher.ts:181`).
2. Each rotation tick runs `tmux capture-pane -p -S -<lines>`
   (`adapters/tmux.ts:1020`) and atomically overwrites (temp file + rename,
   `transcript-rotation.ts:146`)
   `~/.openrig/transcripts/{rig-name}/{session-name}.log`. Defaults: 1000
   trailing lines every 2 s (`transcript-rotation.ts:27`–`28`), tunable with
   `OPENRIG_TRANSCRIPTS_LINES` and `OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS`.
   This bounded capture replaced the earlier `tmux pipe-pane` stream
   (`transcript-rotation.ts:3`), so the file holds a trailing window, not the
   whole session.
3. `TranscriptStore` owns path convention, ANSI stripping on read, boundary
   markers, `readTail`, `readFull`, `grep`.
4. `rig transcript <session> --tail N / --grep "pattern"` provides
   agent-facing access.
5. On restore: a `--- SESSION BOUNDARY: … ---` marker is written before
   re-launch (`restore-orchestrator.ts:1100`); each rotation tick keeps every
   boundary line as a header above the fresh capture
   (`transcript-rotation.ts:122`). (Restore-side detail in
   `lifecycle-snapshot-restore.md`.)
6. `rig ask` gathers rig summary plus transcript excerpts, chat excerpts,
   insufficiency state, and guidance.

Architecture rule 19, as the code implements it: transcripts are a bounded
`capture-pane` snapshot (not pipe-pane), ANSI-stripped on read; `rg`
preferred, `grep -E` fallback. Rule 22: the daemon's `rig ask` is context
engineering — it gathers evidence and does NOT call an external LLM; the
agent IS the LLM. The one exception is the explicit CLI flag `rig ask --wake`
(`packages/cli/src/commands/ask.ts:88`), which runs a headless resume of a
Claude or Codex session (`claude -p --resume` / `codex exec resume`,
`packages/cli/src/ask-wake.ts:58`–`60`) to answer one question.

## 5. Chat flow

1. `rig chatroom send <rig> "message"` → `POST
   /api/rigs/:rigId/chat/send` → `ChatRepository.send()`
   (`routes/chat.ts:35`); the route then emits `chat.message` (`:37`).
2. SSE: `GET /api/rigs/:rigId/chat/watch` delivers real-time messages.
3. History: `GET /api/rigs/:rigId/chat/history` returns channel history in id
   order, 100 messages unless `limit` says otherwise
   (`chat-repository.ts:68`), filterable by `topic`, `after`, `since` and
   `sender`; `POST /api/rigs/:rigId/chat/topic` persists topic markers.
4. UI: a `RigChatPanel` component exists
   (`packages/ui/src/components/RigChatPanel.tsx`), but no UI view mounts it:
   **1** file under `packages/ui/src` names it, its own
   (`git grep -l 'RigChatPanel' -- packages/ui/src | wc -l`).
5. MCP: **`rig_chatroom_send` + `rig_chatroom_watch`** (`mcp-server.ts:364`,
   `:400`).
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
- Note 7 — `--verify` on `rig send` checks the pane for the message by
  comparing snippet counts before and after the send (§3 step 4); when the
  capture cannot re-confirm the render it reports `rendered-unconfirmed`,
  not a failure.

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
- `../cli-reference.md` § Cross-host execution (`--host <id>`) — the per-verb
  transport table, the `agent@rig@host` parse rules, and the structured
  failure modes.
- Source roots: `packages/daemon/src/domain/{session-transport,transcript-store,transcript-rotation,history-query,ask-service,chat-repository}.ts`,
  `packages/daemon/src/routes/{transport,transcripts,ask,chat}.ts`,
  `packages/cli/src/mcp-server.ts`,
  `packages/cli/src/{remote-host-ops,cross-host-target,cross-host-executor,ask-wake}.ts`.
