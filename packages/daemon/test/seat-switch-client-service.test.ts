import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatSwitchClientService } from "../src/domain/seat-switch-client-service.js";
import type { TmuxAdapter, TmuxClient, TmuxWindow, TmuxResult } from "../src/adapters/tmux.js";

/**
 * OPR.0.4.3.26 — VIEW-ONLY switch-client retarget. The service holds only
 * rigRepo (read) + tmuxAdapter (probe + switch); it is structurally incapable of
 * mutating routing/bindings/sessions. These tests pin the mechanism AND the
 * view-only invariant: no session/binding mutation adapter call ever fires.
 */

/** A tmux mock with every method spied so the invariant test can assert that no
 *  mutation method (createSession/killSession/sendText/sendKeys/setSessionOption)
 *  is ever invoked by the view retarget. */
function spyTmux(overrides: {
  hasSession?: boolean;
  windows?: TmuxWindow[];
  clients?: TmuxClient[];
  switchResult?: TmuxResult;
  hasSessionThrows?: Error;
} = {}) {
  const mutators = {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    setSessionOption: vi.fn(async () => ({ ok: true as const })),
    createWindow: vi.fn(async () => ({ ok: true as const })),
  };
  const probes = {
    hasSession: vi.fn(async () => {
      if (overrides.hasSessionThrows) throw overrides.hasSessionThrows;
      return overrides.hasSession ?? true;
    }),
    listWindows: vi.fn(async () => overrides.windows ?? [{ index: 0, name: "main", panes: 1, active: true }]),
    listClients: vi.fn(async () => overrides.clients ?? []),
    switchClient: vi.fn(async () => overrides.switchResult ?? ({ ok: true as const })),
  };
  const adapter = { ...mutators, ...probes } as unknown as TmuxAdapter;
  return { adapter, mutators, probes };
}

function client(name: string, session: string): TmuxClient {
  return { name, session };
}

