---
kind: as-built
title: Transport, Transcripts, Chat, Ask
status: active
topics: [coordination, observability]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need to know how rig send/capture/broadcast works, how pipe-pane transcript
  capture and rg/grep search behave, how durable rig chat (SQLite + SSE) is
  modeled, what rig ask gathers, or the exact MCP-tool-name vs tmux-metadata-key
  naming distinction.
siblings: [daemon-core.md, lifecycle-snapshot-restore.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# Transport, Transcripts, Chat, Ask

The communication-and-history layer: tmux is transport, not truth. Send/
capture/broadcast wrap tmux with honest errors; transcripts are raw pipe-pane
captures; chat is daemon-backed SQLite; `rig ask` gathers evidence but never
calls an LLM.

> Verified against source at HEAD `7eaf524c` (`git describe` →
> `v0.3.1-6-g7eaf524c`). Package version **0.3.1** (slice-00 §1.1). Source
> located by `architecture.md` headings (§5 Transport and communication, §6
> Communication/Transcript/Chat flows, §11 Compat notes) per slice-08 §10.1
> — line numbers advisory only.

## 1. The naming axes (D5 — read this first)

This module carries the D5 drift, which has **two independent axes** that
must NOT be conflated or blanket-replaced (banked
`feedback_release_prep_three_layer_depersonalization`: the rename was scoped,
not global). Per-occurrence source verification:

**Axis 1 — MCP tool names: `rig_*` (architecture.md is STALE → corrected).**
slice-00 §1.4 confirms all 17 MCP tools are `rig_*`. The `rigged_*`
references in `architecture.md` are stale text from a rename that predates
v0.2.0:

> Drift-fix D5 (MCP-tool-name axis) — `architecture.md` §5 `node-inventory.ts`
> description says MCP `rigged_rig_nodes`; §6 chat flow says MCP
> `rigged_chatroom_send` + `rigged_chatroom_watch`. Corrected to **`rig_*`**.
> Re-confirmed at source: `mcp-server.ts:288` registers `"rig_rig_nodes"`,
> `:305` `"rig_send"`, `:339` `"rig_capture"`, `:364` `"rig_chatroom_send"`,
> `"rig_chatroom_watch"` (tool #17). Zero `rigged_chatroom_send` /
> `rigged_send` / `rigged_rig_nodes` in non-test product source (grep clean
> @HEAD). slice-00 §1.4; the rename landed in `b183c50c` pre-v0.2.0.

**Axis 2 — tmux metadata keys: `@rigged_*` (architecture.md is CORRECT → do
NOT change).** The tmux metadata keys written at claim/bind time are a
SEPARATE thing from MCP tool names and were NOT renamed:

> Drift-nuance D5 (tmux-metadata-key axis) — `architecture.md` §6 "Whoami
> and adopted-session parity flow" lists `@rigged_node_id`,
> `@rigged_session_name`, `@rigged_rig_id`, `@rigged_rig_name`,
> `@rigged_logical_id`. These are **CORRECT as-is** — verified literally at
> source: `claim-service.ts:77-81` writes exactly these five `@rigged_*`
> keys. Do NOT blanket-sed `rigged` → `rig`; this is a per-occurrence
> verify, not a global substitution. (The metadata-key axis is detailed in
> `agent-spec-and-startup.md` §6.) Re-confirmed `claim-service.ts:77-81`
> @HEAD.

## 2. Transport and communication domain services

(`architecture.md` §5 "Transport and communication")

- `session-transport.ts` — communication primitives: send/capture/broadcast
  with session resolution (canonical + legacy names), mid-work detection,
  honest error reporting, pod/rig/global targeting.
- `transcript-store.ts` — pipe-pane transcript management: ANSI stripping on
  read, boundary markers, readTail, grep. Filesystem-backed, NOT SQLite.
- `history-query.ts` — transcript + chat search. Prefers `rg` when
  available, falls back to `grep -E`, surfaces which backend was used.
  Re-confirmed: `history-query.ts:7` `backend: "rg" | "grep" | "none"`;
  `:103` execs `rg -i --no-filename -e <pattern>`; `:108` returns
  `backend: "rg"`.
- `ask-service.ts` — context-engineering evidence pack: gathers rig summary
  plus transcript excerpts, chat excerpts, insufficiency state, guidance.
  Does NOT call an external LLM.
- `chat-repository.ts` — durable rig-scoped chat: CRUD for `chat_messages`
  table, SSE-compatible event emission.

Routes: `routes/{transport,transcripts,ask,chat,whoami}.ts` — all confirmed
present @HEAD.

## 3. Communication flow

(`architecture.md` §6 "Communication flow")

`rig send <session> "message"` → CLI → `POST /api/transport/send` →
`SessionTransport`:

1. Resolve session name (canonical or legacy; by session/rig/pod/global).
2. Check mid-work state (unless `--force`) — re-confirmed
   `session-transport.ts:136-141` (`findPatternEvidence(recentLines,
   MID_WORK_PATTERNS)`); legacy mid-work check at `:666`.
3. Two-step tmux send: `send-keys -l` → ~200ms delay → `C-m`
   (`session-transport.ts:717` submits `C-m`).
4. Optional `--verify`: capture post-send pane, check message visibility
   (`session-transport.ts:305` `verify?`; `:694` `if (opts?.verify)`).
5. Honest result with reason on failure.

Architecture Rule 18 (carried, `architecture.md` §7): tmux is transport, not
truth — `send/capture/broadcast` wrap tmux reliably with honest errors.

## 4. Transcript flow

(`architecture.md` §6 "Transcript flow")

1. `NodeLauncher` starts `pipe-pane` immediately after tmux session creation
   (before harness boot).
2. Raw terminal output streams to
   `~/.openrig/transcripts/{rig-name}/{session-name}.log`.
3. `TranscriptStore` owns path convention, ANSI stripping on read, boundary
   markers, `readTail`, `grep`.
4. `rig transcript <session> --tail N / --grep "pattern"` provides
   agent-facing access.
5. On restore: a boundary marker is written before re-launch; pipe-pane
   reconnects to the same file (append). (Restore-side detail in
   `lifecycle-snapshot-restore.md` §3.)
6. `rig ask` gathers rig summary plus transcript excerpts, chat excerpts,
   insufficiency state, and guidance.

Architecture Rule 19 (carried): transcripts are raw capture via pipe-pane,
ANSI strip on read; `rg` preferred, `grep -E` fallback. Rule 22: `rig ask`
is context engineering — gathers evidence, does NOT call an external LLM;
the agent IS the LLM.

## 5. Chat flow

(`architecture.md` §6 "Chat flow")

1. `rig chatroom send <rig> "message"` → `POST
   /api/rigs/:rigId/chat/send` → `ChatRepository.addMessage()`.
2. SSE: `GET /api/rigs/:rigId/chat/watch` delivers real-time messages.
3. History: `GET /api/rigs/:rigId/chat/history` returns full channel
   history; `POST /api/rigs/:rigId/chat/topic` persists topic markers.
4. UI: chat-room tab in the rig drawer.
5. MCP: **`rig_chatroom_send` + `rig_chatroom_watch`** (D5 axis-1 correction
   — `architecture.md` §6 said `rigged_*`; source `mcp-server.ts:364` +
   tool #17).
6. Source of truth: daemon-backed SQLite (`chat_messages` table), NOT tmux
   scrollback.

**ChatMessage** type (`architecture.md` §4): durable rig-scoped message —
`id`, `rigId`, `sender`, `kind`, `body`, `topic`, `createdAt`.

## 6. Compatibility notes (carried verbatim, `architecture.md` §11)

The intentional limits in this layer:

- Note 4 — `rig ask` gathers context only; does not call an external LLM.
  The agent reasons about the gathered evidence.
- Note 5 — transcript search prefers `rg` but falls back to `grep -E`;
  search quality/performance varies by backend.
- Note 6 — chat is rig-scoped only: no cross-rig channels or DMs.
- Note 7 — `--verify` on `rig send` checks pane content for message
  visibility but can produce false positives from pre-existing matching
  content. Known limitation.

(The full §11 compatibility-notes list lives in
`architecture-rules-and-event-system.md`.)

## OPEN / carried items

- **D5 (the careful one — resolved per-occurrence, NOT blanket-replaced):**
  Axis 1 (MCP tool names) corrected `rigged_*` → `rig_*` (3 sites: §5
  node-inventory, §6 chat flow ×2). Axis 2 (tmux `@rigged_*` metadata keys)
  verified literally correct at `claim-service.ts:77-81` and left unchanged.
  No slice-00 numeric drift applies to this module's split content.

## See also

- `daemon-core.md` — transport/transcript/chat/ask are among the 49 route
  mounts; MCP tool count (17, `rig_*`) is anchored there.
- `agent-spec-and-startup.md` §6 — the tmux `@rigged_*` metadata-key axis
  detail (whoami/adopt).
- `lifecycle-snapshot-restore.md` §3 — restore-side transcript boundary
  markers.
- Source roots: `packages/daemon/src/domain/{session-transport,
  transcript-store,history-query,ask-service,chat-repository}.ts`,
  `packages/daemon/src/routes/{transport,transcripts,ask,chat}.ts`,
  `packages/cli/src/mcp-server.ts`.
