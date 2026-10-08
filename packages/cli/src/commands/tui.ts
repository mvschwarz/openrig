// Standalone entry shares the bare-rig front door. Shared entry attaches a client
// to the kernel's existing terminal without launching a second TUI.
import { Command } from "commander";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { openMissionControl, USAGE_LINES, type FrontDoorIo } from "../front-door.js";
import { sharedTuiTarget, attachSharedTui } from "../shared-tui.js";

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

export function tuiCommand(io: FrontDoorIo & {
  loadRegistry?: () => Promise<TuiCommandEntry[]>;
  sharedTarget?: () => Promise<string>;
  attachShared?: (target: string) => Promise<number>;
} = {}): Command {
  const cmd = new Command("tui")
    .description("open the status dashboard, not agent chat (--shared is the OpenRig view fallback)")
    .option("--shared", "dashboard-only fallback if the OpenRig view window cannot open; detach with Ctrl-b d")
    .addHelpText("after", "\nThe dashboard shows status and navigation; it is not the operator's or advisor's conversation.\nFor show me my agents, show me the terminals or the OpenRig view: rig terminal open saved:kernel --window. The agent runs it on the daemon desktop; it opens a new terminal tab/window with herdr, otherwise plain tmux. Herdr needs a terminal the person can see; changing this dashboard to :terminals does not open one. Over headless SSH, give the exact connection/attach command for a new terminal/tab, as in the getting-started guide. Check the result and visible content, or say what cannot be verified; on a desktop, do not finish by printing a command for the person to type. Only if the window cannot open, rig tui --shared is the dashboard-only fallback. Explain the failure; not every failure prints an operator attach command. Use the getting-started guide to derive the current operator binding if the person chooses manual attachment. Existing herdr/cmux workspaces can still use --provider without --window.\nThe shared dashboard keeps its view when you detach. On an older kernel, or after quitting the TUI, run rig tui in that terminal once. No agent or terminal is started by --shared.");

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
    .action(async (opts: { shared?: boolean }) => {
      const stdoutIsTTY = io.stdoutIsTTY ?? process.stdout.isTTY === true;
      if (!stdoutIsTTY || (opts.shared && !(io.stdinIsTTY ?? process.stdin.isTTY === true))) {
        // Same TTY-awareness on stdout as the bare-`rig` front door — degrade, never
        // launch the interactive TUI into a redirected/piped stdout.
        const err = io.err ?? ((l: string) => process.stderr.write(l + "\n"));
        const exit = io.exit ?? ((c: number) => process.exit(c));
        for (const line of USAGE_LINES) err(line);
        err("");
        err("mission control needs an interactive terminal (shared entry requires TTY input and output)");
        exit(1);
        return;
      }
      if (opts.shared) {
        const err = io.err ?? ((line: string) => process.stderr.write(line + "\n"));
        const exit = io.exit ?? ((code: number) => process.exit(code));
        try {
          const target = await (io.sharedTarget ?? sharedTuiTarget)();
          err("Joining the shared dashboard, not the operator conversation. For the OpenRig view: rig terminal open saved:kernel --window. This shared dashboard is the fallback if that window cannot open. Ctrl-b d detaches and preserves the view; if a shell is shown, run rig tui once.");
          const code = await (io.attachShared ?? attachSharedTui)(target);
          if (code !== 0) err("Could not attach the kernel terminal. Inspect rig ps --nodes --rig kernel and rig status; standalone: rig tui.");
          exit(code);
        } catch (error) {
          err(error instanceof Error ? error.message : String(error));
          exit(1);
        }
        return;
      }
      await openMissionControl(io);
    });

  return cmd;
}
