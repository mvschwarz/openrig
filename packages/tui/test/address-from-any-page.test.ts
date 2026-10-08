// Slice 07 finding 6: on a page that reads no rigs, a topology address switches
// to Topology and resolves once Topology's own read settles. "no such rig" is
// only said when that read really lacks the rig.
import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createLiveRefresh } from "../src/live.js";
import { pageReadKey } from "../src/page-read.js";
import { resolvePendingAddress } from "../src/pending-address.js";
import { renderScreen } from "../src/render.js";
import { createControlSocket, type ControlSocket } from "../src/socket-server.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import type { FleetSnapshot } from "../src/types.js";

const rigs = [
  { id: "r-kernel", name: "kernel", lifecycleState: "running" },
  { id: "r-workshop", name: "workshop", lifecycleState: "running" },
];
const seat = {
  nodeId: "n-build", rigId: "r-workshop", rigName: "workshop", logicalId: "dev.build", podId: "p-dev", podNamespace: "dev",
  role: "builder", canonicalSessionName: "dev-build@workshop", nodeKind: "agent", runtime: "claude-code",
  sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a", oriented: "verified",
  terminalActive: false, lastActivityAt: null,
  lifecycleState: "running", occupantLifecycle: "active", continuityOutcome: null, handoverResult: null,
  previousOccupant: null, handoverAt: null, tmuxAttachCommand: null, resumeCommand: null,
  recoveryGuidance: null, latestError: null, model: null, agentRef: "builder", profile: "default",
  resolvedSpecName: "builder", resolvedSpecVersion: null, resolvedSpecHash: null, cwd: "/repo",
  restorePolicy: null, resumeType: null, resumeToken: null, startupCompletedAt: null,
  hasAssignedWork: false, pendingWorkCount: 0,
};

function daemon(calls: string[] = [], summaryStatus?: number) {
  return new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (input) => {
    const u = new URL(String(input)); calls.push(u.pathname);
    if (u.pathname === "/healthz") return Response.json({ selfHostId: "fixture" });
    if (u.pathname === "/api/rigs/summary") return summaryStatus ? Response.json({ error: "busy" }, { status: summaryStatus }) : Response.json(rigs);
    if (u.pathname === "/api/terminal/views") return Response.json({ saved: [], rigs: rigs.map((r) => r.name) });
    if (u.pathname === "/api/rigs/r-workshop/nodes") return Response.json([seat]);
    if (u.pathname.endsWith("/nodes") || u.pathname === "/api/queue/recent-transitions") return Response.json([]);
    return Response.json({}, { status: 404 });
  }) as typeof fetch });
}

/** A view on `section` whose snapshot is that page's real read. */
async function viewOn(section: string, client = daemon()) {
  let snap: FleetSnapshot = emptySnapshot();
  const view = createViewState({ instanceId: "kernel", getSnapshot: () => snap });
  if (section !== "topology") view.dispatch({ type: "jump", section });
  snap = await hydrateSnapshot(client, undefined, null, null, null, view.get());
  return { view, client, read: async () => { snap = await hydrateSnapshot(client, undefined, null, null, null, view.get()); } };
}

const drillOf = (state: { drill: { kind: string; name: string }[] }) => state.drill.map((d) => `${d.kind}:${d.name}`);

describe("a topology address typed on a page that reads no rigs", () => {
  it.each(["terminals", "needs", "system", "config", "specs"])("from %s, `rig workshop` switches to Topology, then resolves to the running rig", async (section) => {
    const { view, read } = await viewOn(section);
    view.dispatch(parseCommand("rig workshop", view.get().sections));
    expect(view.get()).toMatchObject({ section: "topology", drill: [], lastError: null, pendingDrill: { resource: "rig", name: "workshop" } });
    expect(renderScreen(view.get(), emptySnapshot()).lines.join("\n")).toContain('resolving rig "workshop"');
    await read();
    view.dispatch({ type: "resolve-pending" });
    expect(view.get().lastError).toBeNull();
    expect(view.get().pendingDrill).toBeNull();
    expect(drillOf(view.get())).toEqual(["host:fixture", "rig:workshop"]);
  });

  it.each([
    ["host fixture", ["host:fixture"]],
    ["pod dev", ["host:fixture", "rig:workshop", "pod:dev"]],
    ["agent dev.build", ["host:fixture", "rig:workshop", "pod:dev", "agent:dev.build"]],
    ["agent dev-build@workshop", ["host:fixture", "rig:workshop", "pod:dev", "agent:dev.build"]],
  ])("from Terminals, `%s` resolves too (pod and agent read every rig's seats)", async (command, drill) => {
    const calls: string[] = [];
    const { view, read } = await viewOn("terminals", daemon(calls));
    view.dispatch(parseCommand(command, view.get().sections));
    expect(view.get().pendingDrill).toBeTruthy();
    calls.length = 0;
    await read();
    if (command.startsWith("pod") || command.startsWith("agent")) expect(calls).toContain("/api/rigs/r-workshop/nodes");
    view.dispatch({ type: "resolve-pending" });
    expect(view.get().lastError).toBeNull();
    expect(drillOf(view.get())).toEqual(drill);
  });

  it("says no such rig only after Topology's read lacks it", async () => {
    const { view, read } = await viewOn("terminals");
    view.dispatch(parseCommand("rig ghost", view.get().sections));
    expect(view.get().lastError).toBeNull();
    await read();
    view.dispatch({ type: "resolve-pending" });
    expect(view.get()).toMatchObject({ section: "topology", drill: [], pendingDrill: null, lastError: 'no such rig "ghost"' });
  });

  it("a failed Topology read reports the rig as unconfirmed, not absent", async () => {
    const { view, read } = await viewOn("terminals", daemon([], 503));
    view.dispatch(parseCommand("rig workshop", view.get().sections));
    await read();
    view.dispatch({ type: "resolve-pending" });
    expect(view.get().lastError).toMatch(/^could not confirm rig "workshop": rigs-summary: daemon read failed: GET \/api\/rigs\/summary → 503/);
  });

  it("control: on Topology with rigs read, an unknown rig still errors at once", async () => {
    const { view } = await viewOn("topology");
    view.dispatch(parseCommand("rig ghost", view.get().sections));
    expect(view.get().lastError).toBe('no such rig "ghost"');
    expect(view.get().pendingDrill).toBeFalsy();
  });

  it("leaving the Topology landing cancels the pending address", async () => {
    const { view, read } = await viewOn("terminals");
    view.dispatch(parseCommand("rig workshop", view.get().sections));
    view.dispatch({ type: "jump", section: "needs" });
    expect(view.get().pendingDrill).toBeNull();
    await read();
    view.dispatch({ type: "resolve-pending" });
    expect(view.get()).toMatchObject({ section: "needs", drill: [], lastError: null });
  });

  it("Back from the resolved rig returns to the page where the address was typed", async () => {
    const { view, read } = await viewOn("terminals");
    view.dispatch(parseCommand("rig workshop", view.get().sections));
    await read();
    view.dispatch({ type: "resolve-pending" });
    view.dispatch({ type: "back" });
    expect(view.get().section).toBe("terminals");
  });

  it("every request gets its own page read", async () => {
    const { view } = await viewOn("terminals");
    view.dispatch(parseCommand("rig workshop", view.get().sections));
    const first = pageReadKey(view.get());
    view.dispatch({ type: "jump", section: "terminals" });
    view.dispatch(parseCommand("rig workshop", view.get().sections));
    expect(pageReadKey(view.get())).not.toBe(first);
    // Any explicit navigation, even to the same landing, drops the address.
    view.dispatch({ type: "jump", section: "topology" });
    expect(view.get().pendingDrill).toBeNull();
    expect(pageReadKey(view.get())).not.toBe(first);
  });
});

