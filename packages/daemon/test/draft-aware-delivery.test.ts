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

function fixture(saved?: Buffer, opts: { runtime?: string; idleHook?: boolean } = {}) {
  const db = new Database(saved ?? ":memory:");
  if (!saved) {
    migrate(db, ALL_MIGRATIONS);
    db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
      INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','${opts.runtime ?? "terminal"}'),('b','rig','sibling','terminal');
      INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','%1'),('bb','b','sibling@test','%2');
      INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running'),('sb','b','sibling@test','running');
      INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh'),('gb','b',1,'g2','fresh');`);
  }
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  guard.recoverActivation();
  const bodies: Record<string, string | null> = { a: "", b: "" };
  const history: Record<string, string> = { a: "", b: "" };
  const writes: string[] = [], submissions: string[] = [];
  const observations: unknown[] = [];
  const hooks: { load?: () => void | Promise<void>; paste?: () => void | Promise<void>; sleep?: (ms: number) => void | Promise<void> } = {};
  let staged = "";
  // A terminal pane shows a submitted line as typed; an agent pane echoes a sent message under its prompt, as Claude does.
  const echo = (node: string, body: string) => (db.prepare("SELECT runtime FROM nodes WHERE id=?").get(node) as { runtime: string }).runtime === "terminal"
    ? `${body}\n` : `${body.split("\n").map((row, i) => (i ? "  " : "❯ ") + row).join("\n")}\n`;
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
        submissions.push(bodies[node] ?? ""); history[node] += echo(node, bodies[node] ?? ""); bodies[node] = "";
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
    eventBus: new EventBus(db), captureObserver: { record: input => { observations.push(input); } },
    agentActivityStore: { resolveSession: () => ({ rigId: "rig", nodeId: "a", sessionName: "worker@test" }), getLatestForNode: () => opts.idleHook === false ? null
      : ({ state: "idle", reason: "fixture idle hook", evidenceSource: "runtime_hook", sampledAt: new Date(at).toISOString(), evidence: null }) } as never });
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
  return { db, guard, tmux, transport, observations, guarded, outbox, repo, app, bodies, history, writes, submissions, hooks,
    advance: (ms = 4000) => { at += ms; },
    enable: (settings = {}) => guard.set("a", { mode: "draft-aware", ...settings }, "human@test", "keep draft"),
    send: (id: string, text = "incoming message", opts: SendOpts = {}) => transport.send("worker@test", text, { deliveryId: id, actorSession: "human@test", verify: true, ...opts }),
    post: (path: string, body: unknown, actor = "human@test") => app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-openrig-session": actor }, body: JSON.stringify(body) }),
  };
}


