// Real repositories/services/routes; tmux and runtime effects are inert recorders.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptRoutes } from "../src/routes/transcripts.js";
import { discoverResumeToken } from "../src/domain/agent-images/resume-token-discovery.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry, physicalSessionName } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SelfAttachService } from "../src/domain/self-attach-service.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { WhoamiService } from "../src/domain/whoami-service.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { rigsRoutes } from "../src/routes/rigs.js";
import { transportRoutes } from "../src/routes/transport.js";

describe("attached team address preserves physical custody", () => {
  let db: ReturnType<typeof createDb>, rigs: RigRepository, pods: PodRepository, sessions: SessionRegistry, bus: EventBus;
  let attach: SelfAttachService, transport: SessionTransport, tmux: TmuxAdapter, app: Hono;
  let transcriptRoot: string;
  let writes: Array<{ target: string; text: string }>;
  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    rigs = new RigRepository(db); pods = new PodRepository(db); sessions = new SessionRegistry(db); bus = new EventBus(db);
    transcriptRoot = mkdtempSync(join(tmpdir(), "attach-history-"));
    writes = [];
    tmux = { hasSession: async () => true, probeSession: async () => ({ state: "present" }),
      capturePaneContent: async () => "plain terminal", getPaneCommand: async () => "sh",
      sendText: async (target: string, text: string) => { writes.push({ target, text }); return { ok: true }; },
      sendKeys: async () => ({ ok: true }), createSession: vi.fn(async () => ({ ok: false, code: "session_exists", message: "inert" })),
    } as unknown as TmuxAdapter;
    attach = new SelfAttachService({ db, rigRepo: rigs, podRepo: pods, sessionRegistry: sessions, eventBus: bus, tmuxAdapter: tmux });
    transport = new SessionTransport({ db, rigRepo: rigs, sessionRegistry: sessions, tmuxAdapter: tmux, sleep: async () => {} });
    app = new Hono(); app.use("*", async (c, next) => { c.set("selfAttachService" as never, attach); c.set("sessionTransport" as never, transport); await next(); });
    app.route("/api/rigs", rigsRoutes); app.route("/api/transport", transportRoutes());
  });
  afterEach(() => { db.close(); rmSync(transcriptRoot, { recursive: true, force: true }); });
  const context = (tmuxSession: string) => ({ attachmentType: "tmux" as const, tmuxSession, tmuxWindow: "@12", tmuxPane: "%42" });

  it.each(["0", "person-terminal"])("returns a routable sender and records the display label without renaming %s", async (physical) => {
    const rig = rigs.createRig("sample-team"), node = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    const result = await attach.attachToNode({ rigId: rig.id, logicalId: node.logicalId, displayName: "Taylor", context: context(physical) });
    expect(result).toMatchObject({ ok: true, sessionName: physical, senderAddress: "person-agent@sample-team", env: { OPENRIG_SESSION_NAME: "person-agent@sample-team" } });
    expect(rigs.getRig(rig.id)?.nodes[0]?.label).toBe("Taylor");
    expect(sessions.getBindingForNode(node.id)).toMatchObject({ tmuxSession: physical, tmuxPane: "%42" });
    expect(sessions.getSessionsForRig(rig.id)[0]?.sessionName).toBe(physical);
    if (!result.ok) throw new Error("attach failed");
    const response = await app.request("/api/transport/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: result.env.OPENRIG_SESSION_NAME, text: "harmless reply" }) });
    expect(response.status).toBe(200); expect((await response.json()).ok).toBe(true);
    expect(writes).toEqual([{ target: physical, text: "harmless reply" }]);
    const raw = await transport.send(physical, "raw reply"); expect(raw.ok).toBe(true);
    expect(writes.at(-1)).toEqual({ target: physical, text: "raw reply" });
  });

  it("refuses an ambiguous flattened member before binding or provisioning", async () => {
    const rig = rigs.createRig("team"), first = rigs.addNode(rig.id, "p.a-b", { runtime: "terminal" });
    expect((await attach.attachToNode({ rigId: rig.id, logicalId: first.logicalId, context: context("first") })).ok).toBe(true);
    const second = rigs.addNode(rig.id, "p-a.b", { runtime: "terminal" });
    const before = db.prepare("SELECT * FROM sessions ORDER BY id").all();
    const result = await attach.attachToNode({ rigId: rig.id, logicalId: second.logicalId, context: context("second") });
    expect(result).toMatchObject({ ok: false, code: "address_conflict" });
    if (!result.ok) expect(result.error).toMatch(/another member name/i);
    expect(sessions.getBindingForNode(second.id)).toBeNull();
    expect(db.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(before);
  });

  it("refuses a new physical name that would steal another member's advertised address", async () => {
    const rig = rigs.createRig("team"), first = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    await attach.attachToNode({ rigId: rig.id, logicalId: first.logicalId, context: context("0") });
    const second = rigs.addNode(rig.id, "other.agent", { runtime: "terminal" });
    expect(await attach.attachToNode({ rigId: rig.id, logicalId: second.logicalId, context: context("person-agent@team") })).toMatchObject({ ok: false, code: "address_conflict" });
    expect(sessions.getBindingForNode(first.id)?.tmuxSession).toBe("0"); expect(sessions.getBindingForNode(second.id)).toBeNull();
  });

  it("refuses a new join sharing another current member's raw physical name", async () => {
    const rig = rigs.createRig("team"), first = rigs.addNode(rig.id, "first.agent", { runtime: "terminal" });
    expect((await attach.attachToNode({ rigId: rig.id, logicalId: first.logicalId, context: context("0") })).ok).toBe(true);
    const other = rigs.addNode(rig.id, "other.agent", { runtime: "terminal" });
    const before = db.prepare("SELECT * FROM sessions ORDER BY id").all();
    expect(await attach.attachToNode({ rigId: rig.id, logicalId: other.logicalId, context: context("0") }))
      .toMatchObject({ ok: false, code: "address_conflict" });
    expect(sessions.getBindingForNode(other.id)).toBeNull();
    expect(db.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(before);
    expect(writes).toHaveLength(0); expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it("later launch refuses the same address before creating any tmux session", async () => {
    const rig = rigs.createRig("team"), first = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    await attach.attachToNode({ rigId: rig.id, logicalId: first.logicalId, context: context("0") });
    const second = rigs.addNode(rig.id, "other.agent", { runtime: "terminal" });
    const launcher = new NodeLauncher({ db, rigRepo: rigs, sessionRegistry: sessions, eventBus: bus, tmuxAdapter: tmux });
    expect(await launcher.launchNode(rig.id, second.logicalId, { sessionName: "person-agent@team" })).toMatchObject({ ok: false, code: "address_conflict" });
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it("logical and raw queue owners see and claim the same current rows without rewriting them", async () => {
    const rig = rigs.createRig("team"), node = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    await attach.attachToNode({ rigId: rig.id, logicalId: node.logicalId, context: context("0") });
    const queue = new QueueRepository(db, bus, { resolveSessionAddresses: (name: string) => sessions.sessionAddresses(name) });
    const item = await queue.create({ sourceSession: "operator@team", destinationSession: "0", body: "work", nudge: false });
    expect(queue.list({ destinationSession: "person-agent@team" }).map((q) => q.qitemId)).toContain(item.qitemId);
    expect(queue.claim({ qitemId: item.qitemId, destinationSession: "person-agent@team" }).destinationSession).toBe("0");
    expect(queue.whoami("person-agent@team").asDestination.inProgress).toBe(1);
  });

  it("pod and multi-dot addresses use the same rule, label and physical transcript path", async () => {
    const rig = rigs.createRig("team"); pods.createPod(rig.id, "people", "People");
    const result = await attach.attachToPod({ rigId: rig.id, podNamespace: "people", memberName: "person.agent", runtime: "terminal", displayName: "Taylor", context: context("0") });
    expect(result).toMatchObject({ ok: true, senderAddress: "people-person-agent@team" });
    if (!result.ok) throw new Error("attach failed");
    const store = new TranscriptStore({ transcriptsRoot: "/tmp/inert-attach-proof", enabled: true });
    const who = new WhoamiService({ db, rigRepo: rigs, sessionRegistry: sessions, transcriptStore: store }).resolve({ sessionName: result.senderAddress, compact: true });
    expect(who?.identity).toMatchObject({ sessionName: "0", senderAddress: result.senderAddress, memberLabel: "Taylor" });
    expect(who?.transcript.path).toBe(store.getTranscriptPath("team", "0"));
    const resolved = await transport.resolveSessions({ sessions: [result.senderAddress, "0"] });
    expect(resolved.ok && resolved.sessions).toHaveLength(1);
    expect((await transport.capture(result.senderAddress)).ok).toBe(true);
  });

  it("a second attach to the same member retains the existing already-bound result, not a clash", async () => {
    const rig = rigs.createRig("team"), node = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    await attach.attachToNode({ rigId: rig.id, logicalId: node.logicalId, context: context("0") });
    expect(await attach.attachToNode({ rigId: rig.id, logicalId: node.logicalId, context: context("0") })).toMatchObject({ ok: false, code: "already_bound" });
    expect(() => sessions.assertAddressAvailable(node.id, "0")).not.toThrow();
    expect(sessions.getSessionsForRig(rig.id)).toHaveLength(1);
  });

  it("archived namesakes do not own a new live member's address", async () => {
    const old = rigs.createRig("team"), former = rigs.addNode(old.id, "person.agent", { runtime: "terminal" });
    await attach.attachToNode({ rigId: old.id, logicalId: former.logicalId, context: context("old") });
    db.prepare("UPDATE rigs SET archived_at='2026-10-01T00:00:00Z' WHERE id=?").run(old.id);
    const rig = rigs.createRig("team"), current = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    expect(await attach.attachToNode({ rigId: rig.id, logicalId: current.logicalId, context: context("0") })).toMatchObject({ ok: true, senderAddress: "person-agent@team" });
    expect(resolveGuardTarget(db, "person-agent@team")?.nodeId).toBe(current.id);
    expect((await transport.send("person-agent@team", "current reply")).ok).toBe(true);
    expect(writes.at(-1)?.target).toBe("0");
  });

  it.each(["unbound", "archived", "older session"])("reserves an exact historical address before any join effect (%s)", async state => {
    const rig = rigs.createRig("team"), former = rigs.addNode(rig.id, "former.agent", { runtime: "terminal" });
    await attach.attachToNode({ rigId: rig.id, logicalId: former.logicalId, context: context("person-agent@team") });
    const oldSession = sessions.getSessionsForRig(rig.id)[0]!;
    sessions.clearBinding(former.id); sessions.markSuperseded(oldSession.id);
    if (state === "older session") {
      sessions.registerClaimedSession(former.id, "different-physical");
      sessions.updateBinding(former.id, { tmuxSession: "different-physical", tmuxPane: "%77" });
    }
    let currentRig = rig;
    if (state === "archived") {
      db.prepare("UPDATE rigs SET archived_at='2026-10-01T00:00:00Z' WHERE id=?").run(rig.id);
      currentRig = rigs.createRig("team");
    }
    const current = rigs.addNode(currentRig.id, "person.agent", { runtime: "terminal", label: "before" });
    const stored = () => Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{name:string}>)
      .map(({name}) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
    const before = stored();
    const result = await attach.attachToNode({ rigId: currentRig.id, logicalId: current.logicalId, displayName: "must not apply", context: context("0") });
    expect(result).toMatchObject({ ok: false, code: "address_conflict", error: expect.stringContaining("Choose another member name") });
    expect(stored()).toEqual(before);
    expect(writes).toHaveLength(0);expect(tmux.createSession).not.toHaveBeenCalled();
    expect(physicalSessionName(db, "person-agent@team")).toBe("person-agent@team");
  });

  it.each([
    ["archived", "person-agent@team"], ["archived", "0"],
    ["detached", "0"], ["exited", "0"], ["superseded", "0"],
  ])("the same seat's successor owns guarded replies after %s on %s", async (state, physical) => {
    const address = "person-agent@team";
    const oldRig = rigs.createRig("team"), oldNode = rigs.addNode(oldRig.id, "person.agent", { runtime: "terminal" });
    expect((await attach.attachToNode({ rigId: oldRig.id, logicalId: oldNode.logicalId, context: { ...context(address), tmuxPane: "%41" } })).ok).toBe(true);
    const oldSession = sessions.getSessionsForRig(oldRig.id)[0]!;
    if (state === "archived") { sessions.updateStatus(oldSession.id, "exited"); rigs.archiveRig(oldRig.id); }
    else db.prepare("UPDATE sessions SET status=? WHERE id=?").run(state, oldSession.id);
    const rig = rigs.createRig("team"), node = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    expect(await attach.attachToNode({ rigId: rig.id, logicalId: node.logicalId, context: context(physical) }))
      .toMatchObject({ ok: true, sessionName: physical, senderAddress: address });
    expect(physicalSessionName(db, address)).toBe(physical);
    const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
    Object.defineProperty(tmux, "deliveryGuard", { value: guard });
    const guarded = new SessionTransport({ db, rigRepo: rigs, sessionRegistry: sessions, tmuxAdapter: tmux, sleep: async () => {} });
    const target = { nodeId: node.id, session: physical, pane: "%42", occupant: sessions.currentOccupantTenure(node.id)!.generationUuid };
    expect(guard.target(address)).toEqual(target);
    expect(guard.target(oldNode.id)).toEqual({ nodeId: oldNode.id, session: address, pane: "%41", occupant: sessions.currentOccupantTenure(oldNode.id)!.generationUuid });
    if (physical === "0") expect(sessions.findResumeContextByName(address)?.sessionId).toBe(oldSession.id);
    await guard.set(oldNode.id, true, "operator@team", "old preference");
    await guard.set(node.id, false, "operator@team", "successor is off");
    expect((await guarded.send(address, "replacement reply")).ok).toBe(true);
    expect(writes).toEqual([{ target: physical, text: "replacement reply" }]);
    await guard.set(oldNode.id, false, "operator@team", "old is off");
    await guard.set(node.id, true, "operator@team", "successor holds");
    expect(await guarded.send(address, "held reply", { deliveryId: "successor-held", actorSession: "operator@team" }))
      .toMatchObject({ ok: true, sent: false, outcome: "retained" });
    expect(new OutboxHandler(db).getById("successor-held")?.guardBinding).toEqual(target);
    expect(writes).toHaveLength(1);
    expect(sessions.getSessionsForRig(oldRig.id)[0]?.sessionName).toBe(address);
  });

  it.each(["0", "person-terminal"].flatMap(physical => [
    { physical, competitorHeld: true }, { physical, competitorHeld: false },
  ]))("keeps an unrelated exact binding ambiguous for $physical (competitor held=$competitorHeld)", async ({ physical, competitorHeld }) => {
    const address = "person-agent@team", rig = rigs.createRig("team");
    const node = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    expect((await attach.attachToNode({ rigId: rig.id, logicalId: node.logicalId, context: context(physical) })).ok).toBe(true);
    const other = rigs.addNode(rig.id, "other.agent", { runtime: "terminal" });
    // A later competing binding has no matching session; routing still selects
    // the attached person, but the guard must not prefer the unrelated owner.
    sessions.updateBinding(other.id, { tmuxSession: address, tmuxPane: "%77" });
    expect(sessions.resolveAddress(address)?.nodeId).toBe(node.id);
    expect(physicalSessionName(db, address)).toBe(physical);
    const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
    Object.defineProperty(tmux, "deliveryGuard", { value: guard });
    const guarded = new SessionTransport({ db, rigRepo: rigs, sessionRegistry: sessions, tmuxAdapter: tmux, sleep: async () => {} });
    await guard.set(node.id, !competitorHeld, "operator@team", "person preference");
    await guard.set(other.id, competitorHeld, "operator@team", "opposing preference");
    expect(await guarded.send(address, "must not send or retain", { deliveryId: "ambiguous-reply", actorSession: "operator@team" }))
      .toMatchObject({ ok: false, sent: false, reason: "guard_target_unknown" });
    expect(resolveGuardTarget(db, address)).toBeNull();
    expect(writes).toEqual([]);
    expect(new OutboxHandler(db).getById("ambiguous-reply")).toBeNull();
    expect(guard.target(node.id).nodeId).toBe(node.id);
    expect(guard.target("%77").nodeId).toBe(other.id);
  });

  it.each(["running", "pending", "unknown"])("does not treat a %s same-seat predecessor as stopped", async status => {
    const oldRig = rigs.createRig("team"), oldNode = rigs.addNode(oldRig.id, "person.agent", { runtime: "terminal" });
    await attach.attachToNode({ rigId: oldRig.id, logicalId: oldNode.logicalId, context: context("person-agent@team") });
    db.prepare("UPDATE sessions SET status=? WHERE node_id=?").run(status, oldNode.id);
    const rig = rigs.createRig("team"), node = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    expect(await attach.attachToNode({ rigId: rig.id, logicalId: node.logicalId, context: context("0") }))
      .toMatchObject({ ok: false, code: "address_conflict" });
    expect(sessions.getBindingForNode(node.id)).toBeNull(); expect(writes).toHaveLength(0);
  });

  it("retained legacy collisions keep exact history and do not select a different occupant", async () => {
    const rig = rigs.createRig("team"), former = rigs.addNode(rig.id, "former.agent", { runtime: "terminal" });
    await attach.attachToNode({ rigId: rig.id, logicalId: former.logicalId, context: context("person-agent@team") });
    sessions.clearBinding(former.id);sessions.markSuperseded(sessions.getSessionsForRig(rig.id)[0]!.id);
    const current = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    // Pre-existing data is not a new join permitted by the admission check.
    db.prepare("INSERT INTO sessions(id,node_id,session_name,status,origin) VALUES ('legacy-current',?,'0','running','claimed')").run(current.id);
    sessions.updateBinding(current.id, { tmuxSession: "0", tmuxPane: "%99" });
    expect(physicalSessionName(db, "person-agent@team")).toBe("person-agent@team");
    expect(resolveGuardTarget(db, "person-agent@team")).toBeNull();
    expect(resolveGuardTarget(db, "0")?.nodeId).toBe(current.id);
    const whoami = new WhoamiService({ db, rigRepo: rigs, sessionRegistry: sessions, transcriptStore: new TranscriptStore({ enabled: false }) });
    expect(whoami.resolve({ sessionName: "person-agent@team" })?.identity.nodeId).toBe(former.id);
    expect(whoami.resolve({ nodeId: current.id })?.identity.senderAddress).toBe("0");
  });

  it("the historical owner can reconnect under its own logical address", async () => {
    const rig = rigs.createRig("team"), node = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    const original = await attach.attachToNode({ rigId: rig.id, logicalId: node.logicalId, context: context("person-agent@team") });
    expect(original.ok).toBe(true);
    sessions.clearBinding(node.id);sessions.markSuperseded(sessions.getSessionsForRig(rig.id)[0]!.id);
    expect(await attach.attachToNode({ rigId: rig.id, logicalId: node.logicalId, context: context("0") }))
      .toMatchObject({ ok: true, senderAddress: "person-agent@team", sessionName: "0" });
  });

  async function reconnect() {
    const rig = rigs.createRig("team"), node = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    expect((await attach.attachToNode({ rigId: rig.id, logicalId: node.logicalId, context: context("person-agent@team") })).ok).toBe(true);
    const old = sessions.getSessionsForRig(rig.id)[0]!;
    sessions.clearBinding(node.id); sessions.updateStatus(old.id, "exited");
    expect(await attach.attachToNode({ rigId: rig.id, logicalId: node.logicalId, context: context("0") }))
      .toMatchObject({ ok: true, senderAddress: "person-agent@team", sessionName: "0" });
    const current = sessions.getSessionsForRig(rig.id).find(s => s.sessionName === "0")!;
    expect((await transport.send("person-agent@team", "current reply")).ok).toBe(true);
    expect(writes).toEqual([{ target: "0", text: "current reply" }]);
    return { node, old, current };
  }

  it.each(["tail", "grep?pattern=output", "full"])("keeps exact saved transcript reads after same-node reconnect (%s)", async route => {
    await reconnect();
    const store = new TranscriptStore({ transcriptsRoot: transcriptRoot, enabled: true });
    store.ensureTranscriptDir("team");
    writeFileSync(store.getTranscriptPath("team", "person-agent@team"), "old output\n");
    writeFileSync(store.getTranscriptPath("team", "0"), "new output\n");
    const history = new Hono();
    history.use("*", async (c, next) => {
      c.set("db" as never, db); c.set("rigRepo" as never, rigs); c.set("transcriptStore" as never, store); await next();
    });
    history.route("/api/transcripts", transcriptRoutes());
    for (const [name, expected, absent] of [["person-agent@team", "old output", "new output"], ["0", "new output", "old output"]]) {
      const response = await history.request(`/api/transcripts/${name}/${route}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.session).toBe(name);
      expect(JSON.stringify(body)).toContain(expected); expect(JSON.stringify(body)).not.toContain(absent);
    }
  });

  it.each(["claude-code", "codex"])("keeps exact saved native context after same-node reconnect (%s)", async runtime => {
    const { node, old, current } = await reconnect();
    db.prepare("UPDATE nodes SET runtime=? WHERE id=?").run(runtime, node.id);
    db.prepare("UPDATE sessions SET resume_token=? WHERE id=?").run("old-native-id", old.id);
    db.prepare("UPDATE sessions SET resume_token=? WHERE id=?").run("new-native-id", current.id);
    expect(discoverResumeToken(db, "person-agent@team")).toMatchObject({ ok: true, result: { runtime, nativeId: "old-native-id" } });
    expect(discoverResumeToken(db, "0")).toMatchObject({ ok: true, result: { runtime, nativeId: "new-native-id" } });
    expect(sessions.findResumeContextByName("person-agent@team")?.sessionId).toBe(old.id);
    expect(sessions.findResumeContextByName("0")?.sessionId).toBe(current.id);
  });

  it("a reused physical name does not newly transfer old raw queue ownership through the alias", async () => {
    const rig = rigs.createRig("team"), former = rigs.addNode(rig.id, "former.agent", { runtime: "terminal" });
    await attach.attachToNode({ rigId: rig.id, logicalId: former.logicalId, context: context("0") });
    const queue = new QueueRepository(db, bus, { resolveSessionAddresses: name => sessions.sessionAddresses(name) });
    const old = await queue.create({ sourceSession: "operator@team", destinationSession: "0", body: "former raw record", nudge: false });
    sessions.clearBinding(former.id); sessions.markSuperseded(sessions.getSessionsForRig(rig.id)[0]!.id);
    const current = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    await attach.attachToNode({ rigId: rig.id, logicalId: current.logicalId, context: context("0") });
    expect(queue.list({ destinationSession: "person-agent@team" })).toHaveLength(0);
    expect(() => queue.claim({ qitemId: old.qitemId, destinationSession: "person-agent@team" })).toThrow(/destination/);
    expect(queue.getById(old.qitemId)?.destinationSession).toBe("0");
    expect(queue.list({ destinationSession: "0" })).toHaveLength(1); // raw compatibility is unchanged
  });

  it("both spellings take the same lease, and a waiting old occupant cannot acquire its replacement", async () => {
    const rig = rigs.createRig("team"), node = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    await attach.attachToNode({ rigId: rig.id, logicalId: node.logicalId, context: context("0") });
    const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
    expect(guard.target("person-agent@team")).toEqual(guard.target("0"));
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = guard.operation("0", async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    await started;
    const effect = vi.fn(); const next = guard.operation("person-agent@team", async () => effect());
    const rejection = expect(next).rejects.toMatchObject({ code: "guard_target_changed" });
    sessions.updateBinding(node.id, { tmuxPane: "%99" }); release(); await held; await rejection;
    expect(effect).not.toHaveBeenCalled();
  });

  it("retained IDs preserve the requested spelling and frozen pane across an alias and occupant change", async () => {
    const rig = rigs.createRig("team"), node = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    await attach.attachToNode({ rigId: rig.id, logicalId: node.logicalId, context: context("0") });
    const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
    Object.defineProperty(tmux, "deliveryGuard", { value: guard });
    const guarded = new SessionTransport({ db, rigRepo: rigs, sessionRegistry: sessions, tmuxAdapter: tmux });
    await guard.set(node.id, true, "operator@team", "fixture hold");
    const first = await guarded.send("person-agent@team", "kept text", { deliveryId: "stable-id", actorSession: "operator@team" });
    expect(first).toMatchObject({ ok: true, sent: false, outcome: "retained" });
    const outbox = new OutboxHandler(db), before = outbox.getById("stable-id")!;
    expect(before.destinationSession).toBe("person-agent@team"); expect(before.guardBinding?.session).toBe("0"); expect(before.guardBinding?.pane).toBe("%42");
    expect(await guarded.send("0", "kept text", { deliveryId: "stable-id", actorSession: "operator@team" })).toMatchObject({ ok: false, reason: "delivery_identity_conflict" });
    sessions.updateBinding(node.id, { tmuxPane: "%99" });
    await guarded.send("person-agent@team", "kept text", { deliveryId: "stable-id", actorSession: "operator@team" });
    expect(outbox.getById("stable-id")).toEqual(before); expect(writes).toHaveLength(0);
  });

  it("hook resolution uses the current physical identity and retains old-session mismatch checks", async () => {
    const rig = rigs.createRig("team"), node = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    await attach.attachToNode({ rigId: rig.id, logicalId: node.logicalId, context: context("0") });
    const activity = new AgentActivityStore({ db, eventBus: bus });
    expect(activity.resolveSession({ sessionName: "person-agent@team" })).toMatchObject({ nodeId: node.id, sessionName: "0" });
    expect(sessions.currentOccupantGenerationForSession("person-agent@team")).toBe(sessions.currentOccupantGenerationForSession("0"));
    expect(sessions.findResumeContextByName("person-agent@team")?.nodeId).toBe(node.id);
  });

});
