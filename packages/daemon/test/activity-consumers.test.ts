import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { attachTerminalActivityAndWork } from "../src/domain/node-inventory.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import type Database from "better-sqlite3";
import type { NodeInventoryEntry } from "../src/domain/types.js";

// OPR.0.5.5.19 A8 — consumers render FROM the taxonomy: the enrichment serves the
// arbitrated state with display pre-derived through the ONE bridge; ps/TUI consume the
// served value (grep-guard trace) — no surface re-arbitrates.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SEAT = "node-c1";
const SESSION = "dev50-qa@v-openrig-build";

function entryFor(session: string | null): NodeInventoryEntry {
  return {
    rigId: "r1", rigName: "rig", logicalId: "dev50.qa", podId: null, role: null,
    canonicalSessionName: session, nodeKind: "agent", runtime: "claude-code",
    sessionStatus: "running", startupStatus: "ready", restoreOutcome: null,
    oriented: null, lifecycleState: "running",
  } as unknown as NodeInventoryEntry;
}

function fakeDb(): Database.Database {
  return { prepare: () => ({ all: () => [] }) } as unknown as Database.Database;
}

describe("S19 A8 — the enrichment serves the arbitrated taxonomy state", () => {
  it("activityState carries activity + bridge-derived display + needs-input + decidedBy", () => {
    const clock = { now: 6_000_000 };
    const svc = new SeatActivityService({
      tmux: { readPaneLastActivity: async () => null },
      defaultWindowSeconds: 3,
      now: () => new Date(clock.now),
    });
    svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, {
      adapterId: "claude-code-adapter", runtime: "claude-code",
      rungs: [
        { rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "authoritative" },
        { rung: "needs-input-chrome", lifecycleCoverage: "full", initialTrust: "authoritative" },
      ],
    });
    svc.reportEvidence({
      seatNodeId: SEAT, sessionName: SESSION, rung: "lifecycle-hooks", sourceId: "claude-code:hooks",
      seq: 1, observedAt: new Date(clock.now).toISOString(), activity: "working",
    });
    svc.reportEvidence({
      seatNodeId: SEAT, sessionName: SESSION, rung: "needs-input-chrome", sourceId: "tmux:chrome",
      seq: 2, observedAt: new Date(clock.now).toISOString(), needsInput: { count: 1, reason: "permission prompt" },
    });
    const [enriched] = attachTerminalActivityAndWork([entryFor(SESSION)], { db: fakeDb(), seatActivity: svc });
    const tax = enriched!.activityState!;
    expect(tax.activity).toBe("working");
    expect(tax.display).toBe("needs-input"); // the ONE bridge: count>0 renders needs-input
    expect(tax.needsInput).toEqual({ count: 1, reason: "permission prompt" });
    expect(tax.decidedBy).toBe("lifecycle-hooks");
  });

  it("no oracle state for the seat → activityState null (honest), never fabricated", () => {
    const svc = new SeatActivityService({
      tmux: { readPaneLastActivity: async () => null },
      defaultWindowSeconds: 3,
    });
    const [enriched] = attachTerminalActivityAndWork([entryFor(SESSION)], { db: fakeDb(), seatActivity: svc });
    expect(enriched!.activityState).toBeNull();
  });

  it("no service at all → activityState stays undefined (the pre-taxonomy enrichment shape survives — no flag day)", () => {
    const [enriched] = attachTerminalActivityAndWork([entryFor(SESSION)], { db: fakeDb() });
    expect(enriched!.activityState).toBeUndefined();
    expect(enriched!.terminalActive).toBeUndefined(); // the legacy fields behave exactly as before
  });
});

describe("S19 A8 — consumption trace: the surfaces read the SERVED state (no re-arbitration)", () => {
  it("cli ps renders activityState (taxonomy-first, legacy fallback cited)", () => {
    const src = readFileSync(join(repoRoot, "packages", "cli", "src", "commands", "ps.ts"), "utf8");
    expect(src).toContain("activityState");
    expect(src).toMatch(/Legacy fallback/);
  });

  it("tui hydrate prefers the served display over its inline mixing (which survives only as fallback)", () => {
    const src = readFileSync(join(repoRoot, "packages", "tui", "src", "hydrate.ts"), "utf8");
    expect(src).toContain("activityState");
    expect(src.indexOf("activityState?.display")).toBeGreaterThan(-1);
  });
});
