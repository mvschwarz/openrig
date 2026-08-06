#!/usr/bin/env node
// Entry: wires the four input adapters (command bar / keyboard / mouse /
// control socket) onto ONE instance-scoped view-state (PIN 1). tmux send-keys
// against this process is the drivability floor and needs no adapter at all —
// keystrokes ARE the keyboard adapter.
//
//   openrig-tui [--instance <id>] [--socket <path>] [--url <daemon>] [--demo]
import { createViewState, computeExplorerRows, emptySnapshot } from "./state.js";
import { parseCommand } from "./grammar.js";
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
    const opts = { cols, rows, nowMs, colorMode: style.mode, ...crashCartOpts, ...(live ? { load: live.load(), rowFlashes: live.flashes() } : {}) };
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
  function performCrashCart(action: CrashCartKeyAction): void {
    if (action === "start-daemon" || action === "restore") {
      execFile("rig", ["daemon", "start"], { timeout: 30_000 }, () => void refreshCrashCart());
      return;
    }
    if (action === "retry") void refreshCrashCart();
    // inspect / onboarding: entry-point seams (no cockpit notice channel this wave).
  }

  const socketPath = argOf(args, "--socket") ?? defaultSocketPath(instanceId);
  const socket = await createControlSocket({ socketPath, view, onMutation: draw });

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
      if (ev.type === "char") {
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
        inputLine = "";
      } else if (ev.type === "key" && ev.key === "enter") {
        if (inputLine !== "") {
          perform(parseCommand(inputLine, view.get().sections));
          inputLine = "";
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
