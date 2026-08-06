import { describe, it, expect } from "vitest";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoCrashCartModel, buildCrashCartModel } from "../src/crash-cart/crash-cart-model.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle, stripAnsi } from "../src/theme.js";

// Crash-cart shell-placement rework (ruling 3c6c2be0) — the cockpit renders as a CONTENT-PANE view
// inside the standard shell: the explorer sidebar is ALWAYS present (│ at EXPL_W), ledger-fed +
// honestly marked daemon-down; the approved content moves into the RIGHT pane verbatim. All rails stand.

const EXPL_W = 30;
const snap = emptySnapshot();
const view = createViewState({ instanceId: "t", getSnapshot: () => snap });

describe("renderScreen daemon-down — in-shell split (explorer always present)", () => {
  const screen = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel() });
  const body = screen.lines.join("\n");

  it("has the explorer│content split (a │ border at EXPL_W on the body rows)", () => {
    const borderRows = screen.lines.filter((l) => l.charAt(EXPL_W) === "│");
    expect(borderRows.length).toBeGreaterThan(3);
  });

  it("ledger-feeds the explorer with the rig names + an honest ledger marker (never a second read)", () => {
    const left = screen.lines.map((l) => l.slice(0, EXPL_W)).join("\n");
    expect(left).toContain("openrig-pm");
    expect(left).toContain("kernel");
    expect(left.toLowerCase()).toContain("ledger"); // honestly marked ledger-sourced
  });

  it("moves the approved cockpit CONTENT into the right pane verbatim (all rails stand)", () => {
    const right = screen.lines.map((l) => l.slice(EXPL_W + 1)).join("\n");
    expect(right).toContain("daemon not running");
    expect(right).toContain("RESTORE EVERYTHING");
    expect(right).toContain("unavailable — no shutdown record"); // honest-null header slot preserved
    expect(right).toContain("WHERE WORK STOPPED");
  });

  it("through stylize: strip-invariant holds + the RESTORE accent bg paints (split-pane path)", () => {
    const styled = stylizeLines(screen, createStyle("truecolor"));
    styled.forEach((l, i) => expect(stripAnsi(l)).toBe(screen.lines[i]));
    const restoreIdx = screen.lines.findIndex((l) => l.includes("RESTORE EVERYTHING"));
    expect(styled[restoreIdx]).toMatch(/48;2;/);
  });
});

describe("renderScreen daemon-down — UNVERIFIED in-shell (explorer present, no restore)", () => {
  const screen = renderScreen(view.get(), snap, {
    cols: 120,
    rows: 32,
    daemonState: "unverified",
    daemonEvidence: { pidState: "alive (pid 7)", probeResult: "timeout", failedSignal: "healthz timed out" },
  });
  const body = screen.lines.join("\n");
  it("has the explorer split + the cannot-verify content, and offers NO restore", () => {
    expect(screen.lines.filter((l) => l.charAt(EXPL_W) === "│").length).toBeGreaterThan(3);
    expect(body).toContain("cannot verify the daemon");
    expect(body).toContain("alive (pid 7)");
    expect(body).not.toContain("RESTORE EVERYTHING");
  });
});

describe("renderScreen daemon-down — first-run in-shell (onboarding, no crash story)", () => {
  const screen = renderScreen(view.get(), snap, {
    cols: 120,
    rows: 32,
    daemonState: "down",
    crashCart: buildCrashCartModel({ header: { lastActivityAt: null }, foundOnHost: [], whereWorkStopped: [] }),
  });
  const body = screen.lines.join("\n");
  it("has the shell + onboarding framing, no crash header/RESTORE; explorer marked ledger even with no rigs", () => {
    expect(screen.lines.filter((l) => l.charAt(EXPL_W) === "│").length).toBeGreaterThan(3);
    expect(body).not.toContain("daemon not running");
    expect(body).not.toContain("RESTORE EVERYTHING");
    expect(body.toLowerCase()).toContain("onboarding");
    const left = screen.lines.map((l) => l.slice(0, EXPL_W)).join("\n");
    expect(left.toLowerCase()).toContain("ledger"); // explorer honestly marked even with no rigs
  });
});
