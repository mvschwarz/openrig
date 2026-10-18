---
kind: as-built
title: Seat seams — where the daemon reaches tmux, and the interfaces to put in front of it
status: active
topics: [launch-and-resume, message-delivery, activity]
applies-when: |
  You are putting launch, delivery or activity behind an interface so that a seat can run
  somewhere other than a tmux pane, or reviewing such a change.
siblings: [arteries.md, test-layers.md]
prerequisite-reads: [../../ARCHITECTURE.md, arteries.md]
last-verified-against-source: 7e6a60a9
last-updated: 2026-10-18
---

# Seat seams

Source snapshot: `7e6a60a9` for the map in §1-§2. §3-§4 describe the interfaces as built on the
`seat-seams` branch, and §5 records what a daemon booted without tmux actually did.

Goal: one PR that adds interfaces in front of tmux, with today's tmux code as the only
implementation that does anything, so that a seat whose agent runs elsewhere (an ACP host, for
example) can exist without the daemon touching tmux for it. No behaviour change: every existing
test passes unchanged.

## 1. What already exists

- `TmuxAdapter` (`packages/daemon/src/adapters/tmux.ts`) is built once, in `startup.ts:501`, and
  handed to about 60 files. Roughly half already take a `Pick<TmuxAdapter, …>` (pane-cutover,
  seat-restart-in-place, seat-activity-service, seat-identity-reconciler, structural activity,
  agent-app adapter, `observeSolePane`, `native-process-lineage`); the rest take the class.
- A paneless seat type already exists: `bindings.attachment_type` (migration 019, `TEXT NOT NULL
  DEFAULT 'tmux'`, no CHECK) with `'external_cli'` and `bindings.external_session_name`. It is made
  only by `attach-self`. Every inbound path refuses it with `transport_unavailable`
  (`session-transport.ts:2049, 2208, 3170`), activity says `unsupported_attachment` (`:512`), target
  resolution already names it by `external_session_name` (`:1866`), and the queue already treats it
  as paneless (`queue-repository.ts:3771`).
- The three pollers already select only `COALESCE(b.attachment_type,'tmux') = 'tmux'`
  (seat-activity-service:239-285, seat-structural-activity-service:151,
  seat-identity-reconciler:136). A non-tmux seat is never sampled by them today.
- Activity already has a non-tmux input: hook events and self-report go through `routes/activity.ts`
  into the arbitration oracle (`activity-taxonomy.ts` rungs `self-report`, `lifecycle-hooks`). The
  only tmux use on that route is optional Claude launch-lineage (`routes/activity.ts:315`, skipped
  when there is no pane).
- `SeatDeliveryGuard` (typing guard, per-seat lease, retention) is DB-backed but hangs off
  `tmuxAdapter.deliveryGuard` (`startup.ts:505-507`), and `TmuxAdapter` itself wraps every write in
  it (`guardedInput`, `tmux.ts:397-452`).

So the attachment type is the dispatch key. The work is to make "what happens for a seat of kind
X" a lookup rather than an `if (external_cli) refuse`.

## 2. Where the daemon reaches tmux, by interface

Counts are call sites read from source; file:line is at `7e6a60a9`.

### Launch (create, launch harness, ready, stop, resume)

