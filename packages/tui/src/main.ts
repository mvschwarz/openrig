#!/usr/bin/env node
import { pageReadKey } from "./page-read.js";
import { completeCommand } from "./commands/completion.js";
import { resolveTimeZone } from "./time.js";
// Entry: wires the four input adapters (command bar / keyboard / mouse /
// control socket) onto ONE instance-scoped view-state (PIN 1). tmux send-keys
// against this process is the drivability floor and needs no adapter at all —
// keystrokes ARE the keyboard adapter.
//
//   openrig-tui [--instance <id>] [--socket <path>] [--url <daemon>] [--demo]
import { createViewState, computeExplorerRows, emptySnapshot, locationKey } from "./state.js";
import { parseCommand } from "./grammar.js";
import { filterPalette, paletteExecuteLine } from "./commands/palette.js";
import { COMMAND_REGISTRY, currentCommandContext } from "./commands/registry.js";
import { createInputDecoder, resolveEscapeAction, resolveKeyAction, resolveMouseAction, MOUSE_ENABLE, MOUSE_DISABLE, ALT_SCREEN_ON, ALT_SCREEN_OFF, PASTE_ENABLE, PASTE_DISABLE } from "./input.js";
import { renderScreen } from "./render.js";
import { createStyle, detectColorMode } from "./theme.js";
import { stylizeLines } from "./stylize.js";
import { createControlSocket, defaultSocketPath } from "./socket-server.js";
import { demoSnapshot } from "./demo-data.js";
import { DaemonClient, launchNodeNotice } from "./daemon-client.js";
import { hydrateSnapshot } from "./hydrate.js";
import { createLiveRefresh } from "./live.js";
import { resolvePendingAddress } from "./pending-address.js";
import { subscribeActivityEvents } from "./live-events.js";
import { execFile } from "node:child_process";
import { probeCrashCart, type CrashCartRenderOpts } from "./crash-cart/from-emit.js";
import { resolveCrashCartKey, type CrashCartKeyAction } from "./crash-cart/keys.js";
import { driveRestoreLifecycle, buildRestoreLifecycleVM } from "./crash-cart/restore-lifecycle.js";
import { restoreKeyAction, type RestoreInputEvent } from "./crash-cart/restore-input.js";
import { evaluateOneClickGate, restoreConfirmMessage } from "./crash-cart/one-click-gate.js";
import { daemonStartArgs } from "./crash-cart/start-daemon.js";
import { readLocal } from "./local-reading.js";
import { StartupController } from "./startup.js";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Action, FleetSnapshot, Screen } from "./types.js";
import type { SpecReviewCache } from "./hydrate.js";
import { MOTION_FRAME_MS } from "./visual-layout.js";
import { launchProcess, runSpecLaunch } from "./specs/launch.js";
import { runCopySession, processCopyTerminal } from "./print-for-copy.js";
import { openTerminalInWindow, terminalWindowNotice } from "./terminals/open-window.js";

function argOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const instanceId = argOf(args, "--instance") ?? "tui-1";
  const demo = args.includes("--demo");
  // Reuse the entry/runtime that opened this TUI, even under a conflicting PATH.
  const cliEntry = process.env["OPENRIG_TUI_CLI_ENTRY"];
  const cliExecutable = cliEntry ? process.execPath : "rig";
  const cliArgs = (args: string[]): string[] => cliEntry ? [cliEntry, ...args] : args;

  // --demo renders the labeled fixture; otherwise the §4.A reads hydrate the
  // snapshot (honest-empty until the first read answers; failed reads surface
  // as named readErrors in the status line, never fabricated content).
  let snapshot: FleetSnapshot = demo ? demoSnapshot() : emptySnapshot();
  let timeReadWarning = false;
  const timeSetting = new Promise<unknown>((resolve) => {
    execFile(cliExecutable, cliArgs(["config", "get", "ui.timezone", "--json"]), { timeout: 5000, maxBuffer: 8192 }, (err, stdout, stderr) => {
      timeReadWarning = !!err || stderr.includes("ui.timezone");
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout).value); } catch { resolve(null); }
    });
  });
  const view = createViewState({ instanceId, getSnapshot: () => snapshot, timeZoneWarning: "Reading configured timezone…" });
  let startupHeaders: () => Record<string, string> = () => ({});
  if (cliEntry) {
    try {
      const cli = await import(pathToFileURL(join(dirname(cliEntry), "client.js")).href);
      startupHeaders = cli.terminalAuthHeaders;
    } catch { /* the startup read will expose an unavailable/unauthorized prerequisite */ }
  }
  const client = demo ? null : new DaemonClient({ baseUrl: argOf(args, "--url"), headers: startupHeaders });
  let startup: StartupController | null = null;
  let nativeAttached = false;
  let launching = false;
  let openingTerminal = false;
  let controlSocketPath: string | undefined;
  let shuttingDown = false;

  let inputLine = "";
  let completion: ReturnType<typeof completeCommand> | null = null;
  let lastScreen: Screen | null = null;
  // 5.2 crash-cart: the daemon-down verdict (probed from the `rig crash-cart --json` verb). Empty ⇒
  // normal fleet views; DOWN ⇒ the recovery cockpit; UNVERIFIED ⇒ the cannot-verify screen.
  let crashCartOpts: CrashCartRenderOpts = {};
  let startingDaemon = false;
  // H2 — a non-zero-generation ⏎ arms a confirm: the NEXT ⏎ proceeds, Esc cancels. Never a silent
  // resume→fresh downgrade — the confirm NAMES the seats that will need a decision.
  let pendingRestoreConfirm = false;
  // B1 ROUND 2 — the operator's mid-run cancel request for the active fleet restore (the lifecycle
  // driver polls this and reaches the cancel endpoint stop-before-next-rig).
  let restoreCancelRequested = false;
  // B1 ROUND 3 (HIGH-2) — vertical scroll offset into the restore triage list, so a fleet with more
  // needs than the viewport stays keyboard-walkable (arrow/j-k on the done view).
  let restoreScrollOffset = 0;
  const inputDecoder = createInputDecoder();
  const style = createStyle(args.includes("--no-color") ? "none" : detectColorMode());
  let appliedCopyMode = view.get().copyMode;
  const unsubscribeCopyMode = view.subscribe((state) => {
    if (state.copyMode === appliedCopyMode) return;
    appliedCopyMode = state.copyMode;
    process.stdout.write(state.copyMode ? MOUSE_DISABLE : MOUSE_ENABLE);
  });

  // S19 round-5 (guard): the refresh OWNER (live.ts) carries the honest load
  // lifecycle and the per-seat fresh-pane-output events; renderScreen stays
  // pure and takes the clock + owner state as inputs. motionTimer keeps
  // redrawing ONLY while the frame reports live motion (spinner or flash).
  const reviewCache: SpecReviewCache = new Map();
  const selectedSliceDirectory = (): string | null => {
    const current = view.get();
    if (current.scopesSelected) return current.scopesSelected.slice;
    if (!current.executionOpen?.startsWith("slice:")) return null;
    const id = current.executionOpen.slice("slice:".length);
    const mission = snapshot.scopes?.find((item) => item.mission === current.scopesMission);
    return mission?.slices.find((slice) => slice.id === id || slice.dirName === id)?.dirName ?? null;
  };
  const selectedRigName = (): string | null =>
    view.get().drill.find((part) => part.kind === "rig")?.name ?? null;
  const live = client
    ? createLiveRefresh({ scopeKey: () => pageReadKey(view.get()), hydrate: (page, signal) => hydrateSnapshot(client.forPage(page, signal), reviewCache, view.get().scopesMission, selectedSliceDirectory(), selectedRigName(), view.get()), onFrame: () => draw(), now: () => Date.now() })
    : null;
  let motionTimer: NodeJS.Timeout | null = null;
  // S19 AM-R18 — the open view updates ITSELF: oracle pushes drive the refresh owner.
  // Notification-only; the refresh rehydrates the same ps projection through the
  // daemon client (one oracle, with the owner's bounded quiet fallback; HTTP stays
  // in the client module).
  let liveEnabled = false;
  let inputRevision = 0;
  let drawnScope = pageReadKey(view.get());
  let drawnSnapshot = snapshot;
  let drawnSettled = false;
  let previousPage: { state: ReturnType<typeof view.get>; snapshot: FleetSnapshot } | undefined;
  let activityEvents: ReturnType<typeof subscribeActivityEvents> | null = null;
  function enableLive(): boolean {
    if (!live || !client || startup?.state.connection !== "up") return false;
    liveEnabled = true;
    activityEvents ??= subscribeActivityEvents({ open: () => client.openActivityEvents(), onEvent: (event) => { if (event.type.startsWith("proof.")) reviewCache.clear(); void live.invalidate(); }, onStatus: (status) => live.connectionStatus(status) });
    return true;
  }
  function commandContext() {
    return currentCommandContext(startup && startup.state.connection !== "up" ? "unverified" : crashCartOpts.daemonState ?? null);
  }

  function draw(): void {
    if (nativeAttached) return;
    const cols = process.stdout.columns ?? 120;
    const rows = process.stdout.rows ?? 32;
    const nowMs = Date.now();
    if (live) {
      const next = live.snapshot();
      const scope = pageReadKey(view.get());
      if (next !== drawnSnapshot && live.load().settled) {
        const oldKey = scope === drawnScope && drawnSettled
          ? computeExplorerRows(view.get(), snapshot)[view.get().selection]?.key
          : locationKey(view.get());
        const rows = computeExplorerRows(view.get(), next);
        const index = oldKey ? rows.findIndex(row => row.key === oldKey) : -1;
        const selection = index >= 0 ? index : Math.min(view.get().selection, Math.max(0, rows.length - 1));
        if (selection !== view.get().selection) view.dispatch({ type: "select", index: selection, rowCount: rows.length, origin: "refresh" });
      }
      drawnScope = scope; drawnSnapshot = next; drawnSettled = live.load().settled;
    }
    if (live) snapshot = { ...live.snapshot(),
      ...(!liveEnabled ? { readErrors: [`Live data not loaded · connection ${startup?.state.connection ?? "probing"} · L Local reading · S Startup`] } : {}),
      launchingCli: process.env["OPENRIG_TUI_CLI_IDENTITY"]?.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 180) };
    if (resolvePendingAddress(view, liveEnabled && live ? live.load() : null)) refreshFromActivity();
    const opts = { cols, rows, nowMs, completion, controlSocketPath, colorMode: style.mode, commandContext: commandContext(), ...crashCartOpts, ...(startup?.state.open && !view.get().palette ? { startup: startup.state } : {}), restoreScroll: restoreScrollOffset, ...(liveEnabled && live ? { load: live.load(), rowFlashes: live.flashes() } : {}) };
    if (liveEnabled && live?.load().settled) previousPage = { state: { ...view.get() }, snapshot };
    const pageOptions = { ...opts, ...(liveEnabled && !live?.load().settled ? { previousPage } : {}) };
    lastScreen = renderScreen(view.get(), snapshot, pageOptions, inputLine);
    if (startup?.state.local) startup.state.local.scroll = Math.min(startup.state.local.scroll, lastScreen.contentMaxOffset);
    // Startup has its own selection/scroll; keep the underlying reader bookmark intact.
    if (!startup?.state.open && !view.get().palette && (!liveEnabled || live?.load().settled) && (view.get().contentMaxOffset !== lastScreen.contentMaxOffset || view.get().contentTargetCount !== lastScreen.contentTargets.length)) {
      view.dispatch({ type: "layout", contentMaxOffset: lastScreen.contentMaxOffset, contentTargetCount: lastScreen.contentTargets.length });
      lastScreen = renderScreen(view.get(), snapshot, pageOptions, inputLine);
    }
    // styling is a zero-width post-pass over the tested plain layer — the
    // hitMap coordinates always match what is on screen
    // The renderer owns line breaks. Wide pasted characters must not wrap a
    // padded row and scroll the entire frame; restore normal wrapping after paint.
    process.stdout.write("\x1b[?7l\x1b[H" + stylizeLines(lastScreen, style).map((l) => "\x1b[2K" + l).join("\r\n") + "\x1b[?7h");
    if (motionTimer) clearTimeout(motionTimer);
    motionTimer = lastScreen.motionActive || lastScreen.commandMotionActive ? setTimeout(draw, MOTION_FRAME_MS) : null;
  }

  // 5.2 crash-cart: probe the daemon-down verdict via the shipped `rig crash-cart --json` verb (its
  // JSON is the truth even on a hint non-zero exit). Any failure → normal TUI (never a fabricated cockpit).
  const runCrashCartVerb = (): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(cliExecutable, cliArgs(["crash-cart", "--json"]), { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (stdout && stdout.trim()) resolve(stdout);
        else reject(new Error(stderr.trim() || err?.message || "crash-cart: no output"));
      });
    });
  if (client) startup = new StartupController({
    client, home: process.env["OPENRIG_HOME"] ?? "default local instance", probe: runCrashCartVerb,
    startDaemon: () => new Promise<void>((resolve, reject) => {
      execFile(cliExecutable, cliArgs(daemonStartArgs(client.baseUrl)), { timeout: 30_000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`Daemon start did not confirm completion: ${stderr.trim() || stdout.trim() || error.message}`));
        else resolve();
      });
    }),
    onChange: () => {
      draw();
      // Skip during the probe must remain skipped, but can start reads when
      // the connection later answers. This never changes the chosen page.
      if (!startup?.state.open && startup?.state.connection === "up" && !liveEnabled && enableLive()) void live?.refresh();
    },
    onHelp: () => { view.dispatch({ type: "palette-open" }); draw(); },
    readLocal: (request) => readLocal(cliEntry, request),
    onNative: async (seat) => {
      if (!cliEntry || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(client.baseUrl).hostname)) {
        throw new Error("Native terminal access requires this TUI on the selected daemon's machine.");
      }
      const { attachSharedTui } = await import(pathToFileURL(join(dirname(cliEntry), "shared-tui.js")).href);
      nativeAttached = true;
      process.stdin.pause();
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write(PASTE_DISABLE + MOUSE_DISABLE + ALT_SCREEN_OFF);
      try {
        const code = await attachSharedTui(seat.observed.sessionName);
        if (code !== 0) throw new Error(`Native terminal attachment exited ${code}. Refresh to inspect the existing occupant.`);
      } finally {
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdout.write(ALT_SCREEN_ON + MOUSE_ENABLE + PASTE_ENABLE);
        nativeAttached = false;
      }
    },
    onWork: async (rig, seat) => {
      const revision = inputRevision;
      crashCartOpts = {};
      view.dispatch({ type: "notice", message: startup?.state.connection === "up" ? "" : "Live data waits for a confirmed connection · S Startup · L Local" });
      draw();
      if (!enableLive()) return;
      await live?.refresh();
      if (revision !== inputRevision) return;
      const current = live?.snapshot() ?? snapshot;
      const host = current.hosts.find((host) => host.rigs.some((entry) => entry.id === rig?.rigId));
      if (rig && host) {
        view.dispatch({ type: "drill", resource: "rig", name: rig.rigName, target: { host: host.name } });
        await live?.refresh();
      }
      if (revision !== inputRevision) return;
      if (seat && host) view.dispatch({ type: "drill", resource: "agent", name: seat.observed.sessionName, target: { host: host.name, rig: rig!.rigName } });
      draw();
    },
  });
  async function refreshCrashCart(): Promise<void> {
    crashCartOpts = await probeCrashCart(runCrashCartVerb);
    draw();
  }
  // Perform a cockpit action key. start-daemon/restore exec `rig daemon start` (the ⏎ flow's `s` step;
  // the C1 batch conductor that RESTORE ultimately drives is EXCLUDED this wave) then re-probe; retry
  // re-probes (UNVERIFIED). inspect/onboarding are entry-point seams this wave.
  // ⏎ RESTORE EVERYTHING: start the daemon (the `s` step), then the TUI OWNS the restore lifecycle
  // against it — kick/poll/cancel via the daemon client, retaining the attempt id (r2: no more blind
  // delegation to a buffered child). Each poll updates the restore render (progress from the rollup
  // stream); on done the rollup + keyboard-walkable triage list render; 'c' cancels mid-run.
  // Poll one restore attempt to done/detached, rendering a frame per poll. Shared by the initial ⏎
  // restore and by reattach (attemptId set) from the detached view. The driver TOLERATES transient poll
  // errors internally (it detaches after a sustained streak, never throws on a blip), so this .catch
  // fires ONLY on a genuine kick/start-side failure — never on a single blipped poll (r1 refinement 2).
  function pollRestore(daemonClient: DaemonClient, attemptId?: string): void {
    void driveRestoreLifecycle({
      client: daemonClient,
      attemptId,
      onFrame: (frame) => {
        // render progress from the poll stream — a mid-run frame every poll, not only at completion
        crashCartOpts = { ...crashCartOpts, restore: buildRestoreLifecycleVM(frame) };
        draw();
      },
      isCancelRequested: () => restoreCancelRequested,
    }).catch((e: unknown) => {
      crashCartOpts = { ...crashCartOpts, restore: undefined };
      view.dispatch({ type: "notice", message: `fleet restore failed: ${e instanceof Error ? e.message : String(e)}` });
      void refreshCrashCart();
    });
  }

  function runFleetRestore(): void {
    if (!client) {
      view.dispatch({ type: "notice", message: "demo mode: restore disabled" });
      draw();
      return;
    }
    const daemonClient = client;
    restoreCancelRequested = false;
    restoreScrollOffset = 0;
    new Promise<void>((resolve, reject) =>
      execFile("rig", ["daemon", "start"], { timeout: 30_000 }, (err) => (err ? reject(err) : resolve())),
    )
      .then(() => pollRestore(daemonClient))
      .catch((e: unknown) => {
        crashCartOpts = { ...crashCartOpts, restore: undefined };
        view.dispatch({ type: "notice", message: `fleet restore failed: ${e instanceof Error ? e.message : String(e)}` });
        void refreshCrashCart();
      });
  }

  // Detached view `r`/`c`: resume the live view against the STILL-RUNNING attempt. `c` sets the cancel
  // flag first so the resumed driver POSTs cancel and the operator SEES it take effect (observable
  // confirmation, not a silent successful POST — r1 question 1). Reattach never resets the cancel flag.
  function reattachRestore(attemptId: string): void {
    if (!client) return;
    pollRestore(client, attemptId);
  }

  function performCrashCart(action: CrashCartKeyAction): void {
    if (startingDaemon) return;
    if (action === "details") {
      crashCartOpts = { ...crashCartOpts, unavailableExpanded: !crashCartOpts.unavailableExpanded };
      restoreScrollOffset = 0;
      draw();
      return;
    }
    if (action === "start-daemon") {
      let startArgs: string[];
      try { startArgs = daemonStartArgs(client!.baseUrl); }
      catch (error) {
        crashCartOpts = { unavailable: error instanceof Error ? error.message : String(error) };
        draw();
        return;
      }
      startingDaemon = true;
      crashCartOpts = { ...crashCartOpts, starting: client!.baseUrl };
      draw();
      execFile(cliExecutable, cliArgs(startArgs), { timeout: 30_000 }, (error, stdout, stderr) => {
        startingDaemon = false;
        if (error) {
          crashCartOpts = { unavailable: `Daemon start did not confirm completion. Retry reads actual state before another attempt. ${stderr.trim() || stdout.trim() || error.message}` };
          draw();
        } else {
          void refreshCrashCart();
          void live?.refresh();
        }
      });
      return;
    }
    if (action === "restore") {
      // zero-generation one-click (the gate cleared it) — restore directly.
      runFleetRestore();
      return;
    }
    if (action === "restore-confirm") {
      // H2 — some rig has non-resumable seats: NAME the deltas and arm a confirm (the next ⏎
      // proceeds and fresh-primes them; Esc cancels). Never a silent resume→fresh downgrade.
      const gate = evaluateOneClickGate({
        foundOnHost: (crashCartOpts.crashCart?.foundOnHost ?? []).map((r) => ({
          rigName: r.name,
          seatCount: r.seatCount,
          resumableCount: r.resumableCount,
        })),
      });
      pendingRestoreConfirm = true;
      // Truthful (r2 HIGH-2): describe the awaiting-decision the restore actually produces — never a
      // fresh-prime the parameterless restore does not request. ROUND 10: render it IN the cockpit
      // (crashCartOpts.confirm) — ViewState.notice is not shown in the daemon-down cockpit, so the
      // first ⏎ used to appear to do nothing. The notice is kept as a belt for non-cockpit contexts.
      const confirmMsg = restoreConfirmMessage(gate.deltas);
      crashCartOpts = { ...crashCartOpts, confirm: confirmMsg };
      view.dispatch({ type: "notice", message: confirmMsg });
      draw();
      return;
    }
    if (action === "retry") void refreshCrashCart();
    // inspect / onboarding: entry-point seams (no cockpit notice channel this wave).
  }

  function refreshFromActivity(): void {
    if (enableLive()) void live?.refresh();
  }

  const socketPath = argOf(args, "--socket") ?? defaultSocketPath(instanceId);
  const socket = await createControlSocket({
    socketPath,
    fallbackOnCollision: true,
    view,
    onMutation: () => {
      inputRevision += 1; startup?.interacted();
      if (startup) startup.state.open = false;
      draw();
      refreshFromActivity();
    },
    currentContext: () => commandContext(),
  });

  if (socket.path !== socketPath) controlSocketPath = socket.path;

  // Reuse the CLI's desktop opener and the daemon's node-launch contract.
  // The view-state is only told the outcome.
  async function executeAct(action: Extract<Action, { type: "act" }>): Promise<void> {
    if (!client || startup?.state.connection !== "up") {
      view.dispatch({ type: "notice", message: "Live actions require a confirmed daemon connection. S opens startup; L opens local reading." });
      draw();
      return;
    }
    if (action.act === "open-terminal" && openingTerminal) return;
    try {
      if (action.act === "open-terminal") {
        openingTerminal = true;
        view.dispatch({ type: "notice", message: `Opening terminals for ${action.view}…` });
        draw();
        const result = await openTerminalInWindow(action.view, client.baseUrl, cliEntry, action.expectedPlan,
          () => view.dispatch({ type: "terminal-preview", view: action.view }));
        const message = terminalWindowNotice(action.view, result);
        view.dispatch({ type: "terminal-result", view: action.view, message });
        view.dispatch({ type: "notice", message });
      } else if (action.act === "run") {
        const result = await client.launchNode(action.rigId, action.agent);
        view.dispatch({ type: "notice", message: launchNodeNotice(action.agent, result) });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (action.act === "open-terminal") view.dispatch({ type: "terminal-result", view: action.view, message });
      view.dispatch({ type: "notice", message: action.act === "open-terminal" ? `Terminal view not confirmed\n${message}` : message });
    } finally {
      if (action.act === "open-terminal") openingTerminal = false;
    }
    draw();
    refreshFromActivity();
  }

  function perform(action: Action): void {
    if (action.type === "print-for-copy") {
      // runCopySession never rejects; while suspended, handleInput and draw return early.
      void runCopySession({
        terminal: processCopyTerminal(), label: action.label, value: action.value,
        setSuspended: (on) => { nativeAttached = on; },
        isShuttingDown: () => shuttingDown,
        notice: (message) => view.dispatch({ type: "notice", message }),
        draw,
      });
      return;
    }
    if (action.type === "act" && action.act === "launch-spec") {
      const launch = view.get().specLaunch;
      if (!launch || nativeAttached) return;
      if (!client) { view.dispatch({ type: "notice", message: "Demo mode: no rig was launched." }); return; }
      try {
        const command = launchProcess(launch, client.baseUrl, process.env, cliExecutable, cliArgs([]));
        view.dispatch({ type: "launch-close" });
        void runSpecLaunch({ command, terminal: processCopyTerminal(),
          pauseInput: () => { process.stdin.pause(); }, resumeInput: () => { process.stdin.resume(); },
          setSuspended: on => { nativeAttached = on; launching = on; }, isShuttingDown: () => shuttingDown,
          notice: message => view.dispatch({ type: "notice", message }), draw,
        }).catch(error => view.dispatch({ type: "notice", message: String(error) }));
      } catch (err) { view.dispatch({ type: "notice", message: (err as Error).message }); }
      return;
    }
    if (action.type === "act") {
      view.dispatch({ type: "notice", message: `${action.act}…` });
      void executeAct(action);
      return;
    }
    if (startup?.state.open && !["palette-open", "palette-close", "notice", "error", "time-setting"].includes(action.type)) {
      startup.state.open = false; startup.state.consent = undefined;
    }
    view.dispatch(action);
    if (!["palette-open", "palette-close", "time-setting"].includes(action.type)) refreshFromActivity();
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    process.stdout.off("resize", draw);
    if (motionTimer) clearTimeout(motionTimer);
    live?.close();
    unsubscribeCopyMode();
    process.stdout.write(PASTE_DISABLE + MOUSE_DISABLE + ALT_SCREEN_OFF);
    await socket.close();
    activityEvents?.close();
    process.exit(0);
  }
  process.stdout.on("resize", draw);
  // In cooked mode Ctrl-C reaches both us and rig up. Let the child stop while
  // keeping its result and the Enter-to-return prompt available in this TUI.
  process.on("SIGINT", () => { if (!launching) void shutdown(); });
  process.on("SIGTERM", () => void shutdown());

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  function handleInput(events: ReturnType<typeof inputDecoder.write>): void {
    if (nativeAttached) return;
    for (const ev of events) {
      inputRevision += 1; startup?.interacted();
      // The bound endpoint's copy label remains usable in startup/palette/restore
      // contexts, whose input handlers otherwise consume the status-row click.
      if (ev.type === "mouse" && ev.button === 0 && lastScreen) {
        const hit = lastScreen.hitMap.find((h) => h.y === ev.y && ev.x >= h.x1 && ev.x <= h.x2);
        if (hit?.action.type === "print-for-copy" && hit.action.value === socket.path) {
          perform(hit.action);
          return;
        }
      }
      if (startup?.state.open && !view.get().palette) {
        if (ev.type === "char" && ev.ch === "q") { void shutdown(); return; }
        if (ev.type === "char") void startup.key(ev.ch);
        else if (ev.type === "key") void startup.key(ev.key);
        else if (ev.type === "mouse" && ev.button === 0 && lastScreen) {
          const hit = lastScreen.hitMap.find((h) => h.y === ev.y && ev.x >= h.x1 && ev.x <= h.x2);
          if (hit?.action.type === "startup") void startup.key(hit.action.key);
        }
        continue;
      }
      if (!view.get().palette && ev.type === "char" && inputLine === "") {
        if (ev.ch === "?") { view.dispatch({ type: "palette-open" }); continue; }
        if (ev.ch === "S") { void startup?.open(); continue; }
        if (ev.ch === "L" && startup) { startup.state.open = true; void startup.key("L"); continue; }
      }
      if (crashCartOpts.unavailable && !crashCartOpts.restore && !view.get().palette) {
        if (ev.type === "char" && ev.ch === "q") { void shutdown(); return; }
        if (ev.type === "char") {
          const action = resolveCrashCartKey(ev.ch, crashCartOpts);
          if (action) performCrashCart(action);
        }
        if (ev.type === "key" && (ev.key === "up" || ev.key === "down")) {
          restoreScrollOffset = Math.max(0, Math.min(lastScreen?.contentMaxOffset ?? 0,
            restoreScrollOffset + (ev.key === "down" ? 1 : -1)));
        }
        continue;
      }
      if (!(ev.type === "key" && ev.key === "tab")) completion = null;
      // REGISTRY I3 — palette mode captures input while open. Execution is BYTE-EQUAL to
      // direct typing: an argless selection runs perform(parseCommand(line)) — the exact
      // BR-9 one-resolver path the command bar uses; argful selections PRE-FILL the bar.
      const pal = view.get().palette;
      if (pal) {
        if (ev.type === "paste") { view.dispatch({ type: "palette-query", query: pal.query + ev.text }); continue; }
        if (ev.type === "char") {
          view.dispatch({ type: "palette-query", query: pal.query + ev.ch });
          continue;
        }
        if (ev.type === "key" && ev.key === "backspace") {
          view.dispatch({ type: "palette-query", query: [...pal.query].slice(0, -1).join("") });
          continue;
        }
        if (ev.type === "key" && (ev.key === "up" || ev.key === "down")) {
          view.dispatch({ type: "palette-move", delta: ev.key === "down" ? 1 : -1 });
          continue;
        }
        if (ev.type === "key" && ev.key === "escape") {
          view.dispatch({ type: "palette-close" });
          continue;
        }
        if (ev.type === "key" && ev.key === "enter") {
          const rows = filterPalette(pal.query, COMMAND_REGISTRY, commandContext());
          const row = rows[Math.min(pal.selection, Math.max(0, rows.length - 1))];
          view.dispatch({ type: "palette-close" });
          if (row && row.available) {
            const exec = paletteExecuteLine(row.entry);
            if (exec.mode === "execute") perform(parseCommand(exec.line, view.get().sections));
            else inputLine = exec.line;
          }
          continue;
        }
        continue;
      }
      // An ACTIVE fleet restore owns its keys (takes precedence over cockpit/command-bar). The key→action
      // decision is the PURE restoreKeyAction reducer (r1: every affordance the screen advertises must
      // act in that state); main.ts here is only the executor. Scroll works in EVERY phase, so the
      // "↑↓ scroll" the footer advertises when overflowing is real — and the lifecycle action row below
      // the fold on a large fleet is reachable.
      if (crashCartOpts.restore) {
        const rvm = crashCartOpts.restore;
        const action = restoreKeyAction(ev as RestoreInputEvent, {
          phase: rvm.phase,
          cancelled: rvm.cancelled,
          offset: restoreScrollOffset,
          maxOffset: lastScreen?.contentMaxOffset ?? 0,
        });
        switch (action.kind) {
          case "quit":
            void shutdown();
            return;
          case "scroll":
            restoreScrollOffset = action.offset;
            draw();
            continue;
          case "cancel":
            restoreCancelRequested = true;
            view.dispatch({ type: "notice", message: "cancelling after the current rig…" });
            draw();
            continue;
          case "reattach":
            reattachRestore(rvm.attemptId);
            continue;
          case "cancel-reattach":
            restoreCancelRequested = true;
            // r1 LOW: "requested", not "sent" — no POST has happened yet (the reattached driver POSTs,
            // and in the unreachable-daemon case that caused the detach it may not land).
            view.dispatch({ type: "notice", message: "cancel requested — reattaching to confirm…" });
            reattachRestore(rvm.attemptId);
            continue;
          case "dismiss":
            crashCartOpts = { ...crashCartOpts, restore: undefined };
            void refreshCrashCart();
            continue;
          case "none":
            continue; // swallowed while the fleet restores
        }
      }
      if (ev.type === "paste") {
        inputLine += ev.text;
        continue;
      }
      if (ev.type === "key" && ev.key === "tab") {
        if (!crashCartOpts.daemonState) {
          completion = completeCommand(inputLine, { state: view.get(), snapshot }, commandContext());
          inputLine = completion.line;
        }
        continue;
      }
      if (ev.type === "char") {
        if (ev.ch === "v" && inputLine === "") {
          perform(parseCommand("select-text", view.get().sections));
          continue;
        }
        // SCOPES accelerators: m/n ride the REGISTERED commands (one path).
        if (inputLine === "" && view.get().section === "scopes" && view.get().scopesSelected) {
          if (ev.ch === "m") { perform(parseCommand("reqs", view.get().sections)); continue; }
          if (ev.ch === "n") { perform(parseCommand("narrative", view.get().sections)); continue; }
        }
        if (ev.ch === "?" && inputLine === "") {
          // The registered palette trigger — through the grammar, never beside it.
          perform(parseCommand("?", view.get().sections));
          continue;
        }
        if (ev.ch === "q" && inputLine === "") {
          void shutdown();
          return;
        }
        if (ev.ch === "f" && inputLine === "") {
          view.dispatch({ type: "footer" });
          continue;
        }
        // 5.2 crash-cart: while a daemon-down screen is active, single keys are cockpit actions
        // (s/i/n/r), not command-bar input.
        if ((crashCartOpts.daemonState || crashCartOpts.unavailable) && inputLine === "") {
          const cca = resolveCrashCartKey(ev.ch, crashCartOpts);
          if (cca) {
            performCrashCart(cca);
            continue;
          }
        }
        if (inputLine === "" && (ev.ch === "j" || ev.ch === "k")) {
          if (lastScreen) {
            const key = ev.ch === "j" ? "down" : "up";
            const delta = key === "down" ? 1 : -1;
            const action = resolveKeyAction(
              { type: "key", key, action: { type: "select", delta } },
              view.get(),
              lastScreen,
              computeExplorerRows(view.get(), snapshot).length,
            );
            if (action) perform(action);
          }
          continue;
        }
        inputLine += ev.ch;
      } else if (ev.type === "key" && ev.key === "backspace") {
        inputLine = [...inputLine].slice(0, -1).join("");
      } else if (ev.type === "key" && ev.key === "escape") {
        if (pendingRestoreConfirm) {
          // H2 — cancel the armed restore confirm (no fresh-prime happens). Clear the cockpit banner.
          pendingRestoreConfirm = false;
          crashCartOpts = { ...crashCartOpts, confirm: undefined };
          view.dispatch({ type: "notice", message: "restore cancelled" });
          draw();
        } else {
          const action = resolveEscapeAction(ev, view.get(), inputLine !== "");
          if (action) perform(action);
        }
        inputLine = "";
      } else if (ev.type === "key" && ev.key === "enter") {
        if (inputLine !== "") {
          perform(parseCommand(inputLine, view.get().sections));
          inputLine = "";
        } else if (pendingRestoreConfirm) {
          // H2 — the operator confirmed the non-zero-generation restore: proceed. Clear the cockpit banner.
          pendingRestoreConfirm = false;
          crashCartOpts = { ...crashCartOpts, confirm: undefined };
          runFleetRestore();
        } else if (crashCartOpts.daemonState) {
          // 5.2 crash-cart: ⏎ is the cockpit primary action (RESTORE EVERYTHING) when daemon-down.
          const cca = resolveCrashCartKey("enter", crashCartOpts);
          if (cca) performCrashCart(cca);
        } else {
          if (lastScreen) {
            const action = resolveKeyAction(ev, view.get(), lastScreen, computeExplorerRows(view.get(), snapshot).length);
            if (action) perform(action);
          }
        }
      } else if (ev.type === "key" && "action" in ev) {
        if (lastScreen) {
          const action = resolveKeyAction(ev, view.get(), lastScreen, computeExplorerRows(view.get(), snapshot).length);
          if (action) perform(action);
        }
      } else if (ev.type === "mouse" && lastScreen) {
        const wheel = resolveMouseAction(ev, view.get(), lastScreen, computeExplorerRows(view.get(), snapshot).length);
        if (wheel) perform(wheel);
        else if (ev.button === 0) {
          const hit = lastScreen.hitMap.find((h) => h.y === ev.y && ev.x >= h.x1 && ev.x <= h.x2);
          if (hit) perform(hit.action);
        }
      }
    }
    draw();
  }

  // A bare Esc keypress is byte-identical to the START of an arrow/mouse sequence, so the
  // decoder holds it. Flush after a short quiet gap (the terminal convention) so the Esc the
  // screens advertise ("esc back", palette close) actually lands instead of waiting for the
  // next keystroke.
  let escapeFlush: NodeJS.Timeout | null = null;
  process.stdin.on("data", (bytes: Buffer) => {
    if (escapeFlush) { clearTimeout(escapeFlush); escapeFlush = null; }
    handleInput(inputDecoder.write(bytes));
    if (inputDecoder.hasPending()) {
      escapeFlush = setTimeout(() => { escapeFlush = null; handleInput(inputDecoder.flush()); }, 50);
    }
  });
  process.stdin.on("end", () => {
    handleInput(inputDecoder.flush());
  });

  process.stdout.write(ALT_SCREEN_ON + MOUSE_ENABLE + PASTE_ENABLE);
  // round-5 (guard): the FIRST terminal frame draws the honest in-flight
  // state — the refresh starts after entering the alt screen, never before,
  // so loading is VISIBLE instead of awaited behind a blank terminal
  draw();
  // Probe the daemon-down verdict once on launch: bare `rig` with the daemon down renders the cockpit.
  // (Key-triggered re-probe after `s start daemon` / `r retry` is the follow-on increment.)
  if (startup) void startup.refresh();
  else void refreshCrashCart();
  // A merely-open TUI must impose no steady-state fleet load. The initial
  // hydrate establishes honest state; navigation, commands, and socket-driven
  // mutations request later truth through the same single-flight owner.
  // Optional data and event subscriptions start only on confirmed live entry.
  void timeSetting.then((setting) => {
    const timezone = resolveTimeZone(setting, timeReadWarning);
    view.dispatch({ type: "time-setting", timeZone: timezone.timeZone, timeZoneWarning: timezone.warning }); draw();
  });
}

run().catch((err: unknown) => {
  process.stdout.write(PASTE_DISABLE + MOUSE_DISABLE + ALT_SCREEN_OFF);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
