// S19 ROUND-5 (guard NOT-CLEAR at b92c2a58, qitem e858ee70): motion rides its
// REAL lifecycle/event OWNER. These pins cross the refresh owner itself — the
// component main.ts wires between hydrateSnapshot and the terminal — proving
// start → in-flight → settle, rejection-release/retry, and per-seat
// pane-output event identity (served terminalActive false→true), NOT a
// fabricated render option.
import { describe, it, expect } from "vitest";
import { createLiveRefresh, FLASH_WINDOW_MS } from "../src/live.js";
import { demoSnapshot } from "../src/demo-data.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import type { FleetSnapshot } from "../src/types.js";

const DRIVER_KEY = "agent:vm-host/openrig-build/dev50/dev50.driver";

/** demo snapshot with per-agent served pane-activity (terminalActive verbatim) */
function snapWithPanes(panes: Record<string, boolean | null>): FleetSnapshot {
  const snap = structuredClone(demoSnapshot());
  for (const host of snap.hosts)
    for (const rig of host.rigs)
      for (const pod of rig.pods)
        for (const agent of pod.agents)
          if (agent.name in panes) agent.paneActive = panes[agent.name];
  return snap;
}

function sequenced(snaps: FleetSnapshot[]): () => Promise<FleetSnapshot> {
  let i = 0;
  return () => Promise.resolve(snaps[Math.min(i++, snaps.length - 1)]!);
}

describe("refresh owner — load lifecycle (guard round-5 finding 1)", () => {
  it("refresh START exposes in-flight (drawn immediately) and SETTLE clears it, replacing the snapshot", async () => {
    let release!: (s: FleetSnapshot) => void;
    const gate = new Promise<FleetSnapshot>((r) => { release = r; });
    const frames: Array<{ inFlight: boolean; settled: boolean }> = [];
    const live = createLiveRefresh({ hydrate: () => gate, onFrame: () => frames.push(live.load()), now: () => 0 });
    // before any refresh: nothing has answered yet — un-settled, not in flight
    expect(live.load()).toEqual({ inFlight: false, settled: false });
    const done = live.refresh();
    expect(live.load()).toEqual({ inFlight: true, settled: false });
    expect(frames).toEqual([{ inFlight: true, settled: false }]); // the loading frame IS drawn
    release(demoSnapshot());
    await done;
    expect(live.load()).toEqual({ inFlight: false, settled: true });
    expect(frames).toHaveLength(2); // the settle frame is drawn too
    expect(live.snapshot().hosts.length).toBeGreaterThan(0);
  });

  it("a REJECTED hydrate releases in-flight, keeps the prior snapshot, and a later refresh retries", async () => {
    let fail = true;
    const live = createLiveRefresh({
      hydrate: () => (fail ? Promise.reject(new Error("daemon unreachable")) : Promise.resolve(demoSnapshot())),
      onFrame: () => {},
      now: () => 0,
    });
    await live.refresh(); // must resolve — never an unhandled rejection
    expect(live.load()).toEqual({ inFlight: false, settled: true });
    expect(live.snapshot().hosts).toEqual([]); // prior (empty) retained, nothing fabricated
    fail = false;
    await live.refresh(); // retry path works
    expect(live.snapshot().hosts.length).toBeGreaterThan(0);
  });
});

