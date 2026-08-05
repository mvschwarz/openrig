// ATOM-7 (slice-03 rig-context) — STRIP + RENAME grammar pins.
//
// Founder-locked SPEC §5 / §7:
//   - the context-window USAGE VIEWER is KILLED ENTIRELY (remove the command);
//   - bare `rig context` = the library (list/help), full stop;
//   - the `rig context-pack` grammar is RETIRED ENTIRELY — ONE grammar, no
//     deprecated alias, no merged-noun ghost.
//
// These pins drive the REAL assembled top-level program (createProgram) so
// "help clean / no orphan machinery reachable" is proven at the wiring, not
// just at a leaf function.

import { describe, it, expect } from "vitest";
import type { Command } from "commander";
import { createProgram } from "../src/index.js";

const VIEWER_DESCRIPTION_FRAGMENT = "context-usage across running agents";
const LIBRARY_SUBCOMMANDS = ["compose", "list", "show", "preview", "sync", "add", "rm"];

function topLevelNames(program: Command): string[] {
  return program.commands.map((c) => c.name());
}

function contextCmd(program: Command): Command {
  const cmd = program.commands.find((c) => c.name() === "context");
  if (!cmd) throw new Error("no top-level `context` command registered");
  return cmd;
}

describe("ATOM-7 rig context grammar (STRIP viewer + RENAME context-pack)", () => {
  it("(a) VIEWER GONE: `context` is the library, not the usage viewer; no command carries the viewer description", () => {
    const program = createProgram();
    const ctx = contextCmd(program);
    expect(ctx.description()).not.toContain(VIEWER_DESCRIPTION_FRAGMENT);
    // The library description — what `context` now owns.
    expect(ctx.description().toLowerCase()).toContain("context pack");
    // No top-level command anywhere still carries the viewer's description.
    const anyViewer = program.commands.some((c) => c.description().includes(VIEWER_DESCRIPTION_FRAGMENT));
    expect(anyViewer).toBe(false);
  });

  it("(b) HELP CLEAN: top-level lists `context`, never `context-pack`, and help text shows no viewer entry", () => {
    const program = createProgram();
    const names = topLevelNames(program);
    expect(names).toContain("context");
    expect(names).not.toContain("context-pack");
    const help = program.helpInformation();
    expect(help).not.toContain("context-pack");
    expect(help).not.toContain(VIEWER_DESCRIPTION_FRAGMENT);
  });

  it("(c) BARE `rig context` = DELIVERY-FREE LIBRARY: exact ordered subcommands exclude every delivery seam", () => {
    const program = createProgram();
    const context = contextCmd(program);
    const help = context.helpInformation();
    expect(context.commands.map((sub) => sub.name())).toEqual(LIBRARY_SUBCOMMANDS);
    for (const sub of LIBRARY_SUBCOMMANDS) {
      expect(help).toContain(sub);
    }
    expect(context.commands.map((sub) => sub.name())).not.toContain("send");
    expect(help).not.toMatch(/rig context send|^\s*send\b/im);
    expect(help).not.toContain("CONTEXT USAGE");
  });

  it("(d) ALIAS ABSENT: no `context-pack` command; `rig context-pack list` is rejected as unknown", async () => {
    const program = createProgram();
    expect(topLevelNames(program)).not.toContain("context-pack");
    program.exitOverride();
    await expect(
      program.parseAsync(["node", "rig", "context-pack", "list"]),
    ).rejects.toThrow();
  });
});
