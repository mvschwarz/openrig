import Database from "better-sqlite3";
import { Hono } from "hono";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import type { ComposerSnapshot } from "../src/domain/composer-prompts.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport, type SendOpts } from "../src/domain/session-transport.js";
import { seatRoutes } from "../src/routes/seat.js";
import { transportRoutes } from "../src/routes/transport.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function frame(body: string): ComposerSnapshot {
  const rows = body.split("\n");
  return { screen: ["Ready", "────────────────────", `❯ ${rows[0]}`, ...rows.slice(1).map(row => `  ${row}`), "────────────────────", "? for shortcuts", ""].join("\n"),
    cursor: { x: 2 + stringWidth(rows.at(-1)!), y: 1 + rows.length, width: 240, height: 60 }, inMode: false };
}

function signal() {
  let release!: () => void;
  return { ready: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

function fixture(saved?: Buffer) {
  const db = new Database(saved ?? ":memory:");
  if (!saved) {
    migrate(db, ALL_MIGRATIONS);
    db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
      INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','terminal'),('b','rig','sibling','terminal');
      INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','%1'),('bb','b','sibling@test','%2');
      INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running'),('sb','b','sibling@test','running');
      INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh'),('gb','b',1,'g2','fresh');`);
  }
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  guard.recoverActivation();
  const bodies: Record<string, string | null> = { a: "", b: "" };
  const history: Record<string, string> = { a: "", b: "" };
  const writes: string[] = [], submissions: string[] = [];
  const hooks: { load?: () => void | Promise<void>; paste?: () => void | Promise<void>; sleep?: (ms: number) => void | Promise<void> } = {};
  let staged = "";
  const tmux = new TmuxAdapter(async command => {
    if (command.includes("load-buffer")) await hooks.load?.();
    const node = command.includes("%2") ? "b" : "a";
    if (command.includes("paste-buffer")) {
      await hooks.paste?.();
      writes.push(`paste:${node}:${staged}`); bodies[node] = staged;
    }
    if (command.includes("send-keys")) {
      writes.push(`keys:${node}:${command}`);
      if (command.includes("Enter")) {
        submissions.push(bodies[node] ?? ""); history[node] += `${bodies[node]}\n`; bodies[node] = "";
      }
    }
    return "";
  }, { writeFile: async (_path, text) => { staged = text; }, unlink: async () => {}, tmpName: () => "/fixture/draft-input", bufferName: () => "draft-input" });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "listPanes").mockImplementation(async name => [{ id: guard.target(name).pane! } as never]);
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("node");
  vi.spyOn(tmux, "captureComposerSnapshot").mockImplementation(async name => {
    const body = bodies[guard.target(name).nodeId]; return body == null ? null : frame(body);
  });
  vi.spyOn(tmux, "capturePaneContent").mockImplementation(async name => {
    const node = guard.target(name).nodeId; return bodies[node] == null ? null : history[node] + frame(bodies[node]!).screen;
  });
  let at = Date.now();
  const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), outbox = new OutboxHandler(db);
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo, sessionRegistry, now: () => new Date(at), sleep: async ms => { await hooks.sleep?.(ms); },
    agentActivityStore: { getLatestForNode: () => ({ state: "idle", reason: "fixture idle hook", evidenceSource: "runtime_hook", sampledAt: new Date(at).toISOString(), evidence: null }) } as never });
  const guarded = transport.guardedDelivery!;
  const repo = new QueueRepository(db, new EventBus(db), { transport, loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
  repo.attachOutbox(outbox);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tmuxAdapter" as never, tmux); c.set("rigRepo" as never, rigRepo);
    c.set("sessionTransport" as never, transport); c.set("outboxHandler" as never, outbox); await next();
  });
  app.route("/api/seat", seatRoutes); app.route("/api/transport", transportRoutes());
  cleanup.push(async () => { await guarded.stop(); db.close(); });
  return { db, guard, tmux, transport, guarded, outbox, repo, app, bodies, history, writes, submissions, hooks,
    advance: (ms = 4000) => { at += ms; },
    enable: (settings = {}) => guard.set("a", { mode: "draft-aware", ...settings }, "human@test", "keep draft"),
    send: (id: string, text = "incoming message", opts: SendOpts = {}) => transport.send("worker@test", text, { deliveryId: id, actorSession: "human@test", verify: true, ...opts }),
    post: (path: string, body: unknown, actor = "human@test") => app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-openrig-session": actor }, body: JSON.stringify(body) }),
  };
}


