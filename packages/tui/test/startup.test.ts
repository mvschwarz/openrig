import { describe, it, expect, vi } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { StartupController, startupLines, type StartupSeat } from "../src/startup.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";

function fixture() {
  const seat: StartupSeat = { nodeId: "n1", logicalId: "operator.agent", runtime: "codex", model: "configured-model",
    revision: "rev1", hasHistory: true, intendedAction: "awaiting-decision", freshRequired: true, tokenState: "missing",
    reason: "No native history identity was recorded", observed: { state: "stopped", detail: "No terminal", sessionName: "operator-agent@kernel" } };
  const posts: Array<{ route: string; body: Record<string, string> }> = [];
  let response: (body: Record<string, string>) => Promise<Response> = async () => new Response(JSON.stringify({ ok: true }));
  let probeState = "up";
  const client = new DaemonClient({ baseUrl: "http://127.0.0.1:17433", headers: { Authorization: "Bearer test" },
    fetchImpl: (async (url, options) => {
      const route = new URL(String(url)).pathname;
      if (options?.method === "POST") { const body = JSON.parse(String(options.body)); posts.push({ route, body }); return response(body); }
      if (probeState === "down") throw new Error("connection refused");
      if (route === "/api/rigs/summary") return new Response(JSON.stringify([{ id: "r1", name: "kernel" }, { id: "bad", name: "unrelated-legacy" }]));
      return new Response(JSON.stringify({ rigId: "r1", rigName: "kernel", seats: [{ ...seat }] }));
    }) as typeof fetch,
  });
  const startDaemon = vi.fn(async () => { probeState = "up"; });
  const onWork = vi.fn();
  const onNative = vi.fn(async () => {});
  const controller = new StartupController({ client, home: "/private/instance", startDaemon, onWork, onNative, onChange: () => {},
    probe: async () => JSON.stringify(probeState === "down" ? { state: "down", discovery: { header: { lastActivityAt: null }, foundOnHost: [], whereWorkStopped: [] } } : { state: probeState }),
  });
  return { controller, seat, posts, startDaemon, onWork, onNative, response: (fn: typeof response) => { response = fn; }, down: () => { probeState = "down"; } };
}
async function chooseOperator(f: ReturnType<typeof fixture>) { await f.controller.refresh(); await f.controller.key("enter"); }