| Where | Calls | Notes |
|---|---|---|
| `node-launcher.ts:169-279` | `createSession`, `observeSolePane`→`listPanes`, `tmuxOptionDefaults.applyToFreshSession`, `startTranscriptRotation`, `killSession` (×2), `setSessionEnv`/`unsetSessionEnv` (`:305-311`), `finishLaunchBinding` | The container. Writes `bindings.tmux_session/tmux_pane`. |
| `startup-orchestrator.ts:331-653` | `adapter.project`, `adapter.deliverStartup`, `adapter.launchHarness` (`:420`), `adapter.checkReady` (`:524, 653, 727`) | Generic; the tmux is inside the runtime adapter. |
| Runtime adapters (`claude-code-adapter`, `codex-runtime-adapter`, `pi-runtime-adapter`, `stub-runtime-adapter`, `agent-app-runtime-adapter`, `terminal-adapter`) | launch = `sendShellCommand`/`sendText`+`sendKeys Enter` into the pane; ready = `hasSession`, `getPaneCommand`, `capturePaneContent(40)`, `getPanePid` lineage; codex update-prompt dismissal = `capturePaneScreen` + `sendKeys ["3"]` | `RuntimeAdapter` (`domain/runtime-adapter.ts`) is the contract; its doc says "launch the harness inside the tmux session". |
| Resume adapters (`claude-resume`, `codex-resume`, `pi-resume`) | `sendShellCommand`/`sendText`+Enter, `C-c` on abort, verify via `getPaneCommand`+`capturePaneContent(40)`, `verifyPaneIdleShell` | Called by restore (`restore-orchestrator.ts:1242→1741`). |
| `restore-orchestrator.ts` | `hasSession` (`:540, 638, 706, 1914`), idle-shell proof (`:551-553`), `nodeLauncher.launchNode` (`:1026`), `killSession` rollback (`:1100`), `rebindAndVerifyPaneIdentity` (`:1567, 1934`), runtime-truth probe (`:1946-1973`) | |
| Stop: `seat-lifecycle-service.ts:1370, 1575`, `rig-teardown.ts:151-250`, `rig-lifecycle-service.ts:253, 514`, `rigspec-instantiator.ts:171, 1226-1640` | `killSession`, `probeSession`, `setSessionOption` (clear `@rigged_*`), `startServer` (`seat-lifecycle-service:1015, 1044`) | |
| Liveness at boot: `reconciler.ts:62` | `probeSession` per running session | |
| Claim / adopt: `claim-service.ts` | `observeSolePane`, `setSessionOption` ×5 (`:194`), hint `sendText`+Enter under the guard (`:205-211`), `hasSession`/`getPaneCommand`/lineage (`:409, 510-533`), transcript capture | Adopts an existing tmux session. Inherently tmux. |
| Handover / restart in place: `successor-session-launcher.ts`, `seat-handover-service.ts`, `seat-restart-in-place.ts`, `pane-cutover.ts` | `respawnPane`, `getDefaultShell`, `setRemainOnExit`, `signalPaneProcess`, `isPaneDead`, `signalPid`, pane-local options, `capturePaneHistory` | Replace the process inside the same pane. Inherently tmux. |
| `seat-launch-environment.ts:111-119` | `getPaneCommand` (shell kind), `getSessionEnv` | Builds the env-wrapped command typed into the pane. |
| `resume-metadata-refresher.ts:367-421` | throwaway `rigged-refresh-*` session: `createProbeSession`, `sendText`, `capturePaneContent(80)`, `killSession` | |

### Delivery (send, capture, readiness of the input box)

| Where | Calls | Notes |
|---|---|---|
| `SessionTransport.send` and helpers (`session-transport.ts:1902-2740`) | `probeSession` (`:2091, 2259`), `isPaneInMode`/`cancelPaneMode` (`:2167-2173`), `capturePaneContent` pre-paste and verify (`:2308, 2558, 2624, 2663`), `sendText` (`:2588-2589`), `sendKeys Enter` (`:2332, 2637`), `getPanePid`/`listPanes`/`getPaneCommand` identity (`:2613, 2733, 2872-2906`), `hasSessionEnv` (`:3051-3080`) | The guard/outbox/lease and target resolution around it are not tmux. |
| `SessionTransport.capture` (`:3168-3224`) | `probeSession`, `capturePaneContent` | |
| `SessionTransport.waitUntilIdle` (`:2753`) | via `probeSessionActivity` | |
| Queue wake | `queue-repository.ts:1472` → `QueueNudgeTransport.send` | Already behind an interface (`queue-repository.ts:265`); the implementation is `SessionTransport`. Outbox handler has no tmux. |
| Startup text: `startup-orchestrator.ts:941-1044` | `sendText`, `sendKeys Enter`, `capturePaneContent` to verify submission | Bypasses `SessionTransport` for the first send. |
| Runtime adapters' `deliverStartup` (`send_text` files) | `sendText` + `sendKeys Enter` | |
| Handover packets: `seat-handover-service.ts:827-907` | `capturePaneScreen`, `sendText`, `sendKeys Enter` | |
| Human terminal: `TerminalSessionBroker.ts:289-290` | `sendKeys`/`sendText` under `humanInput` | View, not delivery. |

### Activity

| Where | Calls | Notes |
|---|---|---|
| `probeSessionActivity` (`session-transport.ts:471-660`) | `getPaneCommand`, `hasSession`, `capturePaneContent(20)` (+ styled) | Used by node-inventory (`:1484`), `routes/rigs.ts:379`, `routes/sessions.ts:141,188`, `waitUntilIdle`. Already refuses `external_cli`. |
| `seat-activity-service.ts:106, 280` | `readPaneLastActivity`, `readAllSessionWindowActivity` | tmux rows only. |
| `seat-structural-activity-service.ts:103-184` | `capturePaneContent`, `capturePanesContent`, window snapshot | tmux rows only. |
| `seat-identity-reconciler.ts:167-337` | `listSessions`, `readAllPaneProcesses`, `getPanePid`, `getPaneCommand`, `listPanes` | tmux rows only. |
| `seat-attention-reconciler.ts` (`rebindAndVerifyPaneIdentity`) | `listPanes`, `getPanePid`, `getPaneCommand` | |
| `transcript-rotation.ts` | window snapshot, `capturePaneContent(s)` | Transcript, not activity, but same sampling. |
| Model monitor (`startup.ts:2295`), codex thread (`routes/sessions.ts:706-721`) | `getPanePid` | |

