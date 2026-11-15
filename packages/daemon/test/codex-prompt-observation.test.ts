import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { CODEX_ACTIVITY_RUNG_INVENTORY } from "../src/domain/activity-taxonomy.js";
import { classifyPromptAfterRefusal } from "../src/domain/queue-wake-ladder.js";

// Recorded Codex screens: two native choice prompts (directory trust on 0.156.1, the update prompt on 0.160.0), a complete
// empty composer and a staged draft (0.160.0).
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const TRUST = read("./fixtures/codex-trust-0.156.1.txt");
const UPDATE = read("./fixtures/codex-update-0.160.0.txt");
const IDLE = read("./fixtures/input-box/codex-0.160.0/idle.txt");
const DRAFT = read("./fixtures/input-box/codex-0.160.0/staged-short.J.txt");
// #2500's recorded working frame, as codex-working-queue-oracle.test.ts builds it.
const RECORDED_WORKING = read("./fixtures/input-box/codex-0.160.0/after-enter-0.4s.J.txt");
const WORKING = RECORDED_WORKING.slice(RECORDED_WORKING.indexOf("• Working"))
  .replace(/^• Working.*$/m, "◦ Working已(1h 56m 32s • esc to interrupt · 3 background terminals running")
  .replace(/^  GPT-.*$/m, "  GPT-6.1 Terra high · D:\\workspace");
type Pane = { id: string; pid: number } | undefined;
type Occupant = { paneId: string | null; pid: number | null };

