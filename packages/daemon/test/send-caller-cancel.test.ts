// A send whose caller has gone away while it still waited never types later; once input may have started, its result
// stays honest. Driven through the real transport route, SessionTransport, seat delivery guard and tmux adapter (a
// recording exec, no tmux server). Native: not run.
import Database from "better-sqlite3";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { transportRoutes } from "../src/routes/transport.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(opts: { guarded?: boolean } = {}) {
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
    INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','terminal'),('b','rig','sibling','terminal');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','%1'),('bb','b','sibling@test','%2');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running'),('sb','b','sibling@test','running');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh'),('gb','b',1,'g2','fresh');`);
  const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
  guard.recoverActivation();
  /** Every pane write, in order: `paste:<node>:<text>` and `keys:<node>:<keys>`. */
  const writes: string[] = [];
  const hooks: { load?: () => void; paste?: () => void } = {};
  let staged = "";
  const tmux = new TmuxAdapter(async (command) => {
    const node = command.includes("%2") || command.includes("sibling@test") ? "b" : "a";
    if (command.includes("load-buffer")) hooks.load?.();
    if (command.includes("paste-buffer")) { hooks.paste?.(); writes.push(`paste:${node}:${staged}`); }
    if (command.includes("send-keys")) writes.push(`keys:${node}:${command.includes("Enter") ? "Enter" : command}`);
    return "";
  }, { writeFile: async (_path, text) => { staged = text; }, unlink: async () => {}, tmpName: () => "/fixture/input", bufferName: () => "input" });
  if (opts.guarded !== false) tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "listPanes").mockImplementation(async (name) => [{ id: name.startsWith("sibling") || name === "%2" ? "%2" : "%1" } as never]);
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("bash");
  const outbox = new OutboxHandler(db);
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))), waitForIdlePollMs: 5 });
  /** Seat readiness, per session: what the idle wait observes. */
  const activity: Record<string, string> = { "worker@test": "idle", "sibling@test": "idle" };
  (transport as never as { classifySendReadiness: unknown }).classifySendReadiness = async (input: { sessionName: string }) => ({ state: activity[input.sessionName] ?? "idle", reason: "fixture", evidenceSource: "pane_heuristic", sampledAt: new Date().toISOString(), evidence: null });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("sessionTransport" as never, transport); c.set("outboxHandler" as never, outbox); await next(); });
  app.route("/api/transport", transportRoutes());
  const post = (path: string, body: unknown, signal?: AbortSignal) => app.request(`/api/transport${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-openrig-session": "human@test" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  cleanup.push(() => db.close());
  return { db, guard, tmux, transport, outbox, app, post, writes, hooks, activity };
}

