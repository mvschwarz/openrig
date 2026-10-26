import { describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { parseCommand } from "../src/grammar.js";
import type { FleetSnapshot, RecentTransitionSnap } from "../src/types.js";

// #2049: a registered remote host stays in the topology tree on every tab and through drill-in, with no feed
// subscription, and lists its rigs (names and states) read through this daemon's read-only `?host=` forwarding.
// Its seats aren't read, and none of this host's seats or queue changes appear under its name.

const VPS = { id: "vps", transport: "http", url: "http://vps.example:7433", selected: false, status: "reachable" };
const LOCAL_RIGS = [{ id: "r-kernel", name: "kernel", lifecycleState: "running" }];
const REMOTE_RIGS = [{ id: "r-vps-kernel", name: "kernel", lifecycleState: "running" }, { id: "r-web", name: "web", lifecycleState: "stopped" }];
const LOCAL_CHANGE: RecentTransitionSnap = { transitionId: 41, qitemId: "qitem-local", ts: "2026-10-25T19:00:00.000Z",
  actorSession: "local-seat@kernel", change: "created", rig: "kernel", targetKind: "qitem", target: "qitem-local" };

interface Fake { calls: string[]; hosts?: unknown[]; hostsStatus?: number; remoteStatus?: number; aggregateHosts?: unknown[] }

function daemon(fake: Fake): DaemonClient {
  return new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (input) => {
    const u = new URL(String(input)); fake.calls.push(u.pathname + u.search);
    if (u.pathname === "/healthz") return Response.json({ selfHostId: "mac" });
    if (u.pathname === "/api/hosts") return fake.hostsStatus
      ? Response.json({ error: "invalid_registry" }, { status: fake.hostsStatus })
      : Response.json({ ownName: "mac", selected: "local", hosts: fake.hosts ?? [VPS] });
    if (u.pathname === "/api/rigs/summary") {
      const host = u.searchParams.get("host");
      if (!host) return Response.json(LOCAL_RIGS);
      if (fake.remoteStatus) return Response.json({ error: "remote_read_failed" }, { status: fake.remoteStatus });
      return Response.json(host === "vps" ? REMOTE_RIGS : []);
    }
    if (u.pathname === "/api/health") {
      return Response.json({ schema: "openrig.health-list/v0alpha1", evaluatedAt: "2026-10-25T19:00:00.000Z", total: 0, limit: 200, truncated: false, records: [] });
    }
    if (u.pathname === "/api/queue/attention-aggregate") {
      return Response.json({ items: [], hosts: [{ hostId: "local", status: "ok" }, ...(fake.aggregateHosts ?? [])] });
    }
    if (u.pathname === "/api/queue/recent-transitions") return Response.json([LOCAL_CHANGE]);
    if (u.pathname.endsWith("/nodes") || u.pathname.startsWith("/api/queue/")) return Response.json([]);
    return Response.json({}, { status: 404 });
  }) as typeof fetch });
}

type Step = string | Parameters<ReturnType<typeof createViewState>["dispatch"]>[0];

/** Hydrate the landing, then apply each step and hydrate again for the page it opens, as the live refresh does.
 *  `fake.calls` keeps every read along the way. */
async function page(fake: Fake, ...steps: Step[]) {
  let snap: FleetSnapshot = emptySnapshot();
  const view = createViewState({ instanceId: "remote-hosts", getSnapshot: () => snap });
  const client = daemon(fake);
  const rigName = () => view.get().drill.find((part) => part.kind === "rig")?.name ?? null;
  snap = await hydrateSnapshot(client, undefined, null, null, rigName(), view.get());
  for (const step of steps) {
    view.dispatch(typeof step === "string" ? parseCommand(step) : step);
    snap = await hydrateSnapshot(client, undefined, null, null, rigName(), view.get());
  }
  return { snap, view, text: renderScreen(view.get(), snap, { cols: 160, rows: 50, colorMode: "none" }).lines.join("\n") };
}

