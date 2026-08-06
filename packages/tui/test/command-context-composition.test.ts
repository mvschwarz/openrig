// REGISTRY I5 — context composition with the C3 detector states: a detector flip changes
// availability IDENTICALLY on every surface (one rule, three projections).
import { describe, it, expect } from "vitest";
import { COMMAND_REGISTRY, serializeCommands, evaluateAvailability, currentCommandContext } from "../src/commands/registry.js";
import { filterPalette } from "../src/commands/palette.js";

describe("detector-state → command context (I5)", () => {
  it("maps C3 states: up/absent=standard, down=crash-cart, unverified=unverified", () => {
    expect(currentCommandContext(null)).toBe("standard");
    expect(currentCommandContext("up")).toBe("standard");
    expect(currentCommandContext("down")).toBe("crash-cart");
    expect(currentCommandContext("unverified")).toBe("unverified");
  });

  it("daemon-down: standard commands go unavailable-with-reason on palette AND socket identically; help stays available", () => {
    const ctx = currentCommandContext("down");
    const socketRows = serializeCommands(ctx);
    const paletteRows = filterPalette("", COMMAND_REGISTRY, ctx);
    for (const e of COMMAND_REGISTRY) {
      const s = socketRows.find((r) => r.name === e.name)!;
      const p = paletteRows.find((r) => r.entry.name === e.name)!;
      expect(p.available).toBe(s.available); // IDENTICAL across surfaces
      expect(p.reason).toBe(s.reason);
      expect(evaluateAvailability(e, ctx).available).toBe(s.available); // one rule
    }
    expect(socketRows.find((r) => r.name === "help")!.available).toBe(true);
    expect(socketRows.find((r) => r.name === "graph")!.available).toBe(false);
    expect(socketRows.find((r) => r.name === "graph")!.reason).toMatch(/standard/);
  });
});
