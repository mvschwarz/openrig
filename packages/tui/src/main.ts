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
import { createControlSocket, defaultSocketPath } from "./socket-server.js";
import { demoSnapshot } from "./demo-data.js";
import { DaemonClient } from "./daemon-client.js";
import { hydrateSnapshot } from "./hydrate.js";
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
  const inputDecoder = createInputDecoder();
  let inputFlushTimer: NodeJS.Timeout | null = null;

  function draw(): void {
    const cols = process.stdout.columns ?? 120;
    const rows = process.stdout.rows ?? 32;
    lastScreen = renderScreen(view.get(), snapshot, { cols, rows }, inputLine);
    if (view.get().contentMaxOffset !== lastScreen.contentMaxOffset || view.get().contentTargetCount !== lastScreen.contentTargets.length) {
      view.dispatch({ type: "layout", contentMaxOffset: lastScreen.contentMaxOffset, contentTargetCount: lastScreen.contentTargets.length });
      lastScreen = renderScreen(view.get(), snapshot, { cols, rows }, inputLine);
    }
    process.stdout.write("\x1b[H" + lastScreen.lines.map((l) => "\x1b[2K" + l).join("\r\n"));
  }

  const socketPath = argOf(args, "--socket") ?? defaultSocketPath(instanceId);
  const socket = await createControlSocket({ socketPath, view, onMutation: draw });

  let refreshTimer: NodeJS.Timeout | null = null;
  if (client) {
    const reviewCache: SpecReviewCache = new Map();
    const refresh = async () => {
      snapshot = await hydrateSnapshot(client, reviewCache);
      draw();
    };
    await refresh();
    refreshTimer = setInterval(() => void refresh(), REFRESH_MS);
  }

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
        await client.launchNode(action.rigId, action.agent);
        view.dispatch({ type: "notice", message: `agent run requested: ${action.agent}` });
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
        inputLine += ev.ch;
      } else if (ev.type === "key" && ev.key === "backspace") {
        inputLine = inputLine.slice(0, -1);
      } else if (ev.type === "key" && ev.key === "escape") {
        inputLine = "";
      } else if (ev.type === "key" && ev.key === "enter") {
        if (inputLine !== "") {
          perform(parseCommand(inputLine, view.get().sections));
          inputLine = "";
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
    if (inputFlushTimer) clearTimeout(inputFlushTimer);
    handleInput(inputDecoder.write(bytes));
    if (inputDecoder.hasPending()) {
      inputFlushTimer = setTimeout(() => {
        inputFlushTimer = null;
        handleInput(inputDecoder.flush());
      }, 25);
    }
  });

  process.stdout.write(ALT_SCREEN_ON + MOUSE_ENABLE);
  draw();
}

run().catch((err: unknown) => {
  process.stdout.write(MOUSE_DISABLE + ALT_SCREEN_OFF);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
