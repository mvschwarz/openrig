// A park timer is queued work coming due. When its seat is missing (a seat on standby has no session), the delivery tells
// the queue's no-receiver path, where cold start decides whether to start the seat for that work. A watchdog reminder
// that wakes no parked row starts nothing, and the reminder's own outcome is unchanged either way.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { makeWatchdogDeliver } from "../src/domain/watchdog-delivery.js";

const SEAT = "expert@lab";
const missing = { ok: false as const, reason: "session_missing" as const, sent: false, inputPhase: "not_reached" as const,
  error: `Session '${SEAT}' not found: tmux reports no session with this name. No text was sent.` };

function deliverWith(result: unknown, parkedRows: string[]) {
  const noteNoReceiver = vi.fn();
  const resolveParkedRows = vi.fn(() => parkedRows);
  const deliver = makeWatchdogDeliver({
    sessionTransport: { send: vi.fn(async () => result) } as never,
    resolveParkedRows,
    noteNoReceiver,
  });
  return { deliver, noteNoReceiver, resolveParkedRows };
}

describe("a park timer due at a missing seat", () => {
  it("tells cold start when the timer wakes a parked row of that seat", async () => {
    const f = deliverWith(missing, ["qitem-20000101000000-00000001"]);
    const outcome = await f.deliver({ targetSession: SEAT, message: "Resume parked qitem" }, { jobId: "job-1", policy: "periodic-reminder" });
    expect(f.noteNoReceiver).toHaveBeenCalledWith(SEAT);
    expect(outcome.status).toBe("failed");
  });

  it("tells cold start for a digest that carries parked rows", async () => {
    const f = deliverWith(missing, ["qitem-20000101000000-00000002"]);
    await f.deliver({ targetSession: SEAT, message: "Resume parked work" },
      { jobId: "job-1", policy: "periodic-reminder", members: [{ jobId: "job-1", occurrenceId: "o1" }],
        parkedRows: [{ jobId: "job-1", qitemId: "qitem-20000101000000-00000002" }] });
    expect(f.noteNoReceiver).toHaveBeenCalledWith(SEAT);
    expect(f.resolveParkedRows).toHaveBeenCalledWith({ jobId: "job-1", targetSession: SEAT });
  });

  it("starts nothing for a reminder that wakes no parked row", async () => {
    const f = deliverWith(missing, []);
    await f.deliver({ targetSession: SEAT, message: "Check the dashboard" }, { jobId: "job-2", policy: "periodic-reminder" });
    expect(f.noteNoReceiver).not.toHaveBeenCalled();
  });

  it("says nothing when the seat is there", async () => {
    const f = deliverWith({ ok: true, sent: true, inputPhase: "written" }, ["qitem-20000101000000-00000001"]);
    await f.deliver({ targetSession: SEAT, message: "Resume parked qitem" }, { jobId: "job-1", policy: "periodic-reminder" });
    expect(f.noteNoReceiver).not.toHaveBeenCalled();
  });

  it("keeps the reminder's outcome when telling cold start throws", async () => {
    const f = deliverWith(missing, ["qitem-20000101000000-00000001"]);
    f.noteNoReceiver.mockImplementation(() => { throw new Error("cold start unavailable"); });
    const outcome = await f.deliver({ targetSession: SEAT, message: "Resume parked qitem" }, { jobId: "job-1", policy: "periodic-reminder" });
    expect(outcome.status).toBe("failed");
  });
});

describe("production wiring", () => {
  it("passes the cold starter to the watchdog's delivery (a dropped line would leave standby seats asleep on due timers)", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/startup.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/noteNoReceiver:\s*\(session\)\s*=>\s*seatColdStarter\.notify\(session\)/);
  });
});
