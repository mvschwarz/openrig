import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { queueRoutes } from "../../daemon/src/routes/queue.js";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { buildPulseModel } from "../src/pulse/pulse-model.js";
import { pulseLaneTargets, renderPulseView } from "../src/pulse/render-pulse.js";
import type { FleetSnapshot, ViewState } from "../src/types.js";

const databases: ReturnType<typeof createDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(rig = "selected", seat = "dev.worker") {
  const db = createDb(); databases.push(db); migrate(db, ALL_MIGRATIONS);
  const repo = new QueueRepository(db, new EventBus(db));
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("queueRepo" as never, repo); await next(); });
  app.route("/api/queue", queueRoutes());
  let sequence = 0;
  const seed = (destination = `${seat}@${rig}`, state = "blocked", blocker = "fold:test", qitemId?: string) => {
    const id = qitemId ?? `coverage-${sequence}`; sequence++;
    const at = new Date(sequence * 1000).toISOString();
    db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,body,blocked_on) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, at, at, "source@selected", destination, state, `Work ${id}`, blocker);
    return id;
  };
  const calls: string[] = [];
  const node = { logicalId: seat, podNamespace: "dev", nodeKind: "agent", runtime: "codex", lifecycleState: "running", sessionStatus: "running", canonicalSessionName: `${seat}@${rig}`, resolvedSpecName: null };
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async input => {
    const u = new URL(String(input)); calls.push(u.pathname + u.search);
    if (u.pathname === "/api/queue/list" || u.pathname === "/api/queue/qitem-coverage-blocker") return app.request(u.pathname + u.search);
    if (u.pathname === "/healthz") return Response.json({ selfHostId: "fixture" });
    if (u.pathname === "/api/rigs/summary") return Response.json([{ id: `${rig}-id`, name: rig, lifecycleState: "running" }]);
    if (u.pathname === `/api/rigs/${rig}-id/nodes`) return Response.json([node]);
    if (u.pathname === "/api/queue/recent-transitions" || u.pathname === "/api/specs/library") return Response.json([]);
    if (u.pathname === "/api/health") return Response.json({ schema: "openrig.health-list/v0alpha1", total: 0, limit: 200, records: [], truncated: false, evaluatedAt: null });
    throw Error(`Unexpected fixture route ${u.pathname}`);
  }) as typeof fetch });
  const context = (scope: "host" | "rig" | "pod" | "agent") => ({ section: "topology", viewTab: "table", drill: [
    { kind: "host", name: "fixture" },
    ...(scope !== "host" ? [{ kind: "rig", name: rig }] : []),
    ...(scope === "pod" || scope === "agent" ? [{ kind: "pod", name: "dev" }] : []),
    ...(scope === "agent" ? [{ kind: "agent", name: seat }] : []),
  ] }) as ViewState;
  const read = (scope: "host" | "rig" | "pod" | "agent") => hydrateSnapshot(client, undefined, null, null, rig, context(scope));
  const render = (snap: FleetSnapshot, scope: "host" | "rig" | "pod" | "agent") => {
    const state = { ...createViewState({ instanceId: "fixture", getSnapshot: () => snap }).get(), ...context(scope) };
    return renderScreen(state, snap, { cols: 160, rows: 100 }).lines.join("\n");
  };
  return { repo, seed, calls, read, render, client, context };
}

