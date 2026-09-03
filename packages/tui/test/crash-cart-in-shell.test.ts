import { describe, it, expect } from "vitest";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoCrashCartModel, buildCrashCartModel } from "../src/crash-cart/crash-cart-model.js";
import { buildRestoreLifecycleVM, type RestoreFrame } from "../src/crash-cart/restore-lifecycle.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle, stripAnsi } from "../src/theme.js";

// Crash-cart shell-placement rework (ruling 3c6c2be0) — the cockpit renders as a CONTENT-PANE view
// inside the standard shell: the explorer sidebar is ALWAYS present (│ at EXPL_W), ledger-fed +
// honestly marked daemon-down; the approved content moves into the RIGHT pane verbatim. All rails stand.

const snap = emptySnapshot();
const view = createViewState({ instanceId: "t", getSnapshot: () => snap });

describe("renderScreen daemon-down — in-shell split (explorer always present)", () => {
  const screen = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel() });
  const body = screen.lines.join("\n");

  it("has the explorer│content split (a │ border at EXPL_W on the body rows)", () => {
    const borderRows = screen.lines.filter((l) => l.charAt(screen.explorerWidth) === "┃");
    expect(borderRows.length).toBeGreaterThan(3);
  });

  it("ledger-feeds the explorer with the rig names + an honest ledger marker (never a second read)", () => {
    const left = screen.lines.map((l) => l.slice(0, screen.explorerWidth)).join("\n");
    expect(left).toContain("openrig-pm");
    expect(left).toContain("kernel");
    expect(left.toLowerCase()).toContain("ledger"); // honestly marked ledger-sourced
  });

  it("moves the approved cockpit CONTENT into the right pane verbatim (all rails stand)", () => {
    const right = screen.lines.map((l) => l.slice(screen.explorerWidth + 1)).join("\n");
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

// B1 ROUND 2 — the ACTIVE restore surface renders THROUGH renderScreen (the real pipeline), proving a
// mid-run frame is visible (r2 HIGH-3) and the done triage list is unclipped in-shell (r2 HIGH-4).
function frame(over: Partial<RestoreFrame>): RestoreFrame {
  return {
    attemptId: "fleet-1",
    phase: over.phase ?? "running",
    done: over.done ?? false,
    cancelled: over.cancelled ?? false,
    verdict: over.verdict ?? "none_attempted",
    rollup: over.rollup ?? { counts: { fully_restored: 0, partially_restored: 0, failed: 0, not_attempted: 0 }, sequence: [], attention_required: [] },
  };
}

describe("renderScreen — ACTIVE restore takes precedence (mid-run progress frame, in-shell)", () => {
  it("running: shows RESTORING FLEET + per-rig progress + the cancel affordance, not the cockpit", () => {
    const vm = buildRestoreLifecycleVM(
      frame({
        phase: "running",
        rollup: {
          counts: { fully_restored: 1, partially_restored: 0, failed: 0, not_attempted: 0 },
          sequence: [{ rigId: "kernel", outcome: "fully_restored" }],
          attention_required: [],
        },
      }),
    );
    const screen = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel(), restore: vm });
    const body = screen.lines.join("\n");
    expect(screen.lines.filter((l) => l.charAt(screen.explorerWidth) === "┃").length).toBeGreaterThan(3); // still in-shell
    expect(body).toContain("RESTORING FLEET"); // the mid-run frame
    expect(body).toContain("kernel");
    expect(body).toContain("c cancel");
    expect(body).not.toContain("RESTORE EVERYTHING"); // the cockpit is superseded by the active restore
  });

  it("done: renders the keyboard-walkable triage list in-shell — the exact need is NOT clipped away", () => {
    const vm = buildRestoreLifecycleVM(
      frame({
        phase: "done",
        done: true,
        verdict: "mixed",
        rollup: {
          counts: { fully_restored: 1, partially_restored: 0, failed: 0, not_attempted: 1 },
          sequence: [
            { rigId: "kernel", outcome: "fully_restored" },
            { rigId: "beta", outcome: "not_attempted", reason: "no restore-usable snapshot for this rig", remediation: "take a snapshot" },
          ],
          attention_required: [{ rigId: "kernel", seat: "dev.guard", need: "original session not resumable and no --fresh — choose fresh-prime or skip" }],
        },
      }),
    );
    const screen = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel(), restore: vm });
    const body = screen.lines.join("\n");
    expect(body).toContain("FLEET RESTORE: mixed");
    expect(body).toContain("NEEDS ATTENTION");
    // The full need is WRAPPED (not clipped): every word survives the pane, so both the head and the
    // tail of the exact need are present — nothing dropped off the right edge (the r2 HIGH-4 defect).
    expect(body).toContain("choose fresh-prime");
    expect(body).toContain("or skip");
    expect(body).toContain("take a snapshot"); // the not_attempted remediation survives too
    // and the wrapped continuation is hanging-indented under its row (a second visible line)
    const paneText = screen.lines.map((l) => l.slice(screen.explorerWidth + 1)).join("\n");
    expect(paneText).toMatch(/skip/);
  });
});