describe("current draft-aware delivery through the real transport", () => {
  it.each(["ordinary request ", "1. Review the change"])("attempts each ordinary authored request, even with a reused caller ID: %j", async text => {
    const f = fixture(); await f.enable();
    expect(await f.send("ordinary", text)).toMatchObject({ ok: true, sent: true });
    expect(await f.send("ordinary", text)).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual([text, text]);
  });

  it("submits its delayed collapsed paste once, leaving the next queue wake deliverable", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const text = "first line\nsecond line\nlast line";
    let readsAfterPaste = 0;
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async name => {
      const body = f.bodies[f.guard.target(name).nodeId];
      if (body === text) return frame(readsAfterPaste++ === 0 ? "" : "[Pasted text #1 +2 lines]");
      return body == null ? null : frame(body);
    });
    expect(await f.send("delayed-label", text, { verify: false })).toMatchObject({ ok: true, sent: true });
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "next work", nudge: false });
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    await f.repo.drainPendingWakeIntents();
    expect(f.submissions).toEqual([text, expect.stringContaining(item.qitemId)]);
    expect(f.writes.filter(write => write.startsWith("paste:"))).toHaveLength(2);
    expect(f.writes.filter(write => write.startsWith("keys:"))).toHaveLength(2);
    expect(f.bodies.a).toBe("");
    expect(f.outbox.getById("wake-intent-" + item.qitemId)!.deliveryState).toBe("delivered");
  });

  it("does not submit a person's replacement paste after recording its own label", async () => {
    const f = fixture(); await f.enable();
    const text = "first line\nsecond line\nlast line", draft = "different first\ndifferent second\ndifferent last";
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async name => {
      const body = f.bodies[f.guard.target(name).nodeId];
      return body == null ? null : frame(body === text ? "[Pasted text #1 +2 lines]" : body === draft ? "[Pasted text #2 +2 lines]" : body);
    });
    // A person attached directly replaces the draft; no broker humanInput call updates the epoch.
    f.hooks.sleep = ms => { if (ms === 200) f.bodies.a = draft; };
    expect(await f.send("replacement-label", text, { verify: false })).toMatchObject({ ok: false, sent: true, reason: "draft_input_changed" });
    expect(f.submissions).toEqual([]);
    expect(f.writes).toHaveLength(1);
    expect(f.bodies.a).toBe(draft);
  });

  it.each(["wrong count", "moved cursor", "changed composer", "human input"])("does not submit a delayed label after %s", async condition => {
    const f = fixture(); await f.enable();
    const text = "first line\nsecond line\nlast line";
    let readsAfterPaste = 0;
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async name => {
      const body = f.bodies[f.guard.target(name).nodeId];
      if (body !== text) return body == null ? null : frame(body);
      if (readsAfterPaste++ === 0) return frame("");
      const snapshot = frame(condition === "wrong count" ? "[Pasted text #1 +9 lines]" : "[Pasted text #1 +2 lines]");
      if (condition === "moved cursor") snapshot.cursor.x--;
      if (condition === "changed composer") snapshot.cursor.width--;
      return snapshot;
    });
    if (condition === "human input") f.hooks.sleep = async ms => {
      if (ms === 200) await f.guard.humanInput("worker@test", async () => {});
    };
    const result = await f.send("unowned-label", text, { verify: false });
    expect(result).toMatchObject({ ok: false, sent: true, reason: "draft_input_changed" });
    expect(result.error).toContain("Enter was not sent");
    expect(f.submissions).toEqual([]);
    expect(f.bodies.a).toBe(text);
    expect(f.writes).toHaveLength(1);
  });

  it("retains the next wake behind an uncertain native Enter without submitting or replaying the leftover", async () => {
    const f = fixture(); await f.enable();
    const enter = vi.spyOn(f.tmux, "sendKeys").mockResolvedValueOnce({ ok: false, code: "tmux_error", message: "lost Enter result" });
    const first = await f.send("uncertain-enter");
    expect(first).toMatchObject({ ok: false, reason: "submit_failed" });
    expect(first.error).toContain("submission outcome is unconfirmed");
    expect(f.outbox.getById(first.outboxIds![0]!)!.deliveryState).toBe("indeterminate");
    expect(await f.send("next-wake")).toMatchObject({ outcome: "retained", sent: false, reason: "draft_input_busy" });
    expect(enter).toHaveBeenCalledTimes(1);
    expect(f.writes).toHaveLength(1);
    expect(f.submissions).toEqual([]);
    expect(f.bodies.a).toBe("incoming message");
  });

  it("tries a current request after the person's draft clears, without replaying a saved prerequisite", async () => {
    const f = fixture(); await f.enable(); f.bodies.a = "a person's draft";
    const oldPrerequisite = vi.fn();
    expect(await f.send("draft-cleared", "current request", { beforeWrite: oldPrerequisite })).toMatchObject({ outcome: "retained", sent: false });
    expect(f.submissions).toEqual([]);
    f.bodies.a = "";
    expect(await f.send("draft-cleared", "current request")).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual(["current request"]);
    expect(oldPrerequisite).not.toHaveBeenCalled();
  });

  it("delivers at an ordinary empty prompt when receipt bookkeeping is unavailable", async () => {
    const f = fixture(); await f.enable();
    f.db.exec("CREATE TRIGGER fail_delivery_receipt BEFORE UPDATE OF guard_delivery ON outbox_entries BEGIN SELECT RAISE(ABORT, 'fixture receipt unavailable'); END;");
    const result = await f.send("no-receipt", "arrives despite bookkeeping");
    expect(f.submissions).toEqual(["arrives despite bookkeeping"]);
    expect(result).toMatchObject({ ok: true, sent: true });
    expect(result.warning).toMatch(/bookkeeping|receipt/i);
  });

  it("protects a human draft without claiming custody when its record cannot be saved", async () => {
    const f = fixture(); await f.enable(); f.bodies.a = "unfinished human input";
    f.db.exec("CREATE TRIGGER fail_held_receipt BEFORE UPDATE OF guard_delivery ON outbox_entries BEGIN SELECT RAISE(ABORT, 'fixture receipt unavailable'); END;");
    const result = await f.send("unsaved-held", "incoming message");
    expect(result).toMatchObject({ ok: false, sent: false, outcome: "failed", reason: "draft_input_busy" });
    expect(result.warning).toMatch(/bookkeeping/);
    expect(result.outboxIds).toBeUndefined();
    expect(f.bodies.a).toBe("unfinished human input"); expect(f.writes).toEqual([]);
  });

  it("a callback throwing null stays an uncertain delivery result", async () => {
    const f = fixture(); await f.enable();
    expect(await f.send("null-callback", "current request", { beforeWrite: () => { throw null; } }))
      .toMatchObject({ ok: false, outcome: "failed", reason: "delivery_indeterminate" });
    expect(f.submissions).toEqual([]);
  });

  it("completes a successful send without requested verification without claiming render proof", async () => {
    const f = fixture(); await f.enable();
    const result = await f.send("no-verify", "message", { verify: false });
    expect(result).toMatchObject({ ok: true, sent: true });
    expect(result.verified).toBeUndefined();
    expect(f.outbox.getById(result.outboxIds![0]!)!.deliveryState).toBe("delivered");
    await f.send("no-verify", "message", { verify: false });
    expect(f.submissions).toEqual(["message", "message"]);
  });

  it("keeps unconfirmed verification honest while allowing a current request", async () => {
    const f = fixture(); await f.enable();
    vi.mocked(f.tmux.capturePaneContent).mockResolvedValue("no render evidence");
    expect(await f.send("not-confirmed")).toMatchObject({ ok: true, sent: true, verified: false });
    await f.send("not-confirmed");
    expect(f.db.prepare("SELECT delivery_state FROM outbox_entries").all()).toEqual([{ delivery_state: "indeterminate" }, { delivery_state: "indeterminate" }]);
    expect(f.submissions).toHaveLength(2);
  });

  // With no authoritative idle hook, a Claude seat's readiness comes from its screen, so the lease-free idle wait would read a draft as
  // needs-input, or an unreadable screen as unknown until the deadline, before the draft-aware check ran. A draft-aware seat keeps the
  // check's immediate result instead.
  it.each(["draft", "unknown"])("a Claude seat with no idle hook returns the exact %s refusal and original ID immediately with wait-for-idle", async condition => {
    const f = fixture(undefined, { runtime: "claude-code", idleHook: false }); await f.enable();
    f.bodies.a = condition === "unknown" ? null : "unfinished human request";
    const reason = condition === "unknown" ? "draft_input_unknown" : "draft_input_busy";
    const sleep = vi.fn((ms: number) => f.advance(ms)); f.hooks.sleep = sleep; // a wait, if any, reaches its deadline
    expect(await f.send("held-claude", "incoming message", { waitForIdleMs: 60000, verify: false })).toMatchObject({
      outcome: "retained", sent: false, reason, outboxIds: [expect.any(String)],
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
    expect(f.outbox.heldForNode("a").items[0]).toMatchObject({ body: "incoming message", deliveryState: "retained" });
  });

  it("a Claude seat with no idle hook and an empty input box takes a wait-for-idle send once", async () => {
    const f = fixture(undefined, { runtime: "claude-code", idleHook: false }); await f.enable();
    expect(await f.send("empty-claude", "incoming message", { waitForIdleMs: 60000, verify: false })).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual(["incoming message"]);
  });

  it.each([false, true])("preserves old uncertainty but allows a current request (generic recovery first: %s)", async genericFirst => {
    const first = fixture(); await first.enable(); first.bodies.a = "draft"; await first.send("crash");
    first.db.exec("UPDATE outbox_entries SET delivery_state='sending',guard_delivery=json_remove(guard_delivery,'$.result');");
    const resumed = fixture(first.db.serialize());
    if (genericFirst) resumed.outbox.reconcileAbandonedSending("crash");
    resumed.guarded.recover();
    expect(await resumed.send("crash")).toMatchObject({ ok: true, sent: true });
    expect(resumed.submissions).toEqual(["incoming message"]);
    expect(resumed.db.prepare("SELECT count(*) AS n FROM outbox_entries WHERE delivery_state='indeterminate'").get()).toEqual({ n: 1 });
  });

  it("serializes current requests and waits for active input on shutdown", async () => {
    const f = fixture(); await f.enable(); const entered = signal(), release = signal();
    f.hooks.paste = async () => { entered.release(); await release.ready; };
    const sending = f.send("concurrent"); await entered.ready;
    const second = f.send("concurrent");
    let stopped = false; const stopping = f.guarded.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    release.release(); await Promise.all([sending, second, stopping]);
    expect(f.submissions).toEqual(["incoming message", "incoming message"]);
  });

  it("leaves human edits visible and never replays an already-pasted message", async () => {
    const f = fixture(); await f.enable();
    f.hooks.sleep = ms => { if (ms === 200) f.bodies.a += " plus a human draft"; };
    expect(await f.send("late")).toMatchObject({ ok: false, sent: true, reason: "draft_input_changed" });
    expect(f.bodies.a).toBe("incoming message plus a human draft");
    await f.send("late"); expect(f.writes).toHaveLength(1); expect(f.submissions).toEqual([]);
  });

  it.each([false, true])("does not claim no write for an unknown native result (wait mode: %s)", async wait => {
    const f = fixture(); await f.enable();
    f.hooks.paste = () => { f.bodies.a = "incoming message"; throw new Error("lost native result after dispatch"); };
    const opts = wait ? { waitForIdleMs: 1000 } : {};
    const result = await f.send("unknown-write", "incoming message", opts);
    expect(result).toMatchObject({ ok: false });
    expect(result.sent).toBeUndefined();
    await f.send("unknown-write", "incoming message", opts);
    expect(f.submissions).toEqual([]);
  });

  it("reports actual delivered input when a final ledger update fails", async () => {
    const f = fixture(); await f.enable();
    const finalize = vi.spyOn(OutboxHandler.prototype, "finalizeDelivery").mockImplementationOnce(() => { throw new Error("ledger failure"); });
    try {
      const result = await f.send("ledger-failure");
      expect(result).toMatchObject({ ok: true, sent: true, verified: true });
      expect(result.warning).toMatch(/bookkeeping/);
      await f.send("ledger-failure");
      expect(f.submissions).toEqual(["incoming message", "incoming message"]);
    } finally { finalize.mockRestore(); }
  });


  it("reports current input without requiring a historical receipt read", async () => {
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
      expect(result).toMatchObject({ ok: true, sent: true });
      expect(f.submissions).toHaveLength(1);
    } finally { reader.mockRestore(); finalizer.mockRestore(); }
    expect(await f.send("lost-receipt")).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toHaveLength(2);
  });

  it("does not serialize or replay a live prerequisite", async () => {
    const f = fixture(); await f.enable(); f.bodies.a = "draft"; const beforeWrite = vi.fn();
    expect(await f.send("live", "message", { beforeWrite })).toMatchObject({ outcome: "retained", reason: "draft_input_busy" });
    f.bodies.a = ""; await f.send("live", "message");
    expect(beforeWrite).not.toHaveBeenCalled(); expect(f.submissions).toEqual(["message"]);
  });
});

