# OpenRig — As-Built Architecture
## Final Stretch 1 Snapshot (as of 2026-04-05)

Status:
- Four implementation rounds have landed: AgentSpec reboot (16 tasks), North Star (16 tasks), Post-North-Star (11 tasks + dogfood fixes + UI polish), and Final Stretch 1 (spec library, `whoami`, adopted-session parity, specs/discovery drawer workflows, reusable spec display surfaces, live-node full-details route, graph hover/runtime hints).
- Shipped source footprint: `253` source files across the three packages.
- Daemon footprint: `133` source files total, including `79` domain files, `21` route files, `10` adapters, and `17` migrations.
- CLI footprint: `37` source files.
- UI footprint: `83` source files.
- Current full-suite verification during this refresh:
  - daemon: `112/112` files, `1461/1461` passing
  - CLI: `29/29` files, `275/275` passing
  - UI: `35` files, `361/364` passing (`3` known design/foundation failures)

Packages: `@openrig/daemon`, `@openrig/cli`, `@openrig/ui`

---

## 1. System Overview

OpenRig is a local control plane for multi-agent coding topologies. The system currently has four architectural layers:

1. **AgentSpec / pod-aware core**: spec parsing, resolution, precedence, startup orchestration, snapshot/restore, bundles.
2. **North Star operator layer**: harness auto-launch, node inventory, session naming, infrastructure nodes, explorer UI, existing-rig power-on, auto-snapshot, post-command handoff.
3. **Post-North-Star transport/history layer**: transcript capture (pipe-pane), communication primitives (send/capture/broadcast), config/preflight, `rig ask` context packs, durable rig chat.
4. **Final Stretch 1 authoring/identity layer**: spec review + spec library, `whoami`, adopted-session tmux-metadata parity, bind/materialize/adopt workflows, specs/discovery drawers, reusable spec display components, live-node full-details workspace routes, and graph hover/runtime hints.

Legacy flat-node/package flows remain for backward compatibility.

The stack is:

```text
CLI (31 command groups) / UI (explorer + workspace + drawer) / MCP (17 tools)
      |
      v
Hono daemon routes (21 route groups + dedicated health/export/static handlers)
      |
      +-- dual-format route adapters (legacy v1 + rebooted v0.2)
      +-- transport routes (send/capture/broadcast)
      +-- transcript routes (tail/grep)
      +-- ask routes (context evidence packs)
      +-- chat routes (durable rig messaging + SSE)
      +-- spec review/library routes
      +-- whoami identity route
      |
      v
Framework-free domain services
      |
      +-- SQLite state (17 migrations)
      +-- tmux / cmux / resume adapters
      +-- runtime adapters (Claude Code / Codex / Terminal)
      +-- transport layer (SessionTransport)
      +-- transcript store (pipe-pane backed)
      +-- chat repository (SQLite backed)
      +-- spec review service
      +-- spec library service
      +-- whoami identity service

The core product loop:
  down (auto-snapshot) → up <rig-name> (auto-restore) → handoff → inspect/attach → work → repeat
```

---

## 2. Current Public Surface

### HTTP routes

`createApp()` now mounts 21 route groups plus:
- `GET /healthz`
- `GET /api/rigs/:rigId/spec`
- `GET /api/rigs/:rigId/spec.json`
- static/deep-link catch-all for the built UI

In addition to the reboot-era routes:

**North Star additions:**
- `GET /api/rigs/:rigId/nodes` — canonical shared node-inventory projection
- `GET /api/rigs/:rigId/nodes/:logicalId` — rich node-detail payload for the drawer
- `POST /api/rigs/:rigId/nodes/:logicalId/launch` — manual node launch
- `POST /api/rigs/:rigId/nodes/:logicalId/focus` — cmux focus
- `POST /api/rigs/:id/up` — existing-rig restore by rig ID
- `POST /api/discovery/draft-rig` — generate candidate rig spec from discovered sessions

**Final Stretch 1 additions:**
- `POST /api/rigs/import/materialize` — create pod-aware rig topology without launching
- `POST /api/discovery/:id/bind` — bind discovered session to an existing logical node
- `POST /api/discovery/:id/adopt` — UI-friendly composite adopt route (`bind` or `create_and_bind`)
- `/api/specs/review` — `POST /rig`, `POST /agent` structured review over raw YAML
- `/api/specs/library` — list/get/review/sync filesystem-backed library entries
- `/api/whoami` — daemon-backed runtime identity projection by `nodeId` or `sessionName`

**Post-North-Star additions:**
- `/api/transport` — `POST /send`, `/capture`, `/broadcast` — communication primitives
- `/api/transcripts` — `GET /:session/tail`, `/:session/grep` — transcript access
- `/api/ask` — `POST /` — context evidence pack over rig summary + transcripts + chat
- `/api/rigs/:rigId/chat` — `GET /watch` (SSE stream), `POST /send`, `GET /history`, `POST /topic` — durable rig chat

