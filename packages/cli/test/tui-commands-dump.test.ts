// REGISTRY I2 (ruling 64f1dbdf, PM pin 2) — `rig tui commands [--json]`: the SERIALIZED
// registry projection; never a hand-maintained list. RED-first pre-implementation.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tuiCommand } from "../src/commands/tui.js";

const PLANTED = [
  { name: "planted-cmd", aliases: ["pc"], args: "<x>", description: "a planted entry", context: "standard", sample: "planted-cmd x" },
  { name: "always-cmd", aliases: [], args: "", description: "works daemon-down", context: "always", sample: "always-cmd" },
];

describe("rig tui commands — serialized registry projection (I2)", () => {
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { logs = []; logSpy = vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); }); });
  afterEach(() => logSpy.mockRestore());

  it("--json emits the registry entries verbatim (a planted entry appears with zero CLI edits)", async () => {
    const cmd = tuiCommand({ loadRegistry: async () => PLANTED as never });
    await cmd.parseAsync(["node", "rig", "commands", "--json"]);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed).toEqual(PLANTED); // serialized, never hand-maintained
  });

  it("human table renders name, aliases, args, description AND the context field on every row", async () => {
    const cmd = tuiCommand({ loadRegistry: async () => PLANTED as never });
    await cmd.parseAsync(["node", "rig", "commands"]);
    const out = logs.join("\n");
    expect(out).toContain("planted-cmd");
    expect(out).toContain("pc"); // aliases first-class in the dump
    expect(out).toContain("a planted entry");
    expect(out).toContain("standard");
    expect(out).toContain("always"); // context renders on EVERY row (pin 3)
  });
});