### tmux-only, not behind any seat interface

Discovery (`tmux-discovery-scanner`, `session-fingerprinter`, `routes/adapters.ts:17`), views
(`TerminalSessionBroker`, `terminal-service`, `routes/terminal-ws.ts`, `seat-switch-client-service`,
cmux services, `tmuxAttachCommand` strings in `rig up`/inventory), option defaults
(`tmux-option-defaults.ts`), transcripts (`transcript-capture`, `routes/transcripts.ts` — already
gated on `attachment_type`), `routes/startup.ts:75-104` (kernel probe, `POST /terminal` →
`startServer`), `runtime-verifier.ts:59` (`tmux -V`), shutdown (`index.ts:407`
`closeControlClient`), boot (`index.ts:437-441` parent-env strip).

These describe or show a pane. A non-tmux seat has none, so they need to skip it, not abstract it.

## 3. The interfaces

`packages/daemon/src/domain/seat-kinds.ts`. One registry, keyed by `bindings.attachment_type`.
tmux and external_cli are built in and keep their code where it is; a kind registered through
`createDaemon({ seatKinds })` replaces the tmux calls for its own seats. Nothing in this
repository registers one.

```ts
export type AttachmentKind = "tmux" | "external_cli" | (string & {});

export interface SeatRef {          // the registry row a seat interface acts on, read at entry
  nodeId: string | null; sessionName: string; runtime: string | null;
  kind: AttachmentKind; pane: string | null; occupant: string | null;
}

export interface SeatHost {
  create(req: SeatCreateRequest): Promise<SeatCreateResult>;   // before any DB write
  launch(binding: NodeBinding, adapter: RuntimeAdapter,
         opts: { name: string; resumeToken?: string; forkSource?: ForkSource }): Promise<HarnessLaunchResult>;
  checkReady(binding: NodeBinding, adapter: RuntimeAdapter): Promise<ReadinessResult>;
  probe(ref: SeatRef): Promise<SessionProbe>;                  // positive absence only
  stop(ref: SeatRef): Promise<TmuxResult>;                     // session_not_found when already gone
}

export interface SeatInbound {      // called after target resolution, inside the guard's lease
  deliver(ref: SeatRef, text: string, opts: SendOpts): Promise<SendResult>;
  capture(ref: SeatRef, lines: number): Promise<CaptureResult>;
}

export interface SeatActivityProbe { probe(ref: SeatRef, now: Date): Promise<AgentActivity>; }

export interface SeatKind { kind; host: SeatHost; inbound: SeatInbound; activity: SeatActivityProbe; }

export class SeatKindRegistry {
  constructor(kinds?: readonly SeatKind[]);   // refuses "tmux", "external_cli" and duplicates
  hasCustom(): boolean;                       // call sites check this first: no extra reads by default
  custom(kind): SeatKind | null;              // null for the built-ins and unknown kinds
  forNode(sessionRegistry, nodeId, sessionName, runtime?): { kind; ref } | null;
}
```

`TmuxSeatHost` (`tmux-seat-host.ts`) is the tmux host: `create` is NodeLauncher's session setup
moved verbatim (createSession, one-off env drop, sole-pane observation, option defaults, transcript
rotation); `launch`/`checkReady` call the runtime adapter; `probe`/`stop` call `probeSession` and
`killSession`. NodeLauncher and StartupOrchestrator always go through a host.

Where it is wired:

| Call site | tmux (unchanged) | A registered kind's seat |
|---|---|---|
| `NodeLauncher.launchNode` | `TmuxSeatHost.create`, binding `tmux_session`/`tmux_pane` | `LaunchOpts.kind` picks the host; binding `attachment_type=<kind>`, `external_session_name=<session>`; unregistered kind refuses `seat_kind_unknown` |
| `StartupOrchestrator` launch, readiness, startup text | runtime adapter via `TmuxSeatHost`; text typed into the pane | `host.launch`, `host.checkReady`; startup text through `inbound.deliver` |
| `SessionTransport.send` / `capture`, rig-wide targets | inline tmux code | `inbound.deliver` / `inbound.capture`, only for the session name the binding currently carries; running seats join rig targets |
| `resolveGuardTarget` | same SQL result | resolves by `external_session_name` for a registered kind only |
| `probeSessionActivity` (inventory, idle waits) | pane reading | `activity.probe` |
| Boot reconcile, `rig down`, `rig seat stop`, node removal | `probeSession` / `killSession` | `host.probe` / `host.stop`; refusal text names the seat host, codes unchanged |
| Node removal's `fallbackDestination` liveness | `hasSession` | `host.probe` must answer `present` |

