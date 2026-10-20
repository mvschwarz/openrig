// QA additions, using the candidate fixture with command/file-cleanup recording.
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
  const writes: string[] = []; const commands: string[] = []; const unlinked: string[] = [];
  const hooks: { load?: () => void; paste?: () => void } = {};
  let staged = "";
  const tmux = new TmuxAdapter(async (command) => {
    commands.push(command);
    const node = command.includes("%2") || command.includes("sibling@test") ? "b" : "a";
    if (command.includes("load-buffer")) hooks.load?.();
    if (command.includes("paste-buffer")) { hooks.paste?.(); writes.push(`paste:${node}:${staged}`); }
    if (command.includes("send-keys")) writes.push(`keys:${node}:${command.includes("Enter") ? "Enter" : command}`);
    return "";
  }, { writeFile: async (_path, text) => { staged = text; }, unlink: async (path) => { unlinked.push(path); }, tmpName: () => "/fixture/input", bufferName: () => "input" });
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
  return { db, guard, tmux, transport, outbox, app, post, writes, hooks, activity, commands, unlinked };
}


describe("independent QA boundary cases", () => {
  it("pre-paste cancellation cleans up both the loaded tmux buffer and input file", async () => {
    const f = fixture(); const caller = new AbortController();
    f.hooks.load = () => caller.abort();
    const result = await f.transport.send("worker@test", "WORK", { signal: caller.signal });
    console.log("QA CLEANUP", JSON.stringify({result, commands:f.commands, unlinked:f.unlinked}));
    expect(result).toMatchObject({reason:"caller_cancelled",inputPhase:"not_reached",sent:false});
    expect(f.commands.filter(c => c.includes("paste-buffer"))).toEqual([]);
    expect(f.commands.filter(c => c.includes("delete-buffer"))).toHaveLength(1);
    expect(f.unlinked).toEqual(["/fixture/input"]);
  });
  it("an uncertain paste plus caller abort is still attempted, never not_reached", async () => {
    const f = fixture(); const caller = new AbortController();
    f.hooks.paste = () => { caller.abort(); throw new Error("injected loss of paste acknowledgement"); };
    const result = await f.transport.send("worker@test", "WORK", { signal: caller.signal });
    console.log("QA UNCERTAIN", JSON.stringify({result,commands:f.commands}));
    expect(f.commands.filter(c => c.includes("paste-buffer"))).toHaveLength(1);
    expect(result).toMatchObject({ok:false,inputPhase:"attempted"});
    expect(result.reason).not.toBe("caller_cancelled");
    expect(result.sent).not.toBe(false);
  });
  it("ordinary send aborted while queued for the lease never writes after release", async () => {
    const f = fixture(); let release!: () => void; let entered!: () => void;
    const locked = new Promise<void>(r => entered=r); const gate = new Promise<void>(r => release=r);
    const holder = f.guard.operation("worker@test",async()=> { entered(); await gate; });
    await locked;
    const op = vi.spyOn(f.guard,"operation"); const caller=new AbortController();
    const pending=f.post("/send",{session:"worker@test",text:"WORK"},caller.signal);
    await vi.waitFor(()=>expect(op).toHaveBeenCalled()); caller.abort(); release(); await holder;
    const response=await pending; const result=await response.json();
    console.log("QA OFF LEASE",JSON.stringify({status:response.status,result,writes:f.writes}));
    expect(f.writes).toEqual([]);
    expect(result).toMatchObject({reason:"caller_cancelled",inputPhase:"not_reached",sent:false});
  });
  it("a committed outbox delivery ignores a caller that was already aborted", async () => {
    const f=fixture(); const id="qa-committed";
    f.outbox.record({outboxId:id,senderSession:"human@test",destinationSession:"worker@test",body:"DURABLE"});
    const caller=new AbortController();caller.abort();
    const result=await f.transport.send("worker@test","DURABLE",{signal:caller.signal,committedOutboxIds:[id]});
    console.log("QA COMMITTED",JSON.stringify({result,writes:f.writes}));
    expect(result.ok).toBe(true); expect(f.writes).toEqual(["paste:a:DURABLE","keys:a:Enter"]);
  });
  it("readback of an already retained delivery stays retained with an aborted retry", async () => {
    const f=fixture();await f.guard.set("a",{mode:"hold"},"operator","QA hold");
    const opts={deliveryId:"qa-retained",actorSession:"human@test"};
    expect(await f.transport.send("worker@test","HELD",opts)).toMatchObject({outcome:"retained",sent:false});
    const caller=new AbortController();caller.abort();
    const result=await f.transport.send("worker@test","HELD",{...opts,signal:caller.signal});
    console.log("QA RETAINED RETRY",JSON.stringify({result,storedState:f.outbox.getById(opts.deliveryId)?.deliveryState,writes:f.writes}));
    expect(result).toMatchObject({outcome:"retained",sent:false});
    expect(f.writes).toEqual([]);
  });
});
