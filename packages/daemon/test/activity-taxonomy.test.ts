import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTIVITY_VALUES,
  SESSION_PRESENCE_VALUES,
  RESUMABILITY_VALUES,
  deriveDisplayActivity,
  type NeedsInput,
} from "../src/domain/activity-taxonomy.js";

// OPR.0.5.5.19 A1 — the taxonomy IS the vocabulary. RED enumeration at base (received
// receipt): surfaces carry surface-local state words — terminalActive boolean
// (SeatActivityService), agentActivity.state "running|needs_input|idle|unknown"
// (AgentActivityStore, needs_input AS an enum value), hydrate.ts's own inline
// display arbitration, attention_required lifecycle vocab. These pins declare the ONE
// language; the consumption pins (surfaces render from it) land at atom A8.

// repoRoot derived from import.meta.url, never process.cwd() (SOP grep-guard law).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("S19 A1 — the three-axis taxonomy, binding exclusions held", () => {
  it("the activity enum is EXACTLY working | idle-at-prompt | unknown — needs-input and attention are NOT status values", () => {
    expect([...ACTIVITY_VALUES].sort()).toEqual(["idle-at-prompt", "unknown", "working"]);
    for (const banned of ["needs-input", "needs_input", "attention", "blocked", "waiting"]) {
      expect(ACTIVITY_VALUES.has(banned), `"${banned}" must never be an activity enum value`).toBe(false);
    }
  });

  it("unknown is first-class: a member of the enum, not an error state", () => {
    expect(ACTIVITY_VALUES.has("unknown")).toBe(true);
  });

  it("the session axis is present | detached | exited | absent, orthogonal to activity", () => {
    expect([...SESSION_PRESENCE_VALUES].sort()).toEqual(["absent", "detached", "exited", "present"]);
    for (const v of SESSION_PRESENCE_VALUES) expect(ACTIVITY_VALUES.has(v)).toBe(false);
  });

  it("the resumability axis is live | resumable | context-walled, orthogonal to both", () => {
    expect([...RESUMABILITY_VALUES].sort()).toEqual(["context-walled", "live", "resumable"]);
    for (const v of RESUMABILITY_VALUES) {
      expect(ACTIVITY_VALUES.has(v)).toBe(false);
      expect(SESSION_PRESENCE_VALUES.has(v)).toBe(false);
    }
  });

  it("needs-input rides as count+reason and only the DISPLAY bridge may render it (the addendum's human-facing value)", () => {
    const none: NeedsInput = { count: 0, reason: null };
    const two: NeedsInput = { count: 2, reason: "permission prompt" };
    // count=0: the display is the activity value itself.
    expect(deriveDisplayActivity("working", none)).toBe("working");
    expect(deriveDisplayActivity("idle-at-prompt", none)).toBe("idle");
    expect(deriveDisplayActivity("unknown", none)).toBe("unknown");
    // count>0: the display renders needs-input WITHOUT it ever being an enum value.
    expect(deriveDisplayActivity("idle-at-prompt", two)).toBe("needs-input");
    expect(deriveDisplayActivity("working", two)).toBe("needs-input"); // chrome outranks self-report for this signal
  });

  it("deriveDisplayActivity refuses a non-taxonomy activity value loudly (no silent vocabulary widening)", () => {
    expect(() => deriveDisplayActivity("running", { count: 0, reason: null })).toThrow(/taxonomy/);
    expect(() => deriveDisplayActivity("needs_input", { count: 0, reason: null })).toThrow(/taxonomy/);
  });
});

describe("S19 A1 — the reference doc is canonical and pins the rejects", () => {
  const docPath = join(repoRoot, "docs", "reference", "agent-state-taxonomy.md");

  it("docs/reference/agent-state-taxonomy.md exists", () => {
    expect(existsSync(docPath)).toBe(true);
  });

  it("the public doc declares itself canonical and points at the typed source of truth (no fork)", () => {
    const doc = readFileSync(docPath, "utf8");
    expect(doc).toContain("This document is the canonical text for the shipped taxonomy");
    expect(doc).toContain("packages/daemon/src/domain/activity-taxonomy.ts");
  });

  it("the doc carries the dated reject receipts: transcript-quiescence and pane-scraping-as-primary", () => {
    const doc = readFileSync(docPath, "utf8");
    expect(doc).toMatch(/transcript[- ]quiescence/i);
    expect(doc).toMatch(/pane[- ]scraping/i);
    expect(doc).toContain("2026-08-26"); // dated receipts, not folklore
    // The permitted different-purpose consumer is cited so the reject cannot over-reach:
    expect(doc).toMatch(/refocus/i);
  });

  it("the doc carries the reconciliation table (ours vs herdr vs omnigent)", () => {
    const doc = readFileSync(docPath, "utf8");
    expect(doc).toMatch(/herdr/i);
    expect(doc).toMatch(/omnigent/i);
  });

  it("the doc states PARKED as a derived diagnosis and HELD as its deliberate counterpart", () => {
    const doc = readFileSync(docPath, "utf8");
    expect(doc).toMatch(/PARKED/);
    expect(doc).toMatch(/HELD/);
    expect(doc).toMatch(/derived/i);
  });
});