function fixture(first: string) {
  let time = Date.parse("2026-11-11T06:00:00.000Z"), screen = first, pane: Pane = { id: "%5", pid: 4100 };
  let windowRead: number | null = time / 1000 - 60;
  const session = "worker@fixture", node = "node-fixture";
  const structural = new SeatStructuralActivityService({ capturePaneContent: async () => screen } as never, () => new Date(time));
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => windowRead },
    defaultWindowSeconds: 3, now: () => new Date(time), structuralActivity: structural } as never);
  oracle.declareRungInventory({ seatNodeId: node, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY);
  /** The occupant as OpenRig records it (the binding's pane, the process the identity reconciler verified); the sweep
   *  refreshes it every tick. */
  const occupant = (next: Occupant) => oracle.recordCodexOccupant?.(node, next);
  occupant({ paneId: "%5", pid: 4100 });
  /** The sweep's batched capture: the text with the pane and process tmux reported for it in the same call. */
  const capture = async () => structural.pollSeat(session, new Map([[session, { text: screen, capturedAt: new Date(time), ...(pane ? { pane } : {}) }]]),
    "codex", null, new Date(time));
  const tick = async (ms = 1000) => {
    time += ms;
    windowRead = time / 1000 - 60;
    await capture();
    await oracle.pollSeat(session);
  };
  return { oracle, node, session, structural, tick, capture, at: () => new Date(time).toISOString(),
    show: (next: string) => { screen = next; }, pane: (next: Pane) => { pane = next; }, occupant, advance: (ms: number) => { time += ms; },
    failWindowRead: () => { windowRead = null; },
    state: () => oracle.getSeatState(node)!,
    redeclare: () => oracle.declareRungInventory({ seatNodeId: node, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY),
    verdict: (refusedAt: string) => classifyPromptAfterRefusal(oracle.getSeatState(node), refusedAt) };
}

describe("a Codex choice prompt read from the structural frame (#2515)", () => {
  it.each([["directory trust (0.156.1)", TRUST], ["update (0.160.0)", UPDATE]])(
    "a native %s choice reads as needs-input; once answered, an empty composer reads as a clear observed after the refusal", async (_name, choice) => {
      const f = fixture(choice);
      await f.tick();
      expect(f.state()).toMatchObject({ needsInput: { count: 1, reason: "selection_prompt" }, needsInputEvidence: { rung: "needs-input-chrome" } });
      const refusedAt = f.at();
      expect(f.verdict(refusedAt)).toBe("blocked");
      f.show(IDLE);
      await f.tick();
      expect(f.state()).toMatchObject({ needsInput: { count: 0, reason: null }, needsInputEvidence: { rung: "needs-input-chrome" } });
      expect(f.verdict(refusedAt)).toBe("clear");
      // The clear is observed at the capture's start: a refusal after it isn't cleared by it.
      expect(f.verdict(new Date(Date.parse(f.at()) + 1).toISOString())).toBe("unknown");
    });

  it.each([["a staged draft", DRAFT], ["an unrecognised screen", "some provider output\nwith no composer"]])(
    "%s after the choice never clears: the prompt reads unknown again", async (_name, screen) => {
      const f = fixture(TRUST);
      await f.tick();
      const refusedAt = f.at();
      f.show(screen);
      await f.tick();
      expect(f.state().needsInputEvidence).toBeNull();
      expect(f.verdict(refusedAt)).toBe("unknown");
    });

  it("a frame captured before the seat's current inventory isn't used (it may be another occupant's screen)", async () => {
    const f = fixture(IDLE);
    await f.capture();
    f.advance(500);
    // A new occupant's inventory is declared after that capture; no capture has happened since.
    f.redeclare();
    const refusedAt = new Date(Date.parse(f.at()) - 1000).toISOString();
    await f.oracle.pollSeat(f.session); // the sampler reads the cached frame; no new capture
    expect(f.state().needsInputEvidence).toBeNull();
    expect(f.verdict(refusedAt)).toBe("unknown");
    // The next capture is the current occupant's, and counts.
    await f.tick();
    expect(f.verdict(refusedAt)).toBe("clear");
  });

  it("a tracked tool approval keeps its own path: an empty composer doesn't clear a pending tracked request", async () => {
    const f = fixture(IDLE);
    f.oracle.reportEvidence({ seatNodeId: f.node, sessionName: f.session, rung: "lifecycle-hooks", sourceId: "codex:hooks",
      seq: 1, observedAt: f.at(), activity: "working", permissionRequest: { id: "tracked-approval" } } as never);
    const refusedAt = f.at();
    await f.tick();
    // The structural zero is ignored while the request is tracked; its own probe decides it.
    expect(f.state().needsInputEvidence?.rung ?? null).not.toBe("needs-input-chrome");
    expect(f.verdict(refusedAt)).not.toBe("clear");
  });
});

describe("the copied prompt evidence expires where it's read (#2952 R1-F1)", () => {
  const clearedAfterRefusal = async () => {
    const f = fixture(TRUST);
    await f.tick();
    const refusedAt = f.at();
    f.show(IDLE);
    await f.tick();
    expect(f.verdict(refusedAt)).toBe("clear");
    return { f, refusedAt };
  };

  it("on a getter alone, past the structural window with no capture", async () => {
    const { f, refusedAt } = await clearedAfterRefusal();
    f.advance(6000);
    expect(f.verdict(refusedAt)).toBe("unknown");
    expect(f.state().needsInputEvidence).toBeNull();
  });

  it("when the window read fails, past the structural window", async () => {
    const { f, refusedAt } = await clearedAfterRefusal();
    f.advance(6000);
    f.failWindowRead();
    await f.oracle.pollSeat(f.session);
    expect(f.verdict(refusedAt)).toBe("unknown");
  });

  it("when the seat's inventory is declared again, without any new capture", async () => {
    const { f, refusedAt } = await clearedAfterRefusal();
    f.redeclare();
    expect(f.verdict(refusedAt)).toBe("unknown");
  });

  it("a fresh clear stays positive while its frame is current", async () => {
    const { f, refusedAt } = await clearedAfterRefusal();
    f.advance(2000);
    expect(f.verdict(refusedAt)).toBe("clear");
  });
});

describe("the frame must come from the occupant's own pane and process (#2952 R1-F2)", () => {
  it.each([
    ["a same-name successor (a new process in the pane)", { id: "%5", pid: 4200 }],
    ["a reused pane id held by another process", { id: "%5", pid: 9999 }],
    ["another pane under the same session name", { id: "%9", pid: 4100 }],
  ])("%s is refused: the prompt reads unknown, never clear", async (_name, other) => {
    const f = fixture(TRUST);
    await f.tick(); // the occupant is %5 / 4100
    const refusedAt = f.at();
    f.show(IDLE);
    f.pane(other);
    await f.tick();
    expect(f.state().needsInputEvidence).toBeNull();
    expect(f.verdict(refusedAt)).toBe("unknown");
    // Once OpenRig records that pane and process as the occupant (a managed swap's binding, or the reconciler verifying
    // the process), its frames count.
    f.occupant({ paneId: other.id, pid: other.pid });
    await f.tick();
    expect(f.verdict(refusedAt)).toBe("clear");
  });

  it("a capture that doesn't name its pane (the per-seat fallback read) gives no prompt evidence", async () => {
    const f = fixture(IDLE);
    f.pane(undefined);
    await f.tick();
    expect(f.state().needsInputEvidence).toBeNull();
  });
});

describe("the identity is the occupant's as OpenRig records it, not the first frame's (#2952 round 2)", () => {
  it("a replacement before the seat's first frame is refused, so it can't clear an earlier refusal (R2-F1)", async () => {
    const f = fixture(IDLE);
    const refusedAt = f.at();
    f.pane({ id: "%5", pid: 4200 }); // replaced behind the same name before any frame was read
    await f.tick();
    expect(f.state().needsInputEvidence).toBeNull();
    expect(f.verdict(refusedAt)).toBe("unknown");
  });

  it("a process OpenRig hasn't verified gives no prompt evidence", async () => {
    const f = fixture(IDLE);
    f.occupant({ paneId: "%5", pid: null });
    const refusedAt = f.at();
    await f.tick();
    expect(f.state().needsInputEvidence).toBeNull();
    expect(f.verdict(refusedAt)).toBe("unknown");
  });

  it("OpenRig's in-place restart (same pane, new process): once the reconciler verifies the process, the prompt clear works", async () => {
    const f = fixture(TRUST);
    await f.tick();
    const refusedAt = f.at();
    f.pane({ id: "%5", pid: 4300 });
    f.show(IDLE);
    await f.tick();
    // Until the identity reconciler verifies the new process, its frames aren't the occupant's.
    expect(f.verdict(refusedAt)).toBe("unknown");
    f.occupant({ paneId: "%5", pid: 4300 });
    await f.tick();
    expect(f.verdict(refusedAt)).toBe("clear");
  });

  it("OpenRig's in-place restart keeps #2500's working frame once the reconciler verifies the process", async () => {
    const f = fixture(WORKING);
    await f.tick();
    expect(f.state()).toMatchObject({ activity: "working", decidedBy: "window-sampling" });
    f.pane({ id: "%5", pid: 4300 });
    f.occupant({ paneId: "%5", pid: 4300 });
    await f.tick();
    await f.tick();
    expect(f.state()).toMatchObject({ activity: "working", decidedBy: "window-sampling" });
  });
});
