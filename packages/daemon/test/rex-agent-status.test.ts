import { describe, it, expect, vi } from "vitest";
import {
  REX_CLIENT_RECHECK_MS,
  REX_CLIENT_REFRESH_MS,
  RexAgentStatusRelay,
  rexAgentStatus,
  rexStatusReport,
  type SeatActivity,
} from "../src/domain/terminal/rex-agent-status.js";
import type { AgentActivity, AgentActivityState } from "../src/domain/types.js";

const activity = (state: AgentActivityState, reason = "hook"): AgentActivity =>
  ({ state, reason, evidenceSource: "hook", sampledAt: "2026-11-11T00:00:00.000Z", evidence: null }) as AgentActivity;

const osc = (fields: string) => `\x1b]7501;${fields}\x1b\\`;
const REX = "rex 0.0.1793890641-gaf0c20";

type Clients = Record<string, Array<{ tty: string; termtype: string }> | null>;

/** A tmux with the given clients per seat, a clock, and terminals that can be told to refuse writes. */
function rig(clients: Clients, seats: Record<string, SeatActivity> = {}) {
  const writes: Array<{ tty: string; text: string }> = [];
  const refusing = new Set<string>();
  /** Terminals whose next write goes out only partly, with how many bytes. */
  const partial = new Map<string, number>();
  let listings = 0;
  const clock = { now: 0 };
  const relay = new RexAgentStatusRelay({
    clients: { async listSessionClientTerminals(session) { listings++; return session in clients ? clients[session]! : []; } },
    resolve: (seat) => seats[seat] ?? { activity: null, runtime: null },
    writeTty: async (tty, text) => {
      if (refusing.has(tty)) throw new Error("EAGAIN");
      const n = partial.get(tty);
      if (n !== undefined) { partial.delete(tty); writes.push({ tty, text: text.slice(0, n) }); return n; }
      writes.push({ tty, text });
      return Buffer.byteLength(text);
    },
    now: () => clock.now,
    sweep: false,
  });
  const to = (tty: string) => writes.filter((w) => w.tty === tty).map((w) => w.text);
  return { relay, writes, refusing, partial, clock, to, listings: () => listings };
}

const at = (state: AgentActivityState, runtime = "claude-code", reason?: string): SeatActivity => ({ activity: activity(state, reason), runtime });
const rex = (tty: string) => ({ tty, termtype: REX });

describe("rex agent status: mapping", () => {
  it("maps running, idle and needs_input, and keeps unknown as a clear rather than idle", () => {
    expect(rexAgentStatus(activity("running"))).toEqual({ state: "working" });
    expect(rexAgentStatus(activity("idle"))).toEqual({ state: "idle" });
    expect(rexAgentStatus(activity("needs_input", "permission_prompt"))).toEqual({ state: "blocked", kind: "permission" });
    expect(rexAgentStatus(activity("needs_input", "selection_prompt"))).toEqual({ state: "blocked" });
    expect(rexAgentStatus(activity("unknown"))).toEqual({ state: "clear" });
    expect(rexAgentStatus(null)).toEqual({ state: "clear" });
  });

  it("names the runtime as the app", () => {
    expect(rexStatusReport({ state: "idle" }, "claude-code")).toBe(osc("state=idle:app=claude-code"));
    expect(rexStatusReport({ state: "blocked", kind: "permission" }, "codex")).toBe(osc("state=blocked:app=codex:kind=permission"));
    expect(rexStatusReport({ state: "clear" }, null)).toBe(osc("state=clear"));
    expect(rexStatusReport({ state: "working" }, null)).toBe(osc("state=clear"));
  });
});