describe("single-attempt draft-aware delivery through the real transport", () => {
  it.each(["ordinary request ", "1. Review the change"])("submits ordinary authored text once: %j", async text => {
    const f = fixture(); await f.enable();
    expect(await f.send("ordinary", text)).toMatchObject({ ok: true, sent: true, delivery: { state: "complete" } });
    expect(await f.send("ordinary", text)).toMatchObject({ delivery: { state: "complete" } });
    expect(f.submissions).toEqual([text]);
  });

  it("completes a successful send without requested verification without claiming render proof", async () => {
    const f = fixture(); await f.enable();
    const result = await f.send("no-verify", "message", { verify: false });
    expect(result).toMatchObject({ ok: true, sent: true, delivery: { state: "complete" } });
    expect(result.verified).toBeUndefined();
    expect(f.outbox.getById("no-verify")!.deliveryState).toBe("delivered");
    await f.send("no-verify", "message", { verify: false });
    expect(f.submissions).toEqual(["message"]);
  });

  it("keeps requested-but-unconfirmed verification indeterminate without resending", async () => {
    const f = fixture(); await f.enable();
    vi.mocked(f.tmux.capturePaneContent).mockResolvedValue("no render evidence");
    expect(await f.send("not-confirmed")).toMatchObject({ ok: true, sent: true, verified: false, delivery: { state: "indeterminate" } });
    await f.send("not-confirmed");
    expect(f.outbox.getById("not-confirmed")!.deliveryState).toBe("indeterminate");
    expect(f.submissions).toHaveLength(1);
  });

  it.each(["draft", "unknown"])("returns the exact %s refusal and original ID immediately, including with wait-for-idle", async condition => {
    const f = fixture(); await f.enable(); f.bodies.a = condition === "unknown" ? null : "unfinished human request";
    const reason = condition === "unknown" ? "draft_input_unknown" : "draft_input_busy";
    const sleep = vi.fn(); f.hooks.sleep = sleep;
    expect(await f.send("held", "incoming message", { waitForIdleMs: 60000 })).toMatchObject({
      outcome: "retained", sent: false, reason, outboxIds: ["held"], delivery: { state: "held", reason },
    });
    expect(sleep).not.toHaveBeenCalled();
    f.bodies.a = ""; f.advance(3600000);
    await f.repo.drainPendingWakeIntents();
    expect(await f.send("held")).toMatchObject({ outcome: "retained", reason });
    expect(f.writes).toEqual([]);
    expect(f.outbox.getById("held")).toMatchObject({ body: "incoming message", deliveryState: "retained" });
    expect(f.db.prepare("SELECT count(*) n FROM outbox_entries").get()).toEqual({ n: 1 });
    expect(await f.send("held", "different")).toMatchObject({ ok: false, reason: "delivery_identity_conflict" });
  });

  it("has no retry timer and keeps held receipts unchanged across restart and mode changes", async () => {
    const first = fixture(); await first.enable(); first.bodies.a = "draft"; await first.send("restart");
    const resumed = fixture(first.db.serialize()); resumed.guarded.recover();
    await resumed.guard.set("a", false, "human@test", "allow new sends");
    await resumed.enable();
    vi.useFakeTimers();
    try { await vi.advanceTimersByTimeAsync(3600000); } finally { vi.useRealTimers(); }
    expect(await resumed.send("restart")).toMatchObject({ reason: "draft_input_busy", delivery: { state: "held" } });
    expect(resumed.writes).toEqual([]);
    expect(resumed.db.prepare("PRAGMA table_info(outbox_entries)").all().map((r: any) => r.name))
      .not.toContain("retry_request");
  });

  it.each([false, true])("never replays an interrupted attempt (generic recovery first: %s)", async genericFirst => {
    const first = fixture(); await first.enable(); first.bodies.a = "draft"; await first.send("crash");
    first.db.exec("UPDATE outbox_entries SET delivery_state='sending',guard_delivery=json_remove(guard_delivery,'$.result');");
    const resumed = fixture(first.db.serialize());
    if (genericFirst) resumed.outbox.reconcileAbandonedSending("crash");
    resumed.guarded.recover();
    expect(await resumed.send("crash")).toMatchObject({ ok: false, reason: "delivery_indeterminate", delivery: { state: "indeterminate", reason: "interrupted_write" } });
    expect(resumed.writes).toEqual([]);
  });

  it("returns an in-flight receipt without duplicate input and waits for active sends on shutdown", async () => {
    const f = fixture(); await f.enable(); const entered = signal(), release = signal();
    f.hooks.paste = async () => { entered.release(); await release.ready; };
    const sending = f.send("concurrent"); await entered.ready;
    expect(await f.send("concurrent")).toMatchObject({ ok: false, reason: "delivery_in_progress" });
    let stopped = false; const stopping = f.guarded.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    release.release(); await Promise.all([sending, stopping]);
    expect(f.submissions).toHaveLength(1);
  });

  it("leaves human edits visible and never replays an already-pasted message", async () => {
    const f = fixture(); await f.enable();
    f.hooks.sleep = ms => { if (ms === 200) f.bodies.a += " plus a human draft"; };
    expect(await f.send("late")).toMatchObject({ ok: false, sent: true, reason: "draft_input_changed", delivery: { state: "indeterminate" } });
    expect(f.bodies.a).toBe("incoming message plus a human draft");
    await f.send("late"); expect(f.writes).toHaveLength(1); expect(f.submissions).toEqual([]);
  });

  it.each([false, true])("does not claim no write for an unknown native result (wait mode: %s)", async wait => {
    const f = fixture(); await f.enable();
    f.hooks.paste = () => { f.bodies.a = "incoming message"; throw new Error("lost native result after dispatch"); };
    const opts = wait ? { waitForIdleMs: 1000 } : {};
    const result = await f.send("unknown-write", "incoming message", opts);
    expect(result).toMatchObject({ ok: false, delivery: { state: "indeterminate" } });
    expect(result.sent).toBeUndefined();
    await f.send("unknown-write", "incoming message", opts);
    expect(f.submissions).toEqual([]);
  });

  it("a failed final ledger update cannot claim no input or authorize replay", async () => {
    const f = fixture(); await f.enable();
    const finalize = vi.spyOn(OutboxHandler.prototype, "finalizeDelivery").mockImplementationOnce(() => { throw new Error("ledger failure"); });
    try {
      const result = await f.send("ledger-failure");
      expect(result).toMatchObject({ ok: false, reason: "delivery_indeterminate", delivery: { state: "indeterminate" } });
      expect(result.sent).toBeUndefined(); await f.send("ledger-failure");
      expect(f.submissions).toEqual(["incoming message"]);
    } finally { finalize.mockRestore(); }
  });


  it("a lost final receipt read cannot report that no input was written", async () => {
    const f = fixture(); await f.enable();
    const prepare = f.db.prepare.bind(f.db);
    let finalized = false;
    const finalize = OutboxHandler.prototype.finalizeDelivery;
    const finalizer = vi.spyOn(OutboxHandler.prototype, "finalizeDelivery").mockImplementation(function (this: OutboxHandler, id, state) {
      const result = finalize.call(this, id, state); finalized = true; return result;
    });
    const reader = vi.spyOn(f.db, "prepare").mockImplementation((sql: string) => {
      if (finalized && sql === "SELECT guard_delivery FROM outbox_entries WHERE outbox_id=?") throw new Error("receipt unavailable");
      return prepare(sql);
    });
    try {
      const result = await f.send("lost-receipt");
      expect(result).toMatchObject({ ok: false, reason: "delivery_indeterminate", outboxIds: ["lost-receipt"] });
      expect(result.sent).toBeUndefined(); expect(f.submissions).toHaveLength(1);
    } finally { reader.mockRestore(); finalizer.mockRestore(); }
    expect(await f.send("lost-receipt")).toMatchObject({ delivery: { state: "complete" } });
    expect(f.submissions).toHaveLength(1);
  });

  it("does not serialize or replay a live prerequisite", async () => {
    const f = fixture(); await f.enable(); f.bodies.a = "draft"; const beforeWrite = vi.fn();
    expect(await f.send("live", "message", { beforeWrite })).toMatchObject({ outcome: "retained", reason: "draft_input_busy" });
    f.bodies.a = ""; await f.send("live", "message");
    expect(beforeWrite).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
  });
});

