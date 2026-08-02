---
name: session-source-fork
description: |
  Use when authoring a rig spec member or `rig expand` payload that needs to start a new managed seat from a prior runtime conversation source — `session_source: { mode: fork, ref: { kind, value } }`. v1 supports `mode: fork` with `ref.kind: native_id` for Claude and Codex. The new seat persists a NEW post-fork token; the parent token is NEVER written onto the new seat. NOT for restoring an existing seat or for artifact-backed mental-model rebuild.
metadata:
  openrig:
    stage: factory-approved
    sibling_skills:
      - claude-compaction-restore
      - mental-model-ha
      - scope-recovery
      - session-compaction-and-restore
      - agent-startup-and-context-ingestion
      - agent-starters
      - composable-priming-packs
      - seat-continuity-and-handover
      - claude-compact-in-place
      - pre-maintenance-agent-preservation
---

# session_source Fork

`session_source` is a **member-level OpenRig field** that declares how a
newly-launched managed seat should derive its initial conversation
continuity from a prior runtime conversation source.

v1 supports one mode: **`fork`** — start a *new* managed seat from a
prior native runtime conversation source without claiming the original
seat continued.

The schema is runtime-neutral; implementation is runtime-specific (Claude
and Codex have their own native fork commands).

## Use this when

- Authoring a rig spec member that should fork from a prior session
- Authoring a `rig expand` payload with `session_source`
- Reasoning about whether to use `fork` vs `rebuild` vs `resume` vs `fresh` for a new seat
- Composing fork + handover (seat-handover-over-fork) — see `seat-continuity-and-handover` skill

## Don't use this when

- The seat is being **restored**, not created. Restore continues an existing managed seat. Fork creates a new seat.
- The continuity is **artifact-backed mental-model rebuild** (packet-derived understanding, not native runtime continuity). Use `mode: rebuild` (see `seat-continuity-and-handover` for the rebuild surface) — do NOT collapse fork into artifact-backed reentry; the distinction is load-bearing.
- The runtime is `terminal`. Terminal runtime rejects `session_source`.

## The shape (canonical YAML)

```yaml
members:
  - id: reviewer-2
    runtime: claude-code        # or "codex"; not valid on terminal
    agent_ref: specs/agents/reviewer.yaml
    profile: reviewer
    cwd: .
    session_source:
      mode: fork
      ref:
        kind: native_id          # v1 fork mode supports native_id only
        value: "0b0165d7-cb4d-4650-90de-15c0a1ede9e6"
```

Rules:
- `mode` v1 only valid value: `fork`.
- `ref.kind` v1 supports `native_id` only. Schema rejects `artifact_path`, `name`, `last`, and `artifact_set` pre-launch with explicit deferred/weaker/wrong-mode error messages (see `packages/daemon/src/domain/rigspec-schema.ts` validateSessionSourceFork). Adapter-level refusal exists as defensive handling but should not be reachable in v1 because schema rejects first.
- `value` required for `ref.kind: native_id` in v1 (the only schema-accepted kind). Future-state value semantics for `artifact_path` / `name` / `last` are not active in v1 because schema rejects those kinds pre-launch.
- `rig expand` accepts the same shape so dynamically-added members can carry session-source attribution.

The primitive does NOT introduce a new top-level command. It flows
through existing rig spec and expansion pathways.

## State model

`session_source` is a **launch-time input**, not a long-lived stateful field:

1. **Declared** — present in member config or expansion payload
2. **Resolved** — at launch time, OpenRig resolves the `ref` against the runtime
3. **Realized** — runtime fork succeeds; new managed seat receives a **NEW** native continuity token (Claude session id or Codex thread id). OpenRig persists that NEW token. **Parent token is NEVER written onto the new seat.**
4. **Failed** — resolution or fork failed; seat not launched as a fork; clear error names the resolution step that failed

Once realized, `session_source` is essentially history. Restoring the
seat later is `restore` of the new seat, not re-fork-from-parent.

## Failure modes (5)