describe("TUI startup choices", () => {
  it("opens the existing native terminal and refreshes without a launch, then explicitly continues context", async () => {
    const f = fixture(); f.seat.observed.state = "attention_required"; f.seat.contextPending = true;
    await chooseOperator(f); await f.controller.key("o");
    expect(f.onNative).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "n1" }));
    expect(f.posts).toEqual([]);
    f.seat.observed.state = "running";
    await f.controller.key("c");
    expect(f.posts).toEqual([{ route: "/api/startup/r1/operator.agent", body: { action: "continue", revision: "rev1" } }]);
  });
  it("offers an explicit fresh choice for ambiguous history after positive absence", async () => {
    const f = fixture(); f.seat.intendedAction = "blocked"; f.seat.freshRequired = false; f.seat.freshAllowed = true;
    await chooseOperator(f); await f.controller.key("f");
    expect(f.controller.state.page).toBe("confirm");
    await f.controller.key("escape"); expect(f.posts).toEqual([]);
  });
  it("shows the current native gate and opens that existing seat without another launch", async () => {
    const f = fixture();
    f.seat.observed.state = "attention_required";
    f.seat.observed.detail = "Codex is waiting for hook trust approval";
    f.seat.freshAllowed = false;
    await chooseOperator(f);
    const text = startupLines(f.controller.state).map((line) => line.text).join("\n");
    expect(text).toContain("Codex is waiting for hook trust approval");
    expect(text).not.toContain("No native history identity was recorded");
    expect(text).not.toContain("Consider a fresh");
    await f.controller.key("enter");
    expect(f.posts).toEqual([]);
    expect(f.onWork).toHaveBeenCalledWith(expect.objectContaining({ rigId: "r1" }), expect.objectContaining({ nodeId: "n1" }));
  });
  it("makes terminal transport repair a separate action with no seat launch", async () => {
    const f = fixture();
    f.seat.observed.state = "transport_unavailable"; f.seat.freshAllowed = false;
    f.response(async () => {
      f.seat.observed.state = "stopped"; f.seat.freshAllowed = true;
      return new Response(JSON.stringify({ ok: true }));
    });
    await chooseOperator(f);
    await f.controller.key("f"); expect(f.controller.state.page).toBe("seats");
    await f.controller.key("t");
    expect(f.posts).toEqual([{ route: "/api/startup/terminal", body: {} }]);
    await f.controller.key("f"); expect(f.controller.state.page).toBe("confirm");
    await f.controller.key("escape"); expect(f.posts).toHaveLength(1);
  });
  it("first setup starts only the daemon, then presents deliberate rig choices", async () => {
    const f = fixture(); f.down(); await f.controller.refresh();
    expect(f.controller.state.page).toBe("down");
    await f.controller.key("enter");
    expect(f.startDaemon).toHaveBeenCalledTimes(1);
    expect(f.posts).toEqual([]);
    expect(f.controller.state.page).toBe("rigs");
  });
  it("decline and refresh invalidate fresh consent with no launch effect", async () => {
    const f = fixture(); await chooseOperator(f);
    await f.controller.key("f"); expect(f.controller.state.page).toBe("confirm");
    await f.controller.key("escape"); await f.controller.key("y");
    expect(f.posts).toEqual([]);
    await f.controller.key("f"); await f.controller.key("r"); await f.controller.key("y");
    expect(f.posts).toEqual([]);
  });
  it("shows fresh confirmation and decline on an 80x24 screen even with a long instance path", async () => {
    const f = fixture(); await chooseOperator(f); await f.controller.key("f");
    f.controller.state.home = "/long-instance".repeat(20);
    const screen = renderScreen(createViewState({ instanceId: "test" }).get(), emptySnapshot(), { cols: 80, rows: 24, startup: f.controller.state });
    expect(screen.lines.join("\n")).toContain("Confirm this fresh start");
    expect(screen.lines.join("\n")).toContain("Decline; leave stopped");
  });
  it("one confirmation sends the exact seat/revision once despite repeated input", async () => {
    const f = fixture(); await chooseOperator(f);
    let finish!: (value: Response) => void;
    f.response(() => new Promise((resolve) => { finish = resolve; }));
    await f.controller.key("f");
    const first = f.controller.key("y"); await Promise.resolve();
    await f.controller.key("y"); await f.controller.key("enter");
    expect(f.posts).toEqual([{ route: "/api/startup/r1/operator.agent", body: { action: "fresh", revision: "rev1" } }]);
    f.seat.observed.state = "running";
    finish(new Response(JSON.stringify({ ok: true })));
    await first;
    expect(f.controller.state.consent).toBeUndefined();
    expect(f.controller.state.notice).toContain("new conversation");
  });
  it("reports a gate observed after a successful producer return instead of repeating its success claim", async () => {
    const f = fixture();
    f.response(async () => {
      f.seat.observed = { ...f.seat.observed, state: "attention_required", detail: "Hook review needs a decision" };
      f.seat.freshAllowed = false;
      return new Response(JSON.stringify({ ok: true, message: "Previous conversation resumed." }));
    });
    await chooseOperator(f); await f.controller.key("enter");
    expect(f.controller.state.notice).toBe("Hook review needs a decision");
    expect(f.posts).toHaveLength(1);
  });
  it.each(["running", "attention_required"] as const)("#729: retains startup warnings after the %s refresh", async state => {
    const f = fixture();
    f.response(async () => {
      f.seat.observed.state = state;
      f.seat.observed.detail = "Current observed state";
      return new Response(JSON.stringify({ ok: true, message: "Launch returned", warnings: ["Startup submission unverified: capture unavailable"] }));
    });
    await chooseOperator(f); await f.controller.key("enter");
    expect(f.controller.state.notice).toContain("Startup submission unverified: capture unavailable");
    if (state === "attention_required") {
      expect(f.controller.state.notice).toContain("Current observed state");
      expect(f.controller.state.notice).not.toContain("Launch returned");
    }
    expect(f.posts).toHaveLength(1);
  });
  it("a lost launch response reads the actual effect and never repeats the POST", async () => {
    const f = fixture(); f.seat.intendedAction = "resume-original";
    f.response(async () => { f.seat.observed.state = "running"; f.seat.revision = "rev2"; throw new Error("response lost"); });
    await chooseOperator(f); await f.controller.key("enter");
    expect(f.posts).toHaveLength(1);
    await f.controller.key("enter");
    expect(f.posts).toHaveLength(1);
    expect(f.onWork).toHaveBeenCalledTimes(1);
  });
  it("provider failure is visible and does not offer fresh as its cure", async () => {
    const f = fixture();
    f.response(async () => {
      f.seat.freshAllowed = false;
      f.seat.prerequisite = "Codex authentication is unavailable";
      return new Response(JSON.stringify({ ok: false, code: "provider_prerequisite", freshAllowed: false, message: f.seat.prerequisite }), { status: 409 });
    });
    await chooseOperator(f); await f.controller.key("enter"); await f.controller.key("f");
    expect(f.controller.state.page).toBe("seats");
    expect(startupLines(f.controller.state).map((line) => line.text).join("\n")).not.toContain("Consider a fresh");
    await f.controller.key("up"); await f.controller.key("r"); await f.controller.key("f");
    expect(f.controller.state.page).toBe("seats");
    expect(startupLines(f.controller.state).map((line) => line.text).join("\n")).toContain("authentication is unavailable");
    f.seat.freshAllowed = true; f.seat.prerequisite = undefined;
    await f.controller.key("r"); await f.controller.key("f");
    expect(f.controller.state.page).toBe("confirm");
  });
  it("renders the actual selected seat and a mouse action in the ordinary shell", async () => {
    const f = fixture(); await chooseOperator(f);
    const snap = emptySnapshot(); const view = createViewState({ instanceId: "test", getSnapshot: () => snap });
    const screen = renderScreen(view.get(), snap, { cols: 100, rows: 32, startup: f.controller.state });
    expect(screen.lines.join("\n")).toContain("operator.agent");
    expect(screen.lines.join("\n")).toContain("configured-model");
    expect(screen.hitMap.some((hit) => hit.action.type === "startup" && hit.action.key === "f")).toBe(true);
  });
});
