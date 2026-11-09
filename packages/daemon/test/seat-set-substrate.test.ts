import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

/** `rig seat set-substrate`: a stopped seat moves to another terminal substrate for its next launch; a live one can't. */
describe("SeatLifecycleService.setTerminalSubstrate", () => {
  let db: Database.Database;
  let repo: RigRepository;
  let registry: SessionRegistry;
  let probe: { state: string; cause?: string };
  let probed: string[];
  let service: SeatLifecycleService;

  beforeEach(() => {
    db = createFullTestDb();
    repo = new RigRepository(db);
    registry = new SessionRegistry(db);
    probe = { state: "absent" };
    probed = [];
    const tmuxAdapter = { probeSession: async (name: string) => { probed.push(name); return probe; } } as unknown as TmuxAdapter;
    service = new SeatLifecycleService({ db, rigRepo: repo, sessionRegistry: registry, eventBus: new EventBus(db), tmuxAdapter });
  });
  afterEach(() => db.close());

  function seat(status: string | null) {
    const rig = repo.createRig("moving");
    const node = repo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/project" });
    if (status) registry.updateStatus(registry.registerSession(node.id, "dev-impl@moving").id, status);
    return node;
  }
  const stored = (nodeId: string) =>
    (db.prepare("SELECT terminal_substrate FROM nodes WHERE id = ?").get(nodeId) as { terminal_substrate: string | null }).terminal_substrate;
  const events = () => db.prepare("SELECT payload FROM events WHERE type = 'node.terminal_substrate_changed'").all() as Array<{ payload: string }>;

  it("moves a stopped seat to herdr and back to tmux, audited, for the next launch", async () => {
    const node = seat("exited");
    const there = await service.setTerminalSubstrate({ seatRef: "dev-impl@moving", substrate: "herdr", reason: "move", operator: "op@kernel" });
    expect(there).toMatchObject({ ok: true, from: "tmux", to: "herdr", changed: true, effect: "next_launch", next: "rig up moving --existing" });
    expect(stored(node.id)).toBe("herdr");
    expect(probed).toEqual(["dev-impl@moving"]);
    const back = await service.setTerminalSubstrate({ seatRef: "dev.impl", substrate: "tmux", reason: "move back" });
    expect(back).toMatchObject({ ok: true, from: "herdr", to: "tmux", changed: true });
    expect(stored(node.id)).toBeNull();
    expect(events().map(e => JSON.parse(e.payload))).toMatchObject([
      { from: "tmux", to: "herdr", reason: "move", operator: "op@kernel" }, { from: "herdr", to: "tmux", reason: "move back" },
    ]);
  });

  it("is a no-op (no event) when the seat is already there", async () => {
    seat(null);
    expect(await service.setTerminalSubstrate({ seatRef: "dev.impl", substrate: "tmux", reason: "x" }))
      .toMatchObject({ ok: true, changed: false });
    expect(events()).toHaveLength(0);
  });

  it("refuses a live seat, an open terminal session and an unreadable probe, changing nothing", async () => {
    const live = seat("running");
    expect(await service.setTerminalSubstrate({ seatRef: "dev.impl", substrate: "herdr", reason: "x" }))
      .toMatchObject({ ok: false, code: "session_live" });
    expect(probed).toEqual([]);
    db.prepare("UPDATE sessions SET status = 'exited' WHERE node_id = ?").run(live.id);
    probe = { state: "present" };
    expect(await service.setTerminalSubstrate({ seatRef: "dev.impl", substrate: "herdr", reason: "x" }))
      .toMatchObject({ ok: false, code: "session_live" });
    probe = { state: "transport_unavailable", cause: "no server" };
    expect(await service.setTerminalSubstrate({ seatRef: "dev.impl", substrate: "herdr", reason: "x" }))
      .toMatchObject({ ok: false, code: "tmux_probe_failed" });
    expect(stored(live.id)).toBeNull();
    expect(events()).toHaveLength(0);
  });

  it("requires a known substrate and a reason", async () => {
    seat("exited");
    expect(await service.setTerminalSubstrate({ seatRef: "dev.impl", substrate: "screen", reason: "x" }))
      .toMatchObject({ ok: false, code: "invalid_terminal_substrate" });
    expect(await service.setTerminalSubstrate({ seatRef: "dev.impl", substrate: "herdr", reason: " " }))
      .toMatchObject({ ok: false, code: "missing_reason" });
  });
});
