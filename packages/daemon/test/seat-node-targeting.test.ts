import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import type { SeatDeliveryGuard } from "../src/domain/seat-delivery-guard.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";

describe("node-addressed seat settings", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => { db = createFullTestDb(); app = createTestApp(db); });
  afterEach(() => db.close());

  function add(rigName: string) {
    const rig = app.rigRepo.createRig(rigName);
    const node = app.rigRepo.addNode(rig.id, "worker", { runtime: "codex", model: "old" });
    return { rig, node };
  }
  async function post(verb: string, target: string, body: Record<string, unknown>) {
    return app.app.request(`/api/seat/${verb}/${target}`, { method: "POST",
      headers: { "content-type": "application/json", "x-openrig-session": "operator@control" },
      body: JSON.stringify({ ...body, reason: "Reviewed setting" }) });
  }
  const verbs = [
    { name: "set-permissions", body: { mode: "floor" }, event: "node.permissions_changed" },
    { name: "set-policy", body: { ref: "builtin:yolo" }, event: "node.policy_changed" },
    { name: "set-model", body: { model: "new" }, event: "node.model_changed" },
    { name: "set-effort", body: { effort: "high" }, event: "node.effort_changed" },
  ];

  it.each(verbs)("$name binds to the exact node amid ambiguous names and leaves history untouched", async ({ name, body, event }) => {
    const selected = add("one"), other = add("two");
    const otherBefore = db.prepare("SELECT model, effort_choice, permission_policy FROM nodes WHERE id=?").get(other.node.id);
    const session = app.sessionRegistry.registerSession(selected.node.id, "worker@one");
    app.sessionRegistry.updateBinding(selected.node.id, { attachmentType: "tmux", tmuxSession: "worker@one", tmuxPane: "%1" });
    const before = ["sessions", "bindings", "occupant_tenures"].map(t => db.prepare(`SELECT * FROM ${t}`).all());
    const ambiguous = await post(name, "worker", body);
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({ code: "seat_ambiguous" });

    const response = await post(name, `node/${selected.node.id}`, body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, changed: true,
      seat: { nodeId: selected.node.id, rigId: selected.rig.id } });
    expect(["sessions", "bindings", "occupant_tenures"].map(t => db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before);
    expect(db.prepare("SELECT id FROM sessions WHERE id=?").get(session.id)).toBeDefined();
    const events = db.prepare("SELECT payload FROM events WHERE type=?").all(event) as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({ nodeId: selected.node.id, rigId: selected.rig.id,
      reason: "Reviewed setting", [name === "set-permissions" ? "actor" : "operator"]: "operator@control" });
    expect(db.prepare("SELECT model, effort_choice, permission_policy FROM nodes WHERE id=?").get(other.node.id)).toEqual(otherBefore);
    expect(db.prepare("SELECT COUNT(*) n FROM node_permission_selections WHERE node_id=?").get(other.node.id)).toEqual({ n: 0 });
  });

  it.each(verbs)("$name refuses deleted and archived IDs even with reusable names", async ({ name, body }) => {
    const selected = add("one");
    const replacement = add("two");
    app.rigRepo.deleteNode(selected.node.id);
    const missing = await post(name, `node/${selected.node.id}`, body);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "seat_not_found" });
    expect(app.rigRepo.getRig(replacement.rig.id)!.nodes[0]!.id).toBe(replacement.node.id);
    app.rigRepo.archiveRig(replacement.rig.id);
    const archived = await post(name, `node/${replacement.node.id}`, body);
    expect(archived.status).toBe(404);
    expect(await archived.json()).toMatchObject({ code: "seat_not_found" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id IN (?,?)").get(selected.node.id, replacement.node.id)).toEqual({ n: 0 });
  });

  it.each(verbs)("$name never retargets a deleted ID when the same rig reuses its name", async ({ name, body, event }) => {
    const original = add("one");
    app.rigRepo.deleteNode(original.node.id);
    const replacement = app.rigRepo.addNode(original.rig.id, "worker", { runtime: "codex", model: "old" });
    const oldId = await post(name, `node/${original.node.id}`, body);
    expect(oldId.status).toBe(404);
    expect(await oldId.json()).toMatchObject({ code: "seat_not_found" });
    expect(db.prepare("SELECT COUNT(*) n FROM events WHERE type=?").get(event)).toEqual({ n: 0 });
    const legacy = await post(name, "worker@one", body);
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toMatchObject({ ok: true, changed: true,
      seat: { nodeId: replacement.id, rigId: original.rig.id } });
    const rows = db.prepare("SELECT node_id FROM events WHERE type=?").all(event);
    expect(rows).toEqual([{ node_id: replacement.id }]);
  });

  it("reads the exact node status and advertises the additive contract", async () => {
    const chosen = add("one"); add("two");
    const exact = await app.app.request(`/api/seat/status/node/${chosen.node.id}`);
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ node_id: chosen.node.id, rig_id: chosen.rig.id,
      contract: "seat-node.v1", supported_actions: verbs.map(v => v.name) });
    const legacy = await app.app.request("/api/seat/status/worker");
    expect(legacy.status).toBe(409);
    const named = await app.app.request("/api/seat/status/worker@one");
    expect(named.status).toBe(200);
    expect(await named.json()).not.toHaveProperty("contract");
    app.rigRepo.archiveRig(chosen.rig.id);
    expect((await app.app.request(`/api/seat/status/node/${chosen.node.id}`)).status).toBe(404);
  });

  it("normalizes an encoded padded ID in exact status and guard enrichment", async () => {
    const selected = add("one");
    db.exec("CREATE TABLE outbox_entries (delivery_state TEXT, guard_binding TEXT, ts_dispatched TEXT, outbox_id TEXT)");
    db.prepare("INSERT INTO outbox_entries (delivery_state, guard_binding, ts_dispatched, outbox_id) VALUES ('retained', ?, '', 'held')")
      .run(JSON.stringify({ nodeId: selected.node.id }));
    const preference = vi.fn((nodeId: string) => ({ nodeId, desired: false, effective: false, pending: false,
      desiredMode: "off", effectiveMode: "off" }));
    app.tmuxAdapter.deliveryGuard = { db, preference } as unknown as SeatDeliveryGuard;
    const response = await app.app.request(`/api/seat/status/node/${encodeURIComponent(` ${selected.node.id} `)}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ node_id: selected.node.id, rig_id: selected.rig.id,
      typingGuard: { nodeId: selected.node.id, heldCount: 1 } });
    expect(preference).toHaveBeenCalledExactlyOnceWith(selected.node.id);
  });

  it.each(verbs)("$name refuses a formerly valid node after archive, even for the same value", async ({ name, body, event }) => {
    const selected = add("one");
    expect((await post(name, `node/${selected.node.id}`, body)).status).toBe(200);
    const noOp = await post(name, `node/${selected.node.id}`, body);
    expect(noOp.status).toBe(200);
    expect(await noOp.json()).toMatchObject({ ok: true, changed: false, seat: { nodeId: selected.node.id } });
    const count = db.prepare("SELECT COUNT(*) n FROM events WHERE type=?").get(event);
    app.rigRepo.archiveRig(selected.rig.id);
    const refusal = await post(name, `node/${selected.node.id}`, body);
    expect(refusal.status).toBe(404);
    expect(await refusal.json()).toMatchObject({ code: "seat_not_found" });
    expect(db.prepare("SELECT COUNT(*) n FROM events WHERE type=?").get(event)).toEqual(count);
  });

  it.each(["delete", "archive"] as const)(
    "refuses an unavailable exact node after awaited Claude preparation: %s", async change => {
      const rig = app.rigRepo.createRig("claude-rig");
      const node = app.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code", cwd: "/old" });
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const pending = new Promise<void>(resolve => { release = resolve; });
      const service = new SeatLifecycleService({ db, rigRepo: app.rigRepo, sessionRegistry: app.sessionRegistry,
        eventBus: app.eventBus, tmuxAdapter: app.tmuxAdapter,
        runtimeAdapters: { "claude-code": { claudeManagedLaunch: { prepare: async () => {
          enter(); await pending;
          // This no-op assertion isolates the added node eligibility check. S03 separately
          // verifies that real Claude preparation refuses generation changes during help.
          return { assertCurrent: () => {} };
        } } } as never } });
      const saving = service.setPermissions({ nodeId: node.id, mode: "acceptEdits", reason: "native choice", actor: "operator@control" });
      await entered;
      if (change === "delete") app.rigRepo.deleteNode(node.id);
      else app.rigRepo.archiveRig(rig.id);
      release();
      const result = await saving;
      expect(result).toMatchObject({ ok: false, code: "seat_not_found" });
      expect(db.prepare("SELECT COUNT(*) n FROM events WHERE type='node.permissions_changed'").get())
        .toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) n FROM node_permission_selections WHERE node_id=?").get(node.id))
        .toEqual({ n: 0 });
    });

  it.each(["delete", "archive"] as const)(
    "refuses an unavailable exact node after awaited Codex profile observation: %s", async change => {
      const selected = add("one");
      db.prepare("UPDATE nodes SET cwd='/old' WHERE id=?").run(selected.node.id);
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const pending = new Promise<void>(resolve => { release = resolve; });
      const service = new SeatLifecycleService({ db, rigRepo: app.rigRepo, sessionRegistry: app.sessionRegistry,
        eventBus: app.eventBus, tmuxAdapter: app.tmuxAdapter,
        runtimeAdapters: { codex: { observeProfile: async () => {
          enter(); await pending;
          return { vantage: "configured_codex_home", home: "/home/codex", file: "absent", load: "ok",
            detail: "Profile file absent", observedAt: new Date().toISOString() };
        } } as never } });
      const saving = service.setPermissions({ nodeId: selected.node.id, codexProfile: "reviewed", reason: "native choice", actor: "operator@control" });
      await entered;
      if (change === "delete") app.rigRepo.deleteNode(selected.node.id);
      else app.rigRepo.archiveRig(selected.rig.id);
      release();
      expect(await saving).toMatchObject({ ok: false, code: "seat_not_found" });
      expect(db.prepare("SELECT COUNT(*) n FROM events WHERE type='node.codex_profile_changed'").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) n FROM nodes WHERE id=? AND codex_config_profile IS NOT NULL").get(selected.node.id))
        .toEqual({ n: 0 });
    });
});

describe("#3253 status processLimits", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createTestApp>;
  let read: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createFullTestDb(); app = createTestApp(db);
    read = vi.fn(async (_target: string, requested: { tasksMax?: number; memoryMax?: number }) => ({ state: "applied", requested, pidsMax: String(requested.tasksMax),
      pidsCurrent: 3, limitHits: 0, scope: "openrig-seat-worker_one-1a2b3c4d.scope" }));
    Object.assign(app.tmuxAdapter, { readSeatProcessLimits: read });
  });
  afterEach(() => db.close());

  /** A seat with a limit (or none), its session in `status`, and its binding's pane (null: none recorded). */
  function seat(opts: { tasksMax?: number; memoryMax?: number; status?: string; pane?: string | null }) {
    const rig = app.rigRepo.createRig("one");
    const node = app.rigRepo.addNode(rig.id, "worker", { runtime: "codex", model: "m",
      ...(opts.tasksMax || opts.memoryMax ? { processLimits: {
        ...(opts.tasksMax ? { tasksMax: opts.tasksMax } : {}), ...(opts.memoryMax ? { memoryMax: opts.memoryMax } : {}) } } : {}) });
    if (opts.status) {
      const session = app.sessionRegistry.registerSession(node.id, "worker@one");
      app.sessionRegistry.updateStatus(session.id, opts.status);
      if (opts.pane !== undefined) app.sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: "worker@one", tmuxPane: opts.pane });
    }
    return node;
  }
  const status = async () => {
    const res = await app.app.request("/api/seat/status/worker@one");
    expect(res.status).toBe(200);
    return await res.json() as { current_occupant: string | null; processLimits?: Record<string, unknown> };
  };

  it("a stopped seat whose session name is still recorded reads not_applied, without reading tmux", async () => {
    seat({ tasksMax: 256, status: "exited", pane: "%7" });
    const body = await status();
    expect(body.current_occupant).toBe("worker@one");
    expect(body.processLimits).toEqual({ state: "not_applied", requested: { tasksMax: 256 },
      reason: "the seat is not running; the limit applies at its next fresh launch" });
    expect(read).not.toHaveBeenCalled();
  });

  it("a stopped seat with only memory_max reads not_applied with that request, without reading tmux", async () => {
    seat({ memoryMax: 4294967296, status: "exited", pane: "%7" });
    expect((await status()).processLimits).toEqual({ state: "not_applied", requested: { memoryMax: 4294967296 },
      reason: "the seat is not running; the limit applies at its next fresh launch" });
    expect(read).not.toHaveBeenCalled();
  });

  it("a stopped seat with both limits reads not_applied with both requested, without reading tmux", async () => {
    seat({ tasksMax: 128, memoryMax: 1073741824, status: "exited", pane: "%7" });
    expect((await status()).processLimits).toEqual({ state: "not_applied", requested: { tasksMax: 128, memoryMax: 1073741824 },
      reason: "the seat is not running; the limit applies at its next fresh launch" });
    expect(read).not.toHaveBeenCalled();
  });

  it("an unreadable stored value reads invalid, with a 200", async () => {
    const node = seat({ tasksMax: 256, status: "running", pane: "%7" });
    db.prepare("UPDATE nodes SET process_limits = 'BAD' WHERE id = ?").run(node.id);
    expect((await status()).processLimits).toMatchObject({ state: "invalid", reason: expect.stringMatching(/the stored value is kept$/) });
    expect(read).not.toHaveBeenCalled();
  });

  it("a running seat is read from its bound pane, not its session's active pane", async () => {
    const node = seat({ tasksMax: 256, status: "running", pane: "%7" });
    expect((await status()).processLimits).toMatchObject({ state: "applied", readFrom: "the seat's pane" });
    expect(read).toHaveBeenCalledWith("%7", { tasksMax: 256 }, node.id);
  });

  it("a running seat with no pane recorded falls back to its session and says so", async () => {
    const node = seat({ tasksMax: 256, status: "running", pane: null });
    expect((await status()).processLimits).toMatchObject({ state: "applied",
      readFrom: "the session's active pane (no pane is recorded for the seat)" });
    expect(read).toHaveBeenCalledWith("worker@one", { tasksMax: 256 }, node.id);
  });

  it("no limit stored and not in a seat scope: no processLimits", async () => {
    seat({ status: "running", pane: "%7" });
    expect(await status()).not.toHaveProperty("processLimits");
    expect(read).not.toHaveBeenCalled();
  });

  it("a stopped seat with no limit reads nothing from tmux", async () => {
    seat({ status: "exited", pane: "%7" });
    expect(await status()).not.toHaveProperty("processLimits");
  });

  it("a seat in an environment guest reads not_applied, never applied, and nothing is read from its pane", async () => {
    const node = seat({ tasksMax: 256, status: "running", pane: "%7" });
    const real = new TmuxAdapter(async () => { throw new Error("no tmux in this test"); });
    real.seatInEnvironmentGuest = (id) => id === node.id;
    const getPanePid = vi.spyOn(real, "getPanePid");
    Object.assign(app.tmuxAdapter, { readSeatProcessLimits: real.readSeatProcessLimits.bind(real), seatInEnvironmentGuest: real.seatInEnvironmentGuest });
    const limits = (await status()).processLimits;
    expect(limits).toMatchObject({ state: "not_applied", requested: { tasksMax: 256 }, reason: expect.stringMatching(/environment guest/) });
    expect(limits).not.toHaveProperty("readFrom");
    expect(getPanePid).not.toHaveBeenCalled();
  });
});