describe("the live read decides when a pending address resolves", () => {
  it("resolves only after the Topology read it opened settles", async () => {
    const client = daemon();
    let view = createViewState({ instanceId: "kernel" });
    const live = createLiveRefresh({ scopeKey: () => pageReadKey(view.get()), now: () => 0, onFrame: () => {},
      hydrate: (page, signal) => hydrateSnapshot(client.forPage(page, signal), undefined, null, null, null, view.get()) });
    view = createViewState({ instanceId: "kernel", getSnapshot: () => live.snapshot() });
    view.dispatch({ type: "jump", section: "terminals" });
    await live.refresh();
    view.dispatch(parseCommand("rig workshop", view.get().sections));
    expect(resolvePendingAddress(view, live.load())).toBe(false);
    expect(view.get().pendingDrill).toBeTruthy();
    await live.refresh();
    expect(resolvePendingAddress(view, live.load())).toBe(true);
    expect(view.get().lastError).toBeNull();
    expect(drillOf(view.get())).toEqual(["host:fixture", "rig:workshop"]);
    live.close();
  });

  it("with no live read coming, resolves at once and says why it could not confirm", () => {
    const view = createViewState({ instanceId: "kernel", getSnapshot: () => ({ ...emptySnapshot(), readErrors: ["Live data not loaded"] }) });
    view.dispatch({ type: "jump", section: "terminals" });
    view.dispatch(parseCommand("rig workshop", view.get().sections));
    expect(resolvePendingAddress(view, null)).toBe(true);
    expect(view.get().lastError).toBe('could not confirm rig "workshop": Live data not loaded');
  });
});

describe("the control socket does not report a pending address as done", () => {
  let open: ControlSocket | null = null;
  afterEach(async () => { if (open) await open.close(); open = null; });

  function ask(sockPath: string, lines: string[]): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const conn = net.createConnection({ path: sockPath });
      let buf = "";
      conn.on("data", (d) => {
        buf += d.toString("utf8");
        if (buf.split("\n").filter(Boolean).length >= lines.length) { conn.end(); resolve(buf.split("\n").filter(Boolean)); }
      });
      conn.on("error", reject);
      conn.on("connect", () => conn.write(lines.map((l) => l + "\n").join("")));
    });
  }

  it("replies that it switched to Topology and is resolving; state then reports the result", async () => {
    const { view, read } = await viewOn("terminals");
    open = await createControlSocket({ socketPath: path.join(os.tmpdir(), `tui-a-${process.pid}-${Math.floor(Math.random() * 1e6)}.sock`), view });
    const [reply, state] = (await ask(open.path, ["rig workshop", "state"])).map((line) => JSON.parse(line));
    expect(reply).toMatchObject({ screen: "topology", resolving: "rig workshop" });
    expect(reply.notice).toMatch(/^Switched to Topology; resolving rig "workshop" once its read settles\. Send "state" for the result\./);
    expect(state.state).toMatchObject({ resolving: "rig workshop", drill: [] });
    await read();
    view.dispatch({ type: "resolve-pending" });
    const [after] = (await ask(open.path, ["state"])).map((line) => JSON.parse(line));
    expect(after.state).toMatchObject({ ok: true, drill: ["host:fixture", "rig:workshop"] });
    expect(after.state.resolving).toBeUndefined();
  });
});