Important route behaviors:
- `/api/rigs/import`, `/validate`, `/preflight` are dual-format (pod-aware + legacy)
- `/api/rigs/import/materialize` is pod-aware only and returns topology creation without launch
- `/api/up` accepts spec paths, bundle paths, AND rig names (restore-by-name)
- `/api/transport/send` classifies target activity before sending and can refuse unless forced
- `/api/ask` returns context/evidence, not LLM-synthesized answers
- `/api/rigs/:rigId/chat` streams via SSE for real-time delivery
- `/api/specs/library/:id/review` returns structured review plus library provenance (`sourcePath`, `sourceState`)
- `/api/whoami` fails honestly on missing/ambiguous identity instead of fabricating “healthy” state

### CLI commands

`index.ts` currently mounts 31 command groups. Reboot-era commands plus:

**North Star additions:**
- `rig up <rig-name>` — existing-rig restore by name (auto-finds latest snapshot)
- `rig down` — auto-snapshots before teardown, handoff includes restore command
- `rig discover --draft` — generate candidate rig spec from discovered sessions
- Changed: `rig ps --nodes` shows per-node detail with session names, status, startup status

**Final Stretch 1 additions:**
- `rig specs ls/show/preview/add/sync` — agent-facing spec library browse/review workflow
- `rig whoami --json` — daemon-backed runtime identity with peers, edges, transcript helpers, and command hints
- `rig bind <discoveredId> <rigId> <logicalId>` — bind discovered session to an existing node
- `rig adopt <file> --bind logicalId=session` — materialize then bind live sessions into a rig
- Changed: `rig up <source>` and `rig bootstrap <source>` now resolve spec-library names and fail loudly on rig-name vs library-name ambiguity

**Post-North-Star additions (8 new command groups):**
- `rig send <session> "message" [--verify] [--force]` — send to agent terminal
- `rig capture <session> [--lines N] [--json]` — capture agent pane content
- `rig broadcast --rig <name> "message"` — multi-agent broadcast
- `rig transcript <session> --tail N / --grep "pattern" [--json]` — transcript access
- `rig config [get <key> / set <key> <value> / reset <key>] [--json]` — configuration surface
- `rig preflight [--json]` — system readiness check (Node, tmux, writable dirs, port)
- `rig ask <rig> "question" [--json]` — context evidence pack over rig summary + transcripts + chat
- `rig chatroom send/watch/history/topic` — durable group chat

### MCP tools

The CLI-hosted MCP server exposes 17 tools:

1-12. Reboot-era: `rigged_up`, `rigged_down`, `rigged_ps`, `rigged_status`, `rigged_snapshot_create`, `rigged_snapshot_list`, `rigged_restore`, `rigged_discover`, `rigged_claim`, `rigged_bundle_inspect`, `rigged_agent_validate`, `rigged_rig_validate`

13-17. Post-North-Star additions:
- `rigged_rig_nodes` — node inventory for a rig (agents can look up infrastructure sessions)
- `rigged_send` — send message to agent terminal
- `rigged_capture` — capture agent pane content
- `rigged_chatroom_send` — send to rig chat channel
- `rigged_chatroom_watch` — watch rig chat (SSE stream)

### UI architecture

The UI is now explorer-first, with a shared drawer plus center-workspace route model:

- `/` renders `WorkspaceHome` (landing page when no rig selected)
- `AppShell` composes: `Explorer` sidebar + shared drawer selection context + `SharedDetailDrawer` + specs workspace context + activity/system surfaces
- Selecting a rig in the explorer loads its topology graph in the main area
- Clicking a node (in explorer or graph) opens the shared detail drawer
- The shared drawer has five primary surfaces:
  - **Rig drawer:** identity, node summary, snapshots (relocated from standalone panel), Turn On/Off/Export/Snapshot actions, chat room tab
  - **Node drawer:** runtime-first identity, peers, edges, transcript helpers, compact spec summary, status (with restore outcome), startup files, recent events, and `Open Full Details`
  - **Specs drawer:** library list, draft/spec review routing, and spec authoring entry points
  - **Discovery drawer:** placement-first adopt/bind/materialize flow
  - **System drawer:** global event/activity surface replacing the old status-bar role
- Pod selection opens the rig drawer with pod section expanded (no separate pod drawer)
- Human-readable IDs are UI-only: pod labels instead of ULIDs in explorer, short ULID tails for glanceability, full IDs in detail views
- Infrastructure/terminal nodes have distinct visual treatment
- Graph shows pod grouping via React Flow group nodes, status colors (green=ready, amber=launching, red=failed, gray=stopped), and lightweight hover/runtime hints
- Explicit center-workspace routes now exist for:
  - `/specs`
  - `/specs/rig`
  - `/specs/agent`
  - `/specs/library/$entryId`
  - `/rigs/$rigId/nodes/$logicalId`

---

## 3. Database Schema

The daemon now has 17 migrations.

### Core state tables

**rigs**
- Top-level topology container.