Continuous activity for a seat without a pane arrives over the existing hook and self-report
routes (`routes/activity.ts`). The pollers already skip non-tmux rows.

## 4. What did not move

Departures from the design note this doc first proposed, and why:

1. The tmux send, capture and activity code stays inline in `SessionTransport`, behind a
   dispatch for registered kinds, rather than moving to a `TmuxSeatInbound` class. Those are ~800
   lines of an artery, and a test replaces `transport.tmuxAdapter` after construction; moving them
   is a separate refactor with no behaviour to gain for PR 1.
2. No `SeatHost.resume`: a resume is `launch` with `resumeToken`. Restore keeps its tmux resume
   adapters and cannot yet bring back a registered kind's seat, because the kind is not persisted
   once a seat is stopped and its binding cleared. Restore of such seats belongs to the embedder
   for now.
3. No `submit`/`readSeat` on `SeatInbound`: a registered kind's seat takes the leased path, and its
   `deliver` owns submit-only and any wait it supports.

What cannot move without behaviour change:

1. The `RuntimeAdapter` contract is tmux-shaped (launch types into a pane; readiness and `send_text`
   startup files read and write it). It is untouched; a registered host does not call it, and a
   non-Claude adapter's `send_text` files still go to tmux.
2. Pane lineage (`native-process-lineage`, `getPanePid` proofs) proves the agent is the one OpenRig
   launched. A seat without a pane has none; its host attests identity.
3. Handover, restart-in-place, pane cutover, claim, discovery, views, cmux, transcripts, the
   startup-proof challenge prompt, the resume-metadata probe and failed-startup recovery replace or
   read a pane. They stay tmux-only; failed-startup recovery skips a registered kind's seat.
4. Refusal text says "tmux" (also on the stop path a registered host now uses). Tests assert it.
5. A missing `tmux` binary is not classified as transport-absent: `isTmuxTransportAbsentError`
   (`tmux.ts:196-214`) does not match the shell's 127 "not found", so `probeSession` throws. See §5.

## 5. Can the daemon and `rig setup` run without tmux?

Run on 2026-10-18 against the built `7e6a60a9` (`dist/`), Node 26.12, with `PATH` holding only
`node`, `/usr/bin` and `/bin` (`command -v tmux` → none), `HOME` and `OPENRIG_HOME` under
`/private/tmp`, `OPENRIG_NO_KERNEL=1`, port 47901. Script: two boots of `node dist/index.js`, the
second with one running session seeded in the DB, then the CLI.

| Path | Observed without `tmux` on PATH |
|---|---|
| Daemon boot, fresh DB | Starts; `/healthz` 200, `/api/rigs` 200. `startup reconcile: rigs=0 checked=0 detached=0 errors=0`. Two `tmux list-sessions … exec: tmux: not found` stack traces in the log from a poller. `/api/adapters/tmux/sessions` → 500. |
| Daemon boot, one running session | Starts; same endpoints. `startup reconcile: rigs=1 checked=0 detached=0 errors=1` with `tmux has-session … not found`: the row is neither checked nor detached (§4.5). |
| `rig daemon start --no-kernel --port 47902` | Refuses before starting: `✗ tmux: tmux was not found in PATH.`, exit 1. |
| `rig doctor` | `[FAIL] tmux: tmux not found.`, exit 1. |
| `rig setup` | Not run. From code: tries `brew install tmux` (no brew on this PATH → `skipped`), then the doctor verification's `tmux` check fails, so `ready=false` and exit 1 (`setup.ts:355-396, 556-559`, `doctor.ts:118-126`). |

So the daemon runs without tmux, with log noise and a stuck reconcile row for any old tmux
session; the CLI refuses to start it and `rig setup` ends not ready. An embedder that starts the
daemon itself (`createDaemon`, or the daemon entry) avoids the CLI preflight. Accepting a tmux-less
install in `rig daemon start`/`setup` is a behaviour change for the fork or a later upstream
proposal.

Found while running it: with no `OPENRIG_BIND_HOST`, the daemon also bound the machine's
Tailscale address (`listening on http://100.x.x.x:47901`) next to loopback. That is its documented
auto-bind, but a scratch daemon should set `OPENRIG_BIND_HOST=127.0.0.1`.