1. **Source session id not found** — runtime cannot resolve `native_id`. **Action**: emit error naming runtime + missing id; do NOT silently launch fresh. (Future-state note: when `artifact_path` is supported in a follow-up slice, it could become a candidate fallback for Claude; in v1 schema rejects `artifact_path` pre-launch so no fallback path exists.)
2. **Source artifact path missing** *(out of v1 scope)* — would apply once `ref.kind: artifact_path` becomes schema-accepted. v1 schema rejects this kind pre-launch.
3. **Unsupported runtime/kind combination** *(largely pre-empted in v1 by schema rejection)* — schema rejects all non-`native_id` kinds upfront. Adapter-level refusal exists as defensive handling but is not reached in v1.
4. **Fork launch failed after source resolution** — runtime command (`claude --resume <parent> --fork-session` or `codex fork <id>`) returned non-zero or hung. Preserve runtime stderr; do not record new seat as launched; do not write parent token onto seat.
5. **Persistence inconsistency** — fork succeeded but seat-token persistence cannot record new continuity token. **Internal failure**: seat is not considered launched until new token is durably written.

## Honest UX rule (verbatim)

The primitive must NOT report "restored the original agent" or "resumed
the original seat" or "snapshot." The correct framing is **"forked from
source session"** / **"started from prior conversation source."**

Negative-grep over adapter source confirms ZERO `restored` / `resumed` /
`snapshot` strings in fork code paths.

## Hard boundaries (do-not list; verbatim)

- **Do NOT introduce a new top-level command** (e.g., `rig fork`). The primitive flows through existing spec/expansion pathways.
- **Do NOT report "restored" / "resumed the original seat" / "snapshot"** in any UX surface.
- **Do NOT couple `session_source` to AgentSpec.** It's a member-level launch-time input.
- **Do NOT change `restore` semantics.** `session_source` creates a seat; `restore` continues an existing managed seat.

## Adapter command shape (shipped v1)

| Runtime | Command shape |
|---|---|
| Claude (`mode: fork` + `ref.kind: native_id`) | `claude --resume <parent-id> --fork-session` |
| Codex (`mode: fork` + `ref.kind: native_id`) | `codex... fork <parent-id>` |
| Terminal | Rejected at schema level |

Mutual exclusion between `resumeToken` (restore path) and `forkSource`
(fork path) is enforced at three layers in the daemon.

## Continuity outcome literals

| Outcome | When |
|---|---|
| `forked` | Fork succeeded; new seat has new native token; parent never written onto new seat |
| `fresh` | Fresh launch (no `session_source` declared) |
| `resumed` | Restore of existing managed seat |
| `failed` | Resolution or fork failed |

For `seat handover over fork` composition, the binding outcome is
independent (see `seat-continuity-and-handover` skill).

## Active-daemon caveat (live-runtime gap)

2026-04-30 live scale-out dogfood found: source checkout contained fork
support, but active daemon was running from a pre-fork commit. **Verify
the active daemon/runtime commit contains the fork path before live
proof.** Isolated daemon proof at the target commit can prove the
feature safely; live forked scale-out remains unproven until the active
daemon parity is verified.

## Currently shipped (v1) vs deferred

Shipped at openrig `c7b6df1` (2026-04-30):
- Schema accept/reject for full Honest Refusal Matrix
- Codec roundtrip (serialize → parse → normalize preserves `session_source` faithfully)
- Expansion path through `rig expand` member-input
- Adapter command shape for Claude + Codex `native_id`
- Persistence honesty (seat's `resume_token` is the NEW post-fork token; parent token NEVER written)
- Honest UX literal contract (`continuityOutcome: forked`)

Deferred:
- Tier 2 real-runtime fork proof (disposable Tart VM cycle, human-gated)
- Claude `artifact_path` mode (schema currently refuses with deferred message)
- Provenance columns (`parent_native_id` / `created_via` for queryable RSI consumer)
- Cross-host fork (source on host A, new seat on host B) — depends on `cross-host-rig-commands`

## See also

- `seat-continuity-and-handover` skill — sibling occupant-creation primitives (resume / fork / rebuild / fresh) + seat-binding (handover composes with fork)
- `agent-starters` skill — composes session_source fork into named reusable starting points
- `cross-host-rig-commands` skill — multi-host fork (deferred)