**nodes**
- Logical node identity inside a rig.
- Legacy columns remain (`logical_id`, `runtime`, `model`, `cwd`, `restore_policy`, `package_refs`).
- Reboot additions from migration 014:
  - `pod_id`
  - `agent_ref`
  - `profile`
  - `label`
  - `resolved_spec_name`
  - `resolved_spec_version`
  - `resolved_spec_hash`

**edges**
- Logical topology relationships.

**bindings**
- Physical surface attachment: tmux/cmux coordinates.

**sessions**
- Live execution state.
- Reboot additions from migration 014:
  - `startup_status`
  - `startup_completed_at`
- Restore still reads the newest session row, so narrowed restore policy must be propagated to both node and session rows.

**events**
- Append-only event log.

**snapshots**
- Serialized rig state.

**checkpoints**
- Per-node recovery state.
- Reboot additions from migration 014:
  - `pod_id`
  - `continuity_source`
  - `continuity_artifacts_json`

### Legacy package / bootstrap / discovery tables

These remain active:
- `packages`
- `package_installs`
- `install_journal`
- `bootstrap_runs`
- `bootstrap_actions`
- `runtime_verifications`
- `discovered_sessions`

### Reboot-specific tables

**pods** (`014_agentspec_reboot.ts`, extended by `017_pod_namespace.ts`)
- Persisted pod record containing:
  - internal DB `id`
  - authored `namespace`
  - `label`
  - `summary`
  - serialized continuity policy
- Final Stretch 1 made `namespace` first-class so adoption, export, and identity surfaces can use authored pod identity instead of leaking pod ULIDs.

**continuity_state** (`014_agentspec_reboot.ts`)
- Live per-`pod_id` / `node_id` operational continuity state.
- Current statuses:
  - `healthy`
  - `degraded`
  - `restoring`

**node_startup_context** (`015_startup_context.ts`)
- Persisted startup replay context for restore.
- Stores:
  - classification-free projection intent
  - resolved startup files with owner-root provenance
  - startup actions
  - runtime

**chat_messages** (`016_chat_messages.ts`)
- Durable rig-scoped chat messages for group communication.
- Columns: `id`, `rig_id` (FK → rigs, CASCADE), `sender`, `kind` (default 'message'), `body`, `topic`, `created_at`
- Indexed by `(rig_id, created_at)` for fast rig-scoped queries
- Note: transcript persistence is filesystem-backed (pipe-pane → log files), not SQLite. Chat is SQLite-backed.

Migration boundary:
- `014_agentspec_reboot.ts` adds the reboot schema shape.
- `015_startup_context.ts` adds persisted startup replay context.
- `016_chat_messages.ts` adds durable rig chat.
- `017_pod_namespace.ts` backfills/persists authored pod namespace for export, adoption, and identity parity.

---

## 4. Canonical Reboot Types

### Spec and topology

**AgentSpec**
- Parsed from `agent.yaml`.
- Owns imports, defaults, startup, resources, and profiles.

**RigSpec**
- Canonical pod-aware rig topology.
- Uses `version: "0.2"` and `pods[]`.
- Owns cross-pod `edges[]`, rig-level startup overlays, and `cultureFile`.

**RigSpecPod**
- Pod-local bounded context with `members[]`, pod-local `edges[]`, pod startup, and optional continuity policy.

**RigSpecPodMember**
- Member-level runtime and startup surface:
  - `agentRef`
  - `profile`
  - `runtime`
  - `model?`
  - `cwd`
  - `restorePolicy?`
  - member startup overlays

**Pod**
- Persisted DB entity for a pod.

**ContinuityState**
- Persisted live continuity row keyed by `podId + nodeId`.

### Execution and restore

**ResolvedNodeConfig**
- Output of profile resolution.
- Carries effective runtime/model/cwd, narrowed restore policy, selected resources, layered startup block, and resolved spec identity.

**ProjectionPlan**
- Runtime projection plan for a node.
- Carries runtime, cwd, projection entries, startup block, diagnostics, and conflict/no-op classifications.

**RuntimeAdapter**
- Five-method contract:
  - `listInstalled(binding)`
  - `project(plan, binding)`
  - `deliverStartup(files, binding)`
  - `launchHarness(binding, opts: { name, resumeToken? })` — launches harness inside tmux, returns resume token
  - `checkReady(binding)` — retry loop with exponential backoff and timeout (no longer a single poll)

**HarnessLaunchResult**
- Returned by `launchHarness`: `{ ok, resumeToken?, resumeType?, error? }`

**StartupOrchestrator**
- Drives the full startup sequence: mark pending → project resources → deliver pre-launch files → launch harness → wait for ready → deliver interactive files → execute actions → persist context → mark ready.
- Pre-launch vs interactive delivery split: `guidance_merge`/`skill_install` happen before harness boot (filesystem); `send_text` happens after harness is ready (TUI).
- Persists replay context including resume token for future restores.