describe("a registered remote host in the topology tree (#2049)", () => {
  it("is listed on the Table tab with no feed subscription and no attention-aggregate read", async () => {
    const fake: Fake = { calls: [] };
    const { snap, text } = await page(fake);
    expect(snap.hosts.map((host) => [host.name, host.reachable, host.rigs.length])).toEqual([["mac", true, 1], ["vps", true, 0]]);
    expect(fake.calls.some((call) => call.startsWith("/api/queue/attention-aggregate"))).toBe(false);
    expect(fake.calls.some((call) => call.includes("host=vps"))).toBe(false);
    expect(text).toMatch(/⊕ vps/);
  });

  it("keeps its place through drill-in and lists its rigs read through this daemon, never as proven empty", async () => {
    const fake: Fake = { calls: [] };
    const { snap, text } = await page(fake, "host vps");
    expect(fake.calls).toContain("/api/rigs/summary?host=vps");
    expect(snap.hosts.find((host) => host.name === "vps")?.rigs.map((rig) => [rig.name, rig.lifecycleState, rig.remoteHost]))
      .toEqual([["kernel", "running", "vps"], ["web", "stopped", "vps"]]);
    expect(text).toContain("host vps · reachable");
    expect(text).toContain("rig ps --host vps --nodes -A");
    expect(text).toMatch(/web\s+stopped/);
    expect(text).toMatch(/remote instance findings are not served/);
    expect(text).not.toContain("proven empty");
  });

  it("reads none of this host's seats or queue changes for its page, and lists none under its name", async () => {
    const fake: Fake = { calls: [] };
    const { snap, text } = await page(fake, "host vps", "tab recent");
    expect(fake.calls.filter((call) => call.endsWith("/nodes") || call.startsWith("/api/queue/recent-transitions"))).toEqual([]);
    expect(text).toContain("(instance RECENT window not served)");
    expect(text).not.toContain("local-seat@kernel");
    // Before the drilled read lands, the previous snapshot still holds this host's changes: they stay off its page.
    const stale = { ...snap, recentTransitionsScope: { kind: "instance" } as const, recentTransitions: [LOCAL_CHANGE] };
    const view = createViewState({ instanceId: "remote-hosts", getSnapshot: () => stale });
    view.dispatch(parseCommand("host vps"));
    view.dispatch(parseCommand("tab recent"));
    expect(renderScreen(view.get(), stale, { cols: 160, rows: 50, colorMode: "none" }).lines.join("\n")).not.toContain("local-seat@kernel");
  });

  it("opens a remote rig as its name and state with the rig ps --host pointer, even where this host runs a rig of that name", async () => {
    const fake: Fake = { calls: [] };
    const { text } = await page(fake, "host vps", { type: "drill", resource: "rig", name: "kernel", target: { host: "vps" } });
    expect(text).toContain("rig kernel on vps · running");
    expect(text).toContain("rig ps --host vps --nodes --rig kernel");
    expect(fake.calls.filter((call) => call.endsWith("/nodes"))).toEqual([]);
  });

  it("names a failed remote rigs read instead of calling the host empty", async () => {
    const fake: Fake = { calls: [], remoteStatus: 502 };
    const { snap, text } = await page(fake, "host vps");
    expect(snap.readErrors).toEqual([expect.stringMatching(/^rigs-summary\(vps\): .*502/)]);
    expect(text).toContain("✕ rigs read failed — named in the status line");
    expect(text).not.toContain("no rigs served");
  });

  it("says (no rigs served by …) only when the remote read answered with none", async () => {
    const fake: Fake = { calls: [], hosts: [{ ...VPS, id: "mini" }] };
    const { snap, text } = await page(fake, "host mini");
    expect(fake.calls).toContain("/api/rigs/summary?host=mini");
    expect(snap.readErrors).toEqual([]);
    expect(text).toContain("(no rigs served by mini)");
  });

  it("keeps a host the attention aggregate answered for, and lets the aggregate's answer set its reachability", async () => {
    const fake: Fake = { calls: [], hosts: [VPS], aggregateHosts: [{ hostId: "mm2", status: "ok" }, { hostId: "vps", status: "unreachable" }] };
    const { snap } = await page(fake, "tab pulse");
    expect(snap.hosts.map((host) => [host.name, host.reachable])).toEqual([["mac", true], ["mm2", true], ["vps", false]]);
  });

  it("does not list this host twice when the registry names it", async () => {
    const { snap } = await page({ calls: [], hosts: [VPS, { ...VPS, id: "mac", url: "http://mac.example:7433" }] });
    expect(snap.hosts.map((host) => host.name)).toEqual(["mac", "vps"]);
  });

  it("names a failed hosts read where a drilled host would otherwise read as proven empty", async () => {
    const fake: Fake = { calls: [] };
    const { view, snap } = await page(fake, "host vps");
    expect(snap.hosts.map((host) => host.name)).toContain("vps");
    fake.hostsStatus = 500;
    const failed = await hydrateSnapshot(daemon(fake), undefined, null, null, null, view.get());
    expect(failed.readErrors).toEqual([expect.stringMatching(/^hosts: .*500/)]);
    const text = renderScreen(view.get(), failed, { cols: 160, rows: 50, colorMode: "none" }).lines.join("\n");
    expect(text).toContain("✕ host vps not listed: the hosts read failed — named in the status line");
    expect(text).not.toContain("proven empty");
  });
});
