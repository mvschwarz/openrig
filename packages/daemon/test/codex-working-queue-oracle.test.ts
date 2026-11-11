import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { CODEX_ACTIVITY_RUNG_INVENTORY } from "../src/domain/activity-taxonomy.js";
import { diagnoseSeatParked } from "../src/domain/parked-query.js";
import { activityRoutes } from "../src/routes/activity.js";
import { createDaemon } from "../src/startup.js";
const recorded = readFileSync(new URL("./fixtures/input-box/codex-0.160.0/after-enter-0.4s.J.txt", import.meta.url), "utf8");
// The normal frame is a recorded fixture; the status and footer follow the current seat's sanitized capture.
const screen = recorded.slice(recorded.indexOf("• Working"))
  .replace(/^• Working.*$/m, "◦ Working已(1h 56m 32s • esc to interrupt · 3 background terminals running")
  .replace(/^  GPT-.*$/m, "  GPT-6.1 Terra high · D:\\workspace");

it("keeps a visibly running Codex turn working when the window timestamp is quiet", async () => {
  const now = new Date("2026-11-04T20:00:00.000Z");
  const session = "worker@fixture", node = "node-fixture";
  const structural = new SeatStructuralActivityService({ capturePaneContent: async () => screen } as never, () => now);
  expect((await structural.pollSeat(session, null, "codex"))?.state).toBe("agent_active");
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => now.getTime() / 1000 - 60 },
    defaultWindowSeconds: 3, now: () => now, structuralActivity: structural } as never);
  oracle.declareRungInventory({ seatNodeId: node, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY);
  await oracle.pollSeat(session);
  expect(oracle.getSeatState(node)).toMatchObject({ activity: "working", decidedBy: "window-sampling" });
  const result = diagnoseSeatParked({ getSeatState: () => oracle.getSeatState(node),
    listOpenObligations: () => ({ rows: [{ qitemId: "work", state: "in-progress", summary: "Work" }], limit: 500 }),
    getParkWake: () => null }, { seatNodeId: node, sessionName: session });
  expect(result.parked).toBe(false);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("seatActivityService" as never, oracle as never);
    c.set("queueRepo" as never, { listOpenObligations: () => [{ qitemId: "work", state: "in-progress", summary: "Work" }] } as never);
    c.set("rigRepo" as never, { db: { prepare: (sql: string) => ({
      get: () => ({ id: "rig-1", name: "fixture" }),
      all: () => sql.includes("SELECT name FROM rigs") ? [] : [{ node_id: node, session_name: session }],
    }) } } as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  const response = await app.request(`/api/activity/parked?seat=${encodeURIComponent(session)}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ seat: { parked: false, activity: { value: "working", decidedBy: "window-sampling" } } });
  oracle.reportEvidence({ seatNodeId: node, sessionName: session, rung: "needs-input-chrome", sourceId: "fixture:prompt",
    seq: 1, observedAt: now.toISOString(), needsInput: { count: 1, reason: "selection_prompt" } });
  const waiting = diagnoseSeatParked({ getSeatState: () => oracle.getSeatState(node),
    listOpenObligations: () => ({ rows: [{ qitemId: "work", state: "in-progress", summary: "Work" }], limit: 500 }),
    getParkWake: () => null }, { seatNodeId: node, sessionName: session });
  expect(waiting.parked).toBe(true);
});

it("does not treat a working-looking line in history as a live frame", async () => {
  const now = new Date("2026-11-04T20:00:00.000Z"), session = "worker@fixture", node = "node-fixture";
  const history = screen.replace("◦ Working已(1h 56m 32s • esc to interrupt · 3 background terminals running",
    "◦ Working (1s • esc to interrupt)\n\nCompleted work.");
  const structural = new SeatStructuralActivityService({ capturePaneContent: async () => history } as never, () => now);
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => now.getTime() / 1000 - 60 },
    defaultWindowSeconds: 3, now: () => now, structuralActivity: structural } as never);
  oracle.declareRungInventory({ seatNodeId: node, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY);
  await structural.pollSeat(session, null, "codex");
  await oracle.pollSeat(session);
  expect(oracle.getSeatState(node)?.activity).toBe("idle-at-prompt");
});

it("uses an advancing counter when output separates the status from the composer, but expires a frozen counter", async () => {
  let time = Date.parse("2026-11-04T20:00:00.000Z"), elapsed = 32;
  const session = "worker@fixture", node = "node-fixture";
  const structural = new SeatStructuralActivityService({ capturePaneContent: async () =>
    screen.replace("32s • esc to interrupt", `${elapsed}s • esc to interrupt`).replace("\n› Ask Codex", "\n• Edited files\n\n› Ask Codex") } as never, () => new Date(time));
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => time / 1000 - 60 },
    defaultWindowSeconds: 3, now: () => new Date(time), structuralActivity: structural } as never);
  oracle.declareRungInventory({ seatNodeId: node, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY);
  await structural.pollSeat(session, null, "codex");
  await oracle.pollSeat(session);
  expect(oracle.getSeatState(node)?.activity).toBe("idle-at-prompt");
  time += 1000; elapsed++;
  await structural.pollSeat(session, null, "codex");
  await oracle.pollSeat(session);
  expect(oracle.getSeatState(node)?.activity).toBe("working");
  time += 1000;
  await structural.pollSeat(session, null, "codex");
  await oracle.pollSeat(session);
  expect(oracle.getSeatState(node)?.activity).toBe("working");
  time += 6000;
  await structural.pollSeat(session, null, "codex");
  await oracle.pollSeat(session);
  time += 3000;
  await oracle.pollSeat(session);
  expect(oracle.getSeatState(node)?.activity).toBe("idle-at-prompt");
  time += 60_000;
  expect(oracle.getSeatState(node)?.activity).toBe("unknown");
});

it("expires a repeatedly captured frozen adjacent frame and accepts a later advance", async () => {
  let time = Date.parse("2026-11-04T20:00:00.000Z"), elapsed = 32;
  const session = "worker@fixture", node = "node-fixture";
  const structural = new SeatStructuralActivityService({ capturePaneContent: async () =>
    screen.replace("32s • esc to interrupt", `${elapsed}s • esc to interrupt`) } as never, () => new Date(time));
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => time / 1000 - 60 },
    defaultWindowSeconds: 3, now: () => new Date(time), structuralActivity: structural } as never);
  oracle.declareRungInventory({ seatNodeId: node, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY);
  for (let i = 0; i <= 6; i++) {
    await structural.pollSeat(session, null, "codex");
    await oracle.pollSeat(session);
    time += 1000;
  }
  expect(oracle.getSeatState(node)?.activity).toBe("idle-at-prompt");
  elapsed++;
  await structural.pollSeat(session, null, "codex");
  await oracle.pollSeat(session);
  expect(oracle.getSeatState(node)?.activity).toBe("working");
});

it("uses an advancing unclosed status beyond the classifier tail", async () => {
  let time = Date.parse("2026-11-04T20:00:00.000Z"), elapsed = 32;
  const session = "worker@fixture", node = "node-fixture";
  const structural = new SeatStructuralActivityService({ capturePaneContent: async () =>
    screen.replace("32s • esc to interrupt", `${elapsed}s • esc to interrupt`)
      .replace("\n› Ask Codex", `\n${Array.from({ length: 10 }, (_, i) => `output ${i}`).join("\n")}\n› Ask Codex`) } as never, () => new Date(time));
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => time / 1000 - 60 },
    defaultWindowSeconds: 3, now: () => new Date(time), structuralActivity: structural } as never);
  oracle.declareRungInventory({ seatNodeId: node, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY);
  const first = await structural.pollSeat(session, null, "codex");
  expect(first?.state).not.toBe("agent_active");
  await oracle.pollSeat(session);
  expect(oracle.getSeatState(node)?.activity).toBe("idle-at-prompt");
  time += 1000; elapsed++;
  await structural.pollSeat(session, null, "codex");
  await oracle.pollSeat(session);
  expect(oracle.getSeatState(node)?.activity).toBe("working");
});

it("does not use an advancing working line while the pane asks for input", async () => {
  let time = Date.parse("2026-11-04T20:00:00.000Z"), elapsed = 32;
  const session = "worker@fixture";
  const structural = new SeatStructuralActivityService({ capturePaneContent: async () =>
    screen.replace("32s • esc to interrupt", `${elapsed}s • esc to interrupt`)
      .replace("\n› Ask Codex", "\n❯ 1. First option\n  2. Second option\nEnter to select · ↑/↓ to navigate · Esc to cancel\n› Ask Codex") } as never, () => new Date(time));
  await structural.pollSeat(session, null, "codex");
  time += 1000; elapsed++;
  const observation = await structural.pollSeat(session, null, "codex");
  expect(observation?.state).toBe("attention");
  expect(observation?.codexWorkingFrame).toBeUndefined();
});

it("wires the daemon's existing pane reader into the queue oracle", async () => {
  const previous = process.env.OPENRIG_NO_KERNEL;
  process.env.OPENRIG_NO_KERNEL = "1";
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 404 }));
  let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
  try {
    daemon = await createDaemon({ dbPath: ":memory:", tmuxExec: async () => "", cmuxExec: async () => "" } as Parameters<typeof createDaemon>[0]);
    const { rigRepo, sessionRegistry, seatActivityService, seatStructuralActivityService, tmuxAdapter } = daemon.deps;
    const rig = rigRepo.createRig("activity-fixture"), node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "codex" });
    const sessionName = "worker@activity-fixture";
    const session = sessionRegistry.registerSession(node.id, sessionName);
    sessionRegistry.updateStatus(session.id, "running");
    seatActivityService.declareRungInventory({ seatNodeId: node.id, sessionName }, CODEX_ACTIVITY_RUNG_INVENTORY);
    const capturedAt = new Date();
    await seatStructuralActivityService.pollSeat(sessionName, new Map([[sessionName, { text: screen, capturedAt }]]), "codex", null, capturedAt);
    vi.spyOn(tmuxAdapter, "readPaneLastActivity").mockResolvedValue(Date.now() / 1000 - 60);
    await seatActivityService.pollSeat(sessionName);
    expect(seatActivityService.getSeatState(node.id)).toMatchObject({ activity: "working", decidedBy: "window-sampling" });
  } finally {
    daemon?.eventLoopMonitor.stop();
    daemon?.db.close();
    fetch.mockRestore();
    if (previous === undefined) delete process.env.OPENRIG_NO_KERNEL;
    else process.env.OPENRIG_NO_KERNEL = previous;
  }
});

it("does not carry a stale working frame into a replacement occupant", async () => {
  let time = Date.parse("2026-11-04T20:00:00.000Z");
  const session = "worker@fixture", node = "node-fixture";
  const structural = new SeatStructuralActivityService({ capturePaneContent: async () => screen } as never, () => new Date(time));
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => time / 1000 - 60 },
    defaultWindowSeconds: 3, now: () => new Date(time), structuralActivity: structural } as never);
  oracle.declareRungInventory({ seatNodeId: node, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY);
  await structural.pollSeat(session, null, "codex");
  await oracle.pollSeat(session);
  expect(oracle.getSeatState(node)?.activity).toBe("working");
  time += 1000;
  oracle.declareOccupantSwap(node, "replacement");
  oracle.declareRungInventory({ seatNodeId: node, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY);
  await oracle.pollSeat(session);
  expect(oracle.getSeatState(node)?.activity).toBe("idle-at-prompt");
});

it("does not compare a new occupant's counter with the predecessor's frame", async () => {
  let time = Date.parse("2026-11-04T20:00:00.000Z"), elapsed = 32;
  const session = "worker@fixture", node = "node-fixture";
  const structural = new SeatStructuralActivityService({ capturePaneContent: async () =>
    screen.replace("32s • esc to interrupt", `${elapsed}s • esc to interrupt`).replace("\n› Ask Codex", "\n• Edited files\n\n› Ask Codex") } as never, () => new Date(time));
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => time / 1000 - 60 },
    defaultWindowSeconds: 3, now: () => new Date(time), structuralActivity: structural } as never);
  oracle.declareRungInventory({ seatNodeId: node, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY);
  await structural.pollSeat(session, null, "codex");
  time += 1000; elapsed++;
  oracle.declareOccupantSwap(node, "replacement");
  oracle.declareRungInventory({ seatNodeId: node, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY);
  await structural.pollSeat(session, null, "codex");
  await oracle.pollSeat(session);
  expect(oracle.getSeatState(node)?.activity).toBe("idle-at-prompt");
});

it("does not renew an adjacent frame using a predecessor's counter", async () => {
  let time = Date.parse("2026-11-04T20:00:00.000Z"), elapsed = 32;
  const session = "worker@fixture", node = "node-fixture";
  const structural = new SeatStructuralActivityService({ capturePaneContent: async () =>
    screen.replace("32s • esc to interrupt", `${elapsed}s • esc to interrupt`) } as never, () => new Date(time));
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => time / 1000 - 60 },
    defaultWindowSeconds: 3, now: () => new Date(time), structuralActivity: structural } as never);
  oracle.declareRungInventory({ seatNodeId: node, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY);
  await structural.pollSeat(session, null, "codex");
  time += 1000; elapsed++;
  oracle.declareOccupantSwap(node, "replacement");
  oracle.declareRungInventory({ seatNodeId: node, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY);
  await structural.pollSeat(session, null, "codex");
  await oracle.pollSeat(session);
  expect(oracle.getSeatState(node)?.activity).toBe("idle-at-prompt");
});

it.each([
  { name: "the same counter", predecessorAdjacent: true, step: 0 },
  { name: "an advanced counter", predecessorAdjacent: false, step: 1 },
])("does not credit a restarted pane process with $name from the process before it", async ({ predecessorAdjacent, step }) => {
  let time = Date.parse("2026-11-04T20:00:00.000Z"), elapsed = 32, pid = 4100;
  const session = "worker@fixture", node = "node-fixture";
  const structural = new SeatStructuralActivityService({ capturePaneContent: async () => null } as never, () => new Date(time));
  const capture = (adjacent: boolean) => {
    const at = new Date(time);
    const frame = screen.replace("32s • esc to interrupt", `${elapsed}s • esc to interrupt`);
    const text = adjacent ? frame : frame.replace("\n› Ask Codex", "\n• Edited files\n\n› Ask Codex");
    return structural.pollSeat(session, new Map([[session, { text, capturedAt: at, pane: { id: "%5", pid } }]]), "codex", null, at);
  };
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => time / 1000 - 60 },
    defaultWindowSeconds: 3, now: () => new Date(time), structuralActivity: structural } as never);
  oracle.declareRungInventory({ seatNodeId: node, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY);
  oracle.recordCodexOccupant(node, { paneId: "%5", pid });
  await capture(predecessorAdjacent);
  // An in-place restart: OpenRig verifies the new process in the same pane, and the inventory is unchanged.
  time += 1000; elapsed += step; pid = 4200;
  oracle.recordCodexOccupant(node, { paneId: "%5", pid });
  const replaced = await capture(false);
  await oracle.pollSeat(session);
  expect(oracle.getSeatState(node)?.activity).toBe("idle-at-prompt");
  expect(replaced?.codexWorkingFrame).toBeUndefined();
  // The new process's own advancing counter still counts.
  time += 1000; elapsed++;
  await capture(false);
  await oracle.pollSeat(session);
  expect(oracle.getSeatState(node)?.activity).toBe("working");
});

it("does not treat counter readings separated by a capture outage as continuous activity", async () => {
  let time = Date.parse("2026-11-04T20:00:00.000Z"), elapsed = 32;
  const session = "worker@fixture", node = "node-fixture";
  const structural = new SeatStructuralActivityService({ capturePaneContent: async () =>
    screen.replace("32s • esc to interrupt", `${elapsed}s • esc to interrupt`).replace("\n› Ask Codex", "\n• Edited files\n\n› Ask Codex") } as never, () => new Date(time));
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => time / 1000 - 60 },
    defaultWindowSeconds: 3, now: () => new Date(time), structuralActivity: structural } as never);
  oracle.declareRungInventory({ seatNodeId: node, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY);
  await structural.pollSeat(session, null, "codex");
  time += 6000; elapsed += 6;
  await structural.pollSeat(session, null, "codex");
  await oracle.pollSeat(session);
  expect(oracle.getSeatState(node)?.activity).toBe("idle-at-prompt");
});

it("lets an unrefreshed working frame expire", async () => {
  let time = Date.parse("2026-11-04T20:00:00.000Z");
  const session = "worker@fixture", node = "node-fixture";
  const structural = new SeatStructuralActivityService({ capturePaneContent: async () => screen } as never, () => new Date(time));
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => time / 1000 - 60 },
    defaultWindowSeconds: 3, now: () => new Date(time), structuralActivity: structural } as never);
  oracle.declareRungInventory({ seatNodeId: node, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY);
  await structural.pollSeat(session, null, "codex");
  await oracle.pollSeat(session);
  expect(oracle.getSeatState(node)?.activity).toBe("working");
  time += 6000;
  expect(oracle.getSeatState(node)?.activity).toBe("idle-at-prompt");
  await oracle.pollSeat(session);
  time += 3000;
  await oracle.pollSeat(session);
  expect(oracle.getSeatState(node)?.activity).toBe("idle-at-prompt");
});