describe("supported seat and queue integration", () => {
  it("exposes exact held reasons, audit identity and retirement through HTTP", async () => {
    const f = fixture(); f.bodies.a = "draft";
    expect((await f.post("/api/seat/set-typing-guard/worker@test", { mode: "draft-aware", actor: "spoof", reason: "draft" })).status).toBe(200);
    expect(f.db.prepare("SELECT actor FROM seat_delivery_guards").get()).toEqual({ actor: "human@test" });
    const response = await f.post("/api/transport/send", { session: "worker@test", text: "http message", deliveryId: "http", actorSession: "spoof", verify: true });
    expect(await response.json()).toMatchObject({ outcome: "retained", reason: "draft_input_busy", outboxIds: ["http"], delivery: { state: "held" } });
    const page = await (await f.app.request("/api/seat/held-messages/worker@test")).json();
    expect(page.items[0]).toMatchObject({ senderSession: "human@test", body: "http message", delivery: { state: "held", reason: "draft_input_busy" } });
    expect(f.db.prepare("SELECT identity_provenance FROM outbox_entries").get()).toEqual({ identity_provenance: "transport:v1" });
    expect(await (await f.app.request("/api/seat/status/worker@test")).json()).toMatchObject({ typingGuard: { effectiveMode: "draft-aware", heldCount: 1 } });
    expect((await f.post("/api/seat/retire-held-message/sibling@test/http", { reason: "read" })).status).toBe(404);
    expect((await f.post("/api/seat/retire-held-message/worker@test/http", { reason: "read" })).status).toBe(200);
    expect(await (await f.app.request("/api/seat/held-messages/worker@test?id=http")).json()).toMatchObject({ entry: { deliveryState: "retired" }, delivery: { state: "held", reason: "message_retired" } });
    f.bodies.a = ""; expect(await f.send("http", "http message")).toMatchObject({ outcome: "retained" }); expect(f.writes).toEqual([]);
  });

  it("returns a successful HTTP delivery once, preserving its original row", async () => {
    const f = fixture(); await f.enable();
    const send = () => f.post("/api/transport/send", { session: "worker@test", text: "http success", deliveryId: "http-success", verify: true });
    expect(await (await send()).json()).toMatchObject({ ok: true, verified: true, outboxIds: ["http-success"] });
    expect(await (await send()).json()).toMatchObject({ delivery: { state: "complete" } });
    expect(f.db.prepare("SELECT count(*) n FROM outbox_entries").get()).toEqual({ n: 1 }); expect(f.submissions).toEqual(["http success"]);
  });

  it("broadcast preserves one original record per recipient", async () => {
    const f = fixture(); await f.enable();
    expect(await (await f.post("/api/transport/broadcast", { sessions: ["worker@test", "sibling@test"], text: "broadcast message", verify: true })).json()).toMatchObject({ sent: 2, failed: 0 });
    expect(f.db.prepare("SELECT count(*) n FROM outbox_entries").get()).toEqual({ n: 2 });
    expect(f.submissions).toEqual(["broadcast message", "broadcast message"]);
  });

  it("rejects invalid modes, ambiguous controls and obsolete retry settings", async () => {
    const f = fixture();
    for (const body of [{ enabled: true, mode: "draft-aware", reason: "ambiguous" }, { reason: "missing" }, { enabled: "true", reason: "type" },
      { mode: "automatic", reason: "old mode" }, { mode: "draft-aware", maxAttempts: 3, reason: "obsolete" },
      { mode: "draft-aware", holdSeconds: 60, reason: "obsolete" }, { mode: "hold" }]) {
      expect((await f.post("/api/seat/set-typing-guard/worker@test", body)).status).toBe(400);
    }
    expect((await f.post("/api/seat/set-typing-guard/worker@test", { mode: "hold", reason: "draft", actor: "spoof" }, "")).status).toBe(400);
  });

  it("hold keeps messages indefinitely while a sibling still receives sends", async () => {
    const f = fixture(); await f.guard.set("a", { mode: "hold" }, "human@test", "manual terminal");
    expect(await f.send("inbox")).toMatchObject({ outcome: "retained", reason: "typing_guard_enabled" });
    expect(await f.transport.send("sibling@test", "sibling message", { verify: true })).toMatchObject({ ok: true });
    await f.enable(); expect(await f.send("inbox")).toMatchObject({ outcome: "retained" });
    expect(f.submissions).toEqual(["sibling message"]);
  });

  it("a held queue wake remains on the existing queue recovery path without a second scheduler", async () => {
    const f = fixture(); await f.enable(); f.bodies.a = "draft";
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work" });
    await vi.waitFor(() => expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toBe("retained:draft_aware"));
    const id = "wake-intent-" + item.qitemId;
    expect(f.guarded.lookup(id)).toMatchObject({ state: "held", reason: "draft_input_busy" });
    f.bodies.a = ""; await f.repo.drainPendingWakeIntents();
    expect(f.outbox.getById(id)!.deliveryState).toBe("retained");
    expect(f.repo.getById(item.qitemId)!.state).toBe("pending"); expect(f.writes).toEqual([]);
  });

  it("rechecks queue applicability before paste", async () => {
    const f = fixture(); await f.enable();
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work", nudge: false });
    const id = "wake-intent-" + item.qitemId; f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    f.hooks.load = () => { f.db.prepare("UPDATE queue_items SET state='done' WHERE qitem_id=?").run(item.qitemId); };
    await f.repo.drainPendingWakeIntents();
    expect(f.guarded.lookup(id)).toMatchObject({ state: "held", reason: "draft_wake_superseded" });
    expect(f.writes).toEqual([]);
  });

  it.each([false, true])("coalesced wakes preserve every original ID and body (held: %s)", async held => {
    const f = fixture(); await f.enable(); if (held) f.bodies.a = "draft"; const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "work " + i, nudge: false });
      f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
      const id = "wake-intent-" + item.qitemId; ids.push(id);
      f.db.prepare("UPDATE outbox_entries SET tags=? WHERE outbox_id=?").run(JSON.stringify(["queue:return:common"]), id);
    }
    const original = ids.map(id => f.outbox.getById(id)!.body);
    await f.repo.drainPendingWakeIntents();
    expect(f.guarded.lookup(ids[1]!)).toEqual(f.guarded.lookup(ids[0]!));
    f.bodies.a = ""; await f.repo.drainPendingWakeIntents();
    expect(f.submissions).toHaveLength(held ? 0 : 1);
    ids.forEach((id, i) => expect(f.outbox.getById(id)).toMatchObject({ body: original[i], deliveryState: held ? "retained" : "delivered" }));
    expect(f.db.prepare("SELECT count(*) n FROM outbox_entries").get()).toEqual({ n: 2 });
  });
});
