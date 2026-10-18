---
kind: as-built
title: Seat seams — where the daemon reaches tmux, and the interfaces to put in front of it
status: draft
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

Source snapshot: `7e6a60a9`. Read from code only; nothing here was run.

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

## 3. Proposed interfaces

One registry, keyed by `bindings.attachment_type`. `"tmux"` gets today's code; `"external_cli"`
gets today's refusals; anything else is registered by an embedder (the abyme fork, later) before
the daemon starts. Nothing in PR 1 registers a third kind.

```ts
// packages/daemon/src/domain/seat-kinds.ts
export type AttachmentKind = "tmux" | "external_cli" | (string & {});

/** What every seat interface receives: the registry row, frozen at entry. */
export interface SeatRef {
  nodeId: string;
  sessionName: string;          // canonical name; tmux session, or external_session_name
  runtime: string | null;
  kind: AttachmentKind;
  pane: string | null;          // tmux only
  occupant: string | null;      // occupant generation
}

export interface SeatKind {
  readonly kind: AttachmentKind;
  readonly host?: SeatHost;         // absent = OpenRig cannot launch this kind (external_cli)
  readonly inbound: SeatInbound;    // required; external_cli's refuses
  readonly activity: SeatActivityProbe;
}

export class SeatKindRegistry {
  constructor(kinds: SeatKind[]);
  get(kind: AttachmentKind | null | undefined): SeatKind;   // null → "tmux", unknown → throws
  register(kind: SeatKind): void;                           // embedders; refuses re-registering "tmux"
}
```

### SeatHost — launch, ready, stop, resume

Sits where `NodeLauncher` calls `createSession` and where `StartupOrchestrator` calls
`adapter.launchHarness`/`checkReady`. The tmux host is a thin wrapper that calls exactly what is
called today, so runtime adapters do not change.

```ts
export interface SeatHost {
  /** Make the container and return what goes in the binding row. tmux: createSession,
   *  one-off env drop, observeSolePane, option defaults, transcript rotation. */
  create(req: {
    nodeId: string; rigName: string; sessionName: string; cwd?: string;
    env: Record<string, string>; oneOffEnvNames: string[]; baselineEnv: Record<string, string>;
  }): Promise<
    | { ok: true; binding: { tmuxSession?: string; tmuxPane?: string; externalSessionName?: string };
        paneVerdict?: PaneObservation; warnings: string[] }
    | { ok: false; code: string; message: string }>;

  /** Start the agent. tmux: adapter.launchHarness(binding, opts). */
  launch(binding: NodeBinding, adapter: RuntimeAdapter,
         opts: { name: string; resumeToken?: string; forkSource?: ForkSource }): Promise<HarnessLaunchResult>;

  /** tmux: adapter.checkReady(binding). */
  checkReady(binding: NodeBinding, adapter: RuntimeAdapter): Promise<ReadinessResult>;

  /** Restore's resume step. tmux: the Claude/Codex/Pi resume adapters as today. */
  resume(binding: NodeBinding, runtime: string, token: string): Promise<HarnessLaunchResult>;

  /** Positive absence only, as probeSession today. */
  probe(ref: SeatRef): Promise<SessionProbe>;

  /** tmux: killSession. */
  stop(ref: SeatRef): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
}
```

### SeatInbound — send, capture, read

Sits inside `SessionTransport`, below target resolution, the delivery guard, the outbox and the
lease, and above the pane. The tmux implementation is today's private methods moved, not rewritten.

```ts
export interface SeatInbound {
  /** One write inside the lease SessionTransport already holds. tmux: probe, leave copy mode,
   *  runtime-foreground check, pre-paste input-box read, paste, Enter, render verification. */
  deliver(ref: SeatRef, text: string, opts: SendOpts & { beforeWrite?: () => void }): Promise<SendResult>;
  /** Enter-only (submitOnly). */
  submit(ref: SeatRef, opts: SendOpts): Promise<SendResult>;
  capture(ref: SeatRef, lines: number): Promise<CaptureResult>;
  /** For --wait-for-idle and the guarded pre-paste read. */
  readSeat(ref: SeatRef): Promise<SeatReading>;
}
```

