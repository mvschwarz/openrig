import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { seatRoutes } from "../src/routes/seat.js";

describe("seat-stop.v1 checked stop", () => {
  let db: Database.Database;
  let repo: RigRepository;
  let registry: SessionRegistry;
  let bus: EventBus;
  let adapter: TmuxAdapter;
  let service: SeatLifecycleService;
  let commands: string[];
  let onProbe: (() => void) | undefined;
  let onPanes: (() => void) | undefined;
  let onDetach: (() => void) | undefined;
  let onKill: (() => void) | undefined;
  let killError: Error | undefined;

  beforeEach(() => {
    db = createFullTestDb();
    db.exec(outboxEntriesSchema.sql);
    db.exec(seatDeliveryGuardSchema.sql);
    repo = new RigRepository(db);
    registry = new SessionRegistry(db);
    bus = new EventBus(db);
    commands = [];
    onProbe = onPanes = onDetach = onKill = undefined;
    killError = undefined;
    adapter = new TmuxAdapter(async command => {
      commands.push(command);
      if (command.includes("has-session")) { onProbe?.(); return ""; }
      if (command.includes("list-panes")) { onPanes?.(); return "%1|0|/project|120|40|1"; }
      if (command.includes("display-message")) return "$7";
      if (command.includes("detach-client")) { onDetach?.(); return ""; }
      if (command.includes("kill-session")) { onKill?.(); if (killError) throw killError; return ""; }
      throw new Error(`unexpected tmux command: ${command}`);
    });
    adapter.deliveryGuard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
    service = new SeatLifecycleService({ db, rigRepo: repo, sessionRegistry: registry, eventBus: bus, tmuxAdapter: adapter });
  });
  afterEach(() => db.close());

  function seat(logicalId: string) {
    const rig = repo.findRigsByName("checked")[0] ?? repo.createRig("checked");
    const node = repo.addNode(rig.id, logicalId, { runtime: "claude-code", cwd: "/project" });
    const name = `${logicalId.replaceAll(".", "-")}@checked`;
    const session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: name, tmuxPane: "%1" });
    return { node, session, name };
  }
  function expected(name: string) {
    const result = service.stopPrecondition(name);
    expect(result).toMatchObject({ contract: "seat-stop.v1" });
    if (!("contract" in result)) throw new Error(result.message);
    return result.expected;
  }
  function status(id: string) {
    return (db.prepare("SELECT status FROM sessions WHERE id=?").get(id) as { status: string }).status;
  }
  const stop = (name: string, precondition: unknown) => service.stopSeat({ seatRef: name, reason: "operator requested pause", expected: precondition });

  it("returns a narrow review tuple and refuses malformed expected without effects", async () => {
    const a = seat("dev.a");
    expect(expected(a.name)).toEqual({ nodeId: a.node.id, sessionId: a.session.id });
    for (const malformed of [null, {}, { nodeId: a.node.id }, { nodeId: "", sessionId: a.session.id },
      { nodeId: a.node.id, sessionId: 42 }, { nodeId: a.node.id, sessionId: a.session.id, extra: true }]) {
      expect(await stop(a.name, malformed)).toMatchObject({ ok: false, code: "invalid_stop_precondition" });
    }
    expect(commands).toEqual([]);
    const empty = repo.addNode(a.node.rigId, "dev.empty", { runtime: "claude-code" });
    expect(expected("dev.empty")).toEqual({ nodeId: empty.id, sessionId: null });
    expect(await stop("dev.empty", { nodeId: empty.id, sessionId: null })).toMatchObject({ ok: false, code: "no_session" });
  });

  it("exposes the GET contract and strict POST validation over HTTP", async () => {
    const a = seat("dev.a");
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("rigRepo" as never, repo as never); c.set("sessionRegistry" as never, registry as never);
      c.set("eventBus" as never, bus as never); c.set("tmuxAdapter" as never, adapter as never);
      await next();
    });
    app.route("/api/seat", seatRoutes);
    const path = `/api/seat/stop/${encodeURIComponent(a.name)}`;
    const precondition = await app.request(`/api/seat/stop-precondition/${encodeURIComponent(a.name)}`);
    expect(precondition.status).toBe(200);
    expect(await precondition.json()).toEqual({ contract: "seat-stop.v1", expected: expected(a.name) });
    const malformed = await app.request(path, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "pause", expected: { nodeId: a.node.id } }) });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ ok: false, code: "invalid_stop_precondition" });
    expect(commands).toEqual([]);
    const accepted = await app.request(path, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "pause", expected: expected(a.name) }) });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true, sessionId: a.session.id });
  });

  it("refuses checked stop when the delivery guard is unavailable", async () => {
    const a = seat("dev.a"); const selected = expected(a.name);
    adapter.deliveryGuard = undefined;
    expect(await stop(a.name, selected)).toMatchObject({ ok: false, code: "guard_unavailable" });
    expect(commands).toEqual([]);
  });

  it("keeps claimed-session and typing protection on the checked path", async () => {
    const a = seat("dev.a");
    db.prepare("UPDATE sessions SET origin='claimed' WHERE id=?").run(a.session.id);
    expect(await stop(a.name, expected(a.name))).toMatchObject({ ok: false, code: "claimed_session" });
    db.prepare("UPDATE sessions SET origin='managed' WHERE id=?").run(a.session.id);
    await adapter.deliveryGuard!.set(a.node.id, { mode: "hold" }, "operator", "protect current draft");
    expect(await stop(a.name, expected(a.name))).toMatchObject({ ok: false, code: "typing_guard_enabled" });
    expect(commands).toEqual([]);
  });

  it("stops exactly the reviewed live session and keeps the sibling", async () => {
    const a = seat("dev.a"); const b = seat("dev.b");
    const result = await stop(a.name, expected(a.name));
    expect(result).toMatchObject({ ok: true, sessionName: a.name, sessionId: a.session.id });
    expect(commands.filter(command => command.includes("detach-client") || command.includes("kill-session"))).toEqual([
      "tmux detach-client -s '$7'", "tmux kill-session -t '$7'",
    ]);
    expect(status(a.session.id)).toBe("exited");
    expect(registry.getBindingForNode(a.node.id)).toBeNull();
    expect(status(b.session.id)).toBe("running");
    expect(registry.getBindingForNode(b.node.id)).not.toBeNull();
  });

  it("refuses a changed latest session before effects, including an asynchronous liveness change", async () => {
    const a = seat("dev.a"); const old = expected(a.name);
    const replacement = registry.registerSession(a.node.id, a.name);
    registry.updateStatus(replacement.id, "running");
    expect(await stop(a.name, old)).toMatchObject({ ok: false, code: "selection_changed" });
    expect(commands).toEqual([]);
    const current = expected(a.name);
    onProbe = () => { onProbe = undefined; registry.registerSession(a.node.id, a.name); };
    expect(await stop(a.name, current)).toMatchObject({ ok: false, code: "selection_changed" });
    expect(commands.some(command => command.includes("detach-client"))).toBe(false);
  });

  it("refuses a changed binding with the same public tuple before detach", async () => {
    const a = seat("dev.a"); const selected = expected(a.name);
    onPanes = () => { onPanes = undefined; registry.updateBinding(a.node.id, { attachmentType: "tmux", tmuxSession: a.name, tmuxPane: "%2" }); };
    expect(await stop(a.name, selected)).toMatchObject({ ok: false, code: "selection_changed" });
    expect(commands.some(command => command.includes("detach-client"))).toBe(false);
    expect(registry.getBindingForNode(a.node.id)?.tmuxPane).toBe("%2");
  });

  it("refuses a changed occupant with the same public tuple before detach", async () => {
    const a = seat("dev.a"); const selected = expected(a.name);
    let occupant = "generation-one";
    adapter.deliveryGuard = new SeatDeliveryGuard(db, name => {
      const target = resolveGuardTarget(db, name);
      return target && { ...target, occupant };
    });
    onPanes = () => { occupant = "generation-two"; };
    expect(await stop(a.name, selected)).toMatchObject({ ok: false, code: "selection_changed", partialEffect: false });
    expect(commands.some(command => command.includes("detach-client"))).toBe(false);
  });

  it("reports a changed selection after detach as partial and leaves the successor intact", async () => {
    const a = seat("dev.a"); const selected = expected(a.name);
    onDetach = () => { const next = registry.registerSession(a.node.id, a.name); registry.updateStatus(next.id, "running"); };
    expect(await stop(a.name, selected)).toMatchObject({ ok: false, code: "selection_changed", partialEffect: true, stopPhase: "detached" });
    expect(commands.some(command => command.includes("kill-session"))).toBe(false);
    expect(registry.getBindingForNode(a.node.id)).not.toBeNull();
  });

  it("reports a changed selection after kill without clearing the successor binding", async () => {
    const a = seat("dev.a"); const selected = expected(a.name);
    onKill = () => { const next = registry.registerSession(a.node.id, a.name); registry.updateStatus(next.id, "running");
      registry.updateBinding(a.node.id, { attachmentType: "tmux", tmuxSession: a.name, tmuxPane: "%2" }); };
    expect(await stop(a.name, selected)).toMatchObject({ ok: false, code: "selection_changed", partialEffect: true });
    expect(registry.getBindingForNode(a.node.id)?.tmuxPane).toBe("%2");
    expect(status(a.session.id)).toBe("running");
  });

  it("protects a changed binding after kill even when node and latest session IDs match", async () => {
    const a = seat("dev.a"); const selected = expected(a.name);
    onKill = () => registry.updateBinding(a.node.id, { attachmentType: "tmux", tmuxSession: a.name, tmuxPane: "%2" });
    expect(await stop(a.name, selected)).toMatchObject({ ok: false, code: "selection_changed", partialEffect: true });
    expect(registry.getBindingForNode(a.node.id)?.tmuxPane).toBe("%2");
    expect(status(a.session.id)).toBe("running");
  });

  it("reports kill and persistence failures as uncertain after external effects", async () => {
    const a = seat("dev.a");
    killError = new Error("socket lost after dispatch");
    expect(await stop(a.name, expected(a.name))).toMatchObject({ ok: false, code: "stop_uncertain", partialEffect: true, stopPhase: "kill_attempted" });
    expect(registry.getBindingForNode(a.node.id)).not.toBeNull();
    killError = new Error(`can't find session: ${a.name}`);
    expect(await stop(a.name, expected(a.name))).toMatchObject({ ok: false, code: "stop_uncertain", partialEffect: true });
    killError = undefined;
    vi.spyOn(bus, "persistWithinTransaction").mockImplementationOnce(() => { throw new Error("audit unavailable"); });
    expect(await stop(a.name, expected(a.name))).toMatchObject({ ok: false, code: "stop_uncertain", partialEffect: true });
    expect(status(a.session.id)).toBe("running");
    expect(registry.getBindingForNode(a.node.id)).not.toBeNull();
  });
});
