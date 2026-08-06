import { describe, it, expect } from "vitest";
import { buildLedgerExplorer } from "../src/crash-cart/ledger-explorer.js";

// Crash-cart shell-placement rework (ruling 3c6c2be0) — daemon-down the explorer sidebar is ALWAYS
// present but LEDGER-FED (from the SAME one-JSON discovery — rigs+seats — never a second read path) and
// HONESTLY MARKED as ledger-sourced (the founder's honesty requirement). This is the ledger-explorer
// model the in-pane split's left column renders.

describe("buildLedgerExplorer — ledger-fed rig sidebar (honestly marked)", () => {
  it("one row per rig from the discovery, with seat count, and an honest ledger marker", () => {
    const led = buildLedgerExplorer([
      { rigName: "openrig-pm", seatCount: 13, resumableCount: 7 },
      { rigName: "kernel", seatCount: 4, resumableCount: 4 },
    ]);
    expect(led.ledgerSourced).toBe(true);
    expect(led.note.toLowerCase()).toContain("ledger"); // honestly marked ledger-sourced
    expect(led.rows.map((r) => r.rigName)).toEqual(["openrig-pm", "kernel"]);
    expect(led.rows[0]).toMatchObject({ rigName: "openrig-pm", seatCount: 13 });
    expect(led.rows[0]!.label).toContain("openrig-pm");
  });

  it("empty discovery → no rows, still honestly marked (first-run / no rigs)", () => {
    const led = buildLedgerExplorer([]);
    expect(led.rows).toEqual([]);
    expect(led.ledgerSourced).toBe(true);
    expect(led.note.toLowerCase()).toContain("ledger");
  });
});