`StartupOrchestrator.sendInteractiveText` (`:941-1044`) and the runtime adapters' `send_text`
startup files keep calling tmux directly in PR 1; a non-tmux host owns its own startup delivery
(it gets the resolved files through `SeatHost.launch`'s binding). See §4.

### SeatActivityProbe

```ts
export interface SeatActivityProbe {
  /** One-shot reading for inventory, `rig ps`, waitUntilIdle. tmux: probeSessionActivity body;
   *  external_cli: { state: "unknown", reason: "unsupported_attachment" }. */
  probe(ref: SeatRef, opts: { now?: Date; captureObserver?: CaptureObserverSink;
                              timerlessStatusIsLive?: boolean; agentApp?: string | null }): Promise<AgentActivity>;
}
```

Continuous activity for a non-tmux seat uses the route that exists: the host posts hook or
self-report evidence to `routes/activity.ts`. The pollers stay tmux-only (they already are).

### Delivery guard

Move the reference, not the behaviour: `SeatKindRegistry` owns `deliveryGuard`, and
`tmuxAdapter.deliveryGuard` stays assigned to the same instance (`startup.ts:507`) so
`TmuxAdapter.guardedInput` and the ~25 readers of `tmuxAdapter.deliveryGuard` are untouched. A
non-tmux inbound is called inside `guard.operation` by `SessionTransport` exactly as tmux is.

## 4. What cannot move without behaviour change

1. The `RuntimeAdapter` contract is tmux-shaped (launch types a command into a pane; readiness and
   startup files read and write the pane). Changing it means changing six adapters and their tests.
   PR 1 leaves it alone; `SeatHost.launch` wraps it for tmux and a non-tmux host does not call it.
   `project()` and `listInstalled()` are not tmux and stay usable by any host.
2. `StartupOrchestrator`'s own first send and submission check (`:941-1044`) has tmux-specific
   retry and staged-paste logic. Routing it through `SeatInbound` changes the order of probes;
   leave it, and skip it when `host.launch` reports the startup text was delivered.
3. Pane lineage (`native-process-lineage`, `getPanePid` proofs in claim, restore, transport,
   activity route) proves the agent is the one OpenRig launched. A non-tmux seat has no pane pid;
   its host must attest identity. No change for tmux seats.
4. Handover, restart-in-place, pane cutover, claim, discovery, views, cmux, transcripts and the
   resume-metadata probe session replace or show a pane. They stay tmux-only. For a new kind they
   must refuse; most already branch on `attachment_type` or `tmuxSession`, the rest need a guard.
   For existing kinds that is no change.
5. Error strings say "tmux" (`session-transport.ts:2098` etc.). Tests assert them; keep them in the
   tmux implementation.
6. A missing `tmux` binary is not classified as transport-absent: `isTmuxTransportAbsentError`
   (`tmux.ts:196-214`) does not match the shell's 127 "not found", so `probeSession` throws instead
   of returning `transport_unavailable`. Fixing that is a behaviour change; separate PR.

### Smallest PR 1 that lets an external seat exist

1. `seat-kinds.ts`: `SeatKind`, `SeatHost`, `SeatInbound`, `SeatActivityProbe`, `SeatKindRegistry`.
2. `tmux-seat-kind.ts`: tmux implementations that call today's code. `external-cli-seat-kind.ts`:
   today's refusals, moved verbatim.
3. `SessionTransport`: new optional dep `seatKinds?: SeatKindRegistry`; when absent it builds the
   default from `tmuxAdapter`, so every existing test constructs it unchanged. `send`, `capture`,
   `preWaitForIdle`, `waitUntilIdle` and `probeSessionActivity` callers dispatch on
   `getSessionMeta().attachmentType` instead of `if (external_cli)`.
4. `NodeLauncher` and `StartupOrchestrator`: optional `seatKinds`; launch picks `host` by a new
   optional `LaunchOpts.kind` (default `"tmux"`), and writes `attachment_type` +
   `external_session_name` for a non-tmux kind. Restore, teardown and the reconciler call
   `registry.get(binding.attachmentType).host.probe/stop` in place of `probeSession`/`killSession`.
5. Widen `Binding.attachmentType` and the other three unions (`types.ts:79, 662, 837`,
   `session-registry.ts:33`) to `AttachmentKind`. No migration: the column has no CHECK.
6. `createDaemon` accepts `seatKinds?: SeatKind[]` and registers them. That is the one extension
   point; nothing in this repo passes it.

Not in PR 1: a CLI or rig-spec field to choose a kind (the fork sets it), anything about ACP, the
missing-binary classification, `rig setup`/preflight changes.

Risk: this touches two arteries (message delivery; launch and resume). The tmux paths must be
moved, not edited. Verification: full `npm test`, `npm run lint`, and the stub-agent scenarios,
plus one new unit test per interface that registers a fake kind and checks dispatch (the only new
behaviour, and only reachable through `createDaemon({ seatKinds })`).

## 5. Can the daemon and `rig setup` run without tmux?

| Path | Without `tmux` on PATH | Source |
|---|---|---|
| Daemon process boot (`createDaemon`) | Starts. No `tmux -V`, no `startServer` at boot. The boot reconcile's `probeSession` throws per existing session (not classified, §4.6), errors are counted and boot continues. Fresh DB: nothing to probe. Pollers query tmux rows only. | `startup.ts:501, 701-736`, `reconciler.ts:62-69` |
| `rig daemon start` / `rig start` | Refuses: `SystemPreflight` fails "tmux was not found in PATH." and exits 1 before starting. | `cli/src/commands/daemon.ts:187-232`, `system-preflight.ts:146-168`, `start.ts:209-231` |
| `rig setup` | Tries `brew install tmux`; without brew the step is `skipped`, but the doctor verification has a `tmux` check with status `fail`, so `ready=false` and exit 1. | `setup.ts:355-396, 556-559, 704, 750`, `doctor.ts:118-126` |
| `rig doctor` | `fail` on tmux. | `doctor.ts:118-126` |

So the daemon itself can run without tmux; the CLI refuses to start it and `rig setup` reports not
ready. An embedder that starts the daemon itself (calling `createDaemon` or the daemon entry
directly) avoids the CLI preflight. Making `rig daemon start`/`setup` accept a tmux-less install is
a behaviour change (a preflight that knows no tmux seat is configured), so it belongs in the fork
or a later upstream proposal, not PR 1. Not verified by running: the absent-tmux boot trace and
the pollers' behaviour with no tmux rows.