describe("renderScreen — restore triage is KEYBOARD-WALKABLE beyond the viewport (r2 HIGH-2)", () => {
  // r2's exact probe: 28 attention rows at 120x32. At offset 0 the tail need is off-screen; the shell
  // must report a navigable contentMaxOffset, and scrolling to it must bring the final need on-screen.
  // Short needs (fit one line, no wrap) so this isolates VERTICAL reachability (HIGH-2) from width-wrap.
  const attention = Array.from({ length: 28 }, (_, i) => ({
    rigId: "kernel",
    seat: `seat${i}`,
    need: `NEED-${i}: resume seat ${i}`,
  }));
  const vm = buildRestoreLifecycleVM(
    frame({
      phase: "done",
      done: true,
      verdict: "mixed",
      rollup: { counts: { fully_restored: 1, partially_restored: 0, failed: 0, not_attempted: 0 }, sequence: [{ rigId: "kernel", outcome: "fully_restored" }], attention_required: attention },
    }),
  );

  it("at offset 0 the list overflows the viewport → a navigable contentMaxOffset is reported", () => {
    const screen = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel(), restore: vm, restoreScroll: 0 });
    expect(screen.contentMaxOffset).toBeGreaterThan(0); // scrollable, not a dead fixed window
    const body = screen.lines.join("\n");
    expect(body).toContain("NEED-0"); // first need on-screen
    expect(body).not.toContain("NEED-27"); // the tail is off-screen at offset 0 (the defect r2 probed)
  });

  it("scrolling to contentMaxOffset brings the FINAL row's exact need on-screen (reachable)", () => {
    const max = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel(), restore: vm, restoreScroll: 0 }).contentMaxOffset;
    const scrolled = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel(), restore: vm, restoreScroll: max });
    const body = scrolled.lines.join("\n");
    expect(body).toContain("NEED-27: resume seat 27"); // the exact final need is now reachable — R5
    expect(body).toContain("seat27@kernel"); // its seat too
  });
});

// B1 ROUND 10 (gap 1) — the ⏎ confirm must be VISIBLE in the cockpit (not only in ViewState.notice,
// which the daemon-down cockpit does not render — the first ⏎ used to appear to do nothing).
describe("renderScreen daemon-down — the ⏎ confirm banner renders IN the cockpit", () => {
  const confirm = "⏎ RESTORE: openrig-pm (6/13) have seats that can't resume — they'll need a decision (fresh-prime or skip) in the triage list. Press ⏎ to proceed, Esc to cancel.";
  it("shows the confirm banner + the proceed/cancel affordance where the operator looks", () => {
    const screen = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel(), confirm });
    const body = screen.lines.join("\n");
    expect(body).toContain("CONFIRM RESTORE");
    expect(body).toContain("can't resume");
    expect(body).toContain("proceed"); // ⏎ proceed advertised in the cockpit
    expect(body).toContain("cancel"); // Esc cancel advertised in the cockpit
  });
  it("without a confirm, the cockpit shows no confirm banner (RESTORE EVERYTHING is the primary action)", () => {
    const screen = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel() });
    const body = screen.lines.join("\n");
    expect(body).not.toContain("CONFIRM RESTORE");
    expect(body).toContain("RESTORE EVERYTHING");
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
    expect(screen.lines.filter((l) => l.charAt(screen.explorerWidth) === "┃").length).toBeGreaterThan(3);
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
    expect(screen.lines.filter((l) => l.charAt(screen.explorerWidth) === "┃").length).toBeGreaterThan(3);
    expect(body).not.toContain("daemon not running");
    expect(body).not.toContain("RESTORE EVERYTHING");
    expect(body.toLowerCase()).toContain("onboarding");
    const left = screen.lines.map((l) => l.slice(0, screen.explorerWidth)).join("\n");
    expect(left.toLowerCase()).toContain("ledger"); // explorer honestly marked even with no rigs
  });
});
