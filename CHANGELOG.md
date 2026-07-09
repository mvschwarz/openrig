# OpenRig Changelog

Agent-readable release notes for coding agents and human operators installing,
upgrading, or operating OpenRig.

Versioning: pre-1.0 minor releases may include contract additions,
deprecations, and behavioral changes. Breaking changes are called out explicitly.

---

## [0.4.6] - 2026-07-09

**Status**: shipped; workflows + multi-host coordination + factory foundations theme. 0.4.5 was skipped (no cut).

### Summary For Installing Agents

- **Package version**: bumps from `0.4.4`. 0.4.5 was skipped.
- **Migrations**: additive only — `049_workflow_instance_version`, `050_workflow_spec_json`, `051_workflow_resume`, `052_workflow_instance_bound_rig`, `053_sessions_node_id_index`, `054_queue_transitions_archive`. Existing v0.4.4 databases upgrade by running `rig daemon start` on the new daemon.
- **Node engines**: unchanged.
- **New bundled skills**: `openrig-herdr` and `openrig-cmux` ship in canonical shared source + bundled openrig-core plugin, byte-parity guarded.

### Headline

**Workflows + multi-host coordination + factory foundations.** OpenRig gains a rock-solid deterministic workflow engine — spec language, CLI, web UI, exception + human-gate model — plus the self-driving factory starter that runs on top of it. Multi-host coordination lands the full happy path: hosts register + select, remote workspaces read, cross-host queue routing, cross-host direct coordination verbs (`rig send` / `rig capture` / `rig transcript` / `rig broadcast`), and a fleet-attention rollup. Terminal provider first-class treatment and daemon read-path hardening ride alongside; a new Pi agent runtime adapter joins Claude and Codex as a first-class runtime.

### The rock-solid deterministic workflow engine

- **Migrations**: additive only — 049 `workflow_instances.version` (optimistic concurrency, default 0), 050 `workflow_specs.spec_json` (full parsed spec at cache time; legacy rows self-heal on next read-through and degrade with a visible advisory until then).
- **Behavioral**: `loop_guards.max_hops` is now ENFORCED at projection (exceeding converts the handoff to an honest structured failure — instances that silently looped will now fail loud at the guard); workflow spec validation is STRICT (unknown keys reject at parse; unreachable steps and unguarded cycles fail validation — declare `loop_guards.max_hops` to sanction a loop); waiting-exit replays are absorbed (exact duplicates return the stored outcome with zero writes); `rig workflow continue` is relabeled to its real read-only inspector semantics (the wire was always read-only; the label lied).
- **New**: per-instance workflow-keepalive watchdog jobs auto-arm in the routing transaction and disarm at terminal (deadline-gated: quiet while healthy, stuck-steering nudge when a step is overdue — 4h threshold on the routine-tier SLA); a startup sweep re-arms keepalives, reissues nudges lost to the commit-then-crash window, and surfaces stuck instances.
- **Advisories (fail-open)**: declared-but-unenforced spec keys (`invariants.*` except `allowed_exits`, `closure.*`, `gates[]`, `skill_refs`, `next_hop.mode: prefer`, `spawn_budget`) warn `declared_not_enforced_v1` at validation; exit code unchanged.

### The full-featured workflow spec language

- **The workflow spec DSL** the engine parses ships full-featured: step definitions with `role`/`target.rig`/`preferred_targets`, `next_hop.on` branch semantics, `invariants.allowed_exits`, `loop_guards.max_hops`, `exception_routing`, `closure.*`, `gates[]`, `skill_refs`, `spawn_budget`. Strict-keyset validation at parse (unknown keys reject; unreachable steps + unguarded cycles fail); shipped-spec compat pinned by fixture round-trip. Composes with the workflow-to-rig binding + the exception model.

### The workflow CLI