describe("a cancelled caller's send never types later", () => {
  it("a request already cancelled when it arrives writes nothing", async () => {
    const f = fixture();
    const caller = new AbortController(); caller.abort();
    const res = await f.post("/send", { session: "worker@test", text: "WORK" }, caller.signal);
    expect(f.writes).toEqual([]);
    expect(await res.json()).toMatchObject({ ok: false, sent: false, reason: "caller_cancelled", inputPhase: "not_reached" });
  });

  it.each([["guarded (lease-free wait)", true], ["unguarded (in-lease wait)", false]] as const)(
    "%s: a caller that goes away during --wait-for-idle never types, even after the seat goes idle",
    async (_label, guarded) => {
      const f = fixture({ guarded });
      f.activity["worker@test"] = "running";
      const caller = new AbortController();
      const pending = f.post("/send", { session: "worker@test", text: "WORK", waitForIdleMs: 60_000 }, caller.signal);
      await settle();
      caller.abort();
      await settle();
      f.activity["worker@test"] = "idle";
      const res = await pending;
      await settle();
      expect(f.writes).toEqual([]);
      expect(await res.json()).toMatchObject({ ok: false, sent: false, reason: "caller_cancelled", inputPhase: "not_reached" });
    });

  it("a cancel seen after the input buffer is loaded but before the paste reports not_reached and issues no paste", async () => {
    const f = fixture();
    const caller = new AbortController();
    f.hooks.load = () => caller.abort();
    const result = await f.transport.send("worker@test", "WORK", { signal: caller.signal });
    expect(f.writes).toEqual([]);
    expect(result).toMatchObject({ ok: false, sent: false, reason: "caller_cancelled", inputPhase: "not_reached" });
  });

  it("a cancel after the text is written changes nothing: Enter is sent as today and the result reports the write", async () => {
    const f = fixture();
    const caller = new AbortController();
    f.hooks.paste = () => caller.abort();
    const result = await f.transport.send("worker@test", "WORK", { signal: caller.signal });
    expect(f.writes).toEqual(["paste:a:WORK", "keys:a:Enter"]);
    expect(result).toMatchObject({ ok: true });
    expect(result.reason).not.toBe("caller_cancelled");
    expect(result.inputPhase).not.toBe("not_reached");
  });

  it("a fully received request whose connection closes before the response never types", async () => {
    const f = fixture();
    f.activity["worker@test"] = "running";
    const server = serve({ fetch: f.app.fetch, port: 0, hostname: "127.0.0.1" });
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const body = JSON.stringify({ session: "worker@test", text: "WORK", waitForIdleMs: 60_000 });
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/transport/send", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-openrig-session": "human@test" } });
    req.on("error", () => {});
    req.end(body); // the whole request is sent
    await settle(80);
    req.destroy(); // then the caller goes away before any response
    await settle(80);
    f.activity["worker@test"] = "idle";
    await settle(200);
    expect(f.writes).toEqual([]);
  });

  it("a retry after a proven no-input cancel, with the same delivery id, writes exactly once", async () => {
    const f = fixture({ guarded: false });
    const caller = new AbortController(); caller.abort();
    const cancelled = await f.transport.send("worker@test", "WORK", { deliveryId: "same", signal: caller.signal });
    expect(cancelled).toMatchObject({ reason: "caller_cancelled", inputPhase: "not_reached" });
    const retried = await f.transport.send("worker@test", "WORK", { deliveryId: "same" });
    expect(retried).toMatchObject({ ok: true });
    expect(f.writes).toEqual(["paste:a:WORK", "keys:a:Enter"]);
  });

  it("broadcast: a cancel during one recipient's wait keeps the started recipient's result and writes nothing to the rest", async () => {
    const f = fixture();
    (f.transport as never as { resolveSessions: unknown }).resolveSessions = async () => ({ ok: true, sessions: [{ sessionName: "worker@test" }, { sessionName: "sibling@test" }] });
    f.activity["sibling@test"] = "running";
    const caller = new AbortController();
    const pending = f.post("/broadcast", { sessions: ["worker@test", "sibling@test"], text: "ALL", waitForIdleMs: 60_000 }, caller.signal);
    await settle(80);
    expect(f.writes).toEqual(["paste:a:ALL", "keys:a:Enter"]);
    caller.abort();
    await settle();
    f.activity["sibling@test"] = "idle";
    const res = await pending;
    await settle();
    expect(f.writes).toEqual(["paste:a:ALL", "keys:a:Enter"]);
    const body = await res.json() as { results: Array<{ sessionName: string; ok: boolean; reason?: string }> };
    expect(body.results.find((r) => r.sessionName === "worker@test")).toMatchObject({ ok: true });
    expect(body.results.find((r) => r.sessionName === "sibling@test")).toMatchObject({ ok: false, reason: "caller_cancelled", inputPhase: "not_reached" });
  });
});

