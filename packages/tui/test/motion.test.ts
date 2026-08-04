// ROUND-3 mr7 — the MOTION design language mechanics (sign-off = open item c;
// these pins cover the MECHANICS + discipline: reduced-motion everywhere,
// max ONE persistent animation per region, honest fallbacks).
import { describe, it, expect } from "vitest";
import { reducedMotion, spinnerFrame, flashActive, barCells } from "../src/motion.js";
import { createViewState } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import { demoSnapshot } from "../src/demo-data.js";

describe("motion primitives", () => {
  it("reducedMotion honors the env kill-switch", () => {
    expect(reducedMotion({ OPENRIG_REDUCED_MOTION: "1" })).toBe(true);
    expect(reducedMotion({ REDUCED_MOTION: "1" })).toBe(true);
    expect(reducedMotion({})).toBe(false);
  });

  it("spinner: braille frames in truecolor/256, line frames at 16-color, STATIC dot under reduced motion", () => {
    expect(spinnerFrame(0, "truecolor", false)).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(spinnerFrame(1, "truecolor", false)).not.toBe(spinnerFrame(0, "truecolor", false)); // animates
    expect(spinnerFrame(0, "16", false)).toMatch(/[|\/\-\\]/); // 16-color fallback
    expect(spinnerFrame(5, "truecolor", true)).toBe("·"); // reduced: static, honest
  });

  it("flashActive is ONE-SHOT: true within the window, false after, never under reduced motion", () => {
    expect(flashActive(1000, 1300, 600, false)).toBe(true);
    expect(flashActive(1000, 1700, 600, false)).toBe(false);
    expect(flashActive(1000, 1300, 600, true)).toBe(false);
  });

  it("barCells renders REAL fractions only — null/NaN gives no bar, never a fabricated fill", () => {
    expect(barCells(0.5, 10)).toBe("█████░░░░░");
    expect(barCells(0, 10)).toBe("░░░░░░░░░░");
    expect(barCells(1, 10)).toBe("██████████");
    expect(barCells(null, 10)).toBe("");
    expect(barCells(Number.NaN, 10)).toBe("");
  });
});

