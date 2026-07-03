import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

/**
 * OPR.0.4.3.26 — POST /api/seat/switch-client/:seatRef. VIEW-ONLY view retarget:
 * the route resolves the seat read-only and only probes/switches via the tmux
 * adapter already in context. These tests pin the happy path + the honest-error
 * HTTP mapping + that no reconcile/converge machinery is invoked.
 */
describe("POST /api/seat/switch-client/:seatRef", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => { db.close(); });

  function seedLiveSeat() {
    const rig = setup.rigRepo.createRig("seat-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");
    return { rig, node, session };
  }

  function tmux() {
    return setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
  }

  function post(seatRef: string, body: Record<string, unknown> = {}) {
    return setup.app.request(`/api/seat/switch-client/${encodeURIComponent(seatRef)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("200: retargets the single attached client to <session>:0", async () => {
    seedLiveSeat();
    tmux().hasSession.mockResolvedValue(true);
    tmux().listClients.mockResolvedValue([{ name: "/dev/ttys003", session: "wrong-view" }]);

    const res = await post("dev-impl@seat-rig");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      seat_ref: "dev-impl@seat-rig",
      session: "dev-impl@seat-rig",
      target: "dev-impl@seat-rig:0",
      client: "/dev/ttys003",
      mutated: false,
      retargeted: true,
    });
    expect(tmux().switchClient).toHaveBeenCalledWith("/dev/ttys003", "dev-impl@seat-rig:0");
  });

  it("404 for an unknown seat", async () => {
    const res = await post("ghost@seat-rig");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("seat_not_found");
    expect(tmux().switchClient).not.toHaveBeenCalled();
  });

  it("409 no_client when nothing is attached (honest error, no switch)", async () => {
    seedLiveSeat();
    tmux().hasSession.mockResolvedValue(true);
    tmux().listClients.mockResolvedValue([]);

    const res = await post("dev-impl@seat-rig");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("no_client");
    expect(tmux().switchClient).not.toHaveBeenCalled();
  });

  it("409 ambiguous_client when multiple attached and no --client", async () => {
    seedLiveSeat();
    tmux().hasSession.mockResolvedValue(true);
    tmux().listClients.mockResolvedValue([
      { name: "/dev/ttys003", session: "a" },
      { name: "/dev/ttys007", session: "b" },
    ]);

    const res = await post("dev-impl@seat-rig");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("ambiguous_client");
    expect(body.clients).toHaveLength(2);
    expect(tmux().switchClient).not.toHaveBeenCalled();
  });

  it("409 session_not_found points to routing repair when the canonical session is dead", async () => {
    seedLiveSeat();
    tmux().hasSession.mockResolvedValue(false);
    tmux().listClients.mockResolvedValue([{ name: "/dev/ttys003", session: "a" }]);

    const res = await post("dev-impl@seat-rig");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("session_not_found");
    expect(body.guidance).toContain("reconcile-session");
    expect(tmux().switchClient).not.toHaveBeenCalled();
  });

  it("404 window_not_found for an explicit --to-window that does not exist", async () => {
    seedLiveSeat();
    tmux().hasSession.mockResolvedValue(true);
    tmux().listWindows.mockResolvedValue([{ index: 0, name: "main", panes: 1, active: true }]);
    tmux().listClients.mockResolvedValue([{ name: "/dev/ttys003", session: "a" }]);

    const res = await post("dev-impl@seat-rig", { toWindow: 5 });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("window_not_found");
    expect(tmux().switchClient).not.toHaveBeenCalled();
  });

  it("502 tmux_probe_failed when listClients THROWS (honest error, not an unstructured 500)", async () => {
    seedLiveSeat();
    tmux().hasSession.mockResolvedValue(true);
    tmux().listClients.mockRejectedValue(new Error("error connecting to /private/tmp/tmux-501/default (Permission denied)"));

    const res = await post("dev-impl@seat-rig");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("tmux_probe_failed");
    expect(tmux().switchClient).not.toHaveBeenCalled();
  });

  it("502 tmux_probe_failed when listWindows THROWS on an explicit --to-window", async () => {
    seedLiveSeat();
    tmux().hasSession.mockResolvedValue(true);
    tmux().listWindows.mockRejectedValue(new Error("EACCES: permission denied"));
    tmux().listClients.mockResolvedValue([{ name: "/dev/ttys003", session: "a" }]);

    const res = await post("dev-impl@seat-rig", { toWindow: 1 });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("tmux_probe_failed");
    expect(tmux().switchClient).not.toHaveBeenCalled();
  });

  it("502 switch_failed when the tmux switch itself fails", async () => {
    seedLiveSeat();
    tmux().hasSession.mockResolvedValue(true);
    tmux().listClients.mockResolvedValue([{ name: "/dev/ttys003", session: "a" }]);
    tmux().switchClient.mockResolvedValue({ ok: false, code: "session_not_found", message: "gone" });

    const res = await post("dev-impl@seat-rig");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("switch_failed");
  });
});