describe("bounded queue route to topology/Pulse render", () => {
  it.each(["other", "selected"])("%s-rig saturation leaves an omitted seat's work unknown at every scope", async rig => {
    const f = fixture(); const omitted = f.seed();
    for (let i = 0; i < 100; i++) f.seed(`dev.busy@${rig}`);
    expect(f.repo.list({ state: "blocked", limit: 200 })).toHaveLength(101);
    // Even existing rig scoping is not completeness: source OR destination matches.
    expect(f.repo.list({ state: "blocked", rig: "selected" })).toHaveLength(100);
    for (const scope of ["host", "rig", "pod", "agent"] as const) {
      const snap = await f.read(scope);
      expect(snap.blocked).toHaveLength(100);
      expect(snap.blocked.some(row => row.qitemId === omitted)).toBe(false);
      const text = f.render(snap, scope);
      if (scope === "agent") expect(text).toContain("not in sample; work unknown");
      else expect(text.split("\n").filter(line => line.includes("worker")).join("\n")).toMatch(/\?[\s│]+unknown/);
      expect(snap.queueCoverage).toBe("partial");
      expect(text).toContain("may be incomplete");
      expect(text).toContain("unlisted work is unknown");
      expect(text).not.toContain("none in the served bounded lists");
      expect(text).toMatch(/unknown|not in sample/);
    }
    // Four open-queue lists at each scope, plus the agent page's recently finished list.
    expect(f.calls.filter(c => c.startsWith("/api/queue/list"))).toHaveLength(17);
  });

  it("complete empty data stays empty without a sample warning", async () => {
    const f = fixture();
    for (const scope of ["host", "rig", "pod", "agent"] as const) {
      const snap = await f.read(scope); expect(snap.queueCoverage ?? "complete").toBe("complete");
      const text = f.render(snap, scope);
      expect(text).not.toContain("may be incomplete"); expect(text).not.toContain("not in sample");
      if (scope === "agent") expect(text).toContain("none in the served bounded lists");
    }
    expect(renderPulseView(buildPulseModel(await f.read("rig"))).map(row => row.text).join("\n")).not.toContain("Queue counts are samples");
  });

  it("cap reached without an omitted row says possible truncation; pending uses its own cap", async () => {
    const f = fixture(); for (let i = 0; i < 50; i++) f.seed("dev.worker@selected", "pending", "");
    const snap = await f.read("rig"); expect(snap.pending).toHaveLength(50); expect(snap.queueCoverage).toBe("partial");
    expect(f.render(snap, "rig")).toContain("may be incomplete");
    const model = buildPulseModel(snap); const lines = renderPulseView(model);
    expect(lines.map(row => row.text).join("\n")).toContain("Queue counts are samples");
    for (const target of pulseLaneTargets(model)) expect(lines[target.lineIndex]?.text).toContain(model.lanes[target.lane]!.rows[target.row]!.label);
  });

  it("attention/state overlap counts once in seat work and Pulse exceptions", async () => {
    const f = fixture(); f.seed("dev.worker@selected", "blocked", "human-person@kernel");
    const snap = await f.read("agent"); expect(snap.attention).toHaveLength(1); expect(snap.blocked).toHaveLength(1);
    expect(f.render(snap, "agent")).toContain("CURRENT WORK · 1");
    expect(f.render(snap, "agent")).toContain("1 assigned");
    const model = buildPulseModel(snap); expect(model.exceptions.flatMap(section => section.rows)).toHaveLength(1);
  });

  it("Pulse does not count human-destined qitem-blocked work again as BLOCKED", async () => {
    const f = fixture("kernel", "human-person");
    const blocker = f.seed("dev.helper@kernel", "in-progress", "", "qitem-coverage-blocker");
    f.seed(undefined, "blocked", blocker);
    const snap = await f.read("agent");
    expect(snap.attention).toHaveLength(1); expect(snap.blocked).toHaveLength(1);
    expect(snap.blocked[0]?.blockerSession).toBe("dev.helper@kernel");
    const model = buildPulseModel(snap);
    expect(model.exceptions.find(section => section.label === "NEEDS YOU")?.rows).toHaveLength(1);
    expect(model.exceptions.find(section => section.label === "BLOCKED ON AGENTS")).toBeUndefined();
    expect(model.exceptions.flatMap(section => section.rows)).toHaveLength(1);
    const text = f.render({ ...snap, queueCoverage: "partial" }, "agent");
    expect(text).not.toMatch(/NEEDS YOU · \d+ served/);
    expect(text).toContain("Queue sample may be incomplete");
  });

  it("pending attention overlap counts once in assigned depth", async () => {
    const f = fixture("kernel", "human-person"); f.seed(undefined, "pending", "");
    const snap = await f.read("agent"); expect(snap.attention).toHaveLength(1); expect(snap.pending).toHaveLength(1);
    expect(f.render(snap, "agent")).toContain("1 assigned");
    expect(f.render(snap, "agent")).not.toContain("2 assigned");
  });

  it("a failed list is unavailable, while tabs without queues still make no queue-list read", async () => {
    const f = fixture(); const failing = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async () => { throw Error("offline"); }) as typeof fetch });
    const snap = await hydrateSnapshot(failing, undefined, null, null, "selected", f.context("rig"));
    expect(snap.queueCoverage).toBe("unavailable");
    const empty = { ...emptySnapshot(), queueCoverage: "unavailable" as const };
    expect(buildPulseModel(empty).queueSampleNote).toContain("unlisted work is unknown");
    for (const viewTab of ["overview", "graph", "health"] as const) {
      f.calls.length = 0;
      await hydrateSnapshot(f.client, undefined, null, null, "selected", { ...f.context("rig"), viewTab });
      expect(f.calls.filter(c => c.startsWith("/api/queue/list"))).toEqual([]);
    }
  });
});