- **Migrations**: none.
- **New verbs**: `rig workflow run <spec>` (instantiate + follow live to a terminal state; exit 0 = completed, exit 3 = workflow failed — distinct from transport 1/2, so `run && next-thing` is honest) · `rig workflow watch <instance>` (read-only mid-flight attach; snapshot-first so fast early steps still render exactly once; drops reconnect then degrade to an announced poll fallback) · `rig workflow status` (the needs-attention rollup: counts + one row per failed/stuck/waiting instance with combined reasons and the next action; proven-empty on a clean fleet) · `rig workflow route <instance> --to <session>` (re-target the current frontier step: honest handed_off_to closure + successor recreate + frontier rebind in one transaction; the step does NOT advance; the old owner's stale project is structurally rejected with `packet_not_on_frontier`).
- **Behavioral**: `trace`/`list`/`show` human output is now formatted (per-step tree, columns, status glyphs, ATTN markers) — `--json` payloads are byte-identical to before; named daemon rejections render as what/why/fix in human mode (`--json` keeps the raw body).
- **Guard**: out-of-band TERMINAL closure of a live workflow-frontier packet (raw `rig queue update`, Mission Control route/handoff) now rejects with `workflow_frontier_packet` (HTTP 400) naming the correct workflow verbs. Non-workflow queue items are unaffected. The predicate is injected at startup (the queue layer does not import the workflow domain).
- **Events**: `workflow.routing_table_changed` extended additively with `{instanceId, stepId, from, to}` on route emissions; existing `{rigName, cause}` consumers unaffected.

### The workflow web UI

- **New pages + components**: `WorkflowsPage` (workflow catalog + instantiate flow), `WorkflowInstancePage` (per-instance detail + trail), `WorkflowInstancesBand` (in-band rollup surface), `WorkflowTopologyGraph` (visual topology renderer), `InstanceTrailTimeline` (packet + step trail).
- **New hooks**: `useWorkflow`, `useWorkflowSse` (workflow SSE stream, unscoped by rig — never `?rigId=`); workflow events cross-rig aggregate.
- **Behavioral**: workflow layout math is extracted as pure exports (`buildLauncherViews` / `suggestLayout`) for unit tests; permutation-invariant edge-handle assignment (`computeStepDepths` / `assignEdgeHandles`); post-merge borderRadius design-compliance fix landed. Twin fixture backfill for these routes is routed as a non-blocking 0.4.7 hygiene fast-follow; UI acceptance is carried by per-cut real screenshots + the two-host integration proof.

### The exception + human-gate model

- **Migrations**: `051_workflow_resume` — two additive columns on `workflow_instances` (`resume_count`, `hops_baseline`, both NOT NULL DEFAULT 0; no backfill; behavior byte-identical until the first resume).
- **New verb**: `rig workflow resume <instance> [--decision <text>]` — redrive a FAILED instance from its failed step: back to active, rebound, fresh packet to the step's RE-RESOLVED owner (a replaced dead seat receives the redrive — the recorded stale destination is never copied); completed steps never re-run; one fresh `max_hops` window per resume (`hops_baseline`); the resolved exception occurrence closes; a repeat failure raises a NEW occurrence-distinct item.
- **Exceptions are durable attention items now**: an unmapped `failed` close creates the item IN THE SAME transaction as the failure (no item-less failed window); stuck/overdue instances get their item at sweep/keepalive detection, occurrence-deduped. Items carry plain-language summary, a trace evidence pointer, the resume affordance, and structured tags (`workflow:`/`instance:`/`step:`/`exception:`/`occurrence:`) for query-side joins.
- **The maturity dial**: exception routing is configurable per class / per workflow (`exception_routing:` in the spec — strict-keyset validated) and per host (`rig config set workflow.exception_routing orchestrator|human_only`). Default = ORCHESTRATOR-FIRST: the item routes to the workflow's declared `orchestrator_role` target while the human band shows an AWARENESS row (holder + age — visibility, not a to-do). `human_only` classes/workflows route `human@host` first and gate there. No resolvable target = `human@host`, never lost. Orchestrator-routed items carry an ordinary tier — they never leak into the human attention legs; the shipped attention predicate is unchanged.
- **The attention band is workflow-aware**: failed/stuck instances with no item render a backstop row naming the missing-item anomaly; a frontier referencing a closed packet renders an anomaly row (the detection twin of the CLI close-path guard); healthy fleets render zero workflow rows.
- **Happy-path guarantee unchanged**: a healthy run creates zero exception items of any routing and involves no orchestrator — pinned by test and proof.
- **Events**: additive `workflow.resumed` (`{instanceId, workflowName, stepId, resumedBy, decision, resumeCount}`).

### Add / select hosts — host registry + dashboard

- **Host registry verbs** (shipped at 0.4.4) gain the dashboard-side complement: `HostConfigCard` surfaces each registered host's declared transport, health, and identity; `HostIndicator` shows the current selection at the operator field of view. New hooks: `useHosts`, `useFleet` (registry read + fleet-wide rollup).
- **`rig host select` persists a sticky selection** consumed by the observe/interactive verbs (see cross-host coordination verbs, below); durable writes never follow the selection (deliberate asymmetry — see cross-host queue routing, below).

### View remote workspace

- **A remote host's workspace surfaces are readable from a local operator** — the workspace observability tabs shipped at 0.4.1 gain `--host <id>` scope; the registry + bearer path fans out per-host reads. Read-only for this pass; cross-host writes are the queue-routing and coordination-verb sections below.

### Cross-host queue routing

- **A queue item can now be sent — and a hot-potato handed off — to a destination on ANOTHER host.** `rig queue create/handoff/handoff-and-complete` gain `--host <id>` and the host-qualified destination form `member@rig@<host>` (both resolve to the same out-of-band `hostId` envelope; the session string stays `member@rig`). The local daemon forwards the write to the target host's daemon over the host registry + bearer (the shipped mission-control forward-then-strip WRITE, generalized); **the qitem lives in the target host's DB** and that host's own nudge wakes the destination agent on ITS tmux.
- **Explicit-only routing**: queue verbs never follow the persisted `rig host select` selection — a durable write does not silently re-home on a sticky selection (deliberate asymmetry with the observe/interactive verbs).
- **At-least-once + idempotent, never exactly-once**: the forwarding daemon mints the qitem id before the first forward; a cross-host handoff's successor id is derived deterministically (`qitem-xh-…`) from (source, destination, host) so retries absorb on the target's primary key. Cross-host handoffs create the successor FIRST and close the local source SECOND (never-drop); the source close records the opaque three-part `closure_target=member@rig@<host>` (audit metadata, never parsed) and the successor carries the continued `chain_of_record` (opaque lineage ids on the target). Re-drives absorb on a matching `closure_target`; a mismatch is a structured `cross_host_close_conflict` (409).
- **Failure honesty**: unknown / ssh-declared / unreachable / auth-failed hosts each surface a distinct structured `remote_queue_write_failed` error naming the host; nothing is written on either side. Transport is http-only (daemon→daemon); the `rig send --host` ssh shell-out is untouched.
- **No migrations. Local (no-host) queue behavior is byte-identical.** Claim/update/inbox stay local-by-principle; sender-side ops on a forwarded item are a named follow-up.

### Cross-host agent coordination

- **The direct coordination verbs now cross hosts — send, observe, coordinate JUST WORK.** `rig send` and `rig capture` gain an **http transport branch**: an http-registered host (the kind the shipped `rig host pair` front door creates) is reached CLI-DIRECT via the shipped `runRemoteHttpOp` against the remote daemon's EXISTING `/api/transport/send|capture` routes — **zero daemon-side changes**; the ssh path stays byte-verbatim for ssh-registered hosts (the host entry's declared transport dictates the path; never a fallback). `rig transcript` and `rig broadcast` gain their FIRST cross-host affordance the same way (`--host <id>`, http-only): transcript reads the remote daemon's tail/grep routes with origin output verbatim; broadcast posts to the remote daemon's own fan-out engine, printing its per-target results verbatim (a partial fan-out exits non-zero, exactly as local) under its own named 30s deadline.
- **The `agent@rig@host` target form is CLI-edge sugar, uniform on the session-target verbs** (send/capture/transcript): the suffix is host-qualified IFF it matches a REGISTERED host id, else the target passes through unchanged with a loud host hint on failure (adopted/raw names containing `@` keep working — deliberately different from the queue verbs' always-strip rule; both documented side-by-side in cli-reference). Precedence: explicit `--host` > target sugar > the persisted host selection; a `--host`-vs-sugar conflict is a structured error. Broadcast's positional is message text (never parsed as a target), so it takes `--host`/selection only. Every session string that reaches any daemon stays `member@rig`.
- **Failure honesty per branch:** the http branch names its own steps (unknown-host / permission-gate / remote-daemon-unreachable / remote-command-failed, with the remote route's own error text surfaced); the ssh branch keeps its shipped taxonomy. `send --verify` over http prints the REMOTE route's verdict verbatim — never a locally synthesized "Verified: yes". Named terminal-bearer posture: default/tailnet = pass-through; a remote enforcing a different terminal bearer surfaces as the structured permission-gate step (remedy documented; no new auth machinery).
- **No migrations. No daemon changes. Local (no-host, no-selection) behavior of all four verbs is byte-identical.** Durable cross-host coordination remains the queue; the coordination verbs add no queue surface.

### Fleet-attention altitude

- **A fleet-altitude attention surface** — the attention band gains a fleet-wide altitude rollup (`FleetBand` + `FleetPage`): aggregates attention counts across every registered host, per-host status, drill-down to the per-host attention list. Composes with the host registry + the remote-workspace read. New hooks: `useFleet`, `useReviewAgents`.

### The workflow-to-rig binding layer

- **Migrations**: `052_workflow_instance_bound_rig` — one additive nullable column on `workflow_instances` (`bound_rig` TEXT; NULL = unbound = byte-identical prior behavior; no backfill).
- **Point a workflow at a rig at INSTANTIATION**: `rig workflow instantiate|run … --rig <name>` overrides the spec's `target.rig` DEFAULT; the binding persists on the instance (`boundRig` in `--json`, rendered by `show`/`trace`). Unknown-rig validation splits by provenance: an explicit `--rig <unknown>` is a hard `bound_rig_unknown` naming the registered rigs; an unknown spec-default `target.rig` DEGRADES to unbound with a loud instantiate advisory (surfaced in `--json` `advisories` + on stderr) — shipped/example specs that carry a descriptive `target.rig` and route via `preferred_targets` (e.g. `conveyor`) instantiate byte-identically to prior behavior (zero-regression).
- **Roles resolve to SEATS by capability**: pod members may declare `role: <name>` (rig.yaml, `rig expand` fragments, `rig add` fragments — opt-in per seat; charset-validated; rejected on terminal members; round-trips through export). On a bound instance, a workflow role with **no `preferred_targets`** resolves at step-close to a live capable seat on that rig: running agents declaring the role, managed seats only (adopted seats excluded loudly with `adopted_seat_not_role_resolvable_v1`), harness-pin-aware runtime match, least pending backlog, deterministic coordinate tiebreak. Declared `preferred_targets` stay the explicit override tier, byte-identical and never liveness-filtered; every previously-shipped spec behaves identically.
- **Resolve-once, record-in-the-packet**: resolution happens once inside the close+create transaction and records as the packet destination; replays consume the record (zero inventory reads); `rig workflow resume` re-resolves by design and is now capability-aware. Roles bind to the stable seat coordinate `{pod}-{member}@{rig}` — an agent handover behind the seat never strands the workflow.
- **Honest failures**: no live capable seat = structured `next_owner_unresolved` with per-candidate disqualifiers + fix line; zero-declaring rigs get a named message; instantiate hard-fails only on STRUCTURAL zero-role coverage (`bound_rig_role_uncovered`) — a declared-but-not-yet-running seat is fine (factory rigs warm up). Never a spawn, never auto-`add_member`, never a dead-seat route.
- **Exception routing rides the binding**: the exception model's orchestrator-role position resolves capability-aware on the bound rig (never-lost human@host fallback unchanged).
- **Scale-out = add a member under a role** (`rig add` fragments carry `role`); auto-scale-out is explicitly NOT built.

### The self-driving factory starter (`factory-rsi`)

- **New shipped starter: `rig up factory-rsi`** — the single-rig recursive-self-improvement factory MVP. One rig, seven seats (`plan-planner`, `build-implementer`, `check-qa`, `review-reviewer`, `dogfood-tester`, `release-manager`, `orch-lead`), running the new `factory-rsi` workflow. A launch-tier product starter (a `product-team` sibling), workspace-agnostic — point `--cwd <repo>` at whatever the loop should improve.
- **New builtin workflow: `factory-rsi`** — the inner loop `plan → implement → qa_check → review → release`, with `qa_check`/`review` `failed` → `implement` (bounded remediation), engine-routed — never an orchestrator relay. Dogfood is **decoupled** from this gated loop: the dogfood seat runs out-of-band against the **shipped** product and feeds its findings into the next plan (the RSI edge, ungated — no loop-stop in the MVP; the continuous out-of-band runtime mechanism is refined in a later release). The remediation loops are sanctioned only by the enforceable `loop_guards.max_hops`; a trip is an exception routed orchestrator-first (`exception_routing`), and `rig workflow resume` grants one more bounded window.
- **Recorded-state cycles**: the next plan's input is the *recorded* dogfood findings (`evidence_ref` / the packet trail), never a seat's chat memory — the RSI feedback is durable recorded state.
- **Publish stays a human act**: the release leg is two steps — `release_prep` (the release-manager PREPARES notes/docs/PR and records the evidence; un-gated, runs first) hands off to `release_signoff`, which holds the ship decision at a human gate (`gate.target: human@kernel`). Prepared artifacts exist before sign-off; no seat pushes, tags, publishes, or upgrades a host.
- **Rides the merged engine, no new machinery**: runs on the workflow engine + spec language + exception model as shipped, with the v0 hardcode seam (`target.rig: factory-rsi` + `preferred_targets` pin each role 1:1 to a seat) — no binding-layer dependency, no engine change. Runtime config: seats inherit their runtime's default model (no per-seat pin); plan/build/release/orch run on claude-code, and qa/review/dogfood run on codex for cross-runtime diversity against the builder.
- **No migrations. No breaking changes.**

### The member-exists instantiate advisory + cross-rig wrapping workflow

- **Mis-routed workflow destinations are caught loudly at instantiate, never silently orphaned.** A declared `preferred_target` that names a rig registered on this daemon but a MEMBER that does not exist (a typo or a stale seat name) now surfaces **ONE loud, aggregated advisory** on the shipped instantiate `advisories` list — naming the destination, every declaring step/role pair, the consequence (the work will not be claimed; it will surface as a stuck exception), and the fix hint (`rig ps` / add the member). Rendered exactly where advisories already render: the route body + CLI stderr. **No new surface, no new flag** — the shipped `target.rig`-degrade list simply gains a second producer.
- **ADVISORY, never a deny**: instantiate always proceeds; the queue transport gate stays rig-exists-only (unchanged). Scope guards: human-seat refs are classified before parse and skipped; raw/adopted (non-canonical) destinations are skipped (legitimate — the inventory cannot vouch for them); an unregistered rig keeps its existing loud transport rejection (no double advisory). Existence is structural — any lifecycle state, any member kind (a declared-but-not-launched seat or an explicitly named terminal member is a legitimate destination; liveness stays a projection-time concern).
- **Cross-rig wrapping workflow**: workflows declared on one rig may `preferred_target` a seat on another registered rig; the routing packet travels via the cross-host queue routing path (host-qualified destination form) and lands in the target host's DB. Local-rig-only workflows are byte-identical.
- **No migrations. No CLI changes. No breaking changes.** Advisory-free specs instantiate byte-identically.

### Pi agent runtime adapter

- **New runtime adapter: Pi** — an agent runtime beyond Claude/Codex, joining the shipped runtime dial as a first-class option in rig specs (`runtime: pi`) and pod member declarations. The adapter honors the standard runtime contract (identity via `rig whoami`, startup guidance, hooks, transcript path). Pi runtime seats participate in all workflow / role / queue / send / capture surfaces exactly like Claude/Codex seats.

### Terminal provider first-class treatment

- **The terminal provider dial gets first-class treatment across the terminal-facing surfaces** — the terminal launcher (`TerminalLauncher`), send/capture/broadcast surfaces, and the new `openrig-cmux` skill's `--provider cmux` seam honor a declared terminal provider per member with best-effort fallback. Existing seats using cmux keep their behavior byte-identical; declared-provider seats now route deterministically.

### Daemon read-path hardening

- **The daemon's read-path is hardened for the multi-host + workflow load** — SSE stream backpressure guards, projection caches, and additive indices for read-side query performance. **No functional behavior change** — reads that returned correct results before return the same results now, faster.
- **Migrations**: `053_sessions_node_id_index` (additive index) + `054_queue_transitions_archive` (archive table for read-side query performance). Additive only.

### New bundled skills (canonical + plugin, byte-parity guard)

- **`openrig-herdr`** — the full rig terminal open/views/status model: verbs, view grammar (`rig | pod:<rig>/<pod> | mission:<id> | slice:<id> | saved`), honest-partial/degrade reading, read-only policy (rig/pod interactive, mission/slice read-only-by-construction, saved per-member), scroll/copy + never-retroactive-flip honesty, same-size-only duplicate limit, terminal-views.yaml schema. AGPL clean-room rail — no herdr source text vendored. Ships in `skills/_canonical/core/openrig-herdr/` + `packages/daemon/assets/plugins/openrig-core/skills/openrig-herdr/`.
- **`openrig-cmux`** — the provider-agnostic vs cmux-specific delta (`--provider cmux`) with shipped-integration open-or-focus rule, patterns only (no arm's-length constraint pointing at openrig-herdr for the shared model). Ships in `skills/_canonical/core/openrig-cmux/` + `packages/daemon/assets/plugins/openrig-core/skills/openrig-cmux/`.

### Known Follow-ons

- **Save-verb** — did not land in 0.4.6; rides 0.4.7.
- **Twin fixture backfill** for the new workflow + multi-host UI routes (WorkflowsPage, WorkflowInstancePage, FleetPage, FleetBand, TerminalLauncher, HostConfigCard, HostIndicator, etc.) — non-blocking 0.4.7 hygiene fast-follow; UI acceptance carried by per-cut real screenshots + the two-host integration proof.
- **Carry-forwards from 0.4.4**: `openrig-user` bundled plugin stale-copy sweep, `whoami --all-hosts` silent host filter, managed-stop SIGTERM-escalation brittleness (recurred at 0.4.4 cutover), post-cutover reconcile-settle-visibility signal on `/healthz`.
- **iOS Safari** (Living Notes composer verification) — carry-forward from 0.4.4.
- **Wider mission-template prose sweep** — post-cut sequencing.
- **Continuous out-of-band dogfood runtime** — the factory-rsi RSI edge ships ungated in the MVP; the continuous mechanism is refined in a later release.

---

## [0.4.4] - 2026-07-06

**Status**: shipped; multi-host + Living Notes theme.

### Summary For Installing Agents

- **Package version**: bumps from `0.4.3`.
- **Migrations**: additive only. Existing v0.4.3 databases upgrade by running `rig daemon start` on the new daemon.
- **Node engines**: unchanged.
- **Backward compatibility**: `rig ps` default view flips to a consolidated all-active-rigs compact projection (the v0.4.0 current-rig-only default is retired); progressive-disclosure via `--full` / `-A` / `--rig <name>` returns the v0.4.3 default shape. `--json` shape unchanged (scope-not-shape). `rig host` gains three new verbs (`add` / `list` / `doctor`); transport posture documented (no behavior change).

### Headline

**Multi-host + Living Notes.** A shared rig topology can now span multiple hosts with staged whole-topology spin-up, real cross-host file movement, and a consolidated For-You feed that aggregates activity across every registered host. Living Notes ships as the durable INTENT → PLAN → DELIVERED signal layer with a one-structure review contract (single vertical stack, delete-not-demote) and cheap composer surfaces. Operator UX picks up `rig ps` consolidated default (with progressive disclosure), an agent-altitude coordination panel, and the operationalize-SDLC control plane. As-built docs closeout catches everything up.

### The SDLC control plane ships in source (OPR.0.4.4.23 — release requirement)

- **Conventions SSOT**: `docs/reference/sdlc-conventions.md` (copied into the assembled CLI package) — the section names the Living Notes UI projects (`## Intent` / `## Mini-requirements` / `## Proof contract`), the proof-contract format + `plannedRef` mockup pairing, the two staged-approval locks, the C1 proof header + closed sets, the three role contracts, the curation rule, the elastic-middle doctrine, and the advisory fail-open audit posture. Once shipped, the repo doc is the living SSOT; the corrective-redesign spec it derives from is the historical design record.
- **Scaffold**: `rig scope slice create` emits the convention sections + `proof/` + `PROOF.md` + an `IMPLEMENTATION-PRD.md` skeleton (elastic-middle note in its header) for **EVERY template kind** — enumeration-tested, so a future kind fails until covered. Mission templates carry the conventions pointer.
- **Advisory audit**: `rig scope audit` (both byte-identical classifier copies) gains `missing_intent_section` / `mini_requirements_missing_or_malformed` / `proof_contract_missing_or_malformed` / `ui_slice_missing_mockup` (mockup ref = a real image ref or plannedRef token, never bare prose) — low/info severities by construction (the exit code flips on HIGH findings only; records-and-advises, never gates). `rig workspace doctor` gains check #8 (`sdlc_convention_sections`, advisory warn) — the 7-check diagnostic is now 8.
- **Skill**: `mission-slice-sop` now ships in the canonical product skill source (+ `skills/_canonical` mirror), updated to teach the full flow: intent → mini-requirements + proof contract → mockups (UI slices) → plan-lock (`--scope spec`) → build the locked set → QA mockup↔delivered visual compare → `rig proof add` C1 drops → proof-lock (`--scope delivery`). The bundled openrig-core plugin's copy is now pinned by a CI byte-parity test. **Census (verbatim)**: before this slice, `mission-slice-sop` was absent from the canonical shared skill source and `skills/_canonical` mirror; the bundled plugin carried a stale orphan copy (from `c7f501a7`) with no guard — that orphan is replaced and parity-guarded. KNOWN residue: the plugin's `openrig-user` copy remains a wholesale-stale older edition with no mechanical guard (routed as a follow-up candidate, not swept here).
- **Bootstrap**: the shipped `openrig-start.md` overlay (the CLAUDE.md/AGENTS.md floor every managed seat sees) + the product-team and pm-team rig-spec cultures point fresh seats at the SOP skill and the SSOT at boot.
- **CLI help**: `rig proof`, `rig scope slice create`, and `rig scope slice approve` help text teach the flow and cite the SSOT; cli-reference gains the SDLC control-plane verbs section (`approve` locks, `rig proof add`, the audit advisories).

### `rig host` verbs + the documented multi-host transport posture (OPR.0.4.4.13)

- **New verbs (capped at exactly three)**: `rig host add` (registry writes validated by the loader's own rules — no more hand-edited YAML for the standard path), `rig host list` (config pointers, never secret values), `rig host doctor <id>` (stepwise distinct errors: transport → remote rig binary → daemon health → identity) with `--posture product-factory-vps` — the ONE built-in security baseline, three-valued per item (UNKNOWN is never pass).
- **Transport posture DECIDED + documented** (no behavior change): ssh carries pane ops (`send`/`capture`), http-bearer carries daemon REST (`up`/`down`/`launch`), `ps`/`whoami` follow the host's declared transport, fan-out is http-only; NO cross-transport fallback; NO http parity for send/capture in 0.4.4. Per-command table in cli-reference §Cross-host execution.
- **Product-factory bootstrap**: `scripts/bootstrap-product-factory-vps.sh` + `docs/reference/product-factory-vps-runbook.md` (fresh Ubuntu VPS → factory-ready; smoke-tested VPS posture as encoded defaults; safe UI tunnel + restricted fail-closed reverse-path recipes).

### BREAKING: `rig ps` consolidated all-rigs default + explicit disclosure ladder (OPR.0.4.4.21)

- **Default scope flips**: bare `rig ps` now shows **every ACTIVE rig on the host** as one compact O(rigs) row (the v0.4.0 current-rig-only default is retired — it hid running rigs from the operator's field of view). New display elements: the host rollup line ("N rigs · M seats · K need attention"), the archived/stopped count line, the drill-ladder footer, and an ATTN column (additive `attentionCount` JSON field).
- **`--json` is scope-not-shape**: still a bare array with the existing per-entry keys; scope widens to ALL non-archived rigs INCLUDING stopped ones (only the human table folds stopped rigs into the count line). Scripts that assumed current-rig-only add the existing `--rig <name>` flag — same schema, wider scope. **One-line migration for the old fleet firehose: `rig ps --nodes -A --full`.**
- **`-A`/`--all-rigs` keeps exactly ONE meaning** — the `--nodes` fleet widener. Bare `rig ps -A` is now a structured teaching error (all-rigs IS the default; archived history stays behind `--include-archived`).
- **`--nodes` names its scope everywhere**: session default applies locally only; `rig ps --host <id> --nodes` requires an explicit `--rig` or `-A` (implicit scope defaults don't cross host boundaries); multi-host fan-out is rollup-only by default; the full explicit ladder (`--all-hosts --nodes -A`, `--full` for complete records) fans out per-node with hostId-stamped projected rows.
- **`--all-hosts`/`--hosts --json` shape change**: emits the intra-P4 shared `AggregatedPayload` — `items` (per-host O(rigs) rows stamped with their origin `hostId`) + `hosts` (closed-enum per-host statuses: `ok | unreachable | unsupported-transport | auth-failed`).

### Multi-host foundation (OPR.0.4.4.11 + 13 + 15 + 18)

- **Shareable whole-topology staged spin-up (S11)** — a rig topology can be brought up in stages across multiple hosts; the spec + the daemon coordinate to reach a green whole-fleet state without requiring single-host bring-up.
- **VPS product-factory multi-host hardening (S13)** — `rig host` verbs (above) + the documented transport posture harden the fresh-Ubuntu-VPS → factory-ready flow. Product-factory bootstrap script + runbook ship for the smoke-tested VPS posture.
- **Multi-host consolidated For-You feed (S15)** — the For-You feed aggregates activity across all registered hosts in the topology. Real-host feed-subscription capture is sequenced as a lifecycle-post-publish belt-and-suspenders proof.
- **`rig file` cross-host movement (S18)** — files move across registered hosts via the `rig file` surface. Real registered-host two-host round-trip proves the flow on top of the VM stand-ins already merged.

### Living Notes signal layer (OPR.0.4.4.19 + 20 + corrective rebuild)

- **Living Notes signal layer (S19)** — durable agent-authored notes at mission and slice altitude; INTENT / PLAN / DELIVERED entries thread down the mission tree with agent authorship + timestamps.
- **Living Notes composer surfaces (S20)** — cheap authoring surfaces make Living Notes the first-class place agents record decisions, plans, and delivered work.
- **One-structure review contract §3.1 (corrective rebuild)** — the review surface reads left-to-right as a single vertical stack (INTENT above, PLAN + mockup in the middle, DELIVERED with paired proof at the bottom); a plan change **deletes** the old plan and writes a new one — never demotes / stacks multiple competing plans. Replaced an earlier three-column layout after human review.

### Operator UX (OPR.0.4.4.22)

- **Agent altitude coordination panel (S22)** — a coordination surface scoped to the right altitude (workspace / mission / slice) so the operator sees actual coordination state without drowning in per-seat detail. Composes with the workspace observability tabs shipped at 0.4.1.

### Docs closeout (OPR.0.4.4.24)

- **As-built docs closeout (S24)** — the as-built documentation family (`docs/as-built/architecture.md`, `docs/as-built/cli-reference.md`, codemaps) is caught up to what shipped through 0.4.4.

### Known Follow-ons

- **R2 — iOS-Safari S20** — deferred to 0.4.5 for iOS Safari verification.
- **R4 — S18 symlink footgun** — routed to the 0.4.5+ backlog.
- **`openrig-user` stale plugin copy + `whoami --all-hosts` silent host filter** — 0.4.5 candidates.
- **Wider mission-template prose sweep** — post-cut sequencing.
- **Belt-and-suspenders real-host proofs (R13-1 / R1 / R3)** — published-npm Linux install smoke, real registered-host two-host e2e for S13 + S18, and S15 real-host feed-subscription capture sequenced as post-publish lifecycle validation lanes. Shipped code already proven via VM/SSH stand-ins per PM rulings; real-host lanes are defense-in-depth belt-and-suspenders, not release gates.

---

## [0.4.3] - 2026-07-03

**Status**: shipped; "rigs that survive" theme.

### Summary For Installing Agents

- **Package version**: bumps from `0.4.2`.
- **Migrations**: additive only. `045_resume_verification`, `046_seat_identity_verdicts`, `047_events_node_type_index`. Existing v0.4.2 databases upgrade by running `rig daemon start` on the new daemon.
- **Node engines**: unchanged.
- **Backward compatibility**: `rig send` default posture changes — unknown / stale / missing / busy activity signals now advise-and-send instead of default-blocking; only `needs_input` (a real interactive picker on the target pane) is a hard send-refuse. `--dangerously-interact --reason "..."` override still available for intentional prompted-seat driving.

### Headline

**Rigs actually survive.** Crash-restore ledger (FR-3 → FR-7) survived a real hard power-off → reboot → `rig start`: both Claude and Codex seats restored to their **original** sessions with recalled pre-crash markers, zero fresh-prime. That's the load-bearing "rigs survive" claim, and it's proven at the operating-system level, not just in unit tests.

### Survival Backbone

- **Crash-restore resume-token ledger (FR-3 → FR-7 + FR-6.1)** — capture-on-adoption / snapshot-refresh / restore-target-pin / freshness threshold (1h advisory, `--fresh` re-verify, FR-6.1 periodic re-stamp) / **no-silent-fresh-prime** guarantee on the restore path.
- **Fixture-home isolation guard** — a fresh-prime that would clobber a live rig's home dir is refused loudly.
- **Liveness PID-verify** — daemon distinguishes a live seat from a dead-PID ghost.
- **Daemon event-loop health + terminal broker resilience** — health signal exposed; `TerminalSessionBroker` recovers cleanly across daemon restarts.
- **Startup-proof** — challenge-verified orientation read; seat can't skip past its orientation material.

### The Deny-by-Default `rig send` Reversal

The 0.4.1 3-layer guard was too strict at the fleet level — unknown / stale / missing / busy all default-blocked, requiring `--dangerously-interact` for routine coordination. Corrected:

- **Only `needs_input` hard-refuses** — that's the actual footgun-point.
- **Unknown / stale / missing / busy advise-and-send** — peer sends land; operator sees the advisory in output.
- **`--dangerously-interact --reason` override** — unchanged for intentional prompted-seat driving.

Also: **Codex activity-signal hardening** so idle Codex takes normal sends while the genuine prompt block holds; **hook-trust autoclear** fast-follow for fully-unattended Codex restore.

### `rig send` Unified Targeting

Multi-recipient list + `--pod` + `--rig` — reuses broadcast fan-out + per-recipient guard. Backward-compatible.

### Wave-2 UI + Theming

- **Rig-status + launch-control UI** — start / stop / recover a rig from the workspace surface; launch modal for mixed-plan rigs.
- **Switch-client view-retarget** — a switch-client action lands on the correct target view.
- **Dashboard theming (Vellum Dark opt-in)** — `light` = existing `:root` (byte-identical); `dark` = first shipped alternate; token-block + registry scales to N. Uses Tailwind `darkMode: 'selector'`.

### Recovery + Seat Lifecycle

- **Seat-handover full-cycle** — outgoing seat delivers captured context to a fresh successor; resume marker carries via FR-3; loud-unwind on both lanes on failure.
- **Seat-forking closeout** — fork lifecycle terminates on the shared checkpoint; predecessor + successor named.
- **Idle-gate watchdog** — idle seat holding a claimable gate qitem is woken with bounded skip-recording.

### Hardening + Bug Pile-ins

- **Session-admin mutation auth-guard** — admin mutation surface no longer reachable without the correct auth posture.
- **Secret-boundary B1 hardening (`rig auth`)** — fd-first: open the fd + operate on the fd, never re-resolve the path. Closes the check-then-use gap under interruption / concurrent-legitimate-rig-process scenarios (TOCTOU class closed as a consequence). Leak-hunt regression against the real credential file.
- **`rig queue show` bounded body preview** — long qitem bodies truncated in show view; full body inspectable via the queue-item drawer.
- **Manual configurable compaction trigger + same-seat guard** — Claude Code seats can be compacted from outside the seat; same-seat mutation refused.

### Doctrine

- **`mission-slice-sop` skill** ships — per-file rules for `PROGRESS.md` / `PROOF.md` / `MISSION_NOTES.md` / `MISSION_BRIEF.md` / `README.md`, the SCAFFOLD/POPULATE/PROJECT/VERIFY lifecycle, hot-potato queue handoffs, `rig scope audit` backstop.

### Known Follow-ons

- Slice-04 real-provider handover VM-marker — code proven at runtime; real-provider end-to-end VM-round-trip is a fast-follow proof capture (not a claim gap; the load-bearing survival proof is the crash-restore capstone).
- `rig ps` consolidated-default + progressive disclosure — captured for 0.4.4.
- Deploy-identity: git SHA via `/healthz` + `rig --version` (version-truth-vs-commit-truth observability gap) — captured for 0.4.4 Discovery.
- Managed-hooks-via-`requirements.toml` — later fast-follow.
- Skill-layer cut depth (slice-25) + dashboard glyph swap (slice-24) — deferred.

---

## [0.4.2] - 2026-07-01

**Status**: shipped; targeted CLI hotfix.

### Summary For Installing Agents

- **Package version**: bumps from `0.4.1`.
- **Migrations**: none — no schema changes ship in `0.4.2`.
- **Node engines**: unchanged.
- **Backward compatibility**: no CLI surface, daemon, or dependency changes. `rig daemon status` no longer false-negatives during the daemon's post-start listener-bind window; genuine-down reporting is unchanged.

### Fixed

- **`rig daemon status` false-negative after restart** — the probe's single `/healthz` fetch lost to the post-restart HTTP-listener bind window (process up, not yet accepting), causing a false "Daemon not running" / "healthz failed" report even though `/healthz` was returning `200`. Fixed by wrapping the three `getDaemonStatus` `/healthz` branches in a status-probe-local bounded settle (max 5 attempts, 200ms backoff, hard-bounded). Genuine-down still fails all attempts and is reported stopped / unhealthy after the budget — never masked, never an unbounded wait.

### Scope

- `packages/cli/src/daemon-lifecycle.ts` — three probe branches now go through `probeHealthzWithSettle`.
- `packages/cli/test/daemon-lifecycle.test.ts` — focused probe-layer tests: transient-then-healthy settles to running / healthy; pid-alive-but-never-answers stays `healthy: false`; genuine-down still reported stopped after the hard-bounded budget.

No dependency, script, config, or behavioral package-field changes beyond the CLI hotfix and version bumps.

---

## [0.4.1] - 2026-06-30

**Status**: shipped; observability + operator-UI overhaul.

### Summary For Installing Agents

- **Package version**: bumps from `0.4.0`.
- **Migrations**: additive only. Migration 044 adds a nullable `queue_items.summary` column; pre-0.4.1 items degrade cleanly to a body-fallback label. Existing v0.4.0 databases upgrade by running `rig daemon start` on the new daemon.
- **Node engines**: unchanged.
- **Backward compatibility**: `rig send` defaults now refuse a send when the target pane is at an interactive prompt or permission block (3-layer guard: L0 default-blocked, L1 `--raw` still guarded, L2 `--dangerously-interact --reason "..."` audited override). `rig queue create` + `rig queue handoff` gain an optional `--summary` field with WARN-on-author (does not hard-break existing callers). Cosmetic Project tab renames: Topology → Workflow (test-id stable as `project-tab-topology`); Queue folds into Story.

### Headline

OpenRig v0.4.1 is the **workspace-as-mission-cockpit** release: a coherent altitude projection (workspace → mission → slice), a Mission **Steering** landing tab (`STEERING.md` + `MISSION_BRIEF.md`), a **Story** queue-item DAG git-graph that reconstructs what actually happened on a mission, a **Workflow** spec visualizer, a **Proof** tab, a Workspace **Portfolio** panel, an **Artifacts** navigator, and a **Progress** heat-map — all derived through a new UI digital twin so visual intent can be approved before any UI slice is built.

### New Top-Level CLI Verbs

- **`rig auth`** — product-native, CLI-local Codex auth-profile management with a hardened secret boundary (refuses symlinked active auth, hardlink + symlinked-parent escapes out of `CODEX_HOME`). List / show / switch / capture / forget profiles under `~/.openrig/codex-auth/`.

### `rig send` — Interactive-Prompt Guard

- **L0 (default)** — blocks `rig send` when the target pane is at an interactive prompt or permission block. Hook-primary (Codex `PermissionRequest`) with a hardened capture-pane fallback (12-line trailing-content scan + 15-second send-readiness freshness).
- **L1 — `--raw`** — exact keystrokes; the L0 guard still applies.
- **L2 — `--dangerously-interact --reason "..."`** — explicit override, implies `--raw`, requires `--reason`, writes an audit row.

### Workspace Observability Surfaces

- **Mission Steering tab** — landing tab when you click into a mission. Panel 1 projects `STEERING.md` (what agents are currently being told to do); Panel 2 projects the new mission `MISSION_BRIEF.md` doctype (the locked 7-section template).
- **Mission Brief doc-type + projection** — `rig scope init-workspace` / `rig scope mission create` emit a root `MISSION_BRIEF.md` from the 7-section template (Brief / What & why / Building / Progress / Proven / Needs you / Pointers); the Steering tab renders it markdown → UI.
- **Story tab — queue-item DAG git-graph** — scrollable, upward-growing git-graph derived from `chain_of_record` + handoff lineage; single-parent edges only (no invented merge state); one-line rows over a curved gutter; Tier-3 drawer with the full agent-speak body + chain. Mission + slice altitudes; client-side from `/api/queue` (no new surface). Queue tab folds into Story.
- **Workflow tab — spec visualizer** — finishes the half-built Project Topology tab into a real read-only visualizer of the configured workflow spec (dotted-grid canvas, dark-header step cards, per-step state dot, dagre LR layout, amber reject → rework loop-back). Label rename Topology → Workflow (`project-tab-topology` id-stable). Mission + slice altitudes.
- **Proof tab** — per-slice proof galleries + empty-state for scaffolded-but-unpopulated slices; reads from each slice's `proof/` directory and an optional `PROOF.md` summary.
- **Progress heat-map** — Project Progress tab consolidates to the heat-map (per-slice rollup cards retired).
- **Artifacts navigator** — slice-altitude `ArtifactsNavigator` replaces the prior `SliceArtifactsTab` card wall; resolves via the existing `/api/files/*` surface; Decisions surface routes through Story (decision-of-record items are Story nodes).
- **Workspace portfolio** — workspace parent-altitude cross-mission portfolio panel (mission list + steering glance on expand, lazy `MISSION_BRIEF.md` fetch); rollup metric counts *proven* (from `hasProofPacket`) rather than `done`.

### UI Digital Twin + Visual-Intent Convention

- **UI digital twin (harness)** — a derive-from-source twin renders all six real Project UI surfaces 1:1 daemon-free from typed fixtures (cache-seed + a thin fetch override + a seeded SSE stream; **not** MSW). One self-contained `intent.html` per surface; tsc compile-time drift-guard; ~2-step per-slice authoring loop; production-isolated dev-only target. Per-surface build: `TWIN_ROUTE=<route> npm run twin:build`.
- **`rig scope` intent-visual slot** — `rig scope slice create` scaffolds an `## Intent visual` slot in the slice `README.md` (with `[change.diff]` + the `TWIN_ROUTE=<route> npm run twin:build` rebuild command). Non-visual slices get an explicit `N/A` line.
- **Visual intent → proof convention** — adopted alongside the harness.

### Topology + For-You

- **Topology edge-flow animation** — when a real queue handoff or `rig send` travels an edge, the edge animates in the handoff direction, brightens while live, then settles static after TTL. Animates **only** on a real queue/send signal (no workflow DAG, no ambient motion); reduced-motion omits the flow.
- **For-You phone restyle + real-data fidelity** — the Dashboard restyle reaches For-You as a phone-friendly cards layout with an altitude-dial level filter (All activity → Highlights → Needs you). The internal `source.type` wrapper string no longer renders, and the vestigial storytelling-preview band that ignored the level filters is removed.

### Reliability + Correctness

- **Fresh-install daemon-start fix** — `@hono/node-ws` is now declared in `@openrig/cli` (the CLI vendors the built daemon and does not depend on `@openrig/daemon`, so its `package.json` must mirror the daemon runtime deps for a global install to resolve them). A packaging-completeness gate now fails the test suite if a daemon runtime dep is not mirrored in the CLI.
- **Table / hybrid terminal-action reliability** — terminal-action errors surface as a visible alert instead of silent failure on the topology Table view + the hybrid surface; the Table terminal now opens cleanly.
- **Queue-item human-readable summary** — additive nullable `summary` field on queue items (migration 044). The Story-row label prefers the authored summary and degrades to the body fallback for pre-0.4.1 items. The agent-speak body remains the source of truth and is inspectable in the queue-item drawer.
- **Seat-scoped post-compaction restore** — Claude Code seats get a scoped, idempotent restore packet derived from the JSONL transcript.
- **Table-view crash fix** — null-safe TanStack filter + an `ErrorBoundary` on all three topology Table mounts (host / rig / pod).
- **Dashboard route refresh** — cosmetic visual overhaul of the welcome / home launcher route (paper-draft launcher grid + six cards + Field Environment).

### Conventions Adopted

- **Visual intent → proof** (the digital-twin convention) — derive-from-source twin (no MSW), one `intent.html` per surface, twin-data-freshness as the residual release-close check.
- **Release-durability close AC-9 — skill-cascade integrity**.
- **Release-durability close AC-10 — twin-data-freshness**.

### Known Limitations + Follow-ons

- The skill-layer cut still awaits a decision on the load-bearing set; the cut does not execute in this release. The shipping cascade-drift checker (slice 04.3) is not in this cut.
- Convention drift control (slice 28) is partially delivered (convention ratified + folded into the release-close gate; product skill + audit-code in flight).
- Twin capture tooling (slice 11.2) is in flight; the twin harness ships.
- Workspace UX architecture (slice 15) design-discovery scope is approved; remaining mockups are in flight.
- For-You embedded terminal phone-UX is a non-gating polish check, not yet phone-verified.
- `rig send` hook-primary `PermissionRequest` path lands with this release; the fallback capture-pane guard is fully proven; the hook-primary path rides its full proof on the next iteration.
- `rig auth` deeper structured secret-boundary follow-on is tracked separately, not in this cut.
- Inherited cascade-metadata hygiene from v0.4.0 remains the documented residue; bulk fix is a separate work item.

### Carry-Forward From v0.4.0

The v0.4.0 cascade-metadata hygiene findings (`missing_provenance` + `missing_verified` on the skill layer) remain the documented residue. Other v0.4.0 known issues (managed-seat Codex hook-trust ID-scrape, resume auto-capture-on-reconcile, post-host-adoption smoke for `rig seat clear-attention` + Codex resume posture) carry forward to subsequent releases.

---

## [0.4.0] - 2026-06-20

**Status**: wrap-gate CLEAR; lifecycle push / npm publish / tag held for founder-auth.

### Summary For Installing Agents

- **Package version**: bumps from `0.3.4` at the lifecycle wrap step.
- **Migrations**: additive only; no schema-breaking migrations. Existing v0.3.4 databases upgrade by running `rig daemon start`.
- **Node engines**: unchanged.
- **Backward compatibility**: read-command DEFAULTS change (compact-by-default for `rig ps`, `rig whoami`, `rig queue list`, `rig restore-check`, `rig context`); `--full` returns the v0.3.4 default shapes. `rig queue list` adopts docker / kubectl-aligned grammar (`-a` / `-A` / `--full` / `-o json|wide` / `--mine` / `--source` / `--destination`); the prior unscoped firehose default is retired (opt-in via `-A -a --full`). Existing flag forms continue to work and compose with the new grammar.

### Token-Efficient Defaults (headline)

Five read-commands flip from firehose-by-default to compact-by-default — closes a ~225,000-token aggregate context-window cost on aged hosts.

- **`rig ps`** — compact TL;DR per node (slice 25); `--full` for v0.3.4 shape; `--rig <name>` / `--session <sess>` filters. **Slice 34** breadth default flipped to current-rig (derived from `OPENRIG_SESSION_NAME`'s `@<rig>` suffix); `-A`/`--all-rigs` for fleet breadth; all-states default preserved (topology/readiness signal, unlike queue-list); `--full` JSON now emits `resumeTokenPresent` boolean instead of the resume-token value (security fix). Daemon-side payload source-dedup (slice 26): `recoveryGuidance` no longer duplicated per-node; `contextUsage` compact in list payload.
- **`rig whoami`** — compact identity-recovery essentials by default (~192 tokens vs ~909); `--full` (alias `--verbose`) returns v0.3.4 payload. Allowlist projection — future fields default to `--full`.
- **`rig queue list`** — docker / kubectl grammar (slices 28 + 32): `-a` for history, `-A` for cross-rig breadth, `-o json|wide` for encoding, `--mine` / `--source` / `--destination` for scope. Default is active + compact + current-rig.
- **`rig restore-check`** — summary counts + not-ready seats only by default (slice 29); `--full` for complete per-seat detail. Closes the largest measured bomb (~79,000 → low thousands).
- **`rig context`** — compact summary by default (slice 30); `--full` for complete payload.

### New Top-Level CLI Verbs and Subcommands

- **`rig skill audit`** (slice 10) — read-only audit of the skill cascade. Detects `missing` / `stale` / `self-referential` / `invalid-date` / `mirror-drift` across canonical → product mirror → hub cwd → installed plugin. False-green prevention: emits `unable-to-audit` exit `2` rather than reporting `clean` when evidence unavailable.
- **`rig scope mission|slice progress`** (slice 33) — deterministic `PROGRESS.md` updates through the command surface rather than hand-edited markdown. `rig scope mission|slice create` now scaffold `PROGRESS.md` automatically.
- **`rig scope mission|slice stage / verified / reconcile`** (slice 35) — maturity vocabulary from `conventions/scope-and-versioning` §2 enforced through commands. `stage <id> <new-stage>` sets `stage` (wip / provisional / established / canonical / superseded / retired); `superseded` REQUIRES `--successor`; invalid stages rejected. `verified <id> --against "<source>"` stamps `verified: <today> against <source>`; `--against` MANDATORY (bare timestamps rejected — the anti-stale keystone). `reconcile <id>` is the idempotent repair verb (backfills `PROGRESS.md` + conforms `id`/`stage`/`verified` frontmatter + repairs id-registration ghosts). `create` now writes mandatory `stage` (default `wip`) + a `verified` placeholder. `show` derives read-time effective-reliability projection from (stage × verified) — stale-`verified` `canonical` reported as effectively `provisional`. Composes with slice 33 to make `rig scope` the deterministic convention-enforcer.
- **`rig seat clear-attention`** extended to derived projection staleness (slice 16) — reaches the second class of projection staleness (`restoreOutcome=failed` on a live ready session) that v0.3.4 couldn't.

### UI + Topology + Identity

- Real (interactive) terminals (slice 01) — per-seat terminals are interactive; read-only 3-second snapshot view retired for local-host seats. Global `LiveTerminalRegistry` caps concurrently-live terminals (`ui.terminal.max_live_terminals` config); `LiveTerminalProvider` + `ProgressiveTerminal` interaction model — live where the user is looking, static smoked-glass thumbnails everywhere else; in-place multi-live in the topology grid; shared smoked-glass styling across focused / popover / grid / node-detail.
- Real-terminal session broker (slice 38) — release-critical reliability: a daemon-owned `TerminalSessionBroker` keyed by canonical `sessionName` (one tmux pipe-pane per session, N WebSocket subscribers, output fanout, session-level seed + shared scrollback ring, input-owner semantics, honest cleanup). Closes the "second view steals output from the first" failure mode (tmux's one-pipe-pane-per-pane constraint). `terminal-ws` is now a thin broker subscriber. Resize policy = canonical fixed geometry (120×40); subscribers fit/scroll their container, no per-subscriber tmux resize.
- Unified static/live terminal component (slice 39) — shared `StaticTerminalPlate` + opaque mirror + static line-return fix + 90×27 mirror geometry (fit-to-container projection of the broker's 120×40 live stream); fontSize-scaling for selection on scaled views (not CSS transform); geometry-comment sweep (behavior-neutral).
- Agent Images library polish (slice 07) — Fork-now + row metadata + nested-failure rendering.
- Attention / activity detection elite tier (slice 09) — richer `agentActivity` consumption.
- Topology graph-view ghost render fix (slice 21).
- Reliable active/idle node state (slice 18) — DOT→terminalActive fallback; dead `pane_silence_flag` retired.
- Multi-host dogfood hardening (slice 02).
- Native Codex session-identity capture (slice 11) — foundation for 0.4.1 identity refactor.
- Codex resume preserves approval posture (slice 17).
- Scope-backed progress rails (slice 15).

### Bug-Fix Wrap

- Wrap convergence fixes (slice 24) — P1 For-You drill captured/live contract + P2 daemon test-harness WebSocket registration.

### Known Limitations / Carry-Forward

- **Plugin-lineage drift in `openrig-core`** — the openrig-core plugin skill lineage is divergent/stale; full re-sync is OPR.0.4.1.4 (rides 0.4.1). Boot-path layers (canonical + hub cwd) verified current in wrap-gate AC-3 sweep. `rig skill audit` (slice 10) is the runtime mechanism for future drift detection.
- All earlier "PUSHED to 0.4.1" carry-forwards from the original wrap-gate were RESTORED to 0.4.0 during the wrap: slice 34 (`rig ps` current-rig default + `-A`/`--all-rigs` + `resumeTokenPresent`) landed — see Token-Efficient Defaults; slice 35 (`rig scope` stage/verified/reconcile) landed — see New Top-Level CLI Verbs. Real-terminal-related slices 38 + 39 also shipped via founder live-dogfood forward-fix authorization 2026-06-21. Nothing of substance carries forward to 0.4.1 from the original wrap-gate set.

### What To STOP Using

- Stop using `rig ps --nodes --json` as the casual status check assuming v0.3.4 shape; compact default IS the casual check.
- Stop using bare `rig queue list` as the cross-rig firehose; default is now active + current-rig.
- Stop using `rig whoami --json` for the heavy payload on boot; default is compact.
- Stop using `rig restore-check` as a per-seat-detail fleet scan; default is summary + not-ready only.
- Stop hand-editing `PROGRESS.md` markdown; use `rig scope ... progress`.
- Stop applying the `token-efficiency-boot-guardrail` pack's CLI-command prohibitions on hosts running 0.4.0 (host-version workarounds; CLI-prohibitions half retires at host-upgrade). The pack's bounded-local-search + scope/over-flag discipline GRADUATE to a standing convention.

### Verification

- Wrap worktree clean on `8d55ea60`.
- CLI surfaces source-verified against the command modules at the release SHA.
- CLI→skill cascade sweep: canonical `openrig-work/skills/openrig-user/SKILL.md` → product mirror at `packages/daemon/specs/agents/shared/skills/core/openrig-user/SKILL.md` → hub cwd `.claude/skills/openrig-user/SKILL.md` + `.agents/skills/openrig-user/SKILL.md` — all byte-identical (md5 `e2aa9176`).
- cli-reference.md updated for 6 changed commands + new `rig skill` section; `last-verified-against-source` bumped to `8d55ea60`.
- Stale-pattern grep (`dumps everything` / `--notify required` / `rig down 404`) returned 0 hits across active SKILL.md locations.
- AC-6 self-check evidence: `substrate/shared-docs/openrig-work/missions/release-0.4.0/slices/36-release-durability-close/AC-6-wrap-gate-self-check-evidence.md`.

---

## [0.3.4] - 2026-06-15

**Status**: released. npm `@openrig/cli@0.3.4` (latest); GitHub Release
`v0.3.4`; git tag `v0.3.4`.

### Summary For Installing Agents

- **Package version**: package metadata bumped at release-manager step;
  CLI reports the new version after `npm publish`.
- **Migrations**: no new schema-bumping migrations in 0.3.4. Existing
  databases upgrade by running `rig daemon start` on the new daemon.
- **Node engines**: unchanged from 0.3.3 (CLI accepts Node `>=20`).
- **Backward compatibility**: existing CLI argument shapes, daemon
  route paths, RigSpec/AgentSpec schemas, and persisted settings
  remain backward compatible. New routes are additive
  (`POST /api/rigs/:id/up` plan / apply path is the same path 0.3.3
  shipped; `POST /api/sessions/:session/reconcile` is new;
  `POST /api/sessions/:session/clear-attention` is new;
  `POST /api/rigs/:rigId/nodes/:nodeRef/launch` and
  `POST /api/rigs/:rigId/nodes/launch-subset` are new). New CLI
  commands (`rig start`, `rig reconcile-session`,
  `rig seat clear-attention`) are additive. `rig up` flips from
  fresh-by-default to resume-original-by-default — callers that
  implicitly relied on fresh-prime as the default must now name
  `--fresh <seats...>` explicitly.

### `rig start` — Recovery Entry Point (slice 01)

New top-level command. Sequences existing primitives: daemon-start
-> kernel auto-boot wait -> candidate listing -> picker / flags ->
per-rig restore (`/api/rigs/:id/up`) + reconcile:

```
rig start                            Interactive: daemon + kernel + pick-and-restore
rig start --last                     Headless: restore all rigs that were last running
rig start --all                      Headless: restore all rigs with restore-usable snapshots
rig start --rigs <name> [<name>...]  Headless: restore only the named rigs
rig start --json                     JSON output for agents
```

- **Id-grounded end-to-end**: candidate preview and apply both go
  through `POST /api/rigs/:id/up`. Same-name rigs surface as
  separate candidates; selection carries `rigId` so the name-based
  `/api/up` route is never consulted in the recovery path (no
  `ambiguous_name` 409).
- **Re-codes nothing**: same `/api/rigs/:id/up` that
  `rig up <existing>` uses; same five-term vocabulary on the
  seat-level outcome.

### `rig up` — Resume Original By Default (slice 02)

`rig up <existing-rig>` resumes original sessions by default.
`--fresh <seats...>` is now the explicit per-seat opt-in for
operation B (deliberate fresh-prime):

- **Default**: seats resume; outcome reports `resumed`.
- **`--fresh <logicalId> [<logicalId>...]`**: deliberate fresh-
  prime for the named seats; outcome reports `fresh-primed`.
- **`awaiting-decision`**: when the daemon cannot resume and the
  operator has not opted into fresh. TTY callers get a per-seat
  `[y/N]` prompt; headless callers get the explicit hint
  `rig up --existing <source> --fresh <logicalId>`. ZERO session
  started for `awaiting-decision` seats.
- **Backward-incompatible default flip**: callers that implicitly
  depended on fresh-prime as the default must now name `--fresh`
  explicitly. The `--existing` flag (treat `<source>` as a rig
  name) is unchanged.

### `rig reconcile-session` — Adopt a Hand-Resumed Session (slice 03)

New top-level command. Adopts a LIVE, hand-resumed canonical
session back into its persisted node without launching:

```
rig reconcile-session <session>
rig reconcile-session <session> --rig <rigId> --node <logicalId>
rig reconcile-session <session> --no-launch
rig reconcile-session <session> --json
```

- **NEVER launches / relaunches / kills / replays startup / presses
  resume menus / compacts / types into the pane.** The only mode
  this command has; `--no-launch` is accepted for explicitness.
- **Same node id, no re-key**: the live process binds back to its
  OWN persisted node.
- **Honest reporting**: projection drift is a list of unproven
  metadata fields; conversation continuity is reported as a status
  string, never claimed as proven.
- **Daemon route**: `POST /api/sessions/:session/reconcile`.

### `rig up --plan` — Read-Only Restore Preview (slice 04)

```
rig up <existing-rig> --plan [--json]
```

- **No mutation**: returns the restore plan only.
- **Per-node `intendedAction`**: `resume` / `fresh-prime` /
  `awaiting-decision` keyed to the five-term vocabulary.
- **Snapshot the plan would consume**: surfaced in the response so
  the operator can verify the floor before apply.
- **Honest async timeout**: when the preview cannot complete
  within bound, the response says so rather than claiming a clean
  plan.

### Pod-Aware Claude Resume-Selection Menu (slice 05 rev1 BLOCKING)

`ClaudeCodeAdapter.verifyResumeLaunch` now treats a Claude
resume-selection menu the same way it treats the Codex
unresolved-gate case (the 0.3.3 slice 21 FR-2 pattern):

- Returns immediately with `recovery: attention_required` and
  last-12-line pane evidence on BOTH the inner poll loop and the
  final-probe exit path.
- ZERO numeric selection keystrokes are ever sent.
- Routes into the existing `HarnessLaunchResult` ->
  startup-orchestrator `startupStatus: attention_required` ->
  `ps` / `status` projection — same path the Codex case uses.

### Five-Term Restore Status Vocabulary (slice 06)

The seat-level status on `rig up`, `rig restore`, and `rig ps` is
now ONE of:

- **`resumed`** — original session continuity proven by the
  native-resume probe.
- **`fresh-primed`** — operator opted into deliberate fresh-prime
  (operation B); a brand new session started instead of resumed.
- **`awaiting-decision`** — daemon could not resume and operator
  has not opted into fresh. ZERO session started. The honest
  zero-session state.
- **`attention_required`** — seat is live or parked but needs
  operator action (auth gate, model-selection menu, trust prompt,
  stuck recovery). NEVER reported as `failed`.
- **`failed`** — the launch transport itself failed.

Replaces the prior 2-3 term collapsed model that hid edge cases.
`awaiting-decision` is new and replaces the prior pattern where
zero-session outcomes were either misreported as success or as
failure.

### Codex Profile-V2 Preflight (slice 07 rev1 BLOCKING)

Profile-load check on profile-bearing launch and restore
surfaces, with narrowed legacy-profile detection:

- **Legacy detection requires legacy-specific patterns only**:
  `contains legacy`, `[profiles.<name>]`, `cannot be used while.*
  legacy`, `legacy profile selector`. The prior generic match
  against `failed to load configuration` was also catching
  invalid-TOML stderr and giving the wrong migration hint.
- **Invalid TOML surfaces the parse reason**: up to 3 stderr
  lines (e.g. `expected newline`) with a generic TOML-validity
  hint instead of a wrong hint pointing at
  `[profiles.<profile>]`.
- **Stale comment in `codex-runtime-adapter.ts` corrected**:
  absent `.config.toml` passes (Option B), not fails.

### cmux Launch Readiness (slice 08)

Launch path no longer silently produces a partial cmux workspace:

- **Honest partial-workspace state**: when cmux comes up with a
  subset of expected windows / panes, the seat surfaces an honest
  partial state instead of being projected as launched-clean.
- **One-click open-missing affordance**: UI surfaces the one-click
  path to open the missing workspace pieces.

### Periodic Snapshots (slice 09)

`PeriodicSnapshotScheduler` ships as the crash-insurance floor
under event-driven and teardown snapshots:

- **`snapshots.periodic.enabled`** (default `true`): master
  switch.
- **`snapshots.periodic.interval_seconds`** (default `300`):
  per-rig snapshot interval.
- **`snapshots.periodic.retention_keep`** (default `10`):
  per-rig `auto-periodic` retention count.
- **`auto-periodic` snapshot kind**: captured per enabled rig on
  interval; pruned by `retention_keep`.
- **Restore selector**: treats `auto-periodic` and `auto-pre-down`
  symmetrically — the newer wins. A daemon crash between teardown
  snapshots no longer loses arbitrary lifecycle state.
- **`rig ps` / status**: surfaces last-snapshot / floor so the
  operator can see the crash-insurance floor at a glance.

### `rig seat clear-attention` (slice 10)

New subcommand on `rig seat`. Evidence-gated, operator-attested,
audited reconcile of a stuck `attention_required` seat back to
`ready`:

```
rig seat clear-attention <session>
rig seat clear-attention <session> --reason "<operator attestation>"
rig seat clear-attention <session> --json
```

- **Without `--reason`**: clear requires daemon-side evidence the
  seat is back to a clean state.
- **`--reason <text>`**: operator-attestation override of the
  evidence gate; the attestation string lands in the audit row
  verbatim.
- **Daemon route**: `POST /api/sessions/:session/clear-attention`.
- **Output**: `Cleared <session>: <from> -> ready (<clearedBy>)`.
- **Replaces** the hand-edit-SQLite / fake-clear pattern. Node id
  is unchanged.

### Node-Granular Managed Partial Restore (slice 11)

`rig launch` relaunches a seat or subset by logical id through
orchestration:

```
rig launch <rigId> <nodeRef>                  Single seat
rig launch <rigId> --seats <a,b,c>            Subset (comma-separated)
rig launch <rigId> --seats <a,b> --hold-reason "<text>"
rig launch <rigId> --seats <a,b> --json
```

- **Single target**:
  `POST /api/rigs/:rigId/nodes/:nodeRef/launch`.
- **Subset**: `POST /api/rigs/:rigId/nodes/launch-subset`.
- **Partial outcomes never collapsed**: `launched`, `held` (with
  reason), `alreadyRunning`, and `failedTargets` (liveness
  unknown) reported separately.
- **Retires** the v0.3.x-era `pod_aware_launch_unsupported`
  dead-end and the "use `rig up` instead" workaround that lost
  per-seat control.

### Slow Codex Resume Classification (slice 13)

Internal classification tweak in `verifyResumeLaunch` for slow
but genuinely-resuming Codex sessions:

- Previously the slow path mis-categorized through the
  unresolved-gate branch.
- Now correctly classifies through the five-term vocabulary and
  reaches `resumed` when the readiness probe confirms.

### What to STOP Using

- `rig up <existing-rig>` is no longer fresh-by-default. Use
  `--fresh <seats...>` for deliberate fresh-prime.
- A live or parked seat is NEVER `failed`. Use
  `attention_required`. The honest zero-session state is
  `awaiting-decision`.
- `pod_aware_launch_unsupported` / "use `rig up` instead" for
  per-seat relaunch is RETIRED. Use `rig launch <rigId> <nodeRef>`
  or `rig launch <rigId> --seats <a,b>`.
- Hand-editing SQLite or fake-clearing a stuck
  `attention_required` seat is RETIRED. Use
  `rig seat clear-attention <session>` (evidence-gated) or
  `rig seat clear-attention <session> --reason "<attestation>"`
  (operator-attested, audited).
- Relying only on event-driven or teardown snapshots for crash
  safety is RETIRED. The periodic snapshot scheduler is the
  floor; tune `snapshots.periodic.*` to taste.
- Classifying invalid TOML as a legacy-profile problem is
  RETIRED. The Codex profile-v2 preflight surfaces the actual
  parse reason.
- Restoring a hand-resumed session by relaunching the whole rig
  is RETIRED. Use `rig reconcile-session <session> --no-launch`.

### Known Limitations / 0.3.4 Carry-forwards

- **`rig view list/show --json` flag inconsistency** —
  wrapper-layer routing path remains; the daemon's
  `view show <name>` route returns JSON correctly when invoked
  directly. Workaround: human-readable output for now.
- **`docs/DESIGN.md` docs-guard ledger** — design-doc update
  ledger carries forward; no runtime impact.
- **Slice-21 FR-1 (native Codex session-id hook)**: scope-tipped
  to 0.4.0 after build-time forensic. Carried forward from 0.3.3.
- **Slice-13 component 3 (auto-rollout dispatcher)**: skill-layer
  landing remains; product-code dispatcher / invocation is
  intentionally out of the shipped runtime bundle. Carried
  forward from 0.3.3.
- **Slice-05 sub-scopes carried forward**: agent / port /
  managed-app collision detection (Item 4.3); broader
  install-into-existing-rig pathway acceptance (Item 4.4);
  `--target-name` CLI flag for install-time rig-name overrides.
- **Slice-21 FR-4(d) accepted-queue-state schema**: deferred from
  0.3.2; carried forward.
- **Onboarding journey + battle-hardening**: slices 04
  (new-user-journey), 08 (hooks-elite), 10 (rig-self), 11
  (personal-rig) carried forward to a later release.
- **Workspace symlink alignment**: daemon-side workspace-resolver
  alignment with operator symlinked workspace roots remains a
  follow-up; non-blocking for 0.3.4.
- **Slice-13 permission-block-routing-architecture remains held**:
  big-green-light gated by operator review; `rigx-experimental`
  only; not split-deferred (stays held).
- **0.3.4 host-upgrade flow held**: operators installing v0.3.4
  fresh from npm have full access immediately; existing-host
  upgrade follows the standard daemon-restart flow. The named
  host-upgrade flow is held for separate sequencing.

### Quick Verification Commands

```bash
# Confirm CLI version after the release-manager version bump
rig --version

# Confirm daemon starts cleanly (no new migrations to apply in 0.3.4)
rig daemon start

# Confirm rig start surface is wired
rig start --help

# Confirm rig up --plan + --fresh are wired
rig up --help | grep -E "(plan|fresh)"

# Confirm rig reconcile-session is wired
rig reconcile-session --help

# Confirm rig seat clear-attention is wired
rig seat clear-attention --help

# Confirm rig launch supports single-seat + subset relaunch
rig launch --help

# Confirm five-term vocabulary on rig ps
rig ps --help | grep -i attention
```

---

## [0.3.3] - 2026-06-11

**Status**: released. npm `@openrig/cli@0.3.3` (latest); GitHub Release
`v0.3.3`; git tag `v0.3.3`.

### Summary For Installing Agents

- **Package version**: package metadata bumped at release-manager step;
  CLI reports the new version after `npm publish`.
- **Migrations**: one new migration in 0.3.3 — `042_rig_archive`
  (`ALTER TABLE rigs ADD COLUMN archived_at TEXT` + `idx_rigs_archived`;
  append-only, non-destructive, no rigs-row restructure). Existing
  databases upgrade by running `rig daemon start`.
- **Node engines**: unchanged from 0.3.2 (CLI accepts Node `>=20`).
- **Backward compatibility**: existing CLI argument shapes, daemon
  route paths, RigSpec/AgentSpec schemas, and persisted settings
  remain backward compatible. New routes are additive
  (`/api/rigs/:id/archive`, `/api/rigs/:id/unarchive`,
  `/api/rigs/:rigId/pods/:podNamespace/members`). New CLI commands
  (`rig archive`, `rig unarchive`, `rig add` / `rig add-member`) are
  additive. New `rig ps`, summary, and `rig up` flags
  (`--include-archived`, `?includeArchived=true`, `?archived=only`)
  are additive and default to existing exclude-archived behavior.

### Large Startup-File Transport (slice 16)

`TmuxAdapter.sendText` no longer caps at the OS `MAX_ARG_STRLEN`
limit:

- **Payloads over 100KB** are written to a unique temp file (Node
  `fs`, never shell-embedded), loaded into a unique tmux buffer,
  and pasted with `paste-buffer -d -r`. `-r` preserves raw LF so
  multi-line packs do not early-submit on every newline; `-d`
  drops the buffer on successful paste. The single trailing C-m
  stays the caller's separate `sendKeys(["C-m"])`.
- **Payloads under 100KB** keep the exact inline
  `tmux send-keys -t <t> -l <text>` command (behavior-preserving).
- **Cleanup**: temp file unlinked in `finally`; explicit
  `delete-buffer` on paste-error path; unique temp + buffer names
  per call so parallel `rig up` seats do not collide.
- **Backward-compatible constructor**: optional second arg supplies
  the file/buffer ops (default wires Node `fs` + `os.tmpdir`);
  `new TmuxAdapter(exec)` is unchanged.

### `send_text` Inline Dash Sentinel (slice 17)

Inline `tmux send-keys -t <t> -l <text>` now carries a `--`
end-of-options sentinel:

- Any small `send_text` startup payload whose content begins with
  `-` (notably `---` YAML frontmatter — the norm for per-seat
  packs) is no longer parsed by tmux as flags.
- Inert for non-dash content.
- The slice-16 large/buffer path is already immune (content
  travels via a file, never argv) and is untouched.

### cmux 0.64.x Compatibility (slice 18)

`surface.list` normalizer resolves the surface handle across cmux
0.64.x AND 0.63.x:

- cmux 0.64.x renamed the surface identifier: `list-panels --json`
  rows carry `ref` with no `id` (0.63.x carried `id`). Result:
  `surfaceId` came back undefined and cmux-transport never mapped
  `surface.sendText` -> `cmux send`, throwing
  "Unknown cmux method: surface.sendText" (HTTP 500
  `build_workspace_failed`).
- New `normalizeSurfaceRow` resolves the handle from
  `ref ?? surface_ref ?? surface_id ?? id`, normalizing every
  row regardless of array key (`panels` / `pane_surfaces` /
  `surfaces`).
- One resolution order serves both versions — no
  version-negotiation shim. Mirrors the existing
  `normalizeWorkspaceRow` and create/split handle patterns.

### `rig archive` Affordance (slice 19)

New top-level commands and a non-destructive archive lifecycle:

```
rig archive <rigId> [--force] [--json]
rig unarchive <rigId> [--json]
```

- **Non-destructive**: rig row preserved; `archived_at` set;
  `rig.archived` event fires. `unarchive` clears `archived_at`
  and fires `rig.unarchived`.
- **Default reads exclude archived**: `rig ps`,
  `/api/rigs/summary`, `/api/rigs`, `/api/ps`. Opt-in via
  `rig ps --include-archived` / `?includeArchived=true` /
  `?archived=only`. `rig ps` marks archived rows with `*` and
  renders a legend; the flag propagates through cross-host argv.
- **`rig up` archived-name refusal (AC-7)**: a name matching ONLY
  an archived rig is refused with a 3-part error pointing at
  `rig unarchive`; `--json` emits `rig_archived`. Never silently
  restores.
- **`--force` on archive**: required when a rig is running or
  degraded; surfaces a 3-part fact / consequence / action error
  without it (AC-6).
- **UI**: lazy collapsible "Archive" section under the localhost
  host node, fed by `useArchivedRigs` (separate query against
  `/api/rigs/summary?archived=only`), not by client-side
  filtering. `rig.archived` / `rig.unarchived` events drive
  global query invalidation (`["rigs","summary"]` +
  `["rigs","summary","archived"]` + `["ps"]` + `["nodes", rigId]`
  when present) so a CLI archive reactively refreshes other
  mounted UIs.
- **Migration `042_rig_archive`**: `ALTER TABLE rigs ADD COLUMN
  archived_at TEXT` + `idx_rigs_archived`. Append-only; mirrors
  the `023_stream_items` precedent.

### `rig add` / `rig add-member` (slice 24)

New top-level command for the `add_member` converge op:

```
rig add <rigId> <podNamespace> <member-fragment-path> \
    [--json] [--rig-root <root>]
```

- **Member fragment**: YAML or JSON; tolerates a bare member or a
  `{ member }` wrapper; uses the spec snake_case field names
  (`id`, `runtime`, `agent_ref`, `profile`, `cwd`, ...).
- **Daemon route**:
  `POST /api/rigs/:rigId/pods/:podNamespace/members`. Outcome ->
  HTTP: `rig_not_found` / `pod_not_found` -> 404,
  `member_conflict` -> 409, `validation_failed` /
  `preflight_failed` -> 400, success -> 201. Per-node launch
  status (`launched` / `failed` / `attention_required`) rides in
  the 201 body.
- **MCP tool**: `rig_add` ships in lockstep.
- **Honest edge validation**: non-array `edges` is REJECTED
  (CLI prints error + exits 1; route returns 400
  `validation_failed`; domain returns `validation_failed` as
  defense in depth). Edge `kind` is validated against the
  canonical `VALID_EDGE_KINDS` set exported from
  `rigspec-schema.ts` and reused (not duplicated). Edges still
  carry NO runtime behavior (the edge-runtime fence holds).
- **Built on the topology-converge spine**: `Op` union + differ +
  `convergeOp` scaffold (AC-6); `rig add` is imperative CLI
  sugar over the converge interface, not a bypass.

### `rig down` Accepts Name-or-Id (slice 22)

`rig down <name>` now works:

- `/api/rigs/summary?includeArchived=true` is fetched; id-match
  across ALL rigs (archived ids still reach teardown);
  name-match ACTIVE rigs only.
- Same-name active+archived pair resolves the ACTIVE rig (not
  ambiguous).
- Archived-only name does not resolve by name (use the id, or
  `rig unarchive` first).
- The packaged `openrig-user` skill is corrected across specs
  source + assets/plugins copy + `_canonical` mirror; the
  `down.ts` resolver comment is corrected. The historical v0.3.1
  and v0.3.2 CHANGELOG entries and release notes are left intact
  (the bug genuinely existed at those releases).

### Honest Codex Restore Gate (slice 21 FR-2)

`verifyResumeLaunch` no longer returns `ok:true` unless the
native-resume-probe proves the seat actually resumed:

- **Unresolved operator-action gates** (update that cannot
  auto-dismiss, trust, model-selection) and a bounded poll that
  never reaches `resumed` return `ok:false` with
  `recovery: attention_required` plus last-12-line pane evidence.
- **Routes into existing projection**: `HarnessLaunchResult` ->
  startup-orchestrator `startupStatus: attention_required` ->
  `ps` / `status` projection. Same path the Codex auth-refusal
  case already shipped; no new state machinery.
- **Auto-dismiss preserved**: a skippable update gate still
  auto-dismisses and continues to success; only UNRESOLVED gates
  fail loudly. The readiness loop (`checkReady`) stays the
  SECOND check that upgrades the seat to `ready` once it
  genuinely reaches the TUI.
- **Carry-forward**: FR-1 (native Codex session-id hook) scope-
  tipped to 0.4.0 after build-time forensic; FR-2 ships alone in
  0.3.3.

### `rig send --verify` Honest Delivery Outcomes (slice 99.0.6.3)

The three outcomes are now named in the response:

- **`delivered`**: `ok:true` + post-capture re-confirmed the
  snippet (the prior `Verified: yes`).
- **`rendered-unconfirmed`**: text + Enter both succeeded but
  the capture could not re-confirm (redraw race, or the capture
  threw). LANDED, NOT failure. Exit stays clean.
- **`failed`**: the transport itself failed (`send_failed` /
  `submit_failed` carry `outcome: "failed"`; HTTP mapping
  unchanged).

The legacy `Verified: yes/no` line is preserved verbatim
(parsers); a new `Delivery:` line carries the named outcome plus,
for `rendered-unconfirmed`, a `rig capture <session>`
confirmation pointer. `--json` carries `outcome` through.
Mid-work / wait-for-idle REFUSALS deliberately carry no outcome
(nothing was sent).

### `rig whoami` Peers Contract (slice 99.0.6.1)

`peers[]` is this rig's roster EXCLUDING self. It is NOT a
directionally-edged subset, and it is NOT host inventory.

- **`WhoamiResult.peersNote`** (required string, additive)
  carries the contract in-band, naming the three pointers:
  `peers[]` (roster), `edges{}` (directional graph),
  `rig ps --nodes` (inventory including self + live state).
- **CLI Peers header**: keeps the literal `Peers:` prefix
  verbatim (shipped parsers grep on it), then adds the
  in-band clarifier.
- **No new field**: `peers[]` name and shape are unchanged; no
  `roster` / `podRoster` field is added (peers[] already IS the
  roster).

### Workflow Instantiate By Name (slice 04.1)

`rig workflow instantiate <built-in-name>` (e.g. `conveyor`,
`basic-loop`) now resolves end-to-end:

- `WorkflowRuntime.instantiate` resolves the identifier against
  the seeded spec cache BY NAME first via the new
  `WorkflowSpecCache.resolveSourcePathByName`, falling back to
  literal-sourcePath only when no named spec matches.
- The cache returns the STORED path verbatim — no source-tree
  re-derivation — so the `dist/builtins` production layout
  stays safe.
- Diagnostic rows are excluded via `version != ''` (valid specs
  always carry a version) so resolution needs no dependency on
  the slice-11 status column / migration.

### Guided Golden Path State Clarity (slice 04.2)

The new-operator golden path now points at the correct discovery
verb:

- `rig workflow specs` lists built-in / seeded workflow specs
  (`(built-in)` tagged). USE THIS to discover names before
  `rig workflow instantiate <name>`.
- `rig workflow list` lists workflow INSTANCES; empty for a
  fresh operator.

Corrected in `docs/reference/getting-started.md` and in the
CLI's `setup` golden-path text (`goldenPathNextSteps()` step 4).

### For-You Manage-By-Exception (slice 20)

Feed-interaction UX on existing signals only (the 0.4.0
attention-detection layer is untouched):

- **Drill-to-terminal**: new `FeedCardTerminalDrill` in the card
  footer opens the resolved source/author session's terminal
  PREVIEW via `GET /api/sessions/:sessionName/preview`,
  reusing `TerminalPreviewPopover` over the same
  externally-owned-trigger event contract `TopologyTerminalView`
  uses. Session-NAME keyed ONLY. Honest framing — "terminal
  preview" / "captured snapshot, not live"; disabled with an
  honest title when no session resolves.
- **Decision-band sort**: `feed-classifier` exports
  `sortFeedByDecisionBand` — a stable two-band partition
  (action-required + approval above progress / observation /
  shipped) using the existing newest-first comparator within
  each band. Applied at the single `Feed.tsx` merge-consumption
  seam. Not a ranking engine.
- **One-click approve (approve-only)**: `VerbActions` gains an
  additive `oneClickVerbs` prop. APPROVE submits directly on
  click; deny/route stay select+confirm. Defense in depth:
  prop type narrowed to
  `Array<Extract<MissionControlVerb, "approve">>` so misuse is a
  compile error, and a runtime `ONE_CLICK_SAFE_VERBS = {"approve"}`
  allowlist rejects cast-forced `"deny"` / `"route"`. Reuses the
  same `performSubmit` path (identical optimistic receipt and
  held-error behavior).

### CLI Release-Surface Parser (slice 13.1)

Deterministic TypeScript Compiler API extractor that walks
Commander registrations in `packages/cli/src/commands/*.ts` at
two git refs and emits a structured release-surface-diff:

- Resolves both Commander idioms (chained inline subcommands
  and factory indirection through `addCommand(buildChildCommand())`).
- Emits the REGISTRATION name (`rig-policy.ts` surfaces as
  `policy`); option name-tokens taken from `.option()` arg[0]
  only so template-literal descriptions never drop an option.
- Reads batched via one `git cat-file --batch` per ref (fast,
  offline, deterministic).
- 3-part honest failure shape; never a silent empty diff.
- NOT registered as a `rig` verb at 0.3.3 — the module is
  product code with hermetic test fixtures (including a
  v0.3.1..v0.3.2 worked example checked in at
  `src/release-surface/release-surface-diff.v0.3.1-v0.3.2.yaml`).

### Skill <-> CLI-Surface Binding Index (slice 13.2)

Deterministic offline lookup that joins a release surface-diff
to "which skills are affected by this release":

- Composes with the slice 13.1 parser; invocation-agnostic.
- Implements the ratified join grammar: component-wise prefix
  match in either direction (so `up` does not match `update`);
  conservative over-include bias for the no-false-negative floor.
- Drops `--version` from the binding index (the canonical grammar
  is command paths only, not global flags); the skill body still
  documents `rig --version` as prose.
- Ships with the v0.3.2-affected-skills regression fixture
  derived from the corpus.

### Known Limitations / 0.3.4+ Deferrals

- **Slice-21 FR-1 (native Codex session-id hook)**: scope-tipped
  to 0.4.0 after build-time forensic.
- **Slice-13 component 3 (auto-rollout dispatcher)**: skill-layer
  landing for this release; product-code dispatcher / invocation
  is intentionally out of the shipped runtime bundle. 13.1
  parser + 13.2 binding index ARE shipped product code.
- **Slice-05 sub-scopes carried forward**: agent / port /
  managed-app collision detection (Item 4.3); broader install-
  into-existing-rig pathway acceptance (Item 4.4);
  `--target-name` CLI flag for install-time rig-name overrides.
- **Slice-21 FR-4(d) accepted-queue-state schema**: deferred from
  0.3.2; carried forward.
- **Onboarding journey + battle-hardening**: slices 04
  (new-user-journey), 08 (hooks-elite), 10 (rig-self), 11
  (personal-rig) carried forward to a later release.
- **Workspace symlink alignment**: daemon-side workspace-resolver
  alignment with operator symlinked workspace roots remains a
  follow-up; non-blocking for 0.3.3.
- **Slice-13 permission-block-routing-architecture remains held**:
  big-green-light gated by operator review; `rigx-experimental`
  only; not split-deferred (stays held).
- **`rig view list/show --json` flag inconsistency** — wrapper-
  layer routing path remains; the daemon's `view show <name>`
  route returns JSON correctly when invoked directly.
  Workaround: human-readable output for now.

### Quick Verification Commands

```bash
# Confirm CLI version after the release-manager version bump
rig --version

# Confirm daemon starts and migration 042 applies
rig daemon start

# Confirm rig archive surface is wired
rig archive --help
rig unarchive --help

# Confirm rig add surface is wired
rig add --help

# Confirm rig down accepts name-or-id
rig down --help

# Confirm rig workflow specs lists built-ins
rig workflow specs

# Confirm rig send --verify carries the delivery outcome
rig send --help | grep -i verify

# Confirm rig whoami peers contract is stated in-band
rig whoami --json | jq '.peersNote'
```

---

## [0.3.2] - 2026-06-02

**Status**: released. npm `@openrig/cli@0.3.2` (latest); GitHub Release
`v0.3.2`; git tag `v0.3.2`.

### Summary For Installing Agents

- **Package version**: package metadata bumped at release-manager step; CLI
  reports the new version after `npm publish`.
- **Migrations**: one new migration in 0.3.2 — `041_rig_policy`
  (`CREATE TABLE` for the operator-context-mode bindings store; no impact
  on existing data; binding rows are operator-authored at runtime).
  Existing databases upgrade by running `rig daemon start`.
- **Node engines**: unchanged from 0.3.1 (CLI accepts Node `>=20`).
- **Backward compatibility**: existing CLI argument shapes, daemon route
  paths, RigSpec/AgentSpec schemas, and persisted settings remain backward
  compatible. New routes are additive. New CLI commands (`rig policy`,
  `rig scope`, `rig workspace doctor`) are additive. New `rig queue create`
  flags (`--body-file`, `--mission`, `--slice`) are additive.

### Rigbundles First-Class

`rig bundle` ships cross-primitive bundling end-to-end:

- **Five content kinds routed**: skills + plugins (hybrid) +
  workflow_specs + context_packs + agent_images. Each kind lands in
  its canonical library under `$OPENRIG_HOME`; consumer-scan
  visibility preserved.
- **`bundle.yaml` author manifests** auto-detected when present.
  Vendoring uses both-sides path containment + symlink-escape
  protection + integrity hashing in the manifest.
- **`rig bundle create` new flags**: `--notes <text>`,
  `--min-daemon-version <ver>`, `--min-cli-version <ver>` — operator
  notes captured in bundle provenance metadata; min-version gates
  power the install-time compatibility check.
- **`rig bundle install` new flags**: `--skip-version-check` (operator-
  explicit override of the install-time compatibility check),
  `--force` (operator-explicit override of the install-time conflict
  check). NOT recommended for routine use; provided for known-good
  operator scenarios.
- **`rig bundle history`** — new subcommand reading
  `~/.openrig/bundle-audit.jsonl` with optional `--rig` /
  `--since` filters.
- **Install timeout bumped** — the prior 5-second cap was too short
  for tmux-session-bootstrapping installs.

### Workspace + Workflow GA

Operator-facing surface hardened:

- **`rig workspace validate --max-files`** — strict-int regex enforced;
  out-of-range values produce a 3-part error before `client.post`.
- **`rig workflow project --exit`** — enum guard against
  `handoff | waiting | done | failed`.
- **14 new discriminator tests** on validator paths.

### `rig up <starter>` Paper-Cut Fix-Round

Four bounded fixes unblocking the homepage quick-start on fresh
0.3.1→0.3.2 installs:

- **HTTP 4xx surface for pre-launch failures**: `cycle_error`,
  `preflight_failed`, `validation_failed`, `service_boot_failed` —
  replaces bare 500.
- **No orphan rig record on pre-launch failure**: instantiator
  re-ordered + rollback path + compose teardown order tightened.
- **Path-form `rig up <install-internal-spec>` defaults cwd**: closes
  the divergence between path-form and bare-form invocation; library
  specs now match path-form behavior.
- **`walkYamlFiles` skip standard noise dirs**: `.worktrees`,
  `node_modules`, `.git`, `dist`, `.turbo`, `.next`. Plus stale
  `workflow_specs` rows prune at startup with an install-root
  preservation guard (shipped built-in specs survive the prune).

### Coordination + First-User Setup Fix-Round (slice 21)

Five bounded follow-rounds:

- **FR-1 — Coordination-model boot instinct**: `rig send` vs
  `rig queue` vs `rig queue handoff` + §1b doctrine surfaced in
  `core/openrig-user/SKILL.md`.
- **FR-2 — First-user workspace + workflow setup teaching**: skill
  + docs content for the path from fresh install to first
  workflow_spec authoring.
- **FR-3 — MISSION_NOTES durable-pattern hardening**: convention
  codemap + auto-scaffold via `rig scope mission create` (uses
  `conventions/mission-notes/TEMPLATE.md`); `--no-mission-notes`
  opts out.
- **FR-4 — Queue ergonomics**:
  - `rig queue create --body-file <path>` (use `-` for stdin) kills
    the backtick-shell-corruption class for multiline bodies.
    Mutually exclusive with `--body`.
  - First-class `--mission <id>` / `--slice <id>` flags translate
    to `mission:<id>` / `slice:<id>` tags (compose with `--tags`).
  - `lastNudgeResult` wording fix; closure-vs-acceptance docs.
- **FR-5 — `rig workspace doctor`**: 7-check workspace-readiness
  diagnostic (workspace root, missions folder, file allowlist,
  daemon alignment, daemon reload, optional slice docs,
  MISSION_NOTES presence). Default exit-code: non-zero only on
  `fail`; `--strict` makes warn-or-fail non-zero. CLI overlays
  `OPENRIG_FILES_ALLOWLIST` from operator's shell env.

### Daemon Test Substrate-Path Scrub (slice 14)

Internal-team substrate path shape scrubbed from 4 daemon source
sites + 10 test files. Hook-constants de-duplicated. Privacy class
closed for tracked source + test surface.

### ConceptCard Data Source (slice 17)

`ConceptCard` wired to shaped backlog candidates; storytelling-adapter
completion deferred from 0.3.1 is now complete.

### For-You Priority Windowing (slice 20)

Server-side attention query (Option 3): SQL predicate pushdown +
exact-match attention regex + dismissal as string-keyed for
queue-derived cards.

### Operator Context-Mode Bindings (slice 09)

New `rig policy` command surface paired with daemon-side typed-primitive
store (migration `041_rig_policy`):

- **Six modes**: `sleep | desk | mobile | away | focus | debug`.
- **Four scopes**: `global_host | rig | workstream | qitem`.
- **Restate-and-confirm posture (HG-4)**: `set` is restate-only
  until `--confirm` is passed; scripts cannot silently apply a
  binding.
- **`--qualifier` strict reject for `global_host` (HG-7 guard
  finding)**: operators who type `--scope global_host --qualifier
  <id>` get an error and the daemon is never contacted.
- **Operator-edit verbs require bearer token**: `set --confirm`
  and `unset` require `--bearer <token>` (or
  `OPENRIG_AUTH_BEARER_TOKEN` env).
- **6 subcommands**: `set`, `show`, `effective`, `cite`, `unset`,
  `defaults`.

### Scope Tree Primitive (slice 12)

New `rig scope` command for operating the substrate scope tree
(missions, slices, sub-slices) per
`conventions/scope-and-versioning`:

- **Mission tier**: `ls`, `show`, `create` (auto-mints stable
  dot-IDs into mission frontmatter; auto-scaffolds MISSION_NOTES
  by default; `--template` auto-selects `release` when name matches
  `release-X.Y.Z`).
- **Slice tier**: `ls`, `show`, `create`, `ship`, `close`, `move`.
- **Templates ship under `dist/lib/scope-templates/`**: `release-
  feature`, `placeholder`, `mission-notes`, `bug-fix`,
  `research`, `backlog-deprecation`, `backlog-tech-debt`,
  `mission-placeholder`, `mission-release`.
- **Top-level option `--workspace <path>`** overrides workspace
  root (otherwise inferred from cwd or `$OPENRIG_WORK_ROOT`).

### Known Limitations / 0.3.3 Deferrals

- **Slice-05 Item-3 sub-scopes deferred to 0.3.3**: agent/port/managed-app
  collision detection (Item 4.3); broader install-into-existing-rig
  pathway acceptance (Item 4.4); the `--target-name` CLI flag.
  Design-contingent on the CLI surface decision.
- **Slice-21 FR-4(d) accepted-queue-state schema deferred to 0.3.3**:
  the new `accepted` queue state is a schema model change; carried
  forward per the release-triage philosophy.
- **Onboarding journey + battle-hardening deferred to 0.3.3**: slices
  04 (new-user-journey), 08 (hooks-elite), 10 (rig-self), 11
  (personal-rig) physically moved to the `release-0.3.3` mission tree.
- **Workspace symlink alignment**: daemon-side workspace-resolver
  alignment with operator symlinked workspace roots is a follow-up
  from slice-21 FR-5 QA; non-blocking for 0.3.2.
- **Slice-13 permission-block-routing-architecture remains held**:
  big-green-light gated by operator review; `rigx-experimental` only;
  not split-deferred to 0.3.3 (stays held).
- **`rig down <name>` still returns HTTP 404** at v0.3.2; use
  `rig down <rigId> --delete` instead.
- **`rig view list/show --json` flag inconsistency** — wrapper-layer
  routing path remains; daemon's `view show <name>` route returns
  JSON correctly when invoked directly. Workaround: human-readable
  output for now.

---

## [0.3.1] - 2026-05-15

**Status**: released. npm `@openrig/cli@0.3.1` (latest); GitHub Release
`v0.3.1`; git tag `v0.3.1`.

### Summary For Installing Agents

- **Package version**: package metadata bumped at release-manager step; CLI
  reports the new version after `npm publish`.
- **Migrations**: no schema-breaking migrations in 0.3.1. Existing databases
  upgrade by running `rig daemon start`.
- **Node engines**: unchanged from 0.3.0 (CLI accepts Node `>=20`).
- **Backward compatibility**: existing CLI argument shapes, daemon route
  paths, RigSpec/AgentSpec schemas, and persisted settings remain backward
  compatible. New routes are additive. New ConfigStore keys are opt-in
  default-off.

### Claude Auto-Compaction Policy

The headline 0.3.1 feature: operator-configurable Claude session
auto-compaction with safe defaults.

- **Opt-in default-off**: with no policy configured, no behavior change. The
  daemon never sends an auto-`/compact` until the operator explicitly enables
  the policy.
- **7 new ConfigStore keys** in the `policies.claude_compaction.*` namespace
  (lockstep across CLI VALID_KEYS + daemon SETTINGS_VALID_KEYS): `enabled`,
  `threshold_percent` (strict integer 1-100), `compact_instruction` (default
  empty; appended to `/compact` slash-command args when set),
  `message_inline`, `message_file_path`, `pre_compact_instruction`,
  `post_restore_audit_instruction`. Strict validation across all source
  layers (`set/POST/env/file`) — invalid env values fall back to defaults
  with a warning to stderr rather than silently coercing.
- **5 operator-editable prompt surfaces** rendered in the
  Settings → Policies UI form: pre-compaction prep, compact instruction,
  post-compaction restore (inline), restore file path, post-restore audit.
  Daemon-owned wrappers (usage/threshold framing, trust-channel preservation,
  marker paths, read-depth enforcement, turn-boundary handshake, dedup +
  cooldown) are non-editable.
- **6-stage daemon-to-LLM lifecycle**:
  1. Pre-compact prep prompt — full-context Claude writes a mental-model
     restore map (annotated ASCII file/folder tree) before compaction
     ("save game before quit").
  2. `/compact` with operator instructions + trust-channel preservation
     embedded in args.
  3. Post-compact turn-boundary handshake — non-restorative acknowledgment
     creates an assistant-turn boundary so the subsequent restore prompt
     lands in the correct trust context.
  4. Restore prompt — explicit user-request shape; defense-in-depth
     fallback chain (marker → JSONL transcript path → session-id → generic).
  5. Compliance prompt — forces FULL/PARTIAL/NOT_READ read-depth audit
     table; counters Claude's deferred-execution + token-conservation
     instincts.
  6. Cooldown (10-minute default) — prevents re-fire while restore work
     is still consuming context.
- **PreCompact hook + SessionStart/UserPromptSubmit bridge**: the openrig-core
  plugin ships a marker-bridge that picks up pending-restore markers
  post-compaction and injects restore directives once. Templates live in
  the `claude-compaction-restore` skill and ship with the plugin.
- **Safety hardening**: SessionTransport classifies typed prompt drafts as
  attention state — auto-`/compact` retries later instead of overwriting
  human input. Send-failure does not advance dedup state (transient retry).
  Re-arm requires threshold-crossing (session must drop below threshold
  before next auto-compact).

### Library Explorer Finishing

The Library destination (skills + plugins + specs) became a fully
operator-facing surface:

- **No duplicate top-level entries**: `> SKILLS` and `> PLUGINS` rows
  removed from the top of `SpecsTreeView`. Bottom-row clicks now do
  dual-action (navigate to the matching index page + expand the tree).
- **Reorder**: Plugins above Skills.
- **OpenRig-managed skills discovery**: 32 shared skills now visible in
  the tree + on `/specs/skills` index. Previously the workspace-relative
  path lookup returned empty in production VM environments.
- **Daemon-owned library discovery API** (new):
  - `GET /api/skills/library` → consolidated `LibrarySkillPublic[]`
    (workspace + openrig-managed sources; absolute paths not leaked).
  - `GET /api/skills/:id/files/list?path=<rel>` + `/api/skills/:id/files/read?path=<rel>` —
    skill folder browse + content read.
  - `GET /api/plugins/:id/files/list?path=<rel>` + `/api/plugins/:id/files/read?path=<rel>` —
    plugin folder browse + content read.
  - `PluginEntry.skillCount` field added to plugin discovery
    serialization.
- **Real file-browser docs-browser on plugin and skill detail pages**:
  detail pages mount a `DirectoryTree` + `FileContentPanel` against the
  real plugin/skill folder. Markdown auto-renders; non-markdown files
  (e.g. `.ts`, `.json`) render as text. Folder navigation works (entering
  subfolders + listing files).
- **Rolled-up index pages**: `/specs/skills` lists all skills as flat rows
  with source label + file count + entry link. `/specs/plugins` lists all
  plugins as rows with version + runtimes + skill-count + entry link.

### Plugin Primitive v0

- **Plugin discovery**: vendored plugins under `$OPENRIG_HOME/plugins/`
  (default `~/.openrig/plugins/`) are discovered, validated, and
  surfaced through `rig plugin list` + `/api/plugins`.
- **Plugin install (v0)**: explicit operator copy or symlink to
  `$OPENRIG_HOME/plugins/<plugin-id>/`. A `rig plugin install
  <substrate-path>` verb is deferred to 0.3.2; see `OPENRIG-INSTALL.md`
  inside each plugin's source for the documented copy/symlink workflow.
- **CLI**: `rig plugin list` / `show` / `used-by` / `validate` subcommands
  available. No `install` subcommand at v0.
- **Plugins shipped as substrate references** (for plugin authors to
  copy-install): `gstack` (45 skills), `obra-superpowers` (14 skills).
  `openrig-core` ships bundled with the daemon (11 skills).

### Settings Destination Explorer

Settings became a 4-item Explorer destination matching Topology /
Project / Library / For-You pattern:

- `/settings` (general config keys form), `/settings/policies`,
  `/settings/log`, `/settings/status`.
- Old top-row tab nav removed.
- Shared `SettingsPageShell` chrome across all 4 sub-routes.
- Policies page is the home for the Claude auto-compaction policy form
  (see above).

### CMUX Launcher

- **Launch in CMUX button** on the rig-scope topology tab-bar trailing
  slot. Opens a cmux workspace for the rig with appropriate title +
  cwd parameters. Powered by new daemon route + cmux adapter
  extensions.

### Node-Page Overview + Details

- **Seat overview table** consolidated as 7-column horizontal layout with
  vertical grid lines (Claude/Codex agent + status + context + tokens +
  uptime + cwd + current-work).
- **Tab consolidation** + activity alignment on the node-detail surface.
- **Alert-only notification banner** (renders only on real-alert states:
  `failed`, `attention_required`, or `latestError !== null`); generic
  `recoveryGuidance` no longer triggers a banner on every seat.
- **cwd / current-work separation**: factored into a `SeatOverviewSecondary`
  primitive below the column table.

### Mobile Drawer Behavior

The Explorer drawer at 375px viewports now layers above the mobile rail
tray for Settings / Project / Library / For-You destinations
(previously hidden behind rail-tray; visible click path didn't register
on Explorer items). Topology mobile drawer is intentionally hidden in
0.3.1 (clicking the hamburger triggered a pre-existing
TopologyTableView renderer cascade); the topology mobile drawer is
scheduled for full restoration in 0.3.2 via a dedicated
TopologyTableView render-path slice.

### Dashboard And For You Visual Refresh

The Dashboard (`/`) and For You (`/for-you`) destinations got a coordinated
visual refresh to a "vellum" surface language — translucent stone-tinted
cards over a paper-grid background, ambient multi-stop shadow, mono+dot
kind indicators, and L-shaped corner-bracket registration marks. The
chrome vocabulary is consistent across destination cards (Dashboard) and
both feed-card systems (For You).

- **Dashboard** — full rewrite of `/` into a thin composition over new
  `dashboard/vellum/` primitives (`BackVellumSheet`, `MidLayerContent`,
  `TopLayerContent`, `DestinationsLayer`, `VellumDestinationCard`,
  `CornerBracket`, `graphics.tsx`, `marks.tsx`). Hero typography ("WELCOME
  BACK") at display-lg + headline-bold; tactical instrument-panel stats
  line with tabular numerals and a success-token active count. Six
  destination cards (Topology / Project / For You / Library / Search /
  Settings) share the same numeral-layout treatment. Real-data hooks
  thread through (`useRigSummary`, `usePsEntries`, `useSpecLibrary`,
  `window.location.hostname`).
- **For You** — both card systems unified to the same vellum recipe:
  - Storytelling band: `CardShell` rewritten to bg-stone-100/45 +
    backdrop-blur-[10px] + ambient shadow + corner brackets; design-token
    leading dots replace prior bg-emerald-50 / bg-amber-50 / etc.
    off-brand utilities. Title at 16px headline-bold; body at 12px.
  - Queue-item `FeedCard.tsx`: same outer chrome; `KIND_DOT` + `TONE_DOT`
    design-token maps; vellum bordered-no-fill action buttons
    (Approve/Deny/Route/Hold/Drop/Annotate/Handoff) with hover-invert and
    44px touch targets; `TONE_RECEIPT` strip is a subtle bg-stone-50/40
    with a leading colored dot.
- **Single source of truth** — `/dashboard` and `/lab/vellum-lab` both
  import from `packages/ui/src/components/dashboard/vellum/index.js`.
  Future visual changes hit one location.
- **Lab routes** — `/lab/card-previews`, `/lab/vellum-lab`,
  `/lab/vellum-bg/{a-large,b-small,c-allover}` are checked-in experiment
  surfaces for designer iteration. Reachable in production by direct URL;
  not linked from main nav. Useful when iterating on the visual system.

### For You Storytelling Adapter

The storytelling band (top of `/for-you`) now wires four card kinds to
real data:

- **Progress** — from `useMissionDiscovery` (first 2 active missions)
- **Shipped** — from `useSlices` (status = shipped/complete/done; capped at 3)
- **Incident** — from `useSlices` (status = blocked/failed/danger or fallback "info"; capped at 3)
- **Approval** — from `useActivityFeed` + `classifyFeed` (kind === "approval";
  capped at 2; qitemId extracted from event payload with snake_case alt
  and `FeedCard.id` fallback). Surfaces real queue items waiting on
  approval in a high-visibility band.

`ConceptCard` component is preserved in source but not emitted by the
production adapter — a deliberate data-source decision is scheduled for
0.3.2.

### Action Outcome And Inline Error Surface

Queue-item action buttons (`VerbActions` — Approve/Deny/Route/Hold/Drop/
Annotate/Handoff) now render outcomes immediately and surface failures
without silently reverting:

- **Optimistic outcome** — on mutation success, the
  `ActionOutcomePanel` ("Approved by X" / "Routed by X to Y") renders
  immediately. Audit-log roundtrip reconciles in background. Operator
  no longer waits for a query refetch to see what happened.
- **Inline error surface** — on mutation error, a tertiary-bordered
  error block renders below the verb buttons with the daemon's error
  message; verb-selection state is preserved so the operator can
  correct and retry. Replaces the prior silent-revert UX where errors
  were never displayed.
- **React-query callback discipline** — `submit()` split into separate
  `onSuccess` (optimistic outcome + reset selection) and `onError`
  (set error message; do NOT reset). Regression test guards the
  silent-revert class explicitly.

### Vendored Skill Provenance

Vendored skills shipped in `packages/daemon/specs/agents/shared/skills/`
now declare their upstream lineage via `metadata.openrig` frontmatter
and (when modifications exist) a companion `OPENRIG.md` sidecar:

- **vendoring_pattern**: `vendored-as-is` | `modify-the-file` |
  `add-supplementary-files`
- **vendored_from**: upstream source identifier
- **last_upstream_check**: most recent diff date
- **divergence_notes**: human-readable summary of OpenRig-specific changes

Applied to all 10 process-skill surfaces (agent-browser, executing-plans,
brainstorming, systematic-debugging, test-driven-development,
using-superpowers, verification-before-completion, writing-plans,
frontend-design, dogfood). `OPENRIG.md` sidecars added where the file
has been modified or supplemented (agent-browser + executing-plans +
brainstorming + using-superpowers + writing-plans). Convention is
documented in the `writing-skills-for-openrig` skill.

### Plugins And Skills On The VM (Operator Note)

Operators dogfood-testing 0.3.1 should expect:

- **Stock VM install**: only `openrig-core` plugin is bundled. The
  `/specs/plugins` UI list will show one plugin until the operator
  installs additional plugins per the v0 copy workflow.
- **Skills**: 32 OpenRig-managed shared skills ship under
  `packages/daemon/specs/agents/shared/skills/` (discovered via the
  daemon skill-library API; no operator action required).
- **User-installed skills**: skills the operator installs under
  `~/.openrig/skills/` or the workspace `.openrig/skills/` directory
  surface in the same list.

### Config + Settings

Continues from 0.3.0 with the slice 08 validation pass:

- `rig config get/set/reset/list` remains the canonical CLI surface.
- Lockstep CLI `VALID_KEYS` + daemon `SETTINGS_VALID_KEYS` byte-identical
  sets (verified in slice 08).
- Help-drift CI gate from slice 08 honored across all new keys added in
  0.3.1.

### SC-29 Exceptions

The SC-29 exception process tracks explicit scope expansions to release
contracts. Exceptions declared in 0.3.1:

- **#10 (slice 24)**: cmux launcher — `POST /api/rigs/:rigId/cmux/launch`
  + CmuxLayoutService + 4 CmuxAdapter RPC methods.
- **#10 (slice 27, numbering collision)**: Claude auto-compaction policy
  — 7 `policies.claude_compaction.*` ConfigStore keys. (Numbering
  collision with #10 above is a process-only inconsistency; both code
  scopes are correctly merged. Canonical `SC29-LEDGER.md` and ledger
  hygiene scheduled for 0.3.2.)
- **#11 (slice 28)**: Library Explorer daemon API — 5 new daemon GET
  endpoints (`/api/skills/library`, `/api/skills/:id/files/list`,
  `/api/skills/:id/files/read`, `/api/plugins/:id/files/list`,
  `/api/plugins/:id/files/read`) + 2 response shape additions
  (`PluginEntry.skillCount`, `LibrarySkillPublic`).

### Known Carry-Forwards (0.3.2 Candidates)

- **`rig plugin install <substrate-path>` verb**: explicitly deferred.
  Documented copy/symlink workflow is the v0 install path.
- **Topology mobile drawer**: hidden in 0.3.1 to avoid a pre-existing
  TopologyTableView renderer cascade at 375px viewports. Full
  restoration scheduled for 0.3.2 via dedicated render-path slice.
- **Plugin source-label taxonomy**: copy-installed plugins currently
  land in the `vendored` source kind; UI label says "No user-installed
  plugins" while listing them. Taxonomy refinement scheduled for 0.3.2.
- **`SC29-LEDGER.md`**: canonical SC-29 numbering ledger document.
  Authors currently self-assign exception numbers; documented ledger
  prevents collisions like the slice 24/27 #10.
- **VM PreCompact hook installer**: the documented install path for the
  `claude-compaction-restore` skill is operator-manual at v0; an
  automated installer is a 0.3.2 candidate.
- **`docs/DESIGN.md` docs-guard violation**: pre-existing
  `npm run test:repo` failure; tracked doc outside allowed paths;
  cleanup scheduled for 0.3.2 documentation hygiene pass.
- **Environment-dependent tests**: a small number of vitest suites fail
  on developer hosts due to port-conflicts (preflight) or live host
  Claude hook state (restore-check); focused-test gates pass these
  suites; cumulative-workspace runs surface the gaps. Isolation cleanup
  scheduled for 0.3.2.
- **Cross-daemon route awareness**: the VerbActions destination dropdown
  on `/for-you` currently lists session names without checking whether
  the local daemon can reach them. Routing to a non-local destination
  surfaces as an inline error (per the new error surface above) but the
  dropdown should ideally filter to local-daemon seats. 0.3.2 candidate.
- **ConceptCard data source**: `ConceptCard` component is preserved in
  source but not wired in the production adapter. A 0.3.2 slice will
  pick a deliberate data source (likely shaped backlog candidates or
  early-stage discovery items).
- **Warm error messages on demo surfaces**: daemon error strings (e.g.,
  "queue item not found") surface verbatim through the inline error
  surface. Demo-grade polish to humanize these on user-facing surfaces
  is scheduled for 0.3.2.

### Banked Discipline Patterns

0.3.1 surfaced a number of canonical agent-software-design patterns
during the Claude compaction iteration cycle and Library Explorer
finishing work. These are banked in operator-skill documentation for
agent-prompt design + daemon-to-LLM trust establishment:

- **Channel model**: normal user message is the only authorized action
  surface; hook stdout is informational-only; `/compact` args carry
  trust contracts that the post-compact prompt invokes.
- **Turn-boundary handshake**: when a daemon-driven action request
  would land too adjacent to local-command output, insert a
  non-committing acknowledgment message first to create an
  assistant-turn boundary.
- **Save-game-before-quit pattern**: full-context agent writes
  restoration breadcrumb before forced context loss; context-loss
  agent reads it on restore.
- **Structured-output forces completeness**: ask LLMs for explicit
  FULL/PARTIAL/NOT_READ accounting when thoroughness matters; counters
  token-conservation instincts.
- **Daemon-owned shared-resource discovery**: skill/plugin discovery
  belongs at the daemon layer with HTTP endpoint surfaces; UI consumes
  via typed API. Avoids workspace-cwd-relative path-resolution
  brittleness.

### Quick Verification Commands

```bash
# Confirm CLI version after the release-manager version bump
rig --version

# Confirm daemon starts cleanly
rig daemon start

# Confirm new Claude compaction policy keys are visible
rig config list | grep policies.claude_compaction

# Confirm plugins discoverable
rig plugin list

# Confirm skills discoverable
curl -s http://localhost:7433/api/skills/library | jq 'length'
```

---

## [0.3.0] - 2026-05-10

**Status**: release candidate for public publish. This entry documents the
changes since `0.2.0`.

### Summary For Installing Agents

- **Package version**: package metadata is still `0.2.0` until the release
  manager performs the final version bump. The release contents documented here
  are the intended `0.3.0` payload.
- **Migrations**: fresh databases apply migrations through
  `039_queue_target_repo`. Existing databases migrate by running
  `rig daemon start`.
- **Node engines**: the published CLI accepts Node `>=20`. The root package and
  private daemon package remain constrained to active even-numbered Node lines.
- **Specs and primitives**: workflow specs, context packs, agent images,
  workspace scaffolds, file browsing, queue observability, context usage, and
  runtime skill discovery are all first-class product surfaces.
- **UI shell**: the operator UI has been rebuilt around the V1 shell:
  destination rail, explorer, center workspace, detail drawer, vellum surfaces,
  topology graph/table/terminal modes, and focused project observability.
- **Starter content**: `0.3.0` ships generic starter workflows and starter rigs.
  Project-specific automation recipes are intentionally not shipped in product
  source.
- **No schema-breaking release change**: existing CLI argument shapes, daemon
  route paths, RigSpec/AgentSpec schemas, and persisted settings remain
  backward compatible unless noted below.

### Quick Verification Commands

```bash
# Confirm CLI version after the release-manager version bump
rig --version

# Confirm daemon starts and migrations apply
OPENRIG_DB=/tmp/openrig-030-verify.sqlite rig daemon start

# Confirm settings are readable
rig config list --with-source

# Confirm starter specs are visible
rig specs ls --json

# Confirm runtime identity and loaded context
rig whoami --json
```

If any verification fails, see "Failure Modes And Remediation" below.

---

### V1 Shell And Operator UI

The `0.3.0` UI moves from prototype surfaces to a coherent operator shell:

- Two desktop chrome regions: destination rail and explorer.
- Center workspace for full pages.
- Default-closed detail drawer for previews and referenced content.
- Topology graph/table/terminal modes at a single topology URL.
- Settings rendered as a center workspace page, not as a sidebar panel.
- Vellum surface primitives, 1px region borders, and black-glass terminal
  preview styling.
- Shared runtime graphics marks for agent/runtime/tool identity.
- Retired legacy surfaces: old sidebar shell, legacy dashboard page, and
  rig-detail drawer patterns.

### Starter Rigs And Workflows

OpenRig now ships starter content designed to be useful on a fresh install
without exposing project-specific automation recipes.

- `product-team` is the primary human-directed starter rig.
- `conveyor` is the primary workflow-oriented starter rig.
- `conveyor` includes two generic workflow specs:
  - **Conveyor**: each stage can process queued work independently, so multiple
    packets can be in flight at once and natural queue backpressure handles slow
    stages.
  - **Basic loop**: one packet advances hop-by-hop around a small loop, useful
    when the operator wants a slower, easier-to-watch workflow.
- Generic starter workflows use the workflow runtime and queue primitives. They
  are examples and building blocks, not a hidden project workflow.
- Project-specific workflow specs can still be installed from a user workspace
  or private spec directory; they do not need to be committed to product source.

### Mission-Shaped Workspace Defaults

Fresh installs now have a coherent default workspace path and scaffold:

- `rig config init-workspace` creates the default workspace structure.
- Workspace defaults include missions, slices, specs, proof/evidence locations,
  steering files, and user-editable docs.
- Existing installs are rebased at read time so newer defaults become available
  without destructive rewrites.
- Read-only mission/slice indexing supports nested mission-shaped workspaces
  while preserving compatibility with earlier flat-root layouts.

### Project Observability

Project and queue work is now easier to inspect from the UI:

- For You cards classify queue lifecycle events, shipped work, progress,
  observations, and approvals.
- Queue cards hydrate qitem bodies and proof previews.
- Story tabs emphasize qitem body content and paginate long activity streams.
- Queue rows preview bodies and open the detail drawer with full source,
  destination, state, tags, and created-time metadata.
- Tests tabs show diagnostics and proof assets when no proof is available.
- Workspace and mission rollup pages include scoped Progress, Artifacts, Queue,
  and Topology tabs.
- Current/archive grouping separates active project work from old seed or
  completed work.

### Mission Control And Queue Actions

Mission Control remains the operator surface for queue observability and
qitem actions:

- Views include personal queue, human gate, fleet, active work, recent ships,
  recent activity, and recent observations.
- Actions include approve, deny, route, annotate, hold, drop, and handoff.
- Mission Control audit outcomes are reflected back into For You cards so
  terminal or already-actioned items show evidence instead of stale controls.
- Audit browsing and action history are read-only inspection surfaces.
- Existing daemon endpoints are reused; no extra workflow-specific endpoint is
  required for the public starter content.

### Files, Markdown, Progress, And Proofs

The file and proof surfaces were expanded:

- File browser supports allowlisted roots, safe reads, asset reads, and
  conflict-checked writes.
- Markdown rendering supports frontmatter, code blocks, tables, images, and
  raw/rendered toggles.
- Progress views render status pills, hierarchy, and next-work markers.
- Proof screenshots open in an in-page viewer.
- File drawer headers, proof rows, queue related refs, and story rows use
  shared graphics marks for faster scanning.

### Workflow Runtime And Spec Library

Workflow primitives are available as general infrastructure:

- Workflow specs are cached from markdown/YAML sources.
- Workflow instances and step trails are persisted.
- Specs library includes workflow entries and graph preview.
- Slice and project story surfaces can render spec-aware topology when a slice
  is bound to a workflow instance.
- Cycle-aware traversal prevents graph rendering from hanging on looping specs.

### Context Packs And Agent Images

OpenRig now has additional reusable primitives for context and session state:

- `context_packs` package related context files into a coherent sendable bundle.
- `agent_images` capture reusable starter state from productive sessions.
- Library review surfaces can inspect these primitives and show safe summaries.
- AgentSpec startup can reference context packs and agent images.
- Resume-token data is redacted at route boundaries.

### Topology, Activity, And Context Usage

Topology is now a working operational surface rather than a static diagram:

- Graph/table/terminal views are available at the topology route.
- Host graphs can show multiple rigs on one canvas.
- Rig groups can expand/collapse, persist that state, and auto-expand for
  current rig/pod/seat URLs.
- Agent activity, queue handoffs, token telemetry, and context usage are visible
  in topology views.
- Codex context telemetry is read from local session state and reflected in
  topology table and terminal views when available.
- Detached Codex sessions can still expose the last readable context sample;
  Claude context remains running-session based.

### Terminal Preview

Terminal preview matured across several passes:

- Preview panes use existing session capture primitives.
- Compact terminal popovers are portal-mounted, clamp to viewport edges, and
  resize/reposition on scroll or viewport changes.
- The compact view strips unnecessary chrome and uses a black-glass visual
  language.
- The proof viewer and terminal preview share consistent drawer/popover
  behavior.

### Runtime Skill Discovery

Runtime skill discovery is now part of profile resolution:

- Rig-local skill references still win first.
- Skills can be discovered from runtime-specific and shared user skill roots.
- Structurally invalid `SKILL.md` files are rejected with precise reasons.
- Profile resolution surfaces rejected-skill reasons instead of treating every
  broken skill as merely missing.
- The behavior is intentionally strict: a skill must have frontmatter, non-empty
  `name`, non-empty `description`, and non-empty body content.

### CLI And Daemon Release Hardening

Several release-blocking polish items landed in the CLI/daemon:

- Transcript capture now uses bounded `tmux capture-pane` polling instead of an
  unbounded pipe file.
- `rig send` wraps delivered messages with sender/recipient context and a reply
  hint.
- Generated setup markers use OpenRig naming.
- Original runtime environment aliases keep deprecated `RIGGED_*` fallbacks for
  compatibility; newer typed settings use `OPENRIG_*` only.
- ConfigStore and SettingsStore remain lockstep for typed settings.
- No new plugin loader ships in `0.3.0`; plugin support is planned for a later
  release.

### Removed Or Not Included

- Project-specific workflow recipes are not included in product source.
- The old `demo` rig is no longer the recommended starter; public docs point to
  `product-team` and `conveyor`.
- The legacy `mental-model-ha` skill is removed from starter guidance.
- Root runtime projections such as `CLAUDE.md` are intentionally not tracked.
- Package-local `pnpm-lock.yaml` files are intentionally not restored; this repo
  uses npm workspaces and the root `package-lock.json` for release installs.
- Internal release artifacts and local dogfood packets are not part of the
  public release notes.

---

### Failure Modes And Remediation

**`rig daemon start` fails with an ABI mismatch**

- Cause: native dependencies were compiled against a different Node version.
- Remediation: use an active even-numbered Node release, or rebuild native
  dependencies from the installed package directory.

**Files browser or Progress view appears empty on a fresh install**

- Cause: workspace scaffold has not been initialized or the configured root is
  not where the operator expects.
- Remediation: run `rig config init-workspace`, then inspect
  `rig config list --with-source`.

**Mission Control views are empty**

- Expected on a rig with no queue items.
- Remediation: create or hand off a queue item, then refresh. If still empty,
  confirm daemon status and DB path with `rig daemon status` and
  `rig config get db.path`.

**A skill reference resolves as rejected**

- Cause: the target `SKILL.md` exists but failed structural validation.
- Remediation: fix the skill frontmatter and body. It must include delimited
  YAML frontmatter with non-empty `name` and `description`, followed by non-empty
  markdown body content.

**A public starter workflow is too simple for a specialized loop**

- Expected. `0.3.0` ships reusable primitives and generic starter workflows.
  Specialized workflow specs should live in user workspace or private rig
  packages.

---

## [0.2.0] - 2026-04-22

Baseline for this changelog. Key shipped capabilities at `0.2.0`:

- Pod-aware multi-agent runtime with RigSpec, AgentSpec, pods, and seats.
- Rig-scoped environment management.
- Filesystem-backed spec library for built-in and user roots.
- Daemon-backed stream, queue, project, view, watchdog, and workflow primitives.
- Cross-runtime restore packets for Claude Code and Codex sessions.
- Communication primitives: `rig send`, `rig capture`, `rig broadcast`, durable
  rig chat, and transcript inspection.
- Identity and lifecycle commands: `rig whoami`, adoption/bind/materialize
  flows, snapshot/restore, and post-command handoff.
- Operator surfaces: `rig ps`, `rig ps --nodes`, queue inspection, and daemon
  status.
- 32 SQLite migrations.

---

*This changelog is written for agents and humans. It should describe public
release behavior without depending on local workspace paths or private project
packets.*