describe("SeatSwitchClientService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
  });

  afterEach(() => { db.close(); });

  /** Seed a live seat whose canonical session is `dev-impl@seat-rig`. */
  function seedLiveSeat() {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/project" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    sessionRegistry.updateStatus(session.id, "running");
    return { rig, node, session };
  }

  it("retargets the single attached client to <session>:0 and returns view-only success", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({ clients: [client("/dev/ttys003", "wrong-view")] });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.result).toMatchObject({
      seat_ref: "dev-impl@seat-rig",
      session: "dev-impl@seat-rig",
      window: 0,
      target: "dev-impl@seat-rig:0",
      client: "/dev/ttys003",
      mutated: false,
      retargeted: true,
    });
    expect(probes.switchClient).toHaveBeenCalledWith("/dev/ttys003", "dev-impl@seat-rig:0");
  });

  // THE money proof: a successful view retarget mutates NOTHING in OpenRig.
  it("VIEW-ONLY invariant: never calls a session/binding mutation adapter method", async () => {
    seedLiveSeat();
    const { adapter, mutators } = spyTmux({ clients: [client("/dev/ttys003", "wrong-view")] });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig" });
    expect(result.ok).toBe(true);

    // No session lifecycle mutation, no send, no option write.
    expect(mutators.createSession).not.toHaveBeenCalled();
    expect(mutators.killSession).not.toHaveBeenCalled();
    expect(mutators.sendText).not.toHaveBeenCalled();
    expect(mutators.sendKeys).not.toHaveBeenCalled();
    expect(mutators.setSessionOption).not.toHaveBeenCalled();

    // And no binding/session mutation leaked into the DB: the session is still
    // the one registered, running, and no successor/handover rows appeared.
    const rows = db.prepare("SELECT status FROM sessions WHERE session_name = ?").all("dev-impl@seat-rig") as Array<{ status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("running");
  });

  it("targets an explicit --to-window after verifying it exists", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({
      clients: [client("/dev/ttys003", "wrong-view")],
      windows: [
        { index: 0, name: "main", panes: 1, active: false },
        { index: 1, name: "logs", panes: 1, active: true },
      ],
    });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig", toWindow: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.result.target).toBe("dev-impl@seat-rig:1");
    expect(probes.switchClient).toHaveBeenCalledWith("/dev/ttys003", "dev-impl@seat-rig:1");
  });

  it("honest window_not_found (never a raw tmux failure) for a missing --to-window", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({
      clients: [client("/dev/ttys003", "wrong-view")],
      windows: [{ index: 0, name: "main", panes: 1, active: true }],
    });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig", toWindow: 5 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("window_not_found");
    expect(probes.switchClient).not.toHaveBeenCalled();
  });

  it("honest no_client error (suggest attach / CMUX) when no client is attached", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({ clients: [] });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("no_client");
    expect(result.guidance).toContain("tmux attach -t dev-impl@seat-rig");
    expect(probes.switchClient).not.toHaveBeenCalled();
  });

  it("honest ambiguous_client (lists clients, never picks one) when multiple attached and no --client", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({
      clients: [client("/dev/ttys003", "a"), client("/dev/ttys007", "b")],
    });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("ambiguous_client");
    expect(result.clients).toEqual([
      { name: "/dev/ttys003", session: "a" },
      { name: "/dev/ttys007", session: "b" },
    ]);
    expect(probes.switchClient).not.toHaveBeenCalled();
  });

  it("--client selects the named client out of several", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({
      clients: [client("/dev/ttys003", "a"), client("/dev/ttys007", "b")],
    });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig", client: "/dev/ttys007" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.result.client).toBe("/dev/ttys007");
    expect(probes.switchClient).toHaveBeenCalledWith("/dev/ttys007", "dev-impl@seat-rig:0");
  });

  it("client_not_found lists attached clients when --client names none of them", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({ clients: [client("/dev/ttys003", "a")] });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig", client: "/dev/ttys999" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("client_not_found");
    expect(result.clients).toEqual([{ name: "/dev/ttys003", session: "a" }]);
    expect(probes.switchClient).not.toHaveBeenCalled();
  });

  it("session_not_found points to routing repair (reconcile/handover) and never switches", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({ hasSession: false, clients: [client("/dev/ttys003", "a")] });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("session_not_found");
    expect(result.guidance).toContain("reconcile-session");
    expect(probes.switchClient).not.toHaveBeenCalled();
  });

  it("missing_canonical_session for a seat with no current occupant (never fresh-launch)", async () => {
    // Node exists but no running session -> current_occupant is null.
    const rig = rigRepo.createRig("seat-rig");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    const { adapter, probes, mutators } = spyTmux({ clients: [client("/dev/ttys003", "a")] });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    // No session registered -> resolve by the logical-id form (there is no
    // canonical session name to match on yet).
    const result = await service.switchClient({ seatRef: "dev.impl@seat-rig" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("missing_canonical_session");
    expect(probes.switchClient).not.toHaveBeenCalled();
    expect(mutators.createSession).not.toHaveBeenCalled();
  });

  it("propagates seat_not_found for an unknown seat", async () => {
    const { adapter } = spyTmux();
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "ghost@seat-rig" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("seat_not_found");
  });

  it("surfaces tmux_probe_failed on an unexpected probe error (no silent switch)", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({
      hasSessionThrows: new Error("EACCES: permission denied"),
      clients: [client("/dev/ttys003", "a")],
    });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("tmux_probe_failed");
    expect(probes.switchClient).not.toHaveBeenCalled();
  });

  it("catches a listClients THROW as tmux_probe_failed (never leaks the raw throw, never switches)", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({ clients: [client("/dev/ttys003", "a")] });
    // Adapter intentionally rethrows unexpected probe failures (permission/socket).
    probes.listClients.mockRejectedValueOnce(new Error("error connecting to /private/tmp/tmux-501/default (Permission denied)"));
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("tmux_probe_failed");
    expect(result.message).toContain("list-clients");
    expect(result.message).toContain("Permission denied");
    expect(probes.switchClient).not.toHaveBeenCalled();
  });

  it("catches a listWindows THROW (explicit --to-window) as tmux_probe_failed (never switches)", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({ clients: [client("/dev/ttys003", "a")] });
    probes.listWindows.mockRejectedValueOnce(new Error("EACCES: permission denied"));
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig", toWindow: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("tmux_probe_failed");
    expect(result.message).toContain("list-windows");
    expect(probes.switchClient).not.toHaveBeenCalled();
  });

  it("surfaces switch_failed when the tmux switch-client itself fails", async () => {
    seedLiveSeat();
    const { adapter } = spyTmux({
      clients: [client("/dev/ttys003", "a")],
      switchResult: { ok: false, code: "session_not_found", message: "can't find session" },
    });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("switch_failed");
  });
});
