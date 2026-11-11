import { describe, it, expect } from "vitest";
import {
  REX_STATUS_MARKER,
  RexAgentStatusRelay,
  rexAgentStatus,
  rexStatusReport,
  type ResolveSeatActivity,
} from "../src/domain/terminal/rex-agent-status.js";
import type { AgentActivity, AgentActivityState } from "../src/domain/types.js";

const activity = (state: AgentActivityState, reason = "hook"): AgentActivity =>
  ({ state, reason, evidenceSource: "hook", sampledAt: "2026-11-11T00:00:00.000Z", evidence: null }) as AgentActivity;

const wrapped = (fields: string) => `\x1bPtmux;\x1b\x1b]7501;${fields}\x1b\x1b\\\x1b\\`;

function fakePanes(opts: { marked?: string[]; refuse?: string[] } = {}) {
  const options = new Map<string, string>();
  for (const seat of opts.marked ?? []) options.set(`${seat} ${REX_STATUS_MARKER}`, "on");
  const writes: Array<{ tty: string; text: string }> = [];
  const panes = {
    async getPaneLocalOption(target: string, option: string) { return options.get(`${target} ${option}`) ?? null; },
    async restorePaneOption(target: string, option: string, value: string | null) {
      if (opts.refuse?.includes(target)) return { ok: false };
      if (value === null) options.delete(`${target} ${option}`);
      else options.set(`${target} ${option}`, value);
      return { ok: true };
    },
    async getPaneTty(target: string) { return `/dev/tty-${target}`; },
  };
  const writeTty = async (tty: string, text: string) => { writes.push({ tty, text }); };
  return { panes, options, writes, writeTty };
}

function relayWith(f: ReturnType<typeof fakePanes>, seats: Record<string, { activity: AgentActivity | null; runtime: string | null }>) {
  const resolve: ResolveSeatActivity = (seat) => seats[seat] ?? { activity: null, runtime: null };
  return new RexAgentStatusRelay({ panes: f.panes, resolve, writeTty: f.writeTty });
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

  it("wraps the report for tmux passthrough, naming the runtime as the app", () => {
    expect(rexStatusReport({ state: "idle" }, "claude-code")).toBe(wrapped("state=idle:app=claude-code"));
    expect(rexStatusReport({ state: "blocked", kind: "permission" }, "codex")).toBe(wrapped("state=blocked:app=codex:kind=permission"));
    expect(rexStatusReport({ state: "clear" }, null)).toBe(wrapped("state=clear"));
    expect(rexStatusReport({ state: "working" }, null)).toBeNull();
  });
});

describe("rex agent status: relay", () => {
  it("marks each opened seat's pane, turns on passthrough, and writes its current state", async () => {
    const f = fakePanes();
    const relay = relayWith(f, { "op@kernel": { activity: activity("idle"), runtime: "claude-code" } });
    await relay.tilesOpened(["op@kernel"]);
    expect(f.options.get("op@kernel allow-passthrough")).toBe("on");
    expect(f.options.get(`op@kernel ${REX_STATUS_MARKER}`)).toBe("on");
    expect(f.writes).toEqual([{ tty: "/dev/tty-op@kernel", text: wrapped("state=idle:app=claude-code") }]);
  });

  it("writes nothing for a newly opened seat whose state is unknown", async () => {
    const f = fakePanes();
    await relayWith(f, { "op@kernel": { activity: activity("unknown"), runtime: "claude-code" } }).tilesOpened(["op@kernel"]);
    expect(f.writes).toEqual([]);
  });

  it("skips a seat whose pane refuses passthrough", async () => {
    const f = fakePanes({ refuse: ["op@kernel"] });
    await relayWith(f, { "op@kernel": { activity: activity("idle"), runtime: "claude-code" } }).tilesOpened(["op@kernel"]);
    expect(f.writes).toEqual([]);
  });

  it("writes a change only for a marked seat, once per change, and clears when the state becomes unknown", async () => {
    const f = fakePanes({ marked: ["op@kernel"] });
    const seats = {
      "op@kernel": { activity: activity("running"), runtime: "claude-code" },
      "other@kernel": { activity: activity("running"), runtime: "claude-code" },
    };
    const relay = relayWith(f, seats);
    await relay.activityChanged("op@kernel");
    await relay.activityChanged("op@kernel");
    await relay.activityChanged("other@kernel");
    seats["op@kernel"].activity = activity("unknown");
    await relay.activityChanged("op@kernel");
    expect(f.writes.map((w) => w.text)).toEqual([wrapped("state=working:app=claude-code"), wrapped("state=clear")]);
  });

  it("leaves the tile on the latest state after two quick changes", async () => {
    const f = fakePanes({ marked: ["op@kernel"] });
    const seat = { activity: activity("running"), runtime: "codex" };
    const relay = relayWith(f, { "op@kernel": seat });
    const first = relay.activityChanged("op@kernel");
    seat.activity = activity("idle");
    const second = relay.activityChanged("op@kernel");
    await Promise.all([first, second]);
    expect(f.writes.map((w) => w.text).at(-1)).toBe(wrapped("state=idle:app=codex"));
  });
});