### Operator-layer types (North Star + Post-North-Star)

**NodeInventoryEntry**
- Universal node projection consumed by CLI/UI/MCP: rigId, rigName, logicalId, canonicalSessionName, podId, nodeKind (agent/infrastructure), runtime, sessionStatus, startupStatus, restoreOutcome, tmuxAttachCommand, resumeCommand, latestError.

**NodeDetailEntry**
- Extended projection for the detail drawer: adds model, agentRef, profile, resolvedSpec identity, binding, cwd, startupFiles, installedResources, recentEvents, infrastructureStartupCommand, plus Final Stretch 1 live-identity fields:
  - `peers`
  - directional `edges`
  - transcript helpers/path
  - compact spec summary for the drawer

**NodeRestoreOutcome**
- `"resumed" | "rebuilt" | "fresh" | "failed" | "n-a"` — the locked restore vocabulary.

**WhoamiResult**
- Daemon-backed identity projection returned by `/api/whoami`.
- Carries:
  - resolution source (`node_id` or `session_name`)
  - runtime identity block (rig, node, logical id, pod/member, session, runtime, cwd, resolved spec)
  - peers
  - directional edges
  - transcript helpers
  - example command hints (`send`, `capture`)

**SourceState**
- Spec review/library provenance enum:
  - `draft`
  - `file_preview`
  - `library_item`
- Shared by spec review, library review, and reusable display surfaces.

**ChatMessage**
- Durable rig-scoped message: id, rigId, sender, kind, body, topic, createdAt.

**SnapshotData**
- Current serialized snapshot payload.
- Reboot extensions are optional for compatibility with older snapshots:
  - `pods?`
  - `continuityStates?`
  - `nodeStartupContext?`

**NodeStartupSnapshot**
- Persisted restore replay input:
  - classification-free projection entries
  - resolved startup files
  - startup actions
  - runtime

**PersistedProjectionEntry**
- The classification-free restore replay seam.
- Persists only entry identity and source metadata, not stale `classification`, `conflicts`, or `noOps`.

---

## 5. Domain Services

All rebooted services live under `packages/daemon/src/domain/`. The rule remains: zero Hono imports in domain code.

### Parsing and validation

- `agent-manifest.ts`: canonical AgentSpec parse/normalize/validate
- `rigspec-schema.ts`: dual-format RigSpec validation
- `rigspec-codec.ts`: dual-format YAML codec
- `startup-validation.ts`: shared startup block validation
- `path-safety.ts`: shared relative-path safety checks
- `spec-validation-service.ts`: pure raw-YAML validation helpers
- `spec-review-service.ts`: daemon-owned structured review model for RigSpec/AgentSpec YAML, including topology preview data and provenance state

### Resolution pipeline

- `agent-resolver.ts`: resolves `agent_ref`, imports, and collision metadata
- `agent-preflight.ts`: single-agent resolution/preflight
- `profile-resolver.ts`: applies defaults, profile uses, resource selection, startup layering, and restore-policy narrowing
- `startup-resolver.ts`: additive startup layering
- `projection-planner.ts`: runtime resource projection planning

### Startup, runtime, and instantiation

- `runtime-adapter.ts`: adapter contract and bridge types
- `startup-orchestrator.ts`: startup projection, delivery, actions, readiness, and replay persistence
- `rigspec-preflight.ts`: dual-stack legacy preflight plus rebooted `rigPreflight(...)`
- `rigspec-instantiator.ts`: dual-stack `RigInstantiator` plus `PodRigInstantiator`
- `rigspec-exporter.ts`: dual-format live rig export back to YAML/JSON
- `pod-repository.ts`: pod CRUD plus live continuity-state CRUD

### Runtime adapters

Three runtime adapters implement the five-method contract: projection, startup delivery, harness launch, readiness, and installed-resource listing.

**ClaudeCodeAdapter**
- projects to `.claude/...`, merges guidance into `CLAUDE.md`
- launches via `claude --name <name>`, resumes via `claude --resume <token>`
- readiness probe: polls pane content for Claude TUI indicators

**CodexRuntimeAdapter**
- projects to `.agents/...`, merges guidance into `AGENTS.md`
- launches via `codex`, resumes via `codex resume <threadId>`
- readiness probe: polls for Codex ready indicator

**TerminalAdapter** (North Star)
- no-op project/deliver/launch (shell IS the harness)
- immediate readiness (shell is ready as soon as tmux session exists)
- for infrastructure nodes: servers, log tails, build watchers

### Node inventory and operator surfaces (North Star)

- `node-inventory.ts`: universal node-level projection. The single source of truth for node state consumed by CLI (`ps --nodes`), UI (explorer + graph + drawer), and MCP (`rigged_rig_nodes`). Core + extended field tiers.
- `demo-rig-selector.ts`: existing-rig power-on helper — finds the right rig by name from ps summary
- `whoami-service.ts`: daemon-backed runtime identity projection used by `rig whoami` and adopted-session parity flows