describe("COLD START root topology through the OWNER — guard round-6 finding 1 (the no-rig branch consumes load truth)", () => {
  const BRAILLE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] topology read pending/;
  function composed(live: ReturnType<typeof createLiveRefresh>, opts?: { colorMode?: "truecolor" | "16" }) {
    // the application's REAL default entry: empty snapshot, default Topology
    // view — exactly what main.ts draws before the first hydrate settles
    const s = createViewState({ instanceId: "cold", getSnapshot: () => live.snapshot() });
    return (nowMs: number) =>
      renderScreen(s.get(), live.snapshot(), { cols: 140, rows: 34, nowMs, colorMode: opts?.colorMode ?? "truecolor", load: live.load() });
  }

  it("a real in-flight cold start renders the braille spinner at the root, ANIMATES across frames, and marks motion-active", async () => {
    let release!: (s: FleetSnapshot) => void;
    const gate = new Promise<FleetSnapshot>((r) => { release = r; });
    const live = createLiveRefresh({ hydrate: () => gate, onFrame: () => {}, now: () => 0 });
    const done = live.refresh();
    const frame = composed(live);
    const f0 = frame(0);
    const l0 = f0.lines.find((l) => l.includes("read pending"))!;
    expect(l0).toMatch(BRAILLE);
    expect(frame(500).lines.find((l) => l.includes("read pending"))!).not.toBe(l0); // approved 2 fps frame phase
    expect(f0.motionActive).toBe(true);
    // 16-color fallback renders the LINE spinner on the same real path
    expect(composed(live, { colorMode: "16" })(0).lines.find((l) => l.includes("read pending"))!).toMatch(/[|/\-\\] topology read pending/);
    release(demoSnapshot());
    await done;
    expect(frame(0).lines.join("\n")).not.toMatch(/read pending/); // settled rigs render, no pending claim
  });

  it("settle-success-EMPTY renders the static proven-no-rigs truth — never 'waiting', never a spinner", async () => {
    const live = createLiveRefresh({ hydrate: () => Promise.resolve(emptySnapshot()), onFrame: () => {}, now: () => 0 });
    await live.refresh();
    const screen = composed(live)(0);
    const line = screen.lines.find((l) => l.includes("no rigs"))!;
    expect(line).toMatch(/no rigs served — proven empty/);
    expect(screen.lines.join("\n")).not.toMatch(/waiting|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(screen.motionActive).toBeFalsy();
  });

  it("settle-NAMED-FAILURE renders the static rigs-summary failure — never 'waiting', never a spinner", async () => {
    const failed = emptySnapshot();
    failed.readErrors.push("rigs-summary: connect ECONNREFUSED");
    const live = createLiveRefresh({ hydrate: () => Promise.resolve(failed), onFrame: () => {}, now: () => 0 });
    await live.refresh();
    const screen = composed(live)(0);
    expect(screen.lines.find((l) => l.includes("rigs read"))!).toMatch(/✕ rigs read failed/);
    expect(screen.lines.join("\n")).not.toMatch(/waiting|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(screen.motionActive).toBeFalsy();
  });

  it("reduced motion renders the honest STATIC loading mark on the in-flight cold start, with no motion-active", async () => {
    let release!: (s: FleetSnapshot) => void;
    const gate = new Promise<FleetSnapshot>((r) => { release = r; });
    const live = createLiveRefresh({ hydrate: () => gate, onFrame: () => {}, now: () => 0 });
    const done = live.refresh();
    process.env["OPENRIG_REDUCED_MOTION"] = "1";
    try {
      const screen = composed(live)(0);
      expect(screen.lines.find((l) => l.includes("read pending"))!).toMatch(/· topology read pending/);
      expect(screen.motionActive).toBeFalsy();
    } finally {
      delete process.env["OPENRIG_REDUCED_MOTION"];
    }
    release(demoSnapshot());
    await done;
  });
});

describe("refresh owner — fresh pane-output event identity (guard round-5 finding 2)", () => {
  it("the FIRST hydrate never flashes: a load is not fresh output", async () => {
    const live = createLiveRefresh({
      hydrate: () => Promise.resolve(snapWithPanes({ "dev50.driver": true, "dev50.guard": true })),
      onFrame: () => {},
      now: () => 1000,
    });
    await live.refresh();
    expect(live.flashes()).toEqual([]);
  });

  it("served terminalActive false→true flashes EXACTLY that agent's row key; true→true and null→true never flash", async () => {
    const live = createLiveRefresh({
      hydrate: sequenced([
        snapWithPanes({ "dev50.driver": false, "dev50.guard": true, "dev50.qa": null }),
        snapWithPanes({ "dev50.driver": true, "dev50.guard": true, "dev50.qa": true }),
      ]),
      onFrame: () => {},
      now: () => 5000,
    });
    await live.refresh();
    await live.refresh();
    expect(live.flashes()).toEqual([{ key: DRIVER_KEY, at: 5000 }]);
  });

  it("the ambient rig-stream tail is NOT a flash source (round-4 wiring rejected: event identity)", async () => {
    const base = snapWithPanes({ "dev50.driver": true });
    const streamed = structuredClone(base);
    streamed.stream.push({ tsEmitted: "2026-08-04T09:00:00Z", sourceSession: "someone@somewhere", body: "ambient chatter" });
    const live = createLiveRefresh({ hydrate: sequenced([base, streamed]), onFrame: () => {}, now: () => 5000 });
    await live.refresh();
    await live.refresh();
    expect(live.flashes()).toEqual([]);
  });

  it("expired flashes are pruned on the next refresh (one-shot, never a growing list)", async () => {
    let now = 0;
    const live = createLiveRefresh({
      hydrate: sequenced([
        snapWithPanes({ "dev50.driver": false }),
        snapWithPanes({ "dev50.driver": true }),
        snapWithPanes({ "dev50.driver": true }),
      ]),
      onFrame: () => {},
      now: () => now,
    });
    await live.refresh();
    now = 100;
    await live.refresh();
    expect(live.flashes()).toEqual([{ key: DRIVER_KEY, at: 100 }]);
    now = 100 + FLASH_WINDOW_MS + 1;
    await live.refresh();
    expect(live.flashes()).toEqual([]);
  });
});