// Two cases from the independent review (review-r2's probes), plus the lease release and the Enter-only adapter check.
describe("independent review cancellation seams", () => {
  it("an Enter-only request cancelled during the staged-input capture presses nothing", async () => {
    const f = fixture();
    const caller = new AbortController();
    vi.spyOn(f.tmux, "capturePaneContent").mockImplementation(async () => { caller.abort(); return "Ready\n❯ WORK\n────────────────────\n"; });
    const res = await f.post("/send", { session: "worker@test", text: "", submitOnly: true, expectedStagedText: "WORK" }, caller.signal);
    expect(f.writes).toEqual([]);
    expect(await res.json()).toMatchObject({ reason: "caller_cancelled", sent: false, inputPhase: "not_reached" });
  });

  it.each([["guarded", true], ["unguarded", false]] as const)(
    "%s: an Enter-only request cancelled at the adapter's last pre-key check presses nothing", async (_label, guarded) => {
      const f = fixture({ guarded });
      const caller = new AbortController();
      vi.spyOn(f.tmux, "capturePaneContent").mockResolvedValue("Ready\n❯ WORK\n────────────────────\n");
      // Guarded: abort in the guard's input check, which only the adapter calls, right before its pre-key callback
      // (tmux.ts guardedInput), after every transport check; only that callback can stop it. Unguarded: the
      // copy-mode probe, the last await before the key.
      if (guarded) {
        const original = f.guard.checkInput.bind(f.guard);
        vi.spyOn(f.guard, "checkInput").mockImplementation((id: string) => { caller.abort(); return original(id); });
      } else vi.spyOn(f.tmux, "isPaneInMode").mockImplementation(async () => { caller.abort(); return false; });
      const result = await f.transport.send("worker@test", "", { submitOnly: true, expectedStagedText: "WORK", signal: caller.signal });
      expect(f.writes).toEqual([]);
      expect(result).toMatchObject({ reason: "caller_cancelled", sent: false, inputPhase: "not_reached" });
    });

  it("a cancel during the guarded second idle wait ends as caller_cancelled and releases the lease at once", async () => {
    const f = fixture();
    const caller = new AbortController();
    let observations = 0;
    (f.transport as never as { classifySendReadiness: unknown }).classifySendReadiness = async (input: { sessionName: string }) => {
      if (input.sessionName !== "worker@test") return { state: "idle", reason: "fixture", evidenceSource: "pane_heuristic", sampledAt: new Date().toISOString(), evidence: null };
      observations++;
      if (observations === 2) caller.abort();
      return { state: observations === 1 ? "idle" : "running", reason: "rewait fixture", evidenceSource: "pane_heuristic", sampledAt: new Date().toISOString(), evidence: null };
    };
    const started = Date.now();
    const res = await f.post("/send", { session: "worker@test", text: "WORK", waitForIdleMs: 3_000 }, caller.signal);
    expect(await res.json()).toMatchObject({ reason: "caller_cancelled", sent: false, inputPhase: "not_reached" });
    expect(Date.now() - started).toBeLessThan(1_500); // ended at the cancel, not at the 3 s budget
    // The lease is free: another operation on the seat runs at once.
    let ran = false;
    await Promise.race([f.guard.operation("worker@test", async () => { ran = true; }), new Promise((r) => setTimeout(r, 1_000))]);
    expect(ran).toBe(true);
    expect(f.writes).toEqual([]);
  });

  // From the independent QA pass (its pending-observation probe): the abort must not wait for a readiness read.
  it("an aborted guarded re-wait releases its lease while the readiness observation is still pending", async () => {
    const f = fixture();
    const caller = new AbortController();
    let entered!: () => void, finishObservation!: () => void;
    const atObservation = new Promise<void>(r => { entered = r; });
    const observationGate = new Promise<void>(r => { finishObservation = r; });
    let observations = 0;
    (f.transport as never as { classifySendReadiness: unknown }).classifySendReadiness = async () => {
      observations++;
      if (observations === 2) { entered(); await observationGate; }
      return { state: "idle", reason: "QA deferred observation", evidenceSource: "pane_heuristic", sampledAt: new Date().toISOString(), evidence: null };
    };
    const pending = f.post("/send", { session: "worker@test", text: "WORK", waitForIdleMs: 60_000 }, caller.signal)
      .then(async res => ({ status: res.status, result: await res.json() }));
    await atObservation;
    caller.abort();
    let followerRan = false;
    const follower = f.guard.operation("worker@test", async () => { followerRan = true; });
    const early = await Promise.race([Promise.all([pending, follower]).then(([done]) => done), settle(500).then(() => null)]);
    const followerBeforeRelease = followerRan;
    finishObservation();
    const done = await pending;
    await follower;
    console.log("QA R3 PENDING OBSERVATION", JSON.stringify({ early, followerBeforeRelease, done, followerRan, observations, writes: f.writes }));
    expect(done).toMatchObject({ status: 409, result: { reason: "caller_cancelled", sent: false, inputPhase: "not_reached" } });
    expect(f.writes).toEqual([]); // even the late idle answer must not type
    expect(early, "caller cancellation must not await a readiness read").not.toBeNull();
    expect(followerBeforeRelease, "following lease operation must not await that read").toBe(true);
  });

  it("pinned: the Enter after this request's own successful paste still ignores a later cancellation", async () => {
    const f = fixture({ guarded: false });
    const caller = new AbortController();
    f.hooks.paste = () => caller.abort();
    const result = await f.transport.send("worker@test", "WORK", { signal: caller.signal });
    expect(f.writes).toEqual(["paste:a:WORK", "keys:a:Enter"]);
    expect(result.reason).not.toBe("caller_cancelled");
  });
});