### Transport and communication (Post-North-Star)

- `session-transport.ts`: communication primitives — send/capture/broadcast with session resolution (canonical + legacy names), mid-work detection, honest error reporting, pod/rig/global targeting
- `transcript-store.ts`: pipe-pane transcript management — ANSI stripping on read, boundary markers, readTail, grep. Filesystem-backed, not SQLite.
- `history-query.ts`: transcript + chat search — prefers `rg` when available, falls back to `grep -E`, surfaces which backend was used
- `ask-service.ts`: context engineering evidence pack — gathers rig summary plus transcript excerpts, chat excerpts, insufficiency state, and guidance. Does NOT call an external LLM.
- `chat-repository.ts`: durable rig-scoped chat — CRUD for chat_messages table, SSE-compatible event emission

### Resume honesty (North Star)

- `native-resume-probe.ts`: honest assessment of whether a harness actually resumed vs fresh-launched — probes pane content for runtime-specific indicators
- `resume-metadata-refresher.ts`: post-launch resume token capture — reads Claude conversation IDs from `.claude/` state, Codex thread IDs from SQLite state files
- `codex-thread-id.ts`: Codex-specific thread ID extraction from the Codex SQLite database

### Discovery extensions (North Star)

- `draft-rig-generator.ts`: synthesize a candidate RigSpec YAML from discovered sessions — groups by CWD, suggests pods, sanitizes IDs
- `claim-service.ts`: adopted-session integration service — claim/bind/create-and-bind flows, tmux metadata writes, and post-claim onboarding hint

### Final Stretch 1 authoring and library surfaces

- `spec-library-service.ts`: filesystem-backed library index over builtin/user roots, classified via structured review
- `spec-review-service.ts`: canonical review model for raw YAML, library entries, and reusable display components
- `whoami-service.ts`: daemon-side identity surface with peers/edges/transcript helpers

### Snapshot, restore, and continuity

- `checkpoint-store.ts`: checkpoint persistence with pod/continuity context
- `snapshot-capture.ts`: captures pods, continuity state, and startup replay context
- `snapshot-repository.ts`: snapshot CRUD
- `restore-orchestrator.ts`: resume, checkpoint delivery, startup replay, live continuity consultation, and topology ordering

### Bundles, bootstrap, and legacy compatibility

- `pod-bundle-assembler.ts`: schema-version-2 bundle assembler
- `bundle-types.ts`: v1 and v2 manifest types plus parse/validate/serialize
- `bundle-source-resolver.ts`: `LegacyBundleSourceResolver` plus `PodBundleSourceResolver`
- `bootstrap-orchestrator.ts`: staged bootstrap flow with direct pod-aware rig and v2 bundle delegation
- `up-command-router.ts`: spec/bundle source classification for `/api/up`

### Legacy systems that still ship

- package install engine (`package-*`, `install-*`, `conflict-detector.ts`, `role-resolver.ts`)
- bootstrap and requirement probe support
- discovery and claim services
- tmux/cmux adapters and resume adapters

---

## 6. Current Execution Flows

### RigSpec import / validate / preflight / export

`routes/rigspec.ts` is the main dual-format seam:

- validate:
  - pod-aware -> `RigSpecSchema.validate`
  - legacy -> `LegacyRigSpecSchema.validate`
- preflight:
  - pod-aware -> `rigPreflight({ rigSpecYaml, rigRoot, fsOps })`
  - legacy -> `RigSpecPreflight.check(spec)`
- import:
  - pod-aware -> `podInstantiator.instantiate(yaml, rigRoot)`
  - legacy -> `RigInstantiator.instantiate(spec)`
- export:
  - pod-aware rigs export canonical `version: "0.2"` RigSpec YAML/JSON
  - legacy rigs export flat-node v1 YAML/JSON

### Bundle create / inspect / install

`routes/bundles.ts` is fully dual-format:

- create:
  - detects pod-aware RigSpec and uses `PodBundleAssembler`
  - accepts optional `rigRoot`
  - legacy create still uses `LegacyBundleAssembler`
- inspect:
  - safely extracts the archive
  - detects `schema_version`
  - v2 returns `schemaVersion: 2`, `agents[]`, and integrity data
  - v1 returns the legacy manifest shape
- install:
  - uses full bootstrap plan/apply
  - bootstrap peeks the manifest and routes deterministically to `pod_bundle` or `rig_bundle`

### `/api/up`

`UpCommandRouter` and `BootstrapOrchestrator` now own:

- direct pod-aware rig specs
- legacy rig specs
- v1 bundle installs
- v2 pod-bundle installs

Plan mode and apply mode both work across those source kinds.

### Snapshot / restore

Restore now:

- reads the newest session by monotonic ULID, not timestamp alone
- consults live `continuity_state`
- preserves state when a node is already `restoring`
- replays restore-safe startup using persisted startup context
- prefilters missing optional artifacts into warnings
- hard-fails a node if a required startup file is missing
- writes transcript boundary markers before re-launch
- uses `nativeResumeProbe` to honestly assess whether harness actually resumed
- restore states: `resumed` / `rebuilt` / `fresh` / `failed`
- failed resume is FAILED loudly — no automatic fresh fallback

