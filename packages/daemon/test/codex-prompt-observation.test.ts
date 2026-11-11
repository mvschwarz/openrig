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

function fixture(first: string) {
  let time = Date.parse("2026-11-11T06:00:00.000Z"), pane = first;
  const session = "worker@fixture", node = "node-fixture";
  const structural = new SeatStructuralActivityService({ capturePaneContent: async () => pane } as never, () => new Date(time));
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => time / 1000 - 60 },
    defaultWindowSeconds: 3, now: () => new Date(time), structuralActivity: structural } as never);
  oracle.declareRungInventory({ seatNodeId: node, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY);
  const tick = async (ms = 1000) => {
    time += ms;
    await structural.pollSeat(session, null, "codex");
    await oracle.pollSeat(session);
  };
  return { oracle, node, session, structural, tick, at: () => new Date(time).toISOString(),
    show: (screen: string) => { pane = screen; }, advance: (ms: number) => { time += ms; },
    state: () => oracle.getSeatState(node)!,
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
    await f.structural.pollSeat(f.session, null, "codex");
    f.advance(500);
    // A new occupant's inventory is declared after that capture; no capture has happened since.
    f.oracle.declareRungInventory({ seatNodeId: f.node, sessionName: f.session }, CODEX_ACTIVITY_RUNG_INVENTORY);
    const refusedAt = new Date(Date.parse(f.at()) - 1000).toISOString();
    await f.oracle.pollSeat(f.session); // the sampler reads the cached frame; no new capture
    expect(f.state().needsInputEvidence).toBeNull();
    expect(f.verdict(refusedAt)).toBe("unknown");
    // The next capture is the current occupant's, and counts.
    await f.tick();
    expect(f.verdict(refusedAt)).toBe("clear");
  });

  it("a stale frame isn't used: with no fresh capture the source is withdrawn", async () => {
    const f = fixture(IDLE);
    await f.tick();
    const refusedAt = new Date(Date.parse(f.at()) - 500).toISOString();
    expect(f.verdict(refusedAt)).toBe("clear");
    f.advance(6000); // past the structural stale window, with no capture
    await f.oracle.pollSeat(f.session);
    expect(f.state().needsInputEvidence).toBeNull();
    expect(f.verdict(refusedAt)).toBe("unknown");
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