describe("motion wiring + region discipline", () => {
  const snap = demoSnapshot();
  it("the needs-you ⚑ glyph carries the slow attention-pulse (blink) — the ONLY persistent motion in that region", () => {
    const s = createViewState({ instanceId: "m", getSnapshot: () => snap });
    s.dispatch({ type: "jump", section: "needs" });
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 34 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const needsRow = styled.find((l) => stripAnsi(l).includes("⚑"))!;
    expect(needsRow, "pulse on the needs-you glyph").toMatch(/\x1b\[[0-9;]*5;[0-9;]*m⚑|\x1b\[5m⚑/);
    // discipline: the ⚑ is the only blinking cell on that row
    expect((needsRow.match(/\[[0-9;]*5;[0-9;]*m/g) ?? []).length).toBeLessThanOrEqual(1);
    styled.forEach((l, i) => expect(stripAnsi(l)).toBe(screen.lines[i]));
  });

  it("the detail context line shows a quiet DETERMINATE bar for the real ctx fraction (and none when unknown)", () => {
    const s = createViewState({ instanceId: "m2", getSnapshot: () => snap });
    s.dispatch({ type: "drill", resource: "agent", name: "dev50.driver", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
    const body = renderScreen(s.get(), snap, { cols: 150, rows: 40 }).lines.join("\n");
    expect(body).toMatch(/62% used[^\n]*[█░]{10}/); // driver ctx 62 → a real 10-cell bar
    const s2 = createViewState({ instanceId: "m3", getSnapshot: () => snap });
    s2.dispatch({ type: "drill", resource: "agent", name: "dev50.qa", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
    const body2 = renderScreen(s2.get(), snap, { cols: 150, rows: 40 }).lines.join("\n");
    expect(body2).not.toMatch(/— \(not yet known\)[^\n]*█/); // no fabricated bar
  });

  it("max ONE persistent animation in the command-bar region: exactly the cursor blink", () => {
    const s = createViewState({ instanceId: "m4", getSnapshot: () => snap });
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 34 }, "rig x");
    const styled = stylizeLines(screen, createStyle("truecolor"));
    expect((styled[0]!.match(/\[[0-9;]*5;[0-9;]*m|\[5m/g) ?? []).length).toBe(1);
  });
});

describe("motion rides the LOAD LIFECYCLE — guard round-5 finding 1 (spinner = real in-flight state, never data absence)", () => {
  const snap = demoSnapshot();
  const LOADING = { inFlight: true, settled: false } as const;
  function graphTabStore(base = snap) {
    const noGraph = structuredClone(base);
    const s = createViewState({ instanceId: "sp", getSnapshot: () => noGraph });
    s.dispatch({ type: "tab", tab: "graph" });
    return { s, noGraph };
  }

  it("IN-FLIGHT + unanswered graph: the spinner renders and ANIMATES, marking the screen motion-active", () => {
    const { s, noGraph } = graphTabStore();
    const at = (nowMs: number) =>
      renderScreen(s.get(), noGraph, { cols: 140, rows: 34, nowMs, colorMode: "truecolor", load: LOADING }).lines.find((l) => l.includes("read pending"))!;
    const f0 = at(0);
    const f1 = at(120);
    expect(f0).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] topology graph read pending/);
    expect(f1).not.toBe(f0); // frame/time transition
    const screen = renderScreen(s.get(), noGraph, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor", load: LOADING });
    expect(screen.motionActive).toBe(true); // the entry loop keeps redrawing while loading
  });

  it("SETTLED absence does NOT spin: proven-empty renders a static honest-empty line (default options = settled)", () => {
    const { s, noGraph } = graphTabStore();
    const screen = renderScreen(s.get(), noGraph, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor" });
    const line = screen.lines.find((l) => l.includes("topology graph"))!;
    expect(line).toMatch(/no topology graph served/);
    expect(line).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏·] /);
    expect(screen.motionActive).toBeFalsy(); // nothing animates over settled truth
  });

  it("SETTLED NAMED read failure does not spin: the graph line reports the failure statically", () => {
    const { s, noGraph } = graphTabStore();
    noGraph.readErrors.push("graph(openrig-build): fetch failed");
    const screen = renderScreen(s.get(), noGraph, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor" });
    const line = screen.lines.find((l) => l.includes("topology graph"))!;
    expect(line).toMatch(/✕ topology graph read failed/);
    expect(line).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(screen.motionActive).toBeFalsy();
  });

  it("SPECS: in-flight spins, settled proven-empty and settled named failure render static", () => {
    const empty = structuredClone(snap);
    empty.specs = [];
    const s = createViewState({ instanceId: "sl", getSnapshot: () => empty });
    s.dispatch({ type: "jump", section: "specs" });
    const loading = renderScreen(s.get(), empty, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor", load: LOADING }).lines.join("\n");
    expect(loading).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] library read pending/);
    const settled = renderScreen(s.get(), empty, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor" });
    expect(settled.lines.join("\n")).toMatch(/library empty — proven/);
    expect(settled.motionActive).toBeFalsy();
    empty.readErrors.push("specs-library: boom");
    const failed = renderScreen(s.get(), empty, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor" });
    expect(failed.lines.join("\n")).toMatch(/✕ library read failed/);
    expect(failed.motionActive).toBeFalsy();
  });

  it("HUMAN-QUEUE: in-flight spins with '(read pending)'; a settled unprobed state renders static without it", () => {
    const unprobed = { ...structuredClone(snap), humanQueueProbed: false, needs: [] };
    const s = createViewState({ instanceId: "hq", getSnapshot: () => unprobed });
    s.dispatch({ type: "jump", section: "needs" });
    const loading = renderScreen(s.get(), unprobed, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor", load: LOADING }).lines.join("\n");
    expect(loading).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] human-queue: not yet known \(read pending\)/);
    const settled = renderScreen(s.get(), unprobed, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor" });
    const line = settled.lines.find((l) => l.includes("human-queue"))!;
    expect(line).toMatch(/human-queue: not yet known/);
    expect(line).not.toMatch(/read pending|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(settled.motionActive).toBeFalsy();
  });

  it("16-color in-flight renders the LINE spinner; reduced motion renders the honest static dot and no motion-active", () => {
    const { s, noGraph } = graphTabStore();
    const line16 = renderScreen(s.get(), noGraph, { cols: 140, rows: 34, nowMs: 0, colorMode: "16", load: LOADING }).lines.find((l) => l.includes("read pending"))!;
    expect(line16).toMatch(/[|/\-\\] topology graph read pending/);
    process.env["OPENRIG_REDUCED_MOTION"] = "1";
    try {
      const reduced = renderScreen(s.get(), noGraph, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor", load: LOADING });
      expect(reduced.lines.find((l) => l.includes("read pending"))!).toMatch(/· topology graph read pending/);
      expect(reduced.motionActive).toBeFalsy();
    } finally {
      delete process.env["OPENRIG_REDUCED_MOTION"];
    }
  });

  it("region discipline: while a ⚑ pulse is visible on the needs page, the IN-FLIGHT spinner degrades to the static dot", () => {
    const probing = { ...structuredClone(snap), humanQueueProbed: false };
    const s = createViewState({ instanceId: "rd", getSnapshot: () => probing });
    s.dispatch({ type: "jump", section: "needs" });
    const screen = renderScreen(s.get(), probing, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor", load: LOADING });
    const pending = screen.lines.find((l) => l.includes("not yet known"))!;
    expect(pending).toMatch(/· human-queue: not yet known/); // static — the ⚑ pulse owns the region's one persistent animation
    expect(pending).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });
});

describe("fresh pane-output ROW FLASH — guard round-5 finding 2 (exact agent row, never the ambient stream footer)", () => {
  const snap = demoSnapshot();
  const DRIVER_KEY = "agent:vm-host/openrig-build/dev50/dev50.driver";
  // inverse = a STANDALONE SGR param 7 (never the 7 inside e.g. 77;189;178)
  const INVERSE = /\x1b\[(?:[0-9;]+;)?7(?:;[0-9;]+)?m/;
  function agentRowsStore() {
    const s = createViewState({ instanceId: "fl", getSnapshot: () => snap });
    // drilling the pod auto-expands it — agent rows become visible explorer rows
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } });
    return s;
  }

  it("an in-window flash inverse-paints EXACTLY the flashed agent's explorer row and marks motion-active", () => {
    const s = agentRowsStore();
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 34, nowMs: 1300, rowFlashes: [{ key: DRIVER_KEY, at: 1000 }] });
    expect(screen.flashRows).toHaveLength(1);
    const y = screen.flashRows![0]!;
    expect(screen.lines[y - 1]).toContain("dev50.driver"); // exact-row targeting
    expect(screen.motionActive).toBe(true); // the expiry redraw is scheduled off this
    const styled = stylizeLines(screen, createStyle("truecolor"));
    expect(styled[y - 1]!, "flash = inverse video on the agent row").toMatch(INVERSE);
    const guardRow = screen.lines.findIndex((l) => l.includes("dev50.guard"));
    expect(styled[guardRow]!).not.toMatch(INVERSE); // sibling rows untouched
    styled.forEach((l, i) => expect(stripAnsi(l)).toBe(screen.lines[i]));
  });

  it("the flash is ONE-SHOT: past the window it is gone; reduced motion never flashes", () => {
    const s = agentRowsStore();
    const after = renderScreen(s.get(), snap, { cols: 140, rows: 34, nowMs: 1700, rowFlashes: [{ key: DRIVER_KEY, at: 1000 }] });
    expect(after.flashRows ?? []).toHaveLength(0);
    // the driver's OWN row is back to normal paint (the content-pane selection
    // bar legitimately uses inverse elsewhere — scope the pin to the row)
    const driverIdx = after.lines.findIndex((l) => l.includes("dev50.driver"));
    expect(stylizeLines(after, createStyle("truecolor"))[driverIdx]!).not.toMatch(INVERSE);
    process.env["OPENRIG_REDUCED_MOTION"] = "1";
    try {
      const reduced = renderScreen(s.get(), snap, { cols: 140, rows: 34, nowMs: 1300, rowFlashes: [{ key: DRIVER_KEY, at: 1000 }] });
      expect(reduced.flashRows ?? []).toHaveLength(0);
    } finally {
      delete process.env["OPENRIG_REDUCED_MOTION"];
    }
  });

  it("the ambient rig-stream footer ticker NEVER inverse-flashes (round-4 wiring rejected: wrong event source)", () => {
    const s = createViewState({ instanceId: "ft", getSnapshot: () => snap }); // footer ticker is on by default
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 34, nowMs: 1300 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const footerIdx = screen.lines.findIndex((l) => l.startsWith("≋"));
    expect(footerIdx).toBeGreaterThan(0); // the ticker still renders
    expect(styled[footerIdx]!).not.toMatch(INVERSE);
    styled.forEach((l, i) => expect(stripAnsi(l)).toBe(screen.lines[i]));
  });
});