describe("rex agent status: relay", () => {
  it("writes an opened seat's current state to its Rex clients only", async () => {
    const r = rig({ "op@k": [rex("/dev/t1"), { tty: "/dev/t2", termtype: "iTerm2 3.6" }, { tty: "/dev/t3", termtype: "" }] }, { "op@k": at("idle") });
    await r.relay.tilesOpened(["op@k"]);
    expect(r.writes).toEqual([{ tty: "/dev/t1", text: osc("state=idle:app=claude-code") }]);
  });

  it("clears a tile after a daemon restart when the activity is now unknown, so it doesn't keep showing idle", async () => {
    const clients: Clients = { "op@k": [rex("/dev/t1")] };
    const before = rig(clients, { "op@k": at("idle") });
    await before.relay.tilesOpened(["op@k"]);
    expect(before.to("/dev/t1")).toEqual([osc("state=idle:app=claude-code")]);
    const after = rig(clients, { "op@k": at("unknown") });
    await after.relay.activityChanged("op@k");
    expect(after.to("/dev/t1")).toEqual([osc("state=clear")]);
  });

  it("gives a client that moved to another seat that seat's state, a clear included", async () => {
    const clients: Clients = { "a@k": [rex("/dev/t1")], "b@k": [] };
    const r = rig(clients, { "b@k": at("unknown") });
    await r.relay.activityChanged("a@k", at("running"));
    clients["a@k"] = [];
    clients["b@k"] = [rex("/dev/t1")];
    await r.relay.tilesOpened(["b@k"]);
    expect(r.to("/dev/t1")).toEqual([osc("state=working:app=claude-code"), osc("state=clear")]);
  });

  it("sends a seat's state again to a client that moved to another seat and back before the seat's next listing", async () => {
    const clients: Clients = { "a@k": [rex("/dev/t1")], "b@k": [] };
    const r = rig(clients);
    await r.relay.activityChanged("a@k", at("running"));
    clients["a@k"] = [];
    clients["b@k"] = [rex("/dev/t1")];
    await r.relay.activityChanged("b@k", at("idle"));
    clients["a@k"] = [rex("/dev/t1")];
    clients["b@k"] = [];
    await r.relay.activityChanged("a@k", at("running"));
    expect(r.to("/dev/t1")).toEqual([osc("state=working:app=claude-code"), osc("state=idle:app=claude-code"), osc("state=working:app=claude-code")]);
  });

  it("doesn't start sweeping when a report finishes after stop()", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const setInterval = vi.spyOn(globalThis, "setInterval");
    try {
      const relay = new RexAgentStatusRelay({
        clients: { async listSessionClientTerminals() { await gate; return [rex("/dev/t1")]; } },
        resolve: () => at("idle"),
        writeTty: async (_tty, text) => Buffer.byteLength(text),
      });
      const inFlight = relay.activityChanged("op@k");
      relay.stop();
      release();
      await inFlight;
      expect(setInterval).not.toHaveBeenCalled();
    } finally {
      setInterval.mockRestore();
    }
  });

  it("starts the next write with ST after a partial one, so the terminal isn't left inside the report", async () => {
    const r = rig({ "op@k": [rex("/dev/t1")] });
    r.partial.set("/dev/t1", 5);
    await r.relay.activityChanged("op@k", at("running"));
    await r.relay.activityChanged("op@k", at("running"));
    await r.relay.activityChanged("op@k", at("idle"));
    expect(r.to("/dev/t1")).toEqual([
      osc("state=working:app=claude-code").slice(0, 5),
      "\x1b\\" + osc("state=working:app=claude-code"),
      osc("state=idle:app=claude-code"),
    ]);
  });

  it("writes each change once, without listing clients again for an unchanged report, and clears on unknown", async () => {
    const r = rig({ "op@k": [rex("/dev/t1")] });
    await r.relay.activityChanged("op@k", at("running"));
    await r.relay.activityChanged("op@k", at("running"));
    expect(r.listings()).toBe(1);
    await r.relay.activityChanged("op@k", at("unknown"));
    expect(r.to("/dev/t1")).toEqual([osc("state=working:app=claude-code"), osc("state=clear")]);
  });

  it("brings back a client that missed a change when the seat returns to the state it had", async () => {
    const r = rig({ "op@k": [rex("/dev/t1"), rex("/dev/t2")] });
    await r.relay.activityChanged("op@k", at("idle"));
    r.refusing.add("/dev/t2");
    await r.relay.activityChanged("op@k", at("running"));
    r.refusing.clear();
    await r.relay.activityChanged("op@k", at("idle"));
    expect(r.to("/dev/t1").at(-1)).toBe(osc("state=idle:app=claude-code"));
    expect(r.to("/dev/t2").at(-1)).toBe(osc("state=idle:app=claude-code"));
  });

  it("clears a client whose last write failed when the state becomes unknown", async () => {
    const r = rig({ "op@k": [rex("/dev/t1")] });
    await r.relay.activityChanged("op@k", at("idle"));
    r.refusing.add("/dev/t1");
    await r.relay.activityChanged("op@k", at("running"));
    r.refusing.clear();
    await r.relay.activityChanged("op@k", at("unknown"));
    expect(r.to("/dev/t1").at(-1)).toBe(osc("state=clear"));
  });

  it("retries a missed report on the sweep, with no activity change", async () => {
    const seats = { "op@k": at("running") };
    const r = rig({ "op@k": [rex("/dev/t1")] }, seats);
    r.refusing.add("/dev/t1");
    await r.relay.activityChanged("op@k");
    r.refusing.clear();
    r.clock.now = REX_CLIENT_REFRESH_MS;
    await r.relay.sweep();
    expect(r.to("/dev/t1")).toEqual([osc("state=working:app=claude-code")]);
  });

  it("reaches a client that replaced the old one while the state stayed the same", async () => {
    const clients: Clients = { "op@k": [rex("/dev/t1")] };
    const r = rig(clients, { "op@k": at("idle") });
    await r.relay.activityChanged("op@k");
    clients["op@k"] = [rex("/dev/t2")];
    await r.relay.activityChanged("op@k");
    expect(r.to("/dev/t2")).toEqual([]);
    r.clock.now = REX_CLIENT_REFRESH_MS;
    await r.relay.sweep();
    expect(r.to("/dev/t2")).toEqual([osc("state=idle:app=claude-code")]);
  });

  it("sends the state to a tile that opens while a report for the seat is still in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const clients: Clients = { "op@k": [rex("/dev/t1")] };
    const writes: string[] = [];
    let first = true;
    const relay = new RexAgentStatusRelay({
      clients: { async listSessionClientTerminals(s) { if (first) { first = false; await gate; } return clients[s]!; } },
      resolve: () => at("idle"),
      writeTty: async (tty, text) => { writes.push(tty); return Buffer.byteLength(text); },
      sweep: false,
    });
    const inFlight = relay.activityChanged("op@k");
    const opening = relay.tilesOpened(["op@k"]);
    release();
    await Promise.all([inFlight, opening]);
    expect(writes).toEqual(["/dev/t1", "/dev/t1"]);
  });

  it("looks for Rex clients on a seat without one again only after a Rex view opens it or the recheck time passes", async () => {
    const clients: Clients = { "dev@r": [] };
    const seats = { "dev@r": at("running", "codex") };
    const r = rig(clients, seats);
    await r.relay.activityChanged("dev@r");
    seats["dev@r"] = at("idle", "codex");
    await r.relay.activityChanged("dev@r");
    await r.relay.sweep();
    expect(r.listings()).toBe(1);
    clients["dev@r"] = [rex("/dev/t9")];
    r.clock.now = REX_CLIENT_RECHECK_MS;
    await r.relay.sweep();
    expect(r.to("/dev/t9")).toEqual([osc("state=idle:app=codex")]);
    clients["dev@r"] = [];
    seats["dev@r"] = at("running", "codex");
    r.clock.now += REX_CLIENT_REFRESH_MS;
    await r.relay.activityChanged("dev@r");
    clients["dev@r"] = [rex("/dev/t9")];
    await r.relay.tilesOpened(["dev@r"]);
    expect(r.to("/dev/t9").at(-1)).toBe(osc("state=working:app=codex"));
  });

  it("keeps updating an open tile after tmux couldn't be read once", async () => {
    const clients: Clients = { "op@k": null };
    const r = rig(clients);
    await r.relay.activityChanged("op@k", at("running"));
    clients["op@k"] = [rex("/dev/t1")];
    await r.relay.activityChanged("op@k", at("running"));
    expect(r.to("/dev/t1")).toEqual([osc("state=working:app=claude-code")]);
  });

  it("clears a delivered state when the seat's runtime is no longer known", async () => {
    const r = rig({ "op@k": [rex("/dev/t1")] });
    await r.relay.activityChanged("op@k", at("idle"));
    await r.relay.activityChanged("op@k", { activity: activity("idle"), runtime: null });
    expect(r.to("/dev/t1")).toEqual([osc("state=idle:app=claude-code"), osc("state=clear")]);
  });

  it("recovers through the sweep when the seat's first tmux listing fails", async () => {
    const clients: Clients = { "op@k": null };
    const r = rig(clients, { "op@k": at("running") });
    await r.relay.activityChanged("op@k");
    clients["op@k"] = [rex("/dev/t1")];
    r.clock.now = REX_CLIENT_REFRESH_MS;
    await r.relay.sweep();
    expect(r.to("/dev/t1")).toEqual([osc("state=working:app=claude-code")]);
  });

  it("retries on the next sweep when a Rex view opens a seat found without a client and tmux can't be read", async () => {
    const clients: Clients = { "op@k": [] };
    const r = rig(clients, { "op@k": at("running") });
    await r.relay.activityChanged("op@k");
    clients["op@k"] = null;
    await r.relay.tilesOpened(["op@k"]);
    clients["op@k"] = [rex("/dev/t1")];
    r.clock.now = REX_CLIENT_REFRESH_MS;
    await r.relay.sweep();
    expect(r.to("/dev/t1")).toEqual([osc("state=working:app=claude-code")]);
  });

  it("delivers two quick changes in order", async () => {
    const r = rig({ "op@k": [rex("/dev/t1")] });
    await Promise.all([r.relay.activityChanged("op@k", at("running", "codex")), r.relay.activityChanged("op@k", at("idle", "codex"))]);
    expect(r.to("/dev/t1")).toEqual([osc("state=working:app=codex"), osc("state=idle:app=codex")]);
  });
});
