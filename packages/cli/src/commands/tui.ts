// 0.5.0 — `rig tui`: a NAMED ALIAS for what bare `rig` does (open mission control).
// ZERO NEW BEHAVIOR: it delegates to the front door's `openMissionControl` (probe →
// friendly degrade → resolveTuiPath + launch), the exact path bare `rig` uses — no
// duplicated launch logic. It only adds the same TTY-awareness on stdout: launching
// the interactive TUI into a non-TTY stdout can't render, so it prints the same
// friendly first-impression degrade instead of piping garbage.
import { Command } from "commander";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { openMissionControl, USAGE_LINES, type FrontDoorIo } from "../front-door.js";

/** The registry-entry shape `rig tui commands` serializes (REGISTRY I2, ruling 64f1dbdf).
 *  Structural mirror of the TUI's CommandEntry data fields (functions are not serialized). */
export interface TuiCommandEntry {
  name: string;
  aliases: string[];
  args: string;
  description: string;
  context: string;
  sample: string;
}

/** Default loader — resolves the TUI's BUILT registry module (the resolveTuiPath
 *  monorepo-first/bundled-fallback pattern) and dynamically imports it. No TUI process,
 *  no new package-dependency edge: dist is the source of truth, same as the launcher. */
async function loadRegistryFromDist(baseDir: string): Promise<TuiCommandEntry[]> {
  const cliBaseDir = path.basename(baseDir) === "commands" ? path.resolve(baseDir, "..") : baseDir;
  const candidates = [
    path.join(path.resolve(cliBaseDir, "../../tui"), "dist/commands/registry.js"),
    path.join(path.resolve(cliBaseDir, "../tui"), "dist/commands/registry.js"),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error("TUI command registry not installed (no tui/dist/commands/registry.js next to this CLI)");
  const mod = (await import(pathToFileURL(found).href)) as { COMMAND_REGISTRY: TuiCommandEntry[] };
  // Serialize the DATA contract only — never hand-maintained (PM pin 2).
  return mod.COMMAND_REGISTRY.map(({ name, aliases, args, description, context, sample }) => ({
    name, aliases, args, description, context, sample,
  }));
}

export function tuiCommand(io: FrontDoorIo & { loadRegistry?: () => Promise<TuiCommandEntry[]> } = {}): Command {
  const cmd = new Command("tui")
    .description("open mission control (the interactive terminal UI; same as bare `rig`)");

  cmd
    .command("commands")
    .description("list every TUI command (serialized from the ONE command registry; --json for agents)")
    .option("--json", "JSON output for agents")
    .action(async (opts: { json?: boolean }) => {
      const load = io.loadRegistry ?? (() => loadRegistryFromDist(import.meta.dirname));
      const entries = await load();
      if (opts.json) {
        console.log(JSON.stringify(entries));
        return;
      }
      // Human table: name/aliases/args/description/context — the context column renders
      // on EVERY row (PM pin 3: honest availability composing with the C3 detector states).
      const w1 = Math.max(...entries.map((e) => (e.name + " " + e.args).trim().length), 7);
      const w2 = Math.max(...entries.map((e) => e.aliases.join(",").length), 7);
      const w3 = Math.max(...entries.map((e) => e.context.length), 7);
      console.log(`${"COMMAND".padEnd(w1)}  ${"ALIASES".padEnd(w2)}  ${"CONTEXT".padEnd(w3)}  DESCRIPTION`);
      for (const e of entries) {
        const cmdCol = (e.name + " " + e.args).trim();
        console.log(`${cmdCol.padEnd(w1)}  ${e.aliases.join(",").padEnd(w2)}  ${e.context.padEnd(w3)}  ${e.description}`);
      }
    });

  cmd
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

  return cmd;
}
