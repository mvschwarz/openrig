---
kind: as-built
title: Architecture Invariants, Event System, Compatibility Notes
status: active
topics: [runtime-control, observability, doctrine]
domains: [engineering-advisor, operating-advisor, review]
applies-when: |
  Need the cross-cutting architecture invariants the codebase enforces (the
  25 architecture rules + startup/import constraints), the shape of the
  RigEvent union and its SSE delivery surfaces, or the intentional
  compatibility limits that still describe the shipped system.
siblings: [daemon-core.md, coordination-primitive.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# Architecture Invariants, Event System, Compatibility Notes

This module collects the cross-cutting invariants that do not belong to any
single subsystem: the architecture rules the codebase holds itself to, the
event-system shape, and the intentional compatibility limits.

> Verified against source at HEAD `7eaf524c` (`git describe` →
> `v0.3.1-6-g7eaf524c`); package version **0.3.1** across all three packages
> (slice-00 §1.1). HEAD carries 6 commits of unreleased 0.3.2 work; no
> `v0.3.2` tag exists.

## 1. Architecture rules

These are the invariants the codebase is built to preserve (`architecture.md`
§7). Rule 6 (startup layering) and rule 7 (restore-policy narrowing) are the
spec/startup contract — see `agent-spec-and-startup.md` for their flow detail;
they are restated here as system-level invariants.

1. Zero Hono in `domain/` and `adapters/`.
2. Routes depend on the domain; the domain never depends on routes.
3. Shared DB-handle invariants are enforced at construction time.
4. The reboot is engine-first: domain services land before public-surface
   rewiring.
5. Runtime is member-authoritative in the pod-aware model.
6. Startup layering is additive and ordered: agent base → profile → rig
   culture file → rig startup → pod startup → member startup → operator debug
   append.
7. Restore-policy narrowing is one-way only: `resume_if_possible` →
   `relaunch_fresh` → `checkpoint_only`.
8. Base/import collisions warn; ambiguous import/import unqualified refs fail
   loudly.
9. Bundle assembly and startup-file resolution use containment checks rooted
   in the owning artifact.
10. Restore replay uses classification-free projection intent, not stale
    startup-time `no_op` / conflict classifications.
11. Startup status is explicit session state: `pending`, `ready`, `failed`.
12. Session recency depends on monotonic ULIDs: `session-registry.ts` uses
    `monotonicFactory()`; restore selects the newest session by max ULID.
13. Readiness checking is a retry loop with exponential backoff and
    configurable timeout, using adapter-specific probes (Claude TUI
    indicator, Codex ready message, terminal immediate).
14. Resume states are locked: `resumed` / `rebuilt` / `fresh`. `rebuilt` =
    new process assembled from artifacts.
15. Restore honesty: failed resume is FAILED loudly. No automatic fresh
    fallback. Fresh launch is explicit follow-up only.
16. Post-command handoff required on `up`, `down`, `restore`,
    `snapshot create`: what happened + current state + next action.
17. Session naming: `{pod}-{member}@{rig}` — human-authored,
    system-validated. No generation, no slugification.
18. Communication: tmux is transport, not truth. `send/capture/broadcast`
    wrap tmux reliably with honest errors.
19. Transcripts: raw capture via pipe-pane, ANSI strip on read. `rg`
    preferred, `grep -E` fallback.
20. Config precedence: CLI flag > env var > config file
    (`~/.openrig/config.json`, with legacy fallback from
    `~/.rigged/config.json`) > default.
21. Semi-deterministic calibration: build what agents use constantly. Agent
    handles edge cases from error messages.
22. `rig ask` is context engineering: gathers evidence, does NOT call an
    external LLM. The agent IS the LLM.
23. Spec library truth is YAML on disk; daemon owns the structured
    review/index/cache layer.
24. Adopted-session parity is tmux-metadata parity, not fake env-var parity.
25. Human-readable IDs are UI-only presentation helpers. CLI/API/MCP/backend
    keep full canonical ids.

### Startup action constraints

- No shell startup actions.
- Action types are `slash_command` and `send_text` only.
- Non-idempotent actions must not apply on restore.
- Retrying failed startup is handled as restore.

### Remote import constraints

The reboot supports `local:...` and `path:/abs/...` agent refs. Remote
`agent_ref` sources remain unsupported and fail in preflight
(`architecture.md` §7 "Remote import constraints"; restated in compat note 1).

## 2. Event system

The daemon's event surface is the single `RigEvent` discriminated union.

> Drift-fix D8 / OPEN-4 (carried verbatim, slice-00): `architecture.md` §8
> says "PL-004 Phase A adds 9 coordination events" and (in §3) "Existing 32
> PL-004 events" / "Existing 20 PL-004 events" — internally inconsistent
> contested PL-004 sub-counts. **Do NOT carry the 9 / 32 / 20 figures.** The
> `architecture.md` §8 "Currently emitted in production code" / "Present in
> the union but not yet emitted" lists also predate 0.3.x and are stale. The
> union shape below is re-derived from source at HEAD, not migrated.

`RigEvent` is declared at `packages/daemon/src/domain/types.ts:94`
(`export type RigEvent =`) and runs through `types.ts:218`. It has **73
union members** (slice-00 §1.8, re-confirmed at HEAD:
`grep -cE '^\s*\| \{ type:'` over L94–218 = 73). Every one of the 73
declared `type:` literals is also constructed somewhere in
`packages/daemon/src/{domain,routes}` (re-verified at HEAD: the set of
`type: "<x>"` literals in domain+routes exactly equals the 73 union members
— zero union-only-but-never-referenced types).

### Per-prefix event families (grep-verified at HEAD)

Each count below is a fresh, primary-source-grep-verified, explicitly-labeled
per-prefix family count over the union body
(`types.ts:94–218`) — NOT the contested PL-004 sub-count (OPEN-4 ruling:
labeled grep-verified family counts are ground truth; the `9`/`32`/`20`
figures are forbidden).

| Prefix | Members | Sample / role |
|---|---|---|
| `node.*` | 7 | `node.added` (`types.ts:97`) … `node.startup_failed` (`:139`) — lifecycle/startup |
| `workflow.*` | 6 | PL-004 Phase D workflow runtime (detail in `workflow-runtime.md`) |
| `watchdog.*` | 5 | `watchdog.evaluation_fired` (`:187`) … `watchdog.job_stopped` (`:191`) — PL-004 Phase C |
| `rig.*` | 5 | `rig.created` / `rig.deleted` / `rig.imported` / `rig.stopped` / `rig.expanded` (`:151`) |
| `queue.*` | 5 | PL-004 Phase A queue lifecycle (`:156`–`:159`, `:169`; detail in `coordination-primitive.md`) |
| `package.*` | 5 | legacy package/install engine events |
| `mission_control.*` | 5 | PL-005 audit/notification (`:212`–`:218`; detail in `mission-control.md`) |
| `bootstrap.*` | 5 | legacy bootstrap-run events |
| `session.*` | 4 | session discovery / status / detach / vanish |
| `classifier.*` | 4 | PL-004 Phase B classifier-lease lifecycle |
| `restore.*` | 3 | restore start/complete/reconcile (detail in `lifecycle-snapshot-restore.md`) |
| `qitem.*` | 2 | `qitem.fallback_routed` (`:160`), `qitem.closure_overdue` (`:161`) |
| `pod.*` | 2 | `pod.created` (`:135`), `pod.deleted` (`:136`) |
| `inbox.*` | 2 | `inbox.absorbed` (`:162`), `inbox.denied` (`:163`) |
| `continuity.*` | 2 | `continuity.sync` (`:140`), `continuity.degraded` (`:141`) |
| singletons | 11 | one member each: `workflow_spec.*`, `view.*`, `stream.*` (`:155`), `snapshot.*`, `seat.*`, `project.*`, `kernel.*`, `chat.*` (`:149`), `bundle.*`, `binding.*`, `agent.*` |

Family counts sum to 73 (15 multi-member families totalling 62 + 11
singletons), re-confirmed at HEAD.

### Emission and delivery

Events are constructed and emitted via `eventBus.emit({ type: ... })` across
domain services (`stream-store.ts`, `workflow-runtime.ts`,
`restore-orchestrator.ts`, `node-launcher.ts`, etc.) and route handlers. The
event log is append-only and SQLite-backed.

Three SSE delivery surfaces (re-confirmed at HEAD):

- `GET /api/events` — global stream of all events (`server.ts:457`
  `app.route("/api/events", eventsRoute)`).
- `GET /api/stream/watch` — new stream items (`routes/stream.ts:117`).
- `GET /api/queue/watch` — queue/inbox coordination events
  (`routes/queue.ts:357`).
- The chat SSE stream `GET /api/rigs/:rigId/chat/watch` delivers
  `chat.message` for one rig (rig-scoped; see compat note 6).

> OPEN-4 (carried verbatim, slice-00): the precise PL-004-only vs PL-005-only
> sub-partition is NOT asserted here. `architecture.md`'s `32`/`20`/`9`
> figures are internally inconsistent and not reconcilable without
> classifying all 73 members by introducing slice — flagged, not smoothed.
> The grep-verified per-prefix family counts above are the substituted ground
> truth.

## 3. Remaining compatibility notes

Intentional limits that still describe the shipped system (`architecture.md`
§11), verified as still-current at HEAD:

1. Remote `agent_ref` imports remain unsupported (see §1 remote import
   constraints).
2. Startup actions remain intentionally constrained (`slash_command`,
   `send_text`).
3. Legacy compatibility seams still ship for pre-reboot data and v1
   artifacts.
4. `rig ask` gathers context only — does not call an external LLM (rule 22).
5. Transcript search prefers `rg`, falls back to `grep -E`; quality/perf
   varies by backend.
6. Chat is rig-scoped only — no cross-rig channels or DMs.
7. `--verify` on `rig send` checks pane content for message visibility but
   can produce false positives from pre-existing matching content. Known
   limitation.
8. Terminal node readiness is shell-ready only — no service health probes.
9. `rig env down --volumes` exists in the CLI surface, but the explicit
   daemon-side override is not fully plumbed through yet.
10. Managed-app service surfaces are descriptive only — OpenRig does not
    auto-inject service URLs/tokens into agent prompts beyond authored
    startup/context files.
11. Specialist delegation is conventional, not automatic — addressed by
    session name or normal communication surfaces.

## 4. Cross-references

`architecture.md` §12 names itself the architecture-level source of truth and
points at `codemap.md` for file-by-file structure. Under the modular
as-built, that role is distributed: this module owns the invariants + event
shape; the source-of-truth pointer is the rewritten `../codemap.md`
navigation index.

## See also

- `daemon-core.md` — wiring, DB, migrations, startup; footprint drift-fixes.
- `coordination-primitive.md` — PL-004 Phase A queue/stream/inbox/outbox
  events.
- `workflow-runtime.md` — PL-004 Phase D `workflow.*` events.
- `mission-control.md` — PL-005 `mission_control.*` events.
- Source roots: `packages/daemon/src/domain/types.ts` (RigEvent union),
  `packages/daemon/src/routes/{stream,queue}.ts` (SSE watch),
  `packages/daemon/src/server.ts` (`/api/events`).
