import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestApp } from "./helpers/test-app.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";

describe("unclaim preserves a successor's custody", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    setup = createTestApp(db);
    setup.tmuxAdapter.deliveryGuard = new SeatDeliveryGuard(db, target => resolveGuardTarget(db, target));
  });
  afterEach(() => { db.close(); });

  async function claimedSeat() {
    const rig = setup.rigRepo.createRig("adoption-fixture");
    const node = setup.rigRepo.addNode(rig.id, "external.helper", { runtime: "terminal" });
    const discovered = setup.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: "manual-adoption", tmuxPane: "%1", cwd: "/tmp",
      activeCommand: "bash", runtimeHint: "terminal", confidence: "high",
    });
    const claim = await setup.claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: node.logicalId });
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error(claim.error);
    return { rig, node, discovered, claim };
  }

  function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }

  it.each([true, false])("does not let a replayed old session ID release a newly reclaimed seat (guard=%s)", async guarded => {
    const { rig, node, discovered, claim } = await claimedSeat();
    const first = await setup.app.request(`/api/sessions/${claim.sessionId}/unclaim`, { method: "POST" });
    expect(first.status).toBe(200);
    const successor = await setup.claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: node.logicalId });
    expect(successor.ok).toBe(true);
    const binding = setup.sessionRegistry.getBindingForNode(node.id);
    const discovery = setup.discoveryRepo.getDiscoveredSession(discovered.id);
    if (!guarded) setup.tmuxAdapter.deliveryGuard = undefined;
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockClear();

    const replay = await setup.app.request(`/api/sessions/${claim.sessionId}/unclaim`, { method: "POST" });

    expect(setup.sessionRegistry.getBindingForNode(node.id)).toEqual(binding);
    expect(setup.discoveryRepo.getDiscoveredSession(discovered.id)).toEqual(discovery);
    expect(setup.tmuxAdapter.setSessionOption).not.toHaveBeenCalled();
    expect(replay.status).toBe(409);
  });

  it("does not let an old claimed session ID detach a launched successor", async () => {
    const { rig, node, claim } = await claimedSeat();
    expect((await setup.rigLifecycleService.unclaimSession(claim.sessionId)).ok).toBe(true);
    const launched = await setup.nodeLauncher.launchNode(rig.id, node.logicalId);
    expect(launched.ok).toBe(true);
    const binding = setup.sessionRegistry.getBindingForNode(node.id);
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockClear();

    const res = await setup.app.request(`/api/sessions/${claim.sessionId}/unclaim`, { method: "POST" });

    expect(setup.sessionRegistry.getBindingForNode(node.id)).toEqual(binding);
    expect(setup.tmuxAdapter.setSessionOption).not.toHaveBeenCalled();
    expect(res.status).toBe(409);
  });

  it.each(["unclaim", "release"] as const)("serializes %s metadata cleanup with a concurrent rebind", async operation => {
    const { rig, node, discovered, claim } = await claimedSeat();
    const entered = barrier();
    const finish = barrier();
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      return { ok: true };
    });
    const request = setup.app.request(operation === "unclaim"
      ? `/api/sessions/${claim.sessionId}/unclaim`
      : `/api/rigs/${rig.id}/release`, { method: "POST" });
    await entered.promise;
    let rebindEntered = false;
    const guard = setup.tmuxAdapter.deliveryGuard!;
    const rebind = guard.lifecycle([node.id], async () => {
      rebindEntered = true;
      // This is the same binding replacement performed by a lifecycle operation.
      const next = setup.sessionRegistry.registerClaimedSession(node.id, "replacement-adoption");
      setup.sessionRegistry.updateBinding(node.id, { tmuxSession: next.sessionName, tmuxPane: "%2" });
      setup.discoveryRepo.markClaimed(discovered.id, node.id);
      guard.rebindLifecycle(node.id);
      return setup.sessionRegistry.getBindingForNode(node.id);
    }).then(binding => ({ binding, error: null }), error => ({ binding: null, error }));
    // An unguarded releaser allows this operation to enter before its cleanup ends.
    await new Promise<void>(resolve => setImmediate(resolve));
    const enteredDuringCleanup = rebindEntered;
    finish.resolve();
    await request;
    const rebound = await rebind;
    expect(enteredDuringCleanup).toBe(false);
    expect(rebound.error).toMatchObject({ code: "guard_target_changed" });
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
    const successor = await setup.claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: node.logicalId });
    expect(successor.ok).toBe(true);
    expect(setup.sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("manual-adoption");
    expect(setup.discoveryRepo.getDiscoveredSession(discovered.id)?.status).toBe("claimed");
  });

  it("rejects an unclaim whose target changes while it waits for a lifecycle lease", async () => {
    const { node, claim } = await claimedSeat();
    const entered = barrier();
    const finish = barrier();
    const guard = setup.tmuxAdapter.deliveryGuard!;
    const lifecycle = guard.lifecycle([node.id], async () => {
      entered.resolve();
      await finish.promise;
      setup.sessionRegistry.registerClaimedSession(node.id, "replacement-adoption");
      setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "replacement-adoption", tmuxPane: "%2" });
      guard.rebindLifecycle(node.id);
    });
    await entered.promise;
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockClear();
    const request = setup.app.request(`/api/sessions/${claim.sessionId}/unclaim`, { method: "POST" });
    await new Promise<void>(resolve => setImmediate(resolve));
    finish.resolve();
    await lifecycle;
    const binding = setup.sessionRegistry.getBindingForNode(node.id);
    const response = await request;
    expect(response.status).toBe(409);
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toEqual(binding);
    expect(setup.tmuxAdapter.setSessionOption).not.toHaveBeenCalled();
  });

  it.each(["claim", "launch", "binding"] as const)("preserves a concurrent %s during unguarded metadata cleanup", async replacement => {
    const { rig, node, discovered, claim } = await claimedSeat();
    setup.tmuxAdapter.deliveryGuard = undefined;
    const entered = barrier();
    const finish = barrier();
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      return { ok: true };
    });
    const request = setup.app.request(`/api/sessions/${claim.sessionId}/unclaim`, { method: "POST" });
    await entered.promise;
    if (replacement === "binding") {
      setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "replacement-adoption", tmuxPane: "%2" });
    } else {
      expect((await setup.rigLifecycleService.unclaimSession(claim.sessionId)).ok).toBe(true);
      const successor = replacement === "claim"
        ? await setup.claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: node.logicalId })
        : await setup.nodeLauncher.launchNode(rig.id, node.logicalId);
      expect(successor.ok).toBe(true);
    }
    const binding = setup.sessionRegistry.getBindingForNode(node.id);
    const discovery = setup.discoveryRepo.getDiscoveredSession(discovered.id);
    const sessions = db.prepare("SELECT * FROM sessions WHERE node_id = ? ORDER BY id").all(node.id);
    const events = db.prepare("SELECT * FROM events ORDER BY seq").all();
    finish.resolve();
    const response = await request;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "session_not_current",
      error: `Claimed session '${claim.sessionId}' no longer owns this seat. Database custody was not changed. OpenRig tmux metadata on 'manual-adoption' may already have been cleared.`,
    });
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toEqual(binding);
    expect(setup.discoveryRepo.getDiscoveredSession(discovered.id)).toEqual(discovery);
    expect(db.prepare("SELECT * FROM sessions WHERE node_id = ? ORDER BY id").all(node.id)).toEqual(sessions);
    expect(db.prepare("SELECT * FROM events ORDER BY seq").all()).toEqual(events);
  });

  it.each(["unclaim", "release", "delete"] as const)("allows %s custody cleanup with typing protection enabled", async operation => {
    const { rig, node, discovered, claim } = await claimedSeat();
    await setup.tmuxAdapter.deliveryGuard!.set(node.id, true, "operator", "fixture pause");
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockClear();
    const response = await setup.app.request(operation === "unclaim"
      ? `/api/sessions/${claim.sessionId}/unclaim` : `/api/rigs/${rig.id}/release`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: operation === "delete" }),
    });
    expect(response.status).toBe(200);
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
    expect(setup.discoveryRepo.getDiscoveredSession(discovered.id)?.status).toBe("active");
    expect(setup.tmuxAdapter.killSession).not.toHaveBeenCalled();
    if (operation !== "delete") expect(setup.tmuxAdapter.deliveryGuard!.preference(node.id).desired).toBe(true);
  });

  it("keeps an old-ID retry harmless after a newer claim was released", async () => {
    const { rig, node, discovered, claim } = await claimedSeat();
    const original = await setup.rigLifecycleService.unclaimSession(claim.sessionId);
    const next = await setup.claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: node.logicalId });
    if (!next.ok) throw new Error(next.error);
    await setup.rigLifecycleService.unclaimSession(next.sessionId);
    const events = db.prepare("SELECT * FROM events ORDER BY seq").all();
    const notify = vi.spyOn(setup.eventBus, "notifySubscribers");
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockClear();
    const response = await setup.app.request(`/api/sessions/${claim.sessionId}/unclaim`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(original);
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
    expect(setup.tmuxAdapter.setSessionOption).not.toHaveBeenCalled();
    const second = await setup.app.request(`/api/sessions/${claim.sessionId}/unclaim`, { method: "POST" });
    expect(await second.json()).toEqual(original);
    expect(db.prepare("SELECT * FROM events ORDER BY seq").all()).toHaveLength(events.length + 2);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: "session.detached", nodeId: node.id, sessionName: "manual-adoption" }));
  });

  it.each([false, true])("does not grant input or launch permission through a custody lease (protected=%s)", async protectedSeat => {
    const { rig, node } = await claimedSeat();
    const guard = setup.tmuxAdapter.deliveryGuard!;
    if (protectedSeat) await guard.set(node.id, true, "operator", "fixture pause");
    const write = vi.fn(async () => {});
    await guard.custody([node.id], async () => {
      expect(guard.ownsCustody(node.id)).toBe(true);
      expect(guard.ownsLifecycle(node.id)).toBe(false);
      expect(() => guard.checkInput(node.id)).toThrow("Custody cleanup does not authorize");
      await expect(guard.input(node.id, write)).rejects.toMatchObject({ code: "guard_lease_required" });
      await expect(guard.operation(node.id, write)).rejects.toMatchObject({ code: "guard_lease_required" });
      await expect(guard.lifecycle([node.id], write)).rejects.toMatchObject({ code: "guard_lease_required" });
      await expect(setup.nodeLauncher.launchNode(rig.id, node.logicalId)).rejects.toMatchObject({ code: "guard_lease_required" });
    });
    expect(write).not.toHaveBeenCalled();
    expect(setup.tmuxAdapter.createSession).not.toHaveBeenCalled();
    if (protectedSeat) await expect(guard.operation(node.id, write)).rejects.toMatchObject({ code: "typing_guard_enabled" });
    else await guard.operation(node.id, write);
    expect(write).toHaveBeenCalledTimes(protectedSeat ? 0 : 1);
  });

  it.each(["operation", "humanInput"] as const)("scopes nested custody cleanup inside %s", async origin => {
    const { node, claim } = await claimedSeat();
    const guard = setup.tmuxAdapter.deliveryGuard!;
    const write = vi.fn(async () => {});
    await guard[origin](node.id, async () => {
      await guard.custody([node.id], async () => {
        expect(guard.ownsCustody(node.id)).toBe(true);
        await expect(guard.input(node.id, write)).rejects.toMatchObject({ code: "guard_lease_required" });
        expect((await setup.rigLifecycleService.unclaimSession(claim.sessionId)).ok).toBe(true);
      });
    });
    expect(write).not.toHaveBeenCalled();
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
  });

  it("serializes human-scoped cleanup with an existing automatic operation", async () => {
    const { node, claim } = await claimedSeat();
    const guard = setup.tmuxAdapter.deliveryGuard!;
    const binding = setup.sessionRegistry.getBindingForNode(node.id);
    const entered = barrier(), finish = barrier();
    const busy = guard.operation(node.id, async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    let completed = false;
    const cleanup = guard.humanInput(node.id, () => setup.rigLifecycleService.unclaimSession(claim.sessionId))
      .then(result => { completed = true; return result; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const completedWhileBusy = completed;
    const bindingWhileBusy = setup.sessionRegistry.getBindingForNode(node.id);
    finish.resolve();
    await busy;
    expect((await cleanup).ok).toBe(true);
    expect(completedWhileBusy).toBe(false);
    expect(bindingWhileBusy).toEqual(binding);
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
  });

  it("joins the serial lock when a human scope is nested inside its owner", async () => {
    const { node, claim } = await claimedSeat();
    const guard = setup.tmuxAdapter.deliveryGuard!;
    const result = await guard.operation(node.id, () => guard.humanInput(node.id,
      () => setup.rigLifecycleService.unclaimSession(claim.sessionId)));
    expect(result.ok).toBe(true);
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
  });

  it("does not retain a finished parent's serial ownership in detached human cleanup", async () => {
    const { node, claim } = await claimedSeat();
    const guard = setup.tmuxAdapter.deliveryGuard!;
    const humanEntered = barrier(), resumeHuman = barrier(), busyEntered = barrier(), finishBusy = barrier();
    let cleanup!: Promise<unknown>;
    let completed = false;
    await guard.operation(node.id, async () => {
      cleanup = guard.humanInput(node.id, async () => {
        humanEntered.resolve(); await resumeHuman.promise;
        return setup.rigLifecycleService.unclaimSession(claim.sessionId);
      }).then(result => { completed = true; return result; });
      await humanEntered.promise;
    });
    const busy = guard.operation(node.id, async () => { busyEntered.resolve(); await finishBusy.promise; });
    await busyEntered.promise;
    const binding = setup.sessionRegistry.getBindingForNode(node.id);
    resumeHuman.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    const completedWhileBusy = completed;
    const bindingWhileBusy = setup.sessionRegistry.getBindingForNode(node.id);
    finishBusy.resolve();
    await busy;
    expect(await cleanup).toMatchObject({ ok: true });
    expect(completedWhileBusy).toBe(false);
    expect(bindingWhileBusy).toEqual(binding);
  });

  it.each([[false, false], [false, true], [true, false], [true, true]])("does not wait on an unaffected seat unless deleting (delete=%s, previouslyClaimed=%s)", async (deleting, previouslyClaimed) => {
    const { rig } = await claimedSeat();
    const unaffected = setup.rigRepo.addNode(rig.id, "external.empty", { runtime: "terminal" });
    let detachedSessionId: string | undefined;
    if (previouslyClaimed) {
      const discovered = setup.discoveryRepo.upsertDiscoveredSession({
        tmuxSession: "manual-empty", tmuxPane: "%2", cwd: "/tmp", activeCommand: "bash", runtimeHint: "terminal", confidence: "high",
      });
      const claim = await setup.claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: unaffected.logicalId });
      if (!claim.ok) throw new Error(claim.error);
      detachedSessionId = claim.sessionId;
      await setup.rigLifecycleService.unclaimSession(claim.sessionId);
    }
    const entered = barrier(), finish = barrier();
    const busy = setup.tmuxAdapter.deliveryGuard!.lifecycle([unaffected.id], async () => {
      entered.resolve(); await finish.promise;
    });
    await entered.promise;
    const notify = vi.spyOn(setup.eventBus, "notifySubscribers");
    let completed = false;
    const request = setup.app.request(`/api/rigs/${rig.id}/release`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: deleting }),
    }).then(response => { completed = true; return response; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const completedWhileBusy = completed;
    finish.resolve();
    await busy;
    const response = await request;
    expect(response.status).toBe(200);
    expect(completedWhileBusy).toBe(!deleting);
    if (previouslyClaimed) {
      expect(await response.json()).toMatchObject({ released: expect.arrayContaining([
        expect.objectContaining({ nodeId: unaffected.id, sessionId: detachedSessionId, sessionName: "manual-empty" }),
      ]) });
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: "session.detached", nodeId: unaffected.id, sessionName: "manual-empty" }));
    }
  });

  it.each([[false, "guard", false], [true, "guard", false], [false, "session", false], [true, "session", false], [false, "guard", true], [true, "guard", true]] as const)("captures every release target before waiting (delete=%s, check=%s, detached=%s)", async (deleting, check, detached) => {
    const first = await claimedSeat();
    const node = setup.rigRepo.addNode(first.rig.id, "external.second", { runtime: "terminal" });
    const discovered = setup.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: "manual-second", tmuxPane: "%2", cwd: "/tmp", activeCommand: "bash", runtimeHint: "terminal", confidence: "high",
    });
    const claim = await setup.claimService.bind({ discoveredId: discovered.id, rigId: first.rig.id, logicalId: node.logicalId });
    if (!claim.ok) throw new Error(claim.error);
    const guard = setup.tmuxAdapter.deliveryGuard!;
    if (check === "session") {
      // Isolate the service's session-ID check from the guard's occupant check.
      const target = guard.target.bind(guard);
      vi.spyOn(guard, "target").mockImplementation(name => ({ ...target(name), occupant: null }));
    }
    const [blocked, changed] = [first, { rig: first.rig, node, discovered, claim }].sort((a, b) => a.node.id.localeCompare(b.node.id));
    if (detached) expect((await setup.rigLifecycleService.unclaimSession(changed!.claim.sessionId)).ok).toBe(true);
    const entered = barrier(), finish = barrier();
    const busy = setup.tmuxAdapter.deliveryGuard!.lifecycle([blocked!.node.id], async () => {
      entered.resolve(); await finish.promise;
    });
    await entered.promise;
    const request = setup.app.request(`/api/rigs/${first.rig.id}/release`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: deleting }),
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((await setup.rigLifecycleService.unclaimSession(changed!.claim.sessionId)).ok).toBe(true);
    expect((await setup.claimService.bind({ discoveredId: changed!.discovered.id, rigId: first.rig.id, logicalId: changed!.node.logicalId })).ok).toBe(true);
    const bindings = db.prepare("SELECT * FROM bindings ORDER BY id").all();
    const discovery = setup.discoveryRepo.getDiscoveredSession(changed!.discovered.id);
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockClear();
    finish.resolve();
    await busy;
    const response = await request;
    expect(response.status).toBe(deleting ? 409 : 207);
    if (deleting) {
      expect(db.prepare("SELECT * FROM bindings ORDER BY id").all()).toEqual(bindings);
      expect(setup.tmuxAdapter.setSessionOption).not.toHaveBeenCalled();
    } else {
      expect(await response.json()).toMatchObject({ status: "partial", deleted: false,
        released: [expect.objectContaining({ nodeId: blocked!.node.id, sessionId: blocked!.claim.sessionId })],
        failed: [expect.objectContaining({ nodeId: changed!.node.id, sessionId: changed!.claim.sessionId })],
      });
      expect(setup.sessionRegistry.getBindingForNode(blocked!.node.id)).toBeNull();
      expect(setup.sessionRegistry.getBindingForNode(changed!.node.id)?.tmuxSession).toBe(changed!.discovered.tmuxSession);
      expect(vi.mocked(setup.tmuxAdapter.setSessionOption).mock.calls.every(([name]) => name === blocked!.discovered.tmuxSession)).toBe(true);
    }
    expect(setup.discoveryRepo.getDiscoveredSession(changed!.discovered.id)).toEqual(discovery);
    expect(setup.rigRepo.getRig(first.rig.id)).not.toBeNull();
  });

  it("keeps a repeat of an already released current ID harmless", async () => {
    const { node, claim } = await claimedSeat();
    expect((await setup.rigLifecycleService.unclaimSession(claim.sessionId)).ok).toBe(true);
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockClear();
    const response = await setup.app.request(`/api/sessions/${claim.sessionId}/unclaim`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
    expect(setup.tmuxAdapter.setSessionOption).not.toHaveBeenCalled();
  });

  it("reports a later custody refusal after preserving an earlier release effect", async () => {
    const { rig, node } = await claimedSeat();
    const later = setup.rigRepo.addNode(rig.id, "external.second", { runtime: "terminal" });
    const discovered = setup.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: "manual-second", tmuxPane: "%2", cwd: "/tmp", activeCommand: "bash", runtimeHint: "terminal", confidence: "high",
    });
    const claim = await setup.claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: later.logicalId });
    if (!claim.ok) throw new Error(claim.error);
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockImplementation(async (name, key) => {
      if (name === "manual-adoption" && key === "@rigged_logical_id") {
        // A transport identity change after the full captured-set check.
        setup.sessionRegistry.updateBinding(later.id, { tmuxPane: "%99" });
      }
      return { ok: true };
    });
    const response = await setup.app.request(`/api/rigs/${rig.id}/release`, { method: "POST" });
    expect(response.status).toBe(207);
    expect(await response.json()).toMatchObject({ status: "partial", deleted: false,
      released: [expect.objectContaining({ nodeId: node.id })],
      failed: [expect.objectContaining({ nodeId: later.id, sessionId: claim.sessionId })],
    });
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
    expect(setup.sessionRegistry.getBindingForNode(later.id)?.tmuxPane).toBe("%99");
    expect(setup.discoveryRepo.getDiscoveredSession(discovered.id)?.status).toBe("claimed");
  });

  it("does not delete a seat added and claimed during cleanup", async () => {
    const { rig, node } = await claimedSeat();
    const entered = barrier(), finish = barrier();
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockImplementationOnce(async () => {
      entered.resolve(); await finish.promise; return { ok: true };
    });
    const request = setup.app.request(`/api/rigs/${rig.id}/release`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: true }),
    });
    await entered.promise;
    const added = setup.rigRepo.addNode(rig.id, "external.new", { runtime: "terminal" });
    const discovered = setup.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: "manual-new", tmuxPane: "%2", cwd: "/tmp", activeCommand: "bash", runtimeHint: "terminal", confidence: "high",
    });
    expect((await setup.claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: added.logicalId })).ok).toBe(true);
    const binding = setup.sessionRegistry.getBindingForNode(added.id);
    const discovery = setup.discoveryRepo.getDiscoveredSession(discovered.id);
    finish.resolve();
    const response = await request;
    expect(response.status).toBe(207);
    expect(await response.json()).toMatchObject({ status: "partial", deleted: false,
      released: [expect.objectContaining({ nodeId: node.id })],
      failed: [expect.objectContaining({ nodeId: added.id, sessionId: null })],
    });
    expect(setup.rigRepo.getRig(rig.id)).not.toBeNull();
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
    expect(setup.sessionRegistry.getBindingForNode(added.id)).toEqual(binding);
    expect(setup.discoveryRepo.getDiscoveredSession(discovered.id)).toEqual(discovery);
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE node_id = ? AND type = 'session.detached'").get(added.id)).toEqual({ n: 0 });
  });

  it("holds earlier seats through a whole-rig release and deletion", async () => {
    const { rig, node } = await claimedSeat();
    const secondNode = setup.rigRepo.addNode(rig.id, "external.second", { runtime: "terminal" });
    const discovered = setup.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: "manual-second", tmuxPane: "%2", cwd: "/tmp",
      activeCommand: "bash", runtimeHint: "terminal", confidence: "high",
    });
    expect((await setup.claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: secondNode.logicalId })).ok).toBe(true);
    const entered = barrier();
    const finish = barrier();
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockImplementation(async (sessionName, key, value) => {
      if (sessionName === "manual-second" && key === "@rigged_node_id" && value === "") {
        entered.resolve();
        await finish.promise;
      }
      return { ok: true };
    });
    const release = setup.app.request(`/api/rigs/${rig.id}/release`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: true }),
    });
    await entered.promise;
    let launchEntered = false;
    const launch = setup.tmuxAdapter.deliveryGuard!.lifecycle([node.id], async () => {
      launchEntered = true;
      return setup.nodeLauncher.launchNode(rig.id, node.logicalId);
    }).then(result => ({ result, error: null }), error => ({ result: null, error }));
    await new Promise<void>(resolve => setImmediate(resolve));
    const launchedDuringRelease = launchEntered;
    finish.resolve();
    const response = await release;
    const outcome = await launch;
    expect(launchedDuringRelease).toBe(false);
    expect(launchEntered).toBe(false);
    expect(outcome.error).toMatchObject({ code: "guard_target_unknown" });
    expect(response.status).toBe(200);
    expect(setup.rigRepo.getRig(rig.id)).toBeNull();
    expect(setup.tmuxAdapter.createSession).not.toHaveBeenCalled();
  });

  it("still releases the current claim without killing its tmux session", async () => {
    const { node, discovered, claim } = await claimedSeat();
    const res = await setup.app.request(`/api/sessions/${claim.sessionId}/unclaim`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
    expect(setup.discoveryRepo.getDiscoveredSession(discovered.id)?.status).toBe("active");
    expect(setup.tmuxAdapter.killSession).not.toHaveBeenCalled();
  });
});