### Auto-snapshot + existing-rig power-on (North Star)

- `rig down <rigId>` auto-captures an `auto-pre-down` snapshot before teardown
- `rig up <rig-name>` (no file extension) searches for existing rig by name, restores from latest auto-pre-down snapshot
- If no snapshot: error with guidance ("No saved snapshot for rig 'X'. Boot from a spec or bundle path.")
- Post-command handoff: down output includes snapshot ID + restore command; up output includes node statuses + attach command

### Communication flow (Post-North-Star)

`rig send <session> "message"` → CLI → `POST /api/transport/send` → `SessionTransport`:
1. Resolve session name (canonical or legacy, by session/rig/pod/global)
2. Check mid-work state (unless `--force`)
3. Two-step tmux send: `send-keys -l` → 200ms delay → `C-m`
4. Optional `--verify`: capture post-send pane, check message visibility
5. Honest result with reason on failure

### Transcript flow (Post-North-Star)

1. `NodeLauncher` starts `pipe-pane` immediately after tmux session creation (before harness boot)
2. Raw terminal output streams to `~/.openrig/transcripts/{rig-name}/{session-name}.log`
3. `TranscriptStore` owns path convention, ANSI stripping on read, boundary markers, readTail, grep
4. `rig transcript <session> --tail N / --grep "pattern"` provides agent-facing access
5. On restore: boundary marker written before re-launch. Pipe-pane reconnects to same file (append).
6. `rig ask` gathers rig summary plus transcript excerpts, chat excerpts, insufficiency state, and guidance

### Chat flow (Post-North-Star)

1. `rig chatroom send <rig> "message"` → `POST /api/rigs/:rigId/chat/send` → `ChatRepository.addMessage()`
2. SSE stream: `GET /api/rigs/:rigId/chat/watch` delivers real-time messages
3. History: `GET /api/rigs/:rigId/chat/history` returns full channel history; `POST /api/rigs/:rigId/chat/topic` persists topic markers
4. UI: chat room tab in the rig drawer
5. MCP: `rigged_chatroom_send` + `rigged_chatroom_watch`
6. Source of truth: daemon-backed SQLite (`chat_messages` table), not tmux scrollback

### Config + preflight flow (Post-North-Star)

- `rig config` reads/writes `~/.openrig/config.json` with legacy fallback from `~/.rigged/config.json`. 5 locked keys: `daemon.port`, `daemon.host`, `db.path`, `transcripts.enabled`, `transcripts.path`
- Precedence: CLI flag > env var > config file > default
- `rig preflight` checks: Node.js ≥ 20, tmux available, writable home/db/transcript dirs, port available
- Auto-preflight runs on `rig up` and daemon start
- Every preflight error: what failed + why it matters + what to do (3-part pattern)

### Discovery-to-draft-rig flow (North Star)

`rig discover --draft` → scan tmux sessions → group by CWD → suggest pod structure → generate candidate RigSpec YAML → output to stdout or file

### Spec review and spec library flow (Final Stretch 1)

1. Raw YAML preview:
   - UI/CLI posts YAML to `/api/specs/review/rig` or `/api/specs/review/agent`
   - `SpecReviewService` parses, validates, and returns structured review models
   - UI renders them through `RigSpecDisplay` / `AgentSpecDisplay`
2. Filesystem-backed library:
   - `SpecLibraryService` scans builtin + user roots (`packages/daemon/specs`, `~/.openrig/specs`) with legacy fallback from `~/.rigged/specs`
   - each YAML file is classified via structured review
   - `/api/specs/library` serves list/get/review/sync
3. CLI:
   - `rig specs ls/show/preview/add/sync`
   - `rig up` / `rig bootstrap` resolve library names before falling back to other source kinds

### Whoami and adopted-session parity flow (Final Stretch 1)

1. Managed sessions still prefer projected `OPENRIG_NODE_ID` / `OPENRIG_SESSION_NAME`.
2. Adopted sessions use tmux-owned metadata written at claim/bind time:
   - `@rigged_node_id`
   - `@rigged_session_name`
   - `@rigged_rig_id`
   - `@rigged_rig_name`
   - `@rigged_logical_id`
3. `rig whoami` resolves identity in this order:
   - explicit `--node-id`
   - explicit `--session`
   - env vars
   - tmux metadata
   - raw tmux session-name fallback
4. The daemon owns the truth surface through `/api/whoami`; tmux metadata is an adopted-session anchor, not sovereign truth.

### Materialize / bind / adopt flow (Final Stretch 1)

1. `POST /api/rigs/import/materialize` creates a pod-aware topology without launching sessions.
2. `POST /api/discovery/:id/bind` attaches a discovered live session to an existing logical node.
3. `POST /api/discovery/:id/adopt` is the UI-friendly composite route:
   - bind to existing node
   - or create a new member inside a target pod and bind immediately
