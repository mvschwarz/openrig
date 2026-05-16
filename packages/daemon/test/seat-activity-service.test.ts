// Slice 15 — SeatActivityService unit tests (TDD).
//
// The service is the daemon's owner of the `terminal-active` primitive.
// It polls tmux's per-pane silence flag at a configurable cadence and
// keeps the latest observation in memory keyed by canonical session
// name. Downstream consumers (ps-projection, node-inventory, UI hooks
// via the event stream) read through the service. The service does NOT
// touch queue/assignment state — that's the non-inference contract.

import { describe, it, expect, vi } from "vitest";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

function makeTmuxAdapter(
  silenceFlagBySession: Record<string, boolean | null>,
): TmuxAdapter {
  return {
    readPaneSilenceFlag: vi.fn(async (paneId: string) => {
      return Object.prototype.hasOwnProperty.call(silenceFlagBySession, paneId)
        ? silenceFlagBySession[paneId]!
        : null;
    }),
  } as unknown as TmuxAdapter;
}

describe("SeatActivityService", () => {
  it("pollSeat records an active observation when tmux reports silence flag = 0 (not silent)", async () => {
    const tmux = makeTmuxAdapter({ "claude@rig": false });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });

    const observed = await svc.pollSeat("claude@rig");

    expect(observed).not.toBeNull();
    expect(observed!.paneId).toBe("claude@rig");
    expect(observed!.isActiveWithinWindow).toBe(true);
    expect(observed!.silenceWindowSeconds).toBe(3);
    expect(observed!.lastObservedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("pollSeat records an idle observation when tmux reports silence flag = 1 (silent past threshold)", async () => {
    const tmux = makeTmuxAdapter({ "claude@rig": true });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 5 });

    const observed = await svc.pollSeat("claude@rig");

    expect(observed!.isActiveWithinWindow).toBe(false);
    expect(observed!.silenceWindowSeconds).toBe(5);
  });

  it("pollSeat returns null when tmux read returns null (no observation; consumer treats as 'unknown')", async () => {
    const tmux = makeTmuxAdapter({ "claude@rig": null });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });

    expect(await svc.pollSeat("claude@rig")).toBeNull();
  });

  it("getSeatActivity returns the latest stored observation for a seat", async () => {
    const tmux = makeTmuxAdapter({ "claude@rig": false });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });

    expect(svc.getSeatActivity("claude@rig")).toBeNull();
    await svc.pollSeat("claude@rig");

    const stored = svc.getSeatActivity("claude@rig");
    expect(stored).not.toBeNull();
    expect(stored!.isActiveWithinWindow).toBe(true);
  });

  it("getSeatActivity is keyed per-seat; observations don't leak across seats", async () => {
    const tmux = makeTmuxAdapter({ "a@rig": true, "b@rig": false });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });

    await svc.pollSeat("a@rig");
    await svc.pollSeat("b@rig");

    expect(svc.getSeatActivity("a@rig")!.isActiveWithinWindow).toBe(false);
    expect(svc.getSeatActivity("b@rig")!.isActiveWithinWindow).toBe(true);
  });

  it("pollSeat with a per-seat override honors the override; default is the fallback", async () => {
    const tmux = makeTmuxAdapter({ "claude@rig": false });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });

    const observed = await svc.pollSeat("claude@rig", { silenceWindowSeconds: 7 });
    expect(observed!.silenceWindowSeconds).toBe(7);

    const observed2 = await svc.pollSeat("claude@rig"); // no override
    expect(observed2!.silenceWindowSeconds).toBe(3);
  });

  it("absorbs tmux errors so polling failures never crash the daemon loop", async () => {
    const tmux = {
      readPaneSilenceFlag: vi.fn(async () => {
        throw new Error("tmux gone");
      }),
    } as unknown as TmuxAdapter;
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });

    await expect(svc.pollSeat("claude@rig")).resolves.toBeNull();
  });

  // Slice 15 non-inference contract (HG-4 partial): the service has no
  // input port for queue/assignment state. Even at the type level, the
  // constructor must NOT accept a queue repo / projection. If a future
  // contributor reaches for queue data here, this constructor-shape
  // test fails compile, surfacing the regression.
  it("HG-4 partial — constructor surface depends only on tmux + cadence (no queue/assignment input)", () => {
    const tmux = makeTmuxAdapter({});
    // The constructor only accepts `tmux` + `defaultWindowSeconds` (+ optional bus).
    // If we tried to pass any queue/assignment-shaped dep the compile fails.
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });
    expect(svc).toBeDefined();
  });

  describe("pollAllRunningTmuxSeats", () => {
    // Uses the same DB schema the daemon uses — pick up the test-app
    // helper that provisions an in-memory daemon DB with all migrations.
    async function makeDb() {
      const { createFullTestDb } = await import("./helpers/test-app.js");
      return createFullTestDb();
    }

    it("polls every running tmux-bound seat once; stores observations keyed by canonical session name", async () => {
      const db = await makeDb();
      try {
        db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'rig-a')").run();
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1', 'r1', 'dev')").run();
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n2', 'r1', 'qa')").run();
        const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s1", "n1", "dev@rig", "running", ts);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s2", "n2", "qa@rig", "running", ts);

        const tmux = makeTmuxAdapter({ "dev@rig": false, "qa@rig": true });
        const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });

        await svc.pollAllRunningTmuxSeats(db);

        expect(svc.getSeatActivity("dev@rig")!.isActiveWithinWindow).toBe(true);
        expect(svc.getSeatActivity("qa@rig")!.isActiveWithinWindow).toBe(false);
        expect(tmux.readPaneSilenceFlag).toHaveBeenCalledTimes(2);
      } finally {
        db.close();
      }
    });

    it("skips detached / stopped seats — only `running` status is polled", async () => {
      const db = await makeDb();
      try {
        db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'rig-a')").run();
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1', 'r1', 'dev')").run();
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n2', 'r1', 'qa')").run();
        const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s1", "n1", "dev@rig", "running", ts);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s2", "n2", "qa@rig", "detached", ts);

        const tmux = makeTmuxAdapter({ "dev@rig": false, "qa@rig": false });
        const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });
        await svc.pollAllRunningTmuxSeats(db);

        expect(svc.getSeatActivity("dev@rig")).not.toBeNull();
        expect(svc.getSeatActivity("qa@rig")).toBeNull(); // detached → skipped
        expect(tmux.readPaneSilenceFlag).toHaveBeenCalledTimes(1);
      } finally {
        db.close();
      }
    });

    it("drops cached observations for seats no longer in the running set (memory hygiene)", async () => {
      const db = await makeDb();
      try {
        db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'rig-a')").run();
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1', 'r1', 'dev')").run();
        const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s1", "n1", "dev@rig", "running", ts);

        const tmux = makeTmuxAdapter({ "dev@rig": false });
        const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });
        await svc.pollAllRunningTmuxSeats(db);
        expect(svc.getSeatActivity("dev@rig")).not.toBeNull();

        // Stop the seat; expect the observation to drop on next sweep.
        db.prepare("UPDATE sessions SET status = 'detached' WHERE id = 's1'").run();
        await svc.pollAllRunningTmuxSeats(db);
        expect(svc.getSeatActivity("dev@rig")).toBeNull();
      } finally {
        db.close();
      }
    });
  });
});
