#!/usr/bin/env node
// Entry: wires the four input adapters (command bar / keyboard / mouse /
// control socket) onto ONE instance-scoped view-state (PIN 1). tmux send-keys
// against this process is the drivability floor and needs no adapter at all —
// keystrokes ARE the keyboard adapter.
//
//   openrig-tui [--instance <id>] [--socket <path>] [--url <daemon>] [--demo]
import { createViewState, computeExplorerRows, emptySnapshot } from "./state.js";
import { parseCommand } from "./grammar.js";
import { filterPalette, paletteExecuteLine } from "./commands/palette.js";
import { COMMAND_REGISTRY, currentCommandContext } from "./commands/registry.js";
import { createInputDecoder, resolveKeyAction, MOUSE_ENABLE, MOUSE_DISABLE, ALT_SCREEN_ON, ALT_SCREEN_OFF } from "./input.js";
import { renderScreen } from "./render.js";
import { createStyle, detectColorMode } from "./theme.js";
import { stylizeLines } from "./stylize.js";
import { createControlSocket, defaultSocketPath } from "./socket-server.js";
import { demoSnapshot } from "./demo-data.js";
import { DaemonClient, launchNodeNotice } from "./daemon-client.js";
import { hydrateSnapshot } from "./hydrate.js";
import { createLiveRefresh } from "./live.js";
import { execFile } from "node:child_process";
import { probeCrashCart, type CrashCartRenderOpts } from "./crash-cart/from-emit.js";
import { resolveCrashCartKey, type CrashCartKeyAction } from "./crash-cart/keys.js";
import { driveRestoreEverything } from "./crash-cart/restore-drive.js";
import { parseRestoreRollup, summarizeRestoreRollup } from "./crash-cart/restore-rollup.js";
import { evaluateOneClickGate } from "./crash-cart/one-click-gate.js";
import type { Action, FleetSnapshot, Screen } from "./types.js";
import type { SpecReviewCache } from "./hydrate.js";

const REFRESH_MS = 5000;

function argOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const instanceId = argOf(args, "--instance") ?? "tui-1";
  const demo = args.includes("--demo");

  // --demo renders the labeled fixture; otherwise the §4.A reads hydrate the
  // snapshot (honest-empty until the first read answers; failed reads surface
  // as named readErrors in the status line, never fabricated content).
  let snapshot: FleetSnapshot = demo ? demoSnapshot() : emptySnapshot();
  const view = createViewState({ instanceId, getSnapshot: () => snapshot });
  const client = demo ? null : new DaemonClient({ baseUrl: argOf(args, "--url") });

  let inputLine = "";
  let lastScreen: Screen | null = null;
  // 5.2 crash-cart: the daemon-down verdict (probed from the `rig crash-cart --json` verb). Empty ⇒
  // normal fleet views; DOWN ⇒ the recovery cockpit; UNVERIFIED ⇒ the cannot-verify screen.
  let crashCartOpts: CrashCartRenderOpts = {};
  // H2 — a non-zero-generation ⏎ arms a confirm: the NEXT ⏎ proceeds (fresh-priming the named
  // deltas), Esc cancels. Never a silent one-click resume→fresh downgrade.
  let pendingRestoreConfirm = false;
  const inputDecoder = createInputDecoder();
  const style = createStyle(args.includes("--no-color") ? "none" : detectColorMode());

  // S19 round-5 (guard): the refresh OWNER (live.ts) carries the honest load
  // lifecycle and the per-seat fresh-pane-output events; renderScreen stays
  // pure and takes the clock + owner state as inputs. motionTimer keeps
  // redrawing ONLY while the frame reports live motion (spinner or flash).
  const reviewCache: SpecReviewCache = new Map();
  const live = client
    ? createLiveRefresh({ hydrate: () => hydrateSnapshot(client, reviewCache), onFrame: () => draw(), now: () => Date.now() })
    : null;
  let motionTimer: NodeJS.Timeout | null = null;

  function draw(): void {
    const cols = process.stdout.columns ?? 120;
    const rows = process.stdout.rows ?? 32;
    const nowMs = Date.now();
    if (live) snapshot = live.snapshot();
    const opts = { cols, rows, nowMs, colorMode: style.mode, commandContext: currentCommandContext(crashCartOpts.daemonState ?? null), ...crashCartOpts, ...(live ? { load: live.load(), rowFlashes: live.flashes() } : {}) };
    lastScreen = renderScreen(view.get(), snapshot, opts, inputLine);
    if (view.get().contentMaxOffset !== lastScreen.contentMaxOffset || view.get().contentTargetCount !== lastScreen.contentTargets.length) {
      view.dispatch({ type: "layout", contentMaxOffset: lastScreen.contentMaxOffset, contentTargetCount: lastScreen.contentTargets.length });
      lastScreen = renderScreen(view.get(), snapshot, opts, inputLine);
    }
    // styling is a zero-width post-pass over the tested plain layer — the
    // hitMap coordinates always match what is on screen
    process.stdout.write("\x1b[H" + stylizeLines(lastScreen, style).map((l) => "\x1b[2K" + l).join("\r\n"));
    if (motionTimer) clearTimeout(motionTimer);
    motionTimer = lastScreen.motionActive ? setTimeout(draw, 120) : null;
  }

  // 5.2 crash-cart: probe the daemon-down verdict via the shipped `rig crash-cart --json` verb (its
  // JSON is the truth even on a hint non-zero exit). Any failure → normal TUI (never a fabricated cockpit).
  const runCrashCartVerb = (): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile("rig", ["crash-cart", "--json"], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (stdout && stdout.trim()) resolve(stdout);
        else reject(err ?? new Error("crash-cart: no output"));
      });
    });
  async function refreshCrashCart(): Promise<void> {
    crashCartOpts = await probeCrashCart(runCrashCartVerb);
    draw();
  }
  // Perform a cockpit action key. start-daemon/restore exec `rig daemon start` (the ⏎ flow's `s` step;
  // the C1 batch conductor that RESTORE ultimately drives is EXCLUDED this wave) then re-probe; retry
  // re-probes (UNVERIFIED). inspect/onboarding are entry-point seams this wave.
  // ⏎ RESTORE EVERYTHING drives the C1 batch conductor: the `s` step (start daemon) then
  // `rig crash-cart restore-fleet --json` against it (which polls to completion). The returned
  // rollup is PARSED and surfaced on the notice line (H4 — never discarded), which persists after
  // the daemon comes UP and the cockpit is gone. A start failure never proceeds to restore.
  function runFleetRestore(): void {
    void driveRestoreEverything({
      startDaemon: () =>
        new Promise<void>((resolve, reject) =>
          execFile("rig", ["daemon", "start"], { timeout: 30_000 }, (err) => (err ? reject(err) : resolve())),
        ),
      callRestoreFleet: () =>
        new Promise<string>((resolve) =>
          execFile(
            "rig",
            ["crash-cart", "restore-fleet", "--json"],
            { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
            (_err, stdout) => resolve(stdout ?? ""),
          ),
        ),
    })
      .then((out) => {
        // H4 — surface the rollup + triage + not_attempted reasons on the notice line.
        const model = typeof out === "string" ? parseRestoreRollup(out) : null;
        if (model) view.dispatch({ type: "notice", message: summarizeRestoreRollup(model) });
      })
      .catch(() => {
        /* best-effort: the refreshed cockpit / notice shows the honest post-restore state */
      })
      .finally(() => void refreshCrashCart());
  }

  function performCrashCart(action: CrashCartKeyAction): void {
    if (action === "start-daemon") {
      execFile("rig", ["daemon", "start"], { timeout: 30_000 }, () => void refreshCrashCart());
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
      const names = gate.deltas.map((d) => `${d.rigName} (${d.nonResumable}/${d.seatCount} fresh-primed)`).join(", ");
      pendingRestoreConfirm = true;
      view.dispatch({
        type: "notice",
        message: `⏎ RESTORE will FRESH-PRIME non-resumable seats: ${names}. Press ⏎ to proceed, Esc to cancel.`,
      });
      return;
    }
    if (action === "retry") void refreshCrashCart();
    // inspect / onboarding: entry-point seams (no cockpit notice channel this wave).
  }

  const socketPath = argOf(args, "--socket") ?? defaultSocketPath(instanceId);
  const socket = await createControlSocket({ socketPath, view, onMutation: draw, currentContext: () => currentCommandContext(crashCartOpts.daemonState ?? null) });

  let refreshTimer: NodeJS.Timeout | null = null;

  // Acts are drive-structure daemon WRITES (BR-8/BR-9) — executed here against
  // the two existing contracts; the view-state is only told the outcome.
  async function executeAct(action: Extract<Action, { type: "act" }>): Promise<void> {
    if (!client) {
      view.dispatch({ type: "notice", message: "demo mode: actions disabled" });
      draw();
      return;
    }
    try {
      if (action.act === "open-terminal") {
        const result = await client.openTerminal(action.view);
        view.dispatch({
          type: "notice",
          message: `terminal opened: ${action.view} (${result.opened.length} opened, ${result.absent.length} absent, ${result.degraded.length} degraded)`,
        });
      } else {
        const result = await client.launchNode(action.rigId, action.agent);
        view.dispatch({ type: "notice", message: launchNodeNotice(action.agent, result) });
      }
    } catch (err) {
      view.dispatch({ type: "notice", message: err instanceof Error ? err.message : String(err) });
    }
    draw();
  }

  function perform(action: Action): void {
    if (action.type === "act") {
      view.dispatch({ type: "notice", message: `${action.act}…` });
      void executeAct(action);
      return;
    }
    view.dispatch(action);
  }

  async function shutdown(): Promise<void> {
    if (refreshTimer) clearInterval(refreshTimer);
    if (motionTimer) clearTimeout(motionTimer);
    process.stdout.write(MOUSE_DISABLE + ALT_SCREEN_OFF);
    await socket.close();
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  function handleInput(events: ReturnType<typeof inputDecoder.write>): void {
    for (const ev of events) {
      // REGISTRY I3 — palette mode captures input while open. Execution is BYTE-EQUAL to
      // direct typing: an argless selection runs perform(parseCommand(line)) — the exact
      // BR-9 one-resolver path the command bar uses; argful selections PRE-FILL the bar.
      const pal = view.get().palette;
      if (pal) {
        if (ev.type === "char") {
          view.dispatch({ type: "palette-query", query: pal.query + ev.ch });
          continue;
        }
        if (ev.type === "key" && ev.key === "backspace") {
          view.dispatch({ type: "palette-query", query: pal.query.slice(0, -1) });
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
          const rows = filterPalette(pal.query, COMMAND_REGISTRY, currentCommandContext(crashCartOpts.daemonState ?? null));
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
      if (ev.type === "char") {
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
        if (crashCartOpts.daemonState && inputLine === "") {
          const cca = resolveCrashCartKey(ev.ch, crashCartOpts);
          if (cca) {
            performCrashCart(cca);
            continue;
          }
        }
        inputLine += ev.ch;
      } else if (ev.type === "key" && ev.key === "backspace") {
        inputLine = inputLine.slice(0, -1);
      } else if (ev.type === "key" && ev.key === "escape") {
        if (pendingRestoreConfirm) {
          // H2 — cancel the armed restore confirm (no fresh-prime happens).
          pendingRestoreConfirm = false;
          view.dispatch({ type: "notice", message: "restore cancelled" });
        }
        inputLine = "";
      } else if (ev.type === "key" && ev.key === "enter") {
        if (inputLine !== "") {
          perform(parseCommand(inputLine, view.get().sections));
          inputLine = "";
        } else if (pendingRestoreConfirm) {
          // H2 — the operator confirmed the non-zero-generation restore: proceed (fresh-prime the deltas).
          pendingRestoreConfirm = false;
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
        const hit = lastScreen.hitMap.find((h) => h.y === ev.y && ev.x >= h.x1 && ev.x <= h.x2);
        if (hit) perform(hit.action);
      }
    }
    draw();
  }

  process.stdin.on("data", (bytes: Buffer) => {
    handleInput(inputDecoder.write(bytes));
  });
  process.stdin.on("end", () => {
    handleInput(inputDecoder.flush());
  });

  process.stdout.write(ALT_SCREEN_ON + MOUSE_ENABLE);
  // round-5 (guard): the FIRST terminal frame draws the honest in-flight
  // state — the refresh starts after entering the alt screen, never before,
  // so loading is VISIBLE instead of awaited behind a blank terminal
  draw();
  // Probe the daemon-down verdict once on launch: bare `rig` with the daemon down renders the cockpit.
  // (Key-triggered re-probe after `s start daemon` / `r retry` is the follow-on increment.)
  void refreshCrashCart();
  if (live) {
    void live.refresh();
    refreshTimer = setInterval(() => void live.refresh(), REFRESH_MS);
  }
}

run().catch((err: unknown) => {
  process.stdout.write(MOUSE_DISABLE + ALT_SCREEN_OFF);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