4. CLI mirrors those surfaces:
   - `rig bind`
   - `rig adopt`
5. Authored pod namespace is preserved through adoption so logical ids stay `${podNamespace}.${memberName}`.

### Live identity / specs UI flow (Final Stretch 1)

1. Explorer/graph selection opens the shared right drawer.
2. Node drawer stays runtime-first and now includes:
   - live identity
   - peers
   - directional edges
   - transcript helpers
   - compact spec summary
3. `Open Full Details` navigates to `/rigs/$rigId/nodes/$logicalId` in the center workspace.
4. Specs drawer/workspace flows reuse the same `RigSpecDisplay` / `AgentSpecDisplay` primitives for:
   - raw draft preview
   - library review
   - live full-details surfaces
5. Graph nodes carry lightweight hover/runtime hints without replacing drawer-first operation.

---

## 7. Architecture Rules

1. Zero Hono in `domain/` and `adapters/`.
2. Routes depend on the domain; the domain never depends on routes.
3. Shared DB-handle invariants are enforced at construction time.
4. The reboot is engine-first: domain services land before public-surface rewiring.
5. Runtime is member-authoritative in the pod-aware model.
6. Startup layering is additive and ordered:
   1. agent base
   2. profile
   3. rig culture file
   4. rig startup
   5. pod startup
   6. member startup
   7. operator debug append
7. Restore-policy narrowing is one-way only:
   - `resume_if_possible`
   - `relaunch_fresh`
   - `checkpoint_only`
8. Base/import collisions warn; ambiguous import/import unqualified refs fail loudly.
9. Bundle assembly and startup-file resolution use containment checks rooted in the owning artifact.
10. Restore replay uses classification-free projection intent, not stale startup-time `no_op` / conflict classifications.
11. Startup status is explicit session state: `pending`, `ready`, `failed`.
12. Session recency depends on monotonic ULIDs:
    - `session-registry.ts` uses `monotonicFactory()`
    - restore selects the newest session by max ULID
13. Readiness checking is now a retry loop with exponential backoff and configurable timeout, using adapter-specific probes (Claude TUI indicator, Codex ready message, terminal immediate).
14. Resume states are locked: `resumed` / `rebuilt` / `fresh`. `rebuilt` = new process assembled from artifacts.
15. Restore honesty: failed resume is FAILED loudly. No automatic fresh fallback. Fresh launch is explicit follow-up only.
16. Post-command handoff required on `up`, `down`, `restore`, `snapshot create`: what happened + current state + next action.
17. Session naming: `{pod}-{member}@{rig}` — human-authored, system-validated. No generation, no slugification.
18. Communication: tmux is transport, not truth. `send/capture/broadcast` wrap tmux reliably with honest errors.
19. Transcripts: raw capture via pipe-pane, ANSI strip on read. `rg` preferred, `grep -E` fallback.
20. Config precedence: CLI flag > env var > config file (`~/.openrig/config.json`, with legacy fallback from `~/.rigged/config.json`) > default.
21. Semi-deterministic calibration: build what agents use constantly. Agent handles edge cases from error messages.
22. `rig ask` is context engineering: gathers evidence, does NOT call an external LLM. The agent IS the LLM.
23. Spec library truth is YAML on disk; daemon owns the structured review/index/cache layer.
24. Adopted-session parity is tmux-metadata parity, not fake env-var parity.
25. Human-readable IDs are UI-only presentation helpers. CLI/API/MCP/backend keep full canonical ids.

### Current startup action constraints

- no shell startup actions
- action types are `slash_command` and `send_text` only
- non-idempotent actions must not apply on restore
- retrying failed startup is handled as restore

### Remote import constraints

The reboot currently supports:
- `local:...`
- `path:/abs/...`

Remote `agent_ref` sources remain unsupported and fail in preflight.

---

## 8. Event System

The `RigEvent` union includes reboot-era and post-North-Star signals.

Currently emitted in production code:
- `node.startup_pending`, `node.startup_ready`, `node.startup_failed` (startup orchestrator)
- `chat.message` (chat routes — powers SSE stream for rig chat)

Present in the union but not yet emitted by production code:
- `pod.created`, `pod.deleted`
- `continuity.sync`, `continuity.degraded`

The event log remains append-only and SQLite-backed. The global SSE stream (`/api/events`) delivers all events; the chat SSE stream (`/api/rigs/:rigId/chat/watch`) delivers chat messages for one rig.

---

## 9. Startup Sequence (`createDaemon`)

`createDaemon()` now does the following:

1. Open SQLite and run all 17 migrations.
2. Construct core repositories and legacy services.
3. Construct package/bootstrap/discovery services.
4. Construct rebooted startup/runtime services:
   - `StartupOrchestrator`
   - `ClaudeCodeAdapter`, `CodexRuntimeAdapter`, `TerminalAdapter`
   - `PodRigInstantiator`
   - `PodBundleSourceResolver`