describe("supported seat and queue integration", () => {
  it.each(["failed", "indeterminate", "sending"])("startup recovery attempts a still-current %s queue wake", async state => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work", nudge: false });
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    const id = "wake-intent-" + item.qitemId;
    const original = f.outbox.getById(id)!;
    f.db.prepare("UPDATE outbox_entries SET delivery_state=? WHERE outbox_id=?").run(state, id);
    const reopened = fixture(f.db.serialize());
    reopened.repo.reconcileAbandonedWakeIntents();
    await reopened.repo.drainPendingWakeIntents();
    expect(reopened.submissions).toHaveLength(1);
    expect(reopened.submissions[0]).toContain(original.body);
    expect(reopened.submissions[0]).toMatch(/may (?:repeat|be repeated)/i);
    expect(reopened.outbox.getById(id)!.body).toBe(original.body);
    expect(reopened.outbox.getById(id)!.deliveryState).toBe("delivered");
    expect(reopened.repo.getById(item.qitemId)!.state).toBe("pending");
    expect(reopened.db.prepare("SELECT count(*) AS n FROM queue_items").get()).toEqual({ n: 1 });
    expect(reopened.bodies.b).toBe("");
    await reopened.repo.drainPendingWakeIntents();
    expect(reopened.submissions).toHaveLength(1);
  });

  it.each(["delivered", "retained", "retired"])("startup recovery leaves a %s queue wake alone", async state => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work", nudge: false });
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    const id = "wake-intent-" + item.qitemId;
    f.db.prepare("UPDATE outbox_entries SET delivery_state=? WHERE outbox_id=?").run(state, id);
    const reopened = fixture(f.db.serialize());
    reopened.repo.reconcileAbandonedWakeIntents();
    await reopened.repo.drainPendingWakeIntents();
    expect(reopened.writes).toEqual([]);
    expect(reopened.outbox.getById(id)!.deliveryState).toBe(state);
  });

  it.each(["closed", "claimed", "reassigned", "absent-pane", "replacement"].flatMap(state =>
    [false, true].map(draftAware => ({ state, draftAware }))))("recovery does not paste for $state work (draft-aware: $draftAware)", async ({ state, draftAware }) => {
    const f = fixture(undefined, { runtime: "claude-code" }); if (draftAware) await f.enable();
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work", nudge: false });
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    const id = "wake-intent-" + item.qitemId;
    f.db.prepare("UPDATE outbox_entries SET delivery_state='indeterminate' WHERE outbox_id=?").run(id);
    if (state === "closed") f.db.prepare("UPDATE queue_items SET state='done' WHERE qitem_id=?").run(item.qitemId);
    if (state === "claimed") f.repo.claim({ qitemId: item.qitemId, destinationSession: "worker@test" });
    if (state === "reassigned") f.db.prepare("UPDATE queue_items SET destination_session='sibling@test' WHERE qitem_id=?").run(item.qitemId);
    if (state === "absent-pane") f.db.prepare("UPDATE sessions SET status='exited' WHERE node_id='a'").run();
    if (state === "replacement") f.db.exec("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('next-a','a',2,'replacement-a','fresh')");
    const reopened = fixture(f.db.serialize());
    if (state === "absent-pane") vi.mocked(reopened.tmux.probeSession).mockResolvedValue({ state: "absent" });
    reopened.repo.reconcileAbandonedWakeIntents();
    await reopened.repo.drainPendingWakeIntents();
    expect(reopened.writes).toEqual([]);
  });

  it("tries a failed recovery once per pass even when the native result stays unknown", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work", nudge: false });
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    const id = "wake-intent-" + item.qitemId;
    f.db.prepare("UPDATE outbox_entries SET delivery_state='indeterminate' WHERE outbox_id=?").run(id);
    let attempts = 0;
    f.hooks.paste = () => { attempts++; throw new Error("native result unavailable"); };
    await f.repo.drainPendingWakeIntents();
    expect(attempts).toBe(1);
    expect(f.outbox.getById(id)!.deliveryState).toBe("indeterminate");
    expect(f.repo.getById(item.qitemId)!.lastNudgeWireResult).toMatch(/^indeterminate:/);
  });

  it("keeps earlier uncertainty when a recovery fails before input", async () => {
    const f = fixture(undefined, { runtime: "claude-code" });
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "work", nudge: false });
    const id = "wake-intent-" + item.qitemId;
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    f.db.prepare("UPDATE outbox_entries SET delivery_state='indeterminate' WHERE outbox_id=?").run(id);
    vi.spyOn(f.tmux, "probeSession").mockResolvedValue({ state: "absent" });
    expect(await f.repo.drainPendingWakeIntents()).toMatchObject({ indeterminate: 1, failed: 0 });
    expect(f.writes).toEqual([]);
    expect(f.outbox.getById(id)!.deliveryState).toBe("indeterminate");
    expect(f.repo.getById(item.qitemId)!.lastNudgeWireResult).toMatch(/^indeterminate:/);
  });

  it("does not describe an earlier attempt for a never-attempted pending wake", async () => {
    const f = fixture(undefined, { runtime: "claude-code" });
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "work", nudge: false });
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    await f.repo.drainPendingWakeIntents();
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]).not.toContain("earlier unconfirmed attempt");
  });

  it("reads current recovery candidates without visiting historical uncertain notifications", async () => {
    const f = fixture(undefined, { runtime: "claude-code" });
    const old = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "old work", nudge: false });
    f.db.prepare("UPDATE queue_items SET state='done' WHERE qitem_id=?").run(old.qitemId);
    f.db.transaction(() => { for (let i = 0; i < 600; i++) f.outbox.record({ outboxId: `wake-intent-history-${i}`, senderSession: "sender@test", destinationSession: "worker@test", body: "historical", auditPointer: old.qitemId }); })();
    f.db.exec("UPDATE outbox_entries SET delivery_state='indeterminate' WHERE outbox_id LIKE 'wake-intent-history-%'");
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "current work", nudge: false });
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    const reads = vi.spyOn(f.outbox, "getById");
    await f.repo.drainPendingWakeIntents();
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]).toContain(item.qitemId);
    expect(reads.mock.calls.length).toBeLessThan(10);
  });

  it.each(["draft_input_changed", "delivery_indeterminate", "submit_failed", "send_failed"])(
    "keeps a committed wake's %s outcome indeterminate in the queue", async reason => {
      const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
      const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work", nudge: false });
      const id = "wake-intent-" + item.qitemId;
      f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
      if (reason === "draft_input_changed") f.hooks.sleep = ms => { if (ms === 200) f.bodies.a += " plus a human draft"; };
      if (reason === "delivery_indeterminate") f.hooks.sleep = () => { throw new Error("interrupted after the paste"); };
      if (reason === "submit_failed") vi.spyOn(f.tmux, "sendKeys").mockResolvedValue({ ok: false, code: "tmux_error", message: "lost Enter result" });
      if (reason === "send_failed") f.hooks.paste = () => { f.bodies.a = "possibly pasted"; throw new Error("lost native paste result"); };

      await f.repo.drainPendingWakeIntents();
      const receipt = JSON.parse((f.db.prepare("SELECT guard_delivery AS value FROM outbox_entries WHERE outbox_id=?").get(id) as { value: string }).value);
      expect(receipt.result).toMatchObject({ ok: false, reason });
      expect(receipt.result.delivery).toBeUndefined();
      expect(f.repo.getById(item.qitemId)!.lastNudgeWireResult).toMatch(/^indeterminate:/);
      expect(f.outbox.getById(id)!.deliveryState).toBe("indeterminate");
      expect(f.submissions).toEqual([]);
    },
  );

  it.each(["ladder", "legacy-boot"])("delivers a %s nudge without a precommitted outbox entry", async path => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work", nudge: false });
    if (path === "ladder") await f.repo.maybeNudge(item.qitemId, "worker@test", true, "sender@test");
    else await f.repo.recoverLostNudge(item.qitemId, "worker@test", "sender@test");
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]).toContain(item.qitemId);
    expect(f.bodies.b).toBe("");
    expect(f.repo.getById(item.qitemId)!.lastNudgeWireResult).toBe("verified");
  });

  it.each(["current", "closed", "reassigned"])("checks the %s queue facts without saved delivery bookkeeping", async state => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work", nudge: false });
    f.db.exec("CREATE TRIGGER unavailable_nudge_receipt BEFORE UPDATE OF guard_delivery ON outbox_entries BEGIN SELECT RAISE(ABORT, 'fixture receipt unavailable'); END;");
    f.hooks.load = () => {
      if (state === "closed") f.db.prepare("UPDATE queue_items SET state='done' WHERE qitem_id=?").run(item.qitemId);
      if (state === "reassigned") f.db.prepare("UPDATE queue_items SET destination_session='sibling@test' WHERE qitem_id=?").run(item.qitemId);
    };
    await f.repo.maybeNudge(item.qitemId, "worker@test", true, "sender@test");
    expect(f.db.prepare("SELECT count(*) AS n FROM outbox_entries").get()).toEqual({ n: 0 });
    if (state === "current") {
      expect(f.submissions).toHaveLength(1);
      expect(f.submissions[0]).toContain(item.qitemId);
      expect(f.repo.getById(item.qitemId)!.lastNudgeWireResult).toBe("verified");
    } else expect(f.writes).toEqual([]);
    expect(f.bodies.b).toBe("");
  });

  it("exposes exact held reasons, audit identity and retirement through HTTP", async () => {
    const f = fixture(); f.bodies.a = "draft";
    expect((await f.post("/api/seat/set-typing-guard/worker@test", { mode: "draft-aware", actor: "spoof", reason: "draft" })).status).toBe(200);
    expect(f.db.prepare("SELECT actor FROM seat_delivery_guards").get()).toEqual({ actor: "human@test" });
    const response = await f.post("/api/transport/send", { session: "worker@test", text: "http message", deliveryId: "http", actorSession: "spoof", verify: true });
    const held = await response.json();
    expect(held).toMatchObject({ outcome: "retained", reason: "draft_input_busy", outboxIds: [expect.any(String)] });
    const id = held.outboxIds[0];
    const page = await (await f.app.request("/api/seat/held-messages/worker@test")).json();
    expect(page.items[0]).toMatchObject({ senderSession: "human@test", body: "http message", delivery: { state: "held", reason: "draft_input_busy" } });
    expect(f.db.prepare("SELECT identity_provenance FROM outbox_entries").get()).toEqual({ identity_provenance: "transport:v1" });
    expect(await (await f.app.request("/api/seat/status/worker@test")).json()).toMatchObject({ typingGuard: { effectiveMode: "draft-aware", heldCount: 1 } });
    expect((await f.post(`/api/seat/retire-held-message/sibling@test/${id}`, { reason: "read" })).status).toBe(404);
    expect((await f.post(`/api/seat/retire-held-message/worker@test/${id}`, { reason: "read" })).status).toBe(200);
    expect(await (await f.app.request(`/api/seat/held-messages/worker@test?id=${id}`)).json()).toMatchObject({ entry: { deliveryState: "retired" }, delivery: { state: "held", reason: "message_retired" } });
    expect(f.writes).toEqual([]); // Retirement itself did not type anything.
    f.bodies.a = ""; expect(await f.send("http", "http message")).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual(["http message"]);
  });

  it("attempts each explicit HTTP request despite a reused caller ID", async () => {
    const f = fixture(); await f.enable();
    const send = () => f.post("/api/transport/send", { session: "worker@test", text: "http success", deliveryId: "http-success", verify: true });
    expect(await (await send()).json()).toMatchObject({ ok: true, verified: true });
    expect(await (await send()).json()).toMatchObject({ ok: true, verified: true });
    expect(f.submissions).toEqual(["http success", "http success"]);
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
    await f.enable(); expect(await f.send("inbox")).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual(["sibling message", "incoming message"]);
  });

  // Queue wakes go to an agent seat: a wake to a terminal seat types nothing before any draft check (gateway-destination-routing covers it).
  it("a held queue wake remains on the existing queue recovery path without a second scheduler", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work" });
    await vi.waitFor(() => expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toBe("retained:draft_aware"));
    const id = "wake-intent-" + item.qitemId;
    expect(f.guarded.lookup(id)).toMatchObject({ state: "held", reason: "draft_input_busy" });
    f.bodies.a = ""; await f.repo.drainPendingWakeIntents();
    expect(f.outbox.getById(id)!.deliveryState).toBe("retained");
    expect(f.repo.getById(item.qitemId)!.state).toBe("pending"); expect(f.writes).toEqual([]);
  });

  it("rechecks queue applicability before paste", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work", nudge: false });
    const id = "wake-intent-" + item.qitemId; f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    f.hooks.load = () => { f.db.prepare("UPDATE queue_items SET state='done' WHERE qitem_id=?").run(item.qitemId); };
    await f.repo.drainPendingWakeIntents();
    expect(f.guarded.lookup(id)).toMatchObject({ state: "held", reason: "draft_wake_superseded" });
    expect(f.writes).toEqual([]);
  });

  it.each([false, true])("coalesced wakes preserve every original ID and body (held: %s)", async held => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); if (held) f.bodies.a = "draft"; const ids: string[] = [];
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