describe("what a caller's cancellation does not change", () => {
  it("managed preparation's own cancelled wait keeps its result", async () => {
    const f = fixture();
    f.activity["worker@test"] = "running";
    const prep = new AbortController(); prep.abort();
    expect(await f.transport.waitUntilIdle("worker@test", 1000, prep.signal)).toMatchObject({
      ok: false, reason: "preparation_cancelled", error: "Managed preparation ended; no compact authorized." });
  });

  it("a queue wake is not cancelled by a caller signal", async () => {
    const f = fixture({ guarded: false });
    const caller = new AbortController(); caller.abort();
    const result = await f.transport.send("worker@test", "WAKE", { queueWake: true, signal: caller.signal });
    expect(result).toMatchObject({ ok: true });
    expect(f.writes).toEqual(["paste:a:WAKE", "keys:a:Enter"]);
  });

  it("a caller that goes away while queued for the lease of a typing-guarded seat retains nothing", async () => {
    const f = fixture();
    await f.guard.set("a", { mode: "hold" }, "operator", "manual terminal");
    let release!: () => void; let entered!: () => void;
    const locked = new Promise<void>((r) => { entered = r; }); const gate = new Promise<void>((r) => { release = r; });
    // A held seat routes an operation to its retention callback; hold the lease through either.
    const hold = async () => { entered(); await gate; };
    const holder = f.guard.operation("worker@test", hold, hold);
    await locked;
    const op = vi.spyOn(f.guard, "operation");
    const caller = new AbortController();
    const pending = f.post("/send", { session: "worker@test", text: "HELD", deliveryId: "held-queued" }, caller.signal);
    await vi.waitFor(() => expect(op).toHaveBeenCalled());
    caller.abort(); release(); await holder;
    expect(await (await pending).json()).toMatchObject({ ok: false, sent: false, reason: "caller_cancelled", inputPhase: "not_reached" });
    expect(f.outbox.getById("held-queued")).toBeFalsy();
    expect(f.writes).toEqual([]);
  });

  it("a delivery the typing guard retained stays retained after the caller goes away", async () => {
    const f = fixture();
    await f.guard.set("a", { mode: "hold" }, "operator", "manual terminal");
    const caller = new AbortController();
    const res = await f.post("/send", { session: "worker@test", text: "HELD", deliveryId: "held-1" }, caller.signal);
    expect(await res.json()).toMatchObject({ ok: true, outcome: "retained" });
    caller.abort();
    await settle();
    expect(f.outbox.getById("held-1")).toMatchObject({ deliveryState: "retained" });
    expect(f.writes).toEqual([]);
  });
});
