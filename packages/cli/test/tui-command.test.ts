// 0.5.0 — `rig tui` is a NAMED ALIAS of the bare-`rig` front-door mission-control
// path. Zero new behavior: it delegates to the SAME openMissionControl (probe →
// friendly degrade → resolveTuiPath + launch) that bare `rig` uses, with the same
// TTY-awareness on stdout and the same daemon-down degrade. These pins assert the
// shared code path (via injected FrontDoorIo spies), not a mirror.
import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { tuiCommand } from "../src/commands/tui.js";
import { USAGE_LINES } from "../src/front-door.js";

function run(io: Record<string, unknown>) {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(tuiCommand(io));
  return prog.parseAsync(["node", "rig", "tui"]);
}

describe("rig tui — alias of the bare-rig front-door mission-control path (no new behavior)", () => {
  it("daemon UP + TTY stdout → delegates to the SAME launch path (launchTui called, exits its code)", async () => {
    const launchTui = vi.fn(async () => 0);
    const exit = vi.fn();
    await run({ stdoutIsTTY: true, probeDaemon: async () => true, launchTui, exit, err: () => {} });
    expect(launchTui).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("daemon DOWN → identical friendly degrade (same USAGE + 'rig up' line), exit 1, no launch", async () => {
    const launchTui = vi.fn(async () => 0);
    const errs: string[] = [];
    const exit = vi.fn();
    await run({ stdoutIsTTY: true, probeDaemon: async () => false, launchTui, exit, err: (l: string) => errs.push(l) });
    expect(launchTui).not.toHaveBeenCalled();
    expect(errs.join("\n")).toMatch(/daemon not running — try: rig up/);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("stdout NOT a TTY → degrades (same TTY-awareness on stdout), never launches into a pipe", async () => {
    const launchTui = vi.fn(async () => 0);
    const exit = vi.fn();
    await run({ stdoutIsTTY: false, probeDaemon: async () => true, launchTui, exit, err: () => {} });
    expect(launchTui).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("the front-door usage lines register the `rig tui` help text", () => {
    expect(USAGE_LINES.join("\n")).toMatch(/rig tui/);
  });
});
