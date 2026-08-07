import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryQuery } from "../src/domain/history-query.js";

// searchSeat is a direct-read path (generation labeling needs positional info),
// so exec is never invoked here — a throwing stub proves that.
const throwExec = async () => {
  throw new Error("searchSeat must not shell out to rg/grep");
};

describe("HistoryQuery.searchSeat — seat-scoped, cross-generation, honest-degraded", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rigask-seat-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSeatLog(rig: string, seat: string, content: string): void {
    const dir = join(root, rig);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${seat}.log`), content, "utf-8");
  }

  it("returns hits spanning TWO generations of one seat, labeled by generation", async () => {
    const rig = "my-rig";
    const seat = "dev-planner@my-rig";
    writeSeatLog(
      rig,
      seat,
      [
        "gen1 discussed the deployment strategy",
        "unrelated chatter",
        "--- SESSION BOUNDARY: handover at 2026-08-06T00:00:00.000Z ---",
        "gen2 revisited the deployment plan",
      ].join("\n") + "\n",
    );
    // A DIFFERENT seat in the same rig dir must NOT be searched (scoping).
    writeSeatLog(rig, "review-r1@my-rig", "deployment noise in another seat\n");

    const hq = new HistoryQuery({ transcriptsRoot: root, exec: throwExec });
    const res = await hq.searchSeat(rig, seat, "deployment");

    expect(res.seat).toBe(seat);
    expect(res.generations).toBe(2);
    const gens = res.hits.map((h) => h.generation).sort();
    expect(gens).toContain(1); // hit before the boundary
    expect(gens).toContain(2); // hit after the boundary — cross-generation is the point
    // Scoped: no hit leaked from the other seat's log.
    expect(res.hits.some((h) => h.text.includes("another seat"))).toBe(false);
    expect(res.insufficient).toBe(false);
    expect(res.degraded).toBeUndefined();
  });

  it("honest-degraded (boundary_only) — never a silent zero-hits implying the seat never spoke", async () => {
    const rig = "my-rig";
    const seat = "dev-guard@my-rig";
    writeSeatLog(rig, seat, "--- SESSION BOUNDARY: launch at 2026-08-06T00:00:00.000Z ---\n\n");

    const hq = new HistoryQuery({ transcriptsRoot: root, exec: throwExec });
    const res = await hq.searchSeat(rig, seat, "deployment");

    expect(res.degraded).toBeDefined();
    expect(res.degraded?.reason).toBe("boundary_only");
    expect(res.degraded?.message).toMatch(/boundary/i);
    expect(res.hits.length).toBe(0);
    expect(res.insufficient).toBe(true);
  });

  it("honest-degraded (capture_missing) when the seat has no transcript file", async () => {
    const hq = new HistoryQuery({ transcriptsRoot: root, exec: throwExec });
    const res = await hq.searchSeat("my-rig", "ghost@my-rig", "deployment");

    expect(res.degraded?.reason).toBe("capture_missing");
    expect(res.hits.length).toBe(0);
    expect(res.insufficient).toBe(true);
  });
});
