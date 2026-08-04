// 0.5.0 — `rig tui`: a NAMED ALIAS for what bare `rig` does (open mission control).
// ZERO NEW BEHAVIOR: it delegates to the front door's `openMissionControl` (probe →
// friendly degrade → resolveTuiPath + launch), the exact path bare `rig` uses — no
// duplicated launch logic. It only adds the same TTY-awareness on stdout: launching
// the interactive TUI into a non-TTY stdout can't render, so it prints the same
// friendly first-impression degrade instead of piping garbage.
import { Command } from "commander";
import { openMissionControl, USAGE_LINES, type FrontDoorIo } from "../front-door.js";

export function tuiCommand(io: FrontDoorIo = {}): Command {
  return new Command("tui")
    .description("open mission control (the interactive terminal UI; same as bare `rig`)")
    .action(async () => {
      const stdoutIsTTY = io.stdoutIsTTY ?? process.stdout.isTTY === true;
      if (!stdoutIsTTY) {
        // Same TTY-awareness on stdout as the bare-`rig` front door — degrade, never
        // launch the interactive TUI into a redirected/piped stdout.
        const err = io.err ?? ((l: string) => process.stderr.write(l + "\n"));
        const exit = io.exit ?? ((c: number) => process.exit(c));
        for (const line of USAGE_LINES) err(line);
        err("");
        err("mission control needs an interactive terminal (stdout is not a TTY)");
        exit(1);
        return;
      }
      await openMissionControl(io);
    });
}
