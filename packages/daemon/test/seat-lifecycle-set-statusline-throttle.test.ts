// #3416 (3): rig seat set-statusline-throttle saves (or clears) a Claude seat's status line throttle for its next launch,
// with an audited event, and never restarts the seat or touches its peers.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { seatRoutes } from "../src/routes/seat.js";

function eventsOfType(db: Database.Database, type: string): Array<Record<string, unknown>> {
  return (db.prepare("SELECT payload FROM events WHERE type = ? ORDER BY seq").all(type) as Array<{ payload: string }>)
    .map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

describe("SeatLifecycleService.setStatuslineThrottle", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let service: SeatLifecycleService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const tmux = { probeSession: async () => ({ state: "present" }) } as unknown as TmuxAdapter;
    service = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus: new EventBus(db), tmuxAdapter: tmux });
  });
  afterEach(() => db.close());

  function seat(logicalId: string, runtime = "claude-code") {
    const rig = rigRepo.findRigsByName("sl-rig")[0] ?? rigRepo.createRig("sl-rig");
    const node = rigRepo.addNode(rig.id, logicalId, { runtime, cwd: "/project" });
    new SessionRegistry(db).registerSession(node.id, `${logicalId.replace(".", "-")}@sl-rig`);
    return { node, sessionName: `${logicalId.replace(".", "-")}@sl-rig` };
  }

  it("saves the throttle for the seat only, audits it, and reports an unchanged repeat without an event", () => {
    const { node, sessionName } = seat("dev.impl");
    const peer = seat("dev.peer");
    const result = service.setStatuslineThrottle({ seatRef: sessionName, seconds: 30, reason: "many seats", operator: "lead@sl-rig" });
    expect(result).toMatchObject({ ok: true, from: null, to: 30, changed: true, effect: expect.stringContaining("next launch, resume or restore") });
    expect(rigRepo.getNodeStatuslineThrottle(node.id)).toBe(30);
    expect(rigRepo.getNodeStatuslineThrottle(peer.node.id)).toBeNull();
    expect(rigRepo.getRig(node.rigId)?.nodes.find(n => n.id === node.id)?.statuslineThrottle).toBe(30);
    expect(eventsOfType(db, "node.statusline_throttle_changed")).toEqual([expect.objectContaining({
      nodeId: node.id, logicalId: "dev.impl", from: null, to: 30, reason: "many seats", operator: "lead@sl-rig" })]);

    expect(service.setStatuslineThrottle({ seatRef: sessionName, seconds: 30, reason: "again" })).toMatchObject({ ok: true, changed: false });
    expect(eventsOfType(db, "node.statusline_throttle_changed")).toHaveLength(1);

    expect(service.setStatuslineThrottle({ seatRef: sessionName, seconds: null, reason: "watching closely" }))
      .toMatchObject({ ok: true, from: 30, to: null, changed: true, effect: expect.stringContaining("Cleared") });
    expect(rigRepo.getNodeStatuslineThrottle(node.id)).toBeNull();
  });

  it("refuses a seat that isn't Claude, an interval out of bounds and a missing reason, saving nothing", () => {
    const codex = seat("dev.codex", "codex");
    const { node, sessionName } = seat("dev.impl");
    expect(service.setStatuslineThrottle({ seatRef: codex.sessionName, seconds: 30, reason: "r" }))
      .toMatchObject({ ok: false, code: "statusline_throttle_unsupported_runtime" });
    for (const seconds of [0, 121, 2.5, Number.NaN]) {
      expect(service.setStatuslineThrottle({ seatRef: sessionName, seconds, reason: "r" })).toMatchObject({ ok: false, code: "invalid_statusline_throttle" });
    }
    expect(service.setStatuslineThrottle({ seatRef: sessionName, seconds: 30, reason: " " })).toMatchObject({ ok: false });
    expect(rigRepo.getNodeStatuslineThrottle(node.id)).toBeNull();
    expect(eventsOfType(db, "node.statusline_throttle_changed")).toEqual([]);
  });

  it("refuses to save on a database without the column, and reads it as no throttle", () => {
    const { node, sessionName } = seat("dev.impl");
    db.exec("ALTER TABLE nodes DROP COLUMN statusline_throttle_seconds");
    expect(rigRepo.getNodeStatuslineThrottle(node.id)).toBeNull();
    expect(service.setStatuslineThrottle({ seatRef: sessionName, seconds: 30, reason: "r" }))
      .toMatchObject({ ok: false, code: "statusline_throttle_unavailable", message: expect.stringContaining("migration is required") });
  });

  it("reads a stored value outside the bounds as no throttle", () => {
    const { node } = seat("dev.impl");
    db.prepare("UPDATE nodes SET statusline_throttle_seconds = 900 WHERE id = ?").run(node.id);
    expect(rigRepo.getNodeStatuslineThrottle(node.id)).toBeNull();
    expect(rigRepo.getRig(node.rigId)?.nodes.find(n => n.id === node.id)?.statuslineThrottle).toBeUndefined();
  });
});

describe("POST /set-statusline-throttle with a body that isn't an object", () => {
  it.each(["null", "[]", "42", "not json"])("answers 400, not 500, for %s", async (body) => {
    const response = await seatRoutes.request("/set-statusline-throttle/dev.impl", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: "invalid_statusline_throttle" });
  });
});
