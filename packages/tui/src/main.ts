#!/usr/bin/env node
// Entry: wires the four input adapters (command bar / keyboard / mouse /
// control socket) onto ONE instance-scoped view-state (PIN 1). tmux send-keys
// against this process is the drivability floor and needs no adapter at all —
// keystrokes ARE the keyboard adapter.
//
//   openrig-tui [--instance <id>] [--socket <path>] [--url <daemon>] [--demo]
import { createViewState, computeExplorerRows, emptySnapshot } from "./state.js";
import { parseCommand } from "./grammar.js";
import { decodeInput, MOUSE_ENABLE, MOUSE_DISABLE, ALT_SCREEN_ON, ALT_SCREEN_OFF } from "./input.js";
import { renderScreen } from "./render.js";
import { createControlSocket, defaultSocketPath } from "./socket-server.js";
import { demoSnapshot } from "./demo-data.js";
import type { FleetSnapshot, Screen } from "./types.js";

function argOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const instanceId = argOf(args, "--instance") ?? "tui-1";
  const demo = args.includes("--demo");

  // Phase 1: the snapshot is honest-empty unless --demo; Phase 2 binds the
  // §4.A daemon reads (DaemonClient) to hydrate it.
  const snapshot: FleetSnapshot = demo ? demoSnapshot() : emptySnapshot();
  const view = createViewState({ instanceId, getSnapshot: () => snapshot });

  let inputLine = "";
  let lastScreen: Screen | null = null;

  function draw(): void {
    const cols = process.stdout.columns ?? 120;
    const rows = process.stdout.rows ?? 32;
    lastScreen = renderScreen(view.get(), snapshot, { cols, rows }, inputLine);
    process.stdout.write("\x1b[H" + lastScreen.lines.map((l) => "\x1b[2K" + l).join("\r\n"));
  }

  const socketPath = argOf(args, "--socket") ?? defaultSocketPath(instanceId);
  const socket = await createControlSocket({ socketPath, view, onMutation: draw });

  async function shutdown(): Promise<void> {
    process.stdout.write(MOUSE_DISABLE + ALT_SCREEN_OFF);
    await socket.close();
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("data", (bytes: Buffer) => {
    for (const ev of decodeInput(bytes)) {
      if (ev.type === "char") {
        if (ev.ch === "q" && inputLine === "") {
          void shutdown();
          return;
        }
        inputLine += ev.ch;
      } else if (ev.type === "key" && ev.key === "backspace") {
        inputLine = inputLine.slice(0, -1);
      } else if (ev.type === "key" && ev.key === "escape") {
        inputLine = "";
      } else if (ev.type === "key" && ev.key === "enter") {
        if (inputLine !== "") {
          view.dispatch(parseCommand(inputLine));
          inputLine = "";
        } else {
          view.dispatch({ type: "activate" });
        }
      } else if (ev.type === "key" && "action" in ev) {
        const action = ev.action;
        if (action.type === "select")
          view.dispatch({ ...action, rowCount: computeExplorerRows(view.get(), snapshot).length });
        else view.dispatch(action);
      } else if (ev.type === "mouse" && lastScreen) {
        const hit = lastScreen.hitMap.find((h) => h.y === ev.y && ev.x >= h.x1 && ev.x <= h.x2);
        if (hit) view.dispatch(hit.action);
      }
    }
    draw();
  });

  process.stdout.write(ALT_SCREEN_ON + MOUSE_ENABLE);
  draw();
}

run().catch((err: unknown) => {
  process.stdout.write(MOUSE_DISABLE + ALT_SCREEN_OFF);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
