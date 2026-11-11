import { describe, it, expect } from "vitest";
import {
  REX_CLIENT_RECHECK_MS,
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

function fakeTmux(clients: Record<string, Array<{ tty: string; termtype: string }> | null>) {
  const writes: Array<{ tty: string; text: string }> = [];
  let listings = 0;
  const tmux = {
    async listSessionClientTerminals(session: string) { listings++; return session in clients ? clients[session] : []; },
  };
  const writeTty = async (tty: string, text: string) => { writes.push({ tty, text }); };
  return { tmux, writes, writeTty, listings: () => listings };
}

function relayWith(f: ReturnType<typeof fakeTmux>, seats: Record<string, SeatActivity>) {
  return new RexAgentStatusRelay({ clients: f.tmux, resolve: (seat) => seats[seat] ?? { activity: null, runtime: null }, writeTty: f.writeTty });
}

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
    expect(rexStatusReport({ state: "working" }, null)).toBeNull();
  });
});

describe("rex agent status: relay", () => {
  it("writes an opened seat's current state to its Rex clients only", async () => {
    const f = fakeTmux({ "op@kernel": [{ tty: "/dev/ttys1", termtype: REX }, { tty: "/dev/ttys2", termtype: "iTerm2 3.6" }, { tty: "/dev/ttys3", termtype: "" }] });
    await relayWith(f, { "op@kernel": { activity: activity("idle"), runtime: "claude-code" } }).tilesOpened(["op@kernel"]);
    expect(f.writes).toEqual([{ tty: "/dev/ttys1", text: osc("state=idle:app=claude-code") }]);
  });

  it("writes nothing for a newly opened seat whose state is unknown", async () => {
    const f = fakeTmux({ "op@kernel": [{ tty: "/dev/ttys1", termtype: REX }] });
    await relayWith(f, { "op@kernel": { activity: activity("unknown"), runtime: "claude-code" } }).tilesOpened(["op@kernel"]);
    expect(f.writes).toEqual([]);
  });

  it("writes each change once, uses the caller's reading, and clears when the state becomes unknown", async () => {
    const f = fakeTmux({ "op@kernel": [{ tty: "/dev/ttys1", termtype: REX }] });
    const relay = relayWith(f, {});
    await relay.activityChanged("op@kernel", { activity: activity("running"), runtime: "claude-code" });
    await relay.activityChanged("op@kernel", { activity: activity("running"), runtime: "claude-code" });
    await relay.activityChanged("op@kernel", { activity: activity("unknown"), runtime: "claude-code" });
    expect(f.writes.map((w) => w.text)).toEqual([osc("state=working:app=claude-code"), osc("state=clear")]);
  });

  it("looks for Rex clients on a seat without one again only after a Rex view opens it or the recheck time passes", async () => {
    const clients: Record<string, Array<{ tty: string; termtype: string }> | null> = { "dev@r": [] };
    const f = fakeTmux(clients);
    let now = 0;
    const seats = { "dev@r": { activity: activity("running"), runtime: "codex" } };
    const relay = new RexAgentStatusRelay({ clients: f.tmux, resolve: (seat) => seats[seat as "dev@r"], writeTty: f.writeTty, now: () => now });
    await relay.activityChanged("dev@r");
    seats["dev@r"].activity = activity("idle");
    await relay.activityChanged("dev@r");
    expect(f.listings()).toBe(1);
    clients["dev@r"] = [{ tty: "/dev/ttys9", termtype: REX }];
    now = REX_CLIENT_RECHECK_MS;
    await relay.activityChanged("dev@r");
    expect(f.writes).toEqual([{ tty: "/dev/ttys9", text: osc("state=idle:app=codex") }]);
    clients["dev@r"] = [];
    seats["dev@r"].activity = activity("running");
    await relay.activityChanged("dev@r");
    clients["dev@r"] = [{ tty: "/dev/ttys9", termtype: REX }];
    await relay.tilesOpened(["dev@r"]);
    expect(f.writes.at(-1)).toEqual({ tty: "/dev/ttys9", text: osc("state=working:app=codex") });
  });

  it("keeps updating an open tile after tmux couldn't be read once", async () => {
    const clients: Record<string, Array<{ tty: string; termtype: string }> | null> = { "op@kernel": null };
    const f = fakeTmux(clients);
    const relay = relayWith(f, {});
    await relay.activityChanged("op@kernel", { activity: activity("running"), runtime: "claude-code" });
    clients["op@kernel"] = [{ tty: "/dev/ttys1", termtype: REX }];
    await relay.activityChanged("op@kernel", { activity: activity("running"), runtime: "claude-code" });
    expect(f.writes.map((w) => w.text)).toEqual([osc("state=working:app=claude-code")]);
  });

  it("writes again to every Rex client when one of them missed the last report", async () => {
    const f = fakeTmux({ "op@kernel": [{ tty: "/dev/ttys1", termtype: REX }, { tty: "/dev/ttys2", termtype: REX }] });
    let failNext = true;
    const relay = new RexAgentStatusRelay({
      clients: f.tmux,
      resolve: () => ({ activity: activity("running"), runtime: "claude-code" }),
      writeTty: async (tty, text) => { if (tty === "/dev/ttys2" && failNext) { failNext = false; throw new Error("EAGAIN"); } f.writes.push({ tty, text }); },
    });
    await relay.activityChanged("op@kernel");
    await relay.activityChanged("op@kernel");
    expect(f.writes.map((w) => w.tty)).toEqual(["/dev/ttys1", "/dev/ttys1", "/dev/ttys2"]);
  });

  it("retries a report no Rex client took on the next activity reading", async () => {
    const f = fakeTmux({ "op@kernel": [{ tty: "/dev/ttys1", termtype: REX }] });
    let attempts = 0;
    const relay = new RexAgentStatusRelay({
      clients: f.tmux,
      resolve: () => ({ activity: activity("running"), runtime: "claude-code" }),
      writeTty: async (tty, text) => { if (attempts++ === 0) throw new Error("EAGAIN"); f.writes.push({ tty, text }); },
    });
    await relay.activityChanged("op@kernel");
    expect(f.writes).toEqual([]);
    await relay.activityChanged("op@kernel");
    expect(f.writes.map((w) => w.text)).toEqual([osc("state=working:app=claude-code")]);
  });

  it("leaves the tile on the latest state after two quick changes", async () => {
    const f = fakeTmux({ "op@kernel": [{ tty: "/dev/ttys1", termtype: REX }] });
    const relay = relayWith(f, {});
    await Promise.all([
      relay.activityChanged("op@kernel", { activity: activity("running"), runtime: "codex" }),
      relay.activityChanged("op@kernel", { activity: activity("idle"), runtime: "codex" }),
    ]);
    expect(f.writes.map((w) => w.text)).toEqual([osc("state=working:app=codex"), osc("state=idle:app=codex")]);
  });
});