5. Construct North Star + Post-North-Star services:
   - `TranscriptStore` (with config from env for transcript path/enabled)
   - `SessionTransport`
   - `ChatRepository`
   - `AskService` (with `HistoryQuery`)
    - `ResumeMetadataRefresher`
    - `NodeInventory`
6. Construct Final Stretch 1 services:
   - `SpecReviewService`
   - `SpecLibraryService` (builtin + user roots)
   - `WhoamiService`
7. Construct `BootstrapOrchestrator` with both legacy and rebooted seams.
8. Build `AppDeps`, enforce shared-DB invariants in `createApp()`, and mount the full route tree including specs review/library and `whoami`.

---

## 10. Test And Verification State

### Test footprint

- daemon: 112 Vitest files / 1,461 tests
- CLI: 29 Vitest files / 275 tests
- UI: 35 Vitest files / 364 tests
- total: 176 files / 2,100 tests

### Verified during this doc refresh

- daemon: `1461/1461` passing
- CLI: `275/275` passing
- UI: `361/364` passing

Current known UI failures during this refresh:
- `design-compliance.test.tsx`
  - non-zero border-radius count still above zero
  - stale `StatusBar.tsx` file assumption in the mono/data-display assertion
- `tailwind-foundation.test.tsx`
  - missing `.bg-card` assertion in generated CSS

### Post-North-Star test suites

In addition to reboot-era coverage:

- `session-transport.test.ts` — send/capture/broadcast with session resolution and mid-work detection
- `transcript-store.test.ts` — ANSI stripping, boundary markers, readTail, grep, path traversal
- `transcript-routes.test.ts` — transcript API contracts
- `transport-routes.test.ts` — communication route contracts
- `config.test.ts` — all 5 config keys, precedence, env override, JSON output
- `preflight.test.ts` — Node version, tmux, writable dirs, port availability
- `send.test.ts`, `capture.test.ts`, `broadcast.test.ts` — CLI communication commands
- `transcript.test.ts` — CLI transcript access
- `ask.test.ts` — CLI ask command (context evidence pack)
- `node-launcher.test.ts` — pipe-pane integration tests
- `restore-orchestrator.test.ts` — honest resume/rebuilt/fresh/failed restore paths
- CLI tests for config, preflight, send, capture, broadcast, transcript, ask, chatroom
- UI tests for explorer, shared drawer, rig detail, node detail, chat panel
- `spec-review-service.test.ts`, `spec-review-routes.test.ts` — structured spec review
- `spec-library-service.test.ts`, `spec-library-routes.test.ts`, `spec-library-starters.test.ts` — filesystem-backed library and builtin starter specs
- `whoami-service.test.ts`, `whoami-routes.test.ts`, `whoami.test.ts` — daemon + CLI identity projection
- `adopt.test.ts` — CLI materialize/bind adoption flow
- UI tests for spec review displays, spec library review, specs panel, live node details, and adopted-session node identity

### Dogfood status

Post-North-Star + Final Stretch 1 dogfood verified:

- Full product loop: `rig up demo/rig.yaml` → harnesses launch → `rig ps --nodes` → `rig down` → `rig up demo-rig` (restore by name) → agents resume
- Communication: `rig send`, `rig capture`, `rig broadcast` across running rig
- Transcripts: `rig transcript <session> --tail / --grep` against live pipe-pane output
- Config/preflight: `rig config`, `rig preflight` with honest errors
- Chat: `rig chatroom send/watch/history/topic`
- Ask: `rig ask <rig> "question"` returns context evidence
- UI: explorer tree → graph → node detail drawer → `Open Full Details` → specs/library review surfaces
- Identity: `rig whoami --json` inside managed and adopted sessions
- Authoring/library: `rig specs ls/show/preview/add/sync`
- Adoption: materialize + bind/adopt flows from discovery/specs workflows
- MCP: all 17 tools verified

---

## 11. Remaining Compatibility Notes

These are the main intentional limits that still describe the shipped system:

1. Remote `agent_ref` imports remain unsupported.
2. Startup actions remain intentionally constrained (`slash_command`, `send_text`).
3. Legacy compatibility seams still ship for pre-reboot data and v1 artifacts.
4. `rig ask` gathers context only — does not call an external LLM. The agent reasons about the gathered evidence.
5. Transcript search prefers `rg` but falls back to `grep -E`. Search quality/performance varies by backend.
6. Chat is rig-scoped only — no cross-rig channels or DMs.
7. `--verify` on `rig send` checks pane content for message visibility but can produce false positives from pre-existing matching content. Known limitation.
8. Terminal node readiness is shell-ready only — no service health probes.

---

## 12. Cross-References

This document is the architecture-level source of truth.

For file-by-file structure across daemon, CLI, and UI, use:
- [codemap.md](/Users/mschwarz/code/rigged/docs/as-built/codemap.md)
