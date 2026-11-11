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
type Pane = { id: string; pid: number } | undefined;

function fixture(first: string) {
  let time = Date.parse("2026-11-11T06:00:00.000Z"), screen = first, pane: Pane = { id: "%5", pid: 4100 };
  let windowRead: number | null = time / 1000 - 60;
  const session = "worker@fixture", node = "node-fixture";
  const structural = new SeatStructuralActivityService({ capturePaneContent: async () => screen } as never, () => new Date(time));
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => windowRead },
    defaultWindowSeconds: 3, now: () => new Date(time), structuralActivity: structural } as never);
  oracle.declareRungInventory({ seatNodeId: node, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY);
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
    show: (next: string) => { screen = next; }, pane: (next: Pane) => { pane = next; }, advance: (ms: number) => { time += ms; },
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
    await f.tick(); // pins %5 / 4100 for this inventory
    const refusedAt = f.at();
    f.show(IDLE);
    f.pane(other);
    await f.tick();
    expect(f.state().needsInputEvidence).toBeNull();
    expect(f.verdict(refusedAt)).toBe("unknown");
    // A newly declared inventory (a managed swap) accepts the new pane.
    f.redeclare();
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