describe("deliberate override preserves existing input", () => {
  const override = { dangerouslyInteract: true, reason: "fixture interaction", verify: false };
  it.each(["off", "draft-aware", "hold", "openrig-urgent", "urgent-only", "sends-only"])("stops and shows typed input under %s without retaining it", async mode => {
    const f = fixture();
    await f.guard.set("a", { mode }, "human@test", "fixture policy");
    const draft = "私の下書き😀\n  second line U3-private";
    // Arrives during buffer preparation, so a check before calling the adapter would be too early.
    f.hooks.load = () => { f.bodies.a = draft; };
    const res = await f.post("/api/transport/send", { session: "worker@test", text: "incoming override", ...override });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, sent: false, reason: "override_input_present", existingInput: {
      classification: "typed_or_pasted", rows: draft.split("\n"), suggestionRows: [], fullContentsVisible: true,
      target: { nodeId: "a", occupant: "g1", pane: "%1" }, cursor: expect.objectContaining({ y: 3 }),
    } });
    expect(f.writes).toEqual([]);
    expect(f.bodies.a).toBe(draft);
    expect(f.db.prepare("SELECT count(*) n FROM outbox_entries").get()).toEqual({ n: 0 });
    expect(f.db.serialize().includes(Buffer.from("U3-private"))).toBe(false);
    expect(f.observations).toEqual([]);
  });

  it.each([null, "[Pasted text #4 +18 lines]"])("shows unreadable or collapsed input honestly: %s", async body => {
    const f = fixture(); f.bodies.a = body;
    const result = await f.send("override", "incoming", override);
    expect(result).toMatchObject({ ok: false, sent: false, existingInput: { classification: body === null ? "unreadable" : "typed_or_pasted", fullContentsVisible: false } });
    expect(f.writes).toEqual([]);
  });

  it.each(["", "typed"])("separates the suggestion from %j and never stores either", async typed => {
    const f = fixture(); const suggestion = " U3 suggestion private";
    vi.mocked(f.tmux.captureComposerSnapshot).mockResolvedValue({ ...frame(`${typed}\x1b[2m${suggestion}\x1b[22m`),
      cursor: { x: 2 + typed.length, y: 2, width: 240, height: 60 } });
    const result = await f.send("override", "incoming", override);
    expect(result).toMatchObject({ sent: typed === "" ? true : false, existingInput: {
      classification: typed ? "typed_or_pasted" : "suggestion_only", rows: [typed], suggestionRows: [suggestion],
    } });
    expect(f.writes).toEqual(typed ? [] : ["paste:a:incoming"]); // Static suggestion frame never proves this answer staged for Enter.
    expect(f.db.serialize().includes(Buffer.from(suggestion))).toBe(false);
  });

  it("the explicit unchecked option can drive unreadable input without clearing or retaining", async () => {
    const f = fixture(); await f.guard.set("a", { mode: "hold" }, "human@test", "fixture quiet");
    vi.mocked(f.tmux.captureComposerSnapshot).mockResolvedValue(null);
    const result = await f.send("unchecked", "incoming", { ...override, typeWithoutChecking: true } as SendOpts);
    expect(result).toMatchObject({ ok: true, sent: true, existingInput: { classification: "not_checked", cleared: false } });
    expect(f.tmux.captureComposerSnapshot).not.toHaveBeenCalled();
    expect(f.writes).toEqual(["paste:a:incoming"]);
    expect(f.submissions).toEqual([]); // Unreadable input cannot prove the answer staged for Enter.
  });

  it.each(["R1-existing-draft", ""])("broadcast wait plus override checks current input before typing: %j", async draft => {
    const f = fixture(); await f.guard.set("a", { mode: "hold" }, "human@test", "fixture quiet");
    f.bodies.a = draft;
    const response = await f.post("/api/transport/broadcast", { sessions: ["worker@test"], text: "outgoing", ...override, verify: true, waitForIdleMs: 100 });
    expect(response.status).toBe(200);
    const { results } = await response.json();
    expect(results[0]).toMatchObject(draft
      ? { ok: false, sent: false, reason: "override_input_present", existingInput: { rows: [draft], classification: "typed_or_pasted" } }
      : { ok: true, sent: true, existingInput: { classification: "empty" } });
    expect(f.writes).toEqual(draft ? [] : ["paste:a:outgoing"]);
    expect(f.submissions).toEqual([]); // Terminal fixture cannot prove a native answer staged for Enter.
    expect(f.observations).toEqual([]);
    expect(f.db.serialize().includes(Buffer.from("R1-existing-draft"))).toBe(false);
  });

  it("unchecked API requests require explicit interaction and a reason", async () => {
    const f = fixture();
    for (const [route, dangerouslyInteract] of [["send", false], ["broadcast", true]] as const) {
      const response = await f.post(`/api/transport/${route}`, { dangerouslyInteract, session: "worker@test", sessions: ["worker@test"], text: "ordinary", typeWithoutChecking: true });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ reason: "invalid_dangerously_interact" });
    }
    expect(f.writes).toEqual([]);
  });

  it("a recognised native prompt keeps its existing audited interaction", async () => {
    const f = fixture(undefined, { idleHook: false, runtime: "codex" });
    await f.guard.set("a", { mode: "hold" }, "human@test", "fixture quiet");
    vi.mocked(f.tmux.capturePaneContent).mockResolvedValue("Codex update available.\n\n› 1. Update now\n  2. Skip this version\n  3. Remind me later\n\n  gpt-5.5 high · Context [████ ] · ~/example");
    expect(await f.send("native-prompt", "y", override)).toMatchObject({ ok: true, sent: true });
    expect(f.writes).toEqual(["paste:a:y"]);
    const audit = f.db.prepare("SELECT payload FROM events WHERE type='transport.prompt_override'").get() as { payload: string };
    expect(JSON.parse(audit.payload)).not.toHaveProperty("input");
    expect(f.observations).toEqual([]);
  });
});
