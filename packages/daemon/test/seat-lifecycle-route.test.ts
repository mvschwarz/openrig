// S5 (OPR.0.5.4.7) — the three seat-lifecycle routes: HTTP status mapping per the
// PRD (400 required-input, 404 not-found, 409 state conflicts, 502 tmux-layer) and
// the pass-through of the service's named refusals (message + guidance + matches).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("POST /api/seat/{set-model,stop,clean}/:seatRef", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => { db.close(); });

  function seedSeat(logicalId = "dev.impl", model = "fable") {
    const rig = setup.rigRepo.findRigsByName("seat-rig")[0] ?? setup.rigRepo.createRig("seat-rig");
    const sessionName = `${logicalId.replace(".", "-")}@seat-rig`;
    const node = setup.rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code", model });
    const session = setup.sessionRegistry.registerSession(node.id, sessionName);
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: sessionName, tmuxPane: "%1" });
    return { rig, node, session, sessionName };
  }

  function tmux() {
    const t = setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
    // Fix r1 (row 9baac99f): the service consumes the CLASSIFIED probeSession.
    // The shared test-app mock predates it; derive a positive-evidence probe
    // from the test's hasSession mock (present/absent — the blip class is
    // pinned against the REAL adapter in the service suite, not here).
    if (!t.probeSession) {
      t.probeSession = vi.fn(async (name: string) =>
        (await t.hasSession(name)) ? { state: "present" } : { state: "absent" });
    }
    return t;
  }

  function post(path: string, seatRef: string, body: Record<string, unknown> = {}) {
    return setup.app.request(`/api/seat/${path}/${encodeURIComponent(seatRef)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("set-model 200: persists, echoes from/to/changed", async () => {
    const { sessionName } = seedSeat();
    const res = await post("set-model", sessionName, { model: "claude-fable-5", reason: "alias migration", operator: "op@rig" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, from: "fable", to: "claude-fable-5", changed: true });
  });

  it("set-model 400 on missing model; 400 on missing reason", async () => {
    const { sessionName } = seedSeat();
    const noModel = await post("set-model", sessionName, { reason: "x" });
    expect(noModel.status).toBe(400);
    expect((await noModel.json() as { code: string }).code).toBe("missing_model");
    const noReason = await post("set-model", sessionName, { model: "claude-fable-5" });
    expect(noReason.status).toBe(400);
    expect((await noReason.json() as { code: string }).code).toBe("missing_reason");
  });

  it("404 seat_not_found; 409 seat_ambiguous with matches", async () => {
    seedSeat();
    const missing = await post("set-model", "ghost@seat-rig", { model: "m", reason: "x" });
    expect(missing.status).toBe(404);

    // Same logical id in a second rig → bare ref is ambiguous.
    const rigB = setup.rigRepo.createRig("seat-rig-b");
    setup.rigRepo.addNode(rigB.id, "dev.impl", { runtime: "claude-code" });
    const ambiguous = await post("set-model", "dev.impl", { model: "m", reason: "x" });
    expect(ambiguous.status).toBe(409);
    const body = await ambiguous.json() as { code: string; matches: unknown[] };
    expect(body.code).toBe("seat_ambiguous");
    expect(body.matches.length).toBe(2);
  });

  it("stop 200 on a live seat; 409 session_not_live on a dead one; 502 on probe failure", async () => {
    const { sessionName } = seedSeat();
    tmux().hasSession.mockResolvedValue(true);
    tmux().killSession.mockResolvedValue({ ok: true });
    const ok = await post("stop", sessionName, { reason: "wave boundary" });
    expect(ok.status).toBe(200);
    expect(tmux().killSession).toHaveBeenCalledWith(sessionName);

    const b = seedSeat("dev.other");
    tmux().hasSession.mockResolvedValue(false);
    const dead = await post("stop", b.sessionName, { reason: "x" });
    expect(dead.status).toBe(409);
    expect((await dead.json() as { code: string }).code).toBe("session_not_live");

    tmux().hasSession.mockRejectedValue(new Error("socket gone"));
    const probe = await post("stop", b.sessionName, { reason: "x" });
    expect(probe.status).toBe(502);
    expect((await probe.json() as { code: string }).code).toBe("tmux_probe_failed");
  });

  it("clean 409 session_live on a live seat; 200 on a dead one; 409 nothing_to_clean when repeated", async () => {
    const { sessionName } = seedSeat();
    tmux().hasSession.mockResolvedValue(true);
    const live = await post("clean", sessionName, { reason: "x" });
    expect(live.status).toBe(409);
    expect((await live.json() as { code: string }).code).toBe("session_live");

    tmux().hasSession.mockResolvedValue(false);
    const ok = await post("clean", sessionName, { reason: "clean exit observed" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, actions: { sessionsExited: [sessionName], bindingCleared: true } });

    const again = await post("clean", sessionName, { reason: "x" });
    expect(again.status).toBe(409);
    expect((await again.json() as { code: string }).code).toBe("nothing_to_clean");
  });
});
